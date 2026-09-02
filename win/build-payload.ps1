# Build the Windows harness payload — ON Windows, so the artifact and the test
# machine are the same OS. This is the whole point: the container existed because
# nothing here was ever tested on Windows, and a CI runner fixes that without
# making every user install Docker.
#
#   pwsh -File win/build-payload.ps1 -Version 3.0.0
#
# Output: dist/DeepSeekHarness-win-x64-<version>.zip  plus its sha256.
#
# Everything decidable at build time is decided here: the Node runtime, the pinned
# dsh, all plugin bundles, the local plugins, the model-picker patch. First run on
# a user's machine only fetches that machine's credentials and starts serving.
[CmdletBinding()]
param(
  [string]$DshVersion  = '0.1.1-rc.2',
  [string]$NodeVersion = '24.14.1',
  [string]$Version     = 'dev',
  [string]$OutDir      = 'dist',
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stage    = Join-Path $RepoRoot "$OutDir\DeepSeekHarness"
$Runtime  = Join-Path $Stage 'runtime\node'
$App      = Join-Path $Stage 'app'
$Baked    = Join-Path $Stage 'baked'
$Inst     = Join-Path $Stage 'installer'

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   + $t" -ForegroundColor Green }
function Note($t) { Write-Host "   . $t" -ForegroundColor DarkGray }

# A native command's stderr must never be treated as failure: Windows PowerShell
# turns a redirected stderr line into a terminating error under 'Stop', and npm,
# pnpm and git all write progress there. Only the exit code decides.
function Run {
  param([string]$Exe, [string[]]$Arguments, [string]$Cwd = $null, [int[]]$Allow = @(0))
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    # if/else rather than a ternary: this script has to survive being run by
    # Windows PowerShell 5.1, where `? :` is a parse error.
    if ($Cwd) { Push-Location $Cwd } else { Push-Location (Get-Location).Path }
    & $Exe @Arguments 2>&1 | ForEach-Object { Note $_ }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($Allow -notcontains $code) { throw "$Exe exited $code" }
    return $code
  } finally {
    Pop-Location
    $ErrorActionPreference = $old
  }
}

Step "clean $Stage"
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage, $App, $Baked | Out-Null
Ok 'staging tree created'

# ── 1. the Node runtime, shipped rather than required ────────────────────────
Step "Node $NodeVersion (win-x64)"
$nodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
if (-not (Test-Path -LiteralPath $nodeZip)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" `
    -OutFile $nodeZip -UseBasicParsing
}
$tmpNode = Join-Path $env:TEMP "node-unzip-$PID"
if (Test-Path -LiteralPath $tmpNode) { Remove-Item -LiteralPath $tmpNode -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($nodeZip, $tmpNode)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Runtime) | Out-Null
Move-Item -LiteralPath (Join-Path $tmpNode "node-v$NodeVersion-win-x64") -Destination $Runtime
Remove-Item -LiteralPath $tmpNode -Recurse -Force -ErrorAction SilentlyContinue

$NodeExe = Join-Path $Runtime 'node.exe'
$NpmCli  = Join-Path $Runtime 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "node.exe missing at $NodeExe" }
Ok ((& $NodeExe --version) + ' bundled')

# ── 2. the harness itself ────────────────────────────────────────────────────
# Installed with the BUNDLED node, so every optional native package (sharp, koffi,
# node-pty, lightningcss) is resolved for the runtime that will actually run it —
# not for whatever Node the CI image happens to have.
Step "@deepseek-ai/dsh@$DshVersion"
'{ "name": "dsh-app", "private": true, "version": "0.0.0" }' |
  Set-Content -LiteralPath (Join-Path $App 'package.json') -Encoding UTF8
Run $NodeExe @($NpmCli, 'install', "@deepseek-ai/dsh@$DshVersion", '--no-audit', '--no-fund', '--loglevel', 'warn') $App

