/**
 * Document structure `observe` paragraphs alone do not give the editor: the
 * paragraph styles the document defines (style picker, heading levels), and
 * for each paragraph its style, table cell and left indent.
 * `observedStructure(state)` builds it from the engine's view: the top-level
 * `styles` list, paragraph `format`, and cell `grid_column` / `col_span`
 * (engine-ops-docx.md, observe members).
 */
import type { Address, DocState, ViewNode } from "@wolfsdk/protocol";

export type StyleInfo = {
  id: string;
  /** Display name (`w:name`), falling back to the id. */
  name: string;
  isDefault: boolean;
  /** 1-9 for heading styles (observe `outline_level`, 1-based). */
  heading: number | null;
  /** Not offered in the style picker (observe `hidden` or `semi_hidden`). */
  hidden: boolean;
};

/** `col` is the cell's 1-based position in its row (the `cell:@n` address); `gridCol`
 * (0-based) and `colSpan` place it in the table grid, which column operations index. */
export type CellPosition = { table: number; row: number; col: number; gridCol?: number; colSpan?: number };

export type StructurePara = {
  /** Paragraph style id, null when the paragraph uses the default style. */
  style: string | null;
  /** 1-based position of the enclosing top-level table cell. */
  cell: CellPosition | null;
  /** Left indent in points. */
  leftPt: number | null;
};

export type StructureModel = {
  styles: StyleInfo[];
  defaultStyle: string | null;
  /** Every paragraph of the view, by address. */
  paragraphs: Map<Address, StructurePara>;
};

export type ListKind = "bullet" | "number";

export function styleById(model: StructureModel, id: string | null): StyleInfo | undefined {
  const wanted = id ?? model.defaultStyle;
  return model.styles.find((s) => s.id === wanted);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** observe `styles[]` entry (`{id, name, type, based_on?, outline_level?, default?, hidden?, semi_hidden?}`). */
function observedStyle(entry: Record<string, unknown>): StyleInfo | null {
  if (entry.type !== "paragraph" || typeof entry.id !== "string") return null;
  const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.id;
  // `outline_level` is 1-based: 1 is Heading 1.
  const outline =
    typeof entry.outline_level === "number" && entry.outline_level >= 1 && entry.outline_level <= 9
      ? entry.outline_level
      : null;
  const named = /^heading ([1-9])$/i.exec(name);
  return {
    id: entry.id,
    name,
    isDefault: entry.default === true,
    heading: outline ?? (named ? Number(named[1]) : null),
    hidden: entry.hidden === true || entry.semi_hidden === true,
  };
}

const observed = new WeakMap<DocState, StructureModel>();

/** The structure model from the engine's view (cached per revision). */
export function observedStructure(state: DocState): StructureModel {
  let model = observed.get(state);
  if (!model) observed.set(state, (model = buildObserved(state)));
  return model;
}

function buildObserved(state: DocState): StructureModel {
  const byId = new Map<Address, ViewNode>(state.nodes.map((n) => [n.id, n]));

  // Top-level tables numbered 1.. in document order; rows and cells by position under their parent.
  const tableNumber = new Map<Address, number>();
  for (const n of state.nodes) if (n.kind === "table" && n.parent === null) tableNumber.set(n.id, tableNumber.size + 1);
  const ordinal = (node: ViewNode, kind: string): number => {
    const siblings = (state.childIds[node.parent ?? ""] ?? []).filter((id) => byId.get(id)?.kind === kind);
    return siblings.indexOf(node.id) + 1;
  };
  // Cell paragraphs name their cell as parent; nested tables resolve to the outermost cell.
  const cellOf = (node: ViewNode): CellPosition | null => {
    let outer: CellPosition | null = null;
    for (
      let at = node.parent ? byId.get(node.parent) : undefined;
      at;
      at = at.parent ? byId.get(at.parent) : undefined
    ) {
      if (at.kind !== "cell") continue;
      const row = at.parent ? byId.get(at.parent) : undefined;
      const table = row?.parent ? tableNumber.get(row.parent) : undefined;
      if (row && table !== undefined) {
        outer = { table, row: ordinal(row, "row"), col: ordinal(at, "cell") };
        if (typeof at.grid_column === "number") outer.gridCol = at.grid_column;
        if (typeof at.col_span === "number") outer.colSpan = at.col_span;
      }
    }
    return outer;
  };

  const paragraphs = new Map<Address, StructurePara>();
  for (const node of state.nodes) {
    if (node.kind !== "paragraph") continue;
    const format = record(node.format);
    paragraphs.set(node.id, {
      style: typeof format?.style === "string" ? format.style : null,
      cell: cellOf(node),
      leftPt: typeof format?.left === "number" ? format.left : null,
    });
  }
  const list: unknown[] = Array.isArray(state.viewMeta.styles) ? state.viewMeta.styles : [];
  const styles = list.flatMap((entry) => {
    const style = record(entry) && observedStyle(entry as Record<string, unknown>);
    return style ? [style] : [];
  });
  return { styles, defaultStyle: styles.find((s) => s.isDefault)?.id ?? null, paragraphs };
}
