#!/usr/bin/env node
// Windows bootstrap — what container/entrypoint.sh does, in Node, with no bash.
//
// The container proved the right shape: everything decidable at BUILD time is
// baked, and first run only turns a generic tree into THIS machine's harness.
// This keeps that split exactly, minus Docker:
//
//   app  owns  <root>/baked/{profiles,.agent-presets}   replaced by an update
//   user owns  <root>/home/.dsh/{sessions,storages,task-board,logs}   never touched
//
// Three container-only workarounds are deliberately GONE, because natively they
// are not problems: no socat relay (dsh binds 3080 itself), no
// host.docker.internal (127.0.0.1 really is the host), no root-owned volume.
//
// One Windows-specific rule that cost five releases to learn: a local plugin's
// `name:` must be a file:// URL. A bare C:\... or C:/... path makes Node throw
// ERR_UNSUPPORTED_ESM_URL_SCHEME on the drive letter, every plugin fails to
// import, and `dsh web` serves one page and dies. DSHX_PROFILE_WEB is therefore
// a URL, not a path, and that is the only value in here that is.
//
//   node bootstrap.mjs                  configure, then supervise dsh web
//   node bootstrap.mjs --configure-only  render config and exit
//   node bootstrap.mjs --no-supervise    run dsh web in the foreground (CI)
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

const APP = path.join(ROOT, "app");
const BAKED = path.join(ROOT, "baked");
const INSTALLER = path.join(ROOT, "installer");
const HOME_ROOT = path.join(ROOT, "home");
const DSH_HOME = process.env.DSH_HOME || path.join(HOME_ROOT, ".dsh");
const PORT = Number(process.env.DSH_WEB_PORT || 3080);
const BASE = process.env.DSH_DIST_BASE || "";
const TOKEN = process.env.DSH_DIST_TOKEN || "";
const VERSION = readIfExists(path.join(ROOT, "version.txt")).trim() || "dev";

const ok = (t) => console.log(`  + ${t}`);
const warn = (t) => console.log(`  ! ${t}`);
const say = (t) => console.log(t);

function readIfExists(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Node's own node.exe when we were launched by it; the bundled runtime otherwise. */
function nodeExe() {
  const bundled = path.join(ROOT, "runtime", "node", "node.exe");
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}

/**
 * The dsh entry script, resolved from the installed package rather than assumed:
 * the `bin` field has moved between releases and a wrong guess is a silent death.
 */
function dshEntry() {
  const pkgDir = path.join(APP, "node_modules", "@deepseek-ai", "dsh");
  const pkgFile = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgFile)) {
    throw new Error(`the harness is not installed at ${pkgDir}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
  if (!rel) throw new Error("the installed @deepseek-ai/dsh declares no bin entry");
  const entry = path.join(pkgDir, rel);
  if (!fs.existsSync(entry)) throw new Error(`the harness entry ${entry} is missing`);
  return entry;
}

/** A file:// URL for an absolute Windows path. The one value dsh must not see as a path. */
function fileUrl(p) {
  return `file:///${p.split(path.sep).join("/").replace(/^\/+/, "")}`;
}

function mkdirp(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Replace dest with src, like `rsync -a --delete`. Only ever called on app-owned dirs. */
function mirror(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: false });
  return true;
}

/**
 * Best-effort "only this user can read it". fs.chmod on Windows moves the
 * read-only bit and nothing else, so the real ACL is set with icacls; a failure
 * is not fatal because the file still lives under the user's own profile.
 */
