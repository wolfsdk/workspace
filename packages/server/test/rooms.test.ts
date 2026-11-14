// The rooms: documents, commits, revision checks, proposals, comments, activity and what a failed batch leaves
// behind. The engine is the stand-in reactor over real pipes; every hash the tests expect is computed here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm, writeFile } from "node:fs/promises";
import { type RoomBatch, type RoomPinnedBatch, type RoomServerEvent, validateRoomEvent } from "@wolfsdk/protocol/workspace";
import type { EditRequest } from "../src/index.ts";
import {
  alice,
  bob,
  bytesOf,
  Collector,
  committed,
  type Harness,
  makeHarness,
  must,
  proposed,
  refusalOf,
  robot,
  seedRoom,
  sha256,
  snapshotOf,
  textOf,
} from "./fixtures/harness.ts";

const DOC = "doc.docx";
const HELLO = "hello world";
/** The batch is what a server with the default options pins when the client pinned nothing: all four members. */
function expectPinned(pinned: RoomPinnedBatch | undefined, ops: RoomBatch["ops"]): void {
  expect(pinned?.ops).toEqual(ops);
  expect(pinned?.timezone).toBe("UTC");
  expect(pinned?.locale).toBe("en-US");
  expect(typeof pinned?.clock).toBe("string");
  expect(Number.isInteger(pinned?.seed)).toBe(true);
}

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.dispose();
});

const batch = (...ops: RoomBatch["ops"]): RoomBatch => ({ ops });
const append = (text: string): RoomBatch => batch({ op: "append", text });
const edit = (mode: EditRequest["mode"], base: number, b: RoomBatch, actor = alice, doc = DOC) =>
  h.server.edit("room", actor, { doc_name: doc, base_revision: base, mode, batch: b });
const decide = (proposalId: string, decision: "approve" | "reject", actor = alice) =>
  h.server.decideProposal("room", actor, { proposal_id: proposalId, decision });
const join = async (since: number | null, actor = alice): Promise<Collector> => {
  const log = new Collector();
  must(await h.server.join("room", actor, since, log.listener));
  return log;
};
const seqNow = async (): Promise<number> => (await snapshotOf(h)).seq;

describe("rooms and documents", () => {
  test("a room starts empty at seq 0; a document is revision 0 and its head is the hash of its bytes", async () => {
    const created = must(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    expect(created).toMatchObject({ contract: "wolfsdk.room.v1", room_id: "room", workspace_id: "ws", seq: 0, documents: [], session_log: [], proposals: [], comments: [] });
    const head = must(await h.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf(HELLO) }));
    expect(head).toMatchObject({ revision: 0, sha256: sha256(bytesOf(HELLO)), format: "docx", name: DOC });
    const room = await snapshotOf(h);
    expect(room.seq).toBe(1);
    expect(room.documents).toEqual([{ head, page_hashes: [sha256(bytesOf(HELLO))] }]);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(HELLO);
    expect(await h.server.listRooms()).toEqual([{ room_id: "room", workspace_id: "ws", seq: 1 }]);
  });

  test("adding a document is announced with a doc.added that carries it", async () => {
    must(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const log = await join(null);
    const head = must(await h.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf(HELLO) }));
    expect(log.events.map((e) => e.type)).toEqual(["room.snapshot", "doc.added"]);
    expect(log.ofType("doc.added")).toEqual([{ type: "doc.added", seq: 1, document: { head, page_hashes: [sha256(bytesOf(HELLO))] } }]);
    log.expectValid();
  });

  test("a client that resumes from before a document was added gets the doc.added from the log, not a snapshot", async () => {
    must(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const head = must(await h.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf(HELLO) }));
    committed(await edit("commit", 0, append("!")));
    const log = await join(0);
    expect(log.events.map((e) => e.type)).toEqual(["doc.added", "doc.committed", "pages.invalidated"]);
    expect(log.ofType("doc.added")[0]?.document.head).toEqual(head);
    log.expectValid();
  });

  test("refuses what cannot be a room or a document, and changes nothing", async () => {
    await seedRoom(h);
    const before = await snapshotOf(h);
    expect(refusalOf(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await h.server.createRoom(alice, { room_id: "bad id", workspace_id: "ws" })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await h.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("again") })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await h.server.addDocument("room", alice, { name: "", format: "docx", bytes: bytesOf("x") })).code).toBe("BAD_REQUEST");
    const bad = refusalOf(await h.server.addDocument("room", alice, { name: "bad.docx", format: "docx", bytes: bytesOf("!!bad bytes") }));
    expect(bad.code).toBe("BAD_REQUEST");
    expect(bad.message).toContain("invalid-input");
    expect(refusalOf(await h.server.addDocument("nowhere", alice, { name: DOC, format: "docx", bytes: bytesOf("x") })).code).toBe("UNKNOWN_ROOM");
    expect(refusalOf(await h.server.getRoom("nowhere", alice)).code).toBe("UNKNOWN_ROOM");
    expect(refusalOf(await h.server.readHead("room", alice, "missing.docx")).code).toBe("UNKNOWN_DOCUMENT");
    expect(await snapshotOf(h)).toEqual(before);
  });

  test("an edit that cannot be an edit is refused before any engine work", async () => {
    await seedRoom(h);
    must(await h.server.addDocument("room", alice, { name: "a.pdf", format: "pdf", bytes: bytesOf("%PDF") }));
    const before = await snapshotOf(h);
    expect(refusalOf(await edit("commit", -1, append("x"))).code).toBe("BAD_REQUEST");
    expect(refusalOf(await edit("commit", 0.5, append("x"))).code).toBe("BAD_REQUEST");
    expect(refusalOf(await edit("commit", 0, append("x"), alice, "missing.docx")).code).toBe("UNKNOWN_DOCUMENT");
    expect(refusalOf(await h.server.edit("nowhere", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: append("x") })).code).toBe("UNKNOWN_ROOM");
    expect(refusalOf(await edit("commit", 0, append("x"), alice, "a.pdf")).code).toBe("BAD_REQUEST");
    expect(await snapshotOf(h)).toEqual(before);
  });

  test("the authorize hook decides who may do what; a refusal is FORBIDDEN and changes nothing", async () => {
    await h.dispose();
    h = await makeHarness({ authorize: (actor, action) => !(actor.id === "bob" && (action === "edit" || action === "join")) });
    await seedRoom(h);
    const before = await snapshotOf(h);
    expect(refusalOf(await edit("commit", 0, append("!"), bob)).code).toBe("FORBIDDEN");
    const listener = new Collector();
    expect(refusalOf(await h.server.join("room", bob, null, listener.listener)).code).toBe("FORBIDDEN");
    expect(listener.events).toEqual([]);
    expect(await snapshotOf(h)).toEqual(before);
    committed(await edit("commit", 0, append("!"), alice));
  });
});

