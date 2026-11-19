// The unified port of `serve`: the UI, the API, the room WebSocket and the MCP endpoint answer on one
// `Bun.serve`, over a real room server on a temporary directory with the in-memory engine of the MCP tests.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorPipeRequest, RoomActor, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { checkPack, DirectoryStore } from "@wolfsdk/packs";
import { EngineFault, EngineRefusal, type EngineWorker, RoomServer, type WorkerPool } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { LocalEngine } from "../../packs/test/evaluators.ts";
import { binding, docx, manifest, manifestBytes, partText, QUARTERS, STYLE, xlsx } from "../../packs/test/fixtures.ts";
import workspacePackage from "../package.json" with { type: "json" };
import { PLAN_READ_ONLY_REASONS, type PlanReadOnly, type PlanReadOnlyReason, planReadOnlyMode } from "../src/errors.ts";
import { formatOfName, resolveInside, type SnapshotInput, startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";
import { engineSnapshot } from "../src/run.ts";

// Writes are flushed to disk and sockets are opened: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const TOKENS = new Map<string, RoomActor>([
  ["t-alice", ALICE],
  ["t-robot", ROBOT],
]);
const LINES = ["Quarterly brief", "Revenue grew in Q3."];
const INDEX_HTML = "<!doctype html><title>Wolf Workspace</title><div id=app></div>";
/** A Word document on its own `ArrayBuffer`, as a fetch body takes it. */
const word = (lines: string[]): Uint8Array<ArrayBuffer> => new Uint8Array(wordDocument(lines));

let dir: string;
let room: RoomServer;
let server: WorkspaceServer;

async function start(options: Partial<WorkspaceServerOptions> = {}): Promise<WorkspaceServer> {
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    staticDir: join(dir, "ui"),
    ...options,
  });
  return server;
}

