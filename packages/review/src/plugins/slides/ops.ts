/**
 * Every engine operation the slides plugin issues is built here, so op
 * shapes can be corrected in one place when the engine changes.
 *
 * Sources: `docs/ops-pptx.md` (the current module) and
 * `docs/engine-ops-pptx.md` (engine additions: shape `move`/`resize`, z-order
 * `move` with `anchor`, shape `copy` with an absolute `offset`, picture
 * insert, paragraph/run `set` and `delete`, slide `move`). Every member sent
 * is a documented one: the engine refuses unknown members with `usage`.
 * Units: EMU everywhere (12700 per point, 914400 per inch).
 */
import type { Address, KernelError, Op } from "@wolfsdk/protocol";
import { textDiff } from "./textedit.ts";

export const EMU_PER_PT = 12700;
export const EMU_PER_INCH = 914400;
/** Insert placement limits (ops-pptx.md section 2). */
export const MAX_EMU = 51206400;

export type EmuRect = { x: number; y: number; cx: number; cy: number };

/** Operations whose availability depends on the module in use. A refusal
 * classified by `isCapabilityRefusal` disables the capability for the session. */
export type Capability =
  "shape-move" | "shape-resize" | "slide-move" | "paragraph-set" | "shape-order" | "shape-copy" | "picture-insert";

const clampOffset = (v: number) => Math.max(-MAX_EMU, Math.min(MAX_EMU, Math.round(v)));
const clampExtent = (v: number) => Math.max(1, Math.min(MAX_EMU, Math.round(v)));
const clampInsertOffset = (v: number) => Math.max(0, Math.min(MAX_EMU, Math.round(v)));

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Whole text body of a shape or a table cell; `\n` separates paragraphs.
 * Keeps the first run's formatting only (ops-pptx.md, "set"). */
export function setText(target: Address, text: string): Op {
  return { op: "set", target, value: { text } };
}

/** Paragraph-level set (docs/engine-ops-pptx.md, "Set and delete
 * paragraph/run text"): the paragraph's text, `\u000b` for a line break,
 * never `\n` (refused `op-kind-mismatch`). Every run of the paragraph takes
 * its first run's formatting. */
export function setParagraphText(paragraph: Address, text: string): Op {
  return { op: "set", target: paragraph, value: { text } };
}

/** Run-level set: one run's text, keeping its formatting and its
 * neighbours'. No line or paragraph breaks (refused `op-kind-mismatch`). */
export function setRunText(run: Address, text: string): Op {
  return { op: "set", target: run, value: { text } };
}

/** A paragraph's runs in order. A line break (`\u000b`) between runs belongs
 * to no run. */
export type RunText = { address: Address; text: string };

/**
 * The run-level `set`s that turn paragraph text `before` into `after`, so
 * every run keeps its formatting. The inserted text goes to the run the
 * caret is in: a pure insertion on the boundary of two runs to the run
 * before it (typing continues the text to its left), at the paragraph start
 * or after a line break to the run after it; a replacement to the first run
 * it touches, the other runs it touches losing the replaced part (a run
 * emptied this way stays, empty: the engine deletes no runs). `caret` is an
 * offset of `after`. Null when the runs do not spell the paragraph (only
 * line breaks may lie between them) or the edit inserts or removes a line
 * break (no run holds one).
 */
