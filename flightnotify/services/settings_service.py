"""Non-secret application settings stored in the database.

Credentials never land here. The Telegram *chat id* is an addressing
identifier, not a credential, so it is persisted when discovered; the bot token
always stays in the environment.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..models import AppSetting
from ..timeutil import utcnow

KEY_TELEGRAM_CHAT_ID = "telegram_chat_id"
KEY_DEFAULT_MARKET = "default_market"
KEY_DEFAULT_CURRENCY = "default_currency"
KEY_QUOTA_RESERVE = "quota_reserve_override"
KEY_TIMEZONE_NOTE = "timezone_note"

#: Keys the Settings screen is allowed to write. Anything else is rejected so a
#: crafted form cannot inject arbitrary rows.
WRITABLE_KEYS = frozenset(
    {KEY_TELEGRAM_CHAT_ID, KEY_DEFAULT_MARKET, KEY_DEFAULT_CURRENCY, KEY_QUOTA_RESERVE}
)


def get_setting(session: Session, key: str, default: Any = None) -> Any:
    row = session.get(AppSetting, key)
    if row is None or row.value is None:
        return default
    return row.value


def set_setting(session: Session, key: str, value: Any) -> None:
    if key not in WRITABLE_KEYS:
        raise ValueError(f"{key!r} is not a writable application setting.")
    row = session.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key, value=value)
        session.add(row)
    else:
        row.value = value
        row.updated_at = utcnow()
    session.flush()


def get_chat_id(session: Session, settings: Settings | None = None) -> str | None:
    """Environment value wins; a discovered chat id is the fallback."""
    settings = settings or get_settings()
    if settings.telegram_chat_id.strip():
        return settings.telegram_chat_id.strip()
    stored = get_setting(session, KEY_TELEGRAM_CHAT_ID)
    return str(stored) if stored else None


def chat_id_source(session: Session, settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    if settings.telegram_chat_id.strip():
        return "environment (TELEGRAM_CHAT_ID)"
    if get_setting(session, KEY_TELEGRAM_CHAT_ID):
        return "discovered in Settings"
    return "not set"


def default_market(session: Session, settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return str(get_setting(session, KEY_DEFAULT_MARKET, settings.default_market)).lower()


def default_currency(session: Session, settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return str(get_setting(session, KEY_DEFAULT_CURRENCY, settings.default_currency)).upper()


def quota_reserve(session: Session, settings: Settings | None = None) -> int:
    settings = settings or get_settings()
    stored = get_setting(session, KEY_QUOTA_RESERVE)
    try:
        return int(stored) if stored is not None else settings.serpapi_reserve_searches
    except (TypeError, ValueError):
        return settings.serpapi_reserve_searches
