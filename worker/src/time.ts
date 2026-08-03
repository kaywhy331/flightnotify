/**
 * UTC-internal / local-display time helpers.
 *
 * Port of `flightnotify/timeutil.py`. Everything persisted is UTC; only the
 * presentation layer converts to APP_TIMEZONE.
 *
 * Timestamps are stored as TEXT in exactly one shape:
 *
 *     YYYY-MM-DDTHH:MM:SS.sssZ
 *
 * The fixed width is deliberate. D1 indexes compare TEXT lexicographically, so
 * a uniform format makes string order equal chronological order and lets the
 * plain indexes serve due-work and history queries. Mixing 3- and 6-digit
 * fractional seconds would silently invert ordering ("...724370Z" sorts before
 * "...724Z" while being later), so every write goes through `toIso()`.
 */

/** Canonical stored timestamp: ISO-8601 UTC, always millisecond precision. */
export function toIso(value: Date | number | string): string {
  const date =
    value instanceof Date ? value : typeof value === "number" ? new Date(value) : parseIso(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`not a valid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/**
 * Parse a stored timestamp.
 *
 * Accepts the Python/SQLite legacy shape ("YYYY-MM-DD HH:MM:SS.ffffff", naive
 * UTC) as well as ISO-8601, so a row written by the old app is read correctly
 * if one ever slips through the importer.
 */
export function parseIso(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(trimmed) && !/[Zz]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    // Naive: the old schema guaranteed UTC without saying so.
    return new Date(`${trimmed.replace(" ", "T")}Z`);
  }
  return new Date(trimmed.replace(" ", "T"));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseIsoOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = parseIso(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

export function addSeconds(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

/** Quota accounting period, YYYY-MM in UTC. */
export function periodKey(moment: Date = new Date()): string {
  return `${moment.getUTCFullYear()}-${String(moment.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First instant of the next UTC month. */
export function monthEnd(moment: Date = new Date()): Date {
  const year = moment.getUTCFullYear();
  const month = moment.getUTCMonth();
  return month === 11
    ? new Date(Date.UTC(year + 1, 0, 1))
    : new Date(Date.UTC(year, month + 1, 1));
}

/** The operator's current local date -- what "not in the past" means to them. */
export function todayIn(timeZone: string): string {
  // en-CA gives ISO-shaped YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Presentation-layer rendering, e.g. "Aug 2, 3:17 PM PDT". */
export function formatLocal(value: Date | string | null | undefined, timeZone: string): string {
  const date = value instanceof Date ? value : parseIsoOrNull(value ?? null);
  if (date === null) return "-";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return (
    `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ` +
    `${get("dayPeriod")} ${get("timeZoneName")}`
  );
}

/** Render a date-only string (YYYY-MM-DD) as e.g. "Sep 30". */
export function formatDateShort(value: string | null | undefined): string {
  if (!value) return "-";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Render `target` relative to now, e.g. "in 3h 20m" / "12m ago". */
export function humanizeDelta(
  target: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  const date = target instanceof Date ? target : parseIsoOrNull(target ?? null);
  if (date === null) return "-";
  const deltaMs = date.getTime() - now.getTime();
  const past = deltaMs < 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  let text: string;
  if (seconds < 60) text = `${seconds}s`;
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86400)
    text = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  else text = `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;

  return past ? `${text} ago` : `in ${text}`;
}

/** Days between two YYYY-MM-DD strings. */
export function nightsBetween(outbound: string, ret: string): number {
  const a = new Date(`${outbound}T00:00:00Z`).getTime();
  const b = new Date(`${ret}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Add days to a YYYY-MM-DD string, returning the same shape. */
export function addDays(dateOnly: string, days: number): string {
  const base = new Date(`${dateOnly}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
