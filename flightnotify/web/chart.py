"""Server-rendered price-history chart.

The SVG is generated on the server and scales with its container, so the chart
works with JavaScript disabled, resizes without clipping, and is always
accompanied by the same data as a real table (rendered by the template).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from html import escape
from zoneinfo import ZoneInfo

from ..domain.pricing import format_money
from ..timeutil import to_local

VIEW_WIDTH = 720
VIEW_HEIGHT = 260
PADDING_LEFT = 62
PADDING_RIGHT = 16
PADDING_TOP = 18
PADDING_BOTTOM = 34


@dataclass(frozen=True, slots=True)
class PricePoint:
    observed_at: datetime
    amount: Decimal
    label: str


def render_price_chart(
    points: list[PricePoint],
    *,
    currency: str,
    tz: ZoneInfo,
    threshold: Decimal | None = None,
    low: Decimal | None = None,
    title: str = "Observed price history",
) -> str:
    """Return a self-contained, responsive, accessible SVG string."""
    if not points:
        return (
            '<p class="chart-empty">No successful observations yet, so there is nothing '
            "to chart.</p>"
        )

    ordered = sorted(points, key=lambda p: p.observed_at)
    values = [float(p.amount) for p in ordered]
    candidates = list(values)
    if threshold is not None:
        candidates.append(float(threshold))
    y_min, y_max = min(candidates), max(candidates)
    if y_max == y_min:
        y_max = y_min + max(1.0, y_min * 0.05)
    span = y_max - y_min
    y_min -= span * 0.08
    y_max += span * 0.08

    plot_w = VIEW_WIDTH - PADDING_LEFT - PADDING_RIGHT
    plot_h = VIEW_HEIGHT - PADDING_TOP - PADDING_BOTTOM

    def x_at(index: int) -> float:
        if len(ordered) == 1:
            return PADDING_LEFT + plot_w / 2
        return PADDING_LEFT + plot_w * index / (len(ordered) - 1)

    def y_at(value: float) -> float:
        ratio = (value - y_min) / (y_max - y_min)
        return PADDING_TOP + plot_h * (1 - ratio)

    parts: list[str] = []
    # Horizontal gridlines + y labels
    for step in range(4):
        value = y_min + (y_max - y_min) * step / 3
        y = y_at(value)
        parts.append(
            f'<line class="grid" x1="{PADDING_LEFT}" y1="{y:.1f}" '
            f'x2="{VIEW_WIDTH - PADDING_RIGHT}" y2="{y:.1f}" />'
        )
        parts.append(
            f'<text class="axis" x="{PADDING_LEFT - 8}" y="{y + 4:.1f}" text-anchor="end">'
            f"{escape(format_money(Decimal(str(round(value, 2))), currency))}</text>"
        )

    if threshold is not None:
        y = y_at(float(threshold))
        if PADDING_TOP <= y <= PADDING_TOP + plot_h:
            parts.append(
                f'<line class="threshold" x1="{PADDING_LEFT}" y1="{y:.1f}" '
                f'x2="{VIEW_WIDTH - PADDING_RIGHT}" y2="{y:.1f}" />'
            )
            parts.append(
                f'<text class="axis threshold-label" x="{VIEW_WIDTH - PADDING_RIGHT}" '
                f'y="{y - 6:.1f}" text-anchor="end">Threshold</text>'
            )

    coords = [(x_at(i), y_at(v)) for i, v in enumerate(values)]
    path = " ".join(
        ("M" if i == 0 else "L") + f"{x:.1f},{y:.1f}" for i, (x, y) in enumerate(coords)
    )
    area = (
        path
        + f" L{coords[-1][0]:.1f},{PADDING_TOP + plot_h:.1f}"
        + f" L{coords[0][0]:.1f},{PADDING_TOP + plot_h:.1f} Z"
    )
    parts.append(f'<path class="area" d="{area}" />')
    parts.append(f'<path class="line" d="{path}" />')

    low_value = float(low) if low is not None else min(values)
    for (x, y), point in zip(coords, ordered, strict=True):
        is_low = abs(float(point.amount) - low_value) < 0.005
        cls = "dot dot-low" if is_low else "dot"
        stamp = to_local(point.observed_at, tz)
        stamp_text = stamp.strftime("%b %-d, %-I:%M %p") if stamp else ""
        parts.append(
            f'<circle class="{cls}" cx="{x:.1f}" cy="{y:.1f}" r="{4.5 if is_low else 3}">'
            f"<title>{escape(format_money(point.amount, currency))} — "
            f"{escape(stamp_text)} — {escape(point.label)}</title></circle>"
        )

    # X labels: first, middle, last only, so they never collide.
    label_indexes = {0, len(ordered) - 1}
    if len(ordered) > 2:
        label_indexes.add(len(ordered) // 2)
    for index in sorted(label_indexes):
        stamp = to_local(ordered[index].observed_at, tz)
        if stamp is None:
            continue
        anchor = "start" if index == 0 else ("end" if index == len(ordered) - 1 else "middle")
        x = x_at(index)
        if anchor == "start":
            x = PADDING_LEFT
        elif anchor == "end":
            x = VIEW_WIDTH - PADDING_RIGHT
        parts.append(
            f'<text class="axis" x="{x:.1f}" y="{VIEW_HEIGHT - 10}" text-anchor="{anchor}">'
            f"{escape(stamp.strftime('%b %-d'))}</text>"
        )

    description = (
        f"Line chart of {len(ordered)} observed fares in {currency}, "
        f"from {escape(format_money(Decimal(str(min(values))), currency))} to "
        f"{escape(format_money(Decimal(str(max(values))), currency))}. "
        "The same data is listed in the table below."
    )
    return (
        f'<svg class="price-chart" viewBox="0 0 {VIEW_WIDTH} {VIEW_HEIGHT}" '
        'preserveAspectRatio="xMidYMid meet" role="img" '
        f'aria-label="{escape(title)}. {description}">'
        f"<desc>{description}</desc>" + "".join(parts) + "</svg>"
    )
