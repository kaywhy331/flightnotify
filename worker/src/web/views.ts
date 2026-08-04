/**
 * Page rendering.
 *
 * Ported from the Jinja2 templates, keeping the same markup structure, class
 * names and accessibility affordances so the existing stylesheet and
 * `app.js` apply unchanged: skip link, `aria-current` navigation, `role=status`
 * live regions, and labelled form controls.
 */

import {
  parseJsonColumn,
  type AlertEventRow,
  type CronRunRow,
  type FareObservationRow,
  type FlexibleDateCandidateRow,
  type SearchRunRow,
  type TrackerWithMarkets,
} from "../db/rows.js";
import type { OfferLayover, OfferSegment } from "../providers/types.js";
import {
  ALERT_TYPE_LABELS,
  CABIN_LABELS,
  DateMode,
  DATE_MODE_LABELS,
  DELIVERY_STATE_LABELS,
  FLEX_DURATION_LABELS,
  RUN_STATUS_LABELS,
  STOPS_LABELS,
  TrackerStatus,
} from "../domain/enums.js";
import { formatMoney } from "../domain/money.js";
import { formatDateShort, formatLocal, humanizeDelta, parseIsoOrNull } from "../time.js";
import type { QuotaSnapshot } from "../services/quota.js";
import type { TelegramWebhookInfo } from "../services/telegram.js";
import { humanizeDuration, SCHEDULE_CHOICES } from "../services/planner.js";
import type { FormBudget } from "./tracker-form.js";
import { html, raw, type SafeHtml } from "./html.js";
import { renderAirportDatalist } from "./airports.js";

export interface OperationalStatus {
  environment: string;
  workerVersion: string;
  d1Ok: boolean;
  d1Detail: string;
  schemaVersion: string | null;
  schedulerEnabled: boolean;
  cronSchedule: string;
  lastCron: CronRunRow | null;
  leaseOwnerActive: boolean;
  leaseExpiresAt: string | null;
  nextDueAt: string | null;
  quota: QuotaSnapshot | null;
  serpapiConfigured: boolean;
  telegramConfigured: boolean;
  telegramChatConfigured: boolean;
  telegramWebhookSecretConfigured: boolean;
  telegramHint: string | null;
  trackerCount: number;
  observationCount: number;
  problems: { key: string; detail: string; blocking: boolean }[];
}

function badge(ok: boolean, okText: string, badText: string): SafeHtml {
  return ok
    ? html`<span class="badge badge-ok">${okText}</span>`
    : html`<span class="badge badge-warning">${badText}</span>`;
}

function statusBadge(status: string): SafeHtml {
  if (status === TrackerStatus.ACTIVE) return html`<span class="badge badge-ok">Active</span>`;
  if (status === TrackerStatus.PAUSED) return html`<span class="badge badge-muted">Paused</span>`;
  if (status === TrackerStatus.COMPLETED)
    return html`<span class="badge badge-info">Completed</span>`;
  return html`<span class="badge badge-danger">Error</span>`;
}

/** External links come from provider payloads; render only plain https. */
function safeHttpsLink(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https:\/\//i.test(url.trim()) ? url.trim() : null;
}

/**
 * Tiny inline trend line for the tracker list. Geometry only -- the numbers
 * are in the adjacent cells, so the sparkline carries no information colour
 * alone would.
 */
