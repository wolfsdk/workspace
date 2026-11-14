// The DOCX reader: the body of `word/document.xml` as paragraphs, tables, rows, cells and bookmarks, addressed
// as `docs/agent-api.md` section 3 says (`para:#<w14:paraId>` or `para:@n`, `table:@n/row:@n/cell:@n`,
// `bookmark:<name>`). Headers, footers, footnotes and comments are not read. Tracked deletions are ignored,
// so the text is what the document says once every change is accepted.
import { createHash } from "node:crypto";
import { ReadError } from "./model.ts";
import type { Block, CellEntry, ReadableDocument, SearchUnit } from "./model.ts";
import { relationshipsOf } from "./rels.ts";
import { attr, childElements, firstChild, parseXml, textOf } from "./xml.ts";
import type { XmlElement } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

/** Blocks materialized from one document; the rest of an oversized body is dropped. */
const MAX_UNITS = 200_000;
/** Characters kept of one paragraph or cell. */
const MAX_TEXT = 100_000;
/** Characters of the paragraph text a bookmark block carries. */
const BOOKMARK_TEXT = 200;

const HEADING_STYLE = /^heading ?([0-9])$/i;
const TITLE_STYLE = /^title$/i;
const PARA_ID = /^[A-Za-z0-9_.-]+$/;
const FINGERPRINT_TARGET = /^para:~([0-9a-fA-F]{8})(?:\.([0-9]+))?$/;
const PARA_ID_TARGET = /^para:#([^/]+)$/;

type EntryType = "para" | "table" | "row" | "cell" | "bookmark";

/** One listed block plus what the views need to render it. */
type Entry = {
  type: EntryType;
  block: Block;
  /** One past the index of the last entry below this one. */
  end: number;
  /** The enclosing cell's index for a paragraph or nested table, -1 at the body: the scope of `.n` fingerprints. */
  parent: number;
  /** Heading level of a paragraph. */
  heading?: number;
  /** `w:ilvl` of a list paragraph. */
  listLevel?: number;
  /** Indexes of the rows of a table. */
  rows?: number[];
  /** The text of each cell of a row. */
  cells?: string[];
};

type StyleInfo = { name: string | undefined; outline: number | undefined };

type State = { entries: Entry[]; paragraphs: number; tables: number; styles: Map<string, StyleInfo> };

const val = (el: XmlElement | undefined): string | undefined => (el === undefined ? undefined : attr(el, "w:val"));

/** The `w:outlineLvl` of a property element as a heading level (outline level 0 is level 1); body text is 9. */
function outlineOf(props: XmlElement | undefined): number | undefined {
  const raw = props === undefined ? undefined : val(firstChild(props, "outlineLvl"));
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 8 ? n + 1 : undefined;
}

/** The paragraph styles of the styles part: name and outline level by id. A part that does not read gives an
 * empty map, since styles only decide labels and heading levels. */
function readStyles(zip: ZipArchive, mainPart: string): Map<string, StyleInfo> {
  const out = new Map<string, StyleInfo>();
  try {
    let part = "word/styles.xml";
    for (const rel of relationshipsOf(zip, mainPart).values()) if (!rel.external && rel.type.endsWith("/styles")) part = rel.target;
    const source = zip.optionalText(part);
    if (source === undefined) return out;
    for (const style of childElements(parseXml(source), "style")) {
      const id = attr(style, "w:styleId");
      if (id === undefined) continue;
      const props = firstChild(style, "pPr");
      out.set(id, { name: val(firstChild(style, "name")), outline: outlineOf(props) });
    }
    return out;
  } catch {
    return new Map();
  }
}

type Collected = { text: string; bookmarks: string[] };

function append(acc: Collected, text: string): void {
  if (acc.text.length < MAX_TEXT) acc.text = (acc.text + text).slice(0, MAX_TEXT);
}

function collectRun(run: XmlElement, acc: Collected): void {
  for (const child of childElements(run)) {
    switch (child.local) {
      case "t":
        append(acc, textOf(child));
        break;
      case "tab":
        append(acc, "\t");
        break;
      case "br":
      case "cr":
        append(acc, "\n");
        break;
      case "noBreakHyphen":
        append(acc, "-");
        break;
    }
  }
}

/** The text and bookmark names of the content of a paragraph, in order. Wrappers such as hyperlinks, insertions,
 * smart tags and simple fields are read through; deletions, drawings and property elements are not. */
function collect(el: XmlElement, acc: Collected): void {
  for (const child of childElements(el)) {
    switch (child.local) {
      case "pPr":
      case "rPr":
      case "del":
      case "moveFrom":
      case "drawing":
      case "pict":
      case "object":
      case "AlternateContent":
        break;
      case "r":
        collectRun(child, acc);
        break;
      case "bookmarkStart": {
        const name = attr(child, "w:name");
        if (name !== undefined && name !== "" && !name.startsWith("_")) acc.bookmarks.push(name);
        break;
      }
      case "sdt": {
        const content = firstChild(child, "sdtContent");
        if (content !== undefined) collect(content, acc);
        break;
      }
      default:
        collect(child, acc);
    }
  }
}

