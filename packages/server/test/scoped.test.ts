// The room service as a guest sees it: a short list of (room, document) pairs and nothing else. What lies outside the
// list answers exactly as what does not exist, and no event or snapshot carries it.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { type AccessScope, type RoomService, scopedService } from "../src/index.ts";
import { alice, bytesOf, Collector, type Harness, makeHarness, must, proposed, refusalOf, robot } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const DOC = "doc.docx";
const OTHER = "other.docx";
const viewer: RoomActor = { kind: "user", id: "viewer", name: "Viewer" };
const guest: RoomActor = { kind: "agent", id: "guest-bot", name: "Guest Bot" };
const append = (text: string) => ({ ops: [{ op: "append", text }] }) as never;

let h: Harness;
let guestService: RoomService;
let scopes: Map<string, AccessScope>;

beforeEach(async () => {
  h = await makeHarness();
  const s = h.server;
  must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  must(await s.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("hello") }));
  must(await s.addDocument("room", alice, { name: OTHER, format: "docx", bytes: bytesOf("secret") }));
  must(await s.createRoom(alice, { room_id: "hidden", workspace_id: "ws" }));
  must(await s.addDocument("hidden", alice, { name: "x.docx", format: "docx", bytes: bytesOf("x") }));
  scopes = new Map([
    [guest.id, { access: "propose", docs: [{ room_id: "room", doc_name: DOC }] }],
    [viewer.id, { access: "view", docs: [{ room_id: "room", doc_name: DOC }] }],
  ]);
  guestService = scopedService(s, (actor) => scopes.get(actor.id) ?? null);
});

afterEach(async () => {
  await h.dispose();
});

/** A failure with the name of what was asked for replaced, so that the failure for a thing out of scope can be
 * compared with the one for a thing that is not there. */
const shaped = (failure: { code: string; message: string }, name: string) => ({ code: failure.code, message: failure.message.split(name).join("<name>") });

describe("a guest that may propose", () => {
  test("proposes an edit to its document and comments on it, but cannot commit or decide", async () => {
    const proposal = proposed(await guestService.edit("room", guest, { doc_name: DOC, base_revision: 0, mode: "propose", batch: append("!") }));
    const thread = must(await guestService.postComment("room", guest, { thread_id: null, doc_name: DOC, target_address: "p1", body: "look", mentions: [] }));
    must(await guestService.postComment("room", guest, { thread_id: thread.thread_id, doc_name: DOC, target_address: "p1", body: "again", mentions: [] }));
    must(await guestService.readPreview("room", guest, proposal.proposal_id));
    must(await guestService.reportActivity("room", guest, { doc_name: DOC, activity: "reading" }));

    expect(refusalOf(await guestService.edit("room", guest, { doc_name: DOC, base_revision: 0, mode: "commit", batch: append("?") })).code).toBe("FORBIDDEN");
    expect(refusalOf(await guestService.decideProposal("room", guest, { proposal_id: proposal.proposal_id, decision: "approve" })).code).toBe("FORBIDDEN");
    expect(refusalOf(await guestService.createRoom(guest, { room_id: "mine", workspace_id: "ws" })).code).toBe("FORBIDDEN");
    expect(refusalOf(await guestService.addDocument("room", guest, { name: "new.docx", format: "docx", bytes: bytesOf("n") })).code).toBe("FORBIDDEN");
    // Nothing the guest was refused happened, and a member decides what it proposed.
    expect(must(await h.server.getRoom("room", alice)).documents.find((d) => d.head.name === DOC)?.head.revision).toBe(0);
    must(await h.server.decideProposal("room", alice, { proposal_id: proposal.proposal_id, decision: "approve" }));
  });
});

describe("a guest that may only view", () => {
  test("reads its document and cannot write at all", async () => {
    must(await guestService.getRoom("room", viewer));
    must(await guestService.readHead("room", viewer, DOC));
    const proposal = proposed(await h.server.edit("room", robot, { doc_name: DOC, base_revision: 0, mode: "propose", batch: append("!") }));
    must(await guestService.readPreview("room", viewer, proposal.proposal_id));

    for (const mode of ["propose", "commit"] as const) {
      expect(refusalOf(await guestService.edit("room", viewer, { doc_name: DOC, base_revision: 0, mode, batch: append("no") })).code).toBe("FORBIDDEN");
    }
    expect(refusalOf(await guestService.postComment("room", viewer, { thread_id: null, doc_name: DOC, target_address: "p1", body: "no", mentions: [] })).code).toBe("FORBIDDEN");
    expect(refusalOf(await guestService.decideProposal("room", viewer, { proposal_id: proposal.proposal_id, decision: "reject" })).code).toBe("FORBIDDEN");
    expect(refusalOf(await guestService.reportActivity("room", viewer, { doc_name: DOC, activity: "reading" })).code).toBe("FORBIDDEN");
  });
});

