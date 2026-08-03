/**
 * The hardening pass that followed the traveler-UX wave: mid-sweep resume
 * pacing, the dashboard's recent-alerts card, cache-busted static assets, the
 * one-time notice when a tracker parks itself, itinerary detail in the price
 * history, and cron_runs retention.
 *
 * Everything runs against real D1 through the real services. The provider is a
 * stub and the Telegram client is a two-method fake, so no test can reach
 * SerpApi or message a real person.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { loadConfig, type Env } from "../../src/env.js";
import { AlertService, type AlertNotifier } from "../../src/services/alerts.js";
import { QuotaManager } from "../../src/services/quota.js";
import { SearchService } from "../../src/services/search.js";
import { TelegramNotifier, type TelegramResult } from "../../src/services/telegram.js";
import { ensureConfigVersion } from "../../src/services/tracker.js";
import { runScheduledTick, type CheckRunner } from "../../src/scheduled.js";
import { ProviderError } from "../../src/providers/errors.js";
import type { FareProvider, ProviderResult } from "../../src/providers/types.js";
import { EndpointType, RunTrigger, TrackerStatus } from "../../src/domain/enums.js";
import { handleRequest } from "../../src/web/router.js";
import { hashPassword } from "../../src/web/auth.js";
import { APP_CSS_ETAG, APP_JS_ETAG } from "../../src/web/static-assets.js";
import { addDays, todayIn, toIso } from "../../src/time.js";

const PASSWORD = "test-password-not-real";
const TZ = "UTC";
let passwordHash = "";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    SESSION_SECRET: "h".repeat(48),
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
const today = (): string => todayIn(TZ);

function repo(): Repo {
  return new Repo(env.DB);
}

function configFor(overrides: Partial<Env> = {}) {
  return loadConfig(testEnv(overrides)).config;
}

/** A provider whose search methods must not be reached unless told otherwise. */
function stubProvider(result?: () => ProviderResult): FareProvider & { calls: number } {
  const provider = {
    calls: 0,
    name: "stub",
    priceScope: "party_total" as const,
    exactEndpoint: EndpointType.GOOGLE_FLIGHTS,
    flexibleEndpoint: EndpointType.GOOGLE_TRAVEL_EXPLORE,
    isConfigured: () => true,
    supportsFlexible: () => true,
    buildExactParams: () => ({ engine: "stub" }),
    buildFlexibleParams: () => ({ engine: "stub" }),
    async searchExact() {
      provider.calls += 1;
      if (!result) throw new Error("provider must not be called in this test");
      return result();
    },
    async searchFlexible() {
      provider.calls += 1;
      if (!result) throw new Error("provider must not be called in this test");
      return result();
    },
    parsePayload() {
      throw new Error("not needed");
    },
    async accountStatus() {
      throw new Error("not needed");
    },
  };
  return provider as unknown as FareProvider & { calls: number };
}

/** Records what would have been sent instead of sending it. */
function fakeNotifier(options: { configured?: boolean; ok?: boolean } = {}) {
  const sent: { chatId: string | number; text: string }[] = [];
  const notifier: AlertNotifier & { sent: typeof sent } = {
    sent,
    isConfigured: () => options.configured ?? true,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return {
        ok: options.ok ?? true,
        messageId: 1,
        errorCode: null,
        description: null,
        retryAfter: null,
        category: "ok",
        userMessage: "",
        retryable: false,
        meta: {},
      } satisfies TelegramResult;
    },
  };
  return notifier;
}

function searchServiceWith(
  provider: FareProvider,
  options: { notifier?: AlertNotifier; chatId?: string | null; overrides?: Partial<Env> } = {},
): SearchService {
  const config = configFor(options.overrides ?? {});
  const r = repo();
  // Default: the real client with no token, which records and never sends.
  const notifier = options.notifier ?? new TelegramNotifier(config);
  return new SearchService({
    repo: r,
    config,
    provider,
    quota: new QuotaManager(r, config),
    alerts: new AlertService({ repo: r, notifier, timeZone: TZ }),
    chatId: options.chatId ?? null,
  });
}

function offerResult(priceCents: number, outbound?: string, ret?: string): ProviderResult {
  const out = outbound ?? addDays(today(), 60);
  const back = ret ?? addDays(today(), 68);
  return {
    endpoint: EndpointType.GOOGLE_FLIGHTS,
    market: "us",
    currency: "USD",
    queryFingerprint: "stub-fp",
    offers: [
      {
        priceCents,
        currency: "USD",
        priceScope: "party_total",
        market: "us",
        origin: "SFO",
        destination: "NRT",
        outboundDate: out,
        returnDate: back,
        departureTime: null,
        arrivalTime: null,
        airlines: ["NH"],
        flightNumbers: ["NH 107"],
        stops: 0,
        durationMinutes: 660,
        cabin: "economy",
        segments: [],
        layovers: [],
        bookingLink: null,
        searchLink: null,
      },
    ],
    responseAt: toIso(new Date()),
    requestCount: 1,
    searchLink: null,
    outboundDate: out,
    returnDate: back,
    rawExcerpt: {},
    fromCache: false,
  };
}

