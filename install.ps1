<#
DeepSeek Harness — one-click install of Ayush's full setup (Windows 10/11).

    irm https://raw.githubusercontent.com/ayushsuletiya/dsh-installer/main/install.ps1 | iex

or, from a clone:

    powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Secrets C:\dsh-secrets.env] [-DryRun] [-SkipQwen]

What it does, in order. Every step is safe to re-run:
  1. node (>= 22) unpacked per-user from nodejs.org - no Administrator, no UAC -
     then pnpm via corepack
  2. @deepseek-ai/dsh pinned to a known-good version, installed globally
  3. credentials from -Secrets / the environment / an existing ~\.dsh\.env
  4. %USERPROFILE%\.dsh: settings.yaml (11 providers), .credentials.yaml, .env
  5. the `web` profile: 10 plugin bundles, 5 local plugins, the MCP rows
  6. the `opus-qwen` agent preset (Opus thinks, Qwen writes the code)
  7. the model-picker patches (search + collapsible provider groups)
  8. the Qwen desktop app + its CDP bridge + a logon Scheduled Task
  9. verification: dsh boots, the composed profile parses, the bridge answers

Secrets are never baked in. Pass them with -Secrets (see secrets.example.env);
anything missing is left blank and that route is skipped, so the install still
completes and can be topped up later with:  dsh-setup reconfigure
#>
[CmdletBinding()]
param(
  [string]$Secrets = '',
  [switch]$DryRun,
  [switch]$SkipQwen,
  [switch]$SkipPatch,
  [switch]$SkipProfileInstall,
  [switch]$ReplaceConfig,
  [switch]$KeepConfig,
  [switch]$AllowDowngrade,
  [switch]$Managed,
  [string]$DshVersion = '0.1.1-rc.2'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 still negotiates TLS 1.0 on some builds, and then every
# https download here dies with "could not create SSL/TLS secure channel". Ask
# for 1.2 explicitly; 1.3 only where the runtime knows the value.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288 } catch { }

# One log that outlives the console window, so a failure is a file to read rather
# than a screenshot of output that has already scrolled away.
$LogPath = Join-Path $env:TEMP 'dsh-install.log'
$script:Transcribing = $false
try {
  Start-Transcript -LiteralPath $LogPath -Force | Out-Null
  $script:Transcribing = $true
} catch { }
function Stop-Log {
  if ($script:Transcribing) {
    $script:Transcribing = $false
    try { Stop-Transcript | Out-Null } catch { }
  }
}

# ── constants ───────────────────────────────────────────────────────────────

$NodeMajorMin       = 22
$NodeInstallVersion = '24'
$RepoUrl            = if ($env:DSH_INSTALLER_REPO)   { $env:DSH_INSTALLER_REPO }   else { 'https://github.com/ayushsuletiya/dsh-installer.git' }
$RepoBranch         = if ($env:DSH_INSTALLER_BRANCH) { $env:DSH_INSTALLER_BRANCH } else { 'main' }
# Endpoints come from the secrets file, not from this repo - see $EndpointKeys.
$MetaAdsBridgeUrl   = if ($env:META_ADS_BRIDGE_URL)  { $env:META_ADS_BRIDGE_URL }  else { '' }

$UserHome     = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DshHome      = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $UserHome '.dsh' }
$ProfileDir   = Join-Path $DshHome 'profiles\web'
$PresetDir    = Join-Path $DshHome '.agent-presets\opus-qwen'
$InstallerHome= Join-Path $DshHome 'installer'
$BridgeDir    = if ($env:QWEN_BRIDGE_DIR) { $env:QWEN_BRIDGE_DIR } else { Join-Path $UserHome 'qwen-bridge' }
$Stamp        = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$LocalBin     = Join-Path $UserHome '.local\bin'

# ── output ──────────────────────────────────────────────────────────────────

$script:StepNo   = 0
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Missing  = New-Object System.Collections.Generic.List[string]
$script:Failed   = 0
$script:NodeWasInstalled = $false
$script:PathWasChanged  = $false
# Absolute paths to the tools we drive. Resolved once node exists, and used
# instead of bare names because PowerShell 5.1 would not see a mid-session PATH
# addition on the machine this was fixed on.
$script:NodeExe     = ''
$script:NpmCmd      = ''
$script:CorepackCmd = ''
$script:GlobalBin   = ''
# Managed install: the bootstrap from the distribution service sets these. The
# machine is ours to configure, so config is fetched by token and applied without
# asking, and an updater task is registered at the end.
$DistBase    = if ($env:DSH_DIST_BASE)    { $env:DSH_DIST_BASE }    else { '' }
$DistToken   = if ($env:DSH_DIST_TOKEN)   { $env:DSH_DIST_TOKEN }   else { '' }
$DistVersion = if ($env:DSH_DIST_VERSION) { $env:DSH_DIST_VERSION } else { '' }
if ($Managed) { $ReplaceConfig = $true; $TotalSteps = 11 } else { $TotalSteps = 10 }

function Write-Step($text) {
  $script:StepNo++
  Write-Host ''
  Write-Host ("[{0}/{1}] {2}" -f $script:StepNo, $TotalSteps, $text) -ForegroundColor Blue
}
function Write-Info($text) { Write-Host ("      {0}" -f $text) }
function Write-Ok($text)   { Write-Host '      ' -NoNewline; Write-Host '+' -ForegroundColor Green -NoNewline; Write-Host " $text" }
function Write-Warn($text) {
  Write-Host '      ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $text"
  $script:Warnings.Add($text) | Out-Null
}
function Die($text) {
  Write-Host ''
  Write-Host "error: $text" -ForegroundColor Red
  if ($script:Transcribing) { Write-Host "  full log: $LogPath" -ForegroundColor Yellow }
  Stop-Log
  exit 1
}
function Invoke-Step([scriptblock]$block, [string]$describe) {
  if ($DryRun) { Write-Host ("      `$ {0}" -f $describe) -ForegroundColor DarkGray }
  else { & $block }
}

function Test-CommandExists($name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

# ── running external tools ──────────────────────────────────────────────────
#
# Windows PowerShell turns anything a native command writes to stderr into error
# records as soon as a redirection is involved, and $ErrorActionPreference =
# 'Stop' then promotes those to terminating errors. That is how ONE npm
# deprecation warning killed this installer: npm printed a warning, exited 0, and
# PowerShell threw. So every external tool is invoked through these three, with
# 'Stop' suspended for the duration, and only the exit code decides anything.

# Discard all output; return the exit code.
function Invoke-Native([string]$File, [string[]]$Arguments = @(), [string]$Log = '') {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Log) { & $File @Arguments *> $Log } else { & $File @Arguments *> $null }
    if ($null -eq $LASTEXITCODE) { return 0 }
    return $LASTEXITCODE
  } catch {
    return 1
  } finally { $ErrorActionPreference = $old }
}

