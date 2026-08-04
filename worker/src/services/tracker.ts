/**
 * Comparison-series identity and scheduling.
 *
 * Port of `flightnotify/domain/config_series.py` and the scheduling helpers in
 * `flightnotify/services/tracker_service.py`.
 *
 * The payload built here is hashed into the series fingerprint, so its shape is
 * a compatibility contract with the existing production rows: the field list,
 * the names, and the sorted markets all have to match the Python original or an
 * imported tracker would appear to have changed configuration and start a new
 * series, orphaning its price history.
 */

import type { Repo } from "../db/repo.js";
import type { TrackerWithMarkets } from "../db/rows.js";
import type { CanonicalInput } from "../domain/canonical.js";
import { configFingerprint } from "../domain/fingerprints.js";
import { addMinutes, nowIso, toIso } from "../time.js";

/** Fields whose values define a comparison series. Order is irrelevant (the
 *  canonicaliser sorts), but the exact set is not. */
export const COMPARISON_FIELDS = [
  "origin",
  "destination",
  "adults",
  "children",
  "infants_in_seat",
  "infants_on_lap",
  "cabin",
  "stops",
  "include_airlines",
  "exclude_airlines",
  "currency",
  "date_mode",
  "outbound_date",
  "return_date",
  "flex_month",
  "flex_year",
  "flex_duration",
  "window_outbound_start",
  "window_outbound_end",
  "window_return_start",
  "window_return_end",
  "min_nights",
  "max_nights",
] as const;

export const FIELD_LABELS: Record<string, string> = {
  origin: "origin airport",
  destination: "destination airport",
  adults: "adults",
  children: "children",
  infants_in_seat: "infants in seat",
  infants_on_lap: "lap infants",
  cabin: "cabin",
  stops: "stops preference",
  include_airlines: "included airlines",
  exclude_airlines: "excluded airlines",
  currency: "currency",
  date_mode: "date mode",
  outbound_date: "outbound date",
  return_date: "return date",
  flex_month: "flexible month",
  flex_year: "flexible year",
  flex_duration: "flexible trip length",
  window_outbound_start: "outbound window start",
  window_outbound_end: "outbound window end",
  window_return_start: "return window start",
  window_return_end: "return window end",
  min_nights: "minimum nights",
  max_nights: "maximum nights",
  markets: "country markets",
};

/** Immutable snapshot of everything that defines the comparison series. */
export function comparisonPayload(tracker: TrackerWithMarkets): Record<string, CanonicalInput> {
  const payload: Record<string, CanonicalInput> = {};
  for (const field of COMPARISON_FIELDS) {
    payload[field] = tracker[field] as CanonicalInput;
  }
  payload["markets"] = [...tracker.markets].sort();
  return payload;
}

export async function seriesFingerprint(tracker: TrackerWithMarkets): Promise<string> {
  return configFingerprint(comparisonPayload(tracker));
}

export interface SeriesChange {
  changed: boolean;
  configVersionId: number;
  version: number;
  reasons: string[];
}

/**
 * Make sure the tracker points at a config version matching its current
 * settings, creating a new one when a comparison-relevant field changed.
 *
 * Changing the threshold, alert preferences or schedule keeps the existing
 * history comparable; changing route, passengers, cabin, currency, markets or
 * dates starts a new series so incompatible observations are never silently
 * compared.
 */
export async function ensureConfigVersion(
  repo: Repo,
  tracker: TrackerWithMarkets,
  options: {
    candidates?: { outbound: string; ret: string; nights: number }[];
  } = {},
): Promise<SeriesChange> {
  const payload = comparisonPayload(tracker);
  const fingerprint = await configFingerprint(payload);
  const latest = await repo.latestConfigVersion(tracker.id);

  if (latest !== null && latest.fingerprint === fingerprint) {
    if (tracker.current_config_version_id !== latest.id) {
      await repo.updateTrackerFields(tracker.id, { current_config_version_id: latest.id });
      tracker.current_config_version_id = latest.id;
    }
    if (options.candidates !== undefined) {
      const existing = await repo.candidateDefinitions(latest.id);
      const intended = options.candidates;
      const matches =
        existing.length === intended.length &&
        existing.every(
          (candidate, index) =>
            candidate.outbound === intended[index]?.outbound &&
            candidate.ret === intended[index]?.ret &&
            candidate.nights === intended[index]?.nights,
        );
      if (!matches) {
        // Repair a missing/partial legacy queue without resetting healthy
        // progress merely because the operator saved an unchanged form.
        await repo.replaceCandidates(tracker.id, latest.id, intended);
      }
    }
    return { changed: false, configVersionId: latest.id, version: latest.version, reasons: [] };
  }

  const at = nowIso();
  const version = (latest?.version ?? 0) + 1;
  const reasons = latest === null ? [] : describeChanges(safeParse(latest.payload), payload);

  const id = await repo.transitionConfigVersion({
    trackerId: tracker.id,
    latestId: latest?.id ?? null,
    version,
    fingerprint,
    payload: JSON.stringify(payload),
    effectiveFrom: at,
    candidates: options.candidates,
  });

  tracker.current_config_version_id = id;
  tracker.series_started_at = at;
  tracker.low_price_cents = null;
  tracker.latest_price_cents = null;
  tracker.last_threshold_met = 0;
  if (options.candidates !== undefined) tracker.coverage_cycle = 1;

  return { changed: true, configVersionId: id, version, reasons };
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Human-readable list of the comparison-relevant fields that changed. */
export function describeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: string[] = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    const label = FIELD_LABELS[key] ?? key.replace(/_/g, " ");
    changes.push(`${label}: ${renderValue(a)} → ${renderValue(b)}`);
  }
  return changes;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "not set";
  if (Array.isArray(value)) {
    const rendered = value.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    return rendered.length ? rendered.join(", ") : "none";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "changed";
}

/** Move the tracker's next run forward by its configured interval. */
export function nextRunAt(intervalMinutes: number, from: Date = new Date()): string {
  return toIso(addMinutes(from, Math.max(15, intervalMinutes)));
}

export async function scheduleNextRun(
  repo: Repo,
  tracker: TrackerWithMarkets,
  from: Date = new Date(),
): Promise<void> {
  const at = nextRunAt(tracker.check_interval_minutes, from);
  await repo.updateTrackerFields(tracker.id, { next_run_at: at });
  tracker.next_run_at = at;
}

export function payingTravelersOf(tracker: TrackerWithMarkets): number {
  return tracker.adults + tracker.children + tracker.infants_in_seat;
}
