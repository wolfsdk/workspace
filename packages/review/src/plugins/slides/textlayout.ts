/**
 * Caret geometry of one edited text (a shape's text body or a table cell)
 * from the reactor's `text_layout` (docs/reactor-abi.md): visual lines with
 * their clusters in offsets of the edited text, caret and selection
 * rectangles in line space plus the line transform (so rotated text gets a
 * rotated caret), hit testing and line navigation, all without a module call.
 *
 * Offsets. A shape's `text_layout` offsets are source UTF-16 offsets into
 * the shape's `text` (paragraphs joined by "\n", line breaks "\u000b"), so
 * they are used as they are. A table is one layout object: its offsets index
 * the concatenation of every cell's painted text, row by row, without the
 * paragraph and line breaks (measured on module `42e72b28`); `cellGeometry`
 * maps them back to the cell's own text after checking that concatenation.
 *
 * Hit testing follows `hit_test` (packages/vector `hitTestLocal`): nearest
 * line, then nearest cluster edge; a trailing edge followed on the same line
 * by unpainted characters (tabs) takes the next painted character's offset.
 * One deliberate difference: at the end of a paragraph or before a line
 * break `hit_test` answers the next line's first offset (the next painted
 * character, past the unpainted "\n"), which would type into the next
 * paragraph; here the caret stays at the end of the clicked line.
 */
import type { TextLayout } from "@wolfsdk/protocol";
import { LINE_BREAK, PARAGRAPH } from "./textedit.ts";

/** `[a b c d e f]`: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];

type Cluster = { x: number; advance: number; start: number; end: number; rtl: boolean; units: number };

export type VisualLine = {
  m: Mat;
  inv: Mat;
  baseline: number;
  ascent: number;
  descent: number;
  /** Non-synthetic clusters in offset order (offsets of the edited text). */
  clusters: Cluster[];
  start: number;
  end: number;
  /** An empty paragraph or line: the engine lays out nothing for it, so it
   * is placed from the neighbouring lines (`x0`, `baseline`). */
  estimated: boolean;
  x0: number;
};

export type TextGeometry = {
  /** The text this layout was computed for. */
  text: string;
  /** Visual lines in offset order. */
  lines: VisualLine[];
};

/** A caret position; `upstream` draws an offset shared by the end of one
 * visual line and the start of the next (a soft wrap) at the line end. */
export type CaretPos = { offset: number; upstream: boolean };

/** A caret in line space: x at `top..bottom`, mapped to the slide by `m`. */
export type CaretBox = { m: Mat; x: number; top: number; bottom: number; line: number; estimated: boolean };

/** A selection rectangle in line space, mapped to the slide by `m`. */
export type LineRect = { m: Mat; x: number; y: number; w: number; h: number };

export type Unusable = { unusable: string };

function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function sameMat(a: Mat, b: Mat): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
}

/** True when the transform rotates or skews (the caret is drawn rotated). */
export function rotated(m: Mat): boolean {
  return Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6;
}

/** Engine clusters -> local clusters; null drops a cluster (outside the scope). */
type ToLocal = (start: number, end: number) => [number, number] | null;

function build(layout: TextLayout, page: number, text: string, toLocal: ToLocal): TextGeometry | Unusable {
  const lines: VisualLine[] = [];
  for (const line of layout.lines) {
    if (line.page !== page) continue;
    const clusters: Cluster[] = [];
    for (const c of line.clusters) {
      if (c.synthetic || c.source_end <= c.source_start) continue;
      const local = toLocal(c.source_start, c.source_end);
      if (!local) continue;
      clusters.push({
        x: c.x,
        advance: c.advance,
        start: local[0],
        end: local[1],
        rtl: c.rtl,
        units: Math.max(1, c.rendered_end - c.rendered_start),
      });
    }
    if (!clusters.length) continue;
    if (line.approximate) return { unusable: "the engine reports this text's layout as approximate" };
    const t = line.transform;
    if (t.length !== 6 || t.some((v) => typeof v !== "number" || !Number.isFinite(v)))
      return { unusable: "the text layout has no line transform" };
    const m = t as Mat;
    const inv = invert(m);
    if (!inv) return { unusable: "the text layout has a degenerate line transform" };
    const same = lines.find((l) => !l.estimated && sameMat(l.m, m) && Math.abs(l.baseline - line.baseline) < 0.5);
    if (same) {
      same.clusters.push(...clusters);
      same.ascent = Math.max(same.ascent, line.ascent);
      same.descent = Math.max(same.descent, line.descent);
    } else {
      lines.push({
        m,
        inv,
        baseline: line.baseline,
        ascent: line.ascent,
        descent: line.descent,
        clusters,
        start: 0,
        end: 0,
        estimated: false,
        x0: 0,
      });
    }
  }
  if (!lines.length) return { unusable: "the engine lays out no text for it" };
  for (const l of lines) {
    l.clusters.sort((a, b) => a.start - b.start);
    l.start = l.clusters[0]!.start;
    l.end = Math.max(...l.clusters.map((c) => c.end));
    l.x0 = Math.min(...l.clusters.map((c) => c.x));
  }
  lines.sort((a, b) => a.start - b.start);
  return { text, lines: withEmptyLines(text, lines) };
}

