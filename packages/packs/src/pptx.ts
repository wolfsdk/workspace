// A PowerPoint deck as a pack target: tables, headlines and chart series. As for Word, the planner reads the deck
// and says in agent-api ops what must change, and the applier writes those same ops into the slide and chart
// parts by splicing their text; no other part, and no byte of a part it does not edit, changes.
import type { RoomOp } from "@wolfsdk/protocol/workspace";
import { Chart } from "./chart.ts";
import { PackError } from "./errors.ts";
import { doesNotFit, fits, shrinkedSize, truncateToFit, type Box } from "./fit.ts";
import { plainNumber } from "./numfmt.ts";
import { NS, OoxmlPackage } from "./ooxml.ts";
import { fitTable, paddedRow, type FitBinding, type Planned } from "./target.ts";
import { applySplices, childrenNamed, descendantsNamed, escapeText, firstChild, firstDescendant, isNamed, leafText, namespace, type Splice, type XNode } from "./xml.ts";

const EMU_PER_POINT = 12700;
const DEFAULT_SIZE_PT = 18;
const DEFAULT_INSETS_EMU = { lIns: 91440, rIns: 91440, tIns: 45720, bIns: 45720 };
const SHAPE_ELEMENTS = ["sp", "graphicFrame", "pic", "grpSp", "cxnSp"];
const MERGE_ATTRIBUTES = ["gridSpan", "rowSpan", "hMerge", "vMerge"];

type Parsed = { part: string; src: string; root: XNode };
type Slide = { id: string; part: string };
type Located = { parsed: Parsed; node: XNode };
type Shape = Located & { slide: Slide; id: string };
type Cache = Map<string, Parsed>;

type Address = { slide: string | null; shape: string; row: number | null; cell: number | null; chart: boolean; series: string | null; point: number | null };

/** `slide:<#id | @n>/shape:<#id | name | @n>` then optionally `/row:@r/cell:@c` (a table cell), or `/chart/series:<name | @n>/point:@n`. */
function parseAddress(address: string): Address {
  const segments = address.split("/");
  let at = 0;
  const take = (key: string): string | null => {
    const segment = segments[at];
    if (segment === undefined || !segment.startsWith(`${key}:`)) return null;
    at++;
    return segment.slice(key.length + 1);
  };
  const position = (key: string): number | null => {
    const value = take(key);
    if (value === null) return null;
    if (!/^@[1-9]\d*$/.test(value)) throw new PackError("unsupported-address", `${JSON.stringify(address)}: a ${key} is named by position (${key}:@n) in a pack`);
    return Number(value.slice(1));
  };
  const slide = take("slide");
  const shape = take("shape");
  if (shape === null) throw new PackError("bad-target-address", `${JSON.stringify(address)} is not a shape address: slide:<#id | @n>/shape:<#id | name | @n>`);
  const row = position("row");
  const cell = row === null ? null : position("cell");
  const chart = row === null && segments[at] === "chart";
  if (chart) at++;
  const series = row === null ? take("series") : null;
  const point = series === null ? null : position("point");
  if (at !== segments.length) throw new PackError("bad-target-address", `${JSON.stringify(address)} is not a shape, table cell or chart point address`);
  if ((slide ?? "").startsWith("~") || shape.startsWith("~")) {
    throw new PackError("unsupported-address", `${JSON.stringify(address)} names a text fingerprint, which a pack does not resolve: use #id, a name or @n`);
  }
  return { slide, shape, row, cell, chart, series, point };
}

/** `rPr` (the source of an `a:rPr` or `a:endParaRPr`) with the size `sizePt`; a missing one is made. */
function withSize(rPr: string | undefined, sizePt: number, tag: string): string {
  const sz = Math.round(sizePt * 100);
  if (rPr === undefined) return `<${tag} sz="${sz}"/>`;
  const open = /^<[^>]*/.exec(rPr)?.[0] ?? "";
  const resized = /\ssz="\d+"/.test(open) ? open.replace(/\ssz="\d+"/, ` sz="${sz}"`) : open.replace(/^<[^\s>/]+/, (name) => `${name} sz="${sz}"`);
  return resized + rPr.slice(open.length);
}

