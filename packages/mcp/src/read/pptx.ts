// PPTX reader: slides in `p:sldIdLst` order, the shapes of each slide in z-order (groups descended, connectors
// skipped), table rows and cells, and the notes body. Addresses follow section 3.4 of `docs/agent-api.md`:
// `slide:#<sldId>/shape:#<cNvPr id>[/row:@r[/cell:@c]]`, `slide:#<sldId>/notes`. Slide layouts and masters are
// never read: an inherited placeholder is addressed through the slide shape that references it.
import { createHash } from "node:crypto";
import { ReadError } from "./model.ts";
import type { Block, BlockMeta, CellEntry, ReadableDocument, SearchUnit } from "./model.ts";
import { relationshipsOf } from "./rels.ts";
import { attr, childElements, descendants, firstChild, parseXml, textOf } from "./xml.ts";
import type { XmlElement } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

/** Units (slides, shapes, paragraphs, rows, cells) materialized from one presentation. */
const MAX_UNITS = 200_000;
/** Characters kept of one paragraph or of one unit's joined text. */
const MAX_TEXT = 100_000;
const KEY_ID = /^[A-Za-z0-9_.-]+$/;
const KEY_POSITION = /^@[1-9]\d*$/;
const KEY_FINGERPRINT = /^~([0-9a-f]{8})(?:\.([1-9]\d*))?$/;
const FALLBACK_PART = "ppt/presentation.xml";

type Para = { text: string; level: number; bullet: boolean };

/** One addressable unit with its structural children: group members and the notes under a slide, rows under a
 * table frame, cells under a row. */
type Node = {
  kind: "slide" | "shape" | "notes" | "row" | "cell";
  block: Block;
  kids: Node[];
  paras: Para[];
  /** The persistent id (`sldId`, `cNvPr@id`) when the file has a usable one. */
  id: string | undefined;
  name: string | undefined;
  title: boolean;
  /** Every shape of a slide, groups flattened in document order: the scope of `shape:` keys. */
  flat: Node[];
};

type Budget = { left: number };
const take = (budget: Budget): boolean => budget.left-- > 0;
const clip = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);

const pct = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;

