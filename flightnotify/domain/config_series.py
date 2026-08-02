"""Comparison-series identity for a tracker.

Only settings that change what a fare *means* belong here. Changing the
threshold, alert preferences or schedule keeps the existing price history
comparable; changing the route, passengers, cabin, currency, markets or dates
starts a new series so incompatible observations are never silently compared.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .fingerprints import config_fingerprint

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..models import Tracker

#: Fields whose values define a comparison series.
COMPARISON_FIELDS: tuple[str, ...] = (
    "origin",
    "destination",
    "adults",
    "children",
    "infants_in_seat",
    "infants_on_lap",
    "cabin",
    "stops",
    "include_airlines",
    "exclude_airlines",
    "currency",
    "date_mode",
    "outbound_date",
    "return_date",
    "flex_month",
    "flex_year",
    "flex_duration",
    "window_outbound_start",
    "window_outbound_end",
    "window_return_start",
    "window_return_end",
    "min_nights",
    "max_nights",
)

#: Human labels used when explaining why history was split.
FIELD_LABELS: dict[str, str] = {
    "origin": "origin airport",
    "destination": "destination airport",
    "adults": "adults",
    "children": "children",
    "infants_in_seat": "infants in seat",
    "infants_on_lap": "lap infants",
    "cabin": "cabin",
    "stops": "stops preference",
    "include_airlines": "included airlines",
    "exclude_airlines": "excluded airlines",
    "currency": "currency",
    "date_mode": "date mode",
    "outbound_date": "outbound date",
    "return_date": "return date",
    "flex_month": "flexible month",
    "flex_year": "flexible year",
    "flex_duration": "flexible trip length",
    "window_outbound_start": "outbound window start",
    "window_outbound_end": "outbound window end",
    "window_return_start": "return window start",
    "window_return_end": "return window end",
    "min_nights": "minimum nights",
    "max_nights": "maximum nights",
    "markets": "country markets",
}


def comparison_payload(tracker: Tracker) -> dict[str, Any]:
    """Immutable snapshot of everything that defines the comparison series."""
    payload: dict[str, Any] = {}
    for field_name in COMPARISON_FIELDS:
        value = getattr(tracker, field_name)
        payload[field_name] = value.isoformat() if hasattr(value, "isoformat") else value
    payload["markets"] = sorted(tracker.market_codes)
    return payload


def series_fingerprint(tracker: Tracker) -> str:
    return config_fingerprint(comparison_payload(tracker))


def describe_changes(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Human-readable list of the comparison-relevant fields that changed."""
    changes: list[str] = []
    for key in sorted(set(old) | set(new)):
        before, after = old.get(key), new.get(key)
        if before == after:
            continue
        label = FIELD_LABELS.get(key, key.replace("_", " "))
        changes.append(f"{label}: {_render(before)} → {_render(after)}")
    return changes


def _render(value: Any) -> str:
    if value is None or value == "":
        return "not set"
    if isinstance(value, list):
        return ", ".join(str(v) for v in value) or "none"
    return str(value)
