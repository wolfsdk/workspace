// The built-in reader of SpreadsheetML workbooks (`.xlsx`). It reads the stored cell values and formulas, never
// recalculates, and answers every view of `ReadableDocument` from one parse. Sheets, tables and defined names are
// addressed as in `docs/agent-api.md` section 3.2: `sheet:#<sheetId>`, `sheet:<name>`, `sheet:@<n>` with an optional
// `/cell:`, `/range:`, `/row:@<n>`, `/col:` or `/name:` segment, `table:<name>[/row:..][/col:..]` and `name:<n>`.
import type { Block, CellEntry, CellValue, ReadableDocument, SearchUnit } from "./model.ts";
import { ReadError } from "./model.ts";
import { relationshipsOf } from "./rels.ts";
import type { XmlElement } from "./xml.ts";
import { attr, childElements, firstChild, parseXml, textOf } from "./xml.ts";
import { ZipArchive } from "./zip.ts";

/** Stored cells kept across the workbook; the rest of a larger workbook is ignored. */
export const XLSX_MAX_CELLS = 500_000;
/** Characters kept of one string value or formula. */
const MAX_TEXT = 100_000;
/** Row blocks `blocks` lists for one sheet or one target. */
const MAX_ROW_BLOCKS = 5000;
const MAX_COL = 16_384;
const MAX_ROW = 1_048_576;

type Rect = { r1: number; c1: number; r2: number; c2: number };
const FULL: Rect = { r1: 1, c1: 1, r2: MAX_ROW, c2: MAX_COL };

type Cell = { col: number; type: CellEntry["type"]; value: CellValue; formula?: string };
type Row = { r: number; cells: Cell[] };

type Sheet = {
  name: string;
  id: number;
  /** 1-based position among the worksheets this reader keeps. */
  position: number;
  hidden: boolean;
  rows: Row[];
  byRow: Map<number, Row>;
  cellCount: number;
  dimension: string | null;
  tables: Table[];
};

type Table = {
  name: string;
  displayName: string;
  sheet: Sheet;
  ref: string;
  rect: Rect;
  columns: string[];
  headerRows: number;
  totalsRows: number;
};

type DefinedName = { name: string; sheet: Sheet | undefined; hidden: boolean; text: string };

type Workbook = { sheets: Sheet[]; tables: Table[]; names: DefinedName[] };

const clip = (text: string): string => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);

// --- A1 references -----------------------------------------------------------------------------------------------

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colLetters(col: number): string {
  let out = "";
  let n = col;
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const REF = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

function parseRef(text: string): { row: number; col: number } | undefined {
  const m = REF.exec(text);
  if (!m) return undefined;
  const col = colNumber(m[1] as string);
  const row = Number(m[2]);
  return col >= 1 && col <= MAX_COL && row >= 1 && row <= MAX_ROW ? { row, col } : undefined;
}

/** `B3` or `$B$3:$D$9` as a normalized rectangle. */
function parseRect(text: string): Rect | undefined {
  const parts = text.split(":");
  if (parts.length > 2) return undefined;
  const a = parseRef(parts[0] as string);
  const b = parts.length === 2 ? parseRef(parts[1] as string) : a;
  if (!a || !b) return undefined;
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}

// --- Address keys ------------------------------------------------------------------------------------------------

/** A name written as an address key: `%`, `/` and control characters percent-encoded, and a leading `#`, `@` or `~`. */
function escapeKey(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === "%" || ch === "/" || code < 0x20 ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
  }
  const first = out.charAt(0);
  if (first === "#" || first === "@" || first === "~") out = `%${(first.codePointAt(0) ?? 0).toString(16).toUpperCase()}${out.slice(1)}`;
  return out;
}

function decodeKey(key: string): string {
  return key.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

// --- Shared formulas ---------------------------------------------------------------------------------------------

// One token per match: a string literal, a quoted sheet name, the start of a structured reference, a whole-column
// range, a whole-row range or a cell reference. A reference is not preceded by a name character and is not followed
// by one, by `(` (a function such as LOG10) or by `!` (a sheet name such as Q1).
const FORMULA_TOKEN =
  /"(?:[^"]|"")*"|'(?:[^']|'')*'|\[|(?<![\p{L}\p{N}_.\\$])(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\p{L}\p{N}_(!.])|(?<![\p{L}\p{N}_.\\$])(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\p{L}\p{N}_(!.])|(?<![\p{L}\p{N}_.\\$])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\p{L}\p{N}_(!.[])/gu;

