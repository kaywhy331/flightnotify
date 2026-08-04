/**
 * Search orchestration: quota gate -> cache -> provider -> persistence -> alerts.
 *
 * Port of `flightnotify/services/search.py`. A "check" is one batch. It may
 * issue several provider queries (one per country market, and for a custom
 * flexible window one per claimed date combination), and each query is recorded
 * as its own search_run -- including the ones that failed, were served from
 * cache, or were prevented by the quota guard.
 *
 * Ordering matters and is preserved: the run, its observations and the tracker
 * summary are written *before* any alert is attempted, so a Telegram failure
 * can never discard a stored price.
 *
 * Manual and scheduled checks both enter here, so they necessarily share the
 * same quota accounting, locking, normalisation, observation and alert paths.
 */

import type { Config } from "../env.js";
import type { Repo } from "../db/repo.js";
import type { FareObservationRow, TrackerWithMarkets } from "../db/rows.js";
import {
  CacheStatus,
  CandidateStatus,
  CoverageState,
  DateMode,
  DeliveryState,
  EndpointType,
  ErrorCategory,
  PriceScopeLabel,
  RunStatus,
  RunTrigger,
  StopsPreference,
  ThresholdBasis,
  TrackerStatus,
  type CabinValue,
  type ErrorCategoryValue,
  type FlexDurationValue,
  type PriceScopeValue,
  type RunTriggerValue,
  type StopsPreferenceValue,
  type ThresholdBasisValue,
} from "../domain/enums.js";
import { comparableCents, evaluate } from "../domain/evaluation.js";
import { itineraryFingerprint } from "../domain/fingerprints.js";
import { ProviderError, ProviderMissingCredentialsError } from "../providers/errors.js";
import type {
  FareProvider,
  NormalizedOffer,
  ProviderResult,
} from "../providers/types.js";
import { makeParty } from "../providers/types.js";
import { addMinutes, addSeconds, nowIso, todayIn, toIso } from "../time.js";
import { AlertService, type CoverageInfo } from "./alerts.js";
import { QuotaManager } from "./quota.js";
import { escapeHtml } from "./telegram.js";
import { ensureConfigVersion, payingTravelersOf, scheduleNextRun } from "./tracker.js";
import type { CheckOutcome } from "../scheduled.js";

/** Offers persisted per run; the rest are summarised by `offers_found`. */
const MAX_STORED_OFFERS = 25;
/** Consecutive provider failures before a tracker is parked in the error state. */
const FAILURE_LIMIT = 5;
/**
 * How soon a scan that ran out of budget comes back for the rest of its work.
 *
 * The Cron Trigger fires at minutes 7, 22, 37 and 52 -- every 15 minutes. A
 * 16-minute gap therefore always lands strictly inside the following tick's
 * window: exactly one tick is skipped, never two, and the resumption cannot
 * race the tick that clamped the scan in the first place. Rescheduling a full
 * check interval instead (12 hours by default) would make a window that plans
 * ten date pairs but is clamped to three take days to complete one sweep,
 * which is neither what the form's budget estimate promises nor what a
 * traveler watching a window would expect.
 */
const RESUME_MINUTES = 16;

interface QueryUnit {
  market: string;
  endpoint: ProviderResult["endpoint"];
  fingerprint: string;
  outboundDate: string | null;
  returnDate: string | null;
  candidateId: number | null;
  candidateCycle: number | null;
  run: () => Promise<ProviderResult>;
}

export interface CheckResult extends CheckOutcome {
  batchId: string;
  trackerId: number;
  runIds: number[];
  cacheHits: number;
  offersFound: number;
  bestPriceCents: number | null;
  bestMarket: string | null;
  bestObservationId: number | null;
  successfulUnits: number;
  statusMessages: string[];
  skipped: boolean;
  alerts: { type: string; state: string; detail: string }[];
  /** Last precise provider category, retained for tracker-level diagnostics. */
  lastErrorCategory?: ErrorCategoryValue | null;
}

function emptyResult(batchId: string, trackerId: number): CheckResult {
  return {
    batchId,
    trackerId,
    runIds: [],
    providerCalls: 0,
    cacheHits: 0,
    offersFound: 0,
    bestPriceCents: null,
    bestMarket: null,
    bestObservationId: null,
    successfulUnits: 0,
    statusMessages: [],
    errors: [],
    alerts: [],
    skipped: false,
    providerFailures: 0,
    telegramFailures: 0,
    alertsSent: 0,
    workRemaining: false,
    lastErrorCategory: null,
  };
}

export interface SearchDeps {
  repo: Repo;
  config: Config;
  provider: FareProvider;
  quota: QuotaManager;
  alerts: AlertService;
  chatId: string | null;
}

export class SearchService {
  constructor(private readonly deps: SearchDeps) {}

