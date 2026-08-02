"""Tracker lifecycle: configuration series, flexible candidates and coverage."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..domain.config_series import comparison_payload, describe_changes, series_fingerprint
from ..domain.dates import DateWindowError, generate_pairs, ordered_pairs
from ..enums import CandidateStatus, DateMode, TrackerStatus
from ..models import FlexibleDateCandidate, Tracker, TrackerConfigVersion
from ..timeutil import ensure_utc, today_in, utcnow

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class CoverageStats:
    total: int
    checked: int
    cycle: int
    complete: bool
    oldest_observation: object | None
    newest_observation: object | None
    remaining: int

    @property
    def percent(self) -> float:
        if self.total <= 0:
            return 0.0
        return round(self.checked / self.total * 100, 1)


@dataclass(frozen=True, slots=True)
class SeriesChange:
    created: bool
    version: TrackerConfigVersion
    changes: list[str]


def ensure_config_version(session: Session, tracker: Tracker) -> SeriesChange:
    """Return the tracker's current comparison series, creating one if needed.

    A change to any comparison-relevant field closes the previous version and
    opens a new one. Historical observations are *never* deleted; they stay
    attached to the version that produced them, which is what makes the
    comparison boundary explicit instead of silent.
    """
    fingerprint = series_fingerprint(tracker)
    current = None
    if tracker.current_config_version_id is not None:
        current = session.get(TrackerConfigVersion, tracker.current_config_version_id)

    if current is not None and current.fingerprint == fingerprint:
        return SeriesChange(created=False, version=current, changes=[])

    now = utcnow()
    payload = comparison_payload(tracker)
    changes = describe_changes(current.payload, payload) if current is not None else []

    if current is not None:
        current.effective_to = now

    next_version = (
        session.execute(
            select(func.coalesce(func.max(TrackerConfigVersion.version), 0)).where(
                TrackerConfigVersion.tracker_id == tracker.id
            )
        ).scalar_one()
        + 1
    )
    version = TrackerConfigVersion(
        tracker_id=tracker.id,
        version=next_version,
        fingerprint=fingerprint,
        payload=payload,
        effective_from=now,
    )
    session.add(version)
    session.flush()

    tracker.current_config_version_id = version.id
    tracker.series_started_at = now
    # Summary fields describe the *current* series only.
    tracker.latest_price = None
    tracker.latest_observation_id = None
    tracker.latest_observed_at = None
    tracker.low_price = None
    tracker.low_observation_id = None
    tracker.low_observed_at = None
    tracker.last_threshold_met = False
    tracker.coverage_cycle = 1
    session.flush()

    if tracker.date_mode == DateMode.CUSTOM_WINDOW:
        rebuild_candidates(session, tracker, version)

    log.info(
        "tracker configuration series opened",
        extra={"tracker_id": tracker.id, "version": version.version, "changes": len(changes)},
    )
    return SeriesChange(created=True, version=version, changes=changes)


def rebuild_candidates(
    session: Session,
    tracker: Tracker,
    version: TrackerConfigVersion,
    *,
    settings: Settings | None = None,
) -> int:
    """(Re)generate the flexible-window work queue for a configuration version."""
    settings = settings or get_settings()
    existing = (
        session.execute(
            select(FlexibleDateCandidate).where(
                FlexibleDateCandidate.config_version_id == version.id
            )
        )
        .scalars()
        .all()
    )
    for row in existing:
        session.delete(row)
    session.flush()

    if tracker.date_mode != DateMode.CUSTOM_WINDOW:
        return 0
    if tracker.window_outbound_start is None or tracker.window_outbound_end is None:
        return 0

    pairs = generate_pairs(
        outbound_start=tracker.window_outbound_start,
        outbound_end=tracker.window_outbound_end,
        return_start=tracker.window_return_start,
        return_end=tracker.window_return_end,
        min_nights=tracker.min_nights,
        max_nights=tracker.max_nights,
        not_before=today_in(settings.tzinfo),
    )
    for position, pair in ordered_pairs(pairs):
        session.add(
            FlexibleDateCandidate(
                tracker_id=tracker.id,
                config_version_id=version.id,
                outbound_date=pair.outbound,
                return_date=pair.inbound,
                nights=pair.nights,
                order_index=position,
                cycle=1,
                status=CandidateStatus.PENDING.value,
            )
        )
    session.flush()
    return len(pairs)


def prune_past_candidates(session: Session, tracker: Tracker, today: date) -> int:
    """Mark candidates whose outbound date has passed so they are never queried."""
    if tracker.current_config_version_id is None:
        return 0
    rows = (
        session.execute(
            select(FlexibleDateCandidate).where(
                FlexibleDateCandidate.config_version_id == tracker.current_config_version_id,
                FlexibleDateCandidate.outbound_date < today,
                FlexibleDateCandidate.status != CandidateStatus.CHECKED.value,
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.status = CandidateStatus.CHECKED.value
        row.last_checked_at = utcnow()
    session.flush()
    return len(rows)


def next_candidates(session: Session, tracker: Tracker, limit: int) -> list[FlexibleDateCandidate]:
    """Claim the next pending candidates in deterministic fair order.

    When every candidate in the current cycle has been checked, the cycle
    advances and the whole window becomes pending again - that is how a
    long-running tracker keeps re-observing prices over time.
    """
    if tracker.current_config_version_id is None or limit <= 0:
        return []

    rows = (
        session.execute(
            select(FlexibleDateCandidate)
            .where(
                FlexibleDateCandidate.config_version_id == tracker.current_config_version_id,
                FlexibleDateCandidate.cycle == tracker.coverage_cycle,
                FlexibleDateCandidate.status == CandidateStatus.PENDING.value,
            )
            .order_by(FlexibleDateCandidate.order_index)
            .limit(limit)
        )
        .scalars()
        .all()
    )
    if rows:
        return list(rows)

    total = coverage_stats(session, tracker).total
    if total == 0:
        return []

    # Cycle complete - open the next one.
    tracker.coverage_cycle += 1
    session.execute(
        select(FlexibleDateCandidate).where(
            FlexibleDateCandidate.config_version_id == tracker.current_config_version_id
        )
    )
    for row in (
        session.execute(
            select(FlexibleDateCandidate).where(
                FlexibleDateCandidate.config_version_id == tracker.current_config_version_id
            )
        )
        .scalars()
        .all()
    ):
        row.cycle = tracker.coverage_cycle
        row.status = CandidateStatus.PENDING.value
    session.flush()
    log.info(
        "flexible coverage cycle advanced",
        extra={"tracker_id": tracker.id, "cycle": tracker.coverage_cycle},
    )
    return next_candidates(session, tracker, limit)


def coverage_stats(session: Session, tracker: Tracker) -> CoverageStats:
    """Coverage of the *current* cycle for a custom flexible window."""
    if tracker.date_mode != DateMode.CUSTOM_WINDOW or tracker.current_config_version_id is None:
        return CoverageStats(0, 0, tracker.coverage_cycle, True, None, None, 0)

    base = select(FlexibleDateCandidate).where(
        FlexibleDateCandidate.config_version_id == tracker.current_config_version_id
    )
    rows = session.execute(base).scalars().all()
    total = len(rows)
    checked = sum(
        1
        for row in rows
        if row.cycle == tracker.coverage_cycle and row.status != CandidateStatus.PENDING.value
    )
    timestamps = [
        stamp
        for stamp in (ensure_utc(row.last_checked_at) for row in rows if row.last_checked_at)
        if stamp is not None
    ]
    return CoverageStats(
        total=total,
        checked=checked,
        cycle=tracker.coverage_cycle,
        complete=total > 0 and checked >= total,
        oldest_observation=min(timestamps) if timestamps else None,
        newest_observation=max(timestamps) if timestamps else None,
        remaining=max(0, total - checked),
    )


def total_candidate_count(session: Session, tracker: Tracker) -> int:
    if tracker.current_config_version_id is None:
        return 0
    return int(
        session.execute(
            select(func.count(FlexibleDateCandidate.id)).where(
                FlexibleDateCandidate.config_version_id == tracker.current_config_version_id
            )
        ).scalar_one()
        or 0
    )


def preview_candidate_count(tracker_like: dict[str, object], today: date) -> tuple[int, str | None]:
    """Count combinations for an unsaved form, for the live budget estimate."""
    try:
        pairs = generate_pairs(
            outbound_start=tracker_like["window_outbound_start"],  # type: ignore[arg-type]
            outbound_end=tracker_like["window_outbound_end"],  # type: ignore[arg-type]
            return_start=tracker_like.get("window_return_start"),  # type: ignore[arg-type]
            return_end=tracker_like.get("window_return_end"),  # type: ignore[arg-type]
            min_nights=tracker_like.get("min_nights"),  # type: ignore[arg-type]
            max_nights=tracker_like.get("max_nights"),  # type: ignore[arg-type]
            not_before=today,
        )
    except (DateWindowError, KeyError, TypeError) as exc:
        return 0, str(exc) if isinstance(exc, DateWindowError) else None
    return len(pairs), None


def schedule_next_run(tracker: Tracker, *, from_time: object | None = None) -> None:
    """Persist the next due time using the tracker's interval."""
    base = ensure_utc(from_time) if from_time else utcnow()  # type: ignore[arg-type]
    tracker.next_run_at = (base or utcnow()) + timedelta(minutes=tracker.check_interval_minutes)


def is_stale(tracker: Tracker, *, grace_multiplier: float = 2.0) -> bool:
    """True when no successful observation landed inside the expected window."""
    if tracker.status != TrackerStatus.ACTIVE:
        return False
    last = ensure_utc(tracker.last_success_at)
    if last is None:
        return tracker.latest_price is None and tracker.last_attempt_at is not None
    allowed = timedelta(minutes=tracker.check_interval_minutes * grace_multiplier)
    return (utcnow() - last) > allowed