const kindOf = (type: string | undefined): string => (type === "title" || type === "ctrTitle" ? "title" : type === undefined || type === "body" || type === "subTitle" || type === "obj" ? "body" : type);

export class PptxDocument {
  readonly name: string;
  private readonly pkg: OoxmlPackage;
  private readonly slides: Slide[];

  constructor(bytes: Uint8Array, name: string) {
    this.name = name;
    this.pkg = new OoxmlPackage(bytes);
    const main = this.pkg.relationships("").find((r) => r.type.endsWith("/officeDocument"));
    const presentation = main?.target ?? "ppt/presentation.xml";
    if (!this.pkg.has(presentation)) throw new PackError("package-missing-part", `${name} is not a pptx document: it has no ${presentation}`);
    const { root } = this.pkg.xml(presentation);
    const rId = namespace(root, NS.relationships, "r")("id");
    const relationships = this.pkg.relationships(presentation);
    const list = firstChild(root, "sldIdLst");
    this.slides = (list === undefined ? [] : childrenNamed(list, "sldId")).map((s) => {
      const rel = relationships.find((r) => r.id === s.attrs[rId]);
      if (rel === undefined) throw new PackError("package-bad-relationship", `${name}: slide ${s.attrs.id} has no relationship ${JSON.stringify(s.attrs[rId])}`);
      return { id: s.attrs.id ?? "", part: rel.target };
    });
  }

  save(): Uint8Array {
    return this.pkg.save();
  }

  // Resolving --------------------------------------------------------------------------------------------

  private parsed(cache: Cache, part: string): Parsed {
    let parsed = cache.get(part);
    if (parsed === undefined) {
      const { src, root } = this.pkg.xml(part);
      parsed = { part, src, root };
      cache.set(part, parsed);
    }
    return parsed;
  }

  private shapesOf(parsed: Parsed): XNode[] {
    const tree = firstDescendant(parsed.root, "spTree");
    return tree === undefined ? [] : tree.children.filter((c) => SHAPE_ELEMENTS.some((n) => isNamed(c, n)));
  }

  private slideOf(reference: string, address: string): Slide {
    const slide = reference.startsWith("#") ? this.slides.find((s) => s.id === reference.slice(1)) : /^@\d+$/.test(reference) ? this.slides[Number(reference.slice(1)) - 1] : undefined;
    if (slide === undefined) throw new PackError("address-unresolved", `${this.name} has no slide ${JSON.stringify(reference)} (in ${JSON.stringify(address)}); a slide is #id or @n`);
    return slide;
  }

  private shape(cache: Cache, address: Address, text: string): Shape {
    if (address.slide === null && address.shape.startsWith("@")) {
      throw new PackError("unsupported-address", `${JSON.stringify(text)}: a shape by position needs its slide (slide:<#id | @n>/shape:@n)`);
    }
    const slides = address.slide === null ? this.slides : [this.slideOf(address.slide, text)];
    const found: Shape[] = [];
    for (const slide of slides) {
      const parsed = this.parsed(cache, slide.part);
      this.shapesOf(parsed).forEach((node, i) => {
        const props = firstDescendant(node, "cNvPr");
        const matches = address.shape.startsWith("#") ? props?.attrs.id === address.shape.slice(1) : address.shape.startsWith("@") ? i + 1 === Number(address.shape.slice(1)) : props?.attrs.name === address.shape;
        if (matches) found.push({ parsed, node, slide, id: props?.attrs.id ?? "" });
      });
    }
    const [shape] = found;
    if (shape === undefined) throw new PackError("address-unresolved", `${this.name} has no shape ${JSON.stringify(text)}`);
    if (found.length > 1) throw new PackError("address-ambiguous", `${this.name} has several shapes ${JSON.stringify(text)}`);
    return shape;
  }

  private canonical(shape: Shape): string {
    return `slide:#${shape.slide.id}/shape:#${shape.id}`;
  }

