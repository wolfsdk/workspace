/**
 * Engine data beyond the cell nodes.
 *
 * Module with grid metadata (docs/engine-ops-xlsx.md): cell nodes carry
 * `display` and `style`, sheet nodes carry `grid`, and the view-level
 * `workbook` (style table) and `sheets` arrive in `DocState.viewMeta`
 * (`parseViewMeta`). No query is needed.
 *
 * Older module (`viewMeta` is `{}`, docs/ops-xlsx.md 3.3): sheet structure
 * and merged ranges (`extract --what structure`) and number-formatted
 * display strings (`extract --what markdown`: one table per sheet,
 * positional from the used range's top-left cell), once per revision.
 *
 * Ranged observes page in cells left out of a truncated view.
 *
 * Every query result is keyed by the sha256 the engine actually read
 * (receipt `inputs[0].sha256`), so a query that ran after a newer apply can
 * never be attributed to the wrong revision.
 */
import type { DocId, KernelClient, QueryResult, ViewNode } from "@wolfsdk/protocol";
import { parseRange, type Rect } from "./refs.ts";
import { cellKey, type WorkbookModel } from "./model.ts";
import { parseEngineGrid, parseEngineStyles, type CellStyle, type EngineGrid } from "./meta.ts";

export type SheetStructure = {
  name: string;
  /** 1-based position. */
  index: number;
  visibility: string;
  used: Rect | null;
  merges: Rect[];
};

export type MarkdownSheet = { name: string; index: number; rows: string[][] };

/** A sheet grid from a ranged observe's `sheets[]`. */
export type SheetGrid = { id: string; label: string; grid: EngineGrid };

/** Extract-based reads of one revision (older module only). */
export type RevisionReads = {
  sha256: string;
  structure: SheetStructure[];
  markdown: MarkdownSheet[];
};

/** What the grid uses from `DocState.viewMeta`: the resolved
 * `workbook.styles` (null when absent: older module) and the sheet grids of
 * `sheets[{id,label,grid}]` (ranged views). */
export type ViewMeta = { styles: CellStyle[] | null; grids: SheetGrid[] };

export function parseViewMeta(meta: Record<string, unknown>): ViewMeta {
  const grids: SheetGrid[] = [];
  for (const s of Array.isArray(meta.sheets) ? meta.sheets : []) {
    const o = s as { id?: unknown; label?: unknown; grid?: unknown };
    const grid = parseEngineGrid(o.grid);
    if (grid)
      grids.push({ id: typeof o.id === "string" ? o.id : "", label: typeof o.label === "string" ? o.label : "", grid });
  }
  return { styles: parseEngineStyles(meta.workbook), grids };
}

/** The module's observe carries grid metadata: `viewMeta.workbook` or
 * `viewMeta.sheets`, or a sheet `grid` / cell `display`/`style` member on
 * the nodes. Other view-level members (`contract`, `format`,
 * `source_sha256` on every module) do not count. */
export function hasEngineGrid(nodes: readonly ViewNode[], viewMeta: Record<string, unknown> = {}): boolean {
  if (viewMeta.workbook !== undefined || viewMeta.sheets !== undefined) return true;
  for (const n of nodes) {
    if (n.kind === "sheet" && n.grid && typeof n.grid === "object") return true;
    if (n.kind === "cell") return typeof n.display === "string" || typeof n.style === "number";
  }
  return false;
}

const decoder = new TextDecoder();

function inputSha(result: QueryResult): string {
  const inputs = result.receipt.inputs as { sha256?: string }[] | undefined;
  return inputs?.[0]?.sha256 ?? "";
}

function fileText(result: QueryResult, suffix: string): string | null {
  const f = result.files.find((x) => x.name.endsWith(suffix));
  return f ? decoder.decode(f.bytes) : null;
}

export function parseStructure(json: string): SheetStructure[] {
  const data = JSON.parse(json) as {
    sheets?: {
      name?: string;
      index?: number;
      visibility?: string;
      dimensions?: { ref?: string };
      merged_ranges?: string[];
    }[];
  };
  return (data.sheets ?? []).map((s, i) => ({
    name: s.name ?? "",
    index: s.index ?? i + 1,
    visibility: s.visibility ?? "visible",
    used: s.dimensions?.ref ? parseRange(s.dimensions.ref) : null,
    merges: (s.merged_ranges ?? []).map((m) => parseRange(m)).filter((r): r is Rect => r !== null),
  }));
}

