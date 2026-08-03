/**
 * Worker bindings and configuration.
 *
 * Replaces `flightnotify/config.py` (pydantic-settings + `.env`). There is no
 * filesystem here: non-secret operational settings come from wrangler `vars`,
 * and every credential is a Cloudflare secret.
 *
 * The module is deliberately fail-closed. `loadConfig` never throws and never
 * substitutes a default for a missing credential -- it returns the problems,
 * and the request layer turns those into a 503 setup page. A Worker that
 * silently booted with an absent SESSION_SECRET would be an unauthenticated
 * public deployment of someone's private data.
 */

import { PriceScopeLabel, type PriceScopeValue } from "./domain/enums.js";
import { MAX_PBKDF2_ITERATIONS, parsePasswordHash } from "./web/auth.js";

export interface Env {
  // --- bindings ----------------------------------------------------------
  DB: D1Database;
  ASSETS?: Fetcher;

  // --- secrets (wrangler secret put) -------------------------------------
  SERPAPI_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  AUTH_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;

  // --- vars --------------------------------------------------------------
  APP_TIMEZONE?: string;
  DEFAULT_CURRENCY?: string;
  DEFAULT_MARKET?: string;
  SERPAPI_PRICE_SCOPE?: string;
  MONTHLY_SEARCH_BUDGET?: string;
  SEARCH_BUDGET_RESERVE_PERCENT?: string;
  HOURLY_SEARCH_LIMIT?: string;
  QUERY_CACHE_TTL_SECONDS?: string;
  SCHEDULER_ENABLED?: string;
  MAX_TRACKERS_PER_TICK?: string;
  MAX_QUERIES_PER_TICK?: string;
  SCHEDULER_LEASE_TTL_SECONDS?: string;

  // --- test seams --------------------------------------------------------
  /** Overridden only by tests and local development against a stub. */
  SERPAPI_BASE_URL?: string;
  TELEGRAM_BASE_URL?: string;
  /** Set by the test suite so nothing can reach the network by accident. */
  OFFLINE_MODE?: string;
}

export interface Config {
  appTimezone: string;
  defaultCurrency: string;
  defaultMarket: string;

  serpapiApiKey: string;
  serpapiBaseUrl: string;
  priceScope: PriceScopeValue;
  monthlySearchBudget: number;
  /** Absolute reserve, derived from the percentage. */
  reserveSearches: number;
  reservePercent: number;
  hourlySearchLimit: number;
  queryCacheTtlSeconds: number;

  telegramBotToken: string;
  telegramChatId: string;
  telegramBaseUrl: string;

  authPasswordHash: string;
  sessionSecret: string;

  schedulerEnabled: boolean;
  maxTrackersPerTick: number;
  maxQueriesPerTick: number;
  schedulerLeaseTtlSeconds: number;

  offlineMode: boolean;
}

export interface ConfigProblem {
  key: string;
  detail: string;
  /** Blocking problems prevent the app from serving anything but the setup page. */
  blocking: boolean;
}

