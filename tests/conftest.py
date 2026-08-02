"""Shared test fixtures.

No test in the default suite touches the network: the SerpApi and Telegram
adapters are driven through :class:`httpx.MockTransport`.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy.orm import Session, sessionmaker

from flightnotify import db as db_module
from flightnotify.config import Settings, reset_settings_cache
from flightnotify.enums import DateMode, TrackerStatus
from flightnotify.logging_setup import reset_logging_for_tests
from flightnotify.models import Base, Tracker, TrackerMarket

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _clean_module_state() -> Iterator[None]:
    reset_settings_cache()
    reset_logging_for_tests()
    yield
    reset_settings_cache()
    reset_logging_for_tests()
    db_module.dispose_engine()


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    return Settings(
        serpapi_api_key="test-key-not-real",
        telegram_bot_token="",
        telegram_chat_id="",
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        app_timezone="UTC",
        serpapi_monthly_search_limit=250,
        serpapi_hourly_search_limit=50,
        serpapi_reserve_searches=10,
        query_cache_ttl_seconds=900,
        scheduler_enabled=False,
        app_secret_key="test-secret-key-for-sessions-only",
        log_level="WARNING",
    )


@pytest.fixture()
def session_factory(settings: Settings) -> Iterator[sessionmaker[Session]]:
    engine = db_module.create_db_engine(settings)
    Base.metadata.create_all(engine)
    db_module.configure_engine(engine)
    yield db_module.get_session_factory()
    engine.dispose()


@pytest.fixture()
def session(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    with session_factory() as db:
        yield db


@pytest.fixture()
def today() -> date:
    return date.today()


@pytest.fixture()
def make_tracker(session: Session, today: date) -> Callable[..., Tracker]:
    def _make(**overrides: Any) -> Tracker:
        markets = overrides.pop("markets", ["us"])
        defaults: dict[str, Any] = {
            "name": "SFO to Tokyo",
            "status": TrackerStatus.ACTIVE.value,
            "origin": "SFO",
            "destination": "NRT",
            "adults": 2,
            "children": 0,
            "infants_in_seat": 0,
            "infants_on_lap": 0,
            "cabin": "economy",
            "stops": "any",
            "currency": "USD",
            "date_mode": DateMode.EXACT.value,
            "outbound_date": today + timedelta(days=60),
            "return_date": today + timedelta(days=68),
            "threshold_amount": Decimal("1300.00"),
            "threshold_basis": "party",
            "alert_on_threshold": True,
            "alert_on_new_low": True,
            "cooldown_minutes": 0,
            "check_interval_minutes": 720,
            "candidates_per_run": 1,
        }
        defaults.update(overrides)
        tracker = Tracker(**defaults)
        session.add(tracker)
        session.flush()
        for index, code in enumerate(markets):
            session.add(TrackerMarket(tracker_id=tracker.id, market=code, priority=index))
        session.commit()
        session.refresh(tracker)
        return tracker

    return _make


# --------------------------------------------------------------- transports
def json_transport(
    payload: dict[str, Any] | Callable[[httpx.Request], dict[str, Any]],
    status_code: int = 200,
    *,
    recorder: list[httpx.Request] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.MockTransport:
    """A MockTransport returning ``payload`` for every request."""

    def handler(request: httpx.Request) -> httpx.Response:
        if recorder is not None:
            recorder.append(request)
        body = payload(request) if callable(payload) else payload
        return httpx.Response(status_code, json=body, headers=headers or {})

    return httpx.MockTransport(handler)


def sequence_transport(
    responses: list[tuple[int, dict[str, Any]]], recorder: list[httpx.Request] | None = None
) -> httpx.MockTransport:
    """Return each response in turn; the last one repeats."""
    state = {"index": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if recorder is not None:
            recorder.append(request)
        index = min(state["index"], len(responses) - 1)
        state["index"] += 1
        status, body = responses[index]
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler)


@pytest.fixture()
def flights_payload() -> dict[str, Any]:
    return load_fixture("google_flights_round_trip.json")


@pytest.fixture()
def explore_payload() -> dict[str, Any]:
    return load_fixture("google_travel_explore_route.json")


@pytest.fixture()
def account_payload() -> dict[str, Any]:
    return load_fixture("serpapi_account.json")


@pytest.fixture()
def no_results_payload() -> dict[str, Any]:
    return load_fixture("google_flights_no_results.json")
