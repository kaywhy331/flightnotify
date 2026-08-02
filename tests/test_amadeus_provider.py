"""Amadeus provider.

The fixtures are built from the official OpenAPI specification, not recorded
from a live account, so these tests prove the adapter is self-consistent and
handles the documented shapes - they cannot prove the live API matches. Treat a
first real call as the actual acceptance test.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

import httpx
import pytest

from flightnotify.config import Settings
from flightnotify.enums import Cabin, EndpointType, FlexDuration, PriceScopeLabel, StopsPreference
from flightnotify.providers.amadeus import AmadeusClient, AmadeusProvider
from flightnotify.providers.amadeus.parsing import parse_duration_minutes
from flightnotify.providers.base import (
    ExactSearchQuery,
    FareProvider,
    FlexibleSearchQuery,
    PassengerParty,
)
from flightnotify.providers.errors import (
    ProviderAuthError,
    ProviderMalformedResponseError,
    ProviderMissingCredentialsError,
    ProviderRateLimitError,
    ProviderUnsupportedQueryError,
)
from flightnotify.providers.factory import get_provider
from tests.conftest import load_fixture

TOKEN_BODY = {"type": "amadeusOAuth2Token", "access_token": "test-token", "expires_in": 1799}


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        flight_provider="amadeus",
        amadeus_client_id="test-id",
        amadeus_client_secret="test-secret",
        amadeus_environment="test",
        database_url="sqlite:///:memory:",
        app_timezone="UTC",
        app_secret_key="test-secret-key-for-sessions-only",
    )


def amadeus_transport(
    body: dict[str, Any],
    *,
    status: int = 200,
    recorder: list[httpx.Request] | None = None,
    token_status: int = 200,
) -> httpx.MockTransport:
    """Answer the token exchange, then the data call."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/security/oauth2/token"):
            return httpx.Response(
                token_status,
                json=TOKEN_BODY if token_status == 200 else {"error": "invalid_client"},
            )
        if recorder is not None:
            recorder.append(request)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


def exact_query(**overrides: Any) -> ExactSearchQuery:
    defaults: dict[str, Any] = {
        "origin": "SFO",
        "destination": "NRT",
        "outbound_date": date(2026, 11, 14),
        "return_date": date(2026, 11, 25),
        "party": PassengerParty(adults=2),
        "cabin": Cabin.ECONOMY,
        "stops": StopsPreference.ANY,
        "currency": "USD",
        "market": "us",
    }
    defaults.update(overrides)
    return ExactSearchQuery(**defaults)


def flexible_query(**overrides: Any) -> FlexibleSearchQuery:
    defaults: dict[str, Any] = {
        "origin": "SFO",
        "destination": "NRT",
        "month": 11,
        "duration": FlexDuration.TWO_WEEKS,
        "party": PassengerParty(adults=2),
        "cabin": Cabin.ECONOMY,
        "stops": StopsPreference.ANY,
        "currency": "USD",
        "market": "us",
    }
    defaults.update(overrides)
    return FlexibleSearchQuery(**defaults)


# ----------------------------------------------------------------- contract
def test_provider_satisfies_the_fare_provider_protocol(settings):
    assert isinstance(AmadeusProvider(settings), FareProvider)


def test_factory_selects_amadeus_when_configured(settings):
    assert get_provider(settings).name == "amadeus"


def test_factory_defaults_to_serpapi():
    plain = Settings(database_url="sqlite:///:memory:", app_timezone="UTC")
    assert get_provider(plain).name == "serpapi"


def test_price_scope_is_party_total_by_specification(settings):
    """Unlike SerpApi's Google Flights price, this is documented, not assumed."""
    assert AmadeusProvider(settings).price_scope is PriceScopeLabel.PARTY_TOTAL


def test_is_configured_requires_both_halves_of_the_credential():
    half = Settings(
        flight_provider="amadeus",
        amadeus_client_id="only-id",
        database_url="sqlite:///:memory:",
        app_timezone="UTC",
    )
    assert AmadeusProvider(half).is_configured() is False
    assert half.has_provider_credentials is False


def test_settings_report_the_selected_provider_credentials(settings):
    assert settings.has_provider_credentials is True
    assert "AMADEUS_CLIENT_ID" in settings.provider_credential_hint


# -------------------------------------------------------------- parameters
def test_exact_params_follow_the_specification(settings):
    params = AmadeusProvider(settings).build_exact_params(exact_query())
    assert params["originLocationCode"] == "SFO"
    assert params["destinationLocationCode"] == "NRT"
    assert params["departureDate"] == "2026-11-14"
    assert params["returnDate"] == "2026-11-25"
    assert params["adults"] == 2
    assert params["travelClass"] == "ECONOMY"
    assert params["currencyCode"] == "USD"
    assert "nonStop" not in params