/** Place a line for every empty paragraph or empty line-break line: the
 * engine reports no line for them. Between two laid-out lines they are
 * spaced evenly; before the first or after the last, one line pitch apart. */
function withEmptyLines(text: string, real: VisualLine[]): VisualLine[] {
  const empties: number[] = [];
  let at = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === PARAGRAPH || text[i] === LINE_BREAK) {
      if (i === at) empties.push(at);
      at = i + 1;
    }
  }
  if (!empties.length) return real;
  const pitchAt = (i: number): number => {
    const a = real[i - 1];
    const b = real[i];
    if (a && b && sameMat(a.m, b.m) && b.baseline > a.baseline) return b.baseline - a.baseline;
    const l = real[i] ?? real[i - 1]!;
    return (l.ascent + l.descent) * 1.2;
  };
  const out: VisualLine[] = [];
  let r = 0;
  let e = 0;
  while (r < real.length || e < empties.length) {
    if (e >= empties.length || (r < real.length && real[r]!.start <= empties[e]!)) {
      out.push(real[r++]!);
      continue;
    }
    // A run of empty lines between real[r - 1] and real[r].
    const run: number[] = [];
    while (e < empties.length && (r >= real.length || empties[e]! < real[r]!.start)) run.push(empties[e++]!);
    const prev = real[r - 1];
    const next = real[r];
    const ref = prev ?? next!;
    run.forEach((offset, i) => {
      let baseline: number;
      if (prev && next && sameMat(prev.m, next.m) && next.baseline > prev.baseline)
        baseline = prev.baseline + ((i + 1) * (next.baseline - prev.baseline)) / (run.length + 1);
      else if (prev) baseline = prev.baseline + (i + 1) * pitchAt(r - 1);
      else baseline = next!.baseline - (run.length - i) * pitchAt(r + 1);
      out.push({ ...ref, clusters: [], baseline, start: offset, end: offset, estimated: true, x0: ref.x0 });
    });
  }
  return out;
}

/** Geometry of a shape's text: layout offsets are the shape text's offsets. */
export function shapeGeometry(layout: TextLayout, page: number, text: string): TextGeometry | Unusable {
  if (layout.length !== text.length)
    return { unusable: `the text layout covers ${layout.length} characters, the shape holds ${text.length}` };
  return build(layout, page, text, (s, e) => [s, e]);
}

/** Painted text of a cell: paragraph and line breaks are not painted. */
export function paintedCellText(text: string): string {
  return text.replaceAll(PARAGRAPH, "").replaceAll(LINE_BREAK, "");
}

/**
 * Geometry of one table cell. `tableText` is the table object's text from
 * `display_list` `objects`; `cells` every cell's text in row order.
 */
export function cellGeometry(
  layout: TextLayout,
  page: number,
  tableText: string,
  cells: string[],
  index: number,
): TextGeometry | Unusable {
  const painted = cells.map(paintedCellText);
  if (painted.join("") !== tableText || layout.length !== tableText.length)
    return { unusable: "the table's laid-out text does not line up with its cells (tabs or fields in a cell)" };
  const text = cells[index]!;
  let base = 0;
  for (let i = 0; i < index; i++) base += painted[i]!.length;
  const kept: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] !== PARAGRAPH && text[i] !== LINE_BREAK) kept.push(i);
  const len = kept.length;
  return build(layout, page, text, (s, e) =>
    s >= base && e <= base + len ? [kept[s - base]!, kept[e - base - 1]! + 1] : null,
  );
}

// ---------------------------------------------------------------------------
// Carets
// ---------------------------------------------------------------------------

function edge(c: Cluster, end: boolean): number {
  return end !== c.rtl ? c.x + c.advance : c.x;
}

function within(c: Cluster, offset: number): number {
  const t = (offset - c.start) / (c.end - c.start);
  return c.rtl ? c.x + c.advance * (1 - t) : c.x + c.advance * t;
}

function box(lines: VisualLine[], i: number, x: number): CaretBox {
  const l = lines[i]!;
  return { m: l.m, x, top: l.baseline - l.ascent, bottom: l.baseline + l.descent, line: i, estimated: l.estimated };
}

/** The caret of a position, or null when the layout has no place for it. */
export function caretBox(g: TextGeometry, pos: CaretPos): CaretBox | null {
  const { offset } = pos;
  let starts: CaretBox | null = null;
  let ends: CaretBox | null = null;
  let gap: CaretBox | null = null;
  for (let i = 0; i < g.lines.length; i++) {
    const l = g.lines[i]!;
    if (l.estimated) {
      if (l.start === offset) return box(g.lines, i, l.x0);
      continue;
    }
    for (const c of l.clusters) {
      if (offset > c.start && offset < c.end) return box(g.lines, i, within(c, offset));
      if (offset === c.start) starts ??= box(g.lines, i, edge(c, false));
      if (offset === c.end) ends = box(g.lines, i, edge(c, true));
    }
    if (!starts && !ends && offset > l.start && offset < l.end) {
      // Unpainted characters (tabs) inside the line: the next painted one.
      const next = l.clusters.find((c) => c.start >= offset);
      if (next) gap ??= box(g.lines, i, edge(next, false));
    }
  }
  return (pos.upstream ? (ends ?? starts) : (starts ?? ends)) ?? gap;
}

