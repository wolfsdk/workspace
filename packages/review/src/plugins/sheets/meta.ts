/**
 * Cell style and sheet layout (column widths, row heights, hidden rows and
 * columns, merges, frozen panes).
 *
 * Two sources, both funnelled through this file:
 *
 * 1. The engine, when its observe carries grid metadata
 *    (docs/engine-ops-xlsx.md "Grid metadata in observe"): sheet nodes have
 *    `grid` {used_range, default_row_height, default_col_width,
 *    base_col_width, cols, rows, merges, pane, gridlines, tab_color}, cell
 *    nodes have `style` (an index into `workbook.styles`), and the view's
 *    `workbook.styles` resolves each index. Ranged observes carry the same
 *    `grid` under `sheets[{id,label,grid}]`. The engine's grid reflects
 *    every applied edit, so nothing is replayed on top of it.
 * 2. Without those members (older module): this session's own applied
 *    batches (`deriveSessionLayout`): every `format`, `freeze` and row/column
 *    insert/delete in `host.history` up to the current revision, replayed
 *    with positional shifts. Exact for what was done in this editor session;
 *    blind to what the file had before.
 * 3. Reactor kernel: `sheetViewport` tiles (`viewport.ts` builds the
 *    layout and feeds styles through `parseEngineStyle`).
 */
import type { Op } from "@wolfsdk/protocol";
import type { HistoryEntry } from "../../host/index.ts";
import { MAX_COLS, MAX_ROWS, colToNum, parseA1, parseRange, type Rect } from "./refs.ts";

export type Edge = { style: string; color: string };
export type CellStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fill?: string;
  halign?: string;
  valign?: string;
  wrap?: boolean;
  top?: Edge;
  right?: Edge;
  bottom?: Edge;
  left?: Edge;
  /** Font size in points when not the default 11. */
  sizePt?: number;
  /** Font family the document asks for (`Calibri`), when the style names one. */
  font?: string;
};

export type StyleRule = { rect: Rect; format: Record<string, unknown> };

export type Frozen = { rows: number; cols: number };

export type SheetLayout = {
  /** Column widths in Excel character units, by column. */
  colWidths: Map<number, number>;
  /** Row heights in points, by row. */
  rowHeights: Map<number, number>;
  /** Exact sizes in px (reactor viewport), preferred over `colWidths` /
   * `rowHeights`. */
  colPx?: Map<number, number>;
  rowPx?: Map<number, number>;
  /** Default sizes in px (file defaults when the engine reports them). */
  defaultColPx: number;
  defaultRowPx: number;
  /** Hidden rows / columns the engine reports (node-level hidden flags are
   * on the model). */
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  /** Merged ranges from the engine grid; null when the grid is absent (the
   * store then uses `extract --what structure`). */
  merges: Rect[] | null;
  /** Rows above / columns left of the frozen split. */
  frozen: Frozen | null;
  /** The engine's used range of the sheet (styled cells included); null
   * without an engine grid. */
  usedRange: Rect | null;
  gridlines: boolean;
  /** Style index of whole rows / columns (engine grid), for empty cells. */
  rowStyles: Map<number, number>;
  colStyles: Map<number, number>;
  /** Session format rules (no engine grid only). */
  rules: StyleRule[];
  /** The layout is the engine's own (file-stored sizes, panes, merges). */
  fromEngine: boolean;
};

/** Excel default column width (8.43 chars) is 64 px; row 15 pt is 20 px. */
export const DEFAULT_COL_PX = 64;
export const DEFAULT_ROW_PX = 20;
export const charsToPx = (chars: number) => Math.round(Math.trunc(((256 * chars + Math.trunc(128 / 7)) / 256) * 7));
/** Inverse of `charsToPx`: the `<col width>` value (which already holds the
 * 5 px cell padding) that `charsToPx` maps back to `px` (checked for 5..600). */
export const pxToChars = (px: number) => Math.max(0, Math.round((px / 7) * 100) / 100);
export const ptToPx = (pt: number) => Math.round((pt * 96) / 72);
export const pxToPt = (px: number) => Math.round(((px * 72) / 96) * 4) / 4;

