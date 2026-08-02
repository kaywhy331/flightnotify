"""Amadeus response parsing.

Shapes come from the official OpenAPI specification, not from guesswork:
https://github.com/amadeus4dev/amadeus-open-api-specification

The price scope is *known* here, unlike SerpApi's Google Flights price: the
spec documents ``price.total`` as "Total amount paid by the user" for the whole
requested party, with a per-traveler breakdown in ``travelerPricings``. So
FlightNotify can label it ``party_total`` as fact rather than assumption.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from ...enums import EndpointType, PriceScopeLabel
from ...timeutil import utcnow
from ..base import NormalizedOffer, ProviderResult
from ..errors import ProviderMalformedResponseError

#: ISO-8601 duration as Amadeus emits it, e.g. "PT11H30M".
_DURATION = re.compile(r"^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$")

#: Keys worth keeping for debugging. Never includes credentials.
_EXCERPT_KEYS = ("meta", "dictionaries")


def parse_duration_minutes(value: Any) -> int | None:
    """ "PT11H30M" -> 690. Returns None rather than guessing on anything else."""
    if not isinstance(value, str):
        return None
    match = _DURATION.match(value.strip())
    if not match:
        return None
    days, hours, minutes = (int(g) if g else 0 for g in match.groups())
    total = days * 24 * 60 + hours * 60 + minutes
    return total or None


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _local_date(value: Any) -> date | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None


def _time_of(value: Any) -> str | None:
    if not isinstance(value, str) or "T" not in value:
        return None
    return value.split("T", 1)[1][:5] or None


def sanitize_excerpt(payload: dict[str, Any]) -> dict[str, Any]:
    """A small, credential-free slice kept for debugging."""
    excerpt = {key: payload[key] for key in _EXCERPT_KEYS if key in payload}
    data = payload.get("data")
    if isinstance(data, list):
        excerpt["data_count"] = len(data)
    return excerpt


def parse_flight_offers(
    payload: dict[str, Any],
    *,
    market: str,
    currency: str,
    query_fingerprint: str,
    outbound_date: date | None = None,
    return_date: date | None = None,
) -> ProviderResult:
    """Parse GET /v2/shopping/flight-offers."""
    data = payload.get("data")
    if data is None:
        raise ProviderMalformedResponseError(
            "Amadeus flight-offers response had no data array",
            user_message=(
                "Amadeus returned a response FlightNotify could not read. The run is "
                "recorded as a provider error and stored history is unchanged."
            ),
        )
    if not isinstance(data, list):
        raise ProviderMalformedResponseError(
            "Amadeus flight-offers data was not a list",
            user_message=(
                "Amadeus returned a response FlightNotify could not read. The run is "
                "recorded as a provider error and stored history is unchanged."
            ),
        )

    carriers = _carrier_names(payload)
    offers: list[NormalizedOffer] = []
    for entry in data:
        offer = _offer_from(entry, market, currency, carriers)
        if offer is not None:
            offers.append(offer)

    return ProviderResult(
        endpoint=EndpointType.AMADEUS_FLIGHT_OFFERS,
        market=market,
        currency=currency,
        query_fingerprint=query_fingerprint,
        offers=offers,
        response_at=utcnow(),
        outbound_date=outbound_date,
        return_date=return_date,
        raw_excerpt=sanitize_excerpt(payload),
    )


def _carrier_names(payload: dict[str, Any]) -> dict[str, str]:
    dictionaries = payload.get("dictionaries")
    if not isinstance(dictionaries, dict):
        return {}
    carriers = dictionaries.get("carriers")
    return {str(k): str(v) for k, v in carriers.items()} if isinstance(carriers, dict) else {}


def _offer_from(
    entry: Any, market: str, currency: str, carriers: dict[str, str]
) -> NormalizedOffer | None:
    if not isinstance(entry, dict):
        return None
    price = entry.get("price")
    if not isinstance(price, dict):
        return None
    # grandTotal includes fees and selected services; prefer it when present.
    amount = _decimal(price.get("grandTotal")) or _decimal(price.get("total"))
    if amount is None:
        return None

    itineraries = entry.get("itineraries")
    itineraries = itineraries if isinstance(itineraries, list) else []
    outbound = itineraries[0] if itineraries else None
    inbound = itineraries[1] if len(itineraries) > 1 else None

    out_segments = _segments(outbound)
    in_segments = _segments(inbound)
    all_segments = out_segments + in_segments

    airlines = []
    for segment in all_segments:
        code = segment.get("carrierCode")
        if isinstance(code, str) and code:
            name = carriers.get(code, code)
            if name not in airlines:
                airlines.append(name)

    first = out_segments[0] if out_segments else None
    last = out_segments[-1] if out_segments else None
    departure = first.get("departure") if isinstance(first, dict) else None
    arrival = last.get("arrival") if isinstance(last, dict) else None

    return NormalizedOffer(
        price_amount=amount,
        currency=str(price.get("currency") or currency).upper(),
        # Documented by the spec as the total for the requested party.
        price_scope=PriceScopeLabel.PARTY_TOTAL,
        market=market,
        origin=_iata(departure),
        destination=_iata(arrival),
        outbound_date=_local_date(departure.get("at") if isinstance(departure, dict) else None),
        return_date=_return_date_of(in_segments),
        departure_time=_time_of(departure.get("at") if isinstance(departure, dict) else None),
        arrival_time=_time_of(arrival.get("at") if isinstance(arrival, dict) else None),
        airlines=airlines,
        flight_numbers=[
            f"{s.get('carrierCode', '')}{s.get('number', '')}".strip()
            for s in all_segments
            if s.get("number")
        ],
        # Stops on the outbound leg: one segment is nonstop.
        stops=max(0, len(out_segments) - 1) if out_segments else None,
        duration_minutes=parse_duration_minutes(
            outbound.get("duration") if isinstance(outbound, dict) else None
        ),
        cabin=_cabin_of(entry),
        segments=[s for s in all_segments if isinstance(s, dict)],
    )


def _segments(itinerary: Any) -> list[dict[str, Any]]:
    if not isinstance(itinerary, dict):
        return []
    segments = itinerary.get("segments")
    return [s for s in segments if isinstance(s, dict)] if isinstance(segments, list) else []


def _iata(endpoint: Any) -> str | None:
    if not isinstance(endpoint, dict):
        return None
    code = endpoint.get("iataCode")
    return str(code) if code else None


def _return_date_of(inbound_segments: list[dict[str, Any]]) -> date | None:
    if not inbound_segments:
        return None
    departure = inbound_segments[0].get("departure")
    return _local_date(departure.get("at") if isinstance(departure, dict) else None)


def _cabin_of(entry: dict[str, Any]) -> str | None:
    pricings = entry.get("travelerPricings")
    if not isinstance(pricings, list) or not pricings:
        return None
    first = pricings[0]
    if not isinstance(first, dict):
        return None
    details = first.get("fareDetailsBySegment")
    if not isinstance(details, list) or not details:
        return None
    cabin = details[0].get("cabin") if isinstance(details[0], dict) else None
    return str(cabin).lower() if cabin else None


def parse_flight_dates(
    payload: dict[str, Any],
    *,
    market: str,
    currency: str,
    query_fingerprint: str,
) -> ProviderResult:
    """Parse GET /v1/shopping/flight-dates (cheapest date search).

    One call covers a whole departure-date range, which is what makes a
    flexible window affordable: a date grid instead of one search per pair.
    """
    data = payload.get("data")
    if not isinstance(data, list):
        raise ProviderMalformedResponseError(
            "Amadeus flight-dates response had no data array",
            user_message=(
                "Amadeus returned a response FlightNotify could not read. The run is "
                "recorded as a provider error and stored history is unchanged."
            ),
        )

    meta_currency = _meta_currency(payload) or currency
    offers: list[NormalizedOffer] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        price = entry.get("price")
        amount = _decimal(price.get("total")) if isinstance(price, dict) else None
        if amount is None:
            continue
        offers.append(
            NormalizedOffer(
                price_amount=amount,
                currency=meta_currency.upper(),
                price_scope=PriceScopeLabel.PARTY_TOTAL,
                market=market,
                origin=str(entry.get("origin")) if entry.get("origin") else None,
                destination=str(entry.get("destination")) if entry.get("destination") else None,
                outbound_date=_local_date(entry.get("departureDate")),
                return_date=_local_date(entry.get("returnDate")),
                booking_link=_deep_link(entry),
            )
        )

    return ProviderResult(
        endpoint=EndpointType.AMADEUS_FLIGHT_DATES,
        market=market,
        currency=meta_currency,
        query_fingerprint=query_fingerprint,
        offers=offers,
        response_at=utcnow(),
        raw_excerpt=sanitize_excerpt(payload),
    )


def _meta_currency(payload: dict[str, Any]) -> str | None:
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        return None
    currency = meta.get("currency")
    return str(currency) if currency else None


def _deep_link(entry: dict[str, Any]) -> str | None:
    links = entry.get("links")
    if not isinstance(links, dict):
        return None
    link = links.get("flightOffers") or links.get("flightDates")
    return str(link) if link else None
