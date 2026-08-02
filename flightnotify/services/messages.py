"""Telegram alert message composition.

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
from zoneinfo import ZoneInfo

from ..domain.pricing import format_money
from ..enums import CABIN_LABELS, AlertType, PriceScopeLabel, ThresholdBasis
from ..timeutil import format_local

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
