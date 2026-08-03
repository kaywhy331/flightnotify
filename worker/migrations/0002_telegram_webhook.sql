-- Telegram webhook delivery state.
--
-- Telegram retries any update whose webhook response is not 2xx. Persisting
-- the command result before calling sendMessage means a retry can resend the
-- same reply without running /check (and spending provider quota) twice.

CREATE TABLE telegram_updates (
  update_id         INTEGER PRIMARY KEY,
  state             TEXT    NOT NULL
                     CHECK (state IN ('processing', 'ready', 'delivered', 'ignored', 'failed')),
  chat_id           TEXT,
  command           TEXT,
  reply_text        TEXT,
  received_at       TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

CREATE INDEX ix_telegram_updates_updated ON telegram_updates (updated_at);

UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
