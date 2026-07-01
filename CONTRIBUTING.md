# Contributing to verdict-community

Il backend community di [Verdict](https://github.com/Leongithacc/Verdict).

## Regola d'oro (non negoziabile)

**Privacy-first, opt-in default OFF lato client.**

Nessun PR è accettato se:
- aggiunge PII al DB (IP, User-Agent, geo, nome utente, email, path locali, ecc.)
- riduce l'anonimato dei record (es. correla `rig_signature` con account esterni)
- cambia il default client da "OFF" a "ON" senza un consenso esplicito equivalente
- accende endpoint tracker esterni (analytics, telemetry di terze parti)

Vedi la privacy policy formale in
[Verdict/docs/PRIVACY.md](https://github.com/Leongithacc/Verdict/blob/main/docs/PRIVACY.md).

## Setup dev locale

```bash
npm install
npm run db:schema-local   # crea DB SQLite in .wrangler/state/
npm run dev               # http://localhost:8787
npm test                  # unit test (vitest + D1 in-memory)
```

Richiede Node 20+ e wrangler (installato tramite `npm ci`).

## Aggiungere un endpoint

1. Aggiungi lo switch `case '/v1/xxx':` in `src/index.ts`.
2. Se accetta body, definisci uno schema Zod dedicato (segui `EvidenceRecordSchema` come pattern).
3. Se legge/scrive D1, aggiungi una migration SQL in `schema.sql` (o un file separato).
4. Aggiungi test in `src/index.test.ts` con almeno: happy path, Zod validation errors, rate limiting.
5. Aggiorna la lista endpoint in `README.md`.

## Aggiungere una migrazione DB

Il DB è versionato via `schema.sql` (singolo file, idempotente). Per una migrazione:

1. Aggiungi le nuove statement in `schema.sql` (usa `CREATE TABLE IF NOT EXISTS`,
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, ecc.).
2. Testa in locale: `npm run db:schema-local && npm test`.
3. Sul remoto (dopo il merge): `npm run db:schema`.

## Test

- `npm test` — un colpo, output CI-friendly
- `npm run test:watch` — modalità watch
- `npm run smoke` — smoke E2E contro il Worker LIVE (bash)
- `pwsh scripts/smoke.ps1` — smoke E2E contro il Worker LIVE (PowerShell)

## PR workflow

1. Fork → branch → PR contro `main`.
2. CI (GitHub Actions) esegue: `npm ci`, `tsc --noEmit`, `npm test`, `wrangler deploy --dry-run`.
3. Il template PR chiede: impatto privacy, checklist test, cambi schema.

## Rilasci

Il Worker viene rilasciato manualmente:

```bash
npx wrangler deploy
```

Non c'è un versionamento formale (SemVer) per ora: il backend è considerato
"stateful evolution" — nuovi campi backward-compatible, nessun breaking di
endpoint pubblici senza deprecation window.
