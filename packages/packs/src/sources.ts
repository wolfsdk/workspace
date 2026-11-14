// The sources of a pack: an XLSX workbook, or a CSV or SQL snapshot pinned by its SHA-256. A source answers a
// selector with a block of cells (rows of `SourceCell`); everything after that (number formats, fit, targets)
// is the same for every source kind.
import type { PackSelector, PackSource } from "@wolfsdk/protocol/workspace";
import { parseRange, type RangeAddress } from "./a1.ts";
import { PackError } from "./errors.ts";
import type { XlsxEvaluator } from "./evaluator.ts";
import { sha256Hex } from "./hash.ts";
import type { CellValue, SourceCell } from "./numfmt.ts";
import { XlsxWorkbook } from "./xlsx.ts";
import type { PackReader } from "./store.ts";

export type Block = SourceCell[][];

export interface SourceReader {
  /** The block of cells `selector` names. */
  select(selector: PackSelector): Block;
  /** Whether the source reads dates as 1904-based serials and the locale it formats under. */
  readonly date1904: boolean;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A CSV field as a value: a plain number is a number (a leading-zero id such as `007` stays text), empty is empty. */
function csvValue(field: string): CellValue {
  if (field === "") return null;
  if (NUMBER.test(field) && !/^[+-]?0\d/.test(field)) {
    const n = Number(field);
    if (Number.isFinite(n)) return n;
  }
  return field;
}

/** RFC 4180 records of `text`: quoted fields, doubled quotes, CRLF or LF, a final newline that ends no record. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const body = text.startsWith("\ufeff") ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (body[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      started = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      if (started || field !== "") {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = "";
      started = false;
    } else {
      field += ch;
      started = true;
    }
  }
  if (quoted) throw new PackError("bad-snapshot", "a quoted CSV field is not closed");
  if (started || field !== "") {
    record.push(field);
    records.push(record);
  }
  return records;
}

type Grid = { header: string[]; rows: CellValue[][] };

function csvGrid(text: string, name: string): Grid {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) throw new PackError("bad-snapshot", `${name} has no header row`);
  const rows = records.slice(1).map((r, i) => {
    if (r.length > header.length) throw new PackError("bad-snapshot", `${name}: row ${i + 2} has ${r.length} fields, the header has ${header.length}`);
    return [...r.map(csvValue), ...Array.from({ length: header.length - r.length }, () => null)];
  });
  return { header, rows };
}

function isValue(v: unknown): v is CellValue {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/** A SQL snapshot is a query result as JSON: `{columns, rows}` with array or object rows, or an array of objects. */
function sqlGrid(text: string, name: string): Grid {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackError("bad-snapshot", `${name} is not JSON: a SQL snapshot is a query result as {"columns": [...], "rows": [...]} or an array of row objects`);
  }
  const shapeError = new PackError("bad-snapshot", `${name} is neither {"columns": [...], "rows": [...]} nor an array of row objects`);
  const objectRow = (row: unknown): Map<string, unknown> => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw shapeError;
    return new Map(Object.entries(row));
  };
  let header: string[];
  let rows: unknown[][];
  if (Array.isArray(parsed)) {
    const maps = parsed.map(objectRow);
    header = [...new Set(maps.flatMap((m) => [...m.keys()]))];
    rows = maps.map((m) => header.map((c) => m.get(c) ?? null));
  } else if (typeof parsed === "object" && parsed !== null && "columns" in parsed && "rows" in parsed) {
    const { columns, rows: raw } = parsed;
    if (!Array.isArray(columns) || !Array.isArray(raw) || !columns.every((c) => typeof c === "string")) throw shapeError;
    header = columns;
    rows = raw.map((row) => (Array.isArray(row) ? row : header.map((c) => objectRow(row).get(c) ?? null)));
  } else {
    throw shapeError;
  }
  const checked: CellValue[][] = [];
  rows.forEach((values, i) => {
    if (values.length !== header.length || !values.every(isValue)) {
      throw new PackError("bad-snapshot", `${name}: row ${i + 1} is not ${header.length} numbers, strings, booleans or nulls`);
    }
    checked.push(values);
  });
  return { header, rows: checked };
}

const stemOf = (docName: string): string => (docName.split("/").pop() ?? docName).replace(/\.[^.]*$/, "");

class SnapshotReader implements SourceReader {
  readonly date1904 = false;
  private readonly grid: Grid;
  private readonly docName: string;

  constructor(grid: Grid, docName: string) {
    this.grid = grid;
    this.docName = docName;
  }

