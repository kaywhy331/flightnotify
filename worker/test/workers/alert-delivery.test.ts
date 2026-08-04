import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { AlertService, MAX_DELIVERY_ATTEMPTS, type AlertNotifier } from "../../src/services/alerts.js";
import type { TelegramResult } from "../../src/services/telegram.js";
import { toIso } from "../../src/time.js";

function repo(): Repo {
  return new Repo(env.DB);
}

function result(
  category: TelegramResult["category"],
  options: { ok?: boolean; retryable?: boolean; retryAfter?: number | null } = {},
): TelegramResult {
  return {
    ok: options.ok ?? false,
    messageId: options.ok ? 42 : null,
    errorCode: options.ok ? null : 500,
    description: null,
    retryAfter: options.retryAfter ?? null,
    category,
    userMessage: category,
    retryable: options.retryable ?? false,
    meta: {},
  };
}

function notifier(results: (TelegramResult | Error)[]) {
  const calls: string[] = [];
  const fake: AlertNotifier & { calls: string[] } = {
    calls,
    isConfigured: () => true,
    async sendMessage(_chatId, text) {
      calls.push(text);
      const next = results.shift() ?? result("ok", { ok: true });
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return fake;
}

async function insertAlert(fields: Record<string, unknown> = {}): Promise<number> {
  const id = await repo().insertAlertEvent({
    alert_type: "new_low",
    dedupe_key: crypto.randomUUID(),
    message_text: "Price alert",
    delivery_state: "pending",
    created_at: toIso(new Date()),
    ...fields,
  });
  return id!;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM alert_events");
});

describe("atomic alert delivery claims", () => {
  it("allows exactly one concurrent owner to claim an alert", async () => {
    const id = await insertAlert();
    const claims = await Promise.all([
      repo().claimAlert(id, "owner-a", MAX_DELIVERY_ATTEMPTS, 60),
      repo().claimAlert(id, "owner-b", MAX_DELIVERY_ATTEMPTS, 60),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter(Boolean)[0]?.attempts).toBe(1);
  });

  it("claims only due, explicitly retryable failures", async () => {
    const past = toIso(new Date(Date.now() - 60_000));
    const future = toIso(new Date(Date.now() + 60_000));
    const due = await insertAlert({ delivery_state: "failed", retryable: 1, next_attempt_at: past });
    await insertAlert({ delivery_state: "failed", retryable: 0, next_attempt_at: past });
    await insertAlert({ delivery_state: "failed", retryable: 1, next_attempt_at: future });
    await insertAlert({ delivery_state: "uncertain", retryable: 1, next_attempt_at: past });

    const claims = await repo().claimPendingAlerts("retry", 3, 20, 60);
    expect(claims.map((row) => row.id)).toEqual([due]);
  });

  it("parks expired in-flight sends as uncertain instead of retrying", async () => {
    const id = await insertAlert();
    const start = new Date("2026-08-04T12:00:00Z");
    expect(await repo().claimAlert(id, "dead-worker", 3, 30, start)).not.toBeNull();
    expect(await repo().markExpiredAlertClaimsUncertain(new Date(start.getTime() + 31_000))).toBe(1);
    const row = await env.DB.prepare("SELECT * FROM alert_events WHERE id = ?")
      .bind(id)
      .first<{ delivery_state: string; retryable: number; claim_owner: string | null }>();
    expect(row).toMatchObject({ delivery_state: "uncertain", retryable: 0, claim_owner: null });
  });

  it("settles an expired claim even while Telegram is unconfigured", async () => {
    const id = await insertAlert();
    const start = new Date(Date.now() - 120_000);
    expect(await repo().claimAlert(id, "dead-worker", 3, 30, start)).not.toBeNull();
    const unconfigured: AlertNotifier = {
      isConfigured: () => false,
      async sendMessage() {
        throw new Error("must not send");
      },
    };

    const service = new AlertService({ repo: repo(), notifier: unconfigured, timeZone: "UTC" });
    await expect(service.retryPending(null)).resolves.toEqual({ delivered: 0, failed: 0 });
    expect((await repo().findAlertByDedupeKey((await env.DB.prepare(
      "SELECT dedupe_key FROM alert_events WHERE id = ?",
    ).bind(id).first<{ dedupe_key: string }>())!.dedupe_key))?.delivery_state).toBe("uncertain");
  });
});

describe("delivery ambiguity and backoff", () => {
  it("does not retry a timeout because Telegram may have accepted it", async () => {
    const id = await insertAlert();
    const fake = notifier([result("timeout", { retryable: true })]);
    const service = new AlertService({ repo: repo(), notifier: fake, timeZone: "UTC" });

    expect(await service.retryPending("123")).toEqual({ delivered: 0, failed: 1 });
    expect((await repo().findAlertByDedupeKey((await env.DB.prepare(
      "SELECT dedupe_key FROM alert_events WHERE id = ?",
    ).bind(id).first<{ dedupe_key: string }>())!.dedupe_key))?.delivery_state).toBe("uncertain");
    await service.retryPending("123");
    expect(fake.calls).toHaveLength(1);
  });

  it("does not retry when a bounded response cannot confirm delivery", async () => {
    const id = await insertAlert();
    const fake = notifier([result("ambiguous_response")]);
    const service = new AlertService({ repo: repo(), notifier: fake, timeZone: "UTC" });

    expect(await service.retryPending("123")).toEqual({ delivered: 0, failed: 1 });
    const row = await env.DB.prepare("SELECT delivery_state, retryable FROM alert_events WHERE id = ?")
      .bind(id)
      .first<{ delivery_state: string; retryable: number }>();
    expect(row).toEqual({ delivery_state: "uncertain", retryable: 0 });
    await service.retryPending("123");
    expect(fake.calls).toHaveLength(1);
  });

  it("backs off an explicit server failure and later records success", async () => {
    const id = await insertAlert();
    const fake = notifier([
      result("server_error", { retryable: true }),
      result("ok", { ok: true }),
    ]);
    const service = new AlertService({ repo: repo(), notifier: fake, timeZone: "UTC" });

    await service.retryPending("123");
    let row = await env.DB.prepare("SELECT * FROM alert_events WHERE id = ?")
      .bind(id)
      .first<{ delivery_state: string; retryable: number; next_attempt_at: string | null }>();
    expect(row?.delivery_state).toBe("failed");
    expect(row?.retryable).toBe(1);
    expect(row?.next_attempt_at).not.toBeNull();

    await service.retryPending("123");
    expect(fake.calls).toHaveLength(1);
    await env.DB.prepare("UPDATE alert_events SET next_attempt_at = ? WHERE id = ?")
      .bind(toIso(new Date(Date.now() - 1000)), id)
      .run();
    await service.retryPending("123");
    row = await env.DB.prepare("SELECT * FROM alert_events WHERE id = ?")
      .bind(id)
      .first<{ delivery_state: string; retryable: number; next_attempt_at: string | null }>();
    expect(row?.delivery_state).toBe("sent");
    expect(fake.calls).toHaveLength(2);
  });
});