/** A shape name as an address key: `%`, `/`, controls and a leading `#`, `@` or `~` percent-escaped. */
function escapeName(name: string): string {
  const escaped = name.replace(/[%/\u0000-\u001f]/g, pct);
  return /^[#@~]/.test(escaped) ? pct(escaped.charAt(0)) + escaped.slice(1) : escaped;
}

/** The fingerprint key of `text` (`docs/agent-api.md` section 3.1); empty text has none. */
function fingerprint(text: string): string | undefined {
  const normalized = text.normalize("NFC").split(/\s+/).filter((word) => word !== "").join(" ");
  return normalized === "" ? undefined : createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

function makeNode(kind: Node["kind"], block: Block, id: string | undefined, name: string | undefined, paras: Para[]): Node {
  return { kind, block, kids: [], paras, id, name, title: false, flat: [] };
}

/** The paragraphs of a text body: `a:t` of runs and fields, `a:br` as a newline. */
function readParas(body: XmlElement | undefined, bodyPlaceholder: boolean, budget: Budget): Para[] {
  const out: Para[] = [];
  if (!body) return out;
  for (const p of childElements(body, "p")) {
    if (!take(budget)) break;
    let text = "";
    for (const child of childElements(p)) {
      if (child.local === "r" || child.local === "fld") for (const t of childElements(child, "t")) text += textOf(t);
      else if (child.local === "br") text += "\n";
      if (text.length > MAX_TEXT) break;
    }
    const pPr = firstChild(p, "pPr");
    const level = Math.min(8, Math.max(0, Number.parseInt((pPr && attr(pPr, "lvl")) ?? "0", 10) || 0));
    let bullet = bodyPlaceholder;
    if (pPr) {
      if (firstChild(pPr, "buNone")) bullet = false;
      else if (firstChild(pPr, "buChar") || firstChild(pPr, "buAutoNum") || firstChild(pPr, "buBlip")) bullet = true;
    }
    out.push({ text: clip(text), level, bullet });
  }
  return out;
}

const joinParas = (paras: readonly Para[]): string => clip(paras.map((p) => p.text).join("\n"));

type SlideScope = { address: string; flat: Node[]; budget: Budget };

const NV_BY_TAG: Record<string, { nv: string; kind: "shape" | "picture" | "group" | "frame" } | undefined> = {
  sp: { nv: "nvSpPr", kind: "shape" },
  pic: { nv: "nvPicPr", kind: "picture" },
  graphicFrame: { nv: "nvGraphicFramePr", kind: "frame" },
  grpSp: { nv: "nvGrpSpPr", kind: "group" },
};

/** Append the shapes under `parent` to `out` (and, flattened, to the scope), recursing into groups. */
function walkShapes(parent: XmlElement, depth: number, scope: SlideScope, out: Node[]): void {
  for (const el of childElements(parent)) {
    if (el.local === "AlternateContent") {
      const branch = firstChild(el, "Choice") ?? firstChild(el, "Fallback");
      if (branch) walkShapes(branch, depth, scope, out);
      continue;
    }
    const spec = NV_BY_TAG[el.local];
    if (!spec) continue;
    if (!take(scope.budget)) return;
    const nv = firstChild(el, spec.nv);
    const cNvPr = nv ? firstChild(nv, "cNvPr") : undefined;
    const rawId = cNvPr ? attr(cNvPr, "id") : undefined;
    const id = rawId !== undefined && KEY_ID.test(rawId) ? rawId : undefined;
    const name = (cNvPr ? attr(cNvPr, "name") : undefined) ?? "";
    const nvPr = nv ? firstChild(nv, "nvPr") : undefined;
    const ph = nvPr ? firstChild(nvPr, "ph") : undefined;
    const placeholder = ph ? (attr(ph, "type") ?? "obj") : null;

    const tbl = spec.kind === "frame" ? descendants(el, "tbl")[0] : undefined;
    let kind: string = spec.kind;
    if (spec.kind === "frame") kind = tbl ? "table" : descendants(el, "chart").length > 0 ? "chart" : "shape";

    const position = scope.flat.length + 1;
    const address = `${scope.address}/shape:${id !== undefined ? `#${id}` : `@${position}`}`;
    const paras = spec.kind === "shape" ? readParas(firstChild(el, "txBody"), placeholder === "body" || placeholder === "obj", scope.budget) : [];
    const meta: BlockMeta = { placeholder, paragraphs: paras.length };
    const block: Block = { address, kind, depth, text: joinParas(paras), meta };
    if (name !== "") block.label = name;
    const node = makeNode("shape", block, id, name, paras);
    node.title = placeholder === "title" || placeholder === "ctrTitle";
    scope.flat.push(node);
    out.push(node);

    if (tbl) readTable(tbl, node, depth, scope.budget);
    else if (spec.kind === "group") walkShapes(el, depth + 1, scope, node.kids);
  }
}

function readTable(tbl: XmlElement, frame: Node, depth: number, budget: Budget): void {
  let columns = 0;
  for (const tr of childElements(tbl, "tr")) {
    if (!take(budget)) break;
    const rowAddress = `${frame.block.address}/row:@${frame.kids.length + 1}`;
    const cells: Node[] = [];
    for (const tc of childElements(tr, "tc")) {
      if (!take(budget)) break;
      const paras = readParas(firstChild(tc, "txBody"), false, budget);
      const address = `${rowAddress}/cell:@${cells.length + 1}`;
      cells.push(makeNode("cell", { address, kind: "cell", depth: depth + 2, text: joinParas(paras) }, undefined, undefined, paras));
    }
    columns = Math.max(columns, cells.length);
    const text = clip(cells.map((cell) => cell.block.text.replace(/\n/g, " ")).join("\t"));
    const row = makeNode("row", { address: rowAddress, kind: "row", depth: depth + 1, text }, undefined, undefined, []);
    row.kids = cells;
    frame.kids.push(row);
  }
  const meta = frame.block.meta;
  if (meta) {
    meta.rows = frame.kids.length;
    meta.columns = columns;
  }
}

/** The body placeholder paragraphs of the notes slide `slidePart` points to, or none when it has no notes. */
function readNotes(zip: ZipArchive, slidePart: string, budget: Budget): Para[] {
  for (const rel of relationshipsOf(zip, slidePart).values()) {
    if (rel.external || !rel.type.endsWith("/notesSlide") || !zip.has(rel.target)) continue;
    const tree = shapeTree(parseXml(zip.text(rel.target)));
    const paras: Para[] = [];
    if (tree) {
      for (const sp of childElements(tree, "sp")) {
        const nv = firstChild(sp, "nvSpPr");
        const nvPr = nv ? firstChild(nv, "nvPr") : undefined;
        const ph = nvPr ? firstChild(nvPr, "ph") : undefined;
        if (!ph || attr(ph, "type") !== "body") continue;
        paras.push(...readParas(firstChild(sp, "txBody"), false, budget));
      }
    }
    return paras;
  }
  return [];
}

const shapeTree = (root: XmlElement): XmlElement | undefined => {
  const cSld = firstChild(root, "cSld");
  return cSld ? firstChild(cSld, "spTree") : undefined;
};

const hasText = (paras: readonly Para[]): boolean => paras.some((p) => p.text.trim() !== "");

function readSlide(zip: ZipArchive, part: string, n: number, sldId: string | undefined, budget: Budget): Node {
  const root = parseXml(zip.text(part));
  if (root.local !== "sld") throw new ReadError("invalid-input", `${part} is not a slide part`);
  const id = sldId !== undefined && KEY_ID.test(sldId) ? sldId : undefined;
  const address = `slide:${id !== undefined ? `#${id}` : `@${n}`}`;
  const scope: SlideScope = { address, flat: [], budget };
  const kids: Node[] = [];
  const tree = shapeTree(root);
  if (tree) walkShapes(tree, 1, scope, kids);

  const counts = new Map<string, number>();
  for (const shape of scope.flat) counts.set(shape.name ?? "", (counts.get(shape.name ?? "") ?? 0) + 1);
  for (const shape of scope.flat) {
    if (shape.name && counts.get(shape.name) === 1) shape.block.aliases = [`${address}/shape:${escapeName(shape.name)}`];
  }
  const titleShape = scope.flat.find((shape) => shape.title && hasText(shape.paras));
  const label = titleShape ? titleShape.paras.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim() : undefined;

  const meta: BlockMeta = { slide_id: id !== undefined && /^\d+$/.test(id) ? Number(id) : null, index: n, shapes: scope.flat.length };
  const show = attr(root, "show");
  if (show === "0" || show === "false") meta.hidden = true;
  const block: Block = { address, kind: "slide", depth: 0, text: "", meta };
  if (id !== undefined) block.aliases = [`slide:@${n}`];
  if (label) block.label = label;
  const slide = makeNode("slide", block, id, undefined, []);
  slide.kids = kids;
  slide.flat = scope.flat;

  const notes = readNotes(zip, part, budget);
  if (hasText(notes)) {
    const notesBlock: Block = { address: `${address}/notes`, kind: "notes", depth: 1, text: joinParas(notes), meta: { paragraphs: notes.length } };
    slide.kids.push(makeNode("notes", notesBlock, undefined, undefined, notes));
  }
  return slide;
}

function presentationPart(zip: ZipArchive): string {
  const office = [...relationshipsOf(zip, "").values()].find((rel) => !rel.external && rel.type.endsWith("/officeDocument"));
  for (const candidate of [office?.target, FALLBACK_PART]) if (candidate !== undefined && zip.has(candidate)) return candidate;
  throw new ReadError("invalid-input", "the package has no presentation part");
}

function readPresentation(bytes: Uint8Array): Node[] {
  const zip = ZipArchive.open(bytes);
  const main = presentationPart(zip);
  const root = parseXml(zip.text(main));
  if (root.local !== "presentation") throw new ReadError("invalid-input", `${main} is not a presentation part`);
  const rels = relationshipsOf(zip, main);
  const list = firstChild(root, "sldIdLst");
  const budget: Budget = { left: MAX_UNITS };
  const slides: Node[] = [];
  for (const entry of list ? childElements(list, "sldId") : []) {
    if (!take(budget)) break;
    const n = slides.length + 1;
    const rid = attr(entry, "r:id");
    const rel = rid === undefined ? undefined : rels.get(rid);
    if (!rel || rel.external || !zip.has(rel.target)) throw new ReadError("invalid-input", `slide ${n} names a part the package does not hold`);
    slides.push(readSlide(zip, rel.target, n, attr(entry, "id"), budget));
  }
  return slides;
}

/** The children of `parent` (the document when undefined) that a segment of `kind` ranges over. */
function candidates(slides: readonly Node[], parent: Node | undefined, kind: string): Node[] {
  if (!parent) return kind === "slide" ? [...slides] : [];
  if (parent.kind === "slide") {
    if (kind === "shape") return parent.flat;
    if (kind === "notes") return parent.kids.filter((kid) => kid.kind === "notes");
  } else if (parent.kind === "shape" && kind === "row") {
    return parent.kids.filter((kid) => kid.kind === "row");
  } else if (parent.kind === "row" && kind === "cell") {
    return parent.kids;
  }
  return [];
}

/** The one candidate `key` (`#id`, `@n`, `~fingerprint[.n]` or a name) selects. */
function pick(nodes: readonly Node[], key: string): Node | undefined {
  if (key.startsWith("#")) return nodes.find((node) => node.id === key.slice(1));
  if (key.startsWith("@")) return KEY_POSITION.test(key) ? nodes[Number(key.slice(1)) - 1] : undefined;
  if (key.startsWith("~")) {
    const match = KEY_FINGERPRINT.exec(key);
    if (!match) return undefined;
    const hits = nodes.filter((node) => fingerprint(node.block.text) === match[1]);
    return match[2] === undefined ? (hits.length === 1 ? hits[0] : undefined) : hits[Number(match[2]) - 1];
  }
  const name = key.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const hits = nodes.filter((node) => node.name === name);
  return hits.length === 1 ? hits[0] : undefined;
}

function hasPara(paras: readonly Para[], key: string): boolean {
  if (key.startsWith("@")) return KEY_POSITION.test(key) && Number(key.slice(1)) <= paras.length;
  const match = key.startsWith("~") ? KEY_FINGERPRINT.exec(key) : null;
  if (!match) return false;
  const hits = paras.filter((para) => fingerprint(para.text) === match[1]);
  return (match[2] === undefined ? (hits.length === 1 ? hits[0] : undefined) : hits[Number(match[2]) - 1]) !== undefined;
}

/** The node `target` names; `para:` and `chart` segments end at their shape (or cell, or notes). */
function resolve(slides: readonly Node[], target: string): Node {
  const fail = (): never => {
    throw new ReadError("address-unresolved", `${target} names nothing in this document`);
  };
  const segments = target.split("/");
  let node: Node | undefined;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    const colon = segment.indexOf(":");
    const kind = colon < 0 ? segment : segment.slice(0, colon);
    const key = colon < 0 ? undefined : segment.slice(colon + 1);
    const last = i === segments.length - 1;
    if (node && last && kind === "para" && key !== undefined) {
      if (!hasPara(node.paras, key)) fail();
      break;
    }
    if (node && last && kind === "chart" && key === undefined) {
      if (node.block.kind !== "chart") fail();
      break;
    }
    const found: Node[] = candidates(slides, node, kind);
    const next: Node | undefined = key === undefined ? (kind === "notes" ? found[0] : undefined) : pick(found, key);
    if (!next) return fail();
    node = next;
  }
  return node ?? fail();
}

function collect(node: Node, out: Block[]): Block[] {
  out.push(node.block);
  for (const kid of node.kids) collect(kid, out);
  return out;
}

const slideNumber = (slide: Node): number => (slide.block.meta?.index as number | undefined) ?? 0;

function textLines(node: Node, out: string[]): void {
  switch (node.kind) {
    case "slide":
      out.push(`# Slide ${slideNumber(node)}${node.block.label ? ` - ${node.block.label}` : ""}`);
      for (const kid of node.kids) textLines(kid, out);
      break;
    case "shape":
      for (const para of node.paras) if (para.text.trim() !== "") out.push(para.text);
      for (const kid of node.kids) textLines(kid, out);
      break;
    case "row":
      if (node.block.text.replace(/\t/g, "").trim() !== "") out.push(node.block.text);
      break;
    case "cell":
      for (const para of node.paras) if (para.text.trim() !== "") out.push(para.text);
      break;
    case "notes":
      out.push("Notes: ");
      for (const para of node.paras) if (para.text.trim() !== "") out.push(para.text);
      break;
  }
}

function pipeTable(rows: readonly Node[]): string | undefined {
  const grid = rows.map((row) => row.kids.map((cell) => cell.block.text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim()));
  const width = grid.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width === 0) return undefined;
  const line = (row: readonly string[]): string => `| ${Array.from({ length: width }, (_, c) => row[c] ?? "").join(" | ")} |`;
  const [head, ...rest] = grid as [string[], ...string[][]];
  return [line(head), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rest.map(line)].join("\n");
}