/** A name key as the address grammar writes it: `%`, `/` and control characters percent-escaped, and a leading
 * `#`, `@` or `~` escaped too. */
function escapeName(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const first = i === 0 && (name[0] === "#" || name[0] === "@" || name[0] === "~");
    out += c === 0x25 || c === 0x2f || c < 0x20 || first ? `%${c.toString(16).toUpperCase().padStart(2, "0")}` : (name[i] as string);
  }
  return out;
}

/** The elements named `local` that are children of `parent`, looking through `w:sdt` content controls. */
function elementsOf(parent: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const child of childElements(parent)) {
    if (child.local === local) out.push(child);
    else if (child.local === "sdt") {
      const content = firstChild(child, "sdtContent");
      if (content !== undefined) elementsOf(content, local, out);
    }
  }
  return out;
}

function headingLevel(props: XmlElement | undefined, styleId: string | undefined, style: StyleInfo | undefined): number | undefined {
  const direct = outlineOf(props);
  if (direct !== undefined) return direct;
  for (const key of [styleId, style?.name]) {
    if (key === undefined) continue;
    const match = HEADING_STYLE.exec(key);
    if (match !== null) {
      const level = Number(match[1]);
      if (level >= 1) return level;
    }
    if (TITLE_STYLE.test(key)) return 1;
  }
  return style?.outline;
}

function addParagraph(st: State, p: XmlElement, depth: number, parent: number): string {
  if (st.entries.length >= MAX_UNITS) return "";
  st.paragraphs += 1;
  const positional = `para:@${st.paragraphs}`;
  const rawId = attr(p, "w14:paraId");
  const paraId = rawId !== undefined && PARA_ID.test(rawId) ? rawId.toUpperCase() : undefined;

  const acc: Collected = { text: "", bookmarks: [] };
  collect(p, acc);
  const props = firstChild(p, "pPr");
  const styleId = val(props === undefined ? undefined : firstChild(props, "pStyle"));
  const style = styleId === undefined ? undefined : st.styles.get(styleId);
  const level = headingLevel(props, styleId, style);

  const entry: Entry = {
    type: "para",
    block: {
      address: paraId === undefined ? positional : `para:#${paraId}`,
      kind: level === undefined ? "paragraph" : "heading",
      depth,
      text: acc.text,
    },
    end: st.entries.length + 1,
    parent,
  };
  if (paraId !== undefined) entry.block.aliases = [positional];
  if (styleId !== undefined) entry.block.label = style?.name ?? styleId;
  if (level !== undefined) {
    entry.heading = level;
    entry.block.meta = { level };
  } else {
    const numPr = props === undefined ? undefined : firstChild(props, "numPr");
    if (numPr !== undefined && val(firstChild(numPr, "numId")) !== "0") {
      const ilvl = Number.parseInt(val(firstChild(numPr, "ilvl")) ?? "0", 10);
      const listLevel = Number.isInteger(ilvl) && ilvl >= 0 ? Math.min(ilvl, 8) : 0;
      entry.listLevel = listLevel;
      entry.block.meta = { list_level: listLevel };
    }
  }
  st.entries.push(entry);

  for (const name of acc.bookmarks) {
    if (st.entries.length >= MAX_UNITS) break;
    st.entries.push({
      type: "bookmark",
      block: { address: `bookmark:${escapeName(name)}`, kind: "bookmark", depth: 0, text: acc.text.slice(0, BOOKMARK_TEXT) },
      end: st.entries.length + 1,
      parent,
    });
  }
  return acc.text;
}

/** The paragraphs and tables directly under `container` (the body or a cell), in order; the text of each
 * paragraph is appended to `direct`. */
function walkBlocks(st: State, container: XmlElement, depth: number, parent: number, direct: string[]): void {
  for (const child of childElements(container)) {
    if (st.entries.length >= MAX_UNITS) return;
    switch (child.local) {
      case "p":
        direct.push(addParagraph(st, child, depth, parent));
        break;
      case "tbl":
        addTable(st, child, depth, parent);
        break;
      case "sdt":
      case "customXml": {
        const content = child.local === "sdt" ? firstChild(child, "sdtContent") : child;
        if (content !== undefined) walkBlocks(st, content, depth, parent, direct);
        break;
      }
    }
  }
}