  private tableOf(shape: Shape, text: string): { rows: XNode[]; cells: XNode[][] } {
    const table = firstDescendant(shape.node, "tbl");
    if (table === undefined) throw new PackError("unsupported-target", `${this.name}: ${JSON.stringify(text)} is not a table`);
    const rows = childrenNamed(table, "tr");
    const cells = rows.map((r) => childrenNamed(r, "tc"));
    const width = cells[0]?.length ?? 0;
    if (width === 0) throw new PackError("unsupported-target", `the table ${JSON.stringify(text)} of ${this.name} has no cells`);
    if (cells.some((row) => row.length !== width || row.some((c) => MERGE_ATTRIBUTES.some((a) => c.attrs[a] !== undefined)))) {
      throw new PackError("unsupported-target", `the table ${JSON.stringify(text)} of ${this.name} has merged or ragged cells, which a pack does not fill`);
    }
    return { rows, cells };
  }

  private paragraphText(parsed: Parsed, paragraph: XNode): string {
    let out = "";
    for (const child of paragraph.children) {
      if (isNamed(child, "br")) out += "\n";
      else if (isNamed(child, "r") || isNamed(child, "fld")) for (const t of childrenNamed(child, "t")) out += leafText(parsed.src, t);
    }
    return out;
  }

  private bodyText(parsed: Parsed, owner: XNode): string {
    const body = firstChild(owner, "txBody");
    return body === undefined
      ? ""
      : childrenNamed(body, "p")
          .map((p) => this.paragraphText(parsed, p))
          .join("\n");
  }

  // Fit --------------------------------------------------------------------------------------------------

  /** The shape and the layout and master shapes it inherits from, nearest first. */
  private chain(cache: Cache, shape: Shape): Located[] {
    const chain: Located[] = [{ parsed: shape.parsed, node: shape.node }];
    const ph = firstDescendant(shape.node, "ph");
    const layoutRel = this.pkg.relationships(shape.slide.part).find((r) => r.type.endsWith("/slideLayout"));
    if (ph === undefined || layoutRel === undefined) return chain;
    const layout = this.parsed(cache, layoutRel.target);
    const inLayout = this.shapesOf(layout).find((s) => {
      const p = firstDescendant(s, "ph");
      return p !== undefined && (ph.attrs.idx !== undefined ? p.attrs.idx === ph.attrs.idx : kindOf(p.attrs.type) === kindOf(ph.attrs.type));
    });
    if (inLayout !== undefined) chain.push({ parsed: layout, node: inLayout });
    const masterRel = this.pkg.relationships(layoutRel.target).find((r) => r.type.endsWith("/slideMaster"));
    if (masterRel === undefined) return chain;
    const master = this.parsed(cache, masterRel.target);
    const inMaster = this.shapesOf(master).find((s) => {
      const p = firstDescendant(s, "ph");
      return p !== undefined && kindOf(p.attrs.type) === kindOf(ph.attrs.type);
    });
    if (inMaster !== undefined) chain.push({ parsed: master, node: inMaster });
    return chain;
  }

  private boxOf(chain: readonly Located[], text: string): Box {
    let extent: XNode | undefined;
    for (const located of chain) {
      const spPr = firstChild(located.node, "spPr");
      const xfrm = spPr === undefined ? undefined : firstChild(spPr, "xfrm");
      extent = xfrm === undefined ? undefined : firstChild(xfrm, "ext");
      if (extent !== undefined) break;
    }
    const cx = Number(extent?.attrs.cx);
    const cy = Number(extent?.attrs.cy);
    if (!(cx > 0 && cy > 0)) throw new PackError("unsupported-target", `${this.name}: ${JSON.stringify(text)} has no size, neither its own nor from its layout`);
    const inset = (name: keyof typeof DEFAULT_INSETS_EMU): number => {
      for (const located of chain) {
        const body = firstChild(located.node, "txBody");
        const value = Number(body === undefined ? undefined : firstChild(body, "bodyPr")?.attrs[name]);
        if (Number.isFinite(value)) return value;
      }
      return DEFAULT_INSETS_EMU[name];
    };
    return { widthPt: Math.max(0, cx - inset("lIns") - inset("rIns")) / EMU_PER_POINT, heightPt: Math.max(0, cy - inset("tIns") - inset("bIns")) / EMU_PER_POINT };
  }

