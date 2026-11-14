// A dependency-free PDF text reader. The cross-reference table is never trusted: the file is scanned for `N G obj`
// objects (object streams expanded), so a damaged or hand-built file reads like a clean one. Page text comes from the
// content streams (Flate, ASCIIHex and ASCII85 filters), decoded through the font's ToUnicode CMap or its simple
// encoding. Encrypted files are refused; images, other filters and everything executable are skipped, never run.
import { constants, inflateSync } from "node:zlib";
import type { Block, CellEntry, ReadableDocument, SearchUnit } from "./model.ts";
import { ReadError } from "./model.ts";

/** Largest file read. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
/** Pages read; later ones are dropped. */
const MAX_PAGES = 5000;
/** Inflated bytes of every stream decoded from one file; once spent, later streams contribute nothing. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
/** Text kept for one page, and for the whole file, in characters. */
const MAX_PAGE_CHARS = 4 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024;
/** Content stream operators run for the whole file, so nested forms can not multiply work without end. */
const MAX_OPERATORS = 50_000_000;
/** Form XObjects entered below a page. */
const MAX_FORM_DEPTH = 4;
/** Nesting of arrays and dictionaries, and of `/Parent` and reference chains. */
const MAX_NESTING = 64;
/** Mappings kept from one ToUnicode CMap. */
const MAX_CMAP_ENTRIES = 200_000;
/** Objects expanded from one object stream. */
const MAX_OBJECT_STREAM_OBJECTS = 100_000;
/** Rows of a predictor-encoded stream are at most this wide. */
const MAX_PREDICTOR_ROW_BYTES = 16 * 1024 * 1024;
/** A page line moves when the text origin shifts by more than this many user space units. */
const LINE_EPSILON = 0.001;
/** A run on the same line gets a space when its origin jumps forward by more than this share of the font size. */
const GAP_RATIO = 0.2;
/** A TJ adjustment below this many thousandths of an em is a word space. */
const WORD_GAP = -200;

// ---------------------------------------------------------------------------------------------------------------------
// Objects and the lexer

type PdfName = { readonly kind: "name"; readonly value: string };
type PdfString = { readonly kind: "string"; readonly value: string };
type PdfRef = { readonly kind: "ref"; readonly num: number };
type PdfKeyword = { readonly kind: "keyword"; readonly value: string };
type PdfArray = { readonly kind: "array"; readonly items: Value[] };
/** `stream` is the byte span of the data of a stream object, set by the file scan. */
type PdfDict = { readonly kind: "dict"; readonly entries: Map<string, Value>; stream?: { start: number; end: number } };
type Value = null | boolean | number | PdfName | PdfString | PdfRef | PdfKeyword | PdfArray | PdfDict;

function isDict(value: Value | undefined): value is PdfDict {
  return typeof value === "object" && value !== null && value.kind === "dict";
}
function isArray(value: Value | undefined): value is PdfArray {
  return typeof value === "object" && value !== null && value.kind === "array";
}
function isName(value: Value | undefined): value is PdfName {
  return typeof value === "object" && value !== null && value.kind === "name";
}
function isString(value: Value | undefined): value is PdfString {
  return typeof value === "object" && value !== null && value.kind === "string";
}
function isRef(value: Value | undefined): value is PdfRef {
  return typeof value === "object" && value !== null && value.kind === "ref";
}
function isKeyword(value: Value | undefined): value is PdfKeyword {
  return typeof value === "object" && value !== null && value.kind === "keyword";
}
function nameValue(value: Value | undefined): string | undefined {
  return isName(value) ? value.value : undefined;
}
function asDict(value: Value | undefined): PdfDict | undefined {
  return isDict(value) ? value : undefined;
}

/** A syntax error the lexer can recover from by dropping the object or stream that holds it. */
class PdfSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfSyntaxError";
  }
}

const SPACE = 1;
const DELIMITER = 2;
const CLASS = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) CLASS[code] = SPACE;
for (const char of "()<>[]{}/%") CLASS[char.charCodeAt(0)] = DELIMITER;

function isSpaceCode(code: number): boolean {
  return CLASS[code] === SPACE;
}
function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/** Words that end an object whose closing delimiter is missing. */
const STRUCTURAL: Record<string, true> = { endobj: true, stream: true, endstream: true };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const INTEGER = /^\d+$/;
const CLOSE_DICT: PdfKeyword = { kind: "keyword", value: ">>" };
const CLOSE_ARRAY: PdfKeyword = { kind: "keyword", value: "]" };

/** Reads PDF syntax from a latin1 string, one byte per character. Strings come back as byte strings. */
class Lexer {
  readonly src: string;
  pos: number;

  constructor(src: string, pos = 0) {
    this.src = src;
    this.pos = pos;
  }

  /** Skip whitespace and comments. */
  skip(): void {
    const src = this.src;
    let pos = this.pos;
    for (;;) {
      const code = src.charCodeAt(pos);
      if (isSpaceCode(code)) {
        pos += 1;
      } else if (code === 0x25) {
        while (pos < src.length) {
          const next = src.charCodeAt(pos);
          if (next === 10 || next === 13) break;
          pos += 1;
        }
      } else {
        break;
      }
    }
    this.pos = pos;
  }

  /** The next value; a bare word (an operator, `endobj`, a stray closer) comes back as a keyword, the end of the source
   * as `undefined`. With `refs`, `N G R` reads as one reference. */
  value(refs: boolean, depth = 0): Value | undefined {
    if (depth > MAX_NESTING) throw new PdfSyntaxError("arrays and dictionaries nest too deeply");
    this.skip();
    const src = this.src;
    if (this.pos >= src.length) return undefined;
    const code = src.charCodeAt(this.pos);
    switch (code) {
      case 0x2f:
        return this.#name();
      case 0x28:
        return this.#literal();
      case 0x3c:
        if (src.charCodeAt(this.pos + 1) === 0x3c) {
          this.pos += 2;
          return this.#dict(refs, depth);
        }
        return this.#hex();
      case 0x5b:
        this.pos += 1;
        return this.#array(refs, depth);
      case 0x3e:
        if (src.charCodeAt(this.pos + 1) === 0x3e) {
          this.pos += 2;
          return CLOSE_DICT;
        }
        this.pos += 1;
        return { kind: "keyword", value: ">" };
      case 0x5d:
        this.pos += 1;
        return CLOSE_ARRAY;
      case 0x29:
      case 0x7b:
      case 0x7d:
        this.pos += 1;
        return { kind: "keyword", value: String.fromCharCode(code) };
    }
    const start = this.pos;
    let end = start;
    while (end < src.length && CLASS[src.charCodeAt(end)] === 0) end += 1;
    this.pos = end;
    const word = src.slice(start, end);
    if (NUMBER.test(word)) {
      const number = Number(word);
      if (refs && INTEGER.test(word)) return this.#reference(number) ?? number;
      return number;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { kind: "keyword", value: word };
  }

  /** `G R` after the integer `num` just read. */
  #reference(num: number): PdfRef | undefined {
    const src = this.src;
    let at = this.pos;
    while (isSpaceCode(src.charCodeAt(at))) at += 1;
    const generation = at;
    while (isDigit(src.charCodeAt(at))) at += 1;
    if (at === generation || !isSpaceCode(src.charCodeAt(at))) return undefined;
    while (isSpaceCode(src.charCodeAt(at))) at += 1;
    if (src.charCodeAt(at) !== 0x52) return undefined;
    const after = at + 1;
    if (after < src.length && CLASS[src.charCodeAt(after)] === 0) return undefined;
    this.pos = after;
    return { kind: "ref", num };
  }

