/**
 * Reactor kernel capabilities (types only, plus one type guard).
 *
 * A reactor kernel (`@wolfsdk/runtime/client`) implements the frozen
 * `KernelClient` over `wolf_web.wasm`, a long-lived engine instance
 * that keeps documents and their layout in memory. On top of the contract
 * it exposes the layout the engine holds: a vector display list per page
 * (with font and image resources), hit testing, caret geometry, per-cluster
 * text layout and a cell viewport for sheets. Shapes follow
 * `docs/wolf-web-reactor-abi.md` (real responses); engine members keep their
 * snake_case names and pass through untouched. Every IR type is open (index
 * signature) so a newer module adding members or op kinds still compiles.
 *
 * Text offsets (`HitTest.offset`, `caretRects` `start`/`end`, text layout
 * `source_start`/`source_end`) are UTF-16 code-unit offsets into the
 * object's source text (the view node's `text`), so they index a JavaScript
 * string and a `set` op directly.
 *
 * Every call reads the document's **current revision** (the cursor of
 * `undo`/`redo`/`goto`). Rejections are `KernelRequestError`s with the codes
 * of `KernelError` plus the module's own (`unsupported`, `bad-range`,
 * `unknown-object`, `unknown-resource`, `invalid-input`, `render-failed`,
 * `bad-determinism` for a clock, time zone, locale or seed the engine does
 * not accept); a page outside the laid-out document is `page-unknown`, a
 * malformed request is `usage`, and a command this module build lacks is
 * `unsupported`.
 */
import type { Address, DocId, KernelClient, Timings } from "./contract.ts";

/** `[x, y, width, height]` in page points, top-left origin. */
export type RectPt = [number, number, number, number];

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ReactorKernelClient extends KernelClient {
  /** Discriminant read by `isReactorKernel`. */
  readonly kind: "reactor";

  /** WolfRender IR of one page plus its text runs tagged with the view
   * node they came from, fonts and images with resource handles
   * (`display_list`). XLSX: its printed pages. */
  displayList(doc: DocId, page: number): Promise<DisplayList>;

  /** Lay the document out (cached until the next edit) and summarise it
   * (`layout`). */
  layoutInfo(doc: DocId): Promise<LayoutInfo>;

  /** The object and source offset under a page point (`hit_test`). A miss
   * resolves with `object_id: null`. */
  hitTest(doc: DocId, page: number, xPt: number, yPt: number): Promise<HitTest>;

  /** Caret (`start == end`) or selection rectangles for a source range of
   * one object (`caret_rects`). `end` defaults to `start`. */
  caretRects(doc: DocId, objectId: Address, start: number, end?: number): Promise<CaretRects>;

  /** Lines and clusters of one object's text with source ranges
   * (`text_layout`). */
  textLayout(doc: DocId, objectId: Address): Promise<TextLayout>;

  /** Every font request of the laid-out document and the face serving it,
   * with licence data for bundled faces (`fonts`). */
  fonts(doc: DocId): Promise<FontReport>;

  /** Bytes of a resource by handle: a font face or image by its sha256
   * (from `displayList` or `fonts`), or a bundled face's `license_file`
   * path (`kind: "license"`, `text/plain; charset=utf-8`; module builds
   * without licence files reject it with `unknown-resource`). Passed through
   * unchanged; an unknown handle rejects with `unknown-resource`. */
  resource(handle: string): Promise<Resource>;

  /** A window of one sheet: cells with value, formula, display string and
   * style, column widths, row heights, merges, resolved styles
   * (`sheet_viewport`). XLSX only. `sheet` is a name or a 1-based index;
   * `row0`/`col0` are 1-based. */
  sheetViewport(
    doc: DocId,
    sheet: string | number,
    row0: number,
    col0: number,
    rows: number,
    cols: number,
  ): Promise<SheetViewport>;
}

export function isReactorKernel(kernel: KernelClient): kernel is ReactorKernelClient {
  const k = kernel as Partial<ReactorKernelClient>;
  return k.kind === "reactor" && typeof k.displayList === "function" && typeof k.sheetViewport === "function";
}

/** Members every reactor result carries besides the engine's own. */
type ReactorResult = {
  /** Cost of the call (one engine run per reactor command, plus a document
   * re-open when the revision's in-memory copy was evicted). */
  timings: Timings;
};

/** Members of every document-scoped result: the revision it was read from,
 * named as `DocState` names it (`DocState.revision`, `DocState.sha256`).
 * The module's own per-handle `revision` counter is not reported: the
 * kernel holds each revision in its own module handle, so that counter is
 * 0 or 1 whatever the document's history. */
type DocResult = ReactorResult & {
  /** `DocState.revision` (cursor index) of the revision read. */
  revision: number;
  /** `DocState.sha256` of the revision read. */
  sha256: string;
};

/** Clock, zone, locale and seed a layout or run used. */
export type Determinism = { clock: string; timezone: string; locale: string; seed: number; [member: string]: unknown };

// ---------------------------------------------------------------------------
// Layout and display list
// ---------------------------------------------------------------------------