function addTable(st: State, tbl: XmlElement, depth: number, parent: number): void {
  st.tables += 1;
  const address = `table:@${st.tables}`;
  const tblPr = firstChild(tbl, "tblPr");
  const caption = val(tblPr === undefined ? undefined : firstChild(tblPr, "tblCaption"));
  const tableIndex = st.entries.length;
  const block: Block = { address, kind: "table", depth, text: "" };
  if (caption !== undefined && caption !== "") {
    block.aliases = [`table:${escapeName(caption)}`];
    block.label = caption;
  }
  const table: Entry = { type: "table", block, end: tableIndex + 1, parent, rows: [] };
  st.entries.push(table);

  let columns = 0;
  const rowElements = elementsOf(tbl, "tr");
  for (let r = 0; r < rowElements.length && st.entries.length < MAX_UNITS; r++) {
    const rowIndex = st.entries.length;
    const row: Entry = {
      type: "row",
      block: { address: `${address}/row:@${r + 1}`, kind: "row", depth: depth + 1, text: "" },
      end: rowIndex + 1,
      parent,
      cells: [],
    };
    st.entries.push(row);
    table.rows?.push(rowIndex);
    const cellElements = elementsOf(rowElements[r] as XmlElement, "tc");
    for (let c = 0; c < cellElements.length && st.entries.length < MAX_UNITS; c++) {
      const cellIndex = st.entries.length;
      const cell: Entry = {
        type: "cell",
        block: { address: `${address}/row:@${r + 1}/cell:@${c + 1}`, kind: "cell", depth: depth + 2, text: "" },
        end: cellIndex + 1,
        parent,
      };
      st.entries.push(cell);
      const direct: string[] = [];
      walkBlocks(st, cellElements[c] as XmlElement, depth + 3, cellIndex, direct);
      cell.block.text = direct.join("\n").slice(0, MAX_TEXT);
      cell.end = st.entries.length;
      row.cells?.push(cell.block.text);
    }
    row.end = st.entries.length;
    columns = Math.max(columns, cellElements.length);
  }
  table.end = st.entries.length;
  table.block.meta = { rows: table.rows?.length ?? 0, columns };
}

function fingerprintOf(text: string): string {
  return createHash("sha256").update(text.normalize("NFC").replace(/\s+/g, " "), "utf8").digest("hex").slice(0, 8);
}

