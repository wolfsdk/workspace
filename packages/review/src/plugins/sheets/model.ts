/**
 * Workbook model derived from `DocState.nodes`: sheets in workbook order and
 * a sparse cell map per sheet. Table cells (listed under `table:T/...`
 * nodes, not under their sheet) are merged in by `a1`; a table belongs to
 * the sheet node that precedes it in document order (the engine lists a
 * sheet's tables after its own cells, docs/ops-xlsx.md 3.2).
 */
import type { TypedValue, ViewNode } from "@wolfsdk/protocol";
import { parseA1 } from "./refs.ts";

export type CellData = {
  /** Canonical address of the node (`sheet:#1/cell:B2` or a table cell). */
  id: string;
  row: number;
  col: number;
  a1: string;
  value?: TypedValue;
  formula?: string;
  visible: boolean;
  hiddenReason?: string;
  node: ViewNode;
};

export type SheetModel = {
  /** Stable `sheetId` from `sheet:#N`. */
  sheetId: number;
  id: string;
  name: string;
  /** 1-based workbook position. */
  position: number;
  visible: boolean;
  hiddenReason?: string;
  node: ViewNode;
  cells: Map<number, CellData>;
  maxRow: number;
  maxCol: number;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
};

export type WorkbookModel = {
  sheets: SheetModel[];
  byId: Map<number, SheetModel>;
  /** Owning sheetId of every non-sheet node that has one (tables, table rows). */
  ownerOf: Map<string, number>;
};

/** Sparse map key for (row, col). Columns are at most 16384. */
export const cellKey = (row: number, col: number) => row * 16400 + col;

const SHEET_ID = /^sheet:#(\d+)$/;

export function sheetIdOf(address: string): number | null {
  const m = /^sheet:#(\d+)(?:\/|$)/.exec(address);
  return m ? Number(m[1]) : null;
}

/** Build the model from view nodes (`extra`: cells loaded by ranged
 * observes for a truncated view, same node shape). */
export function buildModel(nodes: readonly ViewNode[], extra: readonly ViewNode[] = []): WorkbookModel {
  const sheets: SheetModel[] = [];
  const byId = new Map<number, SheetModel>();
  const nodeSheet = new Map<string, SheetModel>();
  let current: SheetModel | null = null;

  const addCell = (sheet: SheetModel, n: ViewNode) => {
    const a1 = typeof n.a1 === "string" ? n.a1 : null;
    const at = a1 ? parseA1(a1) : null;
    if (!a1 || !at) return;
    const cell: CellData = {
      id: n.id,
      row: at.row,
      col: at.col,
      a1,
      value: n.value,
      formula: typeof n.formula === "string" ? n.formula : undefined,
      visible: n.visible !== false,
      hiddenReason: n.hidden_reason,
      node: n,
    };
    sheet.cells.set(cellKey(at.row, at.col), cell);
    if (at.row > sheet.maxRow) sheet.maxRow = at.row;
    if (at.col > sheet.maxCol) sheet.maxCol = at.col;
    if (n.hidden_reason === "hidden-row") sheet.hiddenRows.add(at.row);
    if (n.hidden_reason === "hidden-column") sheet.hiddenCols.add(at.col);
  };

  const findOwner = (n: ViewNode): SheetModel | null => {
    const sid = sheetIdOf(n.id);
    if (sid !== null) return byId.get(sid) ?? null;
    const viaParent = n.parent ? nodeSheet.get(n.parent) : undefined;
    if (viaParent) return viaParent;
    const table = /^(table:[^/]+)/.exec(n.id)?.[1];
    return table ? (nodeSheet.get(table) ?? null) : null;
  };

  for (const n of nodes) {
    const m = SHEET_ID.exec(n.id);
    if (n.kind === "sheet" && m) {
      const sheet: SheetModel = {
        sheetId: Number(m[1]),
        id: n.id,
        name: n.label ?? n.id,
        position: sheets.length + 1,
        visible: n.visible !== false,
        hiddenReason: n.hidden_reason,
        node: n,
        cells: new Map(),
        maxRow: 0,
        maxCol: 0,
        hiddenRows: new Set(),
        hiddenCols: new Set(),
      };
      sheets.push(sheet);
      byId.set(sheet.sheetId, sheet);
      current = sheet;
      continue;
    }
    if (n.kind === "table" && n.parent === null && current) {
      nodeSheet.set(n.id, current);
      continue;
    }
    const owner = findOwner(n);
    if (!owner) continue;
    nodeSheet.set(n.id, owner);
    if (n.kind === "cell") addCell(owner, n);
  }
  for (const n of extra) {
    const owner = findOwner(n);
    if (owner && n.kind === "cell") addCell(owner, n);
  }
  const ownerOf = new Map<string, number>();
  for (const [id, sheet] of nodeSheet) ownerOf.set(id, sheet.sheetId);
  return { sheets, byId, ownerOf };
}

export function isErrorValue(value: TypedValue | undefined): boolean {
  return (
    !!value &&
    "string" in value &&
    /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!|GETTING_DATA|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)$/.test(
      value.string,
    )
  );
}

/** Text shown in the formula bar / editor for a cell. */
export function editText(cell: CellData | undefined): string {
  if (!cell) return "";
  if (cell.formula) return cell.formula;
  const v = cell.value;
  if (!v) return "";
  if ("number" in v) return String(v.number);
  if ("boolean" in v) return v.boolean ? "TRUE" : "FALSE";
  if ("string" in v) return v.string;
  if ("text" in v) return v.text;
  return "";
}

/** Excel "General" rendering of a number (up to 11 significant digits). */
export function formatGeneral(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = n.toExponential(5).split("e") as [string, string];
    const mant = m.replace(/\.?0+$/, "");
    const exp = Number(e);
    return `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = Number(n.toPrecision(11)).toString();
  return s.includes("e") ? n.toFixed(10).replace(/\.?0+$/, "") : s;
}
