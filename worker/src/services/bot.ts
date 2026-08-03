/**
 * Telegram command webhook.
 *
 * Only the configured private chat is ever obeyed. Every accepted update is
 * claimed in D1 before a command runs; the reply is then persisted before it
 * is sent. Telegram may retry a failed webhook delivery, but a retry can only
 * resend that prepared reply. If an invocation dies before preparing one, the
 * recovery path reports the ambiguity and never executes the command again.
 */

import type { Config } from "../env.js";
import type { Repo } from "../db/repo.js";
import type { TelegramUpdateRow, TrackerWithMarkets } from "../db/rows.js";
import {
  DateMode,
  RunTrigger,
  TrackerStatus,
  type RunTriggerValue,
} from "../domain/enums.js";
import { formatLocal, parseIsoOrNull } from "../time.js";
import { nextRunAt } from "./tracker.js";
import type { QuotaSnapshot } from "./quota.js";
import type { CheckResult } from "./search.js";
import { escapeHtml, type TelegramResult } from "./telegram.js";
import {
  buildCheckResultMessage,
  buildHelpMessage,
  buildStatusMessage,
  buildTrackerDetailMessage,
  buildTrackersMessage,
  buildUnknownCommandMessage,
} from "./bot-messages.js";

const PROCESSING_ABANDON_MS = 5 * 60_000;
const UPDATE_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface TelegramCommand {
  name: string;
  argument: string | null;
  chatId: number;
  updateId: number;
}

export interface BotNotifier {
  sendMessage(
    chatId: string | number,
    text: string,
    options?: { disablePreview?: boolean },
  ): Promise<TelegramResult>;
}

export interface TelegramBotDeps {
  repo: Repo;
  config: Config;
  notifier: BotNotifier;
  quota: { snapshot(): Promise<QuotaSnapshot> };
  search: {
    runTracker(tracker: TrackerWithMarkets, trigger: RunTriggerValue): Promise<CheckResult>;
  };
  version: string;
}

export interface BotHandleResult {
  updateId: number | null;
  outcome: "ignored" | "duplicate" | "delivered" | "retry" | "failed";
  retry: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateIdOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const updateId = value["update_id"];
  return typeof updateId === "number" && Number.isSafeInteger(updateId) && updateId >= 0
    ? updateId
    : null;
}

/** Split `/check@MyBot 3` into `/check` and `3`. */
export function parseCommand(text: string): { name: string; argument: string | null } {
  const stripped = text.trim();
  if (!stripped.startsWith("/")) return { name: "", argument: null };
  const space = stripped.indexOf(" ");
  const head = space < 0 ? stripped : stripped.slice(0, space);
  const tail = space < 0 ? "" : stripped.slice(space + 1).trim();
  return {
    name: (head.split("@", 1)[0] ?? "").toLowerCase().slice(0, 256),
    argument: tail || null,
  };
}

