/**
 * User commands of the slides plugin. Each one builds ops with `ops.ts`,
 * applies them as ONE batch through `host.apply`, and re-derives addresses
 * from the result.
 */
import { isReactorKernel, type Address, type ApplyResult, type KernelError, type Op, type ViewNode } from "@wolfsdk/protocol";
import { type EditorHost } from "../../host/index.ts";
import {
  addressedLines,
  deckOf,
  isCut,
  toBox,
  toRect,
  union,
  type Box,
  type Deck,
  type ShapeInfo,
  type SlideInfo,
} from "./model.ts";
import {
  restackShape,
  capabilityOf,
  cloneShape,
  copyShape,
  deleteNode,
  duplicateSlide,
  formatTarget,
  insertGeometryShape,
  insertTable,
  insertTableColumn,
  insertTableRow,
  insertTextBox,
  isCapabilityRefusal,
  isConstructRefusal,
  textBodyEdit,
  insertPicture,
  layoutProbe,
  EMU_PER_PT,
  moveSlide,
  newSlide,
  orderShape,
  type ZScope,
  parseLayouts,
  PICTURE_TYPES,
  placeShape,
  refusedOps,
  reorderSlide,
  resizeTableColumn,
  resizeTableRow,
  setText,
  stepShape,
  type AddressedLine,
  type EmuRect,
  type Capability,
  type FormatPatch,
} from "./ops.ts";
import { storeOf, type FontToggles, type InsertMode } from "./store.ts";

export const SOURCE = "slides";

const CAPABILITY_LABEL: Record<Capability, string> = {
  "shape-move": "Move shape",
  "shape-resize": "Resize shape",
  "slide-move": "Move slide",
  "paragraph-set": "Paragraph text",
  "shape-order": "Shape order",
  "shape-copy": "Shape copy",
  "picture-insert": "Insert picture",
};

export function deck(host: EditorHost): Deck | null {
  const state = host.getSnapshot().state;
  return state && state.format === "pptx" ? deckOf(state) : null;
}

export function currentSlide(host: EditorHost): SlideInfo | undefined {
  return deck(host)?.byPage.get(host.getSnapshot().currentPage);
}

export function selectedShapes(host: EditorHost): ShapeInfo[] {
  const d = deck(host);
  if (!d) return [];
  return host
    .getSnapshot()
    .selection.map((id) => d.shapes.get(id))
    .filter((s): s is ShapeInfo => !!s);
}

export type CellRef = { table: ShapeInfo; row: number; col: number; node: ViewNode };

export function selectedCells(host: EditorHost): CellRef[] {
  const d = deck(host);
  if (!d) return [];
  const out: CellRef[] = [];
  for (const id of host.getSnapshot().selection) {
    const at = d.cells.get(id);
    const table = at && d.shapes.get(at.table);
    const node = table?.table?.cells[at!.row]?.[at!.col];
    if (table && node) out.push({ table, row: at!.row, col: at!.col, node });
  }
  return out;
}

export function notify(host: EditorHost, text: string, tone: "info" | "error" = "info"): void {
  storeOf(host).set({ notice: { text, tone } });
}

export function errorText(error: KernelError): string {
  return `${error.code}: ${error.message}`;
}

function isTableFrame(host: EditorHost) {
  const d = deck(host);
  return (target: Address) => d?.shapes.get(target)?.kind === "table";
}

/**
 * Apply one batch. A refusal meaning "this module lacks the operation"
 * disables the capability the failing op exercises for the session and is
 * shown with its code.
 */
export async function commit(
  host: EditorHost,
  ops: Op[],
  label: string,
  options: { quiet?: boolean } = {},
): Promise<ApplyResult> {
  const tableFrame = isTableFrame(host);
  const result = await host.apply(ops, { label, source: SOURCE, quiet: options.quiet });
  const store = storeOf(host);
  if (result.ok) {
    if (store.state.notice?.tone === "error") store.set({ notice: null });
    const clip = store.state.clipboard;
    if (clip && result.transaction.address_map.length) {
      const moved = new Map(result.transaction.address_map.map((m) => [m.before, m.after]));
      store.set({ clipboard: { ...clip, shapes: clip.shapes.map((a) => moved.get(a) ?? a) } });
    }
    return result;
  }
  if (isCapabilityRefusal(result.error)) {
    const suspects = refusedOps(result.error, ops);
    const caps = [...new Set(suspects.map((op) => capabilityOf(op, tableFrame)).filter((c): c is Capability => !!c))];
    if (caps.length) {
      const disabled = { ...store.state.disabled };
      for (const cap of caps) disabled[cap] = result.error;
      store.set({ disabled });
      if (!options.quiet)
        notify(
          host,
          `${caps.map((c) => CAPABILITY_LABEL[c]).join(", ")} refused by the engine (${result.error.code}): ${result.error.message}. Disabled for this session.`,
          "error",
        );
      return result;
    }
  }
  if (!options.quiet) notify(host, `${label} refused (${errorText(result.error)})`, "error");
  return result;
}

function created(result: ApplyResult, index = 0): Address | undefined {
  return result.ok ? result.transaction.ops.find((o) => o.index === index)?.created : undefined;
}

