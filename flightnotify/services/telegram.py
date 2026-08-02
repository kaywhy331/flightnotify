"""Telegram Bot API integration.

Direct HTTPS calls to ``api.telegram.org`` - no third-party notification
service, nothing paid. The bot token comes from the environment and is never
persisted, logged, rendered into a template or returned by an API response.
"""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

from ..config import Settings, get_settings

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TelegramResult:
    ok: bool
    message_id: int | None = None
    error_code: int | None = None
    description: str | None = None
    retry_after: float | None = None
    category: str = "ok"
    user_message: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def retryable(self) -> bool:
        return self.category in {"rate_limit", "timeout", "network", "server_error"}


@dataclass(frozen=True, slots=True)
class DiscoveredChat:
    chat_id: int
    chat_type: str
    display_name: str
    last_message_at: datetime | None
    last_text: str | None


@dataclass(frozen=True, slots=True)
class BotIdentity:
    bot_id: int
    username: str | None
    first_name: str | None

    @property
    def handle(self) -> str:
        return f"@{self.username}" if self.username else f"bot {self.bot_id}"


def escape_html(text: str) -> str:
    """Escape for Telegram's HTML parse mode.

    Telegram documents that "All <, > and & symbols that are not a part of a tag
    or an HTML entity must be replaced with the corresponding HTML entities".
    ``quote=False`` keeps apostrophes and quotes literal, which Telegram accepts
    outside of tag attributes and which reads better in a message.
    """
    return html.escape(text, quote=False)


