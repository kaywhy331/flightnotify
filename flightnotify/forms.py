"""Tracker form parsing and validation.

Errors are returned as a ``{field_name: message}`` mapping so templates can put
each message next to its input *and* build an accessible error summary that
links back to the offending control.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from .domain.dates import DateWindowError, generate_pairs
from .enums import Cabin, DateMode, FlexDuration, StopsPreference, ThresholdBasis
from .providers.serpapi.provider import validate_party
from .services.planner import SCHEDULE_CHOICES

IATA_RE = re.compile(r"^[A-Z]{3}$")
MARKET_RE = re.compile(r"^[a-z]{2}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
AIRLINES_RE = re.compile(r"^[A-Z0-9]{2}(,[A-Z0-9]{2})*$")

MAX_MARKETS = 4
MAX_CANDIDATES_PER_RUN = 10
ALLOWED_INTERVALS = {value for value, _ in SCHEDULE_CHOICES}

#: Country markets offered in the UI. SerpApi accepts any two-letter `gl`, so
#: this is a convenience list rather than a restriction.
MARKET_CHOICES: tuple[tuple[str, str], ...] = (
    ("us", "United States"),
    ("gb", "United Kingdom"),
    ("ca", "Canada"),
    ("au", "Australia"),
    ("de", "Germany"),
    ("fr", "France"),
    ("es", "Spain"),
    ("in", "India"),
    ("sg", "Singapore"),
    ("jp", "Japan"),
    ("br", "Brazil"),
    ("mx", "Mexico"),
)

CURRENCY_CHOICES: tuple[str, ...] = (
    "USD",
    "EUR",
    "GBP",
    "CAD",
    "AUD",
    "JPY",
    "SGD",
    "INR",
    "BRL",
    "MXN",
)


@dataclass(slots=True)
class TrackerFormData:
    name: str = ""
    origin: str = ""
    destination: str = ""
    adults: int = 1
    children: int = 0
    infants_in_seat: int = 0
    infants_on_lap: int = 0
    cabin: str = Cabin.ECONOMY.value
    stops: str = StopsPreference.ANY.value
    include_airlines: str | None = None
    exclude_airlines: str | None = None
    currency: str = "USD"
    markets: list[str] = field(default_factory=lambda: ["us"])
    date_mode: str = DateMode.EXACT.value
    outbound_date: date | None = None
    return_date: date | None = None
    flex_month: int | None = None
    flex_year: int | None = None
    flex_duration: str | None = None
    window_outbound_start: date | None = None
    window_outbound_end: date | None = None
    window_return_start: date | None = None
    window_return_end: date | None = None
    min_nights: int | None = None
    max_nights: int | None = None
    threshold_amount: Decimal = Decimal("0")
    threshold_basis: str = ThresholdBasis.PARTY.value
    alert_on_threshold: bool = True
    alert_on_new_low: bool = True
    min_drop_absolute: Decimal | None = None
    min_drop_percent: Decimal | None = None
    cooldown_minutes: int = 360
    check_interval_minutes: int = 720
    candidates_per_run: int = 1
    sampled_mode_ack: bool = False

    #: Populated during validation for the budget estimate.
    candidate_count: int = 0


def _text(raw: dict[str, Any], key: str, default: str = "") -> str:
    value = raw.get(key, default)
    if isinstance(value, list):
        value = value[0] if value else default
    return str(value).strip()


def _int(raw: dict[str, Any], key: str, default: int) -> tuple[int, bool]:
    text = _text(raw, key)
    if text == "":
        return default, True
    try:
        return int(text), True
    except ValueError:
        return default, False


def _optional_int(raw: dict[str, Any], key: str) -> tuple[int | None, bool]:
    text = _text(raw, key)
    if text == "":
        return None, True
    try:
        return int(text), True
    except ValueError:
        return None, False


def _decimal(raw: dict[str, Any], key: str) -> tuple[Decimal | None, bool]:
    text = _text(raw, key).replace(",", "")
    if text == "":
        return None, True
    try:
        return Decimal(text), True
    except InvalidOperation:
        return None, False


def _date(raw: dict[str, Any], key: str) -> tuple[date | None, bool]:
    text = _text(raw, key)
    if text == "":
        return None, True
    try:
        return date.fromisoformat(text), True
    except ValueError:
        return None, False


def _bool(raw: dict[str, Any], key: str) -> bool:
    value = raw.get(key)
    if isinstance(value, list):
        value = value[0] if value else None
    return str(value).lower() in {"1", "true", "on", "yes"}


def parse_tracker_form(
    raw: dict[str, Any], *, today: date, markets_raw: list[str] | None = None
) -> tuple[TrackerFormData, dict[str, str]]:
    """Parse and validate a tracker form. Never raises on bad input."""
    errors: dict[str, str] = {}
    data = TrackerFormData()

    # --- identity ---------------------------------------------------------
    data.name = _text(raw, "name")
    if not data.name:
        errors["name"] = "Give this tracker a name so you can recognise it later."
    elif len(data.name) > 120:
        errors["name"] = "Keep the name to 120 characters or fewer."

    # --- route ------------------------------------------------------------
    data.origin = _text(raw, "origin").upper()
    data.destination = _text(raw, "destination").upper()
    if not IATA_RE.match(data.origin):
        errors["origin"] = "Enter a 3-letter IATA airport code, for example SFO."
    if not IATA_RE.match(data.destination):
        errors["destination"] = "Enter a 3-letter IATA airport code, for example NRT."
    if "origin" not in errors and "destination" not in errors and data.origin == data.destination:
        errors["destination"] = "Origin and destination must be different airports."

    # --- passengers -------------------------------------------------------
    data.adults, ok_adults = _int(raw, "adults", 1)
    data.children, ok_children = _int(raw, "children", 0)
    data.infants_in_seat, ok_seat = _int(raw, "infants_in_seat", 0)
    data.infants_on_lap, ok_lap = _int(raw, "infants_on_lap", 0)
    if not all((ok_adults, ok_children, ok_seat, ok_lap)):
        errors["adults"] = "Passenger counts must be whole numbers."
    else:
        problems = validate_party(
            data.adults, data.children, data.infants_in_seat, data.infants_on_lap
        )
        if problems:
            errors["adults"] = " ".join(problems)

    # --- cabin / stops ----------------------------------------------------
    data.cabin = _text(raw, "cabin", Cabin.ECONOMY.value)
    if data.cabin not in {c.value for c in Cabin}:
        errors["cabin"] = "Choose a supported cabin."
        data.cabin = Cabin.ECONOMY.value
    data.stops = _text(raw, "stops", StopsPreference.ANY.value)
    if data.stops not in {s.value for s in StopsPreference}:
        errors["stops"] = "Choose a supported stops preference."
        data.stops = StopsPreference.ANY.value

    include = _text(raw, "include_airlines").upper().replace(" ", "")
    exclude = _text(raw, "exclude_airlines").upper().replace(" ", "")
    if include and not AIRLINES_RE.match(include):
        errors["include_airlines"] = (
            "Use comma-separated 2-character airline codes, for example UA,NH."
        )
    if exclude and not AIRLINES_RE.match(exclude):
        errors["exclude_airlines"] = (
            "Use comma-separated 2-character airline codes, for example UA,NH."
        )
    if include and exclude:
        errors["exclude_airlines"] = (
            "SerpApi does not accept included and excluded airlines together. Use one."
        )
    data.include_airlines = include or None
    data.exclude_airlines = exclude or None

    # --- comparison -------------------------------------------------------
    data.currency = _text(raw, "currency", "USD").upper()
    if not CURRENCY_RE.match(data.currency):
        errors["currency"] = "Enter a 3-letter currency code, for example USD."

    markets = markets_raw if markets_raw is not None else raw.get("markets") or []
    if isinstance(markets, str):
        markets = [markets]
    cleaned: list[str] = []
    for market in markets:
        code = str(market).strip().lower()
        if code and code not in cleaned:
            cleaned.append(code)
    if not cleaned:
        errors["markets"] = "Select at least one country market."
    elif len(cleaned) > MAX_MARKETS:
        errors["markets"] = (
            f"Select at most {MAX_MARKETS} country markets - each one costs a provider "
            "search on every scan."
        )
    elif any(not MARKET_RE.match(code) for code in cleaned):
        errors["markets"] = "Country markets must be 2-letter codes, for example us."
    data.markets = cleaned or ["us"]

    # --- dates ------------------------------------------------------------
    data.date_mode = _text(raw, "date_mode", DateMode.EXACT.value)
    if data.date_mode not in {m.value for m in DateMode}:
        errors["date_mode"] = "Choose a supported date mode."
        data.date_mode = DateMode.EXACT.value

    _validate_dates(raw, data, errors, today)

    # --- threshold --------------------------------------------------------
    threshold, ok_threshold = _decimal(raw, "threshold_amount")
    if not ok_threshold:
        errors["threshold_amount"] = "Enter the threshold as a number, for example 1200."
    elif threshold is None:
        errors["threshold_amount"] = "Enter the price that should trigger an alert."
    elif threshold <= 0:
        errors["threshold_amount"] = "The threshold must be greater than zero."
    else:
        data.threshold_amount = threshold

    data.threshold_basis = _text(raw, "threshold_basis", ThresholdBasis.PARTY.value)
    if data.threshold_basis not in {b.value for b in ThresholdBasis}:
        errors["threshold_basis"] = "Choose whether the threshold is per traveler or for the party."
        data.threshold_basis = ThresholdBasis.PARTY.value

    # --- alerts -----------------------------------------------------------
    data.alert_on_threshold = _bool(raw, "alert_on_threshold")
    data.alert_on_new_low = _bool(raw, "alert_on_new_low")
    if not data.alert_on_threshold and not data.alert_on_new_low:
        errors["alert_on_threshold"] = (
            "Turn on at least one alert type, or the tracker will never notify you."
        )

    drop_abs, ok_abs = _decimal(raw, "min_drop_absolute")
    if not ok_abs:
        errors["min_drop_absolute"] = "Enter a number, or leave blank."
    elif drop_abs is not None and drop_abs < 0:
        errors["min_drop_absolute"] = "A minimum drop cannot be negative."
    else:
        data.min_drop_absolute = drop_abs

    drop_pct, ok_pct = _decimal(raw, "min_drop_percent")
    if not ok_pct:
        errors["min_drop_percent"] = "Enter a number, or leave blank."
    elif drop_pct is not None and not (0 <= drop_pct <= 100):
        errors["min_drop_percent"] = "Enter a percentage between 0 and 100."
    else:
        data.min_drop_percent = drop_pct

    cooldown, ok_cooldown = _int(raw, "cooldown_minutes", 360)
    if not ok_cooldown or cooldown < 0:
        errors["cooldown_minutes"] = "Enter the cooldown in whole minutes (0 or more)."
    else:
        data.cooldown_minutes = cooldown

    # --- schedule ---------------------------------------------------------
    interval, ok_interval = _int(raw, "check_interval_minutes", 720)
    if not ok_interval or interval not in ALLOWED_INTERVALS:
        errors["check_interval_minutes"] = "Choose one of the offered check frequencies."
    else:
        data.check_interval_minutes = interval

    per_run, ok_per_run = _int(raw, "candidates_per_run", 1)
    if not ok_per_run or not (1 <= per_run <= MAX_CANDIDATES_PER_RUN):
        errors["candidates_per_run"] = (
            f"Check between 1 and {MAX_CANDIDATES_PER_RUN} date combinations per run."
        )
    else:
        data.candidates_per_run = per_run

    data.sampled_mode_ack = _bool(raw, "sampled_mode_ack")

    return data, errors


def _validate_dates(
    raw: dict[str, Any], data: TrackerFormData, errors: dict[str, str], today: date
) -> None:
    mode = DateMode(data.date_mode)

    if mode is DateMode.EXACT:
        data.outbound_date, ok_out = _date(raw, "outbound_date")
        data.return_date, ok_ret = _date(raw, "return_date")
        if not ok_out:
            errors["outbound_date"] = "Enter the outbound date as YYYY-MM-DD."
        elif data.outbound_date is None:
            errors["outbound_date"] = "Choose an outbound date."
        elif data.outbound_date < today:
            errors["outbound_date"] = "The outbound date is in the past. Choose a future date."
        if not ok_ret:
            errors["return_date"] = "Enter the return date as YYYY-MM-DD."
        elif data.return_date is None:
            errors["return_date"] = "Choose a return date - FlightNotify tracks round trips."
        elif data.outbound_date and data.return_date <= data.outbound_date:
            errors["return_date"] = "The return date must be after the outbound date."
        return

    if mode is DateMode.FLEXIBLE_PRESET:
        data.flex_month, ok_month = _optional_int(raw, "flex_month")
        data.flex_duration = _text(raw, "flex_duration") or None
        if not ok_month or data.flex_month is None:
            errors["flex_month"] = "Choose the travel month."
        elif not 1 <= data.flex_month <= 12:
            errors["flex_month"] = "Choose a month between January and December."
        else:
            # Google Travel Explore only looks ahead six months.
            year = today.year if data.flex_month >= today.month else today.year + 1
            data.flex_year = year
            months_ahead = (year - today.year) * 12 + (data.flex_month - today.month)
            if months_ahead > 6:
                errors["flex_month"] = (
                    "Google Travel Explore supports flexible months only within the next "
                    "6 months. Pick a nearer month, or use a custom flexible window."
                )
        if data.flex_duration not in {d.value for d in FlexDuration}:
            errors["flex_duration"] = "Choose a supported trip length."
            data.flex_duration = None
        return

    # Custom flexible window
    data.window_outbound_start, ok_wos = _date(raw, "window_outbound_start")
    data.window_outbound_end, ok_woe = _date(raw, "window_outbound_end")
    data.window_return_start, ok_wrs = _date(raw, "window_return_start")
    data.window_return_end, ok_wre = _date(raw, "window_return_end")
    data.min_nights, ok_min = _optional_int(raw, "min_nights")
    data.max_nights, ok_max = _optional_int(raw, "max_nights")

    if not (ok_wos and ok_woe and ok_wrs and ok_wre):
        errors["window_outbound_start"] = "Enter window dates as YYYY-MM-DD."
        return
    if not (ok_min and ok_max):
        errors["min_nights"] = "Trip length must be a whole number of nights."
        return

    if data.window_outbound_start is None or data.window_outbound_end is None:
        errors["window_outbound_start"] = "Choose the first and last possible outbound date."
        return
    if data.window_outbound_end < data.window_outbound_start:
        errors["window_outbound_end"] = "The outbound window ends before it starts."
        return
    if data.window_outbound_end < today:
        errors["window_outbound_end"] = "The whole outbound window is in the past."
        return

    has_return_window = data.window_return_start is not None and data.window_return_end is not None
    has_nights = data.min_nights is not None or data.max_nights is not None
    if not has_return_window and not has_nights:
        errors["window_return_start"] = (
            "Give either a return date window or a minimum and maximum trip length."
        )
        return
    if data.min_nights is not None and data.min_nights < 1:
        errors["min_nights"] = "A round trip needs at least one night."
        return
    if (
        data.min_nights is not None
        and data.max_nights is not None
        and data.max_nights < data.min_nights
    ):
        errors["max_nights"] = "Maximum trip length is shorter than the minimum."
        return

    try:
        pairs = generate_pairs(
            outbound_start=data.window_outbound_start,
            outbound_end=data.window_outbound_end,
            return_start=data.window_return_start,
            return_end=data.window_return_end,
            min_nights=data.min_nights,
            max_nights=data.max_nights,
            not_before=today,
        )
    except DateWindowError as exc:
        errors["window_outbound_start"] = str(exc)
        return
    data.candidate_count = len(pairs)
