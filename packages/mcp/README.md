# @wolfsdk/mcp

The compact MCP server of Wolf Workspace. It gives a model eight tools (`wolfsdk.mcp-workspace.v1`) over one room of
[`@wolfsdk/server`](../server), on Streamable HTTP or stdio. The model works in the room as an agent: people see what it
is doing, and what it proposes waits for a person to approve it.

| Tool                 | What it does                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `workspace_list`     | Documents, open proposals, comment threads, the people and agents in the room, and packs.         |
| `doc_read`           | One document as `structure`, `text`, `markdown` or `cells`, with its `revision`.                  |
| `doc_search`         | Literal or regular-expression search across the room's documents, with addresses and snippets.    |
| `doc_create`         | A new document, blank or copied from a template of the same format, with optional first ops.      |
| `doc_edit`           | A batch of ops against a `base_revision`, as a `propose` (a person reviews it) or a `commit`.     |
| `doc_inspect_visual` | Pages as PNG images (or a preflight of their sizes) when the server has a renderer.               |
| `pack_link_refresh`  | Recalculate a pack and rewrite its linked targets when the server has a pack refresher.           |
| `comment_reply`      | Reply to a thread, optionally mentioning people or resolving it.                                  |

Every result is a text block of JSON plus the same object as `structuredContent`. A failure is a normal result with
`isError: true` and `{ "error": { "code", "message", "detail" } }`, never a JSON-RPC error, so the model can read it and
act: after `REVISION_MISMATCH` the `detail` carries the head to rebase on.

## Serve it

```ts
import { RoomServer } from "@wolfsdk/server";
import { McpServer, engineInspector, engineRenderer, startMcpHttpServer } from "@wolfsdk/mcp";

const mcp = new McpServer({
  service: roomService, // a RoomService of @wolfsdk/server
  roomId: "room",
  actor: { id: "robot", name: "Robot", kind: "agent" },
  inspector: engineInspector(pool), // optional: engine-backed reads; the built-in readers answer what it declines
  renderer: engineRenderer(pool), // optional: enables doc_inspect_visual
});

const running = startMcpHttpServer({ server: mcp }); // http://127.0.0.1:<port>/mcp
```

- `createMcpHttpHandler({ server })` is a plain `(Request) => Response`, for any fetch host.
- `runMcpStdioServer({ server, input, output })` speaks newline-delimited JSON-RPC, for clients that spawn the server.
- `POST /mcp` takes a JSON-RPC message or batch (JSON or SSE answer, by `Accept`). `initialize` opens a session and its
  answer carries `Mcp-Session-Id`. `GET /mcp` is the session's stream of room events as `notifications/message`, each
  frame's `id` is the room `seq`, and `Last-Event-ID` resumes after the last one seen. `DELETE /mcp` ends the session.
- The agent shows up in the room as it works (`reading`, `searching`, `inspecting`, `proposing`, `committing`,
  `replying`, then `idle`); `@wolfsdk/review` renders that as a presence bar.
- Every tool call and the event stream need a seat of the licence. An agent that loses its seat is sent one last
  `notifications/message` whose `data` is an `error` event with `LICENSE_LIMIT`. Over HTTP the stream then closes:
  `GET /mcp` again to take a seat and resume. Over stdio the events follow again after the agent's next line.

## Trust

- The server acts as one agent actor. An agent can never approve or reject a proposal: that is the room's rule
  (`FORBIDDEN`), and nothing here weakens it.
- The HTTP handler checks `Origin` (loopback pages only by default; a request with no `Origin` passes), caps bodies
  and sessions, and drops idle sessions. Without `authenticate` every caller is the server's own agent, so bind it to
  loopback or put authentication in front of it. With `authenticate`, each session acts as the agent it returns.
- Documents are parsed by built-in, dependency-free readers (`docx`, `xlsx`, `pptx`, `pdf`) with hard limits on size,
  inflated bytes and nesting; nothing in a document is ever executed.

## Plug in

Three optional hooks, all in `src/hooks.ts`:

- `WorkspaceDocInspector.read` reads a document better than the built-in reader (it returns `undefined` to decline).
- `VisualRenderer.inspect` draws pages; without it `doc_inspect_visual` answers `BAD_REQUEST`.
- `PackRefresher` lists and refreshes packs; without it `pack_link_refresh` answers `BAD_REQUEST`.

`engineInspector(pool)` and `engineRenderer(pool)` build the first two from a `WorkerPool` of `@wolfsdk/server`.

## Develop

```sh
bun test packages/mcp
node_modules/.bin/tsc -p packages/mcp --noEmit
```

The tests drive the whole server over its real transports against a real `RoomServer` and a small in-memory engine.
