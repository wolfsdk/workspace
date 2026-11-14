/**
 * Paint one display-list page onto a 2D canvas context. Text is placed from the IR's glyph
 * runs and never re-flowed: every glyph is drawn from the outline of the engine's own face
 * (bytes fetched by handle, see `resources.ts`) at the engine's pen position, with the
 * engine's glyph ids. If a face fails to load, each cluster is drawn with `fillText` at the
 * engine's position, squeezed to the engine's advance, in a fallback family (counted in
 * `RenderStats.text.fallback`). A run whose engine face lacks its script (or whose family the
 * engine substituted) is drawn with a face of the extended font pack when there is one
 * (`RenderStats.text.pack`): as browser text in its registered `FontFace`, or from its outlines
 * by code point. Paths, glyph-run paths and gradients are cached on the model
 * objects, so a repaint at a new zoom only replays fills.
 */
import { mul } from "./abi.ts";
import type { DisplayList, FontRef, Glyphs, GroupOp, Mat, Op, Paint, PathData, StrokeStyle, TextRun } from "./model.ts";
import type { FaceEntry, ResourceCache } from "./resources.ts";
import { faceBoxHeight, glyphGrid, outwardClip, snappedFill, snappedStroke, View } from "./snap.ts";
import type { SfntFace } from "./sfnt.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type RenderOptions = {
  /** Device pixels per point (150 dpi = 150 / 72). */
  pxPerPt: number;
  resources?: ResourceCache | null;
  /** Fill the whole canvas first (`null`: leave it as is). */
  background?: string | null;
  /** Device-pixel position of the page's top-left corner (viewport rendering); default 0, 0. */
  offsetX?: number;
  offsetY?: number;
};

/** How a glyph run's text was drawn: `pack` with an extended font pack face (or a stand-in while
 * it downloads, counted in `RenderStats.pendingFonts`). */
export type TextPath = "outline" | "fontface" | "pack" | "fallback";

export type RenderStats = {
  ms: number;
  ops: number;
  text: Record<TextPath, number>;
  /** Text path used per requested font (`family weight style`). */
  fonts: Record<string, TextPath>;
  /** Runs drawn in a stand-in family while their pack face downloads; `ResourceCache.repaint` paints them again. */
  pendingFonts: number;
  /** Features painted approximately or not at all, with counts. */
  skipped: Record<string, number>;
};

type State = {
  dl: DisplayList;
  res: ResourceCache | null;
  stats: RenderStats;
  layers: OffscreenCanvas[];
  width: number;
  height: number;
  fontById: Map<number, FontRef>;
  /** Snapping view per transform in use this paint. */
  views: Map<Mat, View>;
};

const pathCache = new WeakMap<PathData, Path2D>();
const runPathCache = new WeakMap<TextRun, { key: string; path: Path2D }>();
const packPathCache = new WeakMap<TextRun, Path2D>();
/** Device-snapped fill/stroke/clip geometry per path, keyed by the transform's grid. */
const snapCache = new WeakMap<PathData, Map<string, Path2D | null>>();
const paintCache = new WeakMap<Paint, CanvasGradient>();
const utf16Cache = new WeakMap<TextRun, Uint32Array>();

export function renderPage(ctx: Ctx2D, dl: DisplayList, opts: RenderOptions): RenderStats {
  const t0 = performance.now();
  const stats: RenderStats = {
    ms: 0,
    ops: 0,
    text: { outline: 0, fontface: 0, pack: 0, fallback: 0 },
    fonts: {},
    pendingFonts: 0,
    skipped: {},
  };
  const st: State = {
    dl,
    res: opts.resources ?? null,
    stats,
    layers: [],
    width: ctx.canvas.width,
    height: ctx.canvas.height,
    fontById: new Map(dl.fonts.map((f) => [f.id, f])),
    views: new Map(),
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, st.width, st.height);
  }
  const s = opts.pxPerPt;
  const base: Mat = [s, 0, 0, s, opts.offsetX ?? 0, opts.offsetY ?? 0];
  ctx.setTransform(base[0], 0, 0, base[3], base[4], base[5]);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  paintOps(ctx, dl.ops, base, st);
  ctx.restore();
  stats.ms = performance.now() - t0;
  st.res?.notePaint(ctx, dl, opts, stats.pendingFonts > 0);
  return stats;
}

