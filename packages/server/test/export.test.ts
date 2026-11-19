// The export of a workspace: every document of every room, at its head, in one ZIP archive. The archive is read here
// by a reader of its own that checks the structure strictly (each local header against its directory entry, each CRC,
// no byte outside an entry, the directory exactly at the end), so a malformed archive fails the test and not only a
// tool that happens to be forgiving.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import {
  type DocumentRead,
  EXPORT_FORMAT,
  EXPORT_MANIFEST,
  ExportAborted,
  exportWorkspace,
  type ExportManifest,
  type PlanCap,
  PoolEngine,
  type Result,
  RoomServer,
  type RoomService,
  type WorkspaceExport,
} from "../src/index.ts";
import { safeSegment, ZipWriter } from "../src/export.ts";
import { alice, bob, bytesOf, makePool, must, refusalOf, sha256, steppingClock, textOf } from "./fixtures/harness.ts";

setDefaultTimeout(120_000);

const decoder = new TextDecoder();
const NOW = new Date("2026-11-14T09:30:15.000Z");

let dir: string | undefined;
let server: RoomServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Start a server on the files of `dir` (created on the first call). Calling it again closes the running server and
 * starts another on the same files: a restart. */
async function start(options: { readOnly?: { reason: string; upgrade: string }; planCap?: PlanCap } = {}): Promise<RoomServer> {
  await server?.close();
  dir ??= await mkdtemp(join(tmpdir(), "wolfsdk-export-"));
  let counter = 0;
  server = new RoomServer({
    dbPath: join(dir, "rooms.sqlite"),
    blobDir: join(dir, "blobs"),
    engine: new PoolEngine(makePool()),
    now: steppingClock(),
    newId: () => `id-${++counter}`,
    ...options,
  });
  return server;
}

/** The archive of an export that was planned: every chunk, in order, joined. */
async function collect(planned: WorkspaceExport): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of planned.chunks) chunks.push(chunk);
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

async function exported(service: RoomService, actor: RoomActor = alice): Promise<Uint8Array> {
  return collect(must(await exportWorkspace(service, actor, { now: () => NOW })));
}

// A reader of ZIP, as strict as the format ----------------------------------------------------------------------

type ZipEntry = { path: string; data: Uint8Array; flags: number; method: number; time: number; date: number; wide: boolean };
type ZipRead = { entries: ZipEntry[]; wide: boolean };

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END_64 = 0x06064b50;
const LOCATOR_64 = 0x07064b50;
const MAX_32 = 0xffffffff;

