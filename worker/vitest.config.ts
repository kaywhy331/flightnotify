import { defineConfig } from "vitest/config";

// Domain-parity tests run in plain Node: they exercise pure functions plus
// WebCrypto, which Node 22 provides globally. D1/Worker integration tests use
// the workers pool in vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.js"],
    exclude: ["test/workers/**"],
  },
  resolve: {
    // Source uses .js specifiers (NodeNext-style) against .ts files.
    extensions: [".ts", ".js", ".json"],
  },
});
