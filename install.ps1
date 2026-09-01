<#
DeepSeek Harness — one-click install of Ayush's full setup (Windows 10/11).

    irm https://raw.githubusercontent.com/ayushsuletiya/dsh-installer/main/install.ps1 | iex

or, from a clone:

    powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Secrets C:\dsh-secrets.env] [-DryRun] [-SkipQwen]

What it does, in order. Every step is safe to re-run:
  1. node (>= 22) via winget/fnm when the machine has none, then pnpm
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
  [string]$DshVersion = '0.1.1-rc.2'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

function Write-Step($text) {
  $script:StepNo++
  Write-Host ''
  Write-Host ("[{0}/10] {1}" -f $script:StepNo, $text) -ForegroundColor Blue
}
function Write-Info($text) { Write-Host ("      {0}" -f $text) }
function Write-Ok($text)   { Write-Host '      ' -NoNewline; Write-Host '+' -ForegroundColor Green -NoNewline; Write-Host " $text" }
function Write-Warn($text) {
  Write-Host '      ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $text"
  $script:Warnings.Add($text) | Out-Null
}
function Die($text) { Write-Host ''; Write-Host "error: $text" -ForegroundColor Red; exit 1 }
function Invoke-Step([scriptblock]$block, [string]$describe) {
  if ($DryRun) { Write-Host ("      `$ {0}" -f $describe) -ForegroundColor DarkGray }
  else { & $block }
}

function Test-CommandExists($name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
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
    & git clone --depth 1 --branch $RepoBranch $RepoUrl $CloneDir 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "could not fetch the payload from $RepoUrl" }
  }
  $SrcDir = $CloneDir
}
if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'payload'))) { Die 'payload\ not found next to install.ps1' }

Write-Host 'DeepSeek Harness - one-click setup' -ForegroundColor Blue
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
  exit 2
}

# ── 1. node + pnpm ──────────────────────────────────────────────────────────

Write-Step 'Node.js and pnpm'

function Get-NodeMajor {
  if (-not (Test-CommandExists 'node')) { return 0 }
  try { return [int](& node -p 'process.versions.node.split(".")[0]' 2>$null) } catch { return 0 }
}

# A winget/MSI install lands in Program Files but does not reach THIS process's
# PATH, so refresh it from the registry after installing anything.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

if ((Get-NodeMajor) -ge $NodeMajorMin) {
  Write-Ok ("node {0} already usable" -f (& node -v))
} else {
  if ($DryRun) {
    Write-Info "would install node $NodeInstallVersion"
  } else {
    $installed = $false
    if (Test-CommandExists 'winget') {
      Write-Info 'installing Node.js LTS via winget'
      & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
      Update-SessionPath
      $installed = (Get-NodeMajor) -ge $NodeMajorMin
    }
    if (-not $installed -and (Test-CommandExists 'fnm')) {
      Write-Info 'installing node via fnm'
      & fnm install $NodeInstallVersion 2>$null | Out-Null
      & fnm use $NodeInstallVersion 2>$null | Out-Null
      Update-SessionPath
      $installed = (Get-NodeMajor) -ge $NodeMajorMin
    }
    if (-not $installed) {
      # Last resort: the official MSI, installed per-machine and silently.
      Write-Info 'downloading the Node.js MSI'
      $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
      $msi  = Join-Path $env:TEMP "node-lts-$arch.msi"
      try {
        $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
        $rel = $index | Where-Object { $_.lts -ne $false } | Select-Object -First 1
        Invoke-WebRequest -Uri ("https://nodejs.org/dist/{0}/node-{0}-{1}.msi" -f $rel.version, $arch) -OutFile $msi -TimeoutSec 600
        Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait
        Update-SessionPath
        $installed = (Get-NodeMajor) -ge $NodeMajorMin
      } catch {
        Die "could not install Node.js automatically ($($_.Exception.Message)). Install it from https://nodejs.org and re-run."
      }
    }
    if (-not $installed) { Die 'node still not on PATH - open a new PowerShell and re-run' }
    # Check, do not hope: an older node left active makes corepack, pnpm and dsh
    # all fail later in confusing ways.
    if ((Get-NodeMajor) -lt $NodeMajorMin) {
      Die ("node {0} is active but {1}+ is required - open a new PowerShell and re-run" -f (& node -v), $NodeMajorMin)
    }
    Write-Ok ("node {0} installed" -f (& node -v))
    $script:NodeWasInstalled = $true
  }
}

