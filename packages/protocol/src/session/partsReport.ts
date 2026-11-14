// Which package parts changed between the original file and the file being approved, and whether a
// change the reviewer saw names each one. Independent of the engine's diff: the part list comes from
// the two ZIP central directories (parts.ts); the entries only supply the names to check against.
// Relationship parts are also inflated and parsed here, so a retargeted or new outside link is spelled out.
import type { HistoryEntry } from "./history.ts";
import { comparePackages } from "./parts.ts";

export type Rel = {
  id: string;
  /** Last path segment of the Type URI (`hyperlink`, `image`, `slide`, ...). */
  type: string;
  target: string;
  /** TargetMode="External". */
  external: boolean;
};

export type PartFinding = {
  name: string;
  status: "added" | "removed" | "changed";
  /** Revisions whose change records name this part. Empty = no reviewed change explains it. */
  namedBy: number[];
  /** Revisions whose transaction.parts_written lists this part. Empty = the engine never reported writing it. */
  writtenBy: number[];
  /** "explained": named by a change record. "unnamed": written by the engine but named by no change record.
   *  "unreported": changed in the package but in no parts_written at all. */
  verdict: "explained" | "unnamed" | "unreported";
  /** Filled for every finding. */
  detail?: {
    /** Uncompressed bytes; null when the part is added. */
    sizeBefore: number | null;
    /** Null when the part is removed. */
    sizeAfter: number | null;
    /** Only for relationship parts (`*.rels`), parsed from both sides. */
    relationships?: {
      added: Rel[];
      removed: Rel[];
      /** Same Id on both sides with a different Type, Target or TargetMode. */
      changed: { before: Rel; after: Rel }[];
    };
  };
};

export type PartsReport = {
  /** Revisions of the entries considered, in the order given. */
  revisions: number[];
  /** Added + removed + changed parts. */
  changed: number;
  /** Same content, different compressed bytes: listed, never a finding. */
  recompressed: string[];
  /** Every added, removed or changed part, sorted by name. */
  findings: PartFinding[];
  /** Findings whose verdict is not "explained". */
  unexplained: PartFinding[];
  /** Parts named or written by an entry that did not change in the package (for example a change later undone). Informational. */
  claimedButUnchanged: string[];
};

const norm = (name: string): string => name.replace(/^\//, "");

function fail(reason: string): never {
  throw new Error(`not-a-zip: ${reason}`);
}

// ---- part bytes (parts.ts compares central directories only and does not expose entry data) ----

type Located = { method: number; crc32: number; compressedSize: number; size: number; offset: number };

/** File entries by normalised name, with local header offsets; ZIP64 aware. */
function locate(zip: Uint8Array): Map<string, Located> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u64 = (at: number) => Number(v.getBigUint64(at, true));
  let eocd = -1;
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at--) {
    if (v.getUint32(at, true) !== 0x06054b50) continue;
    if (eocd < 0) eocd = at;
    if (at + 22 + v.getUint16(at + 20, true) === zip.length) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) fail("no end of central directory record");
  let count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  if (eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50) {
    const z = u64(eocd - 12);
    if (z + 56 > zip.length || v.getUint32(z, true) !== 0x06064b50) fail("bad zip64 end of central directory record");
    count = u64(z + 32);
    at = u64(z + 48);
  }
  const out = new Map<string, Located>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || v.getUint32(at, true) !== 0x02014b50) fail(`bad central directory header ${i}`);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    // Uncompressed size, compressed size, local header offset; 0xFFFFFFFF ones come from the ZIP64 extra field in that order.
    const fields = [v.getUint32(at + 24, true), v.getUint32(at + 20, true), v.getUint32(at + 42, true)];
    if (fields.includes(0xffffffff)) {
      let x = at + 46 + nameLen;
      const end = x + extraLen;
      while (x + 4 <= end && v.getUint16(x, true) !== 1) x += 4 + v.getUint16(x + 2, true);
      if (x + 4 > end) fail(`missing zip64 field for ${name}`);
      let p = x + 4;
      for (let k = 0; k < 3; k++)
        if (fields[k] === 0xffffffff) {
          fields[k] = u64(p);
          p += 8;
        }
    }
    if (!name.endsWith("/"))
      out.set(norm(name), {
        method: v.getUint16(at + 10, true),
        crc32: v.getUint32(at + 16, true),
        size: fields[0]!,
        compressedSize: fields[1]!,
        offset: fields[2]!,
      });
    at += 46 + nameLen + extraLen + v.getUint16(at + 32, true);
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// DEFLATE tables (RFC 1951, 3.2.5 and 3.2.7).
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Huffman = { count: Uint16Array; symbol: Uint16Array };
function huffman(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]!]!++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
  const symbol = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]!]!++] = i;
  return { count, symbol };
}
const FIXED_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffman(new Array<number>(30).fill(5));

