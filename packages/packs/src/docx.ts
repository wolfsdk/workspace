// A Word document as a pack target: tables and bookmarks. The planner reads the document and says, as
// `wolfsdk.agent-api` ops, what has to change to bring the bound targets up to date (nothing, when they are).
// The applier writes those same ops into the package part: it splices the text of `word/document.xml` and
// leaves every other part, and every byte of the document it does not touch, as it was.
import type { RoomOp } from "@wolfsdk/protocol/workspace";
import { PackError } from "./errors.ts";
import { doesNotFit, fits, truncateToFit, type Box } from "./fit.ts";
import { NS, OoxmlPackage } from "./ooxml.ts";
import { fitTable, paddedRow, withoutPrefix, type FitBinding, type Planned } from "./target.ts";
import {
  applySplices,
  childrenNamed,
  descendantsNamed,
  escapeText,
  firstChild,
  firstDescendant,
  isNamed,
  leafText,
  namespace,
  type Splice,
  type XNode,
} from "./xml.ts";

const DEFAULT_SIZE_PT = 11;
/** Letter paper with one inch margins, the page of a document that states none. */
const DEFAULT_CONTENT_WIDTH_PT = (12240 - 2 * 1440) / 20;
const PRESERVED_IN_PARAGRAPH = ["bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "permStart", "permEnd"];
const PLAIN_RUN_CONTENT = ["rPr", "t", "tab", "br", "noBreakHyphen", "softHyphen", "lastRenderedPageBreak"];
const CLONE_IDENTITY = / w14:(?:paraId|textId)="[^"]*"/g;

type Table = { reference: string; node: XNode; rows: XNode[][] };
type Bookmark = { name: string; start: XNode; end: XNode; between: XNode[]; paragraph: XNode };

export class DocxDocument {
  readonly name: string;
  private readonly pkg: OoxmlPackage;
  private readonly part: string;
  private readonly src: string;
  private readonly root: XNode;
  private readonly body: XNode;
  private readonly w: (local: string) => string;

  constructor(bytes: Uint8Array, name: string) {
    this.name = name;
    this.pkg = new OoxmlPackage(bytes);
    const main = this.pkg.relationships("").find((r) => r.type.endsWith("/officeDocument"));
    this.part = main?.target ?? "word/document.xml";
    if (!this.pkg.has(this.part)) throw new PackError("package-missing-part", `${name} is not a docx document: it has no ${this.part}`);
    const { src, root } = this.pkg.xml(this.part);
    this.src = src;
    this.root = root;
    const body = firstChild(root, "body");
    if (body === undefined) throw new PackError("package-bad-xml", `${name}: ${this.part} has no body`);
    this.body = body;
    this.w = namespace(root, NS.word, "w");
  }

  save(): Uint8Array {
    return this.pkg.save();
  }

  // Reading ----------------------------------------------------------------------------------------------

  /** The text under `node` as a reader sees it: tabs and breaks as characters, deleted text and drawings left out. */
  private textOf(node: XNode): string {
    let out = "";
    const visit = (n: XNode): void => {
      if (isNamed(n, "del") || isNamed(n, "drawing") || isNamed(n, "pict") || isNamed(n, "instrText")) return;
      if (isNamed(n, "t")) out += leafText(this.src, n);
      else if (isNamed(n, "tab")) out += "\t";
      else if (isNamed(n, "br") || isNamed(n, "cr")) out += "\n";
      else n.children.forEach(visit);
    };
    visit(node);
    return out;
  }

  private cellText(cell: XNode): string {
    return childrenNamed(cell, "p")
      .map((p) => this.textOf(p))
      .join("\n");
  }