describe("commit", () => {
  test("applies the batch to the head: revision + 1, the new hash, one session entry, one doc.committed", async () => {
    await seedRoom(h);
    const log = await join(null, bob);
    const { head, entry } = committed(await edit("commit", 0, append("!")));
    expect(head).toMatchObject({ revision: 1, sha256: sha256(bytesOf("hello world!")), format: "docx", name: DOC });
    expect(entry).toMatchObject({
      doc_name: DOC,
      revision: 1,
      base_sha256: sha256(bytesOf(HELLO)),
      result_sha256: sha256(bytesOf("hello world!")),
      author: alice,
      proposal_id: null,
      approved_by: null,
    });
    expectPinned(entry.batch, append("!").ops);
    const room = await snapshotOf(h);
    expect(room.session_log).toEqual([entry]);
    expect(room.documents[0]?.head).toEqual(head);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("hello world!");
    const [committedEvent] = log.ofType("doc.committed");
    expect(committedEvent).toEqual({ type: "doc.committed", seq: entry.seq, head, entry });
    expect(log.events.map((e) => e.type)).toEqual(["room.snapshot", "doc.committed", "pages.invalidated"]);
    log.expectValid();
  });

  test("revisions count the commits of each document separately, and seq runs across documents", async () => {
    await seedRoom(h);
    must(await h.server.addDocument("room", alice, { name: "b.docx", format: "docx", bytes: bytesOf("bee") }));
    const a1 = committed(await edit("commit", 0, append("1")));
    const b1 = committed(await edit("commit", 0, append("1"), alice, "b.docx"));
    const a2 = committed(await edit("commit", 1, append("2")));
    expect([a1.head.revision, b1.head.revision, a2.head.revision]).toEqual([1, 1, 2]);
    expect(a1.entry.seq).toBeLessThan(b1.entry.seq);
    expect(b1.entry.seq).toBeLessThan(a2.entry.seq);
    const room = await snapshotOf(h);
    expect(room.session_log.map((e) => `${e.doc_name}@${e.revision}`)).toEqual([`${DOC}@1`, "b.docx@1", `${DOC}@2`]);
  });

  test("pages.invalidated names the pages whose hash changed and the pages that went away", async () => {
    await seedRoom(h, "p1\fp2\fp3");
    const page = (text: string) => sha256(bytesOf(text));
    const log = await join(await seqNow());
    committed(await edit("commit", 0, batch({ op: "replace", find: "p2", text: "P2" })));
    committed(await edit("commit", 1, batch({ op: "set_text", text: "p1" })));
    committed(await edit("commit", 2, append("\fnew")));
    const [first, second, third] = log.ofType("pages.invalidated");
    expect(first).toMatchObject({ doc_name: DOC, revision: 1, page_hashes: [page("p1"), page("P2"), page("p3")], changed: [2], removed: [] });
    expect(second).toMatchObject({ revision: 2, page_hashes: [page("p1")], changed: [], removed: [2, 3] });
    expect(third).toMatchObject({ revision: 3, page_hashes: [page("p1"), page("new")], changed: [2], removed: [] });
    expect(first?.sha256).toBe(sha256(bytesOf("p1\fP2\fp3")));
    expect((await snapshotOf(h)).documents[0]?.page_hashes).toEqual([page("p1"), page("new")]);
    log.expectValid();
  });
});

