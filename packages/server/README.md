# @wolfsdk/server

The room server of Wolf Workspace. A room holds DOCX, XLSX and PPTX documents that people and agents work on
together: an edit is a batch of ops against a `base_revision`, an agent's batch waits as a proposal until a person
approves it, and every change is an entry in an append-only log.

- **Rooms and proposals.** `RoomServer` implements `RoomService`: create a room, add documents, read a head or a
  proposal's preview, edit, approve or reject, comment, and join the room's event stream with `since_seq` resume.
- **Storage.** One SQLite file for the log and the room state, and a content-addressed directory for document bytes.
- **Engine.** Documents are opened, edited and saved by the `wolf` executable, started as `wolf reactor-serve`
  workers in a `WorkerPool`. This package contains no format logic and no engine binary.
- **Seats.** The engine reads the licence. Without a `WOLF_LICENSE_KEY` it grants the Community Self-Host terms:
  one workspace and up to five seats.
- **Assistant.** `AssistantService` answers `wolfsdk.assistant.v1` on the room WebSocket (the `assistant` option of
  `startWsServer`): a user asks, a model works through tools you supply as an agent on that user's seat, and each
  task is stored with its tokens and counted against an optional monthly allowance per seat.
  [`@wolfsdk/workspace`](../workspace-cli) wires it to the MCP tools and to `serve`.

It runs on [Bun](https://bun.sh) 1.4 or later and ships TypeScript source.

```sh
bun add @wolfsdk/server
```

```ts
import { PoolEngine, RoomServer, WorkerPool, startWsServer } from "@wolfsdk/server";

const pool = new WorkerPool({ command: ["wolf", "reactor-serve"], size: 2 });
const rooms = new RoomServer({ dbPath: "rooms.sqlite", blobDir: "blobs", engine: new PoolEngine(pool) });

const alice = { kind: "user", id: "alice", name: "Alice" } as const;
await rooms.createRoom(alice, { room_id: "board-pack", workspace_id: "default" });

// The room WebSocket (wolfsdk.room.v1): snapshots, events and client messages.
const ws = startWsServer({ service: rooms, authenticate: () => alice, port: 8787 });
```

Every method returns `{ ok: true, value }` or `{ ok: false, error: { code, message, detail } }`; a refusal is a
value, never an exception. `authorize` in the options decides who may do what in a room.

To serve the browser UI, the HTTP API and the MCP endpoint beside the WebSocket, use
[`@wolfsdk/workspace`](../workspace-cli). To give a model tools over a room, use [`@wolfsdk/mcp`](../mcp).

## Get the engine

```sh
curl -fsSL https://wolfsdk.com/install | sh
```

The engine is closed source and is not part of this package. The installer prints where it put the binary and
its licence.

## Licence

Apache-2.0.
