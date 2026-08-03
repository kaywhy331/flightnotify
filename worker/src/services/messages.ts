/**
 * Telegram message composition -- alerts and the connectivity test.
 *
 * Port of `flightnotify/services/messages.py`. Wording rules the product
 * contract fixes, and which the tests assert on:
 *
 *   - "observed" price, never "guaranteed";
 *   - "new observed low", never urgency language;
 *   - a partial flexible sweep is always labelled as partial;
 *   - a baseline observation is never called a price drop;
 *   - a link is only included when the provider supplied one.
 */

import {
  AlertType,
  CABIN_LABELS,
  PriceScopeLabel,
  ThresholdBasis,
  type AlertTypeValue,
  type PriceScopeValue,
  type ThresholdBasisValue,
} from "../domain/enums.js";
import { formatMoney } from "../domain/money.js";
import { formatDateShort, formatLocal } from "../time.js";
import { escapeHtml } from "./telegram.js";

export const DISCLAIMER = "Price and availability can change before booking.";

export interface AlertContext {
  alertType: AlertTypeValue;
  trackerName: string;
  origin: string;
  destination: string;
  passengerSummary: string;
  cabin: string;
  currency: string;
  comparableCents: number;
  thresholdCents: number;
  thresholdBasis: ThresholdBasisValue;
  priceScope: PriceScopeValue;
  /** Date-only strings, `YYYY-MM-DD`, as stored. */
  outboundDate: string | null;
  returnDate: string | null;
  stops: number | null;
  market: string;
  observedAt: Date | string;
  previousLowCents: number | null;
  dropAbsoluteCents: number | null;
  isBaseline: boolean;
  coverageChecked: number | null;
  coverageTotal: number | null;
  coverageComplete: boolean;
  link: string | null;
  airlines: string[];
}

/** Python's `str.title()`: every run of letters capitalised, the rest lowered. */
function titleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

/** The day number of a `YYYY-MM-DD` string, unpadded, as `%-d` renders it. */
function dayOfMonth(dateOnly: string): string {
  return String(Number(dateOnly.slice(8, 10)));
}

export function dateRange(outbound: string | null, inbound: string | null): string {
  if (outbound === null && inbound === null) return "Dates from provider";
  if (outbound !== null && inbound !== null) {
    if (inbound < outbound) {
      // Never collapse an incoherent pair into a tidy-looking range like
      // "Oct 12-8": spell both dates out so the oddity is visible.
      return (
        `${formatDateShort(outbound)}, ${outbound.slice(0, 4)} → ` +
        `${formatDateShort(inbound)}, ${inbound.slice(0, 4)}`
      );
    }
    if (outbound.slice(0, 7) === inbound.slice(0, 7)) {
      return `${formatDateShort(outbound)}–${dayOfMonth(inbound)}`;
    }
    return `${formatDateShort(outbound)}–${formatDateShort(inbound)}`;
  }
  const single = outbound ?? inbound;
  return single ? formatDateShort(single) : "Dates from provider";
}

function stopsLabel(stops: number | null): string {
  if (stops === null) return "Stops unknown";
  if (stops === 0) return "Nonstop";
  return `${stops} stop${stops === 1 ? "" : "s"}`;
}

function basisLabel(
  basis: ThresholdBasisValue,
  scope: PriceScopeValue,
  passengers: string,
): string {
  if (scope === PriceScopeLabel.UNKNOWN) {
    return "as reported by the provider (price basis unconfirmed)";
  }
  if (basis === ThresholdBasis.PER_TRAVELER) return "per traveler";
  return `total for ${passengers}`;
}

/** Never describe a partial sweep as a complete search. */
export function coverageSentence(
  checked: number | null,
  total: number | null,
  complete: boolean,
): string {
  if (!total || total <= 1) return "";
  if (complete && checked !== null && checked >= total) {
    return `Lowest across all ${total} date combinations in this cycle.`;
  }
  if (checked === null) return `Partial scan of ${total} date combinations.`;
  return `Lowest observed among ${checked} of ${total} date combinations checked.`;
}

/** Compose the alert body for Telegram's HTML parse mode. */
export function buildAlertText(ctx: AlertContext, timeZone: string): string {
  const heading =
    ctx.alertType === AlertType.NEW_LOW
      ? "✈️ New observed low"
      : ctx.alertType === AlertType.APPROACHING
        ? "✈️ Approaching threshold"
        : "✈️ Threshold reached";
  const cabinLabel = CABIN_LABELS[ctx.cabin] ?? titleCase(ctx.cabin);

  const lines: string[] = [
    `<b>${escapeHtml(heading)} — ${escapeHtml(ctx.origin)} → ` +
      `${escapeHtml(ctx.destination)}</b>`,
    escapeHtml(ctx.trackerName),
    "",
    escapeHtml(
      `${formatMoney(ctx.comparableCents, ctx.currency)} ` +
        `${basisLabel(ctx.thresholdBasis, ctx.priceScope, ctx.passengerSummary)} · ` +
        `${cabinLabel}`,
    ),
  ];

  let detail = `${dateRange(ctx.outboundDate, ctx.returnDate)} · ${stopsLabel(ctx.stops)}`;
  if (ctx.airlines.length > 0) detail += ` · ${ctx.airlines.slice(0, 3).join(", ")}`;
  detail += ` · ${ctx.market.toUpperCase()} market`;
  lines.push(escapeHtml(detail));

  if (ctx.isBaseline) {
    lines.push(
      escapeHtml(
        "First observation for this configuration — recorded as the baseline, " +
          "not a price drop.",
      ),
    );
  } else if (
    ctx.previousLowCents !== null &&
    ctx.dropAbsoluteCents !== null &&
    ctx.dropAbsoluteCents > 0
  ) {
    lines.push(
      escapeHtml(
        `Previous observed low: ${formatMoney(ctx.previousLowCents, ctx.currency)} · ` +
          `down ${formatMoney(ctx.dropAbsoluteCents, ctx.currency)}`,
      ),
    );
  } else if (ctx.previousLowCents !== null) {
    lines.push(
      escapeHtml(`Previous observed low: ${formatMoney(ctx.previousLowCents, ctx.currency)}`),
    );
  }

  const basisWord =
    ctx.thresholdBasis === ThresholdBasis.PER_TRAVELER ? "per traveler" : "whole party";
  lines.push(
    escapeHtml(`Threshold: ${formatMoney(ctx.thresholdCents, ctx.currency)} (${basisWord})`),
  );
  if (ctx.alertType === AlertType.APPROACHING) {
    lines.push(escapeHtml("Within 5% of the threshold, but not at it yet."));
  }
  lines.push(escapeHtml(`Checked: ${formatLocal(ctx.observedAt, timeZone)}`));

  const coverage = coverageSentence(ctx.coverageChecked, ctx.coverageTotal, ctx.coverageComplete);
  if (coverage) lines.push(escapeHtml(coverage));

  if (ctx.link) {
    lines.push("");
    lines.push(`<a href="${escapeHtml(ctx.link)}">Open this search on Google Flights</a>`);
  }

  lines.push("");
  lines.push(`<i>${escapeHtml(DISCLAIMER)}</i>`);
  return lines.join("\n");
}

export function buildTestMessage(timeZone: string, now: Date | string): string {
  return (
    "<b>✈️ FlightNotify test message</b>\n" +
    escapeHtml(
      "If you can read this, alerts are wired up correctly. " +
        "This message contains no fare data.",
    ) +
    "\n" +
    escapeHtml(`Sent: ${formatLocal(now, timeZone)}`)
  );
}
