"""HTTP-level tests for the real screens and journeys."""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from flightnotify import config as config_module
from flightnotify.enums import TrackerStatus
from flightnotify.models import FareObservation, SearchRun, Tracker
from flightnotify.web.app import create_app


@pytest.fixture()
def client(settings, session_factory, monkeypatch) -> TestClient:
    """A TestClient wired to the temp database and offline settings."""
    monkeypatch.setattr(config_module, "get_settings", lambda: settings)
    for module in (
        "flightnotify.web.deps",
        "flightnotify.web.app",
        "flightnotify.web.routes.dashboard",
        "flightnotify.web.routes.trackers",
        "flightnotify.web.routes.settings_routes",
        "flightnotify.web.viewmodels",
        "flightnotify.services.quota",
        "flightnotify.services.search",
        "flightnotify.services.alerts",
        "flightnotify.services.telegram",
        "flightnotify.services.settings_service",
        "flightnotify.services.tracker_service",
        "flightnotify.providers.serpapi.provider",
    ):
        monkeypatch.setattr(f"{module}.get_settings", lambda: settings, raising=False)

    app = create_app(
        settings.model_copy(update={"auto_migrate": False, "scheduler_enabled": False})
    )
    with TestClient(app) as test_client:
        yield test_client


def csrf_from(html: str) -> str:
    match = re.search(r'name="csrf_token" value="([^"]+)"', html)
    assert match, "no CSRF token in the page"
    return match.group(1)


def tracker_payload(today, **overrides) -> dict:
    payload = {
        "name": "Tokyo autumn",
        "origin": "SFO",
        "destination": "NRT",
        "adults": "2",
        "children": "0",
        "infants_in_seat": "0",
        "infants_on_lap": "0",
        "cabin": "economy",
        "stops": "any",
        "currency": "USD",
        "markets": ["us"],
        "date_mode": "exact",
        "outbound_date": (today + timedelta(days=60)).isoformat(),
        "return_date": (today + timedelta(days=68)).isoformat(),
        "threshold_amount": "1300",
        "threshold_basis": "party",
        "alert_on_threshold": "1",
        "alert_on_new_low": "1",
        "cooldown_minutes": "360",
        "check_interval_minutes": "720",
        "candidates_per_run": "1",
    }
    payload.update(overrides)
    return payload


# ------------------------------------------------------------------ startup
def test_app_starts_without_credentials_and_says_so(client, settings, monkeypatch):
    monkeypatch.setattr(settings.__class__, "has_provider_credentials", property(lambda s: False))
    response = client.get("/")
    assert response.status_code == 200
    body = response.text
    assert "Setup checklist" in body
    assert "SERPAPI_API_KEY is not set" in body
    # No invented fare data anywhere on the first-run screen.
    assert "$1," not in body


def test_dashboard_empty_state_invites_the_first_tracker(client):
    response = client.get("/")
    assert "No trackers yet" in response.text
    assert "/trackers/new" in response.text


def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["database"] == "connected"


def test_healthz_is_unhealthy_when_startup_failed(client):
    client.app.state.startup_error = "migration failed"
    response = client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["status"] == "error"


def test_security_headers_are_applied(client):
    response = client.get("/")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_static_css_is_served(client):
    response = client.get("/static/app.css")
    assert response.status_code == 200
    assert "prefers-reduced-motion" in response.text


# --------------------------------------------------------------- validation
def test_invalid_iata_and_dates_produce_field_errors(client, today):
    form = client.get("/trackers/new").text
    payload = tracker_payload(
        today,
        origin="XX",
        destination="XX",
        outbound_date=(today - timedelta(days=2)).isoformat(),
        return_date=(today - timedelta(days=5)).isoformat(),
        csrf_token=csrf_from(form),
    )
    response = client.post("/trackers", data=payload)
    assert response.status_code == 422
    body = response.text
    assert "3-letter IATA airport code" in body
    assert "in the past" in body
    assert 'class="error-summary"' in body
    # Each message is linked from the summary to its field.
    assert 'href="#origin"' in body
    assert 'id="origin-error"' in body
    assert 'aria-invalid="true"' in body


def test_reversed_return_date_is_rejected(client, today):
    form = client.get("/trackers/new").text
    payload = tracker_payload(
        today,
        outbound_date=(today + timedelta(days=30)).isoformat(),
        return_date=(today + timedelta(days=20)).isoformat(),
        csrf_token=csrf_from(form),
    )
    response = client.post("/trackers", data=payload)
    assert "return date must be after the outbound date" in response.text


def test_too_many_passengers_is_rejected(client, today):
    form = client.get("/trackers/new").text
    payload = tracker_payload(today, adults="9", children="3", csrf_token=csrf_from(form))
    response = client.post("/trackers", data=payload)
    assert "at most 9 passengers" in response.text


def test_flexible_window_without_a_return_rule_is_rejected(client, today):
    form = client.get("/trackers/new").text
    payload = tracker_payload(
        today,
        date_mode="custom_window",
        window_outbound_start=(today + timedelta(days=30)).isoformat(),
        window_outbound_end=(today + timedelta(days=35)).isoformat(),
        csrf_token=csrf_from(form),
    )
    response = client.post("/trackers", data=payload)
    assert "return date window or a minimum and maximum trip length" in response.text