# Show the tool's own progress, indented; return the exit code.
function Invoke-NativeShow([string]$File, [string[]]$Arguments = @()) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @Arguments 2>&1 | ForEach-Object { Write-Host ("      {0}" -f $_) }
    if ($null -eq $LASTEXITCODE) { return 0 }
    return $LASTEXITCODE
  } catch {
    return 1
  } finally { $ErrorActionPreference = $old }
}

# Trimmed stdout of a tool, or '' when it could not run.
function Get-NativeOut([string]$File, [string[]]$Arguments = @()) {
  if (-not $File) { return '' }
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $File @Arguments 2>$null)
    return (($lines | Where-Object { $_ } | ForEach-Object { "$_" }) -join "`n").Trim()
  } catch {
    return ''
  } finally { $ErrorActionPreference = $old }
}

# ── 0. locate the payload (clone ourselves when piped from irm) ──────────────

$SrcDir = ''
if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
  $SrcDir = Split-Path -Parent $PSCommandPath
}
if (-not $SrcDir -or -not (Test-Path -LiteralPath (Join-Path $SrcDir 'payload'))) {
  $CloneDir = Join-Path $env:TEMP "dsh-installer-$Stamp"
  Write-Host 'fetching installer payload...' -ForegroundColor DarkGray
  # Windows ships no git, so prefer the plain zipball: Invoke-WebRequest and
  # Expand-Archive are both built in. git is only a fallback.
  $ok = $false
  try {
    $zipUrl = ($RepoUrl -replace '\.git$', '') + "/archive/refs/heads/$RepoBranch.zip"
    $zipPath = Join-Path $env:TEMP "dsh-installer-$Stamp.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180 -UseBasicParsing
    $unpack = Join-Path $env:TEMP "dsh-installer-unpack-$Stamp"
    Expand-Archive -LiteralPath $zipPath -DestinationPath $unpack -Force
    # GitHub wraps everything in <repo>-<branch>\; hoist that one directory up.
    $inner = Get-ChildItem -LiteralPath $unpack -Directory | Select-Object -First 1
    if ($inner) {
      Move-Item -LiteralPath $inner.FullName -Destination $CloneDir
      $ok = Test-Path -LiteralPath (Join-Path $CloneDir 'payload')
    }
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue
  } catch { $ok = $false }

  if (-not $ok) {
    if (-not (Test-CommandExists 'git')) { Die "could not download the payload from $RepoUrl and git is not available" }
    Remove-Item -LiteralPath $CloneDir -Recurse -Force -ErrorAction SilentlyContinue
    if ((Invoke-Native 'git' @('clone', '--depth', '1', '--branch', $RepoBranch, $RepoUrl, $CloneDir)) -ne 0) {
      Die "could not fetch the payload from $RepoUrl"
    }
  }
  $SrcDir = $CloneDir
}
if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'payload'))) { Die 'payload\ not found next to install.ps1' }

Write-Host 'DeepSeek Harness - one-click setup' -ForegroundColor Blue
Write-Host ("  shell:   PowerShell {0} ({1})" -f $PSVersionTable.PSVersion, $env:PROCESSOR_ARCHITECTURE) -ForegroundColor DarkGray
Write-Host ("  payload: {0}" -f $SrcDir) -ForegroundColor DarkGray
Write-Host ("  target:  {0}" -f $DshHome) -ForegroundColor DarkGray
if ($DryRun) { Write-Host '  DRY RUN - nothing will be written' -ForegroundColor Yellow }

# Fail on a missing secrets file NOW, not after node and dsh are already installed.
if ($Secrets -and -not (Test-Path -LiteralPath $Secrets)) {
  Write-Host ''
  Write-Host "error: secrets file not found: $Secrets" -ForegroundColor Red
  Write-Host ''
  Write-Host 'Copy it over from the machine you generated it on, then re-run.'
  Write-Host 'Or install without it and add the keys later:'
  Write-Host '  <this same command, minus -Secrets>'
  Write-Host '  dsh-setup reconfigure --secrets $HOME\dsh-secrets.env'
  Write-Host ''
  Stop-Log
  exit 2
}

# ── existing installation guard ──────────────────────────────────────────────

# This installer WRITES settings.yaml, .credentials.yaml, .env, the web profile's
# package.json and cordis.patch.yml. On a machine that already has a DSH setup that
# means replacing that person's providers, plugin list and MCP rows — so it stops
# and makes the choice explicit instead of silently taking over.
#
# Chat history is never involved: sessions\, storages\ and task-board\ are not
# touched by any step, and every replaced file is copied to .bak.<timestamp> first.
$existing = @()
foreach ($f in @(
  @{ Path = (Join-Path $DshHome 'settings.yaml');        Note = '' },
  @{ Path = (Join-Path $DshHome '.credentials.yaml');    Note = '' },
  @{ Path = (Join-Path $ProfileDir 'package.json');      Note = ' (your plugin list)' },
  @{ Path = (Join-Path $ProfileDir 'cordis.patch.yml');  Note = ' (your MCP rows)' }
)) {
  if (Test-Path -LiteralPath $f.Path) { $existing += ($f.Path + $f.Note) }
}

if ($existing.Count -gt 0 -and -not $KeepConfig -and -not $ReplaceConfig -and -not $DryRun) {
  Write-Host ''
  Write-Host 'This machine already has a DeepSeek Harness setup.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host "These files would be REPLACED (each one backed up to .bak.$Stamp first):"
  foreach ($e in $existing) { Write-Host "  $e" }
  Write-Host ''
  Write-Host 'Your chats are safe either way - sessions, workspace index and task board'
  Write-Host 'are never touched.'
  Write-Host ''
  Write-Host 'Pick one:'
  Write-Host '  -ReplaceConfig    take over this setup (backups are kept)'
  Write-Host '  -KeepConfig       leave every config file alone; install only the runtime,'
  Write-Host '                    the Qwen bridge, the AgentRouter proxy and the patches'
  Write-Host '  $env:DSH_HOME="$HOME\.dsh-new"   install side by side, touching nothing'
  Write-Host ''
  Stop-Log
  exit 2
}

# ── 1. node + pnpm ──────────────────────────────────────────────────────────

Write-Step 'Node.js and pnpm'

# Never resolve our own tools by name. On a real Windows 11 / PowerShell 5.1 box
# the freshly unpacked node.exe ran fine by absolute path and was still invisible
# to `Get-Command node` after $env:Path was updated in-process. Child processes
# (pnpm, dsh) inherit the updated PATH and resolve normally through the OS, so
# only what THIS script invokes needs absolute paths.
function Resolve-NodeExe {
  if ($script:NodeExe -and (Test-Path -LiteralPath $script:NodeExe)) { return $script:NodeExe }
  $candidates = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\dsh-node\node.exe') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $candidates += (Join-Path $pf86 'nodejs\node.exe') }
  foreach ($p in ($env:Path -split ';')) {
    if ($p) { $candidates += (Join-Path $p 'node.exe') }
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $script:NodeExe = $c; return $script:NodeExe }
  }
  return ''
}

