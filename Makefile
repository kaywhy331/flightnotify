# FlightNotify - operator shortcuts. Every target is a thin wrapper around a
# documented command; nothing here is required to run the application.
.DEFAULT_GOAL := help
PY ?= .venv/bin/python
PIP ?= .venv/bin/pip

.PHONY: help venv setup migrate dev serve scheduler check-once test test-live lint format typecheck check backup failures status docker-build docker-up docker-down docker-logs clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

venv: ## Create the virtualenv and install dependencies
	python3 -m venv .venv
	$(PIP) install --upgrade pip
	$(PIP) install -e ".[dev]"

setup: ## First run: create .env from the example and migrate
	$(PY) -m flightnotify.cli setup

migrate: ## Apply database migrations
	$(PY) -m flightnotify.cli migrate

dev: ## Development server with auto-reload
	$(PY) -m flightnotify.cli serve --reload

serve: ## Production-like local server (single worker, localhost)
	$(PY) -m flightnotify.cli serve

scheduler: ## Run only the scheduler loop
	$(PY) -m flightnotify.cli scheduler

check-once: ## Run every due tracker once and exit (cron-friendly)
	$(PY) -m flightnotify.cli check-once

status: ## Show quota, scheduler and setup state
	$(PY) -m flightnotify.cli status

backup: ## Back up the SQLite database into ./backups
	$(PY) -m flightnotify.cli backup

failures: ## Show recent failed checks and undelivered alerts
	$(PY) -m flightnotify.cli failures

test: ## Run the fixture-based test suite
	$(PY) -m pytest

test-live: ## Run the opt-in live checks (CONSUMES PROVIDER SEARCHES)
	FLIGHTNOTIFY_LIVE_TESTS=1 $(PY) -m pytest -m live tests/live -s

lint: ## Lint
	$(PY) -m ruff check .

format: ## Auto-format
	$(PY) -m ruff format .

typecheck: ## Static type check
	$(PY) -m mypy

check: lint typecheck ## Lint, types and tests - what CI runs
	$(PY) -m ruff format --check .
	$(PY) -m alembic check
	$(PY) -m pytest

docker-build: ## Build the container image
	docker compose build

docker-up: ## Start with Docker Compose (http://127.0.0.1:8000)
	docker compose up -d

docker-down: ## Stop the container (the data volume is kept)
	docker compose down

docker-logs: ## Follow container logs
	docker compose logs -f

golden: ## Regenerate the Python->Worker behavioural golden vectors
	$(PY) -m tests.golden.generate_vectors > worker/test/golden/vectors.json

worker-install: ## Install the Cloudflare Worker toolchain
	cd worker && npm install

worker-check: ## Typecheck, test and build the Worker (no Cloudflare account needed)
	cd worker && npx wrangler types && npx tsc --noEmit
	cd worker && npx vitest run
	cd worker && npx vitest run --config vitest.workers.config.ts
	cd worker && npx wrangler deploy --dry-run --outdir=dist

worker-dev: ## Run the Worker locally against a local D1 (http://localhost:8788)
	cd worker && npx wrangler dev --local --port 8788 --test-scheduled

clean: ## Remove caches (never the database)
	rm -rf .pytest_cache .mypy_cache .ruff_cache htmlcov .coverage
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
