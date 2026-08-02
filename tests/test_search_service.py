"""End-to-end search orchestration against mocked provider HTTP."""

from __future__ import annotations

import copy
from datetime import timedelta
from decimal import Decimal

import pytest

from flightnotify.enums import (
    CandidateStatus,
    DateMode,
    FlexDuration,
    RunStatus,
    RunTrigger,
    StopsPreference,
    TrackerStatus,
)
from flightnotify.models import FareObservation, FlexibleDateCandidate, SearchRun
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.services import tracker_service
from flightnotify.services.quota import QuotaManager
from flightnotify.services.search import SearchService
from tests.conftest import json_transport


def build_service(settings, payload, recorder=None, **overrides):
    provider = SerpApiProvider(settings, transport=json_transport(payload, recorder=recorder))
    return SearchService(settings, provider=provider, **overrides)


# --------------------------------------------------------------- exact mode
def test_exact_run_stores_run_offers_and_summary(session, settings, make_tracker, flights_payload):
    tracker = make_tracker()
    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)

    result = service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)

    assert len(calls) == 1
    assert result.provider_calls == 1
    assert result.best_price == Decimal("1248.00")
    assert result.best_market == "us"

    runs = session.query(SearchRun).all()
    assert len(runs) == 1
    assert runs[0].status == RunStatus.SUCCESS.value
    assert runs[0].endpoint == "google_flights"
    assert runs[0].provider_request_count == 1
    assert runs[0].offers_found == 2

    observations = session.query(FareObservation).all()
    assert len(observations) == 2
    best = next(o for o in observations if o.is_best_of_run)
    assert best.price_amount == Decimal("1248.00")
    assert best.per_traveler_amount == Decimal("624.00")
    assert best.per_traveler_is_calculated is True

    session.refresh(tracker)
    assert tracker.latest_price == Decimal("1248.00")
    assert tracker.low_price == Decimal("1248.00")
    assert tracker.last_success_at is not None
    assert tracker.next_run_at is not None
    assert tracker.last_threshold_met is True


def test_second_identical_run_is_served_from_cache_without_a_provider_call(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)

    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)

    assert len(calls) == 1  # the second run reused the cache
    runs = session.query(SearchRun).order_by(SearchRun.id).all()
    assert runs[1].cache_status == "hit"
    assert runs[1].provider_request_count == 0
    assert QuotaManager(settings).snapshot(session).local_used == 1


def test_force_refresh_bypasses_the_cache(session, settings, make_tracker, flights_payload):
    tracker = make_tracker()
    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL, force_refresh=True)
    assert len(calls) == 2
    runs = session.query(SearchRun).order_by(SearchRun.id).all()
    assert runs[1].cache_status == "forced"


def test_quota_exhaustion_records_a_blocked_run_and_makes_no_call(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    quota = QuotaManager(settings)
    quota.usage_row(session).local_searches = 250
    session.commit()

    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)
    result = service.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED)

    assert calls == []
    assert result.best_price is None
    run = session.query(SearchRun).one()
    assert run.status == RunStatus.QUOTA_BLOCKED.value
    assert "exhausted" in (run.skip_reason or "")


def test_past_departure_is_refused_before_any_provider_call(
    session, settings, make_tracker, flights_payload, today
):
    tracker = make_tracker(
        outbound_date=today - timedelta(days=5), return_date=today - timedelta(days=1)
    )
    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)
    result = service.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED)

    assert calls == []
    assert result.skipped
    run = session.query(SearchRun).one()
    assert run.status == RunStatus.SKIPPED.value
    assert "in the past" in run.skip_reason
    assert "no quota was used" in run.skip_reason


def test_provider_error_is_recorded_and_history_survives(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    good = build_service(settings, flights_payload)
    good.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    session.refresh(tracker)
    stored_low = tracker.low_price

    bad = build_service(settings, {"error": "Invalid API key."})
    bad.provider._client._max_attempts = 1
    # force_refresh so the cache does not short-circuit the failing call
    result = bad.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True)

    assert result.errors
    session.refresh(tracker)
    assert tracker.low_price == stored_low  # nothing was discarded
    failed = session.query(SearchRun).order_by(SearchRun.id.desc()).first()
    assert failed.status == RunStatus.PROVIDER_ERROR.value
    assert failed.error_category == "invalid_credentials"


def test_repeated_failures_park_the_tracker_in_the_error_state(session, settings, make_tracker):
    tracker = make_tracker()
    service = build_service(settings, {"error": "Invalid API key."})
    service.provider._client._max_attempts = 1
    for _ in range(5):
        service.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED, force_refresh=True)
    session.refresh(tracker)
    assert tracker.status == TrackerStatus.ERROR.value
    assert tracker.last_error_message