  #name(): PdfName {
    const src = this.src;
    const start = this.pos + 1;
    let end = start;
    while (end < src.length && CLASS[src.charCodeAt(end)] === 0) end += 1;
    this.pos = end;
    const raw = src.slice(start, end);
    const value = raw.includes("#") ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : raw;
    return { kind: "name", value };
  }

  #literal(): PdfString {
    const src = this.src;
    let depth = 1;
    let out = "";
    let at = this.pos + 1;
    while (at < src.length) {
      const code = src.charCodeAt(at++);
      if (code === 0x5c) {
        const escaped = src.charCodeAt(at++);
        switch (escaped) {
          case 0x6e:
            out += "\n";
            break;
          case 0x72:
            out += "\r";
            break;
          case 0x74:
            out += "\t";
            break;
          case 0x62:
            out += "\b";
            break;
          case 0x66:
            out += "\f";
            break;
          case 0x0d:
            if (src.charCodeAt(at) === 0x0a) at += 1;
            break;
          case 0x0a:
            break;
          default:
            if (escaped >= 0x30 && escaped <= 0x37) {
              let octal = escaped - 0x30;
              for (let digits = 1; digits < 3; digits++) {
                const next = src.charCodeAt(at);
                if (next < 0x30 || next > 0x37) break;
                octal = octal * 8 + next - 0x30;
                at += 1;
              }
              out += String.fromCharCode(octal & 0xff);
            } else if (!Number.isNaN(escaped)) {
              out += String.fromCharCode(escaped);
            }
        }
      } else if (code === 0x28) {
        depth += 1;
        out += "(";
      } else if (code === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        out += ")";
      } else if (code === 0x0d) {
        if (src.charCodeAt(at) === 0x0a) at += 1;
        out += "\n";
      } else {
        out += String.fromCharCode(code);
      }
    }
    this.pos = at;
    return { kind: "string", value: out };
  }

  #hex(): PdfString {
    const src = this.src;
    const close = src.indexOf(">", this.pos + 1);
    const stop = close < 0 ? src.length : close;
    let out = "";
    let high = -1;
    for (let at = this.pos + 1; at < stop; at++) {
      const digit = hexDigit(src.charCodeAt(at));
      if (digit < 0) continue;
      if (high < 0) {
        high = digit;
      } else {
        out += String.fromCharCode(high * 16 + digit);
        high = -1;
      }
    }
    if (high >= 0) out += String.fromCharCode(high * 16);
    this.pos = close < 0 ? src.length : close + 1;
    return { kind: "string", value: out };
  }

  #array(refs: boolean, depth: number): PdfArray {
    const items: Value[] = [];
    for (;;) {
      const item = this.value(refs, depth + 1);
      if (item === undefined) break;
      if (isKeyword(item)) {
        if (item.value === "]") break;
        if (STRUCTURAL[item.value] === true) {
          this.pos -= item.value.length;
          break;
        }
        continue;
      }
      items.push(item);
    }
    return { kind: "array", items };
  }

  #dict(refs: boolean, depth: number): PdfDict {
    const entries = new Map<string, Value>();
    for (;;) {
      const key = this.value(refs, depth + 1);
      if (key === undefined || (isKeyword(key) && key.value === ">>")) break;
      if (isKeyword(key) && STRUCTURAL[key.value] === true) {
        this.pos -= key.value.length;
        break;
      }
      if (!isName(key)) continue;
      const item = this.value(refs, depth + 1);
      if (item === undefined) break;
      if (isKeyword(item)) {
        if (item.value === ">>") break;
        if (STRUCTURAL[item.value] === true) {
          this.pos -= item.value.length;
          break;
        }
        continue;
      }
      entries.set(key.value, item);
    }
    return { kind: "dict", entries };
  }
}

/** The bytes as a string of one character per byte. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 8192) out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stream filters

function asciiHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array((data.length >> 1) + 1);
  let length = 0;
  let high = -1;
  for (let at = 0; at < data.length; at++) {
    const code = data[at] ?? 0;
    if (code === 0x3e) break;
    const digit = hexDigit(code);
    if (digit < 0) continue;
    if (high < 0) {
      high = digit;
    } else {
      out[length++] = high * 16 + digit;
      high = -1;
    }
  }
  if (high >= 0) out[length++] = high * 16;
  return out.subarray(0, length);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.min(data.length * 4 + 4, MAX_INFLATED_BYTES));
  const group = [0, 0, 0, 0, 0];
  let length = 0;
  let count = 0;
  for (let at = data[0] === 0x3c && data[1] === 0x7e ? 2 : 0; at < data.length; at++) {
    const code = data[at] ?? 0;
    if (code === 0x7e) break;
    if (isSpaceCode(code)) continue;
    if (code === 0x7a && count === 0) {
      if (length + 4 > out.length) break;
      length += 4;
      continue;
    }
    if (code < 0x21 || code > 0x75) continue;
    group[count++] = code - 0x21;
    if (count < 5) continue;
    if (length + 4 > out.length) break;
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    value >>>= 0;
    out[length++] = value >>> 24;
    out[length++] = (value >>> 16) & 0xff;
    out[length++] = (value >>> 8) & 0xff;
    out[length++] = value & 0xff;
    count = 0;
  }
  if (count > 1) {
    for (let at = count; at < 5; at++) group[at] = 84;
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    value >>>= 0;
    const tail = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let at = 0; at < count - 1 && length < out.length; at++) out[length++] = tail[at] ?? 0;
  }
  return out.subarray(0, length);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** Undo a `/Predictor`: 2 is the TIFF horizontal difference (8 bits per component), 10 to 15 are the PNG row filters.
 * `null` when the parameters name a layout this reader does not decode. */
