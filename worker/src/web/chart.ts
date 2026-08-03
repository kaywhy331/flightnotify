/**
 * Server-rendered price-history chart.
 *
 * Port of `flightnotify/web/chart.py`. The SVG is generated on the server and
 * scales with its container, so the chart works with JavaScript disabled,
 * resizes without clipping, and is always accompanied by the same data as a
 * real table (rendered by the view).
 *
 * Two deliberate departures from the Python source, both invisible in output:
 *
 * - Money arrives as integer cents (the Worker never stores floats), so
 *   geometry converts to dollar floats up front. Pixel positions never flow
 *   back into storage, and the degenerate-range fallback below is "one
 *   dollar", which only means the right thing in major units.
 * - `strftime` does not exist here; Intl.DateTimeFormat parts are reassembled
 *   into the same "%b %-d, %-I:%M %p" shapes, so English month abbreviations
 *   come from CLDR rather than a hand-rolled table.
 *
 * The return value is a raw markup string: every interpolated value is escaped
 * here (labels carry airline names from the provider), and the caller wraps
 * the whole thing in `raw()`.
 */

import { formatMoney } from "../domain/money.js";
import { parseIsoOrNull } from "../time.js";
import { escapeHtml } from "./html.js";

export interface PricePoint {
  /** ISO-8601 timestamp, UTC (the canonical stored shape). */
  observedAt: string;
  /** Integer minor units, as everywhere else in the Worker. */
  amountCents: number;
  /** Free text from the fare provider -- airline names, so never trusted. */
  label: string;
}

export interface PriceChartOptions {
  currency: string;
  timeZone: string;
  thresholdCents?: number | null;
  lowCents?: number | null;
  title?: string;
}

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 260;
const PADDING_LEFT = 62;
const PADDING_RIGHT = 16;
const PADDING_TOP = 18;
const PADDING_BOTTOM = 34;

/**
 * Ordering key. Canonical stored timestamps would sort as strings, but points
 * can be assembled from older rows; parsing keeps chronology authoritative.
 * An unparseable stamp sorts first rather than throwing -- the chart is
 * presentation, not validation.
 */
function timeValue(observedAt: string): number {
  return parseIsoOrNull(observedAt)?.getTime() ?? Number.NEGATIVE_INFINITY;
}

function partsFor(date: Date, timeZone: string, withTime: boolean): Map<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit", hour12: true } : {}),
  }).formatToParts(date);
  return new Map(parts.map((p) => [p.type, p.value]));
}

/**
 * Python's `%b %-d, %-I:%M %p` ("Aug 3, 2:15 PM"). Assembled from parts
 * because `format()` would insert ICU's narrow no-break space before AM/PM,
 * and because `formatLocal` in time.ts appends a timezone abbreviation the
 * original chart never showed.
 */
function formatStamp(date: Date, timeZone: string): string {
  const get = partsFor(date, timeZone, true);
  return (
    `${get.get("month")} ${get.get("day")}, ` +
    `${get.get("hour")}:${get.get("minute")} ${get.get("dayPeriod")}`
  );
}

/** Python's `%b %-d` ("Aug 3"), for the x axis. */
function formatDay(date: Date, timeZone: string): string {
  const get = partsFor(date, timeZone, false);
  return `${get.get("month")} ${get.get("day")}`;
}

/** Mirror of Python's `f"{value:.1f}"` for pixel coordinates. */
function px(value: number): string {
  return value.toFixed(1);
}

