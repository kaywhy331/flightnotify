/** Domain enumerations. Values must match `flightnotify/enums.py` exactly:
 *  they are persisted, so a changed string is a silent data migration. */

export const TrackerStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
  ERROR: "error",
  // The trip dates have passed. Terminal until the operator edits the
  // dates, which reactivates the tracker; history stays browsable.
  COMPLETED: "completed",
} as const;
export const DateMode = {
  EXACT: "exact",
  FLEXIBLE_PRESET: "flexible_preset",
  CUSTOM_WINDOW: "custom_window",
} as const;
export const Cabin = {
  ECONOMY: "economy",
  PREMIUM_ECONOMY: "premium_economy",
  BUSINESS: "business",
  FIRST: "first",
} as const;
export const StopsPreference = {
  ANY: "any",
  NONSTOP: "nonstop",
  ONE_STOP_MAX: "one_stop_max",
} as const;
export const ThresholdBasis = { PARTY: "party", PER_TRAVELER: "per_traveler" } as const;
export const FlexDuration = {
  WEEKEND: "weekend",
  ONE_WEEK: "one_week",
  TWO_WEEKS: "two_weeks",
} as const;
export const RunTrigger = {
  INITIAL: "initial",
  MANUAL: "manual",
  SCHEDULED: "scheduled",
  RETRY: "retry",
  ONE_SHOT: "one_shot",
} as const;
export const EndpointType = {
  GOOGLE_FLIGHTS: "google_flights",
  GOOGLE_TRAVEL_EXPLORE: "google_travel_explore",
  AMADEUS_FLIGHT_OFFERS: "amadeus_flight_offers",
  AMADEUS_FLIGHT_DATES: "amadeus_flight_dates",
} as const;
export const RunStatus = {
  SUCCESS: "success",
  NO_RESULTS: "no_results",
  PROVIDER_ERROR: "provider_error",
  QUOTA_BLOCKED: "quota_blocked",
  RATE_LIMITED: "rate_limited",
  INVALID_REQUEST: "invalid_request",
  SKIPPED: "skipped",
} as const;
export const CacheStatus = {
  MISS: "miss",
  HIT: "hit",
  FORCED: "forced",
  NOT_APPLICABLE: "not_applicable",
} as const;
export const CoverageState = {
  NOT_APPLICABLE: "not_applicable",
  PARTIAL: "partial",
  COMPLETE: "complete",
} as const;
export const ErrorCategory = {
  NONE: "none",
  MISSING_CREDENTIALS: "missing_credentials",
  INVALID_CREDENTIALS: "invalid_credentials",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  NETWORK: "network",
  MALFORMED_RESPONSE: "malformed_response",
  UNSUPPORTED_QUERY: "unsupported_query",
  PROVIDER_ERROR: "provider_error",
  QUOTA_EXHAUSTED: "quota_exhausted",
  NO_CANDIDATES: "no_candidates",
  INTERNAL: "internal",
} as const;
export const PriceScopeLabel = {
  PARTY_TOTAL: "party_total",
  PER_TRAVELER: "per_traveler",
  UNKNOWN: "unknown",
} as const;
export const AlertType = {
  THRESHOLD: "threshold",
  NEW_LOW: "new_low",
  // Within 5% above the threshold. Decided in the search service, never in
  // the golden-vector-locked evaluate(), so Python parity is untouched.
  APPROACHING: "approaching",
  TEST: "test",
} as const;
export const DeliveryState = {
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  SUPPRESSED_DUPLICATE: "suppressed_duplicate",
  SUPPRESSED_COOLDOWN: "suppressed_cooldown",
  SUPPRESSED_MIN_DROP: "suppressed_min_drop",
  NOT_CONFIGURED: "not_configured",
} as const;
export const CandidateStatus = {
  PENDING: "pending",
  CHECKED: "checked",
  FAILED: "failed",
} as const;

export type TrackerStatusValue = (typeof TrackerStatus)[keyof typeof TrackerStatus];
export type DateModeValue = (typeof DateMode)[keyof typeof DateMode];
export type CabinValue = (typeof Cabin)[keyof typeof Cabin];
export type StopsPreferenceValue = (typeof StopsPreference)[keyof typeof StopsPreference];
export type ThresholdBasisValue = (typeof ThresholdBasis)[keyof typeof ThresholdBasis];
export type FlexDurationValue = (typeof FlexDuration)[keyof typeof FlexDuration];
export type RunTriggerValue = (typeof RunTrigger)[keyof typeof RunTrigger];
export type EndpointTypeValue = (typeof EndpointType)[keyof typeof EndpointType];
export type RunStatusValue = (typeof RunStatus)[keyof typeof RunStatus];
export type CacheStatusValue = (typeof CacheStatus)[keyof typeof CacheStatus];
export type CoverageStateValue = (typeof CoverageState)[keyof typeof CoverageState];
export type ErrorCategoryValue = (typeof ErrorCategory)[keyof typeof ErrorCategory];
export type PriceScopeValue = (typeof PriceScopeLabel)[keyof typeof PriceScopeLabel];
export type AlertTypeValue = (typeof AlertType)[keyof typeof AlertType];
export type DeliveryStateValue = (typeof DeliveryState)[keyof typeof DeliveryState];
export type CandidateStatusValue = (typeof CandidateStatus)[keyof typeof CandidateStatus];

export const CABIN_LABELS: Record<string, string> = {
  economy: "Economy",
  premium_economy: "Premium economy",
  business: "Business",
  first: "First",
};
export const STOPS_LABELS: Record<string, string> = {
  any: "Any number of stops",
  nonstop: "Nonstop only",
  one_stop_max: "1 stop or fewer",
};
export const DATE_MODE_LABELS: Record<string, string> = {
  exact: "Exact dates",
  flexible_preset: "Flexible preset",
  custom_window: "Custom flexible window",
};
export const FLEX_DURATION_LABELS: Record<string, string> = {
  weekend: "Weekend",
  one_week: "About 1 week",
  two_weeks: "About 2 weeks",
};
export const RUN_STATUS_LABELS: Record<string, string> = {
  success: "Success",
  no_results: "No results",
  provider_error: "Provider error",
  quota_blocked: "Quota prevented",
  rate_limited: "Rate limited",
  invalid_request: "Invalid request",
  skipped: "Skipped",
};
export const DELIVERY_STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  sent: "Sent",
  failed: "Failed",
  suppressed_duplicate: "Suppressed (duplicate)",
  suppressed_cooldown: "Suppressed (cooldown)",
  suppressed_min_drop: "Suppressed (below minimum drop)",
  not_configured: "Not sent (Telegram not configured)",
};
export const ALERT_TYPE_LABELS: Record<string, string> = {
  threshold: "Threshold reached",
  new_low: "New observed low",
  approaching: "Approaching threshold",
  test: "Test message",
};
