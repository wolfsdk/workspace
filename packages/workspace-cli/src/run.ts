// The commands of `wolfsdk-workspace`: `check` and `refresh` a pack on disk, `serve` the room server, list
// or free its `seats`, and `actors add` a person or an agent to its actors file.
//
// Exit codes: 0 the pack is fresh (or `refresh` made it so, or `serve` stopped on a signal, or `seats` or
// `actors` did what it was asked), 1 `check` found a stale binding, 2 anything that stopped a command: usage, an
// unreadable or refused pack, an engine fault, a seat that is not held, an id the actors file already has.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { engineInspector, engineRenderer } from "@wolfsdk/mcp";
import {
  checkPack,
  DirectoryStore,
  PackError,
  PoolXlsxEvaluator,
  refreshPack,
  type PackProblem,
  type PackReport,
  type RefreshReport,
} from "@wolfsdk/packs";
import {
  EngineFault,
  EngineRefusal,
  isRoomDatabase,
  type PlanCap,
  PoolEngine,
  type ReadOnlyMode,
  RoomServer,
  RoomStore,
  scopedService,
  WorkerPool,
} from "@wolfsdk/server";
import { addActor, watchActorDirectory } from "./actors.ts";
import { type BackupEnv, runBackup, runRestore } from "./backup.ts";
import { ask } from "./engine.ts";
import { type PlanReadOnly, planReadOnlyMode, UsageError } from "./errors.ts";
import { type SnapshotInput, SHARE_VIEWER, startWorkspaceServer, tokenOf, type WorkspaceAssistantOptions, type WorkspaceServer } from "./http.ts";

export const EXIT_FRESH = 0;
export const EXIT_STALE = 1;
export const EXIT_ERROR = 2;

export type CliIo = { out(text: string): void; err(text: string): void };

const STDIO: CliIo = { out: (text) => console.log(text), err: (text) => console.error(text) };

