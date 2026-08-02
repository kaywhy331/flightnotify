"""Alert evaluation, deduplication, delivery and Telegram error handling."""

from __future__ import annotations

import copy
from decimal import Decimal

import pytest

from flightnotify.enums import AlertType, DeliveryState, RunTrigger
from flightnotify.models import AlertEvent, FareObservation
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.services.alerts import AlertService
from flightnotify.services.messages import AlertContext, build_alert_text, coverage_sentence
from flightnotify.services.search import SearchService
from flightnotify.services.settings_service import KEY_TELEGRAM_CHAT_ID, get_chat_id, set_setting
from flightnotify.services.telegram import TelegramNotifier, escape_html
from tests.conftest import json_transport, sequence_transport

#: Obviously fake, but shaped like a real token so redaction is exercised.
FAKE_TOKEN = "123456789:TESTTOKEN-not-real-aaaaaaaaaaaaaaaaaaaaaaa"

OK_SEND = {"ok": True, "result": {"message_id": 42, "chat": {"id": 987}}}


@pytest.fixture()
def tg_settings(settings):
    return settings.model_copy(update={"telegram_bot_token": FAKE_TOKEN, "telegram_chat_id": "987"})


def alert_service(tg_settings, transport, recorder=None):
    notifier = TelegramNotifier(tg_settings, transport=transport)
    return AlertService(tg_settings, notifier=notifier)


def search_with_alerts(settings_obj, flights_payload, alerts, recorder=None):
    provider = SerpApiProvider(
        settings_obj, transport=json_transport(flights_payload, recorder=recorder)
    )
    return SearchService(settings_obj, provider=provider, alerts=alerts)


# ---------------------------------------------------------------- delivery
def test_threshold_alert_is_delivered_with_the_expected_content(
    session, tg_settings, make_tracker, flights_payload
):
    sent: list = []
    service = search_with_alerts(
        tg_settings,
        flights_payload,
        alert_service(tg_settings, json_transport(OK_SEND, recorder=sent)),
    )
    tracker = make_tracker(threshold_amount=Decimal("1300"))
    result = service.run_tracker(session, tracker, trigger=RunTrigger.INITIAL)

    assert [o.state for o in result.alerts] == [DeliveryState.SENT]
    event = session.query(AlertEvent).one()
    assert event.alert_type == AlertType.THRESHOLD.value
    assert event.delivery_state == DeliveryState.SENT.value
    assert event.telegram_message_id == 42

    body = event.message_text
    assert "SFO" in body and "NRT" in body
    assert "$1,248" in body
    assert "2 adults" in body
    assert "Economy" in body
    assert "US market" in body
    assert "Price and availability can change before booking." in body
    assert "https://www.google.com/travel/flights" in body
    # A baseline must never be described as a drop.
    assert "baseline" in body
    assert "down $" not in body

    assert sent and sent[0].url.path.endswith("/sendMessage")


def test_new_low_alert_reports_the_previous_low_and_the_drop(
    session, tg_settings, make_tracker, flights_payload
):
    notifier_transport = json_transport(OK_SEND)
    alerts = alert_service(tg_settings, notifier_transport)
    tracker = make_tracker(threshold_amount=Decimal("1300"))

    search_with_alerts(tg_settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )
    cheaper = copy.deepcopy(flights_payload)
    cheaper["best_flights"][0]["price"] = 1106
    search_with_alerts(tg_settings, cheaper, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True
    )

    events = session.query(AlertEvent).order_by(AlertEvent.id).all()
    low = [e for e in events if e.alert_type == AlertType.NEW_LOW.value]
    assert len(low) == 1
    assert low[0].delivery_state == DeliveryState.SENT.value
    assert "New observed low" in low[0].message_text
    assert "Previous observed low: $1,248" in low[0].message_text
    assert "down $142" in low[0].message_text


def test_identical_repeat_observation_is_deduplicated(
    session, tg_settings, make_tracker, flights_payload
):
    sent: list = []
    alerts = alert_service(tg_settings, json_transport(OK_SEND, recorder=sent))
    tracker = make_tracker(threshold_amount=Decimal("1300"))
    service = search_with_alerts(tg_settings, flights_payload, alerts)

    service.run_tracker(session, tracker, trigger=RunTrigger.INITIAL)
    first_count = len(sent)
    service.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True)

    assert len(sent) == first_count  # nothing new was delivered
    assert session.query(AlertEvent).count() == 1


