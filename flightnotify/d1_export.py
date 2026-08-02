"""Export the local SQLite database as Cloudflare D1 SQL.

This is a one-way, read-only migration aid: it opens the source database
``mode=ro`` and never writes to it. Everything it knows about the target lives
in :data:`TABLES`, which mirrors ``worker/migrations/0001_initial_schema.sql``.

Three representation changes are made on the way out, matching that schema:

* money ``Numeric(12, 2)`` becomes ``INTEGER`` minor units and the column gains
  a ``_cents`` suffix. The conversion goes through :class:`~decimal.Decimal`,
  never a float, so ``1962.00`` is exactly ``196200``;
* ``min_drop_percent`` ``Numeric(5, 2)`` becomes ``min_drop_percent_bp``,
  hundredths of a percent, by the same exact route;
* timestamps become ``YYYY-MM-DDTHH:MM:SS.sssZ`` with exactly three fractional
  digits (microseconds are truncated, never rounded). The uniform width is
  load-bearing: D1 indexes these as TEXT, so lexicographic order must equal
  chronological order. Every emitted timestamp is re-checked against
  :data:`ISO_MILLIS_PATTERN` before it reaches the file.

Booleans become ``INTEGER`` 0/1, dates stay ``YYYY-MM-DD`` TEXT, and JSON
columns are copied verbatim as TEXT.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .models import Base

# The same codes flightnotify.cli uses; duplicated to keep this module free of
# a circular import back into the command line.
EXIT_OK = 0
EXIT_ERRORS = 1
EXIT_CONFIG = 2

#: Every timestamp written into the D1 dump must match this exactly.
ISO_MILLIS_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: What SQLite actually stores for a ``UtcDateTime``: naive UTC, optional
#: fractional part, either a space or a ``T`` between date and clock.
_SOURCE_TIMESTAMP = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$",
)

#: A source path containing any of these is refused without
#: ``--allow-unsafe-source``: it is far more likely to be a fixture or a
#: half-finished scratch copy than the database anyone means to migrate.
SUSPICIOUS_SUBSTRINGS = ("stub", "test", "fixture", "step8")
SUSPICIOUS_ROOTS = ("/tmp", "/var/tmp", "/dev/shm")

#: Present in a migrated database but owned by Alembic, not by the models.
ALLOWED_EXTRA_TABLES = frozenset({"alembic_version"})

#: Tables that are deliberately not migrated, and why.
EXCLUDED_TABLES: dict[str, str] = {
    "scheduler_state": ("stale single-process lease; the Worker mints its own on first Cron tick"),
    "query_cache": "ephemeral provider cache, TTL-expired long before the cutover",
}

#: app_settings rows that are deliberately not migrated, and why.
EXCLUDED_SETTING_KEYS: dict[str, str] = {
    "telegram_chat_id": "becomes a Cloudflare secret; a second source of truth would drift",
}

EXPECTED_TABLE_COUNT = 12

VERBATIM = "verbatim"
DATE = "date"
TIMESTAMP = "timestamp"
BOOLEAN = "boolean"
MONEY = "money"
PERCENT = "percent"


class ExportError(RuntimeError):
    """The export cannot proceed; the message is meant for the operator."""


# ------------------------------------------------------------------ mapping
@dataclass(frozen=True)
class Column:
    source: str
    target: str
    kind: str


@dataclass(frozen=True)
class Reference:
    """A parent row this column points at.

    ``enforced`` marks the references the D1 schema declares as real foreign
    keys. The rest are plain integers (the models keep them un-constrained to
    avoid FK cycles); a dangling one is repaired to NULL and reported rather
    than aborting the export.
    """

    column: str
    parent: str
    required: bool
    enforced: bool = True


@dataclass(frozen=True)
class TableSpec:
    name: str
    columns: tuple[Column, ...]
    #: Column holding the owning tracker id, for ``--exclude-tracker``.
    tracker_column: str | None = None
    references: tuple[Reference, ...] = ()
    key: str = "id"
    #: Target timestamp column summarised as a date range in the dry run.
    range_column: str | None = None

    @property
    def source_columns(self) -> tuple[str, ...]:
        return tuple(column.source for column in self.columns)

    @property
    def target_columns(self) -> tuple[str, ...]:
        return tuple(column.target for column in self.columns)


def _keep(name: str) -> Column:
    return Column(name, name, VERBATIM)


def _date(name: str) -> Column:
    return Column(name, name, DATE)


def _ts(name: str) -> Column:
    return Column(name, name, TIMESTAMP)


def _flag(name: str) -> Column:
    return Column(name, name, BOOLEAN)


def _cents(name: str) -> Column:
    return Column(name, f"{name}_cents", MONEY)


def _bp(name: str) -> Column:
    return Column(name, f"{name}_bp", PERCENT)


#: Emission order is foreign-key order: a parent is always inserted before any
#: row that references it, so the dump loads into a schema with FKs on.
TABLES: tuple[TableSpec, ...] = (
    TableSpec(
        name="trackers",
        tracker_column="id",
        range_column="created_at",
        references=(
            Reference("current_config_version_id", "tracker_config_versions", False, False),
            Reference("latest_observation_id", "fare_observations", False, False),
            Reference("low_observation_id", "fare_observations", False, False),
        ),
        columns=(
            _keep("id"),
            _keep("name"),
            _keep("status"),
            _keep("origin"),
            _keep("destination"),
            _keep("adults"),
            _keep("children"),
            _keep("infants_in_seat"),
            _keep("infants_on_lap"),
            _keep("cabin"),
            _keep("stops"),
            _keep("include_airlines"),
            _keep("exclude_airlines"),
            _keep("date_mode"),
            _date("outbound_date"),
            _date("return_date"),
            _keep("flex_month"),
            _keep("flex_year"),
            _keep("flex_duration"),
            _date("window_outbound_start"),
            _date("window_outbound_end"),
            _date("window_return_start"),
            _date("window_return_end"),
            _keep("min_nights"),
            _keep("max_nights"),
            _keep("currency"),
            _cents("threshold_amount"),
            _keep("threshold_basis"),
            _flag("alert_on_threshold"),
            _flag("alert_on_new_low"),
            _cents("min_drop_absolute"),
            _bp("min_drop_percent"),
            _keep("cooldown_minutes"),
            _keep("check_interval_minutes"),
            _keep("candidates_per_run"),
            _flag("sampled_mode_ack"),
            _ts("next_run_at"),
            _ts("last_attempt_at"),
            _ts("last_success_at"),
            _keep("consecutive_failures"),
            _keep("lock_owner"),
            _ts("lock_expires_at"),
            _keep("current_config_version_id"),
            _ts("series_started_at"),
            _cents("latest_price"),
            _keep("latest_observation_id"),
            _ts("latest_observed_at"),
            _cents("low_price"),
            _keep("low_observation_id"),
            _ts("low_observed_at"),
            _flag("last_threshold_met"),
            _keep("coverage_cycle"),
            _keep("last_error_category"),
            _keep("last_error_message"),
            _ts("created_at"),
            _ts("updated_at"),
        ),
    ),
    TableSpec(
        name="tracker_config_versions",
        tracker_column="tracker_id",
        range_column="created_at",
        references=(Reference("tracker_id", "trackers", True),),
        columns=(
            _keep("id"),
            _keep("tracker_id"),
            _keep("version"),
            _keep("fingerprint"),
            _keep("payload"),
            _ts("effective_from"),
            _ts("effective_to"),
            _ts("created_at"),
        ),
    ),
    TableSpec(
        name="tracker_markets",
        tracker_column="tracker_id",
        references=(Reference("tracker_id", "trackers", True),),
        columns=(
            _keep("id"),
            _keep("tracker_id"),
            _keep("market"),
            _keep("priority"),
        ),
    ),
    TableSpec(
        name="flexible_date_candidates",
        tracker_column="tracker_id",
        range_column="last_checked_at",
        references=(
            Reference("tracker_id", "trackers", True),
            Reference("config_version_id", "tracker_config_versions", True),
            Reference("last_run_id", "search_runs", False, False),
        ),
        columns=(
            _keep("id"),
            _keep("tracker_id"),
            _keep("config_version_id"),
            _date("outbound_date"),
            _date("return_date"),
            _keep("nights"),
            _keep("order_index"),
            _keep("cycle"),
            _keep("status"),
            _ts("last_checked_at"),
            _keep("last_run_id"),
            _keep("check_count"),
            _cents("last_price"),
        ),
    ),
    TableSpec(
        name="search_runs",
        tracker_column="tracker_id",
        range_column="started_at",
        references=(
            Reference("tracker_id", "trackers", True),
            Reference("config_version_id", "tracker_config_versions", False),
            Reference("best_observation_id", "fare_observations", False, False),
        ),
        columns=(
            _keep("id"),
            _keep("tracker_id"),
            _keep("config_version_id"),
            _keep("batch_id"),
            _keep("trigger"),
            _keep("endpoint"),
            _keep("market"),
            _keep("currency"),
            _date("outbound_date"),
            _date("return_date"),
            _keep("query_fingerprint"),
            _ts("started_at"),
            _ts("completed_at"),
            _keep("status"),
            _keep("provider_request_count"),
            _keep("cache_status"),
            _keep("coverage_cycle"),
            _keep("coverage_state"),
            _keep("coverage_checked"),
            _keep("coverage_total"),
            _keep("offers_found"),
            _keep("best_observation_id"),
            _keep("error_category"),
            _keep("error_message"),
            _keep("skip_reason"),
            _keep("raw_excerpt"),
        ),
    ),
    TableSpec(
        name="fare_observations",
        tracker_column="tracker_id",
        range_column="observed_at",
        references=(
            Reference("search_run_id", "search_runs", True),
            Reference("tracker_id", "trackers", True),
            Reference("config_version_id", "tracker_config_versions", False),
        ),
        columns=(
            _keep("id"),
            _keep("search_run_id"),
            _keep("tracker_id"),
            _keep("config_version_id"),
            _keep("itinerary_fingerprint"),
            _cents("price_amount"),
            _keep("currency"),
            _keep("price_scope"),
            _cents("per_traveler_amount"),
            _flag("per_traveler_is_calculated"),
            _cents("party_total_amount"),
            _flag("party_total_is_calculated"),
            _keep("origin"),
            _keep("destination"),
            _date("outbound_date"),
            _date("return_date"),
            _keep("departure_time"),
            _keep("arrival_time"),
            _keep("airlines"),
            _keep("flight_numbers"),
            _keep("stops"),
            _keep("duration_minutes"),
            _keep("cabin"),
            _keep("segments"),
            _keep("layovers"),
            _keep("booking_link"),
            _keep("search_link"),
            _keep("market"),
            _ts("observed_at"),
            _flag("eligible"),
            _keep("exclusion_reason"),
            _flag("is_best_of_run"),
        ),
    ),
    TableSpec(
        name="alert_events",
        tracker_column="tracker_id",
        range_column="created_at",
        references=(
            Reference("tracker_id", "trackers", False),
            Reference("config_version_id", "tracker_config_versions", False),
            Reference("observation_id", "fare_observations", False),
        ),
        columns=(
            _keep("id"),
            _keep("tracker_id"),
            _keep("config_version_id"),
            _keep("observation_id"),
            _keep("alert_type"),
            _keep("dedupe_key"),
            _keep("message_text"),
            _keep("delivery_state"),
            _keep("attempts"),
            _keep("last_error"),
            _keep("telegram_message_id"),
            _keep("response_meta"),
            _ts("created_at"),
            _ts("delivered_at"),
        ),
    ),
    # --- standalone: no tracker ownership, no foreign keys ------------------
    TableSpec(
        name="provider_usage",
        range_column="last_synced_at",
        columns=(
            _keep("id"),
            _keep("provider"),
            _keep("period"),
            _keep("local_searches"),
            _keep("provider_searches_per_month"),
            _keep("provider_searches_left"),
            _keep("provider_this_month_usage"),
            _keep("provider_plan_name"),
            _keep("provider_account_email_masked"),
            _keep("provider_rate_limit_per_hour"),
            _ts("last_synced_at"),
            _keep("last_sync_error"),
        ),
    ),
    TableSpec(
        name="provider_calls",
        range_column="called_at",
        references=(Reference("search_run_id", "search_runs", False, False),),
        columns=(
            _keep("id"),
            _keep("provider"),
            _keep("endpoint"),
            _ts("called_at"),
            _keep("search_run_id"),
        ),
    ),
    TableSpec(
        name="app_settings",
        key="key",
        range_column="updated_at",
        columns=(
            _keep("key"),
            _keep("value"),
            _ts("updated_at"),
        ),
    ),
)

TABLES_BY_NAME = {spec.name: spec for spec in TABLES}


# -------------------------------------------------------------- conversions
def _as_decimal(value: object) -> Decimal:
    """Read a stored money value as an exact :class:`Decimal`.

    SQLite's NUMERIC affinity stores ``1962.00`` as the integer ``1962`` and
    ``1024.50`` as a C double, so the raw value can arrive as ``int``,
    ``float`` or ``str``. ``str(float)`` is the shortest representation that
    round-trips, which recovers the decimal the application meant;
    ``Decimal(float)`` would carry the binary error into the result.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise TypeError(f"cannot read {value!r} as a money amount")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except InvalidOperation as exc:
            raise ValueError(f"cannot read {value!r} as a money amount") from exc
    raise TypeError(f"cannot read {value!r} ({type(value).__name__}) as a money amount")


