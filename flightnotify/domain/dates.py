"""Flexible-window date-pair generation and deterministic fair ordering."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import date, timedelta

#: Hard ceiling on generated combinations. Above this the window is refused with
#: actionable guidance rather than quietly truncated.
MAX_CANDIDATES = 2000


@dataclass(frozen=True, slots=True)
class DatePair:
    outbound: date
    inbound: date

    @property
    def nights(self) -> int:
        return (self.inbound - self.outbound).days


class DateWindowError(ValueError):
    """The requested window cannot produce any valid outbound/return pair."""


def bisection_order(n: int) -> list[int]:
    """Indices 0..n-1 ordered by recursive bisection.

    Yields the middle of the range first, then the middles of each half, and so
    on. Checking candidates in this order samples across the whole window early
    instead of exhausting the earliest dates first, and it is fully
    deterministic so coverage survives a restart.

    >>> bisection_order(7)
    [3, 1, 5, 0, 2, 4, 6]
    """
    if n <= 0:
        return []
    order: list[int] = []
    queue: deque[tuple[int, int]] = deque([(0, n - 1)])
    while queue:
        lo, hi = queue.popleft()
        if lo > hi:
            continue
        mid = (lo + hi) // 2
        order.append(mid)
        if lo <= mid - 1:
            queue.append((lo, mid - 1))
        if mid + 1 <= hi:
            queue.append((mid + 1, hi))
    return order


def _daterange(start: date, end: date) -> list[date]:
    if end < start:
        return []
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def generate_pairs(
    *,
    outbound_start: date,
    outbound_end: date,
    return_start: date | None = None,
    return_end: date | None = None,
    min_nights: int | None = None,
    max_nights: int | None = None,
    not_before: date | None = None,
    max_candidates: int = MAX_CANDIDATES,
) -> list[DatePair]:
    """Build every valid round-trip date pair for a custom flexible window.

    Exactly one of (``return_start``/``return_end``) or
    (``min_nights``/``max_nights``) drives the return leg; supplying both simply
    applies the nights range as an extra filter on the return window.

    Raises :class:`DateWindowError` when the window yields nothing usable or
    exceeds ``max_candidates``.
    """
    if outbound_end < outbound_start:
        raise DateWindowError("The outbound window ends before it starts.")

    if not_before is not None:
        outbound_start = max(outbound_start, not_before)
        if outbound_end < outbound_start:
            raise DateWindowError("The whole outbound window is in the past. Choose future dates.")

    if return_start is None and min_nights is None:
        raise DateWindowError(
            "Provide either a return date window or a minimum and maximum trip length."
        )

    if min_nights is not None and max_nights is not None and max_nights < min_nights:
        raise DateWindowError("Maximum trip length is shorter than the minimum.")

    if return_start is not None and return_end is not None and return_end < return_start:
        raise DateWindowError("The return window ends before it starts.")

    pairs: list[DatePair] = []
    for outbound in _daterange(outbound_start, outbound_end):
        if return_start is not None and return_end is not None:
            candidates = _daterange(max(return_start, outbound + timedelta(days=1)), return_end)
        else:
            lo = min_nights if min_nights is not None else 1
            hi = max_nights if max_nights is not None else lo
            candidates = [outbound + timedelta(days=n) for n in range(max(lo, 1), hi + 1)]

        for inbound in candidates:
            nights = (inbound - outbound).days
            if nights < 1:
                continue
            if min_nights is not None and nights < min_nights:
                continue
            if max_nights is not None and nights > max_nights:
                continue
            pairs.append(DatePair(outbound, inbound))
            if len(pairs) > max_candidates:
                raise DateWindowError(
                    f"This window produces more than {max_candidates} date combinations. "
                    "Narrow the outbound window or tighten the trip length."
                )

    if not pairs:
        raise DateWindowError(
            "No valid outbound/return combination exists for this window. "
            "Check that returns can fall after departures and that the trip "
            "length fits inside the return window."
        )

    pairs.sort(key=lambda p: (p.outbound, p.inbound))
    return pairs


def ordered_pairs(pairs: list[DatePair]) -> list[tuple[int, DatePair]]:
    """Attach the deterministic fair queue position to each pair."""
    order = bisection_order(len(pairs))
    return [(position, pairs[index]) for position, index in enumerate(order)]


def flexible_preset_month(target_month: int, target_year: int, today: date) -> tuple[int, int]:
    """Validate a flexible-preset month against the provider's 6-month horizon.

    Google Travel Explore accepts ``month`` 1-12 and only looks ahead six
    months, so a month outside that horizon is rejected here rather than
    producing an empty provider response.
    """
    if not 1 <= target_month <= 12:
        raise DateWindowError("Choose a month between January and December.")
    first_of_target = date(target_year, target_month, 1)
    horizon = date(today.year, today.month, 1)
    months_ahead = (first_of_target.year - horizon.year) * 12 + (
        first_of_target.month - horizon.month
    )
    if months_ahead < 0:
        raise DateWindowError("That month is already in the past.")
    if months_ahead > 6:
        raise DateWindowError(
            "Google Travel Explore only supports flexible months within the next "
            "6 months. Pick a nearer month, or use a custom flexible window."
        )
    return target_month, target_year
