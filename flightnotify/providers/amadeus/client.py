"""Amadeus Self-Service transport: OAuth2 token handling and GET requests.

Amadeus uses OAuth2 client credentials rather than a query-string key: you
exchange an id/secret for a bearer token that expires (typically ~30 minutes),
then send it on every call. The token is cached in memory and refreshed a
little early, so a normal check costs one API call, not two.

Request shapes come from the official OpenAPI specification:
https://github.com/amadeus4dev/amadeus-open-api-specification
"""

from __future__ import annotations

import logging
import threading
from typing import Any

import httpx

from ...timeutil import utcnow
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

#: Hosts documented by Amadeus. "test" carries a limited, cached data set.
HOSTS: dict[str, str] = {
    "test": "https://test.api.amadeus.com",
    "production": "https://api.amadeus.com",
}

TOKEN_PATH = "/v1/security/oauth2/token"
#: Refresh this many seconds before expiry so a call never races the deadline.
TOKEN_LEEWAY_SECONDS = 60


class AmadeusClient:
    """Minimal Amadeus HTTP client. Holds the token; never logs it."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        environment: str = "test",
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._base_url = HOSTS.get(environment, HOSTS["test"])
        self._timeout = timeout
        self._transport = transport
        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._lock = threading.Lock()

    @property
    def base_url(self) -> str:
        return self._base_url

    # -- auth ---------------------------------------------------------------
    def _fetch_token(self) -> str:
        payload = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        body = self._request("POST", TOKEN_PATH, data=payload, authenticated=False)
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise ProviderMalformedResponseError(
                "Amadeus token response contained no access_token",
                user_message=(
                    "Amadeus returned a sign-in response FlightNotify could not read. "
                    "No search was made and stored history is unchanged."
                ),
            )
        expires_in = body.get("expires_in")
        ttl = float(expires_in) if isinstance(expires_in, int | float) else 1799.0
        with self._lock:
            self._token = token
            self._token_expires_at = utcnow().timestamp() + max(0.0, ttl - TOKEN_LEEWAY_SECONDS)
        return token

    def _access_token(self) -> str:
        with self._lock:
            token = self._token
            fresh = token is not None and utcnow().timestamp() < self._token_expires_at
        if fresh and token is not None:
            return token
        return self._fetch_token()

    # -- requests -----------------------------------------------------------
    def get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        """Authenticated GET. Raises a ProviderError subclass on failure."""
        return self._request("GET", path, params=params, authenticated=True)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if authenticated:
            headers["Authorization"] = f"Bearer {self._access_token()}"

        url = f"{self._base_url}{path}"
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.request(method, url, params=params, data=data, headers=headers)
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"Amadeus request timed out: {exc}",
                user_message=(
                    "The request to Amadeus timed out. No result was stored for this "
                    "check and existing history is unchanged."
                ),
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderNetworkError(
                f"Could not reach Amadeus: {exc}",
                user_message=(
                    "FlightNotify could not reach Amadeus. No result was stored for this "
                    "check and existing history is unchanged. Check this machine's network."
                ),
            ) from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderMalformedResponseError(
                f"Amadeus returned non-JSON (HTTP {response.status_code})",
                user_message=(
                    "Amadeus returned a response FlightNotify could not read. The run is "
                    "recorded as a provider error and stored history is unchanged."
                ),
            ) from exc
        if not isinstance(body, dict):
            raise ProviderMalformedResponseError(
                "Amadeus returned a JSON document that was not an object",
                user_message=(
                    "Amadeus returned a response FlightNotify could not read. The run is "
                    "recorded as a provider error and stored history is unchanged."
                ),
            )

        if response.status_code >= 400:
            raise self._map_error(response.status_code, body)
        return body

    def _map_error(self, status: int, body: dict[str, Any]) -> ProviderError:
        detail = _first_error_detail(body) or f"HTTP {status}"
        if status in {401, 403}:
            return ProviderAuthError(
                f"Amadeus rejected the credentials: {detail}",
                user_message=(
                    "Amadeus rejected the API credentials, so no search was made and "
                    "stored history is unchanged. Check AMADEUS_CLIENT_ID and "
                    "AMADEUS_CLIENT_SECRET at https://developers.amadeus.com/my-apps."
                ),
            )
        if status == 429:
            return ProviderRateLimitError(
                f"Amadeus rate-limited the request: {detail}",
                user_message=(
                    "Amadeus rate-limited this request. Nothing was stored for this check "
                    "and existing history is unchanged. FlightNotify will retry later."
                ),
            )
        if status == 400:
            return ProviderUnsupportedQueryError(
                f"Amadeus rejected the query: {detail}",
                user_message=(
                    f"Amadeus rejected this search as unsupported ({detail}). The run is "
                    "recorded and stored history is unchanged. Try a different route, "
                    "date or passenger combination."
                ),
            )
        if status in {402, 404} and "quota" in detail.lower():
            return ProviderQuotaExhaustedError(
                f"Amadeus quota exhausted: {detail}",
                user_message=(
                    "The Amadeus account has no requests left. No search was made and "
                    "stored history is unchanged."
                ),
            )
        return ProviderError(
            f"Amadeus error (HTTP {status}): {detail}",
            user_message=(
                f"Amadeus returned an error ({detail}). The run is recorded as a provider "
                "error and stored history is unchanged."
            ),
        )


def _first_error_detail(body: dict[str, Any]) -> str | None:
    """Amadeus reports problems as a JSON:API-style ``errors`` array."""
    errors = body.get("errors")
    if isinstance(errors, list) and errors:
        first = errors[0]
        if isinstance(first, dict):
            for key in ("detail", "title", "code"):
                value = first.get(key)
                if value:
                    return str(value)
    description = body.get("error_description") or body.get("error")
    return str(description) if description else None
