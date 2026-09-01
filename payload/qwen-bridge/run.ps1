# Keep the Qwen desktop-app bridge alive on Windows.
#
#   powershell -ExecutionPolicy Bypass -File "$HOME\qwen-bridge\run.ps1"
#
# Registered as a logon Scheduled Task by the installer, so it is the Windows
# counterpart of the macOS LaunchAgent. Restarts the bridge if it exits and, when
# a relay key is present, keeps the VPS OmniRoute relay's Qwen signature fresh.
$ErrorActionPreference = 'Continue'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = if ($env:QWEN_BRIDGE_LOG) { $env:QWEN_BRIDGE_LOG } else { Join-Path $dir 'bridge.log' }

function Write-Log([string]$message) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  Add-Content -LiteralPath $log -Value "$stamp $message"
}

# Node: an explicit $env:NODE, then whatever is on PATH. Resolved once, so a
# PATH change mid-session cannot leave the supervisor spinning on a dead binary.
$node = $env:NODE
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  Write-Log 'run.ps1: no usable node found'
  exit 1
}

if (-not $env:QWEN_BRIDGE_PORT) { $env:QWEN_BRIDGE_PORT = '3083' }
if (-not $env:QWEN_CDP_PORT) { $env:QWEN_CDP_PORT = '9222' }

# Credential push: optional. push-creds.mjs exits quietly when no relay key or no
# signed-in app is present, so this job is harmless on a fresh machine.
Start-Job -Name 'qwen-push-creds' -ScriptBlock {
  param($node, $dir, $log)
  Start-Sleep -Seconds 20
  while ($true) {
    & $node (Join-Path $dir 'push-creds.mjs') *>> $log
    Start-Sleep -Seconds 1800
  }
} -ArgumentList $node, $dir, $log | Out-Null

while ($true) {
  & $node (Join-Path $dir 'server-app.mjs') *>> $log
  Write-Log 'supervisor: bridge exited, restarting in 3s'
  Start-Sleep -Seconds 3
}
