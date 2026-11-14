/**
 * Device-pixel snapping that the engine's rasteriser applies (wolfrender-raster `snap.rs`,
 * which reproduces Splash): rectangle fills and axis-aligned strokes land on whole
 * pixels, rectangular clips widen outward to whole pixels, and filled glyph origins sit
 * on the pixel row above the baseline at a quarter-pixel horizontal phase. Without these
 * a canvas paints the same geometry with anti-aliased half-covered edges.
 *
 * Results are user-space geometry (device geometry mapped back through the inverse
 * transform), so paints keep their user-space coordinates.
 */
import { invert } from "./abi.ts";
import type { Mat, PathData, StrokeStyle } from "./model.ts";

/** Device-space distance within which two coordinates count as equal. */
const EPS = 1e-3;
/** Slack, in pixels, that lets an edge on a half-pixel tie round up. */
const TIE_SLACK = 5e-4;
const RIGHT_ANGLE_MITER = Math.SQRT2;
const KAPPA = 0.5522847498;

type Pt = { x: number; y: number };

/**
 * How user-space points reach device pixels. Under the plain page scale (plus a
 * whole-pixel offset) the engine computes device coordinates like Poppler does from a
 * PDF's 3-decimal operands; any other transform is applied in single precision.
 */
export class View {
  readonly d: Mat;
  readonly inv: Mat | null;
  /** Plain page scale plus a whole-pixel offset (the engine's Poppler-exact branch). */
  readonly isPage: boolean;
  private readonly pageHeight: number;
  private readonly f: Mat;
  private readonly slack: number;

  constructor(d: Mat, pageHeight: number) {
    this.d = d;
    this.inv = invert(d);
    this.pageHeight = pageHeight;
    this.isPage = d[1] === 0 && d[2] === 0 && d[0] === d[3] && Number.isInteger(d[4]) && Number.isInteger(d[5]);
    const r = Math.fround;
    this.f = [r(d[0]), r(d[1]), r(d[2]), r(d[3]), r(d[4]), r(d[5])];
    this.slack = this.isPage ? 0 : TIE_SLACK;
  }

  map(x: number, y: number): Pt {
    const d = this.d;
    if (this.isPage) {
      const k = d[0];
      const h = this.pageHeight;
      return { x: popplerReal(x) * k + d[4], y: -k * popplerReal(h - y) + h * k + d[5] };
    }
    const f = this.f;
    return { x: f[0] * x + f[2] * y + f[4], y: f[1] * x + f[3] * y + f[5] };
  }

  /** A vector, ignoring the translation. */
  mapVector(x: number, y: number): Pt {
    const f = this.f;
    return { x: f[0] * x + f[2] * y, y: f[1] * x + f[3] * y };
  }

  /** Splash `splashRound`. */
  round(v: number): number {
    return Math.floor(v + 0.5 + this.slack);
  }

  /** Rounds the edge pair `lo <= hi`, widening a collapsed pair to one pixel. */
  snapPair(lo: number, hi: number): [number, number] {
    const a = this.round(lo);
    const b = this.round(hi);
    return b === a ? [a, a + 1] : [a, b];
  }

  /** Splash `strokeAdjust`: both edges and the centre line; the upper edge lands 0.01 px short. */
  strokeAdjusted(centre: number, half: number): [number, number, number] {
    const [lo, hi0] = this.snapPair(centre - half, centre + half);
    const hi = hi0 - 0.01;
    return [lo, 0.5 * (lo + hi), hi];
  }

  /** Device point back to user space. */
  user(x: number, y: number): [number, number] {
    const i = this.inv!;
    return [i[0] * x + i[2] * y + i[4], i[1] * x + i[3] * y + i[5]];
  }

  /** Cache key: the grid is the same for any whole-pixel shift of the transform. */
  key(): string {
    const d = this.d;
    const frac = (v: number) => (v - Math.floor(v)).toFixed(6);
    return `${d[0]},${d[1]},${d[2]},${d[3]},${frac(d[4])},${frac(d[5])}`;
  }
}

/** A number as Poppler's lexer reads it back from 3-decimal text (`poppler_real`). */
export function popplerReal(v: number): number {
  const [whole, frac = ""] = Math.abs(v).toFixed(3).split(".");
  let real = Number(whole);
  let scale = 0.1;
  for (const digit of frac) {
    real += scale * Number(digit);
    scale *= 0.1;
  }
  return v < 0 ? -real : real;
}

const near = (a: number, b: number) => Math.abs(a - b) <= EPS;

/** User-space Path2D rectangle from device edges. */
function rectPath(path: Path2D, view: View, x0: number, y0: number, x1: number, y1: number) {
  const pts = [view.user(x0, y0), view.user(x1, y0), view.user(x1, y1), view.user(x0, y1)];
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 4; i++) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
}

