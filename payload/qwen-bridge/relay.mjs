#!/usr/bin/env node
// qwen-relay — OpenAI-compatible Qwen endpoint for the OmniRoute gateway.
//
// Runs on the VPS and answers with Ayush's own signed-in Qwen Web session, so
// the gateway (and anything holding an OmniRoute key) can use Qwen with no API
// key and no billing.
//
// Why this exists instead of OmniRoute's built-in `qwen-web` provider: that
// provider sends no `bx-ua` and a placeholder `bx-umidtoken`, so Alibaba's WAF
// blocks every message it sends. A cookie alone is not enough — the send call
// also needs a signature that only the Qwen app's own JavaScript can produce.
// The signature is reusable and portable (verified: an hour-old one worked from
// this VPS), so the Mac bridge mints fresh ones and pushes them here.
//
//   creds:  /etc/qwen-relay/creds.json   (cookie + bx-* + token, 0600)
//   listen: 172.18.0.1:3099  (docker bridge gateway — reachable from the
//           gateway container, not from the internet)
//   auth:   Bearer RELAY_KEY on /v1/* and /admin/*
import http from "node:http";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { repairToolCall, formatterInfo } from "./tool-formatter.mjs";

const PORT = Number(process.env.RELAY_PORT || 3099);
const HOSTS = (process.env.RELAY_HOSTS || "172.18.0.1,127.0.0.1").split(",").map((s) => s.trim());
const CREDS = process.env.RELAY_CREDS || "/etc/qwen-relay/creds.json";
const KEY = process.env.RELAY_KEY || "";
const BASE = "https://chat.qwen.ai";
const UA_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Qwen/1.0.2 Chrome/134.0.6998.179 Electron/35.1.4 Safari/537.36 AliDesktop(QWENCHAT/1.0.2)";

const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => log("uncaughtException:", e?.message || e));

// ---------- credentials ----------

let creds = { cookie: "", token: "", bx: {}, version: "0.2.89", updatedAt: null };
function loadCreds() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS, "utf8"));
    creds = { version: "0.2.89", ...raw, bx: raw.bx || {} };
    log("creds loaded, updated", creds.updatedAt || "unknown");
  } catch (e) {
    log("no usable creds yet:", e.message);
  }
}
function saveCreds(next) {
  creds = { ...creds, ...next, updatedAt: new Date().toISOString() };
  fs.mkdirSync(CREDS.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(CREDS, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log("creds updated; bx keys:", Object.keys(creds.bx || {}).join(","));
}
loadCreds();

const credsAge = () => (creds.updatedAt ? Math.round((Date.now() - Date.parse(creds.updatedAt)) / 60000) : null);

// Headers replicating a real send from the desktop app. `source: desktop` and the
// front-end version must match the environment the signature was minted in.
function qwenHeaders(chatId) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${creds.token}`,
    Cookie: creds.cookie,
    Origin: BASE,
    Referer: chatId ? `${BASE}/c/${chatId}` : `${BASE}/`,
    "User-Agent": creds.ua || UA_APP,
    "Accept-Language": "en-US,en;q=0.9",
    source: "desktop",
    Version: creds.version || "0.2.89",
    Timezone: new Date().toString(),
    "X-Accel-Buffering": "no",
    "X-Request-Id": crypto.randomUUID(),
    ...(creds.bx || {}),
  };
}

// ---------- OpenAI plumbing (mirrors ~/qwen-bridge/server-app.mjs) ----------

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const c = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    req.on("error", reject);
  });

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function partsToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text || "" : p?.type ? "[non-text part omitted]" : ""))
    .filter(Boolean)
    .join("\n");
}

function flatten(messages = []) {
  const blocks = [];
  for (const m of messages) {
    const text = partsToText(m?.content);
    if (!text) continue;
    const role = (m.role || "user").toLowerCase();
    blocks.push(
      role === "system" ? `# System\n${text}` :
      role === "assistant" ? `# Assistant\n${text}` :
      role === "tool" ? `# Tool result\n${text}` : `# User\n${text}`,
    );
  }
  if (!blocks.length) return "(empty request)";
  return blocks.length === 1 ? blocks[0].replace(/^# User\n/, "") : blocks.join("\n\n");
}

