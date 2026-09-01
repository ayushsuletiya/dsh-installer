// Qwen OAuth (device flow) credential helper.
// Shares ~/.qwen/oauth_creds.json with the official @qwen-code CLI, so a login
// here works there and vice versa. Constants lifted verbatim from
// @qwen-code/qwen-code-core 0.0.14 (QWEN_OAUTH_* in dist).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const OAUTH_BASE = "https://chat.qwen.ai";
export const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const SCOPE = "openid profile email model.completion";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const CREDS_PATH = path.join(homedir(), ".qwen", "oauth_creds.json");

const UA = "QwenCode/0.0.14 (darwin; arm64)";

function form(obj) {
  return new URLSearchParams(obj).toString();
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": UA,
      "x-request-id": randomUUID(),
    },
    body: form(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Alibaba's edge returns HTML 502/504 pages under load; callers that can
    // retry (the device-code poller) look at json === null instead of catching.
    json = null;
  }
  return { status: res.status, json, text };
}

function demandJson(url, { status, json, text }) {
  if (!json) {
    throw new Error(`non-JSON reply from ${url} (status ${status}): ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  }
  return json;
}

export async function readCreds() {
  try {
    return JSON.parse(await readFile(CREDS_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function writeCreds(creds) {
  await mkdir(path.dirname(CREDS_PATH), { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2));
  await chmod(CREDS_PATH, 0o600);
}

// Normalises whatever the token endpoint hands back into a full OpenAI base URL.
export function apiBase(creds) {
  let raw = creds?.resource_url || "portal.qwen.ai";
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  raw = raw.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(raw)) raw = `${raw}/v1`;
  return raw;
}

export async function startDeviceFlow() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = `${OAUTH_BASE}/api/v1/oauth2/device/code`;
  const reply = await postForm(url, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const json = demandJson(url, reply);
  if (reply.status !== 200 || !json.device_code) {
    throw new Error(`device code request failed (${reply.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { ...json, code_verifier: verifier };
}

export async function pollForToken(device, { intervalMs = 5000, onTick } = {}) {
  const deadline = Date.now() + (device.expires_in || 900) * 1000;
  let wait = intervalMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));

    let status;
    let json;
    try {
      ({ status, json } = await postForm(`${OAUTH_BASE}/api/v1/oauth2/token`, {
        grant_type: DEVICE_GRANT,
        client_id: CLIENT_ID,
        device_code: device.device_code,
        code_verifier: device.code_verifier,
      }));
    } catch (e) {
      // DNS blips / resets while the user is still on the approval page.
      onTick?.("network");
      continue;
    }

    // Gateway HTML (502/503/504) and any other transient non-JSON body: the
    // device code is still good, so keep waiting instead of aborting the login.
    if (!json) {
      onTick?.(`http_${status}`);
      continue;
    }

    if (status === 200 && json.access_token) {
      const creds = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        token_type: json.token_type || "Bearer",
        resource_url: json.resource_url || json.endpoint || "portal.qwen.ai",
        expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      await writeCreds(creds);
      return creds;
    }
    const err = json.error || json.code;
    if (err === "authorization_pending") {
      onTick?.("pending");
      continue;
    }
    if (err === "slow_down") {
      wait += 2000;
      onTick?.("slow_down");
      continue;
    }
    throw new Error(`authorisation failed: ${err || JSON.stringify(json).slice(0, 200)}`);
  }
  throw new Error("device code expired before approval");
}

export async function refreshCreds(creds) {
  if (!creds?.refresh_token) throw new Error("no refresh_token on file - run qwen-login again");
  const url = `${OAUTH_BASE}/api/v1/oauth2/token`;
  const reply = await postForm(url, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: creds.refresh_token,
  });
  const json = demandJson(url, reply);
  if (reply.status !== 200 || !json.access_token) {
    throw new Error(`refresh failed (${reply.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  const next = {
    access_token: json.access_token,
    // Qwen rotates refresh tokens on some responses and omits them on others.
    refresh_token: json.refresh_token || creds.refresh_token,
    token_type: json.token_type || "Bearer",
    resource_url: json.resource_url || creds.resource_url || "portal.qwen.ai",
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  await writeCreds(next);
  return next;
}
