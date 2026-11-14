// The browser end of `wolfsdk.room.v1`: one WebSocket to `/ws`, joined to one room, that comes back by itself.
//
// On every (re)connect the client sends `room.join` with the highest `seq` it has seen, so the server replays only
// what it missed (or one `room.snapshot` the first time, or when the gap is too old). The server acknowledges a
// request only with the room events it causes, and refuses one with an `error` event that carries its
// `request_id`: `request` turns that into a promise.
//
// This file also holds the zero-WASM half of a shared link: `renderDisplayListSnapshot` paints the display-list
// pages a server sends onto 2D canvases with the vector renderer alone. It never fetches or instantiates an engine
// module, so a viewer of a shared link downloads no `.wasm`.
import type { RoomClientMessage, RoomConflictDetail, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { parseDisplayList } from "./vector/abi.ts";
import type { DisplayList } from "./vector/model.ts";
import { type Ctx2D, type RenderOptions, type RenderStats, renderPage } from "./vector/render.ts";

export type { Ctx2D, RenderOptions, RenderStats };

/** The part of a WebSocket the client uses; a test passes a fake. */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "closed";

/** A request without its `request_id`, which the client assigns. */
export type RoomRequest = RoomClientMessage extends infer M ? (M extends { request_id: string } ? Omit<M, "request_id"> : never) : never;

export type RoomClientOptions = {
  /** `ws(s)://host/ws?token=...` */
  url: string;
  roomId: string;
  /** Every event of the room, in order, including `error` events. */
  onEvent(event: RoomServerEvent): void;
  onStatus?(status: ConnectionStatus): void;
  /** The `seq` to resume after on the first connect. Default null: start from a snapshot. */
  sinceSeq?: number | null;
  /** Default `new WebSocket(url)`. */
  createSocket?: (url: string) => SocketLike;
  /** Runs `fn` after `ms`; returns a cancel. Default `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

/** A refused request: the `error` event's code, message and, for `REVISION_MISMATCH`, the head to rebase on. */
export class RoomRequestError extends Error {
  readonly code: string;
  readonly detail: RoomConflictDetail | undefined;

  constructor(code: string, message: string, detail?: RoomConflictDetail) {
    super(message);
    this.name = "RoomRequestError";
    this.code = code;
    this.detail = detail;
  }
}

/** Milliseconds before reconnect attempt `n` (0-based): 0.5 s doubling to 10 s. */
export const reconnectDelay = (attempt: number): number => Math.min(500 * 2 ** attempt, 10_000);

type Pending = { until: (event: RoomServerEvent) => boolean; resolve(event: RoomServerEvent): void; reject(error: Error): void };

export class RoomClient {
  readonly roomId: string;
  #options: RoomClientOptions;
  #socket: SocketLike | null = null;
  #status: ConnectionStatus = "closed";
  #lastSeq: number | null;
  #attempt = 0;
  #cancelRetry: (() => void) | null = null;
  #counter = 0;
  #joinId: string | null = null;
  #pending = new Map<string, Pending>();
  #stopped = false;
  constructor(options: RoomClientOptions) {
    this.#options = options;
    this.roomId = options.roomId;
    this.#lastSeq = options.sinceSeq ?? null;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** The highest `seq` received: what the next `room.join` resumes after. */
  get lastSeq(): number | null {
    return this.#lastSeq;
  }

  connect(): void {
    if (this.#stopped || this.#socket !== null) return;
    const create = this.#options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const socket = create(this.#options.url);
    this.#socket = socket;
    if (this.#status !== "reconnecting") this.#setStatus("connecting");
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#join();
    };
    socket.onmessage = (message) => {
      if (this.#socket !== socket || typeof message.data !== "string") return;
      let event: RoomServerEvent;
      try {
        event = JSON.parse(message.data) as RoomServerEvent;
      } catch {
        return;
      }
      this.#receive(event);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#joinId = null;
      this.#cancelRetry?.();
      this.#cancelRetry = null;
      this.#failPending("OFFLINE", "the connection closed before the room answered");
      if (this.#stopped) return this.#setStatus("closed");
      this.#setStatus("reconnecting");
      this.#scheduleRetry(() => this.connect());
    };
  }

  /** Stop for good: no reconnect, pending requests fail. */
  close(): void {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#joinId = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "closed by the client");
    this.#failPending("OFFLINE", "the connection was closed");
    this.#setStatus("closed");
  }

  /** Send `message` and resolve with the first room event `until` accepts, or reject with the `error` event that
   * answers it. Rejects at once when the room is not connected. */
  request(message: RoomRequest, until: (event: RoomServerEvent) => boolean): Promise<RoomServerEvent> {
    if (this.#status !== "live" || this.#socket === null) {
      return Promise.reject(new RoomRequestError("OFFLINE", "the room is not connected; try again when it is back"));
    }
    const requestId = this.#nextId();
    const { promise, resolve, reject } = Promise.withResolvers<RoomServerEvent>();
    this.#pending.set(requestId, { until, resolve, reject });
    this.#write({ ...message, request_id: requestId } as RoomClientMessage);
    return promise;
  }

  #join(): void {
    const requestId = this.#nextId();
    this.#joinId = requestId;
    this.#write({ type: "room.join", request_id: requestId, room_id: this.roomId, since_seq: this.#lastSeq });
    this.#setStatus("live");
  }

  #scheduleRetry(action: () => void): void {
    const schedule = this.#options.schedule ?? ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
    this.#cancelRetry = schedule(() => {
      this.#cancelRetry = null;
      action();
    }, reconnectDelay(this.#attempt++));
  }

  #receive(event: RoomServerEvent): void {
    if ("seq" in event) {
      if (this.#lastSeq === null || event.seq > this.#lastSeq) this.#lastSeq = event.seq;
      this.#joinId = null;
      this.#attempt = 0;
      this.#setStatus("live");
    }
    this.#options.onEvent(event);
    if (event.type === "error") {
      if (event.request_id !== null && event.request_id === this.#joinId) {
        this.#joinId = null;
        this.#failPending(event.code, event.message);
        if (!this.#stopped && this.#socket !== null) {
          this.#setStatus("reconnecting");
          this.#scheduleRetry(() => {
            if (!this.#stopped && this.#socket !== null) this.#join();
          });
        }
        return;
      }
      if (event.request_id === null && event.code === "LICENSE_LIMIT") {
        this.#joinId = null;
        this.#failPending(event.code, event.message);
        if (!this.#stopped && this.#socket !== null) {
          this.#setStatus("reconnecting");
          this.#scheduleRetry(() => {
            if (!this.#stopped && this.#socket !== null) this.#join();
          });
        }
        return;
      }
      const pending = event.request_id === null ? undefined : this.#pending.get(event.request_id);
      if (pending && event.request_id !== null) {
        this.#pending.delete(event.request_id);
        pending.reject(new RoomRequestError(event.code, event.message, "detail" in event ? event.detail : undefined));
      }
      return;
    }
    for (const [id, pending] of this.#pending) {
      if (!pending.until(event)) continue;
      this.#pending.delete(id);
      pending.resolve(event);
    }
  }

  #write(message: RoomClientMessage): void {
    this.#socket?.send(JSON.stringify(message));
  }

  #nextId(): string {
    this.#counter += 1;
    return `ui-${this.#counter}`;
  }

  #failPending(code: string, message: string): void {
    for (const pending of this.#pending.values()) pending.reject(new RoomRequestError(code, message));
    this.#pending.clear();
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatus?.(status);
  }
}

