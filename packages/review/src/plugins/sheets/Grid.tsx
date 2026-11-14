/**
 * Canvas grid: draws only the viewport (headers, frozen panes, cells,
 * merges, styles, selection), handles pointer selection, header resizing,
 * in-place editing and the clipboard. A transparent scroller underneath
 * supplies native scrolling; the canvas sits on top with
 * `pointer-events: none`.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { EditorHost } from "../../host/index.ts";
import { Axis } from "./axis.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { charsToPx, numberFits, numberX, ptToPx, type CellStyle, type SheetLayout } from "./meta.ts";
import { cellKey, isErrorValue, type CellData, type SheetModel } from "./model.ts";
import { MAX_COLS, MAX_ROWS, numToCol, toA1, type Rect } from "./refs.ts";
import { useSheets, type SheetsStore } from "./store.ts";
import { dispatch, EDIT_KEYS } from "./keys.ts";
import { CssFace, type TextFace } from "./fonts.ts";

const HEADER_H = 22;
/** Command kernel (no engine faces): cell text in the system stack, 13 px
 * for 11 pt at 100 %. */
const FONT_PX = 13;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/** Workbook defaults on the cell area, the same in every theme (the cell
 * area is the document: white unless the file fills it). */
const CELL_GRIDLINE = "#dadce0";
const CELL_TEXT = "#000000";
const CELL_PENDING = "#8c959f";
const CELL_ERROR = "#c8312b";
const CELL_LINK = "#0563c1";
/** Bar drawn in a cell whose reactor viewport tile is still loading. */
const CELL_PLACEHOLDER = "#e8eaed";
/** Text inset (px at 100 %) from the right edge (which holds the gridline)
 * and from the left edge; Excel's printed pages of model-finance put ink
 * about 2.5-3.6 px in from the left and 5 px in from the right. */
const PAD = 4;
const PAD_LEFT = 2;

type Geo = {
  rows: Axis;
  cols: Axis;
  hw: number;
  hh: number;
  fr: number;
  fc: number;
  fw: number;
  fh: number;
  sl: number;
  st: number;
  w: number;
  h: number;
  /** Zoom (`EditorSnapshot.zoom`): every size above is already scaled. */
  z: number;
};

/** Canvas colours. Header strip, corner, header lines and the frozen-pane
 * line follow the editor theme; the cell area keeps the workbook's colours;
 * selection marks on the cell area use the theme-independent page tokens. */
type Palette = {
  /** Cell area. */
  page: string;
  grid: string;
  text: string;
  pending: string;
  error: string;
  link: string;
  selection: string;
  focusRing: string;
  /** Theme (chrome). */
  header: string;
  headerFg: string;
  headerSel: string;
  headerSelFg: string;
  headerLine: string;
  accent: string;
  onAccent: string;
  frozen: string;
  /** Header label size (px at 100 %) and family. */
  headerPx: number;
  headerFamily: string;
};

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    page: v("--we-page", "#ffffff"),
    grid: CELL_GRIDLINE,
    text: CELL_TEXT,
    pending: CELL_PENDING,
    error: CELL_ERROR,
    link: CELL_LINK,
    selection: v("--we-page-selection", "#2463eb"),
    focusRing: v("--we-page-focus-ring", "#0b4fd6"),
    header: v("--we-surface", "#f6f7f9"),
    headerFg: v("--we-muted", "#6b707c"),
    headerSel: v("--we-selected", "rgba(36, 99, 235, 0.12)"),
    headerSelFg: v("--we-fg", "#1b1d22"),
    headerLine: v("--we-border", "#d6d8de"),
    accent: v("--we-accent", "#2463eb"),
    onAccent: v("--we-on-accent", "#ffffff"),
    frozen: v("--we-border-strong", "#b9bcc5"),
    headerPx: Number.parseFloat(v("--we-text-sm", "12px")) || 12,
    headerFamily: v("--we-font", 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'),
  };
}

type Hit = {
  kind: "corner" | "col" | "row" | "cell";
  row: number;
  col: number;
  resize?: { axis: "col" | "row"; index: number; start: number };
};

type Drag =
  | { kind: "cells"; additive: boolean }
  | { kind: "cols" | "rows" }
  | { kind: "resize"; axis: "col" | "row"; index: number; start: number; origin: number; size: number; current: number }
  /** Fill handle: `to` is the selection grown down or right. */
  | { kind: "fill"; from: Rect; to: Rect };

/** The range the fill handle sits on: a single range that is not a whole
 * row/column, while the module has not refused the fill. */
function fillSource(store: SheetsStore): Rect | null {
  const sel = store.selection;
  if (sel.ranges.length !== 1 || store.isDisabled("fill-handle")) return null;
  const r = sel.ranges[0]!;
  return r.r2 >= MAX_ROWS || r.c2 >= MAX_COLS ? null : r;
}

/** Screen position of the fill handle (bottom-right corner of the range). */
function fillHandlePos(geo: Geo, r: Rect): { x: number; y: number } {
  const { rows, cols, hw, hh, fc, fr, sl, st } = geo;
  return {
    x: hw + cols.start(r.c2) + cols.sizeOf(r.c2) - (r.c2 <= fc ? 0 : sl),
    y: hh + rows.start(r.r2) + rows.sizeOf(r.r2) - (r.r2 <= fr ? 0 : st),
  };
}

/** The fill target for the pointer over (`row`, `col`): `from` grown down
 * or right along the axis the pointer moved further past it. */
function fillTarget(from: Rect, row: number, col: number): Rect {
  const dr = row - from.r2;
  const dc = col - from.c2;
  if (dr > 0 && dr >= dc) return { ...from, r2: row };
  if (dc > 0) return { ...from, c2: col };
  return from;
}

type MirrorCell = { a1: string; text: string; formula?: string; error: boolean; link?: string; loading?: boolean };

/** Cell editor overlay: position and size (scaled), CSS font, zoom. */
type EditorBox = { left: number; top: number; width: number; height: number; font: string; z: number };

type GridMenu = { kind: "cell" | "row" | "col"; x: number; y: number };

function buildGeo(
  store: SheetsStore,
  sheet: SheetModel,
  layout: SheetLayout,
  w: number,
  h: number,
  sl: number,
  st: number,
): Geo {
  const z = store.host.getSnapshot().zoom;
  const zs = (px: number) => (px > 0 ? Math.max(1, Math.round(px * z)) : 0);
  const sel = store.selection.active;
  const used = layout.usedRange;
  const rowCount = Math.min(MAX_ROWS, Math.max(10000, sheet.maxRow + 1000, (used?.r2 ?? 0) + 1000, sel.row + 100));
  const colCount = Math.min(MAX_COLS, Math.max(100, sheet.maxCol + 20, (used?.c2 ?? 0) + 20, sel.col + 20));
  const colOverrides = new Map<number, number>();
  for (const [c, chars] of layout.colWidths) colOverrides.set(c, zs(charsToPx(chars)));
  if (layout.colPx) for (const [c, px] of layout.colPx) colOverrides.set(c, zs(px));
  for (const c of sheet.hiddenCols) colOverrides.set(c, 0);
  for (const c of layout.hiddenCols) colOverrides.set(c, 0);
  const rowOverrides = new Map<number, number>();
  for (const [r, pt] of layout.rowHeights) rowOverrides.set(r, zs(ptToPx(pt)));
  if (layout.rowPx) for (const [r, px] of layout.rowPx) rowOverrides.set(r, zs(px));
  for (const r of sheet.hiddenRows) rowOverrides.set(r, 0);
  for (const r of layout.hiddenRows) rowOverrides.set(r, 0);
  const cols = new Axis(colCount, zs(layout.defaultColPx), colOverrides);
  const rows = new Axis(rowCount, zs(layout.defaultRowPx), rowOverrides);
  const digits = String(Math.max(rows.indexAt(st + h), 1000)).length;
  const hw = Math.round((14 + digits * 8) * z);
  const fr = layout.frozen?.rows ?? 0;
  const fc = layout.frozen?.cols ?? 0;
  return {
    rows,
    cols,
    hw,
    hh: Math.round(HEADER_H * z),
    fr,
    fc,
    fw: cols.start(fc + 1),
    fh: rows.start(fr + 1),
    sl,
    st,
    w,
    h,
    z,
  };
}

