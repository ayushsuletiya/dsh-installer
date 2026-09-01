#!/usr/bin/env node
// Interactive Qwen OAuth login: prints (and optionally opens) the approval URL,
// then polls until the account approves and stores ~/.qwen/oauth_creds.json.
//
//   node ~/qwen-bridge/qwen-login.mjs           # print URL + poll
//   node ~/qwen-bridge/qwen-login.mjs --open    # also open it in the browser
//   node ~/qwen-bridge/qwen-login.mjs --status  # show current credential state
import { spawn } from "node:child_process";
import { apiBase, readCreds, refreshCreds, startDeviceFlow, pollForToken, CREDS_PATH } from "./qwen-auth.mjs";

const args = new Set(process.argv.slice(2));

if (args.has("--status")) {
  const creds = await readCreds();
  if (!creds) {
    console.log("no credentials at", CREDS_PATH);
    process.exit(1);
  }
  const left = Math.round((creds.expiry_date - Date.now()) / 1000);
  console.log(`creds: ${CREDS_PATH}`);
  console.log(`api base: ${apiBase(creds)}`);
  console.log(`access token: ${left > 0 ? `valid ${left}s` : `expired ${-left}s ago`}`);
  console.log(`refresh token: ${creds.refresh_token ? "present" : "MISSING"}`);
  if (left <= 0 && creds.refresh_token) {
    const next = await refreshCreds(creds);
    console.log(`refreshed -> valid ${Math.round((next.expiry_date - Date.now()) / 1000)}s`);
  }
  process.exit(0);
}

const device = await startDeviceFlow();
const url = device.verification_uri_complete || device.verification_uri;
console.log("user code:", device.user_code);
console.log("approve at:", url);
console.log(`(expires in ${device.expires_in}s)`);

if (args.has("--open")) {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

const creds = await pollForToken(device, {
  onTick: (s) => s === "pending" && process.stdout.write("."),
});
console.log("\nauthorised. api base:", apiBase(creds));
console.log("token valid for", Math.round((creds.expiry_date - Date.now()) / 1000), "s; refresh token stored");
