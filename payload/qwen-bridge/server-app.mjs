#!/usr/bin/env node
// OpenAI-compatible bridge in front of the Qwen DESKTOP APP.
//
// DSH speaks plain OpenAI to 127.0.0.1:3083; every request is executed inside
// the running Qwen app's chat.qwen.ai page over CDP, so it rides Ayush's own
// logged-in session and Alibaba's per-request bx-ua signature is produced by
// their own SDK. No API key, no OpenRouter credit, no Alibaba Cloud account.
//
//   node ~/qwen-bridge/server-app.mjs
//   QWEN_BRIDGE_PORT=3083 QWEN_CDP_PORT=9222 node ~/qwen-bridge/server-app.mjs
//
// Known limits of the web route: no native function calling and no image input.
// Tool calling is therefore asked for in the prompt, and — because Qwen's tool
// JSON is the unreliable part — repaired by a free real-API model that DOES have
// native function calling (see tool-formatter.mjs). Qwen stays the brain on the
// free web quota; the formatter only turns its intent into a schema-valid call.
import http from "node:http";
import { createHash } from "node:crypto";
import { QwenAppClient } from "./qwen-app-client.mjs";
import { repairToolCall, formatterInfo } from "./tool-formatter.mjs";

const PORT = Number(process.env.QWEN_BRIDGE_PORT || 3083);
const HOST = process.env.QWEN_BRIDGE_HOST || "127.0.0.1";

const app = new QwenAppClient();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// This process is long-lived and unsupervised (launchctl cannot load the agent
// from inside the DSH sandbox), and Node exits on an unhandled rejection by
// default - which is how an earlier build died silently after a client timed out
// mid-answer. Log and keep serving instead.
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => log("uncaughtException:", e?.message || e));

// The app reports context/generation limits; these cover ids where it says null.
const FALLBACK_CTX = 1_000_000;
const FALLBACK_OUT = 65_536;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function partsToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return p.text || "";
      if (p?.type === "image_url" || p?.type === "image") return "[image omitted: the Qwen app route is text-only]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

// FIRST turn of a thread only: the whole OpenAI conversation is flattened into
// one tagged prompt, because a fresh Qwen chat has no history to lean on.
// Later turns send just the new user message (see threadKey below), so the DSH
// system prompt is not re-posted into the Qwen app on every request.
function flatten(messages = []) {
  const blocks = [];
  for (const m of messages) {
    const text = partsToText(m?.content);
    if (!text) continue;
    const role = (m.role || "user").toLowerCase();
    if (role === "system") blocks.push(`# System\n${text}`);
    else if (role === "assistant") blocks.push(`# Assistant\n${text}`);
    else if (role === "tool") blocks.push(`# Tool result\n${text}`);
    else blocks.push(`# User\n${text}`);
  }
  if (!blocks.length) return "(empty request)";
  if (blocks.length === 1) return blocks[0].replace(/^# User\n/, "");
  return blocks.join("\n\n");
}

// One Qwen conversation per DSH thread.
//
// DSH resends the whole history every turn, so a thread is identified by its
// system prompt plus its user turns — assistant text is deliberately excluded so
// any client-side reformatting of a reply cannot break the match. `dropLast`
// gives the key of the conversation BEFORE this turn (the lookup); the full form
// gives the key it will have on the next turn (the store).
const threads = new Map(); // key -> { chatId, parentId, at }
const THREAD_CAP = 500;

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

function rememberThread(key, entry) {
  threads.set(key, { ...entry, at: Date.now() });
  if (threads.size > THREAD_CAP) {
    const oldest = [...threads.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, threads.size - THREAD_CAP);
    for (const [k] of oldest) threads.delete(k);
  }
}

// Sidebar-friendly name from the first real user line, so his Qwen history shows
// the topic instead of a slab of system prompt.
function chatTitle(messages) {
  const firstUser = messages.find((m) => (m.role || "user").toLowerCase() === "user");
  const line = partsToText(firstUser?.content)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("<"))
    .pop() || "session";
  return `DSH · ${line.slice(0, 48)}`;
}

