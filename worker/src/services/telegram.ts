/**
 * Telegram Bot API client.
 *
 * Port of `flightnotify/services/telegram.py`. Direct HTTPS calls to
 * api.telegram.org over the global `fetch` -- no SDK, no third-party
 * notification service, nothing paid.
 *
 * The bot token is a *path segment* of every request URL. That makes it easy to
 * leak by accident: any error text that echoes the URL, any log line that
 * includes the request, any exception re-raised with its context. Nothing in
 * this module interpolates the URL into a message, and `redact()` is the
 * backstop for the case where a runtime buries it inside an error anyway.
 */

import { telegramTokenHint } from "../env.js";

export type TelegramCategory =
  | "ok"
  | "not_configured"
  | "invalid_token"
  | "rate_limit"
  | "blocked"
  | "chat_not_found"
  | "server_error"
  | "timeout"
  | "network"
  | "ambiguous_response"
  | "no_chats"
  | "error";

/**
 * A failure worth trying again later. Everything else is a configuration or
 * addressing problem that a retry would repeat verbatim.
 */
const RETRYABLE_CATEGORIES: ReadonlySet<TelegramCategory> = new Set<TelegramCategory>([
  "rate_limit",
  "timeout",
  "network",
  "server_error",
]);

export function isRetryable(category: TelegramCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

export interface TelegramResult {
  readonly ok: boolean;
  readonly messageId: number | null;
  readonly errorCode: number | null;
  readonly description: string | null;
  readonly retryAfter: number | null;
  readonly category: TelegramCategory;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly meta: Record<string, unknown>;
}

export interface DiscoveredChat {
  readonly chatId: number;
  readonly chatType: string;
  readonly displayName: string;
  readonly lastMessageAt: Date | null;
  readonly lastText: string | null;
}

export interface BotIdentity {
  readonly botId: number;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly handle: string;
}

export interface TelegramWebhookInfo {
  readonly url: string;
  readonly pendingUpdateCount: number;
  readonly lastErrorDate: number | null;
  readonly lastErrorMessage: string | null;
  readonly maxConnections: number | null;
  readonly allowedUpdates: string[];
}

/** The slice of `Config` this client needs; `Config` satisfies it structurally. */
export interface TelegramConfig {
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
  readonly telegramBaseUrl: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Matches `Settings.telegram_timeout_seconds`. It is a constant rather than a
 * binding because `env.ts` exposes no knob for it and must not be edited; the
 * Worker's own 30s subrequest budget is the real ceiling anyway.
 */
const DEFAULT_TIMEOUT_SECONDS = 20;
/** Bot API JSON should be tiny; cap decompressed bodies far below Worker memory limits. */
export const MAX_TELEGRAM_RESPONSE_BYTES = 1024 * 1024;

type Scalar = string | number | boolean;

/**
 * Escape for Telegram's HTML parse mode.
 *
 * Telegram documents that "All <, > and & symbols that are not a part of a tag
 * or an HTML entity must be replaced with the corresponding HTML entities".
 * This is Python's `html.escape(text, quote=False)`: quotes and apostrophes stay
 * literal, which Telegram accepts outside tag attributes and which reads better
 * in a message. Escaping them too would render as visible `&#x27;` noise.
 *
 * Order matters -- `&` first, or the ampersands of the later entities get
 * double-escaped.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class TelegramResponseBodyError extends Error {
  constructor(readonly reason: "too_large" | "read_failed") {
    super(reason);
    this.name = "TelegramResponseBodyError";
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const header = response.headers.get("Content-Length");
  if (header !== null) {
    const declared = Number(header);
    if (Number.isFinite(declared) && declared > MAX_TELEGRAM_RESPONSE_BYTES) {
      throw new TelegramResponseBodyError("too_large");
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TELEGRAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramResponseBodyError("too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof TelegramResponseBodyError) throw error;
    throw new TelegramResponseBodyError("read_failed");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Rewrite every string reachable from `value`, structure preserved. */
function mapStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, replace)]),
    );
  }
  return value;
}

function makeResult(fields: {
  ok: boolean;
  category: TelegramCategory;
  messageId?: number | null;
  errorCode?: number | null;
  description?: string | null;
  retryAfter?: number | null;
  userMessage?: string;
  meta?: Record<string, unknown>;
}): TelegramResult {
  return {
    ok: fields.ok,
    messageId: fields.messageId ?? null,
    errorCode: fields.errorCode ?? null,
    description: fields.description ?? null,
    retryAfter: fields.retryAfter ?? null,
    category: fields.category,
    userMessage: fields.userMessage ?? "",
    retryable: isRetryable(fields.category),
    meta: fields.meta ?? {},
  };
}

