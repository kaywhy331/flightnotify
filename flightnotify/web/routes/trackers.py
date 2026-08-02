"""Tracker list, create/edit form, detail screen and actions."""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import FormData

from ...config import get_settings
from ...db import db_session
from ...enums import (
    Cabin,
    DateMode,
    FlexDuration,
    RunTrigger,
    StopsPreference,
    ThresholdBasis,
    TrackerStatus,
)
from ...forms import (
    CURRENCY_CHOICES,
    MARKET_CHOICES,
    TrackerFormData,
    parse_tracker_form,
)
from ...models import Tracker, TrackerMarket
from ...services import tracker_service
from ...services.planner import (
    DEFAULT_INTERVAL_MINUTES,
    SCHEDULE_CHOICES,
    PlanInput,
    assess,
    estimate,
)
from ...services.quota import QuotaManager
from ...services.scheduler import acquire_tracker_lock, make_owner_id, release_tracker_lock
from ...services.search import SearchService
from ...timeutil import today_in
from .. import viewmodels
from ..chart import PricePoint, render_price_chart
from ..deps import base_context, flash, require_csrf

log = logging.getLogger(__name__)
router = APIRouter()


# --------------------------------------------------------------------- list
@router.get("/trackers", response_class=HTMLResponse)
def list_trackers(request: Request, session: Session = Depends(db_session)) -> HTMLResponse:
    settings = get_settings()
    trackers = session.execute(select(Tracker).order_by(Tracker.created_at.desc())).scalars().all()
    rows = [viewmodels.tracker_row(session, tracker, settings) for tracker in trackers]
    context = base_context(
        request,
        title="Trackers",
        nav="trackers",
        rows=rows,
        quota=QuotaManager(settings).snapshot(session),
    )
    return request.app.state.templates.TemplateResponse(request, "trackers.html", context)


# --------------------------------------------------------------------- form
def _form_context(
    request: Request,
    session: Session,
    *,
    data: TrackerFormData,
    errors: dict[str, str],
    tracker: Tracker | None,
    verdict: Any = None,
    plan: Any = None,
) -> dict[str, Any]:
    settings = get_settings()
    quota = QuotaManager(settings).snapshot(session)
    return base_context(
        request,
        title="Edit tracker" if tracker else "New tracker",
        nav="trackers",
        form=data,
        errors=errors,
        tracker=tracker,
        quota=quota,
        verdict=verdict,
        plan=plan,
        market_choices=MARKET_CHOICES,
        currency_choices=CURRENCY_CHOICES,
        schedule_choices=SCHEDULE_CHOICES,
        cabins=[(c.value, c.name.replace("_", " ").title()) for c in Cabin],
        stops_options=list(StopsPreference),
        date_modes=list(DateMode),
        flex_durations=list(FlexDuration),
        threshold_bases=list(ThresholdBasis),
        today=today_in(settings.tzinfo).isoformat(),
    )


@router.get("/trackers/new", response_class=HTMLResponse)
def new_tracker(request: Request, session: Session = Depends(db_session)) -> HTMLResponse:
    settings = get_settings()
    data = TrackerFormData(
        currency=settings.default_currency,
        markets=[settings.default_market],
        check_interval_minutes=DEFAULT_INTERVAL_MINUTES,
    )
    context = _form_context(request, session, data=data, errors={}, tracker=None)
    return request.app.state.templates.TemplateResponse(request, "tracker_form.html", context)


