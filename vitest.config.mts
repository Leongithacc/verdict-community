import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// schema.sql va letto QUI (contesto Node): dentro workerd node:fs non esiste,
// quindi lo passiamo ai test come binding di testo (TEST_SCHEMA_SQL).
// File .mts perche' pool-workers 0.17 e' ESM-only (require() lo rifiuta).
const schemaSql = readFileSync(new URL("schema.sql", import.meta.url), "utf8");

// API vitest 4 / pool-workers 0.17: le opzioni workers passano dal plugin
// cloudflareTest() invece che da test.poolOptions.workers.
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Carica wrangler.toml per i binding (D1 + RATE_LIMITER).
      // Per i test, il D1 viene simulato con uno storage locale isolato.
      wrangler: { configPath: "./wrangler.toml" },
      // Miniflare crea un D1 in-memory per ogni test run, applichiamo lo schema
      // all'avvio cosi le tabelle esistono prima dei test che ci interagiscono.
      miniflare: {
        d1Databases: {
          DB: ":memory:",
        },
        bindings: {
          TEST_SCHEMA_SQL: schemaSql,
        },
      },
    }),
  ],
});