  private table(address: string): Table {
    const reference = withoutPrefix(address, "table:");
    if (reference.startsWith("~")) {
      throw new PackError("unsupported-address", `the table address ${JSON.stringify(address)} is a text fingerprint, which a pack does not resolve: name the table by its caption or by position (table:@n)`);
    }
    const tables = childrenNamed(this.body, "tbl");
    let found: XNode[];
    if (/^@\d+$/.test(reference)) {
      const at = tables[Number(reference.slice(1)) - 1];
      found = at === undefined ? [] : [at];
    } else {
      found = tables.filter((t) => {
        const caption = firstChild(firstChild(t, "tblPr") ?? t, "tblCaption");
        return caption?.attrs[this.w("val")] === reference;
      });
    }
    if (found.length === 0) throw new PackError("address-unresolved", `${this.name} has no table ${JSON.stringify(address)}`);
    const [node] = found;
    if (found.length > 1 || node === undefined) throw new PackError("address-ambiguous", `${this.name} has several tables ${JSON.stringify(address)}`);
    const rows = childrenNamed(node, "tr").map((tr) => childrenNamed(tr, "tc"));
    const width = rows[0]?.length ?? 0;
    if (width === 0) throw new PackError("unsupported-target", `the table ${JSON.stringify(address)} of ${this.name} has no cells`);
    for (const cells of rows) {
      const merged = cells.some((c) => descendantsNamed(c, "tcPr").some((pr) => firstChild(pr, "gridSpan") !== undefined || firstChild(pr, "vMerge") !== undefined || firstChild(pr, "hMerge") !== undefined));
      if (merged || cells.length !== width) {
        throw new PackError("unsupported-target", `the table ${JSON.stringify(address)} of ${this.name} has merged or ragged cells, which a pack does not fill`);
      }
    }
    return { reference, node, rows };
  }

  private bookmark(address: string): Bookmark {
    const name = withoutPrefix(address, "bookmark:");
    const starts = descendantsNamed(this.body, "bookmarkStart").filter((s) => s.attrs[this.w("name")] === name);
    const [start] = starts;
    if (start === undefined) throw new PackError("address-unresolved", `${this.name} has no bookmark ${JSON.stringify(name)}`);
    if (starts.length > 1) throw new PackError("address-ambiguous", `${this.name} has several bookmarks named ${JSON.stringify(name)}`);
    const id = start.attrs[this.w("id")];
    const parent = start.parent;
    const siblings = parent?.children ?? [];
    const end = siblings.find((s) => isNamed(s, "bookmarkEnd") && s.attrs[this.w("id")] === id);
    if (parent === null || end === undefined || !isNamed(parent, "p")) {
      throw new PackError("unsupported-target", `the bookmark ${JSON.stringify(name)} of ${this.name} does not start and end in one paragraph, which a pack does not fill`);
    }
    const between = siblings.slice(siblings.indexOf(start) + 1, siblings.indexOf(end));
    for (const node of between) {
      if (isNamed(node, "r")) {
        if (node.children.some((c) => !PLAIN_RUN_CONTENT.some((n) => isNamed(c, n)))) {
          throw new PackError("unsupported-target", `the bookmark ${JSON.stringify(name)} of ${this.name} holds a field, picture or other run content that a refresh would lose`);
        }
      } else if (!PRESERVED_IN_PARAGRAPH.concat("proofErr").some((n) => isNamed(node, n))) {
        throw new PackError("unsupported-target", `the bookmark ${JSON.stringify(name)} of ${this.name} holds a ${node.name} element that a refresh would lose`);
      }
    }
    return { name, start, end, between, paragraph: parent };
  }

  // Fit --------------------------------------------------------------------------------------------------

  private defaultSizePt(): number {
    if (!this.pkg.has("word/styles.xml")) return DEFAULT_SIZE_PT;
    const { root } = this.pkg.xml("word/styles.xml");
    const sz = firstDescendant(firstDescendant(root, "rPrDefault") ?? root, "sz");
    const half = Number(sz?.attrs[namespace(root, NS.word, "w")("val")]);
    return Number.isFinite(half) && half > 0 ? half / 2 : DEFAULT_SIZE_PT;
  }

  /** Font size of a paragraph as the first run that states one gives it, in points. */
  private sizeOf(nodes: readonly XNode[]): number {
    for (const node of nodes) {
      for (const run of isNamed(node, "r") ? [node] : descendantsNamed(node, "r")) {
        const half = Number(firstChild(firstChild(run, "rPr") ?? run, "sz")?.attrs[this.w("val")]);
        if (Number.isFinite(half) && half > 0) return half / 2;
      }
    }
    return this.defaultSizePt();
  }

