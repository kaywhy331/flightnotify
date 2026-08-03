/** HTTP boundary for Telegram webhook updates. */

import type { BotHandleResult } from "../services/bot.js";
import { constantTimeEqual } from "./auth.js";

const MAX_UPDATE_BYTES = 64 * 1024;

export interface TelegramUpdateHandler {
  handleUpdate(raw: unknown): Promise<BotHandleResult>;
}

class PayloadTooLargeError extends Error {}

async function boundedText(request: Request): Promise<string> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPDATE_BYTES) throw new PayloadTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function response(status: number, body: object, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function handleTelegramWebhook(
  request: Request,
  options: { secret: string; bot: TelegramUpdateHandler },
): Promise<Response> {
  // A missing secret means command reception is deliberately disabled. A 404
  // reveals no integration detail to internet scanners, regardless of method.
  if (options.secret === "") return response(404, { ok: false });
  if (request.method !== "POST") {
    return response(405, { ok: false }, { Allow: "POST" });
  }

  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!(await constantTimeEqual(supplied, options.secret))) {
    return response(401, { ok: false });
  }
  const contentEncoding = (request.headers.get("Content-Encoding") ?? "identity")
    .trim()
    .toLowerCase();
  if (contentEncoding !== "identity") {
    return response(415, { ok: false });
  }
  const contentType =
    request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json") return response(415, { ok: false });

  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_UPDATE_BYTES) {
    return response(413, { ok: false });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await boundedText(request)) as unknown;
  } catch (error) {
    return response(error instanceof PayloadTooLargeError ? 413 : 400, { ok: false });
  }

  try {
    const result = await options.bot.handleUpdate(raw);
    console.log(
      JSON.stringify({
        event: "telegram_webhook_update",
        update_id: result.updateId,
        outcome: result.outcome,
      }),
    );
    return response(
      result.retry ? 503 : 200,
      { ok: !result.retry },
      result.retry ? { "Retry-After": "5" } : {},
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "telegram_webhook_error",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
    );
    return response(503, { ok: false }, { "Retry-After": "5" });
  }
}