function sparkline(series: { at: string; cents: number }[] | undefined): SafeHtml {
  const points = (series ?? []).slice(-16);
  if (points.length < 2) return html`<span class="muted small">–</span>`;
  const lo = Math.min(...points.map((p) => p.cents));
  const hi = Math.max(...points.map((p) => p.cents));
  const span = hi === lo ? 1 : hi - lo;
  const coords = points
    .map((point, index) => {
      const x = 2 + (86 * index) / (points.length - 1);
      const y = 20 - (16 * (point.cents - lo)) / span;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const falling = points[points.length - 1]!.cents <= points[0]!.cents;
  return raw(
    `<svg class="sparkline" width="90" height="24" viewBox="0 0 90 24" aria-hidden="true">` +
      `<polyline points="${coords}" fill="none" stroke="${falling ? "#1a7f37" : "#9a6700"}" ` +
      `stroke-width="1.5" /></svg>`,
  );
}

/** A check is overdue once it is a full interval past its scheduled time. */
function isOverdue(t: TrackerWithMarkets, now = new Date()): boolean {
  if (t.status !== TrackerStatus.ACTIVE || t.next_run_at === null) return false;
  const due = parseIsoOrNull(t.next_run_at);
  if (due === null) return false;
  const graceMs = Math.max(t.check_interval_minutes, 15) * 60_000;
  return now.getTime() - due.getTime() > graceMs;
}

function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="csrf_token" value="${token}">`;
}

// ------------------------------------------------------------------ sign in
export function loginPage(args: { error?: string | null; tz: string }): SafeHtml {
  return html`
    <div class="page-head"><h1>Sign in</h1></div>
    <div class="card login-card">
      ${args.error
        ? html`<div class="notice notice-danger" role="alert">${args.error}</div>`
        : raw("")}
      <form method="post" action="/login">
        <div class="field">
          <label for="password">Password</label>
          <input
            type="password"
            id="password"
            name="password"
            required
            autocomplete="current-password"
            autofocus>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">Sign in</button>
        </div>
      </form>
      <p class="hint small">
        FlightNotify is a single-user application. The password is set through the
        <code>AUTH_PASSWORD_HASH</code> Worker secret.
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------- setup page
export function setupPage(problems: { key: string; detail: string; blocking: boolean }[]): SafeHtml {
  return html`
    <div class="page-head"><h1>Setup required</h1></div>
    <div class="notice notice-danger" role="alert">
      FlightNotify will not serve data until the configuration below is complete. Nothing has
      been changed, and any stored data is intact.
    </div>
    <div class="card">
      <ul class="setup-list">
        ${problems.map(
          (p) => html`<li>
            <strong class="mono">${p.key}</strong>
            ${p.blocking ? html`<span class="badge badge-danger">required</span>` : raw("")}
            <div class="small muted">${p.detail}</div>
          </li>`,
        )}
      </ul>
    </div>
  `;
}

// ----------------------------------------------------------------- dashboard
export function dashboardPage(args: {
  status: OperationalStatus;
  trackers: TrackerWithMarkets[];
  recentAlerts: AlertEventRow[];
  tz: string;
  sparklines?: Map<number, { at: string; cents: number }[]>;
}): SafeHtml {
  const { status, trackers, tz } = args;
  const q = status.quota;

  // One line the traveler can skim past; the machinery hides behind it. A
  // problem forces the details open by tone, not by burying prices below it.
  const healthy =
    status.d1Ok && status.problems.filter((p) => p.blocking).length === 0;
  const summaryBits = [
    healthy ? "All systems healthy" : "Attention needed",
    status.schedulerEnabled ? "scheduler on" : "scheduler off",
    status.lastCron ? `last run ${humanizeDelta(status.lastCron.started_at)}` : "no runs yet",
    q ? `${q.remainingSafe} searches left` : "quota unknown",
  ];

  return html`
    <div class="page-head">
      <h1>Dashboard</h1>
      <div class="head-actions">
        <a class="btn btn-small" href="/trackers">All trackers</a>
      </div>
    </div>

    <section class="card" aria-labelledby="trackers-heading">
      <div class="card-head"><h2 id="trackers-heading">Trackers</h2></div>
      ${trackers.length === 0 ? emptyTrackers() : trackerTable(trackers, tz, args.sparklines)}
    </section>

    ${recentAlertsCard(args.recentAlerts, trackers, tz)}

    <section class="card" aria-labelledby="ops-heading">
      <details ${raw(healthy ? "" : "open")}>
        <summary>
          <h2 id="ops-heading" class="inline-heading">Deployment status</h2>
          <span class="small ${healthy ? "muted" : "error-text"}">
            ${summaryBits.join(" · ")}
          </span>
        </summary>
      <dl class="kv">
        <dt>Environment</dt><dd>${status.environment} · Worker ${status.workerVersion}</dd>
        <dt>Database (D1)</dt>
        <dd>
          ${badge(status.d1Ok, "Connected", "Unavailable")}
          <span class="small muted">${status.d1Detail}${status.schemaVersion
            ? html` Schema v${status.schemaVersion}.`
            : raw("")}</span>
        </dd>
        <dt>Scheduler</dt>
        <dd>
          ${status.schedulerEnabled
            ? html`<span class="badge badge-ok">Enabled</span>`
            : html`<span class="badge badge-muted">Disabled</span>`}
          <span class="small muted">Cron ${status.cronSchedule} (UTC).</span>
        </dd>
        <dt>Last Cron run</dt>
        <dd>
          ${status.lastCron
            ? html`${formatLocal(status.lastCron.started_at, tz)} ·
                <span class="mono">${status.lastCron.outcome}</span>
                <div class="small muted">${status.lastCron.detail ?? ""}</div>`
            : html`<span class="muted">No Cron invocation recorded yet.</span>`}
        </dd>
        <dt>Scheduler lease</dt>
        <dd>
          ${status.leaseOwnerActive
            ? html`<span class="badge badge-info">Held</span>
                <span class="small muted">until ${formatLocal(status.leaseExpiresAt, tz)}</span>`
            : html`<span class="muted">Free</span>`}
        </dd>
        <dt>Next due search</dt>
        <dd>
          ${status.nextDueAt
            ? html`${formatLocal(status.nextDueAt, tz)}
                <span class="small muted">(${humanizeDelta(status.nextDueAt)})</span>`
            : html`<span class="muted">Nothing scheduled.</span>`}
        </dd>
        <dt>SerpApi</dt>
        <dd>
          ${badge(status.serpapiConfigured, "Live", "Not configured")}
          ${q
            ? html`<span class="small muted">
                ${q.effectiveUsed}/${q.monthlyLimit} used this period (${q.period}),
                ${q.remainingSafe} available to automation, ${q.reserve} reserved.
              </span>`
            : raw("")}
        </dd>
        <dt>Telegram</dt>
        <dd>
          ${badge(
            status.telegramConfigured && status.telegramChatConfigured,
            "Ready",
            status.telegramConfigured ? "No chat id" : "Not configured",
          )}
          ${status.telegramHint
            ? html`<span class="small muted">${status.telegramHint}</span>`
            : raw("")}
        </dd>
        <dt>Stored records</dt>
        <dd>${status.trackerCount} tracker(s), ${status.observationCount} observation(s)</dd>
      </dl>

      ${status.problems.length > 0
        ? html`<div class="notice notice-warning">
            <strong>Configuration notes</strong>
            <ul>
              ${status.problems.map((p) => html`<li><span class="mono">${p.key}</span>: ${p.detail}</li>`)}
            </ul>
          </div>`
        : raw("")}
      </details>
    </section>
  `;
}

/**
 * What was actually said, and to whom it got through.
 *
 * The dashboard already fetched these; showing them answers "did FlightNotify
 * message me and I missed it?" without opening each tracker in turn. Absent
 * entirely when there is nothing to show, so a quiet deployment is not given a
 * permanently empty table.
 */
function recentAlertsCard(
  alerts: AlertEventRow[],
  trackers: TrackerWithMarkets[],
  tz: string,
): SafeHtml {
  if (alerts.length === 0) return raw("");
  const byId = new Map(trackers.map((t) => [t.id, t]));

  return html`
    <section class="card" aria-labelledby="recent-alerts-heading">
      <div class="card-head"><h2 id="recent-alerts-heading">Recent alerts</h2></div>
      <table class="stacked">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Tracker</th>
            <th scope="col">Type</th>
            <th scope="col">Delivery</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          ${alerts.map((a) => {
            // A tracker can be deleted while its alert history is kept, so the
            // row has to survive the lookup failing rather than omit the alert.
            const tracker = a.tracker_id === null ? undefined : byId.get(a.tracker_id);
            return html`
              <tr>
                <td class="nowrap small" data-label="When">${formatLocal(a.created_at, tz)}</td>
                <td data-label="Tracker">
                  ${tracker
                    ? html`<a href="/trackers/${tracker.id}">${tracker.name}</a>`
                    : html`<span class="muted">deleted tracker</span>`}
                </td>
                <td class="small" data-label="Type">${ALERT_TYPE_LABELS[a.alert_type] ?? a.alert_type}</td>
                <td class="small" data-label="Delivery">
                  ${DELIVERY_STATE_LABELS[a.delivery_state] ?? a.delivery_state}
                </td>
                <td class="small detail-col" data-label="Message">${firstLine(a.message_text)}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </section>
  `;
}

/**
 * The opening line of an alert body, cut to a width a table row can hold.
 *
 * The stored text is Telegram HTML, so it goes through the escaping template
 * like any other string: the tags are shown, never rendered.
 */
function firstLine(text: string, limit = 80): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function emptyTrackers(): SafeHtml {
  return html`
    <div class="empty-state">
      <p>No trackers yet.</p>
      <a class="btn btn-primary" href="/trackers/new">Create your first tracker</a>
    </div>
  `;
}

function trackerTable(
  trackers: TrackerWithMarkets[],
  tz: string,
  sparklines?: Map<number, { at: string; cents: number }[]>,
): SafeHtml {
  return html`
    <table class="stacked">
      <thead>
        <tr>
          <th scope="col">Tracker</th>
          <th scope="col">Route</th>
          <th scope="col">Dates</th>
          <th scope="col" class="num">Latest</th>
          <th scope="col"><span class="visually-hidden">Trend</span></th>
          <th scope="col" class="num">Observed low</th>
          <th scope="col" class="num">Threshold</th>
          <th scope="col">Next check</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        ${trackers.map(
          (t) => html`
            <tr>
              <td data-label="Tracker"><a href="/trackers/${t.id}">${t.name}</a></td>
              <td class="nowrap" data-label="Route">${t.origin} → ${t.destination}</td>
              <td class="nowrap small" data-label="Dates">${describeDates(t)}</td>
              <td class="num" data-label="Latest">${formatMoney(t.latest_price_cents, t.currency)}</td>
              <td data-label="Trend">${sparkline(sparklines?.get(t.id))}</td>
              <td class="num" data-label="Observed low">${formatMoney(t.low_price_cents, t.currency)}</td>
              <td class="num" data-label="Threshold">${formatMoney(t.threshold_amount_cents, t.currency)}</td>
              <td class="nowrap small" data-label="Next check">
                ${humanizeDelta(t.next_run_at)}
                ${isOverdue(t)
                  ? html` <span class="badge badge-warning">overdue</span>`
                  : raw("")}
              </td>
              <td data-label="Status">${statusBadge(t.status)}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
    <p class="disclaimer small">
      "Observed low" is the lowest fare FlightNotify has seen for the tracker's current
      configuration. It is not a prediction and not a guaranteed minimum.
    </p>
    ${raw(tz ? "" : "")}
  `;
}

export function describeDates(t: TrackerWithMarkets): string {
  if (t.date_mode === "exact") {
    return `${formatDateShort(t.outbound_date)} – ${formatDateShort(t.return_date)}`;
  }
  if (t.date_mode === "flexible_preset") {
    return `${t.flex_month ?? "?"}/${t.flex_year ?? "?"} · ${t.flex_duration ?? ""}`;
  }
  return `${formatDateShort(t.window_outbound_start)} – ${formatDateShort(t.window_outbound_end)}`;
}

// ------------------------------------------------------------ tracker list
export function trackersPage(args: { trackers: TrackerWithMarkets[]; tz: string }): SafeHtml {
  return html`
    <div class="page-head">
      <h1>Trackers</h1>
      <div class="head-actions">
        <a class="btn btn-primary btn-small" href="/trackers/new">New tracker</a>
      </div>
    </div>
    <section class="card">
      ${args.trackers.length === 0 ? emptyTrackers() : trackerTable(args.trackers, args.tz)}
    </section>
  `;
}

// ---------------------------------------------------------- tracker detail
export interface PriceContext {
  /** Latest best-of-run minus the previous one; negative means falling. */
  trendCents: number | null;
  rangeLoCents: number | null;
  rangeHiCents: number | null;
  observationCount: number;
  /** Observations that came within 15% of the threshold. */
  nearThresholdCount: number;
  /** Suggested threshold when the configured one looks unreachable. */
  suggestedThresholdCents: number | null;
}

export function trackerDetailPage(args: {
  tracker: TrackerWithMarkets;
  observations: FareObservationRow[];
  latestObservation?: FareObservationRow | null;
  runs: SearchRunRow[];
  alerts: AlertEventRow[];
  csrf: string;
  tz: string;
  quotaBlocked: boolean;
  context?: PriceContext | null;
  /** Server-rendered SVG for the price history; already safe markup. */
  chartSvg?: string | null;
  candidates?: FlexibleDateCandidateRow[];
  candidateCoverage?: { checked: number; total: number } | null;
  historyPage?: number;
  historyPageSize?: number;
  historyTotal?: number;
  maxProviderRequestsPerSearch?: number;
}): SafeHtml {
  const { tracker: t, observations, runs, alerts, csrf, tz } = args;
  const latest = args.latestObservation ?? observations[0];
  const latestLink = safeHttpsLink(latest?.booking_link ?? latest?.search_link);
  const completed = t.status === TrackerStatus.COMPLETED;
  const marketsPerScan = Math.max(1, t.markets.length);
  const pairsPerScan =
    t.date_mode === DateMode.CUSTOM_WINDOW ? Math.max(1, t.candidates_per_run) : 1;
  const plannedCallsPerScan = pairsPerScan * marketsPerScan;
  const maxCallsPerScan =
    plannedCallsPerScan * Math.max(1, args.maxProviderRequestsPerSearch ?? 1);

  return html`
    <div class="page-head">
      <h1>${t.name}</h1>
      <div class="head-actions">
        <a class="btn btn-small" href="/trackers/${t.id}/edit">Edit</a>
        <form method="post" action="/trackers/${t.id}/duplicate" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn btn-small" type="submit">Duplicate</button>
        </form>
        ${completed
          ? raw("")
          : html`<form method="post" action="/trackers/${t.id}/toggle" class="inline-fields">
              ${csrfField(csrf)}
              <button class="btn btn-small" type="submit">
                ${t.status === TrackerStatus.ACTIVE ? "Pause" : "Resume"}
              </button>
            </form>`}
        <details class="delete-confirm">
          <summary class="btn btn-small btn-danger">Delete</summary>
          <div class="confirm-panel">
            <p>Delete this tracker and all of its price history? This cannot be undone.</p>
            <form method="post" action="/trackers/${t.id}/delete" class="btn-row">
              ${csrfField(csrf)}
              <button class="btn btn-small btn-danger" type="submit">Confirm delete</button>
            </form>
          </div>
        </details>
      </div>
    </div>

    <section class="card">
      ${completed
        ? html`<div class="notice notice-info">
            The travel dates for this tracker have passed, so scheduled checks have stopped
            and no quota is being spent. The price history below is preserved. Edit the
            tracker with future dates to start tracking again.
          </div>`
        : raw("")}
      <div class="headline-price">
        <div>
          <div class="small muted">Latest observed</div>
          <div class="num">
            ${latestLink
              ? html`<a href="${latestLink}" target="_blank" rel="noopener noreferrer"
                    >${formatMoney(t.latest_price_cents, t.currency)}</a>`
              : formatMoney(t.latest_price_cents, t.currency)}
          </div>
          ${latestLink
            ? html`<a class="small" href="${latestLink}" target="_blank"
                  rel="noopener noreferrer">Open on Google Flights ↗</a>`
            : raw("")}
        </div>
        <div>
          <div class="small muted">Observed low</div>
          <div class="num">${formatMoney(t.low_price_cents, t.currency)}</div>
        </div>
        <div>
          <div class="small muted">Threshold</div>
          <div class="num">${formatMoney(t.threshold_amount_cents, t.currency)}</div>
        </div>
      </div>

      ${priceContextBlock(args.context ?? null, t)}

      <dl class="kv">
        <dt>Status</dt><dd>${statusBadge(t.status)}</dd>
        <dt>Route</dt><dd>${t.origin} → ${t.destination}</dd>
        <dt>Dates</dt><dd>${DATE_MODE_LABELS[t.date_mode] ?? t.date_mode} · ${describeDates(t)}</dd>
        <dt>Passengers</dt>
        <dd>${t.adults} adult(s)${t.children ? `, ${t.children} child(ren)` : ""}</dd>
        <dt>Cabin</dt><dd>${CABIN_LABELS[t.cabin] ?? t.cabin}</dd>
        <dt>Stops</dt><dd>${STOPS_LABELS[t.stops] ?? t.stops}</dd>
        <dt>Markets</dt><dd>${t.markets.join(", ") || "us"}</dd>
        <dt>Checks</dt>
        <dd>every ${t.check_interval_minutes} minutes · next ${humanizeDelta(t.next_run_at)}</dd>
        <dt>Last success</dt><dd>${formatLocal(t.last_success_at, tz)}</dd>
        ${t.last_error_message
          ? html`<dt>Last error</dt>
              <dd><span class="badge badge-danger">${t.last_error_category}</span>
                <div class="small">${t.last_error_message}</div></dd>`
          : raw("")}
      </dl>

      ${completed
        ? raw("")
        : html`<form method="post" action="/trackers/${t.id}/check" class="btn-row">
            ${csrfField(csrf)}
            <button class="btn btn-primary" type="submit"
                    ${raw(args.quotaBlocked ? "disabled" : "")}>
              Check now
            </button>
            <label class="check-row small">
              <input type="checkbox" name="force_refresh" value="1">
              <span>Force fresh results (skip the 15-minute cache)</span>
            </label>
            ${args.quotaBlocked
              ? html`<span class="hint small">
                  The provider allowance is exhausted, so a manual check is unavailable.
                </span>`
              : html`<span class="hint small">
                  A fresh scan plans <strong>${plannedCallsPerScan}</strong> provider search(es)
                  (${pairsPerScan} date pair(s) × ${marketsPerScan} market(s)).
                  ${maxCallsPerScan > plannedCallsPerScan
                    ? html`It needs quota room for up to <strong>${maxCallsPerScan}</strong>
                        provider calls in case bounded retries are needed.`
                    : raw("")}
                  ${t.last_success_at
                    ? html` Last successful check ${humanizeDelta(t.last_success_at)}.`
                    : raw("")}
                </span>`}
          </form>`}
    </section>

    ${cheapestDatesCard(t, args.candidates ?? [], args.candidateCoverage ?? null)}

    <section class="card" aria-labelledby="history-heading">
      <div class="card-head"><h2 id="history-heading">Price history</h2></div>
      ${args.chartSvg ? html`<div class="chart-frame">${raw(args.chartSvg)}</div>` : raw("")}
      ${observations.length === 0
        ? html`<div class="empty-state"><p>No observations recorded yet.</p></div>`
        : html`
            <table class="stacked">
              <thead>
                <tr>
                  <th scope="col">Observed</th>
                  <th scope="col" class="num">Price</th>
                  <th scope="col">Airlines</th>
                  <th scope="col" class="num">Stops</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Market</th>
                  <th scope="col">Itinerary</th>
                  <th scope="col"><span class="visually-hidden">Booking link</span></th>
                </tr>
              </thead>
              <tbody>
                ${observations.map(
                  (o) => html`
                    <tr>
                      <td class="nowrap small" data-label="Observed">${formatLocal(o.observed_at, tz)}</td>
                      <td class="num" data-label="Price">${formatMoney(o.price_amount_cents, o.currency)}</td>
                      <td class="small" data-label="Airlines">${safeList(o.airlines)}</td>
                      <td class="num" data-label="Stops">${o.stops ?? "-"}</td>
                      <td class="nowrap small" data-label="Dates">
                        ${formatDateShort(o.outbound_date)} – ${formatDateShort(o.return_date)}
                      </td>
                      <td class="small" data-label="Market">${o.market}</td>
                      <td class="small itinerary-col" data-label="Itinerary">${itineraryDetails(o)}</td>
                      <td class="small" data-label="Booking link">
                        ${(() => {
                          const link = safeHttpsLink(o.booking_link ?? o.search_link);
                          return link
                            ? html`<a href="${link}" target="_blank"
                                  rel="noopener noreferrer">Open ↗</a>`
                            : raw("");
                        })()}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            ${(() => {
              const page = args.historyPage ?? 1;
              const size = args.historyPageSize ?? 50;
              const total = args.historyTotal ?? observations.length;
              if (total <= size) return raw("");
              const maxPage = Math.max(1, Math.ceil(total / size));
              return html`<nav class="pager" aria-label="Price history pages">
                ${page > 1
                  ? html`<a class="btn btn-small"
                        href="/trackers/${t.id}?page=${page - 1}#history-heading">Newer</a>`
                  : raw("")}
                <span class="small muted">Page ${page} of ${maxPage} · ${total} observations</span>
                ${page < maxPage
                  ? html`<a class="btn btn-small"
                        href="/trackers/${t.id}?page=${page + 1}#history-heading">Older</a>`
                  : raw("")}
              </nav>`;
            })()}
          `}
    </section>

    <section class="card" aria-labelledby="runs-heading">
      <div class="card-head"><h2 id="runs-heading">Recent checks</h2></div>
      ${runs.length === 0
        ? html`<div class="empty-state"><p>No checks recorded yet.</p></div>`
        : html`
            <table class="stacked">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="num">Offers</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (r) => html`
                    <tr>
                      <td class="nowrap small" data-label="Started">${formatLocal(r.started_at, tz)}</td>
                      <td class="small" data-label="Trigger">${r.trigger}</td>
                      <td class="small" data-label="Status">${RUN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td class="num" data-label="Offers">${r.offers_found}</td>
                      <td class="small" data-label="Detail">${r.error_message ?? r.skip_reason ?? ""}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>

    <section class="card" aria-labelledby="alerts-heading">
      <div class="card-head"><h2 id="alerts-heading">Alerts</h2></div>
      ${alerts.length === 0
        ? html`<div class="empty-state"><p>No alerts recorded yet.</p></div>`
        : html`
            <table class="stacked">
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Type</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                ${alerts.map(
                  (a) => html`
                    <tr>
                      <td class="nowrap small" data-label="Created">${formatLocal(a.created_at, tz)}</td>
                      <td class="small" data-label="Type">${ALERT_TYPE_LABELS[a.alert_type] ?? a.alert_type}</td>
                      <td class="small" data-label="Delivery">
                        ${DELIVERY_STATE_LABELS[a.delivery_state] ?? a.delivery_state}
                      </td>
                      <td class="small" data-label="Detail">${a.last_error ?? ""}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>
  `;
}

/**
 * "Should I book?" context. Every statement is about what was observed, never
 * a prediction -- that stance is the product's spine and stays intact here.
 */
function priceContextBlock(context: PriceContext | null, t: TrackerWithMarkets): SafeHtml {
  if (context === null || context.observationCount < 2) return raw("");

  const bits: SafeHtml[] = [];
  if (context.trendCents !== null && context.trendCents !== 0) {
    const falling = context.trendCents < 0;
    bits.push(
      html`<span>${falling ? "↓" : "↑"}
        ${formatMoney(Math.abs(context.trendCents), t.currency)} since the previous check</span>`,
    );
  }
  if (context.rangeLoCents !== null && context.rangeHiCents !== null) {
    const nearLow =
      t.latest_price_cents !== null &&
      context.rangeHiCents > context.rangeLoCents &&
      t.latest_price_cents - context.rangeLoCents <=
        (context.rangeHiCents - context.rangeLoCents) * 0.2;
    bits.push(
      html`<span>
        ${nearLow ? "near the observed low — " : ""}range
        ${formatMoney(context.rangeLoCents, t.currency)}–${formatMoney(
          context.rangeHiCents,
          t.currency,
        )}
        over ${context.observationCount} observations</span>`,
    );
  }

  const hint =
    context.nearThresholdCount === 0 && context.suggestedThresholdCents !== null
      ? html`<p class="hint small">
          None of the ${context.observationCount} observations has come within 15% of your
          ${formatMoney(t.threshold_amount_cents, t.currency)} threshold. Based on the observed
          low, a threshold around ${formatMoney(context.suggestedThresholdCents, t.currency)}
          would be reachable — or keep the current one if it reflects the most you would pay.
        </p>`
      : raw("");

  if (bits.length === 0 && hint.toString() === "") return raw("");
  return html`
    <div class="small muted" role="status">
      ${bits.map((bit, index) => (index === 0 ? bit : html` · ${bit}`))}
    </div>
    ${hint}
  `;
}

/**
 * The answer a flexible window exists to produce: which dates are cheapest.
 * Data comes straight from the sweep's own progress rows.
 */
function cheapestDatesCard(
  t: TrackerWithMarkets,
  candidates: FlexibleDateCandidateRow[],
  coverage: { checked: number; total: number } | null,
): SafeHtml {
  if (t.date_mode !== "custom_window") return raw("");

  const progress =
    coverage && coverage.total > 0
      ? `${coverage.checked} of ${coverage.total} date combinations checked in this sweep ` +
        `(cycle ${t.coverage_cycle}).`
      : "The first sweep has not started yet.";

  return html`
    <section class="card" aria-labelledby="dates-heading">
      <div class="card-head"><h2 id="dates-heading">Cheapest dates so far</h2></div>
      <p class="small muted">${progress}</p>
      ${candidates.length === 0
        ? html`<div class="empty-state">
            <p>No date combination has a recorded price yet. Prices appear here as the
            sweep works through the window.</p>
          </div>`
        : html`
            <table class="stacked">
              <thead>
                <tr>
                  <th scope="col">Depart</th>
                  <th scope="col">Return</th>
                  <th scope="col" class="num">Nights</th>
                  <th scope="col" class="num">Last seen price</th>
                  <th scope="col">Checked</th>
                </tr>
              </thead>
              <tbody>
                ${candidates.map(
                  (c, index) => html`
                    <tr>
                      <td class="nowrap" data-label="Depart">${formatDateShort(c.outbound_date)}
                        ${index === 0
                          ? html` <span class="badge badge-ok">cheapest</span>`
                          : raw("")}</td>
                      <td class="nowrap" data-label="Return">${formatDateShort(c.return_date)}</td>
                      <td class="num" data-label="Nights">${c.nights}</td>
                      <td class="num" data-label="Last seen price">${formatMoney(c.last_price_cents, t.currency)}</td>
                      <td class="nowrap small" data-label="Checked">${humanizeDelta(c.last_checked_at)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
            <p class="disclaimer small">
              Prices were observed at different times, so they are a guide to which dates
              tend to be cheaper, not simultaneous quotes.
            </p>
          `}
    </section>
  `;
}

/**
 * The itinerary an observation already stored but never showed.
 *
 * Every field here is optional in practice -- the provider omits some of them,
 * and rows imported from the Python app predate others -- so nothing is
 * assumed present and a row with no itinerary detail renders as nothing at all
 * rather than as an empty disclosure. A native `<details>` keeps the table
 * scannable without any JavaScript.
 */
function itineraryDetails(o: FareObservationRow): SafeHtml {
  const segments = jsonArray<OfferSegment>(o.segments);
  const layovers = jsonArray<OfferLayover>(o.layovers);
  const total = formatFlightDuration(o.duration_minutes);
  const hasTimes = Boolean(o.departure_time || o.arrival_time);

  if (!hasTimes && total === null && segments.length === 0 && layovers.length === 0) {
    return raw("");
  }

  const headline = [
    hasTimes ? `${o.departure_time ?? "?"} → ${o.arrival_time ?? "?"}` : null,
    total,
  ].filter(isNonEmpty);

  return html`
    <details class="itinerary">
      <summary>Details</summary>
      ${headline.length > 0 ? html`<div class="itinerary-head">${headline.join(" · ")}</div>` : raw("")}
      ${segments.length > 0
        ? html`<ul class="itinerary-lines">
            ${segments.map((s) => html`<li>${segmentLine(s)}</li>`)}
          </ul>`
        : raw("")}
      ${layovers.length > 0
        ? html`<ul class="itinerary-lines">
            ${layovers.map((l) => html`<li>${layoverLine(l)}</li>`)}
          </ul>`
        : raw("")}
    </details>
  `;
}

/** A stored JSON column that should hold a list; anything else reads as empty. */
function jsonArray<T>(json: string | null): T[] {
  const parsed = parseJsonColumn<unknown>(json);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** One flight leg on one line, built from whichever fields the provider gave. */
function segmentLine(segment: OfferSegment): string {
  const carrier = [segment.airline, segment.flight_number].filter(isNonEmpty).join(" ");
  const route = [segment.departure_id, segment.arrival_id].filter(isNonEmpty).join(" → ");
  const times = [segment.departure_time, segment.arrival_time].filter(isNonEmpty).join(" → ");
  const parts = [carrier, route, times].filter(isNonEmpty);
  const duration = formatFlightDuration(segment.duration_minutes);
  if (duration !== null) parts.push(duration);
  if (segment.overnight) parts.push("overnight");
  return parts.length > 0 ? parts.join(" · ") : "Flight segment (no detail recorded)";
}

function layoverLine(layover: OfferLayover): string {
  const where = [layover.name, layover.id].find(isNonEmpty) ?? "unknown airport";
  const duration = formatFlightDuration(layover.duration_minutes);
  return (
    `Layover: ${where}` +
    (duration === null ? "" : ` (${duration})`) +
    (layover.overnight ? " · overnight" : "")
  );
}

/**
 * Flight durations as "11h 25m". `humanizeDuration` is for schedule intervals
 * and would render the same value as "11.4 hours", which is not how anyone
 * reads a flight time.
 */
function formatFlightDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return hours === 0 ? `${rest}m` : `${hours}h ${rest}m`;
}

function safeList(json: string | null): string {
  if (!json) return "-";
  try {
    const parsed = JSON.parse(json) as string[];
    return parsed.length ? parsed.join(", ") : "-";
  } catch {
    return "-";
  }
}

// ------------------------------------------------------------ tracker form
export interface TrackerFormViewArgs {
  trackerId: number | null;
  errors: Record<string, string>;
  values: Record<string, string>;
  csrf: string;
  today: string;
  budget: FormBudget | null;
  /** Markets offered as checkboxes. */
  availableMarkets: string[];
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Create/edit form.
 *
 * The markup deliberately matches the hooks the existing `app.js` already
 * looks for -- `input[name="date_mode"]`, `[data-date-group]`,
 * `[data-estimate-url]`, `#budget-estimate`, `#sampled-mode-row` -- so the
 * mode switching and the live budget preview work with the stylesheet and
 * script carried over unchanged. Everything it does is also rendered
 * server-side, so the form is fully usable with JavaScript disabled.
 */
export function trackerFormPage(args: TrackerFormViewArgs): SafeHtml {
  const editing = args.trackerId !== null;
  const v = (key: string, fallback = ""): string => args.values[key] ?? fallback;
  const err = (key: string): SafeHtml =>
    args.errors[key]
      ? html`<p class="error-text" id="${key}-error">${args.errors[key]}</p>`
      : raw("");
  const invalid = (key: string): SafeHtml =>
    args.errors[key] ? raw(`aria-invalid="true" aria-describedby="${key}-error"`) : raw("");

  const mode = v("date_mode", "exact");
  const selectedMarkets = new Set(v("markets", "us").split(",").filter(Boolean));
  const hiddenUnless = (value: string): SafeHtml => (mode === value ? raw("") : raw("hidden"));

  return html`
    <div class="page-head">
      <h1>${editing ? "Edit tracker" : "New tracker"}</h1>
    </div>

    ${Object.keys(args.errors).length > 0
      ? html`<div class="notice notice-danger error-summary" role="alert">
          <strong>That could not be saved.</strong> Nothing was changed. Please correct the
          highlighted fields.
        </div>`
      : raw("")}

    <form method="post" action="${editing ? `/trackers/${args.trackerId}` : "/trackers"}"
          class="card" data-estimate-url="/api/estimate">
      ${csrfField(args.csrf)}

      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" required maxlength="120" value="${v("name")}" ${invalid("name")}>
        ${err("name")}
      </div>

      <div class="inline-fields">
        <div class="field">
          <label for="origin">Origin (IATA)</label>
          <input id="origin" name="origin" required maxlength="3" value="${v("origin")}"
                 autocapitalize="characters" list="airport-codes" ${invalid("origin")}>
          ${err("origin")}
        </div>
        <div class="field">
          <label for="destination">Destination (IATA)</label>
          <input id="destination" name="destination" required maxlength="3"
                 value="${v("destination")}" autocapitalize="characters" list="airport-codes"
                 ${invalid("destination")}>
          ${err("destination")}
        </div>
      </div>
      ${raw(renderAirportDatalist("airport-codes"))}

      <!-- ----------------------------------------------------------- dates -->
      <fieldset class="field">
        <legend id="date-mode-label">Dates</legend>
        <div id="date_mode" role="radiogroup" aria-labelledby="date-mode-label">
          ${(
            [
              ["exact", "Exact dates", "One departure and one return."],
              ["flexible_preset", "Flexible preset", "A whole month and a trip length, in one provider call."],
              ["custom_window", "Custom flexible window", "Departure and return ranges, swept across runs."],
            ] as [string, string, string][]
          ).map(
            ([value, label, hint]) => html`
              <label class="check-row" for="mode-${value}">
                <input type="radio" id="mode-${value}" name="date_mode" value="${value}"
                       ${raw(mode === value ? "checked" : "")}>
                <span>
                  <strong>${label}</strong>
                  <span class="small muted"> ${hint}</span>
                </span>
              </label>
            `,
          )}
        </div>
        ${err("date_mode")}

        <div data-date-group="exact" ${hiddenUnless("exact")}>
          <div class="inline-fields">
            <div class="field">
              <label for="outbound_date">Outbound date</label>
              <input type="date" id="outbound_date" name="outbound_date" min="${args.today}"
                     value="${v("outbound_date")}" ${invalid("outbound_date")}>
              ${err("outbound_date")}
            </div>
            <div class="field">
              <label for="return_date">Return date</label>
              <input type="date" id="return_date" name="return_date" min="${args.today}"
                     value="${v("return_date")}" ${invalid("return_date")}>
              ${err("return_date")}
            </div>
          </div>
        </div>

        <div data-date-group="flexible_preset" ${hiddenUnless("flexible_preset")}>
          <div class="inline-fields">
            <div class="field">
              <label for="flex_month">Travel month</label>
              <select id="flex_month" name="flex_month" ${invalid("flex_month")}>
                <option value="">Choose a month</option>
                ${MONTH_NAMES.map(
                  (label, index) =>
                    html`<option value="${index + 1}"
                            ${raw(v("flex_month") === String(index + 1) ? "selected" : "")}>
                      ${label}
                    </option>`,
                )}
              </select>
              ${err("flex_month")}
            </div>
            <div class="field">
              <label for="flex_year">Year</label>
              <input type="number" id="flex_year" name="flex_year" min="2000" max="2100"
                     value="${v("flex_year", args.today.slice(0, 4))}" ${invalid("flex_year")}>
              ${err("flex_year")}
            </div>
            <div class="field">
              <label for="flex_duration">Trip length</label>
              <select id="flex_duration" name="flex_duration" ${invalid("flex_duration")}>
                <option value="">Choose a length</option>
                ${Object.entries(FLEX_DURATION_LABELS).map(
                  ([key, label]) =>
                    html`<option value="${key}" ${raw(v("flex_duration") === key ? "selected" : "")}>
                      ${label}
                    </option>`,
                )}
              </select>
              ${err("flex_duration")}
            </div>
          </div>
          <p class="hint small">
            Google Travel Explore only looks ahead six months, and answers the whole month in a
            single provider search.
          </p>
        </div>

        <div data-date-group="custom_window" ${hiddenUnless("custom_window")}>
          <div class="inline-fields">
            <div class="field">
              <label for="window_outbound_start">Earliest departure</label>
              <input type="date" id="window_outbound_start" name="window_outbound_start"
                     min="${args.today}" value="${v("window_outbound_start")}"
                     ${invalid("window_outbound_start")}>
              ${err("window_outbound_start")}
            </div>
            <div class="field">
              <label for="window_outbound_end">Latest departure</label>
              <input type="date" id="window_outbound_end" name="window_outbound_end"
                     min="${args.today}" value="${v("window_outbound_end")}"
                     ${invalid("window_outbound_end")}>
              ${err("window_outbound_end")}
            </div>
          </div>
          <p class="hint small">
            Set either a return window or a trip-length range. If you set both, the trip length
            filters the return window.
          </p>
          <div class="inline-fields">
            <div class="field">
              <label for="window_return_start">Earliest return</label>
              <input type="date" id="window_return_start" name="window_return_start"
                     min="${args.today}" value="${v("window_return_start")}"
                     ${invalid("window_return_start")}>
              ${err("window_return_start")}
            </div>
            <div class="field">
              <label for="window_return_end">Latest return</label>
              <input type="date" id="window_return_end" name="window_return_end"
                     min="${args.today}" value="${v("window_return_end")}"
                     ${invalid("window_return_end")}>
              ${err("window_return_end")}
            </div>
          </div>
          <div class="inline-fields">
            <div class="field">
              <label for="min_nights">Minimum nights</label>
              <input type="number" id="min_nights" name="min_nights" min="1" max="60"
                     value="${v("min_nights")}" ${invalid("min_nights")}>
              ${err("min_nights")}
            </div>
            <div class="field">
              <label for="max_nights">Maximum nights</label>
              <input type="number" id="max_nights" name="max_nights" min="1" max="60"
                     value="${v("max_nights")}" ${invalid("max_nights")}>
              ${err("max_nights")}
            </div>
            <div class="field">
              <label for="candidates_per_run">Date pairs checked per run</label>
              <input type="number" id="candidates_per_run" name="candidates_per_run" min="1"
                     max="10" value="${v("candidates_per_run", "1")}">
              <p class="hint small">
                Each pair costs one provider search per market. A sweep resumes where the last
                run stopped.
              </p>
            </div>
          </div>
        </div>
      </fieldset>

      <!-- --------------------------------------------------------- markets -->
      <fieldset class="field">
        <legend>Country markets</legend>
        <div class="market-grid">
          ${args.availableMarkets.map(
            (market) => html`
              <label class="check-row" for="market-${market}">
                <input type="checkbox" id="market-${market}" name="markets" value="${market}"
                       ${raw(selectedMarkets.has(market) ? "checked" : "")}>
                <span>${market.toUpperCase()}</span>
              </label>
            `,
          )}
        </div>
        <p class="hint small">Every extra market multiplies the number of provider searches.</p>
        ${err("markets")}
      </fieldset>

      <!-- ------------------------------------------------------ comparison -->
      <div class="inline-fields">
        <div class="field">
          <label for="threshold_amount">Alert threshold</label>
          <input id="threshold_amount" name="threshold_amount" required inputmode="decimal"
                 value="${v("threshold_amount")}" aria-describedby="threshold-hint"
                 ${invalid("threshold_amount")}>
          <p class="hint small" id="threshold-hint">In the tracker's currency.</p>
          ${err("threshold_amount")}
        </div>
        <div class="field">
          <label for="threshold_basis">Threshold applies to</label>
          <select id="threshold_basis" name="threshold_basis">
            <option value="party" ${raw(v("threshold_basis", "party") === "party" ? "selected" : "")}>
              Whole party
            </option>
            <option value="per_traveler"
                    ${raw(v("threshold_basis") === "per_traveler" ? "selected" : "")}>
              Per traveler
            </option>
          </select>
        </div>
        <div class="field">
          <label for="currency">Currency</label>
          <input id="currency" name="currency" maxlength="3" value="${v("currency", "USD")}"
                 ${invalid("currency")}>
          ${err("currency")}
        </div>
        <div class="field">
          <label for="check_interval_minutes">Check every</label>
          <select id="check_interval_minutes" name="check_interval_minutes"
                  ${invalid("check_interval_minutes")}>
            ${SCHEDULE_CHOICES.map(
              ([minutes, label]) =>
                html`<option value="${minutes}"
                        ${raw(v("check_interval_minutes", "720") === String(minutes) ? "selected" : "")}>
                  ${label}
                </option>`,
            )}
          </select>
          ${err("check_interval_minutes")}
        </div>
      </div>

      <div class="inline-fields">
        <div class="field">
          <label for="adults">Adults</label>
          <input type="number" id="adults" name="adults" min="1" max="9"
                 value="${v("adults", "1")}" ${invalid("adults")}>
          ${err("adults")}
        </div>
        <div class="field">
          <label for="children">Children</label>
          <input type="number" id="children" name="children" min="0" max="8"
                 value="${v("children", "0")}" ${invalid("children")}>
          ${err("children")}
        </div>
        <div class="field">
          <label for="infants_in_seat">Infants in seat</label>
          <input type="number" id="infants_in_seat" name="infants_in_seat" min="0" max="4"
                 value="${v("infants_in_seat", "0")}" ${invalid("infants_in_seat")}>
          ${err("infants_in_seat")}
        </div>
        <div class="field">
          <label for="infants_on_lap">Lap infants</label>
          <input type="number" id="infants_on_lap" name="infants_on_lap" min="0" max="4"
                 value="${v("infants_on_lap", "0")}" ${invalid("infants_on_lap")}>
          ${err("infants_on_lap")}
        </div>
        <div class="field">
          <label for="cabin">Cabin</label>
          <select id="cabin" name="cabin">
            ${Object.entries(CABIN_LABELS).map(
              ([key, label]) =>
                html`<option value="${key}" ${raw(v("cabin", "economy") === key ? "selected" : "")}>
                  ${label}
                </option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label for="stops">Stops</label>
          <select id="stops" name="stops">
            ${Object.entries(STOPS_LABELS).map(
              ([key, label]) =>
                html`<option value="${key}" ${raw(v("stops", "any") === key ? "selected" : "")}>
                  ${label}
                </option>`,
            )}
          </select>
        </div>
      </div>

      <fieldset class="field">
        <legend>Alerts</legend>
        <label class="check-row">
          <input type="checkbox" name="alert_on_threshold"
                 ${raw(v("alert_on_threshold", "on") ? "checked" : "")}>
          <span>Alert when the fare reaches the threshold</span>
        </label>
        <label class="check-row">
          <input type="checkbox" name="alert_on_new_low"
                 ${raw(v("alert_on_new_low", "on") ? "checked" : "")}>
          <span>Alert on a new observed low</span>
        </label>
        <div class="field">
          <label for="cooldown_minutes">Cooldown (minutes)</label>
          <input type="number" id="cooldown_minutes" name="cooldown_minutes" min="0"
                 value="${v("cooldown_minutes", "360")}" ${invalid("cooldown_minutes")}>
          ${err("cooldown_minutes")}
        </div>
        <div class="inline-fields">
          <div class="field">
            <label for="min_drop_absolute">Only alert for drops of at least</label>
            <input id="min_drop_absolute" name="min_drop_absolute" inputmode="decimal"
                   value="${v("min_drop_absolute")}" aria-describedby="min-drop-hint"
                   ${invalid("min_drop_absolute")}>
            ${err("min_drop_absolute")}
          </div>
          <div class="field">
            <label for="min_drop_percent">…or at least (%)</label>
            <input id="min_drop_percent" name="min_drop_percent" inputmode="decimal"
                   value="${v("min_drop_percent")}" ${invalid("min_drop_percent")}>
            ${err("min_drop_percent")}
          </div>
        </div>
        <p class="hint small" id="min-drop-hint">
          Leave blank to alert on every qualifying change. Setting these quiets alerts for
          drops too small to act on.
        </p>
      </fieldset>

      <details class="field">
        <summary>Airline filters (optional)</summary>
        <div class="inline-fields">
          <div class="field">
            <label for="include_airlines">Only these airlines</label>
            <input id="include_airlines" name="include_airlines"
                   value="${v("include_airlines")}" placeholder="e.g. NH, UA"
                   aria-describedby="airlines-hint">
          </div>
          <div class="field">
            <label for="exclude_airlines">Never these airlines</label>
            <input id="exclude_airlines" name="exclude_airlines"
                   value="${v("exclude_airlines")}" placeholder="e.g. F9, NK">
          </div>
        </div>
        <p class="hint small" id="airlines-hint">
          Comma-separated two-letter airline codes. Applied to provider searches where the
          provider supports it.
        </p>
      </details>

      <!-- ---------------------------------------------------------- budget -->
      ${budgetBox(args.budget)}

      <div class="field" id="sampled-mode-row" ${raw(args.budget?.verdict.severity === "ok" ? "hidden" : "")}>
        <label class="check-row">
          <input type="checkbox" name="sampled_mode_ack"
                 ${raw(v("sampled_mode_ack") ? "checked" : "")}>
          <span>
            I understand this configuration may not complete within the remaining monthly
            allowance, and that scheduled checks will pause rather than exceed it.
          </span>
        </label>
        ${err("sampled_mode_ack")}
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" type="submit">
          ${editing ? "Save changes" : "Create tracker"}
        </button>
        <a class="btn" href="${editing ? `/trackers/${args.trackerId}` : "/trackers"}">Cancel</a>
      </div>
    </form>
  `;
}

/** Server-rendered budget preview; app.js replaces its contents live. */
function budgetBox(budget: FormBudget | null): SafeHtml {
  if (budget === null) {
    return html`<div class="budget-box" id="budget-estimate" hidden></div>`;
  }
  const { estimate: est, verdict } = budget;
  const tone =
    verdict.severity === "ok" ? "success" : verdict.severity === "blocked" ? "danger" : "warning";

  return html`
    <div class="budget-box notice-${tone}" id="budget-estimate" role="status" aria-live="polite">
      <p class="headline">${verdict.headline}</p>
      <p>${verdict.detail}</p>
      <p class="small">
        Per scan: <strong>${est.callsPerScan}</strong> planned provider search(es)
        (${budget.candidatesPerScan} date pair(s)
        × ${budget.marketCount} market(s)).
        ${est.maxCallsPerScan > est.callsPerScan
          ? html`Retry safety requires quota room for up to
              <strong>${est.maxCallsPerScan}</strong> calls.`
          : raw("")}
      </p>
      ${budget.candidateCount > 0
        ? html`<p class="small">
            Date combinations in this window: <strong>${budget.candidateCount}</strong>.
            A full sweep takes ${est.scansPerFullCycle} scans
            (${est.callsPerFullCycle} planned searches,
            up to ${est.maxCallsPerFullCycle} calls with retries,
            about ${humanizeDuration(est.fullCycleMinutes)}).
          </p>`
        : raw("")}
      ${verdict.suggestions.length > 0
        ? html`<ul>${verdict.suggestions.map((s) => html`<li>${s}</li>`)}</ul>`
        : raw("")}
    </div>
  `;
}

// ------------------------------------------------------------------ settings
export function settingsPage(args: {
  status: OperationalStatus;
  csrf: string;
  discovered: { chatId: number; displayName: string; lastText: string | null }[] | null;
  discoverError: string | null;
  webhook: {
    expectedUrl: string;
    info: TelegramWebhookInfo | null;
    error: string | null;
  };
  tz: string;
}): SafeHtml {
  const { status, csrf } = args;
  const q = status.quota;
  const webhookEnabled = (args.webhook.info?.url ?? "") !== "";
  const webhookMatches = args.webhook.info?.url === args.webhook.expectedUrl;
  const webhookReady =
    webhookEnabled && webhookMatches && status.telegramWebhookSecretConfigured;
  const canEnableWebhook =
    status.telegramConfigured &&
    status.telegramChatConfigured &&
    status.telegramWebhookSecretConfigured;

  return html`
    <div class="page-head"><h1>Settings</h1></div>

    <section class="card" aria-labelledby="integrations-heading">
      <div class="card-head"><h2 id="integrations-heading">Integrations</h2></div>
      <dl class="kv">
        <dt>SerpApi</dt>
        <dd>
          ${badge(status.serpapiConfigured, "Key configured", "No key")}
          <div class="small muted">
            Price scope: <span class="mono">party_total</span> (verified against this account).
          </div>
        </dd>
        <dt>Telegram bot</dt>
        <dd>
          ${badge(status.telegramConfigured, "Token configured", "No token")}
          ${status.telegramHint ? html`<span class="small muted">${status.telegramHint}</span>` : raw("")}
        </dd>
        <dt>Telegram chat</dt>
        <dd>
          ${badge(status.telegramChatConfigured, "Configured", "Not set")}
          <div class="small muted">
            The chat id is stored as a Worker secret, not in the database.
          </div>
        </dd>
        <dt>Telegram commands</dt>
        <dd>
          ${badge(
            webhookReady,
            "Webhook enabled",
            webhookEnabled && !status.telegramWebhookSecretConfigured
              ? "Webhook secret missing"
              : webhookEnabled
                ? "Different URL registered"
                : "Webhook disabled",
          )}
          ${badge(
            status.telegramWebhookSecretConfigured,
            "Secret configured",
            "No webhook secret",
          )}
          ${args.webhook.info
            ? html`<div class="small muted">
                ${webhookEnabled
                  ? html`Registered URL: <span class="mono">${args.webhook.info.url}</span> · `
                  : raw("")}
                ${args.webhook.info.pendingUpdateCount} pending update(s)
                ${args.webhook.info.maxConnections !== null
                  ? html` · ${args.webhook.info.maxConnections} connection(s)`
                  : raw("")}
              </div>`
            : raw("")}
          ${args.webhook.info?.lastErrorMessage
            ? html`<div class="small error-text">
                Last delivery error${args.webhook.info.lastErrorDate !== null
                  ? html` at ${formatLocal(
                      new Date(args.webhook.info.lastErrorDate * 1000),
                      args.tz,
                    )}`
                  : raw("")}: ${args.webhook.info.lastErrorMessage}
              </div>`
            : raw("")}
          <div class="small muted">
            Commands are accepted only from the configured private chat. Telegram webhook
            retries are deduplicated before a command can run again.
          </div>
        </dd>
      </dl>

      <div class="btn-row">
        <form method="post" action="/settings/test-message" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn" type="submit"
                  ${raw(status.telegramConfigured && status.telegramChatConfigured ? "" : "disabled")}>
            Send test message
          </button>
        </form>
        <form method="post" action="/settings/discover-chat" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn" type="submit"
                  ${raw(status.telegramConfigured && !webhookEnabled ? "" : "disabled")}>
            Discover chat
          </button>
        </form>
        <form method="post" action="/settings/telegram-webhook/enable" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn" type="submit" ${raw(canEnableWebhook ? "" : "disabled")}>
            Enable commands
          </button>
        </form>
        <form method="post" action="/settings/telegram-webhook/disable" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn" type="submit" ${raw(webhookEnabled ? "" : "disabled")}>
            Disable commands
          </button>
        </form>
      </div>

      ${webhookEnabled
        ? html`<p class="hint small">
            Chat discovery is unavailable while a Telegram webhook is active. Disable commands
            first if you need to discover a different chat.
          </p>`
        : raw("")}
      ${args.webhook.error
        ? html`<div class="notice notice-warning">
            Telegram webhook status could not be loaded: ${args.webhook.error}
          </div>`
        : raw("")}

      ${args.discoverError
        ? html`<div class="notice notice-warning">${args.discoverError}</div>`
        : raw("")}
      ${args.discovered && args.discovered.length > 0
        ? html`
            <table class="stacked">
              <thead>
                <tr><th scope="col">Chat id</th><th scope="col">Name</th><th scope="col">Last message</th></tr>
              </thead>
              <tbody>
                ${args.discovered.map(
                  (c) => html`<tr>
                    <td class="mono" data-label="Chat id">${c.chatId}</td>
                    <td data-label="Name">${c.displayName}</td>
                    <td class="small" data-label="Last message">${c.lastText ?? ""}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
            <p class="hint small">
              Store the chat id with
              <code>npx wrangler secret put TELEGRAM_CHAT_ID</code>, then redeploy.
            </p>
          `
        : raw("")}
    </section>

    <section class="card" aria-labelledby="quota-heading">
      <div class="card-head"><h2 id="quota-heading">Provider allowance</h2></div>
      ${q
        ? html`
            <div class="budget-box">
              <progress class="progress" value="${Math.min(100, q.usedPercent)}" max="100"
                        aria-label="${q.usedPercent}% of the monthly allowance used">
                ${q.usedPercent}%
              </progress>
              <dl class="kv">
                <dt>Period</dt><dd>${q.period}</dd>
                <dt>Used</dt><dd>${q.effectiveUsed} of ${q.monthlyLimit}</dd>
                <dt>Available to automation</dt><dd>${q.remainingSafe}</dd>
                <dt>Reserved for manual checks</dt>
                <dd>${q.reserve} (${q.reservePercent}%)</dd>
                <dt>This hour</dt><dd>${q.hourlyUsed} of ${q.hourlyLimit}</dd>
                <dt>Provider plan</dt><dd>${q.providerPlan ?? "Not synced"}</dd>
                <dt>Provider account</dt><dd>${q.providerAccountMasked ?? "Not synced"}</dd>
                <dt>Last provider sync</dt><dd>${formatLocal(q.lastSyncedAt, args.tz)}</dd>
                ${q.syncError
                  ? html`<dt>Sync error</dt><dd class="error-text">${q.syncError}</dd>`
                  : raw("")}
              </dl>
            </div>
          `
        : html`<p class="muted">Quota data is unavailable.</p>`}
      <form method="post" action="/settings/sync-provider" class="btn-row">
        ${csrfField(csrf)}
        <button class="btn" type="submit" ${raw(status.serpapiConfigured ? "" : "disabled")}>
          Refresh provider allowance
        </button>
        <span class="hint small">Account-status reads do not consume fare-search quota.</span>
      </form>
    </section>

    <section class="card" aria-labelledby="ops2-heading">
      <div class="card-head"><h2 id="ops2-heading">Scheduling</h2></div>
      <dl class="kv">
        <dt>Scheduler</dt>
        <dd>${status.schedulerEnabled ? "Enabled" : "Disabled"} · Cron ${status.cronSchedule} (UTC)</dd>
        <dt>Last Cron run</dt>
        <dd>
          ${status.lastCron
            ? html`${formatLocal(status.lastCron.started_at, args.tz)} ·
                ${status.lastCron.outcome} ·
                ${status.lastCron.queries_executed} query(ies),
                ${status.lastCron.alerts_sent} alert(s)`
            : "None recorded."}
        </dd>
      </dl>
    </section>

    <section class="card" aria-labelledby="sessions-heading">
      <div class="card-head"><h2 id="sessions-heading">Sessions</h2></div>
      <p>
        Sign out every browser that is currently authenticated. You will need to sign in again
        on this device too.
      </p>
      <form method="post" action="/settings/revoke-sessions" class="btn-row">
        ${csrfField(csrf)}
        <button class="btn btn-danger" type="submit">Revoke all sessions</button>
      </form>
      <p class="hint small">
        To change the password, generate a new hash with <code>npm run hash-password</code>,
        replace the <code>AUTH_PASSWORD_HASH</code> Worker secret, and redeploy.
      </p>
    </section>
  `;
}

// -------------------------------------------------------------------- error
export function errorPage(args: { status: number; detail: string }): SafeHtml {
  return html`
    <div class="page-head"><h1>Something went wrong</h1></div>
    <div class="card">
      <p class="mono">HTTP ${args.status}</p>
      <p>${args.detail}</p>
      <p><a class="btn" href="/">Back to the dashboard</a></p>
    </div>
  `;
}
