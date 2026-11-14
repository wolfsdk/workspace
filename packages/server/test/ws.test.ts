// The WebSocket endpoint on a real local port: real sockets, JSON text frames, the room server and the
// stand-in reactor behind it. Everything the server sends is checked against the contract.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ROOM_REVISION_MISMATCH, type RoomActor, type RoomServerEvent, validateRoomEvent } from "@wolfsdk/protocol/workspace";
import { startWsServer, type WsServer } from "../src/index.ts";
import { alice, bob, bytesOf, type Harness, makeHarness, must, robot, seedRoom } from "./fixtures/harness.ts";

type ErrorEvent = Extract<RoomServerEvent, { type: "error" }>;

/** What the endpoint answers to a binary frame; `Client.settle` sends one and waits for this. */
const BINARY_REFUSAL = "messages are JSON text frames";

/** A socket that remembers every event it is sent. A wait that is never satisfied ends with the test runner's own timeout. */
class Client {
  readonly events: RoomServerEvent[] = [];
  readonly closed = Promise.withResolvers<void>();
  /** The code of the close frame, once the socket is closed. */
  closeCode: number | null = null;
  private watchers: Array<() => void> = [];
  private barriers: Array<() => void> = [];

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as RoomServerEvent;
      if (this.barriers.length > 0 && event.type === "error" && event.request_id === null && event.message === BINARY_REFUSAL) {
        this.barriers.shift()?.();
        return;
      }
      this.events.push(event);
      for (const wake of this.watchers.splice(0)) wake();
    };
    socket.onclose = (event) => {
      this.closeCode = event.code;
      this.closed.resolve();
    };
  }

  static async connect(url: string, as: string): Promise<Client> {
    const socket = new WebSocket(`${url}?as=${as}`);
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error(`could not connect as ${as}`));
    await opened.promise;
    return new Client(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  async until(done: () => boolean): Promise<void> {
    while (!done()) {
      const tick = Promise.withResolvers<void>();
      this.watchers.push(tick.resolve);
      await tick.promise;
    }
  }

  /**
   * Resolves once everything the server sent before this call has arrived: frames on one socket are in order, and the
   * server answers the marker frame with an error that is not kept. Replaces "wait a while and see nothing came".
   */
  async settle(): Promise<void> {
    const answered = Promise.withResolvers<void>();
    this.barriers.push(answered.resolve);
    this.socket.send(new Uint8Array([0]));
    await answered.promise;
  }

  /** Wait until `n` events have arrived in all. */
  count(n: number): Promise<void> {
    return this.until(() => this.events.length >= n);
  }

  /** The events that arrived after the first `skip`, once at least `n` of them are there. */
  async after(skip: number, n: number): Promise<RoomServerEvent[]> {
    await this.count(skip + n);
    return this.events.slice(skip);
  }

  close(): void {
    this.socket.close();
  }
}

const actorFor = (name: string | null): RoomActor | null => {
  if (name === "alice") return alice;
  if (name === "bob") return bob;
  if (name === "robot") return robot;
  if (name?.startsWith("user-")) return { kind: "user", id: name, name };
  return null;
};

let h: Harness;
let ws: WsServer;
let clients: Client[] = [];
beforeEach(async () => {
  h = await makeHarness();
  await seedRoom(h);
  ws = startWsServer({ service: h.server, authenticate: (request) => actorFor(new URL(request.url).searchParams.get("as")) });
});
afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await ws.stop();
  await h.dispose();
});

const connect = async (as: string): Promise<Client> => {
  const client = await Client.connect(ws.url, as);
  clients.push(client);
  return client;
};
const joined = async (as: string, since: number | null = null, room = "room"): Promise<Client> => {
  const client = await connect(as);
  client.send({ type: "room.join", request_id: "j-1", room_id: room, since_seq: since });
  return client;
};
const append = (text: string) => ({ ops: [{ op: "append", text }] });
const edit = (requestId: string, base: number, text: string, mode = "commit") => ({
  type: "doc.edit",
  request_id: requestId,
  doc_name: "doc.docx",
  base_revision: base,
  mode,
  batch: append(text),
});
const errorOf = (event: RoomServerEvent | undefined): ErrorEvent => {
  if (event?.type !== "error") throw new Error(`expected an error event, got ${event?.type}`);
  return event;
};
const types = (events: readonly RoomServerEvent[]): string[] => events.map((e) => e.type);

