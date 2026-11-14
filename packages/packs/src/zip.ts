// A minimal ZIP reader and part-preserving writer for OOXML packages, on the runtime's own `zlib`. Reading
// checks sizes and CRC-32 of every entry it inflates. Writing keeps every entry it was not asked to replace
// byte for byte (local header, compressed data, central directory record, order); a replaced entry is
// deflated at a fixed level with the time stamp of the entry it replaces, so the same input always gives the
// same bytes. ZIP64, encryption and multi-disk archives are refused.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { PackError } from "./errors.ts";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
/** The most one entry may inflate to: a package part is XML or a picture, never this big. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DEFLATE_LEVEL = 6;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DESCRIPTOR = 0x8;
/** 1980-01-01 00:00:00 in DOS date and time: the stamp of an entry this module creates. */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** The central directory record as it was read. */
  central: Uint8Array;
  /** Local header, compressed data and data descriptor as they were read. */
  stored: Uint8Array;
  /** Where the compressed data starts inside `stored`. */
  dataStart: number;
};

export type ZipArchive = { entries: ZipEntry[]; comment: Uint8Array };

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const bad = (message: string): PackError => new PackError("package-bad-zip", message);

export function readZip(bytes: Uint8Array): ZipArchive {
  const v = view(bytes);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === END_SIGNATURE) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad("the file is not a ZIP package: no end of central directory");
  const disk = v.getUint16(end + 4, true);
  const count = v.getUint16(end + 10, true);
  const centralSize = v.getUint32(end + 12, true);
  const centralOffset = v.getUint32(end + 16, true);
  const commentLength = v.getUint16(end + 20, true);
  if (disk !== 0 || v.getUint16(end + 6, true) !== 0) throw bad("multi-disk ZIP archives are not supported");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw bad("ZIP64 archives are not supported");
  if (centralOffset + centralSize > end) throw bad("the central directory overruns the file");
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== CENTRAL_SIGNATURE) throw bad(`central directory record ${i} is damaged`);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const compressedSize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLength = v.getUint16(at + 28, true);
    const extraLength = v.getUint16(at + 30, true);
    const entryComment = v.getUint16(at + 32, true);
    const localOffset = v.getUint32(at + 42, true);
    const recordEnd = at + 46 + nameLength + extraLength + entryComment;
    if (recordEnd > bytes.length) throw bad(`central directory record ${i} overruns the file`);
    if (flags & FLAG_ENCRYPTED) throw bad("encrypted ZIP entries are not supported");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (names.has(name)) throw bad(`the package names ${JSON.stringify(name)} twice`);
    names.add(name);
    if (localOffset + 30 > bytes.length || v.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw bad(`the local header of ${JSON.stringify(name)} is damaged`);
    const dataStart = 30 + v.getUint16(localOffset + 26, true) + v.getUint16(localOffset + 28, true);
    let storedEnd = localOffset + dataStart + compressedSize;
    if (storedEnd > bytes.length) throw bad(`the data of ${JSON.stringify(name)} overruns the file`);
    if (flags & FLAG_DESCRIPTOR) storedEnd += v.getUint32(storedEnd, true) === DESCRIPTOR_SIGNATURE ? 16 : 12;
    if (storedEnd > bytes.length) throw bad(`the data descriptor of ${JSON.stringify(name)} overruns the file`);
    entries.push({
      name,
      method,
      flags,
      crc32: crc,
      compressedSize,
      size,
      central: bytes.slice(at, recordEnd),
      stored: bytes.slice(localOffset, storedEnd),
      dataStart,
    });
    at = recordEnd;
  }
  return { entries, comment: bytes.slice(end + 22, end + 22 + commentLength) };
}

export function findEntry(archive: ZipArchive, name: string): ZipEntry | undefined {
  return archive.entries.find((e) => e.name === name);
}

