// The unified port of `serve`: the UI, the API, the room WebSocket and the MCP endpoint answer on one
// `Bun.serve`, over a real room server on a temporary directory with the in-memory engine of the MCP tests.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactorPipeRequest, RoomActor, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker, RoomServer, type WorkerPool } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { binding, docx, manifest, manifestBytes, QUARTERS, xlsx } from "../../packs/test/fixtures.ts";
import { formatOfName, resolveInside, type SnapshotInput, startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";
import { engineSnapshot } from "../src/run.ts";

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
