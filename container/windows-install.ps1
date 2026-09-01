# Managed DeepSeek Harness - Windows, containerised.
#
# Everything the harness needs is inside one image that was built and verified
# before it ever reached this machine: node, the pinned dsh, all ten plugin
# bundles, the five local plugins, the model-picker patch. Nothing is compiled,
# patched or path-templated here, which is exactly why the native installer kept
# breaking - PowerShell, PATH, npm layout, ESM path semantics and ACLs all differ
# on Windows, and none of them are in the picture any more.
#
# This machine only ever: makes sure Docker is running, pulls the image, and runs
# it with two mounts and its enrollment token.
& {
  $ErrorActionPreference = 'Stop'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

  $base   = '__BASE__'
  $token  = '__TOKEN__'
  $name   = 'deepseek-harness'
  $volume = 'dsh-data'
  $port   = 3080
  $localBin = Join-Path $env:USERPROFILE '.dsh-app'
  $log      = Join-Path $env:TEMP 'dsh-container-install.log'

  function Say($t)  { Write-Host $t }
  function Ok($t)   { Write-Host '  ' -NoNewline; Write-Host '+' -ForegroundColor Green -NoNewline; Write-Host " $t" }
  function Warn($t) { Write-Host '  ' -NoNewline; Write-Host '!' -ForegroundColor Yellow -NoNewline; Write-Host " $t" }
  function Die($t)  { Write-Host ''; Write-Host "error: $t" -ForegroundColor Red; throw $t }

  # Native commands must never be judged by their stderr: Windows PowerShell turns
  # a redirected stderr line into a terminating error under 'Stop', and docker
  # writes progress there.
  function Docker([string[]]$Arguments, [switch]$Quiet) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      if ($Quiet) { & docker @Arguments *> $null } else { & docker @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" } }
      if ($null -eq $LASTEXITCODE) { return 0 }
      return $LASTEXITCODE
    } catch { return 1 } finally { $ErrorActionPreference = $old }
  }
  function DockerOut([string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $lines = @(& docker @Arguments 2>$null)
      return (($lines | Where-Object { $_ }) -join "`n").Trim()
    } catch { return '' } finally { $ErrorActionPreference = $old }
  }

  Say ''
  Say 'DeepSeek Harness'
  Say ("  PowerShell " + $PSVersionTable.PSVersion + "  " + $env:PROCESSOR_ARCHITECTURE)

  # ── 1. Docker ──────────────────────────────────────────────────────────────
  $haveDocker = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
  if (-not $haveDocker) {
    Say ''
    Say '[1/5] Docker Desktop'
    if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) {
      Die 'Docker Desktop is not installed and winget is unavailable. Install Docker Desktop from https://docs.docker.com/desktop/install/windows-install/ and re-run this command.'
    }
    Warn 'installing Docker Desktop - accept the Windows prompt if it appears'
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & winget install --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements 2>&1 |
      ForEach-Object { Write-Host "    $_" }
    $ErrorActionPreference = $old
    $env:Path = ([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))
    if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
      Say ''
      Warn 'Docker Desktop was installed but this shell cannot see it yet.'
      Say 'Start Docker Desktop once (it may ask to restart Windows), then paste this same command again.'
      return
    }
    Ok 'Docker Desktop installed'
  } else {
    Say ''
    Say '[1/5] Docker'
    Ok ((DockerOut @('--version')) -replace 'Docker version ', 'docker ')
  }

  # The engine may be installed but not running; start it and wait.
  if ((Docker @('info') -Quiet) -ne 0) {
    Warn 'starting the Docker engine'
    $roots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) | Where-Object { $_ }
    foreach ($root in $roots) {
      $candidate = Join-Path $root 'Docker\Docker\Docker Desktop.exe'
      if (Test-Path -LiteralPath $candidate) { Start-Process -FilePath $candidate | Out-Null; break }
    }
    $ready = $false
    foreach ($i in 1..60) {
      Start-Sleep -Seconds 5
      if ((Docker @('info') -Quiet) -eq 0) { $ready = $true; break }
    }
    if (-not $ready) { Die 'the Docker engine did not come up. Start Docker Desktop, wait for the whale icon to settle, then paste this command again.' }
  }
  Ok 'Docker engine ready'

  # ── 2. which image ─────────────────────────────────────────────────────────
  Say ''
  Say '[2/5] Release'
  $manifest = Invoke-RestMethod -Uri "$base/manifest.json" -TimeoutSec 30
  if (-not $manifest.image -or -not $manifest.image.reference) {
    Die "this service is not publishing a container image yet (manifest has no image.reference)"
  }
  $image = $manifest.image.reference
  Ok ("image " + $image)

  # ── 3. pull ────────────────────────────────────────────────────────────────
  Say ''
  Say '[3/5] Download'
  Say '      about 1 GB the first time; later updates only fetch what changed.'
  if ((Docker @('pull', $image)) -ne 0) { Die "could not pull $image" }
  Ok 'image ready'

  # ── 4. run ─────────────────────────────────────────────────────────────────
  Say ''
  Say '[4/5] Start'

  # The earlier native install ran its own `dsh web` from a logon task, which
  # would hold port 3080 and make the container fail to bind. Its Qwen bridge and
  # AgentRouter proxy tasks are deliberately left alone: the container reaches
  # both through host.docker.internal, so they are still doing useful work.
  try {
    $stale = Get-ScheduledTask -TaskName 'DSH Web' -ErrorAction Stop
    if ($stale) {
      Stop-ScheduledTask -TaskName 'DSH Web' -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName 'DSH Web' -Confirm:$false -ErrorAction SilentlyContinue
      Warn 'retired the old native web task - the container serves 3080 now'
    }
  } catch { }
  try {
    foreach ($conn in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)) {
      $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
      if ($owner -and $owner.ProcessName -eq 'node') {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        Warn ("stopped a leftover node process holding port " + $port)
      }
    }
  } catch { }

  Docker @('rm', '-f', $name) -Quiet | Out-Null
  $runArgs = @(
    'run', '-d',
    '--name', $name,
    '--restart', 'unless-stopped',
    '-p', ("127.0.0.1:{0}:3080" -f $port),
    '-v', ("{0}:/data" -f $volume),
    '-v', ("{0}:/work" -f $env:USERPROFILE),
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', ("DSH_DIST_BASE={0}" -f $base),
    '-e', ("DSH_DIST_TOKEN={0}" -f $token),
    $image
  )
  if ((Docker $runArgs -Quiet) -ne 0) { Die "could not start the container" }
  Ok ("container " + $name + " started")
  Ok ("your files are mounted at /work (from " + $env:USERPROFILE + ")")

  # ── 5. shortcut + updater ──────────────────────────────────────────────────
  Say ''
  Say '[5/5] Launcher'
  New-Item -ItemType Directory -Force -Path $localBin | Out-Null

  $openPs1 = Join-Path $localBin 'open-harness.ps1'
  Set-Content -LiteralPath $openPs1 -Encoding UTF8 -Value @(
    '# Open the DeepSeek Harness, starting its container first if it is stopped.',
    "`$ErrorActionPreference = 'SilentlyContinue'",
    ('$url  = "http://127.0.0.1:{0}"' -f $port),
    ('$name = "{0}"' -f $name),
    'function Test-Up { try { Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing | Out-Null; return $true } catch { return $false } }',
    'if (-not (Test-Up)) {',
    '  & docker start $name *> $null',
    '  foreach ($i in 1..60) { Start-Sleep -Seconds 2; if (Test-Up) { break } }',
    '}',
    'if (Test-Up) { Start-Process $url }',
    'else {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    "  [System.Windows.Forms.MessageBox]::Show('The harness container is not answering. Open Docker Desktop and check the ' + `$name + ' container.', 'DeepSeek Harness') | Out-Null",
    '}'
  )

  $updatePs1 = Join-Path $localBin 'update-harness.ps1'
  Set-Content -LiteralPath $updatePs1 -Encoding UTF8 -Value @(
    '# Pull the published image and recreate the container. Chats, sessions and',
    '# the task board live in the docker volume, so they survive untouched.',
    "`$ErrorActionPreference = 'Continue'",
    ('$base   = "{0}"' -f $base),
    ('$token  = "{0}"' -f $token),
    ('$name   = "{0}"' -f $name),
    ('$volume = "{0}"' -f $volume),
    ('$port   = {0}' -f $port),
    '$m = Invoke-RestMethod -Uri "$base/manifest.json" -TimeoutSec 30',
    'if (-not $m.image -or -not $m.image.reference) { exit 0 }',
    '$image = $m.image.reference',
    '$before = (& docker image inspect $image --format "{{.Id}}" 2>$null)',
    '& docker pull $image *> $null',
    '$after = (& docker image inspect $image --format "{{.Id}}" 2>$null)',
    '$running = (& docker inspect -f "{{.Config.Image}}" $name 2>$null)',
    'if ($before -eq $after -and $running -eq $image) { exit 0 }',
    '& docker rm -f $name *> $null',
    '& docker run -d --name $name --restart unless-stopped -p ("127.0.0.1:" + $port + ":3080") -v ($volume + ":/data") -v ($env:USERPROFILE + ":/work") --add-host host.docker.internal:host-gateway -e ("DSH_DIST_BASE=" + $base) -e ("DSH_DIST_TOKEN=" + $token) $image *> $null',
    'exit 0'
  )

  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $where = @()
  try {
    $ws = New-Object -ComObject WScript.Shell
    foreach ($folder in @('Desktop', 'Programs')) {
      $dir = [Environment]::GetFolderPath($folder)
      if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
      $sc = $ws.CreateShortcut((Join-Path $dir 'DeepSeek Harness.lnk'))
      $sc.TargetPath       = $psExe
      $sc.Arguments        = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $openPs1)
      $sc.WorkingDirectory = $localBin
      $sc.Description      = 'Open the DeepSeek Harness'
      $sc.Save()
      $where += $(if ($folder -eq 'Programs') { 'Start menu' } else { 'Desktop' })
    }
  } catch { Warn ("could not create the shortcut (" + $_.Exception.Message + ")") }
  if ($where.Count) { Ok ('"DeepSeek Harness" on your ' + ($where -join ' and ')) }

  try {
    $act = New-ScheduledTaskAction -Execute $psExe `
      -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $updatePs1) `
      -WorkingDirectory $localBin
    $trg = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Hours 6))
    )
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'DeepSeek Harness Update' -Action $act -Trigger $trg -Settings $set `
      -Description 'Pulls a newer harness image and recreates the container' -Force | Out-Null
    Ok 'updates checked every 6 hours - a new release is pulled and applied automatically'
  } catch {
    Warn ("could not register the update task (" + $_.Exception.Message + ") - run update-harness.ps1 by hand")
  }

  # ── wait for it, then open ─────────────────────────────────────────────────
  Say ''
  Say '      waiting for the harness to come up'
  $url = "http://127.0.0.1:$port"
  $up = $false
  foreach ($i in 1..90) {
    Start-Sleep -Seconds 2
    try { Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing | Out-Null; $up = $true; break } catch { }
  }
  Say ''
  Say '----------------------------------------'
  if ($up) {
    Write-Host 'Ready.' -ForegroundColor Green
    Say ("  " + $url)
    Start-Process $url
    Say ''
    Say 'From now on: double-click "DeepSeek Harness" on your Desktop.'
  } else {
    Warn 'the harness has not answered yet'
    Say '  docker logs deepseek-harness   shows what it is doing'
  }
  Say ''
  Say 'One manual step, once: sign into the Qwen desktop app on Windows - the'
  Say 'harness reaches it through host.docker.internal for Qwen requests.'
}