/** Visible index span of one axis section. */
function span(axis: Axis, from: number, to: number, offset: number, length: number): [number, number] {
  if (from > to || length <= 0) return [1, 0];
  const a = Math.max(from, axis.indexAt(axis.start(from) + offset));
  const b = Math.min(to, axis.indexAt(axis.start(from) + offset + length));
  return [a, b];
}

/** Scroll the minimum needed for (`row`, `col`) to be visible; frozen rows
 * and columns are always visible. */
function scrollIntoView(scroller: HTMLElement, geo: Geo, row: number, col: number): void {
  const viewW = scroller.clientWidth - geo.hw - geo.fw;
  const viewH = scroller.clientHeight - geo.hh - geo.fh;
  if (col > geo.fc) {
    const x0 = geo.cols.start(col) - geo.fw;
    const x1 = geo.cols.end(col) - geo.fw;
    if (x0 < scroller.scrollLeft) scroller.scrollLeft = x0;
    else if (x1 > scroller.scrollLeft + viewW) scroller.scrollLeft = Math.min(x0, x1 - viewW);
  }
  if (row > geo.fr) {
    const y0 = geo.rows.start(row) - geo.fh;
    const y1 = geo.rows.end(row) - geo.fh;
    if (y0 < scroller.scrollTop) scroller.scrollTop = y0;
    else if (y1 > scroller.scrollTop + viewH) scroller.scrollTop = Math.min(y0, y1 - viewH);
  }
}

function snap(v: number, dpr: number): number {
  return (Math.round(v * dpr) + 0.5) / dpr;
}