def test_flexible_preset_beyond_six_months_is_rejected(client, today):
    form = client.get("/trackers/new").text
    far_month = ((today.month + 8 - 1) % 12) + 1
    payload = tracker_payload(
        today,
        date_mode="flexible_preset",
        flex_month=str(far_month),
        flex_duration="one_week",
        csrf_token=csrf_from(form),
    )
    response = client.post("/trackers", data=payload)
    assert "within the next" in response.text and "6 months" in response.text


def test_csrf_is_required(client, today):
    response = client.post("/trackers", data=tracker_payload(today))
    assert response.status_code == 400
    assert "nothing was changed" in response.text.lower()


def test_include_and_exclude_airlines_cannot_both_be_set(client, today):
    form = client.get("/trackers/new").text
    payload = tracker_payload(
        today, include_airlines="NH", exclude_airlines="UA", csrf_token=csrf_from(form)
    )
    response = client.post("/trackers", data=payload)
    assert "does not accept included and excluded airlines together" in response.text


# ------------------------------------------------------------------ journey
def test_create_pause_resume_edit_and_delete(client, session, today):
    form = client.get("/trackers/new").text
    token = csrf_from(form)
    created = client.post("/trackers", data=tracker_payload(today, csrf_token=token))
    assert created.status_code == 200  # followed the redirect
    assert "Tokyo autumn" in created.text

    tracker = session.query(Tracker).one()
    assert tracker.status == TrackerStatus.ACTIVE.value
    assert tracker.current_config_version_id is not None
    assert tracker.next_run_at is not None
    # No SerpApi key is reachable in tests, so the initial check records the
    # truthful missing-credentials state instead of inventing a price.
    assert tracker.latest_price is None

    detail = client.get(f"/trackers/{tracker.id}")
    assert "Observed low" in detail.text
    assert "Current observed fare" in detail.text
    assert "not a guaranteed or predicted minimum" in detail.text

    token = csrf_from(detail.text)
    client.post(f"/trackers/{tracker.id}/pause", data={"csrf_token": token})
    session.expire_all()
    assert session.get(Tracker, tracker.id).status == TrackerStatus.PAUSED.value

    client.post(f"/trackers/{tracker.id}/resume", data={"csrf_token": token})
    session.expire_all()
    assert session.get(Tracker, tracker.id).status == TrackerStatus.ACTIVE.value

    edit = client.get(f"/trackers/{tracker.id}/edit")
    assert 'value="SFO"' in edit.text
    updated = client.post(
        f"/trackers/{tracker.id}",
        data=tracker_payload(today, name="Renamed", csrf_token=csrf_from(edit.text)),
    )
    assert "Renamed" in updated.text
    assert "Price history is unchanged" in updated.text

    # Deletion needs the exact name typed.
    wrong = client.post(
        f"/trackers/{tracker.id}/delete", data={"csrf_token": token, "confirm_name": "nope"}
    )
    assert "confirmation name did not match" in wrong.text
    assert session.query(Tracker).count() == 1

    right = client.post(
        f"/trackers/{tracker.id}/delete", data={"csrf_token": token, "confirm_name": "Renamed"}
    )
    assert "were deleted" in right.text
    session.expire_all()
    assert session.query(Tracker).count() == 0


