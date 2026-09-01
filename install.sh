#!/usr/bin/env bash
# DeepSeek Harness — one-click install of Ayush's full setup (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/ayushsuletiya/dsh-installer/main/install.sh | bash
#
# or, from a clone:
#
#   ./install.sh [--secrets ~/dsh-secrets.env] [--dry-run] [--skip-qwen]
#
# What it does, in order. Every step is safe to re-run:
#   1. node (>= 22) via nvm when the machine has none, then pnpm
#   2. @deepseek-ai/dsh pinned to a known-good version, installed globally
#   3. credentials collected from --secrets / the environment / an existing ~/.dsh/.env
#   4. ~/.dsh: settings.yaml (11 providers), .credentials.yaml, .env
#   5. the `web` profile: 10 plugin bundles, 5 local plugins, the MCP rows
#   6. the `opus-qwen` agent preset (Opus thinks, Qwen writes the code)
#   7. the model-picker patches (search + collapsible provider groups)
#   8. the Qwen desktop app + its CDP bridge + a LaunchAgent to keep it alive
#   9. verification: dsh boots, the composed profile parses, the bridge answers
#
# Secrets are never baked in. Provide them with --secrets (see secrets.example.env);
# anything missing is left blank and every route that needs it is skipped, so the
# install still completes and can be topped up later with:  dsh-setup reconfigure
#
# Written for bash 3.2, which is what macOS still ships.
set -eu

# ── constants ───────────────────────────────────────────────────────────────

DSH_PKG_VERSION="${DSH_PKG_VERSION:-0.1.1-rc.2}"
NODE_MAJOR_MIN=22
NODE_INSTALL_VERSION="${NODE_INSTALL_VERSION:-24}"
NODE_WAS_INSTALLED=0
NVM_LOG="${TMPDIR:-/tmp}/dsh-nvm-install.log"
PATH_WAS_CHANGED=0
NVM_VERSION="v0.40.1"
REPO_URL="${DSH_INSTALLER_REPO:-https://github.com/ayushsuletiya/dsh-installer.git}"
REPO_BRANCH="${DSH_INSTALLER_BRANCH:-main}"
# Endpoints come from the secrets file, not from this repo — see ENDPOINT_KEYS.
META_ADS_BRIDGE_URL="${META_ADS_BRIDGE_URL:-}"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/web"
PRESET_DIR="$DSH_HOME_DIR/.agent-presets/opus-qwen"
INSTALLER_HOME="$DSH_HOME_DIR/installer"
BRIDGE_DIR="${QWEN_BRIDGE_DIR:-$HOME/qwen-bridge}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

SECRETS_FILE=""
DRY_RUN=0
SKIP_QWEN=0
SKIP_PATCH=0
SKIP_PROFILE_INSTALL=0
REPLACE_CONFIG=0
KEEP_CONFIG=0
ALLOW_DOWNGRADE=0

# ── output (bash 3.2 has no safe empty-array expansion, so: counters + text) ─

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

STEP_NO=0
WARN_COUNT=0
WARN_TEXT=""
MISSING_TEXT=""
MISSING_COUNT=0
FAILED=0

step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%d/10] %s%s\n' "$C_BOLD$C_BLUE" "$STEP_NO" "$*" "$C_RESET"; }
info() { printf '      %s\n' "$*"; }
ok()   { printf '      %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() {
  printf '      %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"
  WARN_COUNT=$((WARN_COUNT + 1))
  WARN_TEXT="$WARN_TEXT  • $*
"
}
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '      %s$ %s%s\n' "$C_DIM" "$*" "$C_RESET"; else "$@"; fi; }

# ── args ────────────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --secrets) SECRETS_FILE="${2:?--secrets needs a path}"; shift 2 ;;
    --secrets=*) SECRETS_FILE="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-qwen) SKIP_QWEN=1; shift ;;
    --skip-patch) SKIP_PATCH=1; shift ;;
    --skip-profile-install) SKIP_PROFILE_INSTALL=1; shift ;;
    --replace-config) REPLACE_CONFIG=1; shift ;;
    --keep-config) KEEP_CONFIG=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --dsh-version) DSH_PKG_VERSION="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# ── 0. locate the payload (clone ourselves when piped from curl) ─────────────

SCRIPT_SELF="${BASH_SOURCE[0]:-}"
SRC_DIR=""
if [ -n "$SCRIPT_SELF" ] && [ -f "$SCRIPT_SELF" ]; then
  SRC_DIR="$(cd "$(dirname "$SCRIPT_SELF")" && pwd)"
fi
if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR/payload" ]; then
  CLONE_DIR="${TMPDIR:-/tmp}/dsh-installer-$STAMP"
  printf '%sfetching installer payload…%s\n' "$C_DIM" "$C_RESET"
  # A factory-fresh Mac has no git: /usr/bin/git is a stub that pops the Xcode
  # Command Line Tools installer and blocks. So prefer the plain tarball, which
  # needs nothing but curl and tar, and only fall back to git.
  TARBALL_URL="$(printf '%s' "$REPO_URL" | sed -E 's#\.git$##')/archive/refs/heads/$REPO_BRANCH.tar.gz"
  mkdir -p "$CLONE_DIR"
  if curl -fsSL --max-time 180 "$TARBALL_URL" 2>/dev/null \
       | tar xz -C "$CLONE_DIR" --strip-components 1 2>/dev/null \
     && [ -d "$CLONE_DIR/payload" ]; then
    SRC_DIR="$CLONE_DIR"
  elif command -v git >/dev/null 2>&1; then
    rm -rf "$CLONE_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CLONE_DIR" >/dev/null 2>&1 \
      || die "could not fetch the payload from $REPO_URL"
    SRC_DIR="$CLONE_DIR"
  else
    die "could not download the payload ($TARBALL_URL) and git is not available"
  fi