function Get-NodeMajor {
  $exe = Resolve-NodeExe
  if (-not $exe) { return 0 }
  # `node -v` and a regex, NOT `node -p '...split(".")...'`: PowerShell 5.1 strips
  # embedded double quotes when it hands arguments to a native command, so that
  # expression reached node as broken JavaScript, node exited with a syntax error,
  # and a perfectly good node looked like no node at all.
  try {
    $v = Get-NativeOut $exe @('-v')
    if ($v -match '^v?(\d+)') { return [int]$matches[1] }
    return 0
  } catch { return 0 }
}

# Same quoting trap, general form: any JavaScript with a double quote in it has to
# reach node as a FILE, never as -e / -p on the command line.
function Invoke-NodeScript([string]$js, [string[]]$nodeArgs = @()) {
  $f = Join-Path $env:TEMP ("dsh-node-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".mjs")
  Set-Content -LiteralPath $f -Value $js -Encoding ASCII
  try {
    return (Invoke-Native $NodeBin (@($f) + $nodeArgs))
  } finally { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
}

# npm, corepack and the global shim directory, all as absolute paths derived from
# whichever node.exe we ended up with.
function Set-NodeTooling {
  $exe = Resolve-NodeExe
  if (-not $exe) { return }
  $dir = Split-Path -Parent $exe
  $script:NpmCmd      = Join-Path $dir 'npm.cmd'
  $script:CorepackCmd = Join-Path $dir 'corepack.cmd'
  if (-not (Test-Path -LiteralPath $script:NpmCmd))      { $script:NpmCmd = '' }
  if (-not (Test-Path -LiteralPath $script:CorepackCmd)) { $script:CorepackCmd = '' }
  $script:GlobalBin = ''
  if ($script:NpmCmd) {
    try {
      $p = Get-NativeOut $script:NpmCmd @('prefix', '-g')
      if ($p) { $script:GlobalBin = $p }
    } catch { }
  }
  if (-not $script:GlobalBin) { $script:GlobalBin = $dir }
  # On Windows npm puts global shims straight into the prefix directory. It may
  # not exist yet on a machine that has never installed a global package, and it
  # has to be on PATH before dsh.cmd lands in it or new shells will not see dsh.
  if (-not (Test-Path -LiteralPath $script:GlobalBin)) {
    try { New-Item -ItemType Directory -Force -Path $script:GlobalBin | Out-Null } catch { }
  }
  if (Test-Path -LiteralPath $script:GlobalBin) { Add-UserPath $script:GlobalBin }
}

# A globally installed CLI, found as a file rather than trusted to PATH.
function Get-ToolPath($name) {
  $dirs = @()
  if ($script:GlobalBin) { $dirs += $script:GlobalBin }
  $exe = Resolve-NodeExe
  if ($exe) { $dirs += (Split-Path -Parent $exe) }
  foreach ($d in $dirs) {
    foreach ($ext in @('.cmd', '.exe', '.bat')) {
      $c = Join-Path $d ($name + $ext)
      if (Test-Path -LiteralPath $c) { return $c }
    }
  }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return ''
}

# A winget/MSI install lands in Program Files but does not reach THIS process's
# PATH, so refresh it from the registry after installing anything.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
  $script:NodeExe = ''
}

# Persist a directory on the user's PATH and make it usable in this process too.
function Add-UserPath($dir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $dir) {
    $joined = (@($userPath.Trim(';'), $dir) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
    $script:PathWasChanged = $true
  }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
}

# node WITHOUT Administrator. winget and the MSI both need elevation, so on an
# ordinary user account all three old paths failed and the install died here at
# step 1. The official zip needs no installer and no UAC prompt: unpack it under
# the user's own profile. It also makes `npm install -g` writable without admin,
# which the very next step needs.
function Install-NodePortable {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64')  { 'arm64' }
          elseif ([Environment]::Is64BitOperatingSystem) { 'x64' }
          else                                           { 'x86' }
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  # `lts` is the codename string on an LTS line and the boolean false otherwise.
  $rel = $index |
    Where-Object { $_.lts -is [string] } |
    Where-Object { [int]($_.version.TrimStart('v').Split('.')[0]) -ge $NodeMajorMin } |
    Select-Object -First 1
  if (-not $rel) { throw "nodejs.org lists no LTS release >= $NodeMajorMin" }

  $ver   = $rel.version
  $name  = "node-$ver-win-$arch"
  $dest  = Join-Path $env:LOCALAPPDATA 'Programs\dsh-node'
  $zip   = Join-Path $env:TEMP "$name.zip"
  $stage = Join-Path $env:TEMP "dsh-node-$Stamp"
  Write-Info "unpacking node $ver ($arch) into $dest"

  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip -TimeoutSec 900 -UseBasicParsing
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
  $inner = Join-Path $stage $name
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw "the node zip has no $name\node.exe" }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $inner -Destination $dest
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

  # Prove it runs before claiming success, then pin the absolute path: PATH
  # resolution by name cannot be trusted for the rest of this run.
  $exe = Join-Path $dest 'node.exe'
  $reported = Get-NativeOut $exe @('-v')
  if (-not $reported) { throw "node.exe unpacked but does not run" }
  $script:NodeExe = $exe
  Add-UserPath $dest
}

if ((Get-NodeMajor) -ge $NodeMajorMin) {
  Write-Ok ("node {0} already usable" -f (Get-NativeOut (Resolve-NodeExe) @('-v')))
} else {
  if ($DryRun) {
    Write-Info "would unpack node into $env:LOCALAPPDATA\Programs\dsh-node"
  } else {
    $installed = $false
    try {
      Install-NodePortable
      $installed = (Get-NodeMajor) -ge $NodeMajorMin
      if (-not $installed) { Write-Warn 'the unpacked node does not report a usable version - trying the system installers' }
    } catch {
      Write-Warn "portable node install failed ($($_.Exception.Message)) - trying the system installers"
    }
    if (-not $installed -and (Test-CommandExists 'winget')) {
      Write-Info 'installing Node.js LTS via winget (needs Administrator)'
      Invoke-Native 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '--silent', '--accept-package-agreements', '--accept-source-agreements') | Out-Null
      Update-SessionPath
      $installed = (Get-NodeMajor) -ge $NodeMajorMin
    }
    if (-not $installed -and (Test-CommandExists 'fnm')) {
      Write-Info 'installing node via fnm'
      Invoke-Native 'fnm' @('install', $NodeInstallVersion) | Out-Null
      Invoke-Native 'fnm' @('use', $NodeInstallVersion) | Out-Null
      Update-SessionPath
      $installed = (Get-NodeMajor) -ge $NodeMajorMin
    }
    if (-not $installed) {
      # Last resort: the official MSI. Silent, but per-machine, so it needs admin.
      Write-Info 'downloading the Node.js MSI (needs Administrator)'
      $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
      $msi  = Join-Path $env:TEMP "node-lts-$arch.msi"
      try {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $rel = $index | Where-Object { $_.lts -is [string] } | Select-Object -First 1
        Invoke-WebRequest -Uri ("https://nodejs.org/dist/{0}/node-{0}-{1}.msi" -f $rel.version, $arch) -OutFile $msi -TimeoutSec 600
        Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait
        Update-SessionPath
        $installed = (Get-NodeMajor) -ge $NodeMajorMin
      } catch {
        Write-Warn "the MSI install failed too ($($_.Exception.Message))"
      }
    }
    if (-not $installed) { Die "could not install Node.js. Install it from https://nodejs.org and re-run this command." }
    Write-Ok ("node {0} installed" -f (Get-NativeOut (Resolve-NodeExe) @('-v')))
    Write-Info ("using {0}" -f (Resolve-NodeExe))
    $script:NodeWasInstalled = $true
  }
}

