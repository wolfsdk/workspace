/**
 * The one file that knows the reactor ABI (`docs/wolf-web-reactor-abi.md`) and the WolfRender IR
 * JSON it carries. Everything else uses `model.ts`. A renamed field is a one-line change
 * here. Parsing is defensive: unknown op kinds and variants are counted in
 * `DisplayList.unknown` instead of throwing.
 */
import type {
  BlendMode,
  Clip,
  Cluster,
  DisplayList,
  Extend,
  FaceInfo,
  FontRef,
  FontsInfo,
  Glyphs,
  GroupOp,
  ImageRef,
  Link,
  Mat,
  ObjectText,
  Op,
  Paint,
  PathData,
  Rect,
  SoftMask,
  StrokeStyle,
  TextLayout,
  TextMode,
  TextRun,
} from "./model.ts";

type Json = Record<string, unknown>;

/** One reactor request; `inputs` are binary request fields (as `Reactor.call` in `../reactor/abi.ts` takes them). */
export type ReactorCall = (request: Json, inputs?: Record<string, Uint8Array>) => Promise<Json>;

export class ReactorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const requests = {
  open: (name: string): Json => ({ cmd: "open", name }),
  /** Binary input field name of `open`. */
  openBytesField: "bytes",
  close: (doc: number): Json => ({ cmd: "close", doc }),
  layout: (doc: number): Json => ({ cmd: "layout", doc }),
  displayList: (doc: number, page: number): Json => ({ cmd: "display_list", doc, page }),
  renderPagePng: (doc: number, page: number, scale: number): Json => ({ cmd: "render_page_png", doc, page, scale }),
  resource: (handle: string): Json => ({ cmd: "resource", handle }),
  hitTest: (doc: number, page: number, x: number, y: number): Json => ({
    cmd: "hit_test",
    doc,
    page,
    x_pt: x,
    y_pt: y,
  }),
  caretRects: (doc: number, objectId: string, start: number, end: number): Json => ({
    cmd: "caret_rects",
    doc,
    object_id: objectId,
    start,
    end,
  }),
  textLayout: (doc: number, objectId: string): Json => ({ cmd: "text_layout", doc, object_id: objectId }),
  fonts: (doc: number): Json => ({ cmd: "fonts", doc }),
};

/** Throw `ReactorError` for a refused request; return the response otherwise. */
export function checked(res: Json): Json {
  if (res.ok === false) {
    const err = obj(res.error);
    throw new ReactorError(str(err.code) ?? "error", str(err.message) ?? "");
  }
  return res;
}

export type Opened = { doc: number; format: string; sha256: string };
export function parseOpen(res: Json): Opened {
  checked(res);
  return { doc: num(res.doc), format: str(res.format) ?? "", sha256: str(res.sha256) ?? "" };
}

export function parseLayout(res: Json): { pages: number; cached: boolean; ms: number } {
  checked(res);
  return { pages: num(obj(res.summary).pages), cached: res.cached === true, ms: num(res.layout_ms) };
}

export type PagePng = {
  png: Uint8Array;
  page: number;
  sizePt: [number, number];
  pixelSize: [number, number];
  ms: number;
};
export function parsePagePng(res: Json): PagePng {
  checked(res);
  const size = arr(res.size_pt);
  const px = arr(res.pixel_size);
  return {
    png: bytes(res.png),
    page: num(res.page),
    sizePt: [num(size[0]), num(size[1])],
    pixelSize: [num(px[0]), num(px[1])],
    ms: num(res.ms),
  };
}

export type Resource = { handle: string; kind: "font" | "image" | string; mime: string; bytes: Uint8Array };
export function parseResource(res: Json): Resource {
  checked(res);
  return {
    handle: str(res.handle) ?? "",
    kind: str(res.kind) ?? "",
    mime: str(res.mime) ?? "",
    bytes: bytes(res.bytes),
  };
}

export type EngineHit = {
  objectId: string | null;
  offset: number;
  inside: boolean;
  run: number;
  runOffset: number;
  caret: Rect | null;
};
export function parseHitTest(res: Json): EngineHit {
  checked(res);
  const c = arr(res.caret);
  return {
    objectId: str(res.object_id),
    offset: num(res.offset),
    inside: res.inside_text === true,
    run: num(res.run, -1),
    runOffset: num(res.run_offset),
    caret: c.length === 4 ? { x: num(c[0]), y: num(c[1]), w: num(c[2]), h: num(c[3]) } : null,
  };
}