/** `text` (a formula without its `=`) as it reads `dRow` rows and `dCol` columns away: relative A1 references move,
 * `$` ones, string literals, sheet names and structured references stay. `undefined` when a reference would leave
 * the grid, which the caller reports as the unshifted master. */
function shiftFormula(text: string, dRow: number, dCol: number): string | undefined {
  if (dRow === 0 && dCol === 0) return text;
  const re = new RegExp(FORMULA_TOKEN.source, FORMULA_TOKEN.flags);
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += text.slice(last, m.index);
    const token = m[0];
    last = m.index + token.length;
    if (token === "[") {
      // A structured reference is copied whole; inside it `'` escapes the next character.
      let depth = 1;
      let i = m.index + 1;
      while (i < text.length && depth > 0) {
        const ch = text.charAt(i);
        if (ch === "'") {
          i += 2;
          continue;
        }
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        i++;
      }
      if (depth > 0) return undefined;
      out += text.slice(m.index, i);
      last = i;
      re.lastIndex = i;
      continue;
    }
    if (token.startsWith('"') || token.startsWith("'")) {
      out += token;
      continue;
    }
    if (m[2] !== undefined) {
      const c1 = colNumber(m[2]);
      const c2 = colNumber(m[4] as string);
      if (c1 > MAX_COL || c2 > MAX_COL) {
        out += token;
        continue;
      }
      const n1 = m[1] ? c1 : c1 + dCol;
      const n2 = m[3] ? c2 : c2 + dCol;
      if (n1 < 1 || n2 < 1 || n1 > MAX_COL || n2 > MAX_COL) return undefined;
      out += `${m[1]}${colLetters(n1)}:${m[3]}${colLetters(n2)}`;
    } else if (m[6] !== undefined) {
      const r1 = Number(m[6]);
      const r2 = Number(m[8]);
      if (r1 < 1 || r2 < 1 || r1 > MAX_ROW || r2 > MAX_ROW) {
        out += token;
        continue;
      }
      const n1 = m[5] ? r1 : r1 + dRow;
      const n2 = m[7] ? r2 : r2 + dRow;
      if (n1 < 1 || n2 < 1 || n1 > MAX_ROW || n2 > MAX_ROW) return undefined;
      out += `${m[5]}${n1}:${m[7]}${n2}`;
    } else {
      const col = colNumber(m[10] as string);
      const row = Number(m[12]);
      if (col > MAX_COL || row > MAX_ROW || row < 1) {
        out += token;
        continue;
      }
      const nc = m[9] ? col : col + dCol;
      const nr = m[11] ? row : row + dRow;
      if (nc < 1 || nr < 1 || nc > MAX_COL || nr > MAX_ROW) return undefined;
      out += `${m[9]}${colLetters(nc)}${m[11]}${nr}`;
    }
  }
  return out + text.slice(last);
}

// --- Parsing -----------------------------------------------------------------------------------------------------

/** The text of a `si` or `is` element: its `t` runs, phonetic `rPh` guides excluded. */
function richText(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") continue;
    if (child.local === "t") out += textOf(child);
    else if (child.local === "r") out += richText(child);
  }
  return out;
}

function parseSharedStrings(root: XmlElement): string[] {
  return childElements(root, "si").map((si) => clip(richText(si)));
}

type Budget = { left: number };