/** The device-space axis-aligned rectangle `[xMin, yMin, xMax, yMax]` a path describes exactly, if any. */
function deviceRect(p: PathData, view: View): [number, number, number, number] | null {
  const pts: Pt[] = [];
  let closed = false;
  let k = 0;
  for (let i = 0; i < p.cmds.length; i++) {
    const c = p.cmds[i];
    if (c === 0 && i === 0) pts.push(view.map(p.pts[k], p.pts[k + 1]));
    else if (c === 1 && i > 0 && !closed) pts.push(view.map(p.pts[k], p.pts[k + 1]));
    else if (c === 4 && i > 0 && !closed) closed = true;
    else return null;
    if (c !== 4) k += 2;
  }
  if (pts.length === 5 && near(pts[4].x, pts[0].x) && near(pts[4].y, pts[0].y)) pts.pop();
  if (pts.length !== 4) return null;
  const hFirst =
    near(pts[0].y, pts[1].y) && near(pts[1].x, pts[2].x) && near(pts[2].y, pts[3].y) && near(pts[3].x, pts[0].x);
  const vFirst =
    near(pts[0].x, pts[1].x) && near(pts[1].y, pts[2].y) && near(pts[2].x, pts[3].x) && near(pts[3].y, pts[0].y);
  if (!hFirst && !vFirst) return null;
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Whole-pixel rectangle the engine fills for a rectangle path; `null` when not an axis-aligned rectangle. */
export function snappedFill(p: PathData, view: View): Path2D | null {
  if (!view.inv) return null;
  const r = deviceRect(p, view);
  if (!r) return null;
  const [x0, x1] = view.snapPair(r[0], r[2]);
  const [y0, y1] = view.snapPair(r[1], r[3]);
  const path = new Path2D();
  rectPath(path, view, x0, y0, x1, y1);
  return path;
}

/** Whole-pixel edges covering a rectangular clip; `null` when not axis-aligned. */
export function outwardClip(p: PathData, view: View): Path2D | null {
  if (!view.inv) return null;
  const r = deviceRect(p, view);
  if (!r) return null;
  const path = new Path2D();
  rectPath(path, view, Math.floor(r[0]), Math.floor(r[1]), Math.ceil(r[2]), Math.ceil(r[3]));
  return path;
}

type Segment = { horizontal: boolean; from: number; to: number; across: number; half: number; cap: number };

const dir = (s: Segment) => (s.to >= s.from ? 1 : -1);

function buildSegment(a: Pt, b: Pt, ux0: number, uy0: number, width: number, view: View): Segment | null {
  let horizontal: boolean;
  let from: number, to: number, across: number;
  if (near(a.y, b.y) && Math.abs(b.x - a.x) > EPS) {
    horizontal = true;
    [from, to, across] = [a.x, b.x, 0.5 * (a.y + b.y)];
  } else if (near(a.x, b.x) && Math.abs(b.y - a.y) > EPS) {
    horizontal = false;
    [from, to, across] = [a.y, b.y, 0.5 * (a.x + b.x)];
  } else return null;
  const length = Math.hypot(ux0, uy0);
  if (length === 0) return null;
  const ux = ux0 / length;
  const uy = uy0 / length;
  const t = view.mapVector(-uy * width, ux * width);
  const c = view.mapVector(ux * width * 0.5, uy * width * 0.5);
  const [acrossT, alongT, capAlong] = horizontal ? [t.y, t.x, c.x] : [t.x, t.y, c.y];
  if (Math.abs(alongT) > EPS) return null;
  return { horizontal, from, to, across, half: 0.5 * Math.abs(acrossT), cap: Math.abs(capAlong) };
}

function endExtension(s: Segment, n: Segment | undefined, style: StrokeStyle): number | null {
  if (!n) return style.cap === "butt" ? 0 : style.cap === "square" ? s.cap : null;
  if (n.horizontal === s.horizontal) return dir(n) === dir(s) ? 0 : null;
  if (style.join === "round") return 0;
  if (style.join !== "miter" || style.miterLimit < RIGHT_ANGLE_MITER) return null;
  return n.half;
}

function pushWedge(
  path: Path2D,
  view: View,
  cx: number,
  cy: number,
  r: number,
  sx: number,
  sy: number,
  xs: number[],
  ys: number[],
) {
  const k = r * KAPPA;
  const xEdge = sx < 0 ? xs[0] : xs[2];
  const yEdge = sy < 0 ? ys[0] : ys[2];
  const onX: [number, number] = [xEdge, ys[1]];
  const onY: [number, number] = [xs[1], yEdge];
  const nearX: [number, number] = [xEdge, cy + sy * k];
  const nearY: [number, number] = [cx + sx * k, yEdge];
  const [first, last, c1, c2] = sx * sy > 0 ? [onX, onY, nearX, nearY] : [onY, onX, nearY, nearX];
  const u = (q: [number, number]) => view.user(q[0], q[1]);
  const m = view.user(xs[1], ys[1]);
  path.moveTo(m[0], m[1]);
  const f = u(first);
  path.lineTo(f[0], f[1]);
  const [a, b, c] = [u(c1), u(c2), u(last)];
  path.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
  path.closePath();
}

/**
 * Whole-pixel rectangles the engine fills for a solid stroke of axis-aligned straight
 * segments; `null` for curves, diagonals, reversals, dashes, round caps, bevels, hairlines.
 * `antiAlias` is set when round joints add anti-aliased quarter discs.
 */
export function snappedStroke(
  p: PathData,
  style: StrokeStyle,
  view: View,
): { path: Path2D; antiAlias: boolean } | null {
  const width = style.width;
  if (!view.inv || width === null || width <= 0 || style.dash !== null || style.cap === "round") return null;
  const subpaths: { pts: [number, number][]; closed: boolean }[] = [];
  let k = 0;
  for (const c of p.cmds) {
    if (c === 0) {
      subpaths.push({ pts: [[p.pts[k], p.pts[k + 1]]], closed: false });
      k += 2;
    } else if (c === 1) {
      const last = subpaths.at(-1);
      if (!last) return null;
      last.pts.push([p.pts[k], p.pts[k + 1]]);
      k += 2;
    } else if (c === 4) {
      const last = subpaths.at(-1);
      if (!last) return null;
      last.closed = true;
    } else return null;
  }
  const path = new Path2D();
  let any = false;
  let rounded = false;
  for (const { pts, closed } of subpaths) {
    if (closed && pts.length > 1 && pts[0][0] === pts.at(-1)![0] && pts[0][1] === pts.at(-1)![1]) pts.pop();
    if (pts.length < 2) continue;
    const count = pts.length;
    const segCount = closed ? count : count - 1;
    const segs: Segment[] = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % count];
      const s = buildSegment(view.map(a[0], a[1]), view.map(b[0], b[1]), b[0] - a[0], b[1] - a[1], width, view);
      if (!s) return null;
      segs.push(s);
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const prev = i > 0 ? segs[i - 1] : closed ? segs.at(-1) : undefined;
      const next = i + 1 < segs.length ? segs[i + 1] : closed ? segs[0] : undefined;
      const start = endExtension(s, prev, style);
      const end = endExtension(s, next, style);
      if (start === null || end === null) return null;
      if (next && style.join === "round" && next.horizontal !== s.horizontal) {
        const [cx, cy] = s.horizontal ? [s.to, s.across] : [s.across, s.to];
        const [dx, dy] = s.horizontal ? [dir(s), 0] : [0, dir(s)];
        const [nx, ny] = next.horizontal ? [dir(next), 0] : [0, dir(next)];
        pushWedge(
          path,
          view,
          cx,
          cy,
          s.half,
          Math.sign(dx - nx),
          Math.sign(dy - ny),
          view.strokeAdjusted(cx, s.half),
          view.strokeAdjusted(cy, s.half),
        );
        rounded = true;
      }
      const [lo, hi] = dir(s) > 0 ? [s.from - start, s.to + end] : [s.to - end, s.from + start];
      const [a0, a1] = view.snapPair(lo, hi);
      const [c0, c1] = view.snapPair(s.across - s.half, s.across + s.half);
      if (s.horizontal) rectPath(path, view, a0, c0, a1, c1);
      else rectPath(path, view, c0, a0, c1, a1);
      any = true;
    }
  }
  return any ? { path, antiAlias: rounded } : null;
}

