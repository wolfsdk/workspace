// Retention of revision history. The plan of a customer keeps `retentionDays` days of it (`Plan.retentionDays` of the
// control plane); this module removes the bytes of the revisions older than that, and the blobs nothing names. Run
// it as a command:
//
//   bun packages/server/src/retention.ts --db <rooms.sqlite> --blobs <dir> --days <n|unlimited> [--read-only <reason>] [--enforce] [--json]
//
// Exit codes: 0 the report was printed (with --enforce: and carried out), 2 it could not be made (usage, no
// database, not a room database, the database could not be claimed).
//
// What goes. A document keeps every revision that was its head at some instant of the last `retentionDays` days:
// the one that was the head at the cutoff (`now` less the days) and every one after it. The oldest of them is
// rebuilt by replaying the session log from the newest keyframe at or below it whose blob is stored, so that
// keyframe becomes the floor of the document's history: it and every revision after it stay, past the cutoff or
// not. The revisions below the floor are removed: their bytes go, and nothing can rebuild them. Their session
// entries stay in the database: the room contract numbers the revisions of a document from 1 and chains each to the
// one before, and who changed what, and when, is not the bytes. A floor only rises. It is recorded in
// `history_floors` before any blob is removed, so a run that stops half way leaves blobs nothing needs, which the
// next run removes.
//
// A blob is needed while a head names it, a proposal names it as its preview, or a keyframe or a session entry at or
// above its document's floor names it (`neededBlobs`). Every other blob of the blob directory goes: those only
// removed revisions named, and those nothing names (a put whose commit never came). Revisions with the same bytes
// share one blob, so a blob that a removed revision shares with a kept one stays.
//
// Two modes. Report-only (`retentionReport`, and the command without --enforce) lists the revisions and blobs that
// would go, with their bytes, and writes nothing: not to the database, not beside it, not to the blob directory. It
// reads the database as the usage report does, so it runs beside a live server, where a put whose commit has not
// come yet shows as a blob nothing names. Enforcing (`enforceRetention`) removes what its own report lists, and,
// given an earlier report, only what both list. It claims the database as a server does, so it runs while no server
// serves the workspace: a server puts a blob before it commits the row that names it, and a sweep beside it could
// take bytes that a commit is about to name.
//
// A read-only workspace (its trial ended, or its paid plan lapsed) is not pruned: enforcing removes nothing and
// records no floor, so a customer who resumes has the full history back. Its report still lists what would go.
// Deleting a workspace at the end of its read-only period is the work of deletion, not of retention.
//
// A backup keeps its own copy of every blob its snapshot names, so a snapshot taken before pruning restores the
// history that pruning removed.
import { Database, constants } from "bun:sqlite";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { BlobStore, isSha256, WorkspaceBlobs } from "./blobs.ts";
import { claimDatabase, SCHEMA_VERSION } from "./store.ts";

const DAY_MS = 86_400_000;

export type RetentionErrorCode =
  /** An argument is wrong. */
  | "BAD_ARGUMENT"
  /** There is no file at the database path. */
  | "NO_DATABASE"
  /** The file is not a room database of the schema this server reads. */
  | "NOT_A_ROOM_DATABASE"
  /** Enforcing could not claim the database: a server serves it, or it cannot be served from where it is. */
  | "CLAIM_REFUSED";

export class RetentionError extends Error {
  readonly code: RetentionErrorCode;

  constructor(code: RetentionErrorCode, message: string) {
    super(message);
    this.name = "RetentionError";
    this.code = code;
  }
}

export type RetentionOptions = {
  dbPath: string;
  blobDir: string;
  /** Days of revision history the plan keeps: a whole number of at least 1, or `null` to keep all of it (only blobs
   * nothing names go then). */
  retentionDays: number | null;
  /** The instant the days are counted back from. Default: now. */
  now?: Date;
  /** Set while the workspace is read-only (the mode its server is started with): enforcing removes nothing. */
  readOnly?: { reason: string } | null;
};

