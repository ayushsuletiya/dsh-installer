#!/usr/bin/env node
// Managed DeepSeek Harness — update checker.
//
//   node check-update.mjs            # notify if a newer release exists
//   node check-update.mjs --apply    # update now, no prompt
//   node check-update.mjs --quiet    # exit 0/10 only, print nothing (for scripts)
//
// Run on a timer by the LaunchAgent (macOS) or Scheduled Task (Windows) the
// installer registers. It asks the distribution service what the current release
// is, compares it with what this machine has, and when they differ shows a native
// prompt with one button that applies the update.
//
// Exit codes: 0 up to date or update applied, 10 an update is available and was
// declined, 1 could not check.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const STATE = path.join(DSH_HOME, "managed.json");
const LOG = path.join(DSH_HOME, "logs", "updater.log");
const apply = process.argv.includes("--apply");
const quiet = process.argv.includes("--quiet");

function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}\n`;
  if (!quiet) process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line);
  } catch {}
}

let managed;
try {
  managed = JSON.parse(fs.readFileSync(STATE, "utf8"));
} catch {
  log("not a managed install (no managed.json) — nothing to do");
  process.exit(0);
}

const { base, token, version: installed } = managed;
if (!base || !token) {
  log("managed.json is incomplete");
  process.exit(1);
}

// ---------- compare ----------

/** Numeric-aware compare so 1.10.0 sorts above 1.9.0 and rc tags sort below. */
function newer(a, b) {
  const norm = (v) =>
    String(v ?? "")
      .replace(/^v/, "")
      .split(/[.-]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i];
    const y = B[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    if (typeof x === typeof y) return x > y;
    return typeof x === "number";
  }
  return false;
}

let manifest;
try {
  const res = await fetch(`${base}/manifest.json`, {
    headers: { "user-agent": `dsh-updater/${installed ?? "unknown"}` },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  manifest = await res.json();
} catch (err) {
  log("could not reach the distribution service:", err.message);
  process.exit(1);
}

const latest = manifest?.version;
if (!latest) {
  log("manifest carried no version");
  process.exit(1);
}

if (!newer(latest, installed)) {
  log(`up to date (${installed})`);
  process.exit(0);
}

log(`update available: ${installed} -> ${latest}`);

// ---------- apply ----------

function runUpdate() {
  log("applying update");
  // The bootstrap is the whole installer: idempotent, and it rewrites
  // managed.json with the new version when it finishes.
  const script = `curl -fsSL ${base}/i/${token} | bash`;
  if (process.platform === "win32") {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${base}/w/${token} | iex`],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
  } else {
    const child = spawn("/bin/bash", ["-lc", script], { detached: true, stdio: "ignore" });
    child.unref();
  }
  log("update started in the background");
}

if (apply) {
  runUpdate();
  process.exit(0);
}

const notes = String(manifest.notes || "").slice(0, 400);

// ---------- ask ----------

if (process.platform === "darwin") {
  // A notification cannot carry a button that runs code, so this is a small
  // dialog instead: one click updates, and it times out to "Later" on its own so
  // an unattended machine is never left blocking.
  const message = `A new version of DeepSeek Harness is ready.\n\n${installed} → ${latest}${notes ? `\n\n${notes}` : ""}`;
  const script = `display dialog ${JSON.stringify(message)} with title "DeepSeek Harness update" buttons {"Later", "Update now"} default button "Update now" giving up after 120`;
  try {
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 140000 });
    // `giving up after` returns `gave up:true` AND names the default button, so a
    // timeout looks exactly like a click unless the flag is checked first. An
    // unattended machine must never update itself behind the user's back.
    if (/gave up:\s*true/i.test(out)) {
      log("prompt timed out — treating as Later");
      process.exit(10);
    }
    if (/button returned:\s*Update now/i.test(out)) {
      runUpdate();
      process.exit(0);
    }
    log("user chose Later");
    process.exit(10);
  } catch (err) {
    // No GUI session (ssh, or the agent ran before login): fall back to a
    // notification so the news is not lost, and try again on the next tick.
    log("dialog unavailable:", err.message);
    try {
      execFile("osascript", [
        "-e",
        `display notification "Version ${latest} is available. Run dsh-update to install it." with title "DeepSeek Harness"`,
      ]);
    } catch {}
    process.exit(10);
  }
}

if (process.platform === "win32") {
  // MessageBox via the WinForms assembly: present on every supported Windows,
  // needs no module install, and returns which button was pressed.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$msg = "A new version of DeepSeek Harness is ready.

${installed} -> ${latest}
${notes.replace(/"/g, "'")}"
$r = [System.Windows.Forms.MessageBox]::Show($msg, 'DeepSeek Harness update', 'YesNo', 'Information')
if ($r -eq 'Yes') { exit 0 } else { exit 10 }`;
  try {
    execFileSync("powershell", ["-NoProfile", "-STA", "-Command", ps], { timeout: 140000 });
    runUpdate();
    process.exit(0);
  } catch (err) {
    if (err.status === 10) {
      log("user chose Later");
      process.exit(10);
    }
    log("prompt unavailable:", err.message);
    process.exit(10);
  }
}

log(`update ${latest} available — run dsh-update to install it`);
process.exit(10);