@router.get("/trackers/{tracker_id}/edit", response_class=HTMLResponse)
def edit_tracker(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> HTMLResponse:
    tracker = _get_tracker(session, tracker_id)
    data = _to_form(tracker)
    context = _form_context(request, session, data=data, errors={}, tracker=tracker)
    return request.app.state.templates.TemplateResponse(request, "tracker_form.html", context)


def _to_form(tracker: Tracker) -> TrackerFormData:
    return TrackerFormData(
        name=tracker.name,
        origin=tracker.origin,
        destination=tracker.destination,
        adults=tracker.adults,
        children=tracker.children,
        infants_in_seat=tracker.infants_in_seat,
        infants_on_lap=tracker.infants_on_lap,
        cabin=tracker.cabin,
        stops=tracker.stops,
        include_airlines=tracker.include_airlines,
        exclude_airlines=tracker.exclude_airlines,
        currency=tracker.currency,
        markets=tracker.market_codes,
        date_mode=tracker.date_mode,
        outbound_date=tracker.outbound_date,
        return_date=tracker.return_date,
        flex_month=tracker.flex_month,
        flex_year=tracker.flex_year,
        flex_duration=tracker.flex_duration,
        window_outbound_start=tracker.window_outbound_start,
        window_outbound_end=tracker.window_outbound_end,
        window_return_start=tracker.window_return_start,
        window_return_end=tracker.window_return_end,
        min_nights=tracker.min_nights,
        max_nights=tracker.max_nights,
        threshold_amount=Decimal(tracker.threshold_amount),
        threshold_basis=tracker.threshold_basis,
        alert_on_threshold=tracker.alert_on_threshold,
        alert_on_new_low=tracker.alert_on_new_low,
        min_drop_absolute=(
            Decimal(tracker.min_drop_absolute) if tracker.min_drop_absolute is not None else None
        ),
        min_drop_percent=(
            Decimal(tracker.min_drop_percent) if tracker.min_drop_percent is not None else None
        ),
        cooldown_minutes=tracker.cooldown_minutes,
        check_interval_minutes=tracker.check_interval_minutes,
        candidates_per_run=tracker.candidates_per_run,
        sampled_mode_ack=tracker.sampled_mode_ack,
    )


def _apply(tracker: Tracker, data: TrackerFormData) -> None:
    tracker.name = data.name
    tracker.origin = data.origin
    tracker.destination = data.destination
    tracker.adults = data.adults
    tracker.children = data.children
    tracker.infants_in_seat = data.infants_in_seat
    tracker.infants_on_lap = data.infants_on_lap
    tracker.cabin = data.cabin
    tracker.stops = data.stops
    tracker.include_airlines = data.include_airlines
    tracker.exclude_airlines = data.exclude_airlines
    tracker.currency = data.currency
    tracker.date_mode = data.date_mode
    tracker.outbound_date = data.outbound_date if data.date_mode == DateMode.EXACT else None
    tracker.return_date = data.return_date if data.date_mode == DateMode.EXACT else None
    is_preset = data.date_mode == DateMode.FLEXIBLE_PRESET
    tracker.flex_month = data.flex_month if is_preset else None
    tracker.flex_year = data.flex_year if is_preset else None
    tracker.flex_duration = data.flex_duration if is_preset else None
    is_window = data.date_mode == DateMode.CUSTOM_WINDOW
    tracker.window_outbound_start = data.window_outbound_start if is_window else None
    tracker.window_outbound_end = data.window_outbound_end if is_window else None
    tracker.window_return_start = data.window_return_start if is_window else None
    tracker.window_return_end = data.window_return_end if is_window else None
    tracker.min_nights = data.min_nights if is_window else None
    tracker.max_nights = data.max_nights if is_window else None
    tracker.threshold_amount = data.threshold_amount
    tracker.threshold_basis = data.threshold_basis
    tracker.alert_on_threshold = data.alert_on_threshold
    tracker.alert_on_new_low = data.alert_on_new_low
    tracker.min_drop_absolute = data.min_drop_absolute
    tracker.min_drop_percent = data.min_drop_percent
    tracker.cooldown_minutes = data.cooldown_minutes
    tracker.check_interval_minutes = data.check_interval_minutes
    tracker.candidates_per_run = data.candidates_per_run
    tracker.sampled_mode_ack = data.sampled_mode_ack


def _sync_markets(session: Session, tracker: Tracker, markets: list[str]) -> None:
    existing = {m.market: m for m in tracker.markets}
    for index, code in enumerate(markets):
        row = existing.pop(code, None)
        if row is None:
            session.add(TrackerMarket(tracker_id=tracker.id, market=code, priority=index))
        else:
            row.priority = index
    for leftover in existing.values():
        session.delete(leftover)
    session.flush()
    session.refresh(tracker)


def _budget(session: Session, data: TrackerFormData) -> tuple[Any, Any]:
    settings = get_settings()
    quota = QuotaManager(settings).snapshot(session)
    plan = PlanInput(
        date_mode=DateMode(data.date_mode),
        market_count=len(data.markets),
        check_interval_minutes=data.check_interval_minutes,
        candidates_per_run=data.candidates_per_run,
        total_candidates=data.candidate_count,
    )
    plan_estimate = estimate(plan)
    verdict = assess(
        plan_estimate,
        remaining_safe=quota.remaining_safe,
        remaining_hard=quota.remaining_hard,
        monthly_limit=quota.monthly_limit,
        plan=plan,
    )
    return plan_estimate, verdict


@router.post(
    "/trackers",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def create_tracker(
    request: Request, session: Session = Depends(db_session)
) -> HTMLResponse | RedirectResponse:
    settings = get_settings()
    raw = await request.form()
    data, errors = parse_tracker_form(
        dict(raw), today=today_in(settings.tzinfo), markets_raw=_selected_markets(raw)
    )
    plan_estimate, verdict = _budget(session, data)

    if not errors and not verdict.fits and not data.sampled_mode_ack:
        errors["sampled_mode_ack"] = (
            "This configuration does not fit the remaining free allowance. Adjust it, "
            "or tick the box to continue in sampled mode."
        )

    if errors:
        context = _form_context(
            request,
            session,
            data=data,
            errors=errors,
            tracker=None,
            verdict=verdict,
            plan=plan_estimate,
        )
        return request.app.state.templates.TemplateResponse(
            request, "tracker_form.html", context, status_code=422
        )

    tracker = Tracker(status=TrackerStatus.ACTIVE.value)
    _apply(tracker, data)
    session.add(tracker)
    session.flush()
    _sync_markets(session, tracker, data.markets)
    tracker_service.ensure_config_version(session, tracker)
    tracker_service.schedule_next_run(tracker)
    session.commit()

    flash(request, f"Tracker “{tracker.name}” created.", "success")
    _run_check(request, session, tracker, trigger=RunTrigger.INITIAL)
    return RedirectResponse(f"/trackers/{tracker.id}", status_code=303)


@router.post(
    "/trackers/{tracker_id}",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def update_tracker(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> HTMLResponse | RedirectResponse:
    settings = get_settings()
    tracker = _get_tracker(session, tracker_id)
    raw = await request.form()
    data, errors = parse_tracker_form(
        dict(raw), today=today_in(settings.tzinfo), markets_raw=_selected_markets(raw)
    )
    plan_estimate, verdict = _budget(session, data)

    if not errors and not verdict.fits and not data.sampled_mode_ack:
        errors["sampled_mode_ack"] = (
            "This configuration does not fit the remaining free allowance. Adjust it, "
            "or tick the box to continue in sampled mode."
        )

    if errors:
        context = _form_context(
            request,
            session,
            data=data,
            errors=errors,
            tracker=tracker,
            verdict=verdict,
            plan=plan_estimate,
        )
        return request.app.state.templates.TemplateResponse(
            request, "tracker_form.html", context, status_code=422
        )

    _apply(tracker, data)
    _sync_markets(session, tracker, data.markets)
    change = tracker_service.ensure_config_version(session, tracker)
    session.commit()

    if change.created and change.changes:
        flash(
            request,
            "Comparison-relevant settings changed ("
            + "; ".join(change.changes[:4])
            + "). Earlier observations are preserved but are no longer compared against "
            "the new configuration — a new price series starts now.",
            "warning",
        )
    else:
        flash(request, "Tracker updated. Price history is unchanged.", "success")
    return RedirectResponse(f"/trackers/{tracker.id}", status_code=303)


# ------------------------------------------------------------------- detail
@router.get("/trackers/{tracker_id}", response_class=HTMLResponse)
def tracker_detail(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> HTMLResponse:
    settings = get_settings()
    tracker = _get_tracker(session, tracker_id)
    row = viewmodels.tracker_row(session, tracker, settings)
    points = viewmodels.history_points(session, tracker)
    chart_svg = render_price_chart(
        [
            PricePoint(
                observed_at=point["observed_at"],
                amount=point["amount"],
                label=f"{point['market'].upper()} market",
            )
            for point in points
            if point["observed_at"] is not None
        ],
        currency=tracker.currency,
        tz=settings.tzinfo,
        threshold=Decimal(tracker.threshold_amount),
        low=Decimal(tracker.low_price) if tracker.low_price is not None else None,
    )
    tone, freshness_text = viewmodels.freshness(tracker)
    context = base_context(
        request,
        title=tracker.name,
        nav="trackers",
        row=row,
        tracker=tracker,
        points=points,
        chart_svg=chart_svg,
        freshness_tone=tone,
        freshness_text=freshness_text,
        offers=viewmodels.latest_offers(session, tracker),
        runs=viewmodels.recent_runs(session, tracker),
        alerts=viewmodels.recent_alerts(session, tracker),
        markets=viewmodels.market_comparison(session, tracker),
        quota=QuotaManager(settings).snapshot(session),
        run_tone=viewmodels.run_state_tone,
        alert_tone=viewmodels.alert_state_tone,
        config_versions=list(reversed(tracker.config_versions))[:5],
    )
    return request.app.state.templates.TemplateResponse(request, "tracker_detail.html", context)


# ------------------------------------------------------------------ actions
def _run_check(
    request: Request,
    session: Session,
    tracker: Tracker,
    *,
    trigger: RunTrigger,
    force: bool = False,
) -> None:
    settings = get_settings()
    owner = make_owner_id()
    if not acquire_tracker_lock(session, tracker.id, owner, settings.scheduler_lock_ttl_seconds):
        flash(
            request,
            "A check for this tracker is already running. Nothing was started twice; "
            "refresh in a moment to see the result.",
            "warning",
        )
        return
    try:
        service = SearchService(settings)
        result = service.run_tracker(session, tracker, trigger=trigger, force_refresh=force)
    except Exception:  # pragma: no cover - defensive
        session.rollback()
        log.exception("manual check failed", extra={"tracker_id": tracker.id})
        flash(
            request,
            "The check failed unexpectedly. Stored price history is unchanged. "
            "See the application log for details.",
            "danger",
        )
        return
    finally:
        release_tracker_lock(session, tracker.id, owner)

    for message in result.status_messages:
        flash(request, message, "info")
    for error in result.errors:
        flash(request, error, "danger")
    if result.succeeded:
        flash(
            request,
            f"Best observed fare {result.best_price} {tracker.currency} "
            f"({(result.best_market or '').upper()} market) from "
            f"{result.provider_calls} provider search(es) and "
            f"{result.cache_hits} cached result(s).",
            "success",
        )
    elif not result.errors and not result.status_messages:
        flash(request, "The provider returned no matching itineraries.", "info")


@router.post(
    "/trackers/{tracker_id}/check",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def check_now(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> RedirectResponse:
    tracker = _get_tracker(session, tracker_id)
    form = await request.form()
    force = str(form.get("force", "")).lower() in {"1", "true", "on"}
    _run_check(request, session, tracker, trigger=RunTrigger.MANUAL, force=force)
    return RedirectResponse(f"/trackers/{tracker_id}", status_code=303)


@router.post(
    "/trackers/{tracker_id}/pause",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
def pause_tracker(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> RedirectResponse:
    tracker = _get_tracker(session, tracker_id)
    tracker.status = TrackerStatus.PAUSED.value
    session.commit()
    flash(request, f"“{tracker.name}” paused. History is kept.", "info")
    return RedirectResponse(request.headers.get("referer", "/trackers"), status_code=303)


@router.post(
    "/trackers/{tracker_id}/resume",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
def resume_tracker(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> RedirectResponse:
    tracker = _get_tracker(session, tracker_id)
    tracker.status = TrackerStatus.ACTIVE.value
    tracker.consecutive_failures = 0
    tracker.last_error_category = None
    tracker.last_error_message = None
    tracker_service.schedule_next_run(tracker)
    session.commit()
    flash(request, f"“{tracker.name}” resumed.", "success")
    return RedirectResponse(request.headers.get("referer", "/trackers"), status_code=303)


@router.post(
    "/trackers/{tracker_id}/delete",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def delete_tracker(
    tracker_id: int, request: Request, session: Session = Depends(db_session)
) -> RedirectResponse:
    tracker = _get_tracker(session, tracker_id)
    form = await request.form()
    if str(form.get("confirm_name", "")).strip() != tracker.name:
        flash(
            request,
            "Nothing was deleted: the confirmation name did not match. All data is safe.",
            "danger",
        )
        return RedirectResponse(f"/trackers/{tracker_id}", status_code=303)
    name = tracker.name
    session.delete(tracker)
    session.commit()
    flash(
        request,
        f"Tracker “{name}” and all of its observations, runs and alerts were deleted.",
        "info",
    )
    return RedirectResponse("/trackers", status_code=303)


# ---------------------------------------------------------------------- API
@router.post("/api/estimate", response_model=None)
async def estimate_budget(request: Request, session: Session = Depends(db_session)) -> JSONResponse:
    """Live call-budget estimate for the form. Never contacts the provider."""
    settings = get_settings()
    raw = await request.form()
    data, errors = parse_tracker_form(
        dict(raw), today=today_in(settings.tzinfo), markets_raw=_selected_markets(raw)
    )
    plan_estimate, verdict = _budget(session, data)
    quota = QuotaManager(settings).snapshot(session)
    return JSONResponse(
        {
            "calls_per_scan": plan_estimate.calls_per_scan,
            "calls_remaining_month": plan_estimate.calls_remaining_this_month,
            "calls_per_full_cycle": plan_estimate.calls_per_full_cycle,
            "scans_per_full_cycle": plan_estimate.scans_per_full_cycle,
            "candidate_count": data.candidate_count,
            "remaining_safe": quota.remaining_safe,
            "remaining_hard": quota.remaining_hard,
            "monthly_limit": quota.monthly_limit,
            "severity": verdict.severity,
            "headline": verdict.headline,
            "detail": verdict.detail,
            "suggestions": verdict.suggestions,
            "date_errors": [
                message
                for key, message in errors.items()
                if key.startswith("window") or key in {"min_nights", "max_nights", "flex_month"}
            ],
        }
    )


def _selected_markets(form: FormData) -> list[str]:
    """The checked market codes. Starlette form values may also be uploads."""
    return [value for value in form.getlist("markets") if isinstance(value, str)]


def _get_tracker(session: Session, tracker_id: int) -> Tracker:
    tracker = session.get(Tracker, tracker_id)
    if tracker is None:
        raise HTTPException(
            status_code=404,
            detail="That tracker does not exist. It may have been deleted. Other data is safe.",
        )
    return tracker


def _today() -> date:
    return today_in(get_settings().tzinfo)
