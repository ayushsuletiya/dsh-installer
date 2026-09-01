<#
dsh-setup - re-run parts of the DSH one-click setup after the first install.

    dsh-setup reconfigure [-Secrets <file>]   re-render settings + profile + preset
    dsh-setup repatch                         re-apply the model-picker patches
    dsh-setup qwen                            (re)install and relaunch the Qwen app
    dsh-setup bridge [start|stop|status]      control the Qwen bridge
    dsh-setup doctor                          report what is wired and what is not
    dsh-setup update                          pull a newer payload, then reconfigure

`reconfigure` is the one to reach for after a `dsh` upgrade or when adding an API
key: the same idempotent path the installer takes, minus the Node/DSH bootstrap.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1)][string]$Action = '',
  [string]$Secrets = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Here      = Split-Path -Parent $PSCommandPath
$UserHome  = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DshHome   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $UserHome '.dsh' }
$BridgeDir = if ($env:QWEN_BRIDGE_DIR) { $env:QWEN_BRIDGE_DIR } else { Join-Path $UserHome 'qwen-bridge' }
$ProfileDir= Join-Path $DshHome 'profiles\web'
$TaskName  = 'DSH Qwen Bridge'

function Ok($t)   { Write-Host '+ ' -ForegroundColor Green -NoNewline;  Write-Host $t }
function Bad($t)  { Write-Host 'x ' -ForegroundColor Red -NoNewline;    Write-Host $t }
function Warn($t) { Write-Host '! ' -ForegroundColor Yellow -NoNewline; Write-Host $t }
function Info($t) { Write-Host "  $t" }
function Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan }
function Usage    { Get-Help -Full $PSCommandPath | Out-String | Write-Host }

function Test-Http($url, $timeout = 3) {
  try { Invoke-WebRequest -Uri $url -TimeoutSec $timeout -UseBasicParsing | Out-Null; return $true }
  catch { return $false }
}

