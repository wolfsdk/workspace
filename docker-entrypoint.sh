#!/bin/sh
# Apache-2.0 - Copyright 2026 SynthGL, Inc.
# Start Wolf Workspace in the container: find or install the Wolf engine, make the first sign-in token when
# there is none, then serve. Extra arguments go to `wolfsdk-workspace serve` (for example --default-room team).
set -eu

data=${WOLF_WORKSPACE_DATA:-/data}
actors=${WOLF_WORKSPACE_ACTORS:-$data/actors.json}
mkdir -p "$data/blobs"

if [ -n "${WOLF_ENGINE:-}" ]; then
    # Your own `wolf` executable, mounted into the container: nothing is downloaded.
    engine=$WOLF_ENGINE
    [ -x "$engine" ] || { echo "error: WOLF_ENGINE=$engine is not an executable file" >&2; exit 1; }
else
    # The engine is closed source and is not part of this image. The installer verifies the download's
    # SHA-256 and keeps the engine and its licence in the data volume, so this runs once per version.
    engine=$data/bin/wolf
    if [ ! -x "$engine" ] || [ ! -d "$data/bin/wolf-licenses/$WOLF_VERSION" ]; then
        echo "Installing the Wolf engine $WOLF_VERSION from $WOLF_INSTALL_URL into $data/bin"
        curl -fsSL "$WOLF_INSTALL_URL" | env WOLF_INSTALL_DIR="$data/bin" WOLF_VERSION="$WOLF_VERSION" sh
    fi
fi

if [ ! -f "$actors" ]; then
    token=$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""))')
    (umask 077 && printf '{"%s": {"kind": "user", "id": "owner", "name": "Owner"}}\n' "$token" >"$actors")
    echo "Created $actors with one user. Sign in at http://127.0.0.1:8787/?token=$token"
    echo "Add people and agents to that file (a map of token to actor) and restart the container."
fi

exec bun run /app/packages/workspace-cli/src/cli.ts serve \
    --db "$data/rooms.sqlite" --blobs "$data/blobs" --engine "$engine" --actors "$actors" \
    --static-dir /app/apps/workspace/dist --host 0.0.0.0 --port 8787 "$@"