  /** The size of a shape's text in points: its first run's, else its list style's, its layout's, its master's. */
  private sizeOf(cache: Cache, shape: Shape, chain: readonly Located[]): number {
    const own = firstDescendant(shape.node, "rPr");
    const ownSize = Number(own?.attrs.sz);
    if (ownSize > 0) return ownSize / 100;
    const levelSize = (node: XNode): number => {
      const body = firstChild(node, "txBody");
      const style = body === undefined ? undefined : firstChild(body, "lstStyle");
      const level = style === undefined ? undefined : firstChild(style, "lvl1pPr");
      const defaults = level === undefined ? undefined : firstChild(level, "defRPr");
      return Number(defaults?.attrs.sz);
    };
    for (const located of chain) if (levelSize(located.node) > 0) return levelSize(located.node) / 100;
    const layoutRel = this.pkg.relationships(shape.slide.part).find((r) => r.type.endsWith("/slideLayout"));
    const masterRel = layoutRel === undefined ? undefined : this.pkg.relationships(layoutRel.target).find((r) => r.type.endsWith("/slideMaster"));
    if (masterRel !== undefined) {
      const ph = firstDescendant(shape.node, "ph");
      const styles = firstDescendant(this.parsed(cache, masterRel.target).root, "txStyles");
      const style = styles === undefined ? undefined : firstChild(styles, ph === undefined ? "otherStyle" : kindOf(ph.attrs.type) === "title" ? "titleStyle" : "bodyStyle");
      const level = style === undefined ? undefined : firstChild(style, "lvl1pPr");
      const size = Number((level === undefined ? undefined : firstChild(level, "defRPr"))?.attrs.sz);
      if (size > 0) return size / 100;
    }
    return DEFAULT_SIZE_PT;
  }

  // Planning ---------------------------------------------------------------------------------------------

  planTable(binding: FitBinding, texts: readonly (readonly string[])[]): Planned {
    const cache: Cache = new Map();
    const address = binding.target_address;
    const shape = this.shape(cache, parseAddress(address), address);
    const { cells } = this.tableOf(shape, address);
    const width = cells[0]?.length ?? 0;
    const fit = fitTable(binding, `the table ${JSON.stringify(address)} of ${this.name}`, { rows: texts.length, columns: texts[0]?.length ?? 0 }, { rows: cells.length, columns: width });
    const base = this.canonical(shape);
    const ops: RoomOp[] = [];
    for (let r = 0; r < fit.writeRows; r++) {
      for (let c = 0; c < fit.writeColumns; c++) {
        const cell = cells[r]?.[c];
        const text = texts[r]?.[c] ?? "";
        if (cell !== undefined && this.bodyText(shape.parsed, cell) !== text) ops.push({ op: "set", target: `${base}/row:@${r + 1}/cell:@${c + 1}`, value: { text } });
      }
    }
    // Each new row follows the one before it: a batch applied in order puts the rows in the order of the source.
    for (let r = cells.length; r < cells.length + fit.growRows; r++) {
      ops.push({ op: "insert-row", anchor: `${base}/row:@${r}`, position: "after", cells: paddedRow(texts[r] ?? [], width) });
    }
    return { ops, notes: fit.notes };
  }

  planHeadline(binding: FitBinding, value: string): Planned {
    const cache: Cache = new Map();
    const address = binding.target_address;
    const shape = this.shape(cache, parseAddress(address), address);
    if (firstChild(shape.node, "txBody") === undefined) throw new PackError("unsupported-target", `${this.name}: ${JSON.stringify(address)} has no text`);
    const chain = this.chain(cache, shape);
    const box = this.boxOf(chain, address);
    const size = this.sizeOf(cache, shape, chain);
    const what = `the headline ${JSON.stringify(address)} of ${this.name}`;
    const notes: string[] = [];
    let text = value;
    let newSize = size;
    if (binding.fit_policy === "fail" && !fits(value, size, box)) throw doesNotFit(what, value);
    if (binding.fit_policy === "truncate") {
      const cut = truncateToFit(value, size, box);
      if (cut === null) throw doesNotFit(what, value);
      if (cut !== value) notes.push(`the value is truncated to fit ${what}`);
      text = cut;
    }
    if (binding.fit_policy === "shrink_to_fit") {
      const shrunk = shrinkedSize(value, size, box);
      if (shrunk === null) throw doesNotFit(what, value);
      if (shrunk !== size) notes.push(`the text of ${what} shrinks from ${size} to ${shrunk} points`);
      newSize = shrunk;
    }
    const target = this.canonical(shape);
    const ops: RoomOp[] = [];
    if (this.bodyText(shape.parsed, shape.node) !== text) ops.push({ op: "set", target, value: { text } });
    if (newSize !== size) ops.push({ op: "format", target, format: { font: { size: newSize } } });
    return { ops, notes };
  }