async function insertTracker(overrides: Record<string, unknown> = {}): Promise<number> {
  const now = toIso(new Date());
  const id = await repo().insertTracker({
    name: "Trip",
    status: "active",
    origin: "SFO",
    destination: "NRT",
    adults: 2,
    cabin: "economy",
    stops: "any",
    date_mode: "exact",
    outbound_date: addDays(today(), 60),
    return_date: addDays(today(), 68),
    currency: "USD",
    threshold_amount_cents: 130000,
    threshold_basis: "party",
    check_interval_minutes: 720,
    cooldown_minutes: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
  await repo().setTrackerMarkets(id, ["us"]);
  return id;
}

async function getTracker(id: number) {
  const tracker = await repo().getTracker(id);
  expect(tracker).not.toBeNull();
  return tracker!;
}

/**
 * Seed a custom window with pending date pairs on the config version the
 * search service will itself settle on, so the sweep can actually claim them.
 */
async function seedWindow(trackerId: number, pairs: number): Promise<number> {
  const tracker = await getTracker(trackerId);
  const version = await ensureConfigVersion(repo(), tracker);
  await repo().replaceCandidates(
    trackerId,
    version.configVersionId,
    Array.from({ length: pairs }, (_, index) => ({
      outbound: addDays(today(), 30 + index),
      ret: addDays(today(), 37 + index),
      nights: 7,
    })),
  );
  return version.configVersionId;
}

async function signIn(): Promise<string> {
  const body = new FormData();
  body.set("password", PASSWORD);
  const response = await handleRequest(
    new Request(`${BASE}/login`, { method: "POST", body }),
    testEnv(),
  );
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

async function getHtml(path: string, cookie?: string): Promise<string> {
  const response = await handleRequest(
    new Request(`${BASE}${path}`, cookie ? { headers: { Cookie: cookie } } : {}),
    testEnv(),
  );
  expect(response.status).toBe(200);
  return response.text();
}

/** Minutes from now, as a float, for scheduling assertions. */
function minutesFromNow(iso: string | null): number {
  expect(iso).not.toBeNull();
  return (new Date(iso!).getTime() - Date.now()) / 60_000;
}

beforeEach(async () => {
  if (passwordHash === "") passwordHash = await hashPassword(PASSWORD);
  for (const table of [
    "flexible_date_candidates",
    "alert_events",
    "fare_observations",
    "search_runs",
    "tracker_config_versions",
    "tracker_markets",
    "trackers",
    "provider_calls",
    // A cached stub payload would short-circuit the live path of a later test.
    "query_cache",
    "cron_runs",
    "telegram_updates",
    "auth_throttle",
    "app_settings",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.exec("UPDATE provider_usage SET local_searches = 0");
  await env.DB.exec(
    "UPDATE scheduler_state SET lock_owner = NULL, lock_expires_at = NULL, last_sweep_state = NULL",
  );
});

// -------------------------------------------------------- mid-sweep pacing
describe("mid-sweep resume pacing", () => {
  const windowTracker = () =>
    insertTracker({
      date_mode: "custom_window",
      outbound_date: null,
      return_date: null,
      window_outbound_start: addDays(today(), 30),
      window_outbound_end: addDays(today(), 35),
      min_nights: 7,
      max_nights: 7,
      candidates_per_run: 6,
    });

  it("comes back on the next Cron tick when the tick clamped its budget", async () => {
    const id = await windowTracker();
    await seedWindow(id, 6);

    const provider = stubProvider(() => offerResult(180000));
    const result = await searchServiceWith(provider).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
      { maxQueries: 2 },
    );

    expect(provider.calls).toBe(2);
    expect(result.workRemaining).toBe(true);

    // Cron fires every 15 minutes; ~16 makes exactly the next tick pick it up,
    // instead of the 12-hour check interval the tracker is configured with.
    const delay = minutesFromNow((await getTracker(id)).next_run_at);
    expect(delay).toBeGreaterThan(15);
    expect(delay).toBeLessThan(20);
  });

  it("keeps the configured interval when the scan finished its planned work", async () => {
    const id = await windowTracker();
    await seedWindow(id, 2);

    const provider = stubProvider(() => offerResult(180000));
    const result = await searchServiceWith(provider).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
      { maxQueries: 6 },
    );

    expect(provider.calls).toBe(2);
    expect(result.workRemaining).toBe(false);

    const delay = minutesFromNow((await getTracker(id)).next_run_at);
    expect(delay).toBeGreaterThan(715);
    expect(delay).toBeLessThan(721);
  });

  it("still records the runs and observations it did get through", async () => {
    const id = await windowTracker();
    await seedWindow(id, 6);

    await searchServiceWith(stubProvider(() => offerResult(180000))).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
      { maxQueries: 2 },
    );

    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM search_runs WHERE tracker_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    const observations = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM fare_observations WHERE tracker_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();

    expect(runs?.n).toBe(2);
    expect(observations?.n).toBe(2);
    expect((await getTracker(id)).latest_price_cents).toBe(180000);
  });
});

// ------------------------------------------------------- error-park notice
describe("tracker parked in the error state", () => {
  const failing = () =>
    stubProvider(() => {
      throw new ProviderError("upstream refused", "SerpApi returned an error.");
    });

  it("tells the owner once, on the transition into the error state", async () => {
    const id = await insertTracker({ consecutive_failures: 4 });
    const notifier = fakeNotifier();

    await searchServiceWith(failing(), { notifier, chatId: "12345" }).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
    );

    expect((await getTracker(id)).status).toBe(TrackerStatus.ERROR);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.text).toContain("Trip");
    expect(notifier.sent[0]?.text).toContain("SFO→NRT");
    expect(notifier.sent[0]?.text).toContain("5 consecutive failed checks");
    // The failure that parked it, not whatever the row said before the check.
    expect(notifier.sent[0]?.text).toContain("Last error: SerpApi returned an error.");

    // Already parked: failing again must stay silent, or a permanently broken
    // key would message the owner on every tick.
    await searchServiceWith(failing(), { notifier, chatId: "12345" }).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
    );
    expect(notifier.sent).toHaveLength(1);

    // Operational, not a fare finding: no alert_events row is created.
    expect(await repo().recentAlerts(5)).toHaveLength(0);
  });

  it("says nothing before the failure limit is reached", async () => {
    const id = await insertTracker({ consecutive_failures: 0 });
    const notifier = fakeNotifier();

    await searchServiceWith(failing(), { notifier, chatId: "12345" }).runTracker(
      await getTracker(id),
      RunTrigger.SCHEDULED,
    );

    expect((await getTracker(id)).status).toBe(TrackerStatus.ACTIVE);
    expect(notifier.sent).toHaveLength(0);
  });

  it("parks the tracker anyway when Telegram is not configured", async () => {
    const id = await insertTracker({ consecutive_failures: 4 });
    const notifier = fakeNotifier({ configured: false });

    const result = await searchServiceWith(failing(), {
      notifier,
      chatId: "12345",
    }).runTracker(await getTracker(id), RunTrigger.SCHEDULED);

    expect(notifier.sent).toHaveLength(0);
    expect((await getTracker(id)).status).toBe(TrackerStatus.ERROR);
    expect(result.errors).toHaveLength(1);
  });
});

