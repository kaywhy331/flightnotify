"""Telegram command handling.

FlightNotify has no authentication and binds to loopback by design. The bot is
its only inbound surface, so the rule that matters here is simple and absolute:
**only the configured chat id is ever obeyed.** Anything else is dropped without
a reply, because answering would confirm the bot exists to a stranger and spend
the send rate limit on them.

Commands reuse the same code paths as the web UI - no second implementation of
checking, pausing or quota accounting - so the two interfaces cannot drift.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .. import __version__
from ..config import Settings, get_settings
from ..enums import DateMode, RunTrigger, ThresholdBasis, TrackerStatus
from ..models import Tracker
from ..timeutil import ensure_utc, utcnow
from . import tracker_service
from .messages import (
    TrackerSummary,
    build_check_result_message,
    build_help_message,
    build_status_message,
    build_tracker_detail_message,
    build_trackers_message,
    build_unknown_command_message,
    date_summary,
)
from .quota import QuotaManager
from .scheduler import (
    acquire_bot_lease,
    acquire_tracker_lock,
    make_owner_id,
    release_bot_lease,
    release_tracker_lock,
    renew_bot_lease,
    scheduler_health,
)
from .search import SearchService
from .settings_service import KEY_BOT_UPDATE_OFFSET, get_chat_id, get_setting, set_setting
from .telegram import TelegramNotifier

log = logging.getLogger(__name__)

#: Commands that change state or spend quota. Kept explicit so the split
#: between reading and acting stays visible.
WRITE_COMMANDS = frozenset({"/check", "/pause", "/resume"})


@dataclass(frozen=True, slots=True)
class Command:
    name: str
    argument: str | None
    chat_id: int
    update_id: int


def parse_command(text: str) -> tuple[str, str | None]:
    """Split ``/check@MyBot 3`` into ``("/check", "3")``.

    Telegram appends ``@botname`` when a command is sent in a group; strip it so
    the same text works from anywhere.
    """
    stripped = text.strip()
    if not stripped.startswith("/"):
        return "", None
    head, _, tail = stripped.partition(" ")
    name, _, _mention = head.partition("@")
    argument = tail.strip() or None
    return name.lower(), argument


def _tracker_summary(session: Session, tracker: Tracker) -> TrackerSummary:
    coverage = tracker_service.coverage_stats(session, tracker)
    is_window = DateMode(tracker.date_mode) is DateMode.CUSTOM_WINDOW
    return TrackerSummary(
        tracker_id=tracker.id,
        name=tracker.name,
        status=tracker.status,
        origin=tracker.origin,
        destination=tracker.destination,
        currency=tracker.currency,
        dates=date_summary(tracker),
        latest_price=Decimal(tracker.latest_price) if tracker.latest_price is not None else None,
        low_price=Decimal(tracker.low_price) if tracker.low_price is not None else None,
        threshold_amount=Decimal(tracker.threshold_amount),
        threshold_basis=ThresholdBasis(tracker.threshold_basis),
        last_success_at=ensure_utc(tracker.last_success_at),
        next_run_at=ensure_utc(tracker.next_run_at),
        stale=tracker_service.is_stale(tracker),
        coverage_checked=coverage.checked if is_window else None,
        coverage_total=coverage.total if is_window else None,
        coverage_complete=coverage.complete,
    )


class BotPoller:
    """Long-polls Telegram for commands. One instance at a time, by lease."""

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: Settings | None = None,
        *,
        notifier: TelegramNotifier | None = None,
        service: SearchService | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.session_factory = session_factory
        self.notifier = notifier or TelegramNotifier(self.settings)
        self.service = service
        self.owner = make_owner_id()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._has_lease = False

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def has_lease(self) -> bool:
        return self._has_lease

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> bool:
        """Start polling. False when it must not run; the reason is logged."""
        if self.running:
            return self._has_lease
        if not self.notifier.is_configured():
            log.warning("bot not started: TELEGRAM_BOT_TOKEN is not set")
            return False

        with self.session_factory() as session:
            if not get_chat_id(session, self.settings):
                # Without a chat id there is nothing to authorise against, so
                # every command would have to be refused anyway.
                log.warning(
                    "bot not started: no Telegram chat id is configured. "
                    "Connect a chat first (Settings -> Discover chat)."
                )
                return False
            self._has_lease = acquire_bot_lease(
                session, self.owner, self.settings.scheduler_lock_ttl_seconds
            )
        if not self._has_lease:
            log.warning("bot not started: another process holds the poller lease")
            return False

        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="flightnotify-bot", daemon=True)
        self._thread.start()
        log.info("telegram command bot started", extra={"owner": self.owner})
        return True

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        if self._has_lease:
            with self.session_factory() as session:
                release_bot_lease(session, self.owner)
            self._has_lease = False
        log.info("telegram command bot stopped")

    # -- polling ------------------------------------------------------------
    def _loop(self) -> None:
        poll_timeout = max(0, self.settings.bot_poll_timeout_seconds)
        while not self._stop.is_set():
            try:
                with self.session_factory() as session:
                    if not renew_bot_lease(
                        session, self.owner, self.settings.scheduler_lock_ttl_seconds
                    ):
                        log.warning("bot lease lost; stopping this instance")
                        self._has_lease = False
                        return
                self.poll_once(timeout=poll_timeout)
            except Exception:  # pragma: no cover - the loop must not die
                log.exception("bot poll failed")
                # Back off so a persistent failure cannot spin.
                self._stop.wait(5)

    def poll_once(self, *, timeout: int = 0) -> int:
        """Fetch and handle one batch. Returns the number of commands handled."""
        with self.session_factory() as session:
            offset = get_setting(session, KEY_BOT_UPDATE_OFFSET)
        next_offset = int(offset) + 1 if isinstance(offset, int) else None

        result = self.notifier.get_updates(offset=next_offset, timeout=timeout)
        if not result.ok:
            if result.category not in {"timeout", "network"}:
                log.warning("getUpdates failed: %s", result.category)
            return 0

        updates = result.meta.get("result") or []
        handled = 0
        highest = int(offset) if isinstance(offset, int) else None
        for update in updates:
            if not isinstance(update, dict):
                continue
            update_id = update.get("update_id")
            if isinstance(update_id, int) and (highest is None or update_id > highest):
                highest = update_id
            command = self._authorize(update)
            if command is None:
                continue
            self._dispatch(command)
            handled += 1

        if highest is not None and highest != offset:
            with self.session_factory() as session:
                set_setting(session, KEY_BOT_UPDATE_OFFSET, highest)
                session.commit()
        return handled

    def _authorize(self, update: dict[str, Any]) -> Command | None:
        """Return a Command only for the configured chat. Never replies."""
        message = update.get("message")
        if not isinstance(message, dict):
            return None
        chat = message.get("chat")
        text = message.get("text")
        if not isinstance(chat, dict) or not isinstance(text, str):
            return None
        if str(chat.get("type")) != "private":
            return None
        chat_id = chat.get("id")
        if not isinstance(chat_id, int):
            return None

        with self.session_factory() as session:
            allowed = get_chat_id(session, self.settings)
        if not allowed or str(chat_id) != str(allowed):
            # Deliberately silent: a reply would confirm the bot to a stranger.
            log.warning(
                "ignored a Telegram command from an unauthorised chat",
                extra={"chat_id": chat_id},
            )
            return None

        name, argument = parse_command(text)
        if not name:
            return None
        return Command(
            name=name,
            argument=argument,
            chat_id=chat_id,
            update_id=int(update.get("update_id") or 0),
        )

    def _dispatch(self, command: Command) -> None:
        handlers = {
            "/start": self._handle_help,
            "/help": self._handle_help,
            "/status": self._handle_status,
            "/trackers": self._handle_trackers,
            "/tracker": self._handle_tracker,
            "/check": self._handle_check,
            "/pause": self._handle_pause,
            "/resume": self._handle_resume,
        }
        handler = handlers.get(command.name)
        try:
            reply = (
                handler(command)
                if handler is not None
                else build_unknown_command_message(command.name)
            )
        except Exception:
            log.exception("bot command failed", extra={"command": command.name})
            reply = (
                "That command failed unexpectedly. Stored price history is unchanged. "
                "See the application log for details."
            )
        if reply:
            self.notifier.send_message(command.chat_id, reply, disable_preview=True)

    # -- handlers -----------------------------------------------------------
    def _handle_help(self, command: Command) -> str:
        return build_help_message()

    def _handle_status(self, command: Command) -> str:
        with self.session_factory() as session:
            snapshot = QuotaManager(self.settings).snapshot(session)
            health = scheduler_health(session, self.settings)
            total = int(session.execute(select(func.count(Tracker.id))).scalar_one() or 0)
            active = int(
                session.execute(
                    select(func.count(Tracker.id)).where(
                        Tracker.status == TrackerStatus.ACTIVE.value
                    )
                ).scalar_one()
                or 0
            )
        return build_status_message(
            snapshot=snapshot,
            scheduler_running=bool(health["running"]),
            scheduler_detail=str(health["detail"]),
            tracker_count=total,
            active_count=active,
            provider_configured=self.settings.has_provider_credentials,
            version=__version__,
            now=utcnow(),
            tz=self.settings.tzinfo,
        )

    def _handle_trackers(self, command: Command) -> str:
        with self.session_factory() as session:
            trackers = session.execute(select(Tracker).order_by(Tracker.id)).scalars().all()
            summaries = [_tracker_summary(session, tracker) for tracker in trackers]
        return build_trackers_message(summaries, self.settings.tzinfo)

    def _handle_tracker(self, command: Command) -> str:
        tracker_id = _parse_id(command.argument)
        if tracker_id is None:
            return "Send a tracker id, for example /tracker 1. Use /trackers to list them."
        with self.session_factory() as session:
            tracker = session.get(Tracker, tracker_id)
            if tracker is None:
                return f"No tracker with id {tracker_id}. Use /trackers to list them."
            summary = _tracker_summary(session, tracker)
        return build_tracker_detail_message(summary, self.settings.tzinfo)

    def _handle_check(self, command: Command) -> str:
        tracker_id = _parse_id(command.argument)
        if tracker_id is None:
            return "Send a tracker id, for example /check 1."
        if not self.settings.has_provider_credentials:
            return "SERPAPI_API_KEY is not set, so no search was attempted."

        owner = make_owner_id()
        with self.session_factory() as session:
            tracker = session.get(Tracker, tracker_id)
            if tracker is None:
                return f"No tracker with id {tracker_id}. Use /trackers to list them."
            name = tracker.name
            if not acquire_tracker_lock(
                session, tracker.id, owner, self.settings.scheduler_lock_ttl_seconds
            ):
                return f"A check for “{name}” is already running. Nothing was started twice."
            try:
                service = self.service or SearchService(self.settings)
                # MANUAL is reserve-eligible, matching the web UI's "Check now":
                # an operator asking for a check may use the held-back searches.
                result = service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
            finally:
                release_tracker_lock(session, tracker.id, owner)

            return build_check_result_message(
                tracker_name=name,
                summary=result.summary(),
                status_messages=list(result.status_messages),
                errors=list(result.errors),
            )

    def _handle_pause(self, command: Command) -> str:
        tracker_id = _parse_id(command.argument)
        if tracker_id is None:
            return "Send a tracker id, for example /pause 1."
        with self.session_factory() as session:
            tracker = session.get(Tracker, tracker_id)
            if tracker is None:
                return f"No tracker with id {tracker_id}. Use /trackers to list them."
            tracker.status = TrackerStatus.PAUSED.value
            session.commit()
            return f"“{tracker.name}” paused. History is kept."

    def _handle_resume(self, command: Command) -> str:
        tracker_id = _parse_id(command.argument)
        if tracker_id is None:
            return "Send a tracker id, for example /resume 1."
        with self.session_factory() as session:
            tracker = session.get(Tracker, tracker_id)
            if tracker is None:
                return f"No tracker with id {tracker_id}. Use /trackers to list them."
            tracker.status = TrackerStatus.ACTIVE.value
            tracker.consecutive_failures = 0
            tracker.last_error_category = None
            tracker.last_error_message = None
            tracker_service.schedule_next_run(tracker)
            session.commit()
            return f"“{tracker.name}” resumed."


def _parse_id(argument: str | None) -> int | None:
    if not argument:
        return None
    token = argument.split()[0]
    return int(token) if token.isdigit() else None


def bot_health(session: Session, settings: Settings | None = None) -> dict[str, object]:
    """Whether a poller currently holds the lease (used by `flightnotify status`)."""
    from ..models import SchedulerState

    settings = settings or get_settings()
    state = session.get(SchedulerState, 1)
    expires = ensure_utc(state.bot_lock_expires_at) if state is not None else None
    live = bool(state and state.bot_lock_owner and expires and expires > utcnow())
    if not settings.bot_enabled:
        return {"running": False, "detail": "BOT_ENABLED is false."}
    if not settings.has_telegram_token:
        return {"running": False, "detail": "TELEGRAM_BOT_TOKEN is not set."}
    return {
        "running": live,
        "detail": "polling for commands" if live else "no poller holds the lease",
    }


__all__ = ["WRITE_COMMANDS", "BotPoller", "Command", "bot_health", "parse_command"]
