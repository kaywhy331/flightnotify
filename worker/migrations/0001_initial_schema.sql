-- FlightNotify D1 schema, ported from the SQLAlchemy models in
-- flightnotify/models.py (see docs/CLOUDFLARE.md for the mapping rationale).
--
-- Two deliberate representation changes from the Python/SQLite original:
--
--   money      Numeric(12,2) -> INTEGER minor units (cents), and Numeric(5,2)
--              percentages -> INTEGER hundredths of a percent ("bp"). SQLite's
--              NUMERIC affinity round-trips through a C double; integer minor
--              units cannot drift, and JS has no decimal type to round-trip
--              into. Column names carry the unit (_cents / _bp) so a caller
--              cannot silently mistake the scale.
--
--   timestamps TEXT, ISO-8601 UTC, always exactly millisecond precision:
--              YYYY-MM-DDTHH:MM:SS.sssZ. Uniform width is load-bearing -- it
--              makes lexicographic comparison equal chronological comparison,
--              so plain TEXT indexes serve the due-work and history queries.
--              Mixing 3- and 6-digit fractions would silently invert ordering.
--
-- Booleans are INTEGER 0/1. JSON payloads are TEXT.

-- Explicit schema version, independent of wrangler's own d1_migrations table.
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');

-- ---------------------------------------------------------------- trackers
CREATE TABLE trackers (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'active',

  origin                 TEXT    NOT NULL,
  destination            TEXT    NOT NULL,
  adults                 INTEGER NOT NULL DEFAULT 1,
  children               INTEGER NOT NULL DEFAULT 0,
  infants_in_seat        INTEGER NOT NULL DEFAULT 0,
  infants_on_lap         INTEGER NOT NULL DEFAULT 0,
  cabin                  TEXT    NOT NULL DEFAULT 'economy',
  stops                  TEXT    NOT NULL DEFAULT 'any',
  include_airlines       TEXT,
  exclude_airlines       TEXT,

  date_mode              TEXT    NOT NULL DEFAULT 'exact',
  outbound_date          TEXT,
  return_date            TEXT,
  flex_month             INTEGER,
  flex_year              INTEGER,
  flex_duration          TEXT,
  window_outbound_start  TEXT,
  window_outbound_end    TEXT,
  window_return_start    TEXT,
  window_return_end      TEXT,
  min_nights             INTEGER,
  max_nights             INTEGER,

  currency               TEXT    NOT NULL DEFAULT 'USD',
  threshold_amount_cents INTEGER NOT NULL,
  threshold_basis        TEXT    NOT NULL DEFAULT 'party',

  alert_on_threshold     INTEGER NOT NULL DEFAULT 1,
  alert_on_new_low       INTEGER NOT NULL DEFAULT 1,
  min_drop_absolute_cents INTEGER,
  min_drop_percent_bp    INTEGER,
  cooldown_minutes       INTEGER NOT NULL DEFAULT 360,

  check_interval_minutes INTEGER NOT NULL DEFAULT 720,
  candidates_per_run     INTEGER NOT NULL DEFAULT 1,
  sampled_mode_ack       INTEGER NOT NULL DEFAULT 0,
  next_run_at            TEXT,
  last_attempt_at        TEXT,
  last_success_at        TEXT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,

  -- Per-tracker execution lock. Prevents a manual check and a Cron tick from
  -- searching the same tracker at once.
  lock_owner             TEXT,
  lock_expires_at        TEXT,

  -- Plain column, not a FK: trackers and tracker_config_versions would
  -- otherwise form a mutually dependent FK cycle (same reasoning as the
  -- Python model). Maintained by ensureConfigVersion().
  current_config_version_id INTEGER,
  series_started_at      TEXT,

  latest_price_cents     INTEGER,
  latest_observation_id  INTEGER,
  latest_observed_at     TEXT,
  low_price_cents        INTEGER,
  low_observation_id     INTEGER,
  low_observed_at        TEXT,
  last_threshold_met     INTEGER NOT NULL DEFAULT 0,

  coverage_cycle         INTEGER NOT NULL DEFAULT 1,
  last_error_category    TEXT,
  last_error_message     TEXT,

  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,

  CONSTRAINT ck_trackers_adults_min          CHECK (adults >= 1),
  CONSTRAINT ck_trackers_children_min        CHECK (children >= 0),
  CONSTRAINT ck_trackers_interval_min        CHECK (check_interval_minutes >= 15),
  CONSTRAINT ck_trackers_threshold_positive  CHECK (threshold_amount_cents > 0)
);

