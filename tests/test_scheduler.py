"""Scheduler leases, duplicate prevention and the one-shot pass."""

from __future__ import annotations

from datetime import timedelta

from flightnotify.enums import RunStatus, RunTrigger, TrackerStatus
from flightnotify.models import SchedulerState, SearchRun
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.services.scheduler import (
    acquire_scheduler_lease,
    acquire_tracker_lock,
    due_tracker_ids,
    make_owner_id,
    release_scheduler_lease,
    release_tracker_lock,
    renew_scheduler_lease,
    run_due_trackers,
    scheduler_health,
)
from flightnotify.services.search import SearchService
from flightnotify.timeutil import utcnow
from tests.conftest import json_transport


def make_service(settings, payload, recorder=None):
    provider = SerpApiProvider(settings, transport=json_transport(payload, recorder=recorder))
    return SearchService(settings, provider=provider)


# ------------------------------------------------------------- single lease
def test_only_one_process_can_hold_the_scheduler_lease(session, settings):
    first, second = make_owner_id(), make_owner_id()
    assert acquire_scheduler_lease(session, first, 300) is True
    assert acquire_scheduler_lease(session, second, 300) is False
    # The same owner may re-acquire (restart of the same process).
    assert acquire_scheduler_lease(session, first, 300) is True


def test_an_expired_lease_can_be_taken_over(session, settings):
    first, second = make_owner_id(), make_owner_id()
    acquire_scheduler_lease(session, first, 300)
    state = session.get(SchedulerState, 1)
    state.lock_expires_at = utcnow() - timedelta(seconds=1)
    session.commit()
    assert acquire_scheduler_lease(session, second, 300) is True


def test_renew_only_works_for_the_holder(session):
    owner, other = make_owner_id(), make_owner_id()
    acquire_scheduler_lease(session, owner, 300)
    assert renew_scheduler_lease(session, owner, 300) is True
    assert renew_scheduler_lease(session, other, 300) is False
    state = session.get(SchedulerState, 1)
    assert state.tick_count == 1


def test_release_frees_the_lease(session):
    owner = make_owner_id()
    acquire_scheduler_lease(session, owner, 300)
    release_scheduler_lease(session, owner)
    assert acquire_scheduler_lease(session, make_owner_id(), 300) is True


def test_scheduler_health_reports_a_missing_process(session, settings):
    health = scheduler_health(session, settings)
    assert health["running"] is False
    assert "No scheduler process" in health["detail"]

    acquire_scheduler_lease(session, "owner-1", 300)
    health = scheduler_health(session, settings)
    assert health["running"] is True


# ------------------------------------------------------- per-tracker locking
def test_tracker_lock_prevents_a_concurrent_duplicate_check(session, make_tracker):
    tracker = make_tracker()
    owner, other = make_owner_id(), make_owner_id()
    assert acquire_tracker_lock(session, tracker.id, owner, 300) is True
    assert acquire_tracker_lock(session, tracker.id, other, 300) is False
    release_tracker_lock(session, tracker.id, owner)
    assert acquire_tracker_lock(session, tracker.id, other, 300) is True


def test_a_stale_tracker_lock_expires_after_a_crash(session, make_tracker):
    """A process killed mid-search must not wedge the tracker forever."""
    tracker = make_tracker()
    acquire_tracker_lock(session, tracker.id, "dead-process", 300)
    tracker.lock_expires_at = utcnow() - timedelta(seconds=1)
    session.commit()
    assert acquire_tracker_lock(session, tracker.id, make_owner_id(), 300) is True


def test_scheduler_pass_skips_a_locked_tracker(
    session_factory, session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    tracker.next_run_at = utcnow() - timedelta(minutes=1)
    session.commit()
    acquire_tracker_lock(session, tracker.id, "someone-else", 300)

    calls: list = []
    report = run_due_trackers(
        session_factory,
        owner=make_owner_id(),
        settings=settings,
        service=make_service(settings, flights_payload, recorder=calls),
    )
    assert report.considered == 1
    assert report.checked == 0
    assert report.skipped_locked == 1
    assert calls == []


# --------------------------------------------------------------- due select
def test_only_active_due_trackers_are_selected(session, make_tracker):
    due = make_tracker(name="due")
    due.next_run_at = utcnow() - timedelta(minutes=5)
    future = make_tracker(name="future")
    future.next_run_at = utcnow() + timedelta(hours=5)
    paused = make_tracker(name="paused", status=TrackerStatus.PAUSED.value)
    paused.next_run_at = utcnow() - timedelta(minutes=5)
    never_run = make_tracker(name="never")
    never_run.next_run_at = None
    session.commit()

    ids = due_tracker_ids(session)
    assert due.id in ids
    assert never_run.id in ids
    assert future.id not in ids
    assert paused.id not in ids


def test_longest_waiting_tracker_is_checked_first(session, make_tracker):
    older = make_tracker(name="older")
    older.next_run_at = utcnow() - timedelta(hours=5)
    newer = make_tracker(name="newer")
    newer.next_run_at = utcnow() - timedelta(minutes=5)
    session.commit()
    ids = due_tracker_ids(session)
    assert ids.index(older.id) < ids.index(newer.id)


# ------------------------------------------------------------------ one pass
def test_one_shot_pass_runs_due_work_and_reschedules(
    session_factory, session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    tracker.next_run_at = utcnow() - timedelta(minutes=1)
    session.commit()

    report = run_due_trackers(
        session_factory,
        owner=make_owner_id(),
        settings=settings,
        service=make_service(settings, flights_payload),
        trigger=RunTrigger.ONE_SHOT,
    )
    assert report.checked == 1
    assert report.provider_calls == 1
    assert not report.had_errors

    session.expire_all()
    from flightnotify.models import Tracker

    reloaded = session.get(Tracker, tracker.id)
    assert reloaded.next_run_at > utcnow()
    run = session.query(SearchRun).one()
    assert run.trigger == RunTrigger.ONE_SHOT.value
    assert run.status == RunStatus.SUCCESS.value


def test_pass_with_nothing_due_makes_no_calls(
    session_factory, session, settings, make_tracker, flights_payload
):
    tracker = make_tracker()
    tracker.next_run_at = utcnow() + timedelta(hours=6)
    session.commit()
    calls: list = []
    report = run_due_trackers(
        session_factory,
        owner=make_owner_id(),
        settings=settings,
        service=make_service(settings, flights_payload, recorder=calls),
    )
    assert report.considered == 0
    assert calls == []


def test_failed_check_backs_off_instead_of_retrying_immediately(
    session_factory, session, settings, make_tracker
):
    tracker = make_tracker()
    tracker.next_run_at = utcnow() - timedelta(minutes=1)
    session.commit()

    service = make_service(settings, {"error": "Invalid API key."})
    service.provider._client._max_attempts = 1
    run_due_trackers(session_factory, owner=make_owner_id(), settings=settings, service=service)

    session.expire_all()
    from flightnotify.models import Tracker

    reloaded = session.get(Tracker, tracker.id)
    assert reloaded.consecutive_failures == 1
    # Backoff pushes the next attempt beyond the plain interval.
    assert reloaded.next_run_at > utcnow() + timedelta(minutes=tracker.check_interval_minutes)
