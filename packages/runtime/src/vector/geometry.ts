/**
 * Text geometry over a display list, for carets, hit testing, selection and copy. Pure
 * functions; all results in page points.
 *
 * Offsets are the reactor's convention: UTF-16 code units of an object's **source** text
 * (`hit_test`, `caret_rects`, `text_layout`). They are exact when the object's `text_layout`
 * is passed in `layouts` (fetch it with `requests.textLayout`); without it the helpers fall
 * back to the run's `char_x` boundaries counted from `object_offset`, which index rendered
 * characters and drift from source offsets where list labels, tabs or fields differ.
 */
import { invert, transformRect } from "./abi.ts";
import type { Cluster, DisplayList, Rect, TextLayout, TextLine, TextRun } from "./model.ts";

/** `text_layout` results by object id (any subset of the page's objects). */
export type Layouts = ReadonlyMap<string, TextLayout>;

export type RunText = {
  run: TextRun;
  objectId: string | null;
  /** Object offsets covered by the run: [start, end). */
  start: number;
  end: number;
  text: string;
  /** One page-space box per rendered character (Unicode scalar) of the run, in text order. */
  boxes: Rect[];
};

export type LocalHit = {
  objectId: string | null;
  /** Caret offset in the object's source text (UTF-16), see the module comment. */
  offset: number;
  run: TextRun;
  inside: boolean;
  /** Zero-width caret in page points. */
  caret: Rect;
  /** True when the offset and caret came from the engine's `text_layout` clusters. */
  exact: boolean;
};

export type RangeEnd = { objectId: string; offset: number };

const runTextCache = new WeakMap<TextRun, RunText>();
const orderCache = new WeakMap<DisplayList, RunText[]>();

/** Runs of one object in offset order. */
export function runsForNode(dl: DisplayList, objectId: string): TextRun[] {
  return dl.runs.filter((r) => r.objectId === objectId).sort((a, b) => a.objectOffset - b.objectOffset);
}

/**
 * Every run in reading order (objects in document order, by offset inside each object;
 * untagged runs last, top to bottom) with per-character boxes.
 */
export function textRuns(dl: DisplayList): RunText[] {
  let out = orderCache.get(dl);
  if (out) return out;
  const rank = new Map<string, number>();
  for (const r of dl.regions) if (!rank.has(r.objectId)) rank.set(r.objectId, rank.size);
  for (const r of dl.runs) if (r.objectId && !rank.has(r.objectId)) rank.set(r.objectId, rank.size);
  out = dl.runs.map(runText);
  out.sort((a, b) => {
    const ra = a.objectId ? rank.get(a.objectId)! : Infinity;
    const rb = b.objectId ? rank.get(b.objectId)! : Infinity;
    if (ra !== rb) return ra - rb;
    if (ra !== Infinity) return a.start - b.start;
    return a.run.bbox.y - b.run.bbox.y || a.run.bbox.x - b.run.bbox.x;
  });
  orderCache.set(dl, out);
  return out;
}

function runText(run: TextRun): RunText {
  let rt = runTextCache.get(run);
  if (rt) return rt;
  const chars = Array.from(run.text);
  const n = Math.min(chars.length, run.charX.length - 1);
  const [y0, y1] = verticalExtent(run);
  const boxes: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const xa = run.charX[i];
    const xb = run.charX[i + 1];
    boxes.push(transformRect(run.ctm, { x: Math.min(xa, xb), y: y0, w: Math.abs(xb - xa), h: y1 - y0 }));
  }
  rt = {
    run,
    objectId: run.objectId,
    start: run.objectOffset,
    end: run.objectOffset + n,
    text: chars.slice(0, n).join(""),
    boxes,
  };
  runTextCache.set(run, rt);
  return rt;
}

/** The run's top and bottom in run space (its page bbox mapped back through the CTM). */
function verticalExtent(run: TextRun): [number, number] {
  const inv = invert(run.ctm);
  if (!inv) return [run.y - run.size * 0.8, run.y + run.size * 0.2];
  const r = transformRect(inv, run.bbox);
  return [r.y, r.y + r.h];
}

