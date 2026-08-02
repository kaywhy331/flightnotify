"""Custom column types: JSON storage and a UTC-enforcing datetime."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, Dialect, Text, TypeDecorator


def _default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


class JSONEncoded(TypeDecorator[Any]):
    """Portable JSON storage backed by ``TEXT``.

    SQLAlchemy's native ``JSON`` type works on SQLite, but this keeps encoding
    behaviour identical everywhere and gives one place to control serialization
    of ``Decimal`` (which the provider adapters produce).
    """

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Dialect) -> str | None:
        if value is None:
            return None
        return json.dumps(value, default=_default, ensure_ascii=False, sort_keys=False)

    def process_result_value(self, value: Any, dialect: Dialect) -> Any:
        if value is None:
            return None
        if isinstance(value, dict | list):
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return None


class UtcDateTime(TypeDecorator[datetime]):
    """A timestamp that is always stored and returned as aware UTC.

    SQLite silently discards ``tzinfo``, so a naive local datetime written by
    mistake would be read back as if it were UTC and compare wrongly against
    everything else. This type converts on the way in and re-attaches UTC on
    the way out, which makes "UTC internally" an enforced property rather than
    a convention every caller has to remember.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            # A naive value is taken as UTC - the only interpretation this
            # application ever intends.
            return value
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
