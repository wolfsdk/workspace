// The read-only mode of `serve` over the unified port: every write is refused with one code and a message that carries
// the reason and the upgrade path, whichever way it comes (HTTP, the room socket, the MCP endpoint), while sign-in,
// listing, reading, download and joining a room keep working, and `GET /api/me` says why.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { type ReadOnlyMode, RoomServer } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { binding, docx, manifest, manifestBytes, QUARTERS, xlsx } from "../../packs/test/fixtures.ts";
import { UsageError } from "../src/errors.ts";
import { startWorkspaceServer, tokenOf, type WorkspaceServer } from "../src/http.ts";
import { watchPlanRecord } from "../src/run.ts";

setDefaultTimeout(120_000);

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const TOKENS = new Map<string, RoomActor>([
  ["t-alice", ALICE],
  ["t-robot", ROBOT],
]);
const MODE: ReadOnlyMode = { reason: "The trial ended on 2026-11-28.", upgrade: "https://cloud.example.test/upgrade" };
const MESSAGE = `workspace-read-only: ${MODE.reason} ${MODE.upgrade}`;
const LINES = ["Quarterly brief", "Revenue grew in Q3."];
const word = (lines: string[]): Uint8Array<ArrayBuffer> => new Uint8Array(wordDocument(lines));

let dir: string;
let room: RoomServer;
let server: WorkspaceServer;
let threadId: string;
let proposalId: string;

const open = (readOnly?: ReadOnlyMode): RoomServer =>
  new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new MemoryEngine(), readOnly });

/** A workspace that was writable: room `r1` with `brief.docx` (one commit), an open proposal by the robot and a thread.
 * The files are then opened again, read-only when `readOnly` is given. */
async function seeded(readOnly?: ReadOnlyMode, options: Partial<Parameters<typeof startWorkspaceServer>[0]> = {}): Promise<void> {
  const writable = open();
  for (const result of [
    await writable.createRoom(ALICE, { room_id: "r1", workspace_id: "ws" }),
    await writable.addDocument("r1", ALICE, { name: "brief.docx", format: "docx", bytes: word(LINES) }),
    await writable.edit("r1", ALICE, { doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Committed." }] } }),
  ]) {
    if (!result.ok) throw new Error(result.error.message);
  }
  const proposal = await writable.edit("r1", ROBOT, { doc_name: "brief.docx", base_revision: 1, mode: "propose", batch: { ops: [{ op: "append_paragraph", text: "Proposed." }] } });
  const thread = await writable.postComment("r1", ALICE, { thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "first", mentions: [] });
  if (!proposal.ok || proposal.value.mode !== "propose" || !thread.ok) throw new Error("the seed failed");
  proposalId = proposal.value.proposal.proposal_id;
  threadId = thread.value.thread_id;
  await writable.close();

  room = open(readOnly);
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    ...(readOnly === undefined ? {} : { readOnly }),
    ...options,
  });
}

