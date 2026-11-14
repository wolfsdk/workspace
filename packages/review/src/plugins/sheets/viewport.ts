/**
 * Reactor kernel grid reads: `ReactorKernelClient.sheetViewport` windows
 * (docs/reactor-abi.md "Sheet viewport") cached as fixed tiles per
 * revision.
 *
 * The reactor module has no `extract` command, and its observe is not
 * read for the grid, so on that kernel everything the grid
 * draws beyond the cell nodes comes from here: display strings (`display`;
 * `display_trimmed` is not used: the engine's fit estimate turns numbers
 * that do fit, such as a bold `2,026.00` in a default column, into `###`,
 * and the grid measures the real text itself), `color` from the number
 * format, resolved
 * styles by `style_id`, column widths and row heights in px, hidden rows
 * and columns, merged ranges, the frozen pane, gridlines and every sheet's
 * used range (scroll extent).
 *
 * A reply describes only its window (`merged`, `hidden_rows`,
 * `hidden_cols`, `columns`, `row_heights` and `cells` are window-scoped),
 * so a sheet's data is the union of the tiles loaded so far; rows and
 * columns outside them use the defaults until a tile covering them
 * arrives. `style_id` is the workbook's cell format index, so styles are
 * pooled per revision.
 */
import type { SheetViewport } from "@wolfsdk/protocol";
import { MAX_COLS, MAX_ROWS, parseA1, parseRange, type Rect } from "./refs.ts";
import { cellKey } from "./model.ts";
import {
  DEFAULT_COL_PX,
  DEFAULT_ROW_PX,
  parseEngineStyle,
  ptToPx,
  type CellStyle,
  type Frozen,
  type SheetLayout,
} from "./meta.ts";

export const TILE_ROWS = 100;
export const TILE_COLS = 26;

export type VpCell = {
  /** Number-format result. */
  display: string;
  /** Number-format colour (`[Red]`), else null. */
  color: string | null;
  style: number | null;
  value: Record<string, unknown> | null;
  formula: string | null;
};

/** One sheet of one revision: the union of its loaded tiles. */
export type VpSheet = {
  name: string;
  tiles: Set<number>;
  cells: Map<number, VpCell>;
  /** Widths / heights in px that differ from the defaults (hidden ones
   * excluded: those are in `hiddenCols` / `hiddenRows`). */
  colPx: Map<number, number>;
  rowPx: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  colStyles: Map<number, number>;
  merges: Map<string, Rect>;
  frozen: Frozen | null;
  gridlines: boolean;
  defaultColPx: number;
  defaultRowPx: number;
  /** Bumped on every merged tile (layout cache key). */
  version: number;
};

/** Everything read for one revision. */
export type VpBook = {
  sha: string;
  revision: number;
  styles: Map<number, CellStyle>;
  /** By sheet name. */
  sheets: Map<string, VpSheet>;
  /** Used range of every sheet (`sheets[].used`), by name; null when the
   * sheet is empty. */
  used: Map<string, Rect | null>;
  /** Workbook default font (`default_font`): family and size in points. */
  defaultFont: { name: string; sizePt: number } | null;
};

export function emptyBook(sha: string, revision: number): VpBook {
  return { sha, revision, styles: new Map(), sheets: new Map(), used: new Map(), defaultFont: null };
}

export const tileKey = (tr: number, tc: number) => tr * 1024 + tc;
export const tileOf = (row: number, col: number) =>
  tileKey(Math.floor((row - 1) / TILE_ROWS), Math.floor((col - 1) / TILE_COLS));

/** The window a tile asks for (1-based, clipped to the sheet's limits). */
export function tileWindow(key: number): { row0: number; col0: number; rows: number; cols: number } {
  const tr = Math.floor(key / 1024);
  const tc = key % 1024;
  const row0 = tr * TILE_ROWS + 1;
  const col0 = tc * TILE_COLS + 1;
  return { row0, col0, rows: Math.min(TILE_ROWS, MAX_ROWS - row0 + 1), cols: Math.min(TILE_COLS, MAX_COLS - col0 + 1) };
}