/** The value a `c` element stores, or `undefined` when it stores none. */
function cellValue(c: XmlElement, sst: readonly string[]): { value: CellValue; type: CellEntry["type"] } | undefined {
  const t = attr(c, "t") ?? "n";
  const v = firstChild(c, "v");
  const raw = v === undefined ? undefined : textOf(v);
  const trimmed = raw?.trim() ?? "";
  switch (t) {
    case "s": {
      const s = trimmed === "" ? undefined : sst[Number(trimmed)];
      return s === undefined ? undefined : { value: s, type: "string" };
    }
    case "str":
    case "d":
      return raw === undefined ? undefined : { value: clip(raw), type: "string" };
    case "inlineStr": {
      const is = firstChild(c, "is");
      if (is) return { value: clip(richText(is)), type: "string" };
      return raw === undefined ? undefined : { value: clip(raw), type: "string" };
    }
    case "b":
      return trimmed === "" ? undefined : { value: trimmed === "1" || trimmed.toLowerCase() === "true", type: "boolean" };
    case "e":
      return trimmed === "" ? undefined : { value: trimmed, type: "error" };
    default: {
      if (trimmed === "") return undefined;
      const n = Number(trimmed);
      return Number.isFinite(n) ? { value: n, type: "number" } : { value: clip(trimmed), type: "string" };
    }
  }
}

/** The rows of a worksheet's `sheetData`, in row order with cells in column order. */
function parseSheetData(root: XmlElement, sst: readonly string[], budget: Budget): Row[] {
  const data = firstChild(root, "sheetData");
  if (!data) return [];
  const rows = new Map<number, Cell[]>();
  const masters = new Map<string, { text: string; row: number; col: number }>();
  const followers: Array<{ cell: Cell; si: string; row: number; col: number }> = [];
  let prevRow = 0;
  scan: for (const rowEl of childElements(data, "row")) {
    const given = Number(attr(rowEl, "r"));
    prevRow = Number.isInteger(given) && given >= 1 && given <= MAX_ROW ? given : prevRow + 1;
    let prevCol = 0;
    for (const c of childElements(rowEl, "c")) {
      const ref = parseRef(attr(c, "r") ?? "");
      const row = ref ? ref.row : prevRow;
      const col = ref ? ref.col : prevCol + 1;
      prevCol = col;
      if (row > MAX_ROW || col > MAX_COL) continue;
      const stored = cellValue(c, sst);
      const f = firstChild(c, "f");
      if (!stored && !f) continue;
      const cell: Cell = { col, type: stored ? stored.type : "empty", value: stored ? stored.value : null };
      if (!f && cell.value === "") continue;
      if (f) {
        const text = textOf(f);
        const si = attr(f, "si");
        if (attr(f, "t") === "shared" && si !== undefined) {
          if (text !== "") {
            if (!masters.has(si)) masters.set(si, { text: clip(text), row, col });
            cell.formula = `=${clip(text)}`;
          } else {
            followers.push({ cell, si, row, col });
          }
        } else if (text !== "") {
          cell.formula = `=${clip(text)}`;
        }
      }
      if (budget.left <= 0) break scan;
      budget.left--;
      const list = rows.get(row);
      if (list) list.push(cell);
      else rows.set(row, [cell]);
    }
  }
  for (const follower of followers) {
    const master = masters.get(follower.si);
    if (!master) continue;
    const shifted = shiftFormula(master.text, follower.row - master.row, follower.col - master.col);
    follower.cell.formula = `=${shifted ?? master.text}`;
  }
  const out: Row[] = [];
  for (const [r, cells] of rows) out.push({ r, cells: orderCells(cells) });
  out.sort((a, b) => a.r - b.r);
  return out;
}

/** `cells` by column; a column written twice keeps its last cell. */
function orderCells(cells: Cell[]): Cell[] {
  let sorted = true;
  for (let i = 1; i < cells.length; i++) {
    if ((cells[i] as Cell).col <= (cells[i - 1] as Cell).col) {
      sorted = false;
      break;
    }
  }
  if (sorted) return cells;
  const byCol = new Map<number, Cell>();
  for (const cell of cells) byCol.set(cell.col, cell);
  return [...byCol.values()].sort((a, b) => a.col - b.col);
}

