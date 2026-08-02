"""Read-model helpers shared by the screens.

Nothing here performs a provider search - opening or refreshing a page must
never consume quota.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..domain.pricing import comparable_amount
from ..enums import (
    CoverageState,
    DateMode,
    DeliveryState,
    PriceScopeLabel,
    RunStatus,
    ThresholdBasis,
    TrackerStatus,
)
from ..models import AlertEvent, FareObservation, SearchRun, Tracker
from ..services import tracker_service
from ..services.bot import bot_health
from ..services.messages import date_summary
from ..services.quota import QuotaManager, QuotaSnapshot
from ..services.scheduler import scheduler_health
from ..services.settings_service import chat_id_source, get_chat_id
from ..services.telegram import TelegramNotifier
from ..timeutil import ensure_utc, utcnow


@dataclass(frozen=True, slots=True)
class SetupItem:
    key: str
    label: str
    done: bool
    detail: str
    action_label: str | None = None
    action_href: str | None = None


def setup_state(session: Session, settings: Settings) -> dict[str, Any]:
    """First-run checklist. Truthful when credentials are missing."""
    has_provider = settings.has_provider_credentials
    has_token = settings.has_telegram_token
    chat_id = get_chat_id(session, settings)
    tracker_count = int(session.execute(select(func.count(Tracker.id))).scalar_one() or 0)

    items = [
        SetupItem(
            "serpapi",
            "Add a SerpApi key",
            has_provider,
            (
                "SERPAPI_API_KEY is set, so live searches can run."
                if has_provider
                else "SERPAPI_API_KEY is not set. FlightNotify will not search and will "
                "not show any fare data until you add it to .env and restart."
            ),
            None if has_provider else "Setup instructions",
            None if has_provider else "/settings",
        ),
        SetupItem(
            "telegram_token",
            "Create a Telegram bot with @BotFather",
            has_token,
            (
                "TELEGRAM_BOT_TOKEN is set."
                if has_token
                else "TELEGRAM_BOT_TOKEN is not set. Price observations will still be "
                "recorded, but no alerts can be delivered."
            ),
            None if has_token else "Setup instructions",
            None if has_token else "/settings",
        ),
        SetupItem(
            "telegram_chat",
            "Send /start to your bot and connect the chat",
            bool(chat_id),
            (
                f"Alerts go to chat {chat_id} ({chat_id_source(session, settings)})."
                if chat_id
                else "No Telegram chat is connected yet. Send /start to your bot, then "
                "use Discover chat in Settings."
            ),
            None if chat_id else "Open Settings",
            None if chat_id else "/settings",
        ),
        SetupItem(
            "tracker",
            "Create your first tracker",
            tracker_count > 0,
            (
                f"{tracker_count} tracker{'s' if tracker_count != 1 else ''} configured."
                if tracker_count
                else "No trackers yet. Create one to start recording prices."
            ),
            None if tracker_count else "New tracker",
            None if tracker_count else "/trackers/new",
        ),
    ]
    return {
        "items": items,
        "complete": all(item.done for item in items),
        "required_complete": items[0].done,
        "tracker_count": tracker_count,
    }


def quota_view(session: Session, quota: QuotaManager) -> QuotaSnapshot:
    return quota.snapshot(session)


def telegram_view(session: Session, settings: Settings) -> dict[str, Any]:
    notifier = TelegramNotifier(settings)
    chat_id = get_chat_id(session, settings)
    return {
        "configured": notifier.is_configured(),
        "token_hint": notifier.token_hint(),
        "chat_id": chat_id,
        "chat_source": chat_id_source(session, settings),
        "ready": bool(notifier.is_configured() and chat_id),
    }


def bot_view(session: Session, settings: Settings) -> dict[str, Any]:
    health = bot_health(session, settings)
    return {
        "enabled": settings.bot_enabled,
        "running": bool(health["running"]),
        "detail": str(health["detail"]),
    }


def status_badge(tracker: Tracker, stale: bool) -> tuple[str, str, str]:
    """(tone, short label, explanation). Never colour-only in the template."""
    status = TrackerStatus(tracker.status)
    if status is TrackerStatus.PAUSED:
        return "muted", "Paused", "Scheduled checks are off for this tracker."
    if status is TrackerStatus.ERROR:
        return (
            "danger",
            "Error",
            tracker.last_error_message or "Recent checks failed. Review the run history.",
        )
    if stale:
        return (
            "warning",
            "Stale",
            "No successful check inside the expected schedule window. The last known "
            "price is shown but may be out of date.",
        )
    if tracker.latest_price is None:
        return "muted", "No data yet", "No successful observation has been recorded yet."
    return "ok", "Active", "Scheduled checks are running."


def tracker_row(session: Session, tracker: Tracker, settings: Settings) -> dict[str, Any]:
    coverage = tracker_service.coverage_stats(session, tracker)
    stale = tracker_service.is_stale(tracker)
    tone, label, explanation = status_badge(tracker, stale)
    threshold = Decimal(tracker.threshold_amount)
    latest = Decimal(tracker.latest_price) if tracker.latest_price is not None else None
    low = Decimal(tracker.low_price) if tracker.low_price is not None else None
    return {
        "tracker": tracker,
        "coverage": coverage,
        "stale": stale,
        "status_tone": tone,
        "status_label": label,
        "status_explanation": explanation,
        "latest_price": latest,
        "low_price": low,
        "threshold": threshold,
        "under_threshold": latest is not None and latest <= threshold,
        "date_summary": date_summary(tracker),
        "markets": tracker.market_codes,
        "coverage_label": coverage_label(tracker, coverage),
        "next_run_at": ensure_utc(tracker.next_run_at),
        "last_success_at": ensure_utc(tracker.last_success_at),
        "settings": settings,
    }


def coverage_label(tracker: Tracker, coverage: tracker_service.CoverageStats) -> str:
    if DateMode(tracker.date_mode) is not DateMode.CUSTOM_WINDOW or coverage.total == 0:
        return ""
    if coverage.complete:
        return f"All {coverage.total} date combinations checked in cycle {coverage.cycle}."
    return (
        f"{coverage.checked} of {coverage.total} date combinations checked "
        f"({coverage.percent}%) in cycle {coverage.cycle} — partial scan."
    )


def dashboard_data(session: Session, settings: Settings, quota: QuotaManager) -> dict[str, Any]:
    trackers = session.execute(select(Tracker).order_by(Tracker.created_at.desc())).scalars().all()
    rows = [tracker_row(session, tracker, settings) for tracker in trackers]
    active = [row for row in rows if row["tracker"].status == TrackerStatus.ACTIVE]

    upcoming = sorted(
        (row for row in active if row["next_run_at"]),
        key=lambda row: row["next_run_at"],
    )[:5]

    recent_alerts = (
        session.execute(select(AlertEvent).order_by(AlertEvent.created_at.desc()).limit(8))
        .scalars()
        .all()
    )
    recent_failures = (
        session.execute(
            select(SearchRun)
            .where(
                SearchRun.status.in_(
                    [
                        RunStatus.PROVIDER_ERROR.value,
                        RunStatus.RATE_LIMITED.value,
                        RunStatus.QUOTA_BLOCKED.value,
                        RunStatus.INVALID_REQUEST.value,
                    ]
                )
            )
            .order_by(SearchRun.started_at.desc())
            .limit(5)
        )
        .scalars()
        .all()
    )

    return {
        "rows": rows,
        "active_count": len(active),
        "under_threshold": [row for row in rows if row["under_threshold"]],
        "stale_count": sum(1 for row in rows if row["stale"]),
        "upcoming": upcoming,
        "recent_alerts": recent_alerts,
        "recent_failures": recent_failures,
        "quota": quota.snapshot(session),
        "scheduler": scheduler_health(session, settings),
        "telegram": telegram_view(session, settings),
        "setup": setup_state(session, settings),
    }


def history_points(session: Session, tracker: Tracker, limit: int = 120) -> list[dict[str, Any]]:
    """Best observation per successful run, oldest first, current series only."""
    observations = (
        session.execute(
            select(FareObservation)
            .where(
                FareObservation.tracker_id == tracker.id,
                FareObservation.config_version_id == tracker.current_config_version_id,
                FareObservation.is_best_of_run.is_(True),
                FareObservation.eligible.is_(True),
            )
            .order_by(FareObservation.observed_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    basis = ThresholdBasis(tracker.threshold_basis)
    points = []
    for observation in reversed(observations):
        points.append(
            {
                "observation": observation,
                "observed_at": ensure_utc(observation.observed_at),
                "amount": comparable_amount(
                    reported_amount=Decimal(observation.price_amount),
                    scope=PriceScopeLabel(observation.price_scope),
                    basis=basis,
                    paying_travelers=tracker.paying_travelers,
                ),
                "market": observation.market,
                "outbound_date": observation.outbound_date,
                "return_date": observation.return_date,
                "stops": observation.stops,
                "airlines": observation.airlines or [],
            }
        )
    return points


def market_comparison(session: Session, tracker: Tracker) -> list[dict[str, Any]]:
    """Latest best observation per market inside the current series."""
    results: list[dict[str, Any]] = []
    for market in tracker.market_codes:
        observation = session.execute(
            select(FareObservation)
            .where(
                FareObservation.tracker_id == tracker.id,
                FareObservation.config_version_id == tracker.current_config_version_id,
                FareObservation.market == market,
                FareObservation.is_best_of_run.is_(True),
                FareObservation.eligible.is_(True),
            )
            .order_by(FareObservation.observed_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        lowest = session.execute(
            select(FareObservation)
            .where(
                FareObservation.tracker_id == tracker.id,
                FareObservation.config_version_id == tracker.current_config_version_id,
                FareObservation.market == market,
                FareObservation.eligible.is_(True),
            )
            .order_by(FareObservation.price_amount.asc())
            .limit(1)
        ).scalar_one_or_none()
        results.append(
            {
                "market": market,
                "latest": observation,
                "lowest": lowest,
                "observed_at": ensure_utc(observation.observed_at) if observation else None,
            }
        )
    results.sort(
        key=lambda row: (
            Decimal(row["latest"].price_amount) if row["latest"] else Decimal("999999999")
        )
    )
    return results


def recent_runs(session: Session, tracker: Tracker, limit: int = 20) -> list[SearchRun]:
    return list(
        session.execute(
            select(SearchRun)
            .where(SearchRun.tracker_id == tracker.id)
            .order_by(SearchRun.started_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def recent_alerts(session: Session, tracker: Tracker, limit: int = 20) -> list[AlertEvent]:
    return list(
        session.execute(
            select(AlertEvent)
            .where(AlertEvent.tracker_id == tracker.id)
            .order_by(AlertEvent.created_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def latest_offers(session: Session, tracker: Tracker, limit: int = 8) -> list[FareObservation]:
    latest_run = session.execute(
        select(SearchRun)
        .where(
            SearchRun.tracker_id == tracker.id,
            SearchRun.status == RunStatus.SUCCESS.value,
            SearchRun.config_version_id == tracker.current_config_version_id,
        )
        .order_by(SearchRun.started_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if latest_run is None:
        return []
    return list(
        session.execute(
            select(FareObservation)
            .where(FareObservation.search_run_id == latest_run.id)
            .order_by(FareObservation.price_amount.asc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def freshness(tracker: Tracker) -> tuple[str, str]:
    """(tone, sentence) describing how current the latest observation is."""
    last = ensure_utc(tracker.last_success_at)
    if last is None:
        return "muted", "No successful observation recorded yet."
    age = utcnow() - last
    window = timedelta(minutes=tracker.check_interval_minutes * 2)
    if age > window:
        return (
            "warning",
            "Stale: the newest successful observation is older than the expected schedule window.",
        )
    return "ok", "Fresh: observed within the expected schedule window."


def coverage_state_of(tracker: Tracker, coverage: tracker_service.CoverageStats) -> CoverageState:
    if DateMode(tracker.date_mode) is not DateMode.CUSTOM_WINDOW or coverage.total == 0:
        return CoverageState.NOT_APPLICABLE
    return CoverageState.COMPLETE if coverage.complete else CoverageState.PARTIAL


def alert_state_tone(state: str) -> str:
    mapping = {
        DeliveryState.SENT.value: "ok",
        DeliveryState.FAILED.value: "danger",
        DeliveryState.PENDING.value: "warning",
        DeliveryState.NOT_CONFIGURED.value: "warning",
    }
    return mapping.get(state, "muted")


def run_state_tone(status: str) -> str:
    mapping = {
        RunStatus.SUCCESS.value: "ok",
        RunStatus.NO_RESULTS.value: "muted",
        RunStatus.PROVIDER_ERROR.value: "danger",
        RunStatus.RATE_LIMITED.value: "warning",
        RunStatus.QUOTA_BLOCKED.value: "warning",
        RunStatus.INVALID_REQUEST.value: "danger",
        RunStatus.SKIPPED.value: "muted",
    }
    return mapping.get(status, "muted")
