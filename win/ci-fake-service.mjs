#!/usr/bin/env node
// A stand-in for get.xovi.pro, so CI can run the REAL installer end to end without
// touching production or holding a real enrollment token.
//
//   node win/ci-fake-service.mjs <zip> <sha256> [port]
//
// It answers the three things the installer asks of the service:
//   GET /manifest.json      the Windows track, pointing at the local zip
//   GET /p.zip              the payload itself
//   GET /config/<token>     an empty credential bundle
//
// An empty bundle is the harshest case a real machine can present — no keys at
// all — and the harness still has to boot and serve every plugin bundle.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [zipPath, sha256, portArg] = process.argv.slice(2);
if (!zipPath || !sha256) {
  console.error("usage: ci-fake-service.mjs <zip> <sha256> [port]");
  process.exit(2);
}
const PORT = Number(portArg || 8799);
const zip = path.resolve(zipPath);
const size = fs.statSync(zip).size;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  if (url.pathname === "/manifest.json") {
    return send(200, {
      version: "ci",
      windows: {
        version: "ci",
        payload: { url: `http://127.0.0.1:${PORT}/p.zip`, sha256, bytes: size },
      },
    });
  }
  if (url.pathname === "/p.zip") {
    res.writeHead(200, { "content-type": "application/zip", "content-length": size });
    return fs.createReadStream(zip).pipe(res);
  }
  if (url.pathname.startsWith("/config/")) {
    return send(200, { enrollment: { name: "ci", profile: "ci" }, credentials: {}, endpoints: {} });
  }
  send(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake service on http://127.0.0.1:${PORT} serving ${path.basename(zip)} (${size} bytes)`);
});