/** Excel turns a number into `###` only when its formatted text is wider
 * than the column's full width; the text padding of left/right-aligned
 * strings is not reserved. */
export const numberFits = (textPx: number, cellPx: number) => textPx <= cellPx;

/** Left edge of a number `textPx` wide in a cell at `x`, `cellPx` wide:
 * aligned with `pad` while it fits with it, else squeezed into the cell. */
export function numberX(halign: string, x: number, cellPx: number, textPx: number, pad: number): number {
  if (halign === "center") return x + (cellPx - textPx) / 2;
  const slack = Math.max(0, Math.min(pad, (cellPx - textPx) / 2));
  return halign === "left" ? x + slack : x + cellPx - slack - textPx;
}

const HEX = /^#?([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/** `#RRGGBB`, `RRGGBB`, `AARRGGBB`, `{rgb: ...}` -> `#RRGGBB`. */
function color(v: unknown): string | undefined {
  if (typeof v === "string") {
    const m = HEX.exec(v);
    if (!m) return undefined;
    const hex = m[1]!;
    return `#${hex.length === 8 ? hex.slice(2) : hex}`.toUpperCase();
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return color(o.rgb ?? o.color ?? o.hex);
  }
  return undefined;
}

function edge(v: unknown): Edge | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const style = typeof o.style === "string" ? o.style : undefined;
  if (!style || style === "none") return undefined;
  return { style, color: color(o.color) ?? "#000000" };
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ---------------------------------------------------------------------------
// Engine grid metadata
// ---------------------------------------------------------------------------

export type EngineGrid = {
  colWidths: Map<number, number>;
  rowHeights: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  colStyles: Map<number, number>;
  rowStyles: Map<number, number>;
  merges: Rect[];
  frozen: Frozen | null;
  defaultColPx: number;
  defaultRowPx: number;
  gridlines: boolean;
  tabColor?: string;
  usedRange: Rect | null;
};

function rectOf(v: unknown): Rect | null {
  if (typeof v === "string") return parseRange(v);
  const o = record(v);
  const text = o && (o.range ?? o.ref ?? o.a1);
  return typeof text === "string" ? parseRange(text) : null;
}

/** Default column width in px: `default_col_width` (characters) when set,
 * else Excel's rule from `base_col_width` (characters of the maximum digit
 * width, plus 5 px padding, rounded up to a multiple of 8 px). */
function defaultColPx(g: Record<string, unknown>): number {
  const dw = num(g.default_col_width);
  if (dw !== undefined && dw > 0) return charsToPx(dw);
  const base = num(g.base_col_width);
  if (base !== undefined && base > 0) return Math.ceil((base * 7 + 5) / 8) * 8;
  return DEFAULT_COL_PX;
}

/** A sheet `grid` member (sheet node or ranged-observe `sheets[].grid`);
 * null when absent or not an object (older module). */
