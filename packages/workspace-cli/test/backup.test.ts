// The commands `backup` and `restore`, called in process (their output and exit codes are the contract), against a
// running workspace of the stand-in reactor and two stores: a directory, and an in-process server that speaks the
// part of the S3 protocol the backup uses, which the real S3 client of Bun talks to over HTTP. The work itself,
// and its failure cases, are tested in the server package; here it is the command line, the store flags, the
// credentials, the reports, and the assistant database the commands add to the backup set.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ASSISTANT_CONTRACT, summarizeAssistantUsage, type AssistantTurn } from "@wolfsdk/protocol/workspace";
import { AssistantStore, BlobStore, isRoomDatabase, RoomStore } from "@wolfsdk/server";
import { alice, bytesOf, committed, type Harness, makeHarness, must, seedRoom, sha256, textOf } from "../../server/test/fixtures/harness.ts";
import {
  assistantDbBeside,
  type BackupEnv,
  HOST_USAGE,
  runBackup,
  runBackupRegistry,
  runHostCli,
  runRestore,
  runRestoreHost,
  SECRETS_KEY_VARIABLE,
  secretsKeyId,
} from "../src/backup.ts";
import { UsageError } from "../src/errors.ts";
import { ASSISTANT_KEY_VARIABLE, assistantOf, EXIT_ERROR, EXIT_FRESH, type CliIo } from "../src/run.ts";

setDefaultTimeout(120_000);

// The workspace -----------------------------------------------------------------------------------------------

async function append(h: Harness, doc: string, text: string): Promise<void> {
  const head = must(await h.server.readHead("room", alice, doc)).head;
  committed(await h.server.edit("room", alice, { doc_name: doc, base_revision: head.revision, mode: "commit", batch: { ops: [{ op: "append", text }] } }));
}

/** Two documents and three committed edits of the first. */
async function populate(h: Harness): Promise<void> {
  await seedRoom(h);
  must(await h.server.addDocument("room", alice, { name: "notes.docx", format: "docx", bytes: bytesOf("notes") }));
  await append(h, "doc.docx", " one");
  await append(h, "doc.docx", " two");
}

type Rows = Record<string, string | number | null>[];

function query(file: string, sql: string): Rows {
  const db = new Database(file, { readwrite: true });
  try {
    return db.query(sql).all() as Rows;
  } finally {
    db.close();
  }
}

/** Every document and revision of a workspace, and the bytes of each head, read through the files. */
async function describeWorkspace(dbPath: string, blobDir: string) {
  const documents = query(dbPath, "SELECT room_id, name, revision, sha256, format FROM documents ORDER BY room_id, name");
  const log = query(dbPath, "SELECT room_id, seq, doc_name, revision, base_sha256, result_sha256, author, batch, committed_at FROM session_log ORDER BY room_id, seq");
  const blobs = new BlobStore(blobDir);
  const texts: Record<string, string> = {};
  for (const row of documents) texts[`${row.room_id}/${row.name}`] = textOf((await blobs.get(String(row.sha256))) ?? new Uint8Array());
  return { documents, log, texts };
}

const dbOf = (h: Harness): string => join(h.dir, "rooms.sqlite");
const blobsOf = (h: Harness): string => join(h.dir, "blobs");

// The assistant -----------------------------------------------------------------------------------------------

/** Where `serve` keeps the assistant database of the harness workspace when no flag says otherwise. */
const assistantDbOf = (h: Harness): string => join(h.dir, "rooms.assistant.sqlite");

const PERIOD = "2026-11";

/** The finished turn of task `n` (1 to 9) of `user` in `conversation`; task n used n model calls' worth of tokens. */
function turnOf(n: number, user: string, conversation: string): AssistantTurn {
  return {
    contract: ASSISTANT_CONTRACT,
    task_id: `task-${n}`,
    conversation_id: conversation,
    room_id: "room",
    workspace_id: "ws",
    user: { kind: "user", id: user, name: user },
    assistant: { kind: "agent", id: `assistant-${user}`, name: `Assistant (${user})` },
    request: { text: `question ${n}`, doc_name: "doc.docx", target_address: null },
    outcome: "answered",
    answer: `answer ${n}`,
    failure: null,
    steps: [],
    proposal_ids: [],
    model: "open-model-1",
    usage: { model_calls: n, prompt_tokens: 100 * n, cached_tokens: 10 * n, completion_tokens: n },
    started_at: `${PERIOD}-0${n}T10:00:00.000Z`,
    finished_at: `${PERIOD}-0${n}T10:00:05.000Z`,
  };
}

/** Count task `n` as the server does at its first model call, and store its turn unless it is still running. */
function storeTask(store: AssistantStore, n: number, user: string, conversation: string, finished = true): void {
  const turn = turnOf(n, user, conversation);
  store.start({ task_id: turn.task_id, workspace_id: "ws", room_id: "room", user_id: user, conversation_id: conversation, started_at: turn.started_at });
  if (finished) store.finish(turn);
}

/** What the server reads from an assistant database: the tasks of each seat in the month, the usage of the month, and the two conversations. */
function assistantView(file: string) {
  const store = new AssistantStore(file);
  try {
    return {
      seats: { ada: store.count("ada", PERIOD), bo: store.count("bo", PERIOD) },
      usage: summarizeAssistantUsage("ws", PERIOD, store.turns("ws", PERIOD)),
      conversations: { ada: store.conversation("room", "ada", "conv-ada"), bo: store.conversation("room", "bo", "conv-bo") },
    };
  } finally {
    store.close();
  }
}

// The stores --------------------------------------------------------------------------------------------------

const BUCKET = "test-bucket";

type FakeS3 = {
  endpoint: string;
  objects: Map<string, Uint8Array>;
  accessKeyId: string;
  secretAccessKey: string;
  methods: Set<string>;
  /** The `<key id>/<date>/<region>/s3/aws4_request` of every signed request. */
  scopes: Set<string>;
  stop(): void;
};

const xml = (status: number, body: string): Response => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "content-type": "application/xml" } });

/** Path-style PutObject, GetObject, DeleteObject and ListObjectsV2. The signature is not verified (a fake holds no real secret); the access key id is. */
function startFakeS3(): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const methods = new Set<string>();
  const scopes = new Set<string>();
  const accessKeyId = `test-id-${crypto.randomUUID()}`;
  const secretAccessKey = `test-secret-${crypto.randomUUID()}`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      methods.add(req.method);
      const body = new Uint8Array(await req.arrayBuffer());
      const scope = /Credential=([^,\s]+)/.exec(req.headers.get("authorization") ?? "")?.[1];
      if (scope === undefined || !scope.startsWith(`${accessKeyId}/`)) {
        return xml(403, "<Error><Code>InvalidAccessKeyId</Code><Message>The access key id is not known</Message></Error>");
      }
      scopes.add(scope);
      if (!url.pathname.startsWith(`/${BUCKET}`)) return xml(404, "<Error><Code>NoSuchBucket</Code><Message>no such bucket</Message></Error>");
      const key = decodeURIComponent(url.pathname.slice(BUCKET.length + 2));
      if (req.method === "PUT") {
        objects.set(key, body);
        return new Response(null, { status: 200, headers: { etag: `"${sha256(body).slice(0, 32)}"` } });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const limit = Math.min(Number(url.searchParams.get("max-keys") ?? 1000), 1000);
        const after = url.searchParams.get("continuation-token") ?? "";
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = matching.slice(0, limit);
        const truncated = matching.length > page.length;
        return xml(
          200,
          `<ListBucketResult><Name>${BUCKET}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${limit}</MaxKeys>` +
            `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ""}` +
            page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.length ?? 0}</Size></Contents>`).join("") +
            "</ListBucketResult>",
        );
      }
      if (req.method === "GET") {
        const found = objects.get(key);
        return found === undefined ? xml(404, `<Error><Code>NoSuchKey</Code><Message>no such key</Message><Key>${key}</Key></Error>`) : new Response(found.slice());
      }
      return xml(400, "<Error><Code>InvalidRequest</Code><Message>not supported by this fake</Message></Error>");
    },
  });
  return { endpoint: `http://127.0.0.1:${server.port}`, objects, accessKeyId, secretAccessKey, methods, scopes, stop: () => void server.stop(true) };
}