def test_no_results_is_stored_as_a_run_not_an_error(
    session, settings, make_tracker, no_results_payload
):
    tracker = make_tracker()
    service = build_service(settings, no_results_payload)
    result = service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    run = session.query(SearchRun).one()
    assert run.status == RunStatus.NO_RESULTS.value
    assert run.provider_request_count == 1
    assert result.best_price is None
    assert not result.errors


def test_nonstop_preference_marks_connecting_offers_ineligible(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker(stops=StopsPreference.NONSTOP.value)
    service = build_service(settings, flights_payload)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)

    observations = session.query(FareObservation).all()
    ineligible = [o for o in observations if not o.eligible]
    assert len(ineligible) == 1
    assert "nonstop" in ineligible[0].exclusion_reason.lower()
    session.refresh(tracker)
    assert tracker.latest_price == Decimal("1248.00")


# ------------------------------------------------------------- multi-market
def test_every_market_produces_its_own_run_and_call(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker(markets=["us", "gb"])
    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)
    result = service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)

    assert len(calls) == 2
    assert {c.url.params["gl"] for c in calls} == {"us", "gb"}
    runs = session.query(SearchRun).all()
    assert {run.market for run in runs} == {"us", "gb"}
    assert result.provider_calls == 2
    assert QuotaManager(settings).snapshot(session).local_used == 2


def test_partial_quota_grant_blocks_only_the_extra_market(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker(markets=["us", "gb", "ca"])
    quota = QuotaManager(settings)
    quota.usage_row(session).local_searches = 250 - 10 - 2  # only 2 available to automation
    session.commit()

    calls: list = []
    service = build_service(settings, flights_payload, recorder=calls)
    service.run_tracker(session, tracker, trigger=RunTrigger.SCHEDULED)

    assert len(calls) == 2
    statuses = [run.status for run in session.query(SearchRun).all()]
    assert statuses.count(RunStatus.QUOTA_BLOCKED.value) == 1


# ---------------------------------------------------------- flexible preset
def test_flexible_preset_uses_the_explore_endpoint_and_keeps_provider_dates(
    session, settings, make_tracker, explore_payload
):
    tracker = make_tracker(
        date_mode=DateMode.FLEXIBLE_PRESET.value,
        outbound_date=None,
        return_date=None,
        flex_month=11,
        flex_duration=FlexDuration.ONE_WEEK.value,
        threshold_amount=Decimal("1000"),
    )
    calls: list = []
    service = build_service(settings, explore_payload, recorder=calls)
    result = service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)

    assert calls[0].url.params["engine"] == "google_travel_explore"
    assert calls[0].url.params["month"] == "11"
    run = session.query(SearchRun).one()
    assert run.endpoint == "google_travel_explore"
    # Dates come from the provider payload, not from local computation.
    assert str(run.outbound_date) == "2026-11-07"
    assert str(run.return_date) == "2026-11-14"
    assert result.best_price == Decimal("986.00")


# ---------------------------------------------------------- custom window
@pytest.fixture()
def window_tracker(make_tracker, today):
    return make_tracker(
        date_mode=DateMode.CUSTOM_WINDOW.value,
        outbound_date=None,
        return_date=None,
        window_outbound_start=today + timedelta(days=30),
        window_outbound_end=today + timedelta(days=33),
        min_nights=7,
        max_nights=8,
        candidates_per_run=1,
        check_interval_minutes=60,
    )


def test_custom_window_generates_candidates_and_progresses_without_duplication(
    session, settings, window_tracker, flights_payload
):
    service = build_service(settings, flights_payload)
    tracker_service.ensure_config_version(session, window_tracker)
    session.commit()

    total = tracker_service.total_candidate_count(session, window_tracker)
    assert total == 8  # 4 outbound dates x 2 trip lengths

    seen: list[tuple] = []
    for _ in range(4):
        service.run_tracker(session, window_tracker, trigger=RunTrigger.SCHEDULED)
        run = session.query(SearchRun).order_by(SearchRun.id.desc()).first()
        seen.append((run.outbound_date, run.return_date))

    assert len(set(seen)) == 4  # no combination checked twice in one cycle
    coverage = tracker_service.coverage_stats(session, window_tracker)
    assert coverage.checked == 4
    assert coverage.total == 8
    assert coverage.complete is False
    assert coverage.percent == 50.0


def test_coverage_cycle_advances_only_after_a_full_sweep(
    session, settings, window_tracker, flights_payload
):
    service = build_service(settings, flights_payload)
    tracker_service.ensure_config_version(session, window_tracker)
    session.commit()

    for _ in range(8):
        service.run_tracker(session, window_tracker, trigger=RunTrigger.SCHEDULED)
    coverage = tracker_service.coverage_stats(session, window_tracker)
    assert coverage.complete is True
    assert window_tracker.coverage_cycle == 1

    service.run_tracker(session, window_tracker, trigger=RunTrigger.SCHEDULED)
    session.refresh(window_tracker)
    assert window_tracker.coverage_cycle == 2
    assert tracker_service.coverage_stats(session, window_tracker).checked == 1