-- The due-work query: status = 'active' AND next_run_at <= now.
CREATE INDEX ix_trackers_status_next_run ON trackers (status, next_run_at);
CREATE INDEX ix_trackers_config_version  ON trackers (current_config_version_id);

-- --------------------------------------------------------- tracker_markets
CREATE TABLE tracker_markets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  market     TEXT    NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_tracker_market UNIQUE (tracker_id, market)
);
CREATE INDEX ix_tracker_markets_tracker ON tracker_markets (tracker_id, priority);

-- -------------------------------------------------- tracker_config_versions
-- Immutable snapshot of every comparison-relevant setting. Observations are
-- never compared across an incompatible configuration change.
CREATE TABLE tracker_config_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id     INTEGER NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  fingerprint    TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  effective_from TEXT    NOT NULL,
  effective_to   TEXT,
  created_at     TEXT    NOT NULL,
  CONSTRAINT uq_config_version_number UNIQUE (tracker_id, version)
);
CREATE INDEX ix_config_versions_tracker_fp ON tracker_config_versions (tracker_id, fingerprint);

-- ------------------------------------------------- flexible_date_candidates
CREATE TABLE flexible_date_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id        INTEGER NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  config_version_id INTEGER NOT NULL REFERENCES tracker_config_versions (id) ON DELETE CASCADE,
  outbound_date     TEXT    NOT NULL,
  return_date       TEXT    NOT NULL,
  nights            INTEGER NOT NULL,
  order_index       INTEGER NOT NULL,

  cycle             INTEGER NOT NULL DEFAULT 1,
  status            TEXT    NOT NULL DEFAULT 'pending',
  last_checked_at   TEXT,
  last_run_id       INTEGER,
  check_count       INTEGER NOT NULL DEFAULT 0,
  last_price_cents  INTEGER,
  CONSTRAINT uq_candidate_pair UNIQUE (config_version_id, outbound_date, return_date)
);
-- Backs "claim the next N pending candidates for this cycle", which is how a
-- flexible sweep resumes across Cron invocations.
CREATE INDEX ix_candidates_queue
  ON flexible_date_candidates (config_version_id, cycle, status, order_index);

-- ------------------------------------------------------------- search_runs
-- One provider query attempt, stored even when it failed, was served from
-- cache, or was refused by the quota guard.
CREATE TABLE search_runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id             INTEGER NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  config_version_id      INTEGER REFERENCES tracker_config_versions (id) ON DELETE SET NULL,
  batch_id               TEXT    NOT NULL,
  trigger                TEXT    NOT NULL DEFAULT 'scheduled',
  endpoint               TEXT    NOT NULL DEFAULT 'google_flights',
  market                 TEXT    NOT NULL,
  currency               TEXT    NOT NULL,
  outbound_date          TEXT,
  return_date            TEXT,
  query_fingerprint      TEXT    NOT NULL,

  started_at             TEXT    NOT NULL,
  completed_at           TEXT,
  status                 TEXT    NOT NULL DEFAULT 'success',
  provider_request_count INTEGER NOT NULL DEFAULT 0,
  cache_status           TEXT    NOT NULL DEFAULT 'miss',

  coverage_cycle         INTEGER,
  coverage_state         TEXT    NOT NULL DEFAULT 'not_applicable',
  coverage_checked       INTEGER,
  coverage_total         INTEGER,

  offers_found           INTEGER NOT NULL DEFAULT 0,
  best_observation_id    INTEGER,
  error_category         TEXT    NOT NULL DEFAULT 'none',
  error_message          TEXT,
  skip_reason            TEXT,
  raw_excerpt            TEXT
);
CREATE INDEX ix_runs_tracker_started ON search_runs (tracker_id, started_at);
CREATE INDEX ix_runs_batch           ON search_runs (batch_id);
CREATE INDEX ix_runs_fingerprint     ON search_runs (query_fingerprint);

