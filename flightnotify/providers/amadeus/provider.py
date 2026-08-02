"""Amadeus implementation of :class:`~flightnotify.providers.base.FareProvider`.

Amadeus returns airline/GDS fare data rather than scraped Google Flights
results, which changes two things FlightNotify cares about:

* the price scope is documented rather than assumed (see ``parsing``);
* a flexible search is a real date-range query, so a whole window costs one
  request instead of one per date pair.

Coverage is narrower than Google Flights, and the ``test`` environment serves a
limited cached data set - a route that works in production may return nothing
there. Treat an empty result as "no data for this route", not a failure.
"""

from __future__ import annotations

import calendar
import logging
from datetime import date
from typing import Any

import httpx

from ...config import Settings, get_settings
from ...domain.fingerprints import query_fingerprint
from ...enums import Cabin, EndpointType, FlexDuration, PriceScopeLabel, StopsPreference
from ...timeutil import utcnow
from ..base import (
    AccountStatus,
    ExactSearchQuery,
    FlexibleSearchQuery,
    ProviderResult,
)
from ..errors import ProviderMissingCredentialsError, ProviderUnsupportedQueryError
from .client import AmadeusClient
from .parsing import parse_flight_dates, parse_flight_offers

log = logging.getLogger(__name__)

FLIGHT_OFFERS_PATH = "/v2/shopping/flight-offers"
FLIGHT_DATES_PATH = "/v1/shopping/flight-dates"

#: travelClass values accepted by Flight Offers Search.
CABIN_CODES: dict[Cabin, str] = {
    Cabin.ECONOMY: "ECONOMY",
    Cabin.PREMIUM_ECONOMY: "PREMIUM_ECONOMY",
    Cabin.BUSINESS: "BUSINESS",
    Cabin.FIRST: "FIRST",
}

#: Nights used to approximate FlightNotify's flexible presets. Amadeus takes a
#: trip duration in days, so each preset maps to its nearest documented length.
FLEX_DURATION_DAYS: dict[FlexDuration, str] = {
    FlexDuration.WEEKEND: "2",
    FlexDuration.ONE_WEEK: "7",
    FlexDuration.TWO_WEEKS: "14",
}

#: Offers requested per exact search. The cheapest is what matters; a large
#: page costs the same one request but more parsing.
MAX_OFFERS = 20


