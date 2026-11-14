/**
 * A slides-shaped reading of one `DocState`: slides in presentation order,
 * their shapes with geometry, tables, paragraphs and notes. Derived, never
 * cached across revisions (memoised per `DocState` object).
 */
import type { Address, DocState, ViewNode } from "@wolfsdk/protocol";
import { EMU_PER_PT, type AddressedLine, type EmuRect } from "./ops.ts";

/** Points from the slide's top-left corner. */
export type Box = { x: number; y: number; w: number; h: number };

export type ShapeKind = "text" | "picture" | "table" | "chart" | "group";

export type TableInfo = {
  cols: { id: Address; emu: number }[];
  rows: { id: Address; emu: number }[];
  /** `cells[r][c]`: address of the cell in row r, column c (0-based). */
  cells: (ViewNode | undefined)[][];
};

export type ShapeInfo = {
  id: Address;
  slide: Address;
  node: ViewNode;
  label: string;
  kind: ShapeKind;
  /** Geometry in EMU: the node's engine `geometry` when present, else the
   * region box. Null when the shape was not drawn. */
  rect: EmuRect | null;
  /** True when `rect` came from the engine's geometry members. */
  exact: boolean;
  /** Nearest enclosing group (`geometry.group`); grouped shapes are listed
   * as slide children too and reorder among their group's siblings. */
  group: Address | null;
  /** Paragraph nodes in order (text shapes). */
  paragraphs: ViewNode[];
  table: TableInfo | null;
};

export type SlideInfo = {
  id: Address;
  /** 1-based page = slide position. */
  page: number;
  title: string;
  widthPt: number;
  heightPt: number;
  /** Shapes in z-order (back to front). */
  shapes: ShapeInfo[];
  notes: ViewNode | null;
  notesParagraphs: ViewNode[];
};

export type Deck = {
  slides: SlideInfo[];
  byPage: Map<number, SlideInfo>;
  bySlide: Map<Address, SlideInfo>;
  shapes: Map<Address, ShapeInfo>;
  /** Cell address -> owning table shape and its row/column (0-based). */
  cells: Map<Address, { table: Address; row: number; col: number }>;
};

type Geometry = { x: number; y: number; cx: number; cy: number };

function engineGeometry(node: ViewNode): Geometry | null {
  const g = node.geometry as Partial<Geometry> | undefined;
  if (!g || typeof g !== "object") return null;
  const { x, y, cx, cy } = g;
  if (typeof x !== "number" || typeof y !== "number" || typeof cx !== "number" || typeof cy !== "number") return null;
  return { x, y, cx, cy };
}

function groupOf(node: ViewNode): Address | null {
  const g = node.geometry;
  return g && typeof g === "object" && "group" in g && typeof g.group === "string" ? g.group : null;
}

function shapeKind(node: ViewNode, childKinds: Set<string>): ShapeKind {
  if (childKinds.has("row") || childKinds.has("col")) return "table";
  if (childKinds.has("chart")) return "chart";
  const label = node.label ?? "";
  if (/^Group\b/i.test(label)) return "group";
  if (typeof node.text !== "string") return "picture";
  if (/^Picture\b/i.test(label) && node.text === "") return "picture";
  return "text";
}

const decks = new WeakMap<DocState, Deck>();

