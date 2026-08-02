"""Programmatic Alembic access.

Both the CLI and application startup use this, so "migrate" means exactly the
same thing however FlightNotify is launched.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine

from .config import PROJECT_ROOT, Settings, get_settings
from .db import create_db_engine

log = logging.getLogger(__name__)

#: Migrations ship *inside* the package, so they are found identically whether
#: FlightNotify is installed editable, installed as a wheel, or run from the
#: image. Resolving them against the project root instead would silently pick
#: up site-packages/alembic - the Alembic library itself - in a non-editable
#: install, leaving the database unmigrated.
ALEMBIC_DIR = Path(__file__).resolve().parent / "alembic"

#: Only used for logging configuration when running from a source checkout.
#: It is not required: everything Alembic needs is set programmatically below.
ALEMBIC_INI = PROJECT_ROOT / "alembic.ini"


class MigrationsUnavailableError(RuntimeError):
    """The packaged migration scripts are missing or unreadable."""


def _script_location() -> str:
    env_py = ALEMBIC_DIR / "env.py"
    if not env_py.is_file():
        raise MigrationsUnavailableError(
            f"Alembic migrations are missing from the installed package (expected {env_py}). "
            "Reinstall FlightNotify; do not hand-create tables."
        )
    return str(ALEMBIC_DIR)


def alembic_config(settings: Settings | None = None, *, url: str | None = None) -> Config:
    settings = settings or get_settings()
    config = Config(str(ALEMBIC_INI)) if ALEMBIC_INI.exists() else Config()
    config.set_main_option("script_location", _script_location())
    resolved = url or settings.database_url
    if resolved.startswith("sqlite:///") and not resolved.startswith("sqlite:////"):
        tail = resolved.split("///", 1)[1]
        path = Path(tail)
        if not path.is_absolute():
            resolved = f"sqlite:///{PROJECT_ROOT / path}"
    # `%` is Alembic's interpolation character; escape before handing it over.
    config.set_main_option("sqlalchemy.url", resolved.replace("%", "%%"))
    return config


def upgrade(settings: Settings | None = None, revision: str = "head") -> None:
    command.upgrade(alembic_config(settings), revision)


def downgrade(settings: Settings | None = None, revision: str = "-1") -> None:
    command.downgrade(alembic_config(settings), revision)


def current_revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def head_revision(settings: Settings | None = None) -> str:
    """The revision the schema should be at.

    Raises rather than returning ``None`` when no head can be resolved. A
    ``None`` head compares equal to the ``None`` revision of an *empty*
    database, which would make :func:`is_up_to_date` report success and skip
    the migration entirely - leaving the application to fail later on a
    missing table.
    """
    script = ScriptDirectory.from_config(alembic_config(settings))
    head = script.get_current_head()
    if head is None:
        raise MigrationsUnavailableError(
            f"No migration head could be resolved from {ALEMBIC_DIR}. The migration "
            "scripts are missing or unreadable; the database was left untouched."
        )
    return head


def is_up_to_date(settings: Settings | None = None, engine: Engine | None = None) -> bool:
    settings = settings or get_settings()
    engine = engine or create_db_engine(settings)
    return current_revision(engine) == head_revision(settings)


def ensure_schema(settings: Settings | None = None) -> bool:
    """Upgrade to head when needed. Returns True if a migration ran."""
    settings = settings or get_settings()
    engine = create_db_engine(settings)
    try:
        if is_up_to_date(settings, engine):
            return False
    finally:
        engine.dispose()
    log.info("applying pending database migrations")
    upgrade(settings)
    return True
