// The usage of a workspace, read from its room database and the blob directory beside it: the seats signed in,
// and, for every workspace id the rooms belong to, its documents, revisions, largest file and stored bytes. The
// tier limits of Wolf Cloud are counted from this report. Run it as a command:
//
//   bun packages/server/src/usage.ts --db <rooms.sqlite> --blobs <dir> [--json]
//
// Exit codes: 0 the report was printed, 2 it could not be made (usage, no database, not a room database).
//
// Nothing is written, to the database, beside it, or to the blob directory, and nothing is locked: the report runs
// beside a live server. A database that has a write-ahead log (a server has it open, or stopped without closing it)
// is read through SQLite's shared-memory index, which the server keeps. One without a log (its server stopped and
// closed it) is opened immutable: an ordinary read-only connection would create the log and its index beside the
// file and leave both behind. Should a log appear while the immutable read runs (a server started), the report
// is read again the ordinary way, so it never mixes the file with a log it did not read.
//
// The counts, by the meanings the rest of the server uses:
//   seats              identities the server admitted to a seat of its licence (people, and agents with a seat of
//                      their own). The roster belongs to the database, not to a workspace id: a seat counts once
//                      however many workspaces its holder works in, as the licence counts it.
//   documents          documents of the rooms, by their heads.
//   revisions          committed revisions: entries of the session log (a document starts at revision 0, which no
//                      entry records). The number `verifyWorkspace` reports.
//   largest_file_bytes the largest blob needed by a room: a head, a retained revision or keyframe, a proposal preview.
//   stored_bytes       of a workspace id, the distinct blobs its rooms need above their history floors; of the whole, the database file and its
//                      log plus every file of the blob directory (leftovers of interrupted writes included, since
//                      they take space too). A blob two workspace ids name counts in each of them, once in the whole.
import { Database, constants } from "bun:sqlite";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isSha256 } from "./blobs.ts";
import { neededBlobs } from "./retention.ts";
import { SCHEMA_VERSION } from "./store.ts";

export type UsageErrorCode =
  /** The arguments of the command are wrong. */
  | "BAD_ARGUMENT"
  /** There is no file at the database path. */
  | "NO_DATABASE"
  /** The file is not a room database of the schema this server reads. */
  | "NOT_A_ROOM_DATABASE";

export class UsageReportError extends Error {
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = "UsageReportError";
    this.code = code;
  }
}

export type WorkspaceUsage = {
  workspace_id: string;
  rooms: number;
  documents: number;
  revisions: number;
  /** Distinct blobs the rooms of this workspace id name and the blob directory holds. */
  blobs: number;
  largest_file_bytes: number;
  stored_bytes: number;
};

export type UsageReport = {
  seats: { users: number; agents: number; total: number };
  rooms: number;
  documents: number;
  revisions: number;
  largest_file_bytes: number;
  /** The database file and its write-ahead log. */
  database_bytes: number;
  /** Every file of the blob directory. */
  blob_bytes: number;
  /** Files of the blob directory stored under a SHA-256 name, in the folder of its first two digits. */
  blob_files: number;
  /** Distinct blobs the database names. */
  named_blobs: number;
  /** Blobs the database names that the blob directory does not hold; 0 in a sound workspace. */
  missing_blobs: number;
  /** `database_bytes` and `blob_bytes`. */
  stored_bytes: number;
  /** One entry for every workspace id a room belongs to, by id. */
  workspaces: WorkspaceUsage[];
};

