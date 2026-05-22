# start-mobile.ps1
# Starts ngrok tunnels for Zynloc mobile testing, then prints one URL to open on your phone.
# Run from the project root: .\start-mobile.ps1

$ErrorActionPreference = "Stop"
$RootDir = $PSScriptRoot

# ── 1. Check ngrok ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Checking ngrok..."
$ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue

if (-not $ngrokCmd) {
    Write-Host "ngrok not found. Installing via winget..."
    winget install ngrok.ngrok --accept-source-agreements --accept-package-agreements
    # Refresh PATH so the newly installed binary is visible
    $machinePath = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH    = "$machinePath;$userPath"
    $ngrokCmd    = Get-Command ngrok -ErrorAction SilentlyContinue
    if (-not $ngrokCmd) {
        Write-Error "ngrok install failed. Download it manually from https://ngrok.com/download and add it to PATH."
        exit 1
    }
}
Write-Host "  OK: $($ngrokCmd.Source)"

# ── 2. Kill any running ngrok ──────────────────────────────────────────────────
$existing = Get-Process ngrok -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing ngrok process..."
    $existing | Stop-Process -Force
    Start-Sleep -Seconds 1
}

# ── 3. Start ngrok with both tunnels ──────────────────────────────────────────
$ngrokConfig = Join-Path $RootDir "ngrok.yml"
Write-Host "Starting ngrok tunnels (api:4000, web:5173)..."
Start-Process ngrok -ArgumentList "start --all --config `"$ngrokConfig`"" -WindowStyle Hidden

# ── 4. Poll the ngrok agent API until both tunnels are up ─────────────────────
$webUrl = $null
$apiUrl = $null
$attempts = 0

Write-Host "Waiting for tunnels..."
while ((-not $webUrl -or -not $apiUrl) -and $attempts -lt 20) {
    Start-Sleep -Seconds 2
    $attempts++
    try {
        $data = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
        foreach ($t in $data.tunnels) {
            $addr = $t.config.addr
            $pub  = if ($t.public_url -match "^http:") { $t.public_url -replace "^http:", "https:" } else { $t.public_url }
            if ($addr -match ":5173") { $webUrl = $pub }
            if ($addr -match ":4000") { $apiUrl = $pub }
        }
    } catch {
        Write-Host "  Attempt $attempts / 20..."
    }
}

if (-not $webUrl -or -not $apiUrl) {
    Write-Host ""
    Write-Host "ERROR: Could not get tunnel URLs from ngrok." -ForegroundColor Red
    Write-Host ""
    Write-Host "Likely cause: missing authtoken. Fix:"
    Write-Host "  1. Sign up free at https://ngrok.com"
    Write-Host "  2. Run:  ngrok config add-authtoken YOUR_TOKEN"
    Write-Host "  3. Re-run this script."
    exit 1
}

Write-Host ""
Write-Host "  API tunnel: $apiUrl"
Write-Host "  Web tunnel: $webUrl"

# ── 5. Write apps/web/.env.local with VITE_API_URL ────────────────────────────
$webEnvLocal = Join-Path $RootDir "apps\web\.env.local"
Set-Content -Path $webEnvLocal -Value "VITE_API_URL=$apiUrl" -Encoding utf8
Write-Host "Written: apps/web/.env.local  (VITE_API_URL=$apiUrl)"

# ── 6. Patch CLIENT_URL in root .env ─────────────────────────────────────────
$envPath    = Join-Path $RootDir ".env"
$envContent = Get-Content $envPath -Raw

# Replace whatever CLIENT_URL is currently set to
if ($envContent -match "CLIENT_URL=") {
    $envContent = $envContent -replace "CLIENT_URL=.*(\r?\n|$)", "CLIENT_URL=http://localhost:5173,$webUrl`$1"
} else {
    $envContent += "`nCLIENT_URL=http://localhost:5173,$webUrl"
}

Set-Content -Path $envPath -Value $envContent -Encoding utf8
Write-Host "Updated:  .env  (CLIENT_URL now includes $webUrl)"

# ── 7. Summary ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host "  MOBILE TESTING READY" -ForegroundColor Cyan
Write-Host "======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Open this on your phone:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    $webUrl" -ForegroundColor Green
Write-Host ""
Write-Host "  Login: manager@zynloc.local / password123"
Write-Host ""
Write-Host "  ACTION REQUIRED: restart both dev servers so the"
Write-Host "  new env vars take effect:"
Write-Host ""
Write-Host "    Press Ctrl+C in the terminal running 'npm run dev'"
Write-Host "    then run:  npm run dev"
Write-Host ""
Write-Host "  ngrok inspector (debug requests): http://localhost:4040"
Write-Host ""
