# verdict-community

Backend community per [Verdict](https://github.com/Leongithacc/Verdict) — Cloudflare Worker + D1.
Riceve esiti anonimi (`EvidenceRecord`) e ne espone statistiche aggregate per "ha aiutato
il X% dei rig simili". Privacy-first, opt-in lato client.

**Specifica completa**: `Verdict/docs/V7_REMOTE_BACKEND_DESIGN.md`.

## Deploy in 5 comandi

Prerequisito: account Cloudflare gratuito, `npm` installato.

```bash
# 0. Auth Cloudflare (una tantum):
npx wrangler login

# 1. Dipendenze:
npm install

# 2. Crea il database D1 remoto:
npm run db:create
# → output contiene "database_id = ...". Copialo nel wrangler.toml,
#   sostituendo "REPLACE_ME_WITH_OUTPUT_OF_npm_run_db_create".

# 3. Applica lo schema:
npm run db:schema

# 4. Deploy:
npm run deploy
# → restituisce https://verdict-community.<account>.workers.dev
```

Aggiorna poi `CommunityConfig.Endpoint` in
`WPEP/src/WPEP.Execution/Community.cs` con l'URL restituito, builda v1.1
seguendo `WPEP/docs/RELEASE_V1.1_RUNBOOK.md`.

## Smoke test post-deploy

```bash
URL="https://verdict-community.<account>.workers.dev"

# Health check
curl -s $URL/
# → {"service":"verdict-community","version":"0.1.0","docs":"..."}

# Submit di prova (record fake con rig_signature valida e tweak reale)
curl -s -X POST $URL/v1/evidence \
  -H 'Content-Type: application/json' \
  -d '{"records":[{
    "rig_signature":"RIG-ABCD-0123",
    "rig_tier":"EPICO",
    "tweak_id":"xmp-expo-enable",
    "outcome":"helped",
    "delta_percent":7.2,
    "captured_at_iso":"2026-06-28T20:14:00Z"
  }]}'
# → {"accepted":1,"duplicate":0}

# Re-submit identico (idempotency)
# → {"accepted":0,"duplicate":1}

# Query stats (≥10 sample servono per uscire non-vuoto)
curl -s "$URL/v1/stats?tweak_id=xmp-expo-enable&rig_tier=EPICO"
# → {"sample_size":0,...} se nessun aggregato (il cron gira di notte)

# Forza ricostruzione cache manualmente (1x), poi riprova lo stats:
npm run db:query "INSERT INTO stats_cache VALUES ('xmp-expo-enable','EPICO',12,75,20,5,datetime('now'))"
curl -s "$URL/v1/stats?tweak_id=xmp-expo-enable&rig_tier=EPICO"
# → {"sample_size":12,"helped_percent":75,"no_effect_percent":20,"hurt_percent":5}
```

## Dev locale

```bash
npm run db:schema-local    # schema su DB locale .wrangler/state/
npm run dev                # http://localhost:8787
```

## Comandi utili

```bash
# Tail dei log in produzione:
npm run tail

# Query SQL ad-hoc su D1 remoto:
npm run db:query "SELECT COUNT(*) FROM evidence"
npm run db:query "SELECT * FROM stats_cache LIMIT 10"
```

## Architettura

- `src/index.ts` — Worker single-file. 3 endpoint + 1 scheduled handler.
- `schema.sql` — 2 tabelle (evidence raw + stats_cache derivata).
- `wrangler.toml` — D1 binding + cron `0 3 * * *` + rate limit nativo.
- Niente framework router (uno switch su pathname basta).
- Validation con Zod (vedi `EvidenceRecordSchema` in `src/index.ts`).
- Cron ricostruisce `stats_cache` ogni notte alle 3:00 UTC + retention 365gg.

## Privacy

Vedi sez. 7 della spec. In sintesi: il Worker NON salva IP, User-Agent
o geo. Solo `rig_signature` (hash 8-char) + `rig_tier` (categoria) +
`tweak_id` + `outcome` + `delta_percent` + `captured_at`. L'app fa
opt-in esplicito (default OFF) prima di inviare qualunque cosa.

## License

Stessa di Verdict (MIT). Vedi repo principale.