/** Return a self-contained, responsive, accessible SVG string. */
export function renderPriceChart(points: PricePoint[], options: PriceChartOptions): string {
  const {
    currency,
    timeZone,
    thresholdCents = null,
    lowCents = null,
    title = "Observed price history",
  } = options;

  if (points.length === 0) {
    return (
      '<p class="chart-empty">No successful observations yet, so there is nothing ' +
      "to chart.</p>"
    );
  }

  const ordered = [...points].sort((a, b) => timeValue(a.observedAt) - timeValue(b.observedAt));
  const values = ordered.map((p) => p.amountCents / 100);

  // The threshold joins the y-domain so a threshold far above every fare still
  // lands on the canvas instead of silently vanishing.
  const candidates = [...values];
  if (thresholdCents !== null) candidates.push(thresholdCents / 100);
  let yMin = Math.min(...candidates);
  let yMax = Math.max(...candidates);
  if (yMax === yMin) {
    // A flat series still needs vertical room, or every dot sits on one line
    // and the 8% padding below divides by zero span.
    yMax = yMin + Math.max(1.0, yMin * 0.05);
  }
  const span = yMax - yMin;
  yMin -= span * 0.08;
  yMax += span * 0.08;

  const plotW = VIEW_WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const plotH = VIEW_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const xAt = (index: number): number => {
    // A lone observation is centered rather than pinned to the left edge.
    if (ordered.length === 1) return PADDING_LEFT + plotW / 2;
    return PADDING_LEFT + (plotW * index) / (ordered.length - 1);
  };
  const yAt = (value: number): number => {
    const ratio = (value - yMin) / (yMax - yMin);
    return PADDING_TOP + plotH * (1 - ratio);
  };

  const parts: string[] = [];

  // Horizontal gridlines + y labels.
  for (let step = 0; step < 4; step += 1) {
    const value = yMin + ((yMax - yMin) * step) / 3;
    const y = yAt(value);
    parts.push(
      `<line class="grid" x1="${PADDING_LEFT}" y1="${px(y)}" ` +
        `x2="${VIEW_WIDTH - PADDING_RIGHT}" y2="${px(y)}" />`,
    );
    parts.push(
      `<text class="axis" x="${PADDING_LEFT - 8}" y="${px(y + 4)}" text-anchor="end">` +
        `${escapeHtml(formatMoney(Math.round(value * 100), currency))}</text>`,
    );
  }

  if (thresholdCents !== null) {
    const y = yAt(thresholdCents / 100);
    // Defensive: the domain above already contains the threshold, but a future
    // domain tweak must degrade to "no line", never to a line off-canvas.
    if (y >= PADDING_TOP && y <= PADDING_TOP + plotH) {
      parts.push(
        `<line class="threshold" x1="${PADDING_LEFT}" y1="${px(y)}" ` +
          `x2="${VIEW_WIDTH - PADDING_RIGHT}" y2="${px(y)}" />`,
      );
      parts.push(
        `<text class="axis threshold-label" x="${VIEW_WIDTH - PADDING_RIGHT}" ` +
          `y="${px(y - 6)}" text-anchor="end">Threshold</text>`,
      );
    }
  }

  const coords = values.map((v, i) => [xAt(i), yAt(v)] as const);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${px(x)},${px(y)}`).join(" ");
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const area =
    path +
    ` L${px(last[0])},${px(PADDING_TOP + plotH)}` +
    ` L${px(first[0])},${px(PADDING_TOP + plotH)} Z`;
  parts.push(`<path class="area" d="${area}" />`);
  parts.push(`<path class="line" d="${path}" />`);

  // The near-equality window matches Python's float comparison: the stored low
  // and the observation it came from can differ by float noise, never by half
  // a cent or more.
  const lowValue = lowCents !== null ? lowCents / 100 : Math.min(...values);
  for (let i = 0; i < ordered.length; i += 1) {
    const point = ordered[i]!;
    const [x, y] = coords[i]!;
    const isLow = Math.abs(values[i]! - lowValue) < 0.005;
    const cls = isLow ? "dot dot-low" : "dot";
    const stamp = parseIsoOrNull(point.observedAt);
    const stampText = stamp ? formatStamp(stamp, timeZone) : "";
    parts.push(
      `<circle class="${cls}" cx="${px(x)}" cy="${px(y)}" r="${isLow ? "4.5" : "3"}">` +
        `<title>${escapeHtml(formatMoney(point.amountCents, currency))} — ` +
        `${escapeHtml(stampText)} — ${escapeHtml(point.label)}</title></circle>`,
    );
  }

  // X labels: first, middle, last only, so they never collide.
  const labelIndexes = new Set<number>([0, ordered.length - 1]);
  if (ordered.length > 2) labelIndexes.add(Math.floor(ordered.length / 2));
  for (const index of [...labelIndexes].sort((a, b) => a - b)) {
    const stamp = parseIsoOrNull(ordered[index]!.observedAt);
    if (stamp === null) continue;
    const anchor = index === 0 ? "start" : index === ordered.length - 1 ? "end" : "middle";
    // Edge labels hug the frame instead of centering on their dot, so the
    // first and last never overflow the viewBox.
    let x = xAt(index);
    if (anchor === "start") x = PADDING_LEFT;
    else if (anchor === "end") x = VIEW_WIDTH - PADDING_RIGHT;
    parts.push(
      `<text class="axis" x="${px(x)}" y="${VIEW_HEIGHT - 10}" text-anchor="${anchor}">` +
        `${escapeHtml(formatDay(stamp, timeZone))}</text>`,
    );
  }

  const minCents = Math.min(...ordered.map((p) => p.amountCents));
  const maxCents = Math.max(...ordered.map((p) => p.amountCents));
  const description =
    `Line chart of ${ordered.length} observed fares in ${escapeHtml(currency)}, ` +
    `from ${escapeHtml(formatMoney(minCents, currency))} to ` +
    `${escapeHtml(formatMoney(maxCents, currency))}. ` +
    "The same data is listed in the table below.";
  return (
    `<svg class="price-chart" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" ` +
    'preserveAspectRatio="xMidYMid meet" role="img" ' +
    `aria-label="${escapeHtml(title)}. ${description}">` +
    `<desc>${description}</desc>` +
    parts.join("") +
    "</svg>"
  );
}
