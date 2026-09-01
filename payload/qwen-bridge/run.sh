#!/bin/sh
# Keep the Qwen desktop-app bridge alive without launchd.
#
#   nohup ~/qwen-bridge/run.sh >/dev/null 2>&1 &
#
# launchctl cannot load a LaunchAgent from inside the DSH sandbox, so this script
# is the portable supervisor: it restarts the bridge if it exits and, when a relay
# key is present, keeps the VPS OmniRoute relay's Qwen signature fresh so that
# route keeps working while this machine is idle.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${QWEN_BRIDGE_LOG:-$DIR/bridge.log}"

# Node, in order of preference: an explicit NODE, whatever is on PATH, then the
# newest nvm install. Never a version-pinned absolute path — that breaks on the
# next `nvm install`.
if [ -z "${NODE:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    NODE="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  fi
fi
if [ -z "${NODE:-}" ] || [ ! -x "$NODE" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) run.sh: no usable node found" >>"$LOG"
  exit 1
fi

export QWEN_BRIDGE_PORT="${QWEN_BRIDGE_PORT:-3083}"
export QWEN_CDP_PORT="${QWEN_CDP_PORT:-9222}"

# Credential push: optional. push-creds.mjs exits 0 and quietly when no relay key
# or no signed-in app is present, so this loop is harmless on a fresh machine.
(
  sleep 20
  while true; do
    "$NODE" "$DIR/push-creds.mjs" >>"$LOG" 2>&1 \
      || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) push-creds failed" >>"$LOG"
    sleep 1800
  done
) &

while true; do
  "$NODE" "$DIR/server-app.mjs" >>"$LOG" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor: bridge exited, restarting in 3s" >>"$LOG"
  sleep 3
done
