/**
 * Alert creation, deduplication and delivery.
 *
 * Port of `flightnotify/services/alerts.py`. The ordering guarantee is the
 * important part and it survives the move to D1: the observation is already
 * persisted before this runs, and the alert row is written *before* delivery is
 * attempted, so a Telegram failure can only ever update that row -- it can
 * never discard a stored price.
 *
 * Deduplication is enforced by the UNIQUE(dedupe_key) index rather than by a
 * read-then-write, because a manual check and a Cron tick can genuinely race.
 */

import type { Repo } from "../db/repo.js";
import type { AlertEventRow, FareObservationRow, TrackerWithMarkets } from "../db/rows.js";
import type { Evaluation } from "../domain/evaluation.js";
import { alertDedupeKey } from "../domain/fingerprints.js";
import {
  AlertType,
  DeliveryState,
  type AlertTypeValue,
  type DeliveryStateValue,
  type PriceScopeValue,
  type ThresholdBasisValue,
} from "../domain/enums.js";
import { buildAlertText, type AlertContext } from "./messages.js";
import type { TelegramResult } from "./telegram.js";
import { addSeconds, nowIso, parseIsoOrNull, toIso } from "../time.js";

/** Delivery attempts per alert before it is left as failed for the operator. */
export const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_CLAIM_TTL_SECONDS = 60;

export interface CoverageInfo {
  checked: number | null;
  total: number | null;
  complete: boolean;
}

export interface AlertOutcome {
  alertType: AlertTypeValue;
  state: DeliveryStateValue;
  detail: string;
  eventId: number | null;
}

/**
 * The slice of the Telegram client this service uses.
 *
 * `TelegramNotifier` satisfies it structurally, so nothing changes at the call
 * sites; declaring it here is what lets a test hand in a two-method fake and
 * assert on what would have been sent without a mocking library, a network
 * stub, or any risk of a real message reaching a real person.
 */
export interface AlertNotifier {
  isConfigured(): boolean;
  sendMessage(
    chatId: string | number,
    text: string,
    options?: { disablePreview?: boolean },
  ): Promise<TelegramResult>;
}

export interface AlertDeps {
  repo: Repo;
  notifier: AlertNotifier;
  timeZone: string;
}

function passengerSummary(tracker: TrackerWithMarkets): string {
  const parts = [`${tracker.adults} adult${tracker.adults === 1 ? "" : "s"}`];
  if (tracker.children) {
    parts.push(`${tracker.children} child${tracker.children === 1 ? "" : "ren"}`);
  }
  if (tracker.infants_in_seat) parts.push(`${tracker.infants_in_seat} infant in seat`);
  if (tracker.infants_on_lap) parts.push(`${tracker.infants_on_lap} lap infant`);
  return parts.join(", ");
}

export class AlertService {
  constructor(private readonly deps: AlertDeps) {}

  /**
   * Create and attempt any alerts this observation earns.
   *
   * One observation produces at most one message. When a fare is both a new
   * observed low *and* at or below the threshold, only the new-low alert is
   * sent: its body already states the threshold and that the fare is under it,
   * so a second message would say nothing new. The threshold event is still
   * recorded, marked as consolidated.
   */
  async process(args: {
    tracker: TrackerWithMarkets;
    observation: FareObservationRow;
    evaluation: Evaluation;
    coverage: CoverageInfo;
    chatId: string | null;
  }): Promise<AlertOutcome[]> {
    const pending = [...args.evaluation.alertsToSend];
    const consolidated: AlertTypeValue[] = [];

    if (pending.includes(AlertType.NEW_LOW) && pending.includes(AlertType.THRESHOLD)) {
      pending.splice(pending.indexOf(AlertType.THRESHOLD), 1);
      consolidated.push(AlertType.THRESHOLD);
    }

    const outcomes: AlertOutcome[] = [];
    for (const alertType of pending) {
      outcomes.push(await this.handleOne({ ...args, alertType, suppressReason: null }));
    }
    for (const alertType of consolidated) {
      outcomes.push(
        await this.handleOne({
          ...args,
          alertType,
          suppressReason:
            "Consolidated into the new-observed-low alert for the same observation, " +
            "which already reports the threshold.",
        }),
      );
    }
    return outcomes;
  }

