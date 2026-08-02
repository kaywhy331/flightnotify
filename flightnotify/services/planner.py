"""Call-budget planning shown before a tracker is saved.

Every number here is an estimate of *provider searches*, which is what the free
plan meters. Cache hits are excluded because they are not billable.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..enums import DateMode
from ..timeutil import hours_remaining_in_month

#: Schedules offered in the UI, coarsest first.
SCHEDULE_CHOICES: tuple[tuple[int, str], ...] = (
    (60, "Every hour"),
    (180, "Every 3 hours"),
    (360, "Every 6 hours"),
    (720, "Every 12 hours"),
    (1440, "Once a day"),
    (2880, "Every 2 days"),
    (10080, "Once a week"),
)

#: Conservative default for a new fixed-date tracker.
DEFAULT_INTERVAL_MINUTES = 720


@dataclass(frozen=True, slots=True)
class PlanInput:
    date_mode: DateMode
    market_count: int
    check_interval_minutes: int
    candidates_per_run: int = 1
    total_candidates: int = 0


@dataclass(frozen=True, slots=True)
class PlanEstimate:
    calls_per_scan: int
    scans_remaining_this_month: int
    calls_remaining_this_month: int
    calls_per_full_cycle: int
    scans_per_full_cycle: int
    calls_per_30_days: int

    @property
    def has_coverage_cycle(self) -> bool:
        return self.scans_per_full_cycle > 1


def estimate(plan: PlanInput, *, now_hours_left: float | None = None) -> PlanEstimate:
    markets = max(1, plan.market_count)

    if plan.date_mode is DateMode.CUSTOM_WINDOW:
        per_scan_units = max(1, plan.candidates_per_run)
        total_units = max(0, plan.total_candidates)
    else:
        per_scan_units = 1
        total_units = 1

    calls_per_scan = per_scan_units * markets
    scans_per_cycle = max(1, math.ceil(total_units / per_scan_units)) if total_units else 1
    calls_per_cycle = total_units * markets if total_units else calls_per_scan

    hours_left = hours_remaining_in_month() if now_hours_left is None else now_hours_left
    interval_hours = max(plan.check_interval_minutes, 1) / 60
    scans_left = int(hours_left // interval_hours)

    calls_per_30_days = int((30 * 24) / interval_hours) * calls_per_scan

    return PlanEstimate(
        calls_per_scan=calls_per_scan,
        scans_remaining_this_month=scans_left,
        calls_remaining_this_month=scans_left * calls_per_scan,
        calls_per_full_cycle=calls_per_cycle,
        scans_per_full_cycle=scans_per_cycle,
        calls_per_30_days=calls_per_30_days,
    )


@dataclass(frozen=True, slots=True)
class BudgetVerdict:
    fits: bool
    severity: str  # "ok" | "warning" | "blocked"
    headline: str
    detail: str
    suggestions: list[str]


def assess(
    estimate_value: PlanEstimate,
    *,
    remaining_safe: int,
    remaining_hard: int,
    monthly_limit: int,
    plan: PlanInput,
) -> BudgetVerdict:
    """Explain whether the configuration fits the remaining free allowance."""
    needed = estimate_value.calls_remaining_this_month
    suggestions: list[str] = []
    if plan.market_count > 1:
        suggestions.append("Compare fewer country markets.")
    if plan.date_mode is DateMode.CUSTOM_WINDOW:
        suggestions.append("Narrow the outbound window or the trip-length range.")
        if plan.candidates_per_run > 1:
            suggestions.append("Check fewer date combinations per run.")
    suggestions.append("Check less often.")

    if estimate_value.calls_per_scan > remaining_hard:
        return BudgetVerdict(
            fits=False,
            severity="blocked",
            headline="A single scan does not fit the remaining allowance.",
            detail=(
                f"One scan needs {estimate_value.calls_per_scan} provider searches but only "
                f"{remaining_hard} remain this period (cap {monthly_limit})."
            ),
            suggestions=suggestions,
        )

    if needed > remaining_safe:
        return BudgetVerdict(
            fits=False,
            severity="warning",
            headline="This schedule will not run for the rest of the month.",
            detail=(
                f"Running every {_interval_label(plan.check_interval_minutes)} until the period "
                f"resets needs about {needed} provider searches; {remaining_safe} are available "
                "to automation. FlightNotify will keep checking until the allowance runs out "
                "and then pause scheduled checks rather than exceeding the cap."
            ),
            suggestions=suggestions,
        )

    coverage_note = ""
    if estimate_value.has_coverage_cycle:
        coverage_note = (
            f" A full sweep of all date combinations takes {estimate_value.scans_per_full_cycle} "
            f"scans ({estimate_value.calls_per_full_cycle} searches)."
        )
    return BudgetVerdict(
        fits=True,
        severity="ok",
        headline="This configuration fits the remaining allowance.",
        detail=(
            f"About {needed} of {remaining_safe} available searches for the rest of the period."
            + coverage_note
        ),
        suggestions=[],
    )


def _interval_label(minutes: int) -> str:
    for value, label in SCHEDULE_CHOICES:
        if value == minutes:
            return label.lower()
    if minutes % 1440 == 0:
        return f"{minutes // 1440} days"
    if minutes % 60 == 0:
        return f"{minutes // 60} hours"
    return f"{minutes} minutes"


def interval_label(minutes: int) -> str:
    return _interval_label(minutes)
