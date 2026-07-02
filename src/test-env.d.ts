// Tipi per l'`env` dei test: pool-workers 0.17 tipizza `env` come
// `Cloudflare.Env` (namespace globale). Qui dichiariamo i binding reali:
// D1 dal wrangler.toml + TEST_SCHEMA_SQL iniettato da vitest.config.mts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_SCHEMA_SQL: string;
  }
}
