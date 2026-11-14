// Part-level comparison of two OOXML packages (ZIP files), read from the central directory
// without decompressing anything. It is an independent check, outside the engine, that the only
// parts that changed between two saved files are the ones the reviewed changes name.

export type PartEntry = {
  name: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
};
export type PartDelta = { name: string; status: "added" | "removed" | "changed" | "recompressed" };

type Located = { part: PartEntry; offset: number };

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;
const utf8 = new TextDecoder("utf-8");

function fail(reason: string): never {
  throw new Error(`not-a-zip: ${reason}`);
}

function u64(v: DataView, at: number): number {
  const n = v.getBigUint64(at, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail("64-bit field out of range");
  return Number(n);
}

/** Scans back over at most a 64 KiB comment; prefers a record whose comment ends the input exactly. */
function findEocd(v: DataView): number {
  const last = v.byteLength - 22;
  let loose = -1;
  for (let at = last; at >= 0 && at >= last - 0xffff; at--) {
    if (v.getUint32(at, true) !== EOCD) continue;
    const end = at + 22 + v.getUint16(at + 20, true);
    if (end === v.byteLength) return at;
    if (end < v.byteLength && loose < 0) loose = at;
  }
  if (loose < 0) fail("no end of central directory record");
  return loose;
}

/** Replaces each 0xFFFFFFFF field, in order, from the ZIP64 extended-information extra field (id 1). */
function widen(v: DataView, at: number, len: number, fields: number[], name: string): number[] {
  const end = at + len;
  while (at + 4 <= end) {
    const id = v.getUint16(at, true);
    const size = v.getUint16(at + 2, true);
    if (id === 1) {
      let p = at + 4;
      const stop = Math.min(p + size, end);
      return fields.map((f) => {
        if (f !== MAX32) return f;
        if (p + 8 > stop) fail(`short zip64 field for ${name}`);
        const n = u64(v, p);
        p += 8;
        return n;
      });
    }
    at += 4 + size;
  }
  fail(`missing zip64 field for ${name}`);
}

function readEntries(zip: Uint8Array): Located[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(v);
  let disks = [v.getUint16(eocd + 4, true), v.getUint16(eocd + 6, true)];
  let count = v.getUint16(eocd + 10, true);
  let size = v.getUint32(eocd + 12, true);
  let start = v.getUint32(eocd + 16, true);
  const loc = eocd - 20;
  if (loc >= 0 && v.getUint32(loc, true) === LOCATOR64) {
    const at = u64(v, loc + 8);
    if (at + 56 > loc || v.getUint32(at, true) !== EOCD64) fail("bad zip64 end of central directory record");
    disks = [v.getUint32(at + 16, true), v.getUint32(at + 20, true)];
    count = u64(v, at + 32);
    size = u64(v, at + 40);
    start = u64(v, at + 48);
  }
  if (disks[0] !== 0 || disks[1] !== 0) fail("multi-disk archive");
  const end = start + size;
  if (end > v.byteLength) fail("central directory runs past the end of the input");
  const out: Located[] = [];
  const seen = new Set<string>();
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || v.getUint32(at, true) !== CENTRAL) fail(`bad central directory header ${i}`);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const next = at + 46 + nameLen + extraLen + v.getUint16(at + 32, true);
    if (next > end) fail(`central directory header ${i} runs past the directory`);
    const name = utf8.decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (seen.has(name)) fail(`duplicate entry ${name}`);
    seen.add(name);
    let fields = [v.getUint32(at + 24, true), v.getUint32(at + 20, true), v.getUint32(at + 42, true)];
    if (fields.includes(MAX32)) fields = widen(v, at + 46 + nameLen, extraLen, fields, name);
    const [uncompressedSize, compressedSize, offset] = fields as [number, number, number];
    if (!name.endsWith("/"))
      out.push({
        part: {
          name,
          crc32: v.getUint32(at + 16, true),
          compressedSize,
          uncompressedSize,
          method: v.getUint16(at + 10, true),
        },
        offset,
      });
    at = next;
  }
  return out;
}

/** Compressed bytes of an entry; the local header's name and extra lengths can differ from the central ones. */
function dataOf(zip: Uint8Array, e: Located): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (e.offset + 30 > v.byteLength || v.getUint32(e.offset, true) !== LOCAL)
    fail(`bad local header for ${e.part.name}`);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const end = start + e.part.compressedSize;
  if (end > v.byteLength) fail(`data for ${e.part.name} runs past the end of the input`);
  return zip.subarray(start, end);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** File entries in central-directory order; directory entries are skipped. */
export function listParts(zip: Uint8Array): PartEntry[] {
  return readEntries(zip).map((e) => e.part);
}

export function comparePackages(before: Uint8Array, after: Uint8Array): { identical: string[]; deltas: PartDelta[] } {
  const a = new Map(readEntries(before).map((e) => [e.part.name, e]));
  const b = new Map(readEntries(after).map((e) => [e.part.name, e]));
  const identical: string[] = [];
  const deltas: PartDelta[] = [];
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) deltas.push({ name, status: "removed" });
    else if (x.part.crc32 !== y.part.crc32 || x.part.uncompressedSize !== y.part.uncompressedSize)
      deltas.push({ name, status: "changed" });
    else if (
      x.part.method !== y.part.method ||
      x.part.compressedSize !== y.part.compressedSize ||
      !sameBytes(dataOf(before, x), dataOf(after, y))
    )
      deltas.push({ name, status: "recompressed" });
    else identical.push(name);
  }
  for (const name of b.keys()) if (!a.has(name)) deltas.push({ name, status: "added" });
  identical.sort();
  deltas.sort((p, q) => (p.name < q.name ? -1 : p.name > q.name ? 1 : 0));
  return { identical, deltas };
}

/** Content deltas (added, removed, changed) not named in `explained`; one leading "/" is ignored on both sides. */
export function unexplainedParts(deltas: PartDelta[], explained: Iterable<string>): PartDelta[] {
  const known = new Set<string>();
  for (const name of explained) known.add(name.replace(/^\//, ""));
  return deltas.filter((d) => d.status !== "recompressed" && !known.has(d.name.replace(/^\//, "")));
}
