import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  AssistantClientMessage,
  AssistantServerEvent,
  RoomClientMessage,
  RoomHead,
  RoomServerEvent,
  RoomSessionEntry,
  RoomState,
  RoomThread,
} from "@wolfsdk/protocol/workspace";
import type { Ctx2D } from "../src/vector/render.ts";
import { parseDisplayList } from "../src/vector/abi.ts";
import {
  type ConnectionStatus,
  decodeDisplayListSnapshot,
  type Page,
  reconnectDelay,
  renderDisplayListSnapshot,
  RoomClient,
  RoomRequestError,
  roomSocketUrl,
  type SocketLike,
  snapshotCanvasSize,
  SnapshotError,
} from "../src/ws-room.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SCOUT = { kind: "agent", id: "scout", name: "Scout" } as const;
const ALICE = { kind: "user", id: "alice", name: "Alice Chen" } as const;

function head(name: string, revision = 0, sha256 = SHA_A): RoomHead {
  return { name, revision, sha256, format: name.endsWith(".pptx") ? "pptx" : "docx", updated_at: "2026-11-13T18:00:00Z" };
}

function room(over: Partial<RoomState> = {}): RoomState {
  return {
    contract: "wolfsdk.room.v1",
    room_id: "q3-close",
    workspace_id: "default",
    seq: 10,
    documents: [{ head: head("memo.docx") }],
    session_log: [],
    proposals: [],
    comments: [],
    ...over,
  };
}

class FakeSocket implements SocketLike {
  sent: (RoomClientMessage | AssistantClientMessage)[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as RoomClientMessage | AssistantClientMessage);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  deliver(event: RoomServerEvent | AssistantServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(): void {
    this.onclose?.({});
  }
}

function harness(sinceSeq: number | null = null) {
  const sockets: FakeSocket[] = [];
  const events: RoomServerEvent[] = [];
  const assistant: unknown[] = [];
  const statuses: ConnectionStatus[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const client = new RoomClient({
    url: "ws://127.0.0.1:8787/ws?token=t",
    roomId: "q3-close",
    sinceSeq,
    onEvent: (event) => events.push(event),
    onAssistant: (event) => assistant.push(event),
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return { client, sockets, events, assistant, statuses, timers };
}

describe("RoomClient", () => {
  test("room.join carries since_seq null the first time, then resumes after the last seq it saw", () => {
    const { client, sockets, timers, statuses } = harness();
    client.connect();
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ type: "room.join", request_id: "ui-1", room_id: "q3-close", since_seq: null }]);
    sockets[0]!.deliver({ type: "room.snapshot", seq: 10, room: room() });
    sockets[0]!.deliver({ type: "doc.added", seq: 11, document: { head: head("deck.pptx") } });
    expect(client.lastSeq).toBe(11);

    sockets[0]!.drop();
    expect(client.status).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(reconnectDelay(0));
    timers[0]!.fn();
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toEqual({ type: "room.join", request_id: "ui-2", room_id: "q3-close", since_seq: 11 });
    expect(statuses).toEqual(["connecting", "live", "reconnecting", "live"]);
  });

  test("starts from a given seq", () => {
    const { client, sockets } = harness(42);
    client.connect();
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toMatchObject({ type: "room.join", since_seq: 42 });
  });

  test("an error event carries no seq and does not move lastSeq", () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver({ type: "room.snapshot", seq: 3, room: room({ seq: 3 }) });
    sockets[0]!.deliver({ type: "error", request_id: null, code: "BAD_REQUEST", message: "x" });
    expect(client.lastSeq).toBe(3);
  });

  test("backs off up to 10 seconds and resets after a successful open", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    const { client, sockets, timers } = harness();
    client.connect();
    sockets[0]!.drop();
    timers[0]!.fn();
    sockets[1]!.drop();
    expect(timers[1]!.ms).toBe(1000);
    timers[1]!.fn();
    sockets[2]!.open();
    sockets[2]!.drop();
    expect(timers[2]!.ms).toBe(500);
  });