function skip(st: State, what: string) {
  st.stats.skipped[what] = (st.stats.skipped[what] ?? 0) + 1;
}

function paintOps(ctx: Ctx2D, ops: Op[], ctm: Mat, st: State) {
  for (const op of ops) {
    st.stats.ops++;
    switch (op.kind) {
      case "fill": {
        const style = paintStyle(ctx, op.paint, st);
        if (style === null) break;
        ctx.fillStyle = style;
        const snapped = snapped2d(op.path, "fill", viewOf(st, ctm), (v) => snappedFill(op.path, v));
        if (snapped) ctx.fill(snapped);
        else ctx.fill(path2d(op.path), op.evenOdd ? "evenodd" : "nonzero");
        break;
      }
      case "stroke": {
        const style = paintStyle(ctx, op.paint, st);
        if (style === null) break;
        const view = viewOf(st, ctm);
        const snapped = snapped2d(
          op.path,
          `stroke ${strokeKey(op.style)}`,
          view,
          (v) => snappedStroke(op.path, op.style, v)?.path ?? null,
        );
        if (snapped) {
          ctx.fillStyle = style;
          ctx.fill(snapped);
          break;
        }
        ctx.strokeStyle = style;
        applyStroke(ctx, op.style, ctm);
        ctx.stroke(path2d(op.path));
        break;
      }
      case "text":
        drawRun(ctx, op.run, ctm, st);
        break;
      case "image": {
        const bitmap = st.res?.image(st.dl, op.image) ?? null;
        if (!bitmap) {
          // As the engine does for a picture it cannot decode: a grey hairline frame.
          skip(st, `image not decodable (${imageMime(st, op.image)}): frame drawn`);
          ctx.save();
          ctx.strokeStyle = "#808080";
          ctx.lineWidth = 1 / Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) || 1);
          ctx.strokeRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h);
          ctx.restore();
          break;
        }
        ctx.drawImage(bitmap, op.rect.x, op.rect.y, op.rect.w, op.rect.h);
        break;
      }
      case "group":
        paintGroup(ctx, op, ctm, st);
        break;
      default:
        skip(st, `op.${op.name}`);
    }
  }
}

function imageMime(st: State, id: number): string {
  return st.dl.images.find((m) => m.id === id)?.mime ?? `image ${id} not listed`;
}

