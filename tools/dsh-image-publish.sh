#!/usr/bin/env bash
# dsh-image-publish — build, push and publish a new harness container image.
#
#   ./tools/dsh-image-publish.sh 2.0.2 "what changed"
#
# The build runs ON the VPS, natively on linux/amd64, because that is the
# architecture Docker Desktop runs on Windows and on this Mac it would be
# emulated. Every enrolled machine pulls whatever the manifest points at, so
# publishing is the entire update: no client change, no reinstall, and the data
# volume with the user's chats is never touched.
set -eu

VERSION="${1:?usage: dsh-image-publish.sh <version> [notes]}"
NOTES="${2:-}"
VPS="${DSH_DIST_SSH:-root@72.60.219.89}"
REGISTRY_PUBLIC="${DSH_REGISTRY:-reg.xovi.pro}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

case "$VERSION" in
  *[!A-Za-z0-9._-]*) printf 'error: unsafe version: %s\n' "$VERSION" >&2; exit 1 ;;
esac

printf '→ syncing the tree to the builder\n'
rsync -az --delete --exclude '.git' --exclude '.DS_Store' \
  -e 'ssh -o BatchMode=yes' "$HERE/" "$VPS:/opt/dsh-build/"

printf '→ building linux/amd64 image %s\n' "$VERSION"
ssh -o BatchMode=yes "$VPS" \
  "cd /opt/dsh-build && docker build -q -f container/Dockerfile \
     --build-arg IMAGE_VERSION='$VERSION' \
     -t '127.0.0.1:5000/dsh:$VERSION' -t '127.0.0.1:5000/dsh:latest' . >/dev/null && echo built"

printf '→ pushing to the registry\n'
ssh -o BatchMode=yes "$VPS" \
  "docker push -q '127.0.0.1:5000/dsh:$VERSION' >/dev/null && docker push -q '127.0.0.1:5000/dsh:latest' >/dev/null && echo pushed"

printf '→ pointing the manifest at it\n'
ssh -o BatchMode=yes "$VPS" "TOK=\$(cat /opt/dsh-dist/admin.token); \
  curl -sS -X POST -H \"Authorization: Bearer \$TOK\" -H 'content-type: application/json' \
    --data \"{\\\"reference\\\":\\\"$REGISTRY_PUBLIC/dsh:$VERSION\\\",\\\"tag\\\":\\\"$VERSION\\\",\\\"notes\\\":\\\"$NOTES\\\"}\" \
    http://127.0.0.1:8790/admin/image" | sed 's/^/  /'

printf '→ confirming the public pull path\n'
curl -fsS "https://$REGISTRY_PUBLIC/v2/dsh/tags/list" | sed 's/^/  /'
printf '\n✓ published %s/dsh:%s\n' "$REGISTRY_PUBLIC" "$VERSION"
printf '  every machine picks it up within 6 hours, or immediately from the Desktop shortcut after an update check.\n'
