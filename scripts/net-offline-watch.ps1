# net-offline-watch.ps1 -- shut the machine down when it has been offline for too long.
#
# WHY: this box runs qq-bridge 24/7. When the network drops, the bot is useless but the
# machine keeps drawing power until someone notices. This watcher powers it off after a
# long, CONFIRMED outage.
#
# DESIGN RULES (all of them exist because a false shutdown is expensive):
#   * Multi-target vote. A single unreachable host is NOT offline evidence: measured here,
#     180.76.76.76:53 fails on TCP while ICMP to it succeeds. Requiring >= MinOnlineVotes
#     successes avoids that class of false positive.
#   * TCP, not ICMP/HTTP. The probe uses raw TCP connects (node:net) so it needs no PATH
#     lookup and no third-party binary. This machine's PATH is stripped: ping.exe,
#     curl.exe and shutdown.exe are NOT resolvable by bare name.
#   * Long threshold + grace window. Default 15 min offline before arming, then a 120 s
#     cancellation window during which a returning network aborts the shutdown.
#   * DRY RUN IS THE DEFAULT. It only logs what it would do. Pass -Live to actually arm.
#   * Single instance. Two watchers could fight over shutdown scheduling.
#   * Never resumes/starts anything: after a power-off the autostart tasks bring the stack
#     back on the next boot.
#
# ASCII ONLY, NO BOM. PowerShell 5.1 reads a BOM-less .ps1 as system ANSI (GBK on this
# box) and mangles non-ASCII, which earlier broke a script with a bogus syntax error.
#
# Usage:
#   powershell -NoProfile -File net-offline-watch.ps1                 # dry run (default)
#   powershell -NoProfile -File net-offline-watch.ps1 -Once           # single check, print, exit
#   powershell -NoProfile -File net-offline-watch.ps1 -Live           # actually may shut down
#   powershell -NoProfile -File net-offline-watch.ps1 -Cancel         # abort a pending shutdown
#   powershell -NoProfile -File net-offline-watch.ps1 -Live -OfflineSec 600 -GraceSec 60
#   powershell -NoProfile -File net-offline-watch.ps1 -Live -Config <path>

[CmdletBinding()]
param(
  [switch]$Live,
  [switch]$Once,
  [switch]$Cancel,
  [switch]$Status,
  [int]$OfflineSec = 900,
  [int]$GraceSec = 120,
  [int]$IntervalSec = 30,
  [int]$MinOnlineVotes = 2,
  [string]$Config = '',
  # test-only: comma list of UP/OFF/ERR verdicts to replay through the real loop
  [string]$TestPlan = '',
  # test-only: real seconds to wait between replayed steps. The arming condition compares
  # wall-clock timestamps, so a plan that runs instantly can never cross the threshold --
  # this is what makes the arm path testable without waiting minutes.
  [int]$TestStepDelaySec = 0
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # ...\qq-bridge
$StateDir = Join-Path $Root 'state'
$LogFile = Join-Path $StateDir 'net-watch.log'
$PidFile = Join-Path $StateDir 'net-watch.pid'
$ConfigFile = if ($Config) { $Config } else { Join-Path $Root 'config-net-watch.json' }
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$ShutdownExe = Join-Path $env:SystemRoot 'System32\shutdown.exe'

# ---- optional JSON config (CLI switches win) -------------------------------------------
if (Test-Path $ConfigFile) {
  try {
    $c = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($c.offlineSec)    { if (-not $PSBoundParameters.ContainsKey('OfflineSec'))    { $OfflineSec = [int]$c.offlineSec } }
    if ($c.graceSec)      { if (-not $PSBoundParameters.ContainsKey('GraceSec'))      { $GraceSec = [int]$c.graceSec } }
    if ($c.intervalSec)   { if (-not $PSBoundParameters.ContainsKey('IntervalSec'))    { $IntervalSec = [int]$c.intervalSec } }
    if ($c.minOnlineVotes){ if (-not $PSBoundParameters.ContainsKey('MinOnlineVotes')) { $MinOnlineVotes = [int]$c.minOnlineVotes } }
    if ($c.logFile)       { $LogFile = [string]$c.logFile }
  } catch {
    Write-Host "[net-watch] config parse failed, using defaults: $($_.Exception.Message)"
  }
}

function Say($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host "[net-watch] $msg"
  try {
    $dir = Split-Path -Parent $LogFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  } catch { }
}

# ---- probe (node: raw TCP to well-known DNS:53) -----------------------------------------
# Targets are public resolvers. We only need a TCP handshake, so no query is sent.
$ProbeScript = @'
const targets = [
  ["223.5.5.5", 53],       // AliDNS
  ["119.29.29.29", 53],    // DNSPod
  ["1.1.1.1", 53],         // Cloudflare
  ["8.8.8.8", 53]          // Google
];
const timeoutMs = Number(process.argv[2] || 3000);
const probe = (host, port) => new Promise((resolve) => {
  const started = Date.now();
  let settled = false;
  const done = (ok) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve({ host, ok, ms: Date.now() - started }); };
  const sock = require('node:net').connect({ host, port });
  sock.setTimeout(timeoutMs);
  sock.on("connect", () => done(true));
  sock.on("timeout", () => done(false));
  sock.on("error", () => done(false));
});
(async () => {
  const results = await Promise.all(targets.map(([h, p]) => probe(h, p)));
  process.stdout.write(JSON.stringify(results));
})();
'@

