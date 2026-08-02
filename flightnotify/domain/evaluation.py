"""Threshold and historical-low evaluation.

"Historical low" means: the lowest comparable fare *FlightNotify has observed*
for this tracker's current configuration series. It is not a prediction and it
is never described as a guaranteed or future minimum.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from ..enums import AlertType, PriceScopeLabel, ThresholdBasis
from .pricing import comparable_amount, money


@dataclass(frozen=True, slots=True)
class SeriesState:
    """What was already known about the series before this observation."""

    previous_best: Decimal | None = None
    series_low: Decimal | None = None
    has_baseline: bool = False
    previously_met_threshold: bool = False


@dataclass(frozen=True, slots=True)
class AlertDecision:
    alert_type: AlertType
    should_alert: bool
    reason: str


@dataclass(frozen=True, slots=True)
class Evaluation:
    comparable: Decimal
    is_baseline: bool
    meets_threshold: bool
    is_new_low: bool
    drop_absolute: Decimal | None
    drop_percent: Decimal | None
    previous_best: Decimal | None
    previous_low: Decimal | None
    decisions: list[AlertDecision] = field(default_factory=list)

    @property
    def alerts_to_send(self) -> list[AlertType]:
        return [d.alert_type for d in self.decisions if d.should_alert]

    def reason_for(self, alert_type: AlertType) -> str:
        for decision in self.decisions:
            if decision.alert_type is alert_type:
                return decision.reason
        return ""


def evaluate(
    *,
    reported_amount: Decimal,
    price_scope: PriceScopeLabel | str,
    threshold_amount: Decimal,
    threshold_basis: ThresholdBasis | str,
    paying_travelers: int,
    state: SeriesState,
    alert_on_threshold: bool = True,
    alert_on_new_low: bool = True,
    min_drop_absolute: Decimal | None = None,
    min_drop_percent: Decimal | None = None,
) -> Evaluation:
    """Decide what this observation means for the tracker.

    Rules that matter:

    * a price exactly equal to the threshold counts as reaching it;
    * the first observation in a series is a *baseline* - it may fire a
      threshold alert, but never a "new low" alert and never a "price drop";
    * a new low requires a strictly lower comparable fare than the series low;
    * minimum-drop rules gate alerts only when a previous best exists.
    """
    basis = ThresholdBasis(threshold_basis)
    comparable = comparable_amount(
        reported_amount=reported_amount,
        scope=price_scope,
        basis=basis,
        paying_travelers=paying_travelers,
    )
    threshold = money(threshold_amount)

    is_baseline = not state.has_baseline
    meets_threshold = comparable <= threshold
    previous_low = state.series_low
    is_new_low = (not is_baseline) and previous_low is not None and comparable < previous_low

    drop_absolute: Decimal | None = None
    drop_percent: Decimal | None = None
    if state.previous_best is not None and state.previous_best > 0:
        drop_absolute = money(state.previous_best - comparable)
        drop_percent = money((drop_absolute / state.previous_best) * Decimal(100))

    decisions: list[AlertDecision] = []

    # --- threshold ----------------------------------------------------------
    if not alert_on_threshold:
        decisions.append(
            AlertDecision(AlertType.THRESHOLD, False, "Threshold alerts are turned off.")
        )
    elif not meets_threshold:
        decisions.append(
            AlertDecision(
                AlertType.THRESHOLD,
                False,
                f"Observed {comparable} is above the threshold {threshold}.",
            )
        )
    elif state.previously_met_threshold and not is_new_low and not is_baseline:
        # Already under threshold on the previous check and no improvement:
        # the dedupe key would normally catch this, but skipping here avoids
        # creating an event row for an unchanged situation.
        decisions.append(
            AlertDecision(
                AlertType.THRESHOLD,
                False,
                "Already under threshold on the previous check with no further improvement.",
            )
        )
    else:
        blocked = _min_drop_block(drop_absolute, drop_percent, min_drop_absolute, min_drop_percent)
        if blocked and not is_baseline:
            decisions.append(AlertDecision(AlertType.THRESHOLD, False, blocked))
        else:
            reason = (
                "First observation for this configuration is at or below the threshold."
                if is_baseline
                else "Fare reached the threshold."
            )
            decisions.append(AlertDecision(AlertType.THRESHOLD, True, reason))

    # --- new observed low ---------------------------------------------------
    if not alert_on_new_low:
        decisions.append(AlertDecision(AlertType.NEW_LOW, False, "New-low alerts are turned off."))
    elif is_baseline:
        decisions.append(
            AlertDecision(
                AlertType.NEW_LOW,
                False,
                "This is the baseline observation, not a price drop.",
            )
        )
    elif not is_new_low:
        decisions.append(
            AlertDecision(
                AlertType.NEW_LOW,
                False,
                f"Observed {comparable} is not below the observed low {previous_low}.",
            )
        )
    else:
        blocked = _min_drop_block(drop_absolute, drop_percent, min_drop_absolute, min_drop_percent)
        if blocked:
            decisions.append(AlertDecision(AlertType.NEW_LOW, False, blocked))
        else:
            decisions.append(
                AlertDecision(AlertType.NEW_LOW, True, "New lowest fare observed for this tracker.")
            )

    return Evaluation(
        comparable=comparable,
        is_baseline=is_baseline,
        meets_threshold=meets_threshold,
        is_new_low=is_new_low,
        drop_absolute=drop_absolute,
        drop_percent=drop_percent,
        previous_best=state.previous_best,
        previous_low=previous_low,
        decisions=decisions,
    )


def _min_drop_block(
    drop_absolute: Decimal | None,
    drop_percent: Decimal | None,
    min_drop_absolute: Decimal | None,
    min_drop_percent: Decimal | None,
) -> str | None:
    """Return a reason string when a minimum-drop rule blocks the alert."""
    if (
        min_drop_absolute is not None
        and min_drop_absolute > 0
        and (drop_absolute is None or drop_absolute < money(min_drop_absolute))
    ):
        return (
            f"Drop of {drop_absolute if drop_absolute is not None else 0} is below the "
            f"configured minimum of {money(min_drop_absolute)}."
        )
    if (
        min_drop_percent is not None
        and min_drop_percent > 0
        and (drop_percent is None or drop_percent < money(min_drop_percent))
    ):
        return (
            f"Drop of {drop_percent if drop_percent is not None else 0}% is below the "
            f"configured minimum of {money(min_drop_percent)}%."
        )
    return None
