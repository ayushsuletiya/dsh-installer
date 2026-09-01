#!/usr/bin/env node
// Install the Qwen desktop app, unattended, on macOS or Windows.
//
//   node tools/install-qwen-app.mjs [--force] [--no-launch]
//
// The app is the credential for the whole `qwen` provider: the bridge drives its
// own signed-in chat.qwen.ai page over CDP, so there is no API key and no billing.
// That makes installing it part of the one-click setup rather than a manual step.
//
// Download URLs are resolved live from Qwen's own download-page API, so a new
// release needs no change here:
//
//   GET https://qwen.ai/api/config?api.app_download_url
//     -> { macOS_arm, macOS_inter, windows, ios, android, android_apk }
//
// Exit codes: 0 installed or already present, 3 could not install (the caller
// prints the manual URL and carries on — everything except the `qwen` provider
// works without the app).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_URL = "https://qwen.ai/api/config?api.app_download_url";
const CDP_PORT = process.env.QWEN_CDP_PORT || "9222";
const force = process.argv.includes("--force");
const noLaunch = process.argv.includes("--no-launch");

const log = (...a) => console.log("[qwen-app]", ...a);
const fail = (...a) => {
  console.error("[qwen-app]", ...a);
  process.exit(3);
};

// ---------- where the app already is ----------

function macAppPaths() {
  return ["/Applications/Qwen.app", path.join(os.homedir(), "Applications", "Qwen.app")];
}

function winAppPaths() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  return [
    path.join(local, "Programs", "Qwen", "Qwen.exe"),
    path.join(local, "Programs", "qwen", "Qwen.exe"),
    path.join(pf, "Qwen", "Qwen.exe"),
  ];
}

function installedPath() {
  const candidates = process.platform === "darwin" ? macAppPaths() : winAppPaths();
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ---------- download ----------

async function resolveUrls() {
  const res = await fetch(CONFIG_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
      "x-request-id": crypto.randomUUID(),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`download config HTTP ${res.status}`);
  const body = await res.json();
  const urls = body?.app_download_url;
  if (!urls || typeof urls !== "object") throw new Error("config carried no app_download_url");
  return urls;
}

function pickUrl(urls) {
  if (process.platform === "darwin") {
    const key = process.arch === "arm64" ? "macOS_arm" : "macOS_inter";
    return urls[key] || urls.macOS_arm || urls.macOS_inter;
  }
  if (process.platform === "win32") return urls.windows;
  return null;
}

async function download(url, dest) {
  log("downloading", url);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A 404 HTML page or a truncated transfer must not be handed to hdiutil.
  if (buf.length < 5 * 1024 * 1024) throw new Error(`downloaded only ${buf.length} bytes`);
  fs.writeFileSync(dest, buf);
  log(`saved ${(buf.length / 1048576).toFixed(1)} MB -> ${dest}`);
  return dest;
}

// ---------- install ----------

function installMac(dmg) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-dmg-"));
  log("mounting", dmg);
  execFileSync(
    "hdiutil",
    ["attach", dmg, "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mountPoint],
    { stdio: "inherit" },
  );
  try {
    const app = fs
      .readdirSync(mountPoint)
      .map((e) => path.join(mountPoint, e))
      .find((p) => p.endsWith(".app"));
    if (!app) throw new Error("no .app inside the disk image");

    // /Applications when it is writable (the normal case for an admin account),
    // otherwise the per-user Applications folder — never sudo from an installer.
    let target = "/Applications";
    try {
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      target = path.join(os.homedir(), "Applications");
      fs.mkdirSync(target, { recursive: true });
    }
    const dest = path.join(target, path.basename(app));
    fs.rmSync(dest, { recursive: true, force: true });
    log("copying to", dest);
    execFileSync("cp", ["-R", app, dest], { stdio: "inherit" });
    // Gatekeeper quarantines anything a script downloads; clearing the flag is
    // what stops the "downloaded from the internet" modal on first launch.
    try {
      execFileSync("xattr", ["-dr", "com.apple.quarantine", dest], { stdio: "ignore" });
    } catch {}
    return dest;
  } finally {
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    } catch {}
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function installWindows(exe) {
  // electron-builder's NSIS installer: /S is silent, /D sets the target dir.
  // Per-user install needs no elevation, which keeps this unattended.
  log("running silent installer");
  try {
    execFileSync(exe, ["/S"], { stdio: "inherit", windowsHide: true });
  } catch (err) {
    // Some builds return non-zero even on success; trust the filesystem instead.
    log("installer exited non-zero:", err.message);
  }
  for (let i = 0; i < 30; i++) {
    const found = installedPath();
    if (found) return found;
    execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 1000"], {
      stdio: "ignore",
    });
  }
  throw new Error("installer finished but Qwen.exe was not found");
}

function launch(appPath) {
  const flag = `--remote-debugging-port=${CDP_PORT}`;
  log("launching with", flag);
  if (process.platform === "darwin") {
    spawn("open", ["-a", appPath, "--args", flag], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(appPath, [flag], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}

// ---------- main ----------

if (process.platform !== "darwin" && process.platform !== "win32") {
  fail(`no unattended installer for ${process.platform}; install Qwen from https://qwen.ai/download`);
}

const already = installedPath();
if (already && !force) {
  log("already installed:", already);
  if (!noLaunch) launch(already);
  process.exit(0);
}

let urls;
try {
  urls = await resolveUrls();
} catch (err) {
  fail(`could not resolve the download URL (${err.message}); install from https://qwen.ai/download`);
}

const url = pickUrl(urls);
if (!url) fail(`no build for ${process.platform}/${process.arch}; see https://qwen.ai/download`);

const tmp = path.join(os.tmpdir(), path.basename(new URL(url).pathname));
let appPath;
try {
  await download(url, tmp);
  appPath = process.platform === "darwin" ? installMac(tmp) : installWindows(tmp);
} catch (err) {
  fail(`install failed (${err.message}); download it yourself: ${url}`);
} finally {
  fs.rmSync(tmp, { force: true });
}

log("installed:", appPath);
if (!noLaunch) launch(appPath);
log("sign in to the app once — the bridge then uses that session for every request");
