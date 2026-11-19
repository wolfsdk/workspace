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
    # SHA-256 and keeps the engine and its licences in the data volume, so this runs once per version.
    # A self-hosted workspace runs the engine under the Community Self-Host licence, so the installer
    # is told to name that one.
    engine=$data/bin/wolf
    # Image 0.1.0-1 put the x86-64 engine into the volume of an arm64 container and ran it through
    # emulation. Such a volume gets the arm64 build: byte 18 of an ELF file names its machine, and
    # 3e is x86-64.
    foreign=
    case "$(uname -m)" in
        aarch64|arm64)
            if [ -x "$engine" ] && [ "$(od -An -tx1 -j18 -N1 "$engine" | tr -d ' ')" = 3e ]; then
                foreign=1
            fi
            ;;
    esac
    if [ ! -x "$engine" ] || [ -n "$foreign" ] || [ ! -d "$data/bin/wolf-licenses/$WOLF_VERSION" ]; then
        echo "Installing the Wolf engine $WOLF_VERSION from $WOLF_INSTALL_URL into $data/bin"
        curl -fsSL "$WOLF_INSTALL_URL" | env WOLF_INSTALL_DIR="$data/bin" WOLF_VERSION="$WOLF_VERSION" \
            WOLF_INSTALL_TERMS="${WOLF_INSTALL_TERMS:-community-selfhost}" sh
    fi
fi
if ! "$engine" --version >/dev/null 2>&1; then
    echo "error: $engine does not run in this container ($(uname -m))." >&2
    echo "The engine has to be a Linux executable for this machine: the installer picks that build, and a WOLF_ENGINE of your own has to match." >&2
    exit 1
fi

if [ ! -f "$actors" ]; then
    token=$(bun -e 'console.log(crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""))')
    (umask 077 && printf '{"%s": {"kind": "user", "id": "owner", "name": "Owner"}}\n' "$token" >"$actors")
    echo "Created $actors with one user. Sign in at http://127.0.0.1:8787/?token=$token"
    echo "Add people and agents to that file (a map of token to actor) and restart the container."
fi

# The server runs as a child of this script, which ends it when it has stopped answering. Docker
# restarts a container that has exited (compose.yaml: restart: unless-stopped), never one that is
# still running, and a crashed server can stay behind as a process that answers nothing.
bun run /app/packages/workspace-cli/src/cli.ts serve \
    --db "$data/rooms.sqlite" --blobs "$data/blobs" --engine "$engine" --actors "$actors" \
    --static-dir /app/apps/workspace/dist --host 0.0.0.0 --port 8787 "$@" &
server=$!
trap 'kill -TERM "$server" 2>/dev/null || true' TERM INT

# One health probe every 10 s. The server has 12 probes to answer for the first time; after that,
# 3 probes in a row without an answer end it.
(
    allowed=12
    failures=0
    while sleep 10; do
        if curl -fsS -m 5 -o /dev/null http://127.0.0.1:8787/api/health 2>/dev/null; then
            allowed=3
            failures=0
        else
            failures=$((failures + 1))
        fi
        if [ "$failures" -ge "$allowed" ]; then
            echo "error: the server failed $failures health probes in a row; ending it so that the container exits" >&2
            kill -KILL "$server" 2>/dev/null || true
            exit 0
        fi
    done
) &
watchdog=$!

status=0
wait "$server" || status=$?
# A forwarded stop signal interrupts the wait before the server has finished.
if kill -0 "$server" 2>/dev/null; then
    status=0
    wait "$server" || status=$?
fi
kill "$watchdog" 2>/dev/null || true
exit "$status"
