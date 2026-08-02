"""Persistent scheduling for a single-node deployment.

Two independent locks, both in the database so they survive a restart:

* a **scheduler lease** - only one process drives the loop, even if the app is
  started with multiple workers or a second one-shot run overlaps;
* a **per-tracker lock** - the same tracker is never checked concurrently.

Both leases carry an expiry, so a process killed mid-search does not wedge the
scheduler; the lock simply ages out.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, cast

from sqlalchemy import CursorResult, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from ..config import Settings, get_settings
from ..enums import RunTrigger, TrackerStatus
from ..models import SchedulerState, Tracker
from ..timeutil import ensure_utc, utcnow
from .search import CheckResult, SearchService
from .settings_service import get_chat_id

log = logging.getLogger(__name__)


def make_owner_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


def _changed(result: object) -> bool:
    """True when an UPDATE actually claimed the row (the lock succeeded)."""
    return bool(cast(CursorResult[Any], result).rowcount)


# ---------------------------------------------------------------- leases
def acquire_scheduler_lease(session: Session, owner: str, ttl_seconds: int) -> bool:
    """Claim the single scheduler lease. False means another process holds it."""
    now = utcnow()
    state = session.get(SchedulerState, 1)
    if state is None:
        state = SchedulerState(id=1)
        session.add(state)
        session.flush()

    expires = ensure_utc(state.lock_expires_at)
    holder = state.lock_owner
    if holder and holder != owner and expires is not None and expires > now:
        return False

    result = session.execute(
        update(SchedulerState)
        .where(
            SchedulerState.id == 1,
            or_(
                SchedulerState.lock_owner.is_(None),
                SchedulerState.lock_owner == owner,
                SchedulerState.lock_expires_at.is_(None),
                SchedulerState.lock_expires_at < now,
            ),
        )
        .values(
            lock_owner=owner,
            lock_expires_at=now + timedelta(seconds=ttl_seconds),
            started_at=state.started_at or now,
        )
    )
    session.commit()
    return _changed(result)


def renew_scheduler_lease(session: Session, owner: str, ttl_seconds: int) -> bool:
    now = utcnow()
    result = session.execute(
        update(SchedulerState)
        .where(SchedulerState.id == 1, SchedulerState.lock_owner == owner)
        .values(
            lock_expires_at=now + timedelta(seconds=ttl_seconds),
            last_tick_at=now,
            tick_count=SchedulerState.tick_count + 1,
        )
    )
    session.commit()
    return _changed(result)


def release_scheduler_lease(session: Session, owner: str) -> None:
    session.execute(
        update(SchedulerState)
        .where(SchedulerState.id == 1, SchedulerState.lock_owner == owner)
        .values(lock_owner=None, lock_expires_at=None)
    )
    session.commit()


def acquire_bot_lease(session: Session, owner: str, ttl_seconds: int) -> bool:
    """Claim the single Telegram-poller lease.

    Separate from the scheduler lease so either background worker can run
    without the other. Telegram answers concurrent ``getUpdates`` calls with
    409, and two pollers would each consume a share of the updates.
    """
    now = utcnow()
    state = session.get(SchedulerState, 1)
    if state is None:
        state = SchedulerState(id=1)
        session.add(state)
        session.flush()

    expires = ensure_utc(state.bot_lock_expires_at)
    holder = state.bot_lock_owner
    if holder and holder != owner and expires is not None and expires > now:
        return False

    result = session.execute(
        update(SchedulerState)
        .where(
            SchedulerState.id == 1,
            or_(
                SchedulerState.bot_lock_owner.is_(None),
                SchedulerState.bot_lock_owner == owner,
                SchedulerState.bot_lock_expires_at.is_(None),
                SchedulerState.bot_lock_expires_at < now,
            ),
        )
        .values(bot_lock_owner=owner, bot_lock_expires_at=now + timedelta(seconds=ttl_seconds))
    )
    session.commit()
    return _changed(result)


def renew_bot_lease(session: Session, owner: str, ttl_seconds: int) -> bool:
    now = utcnow()
    result = session.execute(
        update(SchedulerState)
        .where(SchedulerState.id == 1, SchedulerState.bot_lock_owner == owner)
        .values(bot_lock_expires_at=now + timedelta(seconds=ttl_seconds))
    )
    session.commit()
    return _changed(result)


def release_bot_lease(session: Session, owner: str) -> None:
    session.execute(
        update(SchedulerState)
        .where(SchedulerState.id == 1, SchedulerState.bot_lock_owner == owner)
        .values(bot_lock_owner=None, bot_lock_expires_at=None)
    )
    session.commit()


def acquire_tracker_lock(session: Session, tracker_id: int, owner: str, ttl_seconds: int) -> bool:
    """Atomically claim a tracker. False means a check is already running."""
    now = utcnow()
    result = session.execute(
        update(Tracker)
        .where(
            Tracker.id == tracker_id,
            or_(
                Tracker.lock_owner.is_(None),
                Tracker.lock_expires_at.is_(None),
                Tracker.lock_expires_at < now,
            ),
        )
        .values(lock_owner=owner, lock_expires_at=now + timedelta(seconds=ttl_seconds))
    )
    session.commit()
    return _changed(result)


def release_tracker_lock(session: Session, tracker_id: int, owner: str) -> None:
    session.execute(
        update(Tracker)
        .where(Tracker.id == tracker_id, Tracker.lock_owner == owner)
        .values(lock_owner=None, lock_expires_at=None)
    )
    session.commit()


# ---------------------------------------------------------------- one pass
@dataclass(slots=True)
class TickReport:
    considered: int = 0
    checked: int = 0
    skipped_locked: int = 0
    provider_calls: int = 0
    alerts_sent: int = 0
    errors: list[str] = None  # type: ignore[assignment]
    results: list[CheckResult] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []
        if self.results is None:
            self.results = []

    @property
    def had_errors(self) -> bool:
        return bool(self.errors)


def due_tracker_ids(session: Session, *, limit: int | None = None) -> list[int]:
    """Active trackers whose next run has arrived, fairest-first.

    Ordering by ``next_run_at`` means the tracker waiting longest goes first,
    so a constrained quota is shared fairly instead of always feeding the same
    tracker.
    """
    now = utcnow()
    statement = (
        select(Tracker.id)
        .where(
            Tracker.status == TrackerStatus.ACTIVE.value,
            or_(Tracker.next_run_at.is_(None), Tracker.next_run_at <= now),
        )
        .order_by(Tracker.next_run_at.is_(None).desc(), Tracker.next_run_at.asc(), Tracker.id.asc())
    )
    if limit:
        statement = statement.limit(limit)
    return [int(row) for row in session.execute(statement).scalars().all()]


def run_due_trackers(
    session_factory: sessionmaker[Session],
    *,
    owner: str,
    settings: Settings | None = None,
    service: SearchService | None = None,
    trigger: RunTrigger = RunTrigger.SCHEDULED,
    limit: int | None = None,
) -> TickReport:
    """Check every due tracker once. Safe to call from cron or the loop."""
    settings = settings or get_settings()
    service = service or SearchService(settings)
    report = TickReport()

    with session_factory() as session:
        tracker_ids = due_tracker_ids(session, limit=limit)
        report.considered = len(tracker_ids)

    for tracker_id in tracker_ids:
        with session_factory() as session:
            if not acquire_tracker_lock(
                session, tracker_id, owner, settings.scheduler_lock_ttl_seconds
            ):
                report.skipped_locked += 1
                log.info(
                    "tracker check skipped: already running",
                    extra={"tracker_id": tracker_id},
                )
                continue
            try:
                tracker = session.get(Tracker, tracker_id)
                if tracker is None or tracker.status != TrackerStatus.ACTIVE:
                    continue
                result = service.run_tracker(session, tracker, trigger=trigger)
                report.results.append(result)
                report.checked += 1
                report.provider_calls += result.provider_calls
                report.alerts_sent += sum(
                    1 for outcome in result.alerts if outcome.state.value == "sent"
                )
                report.errors.extend(result.errors)
            except Exception as exc:  # pragma: no cover - defensive
                session.rollback()
                log.exception("scheduled check failed", extra={"tracker_id": tracker_id})
                report.errors.append(f"Tracker {tracker_id}: unexpected error - {exc}")
            finally:
                release_tracker_lock(session, tracker_id, owner)

    # Opportunistic maintenance: retry deliverable alerts and trim caches.
    with session_factory() as session:
        try:
            chat_id = get_chat_id(session, settings)
            service.alerts.retry_pending(session, chat_id)
            service.cache.purge_expired(session)
            service.quota.prune_call_log(session)
            session.commit()
        except Exception:  # pragma: no cover - maintenance must never break a tick
            session.rollback()
            log.exception("scheduler maintenance failed")

    return report


# ---------------------------------------------------------------- the loop
class Scheduler:
    """Background thread driving :func:`run_due_trackers`."""

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        settings: Settings | None = None,
        *,
        service: SearchService | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.session_factory = session_factory
        self.service = service
        self.owner = make_owner_id()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._has_lease = False
        self.last_report: TickReport | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def has_lease(self) -> bool:
        return self._has_lease

    def start(self) -> bool:
        """Start the loop. Returns False when another process holds the lease."""
        if self.running:
            return self._has_lease
        with self.session_factory() as session:
            self._has_lease = acquire_scheduler_lease(
                session, self.owner, self.settings.scheduler_lock_ttl_seconds
            )
        if not self._has_lease:
            log.warning(
                "scheduler not started: another process holds the lease. "
                "Run the web application with a single worker."
            )
            return False
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="flightnotify-scheduler", daemon=True
        )
        self._thread.start()
        log.info("scheduler started", extra={"owner": self.owner})
        return True

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        if self._has_lease:
            with self.session_factory() as session:
                release_scheduler_lease(session, self.owner)
            self._has_lease = False
        log.info("scheduler stopped")

    def _loop(self) -> None:
        interval = max(5, self.settings.scheduler_tick_seconds)
        while not self._stop.is_set():
            try:
                with self.session_factory() as session:
                    if not renew_scheduler_lease(
                        session, self.owner, self.settings.scheduler_lock_ttl_seconds
                    ):
                        log.warning("scheduler lease lost; stopping this instance")
                        self._has_lease = False
                        return
                self.last_report = run_due_trackers(
                    self.session_factory,
                    owner=self.owner,
                    settings=self.settings,
                    service=self.service,
                )
            except Exception as exc:  # pragma: no cover - loop must not die
                log.exception("scheduler tick failed")
                try:
                    with self.session_factory() as session:
                        state = session.get(SchedulerState, 1)
                        if state is not None:
                            state.last_error = str(exc)[:500]
                            session.commit()
                except Exception:
                    pass
            self._stop.wait(interval)


def scheduler_health(session: Session, settings: Settings | None = None) -> dict[str, object]:
    """Snapshot for the dashboard and Settings screen."""
    settings = settings or get_settings()
    state = session.get(SchedulerState, 1)
    now = utcnow()
    if state is None or state.lock_owner is None:
        return {
            "running": False,
            "owner": None,
            "last_tick_at": None,
            "tick_count": 0,
            "last_error": None,
            "detail": (
                "No scheduler process holds the lease. Automated checks only happen "
                "while the web app (with SCHEDULER_ENABLED=true) or "
                "`flightnotify check-once` is running."
            ),
        }
    expires = ensure_utc(state.lock_expires_at)
    alive = expires is not None and expires > now
    return {
        "running": alive,
        "owner": state.lock_owner,
        "last_tick_at": ensure_utc(state.last_tick_at),
        "tick_count": state.tick_count,
        "last_error": state.last_error,
        "detail": (
            "Scheduler lease is held and current."
            if alive
            else "The last scheduler lease expired - no process is currently checking trackers."
        ),
    }