export function runsEdit(runs: RunText[], before: string, after: string, caret?: number): Op[] | null {
  const spans: { run: RunText; start: number; end: number }[] = [];
  let pos = 0;
  for (const run of runs) {
    if (!run.text) continue;
    const at = before.indexOf(run.text, pos);
    if (at < 0 || /[^\u000b]/.test(before.slice(pos, at))) return null;
    spans.push({ run, start: at, end: at + run.text.length });
    pos = at + run.text.length;
  }
  if (!spans.length || /[^\u000b]/.test(before.slice(pos))) return null;
  const d = textDiff(before, after, caret);
  const inserted = after.slice(d.start, d.endAfter);
  if (/[\n\u000b]/.test(inserted) || before.slice(d.start, d.endBefore).includes("\u000b")) return null;
  if (d.start === d.endBefore) {
    const holder =
      spans.find((s) => s.start < d.start && d.start <= s.end) ??
      spans.find((s) => s.start <= d.start && d.start < s.end);
    if (!holder) return null;
    return [
      setRunText(
        holder.run.address,
        before.slice(holder.start, d.start) + inserted + before.slice(d.start, holder.end),
      ),
    ];
  }
  const touched = spans.filter((s) => s.start < d.endBefore && d.start < s.end);
  if (!touched.length) return null;
  const ops: Op[] = [];
  touched.forEach((s, i) => {
    const head = i === 0 ? before.slice(s.start, Math.max(s.start, d.start)) + inserted : "";
    const text = head + before.slice(Math.max(s.start, d.endBefore), s.end);
    if (text !== s.run.text) ops.push(setRunText(s.run.address, text));
  });
  return ops;
}

export function insertParagraph(anchor: Address, position: "before" | "after", text: string): Op {
  return { op: "insert", anchor, position, node: { kind: "paragraph", text } };
}

/** One addressable line of a text body: its paragraph address, or null for a
 * line the view gives no address. */
export type AddressedLine = { address: Address | null; text: string };

/**
 * Paragraph-by-paragraph edit of a text body; untouched paragraphs are not
 * written. Lines are aligned by their common head and tail. A changed
 * paragraph gets `lineEdit(address, before, after, index)` (`index` its
 * line in `next`), a removed one `delete` (`next` is never empty, so one
 * paragraph always remains, as the engine requires), an added line a
 * paragraph insert. Null when a line to change, remove or anchor on has no
 * address.
 */
export function paragraphsEdit(
  lines: AddressedLine[],
  next: string[],
  lineEdit: (address: Address, before: string, after: string, index: number) => Op[],
): Op[] | null {
  const old = lines.map((l) => l.text);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const oldMid = lines.slice(head, lines.length - tail);
  const newMid = next.slice(head, next.length - tail);
  if (oldMid.length === 0 && newMid.length === 0) return [];
  const ops: Op[] = [];
  const paired = Math.min(oldMid.length, newMid.length);
  for (let i = 0; i < paired; i++) {
    const line = oldMid[i]!;
    const text = newMid[i]!;
    if (line.text === text) continue;
    if (!line.address) return null;
    ops.push(...lineEdit(line.address, line.text, text, head + i));
  }
  if (oldMid.length > newMid.length) {
    const removed = oldMid.slice(paired);
    if (removed.some((l) => !l.address)) return null;
    for (const line of removed) ops.push(deleteNode(line.address!));
  } else if (newMid.length > oldMid.length) {
    const extra = newMid.slice(paired);
    // Anchor after the last paired line, else after the line before the
    // changed block, else before the line after it.
    const afterLine = paired > 0 ? oldMid[paired - 1] : head > 0 ? lines[head - 1] : undefined;
    if (afterLine) {
      if (!afterLine.address) return null;
      // Every insert after the same anchor lands right after it: reverse order.
      for (const text of [...extra].reverse()) ops.push(insertParagraph(afterLine.address, "after", text));
    } else {
      const beforeLine = lines[lines.length - tail];
      if (!beforeLine?.address) return null;
      for (const text of extra) ops.push(insertParagraph(beforeLine.address, "before", text));
    }
  }
  return ops;
}

/**
 * The ops that turn a text body's `lines` into `next` (one string per
 * paragraph), writing only what changed so formatting survives: a changed
 * paragraph takes run-level `set`s (`runsEdit`, `caret` an offset of
 * `next.join("\n")` deciding which run takes typed text), else, for a
 * line-break edit or runs that do not spell the paragraph, a paragraph-level
 * `set`; removed paragraphs are deleted and new lines inserted
 * (`paragraphsEdit`). `runsOf` lists a paragraph's runs. `paragraphSets`
 * names the paragraphs that had runs and were set whole (they take their
 * first run's formatting). Null when a line to change has no address.
 */