function paintGroup(ctx: Ctx2D, g: GroupOp, parentCtm: Mat, st: State) {
  ctx.save();
  let ctm = parentCtm;
  if (!g.identity) {
    const t = g.transform;
    ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    ctm = mul(parentCtm, t);
  }
  if (g.clip?.kind === "path") {
    const p = g.clip.path;
    const snapped = g.clip.evenOdd ? null : snapped2d(p, "clip", viewOf(st, ctm), (v) => outwardClip(p, v));
    ctx.clip(snapped ?? path2d(p), g.clip.evenOdd ? "evenodd" : "nonzero");
  } else if (g.clip?.kind === "text") {
    const clip = new Path2D();
    let complete = true;
    for (const run of g.clip.runs) {
      drawRun(ctx, run, ctm, st);
      const face = faceOf(run, st);
      if (face?.outline) clip.addPath(runPath(run, face, face.outline, null));
      else complete = false;
    }
    if (complete) ctx.clip(clip);
    else skip(st, "clip.text (no outlines: not clipped)");
  }
  if (g.knockout) skip(st, "group.knockout (source-over)");
  if (g.blendSpace) skip(st, "group.blend_space (sRGB)");
  const layered = g.opacity < 1 || g.softMask !== null || (g.blend !== "normal" && g.isolated);
  if (!layered) {
    if (g.blend !== "normal") {
      skip(st, "group.non_isolated_blend (per child)");
      ctx.globalCompositeOperation = g.blend;
    }
    paintOps(ctx, g.ops, ctm, st);
    ctx.restore();
    return;
  }
  if (g.opacity <= 0) {
    ctx.restore();
    return;
  }
  const layer = acquire(st);
  const lc = layer.getContext("2d")!;
  lc.setTransform(ctx.getTransform());
  lc.textBaseline = "alphabetic";
  paintOps(lc, g.ops, ctm, st);
  if (g.softMask) {
    const m = g.softMask;
    const mask = acquire(st);
    const mc = mask.getContext("2d")!;
    if (m.backdrop) {
      mc.fillStyle = m.backdrop;
      mc.fillRect(0, 0, st.width, st.height);
    }
    mc.setTransform(ctx.getTransform());
    paintGroup(mc, m.group, ctm, st);
    if (m.luminosity) {
      const img = mc.getImageData(0, 0, st.width, st.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        d[i + 3] = Math.round(lum * d[i + 3]);
      }
      mc.putImageData(img, 0, 0);
    }
    if (m.transfer) skip(st, "soft_mask.transfer (identity)");
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = "destination-in";
    lc.drawImage(mask, 0, 0);
    release(st, mask);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = g.opacity;
  ctx.globalCompositeOperation = g.blend === "normal" ? "source-over" : g.blend;
  ctx.drawImage(layer, 0, 0);
  release(st, layer);
  ctx.restore();
}

function acquire(st: State): OffscreenCanvas {
  const c = st.layers.pop() ?? new OffscreenCanvas(st.width, st.height);
  const lc = c.getContext("2d")!;
  lc.reset();
  return c;
}

function release(st: State, c: OffscreenCanvas) {
  st.layers.push(c);
}

function viewOf(st: State, ctm: Mat): View {
  let v = st.views.get(ctm);
  if (!v) st.views.set(ctm, (v = new View(ctm, st.dl.height)));
  return v;
}

function strokeKey(s: StrokeStyle): string {
  return `${s.width} ${s.cap} ${s.join} ${s.miterLimit} ${s.dash}`;
}

/** Device-snapped geometry for `p` under `view`, cached per transform grid; `null` when the engine would not snap it. */
function snapped2d(p: PathData, kind: string, view: View, make: (v: View) => Path2D | null): Path2D | null {
  let byKey = snapCache.get(p);
  if (!byKey) snapCache.set(p, (byKey = new Map()));
  const key = `${kind} ${view.key()}`;
  let hit = byKey.get(key);
  if (hit === undefined) byKey.set(key, (hit = make(view)));
  return hit;
}

function path2d(p: PathData): Path2D {
  let path = pathCache.get(p);
  if (!path) {
    path = new Path2D();
    appendPath(path, p.cmds, p.pts);
    pathCache.set(p, path);
  }
  return path;
}

function appendPath(path: Path2D, cmds: number[], pts: number[]) {
  let k = 0;
  for (const c of cmds) {
    switch (c) {
      case 0:
        path.moveTo(pts[k], pts[k + 1]);
        k += 2;
        break;
      case 1:
        path.lineTo(pts[k], pts[k + 1]);
        k += 2;
        break;
      case 2:
        path.quadraticCurveTo(pts[k], pts[k + 1], pts[k + 2], pts[k + 3]);
        k += 4;
        break;
      case 3:
        path.bezierCurveTo(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], pts[k + 5]);
        k += 6;
        break;
      case 4:
        path.closePath();
        break;
    }
  }
}

function paintStyle(ctx: Ctx2D, paint: Paint, st: State): string | CanvasGradient | CanvasPattern | null {
  switch (paint.kind) {
    case "solid":
      return paint.transparent ? null : paint.color;
    case "linear":
    case "radial": {
      if (paint.extend !== "pad") skip(st, `gradient.extend ${paint.extend} (pad)`);
      if (paint.space) skip(st, "gradient.interpolation_space (sRGB)");
      let g = paintCache.get(paint);
      if (!g) {
        g =
          paint.kind === "linear"
            ? ctx.createLinearGradient(paint.x0, paint.y0, paint.x1, paint.y1)
            : ctx.createRadialGradient(paint.x0, paint.y0, paint.r0, paint.x1, paint.y1, paint.r1);
        let last = 0;
        for (const s of paint.stops) {
          last = Math.min(1, Math.max(last, s.offset));
          g.addColorStop(last, s.color);
        }
        paintCache.set(paint, g);
      }
      return g;
    }
    case "image": {
      const bitmap = st.res?.image(st.dl, paint.image) ?? null;
      if (!bitmap) {
        skip(st, "paint.image (bytes not available)");
        return null;
      }
      if (paint.extend === "reflect") skip(st, "paint.image extend reflect (repeat)");
      const pattern = ctx.createPattern(bitmap, paint.extend === "pad" ? "no-repeat" : "repeat");
      pattern?.setTransform({
        a: paint.rect.w / bitmap.width,
        d: paint.rect.h / bitmap.height,
        e: paint.rect.x,
        f: paint.rect.y,
      });
      return pattern;
    }
    default:
      skip(st, `paint.${paint.what}`);
      return null;
  }
}

