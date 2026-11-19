// `GET /api/export` of `serve`: every document of one workspace, at its head, in one archive with a manifest that names
// each room, document and revision. The archive is unpacked here by a reader of its own (central directory, local
// headers, CRC-32) and each file is compared byte for byte with the head the server serves for that document, for a
// user and for an agent, in a writable and in a read-only workspace. A caller from another workspace is refused:
// one the room service keeps out of this workspace's rooms (403), and one whose token belongs to another workspace's
// server (401).
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { type ReadOnlyMode, type Result, RoomServer } from "@wolfsdk/server";
import { MemoryEngine, wordDocument } from "../../mcp/test/fixtures/memory-engine.ts";
import type { PlanReadOnly } from "../src/errors.ts";
import { startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";

setDefaultTimeout(240_000);

const ALICE: RoomActor = { kind: "user", id: "alice", name: "Alice" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const BOB: RoomActor = { kind: "user", id: "bob", name: "Bob" };
const TOKENS = new Map<string, RoomActor>([
  ["t-alice", ALICE],
  ["t-robot", ROBOT],
  ["t-bob", BOB],
]);
/** Who belongs to which workspace, and which workspace each room is in: what the `authorize` hook decides from. */
const MEMBER_OF: Record<string, string> = { alice: "acme", robot: "acme", bob: "globex" };
const ROOM_OF: Record<string, string> = { r1: "acme", r2: "acme", g1: "globex" };
const authorize = (actor: RoomActor, _action: string, roomId: string): boolean => MEMBER_OF[actor.id] !== undefined && MEMBER_OF[actor.id] === ROOM_OF[roomId];

const MODE: ReadOnlyMode = { reason: "The trial ended on 2026-11-28.", upgrade: "https://cloud.example.test/upgrade" };
const MARK: PlanReadOnly = { reason: "trial-ended", since: "2026-11-28T00:00:00Z", payUrl: "https://cloud.example.test/pay" };
const ORIGINAL_BRIEF = ["Quarterly brief", "Revenue grew in Q3."];
const word = (lines: string[]): Uint8Array<ArrayBuffer> => new Uint8Array(wordDocument(lines));

/** The documents of workspace `acme`, by room, in the manifest's order, at the revisions the seed leaves. */
const ACME = [
  { room_id: "r1", documents: [{ name: "brief.docx", revision: 1, path: "r1/brief.docx" }, { name: "notes.docx", revision: 0, path: "r1/notes.docx" }] },
  { room_id: "r2", documents: [{ name: "plan.docx", revision: 2, path: "r2/plan.docx" }] },
];
const GLOBEX = [{ room_id: "g1", documents: [{ name: "secret.docx", revision: 0, path: "g1/secret.docx" }] }];

let dir: string;
let rooms: RoomServer;
let server: WorkspaceServer;
let proposalId: string;
/** Every server and room service a test started, stopped after it. */
const started: { rooms: RoomServer; server: WorkspaceServer }[] = [];

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const open = (at: string, readOnly?: ReadOnlyMode): RoomServer =>
  new RoomServer({ dbPath: join(at, "rooms.sqlite"), blobDir: join(at, "blobs"), engine: new MemoryEngine(), authorize, ...(readOnly ? { readOnly } : {}) });

function serve(service: RoomServer, tokens: ReadonlyMap<string, RoomActor>, options: Partial<WorkspaceServerOptions> = {}): WorkspaceServer {
  const served = startWorkspaceServer({
    service,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (tokens.get(token) ?? null);
    },
    ...options,
  });
  started.push({ rooms: service, server: served });
  return served;
}

/** One server that holds two workspaces: `acme` (rooms `r1` and `r2`, three documents, two of them committed to and
 * one with an open proposal of the robot) and `globex` (room `g1`). The files are then opened again, read-only when
 * `readOnly` is given, and served with `options`. */
async function seeded(readOnly?: ReadOnlyMode, options: Partial<WorkspaceServerOptions> = {}): Promise<void> {
  const writable = open(dir);
  must(await writable.createRoom(ALICE, { room_id: "r1", workspace_id: "acme" }));
  must(await writable.addDocument("r1", ALICE, { name: "brief.docx", format: "docx", bytes: word(ORIGINAL_BRIEF) }));
  must(await writable.edit("r1", ALICE, { doc_name: "brief.docx", base_revision: 0, mode: "commit", batch: { ops: [{ op: "append_paragraph", text: "Committed." }] } }));
  must(await writable.addDocument("r1", ALICE, { name: "notes.docx", format: "docx", bytes: word(["Notes"]) }));
  must(await writable.createRoom(ALICE, { room_id: "r2", workspace_id: "acme" }));
  must(await writable.addDocument("r2", ROBOT, { name: "plan.docx", format: "docx", bytes: word(["Plan"]) }));
  for (const [revision, text] of [[0, "Step one."], [1, "Step two."]] as const) {
    must(await writable.edit("r2", ROBOT, { doc_name: "plan.docx", base_revision: revision, mode: "commit", batch: { ops: [{ op: "append_paragraph", text }] } }));
  }
  must(await writable.createRoom(BOB, { room_id: "g1", workspace_id: "globex" }));
  must(await writable.addDocument("g1", BOB, { name: "secret.docx", format: "docx", bytes: word(["Globex only"]) }));
  const proposal = must(await writable.edit("r1", ROBOT, { doc_name: "brief.docx", base_revision: 1, mode: "propose", batch: { ops: [{ op: "append_paragraph", text: "Proposed." }] } }));
  if (proposal.mode !== "propose") throw new Error("the robot's edit was not held as a proposal");
  proposalId = proposal.proposal.proposal_id;
  await writable.close();

  rooms = open(dir, readOnly);
  server = serve(rooms, TOKENS, { ...(readOnly ? { readOnly } : {}), ...options });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "workspace-export-"));
});