/** Paragraphs as markdown blocks: runs of bullets form one list, other paragraphs stand alone. */
function paraBlocks(paras: readonly Para[], out: string[]): void {
  let list: string[] = [];
  const flush = (): void => {
    if (list.length > 0) out.push(list.join("\n"));
    list = [];
  };
  for (const para of paras) {
    if (para.text.trim() === "") continue;
    if (para.bullet) {
      const indent = "  ".repeat(para.level);
      list.push(`${indent}- ${para.text.replace(/\n/g, `  \n${indent}  `)}`);
    } else {
      flush();
      out.push(para.text.replace(/\n/g, "  \n"));
    }
  }
  flush();
}

function markdownBlocks(node: Node, out: string[], inSlide: boolean): void {
  switch (node.kind) {
    case "slide": {
      const title = node.block.label;
      out.push(`## Slide ${slideNumber(node)}${title ? `: ${title}` : ""}`);
      for (const kid of node.kids) markdownBlocks(kid, out, true);
      break;
    }
    case "shape": {
      if (inSlide && node.title) break;
      if (node.block.kind === "table") {
        const table = pipeTable(node.kids);
        if (table) out.push(table);
        break;
      }
      paraBlocks(node.paras, out);
      for (const kid of node.kids) markdownBlocks(kid, out, inSlide);
      break;
    }
    case "row": {
      const table = pipeTable([node]);
      if (table) out.push(table);
      break;
    }
    case "cell":
      paraBlocks(node.paras.map((para) => ({ ...para, bullet: false })), out);
      break;
    case "notes": {
      const quoted = node.paras.filter((para) => para.text.trim() !== "").map((para) => para.text.split("\n").map((line) => `> ${line}`).join("\n"));
      if (quoted.length > 0) out.push(quoted.join("\n>\n"));
      break;
    }
  }
}

