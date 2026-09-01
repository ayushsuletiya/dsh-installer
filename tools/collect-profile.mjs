#!/usr/bin/env node
// Collect THIS machine's working credentials and endpoints into the config bundle
// that enrolled machines receive.
//
//   node tools/collect-profile.mjs <profile-name>   -> JSON on stdout
//
// Read straight out of the live config so nothing is retyped and nothing can drift
// from what actually works here. Values are never printed to a terminal by
// dsh-publish; they go over SSH into the distribution service.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const name = process.argv[2] || "default";
const home = os.homedir();
const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

const creds = read(path.join(home, ".dsh", ".credentials.yaml"));
const env = read(path.join(home, ".dsh", ".env"));
const settings = read(path.join(home, ".dsh", "settings.yaml"));
const patch = read(path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml"));

const grab = (text, re) => {
  const m = text.match(re);
  return m ? m[1].trim() : "";
};
const unquote = (v) => v.replace(/^['"]|['"]$/g, "");

const CREDENTIAL_KEYS = [
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

const credentials = {};
for (const key of CREDENTIAL_KEYS) {
  const value = unquote(grab(creds, new RegExp(`^\\s*${key}:\\s*(.*)$`, "m")));
  if (value) credentials[key] = value;
}
for (const key of ENV_KEYS) {
  const value = grab(env, new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m"));
  if (value) credentials[key] = value;
}

// Endpoints are lifted from the live settings/profile rather than hardcoded, so a
// gateway move only has to happen in one place.
const endpoints = {};
const tabi = grab(settings, /^\s*baseURL:\s*(https:\/\/tabi\.[^\s]+)\s*$/m);
const omni = grab(settings, /^\s*baseURL:\s*(https:\/\/omni\.[^\s]+)\s*$/m);
const nodeId = grab(settings, /id:\s*(openai-compatible-chat-[0-9a-f-]{36})\//);
const metaAds = grab(patch, /url:\s*(https?:\/\/[^\s/]+)\/mcp/);
if (tabi) endpoints.TABITOKEN_BASE_URL = tabi;
if (omni) endpoints.OMNIROUTE_BASE_URL = omni;
if (nodeId) endpoints.QWEN_OMNI_NODE_ID = nodeId;
if (metaAds) endpoints.META_ADS_BRIDGE_URL = metaAds;

if (process.argv.includes("--summary")) {
  process.stdout.write(
    `${Object.keys(credentials).length} credentials, ${Object.keys(endpoints).length} endpoints\n`,
  );
  process.exit(0);
}

process.stdout.write(JSON.stringify({ name, credentials, endpoints }));
