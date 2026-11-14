import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_LIMIT,
  type ActivityItem,
  applyRoomEvent,
  documentSummaries,
  EMPTY_VIEW,
  historyOf,
  lastSeqOf,
  participantsOf,
  presenceFor,
  proposalSize,
  proposalsOf,
  type RoomView,
  threadsOf,
} from "../src/lib/room-state.ts";
import { ALICE, entry, head, proposal, room, SCOUT, SHA_B, thread } from "./fixtures.ts";

const joined = (over = {}): RoomView => applyRoomEvent(EMPTY_VIEW, { type: "room.snapshot", seq: 10, room: room(over) });

const activity = (seq: number, doc: string | null, kind: ActivityItem["activity"], agent = SCOUT): ActivityItem => ({
  type: "agent.activity",
  seq,
  agent: { id: agent.id, name: agent.name },
  doc_name: doc,
  activity: kind,
  at: "2026-11-13T18:40:00Z",
});

describe("applyRoomEvent", () => {
  test("a snapshot replaces the room", () => {
    const view = joined();
    expect(view.room?.room_id).toBe("q3-close");
    expect(lastSeqOf(view)).toBe(10);
    const again = applyRoomEvent(view, { type: "room.snapshot", seq: 12, room: room({ seq: 12, documents: [] }) });
    expect(again.room?.documents).toEqual([]);
    expect(lastSeqOf(again)).toBe(12);
  });

  test("events before the first snapshot change nothing", () => {
    expect(applyRoomEvent(EMPTY_VIEW, { type: "doc.added", seq: 1, document: { head: head("x.docx") } })).toBe(EMPTY_VIEW);
    expect(lastSeqOf(EMPTY_VIEW)).toBeNull();
  });

  test("a replayed event (seq already seen) changes nothing", () => {
    const view = joined();
    expect(applyRoomEvent(view, { type: "doc.added", seq: 10, document: { head: head("late.docx") } })).toBe(view);
    expect(applyRoomEvent(view, { type: "doc.added", seq: 4, document: { head: head("late.docx") } })).toBe(view);
  });

  test("error events change nothing", () => {
    const view = joined();
    expect(applyRoomEvent(view, { type: "error", request_id: "r1", code: "FORBIDDEN", message: "no" })).toBe(view);
  });

  test("doc.added adds a document and advances seq", () => {
    const view = applyRoomEvent(joined(), { type: "doc.added", seq: 11, document: { head: head("deck.pptx") } });
    expect(view.room?.documents.map((d) => d.head.name)).toEqual(["memo.docx", "model.xlsx", "deck.pptx"]);
    expect(lastSeqOf(view)).toBe(11);
  });

  test("doc.committed moves the head, keeps the page hashes, and appends the entry", () => {
    const start = joined({ documents: [{ head: head("memo.docx"), page_hashes: ["p1"] }] });
    const view = applyRoomEvent(start, { type: "doc.committed", seq: 11, head: head("memo.docx", 1, SHA_B), entry: entry(11, "memo.docx", 1) });
    expect(view.room?.documents).toEqual([{ head: head("memo.docx", 1, SHA_B), page_hashes: ["p1"] }]);
    expect(view.room?.session_log.map((e) => e.seq)).toEqual([11]);
  });

  test("pages.invalidated replaces the page hashes of that document only", () => {
    const view = applyRoomEvent(joined(), {
      type: "pages.invalidated",
      seq: 11,
      doc_name: "memo.docx",
      revision: 0,
      sha256: SHA_B,
      page_hashes: ["h1", "h2"],
      changed: [0, 1],
      removed: [],
    });
    expect(view.room?.documents[0]?.page_hashes).toEqual(["h1", "h2"]);
    expect(view.room?.documents[1]?.page_hashes).toBeUndefined();
  });

  test("proposal.updated and comment.updated upsert by id", () => {
    let view = applyRoomEvent(joined(), { type: "proposal.updated", seq: 11, proposal: proposal("p1", "memo.docx") });
    view = applyRoomEvent(view, { type: "proposal.updated", seq: 12, proposal: proposal("p1", "memo.docx", { status: "approved" }) });
    expect(view.room?.proposals.map((p) => [p.proposal_id, p.status])).toEqual([["p1", "approved"]]);
    view = applyRoomEvent(view, { type: "comment.updated", seq: 13, thread: thread("t1", "memo.docx") });
    view = applyRoomEvent(view, { type: "comment.updated", seq: 14, thread: thread("t1", "memo.docx", { resolved: true }) });
    expect(view.room?.comments.map((t) => [t.thread_id, t.resolved])).toEqual([["t1", true]]);
  });

  test("agent.activity goes to the stream, newest first, bounded", () => {
    let view = joined();
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) view = applyRoomEvent(view, activity(11 + i, "memo.docx", "reading"));
    expect(view.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(view.activity[0]?.seq).toBe(11 + ACTIVITY_LIMIT + 4);
    expect(lastSeqOf(view)).toBe(11 + ACTIVITY_LIMIT + 4);
  });
});