/** A revision whose bytes go. */
export type RemovedRevision = {
  revision: number;
  /** When it was committed; `null` for revision 0, which no session entry records. */
  committed_at: string | null;
  /** The blob of its bytes. */
  sha256: string;
  /** The size of that blob when it goes with this run; 0 when a kept revision shares it or it is already gone. */
  bytes: number;
};

/** A document whose history floor rises. */
export type DocumentRetention = {
  room_id: string;
  workspace_id: string;
  doc_name: string;
  head_revision: number;
  /** The first revision of the history before this run, and after it. */
  floor_before: number;
  floor_after: number;
  /** The revisions from `floor_before` up to `floor_after`, oldest first. */
  revisions: RemovedRevision[];
};

/** A blob that goes: one that only removed revisions name, or one that nothing names. */
export type RemovedBlob = { sha256: string; bytes: number; named_by: "removed-revisions" | "nothing" };

export type RetentionReport = {
  mode: "report-only" | "enforce";
  retention_days: number | null;
  /** Revisions that stopped being the head before this instant are past retention; `null` when all history is kept. */
  cutoff: string | null;
  /** Why enforcing removes nothing: the reason the workspace is read-only. `null` when it is not. */
  held: string | null;
  /** Whether what is listed was removed: only an enforcing run that was not held removes. */
  removed: boolean;
  /** The documents whose history floor rises, by room and then document order. */
  documents: DocumentRetention[];
  /** The revisions listed under `documents`. */
  revisions: number;
  /** The blobs that go, by SHA-256. */
  blobs: RemovedBlob[];
  /** The bytes of `blobs`: what the run frees. */
  bytes: number;
};

type Entry = { revision: number; base_sha256: string; result_sha256: string; committed_at: string };

type DocumentHistory = {
  room_id: string;
  workspace_id: string;
  doc_name: string;
  head: { revision: number; sha256: string };
  /** Its session entries, by revision. */
  entries: Entry[];
  /** Its keyframes, by revision. */
  keyframes: Array<{ revision: number; sha256: string }>;
  /** The first revision of its history: 0 until retention raised it. */
  floor: number;
};

type History = { documents: DocumentHistory[]; previews: Set<string> };

const keyOf = (roomId: string, docName: string): string => JSON.stringify([roomId, docName]);

function tablesOf(db: Database): Set<string> {
  return new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
}