fi
[ -d "$SRC_DIR/payload" ] || die "payload/ not found next to install.sh"

printf '%s%sDeepSeek Harness — one-click setup%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET"
printf '%s  payload: %s%s\n' "$C_DIM" "$SRC_DIR" "$C_RESET"
printf '%s  target:  %s%s\n' "$C_DIM" "$DSH_HOME_DIR" "$C_RESET"
if [ "$DRY_RUN" = 1 ]; then
  printf '%s  DRY RUN — nothing will be written%s\n' "$C_YELLOW" "$C_RESET"
fi

# ── existing installation guard ──────────────────────────────────────────────

# This installer WRITES settings.yaml, .credentials.yaml, .env, the web profile's
# package.json and cordis.patch.yml. On a machine that already has a DSH setup that
# means replacing that person's providers, plugin list and MCP rows — so it stops
# and makes the choice explicit instead of silently taking over.
#
# Chat history is never involved: sessions/, storages/ and task-board/ are not
# touched by any step, and every file that IS replaced is copied to
# <name>.bak.<timestamp> first.
EXISTING=""
[ -f "$DSH_HOME_DIR/settings.yaml" ] && EXISTING="$EXISTING  $DSH_HOME_DIR/settings.yaml
"
[ -f "$DSH_HOME_DIR/.credentials.yaml" ] && EXISTING="$EXISTING  $DSH_HOME_DIR/.credentials.yaml
"
[ -f "$PROFILE_DIR/package.json" ] && EXISTING="$EXISTING  $PROFILE_DIR/package.json (your plugin list)
"
[ -f "$PROFILE_DIR/cordis.patch.yml" ] && EXISTING="$EXISTING  $PROFILE_DIR/cordis.patch.yml (your MCP rows)
"

if [ -n "$EXISTING" ] && [ "$KEEP_CONFIG" = 0 ] && [ "$REPLACE_CONFIG" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  printf '\n%sThis machine already has a DeepSeek Harness setup.%s\n\n' "$C_BOLD$C_YELLOW" "$C_RESET"
  printf 'These files would be REPLACED (each one backed up to .bak.%s first):\n' "$STAMP"
  printf '%s' "$EXISTING"
  printf '\nYour chats are safe either way — sessions, workspace index and task board\nare never touched.\n\n'
  printf 'Pick one:\n'
  printf '  %s--replace-config%s   take over this setup (backups are kept)\n' "$C_BOLD" "$C_RESET"
  printf '  %s--keep-config%s      leave every config file alone; install only the runtime,\n' "$C_BOLD" "$C_RESET"
  printf '                     the Qwen bridge, the AgentRouter proxy and the patches\n'
  printf '  %sDSH_HOME=~/.dsh-new%s  install side by side, touching nothing\n\n' "$C_BOLD" "$C_RESET"
  exit 2
fi

# Fail on a missing secrets file NOW, not after node and dsh are already installed.
if [ -n "$SECRETS_FILE" ] && [ ! -f "$SECRETS_FILE" ]; then
  printf '\n%serror:%s secrets file not found: %s\n\n' "$C_RED" "$C_RESET" "$SECRETS_FILE"
  printf 'Copy it from the machine you generated it on, e.g. from the other Mac:\n'
  printf '  %sscp ~/Desktop/dsh-secrets.env %s@%s:~/%s\n\n' "$C_BOLD" "$(id -un)" "$(hostname -s 2>/dev/null || echo this-mac)" "$C_RESET"
  printf 'Or install without it and add the keys later:\n'
  printf '  %s<this same command, minus --secrets>%s\n' "$C_BOLD" "$C_RESET"
  printf '  %sdsh-setup reconfigure --secrets ~/dsh-secrets.env%s\n\n' "$C_BOLD" "$C_RESET"
  exit 2
fi

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=mac ;;
  Linux)  PLATFORM=linux ;;
  *) die "unsupported OS: $OS (Windows uses install.ps1)" ;;
esac

# ── 1. node + pnpm ──────────────────────────────────────────────────────────

step "Node.js and pnpm"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

load_nvm() {
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
}

if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
  ok "node $(node -v) already usable"