describe("what is outside the scope", () => {
  test("answers as a room, a document, a proposal or a thread that does not exist", async () => {
    const hiddenProposal = proposed(await h.server.edit("room", robot, { doc_name: OTHER, base_revision: 0, mode: "propose", batch: append("!") }));
    const hiddenThread = must(await h.server.postComment("room", alice, { thread_id: null, doc_name: OTHER, target_address: "p1", body: "private", mentions: [] }));
    const edit = (doc: string) => guestService.edit("room", guest, { doc_name: doc, base_revision: 0, mode: "propose", batch: append("x") });
    const comment = (doc: string) => guestService.postComment("room", guest, { thread_id: null, doc_name: doc, target_address: "p1", body: "x", mentions: [] });
    const reply = (id: string) => guestService.postComment("room", guest, { thread_id: id, doc_name: OTHER, target_address: "p1", body: "x", mentions: [] });

    const pairs: [{ code: string; message: string }, { code: string; message: string }, string][] = [
      [refusalOf(await guestService.getRoom("hidden", guest)), refusalOf(await guestService.getRoom("nowhere", guest)), "hidden"],
      [refusalOf(await guestService.join("hidden", guest, null, () => {})), refusalOf(await guestService.join("nowhere", guest, null, () => {})), "hidden"],
      [refusalOf(await guestService.readHead("hidden", guest, "x.docx")), refusalOf(await guestService.readHead("nowhere", guest, "x.docx")), "hidden"],
      [refusalOf(await guestService.readHead("room", guest, OTHER)), refusalOf(await guestService.readHead("room", guest, "missing.docx")), OTHER],
      [refusalOf(await edit(OTHER)), refusalOf(await edit("missing.docx")), OTHER],
      [refusalOf(await comment(OTHER)), refusalOf(await comment("missing.docx")), OTHER],
      [refusalOf(await guestService.reportActivity("room", guest, { doc_name: OTHER, activity: "reading" })), refusalOf(await guestService.reportActivity("room", guest, { doc_name: "missing.docx", activity: "reading" })), OTHER],
      [refusalOf(await guestService.readPreview("room", guest, hiddenProposal.proposal_id)), refusalOf(await guestService.readPreview("room", guest, "nothing")), hiddenProposal.proposal_id],
      [refusalOf(await reply(hiddenThread.thread_id)), refusalOf(await reply("nothing")), hiddenThread.thread_id],
    ];
    for (const [outside, absent, name] of pairs) {
      expect(shaped(outside, name)).toEqual(shaped(absent, name === "hidden" ? "nowhere" : name === OTHER ? "missing.docx" : "nothing"));
    }
    // Asking for the absent thing as a member shows what the guest must be told.
    expect(refusalOf(await h.server.readHead("room", alice, "missing.docx")).code).toBe("UNKNOWN_DOCUMENT");
    expect(must(await h.server.getRoom("room", alice)).proposals.some((p) => p.doc_name === OTHER)).toBe(true);
  });

  test("is left out of the state a guest reads", async () => {
    must(await h.server.edit("room", robot, { doc_name: OTHER, base_revision: 0, mode: "propose", batch: append("!") }));
    must(await h.server.postComment("room", alice, { thread_id: null, doc_name: OTHER, target_address: "p1", body: "private", mentions: [] }));
    must(await h.server.edit("room", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: append("?") }));

    const state = must(await guestService.getRoom("room", guest));
    expect(state.documents.map((d) => d.head.name)).toEqual([DOC]);
    expect(state.proposals).toEqual([]);
    expect(state.comments).toEqual([]);
    expect(state.session_log.map((e) => e.doc_name)).toEqual([DOC]);
    expect(JSON.stringify(state)).not.toContain(OTHER);
  });

  test("never appears in an event a guest is sent", async () => {
    const seen = new Collector();
    must(await guestService.join("room", guest, null, seen.listener));
    const fromStart = new Collector();
    must(await h.server.edit("room", alice, { doc_name: OTHER, base_revision: 0, mode: "commit", batch: append("1") }));
    must(await guestService.join("room", viewer, 0, fromStart.listener));

    const hidden = proposed(await h.server.edit("room", robot, { doc_name: OTHER, base_revision: 1, mode: "propose", batch: append("2") }));
    must(await h.server.postComment("room", alice, { thread_id: null, doc_name: OTHER, target_address: "p1", body: "private", mentions: [] }));
    must(await h.server.reportActivity("room", robot, { doc_name: OTHER, activity: "reading" }));
    must(await h.server.addDocument("room", alice, { name: "third.docx", format: "docx", bytes: bytesOf("3") }));
    must(await h.server.decideProposal("room", alice, { proposal_id: hidden.proposal_id, decision: "approve" }));
    must(await h.server.edit("room", alice, { doc_name: DOC, base_revision: 0, mode: "commit", batch: append("visible") }));
    must(await h.server.reportActivity("room", robot, { doc_name: DOC, activity: "reading" }));

    for (const log of [seen, fromStart]) {
      log.expectValid();
      const text = JSON.stringify(log.events);
      expect(text).not.toContain(OTHER);
      expect(text).not.toContain("third.docx");
      expect(text).not.toContain("private");
    }
    expect(seen.ofType("doc.committed").map((e) => e.head.name)).toEqual([DOC]);
    expect(seen.ofType("agent.activity").map((e) => e.doc_name)).toEqual([DOC]);
    // Joining again from before the hidden edits gets a snapshot or a backlog with the same restraint.
    expect(fromStart.ofType("room.snapshot").every((e) => e.room.documents.every((d) => d.head.name === DOC))).toBe(true);
  });
});

describe("a member", () => {
  test("is not limited: every call reaches the service as it is", async () => {
    must(await guestService.addDocument("room", alice, { name: "member.docx", format: "docx", bytes: bytesOf("m") }));
    const state = must(await guestService.getRoom("room", alice));
    expect(state.documents.map((d) => d.head.name).sort()).toEqual([DOC, OTHER, "member.docx"].sort());
    must(await guestService.getRoom("hidden", alice));
    must(await guestService.edit("room", alice, { doc_name: OTHER, base_revision: 0, mode: "commit", batch: append("!") }));
  });
});