/** A pipe table of `rows`; the first row is the header. Empty when there is nothing to put in it. */
function pipeTable(rows: readonly (readonly string[])[]): string {
  const columns = rows.reduce((most, row) => Math.max(most, row.length), 0);
  if (columns === 0) return "";
  const line = (row: readonly string[]): string => {
    const cells: string[] = [];
    for (let c = 0; c < columns; c++) cells.push((row[c] ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>"));
    return `| ${cells.join(" | ")} |`;
  };
  const [header, ...rest] = rows as readonly (readonly string[])[];
  return [line(header as readonly string[]), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rest.map(line)].join("\n");
}

class DocxDocument implements ReadableDocument {
  readonly format = "docx" as const;
  readonly #entries: Entry[];
  readonly #byAddress = new Map<string, number>();
  /** `table:<caption>` to the canonical table address, to read captioned row and cell addresses. */
  readonly #captions = new Map<string, string>();
  #fingerprints: Map<string, Map<number, number[]>> | undefined;

  constructor(entries: Entry[]) {
    this.#entries = entries;
    entries.forEach((entry, index) => {
      if (!this.#byAddress.has(entry.block.address)) this.#byAddress.set(entry.block.address, index);
      for (const alias of entry.block.aliases ?? []) {
        if (!this.#byAddress.has(alias)) this.#byAddress.set(alias, index);
        if (entry.type === "table" && !this.#captions.has(alias)) this.#captions.set(alias, entry.block.address);
      }
    });
  }

  /** Paragraph indexes by fingerprint, then by parent, in document order. */
  #fingerprintIndex(): Map<string, Map<number, number[]>> {
    if (this.#fingerprints !== undefined) return this.#fingerprints;
    const index = new Map<string, Map<number, number[]>>();
    this.#entries.forEach((entry, i) => {
      if (entry.type !== "para") return;
      const fingerprint = fingerprintOf(entry.block.text);
      let groups = index.get(fingerprint);
      if (groups === undefined) index.set(fingerprint, (groups = new Map()));
      let group = groups.get(entry.parent);
      if (group === undefined) groups.set(entry.parent, (group = []));
      group.push(i);
    });
    this.#fingerprints = index;
    return index;
  }

  #lookup(address: string): number | undefined {
    const direct = this.#byAddress.get(address);
    if (direct !== undefined) return direct;
    const id = PARA_ID_TARGET.exec(address);
    if (id !== null) return this.#byAddress.get(`para:#${(id[1] as string).toUpperCase()}`);
    const fingerprint = FINGERPRINT_TARGET.exec(address);
    if (fingerprint !== null) {
      const n = fingerprint[2] === undefined ? 1 : Number(fingerprint[2]);
      const groups = this.#fingerprintIndex().get((fingerprint[1] as string).toLowerCase());
      for (const group of groups?.values() ?? []) if (n >= 1 && group.length >= n) return group[n - 1];
      return undefined;
    }
    for (const [alias, canonical] of this.#captions) {
      if (address.startsWith(`${alias}/`)) return this.#byAddress.get(canonical + address.slice(alias.length));
    }
    return undefined;
  }

  /** The entries `[start, end)` that `target` selects: the whole body without one. */
  #range(target: string | undefined): [number, number] {
    if (target === undefined || target === "section:body") return [0, this.#entries.length];
    const rest = target.startsWith("section:body/") ? target.slice("section:body/".length) : target;
    const index = this.#lookup(rest);
    const entry = index === undefined ? undefined : this.#entries[index];
    if (index === undefined || entry === undefined) throw new ReadError("address-unresolved", `${target} names nothing in this document`);
    return [index, entry.end];
  }

  blocks(target?: string): Block[] {
    const [start, end] = this.#range(target);
    return this.#entries.slice(start, end).map((entry) => entry.block);
  }

  text(target?: string): string {
    const [start, end] = this.#range(target);
    const lines: string[] = [];
    const rowEnds: number[] = [];
    for (let i = start; i < end; i++) {
      while (rowEnds.length > 0 && (rowEnds[rowEnds.length - 1] as number) <= i) rowEnds.pop();
      const entry = this.#entries[i] as Entry;
      if (entry.type === "row") {
        lines.push((entry.cells ?? []).map((cell) => cell.replace(/\n/g, " ")).join("\t"));
        rowEnds.push(entry.end);
      } else if (entry.type === "para" && rowEnds.length === 0 && entry.block.text !== "") {
        lines.push(entry.block.text);
      }
    }
    return lines.join("\n");
  }

  markdown(target?: string): string {
    const [start, end] = this.#range(target);
    const parts: string[] = [];
    const rowEnds: number[] = [];
    for (let i = start; i < end; i++) {
      while (rowEnds.length > 0 && (rowEnds[rowEnds.length - 1] as number) <= i) rowEnds.pop();
      const entry = this.#entries[i] as Entry;
      if (entry.type === "table") {
        const table = pipeTable((entry.rows ?? []).map((row) => this.#entries[row]?.cells ?? []));
        if (table !== "") parts.push(table);
      } else if (entry.type === "row") {
        if (i === start) parts.push(pipeTable([entry.cells ?? []]));
        rowEnds.push(entry.end);
      } else if (entry.type === "para" && rowEnds.length === 0 && entry.block.text !== "") {
        if (entry.heading !== undefined) parts.push(`${"#".repeat(Math.min(entry.heading, 6))} ${entry.block.text}`);
        else if (entry.listLevel !== undefined) parts.push(`${"  ".repeat(entry.listLevel)}- ${entry.block.text}`);
        else parts.push(entry.block.text);
      }
    }
    return parts.join("\n\n");
  }

  cells(): CellEntry[] {
    throw new ReadError("unsupported-view", "a Word document has no cells view");
  }

  units(): SearchUnit[] {
    const out: SearchUnit[] = [];
    for (const entry of this.#entries) if (entry.type === "para" && entry.block.text !== "") out.push({ address: entry.block.address, text: entry.block.text });
    return out;
  }
}

/** The part the package's officeDocument relationship names, else `word/document.xml`. */
function mainPartOf(zip: ZipArchive): string {
  for (const rel of relationshipsOf(zip, "").values()) {
    if (!rel.external && rel.type.endsWith("/officeDocument") && zip.has(rel.target)) return rel.target;
  }
  if (zip.has("word/document.xml")) return "word/document.xml";
  throw new ReadError("invalid-input", "the package has no Word document part (word/document.xml)");
}

function parseDocx(bytes: Uint8Array): ReadableDocument {
  const zip = ZipArchive.open(bytes);
  const mainPart = mainPartOf(zip);
  const root = parseXml(zip.text(mainPart));
  const body = root.local === "document" ? firstChild(root, "body") : undefined;
  if (body === undefined) throw new ReadError("invalid-input", `${mainPart} is not a Word document (no w:document/w:body)`);
  const st: State = { entries: [], paragraphs: 0, tables: 0, styles: readStyles(zip, mainPart) };
  walkBlocks(st, body, 0, -1, []);
  return new DocxDocument(st.entries);
}

/** Parse `bytes` as a Word package. Throws `ReadError` (`invalid-input`) when they are not one. */
export function openDocx(bytes: Uint8Array): ReadableDocument {
  try {
    return parseDocx(bytes);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("invalid-input", `not a readable Word package: ${error instanceof Error ? error.message : String(error)}`);
  }
}
