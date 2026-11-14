/**
 * Pure helpers for the Recalc mode: how a stored value and Wolf's computed
 * value are shown, the numeric difference between them, sorting, and whether
 * this document can be recalculated at all. Nothing in this file computes a
 * formula.
 */
import type { DocFormat, LabDoc, RecalcReport, Region, TypedValue } from "../../lab/index.ts";

export type RecalcCell = RecalcReport["cells"][number];

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type ValueKind = "number" | "text" | "boolean" | "error" | "blank";

export type ShownValue = { kind: ValueKind; text: string; number?: number };

/** Spreadsheet error codes. The engine reports an error value as a string
 * holding the code (docs/ops-xlsx.md, "Values"), so a string that is exactly
 * one of these is shown as an error value. */
const ERROR_CODES: Readonly<Record<string, true>> = {
  "#NULL!": true,
  "#DIV/0!": true,
  "#VALUE!": true,
  "#REF!": true,
  "#NAME?": true,
  "#NUM!": true,
  "#N/A": true,
  "#GETTING_DATA": true,
  "#SPILL!": true,
  "#CALC!": true,
  "#FIELD!": true,
  "#BLOCKED!": true,
  "#CONNECT!": true,
  "#BUSY!": true,
  "#UNKNOWN!": true,
};

export const KIND_LABEL: Record<ValueKind, string> = {
  number: "number",
  text: "text",
  boolean: "true or false",
  error: "error value",
  blank: "blank",
};

function textValue(text: string): ShownValue {
  if (Object.hasOwn(ERROR_CODES, text)) return { kind: "error", text };
  return { kind: "text", text: `"${text}"` };
}

/** How a stored or computed cell value is written on the page. Numbers keep
 * every digit the engine reported. */
export function showValue(value: TypedValue | null | undefined): ShownValue {
  if (value == null || "empty" in value) return { kind: "blank", text: "blank" };
  if ("number" in value) return { kind: "number", text: Object.is(value.number, -0) ? "0" : String(value.number), number: value.number };
  if ("boolean" in value) return { kind: "boolean", text: value.boolean ? "TRUE" : "FALSE" };
  if ("string" in value) return textValue(value.string);
  if ("text" in value) return textValue(value.text);
  if ("formula" in value) return { kind: "text", text: value.formula };
  return { kind: "text", text: value.instruction };
}

// ---------------------------------------------------------------------------
// Differences
// ---------------------------------------------------------------------------

export type Difference =
  /** `relative` is the absolute difference over the size of the stored
   * value; `null` when the stored value is 0. */
  | { kind: "numeric"; absolute: number; relative: number | null }
  | { kind: "not-numeric"; reason: string };

export function difference(cached: ShownValue, computed: ShownValue): Difference {
  if (cached.number !== undefined && computed.number !== undefined) {
    const absolute = Math.abs(computed.number - cached.number);
    const relative = cached.number === 0 ? null : absolute / Math.abs(cached.number);
    return { kind: "numeric", absolute, relative };
  }
  const reason =
    cached.kind === computed.kind
      ? `both are ${KIND_LABEL[cached.kind]}`
      : `${KIND_LABEL[cached.kind]} and ${KIND_LABEL[computed.kind]}`;
  return { kind: "not-numeric", reason };
}

// Six significant digits for reading, but never rounding away whole units.
const plain = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumSignificantDigits: 3 });
const wholePercent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

export function formatAbsolute(d: Difference): string {
  if (d.kind !== "numeric") return "does not apply";
  if (!Number.isFinite(d.absolute)) return String(d.absolute);
  if (d.absolute !== 0 && d.absolute < 1e-4) return d.absolute.toExponential(2);
  return (d.absolute >= 1e6 ? whole : plain).format(d.absolute);
}

export function formatRelative(d: Difference): string {
  if (d.kind !== "numeric") return "does not apply";
  if (d.relative === null) return "not defined, stored value is 0";
  if (!Number.isFinite(d.relative)) return String(d.relative);
  if (d.relative !== 0 && d.relative < 1e-6) return `${(d.relative * 100).toExponential(2)}%`;
  return (d.relative >= 10 ? wholePercent : percent).format(d.relative);
}

