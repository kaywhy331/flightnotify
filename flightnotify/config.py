"""Application configuration.

Secrets are read from the environment (or a local ``.env``) and are never
written to the database, rendered into templates, or emitted in logs.
"""

from __future__ import annotations

import secrets
import stat
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class PriceScope(StrEnum):
    """How a provider-reported price should be interpreted."""

    PARTY_TOTAL = "party_total"
    PER_TRAVELER = "per_traveler"
    UNKNOWN = "unknown"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- provider -----------------------------------------------------------
    serpapi_api_key: str = ""
    serpapi_base_url: str = "https://serpapi.com"
    serpapi_monthly_search_limit: int = 250
    serpapi_hourly_search_limit: int = 50
    serpapi_reserve_searches: int = 10
    serpapi_price_scope: PriceScope = PriceScope.PARTY_TOTAL
    serpapi_timeout_seconds: float = 60.0

    # --- telegram -----------------------------------------------------------
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    telegram_base_url: str = "https://api.telegram.org"
    telegram_timeout_seconds: float = 20.0

    # --- application --------------------------------------------------------
    app_timezone: str = "America/Los_Angeles"
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    app_secret_key: str = ""
    database_url: str = "sqlite:///data/flightnotify.db"
    default_market: str = "us"
    default_currency: str = "USD"
    log_level: str = "INFO"
    log_format: str = "text"

    query_cache_ttl_seconds: int = 900
    scheduler_enabled: bool = True
    scheduler_tick_seconds: int = 60
    scheduler_lock_ttl_seconds: int = 300
    #: Apply pending Alembic migrations on startup so a clean checkout never
    #: needs tables created by hand. Set false to gate schema changes manually.
    auto_migrate: bool = True

    #: Set by the test suite / CI so nothing can reach the network by accident.
    offline_mode: bool = Field(default=False, alias="FLIGHTNOTIFY_OFFLINE")

    @field_validator("default_market")
    @classmethod
    def _lower_market(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("default_currency")
    @classmethod
    def _upper_currency(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("app_timezone")
    @classmethod
    def _validate_tz(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:  # pragma: no cover - config error
            raise ValueError(f"APP_TIMEZONE {value!r} is not a known IANA timezone") from exc
        return value

    @field_validator("serpapi_reserve_searches", "serpapi_monthly_search_limit")
    @classmethod
    def _non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError("must be zero or greater")
        return value

    # --- derived ------------------------------------------------------------
    @property
    def tzinfo(self) -> ZoneInfo:
        return ZoneInfo(self.app_timezone)

    @property
    def has_provider_credentials(self) -> bool:
        return bool(self.serpapi_api_key.strip())

    @property
    def has_telegram_token(self) -> bool:
        return bool(self.telegram_bot_token.strip())

    @property
    def sqlite_path(self) -> Path | None:
        """Filesystem path backing a SQLite ``DATABASE_URL``, if any."""
        url = self.database_url
        if not url.startswith("sqlite"):
            return None
        _, _, tail = url.partition("///")
        if not tail or tail == ":memory:":
            return None
        path = Path(tail)
        return path if path.is_absolute() else (PROJECT_ROOT / path)

    def resolved_secret_key(self) -> str:
        """Return the signing key, generating and persisting one if needed.

        A generated key lives in ``data/secret_key`` with 0600 permissions so a
        clean checkout works without the operator hand-crafting a secret, while
        no real secret is ever committed.
        """
        if self.app_secret_key.strip():
            return self.app_secret_key.strip()

        sqlite_path = self.sqlite_path
        base = sqlite_path.parent if sqlite_path else (PROJECT_ROOT / "data")
        base.mkdir(parents=True, exist_ok=True)
        key_file = base / "secret_key"
        if key_file.exists():
            existing = key_file.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        generated = secrets.token_urlsafe(48)
        key_file.write_text(generated, encoding="utf-8")
        key_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        return generated

    def secret_values(self) -> list[str]:
        """Every literal secret, for log redaction."""
        return [v for v in (self.serpapi_api_key.strip(), self.telegram_bot_token.strip()) if v]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Drop the cached settings (used by tests and the CLI)."""
    get_settings.cache_clear()
