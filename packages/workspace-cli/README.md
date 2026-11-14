# @wolfsdk/workspace

The `wolfsdk-workspace` command line of Wolf Workspace: check and refresh a pack, serve the
workspace (browser UI, API, room WebSocket and MCP endpoint) on one port, and list or free its
seats. Apache-2.0. Private until it is published on purpose. Depends on `@wolfsdk/mcp`,
`@wolfsdk/packs`, `@wolfsdk/protocol` and `@wolfsdk/server`.

```sh
bun packages/workspace-cli/src/cli.ts check   ./quarterly-pack
bun packages/workspace-cli/src/cli.ts refresh ./quarterly-pack --json
bun packages/workspace-cli/src/cli.ts serve --db rooms.sqlite --blobs blobs \
  --engine /path/to/wolf --actors actors.json
bun packages/workspace-cli/src/cli.ts seats --db rooms.sqlite
bun packages/workspace-cli/src/cli.ts seats release user alice --db rooms.sqlite
```

The package's `bin` is `wolfsdk-workspace` and runs under Bun.

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
|`GET /`, any app route, `/assets/*`|The compiled workspace UI (`--static-dir`, default `apps/workspace/dist` of this checkout when built). A path that would leave the directory is a 404.|
|`WS /ws`|`wolfsdk.room.v1`: `room.join`, `doc.edit`, `proposal.decide`, `comment.post`. The same contract and order guarantees as `startWsServer` of `@wolfsdk/server`.|
|`POST`, `GET`, `DELETE /mcp`|MCP over Streamable HTTP, for agents only. The room is `?room=<id>` or `X-Wolf-Room`, else `--default-room`, else the only room.|
|`GET /api/health`|`{ "ok": true }`, without a token.|
|`GET /api/me`|`{ "actor": ... }` of the token.|
|`GET`, `POST /api/rooms`|`{ "rooms": [...] }`; `POST { "room_id", "workspace_id"? }` creates a room (201).|
|`GET /api/rooms/<room>`|The full room state.|
|`POST /api/rooms/<room>/docs`|Add a document: the raw bytes with `?name=<file>` (and `?format=` when the extension does not say it), or `multipart/form-data` with a `file` field.|
|`GET /api/rooms/<room>/docs/<doc>/head`|The head bytes, with `ETag: "sha256:<hex>"`, `X-Wolf-Revision` and `X-Wolf-Sha256`. `If-None-Match` answers 304.|
|`GET /api/rooms/<room>/proposals/<id>/preview`|The preview bytes of a proposal, with `X-Wolf-Sha256`.|
|`GET /api/pack`, `POST /api/pack/refresh`|Check or refresh the pack of `--pack <dir>`; `404 { "error": { "code": "NO_PACK" } }` without one.|
|`GET /wasm/*`|A local engine channel (`latest.txt`, `v<VERSION>/wolf_web.wasm`, fonts) from `--wasm-dir`, with CORS.|

An API failure is `{ "error": { "code", "message" } }` with the status of its code (`UNKNOWN_*`
404, `FORBIDDEN` 403, `REVISION_MISMATCH` and `PROPOSAL_NOT_OPEN` 409, `LICENSE_LIMIT` 402,
`ENGINE_FAILED` 503, otherwise 400). `--default-room <id>` creates that room at start, as the
first user of the actors file, in `--workspace-id` (default `default`) when it does not exist.
`--workspace-id` is also the workspace of a room created through the API without one.

The same server is a library: `startWorkspaceServer({ service, authenticate, ... })`.

`--actors <file>` says who may connect: a JSON file that maps each bearer token to the actor
it stands for.

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
A client sends the token as `Authorization: Bearer <token>`, or as the `token` query
parameter when it is a browser (a browser WebSocket cannot set a header). A request without a
known token is refused with 401; the server derives the actor from the token and trusts
nothing a client says about itself inside the socket. Bind to `127.0.0.1` or put the server
behind TLS: the token travels in the clear on plain `ws://` and `http://` connections. The UI
pages are served with `Referrer-Policy: no-referrer`, so a token in the address bar does not
leave the page.

One `serve` runs on one database: it holds `<db>.lock` while it runs, and a second `serve` on
the same `--db` exits 2 and names the lock. The lock is freed when the process ends. A `--db`
that is a symbolic link is the database it points at, also before that database exists. A
database file with a second hard link is refused under either name: remove the other link, or
serve a copy. A database file that is mounted on its own (a single-file bind mount into a
container) is refused too, because its lock and its write-ahead log would stay inside that
container: mount the folder that holds the database.

## seats

`seats --db <file>` lists the identities that hold a seat of the licence, oldest first.
`seats release <user|agent> <id> --db <file>` frees the seat of one, and exits 2 when that
identity holds none. A `--db` that does not exist or is not a room database is an error and
is left untouched. Both work on the database of a running
`serve`. An identity whose seat was freed stops receiving the events of its room and is sent
one `LICENSE_LIMIT` error; its next request takes a seat again if one is left. Releasing the
seat of a user also ends the streams of the agents that user operates.

## Tests

```sh
bun test            # from this directory
```

The CLI tests build their packs in memory with the fixtures of `@wolfsdk/packs`' tests.
`test/http.test.ts` drives the unified port end to end (UI, API, `/ws`, `/mcp`, pack and
`/wasm`) over a real room server with the in-memory engine of the MCP tests. The `serve`
process itself is tested up to the authentication of a request; opening documents through
it needs the engine executable, which is not part of this workspace.