function applyStroke(ctx: Ctx2D, s: StrokeStyle, ctm: Mat) {
  // A hairline is one device pixel wide whatever the transform.
  ctx.lineWidth = s.width ?? 1 / Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) || 1);
  ctx.lineCap = s.cap;
  ctx.lineJoin = s.join;
  ctx.miterLimit = s.miterLimit;
  ctx.setLineDash(s.dash ?? []);
  ctx.lineDashOffset = s.dashPhase;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function faceOf(run: TextRun, st: State): FaceEntry | null {
  const font = st.fontById.get(run.font);
  return font && st.res ? st.res.face(font) : null;
}

function drawRun(ctx: Ctx2D, run: TextRun, ctm: Mat, st: State) {
  const m = run.mode;
  const fills = m === "fill" || m === "fill_stroke" || m === "fill_clip" || m === "fill_stroke_clip";
  const strokes = m === "stroke" || m === "fill_stroke" || m === "stroke_clip" || m === "fill_stroke_clip";
  if (!fills && !strokes) return;
  const fill = fills && run.fill ? paintStyle(ctx, run.fill, st) : null;
  const stroke = strokes && run.stroke ? paintStyle(ctx, run.stroke.paint, st) : null;
  if (fill === null && stroke === null) return;
  const font = st.fontById.get(run.font);
  const packed = font && st.res ? st.res.packFace(run, font) : null;
  const pending = packed === "pending";
  const pack = packed && !pending ? packed : null;
  // While a pack face downloads, the run is drawn as a fallback would be (a stand-in family).
  const face = pack || pending ? null : font && st.res ? st.res.face(font) : null;
  const path: TextPath =
    pack || pending ? "pack" : face?.outline ? "outline" : face?.cssFamily ? "fontface" : "fallback";
  st.stats.text[path]++;
  if (pending) st.stats.pendingFonts++;
  if (font) st.stats.fonts[`${font.family} ${font.weight}${font.italic ? " italic" : ""}`] = path;
  if (fill !== null) ctx.fillStyle = fill;
  if (stroke !== null) {
    ctx.strokeStyle = stroke;
    applyStroke(ctx, run.stroke!.style, ctm);
  }
  const outline = face?.outline ?? (pack && !pack.face.cssFamily ? pack.face.outline : null);
  if (outline) {
    const p = face
      ? runPath(run, face, outline, m === "fill" ? viewOf(st, ctm) : null)
      : packRunPath(run, pack!.face, outline);
    if (fill !== null) ctx.fill(p);
    if (stroke !== null) ctx.stroke(p);
    return;
  }
  const fallback = fallbackFamilies(font?.resolvedFamily ?? font?.family ?? "");
  const families = pack ? `"${pack.face.cssFamily}", ${fallback}` : (face?.cssFamily ?? fallback);
  // Always set: save/restore in groups reverts `ctx.font`, so a cached value is unreliable.
  ctx.font = `${font?.italic ? "italic " : ""}${font?.weight ?? 400} ${run.size}px ${families}`;
  const mapPua = face === null && !pack;
  if (run.vertical) skip(st, "text.vertical (horizontal clusters)");
  const g = run.glyphs;
  if (!g) {
    skip(st, "text.pending (browser shaping)");
    let y = run.y;
    for (const line of run.text.replace(/\r\n?/g, "\n").split("\n")) {
      const t = line.replace(/\t/g, "    ");
      if (fill !== null) ctx.fillText(t, run.x, y);
      if (stroke !== null) ctx.strokeText(t, run.x, y);
      y += run.size * 1.2;
    }
    return;
  }
  if (pack?.shaped) {
    // The whole run in one call, so the browser shapes the script (joining, reordering), squeezed to the engine's width.
    const width = g.advances.reduce((sum, a) => sum + a, 0);
    const max = width > 0 ? width : undefined;
    if (fill !== null) ctx.fillText(run.text, run.x, run.y, max);
    if (stroke !== null) ctx.strokeText(run.text, run.x, run.y, max);
    return;
  }
  // Same origin grid as the outline path; the fallback face's box is estimated as 1.25 em.
  const snap =
    m === "fill" && !run.vertical
      ? glyphGrid(viewOf(st, ctm), Math.trunc(run.size * 1.25 * Math.hypot(ctm[1], ctm[3])))
      : null;
  eachCluster(run, g, (text, x, y, adv) => {
    const t = mapPua ? mapSymbols(text) : text;
    if (t.trim() === "") return;
    if (snap) [x, y] = snap(x, y);
    const max = adv > 0 && !run.vertical ? adv : undefined;
    if (fill !== null) {
      if (max === undefined) ctx.fillText(t, x, y);
      else ctx.fillText(t, x, y, max);
    }
    if (stroke !== null) {
      if (max === undefined) ctx.strokeText(t, x, y);
      else ctx.strokeText(t, x, y, max);
    }
  });
}

