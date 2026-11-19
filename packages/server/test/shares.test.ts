// Share links: one live link per document, kept in the room database, ended for good by `unshare`.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoolEngine, type ReadOnlyMode, RoomServer } from "../src/index.ts";
import { alice, bytesOf, makePool, must, refusalOf, steppingClock } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const DOC = "doc.docx";
const MODE: ReadOnlyMode = { reason: "The trial ended.", upgrade: "https://cloud.example.test/upgrade" };

let dir: string | undefined;
let server: RoomServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Start a server on the files of `dir` (created on the first call). Calling it again closes the running server and
 * starts another on the same files: a restart. */
async function start(readOnly?: ReadOnlyMode): Promise<RoomServer> {
  await server?.close();
  dir ??= await mkdtemp(join(tmpdir(), "wolfsdk-shares-"));
  server = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new PoolEngine(makePool()),
    now: steppingClock(),
    readOnly,
  });
  return server;
}

async function seeded(): Promise<RoomServer> {
  const s = await start();
  must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  must(await s.addDocument("room", alice, { name: DOC, format: "docx", bytes: bytesOf("hello") }));
  must(await s.addDocument("room", alice, { name: "other.docx", format: "docx", bytes: bytesOf("other") }));
  return s;
}

describe("a share link", () => {
  test("is 32 random bytes in base64url, one per document, and the same one when shared again", async () => {
    const s = await seeded();
    expect(s.shareOf("room", DOC)).toBeNull();
    const made = must(await s.share("room", DOC, alice));
    expect(made.existed).toBe(false);
    expect(made.link).toMatchObject({ room_id: "room", doc_name: DOC, created_by: alice });
    expect(made.link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(made.link.token, "base64url").length).toBe(32);

    const again = must(await s.share("room", DOC, alice));
    expect(again).toEqual({ link: made.link, existed: true });
    expect(s.shareOf("room", DOC)).toEqual(made.link);
    expect(s.resolveShare(made.link.token)).toEqual(made.link);
    // Another document has a link of its own.
    const other = must(await s.share("room", "other.docx", alice));
    expect(other.existed).toBe(false);
    expect(other.link.token).not.toBe(made.link.token);
  });

  test("survives closing and reopening the server on the same database", async () => {
    const first = await seeded();
    const { link } = must(await first.share("room", DOC, alice));
    const second = await start();
    expect(second.resolveShare(link.token)).toEqual(link);
    expect(must(await second.share("room", DOC, alice))).toEqual({ link, existed: true });
  });

  test("is added to a database that was made before links existed", async () => {
    const first = await seeded();
    await first.close();
    server = undefined;
    const raw = new Database(join(dir ?? "", "rooms.sqlite"));
    raw.exec("DROP TABLE shares");
    raw.close();
    const s = await start();
    const { link } = must(await s.share("room", DOC, alice));
    expect((await start()).resolveShare(link.token)).toEqual(link);
  });

  test("ends for good with unshare, and a later share makes a new token", async () => {
    const s = await seeded();
    const { link } = must(await s.share("room", DOC, alice));
    expect(s.unshare("room", DOC)).toBe(true);
    expect(s.resolveShare(link.token)).toBeNull();
    expect(s.shareOf("room", DOC)).toBeNull();
    expect(s.unshare("room", DOC)).toBe(false);

    const next = must(await s.share("room", DOC, alice));
    expect(next.existed).toBe(false);
    expect(next.link.token).not.toBe(link.token);
    expect(s.resolveShare(link.token)).toBeNull();
    expect(s.resolveShare(next.link.token)).toEqual(next.link);
  });

  test("cannot be made for a room or a document that does not exist", async () => {
    const s = await seeded();
    expect(refusalOf(await s.share("nowhere", DOC, alice)).code).toBe("UNKNOWN_ROOM");
    expect(refusalOf(await s.share("room", "missing.docx", alice)).code).toBe("UNKNOWN_DOCUMENT");
    expect(s.resolveShare("not-a-token")).toBeNull();
  });
});

describe("in a read-only workspace", () => {
  test("a link cannot be made, but one that exists can still be ended", async () => {
    const writable = await seeded();
    const { link } = must(await writable.share("room", DOC, alice));
    const s = await start(MODE);
    expect(s.resolveShare(link.token)).toEqual(link);
    const refusal = refusalOf(await s.share("room", "other.docx", alice));
    expect(refusal).toMatchObject({ code: "LICENSE_LIMIT", reason: "workspace-read-only" });
    expect(s.shareOf("room", "other.docx")).toBeNull();

    expect(s.unshare("room", DOC)).toBe(true);
    expect(s.resolveShare(link.token)).toBeNull();
  });
});