class AmadeusProvider:
    """Amadeus Self-Service adapter. Produces no data of its own."""

    name = "amadeus"

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        client: AmadeusClient | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._client = client or AmadeusClient(
            self._settings.amadeus_client_id,
            self._settings.amadeus_client_secret,
            environment=self._settings.amadeus_environment,
            timeout=self._settings.amadeus_timeout_seconds,
            transport=transport,
        )

    # -- capability ---------------------------------------------------------
    def is_configured(self) -> bool:
        return bool(
            self._settings.amadeus_client_id.strip()
            and self._settings.amadeus_client_secret.strip()
        )

    def supports_flexible(self) -> bool:
        return True

    @property
    def price_scope(self) -> PriceScopeLabel:
        # Documented by the specification, not inferred.
        return PriceScopeLabel.PARTY_TOTAL

    @property
    def exact_endpoint(self) -> EndpointType:
        return EndpointType.AMADEUS_FLIGHT_OFFERS

    @property
    def flexible_endpoint(self) -> EndpointType:
        return EndpointType.AMADEUS_FLIGHT_DATES

    # -- cache replay -------------------------------------------------------
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
        if flexible:
            return parse_flight_dates(
                payload,
                market=market,
                currency=currency,
                query_fingerprint=query_fingerprint,
            )
        return parse_flight_offers(
            payload,
            market=market,
            currency=currency,
            query_fingerprint=query_fingerprint,
            outbound_date=outbound_date,
            return_date=return_date,
        )

    # -- exact --------------------------------------------------------------
    def build_exact_params(self, query: ExactSearchQuery) -> dict[str, Any]:
        """Credential-free request parameters for Flight Offers Search."""
        params: dict[str, Any] = {
            "originLocationCode": query.origin.upper(),
            "destinationLocationCode": query.destination.upper(),
            "departureDate": query.outbound_date.isoformat(),
            "returnDate": query.return_date.isoformat(),
            "adults": query.party.adults,
            "travelClass": CABIN_CODES[query.cabin],
            "currencyCode": query.currency.upper(),
            "max": MAX_OFFERS,
        }
        if query.party.children:
            params["children"] = query.party.children
        # Amadeus counts every infant once, seated or not.
        infants = query.party.infants_in_seat + query.party.infants_on_lap
        if infants:
            params["infants"] = infants
        if query.stops is StopsPreference.NONSTOP:
            params["nonStop"] = "true"
        if query.include_airlines:
            params["includedAirlineCodes"] = query.include_airlines
        elif query.exclude_airlines:
            # Amadeus rejects both filters on one request.
            params["excludedAirlineCodes"] = query.exclude_airlines
        return params

    def search_exact(self, query: ExactSearchQuery) -> ProviderResult:
        self._require_credentials()
        if query.stops is StopsPreference.ONE_STOP_MAX:
            # Amadeus exposes only a nonstop flag, so "1 stop or fewer" cannot
            # be expressed. Refusing beats silently returning any number of
            # stops as if the filter had applied.
            raise ProviderUnsupportedQueryError(
                "Amadeus cannot express a one-stop-maximum filter",
                user_message=(
                    "Amadeus can only filter for nonstop flights, not “1 stop or fewer”. "
                    "Nothing was searched and stored history is unchanged. Choose "
                    "“Nonstop only” or “Any number of stops”, or use the SerpApi provider."
                ),
            )
        params = self.build_exact_params(query)
        fingerprint = query_fingerprint(EndpointType.AMADEUS_FLIGHT_OFFERS.value, params)
        payload = self._client.get(FLIGHT_OFFERS_PATH, params)
        return parse_flight_offers(
            payload,
            market=query.market,
            currency=query.currency,
            query_fingerprint=fingerprint,
            outbound_date=query.outbound_date,
            return_date=query.return_date,
        )

    # -- flexible -----------------------------------------------------------
    def build_flexible_params(self, query: FlexibleSearchQuery) -> dict[str, Any]:
        """Credential-free request parameters for Flight Cheapest Date Search.

        FlightNotify's flexible preset is a month plus a trip length; Amadeus
        takes a departure-date range plus a duration, so the month becomes its
        own first-to-last day range.
        """
        year = utcnow().year
        month = max(1, min(12, query.month))
        first = date(year, month, 1)
        last = date(year, month, calendar.monthrange(year, month)[1])
        today = utcnow().date()
        if last < today:
            # The month has already passed this year; the next one is meant.
            first = date(year + 1, month, 1)
            last = date(year + 1, month, calendar.monthrange(year + 1, month)[1])
        elif first < today:
            first = today

        params: dict[str, Any] = {
            "origin": query.origin.upper(),
            "destination": query.destination.upper(),
            "departureDate": f"{first.isoformat()},{last.isoformat()}",
            "duration": FLEX_DURATION_DAYS[query.duration],
            "oneWay": "false",
            "viewBy": "DATE",
        }
        if query.stops is StopsPreference.NONSTOP:
            params["nonStop"] = "true"
        return params

    def search_flexible(self, query: FlexibleSearchQuery) -> ProviderResult:
        self._require_credentials()
        params = self.build_flexible_params(query)
        fingerprint = query_fingerprint(EndpointType.AMADEUS_FLIGHT_DATES.value, params)
        payload = self._client.get(FLIGHT_DATES_PATH, params)
        return parse_flight_dates(
            payload,
            market=query.market,
            currency=query.currency,
            query_fingerprint=fingerprint,
        )

    # -- account ------------------------------------------------------------
    def account_status(self) -> AccountStatus:
        """Amadeus exposes no quota endpoint on the Self-Service tier.

        Reporting unknown is the honest answer: the quota guard then keeps
        using FlightNotify's own configured limits rather than a number this
        provider never supplied.
        """
        return AccountStatus(
            plan_name=f"Amadeus Self-Service ({self._settings.amadeus_environment})",
            searches_per_month=None,
            searches_left=None,
            this_month_usage=None,
            rate_limit_per_hour=None,
            account_email_masked=None,
            fetched_at=utcnow(),
        )

    def _require_credentials(self) -> None:
        if not self.is_configured():
            raise ProviderMissingCredentialsError(
                "AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET are not set.",
                user_message=(
                    "No Amadeus credentials are configured, so no search was made. "
                    "Stored history is unchanged. Add AMADEUS_CLIENT_ID and "
                    "AMADEUS_CLIENT_SECRET to your .env and restart FlightNotify."
                ),
            )