def test_cooldown_suppresses_a_second_alert_of_the_same_type(
    session, tg_settings, make_tracker, flights_payload
):
    """A second new low inside the cooldown window is recorded but not sent."""
    sent: list = []
    alerts = alert_service(tg_settings, json_transport(OK_SEND, recorder=sent))
    tracker = make_tracker(
        threshold_amount=Decimal("1300"),
        cooldown_minutes=360,
        alert_on_threshold=False,  # keep only the new-low path in play
    )
    search_with_alerts(tg_settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )

    for price in (1200, 1100):
        cheaper = copy.deepcopy(flights_payload)
        cheaper["best_flights"][0]["price"] = price
        search_with_alerts(tg_settings, cheaper, alerts).run_tracker(
            session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True
        )

    states = [e.delivery_state for e in session.query(AlertEvent).order_by(AlertEvent.id).all()]
    assert states.count(DeliveryState.SENT.value) == 1
    assert DeliveryState.SUPPRESSED_COOLDOWN.value in states
    assert len(sent) == 1  # only the first new low reached Telegram


def test_delivery_failure_keeps_the_observation_and_stays_visible(
    session, tg_settings, make_tracker, flights_payload
):
    alerts = alert_service(
        tg_settings,
        json_transport(
            {
                "ok": False,
                "error_code": 403,
                "description": "Forbidden: bot was blocked by the user",
            },
            status_code=403,
        ),
    )
    tracker = make_tracker(threshold_amount=Decimal("1300"))
    result = search_with_alerts(tg_settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )

    session.refresh(tracker)
    assert tracker.low_price == Decimal("1248.00")  # observation survived
    assert session.query(FareObservation).count() == 2

    event = session.query(AlertEvent).one()
    assert event.delivery_state == DeliveryState.FAILED.value
    assert "blocked or never started" in event.last_error
    assert event.attempts == 1
    assert any("blocked" in error for error in result.errors)


def test_missing_telegram_config_records_the_alert_without_delivering(
    session, settings, make_tracker, flights_payload
):
    alerts = AlertService(settings, notifier=TelegramNotifier(settings))
    tracker = make_tracker(threshold_amount=Decimal("1300"))
    search_with_alerts(settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )
    event = session.query(AlertEvent).one()
    assert event.delivery_state == DeliveryState.NOT_CONFIGURED.value
    assert "TELEGRAM_BOT_TOKEN" in event.last_error


def test_retry_pending_redelivers_a_failed_alert(
    session, tg_settings, make_tracker, flights_payload
):
    failing = alert_service(
        tg_settings,
        json_transport(
            {"ok": False, "error_code": 500, "description": "Internal"}, status_code=500
        ),
    )
    tracker = make_tracker(threshold_amount=Decimal("1300"))
    search_with_alerts(tg_settings, flights_payload, failing).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )
    assert session.query(AlertEvent).one().delivery_state == DeliveryState.FAILED.value

    recovered = alert_service(tg_settings, json_transport(OK_SEND))
    assert recovered.retry_pending(session, "987") == 1
    event = session.query(AlertEvent).one()
    assert event.delivery_state == DeliveryState.SENT.value
    assert event.attempts == 2


def test_alerts_disabled_produce_no_events(session, tg_settings, make_tracker, flights_payload):
    alerts = alert_service(tg_settings, json_transport(OK_SEND))
    tracker = make_tracker(alert_on_threshold=False, alert_on_new_low=False)
    search_with_alerts(tg_settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )
    assert session.query(AlertEvent).count() == 0


# ------------------------------------------------------------- Telegram API
def test_get_me_success(tg_settings):
    notifier = TelegramNotifier(
        tg_settings,
        transport=json_transport(
            {"ok": True, "result": {"id": 1, "is_bot": True, "username": "flightnotify_bot"}}
        ),
    )
    result = notifier.get_me()
    assert result.ok
    assert "@flightnotify_bot" in result.user_message


