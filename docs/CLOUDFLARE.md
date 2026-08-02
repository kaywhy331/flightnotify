# FlightNotify on Cloudflare

FlightNotify runs as a single Cloudflare Worker: HTTP handling, a D1 database
for persistence, and a Cron Trigger for scheduled price checks. There is no
always-on server, no SSH session and no local filesystem.

Everything here fits the **Workers Free plan**. No paid Cloudflare service is
used or required.

---

## 1. Why TypeScript and not Python Workers

Cloudflare does offer Python Workers, and the existing app is Python — so the
choice was made on evidence rather than preference:

| Finding | Source |
| --- | --- |
| D1 is binding-only (`prepare`/`bind`/`run`/`all`/`batch`). There is no DBAPI driver and no SQLAlchemy dialect, so **SQLAlchemy and Alembic must be discarded in either language**. | [Query D1 from Python Workers](https://developers.cloudflare.com/d1/examples/query-d1-from-python-workers/), [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/) |
| Python Workers are in **open beta** and require the `python_workers` compatibility flag. | [Python Workers](https://developers.cloudflare.com/workers/languages/python/) |
| `threading` is importable but non-functional, so the in-process scheduler had to be replaced regardless. | [Python stdlib support](https://developers.cloudflare.com/workers/languages/python/stdlib/) |
| SQLAlchemy, Alembic, pydantic-settings and Jinja2 are **not** listed as supported packages. | [Python packages](https://developers.cloudflare.com/workers/languages/python/packages/) |
| Free plan allows **10 ms CPU per invocation**; Python is interpreted by Pyodide inside V8, adding interpreter overhead against that budget. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Free plan script size is **3 MB gzipped**; FastAPI + pydantic wheels make that a real risk. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |

Since the persistence, migration, scheduling and configuration layers had to be
rewritten either way, the only thing Python Workers would have preserved is the
FastAPI HTTP layer — not worth a beta runtime and an interpreter tax against a
10 ms budget.

**The Python implementation is retained in this repository**, both as the
rollback target and as the behavioural reference the Worker is tested against
(see [Golden vectors](#8-golden-vectors)).

---

## 2. What changed, and what did not

Preserved, and verified by tests:

- tracker create / edit / duplicate / pause / resume / delete
- exact and flexible round-trip searches
- passenger, cabin, stop, airline, market, currency and threshold settings
- SerpApi Google Flights integration and `SERPAPI_PRICE_SCOPE=party_total`
- provider quota accounting, including the reserve held back for manual checks
- observation history and observed lows, scoped to a comparison series
- threshold and new-low Telegram alerts, cooldown and deduplication
- Telegram chat discovery, integration status and test message
- loading, empty, stale, error and recovery states
- the existing stylesheet, markup structure and accessibility affordances

Changed, and why:

| Area | Before | Now | Why |
| --- | --- | --- | --- |
| Scheduler | in-process thread, 60 s poll | Cron Trigger + `scheduled()` handler | Workers have no background threads. Due status is derived from `trackers.next_run_at`, so the Cron interval only bounds *latency*, never which trackers are due. |
| Work per run | whole sweep in one pass | bounded per invocation, progress persisted | Free plan: 10 ms CPU, 50 subrequests, 50 D1 queries per invocation. |
| Money | `Numeric(12,2)` / `Decimal` | INTEGER minor units (`_cents`, `_bp`) | JavaScript has no decimal type; integer minor units cannot drift. |
| Timestamps | naive-UTC TEXT, microseconds | `YYYY-MM-DDTHH:MM:SS.sssZ` | Uniform width makes lexicographic order equal chronological order, so plain TEXT indexes serve the due-work queries. **Microseconds are truncated to milliseconds**; no behaviour depends on sub-millisecond precision. |
| Sessions | Starlette cookie (flash/CSRF only) | HMAC-signed stateless cookie | A D1 session table would cost a query per request against a 50-query budget. |
| **Authentication** | **none** — bound to `127.0.0.1` | password + session + CSRF + throttling | The old security boundary was the loopback interface. A public HTTPS URL has none, so this is genuinely new, not ported. |
| Secrets | `.env` file, `data/secret_key` | Cloudflare secrets | No filesystem. |

---

## 3. One-time setup

```bash
cd worker
npm install
npx wrangler login          # opens a browser; only you can do this
npx wrangler whoami         # confirm the right account
```

Create the database and paste the returned id into `wrangler.jsonc`, replacing
`PLACEHOLDER_D1_DATABASE_ID`:

```bash
npx wrangler d1 create flightnotify
```

Apply the schema:

```bash
npx wrangler d1 migrations apply flightnotify --local    # local dev copy
npx wrangler d1 migrations apply flightnotify --remote   # the real database
```

### Secrets

```bash
node scripts/hash-password.mjs          # prints a PBKDF2 hash; the password is never stored
npx wrangler secret put AUTH_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET   # >= 32 random characters
npx wrangler secret put SERPAPI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Generate a session secret with:

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Non-secret settings live in `wrangler.jsonc` under `vars`: `APP_TIMEZONE`,
`DEFAULT_CURRENCY`, `DEFAULT_MARKET`, `SERPAPI_PRICE_SCOPE`,
`MONTHLY_SEARCH_BUDGET`, `SEARCH_BUDGET_RESERVE_PERCENT`, `SCHEDULER_ENABLED`
and the per-tick bounds.

> `SEARCH_BUDGET_RESERVE_PERCENT=4` of a 250 budget is 10 searches, matching
> the previous absolute `SERPAPI_RESERVE_SEARCHES=10`.

---

## 4. Local development

```bash
make worker-dev     # http://localhost:8788, local D1, no Cloudflare account needed
```

Local secrets go in `worker/.dev.vars` (gitignored). Trigger the Cron handler
without waiting for the schedule:

```bash
curl "http://localhost:8788/__scheduled?cron=7,22,37,52+*+*+*+*"
```

> **Gotcha:** a key defined in `wrangler.jsonc` `vars` takes precedence over
> `.dev.vars`. To enable scheduling locally use
> `npx wrangler dev --local --var SCHEDULER_ENABLED:true`, not `.dev.vars`.

---

## 5. Data migration from SQLite

The exporter reads the production SQLite database **read-only** and never
mutates or deletes it.

```bash
# 1. Back up first (consistent, WAL-safe).
flightnotify backup --output "backups/flightnotify-preD1-$(date +%Y%m%dT%H%M%S).db"

# 2. Dry run. Prints a redacted summary and writes nothing.
flightnotify export-d1 --source data/flightnotify.db

# 3. Emit the SQL.
flightnotify export-d1 --source data/flightnotify.db --write --output /tmp/d1-import.sql

# 4. Import into the remote database.
cd worker
npx wrangler d1 execute flightnotify --remote --file=/tmp/d1-import.sql

# 5. Verify counts against the source.
flightnotify export-d1 --source data/flightnotify.db --verify \
  --expect-json /tmp/d1-import.sql.counts.json
```

The command refuses an ambiguous source: paths under `/tmp`, or containing
`stub`, `test`, `fixture` or `step8`, need `--allow-unsafe-source`.

**Never migrated:**

| Excluded | Reason |
| --- | --- |
| `scheduler_state` | Stale single-process lease; the Worker mints its own. |
| `query_cache` | Ephemeral provider cache, already TTL-expired. |
| `app_settings` row `telegram_chat_id` | Becomes a Cloudflare secret; two sources of truth would drift. |
| `--exclude-tracker <id>` | Opt-in removal of a tracker and everything referencing it. |

Secrets, session signing material, filesystem paths and process ids are not in
the source schema at all and cannot be exported.

---

## 6. Cutover

Run in this order. Steps 8 and 9 are the only irreversible-feeling ones, and
they exist to guarantee **exactly one scheduler is ever live**.

1. **Deploy with scheduling off.** `SCHEDULER_ENABLED` is `"false"` in
   `wrangler.jsonc`. `npx wrangler deploy`. The Cron Trigger is registered but
   the handler performs no live work and records `outcome=disabled`.
2. **Apply D1 migrations.** `npx wrangler d1 migrations apply flightnotify --remote`
3. **Import and verify data** (section 5).
4. **Configure secrets** (section 3).
5. **Verify authentication and read-only UI.** Sign in at the workers.dev URL.
   Confirm the imported tracker, its history and its observed low.
6. **Verify Telegram.** Settings → *Send test message*. Exactly one message.
7. **Verify SerpApi only if necessary**, with at most one live search
   (tracker → *Check now*).
8. **Stop the old scheduler.**
   ```bash
   pkill -f "flightnotify.cli serve"        # or: systemctl stop flightnotify
   ```
   Confirm nothing remains: `ps -ef | grep flightnotify`
9. **Enable the Cloudflare Cron.** Set `"SCHEDULER_ENABLED": "true"` in
   `wrangler.jsonc`, then `npx wrangler deploy`.
10. **Confirm one scheduled run.** Wait for the next Cron minute
    (`7,22,37,52`), then check the dashboard's *Last Cron run*, or:
    ```bash
    npx wrangler tail --format pretty
    ```
    Confirm no duplicate Telegram notification arrived.
11. **Keep the backup.** Retain `backups/flightnotify-preD1-*.db` until you are
    satisfied. Nothing in this process deletes it.

> Never run step 9 before step 8. Two active schedulers would double-spend the
> SerpApi allowance and could deliver duplicate alerts.

---

## 7. Rollback

Disable Cloudflare scheduling **first**, then restart the old app:

```bash
# 1. Stop Cloudflare from performing live work.
#    Set "SCHEDULER_ENABLED": "false" in worker/wrangler.jsonc
cd worker && npx wrangler deploy

# 2. Confirm the next Cron tick records outcome=disabled.
npx wrangler tail --format pretty

# 3. Restore the database if needed (only if it was changed).
cp backups/flightnotify-preD1-<timestamp>.db data/flightnotify.db

# 4. Restart the Python app.
cd .. && .venv/bin/python -m flightnotify.cli serve
```

The Worker stays deployed and serves the UI read-only-ish throughout; only
scheduling is off. To take it down entirely: `npx wrangler delete`.

---

## 8. Golden vectors

The Worker is a port, not a rewrite, and that claim is checked rather than
asserted. `tests/golden/generate_vectors.py` runs the **Python** implementation
and serializes its answers for pricing, fingerprints and alert evaluation;
`worker/test/golden.test.ts` asserts the TypeScript port reproduces every one.

CI regenerates the file and fails on any diff.

```bash
make golden     # refresh after an intentional behaviour change
```

The most load-bearing vector is the production tracker's config fingerprint,
`49bfddc4…79df`. If the Worker cannot reproduce that digest, importing that
tracker would start a *new* comparison series and orphan its price history.

---

## 9. Operations

| Task | Command |
| --- | --- |
| Deploy | `npx wrangler deploy` |
| Build only, no account needed | `npx wrangler deploy --dry-run --outdir=dist` |
| Live logs | `npx wrangler tail --format pretty` |
| Query the remote database | `npx wrangler d1 execute flightnotify --remote --command "SELECT ..."` |
| List migrations | `npx wrangler d1 migrations list flightnotify --remote` |
| Health check | `curl https://<worker>.workers.dev/healthz` |
| Enable/disable scheduling | edit `SCHEDULER_ENABLED` in `wrangler.jsonc`, redeploy |

The dashboard surfaces deployment environment, D1 connectivity and schema
version, scheduler enabled/disabled, last Cron invocation and its outcome,
active lease, next due search, SerpApi quota, Telegram readiness, and stored
tracker/observation counts.

### Free-plan limits worth knowing

| Limit | Value | How FlightNotify stays inside it |
| --- | --- | --- |
| CPU per invocation | 10 ms | Bounded work per tick; network waits do not count as CPU. |
| Subrequests per invocation | 50 | `MAX_QUERIES_PER_TICK` (3) plus Telegram sends. |
| D1 queries per invocation | 50 | No N+1: list views fetch joined data in a fixed number of statements. |
| D1 database size | 500 MB | One tracker's history is kilobytes. |
| Cron Triggers per account | 5 | One is used. |
| Requests per day | 100,000 | Single user; static assets are free and unmetered. |

---

## 10. Security

- Single-user authentication, fail-closed. Missing `SESSION_SECRET`,
  `AUTH_PASSWORD_HASH` or the D1 binding serves a 503 setup page and no data.
- PBKDF2-SHA256 password verification, constant-time comparison.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, 14-day expiry.
- CSRF token bound to the session, required on every mutation, checked
  centrally rather than per route.
- Login throttling: 5 failures locks for 15 minutes. The throttle key is an
  HMAC of the client address, so raw IPs are never stored.
- `Content-Security-Policy`, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: same-origin`, `Cache-Control: no-store`, `noindex`.
- No Cloudflare account id, database id, API key, bot token, password hash or
  session secret is rendered into a page, a log line, or the built bundle. CI
  greps the bundle for credential-shaped strings.