const USAGE = `wolfsdk-workspace: check and refresh packs, serve the workspace, add who may use it, list and free its seats, back it up and restore it

  wolfsdk-workspace check   [<pack dir>] [--engine <wolf>] [--json]
  wolfsdk-workspace refresh [<pack dir>] [--engine <wolf>] [--json]
  wolfsdk-workspace serve   --db <file> --blobs <dir> --engine <wolf> --actors <file>
                            [--port <n>] [--host <name>] [--pool <n>] [--static-dir <dir>]
                            [--wasm-dir <dir>] [--pack <dir>] [--default-room <id>] [--workspace-id <id>] [--share-connect <path>]
                            [--live-cells-attest <sha256>]...
                            [--live-slide-text-attest <sha256>]...
                            [--plan-seats <n|unlimited> --plan-workspaces <n|unlimited> --plan-upgrade <text> [--plan-name <name>]]
                            [--read-only-reason <text> --read-only-upgrade <text>]
                            [--plan-record <file>]
                            [--assistant-url <url> --assistant-model <name> [--assistant-allowance <n>] [--assistant-db <file>]]
  wolfsdk-workspace actors  add <user|agent> <id> --actors <file> [--name <text>] [--operator <user id>] [--json]
  wolfsdk-workspace seats   --db <file> [--json]
  wolfsdk-workspace seats release <user|agent> <id> --db <file> [--json]
  wolfsdk-workspace backup  --db <file> --blobs <dir> --keep <n> (--dir <dir> | --s3-bucket <name> --s3-endpoint <url> [--s3-region <name>])
                            [--prefix <key prefix>] [--scratch <dir>] [--json]
  wolfsdk-workspace restore --db <file> --blobs <dir> [--snapshot <id>] (same store flags) [--prefix <key prefix>] [--json]
  wolfsdk-workspace restore --list (same store flags) [--prefix <key prefix>] [--json]

check     exit 0 when every binding of the pack is fresh, 1 when one is stale, 2 on an error.
          Writes nothing.
refresh   bring the target documents up to date, all or none; exit 0 on success, 2 on an error.
serve     one port (default 127.0.0.1:8787) for the browser workspace at /, its API at /api (rooms, documents,
          display-list snapshots for shared links, the pack), the wolfsdk.room.v1 WebSocket at /ws and the
          MCP endpoint at /mcp. With --assistant-url the same WebSocket carries wolfsdk.assistant.v1.
          --actors is a JSON file that maps each bearer token to the actor it stands for;
          a client sends the token as "Authorization: Bearer <token>" or as the token query parameter. The file is
          read again when it changes, without a restart; a file that does not parse leaves the last good one in force.
          When the file is not there, serve makes it with one user, owner, and prints the address to sign in at.
actors    add a person (user) or an agent to the actors file of serve under a new token, and print the token, this
          once. The file is made when it is not there and stays mode 600; a running serve takes the token from its
          next request. --name defaults to the id; --operator <user id> puts an agent on the seat of that user of
          the file. An id the file already has for the same kind is refused (exit 2).
seats     list the identities that hold a seat of the licence, or free the seat of one. Both read and
          write the database of serve and work while it runs. An identity whose seat was freed is
          told so; its next request takes a seat again if one is left.
backup    snapshot the database of a running workspace, upload the blobs the store does not hold, then the
          snapshot, last, and keep the newest --keep snapshots. A blob leaves the store only when no kept
          snapshot names it. Exit 0 on success, 2 on an error (nothing is uploaded when a blob the snapshot
          names is missing). S3 credentials come from S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or the
          AWS_ names), never from a flag.
restore   rebuild a workspace from a backup into an empty place: the newest snapshot, or --snapshot <id>.
          Checks the database and every blob; exit 0 on success, 2 on an error, and a failed restore leaves
          the target as it was. --list prints the snapshot ids of the store, oldest first.

--engine <wolf>       the wolf executable; it is started as "<wolf> reactor-serve". For check and refresh
                      it is optional: it recalculates XLSX sources and applies the edits, where without
                      it the package reads cached values and applies the edits itself.
--json                print the report (or the error) as one JSON document on standard output.
--static-dir <dir>    the compiled workspace UI (default: the UI packed with this package, else
                      apps/workspace/dist of a checkout, when built).
--wasm-dir <dir>      a local engine channel (latest.txt, v<VERSION>/...) served at /wasm with CORS.
--pack <dir>          the pack /api/pack checks against the heads of a room (?room=, else --default-room,
                      else the only room; on disk while there is none), /api/pack/refresh refreshes on
                      disk, and the MCP tool pack_link_refresh refreshes into the documents of a room.
--default-room <id>   the room /mcp attaches to when a request names none; created at start when absent.
--workspace-id <id>   the workspace of rooms created without one (default: that of the first room).
--share-connect <path>
                      the path, on the host of the workspace, of the instructions an agent follows to connect to a
                      shared document (such as /-/connect/instructions). It must start with /. The public page of a
                      share link offers "<path>?share=<token>" as its connect address; without the flag it offers none.
                      Sharing itself needs no flag: GET /api/share/<token> and GET /api/share/<token>/snapshot answer
                      anyone who holds a live link, with no token, and an actors-file entry with a "guest" field limits
                      that user or agent to the listed documents.
--live-cells-attest <sha256>
                      repeatable. The sha256 of an XLSX file that you reviewed as unprotected and made of standalone
                      scalar values and formulas only (no shared, array or spill formulas, no special ranges): the
                      exact bytes that live cells may write cell by cell. The engine does not report sheet protection or
                      the kind of a formula, so no uploaded workbook is writable there by default; the others stay
                      readable. A write of live cells (a typed value, or a formula of numbers, same-sheet A1 references,
                      + - * / ^ and parentheses) leaves the workbook writable until something else edits it; a restart
                      forgets that, so attest the head again.
--live-slide-text-attest <sha256>
                      repeatable. The sha256 of a PPTX file that you reviewed as an ordinary text deck, with no special
                      text, fields, hyperlinks, groups or ambiguous shape and run identity: the exact bytes that live
                      slide text may write run by run. The engine does not report those, so no uploaded deck is
                      writable there by default; the others stay readable. A write (the text of one run, with the
                      formatting of the run and of its neighbors left as it is) leaves the deck writable until something
                      else edits it; a restart forgets that, so attest the head again.
--plan-seats <n|unlimited>, --plan-workspaces <n|unlimited>
                      a cap of a plan under the limits of the engine licence: the server admits the smaller of
                      the two. A refusal that the plan caused says which limit, what would be one more, and
                      --plan-upgrade <text>, the words that tell the person what to change. The three come
                      together; --plan-name <name> (default "current") says what the plan is called.
--read-only-reason <text>, --read-only-upgrade <text>
                      serve reads and refuse every write: creating a workspace, adding a document, editing and
                      proposing, deciding, commenting, refreshing a pack, and the MCP write tools. A refusal
                      is the error LICENSE_LIMIT (HTTP 402), and its message is "workspace-read-only: <reason>
                      <upgrade>": the sentence that says why, then the words that say what to do (a URL, say).
                      Signing in, listing, reading, downloading, exporting and joining a room keep working. The
                      two come together, each 1 to 300 characters; GET /api/me reports them as readOnly.
--plan-record <file>  the plan record of a hosted workspace, a JSON file: {"readOnly": null}, or {"readOnly":
                      {"reason": "trial-ended" | "payment-failed" | "plan-cancelled" | "chargeback", "since": <ISO
                      8601 date>, "payUrl": <http or https URL of the page to pay on>}}. While it carries a mark,
                      every write is refused as with --read-only-reason, with the message "workspace-read-only:
                      <the reason with its day> To keep editing, pay at <payUrl>." The file is read again when it
                      changes, without a restart: a mark set or lifted applies from the next request. A file that
                      cannot be used when serve starts stops it (exit 2); one that cannot be used later leaves the
                      last good mark in force. The read-only flags, when given as well, come first.
--assistant-url <url>, --assistant-model <name>
                      the assistant of the workspace: the chat-completions endpoint of a model (an OpenAI-compatible
                      URL that ends in /chat/completions) and the name of the model. The two come together. The
                      key of the endpoint comes from WOLFSDK_ASSISTANT_API_KEY, never from a flag; give any value
                      to an endpoint that asks for none. A user asks in the panel of the browser workspace; the
                      assistant reads and edits through the MCP tools as an agent on that user's seat, and its
                      edits are proposals that a user approves. Without the flags the assistant says it is not
                      configured.
--assistant-allowance <n>
                      the tasks one seat may start in a calendar month (UTC), counted at the first model call of
                      a task. At the limit the assistant refuses a new task and says so; editing, deciding and
                      commenting go on. Without it the server does not meter.
--assistant-db <file> where the turns and the counts of the assistant are kept (default: beside --db, as
                      <name of --db>.assistant.sqlite).
--dir <dir>           the store of backup and restore as a directory (made by a backup when it is not there).
--s3-bucket <name>, --s3-endpoint <url>, --s3-region <name>
                      the store as a bucket of an S3-compatible service (Backblaze B2, Cloudflare R2). Give
                      --dir, or --s3-bucket with --s3-endpoint; the region defaults to auto.
--prefix <key prefix> a key prefix, to keep several workspaces apart in one bucket or directory.
--keep <n>            how many snapshots a backup keeps, at least 1.
--scratch <dir>       where a backup writes its temporary copy of the database (default: the system
                      temporary directory).`;