-- -------------------------------------------------------- fare_observations
CREATE TABLE fare_observations (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  search_run_id             INTEGER NOT NULL REFERENCES search_runs (id) ON DELETE CASCADE,
  tracker_id                INTEGER NOT NULL REFERENCES trackers (id) ON DELETE CASCADE,
  config_version_id         INTEGER REFERENCES tracker_config_versions (id) ON DELETE SET NULL,

  itinerary_fingerprint     TEXT    NOT NULL,
  price_amount_cents        INTEGER NOT NULL,
  currency                  TEXT    NOT NULL,
  -- 'party_total' | 'per_traveler' | 'unknown'. Stored per observation so a
  -- later config change cannot retroactively reinterpret stored history.
  price_scope               TEXT    NOT NULL DEFAULT 'party_total',
  per_traveler_amount_cents INTEGER,
  per_traveler_is_calculated INTEGER NOT NULL DEFAULT 0,
  party_total_amount_cents  INTEGER,
  party_total_is_calculated INTEGER NOT NULL DEFAULT 0,

  origin                    TEXT,
  destination               TEXT,
  outbound_date             TEXT,
  return_date               TEXT,
  departure_time            TEXT,
  arrival_time              TEXT,
  airlines                  TEXT,
  flight_numbers            TEXT,
  stops                     INTEGER,
  duration_minutes          INTEGER,
  cabin                     TEXT,
  segments                  TEXT,
  layovers                  TEXT,
  booking_link              TEXT,
  search_link               TEXT,
  market                    TEXT    NOT NULL,

  observed_at               TEXT    NOT NULL,
  eligible                  INTEGER NOT NULL DEFAULT 1,
  exclusion_reason          TEXT,
  is_best_of_run            INTEGER NOT NULL DEFAULT 0
);
-- Series-low lookup: cheapest eligible fare within one config version.
CREATE INDEX ix_obs_tracker_series_price
  ON fare_observations (tracker_id, config_version_id, price_amount_cents);
CREATE INDEX ix_obs_tracker_observed ON fare_observations (tracker_id, observed_at);
CREATE INDEX ix_obs_run              ON fare_observations (search_run_id);

-- ------------------------------------------------------------ alert_events
CREATE TABLE alert_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id          INTEGER REFERENCES trackers (id) ON DELETE CASCADE,
  config_version_id   INTEGER REFERENCES tracker_config_versions (id) ON DELETE SET NULL,
  observation_id      INTEGER REFERENCES fare_observations (id) ON DELETE SET NULL,
  alert_type          TEXT    NOT NULL,
  -- The deduplication contract: a repeat of the same finding maps to the same
  -- key, and the UNIQUE index is what actually enforces "send it once", even
  -- if a manual check and a Cron tick race.
  dedupe_key          TEXT    NOT NULL,
  message_text        TEXT    NOT NULL,
  delivery_state      TEXT    NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  telegram_message_id INTEGER,
  response_meta       TEXT,
  created_at          TEXT    NOT NULL,
  delivered_at        TEXT,
  CONSTRAINT uq_alert_dedupe_key UNIQUE (dedupe_key)
);
CREATE INDEX ix_alerts_tracker_created ON alert_events (tracker_id, created_at);
-- Backs the cooldown lookup (most recent delivered alert of one type) and the
-- pending-retry sweep.
CREATE INDEX ix_alerts_cooldown  ON alert_events (tracker_id, alert_type, delivery_state, delivered_at);
CREATE INDEX ix_alerts_retry     ON alert_events (delivery_state, attempts, created_at);