export function parseCaretRects(res: Json): { page: number; rect: Rect }[] {
  checked(res);
  return arr(res.rects).map((r) => {
    const o = obj(r);
    return { page: num(o.page), rect: { x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h) } };
  });
}

export function parseTextLayout(res: Json): TextLayout {
  checked(res);
  return {
    objectId: str(res.object_id) ?? "",
    length: num(res.length),
    lines: arr(res.lines).map((l) => {
      const o = obj(l);
      const t = arr(o.transform);
      return {
        page: num(o.page, 1),
        ctm: (t.length === 6 ? t.map((v) => num(v)) : [1, 0, 0, 1, 0, 0]) as Mat,
        box: boxArr(o.box),
        baseline: num(o.baseline),
        ascent: num(o.ascent),
        descent: num(o.descent),
        approximate: o.approximate === true,
        clusters: arr(o.clusters).map((c): Cluster => {
          const k = obj(c);
          return {
            x: num(k.x),
            advance: num(k.advance),
            run: num(k.run, -1),
            renderedStart: num(k.rendered_start),
            renderedEnd: num(k.rendered_end),
            sourceStart: num(k.source_start),
            sourceEnd: num(k.source_end),
            rtl: k.rtl === true,
            synthetic: k.synthetic === true,
          };
        }),
      };
    }),
  };
}

