/** Telegram command replies for the Cloudflare Worker webhook bot. */

import type { TrackerWithMarkets } from "../db/rows.js";
import {
  FLEX_DURATION_LABELS,
  ThresholdBasis,
  TrackerStatus,
} from "../domain/enums.js";
import { formatMoney } from "../domain/money.js";
import { formatDateShort, formatLocal, parseIsoOrNull } from "../time.js";
import type { CheckResult } from "./search.js";
import type { QuotaSnapshot } from "./quota.js";
import { coverageSentence, DISCLAIMER } from "./messages.js";
import { escapeHtml } from "./telegram.js";

const COMMAND_HELP: ReadonlyArray<readonly [string, string]> = [
  ["/status", "quota, scheduler and setup state"],
  ["/trackers", "every tracker with its latest observed fare"],
  ["/tracker <id>", "detail for one tracker"],
  ["/check <id>", "check one tracker now (spends provider searches)"],
  ["/pause <id>", "stop checking a tracker (history is kept)"],
  ["/resume <id>", "resume a paused tracker"],
  ["/help", "this list"],
];

export interface TrackerCoverage {
  checked: number;
  total: number;
  complete: boolean;
}

export function buildHelpMessage(): string {
  const lines = ["<b>✈️ FlightNotify commands</b>", ""];
  lines.push(...COMMAND_HELP.map(([name, detail]) => `${escapeHtml(name)} — ${escapeHtml(detail)}`));
  lines.push(
    "",
    escapeHtml(
      "/check spends provider searches from the monthly free-tier allowance, " +
        "so it is the only command here that costs anything.",
    ),
  );
  return lines.join("\n");
}

export function buildUnknownCommandMessage(command: string): string {
  return `${escapeHtml(`Unrecognised command ${command.slice(0, 120)}.`)}\n\n${buildHelpMessage()}`;
}

export function buildStatusMessage(args: {
  snapshot: QuotaSnapshot;
  schedulerEnabled: boolean;
  schedulerDetail: string;
  trackerCount: number;
  activeCount: number;
  providerConfigured: boolean;
  version: string;
  now: Date;
  timeZone: string;
}): string {
  const { snapshot } = args;
  const lines = [
    `<b>${escapeHtml(`✈️ FlightNotify ${args.version}`)}</b>`,
    "",
    escapeHtml(`Trackers: ${args.trackerCount} (${args.activeCount} active)`),
    escapeHtml(
      `Quota: ${snapshot.effectiveUsed}/${snapshot.monthlyLimit} used · ` +
        `${snapshot.remainingSafe} available to automation · ` +
        `${snapshot.reserve} reserved for manual checks`,
    ),
    escapeHtml(
      `Hourly: ${snapshot.hourlyUsed}/${snapshot.hourlyLimit} in the last hour · ` +
        `period ${snapshot.period}`,
    ),
    escapeHtml(
      `Scheduler: ${args.schedulerEnabled ? "enabled" : "disabled"} — ` +
        args.schedulerDetail,
    ),
  ];
  if (!args.providerConfigured) {
    lines.push(escapeHtml("SERPAPI_API_KEY is not set, so no search can run."));
  }
  if (snapshot.syncError) lines.push(escapeHtml(`Quota sync: ${snapshot.syncError.slice(0, 500)}`));
  lines.push("", escapeHtml(`As of ${formatLocal(args.now, args.timeZone)}`));
  return lines.join("\n");
}

function stateSuffix(tracker: TrackerWithMarkets): string {
  if (tracker.status === TrackerStatus.PAUSED) return " · paused";
  if (tracker.status === TrackerStatus.ERROR) return " · error";
  if (tracker.status === TrackerStatus.COMPLETED) return " · completed";
  return isStale(tracker) ? " · stale" : "";
}

function isStale(tracker: TrackerWithMarkets, now = new Date()): boolean {
  if (tracker.status !== TrackerStatus.ACTIVE) return false;
  const lastSuccess = parseIsoOrNull(tracker.last_success_at);
  if (lastSuccess === null) {
    return tracker.latest_price_cents === null && tracker.last_attempt_at !== null;
  }
  return now.getTime() - lastSuccess.getTime() > tracker.check_interval_minutes * 2 * 60_000;
}

function priceOrEmpty(value: number | null, currency: string): string {
  return value === null ? "no observation yet" : formatMoney(value, currency);
}

