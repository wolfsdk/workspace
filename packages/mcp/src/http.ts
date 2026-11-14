// MCP over Streamable HTTP, one endpoint (default `/mcp`):
//   POST    a JSON-RPC message or batch. The answer is one JSON body or one SSE stream, by the client's `Accept`.
//           `initialize` opens a session and its answer carries `Mcp-Session-Id`; every later request names it.
//   GET     the session's stream of room events as `notifications/message`. `Last-Event-ID` is the room `seq` of
//           the last event the client saw: the events after it are replayed before the live ones.
//   DELETE  end the session.
// The handler is a plain `(Request) => Response`, so it serves under Bun.serve (`startMcpHttpServer`) or any
// other fetch host. It checks `Origin` (a browser page on another site must not drive an agent on loopback), and
// asks `authenticate`, when given, who is calling.
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { INVALID_REQUEST, isObject, PARSE_ERROR, rpcError, type JsonRpcNotification, type JsonRpcResponse } from "./jsonrpc.ts";
import { MCP_PROTOCOL_VERSIONS, type McpServer, type McpSession } from "./server.ts";

export type McpHttpOptions = {
  server: McpServer;
  /** The URL path of the endpoint. Default `/mcp`. */
  path?: string;
  /** Origins a browser may call from, written as the browser sends them (`https://app.example.com`), or `*` for
   * any. Default: pages served from loopback only. A request with no `Origin` (not from a browser) passes. */
  allowedOrigins?: readonly string[] | "*";
  /** Who is calling. Return `null` to refuse the request with 401. The actor must be an agent; it replaces the
   * server's for that session, and a session keeps the actor that opened it. Default: every caller is the
   * server's own agent, so bind such a handler to loopback or put authentication in front of it. */
  authenticate?: (request: Request) => RoomActor | null | Promise<RoomActor | null>;
  /** Milliseconds between comment lines that keep an idle event stream open. 0 turns them off. Default 15000. */
  keepAliveMs?: number;
  /** Largest request body. Default 4 MiB. */
  maxBodyBytes?: number;
  /** Most sessions at once. Default 256. */
  maxSessions?: number;
  /** A session with no request and no event stream for this long is dropped. Default 30 minutes. */
  sessionTtlMs?: number;
};

export type McpHttpHandler = {
  fetch(request: Request): Promise<Response>;
  /** Close every session. */
  close(): void;
  /** Sessions open now. */
  readonly sessionCount: number;
};

const SESSION_HEADER = "mcp-session-id";
const DEFAULT_PATH = "/mcp";
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_MAX_BODY = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Entry = { session: McpSession; touched: number };

type MediaRange = { type: string; q: number; order: number };

/** The ranges of an `Accept` header with their quality, in the order written. */
function mediaRanges(accept: string | null): MediaRange[] {
  if (accept === null) return [];
  const ranges: MediaRange[] = [];
  accept.split(",").forEach((part, order) => {
    const [type = "", ...params] = part.split(";").map((piece) => piece.trim());
    if (type === "") return;
    let q = 1;
    for (const param of params) {
      const m = /^q=([0-9.]+)$/i.exec(param);
      if (m) q = Number(m[1]);
    }
    ranges.push({ type: type.toLowerCase(), q: Number.isFinite(q) ? q : 0, order });
  });
  return ranges;
}

/** How much `accept` wants `type`: the quality of the most specific range that names it, and where it was
 * written. `undefined` when no range covers it or its quality is 0. */
function want(ranges: readonly MediaRange[], type: string): { q: number; order: number } | undefined {
  const slash = type.indexOf("/");
  const wildcard = `${type.slice(0, slash)}/*`;
  const found = ranges.find((r) => r.type === type) ?? ranges.find((r) => r.type === wildcard) ?? ranges.find((r) => r.type === "*/*");
  return found && found.q > 0 ? { q: found.q, order: found.order } : undefined;
}

/** Whether a POST is answered as an event stream: the client wants `text/event-stream` more than JSON, or as
 * much and listed it first. A client that names neither gets JSON. */
export function prefersEventStream(accept: string | null): boolean {
  const ranges = mediaRanges(accept);
  const sse = want(ranges, "text/event-stream");
  if (!sse) return false;
  const json = want(ranges, "application/json");
  if (!json) return true;
  return sse.q > json.q || (sse.q === json.q && sse.order < json.order);
}

