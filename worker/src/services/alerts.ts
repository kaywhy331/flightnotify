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
import type { FareObservationRow, TrackerWithMarkets } from "../db/rows.js";
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
import { nowIso, parseIsoOrNull, toIso } from "../time.js";

/** Delivery attempts per alert before it is left as failed for the operator. */
export const MAX_DELIVERY_ATTEMPTS = 3;

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
      delivery_state: DeliveryState.PENDING,
      created_at: nowIso(),
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
      await repo.updateAlertEvent(eventId, {
        delivery_state: DeliveryState.SUPPRESSED_DUPLICATE,
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
      await repo.updateAlertEvent(eventId, {
        delivery_state: DeliveryState.SUPPRESSED_COOLDOWN,
        last_error: cooldown,
      });
      return { alertType, state: DeliveryState.SUPPRESSED_COOLDOWN, detail: cooldown, eventId };
    }

    if (!notifier.isConfigured() || !chatId) {
      const detail =
        "Telegram is not configured. The alert is recorded here; set TELEGRAM_BOT_TOKEN " +
        "and TELEGRAM_CHAT_ID as Worker secrets to receive messages.";
      await repo.updateAlertEvent(eventId, {
        delivery_state: DeliveryState.NOT_CONFIGURED,
        last_error: detail,
      });
      return { alertType, state: DeliveryState.NOT_CONFIGURED, detail, eventId };
    }

    const delivered = await this.deliver(eventId, message, 0, chatId);
    return {
      alertType,
      state: delivered.state,
      detail: delivered.detail,
      eventId,
    };
  }

  private async deliver(
    eventId: number,
    message: string,
    priorAttempts: number,
    chatId: string,
  ): Promise<{ state: DeliveryStateValue; detail: string }> {
    const { repo, notifier } = this.deps;
    const attempts = priorAttempts + 1;
    const result = await notifier.sendMessage(chatId, message, { disablePreview: false });

    if (result.ok) {
      await repo.updateAlertEvent(eventId, {
        delivery_state: DeliveryState.SENT,
        delivered_at: nowIso(),
        telegram_message_id: result.messageId ?? null,
        attempts,
        last_error: null,
        response_meta: JSON.stringify({ message_id: result.messageId ?? null }),
      });
      return { state: DeliveryState.SENT, detail: "Alert delivered." };
    }

    await repo.updateAlertEvent(eventId, {
      delivery_state: DeliveryState.FAILED,
      attempts,
      last_error: result.userMessage,
      response_meta: JSON.stringify({
        category: result.category,
        error_code: result.errorCode ?? null,
        retry_after: result.retryAfter ?? null,
        retryable: result.retryable,
        attempts,
      }),
    });
    return { state: DeliveryState.FAILED, detail: result.userMessage || "Delivery failed." };
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
    if (!chatId || !this.deps.notifier.isConfigured()) return { delivered: 0, failed: 0 };

    const events = await this.deps.repo.pendingAlerts(MAX_DELIVERY_ATTEMPTS, limit);
    let delivered = 0;
    let failed = 0;
    for (const event of events) {
      const outcome = await this.deliver(event.id, event.message_text, event.attempts, chatId);
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