/**
 * Where the engine places a filled glyph's origin: the pixel row above the baseline and
 * a quarter-pixel horizontal phase (whole pixels when the face box, `boxHeight` device
 * pixels, is over 50 px tall). Returns the user-space origin.
 */
export function glyphGrid(view: View, boxHeight: number): ((x: number, y: number) => [number, number]) | null {
  if (!view.inv) return null;
  const quarter = boxHeight + 3 <= 50;
  const d = view.d;
  return (x, y) => {
    const dx = d[0] * x + d[2] * y + d[4] + TIE_SLACK * 0.2;
    const col = Math.floor(dx);
    const px = col + (quarter ? Math.floor((dx - col) * 4) / 4 : 0);
    const py = Math.floor(view.map(x, y).y + (view.isPage ? 0 : TIE_SLACK * 0.2));
    return view.user(px, py);
  };
}

/** Splash's `glyphH - 3` from the face box in font units (corners truncated toward zero). */
export function faceBoxHeight(
  d: Mat,
  size: number,
  upem: number,
  bbox: readonly [number, number, number, number],
): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const bx of [bbox[0], bbox[2]])
    for (const by of [bbox[1], bbox[3]]) {
      const y = Math.trunc((d[1] * size * bx - d[3] * size * by) / upem);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  return hi === lo ? 0 : hi - lo;
}
