/**
 * The logic of the review-mode sheet grid (`SheetReviewView.tsx`), free of the DOM and the kernel
 * so it can be tested on its own: which cells the reviewed change sets touched and what the
 * reviewer decided on them, how much of a sheet to read, and how a `sheet_viewport` reply
 * becomes boxes.
 *
 * It keeps its own small A1 helpers instead of importing the sheets plugin's: a module the
 * review entry reaches is part of the entry, and the authoring plugin must stay a lazy chunk.
 */
import { changesOf, type Decision, type Hunk, type SheetViewport } from "@wolfsdk/protocol";
import type { HistoryEntry } from "../host/index.ts";

/** What the main area of a workbook shows: the sheet grid or the engine's printed pages. */
export type SheetViewMode = "grid" | "pages";

/** A workbook opens on its sheet grid. */
export const DEFAULT_SHEET_VIEW: SheetViewMode = "grid";

/** Rows and columns read per step, and the most that are ever read. */
export const ROW_STEP = 200;
export const COL_STEP = 40;
export const ROW_CAP = 2000;
export const COL_CAP = 200;
/** The grid always shows at least this much, so a small sheet still reads as a grid. */
const MIN_ROWS = 20;
const MIN_COLS = 10;

/** Pixel sizes of the grid's frame and the engine's defaults (Excel's 8.43 characters and 15 points). */
export const ROW_HEADER_PX = 44;
export const COL_HEADER_PX = 24;
const DEFAULT_COL_PX = 64;
const DEFAULT_ROW_PX = 20;

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let letters = "";
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) letters = String.fromCharCode(65 + ((v - 1) % 26)) + letters;
  return letters;
}

export type CellAddress = { sheetId: number; a1: string; row: number; col: number };

/** `sheet:#2/cell:B7` (a cell node of the engine's view) as its parts; null for any other address. */
export function parseCellAddress(address: string): CellAddress | null {
  const m = /^sheet:#(\d+)\/cell:([A-Z]+)(\d+)$/.exec(address);
  if (!m) return null;
  return { sheetId: Number(m[1]), a1: `${m[2]}${m[3]}`, row: Number(m[3]), col: colToNum(m[2]!) };
}

/** The engine's node address of a cell. */
export const cellAddress = (sheetId: number, a1: string): string => `sheet:#${sheetId}/cell:${a1}`;

/** Key of a cell in `changedCells`. */
export const cellKey = (sheetId: number, a1: string): string => `${sheetId}!${a1}`;

/** The reads of the review store this module needs (`ReviewStore` has them). */
export type ReviewReads = {
  history(): HistoryEntry[];
  hunks(entry: HistoryEntry): Hunk[];
  hunkDecisionOf(entry: HistoryEntry, op: number | null): Decision;
};

/** A cell some change record touched. `entry` and `index` name its latest record (`selectChange` takes them). */
export type ChangedCell = CellAddress & {
  /** `reject` if any hunk touching the cell is rejected, else `pending` if any is undecided, else `approve`. */
  decision: Decision;
  entry: HistoryEntry;
  index: number;
  /** Change records on the cell across all change sets. */
  records: number;
};

/** The more urgent of two decisions: a rejected hunk shows over an undecided one, that over an approved one. */
export function mergeDecision(a: Decision, b: Decision): Decision {
  if (a === "reject" || b === "reject") return "reject";
  if (a === "pending" || b === "pending") return "pending";
  return "approve";
}

/**
 * Every cell the history's change records touch, by `cellKey`, each with the combined decision of
 * the hunks that changed it. Changes to anything but a cell (sheets, rows, columns, ranges) are
 * left to the changes panel.
 */
