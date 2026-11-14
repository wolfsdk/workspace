// Document bytes, stored by the SHA-256 of their content: `<dir>/<first two hex digits>/<sha256>`. A blob is
// immutable, and a read re-hashes what it found: a blob that no longer matches its name is damage, not an
// answer. A put is durable before it returns, because the room database commits a head that names these bytes
// next, and a head must never outlive the bytes it names.
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./hash.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export class BlobCorrupt extends Error {
  constructor(sha256: string, actual: string) {
    super(`blob ${sha256} is damaged: its bytes hash to ${actual}`);
    this.name = "BlobCorrupt";
  }
}

export class BlobStore {
  private readonly dir: string;
  /** The fan-out directories this process has made durable, by directory; a put waits for its directory's entry. */
  private readonly durableDirs = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  private pathOf(sha256: string): string {
    if (!SHA256.test(sha256)) throw new RangeError(`not a sha256: ${sha256}`);
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  /**
   * Store `bytes`; returns their SHA-256. On return the bytes are on disk, not only in the page cache: they are
   * written to a temporary file in the target directory and fsynced, renamed into place (so a reader never sees
   * half a blob), and the directory is fsynced so that the rename itself survives power loss.
   *
   * A put of bytes that are already stored writes them again: the old file may never have reached the disk, and
   * a damaged one is repaired by the rename.
   */
  async put(bytes: Uint8Array): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const target = this.pathOf(sha256);
    const dir = path.dirname(target);
    await this.durableDir(dir);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } catch (e) {
      await rm(temporary, { force: true });
      throw e;
    }
    await syncDirectory(dir);
    return sha256;
  }

  /**
   * Make the fan-out directory exist, and make every directory entry on the way to it durable: `mkdir` alone
   * leaves the new name in the parent's page cache, and a file synced inside a directory that is lost is lost
   * too. Once per directory per process; a put that finds the work in flight waits for it.
   */
  private durableDir(dir: string): Promise<void> {
    let ready = this.durableDirs.get(dir);
    if (ready === undefined) {
      ready = this.makeDurable(dir);
      this.durableDirs.set(dir, ready);
      ready.catch(() => this.durableDirs.delete(dir));
    }
    return ready;
  }

  private async makeDurable(dir: string): Promise<void> {
    // The directories to sync are the ones whose listing names a directory on the way to `dir`. `mkdir`
    // returns the first directory it made: `dir` itself, the blob root, or an ancestor of the root (undefined
    // when `dir` existed). That ancestor's parent is where the new names begin; if nothing above `dir` was
    // made now, start at the root's parent anyway, in case an earlier process made the root and died before
    // it could sync.
    const created = await mkdir(dir, { recursive: true });
    const top = path.dirname(created === undefined || created === dir ? this.dir : created);
    for (let at = path.dirname(dir); ; at = path.dirname(at)) {
      await syncDirectory(at);
      if (at === top) return;
    }
  }

  async has(sha256: string): Promise<boolean> {
    return Bun.file(this.pathOf(sha256)).exists();
  }

  /** The bytes of `sha256`, or `null` when there is no such blob. Throws `BlobCorrupt` on a mismatch. */
  async get(sha256: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.pathOf(sha256));
    if (!(await file.exists())) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const actual = sha256Hex(bytes);
    if (actual !== sha256) throw new BlobCorrupt(sha256, actual);
    return bytes;
  }
}

/** fsync a directory, which is what makes the names in it (a rename, a new subdirectory) survive power loss. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
