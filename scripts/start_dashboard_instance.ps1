param(
  [Parameter(Mandatory = $true)]
  [string]$InstanceDir,
  [ValidateRange(1, 65535)]
  [int]$Port = 4173,
  [string]$ForwardConfig,
  [string]$LabelSequenceFile,
  [switch]$Hidden
)

$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $PSScriptRoot
$instance = [System.IO.Path]::GetFullPath($InstanceDir)
$backups = Join-Path $instance "backups"
$logs = Join-Path $instance "logs"

New-Item -ItemType Directory -Force -Path $instance | Out-Null
New-Item -ItemType Directory -Force -Path $backups | Out-Null
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if ([string]::IsNullOrWhiteSpace($ForwardConfig)) {
  $ForwardConfig = Join-Path $instance "mail-forward.config.json"
} else {
  $ForwardConfig = [System.IO.Path]::GetFullPath($ForwardConfig)
}

if ([string]::IsNullOrWhiteSpace($LabelSequenceFile)) {
  $LabelSequenceFile = Join-Path $instance "icloud-label-sequence.json"
} else {
  $LabelSequenceFile = [System.IO.Path]::GetFullPath($LabelSequenceFile)
}

$env:HOST = "127.0.0.1"
$env:PORT = [string]$Port
$env:HME_COOKIE_FILE = Join-Path $instance "cookies.txt"
$env:HME_COOKIE_REFRESH_MODE = "extension"
$env:MAIL_DASHBOARD_STATE_PATH = Join-Path $instance "dashboard-state-v1.json"
$env:MAIL_DASHBOARD_BACKUP_DIR = $backups
$env:MAIL_DASHBOARD_API_KEY_FILE = Join-Path $instance "api-key.txt"
$env:HME_LABEL_SEQUENCE_FILE = $LabelSequenceFile
$env:MAIL_FORWARD_CONFIG = $ForwardConfig
$env:MAIL_LIFECYCLE_LOG_PATH = Join-Path $logs "server-lifecycle.log"

# Each instance owns its key file. An inherited environment key would make two
# otherwise isolated instances share credentials, so do not let it win.
Remove-Item Env:MAIL_DASHBOARD_API_KEY -ErrorAction SilentlyContinue

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
  Write-Output "ALREADY_RUNNING PID=$($listeners[0].OwningProcess) URL=http://127.0.0.1:$Port/ INSTANCE_DIR=$instance API_KEY_FILE=$env:MAIL_DASHBOARD_API_KEY_FILE"
  exit 0
}

Write-Output "URL=http://127.0.0.1:$Port/ INSTANCE_DIR=$instance API_KEY_FILE=$env:MAIL_DASHBOARD_API_KEY_FILE"

if (-not $Hidden) {
  Push-Location $project
  try {
    & node "server.mjs"
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "Dashboard exited with code $exitCode"
  }
  exit 0
}

$stdout = Join-Path $logs "server.out.log"
$stderr = Join-Path $logs "server.err.log"
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
  $portReady = Test-NetConnection `
    -ComputerName "127.0.0.1" `
    -Port $Port `
    -InformationLevel Quiet `
    -WarningAction SilentlyContinue
  if ($portReady) {
    break
  }
}

if (-not $portReady) {
  throw "Dashboard failed to start. Check $stderr"
}

Write-Output "STARTED PID=$($process.Id) URL=http://127.0.0.1:$Port/ INSTANCE_DIR=$instance API_KEY_FILE=$env:MAIL_DASHBOARD_API_KEY_FILE"
