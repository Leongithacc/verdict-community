#!/usr/bin/env bash
# Smoke test E2E del Worker community Verdict.
# Uso:  bash scripts/smoke.sh
#       VERDICT_ENDPOINT=https://my-worker.example.dev bash scripts/smoke.sh
# Richiede: curl, jq (per parsing JSON pulito).

set -uo pipefail

ENDPOINT="${VERDICT_ENDPOINT:-https://verdict-community.gz6jk62yk8.workers.dev}"
RIG="RIG-SMOK-TEST"   # deterministic per idempotency check
NOW_ISO="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
PASS=0
FAIL=0

pass() { echo "  PASS - $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL - $1"; FAIL=$((FAIL+1)); }

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq non installato. Su Windows installa via 'winget install jqlang.jq'."
    exit 2
  fi
}

echo "==> Smoke test verso $ENDPOINT"
echo
require_jq

# ──────────────────────────────────────────────────────────────────────────────
echo "Test 1/5: GET / (health check)"
RESP=$(curl -s "$ENDPOINT/")
SVC=$(echo "$RESP" | jq -r '.service // empty')
if [ "$SVC" = "verdict-community" ]; then
  pass "service identifier corretto"
else
  fail "atteso 'verdict-community', risposta: $RESP"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "Test 2/5: POST /v1/evidence (primo inserimento)"
BODY=$(cat <<EOF
{"records":[{
  "rig_signature":"$RIG",
  "rig_tier":"EPICO",
  "tweak_id":"smoke-test-tweak",
  "outcome":"helped",
  "delta_percent":3.14,
  "captured_at_iso":"$NOW_ISO"
}]}
EOF
)
RESP=$(curl -s -X POST "$ENDPOINT/v1/evidence" -H 'Content-Type: application/json' -d "$BODY")
ACC=$(echo "$RESP" | jq -r '.accepted // -1')
DUP=$(echo "$RESP" | jq -r '.duplicate // -1')
# Primo invio: accettato=1 (nuovo) OPPURE accettato=0+duplicate=1 (smoke girato prima → idempotency).
if [ "$ACC" = "1" ] && [ "$DUP" = "0" ]; then
  pass "record nuovo accettato (accepted=1, duplicate=0)"
elif [ "$ACC" = "0" ] && [ "$DUP" = "1" ]; then
  pass "record già presente da smoke precedente (accepted=0, duplicate=1) — idempotency OK"
else
  fail "risposta inattesa: $RESP"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "Test 3/5: POST identico (verifica idempotency)"
RESP=$(curl -s -X POST "$ENDPOINT/v1/evidence" -H 'Content-Type: application/json' -d "$BODY")
ACC=$(echo "$RESP" | jq -r '.accepted // -1')
DUP=$(echo "$RESP" | jq -r '.duplicate // -1')
if [ "$ACC" = "0" ] && [ "$DUP" = "1" ]; then
  pass "duplicate rilevato correttamente (accepted=0, duplicate=1)"
else
  fail "duplicate non rilevato. Risposta: $RESP"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "Test 4/5: POST malformato (Zod validation rejection)"
BAD_BODY='{"records":[{"rig_signature":"INVALID","rig_tier":"NONESISTE","tweak_id":"x","outcome":"helped","captured_at_iso":"2026-06-29T00:00:00Z"}]}'
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ENDPOINT/v1/evidence" -H 'Content-Type: application/json' -d "$BAD_BODY")
if [ "$HTTP_CODE" = "400" ]; then
  pass "Zod ha rigettato lo schema invalido (HTTP 400)"
else
  fail "atteso HTTP 400, ricevuto $HTTP_CODE"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "Test 5/5: GET /v1/stats per il tweak smoke (sample <10 → 0)"
RESP=$(curl -s "$ENDPOINT/v1/stats?tweak_id=smoke-test-tweak&rig_tier=EPICO")
SAMPLE=$(echo "$RESP" | jq -r '.sample_size // -1')
if [ "$SAMPLE" = "0" ]; then
  pass "stats vuote (sample <10, niente FPS finti — regola d'oro rispettata)"
elif [ "$SAMPLE" -ge "10" ]; then
  pass "stats popolate ($SAMPLE sample) — qualcuno ha già spammato lo smoke tweak"
else
  fail "risposta inattesa: $RESP"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "Bonus: GET /v1/top-tweaks (vetrina pubblica)"
RESP=$(curl -s "$ENDPOINT/v1/top-tweaks")
TOP_LEN=$(echo "$RESP" | jq -r '.top | length')
if [ "$TOP_LEN" -ge "0" ] 2>/dev/null; then
  pass "endpoint disponibile, $TOP_LEN entry nella leaderboard"
else
  fail "risposta inattesa: $RESP"
fi

# ──────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────"
echo "Risultato: $PASS passati · $FAIL falliti"
echo "─────────────────────────────────────────"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