function readZip(zip: Uint8Array): ZipRead {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.length);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  const u64 = (at: number): number => Number(view.getBigUint64(at, true));

  // The writer puts no comment after the end record: it is the last 22 bytes.
  const end = zip.length - 22;
  expect(u32(end)).toBe(END);
  expect(u16(end + 20)).toBe(0);
  let count = u16(end + 10);
  let size = u32(end + 12);
  let start = u32(end + 16);
  let wide = false;
  let after = end;
  if (count === 0xffff || size === MAX_32 || start === MAX_32) {
    wide = true;
    expect(u32(end - 20)).toBe(LOCATOR_64);
    const record = u64(end - 20 + 8);
    expect(record + 56).toBe(end - 20);
    expect(u32(record)).toBe(END_64);
    expect(u64(record + 4)).toBe(44);
    count = u64(record + 32);
    size = u64(record + 40);
    start = u64(record + 48);
    after = record;
  }
  expect(start + size).toBe(after);

  const entries: ZipEntry[] = [];
  let at = start;
  let next = 0;
  for (let i = 0; i < count; i += 1) {
    expect(u32(at)).toBe(CENTRAL);
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const time = u16(at + 12);
    const date = u16(at + 14);
    const crc = u32(at + 16);
    let compressed = u32(at + 20);
    let size64 = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let offset = u32(at + 42);
    const path = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    let entryWide = false;
    for (let extra = at + 46 + nameLength; extra < at + 46 + nameLength + extraLength; extra += 4 + u16(extra + 2)) {
      expect(u16(extra)).toBe(1);
      entryWide = true;
      let field = extra + 4;
      if (size64 === MAX_32) {
        size64 = u64(field);
        field += 8;
      }
      if (compressed === MAX_32) {
        compressed = u64(field);
        field += 8;
      }
      if (offset === MAX_32) {
        offset = u64(field);
        field += 8;
      }
      expect(field).toBe(extra + 4 + u16(extra + 2));
    }
    expect(compressed).toBe(size64);

    // The local header agrees with the directory, and the entry starts where the one before it ended.
    expect(offset).toBe(next);
    expect(u32(offset)).toBe(LOCAL);
    expect([u16(offset + 6), u16(offset + 8), u16(offset + 10), u16(offset + 12), u32(offset + 14)]).toEqual([flags, method, time, date, crc]);
    expect(u16(offset + 26)).toBe(nameLength);
    expect(decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLength))).toBe(path);
    const localExtra = u16(offset + 28);
    let localSize = u32(offset + 22);
    expect(u32(offset + 18)).toBe(u32(offset + 22));
    if (localSize === MAX_32) {
      expect(localExtra).toBe(20);
      expect(u16(offset + 30 + nameLength)).toBe(1);
      expect(u16(offset + 30 + nameLength + 2)).toBe(16);
      localSize = u64(offset + 30 + nameLength + 4);
      expect(u64(offset + 30 + nameLength + 12)).toBe(localSize);
    } else {
      expect(localExtra).toBe(0);
    }
    expect(localSize).toBe(size64);
    const dataAt = offset + 30 + nameLength + localExtra;
    const data = zip.subarray(dataAt, dataAt + size64);
    expect(crc32(data)).toBe(crc);
    next = dataAt + size64;

    entries.push({ path, data, flags, method, time, date, wide: entryWide });
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(start + size);
  expect(next).toBe(start);
  return { entries, wide };
}

/** The MS-DOS time and date of an ISO timestamp, worked out here from its text. */
function dosOf(iso: string): { time: number; date: number } {
  const [, y, mo, d, h, mi, s] = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(iso)!.map(Number) as number[];
  return { time: (h! << 11) | (mi! << 5) | (s! >> 1), date: ((y! - 1980) << 9) | (mo! << 5) | d! };
}

const manifestOf = (read: ZipRead): ExportManifest => JSON.parse(decoder.decode(read.entries.at(-1)!.data)) as ExportManifest;

/** A workspace of two rooms: `alpha` with two documents, one of them committed twice, and `beta` with one. */
async function seeded(): Promise<RoomServer> {
  const s = await start();
  must(await s.createRoom(alice, { room_id: "alpha", workspace_id: "ws" }));
  must(await s.addDocument("alpha", alice, { name: "plan.docx", format: "docx", bytes: bytesOf("the plan") }));
  must(await s.addDocument("alpha", alice, { name: "budget.xlsx", format: "xlsx", bytes: bytesOf("the budget") }));
  for (let revision = 0; revision < 2; revision += 1) {
    must(await s.edit("alpha", alice, { doc_name: "plan.docx", base_revision: revision, mode: "commit", batch: { ops: [{ op: "append", text: "!" }] } }));
  }
  must(await s.createRoom(alice, { room_id: "beta", workspace_id: "ws" }));
  must(await s.addDocument("beta", alice, { name: "deck.pptx", format: "pptx", bytes: bytesOf("the deck") }));
  return s;
}

