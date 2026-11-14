// The eight tools, one session at a time: what each returns, what each refuses, and what each leaves in the room.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { type DocumentEngine, RoomServer } from "@wolfsdk/server";
import { McpServer, blankDocument } from "../src/index.ts";
import type { McpSession } from "../src/server.ts";
import { BRIEF_LINES, alice, bob, callTool, dataOf, disposeAll, headOf, listen, makeWorkspace, must, onDispose, openSession, robot, steppingClock, toolErrorOf, type Workspace } from "./fixtures/workspace.ts";
import { MEMORY_ENTITLEMENT, MemoryEngine, wordDocument } from "./fixtures/memory-engine.ts";

afterEach(disposeAll);

async function setup(): Promise<{ workspace: Workspace; session: McpSession }> {
  const workspace = await makeWorkspace();
  return { workspace, session: await openSession(workspace.mcp) };
}

describe("workspace_list", () => {
  test("lists the documents with their heads and what is open on them", async () => {
    const { workspace, session } = await setup();
    const brief = must(await workspace.room.readHead("room", alice, "brief.docx")).head;
    must(
      await workspace.room.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] }),
    );
    const proposed = await callTool(session, "doc_edit", {
      doc: "brief.docx",
      base_revision: 0,
      mode: "propose",
      ops: [{ op: "append_paragraph", text: "Open item" }],
    });
    const data = dataOf(await callTool(session, "workspace_list"));
    expect(data.room_id).toBe("room");
    expect(data.total_documents).toBe(2);
    expect(data.truncated).toBe(false);
    expect(data.documents).toEqual([
      { name: "brief.docx", format: "docx", revision: 0, sha256: brief.sha256, updated_at: brief.updated_at, open_proposals: 1, open_threads: 1 },
      expect.objectContaining({ name: "model.xlsx", format: "xlsx", revision: 0, open_proposals: 0, open_threads: 0 }),
    ]);
    expect(data.proposals).toEqual([
      expect.objectContaining({ proposal_id: dataOf(proposed).proposal_id, doc_name: "brief.docx", base_revision: 0, author: "robot", ops: 1 }),
    ]);
    expect(data.packs).toEqual([]);
    expect(data.seq).toBeGreaterThan(0);
  });

  test("shows each open thread with what was said, so the agent can answer it by id", async () => {
    const { workspace, session } = await setup();
    must(
      await workspace.room.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] }),
    );
    const [thread] = dataOf(await callTool(session, "workspace_list")).threads as { thread_id: string; messages: { author: string; body: string }[] }[];
    expect(thread).toMatchObject({ doc_name: "brief.docx", target_address: "para:@2", mentions: [] });
    expect(thread?.messages.map(({ author, body }) => ({ author, body }))).toEqual([{ author: alice.id, body: "Source?" }]);
    const reply = await callTool(session, "comment_reply", { thread_id: thread?.thread_id, body: "The Q3 ledger.", resolve: true });
    expect(reply.isError).toBeFalsy();
    expect(dataOf(await callTool(session, "workspace_list")).threads).toEqual([]);
  });

  test("filters by format and cuts at the limit", async () => {
    const { session } = await setup();
    const sheets = dataOf(await callTool(session, "workspace_list", { format: "xlsx" }));
    expect((sheets.documents as { name: string }[]).map((d) => d.name)).toEqual(["model.xlsx"]);
    const cut = dataOf(await callTool(session, "workspace_list", { limit: 1 }));
    expect(cut.documents).toHaveLength(1);
    expect(cut.total_documents).toBe(2);
    expect(cut.truncated).toBe(true);
  });

  test("a result is one JSON text block that equals its structured content", async () => {
    const { session } = await setup();
    const result = await callTool(session, "workspace_list");
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    expect(block?.type).toBe("text");
    expect(JSON.parse((block as { text: string }).text)).toEqual(result.structuredContent);
    expect(result.isError).toBeUndefined();
  });
});