export function deckOf(state: DocState): Deck {
  const known = decks.get(state);
  if (known) return known;
  const nodes = new Map(state.nodes.map((n) => [n.id, n]));
  const regionOf = new Map<Address, { page: number; bbox: [number, number, number, number] }>();
  for (const r of state.regions)
    if (!regionOf.has(r.object_id)) regionOf.set(r.object_id, { page: r.page, bbox: r.bbox_pt });
  const kids = (id: Address) => (state.childIds[id] ?? []).map((c) => nodes.get(c)).filter((n): n is ViewNode => !!n);
  const pageSize = new Map(state.pages.map((p) => [p.page, p]));

  const deck: Deck = { slides: [], byPage: new Map(), bySlide: new Map(), shapes: new Map(), cells: new Map() };
  const slideNodes = (state.childIds[""] ?? [])
    .map((id) => nodes.get(id))
    .filter((n) => n?.kind === "slide") as ViewNode[];
  slideNodes.forEach((slideNode, index) => {
    const page = regionOf.get(slideNode.id)?.page ?? index + 1;
    const size = pageSize.get(page);
    const slide: SlideInfo = {
      id: slideNode.id,
      page,
      title: "",
      widthPt: size?.widthPt ?? regionOf.get(slideNode.id)?.bbox[2] ?? 720,
      heightPt: size?.heightPt ?? regionOf.get(slideNode.id)?.bbox[3] ?? 540,
      shapes: [],
      notes: null,
      notesParagraphs: [],
    };
    for (const child of kids(slideNode.id)) {
      if (child.kind === "notes") {
        slide.notes = child;
        slide.notesParagraphs = kids(child.id).filter((n) => n.kind === "paragraph");
        continue;
      }
      if (child.kind !== "shape") continue;
      const children = kids(child.id);
      const kind = shapeKind(child, new Set(children.map((c) => c.kind)));
      const geometry = engineGeometry(child);
      const region = regionOf.get(child.id);
      const rect: EmuRect | null = geometry
        ? geometry
        : region
          ? {
              x: region.bbox[0] * EMU_PER_PT,
              y: region.bbox[1] * EMU_PER_PT,
              cx: region.bbox[2] * EMU_PER_PT,
              cy: region.bbox[3] * EMU_PER_PT,
            }
          : null;
      let table: TableInfo | null = null;
      if (kind === "table") {
        const num = (n: ViewNode) => {
          const v = n.value as { number?: number } | undefined;
          return typeof v?.number === "number" ? v.number : 0;
        };
        const rows = children.filter((c) => c.kind === "row");
        table = {
          cols: children.filter((c) => c.kind === "col").map((c) => ({ id: c.id, emu: num(c) })),
          rows: rows.map((r) => ({ id: r.id, emu: num(r) })),
          cells: rows.map((r) => kids(r.id).filter((c) => c.kind === "cell")),
        };
        table.cells.forEach((row, r) =>
          row.forEach((cell, c) => cell && deck.cells.set(cell.id, { table: child.id, row: r, col: c })),
        );
      }
      const info: ShapeInfo = {
        id: child.id,
        slide: slideNode.id,
        node: child,
        label: child.label ?? child.id,
        kind,
        rect,
        exact: !!geometry,
        group: groupOf(child),
        paragraphs: kind === "text" ? children.filter((c) => c.kind === "paragraph") : [],
        table,
      };
      slide.shapes.push(info);
      deck.shapes.set(info.id, info);
      if (!slide.title && kind === "text" && child.text) slide.title = child.text.split("\n")[0]!;
    }
    deck.slides.push(slide);
    deck.byPage.set(page, slide);
    deck.bySlide.set(slide.id, slide);
  });
  decks.set(state, deck);
  return deck;
}

export function toBox(rect: EmuRect): Box {
  return { x: rect.x / EMU_PER_PT, y: rect.y / EMU_PER_PT, w: rect.cx / EMU_PER_PT, h: rect.cy / EMU_PER_PT };
}

export function toRect(box: Box): EmuRect {
  return { x: box.x * EMU_PER_PT, y: box.y * EMU_PER_PT, cx: box.w * EMU_PER_PT, cy: box.h * EMU_PER_PT };
}

export function shapeBox(shape: ShapeInfo): Box | null {
  return shape.rect ? toBox(shape.rect) : null;
}

/** Column x edges and row y edges of a table, in points, scaled so the grid
 * fills the frame box (the view does not recompute the frame after a column
 * resize, ops-pptx.md 3.7). */
export function tableGrid(shape: ShapeInfo): { xs: number[]; ys: number[]; sx: number; sy: number } | null {
  const box = shapeBox(shape);
  const table = shape.table;
  if (!box || !table) return null;
  const colSum = table.cols.reduce((a, c) => a + c.emu, 0) / EMU_PER_PT;
  const rowSum = table.rows.reduce((a, r) => a + r.emu, 0) / EMU_PER_PT;
  // Columns are authoritative for width; rows grow with their text, so the
  // drawn frame height is used only when the rows sum to less.
  const sx = colSum > 0 ? box.w / colSum : 1;
  const sy = rowSum > 0 && rowSum < box.h ? box.h / rowSum : 1;
  const xs = [box.x];
  for (const c of table.cols) xs.push(xs[xs.length - 1]! + (c.emu / EMU_PER_PT) * sx);
  const ys = [box.y];
  for (const r of table.rows) ys.push(ys[ys.length - 1]! + (r.emu / EMU_PER_PT) * sy);
  return { xs, ys, sx, sy };
}

export function cellBox(shape: ShapeInfo, row: number, col: number): Box | null {
  const grid = tableGrid(shape);
  if (!grid || row + 1 >= grid.ys.length || col + 1 >= grid.xs.length) return null;
  return {
    x: grid.xs[col]!,
    y: grid.ys[row]!,
    w: grid.xs[col + 1]! - grid.xs[col]!,
    h: grid.ys[row + 1]! - grid.ys[row]!,
  };
}

/**
 * Lines of a text body paired with their paragraph addresses. The view lists
 * a paragraph per line in the normal case; when the counts disagree, the
 * nonempty lines are paired with the listed paragraphs in order and empty
 * lines get no address.
 */
export function addressedLines(text: string, paragraphs: ViewNode[]): AddressedLine[] {
  const lines = text.split("\n");
  if (lines.length === paragraphs.length) return lines.map((t, i) => ({ address: paragraphs[i]!.id, text: t }));
  let k = 0;
  return lines.map((t) => {
    if (t === "") return { address: null, text: t };
    const para = paragraphs[k];
    if (para && para.text === t) {
      k++;
      return { address: para.id, text: t };
    }
    return { address: null, text: t };
  });
}

/** The engine cuts long text with U+2026; such text cannot be edited safely. */
export function isCut(text: string | undefined): boolean {
  return !!text && text.length > 200 && text.endsWith("\u2026");
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