export function changedCells(reads: ReviewReads): Map<string, ChangedCell> {
  const cells = new Map<string, ChangedCell>();
  for (const entry of reads.history()) {
    const changes = changesOf(entry);
    for (const hunk of reads.hunks(entry)) {
      const decision = reads.hunkDecisionOf(entry, hunk.op);
      for (const index of hunk.changeIndices) {
        const parsed = parseCellAddress(changes[index]?.address ?? "");
        if (!parsed) continue;
        const key = cellKey(parsed.sheetId, parsed.a1);
        const before = cells.get(key);
        cells.set(key, {
          ...parsed,
          decision: before ? mergeDecision(before.decision, decision) : decision,
          entry,
          index,
          records: (before?.records ?? 0) + 1,
        });
      }
    }
  }
  return cells;
}

/** Per sheet (by sheet id): the changed cells and their combined decision, for the tab badges. */
export function sheetMarks(cells: ReadonlyMap<string, ChangedCell>): Map<number, { count: number; decision: Decision }> {
  const marks = new Map<number, { count: number; decision: Decision }>();
  for (const cell of cells.values()) {
    const before = marks.get(cell.sheetId);
    marks.set(cell.sheetId, {
      count: (before?.count ?? 0) + 1,
      decision: before ? mergeDecision(before.decision, cell.decision) : cell.decision,
    });
  }
  return marks;
}

export type SheetTab = { sheetId: number; name: string };

/** The workbook's sheets in document order, from the `sheet:#N` nodes of the view. */
export function sheetTabs(nodes: readonly { id: string; kind: string; label?: string }[]): SheetTab[] {
  const tabs: SheetTab[] = [];
  for (const node of nodes) {
    const m = node.kind === "sheet" ? /^sheet:#(\d+)$/.exec(node.id) : null;
    if (m) tabs.push({ sheetId: Number(m[1]), name: node.label ?? node.id });
  }
  return tabs;
}

/** The label of each view in the toggle. */
export const VIEW_LABELS: Record<SheetViewMode, string> = { grid: "Sheet Grid", pages: "Printed Pages" };

/** Last row and column of an A1 range (`A1:F20`) or single cell, or null for anything else. */
export function usedExtent(range: string | null | undefined): { rows: number; cols: number } | null {
  const m = range ? /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range) : null;
  if (!m) return null;
  return { rows: Number(m[4] ?? m[2]), cols: colToNum(m[3] ?? m[1]!) };
}

export type GridWindow = {
  rows: number;
  cols: number;
  /** The sheet has cells beyond this window. */
  truncated: boolean;
};

/**
 * How many rows and columns (from A1) to read or show. `used` is the sheet's used extent, or null
 * before it is known (the read window). The window holds `ROW_STEP` x `COL_STEP` per step (`more`
 * steps beyond the first) and always every changed cell, up to the caps; it is cut to the used
 * extent once that is known, but never below a small grid.
 */
export function windowFor(
  used: { rows: number; cols: number } | null,
  changed: readonly { row: number; col: number }[],
  more: number,
): GridWindow {
  const lastRow = changed.reduce((m, c) => Math.max(m, c.row), 0);
  const lastCol = changed.reduce((m, c) => Math.max(m, c.col), 0);
  const stepRows = Math.max(ROW_STEP * (1 + more), lastRow);
  const stepCols = Math.max(COL_STEP * (1 + more), lastCol);
  const needRows = Math.max(MIN_ROWS, used?.rows ?? 0, lastRow);
  const needCols = Math.max(MIN_COLS, used?.cols ?? 0, lastCol);
  const rows = Math.min(ROW_CAP, used ? Math.min(stepRows, needRows) : stepRows);
  const cols = Math.min(COL_CAP, used ? Math.min(stepCols, needCols) : stepCols);
  return { rows, cols, truncated: used !== null && (used.rows > rows || used.cols > cols) };
}

export type GridLayout = {
  /** Left edge of column `c` (1-based) is `colX[c - 1]`; `colX[cols]` is the grid's width. */
  colX: number[];
  rowY: number[];
  width: number;
  height: number;
};