def _scaled(value: object) -> int:
    amount = _as_decimal(value)
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def to_cents(value: object) -> int:
    """``Decimal('1962.00')`` -> ``196200``. Exact; half-units round away from zero."""
    return _scaled(value)


def to_basis_points(value: object) -> int:
    """``Decimal('7.50')`` percent -> ``750`` hundredths of a percent."""
    return _scaled(value)


def to_iso_millis(value: object) -> str:
    """Naive-UTC SQLite text -> ``YYYY-MM-DDTHH:MM:SS.sssZ``.

    Microseconds are truncated rather than rounded: rounding could carry a
    value into the next second and reorder two observations recorded within the
    same millisecond.
    """
    if isinstance(value, datetime):
        moment = value.astimezone(UTC) if value.tzinfo is not None else value
        text = f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"
    else:
        match = _SOURCE_TIMESTAMP.match(str(value).strip())
        if match is None:
            raise ValueError(f"unparseable timestamp {value!r}")
        day, clock, fraction = match.groups()
        millis = (fraction or "").ljust(6, "0")[:3]
        text = f"{day}T{clock}.{millis}Z"
    if not ISO_MILLIS_PATTERN.match(text):  # pragma: no cover - defensive
        raise ValueError(f"produced a non-conforming timestamp {text!r} from {value!r}")
    return text