describe("revision mismatch", () => {
  test("a stale base_revision is refused with the head to rebase on, and nothing changes", async () => {
    await seedRoom(h);
    const { head } = committed(await edit("commit", 0, append("!")));
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    const refusal = refusalOf(await edit("commit", 0, append("?")));
    expect(refusal.code).toBe("REVISION_MISMATCH");
    expect(refusal).toMatchObject({ detail: { doc_name: DOC, base_revision: 0, head } });
    expect(validateRoomEvent({ type: "error", request_id: "r-1", ...refusal })).toEqual([]);
    expect(refusalOf(await edit("commit", 7, append("?"))).code).toBe("REVISION_MISMATCH");
    expect(refusalOf(await edit("propose", 0, append("?"))).code).toBe("REVISION_MISMATCH");
    expect(await snapshotOf(h)).toEqual(before);
    expect(log.events).toEqual([]);
    expect(committed(await edit("commit", head.revision, append("?"))).head.revision).toBe(2);
  });

  test("eight writers on one revision: exactly one wins, the rest are told the winning head", async () => {
    await seedRoom(h);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => edit("commit", 0, append(`-${i}`), i % 2 === 0 ? alice : bob)));
    const wins = results.filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const winner = committed(wins[0] as Parameters<typeof committed>[0]);
    for (const result of results.filter((r) => !r.ok)) {
      const refusal = refusalOf(result);
      expect(refusal.code).toBe("REVISION_MISMATCH");
      expect(refusal).toMatchObject({ detail: { doc_name: DOC, base_revision: 0, head: winner.head } });
    }
    const room = await snapshotOf(h);
    expect(room.session_log).toEqual([winner.entry]);
    expect(room.documents[0]?.head).toEqual(winner.head);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(HELLO + String(winner.entry.batch.ops[0]?.text));
  });

  test("writers on different documents do not disturb each other", async () => {
    await seedRoom(h);
    must(await h.server.addDocument("room", alice, { name: "b.docx", format: "docx", bytes: bytesOf("bee") }));
    const [a, b] = await Promise.all([edit("commit", 0, append("A")), edit("commit", 0, append("B"), bob, "b.docx")]);
    expect(committed(a).head.revision).toBe(1);
    expect(committed(b).head.revision).toBe(1);
    await snapshotOf(h);
  });
});