/** Make `page` current and ask the shell to scroll it into view. */
export function goToPage(host: EditorHost, page: number): void {
  host.setCurrentPage(page);
  host.reveal({ page });
}

function goToSlide(host: EditorHost, slide: Address | undefined): void {
  const target = slide && deck(host)?.bySlide.get(slide);
  if (target) goToPage(host, target.page);
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/** Ask the engine for the deck's layout names (listed in a refusal). */
export async function loadLayouts(host: EditorHost): Promise<string[] | null> {
  const state = host.getSnapshot().state;
  const first = deck(host)?.slides[0];
  const store = storeOf(host);
  if (!state || !first) return null;
  if (store.state.layouts?.doc === state.doc) return store.state.layouts.names;
  const result = await host.apply([layoutProbe(first.id)], { label: "List layouts", source: SOURCE, quiet: true });
  if (result.ok) {
    // A layout really carries the probe name: take the slide back out.
    await host.undo();
    store.set({ layouts: { doc: state.doc, names: null } });
    return null;
  }
  const names = parseLayouts(result.error);
  store.set({ layouts: { doc: state.doc, names } });
  return names;
}

export async function addSlide(host: EditorHost, after: Address, layout?: string): Promise<void> {
  const result = await commit(host, [newSlide(after, "after", layout)], layout ? `New slide (${layout})` : "New slide");
  if (result.ok) {
    host.select([]);
    goToSlide(host, created(result));
  }
}

export async function duplicateSlideCmd(host: EditorHost, slide: Address): Promise<void> {
  const result = await commit(host, [duplicateSlide(slide)], "Duplicate slide");
  if (result.ok) {
    host.select([]);
    goToSlide(host, created(result));
  }
}

export async function deleteSlide(host: EditorHost, slide: Address): Promise<void> {
  const d = deck(host);
  const index = d?.slides.findIndex((s) => s.id === slide) ?? -1;
  const result = await commit(host, [deleteNode(slide)], "Delete slide");
  if (result.ok) {
    host.select([]);
    const slides = deck(host)?.slides ?? [];
    const next = slides[Math.min(Math.max(index, 0), slides.length - 1)];
    if (next) goToPage(host, next.page);
  }
}

/**
 * Move `slide` so it ends at position `to` (0-based, in the final order).
 * Uses the engine's slide `move` while it is available (id kept), else the
 * documented clone + delete batch (new id followed from `created`).
 */
export async function moveSlideTo(host: EditorHost, slide: Address, to: number): Promise<void> {
  const d = deck(host);
  if (!d) return;
  const from = d.slides.findIndex((s) => s.id === slide);
  const target = Math.max(0, Math.min(d.slides.length - 1, to));
  if (from < 0 || target === from) return;
  const anchor = d.slides[target]!.id;
  const position = target < from ? "before" : "after";
  const real = await withCapability(host, "slide-move", [moveSlide(slide, anchor, position)], "Move slide");
  if (real) {
    if (real.ok) goToSlide(host, slide);
    return;
  }
  const result = await commit(host, reorderSlide(slide, anchor, position), "Move slide");
  if (result.ok) {
    host.select([]);
    goToSlide(host, created(result));
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export async function deleteSelection(host: EditorHost): Promise<void> {
  const shapes = selectedShapes(host);
  if (shapes.length) {
    const result = await commit(
      host,
      shapes.map((s) => deleteNode(s.id)),
      shapes.length > 1 ? "Delete shapes" : "Delete shape",
    );
    if (result.ok) host.select([]);
    return;
  }
  const cells = selectedCells(host).filter((c) => (c.node.text ?? "") !== "");
  if (cells.length)
    await commit(
      host,
      cells.map((c) => setText(c.node.id, "")),
      "Clear cells",
    );
}

/**
 * Try `ops` that need `cap` unless the module refused it earlier. Returns
 * the result, or null when the caller should run its fallback: the
 * capability is (now) disabled, or the engine refused this construct
 * (`unsupported`, fallback for this action only). Any other refusal is shown
 * and returned.
 */
async function withCapability(
  host: EditorHost,
  cap: Capability,
  ops: Op[],
  label: string,
): Promise<ApplyResult | null> {
  const store = storeOf(host);
  if (store.state.disabled[cap]) return null;
  const result = await commit(host, ops, label, { quiet: true });
  if (result.ok) return result;
  if (store.state.disabled[cap] || isConstructRefusal(result.error)) return null;
  host.reportError(result.error);
  notify(host, `${label} refused (${errorText(result.error)})`, "error");
  return result;
}

/** Pasted and duplicated shapes land this far right and down of the source
 * on the same slide (only with the engine's shape `copy`; a clone keeps the
 * source position). */
const PASTE_SHIFT = 10 * EMU_PER_PT;

/** `copy` ops onto `slide`; a source already on `slide` is placed
 * `PASTE_SHIFT` right and down of itself, others keep their position. */
function copyOps(host: EditorHost, sources: Address[], slide: Address): Op[] {
  const d = deck(host);
  return sources.map((id) => {
    const shape = d?.shapes.get(id);
    const rect = shape?.slide === slide ? shape.rect : null;
    return copyShape(id, slide, rect ? { x: rect.x + PASTE_SHIFT, y: rect.y + PASTE_SHIFT } : undefined);
  });
}

/** Copy the selected shapes: the engine's shape `copy` placed next to the
 * source when the module has it, else a clone at the source position. */
export async function duplicateShapes(host: EditorHost): Promise<boolean> {
  const shapes = selectedShapes(host);
  if (!shapes.length) return false;
  const label = shapes.length > 1 ? "Duplicate shapes" : "Duplicate shape";
  const real = await withCapability(
    host,
    "shape-copy",
    shapes.flatMap((s) => copyOps(host, [s.id], s.slide)),
    label,
  );
  const result =
    real ??
    (await commit(
      host,
      shapes.map((s) => cloneShape(s.slide, s.id)),
      label,
    ));
  if (result.ok) host.select(shapes.map((_, i) => created(result, i)).filter((a): a is Address => !!a));
  return true;
}

/** Notify and return true when shape `move` was refused this session. */
function moveRefused(host: EditorHost): boolean {
  const refusal = storeOf(host).state.disabled["shape-move"];
  if (!refusal) return false;
  notify(
    host,
    `Move is disabled for this session: the engine refused it (${refusal.code}: ${refusal.message}).`,
    "error",
  );
  return true;
}

/** Selected shapes with geometry on the selection's first slide. */
function placedSelection(host: EditorHost): { slide: SlideInfo; shapes: ShapeInfo[] } | null {
  const shapes = selectedShapes(host).filter((s) => s.rect);
  const slide = shapes[0] && deck(host)?.bySlide.get(shapes[0].slide);
  return slide ? { slide, shapes: shapes.filter((s) => s.slide === slide.id) } : null;
}

export type AlignEdge = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Align the selected shapes to each other, or a single shape to the slide. */
export async function alignShapes(host: EditorHost, edge: AlignEdge): Promise<void> {
  const sel = placedSelection(host);
  if (!sel || moveRefused(host)) return;
  const boxes = sel.shapes.map((s) => [s.id, toBox(s.rect!)] as const);
  const frame =
    boxes.length === 1 ? { x: 0, y: 0, w: sel.slide.widthPt, h: sel.slide.heightPt } : union(boxes.map(([, b]) => b))!;
  const out: Record<Address, Box> = {};
  for (const [id, b] of boxes) {
    const x =
      edge === "left"
        ? frame.x
        : edge === "center"
          ? frame.x + (frame.w - b.w) / 2
          : edge === "right"
            ? frame.x + frame.w - b.w
            : b.x;
    const y =
      edge === "top"
        ? frame.y
        : edge === "middle"
          ? frame.y + (frame.h - b.h) / 2
          : edge === "bottom"
            ? frame.y + frame.h - b.h
            : b.y;
    out[id] = { ...b, x, y };
  }
  await commitGeometry(host, out, `Align ${edge}`);
}

/** Equal gaps between three or more selected shapes, keeping the outer two. */
export async function distributeShapes(host: EditorHost, axis: "horizontal" | "vertical"): Promise<void> {
  const sel = placedSelection(host);
  if (!sel || sel.shapes.length < 3 || moveRefused(host)) return;
  const h = axis === "horizontal";
  const boxes = sel.shapes
    .map((s) => [s.id, toBox(s.rect!)] as const)
    .sort(([, a], [, b]) => (h ? a.x + a.w / 2 - (b.x + b.w / 2) : a.y + a.h / 2 - (b.y + b.h / 2)));
  const first = boxes[0]![1];
  const last = boxes[boxes.length - 1]![1];
  const start = h ? first.x : first.y;
  const end = h ? last.x + last.w : last.y + last.h;
  const total = boxes.reduce((sum, [, b]) => sum + (h ? b.w : b.h), 0);
  const gap = (end - start - total) / (boxes.length - 1);
  const out: Record<Address, Box> = {};
  let at = start;
  for (const [id, b] of boxes) {
    out[id] = h ? { ...b, x: at } : { ...b, y: at };
    at += (h ? b.w : b.h) + gap;
  }
  await commitGeometry(host, out, `Distribute ${axis}`);
}

/** Bring to front / send to back: the engine's z-order `move` (ids kept)
 * when the module has it, else clone + delete (new ids; top level only).
 * Shapes move within one container: the slide's top level, or the group of
 * the first selected shape (a grouped shape reorders among its siblings). */
export async function restackShapes(host: EditorHost, to: "front" | "back"): Promise<void> {
  const slide = currentSlide(host);
  const picked = selectedShapes(host).filter((s) => s.slide === slide?.id);
  if (!slide || !picked.length) return;
  const group = picked[0]!.group;
  const siblings = slide.shapes.filter((s) => s.group === group);
  const moving = siblings.filter((s) => picked.includes(s));
  const edge = to === "front" ? siblings.slice(-moving.length) : siblings.slice(0, moving.length);
  if (edge.every((s) => moving.includes(s))) {
    notify(host, `Already at the ${to}.`);
    return;
  }
  const label = to === "front" ? "Bring to front" : "Send to back";
  const scope: ZScope =
    group === null ? { slide: slide.id } : { siblings: siblings.filter((s) => !moving.includes(s)).map((s) => s.id) };
  // Keep the moving shapes' own order: `last-child` / `before` placements
  // stack upwards (back first), `first-child` / `after` downwards (front first).
  const backFirst = group === null ? to === "front" : to === "back";
  const ids = (backFirst ? moving : [...moving].reverse()).map((s) => s.id);
  const ops = ids.map((id) => orderShape(id, scope, to)).filter((op): op is Op => !!op);
  if (await withCapability(host, "shape-order", ops, label)) return;
  if (group !== null) {
    const refusal = storeOf(host).state.disabled["shape-order"];
    if (refusal)
      notify(
        host,
        `${label} inside a group needs the engine's z-order move, which it refused (${errorText(refusal)}).`,
        "error",
      );
    return;
  }
  const pairs = ids.map((id) => restackShape(slide.id, id, to));
  const fallback = [...pairs.map((p) => p[0]!), ...pairs.map((p) => p[1]!)];
  const result = await commit(host, fallback, label);
  if (result.ok) host.select(ids.map((_, i) => created(result, i)).filter((a): a is Address => !!a));
}

/** Bring forward / send backward one step among the shape's siblings (top
 * level or its group): only with the engine's z-order `move` (no clone
 * fallback); a refusal disables both for the session. */
export async function stepShapes(host: EditorHost, to: "forward" | "backward"): Promise<void> {
  const slide = currentSlide(host);
  const picked = selectedShapes(host).filter((s) => s.slide === slide?.id);
  if (!slide || picked.length !== 1) return;
  const siblings = slide.shapes.filter((s) => s.group === picked[0]!.group);
  const at = siblings.indexOf(picked[0]!);
  const sibling = siblings[to === "forward" ? at + 1 : at - 1];
  if (!sibling) {
    notify(host, `Already at the ${to === "forward" ? "front" : "back"}.`);
    return;
  }
  await commit(host, [stepShape(picked[0]!.id, sibling.id, to)], to === "forward" ? "Bring forward" : "Send backward");
}

/** Remember the selected shapes; a cut removes them when pasted. */
export function copyShapes(host: EditorHost, cut: boolean): boolean {
  const shapes = selectedShapes(host);
  const doc = host.getSnapshot().state?.doc;
  if (!shapes.length || !doc) return false;
  storeOf(host).set({ clipboard: { doc, shapes: shapes.map((s) => s.id), cut } });
  const what = shapes.length > 1 ? `${shapes.length} shapes` : shapes[0]!.label;
  notify(host, cut ? `Cut ${what}: removed from here when you paste (Cmd+V).` : `Copied ${what}.`);
  return true;
}

/** Paste onto the current slide as one batch: engine `copy` (next to the
 * source on its own slide) or clones (source position), plus deletes of the
 * originals after a cut. */
export async function pasteShapes(host: EditorHost): Promise<boolean> {
  const store = storeOf(host);
  const clip = store.state.clipboard;
  const d = deck(host);
  const slide = currentSlide(host);
  if (!clip || !d || !slide || clip.doc !== host.getSnapshot().state?.doc) return false;
  const sources = clip.shapes.filter((id) => d.shapes.has(id));
  if (!sources.length) {
    store.set({ clipboard: null });
    notify(host, "The copied shapes are no longer in the deck.", "error");
    return true;
  }
  const deletes = clip.cut ? sources.map((id) => deleteNode(id)) : [];
  const label = clip.cut ? "Cut and paste" : sources.length > 1 ? "Paste shapes" : "Paste shape";
  // A cut pastes in place; a copy onto the source slide lands beside it.
  const copies = clip.cut ? sources.map((id) => copyShape(id, slide.id)) : copyOps(host, sources, slide.id);
  const real = await withCapability(host, "shape-copy", [...copies, ...deletes], label);
  const result = real ?? (await commit(host, [...sources.map((id) => cloneShape(slide.id, id)), ...deletes], label));
  if (!result.ok) return true;
  const pasted = sources.map((_, i) => created(result, i)).filter((a): a is Address => !!a);
  host.select(pasted);
  // After a cut the originals are gone; later pastes copy the pasted shapes.
  if (clip.cut) store.set({ clipboard: { doc: clip.doc, shapes: pasted, cut: false } });
  return true;
}

/** Tab / Shift+Tab: select the next / previous shape on the current slide. */
export function cycleShapes(host: EditorHost, back: boolean): boolean {
  const slide = currentSlide(host);
  if (!slide?.shapes.length) return false;
  const selection = host.getSnapshot().selection;
  const n = slide.shapes.length;
  const at = slide.shapes.findIndex((s) => s.id === selection[selection.length - 1]);
  const next = at === -1 ? (back ? n - 1 : 0) : (at + (back ? n - 1 : 1)) % n;
  host.select([slide.shapes[next]!.id]);
  return true;
}

/** Commit previewed geometry of several shapes as one batch. */
export async function commitGeometry(host: EditorHost, boxes: Record<Address, Box>, label: string): Promise<void> {
  const d = deck(host);
  const store = storeOf(host);
  if (!d) return;
  const ops: Op[] = [];
  for (const [id, box] of Object.entries(boxes)) {
    const shape = d.shapes.get(id);
    if (shape?.rect) ops.push(...placeShape(id, shape.rect, toRect(box)));
  }
  if (!ops.length) {
    store.set({ preview: null });
    return;
  }
  try {
    await commit(host, ops, label);
  } finally {
    store.set({ preview: null });
  }
}

const DEFAULT_SIZE: Record<InsertMode["kind"], { w: number; h: number }> = {
  textbox: { w: 216, h: 36 },
  shape: { w: 144, h: 72 },
  table: { w: 0, h: 0 },
};

/** Insert per `mode` into `box` (points); a click (tiny box) uses a default size. */
export async function insertAt(host: EditorHost, slide: SlideInfo, mode: InsertMode, box: Box): Promise<void> {
  let { x, y, w, h } = box;
  if (w < 4 || h < 4) {
    const size =
      mode.kind === "table"
        ? { w: Math.min(72 * mode.cols, slide.widthPt - 36), h: 28 * mode.rows }
        : DEFAULT_SIZE[mode.kind];
    w = size.w;
    h = size.h;
  }
  x = Math.max(0, Math.min(x, slide.widthPt - 1));
  y = Math.max(0, Math.min(y, slide.heightPt - 1));
  const rect = toRect({ x, y, w, h });
  const op =
    mode.kind === "textbox"
      ? insertTextBox(slide.id, rect)
      : mode.kind === "shape"
        ? insertGeometryShape(slide.id, mode.geometry, rect)
        : insertTable(slide.id, mode.rows, mode.cols, rect);
  const label = mode.kind === "textbox" ? "Insert text box" : mode.kind === "shape" ? "Insert shape" : "Insert table";
  const store = storeOf(host);
  store.set({ insert: null });
  const result = await commit(host, [op], label);
  const id = created(result);
  if (!id) return;
  host.select([id]);
  if (mode.kind === "textbox") beginTextEdit(host, id, "shape", slide.page);
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/** Image files the picture insert takes (by media type). */
export function isPictureFile(file: File): boolean {
  return PICTURE_TYPES.includes(file.type);
}

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** Natural size in points (CSS pixels at 96 dpi), null when not decodable here. */
async function naturalSize(file: File): Promise<{ w: number; h: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth * 0.75, h: img.naturalHeight * 0.75 } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Insert an image file as a picture on `slide` (default: the current one),
 * centred on `at` (points) or on the slide, at its natural size scaled down
 * to fit 80 % of the slide. Refusals disable "picture-insert".
 */
export async function insertPictureFile(
  host: EditorHost,
  file: File,
  at?: { x: number; y: number },
  slide = currentSlide(host),
): Promise<void> {
  if (!slide) return;
  const refusal = storeOf(host).state.disabled["picture-insert"];
  if (refusal) {
    notify(
      host,
      `Insert picture is disabled for this session: the engine refused it (${errorText(refusal)}).`,
      "error",
    );
    return;
  }
  if (!isPictureFile(file)) {
    notify(
      host,
      `${file.name || "The pasted item"} is not a picture this editor inserts (${file.type || "unknown type"}).`,
      "error",
    );
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const natural = (await naturalSize(file)) ?? { w: slide.widthPt / 2, h: slide.heightPt / 2 };
  const scale = Math.min(1, (slide.widthPt * 0.8) / natural.w, (slide.heightPt * 0.8) / natural.h);
  const w = Math.max(1, natural.w * scale);
  const h = Math.max(1, natural.h * scale);
  const cx = at?.x ?? slide.widthPt / 2;
  const cy = at?.y ?? slide.heightPt / 2;
  const x = Math.max(0, Math.min(cx - w / 2, slide.widthPt - w));
  const y = Math.max(0, Math.min(cy - h / 2, slide.heightPt - h));
  const altText = file.name ? file.name.replace(/\.[^.]+$/, "") : "Pasted picture";
  const op = insertPicture(slide.id, toRect({ x, y, w, h }), {
    mediaType: file.type,
    base64: toBase64(bytes),
    sha256,
    altText,
  });
  const store = storeOf(host);
  store.set({ insert: null, editing: null });
  const result = await commit(host, [op], "Insert picture");
  const id = created(result);
  if (id) host.select([id]);
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

/** Targets `format` accepts among the selection: text shapes and table cells
 * (a selected table frame stands for all its cells). */
export function formatTargets(host: EditorHost): Address[] {
  const targets: Address[] = [];
  for (const shape of selectedShapes(host)) {
    if (shape.kind === "text") targets.push(shape.id);
    else if (shape.kind === "table")
      for (const row of shape.table?.cells ?? []) for (const cell of row) if (cell) targets.push(cell.id);
  }
  for (const cell of selectedCells(host)) targets.push(cell.node.id);
  return [...new Set(targets)];
}

export async function applyFormat(host: EditorHost, patch: FormatPatch, label: string): Promise<boolean> {
  const targets = formatTargets(host);
  if (!targets.length) return false;
  const result = await commit(
    host,
    targets.map((t) => formatTarget(t, patch)),
    label,
  );
  return result.ok;
}

/** A colour as observe reports it: `#RRGGBB` (`hex`), a theme, system or
 * preset colour the `format` op cannot write (`theme`, e.g. `scheme:accent1`),
 * and for fills and lines the `kind` (`solid|none|gradient|picture|pattern|group`). */
export type ColorState = { kind?: string; hex?: string; theme?: string };

/** On, off, or set differently across the runs of the target. */
export type Toggle = boolean | "mixed";

/** Toolbar state of a format target. Absent members are unset in the file
 * (inherited from layout or theme) or differ across runs/paragraphs. */
export type FormatState = {
  bold?: Toggle;
  italic?: Toggle;
  underline?: Toggle;
  name?: string;
  size?: number;
  color?: ColorState;
  fill?: ColorState;
  line?: ColorState;
  lineWidth?: number;
  horizontal?: string;
  vertical?: string;
};

type ObservedColor = { kind?: string; color?: string };
type ObservedFont = {
  name?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: string;
};
type ObservedFormat = {
  font?: ObservedFont;
  fill?: ObservedColor;
  line?: ObservedColor & { width?: number };
  alignment?: { horizontal?: string; vertical?: string };
};

const HEX = /^#[0-9a-f]{6}$/i;

function colorState(c: ObservedColor | undefined): ColorState | undefined {
  if (!c || (c.kind === undefined && c.color === undefined)) return undefined;
  const out: ColorState = {};
  if (c.kind !== undefined) out.kind = c.kind;
  if (c.color !== undefined) {
    if (HEX.test(c.color)) out.hex = c.color.toUpperCase();
    else out.theme = c.color;
  }
  return out;
}

/** True when the module reports observe `format`/`geometry` (the engine
 * additions of `docs/engine-ops-pptx.md`); without them the toolbar falls
 * back to the font toggles this session applied. */
const reportsFormat = new WeakMap<object, boolean>();
function formatReported(state: NonNullable<ReturnType<EditorHost["getSnapshot"]>["state"]>): boolean {
  let known = reportsFormat.get(state);
  if (known === undefined) {
    known = state.nodes.some((n) => n.format !== undefined || n.geometry !== undefined);
    reportsFormat.set(state, known);
  }
  return known;
}

/**
 * What the toolbar shows for `target` (a shape or table cell). The engine
 * reports on the shape/cell each `font` member all its runs share and
 * `alignment.horizontal` when all paragraphs agree; a member stored on some
 * runs but absent on the target is shown as mixed. Unset members stay
 * undefined (inherited values are not resolved by the engine). Without
 * observe `format` in the module, bold/italic/underline come from what this
 * session applied.
 */
export function formatState(host: EditorHost, target: Address | undefined): FormatState {
  if (!target) return {};
  const state = host.getSnapshot().state;
  if (!state) return {};
  const own = (host.node(target)?.format ?? {}) as ObservedFormat;
  const children = (id: Address, kind: string) =>
    (state.childIds[id] ?? []).map((c) => host.node(c)).filter((n): n is ViewNode => n?.kind === kind);
  const paragraphs = children(target, "paragraph");
  const runs = paragraphs.flatMap((p) => children(p.id, "run"));
  const runFonts = runs.map((r) => (r.format as ObservedFormat | undefined)?.font);
  const toggle = (key: "bold" | "italic" | "underline"): Toggle | undefined => {
    const v = own.font?.[key];
    if (v !== undefined) return key === "underline" ? v !== "none" : v === true;
    return runFonts.some((f) => f?.[key] !== undefined) ? "mixed" : undefined;
  };
  if (!formatReported(state)) {
    const memory = storeOf(host).state.fontMemory[target] ?? {};
    return { bold: memory.bold, italic: memory.italic, underline: memory.underline };
  }
  return {
    bold: toggle("bold"),
    italic: toggle("italic"),
    underline: toggle("underline"),
    name: own.font?.name,
    size: own.font?.size,
    color: colorState(own.font?.color === undefined ? undefined : { color: own.font.color }),
    fill: colorState(own.fill),
    line: colorState(own.line),
    lineWidth: own.line?.width,
    horizontal: own.alignment?.horizontal,
    vertical: own.alignment?.vertical,
  };
}

export async function toggleFont(host: EditorHost, key: keyof FontToggles): Promise<void> {
  const targets = formatTargets(host);
  if (!targets.length) return;
  // Mixed or unset turns it on.
  const next = formatState(host, targets[0])[key] !== true;
  const font = key === "underline" ? { underline: next ? ("single" as const) : ("none" as const) } : { [key]: next };
  const label = `${next ? "" : "Remove "}${key === "bold" ? "Bold" : key === "italic" ? "Italic" : "Underline"}`;
  if (await applyFormat(host, { font }, label.trim())) {
    const store = storeOf(host);
    const memory = { ...store.state.fontMemory };
    for (const t of targets) memory[t] = { ...memory[t], [key]: next };
    store.set({ fontMemory: memory });
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function runsOf(host: EditorHost, paragraph: ViewNode): ViewNode[] {
  const state = host.getSnapshot().state;
  return (state?.childIds[paragraph.id] ?? []).map((c) => host.node(c)).filter((n): n is ViewNode => n?.kind === "run");
}

const formatKey = (n: ViewNode | undefined) => JSON.stringify(n?.format ?? null);

/** The paragraph's runs carry different formatting, or the module does not
 * report `format` and there are several runs (the view cannot tell). */
function mixedRuns(host: EditorHost, paragraph: ViewNode): boolean {
  const runs = runsOf(host, paragraph);
  if (runs.length < 2) return false;
  const state = host.getSnapshot().state;
  if (!state || !formatReported(state)) return true;
  return runs.some((r) => formatKey(r) !== formatKey(runs[0]));
}

function paragraphsOf(host: EditorHost, body: Address): ViewNode[] {
  const state = host.getSnapshot().state;
  return (state?.childIds[body] ?? []).map((c) => host.node(c)).filter((n): n is ViewNode => n?.kind === "paragraph");
}

export type TextOutcome = { status: "done" } | { status: "refused"; error: KernelError };

/**
 * Write the text (`\n` between paragraphs) of a shape, table cell or notes
 * body, writing only what changed so formatting survives:
 * - an edit inside a paragraph: run-level `set` on the runs it touches, the
 *   caret's run (`caret`, an offset of `text`) taking typed text;
 * - a line-break edit, or a paragraph whose runs do not spell its text:
 *   paragraph-level `set` (the paragraph takes its first run's formatting;
 *   the engine edits no line break between runs; a notice says so when the
 *   runs were formatted differently);
 * - removed paragraphs: `delete`; new lines: paragraph `insert` (the engine
 *   gives them the anchor paragraph's last run formatting).
 * The whole-body `set` (`whole`, shapes and cells) takes the edit when the
 * body has no addressable paragraph for a changed line, paragraph/run edits
 * are disabled for the session, or the engine refuses them for this
 * construct (`unsupported`).
 */
async function writeBodyText(
  host: EditorHost,
  body: Address,
  text: string,
  caret: number | undefined,
  label: string,
  whole: boolean,
): Promise<TextOutcome> {
  const node = host.node(body);
  if (!node)
    return { status: "refused", error: { code: "address-unresolved", message: `${body} is gone`, argument: body } };
  const before = node.text ?? "";
  if (before === text) return { status: "done" };
  const store = storeOf(host);
  const edit = store.state.disabled["paragraph-set"]
    ? null
    : textBodyEdit(
        addressedLines(before, paragraphsOf(host, body)),
        text.split("\n"),
        (address) => {
          const para = host.node(address);
          return para ? runsOf(host, para).map((r) => ({ address: r.id, text: r.text ?? "" })) : [];
        },
        caret,
      );
  const ops = edit?.ops ?? null;
  const flattened = (edit?.paragraphSets ?? []).filter((a) => {
    const para = host.node(a);
    return para !== undefined && mixedRuns(host, para);
  });
  if (ops && !ops.length) return { status: "done" };
  if (ops) {
    const result = await commit(host, ops, label, { quiet: whole });
    if (result.ok) {
      if (flattened.length)
        notify(
          host,
          "A line break was edited between differently formatted runs: that paragraph now has its first run's formatting (the engine edits no line break between runs).",
        );
      return { status: "done" };
    }
    if (!whole) return { status: "refused", error: result.error };
    if (!isConstructRefusal(result.error)) {
      notify(host, `${label} refused (${errorText(result.error)})`, "error");
      return { status: "refused", error: result.error };
    }
  } else if (!whole) {
    const why = store.state.disabled["paragraph-set"]
      ? {
          code: store.state.disabled["paragraph-set"]!.code,
          message: `paragraph edits are disabled for this session: ${store.state.disabled["paragraph-set"]!.message}`,
        }
      : { code: "address-unresolved", message: `${body}: a changed paragraph has no address` };
    notify(host, `${label} not saved (${why.code}: ${why.message}).`, "error");
    return { status: "refused", error: { ...why, argument: body } };
  }
  const result = await commit(host, [setText(body, text)], label);
  return result.ok ? { status: "done" } : { status: "refused", error: result.error };
}

export function writeShapeText(host: EditorHost, shapeId: Address, text: string, caret?: number): Promise<TextOutcome> {
  return writeBodyText(host, shapeId, text, caret, "Edit text", true);
}

export function canEditText(shape: ShapeInfo): boolean {
  return shape.kind === "text" && !isCut(shape.node.text);
}

/**
 * Start editing a shape's or cell's text. On the reactor kernel the caret
 * editor takes it (CaretEditor.tsx), except where it cannot place a caret:
 * empty text (the engine lays out no line for it) or text the engine cut in
 * the view; those use the box editor and say why. The caret editor itself
 * falls back when the layout turns out unusable.
 */
export function beginTextEdit(
  host: EditorHost,
  target: Address,
  kind: "shape" | "cell",
  page: number,
  options: { at?: { x: number; y: number; client?: [number, number] }; selectAll?: boolean } = {},
): void {
  const text = host.node(target)?.text ?? "";
  let reason: string | undefined;
  if (!text) reason = "the text is empty, so the engine lays out no line to put a caret on";
  else if (isCut(text)) reason = "the engine cut this text in the view";
  const caret = isReactorKernel(host.kernel) && !reason;
  storeOf(host).set({
    editing: {
      target,
      kind,
      page,
      mode: caret ? "caret" : "box",
      ...options,
      ...(isReactorKernel(host.kernel) && reason ? { reason } : {}),
    },
  });
}

export function writeCellText(host: EditorHost, cell: Address, text: string, caret?: number): Promise<TextOutcome> {
  return writeBodyText(host, cell, text, caret, "Edit cell", true);
}

/** Speaker notes: paragraph-level edits only (notes have no whole-body `set`). */
export async function writeNotes(host: EditorHost, slide: SlideInfo, text: string): Promise<boolean> {
  if (!slide.notes) return false;
  return (await writeBodyText(host, slide.notes.id, text, undefined, "Edit notes", false)).status === "done";
}

// ---------------------------------------------------------------------------
// Tables (positional addresses: everything is re-derived from the new state)
// ---------------------------------------------------------------------------

/** The table and the row/column the user is on: a selected cell, else the
 * selected table's last row/column. */
export function tableFocus(host: EditorHost): { table: ShapeInfo; row: number; col: number } | null {
  const cell = selectedCells(host)[0];
  if (cell) return { table: cell.table, row: cell.row, col: cell.col };
  const table = selectedShapes(host).find((s) => s.kind === "table");
  if (!table?.table) return null;
  return { table, row: table.table.rows.length - 1, col: table.table.cols.length - 1 };
}

export async function tableInsertRow(host: EditorHost, where: "before" | "after"): Promise<void> {
  const f = tableFocus(host);
  const row = f?.table.table?.rows[f.row];
  if (!f || !row) return;
  await commit(
    host,
    [insertTableRow(row.id, where, row.emu || undefined)],
    where === "before" ? "Insert row above" : "Insert row below",
  );
}

export async function tableDeleteRow(host: EditorHost): Promise<void> {
  const f = tableFocus(host);
  const rows = f?.table.table?.rows ?? [];
  if (!f || rows.length < 2) return;
  const result = await commit(host, [deleteNode(rows[f.row]!.id)], "Delete row");
  if (result.ok) host.select([f.table.id]);
}

export async function tableInsertColumn(host: EditorHost, where: "before" | "after"): Promise<void> {
  const f = tableFocus(host);
  const col = f?.table.table?.cols[f.col];
  if (!f || !col) return;
  const index = where === "before" ? f.col : f.col + 1;
  await commit(
    host,
    [insertTableColumn(f.table.id, index, col.emu || undefined)],
    where === "before" ? "Insert column left" : "Insert column right",
  );
}

export async function tableDeleteColumn(host: EditorHost): Promise<void> {
  const f = tableFocus(host);
  const cols = f?.table.table?.cols ?? [];
  if (!f || cols.length < 2) return;
  const result = await commit(host, [deleteNode(cols[f.col]!.id)], "Delete column");
  if (result.ok) host.select([f.table.id]);
}

/** Set column `index` width or row `index` height to `emu`. */
export async function tableResizeLine(
  host: EditorHost,
  table: ShapeInfo,
  axis: "col" | "row",
  index: number,
  emu: number,
): Promise<void> {
  const list = axis === "col" ? table.table?.cols : table.table?.rows;
  const item = list?.[index];
  if (!item) return;
  const op = axis === "col" ? resizeTableColumn(item.id, emu) : resizeTableRow(item.id, emu);
  await commit(host, [op], axis === "col" ? "Resize column" : "Resize row");
}

/** Arrow-key nudge: accumulate on the preview, commit one batch after a pause. */
const NUDGE_COMMIT_MS = 600;
const nudgeTimers = new WeakMap<EditorHost, number>();

export function nudge(host: EditorHost, dx: number, dy: number): void {
  const store = storeOf(host);
  const refusal = store.state.disabled["shape-move"];
  if (refusal) {
    notify(
      host,
      `Move is disabled for this session: the engine refused it (${refusal.code}: ${refusal.message}).`,
      "error",
    );
    return;
  }
  const d = deck(host);
  const shapes = selectedShapes(host).filter((s) => s.rect);
  const page = shapes[0] && d?.bySlide.get(shapes[0].slide)?.page;
  if (!page) return;
  const base = store.state.preview?.page === page ? store.state.preview.boxes : {};
  const boxes: Record<Address, Box> = {};
  for (const s of shapes) {
    if (d!.bySlide.get(s.slide)?.page !== page) continue;
    const b = base[s.id] ?? toBox(s.rect!);
    boxes[s.id] = { ...b, x: b.x + dx, y: b.y + dy };
  }
  store.set({ preview: { page, boxes, guides: { x: [], y: [] } } });
  const doc = host.getSnapshot().state?.doc;
  clearTimeout(nudgeTimers.get(host));
  nudgeTimers.set(
    host,
    window.setTimeout(() => {
      const pending = store.state.preview?.boxes;
      if (!pending) return;
      // Another document was opened during the pause: its shapes can share
      // these addresses, so the pending move is dropped, never applied to it.
      if (host.getSnapshot().state?.doc !== doc) store.set({ preview: null });
      else void commitGeometry(host, pending, "Nudge");
    }, NUDGE_COMMIT_MS),
  );
}