/** The WebSocket URL of `/ws` on the page's own origin, with the token as a query parameter (a browser WebSocket
 * cannot set a header). */
export function roomSocketUrl(origin: string, token: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Shared-link snapshot: display-list pages on a canvas, no engine
// ---------------------------------------------------------------------------

/** One page of a snapshot: the renderer's own page model (`./vector/model.ts`). */
export type Page = DisplayList;

/** What a shared-link view takes: pages already parsed, or the display-list bytes of a server snapshot. */
export type SharedSnapshotView = readonly Page[] | Uint8Array;

/** A snapshot the bytes or the JSON of which are not display-list pages. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** CSS pixels per point: a page of 612 pt shows 816 px wide at a device pixel ratio of 1. */
export const SNAPSHOT_PX_PER_PT = 96 / 72;

/** What a snapshot page is painted with unless the caller says otherwise: 96 dpi on white paper, no pack fonts. */
export const SNAPSHOT_RENDER: RenderOptions = { pxPerPt: SNAPSHOT_PX_PER_PT, background: "#ffffff" };

/** The pages of a snapshot from its bytes: UTF-8 JSON that is one `display_list` response per page, as an array
 * (in page order), as `{ "pages": [...] }`, or as a single response. A refusal (`ok: false`) throws the
 * `ReactorError` of `parseDisplayList`; anything that is not an object per page throws `SnapshotError`. */
export function decodeDisplayListSnapshot(bytes: Uint8Array): Page[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SnapshotError("the snapshot is not UTF-8 JSON");
  }
  const list: unknown[] =
    Array.isArray(value) ? value : typeof value === "object" && value !== null && "pages" in value && Array.isArray(value.pages) ? value.pages : [value];
  return list.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot page ${index + 1} is not a display_list response`);
    }
    return parseDisplayList(entry as Record<string, unknown>);
  });
}

/** The backing-store size, in device pixels, `renderDisplayListSnapshot` expects for `page`. */
export function snapshotCanvasSize(page: Page, options: RenderOptions = SNAPSHOT_RENDER): { width: number; height: number } {
  return { width: Math.round(page.width * options.pxPerPt), height: Math.round(page.height * options.pxPerPt) };
}

/** Paint every page of a snapshot: `createCanvas` gives the 2D context of one page (sized with
 * `snapshotCanvasSize` for the same options), and the stats of each paint come back in page order. Only the vector
 * renderer runs: nothing is fetched and no module is instantiated. */
export function renderDisplayListSnapshot(
  view: SharedSnapshotView,
  createCanvas: (page: Page) => Ctx2D,
  options: RenderOptions = SNAPSHOT_RENDER,
): RenderStats[] {
  const pages = view instanceof Uint8Array ? decodeDisplayListSnapshot(view) : view;
  return pages.map((page) => renderPage(createCanvas(page), page, options));
}