$DshEntry = Join-Path $App 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path -LiteralPath $DshEntry)) {
  # StrictMode makes a missing property fatal, so the bin field is read defensively:
  # it has moved between releases and this fallback is the reason a move is survivable.
  $pkg = Get-Content -Raw (Join-Path $App 'node_modules\@deepseek-ai\dsh\package.json') | ConvertFrom-Json
  $bin = $pkg.PSObject.Properties['bin']
  $rel = $null
  if ($bin) {
    if ($bin.Value -is [string]) { $rel = $bin.Value }
    elseif ($bin.Value.PSObject.Properties['dsh']) { $rel = $bin.Value.dsh }
  }
  if ($rel) { $DshEntry = Join-Path (Join-Path $App 'node_modules\@deepseek-ai\dsh') $rel }
}
if (-not (Test-Path -LiteralPath $DshEntry)) { throw 'could not find the dsh entry script' }
Ok ((& $NodeExe $DshEntry --version) -join ' ')

# ── 3. installer payload + bootstrap ────────────────────────────────────────
Step 'payload and tools'
New-Item -ItemType Directory -Force -Path $Inst | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot 'payload') -Destination (Join-Path $Inst 'payload') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'tools')   -Destination (Join-Path $Inst 'tools')   -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bootstrap.mjs') -Destination (Join-Path $Stage 'bootstrap.mjs') -Force
"$Version`n" | Set-Content -LiteralPath (Join-Path $Stage 'version.txt') -Encoding UTF8 -NoNewline
Ok 'payload, tools, bootstrap.mjs, version.txt'

# ── 4. the baked profile ────────────────────────────────────────────────────
# The slow step, done once here instead of on every machine. Built under
# <stage>\baked so a user's data directory never shadows it and an update can
# replace it wholesale.
Step 'compose the web profile'
$env:DSH_HOME = $Baked
Run $NodeExe @($DshEntry, '--profile', 'web', '--dump-default-config') $Stage @(0, 1)

$ProfileWeb = Join-Path $Baked 'profiles\web'
New-Item -ItemType Directory -Force -Path $ProfileWeb | Out-Null
$src = Join-Path $Inst 'payload\profile-web'
Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $ProfileWeb -Force
foreach ($f in @(
  'compaction-llm-retry.mjs', 'web-search-ddg.mjs', 'llm-turn-fallback.mjs',
  'qwen-coder.mjs', 'command-clear.mjs'
)) {
  Copy-Item -LiteralPath (Join-Path $src $f) -Destination $ProfileWeb -Force
}
$workspace = Join-Path $ProfileWeb 'pnpm-workspace.yaml'
if (Test-Path -LiteralPath $workspace) {
  Run $NodeExe @((Join-Path $Inst 'tools\pnpm-allow-builds.mjs'), $workspace) $Stage
  Ok 'pnpm build allowances applied'
}

# A shippable tree must not contain symlinks. pnpm's default layout is a store of
# symlinks into node_modules/.pnpm, and this tree gets zipped, moved and unzipped on
# someone else's machine: a zip writer either follows those links and duplicates the
# store, or preserves them and lands paths that resolve nowhere. Hoisted linking
# produces one flat, real node_modules - which also keeps paths far away from
# Windows' 260-character limit.
@(
  '# Shipped as a zip, so no symlinks and no store indirection.'
  'node-linker=hoisted'
  'symlink=false'
) | Set-Content -LiteralPath (Join-Path $ProfileWeb '.npmrc') -Encoding UTF8
Ok 'pnpm set to hoisted linking (no symlinks in the shipped tree)'
Ok 'profile files in place'

Step 'install plugin bundles (slow)'
Run 'corepack' @('enable', 'pnpm') $Stage @(0, 1)
Run $NodeExe @($DshEntry, 'plugin', '--profile', 'web', 'install') $ProfileWeb
$bundles = (Get-ChildItem -LiteralPath (Join-Path $ProfileWeb 'node_modules') -Directory -ErrorAction SilentlyContinue).Count
Ok "$bundles packages under the profile"

Step 'model-picker patch'
# Exit 4 means "this dsh is not the version the patch was cut for" — the picker
# still works, so it is not a build failure.
Run $NodeExe @(
  (Join-Path $Inst 'tools\patch-model-selector.mjs'),
  '--dsh-root', (Join-Path $App 'node_modules\@deepseek-ai\dsh')
) $Stage @(0, 4)

