#!/usr/bin/env node
// Pushes a fresh Qwen web-session credential to the VPS relay.
//
// The relay can reuse a signature for a long time but not forever, so this runs
// on a timer from run.sh. It reads the cookie jar + JWT straight out of the Qwen
// desktop app, captures a live `bx-*` triple by watching one real request the app
// makes, and pipes the bundle to the relay's admin endpoint over SSH — the relay
// listens only on loopback and the docker bridge, so nothing is exposed publicly
// and the credential never crosses the internet unencrypted.
//
//   node ~/qwen-bridge/push-creds.mjs            # capture + push
//   node ~/qwen-bridge/push-creds.mjs --dry-run  # capture only, show shape
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CDP = Number(process.env.QWEN_CDP_PORT || 9222);
const BRIDGE = process.env.QWEN_BRIDGE_URL || "http://127.0.0.1:3083";
// Set QWEN_RELAY_SSH (user@host) to push a fresh signature to your own relay.
const VPS = process.env.QWEN_RELAY_SSH || "";
const RELAY = process.env.QWEN_RELAY_URL || "http://127.0.0.1:3099";
const KEY_FILE = process.env.QWEN_RELAY_KEY_FILE
  || path.join(os.homedir(), "qwen-bridge", ".relay-key");

// The desktop app's cookie jar lives in the platform's per-user app-data dir.
function cookieJarPath() {
  if (process.env.QWEN_COOKIES) return process.env.QWEN_COOKIES;
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Qwen", "Cookies");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Qwen", "Cookies");
  }
  const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(cfg, "Qwen", "Cookies");
}

const COOKIES = cookieJarPath();
const dry = process.argv.includes("--dry-run");
const log = (...a) => console.log(new Date().toISOString(), "[push-creds]", ...a);

// This whole script is OPTIONAL: it only keeps the VPS OmniRoute relay's Qwen
// signature fresh. On a machine with no relay key configured there is nothing to
// push, so exit quietly instead of crashing the supervisor loop every 30 min.
if (!dry && !VPS) {
  log("no QWEN_RELAY_SSH configured - skipping (local bridge is unaffected)");
  process.exit(0);
}
if (!dry && !fs.existsSync(KEY_FILE)) {
  log("no relay key at", KEY_FILE, "- skipping (local bridge is unaffected)");
  process.exit(0);
}
if (!fs.existsSync(COOKIES)) {
  log("no Qwen cookie jar at", COOKIES, "- app not signed in yet, skipping");
  process.exit(0);
}

// ---- cookie jar + JWT straight from the app's (plaintext) store ----
function readSession() {
  const tmp = path.join(os.tmpdir(), `qwen-cookies-${process.pid}.db`);
  fs.copyFileSync(COOKIES, tmp);
  try {
    const out = execFileSync("sqlite3", [tmp, "select name||'='||value from cookies where host_key like '%qwen.ai%' and value<>''"], {
      encoding: "utf8",
    });
    const pairs = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const cookie = pairs.join("; ");
    const token = (pairs.find((p) => p.startsWith("token=")) || "").slice(6);
    return { cookie, token };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---- live bx-* triple, captured from a real request the app sends ----
async function captureSignature() {
  const targets = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
  const t = targets.find((x) => (x.url || "").includes("chat.qwen.ai"));
  if (!t) throw new Error("Qwen app is not running with a debugging port");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  let headers = null, feVersion = null, ua = null;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
    if (m.method === "Network.requestWillBeSent" && (m.params.request.url || "").includes("/chat/completions")) {
      headers = m.params.request.headers;
    }
  });
  await send("Network.enable");
  // The cheapest way to make the app sign something is one tiny bridge request.
  await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3.8-max", stream: false, messages: [{ role: "user", content: "ok" }] }),
  }).catch(() => {});
  for (let i = 0; i < 40 && !headers; i++) await new Promise((r) => setTimeout(r, 300));
  if (!headers) throw new Error("no signed request observed — is the bridge running?");
  const bx = {};
  for (const k of Object.keys(headers)) if (/^bx-/i.test(k)) bx[k] = headers[k];
  feVersion = headers.Version || headers.version || null;
  ua = headers["User-Agent"] || headers["user-agent"] || null;
  ws.close();
  if (!bx["bx-ua"]) throw new Error("captured headers carried no bx-ua");
  return { bx, version: feVersion, ua };
}

const { cookie, token } = readSession();
if (!cookie || !token) throw new Error("no cookie/token in the Qwen app store — is it signed in?");
const { bx, version, ua } = await captureSignature();
const payload = JSON.stringify({ cookie, token, bx, version, ua });
log(`cookie ${cookie.length}b · token ${token.length}b · bx-ua ${bx["bx-ua"].length}b · fe ${version}`);

if (dry) {
  log("dry run, not pushing");
  process.exit(0);
}

// Piped through SSH so the credential never travels over the public network.
const key = fs.readFileSync(KEY_FILE, "utf8").trim();
const r = spawnSync(
  "ssh",
  ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", VPS,
   `curl -s -m 15 -X POST ${RELAY}/admin/creds -H 'Content-Type: application/json' -H 'Authorization: Bearer ${key}' --data-binary @-`],
  { input: payload, encoding: "utf8" },
);
log("relay replied:", (r.stdout || r.stderr || "").trim().slice(0, 200));
process.exit(r.status === 0 && /"ok":true/.test(r.stdout || "") ? 0 : 1);
