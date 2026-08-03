/** Telegram command webhook against real D1, with every network edge faked. */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { loadConfig, type Env } from "../../src/env.js";
import { RunTrigger, TrackerStatus, type RunTriggerValue } from "../../src/domain/enums.js";
import { TelegramBot, parseCommand, type BotNotifier } from "../../src/services/bot.js";
import { QuotaManager } from "../../src/services/quota.js";
import type { CheckResult } from "../../src/services/search.js";
import type { TelegramResult } from "../../src/services/telegram.js";
import { toIso } from "../../src/time.js";
import { hashPassword } from "../../src/web/auth.js";
import { handleRequest } from "../../src/web/router.js";
import { handleTelegramWebhook } from "../../src/web/telegram-webhook.js";

const OWNER_CHAT = 4242;
const STRANGER_CHAT = 9999;
const SECRET = `flightnotify_${"s".repeat(40)}`;
const BASE = "https://flightnotify.test";
let passwordHash = "";

function telegramResult(
  overrides: Partial<TelegramResult> = {},
): TelegramResult {
  return {
    ok: true,
    messageId: 1,
    errorCode: null,
    description: null,
    retryAfter: null,
    category: "ok",
    userMessage: "Message delivered.",
    retryable: false,
    meta: {},
    ...overrides,
  };
}

class FakeNotifier implements BotNotifier {
  readonly sent: { chatId: string | number; text: string }[] = [];

  constructor(private readonly results: TelegramResult[] = []) {}

  async sendMessage(chatId: string | number, text: string): Promise<TelegramResult> {
    this.sent.push({ chatId, text });
    return this.results.shift() ?? telegramResult();
  }
}

class FakeSearch {
  readonly calls: { trackerId: number; trigger: RunTriggerValue }[] = [];

  async runTracker(
    tracker: Awaited<ReturnType<Repo["getTracker"]>> & {},
    trigger: RunTriggerValue,
  ): Promise<CheckResult> {
    this.calls.push({ trackerId: tracker.id, trigger });
    return {
      batchId: "bot-test",
      trackerId: tracker.id,
      runIds: [1],
      providerCalls: 1,
      cacheHits: 0,
      offersFound: 3,
      bestPriceCents: 99900,
      bestMarket: "us",
      statusMessages: ["Three itineraries considered."],
      errors: [],
      alerts: [],
      skipped: false,
      providerFailures: 0,
      telegramFailures: 0,
      alertsSent: 0,
      workRemaining: false,
    };
  }
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    SESSION_SECRET: "w".repeat(48),
    AUTH_PASSWORD_HASH: passwordHash,
    APP_TIMEZONE: "UTC",
    MONTHLY_SEARCH_BUDGET: "250",
    SEARCH_BUDGET_RESERVE_PERCENT: "4",
    HOURLY_SEARCH_LIMIT: "50",
    SCHEDULER_ENABLED: "true",
    SERPAPI_API_KEY: "serpapi-test-key-not-real",
    TELEGRAM_BOT_TOKEN: "123456:test-token-not-real",
    TELEGRAM_CHAT_ID: String(OWNER_CHAT),
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TELEGRAM_BASE_URL: "https://telegram.invalid",
    OFFLINE_MODE: "true",
    ...overrides,
  } as Env;
}

function makeBot(options: {
  notifier?: FakeNotifier;
  search?: FakeSearch;
  env?: Env;
} = {}) {
  const workerEnv = options.env ?? testEnv();
  const config = loadConfig(workerEnv).config;
  const repo = new Repo(env.DB);
  const notifier = options.notifier ?? new FakeNotifier();
  const search = options.search ?? new FakeSearch();
  return {
    bot: new TelegramBot({
      repo,
      config,
      notifier,
      search,
      quota: new QuotaManager(repo, config),
      version: "test-version",
    }),
    config,
    repo,
    notifier,
    search,
  };
}

function update(
  updateId: number,
  text: string,
  chatId = OWNER_CHAT,
  chatType = "private",
): object {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatType },
      text,
    },
  };
}

