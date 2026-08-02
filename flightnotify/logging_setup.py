"""Structured logging with unconditional credential redaction.

Every log record - including exception text and third-party records - passes
through :class:`RedactionFilter` before a handler can format it.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from typing import Any

#: Patterns that catch credential-shaped strings even if a value was never
#: registered (for example a token pasted into a URL by a dependency).
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Telegram bot tokens: <digits>:<35 base64url chars>
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"), "[REDACTED_TELEGRAM_TOKEN]"),
    # api_key=... / token=... / key=... in query strings or kwargs
    (
        re.compile(
            r"(?i)\b(api_key|apikey|token|secret|bot_token|password)\b"
            r"(\s*[=:]\s*)[^\s,&'\")}]+"
        ),
        r"\1\2[REDACTED]",
    ),
    # /bot<token>/method on api.telegram.org
    (re.compile(r"/bot[^/\s]+/"), "/bot[REDACTED]/"),
)

_registered: list[str] = []


def register_secret(value: str) -> None:
    """Register a literal secret so it is masked wherever it appears."""
    value = (value or "").strip()
    if len(value) >= 8 and value not in _registered:
        _registered.append(value)


def redact(text: str) -> str:
    """Return ``text`` with every known or credential-shaped value masked."""
    if not text:
        return text
    for secret in _registered:
        if secret in text:
            text = text.replace(secret, "[REDACTED]")
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact(str(record.msg))
        except Exception:  # pragma: no cover - never let logging explode
            record.msg = "[unrenderable log message]"
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: redact(str(v)) for k, v in record.args.items()}
            else:
                record.args = tuple(redact(str(a)) for a in record.args)
        for key, value in list(record.__dict__.items()):
            if key in _RESERVED or not isinstance(value, str):
                continue
            record.__dict__[key] = redact(value)
        return True


_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}


class TextFormatter(logging.Formatter):
    """Human-readable one-line records with key=value context."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        extras = {
            k: v for k, v in record.__dict__.items() if k not in _RESERVED and not k.startswith("_")
        }
        if extras:
            rendered = " ".join(f"{k}={_compact(v)}" for k, v in sorted(extras.items()))
            base = f"{base} | {rendered}"
        return redact(base)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return redact(json.dumps(payload, default=str))


def _compact(value: Any) -> str:
    text = str(value)
    return text if " " not in text else f'"{text}"'


_configured = False


def configure_logging(
    level: str = "INFO", fmt: str = "text", secrets: list[str] | None = None
) -> None:
    """Install the root handler. Safe to call more than once."""
    global _configured
    for secret in secrets or []:
        register_secret(secret)

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    if _configured:
        return

    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(RedactionFilter())
    if fmt.lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            TextFormatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
        )
    root.handlers = [handler]

    # httpx logs full request URLs at INFO; those carry the api_key query param.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    _configured = True


def reset_logging_for_tests() -> None:
    """Clear module state so tests can reconfigure from scratch."""
    global _configured
    _configured = False
    _registered.clear()
