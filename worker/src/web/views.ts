/**
 * Page rendering.
 *
 * Ported from the Jinja2 templates, keeping the same markup structure, class
 * names and accessibility affordances so the existing stylesheet and
 * `app.js` apply unchanged: skip link, `aria-current` navigation, `role=status`
 * live regions, and labelled form controls.
 */

import type {
  AlertEventRow,
  CronRunRow,
  FareObservationRow,
  SearchRunRow,
  TrackerWithMarkets,
} from "../db/rows.js";
import {
  ALERT_TYPE_LABELS,
  CABIN_LABELS,
  DATE_MODE_LABELS,
  DELIVERY_STATE_LABELS,
  FLEX_DURATION_LABELS,
  RUN_STATUS_LABELS,
  STOPS_LABELS,
  TrackerStatus,
} from "../domain/enums.js";
import { formatMoney } from "../domain/money.js";
import { formatDateShort, formatLocal, humanizeDelta } from "../time.js";
import type { QuotaSnapshot } from "../services/quota.js";
import { humanizeDuration, SCHEDULE_CHOICES } from "../services/planner.js";
import type { FormBudget } from "./tracker-form.js";
import { html, raw, type SafeHtml } from "./html.js";

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
  return html`<span class="badge badge-danger">Error</span>`;
}

function csrfField(token: string): SafeHtml {
  return html`<input type="hidden" name="csrf_token" value="${token}">`;
}

