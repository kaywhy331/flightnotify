"""Search orchestration: quota gate → cache → provider → persistence → alerts.

A "check" is one batch. It may issue several provider queries (one per country
market, and for a custom flexible window one per claimed date combination), and
each query is recorded as its own :class:`~flightnotify.models.SearchRun` -
including the ones that failed, were served from cache, or were prevented by
the quota guard.

Transaction boundaries matter here: the run, its observations and the tracker
summary are committed together *before* any alert is attempted, so a Telegram
failure can never discard a stored price.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..domain.evaluation import SeriesState, evaluate
from ..domain.fingerprints import itinerary_fingerprint, query_fingerprint
from ..domain.pricing import normalize_price
from ..enums import (
    AlertType,
    Cabin,
    CacheStatus,
    CandidateStatus,
    CoverageState,
    DateMode,
    DeliveryState,
    EndpointType,
    ErrorCategory,
    FlexDuration,
    PriceScopeLabel,
    RunStatus,
    RunTrigger,
    StopsPreference,
    ThresholdBasis,
    TrackerStatus,
)
from ..models import AppSetting, FareObservation, FlexibleDateCandidate, SearchRun, Tracker
from ..providers.base import (
    ExactSearchQuery,
    FareProvider,
    FlexibleSearchQuery,
    NormalizedOffer,
    PassengerParty,
    ProviderResult,
)
from ..providers.errors import ProviderError, ProviderMissingCredentialsError
from ..providers.factory import get_provider
from ..timeutil import ensure_utc, today_in, utcnow
from . import tracker_service
from .alerts import AlertOutcome, AlertService, CoverageInfo
from .cache import QueryCache
from .quota import QuotaManager
from .settings_service import get_chat_id

log = logging.getLogger(__name__)

#: Offers persisted per run. The cheapest are kept; the rest are summarized by
#: the run's ``offers_found`` count so history stays bounded.
MAX_STORED_OFFERS = 25
#: Consecutive provider failures before a tracker is parked in the error state.
FAILURE_LIMIT = 5


@dataclass(slots=True)
class QueryUnit:
    """One planned provider query."""

    market: str
    endpoint: EndpointType
    params: dict[str, Any]
    fingerprint: str
    outbound_date: date | None = None
    return_date: date | None = None
    candidate_id: int | None = None
    exact_query: ExactSearchQuery | None = None
    flexible_query: FlexibleSearchQuery | None = None


@dataclass(slots=True)
class CheckResult:
    batch_id: str
    tracker_id: int
    runs: list[int] = field(default_factory=list)
    provider_calls: int = 0
    cache_hits: int = 0
    offers_found: int = 0
    best_price: Decimal | None = None
    best_market: str | None = None
    status_messages: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    alerts: list[AlertOutcome] = field(default_factory=list)
    skipped: bool = False

    @property
    def succeeded(self) -> bool:
        return self.best_price is not None

    def summary(self) -> str:
        if self.skipped and not self.runs:
            return self.status_messages[0] if self.status_messages else "Nothing to check."
        if self.best_price is not None:
            return f"Best observed fare {self.best_price} ({self.best_market or '-'} market)."
        if self.errors:
            return self.errors[0]
        return "No matching itineraries were returned."


class SearchService:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        provider: FareProvider | None = None,
        quota: QuotaManager | None = None,
        cache: QueryCache | None = None,
        alerts: AlertService | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.provider = provider or get_provider(self.settings)
        self.quota = quota or QuotaManager(self.settings)
        self.cache = cache or QueryCache(self.settings.query_cache_ttl_seconds)
        self.alerts = alerts or AlertService(self.settings)

    # ------------------------------------------------------------------ API
    def run_tracker(
        self,
        session: Session,
        tracker: Tracker,
        *,
        trigger: RunTrigger = RunTrigger.SCHEDULED,
        force_refresh: bool = False,
    ) -> CheckResult:
        batch_id = str(uuid.uuid4())
        result = CheckResult(batch_id=batch_id, tracker_id=tracker.id)

        tracker_service.ensure_config_version(session, tracker)
        tracker.last_attempt_at = utcnow()
        session.commit()

        if not self.provider.is_configured():
            self._record_blocked_run(
                session,
                tracker,
                batch_id,
                trigger,
                RunStatus.SKIPPED,
                ErrorCategory.MISSING_CREDENTIALS,
                ProviderMissingCredentialsError().guidance(),
            )
            result.skipped = True
            result.errors.append(ProviderMissingCredentialsError().guidance())
            tracker_service.schedule_next_run(tracker)
            session.commit()
            return result

        try:
            units = self._plan_units(session, tracker)
        except _PlanningRefusal as refusal:
            self._record_blocked_run(
                session,
                tracker,
                batch_id,
                trigger,
                RunStatus.SKIPPED,
                refusal.category,
                refusal.message,
            )
            result.skipped = True
            result.status_messages.append(refusal.message)
            tracker_service.schedule_next_run(tracker)
            session.commit()
            return result

        if not units:
            self._record_blocked_run(
                session,
                tracker,
                batch_id,
                trigger,
                RunStatus.SKIPPED,
                ErrorCategory.NO_CANDIDATES,
                "No date combination was due for checking.",
            )
            result.skipped = True
            result.status_messages.append("No date combination was due for checking.")
            tracker_service.schedule_next_run(tracker)
            session.commit()
            return result

        # Cache first: a cached unit costs no quota.
        cached: dict[str, dict[str, Any] | None] = {}
        billable_units: list[QueryUnit] = []
        for unit in units:
            payload = None if force_refresh else self.cache.get(session, unit.fingerprint)
            cached[unit.fingerprint] = payload
            if payload is None:
                billable_units.append(unit)

        decision = self.quota.authorize(session, wanted=len(billable_units), trigger=trigger)
        session.commit()
        if decision.reason:
            result.status_messages.append(decision.reason)

        allowed_fingerprints = {u.fingerprint for u in billable_units[: decision.granted]}

        for unit in units:
            payload = cached.get(unit.fingerprint)
            if payload is not None:
                self._execute_cached(session, tracker, batch_id, trigger, unit, payload, result)
                continue
            if unit.fingerprint not in allowed_fingerprints:
                self._record_blocked_run(
                    session,
                    tracker,
                    batch_id,
                    trigger,
                    RunStatus.QUOTA_BLOCKED,
                    ErrorCategory.QUOTA_EXHAUSTED,
                    decision.reason or "The configured provider allowance is exhausted.",
                    unit=unit,
                )
                continue
            self._execute_live(
                session, tracker, batch_id, trigger, unit, result, force_refresh=force_refresh
            )

        self._finalize(session, tracker, batch_id, result)
        return result

    # ------------------------------------------------------------- planning
    def _plan_units(self, session: Session, tracker: Tracker) -> list[QueryUnit]:
        markets = tracker.market_codes or [self.settings.default_market]
        today = today_in(self.settings.tzinfo)
        party = PassengerParty(
            adults=tracker.adults,
            children=tracker.children,
            infants_in_seat=tracker.infants_in_seat,
            infants_on_lap=tracker.infants_on_lap,
        )
        cabin = Cabin(tracker.cabin)
        stops = StopsPreference(tracker.stops)
        mode = DateMode(tracker.date_mode)

        if mode is DateMode.EXACT:
            if tracker.outbound_date is None or tracker.return_date is None:
                raise _PlanningRefusal(
                    "This tracker has no outbound or return date. Edit it to set dates.",
                    ErrorCategory.UNSUPPORTED_QUERY,
                )
            if tracker.outbound_date < today:
                raise _PlanningRefusal(
                    f"The outbound date {tracker.outbound_date:%b %-d, %Y} is in the past, so "
                    "no search was made and no quota was used. Stored history is unchanged. "
                    "Edit the tracker with future dates, or pause it.",
                    ErrorCategory.UNSUPPORTED_QUERY,
                )
            return [
                self._exact_unit(
                    tracker, market, tracker.outbound_date, tracker.return_date, party, cabin, stops
                )
                for market in markets
            ]

        if mode is DateMode.FLEXIBLE_PRESET:
            if tracker.flex_month is None or tracker.flex_duration is None:
                raise _PlanningRefusal(
                    "This tracker has no flexible month or trip length. Edit it to set them.",
                    ErrorCategory.UNSUPPORTED_QUERY,
                )
            units = []
            for market in markets:
                query = FlexibleSearchQuery(
                    origin=tracker.origin,
                    destination=tracker.destination,
                    month=tracker.flex_month,
                    duration=FlexDuration(tracker.flex_duration),
                    party=party,
                    cabin=cabin,
                    stops=stops,
                    currency=tracker.currency,
                    market=market,
                    include_airlines=tracker.include_airlines,
                    exclude_airlines=tracker.exclude_airlines,
                )
                params = self.provider.build_flexible_params(query)
                units.append(
                    QueryUnit(
                        market=market,
                        endpoint=EndpointType.GOOGLE_TRAVEL_EXPLORE,
                        params=params,
                        fingerprint=query_fingerprint(
                            EndpointType.GOOGLE_TRAVEL_EXPLORE.value, params
                        ),
                        flexible_query=query,
                    )
                )
            return units

        # Custom flexible window - claim the next candidates from the queue.
        tracker_service.prune_past_candidates(session, tracker, today)
        claimed = tracker_service.next_candidates(
            session, tracker, max(1, tracker.candidates_per_run)
        )
        session.flush()
        if not claimed:
            raise _PlanningRefusal(
                "This flexible window has no remaining valid date combinations. "
                "Stored history is unchanged. Edit the window to cover future dates.",
                ErrorCategory.NO_CANDIDATES,
            )
        units = []
        for candidate in claimed:
            for market in markets:
                unit = self._exact_unit(
                    tracker,
                    market,
                    candidate.outbound_date,
                    candidate.return_date,
                    party,
                    cabin,
                    stops,
                )
                unit.candidate_id = candidate.id
                units.append(unit)
        return units

    def _exact_unit(
        self,
        tracker: Tracker,
        market: str,
        outbound: date,
        inbound: date,
        party: PassengerParty,
        cabin: Cabin,
        stops: StopsPreference,
    ) -> QueryUnit:
        query = ExactSearchQuery(
            origin=tracker.origin,
            destination=tracker.destination,
            outbound_date=outbound,
            return_date=inbound,
            party=party,
            cabin=cabin,
            stops=stops,
            currency=tracker.currency,
            market=market,
            include_airlines=tracker.include_airlines,
            exclude_airlines=tracker.exclude_airlines,
        )
        params = self.provider.build_exact_params(query)
        return QueryUnit(
            market=market,
            endpoint=EndpointType.GOOGLE_FLIGHTS,
            params=params,
            fingerprint=query_fingerprint(EndpointType.GOOGLE_FLIGHTS.value, params),
            outbound_date=outbound,
            return_date=inbound,
            exact_query=query,
        )

    # ------------------------------------------------------------ execution
    def _new_run(
        self,
        tracker: Tracker,
        batch_id: str,
        trigger: RunTrigger,
        *,
        unit: QueryUnit | None = None,
    ) -> SearchRun:
        return SearchRun(
            tracker_id=tracker.id,
            config_version_id=tracker.current_config_version_id,
            batch_id=batch_id,
            trigger=trigger.value,
            endpoint=(unit.endpoint.value if unit else EndpointType.GOOGLE_FLIGHTS.value),
            market=(unit.market if unit else tracker.primary_market),
            currency=tracker.currency,
            outbound_date=unit.outbound_date if unit else tracker.outbound_date,
            return_date=unit.return_date if unit else tracker.return_date,
            query_fingerprint=(unit.fingerprint if unit else "n/a"),
            coverage_cycle=tracker.coverage_cycle,
            started_at=utcnow(),
        )

    def _record_blocked_run(
        self,
        session: Session,
        tracker: Tracker,
        batch_id: str,
        trigger: RunTrigger,
        status: RunStatus,
        category: ErrorCategory,
        reason: str,
        *,
        unit: QueryUnit | None = None,
    ) -> SearchRun:
        run = self._new_run(tracker, batch_id, trigger, unit=unit)
        run.status = status.value
        run.error_category = category.value
        run.skip_reason = reason
        run.cache_status = CacheStatus.NOT_APPLICABLE.value
        run.completed_at = utcnow()
        session.add(run)
        session.commit()
        log.info(
            "search run skipped",
            extra={
                "tracker_id": tracker.id,
                "run_status": status.value,
                "error_category": category.value,
            },
        )
        return run

    def _execute_cached(
        self,
        session: Session,
        tracker: Tracker,
        batch_id: str,
        trigger: RunTrigger,
        unit: QueryUnit,
        payload: dict[str, Any],
        result: CheckResult,
    ) -> None:
        run = self._new_run(tracker, batch_id, trigger, unit=unit)
        run.cache_status = CacheStatus.HIT.value
        run.provider_request_count = 0
        session.add(run)
        session.flush()
        try:
            provider_result = self._parse_cached(unit, payload, tracker)
        except ProviderError as exc:
            self._apply_error(session, run, exc, result)
            return
        self._store_result(session, tracker, run, unit, provider_result, result)
        result.cache_hits += 1

    def _parse_cached(
        self, unit: QueryUnit, payload: dict[str, Any], tracker: Tracker
    ) -> ProviderResult:
        # The provider that produced the payload is the only thing that can
        # read it back, so the dispatch belongs there rather than here.
        return self.provider.parse_payload(
            payload,
            flexible=unit.flexible_query is not None,
            market=unit.market,
            currency=tracker.currency,
            query_fingerprint=unit.fingerprint,
            outbound_date=unit.outbound_date,
            return_date=unit.return_date,
        )

    def _execute_live(
        self,
        session: Session,
        tracker: Tracker,
        batch_id: str,
        trigger: RunTrigger,
        unit: QueryUnit,
        result: CheckResult,
        *,
        force_refresh: bool,
    ) -> None:
        run = self._new_run(tracker, batch_id, trigger, unit=unit)
        run.cache_status = CacheStatus.FORCED.value if force_refresh else CacheStatus.MISS.value
        session.add(run)
        session.flush()

        try:
            if unit.flexible_query is not None:
                provider_result = self.provider.search_flexible(unit.flexible_query)
            else:
                assert unit.exact_query is not None
                provider_result = self.provider.search_exact(unit.exact_query)
        except ProviderError as exc:
            # An auth failure or a refused query does not consume a search;
            # a rate limit does not either. Only count what the provider ran.
            self._apply_error(session, run, exc, result)
            return
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("unexpected search failure", extra={"tracker_id": tracker.id})
            run.status = RunStatus.PROVIDER_ERROR.value
            run.error_category = ErrorCategory.INTERNAL.value
            run.error_message = (
                "FlightNotify hit an unexpected internal error while searching. "
                "Stored history is unchanged. See the application log for details."
            )
            run.completed_at = utcnow()
            session.commit()
            result.errors.append(run.error_message)
            _ = exc
            return

        run.provider_request_count = provider_result.request_count
        self.quota.record_call(
            session,
            endpoint=unit.endpoint.value,
            run_id=run.id,
            count=provider_result.request_count,
        )
        result.provider_calls += provider_result.request_count

        if provider_result.offers:
            self.cache.put(
                session,
                fingerprint=unit.fingerprint,
                endpoint=unit.endpoint.value,
                payload=self._cacheable_payload(provider_result),
                run_id=run.id,
            )

        self._store_result(session, tracker, run, unit, provider_result, result)

    def _cacheable_payload(self, provider_result: ProviderResult) -> dict[str, Any]:
        """Rebuild a minimal provider-shaped payload for the cache.

        Storing the normalized shape (rather than the full raw response) keeps
        the cache small and guarantees no credential ever reaches the database.
        """
        if provider_result.endpoint is EndpointType.GOOGLE_TRAVEL_EXPLORE:
            return {
                "start_date": (
                    provider_result.outbound_date.isoformat()
                    if provider_result.outbound_date
                    else None
                ),
                "end_date": (
                    provider_result.return_date.isoformat() if provider_result.return_date else None
                ),
                "google_flights_link": provider_result.search_link,
                "search_metadata": provider_result.raw_excerpt.get("search_metadata", {}),
                "search_parameters": provider_result.raw_excerpt.get("search_parameters", {}),
                "flights": [
                    {
                        "departure_airport": {"id": offer.origin},
                        "arrival_airport": {"id": offer.destination},
                        "price": str(offer.price_amount),
                        "number_of_stops": offer.stops,
                        "duration": offer.duration_minutes,
                        "airline": offer.airlines[0] if offer.airlines else None,
                    }
                    for offer in provider_result.offers
                ],
            }
        return {
            "search_metadata": provider_result.raw_excerpt.get("search_metadata", {}),
            "search_parameters": provider_result.raw_excerpt.get("search_parameters", {}),
            "other_flights": [
                {
                    "price": str(offer.price_amount),
                    "total_duration": offer.duration_minutes,
                    "flights": offer.segments,
                    "layovers": offer.layovers,
                }
                for offer in provider_result.offers
            ],
        }

    def _apply_error(
        self, session: Session, run: SearchRun, exc: ProviderError, result: CheckResult
    ) -> None:
        status = {
            ErrorCategory.RATE_LIMIT: RunStatus.RATE_LIMITED,
            ErrorCategory.UNSUPPORTED_QUERY: RunStatus.INVALID_REQUEST,
            ErrorCategory.QUOTA_EXHAUSTED: RunStatus.QUOTA_BLOCKED,
        }.get(exc.category, RunStatus.PROVIDER_ERROR)
        run.status = status.value
        run.error_category = exc.category.value
        run.error_message = exc.guidance()
        run.completed_at = utcnow()
        session.commit()
        result.errors.append(exc.guidance())
        log.warning(
            "search run failed",
            extra={
                "tracker_id": run.tracker_id,
                "error_category": exc.category.value,
                "run_status": status.value,
            },
        )

    # ----------------------------------------------------------- persistence
    def _store_result(
        self,
        session: Session,
        tracker: Tracker,
        run: SearchRun,
        unit: QueryUnit,
        provider_result: ProviderResult,
        result: CheckResult,
    ) -> None:
        run.currency = provider_result.currency
        if provider_result.endpoint is EndpointType.GOOGLE_TRAVEL_EXPLORE:
            # Flexible preset: the provider chooses the dates, so record its
            # answer. For exact searches the run already holds the dates that
            # were actually requested and must not be overwritten.
            run.outbound_date = provider_result.outbound_date or run.outbound_date
            run.return_date = provider_result.return_date or run.return_date
        run.raw_excerpt = provider_result.raw_excerpt
        run.completed_at = utcnow()

        eligible_offers = [
            (offer, self._eligibility(tracker, offer)) for offer in provider_result.offers
        ]
        eligible_offers.sort(key=lambda pair: pair[0].price_amount)
        run.offers_found = len(eligible_offers)

        if not eligible_offers:
            run.status = RunStatus.NO_RESULTS.value
            run.error_category = ErrorCategory.NONE.value
            session.commit()
            self._mark_candidate(session, unit, None, checked=True)
            return

        stored: list[FareObservation] = []
        for offer, (eligible, reason) in eligible_offers[:MAX_STORED_OFFERS]:
            stored.append(
                self._build_observation(tracker, run, offer, eligible=eligible, reason=reason)
            )
        session.add_all(stored)
        session.flush()

        best = next((obs for obs in stored if obs.eligible), None)
        if best is None:
            run.status = RunStatus.NO_RESULTS.value
            run.error_message = (
                "The provider returned itineraries, but none matched this tracker's "
                "stops preference. They are stored and marked ineligible."
            )
            session.commit()
            self._mark_candidate(session, unit, None, checked=True)
            return

        best.is_best_of_run = True
        run.best_observation_id = best.id
        run.status = RunStatus.SUCCESS.value
        run.error_category = ErrorCategory.NONE.value
        session.commit()

        result.offers_found += run.offers_found
        self._mark_candidate(session, unit, Decimal(best.price_amount), checked=True)

    def _eligibility(self, tracker: Tracker, offer: NormalizedOffer) -> tuple[bool, str | None]:
        if offer.currency.upper() != tracker.currency.upper():
            return (
                False,
                f"Provider returned {offer.currency}, tracker compares in {tracker.currency}.",
            )
        stops_pref = StopsPreference(tracker.stops)
        if offer.stops is not None:
            if stops_pref is StopsPreference.NONSTOP and offer.stops > 0:
                return False, "Has a stop; tracker requires nonstop."
            if stops_pref is StopsPreference.ONE_STOP_MAX and offer.stops > 1:
                return False, "More than one stop; tracker allows at most one."
        return True, None

    def _build_observation(
        self,
        tracker: Tracker,
        run: SearchRun,
        offer: NormalizedOffer,
        *,
        eligible: bool,
        reason: str | None,
    ) -> FareObservation:
        normalized = normalize_price(
            offer.price_amount,
            scope=offer.price_scope,
            paying_travelers=tracker.paying_travelers,
        )
        # Both dates must come from the same source, or an outbound taken from
        # the itinerary and a return taken from the request could describe an
        # impossible trip. For an exact search the requested pair is what the
        # tracker is tracking; for a flexible search the provider chose them.
        outbound_date: date | None
        return_date: date | None
        if run.endpoint == EndpointType.GOOGLE_FLIGHTS.value and run.outbound_date is not None:
            outbound_date, return_date = run.outbound_date, run.return_date
        else:
            outbound_date = offer.outbound_date or run.outbound_date
            return_date = offer.return_date or run.return_date

        return FareObservation(
            search_run_id=run.id,
            tracker_id=tracker.id,
            config_version_id=tracker.current_config_version_id,
            itinerary_fingerprint=itinerary_fingerprint(
                origin=offer.origin,
                destination=offer.destination,
                outbound_date=outbound_date,
                return_date=return_date,
                flight_numbers=offer.flight_numbers,
                departure_time=offer.departure_time,
                arrival_time=offer.arrival_time,
                stops=offer.stops,
                market=offer.market,
            ),
            price_amount=normalized.reported_amount,
            currency=offer.currency,
            price_scope=normalized.scope.value,
            per_traveler_amount=normalized.per_traveler,
            per_traveler_is_calculated=normalized.per_traveler_is_calculated,
            party_total_amount=normalized.party_total,
            party_total_is_calculated=normalized.party_total_is_calculated,
            origin=offer.origin or tracker.origin,
            destination=offer.destination or tracker.destination,
            outbound_date=outbound_date,
            return_date=return_date,
            departure_time=offer.departure_time,
            arrival_time=offer.arrival_time,
            airlines=offer.airlines,
            flight_numbers=offer.flight_numbers,
            stops=offer.stops,
            duration_minutes=offer.duration_minutes,
            cabin=offer.cabin,
            segments=offer.segments,
            layovers=offer.layovers,
            booking_link=offer.booking_link,
            search_link=offer.search_link,
            market=offer.market,
            observed_at=utcnow(),
            eligible=eligible,
            exclusion_reason=reason,
        )

    def _mark_candidate(
        self, session: Session, unit: QueryUnit, price: Decimal | None, *, checked: bool
    ) -> None:
        if unit.candidate_id is None:
            return
        candidate = session.get(FlexibleDateCandidate, unit.candidate_id)
        if candidate is None:
            return
        if checked:
            candidate.status = CandidateStatus.CHECKED.value
            candidate.last_checked_at = utcnow()
            candidate.check_count += 1
        if price is not None:
            candidate.last_price = price
        session.commit()

    # -------------------------------------------------------------- finalize
    def _finalize(
        self, session: Session, tracker: Tracker, batch_id: str, result: CheckResult
    ) -> None:
        runs = (
            session.execute(select(SearchRun).where(SearchRun.batch_id == batch_id)).scalars().all()
        )
        result.runs = [run.id for run in runs]

        best_ids = [run.best_observation_id for run in runs if run.best_observation_id]
        observations = (
            session.execute(select(FareObservation).where(FareObservation.id.in_(best_ids)))
            .scalars()
            .all()
            if best_ids
            else []
        )

        coverage = tracker_service.coverage_stats(session, tracker)
        coverage_state = (
            CoverageState.NOT_APPLICABLE
            if coverage.total == 0
            else (CoverageState.COMPLETE if coverage.complete else CoverageState.PARTIAL)
        )
        for run in runs:
            run.coverage_state = coverage_state.value
            run.coverage_checked = coverage.checked or None
            run.coverage_total = coverage.total or None

        had_provider_error = any(
            run.status in {RunStatus.PROVIDER_ERROR.value, RunStatus.RATE_LIMITED.value}
            for run in runs
        )

        if not observations:
            if had_provider_error:
                tracker.consecutive_failures += 1
                tracker.last_error_category = next(
                    (
                        run.error_category
                        for run in runs
                        if run.error_category != ErrorCategory.NONE.value
                    ),
                    ErrorCategory.PROVIDER_ERROR.value,
                )
                tracker.last_error_message = next(
                    (run.error_message for run in runs if run.error_message), None
                )
                if tracker.consecutive_failures >= FAILURE_LIMIT:
                    tracker.status = TrackerStatus.ERROR.value
            self._schedule_next(tracker, failed=had_provider_error)
            session.commit()
            return

        best = min(observations, key=lambda obs: Decimal(obs.price_amount))
        result.best_price = Decimal(best.price_amount)
        result.best_market = best.market

        state = self._series_state(session, tracker, exclude_run_ids=[r.id for r in runs])
        evaluation = evaluate(
            reported_amount=Decimal(best.price_amount),
            price_scope=PriceScopeLabel(best.price_scope),
            threshold_amount=Decimal(tracker.threshold_amount),
            threshold_basis=ThresholdBasis(tracker.threshold_basis),
            paying_travelers=tracker.paying_travelers,
            state=state,
            alert_on_threshold=tracker.alert_on_threshold,
            alert_on_new_low=tracker.alert_on_new_low,
            min_drop_absolute=(
                Decimal(tracker.min_drop_absolute)
                if tracker.min_drop_absolute is not None
                else None
            ),
            min_drop_percent=(
                Decimal(tracker.min_drop_percent) if tracker.min_drop_percent is not None else None
            ),
        )

        tracker.latest_price = evaluation.comparable
        tracker.latest_observation_id = best.id
        tracker.latest_observed_at = ensure_utc(best.observed_at)
        tracker.last_success_at = utcnow()
        tracker.consecutive_failures = 0
        tracker.last_error_category = None
        tracker.last_error_message = None
        if tracker.status == TrackerStatus.ERROR:
            tracker.status = TrackerStatus.ACTIVE.value
        if tracker.low_price is None or evaluation.comparable < Decimal(tracker.low_price):
            tracker.low_price = evaluation.comparable
            tracker.low_observation_id = best.id
            tracker.low_observed_at = ensure_utc(best.observed_at)
        tracker.last_threshold_met = evaluation.meets_threshold
        self._schedule_next(tracker, failed=False)
        session.commit()

        # --- alerts run only after everything above is durable -------------
        chat_id = get_chat_id(session, self.settings)
        result.alerts = self.alerts.process(
            session,
            tracker=tracker,
            observation=best,
            evaluation=evaluation,
            coverage=CoverageInfo(
                checked=coverage.checked or None,
                total=coverage.total or None,
                complete=coverage.complete,
            ),
            chat_id=chat_id,
        )
        for outcome in result.alerts:
            if outcome.state is DeliveryState.SENT:
                result.status_messages.append(
                    f"Sent {AlertType(outcome.alert_type).value.replace('_', ' ')} alert."
                )
            elif outcome.state is DeliveryState.FAILED:
                result.errors.append(outcome.detail)
            elif outcome.state is DeliveryState.NOT_CONFIGURED:
                # Not a failure of this check: the price was recorded and the
                # alert is stored. Surfacing it as an error would make
                # `check-once` exit non-zero forever until Telegram is set up.
                result.status_messages.append(outcome.detail)

    def _series_state(
        self, session: Session, tracker: Tracker, exclude_run_ids: list[int]
    ) -> SeriesState:
        """Prior state of the current comparison series, excluding this batch."""
        base = select(FareObservation).where(
            FareObservation.tracker_id == tracker.id,
            FareObservation.config_version_id == tracker.current_config_version_id,
            FareObservation.eligible.is_(True),
            FareObservation.is_best_of_run.is_(True),
        )
        if exclude_run_ids:
            base = base.where(FareObservation.search_run_id.notin_(exclude_run_ids))

        previous = session.execute(
            base.order_by(FareObservation.observed_at.desc()).limit(1)
        ).scalar_one_or_none()
        lowest = session.execute(
            base.order_by(FareObservation.price_amount.asc()).limit(1)
        ).scalar_one_or_none()

        def comparable(obs: FareObservation | None) -> Decimal | None:
            if obs is None:
                return None
            from ..domain.pricing import comparable_amount

            return comparable_amount(
                reported_amount=Decimal(obs.price_amount),
                scope=PriceScopeLabel(obs.price_scope),
                basis=ThresholdBasis(tracker.threshold_basis),
                paying_travelers=tracker.paying_travelers,
            )

        return SeriesState(
            previous_best=comparable(previous),
            series_low=comparable(lowest),
            has_baseline=previous is not None,
            previously_met_threshold=tracker.last_threshold_met,
        )

    def _schedule_next(self, tracker: Tracker, *, failed: bool) -> None:
        if failed and tracker.consecutive_failures > 0:
            # Bounded exponential backoff; never faster than the configured
            # interval and never longer than 24 hours.
            factor = min(2 ** min(tracker.consecutive_failures, 4), 16)
            minutes = min(tracker.check_interval_minutes * factor, 24 * 60)
            from datetime import timedelta

            tracker.next_run_at = utcnow() + timedelta(minutes=minutes)
            return
        tracker_service.schedule_next_run(tracker)


class _PlanningRefusal(Exception):
    def __init__(self, message: str, category: ErrorCategory) -> None:
        super().__init__(message)
        self.message = message
        self.category = category


def app_setting(session: Session, key: str) -> Any:
    row = session.get(AppSetting, key)
    return row.value if row else None