const auth = (token = "t-alice"): Record<string, string> => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${server.url}${path}`, init);
const postJson = (path: string, body: unknown, token = "t-alice"): Promise<Response> =>
  call(path, { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-http-"));
  await mkdir(join(dir, "ui", "assets"), { recursive: true });
  await writeFile(join(dir, "ui", "index.html"), INDEX_HTML);
  await writeFile(join(dir, "ui", "assets", "app-1234.js"), "console.log('workspace');");
  await writeFile(join(dir, "secret.txt"), "outside the UI");
  room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new MemoryEngine() });
});

afterEach(async () => {
  await server?.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

/** A room `r1` with `brief.docx`, created through the API. */
async function seedRoom(): Promise<void> {
  expect((await postJson("/api/rooms", { room_id: "r1", workspace_id: "ws" })).status).toBe(201);
  const upload = await call("/api/rooms/r1/docs?name=brief.docx", { method: "POST", headers: auth(), body: word(LINES) });
  expect(upload.status).toBe(201);
}

/** A WebSocket client of `/ws` that keeps every event and waits for the one a test needs. */
async function connect(token = "t-alice"): Promise<{ ws: WebSocket; events: RoomServerEvent[]; next(match: (e: RoomServerEvent) => boolean): Promise<RoomServerEvent>; send(message: unknown): void }> {
  const ws = new WebSocket(`${server.wsUrl}?token=${token}`);
  const events: RoomServerEvent[] = [];
  const waiters: { match: (e: RoomServerEvent) => boolean; resolve: (e: RoomServerEvent) => void }[] = [];
  ws.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as RoomServerEvent;
    events.push(event);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(event)) waiter.resolve(event);
      else waiters.push(waiter);
    }
  });
  const opened = Promise.withResolvers<void>();
  ws.addEventListener("open", () => opened.resolve(), { once: true });
  ws.addEventListener("error", () => opened.reject(new Error("the socket did not open")), { once: true });
  await opened.promise;
  return {
    ws,
    events,
    send: (message) => ws.send(JSON.stringify(message)),
    // An event that never comes fails the test on the runner's own timeout.
    next: (match) => {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen);
      const waiting = Promise.withResolvers<RoomServerEvent>();
      waiters.push({ match, resolve: waiting.resolve });
      return waiting.promise;
    },
  };
}

describe("helpers", () => {
  test("the token comes from the bearer header, else the query", () => {
    expect(tokenOf(new Request("http://x/ws", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(tokenOf(new Request("http://x/ws?token=def"))).toBe("def");
    expect(tokenOf(new Request("http://x/ws"))).toBeNull();
  });

  test("the format of a file name is its extension", () => {
    expect(["a.docx", "B.XLSX", "c.pptx", "d.pdf", "e.txt", "noext"].map(formatOfName)).toEqual(["docx", "xlsx", "pptx", "pdf", null, null]);
  });

  test("a path never leaves its root", () => {
    expect(resolveInside("/srv/ui", "/assets/a.js")).toBe("/srv/ui/assets/a.js");
    expect(resolveInside("/srv/ui", "/a/../b.js")).toBe("/srv/ui/b.js");
    expect(resolveInside("/srv/ui", "/../secret.txt")).toBeNull();
    expect(resolveInside("/srv/ui", "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(resolveInside("/srv/ui", "/%00")).toBeNull();
    expect(resolveInside("/srv/ui", "/%E0%A4%A")).toBeNull();
  });
});

describe("the UI", () => {
  test("serves index.html at / and for app routes, assets as files, and nothing outside its directory", async () => {
    await start();
    const index = await call("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await index.text()).toBe(INDEX_HTML);
    expect(await (await call("/rooms/r1", { headers: { accept: "*/*" } })).text()).toBe(INDEX_HTML);
    expect(await (await call("/rooms/r1/brief.docx", { headers: { accept: "text/html" } })).text()).toBe(INDEX_HTML);
    const asset = await call("/assets/app-1234.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await call("/assets/missing.js")).status).toBe(404);
    expect((await call("/missing.png")).status).toBe(404);
    expect((await call("/%2e%2e/secret.txt")).status).toBe(404);
    expect((await call("/", { method: "POST" })).status).toBe(405);
  });

  test("says how to build it when there is none", async () => {
    await start({ staticDir: null });
    const response = await call("/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("bun run build");
  });
});

describe("the API", () => {
  test("answers health without a token and everything else only with one", async () => {
    await start();
    expect(await (await call("/api/health")).json()).toEqual({ ok: true });
    const anonymous = await call("/api/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect((await call("/api/me", { headers: auth("wrong") })).status).toBe(401);
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE });
    expect(await (await call("/api/me?token=t-robot")).json()).toEqual({ actor: ROBOT });
    expect((await call("/api/nothing", { headers: auth() })).status).toBe(404);
  });

  test("creates and lists rooms, adds documents raw and as a form, and serves heads with their receipts", async () => {
    await start();
    const created = await postJson("/api/rooms", { room_id: "r1" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { workspace_id: string }).workspace_id).toBe("default");
    expect((await postJson("/api/rooms", { room_id: "r1" })).status).toBe(400);
    expect((await postJson("/api/rooms", { room_id: "bad id" })).status).toBe(400);
    expect(await (await call("/api/rooms", { headers: auth() })).json()).toEqual({ rooms: [{ room_id: "r1", workspace_id: "default", seq: 0 }] });

    const bytes = word(LINES);
    const raw = await call("/api/rooms/r1/docs?name=brief.docx", { method: "POST", headers: auth(), body: bytes });
    expect(raw.status).toBe(201);
    const { head } = (await raw.json()) as { head: { revision: number; sha256: string; format: string } };
    expect(head).toMatchObject({ revision: 0, format: "docx" });

    const form = new FormData();
    form.append("file", new File([word(["Second"])], "notes.docx"));
    const multipart = await call("/api/rooms/r1/docs", { method: "POST", headers: auth(), body: form });
    expect(multipart.status).toBe(201);
    expect(((await multipart.json()) as { head: { name: string } }).head.name).toBe("notes.docx");

    expect((await call("/api/rooms/r1/docs?name=notes.txt", { method: "POST", headers: auth(), body: bytes })).status).toBe(400);
    expect((await call("/api/rooms/r1/docs?name=a/b.docx", { method: "POST", headers: auth(), body: bytes })).status).toBe(400);
    expect((await call("/api/rooms/r1/docs?name=empty.docx", { method: "POST", headers: auth(), body: new Uint8Array() })).status).toBe(400);
    expect((await call("/api/rooms/nope/docs?name=x.docx", { method: "POST", headers: auth(), body: bytes })).status).toBe(404);

    const read = await call("/api/rooms/r1/docs/brief.docx/head", { headers: auth() });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(read.headers.get("etag")).toBe(`"sha256:${head.sha256}"`);
    expect(read.headers.get("x-wolf-revision")).toBe("0");
    expect(read.headers.get("x-wolf-sha256")).toBe(head.sha256);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    const again = await call("/api/rooms/r1/docs/brief.docx/head", { headers: { ...auth(), "if-none-match": `"sha256:${head.sha256}"` } });
    expect(again.status).toBe(304);
    expect((await call("/api/rooms/r1/docs/none.docx/head", { headers: auth() })).status).toBe(404);

    const state = (await (await call("/api/rooms/r1", { headers: auth() })).json()) as { documents: unknown[]; contract: string };
    expect(state.contract).toBe("wolfsdk.room.v1");
    expect(state.documents).toHaveLength(2);
  });

  test("answers NO_PACK without a linked pack, and checks and refreshes one when linked", async () => {
    await start();
    const missing = await call("/api/pack", { headers: auth() });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NO_PACK");
    await server.stop();

    const pack = join(dir, "pack");
    await mkdir(pack);
    await writeFile(
      join(pack, "pack.wolf.json"),
      manifestBytes(
        manifest([binding({ id: "headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } })]),
      ),
    );
    await writeFile(join(pack, "fin.xlsx"), xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } }));
    await writeFile(join(pack, "deck.docx"), docx());
    await start({ pack: { dir: pack } });
    const stale = (await (await call("/api/pack", { headers: auth() })).json()) as { dir: string; report: { fresh: boolean } };
    expect(stale).toMatchObject({ dir: "pack", report: { fresh: false } });
    expect((await call("/api/pack/refresh", { headers: auth() })).status).toBe(405);
    const refreshed = await call("/api/pack/refresh", { method: "POST", headers: auth() });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { refreshed: string[]; report: { documents: { doc_name: string; sha256_after: string }[] } };
    expect(body.refreshed).toEqual(["deck.docx"]);
    expect(body.report.documents[0]?.sha256_after).toMatch(/^[0-9a-f]{64}$/);
    expect(((await (await call("/api/pack", { headers: auth() })).json()) as { report: { fresh: boolean } }).report.fresh).toBe(true);
    expect((await readFile(join(pack, "deck.docx"))).length).toBeGreaterThan(0);
  });

  test("checks the pack against the heads of a room: stale until the refresh an agent proposed is approved, then fresh", async () => {
    // A room whose engine applies a batch the way a local refresh does.
    await room.close();
    room = new RoomServer({ dbPath: join(dir, "pack-rooms.sqlite"), blobDir: join(dir, "pack-blobs"), engine: new LocalEngine() });
    const pack = join(dir, "pack");
    await mkdir(pack);
    const bindings = [
      binding({ id: "headline", target_kind: "docx_bookmark", target_address: "Headline", selector: { type: "defined_name", name: "Headline" } }),
      binding({ id: "table", target_kind: "docx_table", target_address: "Revenue", selector: { type: "range", sheet: "Fin", ref: "A1:B4" }, fit_policy: "grow" }),
    ];
    await writeFile(join(pack, "pack.wolf.json"), manifestBytes(manifest(bindings)));
    await writeFile(join(pack, "fin.xlsx"), xlsx({ rows: QUARTERS, names: { Headline: "Fin!$B$2" } }));
    await writeFile(join(pack, "deck.docx"), docx());
    await start({ pack: { dir: pack } });
    expect((await postJson("/api/rooms", { room_id: "r1", workspace_id: "ws" })).status).toBe(201);
    // The room's workbook says Q1 revenue is 5,000,000; the pack directory's says 1,234,567.
    const rows = [QUARTERS[0] ?? [], ["Q1", { v: 5000000, s: STYLE.currency }, { v: 0.5, s: STYLE.percent }], ...QUARTERS.slice(2)];
    const workbook = new Uint8Array(xlsx({ rows, names: { Headline: "Fin!$B$2" } }));
    expect((await call("/api/rooms/r1/docs?name=fin.xlsx", { method: "POST", headers: auth(), body: workbook })).status).toBe(201);
    expect((await call("/api/rooms/r1/docs?name=deck.docx", { method: "POST", headers: auth(), body: new Uint8Array(docx()) })).status).toBe(201);

    type Checked = { dir: string; room: string | null; report: { fresh: boolean; bindings: { binding_id: string; status: string }[] } };
    const check = async (query = "?room=r1"): Promise<Checked> => {
      const response = await call(`/api/pack${query}`, { headers: auth() });
      expect(response.status).toBe(200);
      return (await response.json()) as Checked;
    };
    const statuses = (checked: Checked) => checked.report.bindings.map((b) => [b.binding_id, b.status]);

    const before = await check();
    expect(before).toMatchObject({ dir: "pack", room: "r1", report: { fresh: false } });
    expect(statuses(before)).toEqual([
      ["headline", "stale"],
      ["table", "stale"],
    ]);
    // The only room needs no name.
    expect((await check("")).room).toBe("r1");

    // The agent proposes the refresh; until a person approves it, nothing in the room has changed.
    const mcp = (body: unknown, headers: Record<string, string>) =>
      fetch(`${server.mcpUrl}?room=r1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    const opened = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, auth("t-robot"));
    expect(opened.status).toBe(200);
    const session = { ...auth("t-robot"), "mcp-session-id": opened.headers.get("mcp-session-id") ?? "" };
    const proposed = (await (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pack_link_refresh", arguments: { pack: "quarterly" } } }, session)).json()) as {
      result: { structuredContent: { mode: string; updated: number; bindings: { proposal_id?: string }[] } };
    };
    expect(proposed.result.structuredContent).toMatchObject({ mode: "propose", updated: 2 });
    const proposalId = proposed.result.structuredContent.bindings[0]?.proposal_id ?? "";
    expect(statuses(await check())).toEqual([
      ["headline", "stale"],
      ["table", "stale"],
    ]);

    // Approved and committed: the same server, unrestarted, says every binding is fresh.
    expect((await room.decideProposal("r1", ALICE, { proposal_id: proposalId, decision: "approve" })).ok).toBe(true);
    const head = await room.readHead("r1", ALICE, "deck.docx");
    if (!head.ok) throw new Error(head.error.message);
    expect(head.value.head.revision).toBe(1);
    expect(partText(head.value.bytes, "word/document.xml")).toContain("5,000,000");
    const after = await check();
    expect(after).toMatchObject({ room: "r1", report: { fresh: true } });
    expect(after.report.bindings.filter((b) => b.status === "stale")).toEqual([]);
    // The files on disk were never refreshed: checked there, the pack is still stale.
    expect((await checkPack(new DirectoryStore(pack))).fresh).toBe(false);

    // A room that does not exist, or an id that is none, is named as such.
    expect((await call("/api/pack?room=nope", { headers: auth() })).status).toBe(404);
    expect((await call("/api/pack?room=%2Fx", { headers: auth() })).status).toBe(400);
  });
});

