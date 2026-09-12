param(
  [int]$Port = 9222,
  [string]$ExtensionId = "hblimlciefcijbjlhpopkhcmedgecpli",
  [string]$CookieFile = "",
  [string]$ProfileDirectory = "",
  [switch]$RestartEdge
)

$ErrorActionPreference = "Stop"

# The iCloud session does not always live in `Default`; honour the same
# EDGE_PROFILE override the Python fallback reads so both paths agree.
if (-not $ProfileDirectory) {
  $ProfileDirectory = if ($env:EDGE_PROFILE) { $env:EDGE_PROFILE } else { "Default" }
}

if (-not $CookieFile) {
  $CookieFile = Join-Path (Split-Path -Parent $PSScriptRoot) "runtime\cookies.txt"
}

function Get-EdgePath {
  $candidates = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw "msedge.exe not found"
}

function Get-CdpTargets {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 3
  } catch {
    return $null
  }
}

function Ensure-EdgeCdp {
  $version = $null
  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  } catch {
    $version = $null
  }
  if ($version -and ($version.Browser -match "Edg/")) { return $version }

  if (-not $RestartEdge) {
    # Restarting Edge closes every open tab, so the server never gets to decide
    # that for the operator — spell out the one command that fixes this instead.
    $edgePath = try { Get-EdgePath } catch { "msedge.exe" }
    throw ("Edge CDP is not open on port {0}. Close Edge and relaunch it with remote debugging: " +
      '"{1}" --remote-debugging-port={0} --remote-allow-origins=* --profile-directory="{2}"' +
      " (or re-run this script with -RestartEdge, which force-closes Edge first).") -f $Port, $edgePath, $ProfileDirectory
  }

  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $edge = Get-EdgePath
  Start-Process -FilePath $edge -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--profile-directory=$ProfileDirectory",
    "edge://extensions/?id=$ExtensionId"
  )
  Start-Sleep -Seconds 4
  $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
  if (-not ($version.Browser -match "Edg/")) {
    throw "Port $Port is not Edge CDP: $($version.Browser)"
  }
  return $version
}

function Send-Cdp($ws, [int]$id, [string]$method, $params) {
  $obj = @{ id = $id; method = $method }
  if ($null -ne $params) { $obj.params = $params }
  $json = $obj | ConvertTo-Json -Depth 30 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $segment = [ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
}

function Receive-Cdp($ws) {
  $stream = New-Object IO.MemoryStream
  $buffer = New-Object byte[] 131072
  do {
    $segment = [ArraySegment[byte]]::new($buffer)
    $result = $ws.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($result.Count -gt 0) { $stream.Write($buffer, 0, $result.Count) }
  } while (-not $result.EndOfMessage)
  [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
}

function Invoke-Cdp($wsUrl, [string]$expression, [switch]$AwaitPromise) {
  $ws = [Net.WebSockets.ClientWebSocket]::new()
  try {
    $ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    Send-Cdp $ws 1 "Runtime.enable" $null
    while ($true) {
      $message = Receive-Cdp $ws
      if ($message.id -eq 1) { break }
    }
    $params = @{
      expression = $expression
      returnByValue = $true
      awaitPromise = [bool]$AwaitPromise
    }
    Send-Cdp $ws 2 "Runtime.evaluate" $params
    while ($true) {
      $message = Receive-Cdp $ws
      if ($message.id -eq 2) {
        if ($message.result.exceptionDetails) {
          throw ($message.result.exceptionDetails.text)
        }
        return $message.result.result.value
      }
    }
  } finally {
    $ws.Dispose()
  }
}

function Get-ExtensionPage {
  $targets = Get-CdpTargets
  $page = $targets | Where-Object { $_.url -like "edge://extensions/*" } | Select-Object -First 1
  if ($page) { return $page }

  Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$Port/json/new?edge://extensions/?id=$ExtensionId" -TimeoutSec 3 | Out-Null
  Start-Sleep -Seconds 2
  $targets = Get-CdpTargets
  $page = $targets | Where-Object { $_.url -like "edge://extensions/*" } | Select-Object -First 1
  if (-not $page) { throw "No edge://extensions target found" }
  return $page
}

function Get-BridgeWorker {
  $targets = Get-CdpTargets
  $worker = $targets | Where-Object { $_.url -eq "chrome-extension://$ExtensionId/background.js" } | Select-Object -First 1
  if (-not $worker) { throw "No iCloud Cookie Bridge service worker found after reload" }
  return $worker
}

$version = Ensure-EdgeCdp
$extensionPage = Get-ExtensionPage

$reloadExpression = @"
(async () => {
  const id = '$ExtensionId';
  await new Promise((resolve, reject) => chrome.developerPrivate.reload(id, () => {
    const error = chrome.runtime.lastError && chrome.runtime.lastError.message;
    error ? reject(new Error(error)) : resolve();
  }));
  return { reload: 'ok' };
})()
"@
$reload = Invoke-Cdp $extensionPage.webSocketDebuggerUrl $reloadExpression -AwaitPromise
Start-Sleep -Seconds 3

$worker = Get-BridgeWorker
$syncExpression = @"
(async () => {
  const cookies = await collectAppleCookies();
  const status = await syncCookies();
  return {
    cookieCount: cookies.length,
    names: cookies.map(item => item.name).sort(),
    status
  };
})()
"@
$sync = Invoke-Cdp $worker.webSocketDebuggerUrl $syncExpression -AwaitPromise

$cookieInfo = $null
if (Test-Path -LiteralPath $CookieFile) {
  $file = Get-Item -LiteralPath $CookieFile
  $content = Get-Content -LiteralPath $CookieFile -Raw
  $cookieInfo = [ordered]@{
    fullName = $file.FullName
    length = $file.Length
    lastWriteTime = $file.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    hasSessionToken = [bool]($content -match [regex]::Escape("X-APPLE-DS-WEB-SESSION-TOKEN"))
    hasWebauthToken = [bool]($content -match [regex]::Escape("X-APPLE-WEBAUTH-TOKEN"))
    hasMailPcs = [bool]($content -match [regex]::Escape("X-APPLE-WEBAUTH-PCS-Mail"))
    hasLogin = [bool]($content -match [regex]::Escape("X-APPLE-WEBAUTH-LOGIN"))
  }
}

[ordered]@{
  ok = [bool]($sync.status.ok -and $cookieInfo.hasSessionToken -and $cookieInfo.hasWebauthToken -and $cookieInfo.hasMailPcs)
  edge = $version.Browser
  port = $Port
  extensionId = $ExtensionId
  reload = $reload
  sync = $sync
  cookieFile = $cookieInfo
} | ConvertTo-Json -Depth 20
