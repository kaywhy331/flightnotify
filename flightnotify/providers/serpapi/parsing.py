"""Normalization of SerpApi responses into provider-neutral offers.

Nothing here invents a value. Fields absent from the provider payload stay
``None`` rather than being filled with a plausible default, and links are only
carried through when SerpApi supplied them.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from ...enums import EndpointType, PriceScopeLabel
from ..base import NormalizedOffer, ProviderResult
from ..errors import ProviderMalformedResponseError

log = logging.getLogger(__name__)

#: Keys copied into the stored debugging excerpt. Deliberately excludes
#: anything that could carry a credential.
_SAFE_METADATA_KEYS = (
    "id",
    "status",
    "created_at",
    "processed_at",
    "total_time_taken",
    "google_flights_url",
    "google_travel_explore_url",
)
_SAFE_PARAM_KEYS = (
    "engine",
    "departure_id",
    "arrival_id",
    "outbound_date",
    "return_date",
    "type",
    "travel_class",
    "adults",
    "children",
    "infants_in_seat",
    "infants_on_lap",
    "stops",
    "currency",
    "gl",
    "hl",
    "month",
    "travel_duration",
    "include_airlines",
    "exclude_airlines",
)


def sanitize_excerpt(payload: dict[str, Any]) -> dict[str, Any]:
    """A credential-free slice of the response, safe to persist."""
    metadata = payload.get("search_metadata")
    params = payload.get("search_parameters")
    excerpt: dict[str, Any] = {}
    if isinstance(metadata, dict):
        excerpt["search_metadata"] = {k: metadata[k] for k in _SAFE_METADATA_KEYS if k in metadata}
    if isinstance(params, dict):
        excerpt["search_parameters"] = {k: params[k] for k in _SAFE_PARAM_KEYS if k in params}
    insights = payload.get("price_insights")
    if isinstance(insights, dict):
        excerpt["price_insights"] = {
            k: insights.get(k) for k in ("lowest_price", "price_level", "typical_price_range")
        }
    return excerpt


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None
    return amount if amount > 0 else None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _response_time(payload: dict[str, Any]) -> datetime:
    metadata = payload.get("search_metadata")
    if isinstance(metadata, dict):
        for key in ("processed_at", "created_at"):
            raw = metadata.get(key)
            if isinstance(raw, str):
                for fmt in ("%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
                    try:
                        return datetime.strptime(raw, fmt).replace(tzinfo=UTC)
                    except ValueError:
                        continue
    return datetime.now(UTC)


# ---------------------------------------------------------------------------
# Google Flights (exact dates)
# ---------------------------------------------------------------------------
def parse_google_flights(
    payload: dict[str, Any],
    *,
    market: str,
    currency: str,
    query_fingerprint: str,
    price_scope: PriceScopeLabel,
    outbound_date: date | None,
    return_date: date | None,
) -> ProviderResult:
    """Normalize a ``engine=google_flights`` response.

    For a round trip the first response lists *outbound* options priced as the
    complete round trip; enumerating individual return legs needs a second
    billable search per itinerary, which FlightNotify deliberately does not
    spend. The provider's own search URL is carried through as the link.
    """
    if not isinstance(payload, dict):
        raise ProviderMalformedResponseError("Google Flights response was not a JSON object.")

    groups: list[dict[str, Any]] = []
    for key in ("best_flights", "other_flights"):
        value = payload.get(key)
        if isinstance(value, list):
            groups.extend(item for item in value if isinstance(item, dict))

    metadata = payload.get("search_metadata")
    search_link = metadata.get("google_flights_url") if isinstance(metadata, dict) else None

    params = payload.get("search_parameters")
    if isinstance(params, dict):
        # The caller's requested dates win: for an exact-date search FlightNotify
        # knows which combination it asked for, and echoing the response back
        # over it would mislabel the run. The echo is only a fallback.
        outbound_date = outbound_date or _parse_date(params.get("outbound_date"))
        return_date = return_date or _parse_date(params.get("return_date"))
        currency = str(params.get("currency") or currency).upper()

    offers: list[NormalizedOffer] = []
    for item in groups:
        offer = _google_flights_offer(
            item,
            market=market,
            currency=currency,
            price_scope=price_scope,
            outbound_date=outbound_date,
            return_date=return_date,
            search_link=search_link,
        )
        if offer is not None:
            offers.append(offer)

    return ProviderResult(
        endpoint=EndpointType.GOOGLE_FLIGHTS,
        market=market,
        currency=currency,
        query_fingerprint=query_fingerprint,
        offers=offers,
        response_at=_response_time(payload),
        request_count=1,
        search_link=search_link,
        outbound_date=outbound_date,
        return_date=return_date,
        raw_excerpt=sanitize_excerpt(payload),
    )


def _google_flights_offer(
    item: dict[str, Any],
    *,
    market: str,
    currency: str,
    price_scope: PriceScopeLabel,
    outbound_date: date | None,
    return_date: date | None,
    search_link: str | None,
) -> NormalizedOffer | None:
    price = _decimal(item.get("price"))
    if price is None:
        # An itinerary without a usable price cannot be tracked; skip it rather
        # than storing a zero that would poison the historical low.
        log.debug("skipping google_flights itinerary without a price")
        return None

    raw_segments = [s for s in (item.get("flights") or []) if isinstance(s, dict)]
    segments: list[dict[str, Any]] = []
    airlines: list[str] = []
    flight_numbers: list[str] = []
    cabin: str | None = None

    for segment in raw_segments:
        departure = segment.get("departure_airport") or {}
        arrival = segment.get("arrival_airport") or {}
        entry = {
            "departure_id": departure.get("id"),
            "departure_name": departure.get("name"),
            "departure_time": departure.get("time"),
            "arrival_id": arrival.get("id"),
            "arrival_name": arrival.get("name"),
            "arrival_time": arrival.get("time"),
            "airline": segment.get("airline"),
            "flight_number": segment.get("flight_number"),
            "travel_class": segment.get("travel_class"),
            "duration_minutes": _int(segment.get("duration")),
            "airplane": segment.get("airplane"),
            "overnight": segment.get("overnight"),
        }
        segments.append(entry)
        if entry["airline"] and entry["airline"] not in airlines:
            airlines.append(str(entry["airline"]))
        if entry["flight_number"]:
            flight_numbers.append(str(entry["flight_number"]))
        if cabin is None and entry["travel_class"]:
            cabin = str(entry["travel_class"])

    layovers = [
        {
            "id": layover.get("id"),
            "name": layover.get("name"),
            "duration_minutes": _int(layover.get("duration")),
            "overnight": layover.get("overnight"),
        }
        for layover in (item.get("layovers") or [])
        if isinstance(layover, dict)
    ]

    first, last = (segments[0], segments[-1]) if segments else ({}, {})
    stops = len(layovers) if layovers else (max(0, len(segments) - 1) if segments else None)

    return NormalizedOffer(
        price_amount=price,
        currency=currency,
        price_scope=price_scope,
        market=market,
        origin=first.get("departure_id"),
        destination=last.get("arrival_id"),
        outbound_date=_parse_date(first.get("departure_time")) or outbound_date,
        return_date=return_date,
        departure_time=first.get("departure_time"),
        arrival_time=last.get("arrival_time"),
        airlines=airlines,
        flight_numbers=flight_numbers,
        stops=stops,
        duration_minutes=_int(item.get("total_duration")),
        cabin=cabin,
        segments=segments,
        layovers=layovers,
        booking_link=None,  # requires a second billable search; never fabricated
        search_link=search_link,
    )


# ---------------------------------------------------------------------------
# Google Travel Explore (flexible preset)
# ---------------------------------------------------------------------------
def parse_google_travel_explore(
    payload: dict[str, Any],
    *,
    market: str,
    currency: str,
    query_fingerprint: str,
    price_scope: PriceScopeLabel,
) -> ProviderResult:
    """Normalize a route-specific ``engine=google_travel_explore`` response.

    The provider chooses the actual dates for a flexible month; those dates are
    preserved verbatim as ``start_date`` / ``end_date`` rather than being
    recomputed locally.
    """
    if not isinstance(payload, dict):
        raise ProviderMalformedResponseError("Travel Explore response was not a JSON object.")

    flights = [f for f in (payload.get("flights") or []) if isinstance(f, dict)]
    if not flights and "destinations" in payload:
        raise ProviderMalformedResponseError(
            "Travel Explore answered with destination suggestions instead of "
            "route flights. FlightNotify needs a specific arrival airport."
        )

    outbound_date = _parse_date(payload.get("start_date"))
    return_date = _parse_date(payload.get("end_date"))
    search_link = payload.get("google_flights_link") or None
    if not search_link:
        metadata = payload.get("search_metadata")
        if isinstance(metadata, dict):
            search_link = metadata.get("google_travel_explore_url")

    params = payload.get("search_parameters")
    if isinstance(params, dict):
        currency = str(params.get("currency") or currency).upper()

    offers: list[NormalizedOffer] = []
    for flight in flights:
        price = _decimal(flight.get("price"))
        if price is None:
            continue
        departure = flight.get("departure_airport") or {}
        arrival = flight.get("arrival_airport") or {}
        airline = flight.get("airline")
        airline_code = flight.get("airline_code")
        offers.append(
            NormalizedOffer(
                price_amount=price,
                currency=currency,
                price_scope=price_scope,
                market=market,
                origin=departure.get("id"),
                destination=arrival.get("id"),
                outbound_date=outbound_date,
                return_date=return_date,
                departure_time=None,
                arrival_time=None,
                airlines=[str(airline)] if airline else [],
                flight_numbers=[],
                stops=_int(flight.get("number_of_stops")),
                duration_minutes=_int(flight.get("duration")),
                cabin=None,
                segments=[
                    {
                        "departure_id": departure.get("id"),
                        "departure_name": departure.get("name"),
                        "arrival_id": arrival.get("id"),
                        "arrival_name": arrival.get("name"),
                        "airline": airline,
                        "airline_code": airline_code,
                        "duration_minutes": _int(flight.get("duration")),
                        "cheapest_flight": bool(flight.get("cheapest_flight", False)),
                    }
                ],
                layovers=[],
                booking_link=None,
                search_link=search_link,
            )
        )

    return ProviderResult(
        endpoint=EndpointType.GOOGLE_TRAVEL_EXPLORE,
        market=market,
        currency=currency,
        query_fingerprint=query_fingerprint,
        offers=offers,
        response_at=_response_time(payload),
        request_count=1,
        search_link=search_link,
        outbound_date=outbound_date,
        return_date=return_date,
        raw_excerpt=sanitize_excerpt(payload),
    )
