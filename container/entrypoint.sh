#!/usr/bin/env bash
# Container entrypoint: turn a generic image into THIS machine's harness.
#
# The split that makes updates safe:
#   image owns  /data/.dsh/profiles and /data/.dsh/.agent-presets   (replaced on update)
#   user owns   /data/.dsh/{sessions,storages,task-board,logs}      (never touched)
#
# Configuration is fetched by enrollment token every start, so rotating a key or
# adding a provider needs no reinstall — restart is enough.
set -euo pipefail

DSH_HOME="${DSH_HOME:-/data/.dsh}"
BAKED_HOME="${BAKED_HOME:-/opt/dsh-home}"
INSTALLER="/opt/dsh"
PORT="${DSH_WEB_PORT:-3080}"
IMAGE_VERSION="${DSH_IMAGE_VERSION:-dev}"

bold=''; dim=''; reset=''
if [ -t 1 ]; then bold=$'\033[1m'; dim=$'\033[2m'; reset=$'\033[0m'; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m+\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

say "${bold}DeepSeek Harness${reset} ${dim}image ${IMAGE_VERSION} · dsh ${DSH_PINNED_VERSION:-?}${reset}"

mkdir -p "$DSH_HOME"/{logs,sessions,storages,task-board}

# ── the image's half of the home ─────────────────────────────────────────────
# Refresh whenever the image version differs from what the volume was last
# populated with. Idempotent, and it never reads or writes user data.
STAMP="$DSH_HOME/.image-version"
CURRENT="$(cat "$STAMP" 2>/dev/null || true)"
if [ "$CURRENT" != "$IMAGE_VERSION" ]; then
  if [ -n "$CURRENT" ]; then
    say "  updating profile: ${CURRENT} -> ${IMAGE_VERSION}"
  fi
  rsync -a --delete "$BAKED_HOME/profiles/" "$DSH_HOME/profiles/"
  if [ -d "$BAKED_HOME/.agent-presets" ]; then
    rsync -a --delete "$BAKED_HOME/.agent-presets/" "$DSH_HOME/.agent-presets/"
  fi
  printf '%s\n' "$IMAGE_VERSION" > "$STAMP"
  ok "profile and presets from image ${IMAGE_VERSION}"
else
  ok "profile already at image ${IMAGE_VERSION}"
fi
mkdir -p "$DSH_HOME/.agent-presets/opus-qwen"

# ── this machine's configuration ─────────────────────────────────────────────
# Credentials and gateway addresses arrive over TLS, keyed to the enrollment
# token. A blank value simply drops the routes that need it.
KEYS="TABITOKEN_API_KEY OMNIROUTER_API_KEY OPENROUTER_API_KEY NVIDIA_NIM_API_KEY \
AGENTROUTER_API_KEY GEMINI_API_KEY ZAI_API_KEY QWEN_BRIDGE_KEY AGY_BRIDGE_KEY \
META_ADS_BRIDGE_TOKEN HOSTINGER_API_TOKEN HOSTINGER_MAIL_API_TOKEN \
TABITOKEN_BASE_URL OMNIROUTE_BASE_URL QWEN_OMNI_NODE_ID META_ADS_BRIDGE_URL QWEN_RELAY_SSH"

CONFIG_JSON=''
if [ -n "${DSH_DIST_BASE:-}" ] && [ -n "${DSH_DIST_TOKEN:-}" ]; then
  if CONFIG_JSON="$(curl -fsS --max-time 40 "${DSH_DIST_BASE}/config/${DSH_DIST_TOKEN}" 2>/dev/null)"; then
    ok "configuration fetched for this machine"
  else
    warn "could not reach ${DSH_DIST_BASE} — starting with whatever is already in the volume"
    CONFIG_JSON=''
  fi
fi

