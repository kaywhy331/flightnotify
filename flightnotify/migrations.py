"""Programmatic Alembic access.

Both the CLI and application startup use this, so "migrate" means exactly the
same thing however FlightNotify is launched.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine

from alembic import command

from .config import PROJECT_ROOT, Settings, get_settings
from .db import create_db_engine

log = logging.getLogger(__name__)

ALEMBIC_INI = PROJECT_ROOT / "alembic.ini"
ALEMBIC_DIR = PROJECT_ROOT / "alembic"


def alembic_config(settings: Settings | None = None, *, url: str | None = None) -> Config:
    settings = settings or get_settings()
    config = Config(str(ALEMBIC_INI)) if ALEMBIC_INI.exists() else Config()
    config.set_main_option("script_location", str(ALEMBIC_DIR))
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


def head_revision(settings: Settings | None = None) -> str | None:
    script = ScriptDirectory.from_config(alembic_config(settings))
    return script.get_current_head()


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
