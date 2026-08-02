"""Credential containment and the operator command line."""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path

import pytest

from flightnotify import cli, config
from flightnotify.config import PROJECT_ROOT
from flightnotify.enums import RunTrigger
from flightnotify.logging_setup import RedactionFilter, configure_logging, redact, register_secret
from flightnotify.models import AlertEvent, AppSetting, FareObservation, SearchRun
from flightnotify.providers.serpapi import SerpApiProvider
from flightnotify.services.search import SearchService
from tests.conftest import json_transport

REAL_LOOKING_KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"
REAL_LOOKING_TOKEN = "8123456789:AAHfakefakefakefakefakefakefakefakeZ"


# ------------------------------------------------------------- redaction
def test_registered_secret_is_masked_everywhere():
    register_secret(REAL_LOOKING_KEY)
    assert REAL_LOOKING_KEY not in redact(
        f"calling https://serpapi.com/search?api_key={REAL_LOOKING_KEY}"
    )


def test_telegram_token_shape_is_masked_without_registration():
    text = redact(f"POST https://api.telegram.org/bot{REAL_LOOKING_TOKEN}/sendMessage")
    assert REAL_LOOKING_TOKEN not in text
    assert "[REDACTED" in text


def test_api_key_query_parameter_is_masked_without_registration():
    text = redact("GET /search.json?engine=google_flights&api_key=zzzsecretzzz&gl=us")
    assert "zzzsecretzzz" not in text
    assert "gl=us" in text


def test_log_records_pass_through_the_filter(caplog):
    register_secret(REAL_LOOKING_KEY)
    log = logging.getLogger("flightnotify.test")
    log.addFilter(RedactionFilter())
    with caplog.at_level(logging.INFO):
        log.info("using key %s", REAL_LOOKING_KEY, extra={"detail": REAL_LOOKING_KEY})
    rendered = "\n".join(record.getMessage() + str(record.__dict__) for record in caplog.records)
    assert REAL_LOOKING_KEY not in rendered


def test_configure_logging_installs_the_filter_and_quiets_httpx():
    configure_logging("INFO", "json", [REAL_LOOKING_KEY])
    root = logging.getLogger()
    assert any(isinstance(f, RedactionFilter) for f in root.handlers[0].filters)
    assert logging.getLogger("httpx").level == logging.WARNING


# ------------------------------------------------------- storage isolation
def test_no_credential_reaches_the_database(session, settings, make_tracker, flights_payload):
    keyed = settings.model_copy(
        update={"serpapi_api_key": REAL_LOOKING_KEY, "telegram_bot_token": REAL_LOOKING_TOKEN}
    )
    provider = SerpApiProvider(keyed, transport=json_transport(flights_payload))
    SearchService(keyed, provider=provider).run_tracker(
        session, make_tracker(), trigger=RunTrigger.MANUAL
    )

    blobs: list[str] = []
    for run in session.query(SearchRun).all():
        blobs.append(json.dumps(run.raw_excerpt or {}))
        blobs.append(str(run.error_message))
    for observation in session.query(FareObservation).all():
        blobs.append(json.dumps(observation.segments or []))
        blobs.append(str(observation.search_link))
    for event in session.query(AlertEvent).all():
        blobs.append(event.message_text)
    for setting in session.query(AppSetting).all():
        blobs.append(json.dumps(setting.value))

    combined = "\n".join(blobs)
    assert REAL_LOOKING_KEY not in combined
    assert REAL_LOOKING_TOKEN not in combined
    assert "api_key" not in combined


def test_settings_never_expose_secrets_through_the_public_context(settings):
    from flightnotify.web.deps import base_context

    class FakeRequest:
        session: dict = {}
        app = None

    keyed = settings.model_copy(update={"serpapi_api_key": REAL_LOOKING_KEY})
    import flightnotify.web.deps as deps

    original = deps.get_settings
    deps.get_settings = lambda: keyed
    try:
        context = base_context(FakeRequest())  # type: ignore[arg-type]
    finally:
        deps.get_settings = original
    assert REAL_LOOKING_KEY not in json.dumps(context["settings_public"])
    assert context["settings_public"]["has_provider"] is True


def test_env_example_contains_no_real_values():
    text = (PROJECT_ROOT / ".env.example").read_text(encoding="utf-8")
    for line in text.splitlines():
        if line.startswith(
            ("SERPAPI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "APP_SECRET_KEY")
        ):
            assert line.split("=", 1)[1].strip() == "", line


def test_gitignore_excludes_env_and_data():
    text = (PROJECT_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert ".env" in text
    assert "data/" in text


def test_generated_secret_key_is_written_with_restrictive_permissions(tmp_path):
    from flightnotify.config import Settings

    settings = Settings(app_secret_key="", database_url=f"sqlite:///{tmp_path / 'sub' / 'app.db'}")
    key = settings.resolved_secret_key()
    assert len(key) > 30
    key_file = tmp_path / "sub" / "secret_key"
    assert key_file.exists()
    assert oct(key_file.stat().st_mode)[-3:] == "600"
    # Stable across calls.
    assert settings.resolved_secret_key() == key


# --------------------------------------------------------------------- CLI
def run_cli(
    args: list[str], env_extra: dict[str, str], tmp_path: Path
) -> subprocess.CompletedProcess:
    import os

    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite:///{tmp_path / 'cli.db'}",
        "APP_TIMEZONE": "UTC",
        "APP_SECRET_KEY": "cli-test-secret",
        "LOG_LEVEL": "WARNING",
        **env_extra,
    }
    env.pop("SERPAPI_API_KEY", None)
    env.pop("TELEGRAM_BOT_TOKEN", None)
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-m", "flightnotify.cli", *args],
        capture_output=True,
        text=True,
        env=env,
        # Run from an empty directory, never the checkout: pydantic-settings
        # loads `.env` relative to the working directory, so a developer who
        # has actually configured FlightNotify would otherwise leak real
        # credentials into tests that deliberately unset them.
        cwd=tmp_path,
        timeout=180,
    )


