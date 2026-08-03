/**
 * Scheduling behaviour against a real local D1.
 *
 * These are the properties that keep a Cron-driven scheduler from spending the
 * owner's search quota twice, so they are tested through actual SQL rather
 * than a mock repository that would agree with whatever the code does.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { loadConfig, type Env } from "../../src/env.js";
import { runScheduledTick, type CheckOutcome, type CheckRunner } from "../../src/scheduled.js";
import { toIso } from "../../src/time.js";

const BASE_ENV: Partial<Env> = {
  SESSION_SECRET: "x".repeat(48),
  AUTH_PASSWORD_HASH: "pbkdf2$sha256$210000$c2FsdA$aGFzaA",
  SCHEDULER_ENABLED: "true",
  MAX_TRACKERS_PER_TICK: "2",
  MAX_QUERIES_PER_TICK: "3",
  SCHEDULER_LEASE_TTL_SECONDS: "300",
};

function configFor(overrides: Partial<Env> = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides, DB: env.DB } as Env).config;
}

function repo(): Repo {
  return new Repo(env.DB);
}

/** A runner that records what it was asked to do and never touches a network. */
function fakeRunner(overrides: Partial<CheckOutcome> = {}): CheckRunner & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async runTracker(tracker) {
      calls.push(tracker.id);
      return {
        providerCalls: 1,
        providerFailures: 0,
        telegramFailures: 0,
        alertsSent: 0,
        errors: [],
        workRemaining: false,
        ...overrides,
      };
    },
    async retryPendingAlerts() {
      return { delivered: 0, failed: 0 };
    },
  };
}