/** Pixel offsets of the first `rows` x `cols` cells of a reply: its column widths, row heights and hidden lines. */
export function layoutOf(reply: SheetViewport, rows: number, cols: number): GridLayout {
  const defaultCol = reply.default_col_width_px > 0 ? reply.default_col_width_px : DEFAULT_COL_PX;
  const defaultRow = reply.default_row_height_pt > 0 ? Math.round((reply.default_row_height_pt * 96) / 72) : DEFAULT_ROW_PX;
  const hiddenCols = new Set(reply.hidden_cols);
  const hiddenRows = new Set(reply.hidden_rows);
  const colPx = new Map<number, number>();
  for (const c of reply.columns) {
    if (c.hidden) hiddenCols.add(c.col);
    else colPx.set(c.col, c.width_px);
  }
  const rowPx = new Map<number, number>();
  for (const r of reply.row_heights) {
    if (r.hidden) hiddenRows.add(r.row);
    else rowPx.set(r.row, r.height_px);
  }
  const colX = [0];
  for (let c = 1; c <= cols; c++) colX.push(colX[c - 1]! + (hiddenCols.has(c) ? 0 : (colPx.get(c) ?? defaultCol)));
  const rowY = [0];
  for (let r = 1; r <= rows; r++) rowY.push(rowY[r - 1]! + (hiddenRows.has(r) ? 0 : (rowPx.get(r) ?? defaultRow)));
  return { colX, rowY, width: colX[cols]!, height: rowY[rows]! };
}