else
  load_nvm
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MAJOR_MIN" ]; then
    ok "node $(node -v) via nvm"
  else
    info "installing nvm + node $NODE_INSTALL_VERSION (no sudo, nothing system-wide)"
    if [ "$DRY_RUN" = 0 ]; then
      NVM_LOG="${TMPDIR:-/tmp}/dsh-nvm-install.log"
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash >"$NVM_LOG" 2>&1 \
        || die "nvm install failed — see $NVM_LOG"
      load_nvm
      nvm install "$NODE_INSTALL_VERSION" >>"$NVM_LOG" 2>&1 || die "node install failed — see $NVM_LOG"
      nvm use "$NODE_INSTALL_VERSION" >>"$NVM_LOG" 2>&1 || true
      nvm alias default "$NODE_INSTALL_VERSION" >>"$NVM_LOG" 2>&1 || true
    fi
    if [ "$DRY_RUN" = 1 ]; then
      if command -v node >/dev/null 2>&1; then
        info "would install node $NODE_INSTALL_VERSION (this machine currently has $(node -v))"
      else
        info "would install node $NODE_INSTALL_VERSION"
      fi
    else
      command -v node >/dev/null 2>&1 || die "node still not on PATH — open a new shell and re-run"
      # nvm can silently leave an older default selected, and everything after this
      # point (corepack, pnpm, dsh) then fails in confusing ways. Check, do not hope.
      if [ "$(node_major)" -lt "$NODE_MAJOR_MIN" ]; then
        die "node $(node -v) is still active but $NODE_MAJOR_MIN+ is required — see $NVM_LOG, then run: nvm use $NODE_INSTALL_VERSION"
      fi
      ok "node $(node -v) installed"
      NODE_WAS_INSTALLED=1
    fi
  fi
fi

NODE_BIN="$(command -v node)"

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  info "enabling pnpm via corepack"
  if [ "$DRY_RUN" = 0 ]; then
    corepack enable pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 || true
  fi
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm -v)"
  else
    warn "pnpm unavailable — the plugin-bundle install will be skipped"
    SKIP_PROFILE_INSTALL=1
  fi
fi

# ── 2. dsh itself ───────────────────────────────────────────────────────────

step "DeepSeek Harness $DSH_PKG_VERSION"

CURRENT_DSH=""
if command -v dsh >/dev/null 2>&1; then
  CURRENT_DSH="$(dsh --version 2>/dev/null || true)"
fi
# A pinned version must never quietly DOWNGRADE a working install: someone on a
# newer dsh keeps it, and the model-picker patch simply reports that it has no
# pinned bundle for that version. `--allow-downgrade` forces the pin.
newer_than_pin() {
  [ -z "$1" ] && return 1
  node -e '
    const cmp = (a, b) => {
      const norm = (v) => String(v).replace(/^v/, "").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
      const A = norm(a), B = norm(b);
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const x = A[i], y = B[i];
        if (x === y) continue;
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === typeof y) return x > y ? 1 : -1;
        return typeof x === "number" ? 1 : -1;
      }
      return 0;
    };
    process.exit(cmp(process.argv[1], process.argv[2]) > 0 ? 0 : 1);
  ' "$1" "$2" 2>/dev/null
}

if [ "$CURRENT_DSH" = "$DSH_PKG_VERSION" ]; then
  ok "dsh $DSH_PKG_VERSION already installed"
elif [ -n "$CURRENT_DSH" ] && [ "$ALLOW_DOWNGRADE" = 0 ] && newer_than_pin "$CURRENT_DSH" "$DSH_PKG_VERSION"; then
  warn "keeping your newer dsh $CURRENT_DSH (this installer pins $DSH_PKG_VERSION; use --allow-downgrade to force it)"
else
  if [ -n "$CURRENT_DSH" ]; then
    info "replacing dsh $CURRENT_DSH with the pinned $DSH_PKG_VERSION"
  else
    info "npm install -g @deepseek-ai/dsh@$DSH_PKG_VERSION"
  fi
  run npm install -g "@deepseek-ai/dsh@$DSH_PKG_VERSION" >/dev/null 2>&1 \
    || die "could not install @deepseek-ai/dsh@$DSH_PKG_VERSION"
  ok "dsh $(dsh --version 2>/dev/null || echo installed)"
fi

NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
export NPM_GLOBAL_ROOT

# ── 3. credentials ──────────────────────────────────────────────────────────

step "Credentials"

# Every value is optional. What goes dark without each one:
#   TABITOKEN_API_KEY         the default Claude Opus route (agent-default-model)
#   OMNIROUTER_API_KEY        Antigravity, Qwen-via-OmniRoute, the free OmniRoute pools
#   OPENROUTER_API_KEY        OpenRouter direct
#   NVIDIA_NIM_API_KEY        NVIDIA NIM + the vision toolkit's image engine
#   AGENTROUTER_API_KEY       AgentRouter — API-based, no local dependency
#   GEMINI_API_KEY            Google Gemini direct
#   ZAI_API_KEY               Z.ai / GLM
#   QWEN_BRIDGE_KEY           any non-empty string: the local bridge ignores it, but
#                             pi-ai refuses a provider carrying no credential at all
#   META_ADS_BRIDGE_TOKEN     the three Meta Ads MCP rows
#   HOSTINGER_API_TOKEN       Hostinger mailbox-provisioning MCP
#   HOSTINGER_MAIL_API_TOKEN  Hostinger message-level MCP
SECRET_KEYS="TABITOKEN_API_KEY OMNIROUTER_API_KEY OPENROUTER_API_KEY NVIDIA_NIM_API_KEY \
AGENTROUTER_API_KEY GEMINI_API_KEY ZAI_API_KEY QWEN_BRIDGE_KEY AGY_BRIDGE_KEY \
META_ADS_BRIDGE_TOKEN HOSTINGER_API_TOKEN HOSTINGER_MAIL_API_TOKEN"
CRED_KEYS="TABITOKEN_API_KEY OMNIROUTER_API_KEY OPENROUTER_API_KEY NVIDIA_NIM_API_KEY \
AGENTROUTER_API_KEY GEMINI_API_KEY ZAI_API_KEY QWEN_BRIDGE_KEY AGY_BRIDGE_KEY"
ENV_KEYS="META_ADS_BRIDGE_TOKEN HOSTINGER_API_TOKEN HOSTINGER_MAIL_API_TOKEN"
# Endpoints, not credentials: the addresses of your own gateways. They live in the
# same file so one file carries a machine, and they are deliberately absent from
# this repo so it can be public. A blank endpoint drops the routes that need it.
#   TABITOKEN_BASE_URL   the Claude Opus gateway (drops the tabitoken provider)
#   OMNIROUTE_BASE_URL   your OmniRoute /v1 (drops antigravity, qwen-omni, the
#                        free pools and the Codex OAuth route)
#   QWEN_OMNI_NODE_ID    OmniRoute's provider-node id that fronts the Qwen web
#                        session; the model ids are "<node-id>/<model>"
#   META_ADS_BRIDGE_URL  the Meta Ads MCP bridge origin (drops its three rows)
ENDPOINT_KEYS="TABITOKEN_BASE_URL OMNIROUTE_BASE_URL QWEN_OMNI_NODE_ID META_ADS_BRIDGE_URL"