// DSH hands us ~128 tools whose schemas carry long prose descriptions; verbatim
// that is ~380k characters of prompt before the conversation even starts. Keep
// the shape the model needs to fill arguments (names, types, required, enums)
// and drop the documentation.
function compactSchema(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return node;
  if (Array.isArray(node)) return node.slice(0, 20).map((n) => compactSchema(n, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (["description", "title", "examples", "default", "$schema", "additionalProperties"].includes(k)) continue;
    if (k === "enum" && Array.isArray(v)) { out.enum = v.slice(0, 20); continue; }
    out[k] = compactSchema(v, depth + 1);
  }
  return out;
}

function toolManifest(tools = []) {
  const lines = tools
    .map((t) => {
      const f = t.function || t;
      if (!f?.name) return null;
      return `- ${f.name}: ${(f.description || "").split("\n")[0].slice(0, 140)}\n  parameters: ${
        f.parameters ? JSON.stringify(compactSchema(f.parameters)) : '{"type":"object","properties":{}}'
      }`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return [
    "# Tool protocol",
    "You can use tools. To call one, reply with ONLY this block and nothing else — no prose before or after:",
    "```tool_call",
    '{"name": "<tool name>", "arguments": { ... }}',
    "```",
    "Rules: exactly one JSON object; `arguments` must satisfy that tool's schema; never invent tool names.",
    "You will receive the result as `# Tool result`, then continue. When no tool is needed, answer normally.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

// Emulated tool calling means the model can invent a plausible name it saw in
// prose ("bash") instead of one that exists. Validate against the declared list,
// and give it one corrective turn rather than letting DSH fail the turn.
function toolNames(tools = []) {
  return tools.map((t) => (t.function || t)?.name).filter(Boolean);
}
function splitCalls(calls, allowed) {
  if (!calls) return { good: null, bad: [] };
  const set = new Set(allowed);
  const good = calls.filter((c) => set.has(c.function.name));
  const bad = calls.filter((c) => !set.has(c.function.name)).map((c) => c.function.name);
  return { good: good.length ? good : null, bad };
}
function correctionPrompt(bad, allowed) {
  return [
    `# Tool error`,
    `${bad.join(", ")} ${bad.length > 1 ? "are not" : "is not"} a valid tool name.`,
    `Reply again with ONLY a tool_call block using one of these exact names, or answer in plain text if no tool fits:`,
    allowed.join(", "),
  ].join("\n");
}

const looksLikeToolCall = (s) => /^\s*(```\s*(tool_call|json)|\{\s*"(name|tool_call)")/i.test(s);

// Preferred repair path for a broken tool call: hand Qwen's intent to a free
// model that has NATIVE function calling and use its structured result. Costs no
// Qwen prompt and cannot return an undeclared tool name. Falls back to null, and
// the caller then spends one corrective Qwen turn.
async function repairCalls({ text, intentName = "", tools, why }) {
  const t0 = Date.now();
  let out = null;
  try {
    out = await repairToolCall({ intentText: text, intentName, tools });
  } catch (e) {
    log("tool formatter error:", e.message);
    return null;
  }
  if (out) {
    log(`tool repair (${why}) -> ${out.tool} via ${out.model.split("/").pop()} in ${Date.now() - t0}ms`);
    return out.calls;
  }
  log(`tool repair (${why}) failed in ${Date.now() - t0}ms`);
  return null;
}

// Models emit near-JSON: bare identifiers for values, single quotes, trailing
// commas. Repair the common slips instead of dropping the tool call and echoing
// a raw block to the user.
function looseParse(raw) {
  const text = String(raw || "").trim();
  try {
    return JSON.parse(text);
  } catch {}
  let fixed = text
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"')
    .replace(/("(?:name|tool|function)"\s*:\s*)([A-Za-z_][\w.-]*)/g, '$1"$2"');
  try {
    return JSON.parse(fixed);
  } catch {}
  // Last resort: pull the name and the arguments object out by hand.
  const name = text.match(/"?(?:name|tool)"?\s*:\s*"?([A-Za-z_][\w.-]*)"?/);
  if (!name) return null;
  const argsAt = text.indexOf('"arguments"');
  let args = {};
  if (argsAt >= 0) {
    const brace = text.indexOf("{", argsAt);
    if (brace >= 0) {
      let depth = 0;
      for (let i = brace; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) {
          try {
            args = JSON.parse(text.slice(brace, i + 1));
          } catch {
            try {
              args = JSON.parse(text.slice(brace, i + 1).replace(/,\s*([}\]])/g, "$1"));
            } catch {}
          }
          break;
        }
      }
    }
  }
  return { name: name[1], arguments: args };
}

function parseToolCalls(text) {
  if (!text) return null;
  const bodies = [];
  for (const m of text.matchAll(/```\s*(?:tool_call|json)?\s*\n([\s\S]*?)\n?```/gi)) bodies.push(m[1]);
  if (!bodies.length && /^\s*\{/.test(text)) bodies.push(text);
  const calls = [];
  for (const raw of bodies) {
    const obj = looseParse(raw);
    if (!obj) continue;
    for (const c of Array.isArray(obj) ? obj : [obj.tool_call || obj]) {
      const name = c?.name || c?.function?.name;
      if (!name) continue;
      const args = c?.arguments ?? c?.function?.arguments ?? {};
      calls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      });
    }
  }
  return calls.length ? calls : null;
}

// One Qwen conversation per client thread, keyed on system prompt + user turns.
const threads = new Map();
function threadKey(messages, model, { dropLast = false, toolsFp = "" } = {}) {
  // Keyed on the model, the tool set and the USER/TOOL turns only. The system
  // prompt is deliberately excluded: DSH rewrites it every turn (runtime
  // snapshot, memory files, skill catalogue), which would otherwise make each
  // turn look like a brand-new conversation and re-send the whole prompt.
  const turns = messages.filter((m) => ["user", "tool"].includes((m.role || "user").toLowerCase()));
  const kept = dropLast ? turns.slice(0, -1) : turns;
  return createHash("sha256")
    .update([model, toolsFp, ...kept.map((m) => partsToText(m.content).slice(0, 2000))].join("\u0000"))
    .digest("hex");
}
function remember(key, entry) {
  threads.set(key, { ...entry, at: Date.now() });
  if (threads.size > 500) {
    for (const [k] of [...threads.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100)) threads.delete(k);
  }
}

// ---------- Qwen calls ----------

async function qwenModels() {
  const r = await fetch(`${BASE}/api/models`, { headers: qwenHeaders() });
  if (!r.ok) throw new Error(`models HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((m) => ({
    id: m.id,
    ctx: m?.info?.meta?.max_context_length || 1_000_000,
    maxOut: m?.info?.meta?.max_generation_length || 65_536,
  }));
}

async function newChat(model) {
  const r = await fetch(`${BASE}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenHeaders(),
    body: JSON.stringify({ title: "OmniRoute", models: [model], chat_mode: "normal", chat_type: "t2t", timestamp: Date.now() }),
  });
  const j = await r.json().catch(() => null);
  if (!j?.data?.id) throw new Error(`newChat failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.id;
}

// Streams a Qwen completion, calling onDelta({phase, content}).
async function qwenComplete({ model, content, thinking, chatId, parentId }, onDelta) {
  const isNew = !chatId;
  if (isNew) chatId = await newChat(model);
  const parent = parentId || null;
  const ts = Math.floor(Date.now() / 1000);
  const body = {
    stream: true, version: "2.1", incremental_output: true,
    chatId, parentId: parent || "", chat_id: chatId, chat_mode: "normal",
    model, parent_id: parent, timestamp: ts,
    messages: [{
      id: null, fid: crypto.randomUUID(), parentId: parent, childrenIds: [crypto.randomUUID()],
      role: "user", content, user_action: "chat", files: [], timestamp: ts,
      models: [model], model: "", chat_type: "t2t",
      feature_config: {
        thinking_enabled: !!thinking, output_schema: "phase", research_mode: "normal",
        auto_thinking: false, thinking_mode: thinking ? "Thinking" : "NoThinking",
        thinking_format: "summary", auto_search: false,
      },
      extra: { meta: { subChatType: "t2t" } }, sub_chat_type: "t2t", parent_id: parent,
    }],
  };
  const res = await fetch(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: "POST", headers: qwenHeaders(chatId), body: JSON.stringify(body),
  });
  const ctype = res.headers.get("content-type") || "";
  if (!res.ok || !ctype.includes("event-stream")) {
    const t = await res.text();
    if (/FAIL_SYS_USER_VALIDATE|x5secdata|RGV587/.test(t)) {
      throw new Error("qwen signature rejected — the relay needs a fresh bx-ua push from the Mac bridge");
    }
    throw new Error(`qwen HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", usage = null, locked = null, responseId = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(raw);
        } catch {
          continue;
        }
        const evRid = ev.response_id || ev["response.created"]?.response_id;
        if (evRid) {
          if (locked === null) { locked = evRid; responseId = evRid; }
          else if (evRid !== locked) continue;
        }
        if (ev.usage) usage = ev.usage;
        const d = ev.choices?.[0]?.delta;
        if (d?.content) onDelta({ phase: d.phase || "answer", content: d.content });
      }
    }
  }
  return { chatId, responseId, usage };
}

// ---------- HTTP ----------

const authed = (req) => !KEY || (req.headers.authorization || "").replace(/^Bearer\s+/i, "") === KEY;
const isThinking = (p) => !!p && /think/i.test(p);

async function handleChat(req, res, body) {
  const model = body.model || "qwen3.8-max";
  const messages = body.messages || [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  const thinking = effort !== undefined && effort !== null && !["off", "none", "false", "minimal"].includes(String(effort).toLowerCase());
  const stream = body.stream !== false;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const toolsFp = createHash("sha256").update(tools.map((t)=>(t.function||t)?.name||"").join(",")).digest("hex").slice(0,12);
  const lookupKey = threadKey(messages, model, { dropLast: true, toolsFp });
  const storeKey = threadKey(messages, model, { toolsFp });
  const known = threads.get(lookupKey);
  const last = messages[messages.length - 1] || {};
  let content;
  if (known) {
    content = (last.role || "").toLowerCase() === "tool"
      ? `# Tool result (${last.name || "tool"})\n${partsToText(last.content) || "(no output)"}`
      : partsToText(last.content) || "(empty turn)";
  } else {
    const manifest = toolManifest(tools);
    content = manifest ? `${manifest}\n\n${flatten(messages)}` : flatten(messages);
  }
  if (known && tools.length) content += `\n\n(Valid tools: ${toolNames(tools).join(", ")})`;
  const turn = { model, content, thinking, chatId: known?.chatId, parentId: known?.parentId };
  log("chat", model, tools.length ? `${tools.length} tools` : "", known ? "continue" : "new chat", `${content.length}ch`);

  if (!stream) {
    let text = "", reasoning = "";
    const done = await qwenComplete(turn, (d) => (isThinking(d.phase) ? (reasoning += d.content) : (text += d.content)));
    if (done.responseId) remember(storeKey, { chatId: done.chatId, parentId: done.responseId });
    let calls = null;
    let u = done.usage || {};
    if (tools.length) {
      const allowed = toolNames(tools);
      const { good, bad } = splitCalls(parseToolCalls(text), allowed);
      calls = good;
      const mustCall = String(body.tool_choice || "") === "required";
      if (!calls && (bad.length || looksLikeToolCall(text) || mustCall)) {
        calls = await repairCalls({
          text, intentName: bad[0] || "", tools,
          why: bad.length ? `invented ${bad.join(",")}` : mustCall ? "tool_choice required" : "unparsed block",
        });
        if (!calls && bad.length) {
          log("invented tool name(s):", bad.join(","), "- asking again");
          let retry = "";
          const again = await qwenComplete(
            { model, content: correctionPrompt(bad, allowed), thinking: false, chatId: done.chatId, parentId: done.responseId },
            (d) => { if (!isThinking(d.phase)) retry += d.content || ""; },
          );
          if (again.responseId) remember(storeKey, { chatId: again.chatId, parentId: again.responseId });
          calls = splitCalls(parseToolCalls(retry), allowed).good;
          if (!calls) text = retry || text;
          u = again.usage || u;
        }
      }
    }
    return sendJson(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{
        index: 0,
        message: calls
          ? { role: "assistant", content: null, tool_calls: calls }
          : { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: calls ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? 0 },
    });
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const write = (o) => { if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch {} } };
  const frame = (delta, finish_reason = null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] });
  write(frame({ role: "assistant", content: "" }));

  let head = "", answer = "", buffering = tools.length > 0, decided = !tools.length;
  const emit = (t) => {
    answer += t;
    if (decided && !buffering) return write(frame({ content: t }));
    head += t;
    if (!decided && head.length >= 24) {
      decided = true;
      buffering = looksLikeToolCall(head);
      if (!buffering) write(frame({ content: head }));
    }
  };
  try {
    const done = await qwenComplete(turn, (d) => (isThinking(d.phase) ? write(frame({ reasoning_content: d.content })) : emit(d.content)));
    if (done.responseId) remember(storeKey, { chatId: done.chatId, parentId: done.responseId });
    let calls = null;
    if (tools.length) {
      const allowed = toolNames(tools);
      const { good, bad } = splitCalls(parseToolCalls(answer), allowed);
      calls = good;
      // Only safe while nothing has been flushed: once prose is on the wire it
      // cannot be withdrawn and re-sent as a tool call.
      const canConvert = buffering || !decided;
      const mustCall = String(body.tool_choice || "") === "required";
      if (!calls && !closed && canConvert && (bad.length || looksLikeToolCall(answer) || mustCall)) {
        calls = await repairCalls({
          text: answer, intentName: bad[0] || "", tools,
          why: bad.length ? `invented ${bad.join(",")}` : mustCall ? "tool_choice required" : "unparsed block",
        });
        if (!calls && bad.length) {
          log("invented tool name(s):", bad.join(","), "- asking again");
          let retry = "";
          const again = await qwenComplete(
            { model, content: correctionPrompt(bad, allowed), thinking: false, chatId: done?.chatId, parentId: done?.responseId },
            (d) => { if (!isThinking(d.phase)) retry += d.content || ""; },
          );
          if (again?.responseId) remember(storeKey, { chatId: again.chatId, parentId: again.responseId });
          calls = splitCalls(parseToolCalls(retry), allowed).good;
          if (!calls) answer = retry || answer;
        }
      }
    }
    if (!calls && buffering) write(frame({ content: answer }));
    else if (!calls && !decided) write(frame({ content: head }));
    if (calls) calls.forEach((c, i) => write(frame({ tool_calls: [{ index: i, id: c.id, type: "function", function: c.function }] })));
    write(frame({}, calls ? "tool_calls" : "stop"));
    const u = done.usage;
    if (u) write({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } });
    res.write("data: [DONE]\n\n");
  } catch (e) {
    log("stream failed:", e.message);
    write({ error: { message: e.message, type: "qwen_relay" } });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  const { pathname } = new URL(req.url, "http://relay");
  try {
    if (pathname === "/health" || pathname === "/") {
      return sendJson(res, 200, {
        ok: true, route: "qwen web session (relay)", port: PORT,
        credsAgeMinutes: credsAge(), hasCookie: !!creds.cookie, hasSignature: !!creds.bx?.["bx-ua"],
        threads: threads.size, toolRepair: formatterInfo(),
      });
    }
    if (!authed(req)) return sendJson(res, 401, { error: { message: "bad relay key", type: "auth" } });

    if (pathname === "/admin/creds" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!b.cookie || !b.bx?.["bx-ua"]) return sendJson(res, 400, { error: { message: "cookie and bx['bx-ua'] required" } });
      saveCreds({ cookie: b.cookie, token: b.token || creds.token, bx: b.bx, version: b.version || creds.version, ua: b.ua || creds.ua });
      return sendJson(res, 200, { ok: true, updatedAt: creds.updatedAt });
    }
    if (pathname === "/v1/models" && req.method === "GET") {
      const models = await qwenModels();
      return sendJson(res, 200, {
        object: "list",
        // OmniRoute reads `context_length` off each entry and falls back to a
        // 128k registry default when it is missing — which rejected 199k-token
        // prompts before they ever reached Qwen. Aliases cover other readers.
        data: models.map((m) => ({
          id: m.id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "qwen-web",
          context_length: m.ctx, context_window: m.ctx, max_context_length: m.ctx,
          max_completion_tokens: m.maxOut, max_output_tokens: m.maxOut,
          top_provider: { context_length: m.ctx, max_completion_tokens: m.maxOut },
        })),
      });
    }
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      return await handleChat(req, res, JSON.parse((await readBody(req)) || "{}"));
    }
    return sendJson(res, 404, { error: { message: `no route ${pathname}`, type: "invalid_request_error" } });
  } catch (e) {
    log("error", pathname, e.message);
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message, type: "qwen_relay" } });
    else res.end();
  }
});

let bound = 0;
for (const h of HOSTS) {
  const s = h === HOSTS[0] ? server : http.createServer(server.listeners("request")[0]);
  s.listen(PORT, h, () => log(`listening on ${h}:${PORT}`)).on("error", (e) => log(`bind ${h} failed: ${e.message}`));
  bound++;
}
log(`qwen-relay starting on ${bound} interface(s); creds age ${credsAge()} min`);
