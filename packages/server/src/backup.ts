// Backup and restore of one workspace: the room database (one SQLite file) and the blob directory beside it, to
// and from an object store that speaks the S3 protocol (Backblaze B2 and Cloudflare R2 Standard are the
// targets), or a plain directory for a self-hoster.
//
// What a backup is. Every document of the database is a head that names a blob by its SHA-256, and so is every
// entry of the session log (the bytes before and after) and every proposal preview. The server puts a blob on
// disk before it commits the row that names it. Retention may remove blobs below the recorded history floors.
// A backup takes the database first and
// the blobs second: a snapshot of the database taken at one instant names only blobs that were on disk at that
// instant, and a blob never changes, so copying them later (while the server keeps writing newer ones) is
// exact. The order is the whole design. A copy of the database file taken after the blobs would name blobs the
// copy does not hold.
//
// What the store holds, under an optional key prefix:
//   blobs/<first two hex digits>/<sha256>        one object per blob, shared by every snapshot that names it
//   snapshots/<id>.blobs.json                    the names of the blobs a snapshot needs (a manifest)
//   snapshots/<id>.sqlite                        the database at one instant; the id is the UTC time of the
//                                                backup and the first 12 hex digits of the database's SHA-256
// A run uploads the blobs, then the manifest, then the snapshot object, last: a snapshot object that is in the
// store has every blob it names, and a run that stops half way leaves objects no snapshot names (they are
// reused by the next run, or removed by the pruning that follows it).
//
// Deleting from the store is governed by one rule: a blob may be removed only when no retained snapshot names
// it. A run keeps the newest `keep` snapshots and removes the older ones; the blobs removed with them are those
// that only they named (`blobsToRemove`, enforced again at the point of deletion by `removeBlobs`). A snapshot
// whose blobs cannot be read (a damaged manifest and a damaged snapshot) makes the run stop before it removes
// anything, because what it names is unknown: the rule fails closed. That keeps a restore of any retained
// snapshot complete even after local history retention removes its blobs, and after any number of prunes.
//
// Limits, all by design: one process runs backups into one prefix at a time (two would each see the other's
// half-finished objects as leftovers); a snapshot is held in memory while it is verified and uploaded; the
// blob listing of the store is read once per run.
import { S3Client } from "bun";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, open, readdir, lstat, rename, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BlobCorrupt, BlobStore, isSha256, syncDirectory } from "./blobs.ts";
import { sha256Hex } from "./hash.ts";
import { SCHEMA_VERSION } from "./store.ts";
import { neededBlobs } from "./retention.ts";

export type BackupErrorCode =
  /** An argument is out of range (a keep count below 1, a key that leaves the store). */
  | "BAD_ARGUMENT"
  /** There is no database file to back up. */
  | "NO_DATABASE"
  /** A database is not a readable room database of the schema this server reads, or fails its own checks. */
  | "SNAPSHOT_INVALID"
  /** A blob the snapshot names is not in the local blob directory; nothing was uploaded. */
  | "BLOB_MISSING"
  /** A blob does not hash to its name, locally or in the store. */
  | "BLOB_CORRUPT"
  /** An object read back from the store differs from the bytes that were sent. */
  | "UPLOAD_MISMATCH"
  /** The store lists no such snapshot (or none at all). */
  | "NO_SNAPSHOT"
  /** The snapshot object does not hash to its id. */
  | "SNAPSHOT_CORRUPT"
  /** The store holds no object for a blob that a snapshot names. */
  | "STORE_BLOB_MISSING"
  /** What a retained or pruned snapshot names cannot be read, so nothing is removed from the store. */
  | "SNAPSHOT_UNREADABLE"
  /** A blob was about to be removed that a retained snapshot names; refused. */
  | "BLOB_IN_USE"
  /** The restore target is not empty. */
  | "TARGET_NOT_EMPTY"
  /** The store answered in a way that cannot be trusted (an incomplete listing). */
  | "STORE_ERROR";

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/**
 * The few operations a backup needs from an object store. A key is a `/` separated path without empty,
 * `.` or `..` segments. `put` replaces; `get` returns `null` for an object that is not there; `list` returns
 * every key that starts with `prefix` (all pages), in no promised order; `delete` of a missing key succeeds.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export type S3ObjectStoreOptions = {
  bucket: string;
  /** The service endpoint, with scheme: `https://s3.<region>.backblazeb2.com` or `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /** The signing region: the region of the B2 endpoint, `auto` for R2 (the default). */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Keys asked for per listing request (default 1000, the most S3 services return). */
  pageSize?: number;
};