export function parseEngineGrid(v: unknown): EngineGrid | null {
  const g = record(v);
  if (!g) return null;
  const out: EngineGrid = {
    colWidths: new Map(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    colStyles: new Map(),
    rowStyles: new Map(),
    merges: [],
    frozen: null,
    defaultColPx: defaultColPx(g),
    defaultRowPx:
      num(g.default_row_height) !== undefined && num(g.default_row_height)! > 0
        ? ptToPx(num(g.default_row_height)!)
        : DEFAULT_ROW_PX,
    gridlines: g.gridlines !== false,
    tabColor: color(g.tab_color),
    usedRange: rectOf(g.used_range),
  };
  for (const item of Array.isArray(g.cols) ? g.cols : []) {
    const o = record(item);
    const min = num(o?.min);
    if (!o || min === undefined) continue;
    const max = Math.min(MAX_COLS, num(o.max) ?? min);
    const width = num(o.width);
    const style = num(o.style);
    for (let c = Math.max(1, min); c <= max; c++) {
      if (width !== undefined) out.colWidths.set(c, width);
      if (o.hidden === true) out.hiddenCols.add(c);
      if (style !== undefined) out.colStyles.set(c, style);
    }
  }
  for (const item of Array.isArray(g.rows) ? g.rows : []) {
    const o = record(item);
    const row = num(o?.row);
    if (!o || row === undefined || row < 1) continue;
    const height = num(o.height);
    const style = num(o.style);
    if (height !== undefined) out.rowHeights.set(row, height);
    if (o.hidden === true) out.hiddenRows.add(row);
    if (style !== undefined) out.rowStyles.set(row, style);
  }
  for (const m of Array.isArray(g.merges) ? g.merges : []) {
    const r = rectOf(m);
    if (r) out.merges.push(r);
  }
  const pane = record(g.pane);
  if (pane && (pane.state === "frozen" || pane.state === "frozenSplit")) {
    const cell = typeof pane.top_left_cell === "string" ? parseA1(pane.top_left_cell) : null;
    const rows = num(pane.y_split) ?? (cell ? cell.row - 1 : 0);
    const cols = num(pane.x_split) ?? (cell ? cell.col - 1 : 0);
    if (rows > 0 || cols > 0) out.frozen = { rows: Math.round(rows), cols: Math.round(cols) };
  }
  return out;
}

/** One resolved `workbook.styles[i]` entry -> what the grid draws. */
export function parseEngineStyle(v: unknown): CellStyle {
  const s = record(v);
  const out: CellStyle = {};
  if (!s) return out;
  const font = record(s.font);
  if (font) {
    if (font.bold === true) out.bold = true;
    if (font.italic === true) out.italic = true;
    if (font.underline === true || (typeof font.underline === "string" && font.underline !== "none"))
      out.underline = true;
    if (font.strike === true) out.strike = true;
    const size = num(font.size_pt) ?? num(font.size);
    if (size !== undefined && size > 0 && size !== 11) out.sizePt = size;
    if (typeof font.name === "string" && font.name) out.font = font.name;
    // Black is the automatic/theme text colour of nearly every workbook:
    // leave it to the grid's foreground so dark themes stay readable.
    const c = color(font.color);
    if (c && c !== "#000000") out.color = c;
  }
  const fill = record(s.fill);
  if (fill && typeof fill.pattern === "string" && fill.pattern !== "none") {
    const c = color(fill.color) ?? color(fill.background);
    if (c) out.fill = c;
  }
  const borders = record(s.borders) ?? record(s.border);
  if (borders) {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const e = edge(borders[side]);
      if (e) out[side] = e;
    }
  }
  const align = record(s.alignment);
  if (align) {
    if (typeof align.horizontal === "string" && align.horizontal !== "general") out.halign = align.horizontal;
    if (typeof align.vertical === "string") out.valign = align.vertical;
    if (align.wrap === true) out.wrap = true;
  }
  return out;
}

/** `workbook.styles` of a view, resolved; null when absent (older module). */
export function parseEngineStyles(workbook: unknown): CellStyle[] | null {
  const styles = record(workbook)?.styles;
  return Array.isArray(styles) ? styles.map(parseEngineStyle) : null;
}

// ---------------------------------------------------------------------------
// Session format rules
// ---------------------------------------------------------------------------

/**
 * Apply one `format` patch (op vocabulary, docs/ops-xlsx.md 4.2) to a cell
 * at (`row`, `col`) inside `rect`. Border presets are positional: `outline`
 * only touches the rectangle's perimeter, `inside-*` only its interior
 * edges.
 */