afterEach(async () => {
  for (const { rooms: service, server: served } of started.splice(0)) {
    await served.stop();
    await service.close();
  }
  await rm(dir, { recursive: true, force: true });
});

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const get = (base: WorkspaceServer, path: string, token?: string): Promise<Response> => fetch(`${base.url}${path}`, token === undefined ? {} : { headers: auth(token) });

/** The files of a ZIP archive whose entries are stored, as `serve` writes them, read the way an unzip tool does: from
 * the end-of-central-directory record to each central entry, then to its local header and its bytes, whose CRC-32 and
 * size must be the ones the directory records. Anything else in the archive fails the test. */
function unpack(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const names = new TextDecoder("utf-8", { fatal: true });
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  const directorySize = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  expect(at + directorySize).toBe(end);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    expect(view.getUint32(at + 20, true)).toBe(size);
    const nameLength = view.getUint16(at + 28, true);
    const name = names.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const local = view.getUint32(at + 42, true);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(local + 26, true);
    expect(names.decode(zip.subarray(local + 30, local + 30 + localNameLength))).toBe(name);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    const bytes = zip.slice(start, start + size);
    expect(bytes.byteLength).toBe(size);
    expect(Bun.hash.crc32(bytes) >>> 0).toBe(crc);
    expect(files.has(name)).toBe(false);
    files.set(name, bytes);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  expect(at).toBe(end);
  return files;
}

type Manifest = {
  format: string;
  exported_at: string;
  rooms: { room_id: string; workspace_id: string; documents: { name: string; path: string; format: string; revision: number; sha256: string; size: number }[] }[];
};

/** Export `workspace` as `token` from `base` (naming it with `?workspace=` when `named`), unpack the archive, and check
 * it against the server: the manifest names each room, document and revision of `expected` and nothing else, the
 * archive holds exactly those files and the manifest, and each file is byte for byte the head `GET .../head` serves the
 * same caller, at the revision and digest the manifest records. Returns the files. */
async function expectExport(base: WorkspaceServer, token: string, workspace: string, expected: typeof ACME, named = true): Promise<Map<string, Uint8Array>> {
  const response = await get(base, named ? `/api/export?workspace=${workspace}` : "/api/export", token);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("x-wolf-workspace")).toBe(workspace);
  const files = unpack(new Uint8Array(await response.arrayBuffer()));
  const manifestBytes = files.get("manifest.json");
  expect(manifestBytes).toBeDefined();
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  expect(manifest.format).toBe("wolfsdk.workspace.export.v1");
  expect(manifest.rooms.map((room) => ({ room_id: room.room_id, documents: room.documents.map(({ name, revision, path }) => ({ name, revision, path })) }))).toEqual(expected);
  expect(manifest.rooms.every((room) => room.workspace_id === workspace)).toBe(true);
  expect([...files.keys()].sort()).toEqual([...expected.flatMap((room) => room.documents.map((d) => d.path)), "manifest.json"].sort());
  for (const room of manifest.rooms) {
    for (const document of room.documents) {
      const file = files.get(document.path)!;
      const head = await get(base, `/api/rooms/${room.room_id}/docs/${encodeURIComponent(document.name)}/head`, token);
      expect(head.status).toBe(200);
      expect(file).toEqual(new Uint8Array(await head.arrayBuffer()));
      expect(head.headers.get("x-wolf-revision")).toBe(String(document.revision));
      expect(head.headers.get("x-wolf-sha256")).toBe(document.sha256);
      expect(new Bun.CryptoHasher("sha256").update(file).digest("hex")).toBe(document.sha256);
      expect(file.byteLength).toBe(document.size);
    }
  }
  return files;
}