// Running the commands ----------------------------------------------------------------------------------------

type Ran = { code: number; out: string; err: string };

async function call(command: (args: string[], io: CliIo, env?: BackupEnv) => Promise<number>, args: string[], env: BackupEnv = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await command(args, io, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

let dir: string;
let h: Harness;
let store: string;
let s3: FakeS3 | null;
let live: AssistantStore | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-workspace-backup-"));
  h = await makeHarness();
  store = join(dir, "store");
  s3 = null;
  live = null;
});
afterEach(async () => {
  s3?.stop();
  live?.close();
  await h.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** The assistant database of the harness workspace, open as a running server holds it. */
function openAssistant(): AssistantStore {
  live = new AssistantStore(assistantDbOf(h));
  return live;
}

const place = (name: string): { db: string; blobs: string } => ({ db: join(dir, name, "rooms.sqlite"), blobs: join(dir, name, "blobs") });

/** `backup` of the harness workspace into the directory store. */
const backup = (...extra: string[]): Promise<Ran> => call(runBackup, ["--db", dbOf(h), "--blobs", blobsOf(h), "--dir", store, "--keep", "3", ...extra]);

const restore = (name: string, ...extra: string[]): Promise<Ran> => {
  const { db, blobs } = place(name);
  return call(runRestore, ["--db", db, "--blobs", blobs, "--dir", store, ...extra]);
};

/** `restore --list` of the directory store. */
const list = (...extra: string[]): Promise<Ran> => call(runRestore, ["--list", "--dir", store, ...extra]);

function bucketFlags(fake: FakeS3, ...extra: string[]): string[] {
  return ["--s3-bucket", BUCKET, "--s3-endpoint", fake.endpoint, ...extra];
}

const credentials = (fake: FakeS3): BackupEnv => ({ S3_ACCESS_KEY_ID: fake.accessKeyId, S3_SECRET_ACCESS_KEY: fake.secretAccessKey });

// A directory -------------------------------------------------------------------------------------------------

describe("a directory store", () => {
  test("backs a running workspace up and restores it: the same documents, revisions and bytes, and a database the server opens", async () => {
    await populate(h);
    const source = await describeWorkspace(dbOf(h), blobsOf(h));
    expect(source.documents).toHaveLength(2);
    expect(source.log.length).toBeGreaterThanOrEqual(2);

    const made = await backup();
    expect(made).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(made.out).toMatch(/^snapshot \d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}  \d+ bytes\n/);
    expect(made.out).toContain("already in the store");
    expect(made.out).toContain("kept 1 snapshot; pruned 0, removed 0 blobs");

    const listed = await list();
    const [id] = listed.out.split("\n");
    expect(listed).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(listed.out).toBe(`${id}\n1 snapshot`);

    const restored = await restore("copy");
    const { db, blobs } = place("copy");
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    const [placed, counted] = restored.out.split("\n");
    expect(placed).toBe(`restored snapshot ${id} into ${db} and ${blobs}`);
    expect(counted).toMatch(new RegExp(`^2 documents, ${source.log.length} revisions, \\d+ blobs \\(\\d+ bytes\\)$`));
    expect(await describeWorkspace(db, blobs)).toEqual(source);
    expect(isRoomDatabase(db)).toBe(true);
    new RoomStore(db).close();
  });

  test("prints the reports as JSON, and the list", async () => {
    await populate(h);
    const made = await backup("--json");
    const report = JSON.parse(made.out);
    expect(made.code).toBe(EXIT_FRESH);
    expect(report).toMatchObject({ blobs_reused: 0, pruned: [], blobs_removed: 0 });
    expect(report.blobs_uploaded).toBe(report.blobs_named);
    expect(report.retained).toEqual([report.snapshot]);

    const listed = await list("--json");
    expect(JSON.parse(listed.out)).toEqual({ snapshots: [report.snapshot] });

    const restored = await restore("copy", "--json");
    expect(JSON.parse(restored.out)).toMatchObject({ snapshot: report.snapshot, documents: 2, blobs: report.blobs_named });
  });

  test("keeps the newest --keep snapshots, and a restore takes the newest or the one named", async () => {
    await populate(h);
    const first = JSON.parse((await backup("--json")).out);
    await append(h, "doc.docx", " three");
    const second = JSON.parse((await backup("--json")).out);
    expect([...second.retained].sort()).toEqual([first.snapshot, second.snapshot].sort());

    expect((await restore("newest")).code).toBe(EXIT_FRESH);
    expect((await restore("older", "--snapshot", first.snapshot)).code).toBe(EXIT_FRESH);
    const newest = place("newest");
    const older = place("older");
    const rowsOf = (file: string): number => query(file, "SELECT COUNT(*) AS n FROM session_log")[0]?.n as number;
    expect(rowsOf(newest.db)).toBe(rowsOf(older.db) + 1);

    const pruned = await backup("--keep", "1", "--json");
    const report = JSON.parse(pruned.out);
    expect([...report.pruned].sort()).toEqual([first.snapshot, second.snapshot].sort());
    expect(report.retained).toEqual([report.snapshot]);
    expect(JSON.parse((await list("--json")).out).snapshots).toEqual([report.snapshot]);
  });

  test("a restore into a place that holds a workspace stops with the reason, and changes nothing", async () => {
    await populate(h);
    await backup();
    const { db } = place("copy");
    const target = dirname(db);
    expect((await restore("copy")).code).toBe(EXIT_FRESH);
    const before = new Uint8Array(await readFile(db));
    const entries = (await readdir(target)).sort();

    const again = await restore("copy");
    expect(again.code).toBe(EXIT_ERROR);
    expect(again.out).toBe("");
    expect(again.err).toMatch(/^error: TARGET_NOT_EMPTY: /);
    expect(new Uint8Array(await readFile(db))).toEqual(before);
    expect((await readdir(target)).sort()).toEqual(entries);

    const asJson = await restore("copy", "--json");
    expect(asJson.code).toBe(EXIT_ERROR);
    expect(asJson.err).toBe("");
    expect(JSON.parse(asJson.out).error.code).toBe("TARGET_NOT_EMPTY");
  });

  test("a restore from a store with no snapshot, or no such snapshot, stops and creates nothing", async () => {
    await mkdir(store, { recursive: true });
    const none = await restore("copy");
    expect(none).toMatchObject({ code: EXIT_ERROR, out: "" });
    expect(none.err).toMatch(/^error: NO_SNAPSHOT: /);
    await populate(h);
    await backup();
    const missing = await restore("copy", "--snapshot", "20200101T000000.000Z-000000000000");
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.err).toMatch(/^error: NO_SNAPSHOT: /);
    expect(existsSync(place("copy").db)).toBe(false);
    expect(existsSync(place("copy").blobs)).toBe(false);
  });

  test("a backup of a database that is not there stops and writes nothing to the store", async () => {
    const ran = await call(runBackup, ["--db", join(dir, "nothing.sqlite"), "--blobs", blobsOf(h), "--dir", store, "--keep", "2"]);
    expect(ran.code).toBe(EXIT_ERROR);
    expect(ran.err).toMatch(/^error: NO_DATABASE: /);
    expect(existsSync(store)).toBe(false);
    expect(existsSync(join(dir, "nothing.sqlite"))).toBe(false);
  });

  test("a backup that finds a blob missing on disk fails and uploads no snapshot", async () => {
    await populate(h);
    const fan = (await readdir(blobsOf(h), { withFileTypes: true })).find((entry) => entry.isDirectory());
    if (fan === undefined) throw new Error("the workspace holds no blob");
    const victim = join(blobsOf(h), fan.name, (await readdir(join(blobsOf(h), fan.name)))[0] as string);
    await rm(victim);
    const ran = await backup("--json");
    expect(ran.code).toBe(EXIT_ERROR);
    expect(JSON.parse(ran.out).error.code).toBe("BLOB_MISSING");
    expect(existsSync(store)).toBe(false);
  });

  test("--prefix keeps two workspaces in one store, apart", async () => {
    await populate(h);
    await backup("--prefix", "team-a");
    expect((await list("--prefix", "team-b")).out).toBe("0 snapshots");
    expect(JSON.parse((await list("--prefix", "team-a", "--json")).out).snapshots).toHaveLength(1);
    expect((await restore("copy", "--prefix", "team-a")).code).toBe(EXIT_FRESH);
    expect((await restore("other", "--prefix", "team-b")).err).toMatch(/^error: NO_SNAPSHOT: /);
  });
});