/** The inflated bytes of an entry, after checking their size and CRC-32 against the directory. */
export function entryBytes(entry: ZipEntry): Uint8Array {
  if (entry.size > MAX_ENTRY_BYTES) throw bad(`${JSON.stringify(entry.name)} inflates to more than ${MAX_ENTRY_BYTES} bytes`);
  const data = entry.stored.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (e) {
      throw bad(`${JSON.stringify(entry.name)} does not inflate: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else throw bad(`${JSON.stringify(entry.name)} uses compression method ${entry.method}, which is not supported`);
  if (out.length !== entry.size) throw bad(`${JSON.stringify(entry.name)} inflates to ${out.length} bytes, its directory entry says ${entry.size}`);
  if (crc32(out) !== entry.crc32) throw bad(`${JSON.stringify(entry.name)} fails its CRC-32 check`);
  return out;
}

export function readEntry(archive: ZipArchive, name: string): Uint8Array | undefined {
  const entry = findEntry(archive, name);
  return entry === undefined ? undefined : entryBytes(entry);
}

export function readEntryText(archive: ZipArchive, name: string): string | undefined {
  const bytes = readEntry(archive, name);
  if (bytes === undefined) return undefined;
  // A UTF-8 byte order mark is not part of the text.
  return decoder.decode(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes);
}

export const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The archive with the entries in `replacements` swapped for new content. Every other entry is copied as it
 * was. An entry that is replaced keeps its name, order, time stamp and attributes, and is deflated at a fixed
 * level, so the output is a pure function of the input and the replacements.
 */
export function writeZip(archive: ZipArchive, replacements: ReadonlyMap<string, Uint8Array>): Uint8Array {
  for (const name of replacements.keys()) {
    if (findEntry(archive, name) === undefined) throw new PackError("package-missing-part", `the package has no part ${JSON.stringify(name)} to replace`);
  }
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of archive.entries) {
    const replacement = replacements.get(entry.name);
    const record = entry.central.slice();
    const rv = view(record);
    if (replacement === undefined) {
      rv.setUint32(42, offset, true);
      body.push(entry.stored);
      offset += entry.stored.length;
    } else {
      const compressed = deflateRawSync(replacement, { level: DEFLATE_LEVEL });
      const crc = crc32(replacement);
      const name = encoder.encode(entry.name);
      const flags = entry.flags & ~FLAG_DESCRIPTOR;
      const time = rv.getUint16(12, true);
      const date = rv.getUint16(14, true);
      const header = new Uint8Array(30);
      const hv = view(header);
      hv.setUint32(0, LOCAL_SIGNATURE, true);
      hv.setUint16(4, 20, true);
      hv.setUint16(6, flags, true);
      hv.setUint16(8, 8, true);
      hv.setUint16(10, time, true);
      hv.setUint16(12, date, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, compressed.length, true);
      hv.setUint32(22, replacement.length, true);
      hv.setUint16(26, name.length, true);
      hv.setUint16(28, 0, true);
      rv.setUint16(6, Math.max(rv.getUint16(6, true), 20), true);
      rv.setUint16(8, flags, true);
      rv.setUint16(10, 8, true);
      rv.setUint32(16, crc, true);
      rv.setUint32(20, compressed.length, true);
      rv.setUint32(24, replacement.length, true);
      rv.setUint32(42, offset, true);
      body.push(header, name, compressed);
      offset += header.length + name.length + compressed.length;
    }
    central.push(record);
  }
  const centralBytes = concat(central);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, END_SIGNATURE, true);
  ev.setUint16(8, archive.entries.length, true);
  ev.setUint16(10, archive.entries.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, archive.comment.length, true);
  return concat([...body, centralBytes, end, archive.comment]);
}

export type ZipSource = { name: string; data: Uint8Array | string };

/** A new package from scratch, with every time stamp fixed: the same files always give the same bytes. */
export function buildZip(files: readonly ZipSource[]): Uint8Array {
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const compressed = deflateRawSync(data, { level: DEFLATE_LEVEL });
    const crc = crc32(data);
    const name = encoder.encode(file.name);
    const header = new Uint8Array(30);
    const hv = view(header);
    hv.setUint32(0, LOCAL_SIGNATURE, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x800, true);
    hv.setUint16(8, 8, true);
    hv.setUint16(10, DOS_TIME, true);
    hv.setUint16(12, DOS_DATE, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, compressed.length, true);
    hv.setUint32(22, data.length, true);
    hv.setUint16(26, name.length, true);
    const record = new Uint8Array(46 + name.length);
    const rv = view(record);
    rv.setUint32(0, CENTRAL_SIGNATURE, true);
    rv.setUint16(4, 20, true);
    rv.setUint16(6, 20, true);
    rv.setUint16(8, 0x800, true);
    rv.setUint16(10, 8, true);
    rv.setUint16(12, DOS_TIME, true);
    rv.setUint16(14, DOS_DATE, true);
    rv.setUint32(16, crc, true);
    rv.setUint32(20, compressed.length, true);
    rv.setUint32(24, data.length, true);
    rv.setUint16(28, name.length, true);
    rv.setUint32(42, offset, true);
    record.set(name, 46);
    body.push(header, name, compressed);
    central.push(record);
    offset += header.length + name.length + compressed.length;
  }
  const centralBytes = concat(central);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, END_SIGNATURE, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...body, centralBytes, end]);
}
