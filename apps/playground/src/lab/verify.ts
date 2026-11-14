/**
 * Package verifier. Reads two ZIP packages (DOCX, XLSX, PPTX) and says, member by
 * member, how the second differs from the first. It uses no engine code and no dependencies:
 * only the ZIP format, `crypto.subtle` and `DecompressionStream`.
 */
import type { MemberDelta, MemberInfo, MemberVerdict, PackageDelta, PackageInfo } from "./types.ts";

export type PackageErrorCode = "truncated" | "not-a-zip" | "zip64-unsupported" | "unsupported" | "malformed";

/** Every refusal to read or compare a package is one of these. */
export class PackageError extends Error {
  readonly code: PackageErrorCode;
  constructor(code: PackageErrorCode, message: string) {
    super(message);
    this.name = "PackageError";
    this.code = code;
  }
}

function fail(code: PackageErrorCode, message: string): never {
  throw new PackageError(code, message);
}

/** `crypto.subtle` and the stream APIs want ArrayBuffer-backed views; copy only when not. */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> =>
  b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", own(bytes)));
  return Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// ZIP structure (APPNOTE.TXT 4.3: local header, central directory, end record)
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export async function readPackage(bytes: Uint8Array): Promise<PackageInfo> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const within = (at: number, length: number, what: string) => {
    if (at + length > bytes.length) fail("truncated", `${what} runs past the end of the file (${bytes.length} bytes)`);
  };

  // The end record is the last 22 bytes plus a comment of up to 65535 bytes: search backwards.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (u32(at) === SIG_END && at + 22 + u16(at + 20) <= bytes.length) { end = at; break; }
  }
  if (end < 0) {
    if (bytes.length >= 4 && u32(0) === SIG_LOCAL) fail("truncated", "no end-of-central-directory record: the archive is cut short");
    fail("not-a-zip", "no end-of-central-directory record: this is not a ZIP package");
  }
  const count = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if ((end >= 20 && u32(end - 20) === SIG_ZIP64_LOCATOR) || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail("zip64-unsupported", "the package uses ZIP64 records, which this verifier does not read");
  }
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== count) fail("unsupported", "multi-disk archives are not supported");
  if (cdOffset + cdSize > end) fail("truncated", "the central directory runs past the end record");

  const decoder = new TextDecoder("utf-8");
  const seen = new Set<string>();
  const entries: Omit<MemberInfo, "streamSha256">[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    within(at, 46, `central directory entry ${i}`);
    if (u32(at) !== SIG_CENTRAL) fail("malformed", `central directory entry ${i} has a bad signature`);
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc32 = u32(at + 16);
    const compressedSize = u32(at + 20);
    const size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const headerOffset = u32(at + 42);
    within(at, 46 + nameLength + extraLength + u16(at + 32), `central directory entry ${i}`);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = decoder.decode(rawName);
    if (compressedSize === 0xffffffff || size === 0xffffffff || headerOffset === 0xffffffff) {
      fail("zip64-unsupported", `member ${name} uses ZIP64 sizes, which this verifier does not read`);
    }
    if (flags & 1) fail("unsupported", `member ${name} is encrypted`);
    if (seen.has(name)) fail("malformed", `member ${name} appears twice`);
    seen.add(name);

    within(headerOffset, 30, `local header of ${name}`);
    if (u32(headerOffset) !== SIG_LOCAL) fail("malformed", `local header of ${name} has a bad signature`);
    const localName = bytes.subarray(headerOffset + 30, headerOffset + 30 + u16(headerOffset + 26));
    if (localName.length !== rawName.length || localName.some((b, k) => b !== rawName[k])) {
      fail("malformed", `local header of ${name} names a different member`);
    }
    const dataOffset = headerOffset + 30 + u16(headerOffset + 26) + u16(headerOffset + 28);
    within(dataOffset, compressedSize, `stream of ${name}`);
    entries.push({ name, method, crc32, compressedSize, size, headerOffset, dataOffset });
    at += 46 + nameLength + extraLength + u16(at + 32);
  }

  const members = await Promise.all(
    entries.map(async (e) => ({
      ...e,
      streamSha256: await sha256Hex(bytes.subarray(e.dataOffset, e.dataOffset + e.compressedSize)),
    })),
  );
  return { bytes: bytes.length, sha256: await sha256Hex(bytes), members };
}

/** Uncompressed bytes of a member, or null for a method other than stored (0) or deflate (8).
 * Inflation stops as soon as the output exceeds the declared size. */
