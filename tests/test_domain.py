"""Pricing normalization, date-pair generation and threshold/low evaluation."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from flightnotify.domain.dates import (
    DateWindowError,
    bisection_order,
    generate_pairs,
    ordered_pairs,
)
from flightnotify.domain.evaluation import SeriesState, evaluate
from flightnotify.domain.fingerprints import (
    alert_dedupe_key,
    itinerary_fingerprint,
    query_fingerprint,
)
from flightnotify.domain.pricing import comparable_amount, format_money, normalize_price
from flightnotify.enums import AlertType, PriceScopeLabel, ThresholdBasis


# ------------------------------------------------------------ price scope
def test_party_total_derives_per_traveler_and_labels_it_calculated():
    normalized = normalize_price(
        Decimal("1248"), scope=PriceScopeLabel.PARTY_TOTAL, paying_travelers=2
    )
    assert normalized.party_total == Decimal("1248.00")
    assert normalized.party_total_is_calculated is False
    assert normalized.per_traveler == Decimal("624.00")
    assert normalized.per_traveler_is_calculated is True


def test_per_traveler_scope_derives_party_total_and_labels_it_calculated():
    normalized = normalize_price(
        Decimal("624"), scope=PriceScopeLabel.PER_TRAVELER, paying_travelers=2
    )
    assert normalized.per_traveler == Decimal("624.00")
    assert normalized.per_traveler_is_calculated is False
    assert normalized.party_total == Decimal("1248.00")
    assert normalized.party_total_is_calculated is True


def test_unknown_scope_never_multiplies_or_divides():
    normalized = normalize_price(Decimal("1000"), scope=PriceScopeLabel.UNKNOWN, paying_travelers=4)
    assert normalized.party_total is None
    assert normalized.per_traveler is None
    assert normalized.reported_amount == Decimal("1000.00")
    # The threshold comparison falls back to the reported value as-is.
    assert comparable_amount(
        reported_amount=Decimal("1000"),
        scope=PriceScopeLabel.UNKNOWN,
        basis=ThresholdBasis.PER_TRAVELER,
        paying_travelers=4,
    ) == Decimal("1000.00")


def test_lap_infants_are_excluded_from_the_per_traveler_divisor():
    # 2 adults + 1 lap infant = 2 paying travelers, not 3.
    normalized = normalize_price(
        Decimal("1200"), scope=PriceScopeLabel.PARTY_TOTAL, paying_travelers=2
    )
    assert normalized.per_traveler == Decimal("600.00")


def test_round_trip_through_both_bases_does_not_double_count():
    party = normalize_price(Decimal("1500"), scope=PriceScopeLabel.PARTY_TOTAL, paying_travelers=3)
    back = normalize_price(
        party.per_traveler, scope=PriceScopeLabel.PER_TRAVELER, paying_travelers=3
    )
    assert back.party_total == Decimal("1500.00")


def test_format_money():
    assert format_money(Decimal("1248"), "USD") == "$1,248"
    assert format_money(Decimal("1248.50"), "USD") == "$1,248.50"
    assert format_money(Decimal("990"), "SEK") == "990 SEK"
    assert format_money(None, "USD") == "-"


# ----------------------------------------------------------- date windows
def test_bisection_order_samples_across_the_window_first():
    assert bisection_order(7) == [3, 1, 5, 0, 2, 4, 6]
    assert bisection_order(0) == []
    assert sorted(bisection_order(20)) == list(range(20))


def test_generate_pairs_from_return_window():
    pairs = generate_pairs(
        outbound_start=date(2026, 10, 1),
        outbound_end=date(2026, 10, 3),
        return_start=date(2026, 10, 8),
        return_end=date(2026, 10, 10),
    )
    assert len(pairs) == 9
    assert all(pair.inbound > pair.outbound for pair in pairs)
    assert pairs[0].outbound == date(2026, 10, 1)


def test_generate_pairs_from_nights_range():
    pairs = generate_pairs(
        outbound_start=date(2026, 10, 1),
        outbound_end=date(2026, 10, 2),
        min_nights=7,
        max_nights=9,
    )
    assert len(pairs) == 6
    assert {pair.nights for pair in pairs} == {7, 8, 9}


def test_nights_filter_applies_to_a_return_window_too():
    pairs = generate_pairs(
        outbound_start=date(2026, 10, 1),
        outbound_end=date(2026, 10, 1),
        return_start=date(2026, 10, 2),
        return_end=date(2026, 10, 20),
        min_nights=10,
        max_nights=12,
    )
    assert {pair.nights for pair in pairs} == {10, 11, 12}


def test_past_outbound_dates_are_excluded():
    today = date(2026, 8, 1)
    pairs = generate_pairs(
        outbound_start=date(2026, 7, 20),
        outbound_end=date(2026, 8, 3),
        min_nights=3,
        max_nights=3,
        not_before=today,
    )
    assert min(pair.outbound for pair in pairs) == today


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(outbound_start=date(2026, 10, 5), outbound_end=date(2026, 10, 1), min_nights=2),
        dict(
            outbound_start=date(2026, 10, 1),
            outbound_end=date(2026, 10, 2),
            min_nights=5,
            max_nights=3,
        ),
        dict(
            outbound_start=date(2026, 10, 10),
            outbound_end=date(2026, 10, 11),
            return_start=date(2026, 10, 1),
            return_end=date(2026, 10, 5),
        ),
        dict(outbound_start=date(2026, 10, 1), outbound_end=date(2026, 10, 2)),
    ],
)
def test_invalid_windows_raise_with_guidance(kwargs):
    with pytest.raises(DateWindowError) as excinfo:
        generate_pairs(**kwargs)
    assert str(excinfo.value)


def test_oversized_window_is_refused_rather_than_truncated():
    with pytest.raises(DateWindowError) as excinfo:
        generate_pairs(
            outbound_start=date(2026, 1, 1),
            outbound_end=date(2026, 12, 31),
            min_nights=1,
            max_nights=30,
            max_candidates=2000,
        )
    assert "Narrow the outbound window" in str(excinfo.value)


def test_ordered_pairs_are_stable_and_complete():
    pairs = generate_pairs(
        outbound_start=date(2026, 10, 1),
        outbound_end=date(2026, 10, 8),
        min_nights=7,
        max_nights=7,
    )
    first = ordered_pairs(pairs)
    second = ordered_pairs(pairs)
    assert [p.outbound for _, p in first] == [p.outbound for _, p in second]
    assert sorted(position for position, _ in first) == list(range(len(pairs)))
    # The first candidate is not simply the earliest date.
    assert first[0][1].outbound != min(p.outbound for p in pairs)


# ------------------------------------------------------------- evaluation
def base_kwargs(**overrides):
    defaults = dict(
        reported_amount=Decimal("1200"),
        price_scope=PriceScopeLabel.PARTY_TOTAL,
        threshold_amount=Decimal("1300"),
        threshold_basis=ThresholdBasis.PARTY,
        paying_travelers=2,
        state=SeriesState(),
    )
    defaults.update(overrides)
    return defaults


def test_baseline_may_alert_on_threshold_but_never_as_a_drop():
    result = evaluate(**base_kwargs())
    assert result.is_baseline is True
    assert result.meets_threshold is True
    assert AlertType.THRESHOLD in result.alerts_to_send
    assert AlertType.NEW_LOW not in result.alerts_to_send
    assert "baseline" in result.reason_for(AlertType.NEW_LOW).lower()


def test_price_exactly_at_threshold_counts_as_reached():
    result = evaluate(**base_kwargs(reported_amount=Decimal("1300")))
    assert result.meets_threshold is True


def test_new_low_requires_a_strictly_lower_fare():
    state = SeriesState(
        previous_best=Decimal("1250"), series_low=Decimal("1250"), has_baseline=True
    )
    same = evaluate(**base_kwargs(reported_amount=Decimal("1250"), state=state))
    assert same.is_new_low is False
    lower = evaluate(**base_kwargs(reported_amount=Decimal("1100"), state=state))
    assert lower.is_new_low is True
    assert lower.drop_absolute == Decimal("150.00")
    assert AlertType.NEW_LOW in lower.alerts_to_send


def test_threshold_realerts_after_rising_above_and_falling_back():
    # Previously under threshold, price rose above, now back below.
    above = evaluate(
        **base_kwargs(
            reported_amount=Decimal("1400"),
            state=SeriesState(
                previous_best=Decimal("1200"),
                series_low=Decimal("1200"),
                has_baseline=True,
                previously_met_threshold=True,
            ),
        )
    )
    assert above.meets_threshold is False
    assert AlertType.THRESHOLD not in above.alerts_to_send

    back_below = evaluate(
        **base_kwargs(
            reported_amount=Decimal("1290"),
            state=SeriesState(
                previous_best=Decimal("1400"),
                series_low=Decimal("1200"),
                has_baseline=True,
                previously_met_threshold=False,
            ),
        )
    )
    assert AlertType.THRESHOLD in back_below.alerts_to_send


def test_unchanged_under_threshold_does_not_realert():
    result = evaluate(
        **base_kwargs(
            reported_amount=Decimal("1200"),
            state=SeriesState(
                previous_best=Decimal("1200"),
                series_low=Decimal("1200"),
                has_baseline=True,
                previously_met_threshold=True,
            ),
        )
    )
    assert AlertType.THRESHOLD not in result.alerts_to_send
    assert "already under threshold" in result.reason_for(AlertType.THRESHOLD).lower()


def test_minimum_absolute_drop_blocks_a_small_improvement():
    state = SeriesState(
        previous_best=Decimal("1200"), series_low=Decimal("1200"), has_baseline=True
    )
    result = evaluate(
        **base_kwargs(reported_amount=Decimal("1195"), state=state, min_drop_absolute=Decimal("50"))
    )
    assert result.is_new_low is True
    assert AlertType.NEW_LOW not in result.alerts_to_send
    assert "below the configured minimum" in result.reason_for(AlertType.NEW_LOW)


def test_minimum_percent_drop_blocks_a_small_improvement():
    state = SeriesState(
        previous_best=Decimal("1000"), series_low=Decimal("1000"), has_baseline=True
    )
    result = evaluate(
        **base_kwargs(reported_amount=Decimal("990"), state=state, min_drop_percent=Decimal("5"))
    )
    assert AlertType.NEW_LOW not in result.alerts_to_send


def test_per_traveler_basis_uses_the_calculated_value():
    result = evaluate(
        **base_kwargs(
            reported_amount=Decimal("1200"),
            threshold_amount=Decimal("650"),
            threshold_basis=ThresholdBasis.PER_TRAVELER,
            paying_travelers=2,
        )
    )
    assert result.comparable == Decimal("600.00")
    assert result.meets_threshold is True


def test_disabled_alert_types_are_reported_with_a_reason():
    result = evaluate(**base_kwargs(alert_on_threshold=False, alert_on_new_low=False))
    assert result.alerts_to_send == []
    assert "turned off" in result.reason_for(AlertType.THRESHOLD)


# ----------------------------------------------------------- fingerprints
def test_query_fingerprint_excludes_the_api_key():
    a = query_fingerprint("google_flights", {"departure_id": "SFO", "api_key": "secret-a"})
    b = query_fingerprint("google_flights", {"departure_id": "SFO", "api_key": "secret-b"})
    assert a == b


def test_query_fingerprint_changes_with_a_meaningful_parameter():
    a = query_fingerprint("google_flights", {"departure_id": "SFO", "gl": "us"})
    b = query_fingerprint("google_flights", {"departure_id": "SFO", "gl": "gb"})
    assert a != b


def test_itinerary_fingerprint_is_stable_and_specific():
    kwargs = dict(
        origin="SFO",
        destination="NRT",
        outbound_date=date(2026, 10, 12),
        return_date=date(2026, 10, 20),
        flight_numbers=["NH 8"],
        departure_time="2026-10-12 11:05",
        arrival_time="2026-10-13 14:40",
        stops=0,
        market="us",
    )
    assert itinerary_fingerprint(**kwargs) == itinerary_fingerprint(**kwargs)
    assert itinerary_fingerprint(**{**kwargs, "market": "gb"}) != itinerary_fingerprint(**kwargs)


def test_alert_dedupe_key_quantizes_price():
    kwargs = dict(
        tracker_id=1,
        config_version_id=2,
        alert_type="new_low",
        currency="USD",
        itinerary_fingerprint_value="abc",
        outbound_date=date(2026, 10, 12),
        return_date=date(2026, 10, 20),
        market="us",
    )
    assert alert_dedupe_key(price=Decimal("1248"), **kwargs) == alert_dedupe_key(
        price=Decimal("1248.00"), **kwargs
    )
    assert alert_dedupe_key(price=Decimal("1248"), **kwargs) != alert_dedupe_key(
        price=Decimal("1247"), **kwargs
    )
