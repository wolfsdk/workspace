// The read-only mode of a workspace as the agent meets it: the four tools that write answer LICENSE_LIMIT with the
// reason and the upgrade path, whether the tools were told or only the room was, and the four that read keep working.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ReadOnlyMode, RoomServer } from "@wolfsdk/server";
import { McpServer, type McpSession, type PackRefreshRequest, type PackRefresher } from "../src/index.ts";
import { BRIEF_LINES, alice, callTool, dataOf, disposeAll, makeWorkspace, must, onDispose, openSession, request, resultOf, robot, steppingClock, toolErrorOf, type Workspace } from "./fixtures/workspace.ts";
import { MemoryEngine, wordDocument } from "./fixtures/memory-engine.ts";

setDefaultTimeout(120_000);
afterEach(disposeAll);

const MODE: ReadOnlyMode = { reason: "The trial ended on 2026-11-28.", upgrade: "https://cloud.example.test/upgrade" };
const REFUSAL = { code: "LICENSE_LIMIT", message: `workspace-read-only: ${MODE.reason} ${MODE.upgrade}` };
const WRITES = ["doc_create", "doc_edit", "comment_reply", "pack_link_refresh"];

function refresher(calls: PackRefreshRequest[]): PackRefresher {
  return {
    async refreshPack(req) {
      calls.push(req);
      return { pack: req.pack, mode: req.mode, bindings: [] };
    },
  };
}

/** One call of each write tool. The last three of each refer to a document, a thread or a pack that does not exist:
 * the refusal comes before the tool looks at what it was asked to touch. */
const writeCalls = (threadId: string): [string, Record<string, unknown>][] => [
  ["doc_create", { name: "plan.docx", format: "docx" }],
  ["doc_create", { name: "plan.docx", format: "docx", template: "ghost.docx" }],
  ["doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] }],
  ["doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "No." }] }],
  ["doc_edit", { doc: "ghost.docx", base_revision: 9, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] }],
  ["comment_reply", { thread_id: threadId, body: "No.", resolve: true }],
  ["comment_reply", { thread_id: "ghost", body: "No." }],
  ["pack_link_refresh", { pack: "kpis" }],
  ["pack_link_refresh", { pack: "ghost", mode: "commit" }],
];

async function thread(workspace: Workspace): Promise<string> {
  return must(await workspace.room.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] })).thread_id;
}

/** The parts of a room a write would change. */
async function stateOf(workspace: Workspace): Promise<unknown> {
  const room = must(await workspace.room.getRoom("room", alice));
  return { seq: room.seq, documents: room.documents.map((d) => [d.head.name, d.head.revision, d.head.sha256]), proposals: room.proposals.length, comments: room.comments.map((c) => c.messages.length) };
}

describe("a read-only MCP server", () => {
  test("refuses each write tool with LICENSE_LIMIT and the reason and the upgrade path, and writes nothing", async () => {
    const calls: PackRefreshRequest[] = [];
    const workspace = await makeWorkspace({ readOnly: MODE, packs: refresher(calls) });
    const threadId = await thread(workspace);
    const session = await openSession(workspace.mcp);
    const before = await stateOf(workspace);
    for (const [name, args] of writeCalls(threadId)) {
      expect(toolErrorOf(await callTool(session, name, args))).toEqual(REFUSAL);
    }
    expect(await stateOf(workspace)).toEqual(before);
    expect(calls).toEqual([]);
  });

  test("keeps the read tools working", async () => {
    const workspace = await makeWorkspace({ readOnly: MODE });
    const session = await openSession(workspace.mcp);
    const list = dataOf(await callTool(session, "workspace_list"));
    expect((list.documents as { name: string }[]).map((d) => d.name)).toEqual(["brief.docx", "model.xlsx"]);
    const read = dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }));
    expect(JSON.stringify(read)).toContain(BRIEF_LINES[1]);
    const hits = dataOf(await callTool(session, "doc_search", { query: "revenue" })).hits as unknown[];
    expect(hits.length).toBeGreaterThan(0);
  });

  test("still lists all eight tools: the mode is a refusal, not a smaller server", async () => {
    const workspace = await makeWorkspace({ readOnly: MODE });
    const session = await openSession(workspace.mcp);
    const listed = resultOf(await session.handle(request("tools/list"))) as { tools: { name: string }[] };
    expect(listed.tools.map((t) => t.name)).toEqual(expect.arrayContaining(WRITES));
    expect(listed.tools).toHaveLength(8);
  });
});

describe("a server that was not told", () => {
  test("serves the write tools", async () => {
    const calls: PackRefreshRequest[] = [];
    const workspace = await makeWorkspace({ packs: refresher(calls) });
    const threadId = await thread(workspace);
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "doc_create", { name: "plan.docx", format: "docx" }))).toMatchObject({ doc: "plan.docx" });
    expect(dataOf(await callTool(session, "comment_reply", { thread_id: threadId, body: "Checked." })).thread).toMatchObject({ thread_id: threadId });
    expect(dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }))).toMatchObject({ pack: "kpis" });
    expect(calls).toHaveLength(1);
  });
});

describe("a room that is read-only", () => {
  /** The files of a workspace that was writable, opened again read-only, and an MCP server over it that is told or not. */
  async function reopened(told: boolean): Promise<{ session: McpSession; threadId: string }> {
    const dir = await mkdtemp(join(tmpdir(), "wolfsdk-mcp-read-only-"));
    const open = (readOnly?: ReadOnlyMode): RoomServer =>
      new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new MemoryEngine(), now: steppingClock(), readOnly });
    const writable = open();
    must(await writable.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    must(await writable.addDocument("room", alice, { name: "brief.docx", format: "docx", bytes: wordDocument(BRIEF_LINES) }));
    const threadId = must(await writable.postComment("room", alice, { thread_id: null, doc_name: "brief.docx", target_address: "para:@2", body: "Source?", mentions: [] })).thread_id;
    await writable.close();
    const room = open(MODE);
    onDispose(async () => {
      await room.close();
      await rm(dir, { recursive: true, force: true });
    });
    const mcp = new McpServer({ service: room, roomId: "room", actor: robot, ...(told ? { readOnly: MODE } : {}) });
    return { session: await openSession(mcp), threadId };
  }

  for (const told of [true, false]) {
    // A tool that was not told resolves its target before the room is asked, so a target that does not exist is
    // still reported as missing: only the calls on what exists are the same refusal.
    test(`answers a write tool the same refusal whether the tools were told (${told}) or only the room`, async () => {
      const { session, threadId } = await reopened(told);
      for (const [name, args] of writeCalls(threadId).filter(([n, a]) => n !== "pack_link_refresh" && (told || !JSON.stringify(a).includes("ghost")))) {
        expect(toolErrorOf(await callTool(session, name, args))).toEqual(REFUSAL);
      }
    });

    test(`reads, though the room refuses the activity a read announces (told: ${told})`, async () => {
      const { session } = await reopened(told);
      const read = await callTool(session, "doc_read", { doc: "brief.docx", view: "text" });
      expect(read.isError).toBeUndefined();
      expect(JSON.stringify(dataOf(read))).toContain(BRIEF_LINES[0]);
      expect(dataOf(await callTool(session, "workspace_list")).room_id).toBe("room");
    });
  }
});