/** Split one markdown table line into unescaped cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  // Skip the leading pipe; the trailing one closes the last cell.
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[i + 1];
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return cells;
}

export function parseMarkdown(md: string): MarkdownSheet[] {
  const out: MarkdownSheet[] = [];
  let sheet: MarkdownSheet | null = null;
  for (const line of md.split("\n")) {
    const marker = /^<!-- sheet (\d+) -->$/.exec(line.trim());
    if (marker) {
      sheet = { name: "", index: Number(marker[1]), rows: [] };
      out.push(sheet);
      continue;
    }
    if (!sheet) continue;
    if (line.startsWith("# ") && !sheet.name && sheet.rows.length === 0) {
      sheet.name = line.slice(2).replace(/\\(.)/g, "$1").trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    sheet.rows.push(splitRow(line));
  }
  return out;
}

export async function loadRevisionReads(kernel: KernelClient, doc: DocId): Promise<RevisionReads> {
  const structure = await kernel.query(doc, { verb: "extract", args: ["--what", "structure"] });
  const markdown = await kernel.query(doc, { verb: "extract", args: ["--what", "markdown"] });
  const sha = inputSha(structure);
  if (inputSha(markdown) !== sha) {
    // An apply landed between the two reads: report the newer revision's
    // structure as missing rather than mixing two revisions.
    return { sha256: inputSha(markdown), structure: [], markdown: parseMarkdown(fileText(markdown, ".md") ?? "") };
  }
  return {
    sha256: sha,
    structure: parseStructure(fileText(structure, ".structure.json") ?? "{}"),
    markdown: parseMarkdown(fileText(markdown, ".md") ?? ""),
  };
}

/** Ranged observe of one sheet rectangle (`sheet:#N/range:A1:K50`). */
export async function loadRange(
  kernel: KernelClient,
  doc: DocId,
  target: string,
): Promise<{ sha256: string; nodes: ViewNode[]; truncated: boolean }> {
  const result = await kernel.query(doc, { verb: "observe", args: ["--target", target] });
  const text = fileText(result, ".view.json");
  const view = text ? (JSON.parse(text) as { nodes?: ViewNode[]; truncated?: boolean }) : { nodes: [] };
  return { sha256: inputSha(result), nodes: view.nodes ?? [], truncated: Boolean(view.truncated) };
}

// ---------------------------------------------------------------------------
// Display strings
// ---------------------------------------------------------------------------

/** Number-formatted display strings of number cells, per sheetId:
 * cell key -> { number it was formatted from, text }. */
export type DisplayMap = Map<number, Map<number, { n: number; text: string }>>;

const firstLine = (s: string) => s.split(/\r?\n/)[0]!.trim();

/**
 * Align each sheet's markdown table with the model: row 0 of the table is
 * the used range's top-left row. The alignment is checked against string
 * cells (their text must match); a sheet that does not align gets no
 * display strings (raw values are shown).
 */
export function buildDisplay(model: WorkbookModel, reads: RevisionReads): { map: DisplayMap; unaligned: string[] } {
  const map: DisplayMap = new Map();
  const unaligned: string[] = [];
  for (const sheet of model.sheets) {
    const st =
      reads.structure.find((s) => s.name === sheet.name) ?? reads.structure.find((s) => s.index === sheet.position);
    const md =
      reads.markdown.find((m) => m.name === sheet.name) ?? reads.markdown.find((m) => m.index === sheet.position);
    if (!md || md.rows.length === 0) continue;
    let r0 = st?.used?.r1 ?? 1;
    let c0 = st?.used?.c1 ?? 1;
    if (!st?.used) {
      // No structure: the table starts at the smallest occupied row / col.
      r0 = Infinity;
      c0 = Infinity;
      for (const c of sheet.cells.values()) {
        r0 = Math.min(r0, c.row);
        c0 = Math.min(c0, c.col);
      }
      if (!Number.isFinite(r0)) continue;
    }
    // The markdown table leaves hidden rows and columns out (they are listed
    // in `wolf-hidden` blocks instead).
    const hiddenRows = [...sheet.hiddenRows].sort((a, b) => a - b);
    const hiddenCols = [...sheet.hiddenCols].sort((a, b) => a - b);
    const at = (row: number, col: number): string | undefined => {
      if (sheet.hiddenRows.has(row) || sheet.hiddenCols.has(col)) return undefined;
      const r = row - r0 - countBetween(hiddenRows, r0, row);
      const c = col - c0 - countBetween(hiddenCols, c0, col);
      return md.rows[r]?.[c];
    };
    let checked = 0;
    let matched = 0;
    for (const c of sheet.cells.values()) {
      if (checked >= 40) break;
      const v = c.value;
      if (!v || !("string" in v) || !v.string.trim() || v.string.includes("\n")) continue;
      if (sheet.hiddenRows.has(c.row) || sheet.hiddenCols.has(c.col)) continue;
      checked++;
      if ((at(c.row, c.col) ?? "") === firstLine(v.string)) matched++;
    }
    if (checked > 0 && matched < checked * 0.7) {
      unaligned.push(sheet.name);
      continue;
    }
    const m = new Map<number, { n: number; text: string }>();
    for (const c of sheet.cells.values()) {
      const v = c.value;
      if (!v || !("number" in v)) continue;
      const text = at(c.row, c.col);
      if (text) m.set(cellKey(c.row, c.col), { n: v.number, text });
    }
    map.set(sheet.sheetId, m);
  }
  return { map, unaligned };
}

/** Number of entries of sorted `xs` in [from, to). */
function countBetween(xs: number[], from: number, to: number): number {
  let n = 0;
  for (const x of xs) {
    if (x >= to) break;
    if (x >= from) n++;
  }
  return n;
}