/** Raw DEFLATE decoder (synchronous, so the report stays a plain function); `size` is the expected output length. */
function inflateRaw(src: Uint8Array, size: number, name: string): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  let pos = 0;
  let buf = 0;
  let cnt = 0;
  const bad = (why: string): never => fail(`cannot inflate ${name}: ${why}`);
  const bits = (n: number): number => {
    while (cnt < n) {
      if (pos >= src.length) bad("data ends early");
      buf |= src[pos++]! << cnt;
      cnt += 8;
    }
    const value = buf & ((1 << n) - 1);
    buf >>>= n;
    cnt -= n;
    return value;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len]!;
      if (code - c < first) return h.symbol[index + (code - first)]!;
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    return bad("bad code");
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0;
      cnt = 0;
      if (pos + 4 > src.length) bad("data ends early");
      const len = src[pos]! | (src[pos + 1]! << 8);
      if ((len ^ (src[pos + 2]! | (src[pos + 3]! << 8))) !== 0xffff) bad("bad stored block");
      pos += 4;
      if (pos + len > src.length || o + len > size) bad("stored block out of range");
      out.set(src.subarray(pos, pos + len), o);
      pos += len;
      o += len;
      continue;
    }
    if (type === 3) bad("bad block type");
    let lit = FIXED_LIT;
    let dist = FIXED_DIST;
    if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const cl = new Array<number>(19).fill(0);
      for (let i = 0; i < ncode; i++) cl[CL_ORDER[i]!] = bits(3);
      const clh = huffman(cl);
      const lengths: number[] = [];
      while (lengths.length < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) lengths.push(sym);
        else {
          const rep = sym === 16 ? 3 + bits(2) : sym === 17 ? 3 + bits(3) : 11 + bits(7);
          if (sym === 16 && !lengths.length) bad("repeat with no previous length");
          const value = sym === 16 ? lengths.at(-1)! : 0;
          for (let k = 0; k < rep; k++) lengths.push(value);
        }
      }
      if (lengths.length > nlen + ndist) bad("too many lengths");
      lit = huffman(lengths.slice(0, nlen));
      dist = huffman(lengths.slice(nlen));
    }
    for (;;) {
      const sym = decode(lit);
      if (sym === 256) break;
      if (sym < 256) {
        if (o >= size) bad("output longer than recorded");
        out[o++] = sym;
        continue;
      }
      if (sym > 285) bad("bad length code");
      const len = LEN_BASE[sym - 257]! + bits(LEN_EXTRA[sym - 257]!);
      const d = decode(dist);
      if (d > 29) bad("bad distance code");
      const back = DIST_BASE[d]! + bits(DIST_EXTRA[d]!);
      if (back > o || o + len > size) bad("copy out of range");
      for (let k = 0; k < len; k++, o++) out[o] = out[o - back]!;
    }
  }
  if (o !== size) bad("output shorter than recorded");
  return out;
}

/** Uncompressed bytes of one entry, checked against its recorded CRC-32. */
function partBytes(zip: Uint8Array, e: Located, name: string): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (e.offset + 30 > zip.length || v.getUint32(e.offset, true) !== 0x04034b50) fail(`bad local header for ${name}`);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  if (start + e.compressedSize > zip.length) fail(`data for ${name} runs past the end of the input`);
  const packed = zip.subarray(start, start + e.compressedSize);
  const data =
    e.method === 0
      ? packed
      : e.method === 8
        ? inflateRaw(packed, e.size, name)
        : fail(`compression method ${e.method} for ${name}`);
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  if ((c ^ 0xffffffff) >>> 0 !== e.crc32) fail(`checksum mismatch for ${name}`);
  return data;
}

/** Uncompressed bytes of part `name` (a leading "/" is ignored), checked against its CRC-32;
 *  null when the package has no such part. Throws on a malformed package. */
export function partContent(zip: Uint8Array, name: string): Uint8Array | null {
  const key = norm(name);
  const e = locate(zip).get(key);
  return e ? partBytes(zip, e, key) : null;
}

// ---- relationships ----

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e]!,
  );

