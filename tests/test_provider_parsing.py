"""SerpApi request construction and response parsing."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from flightnotify.enums import Cabin, EndpointType, FlexDuration, PriceScopeLabel, StopsPreference
from flightnotify.providers import (
    ExactSearchQuery,
    FlexibleSearchQuery,
    ProviderAuthError,
    ProviderRateLimitError,
)
from flightnotify.providers.base import PassengerParty
from flightnotify.providers.errors import (
    ProviderMissingCredentialsError,
    ProviderQuotaExhaustedError,
    ProviderUnsupportedQueryError,
)
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.providers.serpapi.parsing import (
    parse_google_flights,
    parse_google_travel_explore,
    sanitize_excerpt,
)
from flightnotify.providers.serpapi.provider import validate_party
from tests.conftest import json_transport, sequence_transport

PARTY = PassengerParty(adults=2)


def exact_query(**overrides) -> ExactSearchQuery:
    defaults = dict(
        origin="SFO",
        destination="NRT",
        outbound_date=date(2026, 10, 12),
        return_date=date(2026, 10, 20),
        party=PARTY,
        cabin=Cabin.ECONOMY,
        stops=StopsPreference.ANY,
        currency="USD",
        market="us",
    )
    defaults.update(overrides)
    return ExactSearchQuery(**defaults)


# --------------------------------------------------------------- exact mode
def test_exact_request_parameters_match_documented_encoding(settings):
    provider = SerpApiProvider(settings, transport=json_transport({}))
    params = provider.build_exact_params(
        exact_query(cabin=Cabin.BUSINESS, stops=StopsPreference.NONSTOP)
    )
    assert params["engine"] == "google_flights"
    assert params["type"] == 1  # round trip
    assert params["travel_class"] == 3  # business
    assert params["stops"] == 1  # nonstop only
    assert params["departure_id"] == "SFO"
    assert params["arrival_id"] == "NRT"
    assert params["outbound_date"] == "2026-10-12"
    assert params["return_date"] == "2026-10-20"
    assert params["adults"] == 2
    assert params["gl"] == "us"
    assert params["currency"] == "USD"
    assert "api_key" not in params  # credentials are added by the transport layer


def test_include_and_exclude_airlines_are_never_sent_together(settings):
    provider = SerpApiProvider(settings, transport=json_transport({}))
    params = provider.build_exact_params(
        exact_query(include_airlines="NH,UA", exclude_airlines="F9")
    )
    assert params["include_airlines"] == "NH,UA"
    assert "exclude_airlines" not in params


def test_parse_exact_response(flights_payload):
    result = parse_google_flights(
        flights_payload,
        market="us",
        currency="USD",
        query_fingerprint="fp",
        price_scope=PriceScopeLabel.PARTY_TOTAL,
        outbound_date=date(2026, 10, 12),
        return_date=date(2026, 10, 20),
    )
    assert result.endpoint is EndpointType.GOOGLE_FLIGHTS
    assert len(result.offers) == 2

    cheapest = min(result.offers, key=lambda o: o.price_amount)
    assert cheapest.price_amount == Decimal("1248")
    assert cheapest.currency == "USD"
    assert cheapest.origin == "SFO"
    assert cheapest.destination == "NRT"
    assert cheapest.stops == 0
    assert cheapest.airlines == ["ANA"]
    assert cheapest.flight_numbers == ["NH 8"]
    assert cheapest.cabin == "Economy"
    assert cheapest.duration_minutes == 655
    assert cheapest.outbound_date == date(2026, 10, 12)
    assert cheapest.return_date == date(2026, 10, 20)
    assert cheapest.search_link.startswith("https://www.google.com/travel/flights")
    # A booking link needs a second billable search, so none is invented.
    assert cheapest.booking_link is None

    connecting = max(result.offers, key=lambda o: o.price_amount)
    assert connecting.stops == 1
    assert connecting.flight_numbers == ["AS 1234", "JL 69"]
    assert connecting.layovers[0]["id"] == "SEA"


def test_parse_exact_skips_itineraries_without_a_price():
    payload = {"other_flights": [{"flights": [], "price": None}, {"flights": [], "price": 500}]}
    result = parse_google_flights(
        payload,
        market="us",
        currency="USD",
        query_fingerprint="fp",
        price_scope=PriceScopeLabel.PARTY_TOTAL,
        outbound_date=None,
        return_date=None,
    )
    assert len(result.offers) == 1
    assert result.offers[0].price_amount == Decimal("500")


# ------------------------------------------------------------ flexible mode
def test_flexible_request_parameters(settings):
    provider = SerpApiProvider(settings, transport=json_transport({}))
    params = provider.build_flexible_params(
        FlexibleSearchQuery(
            origin="SFO",
            destination="NRT",
            month=11,
            duration=FlexDuration.TWO_WEEKS,
            party=PARTY,
            cabin=Cabin.ECONOMY,
            stops=StopsPreference.ANY,
            currency="USD",
            market="us",
        )
    )
    assert params["engine"] == "google_travel_explore"
    assert params["month"] == 11
    assert params["travel_duration"] == 3  # 2 weeks
    assert params["travel_mode"] == 1  # flights only
    assert params["arrival_id"] == "NRT"


def test_parse_flexible_preserves_provider_dates(explore_payload):
    result = parse_google_travel_explore(
        explore_payload,
        market="us",
        currency="USD",
        query_fingerprint="fp",
        price_scope=PriceScopeLabel.PARTY_TOTAL,
    )
    assert result.endpoint is EndpointType.GOOGLE_TRAVEL_EXPLORE
    # The dates come from the provider and are not recomputed locally.
    assert result.outbound_date == date(2026, 11, 7)
    assert result.return_date == date(2026, 11, 14)
    assert result.search_link == explore_payload["google_flights_link"]
    assert [o.price_amount for o in result.offers] == [Decimal("986"), Decimal("1104")]
    assert result.offers[0].outbound_date == date(2026, 11, 7)
    assert result.offers[0].return_date == date(2026, 11, 14)
    assert result.offers[0].stops == 0
    assert result.offers[0].airlines == ["ZIPAIR"]


def test_flexible_destination_mode_is_rejected():
    from flightnotify.providers.errors import ProviderMalformedResponseError

    with pytest.raises(ProviderMalformedResponseError):
        parse_google_travel_explore(
            {"destinations": [{"name": "Tokyo"}]},
            market="us",
            currency="USD",
            query_fingerprint="fp",
            price_scope=PriceScopeLabel.PARTY_TOTAL,
        )


# ------------------------------------------------------------------- errors
def test_no_results_is_a_successful_empty_run(settings, no_results_payload):
    provider = SerpApiProvider(settings, transport=json_transport(no_results_payload))
    result = provider.search_exact(exact_query())
    assert result.offers == []
    assert result.request_count == 1  # counted conservatively


def test_invalid_key_raises_auth_error(settings):
    provider = SerpApiProvider(
        settings, transport=json_transport({"error": "Invalid API key."}, status_code=401)
    )
    with pytest.raises(ProviderAuthError) as excinfo:
        provider.search_exact(exact_query())
    assert "stored history is unchanged" in excinfo.value.guidance().lower()


def test_rate_limit_is_surfaced_with_retry_after(settings):
    provider = SerpApiProvider(
        settings,
        transport=json_transport(
            {"error": "Too many requests"}, status_code=429, headers={"Retry-After": "12"}
        ),
    )
    with pytest.raises(ProviderRateLimitError) as excinfo:
        provider.search_exact(exact_query())
    assert excinfo.value.retry_after_seconds == 12.0


def test_quota_exhausted_is_distinct_from_rate_limit(settings):
    provider = SerpApiProvider(
        settings,
        transport=json_transport(
            {"error": "Your account has run out of searches."}, status_code=429
        ),
    )
    with pytest.raises(ProviderQuotaExhaustedError):
        provider.search_exact(exact_query())


def test_unsupported_query_message_is_actionable(settings):
    provider = SerpApiProvider(
        settings, transport=json_transport({"error": "departure_id is not a valid airport"})
    )
    with pytest.raises(ProviderUnsupportedQueryError) as excinfo:
        provider.search_exact(exact_query())
    assert "history is unchanged" in excinfo.value.guidance()


def test_transient_server_error_is_retried_then_succeeds(settings, flights_payload):
    calls: list = []
    transport = sequence_transport(
        [(502, {"error": "bad gateway"}), (200, flights_payload)], recorder=calls
    )
    from flightnotify.providers.serpapi.client import SerpApiClient

    client = SerpApiClient("k", transport=transport, sleep=lambda _s: None)
    provider = SerpApiProvider(settings, client=client)
    result = provider.search_exact(exact_query())
    assert len(calls) == 2
    assert len(result.offers) == 2


def test_missing_credentials_never_calls_the_provider():
    from flightnotify.config import Settings

    empty = Settings(serpapi_api_key="", database_url="sqlite:///:memory:")
    provider = SerpApiProvider(empty)
    assert provider.is_configured() is False
    with pytest.raises(ProviderMissingCredentialsError):
        provider.search_exact(exact_query())


# ------------------------------------------------------------------ account
def test_account_status_parsing(settings, account_payload):
    provider = SerpApiProvider(settings, transport=json_transport(account_payload))
    status = provider.account_status()
    assert status.searches_per_month == 250
    assert status.searches_left == 198
    assert status.this_month_usage == 52
    assert status.plan_name == "Free Plan"
    assert status.rate_limit_per_hour == 50
    # The email is masked, never echoed verbatim.
    assert status.account_email_masked != account_payload["account_email"]
    assert status.account_email_masked.endswith("@example.invalid")


def test_sanitized_excerpt_drops_credentials_and_bulk(flights_payload):
    excerpt = sanitize_excerpt(flights_payload)
    blob = str(excerpt)
    assert "api_key" not in blob
    assert "best_flights" not in excerpt
    assert excerpt["search_metadata"]["id"] == flights_payload["search_metadata"]["id"]


# --------------------------------------------------------------- validation
@pytest.mark.parametrize(
    ("party", "expect_problem"),
    [
        ((1, 0, 0, 0), False),
        ((0, 1, 0, 0), True),  # no adult
        ((5, 5, 0, 0), True),  # over the 9-passenger cap
        ((1, 0, 0, 2), True),  # more lap infants than adults
        ((2, 2, 1, 1), False),
    ],
)
def test_validate_party(party, expect_problem):
    problems = validate_party(*party)
    assert bool(problems) is expect_problem