def test_lap_and_seated_infants_are_summed(settings):
    """Amadeus counts every infant once; SerpApi splits them."""
    params = AmadeusProvider(settings).build_exact_params(
        exact_query(party=PassengerParty(adults=2, infants_in_seat=1, infants_on_lap=1))
    )
    assert params["infants"] == 2


def test_nonstop_preference_is_sent(settings):
    params = AmadeusProvider(settings).build_exact_params(
        exact_query(stops=StopsPreference.NONSTOP)
    )
    assert params["nonStop"] == "true"


def test_airline_filters_are_mutually_exclusive(settings):
    provider = AmadeusProvider(settings)
    both = provider.build_exact_params(exact_query(include_airlines="NH", exclude_airlines="UA"))
    assert both["includedAirlineCodes"] == "NH"
    assert "excludedAirlineCodes" not in both


def test_one_stop_max_is_refused_rather_than_silently_ignored(settings):
    """Amadeus has only a nonstop flag; pretending otherwise would mislead."""
    provider = AmadeusProvider(settings, transport=amadeus_transport({"data": []}))
    with pytest.raises(ProviderUnsupportedQueryError) as excinfo:
        provider.search_exact(exact_query(stops=StopsPreference.ONE_STOP_MAX))
    assert "nonstop" in str(excinfo.value.guidance()).lower()


def test_flexible_params_turn_a_month_into_a_date_range(settings):
    params = AmadeusProvider(settings).build_flexible_params(flexible_query())
    start, _, end = params["departureDate"].partition(",")
    assert start.endswith("-11-01") or start > start[:8]
    assert end.endswith("-11-30")
    assert params["duration"] == "14"
    assert params["oneWay"] == "false"


# ------------------------------------------------------------------ search
def test_search_exact_parses_offers(settings):
    payload = load_fixture("amadeus_flight_offers.json")
    recorder: list[httpx.Request] = []
    provider = AmadeusProvider(settings, transport=amadeus_transport(payload, recorder=recorder))

    result = provider.search_exact(exact_query())

    assert result.endpoint is EndpointType.AMADEUS_FLIGHT_OFFERS
    assert len(result.offers) == 2
    cheapest = min(result.offers, key=lambda o: o.price_amount)
    assert cheapest.price_amount == Decimal("988.00")
    assert cheapest.currency == "USD"
    assert cheapest.price_scope is PriceScopeLabel.PARTY_TOTAL
    # Two outbound segments means one stop.
    assert cheapest.stops == 1
    assert "KOREAN AIR" in cheapest.airlines
    assert recorder and "originLocationCode=SFO" in str(recorder[0].url)


def test_nonstop_offer_reports_zero_stops_and_a_duration(settings):
    payload = load_fixture("amadeus_flight_offers.json")
    provider = AmadeusProvider(settings, transport=amadeus_transport(payload))
    offers = provider.search_exact(exact_query()).offers
    nonstop = next(o for o in offers if o.price_amount == Decimal("1180.40"))
    assert nonstop.stops == 0
    assert nonstop.duration_minutes == 690
    assert nonstop.outbound_date == date(2026, 11, 14)
    assert nonstop.return_date == date(2026, 11, 25)
    assert nonstop.cabin == "economy"


def test_search_flexible_returns_a_date_grid_from_one_call(settings):
    """The whole point: a window costs one request, not one per date pair."""
    payload = load_fixture("amadeus_flight_dates.json")
    recorder: list[httpx.Request] = []
    provider = AmadeusProvider(settings, transport=amadeus_transport(payload, recorder=recorder))

    result = provider.search_flexible(flexible_query())

    assert result.endpoint is EndpointType.AMADEUS_FLIGHT_DATES
    assert len(result.offers) == 3
    assert len(recorder) == 1, "a whole date range must cost exactly one request"
    cheapest = min(result.offers, key=lambda o: o.price_amount)
    assert cheapest.price_amount == Decimal("912.30")
    assert cheapest.outbound_date == date(2026, 11, 15)
    assert cheapest.return_date == date(2026, 11, 26)


def test_an_empty_result_set_is_not_an_error(settings):
    """The test environment serves limited data; no route data is not a fault."""
    provider = AmadeusProvider(settings, transport=amadeus_transport({"data": []}))
    result = provider.search_exact(exact_query())
    assert result.offers == []


