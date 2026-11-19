// The one port of `wolfsdk-workspace serve`: the browser workspace, its JSON and binary API, the room
// WebSocket, the MCP endpoint and, optionally, a local engine channel, all behind one `Bun.serve`.
//
//   WS      /ws                 `wolfsdk.room.v1`, the same contract and the same order guarantees as
//                               `startWsServer` of `@wolfsdk/server`, and `wolfsdk.assistant.v1` on the same
//                               connection: the assistant of the workspace, which works through the tools of
//                               the room's MCP server.
//   GET     /mcp, POST, DELETE  MCP over Streamable HTTP (`createMcpHttpHandler` of `@wolfsdk/mcp`), one MCP
//                               server per room, named by `?room=` or `X-Wolf-Room`.
//   *       /api/...            rooms, documents, heads, snapshots, previews, the linked pack and, at `GET /api/export`,
//                               every document of one workspace as one ZIP archive (see `export.ts`).
//   GET     /api/share/<token>  the share link of one document: what it is, and (at `/snapshot`) its painted pages,
//                               for anyone who holds the link, with no token.
//   GET     /wasm/...           a local engine channel (`latest.txt`, `v<VERSION>/...`), when `wasmDir` is set.
//   GET     everything else     the compiled workspace UI, with the single-page fallback to `index.html`.
//
// Every route but `/api/health`, `/api/share/<token>`, `/wasm/...` and the UI needs a bearer token: `Authorization:
// Bearer <token>`, or the `token` query parameter for a browser WebSocket, which cannot set a header. The server
// derives the actor from the token alone and trusts nothing a client says about itself. An actor that `scopeOf`
// limits to some documents (a guest) sees only those rooms and may not create, upload, export, use the pack or the
// assistant.
import { stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { createMcpHttpHandler, McpServer, type McpHttpHandler, WorkspaceTools, type WorkspaceToolsOptions } from "@wolfsdk/mcp";
import { checkPack, DirectoryStore, loadPack, PackError, type PackReader, planPack, refreshPack, type XlsxEvaluator } from "@wolfsdk/packs";
import {
  isAssistantMessage,
  type RoomActor,
  type RoomClientMessage,
  type RoomHead,
  type RoomServerEvent,
  ROOM_REVISION_MISMATCH,
  validateRoomClientMessage,
  validateRoomEvent,
  type WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";
import {
  type AccessScope,
  type AssistantConnection,
  assistantConnection,
  AssistantService,
  type AssistantServiceOptions,
  type DocumentEngine,
  EngineFault,
  EngineRefusal,
  readOnlyFailure,
  type ReadOnlyMode,
  type Result,
  type RoomFailure,
  type RoomService,
  type RoomSubscription,
  scopedService,
  type ScopeOf,
  type ShareLink,
  type ShareLinks,
} from "@wolfsdk/server";
import workspacePackage from "../package.json" with { type: "json" };
import { type PlanReadOnly, planReadOnlyMode } from "./errors.ts";
import { type ExportRefusal, exportResponse, planExport } from "./export.ts";
import { directoryPackManifests, directoryPackRefresher } from "./pack-refresher.ts";

export type Authenticate = (request: Request) => RoomActor | null | Promise<RoomActor | null>;

export type WorkspacePackOptions = {
  /** The pack directory (`pack.wolf.json` and its documents). */
  dir: string;
  /** Recalculates XLSX sources; without it the cached values are read. */
  evaluator?: XlsxEvaluator;
  /** Applies the edits of a refresh; without it the package applies them itself. */
  engine?: DocumentEngine;
};

/** The document a snapshot is made of: the head of one document of a room. */
export type SnapshotInput = { format: WorkspaceDocFormat; name: string; bytes: Uint8Array };

/** The model endpoint, the allowance and the store of the assistant: see `AssistantServiceOptions`. */
export type WorkspaceAssistantOptions = Omit<AssistantServiceOptions, "rooms" | "tools">;

export type WorkspaceServerOptions = {
  service: RoomService;
  /** Who is calling, from the request: `null` refuses it with 401. */
  authenticate: Authenticate;
  /** Default 0: any free port. */
  port?: number;
  /** Default `127.0.0.1`. */
  hostname?: string;
  /** The compiled workspace UI (`apps/workspace/dist`). Without it the UI routes answer 404. */
  staticDir?: string | null;
  /** A local engine channel served at `/wasm/` with CORS, for `<wolf-review engine-channel>`. */
  wasmDir?: string | null;
  /** The `display_list` response of each page of a document, in page order: what `GET /api/rooms/<room>/docs/<doc>/snapshot`
   * serves a shared link, which paints the pages without loading an engine. Without it that route answers 501. */
  snapshot?: (input: SnapshotInput) => Promise<unknown[]>;
  /** The engine hooks of the MCP tools (`inspector`, `renderer`, `packs`). The MCP endpoint is always on. */
  mcp?: Omit<WorkspaceToolsOptions, "service" | "roomId" | "readOnly">;
  /** The pack `GET /api/pack` checks against the heads of a room (`?room=`, else `defaultRoom`, else the only room;
   * on disk while there is no room) and `POST /api/pack/refresh` refreshes on disk, and the pack the MCP tool
   * `pack_link_refresh` refreshes into the documents of a room unless `mcp.packs` says otherwise. Its manifest is
   * also the `packManifests` of the MCP tools, so `workspace_list` describes each binding, unless `mcp.packs` or
   * `mcp.packManifests` says otherwise. */
  pack?: WorkspacePackOptions | null;
  /** The room `/mcp` attaches to when the request names none. */
  defaultRoom?: string | null;
  /** The workspace of a room created without one, and the workspace `GET /api/export` exports when the request names
   * none. Default: the workspace of the first room (for an export, the one workspace of the rooms), else `default`. */
  workspaceId?: string | null;
  /** The workspace is read-only: the room service refuses every write (give `RoomServer` the same value), and this
   * server answers a write with that refusal before it parses the request, tells the MCP write tools, and reports
   * the mode as `readOnly` on `GET /api/me` so a client can say why and where to go. Reads, the export and joining
   * a room keep working. */
  readOnly?: ReadOnlyMode;
  /** The read-only mark of the customer's plan record now, or `null` while the workspace is read-write. It is asked at
   * every write (creating a room, adding a document, a pack refresh, a write on a room's socket, an MCP write tool,
   * the assistant's included) and at every `GET /api/me`. While it returns a mark, every write is refused as `readOnly`
   * refuses it, in the words of `planReadOnlyMode`: the reason on the record and the page to pay on. Once it returns
   * `null` (the customer paid), writes are served again at once: no restart, and the sockets and MCP sessions stay
   * open. Give `RoomServer` no `readOnly` with it, since the room service keeps its mode for its life. A mark that is
   * not one (see `planReadOnlyMode`) fails the write. `readOnly`, when given as well, comes first. */
  planReadOnly?: () => PlanReadOnly | null;
  /** The assistant of the workspace. Without it the assistant is not configured: it says so to a client that
   * asks for its status, refuses a task, and keeps nothing. */
  assistant?: WorkspaceAssistantOptions | null;
  /** What an actor may reach when it is not a member: its documents and its access, or `null` for a member. The
   * room `service` applies the same limits to what it serves, so give it `scopedService(rooms, scopeOf)`; this
   * server uses `scopeOf` for what the service does not decide: which rooms a list shows, and the routes a guest
   * may not use at all. Without it every actor is a member. */
  scopeOf?: ScopeOf;
  /** The share links of the workspace: with them the member routes `.../docs/<doc>/share` and the public routes
   * `GET /api/share/<token>` work, and without them those routes answer 404. The identity of the viewer of a link,
   * `SHARE_VIEWER`, must take no seat: have the room server's `seatless` say so. */
  shares?: ShareLinks;
  /** The path of the instructions an agent follows to connect to a shared document, such as
   * `/-/connect/instructions`, which the public metadata of a link offers as `connect`. Must start with `/`. */
  shareConnect?: string | null;
};

export type WorkspaceServer = {
  port: number;
  /** `http://host:port` */
  url: string;
  /** `ws://host:port/ws` */
  wsUrl: string;
  /** `http://host:port/mcp` */
  mcpUrl: string;
  /** The assistant. Give its `operatorOf` to the room server, so that the agent which works for a user acts on
   * that user's seat. */
  assistant: AssistantService;
  /** Close every connection and MCP session, end the running assistant tasks, and stop listening. */
  stop(): Promise<void>;
};

type Connection = {
  actor: RoomActor;
  /** The requests of this connection, chained: the next starts when the one before has finished. */
  queue: Promise<void>;
  roomId: string | null;
  subscription: RoomSubscription | null;
  closed: boolean;
  /** This connection as the assistant sees it, once it has sent an assistant message. */
  assistant: AssistantConnection | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const FORMATS: readonly WorkspaceDocFormat[] = ["docx", "xlsx", "pptx", "pdf"];

/** The media type of each document format, for the bytes of a head or a preview. */
export const DOC_MEDIA_TYPES: Record<WorkspaceDocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
};

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".gz": "application/gzip",
};

/** The HTTP status of each room failure, and of an export of a workspace the server holds nothing of. */
const FAILURE_STATUS: Record<string, number> = {
  BAD_REQUEST: 400,
  UNKNOWN_ROOM: 404,
  UNKNOWN_DOCUMENT: 404,
  UNKNOWN_PROPOSAL: 404,
  UNKNOWN_THREAD: 404,
  UNKNOWN_WORKSPACE: 404,
  FORBIDDEN: 403,
  PROPOSAL_NOT_OPEN: 409,
  [ROOM_REVISION_MISMATCH]: 409,
  LICENSE_LIMIT: 402,
  ENGINE_FAILED: 503,
};

/** The token of a request: `Authorization: Bearer <token>`, else the `token` query parameter. */
export function tokenOf(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  return bearer ?? new URL(request.url).searchParams.get("token");
}

/** The format a file name implies, from its extension. */
export function formatOfName(name: string): WorkspaceDocFormat | null {
  const ext = extname(name).slice(1).toLowerCase();
  return (FORMATS as readonly string[]).includes(ext) ? (ext as WorkspaceDocFormat) : null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const problem = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  json(status, { error: { code, message, ...extra } }, headers);

function failed(error: RoomFailure | ExportRefusal): Response {
  const extra = "detail" in error ? { detail: error.detail } : {};
  return problem(FAILURE_STATUS[error.code] ?? 400, error.code, error.message, extra);
}

/** `name` for a `Content-Disposition` header, safe for any file name. */
const disposition = (name: string): string => `inline; filename*=UTF-8''${encodeURIComponent(name)}`;

/** The validator and the receipts of a head, for the response that is the head or is made of it. */
const headReceipt = (head: RoomHead): Record<string, string> => ({
  etag: `"sha256:${head.sha256}"`,
  "cache-control": "no-cache",
  "x-wolf-revision": String(head.revision),
  "x-wolf-sha256": head.sha256,
  "x-wolf-format": head.format,
});

/** The file under `root` that `path` names, or null when it would leave `root`. */
export function resolveInside(root: string, path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const target = resolve(base, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  return target === base || target.startsWith(base + sep) ? target : null;
}

async function fileAt(path: string | null): Promise<string | null> {
  if (path === null) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

function errorEvent(requestId: string | null, error: RoomFailure): RoomServerEvent {
  if (error.code === ROOM_REVISION_MISMATCH) {
    return { type: "error", request_id: requestId, code: error.code, message: error.message, detail: error.detail };
  }
  return { type: "error", request_id: requestId, code: error.code, message: error.message };
}

const badRequest = (requestId: string | null, message: string): RoomServerEvent => errorEvent(requestId, { code: "BAD_REQUEST", message });

/** The identity of the public routes of a share link: not a member, not a guest, and never the actor of a token.
 * A room server must give it no seat (compare an actor with `===`). */
export const SHARE_VIEWER: RoomActor = { kind: "user", id: "share-viewer", name: "Viewer" };

/** What `GET /api/share/<token>` tells anyone who holds the link. */
export type PublicShare = {
  room_id: string;
  doc_name: string;
  format: WorkspaceDocFormat;
  revision: number;
  updated_at: string;
  /** The display name of the member who made the link. */
  shared_by: string;
  /** `<shareConnect>?share=<token>`, or `null` when the server has no `shareConnect`. */
  connect: string | null;
};

/** What the member routes of a share link answer: the live link of one document. */
export type Share = { token: string; path: string; room_id: string; doc_name: string; created_at: string; created_by: RoomActor };

/** A share token: 32 random bytes as base64url without padding. */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The placeholder actor of a room's MCP server: every session takes the agent its token stands for. */
const MCP_PLACEHOLDER: RoomActor = { kind: "agent", id: "wolf-workspace-mcp", name: "Wolf Workspace MCP" };

export function startWorkspaceServer(options: WorkspaceServerOptions): WorkspaceServer {
  const { service, authenticate } = options;
  const scopeOf: ScopeOf = options.scopeOf ?? (() => null);
  const staticDir = options.staticDir ? resolve(options.staticDir) : null;
  const wasmDir = options.wasmDir ? resolve(options.wasmDir) : null;
  /** The MCP server of each room that was asked for, and its HTTP transport. */
  const mcpRooms = new Map<string, { server: McpServer; handler: McpHttpHandler }>();
  // The linked pack is also what `pack_link_refresh` refreshes, into the documents of the agent's room.
  const linkedPacks = options.mcp?.packs ?? (options.pack ? directoryPackRefresher({ dir: options.pack.dir, evaluator: options.pack.evaluator }) : undefined);
  // Its manifest is what `workspace_list` describes each binding from; not when `mcp.packs` refreshes other packs.
  const linkedManifests = options.mcp?.packManifests ?? (options.pack && options.mcp?.packs === undefined ? directoryPackManifests(options.pack.dir) : undefined);
  /** The read-only mode in force now, or `null`: the fixed one, else the one of the plan record's mark now. */
  const readOnlyNow = (): ReadOnlyMode | null => {
    if (options.readOnly !== undefined) return options.readOnly;
    const mark = options.planReadOnly?.() ?? null;
    return mark === null ? null : planReadOnlyMode(mark);
  };
  /** The refusal of every write now, or `null`. */
  const refusal = (): RoomFailure | null => {
    const mode = readOnlyNow();
    return mode === null ? null : readOnlyFailure(mode);
  };
  /** Pack refreshes write files: one at a time. */
  let packQueue: Promise<unknown> = Promise.resolve();

  // --- /ws: wolfsdk.room.v1, as `startWsServer` -------------------------------------------------------

  /** Validate, then send. An event that does not validate is a bug of the server: the connection is closed
   * rather than fed something the contract does not allow. A client that does not read is closed too. */
  function send(ws: Bun.ServerWebSocket<Connection>, event: RoomServerEvent): void {
    if (ws.data.closed) return;
    const problems = validateRoomEvent(event);
    if (problems.length > 0) {
      console.error(`workspace server: refusing to send an invalid ${event.type}: ${problems.join("; ")}`);
      ws.close(1011, "internal error");
      return;
    }
    if (ws.send(JSON.stringify(event)) === 0) ws.close(1013, "too slow to follow");
  }

  async function execute(ws: Bun.ServerWebSocket<Connection>, message: RoomClientMessage): Promise<void> {
    const { actor } = ws.data;
    const requestId = message.request_id;
    if (message.type === "room.join") {
      ws.data.subscription?.unsubscribe();
      ws.data.subscription = null;
      ws.data.roomId = null;
      const joined = await service.join(message.room_id, actor, message.since_seq, (event) => {
        send(ws, event);
        if (event.type === "error") {
          ws.data.subscription = null;
          ws.data.roomId = null;
        }
      });
      if (!joined.ok) return send(ws, errorEvent(requestId, joined.error));
      if (ws.data.closed) return joined.value.unsubscribe();
      ws.data.subscription = joined.value;
      ws.data.roomId = message.room_id;
      return;
    }
    const refused = refusal();
    if (refused !== null) return send(ws, errorEvent(requestId, refused));
    const roomId = ws.data.roomId;
    if (roomId === null) return send(ws, badRequest(requestId, "join a room first: send room.join"));
    let result: Result<unknown>;
    switch (message.type) {
      case "doc.edit":
        result = await service.edit(roomId, actor, {
          doc_name: message.doc_name,
          base_revision: message.base_revision,
          mode: message.mode,
          batch: message.batch,
        });
        break;
      case "proposal.decide":
        result = await service.decideProposal(roomId, actor, { proposal_id: message.proposal_id, decision: message.decision });
        break;
      case "comment.post":
        result = await service.postComment(roomId, actor, {
          thread_id: message.thread_id,
          doc_name: message.doc_name,
          target_address: message.target_address,
          body: message.body,
          mentions: message.mentions,
          ...(message.resolve === undefined ? {} : { resolve: message.resolve }),
        });
        break;
    }
    if (!result.ok) send(ws, errorEvent(requestId, result.error));
  }

  async function handle(ws: Bun.ServerWebSocket<Connection>, raw: string | Buffer): Promise<void> {
    if (typeof raw !== "string") return send(ws, badRequest(null, "messages are JSON text frames"));
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(ws, badRequest(null, "the message is not JSON"));
    }
    if (isAssistantMessage(message)) {
      try {
        if ((await scopeOf(ws.data.actor)) !== null) {
          const id = typeof message === "object" && message !== null && "request_id" in message ? message.request_id : null;
          (ws.data.assistant ??= assistantConnection(ws)).send({
            type: "assistant.error",
            request_id: typeof id === "string" && ID.test(id) ? id : null,
            code: "FORBIDDEN",
            message: "the assistant works for members of the workspace",
          });
          return;
        }
        await assistant.handle((ws.data.assistant ??= assistantConnection(ws)), message);
      } catch (e) {
        console.error("workspace server: an assistant request failed unexpectedly", e);
        ws.close(1011, "internal error");
      }
      return;
    }
    const problems = validateRoomClientMessage(message);
    if (problems.length > 0) {
      const id = typeof message === "object" && message !== null && "request_id" in message ? message.request_id : null;
      return send(ws, badRequest(typeof id === "string" && ID.test(id) ? id : null, problems.slice(0, 5).join("; ")));
    }
    try {
      await execute(ws, message as RoomClientMessage);
    } catch (e) {
      console.error("workspace server: a request failed unexpectedly", e);
      ws.close(1011, "internal error");
    }
  }

  // --- /mcp ---------------------------------------------------------------------------------------------

  async function mcpRoomOf(request: Request, scope: AccessScope | null): Promise<string | Response> {
    const reachable = (roomId: string): boolean => scope === null || scope.docs.some((d) => d.room_id === roomId);
    const configured = options.defaultRoom && reachable(options.defaultRoom) ? options.defaultRoom : null;
    const named = new URL(request.url).searchParams.get("room") ?? request.headers.get("x-wolf-room") ?? configured;
    // A room outside the scope of the caller is as unknown as a room that does not exist.
    const rooms = (await service.listRooms()).filter((r) => reachable(r.room_id));
    if (named !== null) {
      if (!ID.test(named)) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `${JSON.stringify(named)} is not a room id` } });
      if ((scope === null && mcpRooms.has(named)) || rooms.some((r) => r.room_id === named)) return named;
      return json(404, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `unknown room ${JSON.stringify(named)}` } });
    }
    if (rooms.length === 1 && rooms[0]) return rooms[0].room_id;
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: rooms.length === 0 ? "the server has no room yet: create one first" : "name the room: add ?room=<id> or the X-Wolf-Room header" },
    });
  }

  function mcpRoomFor(roomId: string): { server: McpServer; handler: McpHttpHandler } {
    let room = mcpRooms.get(roomId);
    if (!room) {
      const tools = {
        ...options.mcp,
        packs: linkedPacks,
        ...(linkedManifests === undefined ? {} : { packManifests: linkedManifests }),
        service,
        roomId,
      } satisfies WorkspaceToolsOptions;
      const server = new McpServer({
        ...tools,
        // `serverInfo.version` names the build an agent client or a support request talks to.
        version: workspacePackage.version,
        actor: MCP_PLACEHOLDER,
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      });
      const scopedPacks = options.scopeOf !== undefined && (linkedPacks !== undefined || linkedManifests !== undefined);
      const dynamicMode = options.readOnly === undefined && options.planReadOnly !== undefined;
      if (scopedPacks || dynamicMode) {
        const { packs: _packs, packManifests: _manifests, ...withoutPacks } = tools;
        const guestTools = new WorkspaceTools({ ...withoutPacks, ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }) });
        const memberCall = server.tools.call.bind(server.tools);
        server.tools.call = async (agent, call) => {
          // Scope and plan can change while an MCP session remains open. Resolve both for the authenticated actor.
          const guest = scopedPacks && (await scopeOf(agent)) !== null;
          const mode = dynamicMode ? readOnlyNow() : null;
          if (mode !== null) return new WorkspaceTools({ ...(guest ? withoutPacks : tools), readOnly: mode }).call(agent, call);
          return guest ? guestTools.call(agent, call) : memberCall(agent, call);
        };
      }
      room = { server, handler: createMcpHttpHandler({ server, authenticate }) };
      mcpRooms.set(roomId, room);
    }
    return room;
  }

  // The assistant calls the tools of the room's MCP server, as the agent that works for the user who asked: one
  // implementation of every read and every edit, whoever the agent is.
  const assistant = new AssistantService({
    endpoint: null,
    allowance: null,
    storePath: ":memory:",
    ...options.assistant,
    rooms: service,
    tools: (roomId, agent, call) => mcpRoomFor(roomId).server.tools.call(agent, call),
  });

  async function mcp(request: Request): Promise<Response> {
    // Authenticate before naming the room: an unknown caller learns nothing about which rooms exist.
    const actor = await authenticate(request);
    if (actor === null) {
      return json(401, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "authentication required" } }, { "www-authenticate": "Bearer" });
    }
    const room = await mcpRoomOf(request, await scopeOf(actor));
    if (room instanceof Response) return room;
    return mcpRoomFor(room).handler.fetch(request);
  }

  // --- /api ---------------------------------------------------------------------------------------------

  async function defaultWorkspace(): Promise<string> {
    if (options.workspaceId) return options.workspaceId;
    const [first] = await service.listRooms();
    return first?.workspace_id ?? "default";
  }

  async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
    try {
      const body: unknown = await request.json();
      if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      // Answered below.
    }
    return problem(400, "BAD_REQUEST", "the body is not a JSON object");
  }

  async function createRoom(request: Request, actor: RoomActor): Promise<Response> {
    const refused = refusal();
    if (refused !== null) return failed(refused);
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const roomId = body.room_id;
    const workspaceId = body.workspace_id ?? (await defaultWorkspace());
    if (typeof roomId !== "string" || !ID.test(roomId)) return problem(400, "BAD_REQUEST", "room_id is letters, digits and . _ : -, up to 128");
    if (typeof workspaceId !== "string" || !ID.test(workspaceId)) return problem(400, "BAD_REQUEST", "workspace_id is letters, digits and . _ : -, up to 128");
    const created = await service.createRoom(actor, { room_id: roomId, workspace_id: workspaceId });
    return created.ok ? json(201, created.value) : failed(created.error);
  }

  async function addDocument(request: Request, roomId: string, actor: RoomActor): Promise<Response> {
    const refused = refusal();
    if (refused !== null) return failed(refused);
    const url = new URL(request.url);
    let name = url.searchParams.get("name");
    let format: string | null = url.searchParams.get("format");
    let bytes: Uint8Array;
    if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (form === null) return problem(400, "BAD_REQUEST", "the multipart body does not parse");
      const file = form.get("file");
      if (!(file instanceof Blob)) return problem(400, "BAD_REQUEST", "send the document as the form field file");
      const fieldName = form.get("name");
      const fieldFormat = form.get("format");
      name = typeof fieldName === "string" && fieldName !== "" ? fieldName : (name ?? (file instanceof File ? file.name : null));
      format = typeof fieldFormat === "string" && fieldFormat !== "" ? fieldFormat : format;
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
    }
    if (name === null || name.trim() === "" || name.includes("/") || name.includes("\\")) {
      return problem(400, "BAD_REQUEST", "name the document: ?name=<file name>, without a path");
    }
    const resolved = format === null ? formatOfName(name) : (FORMATS as readonly string[]).includes(format) ? (format as WorkspaceDocFormat) : null;
    if (resolved === null) return problem(400, "BAD_REQUEST", "the format is one of docx, xlsx, pptx and pdf: pass ?format= or a file name with that extension");
    if (bytes.length === 0) return problem(400, "BAD_REQUEST", "the document is empty");
    const added = await service.addDocument(roomId, actor, { name, format: resolved, bytes });
    return added.ok ? json(201, { head: added.value }) : failed(added.error);
  }

  async function readHead(request: Request, roomId: string, actor: RoomActor, docName: string): Promise<Response> {
    const read = await service.readHead(roomId, actor, docName);
    if (!read.ok) return failed(read.error);
    const { head, bytes } = read.value;
    const headers = headReceipt(head);
    if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { ...headers, "content-type": DOC_MEDIA_TYPES[head.format], "content-disposition": disposition(head.name) },
    });
  }

  /** The snapshot of one document, read from `from` as `actor`. */
  async function readSnapshot(request: Request, roomId: string, actor: RoomActor, docName: string, from: RoomService = service): Promise<Response> {
    const render = options.snapshot;
    if (!render) return problem(501, "NO_SNAPSHOT", "this server renders no snapshots: start it with an engine");
    const read = await from.readHead(roomId, actor, docName);
    if (!read.ok) return failed(read.error);
    const { head, bytes } = read.value;
    const headers = headReceipt(head);
    if (request.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    try {
      return json(200, { pages: await render({ format: head.format, name: head.name, bytes }) }, headers);
    } catch (e) {
      if (e instanceof EngineFault || e instanceof EngineRefusal) return problem(503, "ENGINE_FAILED", e.message);
      throw e;
    }
  }

  async function readPreview(roomId: string, actor: RoomActor, proposalId: string): Promise<Response> {
    const read = await service.readPreview(roomId, actor, proposalId);
    if (!read.ok) return failed(read.error);
    const { proposal, bytes } = read.value;
    const room = await service.getRoom(roomId, actor);
    const format = room.ok ? room.value.documents.find((d) => d.head.name === proposal.doc_name)?.head.format : undefined;
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        "content-type": format ? DOC_MEDIA_TYPES[format] : "application/octet-stream",
        "content-disposition": disposition(`${proposal.proposal_id}-${proposal.doc_name}`),
        "cache-control": "no-store",
        "x-wolf-sha256": new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        "x-wolf-proposal": proposal.proposal_id,
        "x-wolf-base-revision": String(proposal.base_revision),
      },
    });
  }

  function packFailure(e: unknown): Response {
    if (e instanceof PackError) return problem(422, e.code, e.message, { problems: e.problems });
    if (e instanceof EngineFault || e instanceof EngineRefusal) return problem(503, "engine-failed", e.message);
    throw e;
  }

  /** The room `GET /api/pack` checks the pack against: `?room=`, else the default room, else the only room. `null`
   * while the server has no room, and the pack is checked on disk. */
  async function packRoomOf(request: Request): Promise<string | null | Response> {
    const named = new URL(request.url).searchParams.get("room");
    if (named !== null) return ID.test(named) ? named : problem(400, "BAD_REQUEST", `${JSON.stringify(named)} is not a room id`);
    if (options.defaultRoom) return options.defaultRoom;
    const rooms = await service.listRooms();
    return rooms.length === 1 && rooms[0] ? rooms[0].room_id : null;
  }

  /** The documents of `roomId` at their heads, as `actor` reads them, and the file of the pack directory for a name
   * the room does not hold: what `pack_link_refresh` refreshes from and into, so a binding the room's heads already
   * carry is fresh whatever the files on disk say. */
  function roomHeads(roomId: string, actor: RoomActor, dir: PackReader): PackReader {
    return {
      read: async (name) => {
        const read = await service.readHead(roomId, actor, name);
        if (read.ok) return read.value.bytes;
        if (read.error.code !== "UNKNOWN_DOCUMENT") throw new PackError("room-read-failed", `${name}: ${read.error.code}: ${read.error.message}`);
        return dir.read(name);
      },
    };
  }

  async function pack(request: Request, action: "check" | "refresh", actor: RoomActor): Promise<Response> {
    if (action === "refresh" && request.method === "POST") {
      const refused = refusal();
      if (refused !== null) return failed(refused);
    }
    const linked = options.pack;
    if (!linked) return problem(404, "NO_PACK", "no pack is linked: start the server with --pack <dir>");
    if (action === "refresh" && request.method !== "POST") return problem(405, "BAD_REQUEST", "refresh the pack with POST", {}, { allow: "POST" });
    if (action === "check" && request.method !== "GET") return problem(405, "BAD_REQUEST", "read the pack with GET", {}, { allow: "GET" });
    let roomId: string | null = null;
    if (action === "check") {
      const room = await packRoomOf(request);
      if (room instanceof Response) return room;
      if (room !== null) {
        // Who cannot read the room learns nothing of its documents.
        const state = await service.getRoom(room, actor);
        if (!state.ok) return failed(state.error);
      }
      roomId = room;
    }
    const store = new DirectoryStore(linked.dir);
    const name = basename(resolve(linked.dir));
    const evaluator = { evaluator: linked.evaluator };
    const run = async (): Promise<Response> => {
      try {
        if (action === "check" && roomId === null) return json(200, { dir: name, room: null, report: await checkPack(store, evaluator) });
        if (action === "check" && roomId !== null) {
          // The manifest is the pack directory's; every source and target the room holds is read at its head.
          const heads = roomHeads(roomId, actor, store);
          return json(200, { dir: name, room: roomId, report: (await planPack(await loadPack(store), heads, heads, evaluator)).report });
        }
        const report = await refreshPack(store, { evaluator: linked.evaluator, engine: linked.engine });
        return json(200, {
          dir: name,
          room: null,
          report: {
            pack_id: report.pack_id,
            fresh: report.fresh,
            bindings: report.bindings,
            documents: report.documents.map(({ doc_name, ops, sha256_before, sha256_after }) => ({ doc_name, ops, sha256_before, sha256_after })),
          },
          refreshed: report.documents.map((d) => d.doc_name),
        });
      } catch (e) {
        return packFailure(e);
      }
    };
    const next = packQueue.then(run, run);
    packQueue = next.catch(() => undefined);
    return next;
  }

  /** `GET /api/export[?workspace=<id>]`: every document of every room of one workspace, at its head, as one ZIP archive
   * that is streamed, one document in memory at a time (see `export.ts`). Whoever can read every room of the workspace
   * can export it, a user or an agent, read-only mode included (it writes nothing). What can refuse an export is known
   * before the first byte, so a refusal is an ordinary error response. */
  async function exportArchive(request: Request, actor: RoomActor): Promise<Response> {
    if (request.method !== "GET") return problem(405, "BAD_REQUEST", "read the export with GET", {}, { allow: "GET" });
    const named = new URL(request.url).searchParams.get("workspace");
    if (named !== null && !ID.test(named)) return problem(400, "BAD_REQUEST", `${JSON.stringify(named)} is not a workspace id`);
    const planned = await planExport(service, actor, { named, configured: options.workspaceId || null });
    return planned.ok ? exportResponse(planned.value) : failed(planned.error);
  }

  const shareNotFound = (): Response => problem(404, "SHARE_NOT_FOUND", "this link is not shared");
  const guestRefused = (): Response =>
    problem(403, "FORBIDDEN", "a guest of a shared document may read it, comment on it and propose edits, and may not do this");

  const shareOf = (link: ShareLink): Share => ({
    token: link.token,
    path: `/s/${link.token}`,
    room_id: link.room_id,
    doc_name: link.doc_name,
    created_at: link.created_at,
    created_by: link.created_by,
  });

  /** `GET /api/share/<token>` and `GET /api/share/<token>/snapshot`: no credentials. The token names one document and
   * the read goes through a `view` scope of that document alone, as the viewer, who takes no seat. An unknown token,
   * an ended one and a document that is gone are one answer. `null` for a request that is not one of these two. */
  async function publicShare(request: Request, path: string): Promise<Response | null> {
    const match = /^\/api\/share\/([^/]+)(\/snapshot)?$/.exec(path);
    if (match === null || request.method !== "GET") return null;
    const token = match[1] ?? "";
    const link = options.shares && SHARE_TOKEN.test(token) ? options.shares.resolveShare(token) : null;
    if (link === null) return shareNotFound();
    const viewing = scopedService(service, () => ({ access: "view", docs: [{ room_id: link.room_id, doc_name: link.doc_name }] }));
    if (match[2] !== undefined) {
      const snapshot = await readSnapshot(request, link.room_id, SHARE_VIEWER, link.doc_name, viewing);
      return snapshot.status === 404 ? shareNotFound() : snapshot;
    }
    const read = await viewing.readHead(link.room_id, SHARE_VIEWER, link.doc_name);
    if (!read.ok) return read.error.code === "UNKNOWN_ROOM" || read.error.code === "UNKNOWN_DOCUMENT" ? shareNotFound() : failed(read.error);
    const { head } = read.value;
    const connect = options.shareConnect ? `${options.shareConnect}?share=${link.token}` : null;
    const share: PublicShare = {
      room_id: link.room_id,
      doc_name: link.doc_name,
      format: head.format,
      revision: head.revision,
      updated_at: head.updated_at,
      shared_by: link.created_by.name,
      connect,
    };
    return json(200, { share });
  }

  /** `GET`, `PUT` and `DELETE /api/rooms/<room>/docs/<doc>/share`: the link of a document, for a member who is a user. */
  async function memberShare(request: Request, roomId: string, docName: string, actor: RoomActor, scope: AccessScope | null): Promise<Response> {
    if (actor.kind !== "user" || scope !== null) return problem(403, "FORBIDDEN", "only a member of the workspace may share a document");
    const shares = options.shares;
    if (!shares) return problem(404, "NOT_FOUND", "this server keeps no share links");
    const method = request.method;
    if (method !== "GET" && method !== "PUT" && method !== "DELETE") return problem(405, "BAD_REQUEST", "use GET, PUT or DELETE", {}, { allow: "GET, PUT, DELETE" });
    const room = await service.getRoom(roomId, actor);
    if (!room.ok) return failed(room.error);
    if (method === "GET") return json(200, { share: ((link) => (link === null ? null : shareOf(link)))(shares.shareOf(roomId, docName)) });
    // Ending a link is never refused: a workspace that has gone read-only can still stop sharing.
    if (method === "DELETE") {
      shares.unshare(roomId, docName);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    const refused = refusal();
    if (refused !== null) return failed(refused);
    const made = await shares.share(roomId, docName, actor);
    return made.ok ? json(200, { share: shareOf(made.value.link) }) : failed(made.error);
  }

  async function api(request: Request, path: string): Promise<Response> {
    if (path === "/api/health") return json(200, { ok: true });
    const actor = await authenticate(request);
    if (actor === null) return problem(401, "UNAUTHORIZED", "send a known token as Authorization: Bearer <token>", {}, { "www-authenticate": "Bearer" });
    const scope = await scopeOf(actor);
    const method = request.method;
    const parts = path.split("/").slice(2).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "\0";
      }
    });
    const [head, roomId, kind, item, leaf] = parts;
    if (head === "me" && parts.length === 1 && method === "GET") {
      const readOnly = readOnlyNow();
      const guest = scope === null ? null : { docs: scope.docs.map(({ room_id, doc_name }) => ({ room_id, doc_name })) };
      return json(200, readOnly === null ? { actor, guest } : { actor, guest, readOnly });
    }
    if (scope !== null && (head === "export" || head === "pack")) return guestRefused();
    if (head === "export" && parts.length === 1) return exportArchive(request, actor);
    if (head === "pack" && parts.length === 1) return pack(request, "check", actor);
    if (head === "pack" && parts.length === 2 && roomId === "refresh") return pack(request, "refresh", actor);
    if (head !== "rooms") return problem(404, "NOT_FOUND", `no route ${method} ${path}`);
    if (parts.length === 1) {
      if (method === "GET") {
        const rooms = await service.listRooms();
        return json(200, { rooms: scope === null ? rooms : rooms.filter((r) => scope.docs.some((d) => d.room_id === r.room_id)) });
      }
      if (method === "POST") return scope === null ? createRoom(request, actor) : guestRefused();
    } else if (roomId !== undefined && ID.test(roomId)) {
      if (parts.length === 2 && method === "GET") {
        const room = await service.getRoom(roomId, actor);
        return room.ok ? json(200, room.value) : failed(room.error);
      }
      if (kind === "docs" && parts.length === 3 && method === "POST") return scope === null ? addDocument(request, roomId, actor) : guestRefused();
      if (kind === "docs" && parts.length === 5 && leaf === "share" && item) return memberShare(request, roomId, item, actor, scope);
      if (kind === "docs" && parts.length === 5 && leaf === "head" && item && (method === "GET" || method === "HEAD")) return readHead(request, roomId, actor, item);
      if (kind === "docs" && parts.length === 5 && leaf === "snapshot" && item && method === "GET") return readSnapshot(request, roomId, actor, item);
      if (kind === "proposals" && parts.length === 5 && leaf === "preview" && item && method === "GET") return readPreview(roomId, actor, item);
    }
    return problem(404, "NOT_FOUND", `no route ${method} ${path}`);
  }

  // --- /wasm and the UI ----------------------------------------------------------------------------------

  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "*" };

  async function wasm(request: Request, path: string): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (wasmDir === null) return new Response("no local engine channel: start the server with --wasm-dir <dir>", { status: 404, headers: CORS });
    const file = await fileAt(resolveInside(wasmDir, path.slice("/wasm".length)));
    if (file === null) return new Response("not found", { status: 404, headers: CORS });
    const type = basename(file) === "SHA256SUMS" ? "text/plain; charset=utf-8" : (STATIC_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    return new Response(Bun.file(file), { headers: { ...CORS, "content-type": type, "cache-control": "no-cache" } });
  }

  const UI_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "SAMEORIGIN" };

  async function ui(request: Request, path: string): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    if (staticDir === null) {
      return new Response("the workspace UI is not built: run bun run build in sdk/web, or pass --static-dir", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const asset = path === "/" ? null : await fileAt(resolveInside(staticDir, path));
    if (asset !== null) {
      const immutable = path.startsWith("/assets/");
      return new Response(Bun.file(asset), {
        headers: {
          ...UI_HEADERS,
          "content-type": STATIC_TYPES[extname(asset).toLowerCase()] ?? "application/octet-stream",
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    }
    // A missing asset is a 404. Any other path a browser navigates to (it accepts HTML), or that has no file
    // extension, is a route of the single-page app: a document route ends in `.docx` like a file would.
    const navigation = (request.headers.get("accept") ?? "").includes("text/html");
    if (path.startsWith("/assets/") || (extname(path) !== "" && !navigation)) return new Response("not found", { status: 404, headers: UI_HEADERS });
    const index = await fileAt(resolve(staticDir, "index.html"));
    if (index === null) return new Response("the workspace UI has no index.html", { status: 404, headers: UI_HEADERS });
    return new Response(Bun.file(index), { headers: { ...UI_HEADERS, "content-type": STATIC_TYPES[".html"]!, "cache-control": "no-cache" } });
  }

  const server = Bun.serve<Connection>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    maxRequestBodySize: MAX_UPLOAD_BYTES,
    // MCP event streams sit idle between events; their keep-alive comments keep them open, not the socket timer.
    idleTimeout: 0,
    async fetch(request, upgrade) {
      const path = new URL(request.url).pathname;
      if (path === "/ws") {
        const actor = await authenticate(request);
        if (actor === null) return new Response("unauthorized", { status: 401 });
        const data: Connection = { actor, queue: Promise.resolve(), roomId: null, subscription: null, closed: false, assistant: null };
        if (upgrade.upgrade(request, { data })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      }
      if (path === "/mcp") return mcp(request);
      if (path.startsWith("/api/share/")) {
        const shared = await publicShare(request, path);
        if (shared !== null) return shared;
      }
      if (path === "/api" || path.startsWith("/api/")) return api(request, path);
      if (path === "/wasm" || path.startsWith("/wasm/")) return wasm(request, path);
      return ui(request, path);
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES,
      closeOnBackpressureLimit: true,
      message(ws, raw) {
        ws.data.queue = ws.data.queue.then(() => handle(ws, raw));
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.subscription?.unsubscribe();
        ws.data.subscription = null;
      },
    },
  });

  const port = server.port ?? 0;
  const host = server.hostname?.includes(":") ? `[${server.hostname}]` : server.hostname;
  return {
    port,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    mcpUrl: `http://${host}:${port}/mcp`,
    assistant,
    async stop() {
      for (const { handler } of mcpRooms.values()) handler.close();
      mcpRooms.clear();
      await server.stop(true);
      // After the sockets: a task that is cancelled here stores its turn and has nobody left to tell.
      await assistant.close();
    },
  };
}