async function inflate(archive: Uint8Array, m: MemberInfo): Promise<Uint8Array | null> {
  const raw = archive.subarray(m.dataOffset, m.dataOffset + m.compressedSize);
  if (m.method === 0) {
    if (raw.length !== m.size) fail("malformed", `${m.name} is stored with ${raw.length} bytes, its header says ${m.size}`);
    return raw;
  }
  if (m.method !== 8) return null;
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(own(raw)).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > m.size) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    fail("malformed", `the deflate stream of ${m.name} is corrupt`);
  }
  if (total !== m.size) fail("malformed", `${m.name} inflates to ${total} bytes, its header says ${m.size}`);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// XML canonicalisation. Two parts are `xml-equivalent` when these strings are equal.
// Rules: the XML declaration and a byte order mark are dropped; line ends become "\n";
// attributes (namespace declarations included) are sorted by qualified name; quote style,
// character references and `<a/>` against `<a></a>` are normalised; CDATA becomes text; a
// whitespace-only text node is dropped only between elements of an element-only parent with
// no `xml:space="preserve"` in scope; a prefixed namespace declaration (`xmlns:p`, never the
// default `xmlns`) is dropped only when `p` is provably unused in the whole part: no element or
// attribute name has prefix `p`, no attribute value, text, comment or processing instruction
// contains `p:`, and no attribute value or text has `p` as a whitespace-separated token (as in
// `mc:Ignorable="p"`). Prefixes are never renamed or resolved. All other text, comments and
// processing instructions are kept as written. A DOCTYPE, a malformed part or a non-UTF-8 part
// is not canonicalised.
// ---------------------------------------------------------------------------

type XmlNode = { name: string; attrs: [string, string][]; kids: (XmlNode | { text: string } | { raw: string })[] };

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const BARE_AMP = /&(?!(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);)/;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const WS = /^[ \t\n\r]*$/;
const TAG = /<([^\s/>="']+)/y;
const ATTR = /\s*([^\s/>="']+)\s*=\s*("([^"<]*)"|'([^'<]*)')|\s*(\/?>)/y;

function decodeRefs(raw: string): string | null {
  if (BARE_AMP.test(raw)) return null;
  try {
    return raw.replace(ENTITY, (_, ref: string) =>
      ref[0] !== "#" ? NAMED[ref]! : String.fromCodePoint(ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)));
  } catch {
    return null; // a character reference outside Unicode
  }
}

function parseXml(src: string): XmlNode | null {
  const s = src.replace(/\r\n?/g, "\n");
  const top: XmlNode = { name: "", attrs: [], kids: [] };
  const stack = [top];
  const addText = (text: string) => {
    const kids = stack.at(-1)!.kids;
    const last = kids.at(-1);
    if (last && "text" in last) last.text += text;
    else kids.push({ text });
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "<") {
      const next = s.indexOf("<", i);
      const text = decodeRefs(s.slice(i, next < 0 ? s.length : next));
      if (text === null) return null;
      addText(text);
      i = next < 0 ? s.length : next;
    } else if (s.startsWith("<?", i)) {
      const close = s.indexOf("?>", i);
      if (close < 0) return null;
      const body = s.slice(i + 2, close);
      const isDeclaration = /^xml(\s|$)/.test(body) && top.kids.every((k) => "text" in k && WS.test(k.text));
      if (!isDeclaration) stack.at(-1)!.kids.push({ raw: `<?${body}?>` });
      i = close + 2;
    } else if (s.startsWith("<!--", i)) {
      const close = s.indexOf("-->", i + 4);
      if (close < 0) return null;
      stack.at(-1)!.kids.push({ raw: s.slice(i, close + 3) });
      i = close + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const close = s.indexOf("]]>", i + 9);
      if (close < 0 || stack.length === 1) return null;
      addText(s.slice(i + 9, close));
      i = close + 3;
    } else if (s.startsWith("<!", i)) {
      return null; // DOCTYPE: entity definitions could change meaning, so refuse.
    } else if (s.startsWith("</", i)) {
      const close = s.indexOf(">", i);
      if (close < 0 || stack.length === 1 || s.slice(i + 2, close).trim() !== stack.at(-1)!.name) return null;
      stack.pop();
      i = close + 1;
    } else {
      TAG.lastIndex = i;
      const tag = TAG.exec(s);
      if (!tag) return null;
      const node: XmlNode = { name: tag[1]!, attrs: [], kids: [] };
      i = TAG.lastIndex;
      for (;;) {
        ATTR.lastIndex = i;
        const m = ATTR.exec(s);
        if (!m) return null;
        i = ATTR.lastIndex;
        if (m[5]) {
          if (stack.length === 1 && top.kids.some((k) => "name" in k)) return null; // second root
          stack.at(-1)!.kids.push(node);
          if (m[5] === ">") stack.push(node);
          break;
        }
        const value = decodeRefs((m[3] ?? m[4]!).replace(/[\t\n]/g, " "));
        if (value === null || node.attrs.some(([n]) => n === m[1])) return null;
        node.attrs.push([m[1]!, value]);
      }
    }
  }
  if (stack.length !== 1) return null;
  const roots = top.kids.filter((k) => "name" in k);
  if (roots.length !== 1 || top.kids.some((k) => "text" in k && !WS.test(k.text))) return null;
  return top;
}

const escText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");

/** Prefixes declared with `xmlns:p` somewhere in the part and used nowhere in it (rules above). */
function unusedPrefixes(top: XmlNode): Set<string> {
  const declared = new Set<string>();
  const named = new Set<string>();
  const strings: string[] = [];
  const visit = (node: XmlNode) => {
    if (node.name.includes(":")) named.add(node.name.slice(0, node.name.indexOf(":")));
    for (const [n, v] of node.attrs) {
      if (n.startsWith("xmlns:")) { declared.add(n.slice(6)); continue; }
      if (n === "xmlns") continue;
      if (n.includes(":")) named.add(n.slice(0, n.indexOf(":")));
      strings.push(v);
    }
    for (const kid of node.kids) {
      if ("name" in kid) visit(kid);
      else strings.push("text" in kid ? kid.text : kid.raw);
    }
  };
  visit(top);
  const tokens = new Set(strings.flatMap((v) => v.split(/[ \t\n\r]+/)));
  return new Set([...declared].filter((p) => !named.has(p) && !tokens.has(p) && !strings.some((v) => v.includes(`${p}:`))));
}

function serialise(node: XmlNode, preserve: boolean, unused: Set<string>): string {
  const space = node.attrs.find(([n]) => n === "xml:space")?.[1];
  const keep = space === undefined ? preserve : space === "preserve";
  const elementOnly = node.kids.some((k) => "name" in k) && !node.kids.some((k) => "text" in k && !WS.test(k.text));
  const attrs = node.attrs.filter(([n]) => !(n.startsWith("xmlns:") && unused.has(n.slice(6)))).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let out = node.name ? `<${node.name}${attrs.map(([n, v]) => ` ${n}="${escText(v).replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;")}"`).join("")}>` : "";
  for (const kid of node.kids) {
    if ("name" in kid) out += serialise(kid, keep, unused);
    else if ("raw" in kid) out += kid.raw;
    else if (!(WS.test(kid.text) && (elementOnly || !node.name) && !keep)) out += escText(kid.text);
  }
  return node.name ? `${out}</${node.name}>` : out;
}

