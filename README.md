# DSH one-click setup

Installs DeepSeek Harness with the full customized setup — providers, plugins, MCP
servers, agent preset, model-picker patches and the Qwen desktop bridge — on a
fresh **macOS** or **Windows** machine.

## Install

**macOS / Linux**

```bash
git clone https://github.com/ayushsuletiya/dsh-installer.git ~/dsh-installer
cd ~/dsh-installer
cp secrets.example.env ~/dsh-secrets.env   # fill in the keys you have
./install.sh --secrets ~/dsh-secrets.env
```

**Windows 10/11** (PowerShell, no admin needed for the normal path)

```powershell
git clone https://github.com/ayushsuletiya/dsh-installer.git $HOME\dsh-installer
cd $HOME\dsh-installer
copy secrets.example.env $HOME\dsh-secrets.env   # fill in the keys you have
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Secrets $HOME\dsh-secrets.env
```

Then: `dsh web`.

Every step is idempotent — re-running is safe and only does what is missing. Use
`--dry-run` / `-DryRun` first if you want to see the plan without writing anything.

## What lands on the machine

| | |
| --- | --- |
| **Runtime** | node ≥ 22 (installed via nvm / winget / MSI when absent), pnpm, `@deepseek-ai/dsh` pinned to `0.1.1-rc.2` |
| **Providers** | 11 routes: TabiToken Claude Opus 5/4.8, Antigravity (Gemini 3.x + Claude via OmniRoute), Qwen desktop app, Qwen via OmniRoute, OpenRouter, NVIDIA NIM, AgentRouter, OmniRoute free pools, Codex OAuth, Google Gemini, Z.ai |
| **Plugins** | 10 bundles (web-all, modlens, vision-toolkit, at-file, dshmarket, find, genui, mnemon) + 5 local plugins (compaction retry, keyless DDG search, NIM turn fallback, `qwen_code`, `/clear`) |
| **MCP** | UI Skills (keyless, always on); Meta Ads ×3, Hostinger mail ×2 and Multilogin enabled only when their token / directory is present |
| **Agent preset** | `opus-qwen` — Opus thinks and verifies, `qwen_code` writes, `subagent_qwen` drives files |
| **Model picker** | search across provider/model/id + collapsible provider groups, folding persisted in localStorage |
| **Qwen** | desktop app downloaded and installed automatically, plus the CDP bridge on `127.0.0.1:3083`, kept alive by a LaunchAgent (macOS) or logon Scheduled Task (Windows) |

## Credentials

Nothing is baked into the repo. Keys come from `--secrets <file>`, the environment,
or an existing `~/.dsh/.env`, and land in `~/.dsh/.credentials.yaml` (owner-only).

Anything left blank simply switches that route off and the install still finishes.
Add keys later without reinstalling:

```bash
dsh-setup reconfigure --secrets ~/dsh-secrets.env
```

`AGENTROUTER_API_KEY` is one of these — AgentRouter is a plain HTTP API with no
local process, so it is wired up and waiting whenever you add the key.

## Maintenance

```
dsh-setup doctor        what is wired, what is blank, what is stale
dsh-setup reconfigure   re-render config after a dsh upgrade or a new key
dsh-setup repatch       re-apply the model-picker patches (a dsh upgrade wipes them)
dsh-setup qwen          re-install / relaunch the Qwen desktop app
dsh-setup bridge start|stop|status
```

Run `dsh-setup repatch` after every `npm i -g @deepseek-ai/dsh` — the picker
patches live inside the shipped client bundle and are replaced by the upgrade.

## How the Qwen route works

There is no API key. The bridge attaches to the Qwen desktop app over the Chrome
DevTools Protocol and issues every request from inside the app's own signed-in
`chat.qwen.ai` page, because `/api/v2/chat/completions` is gated by Alibaba's
`bx-ua` / `bx-umidtoken` / `bx-v` triple, which is computed per request by their SDK
inside that page. A request assembled anywhere else is rejected.

So the one manual step on a new machine is signing into the Qwen app once. The
installer downloads and launches it with the debugging port already set; sign in and
the bridge picks up the session.

The installer resolves the download URL from Qwen's own API
(`GET https://qwen.ai/api/config?api.app_download_url`), so new releases need no
change here — macOS gets the arm64 or x64 DMG to match the CPU, Windows gets the
x64 exe installed silently.

## Layout

```
install.sh / install.ps1                the entry points
dsh-setup.sh / dsh-setup.ps1            post-install maintenance
tools/render.mjs                        template renderer ({{VAR}}, #if/#endif)
tools/install-qwen-app.mjs              unattended Qwen desktop install
tools/patch-model-selector.mjs          idempotent model-picker patcher
payload/settings.template.yaml          the 11 providers
payload/profile-web/                    package.json, cordis patch template, 5 plugins
payload/agent-presets/opus-qwen/        the two-model preset
payload/qwen-bridge/                    the bridge, cross-platform
payload/patches/model-selection/<ver>/  patched client bundle + its hashes
```

Absolute paths are never committed: `cordis.patch.yml` and the agent preset are
templates rendered with the target machine's own home directory at install time.

## Refreshing the payload from a working machine

```bash
./tools/sync-from-live.sh
```

Copies this machine's live settings, profile plugins, preset, bridge and model-picker
patch back into `payload/`, stripping secrets and re-templating the paths — so the
installer stays current as the setup evolves.

## Notes

- **OpenCode is removed.** The `opencode-free` provider pointed at a local bridge on
  `127.0.0.1:3082` that does not exist on a new machine; nothing references it now.
- The model-picker patch refuses to touch a bundle whose hash it does not recognise,
  so a DSH version bump degrades to "no folding" instead of a blank picker.
- Windows and macOS share every config artifact; only paths and the autostart
  mechanism differ.