# Read KEY=VALUE lines only; comments, blanks and unknown keys are ignored, and a
# value is taken verbatim so a base64 token with '=' in it survives.
read_secret_file() {
  _file="$1"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in ''|'#'*) continue ;; esac
    case "$_line" in *=*) ;; *) continue ;; esac
    _key="${_line%%=*}"
    _val="${_line#*=}"
    _key="$(printf '%s' "$_key" | tr -d '[:space:]')"
    [ -z "$_key" ] && continue
    eval "SECRET_$_key=\$_val"
  done < "$_file"
}

for k in $SECRET_KEYS $ENDPOINT_KEYS; do eval "SECRET_$k=\"\""; done

if [ -f "$DSH_HOME_DIR/.env" ]; then
  read_secret_file "$DSH_HOME_DIR/.env"
  ok "carried existing values from ~/.dsh/.env"
fi
if [ -n "$SECRETS_FILE" ]; then
  [ -f "$SECRETS_FILE" ] || die "secrets file not found: $SECRETS_FILE"
  read_secret_file "$SECRETS_FILE"
  ok "loaded $SECRETS_FILE"
fi
# The environment beats both, so CI can pass secrets with no file on disk.
for k in $SECRET_KEYS $ENDPOINT_KEYS; do
  eval "_env=\${$k:-}"
  if [ -n "$_env" ]; then eval "SECRET_$k=\$_env"; fi
done

# The bridge credential is a placeholder by design.
eval "_qk=\${SECRET_QWEN_BRIDGE_KEY:-}"
if [ -z "$_qk" ]; then SECRET_QWEN_BRIDGE_KEY="local-bridge-no-key-needed"; fi

HAVE_COUNT=0
TOTAL_COUNT=0
for k in $SECRET_KEYS; do
  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  eval "_v=\${SECRET_$k:-}"
  if [ -n "$_v" ]; then
    HAVE_COUNT=$((HAVE_COUNT + 1))
  else
    MISSING_COUNT=$((MISSING_COUNT + 1))
    MISSING_TEXT="$MISSING_TEXT  $k
"
  fi
done
info "$HAVE_COUNT of $TOTAL_COUNT credentials present"
if [ "$MISSING_COUNT" -gt 0 ]; then
  info "blank for now (add later with: dsh-setup reconfigure --secrets <file>)"
fi

# ── 4. ~/.dsh: settings, credentials, env ───────────────────────────────────

step "Host configuration"

backup() {
  if [ -f "$1" ] && [ "$DRY_RUN" = 0 ]; then
    cp "$1" "$1.bak.$STAMP"
    info "backed up $(basename "$1")"
  fi
  return 0
}

run mkdir -p "$DSH_HOME_DIR/logs" "$PRESET_DIR" "$INSTALLER_HOME"

if [ "$KEEP_CONFIG" = 1 ]; then
  info "--keep-config: settings.yaml, .credentials.yaml and .env left untouched"
else

backup "$DSH_HOME_DIR/settings.yaml"
# settings.yaml is rendered, not copied: the gateway addresses live in the secrets
# file, and a provider whose endpoint is blank is dropped rather than left pointing
# at nothing.
eval "DSHX_TABITOKEN_BASE_URL=\${SECRET_TABITOKEN_BASE_URL:-}"; export DSHX_TABITOKEN_BASE_URL
eval "DSHX_OMNIROUTE_BASE_URL=\${SECRET_OMNIROUTE_BASE_URL:-}"; export DSHX_OMNIROUTE_BASE_URL
eval "DSHX_QWEN_OMNI_NODE_ID=\${SECRET_QWEN_OMNI_NODE_ID:-}"; export DSHX_QWEN_OMNI_NODE_ID
if [ "$DRY_RUN" = 0 ]; then
  node "$SRC_DIR/tools/render.mjs" \
    "$SRC_DIR/payload/settings.template.yaml" \
    "$DSH_HOME_DIR/settings.yaml" >/dev/null || die "rendering settings.yaml failed"
fi
run chmod 600 "$DSH_HOME_DIR/settings.yaml"
if [ "$DRY_RUN" = 0 ]; then
  PROVIDER_COUNT="$(grep -cE '^    [a-z0-9-]+:$' "$DSH_HOME_DIR/settings.yaml" 2>/dev/null || echo '?')"
