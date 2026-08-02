"""Migrations must build a clean database and match the ORM metadata."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect

from flightnotify import migrations
from flightnotify.config import Settings
from flightnotify.models import Base

EXPECTED_TABLES = {
    "alert_events",
    "app_settings",
    "fare_observations",
    "flexible_date_candidates",
    "provider_calls",
    "provider_usage",
    "query_cache",
    "scheduler_state",
    "search_runs",
    "tracker_config_versions",
    "tracker_markets",
    "trackers",
}


@pytest.fixture()
def fresh_settings(tmp_path: Path) -> Settings:
    return Settings(database_url=f"sqlite:///{tmp_path / 'migrate.db'}", app_timezone="UTC")


def test_clean_database_migrates_to_head_without_manual_tables(fresh_settings):
    db_path = fresh_settings.sqlite_path
    assert db_path is not None and not db_path.exists()

    migrations.upgrade(fresh_settings)

    assert db_path.exists()
    engine = create_engine(fresh_settings.database_url)
    try:
        tables = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    assert EXPECTED_TABLES.issubset(tables)
    assert "alembic_version" in tables


def test_upgrade_downgrade_upgrade_roundtrip(fresh_settings):
    migrations.upgrade(fresh_settings)
    migrations.downgrade(fresh_settings, "base")

    engine = create_engine(fresh_settings.database_url)
    try:
        after_downgrade = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    assert not EXPECTED_TABLES & after_downgrade

    migrations.upgrade(fresh_settings)
    engine = create_engine(fresh_settings.database_url)
    try:
        assert EXPECTED_TABLES.issubset(set(inspect(engine).get_table_names()))
    finally:
        engine.dispose()


def test_migrated_schema_matches_the_orm_metadata(fresh_settings, tmp_path):
    """Guards against a model change that never made it into a migration."""
    migrations.upgrade(fresh_settings)
    migrated = create_engine(fresh_settings.database_url)
    metadata_engine = create_engine(f"sqlite:///{tmp_path / 'metadata.db'}")
    Base.metadata.create_all(metadata_engine)
    try:
        migrated_inspector = inspect(migrated)
        metadata_inspector = inspect(metadata_engine)
        for table in sorted(EXPECTED_TABLES):
            migrated_columns = {c["name"] for c in migrated_inspector.get_columns(table)}
            metadata_columns = {c["name"] for c in metadata_inspector.get_columns(table)}
            assert migrated_columns == metadata_columns, f"column drift in {table}"
    finally:
        migrated.dispose()
        metadata_engine.dispose()


def test_ensure_schema_is_idempotent(fresh_settings):
    assert migrations.ensure_schema(fresh_settings) is True
    assert migrations.ensure_schema(fresh_settings) is False
    assert migrations.is_up_to_date(fresh_settings) is True


def test_unique_constraints_are_enforced_after_migration(fresh_settings):
    migrations.upgrade(fresh_settings)
    connection = sqlite3.connect(fresh_settings.sqlite_path)
    try:
        connection.execute(
            "INSERT INTO alert_events (alert_type, dedupe_key, message_text, delivery_state, "
            "attempts, created_at) VALUES ('threshold', 'dup', 'text', 'sent', 1, '2026-08-01')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO alert_events (alert_type, dedupe_key, message_text, delivery_state, "
                "attempts, created_at) VALUES ('new_low', 'dup', 'other', 'sent', 1, '2026-08-01')"
            )
    finally:
        connection.close()


def test_head_revision_is_resolvable(fresh_settings):
    assert migrations.head_revision(fresh_settings)
