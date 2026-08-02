"""Provider-neutral query and result types."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

from ..enums import Cabin, EndpointType, FlexDuration, PriceScopeLabel, StopsPreference


@dataclass(frozen=True, slots=True)
class PassengerParty:
    adults: int = 1
    children: int = 0
    infants_in_seat: int = 0
    infants_on_lap: int = 0

    @property
    def paying_travelers(self) -> int:
        return self.adults + self.children + self.infants_in_seat

    @property
    def total(self) -> int:
        return self.paying_travelers + self.infants_on_lap


@dataclass(frozen=True, slots=True)
class ExactSearchQuery:
    """A fixed outbound/return round-trip search in one country market."""

    origin: str
    destination: str
    outbound_date: date
    return_date: date
    party: PassengerParty
    cabin: Cabin
    stops: StopsPreference
    currency: str
    market: str
    include_airlines: str | None = None
    exclude_airlines: str | None = None


@dataclass(frozen=True, slots=True)
class FlexibleSearchQuery:
    """A route-specific flexible search (month + supported trip length)."""

    origin: str
    destination: str
    month: int
    duration: FlexDuration
    party: PassengerParty
    cabin: Cabin
    stops: StopsPreference
    currency: str
    market: str
    include_airlines: str | None = None
    exclude_airlines: str | None = None


@dataclass(slots=True)
class NormalizedOffer:
    """One itinerary, normalized but never lossy about the provider's own value."""

    price_amount: Decimal
    currency: str
    price_scope: PriceScopeLabel
    market: str
    origin: str | None = None
    destination: str | None = None
    outbound_date: date | None = None
    return_date: date | None = None
    departure_time: str | None = None
    arrival_time: str | None = None
    airlines: list[str] = field(default_factory=list)
    flight_numbers: list[str] = field(default_factory=list)
    stops: int | None = None
    duration_minutes: int | None = None
    cabin: str | None = None
    segments: list[dict[str, Any]] = field(default_factory=list)
    layovers: list[dict[str, Any]] = field(default_factory=list)
    booking_link: str | None = None
    search_link: str | None = None


@dataclass(slots=True)
class ProviderResult:
    """Everything one provider call produced."""

    endpoint: EndpointType
    market: str
    currency: str
    query_fingerprint: str
    offers: list[NormalizedOffer]
    response_at: datetime
    #: Billable provider searches this result consumed (0 when served from cache).
    request_count: int = 1
    search_link: str | None = None
    outbound_date: date | None = None
    return_date: date | None = None
    #: Sanitized, credential-free excerpt kept for debugging.
    raw_excerpt: dict[str, Any] = field(default_factory=dict)
    from_cache: bool = False


@dataclass(frozen=True, slots=True)
class AccountStatus:
    """Provider-reported quota. Fetching this must not consume a search."""

    plan_name: str | None
    searches_per_month: int | None
    searches_left: int | None
    this_month_usage: int | None
    rate_limit_per_hour: int | None
    account_email_masked: str | None
    fetched_at: datetime


@runtime_checkable
class FareProvider(Protocol):
    """The contract the tracking domain depends on.

    This is everything :class:`~flightnotify.services.search.SearchService`
    actually calls. The request-shaping and parsing members are part of the
    contract, not implementation detail: the cache stores a provider's own
    request parameters as the fingerprint and replays its own payloads, so a
    provider must be able to build and read both.
    """

    name: str

    def is_configured(self) -> bool:
        """True when credentials are present. Never returns the credential."""

    @property
    def price_scope(self) -> PriceScopeLabel:
        """How this provider's prices should be read (party total vs each)."""

    @property
    def exact_endpoint(self) -> EndpointType:
        """Endpoint recorded for a fixed-date search."""

    @property
    def flexible_endpoint(self) -> EndpointType:
        """Endpoint recorded for a flexible search."""

    def build_exact_params(self, query: ExactSearchQuery) -> dict[str, Any]:
        """Credential-free request parameters, used as the cache fingerprint."""

    def build_flexible_params(self, query: FlexibleSearchQuery) -> dict[str, Any]:
        """Credential-free request parameters, used as the cache fingerprint."""

    def search_exact(self, query: ExactSearchQuery) -> ProviderResult:
        """Run a fixed-date round-trip search."""

    def supports_flexible(self) -> bool:
        """True when this provider can answer route-specific flexible searches."""

    def search_flexible(self, query: FlexibleSearchQuery) -> ProviderResult:
        """Run a route-specific flexible search."""

    def parse_payload(
        self,
        payload: dict[str, Any],
        *,
        flexible: bool,
        market: str,
        currency: str,
        query_fingerprint: str,
        outbound_date: date | None = None,
        return_date: date | None = None,
    ) -> ProviderResult:
        """Read a stored response body back into a result.

        Used to replay a cached payload without spending a search, so it must
        accept exactly what this provider's own search methods produced.
        """

    def account_status(self) -> AccountStatus:
        """Fetch provider-reported quota. Must not consume a fare search."""


def mask_identifier(value: str | None) -> str | None:
    """Mask an account identifier for display (never a token)."""
    if not value:
        return None
    if "@" in value:
        local, _, domain = value.partition("@")
        head = local[:2] if len(local) > 2 else local[:1]
        return f"{head}{'*' * max(3, len(local) - len(head))}@{domain}"
    return f"{value[:2]}{'*' * max(3, len(value) - 2)}"