else
  PROVIDER_COUNT="?"
fi
ok "settings.yaml — $PROVIDER_COUNT providers, dark theme, opus-qwen as the session default"

if [ "$DRY_RUN" = 0 ]; then
  backup "$DSH_HOME_DIR/.credentials.yaml"
  {
    echo "version: 1"
    echo "refs:"
    for k in $CRED_KEYS; do
      eval "_v=\${SECRET_$k:-}"
      if [ -n "$_v" ]; then printf '  %s: %s\n' "$k" "$_v"; else printf "  %s: ''\n" "$k"; fi
    done
  } > "$DSH_HOME_DIR/.credentials.yaml"
  chmod 600 "$DSH_HOME_DIR/.credentials.yaml"
fi
ok ".credentials.yaml (0600)"

if [ "$DRY_RUN" = 0 ]; then
  backup "$DSH_HOME_DIR/.env"
  {
    echo "# Loaded by dsh at boot. Gitignored secrets live here."
    echo "# Refresh with: dsh-setup reconfigure --secrets <file>"
    for k in $ENV_KEYS; do
      eval "_v=\${SECRET_$k:-}"
      if [ -n "$_v" ]; then printf '%s=%s\n' "$k" "$_v"; fi
    done
  } > "$DSH_HOME_DIR/.env"
  chmod 600 "$DSH_HOME_DIR/.env"
fi
ok ".env (0600)"

fi  # KEEP_CONFIG

# ── 5. web profile ──────────────────────────────────────────────────────────

step "Web profile: bundles, local plugins, MCP rows"

if [ "$KEEP_CONFIG" = 1 ]; then
  info "--keep-config: your profile, plugin list and MCP rows left untouched"
else

# Let dsh scaffold the profile skeleton first, so cordis.yml / pnpm-workspace.yaml
# always match the installed dsh version instead of a copy that can drift.
if [ ! -f "$PROFILE_DIR/cordis.yml" ] && [ "$DRY_RUN" = 0 ]; then
  info "scaffolding the profile with dsh itself"
  DSH_HOME="$DSH_HOME_DIR" dsh --profile web --dump-default-config >/dev/null 2>&1 || true
fi
run mkdir -p "$PROFILE_DIR"

run cp "$SRC_DIR/payload/profile-web/package.json" "$PROFILE_DIR/package.json"
for f in compaction-llm-retry.mjs web-search-ddg.mjs llm-turn-fallback.mjs qwen-coder.mjs command-clear.mjs; do
  run cp "$SRC_DIR/payload/profile-web/$f" "$PROFILE_DIR/$f"
done
ok "5 local plugins + 10 bundle declarations"

# Render the patch layer with this machine's real paths. The *_JSON variables are
# JSON-quoted because they are interpolated into `!!js` expressions, where they
# must be valid JS string literals.
json_str() { node -p 'JSON.stringify(process.argv[1])' "$1"; }

DSHX_PROFILE_WEB="$PROFILE_DIR"; export DSHX_PROFILE_WEB
DSHX_DSH_HOME="$DSH_HOME_DIR"; export DSHX_DSH_HOME
DSHX_HOME="$HOME"; export DSHX_HOME
DSHX_NODE="$NODE_BIN"; export DSHX_NODE
eval "DSHX_META_ADS_BRIDGE_TOKEN=\${SECRET_META_ADS_BRIDGE_TOKEN:-}"; export DSHX_META_ADS_BRIDGE_TOKEN
eval "DSHX_META_ADS_BRIDGE_URL=\${SECRET_META_ADS_BRIDGE_URL:-}"
if [ -z "$DSHX_META_ADS_BRIDGE_URL" ]; then DSHX_META_ADS_BRIDGE_URL="$META_ADS_BRIDGE_URL"; fi
export DSHX_META_ADS_BRIDGE_URL
DSHX_META_ADS_ENABLED=""
if [ -n "$DSHX_META_ADS_BRIDGE_TOKEN" ] && [ -n "$DSHX_META_ADS_BRIDGE_URL" ]; then
  DSHX_META_ADS_ENABLED=1
fi
export DSHX_META_ADS_ENABLED
eval "DSHX_HOSTINGER_API_TOKEN=\${SECRET_HOSTINGER_API_TOKEN:-}"; export DSHX_HOSTINGER_API_TOKEN
eval "DSHX_HOSTINGER_MAIL_API_TOKEN=\${SECRET_HOSTINGER_MAIL_API_TOKEN:-}"; export DSHX_HOSTINGER_MAIL_API_TOKEN
DSHX_HOSTINGER_DIR="$HOME/.hostinger-mcp"; export DSHX_HOSTINGER_DIR
DSHX_HOSTINGER_ENV_JSON="$(json_str "$HOME/.hostinger-mcp/.env")"; export DSHX_HOSTINGER_ENV_JSON
if command -v hostinger-mail-mcp >/dev/null 2>&1; then
  DSHX_HOSTINGER_MCP_BIN="$(command -v hostinger-mail-mcp)"
else
  DSHX_HOSTINGER_MCP_BIN="$(dirname "$NODE_BIN")/hostinger-mail-mcp"