describe("the endpoint", () => {
  test("serves /ws only, and only to a client the authenticate hook knows", async () => {
    const http = ws.url.replace("ws://", "http://");
    expect((await fetch(http)).status).toBe(401);
    expect((await fetch(`${http}?as=stranger`)).status).toBe(401);
    expect((await fetch(`${http}?as=alice`)).status).toBe(426);
    expect((await fetch(http.replace("/ws", "/elsewhere"))).status).toBe(404);
    const refused = Promise.withResolvers<void>();
    const socket = new WebSocket(`${ws.url}?as=stranger`);
    socket.onerror = () => refused.resolve();
    socket.onopen = () => refused.reject(new Error("a stranger was let in"));
    await refused.promise;
  });

  test("a client that joins is sent the room as a snapshot that validates", async () => {
    const a = await joined("alice");
    const [snapshot] = await a.after(0, 1);
    expect(snapshot).toMatchObject({ type: "room.snapshot", seq: 1, room: { room_id: "room", workspace_id: "ws" } });
    expect(validateRoomEvent(snapshot)).toEqual([]);
    const unknown = await connect("alice");
    unknown.send({ type: "room.join", request_id: "j-2", room_id: "nowhere", since_seq: null });
    expect(errorOf((await unknown.after(0, 1))[0])).toMatchObject({ request_id: "j-2", code: "UNKNOWN_ROOM" });
  });
});

