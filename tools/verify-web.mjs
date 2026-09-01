#!/usr/bin/env node
// Prove the web UI actually WORKS, the way a browser would.
//
//   node tools/verify-web.mjs [--start <dsh-command>] [--port 3080] [--timeout 90]
//
// Three Windows releases shipped "Done." while the UI was dead, because the
// installer only ever checked that `dsh --version` answered and that the profile
// composed. Both were true while `dsh web` was serving exactly one page and then
// dying on the first local plugin — the browser got the HTML, every plugin bundle
// request hit a corpse, and the page said "Failed to load plugins".
//
// So this checks what actually matters, in order:
//   1. the port answers,
//   2. `/` returns HTML containing the boot manifest,
//   3. EVERY plugin bundle the manifest names returns 200,
//   4. the port still answers afterwards — a server that dies on plugin load
//      passes 1-3 for a second or two.
//
// Exit codes: 0 all good · 1 bundles missing or the server died · 2 never came up.
import { spawn } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(argOf("--port", "3080"));
const TIMEOUT_S = Number(argOf("--timeout", "90"));
const START = argOf("--start", "");
const BASE = `http://127.0.0.1:${String(PORT)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plain TCP probe: cheaper than HTTP and it cannot be confused by a slow route. */
function portOpen() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: PORT });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** The boot payload dsh web injects into index.html: {rev, entries:[{id,url}]}. */
function parseBoot(html) {
  const key = 'globalThis["__DSH_BOOT__"] = ';
  const at = html.indexOf(key);
  if (at < 0) return undefined;
  let depth = 0;
  const start = at + key.length;
  let end = start;
  for (; end < html.length; end++) {
    const ch = html[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return undefined;
  }
}

let child;
// Only start a server when nothing is already serving: on a machine where the
// logon task or a terminal already runs `dsh web`, a second one would just lose
// the port race and its failure would say nothing about the UI.
const alreadyUp = await portOpen();
if (!alreadyUp && START) {
  // Detached output is kept so a failure can be explained rather than guessed at.
  child = spawn(START, ["web"], { stdio: ["ignore", "pipe", "pipe"], shell: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let tail = "";
  const keep = (chunk) => {
    tail = `${tail}${chunk}`.slice(-4000);
    child.tail = tail;
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
}

const stop = () => {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
};

let up = alreadyUp;
for (let i = 0; !up && i < TIMEOUT_S * 2; i++) {
  if (await portOpen()) {
    up = true;
    break;
  }
  await sleep(500);
}
if (!up) {
  console.error(`verify-web: nothing listening on ${BASE} after ${String(TIMEOUT_S)}s`);
  if (child?.tail) console.error(child.tail.split("\n").slice(-25).join("\n"));
  stop();
  process.exit(2);
}

let html = "";
try {
  const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(20000) });
  html = await res.text();
  if (!res.ok) throw new Error(`index returned ${String(res.status)}`);
} catch (error) {
  console.error(`verify-web: could not load ${BASE}/ — ${error.message}`);
  if (child?.tail) console.error(child.tail.split("\n").slice(-25).join("\n"));
  stop();
  process.exit(1);
}

const boot = parseBoot(html);
if (boot === undefined) {
  console.error("verify-web: index.html carries no boot manifest — this is not dsh web");
  stop();
  process.exit(1);
}

const entries = Array.isArray(boot.entries) ? boot.entries : [];
const bad = [];
for (const entry of entries) {
  try {
    const res = await fetch(`${BASE}${entry.url}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) bad.push(`${entry.id} -> HTTP ${String(res.status)}`);
    else await res.arrayBuffer();
  } catch (error) {
    bad.push(`${entry.id} -> ${error.message}`);
  }
}

// A server that dies while loading plugins answers the first requests and then
// vanishes, so the last check is simply: is it still there?
const stillUp = await portOpen();

const total = entries.length;
const ok = total - bad.length;
if (bad.length === 0 && stillUp) {
  console.log(`verify-web: ${String(ok)}/${String(total)} plugin bundles served, server still up`);
  stop();
  process.exit(0);
}

console.error(`verify-web: ${String(ok)}/${String(total)} plugin bundles served; still up: ${String(stillUp)}`);
for (const line of bad.slice(0, 8)) console.error(`  ${line}`);
if (bad.length > 8) console.error(`  ... and ${String(bad.length - 8)} more`);
if (child?.tail) {
  console.error("--- server output ---");
  console.error(child.tail.split("\n").slice(-25).join("\n"));
}
stop();
process.exit(1);