async function post(bot: TelegramBot, body: unknown, secret = SECRET): Promise<Response> {
  return handleTelegramWebhook(
    new Request(`${BASE}/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": secret,
      },
      body: JSON.stringify(body),
    }),
    { secret: SECRET, bot },
  );
}

async function insertTracker(overrides: Record<string, unknown> = {}): Promise<number> {
  const now = toIso(new Date());
  return new Repo(env.DB).insertTracker({
    name: "Tokyo <autumn>",
    status: TrackerStatus.ACTIVE,
    origin: "SFO",
    destination: "NRT",
    adults: 2,
    cabin: "economy",
    stops: "any",
    date_mode: "exact",
    outbound_date: "2026-09-30",
    return_date: "2026-10-08",
    currency: "USD",
    threshold_amount_cents: 130000,
    threshold_basis: "party",
    check_interval_minutes: 720,
    next_run_at: toIso(new Date(Date.now() + 720 * 60_000)),
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

beforeAll(async () => {
  passwordHash = await hashPassword("webhook-test-password");
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM telegram_updates");
  await env.DB.exec("DELETE FROM cron_runs");
  await env.DB.exec("DELETE FROM alert_events");
  await env.DB.exec("DELETE FROM fare_observations");
  await env.DB.exec("DELETE FROM search_runs");
  await env.DB.exec("DELETE FROM tracker_markets");
  await env.DB.exec("DELETE FROM trackers");
  await env.DB.exec("DELETE FROM provider_calls");
  await env.DB.exec(
    "UPDATE provider_usage SET local_searches = 0, provider_this_month_usage = NULL, provider_searches_left = NULL",
  );
});

describe("command parsing", () => {
  it("normalises mentions, arguments and non-commands", () => {
    expect(parseCommand(" /CHECK@FlightNotifyBot   3 ")).toEqual({
      name: "/check",
      argument: "3",
    });
    expect(parseCommand("hello")).toEqual({ name: "", argument: null });
  });
});

describe("webhook boundary", () => {
  it("is public but requires Telegram's secret header", async () => {
    const response = await handleRequest(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "wrong-secret-value-that-is-long-enough",
        },
        body: JSON.stringify(update(1, "/help")),
      }),
      testEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await new Repo(env.DB).telegramUpdate(1)).toBeNull();
  });

  it("rejects the wrong method, non-JSON media types and an oversized body", async () => {
    const { bot } = makeBot();
    const get = await handleTelegramWebhook(new Request(`${BASE}/telegram/webhook`), {
      secret: SECRET,
      bot,
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");

    const text = await handleTelegramWebhook(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: "not json",
      }),
      { secret: SECRET, bot },
    );
    expect(text.status).toBe(415);

    const jsonLookalike = await handleTelegramWebhook(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json-patch",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(update(3, "/help")),
      }),
      { secret: SECRET, bot },
    );
    expect(jsonLookalike.status).toBe(415);

    const huge = await handleTelegramWebhook(
      new Request(`${BASE}/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify({ padding: "x".repeat(70_000) }),
      }),
      { secret: SECRET, bot },
    );
    expect(huge.status).toBe(413);
  });

  it("does not execute commands when the bot or owner chat is no longer configured", async () => {
    const { bot, repo } = makeBot({
      env: testEnv({ TELEGRAM_BOT_TOKEN: undefined }),
    });
    const response = await post(bot, update(2, "/help"));
    expect(response.status).toBe(503);
    expect(await repo.telegramUpdate(2)).toBeNull();
  });
});

describe("authorisation and idempotency", () => {
  it("silently ignores another chat and group messages", async () => {
    const { bot, notifier, repo } = makeBot();
    expect((await post(bot, update(10, "/pause 1", STRANGER_CHAT))).status).toBe(200);
    expect((await post(bot, update(11, "/help", OWNER_CHAT, "group"))).status).toBe(200);
    expect(notifier.sent).toHaveLength(0);
    expect((await repo.telegramUpdate(10))?.state).toBe("ignored");
    expect((await repo.telegramUpdate(11))?.state).toBe("ignored");
  });

  it("delivers a command once and drops an identical retry", async () => {
    const { bot, notifier, repo } = makeBot();
    expect((await post(bot, update(20, "/help"))).status).toBe(200);
    expect((await post(bot, update(20, "/help"))).status).toBe(200);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.text).toContain("FlightNotify commands");
    const row = await repo.telegramUpdate(20);
    expect(row?.state).toBe("delivered");
    expect(row?.delivery_attempts).toBe(1);
  });

  it("retries only a prepared reply after a transient send failure", async () => {
    const notifier = new FakeNotifier([
      telegramResult({
        ok: false,
        messageId: null,
        category: "server_error",
        userMessage: "Telegram returned a server error.",
        retryable: true,
      }),
      telegramResult(),
    ]);
    const { bot, repo } = makeBot({ notifier });
    const id = await insertTracker({ status: TrackerStatus.PAUSED, next_run_at: null });

    expect((await post(bot, update(30, `/resume ${id}`))).status).toBe(503);
    expect((await repo.getTracker(id))?.status).toBe(TrackerStatus.ACTIVE);
    await repo.updateTrackerFields(id, { status: TrackerStatus.PAUSED, next_run_at: null });

    expect((await post(bot, update(30, `/resume ${id}`))).status).toBe(200);
    // If the command had run twice this would be active again. Only the saved
    // reply was retried.
    expect((await repo.getTracker(id))?.status).toBe(TrackerStatus.PAUSED);
    expect(notifier.sent).toHaveLength(2);
    expect((await repo.telegramUpdate(30))?.delivery_attempts).toBe(2);
  });

  it("never re-executes a command whose first invocation died ambiguously", async () => {
    const id = await insertTracker();
    const search = new FakeSearch();
    const { bot, notifier, repo } = makeBot({ search });
    await repo.claimTelegramUpdate(31, new Date(Date.now() - 6 * 60_000));

    expect((await post(bot, update(31, `/check ${id}`))).status).toBe(200);
    expect(search.calls).toHaveLength(0);
    expect(notifier.sent[0]!.text).toContain("could not prove whether the earlier command");
    expect((await repo.telegramUpdate(31))?.state).toBe("delivered");
  });

  it("does not let retention housekeeping strand a newly claimed command", async () => {
    const { bot, notifier, repo } = makeBot();
    vi.spyOn(repo, "pruneTelegramUpdates").mockRejectedValueOnce(
      new Error("temporary cleanup failure"),
    );

    expect((await post(bot, update(32, "/help"))).status).toBe(200);
    expect(notifier.sent).toHaveLength(1);
    expect((await repo.telegramUpdate(32))?.state).toBe("delivered");
  });
});