export function textBodyEdit(
  lines: AddressedLine[],
  next: string[],
  runsOf: (paragraph: Address) => RunText[],
  caret?: number,
): { ops: Op[]; paragraphSets: Address[] } | null {
  const paragraphSets: Address[] = [];
  const ops = paragraphsEdit(lines, next, (address, before, after, index) => {
    const runs = runsOf(address);
    if (runs.length) {
      const start = next.slice(0, index).reduce((n, t) => n + t.length + 1, 0);
      const at = caret !== undefined && caret >= start && caret <= start + after.length ? caret - start : undefined;
      const edit = runsEdit(runs, before, after, at);
      if (edit) return edit;
      paragraphSets.push(address);
    }
    return [setParagraphText(address, after)];
  });
  return ops && { ops, paragraphSets };
}

// ---------------------------------------------------------------------------
// Geometry (pending engine operations)
// ---------------------------------------------------------------------------

/** Shape move (pending in the engine; current module refuses with `usage`). */
export function moveShape(target: Address, x: number, y: number): Op {
  return { op: "move", target, offset: { x_emu: clampOffset(x), y_emu: clampOffset(y) } };
}

/** Shape or table frame resize. Works today on table frames; on ordinary
 * shapes it is pending (current module: `unsupported`). */
export function resizeShape(target: Address, cx: number, cy: number): Op {
  return { op: "resize", target, extent: { cx_emu: clampExtent(cx), cy_emu: clampExtent(cy) } };
}

