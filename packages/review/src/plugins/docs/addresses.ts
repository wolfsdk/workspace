/**
 * Address rules for DOCX (docs/ops-docx.md section 2):
 * - Paragraph ids come from the view as is. A `para:#<paraId>` id is stable;
 *   `para:~<hash>` changes when the text changes (and duplicates get `.2`
 *   suffixes); `para:@<n>` is positional and shifts on insert/delete. The
 *   engine's `address_map` covers text re-hashes but not positional shifts,
 *   and maps `@` ids by slot, which is wrong after an insert. So every cached
 *   address is remapped by aligning the paragraph sequence of the base and
 *   result revisions (text equality + `address_map` for `~`/`#` ids).
 * - Tables, rows and cells are addressed positionally
 *   (`table:@t/row:@r/cell:@c`): hash and text forms change on any cell edit.
 *   Which paragraph sits in which cell comes from the structure model
 *   (`structure.ts`), aligned to the view paragraphs by text.
 */
import type { Address, DocState, TransactionSummary, ViewNode } from "@wolfsdk/protocol";
import { observedStructure, type CellPosition, type StructureModel, type StructurePara } from "./structure.ts";

export type Para = {
  id: Address;
  node: ViewNode;
  /** Ordinal among all paragraph nodes (body, cells, headers, footers). */
  index: number;
  /** Body paragraph (`para:` id; table cells included); false in headers/footers. */
  body: boolean;
  /** Style, table cell and indent from observe. */
  pkg: StructurePara | null;
  cell: CellPosition | null;
  runs: ViewNode[];
  /** Child nodes other than runs (images, hyperlinks, fields, bookmarks, ...). */
  inline: ViewNode[];
};

export type TableShape = { index: number; rows: number[] /* cell count per row */ };

export type DocModel = {
  state: DocState;
  pkg: StructureModel;
  paras: Para[];
  byId: Map<Address, Para>;
  tables: Map<number, TableShape>;
};

// ---------------------------------------------------------------------------
// Address builders
// ---------------------------------------------------------------------------

export const tableAddress = (table: number): Address => `table:@${table}`;
export const rowAddress = (table: number, row: number): Address => `table:@${table}/row:@${row}`;
export const cellAddress = (cell: CellPosition): Address => `table:@${cell.table}/row:@${cell.row}/cell:@${cell.col}`;

/** `para:X/span:<text>`: the engine binds the first occurrence of `text`. */
export function spanAddress(para: Address, text: string): Address {
  return `${para}/span:${text}`;
}

/** The span form is only usable when the range is the first occurrence and
 * the text cannot be misread as address grammar. */
export function spanUsable(paraText: string, start: number, end: number): boolean {
  if (end <= start) return false;
  const text = paraText.slice(start, end);
  if (/[/\n\t]/.test(text)) return false;
  return paraText.indexOf(text) === start;
}

/** The paragraph part of a nested address (`para:X/run:@1` -> `para:X`). */
export function paragraphOf(address: Address): Address {
  const slash = address.search(/\/(run|span|link|image|field):/);
  return slash >= 0 ? address.slice(0, slash) : address;
}

export const isHeaderFooter = (id: Address): boolean => id.startsWith("section:");

// ---------------------------------------------------------------------------
// Sequence alignment
// ---------------------------------------------------------------------------

/**
 * Map each index of `a` to an index of `b` (or -1): longest common
 * subsequence under `eq`, then unmatched runs of equal length between two
 * matches are paired in order (paragraphs edited in place).
 */
export function alignSequences<A, B>(a: A[], b: B[], eq: (x: A, y: B) => boolean): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && eq(a[head]!, b[head]!)) {
    map[head] = head;
    head++;
  }
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && eq(a[tailA]!, b[tailB]!)) {
    map[tailA] = tailB;
    tailA--;
    tailB--;
  }
  const n = tailA - head + 1;
  const m = tailB - head + 1;
  if (n > 0 && m > 0) {
    if (n * m <= 4_000_000) {
      // LCS table over the middle, then walk back.
      const width = m + 1;
      const dp = new Uint16Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * width + j] = eq(a[head + i]!, b[head + j]!)
            ? dp[(i + 1) * width + j + 1]! + 1
            : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (eq(a[head + i]!, b[head + j]!) && dp[i * width + j] === dp[(i + 1) * width + j + 1]! + 1) {
          map[head + i] = head + j;
          i++;
          j++;
        } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) i++;
        else j++;
      }
    }
  }
  // Pair equal-length unmatched gaps.
  let prevA = -1;
  let prevB = -1;
  const pairGap = (endA: number, endB: number): void => {
    const lenA = endA - prevA - 1;
    const lenB = endB - prevB - 1;
    if (lenA > 0 && lenA === lenB) for (let k = 1; k <= lenA; k++) map[prevA + k] = prevB + k;
  };
  for (let i = 0; i < a.length; i++) {
    const j = map[i]!;
    if (j < 0) continue;
    pairGap(i, j);
    prevA = i;
    prevB = j;
  }
  pairGap(a.length, b.length);
  return map;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const models = new WeakMap<DocState, DocModel>();