const PACK_OPTIONS = {
  engine: { type: "string" },
  json: { type: "boolean" },
} as const;

const SERVE_OPTIONS = {
  db: { type: "string" },
  blobs: { type: "string" },
  engine: { type: "string" },
  actors: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  pool: { type: "string" },
  "static-dir": { type: "string" },
  "wasm-dir": { type: "string" },
  pack: { type: "string" },
  "default-room": { type: "string" },
  "workspace-id": { type: "string" },
  "share-connect": { type: "string" },
  "live-cells-attest": { type: "string", multiple: true },
  "live-slide-text-attest": { type: "string", multiple: true },
  "plan-seats": { type: "string" },
  "plan-workspaces": { type: "string" },
  "plan-name": { type: "string" },
  "plan-upgrade": { type: "string" },
  "read-only-reason": { type: "string" },
  "read-only-upgrade": { type: "string" },
  "plan-record": { type: "string" },
  "assistant-url": { type: "string" },
  "assistant-model": { type: "string" },
  "assistant-allowance": { type: "string" },
  "assistant-db": { type: "string" },
} as const;

/** One limit of a plan cap: a whole number, or `unlimited`. */
function limit(flag: string, text: string): number | null {
  if (text === "unlimited") return null;
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n)) throw new UsageError(`${flag} must be a whole number or unlimited`);
  return n;
}

/** The plan cap of the plan flags, or `undefined` when none is given. The flags come together: a cap that is
 * silent about one of its limits, or about the upgrade path, is a mistake of the host that sets it. */
