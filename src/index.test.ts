import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";

// Applica lo schema D1 prima di TUTTI i test (il D1 di test e in-memory
// e parte vuoto; senza schema le INSERT esplodono con "no such table").
// schema.sql arriva dal binding TEST_SCHEMA_SQL (letto in vitest.config.ts,
// contesto Node): node:fs non esiste dentro workerd.
beforeAll(async () => {
  const schema = env.TEST_SCHEMA_SQL;
  // exec() di D1 tratta OGNI RIGA come statement → serve: via i commenti '--'
  // (anche quelli inline a fine riga), split su ';', collasso su riga singola.
  const statements = schema
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(s => s.length > 0);
  for (const stmt of statements) {
    await env.DB.exec(stmt);
  }
});

const validRecord = (overrides: Record<string, unknown> = {}) => ({
  rig_signature: "RIG-AB12-CD34",
  rig_tier: "EPICO",
  tweak_id: "xmp-expo-enable",
  outcome: "helped",
  delta_percent: 7.2,
  captured_at_iso: "2026-06-29T12:00:00Z",
  ...overrides,
});

describe("Health check", () => {
  it("GET / returns service identifier", async () => {
    const resp = await SELF.fetch("https://worker/");
    expect(resp.status).toBe(200);
    const json = await resp.json() as { service: string; version: string };
    expect(json.service).toBe("verdict-community");
    expect(json.version).toBeTruthy();
  });

  it("unknown endpoint returns 404", async () => {
    const resp = await SELF.fetch("https://worker/v1/nope");
    expect(resp.status).toBe(404);
  });

  it("GET /v1/health reports service + DB status", async () => {
    const resp = await SELF.fetch("https://worker/v1/health");
    expect(resp.status).toBe(200);
    const json = await resp.json() as {
      status: string;
      service: string;
      db: string;
      timestamp: string;
    };
    expect(json.status).toBe("ok");
    expect(json.service).toBe("verdict-community");
    expect(json.db).toBe("ready");
    expect(json.timestamp).toBeTruthy();
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /v1/evidence — Zod validation", () => {
  it("rejects malformed rig_signature", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ rig_signature: "not-a-rig" })] }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects invalid rig_tier", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ rig_tier: "NONESISTE" })] }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects invalid outcome enum", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ outcome: "amazing" })] }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects delta_percent out of [-100, 100]", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ delta_percent: 999 })] }),
    });
    expect(resp.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(resp.status).toBe(400);
  });

  it("rejects mixed rig_signature in same batch (anti-flood)", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [
          validRecord({ rig_signature: "RIG-AAAA-1111" }),
          validRecord({ rig_signature: "RIG-BBBB-2222" }),
        ],
      }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("POST /v1/evidence — happy path + idempotency", () => {
  it("accepts a valid record", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ rig_signature: "RIG-TST1-AAAA" })] }),
    });
    expect(resp.status).toBe(200);
    const json = await resp.json() as { accepted: number; duplicate: number };
    expect(json.accepted).toBe(1);
    expect(json.duplicate).toBe(0);
  });

  it("idempotency: same record twice → second is duplicate", async () => {
    const record = validRecord({ rig_signature: "RIG-TST2-BBBB" });
    // First
    let resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [record] }),
    });
    expect(resp.status).toBe(200);
    // Second
    resp = await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [record] }),
    });
    const json = await resp.json() as { accepted: number; duplicate: number };
    expect(json.accepted).toBe(0);
    expect(json.duplicate).toBe(1);
  });
});

describe("GET /v1/stats — sample threshold", () => {
  it("returns empty stats when sample < 10 (no fake percentages)", async () => {
    // Inseriamo 1 solo record per il tweak: sample_size=1 → sotto soglia → 0.
    await SELF.fetch("https://worker/v1/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [validRecord({ rig_signature: "RIG-STAT-LOWS", tweak_id: "stats-low-sample" })] }),
    });
    // Forziamo populate diretto della stats_cache simulando il cron con sample basso.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO stats_cache VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind("stats-low-sample", "EPICO", 5, 80, 10, 10).run();

    const resp = await SELF.fetch("https://worker/v1/stats?tweak_id=stats-low-sample&rig_tier=EPICO");
    expect(resp.status).toBe(200);
    const json = await resp.json() as { sample_size: number; helped_percent: number };
    expect(json.sample_size).toBe(0);
  });

  it("returns real stats when sample >= 10", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO stats_cache VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind("stats-high-sample", "EPICO", 42, 73, 22, 5).run();

    const resp = await SELF.fetch("https://worker/v1/stats?tweak_id=stats-high-sample&rig_tier=EPICO");
    const json = await resp.json() as { sample_size: number; helped_percent: number };
    expect(json.sample_size).toBe(42);
    expect(json.helped_percent).toBe(73);
  });

  it("rejects missing query params", async () => {
    const resp = await SELF.fetch("https://worker/v1/stats");
    expect(resp.status).toBe(400);
  });

  it("rejects invalid rig_tier", async () => {
    const resp = await SELF.fetch("https://worker/v1/stats?tweak_id=foo&rig_tier=FANTASMA");
    expect(resp.status).toBe(400);
  });
});

describe("CORS", () => {
  it("GET responses carry Access-Control-Allow-Origin (github.io -> workers.dev)", async () => {
    const resp = await SELF.fetch("https://worker/v1/top-tweaks");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("error responses carry it too", async () => {
    const resp = await SELF.fetch("https://worker/v1/nope");
    expect(resp.status).toBe(404);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("OPTIONS preflight still answers with CORS headers", async () => {
    const resp = await SELF.fetch("https://worker/v1/evidence", { method: "OPTIONS" });
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("GET /v1/top-tweaks", () => {
  it("returns an array (possibly empty) with cache header", async () => {
    const resp = await SELF.fetch("https://worker/v1/top-tweaks");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Cache-Control")).toContain("max-age");
    const json = await resp.json() as { top: unknown[] };
    expect(Array.isArray(json.top)).toBe(true);
  });

  it("respects limit param", async () => {
    const resp = await SELF.fetch("https://worker/v1/top-tweaks?limit=5");
    expect(resp.status).toBe(200);
    const json = await resp.json() as { top: unknown[] };
    expect(json.top.length).toBeLessThanOrEqual(5);
  });
});
