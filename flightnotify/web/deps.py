"""Template environment, CSRF protection and flash messaging."""

from __future__ import annotations

import secrets
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from fastapi.templating import Jinja2Templates

from ..config import get_settings
from ..domain.pricing import format_money
from ..enums import (
    ALERT_TYPE_LABELS,
    CABIN_LABELS,
    DATE_MODE_LABELS,
    DELIVERY_STATE_LABELS,
    FLEX_DURATION_LABELS,
    RUN_STATUS_LABELS,
    STOPS_LABELS,
)
from ..services.planner import interval_label
from ..timeutil import format_local, humanize_delta, to_local

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"

CSRF_SESSION_KEY = "csrf_token"
FLASH_SESSION_KEY = "flashes"


def build_templates() -> Jinja2Templates:
    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
    settings = get_settings()
    tz = settings.tzinfo

    def _money(value: Decimal | None, currency: str = "USD") -> str:
        return format_money(value, currency)

    def _datetime(value: datetime | None, fmt: str = "%b %-d, %-I:%M %p %Z") -> str:
        return format_local(value, tz, fmt)

    def _date(value: date | None, fmt: str = "%b %-d, %Y") -> str:
        return value.strftime(fmt) if value else "-"

    def _relative(value: datetime | None) -> str:
        return humanize_delta(value)

    def _iso(value: datetime | None) -> str:
        local = to_local(value, tz)
        return local.isoformat() if local else ""

    templates.env.filters["money"] = _money
    templates.env.filters["dt"] = _datetime
    templates.env.filters["d"] = _date
    templates.env.filters["relative"] = _relative
    templates.env.filters["iso"] = _iso
    templates.env.filters["interval"] = interval_label
    templates.env.globals.update(
        cabin_labels=CABIN_LABELS,
        stops_labels=STOPS_LABELS,
        date_mode_labels=DATE_MODE_LABELS,
        flex_duration_labels=FLEX_DURATION_LABELS,
        run_status_labels=RUN_STATUS_LABELS,
        delivery_state_labels=DELIVERY_STATE_LABELS,
        alert_type_labels=ALERT_TYPE_LABELS,
        app_timezone=settings.app_timezone,
    )
    templates.env.trim_blocks = True
    templates.env.lstrip_blocks = True
    return templates


# --------------------------------------------------------------------- CSRF
def get_csrf_token(request: Request) -> str:
    token = request.session.get(CSRF_SESSION_KEY)
    if not token:
        token = secrets.token_urlsafe(32)
        request.session[CSRF_SESSION_KEY] = token
    return token


async def require_csrf(request: Request) -> None:
    """Reject a state-changing request without a matching token."""
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    expected = request.session.get(CSRF_SESSION_KEY)
    form = await request.form()
    supplied = form.get("csrf_token") or request.headers.get("x-csrf-token")
    if not expected or not supplied or not secrets.compare_digest(str(supplied), str(expected)):
        raise HTTPException(
            status_code=400,
            detail=(
                "This form could not be verified, so nothing was changed. Stored data "
                "is safe. Reload the page and try again."
            ),
        )


# -------------------------------------------------------------------- Flash
def flash(request: Request, message: str, level: str = "success") -> None:
    messages: list[dict[str, str]] = list(request.session.get(FLASH_SESSION_KEY, []))
    messages.append({"message": message, "level": level})
    request.session[FLASH_SESSION_KEY] = messages[-6:]


def pop_flashes(request: Request) -> list[dict[str, str]]:
    messages = list(request.session.get(FLASH_SESSION_KEY, []))
    if messages:
        request.session[FLASH_SESSION_KEY] = []
    return messages


def base_context(request: Request, **extra: Any) -> dict[str, Any]:
    settings = get_settings()
    context: dict[str, Any] = {
        "request": request,
        "csrf_token": get_csrf_token(request),
        "flashes": pop_flashes(request),
        "settings_public": {
            "timezone": settings.app_timezone,
            "default_currency": settings.default_currency,
            "default_market": settings.default_market,
            "has_provider": settings.has_provider_credentials,
            "has_telegram": settings.has_telegram_token,
            "price_scope": settings.serpapi_price_scope.value,
            "monthly_limit": settings.serpapi_monthly_search_limit,
            "reserve": settings.serpapi_reserve_searches,
        },
    }
    context.update(extra)
    return context