-- ---------------------------------------------------------- provider_usage
-- Conservative monthly ledger of billable provider searches.
CREATE TABLE provider_usage (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider                     TEXT    NOT NULL DEFAULT 'serpapi',
  period                       TEXT    NOT NULL,  -- YYYY-MM (UTC)
  local_searches               INTEGER NOT NULL DEFAULT 0,
  provider_searches_per_month  INTEGER,
  provider_searches_left       INTEGER,
  provider_this_month_usage    INTEGER,
  provider_plan_name           TEXT,
  provider_account_email_masked TEXT,
  provider_rate_limit_per_hour INTEGER,
  last_synced_at               TEXT,
  last_sync_error              TEXT,
  CONSTRAINT uq_provider_period UNIQUE (provider, period)
);

-- ----------------------------------------------------------- provider_calls
-- One billable call; backs the rolling hourly throughput guard.
CREATE TABLE provider_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT    NOT NULL DEFAULT 'serpapi',
  endpoint      TEXT    NOT NULL,
  called_at     TEXT    NOT NULL,
  search_run_id INTEGER
);
CREATE INDEX ix_provider_calls_time ON provider_calls (provider, called_at);

-- -------------------------------------------------------------- query_cache
CREATE TABLE query_cache (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint   TEXT    NOT NULL,
  endpoint      TEXT    NOT NULL,
  payload       TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  source_run_id INTEGER,
  CONSTRAINT uq_query_cache_fingerprint UNIQUE (fingerprint)
);
CREATE INDEX ix_query_cache_expiry ON query_cache (expires_at);

-- ------------------------------------------------------------- app_settings
-- Non-secret application configuration only. Never stores API tokens.
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- ----------------------------------------------------------- scheduler_state
-- Singleton row (id = 1) holding the Cron lease. Replaces the in-process
-- thread lease: a Worker invocation acquires it, and an expired lease is
-- reclaimable so a Worker killed mid-tick cannot wedge scheduling forever.
CREATE TABLE scheduler_state (
  id                   INTEGER PRIMARY KEY,
  lock_owner           TEXT,
  lock_expires_at      TEXT,
  started_at           TEXT,
  last_tick_at         TEXT,
  tick_count           INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_sweep_state     TEXT,
  last_sweep_at        TEXT
);
INSERT INTO scheduler_state (id, tick_count) VALUES (1, 0);

-- ---------------------------------------------------------------- cron_runs
-- Operational history of scheduled invocations, so the UI can distinguish
-- "the platform did not invoke us" from "we ran and the provider failed".
CREATE TABLE cron_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at          TEXT    NOT NULL,
  completed_at        TEXT,
  cron                TEXT,
  outcome             TEXT    NOT NULL DEFAULT 'running',
  lease_acquired      INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  trackers_selected   INTEGER NOT NULL DEFAULT 0,
  trackers_completed  INTEGER NOT NULL DEFAULT 0,
  queries_executed    INTEGER NOT NULL DEFAULT 0,
  provider_failures   INTEGER NOT NULL DEFAULT 0,
  telegram_failures   INTEGER NOT NULL DEFAULT 0,
  alerts_sent         INTEGER NOT NULL DEFAULT 0,
  work_remaining      INTEGER NOT NULL DEFAULT 0,
  detail              TEXT
);
CREATE INDEX ix_cron_runs_started ON cron_runs (started_at);

-- ------------------------------------------------------------ auth_throttle
-- Login throttling state. Keyed by a salted hash of the client address so the
-- raw IP is never stored.
CREATE TABLE auth_throttle (
  key             TEXT PRIMARY KEY,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,
  last_failed_at  TEXT,
  locked_until    TEXT
);
