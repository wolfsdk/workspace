// A small workbook engine that lives in memory, for the tests of live cells. A workbook is canonical JSON (the same grid
// always has the same bytes and so the same sha256), the room server's `DocumentEngine` applies `set` and `merge` to it,
// and `GridPool` answers the four commands live cells sends a worker (`open`, `extract`, `sheet_viewport`, `close`) the
// way the released engine does, as far as live cells reads them.
import { createHash } from "node:crypto";
import type { ReactorPipeEntitlement, ReactorPipeRequest, RoomBatch, RoomOp } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, EngineRefusal, type EngineWorker, type ReplayInput, type ReplayResult, type WorkerPool } from "@wolfsdk/server";

export type GridCell = {
  value?: { string: string } | { number: number } | { bool: boolean } | { error: string };
  formula?: string;
  /** What the engine calculated, shown to the reader. */
  display?: string;
};
export type GridSheet = { name: string; visibility?: "visible" | "hidden"; kind?: "worksheet" | "chartsheet"; cells: Record<string, GridCell>; merged?: string[] };
export type Grid = { sheets: GridSheet[] };

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a grid: cells sorted by address, so that equal grids are equal bytes. */
export function gridBytes(grid: Grid): Uint8Array {
  const sorted = grid.sheets.map((sheet) => ({
    ...sheet,
    cells: Object.fromEntries(Object.entries(sheet.cells).sort(([a], [b]) => a.localeCompare(b))),
  }));
  return encoder.encode(JSON.stringify({ sheets: sorted }));
}

export const gridSha256 = (grid: Grid): string => sha256(gridBytes(grid));

function parseGrid(bytes: Uint8Array): Grid {
  try {
    const grid = JSON.parse(new TextDecoder().decode(bytes)) as Grid;
    if (Array.isArray(grid.sheets)) return grid;
  } catch {
    // Refused below.
  }
  throw new EngineRefusal("invalid-input", "the bytes are not a grid", "open");
}

