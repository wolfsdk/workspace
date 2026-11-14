// Streamable HTTP: the handler is driven as a plain `(Request) => Response` and, once, over a real socket.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { INVALID_REQUEST, PARSE_ERROR, createMcpHttpHandler, prefersEventStream, startMcpHttpServer, type McpHttpOptions } from "../src/index.ts";
import { SseReader, roomEvents } from "./fixtures/sse.ts";
import { alice, disposeAll, helper, initializeRequest, listen, makeWorkspace, notify, onDispose, request, type Workspace } from "./fixtures/workspace.ts";

afterEach(async () => {
  setSystemTime();
  await disposeAll();
});

const URL_OF = "http://localhost/mcp";
const JSON_ACCEPT = "application/json, text/event-stream";

async function serve(options: Partial<McpHttpOptions> = {}): Promise<{ workspace: Workspace; fetch: (init: RequestInit & { headers?: Record<string, string> }) => Promise<Response>; handler: ReturnType<typeof createMcpHttpHandler> }> {
  const workspace = await makeWorkspace();
  const handler = createMcpHttpHandler({ server: workspace.mcp, keepAliveMs: 0, ...options });
  onDispose(() => handler.close());
  return { workspace, handler, fetch: (init) => handler.fetch(new Request(URL_OF, init)) };
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit & { headers: Record<string, string> } => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: JSON_ACCEPT, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Open a session over `fetch`; returns the id to put in later requests. */
async function open(fetch: Awaited<ReturnType<typeof serve>>["fetch"]): Promise<string> {
  const response = await fetch(post(initializeRequest()));
  expect(response.status).toBe(200);
  const id = response.headers.get("mcp-session-id");
  if (id === null) throw new Error("no session id");
  const accepted = await fetch(post(notify("notifications/initialized"), { "mcp-session-id": id }));
  expect(accepted.status).toBe(202);
  return id;
}

describe("accept negotiation", () => {
  test("a POST is answered as JSON unless the client prefers an event stream", () => {
    expect(prefersEventStream(null)).toBe(false);
    expect(prefersEventStream("application/json")).toBe(false);
    expect(prefersEventStream("application/json, text/event-stream")).toBe(false);
    expect(prefersEventStream("text/event-stream, application/json")).toBe(true);
    expect(prefersEventStream("text/event-stream")).toBe(true);
    expect(prefersEventStream("application/json;q=0.5, text/event-stream")).toBe(true);
    expect(prefersEventStream("text/event-stream;q=0, */*")).toBe(false);
    expect(prefersEventStream("*/*")).toBe(false);
  });
});

describe("POST", () => {
  test("initialize opens a session and returns its id", async () => {
    const { fetch, handler } = await serve();
    const response = await fetch(post(initializeRequest()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("wolf-workspace");
    expect(handler.sessionCount).toBe(1);
  });

  test("a failed initialize opens no session", async () => {
    const { fetch, handler } = await serve();
    const response = await fetch(post(request("initialize", {})));
    expect(response.status).toBe(400);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(handler.sessionCount).toBe(0);
    expect((await fetch(post([initializeRequest()]))).status).toBe(400);
    expect((await fetch(post(notify("initialize")))).status).toBe(400);
  });

  test("a request carries the session id and gets its answer as JSON", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const response = await fetch(post(request("tools/call", { name: "workspace_list", arguments: {} }), { "mcp-session-id": id }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { structuredContent: { room_id: string } } };
    expect(body.result.structuredContent.room_id).toBe("room");
  });

  test("a client that prefers an event stream gets the answer as one event", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const response = await fetch(post(request("tools/list"), { "mcp-session-id": id, accept: "text/event-stream" }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = new SseReader(response);
    const frame = await reader.next();
    expect(frame?.event).toBe("message");
    expect((frame?.data as { result: { tools: unknown[] } }).result.tools).toHaveLength(8);
    expect(await reader.next()).toBeNull();
  });

  test("a batch is answered with an array; notifications alone are 202", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const headers = { "mcp-session-id": id };
    const batch = await fetch(post([request("ping"), request("ping")], headers));
    expect(((await batch.json()) as unknown[]).length).toBe(2);
    expect((await fetch(post([notify("notifications/initialized")], headers))).status).toBe(202);
    expect((await fetch(post({ jsonrpc: "2.0", id: 1, result: {} }, headers))).status).toBe(202);
  });

  test("the session is required, and must be one this server holds", async () => {
    const { fetch } = await serve();
    expect((await fetch(post(request("ping")))).status).toBe(400);
    const stranger = await fetch(post(request("ping"), { "mcp-session-id": "nope" }));
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { error: { code: number } }).error.code).toBe(INVALID_REQUEST);
  });

  test("a body that is not JSON is -32700, and one that is too long is 413", async () => {
    const { fetch } = await serve({ maxBodyBytes: 200 });
    const broken = await fetch(post("{not json"));
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: { code: number } }).error.code).toBe(PARSE_ERROR);
    const long = await fetch(post({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(300) } }));
    expect(long.status).toBe(413);
  });

  test("an MCP-Protocol-Version this server does not speak is 400", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    expect((await fetch(post(request("ping"), { "mcp-session-id": id, "mcp-protocol-version": "1999-01-01" }))).status).toBe(400);
    expect((await fetch(post(request("ping"), { "mcp-session-id": id, "mcp-protocol-version": "2025-06-18" }))).status).toBe(200);
  });

  test("only POST, GET and DELETE, and only on the endpoint", async () => {
    const { fetch, handler } = await serve({ path: "/rpc" });
    expect((await fetch({ method: "POST" })).status).toBe(404);
    const other = await handler.fetch(new Request("http://localhost/rpc", { method: "PUT" }));
    expect(other.status).toBe(405);
    expect(other.headers.get("allow")).toBe("POST, GET, DELETE");
  });
});