# ------------------------------------------------------------------ errors
def test_missing_credentials_are_refused_before_any_request():
    plain = Settings(
        flight_provider="amadeus", database_url="sqlite:///:memory:", app_timezone="UTC"
    )
    recorder: list[httpx.Request] = []
    provider = AmadeusProvider(plain, transport=amadeus_transport({}, recorder=recorder))
    with pytest.raises(ProviderMissingCredentialsError) as excinfo:
        provider.search_exact(exact_query())
    assert "AMADEUS_CLIENT_ID" in excinfo.value.guidance()
    assert recorder == [], "no request may be made without credentials"


def test_rejected_credentials_surface_as_an_auth_error(settings):
    provider = AmadeusProvider(settings, transport=amadeus_transport({}, token_status=401))
    with pytest.raises(ProviderAuthError) as excinfo:
        provider.search_exact(exact_query())
    assert "AMADEUS_CLIENT_ID" in excinfo.value.guidance()


def test_rate_limit_maps_to_a_retryable_error(settings):
    body = {"errors": [{"code": 38194, "title": "Too many requests", "detail": "Rate limit"}]}
    provider = AmadeusProvider(settings, transport=amadeus_transport(body, status=429))
    with pytest.raises(ProviderRateLimitError) as excinfo:
        provider.search_exact(exact_query())
    assert excinfo.value.retryable is True


def test_a_rejected_query_explains_itself(settings):
    body = {"errors": [{"code": 425, "title": "INVALID DATE", "detail": "Date is in the past"}]}
    provider = AmadeusProvider(settings, transport=amadeus_transport(body, status=400))
    with pytest.raises(ProviderUnsupportedQueryError) as excinfo:
        provider.search_exact(exact_query())
    assert "Date is in the past" in excinfo.value.guidance()


def test_a_response_without_data_is_malformed_not_empty(settings):
    provider = AmadeusProvider(settings, transport=amadeus_transport({"meta": {"count": 0}}))
    with pytest.raises(ProviderMalformedResponseError):
        provider.search_exact(exact_query())


# ------------------------------------------------------------------- token
def test_the_token_is_fetched_once_and_reused(settings):
    """A second search must not pay for a second sign-in."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/security/oauth2/token"):
            return httpx.Response(200, json=TOKEN_BODY)
        return httpx.Response(200, json={"data": []})

    provider = AmadeusProvider(settings, transport=httpx.MockTransport(handler))
    provider.search_exact(exact_query())
    provider.search_exact(exact_query(outbound_date=date(2026, 11, 16)))

    token_calls = [c for c in calls if c.endswith("/security/oauth2/token")]
    assert len(token_calls) == 1


def test_the_bearer_token_is_sent_and_the_secret_is_not(settings):
    recorder: list[httpx.Request] = []
    provider = AmadeusProvider(
        settings, transport=amadeus_transport({"data": []}, recorder=recorder)
    )
    provider.search_exact(exact_query())
    request = recorder[0]
    assert request.headers["Authorization"] == "Bearer test-token"
    assert "test-secret" not in str(request.url)


def test_account_status_reports_unknown_rather_than_inventing_a_quota(settings):
    """Amadeus exposes no quota endpoint; the guard keeps its configured limits."""
    status = AmadeusProvider(settings).account_status()
    assert status.searches_per_month is None
    assert status.searches_left is None
    assert "Amadeus" in (status.plan_name or "")


# --------------------------------------------------------------- utilities
@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("PT11H30M", 690),
        ("PT45M", 45),
        ("PT2H", 120),
        ("P1DT3H", 1620),
        ("nonsense", None),
        (None, None),
    ],
)
def test_parse_duration_minutes(value, expected):
    assert parse_duration_minutes(value) == expected


def test_cached_payload_replays_without_a_request(settings):
    """parse_payload must read back exactly what search produced."""
    payload = load_fixture("amadeus_flight_offers.json")
    recorder: list[httpx.Request] = []
    provider = AmadeusProvider(settings, transport=amadeus_transport(payload, recorder=recorder))

    replayed = provider.parse_payload(
        payload,
        flexible=False,
        market="us",
        currency="USD",
        query_fingerprint="fp",
        outbound_date=date(2026, 11, 14),
        return_date=date(2026, 11, 25),
    )

    assert recorder == [], "replaying a cached payload must not call the provider"
    assert len(replayed.offers) == 2
    assert replayed.query_fingerprint == "fp"


def test_client_environment_selects_the_documented_host():
    test_client = AmadeusClient("a", "b", environment="test")
    prod_client = AmadeusClient("a", "b", environment="production")
    assert test_client.base_url == "https://test.api.amadeus.com"
    assert prod_client.base_url == "https://api.amadeus.com"
