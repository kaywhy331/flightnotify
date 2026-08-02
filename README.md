# FlightNotify

Single-user, self-hosted round-trip flight price tracker with Telegram alerts and a hard
free-tier quota guard.

You describe a trip once — route, dates, cabin, travelers, and the price you would actually
book at. FlightNotify checks it on a schedule you control, stores every fare it observes, and
sends you a Telegram message when your threshold is reached or a new low appears. It is
deliberately small: one operator, one SQLite file, no accounts, no sign-up.

**Fares come from [SerpApi](https://serpapi.com/)'s Google Flights endpoints.** The free plan
allows 250 searches/month, so the scheduler is built around not burning them. The app starts
with no credentials at all and truthfully reports a "setup required" state rather than showing
sample fares.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Getting credentials](#getting-credentials)
- [Configuration](#configuration)
- [How checks are scheduled](#how-checks-are-scheduled)
- [The quota guard](#the-quota-guard)
- [How alerts are decided](#how-alerts-are-decided)
- [Date modes](#date-modes)
- [Command line](#command-line)
- [Backup and restore](#backup-and-restore)
- [Security](#security)
- [Development](#development)
- [Project layout](#project-layout)
- [Limitations](#limitations)
- [License](#license)

---

## What it does

- **Tracks round trips** by origin/destination, passenger mix, cabin, stop preference, and
  optional airline include/exclude lists.
- **Records every observation.** Each check writes fare observations and a `SearchRun` row —
  including runs that failed, were served from cache, or were blocked by the quota guard. The
  web UI shows a price history chart per tracker.
- **Alerts over Telegram** on two independent conditions: your price threshold being reached,
  and a new lowest fare observed for that tracker.
- **Guards the free tier** with two independent limits (monthly and hourly) plus a reserve of
  searches that automation may never touch, so a manual "Check now" still works late in the month.
- **Estimates cost before you save.** The tracker form shows how many provider searches a
  configuration will consume per scan and per 30 days, so you find out before committing quota.
- **Runs unattended** via an in-process scheduler thread, a standalone scheduler process, or a
  cron-friendly `check-once` command.

### What it is not

FlightNotify reports what it has seen. "Historical low" means *the lowest comparable fare this
installation has observed for this tracker's current configuration* — not a market low, and not
a prediction. It never forecasts prices or advises when to buy.

---

## Requirements

- Python 3.12 or newer (or Docker)
- A SerpApi API key — the free plan is enough
- A Telegram bot token and chat id, if you want alerts

FlightNotify runs fine without either credential; it just cannot search or notify until you add
them.

---

## Quick start

```bash
git clone <your-remote> FlightNotify
cd FlightNotify

make venv          # create .venv and install with dev extras
make setup         # copy .env.example -> .env and migrate the database
$EDITOR .env       # add SERPAPI_API_KEY and TELEGRAM_BOT_TOKEN
make serve         # http://127.0.0.1:8000
```

Without `make`:

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m flightnotify.cli setup
.venv/bin/python -m flightnotify.cli serve
```

`setup` creates `.env` (mode 0600) from `.env.example` and migrates the database. It never
overwrites an existing `.env`.

Check where you stand at any time:

```bash
make status        # timezone, credentials, tracker count, quota, scheduler state
```

---

## Docker

```bash
cp .env.example .env    # then fill in your credentials
docker compose up --build
# http://127.0.0.1:8000
```

The database lives on a named volume (`flightnotify-data`) and survives
`docker compose down`. Remove it deliberately with `docker compose down -v`.

The container runs as an unprivileged user (uid 10001) with `no-new-privileges`, and the port is
published to `127.0.0.1` only. Inside the container the server binds `0.0.0.0` so the published
loopback mapping can reach it — that is not a network exposure by itself. Do not change the
compose port binding unless you put your own authenticated proxy in front (see
[Security](#security)).

Pending migrations are applied on startup (`AUTO_MIGRATE=true`), so a fresh volume needs no
manual schema work.

---

## Getting credentials

### SerpApi

1. Sign up at <https://serpapi.com/users/sign_up> (free plan).
2. Copy your key from <https://serpapi.com/manage-api-key>.
3. Put it in `.env` as `SERPAPI_API_KEY`.

The free plan's allowance was **250 searches/month and 50/hour** when this was written
(verified 2026-08-01). Both numbers are configurable — do not assume the plan never changes.
`flightnotify status --sync` refreshes usage from SerpApi's account endpoint, which is itself
free and does not consume a search.

### Telegram

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
3. Open a chat with your new bot and send `/start` — a bot cannot message you first.
4. Either set `TELEGRAM_CHAT_ID`, or leave it blank and press **Discover chat** in Settings,
   which reads the chat id from the bot's recent updates.

Settings has a **Send test message** button to confirm delivery end to end.

---

## Configuration

All settings are read from the environment or `.env`. Secrets are never written to the database,
rendered into templates, or logged — the logger redacts them by literal value.

| Variable | Default | Meaning |
|---|---|---|
| `SERPAPI_API_KEY` | *(empty)* | Provider key. Without it, no search is attempted. |
| `SERPAPI_MONTHLY_SEARCH_LIMIT` | `250` | Monthly cap the guard enforces. |
| `SERPAPI_HOURLY_SEARCH_LIMIT` | `50` | Hourly cap the guard enforces. |
| `SERPAPI_RESERVE_SEARCHES` | `10` | Held back from automation for manual checks. |
| `SERPAPI_PRICE_SCOPE` | `party_total` | How to read the provider's `price` field. See below. |
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | *(empty)* | Destination chat; discoverable from the UI. |
| `APP_TIMEZONE` | `America/Los_Angeles` | IANA zone for schedules and displayed times. |
| `APP_HOST` / `APP_PORT` | `127.0.0.1` / `8000` | Listen address. |
| `APP_SECRET_KEY` | *(generated)* | Signs session cookies and CSRF tokens. |
| `DATABASE_URL` | `sqlite:///data/flightnotify.db` | SQLAlchemy URL. |
| `DEFAULT_MARKET` / `DEFAULT_CURRENCY` | `us` / `USD` | Defaults for new trackers. |
| `QUERY_CACHE_TTL_SECONDS` | `900` | How long an identical query is reused locally. |
| `SCHEDULER_ENABLED` | `true` | Run the scheduler thread inside the web app. |
| `SCHEDULER_TICK_SECONDS` | `60` | How often the scheduler looks for due trackers. |
| `AUTO_MIGRATE` | `true` | Apply pending migrations on startup. |
| `LOG_LEVEL` | `INFO` | Standard Python levels. |

If `APP_SECRET_KEY` is blank, a key is generated into `data/secret_key` at mode 0600, so a clean
checkout works without hand-crafting a secret and no real secret is ever committed. Generate your
own with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

### A note on `SERPAPI_PRICE_SCOPE`

SerpApi's documentation does not state whether the Google Flights `price` field covers the whole
passenger party or a single traveler. The default `party_total` mirrors what the Google Flights
web UI shows. This matters as soon as you track more than one traveler with a per-traveler
threshold, so it is configurable rather than assumed, and you can verify it against your own
account with evidence:

```bash
FLIGHTNOTIFY_LIVE_TESTS=1 .venv/bin/python -m pytest -m live \
  tests/live/test_live_provider.py::test_price_scope_matches_the_configured_assumption -s
```

That check consumes provider searches. Set `unknown` to make FlightNotify refuse to derive
per-traveler values at all.

---

## How checks are scheduled

Each tracker has its own interval, chosen from: hourly, 3h, 6h, 12h (the default for a new
fixed-date tracker), daily, every 2 days, or weekly.

You can run the scheduler three ways:

- **Inside the web app** (default) — `SCHEDULER_ENABLED=true`, one thread, one worker.
- **As its own process** — `make scheduler`, with the web app's scheduler disabled.
- **From cron** — `make check-once`, which runs every due tracker once and exits.

Only one scheduler may run at a time. The loop takes a lease, and a second process refuses to
start rather than double-spending quota. Individual trackers are locked while being checked, so
a manual "Check now" and a scheduled run cannot both fire the same search.

The app runs with a single uvicorn worker deliberately: one SQLite writer, one scheduler lease.

---

## The quota guard

Two independent limits are enforced before any provider call:

- **Monthly** — against `SERPAPI_MONTHLY_SEARCH_LIMIT`, tracked per billing period.
- **Hourly** — against `SERPAPI_HOURLY_SEARCH_LIMIT`, a rolling one-hour window.

On top of both sits a **reserve** (`SERPAPI_RESERVE_SEARCHES`, default 10). Automation is
budgeted against `remaining − reserve`; only manual, operator-initiated checks may draw on the
reserve. So a scheduler that runs the month dry still leaves you able to check a fare by hand.

Every check is authorized before it runs, and a blocked check is recorded as a `SearchRun` with
status `quota_blocked` and an explanation — it is visible, not silently skipped. Cache hits are
not billable and are excluded from the estimates the tracker form shows you.

---

## How alerts are decided

Two alert types fire independently, and each can be turned off per tracker.

**Threshold reached** — the comparable fare is at or below your threshold. Exactly equal counts
as reached. It will not re-fire while the fare simply stays under the threshold with no further
improvement.

**New observed low** — the comparable fare is strictly below the lowest this tracker has
observed for its current configuration.

Rules that shape both:

- The **first observation in a series is a baseline.** It may fire a threshold alert (you would
  want to know it is already cheap), but never a "new low" and never a price drop — there is
  nothing yet to compare against.
- **Minimum-drop rules** (`min_drop_absolute`, `min_drop_percent`) suppress alerts for trivial
  movements, and apply only once a previous best exists.
- A **cooldown** (default 6 hours) prevents repeat messages for the same situation, and alerts
  are deduplicated by content key.
- **Editing a tracker's search configuration starts a new series.** Prices for a different cabin
  or different dates are not comparable to the old ones, so the observed low resets rather than
  silently mixing incomparable fares.

Ordering is guaranteed: observations are committed *before* any alert is attempted, and an alert
event is persisted before delivery. A Telegram outage can never discard a stored price. Delivery
is retried up to 3 times, after which the alert is left as failed and surfaced by
`flightnotify failures`.

---

## Date modes

| Mode | Cost per scan | Use when |
|---|---|---|
| **Exact dates** | 1 search per market | You know your dates. |
| **Flexible preset** | 1 search per market | A month plus a trip length (weekend / ~1 week / ~2 weeks), via Google Travel Explore. |
| **Custom flexible window** | 1 per date combination checked | You have a date range and a nights range. |

A custom window can expand into many date combinations — far more than a free plan can check at
once. FlightNotify handles this by checking `candidates_per_run` combinations per scan and
rotating through the rest across subsequent scans, reporting coverage as partial until a full
cycle completes. The form shows you the full-cycle cost before you save, and sampled mode
requires an explicit acknowledgement so it cannot be entered by accident.

---

## Command line

```
flightnotify setup        prepare .env and the database
flightnotify migrate      apply database migrations
flightnotify serve        run the web application
flightnotify scheduler    run only the scheduler loop (no web server)
flightnotify check-once   run every due tracker once and exit (cron-friendly)
flightnotify backup       make a consistent copy of the SQLite database
flightnotify failures     show recent failed checks and undelivered alerts
flightnotify status       show quota, scheduler and setup state
```

Useful flags:

```bash
flightnotify check-once --tracker-id 3 --force   # one tracker, bypass the cache
flightnotify check-once --limit 2                # cap how many trackers run
flightnotify status --sync                       # refresh quota from SerpApi (free)
flightnotify serve --reload                      # development auto-reload
flightnotify migrate --down --revision -1        # step back one migration
```

Exit codes: `0` success, `1` errors occurred, `2` configuration problem.

A cron example that checks due trackers every hour:

```cron
0 * * * * cd /path/to/FlightNotify && .venv/bin/flightnotify check-once >> /var/log/flightnotify.log 2>&1
```

---

## Backup and restore

```bash
make backup      # -> backups/flightnotify-<timestamp>.db
```

This uses SQLite's online backup API, which produces a consistent copy even while the scheduler
is writing. A plain `cp` of a WAL database can't.

To restore, stop FlightNotify first, then copy the backup over `data/flightnotify.db`.

---

## Security

**FlightNotify has no authentication.** It is built for one operator on one machine.

- It binds `127.0.0.1` by default, and `serve` **refuses** to bind a non-loopback address unless
  you pass `--allow-external`.
- Only use `--allow-external` behind your own authenticated reverse proxy. Anyone who reaches the
  port can read and change your trackers and spend your provider quota.
- Secrets live in `.env` (mode 0600) and the generated `data/secret_key` (mode 0600). Both are
  gitignored, along with the database and backups.
- Secrets are redacted from logs, never persisted to the database, and never rendered into pages.
- Forms are CSRF-protected with signed tokens.

---

## Development

```bash
make check      # what CI runs: lint, format, types, migration drift, tests
make test       # fixture-based suite only
make lint       # ruff check
make format     # ruff format
make typecheck  # mypy (strict: untyped defs disallowed)
```

The default suite is entirely offline — it runs against recorded provider fixtures in
`tests/fixtures/` and never touches the network or consumes quota.

Live tests are opt-in and **do** consume real provider searches and send real Telegram messages:

```bash
make test-live      # FLIGHTNOTIFY_LIVE_TESTS=1 pytest -m live tests/live
```

Without that variable they skip, and CI asserts that they stay skipped.

After changing a model, regenerate a migration and confirm there is no drift:

```bash
.venv/bin/python -m alembic revision --autogenerate -m "describe the change"
.venv/bin/python -m alembic check
```

CI additionally verifies that migrations apply to a clean database, round-trip through
`downgrade base` / `upgrade head`, that the app boots into the setup-required state without
credentials, and that the Docker image builds and reports healthy.

---

## Project layout

```
flightnotify/
  cli.py              command line entry points
  config.py           settings, secret resolution
  models.py           SQLAlchemy models
  domain/             pure logic: pricing, dates, evaluation, fingerprints
  providers/serpapi/  provider client and response parsing
  services/           search orchestration, quota, cache, scheduler, alerts, telegram
  web/                FastAPI app, routes, templates, static assets
  alembic/            migrations (shipped inside the package)
alembic.ini           config for running the `alembic` CLI from a checkout
tests/                offline suite + fixtures
tests/live/           opt-in live checks
```

Migrations live **inside** the package rather than at the repository root. Resolving them
against the project root only works for an editable install; for a wheel install it resolves to
`site-packages/alembic` — the Alembic library itself — which left the database unmigrated.
Packaging them means `flightnotify migrate` behaves identically from a checkout, a wheel, or the
container image.

The `domain/` package holds no I/O — pricing normalization, date expansion, and alert evaluation
are pure functions, which is why they carry the densest test coverage.

---

## Limitations

- **One provider.** SerpApi's Google Flights endpoints only.
- **Round trips only.** No one-way or multi-city.
- **Single user, no auth.** By design; see [Security](#security).
- **Observed history only.** The low is what this installation has seen, not a market low.
- **Free-tier bound.** 250 searches/month goes quickly with wide date windows or multiple
  markets — that is exactly why the estimator and the reserve exist.
- **Fares are not bookings.** Prices change between a check and a booking attempt, and
  FlightNotify cannot hold or book a fare.

---

## License

MIT — see [LICENSE](LICENSE).