function unpredict(data: Uint8Array, predictor: number, colors: number, bits: number, columns: number): Uint8Array | null {
  if (predictor <= 1) return data;
  if (!Number.isInteger(colors) || !Number.isInteger(bits) || !Number.isInteger(columns) || colors < 1 || bits < 1 || columns < 1) return null;
  const rowBytes = Math.ceil((colors * bits * columns) / 8);
  if (rowBytes > MAX_PREDICTOR_ROW_BYTES) return null;
  const pixel = Math.max(1, Math.ceil((colors * bits) / 8));
  if (predictor === 2) {
    if (bits !== 8) return null;
    const out = data.slice();
    for (let row = 0; row < out.length; row += rowBytes) {
      const end = Math.min(row + rowBytes, out.length);
      for (let at = row + colors; at < end; at++) out[at] = ((out[at] ?? 0) + (out[at - colors] ?? 0)) & 0xff;
    }
    return out;
  }
  if (predictor < 10 || predictor > 15) return null;
  const stride = rowBytes + 1;
  const full = Math.floor(data.length / stride);
  const rest = data.length - full * stride;
  const rows = full + (rest > 1 ? 1 : 0);
  const out = new Uint8Array(full * rowBytes + (rest > 1 ? rest - 1 : 0));
  for (let row = 0; row < rows; row++) {
    const source = row * stride;
    const target = row * rowBytes;
    const above = target - rowBytes;
    const tag = data[source] ?? 0;
    const width = row < full ? rowBytes : rest - 1;
    for (let at = 0; at < width; at++) {
      const raw = data[source + 1 + at] ?? 0;
      const left = at >= pixel ? (out[target + at - pixel] ?? 0) : 0;
      const up = row > 0 ? (out[above + at] ?? 0) : 0;
      const upLeft = row > 0 && at >= pixel ? (out[above + at - pixel] ?? 0) : 0;
      let predicted = 0;
      if (tag === 1) predicted = left;
      else if (tag === 2) predicted = up;
      else if (tag === 3) predicted = (left + up) >> 1;
      else if (tag === 4) predicted = paeth(left, up, upLeft);
      out[target + at] = (raw + predicted) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The file

type PdfObject = { value: Value; seq: number };
type PageRef = { dict: PdfDict; resources: Value | undefined; mediaBox: Value | undefined };

/** Every object of one file, found by scanning rather than through the cross-reference table. A later definition of an
 * object number wins, which is how incremental updates work. */
class PdfFile {
  readonly bytes: Uint8Array;
  readonly src: string;
  readonly objects = new Map<number, PdfObject>();
  readonly #trailers: PdfDict[] = [];
  readonly #objectStreams: { num: number; seq: number }[] = [];
  #inflated = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.src = latin1(bytes);
    this.#scan();
  }

  /** Follow references to the value they name; `undefined` for a missing object or a chain that does not end. */
  resolve(value: Value | undefined): Value | undefined {
    let current = value;
    for (let hops = 0; isRef(current); hops++) {
      if (hops >= MAX_NESTING) return undefined;
      current = this.objects.get(current.num)?.value;
    }
    return current;
  }

  get(dict: PdfDict, key: string): Value | undefined {
    return this.resolve(dict.entries.get(key));
  }

  dictOf(dict: PdfDict, key: string): PdfDict | undefined {
    return asDict(this.get(dict, key));
  }

  arrayOf(dict: PdfDict, key: string): PdfArray | undefined {
    const value = this.get(dict, key);
    return isArray(value) ? value : undefined;
  }

  numberOf(dict: PdfDict | undefined, key: string): number | undefined {
    if (dict === undefined) return undefined;
    const value = this.get(dict, key);
    return typeof value === "number" ? value : undefined;
  }

  nameOf(dict: PdfDict, key: string): string | undefined {
    return nameValue(this.get(dict, key));
  }

  /** A six number array, as `/Matrix` is. */
  matrixOf(dict: PdfDict, key: string): Matrix | undefined {
    const array = this.arrayOf(dict, key);
    return array !== undefined && array.items.length === 6 ? matrixFrom(array.items.map((item) => this.resolve(item))) : undefined;
  }

  /** Whether a trailer or cross-reference stream carries an `/Encrypt` entry. */
  encrypted(): boolean {
    return this.#trailers.some((trailer) => {
      const entry = trailer.entries.get("Encrypt");
      return entry !== undefined && entry !== null;
    });
  }

  #scan(): void {
    const src = this.src;
    const pendingLengths: { dict: PdfDict; length: PdfRef }[] = [];
    const objectStart = /(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj(?![A-Za-z0-9])|trailer(?![A-Za-z0-9])/g;
    for (let found = objectStart.exec(src); found !== null; found = objectStart.exec(src)) {
      const lexer = new Lexer(src, objectStart.lastIndex);
      let value: Value | undefined;
      try {
        value = lexer.value(true);
      } catch (error) {
        // A damaged object is dropped; the scan goes on from the end of its header.
        if (error instanceof PdfSyntaxError) continue;
        throw error;
      }
      if (found[2] === undefined) {
        if (isDict(value)) this.#trailers.push(value);
        objectStart.lastIndex = lexer.pos;
        continue;
      }
      if (value === undefined || isKeyword(value)) continue;
      objectStart.lastIndex = lexer.pos;
      if (isDict(value)) {
        lexer.skip();
        if (src.startsWith("stream", lexer.pos)) {
          let start = lexer.pos + 6;
          if (src.charCodeAt(start) === 0x0d) start += src.charCodeAt(start + 1) === 0x0a ? 2 : 1;
          else if (src.charCodeAt(start) === 0x0a) start += 1;
          const length = value.entries.get("Length");
          let end = -1;
          let resume = -1;
          if (typeof length === "number" && Number.isInteger(length) && length >= 0) {
            const at = this.#endstreamAt(start + length);
            if (at >= 0) {
              end = start + length;
              resume = at + 9;
            }
          } else if (isRef(length)) {
            pendingLengths.push({ dict: value, length });
          }
          if (end < 0) {
            const at = src.indexOf("endstream", start);
            if (at < 0) {
              end = src.length;
              resume = src.length;
            } else {
              end = at;
              if (end > start && src.charCodeAt(end - 1) === 0x0a) end -= 1;
              if (end > start && src.charCodeAt(end - 1) === 0x0d) end -= 1;
              resume = at + 9;
            }
          }
          value.stream = { start, end };
          objectStart.lastIndex = resume;
        }
        const type = nameValue(value.entries.get("Type"));
        if (type === "XRef") this.#trailers.push(value);
        else if (type === "ObjStm") this.#objectStreams.push({ num: Number(found[1]), seq: found.index });
      }
      this.objects.set(Number(found[1]), { value, seq: found.index });
    }
    // An indirect /Length is known only now; trust it when it lands exactly on `endstream`.
    for (const { dict, length } of pendingLengths) {
      const size = this.resolve(length);
      const span = dict.stream;
      if (span === undefined || typeof size !== "number" || !Number.isInteger(size) || size < 0) continue;
      if (this.#endstreamAt(span.start + size) >= 0) span.end = span.start + size;
    }
  }

  /** The index of `endstream` at `from`, allowing the line end before it; -1 when it is not there. */
  #endstreamAt(from: number): number {
    let at = from;
    while (at < from + 4 && isSpaceCode(this.src.charCodeAt(at))) at += 1;
    return this.src.startsWith("endstream", at) ? at : -1;
  }

  /** Add the objects held in object streams (PDF 1.5). Later in the file wins over earlier, as for plain objects. */
  expand(): void {
    for (const { num, seq } of this.#objectStreams) {
      const dict = this.objects.get(num)?.value;
      if (!isDict(dict) || dict.stream === undefined) continue;
      const count = this.numberOf(dict, "N");
      const first = this.numberOf(dict, "First");
      if (count === undefined || first === undefined || !Number.isInteger(count) || !Number.isInteger(first)) continue;
      if (count < 0 || count > MAX_OBJECT_STREAM_OBJECTS || first < 0) continue;
      const data = this.decode(dict);
      if (data === null) continue;
      const text = latin1(data);
      if (first > text.length) continue;
      const header = new Lexer(text);
      try {
        for (let index = 0; index < count; index++) {
          const target = header.value(false);
          const offset = header.value(false);
          if (typeof target !== "number" || typeof offset !== "number") break;
          let value: Value | undefined;
          try {
            value = new Lexer(text, first + offset).value(true);
          } catch (error) {
            if (error instanceof PdfSyntaxError) continue;
            throw error;
          }
          if (value === undefined || isKeyword(value)) continue;
          const existing = this.objects.get(target);
          if (existing === undefined || existing.seq < seq) this.objects.set(target, { value, seq });
        }
      } catch (error) {
        if (!(error instanceof PdfSyntaxError)) throw error;
      }
    }
  }

  /** The decoded bytes of a stream object, or `null` when it holds no stream, uses a filter this reader does not
   * decode, is damaged, or would pass the inflate budget. */
  decode(dict: PdfDict): Uint8Array | null {
    const span = dict.stream;
    if (span === undefined) return null;
    let data: Uint8Array = this.bytes.subarray(span.start, span.end);
    for (const { name, parms } of this.#filters(dict)) {
      if (name === "FlateDecode" || name === "Fl") {
        const inflated = this.#inflate(data);
        if (inflated === null) return null;
        const plain = unpredict(
          inflated,
          this.numberOf(parms, "Predictor") ?? 1,
          this.numberOf(parms, "Colors") ?? 1,
          this.numberOf(parms, "BitsPerComponent") ?? 8,
          this.numberOf(parms, "Columns") ?? 1,
        );
        if (plain === null) return null;
        data = plain;
      } else if (name === "ASCIIHexDecode" || name === "AHx") {
        data = asciiHex(data);
      } else if (name === "ASCII85Decode" || name === "A85") {
        data = ascii85(data);
      } else {
        return null;
      }
    }
    return data;
  }

  #filters(dict: PdfDict): { name: string; parms: PdfDict | undefined }[] {
    const filter = this.get(dict, "Filter");
    const names: string[] = [];
    if (isName(filter)) {
      names.push(filter.value);
    } else if (isArray(filter)) {
      for (const item of filter.items) names.push(nameValue(this.resolve(item)) ?? "");
    }
    const parms = this.get(dict, "DecodeParms");
    return names.map((name, index) => {
      if (isDict(parms)) return { name, parms: index === 0 ? parms : undefined };
      if (isArray(parms)) return { name, parms: asDict(this.resolve(parms.items[index])) };
      return { name, parms: undefined };
    });
  }

  #inflate(data: Uint8Array): Uint8Array | null {
    const room = MAX_INFLATED_BYTES - this.#inflated;
    if (room <= 0 || data.length === 0) return null;
    try {
      // Z_SYNC_FLUSH keeps the output of a stream whose tail is missing or whose final newline was trimmed.
      const out = inflateSync(data, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH });
      this.#inflated += out.length;
      return out;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
        this.#inflated = MAX_INFLATED_BYTES;
      }
      return null;
    }
  }

  #root(): PdfDict | undefined {
    for (let at = this.#trailers.length - 1; at >= 0; at--) {
      const trailer = this.#trailers[at];
      const root = trailer === undefined ? undefined : this.dictOf(trailer, "Root");
      if (root !== undefined) return root;
    }
    let best: PdfObject | undefined;
    for (const object of this.objects.values()) {
      if (isDict(object.value) && nameValue(object.value.entries.get("Type")) === "Catalog" && (best === undefined || object.seq > best.seq)) {
        best = object;
      }
    }
    return best !== undefined && isDict(best.value) ? best.value : undefined;
  }

  /** The pages in reading order: the `/Pages` tree of the catalog, else every `/Type /Page` object in file order. */
  pages(): PageRef[] {
    const found: PageRef[] = [];
    const tree = this.#root()?.entries.get("Pages");
    if (tree !== undefined) this.#walk(tree, undefined, undefined, found, new Set(), 0);
    if (found.length > 0) return found;
    const loose = [...this.objects.values()]
      .filter((object) => isDict(object.value) && nameValue(object.value.entries.get("Type")) === "Page")
      .sort((a, b) => a.seq - b.seq);
    for (const object of loose) {
      if (found.length >= MAX_PAGES) break;
      if (!isDict(object.value)) continue;
      found.push({ dict: object.value, resources: this.#inherited(object.value, "Resources"), mediaBox: this.#inherited(object.value, "MediaBox") });
    }
    return found;
  }

  #walk(node: Value, resources: Value | undefined, mediaBox: Value | undefined, found: PageRef[], seen: Set<number>, depth: number): void {
    if (found.length >= MAX_PAGES || depth > MAX_NESTING) return;
    if (isRef(node)) {
      if (seen.has(node.num)) return;
      seen.add(node.num);
    }
    const dict = this.resolve(node);
    if (!isDict(dict)) return;
    const ownResources = dict.entries.get("Resources") ?? resources;
    const ownBox = dict.entries.get("MediaBox") ?? mediaBox;
    const type = this.nameOf(dict, "Type");
    const kids = this.arrayOf(dict, "Kids");
    if (type === "Pages" || (type !== "Page" && kids !== undefined)) {
      for (const kid of kids?.items ?? []) this.#walk(kid, ownResources, ownBox, found, seen, depth + 1);
      return;
    }
    found.push({ dict, resources: ownResources, mediaBox: ownBox });
  }

  /** An inheritable page attribute, looked up through `/Parent`. */
  #inherited(page: PdfDict, key: string): Value | undefined {
    let node: PdfDict | undefined = page;
    for (let hops = 0; node !== undefined && hops < MAX_NESTING; hops++) {
      const value = node.entries.get(key);
      if (value !== undefined) return value;
      node = this.dictOf(node, "Parent");
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fonts: from the bytes of a string to text

/** Text for the bytes of one shown string. */
type FontDecoder = (bytes: string) => string;

const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178,
];

/** WinAnsiEncoding: ASCII, cp1252 for 0x80 to 0x9F, Latin-1 above; control codes carry no text. */
const WINANSI: readonly string[] = Array.from({ length: 256 }, (_, code) => {
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (code === 0xa0) return " ";
  if (code >= 0x80 && code <= 0x9f) {
    const point = CP1252_HIGH[code - 0x80] ?? 0;
    return point === 0 ? "" : String.fromCharCode(point);
  }
  return code >= 0xa1 ? String.fromCharCode(code) : "";
});

const ASCII_GLYPHS = [
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash",
  "zero one two three four five six seven eight nine colon semicolon less equal greater question at",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "bracketleft backslash bracketright asciicircum underscore grave",
  ..."abcdefghijklmnopqrstuvwxyz",
  "braceleft bar braceright asciitilde",
]
  .join(" ")
  .split(" ");

const LATIN1_GLYPHS = (
  "exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron " +
  "degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter " +
  "onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis " +
  "Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex " +
  "Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis " +
  "igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex " +
  "udieresis yacute thorn ydieresis"
).split(" ");

const OTHER_GLYPHS: ReadonlyArray<readonly [string, number]> = [
  ["bullet", 0x2022],
  ["endash", 0x2013],
  ["emdash", 0x2014],
  ["quoteleft", 0x2018],
  ["quoteright", 0x2019],
  ["quotesinglbase", 0x201a],
  ["quotedblleft", 0x201c],
  ["quotedblright", 0x201d],
  ["quotedblbase", 0x201e],
  ["dagger", 0x2020],
  ["daggerdbl", 0x2021],
  ["ellipsis", 0x2026],
  ["perthousand", 0x2030],
  ["guilsinglleft", 0x2039],
  ["guilsinglright", 0x203a],
  ["Euro", 0x20ac],
  ["trademark", 0x2122],
  ["minus", 0x2212],
  ["fraction", 0x2044],
  ["OE", 0x152],
  ["oe", 0x153],
  ["Scaron", 0x160],
  ["scaron", 0x161],
  ["Ydieresis", 0x178],
  ["Zcaron", 0x17d],
  ["zcaron", 0x17e],
  ["florin", 0x192],
  ["circumflex", 0x2c6],
  ["tilde", 0x2dc],
  ["Lslash", 0x141],
  ["lslash", 0x142],
  ["dotlessi", 0x131],
  ["nbspace", 0xa0],
  ["ff", 0xfb00],
  ["fi", 0xfb01],
  ["fl", 0xfb02],
  ["ffi", 0xfb03],
  ["ffl", 0xfb04],
];

/** Adobe glyph names that text uses: the ASCII and Latin-1 sets plus the punctuation and ligature names of WinAnsi. */
const GLYPHS = new Map<string, string>();
ASCII_GLYPHS.forEach((name, index) => GLYPHS.set(name, String.fromCharCode(0x20 + index)));
LATIN1_GLYPHS.forEach((name, index) => GLYPHS.set(name, String.fromCharCode(0xa1 + index)));
for (const [name, point] of OTHER_GLYPHS) GLYPHS.set(name, String.fromCodePoint(point));

function glyphPart(name: string): string | undefined {
  const known = GLYPHS.get(name);
  if (known !== undefined) return known;
  const units = /^uni((?:[0-9A-F]{4})+)$/.exec(name)?.[1];
  if (units !== undefined) {
    let out = "";
    for (let at = 0; at < units.length; at += 4) out += String.fromCharCode(parseInt(units.slice(at, at + 4), 16));
    return out;
  }
  const point = /^u([0-9A-F]{4,6})$/.exec(name)?.[1];
  if (point !== undefined) {
    const code = parseInt(point, 16);
    return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : undefined;
  }
  return undefined;
}

/** The text of a glyph name, `undefined` for one that carries none (`.notdef`, `g23`). */
function glyphText(name: string): string | undefined {
  const dot = name.indexOf(".");
  const base = dot < 0 ? name : name.slice(0, dot);
  if (base === "") return undefined;
  const known = glyphPart(base);
  if (known !== undefined || !base.includes("_")) return known;
  const parts = base.split("_").map(glyphPart);
  return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
}

function simpleDecoder(table: readonly string[]): FontDecoder {
  return (bytes) => {
    let out = "";
    for (let at = 0; at < bytes.length; at++) out += table[bytes.charCodeAt(at)] ?? "";
    return out;
  };
}

/** Big-endian UTF-16 code units; a single byte is one unit. */
function utf16be(bytes: string): string {
  if (bytes.length === 1) return bytes;
  let out = "";
  for (let at = 0; at + 1 < bytes.length; at += 2) out += String.fromCharCode(bytes.charCodeAt(at) * 256 + bytes.charCodeAt(at + 1));
  return out;
}

const DEFAULT_FONT: FontDecoder = simpleDecoder(WINANSI);

type CodeSpace = { n: number; lo: number[]; hi: number[] };
type CMapRange = { n: number; lo: number; hi: number; target: string | string[] };
type CMap = { spaces: CodeSpace[]; chars: Map<number, string>; ranges: CMapRange[] };

const KEY_STRIDE = 4294967296;

function codeOf(bytes: string): number {
  let code = 0;
  for (let at = 0; at < bytes.length; at++) code = code * 256 + bytes.charCodeAt(at);
  return code;
}

/** `beginbfchar`, `beginbfrange` and `begincodespacerange` of a ToUnicode CMap; everything else is skipped. */
function parseCMap(source: string): CMap {
  const cmap: CMap = { spaces: [], chars: new Map(), ranges: [] };
  const lexer = new Lexer(source);
  const operands: Value[] = [];
  try {
    for (let token = lexer.value(false); token !== undefined; token = lexer.value(false)) {
      if (!isKeyword(token)) {
        operands.push(token);
        if (operands.length > 3 * MAX_CMAP_ENTRIES) break;
        continue;
      }
      if (token.value === "endcodespacerange") {
        for (let at = 0; at + 1 < operands.length; at += 2) {
          const lo = operands[at];
          const hi = operands[at + 1];
          if (!isString(lo) || !isString(hi) || lo.value.length !== hi.value.length || lo.value.length < 1 || lo.value.length > 4) continue;
          cmap.spaces.push({
            n: lo.value.length,
            lo: [...lo.value].map((char) => char.charCodeAt(0)),
            hi: [...hi.value].map((char) => char.charCodeAt(0)),
          });
        }
      } else if (token.value === "endbfchar") {
        for (let at = 0; at + 1 < operands.length && cmap.chars.size < MAX_CMAP_ENTRIES; at += 2) {
          const from = operands[at];
          const to = operands[at + 1];
          if (isString(from) && isString(to) && from.value.length >= 1 && from.value.length <= 4) {
            cmap.chars.set(from.value.length * KEY_STRIDE + codeOf(from.value), utf16be(to.value));
          }
        }
      } else if (token.value === "endbfrange") {
        for (let at = 0; at + 2 < operands.length && cmap.ranges.length < MAX_CMAP_ENTRIES; at += 3) {
          const lo = operands[at];
          const hi = operands[at + 1];
          const to = operands[at + 2];
          if (!isString(lo) || !isString(hi) || lo.value.length !== hi.value.length || lo.value.length < 1 || lo.value.length > 4) continue;
          let target: string | string[];
          if (isString(to)) {
            target = utf16be(to.value);
          } else if (isArray(to)) {
            target = to.items.map((item) => (isString(item) ? utf16be(item.value) : ""));
          } else {
            continue;
          }
          cmap.ranges.push({ n: lo.value.length, lo: codeOf(lo.value), hi: codeOf(hi.value), target });
        }
      }
      operands.length = 0;
    }
  } catch (error) {
    if (!(error instanceof PdfSyntaxError)) throw error;
  }
  return cmap;
}

function lookupCMap(cmap: CMap, n: number, code: number): string | undefined {
  const direct = cmap.chars.get(n * KEY_STRIDE + code);
  if (direct !== undefined) return direct;
  for (let at = cmap.ranges.length - 1; at >= 0; at--) {
    const range = cmap.ranges[at];
    if (range === undefined || range.n !== n || code < range.lo || code > range.hi) continue;
    if (typeof range.target !== "string") return range.target[code - range.lo];
    if (range.target === "") return "";
    return range.target.slice(0, -1) + String.fromCharCode(range.target.charCodeAt(range.target.length - 1) + code - range.lo);
  }
  return undefined;
}

/** Decode through a ToUnicode CMap. The code width follows its codespace ranges (`defaultWidth` when it has none);
 * a code it does not map goes to `fallback`, or yields nothing without one. */
function cmapDecoder(cmap: CMap, defaultWidth: number, fallback: FontDecoder | undefined): FontDecoder {
  const widths = [...new Set(cmap.spaces.map((space) => space.n))].sort((a, b) => a - b);
  const cache = new Map<number, string>();
  const widthAt = (bytes: string, at: number): number => {
    for (const n of widths) {
      if (at + n > bytes.length) break;
      for (const space of cmap.spaces) {
        if (space.n !== n) continue;
        let inside = true;
        for (let k = 0; k < n && inside; k++) {
          const byte = bytes.charCodeAt(at + k);
          inside = byte >= (space.lo[k] ?? 0) && byte <= (space.hi[k] ?? 255);
        }
        if (inside) return n;
      }
    }
    return Math.min(widths[0] ?? defaultWidth, bytes.length - at);
  };
  return (bytes) => {
    let out = "";
    for (let at = 0; at < bytes.length; ) {
      const n = widthAt(bytes, at);
      let code = 0;
      for (let k = 0; k < n; k++) code = code * 256 + bytes.charCodeAt(at + k);
      const key = n * KEY_STRIDE + code;
      let text = cache.get(key);
      if (text === undefined) {
        text = lookupCMap(cmap, n, code) ?? (fallback === undefined ? "" : fallback(bytes.slice(at, at + n)));
        cache.set(key, text);
      }
      out += text;
      at += n;
    }
    return out;
  };
}

/** Font decoders by font dictionary, built once per file. A font with a ToUnicode CMap decodes through it; without one
 * a simple font is WinAnsi with its `/Differences` applied (MacRoman and the other base encodings read as WinAnsi) and a
 * Type0 font reads two-byte big-endian UTF-16 code units. */
class FontLoader {
  readonly #pdf: PdfFile;
  readonly #cache = new Map<PdfDict, FontDecoder>();

  constructor(pdf: PdfFile) {
    this.#pdf = pdf;
  }

  decoder(font: PdfDict): FontDecoder {
    let decoder = this.#cache.get(font);
    if (decoder === undefined) {
      decoder = this.#build(font);
      this.#cache.set(font, decoder);
    }
    return decoder;
  }

  #build(font: PdfDict): FontDecoder {
    const pdf = this.#pdf;
    const type0 = pdf.nameOf(font, "Subtype") === "Type0";
    let cmap: CMap | undefined;
    const toUnicode = pdf.dictOf(font, "ToUnicode");
    const bytes = toUnicode === undefined ? null : pdf.decode(toUnicode);
    if (bytes !== null) {
      const parsed = parseCMap(latin1(bytes));
      if (parsed.chars.size > 0 || parsed.ranges.length > 0) cmap = parsed;
    }
    if (type0) return cmap === undefined ? utf16be : cmapDecoder(cmap, 2, undefined);
    const simple = simpleDecoder(this.#table(font));
    return cmap === undefined ? simple : cmapDecoder(cmap, 1, simple);
  }

  /** WinAnsi with the `/Differences` of the font's `/Encoding` dictionary applied. */
  #table(font: PdfDict): string[] {
    const table = [...WINANSI];
    const encoding = this.#pdf.dictOf(font, "Encoding");
    const differences = encoding === undefined ? undefined : this.#pdf.arrayOf(encoding, "Differences");
    let code = 0;
    for (const item of differences?.items ?? []) {
      const entry = this.#pdf.resolve(item);
      if (typeof entry === "number") {
        code = Math.trunc(entry);
      } else if (isName(entry)) {
        const text = glyphText(entry.value);
        if (text !== undefined && code >= 0 && code < 256) table[code] = text;
        code += 1;
      }
    }
    return table;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Content streams: from operators to lines

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` followed by `n`. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** The last six of `items` as a matrix, when they are all numbers. */
function matrixFrom(items: readonly (Value | undefined)[]): Matrix | undefined {
  if (items.length < 6) return undefined;
  const [a, b, c, d, e, f] = items.slice(items.length - 6);
  if (typeof a !== "number" || typeof b !== "number" || typeof c !== "number") return undefined;
  if (typeof d !== "number" || typeof e !== "number" || typeof f !== "number") return undefined;
  return [a, b, c, d, e, f];
}

/** The number `back` places from the end of `operands`, 1 being the last. */
function numberFromEnd(operands: readonly Value[], back: number): number | undefined {
  const value = operands[operands.length - back];
  return typeof value === "number" ? value : undefined;
}

/** The graphics state a text run reads: the coordinate matrix and the text state parameters. */
type GState = { readonly ctm: Matrix; readonly font: FontDecoder; readonly size: number; readonly leading: number };

/** Counters shared by every page of one file. */
type Work = { operators: number; chars: number };

/** Skip an inline image, whose data is binary: past `ID`, up to the whitespace-delimited `EI`. */
function skipInlineImage(lexer: Lexer): void {
  for (;;) {
    const token = lexer.value(false);
    if (token === undefined) return;
    if (isKeyword(token) && token.value === "ID") break;
  }
  const src = lexer.src;
  if (isSpaceCode(src.charCodeAt(lexer.pos))) lexer.pos += 1;
  const end = /[\0\t\n\f\r ]EI(?![^\0\t\n\f\r ])/g;
  end.lastIndex = lexer.pos;
  lexer.pos = end.exec(src) === null ? src.length : end.lastIndex;
}

/** Text a shown string adds: tabs and no-break spaces become spaces, other control characters vanish. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u00a0]/g, (char) => (char === "\t" || char === "\n" || char === "\r" || char === "\u00a0" ? " " : ""));
}

/** The text lines of one page, in content stream order. A new line starts when the text origin moves in y; a space
 * goes between runs when a TJ adjustment is below -200 or the origin jumps forward along the line. Glyph widths are
 * never measured, so a run split mid-word by a `Td` reads with a space. */
function extractPage(pdf: PdfFile, fonts: FontLoader, page: PageRef, work: Work): string[] {
  const lines: string[] = [];
  const forms = new Map<PdfDict, string | undefined>();
  let line = "";
  let endsSpace = true;
  let pendingSpace = false;
  let placed = false;
  let lastX = 0;
  let lastY = 0;
  let pageChars = 0;
  let stopped = work.operators >= MAX_OPERATORS || work.chars >= MAX_DOCUMENT_CHARS;

  const endLine = (): void => {
    const text = line.trim();
    line = "";
    endsSpace = true;
    pendingSpace = false;
    if (text === "") return;
    lines.push(text);
    pageChars += text.length + 1;
    work.chars += text.length + 1;
    if (pageChars >= MAX_PAGE_CHARS || work.chars >= MAX_DOCUMENT_CHARS) stopped = true;
  };

  const append = (text: string): void => {
    if (pendingSpace && line.length > 0 && !endsSpace && !isSpaceCode(text.charCodeAt(0))) line += " ";
    pendingSpace = false;
    line += text;
    endsSpace = text.charCodeAt(text.length - 1) === 0x20;
    if (line.length >= MAX_PAGE_CHARS) endLine();
  };

  /** Show `bytes` with the text line matrix `lm`. */
  const show = (bytes: string, state: GState, lm: Matrix): void => {
    if (stopped || bytes.length === 0) return;
    const text = clean(state.font(bytes));
    if (text === "") return;
    const ctm = state.ctm;
    const x = lm[4] * ctm[0] + lm[5] * ctm[2] + ctm[4];
    const y = lm[4] * ctm[1] + lm[5] * ctm[3] + ctm[5];
    if (placed) {
      if (Math.abs(y - lastY) > LINE_EPSILON) {
        endLine();
        if (stopped) return;
      } else {
        const gap = GAP_RATIO * state.size * Math.hypot(lm[0], lm[1]) * Math.hypot(ctm[0], ctm[1]);
        if (x - lastX > Math.max(gap, LINE_EPSILON)) pendingSpace = true;
      }
    }
    append(text);
    placed = true;
    lastX = x;
    lastY = y;
  };

  const fontNamed = (resources: PdfDict | undefined, name: string): FontDecoder => {
    const table = resources === undefined ? undefined : pdf.dictOf(resources, "Font");
    const font = table === undefined ? undefined : pdf.dictOf(table, name);
    return font === undefined ? DEFAULT_FONT : fonts.decoder(font);
  };

  const run = (content: string, resources: PdfDict | undefined, initial: GState, depth: number): void => {
    const lexer = new Lexer(content);
    const operands: Value[] = [];
    const saved: GState[] = [];
    let state = initial;
    let lm: Matrix = IDENTITY;
    const move = (tx: number, ty: number): void => {
      lm = multiply([1, 0, 0, 1, tx, ty], lm);
    };
    try {
      while (!stopped) {
        const token = lexer.value(false);
        if (token === undefined) return;
        if (!isKeyword(token)) {
          operands.push(token);
          if (operands.length > 64) operands.shift();
          continue;
        }
        if (++work.operators >= MAX_OPERATORS) {
          stopped = true;
          return;
        }
        // Tc, Tw, Tz, Ts and Tr only change how glyphs are placed, never which: they, and every painting operator, are skipped.
        switch (token.value) {
          case "q":
            if (saved.length < 256) saved.push(state);
            break;
          case "Q": {
            const prior = saved.pop();
            if (prior !== undefined) state = prior;
            break;
          }
          case "cm": {
            const matrix = matrixFrom(operands);
            if (matrix !== undefined) state = { ...state, ctm: multiply(matrix, state.ctm) };
            break;
          }
          case "BT":
            lm = IDENTITY;
            break;
          case "Tf": {
            const name = operands[operands.length - 2];
            const size = operands[operands.length - 1];
            if (isName(name) && typeof size === "number") state = { ...state, font: fontNamed(resources, name.value), size };
            break;
          }
          case "TL": {
            const leading = numberFromEnd(operands, 1);
            if (leading !== undefined) state = { ...state, leading };
            break;
          }
          case "Td":
          case "TD": {
            const ty = numberFromEnd(operands, 1);
            const tx = numberFromEnd(operands, 2);
            if (tx === undefined || ty === undefined) break;
            if (token.value === "TD") state = { ...state, leading: -ty };
            move(tx, ty);
            break;
          }
          case "Tm": {
            const matrix = matrixFrom(operands);
            if (matrix !== undefined) lm = matrix;
            break;
          }
          case "T*":
            move(0, -state.leading);
            break;
          case "Tj": {
            const shown = operands[operands.length - 1];
            if (isString(shown)) show(shown.value, state, lm);
            break;
          }
          case "'":
          case '"': {
            move(0, -state.leading);
            const shown = operands[operands.length - 1];
            if (isString(shown)) show(shown.value, state, lm);
            break;
          }
          case "TJ": {
            const shown = operands[operands.length - 1];
            if (!isArray(shown)) break;
            for (const item of shown.items) {
              if (isString(item)) show(item.value, state, lm);
              else if (typeof item === "number" && item < WORD_GAP) pendingSpace = true;
            }
            break;
          }
          case "Do": {
            const target = operands[operands.length - 1];
            if (depth >= MAX_FORM_DEPTH || !isName(target)) break;
            const xobjects = resources === undefined ? undefined : pdf.dictOf(resources, "XObject");
            const form = xobjects === undefined ? undefined : pdf.dictOf(xobjects, target.value);
            if (form === undefined || form.stream === undefined || pdf.nameOf(form, "Subtype") !== "Form") break;
            if (!forms.has(form)) {
              const bytes = pdf.decode(form);
              forms.set(form, bytes === null ? undefined : latin1(bytes));
            }
            const body = forms.get(form);
            if (body === undefined) break;
            const matrix = pdf.matrixOf(form, "Matrix") ?? IDENTITY;
            run(body, pdf.dictOf(form, "Resources") ?? resources, { ...state, ctm: multiply(matrix, state.ctm) }, depth + 1);
            break;
          }
          case "BI":
            skipInlineImage(lexer);
            break;
        }
        operands.length = 0;
      }
    } catch (error) {
      // A stream that nests too deeply ends there; what it showed so far stays.
      if (!(error instanceof PdfSyntaxError)) throw error;
    }
  };

  const contents = pdf.resolve(page.dict.entries.get("Contents"));
  const parts: string[] = [];
  for (const entry of isArray(contents) ? contents.items : [contents]) {
    const stream = pdf.resolve(entry);
    if (!isDict(stream) || stream.stream === undefined) continue;
    const bytes = pdf.decode(stream);
    if (bytes !== null) parts.push(latin1(bytes));
  }
  run(parts.join("\n"), asDict(pdf.resolve(page.resources)), { ctm: IDENTITY, font: DEFAULT_FONT, size: 0, leading: 0 }, 0);
  endLine();
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// The document

/** What the reader keeps of one page. `width` and `height` are the media box in points, `null` without one. */
type PageText = { number: number; lines: readonly string[]; text: string; width: number | null; height: number | null };

/** The page size in points from the (inherited) `/MediaBox`. */
function mediaSize(pdf: PdfFile, page: PageRef): { width: number | null; height: number | null } {
  const box = pdf.resolve(page.mediaBox);
  if (!isArray(box) || box.items.length < 4) return { width: null, height: null };
  const [x0, y0, x1, y1] = box.items.slice(0, 4).map((item) => pdf.resolve(item));
  if (typeof x0 !== "number" || typeof y0 !== "number" || typeof x1 !== "number" || typeof y1 !== "number") return { width: null, height: null };
  // Rounded to three decimals, as the Agent API rounds page geometry.
  return { width: Math.round(Math.abs(x1 - x0) * 1000) / 1000, height: Math.round(Math.abs(y1 - y0) * 1000) / 1000 };
}

function readPages(bytes: Uint8Array): PageText[] {
  if (bytes.length > MAX_FILE_BYTES) throw new ReadError("invalid-input", `the PDF is larger than ${MAX_FILE_BYTES} bytes`);
  if (!latin1(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new ReadError("invalid-input", "not a PDF: there is no %PDF- header in the first 1024 bytes");
  }
  const pdf = new PdfFile(bytes);
  if (pdf.encrypted()) throw new ReadError("invalid-input", "the PDF is encrypted");
  if (pdf.objects.size === 0) throw new ReadError("invalid-input", "the PDF holds no objects");
  pdf.expand();
  const fonts = new FontLoader(pdf);
  const work: Work = { operators: 0, chars: 0 };
  return pdf.pages().map((page, index) => {
    const lines = extractPage(pdf, fonts, page, work);
    const size = mediaSize(pdf, page);
    return { number: index + 1, lines, text: lines.join("\n"), width: size.width, height: size.height };
  });
}

/** `page:<n>`, or `page:@<n>` as the Agent API writes it. */
const PAGE_ADDRESS = /^page:@?([1-9][0-9]{0,5})$/;

function blockOf(page: PageText): Block {
  return {
    address: `page:${page.number}`,
    aliases: [`page:@${page.number}`],
    kind: "page",
    depth: 0,
    text: page.text,
    meta: { page: page.number, lines: page.lines.length, chars: page.text.length, width_pt: page.width, height_pt: page.height },
  };
}

class PdfDocument implements ReadableDocument {
  readonly format = "pdf" as const;
  readonly #pages: readonly PageText[];

  constructor(pages: readonly PageText[]) {
    this.#pages = pages;
  }

  blocks(target?: string): Block[] {
    return this.#select(target).map(blockOf);
  }

  text(target?: string): string {
    const pages = this.#select(target);
    if (target !== undefined) return pages.map((page) => page.text).join("\n");
    return pages.map((page) => (page.text === "" ? `# Page ${page.number}` : `# Page ${page.number}\n${page.text}`)).join("\n\n");
  }

  markdown(target?: string): string {
    return this.#select(target)
      .map((page) => [`## Page ${page.number}`, ...page.lines].join("\n\n"))
      .join("\n\n");
  }

  cells(): CellEntry[] {
    throw new ReadError("unsupported-view", "a PDF has no cells view");
  }

  units(): SearchUnit[] {
    return this.#pages.filter((page) => page.text !== "").map((page) => ({ address: `page:${page.number}`, text: page.text }));
  }

  /** The pages `target` names: all of them without one, else the one page. A PDF has no addresses below a page. */
  #select(target: string | undefined): readonly PageText[] {
    if (target === undefined) return this.#pages;
    const number = PAGE_ADDRESS.exec(target)?.[1];
    const page = number === undefined ? undefined : this.#pages[Number(number) - 1];
    if (page === undefined) throw new ReadError("address-unresolved", `${target} names nothing in this document`);
    return [page];
  }
}

/** Read the text of a PDF. Throws `ReadError` (`invalid-input`) for bytes that are not a readable, unencrypted PDF. */
export function openPdf(bytes: Uint8Array): ReadableDocument {
  try {
    return new PdfDocument(readPages(bytes));
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("invalid-input", `the PDF can not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