describe("a session over the socket", () => {
  test("a commit reaches every client in the room, the sender included, as the same events", async () => {
    const [a, b, bystander] = [await joined("alice"), await joined("bob"), await connect("robot")];
    await a.count(1);
    await b.count(1);
    a.send(edit("r-1", 0, "!"));
    const fromA = await a.after(1, 2);
    const fromB = await b.after(1, 2);
    expect(types(fromA)).toEqual(["doc.committed", "pages.invalidated"]);
    expect(fromB).toEqual(fromA);
    expect(fromA[0]).toMatchObject({ type: "doc.committed", head: { revision: 1, name: "doc.docx" }, entry: { author: alice, revision: 1 } });
    for (const event of [...a.events, ...b.events]) expect(validateRoomEvent(event)).toEqual([]);
    await bystander.settle();
    expect(bystander.events).toEqual([]);
  });

  test("a refused request is an error event for the sender alone, with the request_id and the head to rebase on", async () => {
    const [a, b] = [await joined("alice"), await joined("bob")];
    await a.count(1);
    await b.count(1);
    a.send(edit("r-1", 0, "!"));
    await a.count(3);
    await b.count(3);
    b.send(edit("r-2", 0, "?"));
    const refusal = errorOf((await b.after(3, 1))[0]);
    expect(refusal).toMatchObject({ request_id: "r-2", code: "REVISION_MISMATCH" });
    if (refusal.code !== ROOM_REVISION_MISMATCH) throw new Error(`expected a revision mismatch, got ${refusal.code}`);
    expect(refusal.detail).toMatchObject({ doc_name: "doc.docx", base_revision: 0, head: { revision: 1 } });
    expect(validateRoomEvent(refusal)).toEqual([]);
    await a.settle();
    expect(a.events).toHaveLength(3);
    b.send(edit("r-3", 1, "?"));
    await b.count(6);
    expect(types(b.events.slice(4))).toEqual(["doc.committed", "pages.invalidated"]);
  });

  test("a proposal by an agent is decided by a user: every step is an event for everyone", async () => {
    const [a, agent] = [await joined("alice"), await joined("robot")];
    await a.count(1);
    await agent.count(1);
    agent.send(edit("r-1", 0, "!", "propose"));
    const [opened] = await a.after(1, 1);
    expect(opened).toMatchObject({ type: "proposal.updated", proposal: { status: "open", author: robot } });
    if (opened?.type !== "proposal.updated") throw new Error("unreachable");
    expect((await agent.after(1, 1))[0]).toEqual(opened);
    a.send({ type: "proposal.decide", request_id: "r-2", proposal_id: opened.proposal.proposal_id, decision: "approve" });
    const steps = await agent.after(2, 3);
    expect(types(steps)).toEqual(["proposal.updated", "doc.committed", "pages.invalidated"]);
    expect(steps[0]).toMatchObject({ proposal: { status: "approved" } });
    expect(steps[1]).toMatchObject({ entry: { author: robot, proposal_id: opened.proposal.proposal_id } });
    expect(await a.after(2, 3)).toEqual(steps);
    a.send({ type: "proposal.decide", request_id: "r-3", proposal_id: opened.proposal.proposal_id, decision: "approve" });
    expect(errorOf((await a.after(5, 1))[0])).toMatchObject({ request_id: "r-3", code: "PROPOSAL_NOT_OPEN" });
  });

  test("an agent that sends proposal.decide gets FORBIDDEN, for its own proposal and for a user's; nothing changes for anyone", async () => {
    const [a, agent] = [await joined("alice"), await joined("robot")];
    await a.count(1);
    await agent.count(1);
    agent.send(edit("r-1", 0, "!", "propose"));
    const [byAgent] = await a.after(1, 1);
    a.send(edit("r-2", 0, "?", "propose"));
    const [, byUser] = await a.after(1, 2);
    if (byAgent?.type !== "proposal.updated" || byUser?.type !== "proposal.updated") throw new Error("expected two proposals");
    await agent.count(3);
    const [own, others] = [byAgent.proposal.proposal_id, byUser.proposal.proposal_id];
    agent.send({ type: "proposal.decide", request_id: "r-3", proposal_id: own, decision: "approve" });
    agent.send({ type: "proposal.decide", request_id: "r-4", proposal_id: others, decision: "approve" });
    agent.send({ type: "proposal.decide", request_id: "r-5", proposal_id: own, decision: "reject" });
    const refusals = await agent.after(3, 3);
    expect(refusals.map((e) => errorOf(e))).toMatchObject([
      { request_id: "r-3", code: "FORBIDDEN" },
      { request_id: "r-4", code: "FORBIDDEN" },
      { request_id: "r-5", code: "FORBIDDEN" },
    ]);
    await a.settle();
    expect(a.events).toHaveLength(3);
    const room = must(await h.server.getRoom("room", alice));
    expect(room.proposals.map((p) => p.status)).toEqual(["open", "open"]);
    expect(room.session_log).toEqual([]);
    expect(room.documents[0]?.head.revision).toBe(0);
    // A user's decision still goes through.
    a.send({ type: "proposal.decide", request_id: "r-6", proposal_id: others, decision: "approve" });
    expect(types(await a.after(3, 4))).toEqual(["proposal.updated", "doc.committed", "pages.invalidated", "proposal.updated"]);
  });

  test("a comment becomes a thread, and a reply to it the same thread", async () => {
    const [a, b] = [await joined("alice"), await joined("bob")];
    await a.count(1);
    await b.count(1);
    b.send({ type: "comment.post", request_id: "r-1", thread_id: null, doc_name: "doc.docx", target_address: "p1", body: "look", mentions: [{ kind: "user", id: "alice" }] });
    const [first] = await a.after(1, 1);
    if (first?.type !== "comment.updated") throw new Error(`expected comment.updated, got ${first?.type}`);
    expect(first.thread).toMatchObject({ doc_name: "doc.docx", resolved: false, mentions: [{ kind: "user", id: "alice" }] });
    a.send({ type: "comment.post", request_id: "r-2", thread_id: first.thread.thread_id, doc_name: "doc.docx", target_address: "p1", body: "seen", mentions: [] });
    const [second] = await b.after(2, 1);
    expect(second).toMatchObject({ type: "comment.updated", thread: { thread_id: first.thread.thread_id } });
    expect(second?.type === "comment.updated" ? second.thread.messages.map((m) => m.body) : []).toEqual(["look", "seen"]);
  });

  test("a reply that resolves a thread marks it resolved for everyone; resolving a thread that is not there yet is refused", async () => {
    const [a, b] = [await joined("alice"), await joined("bob")];
    await a.count(1);
    await b.count(1);
    const post = { type: "comment.post", doc_name: "doc.docx", target_address: "p1", mentions: [] };
    b.send({ ...post, request_id: "r-1", thread_id: null, body: "look" });
    const [first] = await a.after(1, 1);
    if (first?.type !== "comment.updated") throw new Error(`expected comment.updated, got ${first?.type}`);
    a.send({ ...post, request_id: "r-2", thread_id: first.thread.thread_id, body: "done", resolve: true });
    const [resolved] = await b.after(2, 1);
    expect(resolved).toMatchObject({ type: "comment.updated", thread: { thread_id: first.thread.thread_id, resolved: true } });
    expect(validateRoomEvent(resolved)).toEqual([]);
    expect(must(await h.server.getRoom("room", alice)).comments.map((t) => t.resolved)).toEqual([true]);
    a.send({ ...post, request_id: "r-3", thread_id: null, body: "new", resolve: true });
    const refusal = errorOf((await a.after(3, 1))[0]);
    expect(refusal).toMatchObject({ request_id: "r-3", code: "BAD_REQUEST" });
    expect(refusal.message).toContain("nothing to resolve");
  });

  test("a document added to the room reaches the clients as a doc.added", async () => {
    const a = await joined("alice");
    await a.count(1);
    must(await h.server.addDocument("room", alice, { name: "b.docx", format: "docx", bytes: bytesOf("bee") }));
    const [added] = await a.after(1, 1);
    expect(added).toMatchObject({ type: "doc.added", seq: 2, document: { head: { name: "b.docx", revision: 0 } } });
    expect(validateRoomEvent(added)).toEqual([]);
  });

  test("joining another room moves the subscription; the old room goes quiet", async () => {
    const other = await h.server.createRoom(alice, { room_id: "room-2", workspace_id: "ws" });
    expect(other.ok).toBe(true);
    const a = await joined("alice");
    const b = await joined("bob");
    await a.count(1);
    await b.count(1);
    a.send({ type: "room.join", request_id: "j-2", room_id: "room-2", since_seq: null });
    await a.count(2);
    expect(a.events[1]).toMatchObject({ type: "room.snapshot", room: { room_id: "room-2" } });
    b.send(edit("r-1", 0, "!"));
    await b.count(3);
    await a.settle();
    expect(a.events).toHaveLength(2);
  });
});