def test_coverage_progress_survives_a_restart(
    session_factory, settings, session, window_tracker, flights_payload
):
    service = build_service(settings, flights_payload)
    tracker_service.ensure_config_version(session, window_tracker)
    session.commit()
    for _ in range(3):
        service.run_tracker(session, window_tracker, trigger=RunTrigger.SCHEDULED)
    tracker_id = window_tracker.id
    session.close()

    # A brand-new session stands in for a process restart.
    with session_factory() as fresh:
        from flightnotify.models import Tracker

        reloaded = fresh.get(Tracker, tracker_id)
        coverage = tracker_service.coverage_stats(fresh, reloaded)
        assert coverage.checked == 3
        checked = (
            fresh.query(FlexibleDateCandidate)
            .filter_by(status=CandidateStatus.CHECKED.value)
            .count()
        )
        assert checked == 3


def test_fair_ordering_does_not_start_at_the_earliest_date(
    session, settings, window_tracker, flights_payload
):
    service = build_service(settings, flights_payload)
    tracker_service.ensure_config_version(session, window_tracker)
    session.commit()
    service.run_tracker(session, window_tracker, trigger=RunTrigger.SCHEDULED)
    first_run = session.query(SearchRun).one()
    earliest = min(c.outbound_date for c in session.query(FlexibleDateCandidate).all())
    assert first_run.outbound_date != earliest


def test_configuration_change_opens_a_new_series_and_preserves_history(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    service = build_service(settings, flights_payload)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    session.refresh(tracker)
    first_version = tracker.current_config_version_id
    assert tracker.low_price == Decimal("1248.00")

    tracker.adults = 3  # comparison-relevant
    change = tracker_service.ensure_config_version(session, tracker)
    session.commit()

    assert change.created is True
    assert any("adults" in text for text in change.changes)
    assert tracker.current_config_version_id != first_version
    assert tracker.low_price is None  # the new series starts without a low
    # The earlier observations are still stored, attached to the old version.
    assert session.query(FareObservation).filter_by(config_version_id=first_version).count() == 2


def test_non_comparison_change_keeps_the_same_series(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    service = build_service(settings, flights_payload)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    session.refresh(tracker)
    version = tracker.current_config_version_id
    low = tracker.low_price

    tracker.threshold_amount = Decimal("999")
    tracker.check_interval_minutes = 1440
    change = tracker_service.ensure_config_version(session, tracker)
    session.commit()

    assert change.created is False
    assert tracker.current_config_version_id == version
    assert tracker.low_price == low


def test_price_history_persists_across_a_restart(
    session_factory, settings, session, make_tracker, flights_payload
):
    tracker = make_tracker()
    service = build_service(settings, flights_payload)
    service.run_tracker(session, tracker, trigger=RunTrigger.MANUAL)
    tracker_id = tracker.id
    session.close()

    with session_factory() as fresh:
        from flightnotify.models import Tracker

        reloaded = fresh.get(Tracker, tracker_id)
        assert reloaded.low_price == Decimal("1248.00")
        assert fresh.query(SearchRun).count() == 1
        assert fresh.query(FareObservation).count() == 2


def test_new_low_updates_the_summary_on_a_later_run(
    session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    build_service(settings, flights_payload).run_tracker(
        session, tracker, trigger=RunTrigger.MANUAL
    )

    cheaper = copy.deepcopy(flights_payload)
    cheaper["best_flights"][0]["price"] = 1050
    build_service(settings, cheaper).run_tracker(
        session, tracker, trigger=RunTrigger.MANUAL, force_refresh=True
    )

    session.refresh(tracker)
    assert tracker.latest_price == Decimal("1050.00")
    assert tracker.low_price == Decimal("1050.00")


def test_a_later_rise_keeps_the_recorded_low(session, settings, make_tracker, flights_payload):
    tracker = make_tracker()
    build_service(settings, flights_payload).run_tracker(
        session, tracker, trigger=RunTrigger.MANUAL
    )
    dearer = copy.deepcopy(flights_payload)
    dearer["best_flights"][0]["price"] = 1600
    dearer["other_flights"][0]["price"] = 1700
    build_service(settings, dearer).run_tracker(
        session, tracker, trigger=RunTrigger.MANUAL, force_refresh=True
    )
    session.refresh(tracker)
    assert tracker.latest_price == Decimal("1600.00")
    assert tracker.low_price == Decimal("1248.00")
    assert tracker.last_threshold_met is False