  async runTracker(
    tracker: TrackerWithMarkets,
    trigger: RunTriggerValue = RunTrigger.SCHEDULED,
    options: {
      forceRefresh?: boolean;
      maxQueries?: number;
      heartbeat?: () => Promise<boolean>;
    } = {},
  ): Promise<CheckResult> {
    const { repo, provider, quota } = this.deps;
    const batchId = crypto.randomUUID();
    const result = emptyResult(batchId, tracker.id);

    await ensureConfigVersion(repo, tracker);
    await repo.updateTrackerFields(tracker.id, { last_attempt_at: nowIso() });

    // The natural end-state of every tracker is that its trip happens. Without
    // this, a tracker whose departure has passed keeps spending live provider
    // searches on flights that can no longer be boarded. (The Python original
    // refused past-date scans; this goes one step further and parks the
    // tracker so it stops being selected at all.)
    const completedReason = this.tripCompletedReason(tracker);
    if (completedReason !== null) {
      await this.recordBlockedRun(tracker, batchId, trigger, {
        status: RunStatus.SKIPPED,
        category: ErrorCategory.NO_CANDIDATES,
        message: completedReason,
      });
      await repo.updateTrackerFields(tracker.id, {
        status: TrackerStatus.COMPLETED,
        next_run_at: null,
      });
      tracker.status = TrackerStatus.COMPLETED;
      result.skipped = true;
      result.statusMessages.push(completedReason);
      return result;
    }

    if (!provider.isConfigured()) {
      const guidance = new ProviderMissingCredentialsError().guidance();
      await this.recordBlockedRun(tracker, batchId, trigger, {
        status: RunStatus.SKIPPED,
        category: ErrorCategory.MISSING_CREDENTIALS,
        message: guidance,
      });
      result.skipped = true;
      result.errors.push(guidance);
      await scheduleNextRun(repo, tracker);
      return result;
    }

    let units: QueryUnit[];
    try {
      units = await this.planUnits(tracker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordBlockedRun(tracker, batchId, trigger, {
        status: RunStatus.SKIPPED,
        category: ErrorCategory.UNSUPPORTED_QUERY,
        message,
      });
      result.skipped = true;
      result.statusMessages.push(message);
      await scheduleNextRun(repo, tracker);
      return result;
    }

    if (units.length === 0) {
      const message = "No date combination was due for checking.";
      await this.recordBlockedRun(tracker, batchId, trigger, {
        status: RunStatus.SKIPPED,
        category: ErrorCategory.NO_CANDIDATES,
        message,
      });
      result.skipped = true;
      result.statusMessages.push(message);
      await scheduleNextRun(repo, tracker);
      return result;
    }

    // A tick may hand down a smaller budget than the tracker would like, so a
    // single tracker cannot consume the whole invocation's subrequest budget.
    if (options.maxQueries !== undefined && units.length > options.maxQueries) {
      units = units.slice(0, options.maxQueries);
      result.workRemaining = true;
    }

    // Cache first: a cached unit costs no quota.
    const now = new Date();
    const cached = new Map<string, ProviderResult | null>();
    const billable: QueryUnit[] = [];
    for (const unit of units) {
      const payload = options.forceRefresh ? null : await repo.cacheGet(unit.fingerprint, now);
      const parsed = payload === null ? null : decodeCachedResult(payload, unit);
      if (payload !== null && parsed === null) await repo.cacheDelete(unit.fingerprint);
      cached.set(unit.fingerprint, parsed);
      if (parsed === null) billable.push(unit);
    }

    const maxAttempts = Math.max(1, provider.maxRequestCount ?? 1);
    const { decision } = await quota.authorize(billable.length * maxAttempts, trigger, now);
    if (decision.reason) result.statusMessages.push(decision.reason);
    const allowedUnits = Math.floor(decision.granted / maxAttempts);
    const allowed = new Set(billable.slice(0, allowedUnits).map((u) => u.fingerprint));

    for (const unit of units) {
      if (options.heartbeat && !(await options.heartbeat())) {
        result.workRemaining = true;
        result.errors.push("The scheduler lease expired; remaining work was left for a later tick.");
        break;
      }
      const cachedResult = cached.get(unit.fingerprint) ?? null;
      if (cachedResult !== null) {
        await this.executeCached(tracker, batchId, trigger, unit, cachedResult, result);
        continue;
      }
      if (!allowed.has(unit.fingerprint)) {
        await this.recordBlockedRun(tracker, batchId, trigger, {
          status: RunStatus.QUOTA_BLOCKED,
          category: ErrorCategory.QUOTA_EXHAUSTED,
          message: decision.reason || "The configured provider allowance is exhausted.",
          unit,
        });
        result.workRemaining = true;
        continue;
      }
      await this.executeLive(tracker, batchId, trigger, unit, result, options.forceRefresh ?? false);
    }

    await this.finalize(tracker, result);
    return result;
  }

  /** Why this tracker's trip is over, or null while it is still bookable. */
  private tripCompletedReason(tracker: TrackerWithMarkets): string | null {
    const today = todayIn(this.deps.config.appTimezone);

    if (tracker.date_mode === DateMode.EXACT) {
      if (tracker.outbound_date !== null && tracker.outbound_date < today) {
        return (
          `The outbound date (${tracker.outbound_date}) has passed, so no search was made ` +
          "and no quota was used. The tracker is marked completed; its price history is " +
          "kept. Edit it with future dates to start tracking again."
        );
      }
      return null;
    }

    if (tracker.date_mode === DateMode.FLEXIBLE_PRESET) {
      if (tracker.flex_year === null || tracker.flex_month === null) return null;
      const [year, month] = today.split("-").map(Number) as [number, number];
      if (tracker.flex_year < year || (tracker.flex_year === year && tracker.flex_month < month)) {
        return (
          "The flexible travel month has passed, so no search was made and no quota was " +
          "used. The tracker is marked completed; edit it with a future month to resume."
        );
      }
      return null;
    }

    if (tracker.window_outbound_end !== null && tracker.window_outbound_end < today) {
      return (
        `Every departure in the window (up to ${tracker.window_outbound_end}) has passed, ` +
        "so no search was made and no quota was used. The tracker is marked completed."
      );
    }
    return null;
  }

  // ------------------------------------------------------------- planning
  private async planUnits(tracker: TrackerWithMarkets): Promise<QueryUnit[]> {
    const { config, provider, repo } = this.deps;
    const markets = tracker.markets.length > 0 ? tracker.markets : [config.defaultMarket];
    const party = makeParty({
      adults: tracker.adults,
      children: tracker.children,
      infantsInSeat: tracker.infants_in_seat,
      infantsOnLap: tracker.infants_on_lap,
    });
    const shared = {
      origin: tracker.origin,
      destination: tracker.destination,
      party,
      cabin: tracker.cabin as CabinValue,
      stops: tracker.stops as StopsPreferenceValue,
      currency: tracker.currency,
      includeAirlines: tracker.include_airlines,
      excludeAirlines: tracker.exclude_airlines,
    };

    const units: QueryUnit[] = [];
    const mode = tracker.date_mode;

    if (mode === DateMode.EXACT) {
      if (!tracker.outbound_date || !tracker.return_date) {
        throw new Error("This tracker has no outbound or return date. Edit it to set dates.");
      }
      for (const market of markets) {
        const query = {
          ...shared,
          market,
          outboundDate: tracker.outbound_date,
          returnDate: tracker.return_date,
        };
        const fingerprint = await this.fingerprintFor(provider.exactEndpoint, provider.buildExactParams(query));
        units.push({
          market,
          endpoint: provider.exactEndpoint,
          fingerprint,
          outboundDate: tracker.outbound_date,
          returnDate: tracker.return_date,
          candidateId: null,
          candidateCycle: null,
          run: () => provider.searchExact(query),
        });
      }
      return units;
    }

    if (mode === DateMode.FLEXIBLE_PRESET) {
      if (!provider.supportsFlexible()) {
        throw new Error(
          "The configured provider cannot answer flexible-preset searches. " +
            "Switch this tracker to exact dates or a custom window.",
        );
      }
      if (!tracker.flex_month || !tracker.flex_year || !tracker.flex_duration) {
        throw new Error("This tracker has no flexible month or trip length. Edit it to set them.");
      }
      for (const market of markets) {
        const query = {
          ...shared,
          market,
          month: tracker.flex_month,
          year: tracker.flex_year,
          duration: tracker.flex_duration as FlexDurationValue,
        };
        const fingerprint = await this.fingerprintFor(
          provider.flexibleEndpoint,
          provider.buildFlexibleParams(query),
        );
        units.push({
          market,
          endpoint: provider.flexibleEndpoint,
          fingerprint,
          outboundDate: null,
          returnDate: null,
          candidateId: null,
          candidateCycle: null,
          run: () => provider.searchFlexible(query),
        });
      }
      return units;
    }

    // Custom window: one exact query per claimed date pair. Progress lives in
    // flexible_date_candidates so a sweep resumes across Cron invocations
    // instead of restarting from the first pair every tick.
    const configVersionId = tracker.current_config_version_id;
    if (configVersionId === null) return [];

    const perRun = Math.max(1, tracker.candidates_per_run);
    // A window can straddle today: departures already flown are retired so the
    // sweep spends its budget only on pairs that can still be booked.
    const today = todayIn(config.appTimezone);
    await repo.ensureCandidateMarkets(configVersionId, markets);
    await repo.skipPastCandidates(configVersionId, today);
    let candidates = await repo.claimCandidates(configVersionId, tracker.coverage_cycle, perRun);

    if (candidates.length === 0) {
      // Cycle complete: start the next sweep so long-running windows keep
      // being refreshed rather than stopping once every pair is visited.
      const nextCycle = tracker.coverage_cycle + 1;
      await repo.startNextCycle(configVersionId, nextCycle, today);
      await repo.updateTrackerFields(tracker.id, { coverage_cycle: nextCycle });
      tracker.coverage_cycle = nextCycle;
      candidates = await repo.claimCandidates(configVersionId, nextCycle, perRun);
    }

    const marketWork = await repo.pendingCandidateMarkets(
      candidates.map((candidate) => candidate.id),
      tracker.coverage_cycle,
    );
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const work of marketWork) {
      const candidate = candidateById.get(work.candidate_id);
      if (!candidate) continue;
      const market = work.market;
        const query = {
          ...shared,
          market,
          outboundDate: candidate.outbound_date,
          returnDate: candidate.return_date,
        };
        const fingerprint = await this.fingerprintFor(
          provider.exactEndpoint,
          provider.buildExactParams(query),
        );
        units.push({
          market,
          endpoint: provider.exactEndpoint,
          fingerprint,
          outboundDate: candidate.outbound_date,
          returnDate: candidate.return_date,
          candidateId: candidate.id,
          candidateCycle: tracker.coverage_cycle,
          run: () => provider.searchExact(query),
        });
    }
    return units;
  }

