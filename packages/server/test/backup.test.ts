// Backup and restore of a workspace. Every scenario runs against two stores: a directory, and an in-process
// server that speaks the part of the S3 protocol the backup uses (the real S3 client of Bun talks to it over
// HTTP). Nothing here asserts on how long anything took: the live writer test waits on what the writer has
// acknowledged, never on a clock.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupError,
  type BackupErrorCode,
  type BackupOptions,
  type BackupReport,
  backupWorkspace,
  BlobStore,
  blobsToRemove,
  DirectoryObjectStore,
  listSnapshots,
  type ObjectStore,
  PoolEngine,
  restoreWorkspace,
  RoomServer,
  S3ObjectStore,
  verifyWorkspace,
  WorkerPool,
} from "../src/index.ts";
import { alice, bytesOf, committed, FAKE_REACTOR, failureOf, type Harness, makeHarness, must, seedRoom, sha256, textOf } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

// Stores -----------------------------------------------------------------------------------------------------

const BUCKET = "test-bucket";

type FakeS3 = { endpoint: string; objects: Map<string, Uint8Array>; accessKeyId: string; secretAccessKey: string; requests: string[]; stop(): void };

const xml = (status: number, body: string): Response => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

/**
 * The S3 protocol as far as a backup needs it: path-style PutObject, GetObject, DeleteObject and ListObjectsV2 with
 * pagination. Requests are signed by the client and not verified here (a fake cannot hold a real service's
 * secret), but the access key id they carry is checked, so a wrong key is refused as a real service refuses it.
 */
function startFakeS3(serverPageSize = 1000): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const accessKeyId = `test-id-${crypto.randomUUID()}`;
  const secretAccessKey = `test-secret-${crypto.randomUUID()}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      const body = new Uint8Array(await req.arrayBuffer());
      if (!(req.headers.get("authorization") ?? "").includes(`Credential=${accessKeyId}/`)) {
        return xml(403, "<Error><Code>InvalidAccessKeyId</Code><Message>The access key id is not known</Message></Error>");
      }
      if (!url.pathname.startsWith(`/${BUCKET}`)) return xml(404, "<Error><Code>NoSuchBucket</Code><Message>no such bucket</Message></Error>");
      const key = decodeURIComponent(url.pathname.slice(BUCKET.length + 2));
      if (req.method === "PUT") {
        objects.set(key, body);
        return new Response(null, { status: 200, headers: { etag: `"${sha256(body).slice(0, 32)}"` } });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const asked = Number(url.searchParams.get("max-keys") ?? serverPageSize);
        const after = url.searchParams.get("continuation-token") ?? "";
        const limit = Math.min(asked, serverPageSize);
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = matching.slice(0, limit);
        const truncated = matching.length > page.length;
        return xml(
          200,
          `<ListBucketResult><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys>` +
            `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ""}` +
            page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.length ?? 0}</Size></Contents>`).join("") +
            "</ListBucketResult>",
        );
      }
      if (req.method === "GET") {
        const found = objects.get(key);
        return found === undefined ? xml(404, `<Error><Code>NoSuchKey</Code><Message>no such key</Message><Key>${key}</Key></Error>`) : new Response(found.slice());
      }
      return xml(400, "<Error><Code>InvalidRequest</Code><Message>not supported by this fake</Message></Error>");
    },
  });
  return { endpoint: `http://127.0.0.1:${server.port}`, objects, accessKeyId, secretAccessKey, requests, stop: () => void server.stop(true) };
}

type Target = { store: ObjectStore; keys(): Promise<string[]>; s3?: FakeS3; stop(): void };

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name).slice(root.length + 1));
  }
  return found.sort();
}

async function makeTarget(kind: "directory" | "s3", dir: string): Promise<Target> {
  if (kind === "directory") {
    const root = join(dir, "store");
    await mkdir(root, { recursive: true });
    return { store: new DirectoryObjectStore(root), keys: () => filesUnder(root), stop() {} };
  }
  // A page of two keys: every listing of more than two objects is paginated.
  const s3 = startFakeS3(1000);
  const store = new S3ObjectStore({ bucket: BUCKET, endpoint: s3.endpoint, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, pageSize: 2 });
  return { store, s3, keys: async () => [...s3.objects.keys()].sort(), stop: s3.stop };
}

/** An object store that records what is asked of it, and may damage what it is given. */
class RecordingStore implements ObjectStore {
  readonly log: string[] = [];

  private readonly inner: ObjectStore;
  private readonly damage: ((key: string, bytes: Uint8Array) => Uint8Array) | undefined;

  constructor(inner: ObjectStore, damage?: (key: string, bytes: Uint8Array) => Uint8Array) {
    this.inner = inner;
    this.damage = damage;
  }

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.log.push(`put ${key}`);
    return this.inner.put(key, this.damage?.(key, bytes) ?? bytes);
  }

  get(key: string): Promise<Uint8Array | null> {
    this.log.push(`get ${key}`);
    return this.inner.get(key);
  }

  list(prefix: string): Promise<string[]> {
    this.log.push(`list ${prefix}`);
    return this.inner.list(prefix);
  }

  delete(key: string): Promise<void> {
    this.log.push(`delete ${key}`);
    return this.inner.delete(key);
  }
}

// Workspaces -------------------------------------------------------------------------------------------------

const dbOf = (h: Harness): string => join(h.dir, "rooms.sqlite");
const blobsOf = (h: Harness): string => join(h.dir, "blobs");
const blobPath = (blobDir: string, sha: string): string => join(blobDir, sha.slice(0, 2), sha);

/** A clock for the snapshot names: one second later at every reading. */
function ticking(start = "2026-11-13T12:00:00.000Z"): () => number {
  let at = Date.parse(start);
  return () => (at += 1000);
}

async function append(h: Harness, doc: string, text: string): Promise<string> {
  const head = must(await h.server.readHead("room", alice, doc)).head;
  const out = committed(await h.server.edit("room", alice, { doc_name: doc, base_revision: head.revision, mode: "commit", batch: { ops: [{ op: "append", text }] } }));
  return out.head.sha256;
}