  private cellWidthTwips(cell: XNode): number {
    const tcW = firstChild(firstChild(cell, "tcPr") ?? cell, "tcW");
    const twips = Number(tcW?.attrs[this.w("w")]);
    if (tcW?.attrs[this.w("type")] !== "pct" && twips > 0) return twips;
    const row = cell.parent;
    const table = row?.parent;
    const grid = row === null || table === null || table === undefined ? undefined : childrenNamed(firstChild(table, "tblGrid") ?? table, "gridCol")[childrenNamed(row, "tc").indexOf(cell)];
    const gridTwips = Number(grid?.attrs[this.w("w")]);
    return gridTwips > 0 ? gridTwips : DEFAULT_CONTENT_WIDTH_PT * 20;
  }

  /** The width one line of `paragraph` has: its table cell, else the page, less the paragraph's indents. */
  private lineWidthPt(paragraph: XNode): number {
    let width = DEFAULT_CONTENT_WIDTH_PT;
    const cell = enclosing(paragraph, "tc");
    if (cell !== null) {
      width = this.cellWidthTwips(cell) / 20;
    } else {
      const section = [...this.body.children].reverse().find((c) => isNamed(c, "sectPr"));
      const size = section === undefined ? undefined : firstChild(section, "pgSz");
      const margin = section === undefined ? undefined : firstChild(section, "pgMar");
      const page = Number(size?.attrs[this.w("w")]);
      const left = Number(margin?.attrs[this.w("left")]);
      const right = Number(margin?.attrs[this.w("right")]);
      if ([page, left, right].every(Number.isFinite)) width = (page - left - right) / 20;
    }
    const indent = firstChild(firstChild(paragraph, "pPr") ?? paragraph, "ind");
    const inset = (...names: string[]): number => names.map((n) => Number(indent?.attrs[this.w(n)])).find(Number.isFinite) ?? 0;
    return Math.max(0, width - (inset("left", "start") + inset("right", "end")) / 20);
  }

  // Planning ---------------------------------------------------------------------------------------------

  planTable(binding: FitBinding, texts: readonly (readonly string[])[]): Planned {
    const table = this.table(binding.target_address);
    const what = `the table ${JSON.stringify(binding.target_address)} of ${this.name}`;
    const rowCount = texts.length;
    const columnCount = texts[0]?.length ?? 0;
    const fit = fitTable(binding, what, { rows: rowCount, columns: columnCount }, { rows: table.rows.length, columns: table.rows[0]?.length ?? 0 });
    const ops: RoomOp[] = [];
    for (let r = 0; r < fit.writeRows; r++) {
      for (let c = 0; c < fit.writeColumns; c++) {
        const cell = table.rows[r]?.[c];
        const text = texts[r]?.[c] ?? "";
        if (cell !== undefined && this.cellText(cell) !== text) ops.push({ op: "set", target: `table:${table.reference}/row:@${r + 1}/cell:@${c + 1}`, value: { text } });
      }
    }
    // Each new row follows the one before it: a batch applied in order puts the rows in the order of the source.
    for (let r = table.rows.length; r < table.rows.length + fit.growRows; r++) {
      ops.push({
        op: "insert-row",
        anchor: `table:${table.reference}/row:@${r}`,
        position: "after",
        cells: paddedRow(texts[r] ?? [], table.rows[0]?.length ?? 0),
      });
    }
    return { ops, notes: fit.notes };
  }

  planBookmark(binding: FitBinding, value: string): Planned {
    const bookmark = this.bookmark(binding.target_address);
    const box: Box = { widthPt: this.lineWidthPt(bookmark.paragraph), heightPt: null };
    const size = this.sizeOf([...bookmark.between, bookmark.paragraph]);
    const what = `the line of bookmark ${JSON.stringify(bookmark.name)} of ${this.name}`;
    const notes: string[] = [];
    let text = value;
    if (binding.fit_policy === "fail" && !fits(value, size, box)) throw doesNotFit(what, value);
    if (binding.fit_policy === "truncate") {
      const cut = truncateToFit(value, size, box);
      if (cut === null) throw doesNotFit(what, value);
      if (cut !== value) notes.push(`the value is truncated to fit ${what}`);
      text = cut;
    }
    const current = bookmark.between.map((n) => this.textOf(n)).join("");
    return { ops: current === text ? [] : [{ op: "set", target: `bookmark:${bookmark.name}`, value: { text } }], notes };
  }