describe("doc_read", () => {
  test("reads the structure with addresses, kinds and text previews", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_read", { doc: "brief.docx" }));
    expect(data).toMatchObject({ doc: "brief.docx", format: "docx", revision: 0, view: "structure", truncated: false });
    const nodes = data.nodes as { address: string; kind: string; text?: string }[];
    expect(nodes.map((n) => n.text)).toEqual([...BRIEF_LINES]);
    expect(nodes.every((n) => n.address.startsWith("para:"))).toBe(true);
    expect(data.total).toBe(BRIEF_LINES.length);
  });

  test("reads text and markdown, whole or at an address", async () => {
    const { session } = await setup();
    const text = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }));
    expect(text.text).toBe(BRIEF_LINES.join("\n"));
    const markdown = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "markdown" }));
    expect(String(markdown.markdown)).toContain("Revenue grew in Q3.");
    const one = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", target: "para:@3" }));
    expect(one).toMatchObject({ target: "para:@3", text: "Costs are flat." });
  });

  test("cuts a long answer to max_nodes and says so", async () => {
    const { session } = await setup();
    const cut = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", max_nodes: 2 }));
    expect(cut.nodes).toHaveLength(2);
    expect(cut.total).toBe(BRIEF_LINES.length);
    expect(cut.truncated).toBe(true);
    const lines = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", max_nodes: 2 }));
    expect(lines.text).toBe(`${BRIEF_LINES[0]}\n${BRIEF_LINES[1]}`);
    expect(lines.truncated).toBe(true);
  });

  test("reads the cells of a workbook, and refuses the cells of a document", async () => {
    const { workspace, session } = await setup();
    const sheet = dataOf(await callTool(session, "doc_read", { doc: "model.xlsx", view: "cells" }));
    expect(sheet.view).toBe("cells");
    expect(Array.isArray(sheet.cells)).toBe(true);
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "cells" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "unsupported-view" });
    expect(workspace.engine.replays.length).toBeGreaterThan(0);
  });

  test("refuses an unknown document and an address that names nothing", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "doc_read", { doc: "missing.docx" })).code).toBe("UNKNOWN_DOCUMENT");
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx", target: "para:@99" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "address-unresolved" });
  });

  test("a document the reader can not open is a BAD_REQUEST, not a crash", async () => {
    const { workspace, session } = await setup();
    must(await workspace.room.addDocument("room", alice, { name: "broken.docx", format: "docx", bytes: new TextEncoder().encode("not a package") }));
    const error = toolErrorOf(await callTool(session, "doc_read", { doc: "broken.docx" }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toEqual({ reason: "invalid-input" });
  });
});

describe("doc_search", () => {
  test("finds a literal ignoring case, with an address that doc_read accepts", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_search", { query: "REVENUE" }));
    const hits = data.hits as { doc: string; address: string; snippet: string; revision: number }[];
    expect(hits).toEqual([{ doc: "brief.docx", address: "para:@2", snippet: "Revenue grew in Q3.", revision: 0 }]);
    expect(data).toMatchObject({ regex: false, truncated: false, searched: 2 });
    const read = dataOf(await callTool(session, "doc_read", { doc: hits[0]?.doc, view: "text", target: hits[0]?.address }));
    expect(read.text).toBe("Revenue grew in Q3.");
  });

  test("a literal is not a pattern", async () => {
    const { session } = await setup();
    expect(dataOf(await callTool(session, "doc_search", { query: "Q[0-9]" })).hits).toEqual([]);
    const hits = dataOf(await callTool(session, "doc_search", { query: "Q[0-9]", regex: true })).hits as { address: string }[];
    expect(hits.map((h) => h.address)).toEqual(["para:@2"]);
  });

  test("stops at the limit and says there was more", async () => {
    const { session } = await setup();
    const data = dataOf(await callTool(session, "doc_search", { query: "e", limit: 1 }));
    expect(data.hits).toHaveLength(1);
    expect(data.truncated).toBe(true);
  });

  test("searches one document when asked, and skips an unreadable one when it searches them all", async () => {
    const { workspace, session } = await setup();
    must(await workspace.room.addDocument("room", alice, { name: "broken.docx", format: "docx", bytes: new TextEncoder().encode("not a package") }));
    const all = dataOf(await callTool(session, "doc_search", { query: "costs" }));
    expect(all.skipped).toEqual([expect.objectContaining({ doc: "broken.docx" })]);
    expect(all.searched).toBe(2);
    expect((all.hits as unknown[]).length).toBe(1);
    expect(toolErrorOf(await callTool(session, "doc_search", { query: "costs", doc: "broken.docx" })).code).toBe("BAD_REQUEST");
    expect(toolErrorOf(await callTool(session, "doc_search", { query: "costs", doc: "missing.docx" })).code).toBe("UNKNOWN_DOCUMENT");
  });

  test("terminates a catastrophic backtracking regex without stalling concurrent room calls", async () => {
    const { session } = await setup();
    const started = performance.now();
    const [searchRes, listRes] = await Promise.all([
      callTool(session, "doc_search", { query: "(.*.*)*!", regex: true }),
      callTool(session, "workspace_list"),
    ]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(dataOf(listRes).total_documents).toBe(2);
    const err = toolErrorOf(searchRes);
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.detail).toEqual({ reason: "regex-timeout" });
  });
});

