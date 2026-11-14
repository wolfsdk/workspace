/**
 * The renderer's own page model. `abi.ts` builds it from the reactor's `display_list`
 * response; nothing else in this package reads reactor or WolfRender IR field names.
 * Geometry is in points, top-left origin, +y down (the IR's page user space).
 */

/** Affine matrix `[a, b, c, d, e, f]`: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = [number, number, number, number, number, number];

export type Rect = { x: number; y: number; w: number; h: number };

/** Path commands: 0 move (x y), 1 line (x y), 2 quad (cx cy x y), 3 cubic (c1 c2 x y), 4 close. */
export type PathData = { cmds: number[]; pts: number[] };

export type Extend = "pad" | "repeat" | "reflect";

export type GradientStop = { offset: number; color: string };

export type Paint =
  | { kind: "solid"; color: string; transparent: boolean }
  | {
      kind: "linear";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      stops: GradientStop[];
      extend: Extend;
      space: boolean;
    }
  | {
      kind: "radial";
      x0: number;
      y0: number;
      r0: number;
      x1: number;
      y1: number;
      r1: number;
      stops: GradientStop[];
      extend: Extend;
      space: boolean;
    }
  | { kind: "image"; image: number; rect: Rect; extend: Extend }
  | { kind: "unsupported"; what: string };

export type StrokeStyle = {
  /** User-space width, or `null` for a hairline (one device pixel). */
  width: number | null;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miterLimit: number;
  dash: number[] | null;
  dashPhase: number;
};

/** Shaped glyphs, parallel arrays in visual order (IR `ShapedGlyphs`). */
export type Glyphs = {
  ids: number[];
  advances: number[];
  dx: number[];
  dy: number[];
  /** UTF-8 byte offset in `text` of the cluster that produced each glyph. */
  clusters: number[];
  /** True when the reactor shaped a run the IR left pending. */
  shapedByHost: boolean;
};

export type TextMode =
  "fill" | "stroke" | "fill_stroke" | "invisible" | "fill_clip" | "stroke_clip" | "fill_stroke_clip" | "clip";

export type TextRun = {
  /** Position in paint order on this page (index into `DisplayList.runs`). */
  index: number;
  /** The reactor's document-wide run number (`hit_test.run`), or -1. */
  engineRun: number;
  font: number;
  size: number;
  x: number;
  y: number;
  vertical: boolean;
  text: string;
  /** `null` when the IR left the run unshaped. */
  glyphs: Glyphs | null;
  mode: TextMode;
  fill: Paint | null;
  stroke: { paint: Paint; style: StrokeStyle } | null;
  objectId: string | null;
  /** Unicode-scalar offset of the run's first character in its object's rendered text. */
  objectOffset: number;
  /** Run space to page space. */
  ctm: Mat;
  /** Caret x per character boundary in run space (`chars + 1` entries). */
  charX: number[];
  /** Page-space bounding box. */
  bbox: Rect;
  /** True when `charX` was interpolated rather than taken from glyph positions. */
  approximate: boolean;
};

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type Clip = { kind: "path"; path: PathData; evenOdd: boolean } | { kind: "text"; runs: TextRun[] };

export type SoftMask = { luminosity: boolean; group: GroupOp; backdrop: string | null; transfer: boolean };

export type FillOp = { kind: "fill"; path: PathData; evenOdd: boolean; paint: Paint };
export type StrokeOp = { kind: "stroke"; path: PathData; style: StrokeStyle; paint: Paint };
export type TextOp = { kind: "text"; run: TextRun };
export type ImageOp = { kind: "image"; image: number; rect: Rect };
export type GroupOp = {
  kind: "group";
  transform: Mat;
  identity: boolean;
  clip: Clip | null;
  opacity: number;
  blend: BlendMode;
  isolated: boolean;
  knockout: boolean;
  softMask: SoftMask | null;
  /** Declared non-sRGB blending space (painted in sRGB). */
  blendSpace: boolean;
  ops: Op[];
};
export type UnknownOp = { kind: "unknown"; name: string };
export type Op = FillOp | StrokeOp | TextOp | ImageOp | GroupOp | UnknownOp;

export type FontRef = {
  id: number;
  /** Requested family (as the document names it). */
  family: string;
  weight: number;
  italic: boolean;
  unitsPerEm: number | null;
  embedded: boolean;
  /** Content handle of the face the engine resolved (sha256 hex), when the ABI provides it. */
  face: string | null;
  faceIndex: number;
  /** Family of the face actually used (e.g. Carlito for Calibri), when the ABI provides it. */
  resolvedFamily: string | null;
  /** The engine served another family than the document asked for. */
  substituted: boolean;
};

export type ImageRef = {
  id: number;
  handle: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
};

export type Link = { rect: Rect; uri: string | null };

export type DisplayList = {
  page: number;
  width: number;
  height: number;
  label: string | null;
  ops: Op[];
  /** Every painted glyph run in paint order (clip-only text runs excluded). */
  runs: TextRun[];
  fonts: FontRef[];
  images: ImageRef[];
  /** Source and rendered text per object id. */
  objects: Record<string, ObjectText>;
  /** Object boxes in document order. */
  regions: { objectId: string; bbox: Rect }[];
  links: Link[];
  /** IR op kinds or variants this model does not represent, with counts. */
  unknown: Record<string, number>;
};

/** `text` is the model node's source text (what offsets index); `rendered` what is painted. */
export type ObjectText = { text: string; rendered: string; sourceText: boolean };

/** One shaped cluster of a `text_layout` line; x and advance in the line's run space. */
export type Cluster = {
  x: number;
  advance: number;
  /** Engine run index (`TextRun.engineRun`). */
  run: number;
  renderedStart: number;
  renderedEnd: number;
  /** Source UTF-16 range; empty for synthetic clusters (labels, bullets, field results). */
  sourceStart: number;
  sourceEnd: number;
  rtl: boolean;
  synthetic: boolean;
};

export type TextLine = {
  page: number;
  /** Run space to page points. */
  ctm: Mat;
  /** Page points. */
  box: Rect;
  /** Run space. */
  baseline: number;
  ascent: number;
  descent: number;
  approximate: boolean;
  clusters: Cluster[];
};

/** The engine's text geometry of one object (`text_layout`), all pages. */
export type TextLayout = { objectId: string; length: number; lines: TextLine[] };

/** Licence entry of a face compiled into the module (WolfRender's font manifest). */
export type BundledFace = {
  family: string;
  file: string;
  version: string;
  license: string;
  licenseFile: string;
  upstreamUrl: string;
};

export type FaceInfo = {
  face: string;
  family: string;
  mime: string;
  bytes: number;
  embeddedInDocument: boolean;
  /** Null for faces the document carried. */
  bundled: BundledFace | null;
};

/** One font request of the `fonts` command; shaped like `FontSpec` so `ResourceCache.loadFonts` takes it. */
export type FontRequest = {
  /** The document font id (`font`), the same ids as `display_list.fonts[].id`. */
  id: number;
  family: string;
  style: string;
  italic: boolean;
  weight: number;
  face: string | null;
  faceIndex: number;
  resolvedFamily: string | null;
  substituted: boolean;
  embedded: boolean;
};

/** The `fonts` command: every font request of the document and the face that served it. */
export type FontsInfo = { requests: FontRequest[]; faces: FaceInfo[] };
