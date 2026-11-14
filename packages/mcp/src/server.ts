// The MCP server proper, free of any transport: a session takes a JSON-RPC message and answers it, and streams
// the events of the room it is bound to. `http.ts` and `stdio.ts` only move bytes to and from a session.
//
// One server is bound to one room and one agent (the actor every tool call runs as). A transport makes one
// session per client connection; a session never shares state with another.
import {
  MCP_WORKSPACE_TOOLS,
  type McpWorkspaceCall,
  type RoomActor,
  type RoomServerEvent,
  validateMcpToolCall,
} from "@wolfsdk/protocol/workspace";
import type { RoomFailure, RoomService, RoomSubscription } from "@wolfsdk/server";
import {
  classify,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  METHOD_NOT_FOUND,
  notification,
  rpcError,
  RpcError,
  rpcResult,
} from "./jsonrpc.ts";
import { WorkspaceTools, type WorkspaceToolsOptions } from "./tools.ts";

/** The protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const MCP_LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
export type McpLogLevel = (typeof MCP_LOG_LEVELS)[number];

/** The `logger` of the `notifications/message` that carry room events. */
export const MCP_ROOM_LOGGER = "wolf.workspace.room";

const DEFAULT_INSTRUCTIONS =
  "Documents live in a shared room with people. Start with workspace_list, read with doc_read, and write with doc_edit, " +
  "passing the revision doc_read returned as base_revision. Use mode propose so a person reviews the change; use commit only " +
  "when you were asked to. After REVISION_MISMATCH, read again and rebase.";

export type McpServerOptions = WorkspaceToolsOptions & {
  /** Who the tools act as: an agent of the room. */
  actor: RoomActor;
  /** `serverInfo.name`. Default `wolf-workspace`. */
  name?: string;
  /** `serverInfo.version`. Default `0.0.0`. */
  version?: string;
  /** `instructions` of the `initialize` result: what a model should know before it uses the tools. */
  instructions?: string;
};

/** Receives one room event as an MCP notification. `seq` is the event's room sequence number, when it has one.
 * `last` is true for the event with which the room ends the stream: nothing follows it, and the session is free
 * to attach again. */
export type EventSink = (message: JsonRpcNotification, seq: number | undefined, last: boolean) => void;

export type AttachResult =
  | { ok: true; detach(): void }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "closed" }
  | { ok: false; reason: "room"; error: RoomFailure };

const rank = (level: McpLogLevel): number => MCP_LOG_LEVELS.indexOf(level);

const levelOf = (event: RoomServerEvent): McpLogLevel => {
  switch (event.type) {
    case "agent.activity":
      return "info";
    case "pages.invalidated":
      return "debug";
    case "error":
      return "error";
    default:
      return "notice";
  }
};

export class McpServer {
  readonly actor: RoomActor;
  readonly roomId: string;
  readonly service: RoomService;
  readonly tools: WorkspaceTools;
  readonly name: string;
  readonly version: string;
  readonly instructions: string;

  constructor(options: McpServerOptions) {
    if (options.actor.kind !== "agent") throw new RangeError(`the actor of an MCP server is an agent, not a ${options.actor.kind}`);
    this.actor = options.actor;
    this.roomId = options.roomId;
    this.service = options.service;
    this.name = options.name ?? "wolf-workspace";
    this.version = options.version ?? "0.0.0";
    this.instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
    this.tools = new WorkspaceTools(options);
  }

  /** A session for one client. `actor` overrides the server's, for a transport that authenticates callers. */
  createSession(id: string, actor: RoomActor = this.actor): McpSession {
    if (actor.kind !== "agent") throw new RangeError(`the actor of an MCP session is an agent, not a ${actor.kind}`);
    return new McpSession(this, id, actor);
  }
}

export class McpSession {
  readonly id: string;
  readonly actor: RoomActor;
  /** Aborts when the session closes. */
  readonly signal: AbortSignal;
  readonly #server: McpServer;
  readonly #close = new AbortController();
  #protocolVersion: McpProtocolVersion | null = null;
  #clientName: string | null = null;
  #level: McpLogLevel = "info";
  #detach: (() => void) | null = null;

  constructor(server: McpServer, id: string, actor: RoomActor) {
    this.#server = server;
    this.id = id;
    this.actor = actor;
    this.signal = this.#close.signal;
  }

  /** The revision negotiated by `initialize`; `null` before it. */
  get protocolVersion(): McpProtocolVersion | null {
    return this.#protocolVersion;
  }

  /** `clientInfo.name` of the `initialize` request, if the client sent one. */
  get clientName(): string | null {
    return this.#clientName;
  }

  get closed(): boolean {
    return this.signal.aborted;
  }

  /** Whether a stream of room events is attached. */
  get streaming(): boolean {
    return this.#detach !== null;
  }

  /** Answer one decoded JSON-RPC value: a message, or an array of them (a batch). Resolves to what goes back
   * to the client: nothing for notifications, one response, or the array of responses of a batch. */
  async handleBody(value: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (!Array.isArray(value)) return this.handle(value);
    if (value.length === 0) return rpcError(null, INVALID_REQUEST, "a batch has at least one message");
    const notifications: unknown[] = [];
    const requests: unknown[] = [];
    for (const message of value) (classify(message).kind === "notification" ? notifications : requests).push(message);
    for (const message of notifications) await this.handle(message);
    const answers = await Promise.all(requests.map((message) => this.handle(message)));
    const responses = answers.filter((answer): answer is JsonRpcResponse => answer !== undefined);
    return responses.length === 0 ? undefined : responses;
  }