/** Trailing-edge offset of cluster `i` of a line: the next painted
 * character's when only unpainted characters other than breaks lie between. */
function trailing(g: TextGeometry, l: VisualLine, i: number): number {
  const c = l.clusters[i]!;
  const next = l.clusters[i + 1];
  if (!next || next.start <= c.end) return c.end;
  const between = g.text.slice(c.end, next.start);
  return between.includes(PARAGRAPH) || between.includes(LINE_BREAK) ? c.end : next.start;
}

/** Nearest caret stop of one line to line-space x. */
function stopInLine(g: TextGeometry, li: number, lx: number): CaretPos {
  const l = g.lines[li]!;
  if (l.estimated) return { offset: l.start, upstream: false };
  let best: CaretPos = { offset: l.start, upstream: false };
  let d = Infinity;
  l.clusters.forEach((c, i) => {
    const span = c.end - c.start;
    for (let k = 0; k <= c.units; k++) {
      const t = k / c.units;
      const x = c.rtl ? c.x + c.advance * (1 - t) : c.x + c.advance * t;
      const di = Math.abs(x - lx);
      if (di < d) {
        d = di;
        best =
          k === c.units
            ? { offset: trailing(g, l, i), upstream: true }
            : { offset: c.start + Math.round((k * span) / c.units), upstream: false };
      }
    }
  });
  return best;
}

/** Line-space point of a slide point on line `i`. */
function local(l: VisualLine, x: number, y: number): [number, number] {
  return apply(l.inv, x, y);
}

/** Nearest caret position to a slide point (points). */
export function hitText(g: TextGeometry, x: number, y: number): CaretPos {
  let best = 0;
  let bestD = Infinity;
  g.lines.forEach((l, i) => {
    const [, ly] = local(l, x, y);
    const top = l.baseline - l.ascent;
    const bottom = l.baseline + l.descent;
    const d = ly < top ? top - ly : ly > bottom ? ly - bottom : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const [lx] = local(g.lines[best]!, x, y);
  return stopInLine(g, best, lx);
}

/** Line index of a position (its caret's line), or -1. */
export function lineOf(g: TextGeometry, pos: CaretPos): number {
  return caretBox(g, pos)?.line ?? -1;
}

/** Up/Down: the stop nearest `goalX` on the line above/below; past the first
 * or last line, the text start or end. */
export function verticalMove(g: TextGeometry, pos: CaretPos, dir: -1 | 1, goalX: number): CaretPos {
  const i = lineOf(g, pos);
  const j = i + dir;
  if (i < 0 || j < 0) return dir < 0 ? { offset: 0, upstream: false } : { offset: g.text.length, upstream: false };
  if (j >= g.lines.length) return { offset: g.text.length, upstream: false };
  return stopInLine(g, j, goalX);
}

/** Home/End of the visual line. */
export function lineEdge(g: TextGeometry, pos: CaretPos, end: boolean): CaretPos {
  const i = lineOf(g, pos);
  const l = g.lines[i];
  if (!l) return pos;
  return end ? { offset: l.end, upstream: true } : { offset: l.start, upstream: false };
}

/** Selection rectangles of [lo, hi): one per visual line; a selected break
 * or empty line shows as a narrow block. */
export function selectionBoxes(g: TextGeometry, lo: number, hi: number): LineRect[] {
  const out: LineRect[] = [];
  for (const l of g.lines) {
    const h = l.ascent + l.descent;
    const y = l.baseline - l.ascent;
    if (l.estimated) {
      if (lo <= l.start && l.start < hi) out.push({ m: l.m, x: l.x0, y, w: h * 0.3, h });
      continue;
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const c of l.clusters) {
      if (c.end <= lo || c.start >= hi) continue;
      const a = Math.max(lo, c.start);
      const b = Math.min(hi, c.end);
      const xa = a === c.start ? edge(c, false) : within(c, a);
      const xb = b === c.end ? edge(c, true) : within(c, b);
      x0 = Math.min(x0, xa, xb);
      x1 = Math.max(x1, xa, xb);
    }
    if (lo <= l.end && hi > l.end && (g.text[l.end] === PARAGRAPH || g.text[l.end] === LINE_BREAK)) {
      const xe = Math.max(...l.clusters.map((c) => c.x + c.advance));
      x0 = Math.min(x0, xe);
      x1 = Math.max(x1, xe + h * 0.3);
    }
    if (x0 <= x1) out.push({ m: l.m, x: x0, y, w: x1 - x0, h });
  }
  return out;
}

/** Slide-space bounding box of a caret (for placing the input method window). */
export function caretBounds(c: CaretBox): { x: number; y: number; w: number; h: number } {
  const a = apply(c.m, c.x, c.top);
  const b = apply(c.m, c.x, c.bottom);
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}
