/**
 * HTTP routing.
 *
 * Replaces the FastAPI app and its routers. Every mutating route is behind
 * both the session guard and a CSRF check, and the guard is applied centrally
 * (deny by default, with an explicit public allow-list) rather than per route,
 * so a new page cannot accidentally ship unauthenticated.
 */

import { loadConfig, telegramTokenHint, type Env } from "../env.js";
import { Repo } from "../db/repo.js";
import type { TrackerWithMarkets } from "../db/rows.js";
import { AlertService } from "../services/alerts.js";
import { QuotaManager } from "../services/quota.js";
import { SearchService } from "../services/search.js";
import { SerpApiProvider } from "../providers/serpapi.js";
import { TelegramNotifier } from "../services/telegram.js";
import { buildTestMessage } from "../services/messages.js";
import { ensureConfigVersion } from "../services/tracker.js";
import { RunTrigger, TrackerStatus } from "../domain/enums.js";
import { centsFromDecimalString } from "../domain/money.js";
import { nowIso } from "../time.js";
import {
  checkThrottle,
  clearAuthFailures,
  clearedSessionCookie,
  createSessionToken,
  csrfTokenFor,
  csrfValid,
  readCookie,
  recordAuthFailure,
  SESSION_COOKIE,
  sessionCookie,
  throttleKey,
  verifyPassword,
  verifySessionToken,
} from "./auth.js";
import { htmlResponse, layout, redirect, type Flash } from "./html.js";
import {
  dashboardPage,
  errorPage,
  loginPage,
  settingsPage,
  setupPage,
  trackerDetailPage,
  trackerFormPage,
  trackersPage,
  type OperationalStatus,
} from "./views.js";

const WORKER_VERSION = "1.0.0";
const CRON_SCHEDULE = "7,22,37,52 * * * *";

/** Paths reachable without a session. Everything else is denied by default. */
const PUBLIC_PATHS = new Set(["/login", "/healthz"]);

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { config, problems, usable } = loadConfig(env);
  // Behind Cloudflare this is always https; only local `wrangler dev` is http.
  const secure = url.protocol === "https:";

  if (url.pathname === "/healthz") {
    return healthz(env, usable);
  }

  if (!usable) {
    // Fail closed: no data, no session, just what is missing. A 503 also stops
    // an uptime check from reporting a half-configured deployment as healthy.
    const blocking = problems.filter((p) => p.blocking);
    return htmlResponse(
      layout(
        {
          title: "Setup required",
          nav: "none",
          appTimezone: config.appTimezone,
          authenticated: false,
        },
        setupPage(blocking),
      ),
      { status: 503 },
    );
  }

  const repo = new Repo(env.DB);
  const session = await verifySessionToken(
    config.sessionSecret,
    readCookie(request, SESSION_COOKIE),
  );

  if (!session && !PUBLIC_PATHS.has(url.pathname)) {
    return redirect("/login");
  }

  if (url.pathname === "/login") {
    return session ? redirect("/") : loginRoute(request, repo, config, secure);
  }

  if (!session) return redirect("/login");
  const csrf = await csrfTokenFor(config.sessionSecret, session.sid);

  // --- mutations: CSRF-checked centrally --------------------------------
  if (request.method === "POST") {
    if (url.pathname === "/logout") {
      return redirect("/login", { "Set-Cookie": clearedSessionCookie(secure) });
    }
    const form = await request.formData();
    if (!(await csrfValid(config.sessionSecret, session.sid, String(form.get("csrf_token") ?? "")))) {
      return htmlResponse(
        layout(
          { title: "Invalid request", nav: "none", appTimezone: config.appTimezone, authenticated: true },
          errorPage({
            status: 400,
            detail:
              "That request could not be verified, so nothing was changed. Stored data is safe. " +
              "Go back, reload the page and try again.",
          }),
        ),
        { status: 400 },
      );
    }
    return postRoute(url, form, { request, env, repo, config, csrf });
  }

  return getRoute(url, { request, env, repo, config, csrf });
}

interface Ctx {
  request: Request;
  env: Env;
  repo: Repo;
  config: ReturnType<typeof loadConfig>["config"];
  csrf: string;
}