  test("proposal.decide resolves with the event that answers it", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    const pending = client.request(
      { type: "proposal.decide", proposal_id: "p1", decision: "approve" },
      (event) => event.type === "proposal.updated" && event.proposal.proposal_id === "p1" && event.proposal.status !== "open",
    );
    expect(sockets[0]!.sent[1]).toEqual({ type: "proposal.decide", request_id: "ui-2", proposal_id: "p1", decision: "approve" });
    sockets[0]!.deliver({ type: "doc.added", seq: 1, document: { head: head("other.docx") } });
    const answer: RoomServerEvent = {
      type: "proposal.updated",
      seq: 2,
      proposal: {
        proposal_id: "p1",
        doc_name: "memo.docx",
        base_revision: 0,
        author: SCOUT,
        status: "approved",
        batches: [],
        preview_sha256: SHA_B,
        created_at: "2026-11-13T18:00:00Z",
      },
    };
    sockets[0]!.deliver(answer);
    expect(await pending).toEqual(answer);
  });

  test("doc.edit resolves with the doc.committed that carries the new head", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    const batch = { ops: [{ op: "set", address: "/body/p[1]", value: "Hello" }], label: "Greet" };
    const pending = client.request(
      { type: "doc.edit", doc_name: "memo.docx", base_revision: 0, mode: "commit", batch },
      (event) => event.type === "doc.committed" && event.head.name === "memo.docx" && event.head.revision === 1,
    );
    expect(sockets[0]!.sent[1]).toEqual({ type: "doc.edit", request_id: "ui-2", doc_name: "memo.docx", base_revision: 0, mode: "commit", batch });
    const entry: RoomSessionEntry = {
      seq: 11,
      doc_name: "memo.docx",
      revision: 1,
      base_sha256: SHA_A,
      result_sha256: SHA_B,
      author: ALICE,
      batch: { ...batch, clock: "2026-11-13T18:20:00Z", timezone: "America/Los_Angeles", locale: "en-US", seed: 7 },
      proposal_id: null,
      approved_by: null,
      committed_at: "2026-11-13T18:20:00Z",
    };
    const answer: RoomServerEvent = { type: "doc.committed", seq: 11, head: head("memo.docx", 1, SHA_B), entry };
    sockets[0]!.deliver(answer);
    expect(await pending).toEqual(answer);
    expect(client.lastSeq).toBe(11);
  });

  test("comment.post with resolve true resolves with the thread the room marks resolved", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    const pending = client.request(
      {
        type: "comment.post",
        thread_id: "t1",
        doc_name: "memo.docx",
        target_address: "/body/p[1]",
        body: "Done, thanks @scout",
        mentions: [{ kind: "agent", id: "scout" }],
        resolve: true,
      },
      (event) => event.type === "comment.updated" && event.thread.thread_id === "t1" && event.thread.resolved,
    );
    expect(sockets[0]!.sent[1]).toEqual({
      type: "comment.post",
      request_id: "ui-2",
      thread_id: "t1",
      doc_name: "memo.docx",
      target_address: "/body/p[1]",
      body: "Done, thanks @scout",
      mentions: [{ kind: "agent", id: "scout" }],
      resolve: true,
    });
    const open: RoomThread = {
      thread_id: "t1",
      doc_name: "memo.docx",
      target_address: "/body/p[1]",
      mentions: [{ kind: "agent", id: "scout" }],
      messages: [{ message_id: "t1-m1", author: ALICE, body: "@scout check this", created_at: "2026-11-13T18:30:00Z" }],
      resolved: false,
    };
    sockets[0]!.deliver({ type: "comment.updated", seq: 12, thread: open });
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    const resolved: RoomServerEvent = {
      type: "comment.updated",
      seq: 13,
      thread: {
        ...open,
        messages: [...open.messages, { message_id: "t1-m2", author: ALICE, body: "Done, thanks @scout", created_at: "2026-11-13T18:31:00Z" }],
        resolved: true,
      },
    };
    sockets[0]!.deliver(resolved);
    expect(await pending).toEqual(resolved);
  });

  test("request rejects with the REVISION_MISMATCH error that names it, conflict detail included", async () => {
    const { client, sockets } = harness();
    client.connect();
    sockets[0]!.open();
    const pending = client.request(
      { type: "doc.edit", doc_name: "memo.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "set" }] } },
      () => false,
    );
    sockets[0]!.deliver({
      type: "error",
      request_id: "ui-2",
      code: "REVISION_MISMATCH",
      message: "stale",
      detail: { doc_name: "memo.docx", base_revision: 0, head: head("memo.docx", 3) },
    });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoomRequestError);
    expect((error as RoomRequestError).code).toBe("REVISION_MISMATCH");
    expect((error as RoomRequestError).detail?.head.revision).toBe(3);
  });

  test("request refuses at once while offline, and pending requests fail when the socket drops", async () => {
    const { client, sockets } = harness();
    const offline = await client.request({ type: "proposal.decide", proposal_id: "p", decision: "reject" }, () => true).catch((e: unknown) => e);
    expect((offline as RoomRequestError).code).toBe("OFFLINE");
    client.connect();
    sockets[0]!.open();
    const pending = client.request({ type: "proposal.decide", proposal_id: "p", decision: "reject" }, () => false);
    sockets[0]!.drop();
    expect(((await pending.catch((e: unknown) => e)) as RoomRequestError).code).toBe("OFFLINE");
  });

  test("close stops reconnecting", () => {
    const { client, sockets, timers } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.drop();
    client.close();
    expect(timers[0]!.cancelled).toBe(true);
    expect(client.status).toBe("closed");
    client.connect();
    expect(sockets).toHaveLength(1);
  });

  test("ignores messages of a replaced socket and text that is not JSON", () => {
    const { client, sockets, events, timers } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.drop();
    timers[0]!.fn();
    sockets[0]!.deliver({ type: "room.snapshot", seq: 99, room: room({ seq: 99 }) });
    sockets[1]!.onmessage?.({ data: "not json" });
    expect(events).toEqual([]);
  });

  test("LICENSE_LIMIT releases the seat: pending requests fail and the client rejoins with backoff", async () => {
    const { client, sockets, timers, statuses } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver({ type: "room.snapshot", seq: 7, room: room({ seq: 7 }) });
    const inFlight = client.request(
      { type: "comment.post", thread_id: null, doc_name: "a.docx", target_address: "p1", body: "hi", mentions: [] },
      () => false,
    );
    sockets[0]!.deliver({ type: "error", request_id: null, code: "LICENSE_LIMIT", message: "seat released" });
    await expect(inFlight).rejects.toMatchObject({ code: "LICENSE_LIMIT", message: "seat released" });
    expect(client.status).toBe("reconnecting");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(500);

    timers[0]!.fn();
    const rejoin = sockets[0]!.sent.at(-1)!;
    expect(rejoin).toMatchObject({ type: "room.join", room_id: "q3-close", since_seq: 7 });
    sockets[0]!.deliver({ type: "error", request_id: rejoin.request_id, code: "LICENSE_LIMIT", message: "all seats taken" });
    expect(client.status).toBe("reconnecting");
    expect(timers).toHaveLength(2);
    expect(timers[1]!.ms).toBe(1000);

    timers[1]!.fn();
    sockets[0]!.deliver({ type: "room.snapshot", seq: 8, room: room({ seq: 8 }) });
    expect(client.status).toBe("live");
    expect(client.lastSeq).toBe(8);
    expect(statuses).toContain("reconnecting");
  });

  test("an assistant message goes to onAssistant alone: no room event, no settled request, no seq, no status", async () => {
    const { client, sockets, events, assistant, statuses } = harness();
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver({ type: "room.snapshot", seq: 5, room: room({ seq: 5 }) });
    let settled = false;
    const pending = client.request({ type: "proposal.decide", proposal_id: "p1", decision: "approve" }, () => true);
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    const requestId = sockets[0]!.sent.at(-1)!.request_id;
    const status: AssistantServerEvent = {
      type: "assistant.status",
      request_id: requestId,
      state: "ready",
      model: "deepseek-v4.1-flash",
      allowance: { period: "2026-11", limit: 300, used: 12, resets_at: "2026-12-01T00:00:00Z" },
    };
    // An assistant refusal that happens to carry the room request's id must not reject it either.
    const refusal: AssistantServerEvent = { type: "assistant.error", request_id: requestId, code: "BUSY", message: "a task is already running" };
    sockets[0]!.deliver(status);
    sockets[0]!.deliver(refusal);
    await Promise.resolve();
    expect(assistant).toEqual([status, refusal]);
    expect(events.map((e) => e.type)).toEqual(["room.snapshot"]);
    expect(settled).toBe(false);
    expect(client.lastSeq).toBe(5);
    expect(client.status).toBe("live");
    expect(statuses).toEqual(["connecting", "live"]);

    // The room's own answer still settles the request.
    const answer: RoomServerEvent = { type: "doc.added", seq: 6, document: { head: head("deck.pptx") } };
    sockets[0]!.deliver(answer);
    expect(await pending).toEqual(answer);
  });

  test("without onAssistant an assistant message is dropped, not handed to onEvent", () => {
    const sockets: FakeSocket[] = [];
    const events: RoomServerEvent[] = [];
    const client = new RoomClient({
      url: "ws://127.0.0.1:8787/ws?token=t",
      roomId: "q3-close",
      onEvent: (event) => events.push(event),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.deliver({ type: "assistant.text", task_id: "task-1", delta: "Hello" });
    expect(events).toEqual([]);
    expect(client.lastSeq).toBeNull();
  });

  test("sendAssistant writes the message with the caller's request_id, only while the room is live", () => {
    const { client, sockets, timers } = harness();
    const ask: AssistantClientMessage = {
      type: "assistant.ask",
      request_id: "assistant-7",
      conversation_id: null,
      text: "Tighten the summary",
      doc_name: "memo.docx",
      target_address: "/body/p[2]",
    };
    expect(client.sendAssistant(ask)).toBe(false);
    client.connect();
    expect(client.sendAssistant(ask)).toBe(false);
    expect(sockets[0]!.sent).toEqual([]);

    sockets[0]!.open();
    expect(client.sendAssistant(ask)).toBe(true);
    expect(sockets[0]!.sent).toEqual([{ type: "room.join", request_id: "ui-1", room_id: "q3-close", since_seq: null }, ask]);
    // The room's own request ids are untouched: the next request is still ui-2.
    void client.request({ type: "proposal.decide", proposal_id: "p1", decision: "approve" }, () => false).catch(() => undefined);
    expect(sockets[0]!.sent.at(-1)).toMatchObject({ type: "proposal.decide", request_id: "ui-2" });

    sockets[0]!.drop();
    expect(client.sendAssistant({ type: "assistant.status", request_id: "assistant-8" })).toBe(false);
    timers[0]!.fn();
    sockets[1]!.open();
    expect(client.sendAssistant({ type: "assistant.status", request_id: "assistant-8" })).toBe(true);
    expect(sockets[1]!.sent.at(-1)).toEqual({ type: "assistant.status", request_id: "assistant-8" });
  });
});