// ---------------------------------------------------------------------------
// text_layout clusters
// ---------------------------------------------------------------------------

/** Caret x (run space) at the start or end of a cluster, honouring direction. */
function edge(c: Cluster, end: boolean): number {
  return end !== c.rtl ? c.x + c.advance : c.x;
}

function lineCaret(line: TextLine, x: number): Rect {
  return transformRect(line.ctm, { x, y: line.baseline - line.ascent, w: 0, h: line.ascent + line.descent });
}

/** Caret x of a source offset inside one line, or null when the line does not hold it. */
function xInLine(line: TextLine, offset: number): number | null {
  let atEnd: number | null = null;
  for (const c of line.clusters) {
    if (c.synthetic) continue;
    if (offset === c.sourceStart) return edge(c, false);
    if (offset > c.sourceStart && offset < c.sourceEnd) {
      // Inside a multi-unit cluster (ligature, surrogate pair): interpolate.
      const t = (offset - c.sourceStart) / (c.sourceEnd - c.sourceStart);
      return c.rtl ? c.x + c.advance * (1 - t) : c.x + c.advance * t;
    }
    if (offset === c.sourceEnd) atEnd = edge(c, true);
  }
  return atEnd;
}

/** Zero-width caret of a source offset on `page` from the object's layout. */
export function layoutCaret(layout: TextLayout, page: number, offset: number): Rect | null {
  // A cluster starting at the offset wins over one ending there (the caret after a wrapped
  // line's last character belongs to the next line).
  let fallback: Rect | null = null;
  for (const line of layout.lines) {
    if (line.page !== page) continue;
    const starts = line.clusters.some((c) => !c.synthetic && c.sourceStart === offset);
    const x = xInLine(line, offset);
    if (x === null) continue;
    if (starts) return lineCaret(line, x);
    fallback ??= lineCaret(line, x);
  }
  if (fallback) return fallback;
  // An empty object or an offset only synthetic clusters border: the line start.
  const first = layout.lines.find((l) => l.page === page && l.clusters.length > 0);
  if (!first || offset !== 0) return null;
  return lineCaret(first, edge(first.clusters[0], false));
}

/** Selection rectangles of source range [lo, hi) on `page`, one per (run, line). */
function layoutRects(layout: TextLayout, page: number, lo: number, hi: number): Rect[] {
  const out: Rect[] = [];
  for (const line of layout.lines) {
    if (line.page !== page) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const c of line.clusters) {
      if (c.synthetic || c.sourceEnd <= lo || c.sourceStart >= hi) continue;
      const span = c.sourceEnd - c.sourceStart;
      const ta = span > 0 ? (Math.max(lo, c.sourceStart) - c.sourceStart) / span : 0;
      const tb = span > 0 ? (Math.min(hi, c.sourceEnd) - c.sourceStart) / span : 1;
      const xa = c.rtl ? c.x + c.advance * (1 - ta) : c.x + c.advance * ta;
      const xb = c.rtl ? c.x + c.advance * (1 - tb) : c.x + c.advance * tb;
      x0 = Math.min(x0, xa, xb);
      x1 = Math.max(x1, xa, xb);
    }
    if (x0 <= x1)
      out.push(
        transformRect(line.ctm, { x: x0, y: line.baseline - line.ascent, w: x1 - x0, h: line.ascent + line.descent }),
      );
  }
  return out;
}

/**
 * Clusters of one page of a layout by rendered start (the character after a boundary),
 * synthetic ones included. Per page: a header or footer repeated on several pages continues
 * its rendered offsets across pages, and a boundary never takes the next page's offset.
 */
const byRendered = new WeakMap<TextLayout, Map<number, Map<number, Cluster>>>();
function renderedIndex(layout: TextLayout, page: number): Map<number, Cluster> {
  let pages = byRendered.get(layout);
  if (!pages) byRendered.set(layout, (pages = new Map()));
  let m = pages.get(page);
  if (!m) {
    m = new Map();
    for (const line of layout.lines) {
      if (line.page !== page) continue;
      for (const c of line.clusters) if (!m.has(c.renderedStart)) m.set(c.renderedStart, c);
    }
    pages.set(page, m);
  }
  return m;
}

