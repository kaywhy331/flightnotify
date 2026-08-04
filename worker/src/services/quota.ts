/**
 * Free-tier quota enforcement.
 *
 * Port of `flightnotify/services/quota.py`. The guard is product behaviour,
 * not documentation: normal application activity cannot exceed the configured
 * monthly allowance. Two independent signals are combined and the *most
 * conservative* wins -- a local ledger of every billable call, and the
 * provider's own reported account status.
 *
 * A configurable reserve is held back so a deliberate "Check now" still works
 * after automation has stopped.
 */

import type { Config } from "../env.js";
import type { Repo } from "../db/repo.js";
import { RunTrigger, type RunTriggerValue } from "../domain/enums.js";
import { periodKey } from "../time.js";

/** Triggers allowed to draw on the reserve. Automation never is. */
const RESERVE_ELIGIBLE: ReadonlySet<string> = new Set([RunTrigger.MANUAL, RunTrigger.INITIAL]);

export interface QuotaSnapshot {
  period: string;
  monthlyLimit: number;
  reserve: number;
  reservePercent: number;
  localUsed: number;
  providerUsed: number | null;
  providerLeft: number | null;
  providerLimit: number | null;
  providerPlan: string | null;
  providerAccountMasked: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  hourlyLimit: number;
  hourlyUsed: number;

  effectiveUsed: number;
  remainingHard: number;
  remainingSafe: number;
  usedPercent: number;
  hourlyRemaining: number;
  isExhausted: boolean;
  automationBlocked: boolean;
}

export interface SpendDecision {
  allowed: boolean;
  granted: number;
  reason: string;
}

