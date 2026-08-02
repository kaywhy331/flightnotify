# FlightNotify - single-user flight price tracker.
# Runs unprivileged, keeps the SQLite database on a mounted volume, and binds
# to localhost on the host side via docker-compose port mapping.
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies first so application edits do not bust the layer cache.
COPY pyproject.toml README.md ./
COPY flightnotify/__init__.py flightnotify/__init__.py
RUN pip install --no-cache-dir .

COPY alembic.ini ./
COPY alembic ./alembic
COPY flightnotify ./flightnotify
RUN pip install --no-cache-dir --no-deps .

# Non-root, and the data directory is owned by that user so the volume mount
# is writable without privilege escalation.
RUN useradd --create-home --uid 10001 flightnotify \
    && mkdir -p /data \
    && chown -R flightnotify:flightnotify /data /app
USER flightnotify

ENV DATABASE_URL=sqlite:////data/flightnotify.db \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status==200 else 1)"

# `serve` applies pending migrations on startup (AUTO_MIGRATE=true by default),
# so a fresh volume never needs tables created by hand. APP_HOST is 0.0.0.0
# *inside* the container only; compose publishes it to 127.0.0.1 on the host.
CMD ["flightnotify", "serve", "--allow-external"]
