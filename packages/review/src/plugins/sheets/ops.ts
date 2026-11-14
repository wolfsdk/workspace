/**
 * Every engine operation the sheets plugin sends is built here, so the op
 * shapes can be corrected in one place. Shapes: docs/ops-xlsx.md and
 * docs/engine-ops-xlsx.md (recalculate, hyperlink, cell/range delete,
 * row/column visibility, sheet copy with tables). Sheets
 * are addressed by stable id (`sheet:#N`), which survives rename and move.
 */
import type { Op, TypedValue } from "@wolfsdk/protocol";
import { MAX_COLS, MAX_ROWS, numToCol, toA1, type Rect } from "./refs.ts";

export const sheetAddr = (sheetId: number) => `sheet:#${sheetId}`;
export const cellAddr = (sheetId: number, row: number, col: number) => `sheet:#${sheetId}/cell:${toA1(row, col)}`;
export const rangeAddr = (sheetId: number, r: Rect) =>
  r.r1 === r.r2 && r.c1 === r.c2
    ? cellAddr(sheetId, r.r1, r.c1)
    : `sheet:#${sheetId}/range:${toA1(r.r1, r.c1)}:${toA1(r.r2, r.c2)}`;
/** A range target that is always `range:` (format accepts both). */
const rangeOnly = (sheetId: number, r: Rect) => `sheet:#${sheetId}/range:${toA1(r.r1, r.c1)}:${toA1(r.r2, r.c2)}`;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function setCell(sheetId: number, row: number, col: number, value: TypedValue): Op {
  return { op: "set", target: cellAddr(sheetId, row, col), value };
}

/** A rectangular block of typed values (row-major, exact shape). A 1x1
 * block is sent as a single-cell `set` (a range target refuses `value`). */
export function setBlock(sheetId: number, row: number, col: number, values: TypedValue[][]): Op {
  const rows = values.length;
  const cols = values[0]?.length ?? 0;
  if (rows === 1 && cols === 1) return setCell(sheetId, row, col, values[0]![0]!);
  return {
    op: "set",
    target: rangeOnly(sheetId, { r1: row, c1: col, r2: row + rows - 1, c2: col + cols - 1 }),
    values,
  };
}

/** Clear a cell or range in place, as Excel's Delete key: values and
 * formulas go; formats, merges, comments and links stay; nothing shifts. */
export function deleteCells(sheetId: number, r: Rect): Op {
  return { op: "delete", target: rangeAddr(sheetId, r) };
}

// ---------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------

/** An external `url` (needs a scheme, no spaces, at most 2,079 chars) or an
 * internal `location` (`Sheet!A1`), exactly one of them. */
export type LinkTarget = { url: string } | { location: string };

export function setHyperlink(sheetId: number, row: number, col: number, target: LinkTarget, tooltip?: string): Op {
  const op: Op = { op: "hyperlink", target: cellAddr(sheetId, row, col), action: "set", ...target };
  if (tooltip) op.tooltip = tooltip;
  return op;
}

export function removeHyperlink(sheetId: number, row: number, col: number): Op {
  return { op: "hyperlink", target: cellAddr(sheetId, row, col), action: "remove" };
}

/** Copy with Excel-style rebasing of relative references; a target that is
 * an exact multiple of the source fills (fill down / right). */
export function copyRange(
  fromSheet: number,
  source: Rect,
  toSheet: number,
  target: Rect,
  paste: "all" | "values" = "all",
): Op {
  return { op: "copy", source: rangeAddr(fromSheet, source), target: rangeAddr(toSheet, target), paste };
}

/** Fill-handle batch: `from` repeated over the part of `to` (`from` grown
 * down or right; same columns, or same rows) outside it. Whole repeats are
 * one `copy` (a target an exact multiple of the source fills); a partial
 * last repeat copies the source's leading rows/columns. Empty when `to`
 * does not grow `from` down or right. */
