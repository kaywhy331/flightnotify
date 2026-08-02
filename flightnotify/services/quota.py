"""Free-tier quota enforcement.

The quota guard is a product behaviour, not documentation: normal application
activity cannot exceed the configured monthly allowance. Two independent
signals are combined and the *most conservative* wins:

1. a local ledger of every billable call FlightNotify made, and
2. the provider's own account status (free to query, per SerpApi's docs).

A configurable reserve is held back so a deliberate "Check now" still works
after automation has stopped.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..enums import RunTrigger
from ..models import ProviderCall, ProviderUsage
from ..providers.base import FareProvider
from ..providers.errors import ProviderError
from ..timeutil import period_key, utcnow

log = logging.getLogger(__name__)

#: Triggers allowed to draw on the reserve. Automation never is.
RESERVE_ELIGIBLE_TRIGGERS = frozenset({RunTrigger.MANUAL, RunTrigger.INITIAL})


@dataclass(frozen=True, slots=True)
class QuotaSnapshot:
    period: str
    monthly_limit: int
    reserve: int
    local_used: int
    provider_used: int | None
    provider_left: int | None
    provider_limit: int | None
    provider_plan: str | None
    provider_account_masked: str | None
    last_synced_at: object | None
    sync_error: str | None
    hourly_limit: int
    hourly_used: int

    @property
    def effective_used(self) -> int:
        """The higher of our count and the provider's - never the lower."""
        if self.provider_used is None:
            return self.local_used
        return max(self.local_used, self.provider_used)

    @property
    def remaining_hard(self) -> int:
        """Calls left before the configured monthly cap, ignoring the reserve."""
        remaining = self.monthly_limit - self.effective_used
        if self.provider_left is not None:
            remaining = min(remaining, self.provider_left)
        return max(0, remaining)

    @property
    def remaining_safe(self) -> int:
        """Calls automation may still make."""
        return max(0, self.remaining_hard - self.reserve)

    @property
    def used_percent(self) -> float:
        if self.monthly_limit <= 0:
            return 100.0
        return min(100.0, round(self.effective_used / self.monthly_limit * 100, 1))

    @property
    def hourly_remaining(self) -> int:
        return max(0, self.hourly_limit - self.hourly_used)

    @property
    def is_exhausted(self) -> bool:
        return self.remaining_hard <= 0

    @property
    def automation_blocked(self) -> bool:
        return self.remaining_safe <= 0


@dataclass(frozen=True, slots=True)
class SpendDecision:
    allowed: bool
    granted: int
    reason: str

    @property
    def blocked(self) -> bool:
        return not self.allowed