  private async handleOne(args: {
    tracker: TrackerWithMarkets;
    observation: FareObservationRow;
    evaluation: Evaluation;
    coverage: CoverageInfo;
    chatId: string | null;
    alertType: AlertTypeValue;
    suppressReason: string | null;
  }): Promise<AlertOutcome> {
    const { tracker, observation, evaluation, coverage, chatId, alertType } = args;
    const { repo, notifier, timeZone } = this.deps;
    const owner = `alert:${crypto.randomUUID()}`;
    const claimedAt = new Date();

    const dedupeKey = await alertDedupeKey({
      tracker_id: tracker.id,
      config_version_id: tracker.current_config_version_id,
      alert_type: alertType,
      price_cents: evaluation.comparableCents,
      currency: tracker.currency,
      itinerary_fingerprint_value: observation.itinerary_fingerprint,
      outbound_date: observation.outbound_date,
      return_date: observation.return_date,
      market: observation.market,
    });

    const context: AlertContext = {
      alertType,
      trackerName: tracker.name,
      origin: observation.origin ?? tracker.origin,
      destination: observation.destination ?? tracker.destination,
      passengerSummary: passengerSummary(tracker),
      cabin: tracker.cabin,
      currency: tracker.currency,
      comparableCents: evaluation.comparableCents,
      thresholdCents: tracker.threshold_amount_cents,
      thresholdBasis: tracker.threshold_basis as ThresholdBasisValue,
      priceScope: observation.price_scope as PriceScopeValue,
      outboundDate: observation.outbound_date,
      returnDate: observation.return_date,
      stops: observation.stops,
      market: observation.market,
      observedAt: observation.observed_at,
      previousLowCents: evaluation.previousLowCents,
      dropAbsoluteCents: evaluation.dropAbsoluteCents,
      isBaseline: evaluation.isBaseline,
      coverageChecked: coverage.checked,
      coverageTotal: coverage.total,
      coverageComplete: coverage.complete,
      link: observation.booking_link ?? observation.search_link,
      airlines: (() => {
        try {
          return observation.airlines ? (JSON.parse(observation.airlines) as string[]) : [];
        } catch {
          return [];
        }
      })(),
    };

    const message = buildAlertText(context, timeZone);

    // The insert is the deduplication check: ON CONFLICT DO NOTHING returns
    // null when this exact finding was already recorded, including when a
    // concurrent invocation won the race a millisecond ago.
    const eventId = await repo.insertAlertEvent({
      tracker_id: tracker.id,
      config_version_id: tracker.current_config_version_id,
      observation_id: observation.id,
      alert_type: alertType,
      dedupe_key: dedupeKey,
      message_text: message,
      // The INSERT is both dedupe and delivery claim. A retry sweep can never
      // take this row between creation and the cooldown/configuration checks.
      delivery_state: DeliveryState.SENDING,
      attempts: 1,
      retryable: 0,
      claim_owner: owner,
      claim_expires_at: toIso(addSeconds(claimedAt, DELIVERY_CLAIM_TTL_SECONDS)),
      created_at: toIso(claimedAt),
    });

    if (eventId === null) {
      const existing = await repo.findAlertByDedupeKey(dedupeKey);
      return {
        alertType,
        state: DeliveryState.SUPPRESSED_DUPLICATE,
        detail: "An identical alert was already recorded for this fare and itinerary.",
        eventId: existing?.id ?? null,
      };
    }

    if (args.suppressReason) {
      await repo.completeAlertClaim(eventId, owner, {
        delivery_state: DeliveryState.SUPPRESSED_DUPLICATE,
        retryable: 0,
        next_attempt_at: null,
        last_error: args.suppressReason,
      });
      return {
        alertType,
        state: DeliveryState.SUPPRESSED_DUPLICATE,
        detail: args.suppressReason,
        eventId,
      };
    }

    const cooldown = await this.cooldownReason(tracker, alertType, eventId);
    if (cooldown) {
      await repo.completeAlertClaim(eventId, owner, {
        delivery_state: DeliveryState.SUPPRESSED_COOLDOWN,
        retryable: 0,
        next_attempt_at: null,
        last_error: cooldown,
      });
      return { alertType, state: DeliveryState.SUPPRESSED_COOLDOWN, detail: cooldown, eventId };
    }

    if (!notifier.isConfigured() || !chatId) {
      const detail =
        "Telegram is not configured. The alert is recorded here; set TELEGRAM_BOT_TOKEN " +
        "and TELEGRAM_CHAT_ID as Worker secrets to receive messages.";
      await repo.completeAlertClaim(eventId, owner, {
        delivery_state: DeliveryState.NOT_CONFIGURED,
        retryable: 0,
        next_attempt_at: null,
        last_error: detail,
      });
      return { alertType, state: DeliveryState.NOT_CONFIGURED, detail, eventId };
    }

    const delivered = await this.deliverClaimed(
      { id: eventId, message_text: message, attempts: 1 },
      owner,
      chatId,
    );
    return {
      alertType,
      state: delivered.state,
      detail: delivered.detail,
      eventId,
    };
  }