describe("proposals", () => {
  test("a proposal is held open: the head, the log and the bytes of the head do not change", async () => {
    await seedRoom(h);
    const log = await join(await seqNow());
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    expect(proposal).toMatchObject({ status: "open", doc_name: DOC, base_revision: 0, author: robot, preview_sha256: sha256(bytesOf("hello world!")) });
    expect(proposal.batches).toHaveLength(1);
    expectPinned(proposal.batches[0], append("!").ops);
    const room = await snapshotOf(h);
    expect(room.proposals).toEqual([proposal]);
    expect(room.session_log).toEqual([]);
    expect(room.documents[0]?.head.revision).toBe(0);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(HELLO);
    const preview = must(await h.server.readPreview("room", alice, proposal.proposal_id));
    expect(preview.proposal).toEqual(proposal);
    expect(textOf(preview.bytes)).toBe("hello world!");
    expect(log.events).toEqual([{ type: "proposal.updated", seq: room.seq, proposal }]);
    expect(refusalOf(await h.server.readPreview("room", alice, "nope")).code).toBe("UNKNOWN_PROPOSAL");
  });

  test("approve commits the proposal's batches under its id, by its author, and announces in order", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    const log = await join(await seqNow());
    const outcome = must(await decide(proposal.proposal_id, "approve"));
    expect(outcome.proposal).toEqual({ ...proposal, status: "approved" });
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]).toMatchObject({
      revision: 1,
      proposal_id: proposal.proposal_id,
      approved_by: alice,
      author: robot,
      base_sha256: sha256(bytesOf(HELLO)),
      result_sha256: proposal.preview_sha256,
    });
    expect(outcome.head).toMatchObject({ revision: 1, sha256: proposal.preview_sha256 });
    expect(log.events.map((e) => e.type)).toEqual(["proposal.updated", "doc.committed", "pages.invalidated"]);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("hello world!");
    const room = await snapshotOf(h);
    expect(room.proposals[0]?.status).toBe("approved");
    expect(room.session_log[0]?.proposal_id).toBe(proposal.proposal_id);
    log.expectValid();
  });

  test("a document the engine edits but cannot lay out still takes an approval and a commit", async () => {
    await seedRoom(h, "~nolayout deck");
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    const outcome = must(await decide(proposal.proposal_id, "approve"));
    expect(outcome.proposal.status).toBe("approved");
    expect(outcome.head).toMatchObject({ revision: 1, sha256: proposal.preview_sha256 });
    must(await edit("commit", 1, append("?")));
    const read = must(await h.server.readHead("room", alice, DOC));
    expect(textOf(read.bytes)).toBe("~nolayout deck!?");
    expect(read.page_hashes).toBeUndefined();
  });

  test("a proposal is decided once: a second decision is PROPOSAL_NOT_OPEN, an unknown id UNKNOWN_PROPOSAL", async () => {
    await seedRoom(h);
    const approved = proposed(await edit("propose", 0, append("!"), robot));
    must(await decide(approved.proposal_id, "approve"));
    const before = await snapshotOf(h);
    expect(refusalOf(await decide(approved.proposal_id, "approve")).code).toBe("PROPOSAL_NOT_OPEN");
    expect(refusalOf(await decide(approved.proposal_id, "reject")).code).toBe("PROPOSAL_NOT_OPEN");
    expect(refusalOf(await decide("no-such-proposal", "approve")).code).toBe("UNKNOWN_PROPOSAL");
    expect(await snapshotOf(h)).toEqual(before);
  });

  test("two approvers racing: one commits, the other finds the proposal closed", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    const [a, b] = await Promise.all([decide(proposal.proposal_id, "approve", alice), decide(proposal.proposal_id, "approve", bob)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(refusalOf(a.ok ? b : a).code).toBe("PROPOSAL_NOT_OPEN");
    expect((await snapshotOf(h)).session_log).toHaveLength(1);
  });

  test("reject closes the proposal and commits nothing", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    const log = await join(await seqNow());
    const outcome = must(await decide(proposal.proposal_id, "reject", bob));
    expect(outcome.proposal).toEqual({ ...proposal, status: "rejected" });
    expect(outcome.entries).toEqual([]);
    expect(outcome.head.revision).toBe(0);
    expect(log.events.map((e) => e.type)).toEqual(["proposal.updated"]);
    expect(refusalOf(await decide(proposal.proposal_id, "approve")).code).toBe("PROPOSAL_NOT_OPEN");
    expect((await snapshotOf(h)).session_log).toEqual([]);
  });

  describe("an agent does not decide a proposal", () => {
    const other = { kind: "agent", id: "robot-2", name: "Robot Two" } as const;

    /** The room as everyone can see it, to compare before and after a refused decision. */
    const state = async (server = h.server) => ({ room: must(await server.getRoom("room", alice)), head: must(await server.readHead("room", alice, DOC)) });

    test("it cannot approve its own proposal: FORBIDDEN, and the proposal, the head and the session log stay as they were", async () => {
      await seedRoom(h);
      const proposal = proposed(await edit("propose", 0, append("!"), robot));
      const before = await state();
      const log = await join(await seqNow());
      expect(refusalOf(await decide(proposal.proposal_id, "approve", robot)).code).toBe("FORBIDDEN");
      expect(await state()).toEqual(before);
      expect(before.room.proposals).toEqual([proposal]);
      expect(before.room.session_log).toEqual([]);
      expect(log.events).toEqual([]);
      expect(must(await h.server.readPreview("room", alice, proposal.proposal_id)).proposal.status).toBe("open");
    });

    test("it cannot approve another actor's proposal, and it cannot reject one either", async () => {
      await seedRoom(h);
      const byUser = proposed(await edit("propose", 0, append("!"), alice));
      const byAgent = proposed(await edit("propose", 0, append("?"), other));
      const before = await state();
      expect(refusalOf(await decide(byUser.proposal_id, "approve", robot)).code).toBe("FORBIDDEN");
      expect(refusalOf(await decide(byAgent.proposal_id, "approve", robot)).code).toBe("FORBIDDEN");
      expect(refusalOf(await decide(byUser.proposal_id, "reject", robot)).code).toBe("FORBIDDEN");
      expect(refusalOf(await decide(byAgent.proposal_id, "reject", other)).code).toBe("FORBIDDEN");
      expect(await state()).toEqual(before);
      expect(before.room.proposals.map((p) => p.status)).toEqual(["open", "open"]);
      expect(before.room.session_log).toEqual([]);
    });

    test("an agent is refused before the proposal is looked up, so it learns nothing about an unknown or closed id", async () => {
      await seedRoom(h);
      const closed = proposed(await edit("propose", 0, append("!"), robot));
      must(await decide(closed.proposal_id, "reject"));
      expect(refusalOf(await decide(closed.proposal_id, "approve", robot)).code).toBe("FORBIDDEN");
      expect(refusalOf(await decide("no-such-proposal", "reject", robot)).code).toBe("FORBIDDEN");
    });

    test("an authorize hook that admits everybody does not give an agent the decision", async () => {
      const open = await makeHarness({ authorize: () => true });
      try {
        must(await open.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
        must(await open.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf(HELLO) }));
        const proposal = proposed(await open.server.edit("room", robot, { doc_name: DOC, base_revision: 0, mode: "propose", batch: append("!") }));
        const before = await state(open.server);
        expect(refusalOf(await open.server.decideProposal("room", robot, { proposal_id: proposal.proposal_id, decision: "approve" })).code).toBe("FORBIDDEN");
        expect(await state(open.server)).toEqual(before);
        expect(before.room.session_log).toEqual([]);
        const outcome = must(await open.server.decideProposal("room", alice, { proposal_id: proposal.proposal_id, decision: "approve" }));
        expect(outcome.proposal.status).toBe("approved");
        expect(outcome.entries[0]?.author).toEqual(robot);
      } finally {
        await open.dispose();
      }
    });
  });

  test("a commit that leaves a proposal applicable makes it superseded: it is stale, not broken", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, append("!"), robot));
    const log = await join(await seqNow());
    committed(await edit("commit", 0, append("?")));
    expect(log.events.map((e) => e.type)).toEqual(["doc.committed", "pages.invalidated", "proposal.updated"]);
    expect(log.ofType("proposal.updated")[0]?.proposal).toEqual({ ...proposal, status: "superseded" });
    expect(refusalOf(await decide(proposal.proposal_id, "approve")).code).toBe("PROPOSAL_NOT_OPEN");
    log.expectValid();
    await snapshotOf(h);
  });

  test("a commit that makes a proposal impossible makes it conflicted", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, batch({ op: "replace", find: "hello", text: "x" }), robot));
    const log = await join(await seqNow());
    committed(await edit("commit", 0, batch({ op: "set_text", text: "world" })));
    expect(log.ofType("proposal.updated")[0]?.proposal).toEqual({ ...proposal, status: "conflicted" });
    expect(refusalOf(await decide(proposal.proposal_id, "approve")).code).toBe("PROPOSAL_NOT_OPEN");
    expect((await snapshotOf(h)).proposals[0]?.status).toBe("conflicted");
  });

  // A refusal that says nothing about the request (a budget, an internal error) says nothing about the proposal.
  // The marker file is how the stand-in reactor is told that it refuses right now.
  const REFUSALS = ["reactor-document-limit", "internal-error"];
  const refusingBatch = (marker: string, code: string): RoomBatch =>
    batch({ op: "refuse_while_exists", path: marker, code }, { op: "append", text: "!" });

  test.each(REFUSALS)("a %s refusal while a commit re-evaluates a proposal does not make it conflicted", async (code) => {
    await seedRoom(h);
    const marker = `${h.dir}/refusing`;
    const proposal = proposed(await edit("propose", 0, refusingBatch(marker, code), robot));
    const log = await join(await seqNow());
    await writeFile(marker, "");
    committed(await edit("commit", 0, append("?")));
    expect(log.ofType("proposal.updated").map((e) => e.proposal.status)).toEqual(["superseded"]);
    expect(log.ofType("proposal.updated")[0]?.proposal).toEqual({ ...proposal, status: "superseded" });
    expect((await snapshotOf(h)).proposals.map((p) => p.status)).toEqual(["superseded"]);
  });

  test.each(REFUSALS)("a %s refusal on approve is ENGINE_FAILED and leaves the proposal open; it can be approved once the engine allows", async (code) => {
    await seedRoom(h);
    const marker = `${h.dir}/refusing`;
    const proposal = proposed(await edit("propose", 0, refusingBatch(marker, code), robot));
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    await writeFile(marker, "");
    const refused = refusalOf(await decide(proposal.proposal_id, "approve"));
    expect(refused.code).toBe("ENGINE_FAILED");
    expect(refused.message).toContain(code);
    expect(await snapshotOf(h)).toEqual(before);
    expect(before.proposals.map((p) => p.status)).toEqual(["open"]);
    expect(log.events).toEqual([]);
    await rm(marker);
    const decided = must(await decide(proposal.proposal_id, "approve"));
    expect(decided.proposal.status).toBe("approved");
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("hello world!");
  });

  test("a replay that does not reproduce the preview is ENGINE_FAILED: nothing is committed and the proposal stays open", async () => {
    await seedRoom(h);
    const source = `${h.dir}/source`;
    await writeFile(source, "!");
    const proposal = proposed(await edit("propose", 0, batch({ op: "append_file", path: source }), robot));
    expect(proposal.preview_sha256).toBe(sha256(bytesOf("hello world!")));
    await writeFile(source, "?");
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    const refused = refusalOf(await decide(proposal.proposal_id, "approve"));
    expect(refused.code).toBe("ENGINE_FAILED");
    expect(refused.message).toContain("preview");
    expect(await snapshotOf(h)).toEqual(before);
    expect(before.proposals.map((p) => p.status)).toEqual(["open"]);
    expect(log.events).toEqual([]);
  });

  test("approving one proposal gives each sibling its own verdict, in creation order, and leaves other documents alone", async () => {
    await seedRoom(h);
    must(await h.server.addDocument("room", alice, { name: "b.docx", format: "docx", bytes: bytesOf("bee") }));
    const first = proposed(await edit("propose", 0, batch({ op: "replace", find: "hello", text: "HELLO" }), robot));
    const second = proposed(await edit("propose", 0, batch({ op: "replace", find: "hello", text: "x" }), robot));
    const third = proposed(await edit("propose", 0, append("!"), robot));
    const elsewhere = proposed(await edit("propose", 0, append("?"), robot, "b.docx"));
    const log = await join(await seqNow());
    must(await decide(first.proposal_id, "approve"));
    const updates = log.ofType("proposal.updated").map((e) => [e.proposal.proposal_id, e.proposal.status]);
    expect(updates).toEqual([
      [first.proposal_id, "approved"],
      [second.proposal_id, "conflicted"],
      [third.proposal_id, "superseded"],
    ]);
    const room = await snapshotOf(h);
    expect(room.proposals.find((p) => p.proposal_id === elsewhere.proposal_id)?.status).toBe("open");
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("HELLO world");
  });
});