// The assistant database --------------------------------------------------------------------------------------

describe("the assistant database", () => {
  test("is backed up beside the room database of a running server and restored: the same usage per seat in the month and the same conversations", async () => {
    await populate(h);
    const assistant = openAssistant();
    storeTask(assistant, 1, "ada", "conv-ada");
    storeTask(assistant, 2, "bo", "conv-bo");
    storeTask(assistant, 3, "ada", "conv-ada");
    // Counted against the seat, and never finished: the server stopped under it.
    storeTask(assistant, 4, "ada", "conv-ada", false);
    const source = assistantView(assistantDbOf(h));
    expect(source.seats).toEqual({ ada: 3, bo: 1 });
    expect(source.usage.seats.map((seat) => [seat.user_id, seat.tasks])).toEqual([
      ["ada", 2],
      ["bo", 1],
    ]);
    expect(source.conversations.ada.map((turn) => turn.task_id)).toEqual(["task-1", "task-3"]);
    // The server holds the file open: its rows are in the write-ahead log, which a copy of the file alone would miss.
    expect(existsSync(`${assistantDbOf(h)}-wal`)).toBe(true);

    const made = await backup();
    expect(made).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(made.out.split("\n")[2]).toMatch(/^assistant database: \d+ bytes$/);
    const report = JSON.parse((await backup("--json")).out);
    expect(report.assistant.key).toBe(`snapshots/${report.snapshot}.assistant-${report.assistant.sha256}.sqlite`);
    expect(sha256(new Uint8Array(await readFile(join(store, report.assistant.key))))).toBe(report.assistant.sha256);

    const restored = await restore("copy");
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    const copy = join(dir, "copy", "rooms.assistant.sqlite");
    expect(restored.out.split("\n")[2]).toMatch(new RegExp(`^assistant database: ${copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+ bytes\\)$`));
    expect(assistantView(copy)).toEqual(source);
    expect(await describeWorkspace(place("copy").db, place("copy").blobs)).toEqual(await describeWorkspace(dbOf(h), blobsOf(h)));
  });

  test("a task that finishes during the backup is in the backup whole or not at all", async () => {
    await populate(h);
    const assistant = openAssistant();
    storeTask(assistant, 1, "ada", "conv-ada");
    storeTask(assistant, 2, "ada", "conv-ada", false);
    // Task 2 finishes on a connection of its own, in a transaction that is still open while the backup runs.
    const writer = new Database(assistantDbOf(h), { readwrite: true });
    try {
      writer.exec("PRAGMA busy_timeout = 5000");
      writer.exec("BEGIN IMMEDIATE");
      writer.query("UPDATE tasks SET turn = ? WHERE task_id = 'task-2'").run(JSON.stringify(turnOf(2, "ada", "conv-ada")));
      const during = JSON.parse((await backup("--json")).out);
      writer.exec("COMMIT");
      const after = JSON.parse((await backup("--json")).out);

      expect((await restore("during", "--snapshot", during.snapshot)).code).toBe(EXIT_FRESH);
      expect((await restore("after", "--snapshot", after.snapshot)).code).toBe(EXIT_FRESH);
      const before = assistantView(join(dir, "during", "rooms.assistant.sqlite"));
      const finished = assistantView(join(dir, "after", "rooms.assistant.sqlite"));
      expect(before.seats.ada).toBe(2);
      expect(before.conversations.ada.map((turn) => turn.task_id)).toEqual(["task-1"]);
      expect(finished.seats.ada).toBe(2);
      expect(finished.conversations.ada.map((turn) => turn.task_id)).toEqual(["task-1", "task-2"]);
      expect(finished).toEqual(assistantView(assistantDbOf(h)));
    } finally {
      writer.close();
    }
  });

  test("a workspace that never had an assistant: the backup set and the reports are what they were, and its restore succeeds without one", async () => {
    await populate(h);
    const made = await backup();
    expect(made.code).toBe(EXIT_FRESH);
    expect(made.out).not.toContain("assistant");
    expect(made.out.split("\n")).toHaveLength(3);
    const report = JSON.parse((await backup("--json")).out);
    expect(report).not.toHaveProperty("assistant");
    expect((await readdir(join(store, "snapshots"))).sort()).toEqual(report.retained.flatMap((id: string) => [`${id}.blobs.json`, `${id}.sqlite`]).sort());
    expect(existsSync(assistantDbOf(h))).toBe(false);

    const restored = await restore("copy", "--json");
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(JSON.parse(restored.out)).not.toHaveProperty("assistant");
    expect((await restore("text")).out.split("\n")).toHaveLength(2);
    expect(existsSync(join(dir, "copy", "rooms.assistant.sqlite"))).toBe(false);
    expect(await describeWorkspace(place("copy").db, place("copy").blobs)).toEqual(await describeWorkspace(dbOf(h), blobsOf(h)));
  });

  test("a set made before the server had an assistant restores without one after it has", async () => {
    await populate(h);
    const plain = JSON.parse((await backup("--json")).out);
    storeTask(openAssistant(), 1, "ada", "conv-ada");
    const withAssistant = JSON.parse((await backup("--json")).out);
    expect(withAssistant.assistant).toBeDefined();
    expect((await restore("plain", "--snapshot", plain.snapshot)).code).toBe(EXIT_FRESH);
    expect(existsSync(join(dir, "plain", "rooms.assistant.sqlite"))).toBe(false);
    expect((await restore("newest")).code).toBe(EXIT_FRESH);
    expect(assistantView(join(dir, "newest", "rooms.assistant.sqlite")).seats.ada).toBe(1);
  });

  test("pruning removes the assistant database of a pruned snapshot, and one a stopped run left behind", async () => {
    await populate(h);
    const assistant = openAssistant();
    storeTask(assistant, 1, "ada", "conv-ada");
    const first = JSON.parse((await backup("--json")).out);
    // A run that stopped after its assistant database and before its snapshot object.
    const stray = `20200101T000000.000Z-000000000000.assistant-${"0".repeat(64)}.sqlite`;
    await writeFile(join(store, "snapshots", stray), "left behind");
    storeTask(assistant, 2, "bo", "conv-bo");
    const second = JSON.parse((await backup("--keep", "1", "--json")).out);
    expect(second.pruned).toEqual([first.snapshot]);
    expect((await readdir(join(store, "snapshots"))).sort()).toEqual(
      [`${second.snapshot}.assistant-${second.assistant.sha256}.sqlite`, `${second.snapshot}.blobs.json`, `${second.snapshot}.sqlite`].sort(),
    );
  });

  test("--assistant-db names the file on both sides", async () => {
    await populate(h);
    const elsewhere = join(dir, "kept-apart.sqlite");
    live = new AssistantStore(elsewhere);
    storeTask(live, 1, "ada", "conv-ada");
    const made = JSON.parse((await backup("--assistant-db", elsewhere, "--json")).out);
    expect(made.assistant.bytes).toBeGreaterThan(0);
    const target = join(dir, "restored-apart.sqlite");
    expect((await restore("copy", "--assistant-db", target)).code).toBe(EXIT_FRESH);
    expect(existsSync(join(dir, "copy", "rooms.assistant.sqlite"))).toBe(false);
    expect(assistantView(target)).toEqual(assistantView(elsewhere));
  });

  test("a damaged assistant database stops the restore before anything moves into place", async () => {
    await populate(h);
    storeTask(openAssistant(), 1, "ada", "conv-ada");
    const made = JSON.parse((await backup("--json")).out);
    await writeFile(join(store, made.assistant.key), "damaged");
    const ran = await restore("copy");
    expect(ran).toMatchObject({ code: EXIT_ERROR, out: "" });
    expect(ran.err).toMatch(/^error: SNAPSHOT_CORRUPT: /);
    expect(await readdir(join(dir, "copy"))).toEqual([]);
  });

  test("a restore into a place that holds an assistant database stops with the reason, and changes nothing", async () => {
    await populate(h);
    storeTask(openAssistant(), 1, "ada", "conv-ada");
    await backup();
    await mkdir(join(dir, "copy"));
    await writeFile(join(dir, "copy", "rooms.assistant.sqlite"), "someone else's");
    const ran = await restore("copy");
    expect(ran.code).toBe(EXIT_ERROR);
    expect(ran.err).toMatch(/^error: TARGET_NOT_EMPTY: .*rooms\.assistant\.sqlite already exists/);
    expect(await readdir(join(dir, "copy"))).toEqual(["rooms.assistant.sqlite"]);
    expect(await readFile(join(dir, "copy", "rooms.assistant.sqlite"), "utf8")).toBe("someone else's");
  });

  test("a restore that the room database refuses leaves no assistant database behind", async () => {
    await populate(h);
    storeTask(openAssistant(), 1, "ada", "conv-ada");
    await backup();
    await mkdir(join(dir, "copy"));
    await writeFile(join(dir, "copy", "rooms.sqlite"), "a workspace already");
    const ran = await restore("copy");
    expect(ran.err).toMatch(/^error: TARGET_NOT_EMPTY: /);
    expect(await readdir(join(dir, "copy"))).toEqual(["rooms.sqlite"]);
  });

  test("is where serve keeps it: beside --db", () => {
    const flags = { "assistant-url": "https://models.example.test/v1/chat/completions", "assistant-model": "open-model-1" };
    for (const db of ["/data/rooms.sqlite", "rooms.db", "/srv/workspace/team"]) {
      expect(assistantDbBeside(db)).toBe(assistantOf(flags, db, { [ASSISTANT_KEY_VARIABLE]: "any" })?.storePath as string);
    }
  });
});