$NodeBin = if (Test-CommandExists 'node') { (Get-Command node).Source } else { 'node' }

if (Test-CommandExists 'pnpm') {
  Write-Ok ("pnpm {0}" -f (& pnpm -v))
} elseif (-not $DryRun) {
  Write-Info 'enabling pnpm via corepack'
  try { & corepack enable pnpm 2>$null | Out-Null } catch {}
  if (-not (Test-CommandExists 'pnpm')) { try { & npm install -g pnpm 2>$null | Out-Null } catch {} }
  if (Test-CommandExists 'pnpm') { Write-Ok ("pnpm {0}" -f (& pnpm -v)) }
  else { Write-Warn 'pnpm unavailable - the plugin-bundle install will be skipped'; $SkipProfileInstall = $true }
}

# ── 2. dsh itself ───────────────────────────────────────────────────────────

Write-Step "DeepSeek Harness $DshVersion"

$currentDsh = ''
if (Test-CommandExists 'dsh') { try { $currentDsh = (& dsh --version 2>$null) } catch {} }
function Test-NewerVersion($have, $pin) {
  if (-not $have) { return $false }
  # Same comparison as install.sh, done in node so both platforms agree.
  & node -e '
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
    process.exit(cmp(process.argv[1], process.argv[2]) > 0 ? 0 : 1);
  ' $have $pin 2>$null
  return ($LASTEXITCODE -eq 0)
}

if ($currentDsh -eq $DshVersion) {
  Write-Ok "dsh $DshVersion already installed"
} elseif ($currentDsh -and -not $AllowDowngrade -and (Test-NewerVersion $currentDsh $DshVersion)) {
  Write-Warn "keeping your newer dsh $currentDsh (this installer pins $DshVersion; use -AllowDowngrade to force it)"
} else {
  Write-Info "npm install -g @deepseek-ai/dsh@$DshVersion"
  if (-not $DryRun) {
    & npm install -g "@deepseek-ai/dsh@$DshVersion" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "could not install @deepseek-ai/dsh@$DshVersion" }
    Update-SessionPath
    Write-Ok ("dsh {0}" -f (& dsh --version 2>$null))
  }
}
if (-not $DryRun) { $env:NPM_GLOBAL_ROOT = (& npm root -g 2>$null) }

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
  & node (Join-Path $SrcDir 'tools\render.mjs') (Join-Path $SrcDir 'payload\settings.template.yaml') $settingsPath | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'rendering settings.yaml failed' }
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
  try { & dsh --profile web --dump-default-config 2>$null | Out-Null } catch {}
}

Invoke-Step {
  Copy-Item -LiteralPath (Join-Path $SrcDir 'payload\profile-web\package.json') -Destination (Join-Path $ProfileDir 'package.json') -Force
} 'copy package.json'
foreach ($f in @('compaction-llm-retry.mjs','web-search-ddg.mjs','llm-turn-fallback.mjs','qwen-coder.mjs','command-clear.mjs')) {
  Invoke-Step {
    Copy-Item -LiteralPath (Join-Path $SrcDir "payload\profile-web\$f") -Destination (Join-Path $ProfileDir $f) -Force
  } "copy $f"
}
Write-Ok '5 local plugins + 10 bundle declarations'

