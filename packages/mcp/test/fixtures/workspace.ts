// Shared set-up of the MCP tests: a real room server on a temporary directory (with the in-memory engine), an MCP
// server bound to one room and one agent, and the small helpers every test file uses to talk JSON-RPC.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { type Result, RoomServer } from "@wolfsdk/server";
import type { JsonRpcError, JsonRpcResponse } from "../../src/jsonrpc.ts";
import { blankDocument, type ToolResult } from "../../src/index.ts";
import { McpServer, type McpServerOptions, type McpSession } from "../../src/server.ts";
import { MemoryEngine, wordDocument } from "./memory-engine.ts";

export const alice: RoomActor = { kind: "user", id: "alice", name: "Alice" };
export const bob: RoomActor = { kind: "user", id: "bob", name: "Bob" };
export const robot: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
export const helper: RoomActor = { kind: "agent", id: "helper", name: "Helper" };

export const BRIEF_LINES = ["Quarterly brief", "Revenue grew in Q3.", "Costs are flat.", "Next steps follow."] as const;

export function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** A deterministic clock: every reading is one second after the one before. */
export function steppingClock(start = "2026-11-13T10:00:00.000Z"): () => Date {
  let at = Date.parse(start);
  return () => {
    const reading = new Date(at);
    at += 1000;
    return reading;
  };
}

const disposers: (() => Promise<void> | void)[] = [];

/** Run every cleanup the tests registered, last first. Each test file calls it from `afterEach`. */
export async function disposeAll(): Promise<void> {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
}

export const onDispose = (dispose: () => Promise<void> | void): void => {
  disposers.push(dispose);
};

export type Workspace = {
  room: RoomServer;
  engine: MemoryEngine;
  mcp: McpServer;
};

export type WorkspaceOptions = Partial<Omit<McpServerOptions, "service" | "roomId" | "actor">> & { actor?: RoomActor; seed?: boolean };

/** A room `room` (workspace `ws`) holding `brief.docx` (the four lines of `BRIEF_LINES`) and `model.xlsx` (a blank
 * workbook), and an MCP server that acts in it as `robot`. */
export async function makeWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "wolfsdk-mcp-"));
  const engine = new MemoryEngine();
  let counter = 0;
  const room = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine,
    now: steppingClock(),
    newId: () => `id-${++counter}`,
  });
  onDispose(async () => {
    await room.close();
    await rm(dir, { recursive: true, force: true });
  });
  must(await room.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  if (options.seed !== false) {
    must(await room.addDocument("room", alice, { name: "brief.docx", format: "docx", bytes: wordDocument(BRIEF_LINES) }));
    must(await room.addDocument("room", alice, { name: "model.xlsx", format: "xlsx", bytes: blankDocument("xlsx") }));
  }
  const { actor, seed: _seed, ...hooks } = options;
  const mcp = new McpServer({ ...hooks, actor: actor ?? robot, roomId: "room", service: room });
  return { room, engine, mcp };
}

// JSON-RPC ----------------------------------------------------------------------------------------------------

let nextId = 1;

export const request = (method: string, params?: Record<string, unknown>) =>
  params === undefined ? { jsonrpc: "2.0" as const, id: nextId++, method } : { jsonrpc: "2.0" as const, id: nextId++, method, params };

export const notify = (method: string, params?: Record<string, unknown>) =>
  params === undefined ? { jsonrpc: "2.0" as const, method } : { jsonrpc: "2.0" as const, method, params };

export const initializeRequest = (protocolVersion = "2025-06-18") =>
  request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } });

/** The `result` of a response that must be a success. */
export function resultOf(answer: JsonRpcResponse | JsonRpcResponse[] | undefined): unknown {
  if (answer === undefined || Array.isArray(answer)) throw new Error("expected one response");
  if (!("result" in answer)) throw new Error(`expected a result, got error ${JSON.stringify(answer.error)}`);
  return answer.result;
}

/** The `error` of a response that must be a failure. */
export function rpcErrorOf(answer: JsonRpcResponse | JsonRpcResponse[] | undefined): JsonRpcError {
  if (answer === undefined || Array.isArray(answer)) throw new Error("expected one response");
  if (!("error" in answer)) throw new Error("expected an error response");
  return answer.error;
}

/** A session that has completed the handshake. */
export async function openSession(mcp: McpServer, id = "session", actor?: RoomActor): Promise<McpSession> {
  const session = mcp.createSession(id, actor);
  resultOf(await session.handle(initializeRequest()));
  await session.handle(notify("notifications/initialized"));
  return session;
}

/** One `tools/call` through a session. */
export async function callTool(session: McpSession, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return resultOf(await session.handle(request("tools/call", { name, arguments: args }))) as ToolResult;
}

export const dataOf = (result: ToolResult): Record<string, unknown> => result.structuredContent;

/** The `error` member of a tool result that must have failed. */
export function toolErrorOf(result: ToolResult): { code: string; message: string; detail?: Record<string, unknown> } {
  expectFailed(result);
  return result.structuredContent.error as { code: string; message: string; detail?: Record<string, unknown> };
}

function expectFailed(result: ToolResult): void {
  if (result.isError !== true) throw new Error(`expected a failed tool call, got ${JSON.stringify(result.structuredContent).slice(0, 200)}`);
}

/** The head of `doc` in the room. */
export async function headOf(workspace: Workspace, doc: string): Promise<{ revision: number; sha256: string }> {
  const read = must(await workspace.room.readHead("room", alice, doc));
  return { revision: read.head.revision, sha256: read.head.sha256 };
}

/** The events of a room as one listener sees them. */
export async function listen(workspace: Workspace, actor: RoomActor = alice): Promise<RoomServerEvent[]> {
  const events: RoomServerEvent[] = [];
  const subscription = must(await workspace.room.join("room", actor, null, (event) => events.push(event)));
  onDispose(() => subscription.unsubscribe());
  return events;
}