describe("doc_create", () => {
  test("creates a blank document that can be read at once", async () => {
    const { session } = await setup();
    const created = dataOf(await callTool(session, "doc_create", { name: "plan.docx", format: "docx" }));
    expect(created).toMatchObject({ doc: "plan.docx", format: "docx", revision: 0 });
    expect(dataOf(await callTool(session, "workspace_list")).total_documents).toBe(3);
    expect(dataOf(await callTool(session, "doc_read", { doc: "plan.docx", view: "text" })).revision).toBe(0);
  });

  test("creates the other formats too", async () => {
    const { session } = await setup();
    for (const [name, format] of [["data.xlsx", "xlsx"], ["deck.pptx", "pptx"]] as const) {
      // A format the engine does not hold is still a document the room can keep; the room asks the engine to open it.
      const result = await callTool(session, "doc_create", { name, format });
      expect(dataOf(result)).toMatchObject({ doc: name, format, revision: 0 });
    }
  });

  test("applies the first ops as a commit and reports its entry", async () => {
    const { workspace, session } = await setup();
    const created = dataOf(
      await callTool(session, "doc_create", { name: "plan.docx", format: "docx", ops: [{ op: "append_paragraph", text: "Goals" }] }),
    );
    expect(created).toMatchObject({ doc: "plan.docx", revision: 1 });
    expect(typeof created.entry_id).toBe("number");
    const entry = must(await workspace.room.getRoom("room", alice)).session_log.find((e) => e.seq === created.entry_id);
    expect(entry).toMatchObject({ doc_name: "plan.docx", revision: 1, author: robot });
    expect(dataOf(await callTool(session, "doc_read", { doc: "plan.docx", view: "text" })).text).toBe("Goals");
  });

  test("copies a template", async () => {
    const { workspace, session } = await setup();
    const created = dataOf(await callTool(session, "doc_create", { name: "copy.docx", format: "docx", template: "brief.docx" }));
    expect(created).toMatchObject({ doc: "copy.docx", template: "brief.docx", revision: 0, sha256: (await headOf(workspace, "brief.docx")).sha256 });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "x.docx", format: "docx", template: "model.xlsx" })).detail).toEqual({ reason: "template-format" });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "x.docx", format: "docx", template: "nope.docx" })).code).toBe("UNKNOWN_DOCUMENT");
  });

  test("refuses a name that does not end in the format, and a name that is taken", async () => {
    const { session } = await setup();
    const wrong = toolErrorOf(await callTool(session, "doc_create", { name: "plan.xlsx", format: "docx" }));
    expect(wrong).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "name-extension" } });
    expect(toolErrorOf(await callTool(session, "doc_create", { name: "brief.docx", format: "docx" })).code).toBe("BAD_REQUEST");
  });

  test("when the ops are refused the document exists, and the error says so", async () => {
    const { workspace, session } = await setup();
    const error = toolErrorOf(await callTool(session, "doc_create", { name: "plan.docx", format: "docx", ops: [{ op: "no_such_op" }] }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.detail).toMatchObject({ created: { doc: "plan.docx", revision: 0 } });
    expect(must(await workspace.room.readHead("room", alice, "plan.docx")).head.revision).toBe(0);
  });
});