$NodeBin = Resolve-NodeExe
if (-not $NodeBin) { $NodeBin = 'node' }
Set-NodeTooling

$PnpmCmd = Get-ToolPath 'pnpm'
if ($PnpmCmd) {
  Write-Ok ("pnpm {0}" -f (Get-NativeOut $PnpmCmd @('-v')))
} elseif (-not $DryRun) {
  # npm first, corepack second. A corepack pnpm shim downloads the package
  # manager on first use and asks for confirmation while doing it, which stalls
  # `dsh plugin install`; a plain global pnpm has no such step. The prompt is
  # disabled either way, because dsh may still reach a corepack shim.
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  Write-Info 'installing pnpm'
  if ($script:NpmCmd) {
    Invoke-Native $script:NpmCmd @('install', '-g', 'pnpm') | Out-Null
    $PnpmCmd = Get-ToolPath 'pnpm'
  }
  if (-not $PnpmCmd -and $script:CorepackCmd) {
    Invoke-Native $script:CorepackCmd @('enable', 'pnpm') | Out-Null
    $PnpmCmd = Get-ToolPath 'pnpm'
  }
  if ($PnpmCmd) { Write-Ok ("pnpm {0}" -f (Get-NativeOut $PnpmCmd @('-v'))) }
  else { Write-Warn 'pnpm unavailable - the plugin-bundle install will be skipped'; $SkipProfileInstall = $true }
}

# ── 2. dsh itself ───────────────────────────────────────────────────────────

Write-Step "DeepSeek Harness $DshVersion"

$DshCmd = Get-ToolPath 'dsh'
$currentDsh = ''
if ($DshCmd) { $currentDsh = Get-NativeOut $DshCmd @('--version') }
function Test-NewerVersion($have, $pin) {
  if (-not $have) { return $false }
  # Same comparison as install.sh, done in node so both platforms agree. Passed as
  # a file because this JavaScript contains double quotes.
  $cmpCode = Invoke-NodeScript @'
const cmp = (a, b) => {
  const norm = (v) => String(v).replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const A = norm(a), B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === typeof y) return x > y ? 1 : -1;
    return typeof x === "number" ? 1 : -1;
  }
  return 0;
};
process.exit(cmp(process.argv[2], process.argv[3]) > 0 ? 0 : 1);
'@ @($have, $pin)
  return ($cmpCode -eq 0)
}

if ($currentDsh -eq $DshVersion) {
  Write-Ok "dsh $DshVersion already installed"
} elseif ($currentDsh -and -not $AllowDowngrade -and (Test-NewerVersion $currentDsh $DshVersion)) {
  Write-Warn "keeping your newer dsh $currentDsh (this installer pins $DshVersion; use -AllowDowngrade to force it)"
} else {
  Write-Info "npm install -g @deepseek-ai/dsh@$DshVersion"
  if (-not $DryRun) {
    if (-not $script:NpmCmd) { Die 'npm was not found next to node - cannot install dsh' }
    $npmLog = Join-Path $env:TEMP 'dsh-npm-install.log'
    if ((Invoke-Native $script:NpmCmd @('install', '-g', "@deepseek-ai/dsh@$DshVersion") $npmLog) -ne 0) {
      Die "could not install @deepseek-ai/dsh@$DshVersion - see $npmLog"
    }
    $DshCmd = Get-ToolPath 'dsh'
    if (-not $DshCmd) { Die "dsh installed but its shim was not found in $script:GlobalBin" }
    Write-Ok ("dsh {0}" -f (Get-NativeOut $DshCmd @('--version')))
  }
}
if (-not $DryRun -and $script:NpmCmd) {
  $root = Get-NativeOut $script:NpmCmd @('root', '-g')
  if ($root) { $env:NPM_GLOBAL_ROOT = $root }
}

# ── 3. credentials ──────────────────────────────────────────────────────────

Write-Step 'Credentials'

$SecretKeys = @(
  'TABITOKEN_API_KEY','OMNIROUTER_API_KEY','OPENROUTER_API_KEY','NVIDIA_NIM_API_KEY',
  'AGENTROUTER_API_KEY','GEMINI_API_KEY','ZAI_API_KEY','QWEN_BRIDGE_KEY','AGY_BRIDGE_KEY',
  'META_ADS_BRIDGE_TOKEN','HOSTINGER_API_TOKEN','HOSTINGER_MAIL_API_TOKEN'
)
$CredKeys = @(
  'TABITOKEN_API_KEY','OMNIROUTER_API_KEY','OPENROUTER_API_KEY','NVIDIA_NIM_API_KEY',
  'AGENTROUTER_API_KEY','GEMINI_API_KEY','ZAI_API_KEY','QWEN_BRIDGE_KEY','AGY_BRIDGE_KEY'
)
$EnvKeys = @('META_ADS_BRIDGE_TOKEN','HOSTINGER_API_TOKEN','HOSTINGER_MAIL_API_TOKEN')
# Endpoints, not credentials: the addresses of your own gateways. Same file, so one
# file carries a machine; absent from the repo so it can be public. A blank
# endpoint drops the routes that need it.
$EndpointKeys = @('TABITOKEN_BASE_URL','OMNIROUTE_BASE_URL','QWEN_OMNI_NODE_ID','META_ADS_BRIDGE_URL','QWEN_RELAY_SSH')

$Secret = @{}
foreach ($k in ($SecretKeys + $EndpointKeys)) { $Secret[$k] = '' }

function Read-SecretFile($path) {
  foreach ($line in (Get-Content -LiteralPath $path -Encoding UTF8)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $key = $t.Substring(0, $i).Trim()
    $val = $t.Substring($i + 1)
    if ($Secret.ContainsKey($key)) { $Secret[$key] = $val }
  }
}

