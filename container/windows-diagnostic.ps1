# DeepSeek Harness - container diagnostic. Reports back automatically.
& {
  $ErrorActionPreference = 'Continue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
  $lines = New-Object System.Collections.Generic.List[string]
  function A($t) { $lines.Add("$t") | Out-Null; Write-Host $t }
  function DockerOut([string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = @(& docker @Arguments 2>&1)
      return (($out | Where-Object { $_ }) -join [Environment]::NewLine)
    } catch { return "docker failed: $($_.Exception.Message)" } finally { $ErrorActionPreference = $old }
  }

  $name = 'deepseek-harness'
  A ("dsh-cdiag " + (Get-Date -Format s) + "  ps " + $PSVersionTable.PSVersion + "  os " + [Environment]::OSVersion.Version)

  if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    A 'docker: NOT INSTALLED'
  } else {
    A ("docker: " + (DockerOut @('--version')))
    $info = DockerOut @('info', '--format', '{{.ServerVersion}} {{.OSType}}/{{.Architecture}} {{.Driver}}')
    A ("engine: " + $info)
    A ("containers:")
    foreach ($l in (DockerOut @('ps', '-a', '--format', '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}')).Split([Environment]::NewLine)) {
      if ($l) { A ("  " + $l) }
    }
    A ("volumes: " + (DockerOut @('volume', 'ls', '--format', '{{.Name}}')).Replace([Environment]::NewLine, ' '))

    $state = DockerOut @('inspect', '-f', '{{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}}', $name)
    A ("state: " + $state)

    A '--- container log (last 40) ---'
    foreach ($l in (DockerOut @('logs', '--tail', '40', $name)).Split([Environment]::NewLine)) {
      if ($l) { A ("  " + $l) }
    }
  }

  # The web UI, seen the way the browser sees it.
  $url = 'http://127.0.0.1:3080'
  $html = ''
  try {
    $r = Invoke-WebRequest -Uri "$url/" -TimeoutSec 15 -UseBasicParsing
    $html = "$($r.Content)"
    A ("index " + $r.StatusCode + " " + $html.Length + "b")
  } catch { A ("index FAILED " + $_.Exception.Message) }

  if ($html) {
    $k = 'globalThis["__DSH_BOOT__"] = '
    $i = $html.IndexOf($k)
    if ($i -lt 0) { A 'no boot manifest in index' }
    else {
      $s = $i + $k.Length; $d = 0; $x = $s
      for (; $x -lt $html.Length; $x++) {
        $ch = $html[$x]
        if ($ch -eq '{') { $d++ } elseif ($ch -eq '}') { $d--; if ($d -eq 0) { $x++; break } }
      }
      $boot = $html.Substring($s, $x - $s) | ConvertFrom-Json
      $entries = @($boot.entries)
      $ok = 0; $bad = 0
      foreach ($en in $entries) {
        try {
          $br = Invoke-WebRequest -Uri ($url + $en.url) -TimeoutSec 10 -UseBasicParsing
          if ($br.StatusCode -eq 200) { $ok++ } else { $bad++ }
        } catch { $bad++; if ($bad -le 3) { A ("  BAD " + $en.id + " :: " + $_.Exception.Message) } }
      }
      A ("bundles ok " + $ok + " bad " + $bad + " of " + $entries.Count)
    }
  }

  # The Qwen side: the app on this machine, and the bridge inside the container.
  try {
    $q = @(Get-Process -Name 'Qwen' -ErrorAction SilentlyContinue)
    A ("Qwen app processes: " + $q.Count)
  } catch { A 'Qwen app processes: unknown' }
  try {
    $cdp = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5 -UseBasicParsing
    A ("CDP 9222: " + $cdp.StatusCode)
  } catch { A ("CDP 9222: not answering (" + $_.Exception.Message + ")") }
  if ($null -ne (Get-Command docker -ErrorAction SilentlyContinue)) {
    A ("bridge in container: " + (DockerOut @('exec', $name, 'sh', '-c', 'curl -fsS --max-time 4 http://127.0.0.1:3083/health | head -c 200')))
  }

  foreach ($t in @('DeepSeek Harness Update', 'Qwen (debugging port)', 'DSH Web')) {
    try { $ts = Get-ScheduledTask -TaskName $t -ErrorAction Stop; A ("task '" + $t + "' " + $ts.State) }
    catch { A ("task '" + $t + "' MISSING") }
  }

  try {
    Invoke-RestMethod -Uri '__BASE__/report/__TOKEN__' -Method Post -Body ($lines -join [Environment]::NewLine) -ContentType 'text/plain; charset=utf-8' -TimeoutSec 30 | Out-Null
    Write-Host ''
    Write-Host 'Sent. Nothing to copy.' -ForegroundColor Green
  } catch {
    Write-Host ''
    Write-Host ('Could not send: ' + $_.Exception.Message) -ForegroundColor Yellow
  }
}