// ------------------------------------------------------------- dashboard
describe("recent alerts on the dashboard", () => {
  it("renders what was sent, links the tracker, and escapes the message", async () => {
    const id = await insertTracker();
    await repo().insertAlertEvent({
      tracker_id: id,
      alert_type: "new_low",
      dedupe_key: "dashboard-key",
      message_text: "<b>New observed low</b> $1,899\nSecond line stays hidden",
      delivery_state: "sent",
      created_at: toIso(new Date()),
      delivered_at: toIso(new Date()),
    });

    const html = await getHtml("/", await signIn());

    expect(html).toContain("Recent alerts");
    expect(html).toContain(`<a href="/trackers/${id}">Trip</a>`);
    expect(html).toContain("New observed low");
    // Telegram markup is shown, never rendered.
    expect(html).toContain("&lt;b&gt;New observed low&lt;/b&gt;");
    expect(html).not.toContain("<b>New observed low");
    // Only the first line of the body reaches the table.
    expect(html).not.toContain("Second line stays hidden");
  });

  it("omits the card entirely when nothing has been alerted", async () => {
    await insertTracker();
    const html = await getHtml("/", await signIn());
    expect(html).not.toContain("Recent alerts");
  });
});

// ---------------------------------------------------------- static assets
describe("static asset versioning", () => {
  it("links both assets by content hash so a deploy is not served stale", async () => {
    const html = await getHtml("/login");
    expect(html).toContain(`/static/app.css?v=${APP_CSS_ETAG}`);
    expect(html).toContain(`/static/app.js?v=${APP_JS_ETAG}`);
  });

  it("serves the asset itself regardless of the query string", async () => {
    const response = await handleRequest(
      new Request(`${BASE}/static/app.css?v=${APP_CSS_ETAG}`),
      testEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });
});

// ------------------------------------------------------- itinerary detail
describe("itinerary detail in the price history", () => {
  it("renders segments and layovers, escaping provider-supplied text", async () => {
    const id = await insertTracker({ latest_price_cents: 189900 });
    const runId = await repo().insertSearchRun({
      tracker_id: id,
      batch_id: "b",
      trigger: "manual",
      endpoint: "google_flights",
      market: "us",
      currency: "USD",
      query_fingerprint: "fp",
      started_at: toIso(new Date()),
    });
    await repo().insertObservations([
      {
        search_run_id: runId,
        tracker_id: id,
        itinerary_fingerprint: "itin",
        price_amount_cents: 189900,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date()),
        eligible: 1,
        is_best_of_run: 1,
        departure_time: "2026-10-01 11:20",
        arrival_time: "2026-10-02 14:45",
        duration_minutes: 685,
        segments: JSON.stringify([
          {
            departure_id: "SFO",
            departure_name: "San Francisco",
            departure_time: "2026-10-01 11:20",
            arrival_id: "TPE",
            arrival_name: "Taoyuan",
            arrival_time: "2026-10-02 16:05",
            // A hostile airline name must be shown, never executed.
            airline: "<script>alert(1)</script>Evil Air",
            flight_number: "BR 27",
            duration_minutes: 805,
          },
          {
            departure_id: "TPE",
            departure_name: null,
            arrival_id: "NRT",
            arrival_name: null,
            airline: null,
            flight_number: null,
            duration_minutes: null,
          },
        ]),
        layovers: JSON.stringify([
          { id: "TPE", name: "Taiwan Taoyuan", duration_minutes: 130, overnight: true },
        ]),
      },
    ]);

    const html = await getHtml(`/trackers/${id}`, await signIn());

    expect(html).toContain("<summary>Details</summary>");
    // Total duration reads as a flight time, not as "11.4 hours".
    expect(html).toContain("11h 25m");
    expect(html).toContain("Layover: Taiwan Taoyuan (2h 10m)");
    expect(html).toContain("overnight");
    expect(html).toContain("BR 27");
    // The partial second segment still renders from the fields it does have.
    expect(html).toContain("TPE → NRT");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows no disclosure for a row that stored no itinerary", async () => {
    const id = await insertTracker({ latest_price_cents: 189900 });
    const runId = await repo().insertSearchRun({
      tracker_id: id,
      batch_id: "b",
      trigger: "manual",
      endpoint: "google_flights",
      market: "us",
      currency: "USD",
      query_fingerprint: "fp",
      started_at: toIso(new Date()),
    });
    await repo().insertObservations([
      {
        search_run_id: runId,
        tracker_id: id,
        itinerary_fingerprint: "bare",
        price_amount_cents: 189900,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date()),
        eligible: 1,
        is_best_of_run: 1,
        // Legacy rows can hold unparseable JSON; it must read as "nothing".
        segments: "not json",
        layovers: null,
      },
    ]);

    const html = await getHtml(`/trackers/${id}`, await signIn());
    expect(html).toContain("Price history");
    expect(html).not.toContain("<summary>Details</summary>");
  });
});

