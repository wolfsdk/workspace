// The share link of a document over the real HTTP handler: a member makes, reads and ends it; anyone who holds the
// token reads what the document is and its painted pages with no credentials and no seat; nothing else answers
// without a token.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { RoomServer } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import { SHARE_VIEWER, type Share, type SnapshotInput, startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";

// Writes are flushed to disk: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const TOKENS = new Map<string, RoomActor>([
  ["t-alice", ALICE],
  ["t-robot", ROBOT],
]);
const PAGES = [{ cmd: "display_list", ok: true, ms: 0, page: 1 }];
const SHARE_URL = "/api/rooms/r1/docs/brief.docx/share";
const INDEX_HTML = "<!doctype html><title>Wolf Workspace</title><div id=app></div>";

let dir: string;
let room: RoomServer;
let server: WorkspaceServer;
let rendered: SnapshotInput[];

async function start(options: Partial<WorkspaceServerOptions> = {}): Promise<void> {
  server = startWorkspaceServer({
    service: room,
    shares: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    staticDir: join(dir, "ui"),
    snapshot: async (input) => {
      rendered.push(input);
      return PAGES;
    },
    ...options,
  });
}

const auth = (token = "t-alice"): Record<string, string> => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${server.url}${path}`, init);
const as = (method: string, path: string, token = "t-alice", body?: unknown): Promise<Response> =>
  call(path, { method, headers: { ...auth(token), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-share-"));
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(join(dir, "ui", "index.html"), INDEX_HTML);
  rendered = [];
  room = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new MemoryEngine(),
    seatless: (actor) => actor === SHARE_VIEWER,
  });
  await start();
  expect((await as("POST", "/api/rooms", "t-alice", { room_id: "r1", workspace_id: "ws" })).status).toBe(201);
  const upload = await call("/api/rooms/r1/docs?name=brief.docx", { method: "POST", headers: auth(), body: new Uint8Array(wordDocument(["Quarterly brief", "Revenue grew in Q3."])) });
  expect(upload.status).toBe(201);
});

afterEach(async () => {
  await server?.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

/** The live link of `brief.docx`, made by Alice. */
async function share(): Promise<Share> {
  const made = await as("PUT", SHARE_URL);
  expect(made.status).toBe(200);
  return ((await made.json()) as { share: Share }).share;
}

describe("a member's share link", () => {
  test("is made once, read, and ended", async () => {
    expect(await (await as("GET", SHARE_URL)).json()).toEqual({ share: null });

    const link = await share();
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ path: `/s/${link.token}`, room_id: "r1", doc_name: "brief.docx", created_by: ALICE });
    expect(Number.isNaN(Date.parse(link.created_at))).toBe(false);

    // Asking again answers the live link rather than making another.
    expect(await share()).toEqual(link);
    expect(await (await as("GET", SHARE_URL)).json()).toEqual({ share: link });

    expect((await as("DELETE", SHARE_URL)).status).toBe(204);
    expect(await (await as("GET", SHARE_URL)).json()).toEqual({ share: null });
    // Sharing again makes a different link: the ended token never comes back.
    expect((await share()).token).not.toBe(link.token);
  });

  test("needs a member who is a user, and a document that exists", async () => {
    expect((await call(SHARE_URL, { method: "PUT" })).status).toBe(401);
    expect((await as("PUT", SHARE_URL, "wrong")).status).toBe(401);
    const refused = await as("PUT", SHARE_URL, "t-robot");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect((await as("GET", SHARE_URL, "t-robot")).status).toBe(403);
    expect((await as("DELETE", SHARE_URL, "t-robot")).status).toBe(403);
    expect(await (await as("GET", SHARE_URL)).json()).toEqual({ share: null });

    expect((await as("PUT", "/api/rooms/r1/docs/none.docx/share")).status).toBe(404);
    expect((await as("PUT", "/api/rooms/nope/docs/brief.docx/share")).status).toBe(404);
  });
});

describe("the public routes of a link", () => {
  test("tell anyone with the token what the document is, with no credentials and no seat", async () => {
    const link = await share();
    const seats = room.listSeats().length;

    const read = await call(`/api/share/${link.token}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const { share: shown } = (await read.json()) as { share: Record<string, unknown> };
    expect(shown).toEqual({
      room_id: "r1",
      doc_name: "brief.docx",
      format: "docx",
      revision: 0,
      updated_at: expect.any(String),
      shared_by: "Alice",
      connect: null,
    });
    // The metadata names the document and who shared it and nothing that identifies a member.
    expect(JSON.stringify(shown)).not.toContain("alice");
    expect(room.listSeats()).toHaveLength(seats);
    expect(room.listSeats().some((s) => s.id === SHARE_VIEWER.id)).toBe(false);
  });

  test("serve the painted pages of the head with its ETag, and 304 for a client that holds them", async () => {
    const link = await share();
    const url = `/api/share/${link.token}/snapshot`;
    const head = await as("GET", "/api/rooms/r1/docs/brief.docx/head");
    const sha256 = head.headers.get("x-wolf-sha256")!;

    const read = await call(url);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ pages: PAGES });
    expect(read.headers.get("etag")).toBe(`"sha256:${sha256}"`);
    expect(read.headers.get("x-wolf-revision")).toBe("0");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ format: "docx", name: "brief.docx" });

    const again = await call(url, { headers: { "if-none-match": `"sha256:${sha256}"` } });
    expect(again.status).toBe(304);
    expect(rendered).toHaveLength(1);
    expect(room.listSeats().some((s) => s.id === SHARE_VIEWER.id)).toBe(false);
  });

  test("answer 501 for the pages while the server cannot render them, as the member route does", async () => {
    await server.stop();
    await start({ snapshot: undefined });
    const link = await share();
    const missing = await call(`/api/share/${link.token}/snapshot`);
    expect(missing.status).toBe(501);
    expect(await missing.json()).toMatchObject({ error: { code: "NO_SNAPSHOT" } });
  });

  test("answer 404 SHARE_NOT_FOUND for an unknown token and for an ended one, with the same body", async () => {
    const link = await share();
    expect((await call(`/api/share/${link.token}`)).status).toBe(200);
    expect((await as("DELETE", SHARE_URL)).status).toBe(204);

    const unknown = `${link.token.slice(0, 40)}abc`;
    const bodies: unknown[] = [];
    for (const path of [`/api/share/${link.token}`, `/api/share/${link.token}/snapshot`, `/api/share/${unknown}`, `/api/share/${unknown}/snapshot`, "/api/share/short", "/api/share/%00"]) {
      const answer = await call(path);
      expect(answer.status).toBe(404);
      bodies.push(await answer.json());
    }
    expect(bodies[0]).toMatchObject({ error: { code: "SHARE_NOT_FOUND" } });
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(rendered).toEqual([]);
  });

  test("carry the instructions path of the server, once it has one, as `<path>?share=<token>`", async () => {
    await server.stop();
    await start({ shareConnect: "/-/connect/instructions" });
    const link = await share();
    const { share: shown } = (await (await call(`/api/share/${link.token}`)).json()) as { share: { connect: string | null } };
    expect(shown.connect).toBe(`/-/connect/instructions?share=${link.token}`);
  });

  test("can be ended, and not made, once the workspace is read-only", async () => {
    const link = await share();
    await server.stop();
    await room.close();
    const mode = { reason: "The trial ended.", upgrade: "https://cloud.example.test/upgrade" };
    room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new MemoryEngine(), seatless: (actor) => actor === SHARE_VIEWER, readOnly: mode });
    await start({ readOnly: mode });
    expect((await call(`/api/share/${link.token}`)).status).toBe(200);
    expect((await as("PUT", "/api/rooms/r1/docs/other.docx/share")).status).toBe(402);
    expect((await as("DELETE", SHARE_URL)).status).toBe(204);
    expect((await call(`/api/share/${link.token}`)).status).toBe(404);
  });

  test("answer 404 SHARE_NOT_FOUND when the server keeps no links", async () => {
    await server.stop();
    await start({ shares: undefined });
    const answer = await call(`/api/share/${"a".repeat(43)}`);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "SHARE_NOT_FOUND" } });
    expect((await as("GET", SHARE_URL)).status).toBe(404);
  });

  test("ignore every claim of identity a caller makes", async () => {
    const link = await share();
    // A bearer token of an agent changes nothing on the public route, and a wrong one does not refuse it.
    for (const headers of [auth("t-robot"), auth("wrong"), { "x-wolf-actor": "alice", "x-forwarded-user": "alice" }]) {
      const read = await call(`/api/share/${link.token}`, { headers });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { share: { shared_by: string } }).share.shared_by).toBe("Alice");
    }
  });
});

