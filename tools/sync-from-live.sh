#!/usr/bin/env bash
# Refresh payload/ from THIS machine's live DSH setup.
#
#   ./tools/sync-from-live.sh [--dsh-home ~/.dsh] [--bridge ~/qwen-bridge]
#
# Run this after changing the setup by hand, so the installer keeps installing the
# current thing rather than a snapshot from whenever it was written. It:
#
#   * copies settings.yaml, dropping the `opencode-free` provider block and
#     de-Mac-ifying the Qwen desktop route's display name
#   * copies the profile's package.json and the five local plugins
#   * re-templates every absolute path out of the agent preset
#   * copies the Qwen bridge sources (the cross-platform edits in payload/ are
#     preserved: files that already differ only by those edits are NOT clobbered)
#   * re-pins the model-picker patch for the installed dsh version, recording the
#     pristine npm hash so the patcher can tell "untouched" from "modified"
#
# Secrets are never copied: settings.yaml holds only `apiKeyEnv` references, and
# cordis.patch.yml is regenerated from the template rather than read back.
set -eu

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
BRIDGE_DIR="${QWEN_BRIDGE_DIR:-$HOME/qwen-bridge}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dsh-home) DSH_HOME_DIR="${2:?}"; shift 2 ;;
    --bridge) BRIDGE_DIR="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PAYLOAD="$HERE/payload"
PROFILE="$DSH_HOME_DIR/profiles/web"
PRESET="$DSH_HOME_DIR/.agent-presets/opus-qwen"

say() { printf '  %s\n' "$*"; }

[ -f "$DSH_HOME_DIR/settings.yaml" ] || { echo "no settings.yaml under $DSH_HOME_DIR" >&2; exit 1; }

echo "syncing payload from $DSH_HOME_DIR"

# ── settings.yaml, minus opencode ────────────────────────────────────────────
python3 - "$DSH_HOME_DIR/settings.yaml" "$PAYLOAD/settings.template.yaml" <<'PY'
import re, sys, pathlib
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
lines = src.read_text(encoding='utf-8').splitlines(keepends=True)
out, i, dropped = [], 0, 0
while i < len(lines):
    if lines[i].startswith('    opencode-free:'):
        j = i + 1
        while j < len(lines) and not re.match(r'^    [A-Za-z0-9_-]+:', lines[j]):
            j += 1
        dropped = j - i
        i = j
        continue
    out.append(lines[i]); i += 1
text = ''.join(out)
text = text.replace('displayName: Qwen · Desktop App (full tools · needs Mac)',
                    'displayName: Qwen · Desktop App (full tools · local bridge)')
if 'opencode' in text:
    sys.exit('refusing to write: opencode still referenced')
providers = re.findall(r'^    ([A-Za-z0-9_-]+):', text, re.M)
dst.write_text(text, encoding='utf-8')
print(f"  settings.template.yaml — {len(providers)} providers, dropped {dropped} opencode lines")
PY

# ── profile: package.json + the local plugins ───────────────────────────────
cp "$PROFILE/package.json" "$PAYLOAD/profile-web/package.json"
say "profile-web/package.json"
for f in compaction-llm-retry.mjs web-search-ddg.mjs llm-turn-fallback.mjs qwen-coder.mjs command-clear.mjs; do
  if [ -f "$PROFILE/$f" ]; then
    cp "$PROFILE/$f" "$PAYLOAD/profile-web/$f"
    say "profile-web/$f"
  fi
done

echo "  NOTE cordis.patch.yml is NOT synced — edit payload/profile-web/cordis.patch.template.yml"

# ── agent preset, with paths templated back out ─────────────────────────────
if [ -f "$PRESET/agent.cordis.yml" ]; then
  cp "$PRESET/preset.yml" "$PAYLOAD/agent-presets/opus-qwen/preset.yml"
  python3 - "$PRESET/agent.cordis.yml" "$PAYLOAD/agent-presets/opus-qwen/agent.cordis.template.yml" "$PROFILE" <<'PY'
