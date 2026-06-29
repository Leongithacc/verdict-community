-- Schema D1 per il backend community di Verdict.
-- Riferimento: WPEP/docs/V7_REMOTE_BACKEND_DESIGN.md sezione 6.
-- Applicare con:  npm run db:schema   (remote)  oppure  npm run db:schema-local

-- Raw evidence, append-only entro retention 365 giorni.
CREATE TABLE IF NOT EXISTS evidence (
  rig_signature  TEXT NOT NULL,
  rig_tier       TEXT NOT NULL,
  tweak_id       TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('helped','no-effect','hurt','applied')),
  delta_percent  REAL,
  captured_at    TEXT NOT NULL,    -- ISO 8601
  received_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rig_signature, tweak_id, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_evidence_tweak_tier ON evidence(tweak_id, rig_tier);
CREATE INDEX IF NOT EXISTS idx_evidence_received   ON evidence(received_at);

-- Aggregate cache, ricostruito ogni notte dal cron (alle 3:00 UTC).
-- Query API: GET /v1/stats legge SOLO da qui (latenza <50ms anche con milioni di evidence).
CREATE TABLE IF NOT EXISTS stats_cache (
  tweak_id            TEXT NOT NULL,
  rig_tier            TEXT NOT NULL,
  sample_size         INTEGER NOT NULL,
  helped_percent      INTEGER NOT NULL,
  no_effect_percent   INTEGER NOT NULL,
  hurt_percent        INTEGER NOT NULL,
  computed_at         TEXT NOT NULL,
  PRIMARY KEY (tweak_id, rig_tier)
);