// A bucket ----------------------------------------------------------------------------------------------------

describe("an S3 bucket", () => {
  test("backs up and restores through the S3 protocol, signing for the region it was given, with the credentials of the environment", async () => {
    const fake = (s3 = startFakeS3());
    await populate(h);
    const source = await describeWorkspace(dbOf(h), blobsOf(h));

    const made = await call(runBackup, ["--db", dbOf(h), "--blobs", blobsOf(h), ...bucketFlags(fake, "--s3-region", "test-region-1"), "--keep", "2"], credentials(fake));
    expect(made).toMatchObject({ code: EXIT_FRESH, err: "" });
    const keys = [...fake.objects.keys()];
    expect(keys.filter((k) => k.startsWith("snapshots/") && k.endsWith(".sqlite"))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("blobs/")).length).toBeGreaterThan(0);
    expect([...fake.methods].sort()).toEqual(["GET", "PUT"]);
    expect([...fake.scopes].every((scope) => scope.split("/")[2] === "test-region-1")).toBe(true);

    const listed = await call(runRestore, ["--list", ...bucketFlags(fake, "--s3-region", "test-region-1")], credentials(fake));
    expect(listed.out).toMatch(/^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}\n1 snapshot$/);

    const { db, blobs } = place("copy");
    const restored = await call(runRestore, ["--db", db, "--blobs", blobs, ...bucketFlags(fake, "--s3-region", "test-region-1")], credentials(fake));
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(await describeWorkspace(db, blobs)).toEqual(source);
  });

  test("a second backup uploads only what is new, and pruning deletes from the bucket", async () => {
    const fake = (s3 = startFakeS3());
    await populate(h);
    const flags = ["--db", dbOf(h), "--blobs", blobsOf(h), ...bucketFlags(fake), "--keep", "1", "--json"];
    const first = JSON.parse((await call(runBackup, flags, credentials(fake))).out);
    await append(h, "doc.docx", " three");
    const second = JSON.parse((await call(runBackup, flags, credentials(fake))).out);
    expect(second.blobs_reused).toBe(first.blobs_named);
    expect(second.blobs_uploaded).toBe(second.blobs_named - first.blobs_named);
    expect(second.pruned).toEqual([first.snapshot]);
    expect([...fake.objects.keys()].filter((k) => k.endsWith(".sqlite"))).toEqual([`snapshots/${second.snapshot}.sqlite`]);
    expect(fake.methods.has("DELETE")).toBe(true);
  });

  test("holds the assistant database beside the snapshot, prunes it with the snapshot, and restores it", async () => {
    const fake = (s3 = startFakeS3());
    await populate(h);
    const assistant = openAssistant();
    storeTask(assistant, 1, "ada", "conv-ada");
    const flags = ["--db", dbOf(h), "--blobs", blobsOf(h), ...bucketFlags(fake), "--prefix", "team-a", "--keep", "1", "--json"];
    const first = JSON.parse((await call(runBackup, flags, credentials(fake))).out);
    expect(first.assistant.key).toBe(`team-a/snapshots/${first.snapshot}.assistant-${first.assistant.sha256}.sqlite`);
    storeTask(assistant, 2, "bo", "conv-bo");
    const second = JSON.parse((await call(runBackup, flags, credentials(fake))).out);
    expect([...fake.objects.keys()].filter((k) => k.endsWith(".sqlite")).sort()).toEqual([second.assistant.key, `team-a/snapshots/${second.snapshot}.sqlite`].sort());

    const { db, blobs } = place("copy");
    const restored = await call(runRestore, ["--db", db, "--blobs", blobs, ...bucketFlags(fake), "--prefix", "team-a", "--json"], credentials(fake));
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect(JSON.parse(restored.out).assistant).toEqual({ path: join(dir, "copy", "rooms.assistant.sqlite"), bytes: second.assistant.bytes });
    expect(assistantView(join(dir, "copy", "rooms.assistant.sqlite"))).toEqual(assistantView(assistantDbOf(h)));
  });

  test("reads the AWS names of the credentials and the region when the S3 names are not set", async () => {
    const fake = (s3 = startFakeS3());
    await populate(h);
    const env: BackupEnv = { AWS_ACCESS_KEY_ID: fake.accessKeyId, AWS_SECRET_ACCESS_KEY: fake.secretAccessKey, AWS_REGION: "test-region-2" };
    const made = await call(runBackup, ["--db", dbOf(h), "--blobs", blobsOf(h), ...bucketFlags(fake), "--keep", "1"], env);
    expect(made.code).toBe(EXIT_FRESH);
    expect([...fake.scopes].every((scope) => scope.split("/")[2] === "test-region-2")).toBe(true);
    // The S3 names win.
    await call(runRestore, ["--list", ...bucketFlags(fake)], { ...env, S3_REGION: "test-region-3" });
    expect([...fake.scopes].some((scope) => scope.split("/")[2] === "test-region-3")).toBe(true);
  });

  test("with no region it signs for auto, the region of R2", async () => {
    const fake = (s3 = startFakeS3());
    await call(runRestore, ["--list", ...bucketFlags(fake)], credentials(fake));
    expect([...fake.scopes].map((scope) => scope.split("/")[2])).toEqual(["auto"]);
  });

  test("never prints a secret: not on success, not on a refusal by the bucket, not in JSON", async () => {
    const fake = (s3 = startFakeS3());
    await populate(h);
    const token = `test-token-${crypto.randomUUID()}`;
    const env: BackupEnv = { ...credentials(fake), S3_SESSION_TOKEN: token };
    const wrong: BackupEnv = { S3_ACCESS_KEY_ID: `test-id-${crypto.randomUUID()}`, S3_SECRET_ACCESS_KEY: `test-secret-${crypto.randomUUID()}`, S3_SESSION_TOKEN: token };
    const base = ["--db", dbOf(h), "--blobs", blobsOf(h), ...bucketFlags(fake), "--keep", "1"];
    const ran = [await call(runBackup, base, env), await call(runBackup, [...base, "--json"], env), await call(runBackup, base, wrong), await call(runBackup, [...base, "--json"], wrong)];
    expect(ran.map((r) => r.code)).toEqual([EXIT_FRESH, EXIT_FRESH, EXIT_ERROR, EXIT_ERROR]);
    expect(ran[2]?.err).toMatch(/^error: \S+: /);
    expect(JSON.parse(ran[3]?.out ?? "").error.message).toBeTruthy();
    const everything = ran.map((r) => `${r.out}\n${r.err}`).join("\n");
    for (const secret of [fake.secretAccessKey, token, wrong.S3_SECRET_ACCESS_KEY as string]) expect(everything).not.toContain(secret);
  });
});