fi
export DSHX_HOSTINGER_MCP_BIN
if [ -f "$HOME/multilogin-mcp/server.mjs" ]; then
  DSHX_MULTILOGIN_DIR="$HOME/multilogin-mcp"
  DSHX_MULTILOGIN_SERVER_JSON="$(json_str "$HOME/multilogin-mcp/server.mjs")"
else
  DSHX_MULTILOGIN_DIR=""
  DSHX_MULTILOGIN_SERVER_JSON='""'
fi
export DSHX_MULTILOGIN_DIR DSHX_MULTILOGIN_SERVER_JSON

if [ "$DRY_RUN" = 0 ]; then
  backup "$PROFILE_DIR/cordis.patch.yml"
  node "$SRC_DIR/tools/render.mjs" \
    "$SRC_DIR/payload/profile-web/cordis.patch.template.yml" \
    "$PROFILE_DIR/cordis.patch.yml" >/dev/null || die "rendering cordis.patch.yml failed"
fi
ok "cordis.patch.yml rendered for this machine"

if [ -n "$DSHX_META_ADS_ENABLED" ]; then ok "Meta Ads MCP: 3 rows enabled"; else info "Meta Ads MCP: skipped (needs both META_ADS_BRIDGE_TOKEN and META_ADS_BRIDGE_URL)"; fi
if [ -n "$DSHX_HOSTINGER_API_TOKEN" ]; then ok "Hostinger mail MCP: enabled"; else info "Hostinger mail MCP: skipped (no token)"; fi
if [ -n "$DSHX_MULTILOGIN_DIR" ]; then ok "Multilogin MCP: enabled"; else info "Multilogin MCP: skipped (~/multilogin-mcp absent)"; fi
info "UI Skills MCP: always on (keyless)"