/** Each cluster of a shaped run in visual order: its text, origin (pen plus the first glyph's
 * offset) and advance (all its glyphs). */
function eachCluster(run: TextRun, g: Glyphs, visit: (text: string, x: number, y: number, adv: number) => void) {
  const u16 = utf16Index(run);
  const byteLen = u16.length - 1;
  let pen = run.vertical ? run.y : run.x;
  const n = g.ids.length;
  let monotonic = true;
  for (let k = 1; k < n && monotonic; k++) monotonic = g.clusters[k] >= g.clusters[k - 1];
  for (let i = 0; i < n;) {
    const c = g.clusters[i];
    let adv = g.advances[i];
    let j = i + 1;
    while (j < n && g.clusters[j] === c) adv += g.advances[j++];
    // The cluster's text runs to the next larger cluster start (clusters may be unordered).
    let next = byteLen;
    if (monotonic) next = j < n ? g.clusters[j] : byteLen;
    else for (let k = 0; k < n; k++) if (g.clusters[k] > c && g.clusters[k] < next) next = g.clusters[k];
    visit(
      run.text.slice(u16[c], u16[next]),
      run.vertical ? run.x : pen + g.dx[i],
      run.vertical ? pen + g.dy[i] : run.y + g.dy[i],
      adv,
    );
    pen += adv;
    i = j;
  }
}

/**
 * A run drawn from the outlines of a pack face that has no `FontFace` (no `FontFaceSet` here):
 * each cluster's code points by the face's cmap, from the cluster's origin, squeezed into the
 * engine's advance when wider (no shaping). Cached per run.
 */
function packRunPath(run: TextRun, entry: FaceEntry, face: SfntFace): Path2D {
  let path = packPathCache.get(run);
  if (path) return path;
  const out = new Path2D();
  const s = run.size / face.unitsPerEm;
  const place = (text: string, x: number, y: number, width: number) => {
    const ids = Array.from(text, (ch) => face.glyphFor(ch.codePointAt(0)!));
    const natural = ids.reduce((sum, id) => sum + face.advance(id) * s, 0);
    const squeeze = width > 0 && natural > width ? width / natural : 1;
    for (const id of ids) {
      const gp = glyphPath(entry, face, id);
      if (gp) out.addPath(gp, { a: s * squeeze, b: 0, c: 0, d: -s, e: x, f: y });
      x += face.advance(id) * s * squeeze;
    }
  };
  if (run.glyphs) eachCluster(run, run.glyphs, place);
  else place(run.text.replace(/\s/g, " "), run.x, run.y, 0);
  packPathCache.set(run, (path = out));
  return path;
}

/** UTF-16 index of every UTF-8 byte offset of the run's text (length = bytes + 1). */
function utf16Index(run: TextRun): Uint32Array {
  let map = utf16Cache.get(run);
  if (!map) {
    const text = run.text;
    const out: number[] = [];
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i)!;
      const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      for (let b = 0; b < bytes; b++) out.push(i);
      i += cp > 0xffff ? 2 : 1;
    }
    out.push(text.length);
    map = Uint32Array.from(out);
    utf16Cache.set(run, map);
  }
  return map;
}

/**
 * One Path2D for the whole run in user space, from glyph outlines at the engine's
 * positions; origins snapped to the engine's glyph grid under `view` when given (filled runs).
 */