  private chartOf(shape: Shape, address: string): Chart {
    const reference = firstDescendant(shape.node, "chart");
    const rId = namespace(shape.parsed.root, NS.relationships, "r")("id");
    const rel = reference === undefined ? undefined : this.pkg.relationships(shape.slide.part).find((r) => r.id === reference.attrs[rId]);
    if (rel === undefined) throw new PackError("unsupported-target", `${this.name}: ${JSON.stringify(address)} is not a chart`);
    return new Chart(this.pkg, rel.target);
  }

  planChartSeries(binding: FitBinding, values: readonly number[]): Planned {
    const cache: Cache = new Map();
    const address = binding.target_address;
    const parsed = parseAddress(address);
    if (parsed.series === null) throw new PackError("bad-target-address", `${JSON.stringify(address)} names no series: ...shape:<#id | name | @n>/chart/series:<name | @n>`);
    const shape = this.shape(cache, parsed, address);
    const chart = this.chartOf(shape, address);
    const { capacity, values: current } = chart.read(chart.series(parsed.series));
    const what = `the series ${JSON.stringify(address)} of ${this.name}`;
    const notes: string[] = [];
    if (values.length > capacity) {
      if (binding.fit_policy === "fail") throw new PackError("series-overflow", `${what} has ${capacity} points, the source has ${values.length}`);
      notes.push(`${values.length - capacity} source values do not fit ${what} and are not written`);
    }
    const base = `${this.canonical(shape)}/chart/series:${parsed.series}`;
    const ops: RoomOp[] = [];
    for (let i = 0; i < Math.min(values.length, capacity); i++) {
      const value = values[i] ?? 0;
      if (current.get(i) !== Number(plainNumber(value))) ops.push({ op: "set", target: `${base}/point:@${i + 1}`, value: { number: value } });
    }
    if (values.length < capacity) notes.push(`${capacity - values.length} points of ${what} are not bound and keep their value`);
    return { ops, notes };
  }

  // Applying ---------------------------------------------------------------------------------------------