// The command line --------------------------------------------------------------------------------------------

describe("usage", () => {
  const db = (): string => dbOf(h);
  const blobs = (): string => blobsOf(h);

  test("the exit codes are those of the other commands: 0 for done, 2 for stopped", () => {
    expect([EXIT_FRESH, EXIT_ERROR]).toEqual([0, 2]);
  });

  async function refused(command: typeof runBackup | typeof runRestore, args: string[], env: BackupEnv = {}): Promise<string> {
    try {
      await call(command, args, env);
    } catch (e) {
      if (e instanceof UsageError) return e.message;
      throw e;
    }
    throw new Error(`expected a usage error for ${args.join(" ")}`);
  }

  test("backup names what it needs", async () => {
    expect(await refused(runBackup, [])).toBe("backup needs --db, --blobs and --keep");
    expect(await refused(runBackup, ["--db", db(), "--blobs", blobs(), "--dir", store])).toBe("backup needs --db, --blobs and --keep");
    expect(await refused(runBackup, ["--db", db(), "--blobs", blobs(), "--keep", "2"])).toContain("backup needs --dir <directory>, or --s3-bucket");
  });

  test("--keep is a whole number of at least 1", async () => {
    for (const keep of ["0", "-1", "1.5", "two", "", "1e3"]) {
      expect(await refused(runBackup, ["--db", db(), "--blobs", blobs(), "--dir", store, `--keep=${keep}`])).toBe("--keep must be a whole number of at least 1");
    }
  });

  test("a store is a directory or a bucket, with what a bucket needs", async () => {
    const base = ["--db", db(), "--blobs", blobs(), "--keep", "1"];
    expect(await refused(runBackup, [...base, "--dir", store, "--s3-bucket", BUCKET])).toBe("backup takes --dir or --s3-bucket, not both");
    expect(await refused(runBackup, [...base, "--dir", store, "--s3-endpoint", "https://s3.example.test"])).toBe("--s3-endpoint and --s3-region go with --s3-bucket");
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET])).toBe("--s3-bucket needs --s3-endpoint <url>");
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET, "--s3-endpoint", "not a url"])).toContain("is not a URL");
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET, "--s3-endpoint", "ftp://s3.example.test"])).toBe("--s3-endpoint must be an http or https URL");
    const embedded = `https://user:${crypto.randomUUID()}@s3.example.test`;
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET, "--s3-endpoint", embedded])).toBe("--s3-endpoint must not carry credentials: they come from the environment");
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET, "--s3-endpoint", "https://s3.example.test"])).toContain("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    expect(await refused(runBackup, [...base, "--s3-bucket", BUCKET, "--s3-endpoint", "https://s3.example.test"], { S3_ACCESS_KEY_ID: "only-the-id" })).toContain("S3_SECRET_ACCESS_KEY");
  });

  test("--blobs and --scratch must be directories, and a named --assistant-db must be there", async () => {
    await writeFile(join(dir, "a-file"), "x");
    expect(await refused(runBackup, ["--db", db(), "--blobs", join(dir, "a-file"), "--dir", store, "--keep", "1"])).toContain("is not a directory");
    expect(await refused(runBackup, ["--db", db(), "--blobs", blobs(), "--dir", store, "--keep", "1", "--scratch", join(dir, "nowhere")])).toContain("is not a directory");
    expect(await refused(runBackup, ["--db", db(), "--blobs", blobs(), "--dir", store, "--keep", "1", "--assistant-db", join(dir, "nowhere.sqlite")])).toBe(
      `--assistant-db ${join(dir, "nowhere.sqlite")} is not there`,
    );
  });

  test("restore names what it needs, and --list takes no target", async () => {
    expect(await refused(runRestore, ["--dir", store])).toBe("restore needs --db and --blobs, or --list");
    expect(await refused(runRestore, ["--db", join(dir, "x.sqlite"), "--blobs", join(dir, "x")])).toContain("restore needs --dir <directory>, or --s3-bucket");
    const listOnly = "restore --list takes no --db, --blobs, --assistant-db or --snapshot";
    expect(await refused(runRestore, ["--list", "--db", join(dir, "x.sqlite"), "--dir", store])).toBe(listOnly);
    expect(await refused(runRestore, ["--list", "--snapshot", "x", "--dir", store])).toBe(listOnly);
    expect(await refused(runRestore, ["--list", "--assistant-db", join(dir, "x.sqlite"), "--dir", store])).toBe(listOnly);
  });

  test("a restore never creates its source directory", async () => {
    expect(await refused(runRestore, ["--list", "--dir", store])).toContain("is not a directory");
    expect(await refused(runRestore, ["--db", join(dir, "x.sqlite"), "--blobs", join(dir, "x"), "--dir", store])).toContain("is not a directory");
    expect(existsSync(store)).toBe(false);
  });
});

// A hosted deployment -----------------------------------------------------------------------------------------