/**
 * Tiles covering `view` plus one tile of margin on every side, and the
 * frozen rows/columns, nearest the view's centre first. Tiles that lie
 * wholly outside `limit` (the used range plus slack) are left out: there is
 * nothing in them to show beyond defaults.
 */
export function tilesFor(view: Rect, frozen: Frozen | null, limit: Rect | null): number[] {
  const tr1 = Math.max(0, Math.floor((view.r1 - 1) / TILE_ROWS) - 1);
  const tr2 = Math.floor((view.r2 - 1) / TILE_ROWS) + 1;
  const tc1 = Math.max(0, Math.floor((view.c1 - 1) / TILE_COLS) - 1);
  const tc2 = Math.floor((view.c2 - 1) / TILE_COLS) + 1;
  const rowsT = new Set<number>();
  const colsT = new Set<number>();
  for (let t = tr1; t <= tr2; t++) rowsT.add(t);
  for (let t = tc1; t <= tc2; t++) colsT.add(t);
  if (frozen && frozen.rows > 0) for (let t = 0; t <= Math.floor((frozen.rows - 1) / TILE_ROWS); t++) rowsT.add(t);
  if (frozen && frozen.cols > 0) for (let t = 0; t <= Math.floor((frozen.cols - 1) / TILE_COLS); t++) colsT.add(t);
  const cr = (view.r1 + view.r2) / 2;
  const cc = (view.c1 + view.c2) / 2;
  const out: { key: number; d: number }[] = [];
  for (const tr of rowsT) {
    for (const tc of colsT) {
      const w = tileWindow(tileKey(tr, tc));
      if (w.rows <= 0 || w.cols <= 0) continue;
      // Always the first tile: it carries the sheet-wide members.
      const first = tr === 0 && tc === 0;
      if (!first && limit && (w.row0 > limit.r2 || w.col0 > limit.c2)) continue;
      const dr = Math.max(0, w.row0 - cr, cr - (w.row0 + w.rows - 1)) / TILE_ROWS;
      const dc = Math.max(0, w.col0 - cc, cc - (w.col0 + w.cols - 1)) / TILE_COLS;
      out.push({ key: tileKey(tr, tc), d: dr + dc });
    }
  }
  return out.sort((a, b) => a.d - b.d || a.key - b.key).map((t) => t.key);
}

