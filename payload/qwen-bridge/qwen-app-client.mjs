// Talks to the Qwen desktop app over the Chrome DevTools Protocol and runs
// every API call INSIDE its chat.qwen.ai page.
//
// Why: /api/v2/chat/completions is gated by Alibaba's anti-bot triple
// (bx-ua / bx-umidtoken / bx-v). bx-ua is computed per request by their SDK,
// which monkey-patches window.fetch in that page - so a fetch issued from the
// page is signed for us, while any request built outside it is rejected with
// {"code":"Bad_Request"}. Captured from a real app send on 28 Aug 2026, the
// other must-have bits are source: desktop, Version: <fe build>, a Timezone
// header, and a message body carrying files/childrenIds/full feature_config.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CDP_PORT = Number(process.env.QWEN_CDP_PORT || 9222);
const APP_NAME = process.env.QWEN_APP_NAME || "Qwen";
const PAGE_MATCH = "chat.qwen.ai";
const BINDING = "__dshQwenEmit";
const FE_VERSION_FALLBACK = "0.2.89";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "[app]", ...a);

// ---------- cross-platform app control ----------
// The bridge must be able to (re)start the desktop app WITH the remote-debugging
// flag on whatever OS it is installed on. `QWEN_APP_PATH` overrides discovery.
function windowsCandidates() {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    path.join(local, "Programs", "Qwen", "Qwen.exe"),
    path.join(local, "Programs", "qwen", "Qwen.exe"),
    path.join(local, "Qwen", "Qwen.exe"),
    path.join(pf, "Qwen", "Qwen.exe"),
    path.join(pf86, "Qwen", "Qwen.exe"),
  ];
}

function linuxCandidates() {
  const home = homedir();
  return [
    "/usr/bin/qwen-desktop",
    "/usr/local/bin/qwen-desktop",
    "/opt/Qwen/qwen",
    path.join(home, "Applications", "Qwen.AppImage"),
    path.join(home, ".local", "bin", "Qwen.AppImage"),
  ];
}

/** Resolve how to quit and how to launch the app on this platform. */
function appLauncher() {
  const override = process.env.QWEN_APP_PATH;
  const flag = `--remote-debugging-port=${CDP_PORT}`;

  if (process.platform === "darwin") {
    if (override) {
      return {
        quit: ["osascript", ["-e", `quit app "${APP_NAME}"`]],
        launch: [override, [flag]],
      };
    }
    return {
      quit: ["osascript", ["-e", `quit app "${APP_NAME}"`]],
      launch: ["open", ["-a", APP_NAME, "--args", flag]],
    };
  }

  if (process.platform === "win32") {
    const exe = override || windowsCandidates().find((p) => existsSync(p));
    if (!exe) {
      throw new Error(
        "Qwen desktop app not found. Install it, or set QWEN_APP_PATH to Qwen.exe.",
      );
    }
    return {
      quit: ["taskkill", ["/IM", path.basename(exe), "/F"]],
      launch: [exe, [flag]],
    };
  }

  const bin = override || linuxCandidates().find((p) => existsSync(p));
  if (!bin) {
    throw new Error(
      "Qwen desktop app not found. Install it, or set QWEN_APP_PATH to its binary.",
    );
  }
  return { quit: ["pkill", ["-f", path.basename(bin)]], launch: [bin, [flag]] };
}

export class QwenAppClient {
  constructor() {
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.streams = new Map(); // requestId -> {onDelta, onDone, onError}
    this.connecting = null;
    this.installed = false;
  }

  // ---------- CDP plumbing ----------