  private async fingerprintFor(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<string> {
    const { queryFingerprint } = await import("../domain/fingerprints.js");
    return queryFingerprint(endpoint, params);
  }

  // ------------------------------------------------------------ execution
  private async executeLive(
    tracker: TrackerWithMarkets,
    batchId: string,
    trigger: RunTriggerValue,
    unit: QueryUnit,
    result: CheckResult,
    forceRefresh: boolean,
  ): Promise<void> {
    const { repo, config, provider, quota } = this.deps;
    const runId = await this.openRun(tracker, batchId, trigger, unit,
      forceRefresh ? CacheStatus.FORCED : CacheStatus.MISS);
    result.runIds.push(runId);

    const { decision, reservation } = await quota.reserveCalls(
      Math.max(1, provider.maxRequestCount ?? 1),
      trigger,
    );
    if (reservation === null) {
      const message = decision.reason || "The configured provider allowance is exhausted.";
      await repo.updateSearchRun(runId, {
        completed_at: nowIso(),
        status: RunStatus.QUOTA_BLOCKED,
        cache_status: forceRefresh ? CacheStatus.FORCED : CacheStatus.MISS,
        error_category: ErrorCategory.QUOTA_EXHAUSTED,
        error_message: message,
      });
      result.statusMessages.push(message);
      result.workRemaining = true;
      return;
    }

    let providerResult: ProviderResult;
    try {
      providerResult = await unit.run();
    } catch (error) {
      const requestCount = error instanceof ProviderError ? error.requestCount : 1;
      await quota.finalizeReservation(reservation, unit.endpoint, runId, requestCount);
      result.providerCalls += requestCount;
      result.providerFailures += 1;

      const category =
        error instanceof ProviderError ? error.category : ErrorCategory.INTERNAL;
      result.lastErrorCategory = category;
      const message =
        error instanceof ProviderError
          ? error.guidance()
          : "The check failed unexpectedly. Stored price history is unchanged.";

      await repo.updateSearchRun(runId, {
        completed_at: nowIso(),
        status: statusForCategory(category),
        provider_request_count: requestCount,
        error_category: category,
        error_message: message,
      });
      result.errors.push(message);
      if (unit.candidateId !== null && unit.candidateCycle !== null) {
        await repo.markCandidateMarketChecked(
          unit.candidateId,
          unit.market,
          unit.candidateCycle,
          CandidateStatus.FAILED,
          runId,
          null,
        );
      }
      return;
    }

    await quota.finalizeReservation(
      reservation,
      unit.endpoint,
      runId,
      providerResult.requestCount,
    );
    result.providerCalls += providerResult.requestCount;
    result.successfulUnits += 1;

    if (config.queryCacheTtlSeconds > 0) {
      await repo.cachePut(
        unit.fingerprint,
        unit.endpoint,
        encodeCachedResult(providerResult, unit),
        addSeconds(new Date(), config.queryCacheTtlSeconds),
        runId,
      );
    }

    await this.persistOffers(tracker, runId, unit, providerResult, result);
  }

  private async executeCached(
    tracker: TrackerWithMarkets,
    batchId: string,
    trigger: RunTriggerValue,
    unit: QueryUnit,
    cachedResult: ProviderResult,
    result: CheckResult,
  ): Promise<void> {
    const runId = await this.openRun(tracker, batchId, trigger, unit, CacheStatus.HIT);
    result.runIds.push(runId);
    result.cacheHits += 1;
    result.successfulUnits += 1;
    await this.persistOffers(tracker, runId, unit, cachedResult, result);
  }

  private async openRun(
    tracker: TrackerWithMarkets,
    batchId: string,
    trigger: RunTriggerValue,
    unit: QueryUnit,
    cacheStatus: string,
  ): Promise<number> {
    return this.deps.repo.insertSearchRun({
      tracker_id: tracker.id,
      config_version_id: tracker.current_config_version_id,
      batch_id: batchId,
      trigger,
      endpoint: unit.endpoint,
      market: unit.market,
      currency: tracker.currency,
      outbound_date: unit.outboundDate,
      return_date: unit.returnDate,
      query_fingerprint: unit.fingerprint,
      started_at: nowIso(),
      status: RunStatus.RUNNING,
      cache_status: cacheStatus,
      coverage_cycle: tracker.coverage_cycle,
    });
  }

  private async recordBlockedRun(
    tracker: TrackerWithMarkets,
    batchId: string,
    trigger: RunTriggerValue,
    args: { status: string; category: string; message: string; unit?: QueryUnit },
  ): Promise<void> {
    await this.deps.repo.insertSearchRun({
      tracker_id: tracker.id,
      config_version_id: tracker.current_config_version_id,
      batch_id: batchId,
      trigger,
      endpoint: args.unit?.endpoint ?? EndpointType.GOOGLE_FLIGHTS,
      market: args.unit?.market ?? tracker.markets[0] ?? this.deps.config.defaultMarket,
      currency: tracker.currency,
      outbound_date: args.unit?.outboundDate ?? tracker.outbound_date,
      return_date: args.unit?.returnDate ?? tracker.return_date,
      query_fingerprint: args.unit?.fingerprint ?? "",
      started_at: nowIso(),
      completed_at: nowIso(),
      status: args.status,
      cache_status: CacheStatus.NOT_APPLICABLE,
      error_category: args.category,
      skip_reason: args.message,
      coverage_cycle: tracker.coverage_cycle,
    });
  }

  // ---------------------------------------------------------- persistence
  private async persistOffers(
    tracker: TrackerWithMarkets,
    runId: number,
    unit: QueryUnit,
    providerResult: ProviderResult,
    result: CheckResult,
  ): Promise<void> {
    const { repo, config } = this.deps;
    const assessed = providerResult.offers
      .map((offer) => ({ offer, ...eligibilityFor(tracker, offer) }))
      .sort((a, b) => a.offer.priceCents - b.offer.priceCents);
    result.offersFound += assessed.length;

    if (assessed.length === 0) {
      await repo.updateSearchRun(runId, {
        completed_at: nowIso(),
        status: RunStatus.NO_RESULTS,
        provider_request_count: providerResult.requestCount,
        offers_found: 0,
      });
      if (unit.candidateId !== null && unit.candidateCycle !== null) {
        await repo.markCandidateMarketChecked(
          unit.candidateId,
          unit.market,
          unit.candidateCycle,
          CandidateStatus.CHECKED,
          runId,
          null,
        );
      }
      return;
    }

    const bestEligible = assessed.find((entry) => entry.eligible) ?? null;
    const kept = assessed.slice(0, MAX_STORED_OFFERS);
    // Keep the response bounded without allowing cheaper provider-filter
    // violations to crowd the first usable fare out of persistence.  The
    // tracker summary and alert evaluation both require an observation id, so
    // dropping that fare here would incorrectly turn a valid result into
    // "no results" whenever 25 ineligible offers happened to precede it.
    if (bestEligible !== null && !kept.includes(bestEligible)) {
      kept[kept.length - 1] = bestEligible;
      kept.sort((a, b) => a.offer.priceCents - b.offer.priceCents);
    }
    const bestIndex = bestEligible === null ? -1 : kept.indexOf(bestEligible);
    const observedAt = nowIso();
    const travelers = payingTravelersOf(tracker);

    const rows = await Promise.all(
      kept.map(async ({ offer, eligible, reason }, index) => ({
        search_run_id: runId,
        tracker_id: tracker.id,
        config_version_id: tracker.current_config_version_id,
        itinerary_fingerprint: await itineraryFingerprint({
          origin: offer.origin,
          destination: offer.destination,
          outbound_date: offer.outboundDate,
          return_date: offer.returnDate,
          flight_numbers: offer.flightNumbers,
          departure_time: offer.departureTime,
          arrival_time: offer.arrivalTime,
          stops: offer.stops,
          market: offer.market,
        }),
        price_amount_cents: offer.priceCents,
        currency: offer.currency,
        price_scope: config.priceScope,
        ...normalizedColumns(offer.priceCents, config.priceScope, travelers),
        origin: offer.origin,
        destination: offer.destination,
        outbound_date: offer.outboundDate ?? unit.outboundDate,
        return_date: offer.returnDate ?? unit.returnDate,
        departure_time: offer.departureTime,
        arrival_time: offer.arrivalTime,
        airlines: JSON.stringify(offer.airlines),
        flight_numbers: JSON.stringify(offer.flightNumbers),
        stops: offer.stops,
        duration_minutes: offer.durationMinutes,
        cabin: offer.cabin,
        segments: JSON.stringify(offer.segments),
        layovers: JSON.stringify(offer.layovers),
        booking_link: offer.bookingLink,
        search_link: offer.searchLink ?? providerResult.searchLink,
        market: offer.market,
        observed_at: observedAt,
        eligible: eligible ? 1 : 0,
        exclusion_reason: reason,
        is_best_of_run: index === bestIndex ? 1 : 0,
      })),
    );

    const ids = await repo.insertObservations(rows);
    const bestId = bestIndex >= 0 ? (ids[bestIndex] ?? null) : null;

    if (bestIndex < 0) {
      await repo.updateSearchRun(runId, {
        completed_at: nowIso(),
        status: RunStatus.NO_RESULTS,
        provider_request_count: providerResult.requestCount,
        offers_found: assessed.length,
        error_message:
          "The provider returned itineraries, but none matched this tracker's currency or stops preference. They are stored and marked ineligible.",
      });
      if (unit.candidateId !== null && unit.candidateCycle !== null) {
        await repo.markCandidateMarketChecked(
          unit.candidateId,
          unit.market,
          unit.candidateCycle,
          CandidateStatus.CHECKED,
          runId,
          null,
        );
      }
      return;
    }

    const bestOffer = kept[bestIndex]!.offer;
    const bestPrice = bestOffer.priceCents;

    await repo.updateSearchRun(runId, {
      completed_at: nowIso(),
      status: RunStatus.SUCCESS,
      provider_request_count: providerResult.requestCount,
      offers_found: assessed.length,
      best_observation_id: bestId,
    });

    if (unit.candidateId !== null && unit.candidateCycle !== null) {
      await repo.markCandidateMarketChecked(
        unit.candidateId,
        unit.market,
        unit.candidateCycle,
        CandidateStatus.CHECKED,
        runId,
        bestPrice,
      );
    }

    if (result.bestPriceCents === null || bestPrice < result.bestPriceCents) {
      result.bestPriceCents = bestPrice;
      result.bestMarket = bestOffer.market;
      result.bestObservationId = bestId;
    }
  }

  // ------------------------------------------------------------- finalize
  private async finalize(tracker: TrackerWithMarkets, result: CheckResult): Promise<void> {
    const { repo, config, alerts } = this.deps;

    if (result.bestPriceCents === null || result.bestObservationId === null) {
      const wholeCheckFailed = result.providerFailures > 0 && result.successfulUnits === 0;
      if (wholeCheckFailed) {
        const nextFailures = tracker.consecutive_failures + 1;
        const lastMessage = result.errors[result.errors.length - 1] ?? "Provider check failed.";
        await repo.updateTrackerFields(tracker.id, {
          consecutive_failures: nextFailures,
          last_error_category: result.lastErrorCategory ?? ErrorCategory.PROVIDER_ERROR,
          last_error_message: lastMessage,
        });
        tracker.consecutive_failures = nextFailures;
        tracker.last_error_message = lastMessage;
      } else if (result.successfulUnits > 0 && tracker.consecutive_failures > 0) {
        await repo.updateTrackerFields(tracker.id, {
          consecutive_failures: 0,
          last_error_category: null,
          last_error_message: null,
        });
        tracker.consecutive_failures = 0;
      }

      // Park only after failed tracker checks, never after several failed
      // markets inside one check.
      if (wholeCheckFailed && tracker.consecutive_failures >= FAILURE_LIMIT) {
        // Only the transition is announced. A tracker already parked that
        // fails again must stay silent, or a permanently invalid key would
        // message the owner on every tick -- and deploying this must send
        // nothing at all, because nothing is transitioning.
        const wasParked = tracker.status === TrackerStatus.ERROR;
        await repo.updateTrackerFields(tracker.id, { status: TrackerStatus.ERROR });
        tracker.status = TrackerStatus.ERROR;
        if (!wasParked) await this.announceParked(tracker, result);
      }
      await this.scheduleFollowUp(tracker, result);
      return;
    }

    const observation = await repo.getObservation(result.bestObservationId);
    if (observation === null) {
      await this.scheduleFollowUp(tracker, result);
      return;
    }

    const [previousObservation, lowObservation] = await Promise.all([
      tracker.latest_observation_id === null
        ? Promise.resolve(null)
        : repo.getObservation(tracker.latest_observation_id),
      tracker.low_observation_id === null
        ? Promise.resolve(null)
        : repo.getObservation(tracker.low_observation_id),
    ]);
    const travelers = payingTravelersOf(tracker);
    const basis = tracker.threshold_basis as ThresholdBasisValue;
    const previousComparable = comparableObservationCents(
      previousObservation,
      tracker.latest_price_cents,
      config.priceScope,
      basis,
      travelers,
    );
    const lowComparable = comparableObservationCents(
      lowObservation,
      tracker.low_price_cents,
      config.priceScope,
      basis,
      travelers,
    );
    const hadBaseline = previousComparable !== null;

    const evaluation = evaluate({
      reportedCents: observation.price_amount_cents,
      priceScope: observation.price_scope as PriceScopeValue,
      thresholdCents: tracker.threshold_amount_cents,
      thresholdBasis: basis,
      payingTravelers: travelers,
      state: {
        previousBestCents: previousComparable,
        seriesLowCents: lowComparable,
        hasBaseline: hadBaseline,
        previouslyMetThreshold: tracker.last_threshold_met === 1,
      },
      alertOnThreshold: tracker.alert_on_threshold === 1,
      alertOnNewLow: tracker.alert_on_new_low === 1,
      minDropAbsoluteCents: tracker.min_drop_absolute_cents,
      minDropPercentBp: tracker.min_drop_percent_bp,
    });

    const isNewLow =
      tracker.low_price_cents === null || observation.price_amount_cents < tracker.low_price_cents;

    await repo.updateTrackerFields(tracker.id, {
      latest_price_cents: observation.price_amount_cents,
      latest_observation_id: observation.id,
      latest_observed_at: observation.observed_at,
      low_price_cents: isNewLow ? observation.price_amount_cents : tracker.low_price_cents,
      low_observation_id: isNewLow ? observation.id : tracker.low_observation_id,
      low_observed_at: isNewLow ? observation.observed_at : tracker.low_observed_at,
      last_threshold_met: evaluation.meetsThreshold ? 1 : 0,
      last_success_at: nowIso(),
      consecutive_failures: 0,
      last_error_category: null,
      last_error_message: null,
      status: tracker.status === TrackerStatus.ERROR ? TrackerStatus.ACTIVE : tracker.status,
    });

    // Everything above is committed before a message is attempted.
    const coverage = await this.coverageFor(tracker);
    const outcomes = await alerts.process({
      tracker,
      observation,
      evaluation,
      coverage,
      chatId: this.deps.chatId,
    });

    for (const outcome of outcomes) {
      result.alerts.push({ type: outcome.alertType, state: outcome.state, detail: outcome.detail });
      if (outcome.state === DeliveryState.SENT) result.alertsSent += 1;
      if (
        outcome.state === DeliveryState.FAILED ||
        outcome.state === DeliveryState.UNCERTAIN
      ) result.telegramFailures += 1;
    }

    // Soft heads-up: the fare just improved to within 5% above the threshold.
    // Only on a baseline or a new low (never on ordinary fluctuation), only
    // when threshold alerts are on, and never alongside a real alert, which
    // already says everything this would.
    const withinApproachBand =
      !evaluation.meetsThreshold &&
      evaluation.comparableCents * 100 <= tracker.threshold_amount_cents * 105;
    if (
      withinApproachBand &&
      tracker.alert_on_threshold === 1 &&
      (evaluation.isBaseline || evaluation.isNewLow) &&
      evaluation.alertsToSend.length === 0
    ) {
      const outcome = await alerts.processApproaching({
        tracker,
        observation,
        evaluation,
        coverage,
        chatId: this.deps.chatId,
      });
      result.alerts.push({ type: outcome.alertType, state: outcome.state, detail: outcome.detail });
      if (outcome.state === DeliveryState.SENT) result.alertsSent += 1;
      if (
        outcome.state === DeliveryState.FAILED ||
        outcome.state === DeliveryState.UNCERTAIN
      ) result.telegramFailures += 1;
    }

    await this.scheduleFollowUp(tracker, result);
  }

  /**
   * Decide when this tracker is next due.
   *
   * A scan the tick clamped has planned work it never reached, so it comes
   * back on the next Cron tick rather than waiting out a whole check interval;
   * anything else keeps the interval the owner configured. `scheduleNextRun`
   * is deliberately left alone: its contract is "one configured interval from
   * now, floored at 15 minutes", and bending it here would change what it
   * means everywhere else it is called.
   */
  private async scheduleFollowUp(
    tracker: TrackerWithMarkets,
    result: CheckResult,
  ): Promise<void> {
    const { repo } = this.deps;
    if (!result.workRemaining) {
      await scheduleNextRun(repo, tracker);
      return;
    }
    const at = toIso(addMinutes(new Date(), RESUME_MINUTES));
    await repo.updateTrackerFields(tracker.id, { next_run_at: at });
    tracker.next_run_at = at;
  }

  /**
   * Tell the owner, once, that a tracker has stopped checking itself.
   *
   * Without this the tracker goes quiet and the silence is indistinguishable
   * from "no fare moved" -- which is how a broken key stayed unnoticed for
   * days. It is deliberately not an alert_events row: it is a statement about
   * the tracker, not a finding about a fare, and the transition guard above is
   * its deduplication.
   */
  private async announceParked(
    tracker: TrackerWithMarkets,
    result: CheckResult,
  ): Promise<void> {
    // This run's own last failure, not the tracker row: `executeLive` writes
    // the message to D1 without refreshing the in-memory copy, which would
    // otherwise make the notice quote whatever was there when the check began.
    const reason =
      result.errors[result.errors.length - 1] ??
      tracker.last_error_message ??
      tracker.last_error_category ??
      "no detail recorded";
    const text =
      `⚠️ Tracker paused after ${FAILURE_LIMIT} consecutive failed checks — ` +
      `${escapeHtml(tracker.name)} ` +
      `(${escapeHtml(tracker.origin)}→${escapeHtml(tracker.destination)}).\n\n` +
      `Last error: ${escapeHtml(reason)}\n\n` +
      "FlightNotify will not spend more searches on it until it is edited or resumed.";

    const sent = await this.deps.alerts.sendOperationalNotice(this.deps.chatId, text);
    // Counted even when Telegram is simply unconfigured: unlike a fare alert,
    // this notice leaves no row behind, so the tick's failure count is the
    // only trace that the owner was never told.
    if (!sent) result.telegramFailures += 1;
  }

  private async coverageFor(tracker: TrackerWithMarkets): Promise<CoverageInfo> {
    if (tracker.date_mode !== DateMode.CUSTOM_WINDOW || tracker.current_config_version_id === null) {
      return { checked: null, total: null, complete: true };
    }
    const { checked, total } = await this.deps.repo.candidateCoverage(
      tracker.current_config_version_id,
      tracker.coverage_cycle,
    );
    return { checked, total, complete: total > 0 && checked >= total };
  }

  /** Re-attempt alerts that previously failed with a retryable error. */
  async retryPendingAlerts(limit: number): Promise<{ delivered: number; failed: number }> {
    return this.deps.alerts.retryPending(this.deps.chatId, limit);
  }
}

/** Derived party/per-traveler columns, matching the Python observation writer. */
function normalizedColumns(
  priceCents: number,
  scope: PriceScopeValue,
  travelers: number,
): Record<string, number | null> {
  if (scope === PriceScopeLabel.PARTY_TOTAL) {
    return {
      party_total_amount_cents: priceCents,
      party_total_is_calculated: 0,
      per_traveler_amount_cents: Math.round(priceCents / Math.max(1, travelers)),
      per_traveler_is_calculated: 1,
    };
  }
  if (scope === PriceScopeLabel.PER_TRAVELER) {
    return {
      party_total_amount_cents: priceCents * Math.max(1, travelers),
      party_total_is_calculated: 1,
      per_traveler_amount_cents: priceCents,
      per_traveler_is_calculated: 0,
    };
  }
  return {
    party_total_amount_cents: null,
    party_total_is_calculated: 0,
    per_traveler_amount_cents: null,
    per_traveler_is_calculated: 0,
  };
}

function statusForCategory(category: string): string {
  switch (category) {
    case ErrorCategory.RATE_LIMIT:
      return RunStatus.RATE_LIMITED;
    case ErrorCategory.QUOTA_EXHAUSTED:
      return RunStatus.QUOTA_BLOCKED;
    case ErrorCategory.UNSUPPORTED_QUERY:
      return RunStatus.INVALID_REQUEST;
    case ErrorCategory.MISSING_CREDENTIALS:
    case ErrorCategory.INVALID_CREDENTIALS:
      return RunStatus.INVALID_REQUEST;
    default:
      return RunStatus.PROVIDER_ERROR;
  }
}

export { CoverageState, toIso };

interface CachedResultEnvelope {
  version: 1;
  result: ProviderResult;
}

function encodeCachedResult(result: ProviderResult, unit: QueryUnit): string {
  const envelope: CachedResultEnvelope = {
    version: 1,
    result: {
      ...result,
      endpoint: unit.endpoint,
      market: unit.market,
      queryFingerprint: unit.fingerprint,
      outboundDate: unit.outboundDate,
      returnDate: unit.returnDate,
      requestCount: 0,
      fromCache: true,
    },
  };
  return JSON.stringify(envelope);
}

function decodeCachedResult(payload: string, unit: QueryUnit): ProviderResult | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (!isRecord(value) || value["version"] !== 1 || !isProviderResult(value["result"])) {
      return null;
    }
    const result = value["result"];
    if (
      result.endpoint !== unit.endpoint ||
      result.market !== unit.market ||
      result.queryFingerprint !== unit.fingerprint
    ) {
      return null;
    }
    return { ...result, requestCount: 0, fromCache: true };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNormalizedOffer(value: unknown): value is NormalizedOffer {
  if (!isRecord(value)) return false;
  return (
    typeof value["priceCents"] === "number" &&
    Number.isFinite(value["priceCents"]) &&
    value["priceCents"] >= 0 &&
    typeof value["currency"] === "string" &&
    typeof value["priceScope"] === "string" &&
    typeof value["market"] === "string" &&
    isNullableString(value["origin"]) &&
    isNullableString(value["destination"]) &&
    isNullableString(value["outboundDate"]) &&
    isNullableString(value["returnDate"]) &&
    isNullableString(value["departureTime"]) &&
    isNullableString(value["arrivalTime"]) &&
    isStringArray(value["airlines"]) &&
    isStringArray(value["flightNumbers"]) &&
    isNullableNumber(value["stops"]) &&
    isNullableNumber(value["durationMinutes"]) &&
    isNullableString(value["cabin"]) &&
    Array.isArray(value["segments"]) &&
    value["segments"].every(isRecord) &&
    Array.isArray(value["layovers"]) &&
    value["layovers"].every(isRecord) &&
    isNullableString(value["bookingLink"]) &&
    isNullableString(value["searchLink"])
  );
}

function isProviderResult(value: unknown): value is ProviderResult {
  if (!isRecord(value)) return false;
  return (
    typeof value["endpoint"] === "string" &&
    typeof value["market"] === "string" &&
    typeof value["currency"] === "string" &&
    typeof value["queryFingerprint"] === "string" &&
    Array.isArray(value["offers"]) &&
    value["offers"].every(isNormalizedOffer) &&
    typeof value["responseAt"] === "string" &&
    typeof value["requestCount"] === "number" &&
    isNullableString(value["searchLink"]) &&
    isNullableString(value["outboundDate"]) &&
    isNullableString(value["returnDate"]) &&
    isRecord(value["rawExcerpt"]) &&
    typeof value["fromCache"] === "boolean"
  );
}

function eligibilityFor(
  tracker: TrackerWithMarkets,
  offer: NormalizedOffer,
): { eligible: boolean; reason: string | null } {
  if (offer.currency.toUpperCase() !== tracker.currency.toUpperCase()) {
    return {
      eligible: false,
      reason: `Provider returned ${offer.currency}, tracker compares in ${tracker.currency}.`,
    };
  }
  if (offer.stops !== null) {
    if (tracker.stops === StopsPreference.NONSTOP && offer.stops > 0) {
      return { eligible: false, reason: "Has a stop; tracker requires nonstop." };
    }
    if (tracker.stops === StopsPreference.ONE_STOP_MAX && offer.stops > 1) {
      return { eligible: false, reason: "More than one stop; tracker allows at most one." };
    }
  }
  return { eligible: true, reason: null };
}

function comparableObservationCents(
  observation: FareObservationRow | null,
  fallbackReportedCents: number | null,
  fallbackScope: PriceScopeValue,
  basis: ThresholdBasisValue,
  travelers: number,
): number | null {
  if (observation !== null) {
    if (basis === ThresholdBasis.PARTY && observation.party_total_amount_cents !== null) {
      return observation.party_total_amount_cents;
    }
    if (
      basis === ThresholdBasis.PER_TRAVELER &&
      observation.per_traveler_amount_cents !== null
    ) {
      return observation.per_traveler_amount_cents;
    }
    return comparableCents(
      observation.price_amount_cents,
      observation.price_scope as PriceScopeValue,
      basis,
      travelers,
    );
  }
  return fallbackReportedCents === null
    ? null
    : comparableCents(fallbackReportedCents, fallbackScope, basis, travelers);
}
