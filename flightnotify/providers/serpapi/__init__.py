"""SerpApi fare provider adapter.

Uses the documented JSON APIs only - FlightNotify never scrapes Google Flights
pages, never solves CAPTCHAs and never manipulates browser fingerprints.

* Google Flights API          - exact-date round trips
* Google Travel Explore API   - route-specific flexible months
* Account API                 - quota status (free, not counted as a search)
"""

from .provider import SerpApiProvider

__all__ = ["SerpApiProvider"]
