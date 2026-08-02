"""SQLAlchemy models.

Conventions:

* every timestamp uses :class:`~flightnotify.jsontype.UtcDateTime`, which
  converts to UTC on write and returns an aware UTC value on read;
* money is stored as ``Numeric(12, 2)`` and handled as :class:`~decimal.Decimal`;
* comparison-relevant tracker settings are snapshotted into
  :class:`TrackerConfigVersion` so historical observations are never silently
  compared across an incompatible configuration change.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .enums import (
    AlertType,
    Cabin,
    CacheStatus,
    CandidateStatus,
    CoverageState,
    DateMode,
    DeliveryState,
    EndpointType,
    ErrorCategory,
    PriceScopeLabel,
    RunStatus,
    RunTrigger,
    StopsPreference,
    ThresholdBasis,
    TrackerStatus,
)
from .jsontype import JSONEncoded, UtcDateTime
from .timeutil import utcnow


class Base(DeclarativeBase):
    pass


def _utc_col(**kwargs: Any) -> Mapped[datetime]:
    """A timestamp column that always round-trips as aware UTC."""
    return mapped_column(UtcDateTime, **kwargs)


class Tracker(Base):
    __tablename__ = "trackers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=TrackerStatus.ACTIVE, nullable=False)

    # --- route + passengers -------------------------------------------------
    origin: Mapped[str] = mapped_column(String(3), nullable=False)
    destination: Mapped[str] = mapped_column(String(3), nullable=False)
    adults: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    children: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    infants_in_seat: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    infants_on_lap: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cabin: Mapped[str] = mapped_column(String(20), default=Cabin.ECONOMY, nullable=False)
    stops: Mapped[str] = mapped_column(String(16), default=StopsPreference.ANY, nullable=False)
    include_airlines: Mapped[str | None] = mapped_column(String(120))
    exclude_airlines: Mapped[str | None] = mapped_column(String(120))

    # --- dates --------------------------------------------------------------
    date_mode: Mapped[str] = mapped_column(String(20), default=DateMode.EXACT, nullable=False)
    outbound_date: Mapped[date | None] = mapped_column(Date)
    return_date: Mapped[date | None] = mapped_column(Date)
    flex_month: Mapped[int | None] = mapped_column(Integer)
    flex_year: Mapped[int | None] = mapped_column(Integer)
    flex_duration: Mapped[str | None] = mapped_column(String(16))
    window_outbound_start: Mapped[date | None] = mapped_column(Date)
    window_outbound_end: Mapped[date | None] = mapped_column(Date)
    window_return_start: Mapped[date | None] = mapped_column(Date)
    window_return_end: Mapped[date | None] = mapped_column(Date)
    min_nights: Mapped[int | None] = mapped_column(Integer)
    max_nights: Mapped[int | None] = mapped_column(Integer)

    # --- comparison ---------------------------------------------------------
    currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    threshold_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    threshold_basis: Mapped[str] = mapped_column(
        String(16), default=ThresholdBasis.PARTY, nullable=False
    )

    # --- alerting -----------------------------------------------------------
    alert_on_threshold: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    alert_on_new_low: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    min_drop_absolute: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    min_drop_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=360, nullable=False)

    # --- scheduling ---------------------------------------------------------
    check_interval_minutes: Mapped[int] = mapped_column(Integer, default=720, nullable=False)
    candidates_per_run: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    sampled_mode_ack: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    next_run_at: Mapped[datetime | None] = _utc_col()
    last_attempt_at: Mapped[datetime | None] = _utc_col()
    last_success_at: Mapped[datetime | None] = _utc_col()
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # --- execution lock (prevents duplicate concurrent checks) --------------
    lock_owner: Mapped[str | None] = mapped_column(String(80))
    lock_expires_at: Mapped[datetime | None] = _utc_col()

    # --- current comparison series -----------------------------------------
    #: Deliberately a plain column, not a ForeignKey: trackers and
    #: tracker_config_versions would otherwise form a mutually dependent FK
    #: cycle. The pointer is maintained by
    #: :func:`flightnotify.services.tracker_service.ensure_config_version`, and
    #: the versions themselves cascade from the tracker.
    current_config_version_id: Mapped[int | None] = mapped_column(Integer, index=True)
    series_started_at: Mapped[datetime | None] = _utc_col()

    latest_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    latest_observation_id: Mapped[int | None] = mapped_column(Integer)
    latest_observed_at: Mapped[datetime | None] = _utc_col()
    low_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    low_observation_id: Mapped[int | None] = mapped_column(Integer)
    low_observed_at: Mapped[datetime | None] = _utc_col()
    last_threshold_met: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    coverage_cycle: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    last_error_category: Mapped[str | None] = mapped_column(String(32))
    last_error_message: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = _utc_col(default=utcnow, onupdate=utcnow, nullable=False)

    markets: Mapped[list[TrackerMarket]] = relationship(
        back_populates="tracker",
        cascade="all, delete-orphan",
        order_by="TrackerMarket.priority",
        lazy="selectin",
    )
    config_versions: Mapped[list[TrackerConfigVersion]] = relationship(
        back_populates="tracker",
        cascade="all, delete-orphan",
        order_by="TrackerConfigVersion.version",
    )

    __table_args__ = (
        CheckConstraint("adults >= 1", name="ck_trackers_adults_min"),
        CheckConstraint("children >= 0", name="ck_trackers_children_min"),
        CheckConstraint("check_interval_minutes >= 15", name="ck_trackers_interval_min"),
        CheckConstraint("threshold_amount > 0", name="ck_trackers_threshold_positive"),
        Index("ix_trackers_status_next_run", "status", "next_run_at"),
    )

    # --- convenience --------------------------------------------------------
    @property
    def market_codes(self) -> list[str]:
        return [m.market for m in sorted(self.markets, key=lambda m: m.priority)]

    @property
    def primary_market(self) -> str:
        codes = self.market_codes
        return codes[0] if codes else "us"

    @property
    def paying_travelers(self) -> int:
        """Travelers occupying a seat. Lap infants are deliberately excluded."""
        return self.adults + self.children + self.infants_in_seat

    @property
    def total_travelers(self) -> int:
        return self.paying_travelers + self.infants_on_lap

    @property
    def passenger_summary(self) -> str:
        parts = [f"{self.adults} adult" + ("s" if self.adults != 1 else "")]
        if self.children:
            parts.append(f"{self.children} child" + ("ren" if self.children != 1 else ""))
        if self.infants_in_seat:
            parts.append(f"{self.infants_in_seat} infant in seat")
        if self.infants_on_lap:
            parts.append(f"{self.infants_on_lap} lap infant")
        return ", ".join(parts)

    @property
    def route(self) -> str:
        return f"{self.origin} → {self.destination}"


class TrackerMarket(Base):
    __tablename__ = "tracker_markets"

    id: Mapped[int] = mapped_column(primary_key=True)
    tracker_id: Mapped[int] = mapped_column(
        ForeignKey("trackers.id", ondelete="CASCADE"), nullable=False
    )
    market: Mapped[str] = mapped_column(String(2), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    tracker: Mapped[Tracker] = relationship(back_populates="markets")

    __table_args__ = (UniqueConstraint("tracker_id", "market", name="uq_tracker_market"),)


class TrackerConfigVersion(Base):
    """Immutable snapshot of every comparison-relevant tracker setting."""

    __tablename__ = "tracker_config_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    tracker_id: Mapped[int] = mapped_column(
        ForeignKey("trackers.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONEncoded, nullable=False)
    effective_from: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    effective_to: Mapped[datetime | None] = _utc_col()
    created_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)

    tracker: Mapped[Tracker] = relationship(back_populates="config_versions")

    __table_args__ = (
        UniqueConstraint("tracker_id", "version", name="uq_config_version_number"),
        Index("ix_config_versions_tracker_fp", "tracker_id", "fingerprint"),
    )


class FlexibleDateCandidate(Base):
    """One outbound/return pair inside a custom flexible window."""

    __tablename__ = "flexible_date_candidates"

    id: Mapped[int] = mapped_column(primary_key=True)
    tracker_id: Mapped[int] = mapped_column(
        ForeignKey("trackers.id", ondelete="CASCADE"), nullable=False
    )
    config_version_id: Mapped[int] = mapped_column(
        ForeignKey("tracker_config_versions.id", ondelete="CASCADE"), nullable=False
    )
    outbound_date: Mapped[date] = mapped_column(Date, nullable=False)
    return_date: Mapped[date] = mapped_column(Date, nullable=False)
    nights: Mapped[int] = mapped_column(Integer, nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, nullable=False)

    cycle: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default=CandidateStatus.PENDING, nullable=False)
    last_checked_at: Mapped[datetime | None] = _utc_col()
    last_run_id: Mapped[int | None] = mapped_column(Integer)
    check_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))

    __table_args__ = (
        UniqueConstraint(
            "config_version_id", "outbound_date", "return_date", name="uq_candidate_pair"
        ),
        Index("ix_candidates_queue", "config_version_id", "cycle", "status", "order_index"),
    )


class SearchRun(Base):
    """One provider query attempt - stored even when it fails or is skipped."""

    __tablename__ = "search_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    tracker_id: Mapped[int] = mapped_column(
        ForeignKey("trackers.id", ondelete="CASCADE"), nullable=False
    )
    config_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("tracker_config_versions.id", ondelete="SET NULL")
    )
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False)
    trigger: Mapped[str] = mapped_column(String(16), default=RunTrigger.SCHEDULED, nullable=False)
    endpoint: Mapped[str] = mapped_column(String(32), default=EndpointType.GOOGLE_FLIGHTS)
    market: Mapped[str] = mapped_column(String(2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    outbound_date: Mapped[date | None] = mapped_column(Date)
    return_date: Mapped[date | None] = mapped_column(Date)
    query_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    started_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = _utc_col()
    status: Mapped[str] = mapped_column(String(24), default=RunStatus.SUCCESS, nullable=False)
    provider_request_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cache_status: Mapped[str] = mapped_column(String(16), default=CacheStatus.MISS, nullable=False)

    coverage_cycle: Mapped[int | None] = mapped_column(Integer)
    coverage_state: Mapped[str] = mapped_column(
        String(20), default=CoverageState.NOT_APPLICABLE, nullable=False
    )
    coverage_checked: Mapped[int | None] = mapped_column(Integer)
    coverage_total: Mapped[int | None] = mapped_column(Integer)

    offers_found: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    best_observation_id: Mapped[int | None] = mapped_column(Integer)
    error_category: Mapped[str] = mapped_column(
        String(32), default=ErrorCategory.NONE, nullable=False
    )
    error_message: Mapped[str | None] = mapped_column(Text)
    skip_reason: Mapped[str | None] = mapped_column(Text)
    raw_excerpt: Mapped[dict[str, Any] | None] = mapped_column(JSONEncoded)

    __table_args__ = (
        Index("ix_runs_tracker_started", "tracker_id", "started_at"),
        Index("ix_runs_batch", "batch_id"),
        Index("ix_runs_fingerprint", "query_fingerprint"),
    )


class FareObservation(Base):
    __tablename__ = "fare_observations"

    id: Mapped[int] = mapped_column(primary_key=True)
    search_run_id: Mapped[int] = mapped_column(
        ForeignKey("search_runs.id", ondelete="CASCADE"), nullable=False
    )
    tracker_id: Mapped[int] = mapped_column(
        ForeignKey("trackers.id", ondelete="CASCADE"), nullable=False
    )
    config_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("tracker_config_versions.id", ondelete="SET NULL")
    )

    itinerary_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    price_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    price_scope: Mapped[str] = mapped_column(
        String(16), default=PriceScopeLabel.PARTY_TOTAL, nullable=False
    )
    #: Only populated when it can be derived without double counting.
    per_traveler_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    per_traveler_is_calculated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    party_total_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    party_total_is_calculated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    origin: Mapped[str | None] = mapped_column(String(8))
    destination: Mapped[str | None] = mapped_column(String(8))
    outbound_date: Mapped[date | None] = mapped_column(Date)
    return_date: Mapped[date | None] = mapped_column(Date)
    departure_time: Mapped[str | None] = mapped_column(String(32))
    arrival_time: Mapped[str | None] = mapped_column(String(32))
    airlines: Mapped[list[str] | None] = mapped_column(JSONEncoded)
    flight_numbers: Mapped[list[str] | None] = mapped_column(JSONEncoded)
    stops: Mapped[int | None] = mapped_column(Integer)
    duration_minutes: Mapped[int | None] = mapped_column(Integer)
    cabin: Mapped[str | None] = mapped_column(String(32))
    segments: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONEncoded)
    layovers: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONEncoded)
    booking_link: Mapped[str | None] = mapped_column(Text)
    search_link: Mapped[str | None] = mapped_column(Text)
    market: Mapped[str] = mapped_column(String(2), nullable=False)

    observed_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    eligible: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    exclusion_reason: Mapped[str | None] = mapped_column(String(120))
    is_best_of_run: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    __table_args__ = (
        Index("ix_obs_tracker_series_price", "tracker_id", "config_version_id", "price_amount"),
        Index("ix_obs_tracker_observed", "tracker_id", "observed_at"),
        Index("ix_obs_run", "search_run_id"),
    )


class AlertEvent(Base):
    __tablename__ = "alert_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    tracker_id: Mapped[int | None] = mapped_column(ForeignKey("trackers.id", ondelete="CASCADE"))
    config_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("tracker_config_versions.id", ondelete="SET NULL")
    )
    observation_id: Mapped[int | None] = mapped_column(
        ForeignKey("fare_observations.id", ondelete="SET NULL")
    )
    alert_type: Mapped[str] = mapped_column(String(16), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(64), nullable=False)
    message_text: Mapped[str] = mapped_column(Text, nullable=False)
    delivery_state: Mapped[str] = mapped_column(
        String(24), default=DeliveryState.PENDING, nullable=False
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)
    telegram_message_id: Mapped[int | None] = mapped_column(Integer)
    response_meta: Mapped[dict[str, Any] | None] = mapped_column(JSONEncoded)
    created_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    delivered_at: Mapped[datetime | None] = _utc_col()

    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_alert_dedupe_key"),
        Index("ix_alerts_tracker_created", "tracker_id", "created_at"),
    )


class ProviderUsage(Base):
    """Local, conservative ledger of billable provider searches."""

    __tablename__ = "provider_usage"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="serpapi", nullable=False)
    period: Mapped[str] = mapped_column(String(7), nullable=False)  # YYYY-MM (UTC)
    local_searches: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    provider_searches_per_month: Mapped[int | None] = mapped_column(Integer)
    provider_searches_left: Mapped[int | None] = mapped_column(Integer)
    provider_this_month_usage: Mapped[int | None] = mapped_column(Integer)
    provider_plan_name: Mapped[str | None] = mapped_column(String(80))
    provider_account_email_masked: Mapped[str | None] = mapped_column(String(120))
    provider_rate_limit_per_hour: Mapped[int | None] = mapped_column(Integer)
    last_synced_at: Mapped[datetime | None] = _utc_col()
    last_sync_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (UniqueConstraint("provider", "period", name="uq_provider_period"),)


class ProviderCall(Base):
    """One billable provider call - backs the rolling hourly throughput guard."""

    __tablename__ = "provider_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(32), default="serpapi", nullable=False)
    endpoint: Mapped[str] = mapped_column(String(32), nullable=False)
    called_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    search_run_id: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("ix_provider_calls_time", "provider", "called_at"),)


class QueryCacheEntry(Base):
    """Short-TTL cache keyed by the provider query fingerprint."""

    __tablename__ = "query_cache"

    id: Mapped[int] = mapped_column(primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONEncoded, nullable=False)
    created_at: Mapped[datetime] = _utc_col(default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = _utc_col(nullable=False)
    source_run_id: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint("fingerprint", name="uq_query_cache_fingerprint"),
        Index("ix_query_cache_expiry", "expires_at"),
    )


class AppSetting(Base):
    """Non-secret application configuration only. Never stores API tokens."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONEncoded)
    updated_at: Mapped[datetime] = _utc_col(default=utcnow, onupdate=utcnow, nullable=False)


class SchedulerState(Base):
    """Singleton row holding the background single-instance leases."""

    __tablename__ = "scheduler_state"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    lock_owner: Mapped[str | None] = mapped_column(String(80))
    lock_expires_at: Mapped[datetime | None] = _utc_col()
    started_at: Mapped[datetime | None] = _utc_col()
    last_tick_at: Mapped[datetime | None] = _utc_col()
    tick_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)

    # The Telegram command poller holds its own lease: Telegram rejects
    # concurrent getUpdates calls with 409, and two pollers would each consume
    # half the updates. Separate from the scheduler lease so either background
    # worker can run without the other.
    bot_lock_owner: Mapped[str | None] = mapped_column(String(80))
    bot_lock_expires_at: Mapped[datetime | None] = _utc_col()


__all__ = [
    "AlertEvent",
    "AlertType",
    "AppSetting",
    "Base",
    "FareObservation",
    "FlexibleDateCandidate",
    "ProviderCall",
    "ProviderUsage",
    "QueryCacheEntry",
    "SchedulerState",
    "SearchRun",
    "Tracker",
    "TrackerConfigVersion",
    "TrackerMarket",
]
