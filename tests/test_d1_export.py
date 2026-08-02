"""The SQLite -> Cloudflare D1 export tooling.

Every fixture here is built from FlightNotify's own models, so nothing in this
file depends on (or can reach) the production database.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from flightnotify import cli, d1_export
from flightnotify.config import PROJECT_ROOT
from flightnotify.d1_export import ISO_MILLIS_PATTERN, to_basis_points, to_cents, to_iso_millis
from flightnotify.models import (
    AlertEvent,
    AppSetting,
    Base,
    FareObservation,
    FlexibleDateCandidate,
    ProviderCall,
    ProviderUsage,
    QueryCacheEntry,
    SchedulerState,
    SearchRun,
    Tracker,
    TrackerConfigVersion,
    TrackerMarket,
)

D1_SCHEMA = PROJECT_ROOT / "worker" / "migrations" / "0001_initial_schema.sql"

T0 = datetime(2026, 8, 2, 22, 16, 59, 516031, tzinfo=UTC)


def _seed(session: Session) -> None:
    session.add(
        Tracker(
            id=1,
            name="Tokyo autumn",
            status="active",
            origin="SFO",
            destination="NRT",
            adults=2,
            cabin="economy",
            stops="any",
            currency="USD",
            date_mode="exact",
            outbound_date=datetime(2026, 9, 30).date(),
            return_date=datetime(2026, 10, 8).date(),
            threshold_amount=Decimal("1962.00"),
            threshold_basis="party",
            min_drop_absolute=Decimal("25.50"),
            min_drop_percent=Decimal("7.50"),
            current_config_version_id=1,
            latest_price=Decimal("1962.00"),
            latest_observation_id=1,
            latest_observed_at=T0,
            low_price=Decimal("1962.00"),
            low_observation_id=1,
            low_observed_at=T0,
            next_run_at=T0 + timedelta(hours=12),
            created_at=T0,
            updated_at=T0,
        )
    )
    session.add(
        Tracker(
            # An apostrophe in user data: the emitted SQL must escape it.
            id=2,
            name="O'Hare escape",
            status="paused",
            origin="ORD",
            destination="LIS",
            adults=1,
            cabin="economy",
            stops="any",
            currency="USD",
            date_mode="exact",
            outbound_date=datetime(2027, 3, 1).date(),
            return_date=datetime(2027, 3, 12).date(),
            threshold_amount=Decimal("1024.55"),
            threshold_basis="party",
            current_config_version_id=2,
            latest_price=Decimal("1024.55"),
            latest_observation_id=3,
            low_price=Decimal("1024.55"),
            low_observation_id=3,
            created_at=T0,
            updated_at=T0,
        )
    )
    session.flush()

    for tracker_id in (1, 2):
        session.add(
            TrackerConfigVersion(
                id=tracker_id,
                tracker_id=tracker_id,
                version=1,
                fingerprint=f"fp-{tracker_id}",
                payload={"adults": 2, "cabin": "economy"},
                effective_from=T0,
                created_at=T0,
            )
        )
        session.add(TrackerMarket(id=tracker_id, tracker_id=tracker_id, market="us", priority=0))
    session.flush()

    session.add(
        FlexibleDateCandidate(
            id=1,
            tracker_id=1,
            config_version_id=1,
            outbound_date=datetime(2026, 9, 30).date(),
            return_date=datetime(2026, 10, 8).date(),
            nights=8,
            order_index=0,
            status="checked",
            last_checked_at=T0,
            last_run_id=1,
            check_count=1,
            last_price=Decimal("1962.00"),
        )
    )
    for run_id, tracker_id, best in ((1, 1, 1), (2, 2, 3)):
        session.add(
            SearchRun(
                id=run_id,
                tracker_id=tracker_id,
                config_version_id=tracker_id,
                batch_id=f"batch-{run_id}",
                trigger="scheduled",
                endpoint="google_flights",
                market="us",
                currency="USD",
                outbound_date=datetime(2026, 9, 30).date(),
                return_date=datetime(2026, 10, 8).date(),
                query_fingerprint=f"qfp-{run_id}",
                started_at=T0,
                completed_at=T0 + timedelta(seconds=5),
                status="success",
                offers_found=2,
                best_observation_id=best,
                raw_excerpt={"note": "it's fine"},
            )
        )
    session.flush()

    prices = (
        (1, 1, 1, Decimal("1962.00")),
        (2, 1, 1, Decimal("1024.50")),
        (3, 2, 2, Decimal("1024.55")),
    )
    for obs_id, run_id, tracker_id, price in prices:
        session.add(
            FareObservation(
                id=obs_id,
                search_run_id=run_id,
                tracker_id=tracker_id,
                config_version_id=tracker_id,
                itinerary_fingerprint=f"itin-{obs_id}",
                price_amount=price,
                currency="USD",
                price_scope="party_total",
                per_traveler_amount=price / 2,
                per_traveler_is_calculated=True,
                party_total_amount=price,
                market="us",
                airlines=["Philippine Airlines"],
                outbound_date=datetime(2026, 9, 30).date(),
                observed_at=T0 + timedelta(microseconds=obs_id),
                eligible=True,
                is_best_of_run=obs_id in (1, 3),
            )
        )
    session.flush()

    session.add(
        AlertEvent(
            id=1,
            tracker_id=1,
            config_version_id=1,
            observation_id=1,
            alert_type="threshold",
            dedupe_key="dedupe-1",
            message_text="Fare hit 1,962.00 — that's below your threshold",
            delivery_state="delivered",
            attempts=1,
            created_at=T0,
            delivered_at=T0,
        )
    )
    session.add(
        ProviderUsage(
            id=1, provider="serpapi", period="2026-08", local_searches=2, last_synced_at=T0
        )
    )
    session.add(
        ProviderCall(
            id=1, provider="serpapi", endpoint="google_flights", called_at=T0, search_run_id=1
        )
    )
    session.add(
        ProviderCall(
            id=2, provider="serpapi", endpoint="google_flights", called_at=T0, search_run_id=2
        )
    )
    session.add(AppSetting(key="telegram_chat_id", value="1234567890", updated_at=T0))
    session.add(AppSetting(key="price_scope_ack", value=True, updated_at=T0))
    session.add(
        QueryCacheEntry(
            id=1,
            fingerprint="qfp-1",
            endpoint="google_flights",
            payload={"cached": True},
            created_at=T0,
            expires_at=T0 + timedelta(minutes=15),
        )
    )
    session.add(
        SchedulerState(id=1, lock_owner="TrixBot:2273972:d172156a", started_at=T0, tick_count=31)
    )
    session.commit()


@pytest.fixture()
def source_db(tmp_path: Path) -> Path:
    path = tmp_path / "flightnotify.db"
    engine = create_engine(f"sqlite:///{path}")
    try:
        Base.metadata.create_all(engine)
        with Session(engine) as session:
            _seed(session)
    finally:
        engine.dispose()
    return path


def run(*args: str) -> int:
    return cli.main(["export-d1", *args])


def export(source: Path, output: Path, *extra: str) -> int:
    return run(
        "--source", str(source), "--write", "--output", str(output), "--allow-unsafe-source", *extra
    )


def fingerprint(path: Path) -> tuple[float, int, str]:
    stat = path.stat()
    return (stat.st_mtime, stat.st_size, sha256(path.read_bytes()).hexdigest())


# ------------------------------------------------------------------- money
def test_money_conversion_is_exact_through_decimal():
    assert to_cents(Decimal("1962.00")) == 196200
    assert to_cents(Decimal("0.00")) == 0
    assert to_cents(Decimal("0.01")) == 1
    assert to_cents(Decimal("99999999.99")) == 9999999999
    # SQLite's NUMERIC affinity hands back int and float, not Decimal.
    assert to_cents(1962) == 196200
    assert to_cents(1024.5) == 102450
    assert to_cents("1024.50") == 102450


def test_money_conversion_beats_naive_float_arithmetic():
    """The exact case the _cents rename exists to prevent."""
    assert int(1.15 * 100) == 114  # what a float round-trip would store
    assert to_cents(1.15) == 115
    assert to_cents(Decimal("1.15")) == 115
    assert int(0.29 * 100) == 28
    assert to_cents(0.29) == 29
    assert to_cents(Decimal("1024.55")) == 102455


@pytest.mark.parametrize(
    ("amount", "cents"),
    [
        (Decimal("1024.50"), 102450),
        (Decimal("0.50"), 50),
        (Decimal("10.05"), 1005),
        # Sub-cent halves round away from zero, deterministically.
        (Decimal("0.005"), 1),
        (Decimal("10.125"), 1013),
        (Decimal("10.135"), 1014),
    ],
)
def test_half_unit_cases_are_deterministic(amount, cents):
    assert to_cents(amount) == cents


def test_percentages_become_hundredths_of_a_percent():
    assert to_basis_points(Decimal("7.50")) == 750
    assert to_basis_points(Decimal("100.00")) == 10000
    assert to_basis_points(Decimal("0.01")) == 1


# --------------------------------------------------------------- timestamps
@pytest.mark.parametrize(
    ("stored", "emitted"),
    [
        ("2026-08-02 22:16:59.516031", "2026-08-02T22:16:59.516Z"),
        ("2026-08-02 22:16:59.500000", "2026-08-02T22:16:59.500Z"),
        ("2026-08-02 22:16:59.5", "2026-08-02T22:16:59.500Z"),
        ("2026-08-02 22:16:59.000009", "2026-08-02T22:16:59.000Z"),
        ("2026-08-02 22:16:59", "2026-08-02T22:16:59.000Z"),
        ("2026-08-02T22:16:59.516031", "2026-08-02T22:16:59.516Z"),
    ],
)
def test_timestamp_conversion(stored, emitted):
    assert to_iso_millis(stored) == emitted
    assert ISO_MILLIS_PATTERN.match(to_iso_millis(stored))


def test_microseconds_are_truncated_never_rounded():
    """Rounding .999999 up would carry into the next second and reorder rows."""
    assert to_iso_millis("2026-08-02 22:16:59.999999") == "2026-08-02T22:16:59.999Z"
    assert to_iso_millis("2026-08-02 22:16:59.516999") == "2026-08-02T22:16:59.516Z"


def test_timestamps_are_uniform_width_so_text_ordering_is_chronological():
    early = to_iso_millis("2026-08-02 22:16:59.5")
    late = to_iso_millis("2026-08-02 22:16:59.516031")
    assert len(early) == len(late)
    assert early < late


def test_unparseable_timestamp_is_refused():
    with pytest.raises(ValueError, match="unparseable timestamp"):
        to_iso_millis("yesterday")


def test_every_emitted_timestamp_matches_the_d1_format(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    literals = re.findall(r"'(\d{4}-\d{2}-\d{2}[T ][^']*)'", output.read_text())
    assert literals
    for literal in literals:
        assert ISO_MILLIS_PATTERN.match(literal), literal


# ------------------------------------------------------------ source safety
def test_source_is_required_and_never_guessed(capsys):
    assert run() == cli.EXIT_CONFIG
    error = capsys.readouterr().err
    assert "--source is required" in error
    assert "never guesses" in error


def test_a_missing_file_is_refused(tmp_path, capsys):
    assert run("--source", str(tmp_path / "nope.db"), "--allow-unsafe-source") == cli.EXIT_CONFIG
    assert "no database file at" in capsys.readouterr().err


def test_a_non_sqlite_file_is_refused(tmp_path, capsys):
    decoy = tmp_path / "notes.db"
    decoy.write_text("this is not a database")
    assert run("--source", str(decoy), "--allow-unsafe-source") == cli.EXIT_CONFIG
    assert "is not a SQLite database" in capsys.readouterr().err


def test_a_scratch_path_is_refused_without_the_override(source_db, capsys):
    assert run("--source", str(source_db)) == cli.EXIT_CONFIG
    error = capsys.readouterr().err
    assert "refusing" in error
    assert "scratch space" in error
    assert "--allow-unsafe-source" in error


@pytest.mark.parametrize("word", ["stub", "test", "fixture", "step8"])
def test_a_suspicious_name_is_refused_without_the_override(source_db, tmp_path, capsys, word):
    suspicious = tmp_path / f"{word}-copy.db"
    suspicious.write_bytes(source_db.read_bytes())
    assert run("--source", str(suspicious)) == cli.EXIT_CONFIG
    error = capsys.readouterr().err
    assert f"'{word}'" in error
    assert "fixture or a scratch copy" in error


def test_the_override_prints_a_loud_warning(source_db, capsys):
    assert run("--source", str(source_db), "--allow-unsafe-source") == cli.EXIT_OK
    assert (
        "WARNING: --allow-unsafe-source accepted a suspicious source path."
        in capsys.readouterr().err
    )


def test_write_and_dry_run_together_are_refused(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output, "--dry-run") == cli.EXIT_CONFIG
    assert "contradict" in capsys.readouterr().err
    assert not output.exists()


def test_write_without_an_output_is_refused(source_db, capsys):
    assert run("--source", str(source_db), "--write", "--allow-unsafe-source") == cli.EXIT_CONFIG
    assert "--write needs --output" in capsys.readouterr().err


# ------------------------------------------------------------------ dry run
def test_dry_run_is_the_default_and_writes_nothing(source_db, tmp_path, capsys):
    output = tmp_path / "must-not-appear.sql"
    before = sorted(p.name for p in tmp_path.iterdir())

    assert run("--source", str(source_db), "--output", str(output), "--allow-unsafe-source") == 0

    out = capsys.readouterr().out
    assert "DRY RUN - nothing was written" in out
    assert not output.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == before
    assert "Nothing was written." in out


def test_dry_run_summarises_counts_names_ranges_and_money(source_db, capsys):
    assert run("--source", str(source_db), "--allow-unsafe-source") == cli.EXIT_OK
    out = capsys.readouterr().out

    assert "trackers                       2 row(s)" in out
    assert "fare_observations              3 row(s)" in out
    assert "TOTAL" in out
    assert "Tokyo autumn" in out and "O'Hare escape" in out
    assert "2026-08-02 … 2026-08-02" in out
    # 1962.00 + 1024.50 + 1024.55
    assert "401105" in out and "4,011.05" in out
    assert "Row contents are not printed" in out


def test_dry_run_does_not_print_row_contents(source_db, capsys):
    """The summary is aggregate-only: nothing quotable leaks into a ticket."""
    assert run("--source", str(source_db), "--allow-unsafe-source") == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "1234567890" not in out  # the excluded Telegram chat id
    assert "below your threshold" not in out  # alert message text
    assert "itin-1" not in out  # itinerary fingerprints


# --------------------------------------------------------------- exclusions
def test_excluded_tables_and_rows_never_reach_the_sql(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    sql = output.read_text()
    out = capsys.readouterr().out
    statements = sql.split("BEGIN TRANSACTION;", 1)[1]

    assert 'INSERT INTO "query_cache"' not in sql
    assert 'INSERT INTO "scheduler_state"' not in sql
    assert "telegram_chat_id" not in statements  # named only in the header's exclusion note
    assert "1234567890" not in sql
    # ...but the non-secret app setting still migrates.
    assert 'INSERT INTO "app_settings"' in sql
    assert "price_scope_ack" in sql

    for expected in (
        "table query_cache - ephemeral provider cache",
        "table scheduler_state - stale single-process lease",
        "app_settings row 'telegram_chat_id' - becomes a Cloudflare secret",
    ):
        assert expected in out
        assert expected in sql


def test_excluding_a_tracker_removes_everything_that_references_it(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output, "--exclude-tracker", "2") == cli.EXIT_OK
    sql = output.read_text()
    out = capsys.readouterr().out

    assert "O'Hare escape" not in sql
    assert "qfp-2" not in sql  # its search run
    assert "itin-3" not in sql  # its observation
    assert "fp-2" not in sql  # its config version
    assert "Tokyo autumn" in sql
    assert "tracker 2 and every row referencing it" in out

    counts = json.loads((tmp_path / "out.sql.counts.json").read_text())["tables"]
    assert counts == {
        "trackers": 1,
        "tracker_config_versions": 1,
        "tracker_markets": 1,
        "flexible_date_candidates": 1,
        "search_runs": 1,
        "fare_observations": 2,
        "alert_events": 1,
        "provider_usage": 1,
        "provider_calls": 2,
        "app_settings": 1,
    }


def test_a_reference_stranded_by_an_exclusion_is_nulled_and_reported(source_db, tmp_path, capsys):
    """provider_calls.search_run_id pointed at the excluded tracker's run."""
    output = tmp_path / "out.sql"
    assert export(source_db, output, "--exclude-tracker", "2") == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "provider_calls.search_run_id -> search_runs: 1 dangling reference(s) set to NULL" in out


