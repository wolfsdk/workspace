// One whole working session, as an agent client and a person would live it: the agent connects over Streamable
// HTTP, looks around, reads, proposes a change and answers a comment; the person sees the agent working, approves
// the proposal and resolves the thread. Everything goes through the real room server.
import { afterEach, describe, expect, test } from "bun:test";
import { createMcpHttpHandler } from "../src/index.ts";
import { SseReader, roomEvents } from "./fixtures/sse.ts";
import { alice, bob, disposeAll, initializeRequest, listen, makeWorkspace, must, notify, onDispose, request } from "./fixtures/workspace.ts";

afterEach(disposeAll);

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("a person and an agent in one room", () => {
  test("the agent proposes, the person approves, the agent reads the result and settles the thread", async () => {
    const workspace = await makeWorkspace();
    const handler = createMcpHttpHandler({ server: workspace.mcp, keepAliveMs: 0 });
    onDispose(() => handler.close());
    const person = await listen(workspace, alice);

    // The agent connects and opens its event stream, as a client of the protocol does.
    const send = (body: unknown, session?: string): Promise<Response> =>
      handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: session ? { ...HEADERS, "mcp-session-id": session } : HEADERS, body: JSON.stringify(body) }));
    const opened = await send(initializeRequest());
    const session = opened.headers.get("mcp-session-id") as string;
    await send(notify("notifications/initialized"), session);
    const stream = new SseReader(await handler.fetch(new Request("http://localhost/mcp", { headers: { accept: "text/event-stream", "mcp-session-id": session } })));
    expect((await stream.next())?.comment).toBe("ok");

    const call = async (name: string, args: Record<string, unknown>): Promise<{ data: Record<string, unknown>; isError: boolean }> => {
      const response = await send(request("tools/call", { name, arguments: args }), session);
      const body = (await response.json()) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } };
      return { data: body.result.structuredContent, isError: body.result.isError === true };
    };

    // 1. Look around, read, search.
    const listing = await call("workspace_list", {});
    expect((listing.data.documents as { name: string }[]).map((d) => d.name)).toEqual(["brief.docx", "model.xlsx"]);
    const read = await call("doc_read", { doc: "brief.docx", view: "text" });
    expect(read.data).toMatchObject({ revision: 0 });
    const found = await call("doc_search", { query: "costs" });
    const hit = (found.data.hits as { doc: string; address: string }[])[0];
    expect(hit).toMatchObject({ doc: "brief.docx", address: "para:@3" });

    // 2. The person asks for something in a comment; the agent proposes the change.
    const thread = must(
      await workspace.room.postComment("room", alice, {
        thread_id: null,
        doc_name: "brief.docx",
        target_address: hit?.address ?? "",
        body: "@robot please state the cost trend precisely",
        mentions: [{ kind: "agent", id: "robot" }],
      }),
    );
    const proposal = await call("doc_edit", {
      doc: "brief.docx",
      base_revision: 0,
      mode: "propose",
      ops: [{ op: "replace_text", find: "flat", text: "flat quarter on quarter" }],
      message: "state the cost trend",
    });
    expect(proposal.isError).toBe(false);
    expect(proposal.data).toMatchObject({ mode: "propose", status: "open" });

    // 3. The person's room shows the agent working and the open proposal; nothing has been committed.
    const activities = person.flatMap((e) => (e.type === "agent.activity" ? [`${e.agent.id}:${e.activity}`] : []));
    expect(activities).toEqual(["robot:reading", "robot:idle", "robot:searching", "robot:idle", "robot:proposing", "robot:idle"]);
    const open = must(await workspace.room.getRoom("room", alice)).proposals.filter((p) => p.status === "open");
    expect(open.map((p) => p.proposal_id)).toEqual([proposal.data.proposal_id as string]);
    expect((await call("doc_read", { doc: "brief.docx", view: "text", target: "para:@3" })).data.text).toBe("Costs are flat.");

    // 4. The person approves; the agent's stream carries the commit and the agent reads the new text.
    const decided = must(await workspace.room.decideProposal("room", alice, { proposal_id: proposal.data.proposal_id as string, decision: "approve" }));
    expect(decided.head.revision).toBe(1);
    expect(decided.entries[0]).toMatchObject({ author: { id: "robot", kind: "agent" }, proposal_id: proposal.data.proposal_id });
    const reread = await call("doc_read", { doc: "brief.docx", view: "text", target: "para:@3" });
    expect(reread.data).toMatchObject({ revision: 1, text: "Costs are flat quarter on quarter." });

    // 5. The agent answers the comment and resolves it, mentioning the person.
    const reply = await call("comment_reply", { thread_id: thread.thread_id, body: "@alice done, see revision 1", resolve: true });
    expect(reply.data.thread).toMatchObject({ resolved: true, mentions: [{ kind: "agent", id: "robot" }, { kind: "user", id: "alice" }] });
    const updated = person.filter((e) => e.type === "comment.updated").at(-1);
    expect(updated).toMatchObject({ thread: { thread_id: thread.thread_id, resolved: true } });

    // 6. Another person's change lands first: the agent's stale commit is refused with the head to rebase on.
    must(
      await workspace.room.edit("room", bob, { doc_name: "brief.docx", base_revision: 1, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Bob was here" }] } }),
    );
    const stale = await call("doc_edit", { doc: "brief.docx", base_revision: 1, mode: "commit", ops: [{ op: "append_paragraph", text: "Agent too" }] });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({ code: "REVISION_MISMATCH", detail: { head: { revision: 2 } } });
    const rebased = await call("doc_edit", { doc: "brief.docx", base_revision: 2, mode: "commit", ops: [{ op: "append_paragraph", text: "Agent too" }] });
    expect(rebased.data).toMatchObject({ mode: "commit", revision: 3 });

    // 7. The agent's own stream saw the whole story, in order, with the room seq as the event id.
    const last = must(await workspace.room.getRoom("room", alice)).seq;
    const seen = roomEvents(await stream.until((frame) => frame.id === String(last)));
    const ids = seen.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = seen.map((e) => e.event.type);
    expect(kinds).toContain("proposal.updated");
    expect(kinds.filter((k) => k === "doc.committed")).toHaveLength(3);
    expect(kinds).toContain("comment.updated");
    expect(kinds.filter((k) => k === "agent.activity").length).toBeGreaterThan(8);
    await stream.cancel();
  });
});