/** What the database says, before the blob directory is looked at. */
type DatabaseCounts = {
  seats: { users: number; agents: number };
  workspaces: Map<string, { rooms: number; documents: number; revisions: number; blobs: Set<string> }>;
};

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await lstat(file)).size;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** Read the counts in one read transaction of `db`. */
function countsOf(db: Database, dbPath: string): DatabaseCounts {
  db.exec("BEGIN");
  try {
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of ["meta", "rooms", "documents", "session_log", "proposals", "seats"]) {
      if (!tables.has(table)) throw new UsageReportError("NOT_A_ROOM_DATABASE", `${dbPath} is not a room database: it has no ${table} table`);
    }
    const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (version !== SCHEMA_VERSION) {
      throw new UsageReportError("NOT_A_ROOM_DATABASE", `${dbPath} has schema version ${version ?? "none"}; this server reads ${SCHEMA_VERSION}`);
    }
    const seats = { users: 0, agents: 0 };
    for (const row of db.query<{ kind: string; n: number }, []>("SELECT kind, COUNT(*) AS n FROM seats GROUP BY kind").all()) {
      if (row.kind === "user") seats.users = row.n;
      else if (row.kind === "agent") seats.agents = row.n;
    }
    const workspaces: DatabaseCounts["workspaces"] = new Map();
    for (const row of db.query<{ workspace_id: string; n: number }, []>("SELECT workspace_id, COUNT(*) AS n FROM rooms GROUP BY workspace_id").all()) {
      workspaces.set(row.workspace_id, { rooms: row.n, documents: 0, revisions: 0, blobs: new Set() });
    }
    const perWorkspace = (table: string): Array<{ workspace_id: string; n: number }> =>
      db.query<{ workspace_id: string; n: number }, []>(`SELECT r.workspace_id AS workspace_id, COUNT(*) AS n FROM ${table} AS t JOIN rooms AS r ON r.room_id = t.room_id GROUP BY r.workspace_id`).all();
    for (const row of perWorkspace("documents")) workspaces.get(row.workspace_id)!.documents = row.n;
    for (const row of perWorkspace("session_log")) workspaces.get(row.workspace_id)!.revisions = row.n;
    for (const [workspaceId, counts] of workspaces) {
      counts.blobs = new Set(neededBlobs(db, workspaceId));
    }
    return { seats, workspaces };
  } finally {
    db.exec("COMMIT");
  }
}

function readCounts(file: string, immutable: boolean, dbPath: string): DatabaseCounts {
  let db: Database | undefined;
  try {
    db = immutable
      ? new Database(`${pathToFileURL(file).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
      : new Database(file, { readonly: true });
    // A server that is starting or checkpointing on this file may hold it for a moment.
    if (!immutable) db.exec("PRAGMA busy_timeout = 5000");
    return countsOf(db, dbPath);
  } catch (e) {
    if (e instanceof UsageReportError) throw e;
    throw new UsageReportError("NOT_A_ROOM_DATABASE", `${dbPath} is not a readable room database: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db?.close();
  }
}

/** The counts of the database at `file`, read without writing a byte (see the head of this file). */
async function readDatabase(file: string, dbPath: string): Promise<DatabaseCounts> {
  if ((await sizeOf(`${file}-wal`)) !== null) return readCounts(file, false, dbPath);
  const counts = readCounts(file, true, dbPath);
  if ((await sizeOf(`${file}-wal`)) === null) return counts;
  return readCounts(file, false, dbPath);
}

/** The files of the blob directory: their bytes and count, and the size of every blob stored where `BlobStore`
 * looks for it (`<dir>/<first two hex digits>/<sha256>`). A directory that is not there holds nothing. */
async function readBlobDirectory(blobDir: string): Promise<{ bytes: number; files: number; sizes: Map<string, number> }> {
  const sizes = new Map<string, number>();
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string, depth: number, folder: string | null): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (depth === 0 && e instanceof Error && "code" in e && e.code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(at, depth + 1, depth === 0 ? entry.name : null);
      } else if (entry.isFile()) {
        const size = (await lstat(at)).size;
        bytes += size;
        files += 1;
        if (depth === 1 && folder !== null && isSha256(entry.name) && entry.name.startsWith(folder)) sizes.set(entry.name, size);
      }
    }
  };
  await walk(path.resolve(blobDir), 0, null);
  return { bytes, files, sizes };
}