export class TelegramNotifier {
  private readonly config: TelegramConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: TelegramConfig, options: { fetch?: FetchLike } = {}) {
    this.config = config;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // -- configuration ------------------------------------------------------
  isConfigured(): boolean {
    return this.token() !== "";
  }

  get configuredChatId(): string {
    return this.config.telegramChatId.trim();
  }

  /** A non-reversible hint so the UI can show *which* token is loaded. */
  tokenHint(): string | null {
    return telegramTokenHint(this.config.telegramBotToken);
  }

  // -- API calls ----------------------------------------------------------
  async getMe(): Promise<TelegramResult> {
    const result = await this.call("getMe", {});
    if (!result.ok) return result;

    const payload = isRecord(result.meta["result"]) ? result.meta["result"] : {};
    const botId = typeof payload["id"] === "number" ? payload["id"] : 0;
    const username = typeof payload["username"] === "string" ? payload["username"] : null;
    const identity: BotIdentity = {
      botId,
      username,
      firstName: typeof payload["first_name"] === "string" ? payload["first_name"] : null,
      handle: username ? `@${username}` : `bot ${botId}`,
    };
    return makeResult({
      ok: true,
      category: "ok",
      userMessage: `Connected as ${identity.handle}.`,
      meta: { identity, result: payload },
    });
  }

  /**
   * List recent direct chats that have messaged the bot.
   *
   * `getUpdates` only returns updates from the last 24 hours and only while no
   * webhook is set, so an empty list usually means "/start was never sent"
   * rather than a failure -- hence the dedicated `no_chats` category with
   * instructions instead of an error.
   */
  async discoverChats(limit = 100): Promise<{ chats: DiscoveredChat[]; result: TelegramResult }> {
    const result = await this.call("getUpdates", {
      limit: Math.max(1, Math.min(limit, 100)),
      timeout: 0,
      allowed_updates: '["message"]',
    });
    if (!result.ok) return { chats: [], result };

    const updates = Array.isArray(result.meta["result"]) ? result.meta["result"] : [];
    // Keyed by chat so a chat that wrote twice appears once, with its newest
    // message: insertion order is preserved, which keeps the sort stable.
    const found = new Map<number, DiscoveredChat>();
    for (const update of updates) {
      const message = isRecord(update) ? update["message"] : null;
      if (!isRecord(message)) continue;
      const chat = message["chat"];
      if (!isRecord(chat)) continue;

      const chatType = typeof chat["type"] === "string" ? chat["type"] : "";
      // A single-user tool alerts a direct chat, not groups/channels.
      if (chatType !== "private") continue;
      const chatId = chat["id"];
      if (typeof chatId !== "number") continue;

      let name = ["first_name", "last_name"]
        .map((key) => (typeof chat[key] === "string" ? chat[key] : ""))
        .filter((value) => value !== "")
        .join(" ")
        .trim();
      const username = chat["username"];
      if (typeof username === "string" && username !== "") {
        name = `${name} (@${username})`.trim();
      }

      const timestamp = message["date"];
      const text = message["text"];
      found.set(chatId, {
        chatId,
        chatType,
        displayName: name || `chat ${chatId}`,
        lastMessageAt:
          typeof timestamp === "number" && Number.isInteger(timestamp)
            ? new Date(timestamp * 1000)
            : null,
        lastText: typeof text === "string" ? text.slice(0, 120) : null,
      });
    }

    const chats = [...found.values()].sort(
      (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    );
    if (chats.length === 0) {
      return {
        chats: [],
        result: makeResult({
          ok: false,
          category: "no_chats",
          userMessage:
            "No recent direct chat was found. Open Telegram, send /start to your " +
            "bot, then try again. Telegram only keeps updates for 24 hours, and " +
            "this will not work if the bot has a webhook configured.",
        }),
      };
    }
    return { chats, result: makeResult({ ok: true, category: "ok" }) };
  }

  /**
   * Fetch pending updates, optionally long-polling.
   *
   * `offset` must be one past the highest update id already handled; supplying
   * it is what tells Telegram to forget the earlier ones. A non-zero `timeout`
   * asks Telegram to hold the request open until an update arrives, which is far
   * cheaper than polling in a tight loop.
   *
   * `getUpdates` is single-consumer: confirming an offset discards older
   * updates, so nothing else (notably `discoverChats`) can read them afterwards.
   */
  async getUpdates(options: { offset?: number | null; timeout?: number } = {}) {
    const timeout = Math.max(0, options.timeout ?? 0);
    const payload: Record<string, Scalar> = { timeout, allowed_updates: '["message"]' };
    if (options.offset !== null && options.offset !== undefined) payload["offset"] = options.offset;
    // The HTTP call must outlive the long poll itself, or every quiet poll would
    // surface as a timeout.
    return this.call("getUpdates", payload, DEFAULT_TIMEOUT_SECONDS + timeout);
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    options: { disablePreview?: boolean } = {},
  ): Promise<TelegramResult> {
    const payload: Record<string, Scalar> = {
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
    };
    if (options.disablePreview) payload["link_preview_options"] = '{"is_disabled":true}';

    const result = await this.call("sendMessage", payload);
    if (!result.ok) return result;

    const message = isRecord(result.meta["result"]) ? result.meta["result"] : {};
    const chat = message["chat"];
    return makeResult({
      ok: true,
      messageId: typeof message["message_id"] === "number" ? message["message_id"] : null,
      category: "ok",
      userMessage: "Message delivered.",
      meta: { chatId: isRecord(chat) ? (chat["id"] ?? null) : null },
    });
  }

  /** Register the single-user command webhook with Telegram. */
  async setWebhook(url: string, secret: string): Promise<TelegramResult> {
    if (!url.startsWith("https://")) {
      return makeResult({
        ok: false,
        category: "error",
        userMessage: "Telegram requires an HTTPS webhook URL.",
      });
    }
    if (secret.length < 32 || secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
      return makeResult({
        ok: false,
        category: "error",
        userMessage: "The Telegram webhook secret is missing or invalid.",
      });
    }
    const result = await this.call("setWebhook", {
      url,
      secret_token: secret,
      // One connection preserves update order and keeps a single-user bot from
      // executing two state-changing commands concurrently.
      max_connections: 1,
      allowed_updates: '["message"]',
    });
    if (!result.ok) return result;
    return makeResult({
      ok: true,
      category: "ok",
      userMessage: "Telegram command webhook enabled.",
      meta: result.meta,
    });
  }

  async deleteWebhook(): Promise<TelegramResult> {
    const result = await this.call("deleteWebhook", { drop_pending_updates: false });
    if (!result.ok) return result;
    return makeResult({
      ok: true,
      category: "ok",
      userMessage: "Telegram command webhook disabled.",
      meta: result.meta,
    });
  }

  async getWebhookInfo(): Promise<{
    info: TelegramWebhookInfo | null;
    result: TelegramResult;
  }> {
    const result = await this.call("getWebhookInfo", {});
    if (!result.ok) return { info: null, result };
    const payload = isRecord(result.meta["result"]) ? result.meta["result"] : {};
    const allowed = Array.isArray(payload["allowed_updates"])
      ? payload["allowed_updates"].filter((item): item is string => typeof item === "string")
      : [];
    return {
      info: {
        url: typeof payload["url"] === "string" ? payload["url"] : "",
        pendingUpdateCount:
          typeof payload["pending_update_count"] === "number"
            ? Math.trunc(payload["pending_update_count"])
            : 0,
        lastErrorDate:
          typeof payload["last_error_date"] === "number"
            ? Math.trunc(payload["last_error_date"])
            : null,
        lastErrorMessage:
          typeof payload["last_error_message"] === "string"
            ? payload["last_error_message"]
            : null,
        maxConnections:
          typeof payload["max_connections"] === "number"
            ? Math.trunc(payload["max_connections"])
            : null,
        allowedUpdates: allowed,
      },
      result: makeResult({
        ok: true,
        category: "ok",
        userMessage: "Telegram webhook status loaded.",
        meta: result.meta,
      }),
    };
  }

  // -- transport ----------------------------------------------------------
  private token(): string {
    return this.config.telegramBotToken.trim();
  }

  /**
   * Strip the token from anything about to be handed back to a caller.
   *
   * No code path here builds a message from the URL, so this should never fire
   * on our own text. It covers `meta` too, because that is Telegram's own
   * response body and an upstream that echoed the request URL into a
   * `description` would otherwise land a live bot token in a persisted alert
   * history row -- a leak nothing downstream could undo.
   */
  private redact(result: TelegramResult): TelegramResult {
    const token = this.token();
    if (token === "") return result;
    const clean = (value: string): string => value.split(token).join("[redacted]");
    return {
      ...result,
      description: result.description === null ? null : clean(result.description),
      userMessage: clean(result.userMessage),
      meta: mapStrings(result.meta, clean) as Record<string, unknown>,
    };
  }

  private async call(
    method: string,
    payload: Record<string, Scalar>,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  ): Promise<TelegramResult> {
    const token = this.token();
    if (token === "") {
      return makeResult({
        ok: false,
        category: "not_configured",
        userMessage:
          "TELEGRAM_BOT_TOKEN is not set, so no message was sent. Create a bot " +
          "with @BotFather, put the token in the Worker's secrets and redeploy.",
      });
    }

    const url = `${this.config.telegramBaseUrl.replace(/\/+$/, "")}/bot${token}/${method}`;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) form.set(key, String(value));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
    } catch (error) {
      return this.redact(this.mapTransportError(error));
    }

    let text: string;
    try {
      text = await boundedResponseText(response);
    } catch (error) {
      const reason =
        error instanceof TelegramResponseBodyError ? error.reason : "read_failed";
      const problem =
        reason === "too_large"
          ? "Telegram returned a response larger than the 1 MiB safety limit."
          : "Telegram's response could not be read safely.";
      return this.redact(
        makeResult({
          ok: false,
          category: "ambiguous_response",
          userMessage:
            `${problem} ` +
            (method === "sendMessage"
              ? "Message delivery is uncertain, so FlightNotify will not automatically repeat it and risk a duplicate."
              : "The request result is unknown; try the setup action again."),
          meta: { response_error: reason },
        }),
      );
    }

    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      // A body that is not JSON is treated as absent, so the HTTP status alone
      // drives classification -- same outcome as the Python `except ValueError`.
      body = {};
    }
    const parsed = isRecord(body) ? body : {};

    if (parsed["ok"] === true) return makeResult({ ok: true, category: "ok", meta: parsed });
    return this.redact(this.mapError(response.status, parsed));
  }

  private mapTransportError(error: unknown): TelegramResult {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return makeResult({
        ok: false,
        category: "timeout",
        userMessage:
          "Telegram did not respond in time. Any price observation from this " +
          "check is still saved. If this was a message send, delivery is uncertain, " +
          "so FlightNotify will not automatically repeat it and risk a duplicate.",
      });
    }
    // Only a bare class name goes into the text -- never `error.message`, which
    // in several runtimes contains the request URL and therefore the token.
    const label = /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : "NetworkError";
    return makeResult({
      ok: false,
      category: "network",
      userMessage:
        `Could not reach Telegram (${label}). Any price observation ` +
        "from this check is still saved. If this was a message send, delivery is " +
        "uncertain, so FlightNotify will not automatically repeat it and risk a duplicate. " +
        "Check the Worker's network access.",
    });
  }

  private mapError(status: number, body: Record<string, unknown>): TelegramResult {
    const rawCode = body["error_code"] as number | string | null | undefined;
    const errorCode = rawCode || status;
    const rawDescription = body["description"] as string | number | null | undefined;
    const description = rawDescription ? String(rawDescription) : `HTTP ${status}`;
    const parameters = isRecord(body["parameters"]) ? body["parameters"] : {};
    const rawRetryAfter = parameters["retry_after"];
    const retryAfter =
      typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter) ? rawRetryAfter : null;
    const lowered = description.toLowerCase();

    let category: TelegramCategory;
    let message: string;
    if (errorCode === 401 || lowered.includes("unauthorized")) {
      category = "invalid_token";
      message =
        "Telegram rejected the bot token. No message was sent and stored price " +
        "history is unchanged. Re-check TELEGRAM_BOT_TOKEN with @BotFather.";
    } else if (errorCode === 429 || lowered.includes("too many requests")) {
      category = "rate_limit";
      message =
        "Telegram rate-limited the bot" +
        (retryAfter ? `; retry after ${Math.trunc(retryAfter)}s. ` : ". ") +
        "The price observation is saved and the alert will be retried.";
    } else if (errorCode === 403 || lowered.includes("blocked") || lowered.includes("forbidden")) {
      category = "blocked";
      message =
        "The bot cannot message that chat - it was blocked or never started. " +
        "The price observation is saved. Send /start to the bot in Telegram.";
    } else if (lowered.includes("chat not found")) {
      category = "chat_not_found";
      message =
        "Telegram does not recognise that chat id. The price observation is " +
        "saved. Send /start to the bot, then use Settings -> Discover chat.";
    } else if (typeof errorCode === "number" && errorCode >= 500) {
      category = "server_error";
      message =
        "Telegram returned a server error. The price observation is saved and " +
        "the alert will be retried.";
    } else {
      category = "error";
      message = `Telegram rejected the request: ${description}. The price observation is saved.`;
    }

    return makeResult({
      ok: false,
      errorCode: typeof errorCode === "number" ? Math.trunc(errorCode) : null,
      description,
      retryAfter,
      category,
      userMessage: message,
      meta: { errorCode, description },
    });
  }
}
