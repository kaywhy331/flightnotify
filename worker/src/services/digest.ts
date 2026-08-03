/**
 * Weekly Telegram summary.
 *
 * The bot's silence between rare alerts is indistinguishable from the bot
 * being broken. One short message a week fixes that using the channel that
 * already exists: what each tracker observed, and how much of the search
 * allowance remains. No new services, no new secrets.
 *
 * Cadence state lives in app_settings. On the very first run the timestamp is
 * seeded without sending, so deploying this feature never surprises the owner
 * with an immediate message; the first digest arrives a week later.
 */

import type { Config } from "../env.js";
import type { Repo } from "../db/repo.js";
import { TrackerStatus } from "../domain/enums.js";
import { formatMoney } from "../domain/money.js";
import { escapeHtml } from "./telegram.js";
import type { QuotaManager } from "./quota.js";
import { nowIso, parseIsoOrNull, toIso } from "../time.js";

export const DIGEST_SETTING_KEY = "weekly_digest_last_sent";
const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Just the two members the digest needs, so tests can hand in a fake. */
export interface DigestNotifier {
  isConfigured(): boolean;
  sendMessage(
    chatId: string,
    text: string,
    options?: { disablePreview?: boolean },
  ): Promise<{ ok: boolean; userMessage: string }>;
}

export interface DigestOutcome {
  sent: boolean;
  seeded: boolean;
  skippedReason: string | null;
}

export async function maybeSendWeeklyDigest(
  repo: Repo,
  config: Config,
  quota: QuotaManager,
  notifier: DigestNotifier,
  now: Date = new Date(),
): Promise<DigestOutcome> {
  const last = await repo.getSetting<string>(DIGEST_SETTING_KEY);

  if (last === null) {
    await repo.setSetting(DIGEST_SETTING_KEY, toIso(now));
    return { sent: false, seeded: true, skippedReason: "first run; cadence seeded" };
  }

  const lastAt = parseIsoOrNull(last);
  if (lastAt !== null && now.getTime() - lastAt.getTime() < WEEK_MS) {
    return { sent: false, seeded: false, skippedReason: "not due yet" };
  }

  if (!notifier.isConfigured() || config.telegramChatId === "") {
    // Not an error: the digest simply waits until Telegram is set up, and the
    // stale timestamp means it fires on the first tick after that.
    return { sent: false, seeded: false, skippedReason: "telegram not configured" };
  }

  const message = await composeDigest(repo, config, quota, now);
  const result = await notifier.sendMessage(config.telegramChatId, message, {
    disablePreview: true,
  });
  if (!result.ok) {
    // Timestamp is only advanced on success, so a failed send retries on the
    // next tick instead of silently skipping a week.
    return { sent: false, seeded: false, skippedReason: result.userMessage };
  }

  await repo.setSetting(DIGEST_SETTING_KEY, toIso(now));
  return { sent: true, seeded: false, skippedReason: null };
}

async function composeDigest(
  repo: Repo,
  config: Config,
  quota: QuotaManager,
  now: Date,
): Promise<string> {
  const trackers = await repo.listTrackers();
  const weekAgo = toIso(new Date(now.getTime() - WEEK_MS));
  const weekly = await repo.weeklyObservationStats(weekAgo);
  const snapshot = await quota.snapshot(now);

  const lines: string[] = ["<b>✈️ FlightNotify weekly summary</b>"];

  const active = trackers.filter(
    (t) => t.status === TrackerStatus.ACTIVE || t.status === TrackerStatus.ERROR,
  );
  if (active.length === 0) {
    lines.push(escapeHtml("No active trackers this week."));
  }
  for (const tracker of active) {
    const stats = weekly.get(tracker.id);
    let line = `${tracker.name} (${tracker.origin}→${tracker.destination}): `;
    if (stats && stats.count > 0) {
      line +=
        `this week ${formatMoney(stats.loCents, tracker.currency)}–` +
        `${formatMoney(stats.hiCents, tracker.currency)} over ${stats.count} check` +
        `${stats.count === 1 ? "" : "s"}`;
      if (tracker.low_price_cents !== null) {
        line +=
          stats.loCents <= tracker.low_price_cents
            ? ` · new low ${formatMoney(tracker.low_price_cents, tracker.currency)}`
            : ` · low still ${formatMoney(tracker.low_price_cents, tracker.currency)}`;
      }
    } else {
      line += "no successful checks this week";
      if (tracker.last_error_message) line += " (last check failed)";
    }
    lines.push(escapeHtml(line));
  }

  lines.push(
    escapeHtml(
      `Searches: ${snapshot.effectiveUsed} of ${snapshot.monthlyLimit} used in ` +
        `${snapshot.period}, ${snapshot.remainingSafe} available to automation.`,
    ),
  );
  return lines.join("\n");
}

export { nowIso };
