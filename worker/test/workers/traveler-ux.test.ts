/**
 * Traveler-facing behaviour added after the migration: trip completion,
 * past-candidate pruning, the approaching-threshold soft alert, the weekly
 * digest, and the UI surfacing of links, context, cheapest dates and the new
 * form fields.
 *
 * Everything runs against real D1 through the real services. No SerpApi key
 * and no Telegram token is configured, so a stray live call fails loudly
 * instead of spending the owner's quota or messaging a real person.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { loadConfig, type Env } from "../../src/env.js";
import { AlertService } from "../../src/services/alerts.js";
import { maybeSendWeeklyDigest, DIGEST_SETTING_KEY } from "../../src/services/digest.js";
import { QuotaManager } from "../../src/services/quota.js";
import { SearchService } from "../../src/services/search.js";
import { TelegramNotifier } from "../../src/services/telegram.js";
import type { FareProvider, ProviderResult } from "../../src/providers/types.js";
import { EndpointType, RunTrigger, TrackerStatus } from "../../src/domain/enums.js";
import { handleRequest } from "../../src/web/router.js";
import { hashPassword } from "../../src/web/auth.js";
import { addDays, todayIn, toIso } from "../../src/time.js";

const PASSWORD = "test-password-not-real";
const TZ = "UTC";
let passwordHash = "";

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

function searchServiceWith(provider: FareProvider, overrides: Partial<Env> = {}): SearchService {
  const config = configFor(overrides);
  const r = repo();
  const notifier = new TelegramNotifier(config); // unconfigured: records, never sends
  return new SearchService({
    repo: r,
    config,
    provider,
    quota: new QuotaManager(r, config),
    alerts: new AlertService({ repo: r, notifier, timeZone: TZ }),
    chatId: null,
  });
}

function offerResult(priceCents: number): ProviderResult {
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
        outboundDate: addDays(today(), 60),
        returnDate: addDays(today(), 68),
        departureTime: null,
        arrivalTime: null,
        airlines: ["NH"],
        flightNumbers: ["NH 107"],
        stops: 0,
        durationMinutes: 660,
        cabin: "economy",
        segments: [],
        layovers: [],
        bookingLink: "https://www.google.com/travel/flights?booking",
        searchLink: "https://www.google.com/travel/flights?search",
      },
    ],
    responseAt: toIso(new Date()),
    requestCount: 1,
    searchLink: "https://www.google.com/travel/flights?search",
    outboundDate: addDays(today(), 60),
    returnDate: addDays(today(), 68),
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

async function signIn(): Promise<string> {
  const body = new FormData();
  body.set("password", PASSWORD);
  const response = await handleRequest(new Request(`${BASE}/login`, { method: "POST", body }), testEnv());
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

async function getHtml(path: string, cookie: string): Promise<string> {
  const response = await handleRequest(
    new Request(`${BASE}${path}`, { headers: { Cookie: cookie } }),
    testEnv(),
  );
  expect(response.status).toBe(200);
  return response.text();
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
    "query_cache",
    "auth_throttle",
    "app_settings",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.exec("UPDATE provider_usage SET local_searches = 0");
});

// ------------------------------------------------------------ trip lifecycle
describe("trip completion", () => {
  it("parks an exact tracker whose departure has passed, spending nothing", async () => {
    const id = await insertTracker({
      outbound_date: addDays(today(), -3),
      return_date: addDays(today(), 5),
    });
    const provider = stubProvider(); // throws if reached
    const service = searchServiceWith(provider);

    const result = await service.runTracker(await getTracker(id), RunTrigger.SCHEDULED);

    expect(result.skipped).toBe(true);
    expect(provider.calls).toBe(0);
    const tracker = await getTracker(id);
    expect(tracker.status).toBe(TrackerStatus.COMPLETED);
    expect(tracker.next_run_at).toBeNull();

    const run = (await repo().recentRuns(id, 1))[0];
    expect(run?.status).toBe("skipped");
    expect(run?.skip_reason).toMatch(/marked completed/);

    const usage = await repo().usageRow("any-period-not-created");
    expect(usage.local_searches).toBe(0);
  });

  it("parks a flexible preset whose month has passed", async () => {
    const [year, month] = today().split("-").map(Number) as [number, number];
    const past = month === 1 ? { m: 12, y: year - 1 } : { m: month - 1, y: year };
    const id = await insertTracker({
      date_mode: "flexible_preset",
      outbound_date: null,
      return_date: null,
      flex_month: past.m,
      flex_year: past.y,
      flex_duration: "one_week",
    });
    const service = searchServiceWith(stubProvider());
    const result = await service.runTracker(await getTracker(id), RunTrigger.SCHEDULED);

    expect(result.skipped).toBe(true);
    expect((await getTracker(id)).status).toBe(TrackerStatus.COMPLETED);
  });

  it("parks a custom window once every departure has passed", async () => {
    const id = await insertTracker({
      date_mode: "custom_window",
      outbound_date: null,
      return_date: null,
      window_outbound_start: addDays(today(), -10),
      window_outbound_end: addDays(today(), -2),
      min_nights: 5,
      max_nights: 7,
    });
    const service = searchServiceWith(stubProvider());
    const result = await service.runTracker(await getTracker(id), RunTrigger.SCHEDULED);

    expect(result.skipped).toBe(true);
    expect((await getTracker(id)).status).toBe(TrackerStatus.COMPLETED);
  });

  it("completed trackers are never selected as due work", async () => {
    const id = await insertTracker({
      status: TrackerStatus.COMPLETED,
      next_run_at: null,
    });
    const due = await repo().selectDueTrackers(new Date(), 10);
    expect(due.map((t) => t.id)).not.toContain(id);
  });

  it("editing a completed tracker with future dates reactivates it", async () => {
    const id = await insertTracker({ status: TrackerStatus.COMPLETED, next_run_at: null });
    const cookie = await signIn();
    const html = await getHtml(`/trackers/${id}/edit`, cookie);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";

    const form = new FormData();
    form.set("csrf_token", csrf);
    form.set("name", "Trip");
    form.set("origin", "SFO");
    form.set("destination", "NRT");
    form.set("adults", "2");
    form.set("cabin", "economy");
    form.set("stops", "any");
    form.set("currency", "USD");
    form.set("date_mode", "exact");
    form.set("outbound_date", addDays(today(), 90));
    form.set("return_date", addDays(today(), 98));
    form.set("threshold_amount", "1300");
    form.set("check_interval_minutes", "720");
    form.append("markets", "us");

    const response = await handleRequest(
      new Request(`${BASE}/trackers/${id}`, { method: "POST", body: form, headers: { Cookie: cookie } }),
      testEnv(),
    );
    expect(response.status).toBe(303);
    expect((await getTracker(id)).status).toBe(TrackerStatus.ACTIVE);
  });

  it("retires past-dated pending candidates instead of searching them", async () => {
    const r = repo();
    const trackerId = await insertTracker({ date_mode: "custom_window" });
    const versionId = await r.insertConfigVersion(trackerId, 1, "fp", "{}", toIso(new Date()));
    await r.replaceCandidates(trackerId, versionId, [
      { outbound: addDays(today(), -2), ret: addDays(today(), 5), nights: 7 },
      { outbound: addDays(today(), 3), ret: addDays(today(), 10), nights: 7 },
    ]);

    const skipped = await r.skipPastCandidates(versionId, today());
    expect(skipped).toBe(1);

    const claimable = await r.claimCandidates(versionId, 1, 10);
    expect(claimable).toHaveLength(1);
    expect(claimable[0]?.outbound_date).toBe(addDays(today(), 3));

    const coverage = await r.candidateCoverage(versionId, 1);
    expect(coverage).toEqual({ checked: 1, total: 2 });
  });
});

// ------------------------------------------------------- approaching alerts
describe("approaching-threshold soft alert", () => {
  it("records an approaching alert when a baseline lands within 5% above", async () => {
    // Threshold $1,300; offer $1,350 = 3.8% above.
    const id = await insertTracker();
    const service = searchServiceWith(stubProvider(() => offerResult(135000)));
    const result = await service.runTracker(await getTracker(id), RunTrigger.MANUAL);

    expect(result.errors).toEqual([]);
    const alerts = await repo().recentAlerts(5);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alert_type).toBe("approaching");
    // No Telegram configured in tests, so it is recorded, never sent.
    expect(alerts[0]?.delivery_state).toBe("not_configured");
    expect(alerts[0]?.message_text).toContain("Approaching threshold");
    expect(alerts[0]?.message_text).toContain("Within 5% of the threshold");
  });

  it("does not fire outside the 5% band", async () => {
    const id = await insertTracker();
    const service = searchServiceWith(stubProvider(() => offerResult(140000))); // 7.7% above
    await service.runTracker(await getTracker(id), RunTrigger.MANUAL);
    expect(await repo().recentAlerts(5)).toHaveLength(0);
  });

  it("never fires alongside a real alert", async () => {
    // At/below threshold: the threshold alert fires, approaching must not.
    const id = await insertTracker();
    const service = searchServiceWith(stubProvider(() => offerResult(129000)));
    await service.runTracker(await getTracker(id), RunTrigger.MANUAL);

    const alerts = await repo().recentAlerts(5);
    expect(alerts.map((a) => a.alert_type)).toEqual(["threshold"]);
  });

  it("dedupes a repeat of the same approaching fare", async () => {
    const id = await insertTracker();
    const make = () => searchServiceWith(stubProvider(() => offerResult(135000)));
    await make().runTracker(await getTracker(id), RunTrigger.MANUAL);
    await make().runTracker(await getTracker(id), RunTrigger.MANUAL);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alert_events WHERE alert_type = 'approaching'",
    ).first<{ n: number }>();
    // Second identical finding collapses onto the same dedupe key.
    expect(rows?.n).toBe(1);
  });
});

// ---------------------------------------------------------------- digest
describe("weekly digest", () => {
  const fakeNotifier = (ok = true) => {
    const sent: { chatId: string; text: string }[] = [];
    return {
      sent,
      isConfigured: () => true,
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
        return { ok, userMessage: ok ? "" : "failed" };
      },
    };
  };

  it("seeds the cadence silently on first run — deploying never surprises", async () => {
    const notifier = fakeNotifier();
    const outcome = await maybeSendWeeklyDigest(
      repo(),
      configFor({ TELEGRAM_CHAT_ID: "12345" }),
      new QuotaManager(repo(), configFor()),
      notifier,
    );
    expect(outcome).toMatchObject({ sent: false, seeded: true });
    expect(notifier.sent).toHaveLength(0);
    expect(await repo().getSetting<string>(DIGEST_SETTING_KEY)).not.toBeNull();
  });

  it("stays quiet until a week has passed", async () => {
    await repo().setSetting(DIGEST_SETTING_KEY, toIso(new Date(Date.now() - 3 * 24 * 3600_000)));
    const notifier = fakeNotifier();
    const outcome = await maybeSendWeeklyDigest(
      repo(),
      configFor({ TELEGRAM_CHAT_ID: "12345" }),
      new QuotaManager(repo(), configFor()),
      notifier,
    );
    expect(outcome.sent).toBe(false);
    expect(notifier.sent).toHaveLength(0);
  });

  it("sends one summary when due, then advances the cadence", async () => {
    const id = await insertTracker({ low_price_cents: 196200, latest_price_cents: 196600 });
    const runId = await repo().insertSearchRun({
      tracker_id: id,
      batch_id: "b",
      trigger: "scheduled",
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
        price_amount_cents: 196600,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date(Date.now() - 24 * 3600_000)),
        eligible: 1,
        is_best_of_run: 1,
      },
    ]);
    await repo().setSetting(DIGEST_SETTING_KEY, toIso(new Date(Date.now() - 8 * 24 * 3600_000)));

    const notifier = fakeNotifier();
    const config = configFor({ TELEGRAM_CHAT_ID: "12345" });
    const outcome = await maybeSendWeeklyDigest(
      repo(),
      config,
      new QuotaManager(repo(), config),
      notifier,
    );

    expect(outcome.sent).toBe(true);
    expect(notifier.sent).toHaveLength(1);
    const text = notifier.sent[0]!.text;
    expect(text).toContain("weekly summary");
    expect(text).toContain("Trip (SFO→NRT)");
    expect(text).toContain("$1,966");
    expect(text).toMatch(/Searches: \d+ of 250/);

    // Cadence advanced: an immediate second call sends nothing.
    const again = await maybeSendWeeklyDigest(
      repo(),
      config,
      new QuotaManager(repo(), config),
      notifier,
    );
    expect(again.sent).toBe(false);
    expect(notifier.sent).toHaveLength(1);
  });

  it("retries next tick when the send fails, instead of skipping a week", async () => {
    await repo().setSetting(DIGEST_SETTING_KEY, toIso(new Date(Date.now() - 8 * 24 * 3600_000)));
    const before = await repo().getSetting<string>(DIGEST_SETTING_KEY);

    const config = configFor({ TELEGRAM_CHAT_ID: "12345" });
    const outcome = await maybeSendWeeklyDigest(
      repo(),
      config,
      new QuotaManager(repo(), config),
      fakeNotifier(false),
    );
    expect(outcome.sent).toBe(false);
    expect(await repo().getSetting<string>(DIGEST_SETTING_KEY)).toBe(before);
  });
});

// ------------------------------------------------------------- UI surfacing
describe("traveler-facing UI", () => {
  it("renders booking links in the history and on the headline price", async () => {
    const id = await insertTracker({ latest_price_cents: 196600 });
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
        itinerary_fingerprint: "a",
        price_amount_cents: 196600,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date()),
        eligible: 1,
        is_best_of_run: 1,
        booking_link: "https://www.google.com/travel/flights?tfs=abc",
      },
      {
        search_run_id: runId,
        tracker_id: id,
        itinerary_fingerprint: "b",
        price_amount_cents: 210000,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date(Date.now() - 60_000)),
        eligible: 1,
        is_best_of_run: 0,
        // Must never be rendered as a link.
        booking_link: "javascript:alert(1)",
      },
    ]);

    const html = await getHtml(`/trackers/${id}`, await signIn());
    expect(html).toContain("Open on Google Flights");
    expect(html).toContain('href="https://www.google.com/travel/flights?tfs=abc"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:');
  });

  it("shows the price chart and context once there is history", async () => {
    const id = await insertTracker({
      latest_price_cents: 196600,
      low_price_cents: 196200,
    });
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
    await repo().insertObservations(
      [196200, 196600].map((cents, index) => ({
        search_run_id: runId,
        tracker_id: id,
        itinerary_fingerprint: `itin-${index}`,
        price_amount_cents: cents,
        currency: "USD",
        price_scope: "party_total",
        market: "us",
        observed_at: toIso(new Date(Date.now() - (2 - index) * 3600_000)),
        eligible: 1,
        is_best_of_run: 1,
      })),
    );

    const html = await getHtml(`/trackers/${id}`, await signIn());
    expect(html).toContain('svg class="price-chart"');
    expect(html).toMatch(/↑\s*\$4 since the previous check/);
    expect(html).toContain("range");
    // Threshold $1,300 has never been approached: the hint offers a reachable one.
    expect(html).toMatch(/threshold around \$[\d,]+/);
  });

  it("ranks the cheapest dates for a custom window", async () => {
    const r = repo();
    const id = await insertTracker({
      date_mode: "custom_window",
      outbound_date: null,
      return_date: null,
      window_outbound_start: addDays(today(), 30),
      window_outbound_end: addDays(today(), 33),
      min_nights: 7,
      max_nights: 7,
    });
    const versionId = await r.insertConfigVersion(id, 1, "fp", "{}", toIso(new Date()));
    await r.updateTrackerFields(id, { current_config_version_id: versionId });
    await r.replaceCandidates(id, versionId, [
      { outbound: addDays(today(), 30), ret: addDays(today(), 37), nights: 7 },
      { outbound: addDays(today(), 31), ret: addDays(today(), 38), nights: 7 },
      { outbound: addDays(today(), 32), ret: addDays(today(), 39), nights: 7 },
    ]);
    const claimed = await r.claimCandidates(versionId, 1, 2);
    await r.markCandidateChecked(claimed[0]!.id, "checked", null, 189900);
    await r.markCandidateChecked(claimed[1]!.id, "checked", null, 175000);

    const html = await getHtml(`/trackers/${id}`, await signIn());
    expect(html).toContain("Cheapest dates so far");
    expect(html).toContain("2 of 3 date combinations checked");
    expect(html).toContain("$1,750");
    // The cheapest row is badged and listed first.
    const cheapestIndex = html.indexOf("$1,750");
    const otherIndex = html.indexOf("$1,899");
    expect(cheapestIndex).toBeGreaterThan(-1);
    expect(cheapestIndex).toBeLessThan(otherIndex);
    expect(html).toContain("cheapest");
  });

  it("leads the dashboard with trackers and collapses ops behind a summary", async () => {
    await insertTracker();
    const html = await getHtml("/", await signIn());
    const trackersAt = html.indexOf('id="trackers-heading"');
    const opsAt = html.indexOf('id="ops-heading"');
    expect(trackersAt).toBeGreaterThan(-1);
    expect(trackersAt).toBeLessThan(opsAt);
    expect(html).toContain("<details");
    expect(html).toMatch(/searches left/);
  });

  it("badges an overdue tracker", async () => {
    await insertTracker({
      next_run_at: toIso(new Date(Date.now() - 48 * 3600_000)),
    });
    const html = await getHtml("/", await signIn());
    expect(html).toContain(">overdue</span>");
  });

  it("renders every previously unreachable form field", async () => {
    const html = await getHtml("/trackers/new", await signIn());
    for (const name of [
      "threshold_basis",
      "include_airlines",
      "exclude_airlines",
      "infants_in_seat",
      "infants_on_lap",
      "min_drop_absolute",
      "min_drop_percent",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('list="airport-codes"');
    expect(html).toContain('<datalist id="airport-codes">');
  });

  it("round-trips the new fields through create and edit", async () => {
    const cookie = await signIn();
    const newForm = await getHtml("/trackers/new", cookie);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(newForm)?.[1] ?? "";

    const form = new FormData();
    form.set("csrf_token", csrf);
    form.set("name", "Family trip");
    form.set("origin", "SFO");
    form.set("destination", "NRT");
    form.set("adults", "2");
    form.set("children", "1");
    form.set("infants_in_seat", "1");
    form.set("infants_on_lap", "1");
    form.set("cabin", "economy");
    form.set("stops", "any");
    form.set("currency", "USD");
    form.set("date_mode", "exact");
    form.set("outbound_date", addDays(today(), 60));
    form.set("return_date", addDays(today(), 68));
    form.set("threshold_amount", "650");
    form.set("threshold_basis", "per_traveler");
    form.set("include_airlines", "NH, UA");
    form.set("min_drop_absolute", "50");
    form.set("min_drop_percent", "5");
    form.set("check_interval_minutes", "720");
    form.append("markets", "us");

    const response = await handleRequest(
      new Request(`${BASE}/trackers`, { method: "POST", body: form, headers: { Cookie: cookie } }),
      testEnv(),
    );
    expect(response.status).toBe(303);

    const [tracker] = await repo().listTrackers();
    expect(tracker).toMatchObject({
      threshold_basis: "per_traveler",
      include_airlines: "NH, UA",
      infants_in_seat: 1,
      infants_on_lap: 1,
      min_drop_absolute_cents: 5000,
      min_drop_percent_bp: 500,
    });

    // And the edit form comes back populated with them.
    const editHtml = await getHtml(`/trackers/${tracker!.id}/edit`, cookie);
    expect(editHtml).toMatch(/name="include_airlines"[^>]*value="NH, UA"/);
    expect(editHtml).toMatch(/name="min_drop_percent"[^>]*value="5"/);
    expect(editHtml).toMatch(/value="per_traveler"[^>]*selected/);
  });

  it("marks a completed tracker clearly and hides Check now", async () => {
    const id = await insertTracker({ status: TrackerStatus.COMPLETED, next_run_at: null });
    const html = await getHtml(`/trackers/${id}`, await signIn());
    expect(html).toContain("Completed");
    expect(html).toContain("travel dates for this tracker have passed");
    expect(html).not.toContain(`action="/trackers/${id}/check"`);
  });
});
