"""Quota enforcement, provider sync and the query cache."""

from __future__ import annotations

from datetime import timedelta

import pytest

from flightnotify.enums import DateMode, RunTrigger
from flightnotify.models import ProviderCall, ProviderUsage
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.services.cache import QueryCache
from flightnotify.services.planner import PlanInput, assess, estimate
from flightnotify.services.quota import QuotaManager
from flightnotify.timeutil import period_key, utcnow
from tests.conftest import json_transport


@pytest.fixture()
def quota(settings) -> QuotaManager:
    return QuotaManager(settings)


def test_fresh_period_starts_with_the_full_allowance(session, quota):
    snapshot = quota.snapshot(session)
    assert snapshot.local_used == 0
    assert snapshot.remaining_hard == 250
    assert snapshot.remaining_safe == 240  # reserve of 10 held back
    assert snapshot.period == period_key()


def test_recording_calls_reduces_the_balance(session, quota):
    quota.record_call(session, endpoint="google_flights", count=3)
    session.commit()
    snapshot = quota.snapshot(session)
    assert snapshot.local_used == 3
    assert snapshot.remaining_hard == 247
    assert session.query(ProviderCall).count() == 3


def _set_monthly_usage(session, quota, used: int) -> None:
    """Set the monthly ledger without also filling the rolling hourly window."""
    quota.usage_row(session).local_searches = used
    session.commit()


def test_automation_is_blocked_once_only_the_reserve_remains(session, quota):
    _set_monthly_usage(session, quota, 240)
    decision = quota.authorize(session, wanted=1, trigger=RunTrigger.SCHEDULED)
    assert decision.blocked
    assert "reserve" in decision.reason
    # A deliberate manual check may still use the reserve.
    manual = quota.authorize(session, wanted=1, trigger=RunTrigger.MANUAL)
    assert manual.allowed and manual.granted == 1


def test_hard_cap_blocks_even_manual_checks(session, quota):
    _set_monthly_usage(session, quota, 250)
    manual = quota.authorize(session, wanted=1, trigger=RunTrigger.MANUAL)
    assert manual.blocked
    assert "exhausted" in manual.reason


def test_partial_grant_when_fewer_searches_remain_than_requested(session, quota):
    _set_monthly_usage(session, quota, 238)
    decision = quota.authorize(session, wanted=5, trigger=RunTrigger.SCHEDULED)
    assert decision.allowed
    assert decision.granted == 2
    assert "Reduced from 5 to 2" in decision.reason


def test_hourly_throughput_guard(session, settings, quota):
    for _ in range(settings.serpapi_hourly_search_limit):
        session.add(ProviderCall(provider="serpapi", endpoint="google_flights", called_at=utcnow()))
    session.commit()
    decision = quota.authorize(session, wanted=1, trigger=RunTrigger.MANUAL)
    assert decision.blocked
    assert "hourly throughput" in decision.reason


def test_hourly_guard_ignores_calls_older_than_an_hour(session, settings, quota):
    old = utcnow() - timedelta(hours=2)
    for _ in range(settings.serpapi_hourly_search_limit):
        session.add(ProviderCall(provider="serpapi", endpoint="google_flights", called_at=old))
    session.commit()
    assert quota.hourly_used(session) == 0


def test_provider_sync_takes_the_more_conservative_number(
    session, quota, settings, account_payload
):
    provider = SerpApiProvider(settings, transport=json_transport(account_payload))
    snapshot = quota.sync_from_provider(session, provider)
    session.commit()
    assert snapshot.provider_left == 198
    assert snapshot.provider_used == 52
    # The provider says 52 used; our local ledger said 0, so we adopt 52.
    assert snapshot.local_used == 52
    assert snapshot.effective_used == 52
    assert snapshot.remaining_hard == 198


def test_provider_sync_failure_is_recorded_without_losing_the_ledger(session, quota, settings):
    quota.record_call(session, endpoint="google_flights", count=5)
    session.commit()
    provider = SerpApiProvider(
        settings, transport=json_transport({"error": "Invalid API key."}, status_code=401)
    )
    snapshot = quota.sync_from_provider(session, provider)
    session.commit()
    assert snapshot.sync_error
    assert snapshot.local_used == 5


def test_account_call_is_not_counted_as_a_search(session, quota, settings, account_payload):
    provider = SerpApiProvider(settings, transport=json_transport(account_payload))
    provider.account_status()
    row = session.get(ProviderUsage, quota.usage_row(session).id)
    assert row.local_searches == 0
    assert session.query(ProviderCall).count() == 0


