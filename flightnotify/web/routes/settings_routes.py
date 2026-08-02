"""Settings screen: provider status, Telegram wiring and defaults."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import db_session
from ...forms import CURRENCY_CHOICES, MARKET_CHOICES
from ...providers.factory import get_provider
from ...services.messages import build_test_message
from ...services.quota import QuotaManager
from ...services.scheduler import scheduler_health
from ...services.settings_service import (
    KEY_DEFAULT_CURRENCY,
    KEY_DEFAULT_MARKET,
    KEY_TELEGRAM_CHAT_ID,
    get_chat_id,
    set_setting,
)
from ...services.telegram import TelegramNotifier
from ...timeutil import utcnow
from .. import viewmodels
from ..deps import base_context, flash, require_csrf

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, session: Session = Depends(db_session)) -> HTMLResponse:
    settings = get_settings()
    quota_manager = QuotaManager(settings)
    context = base_context(
        request,
        title="Settings",
        nav="settings",
        quota=quota_manager.snapshot(session),
        telegram=viewmodels.telegram_view(session, settings),
        scheduler=scheduler_health(session, settings),
        bot=viewmodels.bot_view(session, settings),
        setup=viewmodels.setup_state(session, settings),
        market_choices=MARKET_CHOICES,
        currency_choices=CURRENCY_CHOICES,
        discovered=request.session.pop("discovered_chats", []),
    )
    return request.app.state.templates.TemplateResponse(request, "settings.html", context)


@router.post(
    "/settings/quota/refresh",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
def refresh_quota(request: Request, session: Session = Depends(db_session)) -> RedirectResponse:
    settings = get_settings()
    if not settings.has_provider_credentials:
        flash(
            request,
            "No SerpApi key is configured, so quota could not be read. Add "
            "SERPAPI_API_KEY to .env and restart.",
            "danger",
        )
        return RedirectResponse("/settings", status_code=303)
    manager = QuotaManager(settings)
    snapshot = manager.sync_from_provider(session, get_provider(settings))
    session.commit()
    if snapshot.sync_error:
        flash(request, snapshot.sync_error, "danger")
    else:
        flash(
            request,
            f"Provider quota refreshed: {snapshot.provider_left} searches left on "
            f"{snapshot.provider_plan or 'the current plan'}. Reading account status is "
            "free and does not consume a search.",
            "success",
        )
    return RedirectResponse("/settings", status_code=303)


@router.post(
    "/settings/telegram/discover",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
def discover_chat(request: Request, session: Session = Depends(db_session)) -> RedirectResponse:
    settings = get_settings()
    notifier = TelegramNotifier(settings)
    if not notifier.is_configured():
        flash(
            request,
            "TELEGRAM_BOT_TOKEN is not set, so no chat could be discovered. Create a bot "
            "with @BotFather, put the token in .env and restart FlightNotify.",
            "danger",
        )
        return RedirectResponse("/settings", status_code=303)

    chats, result = notifier.discover_chats()
    if not chats:
        flash(request, result.user_message, "danger")
        return RedirectResponse("/settings", status_code=303)

    request.session["discovered_chats"] = [
        {
            "chat_id": str(chat.chat_id),
            "name": chat.display_name,
            "last_text": chat.last_text or "",
        }
        for chat in chats[:5]
    ]
    flash(
        request,
        f"Found {len(chats)} recent direct chat(s). Choose the one alerts should go to.",
        "success",
    )
    return RedirectResponse("/settings", status_code=303)


@router.post(
    "/settings/telegram/chat",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def save_chat(request: Request, session: Session = Depends(db_session)) -> RedirectResponse:
    form = await request.form()
    chat_id = str(form.get("chat_id", "")).strip()
    if not chat_id:
        flash(request, "No chat id was supplied, so nothing was changed.", "danger")
        return RedirectResponse("/settings", status_code=303)
    set_setting(session, KEY_TELEGRAM_CHAT_ID, chat_id)
    session.commit()
    flash(request, f"Alerts will be sent to chat {chat_id}.", "success")
    return RedirectResponse("/settings", status_code=303)


@router.post(
    "/settings/telegram/test",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
def test_message(request: Request, session: Session = Depends(db_session)) -> RedirectResponse:
    settings = get_settings()
    notifier = TelegramNotifier(settings)
    chat_id = get_chat_id(session, settings)
    if not notifier.is_configured():
        flash(
            request,
            "TELEGRAM_BOT_TOKEN is not set, so no test message was sent.",
            "danger",
        )
        return RedirectResponse("/settings", status_code=303)
    if not chat_id:
        flash(
            request,
            "No Telegram chat is connected. Send /start to your bot, then use Discover chat.",
            "danger",
        )
        return RedirectResponse("/settings", status_code=303)

    identity = notifier.get_me()
    if not identity.ok:
        flash(request, identity.user_message, "danger")
        return RedirectResponse("/settings", status_code=303)

    result = notifier.send_message(
        chat_id, build_test_message(settings.tzinfo, utcnow()), disable_preview=True
    )
    flash(
        request,
        f"Test message sent to chat {chat_id}." if result.ok else result.user_message,
        "success" if result.ok else "danger",
    )
    return RedirectResponse("/settings", status_code=303)


@router.post(
    "/settings/defaults",
    dependencies=[Depends(require_csrf)],
    response_model=None,
)
async def save_defaults(
    request: Request, session: Session = Depends(db_session)
) -> RedirectResponse:
    form = await request.form()
    market = str(form.get("default_market", "")).strip().lower()
    currency = str(form.get("default_currency", "")).strip().upper()
    problems = []
    if len(market) != 2 or not market.isalpha():
        problems.append("Country market must be a 2-letter code.")
    if len(currency) != 3 or not currency.isalpha():
        problems.append("Currency must be a 3-letter code.")
    if problems:
        flash(request, " ".join(problems) + " Nothing was changed.", "danger")
        return RedirectResponse("/settings", status_code=303)
    set_setting(session, KEY_DEFAULT_MARKET, market)
    set_setting(session, KEY_DEFAULT_CURRENCY, currency)
    session.commit()
    flash(request, "Defaults for new trackers saved.", "success")
    return RedirectResponse("/settings", status_code=303)
