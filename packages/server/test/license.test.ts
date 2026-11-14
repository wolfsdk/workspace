// The limits of the licence, as the engine reports them: how many workspaces a server serves and how many
// seats it admits (a seat is a signed-in user, or an agent that signs in with an identity of its own). A refusal
// is LICENSE_LIMIT and changes nothing.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, EngineFault, PoolEngine, RoomServer, RoomStore } from "../src/index.ts";
import { claimDatabase } from "../src/store.ts";
import {
  alice,
  bob,
  bytesOf,
  Collector,
  committed,
  type Harness,
  makeHarness,
  makePool,
  must,
  proposed,
  refusalOf,
  robot,
  seedRoom,
  snapshotOf,
  steppingClock,
} from "./fixtures/harness.ts";

const user = (n: number): RoomActor => ({ kind: "user", id: `user-${n}`, name: `User ${n}` });

let h: Harness | undefined;
afterEach(async () => {
  setSystemTime();
  await h?.dispose();
  h = undefined;
});

const harness = async (env: Record<string, string>): Promise<Harness> => {
  h = await makeHarness({ env });
  return h;
};

describe("community licence: one workspace, five users", () => {
  test("a second workspace is refused with LICENSE_LIMIT; more rooms in the first are fine", async () => {
    const { server } = await harness({});
    must(await server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await server.createRoom(alice, { room_id: "room-2", workspace_id: "ws" }));
    const refusal = refusalOf(await server.createRoom(alice, { room_id: "room-3", workspace_id: "other" }));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.message).toContain("1 workspace");
    expect((await server.listRooms()).map((r) => r.room_id).sort()).toEqual(["room", "room-2"]);
    expect(refusalOf(await server.getRoom("room-3", alice)).code).toBe("UNKNOWN_ROOM");
  });

  test("the sixth signed-in user is refused, whatever they try first; nothing they asked for happens", async () => {
    const { server } = await harness({});
    await seedRoom(h as Harness);
    for (const n of [1, 2, 3, 4]) must(await server.addDocument("room", user(n), { name: `u${n}.docx`, format: "docx", bytes: bytesOf(`user ${n}`) }));
    expect(server.listSeats().map((s) => s.id)).toEqual(["alice", "user-1", "user-2", "user-3", "user-4"]);
    const before = await snapshotOf(h as Harness);
    const sixth = user(5);
    expect(refusalOf(await server.addDocument("room", sixth, { name: "x.docx", format: "docx", bytes: bytesOf("x") })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.edit("room", sixth, { doc_name: "doc.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text: "!" }] } })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.postComment("room", sixth, { thread_id: null, doc_name: "doc.docx", target_address: "p1", body: "x", mentions: [] })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.join("room", sixth, null, () => {})).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.createRoom(sixth, { room_id: "mine", workspace_id: "ws" })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.getRoom("room", sixth)).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.readHead("room", sixth, "doc.docx")).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.readPreview("room", sixth, "no-such-proposal")).code).toBe("LICENSE_LIMIT");
    expect(server.listSeats()).toHaveLength(5);
    expect(await snapshotOf(h as Harness)).toEqual(before);
  });

  test("a user who has a seat keeps it; releasing a seat admits the next user", async () => {
    const { server } = await harness({});
    await seedRoom(h as Harness);
    for (const n of [1, 2, 3, 4]) must(await server.join("room", user(n), null, () => {}));
    expect(refusalOf(await server.join("room", user(5), null, () => {})).code).toBe("LICENSE_LIMIT");
    committed(await server.edit("room", user(1), { doc_name: "doc.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text: "!" }] } }));
    expect(server.releaseSeat("user", "user-4")).toBe(true);
    expect(server.releaseSeat("user", "user-4")).toBe(false);
    must(await server.join("room", user(5), null, () => {}));
    expect(server.listSeats().map((s) => s.id)).toEqual(["alice", "user-1", "user-2", "user-3", "user-5"]);
  });

  test("an agent that signs in on its own takes a seat like a user, and the sixth identity is refused whatever it is", async () => {
    const { server } = await harness({});
    await seedRoom(h as Harness);
    for (const n of [1, 2, 3]) must(await server.join("room", user(n), null, () => {}));
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:user-1", "user:user-2", "user:user-3", "agent:robot"]);
    const before = await snapshotOf(h as Harness);
    const second: RoomActor = { kind: "agent", id: "robot-2", name: "Robot Two" };
    expect(refusalOf(await server.reportActivity("room", second, { doc_name: null, activity: "idle" })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.edit("room", second, { doc_name: "doc.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: "!" }] } })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.join("room", user(5), null, () => {})).code).toBe("LICENSE_LIMIT");
    expect(server.listSeats()).toHaveLength(5);
    expect(await snapshotOf(h as Harness)).toEqual(before);
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "reading" }));
  });

  test("a user and an agent that share an id are two identities with a seat each; releasing one leaves the other", async () => {
    const { server } = await harness({});
    await seedRoom(h as Harness);
    must(await server.join("room", { kind: "user", id: "robot", name: "Robin" }, null, () => {}));
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:robot", "agent:robot"]);
    expect(server.releaseSeat("agent", "robot")).toBe(true);
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:robot"]);
  });

  test("an agent that a seated user operates takes no seat, however much it does; one that signs in on its own still does", async () => {
    h = await makeHarness({ operatorOf: (agent) => (agent.id === "robot" ? { id: "alice", name: "Alice" } : null) });
    const { server } = h;
    await seedRoom(h);
    for (const n of [1, 2, 3, 4]) must(await server.join("room", user(n), null, () => {}));
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    proposed(await server.edit("room", robot, { doc_name: "doc.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: "!" }] } }));
    must(await server.join("room", robot, null, () => {}));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:user-1", "user:user-2", "user:user-3", "user:user-4"]);
    const loner: RoomActor = { kind: "agent", id: "loner", name: "Loner" };
    expect(refusalOf(await server.reportActivity("room", loner, { doc_name: null, activity: "idle" })).code).toBe("LICENSE_LIMIT");
  });

  test("an operated agent acts on its operator's seat: an unseated operator takes one, and is refused through its agent when none is left", async () => {
    h = await makeHarness({ operatorOf: (agent) => ({ id: agent.id.replace("bot-", "user-"), name: `Operator of ${agent.id}` }) });
    const { server } = h;
    const bot = (n: number): RoomActor => ({ kind: "agent", id: `bot-${n}`, name: `Bot ${n}` });
    await seedRoom(h);
    for (const n of [1, 2, 3]) must(await server.join("room", user(n), null, () => {}));
    must(await server.reportActivity("room", bot(4), { doc_name: null, activity: "idle" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:user-1", "user:user-2", "user:user-3", "user:user-4"]);
    must(await server.join("room", user(4), null, () => {}));
    const before = await snapshotOf(h);
    expect(refusalOf(await server.join("room", user(5), null, () => {})).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.reportActivity("room", bot(5), { doc_name: null, activity: "idle" })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.edit("room", bot(5), { doc_name: "doc.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: "!" }] } })).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await server.createRoom(bot(5), { room_id: "mine", workspace_id: "ws" })).code).toBe("LICENSE_LIMIT");
    expect(server.listSeats()).toHaveLength(5);
    expect(await snapshotOf(h)).toEqual(before);
  });

  test("an agent that holds a seat of its own is asked about its operator once a minute, not on every request", async () => {
    let at = Date.parse("2026-11-13T10:00:00.000Z");
    let asked = 0;
    const operatorOf = (): null => {
      asked += 1;
      return null;
    };
    h = await makeHarness({ now: () => new Date(at), operatorOf });
    const { server } = h;
    await seedRoom(h);
    for (let n = 0; n < 5; n++) must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(asked).toBe(1);
    at += 59_000;
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(asked).toBe(1);
    at += 1_000;
    for (let n = 0; n < 3; n++) must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(asked).toBe(2);
    expect(server.releaseSeat("agent", "robot")).toBe(true);
    for (let n = 0; n < 3; n++) must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(asked).toBe(3);
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`).sort()).toEqual(["agent:robot", "user:alice"]);
  });

  test("an agent that took a seat of its own gives it up for its operator's, even when every seat is taken", async () => {
    let at = Date.parse("2026-11-13T10:00:00.000Z");
    let operator: { id: string; name: string } | null = null;
    h = await makeHarness({ now: () => new Date(at), operatorOf: () => operator });
    const { server } = h;
    const seats = (): string[] => server.listSeats().map((s) => `${s.kind}:${s.id}`).sort();
    await seedRoom(h);
    for (const n of [1, 2, 3]) must(await server.join("room", user(n), null, () => {}));
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(seats()).toEqual(["agent:robot", "user:alice", "user:user-1", "user:user-2", "user:user-3"]);
    operator = { id: "user-9", name: "User 9" };
    at += 60_000;
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "reading" }));
    expect(seats()).toEqual(["user:alice", "user:user-1", "user:user-2", "user:user-3", "user:user-9"]);
    expect(refusalOf(await server.join("room", user(4), null, () => {})).code).toBe("LICENSE_LIMIT");
    proposed(await server.edit("room", robot, { doc_name: "doc.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: "!" }] } }));
    expect(seats()).toHaveLength(5);
  });

  test("an agent whose new operator already holds a seat just frees its own", async () => {
    let at = Date.parse("2026-11-13T10:00:00.000Z");
    let operator: { id: string; name: string } | null = null;
    h = await makeHarness({ now: () => new Date(at), operatorOf: () => operator });
    const { server } = h;
    await seedRoom(h);
    for (const n of [1, 2, 3]) must(await server.join("room", user(n), null, () => {}));
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(refusalOf(await server.join("room", user(4), null, () => {})).code).toBe("LICENSE_LIMIT");
    operator = { id: "alice", name: "Alice" };
    at += 60_000;
    must(await server.createRoom(robot, { room_id: "room-2", workspace_id: "ws" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`).sort()).toEqual(["user:alice", "user:user-1", "user:user-2", "user:user-3"]);
    must(await server.join("room", user(4), null, () => {}));
  });

  test("the roster survives a restart: nobody is admitted twice, nobody gets a free seat", async () => {
    const harnessed = await harness({});
    await seedRoom(harnessed);
    for (const n of [1, 2, 3, 4]) must(await harnessed.server.join("room", user(n), null, () => {}));
    const roster = harnessed.server.listSeats();
    await harnessed.restart();
    expect(harnessed.server.listSeats()).toEqual(roster);
    expect(refusalOf(await harnessed.server.join("room", user(5), null, () => {})).code).toBe("LICENSE_LIMIT");
    must(await harnessed.server.join("room", user(3), null, () => {}));
  });
});

describe("limits from the licence, not from the server", () => {
  test("a keyed commercial licence with no workspace limit and fifty seats", async () => {
    const { server } = await harness({ FAKE_TIER: "commercial", FAKE_KEYED: "1", FAKE_MAX_WORKSPACES: "null", FAKE_MAX_SEATS: "50" });
    for (let n = 0; n < 8; n++) must(await server.createRoom(user(n), { room_id: `room-${n}`, workspace_id: `ws-${n}` }));
    expect(server.listSeats()).toHaveLength(8);
  });

  test("the seat limit is whatever the engine says: two seats admit two users", async () => {
    const { server } = await harness({ FAKE_TIER: "commercial", FAKE_KEYED: "1", FAKE_MAX_SEATS: "2", FAKE_MAX_WORKSPACES: "3" });
    must(await server.createRoom(user(1), { room_id: "a", workspace_id: "w1" }));
    must(await server.createRoom(user(2), { room_id: "b", workspace_id: "w2" }));
    expect(refusalOf(await server.createRoom(user(3), { room_id: "c", workspace_id: "w3" })).code).toBe("LICENSE_LIMIT");
    must(await server.createRoom(user(1), { room_id: "d", workspace_id: "w3" }));
    expect(refusalOf(await server.createRoom(user(1), { room_id: "e", workspace_id: "w4" })).message).toContain("3 workspaces");
  });

  test("a licence that cannot be read admits nobody and creates nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wolfsdk-server-"));
    const real = new PoolEngine(makePool());
    const unreadable: DocumentEngine = {
      entitlement: () => Promise.reject(new EngineFault("no licence answer")),
      replay: (input) => real.replay(input),
      close: () => real.close(),
    };
    const clock = steppingClock();
    const server = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: unreadable, now: clock, newId: () => "id-1" });
    try {
      const refusal = refusalOf(await server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
      expect(refusal.code).toBe("LICENSE_LIMIT");
      expect(refusal.message).toContain("could not be read");
      expect(await server.listRooms()).toEqual([]);
      expect(server.listSeats()).toEqual([]);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a seat released while an agent hands its own to its operator is not counted as freed twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wolfsdk-server-"));
    const real = new PoolEngine(makePool());
    let maxSeats = 3;
    let whileReading = (): void => {};
    const engine: DocumentEngine = {
      entitlement: async () => {
        const granted = await real.entitlement();
        whileReading();
        return { ...granted, max_seats: maxSeats };
      },
      replay: (input) => real.replay(input),
      close: () => real.close(),
    };
    let at = Date.parse("2026-11-13T10:00:00.000Z");
    let operator: { id: string; name: string } | null = null;
    let counter = 0;
    const server = new RoomServer({
      dbPath: join(dir, "rooms.sqlite"),
      blobDir: join(dir, "blobs"),
      engine,
      now: () => new Date(at),
      newId: () => `id-${++counter}`,
      operatorOf: () => operator,
    });
    try {
      must(await server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
      must(await server.join("room", user(1), null, () => {}));
      must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
      expect(server.listSeats()).toHaveLength(3);
      // The licence now admits fewer seats than are taken, the agent gets an operator, and its own seat is released
      // by hand while the server reads the licence for the hand-over.
      maxSeats = 2;
      operator = { id: "user-9", name: "User 9" };
      at += 60_000;
      whileReading = () => void server.releaseSeat("agent", "robot");
      expect(refusalOf(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" })).code).toBe("LICENSE_LIMIT");
      expect(server.listSeats().map((s) => `${s.kind}:${s.id}`).sort()).toEqual(["user:alice", "user:user-1"]);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const append = (text: string): Parameters<RoomServer["edit"]>[2] => ({ doc_name: "doc.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text }] } });
const errorsOf = (seen: Collector) => seen.ofType("error").map((e) => ({ request_id: e.request_id, code: e.code }));
const SEAT_LOST = { request_id: null, code: "LICENSE_LIMIT" } as const;

describe("a seat that is lost", () => {
  test("a released identity's subscription hears one error and nothing after it; joining again takes a seat", async () => {
    const { server } = await harness({});
    await seedRoom(h as Harness);
    const first = new Collector();
    must(await server.join("room", bob, null, first.listener));
    expect(server.releaseSeat("user", "bob")).toBe(true);
    expect(errorsOf(first)).toEqual([SEAT_LOST]);
    const heard = first.events.length;
    committed(await server.edit("room", alice, append("!")));
    expect(first.events).toHaveLength(heard);
    const second = new Collector();
    must(await server.join("room", bob, null, second.listener));
    expect(server.listSeats().map((s) => s.id)).toEqual(["alice", "bob"]);
    expect(errorsOf(second)).toEqual([]);
  });

  test("an operated agent's subscription ends with its operator's seat", async () => {
    h = await makeHarness({ operatorOf: (agent) => (agent.id === "robot" ? { id: "bob", name: "Bob" } : null) });
    const { server } = h;
    await seedRoom(h);
    const seen = new Collector();
    must(await server.join("room", robot, null, seen.listener));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:bob"]);
    expect(server.releaseSeat("user", "bob")).toBe(true);
    expect(errorsOf(seen)).toEqual([SEAT_LOST]);
    const heard = seen.events.length;
    committed(await server.edit("room", alice, append("!")));
    expect(seen.events).toHaveLength(heard);
  });

  test("a seat freed in the database ends the subscription even when that identity is the next to ask", async () => {
    h = await makeHarness({ operatorOf: (agent) => (agent.id === "robot" ? { id: "bob", name: "Bob" } : null) });
    const { server } = h;
    await seedRoom(h);
    const [bobSees, robotSees] = [new Collector(), new Collector()];
    must(await server.join("room", bob, null, bobSees.listener));
    must(await server.join("room", robot, null, robotSees.listener));
    // What `wolfsdk-workspace seats release user bob` does beside a running server.
    const cli = new RoomStore(join(h.dir, "rooms.sqlite"));
    expect(cli.removeSeat("user", "bob")).toBe(true);
    cli.close();
    const heard = [bobSees.events.length, robotSees.events.length];
    // The request takes a seat again, and what was subscribed before the release has ended.
    committed(await server.edit("room", robot, append("!")));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:bob"]);
    expect(errorsOf(bobSees)).toEqual([SEAT_LOST]);
    expect(errorsOf(robotSees)).toEqual([SEAT_LOST]);
    expect([bobSees.events.length, robotSees.events.length]).toEqual([heard[0] + 1, heard[1] + 1]);
  });

  test("an agent whose operator changes to a user without a seat keeps its subscription", async () => {
    let operator = { id: "bob", name: "Bob" };
    h = await makeHarness({ operatorOf: () => operator });
    const { server } = h;
    await seedRoom(h);
    const seen = new Collector();
    must(await server.join("room", robot, null, seen.listener));
    operator = { id: "carol", name: "Carol" };
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice", "user:bob", "user:carol"]);
    expect(errorsOf(seen)).toEqual([]);
    // It goes by the seat of the new operator from then on.
    expect(server.releaseSeat("user", "bob")).toBe(true);
    expect(errorsOf(seen)).toEqual([]);
    expect(server.releaseSeat("user", "carol")).toBe(true);
    expect(errorsOf(seen)).toEqual([SEAT_LOST]);
  });

  test("an agent that hands its seat to its operator keeps its subscription", async () => {
    let at = Date.parse("2026-11-13T10:00:00.000Z");
    let operator: { id: string; name: string } | null = null;
    h = await makeHarness({ now: () => new Date(at), operatorOf: () => operator });
    const { server } = h;
    await seedRoom(h);
    const seen = new Collector();
    must(await server.join("room", robot, null, seen.listener));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["agent:robot", "user:alice"]);
    operator = { id: "alice", name: "Alice" };
    at += 60_000;
    must(await server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    expect(server.listSeats().map((s) => `${s.kind}:${s.id}`)).toEqual(["user:alice"]);
    committed(await server.edit("room", alice, append("!")));
    expect(errorsOf(seen)).toEqual([]);
    expect(seen.ofType("doc.committed")).toHaveLength(1);
  });
});

describe("a licence that changes under a running server", () => {
  type Limits = { max_seats: unknown; max_workspaces: unknown; unreadable: boolean };
  let dir: string | undefined;
  let server: RoomServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A server whose licence says whatever `limits` holds at the moment it is read. */
  const licensed = async (limits: Limits): Promise<RoomServer> => {
    dir = await mkdtemp(join(tmpdir(), "wolfsdk-server-"));
    const real = new PoolEngine(makePool());
    const engine: DocumentEngine = {
      entitlement: async () => {
        const granted = await real.entitlement();
        if (limits.unreadable) throw new EngineFault("no licence answer");
        // The limits are whatever the test says, valid or not: that is what a custom engine may return.
        return { ...granted, max_seats: limits.max_seats, max_workspaces: limits.max_workspaces } as typeof granted;
      },
      replay: (input) => real.replay(input),
      close: () => real.close(),
    };
    let counter = 0;
    server = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine, now: steppingClock(), newId: () => `id-${++counter}` });
    return server;
  };
  const seatsOf = (s: RoomServer): string[] => s.listSeats().map((seat) => seat.id);
  const aMinuteLater = (): void => void setSystemTime(new Date(Date.now() + 61_000));

  test("fewer seats: within a minute the newest seats are freed, their subscriptions end, the oldest keep working", async () => {
    const limits: Limits = { max_seats: 3, max_workspaces: 1, unreadable: false };
    const s = await licensed(limits);
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const [first, second] = [new Collector(), new Collector()];
    must(await s.join("room", user(1), null, first.listener));
    must(await s.join("room", user(2), null, second.listener));
    expect(seatsOf(s)).toEqual(["alice", "user-1", "user-2"]);

    limits.max_seats = 2;
    aMinuteLater();
    must(await s.getRoom("room", alice));
    expect(seatsOf(s)).toEqual(["alice", "user-1"]);
    expect(errorsOf(second)).toEqual([SEAT_LOST]);
    expect(errorsOf(first)).toEqual([]);
    expect(refusalOf(await s.getRoom("room", user(2))).code).toBe("LICENSE_LIMIT");
    expect(refusalOf(await s.join("room", user(2), null, () => {})).code).toBe("LICENSE_LIMIT");

    // The identity that lost its seat takes one again as soon as one is free.
    expect(s.releaseSeat("user", "user-1")).toBe(true);
    must(await s.getRoom("room", user(2)));
    expect(seatsOf(s)).toEqual(["alice", "user-2"]);
  });

  test("a licence that can no longer be read stops seated identities too, and frees no seat", async () => {
    const limits: Limits = { max_seats: 5, max_workspaces: 1, unreadable: false };
    const s = await licensed(limits);
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    limits.unreadable = true;
    must(await s.getRoom("room", alice));
    aMinuteLater();
    const refusal = refusalOf(await s.getRoom("room", alice));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.message).toContain("could not be read");
    expect(seatsOf(s)).toEqual(["alice"]);
    limits.unreadable = false;
    must(await s.getRoom("room", alice));
  });

  test.each([undefined, Number.NaN, 2.5, -1, "5"])("a seat limit of %p is no limit the server accepts: nobody is admitted", async (bad) => {
    const s = await licensed({ max_seats: bad, max_workspaces: 1, unreadable: false });
    const refusal = refusalOf(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.message).toContain("could not be read");
    expect(await s.listRooms()).toEqual([]);
    expect(s.listSeats()).toEqual([]);
  });

  test("a workspace limit that is no whole number is refused the same way", async () => {
    const s = await licensed({ max_seats: 5, max_workspaces: undefined, unreadable: false });
    expect(refusalOf(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" })).code).toBe("LICENSE_LIMIT");
    expect(await s.listRooms()).toEqual([]);
  });
});

describe("one server for one database", () => {
  const idle: DocumentEngine = {
    entitlement: () => Promise.reject(new EngineFault("not asked")),
    replay: () => Promise.reject(new EngineFault("not asked")),
    close: () => Promise.resolve(),
  };
  let scratch: string | undefined;
  afterEach(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });
  /** Servers without a reactor in a fresh folder: enough to claim a database. `name` is used as written. */
  const claims = async (): Promise<{ dir: string; at: (name: string) => RoomServer }> => {
    const dir = await mkdtemp(join(tmpdir(), "wolf-claim-"));
    scratch = dir;
    return { dir, at: (name) => new RoomServer({ dbPath: `${dir}/${name}`, blobDir: join(dir, "blobs"), engine: idle }) };
  };

  test("a second server on the same database does not start; after the first closes, one does", async () => {
    const { dir, server } = await harness({});
    await seedRoom(h as Harness);
    const second = (): RoomServer => new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: idle });
    expect(second).toThrow("already served by another room server");
    // The refused server took nothing with it: the first still works.
    must(await server.getRoom("room", alice));
    await (h as Harness).restart();
    must(await (h as Harness).server.getRoom("room", alice));
    expect(second).toThrow("already served by another room server");
    // Another name for the same file is the same database.
    await symlink(join(dir, "rooms.sqlite"), join(dir, "alias.sqlite"));
    expect(() => new RoomServer({ dbPath: join(dir, "alias.sqlite"), blobDir: join(dir, "blobs"), engine: idle })).toThrow("already served by another room server");
  });

  test("a link to a database that is not created yet is claimed where the database will be", async () => {
    const { dir, at } = await claims();
    await mkdir(join(dir, "real", "deep"), { recursive: true });
    await symlink(join("real", "deep"), join(dir, "sub"));
    // Relative, through a second link, out of a linked directory by `..`, and to a file that does not exist.
    await symlink("sub/../rooms.sqlite", join(dir, "current.sqlite"));
    await symlink("current.sqlite", join(dir, "alias.sqlite"));
    const first = at("alias.sqlite");
    try {
      // Also the link the first server came through, which now points at a database that exists.
      for (const name of ["real/rooms.sqlite", "sub/../rooms.sqlite", "current.sqlite", "alias.sqlite"]) {
        expect(() => at(name)).toThrow("already served by another room server");
      }
    } finally {
      await first.close();
    }
    await at("real/rooms.sqlite").close();
  });

  test("a database with a second hard link is not served under either name", async () => {
    const { dir, at } = await claims();
    const first = at("rooms.sqlite");
    try {
      await link(join(dir, "rooms.sqlite"), join(dir, "twin.sqlite"));
      expect(() => at("twin.sqlite")).toThrow("has 2 hard links");
      // What the running server does next is the operating system's: the SQLite of macOS stops on the new link.
    } finally {
      await first.close();
    }
    // Neither name starts a server until the other one is gone.
    expect(() => at("rooms.sqlite")).toThrow("has 2 hard links");
    await rm(join(dir, "twin.sqlite"));
    await at("rooms.sqlite").close();
  });

  test("a database mounted as a single file is not served; one in a mounted folder is", async () => {
    const { dir, at } = await claims();
    await mkdir(join(dir, "my data"));
    await at("my data/rooms.sqlite").close();
    const database = join(realpathSync.native(dir), "my data", "rooms.sqlite");
    // The mount table as Linux prints it: the root, then one mount at `point`, its space written as `\040`.
    const table = (point: string): string =>
      ["22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw", `36 22 8:2 /srv/rooms ${point.replaceAll(" ", "\\040")} rw,relatime - ext4 /dev/sdb1 rw`, ""].join("\n");
    expect(() => claimDatabase(database, table(database))).toThrow("mounted as a single file");
    // Each container such a mount goes into would hold a lock of its own; the folder brings the lock along.
    claimDatabase(database, table(dirname(database)))();
  });
});