/** The service with its reads counted, and the reads of the documents named in `fail` refused. */
function spied(service: RoomService, fail: readonly string[] = []): { service: RoomService; reads: string[] } {
  const reads: string[] = [];
  const wrapped = new Proxy(service, {
    get(target, key) {
      if (key === "readHead") {
        return async (room: string, actor: RoomActor, name: string): Promise<Result<DocumentRead>> => {
          reads.push(`${room}/${name}`);
          if (fail.includes(name)) return { ok: false, error: { code: "ENGINE_FAILED", message: "the engine is away" } };
          return target.readHead(room, actor, name);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { service: wrapped, reads };
}

describe("the archive of a workspace", () => {
  test("holds every document of every room as <room>/<name>, at its head, byte for byte, and the manifest last", async () => {
    const s = await seeded();
    const read = readZip(await exported(s));
    expect(read.entries.map((entry) => entry.path)).toEqual(["alpha/plan.docx", "alpha/budget.xlsx", "beta/deck.pptx", EXPORT_MANIFEST]);
    for (const [path, room, name] of [
      ["alpha/plan.docx", "alpha", "plan.docx"],
      ["alpha/budget.xlsx", "alpha", "budget.xlsx"],
      ["beta/deck.pptx", "beta", "deck.pptx"],
    ] as const) {
      const head = must(await s.readHead(room, alice, name));
      expect(read.entries.find((entry) => entry.path === path)!.data).toEqual(head.bytes);
    }
    // The document that was committed twice is at its third revision, not at the one it began with.
    expect(textOf(read.entries[0]!.data)).toBe(textOf(must(await s.readHead("alpha", alice, "plan.docx")).bytes));
    expect(must(await s.readHead("alpha", alice, "plan.docx")).head.revision).toBe(2);
  });

  test("lists what it holds in a manifest that names the format, the revision, the hash and the size of each file", async () => {
    const s = await seeded();
    const read = readZip(await exported(s));
    const manifest = manifestOf(read);
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.exported_at).toBe(NOW.toISOString());
    expect(manifest.rooms.map((room) => [room.room_id, room.workspace_id, room.documents.map((d) => d.path)])).toEqual([
      ["alpha", "ws", ["alpha/plan.docx", "alpha/budget.xlsx"]],
      ["beta", "ws", ["beta/deck.pptx"]],
    ]);
    for (const room of manifest.rooms) {
      for (const listed of room.documents) {
        const head = must(await s.readHead(room.room_id, alice, listed.name));
        const entry = read.entries.find((candidate) => candidate.path === listed.path)!;
        expect(listed).toEqual({
          name: head.head.name,
          path: listed.path,
          format: head.head.format,
          revision: head.head.revision,
          sha256: head.head.sha256,
          size: head.bytes.length,
          updated_at: head.head.updated_at,
        });
        expect(sha256(entry.data)).toBe(listed.sha256);
        expect(entry.data.length).toBe(listed.size);
      }
    }
    expect(manifest.rooms[0]!.documents[0]!.revision).toBe(2);
  });

  test("stamps each file with the time its document was last changed, and the manifest with the time of the export", async () => {
    const s = await seeded();
    const read = readZip(await exported(s));
    const manifest = manifestOf(read);
    for (const listed of manifest.rooms.flatMap((room) => room.documents)) {
      const entry = read.entries.find((candidate) => candidate.path === listed.path)!;
      expect({ time: entry.time, date: entry.date }).toEqual(dosOf(listed.updated_at));
    }
    const last = read.entries.at(-1)!;
    expect({ time: last.time, date: last.date }).toEqual(dosOf(NOW.toISOString()));
  });

  test("stores its files with UTF-8 names and without compression", async () => {
    const s = await seeded();
    for (const entry of readZip(await exported(s)).entries) {
      expect(entry.method).toBe(0);
      expect(entry.flags).toBe(0x0800);
    }
  });

  test("of a workspace with no room holds the manifest alone", async () => {
    const s = await start();
    const read = readZip(await exported(s));
    expect(read.entries.map((entry) => entry.path)).toEqual([EXPORT_MANIFEST]);
    expect(manifestOf(read).rooms).toEqual([]);
  });

  test("reports how many rooms and documents it will hold once it is planned", async () => {
    const s = await seeded();
    const planned = must(await exportWorkspace(s, alice, { now: () => NOW }));
    expect([planned.rooms, planned.documents, planned.exported_at]).toEqual([2, 3, NOW.toISOString()]);
  });
});

describe("the export of a read-only workspace", () => {
  test("is the same archive, and writes nothing", async () => {
    const writable = await seeded();
    const before = await exported(writable);
    const rooms = await writable.listRooms();

    const s = await start({ readOnly: { reason: "The trial ended.", upgrade: "https://cloud.example.test/upgrade" } });
    const after = await exported(s);
    expect(after).toEqual(before);
    expect(await s.listRooms()).toEqual(rooms);
  });
});

describe("the export takes a seat like a read does", () => {
  test("an actor the plan has no seat for is refused before the first byte, with the refusal of the plan", async () => {
    const s = await start({ planCap: { maxSeats: 1, maxWorkspaces: null, name: "free", upgrade: "Move to the team plan." } });
    must(await s.createRoom(alice, { room_id: "alpha", workspace_id: "ws" }));
    must(await s.addDocument("alpha", alice, { name: "plan.docx", format: "docx", bytes: bytesOf("the plan") }));
    const spy = spied(s);
    const refusal = refusalOf(await exportWorkspace(spy.service, bob));
    expect(refusal.code).toBe("LICENSE_LIMIT");
    expect(refusal.code === "LICENSE_LIMIT" && refusal.reason).toBe("plan-seat-limit");
    expect(spy.reads).toEqual([]);
    expect(s.listSeats().map((seat) => seat.id)).toEqual(["alice"]);
    // The actor that holds the seat exports.
    expect(readZip(await exported(s, alice)).entries.map((entry) => entry.path)).toEqual(["alpha/plan.docx", EXPORT_MANIFEST]);
  });
});

describe("the archive is streamed", () => {
  test("a document is read when its turn comes, not when the export is planned", async () => {
    const s = await seeded();
    const spy = spied(s);
    const planned = must(await exportWorkspace(spy.service, alice, { now: () => NOW }));
    expect(spy.reads).toEqual([]);

    const seen: number[] = [];
    for await (const chunk of planned.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      seen.push(spy.reads.length);
    }
    expect(spy.reads).toEqual(["alpha/plan.docx", "alpha/budget.xlsx", "beta/deck.pptx"]);
    // A document is read only once the chunks before it were taken: the count of reads never jumps ahead.
    expect(seen[0]).toBe(1);
    seen.forEach((reads, i) => expect(reads - (seen[i - 1] ?? 0)).toBeLessThanOrEqual(1));
    expect(seen.at(-1)).toBe(3);
  });

  test("stops at a document that cannot be read, and what was sent is not an archive", async () => {
    const s = await seeded();
    const spy = spied(s, ["budget.xlsx"]);
    const planned = must(await exportWorkspace(spy.service, alice, { now: () => NOW }));
    const sent: Uint8Array[] = [];
    let failure: unknown;
    try {
      for await (const chunk of planned.chunks) sent.push(chunk);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExportAborted);
    expect((failure as ExportAborted).message).toContain("budget.xlsx of alpha");
    expect(spy.reads).toEqual(["alpha/plan.docx", "alpha/budget.xlsx"]);
    const joined = new Uint8Array(sent.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of sent) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    // No directory was written, so no reader takes the first document for a whole archive.
    const signatures = new DataView(joined.buffer);
    for (let i = 0; i + 4 <= joined.length; i += 1) expect([CENTRAL, END]).not.toContain(signatures.getUint32(i, true));
  });
});

describe("the names in the archive", () => {
  test("keep apart names that differ only in case, in a room and among the rooms", async () => {
    const s = await start();
    must(await s.createRoom(alice, { room_id: "Alpha", workspace_id: "ws" }));
    must(await s.createRoom(alice, { room_id: "alpha", workspace_id: "ws" }));
    must(await s.addDocument("Alpha", alice, { name: "Report.docx", format: "docx", bytes: bytesOf("one") }));
    must(await s.addDocument("Alpha", alice, { name: "report.docx", format: "docx", bytes: bytesOf("two") }));
    must(await s.addDocument("Alpha", alice, { name: "REPORT.docx", format: "docx", bytes: bytesOf("three") }));
    must(await s.addDocument("alpha", alice, { name: "report.docx", format: "docx", bytes: bytesOf("four") }));
    const read = readZip(await exported(s));
    const paths = read.entries.map((entry) => entry.path);
    expect(paths).toEqual([
      "Alpha/Report.docx",
      "Alpha/report (2).docx",
      "Alpha/REPORT (3).docx",
      "alpha (2)/report.docx",
      EXPORT_MANIFEST,
    ]);
    expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(paths.length);
    expect(read.entries.map((entry) => textOf(entry.data)).slice(0, 4)).toEqual(["one", "two", "three", "four"]);
    // The manifest says which document each file is.
    expect(manifestOf(read).rooms.flatMap((room) => room.documents.map((d) => [d.name, d.path]))).toEqual([
      ["Report.docx", "Alpha/Report.docx"],
      ["report.docx", "Alpha/report (2).docx"],
      ["REPORT.docx", "Alpha/REPORT (3).docx"],
      ["report.docx", "alpha (2)/report.docx"],
    ]);
  });

  test("a document named like the manifest does not take its place", async () => {
    const s = await start();
    must(await s.createRoom(alice, { room_id: "manifest.json", workspace_id: "ws" }));
    must(await s.addDocument("manifest.json", alice, { name: "manifest.json", format: "docx", bytes: bytesOf("mine") }));
    const read = readZip(await exported(s));
    expect(read.entries.map((entry) => entry.path)).toEqual(["manifest (2).json/manifest.json", EXPORT_MANIFEST]);
    expect(manifestOf(read).format).toBe(EXPORT_FORMAT);
  });

  test("never leave the directory of their room, whatever the document is called", async () => {
    const s = await start();
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    for (const [i, name] of ["../escape.docx", "a/b\\c.docx", "..", "C:evil.docx", "line\nbreak.docx", "con.docx"].entries()) {
      must(await s.addDocument("room", alice, { name, format: "docx", bytes: bytesOf(`doc ${i}`) }));
    }
    const read = readZip(await exported(s));
    const paths = read.entries.map((entry) => entry.path);
    expect(paths).toEqual([
      "room/.._escape.docx",
      "room/a_b_c.docx",
      "room/document",
      "room/C_evil.docx",
      "room/line_break.docx",
      "room/_con.docx",
      EXPORT_MANIFEST,
    ]);
    for (const path of paths.slice(0, -1)) expect(path.split("/")).toHaveLength(2);
    expect(read.entries.slice(0, 6).map((entry) => textOf(entry.data))).toEqual(["doc 0", "doc 1", "doc 2", "doc 3", "doc 4", "doc 5"]);
  });
});

describe("safeSegment", () => {
  test("makes one path segment that is safe on every system", () => {
    expect(safeSegment("plan.docx", "x")).toBe("plan.docx");
    expect(safeSegment("a/b\\c:d*e?f\"g<h>i|j.docx", "x")).toBe("a_b_c_d_e_f_g_h_i_j.docx");
    expect(safeSegment("tab\there\u0000.docx", "x")).toBe("tab_here_.docx");
    expect(safeSegment(".", "x")).toBe("x");
    expect(safeSegment("..", "x")).toBe("x");
    expect(safeSegment("  ", "x")).toBe("x");
    expect(safeSegment("name. .", "x")).toBe("name");
    expect(safeSegment(" lead.docx", "x")).toBe("lead.docx");
    expect(safeSegment("NUL", "x")).toBe("_NUL");
    expect(safeSegment("com1.txt", "x")).toBe("_com1.txt");
    expect(safeSegment("console.docx", "x")).toBe("console.docx");
    expect(safeSegment("Quarterly review \u00e9t\u00e9 \u{1f4c8}.docx", "x")).toBe("Quarterly review \u00e9t\u00e9 \u{1f4c8}.docx");
  });

  test("shortens a long name to 200 bytes, keeps its extension and never cuts a character in half", () => {
    const long = safeSegment(`${"a".repeat(300)}.docx`, "x");
    expect(long).toBe(`${"a".repeat(195)}.docx`);
    const wide = safeSegment(`${"\u{1f4c8}".repeat(100)}.xlsx`, "x");
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(200);
    expect(wide.endsWith(".xlsx")).toBe(true);
    expect(decoder.decode(new TextEncoder().encode(wide))).toBe(wide);
    expect(safeSegment(`${"a".repeat(198)} .docx`, "x").endsWith(".docx")).toBe(true);
    expect(new TextEncoder().encode(safeSegment("b".repeat(400), "x")).length).toBe(200);
  });
});

describe("the ZIP writer", () => {
  const modified = new Date("2026-11-14T09:30:15.000Z");

  function written(writer: ZipWriter, files: [string, string][]): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [path, text] of files) parts.push(...writer.file(path, bytesOf(text), modified));
    parts.push(...writer.finish());
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  }

  test("writes the 32-bit form while everything fits", () => {
    const read = readZip(written(new ZipWriter(), [["a.txt", "alpha"], ["dir/b.txt", ""]]));
    expect(read.wide).toBe(false);
    expect(read.entries.map((entry) => [entry.path, textOf(entry.data), entry.wide])).toEqual([
      ["a.txt", "alpha", false],
      ["dir/b.txt", "", false],
    ]);
  });

  test("an empty archive is the end record alone", () => {
    const empty = written(new ZipWriter(), []);
    expect(empty.length).toBe(22);
    expect(readZip(empty).entries).toEqual([]);
  });

  test("writes the 64-bit form for a file whose size, a directory entry whose offset and a count that do not fit", () => {
    // Limits of a few bytes reach the forms that sizes of 4 GiB reach: the first file is at offset 0, so only its size is
    // wide; the second is also at an offset the 32-bit field no longer holds.
    const read = readZip(written(new ZipWriter({ size: 40, entries: 3 }), [["small.txt", "tiny"], ["big.txt", "x".repeat(60)], ["after.txt", "later"]]));
    expect(read.wide).toBe(true);
    expect(read.entries.map((entry) => [entry.path, entry.data.length, entry.wide])).toEqual([
      ["small.txt", 4, false],
      ["big.txt", 60, true],
      ["after.txt", 5, true],
    ]);
    expect(textOf(read.entries[1]!.data)).toBe("x".repeat(60));
  });

  test("65535 entries need the 64-bit end record, 65534 do not", () => {
    const names = (n: number): [string, string][] => Array.from({ length: n }, (_, i): [string, string] => [`f${i}`, ""]);
    const wide = readZip(written(new ZipWriter(), names(0xffff)));
    expect(wide.wide).toBe(true);
    expect(wide.entries).toHaveLength(0xffff);
    const narrow = readZip(written(new ZipWriter(), names(0xfffe)));
    expect(narrow.wide).toBe(false);
    expect(narrow.entries).toHaveLength(0xfffe);
  });

  test("clamps a time before 1980 and after 2107 to the nearest the format holds", () => {
    const writer = new ZipWriter();
    const read = readZip(
      (() => {
        const parts = [
          ...writer.file("old", bytesOf("a"), new Date("1970-01-01T00:00:00.000Z")),
          ...writer.file("new", bytesOf("b"), new Date("2200-06-01T00:00:00.000Z")),
          ...writer.file("bad", bytesOf("c"), new Date(Number.NaN)),
          ...writer.finish(),
        ];
        const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) {
          joined.set(part, at);
          at += part.length;
        }
        return joined;
      })(),
    );
    expect(read.entries.map((entry) => [entry.date, entry.time])).toEqual([
      [(1 << 5) | 1, 0],
      [(127 << 9) | (12 << 5) | 31, (23 << 11) | (59 << 5) | 29],
      [(1 << 5) | 1, 0],
    ]);
  });
});

describe("the export of a workspace with a document the engine renders as bytes it cannot read back", () => {
  test("is never judged: the archive holds the stored bytes, not an interpretation of them", async () => {
    const s = await start();
    must(await s.createRoom(alice, { room_id: "room", workspace_id: "ws" }));
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31 + 7) % 256);
    must(await s.addDocument("room", alice, { name: "blob.pdf", format: "pdf", bytes }));
    const read = readZip(await exported(s));
    expect(read.entries[0]!.data).toEqual(bytes);
    expect(manifestOf(read).rooms[0]!.documents[0]!.sha256).toBe(sha256(bytes));
  });
});
