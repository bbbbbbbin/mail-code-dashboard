param(
  [switch]$Hidden,
  [ValidateRange(1, 65535)]
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $PSScriptRoot
$apiKeyFile = Join-Path $project "runtime\api-key.txt"
$dashboardUrl = "http://127.0.0.1:$Port/"
$env:HOST = "127.0.0.1"
$env:PORT = [string]$Port

$listeners = @(
  Get-NetTCPConnection `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue
)
if ($listeners.Count -gt 0) {
  $unsafeListeners = @(
    $listeners | Where-Object { $_.LocalAddress -ne "127.0.0.1" }
  )
  if ($unsafeListeners.Count -gt 0) {
    throw "Port $Port has a non-loopback listener; refusing to continue."
  }
  Write-Output "ALREADY_RUNNING PID=$($listeners[0].OwningProcess) URL=$dashboardUrl API_KEY_FILE=$apiKeyFile"
  exit 0
}

Write-Output "URL=$dashboardUrl API_KEY_FILE=$apiKeyFile"

if ($Hidden) {
  $logDir = Join-Path $project "logs"
  $stdout = Join-Path $logDir "server.out.log"
  $stderr = Join-Path $logDir "server.err.log"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $process = Start-Process `
    -FilePath "node" `
    -ArgumentList "server.mjs" `
    -WorkingDirectory $project `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    $listeners = @(
      Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue
    )
    if ($listeners.Count -gt 0) {
      break
    }
  }
  if ($listeners.Count -eq 0) {
    throw "Dashboard failed to start. Check $stderr"
  }
  if (@($listeners | Where-Object { $_.LocalAddress -ne "127.0.0.1" }).Count -gt 0) {
    throw "Dashboard started on a non-loopback address."
  }
  Write-Output "STARTED PID=$($process.Id) URL=$dashboardUrl API_KEY_FILE=$apiKeyFile"
} else {
  Push-Location $project
  try {
    & node "server.mjs"
    if ($LASTEXITCODE -ne 0) {
      throw "Dashboard exited with code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}
