// A bounded ZIP reader and a minimal ZIP writer, enough for OOXML packages. Reading goes through the central
// directory, accepts stored and deflated entries, and refuses ZIP64, encrypted entries, unsafe names and
// archives that would inflate past the limits, so a hostile upload can not exhaust memory.
import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Entries an archive may hold. */
export const ZIP_MAX_ENTRIES = 20_000;
/** Inflated size of one entry. */
export const ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Inflated size of everything read from one archive. */
export const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

type Entry = { name: string; method: number; compressed: number; size: number; crc: number; offset: number };

const decoder = new TextDecoder("utf-8", { fatal: false });

export class ZipArchive {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #entries: Map<string, Entry>;
  #inflated = 0;

  private constructor(bytes: Uint8Array, entries: Map<string, Entry>) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#entries = entries;
  }

  /** Read the central directory of `bytes`. Throws `ZipError` when they are not a ZIP archive this reader accepts. */
  static open(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const floor = Math.max(0, bytes.byteLength - 22 - 0xffff);
    for (let at = bytes.byteLength - 22; at >= floor; at--) {
      if (view.getUint32(at, true) === EOCD_SIGNATURE) {
        eocd = at;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("not a ZIP archive: no end of central directory record");
    const count = view.getUint16(eocd + 10, true);
    const size = view.getUint32(eocd + 12, true);
    const offset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
    if (count > ZIP_MAX_ENTRIES) throw new ZipError(`the archive holds ${count} entries, over the limit of ${ZIP_MAX_ENTRIES}`);
    if (offset + size > eocd) throw new ZipError("the central directory runs past the end of the archive");

    const entries = new Map<string, Entry>();
    let at = offset;
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw new ZipError("corrupt central directory");
      const flags = view.getUint16(at + 8, true);
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const compressed = view.getUint32(at + 20, true);
      const uncompressed = view.getUint32(at + 24, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const commentLen = view.getUint16(at + 32, true);
      const localOffset = view.getUint32(at + 42, true);
      if (at + 46 + nameLen > bytes.byteLength) throw new ZipError("corrupt central directory");
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      if ((flags & 1) !== 0) throw new ZipError(`entry ${name} is encrypted`);
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
      if (name.startsWith("/") || name.includes("\\") || name.split("/").some((segment) => segment === "..")) throw new ZipError(`entry name ${name} is not a safe relative path`);
      if (entries.has(name)) throw new ZipError(`entry ${name} appears twice`);
      entries.set(name, { name, method, compressed, size: uncompressed, crc, offset: localOffset });
    }
    return new ZipArchive(bytes, entries);
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** The inflated bytes of entry `name`; throws `ZipError` when it is missing, damaged or too large. */
  bytes(name: string): Uint8Array {
    const entry = this.#entries.get(name);
    if (!entry) throw new ZipError(`the archive has no entry ${name}`);
    if (entry.size > ZIP_MAX_ENTRY_BYTES) throw new ZipError(`entry ${name} inflates to ${entry.size} bytes, over the limit of ${ZIP_MAX_ENTRY_BYTES}`);
    if (this.#inflated + entry.size > ZIP_MAX_TOTAL_BYTES) throw new ZipError(`the archive inflates past ${ZIP_MAX_TOTAL_BYTES} bytes`);
    const at = entry.offset;
    if (at + 30 > this.#bytes.byteLength || this.#view.getUint32(at, true) !== LOCAL_SIGNATURE) throw new ZipError(`entry ${name} has a corrupt local header`);
    const start = at + 30 + this.#view.getUint16(at + 26, true) + this.#view.getUint16(at + 28, true);
    const end = start + entry.compressed;
    if (end > this.#bytes.byteLength) throw new ZipError(`entry ${name} runs past the end of the archive`);
    const raw = this.#bytes.subarray(start, end);
    let out: Uint8Array;
    if (entry.method === 0) {
      out = raw;
    } else if (entry.method === 8) {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
      } catch (error) {
        throw new ZipError(`entry ${name} does not inflate: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new ZipError(`entry ${name} uses compression method ${entry.method}, which is not supported`);
    }
    if (out.byteLength !== entry.size) throw new ZipError(`entry ${name} inflates to ${out.byteLength} bytes, not the ${entry.size} its header states`);
    if (crc32(out) !== entry.crc) throw new ZipError(`entry ${name} fails its CRC-32 check`);
    this.#inflated += out.byteLength;
    return out;
  }

  /** Entry `name` as UTF-8 text. */
  text(name: string): string {
    return decoder.decode(this.bytes(name));
  }

  /** Entry `name` as text, or `undefined` when the archive has no such entry. */
  optionalText(name: string): string | undefined {
    return this.has(name) ? this.text(name) : undefined;
  }
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive of `files` (name and UTF-8 text or bytes), stored without compression, in the order given.
 * The output is deterministic: every entry carries the fixed DOS timestamp 1980-01-01. */
export function writeZip(files: ReadonlyArray<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = files.map((file) => {
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    return { name: encoder.encode(file.name), data, crc: crc32(data) };
  });
  let total = 22;
  for (const file of prepared) total += 30 + file.name.length + file.data.length + 46 + file.name.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const file of prepared) {
    offsets.push(at);
    view.setUint32(at, LOCAL_SIGNATURE, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0x0021, true);
    view.setUint32(at + 14, file.crc, true);
    view.setUint32(at + 18, file.data.length, true);
    view.setUint32(at + 22, file.data.length, true);
    view.setUint16(at + 26, file.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(file.name, at + 30);
    out.set(file.data, at + 30 + file.name.length);
    at += 30 + file.name.length + file.data.length;
  }
  const centralStart = at;
  prepared.forEach((file, index) => {
    view.setUint32(at, CENTRAL_SIGNATURE, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, 0x0021, true);
    view.setUint32(at + 16, file.crc, true);
    view.setUint32(at + 20, file.data.length, true);
    view.setUint32(at + 24, file.data.length, true);
    view.setUint16(at + 28, file.name.length, true);
    view.setUint32(at + 42, offsets[index] as number, true);
    out.set(file.name, at + 46);
    at += 46 + file.name.length;
  });
  view.setUint32(at, EOCD_SIGNATURE, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