export type LayoutInfo = DocResult & {
  /** The layout was already held (no relayout in this call). */
  cached: boolean;
  layout_ms: number;
  summary: {
    format: string;
    pages: number;
    runs: number;
    tagged_runs: number;
    regions: number;
    objects: number;
    fonts: number;
    images: number;
    determinism: Determinism;
    [member: string]: unknown;
  };
  /** One hash per page; a page whose hash is unchanged after an edit
   * paints the same. */
  page_hashes: string[];
  [member: string]: unknown;
};

export type DisplayList = DocResult & {
  page: number;
  /** WolfRender IR page. */
  ir: IrPage;
  /** The IR's font table, indexed by `glyph_run.font` / `TextRun.font`. */
  fonts: IrFont[];
  /** The images this page draws. Match `IrImageOp.image.image` against
   * `IrImage.id` (the IR image-table index), not the array position. */
  images: IrImage[];
  /** Text runs in paint order with caret boundaries. */
  runs: TextRun[];
  /** Every object painted on this page. */
  objects: Record<Address, DisplayObject>;
  /** Object boxes on this page; XLSX cells add `sheet` and `a1`. */
  regions: { object_id: Address; bbox: RectPt; sheet?: string; a1?: string; [member: string]: unknown }[];
  page_hash: string;
  layout_cached: boolean;
  [member: string]: unknown;
};

export type DisplayObject = {
  /** Source text (the view node's `text`), or `rendered` when the node has
   * none (`source_text: false`). */
  text: string;
  /** Text as painted (list labels, field results; no tabs). */
  rendered: string;
  source_text: boolean;
  [member: string]: unknown;
};

export type IrPage = {
  size: { width: number; height: number };
  label: string | null;
  annotations: unknown[];
  ops: IrOp[];
  [member: string]: unknown;
};

/** One IR op: an object with exactly one member naming its kind. Known
 * kinds are typed; any other kind still type-checks as `IrOtherOp`. */
export type IrOp = IrGroupOp | IrFillOp | IrStrokeOp | IrImageOp | IrGlyphRunOp | IrOtherOp;

export type IrGroupOp = {
  group: {
    ops: IrOp[];
    opacity: number;
    blend_mode: string;
    blend_space: unknown;
    clip: unknown;
    isolated: boolean;
    knockout: boolean;
    [member: string]: unknown;
  };
};
export type IrFillOp = {
  fill: { path: IrPathSegment[]; paint: IrPaint; fill_rule: string; [member: string]: unknown };
};
export type IrStrokeOp = {
  stroke: {
    path: IrPathSegment[];
    paint: IrPaint;
    style: { width: number; cap: string; join: string; miter_limit: number; dash: unknown; [member: string]: unknown };
    [member: string]: unknown;
  };
};
export type IrImageOp = {
  image: { image: number; rect: { x: number; y: number; width: number; height: number }; [member: string]: unknown };
};
export type IrGlyphRunOp = {
  glyph_run: {
    font: number;
    mode: string;
    fill: IrPaint;
    origin: { x: number; y: number };
    shaping: Record<string, unknown>;
    /** View node address the run belongs to (`para:~…`, `slide:#256/shape:#2`, `sheet:#1/cell:A1`). */
    object_id: Address | null;
    /** Offset of the run's first character in the object's rendered text. */
    object_offset: number;
    [member: string]: unknown;
  };
};
export type IrOtherOp = { [kind: string]: unknown };

/** `{"move_to": {x, y}}`, `{"line_to": …}`, `{"cubic_to": …}`, `"close"`, … */
export type IrPathSegment = string | { [kind: string]: unknown };
/** `{"solid": {r, g, b, a}}` or another paint kind. */
export type IrPaint = { solid?: { r: number; g: number; b: number; a: number }; [kind: string]: unknown };

export type IrFont = {
  id: number;
  /** What the document asked for. */
  family: string;
  style: string;
  weight: number;
  units_per_em: number;
  /** sha256 resource handle of the face bytes (`resource`). */
  face: string;
  /** Index inside a font collection. */
  face_index: number;
  /** The face actually used; `substituted` when it differs from `family`. */
  resolved_family: string;
  substituted: boolean;
  /** The document carried the face (bundled faces: false, as
   * `FontReport.faces[].embedded_in_document`). */
  embedded: boolean;
  [member: string]: unknown;
};

export type IrImage = {
  id: number;
  /** sha256 resource handle (`resource`). */
  image: string;
  mime: string;
  width: number;
  height: number;
  [member: string]: unknown;
};

export type TextRun = {
  run: number;
  object_id: Address | null;
  object_offset: number;
  text: string;
  font: number;
  size: number;
  bbox: RectPt;
  /** Run CTM `[a b c d e f]` (XLSX scales CSS pixels to points). */
  transform: [number, number, number, number, number, number];
  /** Pen origin in page points. */
  origin: [number, number];
  /** Caret x per rendered character boundary in run space (`chars + 1` entries). */
  char_x: number[];
  /** Boundaries were interpolated. */
  approximate: boolean;
  [member: string]: unknown;
};

// ---------------------------------------------------------------------------
// Fonts and resources
// ---------------------------------------------------------------------------