function wrapLines(face: TextFace, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && face.measure(next) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Measures and paints cell text for one draw: the document's font through
 * the engine's faces at its true size (11 pt = 14.67 px at 100 %) on the
 * reactor kernel, the system stack elsewhere (and for fonts or glyphs the
 * engine serves no face for). */
function faceResolver(store: SheetsStore, ctx: CanvasRenderingContext2D, z: number): (style: CellStyle) => TextFace {
  const fonts = store.fonts;
  const family = store.defaultFont?.name;
  const cache = new Map<string, TextFace>();
  return (s) => {
    const pt = s.sizePt ?? 11;
    const name = s.font ?? family ?? "";
    const key = `${name}|${pt}|${s.bold ? 1 : 0}${s.italic ? 1 : 0}`;
    let face = cache.get(key);
    if (!face) {
      if (fonts) {
        const px = ((pt * 96) / 72) * z;
        const system = new CssFace(px, systemFont(px, s), ctx);
        face = name ? fonts.face(name, !!s.bold, !!s.italic, px, ctx, system) : system;
      } else {
        const px = (s.sizePt ? Math.max(6, Math.round((s.sizePt * FONT_PX) / 11)) : FONT_PX) * z;
        face = new CssFace(px, systemFont(px, s), ctx, (px * 16) / FONT_PX);
      }
      cache.set(key, face);
    }
    return face;
  };
}

function systemFont(px: number, s: CellStyle): string {
  return `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${px}px ${FONT_FAMILY}`;
}

/** CSS font of the cell editor for `style`: the engine face the grid draws
 * with (it is registered in `document.fonts`), else the system stack. */
function editorFont(store: SheetsStore, style: CellStyle, z: number): string {
  const fonts = store.fonts;
  const name = style.font ?? store.defaultFont?.name;
  const px = fonts
    ? ((style.sizePt ?? 11) * 96 * z) / 72
    : (style.sizePt ? Math.max(6, Math.round((style.sizePt * FONT_PX) / 11)) : FONT_PX) * z;
  return (fonts && name ? fonts.cssFont(name, !!style.bold, !!style.italic, px) : null) ?? systemFont(px, style);
}

function edgeWidth(style: string): number {
  return style === "medium" || style === "mediumDashed" ? 2 : style === "thick" || style === "double" ? 3 : 1;
}

function draw(
  canvas: HTMLCanvasElement,
  store: SheetsStore,
  sheet: SheetModel,
  geo: Geo,
  pal: Palette,
  drag: Drag | null,
): MirrorCell[] {
  const dpr = globalThis.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const { rows, cols, hw, hh, fr, fc, fw, fh, sl, st, w, h, z } = geo;
  /** Text inset from the cell's left/right and top/bottom edges. */
  const pad = PAD * z;
  const padL = PAD_LEFT * z;
  const edge = 2 * z;
  const faceOf = faceResolver(store, ctx, z);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.page;
  ctx.fillRect(0, 0, w, h);

  const layout = store.layout(sheet);
  const merges = store.merges(sheet);
  const sel = store.selection;
  const mirror: MirrorCell[] = [];
  const editing = store.editing;

  // Section spans: [frozen, scrolled] for rows and columns.
  const colSpans: { a: number; b: number; qsl: number; x0: number; x1: number }[] = [];
  if (fc > 0) {
    const [a, b] = span(cols, 1, fc, 0, fw);
    colSpans.push({ a, b, qsl: 0, x0: hw, x1: Math.min(w, hw + fw) });
  }
  {
    const [a, b] = span(cols, fc + 1, cols.count, sl, w - hw - fw);
    colSpans.push({ a, b, qsl: sl, x0: hw + fw, x1: w });
  }
  const rowSpans: { a: number; b: number; qst: number; y0: number; y1: number }[] = [];
  if (fr > 0) {
    const [a, b] = span(rows, 1, fr, 0, fh);
    rowSpans.push({ a, b, qst: 0, y0: hh, y1: Math.min(h, hh + fh) });
  }
  {
    const [a, b] = span(rows, fr + 1, rows.count, st, h - hh - fh);
    rowSpans.push({ a, b, qst: st, y0: hh + fh, y1: h });
  }

  const mergeAnchor = new Map<number, Rect>();
  const covered = new Set<number>();

  for (const rs of rowSpans) {
    for (const cs of colSpans) {
      if (rs.a > rs.b || cs.a > cs.b) continue;
      const X = (c: number) => hw + cols.start(c) - cs.qsl;
      const Y = (r: number) => hh + rows.start(r) - rs.qst;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cs.x0, rs.y0, cs.x1 - cs.x0, rs.y1 - rs.y0);
      ctx.clip();

      // Merges intersecting this quadrant.
      const quad = { r1: rs.a, c1: cs.a, r2: rs.b, c2: cs.b };
      mergeAnchor.clear();
      covered.clear();
      for (const m of merges) {
        if (m.r2 < quad.r1 || m.r1 > quad.r2 || m.c2 < quad.c1 || m.c1 > quad.c2) continue;
        mergeAnchor.set(cellKey(m.r1, m.c1), m);
        for (let r = Math.max(m.r1, quad.r1); r <= Math.min(m.r2, quad.r2); r++)
          for (let c = Math.max(m.c1, quad.c1); c <= Math.min(m.c2, quad.c2); c++) covered.add(cellKey(r, c));
      }

      // Styles for visible cells (and merge anchors outside the quadrant).
      const styles = new Map<number, CellStyle>();
      const styleAt = (r: number, c: number) => {
        const k = cellKey(r, c);
        let s = styles.get(k);
        if (!s) {
          s = store.styleOf(sheet, r, c);
          styles.set(k, s);
        }
        return s;
      };

      // Fills.
      for (let r = rs.a; r <= rs.b; r++) {
        const rh = rows.sizeOf(r);
        if (rh === 0) continue;
        for (let c = cs.a; c <= cs.b; c++) {
          const cw = cols.sizeOf(c);
          if (cw === 0 || covered.has(cellKey(r, c))) continue;
          const s = styleAt(r, c);
          if (s.fill) {
            ctx.fillStyle = s.fill;
            ctx.fillRect(X(c), Y(r), cw, rh);
          }
        }
      }

      // Gridlines (off when the sheet hides them).
      if (layout.gridlines) {
        ctx.strokeStyle = pal.grid;
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        for (let c = cs.a; c <= cs.b; c++) {
          if (cols.sizeOf(c) === 0) continue;
          const x = snap(X(c) + cols.sizeOf(c) - 1, dpr);
          ctx.moveTo(x, rs.y0);
          ctx.lineTo(x, rs.y1);
        }
        for (let r = rs.a; r <= rs.b; r++) {
          if (rows.sizeOf(r) === 0) continue;
          const y = snap(Y(r) + rows.sizeOf(r) - 1, dpr);
          ctx.moveTo(cs.x0, y);
          ctx.lineTo(cs.x1, y);
        }
        ctx.stroke();
      }

      // Merged areas: one box, background over the inner gridlines.
      for (const m of mergeAnchor.values()) {
        const x = X(m.c1);
        const y = Y(m.r1);
        const mw = cols.start(m.c2 + 1) - cols.start(m.c1);
        const mh = rows.start(m.r2 + 1) - rows.start(m.r1);
        ctx.fillStyle = styleAt(m.r1, m.c1).fill ?? pal.page;
        ctx.fillRect(x, y, mw - 1, mh - 1);
      }

      // Text, borders, error markers.
      const drawText = (
        r: number,
        c: number,
        x: number,
        y: number,
        cw: number,
        rh: number,
        cell: CellData | undefined,
        clipW: number,
      ) => {
        const text = store.displayText(sheet, cell, r, c);
        if (editing && editing.sheetId === sheet.sheetId && editing.row === r && editing.col === c) return;
        if (!text) return;
        const s = styleAt(r, c);
        const v = cell?.value;
        const isNum = !!v && "number" in v && !store.pending.has(`${sheet.sheetId}:${cellKey(r, c)}`);
        const isErr = isErrorValue(v);
        const isBool = !!v && "boolean" in v;
        const isLink = !!store.linkAt(sheet, r, c);
        const halign =
          s.halign && s.halign !== "general" ? s.halign : isNum ? "right" : isErr || isBool ? "center" : "left";
        const face = faceOf(s);
        ctx.fillStyle = store.pending.has(`${sheet.sheetId}:${cellKey(r, c)}`)
          ? pal.pending
          : isErr
            ? pal.error
            : (s.color ?? (isLink ? pal.link : pal.text));
        let shown = text;
        const inner = cw - pad - padL;
        const valign = s.valign ?? "bottom";
        if (s.wrap) {
          const lines = wrapLines(face, text, inner);
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cw - 1, rh - 1);
          ctx.clip();
          // The block sits by the vertical alignment (bottom by default, as
          // in Excel), never above the cell top.
          const lh = face.lineHeight;
          const block = lines.length * lh;
          const y0 =
            valign === "top"
              ? y + edge
              : Math.max(y + edge, valign === "center" ? y + (rh - block) / 2 : y + rh - 1 - block - edge);
          const lead = face.ascent + (lh - face.ascent - face.descent) / 2;
          lines.forEach((line, i) => {
            const lw = face.measure(line);
            const tx = halign === "right" ? x + cw - pad - lw : halign === "center" ? x + (cw - lw) / 2 : x + padL;
            face.draw(ctx, line, tx, y0 + i * lh + lead);
          });
          ctx.restore();
        } else {
          let tw = face.measure(shown);
          if (isNum && !numberFits(tw, cw)) {
            shown = "#".repeat(Math.max(1, Math.floor(cw / Math.max(1, face.measure("#")))));
            tw = face.measure(shown);
          }
          const avail = halign === "left" ? clipW : cw;
          const tx = isNum
            ? numberX(halign, x, cw, tw, halign === "left" ? padL : pad)
            : halign === "right"
              ? x + cw - pad - tw
              : halign === "center"
                ? x + (cw - tw) / 2
                : x + padL;
          // Baseline: descenders clear the bottom edge (bottom), the
          // ascent+descent box centred (center), ascenders at the top edge.
          const ty =
            valign === "top"
              ? y + edge + face.ascent
              : valign === "center"
                ? y + (rh - 1 - face.ascent - face.descent) / 2 + face.ascent
                : y + rh - 1 - edge - face.descent;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, avail - 1, rh - 1);
          ctx.clip();
          face.draw(ctx, shown, tx, ty);
          const line = Math.max(1, Math.round(z));
          if (s.underline || isLink) ctx.fillRect(tx, ty + Math.max(1, face.descent * 0.4), tw, line);
          if (s.strike) ctx.fillRect(tx, ty - face.px * 0.27, tw, line);
          ctx.restore();
        }
        if (isErr) {
          const t = 6 * z;
          ctx.fillStyle = pal.error;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + t, y);
          ctx.lineTo(x, y + t);
          ctx.closePath();
          ctx.fill();
        }
      };

      for (let r = rs.a; r <= rs.b; r++) {
        const rh = rows.sizeOf(r);
        if (rh === 0) continue;
        for (let c = cs.a; c <= cs.b; c++) {
          const cw = cols.sizeOf(c);
          const k = cellKey(r, c);
          if (cw === 0 || covered.has(k)) continue;
          const cell = sheet.cells.get(k);
          if (!store.cellLoaded(sheet, r, c)) {
            // Reactor tile still loading: a bar where the model has a value.
            if (cell && (cell.formula || (cell.value && !("empty" in cell.value)))) {
              ctx.fillStyle = CELL_PLACEHOLDER;
              ctx.fillRect(
                X(c) + pad,
                Y(r) + Math.max(3 * z, rh / 2 - 4 * z),
                Math.max(4, Math.min(cw - pad * 2, 48 * z)),
                Math.min(8 * z, rh - 6 * z),
              );
              mirror.push({ a1: toA1(r, c), text: "", formula: cell.formula, error: false, loading: true });
            }
            continue;
          }
          const text = store.displayText(sheet, cell, r, c);
          if (!text && !cell?.formula) continue;
          // Left-aligned text overflows into empty neighbours.
          let clipW = cw;
          for (let n = c + 1; n <= cs.b + 1 && n <= cols.count; n++) {
            const nk = cellKey(r, n);
            if (
              covered.has(nk) ||
              mergeAnchor.has(nk) ||
              store.hasValue(sheet, r, n) ||
              store.pending.has(`${sheet.sheetId}:${nk}`)
            )
              break;
            clipW += cols.sizeOf(n);
            if (clipW > 2000) break;
          }
          drawText(r, c, X(c), Y(r), cw, rh, cell, clipW);
          mirror.push({
            a1: toA1(r, c),
            text,
            formula: cell?.formula,
            error: isErrorValue(cell?.value),
            link: linkText(store.linkAt(sheet, r, c)),
          });
        }
      }
      for (const m of mergeAnchor.values()) {
        const cell = sheet.cells.get(cellKey(m.r1, m.c1));
        const mw = cols.start(m.c2 + 1) - cols.start(m.c1);
        const mh = rows.start(m.r2 + 1) - rows.start(m.r1);
        drawText(m.r1, m.c1, X(m.c1), Y(m.r1), mw, mh, cell, mw);
        const text = store.displayText(sheet, cell, m.r1, m.c1);
        if (text)
          mirror.push({
            a1: toA1(m.r1, m.c1),
            text,
            formula: cell?.formula,
            error: isErrorValue(cell?.value),
            link: linkText(store.linkAt(sheet, m.r1, m.c1)),
          });
      }

      // Borders.
      for (let r = rs.a; r <= rs.b; r++) {
        const rh = rows.sizeOf(r);
        if (rh === 0) continue;
        for (let c = cs.a; c <= cs.b; c++) {
          const cw = cols.sizeOf(c);
          if (cw === 0) continue;
          const s = styleAt(r, c);
          if (!s.top && !s.right && !s.bottom && !s.left) continue;
          const x = X(c);
          const y = Y(r);
          const line = (e: { style: string; color: string }, x1: number, y1: number, x2: number, y2: number) => {
            ctx.strokeStyle = e.color;
            ctx.lineWidth = edgeWidth(e.style);
            ctx.setLineDash(
              e.style.includes("dash") ? [3, 2] : e.style === "dotted" || e.style === "hair" ? [1, 1] : [],
            );
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          };
          if (s.top) line(s.top, x - 1, snap(y - 1, dpr), x + cw, snap(y - 1, dpr));
          if (s.bottom) line(s.bottom, x - 1, snap(y + rh - 1, dpr), x + cw, snap(y + rh - 1, dpr));
          if (s.left) line(s.left, snap(x - 1, dpr), y - 1, snap(x - 1, dpr), y + rh);
          if (s.right) line(s.right, snap(x + cw - 1, dpr), y - 1, snap(x + cw - 1, dpr), y + rh);
          ctx.setLineDash([]);
        }
      }

      // Selection.
      const rectBox = (r: Rect) => {
        const x = X(r.c1);
        const y = Y(r.r1);
        return {
          x,
          y,
          w: cols.start(Math.min(r.c2, cols.count) + 1) - cols.start(r.c1),
          h: rows.start(Math.min(r.r2, rows.count) + 1) - rows.start(r.r1),
        };
      };
      ctx.fillStyle = pal.selection;
      ctx.globalAlpha = 0.12;
      for (const range of sel.ranges) {
        const b = rectBox(range);
        if (range.r1 === range.r2 && range.c1 === range.c2 && sel.ranges.length === 1) continue;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      ctx.globalAlpha = 1;
      if (drag?.kind === "fill" && (drag.to.r2 !== drag.from.r2 || drag.to.c2 !== drag.from.c2)) {
        const b = rectBox(drag.to);
        ctx.strokeStyle = pal.selection;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        ctx.setLineDash([]);
      }
      const activeRange = sel.ranges[sel.ranges.length - 1]!;
      {
        const b = rectBox(activeRange);
        ctx.strokeStyle = pal.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x - 0.5, b.y - 0.5, b.w, b.h);
      }
      {
        const m = store.mergeAt(sel.active.row, sel.active.col);
        const b = rectBox(m ?? { r1: sel.active.row, c1: sel.active.col, r2: sel.active.row, c2: sel.active.col });
        if (m || activeRange.r1 !== activeRange.r2 || activeRange.c1 !== activeRange.c2) {
          ctx.strokeStyle = pal.selection;
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 2, b.h - 2);
        }
      }
      const handleOn = drag?.kind === "fill" ? null : fillSource(store);
      if (handleOn) {
        // Fill handle: a square on the bottom-right corner.
        const b = rectBox(handleOn);
        ctx.fillStyle = pal.page;
        ctx.fillRect(b.x + b.w - 5, b.y + b.h - 5, 8, 8);
        ctx.fillStyle = pal.selection;
        ctx.fillRect(b.x + b.w - 4, b.y + b.h - 4, 6, 6);
      }
      if (store.clip && store.clip.sheetId === sheet.sheetId) {
        const b = rectBox(store.clip.rect);
        ctx.strokeStyle = pal.selection;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.x + 1, b.y + 1, b.w - 3, b.h - 3);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  // Headers.
  const active = sel.ranges[sel.ranges.length - 1]!;
  const colSelected = (c: number) => sel.ranges.some((r) => c >= r.c1 && c <= r.c2);
  const rowSelected = (r: number) => sel.ranges.some((x) => r >= x.r1 && r <= x.r2);
  const fullCol = (c: number) => sel.ranges.some((r) => r.r1 === 1 && r.r2 === MAX_ROWS && c >= r.c1 && c <= r.c2);
  const fullRow = (row: number) =>
    sel.ranges.some((r) => r.c1 === 1 && r.c2 === MAX_COLS && row >= r.r1 && row <= r.r2);
  ctx.font = `${pal.headerPx * z}px ${pal.headerFamily}`;
  ctx.textBaseline = "middle";
  for (const cs of colSpans) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cs.x0, 0, cs.x1 - cs.x0, hh);
    ctx.clip();
    ctx.fillStyle = pal.header;
    ctx.fillRect(cs.x0, 0, cs.x1 - cs.x0, hh);
    for (let c = cs.a; c <= cs.b; c++) {
      const cw = cols.sizeOf(c);
      if (cw === 0) continue;
      const x = hw + cols.start(c) - cs.qsl;
      if (colSelected(c)) {
        ctx.fillStyle = fullCol(c) ? pal.accent : pal.headerSel;
        ctx.fillRect(x, 0, cw, hh);
      }
      ctx.fillStyle = fullCol(c) ? pal.onAccent : colSelected(c) ? pal.headerSelFg : pal.headerFg;
      const label = numToCol(c);
      ctx.fillText(label, x + (cw - ctx.measureText(label).width) / 2, hh / 2);
      ctx.strokeStyle = pal.headerLine;
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      ctx.moveTo(snap(x + cw - 1, dpr), 0);
      ctx.lineTo(snap(x + cw - 1, dpr), hh);
      ctx.stroke();
      // Hidden columns before this one: Excel's double line.
      if (c > 1 && cols.sizeOf(c - 1) === 0) hiddenMarker(ctx, pal, "col", x, hh);
    }
    ctx.restore();
  }
  for (const rs of rowSpans) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rs.y0, hw, rs.y1 - rs.y0);
    ctx.clip();
    ctx.fillStyle = pal.header;
    ctx.fillRect(0, rs.y0, hw, rs.y1 - rs.y0);
    for (let r = rs.a; r <= rs.b; r++) {
      const rh = rows.sizeOf(r);
      if (rh === 0) continue;
      const y = hh + rows.start(r) - rs.qst;
      if (rowSelected(r)) {
        ctx.fillStyle = fullRow(r) ? pal.accent : pal.headerSel;
        ctx.fillRect(0, y, hw, rh);
      }
      ctx.fillStyle = fullRow(r) ? pal.onAccent : rowSelected(r) ? pal.headerSelFg : pal.headerFg;
      const label = String(r);
      ctx.fillText(label, hw - pad - 2 * z - ctx.measureText(label).width, y + rh / 2);
      ctx.strokeStyle = pal.headerLine;
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      ctx.moveTo(0, snap(y + rh - 1, dpr));
      ctx.lineTo(hw, snap(y + rh - 1, dpr));
      ctx.stroke();
      if (r > 1 && rows.sizeOf(r - 1) === 0) hiddenMarker(ctx, pal, "row", y, hw);
    }
    ctx.restore();
  }
  // Corner and header edges.
  ctx.fillStyle =
    active.r1 === 1 && active.c1 === 1 && active.r2 === MAX_ROWS && active.c2 === MAX_COLS ? pal.accent : pal.header;
  ctx.fillRect(0, 0, hw, hh);
  ctx.strokeStyle = pal.headerLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, snap(hh - 1, dpr));
  ctx.lineTo(w, snap(hh - 1, dpr));
  ctx.moveTo(snap(hw - 1, dpr), 0);
  ctx.lineTo(snap(hw - 1, dpr), h);
  ctx.stroke();
  // Frozen split lines.
  ctx.strokeStyle = pal.frozen;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (fr > 0) {
    ctx.moveTo(0, hh + fh - 0.5);
    ctx.lineTo(w, hh + fh - 0.5);
  }
  if (fc > 0) {
    ctx.moveTo(hw + fw - 0.5, 0);
    ctx.lineTo(hw + fw - 0.5, h);
  }
  ctx.stroke();
  // Resize guide.
  if (drag?.kind === "resize") {
    ctx.strokeStyle = pal.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (drag.axis === "col") {
      ctx.moveTo(drag.current + 0.5, 0);
      ctx.lineTo(drag.current + 0.5, h);
    } else {
      ctx.moveTo(0, drag.current + 0.5);
      ctx.lineTo(w, drag.current + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return mirror;
}

/** `url`, or `#location` for an internal link (mirror `data-link`). */
function linkText(link: { url?: string; location?: string } | null): string | undefined {
  return link ? (link.url ?? (link.location ? `#${link.location}` : undefined)) : undefined;
}

/** Two lines across a header where hidden rows/columns sit (at `at`, the
 * start of the next visible one). */
function hiddenMarker(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  axis: "row" | "col",
  at: number,
  depth: number,
): void {
  ctx.strokeStyle = pal.headerFg;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const d of [-2.5, 0.5]) {
    if (axis === "col") {
      ctx.moveTo(at + d, 2);
      ctx.lineTo(at + d, depth - 2);
    } else {
      ctx.moveTo(2, at + d);
      ctx.lineTo(depth - 2, at + d);
    }
  }
  ctx.stroke();
}

function hitTest(geo: Geo, x: number, y: number): Hit {
  const { rows, cols, hw, hh, fw, fh, sl, st, fc, fr } = geo;
  const col = x < hw ? 0 : x < hw + fw ? cols.indexAt(x - hw) : cols.indexAt(x - hw + sl);
  const row = y < hh ? 0 : y < hh + fh ? rows.indexAt(y - hh) : rows.indexAt(y - hh + st);
  const colX = (c: number) => hw + cols.start(c) - (c <= fc ? 0 : sl);
  const rowY = (r: number) => hh + rows.start(r) - (r <= fr ? 0 : st);
  if (y < hh && x < hw) return { kind: "corner", row: 0, col: 0 };
  if (y < hh) {
    // Border of this column or the previous visible one.
    const end = colX(col) + cols.sizeOf(col);
    if (Math.abs(x - end) <= 4) return { kind: "col", row, col, resize: { axis: "col", index: col, start: colX(col) } };
    let prev = col - 1;
    while (prev >= 1 && cols.sizeOf(prev) === 0) prev--;
    if (prev >= 1 && Math.abs(x - colX(col)) <= 4)
      return { kind: "col", row, col, resize: { axis: "col", index: prev, start: colX(prev) } };
    return { kind: "col", row, col };
  }
  if (x < hw) {
    const end = rowY(row) + rows.sizeOf(row);
    if (Math.abs(y - end) <= 3) return { kind: "row", row, col, resize: { axis: "row", index: row, start: rowY(row) } };
    let prev = row - 1;
    while (prev >= 1 && rows.sizeOf(prev) === 0) prev--;
    if (prev >= 1 && Math.abs(y - rowY(row)) <= 3)
      return { kind: "row", row, col, resize: { axis: "row", index: prev, start: rowY(prev) } };
    return { kind: "row", row, col };
  }
  return { kind: "cell", row, col };
}

export function Grid({ host }: { host: EditorHost }) {
  const store = useSheets(host);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const geoRef = useRef<Geo | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [mirror, setMirror] = useState<MirrorCell[]>([]);
  const mirrorTimer = useRef<number | undefined>(undefined);
  const [cursor, setCursor] = useState("cell");
  const [hint, setHint] = useState("");
  const [menu, setMenu] = useState<GridMenu | null>(null);
  const sheet = store.sheet;
  const layout = sheet ? store.layout(sheet) : null;

  const paint = () => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    const root = rootRef.current;
    const s = store.sheet;
    if (!canvas || !scroller || !root || !s) return;
    const w = scroller.clientWidth;
    const h = scroller.clientHeight;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const geo = buildGeo(store, s, store.layout(s), w, h, scroller.scrollLeft, scroller.scrollTop);
    geoRef.current = geo;
    const spacer = scroller.firstElementChild as HTMLElement | null;
    if (spacer) {
      const sw = `${geo.hw + geo.cols.total}px`;
      const sh = `${geo.hh + geo.rows.total}px`;
      if (spacer.style.width !== sw) spacer.style.width = sw;
      if (spacer.style.height !== sh) spacer.style.height = sh;
    }
    const cells = draw(canvas, store, s, geo, readPalette(root), dragRef.current);
    // Scrolled area: rows/columns under the top-left corner below the frozen
    // panes, through the bottom-right edge of the scroller.
    const r1 = Math.max(geo.fr + 1, geo.rows.indexAt(geo.st + geo.fh));
    const c1 = Math.max(geo.fc + 1, geo.cols.indexAt(geo.sl + geo.fw));
    const r2 = geo.rows.indexAt(geo.st + h - geo.hh);
    const c2 = geo.cols.indexAt(geo.sl + w - geo.hw);
    const { defaultRowPx, defaultColPx } = store.layout(s);
    const pageRows = Math.max(1, Math.floor((h - geo.hh - geo.fh) / (defaultRowPx * geo.z)));
    const pageCols = Math.max(1, Math.floor((w - geo.hw - geo.fw) / (defaultColPx * geo.z)));
    store.viewport = { sheetId: s.sheetId, r1, r2, c1, c2, pageRows, pageCols };
    // Reactor kernel: viewport tiles for what is on screen now (coalesced
    // in the store: one request in flight, latest window wins).
    store.requestViewport(s, { r1, c1, r2: Math.max(r1, r2), c2: Math.max(c1, c2) });
    clearTimeout(mirrorTimer.current);
    mirrorTimer.current = window.setTimeout(() => {
      setMirror(cells);
      store.ensureViewport({ sheetId: s.sheetId, r1, r2, c1, c2, pageRows, pageCols });
    }, 120);
  };

  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  };

  // Repaint on every store/host change (this component re-renders on both).
  useLayoutEffect(schedule);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      const sc = scrollerRef.current;
      if (sc) setSize({ w: sc.clientWidth, h: sc.clientHeight });
      schedule();
    });
    ro.observe(root);
    // The canvas reads the theme tokens when it paints. A theme switch
    // (data-theme, the system scheme under `auto`, a --wolf-* override on
    // the host) re-renders nothing here, but it changes the probe's
    // token-driven colours, which run a 1 ms transition: repaint then.
    const probe = probeRef.current;
    probe?.addEventListener("transitionrun", schedule);
    store.registerFocus(() => rootRef.current?.focus({ preventScroll: true }));
    return () => {
      ro.disconnect();
      probe?.removeEventListener("transitionrun", schedule);
      store.registerFocus(null);
      if (frame.current) cancelAnimationFrame(frame.current);
      clearTimeout(mirrorTimer.current);
    };
  }, [store]);

  // Scroll the active cell into view when asked.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const s = store.sheet;
    if (!scroller || !s) return;
    const geo = buildGeo(
      store,
      s,
      store.layout(s),
      scroller.clientWidth,
      scroller.clientHeight,
      scroller.scrollLeft,
      scroller.scrollTop,
    );
    const { row, col } = store.selection.active;
    scrollIntoView(scroller, geo, row, col);
    schedule();
  }, [store.revealSeq, store.activeSheetId]);

  // Fresh sheet: start at the top left.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    }
  }, [store.activeSheetId, store.state?.doc]);

  // `host.reveal({ address })` (Inspector, review panel): the store has
  // switched to the sheet; scroll the cell into view, selection untouched.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const s = store.sheet;
    const target = store.hostReveal;
    if (!scroller || !s || !target || target.sheetId !== s.sheetId) return;
    const geo = buildGeo(
      store,
      s,
      store.layout(s),
      scroller.clientWidth,
      scroller.clientHeight,
      scroller.scrollLeft,
      scroller.scrollTop,
    );
    scrollIntoView(scroller, geo, target.row, target.col);
    schedule();
  }, [store.hostRevealSeq]);

  useEffect(() => {
    // The link bar keeps focus while it is open (it closes through the store).
    if (!store.editing && !store.linkDialog) rootRef.current?.focus({ preventScroll: true });
  }, [store.focusSeq]);

  const local = (e: PointerEvent | MouseEvent) => {
    const rect = scrollerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const insideViewport = (x: number, y: number) => {
    const sc = scrollerRef.current!;
    return x >= 0 && y >= 0 && x < sc.clientWidth && y < sc.clientHeight;
  };

  const onPointerDown = (e: PointerEvent) => {
    const geo = geoRef.current;
    if (!geo || e.button !== 0) return;
    const { x, y } = local(e);
    if (!insideViewport(x, y)) return; // scrollbar
    e.preventDefault();
    if (store.editing) store.commitEdit(null);
    rootRef.current?.focus({ preventScroll: true });
    const handleOn = fillSource(store);
    if (handleOn && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const p = fillHandlePos(geo, handleOn);
      if (Math.abs(x - p.x) <= 5 && Math.abs(y - p.y) <= 5) {
        dragRef.current = { kind: "fill", from: handleOn, to: handleOn };
        scrollerRef.current?.setPointerCapture(e.pointerId);
        schedule();
        return;
      }
    }
    const hit = hitTest(geo, x, y);
    const additive = e.metaKey || e.ctrlKey;
    if (hit.resize) {
      const size = hit.resize.axis === "col" ? geo.cols.sizeOf(hit.resize.index) : geo.rows.sizeOf(hit.resize.index);
      dragRef.current = {
        kind: "resize",
        axis: hit.resize.axis,
        index: hit.resize.index,
        start: hit.resize.start,
        origin: hit.resize.axis === "col" ? x : y,
        size,
        current: hit.resize.axis === "col" ? x : y,
      };
    } else if (hit.kind === "corner") {
      store.selectAll();
      return;
    } else if (hit.kind === "col") {
      const rect = { r1: 1, c1: hit.col, r2: MAX_ROWS, c2: hit.col };
      if (e.shiftKey) {
        const s = store.selection;
        store.selectRect(
          { r1: 1, c1: Math.min(s.anchor.col, hit.col), r2: MAX_ROWS, c2: Math.max(s.anchor.col, hit.col) },
          s.anchor,
        );
      } else store.selectRect(rect, { row: 1, col: hit.col }, additive ? "add" : "replace");
      dragRef.current = { kind: "cols" };
    } else if (hit.kind === "row") {
      if (e.shiftKey) {
        const s = store.selection;
        store.selectRect(
          { r1: Math.min(s.anchor.row, hit.row), c1: 1, r2: Math.max(s.anchor.row, hit.row), c2: MAX_COLS },
          s.anchor,
        );
      } else
        store.selectRect(
          { r1: hit.row, c1: 1, r2: hit.row, c2: MAX_COLS },
          { row: hit.row, col: 1 },
          additive ? "add" : "replace",
        );
      dragRef.current = { kind: "rows" };
    } else {
      // Cmd/Ctrl+click on a linked cell follows the link.
      const link = additive && !e.shiftKey && store.sheet ? store.linkAt(store.sheet, hit.row, hit.col) : null;
      if (link) {
        store.selectCell(hit.row, hit.col, "replace", false);
        store.followLink(link);
        return;
      }
      if (e.shiftKey) store.extendTo(hit.row, hit.col, false);
      else store.selectCell(hit.row, hit.col, additive ? "add" : "replace", false);
      dragRef.current = { kind: "cells", additive };
    }
    scrollerRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const geo = geoRef.current;
    if (!geo) return;
    const { x, y } = local(e);
    const drag = dragRef.current;
    if (!drag) {
      const hit = insideViewport(x, y) ? hitTest(geo, x, y) : null;
      const run = hit && hit.kind !== "cell" ? hiddenRunAt(geo, x, y) : null;
      const linked =
        hit?.kind === "cell" && (e.metaKey || e.ctrlKey) && store.sheet
          ? !!store.linkAt(store.sheet, hit.row, hit.col)
          : false;
      const handleOn = hit?.kind === "cell" ? fillSource(store) : null;
      const p = handleOn ? fillHandlePos(geo, handleOn) : null;
      const onHandle = !!p && Math.abs(x - p.x) <= 5 && Math.abs(y - p.y) <= 5;
      const next = onHandle
        ? "crosshair"
        : linked
          ? "pointer"
          : hit?.resize
            ? hit.resize.axis === "col"
              ? "col-resize"
              : "row-resize"
            : hit && hit.kind !== "cell"
              ? "default"
              : "cell";
      if (next !== cursor) setCursor(next);
      const tip = run
        ? `Double-click to unhide ${run.axis === "row" ? (run.lo === run.hi ? `row ${run.lo}` : `rows ${run.lo}-${run.hi}`) : run.lo === run.hi ? `column ${numToCol(run.lo)}` : `columns ${numToCol(run.lo)}-${numToCol(run.hi)}`}`
        : "";
      if (tip !== hint) setHint(tip);
      return;
    }
    if (drag.kind === "resize") {
      drag.current = Math.max(drag.start, drag.axis === "col" ? x : y);
      schedule();
      return;
    }
    // Auto-scroll while dragging past the edges.
    const sc = scrollerRef.current!;
    if (x > sc.clientWidth - 8) sc.scrollLeft += 20;
    else if (x < geo.hw + geo.fw && geo.sl > 0 && drag.kind !== "rows") sc.scrollLeft -= 20;
    if (y > sc.clientHeight - 8) sc.scrollTop += 20;
    else if (y < geo.hh + geo.fh && geo.st > 0 && drag.kind !== "cols") sc.scrollTop -= 20;
    const hit = hitTest(
      geo,
      Math.max(geo.hw, Math.min(x, sc.clientWidth - 1)),
      Math.max(geo.hh, Math.min(y, sc.clientHeight - 1)),
    );
    const s = store.selection;
    if (drag.kind === "fill") {
      const to = fillTarget(drag.from, hit.row, hit.col);
      if (to.r2 !== drag.to.r2 || to.c2 !== drag.to.c2) {
        drag.to = to;
        schedule();
      }
    } else if (drag.kind === "cells") store.extendTo(hit.row, hit.col, false);
    else if (drag.kind === "cols") {
      const last = s.ranges[s.ranges.length - 1]!;
      const rect = { r1: 1, c1: Math.min(s.anchor.col, hit.col), r2: MAX_ROWS, c2: Math.max(s.anchor.col, hit.col) };
      if (rect.c1 !== last.c1 || rect.c2 !== last.c2)
        store.setSelection({ ranges: [...s.ranges.slice(0, -1), rect], active: s.active, anchor: s.anchor }, false);
    } else {
      const last = s.ranges[s.ranges.length - 1]!;
      const rect = { r1: Math.min(s.anchor.row, hit.row), c1: 1, r2: Math.max(s.anchor.row, hit.row), c2: MAX_COLS };
      if (rect.r1 !== last.r1 || rect.r2 !== last.r2)
        store.setSelection({ ranges: [...s.ranges.slice(0, -1), rect], active: s.active, anchor: s.anchor }, false);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    scrollerRef.current?.releasePointerCapture?.(e.pointerId);
    if (drag?.kind === "fill") {
      schedule();
      if (drag.to.r2 !== drag.from.r2 || drag.to.c2 !== drag.from.c2) store.fillTo(drag.to);
      return;
    }
    if (drag?.kind !== "resize") return;
    // Screen px at this zoom -> px at 100 %.
    const px = Math.max(0, Math.round((drag.current - drag.start) / (geoRef.current?.z ?? 1)));
    schedule();
    if (Math.abs(drag.current - drag.origin) < 2) return;
    // Resize every selected full column/row when the dragged one is selected.
    const sel = store.selection;
    const range = sel.ranges.find((r) =>
      drag.axis === "col"
        ? r.r1 === 1 && r.r2 === MAX_ROWS && drag.index >= r.c1 && drag.index <= r.c2
        : r.c1 === 1 && r.c2 === MAX_COLS && drag.index >= r.r1 && drag.index <= r.r2,
    );
    if (drag.axis === "col") store.resizeCols(range ? range.c1 : drag.index, range ? range.c2 : drag.index, px);
    else store.resizeRows(range ? range.r1 : drag.index, range ? range.r2 : drag.index, px);
  };

  /** The hidden rows/columns behind the double line under a header
   * boundary at (x, y), or null. */
  const hiddenRunAt = (geo: Geo, x: number, y: number): { axis: "row" | "col"; lo: number; hi: number } | null => {
    const s = store.sheet;
    if (!s) return null;
    const hit = hitTest(geo, x, y);
    if (hit.kind !== "col" && hit.kind !== "row") return null;
    const axis = hit.kind;
    const i = axis === "col" ? hit.col : hit.row;
    const a = axis === "col" ? geo.cols : geo.rows;
    const start =
      (axis === "col" ? geo.hw : geo.hh) +
      a.start(i) -
      (i <= (axis === "col" ? geo.fc : geo.fr) ? 0 : axis === "col" ? geo.sl : geo.st);
    const end = start + a.sizeOf(i);
    const p = axis === "col" ? x : y;
    const run =
      Math.abs(p - start) <= 4
        ? store.hiddenRunBefore(s, axis, i)
        : Math.abs(p - end) <= 4
          ? store.hiddenRunAfter(s, axis, i)
          : null;
    return run ? { axis, lo: run[0], hi: run[1] } : null;
  };

  const onDoubleClick = (e: MouseEvent) => {
    const geo = geoRef.current;
    const s = store.sheet;
    if (!geo || !s) return;
    const { x, y } = local(e);
    if (!insideViewport(x, y)) return;
    const run = hiddenRunAt(geo, x, y);
    if (run) {
      store.unhide(run.axis, store.hiddenIn(s, run.axis, run.lo, run.hi));
      return;
    }
    const hit = hitTest(geo, x, y);
    if (hit.kind === "cell") {
      store.selectCell(hit.row, hit.col, "replace", false);
      store.beginEdit(null);
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    const geo = geoRef.current;
    if (!geo) return;
    const { x, y } = local(e);
    if (!insideViewport(x, y)) return;
    e.preventDefault();
    if (store.editing) store.commitEdit(null);
    rootRef.current?.focus({ preventScroll: true });
    const hit = hitTest(geo, x, y);
    const sel = store.selection;
    if (hit.kind === "col") {
      if (!sel.ranges.some((r) => r.r1 === 1 && r.r2 === MAX_ROWS && hit.col >= r.c1 && hit.col <= r.c2))
        store.selectRect({ r1: 1, c1: hit.col, r2: MAX_ROWS, c2: hit.col }, { row: 1, col: hit.col });
    } else if (hit.kind === "row") {
      if (!sel.ranges.some((r) => r.c1 === 1 && r.c2 === MAX_COLS && hit.row >= r.r1 && hit.row <= r.r2))
        store.selectRect({ r1: hit.row, c1: 1, r2: hit.row, c2: MAX_COLS }, { row: hit.row, col: 1 });
    } else if (hit.kind === "cell") {
      if (!sel.ranges.some((r) => hit.row >= r.r1 && hit.row <= r.r2 && hit.col >= r.c1 && hit.col <= r.c2))
        store.selectCell(hit.row, hit.col, "replace", false);
    } else return;
    setMenu({ kind: hit.kind, x: e.clientX, y: e.clientY });
  };

  /** Shift+F10 / the context-menu key: the cell menu at the active cell. */
  const openMenuAtActive = () => {
    const geo = geoRef.current;
    const sc = scrollerRef.current;
    if (!geo || !sc) return;
    const { row, col } = store.selection.active;
    const r = sc.getBoundingClientRect();
    const left = r.left + geo.hw + geo.cols.start(col) - (col <= geo.fc ? 0 : geo.sl);
    const top = r.top + geo.hh + geo.rows.start(row) - (row <= geo.fr ? 0 : geo.st);
    setMenu({
      kind: "cell",
      x: Math.max(r.left, Math.min(r.right - 20, left + 8)),
      y: Math.max(r.top, Math.min(r.bottom - 20, top + geo.rows.sizeOf(row))),
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== rootRef.current) return;
    const ed = store.editing;
    if (ed?.source === "cell") {
      // Keys typed before the editor textarea has taken focus.
      const k = e.key;
      if (!dispatch(EDIT_KEYS, { store, event: e })) {
        if (k.length === 1 && !e.metaKey && !e.ctrlKey) store.setEditText(ed.text + k);
        else if (k === "Backspace") store.setEditText(ed.text.slice(0, -1));
        else return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    store.handleKey(e, openMenuAtActive);
  };

  // Editor overlay geometry.
  const editing = store.editing && sheet && store.editing.sheetId === sheet.sheetId ? store.editing : null;
  let editorBox: EditorBox | null = null;
  const geo = geoRef.current;
  if (editing && geo && scrollerRef.current) {
    const m = store.mergeAt(editing.row, editing.col);
    const r1 = m?.r1 ?? editing.row;
    const c1 = m?.c1 ?? editing.col;
    const r2 = m?.r2 ?? editing.row;
    const c2 = m?.c2 ?? editing.col;
    const sl = scrollerRef.current.scrollLeft;
    const st = scrollerRef.current.scrollTop;
    const left = geo.hw + geo.cols.start(c1) - (c1 <= geo.fc ? 0 : sl);
    const top = geo.hh + geo.rows.start(r1) - (r1 <= geo.fr ? 0 : st);
    const style = store.styleOf(sheet!, r1, c1);
    editorBox = {
      left,
      top,
      width: Math.max(geo.cols.start(c2 + 1) - geo.cols.start(c1), 40 * geo.z),
      height: Math.max(geo.rows.start(r2 + 1) - geo.rows.start(r1), geo.rows.sizeOf(r1) || 20 * geo.z),
      font: editorFont(store, style, geo.z),
      z: geo.z,
    };
  }

  if (!sheet || !layout)
    return (
      <div class="we-sheets-empty" data-testid="sheets-grid-empty">
        No sheet
      </div>
    );
  const sel = store.selection;

  return (
    <div
      ref={rootRef}
      class="we-sheets-grid"
      tabIndex={0}
      role="grid"
      aria-label={`Sheet ${sheet.name}`}
      aria-rowcount={MAX_ROWS}
      aria-colcount={MAX_COLS}
      data-testid="sheets-grid"
      data-sheet={sheet.name}
      data-active={toA1(sel.active.row, sel.active.col)}
      data-selection={sel.ranges.map((r) => `${toA1(r.r1, r.c1)}:${toA1(r.r2, r.c2)}`).join(",")}
      data-frozen={layout.frozen ? toA1(layout.frozen.rows + 1, layout.frozen.cols + 1) : ""}
      onKeyDown={onKeyDown}
      onCopy={(e) => !store.editing && store.onCopy(e, false)}
      onCut={(e) => !store.editing && store.onCopy(e, true)}
      onPaste={(e) => !store.editing && store.onPaste(e)}
    >
      <div
        ref={scrollerRef}
        class="we-sheets-scroller"
        style={{ cursor: cursor === "cell" ? "cell" : cursor }}
        title={hint || undefined}
        onScroll={schedule}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDblClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div class="we-sheets-spacer" />
      </div>
      <canvas
        ref={canvasRef}
        class="we-sheets-canvas"
        data-testid="sheets-canvas"
        data-width={size.w}
        aria-hidden="true"
      />
      <span ref={probeRef} class="we-sheets-theme-probe" aria-hidden="true" />
      {editing && editorBox && <CellEditor store={store} box={editorBox} />}
      <div class="we-sheets-mirror" data-testid="sheets-cells" aria-live="off">
        {mirror.map((c) => (
          <span
            key={c.a1}
            data-testid={`sheets-cell-${c.a1}`}
            data-formula={c.formula}
            data-error={c.error ? "true" : undefined}
            data-link={c.link}
            data-loading={c.loading ? "true" : undefined}
            role="gridcell"
          >
            {c.text}
          </span>
        ))}
      </div>
      {menu && <GridContextMenu store={store} menu={menu} close={() => setMenu(null)} />}
    </div>
  );
}

function CellEditor({ store, box }: { store: SheetsStore; box: EditorBox }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const editing = store.editing!;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || editing.source !== "cell") return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing.source, editing.row, editing.col]);
  const lines = editing.text.split("\n").length;
  return (
    <textarea
      ref={ref}
      class="we-sheets-editor"
      data-testid="sheets-editor"
      aria-label={`Edit ${toA1(editing.row, editing.col)}`}
      spellcheck={false}
      style={{
        left: `${box.left}px`,
        top: `${box.top}px`,
        minWidth: `${box.width}px`,
        height: `${Math.max(box.height, (lines * 17 + 4) * box.z)}px`,
        width: `${Math.max(box.width, Math.min(600 * box.z, (editing.text.length * 7.5 + 16) * box.z))}px`,
        font: box.font,
        lineHeight: `${17 * box.z}px`,
      }}
      value={editing.text}
      onFocus={() =>
        store.editing && store.editing.source !== "cell" && (store.editing = { ...store.editing, source: "cell" })
      }
      onInput={(e) => store.setEditText((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (dispatch(EDIT_KEYS, { store, event: e })) e.preventDefault();
      }}
    />
  );
}

/** Right-click menu of the grid: cells (clear, links) or row / column
 * headers (insert, delete, hide, unhide). Acts on the current selection,
 * which the right-click has already adjusted. */
function GridContextMenu({ store, menu, close }: { store: SheetsStore; menu: GridMenu; close: () => void }) {
  const sheet = store.sheet;
  if (!sheet) return null;
  let items: (MenuItem | "separator")[];
  if (menu.kind === "cell") {
    const { row, col } = store.selection.active;
    const link = store.linkAt(sheet, row, col);
    items = [
      { control: "clear", testid: "sheets-menu-clear", label: "Clear contents", act: () => store.clearSelection() },
      "separator",
      {
        control: "hyperlink",
        testid: "sheets-menu-insert-link",
        label: link && link.source !== "formula" ? "Edit link..." : "Insert link...",
        act: () => store.openLinkDialog(),
      },
      {
        testid: "sheets-menu-open-link",
        label: "Open link",
        enabled: !!link,
        act: () => link && store.followLink(link),
      },
      {
        control: "hyperlink",
        testid: "sheets-menu-remove-link",
        label: "Remove link",
        enabled: !!link && link.source !== "formula",
        act: () => store.removeLink(),
      },
    ];
  } else {
    const axis = menu.kind;
    const [lo, hi] = store.axisSpan(axis);
    const n = hi - lo + 1;
    const noun = axis === "row" ? (n === 1 ? "row" : `${n} rows`) : n === 1 ? "column" : `${n} columns`;
    const unhide = store.unhideCandidates(axis);
    const plural = axis === "row" ? "rows" : "cols";
    items =
      axis === "row"
        ? [
            {
              control: "insert-rows-above",
              testid: "sheets-menu-insert-rows-above",
              label: "Insert row above",
              act: () => store.insertRows("above"),
            },
            {
              control: "insert-rows-below",
              testid: "sheets-menu-insert-rows-below",
              label: "Insert row below",
              act: () => store.insertRows("below"),
            },
            {
              control: "delete-rows",
              testid: "sheets-menu-delete-rows",
              label: `Delete ${noun}`,
              act: () => store.deleteRows(),
            },
          ]
        : [
            {
              control: "insert-cols-left",
              testid: "sheets-menu-insert-cols-left",
              label: "Insert column left",
              act: () => store.insertCols("left"),
            },
            {
              control: "insert-cols-right",
              testid: "sheets-menu-insert-cols-right",
              label: "Insert column right",
              act: () => store.insertCols("right"),
            },
            {
              control: "delete-cols",
              testid: "sheets-menu-delete-cols",
              label: `Delete ${noun}`,
              act: () => store.deleteCols(),
            },
          ];
    items.push(
      "separator",
      {
        control: `hide-${axis}`,
        testid: `sheets-menu-hide-${plural}`,
        label: `Hide ${noun}`,
        act: () => store.hideSelection(axis),
      },
      {
        control: `unhide-${axis}`,
        testid: `sheets-menu-unhide-${plural}`,
        label:
          unhide.length > 1
            ? `Unhide ${unhide.length} ${axis === "row" ? "rows" : "columns"}`
            : `Unhide ${axis === "row" ? "row" : "column"}`,
        enabled: unhide.length > 0,
        act: () => store.unhide(axis, unhide),
      },
    );
  }
  // Each item acts, then focus goes back to the grid.
  const wrapped = items.map((it) => (it === "separator" ? it : { ...it, act: () => (it.act(), store.focusGrid()) }));
  return <Menu store={store} x={menu.x} y={menu.y} testid={`sheets-menu-${menu.kind}`} items={wrapped} close={close} />;
}
