#!/usr/bin/env node
// dsh-dist — the managed DeepSeek Harness distribution service.
//
// One job: let Ayush publish a release from his Mac and have every enrolled
// machine install it, and later update itself, from a single URL. No secrets file
// is ever copied by hand — an enrolled machine fetches its own config with its
// token, over TLS, at install time and on every update.
//
//   GET  /                      one-screen help
//   GET  /health                liveness + current version
//   GET  /manifest.json         { version, published, notes, payload:{url,sha256} }
//   GET  /i/<token>             macOS/Linux bootstrap, token baked in
//   GET  /w/<token>             Windows bootstrap, token baked in
//   GET  /config/<token>        that machine's settings + credentials bundle
//   GET  /payload/<version>.tar.gz
//   POST /admin/release         publish (Bearer ADMIN_TOKEN)
//   POST /admin/enroll          mint an enrollment token (Bearer ADMIN_TOKEN)
//   GET  /admin/enrollments     who is enrolled and when they last checked in
//
// Bound to the docker bridge gateway and loopback only: Traefik terminates TLS
// and is the sole way in from the internet.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = process.env.DIST_ROOT || "/opt/dsh-dist";
const PORT = Number(process.env.DIST_PORT || 8790);
const HOSTS = (process.env.DIST_HOSTS || "172.18.0.1,127.0.0.1").split(",").map((h) => h.trim());
const PUBLIC_BASE = process.env.DIST_PUBLIC_BASE || "https://get.xovi.pro";
const ADMIN_TOKEN = process.env.DIST_ADMIN_TOKEN || "";

const PAYLOAD_DIR = path.join(ROOT, "payloads");
const REPORT_DIR = path.join(ROOT, "reports");
const STATE_FILE = path.join(ROOT, "state.json");
const LOG_FILE = process.env.DIST_LOG || path.join(ROOT, "dist.log");

for (const dir of [ROOT, PAYLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
};

// ---------- state ----------
// { releases: [{version, published, notes, sha256, file}], tokens: {tok: {...}},
//   profiles: {name: {credentials:{}, endpoints:{}}} }
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { releases: [], tokens: {}, profiles: { default: { credentials: {}, endpoints: {} } } };
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, STATE_FILE);
}

let state = loadState();

const currentRelease = () => state.releases[state.releases.length - 1] || null;

// ---------- helpers ----------

