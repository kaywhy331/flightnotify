/**
 * Tracker create/edit flows, driven through the real router against real D1.
 *
 * These go through `handleRequest` rather than calling the parser directly, so
 * the session guard, the CSRF check, the D1 writes and the candidate queue are
 * all exercised by the same path a browser takes. Nothing here touches the
 * network: no SerpApi key and no Telegram token is configured, so a stray live
 * call would fail loudly rather than spend the owner's quota.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import workerEntrypoint from "../../src/index.js";
import { Repo } from "../../src/db/repo.js";
import type { Env } from "../../src/env.js";
import { QuotaManager } from "../../src/services/quota.js";
import { handleRequest } from "../../src/web/router.js";
import { hashPassword } from "../../src/web/auth.js";
import { todayIn } from "../../src/time.js";

const PASSWORD = "test-password-not-real";
const TZ = "UTC";
let passwordHash = "";

/** Deliberately no SERPAPI/TELEGRAM credentials: tests must never go live. */
function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    SESSION_SECRET: "t".repeat(48),
    AUTH_PASSWORD_HASH: passwordHash,
    APP_TIMEZONE: TZ,
    DEFAULT_MARKET: "us",
    MONTHLY_SEARCH_BUDGET: "250",
    SEARCH_BUDGET_RESERVE_PERCENT: "4",
    HOURLY_SEARCH_LIMIT: "50",
    SCHEDULER_ENABLED: "false",
    OFFLINE_MODE: "true",
    ...overrides,
  } as Env;
}

const BASE = "https://flightnotify.test";

async function signIn(e: Env = testEnv()): Promise<string> {
  const body = new FormData();
  body.set("password", PASSWORD);
  const response = await handleRequest(
    new Request(`${BASE}/login`, { method: "POST", body }),
    e,
  );
  const cookie = response.headers.get("Set-Cookie") ?? "";
  const value = cookie.split(";")[0] ?? "";
  expect(response.status).toBe(303);
  return value;
}

async function csrfFrom(cookie: string, path: string, e: Env = testEnv()): Promise<string> {
  const response = await handleRequest(
    new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }),
    e,
  );
  const html = await response.text();
  return /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