describe("commands", () => {
  it("reports status, quota and tracker counts", async () => {
    await insertTracker();
    const { bot, notifier } = makeBot();
    expect((await post(bot, update(40, "/status"))).status).toBe(200);
    const text = notifier.sent[0]!.text;
    expect(text).toContain("FlightNotify test-version");
    expect(text).toContain("Trackers: 1 (1 active)");
    expect(text).toContain("Quota: 0/250 used");
    expect(text).toContain("Scheduler: enabled");
  });

  it("lists and details trackers while escaping their names", async () => {
    const id = await insertTracker({ latest_price_cents: 125000, low_price_cents: 120000 });
    const { bot, notifier } = makeBot();
    await post(bot, update(41, "/trackers"));
    await post(bot, update(42, `/tracker ${id}`));
    expect(notifier.sent[0]!.text).toContain("Tokyo &lt;autumn&gt;");
    expect(notifier.sent[0]!.text).not.toContain("Tokyo <autumn>");
    expect(notifier.sent[1]!.text).toContain("Observed low: $1,200");
    expect(notifier.sent[1]!.text).toContain("Threshold: $1,300");
  });

  it("explains missing arguments, missing trackers and unknown commands", async () => {
    const { bot, notifier } = makeBot();
    await post(bot, update(43, "/tracker"));
    await post(bot, update(44, "/pause 999"));
    await post(bot, update(45, "/wat"));
    await post(bot, update(451, `/${"&".repeat(4_000)}`));
    expect(notifier.sent[0]!.text).toContain("Send a tracker id");
    expect(notifier.sent[1]!.text).toContain("No tracker with id 999");
    expect(notifier.sent[2]!.text).toContain("Unrecognised command /wat");
    expect(notifier.sent[3]!.text.length).toBeLessThan(4_096);
  });

  it("runs /check through the manual search path and releases its lock", async () => {
    const id = await insertTracker();
    const search = new FakeSearch();
    const { bot, notifier, repo } = makeBot({ search });
    await post(bot, update(46, `/check ${id}`));
    expect(search.calls).toEqual([{ trackerId: id, trigger: RunTrigger.MANUAL }]);
    expect(notifier.sent[0]!.text).toContain("1 live search(es)");
    expect(notifier.sent[0]!.text).toContain("Best eligible fare: $999");
    expect((await repo.getTracker(id))?.lock_owner).toBeNull();
  });

  it("does not check without credentials or through an existing lock", async () => {
    const id = await insertTracker();
    const noKeySearch = new FakeSearch();
    const noKey = makeBot({
      search: noKeySearch,
      env: testEnv({ SERPAPI_API_KEY: undefined }),
    });
    await post(noKey.bot, update(47, `/check ${id}`));
    expect(noKeySearch.calls).toHaveLength(0);
    expect(noKey.notifier.sent[0]!.text).toContain("SERPAPI_API_KEY is not set");

    const lockedSearch = new FakeSearch();
    const locked = makeBot({ search: lockedSearch });
    await locked.repo.acquireTrackerLock(id, "scheduled:test", 300);
    await post(locked.bot, update(48, `/check ${id}`));
    expect(lockedSearch.calls).toHaveLength(0);
    expect(locked.notifier.sent[0]!.text).toContain("already running");
  });

  it("pauses and resumes a tracker, clearing parked-error state", async () => {
    const id = await insertTracker({
      consecutive_failures: 7,
      last_error_category: "invalid_credentials",
      last_error_message: "old error",
    });
    const { bot, repo } = makeBot();
    await post(bot, update(49, `/pause ${id}`));
    expect((await repo.getTracker(id))?.status).toBe(TrackerStatus.PAUSED);
    await post(bot, update(50, `/resume ${id}`));
    const resumed = await repo.getTracker(id);
    expect(resumed?.status).toBe(TrackerStatus.ACTIVE);
    expect(resumed?.consecutive_failures).toBe(0);
    expect(resumed?.last_error_category).toBeNull();
    expect(resumed?.next_run_at).not.toBeNull();
  });
});
