"""HTTP transport for SerpApi with bounded retries and error mapping."""

from __future__ import annotations

import logging
import random
import time
from typing import Any

import httpx

from ..errors import (
    ProviderAuthError,
    ProviderError,
    ProviderMalformedResponseError,
    ProviderNetworkError,
    ProviderQuotaExhaustedError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnsupportedQueryError,
)

log = logging.getLogger(__name__)

#: SerpApi answers "no itineraries" with an HTTP 200 error string rather than an
#: empty result set. That is a legitimate outcome, not a failure.
_NO_RESULTS_MARKERS = (
    "hasn't returned any results",
    "has not returned any results",
    "no results found",
    "returned no results",
)
_INVALID_KEY_MARKERS = ("invalid api key", "missing api key", "unauthorized")
_QUOTA_MARKERS = ("run out of searches", "exceeded your", "no searches left", "account limit")
_UNSUPPORTED_MARKERS = (
    "unsupported",
    "not supported",
    "invalid value",
    "missing query",
    "wrong request",
    "is not a valid",
)


class NoResultsSignal(Exception):
    """The provider answered successfully but matched no itinerary."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.provider_message = message


class SerpApiClient:
    """Thin, testable wrapper over the SerpApi JSON endpoints.

    ``transport`` exists so tests can drive the adapter through
    :class:`httpx.MockTransport` without any network access.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://serpapi.com",
        timeout: float = 60.0,
        max_attempts: int = 3,
        transport: httpx.BaseTransport | None = None,
        sleep: Any = time.sleep,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_attempts = max(1, max_attempts)
        self._transport = transport
        self._sleep = sleep

    # -- public ------------------------------------------------------------
    def search(self, params: dict[str, Any]) -> dict[str, Any]:
        """Call ``/search.json``. Raises :class:`NoResultsSignal` for empty matches."""
        return self._request("/search.json", params)

    def account(self) -> dict[str, Any]:
        """Call ``/account.json``. Documented as free and not counted as a search."""
        return self._request("/account.json", {}, allow_no_results=False)

    # -- internals ---------------------------------------------------------
    def _request(
        self, path: str, params: dict[str, Any], *, allow_no_results: bool = True
    ) -> dict[str, Any]:
        query = {k: v for k, v in params.items() if v is not None and v != ""}
        query["api_key"] = self._api_key
        query.setdefault("output", "json")

        last_error: ProviderError | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                payload = self._single_request(path, query)
            except (ProviderTimeoutError, ProviderNetworkError) as exc:
                last_error = exc
                if attempt >= self._max_attempts:
                    raise
                delay = self._backoff(attempt)
                log.warning(
                    "serpapi transient failure, retrying",
                    extra={
                        "attempt": attempt,
                        "max_attempts": self._max_attempts,
                        "retry_in_seconds": round(delay, 2),
                        "error_category": exc.category.value,
                    },
                )
                self._sleep(delay)
                continue
            return self._interpret(payload, allow_no_results=allow_no_results)

        raise last_error or ProviderNetworkError("SerpApi request failed.")

    def _single_request(self, path: str, query: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.get(url, params=query)
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(f"SerpApi timed out after {self._timeout}s") from exc
        except httpx.HTTPError as exc:
            # str(exc) can echo the request URL, which carries api_key; the log
            # filter redacts it, and the message we surface stays generic.
            raise ProviderNetworkError(f"SerpApi request failed: {type(exc).__name__}") from exc

        return self._decode(response)

    def _decode(self, response: httpx.Response) -> dict[str, Any]:
        status = response.status_code
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}

        message = str(payload.get("error") or "").strip()

        if status == 401 or (message and _matches(message, _INVALID_KEY_MARKERS)):
            raise ProviderAuthError(message or "SerpApi returned HTTP 401.")
        if status == 429:
            if _matches(message, _QUOTA_MARKERS):
                raise ProviderQuotaExhaustedError(message)
            retry_after = _retry_after(response)
            raise ProviderRateLimitError(
                message or "SerpApi returned HTTP 429.", retry_after_seconds=retry_after
            )
        if status in (402, 403) and _matches(message, _QUOTA_MARKERS):
            raise ProviderQuotaExhaustedError(message)
        if status >= 500:
            raise ProviderNetworkError(f"SerpApi returned HTTP {status}.")
        if status >= 400 and not message:
            raise ProviderError(f"SerpApi returned HTTP {status}.")

        return payload

    def _interpret(self, payload: dict[str, Any], *, allow_no_results: bool) -> dict[str, Any]:
        metadata = payload.get("search_metadata")
        message = str(payload.get("error") or "").strip()
        if not message and isinstance(metadata, dict) and metadata.get("status") == "Error":
            message = str(metadata.get("error") or "SerpApi reported an error status.")

        if message:
            if _matches(message, _INVALID_KEY_MARKERS):
                raise ProviderAuthError(message)
            if _matches(message, _QUOTA_MARKERS):
                raise ProviderQuotaExhaustedError(message)
            if allow_no_results and _matches(message, _NO_RESULTS_MARKERS):
                raise NoResultsSignal(message)
            if _matches(message, _UNSUPPORTED_MARKERS):
                raise ProviderUnsupportedQueryError(
                    message,
                    user_message=(
                        f"SerpApi rejected this search: {message} Nothing was stored "
                        "for this check and existing history is unchanged. Adjust the "
                        "route, dates, cabin, market or passenger counts."
                    ),
                )
            raise ProviderUnsupportedQueryError(message)

        if not payload:
            raise ProviderMalformedResponseError("SerpApi returned an empty response body.")
        return payload

    def _backoff(self, attempt: int) -> float:
        base = min(2.0 ** (attempt - 1), 8.0)
        return base + random.uniform(0, 0.5)


def _matches(message: str, markers: tuple[str, ...]) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in markers)


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