function intAttr(el: XmlElement, name: string, fallback: number): number {
  const raw = attr(el, name);
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parseTable(root: XmlElement, sheet: Sheet): Table | undefined {
  if (root.local !== "table") return undefined;
  const ref = attr(root, "ref");
  const rect = ref === undefined ? undefined : parseRect(ref);
  const name = attr(root, "name") ?? attr(root, "displayName");
  if (ref === undefined || !rect || !name) return undefined;
  const columns = firstChild(root, "tableColumns");
  return {
    name,
    displayName: attr(root, "displayName") ?? name,
    sheet,
    ref,
    rect,
    columns: columns ? childElements(columns, "tableColumn").map((col) => attr(col, "name") ?? "") : [],
    headerRows: intAttr(root, "headerRowCount", 1),
    totalsRows: intAttr(root, "totalsRowCount", 0),
  };
}

function buildSheet(name: string, id: number, position: number, hidden: boolean, rows: Row[]): Sheet {
  let cellCount = 0;
  let r1 = Number.POSITIVE_INFINITY;
  let r2 = 0;
  let c1 = Number.POSITIVE_INFINITY;
  let c2 = 0;
  const byRow = new Map<number, Row>();
  for (const row of rows) {
    byRow.set(row.r, row);
    cellCount += row.cells.length;
    r1 = Math.min(r1, row.r);
    r2 = Math.max(r2, row.r);
    c1 = Math.min(c1, (row.cells[0] as Cell).col);
    c2 = Math.max(c2, (row.cells[row.cells.length - 1] as Cell).col);
  }
  const dimension = rows.length === 0 ? null : `${colLetters(c1)}${r1}:${colLetters(c2)}${r2}`;
  return { name, id, position, hidden, rows, byRow, cellCount, dimension, tables: [] };
}

function loadWorkbook(bytes: Uint8Array): Workbook {
  const zip = ZipArchive.open(bytes);
  let workbookPart = "xl/workbook.xml";
  for (const rel of relationshipsOf(zip, "").values()) {
    if (!rel.external && rel.type.endsWith("/officeDocument")) {
      workbookPart = rel.target;
      break;
    }
  }
  if (!zip.has(workbookPart)) workbookPart = "xl/workbook.xml";
  if (!zip.has(workbookPart)) throw new ReadError("invalid-input", "the package has no workbook part");
  const root = parseXml(zip.text(workbookPart));
  if (root.local !== "workbook") throw new ReadError("invalid-input", `the workbook part is a ${root.name} element, not a workbook`);
  const rels = relationshipsOf(zip, workbookPart);

  let sstPart = "xl/sharedStrings.xml";
  for (const rel of rels.values()) {
    if (!rel.external && rel.type.endsWith("/sharedStrings")) {
      sstPart = rel.target;
      break;
    }
  }
  const sstRoot = zip.has(sstPart) ? parseXml(zip.text(sstPart)) : undefined;
  const sst = sstRoot ? parseSharedStrings(sstRoot) : [];

  const budget: Budget = { left: XLSX_MAX_CELLS };
  const sheets: Sheet[] = [];
  const byIndex = new Map<number, Sheet>();
  const tables: Table[] = [];
  const sheetsEl = firstChild(root, "sheets");
  const entries = sheetsEl ? childElements(sheetsEl, "sheet") : [];
  for (let index = 0; index < entries.length; index++) {
    const el = entries[index] as XmlElement;
    const rel = rels.get(attr(el, "r:id") ?? "");
    if (!rel || rel.external || !rel.type.endsWith("/worksheet") || !zip.has(rel.target)) continue;
    const position = sheets.length + 1;
    const declared = Number(attr(el, "sheetId"));
    const state = attr(el, "state");
    const sheetRoot = parseXml(zip.text(rel.target));
    const sheet = buildSheet(
      attr(el, "name") ?? `Sheet${position}`,
      Number.isInteger(declared) && declared >= 0 ? declared : position,
      position,
      state === "hidden" || state === "veryHidden",
      parseSheetData(sheetRoot, sst, budget),
    );
    const parts = firstChild(sheetRoot, "tableParts");
    if (parts) {
      const sheetRels = relationshipsOf(zip, rel.target);
      for (const part of childElements(parts, "tablePart")) {
        const tableRel = sheetRels.get(attr(part, "r:id") ?? "");
        if (!tableRel || tableRel.external || !zip.has(tableRel.target)) continue;
        const table = parseTable(parseXml(zip.text(tableRel.target)), sheet);
        if (table) {
          sheet.tables.push(table);
          tables.push(table);
        }
      }
    }
    sheets.push(sheet);
    byIndex.set(index, sheet);
  }

  const names: DefinedName[] = [];
  const namesEl = firstChild(root, "definedNames");
  if (namesEl) {
    for (const el of childElements(namesEl, "definedName")) {
      const name = attr(el, "name");
      if (name === undefined || name === "") continue;
      const local = attr(el, "localSheetId");
      let sheet: Sheet | undefined;
      if (local !== undefined) {
        sheet = byIndex.get(Number(local));
        if (!sheet) continue;
      }
      names.push({ name, sheet, hidden: attr(el, "hidden") === "1" || attr(el, "hidden") === "true", text: clip(textOf(el)) });
    }
  }
  return { sheets, tables, names };
}

// --- Display -----------------------------------------------------------------------------------------------------

function display(cell: Cell): string {
  const v = cell.value;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/** The display values of `row` from column `c1` to `c2`, gaps as empty fields and trailing empty fields trimmed;
 * `undefined` when the row has no cell in that span. A tab or line break inside a value becomes a space, so a row stays one line. */
function rowFields(row: Row, c1: number, c2: number): string[] | undefined {
  const fields: string[] = [];
  let any = false;
  for (const cell of row.cells) {
    if (cell.col < c1) continue;
    if (cell.col > c2) break;
    any = true;
    while (fields.length < cell.col - c1) fields.push("");
    fields.push(display(cell).replace(/\r\n|[\t\r\n]/g, " "));
  }
  if (!any) return undefined;
  while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return fields;
}

function* rowsIn(sheet: Sheet, rect: Rect): Generator<Row> {
  for (const row of sheet.rows) {
    if (row.r < rect.r1) continue;
    if (row.r > rect.r2) return;
    yield row;
  }
}

function sheetFields(sheet: Sheet, rect: Rect): string[][] {
  const out: string[][] = [];
  for (const row of rowsIn(sheet, rect)) {
    const fields = rowFields(row, rect.c1, rect.c2);
    if (fields) out.push(fields);
  }
  return out;
}

function sheetMarkdown(sheet: Sheet, rect: Rect): string {
  const rows = sheetFields(sheet, rect);
  const heading = `## ${sheet.name}`;
  if (rows.length === 0) return heading;
  let width = 1;
  for (const fields of rows) width = Math.max(width, fields.length);
  const line = (fields: readonly string[]): string => {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push((fields[i] ?? "").replace(/\|/g, "\\|"));
    return `| ${cells.join(" | ")} |`;
  };
  const header = rows[0] as string[];
  const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  return [heading, "", line(header), separator, ...rows.slice(1).map(line)].join("\n");
}

const cellAddress = (sheet: Sheet, ref: string): string => `sheet:#${sheet.id}/cell:${ref}`;

function entryOf(sheet: Sheet, row: Row, cell: Cell): CellEntry {
  const ref = `${colLetters(cell.col)}${row.r}`;
  const entry: CellEntry = { sheet: sheet.name, sheet_id: sheet.id, ref, address: cellAddress(sheet, ref), value: cell.value, type: cell.type };
  if (cell.formula !== undefined) entry.formula = cell.formula;
  return entry;
}

// --- Blocks ------------------------------------------------------------------------------------------------------

function sheetBlock(sheet: Sheet): Block {
  return {
    address: `sheet:#${sheet.id}`,
    aliases: [`sheet:${escapeKey(sheet.name)}`, `sheet:@${sheet.position}`],
    kind: "sheet",
    depth: 0,
    text: "",
    label: sheet.name,
    meta: { sheet_id: sheet.id, dimension: sheet.dimension, rows: sheet.rows.length, cells: sheet.cellCount, hidden: sheet.hidden },
  };
}

function rowBlock(sheet: Sheet, row: Row): Block {
  return {
    address: `sheet:#${sheet.id}/row:@${row.r}`,
    kind: "row",
    depth: 1,
    text: (rowFields(row, 1, MAX_COL) ?? []).join("\t"),
    meta: { cells: row.cells.length },
  };
}

/** The row blocks of the rows that hold a cell inside `rect`, at most `MAX_ROW_BLOCKS`. */
function rowBlocks(sheet: Sheet, rect: Rect): Block[] {
  const out: Block[] = [];
  for (const row of rowsIn(sheet, rect)) {
    if (out.length >= MAX_ROW_BLOCKS) break;
    if (row.cells.some((cell) => cell.col >= rect.c1 && cell.col <= rect.c2)) out.push(rowBlock(sheet, row));
  }
  return out;
}

function tableBlock(table: Table): Block {
  return {
    address: `table:${escapeKey(table.name)}`,
    kind: "table",
    depth: 0,
    text: "",
    label: table.displayName,
    meta: { sheet: table.sheet.name, ref: table.ref, columns: table.columns.join(", ") },
  };
}

function nameBlock(name: DefinedName): Block {
  return {
    address: name.sheet ? `sheet:#${name.sheet.id}/name:${escapeKey(name.name)}` : `name:${escapeKey(name.name)}`,
    kind: "name",
    depth: 0,
    text: name.text,
    label: name.name,
    meta: { sheet: name.sheet ? name.sheet.name : null, hidden: name.hidden },
  };
}

// --- Targets -----------------------------------------------------------------------------------------------------

type Scope =
  | { kind: "workbook" }
  | { kind: "sheet"; sheet: Sheet }
  | { kind: "region"; sheet: Sheet; rect: Rect }
  | { kind: "table"; table: Table }
  | { kind: "name"; name: DefinedName };

const unresolved = (target: string): ReadError => new ReadError("address-unresolved", `${target} names nothing in this document`);

function segmentOf(segment: string): { kind: string; key: string } | undefined {
  const at = segment.indexOf(":");
  return at > 0 ? { kind: segment.slice(0, at), key: segment.slice(at + 1) } : undefined;
}

const sameName = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase();

/** `key` as a 1-based position (`@n`), `undefined` for another key form. */
function positionOf(key: string): number | undefined {
  if (!key.startsWith("@")) return undefined;
  const n = Number(key.slice(1));
  return Number.isInteger(n) ? n : Number.NaN;
}

function findSheet(wb: Workbook, key: string): Sheet | undefined {
  if (key.startsWith("#")) return wb.sheets.find((s) => String(s.id) === key.slice(1));
  const position = positionOf(key);
  if (position !== undefined) return wb.sheets[position - 1];
  if (key.startsWith("~")) return undefined;
  const name = decodeKey(key);
  return wb.sheets.find((s) => s.name === name) ?? wb.sheets.find((s) => sameName(s.name, name));
}

function findTable(wb: Workbook, key: string): Table | undefined {
  if (key.startsWith("#") || key.startsWith("~")) return undefined;
  const position = positionOf(key);
  if (position !== undefined) return wb.tables[position - 1];
  const name = decodeKey(key);
  return wb.tables.find((t) => t.name === name || t.displayName === name) ?? wb.tables.find((t) => sameName(t.name, name) || sameName(t.displayName, name));
}

function findName(wb: Workbook, key: string, sheet: Sheet | undefined): DefinedName | undefined {
  if (key.startsWith("#") || key.startsWith("@") || key.startsWith("~")) return undefined;
  const name = decodeKey(key);
  const scoped = wb.names.filter((n) => n.sheet === sheet);
  return scoped.find((n) => n.name === name) ?? scoped.find((n) => sameName(n.name, name));
}

function sheetSegment(wb: Workbook, sheet: Sheet, segment: string, target: string): Scope {
  const seg = segmentOf(segment);
  if (!seg) throw unresolved(target);
  switch (seg.kind) {
    case "cell":
    case "range": {
      const rect = parseRect(seg.key);
      if (!rect || (seg.kind === "cell") === seg.key.includes(":")) throw unresolved(target);
      return { kind: "region", sheet, rect };
    }
    case "row": {
      const n = positionOf(seg.key);
      if (n === undefined || !(n >= 1 && n <= MAX_ROW)) throw unresolved(target);
      return { kind: "region", sheet, rect: { r1: n, c1: 1, r2: n, c2: MAX_COL } };
    }
    case "col": {
      const letters = seg.key.replace(/^\$/, "");
      const col = /^[A-Za-z]{1,3}$/.test(letters) ? colNumber(letters) : 0;
      if (col < 1 || col > MAX_COL) throw unresolved(target);
      return { kind: "region", sheet, rect: { r1: 1, c1: col, r2: MAX_ROW, c2: col } };
    }
    case "name": {
      const name = findName(wb, seg.key, sheet);
      if (!name) throw unresolved(target);
      return { kind: "name", name };
    }
    default:
      throw unresolved(target);
  }
}

/** The text of the table's cell at `(row, col)`. */
function cellText(sheet: Sheet, row: number, col: number): string | undefined {
  const cell = sheet.byRow.get(row)?.cells.find((c) => c.col === col);
  return cell ? display(cell) : undefined;
}

function tableScope(table: Table, segments: readonly string[], target: string): Scope {
  if (segments.length === 0) return { kind: "table", table };
  const { rect } = table;
  const first = rect.r1 + table.headerRows;
  const last = rect.r2 - table.totalsRows;
  let rowSel: number | undefined;
  let colSel: number | undefined;
  for (const segment of segments) {
    const seg = segmentOf(segment);
    if (!seg) throw unresolved(target);
    if (seg.kind === "row" && rowSel === undefined && colSel === undefined) {
      const n = positionOf(seg.key);
      if (n !== undefined) {
        if (!(n >= 1 && first + n - 1 <= last)) throw unresolved(target);
        rowSel = first + n - 1;
      } else {
        const key = decodeKey(seg.key);
        const hits: number[] = [];
        for (let r = first; r <= last; r++) if (cellText(table.sheet, r, rect.c1) === key) hits.push(r);
        if (hits.length !== 1) throw unresolved(target);
        rowSel = hits[0];
      }
    } else if (seg.kind === "col" && colSel === undefined) {
      const n = positionOf(seg.key);
      const index = n !== undefined ? n - 1 : table.columns.indexOf(decodeKey(seg.key));
      if (!(index >= 0 && index < table.columns.length)) throw unresolved(target);
      colSel = rect.c1 + index;
    } else {
      throw unresolved(target);
    }
  }
  return {
    kind: "region",
    sheet: table.sheet,
    rect: { r1: rowSel ?? first, r2: rowSel ?? last, c1: colSel ?? rect.c1, c2: colSel ?? rect.c2 },
  };
}

function resolve(wb: Workbook, target: string | undefined): Scope {
  if (target === undefined || target === "" || target === "workbook") return { kind: "workbook" };
  const segments = target.split("/");
  const head = segmentOf(segments[0] as string);
  if (!head) throw unresolved(target);
  const rest = segments.slice(1);
  switch (head.kind) {
    case "sheet": {
      const sheet = findSheet(wb, head.key);
      if (!sheet) throw unresolved(target);
      if (rest.length === 0) return { kind: "sheet", sheet };
      if (rest.length > 1) throw unresolved(target);
      return sheetSegment(wb, sheet, rest[0] as string, target);
    }
    case "table": {
      const table = findTable(wb, head.key);
      if (!table) throw unresolved(target);
      return tableScope(table, rest, target);
    }
    case "name": {
      const name = findName(wb, head.key, undefined);
      if (!name || rest.length > 0) throw unresolved(target);
      return { kind: "name", name };
    }
    default:
      throw unresolved(target);
  }
}

const AREA_REF = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/;

/** The cells a defined name points at, when its formula is one plain area of an existing sheet. */
function nameArea(wb: Workbook, name: DefinedName): { sheet: Sheet; rect: Rect } | undefined {
  const m = AREA_REF.exec(name.text.trim());
  if (!m) return undefined;
  const sheetName = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] as string);
  const sheet = wb.sheets.find((s) => s.name === sheetName) ?? wb.sheets.find((s) => sameName(s.name, sheetName));
  const rect = parseRect(m[3] as string);
  return sheet && rect ? { sheet, rect } : undefined;
}

