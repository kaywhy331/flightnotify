"""FlightNotify command line.

flightnotify setup        prepare .env and the database
flightnotify migrate      apply database migrations
flightnotify serve        run the web application
flightnotify scheduler    run only the scheduler loop (no web server)
flightnotify check-once   run every due tracker once and exit (cron-friendly)
flightnotify backup       make a consistent copy of the SQLite database
flightnotify failures     show recent failed checks and undelivered alerts
flightnotify status       show quota, scheduler and setup state
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from . import __version__, migrations
from .config import PROJECT_ROOT, get_settings, reset_settings_cache
from .db import DatabaseUnavailableError, get_session_factory, session_scope
from .enums import DeliveryState, RunStatus, RunTrigger
from .logging_setup import configure_logging
from .models import AlertEvent, SearchRun, Tracker
from .providers.serpapi import SerpApiProvider
from .services.quota import QuotaManager
from .services.scheduler import make_owner_id, run_due_trackers, scheduler_health
from .services.settings_service import get_chat_id
from .timeutil import format_local, utcnow

EXIT_OK = 0
EXIT_ERRORS = 1
EXIT_CONFIG = 2


def _bootstrap() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format, settings.secret_values())


# --------------------------------------------------------------------- setup
def cmd_setup(args: argparse.Namespace) -> int:
    _bootstrap()
    env_path = PROJECT_ROOT / ".env"
    example = PROJECT_ROOT / ".env.example"
    if not env_path.exists() and example.exists():
        shutil.copyfile(example, env_path)
        env_path.chmod(0o600)
        print(f"Created {env_path} from .env.example — add your credentials to it.")
    elif env_path.exists():
        print(f"{env_path} already exists; leaving it untouched.")

    reset_settings_cache()
    settings = get_settings()
    try:
        migrations.upgrade(settings)
    except DatabaseUnavailableError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    print("Database is migrated and ready.")

    if not settings.has_provider_credentials:
        print(
            "\nNext: add SERPAPI_API_KEY to .env (https://serpapi.com/manage-api-key).\n"
            "FlightNotify starts without it, but it cannot search or show fares."
        )
    if not settings.has_telegram_token:
        print(
            "Next: create a Telegram bot with @BotFather, add TELEGRAM_BOT_TOKEN to .env, "
            "then send /start to the bot."
        )
    print(
        f"\nStart the app with: flightnotify serve   "
        f"(http://{settings.app_host}:{settings.app_port})"
    )
    return EXIT_OK


# ------------------------------------------------------------------ migrate
def cmd_migrate(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    try:
        if args.down:
            migrations.downgrade(settings, args.revision or "-1")
            print(f"Downgraded to {args.revision or '-1'}.")
        else:
            migrations.upgrade(settings, args.revision or "head")
            print(f"Database migrated to {args.revision or 'head'}.")
    except DatabaseUnavailableError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    return EXIT_OK


# -------------------------------------------------------------------- serve
def cmd_serve(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    import uvicorn

    host = args.host or settings.app_host
    port = args.port or settings.app_port
    if host not in {"127.0.0.1", "localhost", "::1"} and not args.allow_external:
        print(
            f"refusing to bind to {host}: FlightNotify has no authentication and must not "
            "be exposed. Re-run with --allow-external only if it sits behind your own "
            "authenticated proxy.",
            file=sys.stderr,
        )
        return EXIT_CONFIG

    # A single worker keeps one scheduler and one SQLite writer.
    uvicorn.run(
        "flightnotify.web.app:app",
        host=host,
        port=port,
        reload=args.reload,
        workers=1,
        log_level=settings.log_level.lower(),
        access_log=args.reload,
    )
    return EXIT_OK


# ---------------------------------------------------------------- scheduler
def cmd_scheduler(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    migrations.ensure_schema(settings)
    from .services.scheduler import Scheduler

    scheduler = Scheduler(get_session_factory(), settings)
    if not scheduler.start():
        print(
            "another process already holds the scheduler lease; not starting a second one.",
            file=sys.stderr,
        )
        return EXIT_CONFIG
    print(f"Scheduler running (tick every {settings.scheduler_tick_seconds}s). Ctrl-C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        scheduler.stop()
    return EXIT_OK


# --------------------------------------------------------------- check-once
def cmd_check_once(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    migrations.ensure_schema(settings)

    if not settings.has_provider_credentials:
        print(
            "SERPAPI_API_KEY is not set: no search was attempted and no data changed.",
            file=sys.stderr,
        )
        return EXIT_CONFIG

    owner = make_owner_id()
    factory = get_session_factory()

    if args.tracker_id:
        from .services.scheduler import acquire_tracker_lock, release_tracker_lock
        from .services.search import SearchService

        with factory() as session:
            tracker = session.get(Tracker, args.tracker_id)
            if tracker is None:
                print(f"no tracker with id {args.tracker_id}", file=sys.stderr)
                return EXIT_CONFIG
            if not acquire_tracker_lock(
                session, tracker.id, owner, settings.scheduler_lock_ttl_seconds
            ):
                print("a check for that tracker is already running", file=sys.stderr)
                return EXIT_ERRORS
            try:
                result = SearchService(settings).run_tracker(
                    session, tracker, trigger=RunTrigger.ONE_SHOT, force_refresh=args.force
                )
            finally:
                release_tracker_lock(session, tracker.id, owner)
        print(f"{tracker.name}: {result.summary()}")
        for message in result.status_messages:
            print(f"  note: {message}")
        for error in result.errors:
            print(f"  error: {error}", file=sys.stderr)
        return EXIT_ERRORS if result.errors else EXIT_OK

    report = run_due_trackers(
        factory, owner=owner, settings=settings, trigger=RunTrigger.ONE_SHOT, limit=args.limit
    )
    print(
        f"due={report.considered} checked={report.checked} "
        f"locked_skips={report.skipped_locked} provider_calls={report.provider_calls} "
        f"alerts_sent={report.alerts_sent}"
    )
    for error in report.errors:
        print(f"  error: {error}", file=sys.stderr)
    return EXIT_ERRORS if report.had_errors else EXIT_OK


# ------------------------------------------------------------------- backup
def cmd_backup(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    source = settings.sqlite_path
    if source is None:
        print(
            "DATABASE_URL is not a SQLite file; back it up with your database's tools.",
            file=sys.stderr,
        )
        return EXIT_CONFIG
    if not source.exists():
        print(f"no database at {source}; run `flightnotify migrate` first.", file=sys.stderr)
        return EXIT_CONFIG

    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    default_target = PROJECT_ROOT / "backups" / f"flightnotify-{stamp}.db"
    target = Path(args.output) if args.output else default_target
    target.parent.mkdir(parents=True, exist_ok=True)

    # sqlite3's online backup API produces a consistent copy even while the
    # scheduler is writing - a plain file copy of a WAL database can't.
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    size_kb = target.stat().st_size / 1024
    print(f"Backed up {source} → {target} ({size_kb:.1f} KiB)")
    print("Restore with: cp <backup> " + str(source) + "   (stop FlightNotify first)")
    return EXIT_OK


# ----------------------------------------------------------------- failures
def cmd_failures(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    tz = settings.tzinfo
    with session_scope() as session:
        runs = (
            session.execute(
                select(SearchRun)
                .where(
                    SearchRun.status.in_(
                        [
                            RunStatus.PROVIDER_ERROR.value,
                            RunStatus.RATE_LIMITED.value,
                            RunStatus.QUOTA_BLOCKED.value,
                            RunStatus.INVALID_REQUEST.value,
                            RunStatus.SKIPPED.value,
                        ]
                    )
                )
                .order_by(SearchRun.started_at.desc())
                .limit(args.limit)
            )
            .scalars()
            .all()
        )
        alerts = (
            session.execute(
                select(AlertEvent)
                .where(
                    AlertEvent.delivery_state.in_(
                        [
                            DeliveryState.FAILED.value,
                            DeliveryState.PENDING.value,
                            DeliveryState.NOT_CONFIGURED.value,
                        ]
                    )
                )
                .order_by(AlertEvent.created_at.desc())
                .limit(args.limit)
            )
            .scalars()
            .all()
        )

        print(f"Recent failed or skipped checks ({len(runs)}):")
        if not runs:
            print("  none")
        for run in runs:
            print(
                f"  [{format_local(run.started_at, tz)}] tracker={run.tracker_id} "
                f"status={run.status} market={run.market} "
                f"category={run.error_category}\n      "
                f"{run.error_message or run.skip_reason or '-'}"
            )

        print(f"\nUndelivered alerts ({len(alerts)}):")
        if not alerts:
            print("  none")
        for alert in alerts:
            print(
                f"  [{format_local(alert.created_at, tz)}] tracker={alert.tracker_id} "
                f"type={alert.alert_type} state={alert.delivery_state} "
                f"attempts={alert.attempts}\n      {alert.last_error or '-'}"
            )
    return EXIT_OK


# ------------------------------------------------------------------- status
def cmd_status(args: argparse.Namespace) -> int:
    _bootstrap()
    settings = get_settings()
    print(f"FlightNotify {__version__}")
    print(f"  timezone       : {settings.app_timezone}")
    print(f"  database       : {settings.database_url}")
    print(f"  SerpApi key    : {'set' if settings.has_provider_credentials else 'NOT SET'}")
    print(f"  Telegram token : {'set' if settings.has_telegram_token else 'NOT SET'}")
    print(f"  price basis    : {settings.serpapi_price_scope.value}")

    try:
        migrations.ensure_schema(settings)
    except Exception as exc:
        print(f"  schema         : ERROR - {exc}", file=sys.stderr)
        return EXIT_CONFIG

    with session_scope() as session:
        manager = QuotaManager(settings)
        if args.sync and settings.has_provider_credentials:
            manager.sync_from_provider(session, SerpApiProvider(settings))
        snapshot = manager.snapshot(session)
        health = scheduler_health(session, settings)
        tracker_count = len(session.execute(select(Tracker.id)).scalars().all())
        chat = get_chat_id(session, settings)

        print(f"  trackers       : {tracker_count}")
        print(f"  Telegram chat  : {chat or 'not connected'}")
        print(
            f"  quota          : {snapshot.effective_used}/{snapshot.monthly_limit} used "
            f"({snapshot.remaining_safe} available to automation, "
            f"{snapshot.reserve} reserved), period {snapshot.period}"
        )
        print(f"  hourly         : {snapshot.hourly_used}/{snapshot.hourly_limit} in the last hour")
        running = "running" if health["running"] else "not running"
        print(f"  scheduler      : {running} - {health['detail']}")
        if snapshot.sync_error:
            print(f"  quota sync     : {snapshot.sync_error}")
    print(f"  checked at     : {format_local(utcnow(), settings.tzinfo)}")
    return EXIT_OK


# --------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="flightnotify", description=__doc__.split("\n")[0])
    parser.add_argument("--version", action="version", version=f"flightnotify {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("setup", help="prepare .env and migrate the database").set_defaults(
        func=cmd_setup
    )

    migrate = sub.add_parser("migrate", help="apply database migrations")
    migrate.add_argument("--revision", help="target revision (default: head)")
    migrate.add_argument("--down", action="store_true", help="downgrade instead of upgrade")
    migrate.set_defaults(func=cmd_migrate)

    serve = sub.add_parser("serve", help="run the web application")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--reload", action="store_true", help="development auto-reload")
    serve.add_argument(
        "--allow-external",
        action="store_true",
        help="permit binding to a non-loopback address (unauthenticated: use with care)",
    )
    serve.set_defaults(func=cmd_serve)

    sub.add_parser("scheduler", help="run only the scheduler loop").set_defaults(func=cmd_scheduler)

    once = sub.add_parser("check-once", help="check every due tracker once and exit")
    once.add_argument("--tracker-id", type=int, help="check exactly this tracker")
    once.add_argument("--limit", type=int, help="check at most this many trackers")
    once.add_argument("--force", action="store_true", help="bypass the query cache")
    once.set_defaults(func=cmd_check_once)

    backup = sub.add_parser("backup", help="copy the SQLite database consistently")
    backup.add_argument("--output", help="destination file")
    backup.set_defaults(func=cmd_backup)

    failures = sub.add_parser("failures", help="show recent failures")
    failures.add_argument("--limit", type=int, default=15)
    failures.set_defaults(func=cmd_failures)

    status = sub.add_parser("status", help="show quota, scheduler and setup state")
    status.add_argument("--sync", action="store_true", help="refresh quota from SerpApi (free)")
    status.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except DatabaseUnavailableError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