const acceptsEventStream = (accept: string | null): boolean => want(mediaRanges(accept), "text/event-stream") !== undefined;

const encoder = new TextEncoder();

function sseFrame(message: JsonRpcNotification | JsonRpcResponse | JsonRpcResponse[], id: number | undefined): Uint8Array {
  return encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const problem = (status: number, code: number, message: string, headers: Record<string, string> = {}): Response =>
  json(status, rpcError(null, code, message), headers);

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const { server } = options;
  const path = options.path ?? DEFAULT_PATH;
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const ttl = options.sessionTtlMs ?? DEFAULT_TTL_MS;
  const sessions = new Map<string, Entry>();

  const originAllowed = (origin: string | null): boolean => {
    if (origin === null) return true;
    const allowed = options.allowedOrigins;
    if (allowed === "*") return true;
    if (allowed !== undefined) return allowed.includes(origin);
    try {
      return LOOPBACK_HOSTS.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  };

  /** Drop the sessions nobody has used for `ttl`, except those with an event stream open. */
  const sweep = (now: number): void => {
    for (const [id, entry] of sessions) {
      if (!entry.session.streaming && now - entry.touched > ttl) {
        entry.session.close();
        sessions.delete(id);
      }
    }
  };

  const protocolHeaderOk = (request: Request): boolean => {
    const version = request.headers.get("mcp-protocol-version");
    return version === null || (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version);
  };

  /** The session a request names, or the response that refuses it. */
  const sessionOf = (request: Request, actor: RoomActor): McpSession | Response => {
    const id = request.headers.get(SESSION_HEADER);
    if (id === null) return problem(400, INVALID_REQUEST, "send the Mcp-Session-Id header of the initialize response");
    const entry = sessions.get(id);
    if (!entry || entry.session.closed) return problem(404, INVALID_REQUEST, "no such session: initialize again");
    if (entry.session.actor.id !== actor.id) return problem(403, INVALID_REQUEST, "the session belongs to another caller");
    entry.touched = Date.now();
    return entry.session;
  };

  const post = async (request: Request, actor: RoomActor): Promise<Response> => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > maxBody) return problem(413, INVALID_REQUEST, `the request body is over ${maxBody} bytes`);
    const text = await request.text();
    if (encoder.encode(text).length > maxBody) return problem(413, INVALID_REQUEST, `the request body is over ${maxBody} bytes`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem(400, PARSE_ERROR, "the body is not JSON");
    }

    const initializes = (message: unknown): boolean => isObject(message) && message.method === "initialize";
    if (Array.isArray(body) ? body.some(initializes) : initializes(body)) {
      if (Array.isArray(body)) return problem(400, INVALID_REQUEST, "initialize is not part of a batch");
      if (sessions.size >= maxSessions) sweep(Date.now());
      if (sessions.size >= maxSessions) return problem(503, INVALID_REQUEST, "too many sessions");
      const session = server.createSession(crypto.randomUUID(), actor);
      const answer = await session.handleBody(body);
      if (answer === undefined || Array.isArray(answer) || "error" in answer) {
        session.close();
        return json(400, answer ?? rpcError(null, INVALID_REQUEST, "initialize needs an id"));
      }
      sessions.set(session.id, { session, touched: Date.now() });
      return respond(request, answer, { "mcp-session-id": session.id });
    }

    if (!protocolHeaderOk(request)) return problem(400, INVALID_REQUEST, `unsupported MCP-Protocol-Version; this server speaks ${MCP_PROTOCOL_VERSIONS.join(", ")}`);
    const found = sessionOf(request, actor);
    if (found instanceof Response) return found;
    const answer = await found.handleBody(body);
    if (answer === undefined) return new Response(null, { status: 202 });
    return respond(request, answer, {});
  };

  /** `answer` as one JSON body, or as one event on a stream that then ends. */
  const respond = (request: Request, answer: JsonRpcResponse | JsonRpcResponse[], headers: Record<string, string>): Response => {
    if (!prefersEventStream(request.headers.get("accept"))) return json(200, answer, headers);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseFrame(answer, undefined));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...headers } });
  };

  const get = async (request: Request, actor: RoomActor): Promise<Response> => {
    if (!acceptsEventStream(request.headers.get("accept"))) return problem(406, INVALID_REQUEST, "the event stream is text/event-stream: send Accept: text/event-stream");
    if (!protocolHeaderOk(request)) return problem(400, INVALID_REQUEST, "unsupported MCP-Protocol-Version");
    const found = sessionOf(request, actor);
    if (found instanceof Response) return found;
    const session = found;
    const last = request.headers.get("last-event-id");
    let since: number | null = null;
    if (last !== null && last !== "") {
      if (!/^\d{1,15}$/.test(last)) return problem(400, INVALID_REQUEST, "Last-Event-ID is the seq of a room event");
      since = Number(last);
    }

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stopKeepAlive = new AbortController();
    let detach: (() => void) | undefined;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      stopKeepAlive.abort();
      detach?.();
      try {
        controller?.close();
      } catch {
        // The client already went away.
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        end();
      },
    });
    const send = (chunk: Uint8Array): void => {
      if (ended) return;
      try {
        controller?.enqueue(chunk);
      } catch {
        end();
      }
    };

    // The room ending the stream closes the response, so the client connects again and takes a seat if one is left.
    const attached = await session.attach((message, seq, last) => {
      send(sseFrame(message, seq));
      if (last) end();
    }, since);
    if (!attached.ok) {
      ended = true;
      void body.cancel().catch(() => undefined);
      if (attached.reason === "busy") return problem(409, INVALID_REQUEST, "this session already has an event stream");
      if (attached.reason === "closed") return problem(404, INVALID_REQUEST, "no such session: initialize again");
      return json(502, { error: attached.error });
    }
    detach = attached.detach;
    session.signal.addEventListener("abort", end, { once: true });
    request.signal.addEventListener("abort", end, { once: true });
    send(encoder.encode(": ok\n\n"));
    if (keepAliveMs > 0 && !ended) {
      const timer = setInterval(() => send(encoder.encode(": keepalive\n\n")), keepAliveMs);
      timer.unref?.();
      stopKeepAlive.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    }
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  };

  const del = (request: Request, actor: RoomActor): Response => {
    const found = sessionOf(request, actor);
    if (found instanceof Response) return found;
    found.close();
    sessions.delete(found.id);
    return new Response(null, { status: 204 });
  };

  return {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname !== path) return new Response("not found", { status: 404 });
      if (!originAllowed(request.headers.get("origin"))) return problem(403, INVALID_REQUEST, "this origin may not call the server");
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST, GET, DELETE" } });
      }
      let actor: RoomActor = server.actor;
      if (options.authenticate) {
        const who = await options.authenticate(request);
        if (who === null) return problem(401, INVALID_REQUEST, "authentication required", { "www-authenticate": "Bearer" });
        if (who.kind !== "agent") return problem(403, INVALID_REQUEST, "an MCP caller is an agent");
        actor = who;
      }
      sweep(Date.now());
      switch (request.method) {
        case "POST":
          return post(request, actor);
        case "GET":
          return get(request, actor);
        default:
          return del(request, actor);
      }
    },
    close(): void {
      for (const entry of sessions.values()) entry.session.close();
      sessions.clear();
    },
    get sessionCount(): number {
      return sessions.size;
    },
  };
}

