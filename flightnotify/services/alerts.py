"""Alert creation, deduplication and delivery.

Ordering guarantee: price observations are already committed before this module
runs. An alert event is persisted in its own transaction *before* delivery is
attempted, and a delivery failure only updates that event - it can never
discard a stored observation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import Settings, get_settings
from ..domain.evaluation import Evaluation
from ..domain.fingerprints import alert_dedupe_key
from ..enums import AlertType, DeliveryState, PriceScopeLabel, ThresholdBasis
from ..models import AlertEvent, FareObservation, Tracker
from ..timeutil import ensure_utc, utcnow
from .messages import AlertContext, build_alert_text
from .telegram import TelegramNotifier

log = logging.getLogger(__name__)

#: Delivery attempts per alert before it is left as failed for the operator.
MAX_DELIVERY_ATTEMPTS = 3


@dataclass(frozen=True, slots=True)
class CoverageInfo:
    checked: int | None = None
    total: int | None = None
    complete: bool = True


@dataclass(frozen=True, slots=True)
class AlertOutcome:
    alert_type: AlertType
    state: DeliveryState
    detail: str
    event_id: int | None = None


class AlertService:
    def __init__(
        self,
        settings: Settings | None = None,
        notifier: TelegramNotifier | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.notifier = notifier or TelegramNotifier(self.settings)

    # -- public -------------------------------------------------------------
    def process(
        self,
        session: Session,
        *,
        tracker: Tracker,
        observation: FareObservation,
        evaluation: Evaluation,
        coverage: CoverageInfo,
        chat_id: str | None,
    ) -> list[AlertOutcome]:
        """Create and attempt any alerts this observation earns.

        One observation produces at most one message. When a single fare is
        both a new observed low *and* at or below the threshold, only the
        new-low alert is sent - its body already states the threshold and that
        the fare is under it, so a second message would say nothing new. The
        threshold event is still recorded, marked as consolidated.
        """
        pending = list(evaluation.alerts_to_send)
        consolidated: list[AlertType] = []
        if AlertType.NEW_LOW in pending and AlertType.THRESHOLD in pending:
            pending.remove(AlertType.THRESHOLD)
            consolidated.append(AlertType.THRESHOLD)

        outcomes: list[AlertOutcome] = []
        for alert_type in pending:
            outcomes.append(
                self._handle_one(
                    session,
                    tracker=tracker,
                    observation=observation,
                    evaluation=evaluation,
                    coverage=coverage,
                    alert_type=alert_type,
                    chat_id=chat_id,
                )
            )
        for alert_type in consolidated:
            outcomes.append(
                self._handle_one(
                    session,
                    tracker=tracker,
                    observation=observation,
                    evaluation=evaluation,
                    coverage=coverage,
                    alert_type=alert_type,
                    chat_id=chat_id,
                    suppress_reason=(
                        "Consolidated into the new-observed-low alert for the same "
                        "observation, which already reports the threshold."
                    ),
                )
            )
        return outcomes

    def retry_pending(self, session: Session, chat_id: str | None, limit: int = 20) -> int:
        """Re-attempt alerts that failed with a retryable error."""
        if not chat_id:
            return 0
        events = (
            session.execute(
                select(AlertEvent)
                .where(
                    AlertEvent.delivery_state.in_(
                        [DeliveryState.PENDING.value, DeliveryState.FAILED.value]
                    ),
                    AlertEvent.attempts < MAX_DELIVERY_ATTEMPTS,
                )
                .order_by(AlertEvent.created_at)
                .limit(limit)
            )
            .scalars()
            .all()
        )
        delivered = 0
        for event in events:
            if self._deliver(session, event, chat_id):
                delivered += 1
        return delivered

    # -- internals ----------------------------------------------------------
    def _handle_one(
        self,
        session: Session,
        *,
        tracker: Tracker,
        observation: FareObservation,
        evaluation: Evaluation,
        coverage: CoverageInfo,
        alert_type: AlertType,
        chat_id: str | None,
        suppress_reason: str | None = None,
    ) -> AlertOutcome:
        dedupe_key = alert_dedupe_key(
            tracker_id=tracker.id,
            config_version_id=tracker.current_config_version_id,
            alert_type=alert_type.value,
            price=evaluation.comparable,
            currency=tracker.currency,
            itinerary_fingerprint_value=observation.itinerary_fingerprint,
            outbound_date=observation.outbound_date,
            return_date=observation.return_date,
            market=observation.market,
        )

        existing = session.execute(
            select(AlertEvent).where(AlertEvent.dedupe_key == dedupe_key)
        ).scalar_one_or_none()
        if existing is not None:
            return AlertOutcome(
                alert_type,
                DeliveryState.SUPPRESSED_DUPLICATE,
                "An identical alert was already recorded for this fare and itinerary.",
                existing.id,
            )

        message = build_alert_text(
            self._context(tracker, observation, evaluation, coverage, alert_type),
            self.settings.tzinfo,
        )

        event = AlertEvent(
            tracker_id=tracker.id,
            config_version_id=tracker.current_config_version_id,
            observation_id=observation.id,
            alert_type=alert_type.value,
            dedupe_key=dedupe_key,
            message_text=message,
            delivery_state=DeliveryState.PENDING.value,
        )
        session.add(event)
        try:
            session.commit()
        except IntegrityError:
            # Another worker inserted the same key between the check and commit.
            session.rollback()
            return AlertOutcome(
                alert_type,
                DeliveryState.SUPPRESSED_DUPLICATE,
                "An identical alert was recorded concurrently.",
                None,
            )

        if suppress_reason:
            event.delivery_state = DeliveryState.SUPPRESSED_DUPLICATE.value
            event.last_error = suppress_reason
            session.commit()
            return AlertOutcome(
                alert_type, DeliveryState.SUPPRESSED_DUPLICATE, suppress_reason, event.id
            )

        cooldown_reason = self._cooldown_reason(session, tracker, alert_type, event.id)
        if cooldown_reason:
            event.delivery_state = DeliveryState.SUPPRESSED_COOLDOWN.value
            event.last_error = cooldown_reason
            session.commit()
            return AlertOutcome(
                alert_type, DeliveryState.SUPPRESSED_COOLDOWN, cooldown_reason, event.id
            )

        if not self.notifier.is_configured() or not chat_id:
            event.delivery_state = DeliveryState.NOT_CONFIGURED.value
            event.last_error = (
                "Telegram is not configured. The alert is recorded here; set "
                "TELEGRAM_BOT_TOKEN and a chat id in Settings to receive messages."
            )
            session.commit()
            return AlertOutcome(
                alert_type, DeliveryState.NOT_CONFIGURED, event.last_error, event.id
            )

        delivered = self._deliver(session, event, chat_id)
        state = DeliveryState(event.delivery_state)
        return AlertOutcome(
            alert_type,
            state,
            "Alert delivered." if delivered else (event.last_error or "Delivery failed."),
            event.id,
        )

    def _deliver(self, session: Session, event: AlertEvent, chat_id: str) -> bool:
        event.attempts += 1
        result = self.notifier.send_message(chat_id, event.message_text, disable_preview=False)
        if result.ok:
            event.delivery_state = DeliveryState.SENT.value
            event.delivered_at = utcnow()
            event.telegram_message_id = result.message_id
            event.last_error = None
            event.response_meta = {"message_id": result.message_id}
        else:
            event.delivery_state = DeliveryState.FAILED.value
            event.last_error = result.user_message
            event.response_meta = {
                "category": result.category,
                "error_code": result.error_code,
                "description": result.description,
                "retry_after": result.retry_after,
                "retryable": result.retryable,
                "attempts": event.attempts,
            }
            log.warning(
                "telegram delivery failed",
                extra={
                    "alert_event_id": event.id,
                    "category": result.category,
                    "attempts": event.attempts,
                },
            )
        session.commit()
        return result.ok

    def _cooldown_reason(
        self, session: Session, tracker: Tracker, alert_type: AlertType, current_id: int
    ) -> str | None:
        if tracker.cooldown_minutes <= 0:
            return None
        window_start = utcnow() - timedelta(minutes=tracker.cooldown_minutes)
        previous = session.execute(
            select(AlertEvent)
            .where(
                AlertEvent.tracker_id == tracker.id,
                AlertEvent.alert_type == alert_type.value,
                AlertEvent.delivery_state == DeliveryState.SENT.value,
                AlertEvent.id != current_id,
            )
            .order_by(AlertEvent.delivered_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if previous is None:
            return None
        delivered_at = ensure_utc(previous.delivered_at)
        if delivered_at is None or delivered_at < window_start:
            return None
        minutes_left = int((delivered_at - window_start).total_seconds() // 60) + 1
        return (
            f"Cooldown active: a {alert_type.value.replace('_', ' ')} alert was sent "
            f"{tracker.cooldown_minutes - minutes_left} minutes ago "
            f"(cooldown {tracker.cooldown_minutes} minutes)."
        )

    def _context(
        self,
        tracker: Tracker,
        observation: FareObservation,
        evaluation: Evaluation,
        coverage: CoverageInfo,
        alert_type: AlertType,
    ) -> AlertContext:
        return AlertContext(
            alert_type=alert_type,
            tracker_name=tracker.name,
            origin=observation.origin or tracker.origin,
            destination=observation.destination or tracker.destination,
            passenger_summary=tracker.passenger_summary,
            cabin=tracker.cabin,
            currency=tracker.currency,
            comparable_amount=evaluation.comparable,
            threshold_amount=Decimal(tracker.threshold_amount),
            threshold_basis=ThresholdBasis(tracker.threshold_basis),
            price_scope=PriceScopeLabel(observation.price_scope),
            outbound_date=observation.outbound_date,
            return_date=observation.return_date,
            stops=observation.stops,
            market=observation.market,
            observed_at=ensure_utc(observation.observed_at) or utcnow(),
            previous_low=(
                Decimal(evaluation.previous_low) if evaluation.previous_low is not None else None
            ),
            drop_absolute=evaluation.drop_absolute,
            is_baseline=evaluation.is_baseline,
            coverage_checked=coverage.checked,
            coverage_total=coverage.total,
            coverage_complete=coverage.complete,
            link=observation.booking_link or observation.search_link,
            airlines=list(observation.airlines or []),
        )