import re, sys, pathlib
src, dst, profile = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3].rstrip('/')
text = src.read_text(encoding='utf-8')
text = text.replace(profile + '/', '{{PROFILE_WEB}}/')
# Any remaining absolute home path would pin the preset to this machine.
leftover = [p for p in re.findall(r'(?:/Users|/home|[A-Z]:[\\/])[^\s\'"]*', text)
            if 'PROFILE_WEB' not in p]
if leftover:
    sys.exit('absolute paths left in the preset: ' + ', '.join(sorted(set(leftover))[:5]))
dst.write_text(text, encoding='utf-8')
print('  agent-presets/opus-qwen/agent.cordis.template.yml')
PY
fi

# ── qwen bridge ─────────────────────────────────────────────────────────────
# The payload copies carry cross-platform edits (app launch per OS, cookie-jar
# path, an optional relay key), so only files WITHOUT those markers are refreshed
# and anything already patched is reported instead of overwritten.
for f in server-app.mjs qwen-app-client.mjs qwen-auth.mjs qwen-login.mjs \
         server-oauth.mjs tool-formatter.mjs push-creds.mjs README.md; do
  live="$BRIDGE_DIR/$f"
  mine="$PAYLOAD/qwen-bridge/$f"
  [ -f "$live" ] || continue
  if [ -f "$mine" ] && grep -q 'cross-platform app control\|cookieJarPath' "$mine" 2>/dev/null; then
    if ! cmp -s "$live" "$mine"; then
      say "SKIPPED $f — payload copy is cross-platform, live copy differs (merge by hand)"
    fi
    continue
  fi
  cp "$live" "$mine"
  say "qwen-bridge/$f"
done
echo "  NOTE run.sh / run.ps1 are installer-owned and never synced"

# ── model-picker patch, re-pinned for the installed version ────────────────
node - "$HERE" <<'JS'
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = process.argv[2];
const PKG = "@deepseek-ai/dsh-client-ui-model-selection";
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const pkgDir = path.join(globalRoot, "@deepseek-ai", "dsh", "node_modules", PKG);
if (!fs.existsSync(pkgDir)) { console.log("  model picker: package not installed, skipped"); process.exit(0); }

const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
const live = path.join(pkgDir, "lib", "client.js");
const liveBuf = fs.readFileSync(live);
const markers = ["local patch: model list search", "local patch: collapsible provider groups"];
const text = liveBuf.toString("utf8");
if (!markers.every((m) => text.includes(m))) {
  console.log(`  model picker: live bundle is not fully patched (${version}), skipped`);
  process.exit(0);
}

// The pristine hash has to come from npm, not from a local backup, so the
// patcher can recognise an untouched install on the TARGET machine.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ms-orig-"));
execFileSync("npm", ["pack", `${PKG}@${version}`], { cwd: tmp, stdio: "ignore" });
const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
execFileSync("tar", ["xzf", tgz], { cwd: tmp });
const pristine = fs.readFileSync(path.join(tmp, "package", "lib", "client.js"));

const outDir = path.join(repo, "payload", "patches", "model-selection", version);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "client.patched.js"), liveBuf);
fs.writeFileSync(path.join(outDir, "client.pristine.sha256"), createHash("sha256").update(pristine).digest("hex") + "\n");
fs.writeFileSync(path.join(outDir, "client.patched.sha256"), createHash("sha256").update(liveBuf).digest("hex") + "\n");
try {
  const diff = execFileSync("diff", ["-u", path.join(tmp, "package", "lib", "client.js"), live], { encoding: "utf8" });
  fs.writeFileSync(path.join(outDir, "client.patch"), diff);
} catch (err) {
  if (err.stdout) fs.writeFileSync(path.join(outDir, "client.patch"), err.stdout);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`  model picker: re-pinned for ${version}`);
JS

echo
echo "done. review with: git -C $HERE diff --stat"