describe("pinned determinism and the approver", () => {
  test("the server pins what the client did not and keeps what it did, and the engine runs the batch under all four", async () => {
    await h.dispose();
    h = await makeHarness({ timezone: "Europe/Paris", locale: "fr-FR", seed: () => 4242 });
    await seedRoom(h);
    const first = committed(await edit("commit", 0, { ...batch({ op: "stamp" }), clock: "2026-02-03T04:05:06Z", seed: 7 })).entry;
    expect(first.batch).toEqual({ ops: [{ op: "stamp" }], clock: "2026-02-03T04:05:06Z", timezone: "Europe/Paris", locale: "fr-FR", seed: 7 });
    const second = committed(await edit("commit", 1, batch({ op: "stamp" }))).entry;
    expect(second.batch).toEqual({ ops: [{ op: "stamp" }], clock: second.batch.clock, timezone: "Europe/Paris", locale: "fr-FR", seed: 4242 });
    expect(second.batch.clock).not.toBe(first.batch.clock);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(`${HELLO}2026-02-03T04:05:06Z|Europe/Paris|fr-FR|7${second.batch.clock}|Europe/Paris|fr-FR|4242`);
  });

  test("a proposal approved under a later clock reproduces its preview: the pinned batch is replayed, and each entry names the approver", async () => {
    await seedRoom(h);
    const proposal = proposed(await edit("propose", 0, batch({ op: "stamp" }), robot));
    const [pinned] = proposal.batches;
    expectPinned(pinned, [{ op: "stamp" }]);
    must(await h.server.postComment("room", bob, { thread_id: null, doc_name: DOC, target_address: "p1", body: "later", mentions: [] }));
    const outcome = must(await decide(proposal.proposal_id, "approve", bob));
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]).toMatchObject({ batch: pinned, proposal_id: proposal.proposal_id, author: robot, approved_by: bob });
    expect(proposal.preview_sha256).toBe(outcome.head.sha256);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(`${HELLO}${pinned?.clock}|UTC|en-US|${pinned?.seed}`);
    expect((await snapshotOf(h)).session_log).toEqual(outcome.entries);
  });
});

