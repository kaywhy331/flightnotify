-- Search correctness and quota-reservation invariants.
--
-- A flexible date pair is searched once per configured market.  The original
-- schema stored only one mutable status on the date pair, so the last market
-- could overwrite an earlier market's success.  Market work now has its own
-- row and the parent candidate is only a derived aggregate.

CREATE TABLE flexible_candidate_markets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id      INTEGER NOT NULL REFERENCES flexible_date_candidates (id) ON DELETE CASCADE,
  market            TEXT    NOT NULL,
  cycle             INTEGER NOT NULL DEFAULT 1 CHECK (cycle >= 1),
  status            TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'checked', 'failed')),
  last_checked_at   TEXT,
  last_run_id       INTEGER,
  check_count       INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  last_price_cents  INTEGER CHECK (last_price_cents IS NULL OR last_price_cents >= 0),
  CONSTRAINT uq_candidate_market UNIQUE (candidate_id, market)
);

CREATE INDEX ix_candidate_markets_queue
  ON flexible_candidate_markets (candidate_id, cycle, status, market);

-- Preserve the terminal state of existing queues.  Future planning also uses
-- INSERT OR IGNORE, which fills a missing default-market row safely.
INSERT OR IGNORE INTO flexible_candidate_markets
  (candidate_id, market, cycle, status, last_checked_at, last_run_id,
   check_count, last_price_cents)
SELECT c.id, m.market, c.cycle, c.status, c.last_checked_at, c.last_run_id,
       c.check_count, c.last_price_cents
  FROM flexible_date_candidates AS c
  JOIN tracker_markets AS m ON m.tracker_id = c.tracker_id;

-- Atomic quota reservations use a fixed UTC hour bucket.  A reservation is
-- made before a provider request; unused retry capacity is released after the
-- adapter reports its exact attempt count.  A killed invocation can therefore
-- only under-spend (leave a conservative reservation), never overspend.
CREATE TABLE provider_quota_hours (
  provider   TEXT    NOT NULL DEFAULT 'serpapi',
  hour       TEXT    NOT NULL, -- YYYY-MM-DDTHH (UTC)
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (provider, hour)
);

-- Alert delivery is a small distributed job queue.  A Cron retry and a manual
-- check can overlap, so selecting a pending row and marking it in flight must
-- be one atomic statement.  Transport failures are intentionally terminal:
-- Telegram may have accepted the message before the response was lost, and an
-- automatic retry would turn an outage into a duplicate price alert.
ALTER TABLE alert_events ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0
  CHECK (retryable IN (0, 1));
ALTER TABLE alert_events ADD COLUMN next_attempt_at TEXT;
ALTER TABLE alert_events ADD COLUMN claim_owner TEXT;
ALTER TABLE alert_events ADD COLUMN claim_expires_at TEXT;

DROP INDEX ix_alerts_retry;
CREATE INDEX ix_alerts_retry
  ON alert_events (delivery_state, retryable, next_attempt_at, attempts, created_at);

-- Housekeeping is intentionally daily rather than on every 15-minute tick.
ALTER TABLE scheduler_state ADD COLUMN last_cleanup_at TEXT;

UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