describe("resuming", () => {
  test("a client back from a disconnect, with its last seq, is sent the events it missed and nothing else", async () => {
    const a = await joined("alice");
    const b = await joined("bob");
    await a.count(1);
    await b.count(1);
    a.send(edit("r-1", 0, "!"));
    await a.count(3);
    const lastSeen = a.events.at(-1);
    if (lastSeen === undefined || lastSeen.type === "error") throw new Error("unreachable");
    a.close();
    await a.closed.promise;
    b.send(edit("r-2", 1, "?"));
    b.send(edit("r-3", 2, "#"));
    await b.count(7);
    const again = await joined("alice", lastSeen.seq);
    const missed = await again.after(0, 4);
    expect(types(missed)).toEqual(["doc.committed", "pages.invalidated", "doc.committed", "pages.invalidated"]);
    expect(missed).toEqual(b.events.slice(3));
    await again.settle();
    expect(again.events).toHaveLength(4);
  });

  test("a client that is up to date is sent nothing; one that is ahead of the room, or new, is sent the snapshot", async () => {
    const upToDate = await joined("alice", 1);
    const ahead = await joined("bob", 500);
    const fresh = await joined("robot", null);
    await ahead.count(1);
    await fresh.count(1);
    expect(ahead.events[0]).toMatchObject({ type: "room.snapshot", seq: 1 });
    expect(fresh.events[0]).toMatchObject({ type: "room.snapshot", seq: 1 });
    await upToDate.settle();
    expect(upToDate.events).toEqual([]);
  });
});

