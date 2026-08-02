"""Selecting the configured fare provider.

One place decides which adapter is live, so the tracking, quota and web layers
never name a concrete provider.
"""

from __future__ import annotations

from ..config import FlightProvider, Settings, get_settings
from .base import FareProvider


def get_provider(settings: Settings | None = None) -> FareProvider:
    """Build the provider named by ``FLIGHT_PROVIDER``."""
    settings = settings or get_settings()
    if FlightProvider(settings.flight_provider) is FlightProvider.AMADEUS:
        from .amadeus import AmadeusProvider

        return AmadeusProvider(settings)
    from .serpapi import SerpApiProvider

    return SerpApiProvider(settings)


def provider_label(settings: Settings | None = None) -> str:
    """Human name of the configured provider, for status output."""
    settings = settings or get_settings()
    return FlightProvider(settings.flight_provider).value