describe("roomSocketUrl", () => {
  test("uses ws for http and wss for https, with the token as a query parameter", () => {
    expect(roomSocketUrl("http://127.0.0.1:8787", "tok en")).toBe("ws://127.0.0.1:8787/ws?token=tok+en");
    expect(roomSocketUrl("https://workspace.example.com", "t")).toBe("wss://workspace.example.com/ws?token=t");
  });

  test("has no token parameter when the token is null, for a hosting front that authenticates the upgrade", () => {
    expect(roomSocketUrl("https://acme.cloud.example.com", null)).toBe("wss://acme.cloud.example.com/ws");
    expect(new URL(roomSocketUrl("http://127.0.0.1:8787", null)).searchParams.has("token")).toBe(false);
  });
});

// A `display_list` response of the reactor ABI, as a server stores it for a shared-link snapshot.
function displayListResponse(pageNumber: number, text: string): Record<string, unknown> {
  return {
    ok: true,
    page: pageNumber,
    ir: {
      size: { width: 612, height: 792 },
      label: `Page ${pageNumber}`,
      ops: [
        {
          fill: {
            path: [{ move_to: { x: 72, y: 72 } }, { line_to: { x: 272, y: 72 } }, { line_to: { x: 272, y: 172 } }, "close"],
            paint: { solid: { r: 20, g: 40, b: 80, a: 255 } },
            fill_rule: "non_zero",
          },
        },
        {
          glyph_run: {
            font: 0,
            size: 12,
            origin: { x: 72, y: 100 },
            fill: { solid: { r: 0, g: 0, b: 0, a: 255 } },
            shaping: "pending",
            text,
            object_id: `p:${pageNumber}`,
            object_offset: 0,
          },
        },
      ],
    },
    runs: [{ run: 0, object_id: `p:${pageNumber}`, object_offset: 0, char_x: [72, 79, 86], bbox: [72, 88, 14, 16] }],
    fonts: [{ id: 0, family: "Inter", weight: 400, style: "normal" }],
    images: [],
    objects: { [`p:${pageNumber}`]: { text, rendered: text, source_text: true } },
    regions: [{ object_id: `p:${pageNumber}`, bbox: [72, 88, 14, 16] }],
  };
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** A 2D context that records what it is asked to paint. */
function recordingContext(width: number, height: number): { ctx: Ctx2D; calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    canvas: { width, height },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    font: "",
    textBaseline: "alphabetic",
    textAlign: "left",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    setTransform: () => calls.push("setTransform"),
    transform: () => calls.push("transform"),
    scale: () => calls.push("scale"),
    translate: () => calls.push("translate"),
    fillRect: () => calls.push("fillRect"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    setLineDash: () => undefined,
    measureText: (t: string) => ({ width: t.length * 7 }),
    fillText: (t: string) => calls.push(`fillText:${t}`),
  } as unknown as Ctx2D;
  return { ctx, calls };
}

describe("renderDisplayListSnapshot", () => {
  const previousPath2D = globalThis.Path2D;
  beforeAll(() => {
    if (!globalThis.Path2D) {
      globalThis.Path2D = class MockPath2D {
        moveTo() {}
        lineTo() {}
        bezierCurveTo() {}
        quadraticCurveTo() {}
        closePath() {}
        rect() {}
        addPath() {}
      } as unknown as typeof Path2D;
    }
  });
  afterAll(() => {
    globalThis.Path2D = previousPath2D;
  });

  /** Runs `body` with every way to fetch or instantiate an engine module counted instead of allowed. */
  async function withoutWasm<T>(body: () => T): Promise<{ result: T; fetches: string[]; wasm: string[] }> {
    const fetches: string[] = [];
    const wasm: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      fetches.push(String(input));
      throw new Error("the snapshot must not fetch anything");
    }) as unknown as typeof fetch;
    const api = WebAssembly as unknown as Record<string, unknown>;
    const names = ["instantiate", "compile", "instantiateStreaming", "compileStreaming"];
    const real = new Map(names.map((name) => [name, api[name]]));
    for (const name of names) {
      api[name] = () => {
        wasm.push(name);
        throw new Error("the snapshot must not instantiate a module");
      };
    }
    try {
      return { result: body(), fetches, wasm };
    } finally {
      globalThis.fetch = realFetch;
      for (const [name, value] of real) api[name] = value;
    }
  }

  test("paints every page of display-list bytes onto its own context with zero fetch and zero WebAssembly", async () => {
    const bytes = encode([displayListResponse(1, "Hi"), displayListResponse(2, "Yo")]);
    const painted: { calls: string[]; page: Page }[] = [];
    const { result, fetches, wasm } = await withoutWasm(() =>
      renderDisplayListSnapshot(bytes, (page) => {
        const { width, height } = snapshotCanvasSize(page);
        const { ctx, calls } = recordingContext(width, height);
        painted.push({ calls, page });
        return ctx;
      }),
    );
    expect(fetches).toEqual([]);
    expect(wasm).toEqual([]);
    expect(painted.map(({ page }) => page.page)).toEqual([1, 2]);
    expect(result).toHaveLength(2);
    for (const stats of result) {
      expect(stats.ops).toBe(2);
      expect(stats.text.fallback).toBe(1);
    }
    expect(painted[0]!.calls).toContain("fillRect");
    expect(painted[0]!.calls).toContain("fill");
    expect(painted[0]!.calls).toContain("fillText:Hi");
    expect(painted[1]!.calls).toContain("fillText:Yo");
  });

  test("takes pages that are already parsed, and a caller's render options", async () => {
    const pages = [parseDisplayList(displayListResponse(1, "Hi"))];
    const sizes: { width: number; height: number }[] = [];
    const { result, fetches, wasm } = await withoutWasm(() =>
      renderDisplayListSnapshot(
        pages,
        (page) => {
          const size = snapshotCanvasSize(page, { pxPerPt: 2 });
          sizes.push(size);
          return recordingContext(size.width, size.height).ctx;
        },
        { pxPerPt: 2, background: null },
      ),
    );
    expect(fetches).toEqual([]);
    expect(wasm).toEqual([]);
    expect(sizes).toEqual([{ width: 1224, height: 1584 }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.ops).toBe(2);
  });

  test("an empty snapshot paints nothing", () => {
    expect(renderDisplayListSnapshot([], () => recordingContext(1, 1).ctx)).toEqual([]);
    expect(renderDisplayListSnapshot(encode({ pages: [] }), () => recordingContext(1, 1).ctx)).toEqual([]);
  });

  test("snapshotCanvasSize is the page in points at 96 dpi unless told otherwise", () => {
    const page = parseDisplayList(displayListResponse(1, "Hi"));
    expect(snapshotCanvasSize(page)).toEqual({ width: 816, height: 1056 });
    expect(snapshotCanvasSize(page, { pxPerPt: 1 })).toEqual({ width: 612, height: 792 });
  });
});