describe("the snapshot of a head", () => {
  const url = "/api/rooms/r1/docs/brief.docx/snapshot";
  const pages = [
    { cmd: "display_list", ok: true, ms: 0, page: 1 },
    { cmd: "display_list", ok: true, ms: 0, page: 2 },
  ];

  test("answers 501 until the server has a way to render pages", async () => {
    await start();
    await seedRoom();
    const missing = await call(url, { headers: auth() });
    expect(missing.status).toBe(501);
    expect(await missing.json()).toMatchObject({ error: { code: "NO_SNAPSHOT" } });
  });

  test("serves the display-list pages of the head with its receipts, and renders a head once per receipt", async () => {
    const seen: SnapshotInput[] = [];
    await start({
      snapshot: async (input) => {
        seen.push(input);
        return pages;
      },
    });
    await seedRoom();
    const head = await call("/api/rooms/r1/docs/brief.docx/head", { headers: auth() });
    const sha256 = head.headers.get("x-wolf-sha256")!;

    const read = await call(url, { headers: auth() });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/json");
    expect(read.headers.get("etag")).toBe(`"sha256:${sha256}"`);
    expect(read.headers.get("cache-control")).toBe("no-cache");
    expect(read.headers.get("x-wolf-revision")).toBe("0");
    expect(read.headers.get("x-wolf-sha256")).toBe(sha256);
    expect(await read.json()).toEqual({ pages });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ format: "docx", name: "brief.docx" });
    expect(seen[0]?.bytes).toEqual(new Uint8Array(await head.arrayBuffer()));

    // A client that holds this head's snapshot is told so, and nothing is rendered again.
    const again = await call(url, { headers: { ...auth(), "if-none-match": `"sha256:${sha256}"` } });
    expect(again.status).toBe(304);
    expect(seen).toHaveLength(1);
  });

  test("needs a known caller and a room and document that exist, and answers GET only", async () => {
    const seen: SnapshotInput[] = [];
    await start({
      snapshot: async (input) => {
        seen.push(input);
        return pages;
      },
    });
    await seedRoom();
    expect((await call(url)).status).toBe(401);
    expect((await call(url, { headers: auth("wrong") })).status).toBe(401);
    expect((await call("/api/rooms/r1/docs/none.docx/snapshot", { headers: auth() })).status).toBe(404);
    expect((await call("/api/rooms/nope/docs/brief.docx/snapshot", { headers: auth() })).status).toBe(404);
    expect((await call(url, { method: "POST", headers: auth() })).status).toBe(404);
    expect(seen).toEqual([]);
    // An agent may read the room, so it may read the snapshot of a head.
    expect((await call(url, { headers: auth("t-robot") })).status).toBe(200);
  });

  test("answers 503 when the engine cannot lay the document out, and lets any other failure through", async () => {
    await start({
      snapshot: async () => {
        throw new EngineRefusal("unsupported", "no layout for this document", "layout");
      },
    });
    await seedRoom();
    const refused = await call(url, { headers: auth() });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "ENGINE_FAILED", message: expect.stringContaining("no layout") } });
    await server.stop();

    await start({
      snapshot: async () => {
        throw new EngineFault("the worker went away");
      },
    });
    expect((await call(url, { headers: auth() })).status).toBe(503);
  });
});

