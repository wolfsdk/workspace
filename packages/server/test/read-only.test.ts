// The read-only mode of a workspace: every write is refused with one stable code and a message that names the reason
// and the way out, before anything else about the request is looked at, while joining, listing and every read keep
// working. The files outlive a restart, so a workspace seeded while it was writable is read back read-only.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReadOnlyMode, PoolEngine, readOnlyFailure, RoomServer, WORKSPACE_READ_ONLY } from "../src/index.ts";
import { alice, bob, bytesOf, Collector, makePool, must, refusalOf, robot, steppingClock, textOf } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const MODE: ReadOnlyMode = { reason: "The trial ended on 2026-11-28.", upgrade: "https://cloud.example.test/upgrade" };
const EXPECTED = `workspace-read-only: ${MODE.reason} ${MODE.upgrade}`;
const DOC = "doc.docx";

let dir: string | undefined;
let server: RoomServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Start a server on the files of `dir` (created on the first call), read-only when `readOnly` is given. Calling it
 * again closes the running server and starts another on the same files: a restart. */
async function start(readOnly?: ReadOnlyMode): Promise<RoomServer> {
  await server?.close();
  dir ??= await mkdtemp(join(tmpdir(), "wolfsdk-read-only-"));
  let counter = 0;
  server = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new PoolEngine(makePool()),
    now: steppingClock(),
    newId: () => `id-${++counter}`,
    readOnly,
  });
  return server;
}

/** A writable workspace with a room, a document with one commit, an open proposal and a thread; then the same files
 * started read-only. Returns the read-only server and the id of the open proposal. */
async function seededReadOnly(): Promise<{ s: RoomServer; proposalId: string; threadId: string }> {
  const writable = await start();
  must(await writable.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  must(await writable.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("hello world") }));
  must(await writable.edit("room", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text: "!" }] } }));
  const proposal = must(await writable.edit("room", robot, { doc_name: DOC, base_revision: 1, mode: "propose", batch: { ops: [{ op: "append", text: "?" }] } }));
  if (proposal.mode !== "propose") throw new Error("expected a proposal");
  const thread = must(await writable.postComment("room", alice, { thread_id: null, doc_name: DOC, target_address: "p1", body: "first", mentions: [] }));
  return { s: await start(MODE), proposalId: proposal.proposal.proposal_id, threadId: thread.thread_id };
}

describe("the refusal", () => {
  test("is LICENSE_LIMIT with a stable reason, and a message with the reason and the upgrade path verbatim", () => {
    expect(WORKSPACE_READ_ONLY).toBe("workspace-read-only");
    expect(readOnlyFailure(MODE)).toEqual({ code: "LICENSE_LIMIT", message: EXPECTED, reason: "workspace-read-only" });
  });
});

describe("a read-only server refuses every write", () => {
  test("create a workspace", async () => {
    const { s } = await seededReadOnly();
    expect(refusalOf(await s.createRoom(alice, { room_id: "other", workspace_id: "ws" }))).toEqual(readOnlyFailure(MODE));
    expect((await s.listRooms()).map((room) => room.room_id)).toEqual(["room"]);
  });

  test("add a document", async () => {
    const { s } = await seededReadOnly();
    const refusal = refusalOf(await s.addDocument("room", alice, { name: "second.docx", format: "docx", bytes: bytesOf("two") }));
    expect(refusal).toEqual(readOnlyFailure(MODE));
    expect(must(await s.getRoom("room", alice)).documents.map((d) => d.head.name)).toEqual([DOC]);
  });

  test("edit, as a commit and as a proposal", async () => {
    const { s } = await seededReadOnly();
    for (const mode of ["commit", "propose"] as const) {
      const refusal = refusalOf(await s.edit("room", alice, { doc_name: DOC, base_revision: 1, mode, batch: { ops: [{ op: "append", text: "no" }] } }));
      expect(refusal).toEqual(readOnlyFailure(MODE));
    }
    const room = must(await s.getRoom("room", alice));
    expect(room.documents[0]?.head.revision).toBe(1);
    expect(room.proposals.filter((p) => p.status === "open")).toHaveLength(1);
  });

  test("decide a proposal", async () => {
    const { s, proposalId } = await seededReadOnly();
    for (const decision of ["approve", "reject"] as const) {
      expect(refusalOf(await s.decideProposal("room", alice, { proposal_id: proposalId, decision }))).toEqual(readOnlyFailure(MODE));
    }
    expect(must(await s.readPreview("room", alice, proposalId)).proposal.status).toBe("open");
  });

  test("comment, new thread and reply", async () => {
    const { s, threadId } = await seededReadOnly();
    const fresh = await s.postComment("room", alice, { thread_id: null, doc_name: DOC, target_address: "p1", body: "second", mentions: [] });
    const reply = await s.postComment("room", bob, { thread_id: threadId, doc_name: DOC, target_address: "p1", body: "reply", mentions: [], resolve: true });
    expect(refusalOf(fresh)).toEqual(readOnlyFailure(MODE));
    expect(refusalOf(reply)).toEqual(readOnlyFailure(MODE));
    const [thread, ...rest] = must(await s.getRoom("room", alice)).comments;
    expect(rest).toEqual([]);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.resolved).toBe(false);
  });

  test("an agent's activity report", async () => {
    const { s } = await seededReadOnly();
    expect(refusalOf(await s.reportActivity("room", robot, { doc_name: DOC, activity: "reading" }))).toEqual(readOnlyFailure(MODE));
  });

  test("before it validates, authorises or looks anything up: the refusal does not depend on the request", async () => {
    const { s } = await seededReadOnly();
    const refusals = [
      refusalOf(await s.createRoom(alice, { room_id: "not a valid id!", workspace_id: "ws" })),
      refusalOf(await s.addDocument("room", alice, { name: "", format: "docx", bytes: new Uint8Array() })),
      refusalOf(await s.addDocument("nowhere", alice, { name: "x.docx", format: "docx", bytes: bytesOf("x") })),
      refusalOf(await s.edit("nowhere", alice, { doc_name: "missing.docx", base_revision: 99, mode: "commit", batch: { ops: [] } })),
      refusalOf(await s.decideProposal("room", robot, { proposal_id: "none", decision: "approve" })),
      refusalOf(await s.postComment("nowhere", alice, { thread_id: "none", doc_name: "missing.docx", target_address: "p1", body: "", mentions: [] })),
      refusalOf(await s.reportActivity("room", alice, { doc_name: "missing.docx", activity: "reading" })),
    ];
    for (const refusal of refusals) expect(refusal).toEqual(readOnlyFailure(MODE));
  });

  test("a refused write takes no seat, no event and no revision", async () => {
    const { s } = await seededReadOnly();
    const before = must(await s.getRoom("room", alice));
    const seats = s.listSeats().map((seat) => seat.id);
    refusalOf(await s.edit("room", bob, { doc_name: DOC, base_revision: 1, mode: "commit", batch: { ops: [{ op: "append", text: "no" }] } }));
    refusalOf(await s.postComment("room", bob, { thread_id: null, doc_name: DOC, target_address: "p1", body: "no", mentions: [] }));
    expect(s.listSeats().map((seat) => seat.id)).toEqual(seats);
    expect(must(await s.getRoom("room", alice))).toEqual(before);
  });
});

