"""SerpApi implementation of :class:`~flightnotify.providers.base.FareProvider`."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from ...config import PriceScope, Settings, get_settings
from ...domain.fingerprints import query_fingerprint
from ...enums import Cabin, EndpointType, FlexDuration, PriceScopeLabel, StopsPreference
from ..base import (
    AccountStatus,
    ExactSearchQuery,
    FlexibleSearchQuery,
    ProviderResult,
    mask_identifier,
)
from ..errors import ProviderMissingCredentialsError
from .client import NoResultsSignal, SerpApiClient
from .parsing import parse_google_flights, parse_google_travel_explore, sanitize_excerpt

log = logging.getLogger(__name__)

#: Documented SerpApi encodings.
CABIN_CODES: dict[Cabin, int] = {
    Cabin.ECONOMY: 1,
    Cabin.PREMIUM_ECONOMY: 2,
    Cabin.BUSINESS: 3,
    Cabin.FIRST: 4,
}
STOPS_CODES: dict[StopsPreference, int] = {
    StopsPreference.ANY: 0,
    StopsPreference.NONSTOP: 1,
    StopsPreference.ONE_STOP_MAX: 2,
}
FLEX_DURATION_CODES: dict[FlexDuration, int] = {
    FlexDuration.WEEKEND: 1,
    FlexDuration.ONE_WEEK: 2,
    FlexDuration.TWO_WEEKS: 3,
}

#: Google Flights caps a single search at nine passengers.
MAX_PASSENGERS = 9
#: Lap infants may not outnumber the adults who would hold them.
MAX_LAP_INFANTS_PER_ADULT = 1


class SerpApiProvider:
    """Live SerpApi adapter. Produces no data of its own."""

    name = "serpapi"

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        client: SerpApiClient | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._price_scope = PriceScopeLabel(PriceScope(self._settings.serpapi_price_scope).value)
        self._client = client or SerpApiClient(
            self._settings.serpapi_api_key,
            base_url=self._settings.serpapi_base_url,
            timeout=self._settings.serpapi_timeout_seconds,
            transport=transport,
        )

    # -- capability ---------------------------------------------------------
    def is_configured(self) -> bool:
        return bool(self._settings.serpapi_api_key.strip())

    def supports_flexible(self) -> bool:
        return True

    @property
    def price_scope(self) -> PriceScopeLabel:
        return self._price_scope

    # -- searches -----------------------------------------------------------
    def build_exact_params(self, query: ExactSearchQuery) -> dict[str, Any]:
        """Request parameters for the Google Flights engine (no credentials)."""
        params: dict[str, Any] = {
            "engine": "google_flights",
            "departure_id": query.origin.upper(),
            "arrival_id": query.destination.upper(),
            "outbound_date": query.outbound_date.isoformat(),
            "return_date": query.return_date.isoformat(),
            "type": 1,  # round trip
            "travel_class": CABIN_CODES[query.cabin],
            "adults": query.party.adults,
            "children": query.party.children,
            "infants_in_seat": query.party.infants_in_seat,
            "infants_on_lap": query.party.infants_on_lap,
            "currency": query.currency.upper(),
            "gl": query.market.lower(),
            "hl": "en",
            "sort_by": 2,  # price
        }
        stops_code = STOPS_CODES[query.stops]
        if stops_code:
            params["stops"] = stops_code
        if query.include_airlines:
            params["include_airlines"] = query.include_airlines
        elif query.exclude_airlines:
            # SerpApi rejects both filters together.
            params["exclude_airlines"] = query.exclude_airlines
        return params

    def search_exact(self, query: ExactSearchQuery) -> ProviderResult:
        self._require_credentials()
        params = self.build_exact_params(query)
        fingerprint = query_fingerprint(EndpointType.GOOGLE_FLIGHTS.value, params)
        try:
            payload = self._client.search(params)
        except NoResultsSignal as signal:
            return self._empty_result(
                EndpointType.GOOGLE_FLIGHTS,
                query.market,
                query.currency,
                fingerprint,
                signal.provider_message,
                outbound=query.outbound_date,
                inbound=query.return_date,
            )
        return parse_google_flights(
            payload,
            market=query.market,
            currency=query.currency,
            query_fingerprint=fingerprint,
            price_scope=self._price_scope,
            outbound_date=query.outbound_date,
            return_date=query.return_date,
        )

    def build_flexible_params(self, query: FlexibleSearchQuery) -> dict[str, Any]:
        """Request parameters for the Google Travel Explore engine."""
        params: dict[str, Any] = {
            "engine": "google_travel_explore",
            "departure_id": query.origin.upper(),
            "arrival_id": query.destination.upper(),
            "type": 1,  # round trip
            "month": query.month,
            "travel_duration": FLEX_DURATION_CODES[query.duration],
            "travel_class": CABIN_CODES[query.cabin],
            "adults": query.party.adults,
            "children": query.party.children,
            "infants_in_seat": query.party.infants_in_seat,
            "infants_on_lap": query.party.infants_on_lap,
            "currency": query.currency.upper(),
            "gl": query.market.lower(),
            "hl": "en",
            "travel_mode": 1,  # flights only
        }
        stops_code = STOPS_CODES[query.stops]
        if stops_code:
            params["stops"] = stops_code
        if query.include_airlines:
            params["include_airlines"] = query.include_airlines
        elif query.exclude_airlines:
            params["exclude_airlines"] = query.exclude_airlines
        return params

    def search_flexible(self, query: FlexibleSearchQuery) -> ProviderResult:
        self._require_credentials()
        params = self.build_flexible_params(query)
        fingerprint = query_fingerprint(EndpointType.GOOGLE_TRAVEL_EXPLORE.value, params)
        try:
            payload = self._client.search(params)
        except NoResultsSignal as signal:
            return self._empty_result(
                EndpointType.GOOGLE_TRAVEL_EXPLORE,
                query.market,
                query.currency,
                fingerprint,
                signal.provider_message,
            )
        return parse_google_travel_explore(
            payload,
            market=query.market,
            currency=query.currency,
            query_fingerprint=fingerprint,
            price_scope=self._price_scope,
        )

    # -- account ------------------------------------------------------------
    def account_status(self) -> AccountStatus:
        """Free per SerpApi's documentation; never counted as a fare search."""
        self._require_credentials()
        payload = self._client.account()
        return AccountStatus(
            plan_name=_str_or_none(payload.get("plan_name")),
            searches_per_month=_int_or_none(payload.get("searches_per_month")),
            searches_left=_int_or_none(payload.get("total_searches_left")),
            this_month_usage=_int_or_none(payload.get("this_month_usage")),
            rate_limit_per_hour=_int_or_none(payload.get("account_rate_limit_per_hour")),
            account_email_masked=mask_identifier(_str_or_none(payload.get("account_email"))),
            fetched_at=datetime.now(UTC),
        )

    # -- helpers ------------------------------------------------------------
    def _require_credentials(self) -> None:
        if not self.is_configured():
            raise ProviderMissingCredentialsError()

    def _empty_result(
        self,
        endpoint: EndpointType,
        market: str,
        currency: str,
        fingerprint: str,
        provider_message: str,
        *,
        outbound: Any = None,
        inbound: Any = None,
    ) -> ProviderResult:
        """A successful call that matched nothing. Still counted as billable."""
        return ProviderResult(
            endpoint=endpoint,
            market=market,
            currency=currency,
            query_fingerprint=fingerprint,
            offers=[],
            response_at=datetime.now(UTC),
            request_count=1,
            search_link=None,
            outbound_date=outbound,
            return_date=inbound,
            raw_excerpt=sanitize_excerpt({"provider_message": provider_message}),
        )


def validate_party(
    adults: int, children: int, infants_in_seat: int, infants_on_lap: int
) -> list[str]:
    """Provider passenger-limit checks. Returns human-readable problems."""
    problems: list[str] = []
    if adults < 1:
        problems.append("At least one adult is required.")
    for label, value in (
        ("Children", children),
        ("Infants in seat", infants_in_seat),
        ("Lap infants", infants_on_lap),
    ):
        if value < 0:
            problems.append(f"{label} cannot be negative.")
    total = adults + children + infants_in_seat + infants_on_lap
    if total > MAX_PASSENGERS:
        problems.append(
            f"Google Flights allows at most {MAX_PASSENGERS} passengers in one search; "
            f"this tracker has {total}."
        )
    if infants_on_lap > adults * MAX_LAP_INFANTS_PER_ADULT:
        problems.append("Each lap infant needs its own adult.")
    return problems


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _str_or_none(value: Any) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None