describe("engineSnapshot", () => {
  const DETERMINISM = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 };

  /** A pool of one scripted worker that records what it was asked. */
  function scriptedPool(script: { pages: number; badClose?: boolean; refuse?: ReactorPipeRequest["cmd"] }) {
    const asked: ReactorPipeRequest[] = [];
    const opened: Uint8Array[] = [];
    const discarded: number[] = [];
    const worker: EngineWorker = {
      discard: () => void discarded.push(1),
      async call(req, segments = []) {
        asked.push(req);
        if (script.refuse === req.cmd) return { body: { cmd: req.cmd, ok: false, ms: 0, error: { code: "unsupported", message: `no ${req.cmd}` } }, segments: [] } as never;
        switch (req.cmd) {
          case "open": {
            const bytes = segments[req.bytes.bin] ?? new Uint8Array();
            opened.push(bytes);
            return { body: { cmd: "open", ok: true, ms: 0, doc: 7, format: req.format, sha256: "0".repeat(64), bytes: bytes.length, revision: 0, determinism: DETERMINISM }, segments: [] } as never;
          }
          case "layout":
            return { body: { cmd: "layout", ok: true, ms: 0, cached: false, layout_ms: 0, summary: { format: "docx", pages: script.pages, determinism: DETERMINISM }, page_hashes: [] }, segments: [] } as never;
          case "display_list":
            return { body: { cmd: "display_list", ok: true, ms: 0, page: req.page, page_hash: "h", ir: {}, fonts: [], images: [], runs: [], objects: {}, regions: [], layout_cached: false }, segments: [] } as never;
          case "close":
            return { body: { cmd: "close", ok: !script.badClose, ms: 0, doc: req.doc }, segments: [] } as never;
          default:
            throw new Error(`unexpected command ${req.cmd}`);
        }
      },
    };
    const pool: Pick<WorkerPool, "withWorker"> = { withWorker: (job) => job(worker) };
    return { pool, asked, opened, discarded };
  }

  test("opens the head bytes, lays them out, asks every page in order and closes the document", async () => {
    const { pool, asked, opened, discarded } = scriptedPool({ pages: 3 });
    const bytes = word(LINES);
    const pages = await engineSnapshot(pool)({ format: "docx", name: "brief.docx", bytes });
    expect(asked.map((r) => r.cmd)).toEqual(["open", "layout", "display_list", "display_list", "display_list", "close"]);
    expect(asked[0]).toMatchObject({ cmd: "open", name: "brief.docx", format: "docx", bytes: { bin: 0, len: bytes.length } });
    expect(asked.slice(2, 5)).toEqual([1, 2, 3].map((page) => ({ cmd: "display_list", doc: 7, page })));
    expect(asked[5]).toEqual({ cmd: "close", doc: 7 });
    expect(opened[0]).toEqual(bytes);
    expect(pages).toMatchObject([1, 2, 3].map((page) => ({ cmd: "display_list", page })));
    expect(discarded).toEqual([]);
  });

  test("a document with no page has no page to paint", async () => {
    const { pool, asked } = scriptedPool({ pages: 0 });
    expect(await engineSnapshot(pool)({ format: "docx", name: "brief.docx", bytes: word(LINES) })).toEqual([]);
    expect(asked.map((r) => r.cmd)).toEqual(["open", "layout", "close"]);
  });

  test("an engine refusal reaches the caller after the document is closed", async () => {
    const { pool, asked } = scriptedPool({ pages: 2, refuse: "display_list" });
    const error = await engineSnapshot(pool)({ format: "docx", name: "brief.docx", bytes: word(LINES) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineRefusal);
    expect(error).toMatchObject({ code: "unsupported" });
    expect(asked.map((r) => r.cmd)).toEqual(["open", "layout", "display_list", "close"]);
  });

  test("a worker that cannot close the document is not reused", async () => {
    const { pool, discarded } = scriptedPool({ pages: 1, badClose: true });
    expect(await engineSnapshot(pool)({ format: "docx", name: "brief.docx", bytes: word(LINES) })).toHaveLength(1);
    expect(discarded).toEqual([1]);
  });
});