/** The usage of the workspace whose room database is `dbPath` and whose blobs are in `blobDir`. Reads only. */
export async function usageOf(options: { dbPath: string; blobDir: string }): Promise<UsageReport> {
  const file = path.resolve(options.dbPath);
  const databaseSize = await sizeOf(file);
  if (databaseSize === null) throw new UsageReportError("NO_DATABASE", `there is no database at ${options.dbPath}`);
  const counts = await readDatabase(file, options.dbPath);
  const disk = await readBlobDirectory(options.blobDir);

  const workspaces: WorkspaceUsage[] = [];
  const named = new Set<string>();
  for (const [workspace_id, ws] of [...counts.workspaces].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let stored = 0;
    let largest = 0;
    let present = 0;
    for (const name of ws.blobs) {
      named.add(name);
      const size = disk.sizes.get(name);
      if (size === undefined) continue;
      present += 1;
      stored += size;
      largest = Math.max(largest, size);
    }
    workspaces.push({ workspace_id, rooms: ws.rooms, documents: ws.documents, revisions: ws.revisions, blobs: present, largest_file_bytes: largest, stored_bytes: stored });
  }
  let missing = 0;
  for (const name of named) if (!disk.sizes.has(name)) missing += 1;
  const database_bytes = databaseSize + ((await sizeOf(`${file}-wal`)) ?? 0);
  const sum = (key: "rooms" | "documents" | "revisions"): number => workspaces.reduce((total, ws) => total + ws[key], 0);
  return {
    seats: { ...counts.seats, total: counts.seats.users + counts.seats.agents },
    rooms: sum("rooms"),
    documents: sum("documents"),
    revisions: sum("revisions"),
    largest_file_bytes: workspaces.reduce((largest, ws) => Math.max(largest, ws.largest_file_bytes), 0),
    database_bytes,
    blob_bytes: disk.bytes,
    blob_files: disk.sizes.size,
    named_blobs: named.size,
    missing_blobs: missing,
    stored_bytes: database_bytes + disk.bytes,
    workspaces,
  };
}

// Command ------------------------------------------------------------------------------------------------------

export const USAGE_HELP = `usage: the seats, documents, revisions, largest file and stored bytes of a workspace, read without writing

  bun packages/server/src/usage.ts --db <file> --blobs <dir> [--json]

--db <file>    the room database of the server
--blobs <dir>  the blob directory of the server
--json         print the report as JSON`;

export type UsageIo = { out(text: string): void; err(text: string): void };

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The report as lines for a person. */
export function formatUsage(report: UsageReport): string {
  const lines = [
    `seats      ${report.seats.total} (${plural(report.seats.users, "user")}, ${plural(report.seats.agents, "agent")})`,
    `documents  ${report.documents} in ${plural(report.rooms, "room")}`,
    `revisions  ${report.revisions}`,
    `largest    ${report.largest_file_bytes} bytes`,
    `stored     ${report.stored_bytes} bytes: database ${report.database_bytes}, blobs ${report.blob_bytes} in ${plural(report.blob_files, "blob")}`,
  ];
  if (report.missing_blobs > 0) lines.push(`missing    ${plural(report.missing_blobs, "blob")} the database names are not in the blob directory`);
  for (const ws of report.workspaces) {
    lines.push(
      `workspace ${ws.workspace_id}: ${plural(ws.rooms, "room")}, ${plural(ws.documents, "document")}, ${plural(ws.revisions, "revision")}, largest file ${ws.largest_file_bytes} bytes, stored ${ws.stored_bytes} bytes in ${plural(ws.blobs, "blob")}`,
    );
  }
  return lines.join("\n");
}

/** Run the command with `args` (without the program); returns the exit code. */
export async function runUsage(args: string[], io: UsageIo): Promise<number> {
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, options: { db: { type: "string" }, blobs: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }));
    } catch (e) {
      throw new UsageReportError("BAD_ARGUMENT", e instanceof Error ? e.message : String(e));
    }
    if (values.help) {
      io.out(USAGE_HELP);
      return 0;
    }
    if (values.db === undefined || values.blobs === undefined) throw new UsageReportError("BAD_ARGUMENT", "usage needs --db and --blobs");
    const report = await usageOf({ dbPath: values.db, blobDir: values.blobs });
    io.out(values.json ? JSON.stringify(report, null, 2) : formatUsage(report));
    return 0;
  } catch (e) {
    if (!(e instanceof UsageReportError)) throw e;
    io.err(`usage: ${e.message}`);
    if (e.code === "BAD_ARGUMENT") io.err(USAGE_HELP);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await runUsage(Bun.argv.slice(2), { out: (text) => console.log(text), err: (text) => console.error(text) }));
}