$existingEnv = Join-Path $DshHome '.env'
if (Test-Path -LiteralPath $existingEnv) {
  Read-SecretFile $existingEnv
  Write-Ok 'carried existing values from .dsh\.env'
}
if ($Secrets) {
  if (-not (Test-Path -LiteralPath $Secrets)) { Die "secrets file not found: $Secrets" }
  Read-SecretFile $Secrets
  Write-Ok "loaded $Secrets"
}

# Managed machines get their keys from the distribution service over TLS, keyed to
# their enrollment token. Nothing is typed, and nothing is carried by hand.
if ($Managed -and $DistBase -and $DistToken -and -not $DryRun) {
  try {
    $bundle = Invoke-RestMethod -Uri "$DistBase/config/$DistToken" -TimeoutSec 40
    $applied = 0
    foreach ($group in @('credentials', 'endpoints')) {
      $section = $bundle.$group
      if (-not $section) { continue }
      foreach ($prop in $section.PSObject.Properties) {
        if ($prop.Name -notmatch '^[A-Z0-9_]+$') { continue }
        if ($null -eq $prop.Value -or "$($prop.Value)" -eq '') { continue }
        $Secret[$prop.Name] = "$($prop.Value)"
        $applied++
      }
    }
    $who = if ($bundle.enrollment -and $bundle.enrollment.name) { " (" + $bundle.enrollment.name + ")" } else { '' }
    if ($applied -gt 0) { Write-Ok "configuration fetched for this machine$who" }
    else { Write-Warn 'the distribution service returned no usable configuration' }
  } catch {
    Write-Warn "could not fetch configuration from $DistBase - installing without keys ($($_.Exception.Message))"
  }
}
foreach ($k in ($SecretKeys + $EndpointKeys)) {
  $fromEnv = [Environment]::GetEnvironmentVariable($k)
  if ($fromEnv) { $Secret[$k] = $fromEnv }
}
if (-not $Secret['QWEN_BRIDGE_KEY']) { $Secret['QWEN_BRIDGE_KEY'] = 'local-bridge-no-key-needed' }

$have = 0
foreach ($k in $SecretKeys) {
  if ($Secret[$k]) { $have++ } else { $script:Missing.Add($k) | Out-Null }
}
Write-Info ("{0} of {1} credentials present" -f $have, $SecretKeys.Count)
if ($script:Missing.Count -gt 0) { Write-Info 'blank for now (add later with: dsh-setup reconfigure)' }

# ── 4. .dsh: settings, credentials, env ─────────────────────────────────────

Write-Step 'Host configuration'

function Backup-File($path) {
  if ((Test-Path -LiteralPath $path) -and -not $DryRun) {
    Copy-Item -LiteralPath $path -Destination "$path.bak.$Stamp" -Force
    Write-Info ("backed up {0}" -f (Split-Path -Leaf $path))
  }
}

# Windows has no chmod; ACLs are the equivalent. Break inheritance and grant the
# current user alone — that is what makes a token file not world-readable here.
function Protect-File($path) {
  if ($DryRun -or -not (Test-Path -LiteralPath $path)) { return }
  try {
    $acl = Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $me, 'FullControl', 'Allow')))
    Set-Acl -LiteralPath $path -AclObject $acl
  } catch { Write-Warn ("could not lock down {0}" -f (Split-Path -Leaf $path)) }
}

foreach ($d in @((Join-Path $DshHome 'logs'), $PresetDir, $InstallerHome, $ProfileDir, $LocalBin)) {
  Invoke-Step { New-Item -ItemType Directory -Force -Path $d | Out-Null } "mkdir $d"
}

if ($KeepConfig) {
  Write-Info '-KeepConfig: settings.yaml, .credentials.yaml and .env left untouched'
}

$settingsPath = Join-Path $DshHome 'settings.yaml'
if (-not $KeepConfig) {
Backup-File $settingsPath
# settings.yaml is rendered, not copied: the gateway addresses live in the secrets
# file, and a provider whose endpoint is blank is dropped rather than left pointing
# at nothing.
$env:DSHX_TABITOKEN_BASE_URL = $Secret['TABITOKEN_BASE_URL']
$env:DSHX_OMNIROUTE_BASE_URL = $Secret['OMNIROUTE_BASE_URL']
$env:DSHX_QWEN_OMNI_NODE_ID  = $Secret['QWEN_OMNI_NODE_ID']
if (-not $DryRun) {
  if ((Invoke-Native $NodeBin @((Join-Path $SrcDir 'tools\render.mjs'), (Join-Path $SrcDir 'payload\settings.template.yaml'), $settingsPath)) -ne 0) {
    Die 'rendering settings.yaml failed'
  }
}
Protect-File $settingsPath
$providerCount = if ($DryRun) { '?' } else {
  ([regex]::Matches((Get-Content -LiteralPath $settingsPath -Raw), '(?m)^    [a-z0-9-]+:$')).Count
}
Write-Ok "settings.yaml - $providerCount providers, dark theme, opus-qwen as the session default"

$credPath = Join-Path $DshHome '.credentials.yaml'
if (-not $DryRun) {
  Backup-File $credPath
  $lines = @('version: 1', 'refs:')
  foreach ($k in $CredKeys) {
    $v = $Secret[$k]
    if ($v) { $lines += ("  {0}: {1}" -f $k, $v) } else { $lines += ("  {0}: ''" -f $k) }
  }
  Set-Content -LiteralPath $credPath -Value $lines -Encoding UTF8
  Protect-File $credPath
}
Write-Ok '.credentials.yaml (locked to your account)'

$envPath = Join-Path $DshHome '.env'
if (-not $DryRun) {
  Backup-File $envPath
  $lines = @(
    '# Loaded by dsh at boot. Gitignored secrets live here.',
    '# Refresh with: dsh-setup reconfigure --secrets <file>'
  )
  foreach ($k in $EnvKeys) { if ($Secret[$k]) { $lines += ("{0}={1}" -f $k, $Secret[$k]) } }
  Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8
  Protect-File $envPath
}
Write-Ok '.env (locked to your account)'
}  # KeepConfig

# ── 5. web profile ──────────────────────────────────────────────────────────

Write-Step 'Web profile: bundles, local plugins, MCP rows'

if ($KeepConfig) {
  Write-Info '-KeepConfig: your profile, plugin list and MCP rows left untouched'
} else {

if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir 'cordis.yml')) -and -not $DryRun) {
  Write-Info 'scaffolding the profile with dsh itself'
  $env:DSH_HOME = $DshHome
  if (-not $DshCmd) { $DshCmd = Get-ToolPath 'dsh' }
  if ($DshCmd) { Invoke-Native $DshCmd @('--profile', 'web', '--dump-default-config') | Out-Null }
}

