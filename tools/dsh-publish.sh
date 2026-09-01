#!/usr/bin/env bash
# dsh-publish — release a new managed DeepSeek Harness from this Mac.
#
#   ./tools/dsh-publish.sh 1.0.1 "what changed"     publish this working tree
#   ./tools/dsh-publish.sh --enroll "Ayush MacBook" mint an install link
#   ./tools/dsh-publish.sh --profile                push the current keys as the
#                                                   config every enrolled machine
#                                                   receives
#   ./tools/dsh-publish.sh --list                   who is enrolled, and the release
#
# Publishing packs this repository (minus .git) into a tarball, uploads it, and
# points the manifest at it. Every enrolled machine notices within 6 hours, or
# immediately if the user runs `dsh-update`.
#
# The admin token lives on the VPS and is read over SSH, so it never sits in a
# file on this Mac and never appears in a shell history.
set -eu

BASE="${DSH_DIST_BASE:-https://get.xovi.pro}"
VPS="${DSH_DIST_SSH:-root@72.60.219.89}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=''; G=''; Y=''; R=''; D=''; N=''
fi
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# The service binds the docker bridge gateway, so admin calls go through the VPS.
# curl runs THERE, which is also why the token never leaves the box.
admin() {
  _method="$1"; _path="$2"; shift 2
  ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$VPS" \
    "TOK=\$(cat /opt/dsh-dist/admin.token); curl -sS -X $_method -H \"Authorization: Bearer \$TOK\" $* http://127.0.0.1:8790$_path"
}

