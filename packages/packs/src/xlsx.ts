// A deterministic reader of an .xlsx workbook: the sheets, defined names and tables it declares, and the values
// each cell last held (the cached `v` of a formula cell). It reads the package parts directly, so it needs no
// engine; a recalculation is the job of an `XlsxEvaluator`, which supplies fresh values for the same cells.
import { cellName, parseCell, type RangeAddress } from "./a1.ts";
import { PackError } from "./errors.ts";
import { BUILTIN_NUMBER_FORMATS, plainNumber, type CellValue, type SourceCell } from "./numfmt.ts";
import { OoxmlPackage } from "./ooxml.ts";
import { applySplices, childrenNamed, firstChild, leafText, type Splice, type XNode } from "./xml.ts";

export type XlsxTable = { name: string; sheet: string; ref: string };
export type XlsxDefinedName = { name: string; scopeSheet: string | null; formula: string };
export type RawCell = { value: CellValue; formula: boolean; style: number };

/** What a defined name stands for, when a pack can read it. */
export type ResolvedName = { kind: "range"; sheet: string; ref: string } | { kind: "constant"; value: CellValue };

function sharedStringsOf(pkg: OoxmlPackage): string[] {
  if (!pkg.has("xl/sharedStrings.xml")) return [];
  const { src, root } = pkg.xml("xl/sharedStrings.xml");
  return childrenNamed(root, "si").map((si) => stringItemText(src, si));
}

/** The text of a string item (`si`, `is`): its `t` and every `r/t`, not the phonetic runs. */
function stringItemText(src: string, item: XNode): string {
  let out = "";
  for (const t of childrenNamed(item, "t")) out += leafText(src, t);
  for (const run of childrenNamed(item, "r")) for (const t of childrenNamed(run, "t")) out += leafText(src, t);
  return out;
}

export class XlsxWorkbook {
  readonly date1904: boolean;
  readonly sheets: { name: string; part: string }[] = [];
  readonly definedNames: XlsxDefinedName[] = [];
  readonly tables: XlsxTable[] = [];
  private readonly pkg: OoxmlPackage;
  private readonly strings: string[];
  private readonly styleFormats: (string | null)[];
  private readonly cellCache = new Map<string, Map<string, RawCell>>();

  constructor(bytes: Uint8Array, docName: string) {
    try {
      this.pkg = new OoxmlPackage(bytes);
    } catch (e) {
      if (e instanceof PackError) throw new PackError(e.code, `${docName}: ${e.message}`);
      throw e;
    }
    if (!this.pkg.has("xl/workbook.xml")) throw new PackError("package-missing-part", `${docName} is not an xlsx workbook: it has no xl/workbook.xml`);
    const { root } = this.pkg.xml("xl/workbook.xml");
    const wbPr = firstChild(root, "workbookPr");
    this.date1904 = wbPr?.attrs.date1904 === "1" || wbPr?.attrs.date1904 === "true";
    const rels = this.pkg.relationships("xl/workbook.xml");
    const sheetsNode = firstChild(root, "sheets");
    for (const s of sheetsNode ? childrenNamed(sheetsNode, "sheet") : []) {
      const id = s.attrs["r:id"] ?? "";
      const rel = rels.find((r) => r.id === id);
      if (rel === undefined) throw new PackError("package-bad-relationship", `${docName}: sheet ${JSON.stringify(s.attrs.name)} has no relationship ${JSON.stringify(id)}`);
      this.sheets.push({ name: s.attrs.name ?? "", part: rel.target });
    }
    const names = firstChild(root, "definedNames");
    const { src } = this.pkg.xml("xl/workbook.xml");
    for (const n of names ? childrenNamed(names, "definedName") : []) {
      const local = n.attrs.localSheetId;
      const scope = local === undefined ? null : (this.sheets[Number(local)]?.name ?? null);
      this.definedNames.push({ name: n.attrs.name ?? "", scopeSheet: scope, formula: leafText(src, n).trim() });
    }
    this.strings = sharedStringsOf(this.pkg);
    this.styleFormats = this.readStyles();
    for (const sheet of this.sheets) {
      for (const rel of this.pkg.relationships(sheet.part)) {
        if (!rel.type.endsWith("/table") || !this.pkg.has(rel.target)) continue;
        const table = this.pkg.xml(rel.target).root;
        const ref = table.attrs.ref;
        const name = table.attrs.displayName ?? table.attrs.name;
        if (ref !== undefined && name !== undefined) this.tables.push({ name, sheet: sheet.name, ref });
      }
    }
  }