/**
 * Nearest cluster boundary of one engine run to run-space x. A boundary takes the source
 * offset of the rendered character after it on the same page, synthetic or not (as
 * `hit_test` does): the caret after "Logistics" in "Logistics\t\t2026" sits before "2026",
 * past the unpainted tabs; before a tab leader or the next paragraph's bullet it takes their
 * (empty) source position. With nothing after it on the page, the cluster's source end.
 */
function nearestBoundary(
  layout: TextLayout,
  page: number,
  engineRun: number,
  lx: number,
): { line: TextLine; x: number; offset: number } | null {
  const next = renderedIndex(layout, page);
  let best: { line: TextLine; x: number; offset: number } | null = null;
  let d = Infinity;
  for (const line of layout.lines) {
    if (line.page !== page) continue;
    for (const c of line.clusters) {
      if (c.run !== engineRun) continue;
      // A ligature cluster has a caret stop per rendered character, evenly split (as char_x).
      const n = Math.max(1, c.renderedEnd - c.renderedStart);
      const span = c.sourceEnd - c.sourceStart;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = c.rtl ? c.x + c.advance * (1 - t) : c.x + c.advance * t;
        const di = Math.abs(x - lx);
        if (di < d) {
          d = di;
          const offset =
            k === n
              ? (next.get(c.renderedEnd)?.sourceStart ?? c.sourceEnd)
              : c.sourceStart + Math.round((k * span) / n);
          best = { line, x, offset };
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Nearest caret position to a page point: same line first, then horizontal distance; among
 * runs containing the point the last painted (topmost) wins, as `hit_test` does for
 * overflowing spreadsheet cells.
 */
export function hitTestLocal(dl: DisplayList, xPt: number, yPt: number, layouts?: Layouts): LocalHit | null {
  let best: TextRun | null = null;
  let bestScore = Infinity;
  for (const run of dl.runs) {
    if (run.charX.length < 2) continue;
    const b = run.bbox;
    const dx = xPt < b.x ? b.x - xPt : xPt > b.x + b.w ? xPt - b.x - b.w : 0;
    const dy = yPt < b.y ? b.y - yPt : yPt > b.y + b.h ? yPt - b.y - b.h : 0;
    const score = dy * 1e4 + dx;
    if (score < bestScore || (score === 0 && bestScore === 0)) {
      bestScore = score;
      best = run;
    }
  }
  if (!best) return null;
  const inv = invert(best.ctm);
  const lx = inv ? inv[0] * xPt + inv[2] * yPt + inv[4] : xPt;
  const layout = best.objectId ? layouts?.get(best.objectId) : undefined;
  const hit = layout ? nearestBoundary(layout, dl.page, best.engineRun, lx) : null;
  if (hit) {
    return {
      objectId: best.objectId,
      offset: hit.offset,
      run: best,
      inside: bestScore === 0,
      caret: lineCaret(hit.line, hit.x),
      exact: true,
    };
  }
  const xs = best.charX;
  let idx = 0;
  let d = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const di = Math.abs(xs[i] - lx);
    if (di < d) {
      d = di;
      idx = i;
    }
  }
  // Untagged runs (chart labels, repeated page furniture) belong to no object: offset 0, as `hit_test`.
  const offset = best.objectId ? best.objectOffset + idx : 0;
  return {
    objectId: best.objectId,
    offset,
    run: best,
    inside: bestScore === 0,
    caret: caretRect(best, idx),
    exact: false,
  };
}

function caretRect(run: TextRun, i: number): Rect {
  const [y0, y1] = verticalExtent(run);
  return transformRect(run.ctm, { x: run.charX[i], y: y0, w: 0, h: y1 - y0 });
}

/**
 * Page rectangles covering offsets [start, end) of an object on this page, merged per line.
 * When `start === end`, one zero-width caret.
 */
export function selectionRects(
  dl: DisplayList,
  objectId: string,
  start: number,
  end: number,
  layouts?: Layouts,
): Rect[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const layout = layouts?.get(objectId);
  if (layout) {
    if (lo === hi) {
      const c = layoutCaret(layout, dl.page, lo);
      return c ? [c] : [];
    }
    return mergeRects(layoutRects(layout, dl.page, lo, hi));
  }
  const runs = runsForNode(dl, objectId);
  if (lo === hi) {
    for (const r of runs) {
      const n = r.charX.length - 1;
      if (lo >= r.objectOffset && lo <= r.objectOffset + n) return [caretRect(r, lo - r.objectOffset)];
    }
    return [];
  }
  const rects: Rect[] = [];
  for (const r of runs) {
    const n = r.charX.length - 1;
    const a = Math.max(lo, r.objectOffset) - r.objectOffset;
    const b = Math.min(hi, r.objectOffset + n) - r.objectOffset;
    if (a >= b) continue;
    const [y0, y1] = verticalExtent(r);
    const xa = r.charX[a];
    const xb = r.charX[b];
    rects.push(transformRect(r.ctm, { x: Math.min(xa, xb), y: y0, w: Math.abs(xb - xa), h: y1 - y0 }));
  }
  return mergeRects(rects);
}

/** Merge horizontally adjacent rectangles of equal y and height (one per line). */
function mergeRects(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const rect of rects) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.y - rect.y) < 0.5 &&
      Math.abs(prev.h - rect.h) < 0.5 &&
      Math.abs(prev.x + prev.w - rect.x) < 0.5
    ) {
      prev.w = rect.x + rect.w - prev.x;
    } else out.push({ ...rect });
  }
  return out;
}

