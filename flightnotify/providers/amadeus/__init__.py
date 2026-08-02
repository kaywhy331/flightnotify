"""Amadeus Self-Service fare provider."""

from .client import AmadeusClient
from .parsing import parse_flight_dates, parse_flight_offers
from .provider import AmadeusProvider

__all__ = ["AmadeusClient", "AmadeusProvider", "parse_flight_dates", "parse_flight_offers"]
