"""Live SerpApi checks.

Search budget for this whole module: **3 provider searches**
(1 exact + 1 flexible + 1 for the price-scope comparison's second leg, which
reuses the exact search above). The Account API is free and is not counted.

Run explicitly:

    FLIGHTNOTIFY_LIVE_TESTS=1 .venv/bin/pytest -m live tests/live -s
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest

from flightnotify.enums import Cabin, FlexDuration, StopsPreference
from flightnotify.providers.base import ExactSearchQuery, FlexibleSearchQuery, PassengerParty
from flightnotify.providers.serpapi import SerpApiProvider

pytestmark = pytest.mark.live

ROUTE = ("SFO", "LAX")


def _dates() -> tuple[date, date]:
    out = date.today() + timedelta(days=45)
    return out, out + timedelta(days=7)


def _exact(adults: int) -> ExactSearchQuery:
    out, back = _dates()
    return ExactSearchQuery(
        origin=ROUTE[0],
        destination=ROUTE[1],
        outbound_date=out,
        return_date=back,
        party=PassengerParty(adults=adults),
        cabin=Cabin.ECONOMY,
        stops=StopsPreference.ANY,
        currency="USD",
        market="us",
    )


def test_account_status_is_free_and_reports_the_plan(live_settings):
    """Costs 0 searches: SerpApi documents the Account API as free."""
    status = SerpApiProvider(live_settings).account_status()
    print(
        f"\n[live] plan={status.plan_name} per_month={status.searches_per_month} "
        f"left={status.searches_left} used={status.this_month_usage}"
    )
    assert status.searches_left is not None
    assert status.searches_left >= 0


def test_exact_search_returns_parseable_offers(live_settings):
    """Costs 1 provider search."""
    result = SerpApiProvider(live_settings).search_exact(_exact(adults=1))
    print(f"\n[live] exact offers={len(result.offers)} link={bool(result.search_link)}")
    assert result.request_count == 1
    for offer in result.offers:
        assert offer.price_amount > 0
        assert offer.currency == "USD"
        assert offer.outbound_date is not None
    if result.offers:
        assert result.search_link, "expected a provider-supplied search URL"


def test_flexible_search_returns_provider_chosen_dates(live_settings):
    """Costs 1 provider search."""
    next_month = (date.today().month % 12) + 1
    result = SerpApiProvider(live_settings).search_flexible(
        FlexibleSearchQuery(
            origin=ROUTE[0],
            destination=ROUTE[1],
            month=next_month,
            duration=FlexDuration.ONE_WEEK,
            party=PassengerParty(adults=1),
            cabin=Cabin.ECONOMY,
            stops=StopsPreference.ANY,
            currency="USD",
            market="us",
        )
    )
    print(
        f"\n[live] flexible offers={len(result.offers)} "
        f"dates={result.outbound_date}..{result.return_date}"
    )
    assert result.request_count == 1
    if result.offers:
        assert result.outbound_date is not None
        assert result.return_date is not None
        assert result.return_date > result.outbound_date


def test_price_scope_matches_the_configured_assumption(live_settings):
    """Costs 2 provider searches. Determines whether `price` is per traveler.

    SerpApi does not document this. Comparing an identical search at 1 adult
    and 2 adults settles it: a party total roughly doubles, a per-traveler
    price stays the same. The result is printed so the operator can set
    SERPAPI_PRICE_SCOPE with evidence rather than assumption.
    """
    provider = SerpApiProvider(live_settings)
    one = provider.search_exact(_exact(adults=1))
    two = provider.search_exact(_exact(adults=2))
    if not one.offers or not two.offers:
        pytest.skip("the provider returned no itineraries for this route/date")

    cheapest_one = min(o.price_amount for o in one.offers)
    cheapest_two = min(o.price_amount for o in two.offers)
    ratio = cheapest_two / cheapest_one if cheapest_one else Decimal(0)
    observed = "party_total" if ratio > Decimal("1.6") else "per_traveler"

    print(
        f"\n[live] 1 adult={cheapest_one} 2 adults={cheapest_two} ratio={ratio:.2f}\n"
        f"[live] observed price scope = {observed} "
        f"(configured SERPAPI_PRICE_SCOPE={live_settings.serpapi_price_scope.value})"
    )
    assert live_settings.serpapi_price_scope.value == observed, (
        f"SERPAPI_PRICE_SCOPE is set to {live_settings.serpapi_price_scope.value} but this "
        f"account returned prices that behave like {observed}. Update .env so per-traveler "
        "and party totals are not mislabelled."
    )