describe("origin and authentication", () => {
  test("a page on another site may not drive the agent; loopback pages and non-browsers may", async () => {
    const { fetch } = await serve();
    const evil = await fetch(post(initializeRequest(), { origin: "https://evil.example" }));
    expect(evil.status).toBe(403);
    expect((await fetch(post(initializeRequest(), { origin: "http://localhost:5173" }))).status).toBe(200);
    expect((await fetch(post(initializeRequest(), { origin: "http://127.0.0.1:3000" }))).status).toBe(200);
    expect((await fetch(post(initializeRequest()))).status).toBe(200);
  });

  test("allowedOrigins names the origins, or * for any", async () => {
    const named = await serve({ allowedOrigins: ["https://app.example.com"] });
    expect((await named.fetch(post(initializeRequest(), { origin: "https://app.example.com" }))).status).toBe(200);
    expect((await named.fetch(post(initializeRequest(), { origin: "http://localhost:3000" }))).status).toBe(403);
    const any = await serve({ allowedOrigins: "*" });
    expect((await any.fetch(post(initializeRequest(), { origin: "https://evil.example" }))).status).toBe(200);
  });

  test("authenticate decides who calls: null is 401, a user is 403, an agent is the session's actor", async () => {
    const { fetch, workspace } = await serve({
      authenticate: (req) => {
        const token = req.headers.get("authorization");
        if (token === "Bearer helper") return helper;
        if (token === "Bearer alice") return alice;
        return null;
      },
    });
    const refused = await fetch(post(initializeRequest()));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe("Bearer");
    expect((await fetch(post(initializeRequest(), { authorization: "Bearer alice" }))).status).toBe(403);

    const opened = await fetch(post(initializeRequest(), { authorization: "Bearer helper" }));
    const id = opened.headers.get("mcp-session-id") as string;
    const headers = { authorization: "Bearer helper", "mcp-session-id": id };
    await fetch(post(notify("notifications/initialized"), headers));
    const seen = await listen(workspace);
    await fetch(post(request("tools/call", { name: "doc_read", arguments: { doc: "brief.docx" } }), headers));
    expect(seen.flatMap((e) => (e.type === "agent.activity" ? [e.agent.id] : []))).toEqual(["helper", "helper"]);
    // Another caller can not use that session.
    const other = await fetch(post(request("ping"), { authorization: "Bearer helper-2", "mcp-session-id": id }));
    expect(other.status).toBe(401);
  });

  test("a session belongs to the caller that opened it", async () => {
    const other = { kind: "agent" as const, id: "other", name: "Other" };
    const { fetch } = await serve({ authenticate: (req) => (req.headers.get("authorization") === "Bearer other" ? other : helper) });
    const opened = await fetch(post(initializeRequest()));
    const id = opened.headers.get("mcp-session-id") as string;
    expect((await fetch(post(request("ping"), { "mcp-session-id": id }))).status).toBe(200);
    expect((await fetch(post(request("ping"), { "mcp-session-id": id, authorization: "Bearer other" }))).status).toBe(403);
  });
});