describe("selectors", () => {
  const state = room({
    documents: [{ head: head("model.xlsx", 2) }, { head: head("memo.docx", 1) }],
    proposals: [
      proposal("p-old", "memo.docx", { status: "rejected", created_at: "2026-11-13T17:00:00Z" }),
      proposal("p-new", "memo.docx", { created_at: "2026-11-13T19:00:00Z" }),
      proposal("p-mid", "memo.docx", { created_at: "2026-11-13T18:00:00Z" }),
      proposal("p-x", "model.xlsx"),
    ],
    comments: [
      thread("t-done", "memo.docx", { resolved: true }),
      thread("t-open", "memo.docx"),
      thread("t-x", "model.xlsx"),
    ],
    session_log: [entry(3, "memo.docx", 1), entry(5, "model.xlsx", 2), entry(4, "model.xlsx", 1)],
  });

  test("documentSummaries sorts by name and counts open proposals and threads", () => {
    expect(documentSummaries(state).map((d) => [d.name, d.format, d.revision, d.openProposals, d.openThreads])).toEqual([
      ["memo.docx", "docx", 1, 2, 1],
      ["model.xlsx", "xlsx", 2, 1, 1],
    ]);
    expect(documentSummaries(null)).toEqual([]);
  });

  test("proposalsOf puts open proposals first, newest first", () => {
    expect(proposalsOf(state, "memo.docx").map((p) => p.proposal_id)).toEqual(["p-new", "p-mid", "p-old"]);
    expect(proposalsOf(state, null)).toHaveLength(4);
  });

  test("threadsOf puts unresolved threads first", () => {
    expect(threadsOf(state, "memo.docx").map((t) => t.thread_id)).toEqual(["t-open", "t-done"]);
  });

  test("historyOf lists commits newest first", () => {
    expect(historyOf(state, "model.xlsx").map((e) => e.seq)).toEqual([5, 4]);
    expect(historyOf(state, null).map((e) => e.seq)).toEqual([5, 4, 3]);
  });

  test("proposalSize counts batches and ops", () => {
    expect(proposalSize(proposal("p", "memo.docx"))).toEqual({ batches: 1, ops: 2 });
  });

  test("participantsOf lists each actor once", () => {
    const view: RoomView = { room: state, activity: [activity(20, null, "reading")] };
    expect(participantsOf(view)).toEqual([ALICE, SCOUT]);
  });

  test("presenceFor keeps the latest word of each agent on the document, without idle agents", () => {
    const ivy = { kind: "agent" as const, id: "ivy", name: "Ivy" };
    const newestFirst = [
      activity(15, "memo.docx", "proposing"),
      activity(14, "memo.docx", "idle", ivy),
      activity(13, "model.xlsx", "reading", { kind: "agent", id: "max", name: "Max" }),
      activity(12, null, "searching", ivy),
      activity(11, "memo.docx", "reading"),
    ];
    expect(presenceFor(newestFirst, "memo.docx").map((a) => [a.agent.id, a.activity])).toEqual([["scout", "proposing"]]);
    expect(presenceFor(newestFirst.slice(2), "memo.docx").map((a) => [a.agent.id, a.activity])).toEqual([
      ["scout", "reading"],
      ["ivy", "searching"],
    ]);
  });
});