class QuotaManager:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    # -- ledger -------------------------------------------------------------
    def usage_row(self, session: Session, period: str | None = None) -> ProviderUsage:
        period = period or period_key()
        row = session.execute(
            select(ProviderUsage).where(
                ProviderUsage.provider == "serpapi", ProviderUsage.period == period
            )
        ).scalar_one_or_none()
        if row is None:
            row = ProviderUsage(provider="serpapi", period=period, local_searches=0)
            session.add(row)
            session.flush()
        return row

    def hourly_used(self, session: Session) -> int:
        since = utcnow() - timedelta(hours=1)
        total = session.execute(
            select(func.count(ProviderCall.id)).where(
                ProviderCall.provider == "serpapi", ProviderCall.called_at >= since
            )
        ).scalar_one()
        return int(total or 0)

    def snapshot(self, session: Session) -> QuotaSnapshot:
        row = self.usage_row(session)
        return QuotaSnapshot(
            period=row.period,
            monthly_limit=self.settings.serpapi_monthly_search_limit,
            reserve=self.settings.serpapi_reserve_searches,
            local_used=row.local_searches,
            provider_used=row.provider_this_month_usage,
            provider_left=row.provider_searches_left,
            provider_limit=row.provider_searches_per_month,
            provider_plan=row.provider_plan_name,
            provider_account_masked=row.provider_account_email_masked,
            last_synced_at=row.last_synced_at,
            sync_error=row.last_sync_error,
            hourly_limit=self.settings.serpapi_hourly_search_limit,
            hourly_used=self.hourly_used(session),
        )

    # -- decisions ----------------------------------------------------------
    def authorize(
        self, session: Session, *, wanted: int, trigger: RunTrigger | str
    ) -> SpendDecision:
        """Decide how many of ``wanted`` billable calls may be made now."""
        trigger = RunTrigger(trigger)
        snapshot = self.snapshot(session)
        may_use_reserve = trigger in RESERVE_ELIGIBLE_TRIGGERS
        budget = snapshot.remaining_hard if may_use_reserve else snapshot.remaining_safe

        if snapshot.monthly_limit <= 0:
            return SpendDecision(
                False, 0, "SERPAPI_MONTHLY_SEARCH_LIMIT is 0, so no searches are permitted."
            )
        if budget <= 0:
            if snapshot.remaining_hard <= 0:
                return SpendDecision(
                    False,
                    0,
                    "Monthly provider allowance is exhausted "
                    f"({snapshot.effective_used}/{snapshot.monthly_limit} used "
                    f"in {snapshot.period}).",
                )
            return SpendDecision(
                False,
                0,
                f"Only the {snapshot.reserve}-search reserve remains "
                f"({snapshot.remaining_hard} left); automated checks are paused so a "
                "manual check stays possible.",
            )

        hourly_left = snapshot.hourly_remaining
        if hourly_left <= 0:
            return SpendDecision(
                False,
                0,
                f"The provider's hourly throughput limit ({snapshot.hourly_limit}/hour) "
                "is reached. FlightNotify will resume on a later run.",
            )

        granted = min(wanted, budget, hourly_left)
        if granted < wanted:
            return SpendDecision(
                True,
                granted,
                f"Reduced from {wanted} to {granted} searches to stay within the "
                f"configured allowance ({snapshot.remaining_hard} left this period).",
            )
        return SpendDecision(True, granted, "")

    # -- recording ----------------------------------------------------------
    def record_call(
        self, session: Session, *, endpoint: str, run_id: int | None = None, count: int = 1
    ) -> None:
        """Record billable calls. Must be called for every non-cached search.

        FlightNotify counts a search that returned no itineraries too. SerpApi
        states errored searches are not billed, but over-counting stops
        automation early, which is the safe direction for a hard cap.
        """
        if count <= 0:
            return
        row = self.usage_row(session)
        row.local_searches += count
        for _ in range(count):
            session.add(
                ProviderCall(
                    provider="serpapi", endpoint=endpoint, called_at=utcnow(), search_run_id=run_id
                )
            )
        session.flush()

    def prune_call_log(self, session: Session, *, keep_hours: int = 72) -> int:
        """Trim the throughput log; the monthly ledger is authoritative."""
        cutoff = utcnow() - timedelta(hours=keep_hours)
        rows = (
            session.execute(select(ProviderCall).where(ProviderCall.called_at < cutoff))
            .scalars()
            .all()
        )
        for row in rows:
            session.delete(row)
        return len(rows)

    # -- provider sync ------------------------------------------------------
    def sync_from_provider(self, session: Session, provider: FareProvider) -> QuotaSnapshot:
        """Refresh provider-reported quota. Never consumes a fare search."""
        row = self.usage_row(session)
        if not provider.is_configured():
            row.last_sync_error = "No SerpApi key configured."
            session.flush()
            return self.snapshot(session)
        try:
            status = provider.account_status()
        except ProviderError as exc:
            row.last_sync_error = exc.guidance()
            session.flush()
            log.warning("provider quota sync failed", extra={"error_category": exc.category.value})
            return self.snapshot(session)

        row.provider_plan_name = status.plan_name
        row.provider_searches_per_month = status.searches_per_month
        row.provider_searches_left = status.searches_left
        row.provider_this_month_usage = status.this_month_usage
        row.provider_rate_limit_per_hour = status.rate_limit_per_hour
        row.provider_account_email_masked = status.account_email_masked
        row.last_synced_at = status.fetched_at
        row.last_sync_error = None
        # Never let the local ledger under-report what the provider has seen.
        if status.this_month_usage is not None:
            row.local_searches = max(row.local_searches, status.this_month_usage)
        session.flush()
        return self.snapshot(session)