function wantsThinking(body) {
  const e = body.reasoning_effort ?? body.reasoning?.effort ?? body.thinking?.type;
  if (e === undefined || e === null) return false;
  const s = String(e).toLowerCase();
  if (["off", "none", "disabled", "false", "minimal"].includes(s)) return false;
  return true;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Thinking arrives as phase "thinking_summary" (thinking_format: summary) and
// possibly other think* phases, never plain "think".
const isThinking = (phase) => !!phase && /think/i.test(phase);

// ---------------------------------------------------------------------------
// Tool calling.
//
// The Qwen web endpoint has no function-calling API, so tools are emulated in
// the prompt: the tool list is described once per thread, the model answers with
// a fenced tool_call block, and that block is translated back into OpenAI
// tool_calls so DSH's own agent loop runs unchanged.
// ---------------------------------------------------------------------------

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
      const schema = f.parameters ? JSON.stringify(compactSchema(f.parameters)) : '{"type":"object","properties":{}}';
      return `- ${f.name}: ${(f.description || "").split("\n")[0].slice(0, 140)}\n  parameters: ${schema}`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return [
    "# Tool protocol",
    "You can use tools. To call one, reply with ONLY this block and nothing else — no prose before or after:",
    "```tool_call",
    '{"name": "<tool name>", "arguments": { ... }}',
    "```",
    "Rules: exactly one JSON object; `arguments` must satisfy that tool's schema; never invent tool names; never wrap the block in extra commentary.",
    "You will receive the result as `# Tool result`, then continue. When no tool is needed, answer normally in plain text.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

const toolsFingerprint = (tools = []) =>
  createHash("sha256")
    .update(tools.map((t) => (t.function || t)?.name || "").join(","))
    .digest("hex")
    .slice(0, 12);

// A reply is a tool call when it opens with the fence (or bare JSON of the same
// shape). Checked against the first characters so streaming can decide early.
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

// Preferred repair path: hand Qwen's intent to a free model with NATIVE function
// calling and use the structured call it returns. Costs no Qwen prompt, cannot
// produce an undeclared name, and fixes wrong argument names as well as broken
// JSON. Returns null when the formatter is disabled, throttled or unsure, and the
// caller then falls back to spending one corrective Qwen turn.
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

const looksLikeToolCall = (s) => /^\s*(```\s*(tool_call|json)|\{\s*"(name|tool_call)")/i.test(s);

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
  const fenced = text.matchAll(/```\s*(?:tool_call|json)?\s*\n([\s\S]*?)\n?```/gi);
  for (const m of fenced) bodies.push(m[1]);
  if (!bodies.length && /^\s*\{/.test(text)) bodies.push(text);
  const calls = [];
  for (const raw of bodies) {
    const obj = looseParse(raw);
    if (!obj) continue;
    const list = Array.isArray(obj) ? obj : [obj.tool_call || obj];
    for (const c of list) {
      const name = c?.name || c?.function?.name;
      if (!name) continue;
      const args = c?.arguments ?? c?.function?.arguments ?? c?.parameters ?? {};
      calls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      });
    }
  }
  return calls.length ? calls : null;
}

// Tool results arrive as role:"tool" messages; label them so the model knows
// which call they answer.
// The Qwen web backend has real function calling: the tool manifest rides on the
// user message as feature_config.local_mcp, the model answers with a `local_tool`
// phase carrying extra.local_mcp = { server: [ { tool_name, params } ] }, and the
// results go back as a role:"function" turn whose content is
// { server: [ { <toolName>: "<result string>" } ] }. Prompt emulation below is kept
// only for the (rare) model that answers with a text block anyway.
const MCP_SERVER = "dsh";

function nativeManifest(tools = []) {
  const map = {};
  for (const t of tools) {
    const f = t.function || t;
    if (!f?.name) continue;
    map[f.name] = {
      description: String(f.description || f.name).slice(0, 2048),
      input_schema: f.parameters || { type: "object", properties: {} },
    };
  }
  return Object.keys(map).length ? { [MCP_SERVER]: map } : null;
}

/** The trailing run of tool results, in the shape the app posts back. */
function nativeResults(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if ((m.role || "").toLowerCase() !== "tool") break;
    const name =
      m.name ||
      messages.flatMap((x) => x.tool_calls || []).find((c) => c.id === m.tool_call_id)?.function?.name ||
      "tool";
    out.unshift({ [name]: partsToText(m.content) || "(no output)" });
  }
  return out.length ? { [MCP_SERVER]: out } : null;
}

/** Native calls -> OpenAI tool_calls. */
function asOpenAICalls(calls = []) {
  return calls.map((c) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
  }));
}

function toolResultBlock(messages, msg) {
  const name =
    msg.name ||
    messages
      .flatMap((m) => m.tool_calls || [])
      .find((c) => c.id === msg.tool_call_id)?.function?.name ||
    "tool";
  return `# Tool result (${name})\n${partsToText(msg.content) || "(no output)"}`;
}

async function handleModels(res) {
  const models = await app.listModels();
  sendJson(res, 200, {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: nowSec(),
      owned_by: "qwen-desktop-app",
      context_window: m.ctx || FALLBACK_CTX,
      max_output_tokens: m.maxOut || FALLBACK_OUT,
      capabilities: m.caps || {},
    })),
  });
}