  async targets() {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`CDP list failed: ${res.status}`);
    return res.json();
  }

  async findPage() {
    const list = await this.targets().catch(() => null);
    if (!list) return null;
    return list.find((t) => (t.url || "").includes(PAGE_MATCH) && t.webSocketDebuggerUrl) || null;
  }

  // The debugging port only exists if the app was started with the flag, so a
  // plain "app is running" check is not enough - we relaunch it when the port
  // is dead.
  async ensureApp() {
    if (await this.findPage()) return true;
    log("no CDP page; restarting the Qwen app with remote debugging");
    const { quit, launch } = appLauncher();
    await new Promise((r) => {
      const p = spawn(quit[0], quit[1], { stdio: "ignore" });
      p.on("close", r);
      p.on("error", r);
    });
    await sleep(2500);
    spawn(launch[0], launch[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await this.findPage()) {
        log("app back with CDP on", CDP_PORT);
        return true;
      }
    }
    throw new Error(`Qwen app did not expose a debugging port on ${CDP_PORT}`);
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.ensureApp();
      const page = await this.findPage();
      if (!page) throw new Error("chat.qwen.ai page not found in the Qwen app");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("CDP socket error")), { once: true });
      });
      ws.addEventListener("message", (e) => this.onMessage(e));
      ws.addEventListener("error", () => log("CDP socket error (will reconnect on next call)"));
      ws.addEventListener("close", () => {
        log("CDP socket closed");
        this.ws = null;
        this.installed = false;
        for (const s of this.streams.values()) s.onError(new Error("app connection closed mid-stream"));
        this.streams.clear();
      });
      this.ws = ws;
      this.installed = false;
      await this.send("Runtime.enable");
      await this.send("Runtime.addBinding", { name: BINDING });
      // Keep the renderer out of Chromium's frozen/throttled states while the
      // app sits in the background, or a request can stall for minutes.
      await this.send("Page.enable").catch(() => {});
      await this.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      log("attached to", page.url);
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error("CDP not connected"));
      const id = ++this.nextId;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === BINDING) {
      let payload;
      try {
        payload = JSON.parse(msg.params.payload);
      } catch {
        return;
      }
      const stream = this.streams.get(payload.rid);
      if (!stream) return;
      if (payload.type === "delta") stream.onDelta(payload);
      else if (payload.type === "toolcall") {
        for (const [server, calls] of Object.entries(payload.calls || {}))
          for (const call of calls || []) stream.toolCalls.push({ server, name: call.tool_name, args: call.params ?? {} });
      }
      else if (payload.type === "done") {
        this.streams.delete(payload.rid);
        stream.onDone({ ...payload, toolCalls: stream.toolCalls });
      } else if (payload.type === "error") {
        this.streams.delete(payload.rid);
        stream.onError(new Error(payload.message || "page error"));
      }
      return;
    }
    // A navigation drops our injected helper and kills any answer in flight.
    if (msg.method === "Runtime.executionContextsCleared") {
      this.installed = false;
      for (const s of this.streams.values()) s.onError(new Error("the Qwen app page navigated mid-answer"));
      this.streams.clear();
    }
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    await this.connect();
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "page exception");
    }
    return r.result?.value;
  }

  // ---------- page-side helper ----------

  async install() {
    if (this.installed) {
      const ok = await this.evaluate(`typeof window.__dshQwen === "object"`).catch(() => false);
      if (ok) return;
    }
    await this.evaluate(`(() => {
      const EMIT = (o) => window.${BINDING}(JSON.stringify(o));
      const feVersion = () => {
        const m = [...document.querySelectorAll('link[href*="qwen-chat-fe"],script[src*="qwen-chat-fe"]')]
          .map(n => (n.href || n.src || "").match(/qwen-chat-fe\\/([0-9.]+)\\//)).find(Boolean);
        return (m && m[1]) || "${FE_VERSION_FALLBACK}";
      };
      const headers = () => ({
        "X-Request-Id": crypto.randomUUID(),
        "Authorization": "Bearer " + localStorage.getItem("token"),
        "X-Accel-Buffering": "no",
        "Timezone": new Date().toString(),
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "source": "desktop",
        "Version": feVersion(),
      });
      window.__dshQwen = {
        version: feVersion(),
        async models() {
          const r = await fetch("/api/models", { headers: headers() });
          const j = await r.json();
          return (j.data || []).map(m => ({
            id: m.id,
            name: (m.info && m.info.name) || m.name || m.id,
            caps: (m.info && m.info.meta && m.info.meta.capabilities) || {},
            ctx: (m.info && m.info.meta && m.info.meta.max_context_length) || null,
            maxOut: (m.info && m.info.meta && m.info.meta.max_generation_length) || null,
          }));
        },
        async newChat(model, title, chatType) {
          const r = await fetch("/api/v2/chats/new", {
            method: "POST", headers: headers(),
            body: JSON.stringify({ title: title || "DSH", models: [model], chat_mode: "normal", chat_type: chatType || "t2t", timestamp: Date.now() }),
          });
          const j = await r.json();
          if (!j || j.success === false || !j.data || !j.data.id) throw new Error("newChat failed: " + JSON.stringify(j).slice(0, 200));
          return j.data.id;
        },
        // Streams a completion, pushing every delta out through the CDP binding.
        // Pass chatId+parentId to CONTINUE an existing conversation: Qwen then
        // keeps the history server-side, so only the new turn goes on the wire.
        async complete(rid, { model, content, thinking, chatId, parentId, title, localMcp, fnResults, chatType, size }) {
          try {
            const kind = chatType || "t2t";
            const isNew = !chatId;
            if (isNew) chatId = await this.newChat(model, title, kind);
            const parent = parentId || null;
            const fid = crypto.randomUUID(), aid = crypto.randomUUID();
            const ts = Math.floor(Date.now() / 1000);
            const feature = {
              thinking_enabled: !!thinking, output_schema: "phase", research_mode: "normal",
              auto_thinking: false, thinking_mode: thinking ? "Thinking" : "NoThinking",
              thinking_format: "summary", auto_search: false,
            };
            if (localMcp && Object.keys(localMcp).length) {
              feature.mcp = Object.keys(localMcp);
              feature.local_mcp = localMcp;
            }
            const turnMessage = fnResults
              ? {
                  role: "function", content: fnResults, chat_type: "t2t", sub_chat_type: "t2t",
                  models: [model], model: "", timestamp: ts, parentId: parent, parent_id: parent,
                  feature_config: { thinking_enabled: !!thinking, output_schema: "phase", research_mode: "normal",
                    auto_thinking: false, thinking_mode: thinking ? "Thinking" : "NoThinking",
                    thinking_format: "summary", auto_search: false },
                  extra: { meta: { subChatType: "t2t" } },
                }
              : null;
            const body = {
              stream: true, version: "2.1", incremental_output: true,
              chatId, parentId: parent || "", chat_id: chatId, chat_mode: "normal",
              model, parent_id: parent, timestamp: ts,
              ...(size ? { size } : {}),
              messages: [turnMessage || {
                id: null, fid, parentId: parent, childrenIds: [aid], role: "user",
                content, user_action: "chat", files: [], timestamp: ts,
                models: [model], model: "", chat_type: kind,
                feature_config: feature,
                extra: { meta: { subChatType: kind } }, sub_chat_type: kind, parent_id: parent,
              }],
            };
            const res = await fetch("/api/v2/chat/completions?chat_id=" + chatId, {
              method: "POST", headers: headers(), body: JSON.stringify(body),
            });
            const ctype = res.headers.get("content-type") || "";
            if (!res.ok || !ctype.includes("event-stream")) {
              const t = await res.text();
              throw new Error("HTTP " + res.status + " " + t.slice(0, 300));
            }
            const reader = res.body.getReader(), dec = new TextDecoder();
            let buf = "", usage = null, locked = null, responseId = null;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf("\\n\\n")) >= 0) {
                const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
                for (const line of frame.split("\\n")) {
                  if (!line.startsWith("data:")) continue;
                  const raw = line.slice(5).trim();
                  if (!raw || raw === "[DONE]") continue;
                  let ev; try { ev = JSON.parse(raw); } catch { continue; }
                  // The page is a live app: a stray generation (regenerate,
                  // title, another tab) can share this socket. Lock onto the
                  // first response_id and drop everything else, otherwise two
                  // answers interleave into one string.
                  const evRid = ev.response_id || (ev["response.created"] && ev["response.created"].response_id);
                  if (evRid) { if (locked === null) { locked = evRid; responseId = evRid; } else if (evRid !== locked) continue; }
                  if (ev.usage) usage = ev.usage;
                  const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
                  if (!d) continue;
                  if (d.extra && d.extra.local_mcp) EMIT({ rid, type: "toolcall", calls: d.extra.local_mcp });
                  else if (d.content) EMIT({ rid, type: "delta", phase: d.phase || "answer", content: d.content });
                  if (d.status === "finished") EMIT({ rid, type: "delta", phase: d.phase || "answer", finish: true });
                }
              }
            }
            EMIT({ rid, type: "done", usage, chatId, responseId });
          } catch (e) {
            EMIT({ rid, type: "error", message: String((e && e.message) || e) });
          }
        },
      };
      return true;
    })()`);
    this.installed = true;
  }

  async listModels() {
    await this.install();
    return this.evaluate(`window.__dshQwen.models()`);
  }

  // onDelta({phase, content}) is called as tokens arrive; resolves with usage.
  // A hard timeout keeps a wedged page (navigation mid-answer, frozen renderer)
  // from leaving the HTTP request hanging forever.
  async complete({ model, content, thinking, chatId, parentId, title, localMcp, fnResults, chatType, size }, onDelta, { timeoutMs = 300_000 } = {}) {
    await this.install();
    const rid = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn) => (v) => {
        if (timer) clearTimeout(timer);
        this.streams.delete(rid);
        fn(v);
      };
      const done = settle(resolve);
      const fail = settle(reject);
      let lastActivity = Date.now();
      this.streams.set(rid, {
        toolCalls: [],
        onDelta: (d) => {
          lastActivity = Date.now();
          try {
            onDelta(d);
          } catch (e) {
            log("onDelta threw:", e.message);
          }
        },
        onDone: done,
        onError: fail,
      });
      timer = setInterval(() => {
        if (Date.now() - lastActivity > timeoutMs) {
          clearInterval(timer);
          timer = null;
          fail(new Error(`no output from the Qwen app for ${Math.round(timeoutMs / 1000)}s`));
        }
      }, 5000);
      const payload = JSON.stringify({ model, content, thinking: !!thinking, chatId, parentId, title, localMcp, fnResults, chatType, size });
      // Fire and forget: the result arrives through the binding, not this call.
      this.evaluate(`window.__dshQwen.complete(${JSON.stringify(rid)}, ${payload}), true`, { awaitPromise: false })
        .catch((e) => fail(e));
    });
  }

  async health() {
    const page = await this.findPage();
    if (!page) return { app: "not running with debugging port", cdpPort: CDP_PORT };
    let loggedIn = null, version = null;
    try {
      const info = await this.evaluate(`(() => ({ t: !!localStorage.getItem("token"), u: location.href }))()`);
      loggedIn = info?.t ?? null;
      version = (await this.evaluate(`(window.__dshQwen && window.__dshQwen.version) || null`)) || null;
    } catch {}
    return { app: "attached", cdpPort: CDP_PORT, page: page.url, loggedIn, feVersion: version };
  }
}
