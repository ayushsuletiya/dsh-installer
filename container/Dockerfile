# DeepSeek Harness — the whole harness, built and tested once, run anywhere.
#
# Why a container: the Windows installer had to reproduce a hand-built macOS setup
# on a host whose PowerShell, PATH, npm layout, ESM path semantics, ACLs and
# service manager all differ. Every one of those cost a round trip, because there
# is no Windows machine here to test on. Inside this image the OS is the one that
# gets tested end to end before anything ships, so Windows and macOS run the
# identical, already-verified artifact.
#
# Everything that can be decided at build time IS decided at build time: node, the
# pinned dsh, all ten plugin bundles, the five local plugins, the model-picker
# patch. Nothing installs at first run, so nothing can fail at first run.
#
# Secrets are never baked. The entrypoint fetches this machine's configuration
# over TLS with its enrollment token and renders it into the data volume.

FROM node:24-bookworm-slim

ARG DSH_VERSION=0.1.1-rc.2
ARG IMAGE_VERSION=dev
ENV DEBIAN_FRONTEND=noninteractive \
    DSH_IMAGE_VERSION=${IMAGE_VERSION} \
    DSH_PINNED_VERSION=${DSH_VERSION}

# git is here on purpose: one bundle is a git-pinned dependency, and without git
# pnpm cannot resolve it and the installer has to fall back to an npm release.
# In a container that fallback is unnecessary, so the pinned tag is what ships.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git rsync socat tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

# The installer payload: templates rendered at start, plus the tools that do it.
COPY payload /opt/dsh/payload
COPY tools /opt/dsh/tools
COPY container/entrypoint.sh /opt/dsh/entrypoint.sh
RUN chmod +x /opt/dsh/entrypoint.sh

# ── the profile, composed at build time ─────────────────────────────────────
# Built under /opt/dsh-home so the runtime data volume never shadows it. The
# entrypoint copies this into the volume on start, which is also how an update
# ships new plugins without touching anything the user owns.
ENV BAKED_HOME=/opt/dsh-home
RUN mkdir -p "$BAKED_HOME" \
 && DSH_HOME="$BAKED_HOME" dsh --profile web --dump-default-config >/dev/null 2>&1 || true

RUN set -eu; \
    P="$BAKED_HOME/profiles/web"; \
    mkdir -p "$P"; \
    cp /opt/dsh/payload/profile-web/package.json "$P/package.json"; \
    for f in compaction-llm-retry.mjs web-search-ddg.mjs llm-turn-fallback.mjs qwen-coder.mjs command-clear.mjs; do \
      cp "/opt/dsh/payload/profile-web/$f" "$P/$f"; \
    done; \
    if [ -f "$P/pnpm-workspace.yaml" ]; then node /opt/dsh/tools/pnpm-allow-builds.mjs "$P/pnpm-workspace.yaml"; fi

# The slow step, done once here instead of on every machine.
RUN set -eu; \
    cd "$BAKED_HOME/profiles/web"; \
    DSH_HOME="$BAKED_HOME" dsh plugin --profile web install; \
    pnpm store prune || true

# The model-picker patch lives in the global dsh install, so it belongs in the
# image. Exit 4 means "this version is not the one the patch was cut for".
RUN node /opt/dsh/tools/patch-model-selector.mjs; \
    code=$?; \
    if [ "$code" != 0 ] && [ "$code" != 4 ]; then exit "$code"; fi

# A marker so the entrypoint can tell whether the volume's profile came from THIS
# image, and refresh it exactly when the image changes.
RUN printf '%s\n' "$IMAGE_VERSION" > "$BAKED_HOME/.image-version"

ENV DSH_HOME=/data/.dsh \
    DSH_WEB_PORT=3080
VOLUME ["/data"]
WORKDIR /work
EXPOSE 3080

# tini reaps the children dsh spawns (pnpm, mcp servers, chrome) so a long-lived
# container does not accumulate zombies.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/dsh/entrypoint.sh"]