function lockDown(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not meaningful on NTFS */
  }
  if (process.platform !== "win32") return;
  const who = process.env.USERNAME ? `${process.env.USERDOMAIN ?? "."}\\${process.env.USERNAME}` : null;
  if (!who) return;
  spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${who}:F`], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function portOpen(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function render(template, out, env) {
  const res = spawnSync(nodeExe(), [path.join(INSTALLER, "tools", "render.mjs"), template, out], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(`render ${path.basename(template)} failed: ${(res.stderr || "").trim()}`);
  }
}

// ── 1. the shape on disk ─────────────────────────────────────────────────────

say(`DeepSeek Harness  version ${VERSION}`);
for (const d of ["logs", "sessions", "storages", "task-board"]) mkdirp(DSH_HOME, d);

// ── 2. the app's half of the home ────────────────────────────────────────────
// Refreshed exactly when the installed version changes, and never reading or
// writing anything the user owns.
const stamp = path.join(DSH_HOME, ".app-version");
const current = readIfExists(stamp).trim();
if (current !== VERSION) {
  if (current) say(`  updating profile: ${current} -> ${VERSION}`);
  mirror(path.join(BAKED, "profiles"), path.join(DSH_HOME, "profiles"));
  mirror(path.join(BAKED, ".agent-presets"), path.join(DSH_HOME, ".agent-presets"));
  fs.writeFileSync(stamp, `${VERSION}\n`);
  ok(`profile and presets from ${VERSION}`);
} else {
  ok(`profile already at ${VERSION}`);
}
mkdirp(DSH_HOME, ".agent-presets", "opus-qwen");

// ── 3. this machine's configuration ──────────────────────────────────────────
// Credentials arrive over TLS keyed to the enrollment token, every start, so
// rotating a key needs a restart rather than a reinstall.
const fetched = { credentials: {}, endpoints: {} };
if (BASE && TOKEN) {
  try {
    const res = await fetch(`${BASE}/config/${TOKEN}`, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bundle = await res.json();
    fetched.credentials = bundle.credentials ?? {};
    fetched.endpoints = bundle.endpoints ?? {};
    ok("configuration fetched for this machine");
  } catch (error) {
    warn(`could not reach ${BASE} (${error.message}) — using what is already on disk`);
  }
}

// An explicit environment value wins, exactly as `docker run -e` did.
const conf = {};
for (const group of [fetched.credentials, fetched.endpoints]) {
  for (const [key, value] of Object.entries(group)) {
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    conf[key] = process.env[key] || String(value);
  }
}
const get = (key) => process.env[key] || conf[key] || "";
if (!get("QWEN_BRIDGE_KEY")) conf.QWEN_BRIDGE_KEY = "local-bridge-no-key-needed";

// ── 4. settings.yaml ─────────────────────────────────────────────────────────
// No sed pass afterwards: the template already points at 127.0.0.1:3083 and
// :3081, which is exactly right when the harness is not in a container.
const settings = path.join(DSH_HOME, "settings.yaml");
render(path.join(INSTALLER, "payload", "settings.template.yaml"), settings, {
  DSHX_TABITOKEN_BASE_URL: get("TABITOKEN_BASE_URL"),
  DSHX_OMNIROUTE_BASE_URL: get("OMNIROUTE_BASE_URL"),
  DSHX_QWEN_OMNI_NODE_ID: get("QWEN_OMNI_NODE_ID"),
});
const providers = (readIfExists(settings).match(/^ {4}[a-z0-9-]+:$/gm) || []).length;
ok(`settings.yaml — ${providers} providers, host services on 127.0.0.1`);

// ── 5. credentials ───────────────────────────────────────────────────────────
// An empty ref is a hard error in dsh ("remove the key instead"), so a key we do
// not have is absent rather than declared blank.
const CRED_KEYS = [
  "TABITOKEN_API_KEY",
  "OMNIROUTER_API_KEY",
  "OPENROUTER_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "AGENTROUTER_API_KEY",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "QWEN_BRIDGE_KEY",
  "AGY_BRIDGE_KEY",
];
const ENV_KEYS = ["META_ADS_BRIDGE_TOKEN", "HOSTINGER_API_TOKEN", "HOSTINGER_MAIL_API_TOKEN"];

const credFile = path.join(DSH_HOME, ".credentials.yaml");
fs.writeFileSync(
  credFile,
  ["version: 1", "refs:", ...CRED_KEYS.filter(get).map((k) => `  ${k}: ${get(k)}`), ""].join("\n"),
);
lockDown(credFile);

const envFile = path.join(DSH_HOME, ".env");
fs.writeFileSync(
  envFile,
  [
    "# Rendered on every start from the enrollment bundle.",
    ...ENV_KEYS.filter(get).map((k) => `${k}=${get(k)}`),
    "",
  ].join("\n"),
);
lockDown(envFile);
ok(`${[...CRED_KEYS, ...ENV_KEYS].filter(get).length} of 12 credentials present`);

// ── 6. MCP rows and the agent preset ─────────────────────────────────────────
const profileWeb = path.join(DSH_HOME, "profiles", "web");
const hostingerDir = mkdirp(DSH_HOME, "hostinger-mcp");
if (get("HOSTINGER_MAIL_API_TOKEN")) {
  const f = path.join(hostingerDir, ".env");
  fs.writeFileSync(f, `HOSTINGER_MAIL_API_TOKEN=${get("HOSTINGER_MAIL_API_TOKEN")}\n`);
  lockDown(f);
}

const templateEnv = {
  // A URL, not a path — see the header.
  DSHX_PROFILE_WEB: fileUrl(profileWeb),
  DSHX_DSH_HOME: DSH_HOME,
  DSHX_HOME: process.env.USERPROFILE || HOME_ROOT,
  DSHX_NODE: nodeExe(),
  DSHX_META_ADS_BRIDGE_TOKEN: get("META_ADS_BRIDGE_TOKEN"),
  DSHX_META_ADS_BRIDGE_URL: get("META_ADS_BRIDGE_URL"),
  DSHX_META_ADS_ENABLED: get("META_ADS_BRIDGE_TOKEN") && get("META_ADS_BRIDGE_URL") ? "1" : "",
  DSHX_HOSTINGER_API_TOKEN: get("HOSTINGER_API_TOKEN"),
  DSHX_HOSTINGER_MAIL_API_TOKEN: get("HOSTINGER_MAIL_API_TOKEN"),
  DSHX_HOSTINGER_DIR: hostingerDir.split(path.sep).join("/"),
  // A YAML-safe JSON string literal, so a backslash path cannot break the row.
  DSHX_HOSTINGER_ENV_JSON: JSON.stringify(path.join(hostingerDir, ".env")),
  DSHX_HOSTINGER_MCP_BIN: "hostinger-mail-mcp",
  // Multilogin is a macOS desktop bridge; the row disables itself when empty.
  DSHX_MULTILOGIN_DIR: "",
  DSHX_MULTILOGIN_SERVER_JSON: '""',
};

render(
  path.join(INSTALLER, "payload", "profile-web", "cordis.patch.template.yml"),
  path.join(profileWeb, "cordis.patch.yml"),
  templateEnv,
);
ok("MCP rows rendered");

const presetDir = mkdirp(DSH_HOME, ".agent-presets", "opus-qwen");
const presetSrc = path.join(INSTALLER, "payload", "agent-presets", "opus-qwen");
if (fs.existsSync(path.join(presetSrc, "preset.yml"))) {
  fs.copyFileSync(path.join(presetSrc, "preset.yml"), path.join(presetDir, "preset.yml"));
  render(
    path.join(presetSrc, "agent.cordis.template.yml"),
    path.join(presetDir, "agent.cordis.yml"),
    templateEnv,
  );
  ok("opus-qwen preset rendered");
}

if (args.has("--configure-only")) {
  say("");
  ok("configured");
  process.exit(0);
}

// ── 7. the Qwen bridge ───────────────────────────────────────────────────────
// The Qwen desktop app must run on Windows (a human signs into it), but the
// bridge that drives it is ours. Natively it reaches the app's debugging port on
// plain 127.0.0.1:9222 — no gateway indirection, no sed pass over settings.yaml.
const bridgeSrc = path.join(INSTALLER, "payload", "qwen-bridge");
if (process.env.DSH_NO_QWEN_BRIDGE !== "1" && fs.existsSync(path.join(bridgeSrc, "server-app.mjs"))) {
  if (await portOpen(3083)) {
    ok("Qwen bridge already answering on 3083");
  } else {
    const bridgeDir = mkdirp(DSH_HOME, "qwen-bridge");
    for (const f of fs.readdirSync(bridgeSrc)) {
      if (f.endsWith(".mjs")) fs.copyFileSync(path.join(bridgeSrc, f), path.join(bridgeDir, f));
    }
    const logFd = fs.openSync(path.join(DSH_HOME, "logs", "qwen-bridge.log"), "a");
    const child = spawn(nodeExe(), ["server-app.mjs"], {
      cwd: bridgeDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        QWEN_CDP_HOST: "127.0.0.1",
        QWEN_BRIDGE_HOST: "127.0.0.1",
        QWEN_BRIDGE_PORT: "3083",
        QWEN_BRIDGE_KEY: get("QWEN_BRIDGE_KEY"),
      },
    });
    child.unref();
    ok("Qwen bridge started (drives the desktop app on 127.0.0.1:9222)");
  }
}

// ── 8. serve ─────────────────────────────────────────────────────────────────
// The harness only ever listens on loopback, which is its own rule and ours too.
const entry = dshEntry();
const dshArgs = [
  entry,
  "--profile",
  "web",
  "--host",
  "127.0.0.1",
  "--port",
  String(PORT),
  "--no-open",
  "--trusted-host",
  "localhost",
];
const childEnv = { ...process.env, ...conf, DSH_HOME };

say("");
say(`  http://127.0.0.1:${PORT}`);

if (args.has("--no-supervise")) {
  const res = spawnSync(nodeExe(), dshArgs, { env: childEnv, stdio: "inherit", windowsHide: true });
  process.exit(res.status ?? 1);
}

// Otherwise be the supervisor. This is the native equivalent of
// `--restart unless-stopped`: if the harness dies, bring it back, but never in a
// tight loop, and stop for good when Windows is shutting this task down.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    process.exit(0);
  });
}

const logFile = path.join(DSH_HOME, "logs", "harness.log");
let backoff = 1000;
while (!stopping) {
  const started = Date.now();
  const fd = fs.openSync(logFile, "a");
  const res = spawnSync(nodeExe(), dshArgs, {
    env: childEnv,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  fs.closeSync(fd);
  if (stopping) break;
  const ranFor = Date.now() - started;
  // A crash inside the first ten seconds is a real fault, not a restart; back off
  // so a broken release cannot spin the CPU, and leave the reason in the log.
  backoff = ranFor > 10000 ? 1000 : Math.min(backoff * 2, 60000);
  warn(`the harness exited (code ${res.status ?? "signal"}) — restarting in ${backoff / 1000}s`);
  await new Promise((r) => setTimeout(r, backoff));
}