  /** Answer one decoded JSON-RPC message. Never throws. */
  async handle(value: unknown): Promise<JsonRpcResponse | undefined> {
    const message = classify(value);
    switch (message.kind) {
      case "response":
        return undefined;
      case "invalid":
        return rpcError(message.id, INVALID_REQUEST, message.reason);
      case "notification":
        return undefined;
      case "request":
        return this.#request(message.message);
    }
  }

  async #request(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      return rpcResult(request.id, await this.#dispatch(request));
    } catch (error) {
      if (error instanceof RpcError) return rpcError(request.id, error.code, error.message, error.data);
      return rpcError(request.id, INTERNAL_ERROR, error instanceof Error ? error.message : "internal error");
    }
  }

  async #dispatch(request: JsonRpcRequest): Promise<unknown> {
    const params = request.params ?? {};
    if (request.method === "ping") return {};
    if (request.method === "initialize") return this.#initialize(params);
    if (this.#protocolVersion === null) throw new RpcError(INVALID_REQUEST, "the session is not initialized: send initialize first");
    switch (request.method) {
      case "tools/list":
        return { tools: MCP_WORKSPACE_TOOLS };
      case "tools/call":
        return this.#callTool(params);
      case "logging/setLevel": {
        const level = params.level;
        if (typeof level !== "string" || !(MCP_LOG_LEVELS as readonly string[]).includes(level)) {
          throw new RpcError(INVALID_PARAMS, "Invalid params", { problems: [`level: one of ${MCP_LOG_LEVELS.join(", ")}`] });
        }
        this.#level = level as McpLogLevel;
        return {};
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${request.method}`);
    }
  }

  #initialize(params: Record<string, unknown>): unknown {
    if (this.#protocolVersion !== null) throw new RpcError(INVALID_REQUEST, "the session is already initialized");
    const wanted = params.protocolVersion;
    if (typeof wanted !== "string") throw new RpcError(INVALID_PARAMS, "Invalid params", { problems: ["protocolVersion: a string"] });
    const supported = MCP_PROTOCOL_VERSIONS as readonly string[];
    // A client that asks for a revision this server does not know is told the newest one it does; the client
    // decides whether it can speak that.
    this.#protocolVersion = (supported.includes(wanted) ? wanted : MCP_PROTOCOL_VERSIONS[0]) as McpProtocolVersion;
    const clientInfo = params.clientInfo;
    if (isObject(clientInfo) && typeof clientInfo.name === "string") this.#clientName = clientInfo.name;
    const { name, version, instructions } = this.#server;
    return {
      protocolVersion: this.#protocolVersion,
      capabilities: { tools: { listChanged: false }, logging: {} },
      serverInfo: { name, version },
      instructions,
    };
  }

  async #callTool(params: Record<string, unknown>): Promise<unknown> {
    const call = { name: params.name, arguments: params.arguments ?? {} };
    const problems = validateMcpToolCall(call);
    if (problems.length > 0) throw new RpcError(INVALID_PARAMS, "Invalid params", { problems });
    return this.#server.tools.call(this.actor, call as McpWorkspaceCall);
  }

  /** Stream the events of the room to `sink` as `notifications/message`. `since` is the `seq` of the last event
   * the client saw (what `Last-Event-ID` carries): the events after it are replayed first. `null` streams only
   * what happens from now on. One stream per session. */
  async attach(sink: EventSink, since: number | null): Promise<AttachResult> {
    if (this.closed) return { ok: false, reason: "closed" };
    if (this.#detach !== null) return { ok: false, reason: "busy" };
    const { service } = this.#server;
    const roomId = this.#server.roomId;
    let from = since;
    if (from === null) {
      const room = await service.getRoom(roomId, this.actor);
      if (!room.ok) return { ok: false, reason: "room", error: room.error };
      from = room.value.seq;
    }
    // Claimed before the join, so two attaches racing on one session can not both get through.
    if (this.closed) return { ok: false, reason: "closed" };
    if (this.#detach !== null) return { ok: false, reason: "busy" };
    let live = true;
    let subscription: RoomSubscription | null = null;
    const detach = (): void => {
      live = false;
      subscription?.unsubscribe();
      if (this.#detach === detach) this.#detach = null;
    };
    this.#detach = detach;
    const joined = await service.join(roomId, this.actor, from, (event) => {
      if (!live) return;
      // An `error` event is the room ending the subscription (the identity lost its seat), so it reaches the
      // client whatever level it asked for, and the session is left free to attach again.
      const ended = event.type === "error";
      if (!ended && rank(levelOf(event)) < rank(this.#level)) return;
      sink(notification("notifications/message", { level: levelOf(event), logger: MCP_ROOM_LOGGER, data: event }), "seq" in event ? event.seq : undefined, ended);
      if (ended) detach();
    });
    if (!joined.ok) {
      if (this.#detach === detach) this.#detach = null;
      return { ok: false, reason: "room", error: joined.error };
    }
    subscription = joined.value;
    // The session closed while the room was joining: nobody is left to read the stream.
    if (this.closed) {
      detach();
      return { ok: false, reason: "closed" };
    }
    // The room ended the subscription before the join returned: the sink has the error, and there is nothing left to detach.
    if (!live) subscription.unsubscribe();
    return { ok: true, detach };
  }

  /** End the session: stop its event stream and abort `signal`. */
  close(): void {
    this.#detach?.();
    this.#detach = null;
    this.#close.abort();
  }
}