# ── 5. prove it serves, here, before anyone downloads it ────────────────────
if (-not $SkipSmokeTest) {
  Step 'smoke test: does the UI actually serve?'
  $testHome = Join-Path $env:TEMP "dsh-smoke-$PID"
  New-Item -ItemType Directory -Force -Path $testHome | Out-Null
  $env:DSH_HOME = Join-Path $testHome '.dsh'
  $env:DSH_NO_QWEN_BRIDGE = '1'
  Remove-Item Env:\DSH_DIST_BASE, Env:\DSH_DIST_TOKEN -ErrorAction SilentlyContinue

  # Configure with NO credentials at all: that is the worst case a real machine can
  # present, and it must still boot.
  Run $NodeExe @((Join-Path $Stage 'bootstrap.mjs'), '--configure-only') $Stage
  Ok 'configured with zero credentials'

  $serve = Start-Process -FilePath $NodeExe `
    -ArgumentList @((Join-Path $Stage 'bootstrap.mjs'), '--no-supervise') `
    -WorkingDirectory $Stage -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $testHome 'serve.out.log') `
    -RedirectStandardError  (Join-Path $testHome 'serve.err.log')
  try {
    # verify-web walks every plugin bundle the browser would fetch and then checks
    # the server is STILL up — the exact failure that shipped five green releases.
    Run $NodeExe @((Join-Path $Inst 'tools\verify-web.mjs'), '--port', '3080', '--timeout', '150') $Stage
    Ok 'UI served every plugin bundle and stayed up'
  } catch {
    Write-Host ''
    Write-Host '--- serve stdout ---' -ForegroundColor Yellow
    Get-Content -LiteralPath (Join-Path $testHome 'serve.out.log') -Tail 60 -ErrorAction SilentlyContinue
    Write-Host '--- serve stderr ---' -ForegroundColor Yellow
    Get-Content -LiteralPath (Join-Path $testHome 'serve.err.log') -Tail 60 -ErrorAction SilentlyContinue
    Write-Host '--- harness log ---' -ForegroundColor Yellow
    Get-Content -LiteralPath (Join-Path $env:DSH_HOME 'logs\harness.log') -Tail 80 -ErrorAction SilentlyContinue
    throw
  } finally {
    if ($serve -and -not $serve.HasExited) { Stop-Process -Id $serve.Id -Force -ErrorAction SilentlyContinue }
    Get-Process -Name node -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -ne $PID } |
      Where-Object { $_.Path -eq $NodeExe } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testHome -Recurse -Force -ErrorAction SilentlyContinue
  }
  # The smoke test's own data directory must not ship.
  Remove-Item -LiteralPath (Join-Path $Stage 'home') -Recurse -Force -ErrorAction SilentlyContinue
}

# ── 6. package ──────────────────────────────────────────────────────────────
Step 'package'
$zip = Join-Path $RepoRoot "$OutDir\DeepSeekHarness-win-x64-$Version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
# ZipFile, not Compress-Archive: half a gigabyte of small files takes minutes with
# the cmdlet and seconds here.
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $Stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
$mb   = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
$hash | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii -NoNewline

# A zip that swallowed a symlink loop is enormous rather than broken, so the size is
# the cheapest tripwire: this payload is ~250-400 MB and anything far outside that
# means the tree was not what we think it is.
if ($mb -gt 900) { throw "the payload is $mb MB - something duplicated the dependency store" }
if ($mb -lt 60)  { throw "the payload is only $mb MB - the profile did not install" }

Write-Host ''
Ok "$zip"
Ok "$mb MB   sha256 $hash"
if ($env:GITHUB_OUTPUT) {
  "zip=$zip"      | Add-Content -LiteralPath $env:GITHUB_OUTPUT
  "sha256=$hash"  | Add-Content -LiteralPath $env:GITHUB_OUTPUT
  "size_mb=$mb"   | Add-Content -LiteralPath $env:GITHUB_OUTPUT
}