describe("the room WebSocket", () => {
  test("refuses a caller without a token and a request that is no upgrade", async () => {
    await start();
    const url = server.wsUrl.replace(/^ws:/, "http:");
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}?token=t-alice`)).status).toBe(426);
  });

  test("joins, commits, proposes, previews, approves and comments on the same port as the API", async () => {
    await start();
    await seedRoom();
    const alice = await connect();
    alice.send({ type: "room.join", request_id: "j1", room_id: "r1", since_seq: null });
    const snapshot = await alice.next((e) => e.type === "room.snapshot");
    expect(snapshot.type === "room.snapshot" && snapshot.room.documents.map((d) => d.head.name)).toEqual(["brief.docx"]);

    alice.send({ type: "doc.edit", request_id: "e1", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Committed." }], label: "Add a line" } });
    const committed = await alice.next((e) => e.type === "doc.committed");
    expect(committed.type === "doc.committed" && committed.head.revision).toBe(1);

    alice.send({ type: "doc.edit", request_id: "e2", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Stale." }] } });
    const stale = await alice.next((e) => e.type === "error" && e.request_id === "e2");
    expect(stale.type === "error" && stale.code).toBe("REVISION_MISMATCH");

    const robot = await connect("t-robot");
    robot.send({ type: "room.join", request_id: "j2", room_id: "r1", since_seq: null });
    await robot.next((e) => e.type === "room.snapshot");
    robot.send({ type: "doc.edit", request_id: "p1", doc_name: "brief.docx", base_revision: 1, mode: "propose", batch: { ops: [{ op: "replace_text", find: "Q3", text: "the third quarter" }], label: "Spell out" } });
    const proposed = await alice.next((e) => e.type === "proposal.updated" && e.proposal.status === "open");
    if (proposed.type !== "proposal.updated") throw new Error("expected a proposal");
    const proposalId = proposed.proposal.proposal_id;
    expect(proposed.proposal.author).toEqual(ROBOT);

    const preview = await call(`/api/rooms/r1/proposals/${proposalId}/preview`, { headers: auth() });
    expect(preview.status).toBe(200);
    const previewBytes = new Uint8Array(await preview.arrayBuffer());
    expect(preview.headers.get("x-wolf-sha256")).toBe(new Bun.CryptoHasher("sha256").update(previewBytes).digest("hex"));
    expect(preview.headers.get("x-wolf-sha256")).toBe(proposed.proposal.preview_sha256!);

    robot.send({ type: "proposal.decide", request_id: "d0", proposal_id: proposalId, decision: "approve" });
    const forbidden = await robot.next((e) => e.type === "error" && e.request_id === "d0");
    expect(forbidden.type === "error" && forbidden.code).toBe("FORBIDDEN");

    alice.send({ type: "proposal.decide", request_id: "d1", proposal_id: proposalId, decision: "approve" });
    const approved = await alice.next((e) => e.type === "proposal.updated" && e.proposal.status === "approved");
    expect(approved.type === "proposal.updated" && approved.proposal.proposal_id).toBe(proposalId);
    const second = await alice.next((e) => e.type === "doc.committed" && e.head.revision === 2);
    expect(second.type === "doc.committed" && second.entry.proposal_id).toBe(proposalId);
    expect(second.type === "doc.committed" && second.entry.approved_by).toEqual(ALICE);

    alice.send({ type: "comment.post", request_id: "c1", thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "@robot please check", mentions: [{ kind: "agent", id: "robot" }] });
    const thread = await robot.next((e) => e.type === "comment.updated");
    expect(thread.type === "comment.updated" && thread.thread.messages[0]?.body).toBe("@robot please check");

    alice.send({ type: "nonsense", request_id: "x1" });
    const refused = await alice.next((e) => e.type === "error" && e.request_id === "x1");
    expect(refused.type === "error" && refused.code).toBe("BAD_REQUEST");

    // A reconnect that names the last seq it saw gets only what came after.
    const lastSeq = Math.max(...alice.events.flatMap((e) => ("seq" in e ? [e.seq] : [])));
    alice.ws.close();
    robot.send({ type: "comment.post", request_id: "c2", thread_id: null, doc_name: "brief.docx", target_address: "p[2]", body: "Done.", mentions: [] });
    await robot.next((e) => e.type === "comment.updated" && e.thread.target_address === "p[2]");
    const back = await connect();
    back.send({ type: "room.join", request_id: "j3", room_id: "r1", since_seq: lastSeq });
    const missed = await back.next((e) => e.type === "comment.updated");
    expect(missed.type === "comment.updated" && missed.thread.target_address).toBe("p[2]");
    expect(back.events.some((e) => e.type === "room.snapshot")).toBe(false);
    robot.ws.close();
    back.ws.close();
  });

  test("ends the socket room subscription on seat release and lets the client join again", async () => {
    await start();
    await seedRoom();
    const robot = await connect("t-robot");
    robot.send({ type: "room.join", request_id: "j1", room_id: "r1", since_seq: null });
    await robot.next((e) => e.type === "room.snapshot");
    expect(room.releaseSeat("agent", "robot")).toBe(true);
    const kicked = await robot.next((e) => e.type === "error" && e.request_id === null);
    expect(kicked.type === "error" && kicked.code).toBe("LICENSE_LIMIT");
    robot.send({ type: "comment.post", request_id: "c1", thread_id: null, doc_name: "brief.docx", target_address: "p[1]", body: "after kick", mentions: [] });
    const notJoined = await robot.next((e) => e.type === "error" && e.request_id === "c1");
    expect(notJoined.type === "error" && notJoined.message).toContain("join a room first");
    robot.send({ type: "room.join", request_id: "j2", room_id: "r1", since_seq: null });
    await robot.next((e) => e.type === "room.snapshot" && robot.events.filter((x) => x.type === "room.snapshot").length === 2);
    robot.ws.close();
  });
});

describe("the MCP endpoint", () => {
  const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  const mcpPost = (body: unknown, headers: Record<string, string> = {}, query = "") =>
    fetch(`${server.mcpUrl}${query}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const initialize = rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });

  test("lists and calls the tools of the room the request names, as the agent of the token", async () => {
    await start();
    await seedRoom();
    const opened = await mcpPost(initialize, auth("t-robot"), "?room=r1");
    expect(opened.status).toBe(200);
    // serverInfo names the build: the version of @wolfsdk/workspace, not the MCP server default of 0.0.0.
    const initialized = (await opened.json()) as { result: { serverInfo: { name: string; version: string } } };
    expect(workspacePackage.version).not.toBe("0.0.0");
    expect(initialized.result.serverInfo).toEqual({ name: "wolf-workspace", version: workspacePackage.version });
    const session = opened.headers.get("mcp-session-id")!;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    const headers = { ...auth("t-robot"), "mcp-session-id": session };
    expect((await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, headers, "?room=r1")).status).toBe(202);

    const listed = (await (await mcpPost(rpc(2, "tools/list"), headers, "?room=r1")).json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((t) => t.name)).toEqual([
      "workspace_list",
      "doc_read",
      "doc_search",
      "doc_create",
      "doc_edit",
      "doc_inspect_visual",
      "pack_link_refresh",
      "comment_reply",
    ]);
    const workspace = (await (await mcpPost(rpc(3, "tools/call", { name: "workspace_list", arguments: {} }), headers, "?room=r1")).json()) as {
      result: { structuredContent: { room_id: string } };
    };
    expect(workspace.result.structuredContent.room_id).toBe("r1");
    const read = (await (await mcpPost(rpc(4, "tools/call", { name: "doc_read", arguments: { doc: "brief.docx", view: "text" } }), { ...headers, "x-wolf-room": "r1" })).json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(read.result.isError).toBeUndefined();
    expect(JSON.stringify(read.result.content)).toContain("Revenue grew in Q3.");

    // A single room needs no name.
    const implicit = (await (await mcpPost(rpc(5, "tools/call", { name: "workspace_list", arguments: {} }), headers)).json()) as { result: unknown };
    expect(implicit.result).toBeDefined();
  });

  test("refuses an unknown caller, a person, an unknown room and an ambiguous one", async () => {
    await start();
    expect((await mcpPost(initialize)).status).toBe(401);
    expect((await mcpPost(initialize, auth("wrong"))).status).toBe(401);
    expect((await mcpPost(initialize, auth("t-robot"))).status).toBe(400);
    await seedRoom();
    expect((await mcpPost(initialize, auth("t-alice"), "?room=r1")).status).toBe(403);
    expect((await mcpPost(initialize, auth("t-robot"), "?room=nope")).status).toBe(404);
    expect((await postJson("/api/rooms", { room_id: "r2" })).status).toBe(201);
    expect((await mcpPost(initialize, auth("t-robot"))).status).toBe(400);
    await server.stop();
    await start({ defaultRoom: "r2" });
    expect((await mcpPost(initialize, auth("t-robot"))).status).toBe(200);
  });
});