describe("everything else still needs a token", () => {
  test("answers 401 on every other API route, and on the public path with another method or tail", async () => {
    const link = await share();
    const routes: [string, string][] = [
      ["GET", "/api/me"],
      ["GET", "/api/rooms"],
      ["POST", "/api/rooms"],
      ["GET", "/api/rooms/r1"],
      ["GET", SHARE_URL],
      ["DELETE", SHARE_URL],
      ["GET", "/api/rooms/r1/docs/brief.docx/head"],
      ["GET", "/api/rooms/r1/docs/brief.docx/snapshot"],
      ["GET", "/api/export"],
      ["POST", "/api/pack"],
      ["POST", `/api/share/${link.token}`],
      ["DELETE", `/api/share/${link.token}`],
      ["GET", `/api/share/${link.token}/head`],
      ["GET", `/api/share/${link.token}/snapshot/extra`],
    ];
    for (const [method, path] of routes) expect([method, path, (await call(path, { method })).status]).toEqual([method, path, 401]);
    expect((await fetch(server.mcpUrl, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/ws")).status).toBe(401);
  });

  test("serves a share page `/s/<token>` as the single-page app, with no credentials", async () => {
    const link = await share();
    const page = await call(`/s/${link.token}`, { headers: { accept: "text/html" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX_HTML);
  });
});