/** Rendered text of every character whose box centre lies in `rect`, objects separated by newlines. */
export function extractText(dl: DisplayList, rect: Rect): string {
  const parts: string[] = [];
  let last: string | null | undefined;
  for (const rt of textRuns(dl)) {
    const chars = Array.from(rt.text);
    let s = "";
    rt.boxes.forEach((b, i) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) s += chars[i];
    });
    if (!s) continue;
    if (last !== undefined && (rt.objectId === null || rt.objectId !== last)) parts.push("\n");
    parts.push(s);
    last = rt.objectId;
  }
  return parts.join("");
}

/**
 * A flow selection between two caret positions (either order): the covered object ranges in
 * reading order, their rectangles on this page and their source text (objects joined by
 * newlines).
 */
export function rangeBetween(
  dl: DisplayList,
  a: RangeEnd,
  b: RangeEnd,
  layouts?: Layouts,
): { segments: { objectId: string; start: number; end: number }[]; rects: Rect[]; text: string } {
  const order: string[] = [];
  for (const rt of textRuns(dl)) if (rt.objectId && !order.includes(rt.objectId)) order.push(rt.objectId);
  let ia = order.indexOf(a.objectId);
  let ib = order.indexOf(b.objectId);
  if (ia < 0 || ib < 0) return { segments: [], rects: [], text: "" };
  let [from, to] = [a, b];
  if (ia > ib || (ia === ib && a.offset > b.offset)) {
    [from, to] = [b, a];
    [ia, ib] = [ib, ia];
  }
  const segments: { objectId: string; start: number; end: number }[] = [];
  const texts: string[] = [];
  const rects: Rect[] = [];
  for (let i = ia; i <= ib; i++) {
    const id = order[i];
    const full =
      dl.objects[id]?.text ??
      runsForNode(dl, id)
        .map((r) => r.text)
        .join("");
    const length = layouts?.get(id)?.length ?? full.length;
    const start = i === ia ? from.offset : 0;
    const end = i === ib ? to.offset : length;
    segments.push({ objectId: id, start, end });
    texts.push(full.slice(start, end));
    rects.push(...selectionRects(dl, id, start, end, layouts));
  }
  return { segments, rects, text: texts.join("\n") };
}
