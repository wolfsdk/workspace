# Apache-2.0 - Copyright 2026 SynthGL, Inc.
# Single-container self-host image for Wolf Workspace: the browser UI, the API, the room WebSocket and the MCP
# endpoint on one port (8787), served by `wolfsdk-workspace serve` over @wolfsdk/server.
#
# The image holds this repository's open-source code and nothing else. The Wolf engine is closed source and is
# not in it: on first start the entrypoint installs the pinned version from https://wolfsdk.com/install into the
# data volume, or uses the `wolf` executable that WOLF_ENGINE names when you mount your own.
#
# The image is built for linux/amd64 and linux/arm64, and each installs the engine's Linux build for its own
# architecture.
FROM oven/bun:1.4.4-debian AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json LICENSE THIRD_PARTY_NOTICES.txt ./
COPY packages ./packages
COPY apps ./apps
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# `bun run build` builds the review element and the workspace UI (apps/workspace/dist).
RUN bun install --frozen-lockfile \
    && bun run build \
    && test -f apps/workspace/dist/index.html \
    && mkdir -p /data \
    && chown -R bun:bun /data /app

USER bun
ENV NODE_ENV=production \
    WOLF_VERSION=0.2.25 \
    WOLF_INSTALL_URL=https://wolfsdk.com/install

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