function emptySheet(name: string): VpSheet {
  return {
    name,
    tiles: new Set(),
    cells: new Map(),
    colPx: new Map(),
    rowPx: new Map(),
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    colStyles: new Map(),
    merges: new Map(),
    frozen: null,
    gridlines: true,
    defaultColPx: DEFAULT_COL_PX,
    defaultRowPx: DEFAULT_ROW_PX,
    version: 0,
  };
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `freeze` member -> rows above / columns left of the split; null for no
 * pane or a plain split (`mode` other than `freeze`). */
export function frozenOf(freeze: SheetViewport["freeze"]): Frozen | null {
  if (!freeze) return null;
  const mode = freeze.mode;
  if (mode !== undefined && mode !== "freeze" && mode !== "frozen") return null;
  const cell = typeof freeze.top_left_cell === "string" ? parseA1(freeze.top_left_cell) : null;
  const rows = finite(freeze.rows) ?? (cell ? cell.row - 1 : 0);
  const cols = finite(freeze.cols) ?? (cell ? cell.col - 1 : 0);
  return rows > 0 || cols > 0 ? { rows, cols } : null;
}

/** `sheets[].used` (`[r0, c0, r1, c1]`) or `used_range` -> Rect. */
function usedOf(s: { used: number[] | null; used_range: string | null }): Rect | null {
  const u = s.used;
  if (Array.isArray(u) && u.length === 4 && u.every((n) => Number.isInteger(n) && n >= 1))
    return { r1: u[0]!, c1: u[1]!, r2: u[2]!, c2: u[3]! };
  return s.used_range ? parseRange(s.used_range) : null;
}

/**
 * Merge one reply (the window of tile `key`) into `book`. Returns the
 * sheet's entry. Pure apart from mutating `book`.
 */
export function mergeReply(book: VpBook, reply: SheetViewport, key: number): VpSheet {
  for (const s of reply.sheets ?? []) book.used.set(s.name, usedOf(s));
  const df = reply.default_font;
  if (df && typeof df.name === "string" && df.name)
    book.defaultFont = { name: df.name, sizePt: finite(df.size_pt) ?? 11 };
  for (const [id, style] of Object.entries(reply.styles ?? {})) {
    const n = Number(id);
    if (Number.isInteger(n) && !book.styles.has(n)) book.styles.set(n, parseEngineStyle(style));
  }
  let sheet = book.sheets.get(reply.sheet);
  if (!sheet) book.sheets.set(reply.sheet, (sheet = emptySheet(reply.sheet)));
  sheet.frozen = frozenOf(reply.freeze);
  sheet.gridlines = reply.show_grid_lines !== false;
  const dcol = finite(reply.default_col_width_px);
  if (dcol !== undefined && dcol > 0) sheet.defaultColPx = dcol;
  const drow = finite(reply.default_row_height_pt);
  if (drow !== undefined && drow > 0) sheet.defaultRowPx = ptToPx(drow);
  for (const c of reply.columns ?? []) {
    if (c.hidden) sheet.hiddenCols.add(c.col);
    else {
      sheet.hiddenCols.delete(c.col);
      if (c.width_px !== sheet.defaultColPx) sheet.colPx.set(c.col, c.width_px);
      else sheet.colPx.delete(c.col);
    }
    if (c.style_id !== null && c.style_id !== undefined) sheet.colStyles.set(c.col, c.style_id);
  }
  for (const r of reply.row_heights ?? []) {
    if (r.hidden) sheet.hiddenRows.add(r.row);
    else {
      sheet.hiddenRows.delete(r.row);
      if (r.height_px !== sheet.defaultRowPx) sheet.rowPx.set(r.row, r.height_px);
      else sheet.rowPx.delete(r.row);
    }
  }
  for (const r of reply.hidden_rows ?? []) sheet.hiddenRows.add(r);
  for (const c of reply.hidden_cols ?? []) sheet.hiddenCols.add(c);
  for (const m of reply.merged ?? []) {
    const text =
      typeof m === "string"
        ? m
        : typeof (m as { range?: unknown })?.range === "string"
          ? (m as { range: string }).range
          : null;
    const rect = text ? parseRange(text) : null;
    if (text && rect) sheet.merges.set(text, rect);
  }
  for (const c of reply.cells ?? []) {
    sheet.cells.set(cellKey(c.row, c.col), {
      display: c.display ?? "",
      color: c.color ?? null,
      style: c.style_id ?? null,
      value: c.value ?? null,
      formula: c.formula ?? null,
    });
  }
  sheet.tiles.add(key);
  sheet.version++;
  return sheet;
}

/** The grid layout of a viewport sheet. */
export function viewportLayout(sheet: VpSheet, used: Rect | null): SheetLayout {
  return {
    colWidths: new Map(),
    rowHeights: new Map(),
    colPx: sheet.colPx,
    rowPx: sheet.rowPx,
    defaultColPx: sheet.defaultColPx,
    defaultRowPx: sheet.defaultRowPx,
    hiddenRows: sheet.hiddenRows,
    hiddenCols: sheet.hiddenCols,
    merges: [...sheet.merges.values()],
    frozen: sheet.frozen,
    usedRange: used,
    gridlines: sheet.gridlines,
    rowStyles: new Map(),
    colStyles: sheet.colStyles,
    rules: [],
    fromEngine: true,
  };
}

/** Text a viewport cell paints: the number-format result (the grid turns a
 * number that does not fit its cell into `###`, and lets text overflow into
 * empty neighbours). */
export function vpText(cell: VpCell): string {
  return cell.display;
}