function planCapOf(values: { "plan-seats"?: string; "plan-workspaces"?: string; "plan-name"?: string; "plan-upgrade"?: string }): PlanCap | undefined {
  const { "plan-seats": seats, "plan-workspaces": workspaces, "plan-name": name, "plan-upgrade": upgrade } = values;
  if (seats === undefined && workspaces === undefined && name === undefined && upgrade === undefined) return undefined;
  if (seats === undefined || workspaces === undefined || upgrade === undefined) {
    throw new UsageError("--plan-seats, --plan-workspaces and --plan-upgrade come together");
  }
  return { maxSeats: limit("--plan-seats", seats), maxWorkspaces: limit("--plan-workspaces", workspaces), name, upgrade };
}

const READ_ONLY_CHARS = 300;

/** The read-only mode of the read-only flags, or `undefined` when none is given. The flags come together: a refusal
 * that does not say why, or does not say what to do about it, is a mistake of the host that sets it. */
function readOnlyOf(values: { "read-only-reason"?: string; "read-only-upgrade"?: string }): ReadOnlyMode | undefined {
  const { "read-only-reason": reason, "read-only-upgrade": upgrade } = values;
  if (reason === undefined && upgrade === undefined) return undefined;
  if (reason === undefined || upgrade === undefined) throw new UsageError("--read-only-reason and --read-only-upgrade come together");
  for (const [flag, text] of [["--read-only-reason", reason], ["--read-only-upgrade", upgrade]] as const) {
    if (text.trim().length === 0 || text.length > READ_ONLY_CHARS) throw new UsageError(`${flag} is 1 to ${READ_ONLY_CHARS} characters and not blank`);
  }
  return { reason, upgrade };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The read-only mark of the plan record `text`, the content of the file at `path`: `null` for `{"readOnly": null}`,
 * else the mark `{"readOnly": {"reason", "since", "payUrl"}}` holds, checked as `planReadOnlyMode` checks it so that
 * a refusal never says something unfounded. Throws for a text that is not a plan record. */
function parsePlanRecord(path: string, text: string): PlanReadOnly | null {
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch (e) {
    throw new Error(`the plan record ${path} is not JSON: ${messageOf(e)}`);
  }
  const shape = `the plan record ${path} is an object whose readOnly is null or {"reason", "since", "payUrl"}`;
  if (typeof record !== "object" || record === null || Array.isArray(record) || !Object.hasOwn(record, "readOnly")) throw new Error(shape);
  const mark: unknown = (record as { readOnly: unknown }).readOnly;
  if (mark === null) return null;
  if (typeof mark !== "object" || Array.isArray(mark)) throw new Error(shape);
  const { reason, since, payUrl } = mark as Record<string, unknown>;
  if (typeof reason !== "string" || typeof since !== "string" || typeof payUrl !== "string") throw new Error(shape);
  const parsed = { reason, since, payUrl } as PlanReadOnly;
  planReadOnlyMode(parsed);
  return parsed;
}

/** What identifies one version of a file: a writer that replaces it by rename changes the inode, one that rewrites it in
 * place changes the modification time or size. An unreadable file is a stamp of its own. */
function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (e) {
    return `unreadable:${messageOf(e)}`;
  }
}

/** A plan record that `serve` keeps in step with the disk. */
export type WatchedPlanRecord = {
  /** The read-only mark in force now, or `null` while the workspace is read-write. When the file's identity, size or
   * modification time differs from the last time this looked (one `stat`, nothing else), the file is read again: a
   * record that parses replaces the mark, one that does not (half written, not JSON, a mark that is not one, gone)
   * leaves the last good mark in force and is reported once through `log`. */
  current(): PlanReadOnly | null;
};

/** Read the plan record at `path` now, and again whenever it changes, for as long as the result is used. The first read
 * throws a `UsageError`: a server must not start without knowing whether it may write. */
