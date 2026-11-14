// The blob store: content-addressed files that are written whole or not at all, and a put that repairs what a
// crash could have left behind. Power loss itself is not simulated here: that fsync reaches the disk is the
// operating system's promise, not something a test on a running system can observe.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobCorrupt, BlobStore } from "../src/index.ts";
import { bytesOf, sha256, textOf } from "./fixtures/harness.ts";

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
});