describe("comments", () => {
  const post = (actor = alice, threadId: string | null = null, body = "note", extra: Partial<Parameters<typeof h.server.postComment>[2]> = {}) =>
    h.server.postComment("room", actor, { thread_id: threadId, doc_name: DOC, target_address: "p1", body, mentions: [], ...extra });

  test("a thread is opened, replied to, and resolved; mentions merge without duplicates", async () => {
    await seedRoom(h);
    const log = await join(await seqNow());
    const opened = must(await post(alice, null, "first", { mentions: [{ kind: "agent", id: "robot" }] }));
    expect(opened).toMatchObject({ doc_name: DOC, target_address: "p1", resolved: false, mentions: [{ kind: "agent", id: "robot" }] });
    expect(opened.messages).toHaveLength(1);
    const replied = must(await post(bob, opened.thread_id, "second", { mentions: [{ kind: "agent", id: "robot" }, { kind: "user", id: "alice" }] }));
    expect(replied.mentions).toEqual([{ kind: "agent", id: "robot" }, { kind: "user", id: "alice" }]);
    const resolved = must(await post(alice, opened.thread_id, "done", { resolve: true }));
    expect(resolved.resolved).toBe(true);
    expect(resolved.messages.map((m) => [m.author.id, m.body])).toEqual([["alice", "first"], ["bob", "second"], ["alice", "done"]]);
    expect((await snapshotOf(h)).comments).toEqual([resolved]);
    expect(log.ofType("comment.updated").map((e) => e.thread.messages.length)).toEqual([1, 2, 3]);
    log.expectValid();
  });

  test("refuses a reply to nothing, a thread on nothing, and a reply about another place", async () => {
    await seedRoom(h);
    const opened = must(await post());
    const before = await snapshotOf(h);
    expect(refusalOf(await post(alice, "no-such-thread")).code).toBe("UNKNOWN_THREAD");
    expect(refusalOf(await h.server.postComment("room", alice, { thread_id: null, doc_name: "missing.docx", target_address: "p1", body: "x", mentions: [] })).code).toBe("UNKNOWN_DOCUMENT");
    expect(refusalOf(await post(alice, opened.thread_id, "x", { target_address: "p9" })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await post(alice, null, "x", { resolve: true })).code).toBe("BAD_REQUEST");
    expect(await snapshotOf(h)).toEqual(before);
  });
});

