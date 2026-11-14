/**
 * Caret geometry over the reactor engine's `text_layout` of one paragraph,
 * plus grapheme and word stops of its source text. Pure functions, page
 * points throughout.
 *
 * Offsets are UTF-16 code units into the paragraph's source text (the view
 * node's `text`), as `text_layout` reports them (docs/reactor-abi.md).
 * Synthetic clusters (list labels, field results, tab leaders) have no
 * source and are skipped: the caret never stops inside them. A layout whose
 * lines are interpolated (`approximate`) or rotated is reported unusable and
 * the paragraph is edited in the text-box editor instead.
 */
import type { TextLayout } from "@wolfsdk/protocol";

/** One painted, sourced cluster in page space (`x0 < x1`). */
export type Glyph = { x0: number; x1: number; start: number; end: number; rtl: boolean };

/** One visual line of the paragraph on one page. */
export type Row = {
  page: number;
  top: number;
  bottom: number;
  /** Smallest / largest source offset the row's clusters cover. */
  start: number;
  end: number;
  /** Sorted by `x0`. */
  glyphs: Glyph[];
};

export type CaretLayout = {
  /** Source UTF-16 length the engine laid out. */
  length: number;
  /** In reading order: page, then top. Empty for a paragraph without text. */
  rows: Row[];
};

/** A zero-width caret: `row` indexes `CaretLayout.rows`. */
export type CaretPos = { row: number; page: number; x: number; top: number; bottom: number };

export type PageRect = { page: number; x: number; y: number; w: number; h: number };

/** A caret stop chosen from a point: `upstream` keeps the caret on the end of its row. */
export type Stop = { offset: number; upstream: boolean };

/** Build the caret layout, or a reason the layout cannot drive a caret. */
export function buildCaretLayout(raw: TextLayout): CaretLayout | { unusable: string } {
  const rows: Row[] = [];
  for (const line of raw.lines) {
    if (line.approximate) return { unusable: "the engine interpolated this paragraph's character positions" };
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = line.transform;
    if (b !== 0 || c !== 0 || a <= 0 || d <= 0) return { unusable: "this paragraph is drawn rotated or mirrored" };
    const glyphs: Glyph[] = [];
    for (const cl of line.clusters) {
      if (cl.synthetic || cl.source_end <= cl.source_start) continue;
      const xa = a * cl.x + e;
      const xb = a * (cl.x + cl.advance) + e;
      glyphs.push({
        x0: Math.min(xa, xb),
        x1: Math.max(xa, xb),
        start: cl.source_start,
        end: cl.source_end,
        rtl: cl.rtl,
      });
    }
    if (glyphs.length === 0) continue;
    const top = d * (line.baseline - line.ascent) + f;
    const bottom = d * (line.baseline + line.descent) + f;
    // Lines of one visual row (runs split by the engine) share a page and overlap vertically.
    const mid = (top + bottom) / 2;
    const row = rows.find((r) => r.page === line.page && mid > r.top && mid < r.bottom);
    if (row) {
      row.glyphs.push(...glyphs);
      row.top = Math.min(row.top, top);
      row.bottom = Math.max(row.bottom, bottom);
    } else rows.push({ page: line.page, top, bottom, start: 0, end: 0, glyphs });
  }
  for (const row of rows) {
    row.glyphs.sort((p, q) => p.x0 - q.x0);
    row.start = Math.min(...row.glyphs.map((g) => g.start));
    row.end = Math.max(...row.glyphs.map((g) => g.end));
  }
  rows.sort((p, q) => p.page - q.page || p.top - q.top);
  return { length: raw.length, rows };
}

const startEdge = (g: Glyph): number => (g.rtl ? g.x1 : g.x0);
const endEdge = (g: Glyph): number => (g.rtl ? g.x0 : g.x1);

function inside(g: Glyph, offset: number): number {
  const t = (offset - g.start) / (g.end - g.start);
  return g.rtl ? g.x1 - t * (g.x1 - g.x0) : g.x0 + t * (g.x1 - g.x0);
}

/**
 * Caret of a source offset. Where a row ends and the next begins at the
 * same offset, the next row wins unless `upstream` (End, a click past the
 * end of a row). An offset no sourced cluster borders (inside a run of
 * tabs) sits after the nearest cluster before it.
 */
export function caretAt(layout: CaretLayout, offset: number, upstream = false): CaretPos | null {
  type Pick = { row: number; x: number; score: number };
  let best: Pick | null = null;
  let before: (Pick & { end: number }) | null = null;
  let after: (Pick & { start: number }) | null = null;
  for (let i = 0; i < layout.rows.length; i++) {
    for (const g of layout.rows[i]!.glyphs) {
      const candidates: Pick[] = [];
      if (g.start < offset && offset < g.end) candidates.push({ row: i, x: inside(g, offset), score: 0 });
      if (g.start === offset) candidates.push({ row: i, x: startEdge(g), score: upstream ? 2 : 1 });
      if (g.end === offset) candidates.push({ row: i, x: endEdge(g), score: upstream ? 1 : 2 });
      for (const c of candidates) if (!best || c.score < best.score) best = c;
      if (g.end <= offset && (!before || g.end > before.end)) before = { row: i, x: endEdge(g), score: 3, end: g.end };
      if (g.start >= offset && (!after || g.start < after.start))
        after = { row: i, x: startEdge(g), score: 4, start: g.start };
    }
  }
  const pick: Pick | null = best ?? before ?? after;
  if (!pick) return null;
  const row = layout.rows[pick.row]!;
  return { row: pick.row, page: row.page, x: pick.x, top: row.top, bottom: row.bottom };
}