/** Ops that bring a shape from `from` to `to`, in one batch. */
export function placeShape(target: Address, from: EmuRect, to: EmuRect): Op[] {
  const ops: Op[] = [];
  if (Math.round(from.x) !== Math.round(to.x) || Math.round(from.y) !== Math.round(to.y))
    ops.push(moveShape(target, to.x, to.y));
  if (Math.round(from.cx) !== Math.round(to.cx) || Math.round(from.cy) !== Math.round(to.cy))
    ops.push(resizeShape(target, to.cx, to.cy));
  return ops;
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

export type FontPatch = {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double";
  size?: number;
  color?: string;
  name?: string;
};
export type FormatPatch = {
  fill?: { color: string };
  line?: { color?: string; width?: number };
  font?: FontPatch;
  alignment?: { horizontal?: "left" | "center" | "right" | "justify"; vertical?: "top" | "center" | "bottom" };
};

/** `format` on an ordinary shape or a table cell (not pictures, groups,
 * table frames, paragraphs). Colours `#RRGGBB`, sizes in points. */
export function formatTarget(target: Address, format: FormatPatch): Op {
  return { op: "format", target, format };
}

// ---------------------------------------------------------------------------
// Insert / delete shapes
// ---------------------------------------------------------------------------

function placement(rect: EmuRect) {
  return {
    offset: { x_emu: clampInsertOffset(rect.x), y_emu: clampInsertOffset(rect.y) },
    extent: { cx_emu: clampExtent(rect.cx), cy_emu: clampExtent(rect.cy) },
  };
}

/** Text box (no geometry) on top of the slide's z-order. */
export function insertTextBox(slide: Address, rect: EmuRect, text = ""): Op {
  return { op: "insert", anchor: slide, position: "last-child", node: { kind: "shape", text, ...placement(rect) } };
}

/** DrawingML preset accepted by the current module (all checked by insert;
 * line and connector presets are refused). */
export const SHAPE_GEOMETRIES: readonly { geometry: string; label: string }[] = [
  { geometry: "rect", label: "Rectangle" },
  { geometry: "roundRect", label: "Rounded rectangle" },
  { geometry: "ellipse", label: "Ellipse" },
  { geometry: "triangle", label: "Triangle" },
  { geometry: "rtTriangle", label: "Right triangle" },
  { geometry: "diamond", label: "Diamond" },
  { geometry: "parallelogram", label: "Parallelogram" },
  { geometry: "trapezoid", label: "Trapezoid" },
  { geometry: "pentagon", label: "Pentagon" },
  { geometry: "hexagon", label: "Hexagon" },
  { geometry: "octagon", label: "Octagon" },
  { geometry: "star5", label: "Star (5 points)" },
  { geometry: "star8", label: "Star (8 points)" },
  { geometry: "rightArrow", label: "Right arrow" },
  { geometry: "leftArrow", label: "Left arrow" },
  { geometry: "upArrow", label: "Up arrow" },
  { geometry: "downArrow", label: "Down arrow" },
  { geometry: "leftRightArrow", label: "Left-right arrow" },
  { geometry: "chevron", label: "Chevron" },
  { geometry: "homePlate", label: "Pentagon arrow" },
  { geometry: "plus", label: "Plus" },
  { geometry: "flowChartProcess", label: "Flowchart: process" },
  { geometry: "flowChartDecision", label: "Flowchart: decision" },
  { geometry: "flowChartTerminator", label: "Flowchart: terminator" },
  { geometry: "flowChartDocument", label: "Flowchart: document" },
  { geometry: "wedgeRectCallout", label: "Callout" },
  { geometry: "wedgeRoundRectCallout", label: "Rounded callout" },
  { geometry: "cloud", label: "Cloud" },
  { geometry: "heart", label: "Heart" },
  { geometry: "can", label: "Can" },
  { geometry: "cube", label: "Cube" },
  { geometry: "donut", label: "Donut" },
  { geometry: "sun", label: "Sun" },
  { geometry: "moon", label: "Moon" },
  { geometry: "lightningBolt", label: "Lightning bolt" },
  { geometry: "frame", label: "Frame" },
  { geometry: "plaque", label: "Plaque" },
];

export function insertGeometryShape(slide: Address, geometry: string, rect: EmuRect, text = ""): Op {
  return {
    op: "insert",
    anchor: slide,
    position: "last-child",
    node: { kind: "shape", geometry, text, ...placement(rect) },
  };
}

/** Table of `rows` x `cols` empty cells (1..1000 x 1..63). */
export function insertTable(slide: Address, rows: number, cols: number, rect: EmuRect): Op {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ""));
  return {
    op: "insert",
    anchor: slide,
    position: "last-child",
    node: { kind: "table", rows: grid, ...placement(rect) },
  };
}

/** Clone of a shape (any kind, any slide of the deck) onto `slide`, keeping
 * the source geometry: placement members cannot be combined with `from`.
 * `last-child` puts it on top of the z-order, `first-child` at the bottom. */
export function cloneShape(slide: Address, source: Address, position: "first-child" | "last-child" = "last-child"): Op {
  return { op: "insert", anchor: slide, position, node: { kind: "shape", from: source } };
}

/**
 * Fallback restack for a module without the z-order op: a clone inserted as
 * the slide's last or first child plus a delete of the original keeps the
 * shape's formatting and geometry, but the shape gets a new id
 * (`transaction.ops[i].created`).
 */
export function restackShape(slide: Address, shape: Address, to: "front" | "back"): Op[] {
  return [cloneShape(slide, shape, to === "front" ? "last-child" : "first-child"), deleteNode(shape)];
}

/** Shapes a z-order `move` is relative to: the slide for a top-level shape,
 * the group's other children (back to front) for a grouped one (anchoring a
 * slide for a grouped shape is refused with `usage`). */
export type ZScope = { slide: Address } | { siblings: Address[] };

