/**
 * `PageOverlay`: selection, direct manipulation, table cells and in-place
 * text editing over one slide's page image. The page image itself belongs to
 * the shell and updates after each commit; until then the selection box shows
 * the previewed geometry.
 */
import { useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { type Address } from "@wolfsdk/protocol";
import { useEditor, type PageOverlayProps } from "../../host/index.ts";
import {
  beginTextEdit,
  canEditText,
  commitGeometry,
  insertAt,
  insertPictureFile,
  isPictureFile,
  notify,
  selectedCells,
  tableResizeLine,
} from "./actions.ts";
import { activeElement } from "./dom.ts";
import {
  HANDLES,
  ORIGIN_HANDLES,
  remap,
  resizeBox,
  snapMove,
  snapTargets,
  type Handle,
  type SnapTargets,
} from "./geometry.ts";
import {
  cellBox,
  contains,
  deckOf,
  shapeBox,
  tableGrid,
  union,
  type Box,
  type ShapeInfo,
  type SlideInfo,
} from "./model.ts";
import { EMU_PER_PT, PICTURE_TYPES } from "./ops.ts";
import { useSlides, type UiState } from "./store.ts";
import { CaretEditor } from "./CaretEditor.tsx";
import { TextEditor } from "./TextEditor.tsx";

type Pt = { x: number; y: number };

type Drag =
  | {
      mode: "move";
      start: Pt;
      boxes: Record<Address, Box>;
      frame: Box;
      targets: SnapTargets;
      moved: boolean;
      /** Clicking (not dragging) an already selected table selects a cell. */
      table: ShapeInfo | null;
      /** Selection to set when the press ends without a drag: one member of a
       * multi-selection alone, or the selection minus a Shift-clicked member. */
      release: Address[] | null;
    }
  | { mode: "resize"; handle: Handle; start: Pt; boxes: Record<Address, Box>; frame: Box; targets: SnapTargets }
  | { mode: "marquee" | "insert"; start: Pt; additive: boolean }
  | { mode: "cells"; table: ShapeInfo; anchor: { row: number; col: number } }
  | {
      mode: "line";
      table: ShapeInfo;
      axis: "col" | "row";
      index: number;
      start: Pt;
      edge: number;
      origin: number;
      scale: number;
    };

/** CSS pixels within which a dragged edge snaps. */
const SNAP_PX = 6;
const DRAG_PX = 3;

function rectBetween(a: Pt, b: Pt, square = false): Box {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

function hitShape(slide: SlideInfo, p: Pt): ShapeInfo | undefined {
  for (let i = slide.shapes.length - 1; i >= 0; i--) {
    const shape = slide.shapes[i]!;
    const b = shapeBox(shape);
    if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return shape;
  }
  return undefined;
}

function cellAt(shape: ShapeInfo, p: Pt): { row: number; col: number } | null {
  const grid = tableGrid(shape);
  if (!grid) return null;
  const col = grid.xs.findIndex((x, i) => i + 1 < grid.xs.length && p.x >= x && p.x < grid.xs[i + 1]!);
  const row = grid.ys.findIndex((y, i) => i + 1 < grid.ys.length && p.y >= y && p.y < grid.ys[i + 1]!);
  return col < 0 || row < 0 ? null : { row, col };
}

function cellRange(shape: ShapeInfo, a: { row: number; col: number }, b: { row: number; col: number }): Address[] {
  const out: Address[] = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
      const cell = shape.table?.cells[r]?.[c];
      if (cell) out.push(cell.id);
    }
  return out;
}

function movable(ui: UiState): boolean {
  return !ui.disabled["shape-move"];
}

/** Resizing from a top/left handle, or a multi-shape frame (members move as
 * the frame scales), needs `move` as well as `resize`. */
function resizable(ui: UiState, shapes: ShapeInfo[], handle: Handle): boolean {
  if ((ORIGIN_HANDLES[handle] || shapes.length > 1) && ui.disabled["shape-move"]) return false;
  return shapes.every((s) => s.kind === "table" || !ui.disabled["shape-resize"]);
}

function px(box: Box, k: number): JSX.CSSProperties {
  return { left: `${box.x * k}px`, top: `${box.y * k}px`, width: `${box.w * k}px`, height: `${box.h * k}px` };
}

export function SlidesOverlay({ host, page, pxPerPt }: PageOverlayProps) {
  const snap = useEditor(host);
  const [ui, store] = useSlides(host);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [rubber, setRubber] = useState<{ box: Box; mode: "marquee" | "insert" } | null>(null);
  const [hover, setHover] = useState<Address | null>(null);

  const state = snap.state;
  if (!state || state.format !== "pptx") return null;
  const deck = deckOf(state);
  const slide = deck.byPage.get(page);
  if (!slide) return null;
  const k = pxPerPt;
  const preview = ui.preview?.page === page ? ui.preview : null;
  const selection = snap.selection;
  const selected = slide.shapes.filter((s) => selection.includes(s.id));
  const boxOf = (s: ShapeInfo): Box | null => preview?.boxes[s.id] ?? shapeBox(s);
  const cells = selectedCells(host).filter((c) => c.table.slide === slide.id);
  const activeTable = cells[0]?.table ?? (selected.length === 1 && selected[0]!.kind === "table" ? selected[0]! : null);

  const toPt = (e: PointerEvent | MouseEvent): Pt => {
    const r = root.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const boxesOf = (shapes: ShapeInfo[]) => {
    const out: Record<Address, Box> = {};
    for (const s of shapes) {
      const b = shapeBox(s);
      if (b) out[s.id] = b;
    }
    return out;
  };
  const targetsExcept = (ids: Address[]) =>
    snapTargets(
      slide.widthPt,
      slide.heightPt,
      slide.shapes
        .filter((s) => !ids.includes(s.id))
        .map(shapeBox)
        .filter((b): b is Box => !!b),
    );

  function begin(e: PointerEvent, next: Drag) {
    drag.current = next;
    root.current?.setPointerCapture(e.pointerId);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // preventDefault below keeps focus where it was: release it so an open
    // text editor commits (blur) and rail keys (Cmd+D duplicates the slide
    // there) stop applying once the user works on the slide.
    const focused = activeElement(e.currentTarget as Node);
    if (focused instanceof HTMLElement) focused.blur();
    // A press outside the caret editor's text (it stops its own) commits and
    // leaves text editing, then acts as usual.
    if (ui.editing?.mode === "caret") store.set({ editing: null });
    host.setCurrentPage(page);
    const p = toPt(e);
    e.preventDefault();
    if (ui.insert) {
      begin(e, { mode: "insert", start: p, additive: false });
      setRubber({ box: { ...p, w: 0, h: 0 }, mode: "insert" });
      return;
    }
    const hit = hitShape(slide!, p);
    if (!hit) {
      if (!e.shiftKey) host.select([]);
      store.set({ cellAnchor: null });
      begin(e, { mode: "marquee", start: p, additive: e.shiftKey });
      setRubber({ box: { ...p, w: 0, h: 0 }, mode: "marquee" });
      return;
    }
    if (hit.kind === "table" && cells.some((c) => c.table.id === hit.id)) {
      const at = cellAt(hit, p);
      if (at) {
        const anchorCell = ui.cellAnchor ? deck.cells.get(ui.cellAnchor) : undefined;
        const anchor = e.shiftKey && anchorCell?.table === hit.id ? anchorCell : at;
        host.select(cellRange(hit, anchor, at));
        if (!e.shiftKey) store.set({ cellAnchor: hit.table?.cells[at.row]?.[at.col]?.id ?? null });
        begin(e, { mode: "cells", table: hit, anchor });
        return;
      }
    }
    if (e.shiftKey) {
      // Shift-click toggles membership; Shift-drag moves the selection
      // (including the pressed shape) constrained to one axis.
      const had = selection.includes(hit.id);
      const members = had ? selection : [...selection, hit.id];
      if (!had) host.select(members);
      const group = slide!.shapes.filter((s) => members.includes(s.id));
      const boxes = boxesOf(group);
      const frame = union(Object.values(boxes));
      if (!frame) return;
      begin(e, {
        mode: "move",
        start: p,
        boxes,
        frame,
        targets: targetsExcept(group.map((s) => s.id)),
        moved: false,
        table: null,
        release: had ? selection.filter((id) => id !== hit.id) : null,
      });
      return;
    }
    const wasOnlyTable = hit.kind === "table" && selection.length === 1 && selection[0] === hit.id;
    const group = selection.includes(hit.id) ? slide!.shapes.filter((s) => selection.includes(s.id)) : [hit];
    if (!selection.includes(hit.id)) host.select([hit.id]);
    const boxes = boxesOf(group);
    const frame = union(Object.values(boxes));
    if (!frame) return;
    begin(e, {
      mode: "move",
      start: p,
      boxes,
      frame,
      targets: targetsExcept(group.map((s) => s.id)),
      moved: false,
      table: wasOnlyTable ? hit : null,
      release: selection.length > 1 && selection.includes(hit.id) ? [hit.id] : null,
    });
  }

  function onHandleDown(e: PointerEvent, handle: Handle) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!resizable(ui, selected, handle)) {
      const viaMove = (ORIGIN_HANDLES[handle] || selected.length > 1) && ui.disabled["shape-move"];
      const err = viaMove ? ui.disabled["shape-move"] : ui.disabled["shape-resize"];
      notify(
        host,
        `${viaMove ? "This resize needs move, which" : "Resize"} is disabled for this session: the engine refused it (${err?.code ?? "unsupported"}).`,
        "error",
      );
      return;
    }
    const boxes = boxesOf(selected);
    const frame = union(Object.values(boxes));
    if (!frame) return;
    begin(e, {
      mode: "resize",
      handle,
      start: toPt(e),
      boxes,
      frame,
      targets: targetsExcept(selected.map((s) => s.id)),
    });
  }

  function onLineDown(e: PointerEvent, table: ShapeInfo, axis: "col" | "row", index: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const grid = tableGrid(table);
    if (!grid) return;
    const edges = axis === "col" ? grid.xs : grid.ys;
    begin(e, {
      mode: "line",
      table,
      axis,
      index,
      start: toPt(e),
      edge: edges[index + 1]!,
      origin: edges[index]!,
      scale: axis === "col" ? grid.sx : grid.sy,
    });
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current;
    const p = toPt(e);
    if (!d) {
      const hit = ui.insert ? undefined : hitShape(slide!, p);
      if ((hit?.id ?? null) !== hover) setHover(hit?.id ?? null);
      return;
    }
    const tolerance = SNAP_PX / k;
    if (d.mode === "move") {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * k < DRAG_PX) return;
      if (!d.moved) {
        if (!movable(ui)) {
          drag.current = null;
          notify(
            host,
            `Move is disabled for this session: the engine refused it (${ui.disabled["shape-move"]?.code}: ${ui.disabled["shape-move"]?.message}).`,
            "error",
          );
          return;
        }
        d.moved = true;
      }
      // Shift constrains the move to the dominant axis.
      const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx);
      const lockY = e.shiftKey && !lockX;
      const moved = { ...d.frame, x: d.frame.x + (lockX ? 0 : dx), y: d.frame.y + (lockY ? 0 : dy) };
      const snapped = e.altKey ? { box: moved, guides: { x: [], y: [] } } : snapMove(moved, d.targets, tolerance);
      const ox = lockX ? 0 : snapped.box.x - d.frame.x;
      const oy = lockY ? 0 : snapped.box.y - d.frame.y;
      const guides = { x: lockX ? [] : snapped.guides.x, y: lockY ? [] : snapped.guides.y };
      const boxes: Record<Address, Box> = {};
      for (const [id, b] of Object.entries(d.boxes)) boxes[id] = { ...b, x: b.x + ox, y: b.y + oy };
      store.set({ preview: { page, boxes, guides } });
      store.set({ preview: { page, boxes, guides: snapped.guides } });
    } else if (d.mode === "resize") {
      const r = resizeBox(
        d.frame,
        d.handle,
        p.x - d.start.x,
        p.y - d.start.y,
        e.altKey ? null : d.targets,
        tolerance,
        e.shiftKey,
      );
      const boxes: Record<Address, Box> = {};
      for (const [id, b] of Object.entries(d.boxes)) boxes[id] = remap(b, d.frame, r.box);
      store.set({ preview: { page, boxes, guides: r.guides } });
    } else if (d.mode === "marquee" || d.mode === "insert") {
      setRubber({ box: rectBetween(d.start, p, d.mode === "insert" && e.shiftKey), mode: d.mode });
    } else if (d.mode === "cells") {
      const at = cellAt(d.table, p);
      if (at) host.select(cellRange(d.table, d.anchor, at));
    } else if (d.mode === "line") {
      const delta = d.axis === "col" ? p.x - d.start.x : p.y - d.start.y;
      const at = Math.max(d.origin + 4, d.edge + delta);
      const grid = tableGrid(d.table)!;
      const line =
        d.axis === "col"
          ? { axis: "x" as const, at, from: grid.ys[0]!, to: grid.ys[grid.ys.length - 1]! }
          : { axis: "y" as const, at, from: grid.xs[0]!, to: grid.xs[grid.xs.length - 1]! };
      store.set({ preview: { page, boxes: {}, guides: { x: [], y: [] }, tableLine: line } });
    }
  }

  async function onPointerUp(e: PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (root.current?.hasPointerCapture(e.pointerId)) root.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    const p = toPt(e);
    if (d.mode === "move") {
      const boxes = store.state.preview?.boxes;
      if (d.moved && boxes)
        await commitGeometry(host, boxes, Object.keys(d.boxes).length > 1 ? "Move shapes" : "Move shape");
      else if (!d.moved && d.release) host.select(d.release);
      else if (!d.moved && d.table) {
        const at = cellAt(d.table, p);
        const cell = at && d.table.table?.cells[at.row]?.[at.col];
        if (cell) {
          host.select([cell.id]);
          store.set({ cellAnchor: cell.id });
        }
      }
    } else if (d.mode === "resize") {
      const boxes = store.state.preview?.boxes;
      if (boxes) await commitGeometry(host, boxes, Object.keys(d.boxes).length > 1 ? "Resize shapes" : "Resize shape");
    } else if (d.mode === "marquee") {
      const box = rectBetween(d.start, p);
      setRubber(null);
      if (box.w * k < DRAG_PX && box.h * k < DRAG_PX) return;
      const inside = slide!.shapes.filter((s) => {
        const b = shapeBox(s);
        return b && contains(box, b);
      });
      host.select(
        inside.map((s) => s.id),
        { additive: d.additive },
      );
    } else if (d.mode === "insert") {
      const box = rectBetween(d.start, p, e.shiftKey);
      setRubber(null);
      if (ui.insert) await insertAt(host, slide!, ui.insert, box);
    } else if (d.mode === "line") {
      const line = store.state.preview?.tableLine;
      store.set({ preview: null });
      if (!line) return;
      const pt = (line.at - d.origin) / d.scale;
      await tableResizeLine(host, d.table, d.axis, d.index, pt * EMU_PER_PT);
    }
  }

  function onDoubleClick(e: MouseEvent) {
    if (ui.insert || ui.editing) return;
    const p = toPt(e);
    const hit = hitShape(slide!, p);
    if (!hit) return;
    if (hit.kind === "table") {
      const at = cellAt(hit, p);
      const cell = at && hit.table?.cells[at.row]?.[at.col];
      if (!cell) return;
      host.select([cell.id]);
      store.set({ cellAnchor: cell.id });
      beginTextEdit(host, cell.id, "cell", page, { at: { ...p, client: [e.clientX, e.clientY] } });
      return;
    }
    if (hit.kind !== "text") {
      notify(host, `${hit.label} has no editable text (${hit.kind}).`);
      return;
    }
    if (!canEditText(hit)) {
      notify(host, `${hit.label}: the engine cut this text in the view, so it cannot be edited here.`, "error");
      return;
    }
    host.select([hit.id]);
    beginTextEdit(host, hit.id, "shape", page, { at: { ...p, client: [e.clientX, e.clientY] } });
  }

  const frame = union(selected.map(boxOf).filter((b): b is Box => !!b));
  const hovered = hover && !selection.includes(hover) ? slide.shapes.find((s) => s.id === hover) : undefined;
  const hoverBox = hovered && shapeBox(hovered);
  const grid = activeTable && !ui.editing ? tableGrid(activeTable) : null;
  const editingBox = (() => {
    const ed = ui.editing;
    if (!ed || ed.page !== page) return null;
    if (ed.kind === "shape") {
      const shape = deck.shapes.get(ed.target);
      return shape ? shapeBox(shape) : null;
    }
    const at = deck.cells.get(ed.target);
    const table = at && deck.shapes.get(at.table);
    return table ? cellBox(table, at!.row, at!.col) : null;
  })();
  const cursor = ui.insert ? "crosshair" : hover ? (movable(ui) ? "move" : "default") : "default";

  // An image file dropped on the slide becomes a picture; the event stops
  // here so a shell that opens dropped documents does not take it. Other
  // drops (a document to open) pass through.
  const carriesPicture = (e: DragEvent) =>
    [...(e.dataTransfer?.items ?? [])].some((item) => item.kind === "file" && PICTURE_TYPES.includes(item.type));
  const onDragOver = (e: DragEvent) => {
    if (!carriesPicture(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = snap.busy ? "none" : "copy";
  };
  const onDrop = (e: DragEvent) => {
    const picture = [...(e.dataTransfer?.files ?? [])].find(isPictureFile);
    if (!picture) return;
    e.preventDefault();
    e.stopPropagation();
    if (!snap.busy) void insertPictureFile(host, picture, toPt(e), slide);
  };

  return (
    <div
      ref={root}
      class="we-slides-layer"
      data-testid={`slides-overlay-${page}`}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => !drag.current && setHover(null)}
      onDblClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {hoverBox && <div class="we-slides-hover" style={px(hoverBox, k)} />}
      {selected.map((s) => {
        const b = boxOf(s);
        return b ? (
          <div
            key={s.id}
            class="we-slides-selected"
            data-testid={`slides-selected-${s.id}`}
            data-shape={s.id}
            style={px(b, k)}
          />
        ) : null;
      })}
      {cells.map((c) => {
        const b = cellBox(c.table, c.row, c.col);
        return b ? (
          <div
            key={c.node.id}
            class="we-slides-cell"
            data-testid={`slides-cell-${c.row + 1}-${c.col + 1}`}
            style={px(b, k)}
          />
        ) : null;
      })}
      {frame && !ui.editing && cells.length === 0 && (
        <div class="we-slides-frame" data-testid="slides-selection-frame" style={px(frame, k)}>
          {HANDLES.map((h) => {
            const ok = resizable(ui, selected, h);
            return (
              <div
                key={h}
                class={`we-slides-handle we-slides-handle-${h}${ok ? "" : " we-slides-handle-off"}`}
                data-testid={`slides-handle-${h}`}
                title={ok ? `Resize (${h})` : "Resize refused by the engine for this session"}
                onPointerDown={(e) => onHandleDown(e, h)}
              />
            );
          })}
        </div>
      )}
      {grid &&
        activeTable &&
        activeTable.table!.cols.map((_, i) => (
          <div
            key={`c${i}`}
            class="we-slides-line we-slides-line-col"
            data-testid={`slides-col-handle-${i + 1}`}
            title={`Resize column ${i + 1}`}
            style={{
              left: `${grid.xs[i + 1]! * k - 3}px`,
              top: `${grid.ys[0]! * k}px`,
              height: `${(grid.ys[grid.ys.length - 1]! - grid.ys[0]!) * k}px`,
            }}
            onPointerDown={(e) => onLineDown(e, activeTable, "col", i)}
          />
        ))}
      {grid &&
        activeTable &&
        activeTable.table!.rows.map((_, i) => (
          <div
            key={`r${i}`}
            class="we-slides-line we-slides-line-row"
            data-testid={`slides-row-handle-${i + 1}`}
            title={`Resize row ${i + 1}`}
            style={{
              top: `${grid.ys[i + 1]! * k - 3}px`,
              left: `${grid.xs[0]! * k}px`,
              width: `${(grid.xs[grid.xs.length - 1]! - grid.xs[0]!) * k}px`,
            }}
            onPointerDown={(e) => onLineDown(e, activeTable, "row", i)}
          />
        ))}
      {preview?.guides.x.map((x) => (
        <div key={`gx${x}`} class="we-slides-guide we-slides-guide-x" style={{ left: `${x * k}px` }} />
      ))}
      {preview?.guides.y.map((y) => (
        <div key={`gy${y}`} class="we-slides-guide we-slides-guide-y" style={{ top: `${y * k}px` }} />
      ))}
      {preview?.tableLine && (
        <div
          class="we-slides-guide we-slides-table-line"
          style={
            preview.tableLine.axis === "x"
              ? {
                  left: `${preview.tableLine.at * k}px`,
                  top: `${preview.tableLine.from * k}px`,
                  height: `${(preview.tableLine.to - preview.tableLine.from) * k}px`,
                }
              : {
                  top: `${preview.tableLine.at * k}px`,
                  left: `${preview.tableLine.from * k}px`,
                  width: `${(preview.tableLine.to - preview.tableLine.from) * k}px`,
                }
          }
        />
      )}
      {rubber && (
        <div
          class={rubber.mode === "insert" ? "we-slides-insert-rect" : "we-slides-marquee"}
          data-testid={rubber.mode === "insert" ? "slides-insert-rect" : "slides-marquee"}
          style={px(rubber.box, k)}
        />
      )}
      {ui.editing && ui.editing.page === page && editingBox && ui.editing.mode === "caret" && (
        <CaretEditor key={ui.editing.target} host={host} editing={ui.editing} box={editingBox} pxPerPt={k} />
      )}
      {ui.editing && ui.editing.page === page && editingBox && ui.editing.mode === "box" && (
        <TextEditor key={ui.editing.target} host={host} editing={ui.editing} box={editingBox} pxPerPt={k} />
      )}
    </div>
  );
}