switch ($Command.ToLowerInvariant()) {

  'reconfigure' {
    # Not $args — that is an automatic variable in PowerShell.
    $installArgs = @('-SkipQwen', '-SkipProfileInstall')
    if ($Secrets) { $installArgs += @('-Secrets', $Secrets) }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'install.ps1') @installArgs
    exit $LASTEXITCODE
  }

  'repatch' {
    & node (Join-Path $Here 'tools\patch-model-selector.mjs')
    exit $LASTEXITCODE
  }

  'qwen' {
    & node (Join-Path $Here 'tools\install-qwen-app.mjs')
    exit $LASTEXITCODE
  }

  'bridge' {
    $what = if ($Action) { $Action.ToLowerInvariant() } else { 'status' }
    switch ($what) {
      'start' {
        try {
          Start-ScheduledTask -TaskName $TaskName
          Ok 'Scheduled Task started'
        } catch {
          $runPs1 = Join-Path $BridgeDir 'run.ps1'
          Start-Process powershell -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$runPs1) -WindowStyle Hidden
          Ok 'bridge started detached'
        }
      }
      'stop' {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine -match 'server-app\.mjs' } |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Ok 'bridge stopped'
      }
      'status' {
        if (Test-Http 'http://127.0.0.1:3083/health') { Ok 'bridge healthy on 127.0.0.1:3083' }
        else { Bad 'bridge not answering on 127.0.0.1:3083'; Info "log: $BridgeDir\bridge.log" }
      }
      default { Usage; exit 2 }
    }
  }

  'doctor' {
    Write-Host 'DSH setup report' -ForegroundColor White

    Head 'runtime'
    foreach ($c in @('node','pnpm','dsh')) {
      $cmd = Get-Command $c -ErrorAction SilentlyContinue
      if ($cmd) {
        $v = try { (& $c --version 2>$null) } catch { '' }
        if (-not $v -and $c -eq 'node') { $v = (& node -v) }
        Ok ("{0} {1}" -f $c, $v)
      } else {
        if ($c -eq 'pnpm') { Warn "$c missing" } else { Bad "$c missing" }
      }
    }

    Head 'config'
    foreach ($f in @('settings.yaml','.credentials.yaml','.env')) {
      if (Test-Path -LiteralPath (Join-Path $DshHome $f)) { Ok $f } else { Bad "$f missing" }
    }
    $settings = Join-Path $DshHome 'settings.yaml'
    if (Test-Path -LiteralPath $settings) {
      $text = Get-Content -LiteralPath $settings -Raw
      $providers = ([regex]::Matches($text, '(?m)^    [a-z0-9-]+:$')).Count
      Info "$providers provider blocks"
      if ($text -match 'opencode') { Warn 'opencode still referenced - run: dsh-setup reconfigure' }
      else { Ok 'opencode absent' }
    }

    Head 'credentials'
    $credFile = Join-Path $DshHome '.credentials.yaml'
    if (Test-Path -LiteralPath $credFile) {
      foreach ($line in (Get-Content -LiteralPath $credFile)) {
        if ($line -match "^\s+([A-Z0-9_]+):\s*(.*)$") {
          $key = $Matches[1]; $val = $Matches[2].Trim().Trim("'")
          if ($val) { Ok $key } else { Warn "$key blank" }
        }
      }
    }

    Head 'profile'
    $patch = Join-Path $ProfileDir 'cordis.patch.yml'
    if (Test-Path -LiteralPath $patch) {
      $ptext = Get-Content -LiteralPath $patch -Raw
      Ok ("cordis.patch.yml ({0} rows)" -f ([regex]::Matches($ptext, 'name: ')).Count)
      foreach ($m in [regex]::Matches($ptext, 'serverName: ([a-z_]+)')) { Info ("mcp: " + $m.Groups[1].Value) }
    } else { Bad 'cordis.patch.yml missing' }
    $missingPlugins = @()
    foreach ($f in @('compaction-llm-retry.mjs','web-search-ddg.mjs','llm-turn-fallback.mjs','qwen-coder.mjs','command-clear.mjs')) {
      if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir $f))) { $missingPlugins += $f }
    }
    if ($missingPlugins.Count -eq 0) { Ok '5 local plugins present' }
    else { foreach ($f in $missingPlugins) { Bad "$f missing" } }
    if (Test-Path -LiteralPath (Join-Path $ProfileDir 'node_modules')) { Ok 'plugin bundles installed' }
    else { Warn 'bundles not installed - run: dsh plugin --profile web install' }

    Head 'preset'
    $preset = Join-Path $DshHome '.agent-presets\opus-qwen\agent.cordis.yml'
    if (Test-Path -LiteralPath $preset) {
      # The preset names its two local plugins by absolute path, so the check that
      # matters is whether those paths point at THIS machine's profile directory.
      $ptxt = Get-Content -LiteralPath $preset -Raw
      $expected = ($ProfileDir -replace '\\', '/')
      if ($ptxt -match [regex]::Escape($expected)) { Ok 'opus-qwen preset' }
      else { Bad 'preset points at another machine - run: dsh-setup reconfigure' }
    } else { Bad 'opus-qwen preset missing' }

    Head 'model picker'
    $root = try { (& npm root -g 2>$null) } catch { '' }
    if ($root) {
      $sel = Join-Path $root '@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-model-selection\lib\client.js'
      if (Test-Path -LiteralPath $sel) {
        $n = ([regex]::Matches((Get-Content -LiteralPath $sel -Raw), 'local patch')).Count
        if ($n -eq 2) { Ok 'search + collapsible groups' }
        elseif ($n -eq 0) { Warn 'unpatched - run: dsh-setup repatch' }
        else { Warn "$n/2 patches present - run: dsh-setup repatch" }
      } else { Warn 'model-selection bundle not found' }
    }

    Head 'qwen'
    # Guarded: these env vars only exist on Windows, and Join-Path throws on null.
    $exe = @(
      $env:LOCALAPPDATA, $env:ProgramFiles
    ) | Where-Object { $_ } | ForEach-Object {
      if ($_ -eq $env:LOCALAPPDATA) { Join-Path $_ 'Programs\Qwen\Qwen.exe' } else { Join-Path $_ 'Qwen\Qwen.exe' }
    } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($exe) { Ok "desktop app installed ($exe)" } else { Warn 'desktop app missing - run: dsh-setup qwen' }
    if (Test-Http 'http://127.0.0.1:3083/health') { Ok 'bridge healthy on :3083' }
    else { Warn 'bridge down - run: dsh-setup bridge start' }
    if (Test-Http 'http://127.0.0.1:9222/json/version') { Ok 'app exposing CDP on :9222' }
    else { Warn 'no CDP on :9222 - the bridge relaunches the app on the next request' }
    try {
      $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      Ok ("logon task registered (state: {0})" -f $t.State)
    } catch { Warn 'logon Scheduled Task not registered' }
  }

  'update' {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Bad 'git required'; exit 1 }
    if (Test-Path -LiteralPath (Join-Path $Here '.git')) {
      Push-Location $Here
      try { & git pull --ff-only; Ok 'payload updated' } finally { Pop-Location }
    } else {
      Warn "payload at $Here is not a git clone; re-run install.ps1 from the repo"
      exit 1
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'install.ps1') -SkipQwen
    exit $LASTEXITCODE
  }

  default { Usage; if ($Command) { exit 2 } }
}