/** Index (1-based) of the line of `edges` (`edges[i - 1]` .. `edges[i]` is line `i`) that holds `at`, or null outside. */
function lineAt(edges: readonly number[], at: number): number | null {
  if (at < 0 || at >= edges[edges.length - 1]!) return null;
  let lo = 1;
  let hi = edges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at < edges[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The cell under a point `x`, `y` pixels from the grid's top-left corner (headers excluded); null outside the grid. */
export function cellAt(layout: GridLayout, x: number, y: number): { row: number; col: number } | null {
  const col = lineAt(layout.colX, x);
  const row = lineAt(layout.rowY, y);
  return col === null || row === null ? null : { row, col };
}

export type Rect = { x: number; y: number; w: number; h: number };

/** Pixel box of one cell (not widened by a merge). */
export function cellRect(layout: GridLayout, row: number, col: number): Rect {
  const x = layout.colX[col - 1] ?? 0;
  const y = layout.rowY[row - 1] ?? 0;
  return { x, y, w: (layout.colX[col] ?? x) - x, h: (layout.rowY[row] ?? y) - y };
}

/**
 * The scroll offset that brings `target` fully into a viewport of `width` x `height` that is
 * scrolled to `left`, `top` and whose first `inset` pixels on each axis lie under sticky headers;
 * unchanged when it is already in view.
 */
export function revealOffset(
  target: Rect,
  view: { left: number; top: number; width: number; height: number },
  inset: { x: number; y: number },
): { left: number; top: number } {
  const fit = (start: number, size: number, scroll: number, extent: number, pad: number): number => {
    if (start < scroll + pad) return Math.max(0, start - pad);
    if (start + size > scroll + extent) return Math.max(0, start + size - extent);
    return scroll;
  };
  return {
    left: fit(target.x, target.w, view.left, view.width, inset.x),
    top: fit(target.y, target.h, view.top, view.height, inset.y),
  };
}

export type HAlign = "left" | "right" | "center";

export type CellBox = {
  a1: string;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The number-formatted text. */
  text: string;
  /** The cell's formula with its leading `=`, or null for a constant. */
  formula: string | null;
  align: HAlign;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb` text colour from the number format or the cell's font; null for the grid's own. */
  color: string | null;
  /** `#rrggbb` fill; null for none. */
  fill: string | null;
};

const HEX = /^#[0-9a-f]{6}$/i;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function colourOf(value: unknown): string | null {
  const c = typeof value === "string" ? value : (recordOf(value)?.rgb ?? recordOf(value)?.color);
  return typeof c === "string" && HEX.test(c) ? c : null;
}

/** Horizontal alignment: the cell style's own, else by what the value is (numbers right, booleans and errors centred). */
export function alignOf(style: SheetViewport["styles"][string] | undefined, value: Record<string, unknown> | null): HAlign {
  const set = recordOf(style?.alignment)?.horizontal;
  if (set === "left" || set === "right" || set === "center") return set;
  if (value && "number" in value) return "right";
  if (value && ("boolean" in value || "error" in value)) return "center";
  return "left";
}

type Merge = { row: number; col: number; rows: number; cols: number };

/** Ranges of `merged` by top-left a1 (entries read as `A1:B2` strings or `{range}`). */
function mergesOf(reply: SheetViewport): Map<string, Merge> {
  const out = new Map<string, Merge>();
  for (const entry of reply.merged) {
    const text = typeof entry === "string" ? entry : recordOf(entry)?.range;
    const m = typeof text === "string" ? /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(text) : null;
    if (!m) continue;
    const col = colToNum(m[1]!);
    const row = Number(m[2]);
    out.set(`${m[1]}${m[2]}`, { row, col, rows: Number(m[4]) - row + 1, cols: colToNum(m[3]!) - col + 1 });
  }
  return out;
}

/**
 * The boxes to draw inside the first `rows` x `cols` cells of `reply`: its non-empty cells and
 * every `extra` cell (a changed cell may be empty now), none in a hidden row or column.
 */
export function cellBoxes(
  reply: SheetViewport,
  layout: GridLayout,
  rows: number,
  cols: number,
  extra: readonly { a1: string; row: number; col: number }[],
): CellBox[] {
  const merges = mergesOf(reply);
  // Cells under a merge but its top-left one are not drawn: the merged box covers them.
  const covered = new Set<string>();
  for (const m of merges.values()) {
    for (let r = m.row; r < m.row + m.rows && r <= rows; r++) {
      for (let c = m.col; c < m.col + m.cols && c <= cols; c++) {
        if (r !== m.row || c !== m.col) covered.add(`${r}:${c}`);
      }
    }
  }
  const seen = new Set<string>();
  const boxes: CellBox[] = [];
  const add = (a1: string, row: number, col: number, cell: SheetViewport["cells"][number] | null) => {
    if (row < 1 || col < 1 || row > rows || col > cols || seen.has(a1) || covered.has(`${row}:${col}`)) return;
    const merge = merges.get(a1);
    const x = layout.colX[col - 1]!;
    const y = layout.rowY[row - 1]!;
    const w = layout.colX[Math.min(cols, col - 1 + (merge?.cols ?? 1))]! - x;
    const h = layout.rowY[Math.min(rows, row - 1 + (merge?.rows ?? 1))]! - y;
    if (w <= 0 || h <= 0) return;
    seen.add(a1);
    const style = cell?.style_id !== null && cell?.style_id !== undefined ? reply.styles[String(cell.style_id)] : undefined;
    const font = recordOf(style?.font);
    const fill = recordOf(style?.fill);
    const fillColour = fill && fill.pattern !== "none" ? (colourOf(fill.color) ?? colourOf(fill.background)) : null;
    const fontColour = colourOf(font?.color);
    boxes.push({
      a1,
      row,
      col,
      x,
      y,
      w,
      h,
      text: cell?.display ?? "",
      formula: cell?.formula ?? null,
      align: alignOf(style, cell?.value ?? null),
      bold: font?.bold === true,
      italic: font?.italic === true,
      color: colourOf(cell?.color) ?? (fontColour !== "#000000" ? fontColour : null),
      fill: fillColour,
    });
  };
  for (const cell of reply.cells) add(cell.a1, cell.row, cell.col, cell);
  for (const cell of extra) add(cell.a1, cell.row, cell.col, null);
  return boxes;
}
