// A guest of one shared document over the real HTTP handler, the room socket and the MCP endpoint, composed as `serve`
// composes them: the actors file decides the scope, the service is scoped, and a guest takes no seat.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { RoomServer, scopedService } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { type ActorDirectory, watchActorDirectory } from "../src/actors.ts";
import { startWorkspaceServer, tokenOf, type WorkspaceServer } from "../src/http.ts";

// Writes are flushed to disk and sockets are opened: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const GUEST_DOCS = { docs: [{ room: "r1", doc: "brief.docx" }] };
const ENTRIES = {
  "t-alice": { kind: "user", id: "alice", name: "Alice" },
  "t-robot": { kind: "agent", id: "robot", name: "Robot", operator: { id: "alice", name: "Alice" } },
  "t-gail": { kind: "user", id: "gail", name: "Gail", guest: GUEST_DOCS },
  "t-gail-bot": { kind: "agent", id: "gail-bot", name: "Gail Bot", operator: { id: "gail", name: "Gail" } },
  "t-lone-bot": { kind: "agent", id: "lone-bot", name: "Lone Bot", guest: GUEST_DOCS },
};
const LINES = ["Quarterly brief", "Revenue grew in Q3."];
const SHARE_URL = "/api/rooms/r1/docs/brief.docx/share";

let dir: string;
let actorsFile: string;
let actors: { current(): ActorDirectory };
let room: RoomServer;
let server: WorkspaceServer;

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${server.url}${path}`, init);
const as = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
  call(path, { method, headers: { ...auth(token), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const errorCode = async (response: Response): Promise<string | undefined> => ((await response.json()) as { error?: { code?: string } }).error?.code;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-guest-"));
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(join(dir, "ui", "index.html"), "<!doctype html>");
  actorsFile = join(dir, "actors.json");
  await writeFile(actorsFile, JSON.stringify(ENTRIES));
  actors = await watchActorDirectory(actorsFile, () => {});
  const scopeOf = (actor: Parameters<ActorDirectory["scopeOf"]>[0]) => actors.current().scopeOf(actor);
  room = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new MemoryEngine(),
    operatorOf: (actor) => actors.current().operatorOf(actor),
    seatless: (actor) => scopeOf(actor) !== null,
  });
  server = startWorkspaceServer({
    service: scopedService(room, scopeOf),
    scopeOf,
    shares: room,
    mcp: { packManifests: async () => [{ contract: "wolfsdk.pack.v1", pack_id: "board", name: "Board pack", sources: [], bindings: [] }] },
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (actors.current().actors.get(token) ?? null);
    },
    staticDir: join(dir, "ui"),
  });
  for (const id of ["r1", "r2"]) expect((await as("t-alice", "POST", "/api/rooms", { room_id: id, workspace_id: "ws" })).status).toBe(201);
  const upload = (roomId: string, name: string) => call(`/api/rooms/${roomId}/docs?name=${name}`, { method: "POST", headers: auth("t-alice"), body: new Uint8Array(wordDocument(LINES)) });
  for (const [roomId, name] of [["r1", "brief.docx"], ["r1", "other.docx"], ["r2", "secret.docx"]] as const) expect((await upload(roomId, name)).status).toBe(201);
});

afterEach(async () => {
  await server?.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

/** A WebSocket client of `/ws` that keeps every event and waits for the one a test needs. */
async function connect(token: string): Promise<{ events: RoomServerEvent[]; next(match: (e: RoomServerEvent) => boolean): Promise<RoomServerEvent>; send(message: unknown): void }> {
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

type ToolAnswer = { isError?: boolean; structuredContent: Record<string, unknown> };

/** An MCP session of `token` in the room the query names (none by default), and a function that calls one tool in it. */
async function mcpSession(token: string, query = ""): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolAnswer>> {
  const post = (body: unknown, headers: Record<string, string>) =>
    fetch(`${server.mcpUrl}${query}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const opened = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, auth(token));
  expect(opened.status).toBe(200);
  const headers = { ...auth(token), "mcp-session-id": opened.headers.get("mcp-session-id")! };
  expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
  let id = 1;
  return async (name, args) => ((await (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, headers)).json()) as { result: ToolAnswer }).result;
}