export type McpHttpServerOptions = McpHttpOptions & {
  /** Default `127.0.0.1`. */
  hostname?: string;
  /** Default 0: a free port. */
  port?: number;
};

export type RunningMcpHttpServer = {
  /** The URL of the endpoint, for example `http://127.0.0.1:41233/mcp`. */
  url: string;
  port: number;
  handler: McpHttpHandler;
  stop(): Promise<void>;
};

/** Serve `createMcpHttpHandler` on a port with `Bun.serve`. Listens on loopback unless `hostname` says otherwise. */
export function startMcpHttpServer(options: McpHttpServerOptions): RunningMcpHttpServer {
  const handler = createMcpHttpHandler(options);
  const hostname = options.hostname ?? "127.0.0.1";
  const bun = Bun.serve({
    hostname,
    port: options.port ?? 0,
    maxRequestBodySize: options.maxBodyBytes ?? DEFAULT_MAX_BODY,
    // Event streams sit idle between events; the keep-alive comments are what keep them open, not the socket timer.
    idleTimeout: 0,
    fetch: (request) => handler.fetch(request),
  });
  const port = bun.port ?? 0;
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return {
    url: `http://${host}:${port}${options.path ?? DEFAULT_PATH}`,
    port,
    handler,
    async stop(): Promise<void> {
      handler.close();
      await bun.stop(true);
    },
  };
}
