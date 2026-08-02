#!/usr/bin/env node
/**
 * Generate an AUTH_PASSWORD_HASH value.
 *
 * PBKDF2-SHA256 through WebCrypto, matching worker/src/web/auth.ts exactly.
 * The hash is printed; the password never leaves this process and is read from
 * stdin so it does not land in shell history.
 *
 *   node scripts/hash-password.mjs
 *   npx wrangler secret put AUTH_PASSWORD_HASH
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ITERATIONS = 210_000;

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question("Password (input is visible): ");
rl.close();

if (password.length < 12) {
  console.error("\nRefusing: use at least 12 characters. This guards a public HTTPS endpoint.");
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
  "deriveBits",
]);
const derived = new Uint8Array(
  await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256),
);

console.log(`\npbkdf2$sha256$${ITERATIONS}$${b64url(salt)}$${b64url(derived)}`);
