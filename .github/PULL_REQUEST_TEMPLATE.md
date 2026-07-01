## Cosa cambia questo PR

<!-- 1-3 frasi sul "cosa" del PR. -->

## Impatto privacy

<!-- OBBLIGATORIO se tocchi lo schema, gli endpoint o la validazione Zod.
     Regola d'oro: privacy-first + opt-in default OFF. Nessuna PII, nessun IP nel DB. -->

## Checklist autore

- [ ] `npm test` → tutti verdi (vitest + D1 in-memory)
- [ ] `npx tsc --noEmit` → 0 errori
- [ ] `npx wrangler deploy --dry-run` → OK (nessun cambio breaking al binding D1)
- [ ] Schema DB: se ho toccato `schema.sql`, ho aggiornato la migrazione o documentato il breaking change
- [ ] Se ho aggiunto un endpoint: la validazione Zod copre tutti i campi
- [ ] Se ho aggiunto un endpoint: il rate limiting è applicato

## Test manuali (opzionale)

<!-- `scripts/smoke.sh` (Linux/Mac) o `scripts/smoke.ps1` (Windows) contro il preview. -->