// ------------------------------------------------------------------ sign in
export function loginPage(args: { error?: string | null; tz: string }): SafeHtml {
  return html`
    <div class="page-head"><h1>Sign in</h1></div>
    <div class="card" style="max-width: 26rem;">
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
}): SafeHtml {
  const { status, trackers, tz } = args;
  const q = status.quota;

  return html`
    <div class="page-head">
      <h1>Dashboard</h1>
      <div class="head-actions">
        <a class="btn btn-small" href="/trackers">All trackers</a>
      </div>
    </div>

    <section class="card" aria-labelledby="ops-heading">
      <div class="card-head"><h2 id="ops-heading">Deployment status</h2></div>
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
    </section>

    <section class="card" aria-labelledby="trackers-heading">
      <div class="card-head"><h2 id="trackers-heading">Trackers</h2></div>
      ${trackers.length === 0 ? emptyTrackers() : trackerTable(trackers, tz)}
    </section>
  `;
}

function emptyTrackers(): SafeHtml {
  return html`
    <div class="empty-state">
      <p>No trackers yet.</p>
      <a class="btn btn-primary" href="/trackers/new">Create your first tracker</a>
    </div>
  `;
}

function trackerTable(trackers: TrackerWithMarkets[], tz: string): SafeHtml {
  return html`
    <table>
      <thead>
        <tr>
          <th scope="col">Tracker</th>
          <th scope="col">Route</th>
          <th scope="col">Dates</th>
          <th scope="col" class="num">Latest</th>
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
              <td><a href="/trackers/${t.id}">${t.name}</a></td>
              <td class="nowrap">${t.origin} → ${t.destination}</td>
              <td class="nowrap small">${describeDates(t)}</td>
              <td class="num">${formatMoney(t.latest_price_cents, t.currency)}</td>
              <td class="num">${formatMoney(t.low_price_cents, t.currency)}</td>
              <td class="num">${formatMoney(t.threshold_amount_cents, t.currency)}</td>
              <td class="nowrap small">${humanizeDelta(t.next_run_at)}</td>
              <td>${statusBadge(t.status)}</td>
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
export function trackerDetailPage(args: {
  tracker: TrackerWithMarkets;
  observations: FareObservationRow[];
  runs: SearchRunRow[];
  alerts: AlertEventRow[];
  csrf: string;
  tz: string;
  quotaBlocked: boolean;
}): SafeHtml {
  const { tracker: t, observations, runs, alerts, csrf, tz } = args;

  return html`
    <div class="page-head">
      <h1>${t.name}</h1>
      <div class="head-actions">
        <a class="btn btn-small" href="/trackers/${t.id}/edit">Edit</a>
        <form method="post" action="/trackers/${t.id}/duplicate" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn btn-small" type="submit">Duplicate</button>
        </form>
        <form method="post" action="/trackers/${t.id}/toggle" class="inline-fields">
          ${csrfField(csrf)}
          <button class="btn btn-small" type="submit">
            ${t.status === TrackerStatus.PAUSED ? "Resume" : "Pause"}
          </button>
        </form>
        <form method="post" action="/trackers/${t.id}/delete" class="inline-fields"
              onsubmit="return confirm('Delete this tracker and its price history?')">
          ${csrfField(csrf)}
          <button class="btn btn-small btn-danger" type="submit">Delete</button>
        </form>
      </div>
    </div>

    <section class="card">
      <div class="headline-price">
        <div>
          <div class="small muted">Latest observed</div>
          <div class="num">${formatMoney(t.latest_price_cents, t.currency)}</div>
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

      <form method="post" action="/trackers/${t.id}/check" class="btn-row">
        ${csrfField(csrf)}
        <button class="btn btn-primary" type="submit" ${raw(args.quotaBlocked ? "disabled" : "")}>
          Check now
        </button>
        ${args.quotaBlocked
          ? html`<span class="hint small">
              The provider allowance is exhausted, so a manual check is unavailable.
            </span>`
          : html`<span class="hint small">Uses one provider search per market.</span>`}
      </form>
    </section>

    <section class="card" aria-labelledby="history-heading">
      <div class="card-head"><h2 id="history-heading">Price history</h2></div>
      ${observations.length === 0
        ? html`<div class="empty-state"><p>No observations recorded yet.</p></div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th scope="col">Observed</th>
                  <th scope="col" class="num">Price</th>
                  <th scope="col">Airlines</th>
                  <th scope="col" class="num">Stops</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Market</th>
                </tr>
              </thead>
              <tbody>
                ${observations.slice(0, 50).map(
                  (o) => html`
                    <tr>
                      <td class="nowrap small">${formatLocal(o.observed_at, tz)}</td>
                      <td class="num">${formatMoney(o.price_amount_cents, o.currency)}</td>
                      <td class="small">${safeList(o.airlines)}</td>
                      <td class="num">${o.stops ?? "-"}</td>
                      <td class="nowrap small">
                        ${formatDateShort(o.outbound_date)} – ${formatDateShort(o.return_date)}
                      </td>
                      <td class="small">${o.market}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>

    <section class="card" aria-labelledby="runs-heading">
      <div class="card-head"><h2 id="runs-heading">Recent checks</h2></div>
      ${runs.length === 0
        ? html`<div class="empty-state"><p>No checks recorded yet.</p></div>`
        : html`
            <table>
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
                      <td class="nowrap small">${formatLocal(r.started_at, tz)}</td>
                      <td class="small">${r.trigger}</td>
                      <td class="small">${RUN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td class="num">${r.offers_found}</td>
                      <td class="small">${r.error_message ?? r.skip_reason ?? ""}</td>
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
            <table>
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
                      <td class="nowrap small">${formatLocal(a.created_at, tz)}</td>
                      <td class="small">${ALERT_TYPE_LABELS[a.alert_type] ?? a.alert_type}</td>
                      <td class="small">
                        ${DELIVERY_STATE_LABELS[a.delivery_state] ?? a.delivery_state}
                      </td>
                      <td class="small">${a.last_error ?? ""}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>
  `;
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
                 autocapitalize="characters" ${invalid("origin")}>
          ${err("origin")}
        </div>
        <div class="field">
          <label for="destination">Destination (IATA)</label>
          <input id="destination" name="destination" required maxlength="3"
                 value="${v("destination")}" autocapitalize="characters" ${invalid("destination")}>
          ${err("destination")}
        </div>
      </div>

      <!-- ----------------------------------------------------------- dates -->
      <fieldset class="field">
        <legend id="date-mode-label">Dates</legend>
        <div id="date_mode" role="radiogroup" aria-labelledby="date-mode-label">
          ${(
            [
              ["exact", "Exact dates", "One departure and one return."],
              ["flexible_preset", "Flexible preset", "A whole month and a trip length, in one provider call."],
              ["custom_window", "Custom flexible window", "A departure range plus a trip-length range, swept across runs."],
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
                     max="20" value="${v("candidates_per_run", "1")}">
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
          <p class="hint small" id="threshold-hint">Whole-party total, in the tracker's currency.</p>
          ${err("threshold_amount")}
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
      </fieldset>

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
        Per scan: <strong>${est.callsPerScan}</strong> provider search(es)
        (${budget.candidateCount > 0 ? budget.candidateCount : 1} date pair(s)
        × ${budget.marketCount} market(s)).
      </p>
      ${budget.candidateCount > 0
        ? html`<p class="small">
            Date combinations in this window: <strong>${budget.candidateCount}</strong>.
            A full sweep takes ${est.scansPerFullCycle} scans
            (${est.callsPerFullCycle} searches, about ${humanizeDuration(est.fullCycleMinutes)}).
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
  tz: string;
}): SafeHtml {
  const { status, csrf } = args;
  const q = status.quota;

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
          <button class="btn" type="submit" ${raw(status.telegramConfigured ? "" : "disabled")}>
            Discover chat
          </button>
        </form>
      </div>

      ${args.discoverError
        ? html`<div class="notice notice-warning">${args.discoverError}</div>`
        : raw("")}
      ${args.discovered && args.discovered.length > 0
        ? html`
            <table>
              <thead>
                <tr><th scope="col">Chat id</th><th scope="col">Name</th><th scope="col">Last message</th></tr>
              </thead>
              <tbody>
                ${args.discovered.map(
                  (c) => html`<tr>
                    <td class="mono">${c.chatId}</td>
                    <td>${c.displayName}</td>
                    <td class="small">${c.lastText ?? ""}</td>
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
              <div class="progress" role="img"
                   aria-label="${q.usedPercent}% of the monthly allowance used">
                <span style="width: ${Math.min(100, q.usedPercent)}%"></span>
              </div>
              <dl class="kv">
                <dt>Period</dt><dd>${q.period}</dd>
                <dt>Used</dt><dd>${q.effectiveUsed} of ${q.monthlyLimit}</dd>
                <dt>Available to automation</dt><dd>${q.remainingSafe}</dd>
                <dt>Reserved for manual checks</dt>
                <dd>${q.reserve} (${q.reservePercent}%)</dd>
                <dt>This hour</dt><dd>${q.hourlyUsed} of ${q.hourlyLimit}</dd>
              </dl>
            </div>
          `
        : html`<p class="muted">Quota data is unavailable.</p>`}
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