describe("GET: the event stream", () => {
  test("needs Accept: text/event-stream and a session", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    expect((await fetch({ method: "GET", headers: { "mcp-session-id": id } })).status).toBe(406);
    expect((await fetch({ method: "GET", headers: { accept: "text/event-stream" } })).status).toBe(400);
    expect((await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": "nope" } })).status).toBe(404);
    expect((await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": id, "last-event-id": "abc" } })).status).toBe(400);
  });

  test("streams the room events as SSE frames whose id is the room seq", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const response = await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": id } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = new SseReader(response);
    expect((await reader.next())?.comment).toBe("ok");

    await fetch(post(request("tools/call", { name: "doc_edit", arguments: { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "x" }] } }), { "mcp-session-id": id }));
    const frames = await reader.until((f) => roomEvents([f])[0]?.event.activity === "idle");
    const events = roomEvents(frames);
    expect(events.map((e) => e.event.type)).toEqual(["agent.activity", "doc.committed", "agent.activity"]);
    expect(events.map((e) => e.event.activity)).toEqual(["committing", undefined, "idle"]);
    const ids = events.map((e) => Number(e.id));
    expect(ids.every(Number.isInteger)).toBe(true);
    expect(ids).toEqual(events.map((e) => e.event.seq as number));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(frames.every((f) => f.event === "message")).toBe(true);
    await reader.cancel();
  });

  test("Last-Event-ID resumes after the seq the client saw", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const headers = { accept: "text/event-stream", "mcp-session-id": id };
    const first = new SseReader(await fetch({ method: "GET", headers }));
    await first.next();
    await fetch(post(request("tools/call", { name: "doc_read", arguments: { doc: "brief.docx" } }), { "mcp-session-id": id }));
    const seen = roomEvents(await first.until((f) => roomEvents([f])[0]?.event.activity === "idle"));
    await first.cancel();
    const mark = Number(seen[0]?.id);

    // The reader is gone, so the stream has freed its slot; a new one asks for what it missed.
    const second = new SseReader(await fetch({ method: "GET", headers: { ...headers, "last-event-id": String(mark) } }));
    const replayed = roomEvents(await second.until((f) => roomEvents([f])[0]?.event.activity === "idle"));
    expect(replayed.map((e) => e.event.activity)).toEqual(["idle"]);
    expect(Number(replayed[0]?.id)).toBeGreaterThan(mark);
    await second.cancel();
  });

  test("one stream per session", async () => {
    const { fetch } = await serve();
    const id = await open(fetch);
    const headers = { accept: "text/event-stream", "mcp-session-id": id };
    const first = new SseReader(await fetch({ method: "GET", headers }));
    await first.next();
    expect((await fetch({ method: "GET", headers })).status).toBe(409);
    await first.cancel();
  });

  test("keep-alive comments keep an idle stream open", async () => {
    const { fetch } = await serve({ keepAliveMs: 20 });
    const id = await open(fetch);
    const reader = new SseReader(await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": id } }));
    const frames = await reader.until((f) => f.comment === "keepalive");
    expect(frames.map((f) => f.comment)).toEqual(["ok", "keepalive"]);
    await reader.cancel();
  });

  test("the room ending the stream closes the response, and the session can open another", async () => {
    const { fetch, workspace } = await serve();
    const id = await open(fetch);
    const headers = { accept: "text/event-stream", "mcp-session-id": id };
    const reader = new SseReader(await fetch({ method: "GET", headers }));
    expect((await reader.next())?.comment).toBe("ok");
    expect(workspace.room.releaseSeat("agent", "robot")).toBe(true);
    const last = await reader.next();
    expect(roomEvents(last === null ? [] : [last])[0]?.event).toMatchObject({ type: "error", code: "LICENSE_LIMIT", request_id: null });
    expect(await reader.next()).toBeNull();
    const second = await fetch({ method: "GET", headers });
    expect(second.status).toBe(200);
    await new SseReader(second).cancel();
  });
});