// The same session generates images: /api/models advertises chat_type "t2i" on
// every model, a t2i turn streams a `phase: "image_gen"` delta whose content IS a
// signed cdn.qwenlm.ai URL, and the body's `size` field is a ratio, not pixels.
const RATIOS = { "1:1": 1, "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4 };

/** OpenAI sends pixels ("1024x1024"); Qwen wants the nearest ratio it serves. */
function sizeToRatio(size) {
  if (!size || size === "auto") return "1:1";
  if (RATIOS[size]) return size;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(size));
  if (!m) return "1:1";
  const want = Number(m[1]) / Number(m[2]);
  return Object.keys(RATIOS).reduce((best, k) =>
    Math.abs(RATIOS[k] - want) < Math.abs(RATIOS[best] - want) ? k : best, "1:1");
}

const IMAGE_URL = /https?:\/\/[^\s"']+/;

async function handleImages(req, res, body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return sendJson(res, 400, { error: { message: "prompt is required", type: "invalid_request_error" } });
  const model = body.model && body.model !== "dall-e-3" && body.model !== "gpt-image-1" ? body.model : "qwen3.7-plus";
  const size = sizeToRatio(body.size);
  const n = Math.min(Math.max(Number(body.n) || 1, 1), 4);
  const wantB64 = body.response_format === "b64_json";
  log("image", model, size, `n=${n}`, `${prompt.length}ch`);
  const urls = [];
  try {
    for (let i = 0; i < n; i += 1) {
      let seen = "";
      await app.complete({ model, content: prompt, thinking: false, chatType: "t2i", size, title: prompt.slice(0, 40) },
        (d) => { if (d.content) seen += d.content; }, { timeoutMs: 300_000 });
      const hit = IMAGE_URL.exec(seen);
      if (!hit) throw new Error(`no image came back${seen ? `: ${seen.slice(0, 160)}` : ""}`);
      urls.push(hit[0]);
    }
  } catch (e) {
    log("image failed:", e.message);
    return sendJson(res, 502, { error: { message: e.message, type: "qwen_app_bridge" } });
  }
  const data = [];
  for (const url of urls) {
    if (!wantB64) { data.push({ url, revised_prompt: prompt }); continue; }
    const r = await fetch(url);
    data.push({ b64_json: Buffer.from(await r.arrayBuffer()).toString("base64"), revised_prompt: prompt });
  }
  return sendJson(res, 200, { created: nowSec(), data });
}

async function completeRecovering(turn, onDelta, lookupKey) {
  let emitted = false;
  try {
    return await app.complete(turn, (d) => { emitted = true; onDelta(d); });
  } catch (e) {
    const gone = /HTTP (400|401|403|404)/.test(e?.message || "");
    if (!turn.chatId || emitted || !gone) throw e;
    log("continue failed, chat is gone - opening a fresh one:", String(e.message).slice(0, 120));
    threads.delete(lookupKey);
    const fresh = { ...turn, content: turn.freshContent || turn.content };
    delete fresh.chatId;
    delete fresh.parentId;
    delete fresh.fnResults;
    return await app.complete(fresh, onDelta);
  }
}

async function handleChat(req, res, body) {
  const model = body.model || "qwen3.8-max";
  const messages = body.messages || [];
  const thinking = wantsThinking(body);
  // OpenAI defaults `stream` to false when the field is absent, and clients that
  // never stream simply omit it — answering those with SSE handed them a body
  // they cannot parse. Only an explicit true streams.
  const stream = body.stream === true;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = nowSec();

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolsFp = tools.length ? toolsFingerprint(tools) : "";

  // Continue this thread's existing Qwen conversation when we have one: only the
  // newest turn goes over the wire, and the app shows one tidy chat per thread
  // instead of the whole system prompt re-posted every request.
  const lookupKey = threadKey(messages, model, { dropLast: true, toolsFp });
  const storeKey = threadKey(messages, model, { toolsFp });
  let known = threads.get(lookupKey);
  // A changed tool set must be re-declared, and the cheapest correct way is a
  // fresh conversation carrying the new manifest.
  if (known && toolsFp && known.toolsFp && known.toolsFp !== toolsFp) known = null;

  const last = messages[messages.length - 1] || {};
  const lastIsTool = (last.role || "").toLowerCase() === "tool";
  const localMcp = nativeManifest(tools);
  const fnResults = known && lastIsTool ? nativeResults(messages) : null;
  let content;
  if (known) {
    content = lastIsTool && !fnResults ? toolResultBlock(messages, last) : partsToText(last.content) || "(empty turn)";
  } else {
    // With a native manifest the tool list is a wire field, so the prompt stays
    // the conversation and nothing is spent explaining a text protocol.
    const manifest = localMcp ? "" : toolManifest(tools);
    content = manifest ? `${manifest}\n\n${flatten(messages)}` : flatten(messages);
  }
  if (known && tools.length && !localMcp) {
    content += `\n\n(Valid tools: ${toolNames(tools).join(", ")})`;
  }
  if (tools.length && !localMcp && String(body.tool_choice || "") === "required") {
    content += "\n\nYou MUST answer with a tool_call block this turn.";
  }

  const turn = { model, content, thinking, title: chatTitle(messages) };
  if (known) {
    turn.chatId = known.chatId;
    turn.parentId = known.parentId;
    turn.freshContent = localMcp ? flatten(messages) : [toolManifest(tools), flatten(messages)].filter(Boolean).join("\n\n");
  }
  if (localMcp) turn.localMcp = localMcp;
  if (fnResults) turn.fnResults = fnResults;

  log("chat", model, thinking ? "(thinking)" : "", `${content.length}ch`,
      tools.length ? `${tools.length} tools` : "no tools",
      known ? `continue ${known.chatId.slice(0, 8)}` : "new chat", stream ? "stream" : "blocking");

  if (!stream) {
    let text = "", reasoning = "";
    const done = await completeRecovering(turn, (d) => {
      if (isThinking(d.phase)) reasoning += d.content || "";
      else text += d.content || "";
    }, lookupKey);
    if (done?.chatId && done?.responseId) rememberThread(storeKey, { chatId: done.chatId, parentId: done.responseId, toolsFp });
    let u = done?.usage || {};
    const allowed = tools.length ? toolNames(tools) : [];
    let calls = null;
    // Native path: the backend already returned parsed calls, so no text is parsed
    // and no repair model is spent.
    const native = asOpenAICalls(done?.toolCalls || []);
    if (native.length) calls = native;
    else if (tools.length) {
      const { good, bad } = splitCalls(parseToolCalls(text), allowed);
      calls = good;
      // Repair when the names were invented, when a tool_call was clearly meant
      // but would not parse, or when DSH demanded a call and got prose.
      const mustCall = String(body.tool_choice || "") === "required";
      if (!calls && (bad.length || looksLikeToolCall(text) || mustCall)) {
        calls = await repairCalls({
          text, intentName: bad[0] || "", tools,
          why: bad.length ? `invented ${bad.join(",")}` : mustCall ? "tool_choice required" : "unparsed block",
        });
        // Formatter unavailable or unsure: fall back to spending one Qwen turn.
        if (!calls && bad.length) {
          log("invented tool name(s):", bad.join(","), "- asking again");
          let retry = "";
          const again = await app.complete(
            { model, content: correctionPrompt(bad, allowed), thinking: false, chatId: done.chatId, parentId: done.responseId },
            (d) => { if (!isThinking(d.phase)) retry += d.content || ""; },
          );
          if (again?.responseId) rememberThread(storeKey, { chatId: again.chatId, parentId: again.responseId, toolsFp });
          calls = splitCalls(parseToolCalls(retry), allowed).good;
          if (!calls) text = retry || text;
          u = again?.usage || u;
        }
      }
    }
    return sendJson(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{
        index: 0,
        message: calls
          ? { role: "assistant", content: null, tool_calls: calls, ...(reasoning ? { reasoning_content: reasoning } : {}) }
          : { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: calls ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: u.input_tokens ?? 0,
        completion_tokens: u.output_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
      },
    });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (obj) => { if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { log("write failed:", e.message); } } };
  const frame = (delta, finish_reason = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason }],
  });

  write(frame({ role: "assistant", content: "" }));
  let closed = false;
  req.on("close", () => { closed = true; });

  // With tools enabled the first characters decide whether this reply is a tool
  // call, so hold them back: prose is flushed and streams live from then on,
  // while a tool_call block is buffered whole and converted at the end.
  let head = "", answer = "", buffering = tools.length > 0, decided = !tools.length;
  const emit = (t) => {
    if (!t) return;
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
    const done = await completeRecovering(turn, (d) => {
      if (closed || !d.content) return;
      if (isThinking(d.phase)) return write(frame({ reasoning_content: d.content }));
      emit(d.content);
    }, lookupKey);
    if (done?.chatId && done?.responseId) rememberThread(storeKey, { chatId: done.chatId, parentId: done.responseId, toolsFp });
    const allowed = tools.length ? toolNames(tools) : [];
    let calls = null;
    // Native path: the backend already returned parsed calls, so no text is parsed
    // and no repair model is spent.
    const native = asOpenAICalls(done?.toolCalls || []);
    if (native.length) calls = native;
    else if (tools.length) {
      const { good, bad } = splitCalls(parseToolCalls(answer), allowed);
      calls = good;
      // Only convert while nothing has been flushed to the client yet: once prose
      // is on the wire it cannot be taken back and turned into a tool call.
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
          const again = await app.complete(
            { model, content: correctionPrompt(bad, allowed), thinking: false, chatId: done?.chatId, parentId: done?.responseId },
            (d) => { if (!isThinking(d.phase)) retry += d.content || ""; },
          );
          if (again?.responseId) rememberThread(storeKey, { chatId: again.chatId, parentId: again.responseId, toolsFp });
          calls = splitCalls(parseToolCalls(retry), allowed).good;
          if (!calls) answer = retry || answer;
        }
      }
    }
    if (!closed && !calls && buffering) write(frame({ content: answer }));   // short reply that never tripped the flush
    else if (!closed && !calls && !decided) write(frame({ content: head }));
    if (!closed && calls) {
      calls.forEach((c, i) =>
        write(frame({ tool_calls: [{ index: i, id: c.id, type: "function", function: c.function }] })));
    }
    if (!closed) {
      write(frame({}, calls ? "tool_calls" : "stop"));
      const u = done?.usage;
      if (u) {
        write({
          id, object: "chat.completion.chunk", created, model, choices: [],
          usage: {
            prompt_tokens: u.input_tokens ?? 0,
            completion_tokens: u.output_tokens ?? 0,
            total_tokens: u.total_tokens ?? 0,
          },
        });
      }
      res.write("data: [DONE]\n\n");
    }
  } catch (e) {
    log("stream failed:", e.message);
    if (!closed) write({ error: { message: e.message, type: "qwen_app_bridge" } });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  // A client that walks away mid-answer must not take the process with it.
  req.on("error", (e) => log("request socket error:", e.message));
  res.on("error", (e) => log("response socket error:", e.message));
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (pathname === "/health" || pathname === "/") {
      return sendJson(res, 200, { ok: true, port: PORT, route: "qwen desktop app (CDP)", threads: threads.size, toolRepair: formatterInfo(), ...(await app.health()) });
    }
    if (pathname === "/v1/models" && req.method === "GET") return await handleModels(res);
    if ((pathname === "/v1/images/generations" || pathname === "/v1/images/generate") && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
      }
      return void (await handleImages(req, res, body));
    }
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
      }
      return await handleChat(req, res, body);
    }
    return sendJson(res, 404, { error: { message: `no route ${pathname}`, type: "invalid_request_error" } });
  } catch (e) {
    log("error on", pathname, "-", e.message);
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message, type: "qwen_app_bridge" } });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  log(`qwen-app bridge on http://${HOST}:${PORT}`);
  try {
    const h = await app.health();
    log("app:", JSON.stringify(h));
    const models = await app.listModels();
    log("models:", models.map((m) => m.id).join(", "));
  } catch (e) {
    log("WARNING:", e.message);
  }
});