# Export every credential and endpoint the templates read. Values come from the
# fetched bundle first, then the container environment, so `docker run -e` can
# override or supply anything without a new image.
if [ -n "$CONFIG_JSON" ]; then
  eval "$(printf '%s' "$CONFIG_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let bundle;
      try { bundle = JSON.parse(raw); } catch { process.exit(0); }
      const out = [];
      for (const group of ["credentials", "endpoints"]) {
        for (const [key, value] of Object.entries(bundle[group] ?? {})) {
          if (!/^[A-Z0-9_]+$/.test(key)) continue;
          if (value === null || value === undefined || value === "") continue;
          if (process.env[key]) continue;            // an explicit -e wins
          out.push(`export ${key}=${JSON.stringify(String(value))}`);
        }
      }
      process.stdout.write(out.join("\n"));
    });
  ')"
fi

: "${QWEN_BRIDGE_KEY:=local-bridge-no-key-needed}"
export QWEN_BRIDGE_KEY

# ── render the config the harness reads ──────────────────────────────────────
export DSHX_TABITOKEN_BASE_URL="${TABITOKEN_BASE_URL:-}"
export DSHX_OMNIROUTE_BASE_URL="${OMNIROUTE_BASE_URL:-}"
export DSHX_QWEN_OMNI_NODE_ID="${QWEN_OMNI_NODE_ID:-}"
node "$INSTALLER/tools/render.mjs" \
  "$INSTALLER/payload/settings.template.yaml" "$DSH_HOME/settings.yaml" >/dev/null

# Two providers reach services that live on the HOST, not in here: the Qwen
# desktop-app bridge on 3083 and the AgentRouter user-agent proxy on 3081. Inside
# a container 127.0.0.1 is the container, so those two are repointed at the host.
# Set DSH_HOST_GATEWAY to override (Linux hosts usually want 172.17.0.1).
HOST_GW="${DSH_HOST_GATEWAY:-host.docker.internal}"
sed -i \
  -e "s|http://127\.0\.0\.1:3083|http://${HOST_GW}:3083|g" \
  -e "s|http://127\.0\.0\.1:3081|http://${HOST_GW}:3081|g" \
  "$DSH_HOME/settings.yaml"
PROVIDERS="$(grep -cE '^    [a-z0-9-]+:$' "$DSH_HOME/settings.yaml" || true)"
ok "settings.yaml — ${PROVIDERS} providers, host services via ${HOST_GW}"

{
  printf 'version: 1\nrefs:\n'
  for key in TABITOKEN_API_KEY OMNIROUTER_API_KEY OPENROUTER_API_KEY NVIDIA_NIM_API_KEY \
             AGENTROUTER_API_KEY GEMINI_API_KEY ZAI_API_KEY QWEN_BRIDGE_KEY AGY_BRIDGE_KEY; do
    eval "value=\${$key:-}"
    # An empty ref is a hard error in dsh ("remove the key instead"), so a key we
    # do not have is simply absent rather than declared blank.
    if [ -n "$value" ]; then printf '  %s: %s\n' "$key" "$value"; fi
  done
} > "$DSH_HOME/.credentials.yaml"
chmod 600 "$DSH_HOME/.credentials.yaml"

{
  printf '# Rendered on every container start from the enrollment bundle.\n'
  for key in META_ADS_BRIDGE_TOKEN HOSTINGER_API_TOKEN HOSTINGER_MAIL_API_TOKEN; do
    eval "value=\${$key:-}"
    if [ -n "$value" ]; then printf '%s=%s\n' "$key" "$value"; fi
  done
} > "$DSH_HOME/.env"
chmod 600 "$DSH_HOME/.env"

PRESENT=0
for key in TABITOKEN_API_KEY OMNIROUTER_API_KEY OPENROUTER_API_KEY NVIDIA_NIM_API_KEY \
           AGENTROUTER_API_KEY GEMINI_API_KEY ZAI_API_KEY QWEN_BRIDGE_KEY AGY_BRIDGE_KEY \
           META_ADS_BRIDGE_TOKEN HOSTINGER_API_TOKEN HOSTINGER_MAIL_API_TOKEN; do
  eval "value=\${$key:-}"
  if [ -n "$value" ]; then PRESENT=$((PRESENT + 1)); fi
