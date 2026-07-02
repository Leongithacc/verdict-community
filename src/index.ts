// Backend community per Verdict — Cloudflare Worker.
// Endpoint:
//   POST /v1/evidence   → riceve batch di EvidenceRecord anonimi, idempotente per (rig_signature, tweak_id, captured_at)
//   GET  /v1/stats      → CommunityStats aggregati per (tweak_id, rig_tier), letti da stats_cache
//   GET  /v1/top-tweaks → vetrina pubblica: top-N tweak per sample_size
//   GET  /v1/health     → health check + verifica read-only DB (per uptime monitors esterni)
//   (scheduled cron)    → ricostruisce stats_cache ogni notte alle 3:00 UTC + retention 365gg
//
// Spec sorgente: WPEP/docs/V7_REMOTE_BACKEND_DESIGN.md

import { z } from "zod";

interface Env {
  DB: D1Database;
  RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
}

// ── Validazione Zod (anche sez. 9 del design doc) ────────────────────────────

const RigSignatureRe = /^RIG-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/;
const RigTierEnum = ["MITICO", "LEGGENDARIO", "EPICO", "RARO", "COMUNE"] as const;
const OutcomeEnum = ["helped", "no-effect", "hurt", "applied"] as const;

const EvidenceRecordSchema = z.object({
  rig_signature: z.string().regex(RigSignatureRe),
  rig_tier: z.enum(RigTierEnum),
  tweak_id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/i),
  outcome: z.enum(OutcomeEnum),
  delta_percent: z.number().min(-100).max(100).nullable().optional(),
  captured_at_iso: z.string().datetime(),
});

const SubmitBodySchema = z.object({
  records: z.array(EvidenceRecordSchema).min(1).max(100),
});

type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

// CORS su OGNI risposta, non solo sul preflight: community.html è servita da
// github.io e fa fetch cross-origin verso workers.dev — senza ACAO sulla GET
// il browser blocca la risposta e la leaderboard non carica mai.
// DECISIONE (audit F11.1): ACAO="*" anche su POST /v1/evidence. È deliberato e
// benigno: il CORS non impedisce l'invio della richiesta (solo la lettura della
// risposta cross-origin), e la submission è anonima per design + rate-limited.
// Restringere ACAO sul POST non aggiungerebbe sicurezza reale (il client WPF non
// usa CORS). API pubblica read-mostly → "*" è la scelta corretta e standard.
const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...(init.headers || {}),
    },
  });

const err = (status: number, message: string) => json({ error: message }, { status });