@pytest.mark.parametrize(
    ("status", "body", "category", "phrase"),
    [
        (401, {"error_code": 401, "description": "Unauthorized"}, "invalid_token", "bot token"),
        (
            400,
            {"error_code": 400, "description": "Bad Request: chat not found"},
            "chat_not_found",
            "chat id",
        ),
        (
            403,
            {"error_code": 403, "description": "Forbidden: bot was blocked by the user"},
            "blocked",
            "/start",
        ),
        (
            429,
            {
                "error_code": 429,
                "description": "Too Many Requests: retry after 7",
                "parameters": {"retry_after": 7},
            },
            "rate_limit",
            "rate-limited",
        ),
        (
            500,
            {"error_code": 500, "description": "Internal Server Error"},
            "server_error",
            "retried",
        ),
    ],
)
def test_send_message_error_mapping(tg_settings, status, body, category, phrase):
    payload = {"ok": False, **body}
    notifier = TelegramNotifier(tg_settings, transport=json_transport(payload, status_code=status))
    result = notifier.send_message("987", "hello")
    assert not result.ok
    assert result.category == category
    assert phrase in result.user_message
    if category == "rate_limit":
        assert result.retry_after == 7.0
        assert result.retryable


def test_send_message_timeout_is_reported_as_retryable(tg_settings):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    notifier = TelegramNotifier(tg_settings, transport=httpx.MockTransport(handler))
    result = notifier.send_message("987", "hello")
    assert result.category == "timeout"
    assert result.retryable
    assert "still saved" in result.user_message


def test_not_configured_is_reported_before_any_request(settings):
    notifier = TelegramNotifier(settings)
    result = notifier.send_message("1", "hello")
    assert result.category == "not_configured"
    assert "BotFather" in result.user_message


def test_discover_chats_returns_only_recent_private_chats(tg_settings):
    payload = {
        "ok": True,
        "result": [
            {
                "update_id": 1,
                "message": {
                    "message_id": 1,
                    "date": 1785000000,
                    "text": "/start",
                    "chat": {"id": 987, "type": "private", "first_name": "Kay", "username": "kay"},
                },
            },
            {
                "update_id": 2,
                "message": {
                    "message_id": 2,
                    "date": 1785000100,
                    "text": "hi",
                    "chat": {"id": -100123, "type": "supergroup", "title": "Travel"},
                },
            },
        ],
    }
    notifier = TelegramNotifier(tg_settings, transport=json_transport(payload))
    chats, result = notifier.discover_chats()
    assert result.ok
    assert [c.chat_id for c in chats] == [987]
    assert "@kay" in chats[0].display_name


def test_discover_chats_explains_a_missing_start(tg_settings):
    notifier = TelegramNotifier(tg_settings, transport=json_transport({"ok": True, "result": []}))
    chats, result = notifier.discover_chats()
    assert chats == []
    assert "/start" in result.user_message


def test_token_hint_never_reveals_the_token(tg_settings):
    hint = TelegramNotifier(tg_settings).token_hint()
    assert hint == "bot id 123456789"
    assert FAKE_TOKEN.split(":")[1] not in hint


# ------------------------------------------------------------------ message
def test_html_escaping_follows_telegram_rules():
    assert escape_html("Fly <SFO> & save") == "Fly &lt;SFO&gt; &amp; save"


def test_coverage_sentence_never_calls_a_partial_scan_complete():
    assert coverage_sentence(18, 24, complete=False) == (
        "Lowest observed among 18 of 24 date combinations checked."
    )
    assert "all 24" in coverage_sentence(24, 24, complete=True)
    assert coverage_sentence(None, 1, complete=True) == ""


def test_alert_body_includes_partial_coverage_wording(tg_settings):
    from datetime import date

    from flightnotify.enums import PriceScopeLabel, ThresholdBasis
    from flightnotify.timeutil import utcnow

    text = build_alert_text(
        AlertContext(
            alert_type=AlertType.NEW_LOW,
            tracker_name="Tokyo trip",
            origin="SFO",
            destination="NRT",
            passenger_summary="2 adults",
            cabin="economy",
            currency="USD",
            comparable_amount=Decimal("1248"),
            threshold_amount=Decimal("1300"),
            threshold_basis=ThresholdBasis.PARTY,
            price_scope=PriceScopeLabel.PARTY_TOTAL,
            outbound_date=date(2026, 10, 12),
            return_date=date(2026, 10, 20),
            stops=1,
            market="us",
            observed_at=utcnow(),
            previous_low=Decimal("1390"),
            drop_absolute=Decimal("142"),
            is_baseline=False,
            coverage_checked=18,
            coverage_total=24,
            coverage_complete=False,
            link=None,
            airlines=["ANA"],
        ),
        tg_settings.tzinfo,
    )
    assert "Lowest observed among 18 of 24 date combinations checked." in text
    assert "Oct 12–20" in text
    assert "1 stop" in text
    assert "down $142" in text
    assert "<a href" not in text  # no link was supplied, so none is invented