  private cells(rows: readonly CellValue[][]): Block {
    return rows.map((r) => r.map((value) => ({ value, format: null })));
  }

  /** The grid a spreadsheet would show: the header on row 1, the rows below it. */
  private whole(): CellValue[][] {
    return [this.grid.header, ...this.grid.rows];
  }

  private known(name: string): boolean {
    return name === "all" || name.toLowerCase() === stemOf(this.docName).toLowerCase() || name === this.docName;
  }

  select(selector: PackSelector): Block {
    switch (selector.type) {
      case "cell":
      case "range": {
        const sheet = selector.sheet;
        if (sheet !== "Sheet1" && !this.known(sheet)) {
          throw new PackError("unknown-sheet", `${this.docName} is one table: its sheet is "Sheet1" or ${JSON.stringify(stemOf(this.docName))}, not ${JSON.stringify(sheet)}`);
        }
        return this.window(parseRange(selector.ref));
      }
      case "table":
        if (!this.known(selector.name)) throw new PackError("unknown-table", `${this.docName} has the table ${JSON.stringify(stemOf(this.docName))} (or "all"), not ${JSON.stringify(selector.name)}`);
        return this.cells(this.whole());
      case "defined_name": {
        if (selector.name === "all") return this.cells(this.whole());
        if (selector.name === "header_row") return this.cells([this.grid.header]);
        const matches = this.grid.header.flatMap((h, i) => (h === selector.name ? [i] : []));
        if (matches.length === 0) throw new PackError("unknown-name", `${this.docName} has no column ${JSON.stringify(selector.name)}, "header_row" or "all"`);
        if (matches.length > 1) throw new PackError("ambiguous-name", `${this.docName} has several columns named ${JSON.stringify(selector.name)}`);
        const at = matches[0] ?? 0;
        return this.cells(this.grid.rows.map((r) => [r[at] ?? null]));
      }
    }
  }

  private window(range: RangeAddress): Block {
    const whole = this.whole();
    const out: CellValue[][] = [];
    for (let row = range.from.row; row <= range.to.row; row++) {
      const cells: CellValue[] = [];
      for (let column = range.from.column; column <= range.to.column; column++) cells.push(whole[row - 1]?.[column - 1] ?? null);
      out.push(cells);
    }
    return this.cells(out);
  }
}

class WorkbookReader implements SourceReader {
  private readonly workbook: XlsxWorkbook;

  constructor(workbook: XlsxWorkbook) {
    this.workbook = workbook;
  }

  get date1904(): boolean {
    return this.workbook.date1904;
  }

  select(selector: PackSelector): Block {
    const wb = this.workbook;
    switch (selector.type) {
      case "cell":
      case "range":
        return wb.block(wb.sheetName(selector.sheet), parseRange(selector.ref));
      case "table": {
        const table = wb.table(selector.name);
        return wb.block(table.sheet, parseRange(table.ref));
      }
      case "defined_name": {
        const resolved = wb.definedName(selector.name);
        if (resolved.kind === "constant") return [[{ value: resolved.value, format: null }]];
        return wb.block(wb.sheetName(resolved.sheet), parseRange(resolved.ref));
      }
    }
  }
}

/** Open the document of `source`, check what the manifest pins about it, and return its reader. */
export async function openSource(source: PackSource, store: PackReader, evaluator: XlsxEvaluator | undefined): Promise<SourceReader> {
  const bytes = await store.read(source.doc_name);
  if (bytes === undefined) throw new PackError("source-missing", `source ${JSON.stringify(source.id)}: the pack has no ${source.doc_name}`);
  if (source.kind === "xlsx") {
    const evaluated = evaluator === undefined ? bytes : await evaluator.recalculate({ name: source.doc_name, bytes, determinism: source.determinism });
    return new WorkbookReader(new XlsxWorkbook(evaluated, source.doc_name));
  }
  const pinned = source.determinism.snapshot_sha256;
  const actual = sha256Hex(bytes);
  if (pinned === undefined || pinned.toLowerCase() !== actual) {
    throw new PackError("snapshot-sha256-mismatch", `${source.doc_name} hashes to ${actual}, the manifest pins ${pinned ?? "nothing"}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PackError("bad-snapshot", `${source.doc_name} is not UTF-8 text`);
  }
  return new SnapshotReader(source.kind === "csv_snapshot" ? csvGrid(text, source.doc_name) : sqlGrid(text, source.doc_name), source.doc_name);
}