// Sample minimo per ESPORRE stats (rispetta la regola d'oro "niente FPS finti"):
// sotto i 10 sample, response 200 con sample_size: 0 invece di una stat fuorviante.
const MIN_SAMPLE_SIZE = 10;

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleSubmit(req: Request, env: Env): Promise<Response> {
  // Body size guard
  const text = await req.text();
  if (text.length > 100 * 1024) return err(413, "Body troppo grande (max 100 KB)");

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return err(400, "JSON malformato");
  }

  const parsed = SubmitBodySchema.safeParse(payload);
  if (!parsed.success) {
    return err(400, `Schema non valido: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  const { records } = parsed.data;

  // Rate limit per rig_signature: 60 req/min (binding in wrangler.toml).
  // LIMITE NOTO: la chiave è controllata dal client — chi ruota firme lo aggira.
  // La difesa per-IP non è esprimibile qui: va configurata come WAF rate-limiting
  // rule dal dashboard Cloudflare (Security > WAF). Questo è solo il 2° livello.
  // Tutti i record di una request devono avere la STESSA rig_signature — altrimenti
  // qualcuno sta tentando di mascherare il flood. Rifiuta in toto.
  const firstSig = records[0]!.rig_signature;
  if (records.some(r => r.rig_signature !== firstSig)) {
    return err(400, "Tutti i record devono avere la stessa rig_signature");
  }
  const rl = await env.RATE_LIMITER.limit({ key: `rig:${firstSig}` });
  if (!rl.success) return err(429, "Rate limit superato (max 60 req/min per rig)");

  // Insert idempotente. SQLite INSERT OR IGNORE conta come "duplicate" i conflitti
  // sulla PK (rig_signature, tweak_id, captured_at).
  let accepted = 0;
  let duplicate = 0;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO evidence
       (rig_signature, rig_tier, tweak_id, outcome, delta_percent, captured_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const batch = records.map((r: EvidenceRecord) =>
    stmt.bind(
      r.rig_signature,
      r.rig_tier,
      r.tweak_id,
      r.outcome,
      r.delta_percent ?? null,
      r.captured_at_iso,
    ),
  );
  const results = await env.DB.batch(batch);
  for (const res of results) {
    // D1 returns meta.changes = 0 quando IGNORE ha scartato per PK conflict
    const changed = res.meta?.changes ?? 0;
    if (changed > 0) accepted++; else duplicate++;
  }

  return json({ accepted, duplicate });
}

async function handleStats(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const tweakId = url.searchParams.get("tweak_id");
  const rigTier = url.searchParams.get("rig_tier");

  if (!tweakId || !/^[a-z0-9-]+$/i.test(tweakId) || tweakId.length > 120)
    return err(400, "tweak_id mancante o invalido");
  if (!rigTier || !RigTierEnum.includes(rigTier as typeof RigTierEnum[number]))
    return err(400, "rig_tier mancante o invalido");

  const row = await env.DB.prepare(
    `SELECT sample_size, helped_percent, no_effect_percent, hurt_percent
       FROM stats_cache
       WHERE tweak_id = ? AND rig_tier = ?`,
  )
    .bind(tweakId, rigTier)
    .first<{
      sample_size: number;
      helped_percent: number;
      no_effect_percent: number;
      hurt_percent: number;
    }>();

  const body =
    row && row.sample_size >= MIN_SAMPLE_SIZE
      ? row
      : { sample_size: 0, helped_percent: 0, no_effect_percent: 0, hurt_percent: 0 };

  return json(body, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function handleTopTweaks(req: Request, env: Env): Promise<Response> {
  // Vetrina pubblica: top-N tweak per sample_size (anti-PII: aggregati gia computati).
  // Default 10, max 50. Cache 1h CDN. Risponde anche quando dataset vuoto (array [].)
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = Math.max(1, Math.min(50, Number.parseInt(limitRaw || "10", 10) || 10));

  const rows = await env.DB.prepare(
    `SELECT tweak_id, rig_tier, sample_size, helped_percent, no_effect_percent, hurt_percent
       FROM stats_cache
       WHERE sample_size >= ?
       ORDER BY sample_size DESC
       LIMIT ?`,
  )
    .bind(MIN_SAMPLE_SIZE, limit)
    .all<{
      tweak_id: string;
      rig_tier: string;
      sample_size: number;
      helped_percent: number;
      no_effect_percent: number;
      hurt_percent: number;
    }>();

  return json(
    { top: rows.results ?? [] },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}

async function handleHealth(env: Env): Promise<Response> {
  // Health check con verifica read-only del DB (SELECT 1). Il servizio è UP
  // solo se anche D1 risponde. Utile per uptime monitors esterni (BetterUptime,
  // UptimeRobot, ecc.) senza esporre dati sensibili.
  const startedAt = new Date().toISOString();
  let dbReady = false;
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    dbReady = row?.ok === 1;
  } catch {
    dbReady = false;
  }
  return json(
    {
      status: dbReady ? "ok" : "degraded",
      service: "verdict-community",
      version: "0.1.0",
      db: dbReady ? "ready" : "unreachable",
      timestamp: startedAt,
    },
    {
      status: dbReady ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

// ── Cron: ricostruisce stats_cache + retention ───────────────────────────────

async function rebuildStatsCacheAndPrune(env: Env): Promise<void> {
  // Retention: butta evidence vecchie >365gg (privacy + storage). Prima
  // dell'aggregazione così le righe scadute non finiscono nelle percentuali.
  await env.DB.prepare(
    `DELETE FROM evidence WHERE received_at < datetime('now','-365 days')`,
  ).run();

  // Aggrega: per ogni (tweak_id, rig_tier) calcola % di helped/no-effect/hurt
  // (gli 'applied' sono fuori dal calcolo: misurano "chi ci ha provato" non l'esito).
  // DELETE + INSERT in UN batch = transazione implicita D1: senza, una fetch
  // tra i due statement (o un crash del secondo) vedrebbe stats_cache vuota
  // fino al cron successivo (fino a 24h di leaderboard vuota). Atomico.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM stats_cache`),
    env.DB.prepare(
      `INSERT INTO stats_cache
         (tweak_id, rig_tier, sample_size, helped_percent, no_effect_percent, hurt_percent, computed_at)
       SELECT
         tweak_id,
         rig_tier,
         SUM(CASE WHEN outcome IN ('helped','no-effect','hurt') THEN 1 ELSE 0 END) AS sample,
         CAST(ROUND(100.0 * SUM(CASE WHEN outcome='helped' THEN 1 ELSE 0 END)
                    / NULLIF(SUM(CASE WHEN outcome IN ('helped','no-effect','hurt') THEN 1 ELSE 0 END), 0)) AS INTEGER),
         CAST(ROUND(100.0 * SUM(CASE WHEN outcome='no-effect' THEN 1 ELSE 0 END)
                    / NULLIF(SUM(CASE WHEN outcome IN ('helped','no-effect','hurt') THEN 1 ELSE 0 END), 0)) AS INTEGER),
         CAST(ROUND(100.0 * SUM(CASE WHEN outcome='hurt' THEN 1 ELSE 0 END)
                    / NULLIF(SUM(CASE WHEN outcome IN ('helped','no-effect','hurt') THEN 1 ELSE 0 END), 0)) AS INTEGER),
         datetime('now')
       FROM evidence
       GROUP BY tweak_id, rig_tier
       HAVING sample > 0`,
    ),
  ]);
}

// ── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight (la GUI WPF non lo fa mai, ma una eventuale dashboard web sì)
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/evidence")
      return handleSubmit(req, env);
    if (req.method === "GET" && url.pathname === "/v1/stats")
      return handleStats(req, env);
    if (req.method === "GET" && url.pathname === "/v1/top-tweaks")
      return handleTopTweaks(req, env);
    if (req.method === "GET" && url.pathname === "/v1/health")
      return handleHealth(env);
    if (req.method === "GET" && url.pathname === "/")
      return json({
        service: "verdict-community",
        version: "0.1.0",
        docs: "https://github.com/Leongithacc/Verdict/blob/main/docs/V7_REMOTE_BACKEND_DESIGN.md",
      });

    return err(404, "Endpoint sconosciuto");
  },

  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(rebuildStatsCacheAndPrune(env));
  },
};