/**
 * Z-order to front / back (`docs/engine-ops-pptx.md`): `move` with `anchor`
 * and no `offset`; ids are kept. Top level: the slide as anchor with
 * `last-child` / `first-child`. In a group: after the front-most / before the
 * back-most sibling. Null when a grouped shape has no other sibling.
 */
export function orderShape(shape: Address, scope: ZScope, to: "front" | "back"): Op | null {
  if ("slide" in scope)
    return { op: "move", target: shape, anchor: scope.slide, position: to === "front" ? "last-child" : "first-child" };
  const anchor = to === "front" ? scope.siblings[scope.siblings.length - 1] : scope.siblings[0];
  return anchor ? { op: "move", target: shape, anchor, position: to === "front" ? "after" : "before" } : null;
}

/** One z-order step: after the next sibling in front (forward) or before the
 * sibling just behind (backward); siblings in observe order run back to front. */
export function stepShape(shape: Address, sibling: Address, to: "forward" | "backward"): Op {
  return { op: "move", target: shape, anchor: sibling, position: to === "forward" ? "after" : "before" };
}

/** Shape copy onto `slide` on top of its z-order. `offset` is the copy's
 * ABSOLUTE slide position in EMU (like `move`), not a delta; without it the
 * copy covers the source's slide box. The new address is
 * `transaction.ops[i].created` (a group copy returns the new group). A copied
 * chart frame shares its chart part with the source. */
export function copyShape(source: Address, slide: Address, offset?: { x: number; y: number }): Op {
  const op: Op = { op: "copy", source, target: slide, position: "last-child" };
  if (offset) op.offset = { x_emu: clampOffset(offset.x), y_emu: clampOffset(offset.y) };
  return op;
}

export type PictureData = { mediaType: string; base64: string; sha256: string; altText: string };

/** Picture on top of the slide's z-order; the new `p:pic` address is
 * `transaction.ops[i].created`. Members exactly as documented: unknown
 * members are refused with `usage`. */
export function insertPicture(slide: Address, rect: EmuRect, picture: PictureData): Op {
  return {
    op: "insert",
    anchor: slide,
    position: "last-child",
    node: {
      kind: "image",
      media_type: picture.mediaType,
      data: picture.base64,
      sha256: picture.sha256,
      ...placement(rect),
      alt_text: picture.altText,
    },
  };
}

/** Media types picture insert takes (`image-media-unsupported` otherwise). */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/bmp"];

