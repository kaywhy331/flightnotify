"""Gate every live test behind an explicit opt-in.

Nothing in this directory runs unless ``FLIGHTNOTIFY_LIVE_TESTS=1`` is set AND
the relevant credential is present. CI never sets either, so CI never spends
provider quota.
"""

from __future__ import annotations

import os

import pytest

from flightnotify.config import Settings

LIVE_ENV_FLAG = "FLIGHTNOTIFY_LIVE_TESTS"


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    if os.environ.get(LIVE_ENV_FLAG) == "1":
        return
    skip = pytest.mark.skip(
        reason=f"live tests are opt-in: set {LIVE_ENV_FLAG}=1 (they consume provider searches)"
    )
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def live_settings() -> Settings:
    settings = Settings()
    if not settings.has_provider_credentials:
        pytest.skip("SERPAPI_API_KEY is not set")
    return settings


@pytest.fixture(scope="session")
def live_telegram_settings() -> Settings:
    settings = Settings()
    if not settings.has_telegram_token:
        pytest.skip("TELEGRAM_BOT_TOKEN is not set")
    if not settings.telegram_chat_id.strip():
        pytest.skip("TELEGRAM_CHAT_ID is not set")
    return settings