function parseTrackerId(argument: string | null): number | null {
  const token = argument?.split(/\s+/, 1)[0] ?? "";
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class TelegramBot {
  constructor(private readonly deps: TelegramBotDeps) {}

  async handleUpdate(raw: unknown): Promise<BotHandleResult> {
    if (
      this.deps.config.telegramBotToken === "" ||
      this.deps.config.telegramChatId === ""
    ) {
      throw new Error("Telegram command webhook is not fully configured");
    }
    const updateId = updateIdOf(raw);
    if (updateId === null) return { updateId: null, outcome: "ignored", retry: false };

    const claim = await this.deps.repo.claimTelegramUpdate(updateId);
    // Retention is housekeeping, never part of the command's correctness. If
    // this DELETE failed after the claim but before dispatch, the row would be
    // left in `processing`; the deliberately at-most-once recovery path would
    // then abandon a command that we know never started. Cron also retries the
    // prune, so keep a transient cleanup failure off the critical path.
    try {
      await this.deps.repo.pruneTelegramUpdates(new Date(Date.now() - UPDATE_RETENTION_MS));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "telegram_update_prune_failed",
          error: error instanceof Error ? error.name : "Error",
        }),
      );
    }
    if (!claim.claimed) return this.handleExisting(raw, claim.row);
    return this.execute(raw, updateId, claim.row.delivery_attempts);
  }

  private async handleExisting(
    raw: unknown,
    row: TelegramUpdateRow,
  ): Promise<BotHandleResult> {
    if (row.state === "ready" && row.chat_id !== null && row.reply_text !== null) {
      return this.deliver(row.update_id, row.chat_id, row.reply_text, row.delivery_attempts);
    }
    if (row.state !== "processing") {
      return { updateId: row.update_id, outcome: "duplicate", retry: false };
    }

    const updated = parseIsoOrNull(row.updated_at);
    if (updated !== null && Date.now() - updated.getTime() < PROCESSING_ABANDON_MS) {
      // Another invocation still owns this update. A 503 asks Telegram to retry
      // later instead of allowing two state-changing handlers to overlap.
      return { updateId: row.update_id, outcome: "retry", retry: true };
    }

    console.warn(
      JSON.stringify({ event: "telegram_update_abandoned", update_id: row.update_id }),
    );
    const command = this.commandFrom(raw, row.update_id);
    if (command === null) {
      await this.deps.repo.updateTelegramUpdate(row.update_id, {
        state: "ignored",
        last_error: "processing lease expired before the update could be authorised",
      });
      return { updateId: row.update_id, outcome: "ignored", retry: false };
    }
    const reply = escapeHtml(
      "FlightNotify could not prove whether the earlier command attempt finished, so it " +
        "was not run again. Check the web UI, then send the command again if it is still needed.",
    );
    await this.deps.repo.updateTelegramUpdate(row.update_id, {
      state: "ready",
      chat_id: String(command.chatId),
      command: command.name,
      reply_text: reply,
      last_error: "processing lease expired; command deliberately not retried",
    });
    return this.deliver(row.update_id, String(command.chatId), reply, row.delivery_attempts);
  }

  private commandFrom(raw: unknown, updateId: number): TelegramCommand | null {
    if (!isRecord(raw)) return null;
    const message = raw["message"];
    if (!isRecord(message)) return null;
    const chat = message["chat"];
    const text = message["text"];
    if (!isRecord(chat) || typeof text !== "string") return null;
    if (chat["type"] !== "private") return null;
    const chatId = chat["id"];
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return null;

    if (
      this.deps.config.telegramChatId === "" ||
      String(chatId) !== this.deps.config.telegramChatId
    ) {
      // Deliberately silent: replying would confirm the bot exists to a
      // stranger and could let them burn the bot's send allowance.
      console.warn(JSON.stringify({ event: "telegram_command_unauthorised" }));
      return null;
    }

    const parsed = parseCommand(text);
    if (parsed.name === "") return null;
    return { ...parsed, chatId, updateId };
  }

  private async execute(
    raw: unknown,
    updateId: number,
    deliveryAttempts: number,
  ): Promise<BotHandleResult> {
    const command = this.commandFrom(raw, updateId);
    if (command === null) {
      await this.deps.repo.updateTelegramUpdate(updateId, {
        state: "ignored",
        last_error: null,
      });
      return { updateId, outcome: "ignored", retry: false };
    }

    let reply: string;
    try {
      reply = await this.dispatch(command);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "telegram_command_error",
          update_id: updateId,
          command: command.name,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      reply = escapeHtml(
        "That command failed unexpectedly. Check the Worker logs for details; " +
          "FlightNotify did not automatically retry the command.",
      );
    }

    await this.deps.repo.updateTelegramUpdate(updateId, {
      state: "ready",
      chat_id: String(command.chatId),
      command: command.name,
      reply_text: reply,
      last_error: null,
    });
    return this.deliver(updateId, String(command.chatId), reply, deliveryAttempts);
  }

  private async deliver(
    updateId: number,
    chatId: string,
    reply: string,
    previousAttempts: number,
  ): Promise<BotHandleResult> {
    const attempts = previousAttempts + 1;
    let result: TelegramResult;
    try {
      result = await this.deps.notifier.sendMessage(chatId, reply, { disablePreview: true });
    } catch (error) {
      const label = error instanceof Error ? error.name : "Error";
      await this.deps.repo.updateTelegramUpdate(updateId, {
        state: "ready",
        delivery_attempts: attempts,
        last_error: `network: ${label}`,
      });
      return { updateId, outcome: "retry", retry: true };
    }

    if (result.ok) {
      await this.deps.repo.updateTelegramUpdate(updateId, {
        state: "delivered",
        delivery_attempts: attempts,
        last_error: null,
      });
      return { updateId, outcome: "delivered", retry: false };
    }

    const detail = `${result.category}: ${result.userMessage}`.slice(0, 1000);
    await this.deps.repo.updateTelegramUpdate(updateId, {
      state: result.retryable ? "ready" : "failed",
      delivery_attempts: attempts,
      last_error: detail,
    });
    return {
      updateId,
      outcome: result.retryable ? "retry" : "failed",
      retry: result.retryable,
    };
  }

  private async dispatch(command: TelegramCommand): Promise<string> {
    switch (command.name) {
      case "/start":
      case "/help":
        return buildHelpMessage();
      case "/status":
        return this.status();
      case "/trackers":
        return buildTrackersMessage(await this.deps.repo.listTrackers());
      case "/tracker":
        return this.tracker(command.argument);
      case "/check":
        return this.check(command);
      case "/pause":
        return this.pause(command.argument);
      case "/resume":
        return this.resume(command.argument);
      default:
        return buildUnknownCommandMessage(command.name);
    }
  }

  private async status(): Promise<string> {
    const [snapshot, state, runs, trackers] = await Promise.all([
      this.deps.quota.snapshot(),
      this.deps.repo.schedulerState(),
      this.deps.repo.recentCronRuns(1),
      this.deps.repo.listTrackers(),
    ]);
    const lastRun = runs[0] ?? null;
    let schedulerDetail: string;
    if (!this.deps.config.schedulerEnabled) {
      schedulerDetail = "SCHEDULER_ENABLED is false";
    } else if (lastRun !== null) {
      schedulerDetail =
        `last run ${lastRun.outcome} at ` +
        formatLocal(lastRun.started_at, this.deps.config.appTimezone);
    } else if (state?.last_tick_at) {
      schedulerDetail =
        "last tick at " + formatLocal(state.last_tick_at, this.deps.config.appTimezone);
    } else {
      schedulerDetail = "enabled; no Cron run recorded yet";
    }
    return buildStatusMessage({
      snapshot,
      schedulerEnabled: this.deps.config.schedulerEnabled,
      schedulerDetail,
      trackerCount: trackers.length,
      activeCount: trackers.filter((tracker) => tracker.status === TrackerStatus.ACTIVE).length,
      providerConfigured: this.deps.config.serpapiApiKey !== "",
      version: this.deps.version,
      now: new Date(),
      timeZone: this.deps.config.appTimezone,
    });
  }

  private async tracker(argument: string | null): Promise<string> {
    const trackerId = parseTrackerId(argument);
    if (trackerId === null) {
      return escapeHtml("Send a tracker id, for example /tracker 1. Use /trackers to list them.");
    }
    const tracker = await this.deps.repo.getTracker(trackerId);
    if (tracker === null) {
      return escapeHtml(`No tracker with id ${trackerId}. Use /trackers to list them.`);
    }
    const coverage =
      tracker.date_mode === DateMode.CUSTOM_WINDOW && tracker.current_config_version_id !== null
        ? await this.deps.repo.candidateCoverage(
            tracker.current_config_version_id,
            tracker.coverage_cycle,
          )
        : null;
    return buildTrackerDetailMessage(
      tracker,
      coverage === null
        ? null
        : { ...coverage, complete: coverage.total > 0 && coverage.checked >= coverage.total },
      this.deps.config.appTimezone,
    );
  }

  private async check(command: TelegramCommand): Promise<string> {
    const trackerId = parseTrackerId(command.argument);
    if (trackerId === null) return escapeHtml("Send a tracker id, for example /check 1.");
    if (this.deps.config.serpapiApiKey === "") {
      return escapeHtml("SERPAPI_API_KEY is not set, so no search was attempted.");
    }
    const tracker = await this.deps.repo.getTracker(trackerId);
    if (tracker === null) {
      return escapeHtml(`No tracker with id ${trackerId}. Use /trackers to list them.`);
    }

    const owner = `telegram:${command.updateId}:${crypto.randomUUID().slice(0, 8)}`;
    const locked = await this.deps.repo.acquireTrackerLock(
      tracker.id,
      owner,
      this.deps.config.schedulerLeaseTtlSeconds,
    );
    if (!locked) {
      return escapeHtml(
        `A check for “${tracker.name.slice(0, 200)}” is already running. Nothing was started twice.`,
      );
    }
    try {
      const result = await this.deps.search.runTracker(tracker, RunTrigger.MANUAL);
      return buildCheckResultMessage(tracker, result);
    } finally {
      await this.deps.repo.releaseTrackerLock(tracker.id, owner);
    }
  }

  private async pause(argument: string | null): Promise<string> {
    const tracker = await this.trackerForWrite(argument, "/pause");
    if (typeof tracker === "string") return tracker;
    await this.deps.repo.updateTrackerFields(tracker.id, { status: TrackerStatus.PAUSED });
    return escapeHtml(`“${tracker.name.slice(0, 200)}” paused. History is kept.`);
  }

  private async resume(argument: string | null): Promise<string> {
    const tracker = await this.trackerForWrite(argument, "/resume");
    if (typeof tracker === "string") return tracker;
    await this.deps.repo.updateTrackerFields(tracker.id, {
      status: TrackerStatus.ACTIVE,
      consecutive_failures: 0,
      last_error_category: null,
      last_error_message: null,
      next_run_at: nextRunAt(tracker.check_interval_minutes),
    });
    return escapeHtml(`“${tracker.name.slice(0, 200)}” resumed.`);
  }

  private async trackerForWrite(
    argument: string | null,
    command: string,
  ): Promise<TrackerWithMarkets | string> {
    const trackerId = parseTrackerId(argument);
    if (trackerId === null) {
      return escapeHtml(`Send a tracker id, for example ${command} 1.`);
    }
    const tracker = await this.deps.repo.getTracker(trackerId);
    return tracker ?? escapeHtml(`No tracker with id ${trackerId}. Use /trackers to list them.`);
  }
}
