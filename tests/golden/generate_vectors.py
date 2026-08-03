"""Emit behavioural golden vectors from the Python implementation.

The Cloudflare Worker is a port, not a rewrite: these vectors are what makes
that claim checkable. The Python domain code here stays the source of truth,
this script serializes its answers, and the Worker's test suite asserts byte
equality against the result. CI regenerates the file and fails on any diff, so
a drift in either implementation is a build failure rather than a silent
behaviour change months later.

Money crosses the boundary as integer minor units, because that is how D1
stores it and JavaScript has no decimal type to round-trip through.

    python -m tests.golden.generate_vectors > worker/test/golden/vectors.json
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from typing import Any

from flightnotify.domain.evaluation import SeriesState, evaluate
from flightnotify.domain.fingerprints import (
    alert_dedupe_key,
    config_fingerprint,
    itinerary_fingerprint,
    query_fingerprint,
)
from flightnotify.domain.pricing import (
    comparable_amount,
    format_money,
    money,
    normalize_price,
)
from flightnotify.enums import AlertType, PriceScopeLabel, ThresholdBasis


def cents(value: Decimal | None) -> int | None:
    """Decimal dollars -> integer minor units, exactly."""
    if value is None:
        return None
    return int(money(value).scaleb(2).to_integral_value())


# --------------------------------------------------------------- pricing
def pricing_vectors() -> list[dict[str, Any]]:
    cases: list[tuple[str, int, int]] = [
        # (reported amount as a decimal string, paying travelers)
        ("1962.00", 2),
        ("1962.00", 1),
        ("1042.00", 2),
        ("1000.00", 3),  # 333.333... -> half-up
        ("0.05", 2),  # 0.025 -> half-up to 0.03
        ("100.50", 1),
        ("999.99", 4),
        ("1.00", 7),
        ("12345.67", 3),
        ("0.01", 2),
    ]
    out = []
    for amount, travelers in cases:
        for scope in PriceScopeLabel:
            norm = normalize_price(Decimal(amount), scope=scope, paying_travelers=travelers)
            row: dict[str, Any] = {
                "reported_cents": cents(Decimal(amount)),
                "scope": scope.value,
                "paying_travelers": travelers,
                "party_total_cents": cents(norm.party_total),
                "party_total_is_calculated": norm.party_total_is_calculated,
                "per_traveler_cents": cents(norm.per_traveler),
                "per_traveler_is_calculated": norm.per_traveler_is_calculated,
                "comparable": {},
            }
            for basis in ThresholdBasis:
                row["comparable"][basis.value] = cents(
                    comparable_amount(
                        reported_amount=Decimal(amount),
                        scope=scope,
                        basis=basis,
                        paying_travelers=travelers,
                    )
                )
            out.append(row)
    return out


def format_money_vectors() -> list[dict[str, Any]]:
    cases = [
        ("1962.00", "USD"),
        ("1962.50", "USD"),
        ("0.00", "USD"),
        ("1234567.89", "USD"),
        ("980.00", "EUR"),
        ("980.00", "GBP"),
        ("125000.00", "JPY"),
        ("980.00", "CAD"),
        ("980.00", "AUD"),
        ("980.00", "CHF"),  # no symbol -> "980 CHF"
    ]
    return [
        {
            "amount_cents": cents(Decimal(a)),
            "currency": c,
            "expected": format_money(Decimal(a), c),
        }
        for a, c in cases
    ] + [{"amount_cents": None, "currency": "USD", "expected": format_money(None, "USD")}]


# ---------------------------------------------------------- fingerprints
#: The real production tracker's comparison payload. If the Worker cannot
#: reproduce this exact digest, importing that tracker would start a *new*
#: comparison series and silently orphan its price history.
PRODUCTION_CONFIG_PAYLOAD: dict[str, Any] = {
    "adults": 2,
    "cabin": "economy",
    "children": 0,
    "currency": "USD",
    "date_mode": "exact",
    "destination": "NRT",
    "exclude_airlines": None,
    "flex_duration": None,
    "flex_month": None,
    "flex_year": None,
    "include_airlines": None,
    "infants_in_seat": 0,
    "infants_on_lap": 0,
    "markets": ["us"],
    "max_nights": None,
    "min_nights": None,
    "origin": "SFO",
    "outbound_date": "2026-09-30",
    "return_date": "2026-10-08",
    "stops": "any",
    "window_outbound_end": None,
    "window_outbound_start": None,
    "window_return_end": None,
    "window_return_start": None,
}


def config_fingerprint_vectors() -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = [
        PRODUCTION_CONFIG_PAYLOAD,
        # Unicode name-ish content: exercises Python's ensure_ascii escaping.
        {"origin": "SFO", "destination": "NRT", "note": "Tōkyō ✈ 😀"},
        # None values are dropped by the canonicaliser, so these two must hash
        # identically -- a property the port has to preserve.
        {"a": 1, "b": None, "c": "x"},
        {"a": 1, "c": "x"},
        # Nested structures and ordering.
        {"z": [3, 2, 1], "a": {"n": None, "m": 2}, "b": True, "d": False},
        {"markets": ["gb", "us"], "adults": 2},
        {},
    ]
    return [{"payload": p, "expected": config_fingerprint(p)} for p in payloads]


def query_fingerprint_vectors() -> list[dict[str, Any]]:
    cases = [
        (
            "google_flights",
            {
                "engine": "google_flights",
                "departure_id": "SFO",
                "arrival_id": "NRT",
                "outbound_date": "2026-09-30",
                "return_date": "2026-10-08",
                "adults": 2,
                "currency": "USD",
                "gl": "us",
                "hl": "en",
                "api_key": "SECRET-MUST-BE-EXCLUDED",
                "output": "json",
                "no_cache": True,
            },
        ),
        ("google_flights", {"engine": "google_flights", "departure_id": "SFO"}),
    ]
    return [{"endpoint": e, "params": p, "expected": query_fingerprint(e, p)} for e, p in cases]


def itinerary_fingerprint_vectors() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = [
        {
            "origin": "SFO",
            "destination": "NRT",
            "outbound_date": date(2026, 9, 30),
            "return_date": date(2026, 10, 8),
            "flight_numbers": ["NH 107", "NH 108"],
            "departure_time": "2026-09-30 11:00",
            "arrival_time": "2026-10-01 14:35",
            "stops": 0,
            "market": "us",
        },
        {
            "origin": None,
            "destination": None,
            "outbound_date": None,
            "return_date": None,
            "flight_numbers": None,
            "departure_time": None,
            "arrival_time": None,
            "stops": None,
            "market": "gb",
        },
    ]
    out = []
    for c in cases:
        expected = itinerary_fingerprint(**c)
        serial = dict(c)
        for key in ("outbound_date", "return_date"):
            value = serial[key]
            serial[key] = value.isoformat() if value is not None else None
        out.append({"args": serial, "expected": expected})
    return out


def alert_dedupe_vectors() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = [
        {
            "tracker_id": 1,
            "config_version_id": 1,
            "alert_type": AlertType.NEW_LOW.value,
            "price": Decimal("1042.00"),
            "currency": "USD",
            "itinerary_fingerprint_value": "abc123",
            "outbound_date": date(2026, 9, 30),
            "return_date": date(2026, 10, 8),
            "market": "us",
        },
        # Trailing-zero equivalence: 1042 and 1042.00 must collapse to one key,
        # otherwise the same fare could alert twice.
        {
            "tracker_id": 1,
            "config_version_id": 1,
            "alert_type": AlertType.NEW_LOW.value,
            "price": Decimal("1042"),
            "currency": "USD",
            "itinerary_fingerprint_value": "abc123",
            "outbound_date": date(2026, 9, 30),
            "return_date": date(2026, 10, 8),
            "market": "us",
        },
        {
            "tracker_id": 1,
            "config_version_id": 1,
            "alert_type": AlertType.THRESHOLD.value,
            "price": Decimal("1300.50"),
            "currency": "USD",
            "itinerary_fingerprint_value": None,
            "outbound_date": None,
            "return_date": None,
            "market": None,
        },
        {
            "tracker_id": 7,
            "config_version_id": None,
            "alert_type": AlertType.THRESHOLD.value,
            "price": Decimal("0.01"),
            "currency": "JPY",
            "itinerary_fingerprint_value": "zz",
            "outbound_date": date(2027, 1, 1),
            "return_date": None,
            "market": "jp",
        },
    ]
    out = []
    for c in cases:
        expected = alert_dedupe_key(**c)
        serial = {
            "tracker_id": c["tracker_id"],
            "config_version_id": c["config_version_id"],
            "alert_type": c["alert_type"],
            "price_cents": cents(c["price"]),
            "currency": c["currency"],
            "itinerary_fingerprint_value": c["itinerary_fingerprint_value"],
            "outbound_date": (c["outbound_date"].isoformat() if c["outbound_date"] else None),
            "return_date": c["return_date"].isoformat() if c["return_date"] else None,
            "market": c["market"],
        }
        out.append({"args": serial, "expected": expected})
    return out


# ------------------------------------------------------------ evaluation
def evaluation_vectors() -> list[dict[str, Any]]:
    scenarios: list[dict[str, Any]] = [
        # baseline at/below threshold -> threshold alert, never a new low
        {
            "name": "baseline_under_threshold",
            "reported": "1042.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {},
        },
        {
            "name": "baseline_above_threshold",
            "reported": "1962.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {},
        },
        # exactly equal counts as reaching the threshold
        {
            "name": "exactly_at_threshold",
            "reported": "1300.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
        },
        {
            "name": "new_low_and_threshold_both",
            "reported": "1100.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
        },
        {
            "name": "not_a_new_low",
            "reported": "1500.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
        },
        {
            "name": "equal_to_series_low_is_not_new_low",
            "reported": "1400.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
        },
        {
            "name": "already_under_threshold_no_improvement",
            "reported": "1200.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {
                "has_baseline": True,
                "previous_best": "1200.00",
                "series_low": "1200.00",
                "previously_met_threshold": True,
            },
        },
        {
            "name": "per_traveler_basis",
            "reported": "1962.00",
            "scope": "party_total",
            "threshold": "900.00",
            "basis": "per_traveler",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1000.00", "series_low": "1000.00"},
        },
        {
            "name": "unknown_scope_uses_reported",
            "reported": "1962.00",
            "scope": "unknown",
            "threshold": "2000.00",
            "basis": "party",
            "travelers": 2,
            "state": {},
        },
        {
            "name": "min_drop_absolute_blocks",
            "reported": "1390.00",
            "scope": "party_total",
            "threshold": "1400.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
            "min_drop_absolute": "50.00",
        },
        {
            "name": "min_drop_percent_blocks",
            "reported": "1390.00",
            "scope": "party_total",
            "threshold": "1400.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
            "min_drop_percent": "10.00",
        },
        {
            "name": "alerts_disabled",
            "reported": "100.00",
            "scope": "party_total",
            "threshold": "1300.00",
            "basis": "party",
            "travelers": 2,
            "state": {"has_baseline": True, "previous_best": "1400.00", "series_low": "1400.00"},
            "alert_on_threshold": False,
            "alert_on_new_low": False,
        },
    ]

    out = []
    for s in scenarios:
        state = SeriesState(
            previous_best=(
                Decimal(s["state"]["previous_best"]) if s["state"].get("previous_best") else None
            ),
            series_low=(
                Decimal(s["state"]["series_low"]) if s["state"].get("series_low") else None
            ),
            has_baseline=bool(s["state"].get("has_baseline", False)),
            previously_met_threshold=bool(s["state"].get("previously_met_threshold", False)),
        )
        ev = evaluate(
            reported_amount=Decimal(s["reported"]),
            price_scope=s["scope"],
            threshold_amount=Decimal(s["threshold"]),
            threshold_basis=s["basis"],
            paying_travelers=s["travelers"],
            state=state,
            alert_on_threshold=bool(s.get("alert_on_threshold", True)),
            alert_on_new_low=bool(s.get("alert_on_new_low", True)),
            min_drop_absolute=(
                Decimal(s["min_drop_absolute"]) if s.get("min_drop_absolute") else None
            ),
            min_drop_percent=(
                Decimal(s["min_drop_percent"]) if s.get("min_drop_percent") else None
            ),
        )
        out.append(
            {
                "name": s["name"],
                "input": {
                    "reported_cents": cents(Decimal(s["reported"])),
                    "scope": s["scope"],
                    "threshold_cents": cents(Decimal(s["threshold"])),
                    "basis": s["basis"],
                    "paying_travelers": s["travelers"],
                    "state": {
                        "previous_best_cents": cents(state.previous_best),
                        "series_low_cents": cents(state.series_low),
                        "has_baseline": state.has_baseline,
                        "previously_met_threshold": state.previously_met_threshold,
                    },
                    "alert_on_threshold": bool(s.get("alert_on_threshold", True)),
                    "alert_on_new_low": bool(s.get("alert_on_new_low", True)),
                    "min_drop_absolute_cents": (
                        cents(Decimal(s["min_drop_absolute"]))
                        if s.get("min_drop_absolute")
                        else None
                    ),
                    "min_drop_percent_bp": (
                        int(Decimal(s["min_drop_percent"]) * 100)
                        if s.get("min_drop_percent")
                        else None
                    ),
                },
                "expected": {
                    "comparable_cents": cents(ev.comparable),
                    "is_baseline": ev.is_baseline,
                    "meets_threshold": ev.meets_threshold,
                    "is_new_low": ev.is_new_low,
                    "drop_absolute_cents": cents(ev.drop_absolute),
                    "drop_percent_bp": (
                        int(ev.drop_percent * 100) if ev.drop_percent is not None else None
                    ),
                    "alerts_to_send": [a.value for a in ev.alerts_to_send],
                },
            }
        )
    return out


def build() -> dict[str, Any]:
    return {
        "_comment": (
            "Generated by tests/golden/generate_vectors.py from the Python "
            "implementation. Do not hand-edit; run `make golden` to refresh."
        ),
        "pricing": pricing_vectors(),
        "format_money": format_money_vectors(),
        "config_fingerprint": config_fingerprint_vectors(),
        "query_fingerprint": query_fingerprint_vectors(),
        "itinerary_fingerprint": itinerary_fingerprint_vectors(),
        "alert_dedupe_key": alert_dedupe_vectors(),
        "evaluation": evaluation_vectors(),
    }


if __name__ == "__main__":
    print(json.dumps(build(), indent=2, sort_keys=True, ensure_ascii=False))