# ----------------------------------------------------------------- emission
def test_tables_are_emitted_in_foreign_key_order(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    sql = output.read_text()

    order = [
        "trackers",
        "tracker_config_versions",
        "tracker_markets",
        "flexible_date_candidates",
        "search_runs",
        "fare_observations",
        "alert_events",
        "provider_usage",
        "provider_calls",
        "app_settings",
    ]
    positions = [sql.index(f'INSERT INTO "{name}" (') for name in order]
    assert positions == sorted(positions)
    assert sql.index("BEGIN TRANSACTION;") < positions[0]
    assert sql.rindex("COMMIT;") > positions[-1]


def test_the_export_uses_explicit_column_lists_and_the_renamed_money_columns(
    source_db, tmp_path, capsys
):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    sql = output.read_text()

    assert '"threshold_amount_cents"' in sql
    assert '"min_drop_percent_bp"' in sql
    assert '"price_amount_cents"' in sql
    assert '"last_price_cents"' in sql
    assert '"threshold_amount"' not in sql
    assert '"price_amount"' not in sql
    assert re.search(r'INSERT INTO "trackers" \("id", "name", "status",', sql)


def test_primary_keys_and_relationships_are_preserved_verbatim(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    loaded = _load_into_d1_schema(output.read_text())
    try:
        assert [row[0] for row in loaded.execute("SELECT id FROM trackers ORDER BY id")] == [1, 2]
        assert loaded.execute(
            "SELECT tracker_id, search_run_id, config_version_id FROM fare_observations WHERE id = 3"
        ).fetchone() == (2, 2, 2)
        assert loaded.execute(
            "SELECT tracker_id, observation_id FROM alert_events WHERE id = 1"
        ).fetchone() == (1, 1)
    finally:
        loaded.close()


def test_single_quotes_in_user_data_are_escaped(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    assert "'O''Hare escape'" in output.read_text()

    loaded = _load_into_d1_schema(output.read_text())
    try:
        assert loaded.execute("SELECT name FROM trackers WHERE id = 2").fetchone()[0] == (
            "O'Hare escape"
        )
    finally:
        loaded.close()


def test_null_values_are_emitted_as_null(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    loaded = _load_into_d1_schema(output.read_text())
    try:
        row = loaded.execute(
            "SELECT min_drop_absolute_cents, min_drop_percent_bp FROM trackers WHERE id = 2"
        ).fetchone()
        assert row == (None, None)
    finally:
        loaded.close()


def _load_into_d1_schema(sql: str) -> sqlite3.Connection:
    """Run the export against the real D1 schema, with foreign keys enforced."""
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(D1_SCHEMA.read_text(encoding="utf-8"))
    connection.executescript(sql)
    return connection


def test_the_export_loads_into_the_real_d1_schema(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()
    loaded = _load_into_d1_schema(output.read_text())
    try:
        assert loaded.execute("PRAGMA foreign_key_check").fetchall() == []
        assert loaded.execute("SELECT COUNT(*) FROM fare_observations").fetchone()[0] == 3
        assert loaded.execute(
            "SELECT threshold_amount_cents, min_drop_percent_bp FROM trackers WHERE id = 1"
        ).fetchone() == (196200, 750)
        assert loaded.execute(
            "SELECT price_amount_cents FROM fare_observations ORDER BY id"
        ).fetchall() == [(196200,), (102450,), (102455,)]
        assert loaded.execute("SELECT created_at FROM trackers WHERE id = 1").fetchone()[0] == (
            "2026-08-02T22:16:59.516Z"
        )
        # Booleans landed as 0/1, dates stayed plain dates, JSON stayed TEXT.
        assert loaded.execute(
            "SELECT alert_on_threshold FROM trackers WHERE id = 1"
        ).fetchone() == (1,)
        assert loaded.execute("SELECT outbound_date FROM trackers WHERE id = 1").fetchone() == (
            "2026-09-30",
        )
        assert json.loads(
            loaded.execute("SELECT airlines FROM fare_observations WHERE id = 1").fetchone()[0]
        ) == ["Philippine Airlines"]
    finally:
        loaded.close()


# ------------------------------------------------------------ source safety
def test_the_source_database_is_never_modified(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    before = fingerprint(source_db)

    assert run("--source", str(source_db), "--allow-unsafe-source") == cli.EXIT_OK
    assert fingerprint(source_db) == before

    assert export(source_db, output) == cli.EXIT_OK
    assert fingerprint(source_db) == before

    assert (
        run(
            "--source",
            str(source_db),
            "--allow-unsafe-source",
            "--verify",
            "--expect-json",
            str(tmp_path / "out.sql.counts.json"),
        )
        == cli.EXIT_OK
    )
    assert fingerprint(source_db) == before
    capsys.readouterr()


def test_the_source_is_opened_read_only(source_db):
    connection = d1_export.open_readonly(source_db)
    try:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("DELETE FROM trackers")
    finally:
        connection.close()


# --------------------------------------------------------- schema validation
def test_a_missing_column_aborts_before_anything_is_exported(source_db, tmp_path, capsys):
    connection = sqlite3.connect(source_db)
    try:
        connection.execute("ALTER TABLE trackers DROP COLUMN low_price")
        connection.commit()
    finally:
        connection.close()

    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_CONFIG
    error = capsys.readouterr().err
    assert "does not match the expected 12-table schema" in error
    assert "trackers: missing column(s): low_price" in error
    assert not output.exists()


def test_a_missing_table_aborts_with_a_precise_message(source_db, tmp_path, capsys):
    connection = sqlite3.connect(source_db)
    try:
        connection.execute("DROP TABLE query_cache")
        connection.commit()
    finally:
        connection.close()

    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_CONFIG
    assert "missing table(s): query_cache" in capsys.readouterr().err
    assert not output.exists()


def test_an_unexpected_table_aborts_rather_than_silently_leaving_data_behind(
    source_db, tmp_path, capsys
):
    connection = sqlite3.connect(source_db)
    try:
        connection.execute("CREATE TABLE loyalty_numbers (id INTEGER PRIMARY KEY)")
        connection.commit()
    finally:
        connection.close()

    assert export(source_db, tmp_path / "out.sql") == cli.EXIT_CONFIG
    assert "unexpected table(s): loyalty_numbers" in capsys.readouterr().err


def test_the_alembic_bookkeeping_table_is_tolerated(source_db, tmp_path, capsys):
    connection = sqlite3.connect(source_db)
    try:
        connection.execute("CREATE TABLE alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        connection.commit()
    finally:
        connection.close()

    assert export(source_db, tmp_path / "out.sql") == cli.EXIT_OK
    capsys.readouterr()


def test_the_export_mapping_covers_every_model_table():
    """The mapping must not drift away from models.py unnoticed."""
    assert d1_export._spec_problems() == []
    assert len(d1_export.expected_schema()) == d1_export.EXPECTED_TABLE_COUNT
    assert set(d1_export.TABLES_BY_NAME) | set(d1_export.EXCLUDED_TABLES) == set(
        d1_export.expected_schema()
    )


# ------------------------------------------------------------------- verify
def test_verify_accepts_a_matching_source(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()

    code = run(
        "--source",
        str(source_db),
        "--allow-unsafe-source",
        "--verify",
        "--expect-json",
        str(tmp_path / "out.sql.counts.json"),
    )
    out = capsys.readouterr().out
    assert code == cli.EXIT_OK
    assert "Verification passed" in out
    assert "fare_observations             expected      3   source      3   ok" in out
    assert "fare_observations.tracker_id → trackers" in out


def test_verify_detects_a_count_that_moved(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()

    manifest_path = tmp_path / "out.sql.counts.json"
    payload = json.loads(manifest_path.read_text())
    payload["tables"]["fare_observations"] = 99
    manifest_path.write_text(json.dumps(payload))

    code = run(
        "--source",
        str(source_db),
        "--allow-unsafe-source",
        "--verify",
        "--expect-json",
        str(manifest_path),
    )
    captured = capsys.readouterr()
    assert code == cli.EXIT_ERRORS
    assert "MISMATCH" in captured.out
    assert "fare_observations: manifest says 99, source has 3" in captured.err


def test_verify_reports_orphans_in_the_source(source_db, tmp_path, capsys):
    output = tmp_path / "out.sql"
    assert export(source_db, output) == cli.EXIT_OK
    capsys.readouterr()

    connection = sqlite3.connect(source_db)
    try:
        connection.execute("UPDATE fare_observations SET tracker_id = 404 WHERE id = 3")
        connection.commit()
    finally:
        connection.close()

    code = run(
        "--source",
        str(source_db),
        "--allow-unsafe-source",
        "--verify",
        "--expect-json",
        str(tmp_path / "out.sql.counts.json"),
    )
    captured = capsys.readouterr()
    assert code == cli.EXIT_ERRORS
    assert "ORPHAN(S)" in captured.out
    assert "fare_observations.tracker_id → trackers: 1 orphan(s)" in captured.err


def test_verify_needs_a_manifest(source_db, capsys):
    assert run("--source", str(source_db), "--allow-unsafe-source", "--verify") == cli.EXIT_CONFIG
    assert "--verify needs --expect-json" in capsys.readouterr().err


# ---------------------------------------------------------------------- CLI
def test_the_subcommand_is_registered():
    parser = cli.build_parser()
    action = next(a for a in parser._subparsers._group_actions if a.choices)
    assert "export-d1" in action.choices
