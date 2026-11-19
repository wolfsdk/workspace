// The blob store: content-addressed files that are written whole or not at all, and a put that repairs what a
// crash could have left behind. Power loss itself is not simulated here: that fsync reaches the disk is the
// operating system's promise, not something a test on a running system can observe.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobQuotaExceeded, PLAN_STORAGE_LIMIT, WorkspaceBlobs } from "../src/blobs.ts";
import { BlobCorrupt, BlobStore } from "../src/index.ts";
import { bytesOf, failureOf, sha256, textOf } from "./fixtures/harness.ts";

// Blobs are written and synced to disk: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-blobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pathOf = (root: string, digest: string): string => join(root, digest.slice(0, 2), digest);

describe("the blob store", () => {
  test("a blob is stored under its SHA-256, in a directory named by the first two digits, and read back", async () => {
    const store = new BlobStore(join(dir, "blobs"));
    const bytes = bytesOf("hello world");
    const digest = await store.put(bytes);
    expect(digest).toBe(sha256(bytes));
    expect(await store.has(digest)).toBe(true);
    expect(textOf((await store.get(digest)) ?? new Uint8Array())).toBe("hello world");
    expect(await Bun.file(pathOf(join(dir, "blobs"), digest)).text()).toBe("hello world");
    expect(await store.get(sha256(bytesOf("never stored")))).toBeNull();
  });

  test("a put leaves nothing but the blob: no temporary file", async () => {
    const root = join(dir, "blobs");
    const store = new BlobStore(root);
    const digests = await Promise.all(["a", "b", "c", "d"].map((text) => store.put(bytesOf(text))));
    for (const digest of digests) expect(await readdir(join(root, digest.slice(0, 2)))).toContain(digest);
    const leftovers = (await Promise.all((await readdir(root)).map((fan) => readdir(join(root, fan))))).flat().filter((name) => !/^[0-9a-f]{64}$/.test(name));
    expect(leftovers).toEqual([]);
  });

  test("the store makes a root that is several directories deep, and many puts at once into one directory all succeed", async () => {
    const root = join(dir, "var", "lib", "rooms", "blobs");
    const store = new BlobStore(root);
    const same = bytesOf("same bytes");
    const digests = await Promise.all(Array.from({ length: 24 }, (_, i) => store.put(i % 2 === 0 ? same : bytesOf(`other ${i}`))));
    expect(new Set(digests.filter((_, i) => i % 2 === 0))).toEqual(new Set([sha256(same)]));
    for (const digest of digests) expect(await store.has(digest)).toBe(true);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  test("putting bytes again repairs a blob that was damaged or left empty, and leaves a good one alone", async () => {
    const root = join(dir, "blobs");
    const store = new BlobStore(root);
    const bytes = bytesOf("precious");
    const digest = await store.put(bytes);
    await Bun.write(pathOf(root, digest), "tampered");
    await expect(store.get(digest)).rejects.toBeInstanceOf(BlobCorrupt);
    expect(await store.put(bytes)).toBe(digest);
    expect(textOf((await store.get(digest)) ?? new Uint8Array())).toBe("precious");
    // What a crash between the rename and the disk would leave: the name is there and the file is empty.
    await Bun.write(pathOf(root, digest), "");
    await expect(store.get(digest)).rejects.toBeInstanceOf(BlobCorrupt);
    expect(await store.put(bytes)).toBe(digest);
    expect(textOf((await store.get(digest)) ?? new Uint8Array())).toBe("precious");
    expect(await store.put(bytes)).toBe(digest);
  });

  test("a put that fails throws, and its temporary file is removed", async () => {
    const root = join(dir, "blobs");
    const store = new BlobStore(root);
    const digest = sha256(bytesOf("blocked"));
    // A directory where the blob should go: the rename onto it fails.
    await mkdir(join(pathOf(root, digest), "inside"), { recursive: true });
    await expect(store.put(bytesOf("blocked"))).rejects.toThrow();
    expect(await readdir(join(root, digest.slice(0, 2)))).toEqual([digest]);
  });

  test("a name that is not a SHA-256 is refused", async () => {
    const store = new BlobStore(join(dir, "blobs"));
    await expect(store.get("../../etc/passwd")).rejects.toBeInstanceOf(RangeError);
    await expect(store.has("abc")).rejects.toBeInstanceOf(RangeError);
  });

  test("a removed blob is gone, and removing it again says there was none", async () => {
    const root = join(dir, "blobs");
    const store = new BlobStore(root);
    const digest = await store.put(bytesOf("short-lived"));
    expect(await store.remove(digest)).toBe(true);
    expect(await store.has(digest)).toBe(false);
    expect(await store.remove(digest)).toBe(false);
    await expect(store.remove("abc")).rejects.toBeInstanceOf(RangeError);
  });
});

// The storage a workspace is charged for, held to the plan's quota. Sizes: "six..." is 6 bytes, "five." 5, "four" 4.
describe("the blobs of each workspace, held to the storage quota", () => {
  const SIX = bytesOf("six...");
  const FIVE = bytesOf("five.");
  const FOUR = bytesOf("four");

  const open = (quota: number | null): { db: Database; blobs: WorkspaceBlobs } => {
    const db = new Database(join(dir, "rooms.sqlite"));
    return { db, blobs: new WorkspaceBlobs(new BlobStore(join(dir, "blobs")), db, { quota }) };
  };

  test("a workspace is charged once for each blob it stores, and the charges are listed by workspace", async () => {
    const { blobs } = open(null);
    const six = await blobs.put("ws-1", SIX);
    expect(await blobs.put("ws-1", SIX)).toBe(six);
    const four = await blobs.put("ws-1", FOUR);
    await blobs.put("ws-2", SIX);
    expect(blobs.list("ws-1")).toEqual([{ sha256: six, bytes: 6 }, { sha256: four, bytes: 4 }].sort((a, b) => a.sha256.localeCompare(b.sha256)));
    expect(blobs.usage("ws-1")).toEqual({ workspace_id: "ws-1", bytes: 10, blobs: 2, quota: null });
    expect(blobs.usages()).toEqual([
      { workspace_id: "ws-1", bytes: 10, blobs: 2, quota: null },
      { workspace_id: "ws-2", bytes: 6, blobs: 1, quota: null },
    ]);
    expect(blobs.usage("ws-3")).toEqual({ workspace_id: "ws-3", bytes: 0, blobs: 0, quota: null });
    expect(blobs.list("ws-3")).toEqual([]);
    expect(textOf((await blobs.store.get(six)) ?? new Uint8Array())).toBe("six...");
  });

  test("a put that brings the workspace exactly to its quota is admitted, and bytes it already stores cost nothing", async () => {
    const { blobs } = open(10);
    await blobs.put("ws-1", SIX);
    await blobs.put("ws-1", FOUR);
    expect(blobs.usage("ws-1")).toEqual({ workspace_id: "ws-1", bytes: 10, blobs: 2, quota: 10 });
    // At the quota, a put of bytes the workspace already stores (a repair) is still admitted.
    await blobs.put("ws-1", SIX);
    expect(blobs.usage("ws-1").bytes).toBe(10);
  });

  test("a put over the quota is refused with the quota, the use and the size of the put, and writes nothing", async () => {
    const { blobs } = open(10);
    await blobs.put("ws-1", SIX);
    const refusal = await failureOf(blobs.put("ws-1", FIVE), BlobQuotaExceeded);
    expect(refusal.reason).toBe(PLAN_STORAGE_LIMIT);
    expect([refusal.workspaceId, refusal.quota, refusal.used, refusal.requested]).toEqual(["ws-1", 10, 6, 5]);
    expect(refusal.message).toBe(
      "plan-storage-limit: workspace ws-1 has a storage quota of 10 bytes and uses 6 bytes; a put of 5 bytes would make 11 bytes",
    );
    expect(await blobs.store.has(sha256(FIVE))).toBe(false);
    expect(blobs.usage("ws-1")).toEqual({ workspace_id: "ws-1", bytes: 6, blobs: 1, quota: 10 });
    // The quota is the workspace's own: another workspace has all of its headroom.
    await blobs.put("ws-2", FIVE);
    expect(blobs.usage("ws-2").bytes).toBe(5);
  });

  test("a delete frees the bytes, and the headroom takes the put that was refused", async () => {
    const { blobs } = open(10);
    const six = await blobs.put("ws-1", SIX);
    await failureOf(blobs.put("ws-1", FIVE), BlobQuotaExceeded);
    expect(await blobs.delete("ws-1", six)).toBe(6);
    expect(blobs.usage("ws-1")).toEqual({ workspace_id: "ws-1", bytes: 0, blobs: 0, quota: 10 });
    expect(blobs.usages()).toEqual([]);
    expect(await blobs.store.has(six)).toBe(false);
    const five = await blobs.put("ws-1", FIVE);
    expect(blobs.list("ws-1")).toEqual([{ sha256: five, bytes: 5 }]);
    expect(await blobs.delete("ws-1", six)).toBe(0);
    await expect(blobs.delete("ws-1", "abc")).rejects.toBeInstanceOf(RangeError);
  });

  test("a blob two workspaces store is kept until the last of them deletes it", async () => {
    const { blobs } = open(10);
    const six = await blobs.put("ws-1", SIX);
    await blobs.put("ws-2", SIX);
    expect(await blobs.delete("ws-1", six)).toBe(6);
    expect(await blobs.store.has(six)).toBe(true);
    expect(blobs.list("ws-2")).toEqual([{ sha256: six, bytes: 6 }]);
    expect(await blobs.delete("ws-2", six)).toBe(6);
    expect(await blobs.store.has(six)).toBe(false);
  });

  test("puts at the same time cannot pass the quota together", async () => {
    const { blobs } = open(10);
    const outcomes = await Promise.allSettled([blobs.put("ws-1", SIX), blobs.put("ws-1", bytesOf("other6"))]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
    const refusal = (outcomes[1] as PromiseRejectedResult).reason as BlobQuotaExceeded;
    expect(refusal).toBeInstanceOf(BlobQuotaExceeded);
    expect([refusal.used, refusal.requested]).toEqual([6, 6]);
    expect(blobs.usage("ws-1").bytes).toBe(6);
  });

  test("the charges last as long as the database: a new process lists them and counts them against the quota", async () => {
    const first = open(10);
    const six = await first.blobs.put("ws-1", SIX);
    first.db.close();
    const second = open(10);
    expect(second.blobs.list("ws-1")).toEqual([{ sha256: six, bytes: 6 }]);
    const refusal = await failureOf(second.blobs.put("ws-1", FIVE), BlobQuotaExceeded);
    expect(refusal.used).toBe(6);
    second.db.close();
  });

  test("a quota that is not a whole number of bytes is refused when the store is made", () => {
    const db = new Database(":memory:");
    for (const quota of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new WorkspaceBlobs(new BlobStore(join(dir, "blobs")), db, { quota })).toThrow(RangeError);
    }
    db.close();
  });
});