def test_editing_a_comparison_field_warns_about_the_new_series(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    tracker = session.query(Tracker).one()

    edit = client.get(f"/trackers/{tracker.id}/edit")
    response = client.post(
        f"/trackers/{tracker.id}",
        data=tracker_payload(today, adults="3", csrf_token=csrf_from(edit.text)),
    )
    assert "Comparison-relevant settings changed" in response.text
    assert "Earlier observations are preserved" in response.text


def test_a_page_refresh_never_triggers_a_search(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    tracker = session.query(Tracker).one()
    before = session.query(SearchRun).count()

    for _ in range(4):
        client.get("/")
        client.get("/trackers")
        client.get(f"/trackers/{tracker.id}")

    session.expire_all()
    assert session.query(SearchRun).count() == before


def test_budget_estimate_endpoint_makes_no_provider_call(client, today):
    response = client.post(
        "/api/estimate",
        data=tracker_payload(
            today,
            date_mode="custom_window",
            window_outbound_start=(today + timedelta(days=40)).isoformat(),
            window_outbound_end=(today + timedelta(days=43)).isoformat(),
            min_nights="7",
            max_nights="8",
            candidates_per_run="2",
            markets=["us", "gb"],
        ),
    )
    payload = response.json()
    assert payload["candidate_count"] == 8
    assert payload["calls_per_scan"] == 4  # 2 candidates x 2 markets
    assert payload["calls_per_full_cycle"] == 16
    assert payload["severity"] in {"ok", "warning", "blocked"}


def test_sampled_mode_acknowledgement_is_required_when_the_budget_does_not_fit(
    client, session, settings, today
):
    from flightnotify.services.quota import QuotaManager

    QuotaManager(settings).usage_row(session).local_searches = 245
    session.commit()

    form = client.get("/trackers/new").text
    payload = tracker_payload(
        today,
        date_mode="custom_window",
        window_outbound_start=(today + timedelta(days=40)).isoformat(),
        window_outbound_end=(today + timedelta(days=60)).isoformat(),
        min_nights="7",
        max_nights="10",
        candidates_per_run="3",
        markets=["us", "gb"],
        check_interval_minutes="60",
        csrf_token=csrf_from(form),
    )
    blocked = client.post("/trackers", data=payload)
    assert blocked.status_code == 422
    assert "sampled mode" in blocked.text
    assert session.query(Tracker).count() == 0

    payload["sampled_mode_ack"] = "1"
    payload["csrf_token"] = csrf_from(blocked.text)
    allowed = client.post("/trackers", data=payload)
    assert allowed.status_code == 200
    session.expire_all()
    assert session.query(Tracker).count() == 1


def test_manual_check_without_credentials_reports_the_setup_state(
    client, session, settings, today, monkeypatch
):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    tracker = session.query(Tracker).one()

    detail = client.get(f"/trackers/{tracker.id}")
    monkeypatch.setattr(settings.__class__, "has_provider_credentials", property(lambda s: False))
    monkeypatch.setattr(settings, "serpapi_api_key", "")

    response = client.post(
        f"/trackers/{tracker.id}/check", data={"csrf_token": csrf_from(detail.text)}
    )
    assert "No SerpApi key is configured" in response.text
    session.expire_all()
    assert session.query(FareObservation).count() == 0


def test_unknown_tracker_returns_a_helpful_404(client):
    response = client.get("/trackers/999999")
    assert response.status_code == 404
    assert "does not exist" in response.text
    assert "Other data is safe" in response.text


# ----------------------------------------------------------------- settings
def test_settings_page_shows_status_without_revealing_secrets(client, settings):
    response = client.get("/settings")
    body = response.text
    assert response.status_code == 200
    assert "BotFather" in body
    assert "/start" in body
    assert settings.serpapi_api_key not in body
    assert "Reading account status is free" in body


def test_settings_defaults_can_be_saved(client, session):
    page = client.get("/settings")
    response = client.post(
        "/settings/defaults",
        data={
            "csrf_token": csrf_from(page.text),
            "default_market": "gb",
            "default_currency": "GBP",
        },
    )
    assert "Defaults for new trackers saved" in response.text


def test_settings_defaults_reject_bad_codes(client):
    page = client.get("/settings")
    response = client.post(
        "/settings/defaults",
        data={
            "csrf_token": csrf_from(page.text),
            "default_market": "united-kingdom",
            "default_currency": "P",
        },
    )
    assert "Nothing was changed" in response.text


def test_telegram_actions_report_missing_configuration(client):
    page = client.get("/settings")
    token = csrf_from(page.text)
    discover = client.post("/settings/telegram/discover", data={"csrf_token": token})
    assert "TELEGRAM_BOT_TOKEN is not set" in discover.text
    test_send = client.post("/settings/telegram/test", data={"csrf_token": token})
    assert "TELEGRAM_BOT_TOKEN is not set" in test_send.text


# ------------------------------------------------------------ accessibility
def test_pages_use_semantic_structure_and_skip_link(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    tracker = session.query(Tracker).one()

    for path in ("/", "/trackers", "/settings", f"/trackers/{tracker.id}", "/trackers/new"):
        body = client.get(path).text
        assert 'class="skip-link"' in body, path
        assert '<main id="main">' in body, path
        assert '<meta name="viewport" content="width=device-width, initial-scale=1">' in body
        assert body.count("<h1") == 1, path


def test_every_form_control_has_a_label(client):
    body = client.get("/trackers/new").text
    ids = set(re.findall(r'<(?:input|select)[^>]*\bid="([^"]+)"', body))
    labelled = set(re.findall(r'<label[^>]*\bfor="([^"]+)"', body))
    hidden = set(re.findall(r'<input[^>]*type="hidden"[^>]*\bid="([^"]+)"', body))
    assert (ids - hidden - labelled) == set()


def test_status_is_not_conveyed_by_colour_alone(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    body = client.get("/trackers").text
    # Every badge carries a text label, not just a colour class.
    for badge in re.findall(r'<span class="badge badge-\w+">([^<]*)</span>', body):
        assert badge.strip(), "a badge rendered with no text label"


def test_tables_are_marked_for_small_screen_stacking(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    body = client.get("/trackers").text
    assert 'table class="stacked"' in body
    # Each cell carries the label used when the table stacks vertically.
    assert body.count("data-label=") >= 8


def test_delete_requires_an_explicit_confirmation_dialog(client, session, today):
    form = client.get("/trackers/new").text
    client.post("/trackers", data=tracker_payload(today, csrf_token=csrf_from(form)))
    tracker = session.query(Tracker).one()
    body = client.get(f"/trackers/{tracker.id}").text
    assert '<dialog id="delete-dialog"' in body
    assert "Type the tracker name to confirm" in body
    assert "cannot be undone" in body
