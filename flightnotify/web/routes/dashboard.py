"""Dashboard screen."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from ...config import get_settings
from ...db import db_session
from ...services.quota import QuotaManager
from .. import viewmodels
from ..deps import base_context

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request, session: Session = Depends(db_session)) -> HTMLResponse:
    settings = get_settings()
    data = viewmodels.dashboard_data(session, settings, QuotaManager(settings))
    context = base_context(
        request,
        title="Dashboard",
        nav="dashboard",
        startup_error=getattr(request.app.state, "startup_error", None),
        **data,
    )
    return request.app.state.templates.TemplateResponse(request, "dashboard.html", context)