/** Selection rectangles of source range [lo, hi), one per row. */
export function rangeRects(layout: CaretLayout, lo: number, hi: number): PageRect[] {
  const out: PageRect[] = [];
  if (hi <= lo) return out;
  for (const row of layout.rows) {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const g of row.glyphs) {
      if (g.end <= lo || g.start >= hi) continue;
      const xa = lo > g.start ? inside(g, lo) : startEdge(g);
      const xb = hi < g.end ? inside(g, hi) : endEdge(g);
      x0 = Math.min(x0, xa, xb);
      x1 = Math.max(x1, xa, xb);
    }
    if (x0 <= x1) out.push({ page: row.page, x: x0, y: row.top, w: Math.max(x1 - x0, 1), h: row.bottom - row.top });
  }
  return out;
}

/** Nearest caret stop in one row to page x; `stops` are the text's grapheme boundaries. */
export function stopInRow(row: Row, x: number, stops: number[]): Stop {
  let best: Stop = { offset: row.start, upstream: false };
  let d = Infinity;
  const take = (cx: number, offset: number, upstream: boolean) => {
    const di = Math.abs(cx - x);
    if (di < d) {
      d = di;
      best = { offset, upstream };
    }
  };
  for (const g of row.glyphs) {
    take(startEdge(g), g.start, false);
    // A ligature or multi-character cluster: a stop per grapheme inside it.
    for (const s of stops) if (s > g.start && s < g.end) take(inside(g, s), s, false);
    take(endEdge(g), g.end, g.end === row.end);
  }
  return best;
}

/**
 * Caret stop for a page point. A point before the paragraph's first row
 * (earlier page, or above it) is offset 0; after its last row, the end:
 * a drag that leaves the paragraph stays clamped to it.
 */
export function stopAt(
  layout: CaretLayout,
  page: number,
  x: number,
  y: number,
  stops: number[],
): Stop & { outside: boolean } {
  const rows = layout.rows;
  if (rows.length === 0) return { offset: 0, upstream: false, outside: false };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (page < first.page || (page === first.page && y < first.top)) return { offset: 0, upstream: false, outside: true };
  if (page > last.page || (page === last.page && y > last.bottom))
    return { offset: layout.length, upstream: true, outside: true };
  const onPage = rows.filter((r) => r.page === page);
  if (onPage.length === 0) {
    // A page between two parts of the paragraph: the end of the part before it.
    const prev = rows.filter((r) => r.page < page).pop() ?? first;
    return { offset: prev.end, upstream: true, outside: false };
  }
  let row = onPage[0]!;
  let dy = Infinity;
  for (const r of onPage) {
    const di = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (di < dy) {
      dy = di;
      row = r;
    }
  }
  return { ...stopInRow(row, x, stops), outside: false };
}

// ---------------------------------------------------------------------------
// Text stops
// ---------------------------------------------------------------------------

// Firefox before 125 has no `Intl.Segmenter`: code points and a regex word split stand in.
const hasSegmenter = typeof Intl.Segmenter === "function";
const graphemeSeg = hasSegmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const wordSeg = hasSegmenter ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

let stopCache: { text: string; stops: number[] } | null = null;

/** Grapheme boundaries of `text`, 0 and `text.length` included. */
export function graphemeStops(text: string): number[] {
  if (stopCache?.text === text) return stopCache.stops;
  const stops: number[] = [];
  if (graphemeSeg) for (const s of graphemeSeg.segment(text)) stops.push(s.index);
  else for (let i = 0; i < text.length; i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1) stops.push(i);
  stops.push(text.length);
  stopCache = { text, stops };
  return stops;
}

export function nextGrapheme(text: string, offset: number): number {
  for (const s of graphemeStops(text)) if (s > offset) return s;
  return text.length;
}

export function prevGrapheme(text: string, offset: number): number {
  const stops = graphemeStops(text);
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i]! < offset) return stops[i]!;
  return 0;
}

type Word = { start: number; end: number; word: boolean };

function words(text: string): Word[] {
  if (wordSeg)
    return [...wordSeg.segment(text)].map((s) => ({
      start: s.index,
      end: s.index + s.segment.length,
      word: s.isWordLike === true,
    }));
  const out: Word[] = [];
  const re = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
  for (let m = re.exec(text); m; m = re.exec(text))
    out.push({ start: m.index, end: m.index + m[0].length, word: /[\p{L}\p{N}_]/u.test(m[0]) });
  return out;
}

/** Start of the word before `offset` (Alt/Ctrl+Left, Alt/Ctrl+Backspace). */
export function wordLeft(text: string, offset: number): number {
  let at = 0;
  for (const w of words(text)) {
    if (w.start >= offset) break;
    if (w.word) at = w.start;
  }
  return at;
}

/** End of the word after `offset` (Alt/Ctrl+Right, Alt/Ctrl+Delete). */
export function wordRight(text: string, offset: number): number {
  for (const w of words(text)) if (w.word && w.end > offset) return w.end;
  return text.length;
}

/** The word (or run of spaces or punctuation) at `offset`, for a double-click. */
export function wordAt(text: string, offset: number): [number, number] {
  const all = words(text);
  const hit = all.find((w) => w.start <= offset && offset < w.end) ?? all[all.length - 1];
  return hit ? [hit.start, hit.end] : [0, 0];
}