class TelegramNotifier:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._transport = transport

    # -- configuration ------------------------------------------------------
    def is_configured(self) -> bool:
        return bool(self._settings.telegram_bot_token.strip())

    @property
    def configured_chat_id(self) -> str:
        return self._settings.telegram_chat_id.strip()

    def token_hint(self) -> str | None:
        """A non-reversible hint so the UI can show *which* token is loaded."""
        token = self._settings.telegram_bot_token.strip()
        if not token:
            return None
        bot_id, _, _ = token.partition(":")
        return f"bot id {bot_id}" if bot_id.isdigit() else "token loaded"

    # -- API calls ----------------------------------------------------------
    def get_me(self) -> TelegramResult:
        result = self._call("getMe", {})
        if result.ok:
            payload = result.meta.get("result") or {}
            identity = BotIdentity(
                bot_id=int(payload.get("id", 0)),
                username=payload.get("username"),
                first_name=payload.get("first_name"),
            )
            return TelegramResult(
                ok=True,
                category="ok",
                user_message=f"Connected as {identity.handle}.",
                meta={"identity": identity, "result": payload},
            )
        return result

    def discover_chats(self, limit: int = 100) -> tuple[list[DiscoveredChat], TelegramResult]:
        """List recent direct chats that have messaged the bot.

        ``getUpdates`` only returns updates from the last 24 hours and only
        while no webhook is set, so an empty list usually means "/start was
        never sent" rather than a failure.
        """
        result = self._call(
            "getUpdates",
            {"limit": max(1, min(limit, 100)), "timeout": 0, "allowed_updates": '["message"]'},
        )
        if not result.ok:
            return [], result

        updates = result.meta.get("result") or []
        found: dict[int, DiscoveredChat] = {}
        for update in updates:
            message = update.get("message") if isinstance(update, dict) else None
            if not isinstance(message, dict):
                continue
            chat = message.get("chat")
            if not isinstance(chat, dict):
                continue
            chat_type = str(chat.get("type") or "")
            if chat_type != "private":
                # A single-user tool alerts a direct chat, not groups/channels.
                continue
            chat_id = chat.get("id")
            if not isinstance(chat_id, int):
                continue
            name = " ".join(
                str(chat.get(key)) for key in ("first_name", "last_name") if chat.get(key)
            ).strip()
            if chat.get("username"):
                name = f"{name} (@{chat['username']})".strip()
            timestamp = message.get("date")
            found[chat_id] = DiscoveredChat(
                chat_id=chat_id,
                chat_type=chat_type,
                display_name=name or f"chat {chat_id}",
                last_message_at=(
                    datetime.fromtimestamp(timestamp, tz=UTC)
                    if isinstance(timestamp, int)
                    else None
                ),
                last_text=str(message.get("text"))[:120] if message.get("text") else None,
            )

        chats = sorted(
            found.values(),
            key=lambda c: c.last_message_at or datetime.fromtimestamp(0, tz=UTC),
            reverse=True,
        )
        if not chats:
            return [], TelegramResult(
                ok=False,
                category="no_chats",
                user_message=(
                    "No recent direct chat was found. Open Telegram, send /start to your "
                    "bot, then try again. Telegram only keeps updates for 24 hours, and "
                    "this will not work if the bot has a webhook configured."
                ),
            )
        return chats, TelegramResult(ok=True, category="ok", user_message="")

    def send_message(
        self, chat_id: str | int, text: str, *, disable_preview: bool = False
    ) -> TelegramResult:
        payload: dict[str, Any] = {
            "chat_id": str(chat_id),
            "text": text,
            "parse_mode": "HTML",
        }
        if disable_preview:
            payload["link_preview_options"] = '{"is_disabled":true}'
        result = self._call("sendMessage", payload)
        if result.ok:
            message = result.meta.get("result") or {}
            chat = message.get("chat") if isinstance(message, dict) else None
            return TelegramResult(
                ok=True,
                message_id=message.get("message_id"),
                category="ok",
                user_message="Message delivered.",
                meta={"chat_id": chat.get("id") if isinstance(chat, dict) else None},
            )
        return result

    # -- transport ----------------------------------------------------------
    def _call(self, method: str, payload: dict[str, Any]) -> TelegramResult:
        token = self._settings.telegram_bot_token.strip()
        if not token:
            return TelegramResult(
                ok=False,
                category="not_configured",
                user_message=(
                    "TELEGRAM_BOT_TOKEN is not set, so no message was sent. Create a bot "
                    "with @BotFather, put the token in .env and restart FlightNotify."
                ),
            )

        url = f"{self._settings.telegram_base_url.rstrip('/')}/bot{token}/{method}"
        try:
            with httpx.Client(
                timeout=self._settings.telegram_timeout_seconds, transport=self._transport
            ) as client:
                response = client.post(url, data=payload)
        except httpx.TimeoutException:
            return TelegramResult(
                ok=False,
                category="timeout",
                user_message=(
                    "Telegram did not respond in time. Any price observation from this "
                    "check is still saved. FlightNotify will retry on the next alert."
                ),
            )
        except httpx.HTTPError as exc:
            return TelegramResult(
                ok=False,
                category="network",
                user_message=(
                    f"Could not reach Telegram ({type(exc).__name__}). Any price observation "
                    "from this check is still saved. Check this machine's network access."
                ),
            )

        try:
            body = response.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}

        if body.get("ok"):
            return TelegramResult(ok=True, category="ok", meta=body)

        return self._map_error(response.status_code, body)

    def _map_error(self, status: int, body: dict[str, Any]) -> TelegramResult:
        error_code = body.get("error_code") or status
        description = str(body.get("description") or f"HTTP {status}")
        raw_parameters = body.get("parameters")
        parameters: dict[str, Any] = raw_parameters if isinstance(raw_parameters, dict) else {}
        retry_after = parameters.get("retry_after")
        lowered = description.lower()

        if error_code == 401 or "unauthorized" in lowered:
            category, message = (
                "invalid_token",
                "Telegram rejected the bot token. No message was sent and stored price "
                "history is unchanged. Re-check TELEGRAM_BOT_TOKEN with @BotFather.",
            )
        elif error_code == 429 or "too many requests" in lowered:
            category, message = (
                "rate_limit",
                "Telegram rate-limited the bot"
                + (f"; retry after {int(retry_after)}s. " if retry_after else ". ")
                + "The price observation is saved and the alert will be retried.",
            )
        elif error_code == 403 or "blocked" in lowered or "forbidden" in lowered:
            category, message = (
                "blocked",
                "The bot cannot message that chat - it was blocked or never started. "
                "The price observation is saved. Send /start to the bot in Telegram.",
            )
        elif "chat not found" in lowered:
            category, message = (
                "chat_not_found",
                "Telegram does not recognise that chat id. The price observation is "
                "saved. Send /start to the bot, then use Settings → Discover chat.",
            )
        elif error_code >= 500:
            category, message = (
                "server_error",
                "Telegram returned a server error. The price observation is saved and "
                "the alert will be retried.",
            )
        else:
            category, message = (
                "error",
                f"Telegram rejected the request: {description}. The price observation is saved.",
            )

        return TelegramResult(
            ok=False,
            error_code=int(error_code) if isinstance(error_code, int) else None,
            description=description,
            retry_after=float(retry_after) if isinstance(retry_after, int | float) else None,
            category=category,
            user_message=message,
            meta={"error_code": error_code, "description": description},
        )