describe("the local engine channel", () => {
  test("serves modules and fonts with CORS, and nothing without --wasm-dir", async () => {
    await start();
    expect((await call("/wasm/latest.txt")).status).toBe(404);
    await server.stop();
    const wasmDir = join(dir, "wasm");
    await mkdir(join(wasmDir, "v1.2.3", "fonts"), { recursive: true });
    await writeFile(join(wasmDir, "latest.txt"), "1.2.3\n");
    await writeFile(join(wasmDir, "v1.2.3", "wolf_web.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(join(wasmDir, "v1.2.3", "SHA256SUMS"), "00  wolf_web.wasm\n");
    await writeFile(join(wasmDir, "v1.2.3", "fonts", "wolf_web_font_pack.json"), "{}");
    await start({ wasmDir });
    const latest = await call("/wasm/latest.txt");
    expect(await latest.text()).toBe("1.2.3\n");
    expect(latest.headers.get("access-control-allow-origin")).toBe("*");
    const module = await call("/wasm/v1.2.3/wolf_web.wasm");
    expect(module.headers.get("content-type")).toBe("application/wasm");
    expect((await call("/wasm/v1.2.3/SHA256SUMS")).headers.get("content-type")).toContain("text/plain");
    expect((await call("/wasm/v1.2.3/fonts/wolf_web_font_pack.json")).headers.get("content-type")).toBe("application/json");
    expect((await call("/wasm/%2e%2e/secret.txt")).status).toBe(404);
    expect((await call("/wasm/latest.txt", { method: "OPTIONS" })).status).toBe(204);
  });
});

describe("the read-only mark of the plan record", () => {
  const PAY = "https://cloud.example.test/billing/acme";
  const SINCE = "2026-11-28T09:30:00Z";
  const WORDS: Record<PlanReadOnlyReason, string> = {
    "trial-ended": "The trial ended on 2026-11-28.",
    "payment-failed": "A payment for the plan failed on 2026-11-28.",
    "plan-cancelled": "The plan was cancelled and ended on 2026-11-28.",
    chargeback: "The card issuer reversed a payment for the plan (a chargeback) on 2026-11-28.",
  };
  const UPGRADE = `To keep editing, pay at ${PAY}.`;
  const refusalOf = (reason: PlanReadOnlyReason) => ({ code: "LICENSE_LIMIT" as const, message: `workspace-read-only: ${WORDS[reason]} ${UPGRADE}` });
  const markOf = (reason: PlanReadOnlyReason): PlanReadOnly => ({ reason, since: SINCE, payUrl: PAY });
  /** The customer's plan record as the control plane holds it now: no mark is a read-write workspace. */
  let mark: PlanReadOnly | null = null;
  const planReadOnly = (): PlanReadOnly | null => mark;
  /** One call of each write tool: the refusal comes before the document, thread or pack is looked up. */
  const WRITE_TOOLS: [string, Record<string, unknown>][] = [
    ["doc_create", { name: "plan.docx", format: "docx" }],
    ["doc_edit", { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "No." }] }],
    ["comment_reply", { thread_id: "ghost", body: "No." }],
    ["pack_link_refresh", { pack: "ghost" }],
  ];
  const append = (text: string) => ({ ops: [{ op: "append_paragraph", text }] });
  /** The type and the fields of an event of either protocol of the socket. */
  const wire = (event: RoomServerEvent) => event as unknown as { type: string; task_id?: string; request_id?: string | null };

  type ToolAnswer = { isError?: boolean; structuredContent: Record<string, unknown> };

  /** An MCP session of the robot in room `r1`, and a function that calls one tool in it. */
  async function mcpSession(): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolAnswer>> {
    const post = (body: unknown, headers: Record<string, string>) =>
      fetch(`${server.mcpUrl}?room=r1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    const opened = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, auth("t-robot"));
    expect(opened.status).toBe(200);
    const headers = { ...auth("t-robot"), "mcp-session-id": opened.headers.get("mcp-session-id")! };
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
    let id = 1;
    return async (name, args) => ((await (await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, headers)).json()) as { result: ToolAnswer }).result;
  }

  /** Signing in, reading, searching, downloading and exporting, for the user and for the agent. */
  async function expectReadable(tool: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>): Promise<void> {
    for (const [token, actor] of [["t-alice", ALICE], ["t-robot", ROBOT]] as const) {
      expect(((await (await call("/api/me", { headers: auth(token) })).json()) as { actor: RoomActor }).actor).toEqual(actor);
      const state = (await (await call("/api/rooms/r1", { headers: auth(token) })).json()) as { documents: { head: { name: string; revision: number } }[] };
      expect(state.documents.map((d) => [d.head.name, d.head.revision])).toEqual([["brief.docx", 0]]);
      const download = await call("/api/rooms/r1/docs/brief.docx/head", { headers: auth(token) });
      expect(download.status).toBe(200);
      expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
      const exported = await call("/api/export", { headers: auth(token) });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("application/zip");
      expect((await exported.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const read = await tool("doc_read", { doc: "brief.docx", view: "text" });
    expect(read.isError).toBeUndefined();
    expect(JSON.stringify(read.structuredContent)).toContain("Revenue grew in Q3.");
    const found = await tool("doc_search", { query: "Revenue" });
    expect(found.isError).toBeUndefined();
    expect(JSON.stringify(found.structuredContent)).toContain("Revenue grew in Q3.");
  }

  test("words each reason with its day and the page to pay on, and refuses a mark that is not one", () => {
    expect(PLAN_READ_ONLY_REASONS).toEqual(["trial-ended", "payment-failed", "plan-cancelled", "chargeback"]);
    for (const reason of PLAN_READ_ONLY_REASONS) expect(planReadOnlyMode(markOf(reason))).toEqual({ reason: WORDS[reason], upgrade: UPGRADE });
    // The day is the day of the instant in UTC.
    expect(planReadOnlyMode({ ...markOf("trial-ended"), since: "2026-11-28T23:30:00-08:00" }).reason).toBe("The trial ended on 2026-11-29.");
    for (const bad of [
      { ...markOf("trial-ended"), reason: "storage-limit" as PlanReadOnlyReason },
      { ...markOf("trial-ended"), since: "soon" },
      { ...markOf("trial-ended"), payUrl: "/billing" },
      { ...markOf("trial-ended"), payUrl: "javascript:alert(1)" },
      { ...markOf("trial-ended"), payUrl: `https://cloud.example.test/${"x".repeat(300)}` },
    ]) {
      expect(() => planReadOnlyMode(bad)).toThrow(TypeError);
    }
  });

  test("refuses the four write paths, for a user and for an agent, with each reason on the record, and serves them again once paid without a restart", async () => {
    mark = null;
    await start({ planReadOnly });
    await seedRoom();
    const alice = await connect("t-alice");
    const robot = await connect("t-robot");
    for (const socket of [alice, robot]) {
      socket.send({ type: "room.join", request_id: "join", room_id: "r1", since_seq: null });
      await socket.next((e) => e.type === "room.snapshot");
    }
    // Opened while the workspace was read-write: the session lives through every change of the record.
    const tool = await mcpSession();

    for (const reason of PLAN_READ_ONLY_REASONS) {
      mark = markOf(reason);
      const refusal = refusalOf(reason);
      for (const token of ["t-alice", "t-robot"]) {
        // Creating a room.
        const created = await postJson("/api/rooms", { room_id: `r-${reason}`, workspace_id: "ws" }, token);
        expect(created.status).toBe(402);
        expect(await created.json()).toEqual({ error: refusal });
        // Adding a document.
        const added = await call(`/api/rooms/r1/docs?name=${reason}.docx`, { method: "POST", headers: auth(token), body: word(["No."]) });
        expect(added.status).toBe(402);
        expect(await added.json()).toEqual({ error: refusal });
      }
      // Messages on a room's socket.
      for (const [who, socket] of [["alice", alice], ["robot", robot]] as const) {
        const requestId = `${who}-${reason}`;
        socket.send({ type: "doc.edit", request_id: requestId, doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: append("No.") });
        expect(await socket.next((e) => e.type === "error" && e.request_id === requestId)).toEqual({ type: "error", request_id: requestId, ...refusal });
      }
      // An agent's tools over MCP.
      for (const [name, args] of WRITE_TOOLS) {
        const answer = await tool(name, args);
        expect(answer.isError).toBe(true);
        expect(answer.structuredContent.error).toEqual(refusal);
      }
      // The client is told why and where to pay; everything that does not write keeps working.
      expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE, readOnly: { reason: WORDS[reason], upgrade: UPGRADE } });
      await expectReadable(tool);
    }
    const rooms = (await (await call("/api/rooms", { headers: auth() })).json()) as { rooms: { room_id: string }[] };
    expect(rooms.rooms.map((r) => r.room_id)).toEqual(["r1"]);
    expect(alice.events.some((e) => e.type === "doc.committed" || e.type === "doc.added" || e.type === "proposal.updated")).toBe(false);

    // The customer pays: the record loses its mark, and the same server, sockets and session write again.
    mark = null;
    expect(await (await call("/api/me", { headers: auth() })).json()).toEqual({ actor: ALICE });
    expect((await postJson("/api/rooms", { room_id: "r2", workspace_id: "ws" })).status).toBe(201);
    expect((await call("/api/rooms/r1/docs?name=second.docx", { method: "POST", headers: auth("t-robot"), body: word(["two"]) })).status).toBe(201);
    alice.send({ type: "doc.edit", request_id: "paid", doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: append("Paid.") });
    expect(await alice.next((e) => e.type === "doc.committed")).toMatchObject({ entry: { author: ALICE } });
    const proposed = await tool("doc_edit", { doc: "brief.docx", base_revision: 1, mode: "propose", ops: [{ op: "append_paragraph", text: "From the agent." }] });
    expect(proposed.isError).toBeUndefined();
    expect(proposed.structuredContent.mode).toBe("propose");
    for (const socket of [alice, robot]) socket.ws.close();
  });

  test("refuses the write tools the assistant calls for a user, with each reason, and lets it write once paid", async () => {
    type Reply = { text?: string; tools?: { name: string; arguments: unknown }[] };
    type Sent = { messages: { role: string; content: unknown }[] };
    const sent: Sent[] = [];
    const edit = { name: "doc_edit", arguments: { doc: "brief.docx", base_revision: 0, mode: "commit", ops: [{ op: "append_paragraph", text: "Outlook: steady." }] } };
    const script: Reply[] = [...PLAN_READ_ONLY_REASONS.flatMap((): Reply[] => [{ tools: [edit] }, { text: "The workspace is read-only." }]), { tools: [edit] }, { text: "Proposed." }];
    // A model that answers from the script, as an OpenAI-compatible stream, and keeps what it was sent.
    const scripted = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const n = sent.length;
      sent.push(JSON.parse(String(init?.body)) as Sent);
      const reply = script[n];
      if (reply === undefined) throw new Error(`the script has no answer for model call ${n + 1}`);
      const chunks: unknown[] = [];
      if (reply.text) chunks.push({ choices: [{ delta: { content: reply.text } }] });
      (reply.tools ?? []).forEach((t, index) => {
        chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${n}_${index}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } }] } }] });
      });
      chunks.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
      chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      return new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
    };
    /** What the tool answered in the task of model call `n`, as the model was given it. */
    const toolAnswer = (n: number): string => String(sent[n]?.messages.find((m) => m.role === "tool")?.content);

    // As `serve` composes it: the agent of the assistant acts on the seat of the user it works for.
    await room.close();
    room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new MemoryEngine(), operatorOf: (agent) => server?.assistant.operatorOf(agent) ?? null });
    mark = null;
    await start({
      planReadOnly,
      assistant: { endpoint: { url: "https://model.invalid/v1/chat/completions", model: "open-model-1", key: "placeholder" }, allowance: null, storePath: join(dir, "assistant.sqlite"), fetch: scripted as typeof fetch },
    });
    await seedRoom();
    const alice = await connect();
    alice.send({ type: "room.join", request_id: "join", room_id: "r1", since_seq: null });
    await alice.next((e) => e.type === "room.snapshot");
    const finished = new Set<string>();
    const ask = async (requestId: string): Promise<void> => {
      alice.send({ type: "assistant.ask", request_id: requestId, conversation_id: null, text: "Add a closing line", doc_name: "brief.docx", target_address: null });
      const done = wire(await alice.next((e) => wire(e).type === "assistant.task.finished" && !finished.has(wire(e).task_id ?? "")));
      finished.add(done.task_id ?? "");
    };

    for (const [i, reason] of PLAN_READ_ONLY_REASONS.entries()) {
      mark = markOf(reason);
      await ask(`a-${reason}`);
      expect(toolAnswer(2 * i + 1)).toContain(refusalOf(reason).message);
    }
    expect(alice.events.some((e) => e.type === "doc.committed" || e.type === "proposal.updated")).toBe(false);

    mark = null;
    await ask("a-paid");
    const answer = JSON.parse(toolAnswer(2 * PLAN_READ_ONLY_REASONS.length + 1)) as { error?: unknown; mode?: string };
    expect(answer.error).toBeUndefined();
    expect(answer.mode).toBe("propose");
    alice.ws.close();
  });
});