def test_zero_monthly_limit_permits_nothing(session, settings):
    settings = settings.model_copy(update={"serpapi_monthly_search_limit": 0})
    decision = QuotaManager(settings).authorize(session, wanted=1, trigger=RunTrigger.MANUAL)
    assert decision.blocked


# --------------------------------------------------------------- planning
def test_estimate_counts_every_market():
    plan = PlanInput(date_mode=DateMode.EXACT, market_count=3, check_interval_minutes=720)
    result = estimate(plan, now_hours_left=24 * 30)
    assert result.calls_per_scan == 3
    assert result.scans_remaining_this_month == 60
    assert result.calls_remaining_this_month == 180


def test_estimate_for_a_flexible_window_reports_a_full_cycle():
    plan = PlanInput(
        date_mode=DateMode.CUSTOM_WINDOW,
        market_count=2,
        check_interval_minutes=720,
        candidates_per_run=3,
        total_candidates=64,
    )
    result = estimate(plan, now_hours_left=24 * 30)
    assert result.calls_per_scan == 6
    assert result.scans_per_full_cycle == 22  # ceil(64/3)
    assert result.calls_per_full_cycle == 128
    assert result.has_coverage_cycle


def test_assess_blocks_when_one_scan_cannot_fit():
    plan = PlanInput(
        date_mode=DateMode.CUSTOM_WINDOW,
        market_count=4,
        check_interval_minutes=60,
        candidates_per_run=5,
        total_candidates=100,
    )
    verdict = assess(
        estimate(plan, now_hours_left=100),
        remaining_safe=5,
        remaining_hard=5,
        monthly_limit=250,
        plan=plan,
    )
    assert verdict.severity == "blocked"
    assert verdict.suggestions


def test_assess_warns_when_the_schedule_outruns_the_allowance():
    plan = PlanInput(date_mode=DateMode.EXACT, market_count=2, check_interval_minutes=60)
    verdict = assess(
        estimate(plan, now_hours_left=24 * 20),
        remaining_safe=50,
        remaining_hard=60,
        monthly_limit=250,
        plan=plan,
    )
    assert verdict.severity == "warning"
    assert "will not run for the rest of the month" in verdict.headline


def test_assess_passes_a_modest_configuration():
    plan = PlanInput(date_mode=DateMode.EXACT, market_count=1, check_interval_minutes=1440)
    verdict = assess(
        estimate(plan, now_hours_left=24 * 20),
        remaining_safe=200,
        remaining_hard=210,
        monthly_limit=250,
        plan=plan,
    )
    assert verdict.fits and verdict.severity == "ok"


# ------------------------------------------------------------------ cache
def test_cache_returns_a_fresh_entry(session, settings):
    cache = QueryCache(settings.query_cache_ttl_seconds)
    cache.put(session, fingerprint="fp1", endpoint="google_flights", payload={"a": 1})
    session.commit()
    assert cache.get(session, "fp1") == {"a": 1}


def test_cache_expires_and_removes_the_row(session):
    cache = QueryCache(ttl_seconds=1)
    cache.put(session, fingerprint="fp2", endpoint="google_flights", payload={"a": 1})
    session.commit()
    from flightnotify.models import QueryCacheEntry

    entry = session.query(QueryCacheEntry).filter_by(fingerprint="fp2").one()
    entry.expires_at = utcnow() - timedelta(seconds=5)
    session.commit()
    assert cache.get(session, "fp2") is None
    assert session.query(QueryCacheEntry).filter_by(fingerprint="fp2").count() == 0


def test_cache_disabled_with_zero_ttl(session):
    cache = QueryCache(ttl_seconds=0)
    cache.put(session, fingerprint="fp3", endpoint="google_flights", payload={"a": 1})
    session.commit()
    assert cache.get(session, "fp3") is None


def test_purge_expired_removes_only_stale_rows(session):
    cache = QueryCache(ttl_seconds=900)
    cache.put(session, fingerprint="fresh", endpoint="e", payload={})
    cache.put(session, fingerprint="stale", endpoint="e", payload={})
    session.commit()
    from flightnotify.models import QueryCacheEntry

    stale = session.query(QueryCacheEntry).filter_by(fingerprint="stale").one()
    stale.expires_at = utcnow() - timedelta(seconds=1)
    session.commit()
    assert cache.purge_expired(session) == 1
    session.commit()
    assert session.query(QueryCacheEntry).count() == 1