  /** Number format code of each cell style (`cellXfs` index): `null` for General. */
  private readStyles(): (string | null)[] {
    if (!this.pkg.has("xl/styles.xml")) return [];
    const { root } = this.pkg.xml("xl/styles.xml");
    const custom = new Map<number, string>();
    const numFmts = firstChild(root, "numFmts");
    for (const f of numFmts ? childrenNamed(numFmts, "numFmt") : []) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "General");
    const xfs = firstChild(root, "cellXfs");
    return (xfs ? childrenNamed(xfs, "xf") : []).map((xf) => {
      const id = Number(xf.attrs.numFmtId ?? 0);
      const code = custom.get(id) ?? BUILTIN_NUMBER_FORMATS[id];
      return code === undefined || code === "General" ? null : code;
    });
  }

  private sheetOf(sheet: string): { name: string; part: string } {
    const found = this.sheets.find((s) => s.name === sheet) ?? this.sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase());
    if (found === undefined) {
      throw new PackError("unknown-sheet", `the workbook has no sheet ${JSON.stringify(sheet)} (it has ${this.sheets.map((s) => JSON.stringify(s.name)).join(", ")})`);
    }
    return found;
  }

  /** The name the workbook spells a sheet with, for a selector that spelt it in another case. */
  sheetName(sheet: string): string {
    return this.sheetOf(sheet).name;
  }

  /** Give cells of `sheet` numbers. A cell must exist and hold a number (or nothing); a formula cell is refused. */
  writeNumbers(sheet: string, writes: readonly { ref: string; value: number }[]): void {
    const { part } = this.sheetOf(sheet);
    const { src, root } = this.pkg.xml(part);
    const cells = new Map<string, XNode>();
    const data = firstChild(root, "sheetData");
    for (const row of data ? childrenNamed(data, "row") : []) {
      for (const c of childrenNamed(row, "c")) if (c.attrs.r !== undefined) cells.set(cellName(parseCell(c.attrs.r)), c);
    }
    const splices = writes.map(({ ref, value }, order): Splice => {
      const cell = cells.get(cellName(parseCell(ref)));
      if (cell === undefined) throw new PackError("unsupported-target", `${sheet}!${ref} is not a cell of the chart's workbook`);
      if (firstChild(cell, "f") !== undefined) throw new PackError("unsupported-target", `${sheet}!${ref} of the chart's workbook holds a formula, which a refresh does not overwrite`);
      if (cell.attrs.t !== undefined && cell.attrs.t !== "n") throw new PackError("unsupported-target", `${sheet}!${ref} of the chart's workbook holds text, not a number`);
      const text = plainNumber(value);
      const v = firstChild(cell, "v");
      if (v !== undefined) return { start: v.start, end: v.end, text: `<${v.name}>${text}</${v.name}>`, order };
      if (cell.selfClosing) return { start: cell.start, end: cell.end, text: `${src.slice(cell.start, cell.end - 2).trimEnd()}><v>${text}</v></${cell.name}>`, order };
      return { start: cell.closeStart, end: cell.closeStart, text: `<v>${text}</v>`, order };
    });
    this.pkg.setText(part, applySplices(src, splices, part));
    this.cellCache.clear();
  }

  save(): Uint8Array {
    return this.pkg.save();
  }

  private cellsOf(sheet: string): Map<string, RawCell> {
    const { part } = this.sheetOf(sheet);
    const cached = this.cellCache.get(part);
    if (cached !== undefined) return cached;
    const { src, root } = this.pkg.xml(part);
    const out = new Map<string, RawCell>();
    const data = firstChild(root, "sheetData");
    for (const row of data ? childrenNamed(data, "row") : []) {
      for (const c of childrenNamed(row, "c")) {
        const ref = c.attrs.r;
        if (ref === undefined) continue;
        out.set(cellName(parseCell(ref)), this.readCell(src, c));
      }
    }
    this.cellCache.set(part, out);
    return out;
  }

  private readCell(src: string, c: XNode): RawCell {
    const type = c.attrs.t ?? "n";
    const style = Number(c.attrs.s ?? 0);
    const formula = firstChild(c, "f") !== undefined;
    const v = firstChild(c, "v");
    const text = v === undefined ? undefined : leafText(src, v);
    let value: CellValue = null;
    if (type === "inlineStr") {
      const is = firstChild(c, "is");
      value = is === undefined ? null : stringItemText(src, is);
    } else if (text === undefined || text === "") value = null;
    else if (type === "s") {
      const s = this.strings[Number(text)];
      if (s === undefined) throw new PackError("package-bad-xml", `cell ${c.attrs.r} points at shared string ${text}, which does not exist`);
      value = s;
    } else if (type === "str" || type === "d") value = text;
    else if (type === "b") value = text === "1" || text === "true";
    else if (type === "e") throw new PackError("source-error-value", `cell ${c.attrs.r} holds the error ${text}`);
    else {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new PackError("package-bad-xml", `cell ${c.attrs.r} holds ${JSON.stringify(text)}, which is not a number`);
      value = n;
    }
    return { value, formula, style };
  }

  /** The cell at `ref` of `sheet`, with the number format of its own style. */
  cell(sheet: string, ref: string): SourceCell {
    const a1 = cellName(parseCell(ref));
    let raw: RawCell | undefined;
    try {
      raw = this.cellsOf(sheet).get(a1);
    } catch (e) {
      if (e instanceof PackError && e.code === "source-error-value") throw new PackError(e.code, `${sheet}!${e.message}`);
      throw e;
    }
    if (raw === undefined) return { value: null, format: null };
    return { value: raw.value, format: this.styleFormats[raw.style] ?? null };
  }

  /** The cells of a range, row by row. */
  block(sheet: string, range: RangeAddress): SourceCell[][] {
    const rows: SourceCell[][] = [];
    for (let row = range.from.row; row <= range.to.row; row++) {
      const cells: SourceCell[] = [];
      for (let column = range.from.column; column <= range.to.column; column++) cells.push(this.cell(sheet, cellName({ column, row })));
      rows.push(cells);
    }
    return rows;
  }

  table(name: string): XlsxTable {
    const found = this.tables.find((t) => t.name === name) ?? this.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (found === undefined) throw new PackError("unknown-table", `the workbook has no table ${JSON.stringify(name)} (it has ${this.tables.map((t) => JSON.stringify(t.name)).join(", ") || "none"})`);
    return found;
  }

  /** What a defined name stands for: a range of one sheet, or a constant. A formula is refused. */
  definedName(name: string): ResolvedName {
    const matches = this.definedNames.filter((n) => n.name === name || n.name.toLowerCase() === name.toLowerCase());
    const exact = matches.filter((n) => n.name === name);
    const pool = exact.length > 0 ? exact : matches;
    const workbookScope = pool.filter((n) => n.scopeSheet === null);
    const chosen = workbookScope.length > 0 ? workbookScope : pool;
    if (chosen.length === 0) throw new PackError("unknown-name", `the workbook has no defined name ${JSON.stringify(name)}`);
    if (chosen.length > 1) throw new PackError("ambiguous-name", `the defined name ${JSON.stringify(name)} is scoped to several sheets`);
    const chosenName = chosen[0];
    if (chosenName === undefined) throw new PackError("unknown-name", `the workbook has no defined name ${JSON.stringify(name)}`);
    const formula = chosenName.formula;
    const reference = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(formula);
    if (reference) {
      const sheet = (reference[1] ?? reference[2] ?? "").replace(/''/g, "'");
      return { kind: "range", sheet, ref: reference[3] ?? "" };
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(formula)) return { kind: "constant", value: Number(formula) };
    const text = /^"((?:[^"]|"")*)"$/.exec(formula);
    if (text) return { kind: "constant", value: (text[1] ?? "").replace(/""/g, '"') };
    throw new PackError("unsupported-defined-name", `the defined name ${JSON.stringify(name)} is ${JSON.stringify(formula)}: only a cell, a range, a number or a text constant can be bound`);
  }
}