usage() { sed -n '2,16p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; }

case "${1:-}" in
  ''|-h|--help) usage; exit 0 ;;

  --list)
    printf '%scurrent release%s\n' "$B" "$N"
    curl -fsS --max-time 20 "$BASE/manifest.json" 2>/dev/null | sed 's/^/  /' || info "(service unreachable from here)"
    printf '\n%senrolled machines%s\n' "$B" "$N"
    admin GET /admin/enrollments > /tmp/dsh-enrollments.json 2>/dev/null || true
    DSH_BASE="$BASE" node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        const base = process.env.DSH_BASE;
        let d; try { d = JSON.parse(raw); } catch { console.log("  " + raw.trim()); return; }
        const rows = d.tokens ?? [];
        if (!rows.length) { console.log("  (none yet — mint one with --enroll)"); return; }
        for (const t of rows) {
          console.log(`  ${t.name}`);
          console.log(`    profile ${t.profile} · checked in ${t.checkIns ?? 0}x · last ${t.lastSeen ?? "never"}`);
          console.log(`    curl -fsSL ${base}/i/${t.fullToken} | bash`);
        }
      });' < /tmp/dsh-enrollments.json
    rm -f /tmp/dsh-enrollments.json
    ;;

  --enroll)
    NAME="${2:?--enroll needs a name, e.g. --enroll \"Ayush MacBook Pro\"}"
    PROFILE="${3:-default}"
    TMP="$(mktemp)"
    node -e 'require("node:fs").writeFileSync(process.argv[3], JSON.stringify({name:process.argv[1],profile:process.argv[2]}))' \
      "$NAME" "$PROFILE" "$TMP"
    scp -q -o BatchMode=yes "$TMP" "$VPS:/tmp/dsh-enroll.json"
    rm -f "$TMP"
    ssh -o BatchMode=yes "$VPS" \
      'TOK=$(cat /opt/dsh-dist/admin.token); curl -sS -X POST -H "Authorization: Bearer $TOK" -H "content-type: application/json" --data-binary @/tmp/dsh-enroll.json http://127.0.0.1:8790/admin/enroll; rm -f /tmp/dsh-enroll.json' \
      > "$HERE/.last-enroll.json"
    # Read from stdin: `node -e` argv indexing differs from a script file and is
    # an easy way to get ERR_INVALID_ARG_TYPE.
    node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        let d; try { d = JSON.parse(raw); } catch { console.log(raw.trim()); return; }
        if (!d.install) { console.log("  " + raw.trim()); return; }
        console.log("");
        console.log("  macOS / Linux — paste this on the new machine:");
        console.log("    " + d.install.macos);
        console.log("");
        console.log("  Windows (PowerShell):");
        console.log("    " + d.install.windows);
        console.log("");
      });' < "$HERE/.last-enroll.json"
    rm -f "$HERE/.last-enroll.json"
    ok "enrolled \"$NAME\" on profile $PROFILE"
    ;;

  --profile)
    # Push THIS machine's working keys and endpoints as the config that enrolled
    # machines receive. collect-profile.mjs reads the live files, so nothing is
    # retyped and nothing drifts from what actually works here.
    PROFILE="${2:-default}"
    TMP="$(mktemp)"
    node "$HERE/tools/collect-profile.mjs" "$PROFILE" > "$TMP" || die "could not collect this machine's config"
    SUMMARY="$(node "$HERE/tools/collect-profile.mjs" "$PROFILE" --summary)"
    scp -q -o BatchMode=yes "$TMP" "$VPS:/tmp/dsh-profile.json"
    rm -f "$TMP"
    ssh -o BatchMode=yes "$VPS" \
      'TOK=$(cat /opt/dsh-dist/admin.token); curl -sS -X POST -H "Authorization: Bearer $TOK" -H "content-type: application/json" --data-binary @/tmp/dsh-profile.json http://127.0.0.1:8790/admin/profile; rm -f /tmp/dsh-profile.json' \
      | sed 's/^/  /'
    ok "profile \"$PROFILE\" pushed — $SUMMARY"
    ;;

  --revoke)
    TOKEN="${2:?--revoke needs a token}"
    admin POST /admin/revoke -H 'content-type:\ application/json' --data "'{\"token\":\"$TOKEN\"}'" | sed 's/^/  /'
    ;;

  *)
    VERSION="$1"
    NOTES="${2:-}"
    case "$VERSION" in
      -*) die "unknown option: $VERSION" ;;
      *[!A-Za-z0-9._-]*) die "version has unsafe characters: $VERSION" ;;
    esac

    # Refuse to ship a release that cannot even parse.
    info "checking the tree"
    bash -n "$HERE/install.sh" || die "install.sh does not parse"
    bash -n "$HERE/dsh-setup.sh" || die "dsh-setup.sh does not parse"
    for f in "$HERE"/tools/*.mjs "$HERE"/payload/updater/*.mjs "$HERE"/payload/agentrouter-proxy/*.mjs; do
      node --check "$f" >/dev/null || die "$f does not parse"
    done
    ok "scripts parse"

    WORK="$(mktemp -d)"
    TAR="$WORK/dsh-$VERSION.tar.gz"
    ZIP="$WORK/dsh-$VERSION.zip"
    ( cd "$HERE" && tar czf "$TAR" --exclude .git --exclude '.DS_Store' --exclude 'dist-server' . )
    # Windows gets a zip: PowerShell's Expand-Archive is built in, tar is not
    # dependable on older builds. Same tree, two containers.
    ( cd "$HERE" && zip -rq "$ZIP" . -x '.git/*' -x '*.DS_Store' -x 'dist-server/*' )
    info "packed $(( $(wc -c < "$TAR") / 1024 ))KB tar.gz + $(( $(wc -c < "$ZIP") / 1024 ))KB zip"

    ENC_NOTES="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]||""))' "$NOTES")"

    # Upload through the VPS: the admin port is not exposed publicly.
    for kind in tar.gz zip; do
      case "$kind" in
        tar.gz) SRC="$TAR" ;;
        zip) SRC="$ZIP" ;;
      esac
      scp -q -o BatchMode=yes "$SRC" "$VPS:/tmp/dsh-release.$kind"
      ssh -o BatchMode=yes "$VPS" \
        "TOK=\$(cat /opt/dsh-dist/admin.token); curl -sS -X POST -H \"Authorization: Bearer \$TOK\" --data-binary @/tmp/dsh-release.$kind 'http://127.0.0.1:8790/admin/release?version=$VERSION&kind=$kind&notes=$ENC_NOTES'; rm -f /tmp/dsh-release.$kind" \
        | sed "s/^/  /"
    done
    rm -rf "$WORK"

    printf '\n'
    ok "released $VERSION"
    info "every enrolled machine is prompted within 6 hours, or instantly with: dsh-update"
    ;;
esac
