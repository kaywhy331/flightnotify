"""Live Telegram checks.

These send a real message to the configured chat. They consume no provider
quota. Run explicitly:

    FLIGHTNOTIFY_LIVE_TESTS=1 .venv/bin/pytest -m live tests/live/test_live_telegram.py -s
"""

from __future__ import annotations

import pytest

from flightnotify.services.messages import build_test_message
from flightnotify.services.telegram import TelegramNotifier
from flightnotify.timeutil import utcnow

pytestmark = pytest.mark.live


def test_bot_token_is_valid(live_telegram_settings):
    result = TelegramNotifier(live_telegram_settings).get_me()
    print(f"\n[live] getMe: {result.user_message}")
    assert result.ok, result.user_message


def test_send_a_real_test_message(live_telegram_settings):
    notifier = TelegramNotifier(live_telegram_settings)
    result = notifier.send_message(
        live_telegram_settings.telegram_chat_id,
        build_test_message(live_telegram_settings.tzinfo, utcnow()),
        disable_preview=True,
    )
    print(f"\n[live] sendMessage: ok={result.ok} message_id={result.message_id}")
    assert result.ok, result.user_message
    assert result.message_id


def test_discover_finds_the_configured_chat(live_telegram_settings):
    """Requires that /start was sent to the bot within the last 24 hours."""
    chats, result = TelegramNotifier(live_telegram_settings).discover_chats()
    print(f"\n[live] discovered {len(chats)} chat(s): {[c.chat_id for c in chats]}")
    if not chats:
        pytest.skip(result.user_message)
    assert all(chat.chat_type == "private" for chat in chats)
