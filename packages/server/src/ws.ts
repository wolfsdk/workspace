// The WebSocket endpoint of the room server: `wolfsdk.room.v1` over JSON text frames at `/ws`.
//
// A connection is one authenticated actor in at most one room. The client speaks `room.join`, `doc.edit`,
// `proposal.decide` and `comment.post`; the server answers a refused request with an `error` event carrying
// the request's `request_id`, and announces every accepted change with the events of the room (`doc.committed`,
// `proposal.updated`, ...), to the requester too: there is no separate acknowledgement. An `error` event with no
// `request_id` means the room ended the subscription (the actor lost its seat): the connection is in no room
// until it joins again.
//
// Every inbound message passes `validateRoomClientMessage` and every outbound event `validateRoomEvent`.
// Requests of one connection run one after another, in the order they arrived.
import {
  type RoomActor,
  type RoomClientMessage,
  type RoomServerEvent,
  ROOM_REVISION_MISMATCH,
  validateRoomClientMessage,
  validateRoomEvent,
} from "@wolfsdk/protocol/workspace";
import type { Result, RoomFailure, RoomService, RoomSubscription } from "./service.ts";

export type WsServerOptions = {
  service: RoomService;
  /** Who is connecting, from the upgrade request (a token, a session cookie, ...): `null` refuses the
   * connection with 401. The server trusts nothing a client says about itself inside the socket. */
  authenticate: (request: Request) => RoomActor | null | Promise<RoomActor | null>;
  /** Default 0: any free port. */
  port?: number;
  /** Default `127.0.0.1`. */
  hostname?: string;
};

export type WsServer = {
  port: number;
  /** `ws://host:port/ws` */
  url: string;
  /** Close every connection and stop listening. */
  stop(): Promise<void>;
};

type Connection = {
  actor: RoomActor;
  /** The requests of this connection, chained: the next starts when the one before has finished. */
  queue: Promise<void>;
  roomId: string | null;
  subscription: RoomSubscription | null;
  closed: boolean;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const WS_PATH = "/ws";

function errorEvent(requestId: string | null, error: RoomFailure): RoomServerEvent {
  if (error.code === ROOM_REVISION_MISMATCH) {
    return { type: "error", request_id: requestId, code: error.code, message: error.message, detail: error.detail };
  }
  return { type: "error", request_id: requestId, code: error.code, message: error.message };
}

const badRequest = (requestId: string | null, message: string): RoomServerEvent => errorEvent(requestId, { code: "BAD_REQUEST", message });

export function startWsServer(options: WsServerOptions): WsServer {
  const { service, authenticate } = options;

  /** Validate, then send. An event that does not validate is a bug of the server, not of the client: the
   * connection is closed rather than fed something the contract does not allow. A client that does not read
   * is closed too, so its backlog cannot grow without bound. */
  function send(ws: Bun.ServerWebSocket<Connection>, event: RoomServerEvent): void {
    if (ws.data.closed) return;
    const problems = validateRoomEvent(event);
    if (problems.length > 0) {
      console.error(`room server: refusing to send an invalid ${event.type}: ${problems.join("; ")}`);
      ws.close(1011, "internal error");
      return;
    }
    if (ws.send(JSON.stringify(event)) === 0) ws.close(1013, "too slow to follow");
  }

  async function execute(ws: Bun.ServerWebSocket<Connection>, message: RoomClientMessage): Promise<void> {
    const { actor } = ws.data;
    const requestId = message.request_id;
    if (message.type === "room.join") {
      ws.data.subscription?.unsubscribe();
      ws.data.subscription = null;
      ws.data.roomId = null;
      const joined = await service.join(message.room_id, actor, message.since_seq, (event) => {
        send(ws, event);
        // The room ended the subscription, which is the only one this connection has.
        if (event.type === "error") {
          ws.data.subscription = null;
          ws.data.roomId = null;
        }
      });
      if (!joined.ok) return send(ws, errorEvent(requestId, joined.error));
      if (ws.data.closed) return joined.value.unsubscribe();
      ws.data.subscription = joined.value;
      ws.data.roomId = message.room_id;
      return;
    }
    const roomId = ws.data.roomId;
    if (roomId === null) return send(ws, badRequest(requestId, "join a room first: send room.join"));
    let result: Result<unknown>;
    switch (message.type) {
      case "doc.edit":
        result = await service.edit(roomId, actor, {
          doc_name: message.doc_name,
          base_revision: message.base_revision,
          mode: message.mode,
          batch: message.batch,
        });
        break;
      case "proposal.decide":
        result = await service.decideProposal(roomId, actor, { proposal_id: message.proposal_id, decision: message.decision });
        break;
      case "comment.post":
        result = await service.postComment(roomId, actor, {
          thread_id: message.thread_id,
          doc_name: message.doc_name,
          target_address: message.target_address,
          body: message.body,
          mentions: message.mentions,
          ...(message.resolve === undefined ? {} : { resolve: message.resolve }),
        });
        break;
    }
    if (!result.ok) send(ws, errorEvent(requestId, result.error));
  }

  async function handle(ws: Bun.ServerWebSocket<Connection>, raw: string | Buffer): Promise<void> {
    if (typeof raw !== "string") return send(ws, badRequest(null, "messages are JSON text frames"));
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(ws, badRequest(null, "the message is not JSON"));
    }
    const problems = validateRoomClientMessage(message);
    if (problems.length > 0) {
      const id = typeof message === "object" && message !== null && "request_id" in message ? message.request_id : null;
      return send(ws, badRequest(typeof id === "string" && ID.test(id) ? id : null, problems.slice(0, 5).join("; ")));
    }
    // `validateRoomClientMessage` found no problem: the message has the shape of the contract.
    const valid = message as RoomClientMessage;
    try {
      await execute(ws, valid);
    } catch (e) {
      console.error("room server: a request failed unexpectedly", e);
      ws.close(1011, "internal error");
    }
  }

  const server = Bun.serve<Connection>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, upgrade) {
      if (new URL(request.url).pathname !== WS_PATH) return new Response("not found", { status: 404 });
      const actor = await authenticate(request);
      if (actor === null) return new Response("unauthorized", { status: 401 });
      const data: Connection = { actor, queue: Promise.resolve(), roomId: null, subscription: null, closed: false };
      if (upgrade.upgrade(request, { data })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES,
      closeOnBackpressureLimit: true,
      message(ws, raw) {
        ws.data.queue = ws.data.queue.then(() => handle(ws, raw));
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.subscription?.unsubscribe();
        ws.data.subscription = null;
      },
    },
  });

  return {
    port: server.port ?? 0,
    url: `ws://${server.hostname}:${server.port}${WS_PATH}`,
    async stop() {
      await server.stop(true);
    },
  };
}