/** The actor token of an account under the text of a control-plane key, as the stand-in control plane derives it. */
const actorToken = (key: string, customerId: string, accountId: string): string =>
  createHmac("sha256", key.trim()).update(`stand-in-actor\0${customerId}\0${accountId}`).digest("base64url");

/**
 * The data directory of a running control plane, in the layout `backup-registry` reads (the hosted deployment section
 * of src/backup.ts): registry.sqlite with its schema version, its customers and accounts that name them,
 * control-plane.key, and customers/<id>/actors.json, which maps the actor token of each account, derived under the
 * key, to its actor. The control plane itself is closed source and outside this package, so this stand-in writes
 * those files. Like `serve`, it holds the registry open in WAL mode, so its newest rows are still in the log.
 */
class StandInControlPlane {
  readonly root: string;
  readonly key = `${randomBytes(32).toString("hex")}\n`;
  private readonly db: Database;
  private customers = 0;

  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "customers"), { recursive: true });
    writeFileSync(join(root, "control-plane.key"), this.key, { mode: 0o600 });
    this.db = new Database(join(root, "registry.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE customers (id TEXT PRIMARY KEY, routing_name TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE accounts (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers (id), email TEXT NOT NULL, role TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
  }

  /** An active customer, created after every other, with the actors file of no actor that `add-customer` writes. */
  addCustomer(id: string): void {
    const createdAt = new Date(Date.UTC(2026, 10, 1) + 1000 * this.customers++).toISOString();
    this.db.query("INSERT INTO customers (id, routing_name, state, created_at) VALUES (?, ?, 'active', ?)").run(id, id, createdAt);
    mkdirSync(join(this.root, "customers", id));
    this.writeActors(id);
  }

  /** An account of `customerId`, with its actor in the customer's actors file. Returns the account id. */
  addAccount(customerId: string, email: string, role = "member"): string {
    const id = `acct-${crypto.randomUUID()}`;
    this.db.query("INSERT INTO accounts (id, customer_id, email, role) VALUES (?, ?, ?, ?)").run(id, customerId, email, role);
    this.writeActors(customerId);
    return id;
  }

  private writeActors(customerId: string): void {
    const accounts = this.db.query<{ id: string; email: string }, [string]>("SELECT id, email FROM accounts WHERE customer_id = ? ORDER BY id").all(customerId);
    const actors = Object.fromEntries(accounts.map((account) => [actorToken(this.key, customerId, account.id), { kind: "user", id: account.id, name: account.email }]));
    writeFileSync(join(this.root, "customers", customerId, "actors.json"), `${JSON.stringify(actors, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * What the deletion job of the control plane does to a customer whose trial ended: it adds its table on its first
   * run, closes the customer, records the deletion with the expiry of its backups 30 days on, and removes the
   * customer's directory. The backup set of the customer stays in the store until that expiry.
   */
  deleteCustomer(id: string, deletedAt: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customer_deletions (customer_id TEXT PRIMARY KEY REFERENCES customers (id), reason TEXT NOT NULL,
        due_at TEXT, requested_by TEXT, deleted_at TEXT NOT NULL, storage_removed_at TEXT, backups_expire_at TEXT NOT NULL, backups_removed_at TEXT) WITHOUT ROWID;
    `);
    const expires = new Date(Date.parse(deletedAt) + 30 * 86_400_000).toISOString();
    this.db.query("UPDATE customers SET state = 'closed' WHERE id = ?").run(id);
    this.db
      .query("INSERT INTO customer_deletions (customer_id, reason, due_at, requested_by, deleted_at, storage_removed_at, backups_expire_at, backups_removed_at) VALUES (?, 'trial-ended', ?, NULL, ?, ?, ?, NULL)")
      .run(id, deletedAt, deletedAt, deletedAt, expires);
    rmSync(join(this.root, "customers", id), { recursive: true, force: true });
  }

  close(): void {
    this.db.close();
  }
}

/** The customers and the accounts in the registry of a data directory. */
function registryRows(root: string) {
  const file = join(root, "registry.sqlite");
  return {
    customers: query(file, "SELECT id, routing_name, state, created_at FROM customers ORDER BY id"),
    accounts: query(file, "SELECT id, customer_id, email, role FROM accounts ORDER BY id"),
  };
}

