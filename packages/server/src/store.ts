// SQLite persistence of everything a room is, except document bytes (those are blobs). All methods are
// synchronous: a caller groups them in `transaction` and the group is stored whole or not at all. The store
// knows the shape of the data and nothing about its rules; `RoomServer` owns the rules and validates what it
// builds with the protocol validators.
//
// History is kept as keyframes plus the edit log. A keyframe is a revision whose full bytes history keeps; a
// revision between two keyframes is rebuilt by replaying the session log's pinned batches on the keyframe at or
// below it (`reconstructRevision`). Which blobs may then go is for retention to decide; the keyframes and the
// heads are what it must keep.
import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import type {
  RoomActor,
  RoomDocument,
  RoomHead,
  RoomProposal,
  RoomServerEvent,
  RoomSessionEntry,
  RoomState,
  RoomThread,
  WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";
import { ROOM_CONTRACT } from "@wolfsdk/protocol/workspace";
import type { BlobStore } from "./blobs.ts";
import type { DocumentEngine } from "./engine.ts";
import { sha256Hex } from "./hash.ts";

/** The schema version this server reads and writes; a backup of another version is refused by restore. The
 * `keyframes` table did not change it: a database without one gets it, filled from its session log, when a store
 * opens it, and a server that does not know the table leaves it alone. */
export const SCHEMA_VERSION = "2";

/**
 * How many revisions apart history keeps a full copy of a document: revision 0, and from then on the first head at
 * least this many revisions past the keyframe before it (with one batch a commit, every Nth revision). Every
 * revision in between is rebuilt by replaying at most N - 1 batches, plus the other batches of the commit that
 * landed the next keyframe. N is set by replay time measured through `wolf reactor-serve` on the recorded sessions
 * and on long edit chains of the fixtures, on a loaded host: the largest N whose slowest replay of N - 1 batches,
 * predicted from a line through the slowest repetition at each length, stays within 250 ms for every history in
 * every recorded run. That is a quarter of a one-second budget for opening an old revision; the rest is headroom for
 * documents larger than the fixtures and for slower hosts. DOCX, the slowest format per batch, sets it. The
 * scenario, the host load and the numbers are in `evidence/ltg-ws-cloud-history-keyframes-20261113.measure.json`.
 */
export const HISTORY_KEYFRAME_INTERVAL = 34;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS documents (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  name TEXT NOT NULL,
  ord INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  page_hashes TEXT,
  PRIMARY KEY (room_id, name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_log (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  seq INTEGER NOT NULL,
  doc_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_sha256 TEXT NOT NULL,
  result_sha256 TEXT NOT NULL,
  author TEXT NOT NULL,
  batch TEXT NOT NULL,
  proposal_id TEXT,
  approved_by TEXT,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, doc_name, revision)
) WITHOUT ROWID;

-- The revisions of a document whose full bytes history keeps, and the blob that holds them. Only a head is ever
-- named: its bytes were stored before the commit that made it the head.
CREATE TABLE IF NOT EXISTS keyframes (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  doc_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (room_id, doc_name, revision)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS proposals (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  proposal_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  doc_name TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (room_id, proposal_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS threads (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  thread_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (room_id, thread_id)
) WITHOUT ROWID;

-- The events a reconnecting client may replay.
CREATE TABLE IF NOT EXISTS events (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
) WITHOUT ROWID;

-- A seat belongs to an identity, and an identity is a kind and an id: a user and an agent may share an id.
CREATE TABLE IF NOT EXISTS seats (
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;
`;

export type RoomRow = { room_id: string; workspace_id: string; seq: number };
export type SeatRow = { kind: RoomActor["kind"]; id: string; name: string; first_seen_at: string };
export type StoredEvent = { seq: number; event: RoomServerEvent };
/** A revision of a document whose full bytes history keeps, in the blob `sha256`. */
export type Keyframe = { revision: number; sha256: string };

export type RoomStoreOptions = {
  /** How many revisions apart keyframes are recorded. Default `HISTORY_KEYFRAME_INTERVAL`. */
  keyframeInterval?: number;
};

type DocumentRow = {
  name: string;
  revision: number;
  sha256: string;
  format: WorkspaceDocFormat;
  updated_at: string;
  page_hashes: string | null;
};

type EntryRow = {
  seq: number;
  doc_name: string;
  revision: number;
  base_sha256: string;
  result_sha256: string;
  author: string;
  batch: string;
  proposal_id: string | null;
  approved_by: string | null;
  committed_at: string;
};

const ENTRY_COLUMNS = "seq, doc_name, revision, base_sha256, result_sha256, author, batch, proposal_id, approved_by, committed_at";

function documentOf(row: DocumentRow): RoomDocument {
  const head: RoomHead = { revision: row.revision, sha256: row.sha256, format: row.format, name: row.name, updated_at: row.updated_at };
  return row.page_hashes === null ? { head } : { head, page_hashes: JSON.parse(row.page_hashes) as string[] };
}

function entryOf(row: EntryRow): RoomSessionEntry {
  return {
    seq: row.seq,
    doc_name: row.doc_name,
    revision: row.revision,
    base_sha256: row.base_sha256,
    result_sha256: row.result_sha256,
    author: JSON.parse(row.author) as RoomActor,
    batch: JSON.parse(row.batch) as RoomSessionEntry["batch"],
    proposal_id: row.proposal_id,
    approved_by: row.approved_by === null ? null : (JSON.parse(row.approved_by) as RoomActor),
    committed_at: row.committed_at,
  };
}

/** The file SQLite opens for `dbPath`, every symbolic link on the way followed; an empty database is created
 * there when none exists yet. SQLite is asked, because the claim belongs beside the file the server will write
 * and SQLite alone decides which file that is: one at the far end of a link that points at nothing, one behind
 * a `..` that leads out of a linked directory. A path worked out here could differ from it; `realpath` on Bun
 * 1.4.0 does, by tidying `..` as text. */
function databaseFile(dbPath: string): string {
  const db = new Database(dbPath, { create: true });
  try {
    return (db.query("PRAGMA database_list").get() as { file: string }).file;
  } finally {
    db.close();
  }
}

/** The mount table of this process as Linux prints it, or nothing where there is none to read. */
function mountTable(): string {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

/** Whether the file `database` is itself a mount point in `mountinfo`: one file mounted from elsewhere, as a
 * container does with a single-file bind mount. */
function mountedAlone(database: string, mountinfo: string): boolean {
  for (const line of mountinfo.split("\n")) {
    // The fifth field is the mount point, with space, tab, newline and backslash written as `\` and three octal digits.
    const point = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (point === database) return true;
  }
  return false;
}

/** Claim the room database at `dbPath` for one server, or throw when another server holds it: two servers on one
 * database would each count seats, room ids and `seq` on their own. The claim is an exclusive SQLite lock on
 * `<database>.lock` beside the file SQLite opens for `dbPath` (a symbolic link to a database is that database,
 * also before the database exists), which the operating system frees when the process ends, however it ends.
 * The claim holds only where every server sees that same lock file, so two kinds of database are refused. One
 * with a second hard link: a server on the other name would claim, and write ahead, beside that name. One that
 * is mounted as a single file (`mountinfo`, the mount table of this process): each container it is mounted into
 * would claim, and write ahead, in a folder of its own. The database itself stays open to other connections: a
 * backup, or the `seats` command of the CLI. Returns the release. */
export function claimDatabase(dbPath: string, mountinfo: string = mountTable()): () => void {
  const database = databaseFile(dbPath);
  const names = statSync(database).nlink;
  if (names > 1) {
    throw new Error(`${dbPath} has ${names} hard links, and a room database is served under one name; remove the other links, or serve a copy`);
  }
  if (mountedAlone(database, mountinfo)) {
    throw new Error(`${dbPath} is mounted as a single file, and a room database is served from a folder that holds its lock and its write-ahead log too; mount the folder that holds it`);
  }
  const lockPath = `${database}.lock`;
  const lock = new Database(lockPath, { create: true });
  try {
    // One statement a call: Bun before 1.4.4 runs on past a statement that fails and reports the last failure.
    lock.exec("PRAGMA locking_mode = EXCLUSIVE");
    lock.exec("BEGIN EXCLUSIVE");
    lock.exec("COMMIT");
  } catch (e) {
    lock.close();
    if (e instanceof Error && "code" in e && e.code === "SQLITE_BUSY") {
      throw new Error(`${dbPath} is already served by another room server (it holds ${lockPath})`);
    }
    throw e;
  }
  return () => lock.close();
}

/** Whether the file at `dbPath` is a room database. Opens it read-only and leaves it as it is. */
export function isRoomDatabase(dbPath: string): boolean {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    // A server that is starting or stopping on this file may hold it for a moment.
    db.exec("PRAGMA busy_timeout = 5000");
    return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seats'").get() !== null;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export class RoomStore {
  private readonly db: Database;
  private readonly keyframeInterval: number;

  constructor(dbPath: string, options: RoomStoreOptions = {}) {
    const interval = options.keyframeInterval ?? HISTORY_KEYFRAME_INTERVAL;
    if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError(`keyframeInterval must be a positive integer, not ${interval}`);
    this.keyframeInterval = interval;
    this.db = new Database(dbPath, { create: true, strict: true });
    // A commit that returned survives power loss. The bytes a head or a proposal names are put (and synced) in
    // the blob store before the row that names them is committed here, so the database never names bytes the
    // disk does not have. Another connection may hold the write lock for a moment (the `seats` command of the
    // CLI frees a seat while the server runs): wait for it instead of failing the request.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const version = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("schema_version");
    if (version === null) {
      this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    } else if (version.value !== SCHEMA_VERSION) {
      throw new Error(`room database has schema version ${version.value}; this server reads ${SCHEMA_VERSION}`);
    }
    this.backfillKeyframes();
  }

  close(): void {
    this.db.close();
  }

  /** Run `work` as one transaction: stored whole when it returns, not at all when it throws. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // Rooms ------------------------------------------------------------------------------------------------

  room(roomId: string): RoomRow | null {
    return this.db.query<RoomRow, [string]>("SELECT room_id, workspace_id, seq FROM rooms WHERE room_id = ?").get(roomId);
  }

  rooms(): RoomRow[] {
    return this.db.query<RoomRow, []>("SELECT room_id, workspace_id, seq FROM rooms ORDER BY created_at, room_id").all();
  }

  workspaceCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(DISTINCT workspace_id) AS n FROM rooms").get()?.n ?? 0;
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.db.query("SELECT 1 FROM rooms WHERE workspace_id = ? LIMIT 1").get(workspaceId) !== null;
  }

  insertRoom(roomId: string, workspaceId: string, createdAt: string): void {
    this.db.query("INSERT INTO rooms (room_id, workspace_id, seq, created_at) VALUES (?, ?, 0, ?)").run(roomId, workspaceId, createdAt);
  }

  /** The next `seq` of the room: stored, and returned. */
  bumpSeq(roomId: string): number {
    const row = this.db.query<{ seq: number }, [string]>("UPDATE rooms SET seq = seq + 1 WHERE room_id = ? RETURNING seq").get(roomId);
    if (row === null) throw new Error(`room ${roomId} does not exist`);
    return row.seq;
  }

  // Documents --------------------------------------------------------------------------------------------

  document(roomId: string, name: string): RoomDocument | null {
    const row = this.db
      .query<DocumentRow, [string, string]>(
        "SELECT name, revision, sha256, format, updated_at, page_hashes FROM documents WHERE room_id = ? AND name = ?",
      )
      .get(roomId, name);
    return row === null ? null : documentOf(row);
  }

  documents(roomId: string): RoomDocument[] {
    return this.db
      .query<DocumentRow, [string]>("SELECT name, revision, sha256, format, updated_at, page_hashes FROM documents WHERE room_id = ? ORDER BY ord")
      .all(roomId)
      .map(documentOf);
  }

  /** Add a document. Its first head is its first keyframe. */
  insertDocument(roomId: string, document: RoomDocument): void {
    const { head, page_hashes } = document;
    const ord = this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM documents WHERE room_id = ?").get(roomId)?.n ?? 0;
    this.db
      .query("INSERT INTO documents (room_id, name, ord, revision, sha256, format, updated_at, page_hashes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(roomId, head.name, ord, head.revision, head.sha256, head.format, head.updated_at, page_hashes ? JSON.stringify(page_hashes) : null);
    this.insertKeyframe(roomId, head.name, { revision: head.revision, sha256: head.sha256 });
  }

  /** Move a document's head. `pageHashes` `null` forgets the page hashes (the engine had none to give). The new head
   * becomes a keyframe when it is at least `keyframeInterval` revisions past the document's last one. */
  setHead(roomId: string, head: RoomHead, pageHashes: string[] | null): void {
    this.db
      .query("UPDATE documents SET revision = ?, sha256 = ?, updated_at = ?, page_hashes = ? WHERE room_id = ? AND name = ?")
      .run(head.revision, head.sha256, head.updated_at, pageHashes ? JSON.stringify(pageHashes) : null, roomId, head.name);
    const last = this.db
      .query<{ revision: number | null }, [string, string]>("SELECT MAX(revision) AS revision FROM keyframes WHERE room_id = ? AND doc_name = ?")
      .get(roomId, head.name)?.revision;
    if (last === null || last === undefined || head.revision - last >= this.keyframeInterval) {
      this.insertKeyframe(roomId, head.name, { revision: head.revision, sha256: head.sha256 });
    }
  }

  // History ----------------------------------------------------------------------------------------------

  /** The keyframes of a document, oldest first. */
  keyframes(roomId: string, docName: string): Keyframe[] {
    return this.db
      .query<Keyframe, [string, string]>("SELECT revision, sha256 FROM keyframes WHERE room_id = ? AND doc_name = ? ORDER BY revision")
      .all(roomId, docName);
  }

  /** The session entries of a document with a revision above `after` and at most `through`, in order: what is
   * replayed on revision `after` to rebuild revision `through`. */
  entriesBetween(roomId: string, docName: string, after: number, through: number): RoomSessionEntry[] {
    return this.db
      .query<EntryRow, [string, string, number, number]>(
        `SELECT ${ENTRY_COLUMNS} FROM session_log WHERE room_id = ? AND doc_name = ? AND revision > ? AND revision <= ? ORDER BY revision`,
      )
      .all(roomId, docName, after, through)
      .map(entryOf);
  }

  private insertKeyframe(roomId: string, docName: string, keyframe: Keyframe): void {
    this.db
      .query("INSERT OR IGNORE INTO keyframes (room_id, doc_name, revision, sha256) VALUES (?, ?, ?, ?)")
      .run(roomId, docName, keyframe.revision, keyframe.sha256);
  }

  /** Give every document without a keyframe the ones `insertDocument` and `setHead` would have recorded: a database
   * written before keyframes were kept has none. Revision 0 is the base of the first entry (or the head, when nothing
   * was committed). Only the head of a commit can be a keyframe, since only its bytes were stored: the last entry of
   * a run that shares `committed_at`, which is the time every entry of one commit carries. */
  private backfillKeyframes(): void {
    const documents = this.db
      .query<{ room_id: string; name: string; revision: number; sha256: string }, []>(
        "SELECT room_id, name, revision, sha256 FROM documents AS d WHERE NOT EXISTS (SELECT 1 FROM keyframes AS k WHERE k.room_id = d.room_id AND k.doc_name = d.name)",
      )
      .all();
    if (documents.length === 0) return;
    this.transaction(() => {
      for (const document of documents) {
        const entries = this.db
          .query<{ revision: number; base_sha256: string; result_sha256: string; committed_at: string }, [string, string]>(
            "SELECT revision, base_sha256, result_sha256, committed_at FROM session_log WHERE room_id = ? AND doc_name = ? ORDER BY revision",
          )
          .all(document.room_id, document.name);
        const first = entries[0];
        let last: Keyframe = first === undefined ? { revision: document.revision, sha256: document.sha256 } : { revision: first.revision - 1, sha256: first.base_sha256 };
        this.insertKeyframe(document.room_id, document.name, last);
        for (const [i, entry] of entries.entries()) {
          if (entries[i + 1]?.committed_at === entry.committed_at) continue;
          if (entry.revision - last.revision < this.keyframeInterval) continue;
          last = { revision: entry.revision, sha256: entry.result_sha256 };
          this.insertKeyframe(document.room_id, document.name, last);
        }
      }
    });
  }

  // Session log ------------------------------------------------------------------------------------------

  sessionLog(roomId: string): RoomSessionEntry[] {
    return this.db
      .query<EntryRow, [string]>(`SELECT ${ENTRY_COLUMNS} FROM session_log WHERE room_id = ? ORDER BY seq`)
      .all(roomId)
      .map(entryOf);
  }

  appendEntry(roomId: string, entry: RoomSessionEntry): void {
    this.db
      .query(
        "INSERT INTO session_log (room_id, seq, doc_name, revision, base_sha256, result_sha256, author, batch, proposal_id, approved_by, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        roomId,
        entry.seq,
        entry.doc_name,
        entry.revision,
        entry.base_sha256,
        entry.result_sha256,
        JSON.stringify(entry.author),
        JSON.stringify(entry.batch),
        entry.proposal_id,
        entry.approved_by === null ? null : JSON.stringify(entry.approved_by),
        entry.committed_at,
      );
  }

  // Proposals --------------------------------------------------------------------------------------------

  proposal(roomId: string, proposalId: string): RoomProposal | null {
    const row = this.db.query<{ body: string }, [string, string]>("SELECT body FROM proposals WHERE room_id = ? AND proposal_id = ?").get(roomId, proposalId);
    return row === null ? null : (JSON.parse(row.body) as RoomProposal);
  }

  proposals(roomId: string): RoomProposal[] {
    return this.db
      .query<{ body: string }, [string]>("SELECT body FROM proposals WHERE room_id = ? ORDER BY ord")
      .all(roomId)
      .map((row) => JSON.parse(row.body) as RoomProposal);
  }

  openProposals(roomId: string, docName: string): RoomProposal[] {
    return this.db
      .query<{ body: string }, [string, string]>("SELECT body FROM proposals WHERE room_id = ? AND doc_name = ? AND status = 'open' ORDER BY ord")
      .all(roomId, docName)
      .map((row) => JSON.parse(row.body) as RoomProposal);
  }

  insertProposal(roomId: string, proposal: RoomProposal): void {
    const ord = this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM proposals WHERE room_id = ?").get(roomId)?.n ?? 0;
    this.db
      .query("INSERT INTO proposals (room_id, proposal_id, ord, doc_name, status, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(roomId, proposal.proposal_id, ord, proposal.doc_name, proposal.status, JSON.stringify(proposal));
  }

  saveProposal(roomId: string, proposal: RoomProposal): void {
    this.db
      .query("UPDATE proposals SET status = ?, body = ? WHERE room_id = ? AND proposal_id = ?")
      .run(proposal.status, JSON.stringify(proposal), roomId, proposal.proposal_id);
  }

  // Threads ----------------------------------------------------------------------------------------------

  thread(roomId: string, threadId: string): RoomThread | null {
    const row = this.db.query<{ body: string }, [string, string]>("SELECT body FROM threads WHERE room_id = ? AND thread_id = ?").get(roomId, threadId);
    return row === null ? null : (JSON.parse(row.body) as RoomThread);
  }

  threads(roomId: string): RoomThread[] {
    return this.db
      .query<{ body: string }, [string]>("SELECT body FROM threads WHERE room_id = ? ORDER BY ord")
      .all(roomId)
      .map((row) => JSON.parse(row.body) as RoomThread);
  }

  insertThread(roomId: string, thread: RoomThread): void {
    const ord = this.db.query<{ n: number }, [string]>("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM threads WHERE room_id = ?").get(roomId)?.n ?? 0;
    this.db.query("INSERT INTO threads (room_id, thread_id, ord, body) VALUES (?, ?, ?, ?)").run(roomId, thread.thread_id, ord, JSON.stringify(thread));
  }

  saveThread(roomId: string, thread: RoomThread): void {
    this.db.query("UPDATE threads SET body = ? WHERE room_id = ? AND thread_id = ?").run(JSON.stringify(thread), roomId, thread.thread_id);
  }

  // Events -----------------------------------------------------------------------------------------------

  appendEvent(roomId: string, event: RoomServerEvent & { seq: number }): void {
    this.db.query("INSERT INTO events (room_id, seq, body) VALUES (?, ?, ?)").run(roomId, event.seq, JSON.stringify(event));
  }

  /** The retained rows with `seq` above `since`, in order. */
  eventsAfter(roomId: string, since: number): StoredEvent[] {
    return this.db
      .query<{ seq: number; body: string }, [string, number]>("SELECT seq, body FROM events WHERE room_id = ? AND seq > ? ORDER BY seq")
      .all(roomId, since)
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.body) as RoomServerEvent }));
  }

  /** Forget the rows with `seq` at or below `through`. */
  pruneEvents(roomId: string, through: number): void {
    this.db.query("DELETE FROM events WHERE room_id = ? AND seq <= ?").run(roomId, through);
  }

  // Seats ------------------------------------------------------------------------------------------------

  hasSeat(kind: SeatRow["kind"], id: string): boolean {
    return this.db.query("SELECT 1 FROM seats WHERE kind = ? AND id = ?").get(kind, id) !== null;
  }

  seatCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM seats").get()?.n ?? 0;
  }

  seats(): SeatRow[] {
    return this.db.query<SeatRow, []>("SELECT kind, id, name, first_seen_at FROM seats ORDER BY first_seen_at, kind, id").all();
  }

  addSeat(seat: SeatRow): void {
    this.db.query("INSERT INTO seats (kind, id, name, first_seen_at) VALUES (?, ?, ?, ?)").run(seat.kind, seat.id, seat.name, seat.first_seen_at);
  }

  removeSeat(kind: SeatRow["kind"], id: string): boolean {
    return this.db.query("DELETE FROM seats WHERE kind = ? AND id = ?").run(kind, id).changes > 0;
  }

  // Snapshot ---------------------------------------------------------------------------------------------

  /** The room as stored. Whether it is a valid `wolfsdk.room.v1` state is for the caller to check. */
  snapshot(roomId: string): RoomState | null {
    const room = this.room(roomId);
    if (room === null) return null;
    return {
      contract: ROOM_CONTRACT,
      room_id: room.room_id,
      workspace_id: room.workspace_id,
      seq: room.seq,
      documents: this.documents(roomId),
      session_log: this.sessionLog(roomId),
      proposals: this.proposals(roomId),
      comments: this.threads(roomId),
    };
  }
}

/** Where `reconstructRevision` reads bytes from and replays batches with. */
export type HistorySources = { blobs: Pick<BlobStore, "get">; engine: Pick<DocumentEngine, "replay"> };

/**
 * The bytes of revision `revision` of a document. The head is read as it is. Any other revision is rebuilt from the
 * nearest keyframe at or below it whose blob is stored, by replaying the pinned batches of the session entries after
 * it, in one engine call; a keyframe whose blob is gone (retention removed it, or it was never stored) passes the
 * work to the keyframe before it. Every step the engine reports must give the bytes the session log names, so what
 * comes back is byte for byte the revision that was committed. Throws when the revision does not exist, when the log
 * does not chain from the keyframe, when the replay gives other bytes, and when no keyframe at or below the revision
 * has its bytes stored.
 */
export async function reconstructRevision(
  store: RoomStore,
  sources: HistorySources,
  roomId: string,
  docName: string,
  revision: number,
): Promise<Uint8Array> {
  const document = store.document(roomId, docName);
  if (document === null) throw new Error(`document ${docName} does not exist in ${roomId}`);
  const { head } = document;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > head.revision) {
    throw new RangeError(`${docName} in ${roomId} has revisions 0 to ${head.revision}; ${revision} is not one of them`);
  }
  const candidates = store
    .keyframes(roomId, docName)
    .filter((keyframe) => keyframe.revision <= revision)
    .reverse();
  if (revision === head.revision) candidates.unshift({ revision, sha256: head.sha256 });
  const missing: string[] = [];
  for (const keyframe of candidates) {
    const bytes = await sources.blobs.get(keyframe.sha256);
    if (bytes === null) {
      missing.push(`revision ${keyframe.revision} (${keyframe.sha256})`);
      continue;
    }
    if (keyframe.revision === revision) return bytes;
    const entries = store.entriesBetween(roomId, docName, keyframe.revision, revision);
    let at = keyframe.sha256;
    for (const [i, entry] of entries.entries()) {
      if (entry.revision !== keyframe.revision + i + 1 || entry.base_sha256 !== at) {
        throw new Error(`the session log of ${docName} in ${roomId} does not chain from keyframe ${keyframe.revision} to revision ${revision}: entry ${entry.revision} is based on ${entry.base_sha256}, not ${at}`);
      }
      at = entry.result_sha256;
    }
    if (entries.length !== revision - keyframe.revision) {
      throw new Error(`the session log of ${docName} in ${roomId} holds ${entries.length} of the ${revision - keyframe.revision} entries after keyframe ${keyframe.revision}`);
    }
    const replay = await sources.engine.replay({ format: head.format, name: docName, bytes, batches: entries.map((entry) => entry.batch), save: true, pages: false });
    for (const [i, entry] of entries.entries()) {
      const step = replay.steps[i];
      if (step?.sha256 !== entry.result_sha256) {
        throw new Error(`replaying revision ${entry.revision} of ${docName} in ${roomId} gave ${step?.sha256 ?? "no step"}, and the session log names ${entry.result_sha256}`);
      }
    }
    if (replay.bytes === null || sha256Hex(replay.bytes) !== at) {
      throw new Error(`replaying ${docName} in ${roomId} to revision ${revision} did not give the bytes ${at}`);
    }
    return replay.bytes;
  }
  throw new Error(`revision ${revision} of ${docName} in ${roomId} cannot be rebuilt: no keyframe at or below it has its bytes stored (missing: ${missing.join(", ")})`);
}
