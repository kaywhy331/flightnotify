"""Telegram message composition - alerts and command replies.

Wording rules that the product contract fixes:

* "observed" price, never "guaranteed";
* "new observed low", never urgency language;
* a partial flexible sweep is always labelled as partial;
* a baseline observation is never called a price drop;
* a link is only included when the provider supplied one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

from ..domain.pricing import format_money
from ..enums import (
    CABIN_LABELS,
    AlertType,
    DateMode,
    FlexDuration,
    PriceScopeLabel,
    ThresholdBasis,
    TrackerStatus,
)
from ..timeutil import format_local

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..models import Tracker
    from .quota import QuotaSnapshot

DISCLAIMER = "Price and availability can change before booking."


@dataclass(frozen=True, slots=True)
class AlertContext:
    alert_type: AlertType
    tracker_name: str
    origin: str
    destination: str
    passenger_summary: str
    cabin: str
    currency: str
    comparable_amount: Decimal
    threshold_amount: Decimal
    threshold_basis: ThresholdBasis
    price_scope: PriceScopeLabel
    outbound_date: date | None
    return_date: date | None
    stops: int | None
    market: str
    observed_at: datetime
    previous_low: Decimal | None
    drop_absolute: Decimal | None
    is_baseline: bool
    coverage_checked: int | None
    coverage_total: int | None
    coverage_complete: bool
    link: str | None
    airlines: list[str]


def _date_range(outbound: date | None, inbound: date | None) -> str:
    if outbound is None and inbound is None:
        return "Dates from provider"
    if outbound is not None and inbound is not None:
        if inbound < outbound:
            # Never collapse an incoherent pair into a tidy-looking range like
            # "Oct 12-8": spell both dates out so the oddity is visible.
            return f"{outbound:%b %-d, %Y} → {inbound:%b %-d, %Y}"
        if outbound.year == inbound.year and outbound.month == inbound.month:
            return f"{outbound:%b %-d}–{inbound:%-d}"
        return f"{outbound:%b %-d}–{inbound:%b %-d}"
    single = outbound or inbound
    return f"{single:%b %-d}" if single else "Dates from provider"


def _stops_label(stops: int | None) -> str:
    if stops is None:
        return "Stops unknown"
    if stops == 0:
        return "Nonstop"
    return f"{stops} stop" + ("s" if stops != 1 else "")


def _basis_label(basis: ThresholdBasis, scope: PriceScopeLabel, passengers: str) -> str:
    if scope is PriceScopeLabel.UNKNOWN:
        return "as reported by the provider (price basis unconfirmed)"
    if basis is ThresholdBasis.PER_TRAVELER:
        return "per traveler"
    return f"total for {passengers}"


def build_alert_text(ctx: AlertContext, tz: ZoneInfo) -> str:
    """Compose the plain-text alert body (Telegram HTML parse mode)."""
    from .telegram import escape_html

    heading = "✈️ New observed low" if ctx.alert_type is AlertType.NEW_LOW else "✈️ Threshold reached"
    lines: list[str] = [
        f"<b>{escape_html(heading)} — {escape_html(ctx.origin)} → "
        f"{escape_html(ctx.destination)}</b>",
        escape_html(ctx.tracker_name),
        "",
        escape_html(
            f"{format_money(ctx.comparable_amount, ctx.currency)} "
            f"{_basis_label(ctx.threshold_basis, ctx.price_scope, ctx.passenger_summary)} · "
            f"{CABIN_LABELS.get(ctx.cabin, ctx.cabin.title())}"
        ),
    ]

    detail = f"{_date_range(ctx.outbound_date, ctx.return_date)} · {_stops_label(ctx.stops)}"
    if ctx.airlines:
        detail += f" · {', '.join(ctx.airlines[:3])}"
    detail += f" · {ctx.market.upper()} market"
    lines.append(escape_html(detail))

    if ctx.is_baseline:
        lines.append(
            escape_html(
                "First observation for this configuration — recorded as the baseline, "
                "not a price drop."
            )
        )
    elif ctx.previous_low is not None and ctx.drop_absolute is not None and ctx.drop_absolute > 0:
        lines.append(
            escape_html(
                f"Previous observed low: {format_money(ctx.previous_low, ctx.currency)} · "
                f"down {format_money(ctx.drop_absolute, ctx.currency)}"
            )
        )
    elif ctx.previous_low is not None:
        lines.append(
            escape_html(f"Previous observed low: {format_money(ctx.previous_low, ctx.currency)}")
        )

    basis_word = (
        "per traveler" if ctx.threshold_basis is ThresholdBasis.PER_TRAVELER else "whole party"
    )
    lines.append(
        escape_html(f"Threshold: {format_money(ctx.threshold_amount, ctx.currency)} ({basis_word})")
    )
    lines.append(escape_html(f"Checked: {format_local(ctx.observed_at, tz)}"))

    coverage = coverage_sentence(
        ctx.coverage_checked, ctx.coverage_total, complete=ctx.coverage_complete
    )
    if coverage:
        lines.append(escape_html(coverage))

    if ctx.link:
        lines.append("")
        lines.append(f'<a href="{escape_html(ctx.link)}">Open this search on Google Flights</a>')

    lines.append("")
    lines.append(f"<i>{escape_html(DISCLAIMER)}</i>")
    return "\n".join(lines)


def coverage_sentence(checked: int | None, total: int | None, *, complete: bool) -> str:
    """Never describe a partial sweep as a complete search."""
    if not total or total <= 1:
        return ""
    if complete and checked is not None and checked >= total:
        return f"Lowest across all {total} date combinations in this cycle."
    if checked is None:
        return f"Partial scan of {total} date combinations."
    return f"Lowest observed among {checked} of {total} date combinations checked."


def build_test_message(tz: ZoneInfo, now: datetime) -> str:
    from .telegram import escape_html

    return (
        "<b>✈️ FlightNotify test message</b>\n"
        + escape_html(
            "If you can read this, alerts are wired up correctly. "
            "This message contains no fare data."
        )
        + "\n"
        + escape_html(f"Sent: {format_local(now, tz)}")
    )


# --------------------------------------------------------------- date summary
MONTH_NAMES: tuple[str, ...] = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

_FLEX_LENGTHS: dict[str, str] = {
    FlexDuration.WEEKEND: "weekend",
    FlexDuration.ONE_WEEK: "about 1 week",
    FlexDuration.TWO_WEEKS: "about 2 weeks",
}


def date_summary(tracker: Tracker) -> str:
    """Human description of a tracker's dates.

    Lives here rather than in the web view models because the Telegram command
    replies need exactly the same wording; the web layer imports it.
    """
    mode = DateMode(tracker.date_mode)
    if mode is DateMode.EXACT:
        if tracker.outbound_date and tracker.return_date:
            return f"{tracker.outbound_date:%b %-d, %Y} → {tracker.return_date:%b %-d, %Y}"
        return "Dates not set"
    if mode is DateMode.FLEXIBLE_PRESET:
        month = tracker.flex_month
        duration = tracker.flex_duration
        month_name = MONTH_NAMES[month - 1] if month and 1 <= month <= 12 else "Any month"
        length = _FLEX_LENGTHS.get(FlexDuration(duration), "flexible") if duration else "flexible"
        return f"{month_name}, {length} (provider picks the dates)"
    parts = []
    if tracker.window_outbound_start and tracker.window_outbound_end:
        parts.append(
            f"Depart {tracker.window_outbound_start:%b %-d} – {tracker.window_outbound_end:%b %-d}"
        )
    if tracker.window_return_start and tracker.window_return_end:
        parts.append(
            f"Return {tracker.window_return_start:%b %-d} – {tracker.window_return_end:%b %-d}"
        )
    if tracker.min_nights is not None or tracker.max_nights is not None:
        lo = tracker.min_nights if tracker.min_nights is not None else "?"
        hi = tracker.max_nights if tracker.max_nights is not None else "?"
        parts.append(f"{lo}–{hi} nights")
    return " · ".join(parts) or "Window not set"


# ------------------------------------------------------------- command replies
#: Shown by /help and by any unrecognised command.
COMMAND_HELP: tuple[tuple[str, str], ...] = (
    ("/status", "quota, scheduler and setup state"),
    ("/trackers", "every tracker with its latest observed fare"),
    ("/tracker <id>", "detail for one tracker"),
    ("/check <id>", "check one tracker now (spends provider searches)"),
    ("/pause <id>", "stop checking a tracker (history is kept)"),
    ("/resume <id>", "resume a paused tracker"),
    ("/help", "this list"),
)


def build_help_message() -> str:
    from .telegram import escape_html

    lines = ["<b>✈️ FlightNotify commands</b>", ""]
    lines += [f"{escape_html(name)} — {escape_html(what)}" for name, what in COMMAND_HELP]
    lines += [
        "",
        escape_html(
            "/check spends provider searches from the monthly free-tier allowance, "
            "so it is the only command here that costs anything."
        ),
    ]
    return "\n".join(lines)


def build_unknown_command_message(command: str) -> str:
    from .telegram import escape_html

    return (
        f"{escape_html(f'Unrecognised command {command}.')}\n\n{build_help_message()}"
        if command
        else build_help_message()
    )


def build_status_message(
    *,
    snapshot: QuotaSnapshot,
    scheduler_running: bool,
    scheduler_detail: str,
    tracker_count: int,
    active_count: int,
    provider_configured: bool,
    version: str,
    now: datetime,
    tz: ZoneInfo,
) -> str:
    from .telegram import escape_html

    lines = [
        f"<b>{escape_html(f'✈️ FlightNotify {version}')}</b>",
        "",
        escape_html(f"Trackers: {tracker_count} ({active_count} active)"),
        escape_html(
            f"Quota: {snapshot.effective_used}/{snapshot.monthly_limit} used · "
            f"{snapshot.remaining_safe} available to automation · "
            f"{snapshot.reserve} reserved for manual checks"
        ),
        escape_html(
            f"Hourly: {snapshot.hourly_used}/{snapshot.hourly_limit} in the last hour · "
            f"period {snapshot.period}"
        ),
        escape_html(
            f"Scheduler: {'running' if scheduler_running else 'not running'} — {scheduler_detail}"
        ),
    ]
    if not provider_configured:
        lines.append(escape_html("SERPAPI_API_KEY is not set, so no search can run."))
    if snapshot.sync_error:
        lines.append(escape_html(f"Quota sync: {snapshot.sync_error}"))
    lines += ["", escape_html(f"As of {format_local(now, tz)}")]
    return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class TrackerSummary:
    """Everything a command reply says about one tracker."""

    tracker_id: int
    name: str
    status: str
    origin: str
    destination: str
    currency: str
    dates: str
    latest_price: Decimal | None
    low_price: Decimal | None
    threshold_amount: Decimal
    threshold_basis: ThresholdBasis
    last_success_at: datetime | None
    next_run_at: datetime | None
    stale: bool
    coverage_checked: int | None
    coverage_total: int | None
    coverage_complete: bool

    @property
    def meets_threshold(self) -> bool:
        return self.latest_price is not None and self.latest_price <= self.threshold_amount


def _price_or_dash(amount: Decimal | None, currency: str) -> str:
    return format_money(amount, currency) if amount is not None else "no observation yet"


def build_trackers_message(summaries: list[TrackerSummary], tz: ZoneInfo) -> str:
    from .telegram import escape_html

    if not summaries:
        return escape_html("No trackers yet. Add one in the web UI.")

    lines = ["<b>✈️ Trackers</b>", ""]
    for item in summaries:
        state = ""
        if item.status == TrackerStatus.PAUSED.value:
            state = " · paused"
        elif item.status == TrackerStatus.ERROR.value:
            state = " · error"
        elif item.stale:
            state = " · stale"
        lines.append(
            f"<b>{escape_html(f'{item.tracker_id}. {item.name}')}</b>"
            + escape_html(f" ({item.origin} → {item.destination}){state}")
        )
        marker = "at or below threshold" if item.meets_threshold else "above threshold"
        lines.append(
            escape_html(
                f"   {_price_or_dash(item.latest_price, item.currency)}"
                + (f" · {marker}" if item.latest_price is not None else "")
            )
        )
    lines += ["", escape_html("Send /tracker <id> for detail.")]
    return "\n".join(lines)


def build_tracker_detail_message(item: TrackerSummary, tz: ZoneInfo) -> str:
    from .telegram import escape_html

    basis_word = (
        "per traveler" if item.threshold_basis is ThresholdBasis.PER_TRAVELER else "whole party"
    )
    lines = [
        f"<b>{escape_html(f'✈️ {item.name}')}</b>",
        escape_html(f"{item.origin} → {item.destination} · {item.dates}"),
        "",
        escape_html(f"Latest observed: {_price_or_dash(item.latest_price, item.currency)}"),
        escape_html(f"Observed low: {_price_or_dash(item.low_price, item.currency)}"),
        escape_html(
            f"Threshold: {format_money(item.threshold_amount, item.currency)} ({basis_word})"
            + (" — reached" if item.meets_threshold else " — not reached")
        ),
        escape_html(f"Status: {item.status}" + (" · stale" if item.stale else "")),
    ]
    if item.last_success_at is not None:
        lines.append(escape_html(f"Last success: {format_local(item.last_success_at, tz)}"))
    if item.next_run_at is not None and item.status == TrackerStatus.ACTIVE.value:
        lines.append(escape_html(f"Next check: {format_local(item.next_run_at, tz)}"))

    coverage = coverage_sentence(
        item.coverage_checked, item.coverage_total, complete=item.coverage_complete
    )
    if coverage:
        lines.append(escape_html(coverage))

    lines += ["", f"<i>{escape_html(DISCLAIMER)}</i>"]
    return "\n".join(lines)


def build_check_result_message(
    *,
    tracker_name: str,
    summary: str,
    status_messages: list[str],
    errors: list[str],
) -> str:
    from .telegram import escape_html

    lines = [f"<b>{escape_html(tracker_name)}</b>", escape_html(summary)]
    lines += [escape_html(f"note: {message}") for message in status_messages]
    lines += [escape_html(f"error: {error}") for error in errors]
    return "\n".join(lines)
