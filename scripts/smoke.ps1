# Smoke test E2E del Worker community Verdict (versione PowerShell, no jq richiesto).
# Uso:  pwsh scripts/smoke.ps1
#       $env:VERDICT_ENDPOINT='https://my-worker.example.dev'; pwsh scripts/smoke.ps1
# Compatibile con Windows PowerShell 5.1+ e PowerShell Core.

$ErrorActionPreference = 'Continue'

$Endpoint = if ($env:VERDICT_ENDPOINT) { $env:VERDICT_ENDPOINT } else { 'https://verdict-community.gz6jk62yk8.workers.dev' }
$Rig = 'RIG-SMOK-TEST'
$NowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$script:Pass = 0
$script:Fail = 0

function Test-Pass($msg) { Write-Host "  PASS - $msg" -ForegroundColor Green; $script:Pass++ }
function Test-Fail($msg) { Write-Host "  FAIL - $msg" -ForegroundColor Red;   $script:Fail++ }

Write-Host "==> Smoke test verso $Endpoint`n"

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "Test 1/5: GET / (health check)"
try {
    $resp = Invoke-RestMethod -Uri "$Endpoint/" -Method Get -TimeoutSec 10
    if ($resp.service -eq 'verdict-community') {
        Test-Pass "service identifier corretto"
    } else {
        Test-Fail "atteso 'verdict-community', risposta: $($resp | ConvertTo-Json -Compress)"
    }
} catch {
    Test-Fail "errore di rete: $_"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nTest 2/5: POST /v1/evidence (primo inserimento)"
$body = @{
    records = @(@{
        rig_signature = $Rig
        rig_tier = 'EPICO'
        tweak_id = 'smoke-test-tweak'
        outcome = 'helped'
        delta_percent = 3.14
        captured_at_iso = $NowIso
    })
} | ConvertTo-Json -Depth 4
try {
    $resp = Invoke-RestMethod -Uri "$Endpoint/v1/evidence" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10
    if (($resp.accepted -eq 1 -and $resp.duplicate -eq 0) -or ($resp.accepted -eq 0 -and $resp.duplicate -eq 1)) {
        Test-Pass "primo POST OK (accepted=$($resp.accepted), duplicate=$($resp.duplicate))"
    } else {
        Test-Fail "risposta inattesa: $($resp | ConvertTo-Json -Compress)"
    }
} catch {
    Test-Fail "errore: $_"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nTest 3/5: POST identico (verifica idempotency)"
try {
    $resp = Invoke-RestMethod -Uri "$Endpoint/v1/evidence" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10
    if ($resp.accepted -eq 0 -and $resp.duplicate -eq 1) {
        Test-Pass "duplicate rilevato (accepted=0, duplicate=1)"
    } else {
        Test-Fail "duplicate non rilevato. Risposta: $($resp | ConvertTo-Json -Compress)"
    }
} catch {
    Test-Fail "errore: $_"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nTest 4/5: POST malformato (Zod validation rejection)"
$badBody = '{"records":[{"rig_signature":"INVALID","rig_tier":"NONESISTE","tweak_id":"x","outcome":"helped","captured_at_iso":"2026-06-29T00:00:00Z"}]}'
try {
    $resp = Invoke-WebRequest -Uri "$Endpoint/v1/evidence" -Method Post -Body $badBody -ContentType 'application/json' -TimeoutSec 10 -ErrorAction Stop
    Test-Fail "atteso HTTP 400, ricevuto $($resp.StatusCode)"
} catch {
    if ($_.Exception.Response.StatusCode.Value__ -eq 400) {
        Test-Pass "Zod ha rigettato lo schema invalido (HTTP 400)"
    } else {
        Test-Fail "atteso HTTP 400, ricevuto $($_.Exception.Response.StatusCode.Value__)"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nTest 5/5: GET /v1/stats per il tweak smoke (sample <10 → 0)"
try {
    $resp = Invoke-RestMethod -Uri "$Endpoint/v1/stats?tweak_id=smoke-test-tweak&rig_tier=EPICO" -Method Get -TimeoutSec 10
    if ($resp.sample_size -eq 0) {
        Test-Pass "stats vuote (sample <10, niente FPS finti - regola d'oro rispettata)"
    } elseif ($resp.sample_size -ge 10) {
        Test-Pass "stats popolate ($($resp.sample_size) sample)"
    } else {
        Test-Fail "risposta inattesa: $($resp | ConvertTo-Json -Compress)"
    }
} catch {
    Test-Fail "errore: $_"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`nBonus: GET /v1/top-tweaks (vetrina pubblica)"
try {
    $resp = Invoke-RestMethod -Uri "$Endpoint/v1/top-tweaks" -Method Get -TimeoutSec 10
    $count = if ($resp.top) { $resp.top.Count } else { 0 }
    Test-Pass "endpoint disponibile, $count entry nella leaderboard"
} catch {
    Test-Fail "errore: $_"
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Host "`n─────────────────────────────────────────"
Write-Host "Risultato: $script:Pass passati - $script:Fail falliti"
Write-Host "─────────────────────────────────────────"
exit $(if ($script:Fail -eq 0) { 0 } else { 1 })