if [ "$SKIP_PROFILE_INSTALL" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  info "installing the plugin bundles — the slow step, a few minutes on first run"
  if (cd "$PROFILE_DIR" && DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile web install >/tmp/dsh-plugin-install.log 2>&1); then
    ok "plugin bundles installed"
  else
    warn "plugin install reported errors — see /tmp/dsh-plugin-install.log"
  fi
else
  info "plugin install skipped"
fi

fi  # KEEP_CONFIG

# ── 6. agent preset ─────────────────────────────────────────────────────────

step "Agent preset: opus-qwen"

if [ "$KEEP_CONFIG" = 1 ]; then
  info "--keep-config: agent presets left untouched"
else
  run cp "$SRC_DIR/payload/agent-presets/opus-qwen/preset.yml" "$PRESET_DIR/preset.yml"
  if [ "$DRY_RUN" = 0 ]; then
    node "$SRC_DIR/tools/render.mjs" \
      "$SRC_DIR/payload/agent-presets/opus-qwen/agent.cordis.template.yml" \
      "$PRESET_DIR/agent.cordis.yml" >/dev/null || die "rendering the agent preset failed"
  fi
  ok "Opus thinks · qwen_code writes · subagent_qwen drives the files"
fi

# ── 7. model picker patches ─────────────────────────────────────────────────

step "Model picker: search + collapsible groups"

if [ "$SKIP_PATCH" = 1 ]; then
  info "skipped (--skip-patch)"
elif [ "$DRY_RUN" = 1 ]; then
  info "would patch @deepseek-ai/dsh-client-ui-model-selection"
else
  set +e
  node "$SRC_DIR/tools/patch-model-selector.mjs"
  PATCH_RC=$?
  set -e
  if [ "$PATCH_RC" = 4 ]; then
    warn "model-picker patch skipped (the picker still works, without folding)"
  fi
fi

# ── 7b. AgentRouter loopback proxy ──────────────────────────────────────────

# AgentRouter is a plain HTTPS API, but it 401s unless the request carries a
# Claude-CLI User-Agent, and pi-ai overwrites a provider `headers:` User-Agent with
# its own. So the route needs one 60-line loopback hop that rewrites that header.
# It costs nothing when the key is absent — the provider is simply unusable until
# a key is added, and the proxy sits idle.
step "AgentRouter loopback proxy"

AR_DIR="$DSH_HOME_DIR/agentrouter-proxy"
run mkdir -p "$AR_DIR"
run cp "$SRC_DIR/payload/agentrouter-proxy/agentrouter-proxy.mjs" "$AR_DIR/agentrouter-proxy.mjs"

if [ "$DRY_RUN" = 0 ]; then
  if curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3081/ 2>/dev/null; then
    ok "AgentRouter proxy already running on 127.0.0.1:3081"
  else
    if [ "$PLATFORM" = mac ]; then
      AR_PLIST="$HOME/Library/LaunchAgents/com.dsh.agentrouter-proxy.plist"
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$AR_PLIST" <<ARPLI
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.agentrouter-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$AR_DIR/agentrouter-proxy.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DSH_HOME_DIR/logs/agentrouter-proxy.log</string>
  <key>StandardErrorPath</key><string>$DSH_HOME_DIR/logs/agentrouter-proxy.log</string>
</dict>
</plist>
ARPLI
      if launchctl load -w "$AR_PLIST" >/dev/null 2>&1; then
        ok "AgentRouter proxy LaunchAgent loaded"
      else
        nohup "$NODE_BIN" "$AR_DIR/agentrouter-proxy.mjs" \
          >>"$DSH_HOME_DIR/logs/agentrouter-proxy.log" 2>&1 &
        warn "launchctl refused the AgentRouter proxy; started detached (load $AR_PLIST from Terminal to persist)"
      fi
    else
      nohup "$NODE_BIN" "$AR_DIR/agentrouter-proxy.mjs" \
        >>"$DSH_HOME_DIR/logs/agentrouter-proxy.log" 2>&1 &
      ok "AgentRouter proxy started (add it to your session autostart to persist)"
    fi
  fi
fi

# ── 8. Qwen desktop app + bridge ────────────────────────────────────────────

step "Qwen desktop bridge"

if [ "$SKIP_QWEN" = 1 ]; then
  info "skipped (--skip-qwen)"
else
  run mkdir -p "$BRIDGE_DIR"
  for f in server-app.mjs qwen-app-client.mjs qwen-auth.mjs qwen-login.mjs \
           server-oauth.mjs tool-formatter.mjs push-creds.mjs README.md run.sh run.ps1; do
    if [ -f "$SRC_DIR/payload/qwen-bridge/$f" ]; then
      run cp "$SRC_DIR/payload/qwen-bridge/$f" "$BRIDGE_DIR/$f"
    fi
  done
  run chmod +x "$BRIDGE_DIR/run.sh"
  ok "bridge installed at $BRIDGE_DIR"

  if [ "$PLATFORM" = mac ]; then
    if [ "$DRY_RUN" = 0 ]; then
      set +e
      node "$SRC_DIR/tools/install-qwen-app.mjs"
      QWEN_RC=$?
      set -e
      if [ "$QWEN_RC" != 0 ]; then
        warn "Qwen app not installed automatically — get it from https://qwen.ai/download"
      else
        ok "Qwen desktop app installed and launched with the debugging port"
      fi
    else
      info "would download + install the Qwen desktop app"
    fi

    PLIST="$HOME/Library/LaunchAgents/com.dsh.qwen-bridge.plist"
    # Someone who already runs a bridge (their own LaunchAgent, a nohup'd run.sh)
    # must not end up with two supervisors fighting over port 3083 — the loser
    # EADDRINUSE-loops forever. If the port already answers, leave it alone.
    BRIDGE_ALREADY=0
    if [ "$DRY_RUN" = 0 ] && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3083/health 2>/dev/null; then
      BRIDGE_ALREADY=1
      OTHER_AGENTS="$(ls "$HOME/Library/LaunchAgents" 2>/dev/null \
        | grep -iE 'qwen' | grep -v '^com\.dsh\.qwen-bridge\.plist$' | tr '\n' ' ')"
      if [ -n "$OTHER_AGENTS" ]; then
        warn "a Qwen bridge is already serving :3083 (LaunchAgent: $OTHER_AGENTS) — not registering a second one"
      else
        warn "something already serves :3083 — not registering a second bridge"
      fi
    fi
    if [ "$DRY_RUN" = 0 ] && [ "$BRIDGE_ALREADY" = 0 ]; then
      mkdir -p "$HOME/Library/LaunchAgents"
      cat > "$PLIST" <<PLI
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.qwen-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$BRIDGE_DIR/run.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE</key><string>$NODE_BIN</string>
    <key>QWEN_BRIDGE_PORT</key><string>3083</string>
    <key>QWEN_CDP_PORT</key><string>9222</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BRIDGE_DIR/bridge.log</string>
  <key>StandardErrorPath</key><string>$BRIDGE_DIR/bridge.log</string>
  <key>WorkingDirectory</key><string>$BRIDGE_DIR</string>
</dict>
</plist>
PLI
      # launchctl refuses to load a LaunchAgent from inside a sandboxed parent, so
      # fall back to a detached supervisor: the bridge comes up either way.
      if launchctl load -w "$PLIST" >/dev/null 2>&1; then
        ok "LaunchAgent loaded — starts at every login"
      else
        warn "launchctl refused; started detached instead. Run 'launchctl load -w $PLIST' from Terminal to make it permanent"
        nohup "$BRIDGE_DIR/run.sh" >/dev/null 2>&1 &
      fi
    fi
  else
    info "Linux: no desktop Qwen build — start the bridge yourself with $BRIDGE_DIR/run.sh"
  fi
fi

# ── 9. dsh-setup helper + verification ──────────────────────────────────────

step "Verify"

# Keep a copy of the payload inside DSH_HOME so `dsh-setup` still works after the
# temp clone is gone.
if [ "$DRY_RUN" = 0 ] && [ "$SRC_DIR" != "$INSTALLER_HOME" ]; then
  rm -rf "$INSTALLER_HOME.new"
  mkdir -p "$INSTALLER_HOME.new"
  cp -R "$SRC_DIR/payload" "$SRC_DIR/tools" "$INSTALLER_HOME.new/" 2>/dev/null || true
  for f in install.sh install.ps1 dsh-setup.sh README.md secrets.example.env VERSION; do
    [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$INSTALLER_HOME.new/$f"
  done
  rm -rf "$INSTALLER_HOME"
  mv "$INSTALLER_HOME.new" "$INSTALLER_HOME"
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/dsh-setup" <<SETUP
#!/bin/sh
# Re-run parts of the DSH one-click setup (payload kept in $INSTALLER_HOME).
exec "$INSTALLER_HOME/dsh-setup.sh" "\$@"
SETUP
  chmod +x "$HOME/.local/bin/dsh-setup"
  ok "dsh-setup installed (reconfigure / repatch / qwen / doctor)"

  # A fresh macOS does not have ~/.local/bin on PATH, so the shim above would be
  # invisible ("zsh: command not found: dsh-setup"). Add it to whichever profile
  # this login shell actually reads.
  case "${SHELL:-}" in
    */zsh) SHELL_PROFILE="$HOME/.zshrc" ;;
    */bash) SHELL_PROFILE="$HOME/.bash_profile" ;;
    *) SHELL_PROFILE="$HOME/.profile" ;;
  esac
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ok "~/.local/bin already on PATH" ;;
    *)
      if [ -f "$SHELL_PROFILE" ] && grep -q 'HOME/.local/bin' "$SHELL_PROFILE" 2>/dev/null; then
        info "~/.local/bin is in $(basename "$SHELL_PROFILE") — open a new terminal to pick it up"
        PATH_WAS_CHANGED=1
      else
        {
          echo ""
          echo "# added by the dsh installer"
          echo 'export PATH="$HOME/.local/bin:$PATH"'
        } >> "$SHELL_PROFILE"
        ok "added ~/.local/bin to $(basename "$SHELL_PROFILE")"
        PATH_WAS_CHANGED=1
      fi
      ;;
  esac