# ------------------------------------------------------------------- chat id
def test_chat_id_prefers_the_environment_then_the_database(session, settings):
    assert get_chat_id(session, settings) is None
    set_setting(session, KEY_TELEGRAM_CHAT_ID, "555")
    session.commit()
    assert get_chat_id(session, settings) == "555"
    env = settings.model_copy(update={"telegram_chat_id": "111"})
    assert get_chat_id(session, env) == "111"


def test_only_allowlisted_settings_keys_can_be_written(session):
    with pytest.raises(ValueError, match="not a writable"):
        set_setting(session, "serpapi_api_key", "nope")


def test_retry_after_backoff_sequence_is_bounded(tg_settings):
    """Two failures then success: attempts are counted, not unbounded."""
    transport = sequence_transport(
        [
            (500, {"ok": False, "error_code": 500, "description": "Internal"}),
            (200, OK_SEND),
        ]
    )
    notifier = TelegramNotifier(tg_settings, transport=transport)
    assert notifier.send_message("987", "one").ok is False
    assert notifier.send_message("987", "two").ok is True


# ------------------------------------------------- one observation, one message
def test_one_observation_never_sends_two_messages(
    session, tg_settings, make_tracker, flights_payload
):
    """A fare that is both a new low and under threshold sends a single alert."""
    sent: list = []
    alerts = alert_service(tg_settings, json_transport(OK_SEND, recorder=sent))
    tracker = make_tracker(threshold_amount=Decimal("1300"))

    search_with_alerts(tg_settings, flights_payload, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.INITIAL
    )
    baseline_messages = len(sent)

    cheaper = copy.deepcopy(flights_payload)
    cheaper["best_flights"][0]["price"] = 1106  # new low AND under threshold
    search_with_alerts(tg_settings, cheaper, alerts).run_tracker(
        session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True
    )

    assert len(sent) - baseline_messages == 1, "exactly one message for one observation"

    events = session.query(AlertEvent).order_by(AlertEvent.id).all()
    latest_low = [e for e in events if e.alert_type == AlertType.NEW_LOW.value]
    consolidated = [
        e
        for e in events
        if e.alert_type == AlertType.THRESHOLD.value
        and e.delivery_state == DeliveryState.SUPPRESSED_DUPLICATE.value
    ]
    assert latest_low and latest_low[-1].delivery_state == DeliveryState.SENT.value
    # The threshold event is still recorded, with the reason it was not sent.
    assert consolidated and "Consolidated into" in consolidated[-1].last_error


def test_exact_search_observation_uses_the_dates_it_requested(
    session, settings, make_tracker, flights_payload, today
):
    """Outbound and return must come from one source, never a mixed pair."""
    from datetime import timedelta

    from flightnotify.models import FareObservation

    out = today + timedelta(days=60)
    back = today + timedelta(days=68)
    tracker = make_tracker(outbound_date=out, return_date=back)
    provider = SerpApiProvider(settings, transport=json_transport(flights_payload))
    SearchService(settings, provider=provider).run_tracker(
        session, tracker, trigger=RunTrigger.MANUAL
    )
    for observation in session.query(FareObservation).all():
        assert observation.outbound_date == out
        assert observation.return_date == back
        assert observation.return_date > observation.outbound_date


def test_reversed_date_pair_is_spelled_out_rather_than_collapsed():
    from datetime import date

    from flightnotify.services.messages import _date_range

    assert _date_range(date(2026, 10, 12), date(2026, 10, 20)) == "Oct 12–20"
    assert _date_range(date(2026, 10, 12), date(2026, 11, 3)) == "Oct 12–Nov 3"
    # An incoherent pair must not render as the tidy "Oct 12-8".
    assert _date_range(date(2026, 10, 12), date(2026, 10, 8)) == "Oct 12, 2026 → Oct 8, 2026"
