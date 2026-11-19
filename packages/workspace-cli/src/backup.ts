// The commands `backup` and `restore` of `wolfsdk-workspace`: one workspace (the room database, its blob directory
// and the database of its assistant) to and from an object store, a bucket that speaks S3 (Backblaze B2,
// Cloudflare R2) or a directory. The room database and the blobs are the work of `backupWorkspace` and
// `restoreWorkspace` of `@wolfsdk/server`; this file adds the assistant database to the same backup set, reads the
// command line, opens the store and prints the report. It also holds `backup-registry` and `restore-host`, the two
// commands of a hosted deployment's control plane (see "The hosted deployment" below).
//
// The assistant of `serve` keeps its stored turns, and the tasks the allowance of a seat is counted from, in a
// SQLite file of its own beside the room database. A backup set holds it beside the room snapshot, under the id
// of that snapshot:
//   snapshots/<id>.assistant-<sha256>.sqlite     the assistant database at one instant, named by its SHA-256
// It is copied with `VACUUM INTO`, which reads it in one transaction while the server keeps writing: a task that
// finishes during the backup is in the copy whole or not at all, and the rows still in the write-ahead log are in
// it. It is uploaded and read back before the room snapshot object, which stays the last object of a run, so a
// snapshot in the store has its assistant database there too. A run that stops between the two leaves an
// assistant object that no snapshot has; every backup removes those, and those of the snapshots it pruned. A
// workspace without an assistant database has a backup set without one, which restores as it always did.
//
// The credentials of a bucket come from the environment and nowhere else (a flag would end up in the shell
// history and in the process list): S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, with S3_SESSION_TOKEN when the
// keys are temporary; the names AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN are read when the
// S3_ ones are not set. Nothing here prints them.
//
// Exit codes are those of the other commands: 0 when the command did what it was asked, 2 for anything that
// stopped it (usage, a refused backup, a restore that failed a check). A failed command writes nothing a later
// run would mistake for a result: a backup uploads its snapshot last, and a restore leaves its target as it was.
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AssistantStore,
  backupWorkspace,
  BackupError,
  DirectoryObjectStore,
  listSnapshots,
  restoreWorkspace,
  S3ObjectStore,
  type BackupOptions,
  type BackupReport,
  type ObjectStore,
  type RestoreOptions,
  type RestoreReport,
} from "@wolfsdk/server";
import { UsageError } from "./errors.ts";
import type { CliIo } from "./run.ts";

// The EXIT_FRESH and EXIT_ERROR of run.ts, which this file cannot import without a cycle (run.ts runs the
// commands of this file); the tests hold the two copies together.
const EXIT_DONE = 0;
const EXIT_ERROR = 2;

/** The variables of the process the credentials are read from: `process.env`, or what a test supplies. */
export type BackupEnv = Readonly<Record<string, string | undefined>>;

const STORE_OPTIONS = {
  dir: { type: "string" },
  "s3-bucket": { type: "string" },
  "s3-endpoint": { type: "string" },
  "s3-region": { type: "string" },
  prefix: { type: "string" },
  json: { type: "boolean" },
} as const;

const BACKUP_OPTIONS = {
  ...STORE_OPTIONS,
  db: { type: "string" },
  blobs: { type: "string" },
  "assistant-db": { type: "string" },
  keep: { type: "string" },
  scratch: { type: "string" },
} as const;

const RESTORE_OPTIONS = {
  ...STORE_OPTIONS,
  db: { type: "string" },
  blobs: { type: "string" },
  "assistant-db": { type: "string" },
  snapshot: { type: "string" },
  list: { type: "boolean" },
} as const;

type StoreFlags = { dir?: string; "s3-bucket"?: string; "s3-endpoint"?: string; "s3-region"?: string };

/** The commands that open a store; a command that reads one (a restore) needs the directory to be there. */
type StoreCommand = "backup" | "restore" | "backup-registry" | "restore-host";