describe("a hosted deployment: backup-registry and restore-host", () => {
  const SECRETS_KEY = "5e".repeat(32);
  const keyed: BackupEnv = { [SECRETS_KEY_VARIABLE]: SECRETS_KEY };
  let plane: StandInControlPlane | null;

  beforeEach(() => {
    plane = null;
  });
  afterEach(() => {
    plane?.close();
  });

  /**
   * The data directory of a running control plane: customer acme with an account (so a derived actor token) and the
   * rooms of the harness backed up under dep/acme, and customer globex, which has no room database yet and so no
   * backup set.
   */
  async function makeHost() {
    const root = join(dir, "host");
    const host = (plane = new StandInControlPlane(root));
    host.addCustomer("acme");
    host.addCustomer("globex");
    const ada = host.addAccount("acme", "ada@acme.test", "admin");
    host.addAccount("globex", "bo@globex.test");
    await populate(h);
    expect((await call(runBackup, ["--db", dbOf(h), "--blobs", blobsOf(h), "--dir", store, "--keep", "3", "--prefix", "dep/acme"])).code).toBe(EXIT_FRESH);
    return { root, ada, token: actorToken(host.key, "acme", ada) };
  }

  const backupRegistry = (root: string, ...extra: string[]): Promise<Ran> =>
    call(runBackupRegistry, ["--data", root, "--dir", store, "--keep", "3", "--prefix", "dep", ...extra], keyed);
  const restoreHost = (target: string, env: BackupEnv = keyed, ...extra: string[]): Promise<Ran> =>
    call(runRestoreHost, ["--data", target, "--dir", store, "--prefix", "dep", ...extra], env);
  const registryObjects = async (): Promise<string[]> => (await readdir(join(store, "dep", "_control-plane", "snapshots"))).sort();

  test("backs up a live registry, its key and the actors files, and restore-host rebuilds the whole host: accounts, tokens and rooms", async () => {
    const { root, ada, token } = await makeHost();
    // The new accounts are still in the write-ahead log: a copy of registry.sqlite alone would not hold them.
    expect(statSync(join(root, "registry.sqlite-wal")).size).toBeGreaterThan(0);
    const source = await describeWorkspace(dbOf(h), blobsOf(h));

    const made = await backupRegistry(root, "--json");
    expect(made).toMatchObject({ code: EXIT_FRESH, err: "" });
    const report = JSON.parse(made.out);
    expect(report).toMatchObject({ customers: 2, pruned: [], secrets: { control_plane_key: true, actors_files: 2, key_id: secretsKeyId(Buffer.from(SECRETS_KEY, "hex")) } });
    expect(report.retained).toEqual([report.snapshot]);
    expect(await registryObjects()).toEqual([`${report.snapshot}.secrets.enc`, `${report.snapshot}.sqlite`]);
    // The bucket holds the secrets sealed: neither the key nor a token nor an address is in the object.
    const sealed = readFileSync(join(store, "dep", "_control-plane", "snapshots", `${report.snapshot}.secrets.enc`)).toString("latin1");
    for (const secret of [readFileSync(join(root, "control-plane.key"), "utf8").trim(), token, "ada@acme.test"]) expect(sealed).not.toContain(secret);

    const target = join(dir, "restored");
    const restored = await restoreHost(target, keyed, "--json");
    expect(restored).toMatchObject({ code: EXIT_FRESH, err: "" });
    const host = JSON.parse(restored.out);
    expect(host).toMatchObject({ data: target, registry_snapshot: report.snapshot, control_plane_key: true, actors_files: 2 });
    expect(host.seconds).toBeGreaterThanOrEqual(0);
    expect(host.customers).toMatchObject([
      { id: "acme", state: "active", documents: 2, assistant: false },
      { id: "globex", state: "active", snapshot: null, documents: 0 },
    ]);
    expect(host.customers[0].snapshot).toMatch(/^\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{12}$/);

    // The key and the actors files are the very ones the host had; the key file keeps its mode.
    expect(readFileSync(join(target, "control-plane.key"))).toEqual(readFileSync(join(root, "control-plane.key")));
    expect(statSync(join(target, "control-plane.key")).mode & 0o777).toBe(0o600);
    for (const id of ["acme", "globex"]) {
      expect(readFileSync(join(target, "customers", id, "actors.json"), "utf8")).toBe(readFileSync(join(root, "customers", id, "actors.json"), "utf8"));
    }
    // The rooms of acme are back; globex has the empty directory add-customer makes.
    expect(await describeWorkspace(join(target, "customers", "acme", "rooms.sqlite"), join(target, "customers", "acme", "blobs"))).toEqual(source);
    expect(await readdir(join(target, "customers", "globex", "blobs"))).toEqual([]);

    // The restored registry holds the same customers and accounts, the restored key derives the same actor token for
    // the account, and the restored actors file still maps that token to it, so the account opens its rooms as before.
    const restoredRows = registryRows(target);
    expect(restoredRows).toEqual(registryRows(root));
    expect(restoredRows.customers.map((customer) => [customer.id, customer.routing_name])).toEqual([
      ["acme", "acme"],
      ["globex", "globex"],
    ]);
    expect(restoredRows.accounts.find((account) => account.email === "ada@acme.test")).toMatchObject({ id: ada, customer_id: "acme", role: "admin" });
    expect(actorToken(readFileSync(join(target, "control-plane.key"), "utf8"), "acme", ada)).toBe(token);
    expect(JSON.parse(readFileSync(join(target, "customers", "acme", "actors.json"), "utf8"))[token]).toEqual({ kind: "user", id: ada, name: "ada@acme.test" });

    // Text reports, through the command line.
    const again = join(dir, "restored-text");
    const ranText = await runHostCliCall(["restore-host", "--data", again, "--dir", store, "--prefix", "dep"], keyed);
    expect(ranText.code).toBe(EXIT_FRESH);
    expect(ranText.out).toMatch(new RegExp(`^restored registry snapshot ${report.snapshot} into ${again} in [0-9.]+ seconds\\n`));
    expect(ranText.out).toContain("customer globex (active): no backup set, an empty directory");
    const everything = [made.out, made.err, restored.out, restored.err, ranText.out, ranText.err].join("\n");
    for (const secret of [SECRETS_KEY, readFileSync(join(root, "control-plane.key"), "utf8").trim(), token]) expect(everything).not.toContain(secret);
  });

  // Five whole restores of the host and two refused ones: more than the default timeout leaves on a loaded machine.
  test("restore-host skips, and reports by id, a deleted workspace whose backups have not expired, unless the operator names it with a reason", async () => {
    const { root } = await makeHost();
    // initech has rooms, backed up under dep/initech, and while it is live it is restored as every customer is.
    plane?.addCustomer("initech");
    expect((await call(runBackup, ["--db", dbOf(h), "--blobs", blobsOf(h), "--dir", store, "--keep", "3", "--prefix", "dep/initech"])).code).toBe(EXIT_FRESH);
    const source = await describeWorkspace(dbOf(h), blobsOf(h));
    expect((await backupRegistry(root)).code).toBe(EXIT_FRESH);
    const live = await restoreHost(join(dir, "live"), keyed, "--json");
    expect(live).toMatchObject({ code: EXIT_FRESH, err: "" });
    const before = JSON.parse(live.out).customers;
    expect(before.map((customer: { id: string }) => customer.id)).toEqual(["acme", "globex", "initech"]);
    const liveOnly = before.filter((customer: { id: string }) => customer.id !== "initech");

    // The deletion job deletes initech. Its backups expire 30 days on, so its backup set is still in the store.
    const deletedAt = "2026-12-15T00:00:00.000Z";
    const expires = "2027-01-14T00:00:00.000Z";
    plane?.deleteCustomer("initech", deletedAt);
    expect((await readdir(join(store, "dep", "initech", "snapshots"))).length).toBeGreaterThan(0);
    expect((await backupRegistry(root)).code).toBe(EXIT_FRESH);

    // The live customers come back exactly as before; the deleted one does not, and the report names it.
    const target = join(dir, "restored");
    const ran = await restoreHost(target, keyed, "--json");
    expect(ran).toMatchObject({ code: EXIT_FRESH, err: "" });
    const host = JSON.parse(ran.out);
    expect(host.customers).toEqual(liveOnly);
    expect(host.skipped).toEqual([{ id: "initech", state: "closed", deleted_at: deletedAt, deletion_reason: "trial-ended", backups_expire_at: expires, backups_removed_at: null }]);
    expect(host.actors_files).toBe(2);
    expect((await readdir(join(target, "customers"))).sort()).toEqual(["acme", "globex"]);
    expect(await describeWorkspace(join(target, "customers", "acme", "rooms.sqlite"), join(target, "customers", "acme", "blobs"))).toEqual(source);
    // The restored registry still records the deletion, as the host does.
    expect(registryRows(target)).toEqual(registryRows(root));
    expect(query(join(target, "registry.sqlite"), "SELECT customer_id, deleted_at FROM customer_deletions")).toEqual([{ customer_id: "initech", deleted_at: deletedAt }]);
    const text = await runHostCliCall(["restore-host", "--data", join(dir, "restored-text"), "--dir", store, "--prefix", "dep"], keyed);
    expect(text.code).toBe(EXIT_FRESH);
    expect(text.out).toContain(`customer initech (closed): deleted ${deletedAt} (trial-ended), not restored; its backups expire ${expires}`);
    expect(text.out).not.toContain("customer initech (closed): snapshot");

    // Naming it needs a reason, and names only a deleted customer of the registry; a refusal leaves no target.
    const refusedTarget = join(dir, "refused");
    const noReason = await runHostCliCall(["restore-host", "--data", refusedTarget, "--dir", store, "--prefix", "dep", "--restore-deleted", "initech"], keyed);
    expect(noReason.code).toBe(EXIT_ERROR);
    expect(noReason.err).toContain("--restore-deleted needs --reason <text>");
    const blankReason = await runHostCliCall(["restore-host", "--data", refusedTarget, "--dir", store, "--prefix", "dep", "--restore-deleted", "initech", "--reason", "  "], keyed);
    expect(blankReason.err).toContain("--restore-deleted needs --reason <text>");
    expect((await runHostCliCall(["restore-host", "--data", refusedTarget, "--dir", store, "--prefix", "dep", "--reason", "why"], keyed)).err).toContain("--reason goes with --restore-deleted");
    for (const [name, message] of [
      ["acme", "the customer is not deleted"],
      ["nobody", "has no such customer"],
    ] as const) {
      const wrong = await restoreHost(refusedTarget, keyed, "--restore-deleted", name, "--reason", "a mistake");
      expect(wrong.code).toBe(EXIT_ERROR);
      expect(wrong.err).toMatch(/^error: BAD_ARGUMENT: /);
      expect(wrong.err).toContain(message);
    }
    expect(existsSync(refusedTarget)).toBe(false);

    // Named with a reason, it comes back from its unexpired backups, and the report records the reason beside it.
    const reason = "the owner asked for an export before the backups expire";
    const asked = await restoreHost(join(dir, "asked"), keyed, "--restore-deleted", "initech", "--reason", reason, "--json");
    expect(asked).toMatchObject({ code: EXIT_FRESH, err: "" });
    const back = JSON.parse(asked.out);
    expect(back.skipped).toEqual([]);
    expect(back.customers).toEqual([...liveOnly, { ...before[2], state: "closed", restored_deleted: { deleted_at: deletedAt, deletion_reason: "trial-ended", reason } }]);
    expect(await describeWorkspace(join(dir, "asked", "customers", "initech", "rooms.sqlite"), join(dir, "asked", "customers", "initech", "blobs"))).toEqual(source);
    const askedText = await runHostCliCall(["restore-host", "--data", join(dir, "asked-text"), "--dir", store, "--prefix", "dep", "--restore-deleted", "initech", "--reason", reason], keyed);
    expect(askedText.out).toContain(`customer initech (closed): snapshot ${before[2].snapshot}, `);
    expect(askedText.out).toContain(`; deleted ${deletedAt} (trial-ended), restored as the operator asked: ${reason}`);
  }, 300_000);

  test("keeps the newest --keep registry snapshots with their secrets", async () => {
    const { root } = await makeHost();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      plane?.addCustomer(`extra-${n}`);
      const ran = await call(runBackupRegistry, ["--data", root, "--dir", store, "--keep", "2", "--prefix", "dep", "--json"], keyed);
      expect(ran.code).toBe(EXIT_FRESH);
      ids.push(JSON.parse(ran.out).snapshot);
    }
    const last = await call(runBackupRegistry, ["--data", root, "--dir", store, "--keep", "2", "--prefix", "dep"], keyed);
    expect(last.out).toContain("kept 2 snapshots; pruned 1");
    const objects = await registryObjects();
    expect(objects.filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
    expect(objects.filter((name) => name.endsWith(".secrets.enc"))).toHaveLength(2);
    expect(objects.some((name) => name.startsWith(ids[0] as string) || name.startsWith(ids[1] as string))).toBe(false);
  });

  test("goes through an S3 bucket, and a bucket that refuses the upload stops the backup with exit 2 and no snapshot", async () => {
    const fake = (s3 = startFakeS3());
    const { root, token } = await makeHost();
    const env: BackupEnv = { ...credentials(fake), ...keyed };
    const made = await call(runBackupRegistry, ["--data", root, ...bucketFlags(fake), "--keep", "7", "--prefix", "wolf-cloud"], env);
    expect(made).toMatchObject({ code: EXIT_FRESH, err: "" });
    expect([...fake.objects.keys()].filter((key) => key.startsWith("wolf-cloud/_control-plane/snapshots/"))).toHaveLength(2);

    const wrong: BackupEnv = { S3_ACCESS_KEY_ID: `test-id-${crypto.randomUUID()}`, S3_SECRET_ACCESS_KEY: `test-secret-${crypto.randomUUID()}`, ...keyed };
    const before = fake.objects.size;
    const refused = await call(runBackupRegistry, ["--data", root, ...bucketFlags(fake), "--keep", "7", "--prefix", "wolf-cloud"], wrong);
    expect(refused.code).toBe(EXIT_ERROR);
    expect(refused.out).toBe("");
    expect(refused.err).toMatch(/^error: \S+: /);
    expect(fake.objects.size).toBe(before);

    // The rooms of acme went to the directory store; restored from the bucket alone, no customer has a rooms set.
    const restored = await call(runRestoreHost, ["--data", join(dir, "from-bucket"), ...bucketFlags(fake), "--prefix", "wolf-cloud", "--json"], env);
    expect(restored.code).toBe(EXIT_FRESH);
    expect(JSON.parse(restored.out).customers.map((c: { snapshot: string | null }) => c.snapshot)).toEqual([null, null]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "from-bucket", "customers", "acme", "actors.json"), "utf8")))).toContain(token);
    for (const secret of [fake.secretAccessKey, wrong.S3_SECRET_ACCESS_KEY as string, SECRETS_KEY]) expect(`${made.out}${made.err}${refused.err}${restored.out}`).not.toContain(secret);
  });

  test("restore-host refuses another secrets key, a data directory that holds anything, a store with no registry, and a damaged rooms set, and leaves the target as it was", async () => {
    const { root } = await makeHost();
    const target = join(dir, "restored");
    const none = await restoreHost(target);
    expect(none).toMatchObject({ code: EXIT_ERROR, out: "" });
    expect(none.err).toMatch(/^error: NO_SNAPSHOT: /);
    expect(existsSync(target)).toBe(false);

    expect((await backupRegistry(root)).code).toBe(EXIT_FRESH);
    const other = await restoreHost(target, { [SECRETS_KEY_VARIABLE]: "c4".repeat(32) });
    expect(other.code).toBe(EXIT_ERROR);
    expect(other.err).toMatch(/^error: SECRETS_UNREADABLE: .* sealed under the secrets key with id [0-9a-f]{16}; WOLF_BACKUP_SECRETS_KEY is the key with id [0-9a-f]{16}$/);
    expect(existsSync(target)).toBe(false);

    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "mine");
    const full = await restoreHost(target);
    expect(full.code).toBe(EXIT_ERROR);
    expect(full.err).toMatch(/^error: TARGET_NOT_EMPTY: /);
    expect(await readdir(target)).toEqual(["keep.txt"]);

    // A rooms set that fails its checks stops the whole restore, and the empty target is empty again.
    const empty = join(dir, "empty");
    await mkdir(empty);
    for (const name of await readdir(join(store, "dep", "acme", "snapshots"))) {
      if (name.endsWith(".sqlite")) await writeFile(join(store, "dep", "acme", "snapshots", name), "damaged");
    }
    const damaged = await restoreHost(empty);
    expect(damaged.code).toBe(EXIT_ERROR);
    expect(damaged.err).toMatch(/^error: SNAPSHOT_CORRUPT: /);
    expect(await readdir(empty)).toEqual([]);
  });

  test("names what it needs: the secrets key, --data, --keep and --prefix", async () => {
    const { root } = await makeHost();
    const noKey = await runHostCliCall(["backup-registry", "--data", root, "--dir", store, "--keep", "1", "--prefix", "dep"], {});
    expect(noKey.code).toBe(EXIT_ERROR);
    expect(noKey.err).toContain(`backup-registry needs ${SECRETS_KEY_VARIABLE} in the environment`);
    expect(noKey.err).toContain(HOST_USAGE);
    expect(existsSync(join(store, "dep", "_control-plane"))).toBe(false);
    const badKey = await runHostCliCall(["restore-host", "--data", join(dir, "x"), "--dir", store, "--prefix", "dep"], { [SECRETS_KEY_VARIABLE]: "not-hex" });
    expect(badKey.err).toContain(`${SECRETS_KEY_VARIABLE} must be 64 hex digits`);
    expect((await runHostCliCall(["backup-registry", "--data", root, "--dir", store, "--keep", "1"], keyed)).err).toContain("backup-registry needs --data, --keep and --prefix");
    expect((await runHostCliCall(["restore-host", "--dir", store, "--prefix", "dep"], keyed)).err).toContain("restore-host needs --data and --prefix");
    expect((await runHostCliCall(["restore-host", "--bogus"], keyed)).code).toBe(EXIT_ERROR);
    expect((await runHostCliCall(["backup-registry", "--help"], {})).out).toBe(HOST_USAGE);
  });
});

async function runHostCliCall(argv: string[], env: BackupEnv): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runHostCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
