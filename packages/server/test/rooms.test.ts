// The rooms: documents, commits, revision checks, proposals, comments, activity and what a failed batch leaves
// behind. The engine is the stand-in reactor over real pipes; every hash the tests expect is computed here.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm, writeFile } from "node:fs/promises";
import { type RoomBatch, type RoomPinnedBatch, type RoomServerEvent, validateRoomEvent } from "@wolfsdk/protocol/workspace";
import type { EditRequest } from "../src/index.ts";
import type { RoomEditOutcome } from "../src/rooms.ts";
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

// Writes are flushed to disk and processes are started: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

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

  describe("an edit equal to an open proposal opens nothing new", () => {
    /** The outcome of an edit that must have proposed: the proposal, and whether it already existed. */
    const proposalOf = (outcome: RoomEditOutcome): Extract<RoomEditOutcome, { mode: "propose" }> => {
      if (outcome.mode !== "propose") throw new Error("expected a proposal, got a commit");
      return outcome;
    };
    const cell = "table:Revenue/row:@2/cell:@2";
    /** What a pack refresh (`refreshPackInRoom` of @wolfsdk/packs) sends for one document: the planned batch,
     * labelled as the pack's refresh and pinned to its source's clock, against the revision it read the document at. */
    const packRefresh = async (value: string) => {
      const { head } = must(await h.server.readHead("room", robot, DOC));
      const refresh: RoomBatch = { ops: [{ op: "set_text", target: cell, text: value }], label: "pack q4: refresh", clock: "2026-11-13T00:00:00Z" };
      return proposalOf(must(await h.server.edit("room", robot, { doc_name: DOC, base_revision: head.revision, mode: "propose", batch: refresh })));
    };

    test("a repeated pack refresh, and the agent's edit equal to it, answer with the open proposal and say it existed", async () => {
      await seedRoom(h);
      const opened = await packRefresh("42");
      expect(opened).toMatchObject({ mode: "propose", existed: false, proposal: { status: "open", base_revision: 0 } });
      const log = await join(await seqNow());
      const before = await snapshotOf(h);
      const again = await packRefresh("42");
      expect(again).toEqual({ mode: "propose", proposal: opened.proposal, existed: true });
      // The agent proposes the same ops itself, without the refresh's label or clock: still the same proposal.
      const own = proposalOf(must(await edit("propose", 0, batch({ op: "set_text", target: cell, text: "42" }), robot)));
      expect(own).toEqual(again);
      expect(log.events).toEqual([]);
      expect(await snapshotOf(h)).toEqual(before);
      expect(before.proposals.map((p) => p.proposal_id)).toEqual([opened.proposal.proposal_id]);

      // Two refreshes with another value race: the document lock lets one open a proposal, the other finds it.
      const raced = await Promise.all([packRefresh("43"), packRefresh("43")]);
      expect(raced.map((r) => r.existed).sort()).toEqual([false, true]);
      expect(raced[0]?.proposal).toEqual(raced[1]?.proposal);
      expect(log.ofType("proposal.updated").map((e) => e.proposal)).toEqual([raced[0]?.proposal]);
      const open = (await snapshotOf(h)).proposals.filter((p) => p.status === "open");
      expect(open.map((p) => p.proposal_id)).toEqual([opened.proposal.proposal_id, raced[0]?.proposal.proposal_id]);
      log.expectValid();
    });

    test("a repeated agent edit answers with the open proposal; other ops, or ops whose proposal was closed, open a new one", async () => {
      await seedRoom(h);
      const opened = proposalOf(must(await edit("propose", 0, append("!"), robot)));
      expect(opened.existed).toBe(false);
      const log = await join(await seqNow());
      const again = proposalOf(must(await edit("propose", 0, { ...append("!"), label: "retry" }, robot)));
      expect(again).toEqual({ mode: "propose", proposal: opened.proposal, existed: true });
      expect(log.events).toEqual([]);

      const other = proposalOf(must(await edit("propose", 0, append("?"), robot)));
      expect(other.existed).toBe(false);
      must(await decide(opened.proposal.proposal_id, "reject"));
      const reopened = proposalOf(must(await edit("propose", 0, append("!"), robot)));
      expect(reopened.existed).toBe(false);
      expect(reopened.proposal.proposal_id).not.toBe(opened.proposal.proposal_id);
      const open = (await snapshotOf(h)).proposals.filter((p) => p.status === "open");
      expect(open.map((p) => p.proposal_id)).toEqual([other.proposal.proposal_id, reopened.proposal.proposal_id]);
      log.expectValid();
    });
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

  test("approving one proposal supersedes the siblings it overlaps and rebases the disjoint ones, in creation order", async () => {
    await seedRoom(h);
    must(await h.server.addDocument("room", alice, { name: "b.docx", format: "docx", bytes: bytesOf("bee") }));
    const row = "table:Revenue/row:@2";
    const approved = proposed(await edit("propose", 0, batch({ op: "replace", target: row, find: "hello", text: "HELLO" }), robot));
    // Overlapping: a cell of the approved row; a row the approved batch may have renumbered; an op with no target.
    const cell = proposed(await edit("propose", 0, batch({ op: "append", target: `${row}/cell:@1`, text: "!" }), robot));
    const shifted = proposed(await edit("propose", 0, batch({ op: "append", target: "table:Revenue/row:@3", text: "#" }), robot));
    const anywhere = proposed(await edit("propose", 0, append("*"), robot));
    // Disjoint: one that still applies on the new head, and one the engine refuses there.
    const paragraph = proposed(await edit("propose", 0, batch({ op: "append", target: "para:@1", text: "?" }), robot));
    const broken = proposed(await edit("propose", 0, batch({ op: "replace", target: "para:@2", find: "hello", text: "x" }), bob));
    const elsewhere = proposed(await edit("propose", 0, append("?"), robot, "b.docx"));
    const log = await join(await seqNow());
    must(await decide(approved.proposal_id, "approve"));
    log.expectValid();

    const updates = log.ofType("proposal.updated").map((e) => [e.proposal.proposal_id, e.proposal.status, e.proposal.base_revision]);
    expect(updates).toEqual([
      [approved.proposal_id, "approved", 0],
      [cell.proposal_id, "superseded", 0],
      [shifted.proposal_id, "superseded", 0],
      [anywhere.proposal_id, "superseded", 0],
      [paragraph.proposal_id, "open", 1],
      [broken.proposal_id, "conflicted", 0],
    ]);
    // A closed proposal gets a thread that names the approved proposal (and the engine's message, for a failed
    // rebase) and mentions its author; a rebased one gets none.
    const notes = new Map(log.ofType("comment.updated").map((e) => [e.thread.target_address, e.thread]));
    expect([...notes.keys()]).toEqual([cell, shifted, anywhere, broken].map((p) => `proposal:${p.proposal_id}`));
    const by = `proposal ${approved.proposal_id}, which ${alice.name} approved`;
    const note = (p: { proposal_id: string }) => notes.get(`proposal:${p.proposal_id}`);
    expect(note(cell)).toMatchObject({
      doc_name: DOC,
      mentions: [{ kind: "agent", id: robot.id }],
      messages: [{ author: alice, body: `Superseded by ${by}: ${row}/cell:@1 overlaps ${row}.` }],
      resolved: false,
    });
    expect(note(shifted)?.messages[0]?.body).toBe(`Superseded by ${by}: table:Revenue/row:@3 overlaps ${row}.`);
    expect(note(anywhere)?.messages[0]?.body).toBe(`Superseded by ${by}: it has an op that names no target, so it may change anything.`);
    expect(note(broken)).toMatchObject({ mentions: [{ kind: "user", id: bob.id }] });
    expect(note(broken)?.messages[0]?.body).toStartWith(`Could not be rebased on revision 1 after ${by}: `);
    expect(note(broken)?.messages[0]?.body).toContain('"hello" is not in the document');

    // The rebased proposal previews its batch on the new head, and approving it commits exactly that preview.
    const room = await snapshotOf(h);
    const rebased = room.proposals.find((p) => p.proposal_id === paragraph.proposal_id);
    expect(rebased).toEqual({ ...paragraph, base_revision: 1, preview_sha256: sha256(bytesOf("HELLO world?")) });
    expect(textOf(must(await h.server.readPreview("room", alice, paragraph.proposal_id)).bytes)).toBe("HELLO world?");
    expect(room.proposals.find((p) => p.proposal_id === elsewhere.proposal_id)).toEqual(elsewhere);
    expect(textOf(must(await h.server.readHead("room", alice, DOC)).bytes)).toBe("HELLO world");
    const second = must(await decide(paragraph.proposal_id, "approve"));
    expect(second.head).toMatchObject({ revision: 2, sha256: sha256(bytesOf("HELLO world?")) });
    expect(second.entries[0]).toMatchObject({ revision: 2, proposal_id: paragraph.proposal_id, approved_by: alice });
  });

  test("a direct commit still closes every open proposal of the document, without a note", async () => {
    await seedRoom(h);
    const paragraph = proposed(await edit("propose", 0, batch({ op: "append", target: "para:@1", text: "?" }), robot));
    const log = await join(await seqNow());
    committed(await edit("commit", 0, batch({ op: "replace", target: "table:Revenue/row:@2", find: "hello", text: "HELLO" })));
    expect(log.ofType("proposal.updated").map((e) => e.proposal)).toEqual([{ ...paragraph, status: "superseded" }]);
    expect(log.ofType("comment.updated")).toEqual([]);
  });

  test("a licence or budget refusal of a rebase closes the sibling as superseded, with the engine's message", async () => {
    await seedRoom(h);
    const marker = `${h.dir}/refusing`;
    const approved = proposed(await edit("propose", 0, batch({ op: "append", target: "table:Revenue/row:Q4", text: "!" }), robot));
    const sibling = proposed(
      await edit("propose", 0, batch({ op: "refuse_while_exists", target: "para:#5C7700D1", path: marker, code: "internal-error" }), robot),
    );
    const log = await join(await seqNow());
    await writeFile(marker, "");
    must(await decide(approved.proposal_id, "approve"));
    expect(log.ofType("proposal.updated").map((e) => [e.proposal.proposal_id, e.proposal.status])).toEqual([
      [approved.proposal_id, "approved"],
      [sibling.proposal_id, "superseded"],
    ]);
    expect(log.ofType("comment.updated")[0]?.thread.messages[0]?.body).toContain("internal-error");
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

  test("an edit announced by its agent lands the announcement ahead of its own event, and a refused edit announces nothing", async () => {
    await seedRoom(h);
    const before = await snapshotOf(h);
    const log = await join(before.seq);
    const announce = { doc_name: DOC, activity: "committing", detail: "1 op" } as const;
    const request = (mode: EditRequest["mode"], base: number, b: RoomBatch, doc = DOC): EditRequest => ({ doc_name: doc, base_revision: base, mode, batch: b });

    // Refused for every reason the room has, each leaves no event at all.
    expect(refusalOf(await h.server.edit("room", robot, request("commit", 0, batch({ op: "replace", find: "absent", text: "x" })), { announce })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await h.server.edit("room", robot, request("propose", 0, batch({ op: "fail", message: "boom" })), { announce })).code).toBe("BAD_REQUEST");
    expect(refusalOf(await h.server.edit("room", robot, request("commit", 7, append("x")), { announce })).code).toBe("REVISION_MISMATCH");
    expect(refusalOf(await h.server.edit("room", robot, request("commit", 0, append("x"), "missing.docx"), { announce })).code).toBe("UNKNOWN_DOCUMENT");
    expect(refusalOf(await h.server.edit("room", robot, request("commit", 0, append("x")), { announce: { ...announce, doc_name: "missing.docx" } })).code).toBe("UNKNOWN_DOCUMENT");
    // Only an agent announces; a person's edit with an announcement is refused, and a plain edit is as it was.
    expect(refusalOf(await h.server.edit("room", alice, request("commit", 0, append("x")), { announce })).code).toBe("FORBIDDEN");
    expect(await snapshotOf(h)).toEqual(before);
    expect(log.events).toEqual([]);

    const proposal = must(await h.server.edit("room", robot, request("propose", 0, append("p")), { announce: { ...announce, activity: "proposing" } }));
    expect(proposal).toMatchObject({ mode: "propose", existed: false });
    const commit = must(await h.server.edit("room", robot, request("commit", 0, append("!")), { announce }));
    expect(commit.mode).toBe("commit");
    const types = log.events.map((event) => event.type);
    expect(types.filter((type) => type === "agent.activity")).toHaveLength(2);
    expect(types.indexOf("agent.activity")).toBeLessThan(types.indexOf("proposal.updated"));
    const proposing = log.ofType("agent.activity")[0];
    const committing = log.ofType("agent.activity")[1];
    const committedEvent = log.ofType("doc.committed")[0];
    expect(proposing).toMatchObject({ agent: { id: "robot" }, doc_name: DOC, activity: "proposing" });
    expect(committing).toMatchObject({ activity: "committing", detail: "1 op" });
    expect(committedEvent?.seq).toBe((committing?.seq ?? -1) + 1);
    expect(types.indexOf("doc.committed")).toBe(types.lastIndexOf("agent.activity") + 1);
    log.expectValid();
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
    h = await makeHarness({ callTimeoutMs: 5_000 });
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