/** The S3 operations used, with Bun's built-in client: PutObject, GetObject, ListObjectsV2 and DeleteObject. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly pageSize: number;

  constructor(options: S3ObjectStoreOptions) {
    this.pageSize = options.pageSize ?? 1000;
    this.client = new S3Client({
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region ?? "auto",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
    });
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    checkKey(key);
    await this.client.write(key, bytes);
  }

  async get(key: string): Promise<Uint8Array | null> {
    checkKey(key);
    try {
      return new Uint8Array(await this.client.file(key).arrayBuffer());
    } catch (e) {
      if (isMissingObject(e)) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.list({ prefix, maxKeys: this.pageSize, ...(token === undefined ? {} : { continuationToken: token }) });
      for (const item of page.contents ?? []) keys.push(item.key);
      if (page.isTruncated && page.nextContinuationToken === undefined) {
        // Carrying on from a partial listing would make a snapshot look like a leftover, and its blobs removable.
        throw new BackupError("STORE_ERROR", `the store returned a truncated listing of ${prefix} without a continuation token`);
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token !== undefined);
    return keys;
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    try {
      await this.client.delete(key);
    } catch (e) {
      if (!isMissingObject(e)) throw e;
    }
  }
}

function isMissingObject(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e.code === "NoSuchKey" || e.code === "NotFound");
}

/** An object store in a directory of this machine (a mounted disk, a network share): one file a key. */
export class DirectoryObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathOf(key: string): string {
    checkKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  /** The bytes are on disk, and the object appears whole or not at all, before this returns. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });
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
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.pathOf(key));
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    const base = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    if (base !== "") checkKey(base.slice(0, -1));
    const found: string[] = [];
    const walk = async (dir: string, relative: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") return;
        throw e;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${relative}${entry.name}/`);
        else if (!entry.name.endsWith(".tmp") && `${relative}${entry.name}`.startsWith(prefix)) found.push(`${relative}${entry.name}`);
      }
    };
    await walk(path.join(this.root, ...base.split("/").filter((segment) => segment !== "")), base);
    return found;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

function checkKey(key: string): void {
  const bad = key === "" || key.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"));
  if (bad) throw new BackupError("BAD_ARGUMENT", `${JSON.stringify(key)} is not a valid object key: it must be non-empty segments joined by "/", none of them "." or ".."`);
}

// Keys --------------------------------------------------------------------------------------------------------

const SNAPSHOT_ID = /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}$/;
const MANIFEST_FORMAT = "wolfsdk.backup.manifest.v1";

/** `prefix` as the empty string or a path that ends in `/`. */
function normalizePrefix(prefix: string | undefined): string {
  const parts = (prefix ?? "").split("/").filter((part) => part !== "");
  if (parts.length === 0) return "";
  checkKey(parts.join("/"));
  return `${parts.join("/")}/`;
}

const blobKey = (prefix: string, sha256: string): string => `${prefix}blobs/${sha256.slice(0, 2)}/${sha256}`;
const snapshotKey = (prefix: string, id: string): string => `${prefix}snapshots/${id}.sqlite`;
const manifestKey = (prefix: string, id: string): string => `${prefix}snapshots/${id}.blobs.json`;

/** The id of a snapshot made at `now` (milliseconds) of a database whose SHA-256 starts with `sha256`: sorts by time. */
function snapshotId(now: number, sha256: string): string {
  return `${new Date(now).toISOString().replace(/[-:]/g, "")}-${sha256.slice(0, 12)}`;
}

/** What `snapshots/` holds: the ids that have a snapshot object, and the ids that have a manifest, oldest first. */
async function listBackupObjects(store: ObjectStore, prefix: string): Promise<{ snapshots: string[]; manifests: string[] }> {
  const head = `${prefix}snapshots/`;
  const snapshots: string[] = [];
  const manifests: string[] = [];
  for (const key of await store.list(head)) {
    const name = key.slice(head.length);
    if (name.endsWith(".sqlite") && SNAPSHOT_ID.test(name.slice(0, -".sqlite".length))) snapshots.push(name.slice(0, -".sqlite".length));
    else if (name.endsWith(".blobs.json") && SNAPSHOT_ID.test(name.slice(0, -".blobs.json".length))) manifests.push(name.slice(0, -".blobs.json".length));
  }
  return { snapshots: snapshots.sort(), manifests: manifests.sort() };
}

/** The ids of the snapshots in the store under `prefix`, oldest first. */
export async function listSnapshots(store: ObjectStore, prefix?: string): Promise<string[]> {
  return (await listBackupObjects(store, normalizePrefix(prefix))).snapshots;
}

// Database -----------------------------------------------------------------------------------------------------

type Inspection = { blobs: string[]; documents: number; revisions: number };

/**
 * A connection that is only used to read `file`. Read-only is preferred. A database in WAL mode whose server is
 * stopped has no `-shm` file, and SQLite cannot open that read-only, so such a file is opened read-write instead
 * (never created: the file must exist). No statement run on these connections writes.
 */
function openForReading(file: string): Database {
  const readOnly = new Database(file, { readonly: true });
  try {
    readOnly.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return readOnly;
  } catch (e) {
    readOnly.close();
    if (!(e instanceof Error && "code" in e && e.code === "SQLITE_CANTOPEN")) throw e;
    return new Database(file, { readwrite: true });
  }
}

/**
 * Open the room database `file` and check it: SQLite's own integrity check, its foreign keys, the
 * schema version this server reads; then list the blobs it names, sorted. Anything unreadable is a
 * `SNAPSHOT_INVALID`.
 */
function inspectDatabase(file: string, what: string): Inspection {
  let db: Database | undefined;
  try {
    db = openForReading(file);
    const checks = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") {
      throw new BackupError("SNAPSHOT_INVALID", `${what} fails PRAGMA integrity_check: ${checks.map((row) => row.integrity_check).slice(0, 3).join("; ")}`);
    }
    const orphans = db.query("PRAGMA foreign_key_check").all();
    if (orphans.length > 0) throw new BackupError("SNAPSHOT_INVALID", `${what} has ${orphans.length} rows that break a foreign key`);
    const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (version !== SCHEMA_VERSION) {
      throw new BackupError("SNAPSHOT_INVALID", `${what} has schema version ${version ?? "none"}; this server reads ${SCHEMA_VERSION}`);
    }
    const blobs = neededBlobs(db);
    const count = (table: string): number => db!.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    return { blobs, documents: count("documents"), revisions: count("session_log") };
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError("SNAPSHOT_INVALID", `${what} is not a readable room database: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db?.close();
  }
}

/**
 * A consistent copy of the database at `dbPath` in a new file: `VACUUM INTO`, which reads the database in one
 * transaction while the server keeps writing (a reader takes no write lock, so the server is never held up).
 */
function takeSnapshot(dbPath: string, into: string): void {
  let db: Database | undefined;
  try {
    db = openForReading(dbPath);
    // A server that is starting or checkpointing on this file may hold it for a moment.
    db.exec("PRAGMA busy_timeout = 30000");
    db.query("VACUUM INTO ?").run(into);
  } catch (e) {
    throw new BackupError("SNAPSHOT_INVALID", `could not take a snapshot of ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db?.close();
  }
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
}

async function writeDurable(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Run `work` over `items`, at most `limit` at a time; stops starting new items at the first failure, then throws it. */
async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (failure === undefined) {
      const at = next++;
      if (at >= items.length) return;
      try {
        await work(items[at] as T);
      } catch (e) {
        failure ??= { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== undefined) throw failure.error;
}

function lanesOf(concurrency: number | undefined): number {
  const lanes = concurrency ?? 8;
  if (!Number.isInteger(lanes) || lanes < 1) throw new BackupError("BAD_ARGUMENT", `concurrency must be a whole number of at least 1, got ${concurrency}`);
  return lanes;
}

function sample(names: readonly string[]): string {
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

// Verify -------------------------------------------------------------------------------------------------------

export type WorkspaceReport = { documents: number; revisions: number; blobs: number; blob_bytes: number };

/**
 * Check a workspace on disk: `PRAGMA integrity_check`, foreign keys, the schema version, and that every blob the
 * database names is in `blobDir` and hashes to its name. Reads only. Throws a `BackupError` that names what is
 * wrong; returns what was checked.
 */
export async function verifyWorkspace(options: { dbPath: string; blobDir: string; concurrency?: number }): Promise<WorkspaceReport> {
  const inspected = inspectDatabase(options.dbPath, options.dbPath);
  const store = new BlobStore(options.blobDir);
  const missing: string[] = [];
  const damaged: string[] = [];
  let bytes = 0;
  await mapLimit(inspected.blobs, lanesOf(options.concurrency), async (sha) => {
    try {
      const body = await store.get(sha);
      if (body === null) missing.push(sha);
      else bytes += body.length;
    } catch (e) {
      if (!(e instanceof BlobCorrupt)) throw e;
      damaged.push(sha);
    }
  });
  if (missing.length > 0) throw new BackupError("BLOB_MISSING", `${missing.length} blobs the database names are not in ${options.blobDir}: ${sample(missing.sort())}`);
  if (damaged.length > 0) throw new BackupError("BLOB_CORRUPT", `${damaged.length} blobs in ${options.blobDir} do not hash to their names: ${sample(damaged.sort())}`);
  return { documents: inspected.documents, revisions: inspected.revisions, blobs: inspected.blobs.length, blob_bytes: bytes };
}

// Backup -------------------------------------------------------------------------------------------------------

/** The stages of a backup, each reported after it is complete. */
export type BackupStage = "snapshot" | "blobs" | "snapshot-upload" | "prune";

export type BackupOptions = {
  dbPath: string;
  blobDir: string;
  store: ObjectStore;
  /** How many snapshots to keep in the store, this one included: a whole number of at least 1. */
  keep: number;
  /** A key prefix inside the store, to keep several workspaces in one bucket. One prefix is one workspace. */
  prefix?: string;
  /** Milliseconds since the epoch; names the snapshot. Default `Date.now`. */
  now?: () => number;
  /** Transfers in flight at once (default 8). */
  concurrency?: number;
  /** A folder for the temporary copy of the database (default: the temporary folder of the machine). */
  scratchDir?: string;
  /** Called, and waited for, after each stage completes. */
  onStage?: (stage: BackupStage) => void | Promise<void>;
};

export type BackupReport = {
  /** The id of the snapshot this run made. */
  snapshot: string;
  snapshot_key: string;
  snapshot_bytes: number;
  blobs_named: number;
  blobs_uploaded: number;
  blobs_uploaded_bytes: number;
  /** Blobs the snapshot names that the store already held. */
  blobs_reused: number;
  /** The snapshots the store holds after the run, newest first. */
  retained: string[];
  pruned: string[];
  blobs_removed: number;
};

/**
 * Back one workspace up. While its server runs: snapshot the database (`VACUUM INTO`), check the snapshot,
 * confirm every blob it names is on disk (otherwise stop: no snapshot is uploaded), upload the blobs the store
 * lacks and verify each by its SHA-256 name, upload the manifest and then the snapshot, last, and prune to the
 * newest `keep` snapshots under the rule of this file.
 */
export async function backupWorkspace(options: BackupOptions): Promise<BackupReport> {
  const { store, keep } = options;
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError("BAD_ARGUMENT", `keep must be a whole number of at least 1, got ${keep}`);
  const prefix = normalizePrefix(options.prefix);
  const lanes = lanesOf(options.concurrency);
  const stage = options.onStage ?? (() => {});
  if (!(await present(options.dbPath))) throw new BackupError("NO_DATABASE", `no room database at ${options.dbPath}`);
  const blobs = new BlobStore(options.blobDir);

  const scratch = await mkdtemp(path.join(options.scratchDir ?? os.tmpdir(), "wolfsdk-backup-"));
  try {
    // 1. The database first.
    const file = path.join(scratch, "snapshot.sqlite");
    takeSnapshot(options.dbPath, file);
    const inspected = inspectDatabase(file, `the snapshot of ${options.dbPath}`);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const id = snapshotId((options.now ?? Date.now)(), sha256Hex(bytes));
    await rm(file);
    await stage("snapshot");

    // 2. Every blob it names must be on disk before anything is uploaded.
    const missing: string[] = [];
    await mapLimit(inspected.blobs, lanes, async (sha) => {
      if (!(await blobs.has(sha))) missing.push(sha);
    });
    if (missing.length > 0) {
      throw new BackupError(
        "BLOB_MISSING",
        `the snapshot names ${missing.length} blobs that are not in ${options.blobDir}: ${sample(missing.sort())}; nothing was uploaded, because a snapshot that names a missing blob could not be restored`,
      );
    }

    // 3. Upload the blobs the store lacks, each verified by its name once it is there.
    const held = new Set(await store.list(`${prefix}blobs/`));
    const upload = inspected.blobs.filter((sha) => !held.has(blobKey(prefix, sha)));
    let uploadedBytes = 0;
    await mapLimit(upload, lanes, async (sha) => {
      uploadedBytes += await uploadBlob(store, blobs, blobKey(prefix, sha), sha);
    });
    const manifest = { format: MANIFEST_FORMAT, snapshot: id, snapshot_sha256: sha256Hex(bytes), schema_version: SCHEMA_VERSION, blobs: inspected.blobs };
    await store.put(manifestKey(prefix, id), new TextEncoder().encode(JSON.stringify(manifest)));
    await stage("blobs");

    // 4. The snapshot object, last.
    await store.put(snapshotKey(prefix, id), bytes);
    await verifyUploaded(store, snapshotKey(prefix, id), sha256Hex(bytes));
    await stage("snapshot-upload");

    // 5. Retention.
    const pruning = await prune({ store, prefix, keep, ours: id, oursNames: new Set(inspected.blobs), scratch, lanes });
    await stage("prune");
    return {
      snapshot: id,
      snapshot_key: snapshotKey(prefix, id),
      snapshot_bytes: bytes.length,
      blobs_named: inspected.blobs.length,
      blobs_uploaded: upload.length,
      blobs_uploaded_bytes: uploadedBytes,
      blobs_reused: inspected.blobs.length - upload.length,
      retained: pruning.retained,
      pruned: pruning.pruned,
      blobs_removed: pruning.blobsRemoved,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Put the local blob `sha256` at `key`, then read it back and compare. Returns the bytes sent. */
async function uploadBlob(store: ObjectStore, blobs: BlobStore, key: string, sha256: string): Promise<number> {
  let bytes: Uint8Array | null;
  try {
    bytes = await blobs.get(sha256);
  } catch (e) {
    if (e instanceof BlobCorrupt) throw new BackupError("BLOB_CORRUPT", `the local blob ${sha256} is damaged, so it is not uploaded: ${e.message}`);
    throw e;
  }
  if (bytes === null) {
    throw new BackupError("BLOB_MISSING", `the blob ${sha256} was removed from the local blob directory during the backup; nothing was uploaded under a snapshot, run it again`);
  }
  await store.put(key, bytes);
  await verifyUploaded(store, key, sha256);
  return bytes.length;
}

/** Read `key` back; an object that is not there or does not hash to `sha256` is removed (it is ours: it was just written) and refused. */
async function verifyUploaded(store: ObjectStore, key: string, sha256: string): Promise<void> {
  const back = await store.get(key);
  const actual = back === null ? null : sha256Hex(back);
  if (actual === sha256) return;
  await store.delete(key).catch(() => {});
  throw new BackupError("UPLOAD_MISMATCH", `${key} read back as ${actual ?? "nothing"}, not ${sha256}`);
}

/**
 * The blobs that may be removed from the store: those a pruned snapshot names that no retained snapshot names.
 * The rule of this file, as a function of the sets alone.
 */
export function blobsToRemove(pruned: readonly ReadonlySet<string>[], retained: readonly ReadonlySet<string>[]): string[] {
  const inUse = new Set<string>();
  for (const names of retained) for (const name of names) inUse.add(name);
  const removable = new Set<string>();
  for (const names of pruned) for (const name of names) if (!inUse.has(name)) removable.add(name);
  return [...removable].sort();
}

/** Remove blobs from the store, after confirming once more that no retained snapshot names any of them. */
async function removeBlobs(store: ObjectStore, prefix: string, shas: readonly string[], retained: readonly ReadonlySet<string>[], lanes: number): Promise<void> {
  for (const sha of shas) {
    if (retained.some((names) => names.has(sha))) throw new BackupError("BLOB_IN_USE", `refusing to remove blob ${sha}: a retained snapshot names it`);
  }
  await mapLimit(shas, lanes, (sha) => store.delete(blobKey(prefix, sha)));
}

/**
 * The blobs snapshot `id` names. From its manifest when that is readable and is the manifest of this snapshot;
 * from the snapshot itself otherwise. Neither: `SNAPSHOT_UNREADABLE`.
 */
async function namedBy(store: ObjectStore, prefix: string, id: string, scratch: string): Promise<Set<string>> {
  const manifest = await store.get(manifestKey(prefix, id));
  if (manifest !== null) {
    const names = parseManifest(manifest, id);
    if (names !== null) return names;
  }
  const bytes = await store.get(snapshotKey(prefix, id));
  if (bytes === null || sha256Hex(bytes).slice(0, 12) !== id.slice(-12)) {
    throw new BackupError(
      "SNAPSHOT_UNREADABLE",
      `what snapshot ${id} names cannot be read (its manifest ${manifest === null ? "is missing" : "is damaged"}, and its snapshot is ${bytes === null ? "missing" : "damaged"}); nothing was removed from the store; ` +
        `delete ${manifestKey(prefix, id)} and ${snapshotKey(prefix, id)} by hand when the snapshot is no longer wanted, and run the backup again`,
    );
  }
  const file = path.join(scratch, `read-${id}.sqlite`);
  try {
    await writeDurable(file, bytes);
    return new Set(inspectDatabase(file, `snapshot ${id}`).blobs);
  } finally {
    await rm(file, { force: true });
  }
}

function parseManifest(bytes: Uint8Array, id: string): Set<string> | null {
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown; snapshot?: unknown; blobs?: unknown };
    if (manifest.format !== MANIFEST_FORMAT || manifest.snapshot !== id || !Array.isArray(manifest.blobs)) return null;
    if (!manifest.blobs.every((name) => typeof name === "string" && isSha256(name))) return null;
    return new Set(manifest.blobs as string[]);
  } catch {
    return null;
  }
}

type Pruning = { retained: string[]; pruned: string[]; blobsRemoved: number };

/**
 * Keep this run's snapshot and the newest `keep - 1` others; remove the rest and the blobs only they named.
 * Order matters: the snapshot objects go first (a snapshot that is gone cannot be restored, and cannot be
 * broken), then the blobs, then the manifests, so that a run that dies half way leaves manifests that the next
 * run finds, reads, and finishes the removal from.
 */
async function prune(args: { store: ObjectStore; prefix: string; keep: number; ours: string; oursNames: Set<string>; scratch: string; lanes: number }): Promise<Pruning> {
  const { store, prefix, keep, ours, lanes } = args;
  const listing = await listBackupObjects(store, prefix);
  const others = listing.snapshots.filter((id) => id !== ours).reverse();
  const keptOthers = others.slice(0, keep - 1);
  const pruned = others.slice(keep - 1);
  // A manifest without a snapshot object: a run that stopped before its last step, or a removal that did.
  const leftovers = listing.manifests.filter((id) => id !== ours && !listing.snapshots.includes(id));
  const retained = [ours, ...keptOthers].sort().reverse();
  if (pruned.length === 0 && leftovers.length === 0) return { retained, pruned: [], blobsRemoved: 0 };

  const retainedNames: Set<string>[] = [args.oursNames];
  for (const id of keptOthers) retainedNames.push(await namedBy(store, prefix, id, args.scratch));
  const goneNames: Set<string>[] = [];
  for (const id of [...pruned, ...leftovers]) goneNames.push(await namedBy(store, prefix, id, args.scratch));
  const removable = blobsToRemove(goneNames, retainedNames);

  for (const id of pruned) await store.delete(snapshotKey(prefix, id));
  await removeBlobs(store, prefix, removable, retainedNames, lanes);
  for (const id of [...pruned, ...leftovers]) await store.delete(manifestKey(prefix, id));
  return { retained, pruned: pruned.slice().reverse(), blobsRemoved: removable.length };
}

// Restore ------------------------------------------------------------------------------------------------------

export type RestoreOptions = {
  store: ObjectStore;
  prefix?: string;
  /** The snapshot id to restore (see `listSnapshots`); default the newest. */
  snapshot?: string;
  /** The database file to create; it, and its `-wal` and `-shm` files, must not exist. */
  dbPath: string;
  /** The blob directory to create; it must be missing or an empty directory. */
  blobDir: string;
  concurrency?: number;
  /** Called, and waited for, after each stage completes. */
  onStage?: (stage: RestoreStage) => void | Promise<void>;
};

export type RestoreStage = "snapshot" | "blobs" | "verify" | "commit";

export type RestoreReport = WorkspaceReport & { snapshot: string; snapshot_bytes: number };

/**
 * Rebuild a workspace from a backup, in an empty place. Everything is built beside the target (`<db>.restore.tmp`,
 * `<blobs>.restore.tmp`), checked, and moved into place at the end: the blob directory first, the database last,
 * because a database is what makes a workspace exist. A failure at any step removes what was built and leaves the
 * target as it was. (A crash between the two moves leaves a populated blob directory and no database; a rerun
 * refuses it, so remove that directory first.)
 *
 * The checks: the snapshot object hashes to its id; `PRAGMA integrity_check` and the foreign keys pass; the schema
 * version is the one this server reads; every blob the database names came out of the store and hashes to its name;
 * and, read back from disk, every one of them is there. The manifest of the snapshot is not consulted: the database
 * is the authority on what it names.
 */
export async function restoreWorkspace(options: RestoreOptions): Promise<RestoreReport> {
  const { store } = options;
  const prefix = normalizePrefix(options.prefix);
  const lanes = lanesOf(options.concurrency);
  const stage = options.onStage ?? (() => {});
  const ids = await listSnapshots(store, prefix);
  const id = options.snapshot ?? ids.at(-1);
  if (id === undefined) throw new BackupError("NO_SNAPSHOT", `the store holds no snapshot${prefix === "" ? "" : ` under ${prefix}`}`);
  if (!ids.includes(id)) throw new BackupError("NO_SNAPSHOT", `the store holds no snapshot ${id}; it holds ${ids.length === 0 ? "none" : sample(ids)}`);

  const dbPath = path.resolve(options.dbPath);
  const blobDir = path.resolve(options.blobDir);
  await requireEmptyTarget(dbPath, blobDir);
  const stagedDb = `${dbPath}.restore.tmp`;
  const stagedBlobs = `${blobDir}.restore.tmp`;
  await mkdir(path.dirname(dbPath), { recursive: true });
  await mkdir(path.dirname(blobDir), { recursive: true });
  // Leftovers of a restore that crashed: they carry the name of this code and are only ever its own.
  await rm(stagedDb, { force: true });
  await rm(stagedBlobs, { recursive: true, force: true });

  try {
    const bytes = await store.get(snapshotKey(prefix, id));
    if (bytes === null) throw new BackupError("NO_SNAPSHOT", `the snapshot object ${snapshotKey(prefix, id)} is gone from the store`);
    if (sha256Hex(bytes).slice(0, 12) !== id.slice(-12)) {
      throw new BackupError("SNAPSHOT_CORRUPT", `${snapshotKey(prefix, id)} does not hash to its id: the snapshot is damaged`);
    }
    await writeDurable(stagedDb, bytes);
    const inspected = inspectDatabase(stagedDb, `snapshot ${id}`);
    await stage("snapshot");

    await mkdir(stagedBlobs, { recursive: true });
    const staging = new BlobStore(stagedBlobs);
    await mapLimit(inspected.blobs, lanes, async (sha) => {
      const body = await store.get(blobKey(prefix, sha));
      if (body === null) throw new BackupError("STORE_BLOB_MISSING", `the store has no object for blob ${sha}, which snapshot ${id} names`);
      if ((await staging.put(body)) !== sha) throw new BackupError("BLOB_CORRUPT", `the stored object for blob ${sha} hashes to something else`);
    });
    await stage("blobs");

    const report = await verifyWorkspace({ dbPath: stagedDb, blobDir: stagedBlobs, concurrency: lanes });
    await stage("verify");

    if (await present(blobDir)) await rmdir(blobDir);
    await rename(stagedBlobs, blobDir);
    try {
      await rename(stagedDb, dbPath);
    } catch (e) {
      await rename(blobDir, stagedBlobs).catch(() => {});
      throw e;
    }
    await syncDirectory(path.dirname(blobDir));
    await syncDirectory(path.dirname(dbPath));
    await stage("commit");
    return { ...report, snapshot: id, snapshot_bytes: bytes.length };
  } finally {
    await rm(stagedDb, { force: true });
    await rm(stagedBlobs, { recursive: true, force: true });
  }
}

/** A restore builds in an empty place: no database (nor the files SQLite keeps beside one, which a new database would adopt), and no blobs. */
async function requireEmptyTarget(dbPath: string, blobDir: string): Promise<void> {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (await present(file)) {
      throw new BackupError("TARGET_NOT_EMPTY", `${file} already exists; a restore builds a workspace in an empty place, so give it a new --db, or move the old files away`);
    }
  }
  if (!(await present(blobDir))) return;
  const info = await lstat(blobDir);
  if (!info.isDirectory()) throw new BackupError("TARGET_NOT_EMPTY", `${blobDir} exists and is not a directory`);
  if ((await readdir(blobDir)).length > 0) {
    throw new BackupError("TARGET_NOT_EMPTY", `${blobDir} is not empty; a restore builds a workspace in an empty place, so give it a new --blobs, or move the old blobs away`);
  }
}
