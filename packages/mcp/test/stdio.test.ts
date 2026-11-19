// MCP over stdio, on a pair of in-memory streams: one JSON-RPC message per line, in and out.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { INVALID_PARAMS, PARSE_ERROR, runMcpStdioServer } from "../src/index.ts";
import { disposeAll, helper, initializeRequest, makeWorkspace, notify, request, type Workspace } from "./fixtures/workspace.ts";

setDefaultTimeout(120_000);
afterEach(disposeAll);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Line = Record<string, unknown>;

/** A client on the far side of a stdio server. */
async function connect(workspace: Workspace, options: { actor?: typeof helper; maxLineBytes?: number } = {}) {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: 1000 }, { highWaterMark: 1000 });
  const done = runMcpStdioServer({ server: workspace.mcp, input: input.readable, output: output.writable, ...options });
  const writer = input.writable.getWriter();
  const reader = output.readable.getReader();
  let buffer = "";

  const sendRaw = (text: string): Promise<void> => writer.write(encoder.encode(text));
  const send = (message: unknown): Promise<void> => sendRaw(`${JSON.stringify(message)}\n`);
  const line = async (): Promise<Line> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return JSON.parse(text) as Line;
      }
      const { done: finished, value } = await reader.read();
      if (finished) throw new Error("the server closed its output");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const end = async (): Promise<void> => {
    await writer.close();
    await done;
  };
  return { send, sendRaw, line, end, done };
}

async function handshake(client: Awaited<ReturnType<typeof connect>>): Promise<void> {
  await client.send(initializeRequest());
  expect((await client.line()).result).toBeDefined();
  await client.send(notify("notifications/initialized"));
}

describe("stdio", () => {
  test("answers a request with one line", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    const init = initializeRequest();
    await client.send(init);
    const answer = await client.line();
    expect(answer).toMatchObject({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "wolf-workspace" } } });
    const list = request("tools/list");
    await client.send(list);
    expect(((await client.line()).result as { tools: unknown[] }).tools).toHaveLength(8);
    await client.end();
  });

  test("a line that is not JSON is -32700 and the next line is served", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await client.sendRaw("{nope\n");
    expect(await client.line()).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
    const ping = request("ping");
    await client.send(ping);
    expect(await client.line()).toMatchObject({ id: ping.id, result: {} });
    await client.end();
  });

  test("blank lines are ignored, and a message split across writes is one message", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    const ping = request("ping");
    const text = JSON.stringify(ping);
    await client.sendRaw("\n\n");
    await client.sendRaw(text.slice(0, 10));
    await client.sendRaw(`${text.slice(10)}\n`);
    expect(await client.line()).toMatchObject({ id: ping.id, result: {} });
    await client.end();
  });

  test("a call before initialize is refused, and invalid arguments are -32602", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await client.send(request("tools/list"));
    expect(await client.line()).toMatchObject({ error: { code: -32600 } });
    await handshake(client);
    await client.send(request("tools/call", { name: "doc_read", arguments: {} }));
    expect(await client.line()).toMatchObject({ error: { code: INVALID_PARAMS } });
    await client.end();
  });

  test("a batch line is answered with one array line", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await handshake(client);
    await client.send([request("ping"), request("ping")]);
    const answer = (await client.line()) as unknown as unknown[];
    expect(Array.isArray(answer)).toBe(true);
    expect(answer).toHaveLength(2);
    await client.end();
  });

  test("after notifications/initialized the room events follow as notifications", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await handshake(client);
    const call = request("tools/call", { name: "doc_edit", arguments: { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] } });
    await client.send(call);
    const lines: Line[] = [];
    while (!lines.some((l) => l.id === call.id)) lines.push(await client.line());
    const events = lines.filter((l) => l.method === "notifications/message").map((l) => (l.params as { data: { type: string; seq: number } }).data);
    expect(events.map((e) => e.type)).toEqual(["doc.committed", "agent.activity", "agent.activity"]);
    expect(lines.find((l) => l.id === call.id)).toMatchObject({ result: { structuredContent: { mode: "commit", revision: 1 } } });
    await client.end();
  });

  test("an agent whose seat is released is told so, and its events follow again after its next line", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await handshake(client);
    const ping = request("ping");
    await client.send(ping);
    expect((await client.line()).id).toBe(ping.id);
    expect(workspace.room.releaseSeat("agent", "robot")).toBe(true);
    expect(await client.line()).toMatchObject({ method: "notifications/message", params: { level: "error", data: { type: "error", code: "LICENSE_LIMIT", request_id: null } } });
    const again = request("ping");
    await client.send(again);
    expect((await client.line()).id).toBe(again.id);
    const call = request("tools/call", { name: "doc_edit", arguments: { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] } });
    await client.send(call);
    const lines: Line[] = [];
    while (!lines.some((l) => l.id === call.id)) lines.push(await client.line());
    const events = lines.filter((l) => l.method === "notifications/message").map((l) => (l.params as { data: { type: string } }).data.type);
    expect(events).toEqual(["doc.committed", "agent.activity", "agent.activity"]);
    await client.end();
  });

  test("no events flow before the client says it is initialized", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await client.send(initializeRequest());
    await client.line();
    const call = request("tools/call", { name: "doc_read", arguments: { doc: "brief.docx" } });
    await client.send(call);
    const answer = await client.line();
    expect(answer.id).toBe(call.id);
    await client.end();
  });

  test("calls in flight are answered before the server finishes", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace);
    await handshake(client);
    const one = request("tools/call", { name: "doc_search", arguments: { query: "costs" } });
    const two = request("tools/call", { name: "doc_read", arguments: { doc: "brief.docx", view: "text" } });
    await client.send(one);
    await client.send(two);
    const ids = new Set<unknown>();
    while (ids.size < 2) {
      const line = await client.line();
      if (line.id !== undefined) ids.add(line.id);
    }
    expect(ids).toEqual(new Set([one.id, two.id]));
    await client.end();
  });

  test("a connection can act as another agent", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace, { actor: helper });
    await handshake(client);
    const call = request("tools/call", { name: "doc_read", arguments: { doc: "brief.docx" } });
    await client.send(call);
    const lines: Line[] = [];
    while (!lines.some((l) => l.id === call.id)) lines.push(await client.line());
    const agents = lines.filter((l) => l.method === "notifications/message").map((l) => (l.params as { data: { agent: { id: string } } }).data.agent.id);
    expect(agents).toEqual(["helper", "helper"]);
    await client.end();
  });

  test("a line over the limit is -32700 and the rest of it is dropped", async () => {
    const workspace = await makeWorkspace();
    const client = await connect(workspace, { maxLineBytes: 64 });
    await client.sendRaw("x".repeat(100));
    expect(await client.line()).toMatchObject({ id: null, error: { code: PARSE_ERROR } });
    await client.sendRaw("y".repeat(10) + "\n");
    const ping = request("ping");
    await client.send(ping);
    expect(await client.line()).toMatchObject({ id: ping.id, result: {} });
    await client.end();
  });
});