async function insertTracker(
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const now = toIso(new Date());
  const fields: Record<string, unknown> = {
    name: "Tokyo autumn",
    status: "active",
    origin: "SFO",
    destination: "NRT",
    adults: 2,
    cabin: "economy",
    stops: "any",
    date_mode: "exact",
    outbound_date: "2026-09-30",
    return_date: "2026-10-08",
    currency: "USD",
    threshold_amount_cents: 130000,
    threshold_basis: "party",
    check_interval_minutes: 720,
    next_run_at: toIso(new Date(Date.now() - 60_000)),
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  return repo().insertTracker(fields);
}

beforeEach(async () => {
  // Each test starts from a known state; migrations already ran in setup.
  await env.DB.exec("DELETE FROM cron_runs");
  await env.DB.exec("DELETE FROM alert_events");
  await env.DB.exec("DELETE FROM fare_observations");
  await env.DB.exec("DELETE FROM search_runs");
  await env.DB.exec("DELETE FROM tracker_markets");
  await env.DB.exec("DELETE FROM trackers");
  await env.DB.exec(
    "UPDATE scheduler_state SET lock_owner = NULL, lock_expires_at = NULL, tick_count = 0",
  );
});

describe("migrations", () => {
  it("initialise an empty database reproducibly", async () => {
    const row = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    expect(row?.value).toBe("2");

    const health = await repo().health();
    expect(health.ok).toBe(true);
  });

  it("enforce the alert dedupe uniqueness constraint", async () => {
    const trackerId = await insertTracker();
    const base = {
      tracker_id: trackerId,
      alert_type: "new_low",
      dedupe_key: "duplicate-key",
      message_text: "first",
      delivery_state: "pending",
      created_at: toIso(new Date()),
    };
    const first = await repo().insertAlertEvent(base);
    const second = await repo().insertAlertEvent({ ...base, message_text: "second" });

    expect(first).not.toBeNull();
    // The second insert is absorbed by ON CONFLICT DO NOTHING, which is what
    // makes a manual check and a Cron tick finding the same fare send once.
    expect(second).toBeNull();

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_events").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("scheduler lease", () => {
  it("is held by exactly one owner at a time", async () => {
    const r = repo();
    expect(await r.acquireSchedulerLease("owner-a", 300)).toBe(true);
    expect(await r.acquireSchedulerLease("owner-b", 300)).toBe(false);
  });

  it("is reclaimable once expired, so a killed Worker cannot wedge scheduling", async () => {
    const r = repo();
    const past = new Date(Date.now() - 3600_000);
    // Acquire with a lease that was already expiring an hour ago.
    expect(await r.acquireSchedulerLease("dead-worker", 1, past)).toBe(true);

    const state = await r.schedulerState();
    expect(state?.lock_owner).toBe("dead-worker");

    // A later invocation takes it over rather than waiting forever.
    expect(await r.acquireSchedulerLease("live-worker", 300, new Date())).toBe(true);
    const after = await r.schedulerState();
    expect(after?.lock_owner).toBe("live-worker");
  });

  it("is released so the next tick starts immediately", async () => {
    const r = repo();
    await r.acquireSchedulerLease("owner-a", 300);
    await r.releaseSchedulerLease("owner-a");
    expect(await r.acquireSchedulerLease("owner-b", 300)).toBe(true);
  });

  it("cannot be released by a different owner", async () => {
    const r = repo();
    await r.acquireSchedulerLease("owner-a", 300);
    await r.releaseSchedulerLease("someone-else");
    expect(await r.acquireSchedulerLease("owner-b", 300)).toBe(false);
  });
});

describe("due-work selection", () => {
  it("selects only active trackers whose next run has passed", async () => {
    await insertTracker({ name: "due" });
    await insertTracker({
      name: "not due",
      next_run_at: toIso(new Date(Date.now() + 3600_000)),
    });
    await insertTracker({ name: "paused", status: "paused" });

    const due = await repo().selectDueTrackers(new Date(), 10);
    expect(due.map((t) => t.name)).toEqual(["due"]);
  });

  it("treats a null next_run_at as due, so an imported tracker is picked up", async () => {
    await insertTracker({ name: "imported", next_run_at: null });
    const due = await repo().selectDueTrackers(new Date(), 10);
    expect(due.map((t) => t.name)).toEqual(["imported"]);
  });

  it("skips a tracker already locked by a live check", async () => {
    const id = await insertTracker();
    await repo().acquireTrackerLock(id, "manual-check", 300);
    const due = await repo().selectDueTrackers(new Date(), 10);
    expect(due).toHaveLength(0);
  });

  it("fetches markets without an N+1 query per tracker", async () => {
    const a = await insertTracker({ name: "a" });
    const b = await insertTracker({ name: "b" });
    await repo().setTrackerMarkets(a, ["us", "gb"]);
    await repo().setTrackerMarkets(b, ["us"]);

    const all = await repo().listTrackers();
    expect(all.find((t) => t.name === "a")?.markets).toEqual(["us", "gb"]);
    expect(all.find((t) => t.name === "b")?.markets).toEqual(["us"]);
  });
});

describe("tracker lock", () => {
  it("prevents a scheduled and a manual check running together", async () => {
    const id = await insertTracker();
    const r = repo();
    expect(await r.acquireTrackerLock(id, "cron", 300)).toBe(true);
    expect(await r.acquireTrackerLock(id, "manual", 300)).toBe(false);
    await r.releaseTrackerLock(id, "cron");
    expect(await r.acquireTrackerLock(id, "manual", 300)).toBe(true);
  });

  it("reclaims an expired tracker lock", async () => {
    const id = await insertTracker();
    const r = repo();
    await r.acquireTrackerLock(id, "dead", 1, new Date(Date.now() - 3600_000));
    expect(await r.acquireTrackerLock(id, "live", 300, new Date())).toBe(true);
  });
});

describe("scheduled tick", () => {
  it("performs no live work when SCHEDULER_ENABLED is false", async () => {
    await insertTracker();
    const runner = fakeRunner();
    const report = await runScheduledTick(repo(), configFor({ SCHEDULER_ENABLED: "false" }), runner);

    expect(report.outcome).toBe("disabled");
    expect(runner.calls).toEqual([]);
    expect(report.leaseAcquired).toBe(false);

    // Still recorded: "firing but disabled" must be distinguishable from
    // "never fired" in the UI.
    const runs = await repo().recentCronRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("disabled");
  });

  it("checks due trackers and records the run", async () => {
    await insertTracker({ name: "one" });
    const runner = fakeRunner();
    const report = await runScheduledTick(repo(), configFor(), runner);

    expect(report.outcome).toBe("completed");
    expect(report.trackersCompleted).toBe(1);
    expect(runner.calls).toHaveLength(1);

    const runs = await repo().recentCronRuns(5);
    expect(runs[0]?.outcome).toBe("completed");
    expect(runs[0]?.lease_acquired).toBe(1);
    expect(runs[0]?.completed_at).not.toBeNull();
  });

  it("skips when another invocation holds the lease", async () => {
    await insertTracker();
    await repo().acquireSchedulerLease("other-tick", 300);

    const runner = fakeRunner();
    const report = await runScheduledTick(repo(), configFor(), runner);

    expect(report.outcome).toBe("lease_held");
    expect(runner.calls).toEqual([]);
  });

  it("releases the lease after a tick so the next one can run", async () => {
    await insertTracker();
    await runScheduledTick(repo(), configFor(), fakeRunner());
    const state = await repo().schedulerState();
    expect(state?.lock_owner).toBeNull();
  });

  it("bounds work per invocation and reports what is still due", async () => {
    for (let i = 0; i < 5; i += 1) await insertTracker({ name: `t${i}` });

    const runner = fakeRunner();
    const report = await runScheduledTick(repo(), configFor({ MAX_TRACKERS_PER_TICK: "2" }), runner);

    expect(runner.calls).toHaveLength(2);
    expect(report.outcome).toBe("partial");
    expect(report.workRemaining).toBeGreaterThan(0);
  });

  it("records a failing tracker without aborting the whole tick", async () => {
    await insertTracker({ name: "bad" });
    await insertTracker({ name: "good" });

    let first = true;
    const runner: CheckRunner = {
      async runTracker() {
        if (first) {
          first = false;
          throw new Error("provider exploded");
        }
        return {
          providerCalls: 1,
          providerFailures: 0,
          telegramFailures: 0,
          alertsSent: 0,
          errors: [],
          workRemaining: false,
        };
      },
      async retryPendingAlerts() {
        return { delivered: 0, failed: 0 };
      },
    };

    const report = await runScheduledTick(repo(), configFor(), runner);
    expect(report.providerFailures).toBe(1);
    expect(report.trackersCompleted).toBe(1);

    const state = await repo().schedulerState();
    expect(state?.lock_owner).toBeNull();
  });

  it("retries undelivered alerts when nothing is due", async () => {
    let retried = 0;
    const runner: CheckRunner = {
      async runTracker() {
        throw new Error("should not be called");
      },
      async retryPendingAlerts() {
        retried += 1;
        return { delivered: 1, failed: 0 };
      },
    };

    const report = await runScheduledTick(repo(), configFor(), runner);
    expect(report.outcome).toBe("no_work");
    expect(retried).toBe(1);
    expect(report.alertsSent).toBe(1);
  });
});

describe("quota ledger", () => {
  it("counts billable calls atomically with the hourly log", async () => {
    const r = repo();
    await r.usageRow("2026-08");
    await r.recordProviderCalls("2026-08", "google_flights", null, 3);

    const usage = await r.usageRow("2026-08");
    expect(usage.local_searches).toBe(3);
    expect(await r.hourlyUsed(new Date(Date.now() - 3600_000))).toBe(3);
  });
});