export function fillOps(sheetId: number, from: Rect, to: Rect): Op[] {
  const down = to.c1 === from.c1 && to.c2 === from.c2 && to.r1 === from.r1 && to.r2 > from.r2;
  const right = to.r1 === from.r1 && to.r2 === from.r2 && to.c1 === from.c1 && to.c2 > from.c2;
  if (!down && !right) return [];
  const size = down ? from.r2 - from.r1 + 1 : from.c2 - from.c1 + 1;
  const start = (down ? from.r2 : from.c2) + 1;
  const span = (down ? to.r2 : to.c2) - start + 1;
  const whole = Math.floor(span / size) * size;
  const part = span - whole;
  const along = (r: Rect, a: number, b: number): Rect => (down ? { ...r, r1: a, r2: b } : { ...r, c1: a, c2: b });
  const base = down ? from.r1 : from.c1;
  const out: Op[] = [];
  if (whole > 0) out.push(copyRange(sheetId, from, sheetId, along(from, start, start + whole - 1)));
  if (part > 0)
    out.push(
      copyRange(
        sheetId,
        along(from, base, base + part - 1),
        sheetId,
        along(from, start + whole, start + whole + part - 1),
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type NumberFormatPreset = "general" | "number" | "currency" | "percent" | "date";

export const NUMBER_FORMATS: Record<NumberFormatPreset, string | null> = {
  // `null` resets to the workbook default (General).
  general: null,
  number: "#,##0.00",
  currency: '"$"#,##0.00',
  percent: "0.00%",
  date: "m/d/yyyy",
};

export type BorderPreset = "none" | "all" | "outline" | "bottom";
export type HAlign = "left" | "center" | "right" | "general";

export type FormatPatch = {
  number_format?: string | null;
  font?: { bold?: boolean; italic?: boolean; underline?: string; color?: string; size?: number; name?: string } | null;
  fill?: { color: string } | null;
  borders?: Record<string, { style: string; color?: string }> | null;
  alignment?: { horizontal?: string; vertical?: string; wrap?: boolean } | null;
  column_width?: number;
  row_height?: number;
};

/** Format a rectangle (a cell or range target). The engine refuses
 * `format` on `sheet:#N`, `col:` and `row:` targets (`op-kind-mismatch`),
 * and a full-height range materializes a million cells (`range:B1:B1048576`
 * runs out of memory on the capped module): whole rows, columns and the
 * whole sheet go through `clipFullLines` first. */
export function formatRect(sheetId: number, r: Rect, format: FormatPatch): Op {
  return { op: "format", target: rangeAddr(sheetId, r), format };
}

/** A selection rectangle as a range the engine can format: full-height
 * columns end at the last used row and full-width rows at the last used
 * column of `used` (at least the rectangle's first row/column), so a
 * whole-column selection formats the cells that exist, as far as the
 * engine's address grammar allows. */
export function clipFullLines(r: Rect, used: Rect): Rect {
  return {
    r1: r.r1,
    c1: r.c1,
    r2: r.r1 === 1 && r.r2 === MAX_ROWS ? Math.max(r.r1, used.r2) : r.r2,
    c2: r.c1 === 1 && r.c2 === MAX_COLS ? Math.max(r.c1, used.c2) : r.c2,
  };
}

export const numberFormat = (preset: NumberFormatPreset): FormatPatch => ({ number_format: NUMBER_FORMATS[preset] });
export const bold = (on: boolean): FormatPatch => ({ font: { bold: on } });
export const italic = (on: boolean): FormatPatch => ({ font: { italic: on } });
export const fontColor = (hex: string): FormatPatch => ({ font: { color: hex.toUpperCase() } });
export const fillColor = (hex: string | null): FormatPatch => ({ fill: hex ? { color: hex.toUpperCase() } : null });
export const hAlign = (h: HAlign): FormatPatch => ({ alignment: { horizontal: h } });
export const underline = (on: boolean): FormatPatch => ({ font: { underline: on ? "single" : "none" } });
export const wrapText = (on: boolean): FormatPatch => ({ alignment: { wrap: on } });

export function borders(preset: BorderPreset, color = "#000000"): FormatPatch {
  const edge = { style: "thin", color };
  switch (preset) {
    case "none":
      return { borders: null };
    case "outline":
      return { borders: { outline: edge } };
    case "bottom":
      return { borders: { bottom: edge } };
    case "all":
      return { borders: { outline: edge, "inside-vertical": edge, "inside-horizontal": edge } };
  }
}

/** Column width in characters (Excel units) for every column in `c1..c2`. */
export function columnWidth(sheetId: number, c1: number, c2: number, chars: number): Op {
  return formatRect(sheetId, { r1: 1, c1, r2: 1, c2 }, { column_width: round2(chars) });
}

/** Row height in points for every row in `r1..r2`. */
export function rowHeight(sheetId: number, r1: number, r2: number, points: number): Op {
  return formatRect(sheetId, { r1, c1: 1, r2, c2: 1 }, { row_height: round2(points) });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export function insertRows(sheetId: number, row: number, count: number, position: "before" | "after" = "before"): Op {
  return { op: "insert", anchor: `sheet:#${sheetId}/row:@${row}`, position, node: { kind: "row", count } };
}

export function insertCols(sheetId: number, col: number, count: number, position: "before" | "after" = "before"): Op {
  return { op: "insert", anchor: `sheet:#${sheetId}/col:${numToCol(col)}`, position, node: { kind: "col", count } };
}

/** Delete rows `r1..r2`: one op per row. Every op in a batch addresses the
 * grid as it was before the batch, so the targets are `r1`, `r1 + 1`, ...; a
 * second op at `r1` is refused ("target was removed by an earlier operation"). */
export function deleteRows(sheetId: number, r1: number, r2: number): Op[] {
  return Array.from({ length: r2 - r1 + 1 }, (_, i) => ({ op: "delete", target: `sheet:#${sheetId}/row:@${r1 + i}` }));
}

/** Delete columns `c1..c2`, addressed like `deleteRows`. */
export function deleteCols(sheetId: number, c1: number, c2: number): Op[] {
  return Array.from({ length: c2 - c1 + 1 }, (_, i) => ({
    op: "delete",
    target: `sheet:#${sheetId}/col:${numToCol(c1 + i)}`,
  }));
}

export function merge(sheetId: number, r: Rect, discardValues = false): Op {
  const op: Op = { op: "merge", target: rangeOnly(sheetId, r) };
  if (discardValues) op.discard_values = true;
  return op;
}

export function unmerge(sheetId: number, r: Rect): Op {
  return { op: "unmerge", target: rangeOnly(sheetId, r) };
}

/** Freeze rows above and columns left of (`row`, `col`); null unfreezes. */
export function freeze(sheetId: number, at: { row: number; col: number } | null): Op {
  return { op: "freeze", target: sheetAddr(sheetId), cell: at ? toA1(at.row, at.col) : null };
}

/** Hide or show rows `r1..r2`, one op per row. Rows already in that state
 * write nothing. */
export function rowVisibility(sheetId: number, r1: number, r2: number, state: "visible" | "hidden"): Op[] {
  return Array.from({ length: r2 - r1 + 1 }, (_, i) => ({
    op: "visibility",
    target: `sheet:#${sheetId}/row:@${r1 + i}`,
    state,
  }));
}

export function colVisibility(sheetId: number, c1: number, c2: number, state: "visible" | "hidden"): Op[] {
  return Array.from({ length: c2 - c1 + 1 }, (_, i) => ({
    op: "visibility",
    target: `sheet:#${sheetId}/col:${numToCol(c1 + i)}`,
    state,
  }));
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export function insertSheet(afterSheetId: number, name: string): Op {
  return { op: "insert", anchor: sheetAddr(afterSheetId), position: "after", node: { kind: "sheet", key: name } };
}

export function renameSheet(sheetId: number, name: string): Op {
  return { op: "rename", target: sheetAddr(sheetId), name };
}

export function deleteSheet(sheetId: number): Op {
  return { op: "delete", target: sheetAddr(sheetId) };
}

export function moveSheet(sheetId: number, anchorSheetId: number, position: "before" | "after"): Op {
  return { op: "move", target: sheetAddr(sheetId), anchor: sheetAddr(anchorSheetId), position };
}

/** Copy sheet `fromSheetId` as `name`, right after it. Tables on the sheet
 * are copied under new names; a sheet with drawings, comments or pivots
 * refuses `unsupported`. */
export function copySheet(fromSheetId: number, name: string): Op {
  return {
    op: "insert",
    anchor: sheetAddr(fromSheetId),
    position: "after",
    node: { kind: "sheet", key: name, from: sheetAddr(fromSheetId) },
  };
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/** Sort the rows of range `r` in place by column `col` (docs/ops-xlsx.md
 * 4.7); `header` keeps the range's first row on top. Moved table rows are
 * reported as `moved` changes (docs/engine-ops-xlsx.md). */
export function sortRange(
  sheetId: number,
  r: Rect,
  col: number,
  order: "ascending" | "descending",
  header: boolean,
): Op {
  return { op: "sort", target: rangeOnly(sheetId, r), keys: [{ col: numToCol(col), order }], header };
}

// ---------------------------------------------------------------------------
// Recalculation
// ---------------------------------------------------------------------------

/** Recalculate every formula in the workbook (docs/engine-ops-xlsx.md,
 * "Recalculate op"). */
export function recalculate(): Op {
  return { op: "recalculate", target: "workbook" };
}