# Forward slashes throughout: Node accepts them on Windows, and they need no
# escaping inside YAML strings or the `!!js` expressions.
function ToFwd($p) { return ($p -replace '\\', '/') }
function JsonStr($p) { return (& node -p 'JSON.stringify(process.argv[1])' $p) }

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
  & node (Join-Path $SrcDir 'tools\render.mjs') (Join-Path $SrcDir 'payload\profile-web\cordis.patch.template.yml') $patchPath | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'rendering cordis.patch.yml failed' }
}
Write-Ok 'cordis.patch.yml rendered for this machine'

if ($env:DSHX_META_ADS_ENABLED) { Write-Ok 'Meta Ads MCP: 3 rows enabled' } else { Write-Info 'Meta Ads MCP: skipped (needs both META_ADS_BRIDGE_TOKEN and META_ADS_BRIDGE_URL)' }
if ($Secret['HOSTINGER_API_TOKEN'])   { Write-Ok 'Hostinger mail MCP: enabled' }   else { Write-Info 'Hostinger mail MCP: skipped (no token)' }
if ($env:DSHX_MULTILOGIN_DIR)         { Write-Ok 'Multilogin MCP: enabled' }       else { Write-Info 'Multilogin MCP: skipped (multilogin-mcp absent)' }
Write-Info 'UI Skills MCP: always on (keyless)'

if (-not $SkipProfileInstall -and -not $DryRun) {
  Write-Info 'installing the plugin bundles - the slow step, a few minutes on first run'
  $log = Join-Path $env:TEMP 'dsh-plugin-install.log'
  Push-Location $ProfileDir
  try {
    $env:DSH_HOME = $DshHome
    & dsh plugin --profile web install *> $log
    if ($LASTEXITCODE -eq 0) { Write-Ok 'plugin bundles installed' }
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
  & node (Join-Path $SrcDir 'tools\render.mjs') `
    (Join-Path $SrcDir 'payload\agent-presets\opus-qwen\agent.cordis.template.yml') `
    (Join-Path $PresetDir 'agent.cordis.yml') | Out-Null
  if ($LASTEXITCODE -ne 0) { Die 'rendering the agent preset failed' }
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
  & node (Join-Path $SrcDir 'tools\patch-model-selector.mjs')
  if ($LASTEXITCODE -eq 4) { Write-Warn 'model-picker patch skipped (the picker still works, without folding)' }
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
    & node (Join-Path $SrcDir 'tools\install-qwen-app.mjs')
    if ($LASTEXITCODE -ne 0) {
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
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$LocalBin", 'User')
    Write-Info "added $LocalBin to your PATH (new shells only)"
    $script:PathWasChanged = $true
  }
  Write-Ok 'dsh-setup installed (reconfigure / repatch / qwen / doctor)'
}

if (-not $DryRun) {
  try {
    $v = (& dsh --version 2>$null)
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
  } else {
    $dumpLog = Join-Path $env:TEMP 'dsh-dump-config.log'
    $env:DSH_HOME = $DshHome
    & dsh --profile web --dump-config *> $dumpLog
    if ($LASTEXITCODE -eq 0) {
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
if ($script:Missing.Count -gt 0) {
  Write-Host ''
  Write-Host 'Blank credentials - put them in a file and run: dsh-setup reconfigure --secrets <file>' -ForegroundColor DarkGray
  foreach ($m in $script:Missing) { Write-Host "  $m" }
}

if ($script:NodeWasInstalled -or $script:PathWasChanged) {
  Write-Host ''
  Write-Host 'Open a new PowerShell before anything else.' -ForegroundColor Yellow
  if ($script:NodeWasInstalled) { Write-Host '  node was just installed and only new shells see it' }
  if ($script:PathWasChanged)   { Write-Host "  $LocalBin was added to your PATH (that is where dsh-setup lives)" }
}

Write-Host ''
Write-Host 'Next: sign into the Qwen desktop app once - the bridge borrows that session -'
Write-Host '      then run dsh web and pick a model.'
exit $script:Failed