fi

if [ "$DRY_RUN" = 0 ]; then
  if V="$(dsh --version 2>/dev/null)"; then
    ok "dsh $V responds"
  else
    warn "dsh --version failed"; FAILED=1
  fi

  if node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    if (!/llm-pi-ai:/.test(text)) { console.error("no llm-pi-ai section"); process.exit(1); }
    if (/opencode/.test(text)) { console.error("opencode leaked into settings"); process.exit(1); }
    if (/3082/.test(text)) { console.error("a dead local bridge port is still referenced"); process.exit(1); }
  ' "$DSH_HOME_DIR/settings.yaml" 2>/dev/null; then
    ok "settings.yaml sane — opencode fully removed"
  else
    warn "settings.yaml failed its sanity check"; FAILED=1
  fi

  # Composition needs the bundles on disk, so a deliberately skipped install is
  # reported as skipped rather than as a failure.
  if [ ! -d "$PROFILE_DIR/node_modules" ]; then
    info "composition check skipped — bundles not installed yet"
    info "run: dsh plugin --profile web install"
  elif DSH_HOME="$DSH_HOME_DIR" dsh --profile web --dump-config >/tmp/dsh-dump-config.log 2>&1; then
    ROWS="$(grep -c '^- id:' /tmp/dsh-dump-config.log 2>/dev/null || echo '?')"
    ok "composed web profile parses ($ROWS top-level rows)"
  else
    warn "profile composition failed — see /tmp/dsh-dump-config.log"; FAILED=1
  fi

  if [ "$SKIP_QWEN" = 0 ] && [ "$PLATFORM" = mac ]; then
    BRIDGE_UP=0
    for _try in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS --max-time 3 http://127.0.0.1:3083/health >/dev/null 2>&1; then BRIDGE_UP=1; break; fi
      sleep 2
    done
    if [ "$BRIDGE_UP" = 1 ]; then
      ok "Qwen bridge answering on 127.0.0.1:3083"
    else
      warn "Qwen bridge not answering yet — sign into the Qwen app, then: tail -f $BRIDGE_DIR/bridge.log"
    fi
  fi
fi

# ── report ──────────────────────────────────────────────────────────────────

printf '\n%s%s────────────────────────────────────────%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
if [ "$DRY_RUN" = 1 ]; then
  printf '%sDry run complete — nothing was written.%s\n' "$C_BOLD" "$C_RESET"
else
  printf '%sDone.%s  Start it with:  %sdsh web%s\n' "$C_BOLD$C_GREEN" "$C_RESET" "$C_BOLD" "$C_RESET"
fi

if [ "$WARN_COUNT" -gt 0 ]; then
  printf '\n%s%d thing(s) need your attention:%s\n' "$C_YELLOW" "$WARN_COUNT" "$C_RESET"
  printf '%s' "$WARN_TEXT"
fi

if [ "$MISSING_COUNT" -gt 0 ]; then
  printf '\n%sBlank credentials%s — put them in a file and run: dsh-setup reconfigure --secrets <file>\n' "$C_DIM" "$C_RESET"
  printf '%s' "$MISSING_TEXT"
fi

if [ "$NODE_WAS_INSTALLED" = 1 ] || [ "$PATH_WAS_CHANGED" = 1 ]; then
  printf '\n%sOpen a new terminal before anything else.%s\n' "$C_BOLD$C_YELLOW" "$C_RESET"
  [ "$NODE_WAS_INSTALLED" = 1 ] && printf '  node was just installed by nvm, which only affects new shells\n'
  [ "$PATH_WAS_CHANGED" = 1 ] && printf '  ~/.local/bin was added to your PATH (that is where dsh-setup lives)\n'
  printf '  In THIS shell you can instead run:\n'
  printf '    %sexport PATH="$HOME/.local/bin:$PATH"; . "$HOME/.nvm/nvm.sh"%s\n' "$C_BOLD" "$C_RESET"
fi

printf '\n%sNext:%s sign into the Qwen desktop app once — the bridge borrows that session —\n' "$C_BOLD" "$C_RESET"
printf '      then run %sdsh web%s and pick a model.\n' "$C_BOLD" "$C_RESET"
exit "$FAILED"
