/**
 * Cron-triggered scheduling.
 *
 * Replaces the Python in-process scheduler thread. The differences that matter
 * are forced by the runtime, not chosen:
 *
 *   - There is no 60-second polling loop. The platform invokes `scheduled()`
 *     on the configured Cron interval, and due status is derived from
 *     `trackers.next_run_at` rather than from how often we happen to wake up.
 *     Changing the Cron interval therefore changes scheduling *latency*, never
 *     which trackers are due.
 *   - A tick does a bounded amount of work. The Free plan allows 10ms CPU, 50
 *     subrequests and 50 D1 queries per invocation, so a large flexible sweep
 *     is spread across ticks and its progress is persisted in
 *     `flexible_date_candidates`, not held in memory.
 *   - Cron delivery is at-least-once and ticks can overlap. The singleton D1
 *     lease makes a second concurrent tick a no-op instead of a double spend
 *     of the owner's search quota.
 */

import type { Config } from "./env.js";
import type { Repo } from "./db/repo.js";
import type { TrackerWithMarkets } from "./db/rows.js";
import { RunTrigger } from "./domain/enums.js";
import { nowIso } from "./time.js";

/** How much Cron history is kept. Long enough to diagnose last month's tick. */
const CRON_RUN_RETENTION_DAYS = 30;

export interface CheckOutcome {
  providerCalls: number;
  providerFailures: number;
  telegramFailures: number;
  alertsSent: number;
  errors: string[];
  workRemaining: boolean;
}

export interface CheckRunner {
  runTracker(
    tracker: TrackerWithMarkets,
    trigger: typeof RunTrigger.SCHEDULED | typeof RunTrigger.MANUAL,
    options?: { forceRefresh?: boolean; maxQueries?: number },
  ): Promise<CheckOutcome>;
  /** Re-attempt alerts that previously failed with a retryable error. */
  retryPendingAlerts(limit: number): Promise<{ delivered: number; failed: number }>;
}

export type TickOutcome =
  | "disabled"
  | "lease_held"
  | "no_work"
  | "completed"
  | "partial"
  | "error";

export interface TickReport {
  outcome: TickOutcome;
  detail: string;
  trackersSelected: number;
  trackersCompleted: number;
  queriesExecuted: number;
  providerFailures: number;
  telegramFailures: number;
  alertsSent: number;
  workRemaining: number;
  leaseAcquired: boolean;
  cronRunId: number | null;
}

/** Identifies this invocation in the lease, so a stale owner is recognisable. */
export function makeOwnerId(scheduledTime: number): string {
  const random = crypto.randomUUID().slice(0, 8);
  return `cron:${new Date(scheduledTime).toISOString()}:${random}`;
}