Invoke-Step {
  Copy-Item -LiteralPath (Join-Path $SrcDir 'payload\profile-web\package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
} 'copy package.json'

# One bundle is a git dependency and pnpm needs a working git to resolve it, or the
# whole install fails and none of the ten bundles land. Windows ships no git.
if (-not $DryRun) {
  $gitWorks = $false
  $gitWorks = ((Invoke-Native 'git' @('--version')) -eq 0)
  if ($gitWorks) {
    Write-Ok 'git available - keeping the pinned dsh-at-file tag'
  } else {
    $swapCode = Invoke-NodeScript @'
import fs from "node:fs";
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
let swapped = 0;
for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
  if (typeof spec === "string" && /^(github:|git\+|git:)/.test(spec)) { pkg.dependencies[name] = "*"; swapped += 1; }
}
if (swapped) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
'@ @((Join-Path $ProfileDir 'package.json'))
    if ($swapCode -eq 0) { Write-Warn 'no working git - git-pinned bundles fall back to their npm release' }
    else { Write-Warn 'no working git, and the fallback rewrite failed - the bundle install may fail' }
  }
}
foreach ($f in @('compaction-llm-retry.mjs','web-search-ddg.mjs','llm-turn-fallback.mjs','qwen-coder.mjs','command-clear.mjs')) {
  Invoke-Step {
    Copy-Item -LiteralPath (Join-Path $SrcDir "payload\profile-web\$f") -Destination (Join-Path $ProfileDir $f) -Force
  } "copy $f"
}
Write-Ok '5 local plugins + 10 bundle declarations'

# Forward slashes throughout: Node accepts them on Windows, and they need no
# escaping inside YAML strings or the `!!js` expressions.
function ToFwd($p) { return ($p -replace '\\', '/') }
function JsonStr($p) { return (Get-NativeOut $NodeBin @('-p', 'JSON.stringify(process.argv[1])', $p)) }

$env:DSHX_PROFILE_WEB = ToFwd $ProfileDir
$env:DSHX_DSH_HOME    = ToFwd $DshHome
$env:DSHX_HOME        = ToFwd $UserHome
$env:DSHX_NODE        = ToFwd $NodeBin
$env:DSHX_META_ADS_BRIDGE_TOKEN    = $Secret['META_ADS_BRIDGE_TOKEN']
$env:DSHX_META_ADS_BRIDGE_URL      = if ($Secret['META_ADS_BRIDGE_URL']) { $Secret['META_ADS_BRIDGE_URL'] } else { $MetaAdsBridgeUrl }
$env:DSHX_META_ADS_ENABLED         = if ($Secret['META_ADS_BRIDGE_TOKEN'] -and $env:DSHX_META_ADS_BRIDGE_URL) { '1' } else { '' }
$env:DSHX_HOSTINGER_API_TOKEN      = $Secret['HOSTINGER_API_TOKEN']
$env:DSHX_HOSTINGER_MAIL_API_TOKEN = $Secret['HOSTINGER_MAIL_API_TOKEN']
$hostingerDir = Join-Path $UserHome '.hostinger-mcp'
$env:DSHX_HOSTINGER_DIR      = ToFwd $hostingerDir
$env:DSHX_HOSTINGER_ENV_JSON = if ($DryRun) { '""' } else { JsonStr (ToFwd (Join-Path $hostingerDir '.env')) }
$hostingerBin = Get-Command 'hostinger-mail-mcp' -ErrorAction SilentlyContinue
$env:DSHX_HOSTINGER_MCP_BIN = if ($hostingerBin) { ToFwd $hostingerBin.Source } else { 'hostinger-mail-mcp' }

$mlServer = Join-Path $UserHome 'multilogin-mcp\server.mjs'
if (Test-Path -LiteralPath $mlServer) {
  $env:DSHX_MULTILOGIN_DIR         = ToFwd (Join-Path $UserHome 'multilogin-mcp')
  $env:DSHX_MULTILOGIN_SERVER_JSON = if ($DryRun) { '""' } else { JsonStr (ToFwd $mlServer) }
} else {
  $env:DSHX_MULTILOGIN_DIR         = ''
  $env:DSHX_MULTILOGIN_SERVER_JSON = '""'
}

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not $DryRun) {
  Backup-File $patchPath
  if ((Invoke-Native $NodeBin @((Join-Path $SrcDir 'tools\render.mjs'), (Join-Path $SrcDir 'payload\profile-web\cordis.patch.template.yml'), $patchPath)) -ne 0) {
    Die 'rendering cordis.patch.yml failed'
  }
}
Write-Ok 'cordis.patch.yml rendered for this machine'

if ($env:DSHX_META_ADS_ENABLED) { Write-Ok 'Meta Ads MCP: 3 rows enabled' } else { Write-Info 'Meta Ads MCP: skipped (needs both META_ADS_BRIDGE_TOKEN and META_ADS_BRIDGE_URL)' }
if ($Secret['HOSTINGER_API_TOKEN'])   { Write-Ok 'Hostinger mail MCP: enabled' }   else { Write-Info 'Hostinger mail MCP: skipped (no token)' }
if ($env:DSHX_MULTILOGIN_DIR)         { Write-Ok 'Multilogin MCP: enabled' }       else { Write-Info 'Multilogin MCP: skipped (multilogin-mcp absent)' }
Write-Info 'UI Skills MCP: always on (keyless)'

# Approve the native build scripts the profile needs. Which key pnpm reads has
# moved twice, and pnpm 11 exits non-zero when it is missing even though every
# package installed — so this is handled in one place for both platforms.
$wsPath = Join-Path $ProfileDir 'pnpm-workspace.yaml'
if (-not $DryRun -and (Test-Path -LiteralPath $wsPath)) {
  if ((Invoke-Native $NodeBin @((Join-Path $SrcDir 'tools\pnpm-allow-builds.mjs'), $wsPath)) -ne 0) {
    Write-Warn 'could not write pnpm build approvals'
  }
}

if (-not $SkipProfileInstall -and -not $DryRun) {
  Write-Info 'installing the plugin bundles - the slow step, a few minutes on first run'
  $log = Join-Path $env:TEMP 'dsh-plugin-install.log'
  if (-not $DshCmd) { $DshCmd = Get-ToolPath 'dsh' }
  Push-Location $ProfileDir
  try {
    $env:DSH_HOME = $DshHome
    # dsh shells out to pnpm, which the child finds through the inherited PATH.
    if ((Invoke-Native $DshCmd @('plugin', '--profile', 'web', 'install') $log) -eq 0) { Write-Ok 'plugin bundles installed' }
    else { Write-Warn "plugin install reported errors - see $log" }
  } finally { Pop-Location }
} else {
  Write-Info 'plugin install skipped'
}

}  # KeepConfig

# ── 6. agent preset ─────────────────────────────────────────────────────────

Write-Step 'Agent preset: opus-qwen'