def test_cli_migrate_and_status_on_a_clean_database(tmp_path):
    migrate = run_cli(["migrate"], {}, tmp_path)
    assert migrate.returncode == 0, migrate.stderr
    assert "migrated" in migrate.stdout

    status = run_cli(["status"], {}, tmp_path)
    assert status.returncode == 0, status.stderr
    assert "SerpApi key    : NOT SET" in status.stdout
    assert "quota" in status.stdout


def test_check_once_without_a_key_exits_with_a_configuration_code(tmp_path):
    run_cli(["migrate"], {}, tmp_path)
    result = run_cli(["check-once"], {}, tmp_path)
    assert result.returncode == cli.EXIT_CONFIG
    assert "SERPAPI_API_KEY is not set" in result.stderr
    assert "no data changed" in result.stderr


def test_check_once_with_nothing_due_exits_zero(tmp_path):
    run_cli(["migrate"], {}, tmp_path)
    result = run_cli(["check-once"], {"SERPAPI_API_KEY": "placeholder-key"}, tmp_path)
    assert result.returncode == cli.EXIT_OK
    assert "due=0 checked=0" in result.stdout


def test_backup_produces_a_readable_copy(tmp_path):
    run_cli(["migrate"], {}, tmp_path)
    target = tmp_path / "backup.db"
    result = run_cli(["backup", "--output", str(target)], {}, tmp_path)
    assert result.returncode == 0, result.stderr
    assert target.exists() and target.stat().st_size > 0
    assert "Restore with" in result.stdout

    import sqlite3

    connection = sqlite3.connect(target)
    try:
        tables = {
            row[0]
            for row in connection.execute("select name from sqlite_master where type='table'")
        }
    finally:
        connection.close()
    assert "trackers" in tables


def test_failures_command_reports_an_empty_state(tmp_path):
    run_cli(["migrate"], {}, tmp_path)
    result = run_cli(["failures"], {}, tmp_path)
    assert result.returncode == 0
    assert "Recent failed or skipped checks (0)" in result.stdout
    assert "Undelivered alerts (0)" in result.stdout


def test_serve_refuses_a_non_loopback_bind_without_the_explicit_flag(tmp_path):
    result = run_cli(["serve", "--host", "0.0.0.0", "--port", "8099"], {}, tmp_path)
    assert result.returncode == cli.EXIT_CONFIG
    assert "refusing to bind" in result.stderr


def test_cli_never_prints_a_configured_secret(tmp_path):
    run_cli(["migrate"], {}, tmp_path)
    result = run_cli(
        ["status"],
        {"SERPAPI_API_KEY": REAL_LOOKING_KEY, "TELEGRAM_BOT_TOKEN": REAL_LOOKING_TOKEN},
        tmp_path,
    )
    combined = result.stdout + result.stderr
    assert REAL_LOOKING_KEY not in combined
    assert REAL_LOOKING_TOKEN not in combined
    assert "SerpApi key    : set" in result.stdout


@pytest.mark.parametrize(
    "command",
    ["setup", "migrate", "serve", "scheduler", "check-once", "backup", "failures", "status"],
)
def test_every_documented_command_is_registered(command):
    parser = cli.build_parser()
    action = next(a for a in parser._subparsers._group_actions if a.choices)
    assert command in action.choices


def test_data_root_is_the_checkout_when_one_is_present():
    """A source checkout keeps using the repository root, as it always has."""
    assert (PROJECT_ROOT / "pyproject.toml").is_file(), "test assumes a source checkout"
    assert config.data_root() == PROJECT_ROOT


def test_data_root_falls_back_to_cwd_for_an_installed_package(tmp_path, monkeypatch):
    """An installed wheel has no checkout, and must never store state in site-packages.

    ``PROJECT_ROOT`` is ``site-packages`` there, so resolving relative paths
    against it would write the database next to the installed code.
    """
    fake_site_packages = tmp_path / "site-packages"
    fake_site_packages.mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", fake_site_packages)
    monkeypatch.chdir(tmp_path)

    assert config.data_root() == tmp_path
    assert config.data_root() != fake_site_packages


def test_relative_database_url_never_resolves_into_the_package(tmp_path, monkeypatch):
    fake_site_packages = tmp_path / "site-packages"
    fake_site_packages.mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", fake_site_packages)
    monkeypatch.chdir(tmp_path)

    settings = config.Settings(database_url="sqlite:///data/flightnotify.db", app_timezone="UTC")
    resolved = settings.sqlite_path
    assert resolved == tmp_path / "data" / "flightnotify.db"
    assert fake_site_packages not in resolved.parents


def test_absolute_database_url_is_left_alone(tmp_path):
    """The container sets an absolute path; it must survive untouched."""
    settings = config.Settings(database_url="sqlite:////data/flightnotify.db", app_timezone="UTC")
    assert settings.sqlite_path == Path("/data/flightnotify.db")