def to_iso_date(value: object) -> str:
    text = str(value).strip()[:10]
    if not DATE_PATTERN.match(text):
        raise ValueError(f"unparseable date {value!r}")
    return text


def convert(column: Column, value: object) -> object:
    if value is None:
        return None
    if column.kind == MONEY:
        return to_cents(value)
    if column.kind == PERCENT:
        return to_basis_points(value)
    if column.kind == TIMESTAMP:
        return to_iso_millis(value)
    if column.kind == DATE:
        return to_iso_date(value)
    if column.kind == BOOLEAN:
        return 1 if value else 0
    return value


# ----------------------------------------------------------- SQL rendering
def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def sql_literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"


# ------------------------------------------------------------ source safety
def resolve_source(raw: str | None, *, allow_unsafe: bool) -> Path:
    """Turn ``--source`` into a path, refusing anything ambiguous."""
    if not raw:
        raise ExportError(
            "--source is required: name the SQLite database to export explicitly. "
            "This command never guesses a database path."
        )
    path = Path(raw).expanduser()
    resolved = path.resolve()

    if not resolved.is_file():
        raise ExportError(f"no database file at {resolved}")
    with resolved.open("rb") as handle:
        if handle.read(16) != b"SQLite format 3\x00":
            raise ExportError(f"{resolved} is not a SQLite database")

    reasons: list[str] = []
    haystack = f"{path}\n{resolved}".lower()
    hits = [needle for needle in SUSPICIOUS_SUBSTRINGS if needle in haystack]
    if hits:
        reasons.append("the path contains " + ", ".join(repr(hit) for hit in hits))
    text = str(resolved)
    if any(text == root or text.startswith(root + "/") for root in SUSPICIOUS_ROOTS):
        reasons.append(f"it resolves under {resolved.parts[1]!r}, which is scratch space")

    if reasons and not allow_unsafe:
        raise ExportError(
            f"refusing {resolved}: " + "; and ".join(reasons) + ". "
            "That looks like a fixture or a scratch copy rather than the database you "
            "meant to migrate. Re-run with --allow-unsafe-source if it really is the one."
        )
    if reasons:
        print(
            "WARNING: --allow-unsafe-source accepted a suspicious source path.\n"
            f"WARNING:   {resolved}\n"
            f"WARNING:   {'; and '.join(reasons)}.\n"
            "WARNING: verify the row counts below before importing anything into D1.",
            file=sys.stderr,
        )
    return resolved


