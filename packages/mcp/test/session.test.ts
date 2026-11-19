// A session without a transport: the handshake, the errors of JSON-RPC, and the stream of room events.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MCP_WORKSPACE_TOOL_NAMES, MCP_WORKSPACE_TOOLS, MCP_WORKSPACE_TOOLS_MAX_BYTES, MCP_WORKSPACE_TOOLS_MAX_TOKENS, mcpToolsBytes, mcpToolsTokenEstimate } from "@wolfsdk/protocol/workspace";
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, MCP_PROTOCOL_VERSIONS, McpServer, type JsonRpcNotification } from "../src/index.ts";
import {
  alice,
  callTool,
  disposeAll,
  helper,
  initializeRequest,
  listen,
  makeWorkspace,
  must,
  notify,
  openSession,
  request,
  resultOf,
  robot,
  rpcErrorOf,
} from "./fixtures/workspace.ts";

setDefaultTimeout(120_000);
afterEach(disposeAll);

describe("handshake", () => {
  test("initialize negotiates the revision and describes the server", async () => {
    const { mcp } = await makeWorkspace();
    const session = mcp.createSession("s");
    const result = resultOf(await session.handle(initializeRequest("2025-03-26"))) as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.serverInfo).toEqual({ name: "wolf-workspace", version: "0.0.0" });
    expect(result.capabilities).toEqual({ tools: { listChanged: false }, logging: {} });
    expect(typeof result.instructions).toBe("string");
    expect(session.protocolVersion).toBe("2025-03-26");
    expect(session.clientName).toBe("test-client");
  });

  test("a revision the server does not know is answered with the newest one it does", async () => {
    const { mcp } = await makeWorkspace();
    const session = mcp.createSession("s");
    const result = resultOf(await session.handle(initializeRequest("2031-01-01"))) as { protocolVersion: string };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  test("the name, version and instructions are the embedder's to set", async () => {
    const { room } = await makeWorkspace();
    const mcp = new McpServer({ actor: robot, roomId: "room", service: room, name: "acme", version: "9.9.9", instructions: "Be brief." });
    const result = resultOf(await mcp.createSession("s").handle(initializeRequest())) as Record<string, unknown>;
    expect(result).toMatchObject({ serverInfo: { name: "acme", version: "9.9.9" }, instructions: "Be brief." });
  });

  test("nothing but ping works before initialize, and initialize works once", async () => {
    const { mcp } = await makeWorkspace();
    const session = mcp.createSession("s");
    expect(resultOf(await session.handle(request("ping")))).toEqual({});
    expect(rpcErrorOf(await session.handle(request("tools/list"))).code).toBe(INVALID_REQUEST);
    expect(rpcErrorOf(await session.handle(request("tools/call", { name: "workspace_list", arguments: {} }))).code).toBe(INVALID_REQUEST);
    resultOf(await session.handle(initializeRequest()));
    expect(rpcErrorOf(await session.handle(initializeRequest())).code).toBe(INVALID_REQUEST);
    expect(rpcErrorOf(await mcp.createSession("t").handle(request("initialize", {}))).code).toBe(INVALID_PARAMS);
  });

  test("the actor of a server or session is an agent", async () => {
    const { room, mcp } = await makeWorkspace();
    expect(() => new McpServer({ actor: alice, roomId: "room", service: room })).toThrow(RangeError);
    expect(() => mcp.createSession("s", alice)).toThrow(RangeError);
  });
});

describe("tools/list", () => {
  test("lists exactly the eight tools of the contract, within the token budget", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { tools } = resultOf(await session.handle(request("tools/list"))) as { tools: typeof MCP_WORKSPACE_TOOLS };
    expect(tools.map((t) => t.name)).toEqual([...MCP_WORKSPACE_TOOL_NAMES]);
    expect(tools).toHaveLength(8);
    expect(tools).toEqual([...MCP_WORKSPACE_TOOLS]);
    expect(mcpToolsBytes(tools)).toBeLessThanOrEqual(MCP_WORKSPACE_TOOLS_MAX_BYTES);
    expect(mcpToolsTokenEstimate(tools)).toBeLessThanOrEqual(MCP_WORKSPACE_TOOLS_MAX_TOKENS);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("JSON-RPC errors", () => {
  test("arguments that fail the schema are -32602 with the problems named", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const missing = rpcErrorOf(await session.handle(request("tools/call", { name: "doc_edit", arguments: { doc: "brief.docx" } })));
    expect(missing.code).toBe(INVALID_PARAMS);
    expect((missing.data as { problems: string[] }).problems.length).toBeGreaterThan(0);
    const badMode = rpcErrorOf(
      await session.handle(request("tools/call", { name: "doc_edit", arguments: { doc: "a.docx", base_revision: 0, mode: "yolo", ops: [{ op: "x" }] } })),
    );
    expect(badMode.code).toBe(INVALID_PARAMS);
    const emptyOps = rpcErrorOf(
      await session.handle(request("tools/call", { name: "doc_edit", arguments: { doc: "a.docx", base_revision: 0, mode: "commit", ops: [] } })),
    );
    expect(emptyOps.code).toBe(INVALID_PARAMS);
    const badRegex = rpcErrorOf(await session.handle(request("tools/call", { name: "doc_search", arguments: { query: "(", regex: true } })));
    expect(badRegex.code).toBe(INVALID_PARAMS);
  });

  test("an unknown tool is -32602 and an unknown method is -32601", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    expect(rpcErrorOf(await session.handle(request("tools/call", { name: "doc_delete", arguments: {} }))).code).toBe(INVALID_PARAMS);
    expect(rpcErrorOf(await session.handle(request("resources/list"))).code).toBe(METHOD_NOT_FOUND);
  });

  test("a malformed message is -32600 with the id it carried", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    expect(await session.handle({ jsonrpc: "1.0", id: 7, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: INVALID_REQUEST, message: 'jsonrpc must be "2.0"' },
    });
    expect(rpcErrorOf(await session.handle("ping")).code).toBe(INVALID_REQUEST);
    expect(rpcErrorOf(await session.handle({ jsonrpc: "2.0", id: 1, method: "ping", params: [] })).code).toBe(INVALID_REQUEST);
  });

  test("a notification and a response get no answer", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    expect(await session.handle(notify("notifications/cancelled", { requestId: 1 }))).toBeUndefined();
    expect(await session.handle({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined();
  });

  test("a batch is answered in one array, without an entry for a notification", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const ping = request("ping");
    const list = request("tools/call", { name: "workspace_list", arguments: {} });
    const answer = await session.handleBody([ping, notify("notifications/initialized"), list, request("nope")]);
    expect(Array.isArray(answer)).toBe(true);
    const responses = answer as { id: number }[];
    expect(responses.map((r) => r.id)).toEqual([ping.id, list.id, list.id + 1]);
    expect(rpcErrorOf(await session.handleBody([]))).toMatchObject({ code: INVALID_REQUEST });
    expect(await session.handleBody([notify("notifications/initialized")])).toBeUndefined();
  });
});

describe("the stream of room events", () => {
  type Sent = { message: JsonRpcNotification; seq: number | undefined };

  async function stream(session: Awaited<ReturnType<typeof openSession>>, since: number | null = null): Promise<{ sent: Sent[]; detach: () => void }> {
    const sent: Sent[] = [];
    const attached = await session.attach((message, seq) => sent.push({ message, seq }), since);
    if (!attached.ok) throw new Error(`attach failed: ${attached.reason}`);
    return { sent, detach: attached.detach };
  }

  const eventsOf = (sent: readonly Sent[]) => sent.map((s) => (s.message.params as { data: { type: string; activity?: string } }).data);

  test("sends each event as notifications/message with its level, logger and room seq", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { sent } = await stream(session);
    await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] });
    expect(sent.every((s) => s.message.method === "notifications/message")).toBe(true);
    expect(sent.every((s) => (s.message.params as { logger: string }).logger === "wolf.workspace.room")).toBe(true);
    const types = eventsOf(sent).map((e) => e.type);
    expect(types).toContain("agent.activity");
    expect(types).toContain("doc.committed");
    const seqs = sent.map((s) => s.seq);
    expect(seqs.every((n) => typeof n === "number")).toBe(true);
    expect([...seqs].sort((a, b) => (a as number) - (b as number))).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    const levels = new Map(sent.map((s) => [(s.message.params as { data: { type: string } }).data.type, (s.message.params as { level: string }).level]));
    expect(levels.get("agent.activity")).toBe("info");
    expect(levels.get("doc.committed")).toBe("notice");
  });

  test("starts at now: nothing that happened before is replayed", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { sent } = await stream(session);
    expect(sent).toEqual([]);
  });

  test("a client that saw up to a seq gets what came after it, then the live events", async () => {
    const { room, mcp } = await makeWorkspace();
    const first = await openSession(mcp, "first");
    const seen = await stream(first);
    await callTool(first, "doc_read", { doc: "brief.docx" });
    const mark = seen.sent.at(-1)?.seq as number;
    seen.detach();
    await callTool(first, "doc_search", { query: "costs" });
    const second = await openSession(mcp, "second");
    const resumed = await stream(second, mark);
    expect(eventsOf(resumed.sent).map((e) => e.activity)).toEqual(["searching", "idle"]);
    await callTool(second, "doc_read", { doc: "brief.docx" });
    expect(eventsOf(resumed.sent).map((e) => e.activity)).toEqual(["searching", "idle", "reading", "idle"]);
    expect(must(await room.getRoom("room", alice)).seq).toBe(resumed.sent.at(-1)?.seq as number);
  });

  test("the level filter keeps the quiet events out until the client asks for them", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { sent } = await stream(session);
    const edit = { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] };
    await callTool(session, "doc_edit", edit);
    expect(eventsOf(sent).map((e) => e.type)).not.toContain("pages.invalidated");
    resultOf(await session.handle(request("logging/setLevel", { level: "debug" })));
    await callTool(session, "doc_edit", { ...edit, base_revision: 1 });
    expect(eventsOf(sent).map((e) => e.type)).toContain("pages.invalidated");
    resultOf(await session.handle(request("logging/setLevel", { level: "error" })));
    const before = sent.length;
    await callTool(session, "doc_read", { doc: "brief.docx" });
    expect(sent.length).toBe(before);
    expect(rpcErrorOf(await session.handle(request("logging/setLevel", { level: "loud" }))).code).toBe(INVALID_PARAMS);
  });

  test("one stream per session; a closed session or a detached one frees the slot", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { detach } = await stream(session);
    expect(session.streaming).toBe(true);
    expect(await session.attach(() => undefined, null)).toEqual({ ok: false, reason: "busy" });
    detach();
    expect(session.streaming).toBe(false);
    const again = await stream(session);
    expect(session.streaming).toBe(true);
    session.close();
    expect(session.streaming).toBe(false);
    expect(session.closed).toBe(true);
    expect(await session.attach(() => undefined, null)).toEqual({ ok: false, reason: "closed" });
    again.detach();
  });

  test("a detached stream hears nothing more", async () => {
    const { mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    const { sent, detach } = await stream(session);
    detach();
    await callTool(session, "doc_read", { doc: "brief.docx" });
    expect(sent).toEqual([]);
  });

  test("an error event from the room is the last the sink hears, and the session can attach again", async () => {
    const { room, mcp } = await makeWorkspace();
    const session = await openSession(mcp);
    // Even a client that asked to hear only the worst is told its subscription ended.
    resultOf(await session.handle(request("logging/setLevel", { level: "emergency" })));
    const first = await stream(session);
    expect(session.streaming).toBe(true);
    expect(room.releaseSeat("agent", "robot")).toBe(true);
    expect(eventsOf(first.sent).map((e) => e.type)).toEqual(["error"]);
    expect(first.sent[0]?.message.params).toMatchObject({ level: "error", data: { type: "error" } });
    expect(session.streaming).toBe(false);
    const second = await stream(session);
    expect(session.streaming).toBe(true);
    second.detach();
  });

  test("two agents are two actors in the room, each with its own activity", async () => {
    const workspace = await makeWorkspace();
    const events = await listen(workspace);
    const one = await openSession(workspace.mcp, "one");
    const two = await openSession(workspace.mcp, "two", helper);
    await callTool(one, "doc_read", { doc: "brief.docx" });
    await callTool(two, "doc_read", { doc: "brief.docx" });
    const agents = events.flatMap((e) => (e.type === "agent.activity" ? [e.agent.id] : []));
    expect(agents).toEqual(["robot", "robot", "helper", "helper"]);
  });
});