function constantEquals(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers.authorization || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented.length > 0 && constantEquals(presented, ADMIN_TOKEN);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Record that a machine checked in, so `admin/enrollments` shows real activity. */
function touchToken(token, extra = {}) {
  const entry = state.tokens[token];
  if (!entry) return null;
  entry.lastSeen = new Date().toISOString();
  entry.checkIns = (entry.checkIns || 0) + 1;
  Object.assign(entry, extra);
  saveState(state);
  return entry;
}

// ---------- bootstrap scripts ----------
// The installer itself lives in the payload. What we serve here is the smallest
// possible shim: fetch the payload the manifest names, verify it, run it. Keeping
// this tiny means a bad release can always be fixed by publishing another one.

function bootstrapSh(token) {
  return `#!/usr/bin/env bash
# Managed DeepSeek Harness — one-line install.
#   curl -fsSL ${PUBLIC_BASE}/i/${token} | bash
set -eu

BASE="${PUBLIC_BASE}"
TOKEN="${token}"
TMP="$(mktemp -d "\${TMPDIR:-/tmp}/dsh-managed-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

bold=''; dim=''; reset=''
if [ -t 1 ]; then bold=$'\\033[1m'; dim=$'\\033[2m'; reset=$'\\033[0m'; fi
printf '%sManaged DeepSeek Harness%s\\n' "$bold" "$reset"

MANIFEST="$(curl -fsSL --max-time 30 "$BASE/manifest.json")" || {
  echo "could not reach $BASE — check the network and try again" >&2; exit 1; }

VERSION="$(printf '%s' "$MANIFEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
URL="$(printf '%s' "$MANIFEST" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
SHA="$(printf '%s' "$MANIFEST" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
[ -n "$VERSION" ] && [ -n "$URL" ] || { echo "manifest looks wrong: $MANIFEST" >&2; exit 1; }
printf '%s  release %s%s\\n' "$dim" "$VERSION" "$reset"

curl -fsSL --max-time 600 "$URL" -o "$TMP/payload.tar.gz" || { echo "download failed: $URL" >&2; exit 1; }

if [ -n "$SHA" ]; then
  GOT="$(shasum -a 256 "$TMP/payload.tar.gz" 2>/dev/null | awk '{print $1}')"
  [ -z "$GOT" ] && GOT="$(sha256sum "$TMP/payload.tar.gz" 2>/dev/null | awk '{print $1}')"
  if [ -n "$GOT" ] && [ "$GOT" != "$SHA" ]; then
    echo "checksum mismatch — refusing to run this download" >&2; exit 1
  fi
fi

mkdir -p "$TMP/payload"
tar xzf "$TMP/payload.tar.gz" -C "$TMP/payload" --strip-components 1 2>/dev/null \\
  || tar xzf "$TMP/payload.tar.gz" -C "$TMP/payload"

[ -f "$TMP/payload/install.sh" ] || { echo "release $VERSION has no install.sh" >&2; exit 1; }

export DSH_MANAGED=1
export DSH_DIST_BASE="$BASE"
export DSH_DIST_TOKEN="$TOKEN"
export DSH_DIST_VERSION="$VERSION"
exec bash "$TMP/payload/install.sh" --managed "$@"
`;
}

function bootstrapPs1(token) {
  // Everything runs inside & { } so nothing leaks into the user's session, and
  // nothing calls exit: `irm | iex` runs in the console the human is typing in,
  // and an exit there closes the window with the error still on it.
  return `# Managed DeepSeek Harness - one-line install.
#   irm ${PUBLIC_BASE}/w/${token} | iex
& {
  $ErrorActionPreference = 'Stop'

  # Windows PowerShell 5.1 still negotiates TLS 1.0 on some builds, and then
  # every https download below dies with "could not create SSL/TLS secure
  # channel". Ask for 1.2 explicitly; 1.3 only where the runtime knows it.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 12288 } catch {}

  $base  = '${PUBLIC_BASE}'
  $token = '${token}'
  $log   = Join-Path $env:TEMP 'dsh-install.log'
  Write-Host 'Managed DeepSeek Harness' -ForegroundColor Cyan
  Write-Host ("  PowerShell " + $PSVersionTable.PSVersion + "  " + $env:PROCESSOR_ARCHITECTURE)

  $tmp = Join-Path $env:TEMP ("dsh-managed-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $keep = $false
  try {
    $manifest = Invoke-RestMethod -Uri "$base/manifest.json" -TimeoutSec 30
    Write-Host ("  release " + $manifest.version)

    $zipUrl = $manifest.payload.url -replace '\\.tar\\.gz$', '.zip'
    $archive = Join-Path $tmp 'payload.zip'
    try {
      Invoke-WebRequest -Uri $zipUrl -OutFile $archive -TimeoutSec 600 -UseBasicParsing
    } catch {
      throw "download failed: $zipUrl - $($_.Exception.Message)"
    }

    if ($manifest.payload.sha256zip) {
      $got = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower()
      if ($got -ne $manifest.payload.sha256zip.ToLower()) { throw 'checksum mismatch - refusing to run this download' }
    }

    $unpack = Join-Path $tmp 'payload'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
    $inner = Get-ChildItem -LiteralPath $unpack -Directory | Select-Object -First 1
    $root = if ($inner -and (Test-Path (Join-Path $inner.FullName 'install.ps1'))) { $inner.FullName } else { $unpack }
    if (-not (Test-Path (Join-Path $root 'install.ps1'))) { throw "release $($manifest.version) has no install.ps1" }

    $env:DSH_MANAGED      = '1'
    $env:DSH_DIST_BASE    = $base
    $env:DSH_DIST_TOKEN   = $token
    $env:DSH_DIST_VERSION = $manifest.version

    # Prefer PowerShell 7 when the machine has it. -ExecutionPolicy Bypass is
    # not optional: a default Windows client is Restricted and refuses to run
    # any .ps1 from disk, signed or not.
    $pwsh  = Get-Command pwsh -ErrorAction SilentlyContinue
    $shell = if ($pwsh) { $pwsh.Source } else { 'powershell' }
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'install.ps1') -Managed
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      $keep = $true
      Write-Host ''
      Write-Host ("the installer stopped with exit code " + $code) -ForegroundColor Red
      if (Test-Path -LiteralPath $log) { Write-Host ("  full log: " + $log) -ForegroundColor Yellow }
    }
  } catch {
    $keep = $true
    Write-Host ''
    Write-Host ("install failed: " + $_.Exception.Message) -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    if (Test-Path -LiteralPath $log) { Write-Host ("  full log: " + $log) -ForegroundColor Yellow }
  } finally {
    if (-not $keep) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Host ("  working copy kept at " + $tmp) -ForegroundColor DarkGray }
  }
}
`;
}

const HELP = `dsh-dist — managed DeepSeek Harness distribution

  install (macOS/Linux)   curl -fsSL ${PUBLIC_BASE}/i/<token> | bash
  install (Windows)       irm ${PUBLIC_BASE}/w/<token> | iex
  current release         ${PUBLIC_BASE}/manifest.json

Enrollment tokens are issued by the operator. An enrolled machine fetches its own
configuration over TLS at install time and on every update, so no credential file
is ever copied by hand.
`;

// ---------- windows diagnostic ----------
// One line for the human: it inspects the running web UI the way the browser
// does, then posts the findings here. Nothing to read, nothing to paste.

const DIAG_PS1 = [
  "# DeepSeek Harness - Windows diagnostic. Reports back automatically.",
  "& {",
  "  $ErrorActionPreference = 'Continue'",
  "  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}",
  "  $lines = New-Object System.Collections.Generic.List[string]",
  "  function A($t) { $lines.Add(\"$t\") | Out-Null; Write-Host $t }",
  "  function Test-Port {",
  "    $c = New-Object Net.Sockets.TcpClient",
  "    try { $c.Connect('127.0.0.1', 3080); $c.Close(); return $true } catch { return $false }",
  "  }",
  "",
  "  A (\"dsh-diag2 \" + (Get-Date -Format s) + \"  ps \" + $PSVersionTable.PSVersion + \"  os \" + [Environment]::OSVersion.Version)",
  "",
  "  $userHome = $env:USERPROFILE",
  "  $dshHome  = Join-Path $userHome '.dsh'",
  "  A (\"--- \" + $dshHome)",
  "  foreach ($f in (Get-ChildItem -LiteralPath $dshHome -Force -ErrorAction SilentlyContinue)) {",
  "    if ($f.PSIsContainer) { A (\"  \" + $f.Name + \"\\\") } else { A (\"  \" + $f.Name + \"  \" + $f.Length + \"b\") }",
  "  }",
  "",
  "  $dsh = Join-Path $env:APPDATA 'npm\\dsh.cmd'",
  "  if (-not (Test-Path -LiteralPath $dsh)) { $dsh = Join-Path $userHome '.local\\bin\\dsh.cmd' }",
  "  A (\"dsh \" + $dsh + \" exists \" + (Test-Path -LiteralPath $dsh))",
  "  A (\"already listening on 3080: \" + (Test-Port))",
  "",
  "  # The page loads and then the bundle requests fail, so the server is dying",
  "  # seconds after it starts. Run it in the foreground with its output captured -",
  "  # its own stderr is the answer.",
  "  $o = Join-Path $env:TEMP 'dsh-web-out.log'",
  "  $e = Join-Path $env:TEMP 'dsh-web-err.log'",
  "  Remove-Item -LiteralPath $o -Force -ErrorAction SilentlyContinue",
  "  Remove-Item -LiteralPath $e -Force -ErrorAction SilentlyContinue",
  "  $env:DSH_HOME = $dshHome",
  "  $proc = $null",
  "  try {",
  "    $proc = Start-Process -FilePath $dsh -ArgumentList 'web' -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e",
  "    A (\"started pid \" + $proc.Id)",
  "  } catch { A (\"could not start: \" + $_.Exception.Message) }",
  "",
  "  $upAt = -1",
  "  for ($i = 1; $i -le 50; $i++) {",
  "    Start-Sleep -Milliseconds 800",
  "    if (Test-Port) { $upAt = $i; break }",
  "  }",
  "  A (\"port came up at poll \" + $upAt + \" (of 50, 0.8s each)\")",
  "",
  "  if ($upAt -ge 0) {",
  "    try {",
  "      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -TimeoutSec 15 -UseBasicParsing",
  "      $html = \"$($r.Content)\"",
  "      A (\"index \" + $r.StatusCode + \" \" + $html.Length + \"b\")",
  "      $k = 'globalThis[\"__DSH_BOOT__\"] = '",
  "      $i2 = $html.IndexOf($k)",
  "      if ($i2 -lt 0) { A \"no boot manifest in index\" }",
  "      else {",
  "        $s = $i2 + $k.Length; $d = 0; $x = $s",
  "        for (; $x -lt $html.Length; $x++) {",
  "          $ch = $html[$x]",
  "          if ($ch -eq '{') { $d++ } elseif ($ch -eq '}') { $d--; if ($d -eq 0) { $x++; break } }",
  "        }",
  "        $boot = $html.Substring($s, $x - $s) | ConvertFrom-Json",
  "        $entries = @($boot.entries)",
  "        A (\"boot entries \" + $entries.Count)",
  "        $ok = 0; $bad = 0",
  "        foreach ($en in $entries) {",
  "          try {",
  "            $br = Invoke-WebRequest -Uri ('http://127.0.0.1:3080' + $en.url) -TimeoutSec 10 -UseBasicParsing",
  "            if ($br.StatusCode -eq 200) { $ok++ } else { $bad++ }",
  "          } catch {",
  "            $bad++",
  "            if ($bad -le 3) { A (\"  BAD \" + $en.id + \" :: \" + $_.Exception.Message) }",
  "          }",
  "        }",
  "        A (\"bundles ok \" + $ok + \" bad \" + $bad)",
  "      }",
  "    } catch { A (\"index FAILED \" + $_.Exception.Message) }",
  "",
  "    Start-Sleep -Seconds 6",
  "    A (\"port still up 6s later: \" + (Test-Port))",
  "  }",
  "",
  "  if ($proc) {",
  "    $gone = $false",
  "    try { $gone = $proc.HasExited } catch { }",
  "    A (\"launcher process exited: \" + $gone)",
  "    if ($gone) { try { A (\"  exit code \" + $proc.ExitCode) } catch { } }",
  "  }",
  "  $nodes = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' })",
  "  A (\"dsh node processes now \" + $nodes.Count)",
  "",
  "  if (Test-Path -LiteralPath $o) {",
  "    A (\"--- stdout \" + (Get-Item -LiteralPath $o).Length + \"b\")",
  "    foreach ($l in (Get-Content -LiteralPath $o -Tail 40 -ErrorAction SilentlyContinue)) { A (\"  \" + $l) }",
  "  } else { A \"--- stdout missing\" }",
  "  if (Test-Path -LiteralPath $e) {",
  "    A (\"--- stderr \" + (Get-Item -LiteralPath $e).Length + \"b\")",
  "    foreach ($l in (Get-Content -LiteralPath $e -Tail 40 -ErrorAction SilentlyContinue)) { A (\"  \" + $l) }",
  "  } else { A \"--- stderr missing\" }",
  "",
  "  if ($proc) { try { & taskkill /PID $proc.Id /T /F *> $null } catch { } }",
  "",
  "  try {",
  "    Invoke-RestMethod -Uri '__BASE__/report/__TOKEN__' -Method Post -Body ($lines -join [Environment]::NewLine) -ContentType 'text/plain; charset=utf-8' -TimeoutSec 30 | Out-Null",
  "    Write-Host ''",
  "    Write-Host 'Sent. Nothing to copy.' -ForegroundColor Green",
  "  } catch {",
  "    Write-Host ''",
  "    Write-Host ('Could not send: ' + $_.Exception.Message) -ForegroundColor Yellow",
  "  }",
  "}"
].join("\n") + "\n";

// One line for the human: it runs the web server with its output captured, walks
// every plugin bundle the browser would fetch, then posts the findings here.
function diagPs1(token) {
  return DIAG_PS1.split("__BASE__").join(PUBLIC_BASE).split("__TOKEN__").join(token);
}

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://dist.local");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (route === "/" && req.method === "GET") return send(res, 200, HELP);

    if (route === "/health" && req.method === "GET") {
      const rel = currentRelease();
      return send(res, 200, {
        ok: true,
        version: rel?.version ?? null,
        releases: state.releases.length,
        enrolled: Object.keys(state.tokens).length,
      });
    }

    if (route === "/manifest.json" && req.method === "GET") {
      const rel = currentRelease();
      if (!rel) return send(res, 503, { error: "no release published yet" });
      return send(res, 200, {
        version: rel.version,
        published: rel.published,
        notes: rel.notes ?? "",
        payload: {
          url: `${PUBLIC_BASE}/payload/${rel.version}.tar.gz`,
          sha256: rel.sha256,
          sha256zip: rel.sha256zip ?? null,
        },
      });
    }

    // Bootstrap shims, token baked in.
    let m = /^\/(i|w)\/([A-Za-z0-9_-]{8,64})$/.exec(route);
    if (m && req.method === "GET") {
      const [, kind, token] = m;
      if (!state.tokens[token]) return send(res, 404, "unknown or revoked enrollment token\n");
      touchToken(token, { lastBootstrap: new Date().toISOString() });
      log("bootstrap", kind, token.slice(0, 8), req.headers["user-agent"] || "");
      return send(res, 200, kind === "i" ? bootstrapSh(token) : bootstrapPs1(token), {
        "content-type": "text/plain; charset=utf-8",
      });
    }

    // A machine's own configuration. This is the whole point: keys travel over
    // TLS to an enrolled machine, never through a file the human carries.
    // A one-line Windows diagnostic that posts its own findings back, so the
    // human runs one command and copies nothing.
    m = /^\/diag\/([A-Za-z0-9_-]{8,64})$/.exec(route);
    if (m && req.method === "GET") {
      const token = m[1];
      if (!state.tokens[token]) return send(res, 404, "unknown or revoked enrollment token\n");
      log("diag", token.slice(0, 8), req.headers["user-agent"] || "");
      return send(res, 200, diagPs1(token), { "content-type": "text/plain; charset=utf-8" });
    }

    m = /^\/report\/([A-Za-z0-9_-]{8,64})$/.exec(route);
    if (m && req.method === "POST") {
      const token = m[1];
      if (!state.tokens[token]) return send(res, 404, { error: "unknown or revoked enrollment token" });
      const body = (await readBody(req, 512 * 1024)).toString("utf8");
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const file = path.join(REPORT_DIR, `${token.slice(0, 8)}-${Date.now()}.txt`);
      fs.writeFileSync(file, body);
      touchToken(token, { lastReport: new Date().toISOString() });
      log("report", token.slice(0, 8), `${body.length}b`);
      return send(res, 200, { ok: true, bytes: body.length });
    }


    if (m && req.method === "GET") {
      const token = m[1];
      const entry = state.tokens[token];
      if (!entry) return send(res, 404, { error: "unknown or revoked enrollment token" });
      const profile = state.profiles[entry.profile] || state.profiles.default || {};
      touchToken(token, { lastConfig: new Date().toISOString() });
      log("config", token.slice(0, 8), "profile", entry.profile);
      return send(res, 200, {
        enrollment: { name: entry.name ?? null, profile: entry.profile ?? "default" },
        credentials: profile.credentials ?? {},
        endpoints: profile.endpoints ?? {},
      });
    }

    m = /^\/payload\/([A-Za-z0-9._-]+\.(?:tar\.gz|zip))$/.exec(route);
    if (m && req.method === "GET") {
      const file = path.join(PAYLOAD_DIR, m[1]);
      if (!file.startsWith(PAYLOAD_DIR) || !fs.existsSync(file)) return send(res, 404, "no such payload\n");
      const stat = fs.statSync(file);
      // Logged so a failed install can be placed: bootstrap only = it died before
      // the download, bootstrap + payload = it died inside install.{sh,ps1}.
      log("payload", m[1], req.headers["user-agent"] || "");
      res.writeHead(200, {
        "content-type": m[1].endsWith(".zip") ? "application/zip" : "application/gzip",
        "content-length": stat.size,
        "cache-control": "public, max-age=86400",
      });
      return fs.createReadStream(file).pipe(res);
    }

    // ---------- admin ----------

    if (route.startsWith("/admin/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "admin token required" });

      if (route === "/admin/enrollments" && req.method === "GET") {
        return send(res, 200, {
          profiles: Object.keys(state.profiles),
          tokens: Object.entries(state.tokens).map(([token, v]) => ({
            token: `${token.slice(0, 8)}…`,
            fullToken: token,
            ...v,
          })),
        });
      }

      if (route === "/admin/enroll" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const token = body.token || randomBytes(18).toString("base64url");
        state.tokens[token] = {
          name: body.name || "unnamed machine",
          profile: body.profile || "default",
          created: new Date().toISOString(),
          checkIns: 0,
        };
        saveState(state);
        log("enrolled", token.slice(0, 8), state.tokens[token].name);
        return send(res, 200, {
          token,
          install: {
            macos: `curl -fsSL ${PUBLIC_BASE}/i/${token} | bash`,
            windows: `irm ${PUBLIC_BASE}/w/${token} | iex`,
          },
        });
      }

      if (route === "/admin/revoke" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const existed = Boolean(state.tokens[body.token]);
        delete state.tokens[body.token];
        saveState(state);
        return send(res, 200, { revoked: existed });
      }

      if (route === "/admin/profile" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        if (!body.name) return send(res, 400, { error: "name required" });
        state.profiles[body.name] = {
          credentials: body.credentials ?? {},
          endpoints: body.endpoints ?? {},
        };
        saveState(state);
        log("profile saved", body.name, Object.keys(body.credentials ?? {}).length, "creds");
        return send(res, 200, { saved: body.name });
      }

      // Publish: the tarball (and optional zip) arrive as raw bytes, metadata in
      // the query string, so `curl --data-binary @file` is enough to release.
      if (route === "/admin/release" && req.method === "POST") {
        const version = url.searchParams.get("version");
        const notes = url.searchParams.get("notes") || "";
        const kind = url.searchParams.get("kind") || "tar.gz";
        if (!version || !/^[A-Za-z0-9._-]+$/.test(version)) {
          return send(res, 400, { error: "version required (safe characters only)" });
        }
        const bytes = await readBody(req);
        if (bytes.length < 1024) return send(res, 400, { error: "payload too small" });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const file = path.join(PAYLOAD_DIR, `${version}.${kind === "zip" ? "zip" : "tar.gz"}`);
        fs.writeFileSync(file, bytes);

        let rel = state.releases.find((r) => r.version === version);
        if (!rel) {
          rel = { version, published: new Date().toISOString(), notes };
          state.releases.push(rel);
        }
        if (notes) rel.notes = notes;
        if (kind === "zip") rel.sha256zip = sha;
        else rel.sha256 = sha;
        // Republishing an older version makes it current again, which is how a
        // rollback works: publish the previous tarball under a new version.
        state.releases = state.releases.filter((r) => r.version !== version).concat(rel);
        saveState(state);
        log("released", version, kind, `${(bytes.length / 1048576).toFixed(1)}MB`, sha.slice(0, 12));
        return send(res, 200, { version, kind, sha256: sha, bytes: bytes.length });
      }

      return send(res, 404, { error: "unknown admin route" });
    }

    return send(res, 404, "not found\n");
  } catch (err) {
    log("ERROR", route, err?.message || String(err));
    return send(res, 500, { error: err?.message || "internal error" });
  }
});

let listening = 0;
for (const host of HOSTS) {
  const s = host === HOSTS[0] ? server : http.createServer(server.listeners("request")[0]);
  s.on("error", (err) => log("listen", host, "failed:", err.message));
  s.listen(PORT, host, () => {
    listening += 1;
    log(`listening on ${host}:${PORT} -> ${PUBLIC_BASE}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(0));
}