const setIn = (env: BackupEnv, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** The store the flags name: a directory (made by a backup when it is not there), or a bucket. */
function openStore(command: StoreCommand, flags: StoreFlags, env: BackupEnv): ObjectStore {
  const { dir, "s3-bucket": bucket, "s3-endpoint": endpoint, "s3-region": region } = flags;
  if (dir !== undefined && bucket !== undefined) throw new UsageError(`${command} takes --dir or --s3-bucket, not both`);
  if (dir !== undefined) {
    if (endpoint !== undefined || region !== undefined) throw new UsageError("--s3-endpoint and --s3-region go with --s3-bucket");
    if (existsSync(dir) ? !isDirectory(dir) : command.startsWith("restore")) throw new UsageError(`--dir ${dir} is not a directory`);
    return new DirectoryObjectStore(dir);
  }
  if (bucket === undefined || bucket === "") throw new UsageError(`${command} needs --dir <directory>, or --s3-bucket <name> with --s3-endpoint <url>`);
  if (endpoint === undefined) throw new UsageError("--s3-bucket needs --s3-endpoint <url>");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UsageError(`--s3-endpoint ${JSON.stringify(endpoint)} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("--s3-endpoint must be an http or https URL");
  if (url.username !== "" || url.password !== "") throw new UsageError("--s3-endpoint must not carry credentials: they come from the environment");
  const accessKeyId = setIn(env, "S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
  const secretAccessKey = setIn(env, "S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY");
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new UsageError("--s3-bucket needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the environment (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are read when those are not set)");
  }
  return new S3ObjectStore({
    bucket,
    endpoint,
    region: region ?? setIn(env, "S3_REGION", "AWS_REGION"),
    accessKeyId,
    secretAccessKey,
    sessionToken: setIn(env, "S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"),
  });
}

// The assistant database --------------------------------------------------------------------------------------

/**
 * Where `serve` keeps the assistant database of the room database `db` when `--assistant-db` does not say:
 * beside it, `rooms.assistant.sqlite` for `rooms.sqlite`. The default of `assistantOf` in run.ts, which this file
 * cannot import without a cycle; the tests hold the two copies together.
 */
export function assistantDbBeside(db: string): string {
  return join(dirname(db), `${basename(db, extname(db))}.assistant.sqlite`);
}

// The snapshot ids and the key prefixes of `@wolfsdk/server`, which checks both before this file uses them.
const SNAPSHOT_ID = /^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}$/;
const ASSISTANT_OBJECT = /^(\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12})\.assistant-([0-9a-f]{64})\.sqlite$/;

function normalizePrefix(prefix: string | undefined): string {
  const parts = (prefix ?? "").split("/").filter((part) => part !== "");
  return parts.length === 0 ? "" : `${parts.join("/")}/`;
}

const snapshotsUnder = (prefix: string): string => `${prefix}snapshots/`;
const assistantKey = (prefix: string, id: string, sha256: string): string => `${snapshotsUnder(prefix)}${id}.assistant-${sha256}.sqlite`;
const sha256Of = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
}

async function writeDurable(file: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A consistent copy of the SQLite database `source` (`what` names it in an error) in the new file `into`: `VACUUM
 * INTO`, one read transaction, which the server's writes never wait for, and which holds the rows still in the
 * write-ahead log. Read-only is preferred; a database in WAL mode whose server is stopped has no `-shm` file and
 * SQLite cannot open that read-only, so it is opened read-write instead (never created). No statement run here
 * writes to `source`.
 */
function snapshotDatabase(source: string, into: string, what: string): void {
  let db: Database | undefined;
  try {
    try {
      db = new Database(source, { readonly: true });
      db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
    } catch (e) {
      db?.close();
      if (!(e instanceof Error && "code" in e && e.code === "SQLITE_CANTOPEN")) throw e;
      db = new Database(source, { readwrite: true });
    }
    // A server that is starting or checkpointing on this file may hold it for a moment.
    db.exec("PRAGMA busy_timeout = 30000");
    db.query("VACUUM INTO ?").run(into);
  } catch (e) {
    throw new BackupError("SNAPSHOT_INVALID", `could not take a snapshot of ${what} ${source}: ${messageOf(e)}`);
  } finally {
    db?.close();
  }
}

/** SQLite's own integrity check of an open database; anything but one `ok` row is thrown. */
function checkIntegrity(db: Database): void {
  const checks = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (checks.length !== 1 || checks[0]?.integrity_check !== "ok") {
    throw new Error(`PRAGMA integrity_check says ${checks.map((row) => row.integrity_check).slice(0, 3).join("; ")}`);
  }
}

/**
 * Check a copy of an assistant database that is ours to open: SQLite's integrity check, the tables of the
 * assistant, and the server's own reading of it (`AssistantStore`, which refuses a schema version it does not
 * read). Anything else is a `SNAPSHOT_INVALID` that names `what`.
 */
function checkAssistant(file: string, what: string): void {
  let db: Database | undefined;
  try {
    db = new Database(file, { readwrite: true });
    checkIntegrity(db);
    if (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() === null) throw new Error("it has no schema version");
    db.query("SELECT COUNT(*) FROM tasks").get();
    db.close();
    db = undefined;
    new AssistantStore(file).close();
  } catch (e) {
    throw new BackupError("SNAPSHOT_INVALID", `${what} is not a readable assistant database: ${messageOf(e)}`);
  } finally {
    db?.close();
  }
}

/** Remove the assistant objects of snapshots that are not `retained`: those of pruned snapshots, and those a stopped run left. */
async function removeStrayAssistants(store: ObjectStore, prefix: string, retained: readonly string[]): Promise<void> {
  const head = snapshotsUnder(prefix);
  const kept = new Set(retained);
  for (const key of await store.list(head)) {
    const id = ASSISTANT_OBJECT.exec(key.slice(head.length))?.[1];
    if (id !== undefined && !kept.has(id)) await store.delete(key);
  }
}

export type AssistantBackup = { key: string; bytes: number; sha256: string };
export type FullBackupReport = BackupReport & { assistant?: AssistantBackup };

/**
 * `backupWorkspace`, with the assistant database `assistantDb` (or none) in the same backup set. The copy is taken
 * and checked before the room backup starts; it is uploaded, and read back, when the room backup puts its
 * snapshot object, just before that object.
 */
async function backupWithAssistant(options: BackupOptions, assistantDb: string | null): Promise<FullBackupReport> {
  const prefix = normalizePrefix(options.prefix);
  const { store } = options;
  if (assistantDb === null) {
    const report = await backupWorkspace(options);
    await removeStrayAssistants(store, prefix, report.retained);
    return report;
  }
  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), "wolfsdk-backup-assistant-"));
  try {
    const file = join(scratch, "assistant.sqlite");
    snapshotDatabase(assistantDb, file, "the assistant database");
    checkAssistant(file, `the snapshot of ${assistantDb}`);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const sha256 = sha256Of(bytes);
    const head = snapshotsUnder(prefix);
    let placed: AssistantBackup | undefined;
    const withAssistant: ObjectStore = {
      async put(key, body) {
        const id = key.startsWith(head) && key.endsWith(".sqlite") ? key.slice(head.length, -".sqlite".length) : "";
        if (placed === undefined && SNAPSHOT_ID.test(id)) {
          const at = assistantKey(prefix, id, sha256);
          await store.put(at, bytes);
          const back = await store.get(at);
          if (back === null || sha256Of(back) !== sha256) {
            await store.delete(at).catch(() => {});
            throw new BackupError("UPLOAD_MISMATCH", `${at} read back as ${back === null ? "nothing" : sha256Of(back)}, not ${sha256}`);
          }
          placed = { key: at, bytes: bytes.length, sha256 };
        }
        await store.put(key, body);
      },
      get: (key) => store.get(key),
      list: (under) => store.list(under),
      delete: (key) => store.delete(key),
    };
    const report = await backupWorkspace({ ...options, store: withAssistant });
    if (placed === undefined) throw new BackupError("STORE_ERROR", "the backup put no snapshot object, so the assistant database was not uploaded");
    await removeStrayAssistants(store, prefix, report.retained);
    return { ...report, assistant: placed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The assistant object of snapshot `id`, or `null` when the set has none. */
async function assistantObjectOf(store: ObjectStore, prefix: string, id: string): Promise<{ key: string; sha256: string } | null> {
  const head = snapshotsUnder(prefix);
  const found: { key: string; sha256: string }[] = [];
  for (const key of await store.list(`${head}${id}.assistant-`)) {
    const match = ASSISTANT_OBJECT.exec(key.slice(head.length));
    if (match !== null && match[1] === id) found.push({ key, sha256: match[2] as string });
  }
  if (found.length > 1) throw new BackupError("STORE_ERROR", `snapshot ${id} has ${found.length} assistant databases in the store: ${found.map((f) => f.key).join(", ")}`);
  return found[0] ?? null;
}

export type FullRestoreReport = RestoreReport & { assistant?: { path: string; bytes: number } };

/**
 * `restoreWorkspace`, with the assistant database of the snapshot, when the set has one, at `assistantDb`. The
 * assistant database is fetched, checked against its SHA-256 and by SQLite, and staged beside its target before
 * the room restore starts; it moves into place once the room restore has checked everything, just before the
 * room database, which stays last. Any failure removes what was built and leaves the target as it was.
 */
async function restoreWithAssistant(options: RestoreOptions, assistantDb: string): Promise<FullRestoreReport> {
  const { store } = options;
  const ids = await listSnapshots(store, options.prefix);
  const id = options.snapshot ?? ids.at(-1);
  const found = id !== undefined && ids.includes(id) ? await assistantObjectOf(store, normalizePrefix(options.prefix), id) : null;
  if (found === null) return restoreWorkspace({ ...options, snapshot: id });

  const target = resolve(assistantDb);
  for (const file of [target, `${target}-wal`, `${target}-shm`]) {
    if (await present(file)) {
      throw new BackupError("TARGET_NOT_EMPTY", `${file} already exists; a restore builds a workspace in an empty place, so give it a new --assistant-db, or move the old files away`);
    }
  }
  const staged = `${target}.restore.tmp`;
  const leftovers = [staged, `${staged}-wal`, `${staged}-shm`];
  await mkdir(dirname(target), { recursive: true });
  // Leftovers of a restore that crashed: they carry the name of this code and are only ever its own.
  for (const file of leftovers) await rm(file, { force: true });
  let moved = false;
  try {
    const bytes = await store.get(found.key);
    if (bytes === null) throw new BackupError("NO_SNAPSHOT", `the assistant database ${found.key} is gone from the store`);
    if (sha256Of(bytes) !== found.sha256) throw new BackupError("SNAPSHOT_CORRUPT", `${found.key} does not hash to its name: the assistant database of snapshot ${id} is damaged`);
    await writeDurable(staged, bytes);
    checkAssistant(staged, `the assistant database of snapshot ${id}`);
    const report = await restoreWorkspace({
      ...options,
      snapshot: id,
      onStage: async (stage) => {
        if (stage === "verify") {
          await rename(staged, target);
          moved = true;
        }
        await options.onStage?.(stage);
      },
    });
    await syncDirectory(dirname(target));
    return { ...report, assistant: { path: target, bytes: bytes.length } };
  } catch (e) {
    if (moved) await rm(target, { force: true });
    throw e;
  } finally {
    for (const file of leftovers) await rm(file, { force: true });
  }
}

// The commands ------------------------------------------------------------------------------------------------

/** What a failed operation says: the code of a `BackupError`, or the code the store's error carries. */
function failure(e: unknown): { code: string; message: string } {
  if (e instanceof BackupError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: "code" in e && typeof e.code === "string" ? e.code : "error", message: e.message };
  return { code: "error", message: String(e) };
}

/** Print the failure of an operation, as JSON when asked, and give the exit code of a stopped command. */
function fail(e: unknown, json: boolean | undefined, io: CliIo): number {
  const { code, message } = failure(e);
  if (json) io.out(JSON.stringify({ error: { code, message } }, null, 2));
  else io.err(`error: ${code}: ${message}`);
  return EXIT_ERROR;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function backupLines(report: FullBackupReport): string[] {
  return [
    `snapshot ${report.snapshot}  ${plural(report.snapshot_bytes, "byte")}`,
    `blobs: ${report.blobs_named} named, ${report.blobs_uploaded} uploaded (${plural(report.blobs_uploaded_bytes, "byte")}), ${report.blobs_reused} already in the store`,
    ...(report.assistant === undefined ? [] : [`assistant database: ${plural(report.assistant.bytes, "byte")}`]),
    `kept ${plural(report.retained.length, "snapshot")}; pruned ${report.pruned.length}, removed ${plural(report.blobs_removed, "blob")}`,
  ];
}

function restoreLines(report: FullRestoreReport, db: string, blobs: string): string[] {
  return [
    `restored snapshot ${report.snapshot} into ${db} and ${blobs}`,
    `${plural(report.documents, "document")}, ${plural(report.revisions, "revision")}, ${plural(report.blobs, "blob")} (${plural(report.blob_bytes, "byte")})`,
    ...(report.assistant === undefined ? [] : [`assistant database: ${report.assistant.path} (${plural(report.assistant.bytes, "byte")})`]),
  ];
}

/** A whole number from `least` up, or a usage error naming the flag. */
function wholeNumber(flag: string, text: string, least: number): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < least) throw new UsageError(`${flag} must be a whole number of at least ${least}`);
  return n;
}

/**
 * `backup`: snapshot the database of a workspace (the server may be running) and its assistant database when there
 * is one (`--assistant-db`, default beside `--db` as `serve` keeps it), upload the blobs the store does not hold,
 * then the assistant database, then the snapshot, and keep the newest `--keep` snapshots. Fails, and uploads no
 * snapshot, when the snapshot names a blob that is not on disk.
 */
export async function runBackup(args: string[], io: CliIo, env: BackupEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: BACKUP_OPTIONS, allowPositionals: false });
  if (values.db === undefined || values.blobs === undefined || values.keep === undefined) throw new UsageError("backup needs --db, --blobs and --keep");
  const keep = wholeNumber("--keep", values.keep, 1);
  if (existsSync(values.blobs) && !isDirectory(values.blobs)) throw new UsageError(`--blobs ${values.blobs} is not a directory`);
  if (values.scratch !== undefined && !isDirectory(values.scratch)) throw new UsageError(`--scratch ${values.scratch} is not a directory`);
  const named = values["assistant-db"];
  if (named !== undefined && !existsSync(named)) throw new UsageError(`--assistant-db ${named} is not there`);
  const assistantDb = named ?? assistantDbBeside(values.db);
  const store = openStore("backup", values, env);
  try {
    const report = await backupWithAssistant(
      { dbPath: values.db, blobDir: values.blobs, store, keep, prefix: values.prefix, scratchDir: values.scratch },
      // A workspace that never had an assistant has no such file: its backup is the one it always was.
      existsSync(assistantDb) ? assistantDb : null,
    );
    io.out(values.json ? JSON.stringify(report, null, 2) : backupLines(report).join("\n"));
    return EXIT_DONE;
  } catch (e) {
    return fail(e, values.json, io);
  }
}

/**
 * `restore`: rebuild a workspace from a backup, in a place that is empty: the newest snapshot, or the one named by
 * `--snapshot`, with its assistant database when the set holds one (`--assistant-db`, default beside `--db`).
 * `--list` prints the snapshots of the store instead, oldest first (the last is the default of a restore) and
 * restores nothing.
 */
export async function runRestore(args: string[], io: CliIo, env: BackupEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: RESTORE_OPTIONS, allowPositionals: false });
  if (values.list) {
    if (values.db !== undefined || values.blobs !== undefined || values["assistant-db"] !== undefined || values.snapshot !== undefined) {
      throw new UsageError("restore --list takes no --db, --blobs, --assistant-db or --snapshot");
    }
    const store = openStore("restore", values, env);
    try {
      const snapshots = await listSnapshots(store, values.prefix);
      io.out(values.json ? JSON.stringify({ snapshots }, null, 2) : [...snapshots, plural(snapshots.length, "snapshot")].join("\n"));
      return EXIT_DONE;
    } catch (e) {
      return fail(e, values.json, io);
    }
  }
  if (values.db === undefined || values.blobs === undefined) throw new UsageError("restore needs --db and --blobs, or --list");
  const store = openStore("restore", values, env);
  try {
    const report = await restoreWithAssistant(
      { store, prefix: values.prefix, snapshot: values.snapshot, dbPath: values.db, blobDir: values.blobs },
      values["assistant-db"] ?? assistantDbBeside(values.db),
    );
    io.out(values.json ? JSON.stringify(report, null, 2) : restoreLines(report, values.db, values.blobs).join("\n"));
    return EXIT_DONE;
  } catch (e) {
    return fail(e, values.json, io);
  }
}

// The hosted deployment ---------------------------------------------------------------------------------------
//
// The control plane of a hosted deployment (`wolfsdk-control-plane serve`) keeps three things beside its customers'
// workspaces in its data directory, and a host that lost them has documents nobody can sign in to:
//   registry.sqlite                   customers, routing names, accounts, sessions, sign-in tokens, plans, trials
//   control-plane.key                 the key every account's actor token and every agent token is derived under
//   customers/<id>/actors.json        the bearer tokens the customer's server knows, derived under that key
// `backup-registry` backs the first up as a snapshot, and the other two sealed in one object beside it, under the
// deployment prefix every customer's backup set lives under (`<prefix>/<customer id>`, written by `backup`):
//   <prefix>/_control-plane/snapshots/<id>.sqlite        the registry at one instant, named as a room snapshot is
//   <prefix>/_control-plane/snapshots/<id>.secrets.enc   the key and every customer's actors file, AES-256-GCM
// No customer id starts with `_`, so the two never meet. The registry is copied with `VACUUM INTO`, SQLite's
// online snapshot, as the room databases are: one read transaction, with the rows still in the write-ahead log,
// that the running control plane never waits for. The secrets are read after it, so an actors file is never older
// than the accounts of the snapshot. They are sealed under WOLF_BACKUP_SECRETS_KEY, a key the bucket never holds
// (64 hex digits, kept by the operator with the bucket's credentials); the object names the key only by an id, a
// hash that tells nothing about it. The secrets object is uploaded and read back first and the snapshot last, so a
// snapshot in the store has its secrets; retention keeps the newest `--keep` snapshots as `backup` does, and removes
// the secrets of every snapshot it does not keep.
//
// `restore-host` rebuilds a whole host into an empty data directory from the store alone: the newest registry
// snapshot, the key and the actors files from its secrets, and for every customer of that registry the newest
// snapshot of its backup set, with its blobs and assistant database (a customer that had no room database yet,
// and so no backup set, gets the empty directory `add-customer` makes). The registry moves into place last, so a
// data directory without one is not a restored host; any failure removes everything the restore made.
//
// A customer whose workspace was deleted (the deletion job of the control plane closed it, recorded the deletion in
// the registry's `customer_deletions` table and removed its directory) is not restored, though its backup set stays
// in the store until its backups expire: the restore skips it and reports it by id. The operator brings one back only
// by naming it (`--restore-deleted <id>`) with a reason (`--reason`), which the report records beside it. Its deletion
// stays on record in the restored registry, so the next run of the deletion job removes its directory again.

/** The variable the key that seals the secrets of a host backup is read from: 64 hex digits. */
export const SECRETS_KEY_VARIABLE = "WOLF_BACKUP_SECRETS_KEY";

/** The files of a control plane's data root (as registry.ts and accounts.ts of the closed control plane write them). */
const REGISTRY_FILE = "registry.sqlite";
const CONTROL_PLANE_KEY_FILE = "control-plane.key";
const ACTORS_FILE = "actors.json";
const CUSTOMERS_DIR = "customers";

/** Where the control plane's objects live under the deployment prefix; a customer id starts with a letter or digit. */
const CONTROL_PLANE_PREFIX = "_control-plane";

/** The customer id grammar of the registry: one path segment. A restore refuses a registry that holds another. */
const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const REGISTRY_OBJECT = /^(\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12})\.sqlite$/;
const SECRETS_OBJECT = /^(\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12})\.secrets\.enc$/;
const SECRETS_FORMAT = "wolfsdk.host-secrets.v1";
/** A sealed object: the magic, the 8 bytes of the key id, the 12-byte nonce, the ciphertext and the 16-byte tag. */
const SECRETS_MAGIC = "WOLFSEC1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 8;

/** A failure of the host commands that no `BackupError` code names: the secrets object cannot be opened. */
export class HostBackupError extends Error {
  readonly code: "SECRETS_UNREADABLE";

  constructor(code: "SECRETS_UNREADABLE", message: string) {
    super(message);
    this.name = "HostBackupError";
    this.code = code;
  }
}

type HostSecrets = {
  format: typeof SECRETS_FORMAT;
  /** The registry snapshot the secrets belong to; also bound into the seal, so they open with no other. */
  snapshot: string;
  /** The text of `control-plane.key`, as it was; `null` when the data root had none. */
  control_plane_key: string | null;
  /** The text of each customer's actors file, by customer id. */
  actors: Record<string, string>;
};

/** A deletion the registry records (`customer_deletions`, written by the deletion job of the control plane). */
type RegistryDeletion = { deleted_at: string; reason: string; backups_expire_at: string; backups_removed_at: string | null };

/** A customer of the registry, with its deletion when its workspace was deleted. */
type RegistryCustomer = { id: string; state: string; deletion: RegistryDeletion | null };

const controlPlaneHead = (prefix: string): string => `${normalizePrefix(prefix)}${CONTROL_PLANE_PREFIX}/snapshots/`;

/** The secrets key from the environment, or a usage error that says what it is. */
function secretsKeyOf(command: StoreCommand, env: BackupEnv): Buffer {
  const text = setIn(env, SECRETS_KEY_VARIABLE);
  if (text === undefined) {
    throw new UsageError(
      `${command} needs ${SECRETS_KEY_VARIABLE} in the environment: 64 hex digits that seal the control-plane key and the actors files, kept where the bucket is not`,
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new UsageError(`${SECRETS_KEY_VARIABLE} must be 64 hex digits`);
  return Buffer.from(text, "hex");
}

/** A name for a secrets key that tells nothing about it: 16 hex digits of a hash of it under a label of its own. */
export function secretsKeyId(key: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update("wolfsdk.backup-secrets-key\0").update(key).digest("hex").slice(0, KEY_ID_BYTES * 2);
}

const sealedData = (snapshot: string): Buffer => Buffer.from(`${SECRETS_FORMAT}\0${snapshot}`);

function seal(secrets: HostSecrets, key: Buffer): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(sealedData(secrets.snapshot));
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from(SECRETS_MAGIC, "latin1"), Buffer.from(secretsKeyId(key), "hex"), nonce, body, cipher.getAuthTag()]));
}

function unseal(bytes: Uint8Array, key: Buffer, snapshot: string, what: string): HostSecrets {
  const sealed = Buffer.from(bytes);
  const head = SECRETS_MAGIC.length + KEY_ID_BYTES;
  if (sealed.length < head + NONCE_BYTES + TAG_BYTES || sealed.subarray(0, SECRETS_MAGIC.length).toString("latin1") !== SECRETS_MAGIC) {
    throw new HostBackupError("SECRETS_UNREADABLE", `${what} is not a sealed secrets object`);
  }
  const sealedWith = sealed.subarray(SECRETS_MAGIC.length, head).toString("hex");
  const given = secretsKeyId(key);
  if (sealedWith !== given) {
    throw new HostBackupError("SECRETS_UNREADABLE", `${what} is sealed under the secrets key with id ${sealedWith}; ${SECRETS_KEY_VARIABLE} is the key with id ${given}`);
  }
  let text: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(head, head + NONCE_BYTES));
    decipher.setAAD(sealedData(snapshot));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    text = Buffer.concat([decipher.update(sealed.subarray(head + NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new HostBackupError("SECRETS_UNREADABLE", `${what} does not open under the secrets key with id ${given}: it is damaged, or it is not the secrets of snapshot ${snapshot}`);
  }
  const secrets = JSON.parse(text) as Partial<HostSecrets>;
  const actors = secrets.actors;
  const valid =
    secrets.format === SECRETS_FORMAT &&
    secrets.snapshot === snapshot &&
    (secrets.control_plane_key === null || typeof secrets.control_plane_key === "string") &&
    typeof actors === "object" &&
    actors !== null &&
    Object.entries(actors).every(([id, file]) => CUSTOMER_ID.test(id) && typeof file === "string");
  if (!valid) throw new HostBackupError("SECRETS_UNREADABLE", `${what} opens, but does not hold the secrets of snapshot ${snapshot} in the format ${SECRETS_FORMAT}`);
  return secrets as HostSecrets;
}

/**
 * Check a copy of a control-plane registry that is ours to open: SQLite's integrity and foreign key checks, a
 * schema version, and customers whose ids are each one path segment. Returns the customers, oldest first, each with
 * its deletion when the registry records one (a registry the deletion job never ran on has no table of them).
 */
function checkRegistry(file: string, what: string): RegistryCustomer[] {
  let db: Database | undefined;
  try {
    db = new Database(file, { readwrite: true });
    checkIntegrity(db);
    const orphans = db.query("PRAGMA foreign_key_check").all();
    if (orphans.length > 0) throw new Error(`PRAGMA foreign_key_check finds ${orphans.length} rows that name a missing row`);
    if (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() === null) throw new Error("it has no schema version");
    const customers = db.query<{ id: string; state: string }, []>("SELECT id, state FROM customers ORDER BY created_at, id").all();
    const unsafe = customers.find((customer) => !CUSTOMER_ID.test(customer.id));
    if (unsafe !== undefined) throw new Error(`the customer id ${JSON.stringify(unsafe.id)} is not one path segment`);
    const deletions = new Map<string, RegistryDeletion>();
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'customer_deletions'").get() !== null) {
      const rows = db.query<RegistryDeletion & { customer_id: string }, []>("SELECT customer_id, deleted_at, reason, backups_expire_at, backups_removed_at FROM customer_deletions").all();
      for (const { customer_id, ...deletion } of rows) deletions.set(customer_id, deletion);
    }
    return customers.map((customer) => ({ ...customer, deletion: deletions.get(customer.id) ?? null }));
  } catch (e) {
    throw new BackupError("SNAPSHOT_INVALID", `${what} is not a readable control-plane registry: ${messageOf(e)}`);
  } finally {
    db?.close();
  }
}

/** Put `bytes` at `key` and read them back; an object that differs is removed (it is ours) and refused. */
async function putVerified(store: ObjectStore, key: string, bytes: Uint8Array): Promise<void> {
  const sha256 = sha256Of(bytes);
  await store.put(key, bytes);
  const back = await store.get(key);
  if (back !== null && sha256Of(back) === sha256) return;
  await store.delete(key).catch(() => {});
  throw new BackupError("UPLOAD_MISMATCH", `${key} read back as ${back === null ? "nothing" : sha256Of(back)}, not ${sha256}`);
}

async function textIfPresent(file: string): Promise<string | null> {
  const handle = Bun.file(file);
  return (await handle.exists()) ? await handle.text() : null;
}

/** The registry snapshots under `head` and the snapshots that have a secrets object, oldest first. */
async function registryObjects(store: ObjectStore, head: string): Promise<{ snapshots: string[]; secrets: string[] }> {
  const snapshots: string[] = [];
  const secrets: string[] = [];
  for (const key of await store.list(head)) {
    const name = key.slice(head.length);
    const snapshot = REGISTRY_OBJECT.exec(name)?.[1];
    const sealed = SECRETS_OBJECT.exec(name)?.[1];
    if (snapshot !== undefined) snapshots.push(snapshot);
    else if (sealed !== undefined) secrets.push(sealed);
  }
  return { snapshots: snapshots.sort(), secrets: secrets.sort() };
}

export type RegistryBackupReport = {
  snapshot: string;
  snapshot_key: string;
  snapshot_bytes: number;
  customers: number;
  secrets: { key: string; bytes: number; key_id: string; control_plane_key: boolean; actors_files: number };
  /** Newest first, as `backup` reports them. */
  retained: string[];
  pruned: string[];
};

type RegistryBackupOptions = { dataRoot: string; store: ObjectStore; keep: number; prefix: string; scratchDir?: string; key: Buffer; now?: () => number };

/** Snapshot the registry of `dataRoot`, seal its secrets, upload both (the snapshot last) and keep the newest `keep`. */
export async function backupRegistry(options: RegistryBackupOptions): Promise<RegistryBackupReport> {
  const { store, keep, key } = options;
  if (!Number.isInteger(keep) || keep < 1) throw new BackupError("BAD_ARGUMENT", `keep must be a whole number of at least 1, got ${keep}`);
  const source = join(resolve(options.dataRoot), REGISTRY_FILE);
  if (!(await present(source))) throw new BackupError("NO_DATABASE", `no control-plane registry at ${source}`);
  const head = controlPlaneHead(options.prefix);
  const scratch = await mkdtemp(join(options.scratchDir ?? tmpdir(), "wolfsdk-backup-registry-"));
  try {
    const file = join(scratch, REGISTRY_FILE);
    snapshotDatabase(source, file, "the control-plane registry");
    const customers = checkRegistry(file, `the snapshot of ${source}`);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    const id = `${new Date((options.now ?? Date.now)()).toISOString().replace(/[-:]/g, "")}-${sha256Of(bytes).slice(0, 12)}`;
    // After the snapshot: an actors file is then at least as new as the accounts the snapshot holds.
    const actors: Record<string, string> = {};
    for (const customer of customers) {
      const text = await textIfPresent(join(options.dataRoot, CUSTOMERS_DIR, customer.id, ACTORS_FILE));
      if (text !== null) actors[customer.id] = text;
    }
    const keyText = await textIfPresent(join(options.dataRoot, CONTROL_PLANE_KEY_FILE));
    const sealed = seal({ format: SECRETS_FORMAT, snapshot: id, control_plane_key: keyText, actors }, key);
    const secretsKey = `${head}${id}.secrets.enc`;
    const snapshotKey = `${head}${id}.sqlite`;
    await putVerified(store, secretsKey, sealed);
    await putVerified(store, snapshotKey, bytes);

    // Retention: this snapshot and the newest `keep - 1` others; the snapshot objects go first, then every secrets
    // object without a kept snapshot (a run that stopped between its two uploads leaves one of those).
    const listing = await registryObjects(store, head);
    const others = listing.snapshots.filter((other) => other !== id).reverse();
    const pruned = others.slice(keep - 1);
    const retained = [id, ...others.slice(0, keep - 1)].sort().reverse();
    for (const old of pruned) await store.delete(`${head}${old}.sqlite`);
    const kept = new Set(retained);
    for (const old of listing.secrets) if (!kept.has(old)) await store.delete(`${head}${old}.secrets.enc`);
    return {
      snapshot: id,
      snapshot_key: snapshotKey,
      snapshot_bytes: bytes.length,
      customers: customers.length,
      secrets: { key: secretsKey, bytes: sealed.length, key_id: secretsKeyId(key), control_plane_key: keyText !== null, actors_files: Object.keys(actors).length },
      retained,
      pruned: pruned.reverse(),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export type RestoredCustomer = {
  id: string;
  state: string;
  /** The snapshot of its backup set that was restored; `null` when it had none and got an empty directory. */
  snapshot: string | null;
  documents: number;
  revisions: number;
  blobs: number;
  blob_bytes: number;
  assistant: boolean;
  /** Only for a deleted customer the operator named: its deletion, and the reason the operator gave. */
  restored_deleted?: { deleted_at: string; deletion_reason: string; reason: string };
};

/** A deleted customer the restore left out: no directory, no actors file, no rooms. */
export type SkippedCustomer = {
  id: string;
  state: string;
  deleted_at: string;
  /** Why the control plane deleted it: `trial-ended` or `owner-request`. */
  deletion_reason: string;
  backups_expire_at: string;
  backups_removed_at: string | null;
};

export type HostRestoreReport = {
  data: string;
  registry_snapshot: string;
  secrets_key_id: string;
  control_plane_key: boolean;
  actors_files: number;
  customers: RestoredCustomer[];
  /** The deleted customers that were not restored, oldest first. */
  skipped: SkippedCustomer[];
  seconds: number;
};

/** Deleted customers the operator restores anyway, by id, and why. */
export type RestoreDeleted = { ids: readonly string[]; reason: string };

type HostRestoreOptions = { dataRoot: string; store: ObjectStore; prefix: string; key: Buffer; restoreDeleted?: RestoreDeleted };

/** Rebuild a host's data directory, which must be missing or empty, from the store: see the head of this section. */
export async function restoreHost(options: HostRestoreOptions): Promise<HostRestoreReport> {
  const started = performance.now();
  const { store, key, restoreDeleted } = options;
  if (restoreDeleted !== undefined && (restoreDeleted.ids.length === 0 || restoreDeleted.reason.trim() === "")) {
    throw new BackupError("BAD_ARGUMENT", "a deleted customer is restored only when it is named, with a reason");
  }
  const overrideReason = restoreDeleted?.reason.trim() ?? "";
  const target = resolve(options.dataRoot);
  let madeTarget = false;
  if (await present(target)) {
    if (!isDirectory(target)) throw new BackupError("TARGET_NOT_EMPTY", `${target} is not a directory`);
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new BackupError("TARGET_NOT_EMPTY", `${target} holds ${plural(entries.length, "entry")}; a host is restored into an empty data directory, so give a new --data, or move the old one away`);
    }
  } else {
    await mkdir(target, { recursive: true });
    madeTarget = true;
  }
  const base = normalizePrefix(options.prefix);
  const head = controlPlaneHead(options.prefix);
  const staged = join(target, `${REGISTRY_FILE}.restore.tmp`);
  // What this restore made in the target, which was empty: removed again when it fails.
  const made: string[] = [];
  try {
    const id = (await registryObjects(store, head)).snapshots.at(-1);
    if (id === undefined) throw new BackupError("NO_SNAPSHOT", `the store holds no registry snapshot under ${head}`);
    const bytes = await store.get(`${head}${id}.sqlite`);
    if (bytes === null) throw new BackupError("NO_SNAPSHOT", `the registry snapshot ${head}${id}.sqlite is gone from the store`);
    if (sha256Of(bytes).slice(0, 12) !== id.slice(-12)) throw new BackupError("SNAPSHOT_CORRUPT", `${head}${id}.sqlite does not hash to its id: the registry snapshot is damaged`);
    const sealed = await store.get(`${head}${id}.secrets.enc`);
    if (sealed === null) throw new HostBackupError("SECRETS_UNREADABLE", `registry snapshot ${id} has no secrets object ${head}${id}.secrets.enc in the store`);
    const secrets = unseal(sealed, key, id, `${head}${id}.secrets.enc`);

    made.push(staged);
    await writeDurable(staged, bytes);
    const customers = checkRegistry(staged, `registry snapshot ${id}`);
    const named = new Set<string>(restoreDeleted?.ids);
    for (const name of named) {
      const customer = customers.find((each) => each.id === name);
      if (customer === undefined) throw new BackupError("BAD_ARGUMENT", `--restore-deleted ${name}: registry snapshot ${id} has no such customer`);
      if (customer.deletion === null) throw new BackupError("BAD_ARGUMENT", `--restore-deleted ${name}: the customer is not deleted, and a live customer is restored without it`);
    }
    if (secrets.control_plane_key !== null) {
      const file = join(target, CONTROL_PLANE_KEY_FILE);
      made.push(file);
      await writeDurable(file, new TextEncoder().encode(secrets.control_plane_key), 0o600);
    }
    const customersDir = join(target, CUSTOMERS_DIR);
    made.push(customersDir);
    await mkdir(customersDir);
    const restored: RestoredCustomer[] = [];
    const skipped: SkippedCustomer[] = [];
    let actorsFiles = 0;
    for (const customer of customers) {
      const { deletion } = customer;
      if (deletion !== null && !named.has(customer.id)) {
        // Deleted: what is left of it in the store waits for its expiry, not for a restore.
        skipped.push({
          id: customer.id,
          state: customer.state,
          deleted_at: deletion.deleted_at,
          deletion_reason: deletion.reason,
          backups_expire_at: deletion.backups_expire_at,
          backups_removed_at: deletion.backups_removed_at,
        });
        continue;
      }
      const override = deletion === null ? {} : { restored_deleted: { deleted_at: deletion.deleted_at, deletion_reason: deletion.reason, reason: overrideReason } };
      const dir = join(customersDir, customer.id);
      await mkdir(dir);
      const actors = secrets.actors[customer.id];
      if (actors !== undefined) actorsFiles++;
      // The file `add-customer` writes when it is given no actor: the customer's server will not start on it.
      await writeDurable(join(dir, ACTORS_FILE), new TextEncoder().encode(actors ?? "{}\n"), 0o600);
      const db = join(dir, "rooms.sqlite");
      const blobs = join(dir, "blobs");
      const under = `${base}${customer.id}`;
      if ((await listSnapshots(store, under)).length === 0) {
        await mkdir(blobs);
        restored.push({ id: customer.id, state: customer.state, snapshot: null, documents: 0, revisions: 0, blobs: 0, blob_bytes: 0, assistant: false, ...override });
        continue;
      }
      const report = await restoreWithAssistant({ store, prefix: under, dbPath: db, blobDir: blobs }, assistantDbBeside(db));
      restored.push({
        id: customer.id,
        state: customer.state,
        snapshot: report.snapshot,
        documents: report.documents,
        revisions: report.revisions,
        blobs: report.blobs,
        blob_bytes: report.blob_bytes,
        assistant: report.assistant !== undefined,
        ...override,
      });
    }
    const registry = join(target, REGISTRY_FILE);
    await rename(staged, registry);
    made[made.indexOf(staged)] = registry;
    await syncDirectory(target);
    return {
      data: target,
      registry_snapshot: id,
      secrets_key_id: secretsKeyId(key),
      control_plane_key: secrets.control_plane_key !== null,
      actors_files: actorsFiles,
      customers: restored,
      skipped,
      seconds: Math.round(performance.now() - started) / 1000,
    };
  } catch (e) {
    for (const file of made.reverse()) await rm(file, { recursive: true, force: true });
    if (madeTarget) await rmdir(target).catch(() => {});
    throw e;
  }
}

const REGISTRY_BACKUP_OPTIONS = { ...STORE_OPTIONS, data: { type: "string" }, keep: { type: "string" }, scratch: { type: "string" } } as const;
const HOST_RESTORE_OPTIONS = { ...STORE_OPTIONS, data: { type: "string" }, "restore-deleted": { type: "string", multiple: true }, reason: { type: "string" } } as const;

function registryBackupLines(report: RegistryBackupReport): string[] {
  return [
    `registry snapshot ${report.snapshot}  ${plural(report.snapshot_bytes, "byte")}, ${plural(report.customers, "customer")}`,
    `secrets: ${report.secrets.control_plane_key ? "the control-plane key" : "no control-plane key"} and ${plural(report.secrets.actors_files, "actors file")}, sealed under the key with id ${report.secrets.key_id}`,
    `kept ${plural(report.retained.length, "snapshot")}; pruned ${report.pruned.length}`,
  ];
}

function restoredLine(customer: RestoredCustomer): string {
  const line =
    customer.snapshot === null
      ? `customer ${customer.id} (${customer.state}): no backup set, an empty directory`
      : `customer ${customer.id} (${customer.state}): snapshot ${customer.snapshot}, ${plural(customer.documents, "document")}, ${plural(customer.revisions, "revision")}, ${plural(customer.blobs, "blob")} (${plural(customer.blob_bytes, "byte")})${customer.assistant ? ", assistant database" : ""}`;
  const deleted = customer.restored_deleted;
  return deleted === undefined ? line : `${line}; deleted ${deleted.deleted_at} (${deleted.deletion_reason}), restored as the operator asked: ${deleted.reason}`;
}

function hostRestoreLines(report: HostRestoreReport): string[] {
  return [
    `restored registry snapshot ${report.registry_snapshot} into ${report.data} in ${report.seconds} seconds`,
    `secrets (key id ${report.secrets_key_id}): ${report.control_plane_key ? "the control-plane key" : "no control-plane key"} and ${plural(report.actors_files, "actors file")}`,
    ...report.customers.map(restoredLine),
    ...report.skipped.map(
      (customer) =>
        `customer ${customer.id} (${customer.state}): deleted ${customer.deleted_at} (${customer.deletion_reason}), not restored; its backups expire ${customer.backups_expire_at}`,
    ),
  ];
}

/**
 * `backup-registry`: snapshot the registry of a control plane's data directory (the control plane may be running),
 * seal its key and its customers' actors files under WOLF_BACKUP_SECRETS_KEY, upload both under
 * `<prefix>/_control-plane/`, and keep the newest `--keep` snapshots.
 */
export async function runBackupRegistry(args: string[], io: CliIo, env: BackupEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: REGISTRY_BACKUP_OPTIONS, allowPositionals: false });
  if (values.data === undefined || values.keep === undefined || values.prefix === undefined) throw new UsageError("backup-registry needs --data, --keep and --prefix");
  const keep = wholeNumber("--keep", values.keep, 1);
  if (!isDirectory(values.data)) throw new UsageError(`--data ${values.data} is not a directory`);
  if (values.scratch !== undefined && !isDirectory(values.scratch)) throw new UsageError(`--scratch ${values.scratch} is not a directory`);
  const key = secretsKeyOf("backup-registry", env);
  const store = openStore("backup-registry", values, env);
  try {
    const report = await backupRegistry({ dataRoot: values.data, store, keep, prefix: values.prefix, scratchDir: values.scratch, key });
    io.out(values.json ? JSON.stringify(report, null, 2) : registryBackupLines(report).join("\n"));
    return EXIT_DONE;
  } catch (e) {
    return fail(e, values.json, io);
  }
}

/**
 * `restore-host`: rebuild a control plane's whole data directory, which must be missing or empty, from the store,
 * without the customers whose workspaces were deleted unless `--restore-deleted` names them with a `--reason`.
 */
export async function runRestoreHost(args: string[], io: CliIo, env: BackupEnv = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: HOST_RESTORE_OPTIONS, allowPositionals: false });
  if (values.data === undefined || values.prefix === undefined) throw new UsageError("restore-host needs --data and --prefix");
  const ids = values["restore-deleted"] ?? [];
  const reason = values.reason?.trim();
  if (ids.length > 0 && !reason) throw new UsageError("--restore-deleted needs --reason <text>: why the deleted workspace comes back, which the report records");
  if (reason !== undefined && ids.length === 0) throw new UsageError("--reason goes with --restore-deleted <customer id>");
  const key = secretsKeyOf("restore-host", env);
  const store = openStore("restore-host", values, env);
  try {
    const restoreDeleted = reason === undefined ? undefined : { ids, reason };
    const report = await restoreHost({ dataRoot: values.data, store, prefix: values.prefix, key, restoreDeleted });
    io.out(values.json ? JSON.stringify(report, null, 2) : hostRestoreLines(report).join("\n"));
    return EXIT_DONE;
  } catch (e) {
    return fail(e, values.json, io);
  }
}

export const HOST_USAGE = `wolfsdk-workspace: back up and restore the control plane of a hosted deployment

  wolfsdk-workspace backup-registry --data <dir> --keep <n> --prefix <key prefix>
                                    (--dir <dir> | --s3-bucket <name> --s3-endpoint <url> [--s3-region <name>])
                                    [--scratch <dir>] [--json]
  wolfsdk-workspace restore-host    --data <dir> --prefix <key prefix> (same store flags)
                                    [--restore-deleted <customer id> ... --reason <text>] [--json]

backup-registry  snapshot <dir>/registry.sqlite of a control plane (it may be running), seal <dir>/control-plane.key
                 and every customer's actors file under ${SECRETS_KEY_VARIABLE}, upload both under
                 <prefix>/_control-plane/, and keep the newest --keep snapshots. Each customer's rooms are backed up
                 under <prefix>/<customer id> by \`wolfsdk-workspace backup\`.
restore-host     rebuild a whole data directory, missing or empty, from the store alone: the newest registry, its key
                 and actors files, and for every customer of that registry its newest rooms, blobs and assistant
                 database. A customer whose workspace was deleted is skipped and reported by id, though backups of it
                 stay until they expire. Exit 0 on success, 2 on an error; a failed restore removes what it made.

--data <dir>     the data directory of \`wolfsdk-control-plane serve\`.
--prefix <p>     the deployment prefix, the one every customer's backup set is under.
--restore-deleted <id>
                 restore that deleted customer too (repeat for more); needs --reason <text>, which the report records.
                 Its deletion stays on record, so the next run of the deletion job removes its directory again.

${SECRETS_KEY_VARIABLE} (64 hex digits, never in the bucket) and the store credentials S3_ACCESS_KEY_ID and
S3_SECRET_ACCESS_KEY come from the environment; nothing prints them.`;

const HOST_COMMANDS: Readonly<Record<string, (args: string[], io: CliIo, env?: BackupEnv) => Promise<number>>> = {
  "backup-registry": runBackupRegistry,
  "restore-host": runRestoreHost,
};

/** Whether `command` is one of the host commands of this file, which `runHostCli` runs. */
export function isHostCommand(command: string | undefined): boolean {
  return command !== undefined && Object.hasOwn(HOST_COMMANDS, command);
}

const STDIO: CliIo = { out: (text) => console.log(text), err: (text) => console.error(text) };

/** Run `backup-registry` or `restore-host` with the arguments after the command: usage errors exit 2 with the usage. */
export async function runHostCli(argv: readonly string[], io: CliIo = STDIO, env: BackupEnv = process.env): Promise<number> {
  const [command, ...args] = argv;
  const run = command === undefined ? undefined : HOST_COMMANDS[command];
  if (run === undefined) {
    io.err(`error: ${JSON.stringify(command)} is not a host command\n\n${HOST_USAGE}`);
    return EXIT_ERROR;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.out(HOST_USAGE);
    return EXIT_DONE;
  }
  try {
    return await run(args, io, env);
  } catch (e) {
    const parseError = e instanceof Error && "code" in e && typeof e.code === "string" && e.code.startsWith("ERR_PARSE_ARGS");
    if (e instanceof UsageError || parseError) {
      io.err(`error: ${messageOf(e)}\n\n${HOST_USAGE}`);
      return EXIT_ERROR;
    }
    throw e;
  }
}
