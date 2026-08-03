/**
 * Authentication against the real Workers runtime.
 *
 * These deliberately run in the workers pool rather than in Node. Node's
 * WebCrypto and workerd's differ in ways that matter here: Node happily
 * accepts 210,000 PBKDF2 iterations while workerd rejects anything above
 * 100,000, so a Node-only suite reported green for a hash that produced a 500
 * on the deployed login route. Anything touching WebCrypto belongs here.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Repo } from "../../src/db/repo.js";
import { loadConfig, type Env } from "../../src/env.js";
import {
  checkThrottle,
  constantTimeEqual,
  createSessionToken,
  csrfTokenFor,
  csrfValid,
  hashPassword,
  MAX_PBKDF2_ITERATIONS,
  parsePasswordHash,
  recordAuthFailure,
  verifyPassword,
  verifySessionToken,
} from "../../src/web/auth.js";

const SECRET = "s".repeat(48);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM auth_throttle");
});

describe("password hashing", () => {
  it("round-trips a password through the Workers runtime", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("defaults to an iteration count this runtime actually supports", async () => {
    const hash = await hashPassword("whatever");
    const parsed = parsePasswordHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.iterations).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS);
  });

  it("rejects a hash whose iteration count the runtime cannot verify", () => {
    // Regression guard: this exact shape deployed and 500'd on every login.
    expect(parsePasswordHash(`pbkdf2$sha256$210000$c2FsdA$aGFzaA`)).toBeNull();
  });

  it("surfaces an unusable hash as a blocking config problem, not a 500", () => {
    const result = loadConfig({
      DB: env.DB,
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "pbkdf2$sha256$210000$c2FsdA$aGFzaA",
    } as Env);
    expect(result.usable).toBe(false);
    const problem = result.problems.find((p) => p.key === "AUTH_PASSWORD_HASH");
    expect(problem?.blocking).toBe(true);
    expect(problem?.detail).toContain("100000");
  });

  it("rejects malformed hashes rather than throwing", async () => {
    for (const bad of ["", "nonsense", "pbkdf2$sha512$100000$a$b", "pbkdf2$sha256$10$a$b"]) {
      expect(parsePasswordHash(bad)).toBeNull();
      await expect(verifyPassword("x", bad)).resolves.toBe(false);
    }
  });
});

describe("sessions", () => {
  it("issues a token that verifies with the same secret", async () => {
    const token = await createSessionToken(SECRET);
    await expect(verifySessionToken(SECRET, token)).resolves.not.toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET);
    await expect(verifySessionToken("d".repeat(48), token)).resolves.toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken(SECRET);
    const [body, signature] = token.split(".");
    await expect(verifySessionToken(SECRET, `${body}x.${signature}`)).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken(SECRET, new Date(Date.now() - 40 * 24 * 3600 * 1000));
    await expect(verifySessionToken(SECRET, token)).resolves.toBeNull();
  });

  it("rejects a missing token", async () => {
    await expect(verifySessionToken(SECRET, null)).resolves.toBeNull();
  });
});

describe("CSRF", () => {
  it("accepts only the token derived from the same session", async () => {
    const good = await csrfTokenFor(SECRET, "session-a");
    await expect(csrfValid(SECRET, "session-a", good)).resolves.toBe(true);
    // A token minted for another session must not authorise this one.
    await expect(csrfValid(SECRET, "session-b", good)).resolves.toBe(false);
    await expect(csrfValid(SECRET, "session-a", null)).resolves.toBe(false);
    await expect(csrfValid(SECRET, "session-a", "forged")).resolves.toBe(false);
  });
});

describe("login throttling", () => {
  it("locks the account after repeated failures and reports a wait", async () => {
    const repo = new Repo(env.DB);
    const key = "throttle-key";
    for (let i = 0; i < 5; i += 1) await recordAuthFailure(repo, key);

    const verdict = await checkThrottle(repo, key);
    expect(verdict.locked).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.message).toMatch(/Too many failed sign-in attempts/);
  });

  it("does not lock before the threshold", async () => {
    const repo = new Repo(env.DB);
    await recordAuthFailure(repo, "few-failures");
    await expect(checkThrottle(repo, "few-failures")).resolves.toMatchObject({ locked: false });
  });

  it("stores a hashed key, never a raw address", async () => {
    const repo = new Repo(env.DB);
    await recordAuthFailure(repo, "hashed-key-value");
    const rows = await env.DB.prepare("SELECT key FROM auth_throttle").all<{ key: string }>();
    for (const row of rows.results ?? []) {
      expect(row.key).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});

describe("constant-time comparison", () => {
  it("compares equal and unequal values correctly", async () => {
    await expect(constantTimeEqual("abc", "abc")).resolves.toBe(true);
    await expect(constantTimeEqual("abc", "abd")).resolves.toBe(false);
    await expect(constantTimeEqual("abc", "abcd")).resolves.toBe(false);
    await expect(constantTimeEqual("", "")).resolves.toBe(true);
  });
});
