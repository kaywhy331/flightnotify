"""Provider error taxonomy.

Each error maps to a stored :class:`~flightnotify.enums.ErrorCategory` and to a
user-facing sentence that says what failed, whether data is safe, and what to
do next.
"""

from __future__ import annotations

from ..enums import ErrorCategory


class ProviderError(Exception):
    """Base class for every fare-provider failure."""

    category: ErrorCategory = ErrorCategory.PROVIDER_ERROR
    #: Whether retrying the same request could plausibly succeed.
    retryable: bool = False

    def __init__(self, message: str, *, user_message: str | None = None) -> None:
        super().__init__(message)
        self.user_message = user_message or message

    def guidance(self) -> str:
        return self.user_message


class ProviderMissingCredentialsError(ProviderError):
    category = ErrorCategory.MISSING_CREDENTIALS

    def __init__(self, message: str = "SERPAPI_API_KEY is not set.") -> None:
        super().__init__(
            message,
            user_message=(
                "No SerpApi key is configured, so no search was made. "
                "Stored history is unchanged. Add SERPAPI_API_KEY to your .env "
                "and restart FlightNotify."
            ),
        )


class ProviderAuthError(ProviderError):
    category = ErrorCategory.INVALID_CREDENTIALS

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            user_message=(
                "SerpApi rejected the API key, so no search was made and no quota "
                "was used. Stored history is unchanged. Check the key at "
                "https://serpapi.com/manage-api-key and update SERPAPI_API_KEY."
            ),
        )


class ProviderRateLimitError(ProviderError):
    category = ErrorCategory.RATE_LIMIT
    retryable = True

    def __init__(self, message: str, retry_after_seconds: float | None = None) -> None:
        self.retry_after_seconds = retry_after_seconds
        super().__init__(
            message,
            user_message=(
                "SerpApi rate-limited this request. Nothing was stored for this "
                "check and existing history is unchanged. FlightNotify will back "
                "off and try again on the next scheduled run."
            ),
        )


class ProviderQuotaExhaustedError(ProviderError):
    category = ErrorCategory.QUOTA_EXHAUSTED

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            user_message=(
                "The SerpApi account has no searches left this cycle. No search "
                "was made and stored history is unchanged. Wait for the plan to "
                "renew, or lower the tracker's check frequency."
            ),
        )


class ProviderTimeoutError(ProviderError):
    category = ErrorCategory.TIMEOUT
    retryable = True

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            user_message=(
                "The request to SerpApi timed out. No result was stored for this "
                "check and existing history is unchanged. FlightNotify retries "
                "with backoff on the next run."
            ),
        )


class ProviderNetworkError(ProviderError):
    category = ErrorCategory.NETWORK
    retryable = True

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            user_message=(
                "FlightNotify could not reach SerpApi. No result was stored for "
                "this check and existing history is unchanged. Check this "
                "machine's network connection."
            ),
        )


class ProviderMalformedResponseError(ProviderError):
    category = ErrorCategory.MALFORMED_RESPONSE

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            user_message=(
                "SerpApi returned a response FlightNotify could not read. The run "
                "is recorded as a provider error and stored history is unchanged. "
                "If this repeats, the provider's response format may have changed."
            ),
        )


class ProviderUnsupportedQueryError(ProviderError):
    category = ErrorCategory.UNSUPPORTED_QUERY

    def __init__(self, message: str, *, user_message: str | None = None) -> None:
        super().__init__(
            message,
            user_message=user_message
            or (
                "SerpApi rejected this search as unsupported. The run is recorded "
                "and stored history is unchanged. Try a different route, date, "
                "cabin, market or passenger combination."
            ),
        )
