// `cloudflare:test` types `env` as `Cloudflare.Env`, so the test-only binding is
// declared by augmenting that namespace. Deliberately not a module (no import
// or export at top level), otherwise the augmentation would be file-scoped.
declare namespace Cloudflare {
  interface Env {
    /** Committed D1 migrations, injected by vitest.workers.config.ts. */
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