describe("bad input", () => {
  test("a message that is not JSON, not text, or not a message of the contract is a BAD_REQUEST, and the socket stays usable", async () => {
    const a = await connect("alice");
    a.sendRaw("this is not json");
    a.sendRaw(new Uint8Array([1, 2, 3]));
    a.send({ type: "doc.edit", request_id: "r-9" });
    a.send({ type: "room.leave", request_id: "r-10" });
    const events = await a.after(0, 4);
    expect(events.map((e) => errorOf(e).code)).toEqual(["BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST", "BAD_REQUEST"]);
    expect(events.map((e) => errorOf(e).request_id)).toEqual([null, null, "r-9", "r-10"]);
    for (const event of events) expect(validateRoomEvent(event)).toEqual([]);
    a.send({ type: "room.join", request_id: "j-1", room_id: "room", since_seq: null });
    await a.count(5);
    expect(a.events[4]?.type).toBe("room.snapshot");
  });

  test("nothing can be edited before a room is joined", async () => {
    const a = await connect("alice");
    a.send(edit("r-1", 0, "!"));
    const refusal = errorOf((await a.after(0, 1))[0]);
    expect(refusal).toMatchObject({ request_id: "r-1", code: "BAD_REQUEST" });
    expect(refusal.message).toContain("join a room first");
  });

  test("the licence applies on the socket: the sixth signed-in user is refused with LICENSE_LIMIT", async () => {
    for (const n of [1, 2, 3, 4]) {
      const client = await joined(`user-${n}`);
      await client.count(1);
      expect(client.events[0]?.type).toBe("room.snapshot");
    }
    const sixth = await joined("user-5");
    expect(errorOf((await sixth.after(0, 1))[0])).toMatchObject({ request_id: "j-1", code: "LICENSE_LIMIT" });
  });

  test("a client whose seat is released is told so, is in no room, and joins again for a seat", async () => {
    const b = await joined("bob");
    await b.count(1);
    expect(h.server.releaseSeat("user", "bob")).toBe(true);
    expect(errorOf((await b.after(1, 1))[0])).toMatchObject({ request_id: null, code: "LICENSE_LIMIT" });
    b.send(edit("r-1", 0, "!"));
    const refusal = errorOf((await b.after(2, 1))[0]);
    expect(refusal).toMatchObject({ request_id: "r-1", code: "BAD_REQUEST" });
    expect(refusal.message).toContain("join a room first");
    b.send({ type: "room.join", request_id: "j-2", room_id: "room", since_seq: null });
    expect((await b.after(3, 1))[0]?.type).toBe("room.snapshot");
    expect(h.server.listSeats().map((s) => s.id)).toEqual(["alice", "bob"]);
  });
});

describe("a damaged room", () => {
  test("a client that joins it is told nothing and is closed with an internal error; the room stays usable for the others", async () => {
    const db = new Database(`${h.dir}/rooms.sqlite`);
    try {
      db.run("UPDATE events SET body = 'not json' WHERE room_id = 'room'");
    } finally {
      db.close();
    }
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const resuming = await joined("alice", 0);
      await resuming.closed.promise;
      expect(resuming.closeCode).toBe(1011);
      expect(resuming.events).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    const fresh = await joined("bob", null);
    await fresh.count(1);
    expect(fresh.events[0]?.type).toBe("room.snapshot");
  });
});

describe("stopping", () => {
  test("stop closes every connection", async () => {
    const a = await joined("alice");
    await a.count(1);
    await ws.stop();
    await a.closed.promise;
    ws = startWsServer({ service: h.server, authenticate: () => null });
  });
});