  /** Write `ops`, as the planners made them, into the deck. Every address resolves against the deck as it is now,
   * except that an `insert-row` after the last row, or after the row the op before it appended, appends one more
   * row; nothing is written when any op is refused. The deck is spent after one `apply`: open `save()` again to
   * read what it wrote. */
  apply(ops: readonly RoomOp[]): void {
    const cache: Cache = new Map();
    const splices = new Map<string, Splice[]>();
    const appended = new Map<XNode, number>();
    const add = (part: string, more: Splice[]): void => {
      splices.set(part, [...(splices.get(part) ?? []), ...more]);
    };
    const shapeEdits = new Map<XNode, { shape: Shape; text?: string; size?: number; order: number }>();
    const charts = new Map<string, { chart: Chart; changes: { series: XNode; points: Map<number, number>; order: number }[] }>();
    const editOf = (shape: Shape, order: number) => {
      let edit = shapeEdits.get(shape.node);
      if (edit === undefined) {
        edit = { shape, order };
        shapeEdits.set(shape.node, edit);
      }
      return edit;
    };

    ops.forEach((op, order) => {
      const target = typeof op.target === "string" ? op.target : typeof op.anchor === "string" ? op.anchor : "";
      const value = typeof op.value === "object" && op.value !== null ? op.value : undefined;
      const text = value !== undefined && "text" in value && typeof value.text === "string" ? value.text : undefined;
      const number = value !== undefined && "number" in value && typeof value.number === "number" ? value.number : undefined;
      const font = typeof op.format === "object" && op.format !== null && "font" in op.format ? op.format.font : undefined;
      const size = typeof font === "object" && font !== null && "size" in font && typeof font.size === "number" ? font.size : undefined;
      const address = parseAddress(target);
      const shape = this.shape(cache, address, target);
      if (op.op === "set" && text !== undefined && address.row !== null && address.cell !== null) {
        const { cells } = this.tableOf(shape, target);
        const cell = cells[address.row - 1]?.[address.cell - 1];
        if (cell === undefined) throw new PackError("address-unresolved", `${this.name} has no ${JSON.stringify(target)}`);
        add(shape.parsed.part, this.cellSplices(shape.parsed, cell, text, order));
      } else if (op.op === "set" && text !== undefined && address.row === null && !address.chart) {
        editOf(shape, order).text = text;
      } else if (op.op === "format" && size !== undefined && address.row === null && !address.chart) {
        editOf(shape, order).size = size;
      } else if (op.op === "set" && number !== undefined && address.series !== null && address.point !== null) {
        const chart = this.chartOf(shape, target);
        const entry = charts.get(chart.part) ?? { chart, changes: [] };
        charts.set(chart.part, entry);
        const series = chart.series(address.series);
        let change = entry.changes.find((c) => c.series === series);
        if (change === undefined) {
          change = { series, points: new Map(), order };
          entry.changes.push(change);
        }
        change.points.set(address.point - 1, number);
      } else if (op.op === "insert-row" && Array.isArray(op.cells) && (op.position === "before" || op.position === "after") && address.row !== null) {
        const { rows, cells } = this.tableOf(shape, target);
        const table = shape.node;
        const made = appended.get(table) ?? 0;
        const atTail = op.position === "after" && address.row === rows.length + made;
        const at = atTail ? rows.length : address.row;
        const row = rows[at - 1];
        const anchorCells = cells[at - 1];
        const given: unknown[] = op.cells;
        if (row === undefined || anchorCells === undefined) throw new PackError("address-unresolved", `${this.name} has no ${JSON.stringify(target)}`);
        if (given.length !== anchorCells.length || !given.every((t) => typeof t === "string")) {
          throw new PackError("table-row-width-mismatch", `an insert-row of ${this.name} has ${given.length} cells, the anchor row has ${anchorCells.length}`);
        }
        add(shape.parsed.part, [this.rowClone(shape.parsed, row, anchorCells, given.map(String), op.position, order)]);
        if (atTail) appended.set(table, made + 1);
      } else {
        throw new PackError("unsupported-op", `${this.name}: a pack applies set on a table cell, headline or chart point, format of a size and insert-row, not ${JSON.stringify(op).slice(0, 120)}`);
      }
    });

    for (const { shape, text, size } of shapeEdits.values()) {
      const parsed = shape.parsed;
      const body = firstChild(shape.node, "txBody");
      if (body === undefined) throw new PackError("unsupported-target", `${this.name}: shape ${shape.id} has no text`);
      const order = shapeEdits.get(shape.node)?.order ?? 0;
      add(parsed.part, text === undefined ? this.sizeSplices(parsed, body, size ?? 0, order) : this.bodySplices(parsed, body, text, size, order));
    }
    for (const [part, list] of splices) {
      const parsed = cache.get(part);
      if (parsed !== undefined) this.pkg.setText(part, applySplices(parsed.src, list, part));
    }
    for (const { chart, changes } of charts.values()) chart.write(changes);
  }

  private runs(parsed: Parsed, text: string, rPr: string | undefined): string {
    const a = namespace(parsed.root, NS.drawing, "a");
    return text
      .split(/\r\n|\n|\r/)
      .map((line) => (line === "" ? "" : `<${a("r")}>${rPr ?? ""}<${a("t")}>${escapeText(line)}</${a("t")}></${a("r")}>`))
      .join(rPr === undefined ? `<${a("br")}/>` : `<${a("br")}>${rPr}</${a("br")}>`);
  }

