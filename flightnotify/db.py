"""Database engine, session factory and SQLite pragmas."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings, data_root, get_settings

log = logging.getLogger(__name__)

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


class DatabaseUnavailableError(RuntimeError):
    """The SQLite file (or its directory) cannot be created or written."""


def _normalize_url(settings: Settings) -> str:
    """Resolve a relative SQLite path against the data root."""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return url
    prefix, sep, tail = url.partition("///")
    if not sep or not tail or tail == ":memory:":
        return url
    path = Path(tail)
    if not path.is_absolute():
        path = data_root() / path
    return f"{prefix}///{path}"


def _ensure_writable(settings: Settings) -> None:
    path = settings.sqlite_path
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        probe = path.parent / ".write-probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise DatabaseUnavailableError(
            f"The database directory {path.parent} is not writable: {exc}. "
            "Stored history is untouched. Fix the directory permissions "
            "(or point DATABASE_URL somewhere writable) and restart."
        ) from exc


def create_db_engine(settings: Settings | None = None) -> Engine:
    settings = settings or get_settings()
    _ensure_writable(settings)
    url = _normalize_url(settings)
    is_sqlite = url.startswith("sqlite")

    connect_args: dict[str, Any] = {}
    if is_sqlite:
        # The scheduler thread and request threads share the engine.
        connect_args = {"check_same_thread": False, "timeout": 30}

    engine = create_engine(url, future=True, pool_pre_ping=True, connect_args=connect_args)

    if is_sqlite:

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
            cursor = dbapi_connection.cursor()
            try:
                # WAL keeps the scheduler writing while the UI reads.
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA synchronous=NORMAL")
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.execute("PRAGMA busy_timeout=30000")
            finally:
                cursor.close()

    return engine


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_db_engine()
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    global _session_factory
    if _session_factory is None:
        _session_factory = sessionmaker(
            bind=get_engine(), expire_on_commit=False, autoflush=False, future=True
        )
    return _session_factory


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope. Commits on success, rolls back on any exception."""
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def db_session() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def configure_engine(engine: Engine) -> None:
    """Point the module at a specific engine (used by tests and the CLI)."""
    global _engine, _session_factory
    _engine = engine
    _session_factory = sessionmaker(
        bind=engine, expire_on_commit=False, autoflush=False, future=True
    )


def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