done
ok "${PRESENT} of 12 credentials present"

# The MCP rows and the agent preset. Paths here are the container's own, which is
# the entire point: one path shape, already tested, on every host OS.
export DSHX_PROFILE_WEB="$DSH_HOME/profiles/web"
export DSHX_DSH_HOME="$DSH_HOME"
export DSHX_HOME="${HOME:-/root}"
export DSHX_NODE="$(command -v node)"
export DSHX_META_ADS_BRIDGE_TOKEN="${META_ADS_BRIDGE_TOKEN:-}"
export DSHX_META_ADS_BRIDGE_URL="${META_ADS_BRIDGE_URL:-}"
if [ -n "${META_ADS_BRIDGE_TOKEN:-}" ] && [ -n "${META_ADS_BRIDGE_URL:-}" ]; then
  export DSHX_META_ADS_ENABLED=1
else
  export DSHX_META_ADS_ENABLED=''
fi
export DSHX_HOSTINGER_API_TOKEN="${HOSTINGER_API_TOKEN:-}"
export DSHX_HOSTINGER_MAIL_API_TOKEN="${HOSTINGER_MAIL_API_TOKEN:-}"
export DSHX_HOSTINGER_DIR="$DSH_HOME/hostinger-mcp"
export DSHX_HOSTINGER_ENV_JSON="\"$DSH_HOME/hostinger-mcp/.env\""
export DSHX_HOSTINGER_MCP_BIN="hostinger-mail-mcp"
export DSHX_MULTILOGIN_DIR=''
export DSHX_MULTILOGIN_SERVER_JSON='""'

mkdir -p "$DSHX_HOSTINGER_DIR"
if [ -n "${HOSTINGER_MAIL_API_TOKEN:-}" ]; then
  printf 'HOSTINGER_MAIL_API_TOKEN=%s\n' "$HOSTINGER_MAIL_API_TOKEN" > "$DSHX_HOSTINGER_DIR/.env"
  chmod 600 "$DSHX_HOSTINGER_DIR/.env"
fi

node "$INSTALLER/tools/render.mjs" \
  "$INSTALLER/payload/profile-web/cordis.patch.template.yml" \
  "$DSH_HOME/profiles/web/cordis.patch.yml" >/dev/null
ok "MCP rows rendered"

cp "$INSTALLER/payload/agent-presets/opus-qwen/preset.yml" \
   "$DSH_HOME/.agent-presets/opus-qwen/preset.yml"
node "$INSTALLER/tools/render.mjs" \
  "$INSTALLER/payload/agent-presets/opus-qwen/agent.cordis.template.yml" \
  "$DSH_HOME/.agent-presets/opus-qwen/agent.cordis.yml" >/dev/null
ok "opus-qwen preset rendered"

# ── serve ────────────────────────────────────────────────────────────────────
# The harness only ever listens on loopback — that is its own safety rule, and its
# config schema allows nothing else — so a raw TCP relay carries the published
# port to it. Docker publishes 3080 to the HOST's loopback only, so the exposed
# surface is the same as running dsh directly, and the browser still arrives with
# a Host of 127.0.0.1, which the /api trust fence accepts as loopback. WebSocket
# upgrades pass through a TCP relay untouched.
INNER_PORT="$((PORT + 1))"
socat "TCP-LISTEN:${PORT},fork,reuseaddr" "TCP:127.0.0.1:${INNER_PORT}" &
say ''
say "  http://127.0.0.1:${PORT}"
# exec so the harness is PID 1's child: if it stops, the container stops with it
# and the restart policy brings both back, instead of leaving a live port in front
# of a dead server.
exec dsh --profile web \
  --host 127.0.0.1 --port "$INNER_PORT" --no-open \
  --trusted-host localhost --trusted-host host.docker.internal "$@"