export async function runScheduledTick(
  repo: Repo,
  config: Config,
  runner: CheckRunner,
  options: {
    cron?: string | null;
    scheduledTime?: number;
    now?: Date;
    /** Weekly digest, invoked only while this tick holds the lease so two
     *  overlapping invocations cannot both send one. */
    digest?: () => Promise<{ sent: boolean }>;
  } = {},
): Promise<TickReport> {
  const now = options.now ?? new Date();
  const cron = options.cron ?? null;
  const owner = makeOwnerId(options.scheduledTime ?? now.getTime());

  const report: TickReport = {
    outcome: "completed",
    detail: "",
    trackersSelected: 0,
    trackersCompleted: 0,
    queriesExecuted: 0,
    providerFailures: 0,
    telegramFailures: 0,
    alertsSent: 0,
    workRemaining: 0,
    leaseAcquired: false,
    cronRunId: null,
  };

  // Recorded even when disabled: "the Cron Trigger is firing but scheduling is
  // off" and "the Cron Trigger never fired" are different problems, and the
  // operator needs to tell them apart from the UI.
  const cronRunId = await repo.startCronRun(cron);
  report.cronRunId = cronRunId;

  if (!config.schedulerEnabled) {
    report.outcome = "disabled";
    report.detail =
      "SCHEDULER_ENABLED is false, so no live searches were performed. " +
      "This is the expected state before cutover.";
    await repo.finishCronRun(cronRunId, {
      outcome: report.outcome,
      detail: report.detail,
      lease_acquired: 0,
    });
    return report;
  }

  const acquired = await repo.acquireSchedulerLease(owner, config.schedulerLeaseTtlSeconds, now);
  report.leaseAcquired = acquired;
  if (!acquired) {
    // Either a previous tick is still running inside its lease, or two ticks
    // raced. Not an error: the other holder is doing the work.
    const state = await repo.schedulerState();
    report.outcome = "lease_held";
    report.detail =
      `Another invocation holds the scheduler lease until ${state?.lock_expires_at ?? "unknown"}. ` +
      "Skipped to avoid duplicate concurrent searches.";
    await repo.finishCronRun(cronRunId, {
      outcome: report.outcome,
      detail: report.detail,
      lease_acquired: 0,
    });
    return report;
  }

  try {
    const due = await repo.selectDueTrackers(now, config.maxTrackersPerTick);
    report.trackersSelected = due.length;

    if (due.length === 0) {
      // Still worth a pass at undelivered alerts: a previous tick may have
      // stored an alert whose delivery failed with a retryable error.
      const retry = await runner.retryPendingAlerts(5);
      report.alertsSent += retry.delivered;
      report.telegramFailures += retry.failed;
      report.outcome = "no_work";
      report.detail = "No tracker was due.";
    } else {
      let budget = config.maxQueriesPerTick;
      const handled: number[] = [];

      for (const tracker of due) {
        if (budget <= 0) break;

        const locked = await repo.acquireTrackerLock(
          tracker.id,
          owner,
          config.schedulerLeaseTtlSeconds,
          now,
        );
        if (!locked) {
          // A manual "Check now" is in flight for this tracker. Leave it be;
          // it uses the same quota and alert paths, so nothing is lost.
          continue;
        }

        try {
          const outcome = await runner.runTracker(tracker, RunTrigger.SCHEDULED, {
            maxQueries: budget,
          });
          budget -= outcome.providerCalls;
          report.queriesExecuted += outcome.providerCalls;
          report.providerFailures += outcome.providerFailures;
          report.telegramFailures += outcome.telegramFailures;
          report.alertsSent += outcome.alertsSent;
          report.trackersCompleted += 1;
          if (outcome.workRemaining) report.workRemaining += 1;
        } catch (error) {
          // A single tracker failing must not abort the tick: the others are
          // independent, and the failure is already classified and persisted
          // against the tracker by the runner.
          report.providerFailures += 1;
          report.detail = describeError(error);
        } finally {
          handled.push(tracker.id);
          await repo.releaseTrackerLock(tracker.id, owner);
        }
      }

      const stillDue = await repo.countDueTrackers(now, handled);
      report.workRemaining = stillDue;
      if (stillDue > 0 || budget <= 0) {
        report.outcome = "partial";
        report.detail =
          report.detail ||
          `Bounded tick: ${report.trackersCompleted} tracker(s) checked, ${stillDue} still due. ` +
            "The next Cron invocation continues from here.";
      } else {
        report.outcome = "completed";
        report.detail = report.detail || `Checked ${report.trackersCompleted} tracker(s).`;
      }
    }

    if (options.digest) {
      try {
        const digest = await options.digest();
        if (digest.sent) report.alertsSent += 1;
      } catch (error) {
        // The digest is a nicety; it must never fail a tick that did real work.
        report.telegramFailures += 1;
        report.detail = report.detail || describeError(error);
      }
    }

    // Housekeeping, once per tick: cron_runs is the only fast-growing table.
    // Wrapped because a tick that checked trackers and sent alerts must not be
    // reported as failed just because a DELETE did not land.
    try {
      await repo.pruneCronRuns(
        new Date(now.getTime() - CRON_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      );
    } catch {
      // Intentionally silent: the next tick tries again, and nothing downstream
      // depends on the old rows being gone.
    }

    await repo.recordSweepState(report.outcome === "completed" ? "complete" : report.outcome);
    return report;
  } catch (error) {
    report.outcome = "error";
    report.detail = describeError(error);
    return report;
  } finally {
    await repo.finishCronRun(cronRunId, {
      outcome: report.outcome,
      detail: report.detail.slice(0, 2000),
      lease_acquired: report.leaseAcquired ? 1 : 0,
      lease_owner: owner,
      trackers_selected: report.trackersSelected,
      trackers_completed: report.trackersCompleted,
      queries_executed: report.queriesExecuted,
      provider_failures: report.providerFailures,
      telegram_failures: report.telegramFailures,
      alerts_sent: report.alertsSent,
      work_remaining: report.workRemaining,
    });
    // Released explicitly so the next tick starts immediately rather than
    // waiting out the TTL. The TTL only matters when a Worker is killed
    // mid-tick and never reaches this line.
    await repo.releaseSchedulerLease(
      owner,
      report.outcome === "error" ? report.detail.slice(0, 500) : null,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export { nowIso };