/** Canonical form of an XML part, or null when the part is not canonicalised (see rules above). */
export function canonicalXml(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const tree = parseXml(text);
  return tree && serialise(tree, false, unusedPrefixes(tree));
}

const XML_PART = /\.(xml|rels|vml)$/i;

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

async function verdictFor(a: Uint8Array, m: MemberInfo, b: Uint8Array, n: MemberInfo): Promise<MemberVerdict> {
  if (m.method === n.method && m.compressedSize === n.compressedSize && m.streamSha256 === n.streamSha256) return "identical-stream";
  const sameHeader = m.crc32 === n.crc32 && m.size === n.size;
  if (!sameHeader && !XML_PART.test(m.name)) return "changed";
  const [x, y] = await Promise.all([inflate(a, m), inflate(b, n)]);
  if (!x || !y) return "changed";
  if (sameHeader && x.length === y.length && x.every((v, i) => v === y[i])) return "same-bytes-recompressed";
  if (XML_PART.test(m.name)) {
    const cx = canonicalXml(x);
    if (cx !== null && cx === canonicalXml(y)) return "xml-equivalent";
  }
  return "changed";
}

export async function comparePackages(before: Uint8Array, after: Uint8Array): Promise<PackageDelta> {
  const [pa, pb] = await Promise.all([readPackage(before), readPackage(after)]);
  const byName = new Map(pb.members.map((m) => [m.name, m]));
  const verdicts: MemberDelta[] = [];
  for (const m of pa.members) {
    const n = byName.get(m.name);
    const verdict = n ? await verdictFor(before, m, after, n) : "removed";
    verdicts.push({ name: m.name, verdict, bytesBefore: m.compressedSize, bytesAfter: n?.compressedSize ?? 0 });
  }
  const names = new Set(pa.members.map((m) => m.name));
  for (const n of pb.members) {
    if (!names.has(n.name)) verdicts.push({ name: n.name, verdict: "added", bytesBefore: 0, bytesAfter: n.compressedSize });
  }
  const counts: Record<MemberVerdict, number> = {
    "identical-stream": 0, "same-bytes-recompressed": 0, "xml-equivalent": 0, changed: 0, removed: 0, added: 0,
  };
  let untouched = 0;
  let total = 0;
  for (const v of verdicts) {
    counts[v.verdict]++;
    total += v.bytesBefore;
    if (v.verdict === "identical-stream") untouched += v.bytesBefore;
  }
  return { before: pa, after: pb, verdicts, counts, untouchedByteShare: total === 0 ? 0 : untouched / total };
}