/** Two documents, three revisions of the first, and an open proposal on the second (its preview is a blob of its own). */
async function populate(h: Harness): Promise<void> {
  await seedRoom(h);
  must(await h.server.addDocument("room", alice, { name: "notes.docx", format: "docx", bytes: bytesOf("notes") }));
  await append(h, "doc.docx", " one");
  await append(h, "doc.docx", " two");
  const proposal = must(await h.server.edit("room", alice, { doc_name: "notes.docx", base_revision: 0, mode: "propose", batch: { ops: [{ op: "append", text: " idea" }] } }));
  expect(proposal.mode).toBe("propose");
}

type Rows = Record<string, string | number | null>[];

/** Run one query on a database file, whoever else has it open. */
function query(file: string, sql: string): Rows {
  const db = new Database(file, { readwrite: true });
  try {
    return db.query(sql).all() as Rows;
  } finally {
    db.close();
  }
}

/** Every blob a database names, including retained keyframes, independently of the code under test. */
function namedBlobs(file: string): string[] {
  const names = new Set<string>();
  for (const sql of ["SELECT sha256 AS n FROM documents", "SELECT base_sha256 AS n FROM session_log", "SELECT result_sha256 AS n FROM session_log", "SELECT sha256 AS n FROM keyframes"]) {
    for (const row of query(file, sql)) names.add(String(row.n));
  }
  for (const row of query(file, "SELECT body FROM proposals")) {
    const body: unknown = JSON.parse(String(row.body));
    if (typeof body === "object" && body !== null && "preview_sha256" in body && typeof body.preview_sha256 === "string") names.add(body.preview_sha256);
  }
  return [...names].sort();
}

/** The documents, the session log and the proposals of a workspace, and the text each document holds. */
async function describeWorkspace(dbPath: string, blobDir: string) {
  const documents = query(dbPath, "SELECT room_id, name, revision, sha256, format FROM documents ORDER BY room_id, name");
  const log = query(dbPath, "SELECT room_id, seq, doc_name, revision, base_sha256, result_sha256, author, batch, committed_at FROM session_log ORDER BY room_id, seq");
  const proposals = query(dbPath, "SELECT proposal_id, status, body FROM proposals ORDER BY proposal_id");
  const blobs = new BlobStore(blobDir);
  const texts: Record<string, string> = {};
  for (const row of documents) texts[`${row.room_id}/${row.name}`] = textOf((await blobs.get(String(row.sha256))) ?? new Uint8Array());
  return { documents, log, proposals, texts };
}

async function codeOf(promise: Promise<unknown>): Promise<BackupErrorCode> {
  return (await failureOf(promise, BackupError)).code;
}

let dir: string;
let h: Harness;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-backup-"));
  h = await makeHarness();
});
afterEach(async () => {
  await h.dispose();
  await rm(dir, { recursive: true, force: true });
});

type Restored = { dbPath: string; blobDir: string };
const placeOf = (name: string): Restored => ({ dbPath: join(dir, name, "rooms.sqlite"), blobDir: join(dir, name, "blobs") });

// The stores ---------------------------------------------------------------------------------------------------

for (const kind of ["directory", "s3"] as const) {
  describe(`an object store, ${kind}`, () => {
    let target: Target;
    beforeEach(async () => {
      target = await makeTarget(kind, dir);
    });
    afterEach(() => target.stop());

    test("puts, gets, lists, replaces and deletes objects, and a missing object is null, not an error", async () => {
      const { store } = target;
      expect(await store.get("blobs/ab/missing")).toBeNull();
      await store.put("blobs/ab/one", bytesOf("1"));
      await store.put("blobs/ab/two", bytesOf("22"));
      await store.put("blobs/cd/three", bytesOf("333"));
      await store.put("snapshots/x.sqlite", bytesOf("4444"));
      expect(textOf((await store.get("blobs/ab/two")) ?? new Uint8Array())).toBe("22");
      expect((await store.list("blobs/")).sort()).toEqual(["blobs/ab/one", "blobs/ab/two", "blobs/cd/three"]);
      expect((await store.list("blobs/ab/")).sort()).toEqual(["blobs/ab/one", "blobs/ab/two"]);
      expect(await store.list("elsewhere/")).toEqual([]);
      await store.put("blobs/ab/two", bytesOf("replaced"));
      expect(textOf((await store.get("blobs/ab/two")) ?? new Uint8Array())).toBe("replaced");
      await store.delete("blobs/ab/two");
      await store.delete("blobs/ab/two");
      expect(await store.get("blobs/ab/two")).toBeNull();
      expect((await store.list("")).sort()).toEqual(["blobs/ab/one", "blobs/cd/three", "snapshots/x.sqlite"]);
    });

    test("an object of several megabytes comes back byte for byte", async () => {
      const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
      await target.store.put("blobs/ab/big", big);
      expect(sha256((await target.store.get("blobs/ab/big")) ?? new Uint8Array())).toBe(sha256(big));
    });

    test("a listing of more keys than a page holds returns every key", async () => {
      for (let i = 0; i < 7; i++) await target.store.put(`blobs/ab/${String(i).padStart(3, "0")}`, bytesOf(String(i)));
      expect((await target.store.list("blobs/")).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `blobs/ab/${String(i).padStart(3, "0")}`));
      if (target.s3 !== undefined) expect(target.s3.requests.filter((r) => r.includes("continuation-token")).length).toBeGreaterThanOrEqual(3);
    });
  });
}

describe("the keys of a store", () => {
  test("a directory store refuses a key that leaves its root", async () => {
    const store = new DirectoryObjectStore(join(dir, "store"));
    for (const key of ["../escape", "a/../../escape", "", "/absolute", "a//b", "a/./b"]) {
      expect(await codeOf(store.put(key, bytesOf("x")))).toBe("BAD_ARGUMENT");
    }
  });
});

describe("S3 credentials", () => {
  test("a wrong access key fails the backup before anything is stored, and the error carries no secret", async () => {
    await populate(h);
    const s3 = startFakeS3();
    try {
      const secret = `test-secret-${crypto.randomUUID()}`;
      const store = new S3ObjectStore({ bucket: BUCKET, endpoint: s3.endpoint, accessKeyId: `wrong-${crypto.randomUUID()}`, secretAccessKey: secret });
      const failure = await failureOf(backupWorkspace({ dbPath: dbOf(h), blobDir: blobsOf(h), store, keep: 2 }), Error);
      expect(`${failure.name} ${failure.message} ${failure.stack ?? ""}`).not.toContain(secret);
      expect(s3.objects.size).toBe(0);
    } finally {
      s3.stop();
    }
  });
});

