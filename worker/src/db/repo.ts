/**
 * D1 data access.
 *
 * Replaces the SQLAlchemy session layer. Two constraints shape everything here:
 *
 *   - The Workers Free plan allows 50 D1 queries per invocation. Every list
 *     view therefore fetches its joined data in a fixed number of statements
 *     (markets come back in one extra query and are grouped in memory) rather
 *     than one query per row.
 *   - There are no transactions across `await` boundaries in D1 the way there
 *     were in SQLAlchemy. `db.batch()` is atomic, so anything that must not be
 *     half-applied is expressed as a single batch, and anything that cannot be
 *     is ordered so a crash leaves the database in a state the next run can
 *     recover from (see the alert flow: the event row is committed before
 *     delivery is attempted, exactly as the Python version did).
 */

import { nowIso, toIso } from "../time.js";
import {
  fromBool,
  type AlertEventRow,
  type AppSettingRow,
  type AuthThrottleRow,
  type CronRunRow,
  type FareObservationRow,
  type FlexibleDateCandidateRow,
  type ProviderUsageRow,
  type SchedulerStateRow,
  type SearchRunRow,
  type TrackerConfigVersionRow,
  type TrackerRow,
  type TrackerWithMarkets,
} from "./rows.js";

export class D1Error extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "D1Error";
  }
}

/** Wrap a D1 call so a binding/SQL failure surfaces as a typed error. */
async function guard<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new D1Error(`database operation failed: ${what}`, error);
  }
}

export class Repo {
  constructor(private readonly db: D1Database) {}

  // ------------------------------------------------------------- trackers
  /** All trackers plus their markets, in 2 queries regardless of row count. */
  async listTrackers(): Promise<TrackerWithMarkets[]> {
    return guard("listTrackers", async () => {
      const batched = await this.db.batch<never>([
        this.db.prepare("SELECT * FROM trackers ORDER BY id"),
        this.db.prepare("SELECT tracker_id, market FROM tracker_markets ORDER BY tracker_id, priority"),
      ]);
      return this.attachMarkets(
        (batched[0]?.results ?? []) as unknown as TrackerRow[],
        (batched[1]?.results ?? []) as unknown as { tracker_id: number; market: string }[],
      );
    });
  }

  async getTracker(id: number): Promise<TrackerWithMarkets | null> {
    return guard("getTracker", async () => {
      const batched = await this.db.batch<never>([
        this.db.prepare("SELECT * FROM trackers WHERE id = ?").bind(id),
        this.db
          .prepare("SELECT tracker_id, market FROM tracker_markets WHERE tracker_id = ? ORDER BY priority")
          .bind(id),
      ]);
      const rows = (batched[0]?.results ?? []) as unknown as TrackerRow[];
      if (rows.length === 0) return null;
      return this.attachMarkets(
        rows,
        (batched[1]?.results ?? []) as unknown as { tracker_id: number; market: string }[],
      )[0]!;
    });
  }

  private attachMarkets(
    trackers: TrackerRow[],
    markets: { tracker_id: number; market: string }[],
  ): TrackerWithMarkets[] {
    const byTracker = new Map<number, string[]>();
    for (const row of markets) {
      const list = byTracker.get(row.tracker_id);
      if (list) list.push(row.market);
      else byTracker.set(row.tracker_id, [row.market]);
    }
    return trackers.map((t) => ({ ...t, markets: byTracker.get(t.id) ?? [] }));
  }

  /**
   * Trackers whose next run is due.
   *
   * `next_run_at IS NULL` counts as due so a freshly imported or newly created
   * tracker is picked up on the next tick instead of waiting forever. Rows
   * currently locked by a live lease are excluded here rather than filtered
   * later, so a manual check in progress is never double-run.
   */
  async selectDueTrackers(now: Date, limit: number): Promise<TrackerWithMarkets[]> {
    return guard("selectDueTrackers", async () => {
      const nowText = toIso(now);
      const due = await this.db
        .prepare(
          `SELECT * FROM trackers
             WHERE status = 'active'
               AND (next_run_at IS NULL OR next_run_at <= ?1)
               AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?1)
             ORDER BY (next_run_at IS NULL) DESC, next_run_at ASC
             LIMIT ?2`,
        )
        .bind(nowText, limit)
        .all<TrackerRow>();

      const rows = (due.results ?? []) as TrackerRow[];
      if (rows.length === 0) return [];

      const placeholders = rows.map(() => "?").join(",");
      const markets = await this.db
        .prepare(
          `SELECT tracker_id, market FROM tracker_markets
             WHERE tracker_id IN (${placeholders}) ORDER BY tracker_id, priority`,
        )
        .bind(...rows.map((r) => r.id))
        .all<{ tracker_id: number; market: string }>();

      return this.attachMarkets(rows, (markets.results ?? []) as { tracker_id: number; market: string }[]);
    });
  }