if ($KeepConfig) {
  Write-Info '-KeepConfig: agent presets left untouched'
} else {
Invoke-Step {
  Copy-Item -LiteralPath (Join-Path $SrcDir 'payload\agent-presets\opus-qwen\preset.yml') -Destination (Join-Path $PresetDir 'preset.yml') -Force
} 'copy preset.yml'
if (-not $DryRun) {
  $presetCode = Invoke-Native $NodeBin @(
    (Join-Path $SrcDir 'tools\render.mjs'),
    (Join-Path $SrcDir 'payload\agent-presets\opus-qwen\agent.cordis.template.yml'),
    (Join-Path $PresetDir 'agent.cordis.yml')
  )
  if ($presetCode -ne 0) { Die 'rendering the agent preset failed' }
}
Write-Ok 'Opus thinks - qwen_code writes - subagent_qwen drives the files'
}  # KeepConfig

# ── 7. model picker patches ─────────────────────────────────────────────────

Write-Step 'Model picker: search + collapsible groups'

if ($SkipPatch) {
  Write-Info 'skipped (-SkipPatch)'
} elseif ($DryRun) {
  Write-Info 'would patch @deepseek-ai/dsh-client-ui-model-selection'
} else {
  $patchCode = Invoke-NativeShow $NodeBin @((Join-Path $SrcDir 'tools\patch-model-selector.mjs'))
  if ($patchCode -eq 4) { Write-Warn 'model-picker patch skipped (the picker still works, without folding)' }
}

# ── 7b. AgentRouter loopback proxy ──────────────────────────────────────────

# AgentRouter is a plain HTTPS API, but it 401s unless the request carries a
# Claude-CLI User-Agent, and pi-ai overwrites a provider `headers:` User-Agent with
# its own. So the route needs one 60-line loopback hop that rewrites that header.
Write-Step 'AgentRouter loopback proxy'

$ArDir = Join-Path $DshHome 'agentrouter-proxy'
Invoke-Step { New-Item -ItemType Directory -Force -Path $ArDir | Out-Null } "mkdir $ArDir"
Invoke-Step {
  Copy-Item -LiteralPath (Join-Path $SrcDir 'payload\agentrouter-proxy\agentrouter-proxy.mjs') -Destination (Join-Path $ArDir 'agentrouter-proxy.mjs') -Force
} 'copy agentrouter-proxy.mjs'

