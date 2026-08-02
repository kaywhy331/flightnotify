"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from .. import __version__, migrations
from ..config import Settings, get_settings
from ..db import DatabaseUnavailableError, get_session_factory
from ..logging_setup import configure_logging
from ..services.bot import BotPoller
from ..services.scheduler import Scheduler
from .deps import STATIC_DIR, base_context, build_templates
from .routes import dashboard, settings_routes, trackers

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_format, settings.secret_values())

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        startup_error: str | None = None
        try:
            if settings.auto_migrate:
                migrations.ensure_schema(settings)
        except DatabaseUnavailableError as exc:
            startup_error = str(exc)
            log.error("database unavailable at startup")
        except Exception as exc:  # pragma: no cover - surfaced in the UI
            startup_error = (
                f"Database migrations failed: {exc}. No data was changed. "
                "Run `flightnotify migrate` manually to see the full error."
            )
            log.exception("migration failure at startup")
        app.state.startup_error = startup_error

        scheduler: Scheduler | None = None
        if settings.scheduler_enabled and startup_error is None:
            scheduler = Scheduler(get_session_factory(), settings)
            scheduler.start()
        app.state.scheduler = scheduler

        # The command bot is opt-in and refuses to start without a chat id to
        # authorise against; it logs the reason and leaves the app running.
        bot: BotPoller | None = None
        if settings.bot_enabled and startup_error is None:
            bot = BotPoller(get_session_factory(), settings)
            if not bot.start():
                bot = None
        app.state.bot = bot

        try:
            yield
        finally:
            if bot is not None:
                bot.stop()
            if scheduler is not None:
                scheduler.stop()

    app = FastAPI(
        title="FlightNotify",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.resolved_secret_key(),
        session_cookie="flightnotify_session",
        same_site="lax",
        https_only=False,  # bound to localhost by default
        max_age=14 * 24 * 3600,
    )
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    templates = build_templates()
    app.state.templates = templates
    app.state.settings = settings

    app.include_router(dashboard.router)
    app.include_router(trackers.router)
    app.include_router(settings_routes.router)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(
        request: Request, exc: StarletteHTTPException
    ) -> HTMLResponse | JSONResponse:
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        context = base_context(
            request,
            status_code=exc.status_code,
            detail=str(exc.detail),
            title="Something went wrong",
        )
        return templates.TemplateResponse(
            request, "error.html", context, status_code=exc.status_code
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(
        request: Request, exc: RequestValidationError
    ) -> HTMLResponse | JSONResponse:
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "Invalid request."}, status_code=422)
        context = base_context(
            request,
            status_code=422,
            detail=(
                "That request could not be understood, so nothing was changed. "
                "Stored data is safe. Go back and try again."
            ),
            title="Invalid request",
        )
        return templates.TemplateResponse(request, "error.html", context, status_code=422)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, object]:
        return {
            "status": "error" if getattr(app.state, "startup_error", None) else "ok",
            "version": __version__,
            "scheduler_running": bool(
                getattr(app.state, "scheduler", None) and app.state.scheduler.running
            ),
            "bot_running": bool(getattr(app.state, "bot", None) and app.state.bot.running),
        }

    return app


app = create_app()