// ------------------------------------------------------------ housekeeping
describe("operational history retention", () => {
  const fakeRunner = (): CheckRunner => ({
    async runTracker() {
      throw new Error("no tracker is due in this test");
    },
    async retryPendingAlerts() {
      return { delivered: 0, failed: 0 };
    },
  });

  it("prunes runs older than the retention window and keeps recent ones", async () => {
    const old = toIso(new Date(Date.now() - 45 * 24 * 3600_000));
    const fresh = toIso(new Date(Date.now() - 2 * 24 * 3600_000));
    for (const startedAt of [old, fresh]) {
      await env.DB.prepare("INSERT INTO cron_runs (started_at, outcome) VALUES (?, 'completed')")
        .bind(startedAt)
        .run();
    }
    for (const [updateId, updatedAt] of [[1, old], [2, fresh]] as const) {
      await env.DB.prepare(
        `INSERT INTO telegram_updates
           (update_id, state, received_at, updated_at)
         VALUES (?, 'delivered', ?, ?)`,
      )
        .bind(updateId, updatedAt, updatedAt)
        .run();
    }

    await runScheduledTick(repo(), configFor({ SCHEDULER_ENABLED: "true" }), fakeRunner());

    const remaining = await env.DB.prepare("SELECT started_at FROM cron_runs ORDER BY started_at")
      .all<{ started_at: string }>();
    const kept = (remaining.results ?? []).map((r) => r.started_at);
    expect(kept).toContain(fresh);
    expect(kept).not.toContain(old);
    // The tick's own row survives its prune.
    expect(kept).toHaveLength(2);

    const updates = await env.DB.prepare(
      "SELECT update_id FROM telegram_updates ORDER BY update_id",
    ).all<{ update_id: number }>();
    expect((updates.results ?? []).map((row) => row.update_id)).toEqual([2]);
  });
});