type Area = { sheet: Sheet; rect: Rect };

/** The sheet rectangles `scope` covers; a name that is not a plain area covers none. */
function areasOf(wb: Workbook, scope: Scope): Area[] {
  switch (scope.kind) {
    case "workbook":
      return wb.sheets.map((sheet) => ({ sheet, rect: FULL }));
    case "sheet":
      return [{ sheet: scope.sheet, rect: FULL }];
    case "region":
      return [{ sheet: scope.sheet, rect: scope.rect }];
    case "table":
      return [{ sheet: scope.table.sheet, rect: scope.table.rect }];
    case "name": {
      const area = nameArea(wb, scope.name);
      return area ? [area] : [];
    }
  }
}

// --- The document ------------------------------------------------------------------------------------------------

class XlsxDocument implements ReadableDocument {
  readonly format = "xlsx" as const;
  readonly #wb: Workbook;

  constructor(wb: Workbook) {
    this.#wb = wb;
  }

  blocks(target?: string): Block[] {
    const wb = this.#wb;
    const scope = resolve(wb, target);
    switch (scope.kind) {
      case "workbook": {
        const out: Block[] = [];
        for (const sheet of wb.sheets) {
          out.push(sheetBlock(sheet));
          for (const row of sheet.rows.slice(0, MAX_ROW_BLOCKS)) out.push(rowBlock(sheet, row));
        }
        for (const table of wb.tables) out.push(tableBlock(table));
        for (const name of wb.names) out.push(nameBlock(name));
        return out;
      }
      case "sheet":
        return [
          sheetBlock(scope.sheet),
          ...scope.sheet.rows.slice(0, MAX_ROW_BLOCKS).map((row) => rowBlock(scope.sheet, row)),
          ...wb.names.filter((name) => name.sheet === scope.sheet).map(nameBlock),
        ];
      case "region":
        return rowBlocks(scope.sheet, scope.rect);
      case "table":
        return [tableBlock(scope.table)];
      case "name":
        return [nameBlock(scope.name)];
    }
  }