  /**
   * How much work is still waiting, for the "work remaining" status.
   *
   * `excludeIds` are the trackers this tick already handled. They are excluded
   * because whether they still look due depends on the runner having moved
   * `next_run_at` forward, which is a different component's responsibility --
   * counting them here would report "partial" for work that is in fact done.
   */
  async countDueTrackers(now: Date, excludeIds: number[] = []): Promise<number> {
    const nowText = toIso(now);
    if (excludeIds.length === 0) {
      const row = await this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM trackers
             WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?1)`,
        )
        .bind(nowText)
        .first<{ n: number }>();
      return row?.n ?? 0;
    }

    const placeholders = excludeIds.map(() => "?").join(",");
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM trackers
           WHERE status = 'active'
             AND (next_run_at IS NULL OR next_run_at <= ?1)
             AND id NOT IN (${placeholders})`,
      )
      .bind(nowText, ...excludeIds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Claim a tracker for checking.
   *
   * The WHERE clause is the whole mechanism: the UPDATE only matches when the
   * row is unlocked or the previous lease has expired, so two concurrent
   * invocations cannot both win. An expired lease is reclaimed rather than
   * respected, which is what stops a Worker that died mid-check from wedging
   * the tracker permanently.
   */
  async acquireTrackerLock(
    trackerId: number,
    owner: string,
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const expires = toIso(new Date(now.getTime() + ttlSeconds * 1000));
    const result = await guard("acquireTrackerLock", () =>
      this.db
        .prepare(
          `UPDATE trackers SET lock_owner = ?2, lock_expires_at = ?3
             WHERE id = ?1
               AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?4)`,
        )
        .bind(trackerId, owner, expires, toIso(now))
        .run(),
    );
    return (result.meta.changes ?? 0) > 0;
  }

  async releaseTrackerLock(trackerId: number, owner: string): Promise<void> {
    await guard("releaseTrackerLock", () =>
      this.db
        .prepare(
          "UPDATE trackers SET lock_owner = NULL, lock_expires_at = NULL WHERE id = ?1 AND lock_owner = ?2",
        )
        .bind(trackerId, owner)
        .run(),
    );
  }

  async updateTrackerFields(id: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
    await guard("updateTrackerFields", () =>
      this.db
        .prepare(`UPDATE trackers SET ${assignments}, updated_at = ?${keys.length + 2} WHERE id = ?1`)
        .bind(id, ...keys.map((k) => fields[k] as never), nowIso())
        .run(),
    );
  }

  async insertTracker(fields: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(fields);
    const columns = keys.join(", ");
    const placeholders = keys.map((_, i) => `?${i + 1}`).join(", ");
    const result = await guard("insertTracker", () =>
      this.db
        .prepare(`INSERT INTO trackers (${columns}) VALUES (${placeholders})`)
        .bind(...keys.map((k) => fields[k] as never))
        .run(),
    );
    return Number(result.meta.last_row_id);
  }

  async deleteTracker(id: number): Promise<void> {
    // Cascades handle markets, config versions, candidates, runs, observations
    // and alerts; foreign keys are enforced by D1 by default.
    await guard("deleteTracker", () =>
      this.db.prepare("DELETE FROM trackers WHERE id = ?").bind(id).run(),
    );
  }

  async setTrackerMarkets(trackerId: number, markets: string[]): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db.prepare("DELETE FROM tracker_markets WHERE tracker_id = ?").bind(trackerId),
    ];
    markets.forEach((market, index) => {
      statements.push(
        this.db
          .prepare("INSERT INTO tracker_markets (tracker_id, market, priority) VALUES (?, ?, ?)")
          .bind(trackerId, market, index),
      );
    });
    await guard("setTrackerMarkets", () => this.db.batch(statements));
  }

  // ------------------------------------------------------ config versions
  async getConfigVersion(id: number): Promise<TrackerConfigVersionRow | null> {
    return this.db
      .prepare("SELECT * FROM tracker_config_versions WHERE id = ?")
      .bind(id)
      .first<TrackerConfigVersionRow>();
  }

  async latestConfigVersion(trackerId: number): Promise<TrackerConfigVersionRow | null> {
    return this.db
      .prepare(
        "SELECT * FROM tracker_config_versions WHERE tracker_id = ? ORDER BY version DESC LIMIT 1",
      )
      .bind(trackerId)
      .first<TrackerConfigVersionRow>();
  }

  async insertConfigVersion(
    trackerId: number,
    version: number,
    fingerprint: string,
    payload: string,
    effectiveFrom: string,
  ): Promise<number> {
    const result = await guard("insertConfigVersion", () =>
      this.db
        .prepare(
          `INSERT INTO tracker_config_versions
             (tracker_id, version, fingerprint, payload, effective_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(trackerId, version, fingerprint, payload, effectiveFrom, effectiveFrom)
        .run(),
    );
    return Number(result.meta.last_row_id);
  }

  async closeConfigVersion(id: number, effectiveTo: string): Promise<void> {
    await this.db
      .prepare("UPDATE tracker_config_versions SET effective_to = ? WHERE id = ?")
      .bind(effectiveTo, id)
      .run();
  }

  // ----------------------------------------------------------- series state
  /**
   * What was already known about the series before a new observation.
   *
   * Restricted to eligible observations inside the current config version, so
   * a configuration change starts a clean comparison series instead of
   * comparing fares that no longer mean the same thing.
   */
  async seriesState(
    trackerId: number,
    configVersionId: number | null,
  ): Promise<{ seriesLowCents: number | null; count: number }> {
    const row = await this.db
      .prepare(
        `SELECT MIN(price_amount_cents) AS low, COUNT(*) AS n
           FROM fare_observations
          WHERE tracker_id = ?1
            AND eligible = 1
            AND (?2 IS NULL OR config_version_id = ?2)`,
      )
      .bind(trackerId, configVersionId)
      .first<{ low: number | null; n: number }>();
    return { seriesLowCents: row?.low ?? null, count: row?.n ?? 0 };
  }

  // ------------------------------------------------------------ search runs
  async insertSearchRun(fields: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(fields);
    const result = await guard("insertSearchRun", () =>
      this.db
        .prepare(
          `INSERT INTO search_runs (${keys.join(", ")})
           VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})`,
        )
        .bind(...keys.map((k) => fields[k] as never))
        .run(),
    );
    return Number(result.meta.last_row_id);
  }

  async updateSearchRun(id: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await this.db
      .prepare(
        `UPDATE search_runs SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`,
      )
      .bind(id, ...keys.map((k) => fields[k] as never))
      .run();
  }

  async recentRuns(trackerId: number, limit = 20): Promise<SearchRunRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM search_runs WHERE tracker_id = ? ORDER BY started_at DESC LIMIT ?")
      .bind(trackerId, limit)
      .all<SearchRunRow>();
    return (result.results ?? []) as SearchRunRow[];
  }

  async recentFailures(limit = 20): Promise<SearchRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM search_runs
          WHERE error_category <> 'none'
          ORDER BY started_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<SearchRunRow>();
    return (result.results ?? []) as SearchRunRow[];
  }

  // ----------------------------------------------------------- observations
  /** Insert observations as one atomic batch and return their ids. */
  async insertObservations(rows: Record<string, unknown>[]): Promise<number[]> {
    if (rows.length === 0) return [];
    const keys = Object.keys(rows[0]!);
    const statements = rows.map((row) =>
      this.db
        .prepare(
          `INSERT INTO fare_observations (${keys.join(", ")})
           VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})`,
        )
        .bind(...keys.map((k) => row[k] as never)),
    );
    const results = await guard("insertObservations", () => this.db.batch(statements));
    return results.map((r) => Number(r.meta.last_row_id));
  }

  async observationsForTracker(trackerId: number, limit = 200): Promise<FareObservationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM fare_observations
          WHERE tracker_id = ? AND eligible = 1
          ORDER BY observed_at DESC LIMIT ?`,
      )
      .bind(trackerId, limit)
      .all<FareObservationRow>();
    return (result.results ?? []) as FareObservationRow[];
  }

  async getObservation(id: number): Promise<FareObservationRow | null> {
    return this.db
      .prepare("SELECT * FROM fare_observations WHERE id = ?")
      .bind(id)
      .first<FareObservationRow>();
  }

  // ---------------------------------------------------------------- alerts
  async findAlertByDedupeKey(key: string): Promise<AlertEventRow | null> {
    return this.db
      .prepare("SELECT * FROM alert_events WHERE dedupe_key = ?")
      .bind(key)
      .first<AlertEventRow>();
  }

  /**
   * Insert an alert event, relying on the UNIQUE(dedupe_key) index rather than
   * a prior SELECT to decide uniqueness. Returns null when the key already
   * exists, which is the concurrent-duplicate case: a manual check and a Cron
   * tick finding the same fare must produce exactly one message.
   */
  async insertAlertEvent(fields: Record<string, unknown>): Promise<number | null> {
    const keys = Object.keys(fields);
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO alert_events (${keys.join(", ")})
           VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")})
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(...keys.map((k) => fields[k] as never))
        .run();
      return (result.meta.changes ?? 0) > 0 ? Number(result.meta.last_row_id) : null;
    } catch (error) {
      throw new D1Error("database operation failed: insertAlertEvent", error);
    }
  }

  async updateAlertEvent(id: number, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await this.db
      .prepare(
        `UPDATE alert_events SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`,
      )
      .bind(id, ...keys.map((k) => fields[k] as never))
      .run();
  }

  /** Most recent *delivered* alert of one type, for the cooldown window. */
  async lastDeliveredAlert(
    trackerId: number,
    alertType: string,
    excludeId: number,
  ): Promise<AlertEventRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM alert_events
          WHERE tracker_id = ?1 AND alert_type = ?2 AND delivery_state = 'sent' AND id <> ?3
          ORDER BY delivered_at DESC LIMIT 1`,
      )
      .bind(trackerId, alertType, excludeId)
      .first<AlertEventRow>();
  }

  async pendingAlerts(maxAttempts: number, limit = 20): Promise<AlertEventRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM alert_events
          WHERE delivery_state IN ('pending', 'failed') AND attempts < ?1
          ORDER BY created_at LIMIT ?2`,
      )
      .bind(maxAttempts, limit)
      .all<AlertEventRow>();
    return (result.results ?? []) as AlertEventRow[];
  }

  async recentAlerts(limit = 20): Promise<AlertEventRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM alert_events ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<AlertEventRow>();
    return (result.results ?? []) as AlertEventRow[];
  }

  // ----------------------------------------------------------------- quota
  async usageRow(period: string): Promise<ProviderUsageRow> {
    const existing = await this.db
      .prepare("SELECT * FROM provider_usage WHERE provider = 'serpapi' AND period = ?")
      .bind(period)
      .first<ProviderUsageRow>();
    if (existing) return existing;

    await this.db
      .prepare(
        `INSERT INTO provider_usage (provider, period, local_searches) VALUES ('serpapi', ?, 0)
         ON CONFLICT (provider, period) DO NOTHING`,
      )
      .bind(period)
      .run();
    const created = await this.db
      .prepare("SELECT * FROM provider_usage WHERE provider = 'serpapi' AND period = ?")
      .bind(period)
      .first<ProviderUsageRow>();
    if (!created) throw new D1Error("could not create the provider usage ledger row");
    return created;
  }

  async hourlyUsed(since: Date): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE provider = 'serpapi' AND called_at >= ?")
      .bind(toIso(since))
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Record billable calls.
   *
   * The ledger increment and the per-call rows go in one batch: a partially
   * applied write would let the hourly guard and the monthly ledger disagree,
   * and the monthly ledger is the one enforcing a hard cap on the owner's bill.
   */
  async recordProviderCalls(
    period: string,
    endpoint: string,
    runId: number | null,
    count: number,
  ): Promise<void> {
    if (count <= 0) return;
    const at = nowIso();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "UPDATE provider_usage SET local_searches = local_searches + ?2 WHERE provider = 'serpapi' AND period = ?1",
        )
        .bind(period, count),
    ];
    for (let i = 0; i < count; i += 1) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO provider_calls (provider, endpoint, called_at, search_run_id) VALUES ('serpapi', ?, ?, ?)",
          )
          .bind(endpoint, at, runId),
      );
    }
    await guard("recordProviderCalls", () => this.db.batch(statements));
  }

  async updateUsage(period: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await this.db
      .prepare(
        `UPDATE provider_usage SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")}
          WHERE provider = 'serpapi' AND period = ?1`,
      )
      .bind(period, ...keys.map((k) => fields[k] as never))
      .run();
  }

  /** Trim the throughput log; the monthly ledger stays authoritative. */
  async pruneProviderCalls(before: Date): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM provider_calls WHERE called_at < ?")
      .bind(toIso(before))
      .run();
    return result.meta.changes ?? 0;
  }

  // ----------------------------------------------------------------- cache
  async cacheGet(fingerprint: string, now: Date): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT payload FROM query_cache WHERE fingerprint = ?1 AND expires_at > ?2")
      .bind(fingerprint, toIso(now))
      .first<{ payload: string }>();
    return row?.payload ?? null;
  }

  async cachePut(
    fingerprint: string,
    endpoint: string,
    payload: string,
    expiresAt: Date,
    runId: number | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO query_cache (fingerprint, endpoint, payload, created_at, expires_at, source_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (fingerprint) DO UPDATE SET
           payload = excluded.payload,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           source_run_id = excluded.source_run_id`,
      )
      .bind(fingerprint, endpoint, payload, nowIso(), toIso(expiresAt), runId)
      .run();
  }

  async cachePrune(now: Date): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM query_cache WHERE expires_at <= ?")
      .bind(toIso(now))
      .run();
    return result.meta.changes ?? 0;
  }

  // -------------------------------------------------------------- settings
  async getSetting<T>(key: string): Promise<T | null> {
    const row = await this.db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind(key)
      .first<AppSettingRow>();
    if (!row || row.value === null) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), nowIso())
      .run();
  }

  // ------------------------------------------------------- scheduler lease
  async schedulerState(): Promise<SchedulerStateRow | null> {
    return this.db.prepare("SELECT * FROM scheduler_state WHERE id = 1").first<SchedulerStateRow>();
  }

  /**
   * Take the singleton Cron lease.
   *
   * Same conditional-UPDATE pattern as the tracker lock. Two Cron invocations
   * overlapping (a slow tick still running when the next fires) is expected on
   * a platform with at-least-once delivery, and the loser simply records that
   * it could not acquire the lease and exits.
   */
  async acquireSchedulerLease(
    owner: string,
    ttlSeconds: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await guard("acquireSchedulerLease", () =>
      this.db
        .prepare(
          `UPDATE scheduler_state
              SET lock_owner = ?1,
                  lock_expires_at = ?2,
                  started_at = COALESCE(started_at, ?3),
                  last_tick_at = ?3,
                  tick_count = tick_count + 1
            WHERE id = 1
              AND (lock_owner IS NULL OR lock_expires_at IS NULL OR lock_expires_at <= ?3)`,
        )
        .bind(owner, toIso(new Date(now.getTime() + ttlSeconds * 1000)), toIso(now))
        .run(),
    );
    return (result.meta.changes ?? 0) > 0;
  }

  async releaseSchedulerLease(owner: string, error: string | null = null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scheduler_state
            SET lock_owner = NULL, lock_expires_at = NULL, last_error = ?2
          WHERE id = 1 AND lock_owner = ?1`,
      )
      .bind(owner, error)
      .run();
  }

  async recordSweepState(state: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE scheduler_state SET last_sweep_state = ?1, last_sweep_at = ?2 WHERE id = 1")
      .bind(state, nowIso())
      .run();
  }

  // ------------------------------------------------------------- cron runs
  async startCronRun(cron: string | null): Promise<number> {
    const result = await this.db
      .prepare("INSERT INTO cron_runs (started_at, cron, outcome) VALUES (?, ?, 'running')")
      .bind(nowIso(), cron)
      .run();
    return Number(result.meta.last_row_id);
  }

  async finishCronRun(id: number, fields: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = { ...fields, completed_at: nowIso() };
    const keys = Object.keys(merged);
    await this.db
      .prepare(
        `UPDATE cron_runs SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`,
      )
      .bind(id, ...keys.map((k) => merged[k] as never))
      .run();
  }

  /**
   * Drop cron_runs older than `before`.
   *
   * At the 15-minute Cron cadence this table gains ~96 rows a day and is the
   * only one in the schema that grows without a tracker or an observation
   * behind it. Nothing reads a run older than the operator's memory of it, so
   * the history is bounded here rather than left to fill the database.
   */
  async pruneCronRuns(before: Date): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(toIso(before))
      .run();
    return result.meta.changes ?? 0;
  }

  async recentCronRuns(limit = 10): Promise<CronRunRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?")
      .bind(limit)
      .all<CronRunRow>();
    return (result.results ?? []) as CronRunRow[];
  }

  // --------------------------------------------------------- flexible dates
  /**
   * Retire pending candidates whose departure has already passed.
   *
   * Marked checked (with no price) rather than deleted, so the coverage count
   * still reflects the window the operator configured while the sweep stops
   * spending searches on flights that can no longer be boarded.
   */
  async skipPastCandidates(configVersionId: number, today: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE flexible_date_candidates
            SET status = 'checked', last_checked_at = ?3
          WHERE config_version_id = ?1 AND status = 'pending' AND outbound_date < ?2`,
      )
      .bind(configVersionId, today, nowIso())
      .run();
    return result.meta.changes ?? 0;
  }

  /** Cheapest-first view of a window's date pairs, checked ones first. */
  async candidatePrices(
    configVersionId: number,
    cycle: number,
    limit = 12,
  ): Promise<FlexibleDateCandidateRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM flexible_date_candidates
          WHERE config_version_id = ?1 AND cycle = ?2 AND last_price_cents IS NOT NULL
          ORDER BY last_price_cents ASC, outbound_date ASC
          LIMIT ?3`,
      )
      .bind(configVersionId, cycle, limit)
      .all<FlexibleDateCandidateRow>();
    return (result.results ?? []) as FlexibleDateCandidateRow[];
  }

  async claimCandidates(
    configVersionId: number,
    cycle: number,
    limit: number,
  ): Promise<FlexibleDateCandidateRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM flexible_date_candidates
          WHERE config_version_id = ?1 AND cycle = ?2 AND status = 'pending'
          ORDER BY order_index LIMIT ?3`,
      )
      .bind(configVersionId, cycle, limit)
      .all<FlexibleDateCandidateRow>();
    return (result.results ?? []) as FlexibleDateCandidateRow[];
  }

  async candidateCoverage(
    configVersionId: number,
    cycle: number,
  ): Promise<{ checked: number; total: number }> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status <> 'pending' THEN 1 ELSE 0 END) AS checked
           FROM flexible_date_candidates WHERE config_version_id = ?1 AND cycle = ?2`,
      )
      .bind(configVersionId, cycle)
      .first<{ total: number; checked: number | null }>();
    return { checked: row?.checked ?? 0, total: row?.total ?? 0 };
  }

  /**
   * Rebuild a tracker's date-pair queue.
   *
   * Deletes by `tracker_id`, not by `config_version_id`: editing a
   * comparison-relevant field mints a *new* config version, so scoping the
   * delete to the incoming version would leave the superseded queue behind.
   * Those rows can never be swept again -- the scheduler only claims
   * candidates for the tracker's current version -- so they would accumulate
   * silently and inflate every coverage count.
   */
  async replaceCandidates(
    trackerId: number,
    configVersionId: number,
    candidates: { outbound: string; ret: string; nights: number }[],
  ): Promise<void> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare("DELETE FROM flexible_date_candidates WHERE tracker_id = ?")
        .bind(trackerId),
    ];
    candidates.forEach((candidate, index) => {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO flexible_date_candidates
               (tracker_id, config_version_id, outbound_date, return_date, nights, order_index, cycle, status)
             VALUES (?, ?, ?, ?, ?, ?, 1, 'pending')`,
          )
          .bind(trackerId, configVersionId, candidate.outbound, candidate.ret, candidate.nights, index),
      );
    });
    await guard("replaceCandidates", () => this.db.batch(statements));
  }

  async markCandidateChecked(
    id: number,
    status: string,
    runId: number | null,
    priceCents: number | null,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE flexible_date_candidates
            SET status = ?2, last_checked_at = ?3, last_run_id = ?4,
                check_count = check_count + 1, last_price_cents = ?5
          WHERE id = ?1`,
      )
      .bind(id, status, nowIso(), runId, priceCents)
      .run();
  }

  /** Start a new sweep cycle once every candidate has been visited. */
  async startNextCycle(configVersionId: number, cycle: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE flexible_date_candidates SET status = 'pending', cycle = ?2
          WHERE config_version_id = ?1`,
      )
      .bind(configVersionId, cycle)
      .run();
  }

  /** Per-tracker min/max/count of best-of-run fares since `sinceIso`. */
  async weeklyObservationStats(
    sinceIso: string,
  ): Promise<Map<number, { loCents: number; hiCents: number; count: number }>> {
    const result = await this.db
      .prepare(
        `SELECT tracker_id, MIN(price_amount_cents) AS lo, MAX(price_amount_cents) AS hi,
                COUNT(*) AS n
           FROM fare_observations
          WHERE is_best_of_run = 1 AND eligible = 1 AND observed_at >= ?1
          GROUP BY tracker_id`,
      )
      .bind(sinceIso)
      .all<{ tracker_id: number; lo: number; hi: number; n: number }>();
    const map = new Map<number, { loCents: number; hiCents: number; count: number }>();
    for (const row of (result.results ?? []) as { tracker_id: number; lo: number; hi: number; n: number }[]) {
      map.set(row.tracker_id, { loCents: row.lo, hiCents: row.hi, count: row.n });
    }
    return map;
  }

  /** Recent best-of-run prices per tracker, one query for the whole list. */
  async sparklineSeries(limit = 240): Promise<Map<number, { at: string; cents: number }[]>> {
    const result = await this.db
      .prepare(
        `SELECT tracker_id, observed_at, price_amount_cents FROM fare_observations
          WHERE is_best_of_run = 1 AND eligible = 1
          ORDER BY observed_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<{ tracker_id: number; observed_at: string; price_amount_cents: number }>();

    const byTracker = new Map<number, { at: string; cents: number }[]>();
    for (const row of (result.results ?? []) as {
      tracker_id: number;
      observed_at: string;
      price_amount_cents: number;
    }[]) {
      const list = byTracker.get(row.tracker_id) ?? [];
      list.push({ at: row.observed_at, cents: row.price_amount_cents });
      byTracker.set(row.tracker_id, list);
    }
    // Fetched newest-first for the LIMIT; each series renders oldest-first.
    for (const list of byTracker.values()) list.reverse();
    return byTracker;
  }

  // ---------------------------------------------------------- auth throttle
  async getThrottle(key: string): Promise<AuthThrottleRow | null> {
    return this.db.prepare("SELECT * FROM auth_throttle WHERE key = ?").bind(key).first<AuthThrottleRow>();
  }

  async recordAuthFailure(key: string, lockedUntil: string | null): Promise<void> {
    const at = nowIso();
    await this.db
      .prepare(
        `INSERT INTO auth_throttle (key, fail_count, first_failed_at, last_failed_at, locked_until)
         VALUES (?1, 1, ?2, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET
           fail_count = auth_throttle.fail_count + 1,
           last_failed_at = ?2,
           locked_until = ?3`,
      )
      .bind(key, at, lockedUntil)
      .run();
  }

  async clearAuthFailures(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM auth_throttle WHERE key = ?").bind(key).run();
  }

  // ----------------------------------------------------------------- health
  /** One cheap query proving the binding works and migrations were applied. */
  async health(): Promise<{ ok: boolean; schemaVersion: string | null; detail: string }> {
    try {
      const row = await this.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .first<{ value: string }>();
      if (!row) {
        return {
          ok: false,
          schemaVersion: null,
          detail: "Connected, but schema_meta is empty. Run the D1 migrations.",
        };
      }
      return { ok: true, schemaVersion: row.value, detail: "Connected." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        schemaVersion: null,
        detail: /no such table/i.test(message)
          ? "Connected, but the tables are missing. Run `wrangler d1 migrations apply flightnotify --remote`."
          : "Could not query D1.",
      };
    }
  }

  static fromBool = fromBool;
}
