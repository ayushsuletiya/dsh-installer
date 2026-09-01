# qwen-bridge

Uses the **Qwen desktop app** as an LLM backend for DeepSeek Harness. No API key,
no billing: every request runs inside the app's own `chat.qwen.ai` page, on the
account already signed in there.

```
DSH ──OpenAI HTTP──► 127.0.0.1:3083 ──CDP :9222──► Qwen.app page ──► chat.qwen.ai
```

## Run

```bash
node ~/qwen-bridge/server-app.mjs          # bridge on 127.0.0.1:3083
curl -s http://127.0.0.1:3083/health       # app attached? logged in?
```

The app must be running with a debugging port. If it is not, the bridge quits
and relaunches it itself:

```bash
open -a Qwen --args --remote-debugging-port=9222
```

Auto-start at login (must be run from a normal terminal — `launchctl` refuses
this from inside the DSH sandbox):

```bash
launchctl load ~/Library/LaunchAgents/com.ayush.qwen-bridge.plist
```

## Why it has to go through the app

`POST /api/v2/chat/completions` is gated by Alibaba's anti-bot triple
`bx-ua` / `bx-umidtoken` / `bx-v`. `bx-ua` is a signed blob computed per request
by their SDK, which monkey-patches `window.fetch` in that page — so a fetch
issued *from the page* is signed automatically, while anything assembled outside
it (curl, node, even the page's session token replayed elsewhere) comes back as
`{"code":"Bad_Request"}`. Captured from a real send on 28 Aug 2026, the other
required bits are:

- headers `source: desktop`, `Version: <fe build, e.g. 0.2.89>`, a `Timezone`
  header, `X-Request-Id`, `X-Accel-Buffering: no`
- body: `version: "2.1"`, both `chatId`/`chat_id` and `parentId`/`parent_id`,
  and a message carrying `files: []`, `childrenIds: [<assistant uuid>]` and the
  full `feature_config` (`thinking_enabled`, `output_schema: "phase"`,
  `research_mode`, `auto_thinking`, `thinking_mode`, `thinking_format`,
  `auto_search`)

## Layout

| file | role |
| --- | --- |
| `server-app.mjs` | OpenAI-compatible HTTP server (`/v1/models`, `/v1/chat/completions`, `/health`) |
| `qwen-app-client.mjs` | CDP client: attaches to the app, injects `window.__dshQwen`, streams deltas back through a CDP binding |
| `server-oauth.mjs`, `qwen-auth.mjs`, `qwen-login.mjs` | the unused official OAuth route (see below) |

## Behaviour notes

- Models come from the app itself: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.7-max`,
  `qwen3.6-plus`, `qwen3.5-plus` (1M context) and `qwen3.5-omni-plus` (262k).
- One Qwen conversation per DSH thread: the first turn carries the flattened
  history (and the tool manifest), later turns send only the new message and let
  Qwen keep the history. Threads are keyed on the system prompt plus user turns,
  so a reformatted assistant reply cannot break the match.
- Reasoning: any `reasoning_effort` other than off/none turns on the app's
  Thinking mode. When the stream emits a `thinking_summary` phase it is
  forwarded as `reasoning_content`; often the model inlines its reasoning in the
  answer instead.
- **Tool calling works** through prompt emulation: the OpenAI `tools` array is
  declared once per thread, the model replies with a ```tool_call``` block, and the
  bridge converts it to OpenAI `tool_calls` (`finish_reason: tool_calls`) so DSH's
  agent loop runs unchanged. Tool results come back as `role: "tool"` messages and
  are relabelled `# Tool result (name)` for the model.
- **No image input** on this route — text only.
- Budget: the free Qwen Studio quota is roughly 100 prompts/day, and each tool
  round trip spends one, so a long agent loop burns it fast. Thread reuse keeps
  the count to one prompt per DSH turn instead of re-sending history.
- Every request shows up as a conversation in the desktop app's own history.

## The OAuth route (kept, not in use)

`qwen-login.mjs` implements Qwen's official device flow (free tier, 2000
requests/day, creds shared with the `@qwen-code` CLI at
`~/.qwen/oauth_creds.json`). Device codes mint fine, but this deployment's web
app has no approval page — `/device` is not a route and `/authorize` ignores the
`user_code` — so the flow cannot be completed. If Qwen ships that page again:

```bash
node ~/qwen-bridge/qwen-login.mjs --open   # then swap the provider baseURL to server-oauth.mjs
```