/** Slide, shape (any kind), table row or table column. */
export function deleteNode(target: Address): Op {
  return { op: "delete", target };
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

export function duplicateSlide(slide: Address): Op {
  return { op: "insert", anchor: slide, position: "after", node: { kind: "slide", from: slide } };
}

/** New slide next to `anchor`; `layout` omitted = the anchor's layout. */
export function newSlide(anchor: Address, position: "before" | "after", layout?: string): Op {
  return { op: "insert", anchor, position, node: layout ? { kind: "slide", style: layout } : { kind: "slide" } };
}

/** Slide move that keeps the id (pending; current module: `op-kind-mismatch`). */
export function moveSlide(slide: Address, anchor: Address, position: "before" | "after"): Op {
  return { op: "move", target: slide, anchor, position };
}

/** Documented reorder: clone at the destination and delete the original in
 * one batch. The moved slide's new id is `transaction.ops[0].created`. */
export function reorderSlide(slide: Address, anchor: Address, position: "before" | "after"): Op[] {
  return [{ op: "insert", anchor, position, node: { kind: "slide", from: slide } }, deleteNode(slide)];
}

/** A slide insert naming a layout no deck has: the engine's refusal lists the
 * deck's layouts (`usage` "... names no slide layout of this deck; layouts: ..."). */
export const LAYOUT_PROBE_NAME = "wolf-review layout probe";
export function layoutProbe(anchor: Address): Op {
  return newSlide(anchor, "after", LAYOUT_PROBE_NAME);
}

/** Layout names from a `layoutProbe` refusal, or null when it lists none. */
export function parseLayouts(error: KernelError): string[] | null {
  const at = error.message.indexOf("layouts:");
  if (at < 0) return null;
  const names = [...error.message.slice(at).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
  return names.length ? names : null;
}

// ---------------------------------------------------------------------------
// Tables (positional addresses: re-derive after every structure edit)
// ---------------------------------------------------------------------------

export function insertTableRow(row: Address, position: "before" | "after", heightEmu?: number): Op {
  const op: Op = { op: "insert-row", anchor: row, position };
  if (heightEmu !== undefined) op.height_emu = Math.max(1, Math.round(heightEmu));
  return op;
}

/** `index` is the zero-based gap (0 = before the first column). */
export function insertTableColumn(table: Address, index: number, widthEmu?: number): Op {
  const op: Op = { op: "insert-column", target: table, index };
  if (widthEmu !== undefined) op.width_emu = Math.max(1, Math.round(widthEmu));
  return op;
}

export function resizeTableColumn(col: Address, widthEmu: number): Op {
  return { op: "resize", target: col, width_emu: clampExtent(widthEmu) };
}

export function resizeTableRow(row: Address, heightEmu: number): Op {
  return { op: "resize", target: row, height_emu: clampExtent(heightEmu) };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Refusal codes that mean "this module has no such operation": the control
 * is disabled for the session. `unsupported` is about one construct (this
 * shape, this paragraph): shown for that action, the control stays enabled. */
const CAPABILITY_CODES: Record<string, true> = { "op-kind-mismatch": true, "op-not-implemented": true };

/** The engine refused because the operation is missing from the module
 * (`op-kind-mismatch`, `op-not-implemented`). */
export function isCapabilityRefusal(error: KernelError): boolean {
  return !!CAPABILITY_CODES[error.code];
}

/** The engine refused this construct (`unsupported`) or the operation
 * (`isCapabilityRefusal`): a caller with another way to do the same edit
 * may take it for this action. */
export function isConstructRefusal(error: KernelError): boolean {
  return error.code === "unsupported" || isCapabilityRefusal(error);
}

/**
 * The ops of a refused batch the refusal is about: the one the engine names
 * ("operation 2: ..."), else those whose kind ("required for move", "PPTX
 * resize is not ...") or target the message names, else all of them.
 */
export function refusedOps(error: KernelError, ops: Op[]): Op[] {
  const index = /operation (\d+)/.exec(error.message);
  if (index && ops[Number(index[1])]) return [ops[Number(index[1])]!];
  const named = ops.filter((op) => typeof op.target === "string" && error.message.includes(op.target));
  const kind = /required for ([a-z-]+)|PPTX ([a-z-]+) (?:is not|supports)/.exec(error.message);
  const kindName = kind?.[1] ?? kind?.[2];
  const pool = named.length ? named : ops;
  const ofKind = kindName ? pool.filter((op) => op.op === kindName) : pool;
  return ofKind.length ? ofKind : pool;
}

/** Which capability an op exercises, if any. */
export function capabilityOf(op: Op, isTableFrame: (target: Address) => boolean): Capability | null {
  if (op.op === "move") {
    if (!("anchor" in op)) return "shape-move";
    return typeof op.target === "string" && /\/shape:[^/]+$/.test(op.target) ? "shape-order" : "slide-move";
  }
  if (op.op === "copy") return "shape-copy";
  if (op.op === "insert" && (op.node as { kind?: string } | undefined)?.kind === "image") return "picture-insert";
  if (op.op === "resize" && "extent" in op && typeof op.target === "string" && !isTableFrame(op.target))
    return "shape-resize";
  // Paragraph/run `set` and paragraph `delete` arrive together (engine-ops-pptx.md).
  if (
    (op.op === "set" || op.op === "delete") &&
    typeof op.target === "string" &&
    /\/para:@\d+(?:\/run:@\d+)?$/.test(op.target)
  )
    return "paragraph-set";
  return null;
}
