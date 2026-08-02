"""Domain enumerations shared by the models, services and templates."""

from __future__ import annotations

from enum import StrEnum


class TrackerStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    ERROR = "error"


class DateMode(StrEnum):
    EXACT = "exact"
    FLEXIBLE_PRESET = "flexible_preset"
    CUSTOM_WINDOW = "custom_window"


class Cabin(StrEnum):
    ECONOMY = "economy"
    PREMIUM_ECONOMY = "premium_economy"
    BUSINESS = "business"
    FIRST = "first"


class StopsPreference(StrEnum):
    ANY = "any"
    NONSTOP = "nonstop"
    ONE_STOP_MAX = "one_stop_max"


class ThresholdBasis(StrEnum):
    PARTY = "party"
    PER_TRAVELER = "per_traveler"


class FlexDuration(StrEnum):
    """Trip lengths the Google Travel Explore endpoint supports."""

    WEEKEND = "weekend"
    ONE_WEEK = "one_week"
    TWO_WEEKS = "two_weeks"


class RunTrigger(StrEnum):
    INITIAL = "initial"
    MANUAL = "manual"
    SCHEDULED = "scheduled"
    RETRY = "retry"
    ONE_SHOT = "one_shot"


class EndpointType(StrEnum):
    GOOGLE_FLIGHTS = "google_flights"
    GOOGLE_TRAVEL_EXPLORE = "google_travel_explore"
    #: Amadeus Flight Offers Search - one fixed outbound/return pair.
    AMADEUS_FLIGHT_OFFERS = "amadeus_flight_offers"
    #: Amadeus Flight Cheapest Date Search - a date range in one call.
    AMADEUS_FLIGHT_DATES = "amadeus_flight_dates"


class RunStatus(StrEnum):
    SUCCESS = "success"
    NO_RESULTS = "no_results"
    PROVIDER_ERROR = "provider_error"
    QUOTA_BLOCKED = "quota_blocked"
    RATE_LIMITED = "rate_limited"
    INVALID_REQUEST = "invalid_request"
    SKIPPED = "skipped"

    @property
    def is_terminal_success(self) -> bool:
        return self is RunStatus.SUCCESS


class CacheStatus(StrEnum):
    MISS = "miss"
    HIT = "hit"
    FORCED = "forced"
    NOT_APPLICABLE = "not_applicable"


class CoverageState(StrEnum):
    NOT_APPLICABLE = "not_applicable"
    PARTIAL = "partial"
    COMPLETE = "complete"


class ErrorCategory(StrEnum):
    NONE = "none"
    MISSING_CREDENTIALS = "missing_credentials"
    INVALID_CREDENTIALS = "invalid_credentials"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    NETWORK = "network"
    MALFORMED_RESPONSE = "malformed_response"
    UNSUPPORTED_QUERY = "unsupported_query"
    PROVIDER_ERROR = "provider_error"
    QUOTA_EXHAUSTED = "quota_exhausted"
    NO_CANDIDATES = "no_candidates"
    INTERNAL = "internal"


class PriceScopeLabel(StrEnum):
    """How an observation's stored price should be read."""

    PARTY_TOTAL = "party_total"
    PER_TRAVELER = "per_traveler"
    UNKNOWN = "unknown"


class AlertType(StrEnum):
    THRESHOLD = "threshold"
    NEW_LOW = "new_low"
    TEST = "test"


class DeliveryState(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    SUPPRESSED_DUPLICATE = "suppressed_duplicate"
    SUPPRESSED_COOLDOWN = "suppressed_cooldown"
    SUPPRESSED_MIN_DROP = "suppressed_min_drop"
    NOT_CONFIGURED = "not_configured"


class CandidateStatus(StrEnum):
    PENDING = "pending"
    CHECKED = "checked"
    FAILED = "failed"


#: Human labels used across the UI and Telegram messages.
CABIN_LABELS: dict[str, str] = {
    Cabin.ECONOMY: "Economy",
    Cabin.PREMIUM_ECONOMY: "Premium economy",
    Cabin.BUSINESS: "Business",
    Cabin.FIRST: "First",
}

STOPS_LABELS: dict[str, str] = {
    StopsPreference.ANY: "Any number of stops",
    StopsPreference.NONSTOP: "Nonstop only",
    StopsPreference.ONE_STOP_MAX: "1 stop or fewer",
}

DATE_MODE_LABELS: dict[str, str] = {
    DateMode.EXACT: "Exact dates",
    DateMode.FLEXIBLE_PRESET: "Flexible preset",
    DateMode.CUSTOM_WINDOW: "Custom flexible window",
}

FLEX_DURATION_LABELS: dict[str, str] = {
    FlexDuration.WEEKEND: "Weekend",
    FlexDuration.ONE_WEEK: "About 1 week",
    FlexDuration.TWO_WEEKS: "About 2 weeks",
}

RUN_STATUS_LABELS: dict[str, str] = {
    RunStatus.SUCCESS: "Success",
    RunStatus.NO_RESULTS: "No results",
    RunStatus.PROVIDER_ERROR: "Provider error",
    RunStatus.QUOTA_BLOCKED: "Quota prevented",
    RunStatus.RATE_LIMITED: "Rate limited",
    RunStatus.INVALID_REQUEST: "Invalid request",
    RunStatus.SKIPPED: "Skipped",
}

DELIVERY_STATE_LABELS: dict[str, str] = {
    DeliveryState.PENDING: "Pending",
    DeliveryState.SENT: "Sent",
    DeliveryState.FAILED: "Failed",
    DeliveryState.SUPPRESSED_DUPLICATE: "Suppressed (duplicate)",
    DeliveryState.SUPPRESSED_COOLDOWN: "Suppressed (cooldown)",
    DeliveryState.SUPPRESSED_MIN_DROP: "Suppressed (below minimum drop)",
    DeliveryState.NOT_CONFIGURED: "Not sent (Telegram not configured)",
}

ALERT_TYPE_LABELS: dict[str, str] = {
    AlertType.THRESHOLD: "Threshold reached",
    AlertType.NEW_LOW: "New observed low",
    AlertType.TEST: "Test message",
}