function futureDate(daysAhead: number): string {
  const base = new Date(`${todayIn(TZ)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + daysAhead);
  return base.toISOString().slice(0, 10);
}

/** A month inside Explore's six-month horizon. */
function presetMonth(): { month: number; year: number } {
  const base = new Date(`${todayIn(TZ)}T00:00:00Z`);
  base.setUTCMonth(base.getUTCMonth() + 2);
  return { month: base.getUTCMonth() + 1, year: base.getUTCFullYear() };
}

function baseForm(csrf: string): FormData {
  const form = new FormData();
  form.set("csrf_token", csrf);
  form.set("name", "Test tracker");
  form.set("origin", "SFO");
  form.set("destination", "NRT");
  form.set("adults", "2");
  form.set("children", "0");
  form.set("cabin", "economy");
  form.set("stops", "any");
  form.set("currency", "USD");
  form.set("threshold_amount", "1300");
  form.set("check_interval_minutes", "720");
  form.set("cooldown_minutes", "360");
  form.set("alert_on_threshold", "on");
  form.set("alert_on_new_low", "on");
  form.append("markets", "us");
  return form;
}

function exactForm(csrf: string): FormData {
  const form = baseForm(csrf);
  form.set("date_mode", "exact");
  form.set("outbound_date", futureDate(60));
  form.set("return_date", futureDate(68));
  return form;
}

function presetForm(csrf: string): FormData {
  const form = baseForm(csrf);
  const { month, year } = presetMonth();
  form.set("date_mode", "flexible_preset");
  form.set("flex_month", String(month));
  form.set("flex_year", String(year));
  form.set("flex_duration", "one_week");
  return form;
}

/** 3 departure days x 3 lengths = 9 date pairs. */
function windowForm(csrf: string): FormData {
  const form = baseForm(csrf);
  form.set("date_mode", "custom_window");
  form.set("window_outbound_start", futureDate(60));
  form.set("window_outbound_end", futureDate(62));
  form.set("min_nights", "5");
  form.set("max_nights", "7");
  form.set("candidates_per_run", "2");
  return form;
}

/** 3 departure days x 3 return days = 9 date pairs. */
function returnWindowForm(csrf: string): FormData {
  const form = baseForm(csrf);
  form.set("date_mode", "custom_window");
  form.set("window_outbound_start", futureDate(60));
  form.set("window_outbound_end", futureDate(62));
  form.set("window_return_start", futureDate(68));
  form.set("window_return_end", futureDate(70));
  form.set("candidates_per_run", "2");
  return form;
}

async function post(path: string, cookie: string, form: FormData, e: Env = testEnv()) {
  return handleRequest(
    new Request(`${BASE}${path}`, { method: "POST", body: form, headers: { Cookie: cookie } }),
    e,
  );
}

beforeEach(async () => {
  if (passwordHash === "") passwordHash = await hashPassword(PASSWORD);
  await env.DB.exec("DELETE FROM flexible_date_candidates");
  await env.DB.exec("DELETE FROM alert_events");
  await env.DB.exec("DELETE FROM fare_observations");
  await env.DB.exec("DELETE FROM search_runs");
  await env.DB.exec("DELETE FROM tracker_config_versions");
  await env.DB.exec("DELETE FROM tracker_markets");
  await env.DB.exec("DELETE FROM trackers");
  await env.DB.exec("DELETE FROM auth_throttle");
});

// ---------------------------------------------------------------- security
describe("authentication and CSRF on mutations", () => {
  const mutations: [string, string][] = [
    ["POST", "/trackers"],
    ["POST", "/trackers/1"],
    ["POST", "/trackers/1/check"],
    ["POST", "/trackers/1/toggle"],
    ["POST", "/trackers/1/delete"],
    ["POST", "/trackers/1/duplicate"],
    ["POST", "/api/estimate"],
    ["POST", "/settings/test-message"],
    ["POST", "/settings/discover-chat"],
    ["POST", "/settings/sync-provider"],
    ["POST", "/settings/revoke-sessions"],
    ["POST", "/settings/telegram-webhook/enable"],
    ["POST", "/settings/telegram-webhook/disable"],
    ["POST", "/logout"],
  ];

  for (const [method, path] of mutations) {
    it(`redirects ${method} ${path} to /login without a session`, async () => {
      const response = await handleRequest(
        new Request(`${BASE}${path}`, { method, body: new FormData() }),
        testEnv(),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/login");
    });

    it(`rejects ${method} ${path} without a CSRF token`, async () => {
      const cookie = await signIn();
      const response = await post(path, cookie, new FormData());
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/could not be verified/);
    });
  }

  it("rejects a CSRF token minted for a different session", async () => {
    const cookieA = await signIn();
    const csrfA = await csrfFrom(cookieA, "/trackers/new");
    const cookieB = await signIn();

    const form = exactForm(csrfA);
    const response = await post("/trackers", cookieB, form);
    expect(response.status).toBe(400);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });

  it("serves the form only to a signed-in session", async () => {
    const anonymous = await handleRequest(new Request(`${BASE}/trackers/new`), testEnv());
    expect(anonymous.status).toBe(303);

    const cookie = await signIn();
    const authed = await handleRequest(
      new Request(`${BASE}/trackers/new`, { headers: { Cookie: cookie } }),
      testEnv(),
    );
    expect(authed.status).toBe(200);
  });

  it("shows Telegram commands as optional and disabled until their secret is set", async () => {
    const cookie = await signIn();
    const response = await handleRequest(
      new Request(`${BASE}/settings`, { headers: { Cookie: cookie } }),
      testEnv(),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Telegram commands");
    expect(html).toContain("Webhook disabled");
    expect(html).toContain("No webhook secret");
    expect(html).toContain('action="/settings/telegram-webhook/enable"');
  });

  it("renders CSRF-protected sign-out and revokes every existing session", async () => {
    const cookie = await signIn();
    const settings = await handleRequest(
      new Request(`${BASE}/settings`, { headers: { Cookie: cookie } }),
      testEnv(),
    );
    const html = await settings.text();
    expect(html).toContain('action="/logout"');
    expect(html).toContain('action="/settings/revoke-sessions"');

    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const form = new FormData();
    form.set("csrf_token", csrf);
    const revoked = await post("/settings/revoke-sessions", cookie, form);
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const stale = await handleRequest(
      new Request(`${BASE}/`, { headers: { Cookie: cookie } }),
      testEnv(),
    );
    expect(stale.status).toBe(303);
    expect(stale.headers.get("Location")).toBe("/login");
  });

  it("returns route-specific 405 responses and security headers", async () => {
    const cookie = await signIn();
    const response = await handleRequest(
      new Request(`${BASE}/trackers/new`, { method: "PUT", headers: { Cookie: cookie } }),
      testEnv(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("bounds form bodies before parsing them", async () => {
    const response = await handleRequest(
      new Request(`${BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${"x".repeat(70_000)}`,
      }),
      testEnv(),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("hardens the top-level 500 response when routing throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const brokenDb = {
        prepare() {
          throw new Error("synthetic D1 failure");
        },
      } as unknown as D1Database;
      const response = await workerEntrypoint.fetch(
        new Request(`${BASE}/`),
        testEnv({ DB: brokenDb }),
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    } finally {
      log.mockRestore();
    }
  });
});

// ------------------------------------------------------------------ create
describe("creating trackers", () => {
  it("creates an exact-date tracker", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const response = await post("/trackers", cookie, exactForm(csrf));
    expect(response.status).toBe(303);

    const [tracker] = await new Repo(env.DB).listTrackers();
    expect(tracker?.date_mode).toBe("exact");
    expect(tracker?.outbound_date).toBe(futureDate(60));
    expect(tracker?.threshold_amount_cents).toBe(130000);
    // Inactive-mode fields must be NULL or they would enter the fingerprint.
    expect(tracker?.flex_month).toBeNull();
    expect(tracker?.window_outbound_start).toBeNull();
  });

  it("creates a flexible-preset tracker", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const { month, year } = presetMonth();
    const response = await post("/trackers", cookie, presetForm(csrf));
    expect(response.status).toBe(303);

    const [tracker] = await new Repo(env.DB).listTrackers();
    expect(tracker?.date_mode).toBe("flexible_preset");
    expect(tracker?.flex_month).toBe(month);
    expect(tracker?.flex_year).toBe(year);
    expect(tracker?.flex_duration).toBe("one_week");
    expect(tracker?.outbound_date).toBeNull();
    // A preset resolves provider-side, so it has no local candidate queue.
    const candidates = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates",
    ).first<{ n: number }>();
    expect(candidates?.n).toBe(0);
  });

  it("creates a custom window and persists every generated date pair", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const response = await post("/trackers", cookie, windowForm(csrf));
    expect(response.status).toBe(303);

    const repo = new Repo(env.DB);
    const [tracker] = await repo.listTrackers();
    expect(tracker?.date_mode).toBe("custom_window");
    expect(tracker?.min_nights).toBe(5);
    expect(tracker?.max_nights).toBe(7);
    expect(tracker?.candidates_per_run).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT outbound_date, return_date, nights, status, cycle FROM flexible_date_candidates ORDER BY order_index",
    ).all<{ outbound_date: string; return_date: string; nights: number; status: string; cycle: number }>();
    const candidates = rows.results ?? [];
    expect(candidates).toHaveLength(9); // 3 departures x 3 lengths
    expect(candidates.every((c) => c.nights >= 5 && c.nights <= 7)).toBe(true);
    expect(candidates.every((c) => c.status === "pending" && c.cycle === 1)).toBe(true);
    // Keyed to the tracker's live config version, or the sweep would not find them.
    expect(tracker?.current_config_version_id).not.toBeNull();

    const detail = await handleRequest(
      new Request(`${BASE}/trackers/${tracker!.id}`, { headers: { Cookie: cookie } }),
      testEnv(),
    );
    const html = await detail.text();
    expect(html).toContain("A fresh scan plans <strong>2</strong> provider search(es)");
    expect(html).toContain("up to <strong>6</strong>");
  });

  it("creates a return-date window without requiring a nights range", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const response = await post("/trackers", cookie, returnWindowForm(csrf));
    expect(response.status).toBe(303);

    const repo = new Repo(env.DB);
    const [tracker] = await repo.listTrackers();
    expect(tracker?.window_return_start).toBe(futureDate(68));
    expect(tracker?.window_return_end).toBe(futureDate(70));
    expect(tracker?.min_nights).toBeNull();
    expect(tracker?.max_nights).toBeNull();

    const candidates = await env.DB.prepare(
      "SELECT outbound_date, return_date FROM flexible_date_candidates ORDER BY order_index",
    ).all<{ outbound_date: string; return_date: string }>();
    expect(candidates.results).toHaveLength(9);
    expect(
      candidates.results.every(
        (pair) => pair.return_date >= futureDate(68) && pair.return_date <= futureDate(70),
      ),
    ).toBe(true);
  });

  it("uses a nights range to filter an explicit return window", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = returnWindowForm(csrf);
    form.set("window_return_start", futureDate(65));
    form.set("min_nights", "5");
    form.set("max_nights", "6");

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(303);
    const candidates = await env.DB.prepare(
      "SELECT nights FROM flexible_date_candidates ORDER BY order_index",
    ).all<{ nights: number }>();
    expect(candidates.results).toHaveLength(6);
    expect(candidates.results.every((pair) => pair.nights === 5 || pair.nights === 6)).toBe(true);
  });

  it("rejects incomplete or reversed return windows", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const incomplete = returnWindowForm(csrf);
    incomplete.delete("window_return_end");

    const missing = await post("/trackers", cookie, incomplete);
    expect(missing.status).toBe(422);
    expect(await missing.text()).toMatch(/both the earliest and latest return dates/);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);

    const nextCsrf = await csrfFrom(cookie, "/trackers/new");
    const reversed = returnWindowForm(nextCsrf);
    reversed.set("window_return_start", futureDate(72));
    const invalid = await post("/trackers", cookie, reversed);
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).toMatch(/return window ends before it starts/);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });

  it("rejects an inverted trip-length range and writes nothing", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.set("min_nights", "10");
    form.set("max_nights", "3");

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/shorter than the minimum/);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });

  it("rejects a reversed departure window", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.set("window_outbound_start", futureDate(70));
    form.set("window_outbound_end", futureDate(60));

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/ends before it starts/);
  });

  it("rejects a preset month beyond the provider's horizon", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = presetForm(csrf);
    const far = new Date(`${todayIn(TZ)}T00:00:00Z`);
    far.setUTCMonth(far.getUTCMonth() + 10);
    form.set("flex_month", String(far.getUTCMonth() + 1));
    form.set("flex_year", String(far.getUTCFullYear()));

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/6 months/);
  });

  it("rejects an exact return before the departure", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = exactForm(csrf);
    form.set("return_date", futureDate(50));

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/must not be before the outbound date/);
  });

  it("refuses a window so large it cannot be swept", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.set("window_outbound_start", futureDate(10));
    form.set("window_outbound_end", futureDate(375));
    form.set("min_nights", "1");
    form.set("max_nights", "30");

    const response = await post("/trackers", cookie, form);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/date combinations/);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });

  it("rejects malformed enums, schedules, passenger totals, markets, and alert settings", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const invalidForms: Array<[string, FormData]> = [];

    const impossibleDate = exactForm(csrf);
    impossibleDate.set("outbound_date", "2027-02-31");
    invalidForms.push(["impossible date", impossibleDate]);

    for (const [field, value] of [
      ["date_mode", "surprise"],
      ["cabin", "luxury"],
      ["stops", "teleport"],
      ["threshold_basis", "somebody_else"],
      ["check_interval_minutes", "13"],
    ]) {
      const form = exactForm(csrf);
      form.set(field!, value!);
      invalidForms.push([`${field}=${value}`, form]);
    }

    const tooManyTravelers = exactForm(csrf);
    tooManyTravelers.set("adults", "9");
    tooManyTravelers.set("children", "1");
    invalidForms.push(["too many travelers", tooManyTravelers]);

    const conflictingAirlines = exactForm(csrf);
    conflictingAirlines.set("include_airlines", "UA");
    conflictingAirlines.set("exclude_airlines", "NH");
    invalidForms.push(["include and exclude airlines", conflictingAirlines]);

    const malformedAirline = exactForm(csrf);
    // IATA designators may legitimately contain digits (for example B6), so
    // use punctuation to exercise malformed input rather than a valid shape.
    malformedAirline.set("include_airlines", "U!");
    invalidForms.push(["malformed airline", malformedAirline]);

    const tooManyMarkets = exactForm(csrf);
    for (const market of ["gb", "ca", "au", "de"]) tooManyMarkets.append("markets", market);
    invalidForms.push(["too many markets", tooManyMarkets]);

    const invalidMarket = exactForm(csrf);
    invalidMarket.append("markets", "xx");
    invalidForms.push(["unsupported market", invalidMarket]);

    const noAlerts = exactForm(csrf);
    noAlerts.delete("alert_on_threshold");
    noAlerts.delete("alert_on_new_low");
    invalidForms.push(["no alert modes", noAlerts]);

    const tooManyPerRun = windowForm(csrf);
    tooManyPerRun.set("candidates_per_run", "11");
    invalidForms.push(["too many candidates per run", tooManyPerRun]);

    for (const [label, form] of invalidForms) {
      const response = await post("/trackers", cookie, form);
      expect(response.status, label).toBe(422);
    }
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });
});

// -------------------------------------------------------------------- edit
describe("editing between date modes", () => {
  async function create(form: (csrf: string) => FormData): Promise<number> {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    await post("/trackers", cookie, form(csrf));
    const [tracker] = await new Repo(env.DB).listTrackers();
    return tracker!.id;
  }

  it("converts exact to a custom window and builds the queue", async () => {
    const id = await create(exactForm);
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);

    const response = await post(`/trackers/${id}`, cookie, windowForm(csrf));
    expect(response.status).toBe(303);

    const tracker = await new Repo(env.DB).getTracker(id);
    expect(tracker?.date_mode).toBe("custom_window");
    // The exact dates must be cleared, not merely ignored.
    expect(tracker?.outbound_date).toBeNull();
    expect(tracker?.return_date).toBeNull();

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(9);
  });

  it("converts a custom window back to exact and clears the queue", async () => {
    const id = await create(windowForm);
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);

    const response = await post(`/trackers/${id}`, cookie, exactForm(csrf));
    expect(response.status).toBe(303);

    const tracker = await new Repo(env.DB).getTracker(id);
    expect(tracker?.date_mode).toBe("exact");
    expect(tracker?.window_outbound_start).toBeNull();
    expect(tracker?.min_nights).toBeNull();

    // A stale queue would let a later switch resume a sweep never configured.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("converts a preset to exact and back, preserving each mode's fields", async () => {
    const id = await create(presetForm);
    const cookie = await signIn();

    const toExact = await csrfFrom(cookie, `/trackers/${id}/edit`);
    await post(`/trackers/${id}`, cookie, exactForm(toExact));
    let tracker = await new Repo(env.DB).getTracker(id);
    expect(tracker?.date_mode).toBe("exact");
    expect(tracker?.flex_month).toBeNull();

    const backToPreset = await csrfFrom(cookie, `/trackers/${id}/edit`);
    await post(`/trackers/${id}`, cookie, presetForm(backToPreset));
    tracker = await new Repo(env.DB).getTracker(id);
    expect(tracker?.date_mode).toBe("flexible_preset");
    expect(tracker?.flex_month).toBe(presetMonth().month);
    expect(tracker?.outbound_date).toBeNull();
  });

  it("round-trips a stored window back into the edit form", async () => {
    const id = await create(windowForm);
    const cookie = await signIn();
    const html = await (
      await handleRequest(
        new Request(`${BASE}/trackers/${id}/edit`, { headers: { Cookie: cookie } }),
        testEnv(),
      )
    ).text();

    // The form must come back populated, not reset to defaults.
    expect(html).toContain(`value="${futureDate(60)}"`);
    expect(html).toContain(`value="${futureDate(62)}"`);
    expect(html).toMatch(/name="min_nights"[^>]*value="5"/);
    expect(html).toMatch(/name="max_nights"[^>]*value="7"/);
    expect(html).toMatch(/id="mode-custom_window"[^>]*checked/);
  });

  it("round-trips a stored return window back into the edit form", async () => {
    const id = await create(returnWindowForm);
    const cookie = await signIn();
    const html = await (
      await handleRequest(
        new Request(`${BASE}/trackers/${id}/edit`, { headers: { Cookie: cookie } }),
        testEnv(),
      )
    ).text();

    expect(html).toMatch(
      new RegExp(`name="window_return_start"[^>]*value="${futureDate(68)}"`),
    );
    expect(html).toMatch(
      new RegExp(`name="window_return_end"[^>]*value="${futureDate(70)}"`),
    );
    expect(html).toMatch(/name="min_nights"[^>]*value=""/);
    expect(html).toMatch(/name="max_nights"[^>]*value=""/);
  });

  it("rebuilds the queue when the window changes", async () => {
    const id = await create(windowForm);
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);

    const wider = windowForm(csrf);
    wider.set("window_outbound_end", futureDate(64)); // 5 departures x 3 lengths
    await post(`/trackers/${id}`, cookie, wider);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(15);
  });

  it("preserves a paused tracker while editing it", async () => {
    const id = await create(exactForm);
    const cookie = await signIn();
    const toggleCsrf = await csrfFrom(cookie, `/trackers/${id}`);
    await post(`/trackers/${id}/toggle`, cookie, (() => {
      const form = new FormData();
      form.set("csrf_token", toggleCsrf);
      return form;
    })());
    expect((await new Repo(env.DB).getTracker(id))?.status).toBe("paused");

    const editCsrf = await csrfFrom(cookie, `/trackers/${id}/edit`);
    await post(`/trackers/${id}`, cookie, exactForm(editCsrf));
    expect((await new Repo(env.DB).getTracker(id))?.status).toBe("paused");
  });

  it("keeps one open config version and keys a rebuilt queue to it", async () => {
    const id = await create(windowForm);
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);
    const wider = windowForm(csrf);
    wider.set("window_outbound_end", futureDate(64));
    await post(`/trackers/${id}`, cookie, wider);

    const tracker = await new Repo(env.DB).getTracker(id);
    const versions = await env.DB.prepare(
      "SELECT id, effective_to FROM tracker_config_versions WHERE tracker_id = ? ORDER BY version",
    ).bind(id).all<{ id: number; effective_to: string | null }>();
    expect(versions.results).toHaveLength(2);
    expect(versions.results.filter((row) => row.effective_to === null)).toHaveLength(1);
    expect(versions.results.find((row) => row.effective_to === null)?.id)
      .toBe(tracker?.current_config_version_id);
    const keyed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates WHERE tracker_id = ? AND config_version_id = ?",
    ).bind(id, tracker?.current_config_version_id).first<{ n: number }>();
    expect(keyed?.n).toBe(15);
  });

  it("repairs a partial legacy queue without resetting a healthy queue", async () => {
    const id = await create(windowForm);
    const first = await env.DB.prepare(
      "SELECT id FROM flexible_date_candidates WHERE tracker_id = ? ORDER BY order_index LIMIT 1",
    ).bind(id).first<{ id: number }>();
    await env.DB.prepare("UPDATE flexible_date_candidates SET status = 'checked' WHERE id = ?")
      .bind(first!.id).run();

    const cookie = await signIn();
    let csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);
    await post(`/trackers/${id}`, cookie, windowForm(csrf));
    expect((await env.DB.prepare(
      "SELECT status FROM flexible_date_candidates WHERE id = ?",
    ).bind(first!.id).first<{ status: string }>())?.status).toBe("checked");

    await env.DB.prepare(
      "DELETE FROM flexible_date_candidates WHERE tracker_id = ? AND order_index = 8",
    ).bind(id).run();
    csrf = await csrfFrom(cookie, `/trackers/${id}/edit`);
    await post(`/trackers/${id}`, cookie, windowForm(csrf));
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM flexible_date_candidates WHERE tracker_id = ?",
    ).bind(id).first<{ n: number }>())?.n).toBe(9);
  });

  it("duplicates a custom window with a complete queue keyed to the copy", async () => {
    const sourceId = await create(windowForm);
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, `/trackers/${sourceId}`);
    const form = new FormData();
    form.set("csrf_token", csrf);
    await post(`/trackers/${sourceId}/duplicate`, cookie, form);

    const trackers = await new Repo(env.DB).listTrackers();
    const copy = trackers.find((tracker) => tracker.id !== sourceId)!;
    expect(copy.status).toBe("paused");
    const candidates = await env.DB.prepare(
      "SELECT config_version_id FROM flexible_date_candidates WHERE tracker_id = ?",
    ).bind(copy.id).all<{ config_version_id: number }>();
    expect(candidates.results).toHaveLength(9);
    expect(candidates.results.every((row) => row.config_version_id === copy.current_config_version_id))
      .toBe(true);
  });
});

// ---------------------------------------------------------------- estimate
describe("budget preview", () => {
  it("reports date-pair count, market multiplication and sweep length", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.append("markets", "gb"); // us + gb

    const response = await post("/api/estimate", cookie, form);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body["candidate_count"]).toBe(9);
    expect(body["market_count"]).toBe(2);
    expect(body["calls_per_scan"]).toBe(4); // 2 pairs per run x 2 markets
    expect(body["max_calls_per_scan"]).toBe(12); // room for 3 attempts per search
    expect(body["calls_per_full_cycle"]).toBe(18); // 9 pairs x 2 markets
    expect(body["max_calls_per_full_cycle"]).toBe(54);
    expect(body["scans_per_full_cycle"]).toBe(5);
    expect(body["full_cycle_duration"]).toBeTruthy();
  });

  it("multiplies provider calls by market count", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");

    const one = (await (await post("/api/estimate", cookie, exactForm(csrf))).json()) as Record<string, number>;
    const twoForm = exactForm(csrf);
    twoForm.append("markets", "gb");
    const two = (await (await post("/api/estimate", cookie, twoForm)).json()) as Record<string, number>;

    expect(one["calls_per_scan"]).toBe(1);
    expect(two["calls_per_scan"]).toBe(2);
    expect(one["max_calls_per_scan"]).toBe(3);
    expect(two["max_calls_per_scan"]).toBe(6);
  });

  it("uses one quota snapshot for a self-consistent live estimate", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const snapshot = vi.spyOn(QuotaManager.prototype, "snapshot");
    try {
      const response = await post("/api/estimate", cookie, exactForm(csrf));
      expect(response.status).toBe(200);
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      snapshot.mockRestore();
    }
  });

  it("blocks a scan that lacks capacity for the provider retry reservation", async () => {
    const smallBudget = testEnv({
      MONTHLY_SEARCH_BUDGET: "2",
      SEARCH_BUDGET_RESERVE_PERCENT: "0",
    });
    const cookie = await signIn(smallBudget);
    const csrf = await csrfFrom(cookie, "/trackers/new", smallBudget);
    const form = exactForm(csrf);

    const preview = (await (await post("/api/estimate", cookie, form, smallBudget)).json()) as {
      severity: string;
      calls_per_scan: number;
      max_calls_per_scan: number;
      detail: string;
    };
    expect(preview).toMatchObject({
      severity: "blocked",
      calls_per_scan: 1,
      max_calls_per_scan: 3,
    });
    expect(preview.detail).toContain("capacity for up to 3 calls");

    form.set("sampled_mode_ack", "on");
    const save = await post("/trackers", cookie, form, smallBudget);
    expect(save.status).toBe(422);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);
  });

  it("surfaces a date error without failing the request", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.set("min_nights", "10");
    form.set("max_nights", "2");

    const response = await post("/api/estimate", cookie, form);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { date_errors: string[] };
    expect(body.date_errors.length).toBeGreaterThan(0);
  });

  it("warns and blocks the save when the schedule outruns the allowance", async () => {
    const cookie = await signIn();
    const csrf = await csrfFrom(cookie, "/trackers/new");
    const form = windowForm(csrf);
    form.set("check_interval_minutes", "60");
    form.set("candidates_per_run", "9");

    const preview = (await (await post("/api/estimate", cookie, form)).json()) as {
      severity: string;
    };
    expect(preview.severity).not.toBe("ok");

    // Saving is refused until the operator acknowledges it.
    const refused = await post("/trackers", cookie, form);
    expect(refused.status).toBe(422);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(0);

    form.set("sampled_mode_ack", "on");
    const accepted = await post("/trackers", cookie, form);
    expect(accepted.status).toBe(303);
    expect(await new Repo(env.DB).listTrackers()).toHaveLength(1);
  });
});