  // Applying ---------------------------------------------------------------------------------------------

  /** Write `ops`, as `planTable` and `planBookmark` made them, into the document. Every address resolves against
   * the document as it is now, except that an `insert-row` after the last row, or after the row the op before it
   * appended, appends one more row; nothing is written when any op is refused. The document is spent after one
   * `apply`: open `save()` again to read what it wrote. */
  apply(ops: readonly RoomOp[]): void {
    const splices: Splice[] = [];
    const appended = new Map<string, number>();
    ops.forEach((op, order) => {
      const target = typeof op.target === "string" ? op.target : "";
      const text = typeof op.value === "object" && op.value !== null && "text" in op.value && typeof op.value.text === "string" ? op.value.text : undefined;
      if (op.op === "set" && target.startsWith("bookmark:") && text !== undefined) {
        splices.push(...this.bookmarkSplices(this.bookmark(target), text, order));
      } else if (op.op === "set" && text !== undefined) {
        const { cell } = this.cellAt(target);
        splices.push(...this.cellSplices(cell, text, order));
      } else if (op.op === "insert-row" && typeof op.anchor === "string" && Array.isArray(op.cells) && (op.position === "before" || op.position === "after")) {
        const { rowNode, cells, tail } = this.anchorRow(op.anchor, op.position, appended);
        const cellTexts: unknown[] = op.cells;
        if (cellTexts.length > cells.length || !cellTexts.every((t) => typeof t === "string")) {
          throw new PackError("table-row-width-mismatch", `an insert-row of ${this.name} has ${cellTexts.length} cells, the anchor row has ${cells.length}`);
        }
        splices.push(this.rowClone(rowNode, cells, cellTexts.map(String), op.position, order));
        if (tail !== null) appended.set(tail, (appended.get(tail) ?? 0) + 1);
      } else {
        throw new PackError("unsupported-op", `${this.name}: a pack applies set on a table cell or a bookmark and insert-row on a table, not ${JSON.stringify(op).slice(0, 120)}`);
      }
    });
    if (splices.length > 0) this.pkg.setText(this.part, applySplices(this.src, splices, this.part));
  }

  /** The row an `insert-row` anchors on; `tail` is the table the insert appends a row to, when it is after the last
   * row or after a row this batch appended (the row then cloned is the last one the table has). */
  private anchorRow(anchor: string, position: string, appended: ReadonlyMap<string, number>): { rowNode: XNode; cells: XNode[]; tail: string | null } {
    const m = /^(table:.+?)\/row:@(\d+)$/.exec(anchor);
    if (m === null) throw new PackError("address-unresolved", `${JSON.stringify(anchor)} is not a table row address of the form table:<caption | @n>/row:@r`);
    const table = this.table(m[1] ?? "");
    const atTail = position === "after" && Number(m[2]) === table.rows.length + (appended.get(table.reference) ?? 0);
    const { rowNode, cells } = this.cellAt(`${m[1]}/row:@${atTail ? table.rows.length : m[2]}/cell:@1`);
    return { rowNode, cells, tail: atTail ? table.reference : null };
  }

  private cellAt(address: string): { cell: XNode; rowNode: XNode; cells: XNode[] } {
    const m = /^(table:.+?)\/row:@(\d+)(?:\/cell:@(\d+))?$/.exec(address);
    if (m === null) throw new PackError("address-unresolved", `${JSON.stringify(address)} is not a table row or cell address of the form table:<caption | @n>/row:@r/cell:@c`);
    const table = this.table(m[1] ?? "");
    const cells = table.rows[Number(m[2]) - 1];
    const rowNode = childrenNamed(table.node, "tr")[Number(m[2]) - 1];
    const cell = cells?.[Number(m[3] ?? 1) - 1];
    if (cells === undefined || rowNode === undefined || cell === undefined) throw new PackError("address-unresolved", `${this.name} has no ${JSON.stringify(address)}`);
    return { cell, rowNode, cells };
  }

