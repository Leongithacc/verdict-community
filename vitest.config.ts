import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Carica wrangler.toml per i binding (D1 + RATE_LIMITER).
        // Per i test, il D1 viene simulato con uno storage locale isolato.
        wrangler: { configPath: "./wrangler.toml" },
        // Miniflare crea un D1 in-memory per ogni test run, applichiamo lo schema
        // all'avvio cosi le tabelle esistono prima dei test che ci interagiscono.
        miniflare: {
          d1Databases: {
            DB: ":memory:",
          },
        },
      },
    },
  },
});
