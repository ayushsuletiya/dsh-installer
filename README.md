# DSH one-click setup

Installs DeepSeek Harness with the full customized setup — providers, plugins, MCP
servers, agent preset, model-picker patches and the Qwen desktop bridge — on a
fresh **macOS** or **Windows** machine.

## Install

**macOS / Linux** — one command, no login:

```bash
curl -fsSL https://raw.githubusercontent.com/ayushsuletiya/dsh-installer/main/install.sh | bash -s -- --secrets ~/dsh-secrets.env
```

or from a clone:

```bash
git clone https://github.com/ayushsuletiya/dsh-installer.git ~/dsh-installer
cd ~/dsh-installer
cp secrets.example.env ~/dsh-secrets.env   # fill in the keys and endpoints you have
./install.sh --secrets ~/dsh-secrets.env
```

**Windows 10/11** — one command, no login, no admin for the normal path:

```powershell
iwr -useb https://raw.githubusercontent.com/ayushsuletiya/dsh-installer/main/install.ps1 -OutFile "$env:TEMP\dsh-install.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\dsh-install.ps1" -Secrets "$HOME\dsh-secrets.env"
```

or from a clone:

```powershell
git clone https://github.com/ayushsuletiya/dsh-installer.git $HOME\dsh-installer
cd $HOME\dsh-installer
copy secrets.example.env $HOME\dsh-secrets.env
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Secrets "$HOME\dsh-secrets.env"
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

## If the machine already has DSH

The installer **stops and asks** rather than taking over. It writes `settings.yaml`,
`.credentials.yaml`, `.env`, the profile's `package.json` and `cordis.patch.yml`, so on
a machine that already has a setup those are someone's providers, plugin list and
MCP rows. Run it there and you get a list of exactly what would be replaced plus
three ways forward:

| | what it does |
| --- | --- |
| `--replace-config` / `-ReplaceConfig` | take over. Every replaced file is copied to `<name>.bak.<timestamp>` first, so the old provider set stays recoverable. |
| `--keep-config` / `-KeepConfig` | touch no config at all. Installs only the runtime, the Qwen bridge, the AgentRouter proxy and the model-picker patches. |
| `DSH_HOME=~/.dsh-new` | a completely separate setup, side by side. Nothing existing is read or written. |

**Chat history is never involved.** `sessions/`, `storages/` (the workspace index)
and `task-board/` are not referenced by any step, on either platform.

Two more things it refuses to do quietly:

- **It will not downgrade a newer DSH.** The pin is `0.1.1-rc.2`; if the machine has
  something newer, that is kept and reported. `--allow-downgrade` forces the pin.
- **It will not start a second Qwen bridge.** If `127.0.0.1:3083` already answers, it
  skips registering its own LaunchAgent / Scheduled Task and names the agent that
  already owns the port — two supervisors on one port means the loser
  `EADDRINUSE`-loops forever.

## Credentials and endpoints

Nothing is baked into the repo — not the keys, and not the addresses of your own
gateways. Both come from `--secrets <file>`, the environment, or an existing
`~/.dsh/.env`; keys land in `~/.dsh/.credentials.yaml` (owner-only).

That is why this repo can be public. The five endpoint values —
`TABITOKEN_BASE_URL`, `OMNIROUTE_BASE_URL`, `QWEN_OMNI_NODE_ID`,
`META_ADS_BRIDGE_URL`, `QWEN_RELAY_SSH` — live only in your secrets file, and a
blank one silently drops the routes that need it rather than writing a provider
that points at nothing:

| blank | what disappears |
| --- | --- |
| `TABITOKEN_BASE_URL` | the Claude Opus 5/4.8 routes; the default session model falls back to Antigravity, then the local Qwen bridge |
| `OMNIROUTE_BASE_URL` | Antigravity, Qwen-via-OmniRoute, the free pools, Codex OAuth |
| `META_ADS_BRIDGE_URL` or its token | all three Meta Ads MCP rows |

With every endpoint set you get 11 providers; with none, 6.

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
