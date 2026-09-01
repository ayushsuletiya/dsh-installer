#!/usr/bin/env node
// Qwen OAuth -> OpenAI-compatible bridge for DeepSeek Harness.
//
// DSH providers take a static API key, but Qwen's free OAuth tier hands out a
// 1-hour bearer plus a refresh token. This process holds that dance: DSH talks
// plain OpenAI to 127.0.0.1:3083 with a dummy key, and every request goes
// upstream with a freshly-refreshed Qwen bearer.
//
//   node ~/qwen-bridge/server.mjs
//   QWEN_BRIDGE_PORT=3083 node ~/qwen-bridge/server.mjs
import http from "node:http";
import { Readable } from "node:stream";
import { apiBase, readCreds, refreshCreds } from "./qwen-auth.mjs";

const PORT = Number(process.env.QWEN_BRIDGE_PORT || 3083);
const HOST = process.env.QWEN_BRIDGE_HOST || "127.0.0.1";
const REFRESH_BUFFER_MS = 60_000;

let cache = null; // last known creds
let inflight = null; // de-duplicates concurrent refreshes

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function currentCreds({ force = false } = {}) {
  if (!cache) cache = await readCreds();
  if (!cache) throw Object.assign(new Error("not authorised: run node ~/qwen-bridge/qwen-login.mjs --open"), { code: 401 });

  const stale = force || !cache.access_token || cache.expiry_date - Date.now() < REFRESH_BUFFER_MS;
  if (!stale) return cache;

  // Another process (the official CLI) may have refreshed already.
  if (!force) {
    const onDisk = await readCreds();
    if (onDisk?.access_token && onDisk.expiry_date - Date.now() >= REFRESH_BUFFER_MS) {
      cache = onDisk;
      return cache;
    }
  }
  if (!inflight) {
    inflight = refreshCreds(await readCreds().then((c) => c || cache))
      .then((next) => {
        cache = next;
        log("token refreshed, valid", Math.round((next.expiry_date - Date.now()) / 1000), "s");
        return next;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function upstream(pathname, search, method, body, creds) {
  const url = `${apiBase(creds)}${pathname.replace(/^\/v1/, "")}${search}`;
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${creds.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "QwenCode/0.0.14 (darwin; arm64)",
    },
    body: body && body.length ? body : undefined,
    redirect: "follow",
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, search } = new URL(req.url, `http://${HOST}:${PORT}`);

  if (pathname === "/health" || pathname === "/") {
    let state = "unauthorised";
    let base = null;
    try {
      const creds = await currentCreds();
      base = apiBase(creds);
      const left = Math.round((creds.expiry_date - Date.now()) / 1000);
      state = `authorised (token ${left}s)`;
    } catch (e) {
      state = e.message;
    }
    return sendJson(res, 200, { ok: true, port: PORT, upstream: base, auth: state });
  }

  if (!pathname.startsWith("/v1/")) return sendJson(res, 404, { error: { message: `no route ${pathname}` } });

  const body = await readBody(req);
  let attempt = 0;

  while (attempt < 2) {
    attempt += 1;
    let creds;
    try {
      creds = await currentCreds({ force: attempt === 2 });
    } catch (e) {
      return sendJson(res, e.code === 401 ? 401 : 500, { error: { message: e.message, type: "qwen_bridge_auth" } });
    }

    let up;
    try {
      up = await upstream(pathname, search, req.method, body, creds);
    } catch (e) {
      return sendJson(res, 502, { error: { message: `upstream unreachable: ${e.message}`, type: "qwen_bridge_network" } });
    }

    // A 401 on the first try usually means the token died early - refresh once.
    if (up.status === 401 && attempt === 1) {
      log(pathname, "-> 401, forcing refresh");
      continue;
    }

    const ctype = up.headers.get("content-type") || "application/json";
    log(req.method, pathname, "->", up.status, ctype.includes("event-stream") ? "(stream)" : "");
    res.writeHead(up.status, {
      "content-type": ctype,
      "cache-control": "no-cache",
      ...(ctype.includes("event-stream") ? { connection: "keep-alive", "x-accel-buffering": "no" } : {}),
    });
    if (!up.body) return res.end();
    return Readable.fromWeb(up.body).pipe(res);
  }
});

server.listen(PORT, HOST, async () => {
  log(`qwen-bridge on http://${HOST}:${PORT}`);
  try {
    const creds = await currentCreds();
    log("upstream", apiBase(creds));
  } catch (e) {
    log("WARNING:", e.message);
  }
});
