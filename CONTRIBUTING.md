# Contributing to Wolf Workspace

Use this guide to run the room server and editor on your own laptop, try a document, and open a pull request from a fork. Commands assume Bash and start at the repository root unless noted.

## What you need

- [Bun](https://bun.sh) 1.4 or later. CI pins 1.4.4.
- [Node](https://nodejs.org) 22.12 or later in the 22.x line, or a supported newer LTS, for Vite.
- `git`, `curl` and `jq`.
- Install the released `wolf` 0.2.25 executable for your platform from [the release channel](https://wolfsdk.com/install). The room server starts it as `wolf reactor-serve`. Point `WOLF` at your installation:

  ```sh
  export WOLF=~/.local/bin/wolf
  "$WOLF" --version
  ```

  The engine is closed source and is never added to this repository, and neither is its browser
  module (see [the engine module](README.md#the-engine-module)).
  The engine is free under the Community Self-Host grant (one workspace, up to five signed-in
  seats), which covers everything here.

The local room server needs the `wolf` executable. The browser editor needs the engine's
WebAssembly module as well (see *Live browser UI*).

## Get the code and build it

Fork [`wolfsdk/workspace`](https://github.com/wolfsdk/workspace/fork) on GitHub. Clone your fork using the HTTPS URL from its **Code** menu, then run:

```sh
cd workspace
git remote add upstream https://github.com/wolfsdk/workspace.git
bun install --frozen-lockfile
bun run build        # packages/review/dist, then apps/workspace/dist
```

The browser workspace imports `@wolfsdk/review` from `packages/review/dist`. Build it before starting the dev server.

### One-command engine check

After the build, one command starts a throwaway room server on a free loopback port with a
temporary actors file and state directory, uploads `fixtures/docx/tiny.docx`, checks that the
workspace renders one page and downloads the same bytes back, then removes everything it made.
It prints no token:

```sh
WOLF_ENGINE="$WOLF" bun scripts/smoke-docx.ts
```

Run it from the repository root. It prints `DOCX uploaded, rendered and downloaded byte-identically`
on success.

### Two-browser Excel check

From the repository root after building the UI:

```sh
bunx playwright-core install chromium firefox
WOLF_ENGINE="$WOLF" bun scripts/smoke-live-cells.ts
```

The check opens a real workbook as two users, saves edits to different cells, then tries competing formulas in the same cell. It downloads the workbook and reads the winning formula and the other user's value through the released engine. Set `LIVE_PROOF_DIR` to an empty directory to retain the workbook, screenshots, and receipt. To select installed browser executables, set `CHROMIUM_PATH` or `FIREFOX_PATH`.

## A local room server

Keep the server's state outside the checkout. From the repository root:

```sh
DATA=$(mktemp -d)
mkdir "$DATA/blobs"
printf 'Local workspace data directory: %s\n' "$DATA"
bun run packages/workspace-cli/src/cli.ts serve \
  --db "$DATA/rooms.sqlite" --blobs "$DATA/blobs" \
  --engine "$WOLF" --actors "$DATA/actors.json" \
  --default-room demo
```

Leave it running. With no actors file it creates one with a single user, `owner`, and prints that
user's token and the address to sign in at. The server listens on `http://127.0.0.1:8787` and serves the UI from
`apps/workspace/dist`, the MCP endpoint at `/mcp` and the room socket at `/ws`.

The printed address, the `created ... token` line and `$DATA/actors.json` contain bearer tokens. Treat them as secrets: do not
paste them into issues, pull requests or logs. The actors file is read again when it changes, so
adding a person or an agent needs no restart. In a second terminal (with `DATA` set to the same
directory, and `jq` for the lookups):

```sh
CLI=packages/workspace-cli/src/cli.ts
OWNER=$(jq -r 'to_entries[] | select(.value.id == "owner") | .key' "$DATA/actors.json")
AGENT=$(bun run "$CLI" actors add agent analyst --name Analyst --operator owner --actors "$DATA/actors.json" --json | jq -r .token)
```

An agent with an `operator` works on that person's seat instead of taking its own. An agent can
propose changes; only a person decides a proposal.

Check the server, and that your token signs in:

```sh
curl -s http://127.0.0.1:8787/api/health                                  # {"ok":true}
curl -s -H "Authorization: Bearer $OWNER" http://127.0.0.1:8787/api/me    # the owner actor
```

## Live browser UI

The browser workspace is `apps/workspace` (Preact). Run its Vite dev server against the room
server above. From the repository root, in a new terminal:

```sh
cd apps/workspace
node node_modules/vite/bin/vite.js
```

Open `http://localhost:5420/` and enter the owner token in the sign-in sheet. The token stays in the tab. Vite sends
`/api`, `/mcp`, `/wasm` and `/ws` to the room server on `127.0.0.1:8787`; set
`WORKSPACE_SERVER=http://127.0.0.1:<port>` to point it elsewhere and `WORKSPACE_APP_PORT` to move
it off 5420.

To see a source change land, change the heading text "Sign in with your access token" in
`apps/workspace/src/ui/sign-in.tsx`, save, and reload `http://localhost:5420/` in a tab that holds
no token: the sheet shows the new text. Revert the edit before you commit. After you change
`packages/review`, run `bun run --cwd packages/review build` and reload; the app reads that
package's `dist`, not its source.

If a saved edit never shows up, the operating system may have run out of file watchers (on macOS,
`node -e 'require("fs").watch(".")'` fails with `EMFILE` while other apps hold them all). Close
other watchers, or give Vite a polling watcher with a throwaway config that stays out of Git:

```sh
cat > vite.poll.config.ts <<'EOF'
import { mergeConfig } from "vite";
import base from "./vite.config.ts";
export default mergeConfig(base, { server: { watch: { usePolling: true, interval: 200 } } });
EOF
node node_modules/vite/bin/vite.js --config vite.poll.config.ts
```

Delete `vite.poll.config.ts` before you commit.

The editor loads the engine's WebAssembly module from the release channel
(`https://wolfsdk.com/download/wolf`) in the browser, so the browser needs to reach it. Offline,
put a module in a local channel directory (`latest.txt`, `v<VERSION>/...`) and start the server
with `--wasm-dir <dir>`; the app finds it at `/wasm`.

## Try a document: upload, propose, approve

The repository holds one small sample file per format in `fixtures/`. `fixtures/docx/tiny.docx`
is a short services agreement with a clause that reads "This clause is intentionally left
blank."

```sh
BASE=http://127.0.0.1:8787
curl -s -X POST "$BASE/api/rooms/demo/docs" -H "Authorization: Bearer $OWNER" \
  -F file=@fixtures/docx/tiny.docx                  # 201, head: revision 0
```

Now act as the agent over MCP (Streamable HTTP). Initialize once, keep the session id, then call
tools:

```sh
MCP="$BASE/mcp?room=demo"
HDR=(-H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
SID=$(curl -si "$MCP" "${HDR[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dev","version":"0"}}}' \
  | awk 'tolower($1) == "mcp-session-id:" { print $2 }' | tr -d '\r')
call() { curl -s "$MCP" "${HDR[@]}" -H "mcp-session-id: $SID" -d "$1"; }
call '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# Read the structure: each node has an address such as para:#1A000004, and the reply carries the revision.
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doc_read","arguments":{"doc":"tiny.docx","view":"structure"}}}' > "$DATA/structure.json"
jq -r '.result.structuredContent | "revision \(.revision)", (.nodes[] | "\(.address)  \(.text // "")")' "$DATA/structure.json"

# Propose an edit to the blank clause. In mode "propose" the change waits for a person.
TARGET=$(jq -r '.result.structuredContent.nodes[] | select(.text == "This clause is intentionally left blank.") | .address' "$DATA/structure.json")
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"doc_edit","arguments":{"doc":"tiny.docx","base_revision":0,"mode":"propose","message":"Fill in the blank clause","ops":[{"op":"replace-text","target":"'"$TARGET"'","find":"This clause is intentionally left blank.","replace":"Liability is capped at fees paid in the prior 12 months."}]}}}' | jq .result.structuredContent
```

The last call prints the open proposal. In the browser, open
`http://localhost:5420/?room=demo`, open `tiny.docx`, and approve the proposal from the
Proposals panel on the right. Approving commits revision 1 as the owner.

Check the saved bytes with the real engine, outside the workspace code:

```sh
curl -s -H "Authorization: Bearer $OWNER" "$BASE/api/rooms/demo/docs/tiny.docx/head" -o "$DATA/head.docx"
"$WOLF" extract "$DATA/head.docx" --what text --outdir "$DATA/out"
cat "$DATA/out/head.txt"      # the blank clause now holds the new text
```

`doc_read`'s other views are `text`, `markdown` and `cells` (workbooks only). The operation names
inside `ops` (`replace-text` here) are the engine's Agent API; the workspace passes them through
and does not interpret them.

## Tests and gates

Run only what you touched while you work:

```sh
bun test packages/server                       # one package
bun test apps/workspace/test                   # the browser app's tests
node_modules/.bin/tsc -p apps/workspace --noEmit   # typecheck one package or app
```

Before you open a pull request run what CI runs (`.github/workflows/pull-request.yml`):

```sh
bun run gate                       # frozen install, typecheck every package, bun test, review package check
bun run --cwd apps/workspace build
WOLF_ENGINE="$WOLF" bun scripts/smoke-docx.ts
```

Do not weaken or delete a test to make a gate
pass. If you change what ships to npm, also run `bun run pack:check`.

## Rules of the road

- This repository holds no format logic. Opening, editing, rendering and saving a document is the
  engine's job; the code here calls it. Do not add DOCX, XLSX or PPTX parsing.
- Do not commit an engine, a `.wasm` module, a database, a blob directory, an actors file or any
  token. Use placeholders (`<token>`, `~`) in issues, commits and pull request text, and no
  absolute paths from your machine.
- TypeScript is strict (`tsconfig.base.json`). Match the surrounding style and add a test beside
  the code you change. The hygiene tests (`hygiene.test.ts` in the app and the server) reject
  machine paths, em dashes, source maps and committed binaries.
- Keep a change to one concern. Change a public message, the room protocol or an MCP tool, and
  update every caller and the README in the same pull request.

## Send a pull request

You do not need write access to `wolfsdk/workspace`; work from your fork.

From your clone of the fork, start a branch **before** editing:

```sh
git fetch upstream
git switch -c fix-short-name upstream/main
# edit, test, run the gate
git add -p && git commit -m "workspace: say what changed"
git push -u origin fix-short-name
```

Open the pull request from your fork's branch against `wolfsdk/workspace` `main`. Say what
changed and why, how you checked it (the commands above, and what you saw in the browser), and
note anything you could not run, for example a browser check without network access to the
release channel. CI checks the code, builds the UI and runs the DOCX smoke against the released engine on GitHub-hosted Linux.

Stop both local servers with Ctrl+C. The temporary state directory printed at startup contains the tokens and any documents you created; remove that specific directory when you no longer need it.
