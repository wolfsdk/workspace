// The export of a workspace: every document of every room, at its head revision, in one ZIP archive that anyone
// can open without tools. The walk reads each room once to learn its documents (that is where a refusal, such as
// a seat the actor cannot have, is found, before the first byte), then reads the documents one at a time and hands
// each to the writer as it goes, so the archive is never held in memory, and no more than one document is.
//
// The layout is `<room id>/<document name>`, and `manifest.json` at the root, last, because it lists the size of
// each document, which is known only after the document was read. Every entry is stored, not compressed: the
// documents are ZIP containers themselves. The central directory comes after the last entry, so an archive that
// was cut short (a read that failed half way) is not an archive at all, and cannot pass for a complete one.
import { extname } from "node:path";
import type { RoomActor, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import type { Result, RoomService } from "./service.ts";

/** The `format` member of the manifest. */
export const EXPORT_FORMAT = "wolfsdk.workspace.export.v1";
/** The path of the manifest in the archive. No room directory takes this name. */
export const EXPORT_MANIFEST = "manifest.json";

/** One document of the archive, as the manifest lists it: the head the archive holds, not the head the room had when
 * the export began. */
export type ExportedDocument = {
  /** The name of the document in its room. */
  name: string;
  /** The path of its bytes in the archive. */
  path: string;
  format: WorkspaceDocFormat;
  revision: number;
  sha256: string;
  /** The size of the bytes in the archive. */
  size: number;
  updated_at: string;
};

export type ExportedRoom = { room_id: string; workspace_id: string; documents: ExportedDocument[] };

export type ExportManifest = { format: typeof EXPORT_FORMAT; exported_at: string; rooms: ExportedRoom[] };

export type WorkspaceExport = {
  /** When the export began, as an ISO timestamp: the `exported_at` of the manifest. */
  exported_at: string;
  rooms: number;
  documents: number;
  /** The archive. Reading it reads the documents; it rejects when a document cannot be read, and then the archive is
   * unfinished: its last bytes, the directory, are never written. */
  chunks: AsyncIterable<Uint8Array>;
};

// ZIP -----------------------------------------------------------------------------------------------------------

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const END_OF_DIRECTORY_64 = 0x06064b50;
const END_LOCATOR_64 = 0x07064b50;
const ZIP64_FIELD = 1;
const VERSION = 20;
const VERSION_64 = 45;
/** Bit 11 of the flags: the names are UTF-8. */
const UTF8_NAMES = 0x0800;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/** The mode of a file made by Unix (`-rw-r--r--`), in the upper half of the external attributes. */
const FILE_MODE = (0o100644 << 16) >>> 0;
const UNIX = 3 << 8;

/** The point from which a size, an offset or a count no longer fits its field and is written the ZIP64 way. The
 * defaults are those of the format; a test lowers them to reach the wide form with small archives. */
export type ZipLimits = { size: number; entries: number };
export const ZIP_LIMITS: ZipLimits = { size: U32_MAX, entries: U16_MAX };

/** A little-endian record of a known length. */
class Frame {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #at = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.#view = new DataView(this.bytes.buffer);
  }

  u16(value: number): this {
    this.#view.setUint16(this.#at, value, true);
    this.#at += 2;
    return this;
  }

  u32(value: number): this {
    this.#view.setUint32(this.#at, value, true);
    this.#at += 4;
    return this;
  }

  u64(value: number): this {
    this.#view.setBigUint64(this.#at, BigInt(value), true);
    this.#at += 8;
    return this;
  }

  put(bytes: Uint8Array): this {
    this.bytes.set(bytes, this.#at);
    this.#at += bytes.length;
    return this;
  }
}

/** The MS-DOS date and time of a ZIP entry, read from the UTC fields; a time outside 1980 to 2107 is the nearest end. */
function dosStamp(modified: Date): { time: number; date: number } {
  const first = { time: 0, date: (1 << 5) | 1 };
  const last = { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  const ms = modified.getTime();
  if (Number.isNaN(ms) || modified.getUTCFullYear() < 1980) return first;
  if (modified.getUTCFullYear() > 2107) return last;
  return {
    time: (modified.getUTCHours() << 11) | (modified.getUTCMinutes() << 5) | (modified.getUTCSeconds() >> 1),
    date: ((modified.getUTCFullYear() - 1980) << 9) | ((modified.getUTCMonth() + 1) << 5) | modified.getUTCDate(),
  };
}

const NAMES = new TextEncoder();

/** A ZIP archive written one stored file at a time: `file` returns the bytes of the entry to send now, `finish` the
 * directory that closes the archive. A size, an offset or a count at its limit is written the ZIP64 way, so the
 * archive has no size limit of its own. */
export class ZipWriter {
  readonly #limits: ZipLimits;
  readonly #directory: Uint8Array[] = [];
  #offset = 0;
  #count = 0;

  constructor(limits: ZipLimits = ZIP_LIMITS) {
    this.#limits = limits;
  }

  /** The entry for a file: its header, then `data` itself (not copied). */
  file(path: string, data: Uint8Array, modified: Date): Uint8Array[] {
    const name = NAMES.encode(path);
    const { time, date } = dosStamp(modified);
    const crc = Bun.hash.crc32(data);
    const wideSize = data.length >= this.#limits.size;
    const wideOffset = this.#offset >= this.#limits.size;
    const local = new Frame(30 + name.length + (wideSize ? 20 : 0))
      .u32(LOCAL_HEADER)
      .u16(wideSize ? VERSION_64 : VERSION)
      .u16(UTF8_NAMES)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(wideSize ? U32_MAX : data.length)
      .u32(wideSize ? U32_MAX : data.length)
      .u16(name.length)
      .u16(wideSize ? 20 : 0)
      .put(name);
    if (wideSize) local.u16(ZIP64_FIELD).u16(16).u64(data.length).u64(data.length);

    // The fields of the directory entry that did not fit, in the order the format gives them.
    const wide: number[] = [...(wideSize ? [data.length, data.length] : []), ...(wideOffset ? [this.#offset] : [])];
    const extra = wide.length === 0 ? 0 : 4 + 8 * wide.length;
    const version = wide.length === 0 ? VERSION : VERSION_64;
    const entry = new Frame(46 + name.length + extra)
      .u32(CENTRAL_HEADER)
      .u16(UNIX | version)
      .u16(wideSize ? VERSION_64 : VERSION)
      .u16(UTF8_NAMES)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(crc)
      .u32(wideSize ? U32_MAX : data.length)
      .u32(wideSize ? U32_MAX : data.length)
      .u16(name.length)
      .u16(extra)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(FILE_MODE)
      .u32(wideOffset ? U32_MAX : this.#offset)
      .put(name);
    if (wide.length > 0) {
      entry.u16(ZIP64_FIELD).u16(8 * wide.length);
      for (const value of wide) entry.u64(value);
    }
    this.#directory.push(entry.bytes);
    this.#offset += local.bytes.length + data.length;
    this.#count += 1;
    return [local.bytes, data];
  }

  /** The central directory and the end of the archive. */
  finish(): Uint8Array[] {
    const start = this.#offset;
    const size = this.#directory.reduce((sum, entry) => sum + entry.length, 0);
    const count = this.#count;
    const wide = count >= this.#limits.entries || size >= this.#limits.size || start >= this.#limits.size;
    const tail = [...this.#directory];
    if (wide) {
      tail.push(
        new Frame(56)
          .u32(END_OF_DIRECTORY_64)
          .u64(44)
          .u16(VERSION_64)
          .u16(VERSION_64)
          .u32(0)
          .u32(0)
          .u64(count)
          .u64(count)
          .u64(size)
          .u64(start).bytes,
      );
      tail.push(new Frame(20).u32(END_LOCATOR_64).u32(0).u64(start + size).u32(1).bytes);
    }
    tail.push(
      new Frame(22)
        .u32(END_OF_DIRECTORY)
        .u16(0)
        .u16(0)
        .u16(wide ? U16_MAX : count)
        .u16(wide ? U16_MAX : count)
        .u32(wide ? U32_MAX : size)
        .u32(wide ? U32_MAX : start)
        .u16(0).bytes,
    );
    return tail;
  }
}

// Names ---------------------------------------------------------------------------------------------------------

/** The most bytes of the name of a file in the archive. */
const NAME_BYTES = 200;
/** Characters that no file system takes in a name, and the control characters. */
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
/** Names Windows reserves, with or without an extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const bytesOf = (text: string): number => NAMES.encode(text).length;

/** The text without the dots and spaces a file name must not end with, or begin with a space. */
const trimmed = (text: string): string => text.replace(/[. ]+$/, "").trim();

/** A name that is one safe path segment on every system: no separator, no control character, not `.` or `..`, no
 * trailing dot or space, not a name Windows keeps, and at most `NAME_BYTES` bytes with its extension kept. */
export function safeSegment(name: string, fallback: string): string {
  let text = trimmed(name.replace(UNSAFE_CHARACTERS, "_"));
  if (text === "") text = fallback;
  if (RESERVED_NAMES.test(text)) text = `_${text}`;
  if (bytesOf(text) > NAME_BYTES) {
    const extension = extname(text).length <= 16 ? extname(text) : "";
    const stem = Array.from(text.slice(0, text.length - extension.length));
    while (stem.length > 0 && bytesOf(stem.join("")) + bytesOf(extension) > NAME_BYTES) stem.pop();
    text = trimmed(stem.join("")) + extension;
  }
  return text === "" ? fallback : text;
}

/** Hands out names that differ even in case, since the archive is opened on systems that do not tell `A.docx` from
 * `a.docx`: a name already taken gets ` (2)`, ` (3)`, and so on before its extension. */
class Names {
  readonly #taken: Record<string, true> = Object.create(null);

  constructor(reserved: readonly string[] = []) {
    for (const name of reserved) this.#taken[name.toLowerCase()] = true;
  }

  take(name: string): string {
    let candidate = name;
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let n = 2; this.#taken[candidate.toLowerCase()] === true; n += 1) candidate = `${stem} (${n})${extension}`;
    this.#taken[candidate.toLowerCase()] = true;
    return candidate;
  }
}

// The walk ------------------------------------------------------------------------------------------------------

type PlannedDocument = { name: string; path: string };
type PlannedRoom = { room_id: string; workspace_id: string; documents: PlannedDocument[] };

/** A document that was listed and then could not be read: the archive stops and is left without its directory. */
export class ExportAborted extends Error {
  readonly room_id: string;
  readonly doc_name: string;
  readonly reason: string;

  constructor(room_id: string, doc_name: string, reason: string) {
    super(`export stopped: ${doc_name} of ${room_id} cannot be read: ${reason}`);
    this.name = "ExportAborted";
    this.room_id = room_id;
    this.doc_name = doc_name;
    this.reason = reason;
  }
}

async function* archive(
  service: RoomService,
  actor: RoomActor,
  rooms: readonly PlannedRoom[],
  exportedAt: Date,
  limits: ZipLimits,
): AsyncGenerator<Uint8Array> {
  const zip = new ZipWriter(limits);
  const manifest: ExportManifest = { format: EXPORT_FORMAT, exported_at: exportedAt.toISOString(), rooms: [] };
  for (const room of rooms) {
    const listed: ExportedRoom = { room_id: room.room_id, workspace_id: room.workspace_id, documents: [] };
    manifest.rooms.push(listed);
    for (const document of room.documents) {
      const read = await service.readHead(room.room_id, actor, document.name);
      if (!read.ok) throw new ExportAborted(room.room_id, document.name, `${read.error.code}: ${read.error.message}`);
      const { head, bytes } = read.value;
      yield* zip.file(document.path, bytes, new Date(head.updated_at));
      listed.documents.push({
        name: head.name,
        path: document.path,
        format: head.format,
        revision: head.revision,
        sha256: head.sha256,
        size: bytes.length,
        updated_at: head.updated_at,
      });
    }
  }
  yield* zip.file(EXPORT_MANIFEST, NAMES.encode(`${JSON.stringify(manifest, null, 2)}\n`), exportedAt);
  yield* zip.finish();
}

/** Plan the export of every room of the workspace for `actor`, and return the archive to stream. Reading a room
 * takes a seat like any read (`GET /api/rooms/<room>` does too): an actor the licence or the plan does not seat is
 * refused here, with that refusal, before an archive begins. Works in a read-only workspace: it writes nothing. */
export async function exportWorkspace(
  service: RoomService,
  actor: RoomActor,
  options: { now?: () => Date; limits?: ZipLimits } = {},
): Promise<Result<WorkspaceExport>> {
  const exportedAt = options.now?.() ?? new Date();
  const directories = new Names([EXPORT_MANIFEST]);
  const rooms: PlannedRoom[] = [];
  let documents = 0;
  for (const row of await service.listRooms()) {
    const room = await service.getRoom(row.room_id, actor);
    if (!room.ok) return { ok: false, error: room.error };
    const directory = directories.take(safeSegment(row.room_id, "room"));
    const files = new Names();
    const planned: PlannedDocument[] = room.value.documents.map(({ head }) => ({
      name: head.name,
      path: `${directory}/${files.take(safeSegment(head.name, "document"))}`,
    }));
    documents += planned.length;
    rooms.push({ room_id: row.room_id, workspace_id: room.value.workspace_id, documents: planned });
  }
  return {
    ok: true,
    value: {
      exported_at: exportedAt.toISOString(),
      rooms: rooms.length,
      documents,
      chunks: archive(service, actor, rooms, exportedAt, options.limits ?? ZIP_LIMITS),
    },
  };
}