def open_readonly(path: Path) -> sqlite3.Connection:
    """Open the source strictly read-only. Nothing here may mutate it."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# -------------------------------------------------------- schema validation
def expected_schema() -> dict[str, tuple[str, ...]]:
    """The source schema the models define: table -> ordered column names."""
    return {
        table.name: tuple(column.name for column in table.columns)
        for table in Base.metadata.sorted_tables
    }


def _spec_problems() -> list[str]:
    """Guard against this module drifting away from the models."""
    expected = expected_schema()
    problems: list[str] = []
    covered = set(TABLES_BY_NAME) | set(EXCLUDED_TABLES)
    for name in sorted(set(expected) - covered):
        problems.append(f"{name}: no export mapping and not on the exclusion list")
    for spec in TABLES:
        model_columns = expected.get(spec.name)
        if model_columns is None:
            problems.append(f"{spec.name}: mapped for export but absent from the models")
            continue
        if spec.source_columns != model_columns:
            missing = [c for c in model_columns if c not in spec.source_columns]
            extra = [c for c in spec.source_columns if c not in model_columns]
            detail = []
            if missing:
                detail.append("unmapped " + ", ".join(missing))
            if extra:
                detail.append("unknown " + ", ".join(extra))
            problems.append(f"{spec.name}: mapping drifted from the models ({'; '.join(detail)})")
    return problems


def validate_source_schema(connection: sqlite3.Connection) -> list[str]:
    """Return every reason the source is not safe to export; empty means good."""
    problems = _spec_problems()
    expected = expected_schema()
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    actual = {row[0] for row in rows if not row[0].startswith("sqlite_")} - ALLOWED_EXTRA_TABLES

    missing = sorted(set(expected) - actual)
    unexpected = sorted(actual - set(expected))
    if missing:
        problems.append(f"missing table(s): {', '.join(missing)}")
    if unexpected:
        problems.append(
            f"unexpected table(s): {', '.join(unexpected)} - nothing here knows how to "
            "migrate them, so exporting would silently leave them behind"
        )

    for name in sorted(set(expected) & actual):
        found = [row[1] for row in connection.execute(f"PRAGMA table_info({quote_ident(name)})")]
        absent = [column for column in expected[name] if column not in found]
        extra = [column for column in found if column not in expected[name]]
        if absent:
            problems.append(f"{name}: missing column(s): {', '.join(absent)}")
        if extra:
            problems.append(f"{name}: unexpected column(s): {', '.join(extra)}")
    return problems


# ------------------------------------------------------------- row gathering
@dataclass
class TableExport:
    spec: TableSpec
    rows: list[dict[str, Any]] = field(default_factory=list)
    source_count: int = 0
    excluded_count: int = 0

    @property
    def name(self) -> str:
        return self.spec.name


@dataclass
class ExportResult:
    source: Path
    digest: str
    tables: list[TableExport]
    exclusions: list[str]
    excluded_trackers: list[int]
    repaired_references: list[str]

    @property
    def counts(self) -> dict[str, int]:
        return {table.name: len(table.rows) for table in self.tables}

    @property
    def total_rows(self) -> int:
        return sum(self.counts.values())

    def table(self, name: str) -> TableExport:
        return next(table for table in self.tables if table.name == name)


def _select(connection: sqlite3.Connection, spec: TableSpec) -> Iterator[sqlite3.Row]:
    columns = ", ".join(quote_ident(name) for name in spec.source_columns)
    order = quote_ident(spec.key)
    yield from connection.execute(
        f"SELECT {columns} FROM {quote_ident(spec.name)} ORDER BY {order}"
    )


def collect(connection: sqlite3.Connection, excluded_trackers: list[int]) -> ExportResult:
    """Read, convert and filter every migrated row."""
    excluded = set(excluded_trackers)
    exclusions = [f"table {name} - {why}" for name, why in sorted(EXCLUDED_TABLES.items())]
    for key, why in sorted(EXCLUDED_SETTING_KEYS.items()):
        exclusions.append(f"app_settings row {key!r} - {why}")

    tables: list[TableExport] = []
    for spec in TABLES:
        export = TableExport(spec=spec)
        for row in _select(connection, spec):
            export.source_count += 1
            if spec.tracker_column and row[spec.tracker_column] in excluded:
                export.excluded_count += 1
                continue
            if spec.name == "app_settings" and row["key"] in EXCLUDED_SETTING_KEYS:
                export.excluded_count += 1
                continue
            converted: dict[str, Any] = {}
            for column in spec.columns:
                try:
                    converted[column.target] = convert(column, row[column.source])
                except (TypeError, ValueError) as exc:
                    raise ExportError(
                        f"{spec.name}.{column.source} (row {row[spec.key]!r}): {exc}"
                    ) from exc
            export.rows.append(converted)
        tables.append(export)

    result = ExportResult(
        source=Path(),
        digest="",
        tables=tables,
        exclusions=exclusions,
        excluded_trackers=sorted(excluded),
        repaired_references=[],
    )
    if excluded:
        for tracker_id in sorted(excluded):
            result.exclusions.append(f"tracker {tracker_id} and every row referencing it")
    _resolve_references(result)
    return result


def _resolve_references(result: ExportResult) -> None:
    """Make sure every emitted reference still lands inside the emitted set.

    A ``--exclude-tracker`` can strand a row that pointed at the excluded
    tracker's data. An enforced foreign key must never dangle, so a required
    one aborts; a nullable one is set to NULL and reported. Un-enforced
    pointers (plain integers in the target schema) are repaired the same way,
    which also cleans up references the source had already orphaned.
    """
    present: dict[str, set[Any]] = {
        table.name: {row[table.spec.key] for row in table.rows} for table in result.tables
    }
    for table in result.tables:
        for reference in table.spec.references:
            known = present.get(reference.parent, set())
            dangling = 0
            for row in table.rows:
                value = row[reference.column]
                if value is None or value in known:
                    continue
                if reference.required and reference.enforced:
                    raise ExportError(
                        f"{table.name}.{reference.column} = {value!r} has no row in "
                        f"{reference.parent}; the export would violate a foreign key. "
                        "Widen --exclude-tracker or fix the source."
                    )
                row[reference.column] = None
                dangling += 1
            if dangling:
                result.repaired_references.append(
                    f"{table.name}.{reference.column} -> {reference.parent}: "
                    f"{dangling} dangling reference(s) set to NULL"
                )


# ---------------------------------------------------------------- rendering
def render_sql(result: ExportResult, *, generated_at: datetime | None = None) -> str:
    stamp = to_iso_millis(generated_at or datetime.now(UTC))
    lines = [
        "-- FlightNotify -> Cloudflare D1 data export.",
        "-- Generated by `flightnotify export-d1`; do not hand-edit.",
        f"-- generated_at : {stamp}",
        f"-- source       : {result.source}",
        f"-- source_sha256: {result.digest}",
        f"-- rows         : {result.total_rows} across {len(result.tables)} tables",
        "--",
        "-- Money is INTEGER minor units (_cents / _bp). Timestamps are",
        "-- YYYY-MM-DDTHH:MM:SS.sssZ. Booleans are 0/1. Ids are preserved verbatim.",
        "-- Tables are emitted in foreign-key order, so this loads with FKs on.",
        "--",
        "-- Excluded:",
    ]
    lines += [f"--   {item}" for item in result.exclusions]
    lines += [f"--   {item}" for item in result.repaired_references]
    lines += ["", "BEGIN TRANSACTION;"]

    for table in result.tables:
        lines.append("")
        lines.append(f"-- {table.name}: {len(table.rows)} row(s)")
        if not table.rows:
            lines.append("--   (nothing to insert)")
            continue
        columns = ", ".join(quote_ident(name) for name in table.spec.target_columns)
        prefix = f"INSERT INTO {quote_ident(table.name)} ({columns}) VALUES "
        for row in table.rows:
            values = ", ".join(sql_literal(row[name]) for name in table.spec.target_columns)
            lines.append(f"{prefix}({values});")

    lines += ["", "COMMIT;", ""]
    return "\n".join(lines)


def manifest(result: ExportResult, *, generated_at: datetime | None = None) -> dict[str, Any]:
    return {
        "generated_at": to_iso_millis(generated_at or datetime.now(UTC)),
        "source": str(result.source),
        "source_sha256": result.digest,
        "excluded_trackers": result.excluded_trackers,
        "excluded_tables": sorted(EXCLUDED_TABLES),
        "excluded_app_settings": sorted(EXCLUDED_SETTING_KEYS),
        "tables": result.counts,
    }


# ------------------------------------------------------------------ summary
def _money_totals(table: TableExport) -> list[tuple[str, int]]:
    totals: list[tuple[str, int]] = []
    for column in table.spec.columns:
        if column.kind != MONEY:
            continue
        total = sum(row[column.target] or 0 for row in table.rows)
        totals.append((f"{table.name}.{column.target}", int(total)))
    return totals


def _range(table: TableExport) -> str:
    column = table.spec.range_column
    if column is None:
        return "-"
    stamps = sorted(row[column] for row in table.rows if row[column] is not None)
    if not stamps:
        return "-"
    return f"{stamps[0][:10]} … {stamps[-1][:10]}"


def _format_money(cents: int) -> str:
    return f"{Decimal(cents) / 100:,.2f}"


def print_summary(result: ExportResult, *, dry_run: bool) -> None:
    heading = "DRY RUN - nothing was written" if dry_run else "export written"
    print(f"FlightNotify → Cloudflare D1 ({heading})")
    print(f"  source         : {result.source}")
    print(f"  sha256         : {result.digest}")
    print(f"  schema         : {EXPECTED_TABLE_COUNT}/{EXPECTED_TABLE_COUNT} tables validated")

    print("\nExcluded (never migrated):")
    for item in result.exclusions:
        print(f"  {item}")
    for item in result.repaired_references:
        print(f"  {item}")

    print("\nTables, in foreign-key order:")
    for table in result.tables:
        skipped = f"  ({table.excluded_count} excluded)" if table.excluded_count else ""
        print(f"  {table.name:<26}{len(table.rows):>6} row(s)   {_range(table):<26}{skipped}")
    print(f"  {'TOTAL':<26}{result.total_rows:>6} row(s)")

    print("\nMoney, converted through Decimal and emitted as integer minor units:")
    grand = 0
    for table in result.tables:
        for label, total in _money_totals(table):
            if total:
                print(f"  {label:<44}{total:>12} = {_format_money(total):>14}")
            grand += total
    observations = result.table("fare_observations")
    observed = sum(row["price_amount_cents"] for row in observations.rows)
    print(
        f"  {'fare value migrated (price_amount_cents)':<44}{observed:>12} = "
        f"{_format_money(observed):>14}"
    )
    print(f"  {'sum of every money column':<44}{grand:>12} = {_format_money(grand):>14}")

    trackers = result.table("trackers")
    print(f"\nTrackers ({len(trackers.rows)}):")
    for row in trackers.rows:
        print(
            f"  #{row['id']} {row['name']} [{row['status']}] "
            f"{row['origin']}→{row['destination']} "
            f"threshold {_format_money(row['threshold_amount_cents'])} {row['currency']}"
        )
    if not trackers.rows:
        print("  none")
    print(
        "\nRow contents are not printed: this summary is aggregate only, so it is safe "
        "to paste into a ticket."
    )


# ------------------------------------------------------------------- verify
def _integrity_problems(connection: sqlite3.Connection, excluded_trackers: list[int]) -> list[str]:
    """Report source rows whose foreign key points at nothing."""
    problems: list[str] = []
    for spec in TABLES:
        for reference in spec.references:
            if not reference.enforced:
                continue
            parent = TABLES_BY_NAME[reference.parent]
            sql = (
                f"SELECT COUNT(*) FROM {quote_ident(spec.name)} AS child "
                f"WHERE child.{quote_ident(reference.column)} IS NOT NULL "
                f"AND NOT EXISTS (SELECT 1 FROM {quote_ident(parent.name)} AS p "
                f"WHERE p.{quote_ident(parent.key)} = child.{quote_ident(reference.column)})"
            )
            orphans = int(connection.execute(sql).fetchone()[0])
            status = "ok" if orphans == 0 else f"{orphans} ORPHAN(S)"
            label = f"{spec.name}.{reference.column} → {reference.parent}"
            print(f"  {label:<58}{status}")
            if orphans:
                problems.append(f"{label}: {orphans} orphan(s)")
    if excluded_trackers:
        print(f"  (counts below ignore excluded trackers: {excluded_trackers})")
    return problems


def _filtered_counts(
    connection: sqlite3.Connection, excluded_trackers: list[int]
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for spec in TABLES:
        where: list[str] = []
        params: list[Any] = []
        if spec.tracker_column and excluded_trackers:
            placeholders = ", ".join("?" for _ in excluded_trackers)
            where.append(
                f"({quote_ident(spec.tracker_column)} IS NULL OR "
                f"{quote_ident(spec.tracker_column)} NOT IN ({placeholders}))"
            )
            params.extend(excluded_trackers)
        if spec.name == "app_settings":
            placeholders = ", ".join("?" for _ in EXCLUDED_SETTING_KEYS)
            where.append(f'"key" NOT IN ({placeholders})')
            params.extend(sorted(EXCLUDED_SETTING_KEYS))
        clause = f" WHERE {' AND '.join(where)}" if where else ""
        sql = f"SELECT COUNT(*) FROM {quote_ident(spec.name)}{clause}"
        counts[spec.name] = int(connection.execute(sql, params).fetchone()[0])
    return counts


def run_verify(connection: sqlite3.Connection, source: Path, expect_json: Path) -> int:
    try:
        payload = json.loads(expect_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ExportError(f"cannot read --expect-json {expect_json}: {exc}") from exc
    expected = payload.get("tables", payload)
    if not isinstance(expected, dict):
        raise ExportError(f"{expect_json} does not contain a table -> count mapping")
    excluded = [int(value) for value in payload.get("excluded_trackers", [])]

    print("FlightNotify → Cloudflare D1 (verify source against the export manifest)")
    print(f"  source         : {source}")
    print(f"  manifest       : {expect_json}")
    print(f"  manifest sha256: {payload.get('source_sha256', '-')}")
    print(f"  source sha256  : {file_digest(source)}")

    print("\nReferential integrity in the source:")
    problems = _integrity_problems(connection, excluded)

    print("\nRow counts:")
    actual = _filtered_counts(connection, excluded)
    for name in sorted(set(expected) | set(actual)):
        want = expected.get(name)
        have = actual.get(name)
        if want == have:
            print(f"  {name:<30}expected {want:>6}   source {have:>6}   ok")
        else:
            print(f"  {name:<30}expected {want!s:>6}   source {have!s:>6}   MISMATCH")
            problems.append(f"{name}: manifest says {want}, source has {have}")

    if problems:
        print("\nVerification FAILED:")
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return EXIT_ERRORS
    print("\nVerification passed: every count matches and no orphan rows were found.")
    return EXIT_OK


# --------------------------------------------------------------------- main
def run(args: argparse.Namespace) -> int:
    """Entry point for ``flightnotify export-d1``."""
    if args.write and args.dry_run:
        print("error: --write and --dry-run contradict each other.", file=sys.stderr)
        return EXIT_CONFIG

    try:
        source = resolve_source(args.source, allow_unsafe=args.allow_unsafe_source)
    except ExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG

    connection = open_readonly(source)
    try:
        if args.verify:
            if not args.expect_json:
                print("error: --verify needs --expect-json.", file=sys.stderr)
                return EXIT_CONFIG
            return run_verify(connection, source, Path(args.expect_json).expanduser())

        problems = validate_source_schema(connection)
        if problems:
            print(
                f"error: {source} does not match the expected {EXPECTED_TABLE_COUNT}-table "
                "schema; nothing was exported.",
                file=sys.stderr,
            )
            for problem in problems:
                print(f"  {problem}", file=sys.stderr)
            return EXIT_CONFIG

        result = collect(connection, list(args.exclude_tracker or []))
        result.source = source
        result.digest = file_digest(source)

        if not args.write:
            print_summary(result, dry_run=True)
            print("\nNothing was written. Re-run with --write --output <file.sql> to emit the SQL.")
            return EXIT_OK

        if not args.output:
            print("error: --write needs --output <file.sql>.", file=sys.stderr)
            return EXIT_CONFIG
        output = Path(args.output).expanduser()
        output.parent.mkdir(parents=True, exist_ok=True)
        counts_path = output.with_suffix(output.suffix + ".counts.json")
        generated_at = datetime.now(UTC)
        output.write_text(render_sql(result, generated_at=generated_at), encoding="utf-8")
        counts_path.write_text(
            json.dumps(manifest(result, generated_at=generated_at), indent=2) + "\n",
            encoding="utf-8",
        )
        print_summary(result, dry_run=False)
        print(f"\nWrote {output} ({output.stat().st_size / 1024:.1f} KiB)")
        print(f"Wrote {counts_path} - pass it to --verify --expect-json after the import.")
        print(f"Import with: wrangler d1 execute <database> --remote --file {output}")
        return EXIT_OK
    except ExportError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    finally:
        connection.close()