describe("a read-only server keeps reading", () => {
  test("lists, reads a room, a document and a preview, and joins a room", async () => {
    const { s, proposalId } = await seededReadOnly();
    expect((await s.listRooms()).map((room) => room.room_id)).toEqual(["room"]);
    const room = must(await s.getRoom("room", alice));
    expect(room.documents.map((d) => d.head.name)).toEqual([DOC]);
    expect(textOf(must(await s.readHead("room", alice, DOC)).bytes)).toBe("hello world!");
    expect(textOf(must(await s.readPreview("room", alice, proposalId)).bytes)).toBe("hello world!?");
    const log = new Collector();
    const subscription = must(await s.join("room", bob, null, log.listener));
    expect(log.ofType("room.snapshot")).toHaveLength(1);
    log.expectValid();
    subscription.unsubscribe();
  });

  test("seedRoom still creates the room the host puts in place at its start", async () => {
    const s = await start(MODE);
    must(await s.seedRoom(alice, { room_id: "home", workspace_id: "ws" }));
    expect((await s.listRooms()).map((room) => room.room_id)).toEqual(["home"]);
    expect(refusalOf(await s.createRoom(alice, { room_id: "other", workspace_id: "ws" }))).toEqual(readOnlyFailure(MODE));
  });

  test("a restart without the mode serves writes again", async () => {
    await seededReadOnly();
    const s = await start();
    must(await s.edit("room", alice, { doc_name: DOC, base_revision: 1, mode: "commit", batch: { ops: [{ op: "append", text: " again" }] } }));
    expect(textOf(must(await s.readHead("room", alice, DOC)).bytes)).toBe("hello world! again");
  });
});

describe("without the mode nothing changes", () => {
  test("every write is served", async () => {
    const s = await start();
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await s.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("hello") }));
    must(await s.edit("room", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: { ops: [{ op: "append", text: "!" }] } }));
    must(await s.postComment("room", alice, { thread_id: null, doc_name: DOC, target_address: "p1", body: "ok", mentions: [] }));
    must(await s.reportActivity("room", robot, { doc_name: DOC, activity: "reading" }));
  });
});

describe("a mode that is a mistake of the host", () => {
  test("is refused when the server starts, not at the first request", async () => {
    dir = await mkdtemp(join(tmpdir(), "wolfsdk-read-only-"));
    const options = { dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new PoolEngine(makePool()) };
    for (const readOnly of [
      { reason: "", upgrade: "x" },
      { reason: "x", upgrade: "   " },
      { reason: "x".repeat(301), upgrade: "x" },
      { reason: "x", upgrade: "u".repeat(301) },
    ]) {
      expect(() => new RoomServer({ ...options, readOnly })).toThrow(/readOnly: (reason|upgrade) is 1 to 300 characters and not blank/);
    }
    await options.engine.close();
  });
});
