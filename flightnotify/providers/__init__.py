"""Fare provider abstraction.

Provider-specific request construction and response parsing lives behind
:class:`~flightnotify.providers.base.FareProvider`; the tracking, quota,
alerting and scheduling layers never see a provider payload shape.
"""

from .base import (
    AccountStatus,
    ExactSearchQuery,
    FareProvider,
    FlexibleSearchQuery,
    NormalizedOffer,
    ProviderResult,
)
from .errors import (
    ProviderAuthError,
    ProviderError,
    ProviderMalformedResponseError,
    ProviderNetworkError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnsupportedQueryError,
)

__all__ = [
    "AccountStatus",
    "ExactSearchQuery",
    "FareProvider",
    "FlexibleSearchQuery",
    "NormalizedOffer",
    "ProviderAuthError",
    "ProviderError",
    "ProviderMalformedResponseError",
    "ProviderNetworkError",
    "ProviderRateLimitError",
    "ProviderResult",
    "ProviderTimeoutError",
    "ProviderUnsupportedQueryError",
]