describe("agent activity", () => {
  test("an agent's report is announced with a seq; anyone else, or a document that is not there, is refused", async () => {
    await seedRoom(h);
    const log = await join(await seqNow());
    must(await h.server.reportActivity("room", robot, { doc_name: DOC, activity: "reading", detail: "page 1" }));
    must(await h.server.reportActivity("room", robot, { doc_name: null, activity: "idle" }));
    const [first, second] = log.ofType("agent.activity");
    expect(first).toMatchObject({ agent: { id: "robot", name: "Robot" }, doc_name: DOC, activity: "reading", detail: "page 1" });
    expect(second).toMatchObject({ doc_name: null, activity: "idle" });
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    expect(refusalOf(await h.server.reportActivity("room", alice, { doc_name: DOC, activity: "reading" })).code).toBe("FORBIDDEN");
    expect(refusalOf(await h.server.reportActivity("room", robot, { doc_name: "missing.docx", activity: "reading" })).code).toBe("UNKNOWN_DOCUMENT");
    expect(log.events).toHaveLength(2);
    log.expectValid();
    expect((await snapshotOf(h)).seq).toBe(second?.seq ?? -1);
  });
});

describe("a failed batch commits nothing", () => {
  const FAULTS = ["crash", "garbage", "truncate", "wrong_req_id", "lie_sha", "invalid_response"];

  test.each(FAULTS)("worker fault %s mid-batch: no entry, no head change, no proposal, no event; the pool recovers", async (fault) => {
    await seedRoom(h);
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    const broken = batch({ op: "append", text: "x" }, { op: fault });
    const commit = refusalOf(await edit("commit", 0, broken));
    expect(commit.code).toBe("ENGINE_FAILED");
    expect(commit.message).toStartWith("the engine failed");
    expect(refusalOf(await edit("propose", 0, broken, robot)).code).toBe("ENGINE_FAILED");
    expect(await snapshotOf(h)).toEqual(before);
    expect(log.events).toEqual([]);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe(HELLO);
    const after = committed(await edit("commit", 0, append("!")));
    expect(after.entry.seq).toBe(before.seq + 1);
  });

  test("a batch the engine refuses (op failed after an op that worked) commits nothing", async () => {
    await seedRoom(h);
    const before = await snapshotOf(h);
    const refusal = refusalOf(await edit("commit", 0, batch({ op: "append", text: "x" }, { op: "fail", message: "boom" })));
    expect(refusal.code).toBe("BAD_REQUEST");
    expect(refusal.message).toContain("op-failed");
    expect(refusal.message).toContain("boom");
    expect(refusalOf(await edit("propose", 0, batch({ op: "replace", find: "absent", text: "x" }))).message).toContain("op-failed");
    expect(refusalOf(await edit("commit", 0, batch({ op: "refuse_nocmd" }))).message).toContain("bad-request");
    expect(await snapshotOf(h)).toEqual(before);
  });

  test.each(["internal-error", "reactor-document-limit"])("a %s refusal is ENGINE_FAILED, not a verdict on the batch: nothing is stored, and the same request can succeed later", async (code) => {
    await seedRoom(h);
    const marker = `${h.dir}/refusing`;
    await writeFile(marker, "");
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    const refusing = batch({ op: "refuse_while_exists", path: marker, code }, { op: "append", text: "!" });
    const commit = refusalOf(await edit("commit", 0, refusing));
    expect(commit.code).toBe("ENGINE_FAILED");
    expect(commit.message).toContain(code);
    expect(refusalOf(await edit("propose", 0, refusing, robot)).code).toBe("ENGINE_FAILED");
    expect(await snapshotOf(h)).toEqual(before);
    expect(log.events).toEqual([]);
    await rm(marker);
    committed(await edit("commit", 0, refusing));
  });

  test("a worker that never answers is cut off at the call timeout and commits nothing", async () => {
    await h.dispose();
    h = await makeHarness({ callTimeoutMs: 400 });
    await seedRoom(h);
    const before = await snapshotOf(h);
    const refusal = refusalOf(await edit("commit", 0, batch({ op: "hang" })));
    expect(refusal.code).toBe("ENGINE_FAILED");
    expect(refusal.message).toStartWith("the engine failed");
    expect(await snapshotOf(h)).toEqual(before);
    committed(await edit("commit", 0, append("!")));
  });
});