  private async deliverClaimed(
    event: Pick<AlertEventRow, "id" | "message_text" | "attempts">,
    owner: string,
    chatId: string,
  ): Promise<{ state: DeliveryStateValue; detail: string }> {
    const { repo, notifier } = this.deps;
    let result: TelegramResult;
    try {
      result = await notifier.sendMessage(chatId, event.message_text, { disablePreview: false });
    } catch (error) {
      const label = error instanceof Error ? error.name : "Error";
      const detail =
        `Telegram delivery ended without a response (${label}). It may have succeeded, ` +
        "so FlightNotify will not automatically send a duplicate.";
      await repo.completeAlertClaim(event.id, owner, {
        delivery_state: DeliveryState.UNCERTAIN,
        retryable: 0,
        next_attempt_at: null,
        last_error: detail,
        response_meta: JSON.stringify({ category: "transport_exception", attempts: event.attempts }),
      });
      return { state: DeliveryState.UNCERTAIN, detail };
    }

    if (result.ok) {
      const recorded = await repo.completeAlertClaim(event.id, owner, {
        delivery_state: DeliveryState.SENT,
        delivered_at: nowIso(),
        telegram_message_id: result.messageId ?? null,
        retryable: 0,
        next_attempt_at: null,
        last_error: null,
        response_meta: JSON.stringify({ message_id: result.messageId ?? null }),
      });
      if (!recorded) {
        return {
          state: DeliveryState.UNCERTAIN,
          detail: "Telegram accepted the message, but the delivery claim expired before confirmation was stored.",
        };
      }
      return { state: DeliveryState.SENT, detail: "Alert delivered." };
    }

    const ambiguous =
      result.category === "timeout" ||
      result.category === "network" ||
      result.category === "ambiguous_response";
    const mayRetry = result.retryable && !ambiguous && event.attempts < MAX_DELIVERY_ATTEMPTS;
    const delaySeconds = Math.min(
      3600,
      Math.max(result.retryAfter ?? 0, 30 * 2 ** Math.max(0, event.attempts - 1)),
    );
    const detail = ambiguous
      ? result.userMessage ||
        "Telegram delivery may have succeeded, so it was not automatically retried."
      : result.userMessage || "Delivery failed.";
    const state = ambiguous ? DeliveryState.UNCERTAIN : DeliveryState.FAILED;
    await repo.completeAlertClaim(event.id, owner, {
      delivery_state: state,
      retryable: mayRetry ? 1 : 0,
      next_attempt_at: mayRetry ? toIso(addSeconds(new Date(), delaySeconds)) : null,
      last_error: detail,
      response_meta: JSON.stringify({
        category: result.category,
        error_code: result.errorCode ?? null,
        retry_after: result.retryAfter ?? null,
        retryable: mayRetry,
        ambiguous,
        attempts: event.attempts,
      }),
    });
    return { state, detail };
  }