describe("GET /api/export", () => {
  test("a user and an agent each get every document of their workspace, byte for byte its head, with a manifest naming each room, document and revision", async () => {
    await seeded();
    for (const token of ["t-alice", "t-robot"]) {
      const files = await expectExport(server, token, "acme", ACME);
      // The current file: the committed edit is in it, the robot's open proposal is not.
      expect(files.get("r1/brief.docx")).not.toEqual(word(ORIGINAL_BRIEF));
      const preview = await get(server, `/api/rooms/r1/proposals/${proposalId}/preview`, token);
      expect(preview.status).toBe(200);
      expect(files.get("r1/brief.docx")).not.toEqual(new Uint8Array(await preview.arrayBuffer()));
    }
    // The server holds two workspaces and was given none of its own: the request names one.
    const unnamed = await get(server, "/api/export", "t-alice");
    expect(unnamed.status).toBe(400);
    expect(((await unnamed.json()) as { error: { code: string; message: string } }).error.message).toContain("?workspace=");
  });

  test("exports the server's own workspace when the request names none", async () => {
    await seeded(undefined, { workspaceId: "acme" });
    await expectExport(server, "t-robot", "acme", ACME, false);
    await expectExport(server, "t-alice", "acme", ACME, false);
  });

  test("works in the read-only state, fixed or from the plan record, for the user and the agent", async () => {
    await seeded(MODE);
    const fixed = await get(server, "/api/me", "t-alice");
    expect(((await fixed.json()) as { readOnly?: ReadOnlyMode }).readOnly).toEqual(MODE);
    const refused = await fetch(`${server.url}/api/rooms`, { method: "POST", headers: { ...auth("t-alice"), "content-type": "application/json" }, body: JSON.stringify({ room_id: "r3", workspace_id: "acme" }) });
    expect(refused.status).toBe(402);
    for (const token of ["t-alice", "t-robot"]) await expectExport(server, token, "acme", ACME);

    // The plan record's mark, over a room service that is not read-only itself. The room files are the first
    // service's until it closes.
    await server.stop();
    await rooms.close();
    started.splice(0, 1);
    let mark: PlanReadOnly | null = MARK;
    const planned = serve(open(dir), TOKENS, { planReadOnly: () => mark, workspaceId: "acme" });
    const marked = await fetch(`${planned.url}/api/rooms/r1/docs?name=extra.docx`, { method: "POST", headers: auth("t-robot"), body: word(["No."]) });
    expect(marked.status).toBe(402);
    expect(((await (await get(planned, "/api/me", "t-robot")).json()) as { readOnly?: ReadOnlyMode }).readOnly?.upgrade).toContain(MARK.payUrl);
    for (const token of ["t-alice", "t-robot"]) await expectExport(planned, token, "acme", ACME, false);
    // Paid: the same export, from the same server, without a restart.
    mark = null;
    await expectExport(planned, "t-alice", "acme", ACME, false);
  });

  test("a caller from another workspace is refused, and its own export holds nothing of this one", async () => {
    await seeded();
    // A member of globex on the same server: the rooms of acme are not its to read, so neither is their export.
    const refused = await get(server, "/api/export?workspace=acme", "t-bob");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toBe("application/json");
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    const reverse = await get(server, "/api/export?workspace=globex", "t-robot");
    expect(reverse.status).toBe(403);
    // Its own workspace exports, and nothing of acme is in it.
    await expectExport(server, "t-bob", "globex", GLOBEX);
    // No token, an unknown token, a workspace the server holds nothing of, a name that is not an id.
    expect((await get(server, "/api/export?workspace=acme")).status).toBe(401);
    expect((await get(server, "/api/export?workspace=acme", "t-mallory")).status).toBe(401);
    const unknown = await get(server, "/api/export?workspace=initech", "t-alice");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("UNKNOWN_WORKSPACE");
    expect((await get(server, "/api/export?workspace=..%2Facme", "t-alice")).status).toBe(400);

    // The hosted shape: each workspace is its own server with its own tokens. A token of acme's server means nothing
    // on globex's, and globex's export is globex alone.
    const other = await mkdtemp(join(tmpdir(), "workspace-export-other-"));
    try {
      const seed = open(other);
      must(await seed.createRoom(BOB, { room_id: "g1", workspace_id: "globex" }));
      must(await seed.addDocument("g1", BOB, { name: "secret.docx", format: "docx", bytes: word(["Globex only"]) }));
      const globex = serve(seed, new Map([["t-bob", BOB]]));
      for (const token of ["t-alice", "t-robot"]) {
        const answer = await get(globex, "/api/export", token);
        expect(answer.status).toBe(401);
        expect(answer.headers.get("content-type")).toBe("application/json");
      }
      await expectExport(globex, "t-bob", "globex", GLOBEX, false);
    } finally {
      for (const { rooms: service, server: served } of started.splice(1)) {
        await served.stop();
        await service.close();
      }
      await rm(other, { recursive: true, force: true });
    }
  });
});
