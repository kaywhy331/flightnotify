"""Alembic environment.

The database URL always comes from FlightNotify's own settings so `alembic`
and `flightnotify migrate` can never target different files.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from flightnotify.config import PROJECT_ROOT, get_settings
from flightnotify.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def _database_url() -> str:
    from pathlib import Path

    override = config.get_main_option("sqlalchemy.url", None)
    settings = get_settings()
    url = override or settings.database_url
    if url.startswith("sqlite:///"):
        tail = url.split("///", 1)[1]
        path = Path(tail)
        if not path.is_absolute():
            path = PROJECT_ROOT / path
            url = f"sqlite:///{path}"
        # A clean checkout has no data/ directory yet; migrating must create it
        # rather than failing with "unable to open database file".
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
    return url


target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _database_url()
    connectable = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # SQLite cannot ALTER most things; batch mode rebuilds the table.
            render_as_batch=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