  /**
   * Soft heads-up when a fare lands within 5% above the threshold.
   *
   * Same dedupe key machinery, cooldown and delivery path as real alerts --
   * only the decision to send lives in the search service, outside the
   * golden-vector-locked evaluation module, so Python parity is untouched.
   */
  async processApproaching(args: {
    tracker: TrackerWithMarkets;
    observation: FareObservationRow;
    evaluation: Evaluation;
    coverage: CoverageInfo;
    chatId: string | null;
  }): Promise<AlertOutcome> {
    return this.handleOne({ ...args, alertType: AlertType.APPROACHING, suppressReason: null });
  }

  /**
   * Send a message about the tracker itself rather than about a fare.
   *
   * No alert_events row is written: these notices are operational, they carry
   * no dedupe key and no delivery history worth retrying, and the caller
   * decides when one is warranted. It never throws -- the search that triggered
   * it has already persisted everything that matters, and a Telegram outage
   * must not turn a stored price into an exception.
   */
  async sendOperationalNotice(chatId: string | null, text: string): Promise<boolean> {
    const { notifier } = this.deps;
    if (chatId === null || chatId === "" || !notifier.isConfigured()) return false;
    try {
      const result = await notifier.sendMessage(chatId, text, { disablePreview: true });
      return result.ok;
    } catch {
      return false;
    }
  }

  /** Re-attempt alerts that failed with a retryable error. */
  async retryPending(
    chatId: string | null,
    limit = 20,
  ): Promise<{ delivered: number; failed: number }> {
    await this.deps.repo.markExpiredAlertClaimsUncertain();
    if (!chatId || !this.deps.notifier.isConfigured()) return { delivered: 0, failed: 0 };

    const owner = `alert-retry:${crypto.randomUUID()}`;
    const events = await this.deps.repo.claimPendingAlerts(
      owner,
      MAX_DELIVERY_ATTEMPTS,
      limit,
      DELIVERY_CLAIM_TTL_SECONDS,
    );
    let delivered = 0;
    let failed = 0;
    for (const event of events) {
      const outcome = await this.deliverClaimed(event, owner, chatId);
      if (outcome.state === DeliveryState.SENT) delivered += 1;
      else failed += 1;
    }
    return { delivered, failed };
  }

  private async cooldownReason(
    tracker: TrackerWithMarkets,
    alertType: AlertTypeValue,
    currentId: number,
  ): Promise<string | null> {
    if (tracker.cooldown_minutes <= 0) return null;

    const previous = await this.deps.repo.lastDeliveredAlert(tracker.id, alertType, currentId);
    if (previous === null) return null;

    const deliveredAt = parseIsoOrNull(previous.delivered_at);
    if (deliveredAt === null) return null;

    const windowStart = new Date(Date.now() - tracker.cooldown_minutes * 60_000);
    if (deliveredAt.getTime() < windowStart.getTime()) return null;

    const minutesLeft =
      Math.floor((deliveredAt.getTime() - windowStart.getTime()) / 60_000) + 1;
    return (
      `Cooldown active: a ${alertType.replace("_", " ")} alert was sent ` +
      `${tracker.cooldown_minutes - minutesLeft} minutes ago ` +
      `(cooldown ${tracker.cooldown_minutes} minutes).`
    );
  }
}

export { toIso };