describe("restart", () => {
  test("a restarted server holds the same snapshot, resumes seq, and serves what was stored", async () => {
    await seedRoom(h);
    const everything = await join(null);
    committed(await edit("commit", 0, append("!")));
    const open = proposed(await edit("propose", 1, append("?"), robot));
    const stale = proposed(await edit("propose", 1, append("#"), robot));
    must(await decide(stale.proposal_id, "reject"));
    must(await h.server.postComment("room", bob, { thread_id: null, doc_name: DOC, target_address: "p1", body: "hi", mentions: [] }));
    must(await h.server.reportActivity("room", robot, { doc_name: DOC, activity: "proposing" }));
    const before = await snapshotOf(h);
    const mid = everything.ofType("doc.committed")[0]?.seq ?? 0;
    await h.restart();
    expect(await snapshotOf(h)).toEqual(before);
    expect(h.server.listSeats().map((s) => s.id).sort()).toEqual(["alice", "bob", "robot"]);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("hello world!");
    expect(textOf(must(await h.server.readPreview("room", alice, open.proposal_id)).bytes)).toBe("hello world!?");
    const resumed = await join(mid - 1);
    expect(resumed.events).toEqual(everything.events.filter((e) => e.type !== "error" && e.seq >= mid));
    const next = must(await decide(open.proposal_id, "approve"));
    expect(next.entries[0]?.seq).toBe(before.seq + 2);
    expect(next.head.revision).toBe(2);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("hello world!?");
    resumed.expectValid();
  });

  test("a damaged blob is damage, not an answer", async () => {
    await seedRoom(h);
    const { head } = must(await h.server.readHead("room", alice, DOC));
    await Bun.write(`${h.dir}/blobs/${head.sha256.slice(0, 2)}/${head.sha256}`, "tampered");
    const error = await h.server.readHead("room", alice, DOC).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("damaged");
  });
});

describe("a damaged room", () => {
  const damage = (sql: string): void => {
    const db = new Database(`${h.dir}/rooms.sqlite`);
    try {
      db.run(sql);
    } finally {
      db.close();
    }
  };
  const rejection = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => null,
      (e: unknown) => e,
    );

  for (const [what, body, message] of [
    ["is not JSON", "not json", "JSON"],
    ["is not an event of the contract", '{"type":"doc.committed","seq":2}', "stored doc.committed is invalid"],
  ] as const) {
    test(`a stored event that ${what} fails the join that replays it, and nothing is registered`, async () => {
      await seedRoom(h);
      committed(await edit("commit", 0, append("!")));
      const last = await seqNow();
      damage(`UPDATE events SET body = '${body}' WHERE room_id = 'room' AND seq = ${last}`);
      const log = new Collector();
      const error = await rejection(h.server.join("room", alice, last - 1, log.listener));
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toContain(message);
      committed(await edit("commit", 1, append("?")));
      expect(log.events).toEqual([]);
    });
  }

  test("a stored room that does not validate fails the join that asks for a snapshot", async () => {
    await seedRoom(h);
    proposed(await edit("propose", 0, append("!"), robot));
    damage(`UPDATE proposals SET body = '{"proposal_id":"id-3"}' WHERE room_id = 'room'`);
    const log = new Collector();
    const error = await rejection(h.server.join("room", alice, null, log.listener));
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("is not a valid");
    expect(log.events).toEqual([]);
  });
});

describe("events", () => {
  test("every event of a long session validates; seq is gapless from 1; every kind appears", async () => {
    must(await h.server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const all = await join(null);
    must(await h.server.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("p1\fp2") }));
    committed(await edit("commit", 0, append("!")));
    const approve = proposed(await edit("propose", 1, append("?"), robot));
    const reject = proposed(await edit("propose", 1, batch({ op: "replace", find: "p1", text: "P1" }), robot));
    expect(reject.status).toBe("open");
    must(await decide(reject.proposal_id, "reject"));
    must(await decide(approve.proposal_id, "approve"));
    must(await h.server.postComment("room", bob, { thread_id: null, doc_name: DOC, target_address: "p1", body: "hi", mentions: [] }));
    must(await h.server.reportActivity("room", robot, { doc_name: DOC, activity: "committing" }));
    all.expectValid();
    const kinds = new Set(all.events.map((e: RoomServerEvent) => e.type));
    expect([...kinds].sort()).toEqual(["agent.activity", "comment.updated", "doc.added", "doc.committed", "pages.invalidated", "proposal.updated", "room.snapshot"]);
    const room = await snapshotOf(h);
    const seqs = all.events.slice(1).map((e) => (e.type === "error" ? -1 : e.seq));
    expect(seqs).toEqual(Array.from({ length: room.seq }, (_, i) => i + 1));
  });
});
