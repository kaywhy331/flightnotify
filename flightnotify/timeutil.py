"""UTC-internal / local-display time helpers.

Everything persisted is timezone-aware UTC. Only the presentation layer
converts to ``APP_TIMEZONE``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo


def utcnow() -> datetime:
    """Current time as an aware UTC datetime."""
    return datetime.now(UTC)


def ensure_utc(value: datetime | None) -> datetime | None:
    """Attach UTC to a naive datetime (SQLite loses tzinfo on round-trip)."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def to_local(value: datetime | None, tz: ZoneInfo) -> datetime | None:
    aware = ensure_utc(value)
    return None if aware is None else aware.astimezone(tz)


def format_local(value: datetime | None, tz: ZoneInfo, fmt: str = "%b %-d, %-I:%M %p %Z") -> str:
    local = to_local(value, tz)
    return "-" if local is None else local.strftime(fmt)


def today_in(tz: ZoneInfo) -> date:
    """The operator's current local date - what 'not in the past' means to them."""
    return datetime.now(tz).date()


def period_key(moment: datetime | None = None) -> str:
    """Quota accounting period, ``YYYY-MM`` in UTC."""
    moment = ensure_utc(moment) or utcnow()
    return moment.strftime("%Y-%m")


def month_end(moment: datetime | None = None) -> datetime:
    """First instant of the next UTC month."""
    moment = ensure_utc(moment) or utcnow()
    if moment.month == 12:
        return datetime(moment.year + 1, 1, 1, tzinfo=UTC)
    return datetime(moment.year, moment.month + 1, 1, tzinfo=UTC)


def hours_remaining_in_month(moment: datetime | None = None) -> float:
    moment = ensure_utc(moment) or utcnow()
    return max(0.0, (month_end(moment) - moment).total_seconds() / 3600.0)


def humanize_delta(target: datetime | None, now: datetime | None = None) -> str:
    """Render ``target`` relative to now, e.g. ``in 3h 20m`` / ``12m ago``."""
    target = ensure_utc(target)
    if target is None:
        return "-"
    now = ensure_utc(now) or utcnow()
    delta = target - now
    past = delta < timedelta(0)
    seconds = int(abs(delta.total_seconds()))
    if seconds < 60:
        text = f"{seconds}s"
    elif seconds < 3600:
        text = f"{seconds // 60}m"
    elif seconds < 86400:
        text = f"{seconds // 3600}h {(seconds % 3600) // 60}m"
    else:
        text = f"{seconds // 86400}d {(seconds % 86400) // 3600}h"
    return f"{text} ago" if past else f"in {text}"
