"""Stable hashes for provider queries, itineraries, configs and alerts.

Every fingerprint is a SHA-256 hex digest over a canonical JSON encoding, so
the same logical input always produces the same key across processes and
restarts.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from decimal import Decimal
from typing import Any


def _canonical(value: Any) -> Any:
    if isinstance(value, Decimal):
        # Quantize so 100 and 100.00 hash identically.
        return format(value.normalize(), "f")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _canonical(v) for k, v in sorted(value.items()) if v is not None}
    if isinstance(value, list | tuple):
        return [_canonical(v) for v in value]
    if isinstance(value, bool | int | float | str) or value is None:
        return value
    return str(value)


def digest(payload: dict[str, Any]) -> str:
    blob = json.dumps(_canonical(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def query_fingerprint(endpoint: str, params: dict[str, Any]) -> str:
    """Identify a provider request. The API key is never part of the key."""
    scrubbed = {k: v for k, v in params.items() if k not in {"api_key", "output", "no_cache"}}
    return digest({"endpoint": endpoint, "params": scrubbed})


def itinerary_fingerprint(
    *,
    origin: str | None,
    destination: str | None,
    outbound_date: date | None,
    return_date: date | None,
    flight_numbers: list[str] | None,
    departure_time: str | None,
    arrival_time: str | None,
    stops: int | None,
    market: str,
) -> str:
    """Identify a specific itinerary so repeats can be deduplicated."""
    return digest(
        {
            "origin": origin,
            "destination": destination,
            "outbound_date": outbound_date,
            "return_date": return_date,
            "flight_numbers": list(flight_numbers or []),
            "departure_time": departure_time,
            "arrival_time": arrival_time,
            "stops": stops,
            "market": market,
        }
    )


def config_fingerprint(payload: dict[str, Any]) -> str:
    """Identify a comparison series (comparison-relevant settings only)."""
    return digest(payload)


def alert_dedupe_key(
    *,
    tracker_id: int,
    config_version_id: int | None,
    alert_type: str,
    price: Decimal,
    currency: str,
    itinerary_fingerprint_value: str | None,
    outbound_date: date | None,
    return_date: date | None,
    market: str | None,
) -> str:
    """A repeat of the same finding must map to the same key."""
    return digest(
        {
            "tracker_id": tracker_id,
            "config_version_id": config_version_id,
            "alert_type": alert_type,
            "price": price.quantize(Decimal("0.01")),
            "currency": currency,
            "itinerary": itinerary_fingerprint_value,
            "outbound_date": outbound_date,
            "return_date": return_date,
            "market": market,
        }
    )