export interface QuotaReservation {
  period: string;
  hour: string;
  reserved: number;
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export class QuotaManager {
  constructor(
    private readonly repo: Repo,
    private readonly config: Config,
  ) {}

  async snapshot(now = new Date()): Promise<QuotaSnapshot> {
    const period = periodKey(now);
    const row = await this.repo.usageRow(period);
    const hourlyUsed = await this.repo.hourlyUsed(new Date(now.getTime() - 3600_000));

    const monthlyLimit = this.config.monthlySearchBudget;
    const reserve = this.config.reserveSearches;
    const localUsed = row.local_searches;
    const providerUsed = row.provider_this_month_usage;
    const providerLeft = row.provider_searches_left;

    // Never the lower of the two: if the provider has seen more calls than we
    // recorded, the provider is right and we stop sooner.
    const effectiveUsed = providerUsed === null ? localUsed : Math.max(localUsed, providerUsed);

    let remainingHard = monthlyLimit - effectiveUsed;
    if (providerLeft !== null) remainingHard = Math.min(remainingHard, providerLeft);
    remainingHard = Math.max(0, remainingHard);

    const remainingSafe = Math.max(0, remainingHard - reserve);
    const hourlyLimit =
      row.provider_rate_limit_per_hour === null
        ? this.config.hourlySearchLimit
        : Math.min(this.config.hourlySearchLimit, row.provider_rate_limit_per_hour);
    const hourlyRemaining = Math.max(0, hourlyLimit - hourlyUsed);

    return {
      period,
      monthlyLimit,
      reserve,
      reservePercent: this.config.reservePercent,
      localUsed,
      providerUsed,
      providerLeft,
      providerLimit: row.provider_searches_per_month,
      providerPlan: row.provider_plan_name,
      providerAccountMasked: row.provider_account_email_masked,
      lastSyncedAt: row.last_synced_at,
      syncError: row.last_sync_error,
      hourlyLimit,
      hourlyUsed,
      effectiveUsed,
      remainingHard,
      remainingSafe,
      usedPercent:
        monthlyLimit <= 0
          ? 100
          : Math.min(100, Math.round((effectiveUsed / monthlyLimit) * 1000) / 10),
      hourlyRemaining,
      isExhausted: remainingHard <= 0,
      automationBlocked: remainingSafe <= 0,
    };
  }

  /**
   * Reserve capacity before a provider request.
   *
   * Monthly and hourly counters each use an atomic conditional write.  They
   * are deliberately conservative across the tiny gap between the two writes:
   * a killed invocation can leave capacity reserved, but cannot spend an
   * unreserved call.  Housekeeping/reconciliation can recover stale capacity;
   * protecting the owner's paid allowance takes precedence over availability.
   */
  async reserveCalls(
    count: number,
    trigger: RunTriggerValue,
    now = new Date(),
  ): Promise<{ decision: SpendDecision; reservation: QuotaReservation | null }> {
    if (count <= 0) {
      return {
        decision: { allowed: true, granted: 0, reason: "" },
        reservation: { period: periodKey(now), hour: hourKey(now), reserved: 0 },
      };
    }

    const period = periodKey(now);
    const row = await this.repo.usageRow(period);
    const mayUseReserve = RESERVE_ELIGIBLE.has(trigger);
    const configuredLimit = mayUseReserve
      ? this.config.monthlySearchBudget
      : Math.max(0, this.config.monthlySearchBudget - this.config.reserveSearches);
    const allowedLimit =
      row.provider_searches_per_month === null
        ? configuredLimit
        : Math.min(configuredLimit, row.provider_searches_per_month);

    if (!(await this.repo.reserveMonthlyCalls(period, count, allowedLimit))) {
      const snapshot = await this.snapshot(now);
      return {
        reservation: null,
        decision: {
          allowed: false,
          granted: 0,
          reason:
            snapshot.remainingHard <= 0
              ? `Monthly provider allowance is exhausted (${snapshot.effectiveUsed}/${snapshot.monthlyLimit} used in ${snapshot.period}).`
              : mayUseReserve
                ? "The remaining provider allowance is smaller than this request's retry reservation."
                : `Only the ${snapshot.reserve}-search reserve remains; automated checks are paused.`,
        },
      };
    }

    const providerHourly = row.provider_rate_limit_per_hour;
    const hourlyLimit =
      providerHourly === null
        ? this.config.hourlySearchLimit
        : Math.min(this.config.hourlySearchLimit, providerHourly);
    const hour = hourKey(now);
    if (!(await this.repo.reserveHourlyCalls(hour, count, hourlyLimit))) {
      await this.repo.releaseMonthlyCalls(period, count);
      return {
        reservation: null,
        decision: {
          allowed: false,
          granted: 0,
          reason:
            `The provider's hourly throughput limit (${hourlyLimit}/hour) is reached. ` +
            "FlightNotify will resume on a later run.",
        },
      };
    }

    return {
      decision: { allowed: true, granted: count, reason: "" },
      reservation: { period, hour, reserved: count },
    };
  }

  /** Reconcile a conservative reservation with the adapter's actual attempts. */
  async finalizeReservation(
    reservation: QuotaReservation,
    endpoint: string,
    runId: number | null,
    actualCount: number,
    now = new Date(),
  ): Promise<void> {
    const actual = Math.max(0, Math.min(reservation.reserved, Math.trunc(actualCount)));
    const unused = reservation.reserved - actual;
    if (unused > 0) {
      await this.repo.releaseMonthlyCalls(reservation.period, unused);
      await this.repo.releaseHourlyCalls(reservation.hour, unused);
    }
    await this.repo.insertProviderCallRows(endpoint, runId, actual, now.toISOString());
  }

  /** Decide how many of `wanted` billable calls may be made now. */
  async authorize(
    wanted: number,
    trigger: RunTriggerValue,
    now = new Date(),
  ): Promise<{ decision: SpendDecision; snapshot: QuotaSnapshot }> {
    const snapshot = await this.snapshot(now);
    const mayUseReserve = RESERVE_ELIGIBLE.has(trigger);
    const budget = mayUseReserve ? snapshot.remainingHard : snapshot.remainingSafe;

    if (snapshot.monthlyLimit <= 0) {
      return {
        snapshot,
        decision: {
          allowed: false,
          granted: 0,
          reason: "MONTHLY_SEARCH_BUDGET is 0, so no searches are permitted.",
        },
      };
    }

    if (budget <= 0) {
      const reason =
        snapshot.remainingHard <= 0
          ? `Monthly provider allowance is exhausted (${snapshot.effectiveUsed}/${snapshot.monthlyLimit} used in ${snapshot.period}).`
          : `Only the ${snapshot.reserve}-search reserve remains (${snapshot.remainingHard} left); ` +
            "automated checks are paused so a manual check stays possible.";
      return { snapshot, decision: { allowed: false, granted: 0, reason } };
    }

    if (snapshot.hourlyRemaining <= 0) {
      return {
        snapshot,
        decision: {
          allowed: false,
          granted: 0,
          reason:
            `The provider's hourly throughput limit (${snapshot.hourlyLimit}/hour) is reached. ` +
            "FlightNotify will resume on a later run.",
        },
      };
    }

    const granted = Math.min(wanted, budget, snapshot.hourlyRemaining);
    if (granted < wanted) {
      return {
        snapshot,
        decision: {
          allowed: true,
          granted,
          reason:
            `Reduced from ${wanted} to ${granted} searches to stay within the configured ` +
            `allowance (${snapshot.remainingHard} left this period).`,
        },
      };
    }
    return { snapshot, decision: { allowed: true, granted, reason: "" } };
  }

  /**
   * Record billable calls.
   *
   * A search that returned no itineraries still counts. SerpApi states errored
   * searches are not billed, but over-counting stops automation early, which is
   * the safe direction for a hard cap on someone's bill.
   */
  async recordCalls(
    endpoint: string,
    runId: number | null,
    count: number,
    now = new Date(),
  ): Promise<void> {
    if (count <= 0) return;
    const period = periodKey(now);
    await this.repo.usageRow(period);
    await this.repo.recordProviderCalls(period, endpoint, runId, count);
  }

  /** Refresh provider-reported quota. Never consumes a fare search. */
  async syncFromProvider(
    status: {
      planName: string | null;
      searchesPerMonth: number | null;
      searchesLeft: number | null;
      thisMonthUsage: number | null;
      rateLimitPerHour: number | null;
      accountEmailMasked: string | null;
      fetchedAt: string;
    } | null,
    error: string | null,
    now = new Date(),
  ): Promise<void> {
    const period = periodKey(now);
    const row = await this.repo.usageRow(period);

    if (status === null) {
      await this.repo.updateUsage(period, { last_sync_error: error });
      return;
    }

    await this.repo.updateUsage(period, {
      provider_plan_name: status.planName,
      provider_searches_per_month: status.searchesPerMonth,
      provider_searches_left: status.searchesLeft,
      provider_this_month_usage: status.thisMonthUsage,
      provider_rate_limit_per_hour: status.rateLimitPerHour,
      provider_account_email_masked: status.accountEmailMasked,
      last_synced_at: status.fetchedAt,
      last_sync_error: null,
      // Never let the local ledger under-report what the provider has seen.
      local_searches:
        status.thisMonthUsage === null
          ? row.local_searches
          : Math.max(row.local_searches, status.thisMonthUsage),
    });
  }
}