function sha(value: unknown, dbPath: string): string {
  if (typeof value !== "string" || !isSha256(value)) {
    throw new RetentionError("NOT_A_ROOM_DATABASE", `${dbPath} names a blob that is not a SHA-256: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The history of every document of `db`, read in one read transaction. */
function historyOf(db: Database, dbPath: string, workspaceId?: string): History {
  const ownTransaction = !db.inTransaction;
  if (ownTransaction) db.exec("BEGIN");
  try {
    const tables = tablesOf(db);
    for (const table of ["meta", "rooms", "documents", "session_log", "proposals"]) {
      if (!tables.has(table)) throw new RetentionError("NOT_A_ROOM_DATABASE", `${dbPath} is not a room database: it has no ${table} table`);
    }
    const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (version !== SCHEMA_VERSION) {
      throw new RetentionError("NOT_A_ROOM_DATABASE", `${dbPath} has schema version ${version ?? "none"}; this server reads ${SCHEMA_VERSION}`);
    }
    const documents = new Map<string, DocumentHistory>();
    const rows = db
      .query<{ room_id: string; workspace_id: string; name: string; revision: number; sha256: unknown }, [string | null, string | null]>(
        "SELECT d.room_id AS room_id, r.workspace_id AS workspace_id, d.name AS name, d.revision AS revision, d.sha256 AS sha256 " +
          "FROM documents AS d JOIN rooms AS r ON r.room_id = d.room_id " +
          "WHERE (? IS NULL OR r.workspace_id = ?) ORDER BY d.room_id, d.ord",
      )
      .all(workspaceId ?? null, workspaceId ?? null);
    for (const row of rows) {
      documents.set(keyOf(row.room_id, row.name), {
        room_id: row.room_id,
        workspace_id: row.workspace_id,
        doc_name: row.name,
        head: { revision: row.revision, sha256: sha(row.sha256, dbPath) },
        entries: [],
        keyframes: [],
        floor: 0,
      });
    }
    const entries = db
      .query<{ room_id: string; doc_name: string; revision: number; base_sha256: unknown; result_sha256: unknown; committed_at: string }, [string | null, string | null]>(
        "SELECT room_id, doc_name, revision, base_sha256, result_sha256, committed_at FROM session_log " +
          "WHERE (? IS NULL OR room_id IN (SELECT room_id FROM rooms WHERE workspace_id = ?)) ORDER BY room_id, doc_name, revision",
      )
      .all(workspaceId ?? null, workspaceId ?? null);
    for (const row of entries) {
      documents.get(keyOf(row.room_id, row.doc_name))?.entries.push({
        revision: row.revision,
        base_sha256: sha(row.base_sha256, dbPath),
        result_sha256: sha(row.result_sha256, dbPath),
        committed_at: row.committed_at,
      });
    }
    // A database written before keyframes were kept has none until a store opens it; its history then has no floor
    // to rise to, and stays whole.
    if (tables.has("keyframes")) {
      const keyframes = db
        .query<{ room_id: string; doc_name: string; revision: number; sha256: unknown }, [string | null, string | null]>(
          "SELECT room_id, doc_name, revision, sha256 FROM keyframes " +
            "WHERE (? IS NULL OR room_id IN (SELECT room_id FROM rooms WHERE workspace_id = ?)) ORDER BY room_id, doc_name, revision",
        )
        .all(workspaceId ?? null, workspaceId ?? null);
      for (const row of keyframes) documents.get(keyOf(row.room_id, row.doc_name))?.keyframes.push({ revision: row.revision, sha256: sha(row.sha256, dbPath) });
    }
    if (tables.has("history_floors")) {
      const floors = db.query<{ room_id: string; doc_name: string; revision: number }, [string | null, string | null]>(
        "SELECT room_id, doc_name, revision FROM history_floors WHERE (? IS NULL OR room_id IN (SELECT room_id FROM rooms WHERE workspace_id = ?))",
      ).all(workspaceId ?? null, workspaceId ?? null);
      for (const row of floors) {
        const document = documents.get(keyOf(row.room_id, row.doc_name));
        if (document !== undefined) document.floor = row.revision;
      }
    }
    const previews = new Set<string>();
    for (const row of db.query<{ name: unknown }, [string | null, string | null]>(
      "SELECT json_extract(body, '$.preview_sha256') AS name FROM proposals WHERE (? IS NULL OR room_id IN (SELECT room_id FROM rooms WHERE workspace_id = ?))",
    ).all(workspaceId ?? null, workspaceId ?? null)) {
      if (row.name !== null) previews.add(sha(row.name, dbPath));
    }
    return { documents: [...documents.values()], previews };
  } finally {
    if (ownTransaction) db.exec("COMMIT");
  }
}

/** The blobs `history` needs with the floors `floors` (by `keyOf`; a document that is not there keeps its own). */
function neededOf(history: History, floors: ReadonlyMap<string, number>): Set<string> {
  const needed = new Set(history.previews);
  for (const document of history.documents) {
    const floor = floors.get(keyOf(document.room_id, document.doc_name)) ?? document.floor;
    needed.add(document.head.sha256);
    for (const entry of document.entries) {
      if (entry.revision >= floor) needed.add(entry.result_sha256);
      // The base of an entry is the bytes of the revision before it.
      if (entry.revision > floor) needed.add(entry.base_sha256);
    }
    for (const keyframe of document.keyframes) if (keyframe.revision >= floor) needed.add(keyframe.sha256);
  }
  return needed;
}

/**
 * The blobs the room database `db` needs, sorted: what a head, a proposal preview, or a keyframe or session entry at
 * or above its document's history floor names. Every other blob of its blob directory may go. Reads only.
 * With `workspaceId`, include only blobs needed by its rooms. Join an existing read transaction when present.
 */
export function neededBlobs(db: Database, workspaceId?: string): string[] {
  const history = historyOf(db, db.filename, workspaceId);
  return [...neededOf(history, new Map())].sort();
}

/** Whether the session entries of a document are its revisions 1 to its head, each based on the one before. Retention
 * moves the floor of no other document: what it would remove is not known. */
function chains(document: DocumentHistory): boolean {
  if (document.entries.length !== document.head.revision) return false;
  for (const [i, entry] of document.entries.entries()) {
    if (entry.revision !== i + 1) return false;
    const prior = document.entries[i - 1];
    if (prior !== undefined && entry.base_sha256 !== prior.result_sha256) return false;
  }
  const last = document.entries.at(-1);
  return last === undefined || last.result_sha256 === document.head.sha256;
}

/** The bytes of revision `revision` of a document whose entries chain. */
function blobOfRevision(document: DocumentHistory, revision: number): string {
  if (revision === 0) return document.entries[0]?.base_sha256 ?? document.head.sha256;
  return (document.entries[revision - 1] as Entry).result_sha256;
}

type Plan = Pick<RetentionReport, "documents" | "revisions" | "blobs" | "bytes"> & { floors: Map<string, number> };

/**
 * What retention removes from `history`, whose blob directory holds `disk` (size by SHA-256), with revisions that
 * stopped being the head before `cutoff` (milliseconds since the epoch; `null`: none) past retention. With `approved`,
 * no floor rises above the one it lists and no blob goes that it does not list.
 */
function planOf(history: History, disk: ReadonlyMap<string, number>, cutoff: number | null, approved: RetentionReport | null): Plan {
  const approvedFloors = new Map((approved?.documents ?? []).map((d) => [keyOf(d.room_id, d.doc_name), d.floor_after]));
  const floors = new Map<string, number>();
  for (const document of history.documents) {
    const key = keyOf(document.room_id, document.doc_name);
    let floor = document.floor;
    if (cutoff !== null && chains(document)) {
      // The revision that was the head at the cutoff: the last one committed at or before it, or revision 0.
      let oldestKept = 0;
      for (const entry of document.entries) if (Date.parse(entry.committed_at) <= cutoff) oldestKept = Math.max(oldestKept, entry.revision);
      // It replays from the newest keyframe at or below it whose bytes are stored, as `reconstructRevision` does.
      for (const keyframe of document.keyframes) {
        if (keyframe.revision <= oldestKept && keyframe.revision > floor && disk.has(keyframe.sha256)) floor = keyframe.revision;
      }
    }
    if (approved !== null) floor = Math.min(floor, Math.max(document.floor, approvedFloors.get(key) ?? document.floor));
    floors.set(key, floor);
  }

  const needed = neededOf(history, floors);
  const approvedBlobs = approved === null ? null : new Set(approved.blobs.map((blob) => blob.sha256));
  const named = neededOf(history, new Map(history.documents.map((d) => [keyOf(d.room_id, d.doc_name), 0])));
  const blobs: RemovedBlob[] = [];
  for (const [name, size] of [...disk].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (needed.has(name) || (approvedBlobs !== null && !approvedBlobs.has(name))) continue;
    blobs.push({ sha256: name, bytes: size, named_by: named.has(name) ? "removed-revisions" : "nothing" });
  }
  const going = new Map(blobs.map((blob) => [blob.sha256, blob.bytes]));

  const documents: DocumentRetention[] = [];
  for (const document of history.documents) {
    const floorAfter = floors.get(keyOf(document.room_id, document.doc_name)) ?? document.floor;
    if (floorAfter <= document.floor) continue;
    const revisions: RemovedRevision[] = [];
    for (let revision = document.floor; revision < floorAfter; revision++) {
      const name = blobOfRevision(document, revision);
      revisions.push({ revision, committed_at: revision === 0 ? null : (document.entries[revision - 1] as Entry).committed_at, sha256: name, bytes: going.get(name) ?? 0 });
    }
    documents.push({
      room_id: document.room_id,
      workspace_id: document.workspace_id,
      doc_name: document.doc_name,
      head_revision: document.head.revision,
      floor_before: document.floor,
      floor_after: floorAfter,
      revisions,
    });
  }
  return {
    documents,
    revisions: documents.reduce((total, d) => total + d.revisions.length, 0),
    blobs,
    bytes: blobs.reduce((total, blob) => total + blob.bytes, 0),
    floors,
  };
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await lstat(file)).size;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** The blobs of the blob directory, by SHA-256, with their sizes: the files stored where `BlobStore` looks for them
 * (`<dir>/<first two hex digits>/<sha256>`). A directory that is not there holds none. */
async function blobsOnDisk(blobDir: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const root = path.resolve(blobDir);
  let folders;
  try {
    folders = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return sizes;
    throw e;
  }
  for (const folder of folders) {
    if (!folder.isDirectory() || !/^[0-9a-f]{2}$/.test(folder.name)) continue;
    for (const entry of await readdir(path.join(root, folder.name), { withFileTypes: true })) {
      if (entry.isFile() && isSha256(entry.name) && entry.name.startsWith(folder.name)) {
        sizes.set(entry.name, (await lstat(path.join(root, folder.name, entry.name))).size);
      }
    }
  }
  return sizes;
}

function checkedOptions(options: RetentionOptions): { cutoff: number | null; held: string | null } {
  const { retentionDays } = options;
  if (retentionDays !== null && !(Number.isSafeInteger(retentionDays) && retentionDays >= 1)) {
    throw new RetentionError("BAD_ARGUMENT", `retention is a whole number of days, 1 or more, or null to keep all history; not ${retentionDays}`);
  }
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new RetentionError("BAD_ARGUMENT", "now is not a valid instant");
  const reason = options.readOnly?.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim().length === 0)) {
    throw new RetentionError("BAD_ARGUMENT", "a read-only workspace is given with the reason it is read-only");
  }
  return { cutoff: retentionDays === null ? null : now - retentionDays * DAY_MS, held: reason ?? null };
}

function reportOf(mode: RetentionReport["mode"], options: RetentionOptions, cutoff: number | null, held: string | null, removed: boolean, plan: Plan): RetentionReport {
  return {
    mode,
    retention_days: options.retentionDays,
    cutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
    held,
    removed,
    documents: plan.documents,
    revisions: plan.revisions,
    blobs: plan.blobs,
    bytes: plan.bytes,
  };
}

function readHistory(file: string, immutable: boolean, dbPath: string): History {
  let db: Database | undefined;
  try {
    db = immutable
      ? new Database(`${pathToFileURL(file).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
      : new Database(file, { readonly: true });
    // A server that is starting or checkpointing on this file may hold it for a moment.
    if (!immutable) db.exec("PRAGMA busy_timeout = 5000");
    return historyOf(db, dbPath);
  } catch (e) {
    if (e instanceof RetentionError) throw e;
    throw new RetentionError("NOT_A_ROOM_DATABASE", `${dbPath} is not a readable room database: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db?.close();
  }
}

/**
 * Report-only: what retention would remove from the workspace whose room database is `dbPath` and whose blobs are in
 * `blobDir`. Writes nothing. A database with a write-ahead log (a server has it open) is read through the index its
 * server keeps; one without is opened immutable, since an ordinary read-only connection would leave a log and an
 * index beside it, and read again the ordinary way should a log appear meanwhile.
 */
export async function retentionReport(options: RetentionOptions): Promise<RetentionReport> {
  const { cutoff, held } = checkedOptions(options);
  const file = path.resolve(options.dbPath);
  if ((await sizeOf(file)) === null) throw new RetentionError("NO_DATABASE", `there is no database at ${options.dbPath}`);
  let history: History;
  if ((await sizeOf(`${file}-wal`)) !== null) {
    history = readHistory(file, false, options.dbPath);
  } else {
    history = readHistory(file, true, options.dbPath);
    if ((await sizeOf(`${file}-wal`)) !== null) history = readHistory(file, false, options.dbPath);
  }
  const disk = await blobsOnDisk(options.blobDir);
  return reportOf("report-only", options, cutoff, held, false, planOf(history, disk, cutoff, null));
}

/**
 * Enforcing: remove what retention removes from the workspace, and return the report of what that was. With
 * `approved` (an earlier report, of either mode), only what it lists goes, and only as far as it is still not needed:
 * a revision committed since may have brought back the bytes of one it lists. A read-only workspace (`readOnly`) has
 * nothing removed and no floor recorded; the report still lists what would have gone, with `removed` false.
 *
 * The database is claimed for the run, as a server claims it, and the claim is refused while a server holds it.
 * The floors are committed before the first blob is removed.
 */
export async function enforceRetention(options: RetentionOptions & { approved?: RetentionReport }): Promise<RetentionReport> {
  const { cutoff, held } = checkedOptions(options);
  const file = path.resolve(options.dbPath);
  if ((await sizeOf(file)) === null) throw new RetentionError("NO_DATABASE", `there is no database at ${options.dbPath}`);
  let release: () => void;
  try {
    release = claimDatabase(file);
  } catch (e) {
    throw new RetentionError("CLAIM_REFUSED", `retention could not claim ${options.dbPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let db: Database | undefined;
  try {
    try {
      db = new Database(file, { readwrite: true });
      db.exec("PRAGMA busy_timeout = 5000");
    } catch (e) {
      throw new RetentionError("NOT_A_ROOM_DATABASE", `${options.dbPath} is not a readable room database: ${e instanceof Error ? e.message : String(e)}`);
    }
    const history = historyOf(db, options.dbPath);
    const disk = await blobsOnDisk(options.blobDir);
    const plan = planOf(history, disk, cutoff, options.approved ?? null);
    if (held !== null) return reportOf("enforce", options, cutoff, held, false, plan);

    const raised = plan.documents.filter((d) => d.floor_after > d.floor_before);
    if (raised.length > 0) {
      const at = new Date().toISOString();
      const target = db;
      target.exec(
        "CREATE TABLE IF NOT EXISTS history_floors (room_id TEXT NOT NULL, doc_name TEXT NOT NULL, revision INTEGER NOT NULL, raised_at TEXT NOT NULL, PRIMARY KEY (room_id, doc_name)) WITHOUT ROWID",
      );
      const raise = target.query(
        "INSERT INTO history_floors (room_id, doc_name, revision, raised_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT (room_id, doc_name) DO UPDATE SET revision = excluded.revision, raised_at = excluded.raised_at WHERE excluded.revision > history_floors.revision",
      );
      target.transaction(() => {
        for (const d of raised) raise.run(d.room_id, d.doc_name, d.floor_after, at);
      })();
    }

    const store = new BlobStore(options.blobDir);
    // The charges of the workspaces go with the bytes, through the accounting that keeps them, when it keeps any.
    const charges = tablesOf(db).has("blob_charges") ? new WorkspaceBlobs(store, db, { quota: null }) : null;
    const chargedTo = charges === null ? null : db.query<{ workspace_id: string }, [string]>("SELECT workspace_id FROM blob_charges WHERE sha256 = ?");
    for (const blob of plan.blobs) {
      for (const { workspace_id } of chargedTo?.all(blob.sha256) ?? []) await charges?.delete(workspace_id, blob.sha256);
      await store.remove(blob.sha256);
    }
    return reportOf("enforce", options, cutoff, null, true, plan);
  } finally {
    db?.close();
    release();
  }
}

// Command ------------------------------------------------------------------------------------------------------

export const RETENTION_HELP = `retention: list, or remove, the revisions older than the plan keeps and the blobs nothing needs

  bun packages/server/src/retention.ts --db <file> --blobs <dir> --days <n|unlimited> [--read-only <reason>] [--enforce] [--json]

--db <file>           the room database of the workspace
--blobs <dir>         the blob directory of the workspace
--days <n>            days of revision history the plan keeps; unlimited keeps all of it
--read-only <reason>  the workspace is read-only: --enforce removes nothing
--enforce             remove what the report lists; the server of the workspace must be stopped
--json                print the report as JSON`;

export type RetentionIo = { out(text: string): void; err(text: string): void };

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The report as lines for a person. */
export function formatRetention(report: RetentionReport): string {
  const lines = [
    report.cutoff === null
      ? "retention  all history is kept"
      : `retention  ${plural(report.retention_days ?? 0, "day")}: revisions that stopped being the head before ${report.cutoff} are past it`,
  ];
  if (report.held !== null) lines.push(`held       the workspace is read-only (${report.held}); nothing is removed`);
  const history = report.blobs.filter((blob) => blob.named_by === "removed-revisions").reduce((total, blob) => total + blob.bytes, 0);
  lines.push(
    `${report.removed ? "removed   " : "would go  "} ${plural(report.revisions, "revision")} of ${plural(report.documents.length, "document")}, ${plural(report.blobs.length, "blob")}, ${report.bytes} bytes (${history} of history, ${report.bytes - history} that nothing names)`,
  );
  for (const d of report.documents) {
    lines.push(`document   ${d.room_id}/${d.doc_name}: revisions ${d.floor_before} to ${d.floor_after - 1}; its history starts at ${d.floor_after} (head ${d.head_revision})`);
  }
  for (const blob of report.blobs) lines.push(`blob       ${blob.sha256} ${blob.bytes} bytes, ${blob.named_by === "nothing" ? "named by nothing" : "named by removed revisions"}`);
  return lines.join("\n");
}

/** Run the command with `args` (without the program); returns the exit code. */
export async function runRetention(args: string[], io: RetentionIo): Promise<number> {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: {
          db: { type: "string" },
          blobs: { type: "string" },
          days: { type: "string" },
          "read-only": { type: "string" },
          enforce: { type: "boolean" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }));
    } catch (e) {
      throw new RetentionError("BAD_ARGUMENT", e instanceof Error ? e.message : String(e));
    }
    if (values.help) {
      io.out(RETENTION_HELP);
      return 0;
    }
    if (values.db === undefined || values.blobs === undefined || values.days === undefined) throw new RetentionError("BAD_ARGUMENT", "retention needs --db, --blobs and --days");
    const days = values.days === "unlimited" ? null : /^[0-9]+$/.test(values.days) ? Number(values.days) : Number.NaN;
    const options: RetentionOptions = {
      dbPath: values.db,
      blobDir: values.blobs,
      retentionDays: days,
      readOnly: values["read-only"] === undefined ? null : { reason: values["read-only"] },
    };
    const report = values.enforce ? await enforceRetention(options) : await retentionReport(options);
    io.out(values.json ? JSON.stringify(report, null, 2) : formatRetention(report));
    return 0;
  } catch (e) {
    if (!(e instanceof RetentionError)) throw e;
    io.err(`retention: ${e.message}`);
    if (e.code === "BAD_ARGUMENT") io.err(RETENTION_HELP);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await runRetention(Bun.argv.slice(2), { out: (text) => console.log(text), err: (text) => console.error(text) }));
}
