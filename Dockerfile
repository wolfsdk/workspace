# Apache-2.0 - Copyright 2026 SynthGL, Inc.
# Single-container self-host image for Wolf Workspace: the browser UI, the API, the room WebSocket and the MCP
# endpoint on one port (8787), served by `wolfsdk-workspace serve` over @wolfsdk/server.
# Installs the qualified x86_64 Linux Wolf Runtime binary from https://wolfsdk.com/install.sh at build time.
FROM --platform=linux/amd64 oven/bun:1.4.4-debian AS runtime

ARG WOLF_INSTALL_URL=https://wolfsdk.com/install.sh
ARG WOLF_DOWNLOAD_ROOT=https://wolfsdk.com/download/wolf

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "${WOLF_INSTALL_URL}" | env HOME=/root WOLF_DOWNLOAD_ROOT="${WOLF_DOWNLOAD_ROOT}" WOLF_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

# `bun run build` builds the review element and the workspace UI (apps/workspace/dist), which `serve` finds by itself.
RUN bun install --frozen-lockfile \
    && bun run build \
    && test -f apps/workspace/dist/index.html \
    && mkdir -p /data/blobs /etc/wolf-workspace \
    && chown -R bun:bun /data /etc/wolf-workspace /app

USER bun
ENV NODE_ENV=production

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1

CMD ["bun", "run", "packages/workspace-cli/src/cli.ts", "serve", "--db", "/data/rooms.sqlite", "--blobs", "/data/blobs", "--engine", "/usr/local/bin/wolf", "--actors", "/etc/wolf-workspace/actors.json", "--static-dir", "/app/apps/workspace/dist", "--host", "0.0.0.0", "--port", "8787"]
