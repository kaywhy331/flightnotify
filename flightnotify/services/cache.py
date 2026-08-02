"""Short-TTL cache keyed by the provider query fingerprint.

Purpose is quota protection, not speed: an identical query inside the TTL must
never consume a second provider search. Refreshing a page cannot bypass it -
only an explicit "force refresh" can.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import QueryCacheEntry
from ..timeutil import ensure_utc, utcnow

log = logging.getLogger(__name__)


class QueryCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = max(0, ttl_seconds)

    @property
    def enabled(self) -> bool:
        return self.ttl_seconds > 0

    def get(self, session: Session, fingerprint: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        entry = session.execute(
            select(QueryCacheEntry).where(QueryCacheEntry.fingerprint == fingerprint)
        ).scalar_one_or_none()
        if entry is None:
            return None
        expires = ensure_utc(entry.expires_at)
        if expires is None or expires <= utcnow():
            session.delete(entry)
            session.flush()
            return None
        payload = entry.payload
        return payload if isinstance(payload, dict) else None

    def peek_age_seconds(self, session: Session, fingerprint: str) -> float | None:
        entry = session.execute(
            select(QueryCacheEntry).where(QueryCacheEntry.fingerprint == fingerprint)
        ).scalar_one_or_none()
        if entry is None:
            return None
        created = ensure_utc(entry.created_at)
        if created is None:
            return None
        return (utcnow() - created).total_seconds()

    def put(
        self,
        session: Session,
        *,
        fingerprint: str,
        endpoint: str,
        payload: dict[str, Any],
        run_id: int | None = None,
    ) -> None:
        if not self.enabled:
            return
        now = utcnow()
        entry = session.execute(
            select(QueryCacheEntry).where(QueryCacheEntry.fingerprint == fingerprint)
        ).scalar_one_or_none()
        if entry is None:
            entry = QueryCacheEntry(fingerprint=fingerprint, endpoint=endpoint)
            session.add(entry)
        entry.endpoint = endpoint
        entry.payload = payload
        entry.created_at = now
        entry.expires_at = now + timedelta(seconds=self.ttl_seconds)
        entry.source_run_id = run_id
        session.flush()

    def invalidate(self, session: Session, fingerprint: str) -> None:
        entry = session.execute(
            select(QueryCacheEntry).where(QueryCacheEntry.fingerprint == fingerprint)
        ).scalar_one_or_none()
        if entry is not None:
            session.delete(entry)
            session.flush()

    def purge_expired(self, session: Session) -> int:
        rows = (
            session.execute(select(QueryCacheEntry).where(QueryCacheEntry.expires_at <= utcnow()))
            .scalars()
            .all()
        )
        for row in rows:
            session.delete(row)
        return len(rows)