/** Every `<Relationship>` element, in order; tolerant of prefixes, attribute order, quote style and `>` inside values. */
function parseRels(bytes: Uint8Array): Rel[] {
  const enc =
    bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8";
  const xml = new TextDecoder(enc).decode(bytes);
  const rels: Rel[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?Relationship(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attrs.set(a[1]!.replace(/^.*:/, "").toLowerCase(), decodeXml(a[2] ?? a[3] ?? ""));
    const type = attrs.get("type") ?? "";
    rels.push({
      id: attrs.get("id") ?? "",
      type: type.slice(type.lastIndexOf("/") + 1),
      target: attrs.get("target") ?? "",
      external: (attrs.get("targetmode") ?? "").toLowerCase() === "external",
    });
  }
  return rels;
}

/** Pairs relationships by Id (repeated Ids pair in order); unpaired ones are added or removed. */
function compareRels(before: Rel[], after: Rel[]): NonNullable<NonNullable<PartFinding["detail"]>["relationships"]> {
  const pending = new Map<string, Rel[]>();
  for (const r of before) pending.set(r.id, [...(pending.get(r.id) ?? []), r]);
  const added: Rel[] = [];
  const changed: { before: Rel; after: Rel }[] = [];
  for (const r of after) {
    const b = pending.get(r.id)?.shift();
    if (!b) added.push(r);
    else if (b.type !== r.type || b.target !== r.target || b.external !== r.external)
      changed.push({ before: b, after: r });
  }
  return { added, removed: [...pending.values()].flat(), changed };
}

function addTo(map: Map<string, number[]>, name: string, revision: number): void {
  const list = map.get(name);
  if (!list) map.set(name, [revision]);
  else if (list.at(-1) !== revision) list.push(revision);
}

/** `entries` = the history entries from revision 1 up to the revision whose bytes are `current`, in order. */
export function buildPartsReport(original: Uint8Array, current: Uint8Array, entries: HistoryEntry[]): PartsReport {
  const { deltas } = comparePackages(original, current);
  const named = new Map<string, number[]>();
  const written = new Map<string, number[]>();
  for (const entry of entries) {
    // The change records the review panel shows (same choice as `changesOf` in model.ts).
    for (const change of entry.transaction.diff?.changes ?? entry.diff)
      for (const p of change.parts ?? []) addTo(named, norm(p), entry.revision);
    // `parts_written` is not in the typed summary; anything other than a string array counts as nothing written.
    const w: unknown = entry.transaction.parts_written;
    if (Array.isArray(w)) for (const p of w) if (typeof p === "string") addTo(written, norm(p), entry.revision);
  }
  const before = locate(original);
  const after = locate(current);
  const recompressed: string[] = [];
  const findings: PartFinding[] = [];
  const changedNames = new Set<string>();
  for (const d of deltas) {
    const name = norm(d.name);
    if (d.status === "recompressed") {
      recompressed.push(name);
      continue;
    }
    changedNames.add(name);
    const namedBy = named.get(name) ?? [];
    const writtenBy = written.get(name) ?? [];
    const b = before.get(name);
    const a = after.get(name);
    const detail: NonNullable<PartFinding["detail"]> = { sizeBefore: b?.size ?? null, sizeAfter: a?.size ?? null };
    if (name.endsWith(".rels"))
      detail.relationships = compareRels(
        b ? parseRels(partBytes(original, b, name)) : [],
        a ? parseRels(partBytes(current, a, name)) : [],
      );
    findings.push({
      name,
      status: d.status,
      namedBy,
      writtenBy,
      verdict: namedBy.length ? "explained" : writtenBy.length ? "unnamed" : "unreported",
      detail,
    });
  }
  findings.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const claimed = new Set([...named.keys(), ...written.keys()]);
  return {
    revisions: entries.map((e) => e.revision),
    changed: findings.length,
    recompressed,
    findings,
    unexplained: findings.filter((f) => f.verdict !== "explained"),
    claimedButUnchanged: [...claimed].filter((n) => !changedNames.has(n)).sort(),
  };
}

/** Plain description of what a part holds, keyed on its path. */
function partKind(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (name === "[Content_Types].xml") return "the list of content types, which says what kind of file each part is";
  if (base.endsWith(".rels")) {
    const dir = name.slice(0, Math.max(0, name.lastIndexOf("/_rels/")));
    const owner = base === ".rels" ? "" : `${dir ? `${dir}/` : ""}${base.slice(0, -".rels".length)}`;
    return owner
      ? `the link table of ${owner}, which says what that part links to, including outside web addresses`
      : "the package link table, which says where the main document and its properties are";
  }
  if (name.startsWith("docProps/")) return "the document properties, such as title, author and dates";
  if (/(^|\/)styles\.xml$/.test(name)) return "the styles, which hold named fonts, colours and formats";
  if (/(^|\/)sharedStrings\.xml$/.test(name)) return "the shared strings, the table of text that cells refer to";
  if (/(^|\/)calcChain\.xml$/.test(name)) return "the calculation chain, the order in which formulas are recalculated";
  if (/\/media\//.test(name)) return "a media file such as an image";
  if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) return "a worksheet";
  if (name === "xl/workbook.xml") return "the workbook part, which holds the sheet list and defined names";
  if (/^xl\/tables\/[^/]+\.xml$/.test(name)) return "a table definition on a worksheet";
  if (/^ppt\/slides\/[^/]+\.xml$/.test(name)) return "a slide";
  if (name === "ppt/presentation.xml") return "the presentation part, which holds the slide list and slide size";
  if (/^ppt\/notesSlides\/[^/]+\.xml$/.test(name)) return "the speaker notes of a slide";
  if (name === "word/document.xml") return "the main document text";
  if (/^word\/(header|footer)\d*\.xml$/.test(name)) return "a page header or footer";
  if (/(^|\/)comments\d*\.xml$/.test(name)) return "the comments";
  if (/\/charts\/[^/]+\.xml$/.test(name)) return "a chart";
  return "a part of the file";
}

const WHAT: Record<PartFinding["status"], string> = {
  added: "was added",
  removed: "was removed",
  changed: "was changed",
};
const links = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const targets = (rs: Rel[]) => rs.map((r) => r.target).join(", ");

/** Sentences about a link table's changes, the ones a reviewer must not miss first. */
function relSentences(r: NonNullable<NonNullable<PartFinding["detail"]>["relationships"]>): string[] {
  const out: string[] = [];
  for (const { before: b, after: a } of r.changed) {
    if (a.external && !b.external)
      out.push(
        `Link ${a.id} became an outside link: it now points to ${a.target} instead of ${b.target} inside the file.`,
      );
    else if (a.target !== b.target)
      out.push(`Link ${a.id} was retargeted from ${b.target} to ${a.target}${a.external ? ", outside the file" : ""}.`);
    else if (b.external && !a.external) out.push(`Link ${a.id} to ${a.target} no longer points outside the file.`);
    else out.push(`Link ${a.id} to ${a.target} changed its kind from ${b.type} to ${a.type}.`);
  }
  const outside = r.added.filter((x) => x.external);
  const inside = r.added.filter((x) => !x.external);
  if (outside.length)
    out.push(`Its link table gained ${links(outside.length, "outside link")} to ${targets(outside)}.`);
  if (inside.length) out.push(`It gained ${links(inside.length, "link")} inside the file, to ${targets(inside)}.`);
  if (r.removed.length) out.push(`It lost ${links(r.removed.length, "link")}, to ${targets(r.removed)}.`);
  return out;
}

/** One plain sentence per unexplained finding, for a reviewer who does not know OOXML:
 *  what kind of part it is, what happened to it, and why it is flagged; then what its links did, when known.
 *  The reason followed by the headline (`describeFindingParts`). */
export function describeFinding(f: PartFinding): string {
  const { headline, reason } = describeFindingParts(f);
  return headline ? `${reason} ${headline}` : reason;
}

/** The finding in two parts for the panel: `headline`, the consequence a reviewer must not miss
 *  (what its links did, else its size change; empty for an explained part), and `reason`, the
 *  part and why it is flagged. */
export function describeFindingParts(f: PartFinding): { headline: string; reason: string } {
  const head = `${f.name} (${partKind(f.name)}) ${WHAT[f.status]}`;
  const reason =
    f.verdict === "explained"
      ? `${head}, as named by the reviewed change${f.namedBy.length > 1 ? "s" : ""} at revision ${f.namedBy.join(", ")}.`
      : f.verdict === "unnamed"
        ? `${head}: the engine reported writing it at revision ${f.writtenBy.join(", ")}, but no change you reviewed names it, so ${f.status === "added" ? "its contents were" : "what changed in it was"} not shown to you.`
        : `${head}, but no change you reviewed names it and the engine never reported writing it, so the file was altered outside the reviewed edits.`;
  const rels = f.detail?.relationships;
  if (rels) return { headline: relSentences(rels).join(" "), reason };
  const d = f.detail;
  if (!d || f.verdict === "explained") return { headline: "", reason };
  const headline =
    d.sizeBefore === null
      ? `It holds ${d.sizeAfter} bytes.`
      : d.sizeAfter === null
        ? `It held ${d.sizeBefore} bytes.`
        : `It went from ${d.sizeBefore} to ${d.sizeAfter} bytes.`;
  return { headline, reason };
}