export interface ConfigResult {
  config: Config;
  problems: ConfigProblem[];
  /** True when the app can serve its normal authenticated UI. */
  usable: boolean;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env): ConfigResult {
  const problems: ConfigProblem[] = [];

  const monthlySearchBudget = Math.max(0, Math.trunc(num(env.MONTHLY_SEARCH_BUDGET, 250)));
  const reservePercent = Math.min(100, Math.max(0, num(env.SEARCH_BUDGET_RESERVE_PERCENT, 4)));
  // The Python app configured an absolute reserve (10 of 250). The platform
  // contract asks for a percentage, so it is expressed as one and rounded up:
  // rounding down could leave zero reserve on a small budget, which is the
  // direction that breaks "a manual check always stays possible".
  const reserveSearches = Math.ceil((monthlySearchBudget * reservePercent) / 100);

  let appTimezone = env.APP_TIMEZONE?.trim() || "America/Los_Angeles";
  if (!isValidTimeZone(appTimezone)) {
    problems.push({
      key: "APP_TIMEZONE",
      detail: `Unknown time zone "${appTimezone}"; falling back to UTC for display.`,
      blocking: false,
    });
    appTimezone = "UTC";
  }

  const scopeRaw = (env.SERPAPI_PRICE_SCOPE?.trim() || PriceScopeLabel.PARTY_TOTAL) as string;
  let priceScope: PriceScopeValue;
  if (
    scopeRaw === PriceScopeLabel.PARTY_TOTAL ||
    scopeRaw === PriceScopeLabel.PER_TRAVELER ||
    scopeRaw === PriceScopeLabel.UNKNOWN
  ) {
    priceScope = scopeRaw;
  } else {
    // Never guess a basis: an unrecognised value degrades to "unknown", which
    // disables derivation rather than inventing a party/per-traveler split.
    priceScope = PriceScopeLabel.UNKNOWN;
    problems.push({
      key: "SERPAPI_PRICE_SCOPE",
      detail: `Unrecognised value "${scopeRaw}"; treating prices as unknown scope so no basis is derived.`,
      blocking: false,
    });
  }

  // --- bindings and credentials -----------------------------------------
  if (!env.DB || typeof env.DB.prepare !== "function") {
    problems.push({
      key: "DB",
      detail:
        "The D1 binding `DB` is missing. Add it to wrangler.jsonc and run " +
        "`npx wrangler d1 migrations apply flightnotify --remote`.",
      blocking: true,
    });
  }

  const sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (sessionSecret.length < 32) {
    problems.push({
      key: "SESSION_SECRET",
      detail:
        sessionSecret === ""
          ? "Not set. Run `npx wrangler secret put SESSION_SECRET` with at least 32 random characters."
          : "Too short: a session signing key must be at least 32 characters.",
      blocking: true,
    });
  }

  const authPasswordHash = env.AUTH_PASSWORD_HASH?.trim() ?? "";
  if (authPasswordHash === "") {
    problems.push({
      key: "AUTH_PASSWORD_HASH",
      detail:
        "Not set, so no one could sign in. Generate one with `npm run hash-password` " +
        "and store it via `npx wrangler secret put AUTH_PASSWORD_HASH`.",
      blocking: true,
    });
  } else if (parsePasswordHash(authPasswordHash) === null) {
    // Checked here rather than at login: an unusable hash is a configuration
    // fault, and surfacing it as "incorrect password" (or a 500) would send
    // the operator hunting for the wrong problem.
    problems.push({
      key: "AUTH_PASSWORD_HASH",
      detail:
        "Not a usable hash. Expected pbkdf2$sha256$<iterations>$<salt>$<hash> with " +
        `between 1000 and ${MAX_PBKDF2_ITERATIONS} iterations (the Workers runtime ` +
        "rejects PBKDF2 above that). Regenerate it with `npm run hash-password`.",
      blocking: true,
    });
  }

  const serpapiApiKey = env.SERPAPI_API_KEY?.trim() ?? "";
  if (serpapiApiKey === "") {
    // Not blocking: the app must still show stored history and report a
    // truthful "setup required" state rather than failing to load.
    problems.push({
      key: "SERPAPI_API_KEY",
      detail: "Not set. Stored history is still visible, but no new searches can run.",
      blocking: false,
    });
  }

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (telegramBotToken === "") {
    problems.push({
      key: "TELEGRAM_BOT_TOKEN",
      detail: "Not set. Alerts will be recorded in the database but not delivered.",
      blocking: false,
    });
  }

  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (telegramBotToken !== "" && telegramChatId === "") {
    problems.push({
      key: "TELEGRAM_CHAT_ID",
      detail:
        "Not set. Use Settings -> Discover chat after sending /start to your bot, " +
        "then store it with `npx wrangler secret put TELEGRAM_CHAT_ID`.",
      blocking: false,
    });
  }

  const config: Config = {
    appTimezone,
    defaultCurrency: (env.DEFAULT_CURRENCY?.trim() || "USD").toUpperCase(),
    defaultMarket: (env.DEFAULT_MARKET?.trim() || "us").toLowerCase(),

    serpapiApiKey,
    serpapiBaseUrl: env.SERPAPI_BASE_URL?.trim() || "https://serpapi.com",
    priceScope,
    monthlySearchBudget,
    reserveSearches,
    reservePercent,
    hourlySearchLimit: Math.max(0, Math.trunc(num(env.HOURLY_SEARCH_LIMIT, 50))),
    queryCacheTtlSeconds: Math.max(0, Math.trunc(num(env.QUERY_CACHE_TTL_SECONDS, 900))),

    telegramBotToken,
    telegramChatId,
    telegramBaseUrl: env.TELEGRAM_BASE_URL?.trim() || "https://api.telegram.org",

    authPasswordHash,
    sessionSecret,

    schedulerEnabled: bool(env.SCHEDULER_ENABLED, false),
    // Bounded so one invocation cannot exceed the Free plan's 10ms CPU,
    // 50 subrequest or 50 D1 query ceilings.
    maxTrackersPerTick: Math.max(1, Math.trunc(num(env.MAX_TRACKERS_PER_TICK, 2))),
    maxQueriesPerTick: Math.max(1, Math.trunc(num(env.MAX_QUERIES_PER_TICK, 3))),
    schedulerLeaseTtlSeconds: Math.max(30, Math.trunc(num(env.SCHEDULER_LEASE_TTL_SECONDS, 300))),

    offlineMode: bool(env.OFFLINE_MODE, false),
  };

  return {
    config,
    problems,
    usable: !problems.some((p) => p.blocking),
  };
}

/** Redacted view for the operational status panel. Never leaks a secret. */
export function describeSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return "not set";
  return `set (${trimmed.length} characters)`;
}

/**
 * A non-reversible hint identifying *which* Telegram bot is configured, so the
 * operator can tell one token from another without the token being exposed.
 */
export function telegramTokenHint(token: string | undefined): string | null {
  const trimmed = token?.trim() ?? "";
  if (trimmed === "") return null;
  const botId = trimmed.split(":")[0] ?? "";
  return /^\d+$/.test(botId) ? `bot id ${botId}` : "token loaded";
}
