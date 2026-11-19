// Document bytes, stored by the SHA-256 of their content: `<dir>/<first two hex digits>/<sha256>`. A blob is
// immutable, and a read re-hashes what it found: a blob that no longer matches its name is damage, not an
// answer. A put is durable before it returns, because the room database commits a head that names these bytes
// next, and a head must never outlive the bytes it names.
//
// `WorkspaceBlobs` charges each workspace for the blobs it stores and holds it to the storage quota of the plan.
import type { Database } from "bun:sqlite";
import { mkdir, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./hash.ts";

const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `value` is the name of a blob: a lowercase hexadecimal SHA-256. */
export function isSha256(value: string): boolean {
  return SHA256.test(value);
}

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

  /**
   * Remove the blob `sha256`; whether there was one. On return the removal is durable: the directory that named
   * the blob is synced. Nothing here knows whether a head still names these bytes; that is the caller's to decide.
   */
  async remove(sha256: string): Promise<boolean> {
    const target = this.pathOf(sha256);
    try {
      await unlink(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    await syncDirectory(path.dirname(target));
    return true;
  }
}

/** The stable code of a put that the plan's storage quota refuses, and the first word of its message. */
export const PLAN_STORAGE_LIMIT = "plan-storage-limit";

/** A put that would take a workspace past its storage quota. Nothing was written and nothing was charged. */
export class BlobQuotaExceeded extends Error {
  readonly reason = PLAN_STORAGE_LIMIT;
  readonly workspaceId: string;
  /** The quota of the workspace, in bytes. */
  readonly quota: number;
  /** The bytes the workspace is charged for, including puts still in flight. */
  readonly used: number;
  /** The bytes of the refused put. */
  readonly requested: number;

  constructor(workspaceId: string, quota: number, used: number, requested: number) {
    super(
      `${PLAN_STORAGE_LIMIT}: workspace ${workspaceId} has a storage quota of ${byteCount(quota)} and uses ` +
        `${byteCount(used)}; a put of ${byteCount(requested)} would make ${byteCount(used + requested)}`,
    );
    this.name = "BlobQuotaExceeded";
    this.workspaceId = workspaceId;
    this.quota = quota;
    this.used = used;
    this.requested = requested;
  }
}

/** One blob a workspace is charged for. */
export type BlobCharge = { sha256: string; bytes: number };

/** What a workspace stores: the bytes and the number of blobs it is charged for, and its quota (`null`: none). */
export type BlobUsage = { workspace_id: string; bytes: number; blobs: number; quota: number | null };

/** A put in flight: the bytes it holds against the quota until it is charged, and how many puts share it. */
type Reservation = { bytes: number; holders: number; charged: boolean };

/**
 * The blobs of each workspace, and the bytes they take, held to a storage quota per workspace (the plan's
 * `storageBytes`, the bytes of documents and revisions across the whole workspace). A workspace is charged once for
 * each distinct blob it stores, at the blob's size; a blob two workspaces store is charged to each. A put of bytes
 * the workspace is already charged for costs nothing, so a put that repairs a blob is never refused.
 *
 * The charges are rows of `db` (table `blob_charges`), so they last as long as the database. A charge is written after
 * its bytes are durable, so a charge never names bytes that are not on disk; a crash in between leaves bytes no
 * workspace is charged for, which the sweep of unreferenced blobs takes away. A put reserves its bytes before it
 * writes, so concurrent puts cannot pass the check together and overrun the quota.
 *
 * Every put and delete of a workspace's blobs must come through here, or the charges stop telling the truth.
 */
export class WorkspaceBlobs {
  readonly store: BlobStore;
  /** The most bytes a workspace may be charged for, or `null` for no limit. */
  readonly quota: number | null;
  private readonly db: Database;
  /** Puts in flight, by workspace and then by blob. */
  private readonly pending = new Map<string, Map<string, Reservation>>();
  /** Removals in flight, by blob: a put of the same bytes waits for it, so that a removal never takes what it wrote. */
  private readonly removing = new Map<string, Promise<unknown>>();

  constructor(store: BlobStore, db: Database, options: { quota: number | null }) {
    const { quota } = options;
    if (quota !== null && !(Number.isSafeInteger(quota) && quota >= 0)) {
      throw new RangeError(`a storage quota is a whole number of bytes, 0 or more, or null for none; not ${quota}`);
    }
    this.store = store;
    this.quota = quota;
    this.db = db;
    db.run(
      `CREATE TABLE IF NOT EXISTS blob_charges (
         workspace_id TEXT NOT NULL,
         sha256 TEXT NOT NULL,
         bytes INTEGER NOT NULL CHECK (bytes >= 0),
         PRIMARY KEY (workspace_id, sha256)
       ) WITHOUT ROWID`,
    );
    db.run("CREATE INDEX IF NOT EXISTS blob_charges_by_blob ON blob_charges (sha256)");
  }

  /**
   * Store `bytes` for `workspaceId` and charge the workspace for them; returns their SHA-256. Throws
   * `BlobQuotaExceeded`, before anything is written, when the charge would take the workspace past its quota. A put
   * that brings the workspace exactly to its quota is admitted.
   */
  async put(workspaceId: string, bytes: Uint8Array): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const reservation = this.reserve(workspaceId, sha256, bytes.byteLength);
    try {
      // A removal that failed left the blob where it was; the put writes it again either way.
      await this.removing.get(sha256)?.catch(() => {});
      await this.store.put(bytes);
      this.db
        .query("INSERT OR IGNORE INTO blob_charges (workspace_id, sha256, bytes) VALUES (?, ?, ?)")
        .run(workspaceId, sha256, bytes.byteLength);
      reservation.charged = true;
    } finally {
      reservation.holders -= 1;
      if (reservation.holders === 0) {
        const inFlight = this.pending.get(workspaceId);
        inFlight?.delete(sha256);
        if (inFlight?.size === 0) this.pending.delete(workspaceId);
      }
    }
    return sha256;
  }

  /** Check the quota and hold the bytes against it. Synchronous, so no other put can check in between. */
  private reserve(workspaceId: string, sha256: string, size: number): Reservation {
    let inFlight = this.pending.get(workspaceId);
    const shared = inFlight?.get(sha256);
    if (shared !== undefined) {
      shared.holders += 1;
      return shared;
    }
    const cost = this.chargeOf(workspaceId, sha256) === null ? size : 0;
    if (cost > 0 && this.quota !== null) {
      const used = this.usedBytes(workspaceId);
      if (used + cost > this.quota) throw new BlobQuotaExceeded(workspaceId, this.quota, used, cost);
    }
    const reservation: Reservation = { bytes: cost, holders: 1, charged: false };
    if (inFlight === undefined) {
      inFlight = new Map();
      this.pending.set(workspaceId, inFlight);
    }
    inFlight.set(sha256, reservation);
    return reservation;
  }

  /**
   * Stop charging `workspaceId` for the blob `sha256`; returns the bytes that frees (0 when it was not charged for it).
   * When no workspace stores the blob any more, and no put of it is in flight, its file is removed too. The caller
   * decides that no head of the workspace names the blob.
   */
  async delete(workspaceId: string, sha256: string): Promise<number> {
    if (!SHA256.test(sha256)) throw new RangeError(`not a sha256: ${sha256}`);
    const freed = this.chargeOf(workspaceId, sha256);
    if (freed === null) return 0;
    this.db.query("DELETE FROM blob_charges WHERE workspace_id = ? AND sha256 = ?").run(workspaceId, sha256);
    if (!this.stored(sha256)) {
      const before = this.removing.get(sha256);
      const removal = (before === undefined ? Promise.resolve() : before.catch(() => {})).then(() =>
        this.store.remove(sha256),
      );
      this.removing.set(sha256, removal);
      try {
        await removal;
      } finally {
        if (this.removing.get(sha256) === removal) this.removing.delete(sha256);
      }
    }
    return freed;
  }

  /** The blobs `workspaceId` is charged for, by SHA-256. */
  list(workspaceId: string): BlobCharge[] {
    return this.db
      .query<BlobCharge, [string]>("SELECT sha256, bytes FROM blob_charges WHERE workspace_id = ? ORDER BY sha256")
      .all(workspaceId);
  }

  /** What `workspaceId` is charged for. Puts still in flight are not in it. */
  usage(workspaceId: string): BlobUsage {
    const row = this.db
      .query<{ bytes: number; blobs: number }, [string]>(
        "SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS blobs FROM blob_charges WHERE workspace_id = ?",
      )
      .get(workspaceId);
    return { workspace_id: workspaceId, bytes: row?.bytes ?? 0, blobs: row?.blobs ?? 0, quota: this.quota };
  }

  /** What every workspace that is charged for a blob is charged for, by workspace id. */
  usages(): BlobUsage[] {
    return this.db
      .query<{ workspace_id: string; bytes: number; blobs: number }, []>(
        "SELECT workspace_id, SUM(bytes) AS bytes, COUNT(*) AS blobs FROM blob_charges " +
          "GROUP BY workspace_id ORDER BY workspace_id",
      )
      .all()
      .map((row) => ({ ...row, quota: this.quota }));
  }

  /** The bytes `workspaceId` is charged for `sha256`, or `null` when it is not. */
  private chargeOf(workspaceId: string, sha256: string): number | null {
    const row = this.db
      .query<{ bytes: number }, [string, string]>("SELECT bytes FROM blob_charges WHERE workspace_id = ? AND sha256 = ?")
      .get(workspaceId, sha256);
    return row === null ? null : row.bytes;
  }

  /** The bytes charged to `workspaceId` and held by its puts in flight that are not charged yet. */
  private usedBytes(workspaceId: string): number {
    let used = this.usage(workspaceId).bytes;
    for (const reservation of this.pending.get(workspaceId)?.values() ?? []) {
      if (!reservation.charged) used += reservation.bytes;
    }
    return used;
  }

  /** Whether a workspace is charged for `sha256` or a put of it is in flight. */
  private stored(sha256: string): boolean {
    if (this.db.query("SELECT 1 FROM blob_charges WHERE sha256 = ? LIMIT 1").get(sha256) !== null) return true;
    for (const inFlight of this.pending.values()) if (inFlight.has(sha256)) return true;
    return false;
  }
}

function byteCount(n: number): string {
  return `${n} byte${n === 1 ? "" : "s"}`;
}

/** fsync a directory, which is what makes the names in it (a rename, a new subdirectory) survive power loss. */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