const mcpOpen = (token: string, query: string): Promise<Response> =>
  fetch(`${server.mcpUrl}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth(token) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });

describe("a guest over HTTP", () => {
  test("says who it is and which documents it may reach, and members and their agents are not guests", async () => {
    const me = await (await as("t-gail", "GET", "/api/me")).json();
    expect(me).toEqual({ actor: { kind: "user", id: "gail", name: "Gail" }, guest: { docs: [{ room_id: "r1", doc_name: "brief.docx" }] } });
    expect(await (await as("t-alice", "GET", "/api/me")).json()).toMatchObject({ guest: null });
    expect(await (await as("t-robot", "GET", "/api/me")).json()).toMatchObject({ guest: null });
    // An agent of the guest, and an agent with a guest field of its own, answer the same scope.
    for (const token of ["t-gail-bot", "t-lone-bot"]) {
      expect(await (await as(token, "GET", "/api/me")).json()).toMatchObject({ guest: { docs: [{ room_id: "r1", doc_name: "brief.docx" }] } });
    }
  });

  test("lists only its room and sees only its document in it", async () => {
    for (const token of ["t-gail", "t-gail-bot"]) {
      const rooms = (await (await as(token, "GET", "/api/rooms")).json()) as { rooms: { room_id: string }[] };
      expect(rooms.rooms.map((r) => r.room_id)).toEqual(["r1"]);
      const state = (await (await as(token, "GET", "/api/rooms/r1")).json()) as { documents: { head: { name: string } }[] };
      expect(state.documents.map((d) => d.head.name)).toEqual(["brief.docx"]);
    }
    const members = (await (await as("t-alice", "GET", "/api/rooms")).json()) as { rooms: { room_id: string }[] };
    expect(members.rooms.map((r) => r.room_id).sort()).toEqual(["r1", "r2"]);
  });

  test("reads the head and the preview of its document, and finds the rest as unknown as a room that is not there", async () => {
    const head = await as("t-gail", "GET", "/api/rooms/r1/docs/brief.docx/head");
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const unknown = await as("t-gail", "GET", "/api/rooms/nope/docs/brief.docx/head");
    const otherRoom = await as("t-gail", "GET", "/api/rooms/r2/docs/secret.docx/head");
    expect(otherRoom.status).toBe(unknown.status);
    // The answer is the one for a room that is not there, down to the words, once the name asked for is set aside.
    expect(JSON.stringify(await otherRoom.json()).replace("r2", "nope")).toBe(JSON.stringify(await unknown.json()));
    expect((await as("t-gail", "GET", "/api/rooms/r2")).status).toBe((await as("t-gail", "GET", "/api/rooms/nope")).status);

    const sibling = await as("t-gail", "GET", "/api/rooms/r1/docs/other.docx/head");
    const missing = await as("t-gail", "GET", "/api/rooms/r1/docs/none.docx/head");
    expect(sibling.status).toBe(missing.status);
    expect(JSON.stringify(await sibling.json()).replace("other.docx", "none.docx")).toBe(JSON.stringify(await missing.json()));
  });

  test("is refused a room, an upload, the export, the pack and a share link, each with 403 FORBIDDEN", async () => {
    const refusals: [string, string, unknown?][] = [
      ["POST", "/api/rooms", { room_id: "mine" }],
      ["POST", "/api/rooms/r1/docs?name=new.docx"],
      ["GET", "/api/export"],
      ["POST", "/api/pack"],
      ["POST", "/api/pack/refresh"],
      ["GET", SHARE_URL],
      ["PUT", SHARE_URL],
      ["DELETE", SHARE_URL],
    ];
    for (const token of ["t-gail", "t-gail-bot", "t-lone-bot"]) {
      for (const [method, path, body] of refusals) {
        const answer = method === "POST" && path.includes("/docs?") ? await call(path, { method, headers: auth(token), body: new Uint8Array(wordDocument(["No."])) }) : await as(token, method, path, body);
        expect([token, method, path, answer.status, await errorCode(answer)]).toEqual([token, method, path, 403, "FORBIDDEN"]);
      }
    }
    // Nothing the guest tried changed the workspace.
    const rooms = (await (await as("t-alice", "GET", "/api/rooms")).json()) as { rooms: { room_id: string }[] };
    expect(rooms.rooms.map((r) => r.room_id).sort()).toEqual(["r1", "r2"]);
    const state = (await (await as("t-alice", "GET", "/api/rooms/r1")).json()) as { documents: { head: { name: string } }[] };
    expect(state.documents.map((d) => d.head.name).sort()).toEqual(["brief.docx", "other.docx"]);
  });

  test("is cut off from the document at once when the actors file drops it, and from everything when the file drops the token", async () => {
    expect((await as("t-gail", "GET", "/api/rooms/r1/docs/brief.docx/head")).status).toBe(200);
    await writeFile(actorsFile, JSON.stringify({ ...ENTRIES, "t-gail": { ...ENTRIES["t-gail"], guest: { docs: [{ room: "r1", doc: "other.docx" }] } } }));
    expect((await as("t-gail", "GET", "/api/rooms/r1/docs/brief.docx/head")).status).toBe(404);
    expect((await as("t-gail", "GET", "/api/rooms/r1/docs/other.docx/head")).status).toBe(200);
    // The agent that inherits follows the same scope.
    expect((await as("t-gail-bot", "GET", "/api/rooms/r1/docs/brief.docx/head")).status).toBe(404);

    const { "t-gail": _gone, ...rest } = ENTRIES;
    await writeFile(actorsFile, JSON.stringify(rest));
    expect((await as("t-gail", "GET", "/api/me")).status).toBe(401);
  });

  test("takes no seat, however it reads", async () => {
    await as("t-gail", "GET", "/api/rooms/r1");
    await as("t-gail-bot", "GET", "/api/rooms/r1");
    await as("t-lone-bot", "GET", "/api/rooms/r1");
    // The seat of Alice is the one her own requests took while the workspace was set up.
    expect(room.listSeats().map((s) => s.id)).toEqual(["alice"]);
  });
});

describe("a guest over the room socket", () => {
  test("joins its room and hears of its document alone", async () => {
    const gail = await connect("t-gail");
    gail.send({ type: "room.join", request_id: "j1", room_id: "r1", since_seq: null });
    const snapshot = await gail.next((e) => e.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.room.documents.map((d) => d.head.name)).toEqual(["brief.docx"]);

    // A member's change to the other document in the room is not heard; the next change to the guest's is.
    const alice = await connect("t-alice");
    alice.send({ type: "room.join", request_id: "a1", room_id: "r1", since_seq: null });
    await alice.next((e) => e.type === "room.snapshot");
    alice.send({ type: "doc.edit", request_id: "e1", doc_name: "other.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Elsewhere." }] } });
    await alice.next((e) => e.type === "doc.committed" && e.head.name === "other.docx");
    alice.send({ type: "doc.edit", request_id: "e2", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Here." }] } });
    await gail.next((e) => e.type === "doc.committed" && e.head.name === "brief.docx");
    expect(gail.events.some((e) => e.type === "doc.committed" && e.head.name === "other.docx")).toBe(false);
  });

  test("finds a room of someone else as unknown as a room that is not there", async () => {
    const gail = await connect("t-gail");
    gail.send({ type: "room.join", request_id: "j1", room_id: "r2", since_seq: null });
    gail.send({ type: "room.join", request_id: "j2", room_id: "nope", since_seq: null });
    const other = await gail.next((e) => e.type === "error" && e.request_id === "j1");
    const none = await gail.next((e) => e.type === "error" && e.request_id === "j2");
    if (other.type !== "error" || none.type !== "error") throw new Error("both joins must be refused");
    expect([other.code, other.message.replace("r2", "nope")]).toEqual([none.code, none.message]);
  });

  test("proposes an edit and is refused a commit, a decision and the assistant", async () => {
    const gail = await connect("t-gail");
    gail.send({ type: "room.join", request_id: "j1", room_id: "r1", since_seq: null });
    await gail.next((e) => e.type === "room.snapshot");

    gail.send({ type: "doc.edit", request_id: "c1", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "No." }] } });
    const refused = await gail.next((e) => e.type === "error" && e.request_id === "c1");
    expect(refused.type === "error" && refused.code).toBe("FORBIDDEN");

    gail.send({ type: "doc.edit", request_id: "p1", doc_name: "brief.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "replace_text", find: "Q3", text: "the third quarter" }], label: "Spell out" } });
    const proposed = await gail.next((e) => e.type === "proposal.updated" && e.proposal.status === "open");
    if (proposed.type !== "proposal.updated") throw new Error("expected a proposal");
    expect(proposed.proposal.author).toEqual({ kind: "user", id: "gail", name: "Gail" });

    gail.send({ type: "proposal.decide", request_id: "d1", proposal_id: proposed.proposal.proposal_id, decision: "approve" });
    const decided = await gail.next((e) => e.type === "error" && e.request_id === "d1");
    expect(decided.type === "error" && decided.code).toBe("FORBIDDEN");

    gail.send({ type: "doc.edit", request_id: "p2", doc_name: "other.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append_paragraph", text: "No." }] } });
    const outside = await gail.next((e) => e.type === "error" && e.request_id === "p2");
    expect(outside.type === "error" && outside.code).not.toBe(undefined);

    gail.send({ type: "assistant.status", request_id: "s1" });
    const assistant = await gail.next((e) => (e as { type: string }).type === "assistant.error");
    expect(assistant).toMatchObject({ code: "FORBIDDEN", request_id: "s1" });

    // The member sees the proposal and approves it: the guest proposed, the member decided.
    const alice = await connect("t-alice");
    alice.send({ type: "room.join", request_id: "a1", room_id: "r1", since_seq: null });
    await alice.next((e) => e.type === "room.snapshot");
    alice.send({ type: "proposal.decide", request_id: "d2", proposal_id: proposed.proposal.proposal_id, decision: "approve" });
    await alice.next((e) => e.type === "proposal.updated" && e.proposal.status === "approved");
  });
});

describe("a guest over MCP", () => {
  test("lists the configured pack for a member and omits it for a guest in the same room", async () => {
    const member = await mcpSession("t-robot", "?room=r1");
    const guest = await mcpSession("t-gail-bot", "?room=r1");
    expect((await member("workspace_list", {})).structuredContent.packs).toMatchObject([{ pack: "board" }]);
    expect((await guest("workspace_list", {})).structuredContent.packs).toEqual([]);
  });

  test("reads and proposes on its document, as the guest and as its agent, and may not commit", async () => {
    for (const token of ["t-gail-bot", "t-lone-bot"]) {
      const tool = await mcpSession(token, "?room=r1");
      const read = await tool("doc_read", { doc: "brief.docx", view: "text" });
      expect(read.isError).toBeUndefined();
      expect(JSON.stringify(read.structuredContent)).toContain("Revenue grew in Q3.");

      const commit = await tool("doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] });
      expect(commit.isError).toBe(true);

      const proposed = await tool("doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: `From ${token}.` }] });
      expect(proposed.isError).toBeUndefined();
    }
    const state = (await (await as("t-alice", "GET", "/api/rooms/r1")).json()) as { proposals: { author: { id: string }; status: string }[]; documents: { head: { revision: number } }[] };
    expect(state.proposals.map((p) => [p.author.id, p.status]).sort()).toEqual([["gail-bot", "open"], ["lone-bot", "open"]]);
    expect(state.documents.map((d) => d.head.revision)).toEqual([0, 0]);
  });

  test("sees only its document in the room, and needs no room name when it has one", async () => {
    const tool = await mcpSession("t-gail-bot");
    const listed = await tool("workspace_list", {});
    expect(listed.isError).toBeUndefined();
    expect(JSON.stringify(listed.structuredContent)).toContain("brief.docx");
    expect(JSON.stringify(listed.structuredContent)).not.toContain("other.docx");

    const outside = await tool("doc_read", { doc: "other.docx", view: "text" });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.structuredContent)).not.toContain("Revenue");
  });

  test("finds a room outside its scope as unknown as a room that is not there", async () => {
    const other = await mcpOpen("t-gail-bot", "?room=r2");
    const none = await mcpOpen("t-gail-bot", "?room=nope");
    expect(other.status).toBe(404);
    expect(other.status).toBe(none.status);
    expect((await other.json() as { error: { message: string } }).error.message.replace("r2", "nope")).toBe((await none.json() as { error: { message: string } }).error.message);
    // A member's agent still reaches it.
    expect((await mcpOpen("t-robot", "?room=r2")).status).toBe(200);
  });
});