if (-not $DryRun) {
  $arUp = $false
  try { Invoke-WebRequest -Uri 'http://127.0.0.1:3081/' -TimeoutSec 3 -UseBasicParsing | Out-Null; $arUp = $true } catch {}
  if ($arUp) {
    Write-Ok 'AgentRouter proxy already running on 127.0.0.1:3081'
  } else {
    $arScript = Join-Path $ArDir 'agentrouter-proxy.mjs'
    try {
      $arAction = New-ScheduledTaskAction -Execute $NodeBin -Argument ('"{0}"' -f $arScript) -WorkingDirectory $ArDir
      $arTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $arSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName 'DSH AgentRouter Proxy' -Action $arAction -Trigger $arTrigger `
        -Settings $arSettings -Description 'Rewrites the User-Agent AgentRouter requires' -Force | Out-Null
      Start-ScheduledTask -TaskName 'DSH AgentRouter Proxy'
      Write-Ok 'AgentRouter proxy Scheduled Task registered'
    } catch {
      Start-Process $NodeBin -ArgumentList @($arScript) -WindowStyle Hidden
      Write-Warn "could not register the AgentRouter task ($($_.Exception.Message)); started detached"
    }
  }
}

# ── 8. Qwen desktop app + bridge ────────────────────────────────────────────

Write-Step 'Qwen desktop bridge'

if ($SkipQwen) {
  Write-Info 'skipped (-SkipQwen)'
} else {
  Invoke-Step { New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null } "mkdir $BridgeDir"
  foreach ($f in @('server-app.mjs','qwen-app-client.mjs','qwen-auth.mjs','qwen-login.mjs',
                   'server-oauth.mjs','tool-formatter.mjs','push-creds.mjs',
                   'README.md','run.sh','run.ps1')) {
    $srcFile = Join-Path $SrcDir "payload\qwen-bridge\$f"
    if (Test-Path -LiteralPath $srcFile) {
      Invoke-Step { Copy-Item -LiteralPath $srcFile -Destination (Join-Path $BridgeDir $f) -Force } "copy $f"
    }
  }
  Write-Ok "bridge installed at $BridgeDir"

  if (-not $DryRun) {
    $qwenCode = Invoke-NativeShow $NodeBin @((Join-Path $SrcDir 'tools\install-qwen-app.mjs'))
    if ($qwenCode -ne 0) {
      Write-Warn 'Qwen app not installed automatically - get it from https://qwen.ai/download'
    } else {
      Write-Ok 'Qwen desktop app installed and launched with the debugging port'
    }
  } else {
    Write-Info 'would download + install the Qwen desktop app'
  }

  # A logon Scheduled Task is the Windows counterpart of the macOS LaunchAgent.
  # Someone who already runs a bridge must not end up with two supervisors
  # fighting over port 3083 — the loser EADDRINUSE-loops forever.
  $bridgeAlready = $false
  if (-not $DryRun) {
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:3083/health' -TimeoutSec 3 -UseBasicParsing | Out-Null
      $bridgeAlready = $true
      Write-Warn 'something already serves :3083 - not registering a second bridge'
    } catch {}
  }
  if (-not $DryRun -and -not $bridgeAlready) {
    $taskName = 'DSH Qwen Bridge'
    $runPs1   = Join-Path $BridgeDir 'run.ps1'
    try {
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $runPs1) `
        -WorkingDirectory $BridgeDir
      $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Description 'Keeps the DSH Qwen desktop-app bridge alive' -Force | Out-Null
      Start-ScheduledTask -TaskName $taskName
      Write-Ok 'Scheduled Task registered - starts at every logon'
    } catch {
      Write-Warn "could not register the Scheduled Task ($($_.Exception.Message)); starting detached instead"
      Start-Process powershell -ArgumentList @('-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$runPs1) -WindowStyle Hidden
    }
  }
}

# ── managed updater ─────────────────────────────────────────────────────────

if ($Managed -and -not $DryRun) {
  Write-Step 'Managed updates'

  $updDir = Join-Path $DshHome 'updater'
  New-Item -ItemType Directory -Force -Path $updDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DshHome 'logs') | Out-Null
  Copy-Item -LiteralPath (Join-Path $SrcDir 'payload\updater\check-update.mjs') `
    -Destination (Join-Path $updDir 'check-update.mjs') -Force

  # This file is what makes the machine "managed": where to check, as whom, and
  # what it currently runs. The updater rewrites `version` after each upgrade.
  $managedPath = Join-Path $DshHome 'managed.json'
  $managedJson = [ordered]@{
    base      = $DistBase
    token     = $DistToken
    version   = if ($DistVersion) { $DistVersion } else { '0.0.0' }
    installed = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  } | ConvertTo-Json
  Set-Content -LiteralPath $managedPath -Value $managedJson -Encoding UTF8
  Protect-File $managedPath
  Write-Ok "enrolled for updates from $DistBase"

  # A .cmd shim so `dsh-update` works from cmd.exe and PowerShell alike.
  $updShim = Join-Path $LocalBin 'dsh-update.cmd'
  Set-Content -LiteralPath $updShim -Encoding ASCII -Value @(
    '@echo off',
    ('"{0}" "{1}\check-update.mjs" %*' -f $NodeBin, $updDir)
  )

  # Every 6 hours, and once at logon, same cadence as the macOS LaunchAgent.
  try {
    $updAction = New-ScheduledTaskAction -Execute $NodeBin `
      -Argument ('"{0}\check-update.mjs"' -f $updDir) -WorkingDirectory $updDir
    $updTriggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) `
        -RepetitionInterval (New-TimeSpan -Hours 6))
    )
    $updSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'DSH Update Check' -Action $updAction `
      -Trigger $updTriggers -Settings $updSettings `
      -Description 'Checks for a new managed DeepSeek Harness release' -Force | Out-Null
    Write-Ok 'update check every 6 hours - you get a prompt when a new version ships'
  } catch {
    Write-Warn "could not register the update task ($($_.Exception.Message)); run dsh-update by hand"
  }
}

# ── 9. dsh-setup helper + verification ──────────────────────────────────────

Write-Step 'Verify'

if (-not $DryRun -and ($SrcDir -ne $InstallerHome)) {
  $staging = "$InstallerHome.new"
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  foreach ($d in @('payload','tools')) {
    Copy-Item -LiteralPath (Join-Path $SrcDir $d) -Destination $staging -Recurse -Force
  }
  foreach ($f in @('install.sh','install.ps1','dsh-setup.sh','dsh-setup.ps1','README.md','secrets.example.env','VERSION')) {
    $p = Join-Path $SrcDir $f
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $staging -Force }
  }
  Remove-Item -LiteralPath $InstallerHome -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $staging -Destination $InstallerHome

  # A .cmd shim so `dsh-setup` works from cmd.exe and PowerShell alike.
  $shim = Join-Path $LocalBin 'dsh-setup.cmd'
  Set-Content -LiteralPath $shim -Encoding ASCII -Value @(
    '@echo off',
    ('powershell -NoProfile -ExecutionPolicy Bypass -File "{0}\dsh-setup.ps1" %*' -f $InstallerHome)
  )
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$LocalBin*") {
    Add-UserPath $LocalBin
    Write-Info "added $LocalBin to your PATH (new shells only)"
  }
  Write-Ok 'dsh-setup installed (reconfigure / repatch / qwen / doctor)'
}

if (-not $DryRun) {
  if (-not $DshCmd) { $DshCmd = Get-ToolPath 'dsh' }
  try {
    $v = if ($DshCmd) { Get-NativeOut $DshCmd @('--version') } else { '' }
    if ($v) { Write-Ok "dsh $v responds" } else { Write-Warn 'dsh --version failed'; $script:Failed = 1 }
  } catch { Write-Warn 'dsh --version failed'; $script:Failed = 1 }

  $text = Get-Content -LiteralPath $settingsPath -Raw
  if ($text -notmatch 'llm-pi-ai:') { Write-Warn 'settings.yaml has no llm-pi-ai section'; $script:Failed = 1 }
  elseif ($text -match 'opencode')  { Write-Warn 'opencode leaked into settings.yaml';    $script:Failed = 1 }
  else { Write-Ok 'settings.yaml sane - opencode fully removed' }

  # Composition needs the bundles on disk, so a deliberately skipped install is
  # reported as skipped rather than as a failure.
  if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir 'node_modules'))) {
    Write-Info 'composition check skipped - bundles not installed yet'
    Write-Info 'run: dsh plugin --profile web install'
  } elseif ($DshCmd) {
    $dumpLog = Join-Path $env:TEMP 'dsh-dump-config.log'
    $env:DSH_HOME = $DshHome
    $dumpCode = Invoke-Native $DshCmd @('--profile', 'web', '--dump-config') $dumpLog
    if ($dumpCode -eq 0) {
      $rows = (Select-String -Path $dumpLog -Pattern '^- id:' -AllMatches).Count
      Write-Ok "composed web profile parses ($rows top-level rows)"
    } else {
      Write-Warn "profile composition failed - see $dumpLog"; $script:Failed = 1
    }
  }

  if (-not $SkipQwen) {
    $up = $false
    foreach ($i in 1..10) {
      try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:3083/health' -TimeoutSec 3 -UseBasicParsing | Out-Null
        $up = $true; break
      } catch { Start-Sleep -Seconds 2 }
    }
    if ($up) { Write-Ok 'Qwen bridge answering on 127.0.0.1:3083' }
    else { Write-Warn "Qwen bridge not answering yet - sign into the Qwen app, then check $BridgeDir\bridge.log" }
  }
}

# ── report ──────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host '----------------------------------------' -ForegroundColor Green
if ($DryRun) {
  Write-Host 'Dry run complete - nothing was written.'
} else {
  Write-Host 'Done.' -ForegroundColor Green -NoNewline
  Write-Host '  Start it with:  dsh web'
}

if ($script:Warnings.Count -gt 0) {
  Write-Host ''
  Write-Host ("{0} thing(s) need your attention:" -f $script:Warnings.Count) -ForegroundColor Yellow
  foreach ($w in $script:Warnings) { Write-Host "  * $w" }
}
if ($script:Missing.Count -gt 0 -and -not $Managed) {
  Write-Host ''
  Write-Host 'Blank credentials - put them in a file and run: dsh-setup reconfigure --secrets <file>' -ForegroundColor DarkGray
  foreach ($m in $script:Missing) { Write-Host "  $m" }
}

if ($script:NodeWasInstalled -or $script:PathWasChanged) {
  Write-Host ''
  Write-Host 'Open a new PowerShell before anything else.' -ForegroundColor Yellow
  if ($script:NodeWasInstalled) { Write-Host ("  node lives in {0}" -f (Split-Path -Parent $NodeBin)) }
  if ($script:GlobalBin)        { Write-Host ("  dsh lives in {0}" -f $script:GlobalBin) }
  if ($script:PathWasChanged)   { Write-Host '  both, and ~\.local\bin, were added to your PATH - only new shells see it' }
}

Write-Host ''
Write-Host 'Next: sign into the Qwen desktop app once - the bridge borrows that session -'
Write-Host '      then run dsh web and pick a model.'
if ($script:Transcribing) {
  Write-Host ''
  Write-Host "log: $LogPath" -ForegroundColor DarkGray
}
Stop-Log
exit $script:Failed
