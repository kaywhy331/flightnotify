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
import { ProviderError } from "../providers/errors.js";
import { TelegramNotifier } from "../services/telegram.js";
import { buildTestMessage } from "../services/messages.js";
import { TelegramBot } from "../services/bot.js";
import { ensureConfigVersion } from "../services/tracker.js";
import { DateMode, RunTrigger, TrackerStatus } from "../domain/enums.js";
import { nowIso, todayIn } from "../time.js";
import { humanizeDuration } from "../services/planner.js";
import { renderPriceChart } from "./chart.js";
import type { PriceContext } from "./views.js";
import {
  AVAILABLE_MARKETS,
  budgetFor,
  parseTrackerForm,
  valuesFromTracker,
  type ParsedTrackerForm,
} from "./tracker-form.js";
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
import { htmlResponse, layout, redirect, type Flash, type SafeHtml } from "./html.js";
import { APP_CSS, APP_CSS_ETAG, APP_JS, APP_JS_ETAG } from "./static-assets.js";
import { handleTelegramWebhook } from "./telegram-webhook.js";
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
/** Browser forms are tiny; cap buffering so a public POST cannot consume the isolate. */
const MAX_FORM_BODY_BYTES = 64 * 1024;

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

async function boundedFormData(request: Request): Promise<FormData | Response> {
  const mediaType = (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (
    mediaType !== "application/x-www-form-urlencoded" &&
    mediaType !== "multipart/form-data"
  ) {
    return Response.json(
      { detail: "Form submissions must use form-encoded data." },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }

  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_FORM_BODY_BYTES) {
    return Response.json(
      { detail: "Form submission is too large." },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (request.body === null) return new FormData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FORM_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return Response.json(
          { detail: "Form submission is too large." },
          { status: 413, headers: { "Cache-Control": "no-store" } },
        );
      }
      chunks.push(next.value);
    }
  } catch {
    return Response.json(
      { detail: "Form submission could not be read." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const replay = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
    });
    return await replay.formData();
  } catch {
    return Response.json(
      { detail: "Form submission is malformed." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const response = await dispatchRequest(request, env);
  return hardenResponse(request, response);
}

async function dispatchRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { config, problems, usable } = loadConfig(env);
  // Behind Cloudflare this is always https; only local `wrangler dev` is http.
  const secure = url.protocol === "https:";

  if (url.pathname === "/healthz") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    return healthz(env, usable);
  }

  // Served before the setup gate and before the session guard: a stylesheet is
  // not private, and the setup page needs it to be legible.
  if (url.pathname === "/static/app.css") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    return staticAsset(request, APP_CSS, "text/css; charset=utf-8", APP_CSS_ETAG);
  }
  if (url.pathname === "/static/app.js") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(["GET", "HEAD"]);
    }
    return staticAsset(request, APP_JS, "text/javascript; charset=utf-8", APP_JS_ETAG);
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
  if (url.pathname === "/telegram/webhook") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const { notifier, quota, search } = servicesFor({
      request,
      env,
      repo,
      config,
      csrf: "",
    });
    return handleTelegramWebhook(request, {
      secret: config.telegramWebhookSecret,
      bot: new TelegramBot({
        repo,
        config,
        notifier,
        quota,
        search,
        version: WORKER_VERSION,
      }),
    });
  }
  const sessionGeneration = (await repo.getSetting<string>("session_generation")) ?? "1";
  const session = await verifySessionToken(
    config.sessionSecret,
    readCookie(request, SESSION_COOKIE),
    new Date(),
    sessionGeneration,
  );

  if (!session && !PUBLIC_PATHS.has(url.pathname)) {
    return redirect("/login");
  }

  if (url.pathname === "/login") {
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }
    return session
      ? redirect("/")
      : loginRoute(request, repo, config, secure, sessionGeneration);
  }

  if (!session) return redirect("/login");
  const csrf = await csrfTokenFor(config.sessionSecret, session.sid);

  const allowed = authenticatedMethods(url.pathname);
  if (allowed !== null && !allowed.includes(request.method)) return methodNotAllowed(allowed);
  if (allowed === null && request.method !== "GET" && request.method !== "HEAD") {
    return notFound({ request, env, repo, config, csrf });
  }

  // --- mutations: CSRF-checked centrally --------------------------------
  if (request.method === "POST") {
    const parsedBody = await boundedFormData(request);
    if (parsedBody instanceof Response) return parsedBody;
    const form = parsedBody;
    if (!(await csrfValid(config.sessionSecret, session.sid, formText(form, "csrf_token")))) {
      return htmlResponse(
        layout(
          {
            title: "Invalid request",
            nav: "none",
            appTimezone: config.appTimezone,
            authenticated: true,
            csrfToken: csrf,
          },
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
    if (url.pathname === "/logout") {
      return redirect("/login", { "Set-Cookie": clearedSessionCookie(secure) });
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
  sessionGeneration: string,
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

  const parsedBody = await boundedFormData(request);
  if (parsedBody instanceof Response) return parsedBody;
  const form = parsedBody;
  const password = formText(form, "password");
  const ok = await verifyPassword(password, config.authPasswordHash);

  if (!ok) {
    await recordAuthFailure(repo, key);
    // Deliberately identical for a wrong password and an unknown state: there
    // is only one account, so any distinction is a free hint to an attacker.
    return page("Incorrect password.", 401);
  }

  await clearAuthFailures(repo, key);
  const token = await createSessionToken(config.sessionSecret, new Date(), sessionGeneration);
  return redirect("/", { "Set-Cookie": sessionCookie(token, secure) });
}

function authenticatedMethods(pathname: string): string[] | null {
  if (pathname === "/" || pathname === "/settings" || pathname === "/trackers/new") {
    return ["GET", "HEAD"];
  }
  if (pathname === "/trackers") return ["GET", "HEAD", "POST"];
  if (pathname === "/logout" || pathname === "/api/estimate") return ["POST"];
  if (/^\/trackers\/\d+$/.test(pathname)) return ["GET", "HEAD", "POST"];
  if (/^\/trackers\/\d+\/edit$/.test(pathname)) return ["GET", "HEAD"];
  if (/^\/trackers\/\d+\/(check|toggle|delete|duplicate)$/.test(pathname)) return ["POST"];
  if (
    /^\/settings\/(test-message|discover-chat|sync-provider|revoke-sessions)$/.test(pathname) ||
    /^\/settings\/telegram-webhook\/(enable|disable)$/.test(pathname)
  ) return ["POST"];
  return null;
}

function methodNotAllowed(allow: string[]): Response {
  return Response.json(
    { detail: "Method not allowed." },
    {
      status: 405,
      headers: { Allow: allow.join(", "), "Cache-Control": "no-store" },
    },
  );
}

export function hardenResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if ((headers.get("Content-Type") ?? "").startsWith("text/html")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Serve an inlined asset with an ETag so repeat loads are a 304. */
function staticAsset(request: Request, body: string, contentType: string, etag: string): Response {
  const tag = `"${etag}"`;
  const immutable = new URL(request.url).searchParams.get("v") === etag;
  const cacheControl = immutable
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
  const validators = (request.headers.get("If-None-Match") ?? "")
    .split(",")
    .map((value) => value.trim());
  if (
    validators.some(
      (value) => value === "*" || value === tag || value.replace(/^W\//, "") === tag,
    )
  ) {
    return new Response(null, {
      status: 304,
      headers: { ETag: tag, "Cache-Control": cacheControl, "Content-Type": contentType },
    });
  }
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      ETag: tag,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
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

async function telegramWebhookStatus(ctx: Ctx) {
  const expectedUrl = `${new URL(ctx.request.url).origin}/telegram/webhook`;
  const { notifier } = servicesFor(ctx);
  if (!notifier.isConfigured()) return { expectedUrl, info: null, error: null };
  const status = await notifier.getWebhookInfo();
  return {
    expectedUrl,
    info: status.info,
    error: status.result.ok ? null : status.result.userMessage,
  };
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
    telegramWebhookSecretConfigured: config.telegramWebhookSecret !== "",
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
      layout(
        {
          title,
          nav,
          appTimezone: config.appTimezone,
          authenticated: true,
          flashes,
          csrfToken: ctx.csrf,
        },
        body,
      ),
    );

  if (url.pathname === "/") {
    const [status, trackers, alerts, sparklines] = await Promise.all([
      operationalStatus(ctx),
      repo.listTrackers(),
      repo.recentAlerts(5),
      repo.sparklineSeries(),
    ]);
    return page(
      "Dashboard",
      "dashboard",
      dashboardPage({
        status,
        trackers,
        recentAlerts: alerts,
        tz: config.appTimezone,
        sparklines,
      }),
      flashesFrom(url),
    );
  }

  if (url.pathname === "/trackers") {
    const trackers = await repo.listTrackers();
    return page("Trackers", "trackers", trackersPage({ trackers, tz: config.appTimezone }), flashesFrom(url));
  }

  if (url.pathname === "/trackers/new") {
    return page("New tracker", "trackers", await formView(ctx, null, {}, {}));
  }

  const detail = url.pathname.match(/^\/trackers\/(\d+)$/);
  if (detail) {
    const tracker = await repo.getTracker(Number(detail[1]));
    if (!tracker) return notFound(ctx);
    const isWindow =
      tracker.date_mode === DateMode.CUSTOM_WINDOW && tracker.current_config_version_id !== null;
    const requestedPage = Number(url.searchParams.get("page") ?? "1");
    const normalizedHistoryPage =
      Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const historyPageSize = 50;
    const [chartObservations, historyTotal, runs, alerts, candidates, candidateCoverage] =
      await Promise.all([
      repo.observationsForTracker(tracker.id, 200),
      repo.countObservationsForTracker(tracker.id),
      repo.recentRuns(tracker.id, 15),
      repo.recentAlertsForTracker(tracker.id, 10),
      isWindow
        ? repo.candidatePrices(tracker.current_config_version_id!, tracker.coverage_cycle)
        : Promise.resolve([]),
      isWindow
        ? repo.candidateCoverage(tracker.current_config_version_id!, tracker.coverage_cycle)
        : Promise.resolve(null),
    ]);
    const maxHistoryPage = Math.max(1, Math.ceil(historyTotal / historyPageSize));
    const historyPage = Math.min(normalizedHistoryPage, maxHistoryPage);
    const observations =
      historyPage === 1
        ? chartObservations.slice(0, historyPageSize)
        : await repo.observationsForTracker(
            tracker.id,
            historyPageSize,
            (historyPage - 1) * historyPageSize,
          );
    const { provider, quota } = servicesFor(ctx);
    const snapshot = await quota.snapshot();

    // Chart and context are computed from the best fare of each run so a
    // single scan that returned 25 offers reads as one point, not a cliff.
    const bestOfRuns = chartObservations
      .filter((o) => o.is_best_of_run === 1)
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    const chartSvg = renderPriceChart(
      bestOfRuns.map((o) => ({
        observedAt: o.observed_at,
        amountCents: o.price_amount_cents,
        label: (() => {
          try {
            const airlines = o.airlines ? (JSON.parse(o.airlines) as string[]) : [];
            return airlines.slice(0, 2).join(", ") || tracker.name;
          } catch {
            return tracker.name;
          }
        })(),
      })),
      {
        currency: tracker.currency,
        timeZone: config.appTimezone,
        thresholdCents: tracker.threshold_amount_cents,
        lowCents: tracker.low_price_cents,
      },
    );

    return page(
      tracker.name,
      "trackers",
      trackerDetailPage({
        tracker,
        observations,
        latestObservation: chartObservations[0] ?? null,
        runs,
        alerts,
        csrf: ctx.csrf,
        tz: config.appTimezone,
        quotaBlocked: snapshot.remainingHard <= 0,
        context: priceContextFor(tracker, chartObservations, bestOfRuns),
        chartSvg: bestOfRuns.length > 0 ? chartSvg : null,
        candidates,
        candidateCoverage,
        historyPage,
        historyPageSize,
        historyTotal,
        maxProviderRequestsPerSearch: Math.max(1, provider.maxRequestCount ?? 1),
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
      await formView(ctx, tracker.id, valuesFromTracker(tracker as unknown as Record<string, unknown>), {}),
    );
  }

  if (url.pathname === "/settings") {
    const [status, webhook] = await Promise.all([
      operationalStatus(ctx),
      telegramWebhookStatus(ctx),
    ]);
    return page(
      "Settings",
      "settings",
      settingsPage({
        status,
        csrf: ctx.csrf,
        discovered: null,
        discoverError: null,
        webhook,
        tz: config.appTimezone,
      }),
      flashesFrom(url),
    );
  }

  return notFound(ctx);
}


/**
 * Book-or-wait context from stored observations. Descriptive only: every
 * number is something FlightNotify observed, never a prediction.
 */
function priceContextFor(
  tracker: TrackerWithMarkets,
  observations: { price_amount_cents: number; eligible: number }[],
  bestOfRuns: { price_amount_cents: number }[],
): PriceContext {
  const eligible = observations.filter((o) => o.eligible === 1);
  const prices = eligible.map((o) => o.price_amount_cents);
  const lo = prices.length > 0 ? Math.min(...prices) : null;
  const hi = prices.length > 0 ? Math.max(...prices) : null;

  const latestBest = bestOfRuns[bestOfRuns.length - 1]?.price_amount_cents ?? null;
  const previousBest = bestOfRuns[bestOfRuns.length - 2]?.price_amount_cents ?? null;

  const threshold = tracker.threshold_amount_cents;
  // "Within 15%" uses integer math to stay off the float path money never takes.
  const nearThresholdCount = prices.filter((p) => p * 100 <= threshold * 115).length;

  // Suggest only when the configured threshold has never been approached and a
  // low exists to anchor on: observed low + 5%, rounded up to the next $50.
  const suggested =
    nearThresholdCount === 0 && lo !== null && lo * 100 > threshold * 115
      ? Math.ceil((lo * 105) / 100 / 5000) * 5000
      : null;

  return {
    trendCents: latestBest !== null && previousBest !== null ? latestBest - previousBest : null,
    rangeLoCents: lo,
    rangeHiCents: hi,
    observationCount: eligible.length,
    nearThresholdCount,
    suggestedThresholdCents: suggested,
  };
}

// ------------------------------------------------------------- form helpers
/**
 * Render the tracker form with a budget preview computed from whatever the
 * operator has entered so far, so the cost of a window is visible before the
 * save rather than discovered from a drained allowance a week later.
 */
async function formView(
  ctx: Ctx,
  trackerId: number | null,
  values: Record<string, string>,
  errors: Record<string, string>,
  parsed?: ParsedTrackerForm,
): Promise<SafeHtml> {
  const { provider, quota } = servicesFor(ctx);
  const snapshot = await quota.snapshot();
  const effective = parsed ?? parseValuesForEstimate(values, ctx);
  return trackerFormPage({
    trackerId,
    values,
    errors,
    csrf: ctx.csrf,
    today: todayIn(ctx.config.appTimezone),
    budget: budgetFor(effective, snapshot, Math.max(1, provider.maxRequestCount ?? 1)),
    availableMarkets: [...AVAILABLE_MARKETS],
  });
}

/** Re-parse stored values through the same code path the form submits use. */
function parseValuesForEstimate(
  values: Record<string, string>,
  ctx: Ctx,
): ParsedTrackerForm {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (key === "markets") {
      for (const market of value.split(",").filter(Boolean)) form.append("markets", market);
    } else if (value !== "") {
      form.set(key, value);
    }
  }
  return parseTrackerForm(form, {
    defaultMarket: ctx.config.defaultMarket,
    today: todayIn(ctx.config.appTimezone),
  });
}

/**
 * Refuse a save whose single scan cannot fit the remaining allowance, and make
 * a merely-expensive one require an explicit acknowledgement.
 *
 * Returns true when the form must be redisplayed. The message lands on
 * `sampled_mode_ack` because that is the control the operator acts on.
 */
async function refuseIfOverBudget(ctx: Ctx, parsed: ParsedTrackerForm): Promise<boolean> {
  if (Object.keys(parsed.errors).length > 0) return false;
  const { provider, quota } = servicesFor(ctx);
  const budget = budgetFor(
    parsed,
    await quota.snapshot(),
    Math.max(1, provider.maxRequestCount ?? 1),
  );

  if (budget.verdict.severity === "blocked") {
    parsed.errors["sampled_mode_ack"] = budget.verdict.detail;
    return true;
  }
  if (budget.verdict.severity === "warning" && !parsed.sampledModeAck) {
    parsed.errors["sampled_mode_ack"] =
      `${budget.verdict.detail} Tick the box below to save it anyway.`;
    return true;
  }
  return false;
}

/**
 * Write the tracker's config version and, for a custom window, its date-pair
 * queue.
 *
 * Order matters: the config version has to exist first because candidates are
 * keyed to it, and rebuilding the queue is what makes an edited window take
 * effect instead of continuing to sweep the previous one.
 */
async function persistCandidates(
  ctx: Ctx,
  tracker: TrackerWithMarkets,
  parsed: ParsedTrackerForm,
): Promise<void> {
  await ensureConfigVersion(ctx.repo, tracker, {
    candidates:
      parsed.dateMode === DateMode.CUSTOM_WINDOW
        ? parsed.candidates.map((pair) => ({
            outbound: pair.outbound,
            ret: pair.inbound,
            nights: pair.nights,
          }))
        : [],
  });
}

// -------------------------------------------------------------- POST routes
async function postRoute(url: URL, form: FormData, ctx: Ctx): Promise<Response> {
  const { repo, config } = ctx;

  // Live budget preview for the form. Read-only, but still a POST behind the
  // session guard and the CSRF check, because it echoes back what the operator
  // typed and reveals their remaining allowance.
  if (url.pathname === "/api/estimate") {
    const parsed = parseTrackerForm(form, {
      defaultMarket: config.defaultMarket,
      today: todayIn(config.appTimezone),
    });
    const { provider, quota } = servicesFor(ctx);
    const snapshot = await quota.snapshot();
    const budget = budgetFor(
      parsed,
      snapshot,
      Math.max(1, provider.maxRequestCount ?? 1),
    );
    const dateErrors = [
      parsed.errors["outbound_date"],
      parsed.errors["return_date"],
      parsed.errors["window_outbound_start"],
      parsed.errors["window_outbound_end"],
      parsed.errors["min_nights"],
      parsed.errors["max_nights"],
      parsed.errors["flex_month"],
      parsed.errors["flex_duration"],
    ].filter((message): message is string => Boolean(message));

    return Response.json(
      {
        headline: budget.verdict.headline,
        detail: budget.verdict.detail,
        severity: budget.verdict.severity,
        calls_per_scan: budget.estimate.callsPerScan,
        max_calls_per_scan: budget.estimate.maxCallsPerScan,
        max_requests_per_search: budget.estimate.maxRequestsPerSearch,
        remaining_safe: snapshot.remainingSafe,
        monthly_limit: snapshot.monthlyLimit,
        candidate_count: budget.candidateCount,
        market_count: budget.marketCount,
        scans_per_full_cycle: budget.estimate.scansPerFullCycle,
        calls_per_full_cycle: budget.estimate.callsPerFullCycle,
        max_calls_per_full_cycle: budget.estimate.maxCallsPerFullCycle,
        full_cycle_duration: humanizeDuration(budget.estimate.fullCycleMinutes),
        suggestions: budget.verdict.suggestions,
        date_errors: dateErrors,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (url.pathname === "/trackers") {
    const parsed = parseTrackerForm(form, {
      defaultMarket: config.defaultMarket,
      today: todayIn(config.appTimezone),
    });
    const refusal = await refuseIfOverBudget(ctx, parsed);
    if (Object.keys(parsed.errors).length > 0 || refusal) {
      return htmlResponse(
        layout(
          {
            title: "New tracker",
            nav: "trackers",
            appTimezone: config.appTimezone,
            authenticated: true,
            csrfToken: ctx.csrf,
          },
          await formView(ctx, null, parsed.values, parsed.errors, parsed),
        ),
        { status: 422 },
      );
    }
    const id = await repo.insertTrackerWithMarkets({
      ...parsed.fields,
      created_at: nowIso(),
      updated_at: nowIso(),
    }, parsed.markets);
    const tracker = await repo.getTracker(id);
    if (tracker) await persistCandidates(ctx, tracker, parsed);
    return redirect(`/trackers/${id}?flash=created`);
  }

  const update = url.pathname.match(/^\/trackers\/(\d+)$/);
  if (update) {
    const tracker = await repo.getTracker(Number(update[1]));
    if (!tracker) return notFound(ctx);
    const parsed = parseTrackerForm(form, {
      defaultMarket: config.defaultMarket,
      today: todayIn(config.appTimezone),
    });
    const refusal = await refuseIfOverBudget(ctx, parsed);
    if (Object.keys(parsed.errors).length > 0 || refusal) {
      return htmlResponse(
        layout(
          {
            title: "Edit tracker",
            nav: "trackers",
            appTimezone: config.appTimezone,
            authenticated: true,
            csrfToken: ctx.csrf,
          },
          await formView(ctx, tracker.id, parsed.values, parsed.errors, parsed),
        ),
        { status: 422 },
      );
    }
    const owner = `edit:${crypto.randomUUID().slice(0, 8)}`;
    const locked = await repo.acquireTrackerLock(tracker.id, owner, config.schedulerLeaseTtlSeconds);
    if (!locked) return redirect(`/trackers/${tracker.id}?flash=busy`);
    try {
      // Editing future dates is the explicit way to revive a completed trip;
      // paused/error trackers otherwise retain their status until Resume.
      parsed.fields["status"] =
        tracker.status === TrackerStatus.COMPLETED ? TrackerStatus.ACTIVE : tracker.status;
      await repo.updateTrackerWithMarkets(tracker.id, parsed.fields, parsed.markets);
      const fresh = await repo.getTracker(tracker.id);
      if (fresh) await persistCandidates(ctx, fresh, parsed);
      return redirect(`/trackers/${tracker.id}?flash=saved`);
    } finally {
      await repo.releaseTrackerLock(tracker.id, owner);
    }
  }

  const action = url.pathname.match(/^\/trackers\/(\d+)\/(check|toggle|delete|duplicate)$/);
  if (action) {
    const tracker = await repo.getTracker(Number(action[1]));
    if (!tracker) return notFound(ctx);
    const owner = `${action[2]}:${crypto.randomUUID().slice(0, 8)}`;
    const locked = await repo.acquireTrackerLock(tracker.id, owner, config.schedulerLeaseTtlSeconds);
    if (!locked) return redirect(`/trackers/${tracker.id}?flash=busy`);
    try {
      if (action[2] === "delete") {
        await repo.deleteTracker(tracker.id);
        return redirect("/trackers?flash=deleted");
      }

      if (action[2] === "toggle") {
        if (tracker.status === TrackerStatus.COMPLETED) {
          return redirect(`/trackers/${tracker.id}?flash=completed_edit`);
        }
        const next =
          tracker.status === TrackerStatus.ACTIVE ? TrackerStatus.PAUSED : TrackerStatus.ACTIVE;
        await repo.updateTrackerFields(
          tracker.id,
          next === TrackerStatus.ACTIVE
            ? {
                status: next,
                next_run_at: nowIso(),
                consecutive_failures: 0,
                last_error_category: null,
                last_error_message: null,
              }
            : { status: next, next_run_at: null },
        );
        return redirect(`/trackers/${tracker.id}?flash=${next}`);
      }

      if (action[2] === "duplicate") {
        const { id: _id, markets, ...stored } = tracker;
        const copy: Record<string, unknown> = {
          ...stored,
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
          coverage_cycle: 1,
          last_error_category: null,
          last_error_message: null,
          lock_owner: null,
          lock_expires_at: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        const sourceCandidates =
          tracker.date_mode === DateMode.CUSTOM_WINDOW && tracker.current_config_version_id !== null
            ? await repo.candidateDefinitions(tracker.current_config_version_id)
            : [];
        const id = await repo.insertTrackerWithMarkets(copy, markets);
        const fresh = await repo.getTracker(id);
        if (fresh) {
          await ensureConfigVersion(repo, fresh, {
            candidates: tracker.date_mode === DateMode.CUSTOM_WINDOW ? sourceCandidates : [],
          });
        }
        return redirect(`/trackers/${id}?flash=duplicated`);
      }

      // Manual check: same lock, quota, observation and alert path as Cron.
      const { search } = servicesFor(ctx);
      const result = await search.runTracker(tracker, RunTrigger.MANUAL, {
        forceRefresh: form.get("force_refresh") === "1",
      });
      const flash =
        result.providerCalls === 0 && result.cacheHits === 0 && result.workRemaining
          ? "check_blocked"
          : result.errors.length > 0 && result.successfulUnits === 0
            ? "check_failed"
            : result.workRemaining
              ? "check_partial"
              : result.offersFound === 0
                ? "checked_no_results"
                : "checked";
      return redirect(`/trackers/${tracker.id}?flash=${flash}`);
    } finally {
      await repo.releaseTrackerLock(tracker.id, owner);
    }
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

  if (url.pathname === "/settings/sync-provider") {
    const { provider, quota } = servicesFor(ctx);
    if (!provider.isConfigured()) return redirect("/settings?flash=provider_missing");
    try {
      const status = await provider.accountStatus();
      await quota.syncFromProvider(status, null);
      return redirect("/settings?flash=provider_synced");
    } catch (error) {
      const detail =
        error instanceof ProviderError
          ? error.guidance()
          : "Provider account status could not be refreshed.";
      await quota.syncFromProvider(null, detail.slice(0, 500));
      console.error(
        JSON.stringify({
          event: "provider_account_sync_failed",
          category: error instanceof ProviderError ? error.category : "internal",
        }),
      );
      return redirect("/settings?flash=provider_sync_failed");
    }
  }

  if (url.pathname === "/settings/revoke-sessions") {
    await repo.setSetting("session_generation", crypto.randomUUID());
    return redirect("/login", {
      "Set-Cookie": clearedSessionCookie(new URL(ctx.request.url).protocol === "https:"),
    });
  }

  if (url.pathname === "/settings/discover-chat") {
    const { notifier } = servicesFor(ctx);
    const status = await operationalStatus(ctx);
    const discovery = await notifier.discoverChats();
    return htmlResponse(
      layout(
        {
          title: "Settings",
          nav: "settings",
          appTimezone: config.appTimezone,
          authenticated: true,
          csrfToken: ctx.csrf,
        },
        settingsPage({
          status,
          csrf: ctx.csrf,
          discovered: discovery.chats.map((c) => ({
            chatId: c.chatId,
            displayName: c.displayName,
            lastText: c.lastText,
          })),
          discoverError: discovery.result.ok ? null : discovery.result.userMessage,
          webhook: await telegramWebhookStatus(ctx),
          tz: config.appTimezone,
        }),
      ),
    );
  }

  const webhookAction = url.pathname.match(/^\/settings\/telegram-webhook\/(enable|disable)$/);
  if (webhookAction) {
    const { notifier } = servicesFor(ctx);
    if (webhookAction[1] === "enable") {
      if (
        !notifier.isConfigured() ||
        config.telegramChatId === "" ||
        config.telegramWebhookSecret === ""
      ) {
        return redirect("/settings?flash=telegram_webhook_missing");
      }
      const target = `${new URL(ctx.request.url).origin}/telegram/webhook`;
      const result = await notifier.setWebhook(target, config.telegramWebhookSecret);
      if (!result.ok) {
        console.error(
          JSON.stringify({ event: "telegram_webhook_enable_failed", category: result.category }),
        );
      }
      return redirect(
        `/settings?flash=${result.ok ? "telegram_webhook_enabled" : "telegram_webhook_enable_failed"}`,
      );
    }

    if (!notifier.isConfigured()) return redirect("/settings?flash=telegram_missing");
    const result = await notifier.deleteWebhook();
    if (!result.ok) {
      console.error(
        JSON.stringify({ event: "telegram_webhook_disable_failed", category: result.category }),
      );
    }
    return redirect(
      `/settings?flash=${result.ok ? "telegram_webhook_disabled" : "telegram_webhook_disable_failed"}`,
    );
  }

  return notFound(ctx);
}

// ------------------------------------------------------------------ helpers
const FLASH_MESSAGES: Record<string, Flash> = {
  created: { level: "success", message: "Tracker created." },
  saved: { level: "success", message: "Changes saved." },
  deleted: { level: "success", message: "Tracker deleted." },
  duplicated: { level: "success", message: "Tracker duplicated. The copy starts paused." },
  active: { level: "success", message: "Tracker resumed." },
  paused: { level: "info", message: "Tracker paused." },
  completed_edit: {
    level: "info",
    message: "This trip is complete. Edit it with future dates to resume tracking.",
  },
  checked: { level: "success", message: "Check complete." },
  checked_no_results: {
    level: "info",
    message: "Check completed, but no eligible itinerary was returned.",
  },
  check_partial: {
    level: "warning",
    message: "Part of this check completed. Remaining date/market work will resume on the next run.",
  },
  check_blocked: {
    level: "warning",
    message: "No provider search ran because the configured quota allowance is currently unavailable.",
  },
  check_failed: {
    level: "danger",
    message: "The provider check failed. Stored price history was left unchanged; see the run details below.",
  },
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
  telegram_webhook_enabled: {
    level: "success",
    message: "Telegram commands enabled for this deployment URL.",
  },
  telegram_webhook_enable_failed: {
    level: "danger",
    message: "Telegram did not enable the command webhook. Check the status below and Worker logs.",
  },
  telegram_webhook_disabled: {
    level: "success",
    message: "Telegram commands disabled. Alert delivery is unchanged.",
  },
  telegram_webhook_disable_failed: {
    level: "danger",
    message: "Telegram did not disable the command webhook. Check the status below and Worker logs.",
  },
  telegram_webhook_missing: {
    level: "warning",
    message:
      "Set the bot token, chat id and TELEGRAM_WEBHOOK_SECRET before enabling commands.",
  },
  provider_synced: {
    level: "success",
    message: "Provider allowance refreshed. Account-status reads do not consume fare searches.",
  },
  provider_sync_failed: {
    level: "danger",
    message: "Provider allowance could not be refreshed. The local hard cap remains in force.",
  },
  provider_missing: {
    level: "warning",
    message: "Set SERPAPI_API_KEY before refreshing provider allowance.",
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
      {
        title: "Not found",
        nav: "none",
        appTimezone: ctx.config.appTimezone,
        authenticated: true,
        csrfToken: ctx.csrf,
      },
      errorPage({ status: 404, detail: "That page does not exist." }),
    ),
    { status: 404 },
  );
}

export { servicesFor, WORKER_VERSION, CRON_SCHEDULE };