  /** `paragraph` with its text replaced by `text` in the formatting of its first run (at `sizePt` when given); its
   * paragraph properties and end mark stay. */
  private paragraphWith(parsed: Parsed, paragraph: XNode, text: string, sizePt: number | undefined): string {
    const a = namespace(parsed.root, NS.drawing, "a");
    const open = paragraph.selfClosing ? `${parsed.src.slice(paragraph.start, paragraph.end - 2).trimEnd()}>` : parsed.src.slice(paragraph.start, paragraph.openEnd);
    const pPr = firstChild(paragraph, "pPr");
    const end = firstChild(paragraph, "endParaRPr");
    const firstRun = firstChild(paragraph, "r");
    const rPrNode = firstRun === undefined ? undefined : firstChild(firstRun, "rPr");
    let rPr = rPrNode === undefined ? undefined : parsed.src.slice(rPrNode.start, rPrNode.end);
    let endSource = end === undefined ? "" : parsed.src.slice(end.start, end.end);
    if (sizePt !== undefined) {
      rPr = withSize(rPr, sizePt, a("rPr"));
      if (end !== undefined) endSource = withSize(endSource, sizePt, a("endParaRPr"));
    }
    const inner = (pPr === undefined ? "" : parsed.src.slice(pPr.start, pPr.end)) + this.runs(parsed, text, rPr) + endSource;
    return `${open}${inner}</${paragraph.name}>`;
  }

  /** Splices that give a text body (a shape's or a table cell's) `text`: its first paragraph is rewritten, the rest go. */
  private bodySplices(parsed: Parsed, body: XNode, text: string, sizePt: number | undefined, order: number): Splice[] {
    const [first, ...rest] = childrenNamed(body, "p");
    if (first === undefined) throw new PackError("unsupported-target", `a text body of ${this.name} has no paragraph`);
    return [{ start: first.start, end: first.end, text: this.paragraphWith(parsed, first, text, sizePt), order }, ...rest.map((p) => ({ start: p.start, end: p.end, text: "", order }))];
  }

  private cellSplices(parsed: Parsed, cell: XNode, text: string, order: number): Splice[] {
    const body = firstChild(cell, "txBody");
    if (body === undefined) throw new PackError("unsupported-target", `a table cell of ${this.name} has no text body`);
    return this.bodySplices(parsed, body, text, undefined, order);
  }

  /** Splices that give every run of a text body the size `sizePt`, leaving its text and the rest of its formatting. */
  private sizeSplices(parsed: Parsed, body: XNode, sizePt: number, order: number): Splice[] {
    const a = namespace(parsed.root, NS.drawing, "a");
    const sz = Math.round(sizePt * 100);
    const out: Splice[] = [];
    for (const paragraph of childrenNamed(body, "p")) {
      for (const node of paragraph.children) {
        if (isNamed(node, "r") && firstChild(node, "rPr") === undefined) out.push({ start: node.openEnd, end: node.openEnd, text: `<${a("rPr")} sz="${sz}"/>`, order });
      }
      for (const props of [...descendantsNamed(paragraph, "rPr"), ...childrenNamed(paragraph, "endParaRPr")]) {
        out.push({ start: props.start, end: props.openEnd, text: withSize(parsed.src.slice(props.start, props.openEnd), sizePt, props.name), order });
      }
    }
    return out;
  }

  private rowClone(parsed: Parsed, row: XNode, cells: XNode[], texts: readonly string[], position: "before" | "after", order: number): Splice {
    const a = namespace(parsed.root, NS.drawing, "a");
    const cellSplices = cells.flatMap((cell, i) => this.cellSplices(parsed, cell, texts[i] ?? "", order).map((s) => ({ ...s, start: s.start - row.start, end: s.end - row.start })));
    const identity = new RegExp(`<${a("extLst")}>[\\s\\S]*?</${a("extLst")}>`, "g");
    const clone = applySplices(parsed.src.slice(row.start, row.end), cellSplices, parsed.part).replace(identity, "");
    const at = position === "after" ? row.end : row.start;
    return { start: at, end: at, text: clone, order };
  }
}
