#!/usr/bin/env bash
# dsh-setup — re-run parts of the DSH one-click setup after the first install.
#
#   dsh-setup reconfigure [--secrets <file>]   re-render settings + profile + preset
#   dsh-setup repatch                          re-apply the model-picker patches
#   dsh-setup qwen                             (re)install and relaunch the Qwen app
#   dsh-setup bridge [start|stop|status]        control the Qwen bridge
#   dsh-setup doctor                           report what is wired and what is not
#   dsh-setup update                           pull a newer payload, then reconfigure
#
# `reconfigure` is the one to reach for after a `dsh` upgrade or when adding an API
# key: it is the same idempotent path the installer takes, minus the Node/DSH
# bootstrap, so it never reinstalls anything it does not have to.
set -eu

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
BRIDGE_DIR="${QWEN_BRIDGE_DIR:-$HOME/qwen-bridge}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/web"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
bad()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '  %s\n' "$*"; }

usage() { sed -n '2,18p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

CMD="${1:-}"
[ $# -gt 0 ] && shift || true

case "$CMD" in
  reconfigure)
    # Everything except the Node/DSH bootstrap and the Qwen app download.
    exec bash "$HERE/install.sh" --replace-config --skip-qwen --skip-profile-install "$@"
    ;;

  repatch)
    exec node "$HERE/tools/patch-model-selector.mjs" "$@"
    ;;

  qwen)
    exec node "$HERE/tools/install-qwen-app.mjs" "$@"
    ;;

  bridge)
    ACTION="${1:-status}"
    PLIST="$HOME/Library/LaunchAgents/com.dsh.qwen-bridge.plist"
    case "$ACTION" in
      start)
        if [ "$(uname -s)" = Darwin ] && [ -f "$PLIST" ] && launchctl load -w "$PLIST" 2>/dev/null; then
          ok "LaunchAgent loaded"
        else
          nohup "$BRIDGE_DIR/run.sh" >/dev/null 2>&1 &
          ok "bridge started detached (pid $!)"
        fi
        ;;
      stop)
        launchctl unload "$PLIST" 2>/dev/null || true
        pkill -f 'qwen-bridge/server-app.mjs' 2>/dev/null || true
        pkill -f 'qwen-bridge/run.sh' 2>/dev/null || true
        ok "bridge stopped"
        ;;
      status)
        if curl -fsS --max-time 3 http://127.0.0.1:3083/health 2>/dev/null; then
          printf '\n'; ok "bridge healthy on 127.0.0.1:3083"
        else
          bad "bridge not answering on 127.0.0.1:3083"
          info "log: $BRIDGE_DIR/bridge.log"
        fi
        ;;
      *) usage; exit 2 ;;
    esac
    ;;

  doctor)
    printf '%sDSH setup report%s\n\n' "$C_BOLD" "$C_RESET"

    if command -v node >/dev/null 2>&1; then ok "node $(node -v)"; else bad "node missing"; fi
    if command -v pnpm >/dev/null 2>&1; then ok "pnpm $(pnpm -v)"; else warn "pnpm missing"; fi
    if command -v dsh  >/dev/null 2>&1; then ok "dsh $(dsh --version 2>/dev/null)"; else bad "dsh missing"; fi

    printf '\n%sconfig%s\n' "$C_BOLD" "$C_RESET"
    for f in settings.yaml .credentials.yaml .env; do
      if [ -f "$DSH_HOME_DIR/$f" ]; then ok "$f"; else bad "$f missing"; fi
    done
    if [ -f "$DSH_HOME_DIR/settings.yaml" ]; then
      P="$(grep -cE '^    [a-z0-9-]+:$' "$DSH_HOME_DIR/settings.yaml" 2>/dev/null || echo 0)"
      info "$P provider blocks"
      if grep -q opencode "$DSH_HOME_DIR/settings.yaml" 2>/dev/null; then
        warn "opencode still referenced — run: dsh-setup reconfigure"
      else
        ok "opencode absent"
      fi
    fi

    printf '\n%scredentials%s\n' "$C_BOLD" "$C_RESET"
    if [ -f "$DSH_HOME_DIR/.credentials.yaml" ]; then
      while IFS= read -r line; do
        case "$line" in
          *:*)
            key="$(printf '%s' "$line" | sed -E 's/^ *([A-Z0-9_]+):.*/\1/')"
            val="$(printf '%s' "$line" | sed -E "s/^ *[A-Z0-9_]+: *//; s/^''$//")"
            case "$key" in
              [A-Z]*)
                if [ -n "$val" ]; then ok "$key"; else warn "$key blank"; fi ;;
            esac ;;
        esac
      done < "$DSH_HOME_DIR/.credentials.yaml"
    fi

    printf '\n%sprofile%s\n' "$C_BOLD" "$C_RESET"
    if [ -f "$PROFILE_DIR/cordis.patch.yml" ]; then
      ROWS="$(grep -c 'name: ' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null || echo 0)"
      ok "cordis.patch.yml ($ROWS rows)"
      grep -oE 'serverName: [a-z_]+' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null \
        | sed 's/serverName: /  mcp: /' || true
    else
      bad "cordis.patch.yml missing"
    fi
    MISSING_PLUGINS=0
    for f in compaction-llm-retry.mjs web-search-ddg.mjs llm-turn-fallback.mjs qwen-coder.mjs command-clear.mjs; do
      [ -f "$PROFILE_DIR/$f" ] || { bad "$f missing"; MISSING_PLUGINS=1; }
    done
    [ "$MISSING_PLUGINS" = 0 ] && ok "5 local plugins present"
    if [ -d "$PROFILE_DIR/node_modules" ]; then ok "plugin bundles installed"; else warn "bundles not installed — run: dsh plugin --profile web install"; fi

    printf '\n%spreset%s\n' "$C_BOLD" "$C_RESET"
    PRESET_FILE="$DSH_HOME_DIR/.agent-presets/opus-qwen/agent.cordis.yml"
    if [ -f "$PRESET_FILE" ]; then
      # The preset names its two local plugins by absolute path, so the check that
      # matters is whether those paths point at THIS machine's profile directory.
      if grep -q "$PROFILE_DIR/" "$PRESET_FILE" 2>/dev/null; then
        ok "opus-qwen preset"
      else
        bad "preset points at another machine — run: dsh-setup reconfigure"
      fi
    else
      bad "opus-qwen preset missing"
    fi

    printf '\n%smodel picker%s\n' "$C_BOLD" "$C_RESET"
    SEL="$(npm root -g 2>/dev/null)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js"
    if [ -f "$SEL" ]; then
      N="$(grep -c 'local patch' "$SEL" 2>/dev/null || echo 0)"
      case "$N" in
        2) ok "search + collapsible groups" ;;
        0) warn "unpatched — run: dsh-setup repatch" ;;
        *) warn "$N/2 patches present — run: dsh-setup repatch" ;;
      esac
    else
      warn "model-selection bundle not found"
    fi

    printf '\n%sqwen%s\n' "$C_BOLD" "$C_RESET"
    if [ -d /Applications/Qwen.app ] || [ -d "$HOME/Applications/Qwen.app" ]; then
      ok "desktop app installed"
    else
      warn "desktop app missing — run: dsh-setup qwen"
    fi
    if curl -fsS --max-time 3 http://127.0.0.1:3083/health >/dev/null 2>&1; then
      ok "bridge healthy on :3083"
    else
      warn "bridge down — run: dsh-setup bridge start"
    fi
    if curl -fsS --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
      ok "app exposing CDP on :9222"
    else
      warn "no CDP on :9222 — the bridge relaunches the app on the next request"
    fi
    ;;

  update)
    command -v git >/dev/null 2>&1 || { bad "git required"; exit 1; }
    if [ -d "$HERE/.git" ]; then
      (cd "$HERE" && git pull --ff-only) && ok "payload updated"
    else
      warn "payload at $HERE is not a git clone; re-run install.sh from the repo"
      exit 1
    fi
    exec bash "$HERE/install.sh" --replace-config --skip-qwen "$@"
    ;;

  ''|-h|--help|help) usage ;;
  *) printf '%sunknown command: %s%s\n\n' "$C_RED" "$CMD" "$C_RESET"; usage; exit 2 ;;
esac