const CELL_TARGET = /^sheet:(#[0-9]+|[^/#][^/]*)\/cell:([A-Z]+[0-9]+)$/;
const RANGE_TARGET = /^sheet:(#[0-9]+|[^/#][^/]*)\/range:([A-Z]+[0-9]+:[A-Z]+[0-9]+)$/;

function sheetOf(grid: Grid, ref: string): GridSheet | undefined {
  if (ref.startsWith("#")) return grid.sheets[Number(ref.slice(1)) - 1];
  const name = decodeURIComponent(ref);
  return grid.sheets.find((sheet) => sheet.name === name);
}

function applyOp(grid: Grid, op: RoomOp): void {
  if (op.op === "set") {
    const match = typeof op.target === "string" ? CELL_TARGET.exec(op.target) : null;
    const sheet = match === null ? undefined : sheetOf(grid, match[1]!);
    if (match === null || sheet === undefined) throw new EngineRefusal("address-unresolved", `no cell ${String(op.target)}`, "apply", "target");
    const value = op.value as Record<string, unknown>;
    const a1 = match[2]!;
    if ("empty" in value) delete sheet.cells[a1];
    else if ("number" in value) sheet.cells[a1] = { value: { number: value.number as number }, display: String(value.number) };
    else if ("string" in value) sheet.cells[a1] = { value: { string: value.string as string }, display: value.string as string };
    else if ("boolean" in value) sheet.cells[a1] = { value: { bool: value.boolean as boolean }, display: value.boolean ? "TRUE" : "FALSE" };
    else if ("formula" in value) sheet.cells[a1] = { formula: value.formula as string, display: "" };
    else throw new EngineRefusal("op-kind-mismatch", "the value is not one the engine knows", "apply", "value");
    return;
  }
  if (op.op === "merge") {
    const match = typeof op.target === "string" ? RANGE_TARGET.exec(op.target) : null;
    const sheet = match === null ? undefined : sheetOf(grid, match[1]!);
    if (match === null || sheet === undefined) throw new EngineRefusal("address-unresolved", `no range ${String(op.target)}`, "apply", "target");
    (sheet.merged ??= []).push(match[2]!);
    return;
  }
  throw new EngineRefusal("unknown-op", `the op ${JSON.stringify(op.op)} is not known`, "apply", "op");
}

function applyBatch(bytes: Uint8Array, batch: RoomBatch): Uint8Array {
  const grid = parseGrid(bytes);
  for (const op of batch.ops) applyOp(grid, op);
  return gridBytes(grid);
}

export const GRID_ENTITLEMENT: ReactorPipeEntitlement = {
  tier: "commercial",
  max_workspaces: null,
  max_seats: null,
  sso: false,
  oem_offline_wasm: false,
  key_id: null,
  expires_at: null,
};

/** The `DocumentEngine` of the room server over grids. */
export class GridEngine implements DocumentEngine {
  async entitlement(): Promise<ReactorPipeEntitlement> {
    return GRID_ENTITLEMENT;
  }

  async replay(input: ReplayInput): Promise<ReplayResult> {
    parseGrid(input.bytes);
    let bytes = input.bytes;
    const steps: ReplayResult["steps"] = [];
    for (const batch of input.batches) {
      const before = sha256(bytes);
      bytes = applyBatch(bytes, batch);
      steps.push({ base_sha256: before, sha256: sha256(bytes) });
    }
    return { format: input.format, base_sha256: sha256(input.bytes), steps, bytes: input.save ? bytes : null, page_hashes: null };
  }

  async close(): Promise<void> {}
}

const COLUMN = /^([A-Z]+)([0-9]+)$/;
const columnOf = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

function viewportCell(a1: string, cell: GridCell): Record<string, unknown> {
  const [, letters, row] = COLUMN.exec(a1)!;
  return {
    a1,
    row: Number(row),
    col: columnOf(letters!),
    value: cell.value ?? null,
    formula: cell.formula ?? null,
    display: cell.display ?? "",
    display_trimmed: cell.display ?? "",
    style_id: 0,
    color: null,
  };
}

/** The part of the released engine's worker that live cells reads, over grids. Counts what it was asked. */
export class GridPool implements Pick<WorkerPool, "withWorker"> {
  /** Documents opened, and so reads that were not answered from a cache. */
  opens = 0;
  readonly #docs = new Map<number, Grid>();
  #next = 1;

  withWorker<T>(job: (worker: EngineWorker) => Promise<T>): Promise<T> {
    const worker: EngineWorker = { call: (request, segments = []) => this.#call(request, segments), discard: () => undefined };
    return job(worker);
  }

  async #call(request: ReactorPipeRequest, segments: readonly Uint8Array[]): Promise<{ body: never; segments: Uint8Array[] }> {
    const answer = (body: Record<string, unknown>, out: Uint8Array[] = []) => ({ body: { ms: 0, ok: true, ...body } as never, segments: out });
    switch (request.cmd) {
      case "open": {
        const bytes = segments[request.bytes.bin]!;
        this.opens++;
        const doc = this.#next++;
        this.#docs.set(doc, parseGrid(bytes));
        return answer({ cmd: "open", doc, format: "xlsx", sha256: sha256(bytes), bytes: bytes.length, revision: 0, determinism: { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 } });
      }
      case "extract": {
        const grid = this.#docs.get(request.doc)!;
        const structure = grid.sheets.map((sheet, i) => ({
          index: i + 1,
          name: sheet.name,
          kind: sheet.kind ?? "worksheet",
          visibility: sheet.visibility ?? "visible",
          merged_ranges: sheet.merged ?? [],
        }));
        const data = encoder.encode(JSON.stringify({ sheets: structure }));
        return answer({ cmd: "extract", receipt: {}, format: "xlsx", outputs: [{ path: "/mem/out/book.structure.json", data: { bin: 0, len: data.length } }] }, [data]);
      }
      case "sheet_viewport": {
        const grid = this.#docs.get(request.doc)!;
        const sheet = typeof request.sheet === "number" ? grid.sheets[request.sheet - 1] : grid.sheets.find((s) => s.name === request.sheet);
        if (sheet === undefined) return { body: { cmd: "sheet_viewport", ok: false, ms: 0, error: { code: "bad-request", message: "sheet must name a sheet or be a 1-based index" } } as never, segments: [] };
        const row0 = request.row0 ?? 1;
        const col0 = request.col0 ?? 1;
        const rows = request.rows ?? 1;
        const cols = request.cols ?? 1;
        const inside = (a1: string): boolean => {
          const [, letters, row] = COLUMN.exec(a1)!;
          const col = columnOf(letters!);
          return Number(row) >= row0 && Number(row) < row0 + rows && col >= col0 && col < col0 + cols;
        };
        const reaches = (range: string): boolean => {
          const [from, to] = range.split(":") as [string, string];
          const [, l1, r1] = COLUMN.exec(from)!;
          const [, l2, r2] = COLUMN.exec(to)!;
          return Number(r1) < row0 + rows && Number(r2) >= row0 && columnOf(l1!) < col0 + cols && columnOf(l2!) >= col0;
        };
        const cells = Object.entries(sheet.cells)
          .filter(([a1]) => inside(a1))
          .map(([a1, cell]) => viewportCell(a1, cell));
        return answer({
          cmd: "sheet_viewport",
          sheet: sheet.name,
          sheets: grid.sheets.map((s, i) => ({ index: i + 1, name: s.name })),
          row0,
          col0,
          rows,
          cols,
          cells,
          columns: [],
          row_heights: [],
          merged: (sheet.merged ?? []).filter(reaches),
          styles: {},
          revision: 0,
        });
      }
      case "close":
        this.#docs.delete(request.doc);
        return answer({ cmd: "close", doc: request.doc });
      default:
        throw new Error(`the grid pool does not answer ${request.cmd}`);
    }
  }
}