describe("decodeDisplayListSnapshot", () => {
  test("reads an array of responses, a { pages } object and a single response", () => {
    const one = displayListResponse(1, "Hi");
    const two = displayListResponse(2, "Yo");
    expect(decodeDisplayListSnapshot(encode([one, two])).map((p) => p.page)).toEqual([1, 2]);
    expect(decodeDisplayListSnapshot(encode({ pages: [two, one] })).map((p) => p.page)).toEqual([2, 1]);
    const [single] = decodeDisplayListSnapshot(encode(one));
    expect(single).toMatchObject({ page: 1, width: 612, height: 792, label: "Page 1" });
    expect(single!.runs[0]!.text).toBe("Hi");
  });

  test("refuses bytes that are not JSON, pages that are not objects, and a refused page", () => {
    expect(() => decodeDisplayListSnapshot(new TextEncoder().encode("not json"))).toThrow(SnapshotError);
    expect(() => decodeDisplayListSnapshot(new Uint8Array([0xff, 0xfe, 0xfd]))).toThrow(SnapshotError);
    expect(() => decodeDisplayListSnapshot(encode([1, 2]))).toThrow("snapshot page 1 is not a display_list response");
    expect(() => decodeDisplayListSnapshot(encode([{ ok: false, error: { code: "unknown-doc", message: "gone" } }]))).toThrow("unknown-doc: gone");
  });
});

describe("the module", () => {
  test("holds no engine: no fetch, no WebAssembly, no loader or reactor import", async () => {
    const source = await Bun.file(join(import.meta.dir, "../src/ws-room.ts")).text();
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/\bfetch\(|WebAssembly|\.wasm|loader\.ts|reactor\//);
    expect([...code.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1])).toEqual(["./vector/abi.ts", "./vector/model.ts", "./vector/render.ts"]);
  });
});
