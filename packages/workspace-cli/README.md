# @wolfsdk/workspace

The `wolfsdk-workspace` command line of Wolf Workspace: check and refresh a pack, serve the
workspace (browser UI, API, room WebSocket and MCP endpoint) on one port, add the people and
agents who may use it, list or free its seats, and back it up to an S3-compatible bucket and
restore it. Apache-2.0. Depends on `@wolfsdk/mcp`, `@wolfsdk/packs`, `@wolfsdk/protocol` and
`@wolfsdk/server`.

The package is TypeScript source and runs under [Bun](https://bun.sh) 1.4 or later; its `bin` is
`wolfsdk-workspace`, and the published package carries the compiled browser UI. `serve` needs the
Wolf engine, which is a separate download under its own licence:

```sh
curl -fsSL https://wolfsdk.com/install | sh        # installs `wolf` into ~/.local/bin
bunx @wolfsdk/workspace check   ./quarterly-pack
bunx @wolfsdk/workspace refresh ./quarterly-pack --json
bunx @wolfsdk/workspace serve --db rooms.sqlite --blobs blobs \
  --engine ~/.local/bin/wolf --actors actors.json
bunx @wolfsdk/workspace actors add user alice --name Alice --actors actors.json
bunx @wolfsdk/workspace actors add agent robot --name Robot --operator alice --actors actors.json
bunx @wolfsdk/workspace seats --db rooms.sqlite
bunx @wolfsdk/workspace seats release user alice --db rooms.sqlite
bunx @wolfsdk/workspace backup --db rooms.sqlite --blobs blobs --keep 7 --dir /mnt/backups/rooms
bunx @wolfsdk/workspace restore --db new/rooms.sqlite --blobs new/blobs --dir /mnt/backups/rooms
```

From a checkout of this repository, the same commands are `bun packages/workspace-cli/src/cli.ts ...`.

## check and refresh

`check <pack dir>` reads the manifest, every source and every target document and reports
which bindings are stale. It writes nothing. `refresh <pack dir>` brings the target documents
up to date, all or none (see `@wolfsdk/packs` for what a refresh guarantees). The directory
defaults to the current one.

|Exit code|Meaning|
|---|---|
|0|`check`: every binding is fresh. `refresh`: done (possibly nothing to do). `serve`: stopped on SIGINT or SIGTERM.|
|1|`check` only: at least one binding is stale.|
|2|Usage error, a pack that cannot be read or is refused, an engine that cannot be started or failed.|

`--json` prints one JSON document on standard output: the report (`pack_id`, `fresh`,
`bindings`, `documents`), or `{ "error": { "code", "message", "problems" } }` with exit code
2. Without it the report is a table on standard output and an error is one line on standard
error, followed by one line per refused binding.

`--engine <wolf>` starts `<wolf> reactor-serve` workers. `check` and `refresh` use them to
recalculate XLSX sources under their determinism and `refresh` has them apply the edits.
Without it the package reads the cached values of an XLSX source and applies the edits
itself.

## serve

`serve` runs the whole workspace on one port (default `127.0.0.1:8787`; `--port 0` picks a
free port) and prints `listening ws://<host>:<port>/ws`, then the UI and MCP addresses, once
it is up. `--engine` is required: the room server opens every document through the engine,
and its entitlement decides the limits of the workspace. `--pool <n>` sets the number of
workers (default 2). The rooms, the MCP tools (`doc_read` text and markdown views,
`doc_inspect_visual` pages) and a linked pack share that one pool.

|Route|What answers|
|---|---|
|`GET /`, any app route, `/assets/*`|The compiled workspace UI (`--static-dir`; by default the UI packed with the package, else `apps/workspace/dist` of a checkout when built). A path that would leave the directory is a 404.|
|`WS /ws`|`wolfsdk.room.v1`: `room.join`, `doc.edit`, `proposal.decide`, `comment.post`. The same contract and order guarantees as `startWsServer` of `@wolfsdk/server`. The same connection carries `wolfsdk.assistant.v1` (`assistant.status`, `assistant.ask`, `assistant.cancel`, `assistant.history`): see [The assistant](#the-assistant).|
|`POST`, `GET`, `DELETE /mcp`|MCP over Streamable HTTP, for agents only. The room is `?room=<id>` or `X-Wolf-Room`, else `--default-room`, else the only room.|
|`GET /api/health`|`{ "ok": true }`, without a token.|
|`GET /api/me`|`{ "actor": ..., "guest": null }` of the token (`"guest": { "docs": [{ "room_id", "doc_name" }] }` for a guest), and `"readOnly": { "reason", "upgrade" }` beside it when the workspace is read-only.|
|`GET`, `POST /api/rooms`|`{ "rooms": [...] }`; `POST { "room_id", "workspace_id"? }` creates a room (201).|
|`GET /api/rooms/<room>`|The full room state.|
|`POST /api/rooms/<room>/docs`|Add a document: the raw bytes with `?name=<file>` (and `?format=` when the extension does not say it), or `multipart/form-data` with a `file` field.|
|`GET /api/rooms/<room>/docs/<doc>/head`|The head bytes, with `ETag: "sha256:<hex>"`, `X-Wolf-Revision` and `X-Wolf-Sha256`. `If-None-Match` answers 304.|
|`GET /api/rooms/<room>/proposals/<id>/preview`|The preview bytes of a proposal, with `X-Wolf-Sha256`.|
|`GET`, `PUT`, `DELETE /api/rooms/<room>/docs/<doc>/share`|The share link of a document, for a member who is a user: `200 { "share": { token, path, room_id, doc_name, created_at, created_by } \| null }`, `PUT` makes the link or answers the live one, `DELETE` ends it (204). An agent or a guest gets 403.|
|`GET /api/share/<token>`|No token needed. `200 { "share": { room_id, doc_name, format, revision, updated_at, shared_by, connect } }`, where `connect` is `<--share-connect>?share=<token>` or `null`; an unknown or ended token is `404 { "error": { "code": "SHARE_NOT_FOUND" } }`.|
|`GET /api/share/<token>/snapshot`|No token needed. The painted pages of the shared document at its head: the answer of `.../docs/<doc>/snapshot` (same ETag and 304), or the same 404.|
|`GET /api/export`|Every document of every room, at its head, as one ZIP archive (`application/zip`, `Content-Disposition: attachment`). See [Export](#export).|
|`GET /api/pack`, `POST /api/pack/refresh`|Check or refresh the pack of `--pack <dir>` on disk; `404 { "error": { "code": "NO_PACK" } }` without one.|
|`GET /wasm/*`|A local engine channel (`latest.txt`, `v<VERSION>/wolf_web.wasm`, fonts) from `--wasm-dir`, with CORS.|

An API failure is `{ "error": { "code", "message" } }` with the status of its code (`UNKNOWN_*`
404, `FORBIDDEN` 403, `REVISION_MISMATCH` and `PROPOSAL_NOT_OPEN` 409, `LICENSE_LIMIT` 402,
`ENGINE_FAILED` 503, otherwise 400). `--default-room <id>` creates that room at start, as the
first user of the actors file, in `--workspace-id` (default `default`) when it does not exist.
`--workspace-id` is also the workspace of a room created through the API without one.

To seat an agent harness, give it the MCP address and the agent's token. For Claude Code:

```json
{
  "mcpServers": {
    "wolf-workspace": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp?room=<room>",
      "headers": { "Authorization": "Bearer <agent token>" }
    }
  }
}
```

Name the server anything except `workspace`: Claude Code reserves that name and skips the entry
with a warning. The agent starts with `workspace_list`, which names the documents, the open
proposals, the packs, and every open comment thread with its `thread_id` and messages.

With `--pack <dir>`, the MCP tool `pack_link_refresh` refreshes that pack into the documents of
the agent's room: one proposal (or commit) per stale target document, never a write to the pack
directory. The manifest is read from the directory on every call. A source is read from the room
when the room holds a document of that name, and from the directory otherwise. `workspace_list`
names the pack and its bindings.

The same server is a library: `startWorkspaceServer({ service, authenticate, ... })`.

`--actors <file>` says who may connect: a JSON file that maps each bearer token to the actor
it stands for. [`actors add`](#actors) writes it; this is what it holds:

```json
{
  "token-for-alice": { "kind": "user", "id": "alice", "name": "Alice" },
  "token-for-the-agent": {
    "kind": "agent",
    "id": "robot",
    "name": "Robot",
    "operator": { "id": "alice", "name": "Alice" }
  }
}
```

An agent entry with `"operator"` acts on that user's seat rather than taking a seat of its own.

Any entry may also carry `"guest": { "docs": [{ "room": "<room id>", "doc": "<document name>" }] }`
(1 to 50 documents). That user or agent is a guest: it sees only those rooms, reads, comments
and proposes on those documents, takes no seat, and is refused committing, deciding a
proposal, creating a room, uploading, `/api/export`, `/api/pack*` and the assistant. An agent
entry with no `guest` whose operator is a guest user of the file has that user's documents.
With `--share-connect <path>`, the public page of a share link names `<path>?share=<token>` as
the place an agent finds how to connect.

A client sends the token as `Authorization: Bearer <token>`, or as the `token` query
parameter when it is a browser (a browser WebSocket cannot set a header). A request without a
known token is refused with 401; the server derives the actor from the token and trusts
nothing a client says about itself inside the socket. Bind to `127.0.0.1` or put the server
behind TLS: the token travels in the clear on plain `ws://` and `http://` connections. The UI
pages are served with `Referrer-Policy: no-referrer`, so a token in the address bar does not
leave the page.

When the actors file is not there, `serve` makes it, mode 600, with one user (`owner`, named
`Owner`), as the container does on its first start. It prints the token of that user before it
starts anything else, and once it listens the address to sign in at and the command that adds
the next person or agent:

```text
created actors.json with one user, owner; token <64 hex digits>
listening ws://127.0.0.1:8787/ws
workspace http://127.0.0.1:8787
mcp http://127.0.0.1:8787/mcp
Sign in at http://127.0.0.1:8787/?token=<64 hex digits>
Add people and agents with: wolfsdk-workspace actors add <user|agent> <id> --actors actors.json
```

A file that is there is never rewritten by `serve`, and the next start prints none of this.

The file is read again when it changes, so a host adds or removes a token without restarting
`serve`. Each time a request is authenticated (an HTTP request, a WebSocket upgrade, an MCP
request) or the operator of an agent is looked up, `serve` makes one `stat` of the file and
compares its inode, size and modification time with those of the last read; there is no timer
and no file watcher, and a file that did not change costs that one `stat`. A token added to the
file is accepted on the next request, and a token removed from it is refused (401) on the next
request. A file that is half written, is not JSON, fails the checks above, names no actor or is
gone does not replace anything: the last good directory stays in force, so nobody is locked out
by a bad edit, and one line goes to standard error saying why. The file is read again when it
changes once more. A writer should write a temporary file next to the actors file and rename it
over the actors file (the same directory, so the rename is atomic): `serve` then never sees a
half-written file, and the rename changes the inode even when the new file has the same size
and modification time. `actors add` writes it that way. A socket that is already open stays
under the actor it authenticated as until it closes: the token is checked when the socket is
opened, not on each message, so removing a token ends nothing that is connected. Its reconnect
is refused, and so is every HTTP and MCP request that carries the token. The first read, at
start, must succeed: `serve` exits 2 on an actors file that cannot be used.

One `serve` runs on one database: it holds `<db>.lock` while it runs, and a second `serve` on
the same `--db` exits 2 and names the lock. The lock is freed when the process ends. A `--db`
that is a symbolic link is the database it points at, also before that database exists. A
database file with a second hard link is refused under either name: remove the other link, or
serve a copy. A database file that is mounted on its own (a single-file bind mount into a
container) is refused too, because its lock and its write-ahead log would stay inside that
container: mount the folder that holds the database.

### A cap of a plan

`--plan-seats <n|unlimited>`, `--plan-workspaces <n|unlimited>` and `--plan-upgrade <text>` put a
plan under the limits of the engine licence, for a host that sells the server in tiers (the
control plane passes them for each customer). The three come together, and `--plan-name <name>`
(default `current`) says what the plan is called. The server admits the smaller of the licence
limit and the plan limit; `unlimited` is no limit of the plan, so the licence alone decides. A
refusal of the licence stays `LICENSE_LIMIT` with the message of the licence. A refusal that the
plan caused is also `LICENSE_LIMIT` on the wire, so a client that knows nothing of plans reads it
as the limit it is, and its message starts with a stable code and says three things: which limit
and its value, who or what would be one more, and what to do:

```text
plan-seat-limit: the free plan admits 1 seat; Bob would take one more. Move to Team for more seats.
plan-workspace-limit: the free plan serves 1 workspace; ws-two would be one more. Move to Team for more workspaces.
```

The cap is read at start. A seat held before a lower cap follows the rule of the licence: the
oldest seats keep working, the newest are freed and told so with one error. To change a cap,
restart `serve` with the new flags.

### Read-only mode

`--read-only-reason <text>` and `--read-only-upgrade <text>` turn the workspace read-only, for a
host whose customer may look but not change (a trial that has ended, for one). The two come
together, each is 1 to 300 characters and not blank, and either alone is a usage error. The
reason is the sentence that says why (`The trial ended on 2026-11-28.`) and the upgrade text is
the way forward (a URL or a sentence). In code the option is `readOnly: { reason, upgrade }` on
`RoomServer` and on `startWorkspaceServer`; the flags set both.

Every write is refused: creating a room, adding a document, `doc.edit` and its proposals,
`proposal.decide`, `comment.post`, activity reports, `POST /api/pack/refresh`, and the MCP write
tools (`doc_create`, `doc_edit`, `comment_reply`, `pack_link_refresh`). The room service makes the
refusal before any other check answers a write, and the HTTP and socket layers answer it before they parse a request.
The refusal is `LICENSE_LIMIT` on the wire (HTTP 402, an `error` event on the socket, an MCP
tool error), as a plan limit is, with the stable reason `workspace-read-only`; its message is
that code, the reason and the upgrade text, verbatim:

```text
workspace-read-only: The trial ended on 2026-11-28. https://cloud.example.test/upgrade
```

What keeps working: `GET /api/me`, `GET /api/health`, listing and reading rooms and documents,
snapshots, proposal previews, downloading a document, `GET /api/export`, joining a room over the
socket (reading takes a seat, and the plan cap still applies) and the MCP read tools.
`GET /api/me` reports the mode as `"readOnly": { "reason", "upgrade" }` beside `actor`, and
leaves the key out when the workspace is not read-only, so an app can show a banner from its
first request. The rooms `--default-room` creates at start are not a client write and are put in
place first. The mode is read at start; to change it, restart `serve` with the new flags.

### The assistant

`--assistant-url <url>` and `--assistant-model <name>` give the workspace an assistant: a model
that a user asks from the panel of the browser workspace, over the room WebSocket
(`wolfsdk.assistant.v1`). The URL is the chat-completions endpoint of an OpenAI-compatible
service (it ends in `/chat/completions`), the two flags come together, and the key of the
endpoint is read from `WOLFSDK_ASSISTANT_API_KEY`, never from a flag. An endpoint that asks for
no key still needs the variable set, to any value. The key is sent to the endpoint only: no
event, log line or stored turn holds it.

```sh
export WOLFSDK_ASSISTANT_API_KEY=<key of the endpoint>
wolfsdk-workspace serve --db rooms.sqlite --blobs blobs --engine wolf --actors actors.json \
  --assistant-url https://models.example.test/v1/chat/completions --assistant-model open-model-1 \
  --assistant-allowance 200
```

In the container of `compose.yaml` the flags come from the environment of the host that runs
`docker compose up`: `WOLFSDK_ASSISTANT_URL`, `WOLFSDK_ASSISTANT_MODEL` and
`WOLFSDK_ASSISTANT_ALLOWANCE` become `--assistant-url`, `--assistant-model` and
`--assistant-allowance` when they are set, and `WOLFSDK_ASSISTANT_API_KEY` is passed into the
container by name, so its value is in neither the compose file nor the image. With none of them
set the container starts without an assistant, as it did before.

```sh
export WOLFSDK_ASSISTANT_API_KEY=<key of the endpoint>
WOLFSDK_ASSISTANT_URL=https://models.example.test/v1/chat/completions \
WOLFSDK_ASSISTANT_MODEL=open-model-1 WOLFSDK_ASSISTANT_ALLOWANCE=200 docker compose up -d
```

A task is one question of one user in one room. The assistant answers it as an agent that works
for that user (`Assistant (<name>)`), on that user's seat, through the tools of the room's MCP
server: the same reads and the same edits an agent on `/mcp` has. What it writes is a proposal,
whatever mode the model asked for, and only a user approves a proposal. A user has one running
task in a room at a time (a second ask is `BUSY`) and may cancel it; the task runs beside the
connection, so editing, deciding and commenting go on while it works. An agent that asks is
refused (`FORBIDDEN`), and in a read-only workspace the write tools refuse as they do on `/mcp`.

`--assistant-allowance <n>` is the number of tasks one seat may start in a calendar month (UTC).
A task counts when it makes its first model call. At the limit the assistant refuses a new task
with `ALLOWANCE_EXHAUSTED` and reports `allowance_exhausted` as its status, both with the limit,
the count and the instant the month ends; everything else on the connection works as before.
Without the flag the server does not meter.

Every task is kept in a SQLite file of its own, `--assistant-db <file>` (default: beside `--db`,
`rooms.assistant.sqlite` for `rooms.sqlite`): the turns of each conversation, and for each
finished task its prompt, cached and completion tokens, so the usage of a workspace in a month
can be read per seat (`AssistantService.usage` of `@wolfsdk/server`). `backup` copies this file
into the same backup set as the rooms (see [backup and restore](#backup-and-restore)). Without
the assistant flags the server answers `assistant.status` with
`not_configured`, refuses an ask with `NOT_CONFIGURED`, and writes no file. In code the option is
`assistant: { endpoint, allowance, storePath }` on `startWorkspaceServer`; give the room server
the `operatorOf` of the returned `assistant`, as `serve` does.

### Export

`GET /api/export` downloads the whole workspace as one ZIP archive: the head of every document of
every room. Whoever can sign in and read the workspace can export it, and it keeps working in
read-only mode, since it writes nothing. Reading the rooms takes a seat like
`GET /api/rooms/<room>`, so an actor the licence or a plan cap does not seat gets that refusal as
an ordinary error response (`LICENSE_LIMIT`, 402), before the first byte of an archive. Any method
but `GET` is a 405.

The layout is `<room id>/<document name>` for each document, with `manifest.json` at the root,
last. The manifest is `{ "format": "wolfsdk.workspace.export.v1", "exported_at", "rooms": [...] }`
and lists, per room (`room_id`, `workspace_id`) and per document: `name`, `path` in the archive,
`format`, `revision`, `sha256`, `size` and `updated_at`. The `sha256` and `size` are those of the
bytes in the archive, which are the head as the archive read it, not as the room had it when the
export began. A room or document name that is not a safe file name is made one, and two that
collide are told apart with a suffix; the manifest `path` is always the truth.

The archive is streamed, one document in memory at a time, and every entry is stored, not
compressed (the documents are ZIP containers already). Sizes past 4 GiB use ZIP64. The central
directory comes after the last entry, so a download that ended early, because a document could
not be read after the archive began, is not a ZIP archive at all and cannot pass for a complete
one: check that the file opens before trusting it.

## actors

`actors add <user|agent> <id> --actors <file>` adds a person (`user`) or an agent to the actors
file of `serve` under a new token, 32 random bytes as 64 hex digits, and prints that token this
once: the file holds it, and no command shows it again. `--name <text>` is the name others see
(default: the id). `--operator <user id>` puts an agent on the seat of that user, who must be a
user of the file; the entry carries the user's id and name. An agent without one takes a seat of
its own, and a user has no operator.

```sh
$ wolfsdk-workspace actors add user alice --name Alice --actors actors.json
added to actors.json: user alice (Alice)
sign in at <workspace address>/?token=<64 hex digits>
This is the only time the token is printed.
$ wolfsdk-workspace actors add agent robot --name Robot --operator alice --actors actors.json
added to actors.json: agent robot (Robot), on the seat of user alice
token <64 hex digits>; the agent sends it as "Authorization: Bearer <token>" to <workspace address>/mcp
This is the only time the token is printed.
```

A file that is not there is made, mode 600; one that is there is written whole to a temporary
file beside it, mode 600, and renamed over it, so a running `serve` sees the old file or the new
one and accepts the token from its next request, without a restart. A file reached through a
symbolic link is replaced where it is, and the link stays. Run as root on the file of another
user (`docker exec` as root, say), the file stays that user's. An id the file already has for the
same kind is refused (a user and an agent may share an id), and so are an operator that is not a
user of the file and a file that `serve` would refuse: each exits 2 and leaves the file as it
was. `--json` prints `{ "added": { "kind", "id", "name", "operator" }, "token", "actors",
"created" }`. Two `actors add` at the same instant on one file can lose one of the two entries;
run them one after the other.

In the container, run it as the image's user against the file in the data volume:

```sh
docker compose exec workspace bun run /app/packages/workspace-cli/src/cli.ts \
  actors add user alice --name Alice --actors /data/actors.json
```

## seats

`seats --db <file>` lists the identities that hold a seat of the licence, oldest first.
`seats release <user|agent> <id> --db <file>` frees the seat of one, and exits 2 when that
identity holds none. A `--db` that does not exist or is not a room database is an error and
is left untouched. Both work on the database of a running
`serve`. An identity whose seat was freed stops receiving the events of its room and is sent
one `LICENSE_LIMIT` error; its next request takes a seat again if one is left. Releasing the
seat of a user also ends the streams of the agents that user operates.

## backup and restore

`backup` takes a consistent snapshot of the database of a workspace (the `serve` that owns it
may be running), uploads the blobs the store does not hold, then uploads the snapshot, last,
and keeps the newest `--keep <n>` snapshots. A blob leaves the store only when no kept
snapshot names it. Nothing is uploaded when a blob the snapshot names is missing from
`--blobs`: the command exits 2 and says which. `restore` rebuilds a workspace from the store
into an empty place, the newest snapshot or the one named by `--snapshot <id>`: it checks the
database and every blob before it moves anything into place, so a failed restore leaves the
target as it was. `restore --list` prints the snapshot ids of the store, oldest first, and
restores nothing. Both exit 0 on success and 2 on an error; `--json` prints the report (or
`{ "error": { "code", "message" } }`) as one JSON document.

The database of the assistant is part of the same backup set: its stored turns, and the tasks
the allowance of a seat is counted from. `backup` copies it from `--assistant-db <file>`
(default: beside `--db`, where `serve` keeps it) with one read transaction, so a task that
finishes while the backup runs is in the copy whole or not at all, and uploads it as
`snapshots/<id>.assistant-<sha256>.sqlite` before the snapshot of the rooms. A pruned snapshot
takes its assistant database with it. `restore` puts it back at `--assistant-db` (default:
beside the new `--db`), checked against its SHA-256 and by SQLite, and moves it into place just
before the room database; a target that already holds an assistant database is refused like a
target that holds a workspace. A workspace that never had an assistant has no such file: its
backup set is what it always was, and a set without an assistant database restores without one.
The reports say `assistant database:` in text and carry `"assistant"` in JSON only when there is
one.

The store is a bucket of an S3-compatible service, or a directory with `--dir <dir>`, which
replaces the three `--s3-*` flags. `--prefix <key prefix>` keeps several workspaces apart in
one bucket or directory (the same prefix goes to `restore`); `--scratch <dir>` is where a
backup writes its temporary copies of the databases (default: the system temporary directory).

Backblaze B2:

```sh
export S3_ACCESS_KEY_ID=<application key id>
export S3_SECRET_ACCESS_KEY=<application key>
bunx @wolfsdk/workspace backup --db rooms.sqlite --blobs blobs --keep 7 \
  --s3-bucket <bucket> --s3-endpoint https://s3.<region>.backblazeb2.com --s3-region <region>
bunx @wolfsdk/workspace restore --list \
  --s3-bucket <bucket> --s3-endpoint https://s3.<region>.backblazeb2.com --s3-region <region>
bunx @wolfsdk/workspace restore --db <new rooms.sqlite> --blobs <new blob dir> [--snapshot <id>] \
  --s3-bucket <bucket> --s3-endpoint https://s3.<region>.backblazeb2.com --s3-region <region>
```

Cloudflare R2: `--s3-endpoint https://<account id>.r2.cloudflarestorage.com` and no
`--s3-region` (the region defaults to `auto`); the rest is the same.

The credentials of a bucket come from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (with
`S3_SESSION_TOKEN` when the keys are temporary), or from the `AWS_` names of the same three
when those are not set, and from nowhere else: a flag would end up in the shell history and
in the process list. The key needs `PutObject`, `GetObject`, `ListBucket` and `DeleteObject`
on the bucket (or the prefix) and nothing more.

## Tests

```sh
bun test            # from this directory
```

The CLI tests build their packs in memory with the fixtures of `@wolfsdk/packs`' tests.
`test/http.test.ts` drives the unified port end to end (UI, API, `/ws`, `/mcp`, pack and
`/wasm`) over a real room server with the in-memory engine of the MCP tests.
`test/assistant.test.ts` asks the assistant over `/ws` with a model that answers from a script
in process: no model is called and no key leaves the test. `test/actors-command.test.ts` covers
`actors add` and the first start of `serve` without an actors file. The `serve`
process itself is tested up to the authentication of a request; opening documents through
it needs the engine executable, which is not part of this workspace.