  text(target?: string): string {
    const scope = resolve(this.#wb, target);
    if (scope.kind === "name" && !nameArea(this.#wb, scope.name)) return scope.name.text;
    return areasOf(this.#wb, scope)
      .map(({ sheet, rect }) => [`# ${sheet.name}`, ...sheetFields(sheet, rect).map((fields) => fields.join("\t"))].join("\n"))
      .join("\n");
  }

  markdown(target?: string): string {
    const scope = resolve(this.#wb, target);
    if (scope.kind === "name" && !nameArea(this.#wb, scope.name)) return `\`${scope.name.name}\` = \`${scope.name.text}\``;
    return areasOf(this.#wb, scope)
      .map(({ sheet, rect }) => sheetMarkdown(sheet, rect))
      .join("\n\n");
  }

  cells(target?: string): CellEntry[] {
    const out: CellEntry[] = [];
    for (const { sheet, rect } of areasOf(this.#wb, resolve(this.#wb, target))) {
      for (const row of rowsIn(sheet, rect)) {
        for (const cell of row.cells) {
          if (cell.col >= rect.c1 && cell.col <= rect.c2) out.push(entryOf(sheet, row, cell));
        }
      }
    }
    return out;
  }

  units(): SearchUnit[] {
    const out: SearchUnit[] = [];
    for (const sheet of this.#wb.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row.cells) {
          const value = display(cell);
          const text = cell.formula === undefined ? value : value === "" ? cell.formula : `${value}  ${cell.formula}`;
          out.push({ address: cellAddress(sheet, `${colLetters(cell.col)}${row.r}`), text });
        }
      }
    }
    return out;
  }
}

/** Parse `bytes` as an XLSX workbook. Throws `ReadError` `invalid-input` for anything that is not one. */
export function openXlsx(bytes: Uint8Array): ReadableDocument {
  try {
    return new XlsxDocument(loadWorkbook(bytes));
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("invalid-input", `not an XLSX workbook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
