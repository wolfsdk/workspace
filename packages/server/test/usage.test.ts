// The usage report of a workspace: a fixture written by a real room server (two workspace ids, users and an agent,
// commits and an open proposal), counted while the server runs and after it stopped. Every expected number is
// worked out here from the bytes the fixture wrote, never read back from the report, and every run must leave the
// database, its log and the blob directory exactly as they were: the same files, bytes and modification times.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RoomBatch } from "@wolfsdk/protocol/workspace";
import { formatUsage, runUsage, type UsageReport, usageOf } from "../src/usage.ts";
import { alice, bob, bytesOf, committed, type Harness, makeHarness, must, proposed, robot } from "./fixtures/harness.ts";

// Writes are flushed to disk and processes are started: on a busy host one test can take many seconds.
setDefaultTimeout(120_000);

const USAGE = join(import.meta.dir, "..", "src", "usage.ts");
const append = (text: string): RoomBatch => ({ ops: [{ op: "append", text }] });

// Every version of every document the fixture writes. `ws` holds doc.docx (two commits, then the agent's open
// proposal) and notes.docx; `other` holds big.docx (one commit) and a copy of notes.docx under another name.
const HELLO = "hello world";
const HELLO_1 = `${HELLO} one`;
const HELLO_2 = `${HELLO_1} two`;
const PREVIEW = `${HELLO_2} three`;
const NOTES = "notes of the team";
const BIG = "x".repeat(5000);
const BIG_1 = `${BIG}!`;
const size = (text: string): number => bytesOf(text).length;
const total = (...texts: string[]): number => texts.reduce((sum, text) => sum + size(text), 0);

let h: Harness;
let running: boolean;
beforeEach(async () => {
  // A licence that serves more than one workspace id.
  h = await makeHarness({ env: { FAKE_TIER: "commercial", FAKE_KEYED: "1", FAKE_MAX_WORKSPACES: "null" } });
  running = true;
  const s = h.server;
  must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
  must(await s.addDocument("room", alice, { name: "doc.docx", format: "docx", bytes: bytesOf(HELLO) }));
  must(await s.addDocument("room", alice, { name: "notes.docx", format: "docx", bytes: bytesOf(NOTES) }));
  committed(await s.edit("room", alice, { doc_name: "doc.docx", base_revision: 0, mode: "commit", batch: append(" one") }));
  committed(await s.edit("room", bob, { doc_name: "doc.docx", base_revision: 1, mode: "commit", batch: append(" two") }));
  proposed(await s.edit("room", robot, { doc_name: "doc.docx", base_revision: 2, mode: "propose", batch: append(" three") }));
  must(await s.createRoom(bob, { room_id: "room-2", workspace_id: "other" }));
  must(await s.addDocument("room-2", bob, { name: "big.docx", format: "docx", bytes: bytesOf(BIG) }));
  must(await s.addDocument("room-2", bob, { name: "copy.docx", format: "docx", bytes: bytesOf(NOTES) }));
  committed(await s.edit("room-2", bob, { doc_name: "big.docx", base_revision: 0, mode: "commit", batch: append("!") }));
});
afterEach(async () => {
  if (running) await h.dispose();
  else await h.dispose().catch(() => {});
});

const dbPath = (): string => join(h.dir, "rooms.sqlite");
const blobDir = (): string => join(h.dir, "blobs");

type FileState = { bytes: number; sha256?: string; mtimeMs?: number };

/**
 * Every file under the server's directory (the database, its log, its lock, every blob), by relative path. The
 * shared-memory index of a live database (`-shm`) is listed by size only: it holds no data of the workspace, SQLite
 * rebuilds it from the log, and every reader of a database in WAL mode records its read position in it, the
 * server's own readers included. That it is not created where there was none is checked with the rest.
 */
async function filesOf(dir: string): Promise<Record<string, FileState>> {
  const found: Record<string, FileState> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const info = await stat(file);
    found[relative(dir, file)] = entry.name.endsWith("-shm")
      ? { bytes: info.size }
      : { bytes: info.size, sha256: createHash("sha256").update(await readFile(file)).digest("hex"), mtimeMs: info.mtimeMs };
  }
  return found;
}