function collectUnits(node: Node, out: SearchUnit[]): void {
  switch (node.kind) {
    case "cell":
      if (node.block.text.trim() !== "") out.push({ address: node.block.address, text: node.block.text });
      return;
    case "shape":
      node.paras.forEach((para, i) => {
        if (para.text.trim() !== "") out.push({ address: `${node.block.address}/para:@${i + 1}`, text: para.text });
      });
      break;
    case "notes":
      node.paras.forEach((para, i) => {
        if (para.text.trim() !== "") out.push({ address: `${node.block.address}/para:@${i + 1}`, text: para.text });
      });
      break;
  }
  for (const kid of node.kids) collectUnits(kid, out);
}

class PptxDocument implements ReadableDocument {
  readonly format = "pptx" as const;
  readonly #slides: readonly Node[];

  constructor(slides: readonly Node[]) {
    this.#slides = slides;
  }

  /** The nodes a view covers: the target (everything below it comes with it), or every slide. */
  #scope(target: string | undefined): readonly Node[] {
    return target === undefined || target === "" ? this.#slides : [resolve(this.#slides, target)];
  }

  blocks(target?: string): Block[] {
    const out: Block[] = [];
    for (const node of this.#scope(target)) collect(node, out);
    return out;
  }

  text(target?: string): string {
    const lines: string[] = [];
    for (const node of this.#scope(target)) textLines(node, lines);
    return lines.join("\n");
  }

  markdown(target?: string): string {
    const blocks: string[] = [];
    for (const node of this.#scope(target)) markdownBlocks(node, blocks, false);
    return blocks.join("\n\n");
  }

  cells(): CellEntry[] {
    throw new ReadError("unsupported-view", "a presentation has no cells view");
  }

  units(): SearchUnit[] {
    const out: SearchUnit[] = [];
    for (const slide of this.#slides) collectUnits(slide, out);
    return out;
  }
}

/** Parse `bytes` as a PowerPoint package. Throws `ReadError` `invalid-input` for anything that is not one. */
export function openPptx(bytes: Uint8Array): ReadableDocument {
  try {
    return new PptxDocument(readPresentation(bytes));
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("invalid-input", `not a PowerPoint presentation: ${error instanceof Error ? error.message : String(error)}`);
  }
}