function Invoke-Probe {
  $tmp = Join-Path $env:TEMP ("netwatch-probe-" + [guid]::NewGuid().ToString('N') + ".cjs")
  try {
    # write as UTF8 WITHOUT BOM so node can parse it
    [IO.File]::WriteAllText($tmp, $ProbeScript, (New-Object Text.UTF8Encoding($false)))
    $raw = & $NodeExe $tmp 3000 2>$null
    if (-not $raw) { return $null }
    return ($raw | Out-String).Trim() | ConvertFrom-Json
  } catch {
    return $null
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Get-Verdict {
  # Normal path: a real probe reads the network. The decision fields (online/votes/detail)
  # are exactly the same ones a test supplies when it injects -MockPlan, so the loop below
  # under test is the same code that runs in production.
  $res = Invoke-Probe
  if ($null -eq $res) { return @{ online = $null; votes = 0; detail = 'probe-failed' } }
  $ok = @($res | Where-Object { $_.ok })
  return @{
    online = ($ok.Count -ge $MinOnlineVotes)
    votes  = $ok.Count
    detail = (($res | ForEach-Object { "$($_.host)=$(if($_.ok){'up'}else{'down'})" }) -join ' ')
  }
}

# ---- test harness: deterministic state-machine test -------------------------------------
# Exercises the REAL loop with an injected offline/online plan, so the arming / cancelling /
# dry-run logic is verified without touching the actual network or the real shutdown.
if ($TestPlan) {
  $script:MockVerdicts = @()
  foreach ($flag in ([string]$TestPlan).Split(',')) {
    $f = $flag.Trim().ToUpperInvariant()
    if ($f -eq 'OFF')  { $script:MockVerdicts += ,@{ online = $false; votes = 0; detail = 'mock=offline' } }
    elseif ($f -eq 'UP') { $script:MockVerdicts += ,@{ online = $true;  votes = 4; detail = 'mock=online' } }
    elseif ($f -eq 'ERR') { $script:MockVerdicts += ,@{ online = $null;  votes = 0; detail = 'mock=probe-error' } }
    else { Write-Host "[net-watch-test] unknown plan token '$f' (use UP/OFF/ERR)"; exit 2 }
  }
  $script:MockIdx = 0
  # Rebind Get-Verdict to a function that consumes the plan (one verdict per loop iteration).
  function Get-Verdict { } # placeholder overwritten below via Set-Item on the function
  Set-Item -Path function:Get-Verdict -Value {
    if ($script:MockIdx -ge $script:MockVerdicts.Count) {
      $v = $script:MockVerdicts[$script:MockVerdicts.Count - 1]
    } else {
      $v = $script:MockVerdicts[$script:MockIdx]
      $script:MockIdx++
    }
    return $v
  }
  # Never touch the real shutdown in test mode: replace the exe path with a recorder.
  $script:ShutdownCalls = @()
  $ShutdownExe = Join-Path $env:TEMP 'net-watch-test-shutdown.cmd'
  [IO.File]::WriteAllText($ShutdownExe, "@echo off`r`necho CALLED %* >> `"$env:TEMP\net-watch-test-calls.txt`"`r`n", (New-Object Text.ASCIIEncoding))
  Remove-Item -LiteralPath "$env:TEMP\net-watch-test-calls.txt" -Force -ErrorAction SilentlyContinue
}

# ---- single instance -------------------------------------------------------------------
if (-not $Once -and -not $Cancel -and -not $Status) {
  if (Test-Path $PidFile) {
    $old = 0
    [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue), [ref]$old) | Out-Null
    if ($old -gt 0 -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
      Say "another watcher is already running (pid=$old); exiting"
      exit 3
    }
  }
  Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII
}

# ---- cancel / status shortcuts ---------------------------------------------------------
if ($Cancel) {
  if (Test-Path $ShutdownExe) {
    $out = & $ShutdownExe /a 2>&1
    Say "cancel requested: $($out -join ' ')"
  }
  exit 0
}

if ($Status) {
  $v = Get-Verdict
  $on = if ($v.online -eq $null) { 'unknown' } elseif ($v.online) { 'ONLINE' } else { 'OFFLINE' }
  Say "status: $on (votes=$($v.votes)/$MinOnlineVotes) $($v.detail)"
  exit 0
}

if ($Once) {
  $v = Get-Verdict
  $on = if ($v.online -eq $null) { 'unknown' } elseif ($v.online) { 'ONLINE' } else { 'OFFLINE' }
  Say "once: $on votes=$($v.votes)/$MinOnlineVotes | $($v.detail)"
  Say "once: would $(if ($Live) { 'be able to shut down' } else { 'only log (dry run)' }) after ${OfflineSec}s offline"
  exit 0
}

# ---- main loop -------------------------------------------------------------------------
# The loop body is a function so the test harness can drive it with injected verdicts and
# return instead of blocking. Production calls it forever with the real probe.
$script:OfflineSince = $null
$script:ArmedAt = $null

function Invoke-WatchStep {
  $v = Get-Verdict
  $now = Get-Date

  if ($v.online -eq $null) {
    # Probe machinery itself failed -- never treat that as an outage (that would shut the
    # machine down for a node crash rather than a network problem).
    Say "probe error; treating as online (fail-open)"
    $script:OfflineSince = $null; $script:ArmedAt = $null
    return 'probe-error'
  }

  if ($v.online) {
    if ($script:OfflineSince) {
      $mins = [math]::Round(($now - $script:OfflineSince).TotalMinutes, 1)
      Say "network back after $mins min offline; timers reset"
      if ($script:ArmedAt) {
        $out = & $ShutdownExe /a 2>&1
        Say "aborted pending shutdown: $($out -join ' ')"
      }
    }
    $script:OfflineSince = $null; $script:ArmedAt = $null
    return 'online'
  }

  # offline branch
  if (-not $script:OfflineSince) { $script:OfflineSince = $now }
  $offlineDur = ($now - $script:OfflineSince).TotalSeconds
  Say "OFFLINE votes=$($v.votes)/$MinOnlineVotes for $([math]::Round($offlineDur))s | $($v.detail)"

  if ($offlineDur -ge $OfflineSec -and -not $script:ArmedAt) {
    if (-not $Live) {
      Say "DRY RUN: offline >= ${OfflineSec}s, would shut down now (pass -Live to arm)"
    } else {
      try {
        $out = & $ShutdownExe /s /t $GraceSec /d p:0:0 /c "net-watch: offline >= ${OfflineSec}s" 2>&1
        $script:ArmedAt = $now
        Say "ARMED shutdown: /s /t $GraceSec (cancel with 'shutdown /a' within ${GraceSec}s) :: $($out -join ' ')"
      } catch {
        Say "shutdown arm FAILED: $($_.Exception.Message)"
      }
    }
  }

  # during the grace window keep checking; a returning network cancels above
  if ($script:ArmedAt) {
    $left = [math]::Round($GraceSec - ($now - $script:ArmedAt).TotalSeconds)
    if ($left -gt 0) { Say "shutdown in ~${left}s unless network returns" }
  }
  return 'offline'
}

Say "watcher starting (pid=$PID) live=$Live offlineSec=$OfflineSec graceSec=$GraceSec intervalSec=$IntervalSec minVotes=$MinOnlineVotes log=$LogFile"
if (-not (Test-Path $ShutdownExe)) { Say "FATAL: $ShutdownExe not found; refusing to run"; exit 4 }

# Drop the pid file on a clean exit. A hard kill (including the power-off this script
# requests) leaves it behind, which is fine: the single-instance check also verifies the
# recorded pid is still alive, so a stale file never blocks a fresh start.
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -Action {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
} | Out-Null

# In test mode every step still writes the real log, but sleeps are skipped so the whole
# plan replays in a second instead of minutes.
if ($TestPlan) {
  $n = $script:MockVerdicts.Count
  $results = @()
  for ($i = 0; $i -lt $n; $i++) {
    $results += (Invoke-WatchStep)
    if ($TestStepDelaySec -gt 0 -and $i -lt ($n - 1)) { Start-Sleep -Seconds $TestStepDelaySec }
  }
  Say "TEST PLAN DONE steps=$n results=$($results -join ',')"
  $calls = if (Test-Path "$env:TEMP\net-watch-test-calls.txt") { Get-Content -LiteralPath "$env:TEMP\net-watch-test-calls.txt" } else { @() }
  Say "TEST shutdown invocations: $(@($calls).Count)"
  foreach ($c in @($calls)) { Say "TEST   $c" }
  Remove-Item -LiteralPath $ShutdownExe -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$env:TEMP\net-watch-test-calls.txt" -Force -ErrorAction SilentlyContinue
  exit 0
}

while ($true) {
  Invoke-WatchStep | Out-Null
  Start-Sleep -Seconds $IntervalSec
}