  private runs(text: string, properties: string): string {
    const w = this.w;
    return text
      .split(/(\r\n|\n|\r|\t)/)
      .filter((part) => part !== "")
      .map((part) => {
        const content = part === "\t" ? `<${w("tab")}/>` : /^(\r\n|\n|\r)$/.test(part) ? `<${w("br")}/>` : `<${w("t")} xml:space="preserve">${escapeText(part)}</${w("t")}>`;
        return `<${w("r")}>${properties}${content}</${w("r")}>`;
      })
      .join("");
  }

  /** `paragraph` with its content replaced by `text` in the formatting of its first run; its properties and any
   * bookmark or comment anchor it carries stay. */
  private paragraphWith(paragraph: XNode, text: string): string {
    const open = paragraph.selfClosing ? `${this.src.slice(paragraph.start, paragraph.end - 2).trimEnd()}>` : this.src.slice(paragraph.start, paragraph.openEnd);
    const pPr = firstChild(paragraph, "pPr");
    const firstRun = firstDescendant(paragraph, "r");
    const rPr = firstChild(firstRun ?? paragraph, "rPr") ?? (pPr === undefined ? undefined : firstChild(pPr, "rPr"));
    const kept = paragraph.children.filter((c) => PRESERVED_IN_PARAGRAPH.some((n) => isNamed(c, n))).map((c) => this.src.slice(c.start, c.end));
    const inner = (pPr === undefined ? "" : this.src.slice(pPr.start, pPr.end)) + kept.join("") + this.runs(text, rPr === undefined ? "" : this.src.slice(rPr.start, rPr.end));
    return `${open}${inner}</${paragraph.name}>`;
  }

  private cellSplices(cell: XNode, text: string, order: number): Splice[] {
    const [first, ...rest] = childrenNamed(cell, "p");
    if (first === undefined) throw new PackError("unsupported-target", `a table cell of ${this.name} has no paragraph`);
    return [
      { start: first.start, end: first.end, text: this.paragraphWith(first, text), order },
      ...rest.map((p) => ({ start: p.start, end: p.end, text: "", order })),
    ];
  }

  private bookmarkSplices(bookmark: Bookmark, text: string, order: number): Splice[] {
    const firstRun = bookmark.between.find((n) => isNamed(n, "r"));
    const rPr = firstChild(firstRun ?? bookmark.paragraph, "rPr");
    const removed = bookmark.between.filter((n) => isNamed(n, "r") || isNamed(n, "proofErr")).map((n) => ({ start: n.start, end: n.end, text: "", order }));
    return [...removed, { start: bookmark.start.end, end: bookmark.start.end, text: this.runs(text, rPr === undefined ? "" : this.src.slice(rPr.start, rPr.end)), order }];
  }

  private rowClone(row: XNode, cells: XNode[], texts: readonly string[], position: "before" | "after", order: number): Splice {
    for (const cell of cells) {
      if (descendantsNamed(cell, "fldChar").length > 0 || descendantsNamed(cell, "fldSimple").length > 0 || descendantsNamed(cell, "ins").length > 0 || descendantsNamed(cell, "del").length > 0) {
        throw new PackError("op-kind-mismatch", `the anchor row of an insert-row in ${this.name} holds a field or a tracked revision`);
      }
    }
    const cellSplices = cells.flatMap((cell, i) => this.cellSplices(cell, texts[i] ?? "", order).map((s) => ({ ...s, start: s.start - row.start, end: s.end - row.start })));
    const clone = applySplices(this.src.slice(row.start, row.end), cellSplices, this.part).replace(CLONE_IDENTITY, "");
    const at = position === "after" ? row.end : row.start;
    return { start: at, end: at, text: clone, order };
  }
}

function enclosing(node: XNode, name: string): XNode | null {
  for (let at = node.parent; at !== null; at = at.parent) if (isNamed(at, name)) return at;
  return null;
}