function applyFormat(style: CellStyle, format: Record<string, unknown>, rect: Rect, row: number, col: number): void {
  if ("font" in format) {
    const f = format.font as Record<string, unknown> | null;
    if (f === null) {
      delete style.bold;
      delete style.italic;
      delete style.underline;
      delete style.color;
    } else if (f) {
      if (typeof f.bold === "boolean") style.bold = f.bold;
      if (typeof f.italic === "boolean") style.italic = f.italic;
      if (f.underline !== undefined) style.underline = !!f.underline && f.underline !== "none";
      const c = color(f.color);
      if (c) style.color = c;
    }
  }
  if ("fill" in format) {
    const f = format.fill as Record<string, unknown> | null;
    if (f === null) delete style.fill;
    else {
      const c = color(f?.color ?? f?.fg ?? f);
      if (c) style.fill = c;
    }
  }
  if ("alignment" in format) {
    const a = format.alignment as Record<string, unknown> | null;
    if (a === null) {
      delete style.halign;
      delete style.valign;
      delete style.wrap;
    } else if (a) {
      if (typeof a.horizontal === "string") style.halign = a.horizontal;
      if (typeof a.vertical === "string") style.valign = a.vertical;
      if (typeof a.wrap === "boolean") style.wrap = a.wrap;
    }
  }
  if ("borders" in format) {
    const b = format.borders as Record<string, unknown> | null;
    if (b === null) {
      delete style.top;
      delete style.right;
      delete style.bottom;
      delete style.left;
    } else if (b) {
      const set = (side: "top" | "right" | "bottom" | "left", v: unknown) => {
        const e = edge(v);
        if (e) style[side] = e;
      };
      for (const side of ["top", "right", "bottom", "left"] as const) set(side, b[side]);
      if (b.outline) {
        if (row === rect.r1) set("top", b.outline);
        if (row === rect.r2) set("bottom", b.outline);
        if (col === rect.c1) set("left", b.outline);
        if (col === rect.c2) set("right", b.outline);
      }
      if (b["inside-vertical"]) {
        if (col > rect.c1) set("left", b["inside-vertical"]);
        if (col < rect.c2) set("right", b["inside-vertical"]);
      }
      if (b["inside-horizontal"]) {
        if (row > rect.r1) set("top", b["inside-horizontal"]);
        if (row < rect.r2) set("bottom", b["inside-horizontal"]);
      }
    }
  }
}

/**
 * Style of the cell at (`row`, `col`): the engine style of its node (or of
 * its row, then its column, for cells without a node) when the engine's
 * style table is known, then this session's rules (older module only).
 */
export function cellStyle(
  nodeStyle: unknown,
  layout: SheetLayout,
  styles: CellStyle[] | null,
  row: number,
  col: number,
): CellStyle {
  let style: CellStyle = {};
  if (styles) {
    const index = num(nodeStyle) ?? layout.rowStyles.get(row) ?? layout.colStyles.get(col);
    const base = index !== undefined ? styles[index] : undefined;
    if (base) style = { ...base };
  }
  for (const rule of layout.rules) {
    const r = rule.rect;
    if (row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) applyFormat(style, rule.format, r, row, col);
  }
  return style;
}

// ---------------------------------------------------------------------------
// Session replay
// ---------------------------------------------------------------------------

function targetRect(target: unknown, sheetId: number): Rect | null {
  if (typeof target !== "string") return null;
  if (target === `sheet:#${sheetId}`) return { r1: 1, c1: 1, r2: MAX_ROWS, c2: MAX_COLS };
  const m = /^sheet:#(\d+)\/(cell|range):(.+)$/.exec(target);
  if (!m || Number(m[1]) !== sheetId) return null;
  return parseRange(m[3]!);
}

function shiftMap(map: Map<number, number>, at: number, delta: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [k, v] of map) {
    if (k < at) out.set(k, v);
    else if (delta < 0 && k < at - delta)
      continue; // deleted
    else out.set(k + delta, v);
  }
  return out;
}

function shiftRect(r: Rect, axis: "row" | "col", at: number, delta: number): Rect | null {
  const lo = axis === "row" ? r.r1 : r.c1;
  const hi = axis === "row" ? r.r2 : r.c2;
  let nlo = lo;
  let nhi = hi;
  if (delta > 0) {
    if (lo >= at) nlo += delta;
    if (hi >= at) nhi += delta;
  } else {
    const delEnd = at - delta - 1; // last deleted index
    const shift = (i: number) => (i < at ? i : i > delEnd ? i + delta : at);
    if (lo >= at && hi <= delEnd) return null;
    nlo = shift(lo);
    nhi = hi > delEnd ? hi + delta : hi >= at ? at - 1 : hi;
    if (nhi < nlo) return null;
  }
  return axis === "row" ? { ...r, r1: nlo, r2: nhi } : { ...r, c1: nlo, c2: nhi };
}