function runPath(run: TextRun, entry: FaceEntry, face: SfntFace, view: View | null): Path2D {
  const key = view ? view.key() : "free";
  const hit = runPathCache.get(run);
  if (hit?.key === key) return hit.path;
  const path = new Path2D();
  const s = run.size / face.unitsPerEm;
  const snap = view ? glyphGrid(view, faceBoxHeight(view.d, run.size, face.unitsPerEm, face.bbox)) : null;
  const add = (gid: number, x: number, y: number) => {
    const gp = glyphPath(entry, face, gid);
    if (!gp) return;
    const [sx, sy] = snap ? snap(x, y) : [x, y];
    path.addPath(gp, { a: s, b: 0, c: 0, d: -s, e: sx, f: sy });
  };
  const g = run.glyphs;
  if (g) {
    // Horizontal pens accumulate in single precision, as the engine's rasteriser does.
    const f = Math.fround;
    let pen = run.vertical ? 0 : f(run.x);
    for (let i = 0; i < g.ids.length; i++) {
      if (run.vertical)
        add(g.ids[i], run.x - (face.advance(g.ids[i]) * s) / 2 + g.dx[i], run.y + pen + face.ascender * s + g.dy[i]);
      else add(g.ids[i], f(pen + f(g.dx[i])), f(f(run.y) + f(g.dy[i])));
      pen = run.vertical ? pen + g.advances[i] : f(pen + f(g.advances[i]));
    }
  } else {
    // Pending shaping, per the IR's rules (no kerning here).
    const lineHeight = Math.max((face.ascender - face.descender + face.lineGap) * s, run.size);
    const space = face.advance(face.glyphFor(32)) * s;
    let x = run.x;
    let y = run.y;
    for (const ch of run.text) {
      if (ch === "\r") continue;
      if (ch === "\n") {
        x = run.x;
        y += lineHeight;
        continue;
      }
      if (ch === "\t") {
        x += 4 * space;
        continue;
      }
      const gid = face.glyphFor(ch.codePointAt(0)!);
      add(gid, x, y);
      x += face.advance(gid) * s;
    }
  }
  runPathCache.set(run, { key, path });
  return path;
}

function glyphPath(entry: FaceEntry, face: SfntFace, gid: number): Path2D | null {
  let p = entry.paths.get(gid);
  if (p === undefined) {
    const o = face.outline(gid);
    p = null;
    if (o) {
      p = new Path2D();
      appendPath(p, o.cmds, o.pts);
    }
    entry.paths.set(gid, p);
  }
  return p;
}

/**
 * CSS font-family list for a face the host has no bytes for: the face itself (if installed),
 * a metric-compatible equivalent, then a close system face.
 */
export function fallbackFamilies(family: string): string {
  const f = family.toLowerCase();
  if (f === "carlito" || f === "calibri" || f.startsWith("calibri "))
    return `Carlito, Calibri, "Helvetica Neue", Arial, sans-serif`;
  if (f === "caladea" || f === "cambria" || f.startsWith("cambria "))
    return `Caladea, Cambria, Georgia, "Times New Roman", serif`;
  if (f === "liberation sans" || f === "arial" || f === "helvetica")
    return `"Liberation Sans", Arial, Helvetica, sans-serif`;
  if (f === "liberation serif" || f === "times new roman" || f === "times")
    return `"Liberation Serif", "Times New Roman", Times, serif`;
  if (f === "liberation mono" || f === "courier new" || f === "courier")
    return `"Liberation Mono", "Courier New", Courier, monospace`;
  if (f.includes("symbol") || f.includes("dingbats") || f.includes("wingdings"))
    return `"Apple Symbols", "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif`;
  return `"${family.replace(/"/g, "")}", sans-serif`;
}

/** Symbol/Wingdings private-use code points that bullets use, as Unicode. */
const PUA: Record<string, string> = {
  "\uf0b7": "\u2022",
  "\uf0a7": "\u25aa",
  "\uf0a8": "\u25fb",
  "\uf0d8": "\u27a2",
  "\uf0fc": "\u2713",
  "\uf076": "\u2756",
};

function mapSymbols(t: string): string {
  return /[\uf000-\uf0ff]/.test(t) ? t.replace(/[\uf000-\uf0ff]/g, (c) => PUA[c] ?? c) : t;
}