/** Bound a list reply by adding complete tracker blocks, never slicing HTML. */
export function buildTrackersMessage(trackers: TrackerWithMarkets[]): string {
  if (trackers.length === 0) return escapeHtml("No trackers yet. Add one in the web UI.");

  const lines = ["<b>✈️ Trackers</b>", ""];
  let shown = 0;
  for (const tracker of trackers) {
    const marker =
      tracker.latest_price_cents !== null &&
      tracker.latest_price_cents <= tracker.threshold_amount_cents
        ? "at or below threshold"
        : "above threshold";
    const block = [
      `<b>${escapeHtml(`${tracker.id}. ${tracker.name}`)}</b>` +
        escapeHtml(` (${tracker.origin} → ${tracker.destination})${stateSuffix(tracker)}`),
      escapeHtml(
        `   ${priceOrEmpty(tracker.latest_price_cents, tracker.currency)}` +
          (tracker.latest_price_cents === null ? "" : ` · ${marker}`),
      ),
    ];
    if ([...lines, ...block].join("\n").length > 3400) break;
    lines.push(...block);
    shown += 1;
  }
  if (shown < trackers.length) {
    lines.push("", escapeHtml(`${trackers.length - shown} more tracker(s) are in the web UI.`));
  }
  lines.push("", escapeHtml("Send /tracker <id> for detail."));
  return lines.join("\n");
}

function describeDates(tracker: TrackerWithMarkets): string {
  if (tracker.date_mode === "exact") {
    return `${formatDateShort(tracker.outbound_date)}–${formatDateShort(tracker.return_date)}`;
  }
  if (tracker.date_mode === "flexible_preset") {
    const duration = FLEX_DURATION_LABELS[tracker.flex_duration ?? ""] ?? tracker.flex_duration ?? "";
    return `${tracker.flex_month ?? "?"}/${tracker.flex_year ?? "?"} · ${duration}`;
  }
  const parts = [
    `${formatDateShort(tracker.window_outbound_start)}–${formatDateShort(tracker.window_outbound_end)}`,
  ];
  if (tracker.window_return_start && tracker.window_return_end) {
    parts.push(
      `return ${formatDateShort(tracker.window_return_start)}–` +
        formatDateShort(tracker.window_return_end),
    );
  }
  if (tracker.min_nights !== null && tracker.max_nights !== null) {
    parts.push(`${tracker.min_nights}–${tracker.max_nights} nights`);
  }
  return parts.join(" · ");
}

export function buildTrackerDetailMessage(
  tracker: TrackerWithMarkets,
  coverage: TrackerCoverage | null,
  timeZone: string,
): string {
  const meetsThreshold =
    tracker.latest_price_cents !== null &&
    tracker.latest_price_cents <= tracker.threshold_amount_cents;
  const basis =
    tracker.threshold_basis === ThresholdBasis.PER_TRAVELER ? "per traveler" : "whole party";
  const lines = [
    `<b>${escapeHtml(`✈️ ${tracker.name.slice(0, 200)}`)}</b>`,
    escapeHtml(
      `${tracker.origin.slice(0, 20)} → ${tracker.destination.slice(0, 20)} · ${describeDates(tracker)}`,
    ),
    "",
    escapeHtml(`Latest observed: ${priceOrEmpty(tracker.latest_price_cents, tracker.currency)}`),
    escapeHtml(`Observed low: ${priceOrEmpty(tracker.low_price_cents, tracker.currency)}`),
    escapeHtml(
      `Threshold: ${formatMoney(tracker.threshold_amount_cents, tracker.currency)} (${basis})` +
        (meetsThreshold ? " — reached" : " — not reached"),
    ),
    escapeHtml(`Status: ${tracker.status}${isStale(tracker) ? " · stale" : ""}`),
  ];
  if (tracker.last_success_at !== null) {
    lines.push(escapeHtml(`Last success: ${formatLocal(tracker.last_success_at, timeZone)}`));
  }
  if (tracker.next_run_at !== null && tracker.status === TrackerStatus.ACTIVE) {
    lines.push(escapeHtml(`Next check: ${formatLocal(tracker.next_run_at, timeZone)}`));
  }
  if (coverage) {
    const sentence = coverageSentence(coverage.checked, coverage.total, coverage.complete);
    if (sentence) lines.push(escapeHtml(sentence));
  }
  lines.push("", `<i>${escapeHtml(DISCLAIMER)}</i>`);
  return lines.join("\n");
}

export function buildCheckResultMessage(
  tracker: TrackerWithMarkets,
  result: CheckResult,
): string {
  const activity = result.skipped
    ? "Check skipped."
    : `Check complete: ${result.providerCalls} live search(es), ${result.cacheHits} cached, ` +
      `${result.offersFound} offer(s).`;
  const best =
    result.bestPriceCents === null
      ? ""
      : ` Best eligible fare: ${formatMoney(result.bestPriceCents, tracker.currency)}.`;
  const lines = [
    `<b>${escapeHtml(tracker.name.slice(0, 200))}</b>`,
    escapeHtml(activity + best),
  ];
  let omitted = 0;
  for (const [prefix, messages] of [
    ["note: ", result.statusMessages],
    ["error: ", result.errors],
  ] as const) {
    for (const message of messages) {
      const line = escapeHtml(`${prefix}${message.slice(0, 500)}`);
      if ([...lines, line].join("\n").length > 3400) {
        omitted += 1;
        continue;
      }
      lines.push(line);
    }
  }
  if (omitted > 0) lines.push(escapeHtml(`${omitted} additional detail line(s) are in the web UI.`));
  return lines.join("\n");
}
