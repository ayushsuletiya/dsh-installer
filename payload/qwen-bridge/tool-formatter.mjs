// Reliable tool calls for the Qwen web route.
//
// The web session cannot do real function calling, so the bridge asks Qwen for a
// tool_call in the prompt. Qwen's REASONING about which tool to use is good; what
// is unreliable is the JSON — invented names (`bash` because the system prompt
// mentions it), single quotes, trailing commas, missing required fields.
//
// So we stop asking Qwen to be a JSON formatter. Qwen stays the brain on Ayush's
// free quota; when its tool JSON is broken we hand the INTENT plus the one real
// schema to a small free model that has NATIVE function calling, and use the
// structured tool_call it returns. One extra hop of ~1.5-3s, no extra Qwen
// prompt spent, and the result is schema-valid by construction.
//
// Free formatter models were verified live through Ayush's OmniRoute key
// (native tool_calls, latencies measured 28 Aug 2026). Nothing here is billed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = os.homedir();
const BASE_URL = process.env.QWEN_TOOLFMT_URL || "https://omni.theworldofmemories.in/v1";
const MODEL = process.env.QWEN_TOOLFMT_MODEL || "openrouter/cohere/north-mini-code:free";
// Tried in order when the primary is throttled; all verified to emit native tool_calls.
const FALLBACKS = (process.env.QWEN_TOOLFMT_FALLBACKS ||
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free,openrouter/nvidia/nemotron-3-ultra-550b-a55b:free,oc/hy3-free")
  .split(",").map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.QWEN_TOOLFMT_TIMEOUT_MS || 20000);
const ENABLED = process.env.QWEN_TOOLFMT !== "0";

// The key lives in the DSH credential file (0600). The bridge runs under launchd
// with no env from ~/.dsh/.env, so read it from disk once and cache it.
let cachedKey = null;
function apiKey() {
  if (cachedKey !== null) return cachedKey;
  if (process.env.OMNIROUTER_API_KEY) return (cachedKey = process.env.OMNIROUTER_API_KEY);
  const candidates = [
    path.join(HOME, "qwen-bridge", ".omni-key"),
    "/etc/qwen-relay/omni-key",          // VPS relay deployment
    path.join(HOME, ".dsh", ".credentials.yaml"),
    path.join(HOME, ".dsh", ".env"),
    "/etc/qwen-relay/env",
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (path.basename(file).endsWith("omni-key")) {   // raw key file (Mac dotfile or /etc/qwen-relay/omni-key)
        const v = raw.trim();
        if (v) return (cachedKey = v);
        continue;
      }
      const m = raw.match(/OMNIROUTER_API_KEY\s*[:=]\s*["']?([^"'\s]+)/);
      if (m) return (cachedKey = m[1]);
    } catch { /* next candidate */ }
  }
  return (cachedKey = "");
}

// ---------------------------------------------------------------------------
// Which tool did Qwen mean?
// ---------------------------------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Rank the declared tools against whatever name Qwen used, plus any names that
// appear in its prose. Exact match wins; then normalised equality (readFile ->
// read_file); then containment; then edit distance.
export function rankTools(intentName, tools = [], intentText = "") {
  const names = tools.map((t) => (t.function || t)?.name).filter(Boolean);
  const want = norm(intentName);
  const hay = String(intentText || "").toLowerCase();
  const scored = names.map((name) => {
    const n = norm(name);
    let score = 0;
    if (name === intentName) score = 1000;
    else if (n === want && want) score = 900;
    else if (want && (n.includes(want) || want.includes(n))) score = 700 - Math.abs(n.length - want.length);
    else if (want) score = 400 - editDistance(n, want) * 20;
    if (hay.includes(name.toLowerCase())) score += 120;   // named somewhere in the prose
    return { name, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Ask a real-API model to emit the call
// ---------------------------------------------------------------------------

const SYSTEM = [
  "You convert an assistant's stated intent into exactly one function call.",
  "Rules:",
  "- Call one of the provided functions. Never answer in prose.",
  "- Take every argument value from the intent text; do not invent facts.",
  "- If the intent names a path, command, query or id, reproduce it verbatim.",
  "- Omit optional arguments the intent does not mention.",
].join("\n");

async function callFormatter(model, tools, intentText, signal) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      tool_choice: "required",
      tools,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Assistant intent:\n\n${intentText}\n\nEmit the matching function call.` },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${body.slice(0, 160)}`);
  }
  const json = await res.json();
  const calls = json?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) throw new Error("no tool_calls in formatter reply");
  return calls;
}

/**
 * Turn Qwen's broken/ambiguous tool intent into valid OpenAI tool_calls.
 *
 * @param {object}   o
 * @param {string}   o.intentText  Qwen's raw reply (fence, bare JSON or prose).
 * @param {string}   o.intentName  The name Qwen used, if one was parsed.
 * @param {object[]} o.tools       The tool list DSH sent, verbatim schemas.
 * @param {number}   o.candidates  How many candidate schemas to offer (default 3).
 * @returns {Promise<{calls: object[], model: string, tool: string}|null>}
 */
export async function repairToolCall({ intentText = "", intentName = "", tools = [], candidates = 3 } = {}) {
  if (!ENABLED || !tools.length || !intentText.trim()) return null;
  if (!apiKey()) return null;

  const ranked = rankTools(intentName, tools, intentText).slice(0, Math.max(1, candidates));
  const keep = new Set(ranked.map((r) => r.name));
  const subset = tools.filter((t) => keep.has((t.function || t)?.name));
  if (!subset.length) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    for (const model of [MODEL, ...FALLBACKS]) {
      try {
        const raw = await callFormatter(model, subset, intentText, ctrl.signal);
        const calls = raw
          .filter((c) => keep.has(c?.function?.name))
          .map((c) => ({
            id: c.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            type: "function",
            function: {
              name: c.function.name,
              arguments: typeof c.function.arguments === "string"
                ? c.function.arguments
                : JSON.stringify(c.function.arguments ?? {}),
            },
          }));
        if (calls.length) return { calls, model, tool: calls[0].function.name };
      } catch (e) {
        if (ctrl.signal.aborted) break;
        // 429/503 on a free tier is throttling: try the next model.
        continue;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const formatterInfo = () => ({
  enabled: ENABLED && !!apiKey(),
  model: MODEL,
  fallbacks: FALLBACKS,
  baseUrl: BASE_URL,
});
