import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Integration tests run inside workerd against a real (local) D1, so lease and
// deduplication behaviour is exercised through actual SQL semantics rather than
// a mock that would happily agree with a wrong assumption.
//
// Passing the committed migrations through a binding means every run also
// proves they initialise an empty database reproducibly.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2026-08-01",
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/workers/**/*.test.ts"],
      setupFiles: ["./test/workers/setup.ts"],
    },
  };
});