export type FontReport = DocResult & {
  format: string;
  requests: {
    font: number;
    family: string;
    style: string;
    weight: number;
    reference: string;
    /** `null` when no face serves the request. */
    face: string | null;
    face_index: number;
    resolved_family: string | null;
    substituted: boolean;
    embedded: boolean;
    [member: string]: unknown;
  }[];
  faces: {
    face: string;
    family: string;
    mime: string;
    bytes: number;
    embedded_in_document: boolean;
    /** WolfRender manifest entry for a face compiled into the module; ship
     * `license_file` with any face bytes served to users. */
    bundled: {
      family: string;
      file: string;
      version: string;
      license: string;
      license_file: string;
      upstream_url: string;
    } | null;
    [member: string]: unknown;
  }[];
  [member: string]: unknown;
};

export type Resource = ReactorResult & {
  handle: string;
  /** `font`, `image`, `license` (a bundled face's licence text), or
   * another kind a later module serves. */
  kind: string;
  mime: string;
  bytes: Uint8Array<ArrayBuffer>;
  [member: string]: unknown;
};

// ---------------------------------------------------------------------------
// Hit testing, carets, text layout
// ---------------------------------------------------------------------------

export type HitTest = DocResult & {
  page: number;
  /** Object under the point, `null` on a miss. */
  object_id: Address | null;
  /** Source UTF-16 offset in the object's text. */
  offset: number | null;
  /** Unicode scalar offset in the object's rendered text. */
  rendered_offset?: number | null;
  /** The point is on painted text with no source (list label, bullet,
   * field result); `offset` is the neighbouring source offset. */
  synthetic?: boolean;
  inside_text: boolean;
  run?: number;
  run_offset?: number;
  caret?: RectPt;
  /** XLSX: the cell under the point. */
  sheet?: string;
  a1?: string;
  [member: string]: unknown;
};

export type CaretRects = DocResult & {
  object_id: Address;
  start: number;
  end: number;
  /** Source UTF-16 length of the object's text. */
  length: number;
  /** One zero-width caret when `start == end`; one rect per line/run
   * otherwise. */
  rects: { page: number; x: number; y: number; w: number; h: number; [member: string]: unknown }[];
  [member: string]: unknown;
};

export type TextLayout = DocResult & {
  object_id: Address;
  /** Source UTF-16 length. */
  length: number;
  /** One line per (object, run) line on a page. */
  lines: TextLine[];
  [member: string]: unknown;
};

export type TextLine = {
  page: number;
  transform: number[];
  box: RectPt;
  baseline: number;
  ascent: number;
  descent: number;
  approximate: boolean;
  clusters: TextCluster[];
  [member: string]: unknown;
};

export type TextCluster = {
  x: number;
  advance: number;
  run: number;
  rendered_start: number;
  rendered_end: number;
  /** Empty (`start == end`) for synthetic clusters. */
  source_start: number;
  source_end: number;
  rtl: boolean;
  synthetic: boolean;
  [member: string]: unknown;
};

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export type SheetViewport = DocResult & {
  /** Resolved sheet name. */
  sheet: string;
  sheets: {
    index: number;
    name: string;
    dimension: string | null;
    used: number[] | null;
    used_range: string | null;
    [member: string]: unknown;
  }[];
  used_range: string | null;
  row0: number;
  col0: number;
  rows: number;
  cols: number;
  /** Pixel offset of the window's top-left cell from A1. */
  x0_px: number;
  y0_px: number;
  freeze: { top_left_cell: string; [member: string]: unknown } | null;
  show_grid_lines: boolean;
  hidden_rows: number[];
  hidden_cols: number[];
  /** Merged ranges intersecting the window. */
  merged: unknown[];
  default_font: { name: string; size_pt: number; max_digit_width_px: number; [member: string]: unknown };
  default_col_width_px: number;
  default_row_height_pt: number;
  /** Non-empty cells in the window. */
  cells: SheetCell[];
  columns: {
    col: number;
    letter: string;
    width_chars: number;
    width_px: number;
    hidden: boolean;
    custom: boolean;
    style_id: number | null;
    [member: string]: unknown;
  }[];
  row_heights: {
    row: number;
    height_pt: number;
    height_px: number;
    hidden: boolean;
    custom: boolean;
    [member: string]: unknown;
  }[];
  /** Resolved styles by `style_id` (theme colours and tints as `#rrggbb`). */
  styles: Record<
    string,
    {
      font: unknown;
      fill: unknown;
      border: unknown;
      alignment: unknown;
      number_format: string;
      [member: string]: unknown;
    }
  >;
  [member: string]: unknown;
};

export type SheetCell = {
  a1: string;
  row: number;
  col: number;
  /** Typed value (`{"number": 1}`, `{"string": "x"}`, …). */
  value: Record<string, unknown> | null;
  /** With leading `=`, `null` for a constant. */
  formula: string | null;
  /** Number-format result. */
  display: string;
  /** The cell-width text the renderer paints. */
  display_trimmed: string;
  /** Number-format colour, `null` for none. */
  color: string | null;
  style_id: number | null;
  [member: string]: unknown;
};