// ---------------------------------------------------------------------------
// Rows and sorting
// ---------------------------------------------------------------------------

export type RecalcRow = {
  /** Stable key, unique within a report. */
  key: string;
  address: string;
  sheet: string;
  a1: string;
  /** `Sheet!A1`, with the sheet quoted when it needs it. */
  label: string;
  formula?: string;
  cached: ShownValue;
  computed: ShownValue;
  diff: Difference;
  /** Position in the report, used to break ties. */
  order: number;
};

export function cellLabel(sheet: string, a1: string): string {
  const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replaceAll("'", "''")}'`;
  return `${quoted}!${a1}`;
}

export function recalcRows(report: RecalcReport): RecalcRow[] {
  return report.cells.map((cell, order) => {
    const cached = showValue(cell.cached);
    const computed = showValue(cell.computed);
    return {
      key: `${cell.sheet}!${cell.a1}#${order}`,
      address: cell.address,
      sheet: cell.sheet,
      a1: cell.a1,
      label: cellLabel(cell.sheet, cell.a1),
      formula: cell.formula,
      cached,
      computed,
      diff: difference(cached, computed),
      order,
    };
  });
}

export type SortKey = "cell" | "cached" | "computed" | "absolute" | "relative";
export type SortOrder = { key: SortKey; dir: "asc" | "desc" };

export const DEFAULT_SORT: SortOrder = { key: "cell", dir: "asc" };

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function compareCell(a: RecalcRow, b: RecalcRow): number {
  const sheet = a.sheet.localeCompare(b.sheet, "en-US");
  if (sheet !== 0) return sheet;
  const pa = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(a.a1);
  const pb = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(b.a1);
  if (pa && pb) {
    const col = columnIndex(pa[1]!) - columnIndex(pb[1]!);
    if (col !== 0) return col;
    return Number(pa[2]) - Number(pb[2]);
  }
  return a.a1.localeCompare(b.a1, "en-US");
}

const KIND_ORDER: Record<ValueKind, number> = { number: 0, text: 1, boolean: 2, error: 3, blank: 4 };

function compareValue(a: ShownValue, b: ShownValue): number {
  if (a.number !== undefined && b.number !== undefined) return a.number - b.number;
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return kind !== 0 ? kind : a.text.localeCompare(b.text, "en-US");
}

function numericKey(row: RecalcRow, key: "absolute" | "relative"): number | null {
  if (row.diff.kind !== "numeric") return null;
  return key === "absolute" ? row.diff.absolute : row.diff.relative;
}

/** A new sorted array. For the two difference columns, rows without a
 * numeric difference stay at the end in either direction. */
export function sortRows(rows: readonly RecalcRow[], order: SortOrder): RecalcRow[] {
  const sign = order.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let c: number;
    switch (order.key) {
      case "cell":
        c = sign * compareCell(a, b);
        break;
      case "cached":
        c = sign * compareValue(a.cached, b.cached);
        break;
      case "computed":
        c = sign * compareValue(a.computed, b.computed);
        break;
      default: {
        const va = numericKey(a, order.key);
        const vb = numericKey(b, order.key);
        if (va === null || vb === null) c = va === vb ? 0 : va === null ? 1 : -1;
        else c = sign * (va - vb);
      }
    }
    return c !== 0 ? c : a.order - b.order;
  });
}

/** Clicking the active column flips it; another column starts ascending,
 * except the difference columns, which start with the largest. */
export function nextSort(current: SortOrder, key: SortKey): SortOrder {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "absolute" || key === "relative" ? "desc" : "asc" };
}

/** The page region drawn for a cell, if the engine located it. */
export function regionFor(row: RecalcRow, regions: readonly Region[]): Region | undefined {
  const named = `sheet:${row.sheet}/cell:${row.a1}`;
  return regions.find((r) => r.object_id === row.address || r.object_id === named);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export type RecalcAccess = { kind: "workbook" } | { kind: "not-a-workbook"; format: DocFormat };

export function recalcAccess(doc: LabDoc): RecalcAccess {
  return doc.format === "xlsx" ? { kind: "workbook" } : { kind: "not-a-workbook", format: doc.format };
}