const auth = (token = "t-alice"): Record<string, string> => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${server.url}${path}`, init);
const postJson = (path: string, body: unknown, token = "t-alice"): Promise<Response> =>
  call(path, { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(body) });

/** The entries of a stored ZIP archive, read from its central directory (the exports are stored, and small here). */
function zipEntries(zip: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, bytes: zip.slice(start, start + size) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The status and the error of a response that must be the refusal of a write. */
async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({ error: { code: "LICENSE_LIMIT", message: MESSAGE } });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-read-only-"));
});

afterEach(async () => {
  await server?.stop();
  await room?.close();
  await rm(dir, { recursive: true, force: true });
});

async function connect(token = "t-alice"): Promise<{ ws: WebSocket; events: RoomServerEvent[]; next(match: (e: RoomServerEvent) => boolean): Promise<RoomServerEvent>; send(message: unknown): void }> {
  const ws = new WebSocket(`${server.wsUrl}?token=${token}`);
  const events: RoomServerEvent[] = [];
  const waiters: { match: (e: RoomServerEvent) => boolean; resolve: (e: RoomServerEvent) => void }[] = [];
  ws.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as RoomServerEvent;
    events.push(event);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(event)) waiter.resolve(event);
      else waiters.push(waiter);
    }
  });
  const opened = Promise.withResolvers<void>();
  ws.addEventListener("open", () => opened.resolve(), { once: true });
  ws.addEventListener("error", () => opened.reject(new Error("the socket did not open")), { once: true });
  await opened.promise;
  return {
    ws,
    events,
    send: (message) => ws.send(JSON.stringify(message)),
    next: (match) => {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen);
      const waiting = Promise.withResolvers<RoomServerEvent>();
      waiters.push({ match, resolve: waiting.resolve });
      return waiting.promise;
    },
  };
}

describe("over HTTP", () => {
  test("GET /api/me says the workspace is read-only, with the reason and the upgrade path", async () => {
    await seeded(MODE);
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE, readOnly: { reason: MODE.reason, upgrade: MODE.upgrade } });
    expect((await call("/api/me")).status).toBe(401);
  });

  test("refuses to create a workspace, whatever the body says", async () => {
    await seeded(MODE);
    await expectRefused(await postJson("/api/rooms", { room_id: "r2", workspace_id: "ws" }));
    await expectRefused(await postJson("/api/rooms", { room_id: "not a valid id!" }));
    await expectRefused(await call("/api/rooms", { method: "POST", headers: auth(), body: "{not json" }));
    expect(((await (await call("/api/rooms", { headers: auth() })).json()) as { rooms: { room_id: string }[] }).rooms.map((r) => r.room_id)).toEqual(["r1"]);
  });

  test("refuses to add a document, raw or multipart, named well or not", async () => {
    await seeded(MODE);
    await expectRefused(await call("/api/rooms/r1/docs?name=second.docx", { method: "POST", headers: auth(), body: word(["two"]) }));
    const form = new FormData();
    form.set("file", new File([word(["three"])], "third.docx"));
    await expectRefused(await call("/api/rooms/r1/docs", { method: "POST", headers: auth(), body: form }));
    await expectRefused(await call("/api/rooms/r1/docs?name=notes.txt", { method: "POST", headers: auth(), body: new Uint8Array() }));
    await expectRefused(await call("/api/rooms/nowhere/docs?name=x.docx", { method: "POST", headers: auth(), body: word(["x"]) }));
    const state = (await (await call("/api/rooms/r1", { headers: auth() })).json()) as { documents: { head: { name: string } }[] };
    expect(state.documents.map((d) => d.head.name)).toEqual(["brief.docx"]);
  });

  test("refuses to refresh a pack, linked or not, and leaves the pack as it was", async () => {
    await seeded(MODE);
    await expectRefused(await call("/api/pack/refresh", { method: "POST", headers: auth() }));
    await server.stop();

    const pack = join(dir, "pack");
    await mkdir(pack);
    await writeFile(
      join(pack, "pack.wolf.json"),
      manifestBytes(manifest([binding({ id: "headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } })])),
    );
    await writeFile(join(pack, "fin.xlsx"), xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } }));
    await writeFile(join(pack, "deck.docx"), docx());
    const before = await readFile(join(pack, "deck.docx"));
    server = startWorkspaceServer({
      service: room,
      authenticate: (request) => TOKENS.get(tokenOf(request) ?? "") ?? null,
      pack: { dir: pack },
      readOnly: MODE,
    });
    await expectRefused(await call("/api/pack/refresh", { method: "POST", headers: auth() }));
    expect(Buffer.compare(await readFile(join(pack, "deck.docx")), before)).toBe(0);
    // Checking a pack writes nothing, so it keeps working.
    const checked = await call("/api/pack", { headers: auth() });
    expect(checked.status).toBe(200);
    expect(((await checked.json()) as { report: { fresh: boolean } }).report.fresh).toBe(false);
  });

  test("keeps listing, reading, previewing and downloading", async () => {
    await seeded(MODE);
    expect(((await (await call("/api/rooms", { headers: auth() })).json()) as { rooms: { room_id: string }[] }).rooms.map((r) => r.room_id)).toEqual(["r1"]);
    const state = (await (await call("/api/rooms/r1", { headers: auth() })).json()) as { documents: { head: { name: string; revision: number } }[] };
    expect(state.documents.map((d) => [d.head.name, d.head.revision])).toEqual([["brief.docx", 1]]);
    const download = await call("/api/rooms/r1/docs/brief.docx/head", { headers: auth() });
    expect(download.status).toBe(200);
    expect(download.headers.get("x-wolf-revision")).toBe("1");
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const preview = await call(`/api/rooms/r1/proposals/${proposalId}/preview`, { headers: auth() });
    expect(preview.status).toBe(200);
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await call("/api/health")).status).toBe(200);
  });

  test("exports every document as one archive, and a write is not needed for that", async () => {
    await seeded(MODE);
    expect((await call("/api/export")).status).toBe(401);
    const refused = await call("/api/export", { method: "POST", headers: auth() });
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET");

    const response = await call("/api/export", { headers: auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="wolf-workspace-export-\d{8}\.zip"$/);
    const entries = zipEntries(new Uint8Array(await response.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["r1/brief.docx", "manifest.json"]);
    const brief = await call("/api/rooms/r1/docs/brief.docx/head", { headers: auth() });
    expect(entries[0]?.bytes).toEqual(new Uint8Array(await brief.arrayBuffer()));
    const listed = JSON.parse(new TextDecoder().decode(entries[1]?.bytes)) as { format: string; rooms: { room_id: string; documents: { path: string; revision: number }[] }[] };
    expect(listed.format).toBe("wolfsdk.workspace.export.v1");
    expect(listed.rooms.map((r) => [r.room_id, r.documents.map((d) => [d.path, d.revision])])).toEqual([["r1", [["r1/brief.docx", 1]]]]);
  });
});

describe("over the room socket", () => {
  test("joins a room and reads it, and refuses an edit, a decision and a comment with the same error", async () => {
    await seeded(MODE);
    const alice = await connect();
    alice.send({ type: "room.join", request_id: "j1", room_id: "r1", since_seq: null });
    const snapshot = await alice.next((e) => e.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.room.documents.map((d) => d.head.name)).toEqual(["brief.docx"]);

    alice.send({ type: "doc.edit", request_id: "e1", doc_name: "brief.docx", base_revision: 1, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "No." }] } });
    alice.send({ type: "doc.edit", request_id: "e2", doc_name: "brief.docx", base_revision: 1, mode: "propose", batch: { ops: [{ op: "append_paragraph", text: "No." }] } });
    alice.send({ type: "proposal.decide", request_id: "d1", proposal_id: proposalId, decision: "approve" });
    alice.send({ type: "comment.post", request_id: "c1", thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "no", mentions: [] });
    alice.send({ type: "comment.post", request_id: "c2", thread_id: threadId, doc_name: "brief.docx", target_address: "p[1]", body: "no", mentions: [], resolve: true });
    for (const requestId of ["e1", "e2", "d1", "c1", "c2"]) {
      const refusal = await alice.next((e) => e.type === "error" && e.request_id === requestId);
      expect(refusal).toEqual({ type: "error", request_id: requestId, code: "LICENSE_LIMIT", message: MESSAGE });
    }
    // The socket stays open and subscribed: a read-only room is still a room one watches.
    expect(alice.ws.readyState).toBe(WebSocket.OPEN);
    expect(alice.events.some((e) => e.type === "doc.committed" || e.type === "comment.updated")).toBe(false);
    alice.ws.close();
  });

  test("answers a write before the join with the refusal too, not with a request to join", async () => {
    await seeded(MODE);
    const alice = await connect();
    alice.send({ type: "comment.post", request_id: "c1", thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "no", mentions: [] });
    expect(await alice.next((e) => e.type === "error")).toEqual({ type: "error", request_id: "c1", code: "LICENSE_LIMIT", message: MESSAGE });
    alice.ws.close();
  });
});

describe("over the MCP endpoint", () => {
  const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  const mcpPost = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.mcpUrl}?room=r1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

  /** Open a session as the robot and return a function that calls one tool in it. */
  async function session(): Promise<(name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }>> {
    const opened = await mcpPost(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }), auth("t-robot"));
    expect(opened.status).toBe(200);
    const headers = { ...auth("t-robot"), "mcp-session-id": opened.headers.get("mcp-session-id")! };
    expect((await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
    let id = 1;
    return async (name, args) => {
      const answer = (await (await mcpPost(rpc(++id, "tools/call", { name, arguments: args }), headers)).json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
      return answer.result;
    };
  }

  const errorOf = (result: { isError?: boolean; structuredContent: Record<string, unknown> }): { code: string; message: string } => {
    expect(result.isError).toBe(true);
    return result.structuredContent.error as { code: string; message: string };
  };

  test("refuses each write tool with the same code and message, even for a document, thread or pack that does not exist", async () => {
    const pack = join(dir, "pack");
    await mkdir(pack);
    await writeFile(join(pack, "pack.wolf.json"), manifestBytes(manifest([])));
    await seeded(MODE, { pack: { dir: pack } });
    const tool = await session();
    const calls: [string, Record<string, unknown>][] = [
      ["doc_create", { name: "plan.docx", format: "docx" }],
      ["doc_create", { name: "plan.docx", format: "docx", template: "ghost.docx" }],
      ["doc_edit", { doc: "brief.docx", base_revision: 1, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] }],
      ["doc_edit", { doc: "brief.docx", base_revision: 1, mode: "propose", ops: [{ op: "append_paragraph", text: "No." }] }],
      ["doc_edit", { doc: "ghost.docx", base_revision: 7, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] }],
      ["comment_reply", { thread_id: threadId, body: "No.", resolve: true }],
      ["comment_reply", { thread_id: "ghost", body: "No." }],
      ["pack_link_refresh", { pack: "pack" }],
      ["pack_link_refresh", { pack: "ghost", mode: "commit" }],
    ];
    for (const [name, args] of calls) expect(errorOf(await tool(name, args))).toEqual({ code: "LICENSE_LIMIT", message: MESSAGE });
    const state = (await (await call("/api/rooms/r1", { headers: auth() })).json()) as { documents: { head: { name: string; revision: number } }[] };
    expect(state.documents.map((d) => [d.head.name, d.head.revision])).toEqual([["brief.docx", 1]]);
  });

  test("keeps the read tools working, though the room refuses the activity they announce", async () => {
    await seeded(MODE);
    const tool = await session();
    const list = await tool("workspace_list", {});
    expect(list.isError).toBeUndefined();
    expect(list.structuredContent.room_id).toBe("r1");
    const read = await tool("doc_read", { doc: "brief.docx", view: "text" });
    expect(read.isError).toBeUndefined();
    expect(JSON.stringify(read.structuredContent)).toContain("Revenue grew in Q3.");
  });
});

describe("without the mode", () => {
  test("GET /api/me reports only the actor and every write is served", async () => {
    await seeded();
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE });
    expect((await postJson("/api/rooms", { room_id: "r2", workspace_id: "ws" })).status).toBe(201);
    expect((await call("/api/rooms/r2/docs?name=second.docx", { method: "POST", headers: auth(), body: word(["two"]) })).status).toBe(201);
  });
});

describe("the plan record of serve --plan-record", () => {
  const MARK = { reason: "trial-ended", since: "2026-11-28T00:00:00.000Z", payUrl: "https://cloud.example.test/pay" };
  const PLAN_MESSAGE = "workspace-read-only: The trial ended on 2026-11-28. To keep editing, pay at https://cloud.example.test/pay.";
  /** Replaces the record whole, beside it and renamed over it, as the control plane does. */
  const replace = async (path: string, record: unknown): Promise<void> => {
    await writeFile(`${path}.tmp`, JSON.stringify(record));
    await rename(`${path}.tmp`, path);
  };

  test("refuses to start on a file that is missing or not a plan record, and says what is wrong", async () => {
    const path = join(dir, "plan-record.json");
    expect(() => watchPlanRecord(path, () => {})).toThrow(UsageError);
    expect(() => watchPlanRecord(path, () => {})).toThrow("cannot use the plan record");
    const cases: [string, string][] = [
      ["{", "is not JSON"],
      ["{}", "whose readOnly is null or"],
      [JSON.stringify({ readOnly: "trial-ended" }), "whose readOnly is null or"],
      [JSON.stringify({ readOnly: { ...MARK, reason: "storage-limit" } }), '"storage-limit"'],
      [JSON.stringify({ readOnly: { ...MARK, since: "the 28th" } }), "ISO 8601"],
      [JSON.stringify({ readOnly: { ...MARK, payUrl: "ftp://cloud.example.test/pay" } }), "page to pay on"],
    ];
    for (const [text, words] of cases) {
      await writeFile(path, text);
      expect(() => watchPlanRecord(path, () => {})).toThrow(words);
    }
    await writeFile(path, JSON.stringify({ readOnly: MARK }));
    expect(watchPlanRecord(path, () => {}).current()).toEqual(MARK as never);
  });

  test("a running server follows the file: writes refused with the reason on the record, then served once it is paid, with no restart", async () => {
    const path = join(dir, "plan-record.json");
    await replace(path, { readOnly: null });
    const lines: string[] = [];
    const plan = watchPlanRecord(path, (line) => lines.push(line));
    await seeded(undefined, { planReadOnly: () => plan.current() });
    expect((await postJson("/api/rooms", { room_id: "r2", workspace_id: "ws" })).status).toBe(201);
    await replace(path, { readOnly: MARK });
    const refused = await postJson("/api/rooms", { room_id: "r3", workspace_id: "ws" });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: { code: "LICENSE_LIMIT", message: PLAN_MESSAGE } });
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({
      actor: ALICE,
      readOnly: { reason: "The trial ended on 2026-11-28.", upgrade: "To keep editing, pay at https://cloud.example.test/pay." },
    });
    // A record caught half written keeps the mark in force, and is reported once.
    await writeFile(path, '{"readOnly": ');
    expect((await postJson("/api/rooms", { room_id: "r3", workspace_id: "ws" })).status).toBe(402);
    expect((await postJson("/api/rooms", { room_id: "r3", workspace_id: "ws" })).status).toBe(402);
    expect(lines).toEqual([expect.stringContaining("keeping the mark read before (read-only, trial-ended)")]);
    await replace(path, { readOnly: null });
    expect((await postJson("/api/rooms", { room_id: "r3", workspace_id: "ws" })).status).toBe(201);
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE });
  });
});