describe("doc_edit", () => {
  test("commit applies the ops at once and reports the new head and the log entry", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    const data = dataOf(
      await callTool(session, "doc_edit", {
        doc: "brief.docx",
        base_revision: 0,
        mode: "commit",
        ops: [{ op: "replace_text", find: "flat", text: "down 2%" }],
        message: "fix the cost line",
      }),
    );
    expect(data).toMatchObject({ mode: "commit", doc: "brief.docx", revision: 1, base_sha256: before.sha256 });
    expect(data.sha256).not.toBe(before.sha256);
    expect(await headOf(workspace, "brief.docx")).toEqual({ revision: 1, sha256: data.sha256 as string });
    const entry = must(await workspace.room.getRoom("room", alice)).session_log.find((e) => e.seq === data.entry_id);
    expect(entry).toMatchObject({ author: robot, base_sha256: before.sha256, result_sha256: data.sha256, proposal_id: null, batch: { label: "fix the cost line" } });
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", target: "para:@3" })).text).toBe("Costs are down 2%.");
  });

  test("propose holds the ops for a person and changes nothing", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    const data = dataOf(
      await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Decision" }] }),
    );
    expect(data).toMatchObject({ mode: "propose", status: "open", doc: "brief.docx", base_revision: 0, ops: 1 });
    expect(data.preview_sha256).not.toBe(before.sha256);
    expect(typeof data.proposal_id).toBe("string");
    expect(await headOf(workspace, "brief.docx")).toEqual(before);
    const proposal = must(await workspace.room.getRoom("room", alice)).proposals[0];
    expect(proposal).toMatchObject({ proposal_id: data.proposal_id, author: robot, status: "open" });
  });

  test("a person approving the proposal commits it, and the agent then reads the result", async () => {
    const { workspace, session } = await setup();
    const proposed = dataOf(
      await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Decision" }] }),
    );
    const decided = must(await workspace.room.decideProposal("room", alice, { proposal_id: proposed.proposal_id as string, decision: "approve" }));
    expect(decided.head.revision).toBe(1);
    expect(decided.head.sha256).toBe(proposed.preview_sha256 as string);
    const read = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }));
    expect(read).toMatchObject({ revision: 1, sha256: proposed.preview_sha256 });
    expect(String(read.text).endsWith("Decision")).toBe(true);
  });

  test("a stale base_revision is REVISION_MISMATCH carrying the head to rebase on", async () => {
    const { session } = await setup();
    const op = [{ op: "append_paragraph", text: "More" }];
    expect(dataOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: op })).revision).toBe(1);
    const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: op }));
    expect(error.code).toBe("REVISION_MISMATCH");
    expect(error.detail).toMatchObject({ doc_name: "brief.docx", base_revision: 0, head: { revision: 1 } });
  });

  test("an op the engine refuses commits nothing and says why", async () => {
    const { workspace, session } = await setup();
    const before = await headOf(workspace, "brief.docx");
    for (const mode of ["commit", "propose"] as const) {
      const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode, ops: [{ op: "replace_text", find: "absent", text: "x" }] }));
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toContain("text-not-found");
    }
    expect(await headOf(workspace, "brief.docx")).toEqual(before);
    expect(must(await workspace.room.getRoom("room", alice)).proposals).toEqual([]);
  });

  test("an unknown document is UNKNOWN_DOCUMENT", async () => {
    const { session } = await setup();
    const error = toolErrorOf(await callTool(session, "doc_edit", { doc: "missing.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] }));
    expect(error.code).toBe("UNKNOWN_DOCUMENT");
  });
});

describe("comment_reply", () => {
  async function thread(workspace: Workspace, body = "Can you check the Q3 figure?"): Promise<string> {
    return must(
      await workspace.room.postComment("room", alice, {
        thread_id: null,
        doc_name: "brief.docx",
        target_address: "para:@2",
        body,
        mentions: [{ kind: "agent", id: "robot" }],
      }),
    ).thread_id;
  }

  test("replies in the thread as the agent", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "Checked: it is right." }));
    const reply = data.thread as { thread_id: string; resolved: boolean; messages: { author: unknown; body: string }[] };
    expect(reply.thread_id).toBe(id);
    expect(reply.resolved).toBe(false);
    expect(reply.messages.map((m) => m.body)).toEqual(["Can you check the Q3 figure?", "Checked: it is right."]);
    expect(reply.messages[1]?.author).toEqual(robot);
    expect(data.unresolved_mentions).toBeUndefined();
  });

  test("resolves the thread with the reply", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "Done.", resolve: true }));
    expect((data.thread as { resolved: boolean }).resolved).toBe(true);
    expect(dataOf(await callTool(session, "workspace_list")).documents).toEqual([
      expect.objectContaining({ name: "brief.docx", open_threads: 0 }),
      expect.anything(),
    ]);
  });

  test("turns @id into a mention of an actor the room knows, and reports the ids that name nobody", async () => {
    const { workspace, session } = await setup();
    const id = await thread(workspace);
    must(await workspace.room.postComment("room", bob, { thread_id: id, doc_name: "brief.docx", target_address: "para:@2", body: "Me too", mentions: [] }));
    const data = dataOf(await callTool(session, "comment_reply", { thread_id: id, body: "@alice and @bob. Also @ghost, ok?" }));
    const mentions = (data.thread as { mentions: { kind: string; id: string }[] }).mentions;
    expect(mentions).toEqual([
      { kind: "agent", id: "robot" },
      { kind: "user", id: "alice" },
      { kind: "user", id: "bob" },
    ]);
    expect(data.unresolved_mentions).toEqual(["ghost"]);
  });

  test("an unknown thread is UNKNOWN_THREAD", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "comment_reply", { thread_id: "nope", body: "hi" })).code).toBe("UNKNOWN_THREAD");
  });
});