export function parseFonts(res: Json): FontsInfo {
  checked(res);
  return {
    requests: arr(res.requests).map((r, i) => {
      const o = obj(r);
      const style = str(o.style) ?? "normal";
      return {
        id: num(o.font, i),
        family: str(o.family) ?? "",
        style,
        italic: style === "italic" || style === "oblique",
        weight: num(o.weight, 400),
        face: str(o.face),
        faceIndex: num(o.face_index, 0),
        resolvedFamily: str(o.resolved_family),
        substituted: o.substituted === true,
        embedded: o.embedded === true,
      };
    }),
    faces: arr(res.faces).map((f): FaceInfo => {
      const o = obj(f);
      const b = o.bundled == null ? null : obj(o.bundled);
      return {
        face: str(o.face) ?? "",
        family: str(o.family) ?? "",
        mime: str(o.mime) ?? "",
        bytes: num(o.bytes),
        embeddedInDocument: o.embedded_in_document === true,
        bundled: b && {
          family: str(b.family) ?? "",
          file: str(b.file) ?? "",
          version: str(b.version) ?? "",
          license: str(b.license) ?? "",
          licenseFile: str(b.license_file) ?? "",
          upstreamUrl: str(b.upstream_url) ?? "",
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// display_list
// ---------------------------------------------------------------------------

/** Build the renderer's page model from a `display_list` response. */
export function parseDisplayList(res: Json): DisplayList {
  checked(res);
  const ir = obj(res.ir);
  const size = obj(ir.size);
  const unknown: Record<string, number> = {};
  const note = (what: string) => {
    unknown[what] = (unknown[what] ?? 0) + 1;
  };
  const abiRuns = arr(res.runs).map(obj);
  const runs: TextRun[] = [];
  const ctx: Ctx = { note, abiRuns, runs };
  const ops = parseOps(arr(ir.ops), IDENTITY, ctx, false);

  const fonts: FontRef[] = arr(res.fonts).map((f, i) => {
    const o = obj(f);
    const style = str(o.style) ?? "normal";
    return {
      id: num(o.id, i),
      family: str(o.family) ?? "",
      weight: num(o.weight, 400),
      italic: style === "italic" || style === "oblique",
      unitsPerEm: o.units_per_em == null ? null : num(o.units_per_em),
      embedded: o.embedded === true,
      face: str(o.face),
      faceIndex: num(o.face_index, 0),
      resolvedFamily: str(o.resolved_family),
      substituted: o.substituted === true,
    };
  });
  // Ops name images by IR image-table id; an entry without one cannot be matched (no positional fallback).
  const images: ImageRef[] = [];
  for (const m of arr(res.images)) {
    const o = obj(m);
    if (typeof o.id !== "number") {
      note("images[] entry without id");
      continue;
    }
    images.push({
      id: o.id,
      handle: str(o.image),
      mime: str(o.mime),
      width: o.width == null ? null : num(o.width),
      height: o.height == null ? null : num(o.height),
    });
  }
  const objects: Record<string, ObjectText> = {};
  for (const [k, v] of Object.entries(obj(res.objects))) {
    if (typeof v === "string") objects[k] = { text: v, rendered: v, sourceText: true };
    else {
      const o = obj(v);
      const rendered = str(o.rendered) ?? str(o.text) ?? "";
      objects[k] = { text: str(o.text) ?? rendered, rendered, sourceText: o.source_text !== false };
    }
  }
  const regions = arr(res.regions).map((r) => {
    const o = obj(r);
    return { objectId: str(o.object_id) ?? "", bbox: boxArr(o.bbox) };
  });
  const links: Link[] = [];
  for (const a of arr(ir.annotations)) {
    const [kind, body] = variant(a);
    if (kind === "link") {
      const b = obj(body);
      links.push({ rect: rectObj(b.rect), uri: str(obj(b.target).uri) });
    } else note(`annotation.${kind}`);
  }
  return {
    page: num(res.page, 1),
    width: num(size.width),
    height: num(size.height),
    label: str(ir.label),
    ops,
    runs,
    fonts,
    images,
    objects,
    regions,
    links,
    unknown,
  };
}

type Ctx = { note: (what: string) => void; abiRuns: Json[]; runs: TextRun[] };

function parseOps(list: unknown[], ctm: Mat, ctx: Ctx, clipOnly: boolean): Op[] {
  const out: Op[] = [];
  for (const raw of list) {
    const [kind, body] = variant(raw);
    const b = obj(body);
    switch (kind) {
      case "fill":
        out.push({
          kind: "fill",
          path: parsePath(b.path, ctx),
          evenOdd: b.fill_rule === "even_odd",
          paint: parsePaint(b.paint, ctx),
        });
        break;
      case "stroke":
        out.push({
          kind: "stroke",
          path: parsePath(b.path, ctx),
          style: parseStrokeStyle(b.style),
          paint: parsePaint(b.paint, ctx),
        });
        break;
      case "glyph_run":
        out.push({ kind: "text", run: parseRun(b, ctm, ctx, clipOnly) });
        break;
      case "image":
        out.push({ kind: "image", image: num(b.image), rect: rectObj(b.rect) });
        break;
      case "group":
        out.push(parseGroup(b, ctm, ctx));
        break;
      default:
        ctx.note(`op.${kind}`);
        out.push({ kind: "unknown", name: kind });
    }
  }
  return out;
}

function parseGroup(b: Json, parentCtm: Mat, ctx: Ctx): GroupOp {
  const t = obj(b.transform);
  const transform: Mat = [num(t.a, 1), num(t.b), num(t.c), num(t.d, 1), num(t.e), num(t.f)];
  const ctm = mul(parentCtm, transform);
  let clip: Clip | null = null;
  if (b.clip != null) {
    const [ck, cb] = variant(b.clip);
    const c = obj(cb);
    if (ck === "path") clip = { kind: "path", path: parsePath(c.path, ctx), evenOdd: c.fill_rule === "even_odd" };
    else if (ck === "text") clip = { kind: "text", runs: arr(c.runs).map((r) => parseRun(obj(r), ctm, ctx, true)) };
    else ctx.note(`clip.${ck}`);
  }
  let softMask: SoftMask | null = null;
  if (b.soft_mask != null) {
    const m = obj(b.soft_mask);
    const backdrop = m.backdrop == null ? null : css(obj(obj(m.backdrop).color));
    softMask = {
      luminosity: m.kind === "luminosity",
      group: parseGroup(obj(m.group), ctm, ctx),
      backdrop,
      transfer: m.transfer != null,
    };
  }
  const blendRaw = str(b.blend_mode) ?? "normal";
  return {
    kind: "group",
    transform,
    identity:
      transform[0] === 1 &&
      transform[1] === 0 &&
      transform[2] === 0 &&
      transform[3] === 1 &&
      transform[4] === 0 &&
      transform[5] === 0,
    clip,
    opacity: num(b.opacity, 1),
    blend: blendRaw.replace(/_/g, "-") as BlendMode,
    isolated: b.isolated === true,
    knockout: b.knockout === true,
    softMask,
    blendSpace: b.blend_space != null,
    ops: parseOps(arr(b.ops), ctm, ctx, false),
  };
}

function parseRun(b: Json, ctm: Mat, ctx: Ctx, clipOnly: boolean): TextRun {
  const origin = obj(b.origin);
  const text = str(b.text) ?? "";
  const size = num(b.size);
  let glyphs: Glyphs | null = null;
  const shaping = b.shaping;
  const [sk, sb] = variant(shaping);
  if (sk === "shaped") {
    const s = obj(sb);
    const offsets = arr(s.offsets).map(obj);
    glyphs = {
      ids: arr(s.glyph_ids).map((v) => num(v)),
      advances: arr(s.advances).map((v) => num(v)),
      dx: offsets.map((o) => num(o.x)),
      dy: offsets.map((o) => num(o.y)),
      clusters: arr(s.clusters).map((v) => num(v)),
      shapedByHost: false,
    };
  } else if (sk !== "pending") ctx.note(`shaping.${sk}`);
  const strokeRaw = b.stroke == null ? null : obj(b.stroke);
  const index = clipOnly ? -1 : ctx.runs.length;
  const abi = clipOnly ? {} : (ctx.abiRuns[index] ?? {});
  if (glyphs && (abi.shaped_by === "reactor" || b.shaped_by === "reactor")) glyphs.shapedByHost = true;
  const run: TextRun = {
    index,
    engineRun: num(abi.run, -1),
    font: num(b.font),
    size,
    x: num(origin.x),
    y: num(origin.y),
    vertical: b.writing_mode === "vertical",
    text,
    glyphs,
    mode: (str(b.mode) ?? "fill") as TextMode,
    fill: b.fill == null ? null : parsePaint(b.fill, ctx),
    stroke: strokeRaw ? { paint: parsePaint(strokeRaw.paint, ctx), style: parseStrokeStyle(strokeRaw.style) } : null,
    objectId: str(b.object_id) ?? str(abi.object_id),
    objectOffset: num(b.object_offset ?? abi.object_offset),
    ctm,
    charX: [],
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    approximate: false,
  };
  const abiCtm = arr(abi.transform);
  if (abiCtm.length === 6) run.ctm = abiCtm.map((v) => num(v)) as Mat;
  const charX = arr(abi.char_x);
  if (charX.length > 0) {
    run.charX = charX.map((v) => num(v));
    run.approximate = abi.approximate === true;
  } else {
    [run.charX, run.approximate] = computeCharX(run);
  }
  run.bbox = abi.bbox != null ? boxArr(abi.bbox) : estimateBox(run);
  if (!clipOnly) ctx.runs.push(run);
  return run;
}

/** Character boundaries from glyph advances when the ABI sends none. */
function computeCharX(run: TextRun): [number[], boolean] {
  const chars = Array.from(run.text);
  const g = run.glyphs;
  if (!g || run.vertical) {
    // Unshaped: an even split of 0.5 em per character, flagged approximate.
    return [chars.map((_, i) => run.x + i * run.size * 0.5).concat(run.x + chars.length * run.size * 0.5), true];
  }
  // Byte offset of every character.
  const byteAt: number[] = [];
  let b = 0;
  for (const ch of chars) {
    byteAt.push(b);
    const cp = ch.codePointAt(0)!;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  // Pen x where each cluster starts and its total advance.
  const start = new Map<number, number>();
  const adv = new Map<number, number>();
  let pen = run.x;
  for (let i = 0; i < g.ids.length; i++) {
    const c = g.clusters[i];
    if (!start.has(c)) start.set(c, pen);
    adv.set(c, (adv.get(c) ?? 0) + g.advances[i]);
    pen += g.advances[i];
  }
  const xs: number[] = [];
  let approximate = false;
  let i = 0;
  while (i < chars.length) {
    const c = byteAt[i];
    let j = i + 1;
    while (j < chars.length && !start.has(byteAt[j])) j++;
    const x0 = start.get(c) ?? (xs.length ? xs[xs.length - 1] : run.x);
    const w = adv.get(c) ?? 0;
    if (j - i > 1) approximate = true;
    for (let k = i; k < j; k++) xs.push(x0 + (w * (k - i)) / (j - i));
    i = j;
  }
  xs.push(pen);
  return [xs, approximate];
}

function estimateBox(run: TextRun): Rect {
  const x0 = run.charX[0] ?? run.x;
  const x1 = run.charX[run.charX.length - 1] ?? run.x;
  return transformRect(run.ctm, { x: x0, y: run.y - run.size * 0.8, w: x1 - x0, h: run.size });
}

function parsePath(raw: unknown, ctx: Ctx): PathData {
  const cmds: number[] = [];
  const pts: number[] = [];
  for (const seg of arr(raw)) {
    if (seg === "close") {
      cmds.push(4);
      continue;
    }
    const [k, v] = variant(seg);
    const o = obj(v);
    switch (k) {
      case "move_to":
        cmds.push(0);
        pts.push(num(o.x), num(o.y));
        break;
      case "line_to":
        cmds.push(1);
        pts.push(num(o.x), num(o.y));
        break;
      case "quad_to": {
        const c = obj(o.ctrl);
        const t = obj(o.to);
        cmds.push(2);
        pts.push(num(c.x), num(c.y), num(t.x), num(t.y));
        break;
      }
      case "cubic_to": {
        const c1 = obj(o.ctrl1);
        const c2 = obj(o.ctrl2);
        const t = obj(o.to);
        cmds.push(3);
        pts.push(num(c1.x), num(c1.y), num(c2.x), num(c2.y), num(t.x), num(t.y));
        break;
      }
      case "close":
        cmds.push(4);
        break;
      default:
        ctx.note(`path.${k}`);
    }
  }
  return { cmds, pts };
}

function parsePaint(raw: unknown, ctx: Ctx): Paint {
  const [k, v] = variant(raw);
  const o = obj(v);
  switch (k) {
    case "solid": {
      const a = num(o.a, 255);
      return { kind: "solid", color: css(o), transparent: a === 0 };
    }
    case "color": {
      // A declared color space with an sRGB fallback; canvas paints the fallback.
      ctx.note("paint.color (sRGB fallback painted)");
      const fb = obj(o.fallback);
      return { kind: "solid", color: css(fb), transparent: num(fb.a, 255) === 0 };
    }
    case "linear_gradient": {
      const s = obj(o.start);
      const e = obj(o.end);
      return {
        kind: "linear",
        x0: num(s.x),
        y0: num(s.y),
        x1: num(e.x),
        y1: num(e.y),
        stops: stops(o.stops),
        extend: extend(o.extend),
        space: o.interpolation_space != null,
      };
    }
    case "radial_gradient": {
      const s = obj(o.start_center);
      const e = obj(o.end_center);
      return {
        kind: "radial",
        x0: num(s.x),
        y0: num(s.y),
        r0: num(o.start_radius),
        x1: num(e.x),
        y1: num(e.y),
        r1: num(o.end_radius),
        stops: stops(o.stops),
        extend: extend(o.extend),
        space: o.interpolation_space != null,
      };
    }
    case "image":
      return { kind: "image", image: num(o.image), rect: rectObj(o.rect), extend: extend(o.extend) };
    default:
      ctx.note(`paint.${k}`);
      return { kind: "unsupported", what: k };
  }
}

function stops(raw: unknown) {
  return arr(raw).map((s) => {
    const o = obj(s);
    return { offset: num(o.offset), color: css(obj(o.color)) };
  });
}

function extend(raw: unknown): Extend {
  return raw === "repeat" || raw === "reflect" ? raw : "pad";
}

function parseStrokeStyle(raw: unknown): StrokeStyle {
  const o = obj(raw);
  const dash = o.dash == null ? null : obj(o.dash);
  return {
    width: o.width === "hairline" ? null : num(o.width, 1),
    cap: (str(o.cap) ?? "butt") as CanvasLineCap,
    join: (str(o.join) ?? "miter") as CanvasLineJoin,
    miterLimit: num(o.miter_limit, 10),
    dash: dash ? arr(dash.array).map((v) => num(v)) : null,
    dashPhase: dash ? num(dash.phase) : 0,
  };
}

function css(o: Json): string {
  const a = num(o.a, 255);
  return a === 255
    ? `rgb(${num(o.r)},${num(o.g)},${num(o.b)})`
    : `rgba(${num(o.r)},${num(o.g)},${num(o.b)},${a / 255})`;
}

function rectObj(raw: unknown): Rect {
  const o = obj(raw);
  return { x: num(o.x), y: num(o.y), w: num(o.width), h: num(o.height) };
}

function boxArr(raw: unknown): Rect {
  const a = arr(raw);
  return { x: num(a[0]), y: num(a[1]), w: num(a[2]), h: num(a[3]) };
}

// ---------------------------------------------------------------------------
// Matrix helpers shared with the renderer
// ---------------------------------------------------------------------------

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** `p` then `q` applied first: result maps x to p(q(x)). */
export function mul(p: Mat, q: Mat): Mat {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function transformRect(m: Mat, r: Rect): Rect {
  const xs = [r.x, r.x + r.w];
  const ys = [r.y, r.y + r.h];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const x of xs)
    for (const y of ys) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------
// JSON access
// ---------------------------------------------------------------------------

function obj(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw new ReactorError("bad-response", "expected a binary output buffer");
}
/** IR externally tagged enum: `{kind: body}` or a bare `"kind"` string. */
function variant(v: unknown): [string, unknown] {
  if (typeof v === "string") return [v, null];
  const o = obj(v);
  const keys = Object.keys(o);
  return keys.length === 1 ? [keys[0], o[keys[0]]] : ["?", null];
}
