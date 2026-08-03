import { applyD1Migrations, env } from "cloudflare:test";

// Every test file starts from the committed migrations, which doubles as proof
// that they initialise an empty database reproducibly.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
