// Tipi per l'`env` dei test: pool-workers 0.17 tipizza `env` come
// `Cloudflare.Env` (namespace globale). Qui dichiariamo i binding reali:
// D1 + rate limiter dal wrangler.toml + TEST_SCHEMA_SQL iniettato da
// vitest.config.mts. Deve combaciare con l'interfaccia Env di src/index.ts
// così l'env di test è passabile a worker.scheduled()/fetch() nei test.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
    TEST_SCHEMA_SQL: string;
  }
}