// Backup -------------------------------------------------------------------------------------------------------

for (const kind of ["directory", "s3"] as const) {
  describe(`a backup to a ${kind} store`, () => {
    let target: Target;
    let clock = ticking();
    beforeEach(async () => {
      clock = ticking();
      target = await makeTarget(kind, dir);
    });
    afterEach(() => target.stop());

    const backup = (options: Partial<BackupOptions> = {}) =>
      backupWorkspace({ dbPath: dbOf(h), blobDir: blobsOf(h), store: target.store, keep: 3, now: clock, ...options });

    test("uploads every blob the snapshot names, then its manifest, then the snapshot itself, last", async () => {
      await populate(h);
      const recording = new RecordingStore(target.store);
      const report = await backup({ store: recording });
      const named = namedBlobs(dbOf(h));
      expect(named).toHaveLength(5);

      const puts = recording.log.filter((entry) => entry.startsWith("put "));
      expect(puts.at(-1)).toBe(`put ${report.snapshot_key}`);
      expect(puts.at(-2)).toBe(`put snapshots/${report.snapshot}.blobs.json`);
      expect(puts.slice(0, -2).sort()).toEqual(named.map((sha) => `put blobs/${sha.slice(0, 2)}/${sha}`).sort());
      expect(report.snapshot).toMatch(/^20261113T120001\.000Z-[0-9a-f]{12}$/);
      expect(report).toMatchObject({ blobs_named: named.length, blobs_uploaded: named.length, blobs_reused: 0, retained: [report.snapshot], pruned: [], blobs_removed: 0 });

      expect(await target.keys()).toEqual([...named.map((sha) => `blobs/${sha.slice(0, 2)}/${sha}`), `snapshots/${report.snapshot}.blobs.json`, `snapshots/${report.snapshot}.sqlite`].sort());
      expect(await listSnapshots(target.store)).toEqual([report.snapshot]);
    });

    test("the snapshot in the store is a database with the documents, revisions and proposals the workspace held", async () => {
      await populate(h);
      const report = await backup();
      const bytes = (await target.store.get(report.snapshot_key)) ?? new Uint8Array();
      expect(sha256(bytes).slice(0, 12)).toBe(report.snapshot.slice(-12));
      const copy = join(dir, "copy.sqlite");
      await writeFile(copy, bytes);
      for (const table of ["documents", "session_log", "keyframes", "proposals", "rooms", "events", "seats", "meta"]) {
        expect(query(copy, `SELECT * FROM ${table} ORDER BY 1, 2`)).toEqual(query(dbOf(h), `SELECT * FROM ${table} ORDER BY 1, 2`));
      }
      expect(query(copy, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    });

    test("a later backup uploads only the blobs the store does not hold", async () => {
      await populate(h);
      const first = await backup();
      await append(h, "doc.docx", " three");
      await append(h, "notes.docx", " more");
      const second = await backup();
      const named = namedBlobs(dbOf(h));
      expect(second.blobs_named).toBe(named.length);
      expect(second.blobs_reused).toBe(first.blobs_named);
      expect(second.blobs_uploaded).toBe(named.length - first.blobs_named);
      expect(second.retained).toEqual([second.snapshot, first.snapshot]);
      expect((await target.keys()).filter((key) => key.startsWith("blobs/"))).toEqual(named.map((sha) => `blobs/${sha.slice(0, 2)}/${sha}`).sort());

      const third = await backup();
      expect(third).toMatchObject({ blobs_uploaded: 0, blobs_uploaded_bytes: 0, blobs_reused: named.length });
    });

    test("a blob the snapshot names that is missing from the blob directory fails the run loudly, and nothing is uploaded", async () => {
      await populate(h);
      const named = namedBlobs(dbOf(h));
      const lost = named[0] as string;
      await rm(blobPath(blobsOf(h), lost));
      const failure = await failureOf(backup(), BackupError);
      expect(failure.code).toBe("BLOB_MISSING");
      expect(failure.message).toContain(lost);
      expect(failure.message).toContain("nothing was uploaded");
      expect(await target.keys()).toEqual([]);
    });

    test("a damaged blob in the blob directory is never uploaded, and no snapshot is", async () => {
      await populate(h);
      const damaged = namedBlobs(dbOf(h))[0] as string;
      await writeFile(blobPath(blobsOf(h), damaged), bytesOf("not what this blob was"));
      const failure = await failureOf(backup(), BackupError);
      expect(failure.code).toBe("BLOB_CORRUPT");
      expect(failure.message).toContain(damaged);
      expect((await target.keys()).filter((key) => key.startsWith("snapshots/"))).toEqual([]);
      expect(await target.store.get(`blobs/${damaged.slice(0, 2)}/${damaged}`)).toBeNull();
    });

    test("a blob that does not read back as its SHA-256 name is removed and fails the run; no snapshot is uploaded", async () => {
      await populate(h);
      const victim = namedBlobs(dbOf(h))[0] as string;
      const store = new RecordingStore(target.store, (key, bytes) => (key.endsWith(victim) ? bytesOf(`${textOf(bytes)} (changed in transit)`) : bytes));
      expect(await codeOf(backup({ store }))).toBe("UPLOAD_MISMATCH");
      expect(await target.keys()).not.toContain(`blobs/${victim.slice(0, 2)}/${victim}`);
      expect((await target.keys()).filter((key) => key.startsWith("snapshots/"))).toEqual([]);
    });

    test("a run with nothing to back up, or a keep count below one, is refused", async () => {
      await populate(h);
      expect(await codeOf(backup({ keep: 0 }))).toBe("BAD_ARGUMENT");
      expect(await codeOf(backup({ keep: 1.5 }))).toBe("BAD_ARGUMENT");
      expect(await codeOf(backup({ dbPath: join(dir, "no-such.sqlite") }))).toBe("NO_DATABASE");
      expect(await codeOf(backup({ concurrency: 0 }))).toBe("BAD_ARGUMENT");
      expect(await target.keys()).toEqual([]);
    });

    test("a file that is not a room database is refused with nothing uploaded", async () => {
      const notRooms = join(dir, "other.sqlite");
      const other = new Database(notRooms, { create: true });
      other.exec("CREATE TABLE t (x)");
      other.close();
      expect(await codeOf(backup({ dbPath: notRooms }))).toBe("SNAPSHOT_INVALID");
      await writeFile(join(dir, "garbage.sqlite"), bytesOf("this is not a database at all, not even close, not by any measure at all"));
      expect(await codeOf(backup({ dbPath: join(dir, "garbage.sqlite") }))).toBe("SNAPSHOT_INVALID");
      expect(await target.keys()).toEqual([]);
    });

    test("workspaces under different prefixes share a bucket without touching each other's blobs or snapshots", async () => {
      await populate(h);
      const a = { prefix: "team-a", keep: 1 };
      const b = { prefix: "team-b/", keep: 1 };
      await backup(b);
      const bKeys = await target.keys();
      await backup(a);
      await append(h, "doc.docx", " three");
      await backup(a);
      await backup(a);
      const keys = await target.keys();
      expect(keys.filter((key) => key.startsWith("team-b/"))).toEqual(bKeys);
      expect(keys.filter((key) => key.startsWith("team-a/snapshots/") && key.endsWith(".sqlite"))).toHaveLength(1);
      expect(await listSnapshots(target.store, "team-a")).toHaveLength(1);
      expect(await listSnapshots(target.store, "team-b")).toHaveLength(1);
      expect(keys.every((key) => key.startsWith("team-a/") || key.startsWith("team-b/"))).toBe(true);
    });
  });
}

// Retention ------------------------------------------------------------------------------------------------------

describe("blob deletion and retention", () => {
  test("a blob may be removed only when no retained snapshot names it", () => {
    const set = (...names: string[]): Set<string> => new Set(names);
    expect(blobsToRemove([set("a", "b", "c")], [set("c", "d")])).toEqual(["a", "b"]);
    expect(blobsToRemove([set("a"), set("b")], [set("a"), set("c")])).toEqual(["b"]);
    expect(blobsToRemove([set("a", "b")], [set("a"), set("b")])).toEqual([]);
    expect(blobsToRemove([], [set("a")])).toEqual([]);
    expect(blobsToRemove([set("a", "b")], [])).toEqual(["a", "b"]);
  });

  for (const kind of ["directory", "s3"] as const) {
    describe(`over a ${kind} store`, () => {
      let target: Target;
      beforeEach(async () => {
        target = await makeTarget(kind, dir);
      });
      afterEach(() => target.stop());

      const backup = (options: Partial<BackupOptions> = {}) =>
        backupWorkspace({ dbPath: dbOf(h), blobDir: blobsOf(h), store: target.store, keep: 2, now: clock, ...options });
      const clock = ticking();
      const blobKeys = async (): Promise<string[]> => (await target.keys()).filter((key) => key.startsWith("blobs/"));
      const keysOf = (names: string[]): string[] => names.map((sha) => `blobs/${sha.slice(0, 2)}/${sha}`).sort();

      /**
       * The retention of a later server, made by hand: the history of one document and the open proposal are
       * dropped from the database, and the blobs only they named are deleted from the blob directory. A snapshot
       * taken before that names blobs that exist nowhere on this machine any more.
       */
      async function applyLocalRetention(): Promise<string[]> {
        const before = namedBlobs(dbOf(h));
        const db = new Database(dbOf(h), { readwrite: true });
        db.exec("DELETE FROM session_log WHERE doc_name = 'doc.docx'");
        db.exec("DELETE FROM keyframes WHERE doc_name = 'doc.docx'");
        db.exec("DELETE FROM proposals");
        db.close();
        const kept = new Set(namedBlobs(dbOf(h)));
        const dropped = before.filter((sha) => !kept.has(sha));
        expect(dropped.length).toBeGreaterThanOrEqual(3);
        for (const sha of dropped) await rm(blobPath(blobsOf(h), sha));
        return dropped;
      }

      test("after the local blobs are deleted and old snapshots are pruned, every retained snapshot still restores completely", async () => {
        await populate(h);
        const s1 = await backup();
        const atS1 = await describeWorkspace(dbOf(h), blobsOf(h));
        const namedAtS1 = namedBlobs(dbOf(h));
        await append(h, "doc.docx", " three");
        const s2 = await backup();
        const atS2 = await describeWorkspace(dbOf(h), blobsOf(h));
        const namedAtS2 = namedBlobs(dbOf(h));
        const dropped = await applyLocalRetention();
        expect(dropped).toHaveLength(4);
        const namedNow = namedBlobs(dbOf(h));

        // Three snapshots, keep two: S1 goes. What only S1 named (nothing: S2 names all of it) stays, because S2 is retained.
        const s3 = await backup();
        expect(s3.pruned).toEqual([s1.snapshot]);
        expect(s3.blobs_removed).toBe(0);
        expect(await listSnapshots(target.store)).toEqual([s2.snapshot, s3.snapshot]);
        expect(await blobKeys()).toEqual(keysOf(namedAtS2));
        // S2 restores completely although the local copies of its history are gone, and S3 restores what the database now names.
        const restoredS2 = placeOf("s2");
        await restoreWorkspace({ store: target.store, snapshot: s2.snapshot, ...restoredS2 });
        expect(await describeWorkspace(restoredS2.dbPath, restoredS2.blobDir)).toEqual(atS2);
        const restoredS3 = placeOf("s3");
        await restoreWorkspace({ store: target.store, snapshot: s3.snapshot, ...restoredS3 });
        expect(namedBlobs(restoredS3.dbPath)).toEqual(namedNow);
        expect(await verifyWorkspace(restoredS3)).toMatchObject({ blobs: namedNow.length });

        // A fourth: S2 goes, and with it the blobs only S2 named: the dropped ones, which no retained snapshot names.
        const s4 = await backup();
        expect(s4.pruned).toEqual([s2.snapshot]);
        expect(s4.blobs_removed).toBe(dropped.length);
        expect(await blobKeys()).toEqual(keysOf(namedNow));
        expect(await listSnapshots(target.store)).toEqual([s3.snapshot, s4.snapshot]);
        for (const id of [s3.snapshot, s4.snapshot]) {
          const place = placeOf(`after-${id}`);
          const report = await restoreWorkspace({ store: target.store, snapshot: id, ...place });
          expect(report.blobs).toBe(namedNow.length);
          expect(namedBlobs(place.dbPath)).toEqual(namedNow);
        }
        // The pruned snapshots are gone, and say so.
        expect(await codeOf(restoreWorkspace({ store: target.store, snapshot: s1.snapshot, ...placeOf("s1") }))).toBe("NO_SNAPSHOT");
        expect(await codeOf(restoreWorkspace({ store: target.store, snapshot: s2.snapshot, ...placeOf("s2-again") }))).toBe("NO_SNAPSHOT");
        // S1 named blobs of the early history; none of the snapshots that remain does.
        expect(namedAtS1.filter((sha) => !namedNow.includes(sha)).length).toBeGreaterThanOrEqual(4);
        expect(atS1.documents.length).toBe(2);
      });

      test("with keep 1 each run removes exactly the blobs the previous snapshot alone named", async () => {
        await populate(h);
        const s1 = await backup({ keep: 1 });
        const namedAtS1 = namedBlobs(dbOf(h));
        const dropped = await applyLocalRetention();
        const s2 = await backup({ keep: 1 });
        expect(s2).toMatchObject({ pruned: [s1.snapshot], retained: [s2.snapshot], blobs_removed: dropped.length });
        const namedNow = namedBlobs(dbOf(h));
        expect(await blobKeys()).toEqual(keysOf(namedNow));
        expect(namedAtS1.length - namedNow.length).toBe(dropped.length);
        expect(await target.keys()).toEqual([...keysOf(namedNow), `snapshots/${s2.snapshot}.blobs.json`, `snapshots/${s2.snapshot}.sqlite`].sort());
      });

      test("a retained snapshot's blobs are never removed, whatever the number of runs between", async () => {
        await populate(h);
        const first = await backup({ keep: 3 });
        const namedAtFirst = namedBlobs(dbOf(h));
        await applyLocalRetention();
        for (let i = 0; i < 4; i++) await backup({ keep: 3 });
        // The first snapshot was pruned only when the fourth later run needed room; until then every blob it names is in the store.
        const retained = await listSnapshots(target.store);
        expect(retained).toHaveLength(3);
        if (retained.includes(first.snapshot)) {
          for (const sha of namedAtFirst) expect(await target.store.get(`blobs/${sha.slice(0, 2)}/${sha}`)).not.toBeNull();
        }
        const place = placeOf("oldest-retained");
        const restored = await restoreWorkspace({ store: target.store, snapshot: retained[0], ...place });
        expect(await verifyWorkspace(place)).toMatchObject({ blobs: restored.blobs });
      });

      test("a damaged manifest is not trusted: what the snapshot names is read from the snapshot itself", async () => {
        await populate(h);
        const s1 = await backup({ keep: 5 });
        const namedAtS1 = namedBlobs(dbOf(h));
        const dropped = await applyLocalRetention();
        const s2 = await backup({ keep: 5 });
        await target.store.put(`snapshots/${s1.snapshot}.blobs.json`, bytesOf("{ not json"));
        const s3 = await backup({ keep: 1 });
        expect(s3.pruned).toEqual([s1.snapshot, s2.snapshot]);
        expect(s3.blobs_removed).toBe(dropped.length);
        expect(await blobKeys()).toEqual(keysOf(namedBlobs(dbOf(h))));
        expect(namedAtS1.length).toBeGreaterThan(namedBlobs(dbOf(h)).length);
        expect((await target.keys()).filter((key) => key.includes(".blobs.json"))).toEqual([`snapshots/${s3.snapshot}.blobs.json`]);
      });

      test("when what a retained snapshot names cannot be read, nothing is removed from the store", async () => {
        await populate(h);
        const s1 = await backup({ keep: 5 });
        await applyLocalRetention();
        const s2 = await backup({ keep: 5 });
        await target.store.put(`snapshots/${s2.snapshot}.blobs.json`, bytesOf("{ not json"));
        await target.store.put(`snapshots/${s2.snapshot}.sqlite`, bytesOf("not a snapshot"));
        const before = await target.keys();
        // Keep two: S1 is pruned, S2 (unreadable) is retained next to the new snapshot; S1's blobs might be S2's.
        const failure = await failureOf(backup({ keep: 2 }), BackupError);
        expect(failure.code).toBe("SNAPSHOT_UNREADABLE");
        expect(failure.message).toContain(s2.snapshot);
        const after = await target.keys();
        expect(after.filter((key) => key.startsWith("blobs/"))).toEqual(before.filter((key) => key.startsWith("blobs/")));
        expect(await listSnapshots(target.store)).toContain(s1.snapshot);
      });

      test("the snapshot objects of a run that stopped half way are not mistaken for backups, and their blobs are pruned once nothing names them", async () => {
        await populate(h);
        // A run that died after its manifest and before its snapshot object leaves a manifest and blobs, and no snapshot.
        const first = await backup({ keep: 2, store: new RecordingStore(target.store) });
        const orphanId = "20261113T110000.000Z-0123456789ab";
        const stray = "9".repeat(64);
        await target.store.put(`blobs/99/${stray}`, bytesOf("stray"));
        await target.store.put(`snapshots/${orphanId}.blobs.json`, bytesOf(JSON.stringify({ format: "wolfsdk.backup.manifest.v1", snapshot: orphanId, snapshot_sha256: "0".repeat(64), schema_version: "2", blobs: [stray] })));
        expect(await listSnapshots(target.store)).toEqual([first.snapshot]);
        const second = await backup({ keep: 2 });
        expect(second.retained).toEqual([second.snapshot, first.snapshot]);
        const keys = await target.keys();
        expect(keys).not.toContain(`snapshots/${orphanId}.blobs.json`);
        expect(keys).not.toContain(`blobs/99/${stray}`);
        // Restores of what was retained are untouched.
        const place = placeOf("after-orphan");
        await restoreWorkspace({ store: target.store, snapshot: first.snapshot, ...place });
        expect(await verifyWorkspace(place)).toMatchObject({ documents: 2 });
      });
    });
  }
});

// Restore --------------------------------------------------------------------------------------------------------

for (const kind of ["directory", "s3"] as const) {
  describe(`a restore from a ${kind} store`, () => {
    let target: Target;
    let clock = ticking();
    beforeEach(async () => {
      clock = ticking();
      target = await makeTarget(kind, dir);
    });
    afterEach(() => target.stop());

    const backup = (options: Partial<BackupOptions> = {}) =>
      backupWorkspace({ dbPath: dbOf(h), blobDir: blobsOf(h), store: target.store, keep: 5, now: clock, ...options });

    test("rebuilds the workspace of the newest snapshot: documents, revisions, the log, the proposals, every blob", async () => {
      await populate(h);
      await backup();
      await append(h, "doc.docx", " three");
      const newest = await backup({ now: () => Date.parse("2026-11-14T00:00:00.000Z") });
      const original = await describeWorkspace(dbOf(h), blobsOf(h));
      const place = placeOf("restored");
      const report = await restoreWorkspace({ store: target.store, ...place });
      expect(report.snapshot).toBe(newest.snapshot);
      expect(await describeWorkspace(place.dbPath, place.blobDir)).toEqual(original);
      expect(original.documents.find((d) => d.name === "doc.docx")?.revision).toBe(3);
      expect(original.texts["room/doc.docx"]).toBe("hello world one two three");
      expect(report).toMatchObject({ documents: 2, revisions: 3 });
      expect(report.blobs).toBe(namedBlobs(dbOf(h)).length);
      expect(await readdir(join(dir, "restored"))).toEqual(expect.arrayContaining(["blobs", "rooms.sqlite"]));
      expect((await readdir(join(dir, "restored"))).filter((name) => name.includes("restore"))).toEqual([]);
    });

    test("rebuilds an older snapshot when asked for it by id", async () => {
      await populate(h);
      const older = await backup();
      const atOlder = await describeWorkspace(dbOf(h), blobsOf(h));
      await append(h, "doc.docx", " three");
      await backup();
      const place = placeOf("older");
      await restoreWorkspace({ store: target.store, snapshot: older.snapshot, ...place });
      expect(await describeWorkspace(place.dbPath, place.blobDir)).toEqual(atOlder);
      expect(await codeOf(restoreWorkspace({ store: target.store, snapshot: "20200101T000000.000Z-000000000000", ...placeOf("unknown") }))).toBe("NO_SNAPSHOT");
    });

    test("a restored workspace opens with the real room server and takes the next edit", async () => {
      await populate(h);
      await backup();
      const place = placeOf("served");
      await restoreWorkspace({ store: target.store, ...place });
      const pool = new WorkerPool({ command: [process.execPath, FAKE_REACTOR], size: 1, callTimeoutMs: 20_000 });
      const server = new RoomServer({ dbPath: place.dbPath, blobDir: place.blobDir, engine: new PoolEngine(pool) });
      try {
        const head = must(await server.readHead("room", alice, "doc.docx"));
        expect(head.head.revision).toBe(2);
        expect(textOf(head.bytes)).toBe("hello world one two");
        const out = committed(await server.edit("room", alice, { doc_name: "doc.docx", base_revision: 2, mode: "commit", batch: { ops: [{ op: "append", text: " three" }] } }));
        expect(out.head.revision).toBe(3);
        const preview = must(await server.readPreview("room", alice, must(await server.getRoom("room", alice)).proposals[0]?.proposal_id ?? ""));
        expect(textOf(preview.bytes)).toBe("notes idea");
      } finally {
        await server.close();
      }
      expect(await verifyWorkspace(place)).toMatchObject({ documents: 2, revisions: 3 });
    });

    test("refuses a target that is not empty and leaves it exactly as it was", async () => {
      await populate(h);
      await backup();
      const place = placeOf("busy");
      await mkdir(join(dir, "busy", "blobs"), { recursive: true });
      await writeFile(join(dir, "busy", "blobs", "keep.txt"), bytesOf("mine"));
      expect(await codeOf(restoreWorkspace({ store: target.store, ...place }))).toBe("TARGET_NOT_EMPTY");
      await writeFile(place.dbPath, bytesOf("an existing database"));
      expect(await codeOf(restoreWorkspace({ store: target.store, dbPath: place.dbPath, blobDir: join(dir, "busy", "other-blobs") }))).toBe("TARGET_NOT_EMPTY");
      await rm(place.dbPath);
      await writeFile(`${place.dbPath}-wal`, bytesOf("a write-ahead log that would be adopted"));
      expect(await codeOf(restoreWorkspace({ store: target.store, dbPath: place.dbPath, blobDir: join(dir, "busy", "other-blobs") }))).toBe("TARGET_NOT_EMPTY");
      expect((await readdir(join(dir, "busy"))).sort()).toEqual(["blobs", "rooms.sqlite-wal"]);
      expect(await readdir(join(dir, "busy", "blobs"))).toEqual(["keep.txt"]);
      expect(await Bun.file(join(dir, "busy", "blobs", "keep.txt")).text()).toBe("mine");
    });

    test("an empty blob directory that is already there is a valid target", async () => {
      await populate(h);
      await backup();
      const place = placeOf("prepared");
      await mkdir(place.blobDir, { recursive: true });
      await restoreWorkspace({ store: target.store, ...place });
      expect(await verifyWorkspace(place)).toMatchObject({ documents: 2 });
    });

    test("a store with no snapshot is refused", async () => {
      expect(await codeOf(restoreWorkspace({ store: target.store, ...placeOf("none") }))).toBe("NO_SNAPSHOT");
    });

    describe("leaves nothing half written when it fails", () => {
      const failing: [string, BackupErrorCode, (report: BackupReport) => Promise<void>][] = [
        [
          "a blob the snapshot names is gone from the store",
          "STORE_BLOB_MISSING",
          async (report) => {
            const sha = namedBlobs(dbOf(h)).at(-1) as string;
            await target.store.delete(`blobs/${sha.slice(0, 2)}/${sha}`);
            expect(report.blobs_named).toBeGreaterThan(0);
          },
        ],
        [
          "a blob in the store does not hash to its name",
          "BLOB_CORRUPT",
          async () => {
            const sha = namedBlobs(dbOf(h))[0] as string;
            await target.store.put(`blobs/${sha.slice(0, 2)}/${sha}`, bytesOf("another content"));
          },
        ],
        [
          "the snapshot object does not hash to its id",
          "SNAPSHOT_CORRUPT",
          async (report) => {
            const bytes = (await target.store.get(report.snapshot_key)) ?? new Uint8Array();
            bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
            await target.store.put(report.snapshot_key, bytes);
          },
        ],
        [
          "the snapshot is a room database of another schema version",
          "SNAPSHOT_INVALID",
          async (report) => {
            const file = join(dir, "other-version.sqlite");
            await writeFile(file, (await target.store.get(report.snapshot_key)) ?? new Uint8Array());
            const db = new Database(file, { readwrite: true });
            db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
            db.close();
            const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
            await target.store.put(report.snapshot_key, bytes);
            await target.store.delete(report.snapshot_key);
            await target.store.put(`snapshots/20261113T130000.000Z-${sha256(bytes).slice(0, 12)}.sqlite`, bytes);
          },
        ],
        [
          "the snapshot is a database with damaged pages",
          "SNAPSHOT_INVALID",
          async (report) => {
            const bytes = (await target.store.get(report.snapshot_key)) ?? new Uint8Array();
            bytes.fill(0xff, 2 * 4096, 2 * 4096 + 256);
            await target.store.delete(report.snapshot_key);
            await target.store.put(`snapshots/20261113T130000.000Z-${sha256(bytes).slice(0, 12)}.sqlite`, bytes);
          },
        ],
      ];
      for (const [name, code, damage] of failing) {
        test(name, async () => {
          await populate(h);
          const report = await backup();
          await damage(report);
          const place = placeOf("failed");
          await mkdir(join(dir, "failed"));
          expect(await codeOf(restoreWorkspace({ store: target.store, ...place }))).toBe(code);
          expect(await readdir(join(dir, "failed"))).toEqual([]);
        });
      }
    });
  });
}

// A writer that never stops ----------------------------------------------------------------------------------

// The writer is a separate process running the real room server (real database, real blob store, the stand-in
// reactor as engine). Each commit it makes is reported on its standard output after the server has acknowledged
// it. The test marks a point after the snapshot of the backup was taken, and waits for the writer to commit more
// revisions after that point: those are the revisions the snapshot cannot hold.
const WRITER = [
  'const { PoolEngine, RoomServer, WorkerPool } = await import(process.env.SERVER_ENTRY);',
  "const [dbPath, blobDir] = process.argv.slice(2);",
  "const pool = new WorkerPool({ command: [process.execPath, process.env.FAKE_REACTOR], size: 1, callTimeoutMs: 20000 });",
  "const server = new RoomServer({ dbPath, blobDir, engine: new PoolEngine(pool) });",
  'const alice = { kind: "user", id: "alice", name: "Alice" };',
  'const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
  'const ok = (result) => { if (!result.ok) throw new Error(result.error.code + ": " + result.error.message); return result.value; };',
  'ok(await server.createRoom(alice, { room_id: "room", workspace_id: "ws" }));',
  'const docs = ["a.docx", "b.docx"];',
  "const heads = {};",
  "for (const name of docs) {",
  '  heads[name] = ok(await server.addDocument("room", alice, { name, format: "docx", bytes: new TextEncoder().encode(name + ":start\\n") }));',
  "  say({ added: name, revision: heads[name].revision, sha256: heads[name].sha256 });",
  "}",
  "let stopping = false;",
  "let marks = 0;",
  "(async () => {",
  '  let pending = "";',
  "  for await (const chunk of Bun.stdin.stream()) {",
  "    pending += new TextDecoder().decode(chunk);",
  '    for (let at = pending.indexOf("\\n"); at >= 0; at = pending.indexOf("\\n")) {',
  "      const line = pending.slice(0, at);",
  "      pending = pending.slice(at + 1);",
  '      if (line === "stop") stopping = true;',
  '      if (line === "mark") marks += 1;',
  "    }",
  "  }",
  "})();",
  "say({ ready: true });",
  "let n = 0;",
  "while (!stopping) {",
  "  for (; marks > 0; marks -= 1) say({ mark: true });",
  "  const name = docs[n % docs.length];",
  "  n += 1;",
  '  const out = ok(await server.edit("room", alice, { doc_name: name, base_revision: heads[name].revision, mode: "commit", batch: { ops: [{ op: "append", text: name + ":" + n + "\\n" }] } }));',
  "  heads[name] = out.head;",
  "  say({ doc: name, revision: out.head.revision, sha256: out.head.sha256, n });",
  "  await new Promise((resolve) => setTimeout(resolve, 0));",
  "}",
  "await server.close();",
  "say({ done: true });",
  "process.exit(0);",
].join("\n");

type WriterEvent = { ready?: true; added?: string; mark?: true; done?: true; doc?: string; revision?: number; sha256?: string; n?: number };

/** A running writer: its acknowledgements so far, and a way to wait for a condition on them. */
async function startWriter(dbPath: string, blobDir: string) {
  const script = join(dir, "writer.ts");
  await writeFile(script, WRITER);
  const child = Bun.spawn([process.execPath, script, dbPath, blobDir], {
    env: { ...process.env, SERVER_ENTRY: new URL("../src/index.ts", import.meta.url).pathname, FAKE_REACTOR },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const events: WriterEvent[] = [];
  const waiters: (() => void)[] = [];
  let exited = false;
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const stderr = new Response(child.stderr).text();
  void (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      pending += decoder.decode(read.value, { stream: true });
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        events.push(JSON.parse(pending.slice(0, at)) as WriterEvent);
        pending = pending.slice(at + 1);
        wake();
      }
    }
    exited = true;
    wake();
  })();
  return {
    events,
    commits: (): WriterEvent[] => events.filter((event) => event.doc !== undefined),
    send(line: string): void {
      child.stdin.write(`${line}\n`);
      void child.stdin.flush();
    },
    async until(condition: () => boolean): Promise<void> {
      while (!condition()) {
        if (exited) throw new Error(`the writer ended before the condition held; it said: ${await stderr}`);
        const { promise, resolve } = Promise.withResolvers<void>();
        waiters.push(resolve);
        await promise;
      }
    },
    async stop(): Promise<void> {
      this.send("stop");
      await this.until(() => events.some((event) => event.done === true));
      await child.exited;
    },
    kill: (): void => child.kill(),
  };
}

describe("a backup taken while a writer keeps committing", () => {
  for (const kind of ["directory", "s3"] as const) {
    test(`restores to a consistent prefix of the writer's history, over a ${kind} store`, async () => {
      const target = await makeTarget(kind, dir);
      const dbPath = join(dir, "live", "rooms.sqlite");
      const blobDir = join(dir, "live", "blobs");
      await mkdir(join(dir, "live"));
      const writer = await startWriter(dbPath, blobDir);
      try {
        await writer.until(() => writer.commits().length >= 5);
        // Everything the writer has acknowledged by now is committed, so any snapshot taken from here on holds it.
        const ackedBefore = new Map<string, number>();
        for (const commit of writer.commits()) ackedBefore.set(commit.doc as string, commit.revision as number);

        let beforeMark = 0;
        let atBlobs = 0;
        const report = await backupWorkspace({
          dbPath,
          blobDir,
          store: target.store,
          keep: 2,
          now: ticking(),
          onStage: async (stage) => {
            if (stage === "snapshot") {
              // The snapshot is taken. Mark the writer's output here, and let it commit three more revisions: those
              // cannot be in the snapshot, and their blobs land in the blob directory while the backup uploads.
              writer.send("mark");
              await writer.until(() => writer.events.some((event) => event.mark === true));
              const markAt = writer.events.findIndex((event) => event.mark === true);
              beforeMark = writer.events.slice(0, markAt).filter((event) => event.doc !== undefined).length;
              await writer.until(() => writer.events.slice(markAt).filter((event) => event.doc !== undefined).length >= 3);
            }
            if (stage === "blobs") {
              // The blobs and the manifest are uploaded; the writer goes on, and the snapshot object is not there yet.
              atBlobs = writer.commits().length;
              await writer.until(() => writer.commits().length >= atBlobs + 2);
            }
          },
        });
        await writer.stop();

        const acked = writer.commits();
        expect(acked.length).toBeGreaterThanOrEqual(beforeMark + 5);
        const initial = new Map(writer.events.filter((event) => event.added !== undefined).map((event) => [event.added as string, event.sha256 as string]));
        const textAt = (doc: string, revision: number): string =>
          `${doc}:start\n` + acked.filter((commit) => commit.doc === doc && (commit.revision as number) <= revision).map((commit) => `${doc}:${commit.n}\n`).join("");

        // What the snapshot holds.
        const restored = placeOf("from-live");
        const restoredReport = await restoreWorkspace({ store: target.store, ...restored });
        expect(restoredReport.snapshot).toBe(report.snapshot);
        const restoredState = await describeWorkspace(restored.dbPath, restored.blobDir);
        const finalState = await describeWorkspace(dbPath, blobDir);
        expect(restoredState.documents.map((d) => d.name)).toEqual(["a.docx", "b.docx"]);

        let restoredRevisions = 0;
        for (const document of restoredState.documents) {
          const doc = String(document.name);
          const revision = Number(document.revision);
          restoredRevisions += revision;
          // Everything acknowledged before the backup began is in it.
          expect(revision).toBeGreaterThanOrEqual(ackedBefore.get(doc) ?? 0);
          // The head is the writer's head at that revision, and its bytes are the writer's bytes.
          const reported = revision === 0 ? initial.get(doc) : acked.find((commit) => commit.doc === doc && commit.revision === revision)?.sha256;
          expect(document.sha256).toBe(reported as string);
          expect(restoredState.texts[`room/${doc}`]).toBe(textAt(doc, revision));
          expect(sha256(bytesOf(textAt(doc, revision)))).toBe(document.sha256 as string);
          // Its history is every revision from the first to the head, each starting where the one before ended.
          const entries = restoredState.log.filter((row) => row.doc_name === doc);
          expect(entries.map((row) => row.revision)).toEqual(Array.from({ length: revision }, (_, i) => i + 1));
          let previous = initial.get(doc) as string;
          for (const entry of entries) {
            expect(entry.base_sha256).toBe(previous);
            expect(entry.result_sha256).toBe(acked.find((commit) => commit.doc === doc && commit.revision === entry.revision)?.sha256 as string);
            previous = String(entry.result_sha256);
          }
          expect(previous).toBe(document.sha256 as string);
        }
        // A prefix of the writer's history, cut before the writer's later commits: the snapshot was taken before the mark.
        expect(restoredRevisions).toBeLessThanOrEqual(beforeMark);
        expect(restoredRevisions).toBeLessThan(acked.length);
        expect(restoredState.log).toEqual(finalState.log.slice(0, restoredState.log.length));
        // The writer's database moved on; the restored one did not, and no revision of it names a missing blob.
        expect(finalState.log.length).toBeGreaterThan(restoredState.log.length);
        expect(await verifyWorkspace(restored)).toMatchObject({ documents: 2, revisions: restoredRevisions });
        // The store holds the blobs the snapshot names, and none of the blobs the writer made after it.
        const named = namedBlobs(restored.dbPath);
        expect((await target.keys()).filter((key) => key.startsWith("blobs/"))).toEqual(named.map((sha) => `blobs/${sha.slice(0, 2)}/${sha}`).sort());
        expect(namedBlobs(dbPath).length).toBeGreaterThan(named.length);

        // The restored workspace is a working one.
        const pool = new WorkerPool({ command: [process.execPath, FAKE_REACTOR], size: 1, callTimeoutMs: 20_000 });
        const server = new RoomServer({ dbPath: restored.dbPath, blobDir: restored.blobDir, engine: new PoolEngine(pool) });
        try {
          const head = must(await server.readHead("room", alice, "a.docx")).head;
          const out = committed(await server.edit("room", alice, { doc_name: "a.docx", base_revision: head.revision, mode: "commit", batch: { ops: [{ op: "append", text: "after the restore\n" }] } }));
          expect(out.head.revision).toBe(head.revision + 1);
        } finally {
          await server.close();
        }
      } finally {
        writer.kill();
        target.stop();
      }
    });
  }
});