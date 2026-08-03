/**
 * Single-user authentication.
 *
 * This is the one part of the migration that is genuinely new rather than
 * ported. The Python app had no login at all: it bound to 127.0.0.1 and
 * treated the loopback interface as the security boundary. A Cloudflare
 * deployment is reachable from the internet, so that boundary has to be
 * rebuilt in software before the same data goes up.
 *
 * Design notes:
 *   - Sessions are stateless HMAC-signed cookies. A D1-backed session table
 *     would cost a query on every request against a 50-query budget, and buys
 *     little for a single user whose only revocation lever (rotating
 *     SESSION_SECRET) invalidates every cookie at once anyway.
 *   - Password verification is PBKDF2-SHA256 through WebCrypto. There is no
 *     bcrypt/argon2 in the Workers runtime and adding a WASM one would blow
 *     the bundle budget for no benefit at this threat level.
 *   - Every comparison of a secret-derived value is constant time.
 */

import { Repo } from "../db/repo.js";
import { addSeconds, nowIso, parseIsoOrNull, toIso } from "../time.js";

export const SESSION_COOKIE = "flightnotify_session";
export const SESSION_TTL_SECONDS = 14 * 24 * 3600;

/** Failed attempts before the account locks, and for how long. */
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

/**
 * The Workers runtime refuses PBKDF2 above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * Node's WebCrypto has no such cap, so this only appears once deployed. The
 * constant is exported and validated at config load, which turns a hash minted
 * with a higher count into a precise setup message instead of a 500 on the
 * login route.
 */
export const MAX_PBKDF2_ITERATIONS = 100_000;
export const DEFAULT_PBKDF2_ITERATIONS = 100_000;

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Compare without leaking length or content through timing.
 *
 * Hashes both sides first so that even the length comparison is taken on
 * fixed-size input.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

// ------------------------------------------------------------ password hash
export interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/** Format: pbkdf2$sha256$<iterations>$<salt-b64url>$<hash-b64url> */
export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.trim().split("$");
  if (parts.length !== 5) return null;
  const [scheme, digestName, iterationsText, saltText, hashText] = parts;
  if (scheme !== "pbkdf2" || digestName !== "sha256") return null;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 1000) return null;
  if (iterations > MAX_PBKDF2_ITERATIONS) return null;
  try {
    return {
      iterations,
      salt: base64UrlDecode(saltText!),
      hash: base64UrlDecode(hashText!),
    };
  } catch {
    return null;
  }
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bits: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
      key,
      bits,
    ),
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  const derived = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.hash.length * 8);
  return constantTimeEqual(base64UrlEncode(derived), base64UrlEncode(parsed.hash));
}

/** Used by the `hash-password` script, and by tests to build fixtures. */
export async function hashPassword(
  password: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, iterations, 256);
  return `pbkdf2$sha256$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
}

// ----------------------------------------------------------------- sessions
interface SessionPayload {
  /** Issued-at and expiry, epoch seconds. */
  iat: number;
  exp: number;
  /** Random per-session id; also seeds the CSRF token. */
  sid: string;
}

export async function createSessionToken(secret: string, now = new Date()): Promise<string> {
  const payload: SessionPayload = {
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(addSeconds(now, SESSION_TTL_SECONDS).getTime() / 1000),
    sid: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifySessionToken(
  secret: string,
  token: string | null,
  now = new Date(),
): Promise<SessionPayload | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = await hmac(secret, body);
  if (!(await constantTimeEqual(signature, expected))) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now.getTime()) return null;
    if (typeof payload.sid !== "string" || payload.sid === "") return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // Secure is omitted only for local http development; every real deployment
  // is https, so this is on in production.
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

// --------------------------------------------------------------------- CSRF
/**
 * CSRF token bound to the session.
 *
 * Derived rather than stored: it needs no D1 round trip, and it is worthless
 * without the session cookie it was derived from, so a cross-site form cannot
 * mint one.
 */
export async function csrfTokenFor(secret: string, sid: string): Promise<string> {
  return hmac(secret, `csrf:${sid}`);
}

export async function csrfValid(
  secret: string,
  sid: string,
  submitted: string | null,
): Promise<boolean> {
  if (!submitted) return false;
  return constantTimeEqual(submitted, await csrfTokenFor(secret, sid));
}

// ---------------------------------------------------------------- throttling
export interface ThrottleVerdict {
  locked: boolean;
  retryAfterSeconds: number;
  message: string;
}

/**
 * Throttle key.
 *
 * Hashed with the session secret so the stored value cannot be reversed to an
 * IP address: this is a personal deployment, and its database should not
 * become a log of where its owner has been.
 */
export async function throttleKey(secret: string, request: Request): Promise<string> {
  const address =
    request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown";
  return hmac(secret, `throttle:${address}`);
}

export async function checkThrottle(
  repo: Repo,
  key: string,
  now = new Date(),
): Promise<ThrottleVerdict> {
  const row = await repo.getThrottle(key);
  const lockedUntil = parseIsoOrNull(row?.locked_until ?? null);
  if (lockedUntil !== null && lockedUntil.getTime() > now.getTime()) {
    const seconds = Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000);
    return {
      locked: true,
      retryAfterSeconds: seconds,
      message: `Too many failed sign-in attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
    };
  }
  return { locked: false, retryAfterSeconds: 0, message: "" };
}

export async function recordAuthFailure(repo: Repo, key: string, now = new Date()): Promise<void> {
  const row = await repo.getThrottle(key);
  const failures = (row?.fail_count ?? 0) + 1;
  const lockedUntil =
    failures >= MAX_FAILURES ? toIso(addSeconds(now, LOCKOUT_SECONDS)) : row?.locked_until ?? null;
  await repo.recordAuthFailure(key, lockedUntil);
}

export async function clearAuthFailures(repo: Repo, key: string): Promise<void> {
  await repo.clearAuthFailures(key);
}

export { MAX_FAILURES, LOCKOUT_SECONDS, nowIso };
