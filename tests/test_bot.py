"""Telegram command bot.

The load-bearing test here is authorisation: FlightNotify has no other inbound
surface, so a command from any chat but the configured one must produce no
reply, no state change and no provider search.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest
from sqlalchemy.orm import Session, sessionmaker

from flightnotify import db as db_module
from flightnotify.config import Settings
from flightnotify.enums import RunTrigger, TrackerStatus
from flightnotify.models import Base, Tracker
from flightnotify.services.bot import BotPoller, parse_command
from flightnotify.services.scheduler import acquire_bot_lease, acquire_tracker_lock
from flightnotify.services.settings_service import KEY_BOT_UPDATE_OFFSET, get_setting
from flightnotify.services.telegram import TelegramNotifier

OWNER_CHAT = 4242
STRANGER_CHAT = 9999


@pytest.fixture()
def settings(tmp_path) -> Settings:
    """Telegram fully configured, unlike the shared fixture."""
    return Settings(
        serpapi_api_key="test-key-not-real",
        telegram_bot_token="123456:test-token",
        telegram_chat_id=str(OWNER_CHAT),
        database_url=f"sqlite:///{tmp_path / 'bot.db'}",
        app_timezone="UTC",
        app_secret_key="test-secret-key-for-sessions-only",
        scheduler_enabled=False,
        bot_enabled=True,
        log_level="WARNING",
    )


@pytest.fixture()
def session_factory(settings: Settings):
    engine = db_module.create_db_engine(settings)
    Base.metadata.create_all(engine)
    db_module.configure_engine(engine)
    yield db_module.get_session_factory()
    engine.dispose()


def make_update(update_id: int, text: str, chat_id: int = OWNER_CHAT, chat_type: str = "private"):
    return {
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "chat": {"id": chat_id, "type": chat_type},
            "text": text,
        },
    }


def bot_transport(
    updates: list[dict[str, Any]], sent: list[dict[str, str]], polls: list[dict[str, str]]
) -> httpx.MockTransport:
    """Serve getUpdates once, record every sendMessage."""

    def handler(request: httpx.Request) -> httpx.Response:
        form = dict(parse_qsl(request.content.decode()))
        if request.url.path.endswith("/getUpdates"):
            polls.append(form)
            return httpx.Response(200, json={"ok": True, "result": updates})
        if request.url.path.endswith("/sendMessage"):
            sent.append(form)
            return httpx.Response(
                200,
                json={"ok": True, "result": {"message_id": 1, "chat": {"id": OWNER_CHAT}}},
            )
        return httpx.Response(200, json={"ok": True, "result": {}})

    return httpx.MockTransport(handler)


def make_poller(
    settings: Settings,
    session_factory: sessionmaker[Session],
    updates: list[dict[str, Any]],
    sent: list[dict[str, str]],
    polls: list[dict[str, str]] | None = None,
    service: Any = None,
) -> BotPoller:
    # `polls or []` would discard a caller's (falsy) empty list.
    notifier = TelegramNotifier(
        settings, transport=bot_transport(updates, sent, [] if polls is None else polls)
    )
    return BotPoller(session_factory, settings, notifier=notifier, service=service)


def add_tracker(session: Session, **overrides: Any) -> Tracker:
    today = date.today()
    defaults: dict[str, Any] = {
        "name": "SFO to Tokyo",
        "status": TrackerStatus.ACTIVE.value,
        "origin": "SFO",
        "destination": "NRT",
        "adults": 2,
        "cabin": "economy",
        "stops": "any",
        "currency": "USD",
        "date_mode": "exact",
        "outbound_date": today + timedelta(days=60),
        "return_date": today + timedelta(days=68),
        "threshold_amount": Decimal("1300.00"),
        "threshold_basis": "party",
        "check_interval_minutes": 720,
        "candidates_per_run": 1,
    }
    defaults.update(overrides)
    tracker = Tracker(**defaults)
    session.add(tracker)
    session.commit()
    session.refresh(tracker)
    return tracker


# ----------------------------------------------------------------- parsing
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("/status", ("/status", None)),
        ("/tracker 3", ("/tracker", "3")),
        ("/CHECK 2", ("/check", "2")),
        ("/check@FlightNotifyBot 7", ("/check", "7")),
        ("  /trackers  ", ("/trackers", None)),
        ("hello", ("", None)),
    ],
)
def test_parse_command(text, expected):
    assert parse_command(text) == expected


# ----------------------------------------------------------- authorisation
def test_command_from_another_chat_is_ignored_without_a_reply(settings, session_factory):
    """The one that matters: a stranger gets silence, not an error."""
    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings,
        session_factory,
        [make_update(1, "/status", chat_id=STRANGER_CHAT)],
        sent,
    )

    handled = poller.poll_once()

    assert handled == 0
    assert sent == [], "replying would confirm the bot exists to an unauthorised chat"


def test_a_group_chat_is_ignored_even_with_the_right_id(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings,
        session_factory,
        [make_update(1, "/status", chat_type="group")],
        sent,
    )
    assert poller.poll_once() == 0
    assert sent == []


def test_poller_refuses_to_start_without_a_chat_id(settings, session_factory):
    settings = settings.model_copy(update={"telegram_chat_id": ""})
    poller = make_poller(settings, session_factory, [], [])
    assert poller.start() is False
    assert poller.running is False


def test_poller_refuses_to_start_without_a_token(settings, session_factory):
    settings = settings.model_copy(update={"telegram_bot_token": ""})
    poller = make_poller(settings, session_factory, [], [])
    assert poller.start() is False


def test_lease_prevents_a_second_poller(settings, session_factory):
    with session_factory() as session:
        assert acquire_bot_lease(session, "someone-else", 300) is True

    poller = make_poller(settings, session_factory, [], [])
    assert poller.start() is False
    assert poller.running is False


# ---------------------------------------------------------------- replies
def test_help_lists_every_command(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/help")], sent)
    poller.poll_once()

    assert len(sent) == 1
    text = sent[0]["text"]
    for command in ("/status", "/trackers", "/tracker", "/check", "/pause", "/resume"):
        assert command in text


def test_unknown_command_returns_help(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/nope")], sent)
    poller.poll_once()
    assert "/nope" in sent[0]["text"]
    assert "/status" in sent[0]["text"]


def test_status_reports_quota_and_tracker_counts(settings, session_factory):
    with session_factory() as session:
        add_tracker(session)
        add_tracker(session, name="Paused one", status=TrackerStatus.PAUSED.value)

    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/status")], sent)
    poller.poll_once()

    text = sent[0]["text"]
    assert "Trackers: 2 (1 active)" in text
    assert "Quota:" in text
    assert "250" in text


def test_trackers_lists_each_tracker(settings, session_factory):
    with session_factory() as session:
        add_tracker(session, latest_price=Decimal("999.00"))

    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/trackers")], sent)
    poller.poll_once()

    text = sent[0]["text"]
    assert "SFO to Tokyo" in text
    assert "SFO → NRT" in text
    assert "at or below threshold" in text


def test_trackers_with_no_trackers_says_so(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/trackers")], sent)
    poller.poll_once()
    assert "No trackers yet" in sent[0]["text"]


def test_tracker_detail_reports_low_and_threshold(settings, session_factory):
    with session_factory() as session:
        tracker = add_tracker(
            session, latest_price=Decimal("1500.00"), low_price=Decimal("1450.00")
        )

    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings, session_factory, [make_update(1, f"/tracker {tracker.id}")], sent
    )
    poller.poll_once()

    text = sent[0]["text"]
    assert "1,450" in text
    assert "not reached" in text


def test_tracker_name_is_html_escaped(settings, session_factory):
    with session_factory() as session:
        add_tracker(session, name="Cheap <b>SFO</b> & NRT")

    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/trackers")], sent)
    poller.poll_once()

    text = sent[0]["text"]
    assert "&lt;b&gt;SFO&lt;/b&gt;" in text
    assert "&amp;" in text
    assert "<b>SFO</b>" not in text


def test_tracker_detail_for_a_missing_id(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/tracker 99")], sent)
    poller.poll_once()
    assert "No tracker with id 99" in sent[0]["text"]


def test_tracker_without_an_id_explains_the_usage(settings, session_factory):
    sent: list[dict[str, str]] = []
    poller = make_poller(settings, session_factory, [make_update(1, "/tracker")], sent)
    poller.poll_once()
    assert "/tracker 1" in sent[0]["text"]


# ------------------------------------------------------------------ offset
def test_offset_is_persisted_and_advances(settings, session_factory):
    sent: list[dict[str, str]] = []
    polls: list[dict[str, str]] = []
    poller = make_poller(
        settings, session_factory, [make_update(7, "/help"), make_update(8, "/help")], sent, polls
    )

    poller.poll_once()

    with session_factory() as session:
        assert get_setting(session, KEY_BOT_UPDATE_OFFSET) == 8
    # The next poll must ask Telegram to forget everything up to 8.
    poller.poll_once()
    assert polls[-1]["offset"] == "9"


def test_an_update_is_never_handled_twice(settings, session_factory):
    """A restart must not replay commands - /check would spend quota again."""
    sent: list[dict[str, str]] = []
    updates = [make_update(5, "/help")]
    poller = make_poller(settings, session_factory, updates, sent)

    assert poller.poll_once() == 1
    # Telegram would not resend a confirmed update; simulate the offset working
    # by clearing the batch and confirming nothing is replayed from storage.
    updates.clear()
    assert poller.poll_once() == 0
    assert len(sent) == 1


# ------------------------------------------------------------------- check
class _StubService:
    def __init__(self) -> None:
        self.calls: list[RunTrigger] = []

    def run_tracker(self, session, tracker, *, trigger, force_refresh=False):
        self.calls.append(trigger)

        class _Result:
            status_messages: list[str] = []
            errors: list[str] = []

            def summary(self) -> str:
                return "Checked: $1,200.00 observed."

        return _Result()


def test_check_runs_the_tracker_as_a_manual_trigger(settings, session_factory):
    """MANUAL is reserve-eligible - an operator asking may use held-back searches."""
    with session_factory() as session:
        tracker = add_tracker(session)

    service = _StubService()
    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings, session_factory, [make_update(1, f"/check {tracker.id}")], sent, service=service
    )
    poller.poll_once()

    assert service.calls == [RunTrigger.MANUAL]
    assert "observed" in sent[0]["text"]


def test_check_respects_an_existing_tracker_lock(settings, session_factory):
    with session_factory() as session:
        tracker = add_tracker(session)
        assert acquire_tracker_lock(session, tracker.id, "another-worker", 300) is True

    service = _StubService()
    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings, session_factory, [make_update(1, f"/check {tracker.id}")], sent, service=service
    )
    poller.poll_once()

    assert service.calls == [], "a locked tracker must not be checked twice"
    assert "already running" in sent[0]["text"]


def test_check_without_a_provider_key_does_not_search(settings, session_factory):
    with session_factory() as session:
        tracker = add_tracker(session)

    settings = settings.model_copy(update={"serpapi_api_key": ""})
    service = _StubService()
    sent: list[dict[str, str]] = []
    poller = make_poller(
        settings, session_factory, [make_update(1, f"/check {tracker.id}")], sent, service=service
    )
    poller.poll_once()

    assert service.calls == []
    assert "SERPAPI_API_KEY is not set" in sent[0]["text"]


# ---------------------------------------------------------- pause / resume
def test_pause_and_resume_change_status(settings, session_factory):
    with session_factory() as session:
        tracker = add_tracker(session)
        tracker_id = tracker.id

    sent: list[dict[str, str]] = []
    make_poller(
        settings, session_factory, [make_update(1, f"/pause {tracker_id}")], sent
    ).poll_once()
    with session_factory() as session:
        assert session.get(Tracker, tracker_id).status == TrackerStatus.PAUSED.value

    make_poller(
        settings, session_factory, [make_update(2, f"/resume {tracker_id}")], sent
    ).poll_once()
    with session_factory() as session:
        refreshed = session.get(Tracker, tracker_id)
        assert refreshed.status == TrackerStatus.ACTIVE.value
        assert refreshed.consecutive_failures == 0
        assert refreshed.next_run_at is not None


def test_pause_from_an_unauthorised_chat_changes_nothing(settings, session_factory):
    with session_factory() as session:
        tracker = add_tracker(session)
        tracker_id = tracker.id

    sent: list[dict[str, str]] = []
    make_poller(
        settings,
        session_factory,
        [make_update(1, f"/pause {tracker_id}", chat_id=STRANGER_CHAT)],
        sent,
    ).poll_once()

    with session_factory() as session:
        assert session.get(Tracker, tracker_id).status == TrackerStatus.ACTIVE.value
    assert sent == []