export function watchPlanRecord(path: string, log: (line: string) => void): WatchedPlanRecord {
  // The stamp comes first: a change that lands during the read is then seen by the next check.
  let seen = fileStamp(path);
  let mark: PlanReadOnly | null;
  try {
    mark = parsePlanRecord(path, readFileSync(path, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot use the plan record: ${messageOf(e)}`);
  }
  return {
    current() {
      const stamp = fileStamp(path);
      if (stamp === seen) return mark;
      seen = stamp;
      try {
        mark = parsePlanRecord(path, readFileSync(path, "utf8"));
      } catch (e) {
        const kept = mark === null ? "read-write" : `read-only, ${mark.reason}`;
        log(`plan record changed but cannot be used, keeping the mark read before (${kept}): ${messageOf(e).replace(/\s+/g, " ")}`);
      }
      return mark;
    },
  };
}

const SEATS_OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean" },
} as const;

/** `seats`: the roster of a room database, read and changed straight in the file. A server that has the database
 * open sees the change with its next request. */
function runSeats(args: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({ args, options: SEATS_OPTIONS, allowPositionals: true });
  if (values.db === undefined) throw new UsageError("seats needs --db");
  /** The seat to free, or `null` to list the seats. */
  let release: { kind: "user" | "agent"; id: string } | null = null;
  if (positionals.length > 0) {
    const [verb, kind, id, ...extra] = positionals;
    if (verb !== "release" || (kind !== "user" && kind !== "agent") || id === undefined || extra.length > 0) {
      throw new UsageError("seats takes nothing to list the seats, or: release <user|agent> <id>");
    }
    release = { kind, id };
  }
  // The store creates a database that is not there and adds its tables to one that has none: a mistyped path
  // must leave nothing behind and change no other file.
  if (!existsSync(values.db)) throw new Error(`no room database at ${values.db}`);
  if (!isRoomDatabase(values.db)) throw new Error(`${values.db} is not a room database`);
  const store = new RoomStore(values.db);
  try {
    if (release === null) {
      const seats = store.seats();
      const lines = seats.map((s) => `${s.kind.padEnd(5)} ${s.id}  ${s.name}  since ${s.first_seen_at}`);
      lines.push(`${seats.length} seat${seats.length === 1 ? "" : "s"} taken`);
      io.out(values.json ? JSON.stringify({ seats }, null, 2) : lines.join("\n"));
      return EXIT_FRESH;
    }
    if (!store.removeSeat(release.kind, release.id)) throw new Error(`${release.kind} ${release.id} holds no seat`);
    io.out(values.json ? JSON.stringify({ released: release }, null, 2) : `freed the seat of ${release.kind} ${release.id}`);
    return EXIT_FRESH;
  } finally {
    store.close();
  }
}

const ACTORS_OPTIONS = {
  actors: { type: "string" },
  name: { type: "string" },
  operator: { type: "string" },
  json: { type: "boolean" },
} as const;

/** `actors add`: one person or agent more in the actors file of `serve`, under a token made here. The token is
 * printed this once; a running server accepts it from its next request. */
function runActors(args: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({ args, options: ACTORS_OPTIONS, allowPositionals: true });
  const [verb, kind, actorId, ...extra] = positionals;
  if (verb !== "add" || (kind !== "user" && kind !== "agent") || actorId === undefined || extra.length > 0) {
    throw new UsageError("actors takes: add <user|agent> <id>");
  }
  if (values.actors === undefined) throw new UsageError("actors add needs --actors");
  const added = addActor(values.actors, { kind, id: actorId, name: values.name ?? actorId, operator: values.operator ?? null });
  if (values.json) {
    io.out(JSON.stringify({ added: { ...added.actor, operator: added.operator }, token: added.token, actors: values.actors, created: added.created }, null, 2));
    return EXIT_FRESH;
  }
  const { actor, operator, token } = added;
  const who = `${actor.kind} ${actor.id} (${actor.name})${operator === null ? "" : `, on the seat of user ${operator.id}`}`;
  const use =
    actor.kind === "user"
      ? `sign in at <workspace address>/?token=${token}`
      : `token ${token}; the agent sends it as "Authorization: Bearer <token>" to <workspace address>/mcp`;
  io.out([`${added.created ? "created" : "added to"} ${values.actors}: ${who}`, use, "This is the only time the token is printed."].join("\n"));
  return EXIT_FRESH;
}

/** The compiled workspace UI: `ui/` in the npm package, `apps/workspace/dist` in a checkout. */
const BUILT_UI =
  [join(import.meta.dir, "..", "ui"), join(import.meta.dir, "..", "..", "..", "apps", "workspace", "dist")].find((dir) =>
    existsSync(join(dir, "index.html")),
  ) ?? null;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function directory(flag: string, path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new UsageError(`${flag} ${path} is not a directory`);
  return path;
}

function id(flag: string, text: string | undefined): string | null {
  if (text === undefined) return null;
  if (!ID.test(text)) throw new UsageError(`${flag} must be letters, digits and . _ : -, up to 128`);
  return text;
}

function count(flag: string, text: string | undefined, fallback: number, least: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < least || n > 65535) throw new UsageError(`${flag} must be a whole number from ${least} to 65535`);
  return n;
}

function reportLines(report: PackReport | RefreshReport, command: "check" | "refresh"): string[] {
  const lines = report.bindings.map((b) => `${b.status.padEnd(9)} ${b.binding_id}  ${b.target_doc} ${b.target_address}  ${b.ops} op${b.ops === 1 ? "" : "s"}`);
  for (const b of report.bindings) for (const note of b.notes) lines.push(`          ${b.binding_id}: ${note}`);
  const documents = report.documents.length;
  if (command === "check") {
    lines.push(report.fresh ? `pack ${report.pack_id}: fresh` : `pack ${report.pack_id}: stale, ${documents} document${documents === 1 ? "" : "s"} would change`);
  } else {
    lines.push(documents === 0 ? `pack ${report.pack_id}: already fresh` : `pack ${report.pack_id}: refreshed ${documents} document${documents === 1 ? "" : "s"}`);
  }
  return lines;
}

/** What a failure of `check` or `refresh` says: a code, a message, and the problems of a refusal. */
function failure(e: unknown): { code: string; message: string; problems: readonly PackProblem[] } {
  if (e instanceof PackError) return { code: e.code, message: e.message, problems: e.problems };
  if (e instanceof EngineFault || e instanceof EngineRefusal) return { code: "engine-failed", message: e.message, problems: [] };
  throw e;
}

async function runPack(command: "check" | "refresh", args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: PACK_OPTIONS, allowPositionals: true });
  if (positionals.length > 1) throw new UsageError(`${command} takes one pack directory, not ${positionals.length}`);
  const pool = values.engine === undefined ? null : new WorkerPool({ command: [values.engine, "reactor-serve"] });
  try {
    const store = new DirectoryStore(positionals[0] ?? ".");
    const evaluator = pool === null ? undefined : new PoolXlsxEvaluator(pool);
    const report =
      command === "check"
        ? await checkPack(store, { evaluator })
        : await refreshPack(store, { evaluator, engine: pool === null ? undefined : new PoolEngine(pool) });
    io.out(values.json ? JSON.stringify(report, null, 2) : reportLines(report, command).join("\n"));
    return report.fresh ? EXIT_FRESH : EXIT_STALE;
  } catch (e) {
    const { code, message, problems } = failure(e);
    if (values.json) {
      io.out(JSON.stringify({ error: { code, message, problems } }, null, 2));
    } else {
      io.err(`error: ${code}: ${message}`);
      if (problems.length > 1) for (const p of problems) io.err(`  ${p.binding_id ?? "-"}  ${p.code}: ${p.message}`);
    }
    return EXIT_ERROR;
  } finally {
    await pool?.close();
  }
}

/** The snapshot a shared link paints: the `display_list` answer of every page of a document, in page order. One
 * worker opens the head bytes, lays them out, asks each page and closes the document; a worker that cannot say it
 * closed the document is not reused. */
export function engineSnapshot(pool: Pick<WorkerPool, "withWorker">): (input: SnapshotInput) => Promise<unknown[]> {
  return (input) =>
    pool.withWorker(async (worker) => {
      const { doc } = await ask(worker, { cmd: "open", bytes: { bin: 0, len: input.bytes.length }, name: input.name, format: input.format }, [input.bytes]);
      try {
        const { summary } = await ask(worker, { cmd: "layout", doc });
        const pages: unknown[] = [];
        for (let page = 1; page <= summary.pages; page++) pages.push(await ask(worker, { cmd: "display_list", doc, page }));
        return pages;
      } finally {
        try {
          const { body } = await worker.call({ cmd: "close", doc });
          if (!body.ok || "error" in body) worker.discard();
        } catch {
          worker.discard();
        }
      }
    });
}

/** The variable the key of the assistant's model endpoint is read from. A flag would show it in a process list. */
export const ASSISTANT_KEY_VARIABLE = "WOLFSDK_ASSISTANT_API_KEY";

type AssistantFlags = { "assistant-url"?: string; "assistant-model"?: string; "assistant-allowance"?: string; "assistant-db"?: string };

/** The assistant of the assistant flags of `serve`, or `null` when they name no endpoint. `db` is the room
 * database: the assistant keeps its own file beside it unless `--assistant-db` says where. */
export function assistantOf(values: AssistantFlags, db: string, env: BackupEnv): WorkspaceAssistantOptions | null {
  const { "assistant-url": url, "assistant-model": model, "assistant-allowance": allowance, "assistant-db": store } = values;
  if (url === undefined && model === undefined) {
    if (allowance !== undefined || store !== undefined) throw new UsageError("--assistant-allowance and --assistant-db need --assistant-url and --assistant-model");
    return null;
  }
  if (url === undefined || model === undefined) throw new UsageError("--assistant-url and --assistant-model come together");
  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) throw new UsageError("--assistant-url must be an http or https URL");
  if (model.trim().length === 0) throw new UsageError("--assistant-model must name a model");
  const key = env[ASSISTANT_KEY_VARIABLE];
  if (key === undefined || key === "") {
    throw new UsageError(`--assistant-url needs the key of the endpoint in ${ASSISTANT_KEY_VARIABLE} (any value for an endpoint that asks for none)`);
  }
  let limit: number | null = null;
  if (allowance !== undefined) {
    limit = Number(allowance);
    if (!/^\d+$/.test(allowance) || !Number.isSafeInteger(limit)) throw new UsageError("--assistant-allowance must be a whole number of tasks per seat per month");
  }
  return { endpoint: { url, model, key }, allowance: limit, storePath: store ?? join(dirname(db), `${basename(db, extname(db))}.assistant.sqlite`) };
}

async function runServe(args: string[], io: CliIo, env: BackupEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: SERVE_OPTIONS, allowPositionals: false });
  const { db, blobs, engine, actors: actorsFile } = values;
  if (db === undefined || blobs === undefined || engine === undefined || actorsFile === undefined) {
    throw new UsageError("serve needs --db, --blobs, --engine and --actors");
  }
  const port = count("--port", values.port, 8787, 0);
  const size = count("--pool", values.pool, 2, 1);
  const staticDir = directory("--static-dir", values["static-dir"]) ?? BUILT_UI;
  const wasmDir = directory("--wasm-dir", values["wasm-dir"]);
  const packDir = directory("--pack", values.pack);
  const defaultRoom = id("--default-room", values["default-room"]);
  const workspaceId = id("--workspace-id", values["workspace-id"]);
  const shareConnect = values["share-connect"] ?? null;
  if (shareConnect !== null && !(shareConnect.startsWith("/") && !shareConnect.startsWith("//") && !/[\s?#]/.test(shareConnect))) {
    throw new UsageError("--share-connect must be a path on this host that starts with / (such as /-/connect/instructions), with no query");
  }
  const attested = (values["live-cells-attest"] ?? []).map((digest) => {
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) throw new UsageError(`--live-cells-attest takes the sha256 of a workbook: 64 hexadecimal digits, not ${JSON.stringify(digest)}`);
    return digest.toLowerCase();
  });
  const slideTextAttested = (values["live-slide-text-attest"] ?? []).map((digest) => {
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) throw new UsageError(`--live-slide-text-attest takes the sha256 of a deck: 64 hexadecimal digits, not ${JSON.stringify(digest)}`);
    return digest.toLowerCase();
  });
  const planCap = planCapOf(values);
  const readOnly = readOnlyOf(values);
  const assistant = assistantOf(values, db, env);
  // The read-only mark of the plan record, read again when the file changes: a mark set or lifted applies from the next
  // request on, with no restart. The room service gets no read-only mode for it, since it keeps its mode for its life.
  const planRecordPath = values["plan-record"];
  const planRecord = planRecordPath === undefined ? null : watchPlanRecord(planRecordPath, (line) => io.err(line));
  // A first start without an actors file makes one with one user, as the container does, so that somebody can sign
  // in. The token is printed now, before anything else can stop the start, and again in the address once it listens.
  const first = existsSync(actorsFile) ? null : addActor(actorsFile, { kind: "user", id: "owner", name: "Owner", operator: null });
  if (first !== null) io.out(`created ${actorsFile} with one user, owner; token ${first.token}`);
  // The file is read again when it changes: a token added is accepted, and one removed refused, from the next request.
  const actors = await watchActorDirectory(actorsFile, (line) => io.err(line));
  const founder = [...actors.current().actors.values()].find((actor) => actor.kind === "user");
  if (defaultRoom !== null && founder === undefined) throw new UsageError("--default-room needs a user in the actors file to create the room");

  // One pool of engine workers for the rooms, the MCP tools and the pack.
  const pool = new WorkerPool({ command: [engine, "reactor-serve"], size });
  const documents = new PoolEngine(pool);
  // The assistant is made with the workspace server, below: until then no agent of it exists to ask about.
  let workspace: WorkspaceServer | null = null;
  const server = new RoomServer({
    dbPath: db,
    blobDir: blobs,
    engine: documents,
    // An agent of the actors file works for whom the file says; the agent of the assistant for the user who asked.
    operatorOf: (agent) => actors.current().operatorOf(agent) ?? workspace?.assistant.operatorOf(agent) ?? null,
    planCap,
    readOnly,
    // A guest, and the viewer of a share link, take no seat: they are not members of the paid workspace.
    seatless: (actor) => actor === SHARE_VIEWER || actors.current().scopeOf(actor) !== null,
  });
  if (defaultRoom !== null && founder !== undefined && !(await server.listRooms()).some((room) => room.room_id === defaultRoom)) {
    // The room of the host, put in place before it serves: a read-only workspace has it too.
    const created = await server.seedRoom(founder, { room_id: defaultRoom, workspace_id: workspaceId ?? "default" });
    if (!created.ok) {
      io.err(`error: cannot create the room ${defaultRoom}: ${created.error.code}: ${created.error.message}`);
      await server.close();
      return EXIT_ERROR;
    }
  }
  workspace = startWorkspaceServer({
    service: scopedService(server, (actor) => actors.current().scopeOf(actor)),
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (actors.current().actors.get(token) ?? null);
    },
    port,
    hostname: values.host,
    staticDir,
    wasmDir,
    snapshot: engineSnapshot(pool),
    liveCells: { pool, attested },
    liveSlideText: { pool, attested: slideTextAttested },
    mcp: { inspector: engineInspector(pool), renderer: engineRenderer(pool) },
    pack: packDir === null ? null : { dir: packDir, evaluator: new PoolXlsxEvaluator(pool), engine: documents },
    defaultRoom,
    readOnly,
    scopeOf: (actor) => actors.current().scopeOf(actor),
    shares: server,
    shareConnect,
    ...(planRecord === null ? {} : { planReadOnly: () => planRecord.current() }),
    assistant,
  });
  io.out(`listening ${workspace.wsUrl}`);
  io.out(`workspace ${staticDir === null ? "(UI not built)" : workspace.url}`);
  io.out(`mcp ${workspace.mcpUrl}`);
  if (assistant?.endpoint) {
    const metered = assistant.allowance === null ? "unmetered" : `${assistant.allowance} tasks per seat per month`;
    io.out(`assistant ${assistant.endpoint.model} at ${new URL(assistant.endpoint.url).host}, ${metered}`);
  }
  if (first !== null) {
    io.out(`Sign in at ${workspace.url}/?token=${first.token}`);
    io.out(`Add people and agents with: wolfsdk-workspace actors add <user|agent> <id> --actors ${actorsFile}`);
  }
  const stopped = Promise.withResolvers<void>();
  process.once("SIGINT", stopped.resolve);
  process.once("SIGTERM", stopped.resolve);
  await stopped.promise;
  await workspace.stop();
  await server.close();
  return EXIT_FRESH;
}

export async function runCli(argv: readonly string[], io: CliIo = STDIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "check":
      case "refresh":
        return await runPack(command, rest, io);
      case "serve":
        return await runServe(rest, io);
      case "actors":
        return runActors(rest, io);
      case "seats":
        return runSeats(rest, io);
      case "backup":
        return await runBackup(rest, io);
      case "restore":
        return await runRestore(rest, io);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return EXIT_FRESH;
      case undefined:
        io.err(USAGE);
        return EXIT_ERROR;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const parseError = e instanceof TypeError && "code" in e && typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS");
    io.err(e instanceof UsageError || parseError ? `error: ${message}\n\n${USAGE}` : `error: ${message}`);
    return EXIT_ERROR;
  }
}