describe("hooks that are not plugged in", () => {
  test("doc_inspect_visual and pack_link_refresh say so instead of pretending", async () => {
    const { session } = await setup();
    expect(toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "brief.docx" }))).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "no-renderer" } });
    expect(toolErrorOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }))).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "no-pack-refresher" } });
  });
});

describe("every tool announces itself to the room and then goes idle", () => {
  test("a call is a pair of agent.activity events around its work", async () => {
    const { workspace, session } = await setup();
    const events = await listen(workspace);
    await callTool(session, "doc_read", { doc: "brief.docx", view: "text" });
    await callTool(session, "doc_search", { query: "costs" });
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "x" }] });
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "y" }] });
    const activity = events.filter((e) => e.type === "agent.activity");
    expect(activity.map((e) => [e.activity, e.doc_name])).toEqual([
      ["reading", "brief.docx"],
      ["idle", "brief.docx"],
      ["searching", null],
      ["idle", null],
      ["proposing", "brief.docx"],
      ["idle", "brief.docx"],
      ["committing", "brief.docx"],
      ["idle", "brief.docx"],
    ]);
    expect(activity.every((e) => e.agent.id === "robot")).toBe(true);
    const seqs = events.map((e) => ("seq" in e ? e.seq : -1));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  test("a failed tool still goes idle", async () => {
    const { workspace, session } = await setup();
    const events = await listen(workspace);
    await callTool(session, "doc_read", { doc: "brief.docx", target: "para:@99" });
    expect(events.filter((e) => e.type === "agent.activity").map((e) => e.activity)).toEqual(["reading", "idle"]);
  });
});

describe("a blank document", () => {
  test("the blank packages of the three formats are what the readers open", () => {
    for (const format of ["docx", "xlsx", "pptx"] as const) expect(blankDocument(format).length).toBeGreaterThan(100);
  });

  test("wordDocument and the memory engine agree on what a page is", async () => {
    const workspace = await makeWorkspace({ seed: false });
    const head = must(await workspace.room.addDocument("room", alice, { name: "long.docx", format: "docx", bytes: wordDocument(["a", "b", "c", "d", "e"]) }));
    expect(head.revision).toBe(0);
    expect(must(await workspace.room.readHead("room", alice, "long.docx")).page_hashes).toHaveLength(3);
  });
});

describe("a room licensed for one seat", () => {
  test("an agent without a seat is refused doc_read and workspace_list, and takes none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wolfsdk-mcp-seat-"));
    // The memory engine licenses any number of seats; this one reports a single seat, which alice holds.
    const real = new MemoryEngine();
    const engine: DocumentEngine = { entitlement: async () => ({ ...MEMORY_ENTITLEMENT, max_seats: 1 }), replay: (i) => real.replay(i), close: () => real.close() };
    let n = 0;
    const room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine, now: steppingClock(), newId: () => `id-${++n}` });
    onDispose(async () => {
      await room.close();
      await rm(dir, { recursive: true, force: true });
    });
    must(await room.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await room.addDocument("room", alice, { name: "brief.docx", format: "docx", bytes: wordDocument(["Brief"]) }));
    const session = await openSession(new McpServer({ actor: robot, roomId: "room", service: room }));
    expect(toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx" })).code).toBe("LICENSE_LIMIT");
    expect(toolErrorOf(await callTool(session, "workspace_list")).code).toBe("LICENSE_LIMIT");
    expect(room.listSeats().map((seat) => `${seat.kind}:${seat.id}`)).toEqual(["user:alice"]);
  });
});