/** View model of one revision, with style, numbering and table-cell data from observe. */
export function buildModel(state: DocState): DocModel {
  const cached = models.get(state);
  if (cached) return cached;
  const pkg = observedStructure(state);
  const paras: Para[] = [];
  const byId = new Map<Address, Para>();
  const nodes = new Map(state.nodes.map((n) => [n.id, n]));
  for (const node of state.nodes) {
    if (node.kind !== "paragraph") continue;
    const kids = (state.childIds[node.id] ?? []).flatMap((id) => nodes.get(id) ?? []);
    const structure = pkg.paragraphs.get(node.id) ?? null;
    const para: Para = {
      id: node.id,
      node,
      index: paras.length,
      body: !isHeaderFooter(node.id),
      pkg: structure,
      cell: structure?.cell ?? null,
      runs: kids.filter((k) => k.kind === "run"),
      inline: kids.filter((k) => k.kind !== "run"),
    };
    paras.push(para);
    byId.set(node.id, para);
  }
  const tables = new Map<number, TableShape>();
  for (const { cell } of paras) {
    if (!cell) continue;
    let shape = tables.get(cell.table);
    if (!shape) tables.set(cell.table, (shape = { index: cell.table, rows: [] }));
    shape.rows[cell.row - 1] = Math.max(shape.rows[cell.row - 1] ?? 0, cell.col);
  }
  const model: DocModel = { state, pkg, paras, byId, tables };
  models.set(state, model);
  return model;
}

export const sameCell = (a: CellPosition | null, b: CellPosition | null): boolean =>
  !!a && !!b && a.table === b.table && a.row === b.row && a.col === b.col;

/** Previous / next paragraph in reading order within the same container
 * (same table cell, or the body outside tables). */
export function neighbour(model: DocModel, para: Para, step: -1 | 1): Para | null {
  if (!para.body) return null;
  const next = model.paras[para.index + step];
  if (!next || !next.body) return null;
  if (para.cell || next.cell) return sameCell(para.cell, next.cell) ? next : null;
  return next;
}

/** Nearest body paragraph outside tables in direction `step` (moving skips over tables). */
export function bodyNeighbour(model: DocModel, para: Para, step: -1 | 1): Para | null {
  for (let i = para.index + step; i >= 0 && i < model.paras.length; i += step) {
    const p = model.paras[i]!;
    if (!p.body) return null;
    if (!p.cell) return p;
  }
  return null;
}

export function paraInCell(model: DocModel, cell: CellPosition): Para | null {
  return model.paras.find((p) => sameCell(p.cell, cell)) ?? null;
}

/** Cell after `cell` in row-major order (Tab), or before it (Shift+Tab). */
export function stepCell(model: DocModel, cell: CellPosition, step: 1 | -1): CellPosition | null {
  const shape = model.tables.get(cell.table);
  if (!shape) return null;
  let { row, col } = cell;
  col += step;
  if (col < 1) {
    row -= 1;
    col = shape.rows[row - 1] ?? 0;
  } else if (col > (shape.rows[row - 1] ?? 0)) {
    row += 1;
    col = 1;
  }
  if (row < 1 || row > shape.rows.length || col < 1) return null;
  return { table: cell.table, row, col };
}

// ---------------------------------------------------------------------------
// Remapping after an apply / undo / redo
// ---------------------------------------------------------------------------

export type Remapper = (id: Address) => Address | null;

/**
 * Build a function from base-revision addresses to result-revision addresses.
 * `transaction` is the apply's summary when there is one (none for undo/redo).
 */
export function remapper(before: DocState, after: DocState, transaction?: TransactionSummary | null): Remapper {
  const present = new Set(after.nodes.map((n) => n.id));
  const textMap = new Map<Address, Address>();
  for (const m of transaction?.address_map ?? []) {
    // Positional before-ids are mapped by slot by the engine; ignore them.
    if (!m.before.includes("@")) textMap.set(m.before, m.after);
  }
  const a = before.nodes.filter((n) => n.kind === "paragraph");
  const b = after.nodes.filter((n) => n.kind === "paragraph");
  const map = alignSequences(a, b, (x, y) => {
    if (x.id.startsWith("para:#") || y.id.startsWith("para:#")) return x.id === y.id;
    const mapped = textMap.get(x.id);
    if (mapped !== undefined) return mapped === y.id;
    return (x.text ?? "") === (y.text ?? "") && isHeaderFooter(x.id) === isHeaderFooter(y.id);
  });
  const paraMap = new Map<Address, Address>();
  a.forEach((x, i) => {
    if (map[i]! >= 0) paraMap.set(x.id, b[map[i]!]!.id);
  });
  return (id) => {
    const direct = paraMap.get(id);
    if (direct) return direct;
    const para = paragraphOf(id);
    if (para !== id && paraMap.has(para)) {
      const moved = paraMap.get(para)! + id.slice(para.length);
      return present.has(moved) ? moved : paraMap.get(para)!;
    }
    const mapped = textMap.get(id);
    if (mapped && present.has(mapped)) return mapped;
    return present.has(id) ? id : null;
  };
}

export function remapAll(remap: Remapper, ids: Address[]): Address[] {
  const out: Address[] = [];
  for (const id of ids) {
    const next = remap(id);
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}