describe("DELETE and the life of a session", () => {
  test("DELETE ends the session and its stream", async () => {
    const { fetch, handler } = await serve();
    const id = await open(fetch);
    const reader = new SseReader(await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": id } }));
    await reader.next();
    expect((await fetch({ method: "DELETE", headers: { "mcp-session-id": id } })).status).toBe(204);
    expect(await reader.next()).toBeNull();
    expect(handler.sessionCount).toBe(0);
    expect((await fetch(post(request("ping"), { "mcp-session-id": id }))).status).toBe(404);
    expect((await fetch({ method: "DELETE", headers: { "mcp-session-id": id } })).status).toBe(404);
  });

  test("a session nobody uses is dropped after its time to live", async () => {
    const { fetch, handler } = await serve({ sessionTtlMs: 10 });
    const id = await open(fetch);
    setSystemTime(new Date(Date.now() + 60_000));
    expect((await fetch(post(request("ping"), { "mcp-session-id": id }))).status).toBe(404);
    expect(handler.sessionCount).toBe(0);
  });

  test("an open event stream keeps its session alive", async () => {
    const { fetch } = await serve({ sessionTtlMs: 10 });
    const id = await open(fetch);
    const reader = new SseReader(await fetch({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": id } }));
    await reader.next();
    setSystemTime(new Date(Date.now() + 60_000));
    expect((await fetch(post(request("ping"), { "mcp-session-id": id }))).status).toBe(200);
    await reader.cancel();
  });

  test("too many sessions is 503", async () => {
    const { fetch } = await serve({ maxSessions: 1 });
    await open(fetch);
    expect((await fetch(post(initializeRequest()))).status).toBe(503);
  });

  test("close() ends every session", async () => {
    const { fetch, handler } = await serve();
    const id = await open(fetch);
    handler.close();
    expect(handler.sessionCount).toBe(0);
    expect((await fetch(post(request("ping"), { "mcp-session-id": id }))).status).toBe(404);
  });
});

describe("over a socket", () => {
  test("Bun.serve carries a whole conversation, event stream included", async () => {
    const workspace = await makeWorkspace();
    const running = startMcpHttpServer({ server: workspace.mcp, keepAliveMs: 0 });
    onDispose(() => running.stop());
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const initialize = await fetch(running.url, post(initializeRequest()));
    const id = initialize.headers.get("mcp-session-id") as string;
    expect(id).toBeTruthy();
    await fetch(running.url, post(notify("notifications/initialized"), { "mcp-session-id": id }));

    const stream = await fetch(running.url, { headers: { accept: "text/event-stream", "mcp-session-id": id } });
    expect(stream.status).toBe(200);
    const reader = new SseReader(stream);
    expect((await reader.next())?.comment).toBe("ok");

    const call = await fetch(running.url, post(request("tools/call", { name: "doc_search", arguments: { query: "costs" } }), { "mcp-session-id": id }));
    const answer = (await call.json()) as { result: { structuredContent: { hits: { address: string }[] } } };
    expect(answer.result.structuredContent.hits.map((h) => h.address)).toEqual(["para:@3"]);
    const events = roomEvents(await reader.until((f) => roomEvents([f])[0]?.event.activity === "idle"));
    expect(events.map((e) => e.event.activity)).toEqual(["searching", "idle"]);
    await reader.cancel();

    expect((await fetch(running.url, { method: "DELETE", headers: { "mcp-session-id": id } })).status).toBe(204);
    expect((await fetch(running.url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });
});