function applyStructural(layout: SheetLayout, axis: "row" | "col", at: number, delta: number): void {
  if (axis === "row") layout.rowHeights = shiftMap(layout.rowHeights, at, delta);
  else layout.colWidths = shiftMap(layout.colWidths, at, delta);
  layout.rules = layout.rules.flatMap((rule) => {
    const rect = shiftRect(rule.rect, axis, at, delta);
    return rect ? [{ ...rule, rect }] : [];
  });
}

function replayOp(layout: SheetLayout, op: Op, sheetId: number): void {
  switch (op.op) {
    case "format": {
      const rect = targetRect(op.target, sheetId);
      const format = op.format as Record<string, unknown> | undefined;
      if (!rect || !format) return;
      const { column_width, row_height, ...rest } = format;
      if (typeof column_width === "number")
        for (let c = rect.c1; c <= rect.c2; c++) layout.colWidths.set(c, column_width);
      if (typeof row_height === "number") for (let r = rect.r1; r <= rect.r2; r++) layout.rowHeights.set(r, row_height);
      if (Object.keys(rest).length) layout.rules.push({ rect, format: rest });
      return;
    }
    case "freeze": {
      if (op.target !== `sheet:#${sheetId}`) return;
      const at = typeof op.cell === "string" ? parseA1(op.cell) : null;
      layout.frozen = at && (at.row > 1 || at.col > 1) ? { rows: at.row - 1, cols: at.col - 1 } : null;
      return;
    }
    case "insert": {
      const anchor = typeof op.anchor === "string" ? op.anchor : "";
      const node = op.node as { kind?: string; count?: number } | undefined;
      const count = node?.count ?? 1;
      const row = new RegExp(`^sheet:#${sheetId}/row:@(\\d+)$`).exec(anchor);
      if (row && node?.kind === "row") {
        const at = Number(row[1]) + (op.position === "after" ? 1 : 0);
        applyStructural(layout, "row", at, count);
      }
      const col = new RegExp(`^sheet:#${sheetId}/col:([A-Z]+)$`).exec(anchor);
      if (col && node?.kind === "col") {
        const at = colToNum(col[1]!) + (op.position === "after" ? 1 : 0);
        applyStructural(layout, "col", at, count);
      }
      return;
    }
    case "delete": {
      const target = typeof op.target === "string" ? op.target : "";
      const row = new RegExp(`^sheet:#${sheetId}/row:@(\\d+)$`).exec(target);
      if (row) applyStructural(layout, "row", Number(row[1]), -1);
      const col = new RegExp(`^sheet:#${sheetId}/col:([A-Z]+)$`).exec(target);
      if (col) applyStructural(layout, "col", colToNum(col[1]!), -1);
      return;
    }
  }
}

/** Layout from an engine grid: the file's own sizes, panes and merges, with
 * every applied edit already in it. */
export function engineLayout(grid: EngineGrid): SheetLayout {
  return {
    colWidths: grid.colWidths,
    rowHeights: grid.rowHeights,
    defaultColPx: grid.defaultColPx,
    defaultRowPx: grid.defaultRowPx,
    hiddenRows: grid.hiddenRows,
    hiddenCols: grid.hiddenCols,
    merges: grid.merges,
    usedRange: grid.usedRange,
    frozen: grid.frozen,
    gridlines: grid.gridlines,
    rowStyles: grid.rowStyles,
    colStyles: grid.colStyles,
    rules: [],
    fromEngine: true,
  };
}

/** Layout without an engine grid: defaults, then this session's batches
 * `history[0 .. revision-1]` replayed. */
export function deriveSessionLayout(sheetId: number, history: HistoryEntry[], revision: number): SheetLayout {
  const layout: SheetLayout = {
    colWidths: new Map(),
    rowHeights: new Map(),
    defaultColPx: DEFAULT_COL_PX,
    defaultRowPx: DEFAULT_ROW_PX,
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    merges: null,
    usedRange: null,
    frozen: null,
    gridlines: true,
    rowStyles: new Map(),
    colStyles: new Map(),
    rules: [],
    fromEngine: false,
  };
  for (const entry of history.slice(0, revision)) for (const op of entry.ops) replayOp(layout, op, sheetId);
  return layout;
}