// --------------------------------------------------------------------- auth
async function loginRoute(
  request: Request,
  repo: Repo,
  config: Ctx["config"],
  secure: boolean,
): Promise<Response> {
  const page = (error: string | null, status = 200): Response =>
    htmlResponse(
      layout(
        { title: "Sign in", nav: "none", appTimezone: config.appTimezone, authenticated: false },
        loginPage({ error, tz: config.appTimezone }),
      ),
      { status },
    );

  if (request.method !== "POST") return page(null);

  const key = await throttleKey(config.sessionSecret, request);
  const verdict = await checkThrottle(repo, key);
  if (verdict.locked) return page(verdict.message, 429);

  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const ok = await verifyPassword(password, config.authPasswordHash);

  if (!ok) {
    await recordAuthFailure(repo, key);
    // Deliberately identical for a wrong password and an unknown state: there
    // is only one account, so any distinction is a free hint to an attacker.
    return page("Incorrect password.", 401);
  }

  await clearAuthFailures(repo, key);
  const token = await createSessionToken(config.sessionSecret);
  return redirect("/", { "Set-Cookie": sessionCookie(token, secure) });
}

async function healthz(env: Env, usable: boolean): Promise<Response> {
  const repo = new Repo(env.DB);
  const health = await repo.health();
  return Response.json(
    {
      status: usable && health.ok ? "ok" : "error",
      version: WORKER_VERSION,
      d1: health.ok ? "connected" : "unavailable",
      schema_version: health.schemaVersion,
      // Deliberately no secret names, values, or configuration detail.
    },
    { status: usable && health.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------- services
function servicesFor(ctx: Ctx) {
  const provider = new SerpApiProvider(ctx.config);
  const notifier = new TelegramNotifier(ctx.config);
  const quota = new QuotaManager(ctx.repo, ctx.config);
  const alerts = new AlertService({
    repo: ctx.repo,
    notifier,
    timeZone: ctx.config.appTimezone,
  });
  const search = new SearchService({
    repo: ctx.repo,
    config: ctx.config,
    provider,
    quota,
    alerts,
    chatId: ctx.config.telegramChatId || null,
  });
  return { provider, notifier, quota, alerts, search };
}

async function operationalStatus(ctx: Ctx): Promise<OperationalStatus> {
  const { repo, config } = ctx;
  const [health, state, cronRuns, trackers] = await Promise.all([
    repo.health(),
    repo.schedulerState(),
    repo.recentCronRuns(1),
    repo.listTrackers(),
  ]);
  const { quota } = servicesFor(ctx);
  const snapshot = health.ok ? await quota.snapshot() : null;

  const observationCount =
    (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM fare_observations").first<{ n: number }>())
      ?.n ?? 0;

  const nextDue = trackers
    .filter((t) => t.status === TrackerStatus.ACTIVE && t.next_run_at)
    .map((t) => t.next_run_at!)
    .sort()[0];

  const leaseExpiry = state?.lock_expires_at ?? null;
  return {
    environment: "Cloudflare Workers",
    workerVersion: WORKER_VERSION,
    d1Ok: health.ok,
    d1Detail: health.detail,
    schemaVersion: health.schemaVersion,
    schedulerEnabled: config.schedulerEnabled,
    cronSchedule: CRON_SCHEDULE,
    lastCron: cronRuns[0] ?? null,
    leaseOwnerActive:
      state?.lock_owner != null &&
      leaseExpiry != null &&
      new Date(leaseExpiry).getTime() > Date.now(),
    leaseExpiresAt: leaseExpiry,
    nextDueAt: nextDue ?? null,
    quota: snapshot,
    serpapiConfigured: config.serpapiApiKey !== "",
    telegramConfigured: config.telegramBotToken !== "",
    telegramChatConfigured: config.telegramChatId !== "",
    telegramHint: telegramTokenHint(config.telegramBotToken),
    trackerCount: trackers.length,
    observationCount,
    problems: loadConfig(ctx.env).problems,
  };
}

// --------------------------------------------------------------- GET routes
async function getRoute(url: URL, ctx: Ctx): Promise<Response> {
  const { repo, config } = ctx;
  const page = (title: string, nav: OperationalStatus extends never ? never : "dashboard" | "trackers" | "settings" | "none", body: Parameters<typeof layout>[1], flashes: Flash[] = []) =>
    htmlResponse(
      layout({ title, nav, appTimezone: config.appTimezone, authenticated: true, flashes }, body),
    );

  if (url.pathname === "/") {
    const [status, trackers, alerts] = await Promise.all([
      operationalStatus(ctx),
      repo.listTrackers(),
      repo.recentAlerts(5),
    ]);
    return page(
      "Dashboard",
      "dashboard",
      dashboardPage({ status, trackers, recentAlerts: alerts, tz: config.appTimezone }),
      flashesFrom(url),
    );
  }

  if (url.pathname === "/trackers") {
    const trackers = await repo.listTrackers();
    return page("Trackers", "trackers", trackersPage({ trackers, tz: config.appTimezone }), flashesFrom(url));
  }

  if (url.pathname === "/trackers/new") {
    return page(
      "New tracker",
      "trackers",
      trackerFormPage({ tracker: null, errors: {}, values: {}, csrf: ctx.csrf }),
    );
  }

  const detail = url.pathname.match(/^\/trackers\/(\d+)$/);
  if (detail) {
    const tracker = await repo.getTracker(Number(detail[1]));
    if (!tracker) return notFound(ctx);
    const [observations, runs, alerts] = await Promise.all([
      repo.observationsForTracker(tracker.id, 100),
      repo.recentRuns(tracker.id, 15),
      repo.recentAlerts(10),
    ]);
    const { quota } = servicesFor(ctx);
    const snapshot = await quota.snapshot();
    return page(
      tracker.name,
      "trackers",
      trackerDetailPage({
        tracker,
        observations,
        runs,
        alerts: alerts.filter((a) => a.tracker_id === tracker.id),
        csrf: ctx.csrf,
        tz: config.appTimezone,
        quotaBlocked: snapshot.remainingHard <= 0,
      }),
      flashesFrom(url),
    );
  }

  const edit = url.pathname.match(/^\/trackers\/(\d+)\/edit$/);
  if (edit) {
    const tracker = await repo.getTracker(Number(edit[1]));
    if (!tracker) return notFound(ctx);
    return page(
      `Edit ${tracker.name}`,
      "trackers",
      trackerFormPage({
        tracker,
        errors: {},
        values: valuesFromTracker(tracker),
        csrf: ctx.csrf,
      }),
    );
  }

  if (url.pathname === "/settings") {
    const status = await operationalStatus(ctx);
    return page(
      "Settings",
      "settings",
      settingsPage({
        status,
        csrf: ctx.csrf,
        discovered: null,
        discoverError: null,
        tz: config.appTimezone,
      }),
      flashesFrom(url),
    );
  }

  return notFound(ctx);
}

// -------------------------------------------------------------- POST routes
async function postRoute(url: URL, form: FormData, ctx: Ctx): Promise<Response> {
  const { repo, config } = ctx;

  if (url.pathname === "/trackers") {
    const { values, errors, fields, markets } = parseTrackerForm(form, config.defaultMarket);
    if (Object.keys(errors).length > 0) {
      return htmlResponse(
        layout(
          { title: "New tracker", nav: "trackers", appTimezone: config.appTimezone, authenticated: true },
          trackerFormPage({ tracker: null, errors, values, csrf: ctx.csrf }),
        ),
        { status: 422 },
      );
    }
    const id = await repo.insertTracker({ ...fields, created_at: nowIso(), updated_at: nowIso() });
    await repo.setTrackerMarkets(id, markets);
    const tracker = await repo.getTracker(id);
    if (tracker) await ensureConfigVersion(repo, tracker);
    return redirect(`/trackers/${id}?flash=created`);
  }

  const update = url.pathname.match(/^\/trackers\/(\d+)$/);
  if (update) {
    const tracker = await repo.getTracker(Number(update[1]));
    if (!tracker) return notFound(ctx);
    const { values, errors, fields, markets } = parseTrackerForm(form, config.defaultMarket);
    if (Object.keys(errors).length > 0) {
      return htmlResponse(
        layout(
          { title: "Edit tracker", nav: "trackers", appTimezone: config.appTimezone, authenticated: true },
          trackerFormPage({ tracker, errors, values, csrf: ctx.csrf }),
        ),
        { status: 422 },
      );
    }
    await repo.updateTrackerFields(tracker.id, fields);
    await repo.setTrackerMarkets(tracker.id, markets);
    const fresh = await repo.getTracker(tracker.id);
    // Re-versioning here is what splits the comparison series when a
    // comparison-relevant field changed.
    if (fresh) await ensureConfigVersion(repo, fresh);
    return redirect(`/trackers/${tracker.id}?flash=saved`);
  }

  const action = url.pathname.match(/^\/trackers\/(\d+)\/(check|toggle|delete|duplicate)$/);
  if (action) {
    const tracker = await repo.getTracker(Number(action[1]));
    if (!tracker) return notFound(ctx);

    if (action[2] === "delete") {
      await repo.deleteTracker(tracker.id);
      return redirect("/trackers?flash=deleted");
    }

    if (action[2] === "toggle") {
      const next =
        tracker.status === TrackerStatus.PAUSED ? TrackerStatus.ACTIVE : TrackerStatus.PAUSED;
      await repo.updateTrackerFields(tracker.id, { status: next });
      return redirect(`/trackers/${tracker.id}?flash=${next}`);
    }

    if (action[2] === "duplicate") {
      const copy: Record<string, unknown> = { ...(tracker as unknown as Record<string, unknown>) };
      delete copy["id"];
      delete copy["markets"];
      Object.assign(copy, {
        name: `${tracker.name} (copy)`,
        status: TrackerStatus.PAUSED,
        current_config_version_id: null,
        series_started_at: null,
        latest_price_cents: null,
        latest_observation_id: null,
        latest_observed_at: null,
        low_price_cents: null,
        low_observation_id: null,
        low_observed_at: null,
        last_threshold_met: 0,
        next_run_at: null,
        last_attempt_at: null,
        last_success_at: null,
        consecutive_failures: 0,
        lock_owner: null,
        lock_expires_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      const id = await repo.insertTracker(copy);
      await repo.setTrackerMarkets(id, tracker.markets);
      const fresh = await repo.getTracker(id);
      if (fresh) await ensureConfigVersion(repo, fresh);
      return redirect(`/trackers/${id}?flash=duplicated`);
    }

    // Manual check: same lock, quota, observation and alert path as the Cron
    // tick, so the two cannot diverge in behaviour.
    const owner = `manual:${crypto.randomUUID().slice(0, 8)}`;
    const locked = await repo.acquireTrackerLock(tracker.id, owner, config.schedulerLeaseTtlSeconds);
    if (!locked) return redirect(`/trackers/${tracker.id}?flash=busy`);
    try {
      const { search } = servicesFor(ctx);
      await search.runTracker(tracker, RunTrigger.MANUAL, { forceRefresh: false });
    } finally {
      await repo.releaseTrackerLock(tracker.id, owner);
    }
    return redirect(`/trackers/${tracker.id}?flash=checked`);
  }

  if (url.pathname === "/settings/test-message") {
    const { notifier } = servicesFor(ctx);
    const chatId = config.telegramChatId;
    if (!notifier.isConfigured() || !chatId) return redirect("/settings?flash=telegram_missing");
    const result = await notifier.sendMessage(
      chatId,
      buildTestMessage(config.appTimezone, new Date()),
      { disablePreview: true },
    );
    return redirect(`/settings?flash=${result.ok ? "test_sent" : "test_failed"}`);
  }

  if (url.pathname === "/settings/discover-chat") {
    const { notifier } = servicesFor(ctx);
    const status = await operationalStatus(ctx);
    const discovery = await notifier.discoverChats();
    return htmlResponse(
      layout(
        { title: "Settings", nav: "settings", appTimezone: config.appTimezone, authenticated: true },
        settingsPage({
          status,
          csrf: ctx.csrf,
          discovered: discovery.chats.map((c) => ({
            chatId: c.chatId,
            displayName: c.displayName,
            lastText: c.lastText,
          })),
          discoverError: discovery.result.ok ? null : discovery.result.userMessage,
          tz: config.appTimezone,
        }),
      ),
    );
  }

  return notFound(ctx);
}

// -------------------------------------------------------------------- forms
function valuesFromTracker(tracker: TrackerWithMarkets): Record<string, string> {
  const t = tracker as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of [
    "name",
    "origin",
    "destination",
    "adults",
    "children",
    "cabin",
    "stops",
    "currency",
    "outbound_date",
    "return_date",
    "check_interval_minutes",
    "cooldown_minutes",
  ]) {
    const value = t[key];
    if (value !== null && value !== undefined) out[key] = String(value);
  }
  const threshold = t["threshold_amount_cents"];
  if (typeof threshold === "number") out["threshold_amount"] = (threshold / 100).toFixed(2);
  out["alert_on_threshold"] = t["alert_on_threshold"] === 1 ? "on" : "";
  out["alert_on_new_low"] = t["alert_on_new_low"] === 1 ? "on" : "";
  return out;
}

function parseTrackerForm(
  form: FormData,
  defaultMarket: string,
): {
  values: Record<string, string>;
  errors: Record<string, string>;
  fields: Record<string, unknown>;
  markets: string[];
} {
  const get = (key: string): string => String(form.get(key) ?? "").trim();
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const key of [
    "name",
    "origin",
    "destination",
    "adults",
    "children",
    "cabin",
    "stops",
    "currency",
    "outbound_date",
    "return_date",
    "threshold_amount",
    "check_interval_minutes",
    "cooldown_minutes",
  ]) {
    values[key] = get(key);
  }
  values["alert_on_threshold"] = form.get("alert_on_threshold") ? "on" : "";
  values["alert_on_new_low"] = form.get("alert_on_new_low") ? "on" : "";

  const name = values["name"]!;
  if (name === "") errors["name"] = "Give the tracker a name.";

  const origin = values["origin"]!.toUpperCase();
  const destination = values["destination"]!.toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin)) errors["origin"] = "Use a three-letter IATA airport code.";
  if (!/^[A-Z]{3}$/.test(destination))
    errors["destination"] = "Use a three-letter IATA airport code.";
  if (origin === destination && origin !== "")
    errors["destination"] = "Origin and destination must differ.";

  const outbound = values["outbound_date"]!;
  const ret = values["return_date"]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(outbound)) errors["outbound_date"] = "Choose an outbound date.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ret)) errors["return_date"] = "Choose a return date.";
  if (!errors["outbound_date"] && !errors["return_date"] && ret < outbound) {
    errors["return_date"] = "The return date must not be before the outbound date.";
  }

  let thresholdCents = 0;
  try {
    thresholdCents = centsFromDecimalString(values["threshold_amount"]!);
    if (thresholdCents <= 0) errors["threshold_amount"] = "Enter an amount above zero.";
  } catch {
    errors["threshold_amount"] = "Enter an amount such as 1300 or 1300.50.";
  }

  const adults = Number(values["adults"] || "1");
  if (!Number.isInteger(adults) || adults < 1) errors["adults"] = "At least one adult is required.";

  const interval = Number(values["check_interval_minutes"] || "720");
  if (!Number.isInteger(interval) || interval < 15) {
    errors["check_interval_minutes"] = "The minimum interval is 15 minutes.";
  }

  const fields: Record<string, unknown> = {
    name,
    origin,
    destination,
    adults,
    children: Number(values["children"] || "0"),
    cabin: values["cabin"] || "economy",
    stops: values["stops"] || "any",
    currency: (values["currency"] || "USD").toUpperCase(),
    date_mode: "exact",
    outbound_date: outbound,
    return_date: ret,
    threshold_amount_cents: thresholdCents,
    threshold_basis: "party",
    alert_on_threshold: values["alert_on_threshold"] ? 1 : 0,
    alert_on_new_low: values["alert_on_new_low"] ? 1 : 0,
    cooldown_minutes: Number(values["cooldown_minutes"] || "360"),
    check_interval_minutes: interval,
    status: TrackerStatus.ACTIVE,
    updated_at: nowIso(),
  };

  return { values, errors, fields, markets: [defaultMarket] };
}

// ------------------------------------------------------------------ helpers
const FLASH_MESSAGES: Record<string, Flash> = {
  created: { level: "success", message: "Tracker created." },
  saved: { level: "success", message: "Changes saved." },
  deleted: { level: "success", message: "Tracker deleted." },
  duplicated: { level: "success", message: "Tracker duplicated. The copy starts paused." },
  active: { level: "success", message: "Tracker resumed." },
  paused: { level: "info", message: "Tracker paused." },
  checked: { level: "success", message: "Check complete." },
  busy: {
    level: "warning",
    message: "A check for this tracker is already running. Nothing was started twice.",
  },
  test_sent: { level: "success", message: "Test message delivered to Telegram." },
  test_failed: {
    level: "danger",
    message: "The test message could not be delivered. See the integration status above.",
  },
  telegram_missing: {
    level: "warning",
    message: "Telegram is not fully configured, so no message was sent.",
  },
};

function flashesFrom(url: URL): Flash[] {
  const key = url.searchParams.get("flash");
  const flash = key ? FLASH_MESSAGES[key] : undefined;
  return flash ? [flash] : [];
}

function notFound(ctx: Ctx): Response {
  return htmlResponse(
    layout(
      { title: "Not found", nav: "none", appTimezone: ctx.config.appTimezone, authenticated: true },
      errorPage({ status: 404, detail: "That page does not exist." }),
    ),
    { status: 404 },
  );
}

export { servicesFor, WORKER_VERSION, CRON_SCHEDULE };