/** The report the fixture must produce, worked out from the texts it wrote and the size of the database files. */
function expected(files: Record<string, FileState>): UsageReport {
  const database_bytes = (files["rooms.sqlite"]?.bytes ?? 0) + (files["rooms.sqlite-wal"]?.bytes ?? 0);
  // Every distinct version once: notes.docx and copy.docx are the same blob.
  const blob_bytes = total(HELLO, HELLO_1, HELLO_2, PREVIEW, NOTES, BIG, BIG_1);
  return {
    seats: { users: 2, agents: 1, total: 3 },
    rooms: 2,
    documents: 4,
    revisions: 3,
    largest_file_bytes: size(BIG_1),
    database_bytes,
    blob_bytes,
    blob_files: 7,
    named_blobs: 7,
    missing_blobs: 0,
    stored_bytes: database_bytes + blob_bytes,
    workspaces: [
      { workspace_id: "other", rooms: 1, documents: 2, revisions: 1, blobs: 3, largest_file_bytes: size(BIG_1), stored_bytes: total(BIG, BIG_1, NOTES) },
      { workspace_id: "ws", rooms: 1, documents: 2, revisions: 2, blobs: 5, largest_file_bytes: size(PREVIEW), stored_bytes: total(HELLO, HELLO_1, HELLO_2, PREVIEW, NOTES) },
    ],
  };
}

describe("the usage report", () => {
  test("counts seats, documents, revisions, the largest file and stored bytes of a running workspace, writing nothing", async () => {
    // The fixture is what the server says it is: the roster and the files the report is checked against.
    expect(h.server.listSeats().map((seat) => `${seat.kind}:${seat.id}`).sort()).toEqual(["agent:robot", "user:alice", "user:bob"]);
    const before = await filesOf(h.dir);
    expect(Object.keys(before)).toContain("rooms.sqlite-wal");
    expect(Object.keys(before).filter((file) => file.startsWith("blobs/"))).toHaveLength(7);

    const report = await usageOf({ dbPath: dbPath(), blobDir: blobDir() });

    expect(report).toEqual(expected(before));
    expect(await filesOf(h.dir)).toEqual(before);
  });

  test("reads a stopped workspace without leaving a log or an index beside its database", async () => {
    await h.server.close();
    running = false;
    // macOS SQLite can retain empty WAL and SHM files after the last close. Make the stopped,
    // sidecar-free WAL database explicitly, without removing any file from the original.
    const db = new Database(dbPath());
    try {
      expect(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0, log: 0 });
    } finally {
      db.close();
    }
    const stopped = join(h.dir, "stopped");
    await mkdir(stopped);
    const copy = join(stopped, "rooms.sqlite");
    await copyFile(dbPath(), copy);
    const before = await filesOf(stopped);
    expect(Object.keys(before)).toEqual(["rooms.sqlite"]);
    const blobsBefore = await filesOf(blobDir());

    const report = await usageOf({ dbPath: copy, blobDir: blobDir() });

    expect(report).toEqual(expected(before));
    expect(await filesOf(stopped)).toEqual(before);
    expect(await filesOf(blobDir())).toEqual(blobsBefore);
  });

  test("is a command that prints the report as JSON or as lines, and writes nothing", async () => {
    const before = await filesOf(h.dir);
    const child = Bun.spawn([process.execPath, USAGE, "--db", dbPath(), "--blobs", blobDir(), "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const report = JSON.parse(stdout) as UsageReport;
    expect(report).toEqual(expected(before));
    expect(await filesOf(h.dir)).toEqual(before);

    const out: string[] = [];
    expect(await runUsage(["--db", dbPath(), "--blobs", blobDir()], { out: (text) => out.push(text), err: () => {} })).toBe(0);
    expect(out).toEqual([formatUsage(report)]);
    const lines = out[0]!.split("\n");
    expect(lines.slice(0, 4)).toEqual(["seats      3 (2 users, 1 agent)", "documents  4 in 2 rooms", "revisions  3", "largest    5001 bytes"]);
    expect(lines.slice(5)).toEqual([
      `workspace other: 1 room, 2 documents, 1 revision, largest file 5001 bytes, stored ${total(BIG, BIG_1, NOTES)} bytes in 3 blobs`,
      `workspace ws: 1 room, 2 documents, 2 revisions, largest file ${size(PREVIEW)} bytes, stored ${total(HELLO, HELLO_1, HELLO_2, PREVIEW, NOTES)} bytes in 5 blobs`,
    ]);
    expect(await filesOf(h.dir)).toEqual(before);
  });

  test("refuses with exit code 2 when there is no database or the arguments are wrong, creating nothing", async () => {
    const before = await filesOf(h.dir);
    const err: string[] = [];
    const io = { out: () => {}, err: (text: string) => err.push(text) };
    expect(await runUsage(["--db", join(h.dir, "absent.sqlite"), "--blobs", blobDir()], io)).toBe(2);
    expect(err[0]).toStartWith("usage: there is no database at ");
    expect(await runUsage(["--db", dbPath()], io)).toBe(2);
    expect(err).toContain("usage: usage needs --db and --blobs");
    expect(await filesOf(h.dir)).toEqual(before);
  });
});
