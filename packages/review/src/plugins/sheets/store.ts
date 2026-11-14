/**
 * Plugin-local state shared by the sheets slots (toolbar, grid, bottom
 * bar): active sheet, selection, in-place editing, clipboard, per-revision
 * engine reads, and every user action that turns into an op batch.
 *
 * One store per `EditorHost` (WeakMap). Document state is never copied
 * here: the model is re-derived from `host.getSnapshot().state` per
 * revision.
 */
import type { ApplyResult, DocState, KernelError, Op, ViewNode } from "@wolfsdk/protocol";
import type { EditorHost, HistoryEntry } from "../../host/index.ts";
import { KernelRequestError } from "@wolfsdk/protocol";
import { isReactorKernel, type ReactorKernelClient } from "@wolfsdk/protocol";
import { useEffect, useState } from "preact/hooks";
import {
  buildModel,
  cellKey,
  editText,
  formatGeneral,
  isErrorValue,
  sheetIdOf,
  type CellData,
  type SheetModel,
  type WorkbookModel,
} from "./model.ts";
import {
  buildDisplay,
  hasEngineGrid,
  loadRange,
  loadRevisionReads,
  parseViewMeta,
  type DisplayMap,
  type RevisionReads,
  type ViewMeta,
} from "./reads.ts";
import {
  cellStyle,
  deriveSessionLayout,
  engineLayout,
  parseEngineGrid,
  pxToChars,
  pxToPt,
  type CellStyle,
  type SheetLayout,
} from "./meta.ts";
import * as ops from "./ops.ts";
import { dispatch, GRID_KEYS } from "./keys.ts";
import {
  deriveSessionLinks,
  formulaLink,
  nodeLink,
  openableUrl,
  parseLinkInput,
  type Link,
  type LinkMap,
} from "./links.ts";
import {
  emptyBook,
  mergeReply,
  tileOf,
  tilesFor,
  tileWindow,
  TILE_COLS,
  TILE_ROWS,
  viewportLayout,
  vpText,
  type VpBook,
  type VpCell,
  type VpSheet,
} from "./viewport.ts";
import { GridFonts } from "./fonts.ts";
import { parseInput, parseTsv, toTsv } from "./parse.ts";
import {
  MAX_COLS,
  MAX_ROWS,
  colToNum,
  normRect,
  parseA1,
  parseNameBox,
  parseRange,
  rectContains,
  rectIntersect,
  rectLabel,
  rectSubtract,
  toA1,
  type Cell,
  type Rect,
} from "./refs.ts";

export const SOURCE = "sheets";
/** Refusal codes that mean "this engine module cannot do that": the control
 * that issued the batch is disabled for the rest of the session. Other
 * codes (`unsupported` is about the construct, not the module) are shown
 * and the control stays enabled. */
const DISABLE_CODES = new Set(["op-kind-mismatch", "op-not-implemented"]);
/** `usage` naming an operation the module does not know also means the
 * module cannot do it. */
const UNKNOWN_OP = /is not a supported Agent API operation/;
const disablesControl = (e: KernelError) =>
  DISABLE_CODES.has(e.code) || (e.code === "usage" && UNKNOWN_OP.test(e.message));
/** One `visibility` op per row/column: a bound on one Hide batch. */
const MAX_VISIBILITY_OPS = 10_000;
type RunOpts = { explain?: (e: KernelError) => string };

export type Selection = { ranges: Rect[]; active: Cell; anchor: Cell };
export type Editing = {
  text: string;
  /** Where the user is typing. */
  source: "cell" | "bar";
  /** `enter`: started by typing (arrows commit); `edit`: F2 / double-click. */
  mode: "enter" | "edit";
  sheetId: number;
  row: number;
  col: number;
};
export type Notice = { text: string; code?: string; kind: "error" | "info" };
export type Viewport = {
  sheetId: number;
  r1: number;
  r2: number;
  c1: number;
  c2: number;
  pageRows: number;
  pageCols: number;
};

type Clip = { sheetId: number; rect: Rect; tsv: string; cut: boolean };

const stores = new WeakMap<EditorHost, SheetsStore>();

export function getStore(host: EditorHost): SheetsStore {
  let s = stores.get(host);
  if (!s) {
    s = new SheetsStore(host);
    stores.set(host, s);
  }
  return s;
}

/** Re-render on host publishes and store changes. */
export function useSheets(host: EditorHost): SheetsStore {
  const store = getStore(host);
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const a = host.subscribe(bump);
    const b = store.subscribe(bump);
    const unmount = store.mount();
    bump();
    return () => {
      a();
      b();
      unmount();
    };
  }, [host, store]);
  return store;
}

function errorOf(cause: unknown): KernelError {
  if (cause instanceof KernelRequestError) return cause.error;
  return { code: "sheets-read-failed", message: cause instanceof Error ? cause.message : String(cause) };
}

export class SheetsStore {
  readonly host: EditorHost;
  private listeners = new Set<() => void>();

  activeSheetId: number | null = null;
  private selBySheet = new Map<number, Selection>();
  editing: Editing | null = null;
  view: "grid" | "print" = "grid";
  /** Controls disabled after an engine refusal, with that refusal. */
  disabled = new Map<string, KernelError>();
  notice: Notice | null = null;
  clip: Clip | null = null;
  viewport: Viewport | null = null;
  /** Values typed but not yet applied: "sheetId:key" -> text. */
  pending = new Map<string, string>();
  /** Bumped to ask the grid to scroll the active cell into view / focus. */
  revealSeq = 0;
  focusSeq = 0;
  /** Last `host.reveal({ address })` aimed at this workbook, for the grid
   * to scroll to (selection untouched); bumped per request. */
  hostReveal: { sheetId: number; row: number; col: number } | null = null;
  hostRevealSeq = 0;
  private lastRevealSeq: number | null = null;

  // Per-revision caches.
  private modelFor: { state: DocState; extraCount: number; model: WorkbookModel } | null = null;
  private reads = new Map<string, RevisionReads>();
  private readsInFlight = new Set<string>();
  readError: KernelError | null = null;
  private displayFor: { sha: string; model: WorkbookModel; map: DisplayMap; unaligned: string[] } | null = null;
  private lastDisplay: DisplayMap | null = null;
  private layoutFor = new Map<string, SheetLayout>();
  private layoutKey: { state: DocState | null; historyLength: number } = { state: null, historyLength: -1 };
  private viewMetaFor: { state: DocState; meta: ViewMeta } | null = null;
  /** Truncated views: cells from ranged observes, per revision sha. */
  private extra = new Map<string, ViewNode[]>();
  /** Loaded ranges per revision sha (labels for the banner). */
  loadedRanges = new Map<string, string[]>();
  private rangesInFlight = new Set<string>();
  private lastSha = "";
  private lastDoc: DocState["doc"] | null = null;

  /** Reactor kernel: the grid reads `sheetViewport` tiles (`viewport.ts`)
   * instead of `query extract`, which that kernel does not have. */
  readonly reactor: ReactorKernelClient | null;
  /** Tiles of the current revision. */
  private vpBook: VpBook | null = null;
  /** Tiles of the previous revision, painted only where the current one has
   * not arrived yet; dropped once it has every wanted tile. */
  private vpStale: VpBook | null = null;
  /** Tiles the grid wants now (latest request wins: scrolling coalesces). */
  private vpWant: { sheet: string; tiles: number[] } | null = null;
  private vpBusy = false;
  private vpFailed = new Set<string>();
  /** Tiles whose reply named another revision once (refetched once). */
  private vpMismatch = new Set<string>();
  private vpLayouts = new WeakMap<VpSheet, { version: number; used: Rect | null; layout: SheetLayout }>();
  private vpDefault: SheetLayout | null = null;
  /** Viewport request timings (harness and status). */
  vpStats = { requests: 0, lastMs: 0, totalMs: 0, cells: 0, mismatches: 0 };
  /** Engine faces for cell text: reactor kernel, while a sheets view is
   * mounted and a workbook is open (one `ResourceStore` per document). */
  fonts: GridFonts | null = null;
  /** Bumped when faces finish loading (grid repaint key). */
  fontsVersion = 0;
  /** Mounted `useSheets` views. */
  private mounts = 0;

  constructor(host: EditorHost) {
    this.host = host;
    this.reactor = isReactorKernel(host.kernel) ? host.kernel : null;
    host.subscribe(() => this.onHostChange());
    this.onHostChange();
  }

  /** A view mounted; the returned function unmounts it. Faces are loaded
   * while at least one view is mounted and released after the last. */
  mount(): () => void {
    this.mounts++;
    if (this.mounts === 1) this.openFonts();
    return () => {
      if (--this.mounts === 0) this.closeFonts();
    };
  }

  private openFonts(): void {
    const state = this.state;
    if (this.fonts || !this.reactor || !state || this.mounts === 0) return;
    const fonts = new GridFonts(this.reactor, () => {
      if (this.fonts !== fonts) return;
      this.fontsVersion++;
      this.changed();
    });
    this.fonts = fonts;
    fonts.open(state.doc);
  }

  private closeFonts(): void {
    if (!this.fonts) return;
    this.fonts.dispose();
    this.fonts = null;
    this.fontsVersion++;
  }

  /** Workbook default font (reactor replies), or null. */
  get defaultFont(): { name: string; sizePt: number } | null {
    return this.vpBook?.defaultFont ?? this.vpStale?.defaultFont ?? null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    for (const fn of [...this.listeners]) fn();
  }

  get state(): DocState | null {
    const s = this.host.getSnapshot().state;
    return s && s.format === "xlsx" ? s : null;
  }

  private onHostChange(): void {
    const state = this.state;
    if (!state) {
      // Closed: release the document's faces.
      if (this.lastDoc !== null) {
        this.lastDoc = null;
        this.closeFonts();
      }
      return;
    }
    if (state.doc !== this.lastDoc) {
      // Another document: nothing of the previous one's UI state applies.
      this.lastDoc = state.doc;
      this.closeFonts();
      this.openFonts();
      this.activeSheetId = null;
      this.selBySheet.clear();
      this.editing = null;
      this.clip = null;
      this.pending.clear();
      this.notice = null;
      this.disabled.clear();
      this.linkDialog = null;
      this.lastDisplay = null;
      this.viewport = null;
      this.vpBook = null;
      this.vpStale = null;
      this.vpWant = null;
      this.vpFailed.clear();
      this.vpMismatch.clear();
      // A reopened file has the same sha: start its reads afresh.
      this.lastSha = "";
    }
    if (state.sha256 !== this.lastSha) {
      this.lastSha = state.sha256;
      if (this.reactor) {
        if (this.vpBook?.sheets.size) this.vpStale = this.vpBook;
        this.vpBook = emptyBook(state.sha256, state.revision);
        this.pumpViewport();
      } else this.ensureReads(state);
    }
    const model = this.model;
    if (!model) return;
    if (this.activeSheetId === null || !model.byId.has(this.activeSheetId)) {
      const first = model.sheets.find((s) => s.visible) ?? model.sheets[0];
      this.activeSheetId = first?.sheetId ?? null;
      this.editing = null;
      this.changed();
    }
    this.handleReveal(model);
  }

  /** Act on a new `EditorSnapshot.reveal` naming a cell, range, row,
   * column or sheet of this workbook; page reveals are the print view's
   * business and are ignored. */
  private handleReveal(model: WorkbookModel): void {
    const reveal = this.host.getSnapshot().reveal;
    if (!reveal || reveal.seq === this.lastRevealSeq) return;
    this.lastRevealSeq = reveal.seq;
    if (!("address" in reveal)) return;
    const target = resolveAddress(model, reveal.address);
    if (!target) return;
    this.switchSheet(target.sheetId);
    this.hostReveal = target;
    this.hostRevealSeq++;
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  get model(): WorkbookModel | null {
    const state = this.state;
    if (!state) return null;
    const extra = this.extra.get(state.sha256) ?? [];
    if (this.modelFor?.state !== state || this.modelFor.extraCount !== extra.length) {
      this.modelFor = { state, extraCount: extra.length, model: buildModel(state.nodes, extra) };
    }
    return this.modelFor.model;
  }

  get sheet(): SheetModel | null {
    const m = this.model;
    return m && this.activeSheetId !== null ? (m.byId.get(this.activeSheetId) ?? null) : null;
  }

  /** Engine reads for the current revision, or the newest older ones while
   * the current ones load. */
  get currentReads(): { reads: RevisionReads | null; fresh: boolean } {
    const state = this.state;
    if (!state) return { reads: null, fresh: false };
    if (this.reactor) return { reads: null, fresh: this.vpFresh };
    // The command module's nodes carry the engine grid: no extracts to wait for.
    if (hasEngineGrid(state.nodes, state.viewMeta ?? {})) return { reads: null, fresh: true };
    const own = this.reads.get(state.sha256);
    if (own) return { reads: own, fresh: true };
    const any = [...this.reads.values()].at(-1) ?? null;
    return { reads: any, fresh: false };
  }

  /** Older module only (no `viewMeta.workbook`/`sheets` and no grid members
   * on the nodes): display strings and merges come from two extracts. */
  private ensureReads(state: DocState): void {
    if (hasEngineGrid(state.nodes, state.viewMeta ?? {})) return;
    if (this.reads.has(state.sha256) || this.readsInFlight.has(state.sha256)) return;
    if (typeof this.host.kernel.query !== "function") {
      this.readError = {
        code: "query-unavailable",
        message: "KernelClient.query is not available: display strings and merges cannot be read",
      };
      this.changed();
      return;
    }
    this.readsInFlight.add(state.sha256);
    loadRevisionReads(this.host.kernel, state.doc)
      .then((reads) => {
        this.reads.set(reads.sha256, reads);
        // Keep a handful of revisions (undo/redo hops back and forth).
        while (this.reads.size > 8) this.reads.delete(this.reads.keys().next().value!);
        this.readError = null;
      })
      .catch((cause) => {
        this.readError = errorOf(cause);
      })
      .finally(() => {
        this.readsInFlight.delete(state.sha256);
        this.changed();
        // The revision moved on while reading: read the new one.
        const now = this.state;
        if (now && now.sha256 !== state.sha256) this.ensureReads(now);
      });
  }

  /** `DocState.viewMeta` of the current revision, parsed: the engine's
   * resolved style table and ranged-view sheet grids. */
  get viewMeta(): ViewMeta {
    const state = this.state;
    if (!state) return { styles: null, grids: [] };
    if (this.viewMetaFor?.state !== state) this.viewMetaFor = { state, meta: parseViewMeta(state.viewMeta ?? {}) };
    return this.viewMetaFor.meta;
  }

  get display(): { map: DisplayMap | null; unaligned: string[] } {
    const model = this.model;
    const state = this.state;
    if (!model || !state) return { map: null, unaligned: [] };
    const reads = this.reads.get(state.sha256);
    if (!reads) return { map: this.lastDisplay, unaligned: [] };
    if (this.displayFor?.sha !== state.sha256 || this.displayFor.model !== model) {
      const built = buildDisplay(model, reads);
      this.displayFor = { sha: state.sha256, model, map: built.map, unaligned: built.unaligned };
      this.lastDisplay = built.map;
    }
    return { map: this.displayFor.map, unaligned: this.displayFor.unaligned };
  }

  /** Merged ranges of a sheet: the engine grid's, else
   * `extract --what structure`. */
  merges(sheet: SheetModel): Rect[] {
    const fromGrid = this.layout(sheet).merges;
    if (fromGrid) return fromGrid;
    const { reads } = this.currentReads;
    const st =
      reads?.structure.find((s) => s.name === sheet.name) ?? reads?.structure.find((s) => s.index === sheet.position);
    return st?.merges ?? [];
  }

  /** Sheet layout: the reactor viewport's (current revision, else the
   * previous one while it loads), else the engine grid of the sheet node (or
   * of the latest ranged observe of this revision), else this session's
   * replayed edits. */
  layout(sheet: SheetModel): SheetLayout {
    if (this.reactor) return this.viewportLayoutOf(sheet);
    const snap = this.host.getSnapshot();
    if (this.layoutKey.state !== snap.state || this.layoutKey.historyLength !== snap.history.length) {
      this.layoutKey = { state: snap.state, historyLength: snap.history.length };
      this.layoutFor.clear();
    }
    const key = String(sheet.sheetId);
    let l = this.layoutFor.get(key);
    if (!l) {
      const grid =
        parseEngineGrid(sheet.node.grid) ??
        this.viewMeta.grids.find(
          (g) => g.id === sheet.id || sheetIdOf(g.id) === sheet.sheetId || g.label === sheet.name,
        )?.grid ??
        null;
      l = grid ? engineLayout(grid) : deriveSessionLayout(sheet.sheetId, snap.history, snap.state?.revision ?? 0);
      this.layoutFor.set(key, l);
    }
    return l;
  }

  // -------------------------------------------------------------------------
  // Reactor viewport tiles
  // -------------------------------------------------------------------------

  private vpSheetOf(sheet: SheetModel): { vs: VpSheet; book: VpBook } | null {
    const fresh = this.vpBook?.sheets.get(sheet.name);
    if (fresh && this.vpBook) return { vs: fresh, book: this.vpBook };
    const stale = this.vpStale?.sheets.get(sheet.name);
    return stale && this.vpStale ? { vs: stale, book: this.vpStale } : null;
  }

  private viewportLayoutOf(sheet: SheetModel): SheetLayout {
    const at = this.vpSheetOf(sheet);
    if (!at) return (this.vpDefault ??= deriveSessionLayout(sheet.sheetId, [], 0));
    const used = at.book.used.get(sheet.name) ?? null;
    const hit = this.vpLayouts.get(at.vs);
    if (hit && hit.version === at.vs.version && hit.used === used) return hit.layout;
    const layout = viewportLayout(at.vs, used);
    this.vpLayouts.set(at.vs, { version: at.vs.version, used, layout });
    return layout;
  }

  /**
   * The viewport cell at (`row`, `col`): `undefined` while its tile has not
   * arrived (current or previous revision), `null` for a loaded empty cell
   * or one past the sheet's used range. A previous-revision cell whose
   * value differs from the model's (just edited) counts as not loaded.
   */
  private vpLookup(sheet: SheetModel, row: number, col: number): { cell: VpCell | null; book: VpBook } | undefined {
    const key = tileOf(row, col);
    const k = cellKey(row, col);
    const fresh = this.vpBook?.sheets.get(sheet.name);
    if (fresh?.tiles.has(key)) return { cell: fresh.cells.get(k) ?? null, book: this.vpBook! };
    const used = this.vpBook?.used.get(sheet.name);
    if (this.vpBook && used !== undefined && (!used || row > used.r2 || col > used.c2) && !sheet.cells.has(k))
      return { cell: null, book: this.vpBook };
    const stale = this.vpStale?.sheets.get(sheet.name);
    if (stale?.tiles.has(key)) {
      const cell = stale.cells.get(k) ?? null;
      if (sameValue(sheet.cells.get(k), cell)) return { cell, book: this.vpStale! };
    }
    return undefined;
  }

  /** False while the reactor tile holding this cell is loading (the grid
   * draws a placeholder); always true on the command kernel. */
  cellLoaded(sheet: SheetModel, row: number, col: number): boolean {
    return !this.reactor || this.vpLookup(sheet, row, col) !== undefined;
  }

  /** Every tile the grid wants is loaded for the current revision. */
  get vpFresh(): boolean {
    const want = this.vpWant;
    const have = want ? this.vpBook?.sheets.get(want.sheet) : undefined;
    return (
      !!want &&
      !!have &&
      want.tiles.every((t) => have.tiles.has(t) || this.vpFailed.has(`${this.vpBook!.sha}|${want.sheet}|${t}`))
    );
  }

  /** Called by the grid on every paint with the visible cell range: asks
   * for the tiles covering it plus a margin (reactor kernel only). */
  requestViewport(sheet: SheetModel, view: Rect): void {
    if (!this.reactor) return;
    const layout = this.layout(sheet);
    const used = this.vpBook?.used.get(sheet.name) ?? this.vpStale?.used.get(sheet.name);
    const limit =
      used === undefined
        ? null
        : {
            r1: 1,
            c1: 1,
            r2: Math.max(used?.r2 ?? 1, sheet.maxRow) + TILE_ROWS,
            c2: Math.max(used?.c2 ?? 1, sheet.maxCol) + TILE_COLS,
          };
    const tiles = tilesFor(view, layout.frozen, limit);
    const prev = this.vpWant;
    if (
      prev &&
      prev.sheet === sheet.name &&
      prev.tiles.length === tiles.length &&
      prev.tiles.every((t, i) => t === tiles[i])
    )
      return;
    this.vpWant = { sheet: sheet.name, tiles };
    this.pumpViewport();
  }

  /** One `sheetViewport` call at a time: the next missing tile of the
   * latest request, so a fast scroll only fetches where it stops. */
  private pumpViewport(): void {
    const kernel = this.reactor;
    const state = this.state;
    const book = this.vpBook;
    const want = this.vpWant;
    if (!kernel || this.vpBusy || !state || !book || !want || book.sha !== state.sha256) return;
    const have = book.sheets.get(want.sheet);
    const key = want.tiles.find((t) => !have?.tiles.has(t) && !this.vpFailed.has(`${book.sha}|${want.sheet}|${t}`));
    if (key === undefined) {
      if (this.vpStale) {
        this.vpStale = null;
        this.changed();
      }
      return;
    }
    const w = tileWindow(key);
    this.vpBusy = true;
    const t0 = performance.now();
    kernel
      .sheetViewport(state.doc, want.sheet, w.row0, w.col0, w.rows, w.cols)
      .then((reply) => {
        // Only a reply read from the current revision counts: `revision` and
        // `sha256` both name it. A mismatch is a read that raced an apply or
        // undo; the pump fetches the tile again once for the current
        // revision, and a second mismatch for the same tile stops there.
        const now = this.state;
        if (this.vpBook !== book || now?.sha256 !== book.sha) return;
        if (reply.revision !== now.revision || reply.sha256 !== now.sha256) {
          const id = `${book.sha}|${want.sheet}|${key}`;
          this.vpStats = { ...this.vpStats, mismatches: this.vpStats.mismatches + 1 };
          if (this.vpMismatch.has(id)) {
            this.vpFailed.add(id);
            this.readError = {
              code: "revision-mismatch",
              message: `Viewport reply for revision ${reply.revision} (${String(reply.sha256).slice(0, 8)}) does not match the current revision ${now.revision} (${now.sha256.slice(0, 8)}).`,
            };
          } else this.vpMismatch.add(id);
          return;
        }
        mergeReply(book, reply, key);
        const ms = performance.now() - t0;
        this.vpStats = {
          ...this.vpStats,
          requests: this.vpStats.requests + 1,
          lastMs: ms,
          totalMs: this.vpStats.totalMs + ms,
          cells: this.vpStats.cells + reply.cells.length,
        };
        if (this.readError?.code !== "query-unavailable") this.readError = null;
      })
      .catch((cause) => {
        this.vpFailed.add(`${book.sha}|${want.sheet}|${key}`);
        this.readError = errorOf(cause);
      })
      .finally(() => {
        this.vpBusy = false;
        this.changed();
        this.pumpViewport();
      });
  }

  /** Style of one cell: the reactor viewport's (with the number format's
   * colour), else the engine style table (current revision's, or the newest
   * older one while it loads) plus session rules (older module). */
  styleOf(sheet: SheetModel, row: number, col: number): CellStyle {
    if (this.reactor) {
      const at = this.vpLookup(sheet, row, col);
      if (!at) return {};
      const layout = this.layout(sheet);
      const id = at.cell?.style ?? layout.colStyles.get(col);
      const base = id !== undefined && id !== null ? at.book.styles.get(id) : undefined;
      const color = at.cell?.color;
      return color ? { ...base, color } : (base ?? {});
    }
    return cellStyle(
      sheet.cells.get(cellKey(row, col))?.node.style,
      this.layout(sheet),
      this.viewMeta.styles,
      row,
      col,
    );
  }

  /** Text drawn in a cell. */
  displayText(sheet: SheetModel, cell: CellData | undefined, row: number, col: number): string {
    const pend = this.pending.get(`${sheet.sheetId}:${cellKey(row, col)}`);
    if (pend !== undefined) return pend;
    if (this.reactor) {
      const vp = this.vpLookup(sheet, row, col)?.cell;
      if (vp) return vpText(vp);
    }
    if (!cell) return "";
    // Engine display string (module with grid metadata): Excel's own text.
    if (typeof cell.node.display === "string") return cell.node.display;
    const v = cell.value;
    if (!v) return "";
    if ("number" in v) {
      const key = cellKey(row, col);
      const map = this.display.map;
      const d = map?.get(sheet.sheetId)?.get(key) ?? this.lastDisplay?.get(sheet.sheetId)?.get(key);
      return d && d.n === v.number ? d.text : formatGeneral(v.number);
    }
    if ("boolean" in v) return v.boolean ? "TRUE" : "FALSE";
    if ("string" in v) return v.string;
    if ("text" in v) return v.text;
    return "";
  }

  /** Formula cells saved without a cached value (the file was never
   * calculated, e.g. model-finance.xlsx). */
  get uncalculated(): { sheetId: number; row: number; col: number; formula: string }[] {
    const out: { sheetId: number; row: number; col: number; formula: string }[] = [];
    for (const s of this.model?.sheets ?? [])
      for (const c of s.cells.values())
        if (c.formula && !c.value) out.push({ sheetId: s.sheetId, row: c.row, col: c.col, formula: c.formula });
    return out;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  get selection(): Selection {
    const id = this.activeSheetId ?? 0;
    let s = this.selBySheet.get(id);
    if (!s) {
      s = { ranges: [{ r1: 1, c1: 1, r2: 1, c2: 1 }], active: { row: 1, col: 1 }, anchor: { row: 1, col: 1 } };
      this.selBySheet.set(id, s);
    }
    return s;
  }

  /** The range the active cell is in (last range). */
  get activeRange(): Rect {
    const s = this.selection;
    return s.ranges[s.ranges.length - 1]!;
  }

  get activeCell(): CellData | undefined {
    const s = this.selection;
    return this.sheet?.cells.get(cellKey(s.active.row, s.active.col));
  }

  setSelection(sel: Selection, reveal = true): void {
    if (this.activeSheetId === null) return;
    this.selBySheet.set(this.activeSheetId, sel);
    if (reveal) this.revealSeq++;
    const sheet = this.sheet;
    if (sheet) {
      const cell = sheet.cells.get(cellKey(sel.active.row, sel.active.col));
      this.host.select([cell?.id ?? ops.cellAddr(sheet.sheetId, sel.active.row, sel.active.col)]);
    }
    this.changed();
  }

  selectCell(row: number, col: number, mode: "replace" | "extend" | "add" = "replace", reveal = true): void {
    const s = this.selection;
    const cell = { row: clampRow(row), col: clampCol(col) };
    const merged = this.mergeAt(cell.row, cell.col);
    const one = merged ?? { r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col };
    if (mode === "extend") {
      const rect = this.expandForMerges(normRect({ r1: s.anchor.row, c1: s.anchor.col, r2: cell.row, c2: cell.col }));
      this.setSelection({ ranges: [...s.ranges.slice(0, -1), rect], active: s.active, anchor: s.anchor }, reveal);
      return;
    }
    const at = { row: one.r1, col: one.c1 };
    if (mode === "add") this.setSelection({ ranges: [...s.ranges, one], active: at, anchor: at }, reveal);
    else this.setSelection({ ranges: [one], active: at, anchor: at }, reveal);
  }

  /** Extend the active range so it is the drag/shift rectangle from the
   * anchor to `cell`, keeping the active cell. */
  extendTo(row: number, col: number, reveal = true): void {
    this.selectCell(row, col, "extend", reveal);
  }

  selectRect(rect: Rect, active: Cell, mode: "replace" | "add" = "replace"): void {
    const s = this.selection;
    const ranges = mode === "add" ? [...s.ranges, rect] : [rect];
    this.setSelection({ ranges, active, anchor: active });
  }

  /** Cmd/Ctrl+A: the used range first (data plus the engine's used range),
   * the whole sheet when the used range is already selected. */
  selectAll(): void {
    const s = this.selection;
    const sheet = this.sheet;
    const used = sheet ? this.usedArea(sheet) : null;
    const r = this.activeRange;
    const isUsed =
      used && s.ranges.length === 1 && r.r1 === used.r1 && r.c1 === used.c1 && r.r2 === used.r2 && r.c2 === used.c2;
    const rect = used && !isUsed ? used : { r1: 1, c1: 1, r2: MAX_ROWS, c2: MAX_COLS };
    const active = rectContains(rect, s.active.row, s.active.col) ? s.active : { row: rect.r1, col: rect.c1 };
    this.setSelection({ ranges: [rect], active, anchor: active }, false);
  }

  /** Data bounds widened by the engine's used range (formats, merges). */
  usedArea(sheet: SheetModel): Rect {
    const data = this.dataBounds(sheet);
    const engine = this.layout(sheet).usedRange;
    return engine ? { r1: 1, c1: 1, r2: Math.max(data.r2, engine.r2), c2: Math.max(data.c2, engine.c2) } : data;
  }

  mergeAt(row: number, col: number): Rect | null {
    const sheet = this.sheet;
    if (!sheet) return null;
    return this.merges(sheet).find((m) => rectContains(m, row, col)) ?? null;
  }

  private expandForMerges(rect: Rect): Rect {
    const sheet = this.sheet;
    if (!sheet) return rect;
    let r = rect;
    for (let pass = 0; pass < 4; pass++) {
      let grown = false;
      for (const m of this.merges(sheet)) {
        if (!rectIntersect(r, m)) continue;
        const u = {
          r1: Math.min(r.r1, m.r1),
          c1: Math.min(r.c1, m.c1),
          r2: Math.max(r.r2, m.r2),
          c2: Math.max(r.c2, m.c2),
        };
        if (u.r1 !== r.r1 || u.c1 !== r.c1 || u.r2 !== r.r2 || u.c2 !== r.c2) {
          r = u;
          grown = true;
        }
      }
      if (!grown) break;
    }
    return r;
  }

  switchSheet(sheetId: number): void {
    if (sheetId === this.activeSheetId) return;
    if (this.editing) this.commitEdit(null);
    this.activeSheetId = sheetId;
    this.revealSeq++;
    this.changed();
  }

  /** Name box: `B2`, `A1:C3`, `Sheet2!C5`. Returns false when not understood. */
  goto(text: string): boolean {
    const target = parseNameBox(text);
    const model = this.model;
    if (!target || !model) return false;
    if (target.sheet) {
      const want = target.sheet.toLowerCase();
      const sheet = model.sheets.find((s) => s.name.toLowerCase() === want);
      if (!sheet) return false;
      this.switchSheet(sheet.sheetId);
    }
    const { rect } = target;
    if (rect.r1 === rect.r2 && rect.c1 === rect.c2) this.selectCell(rect.r1, rect.c1);
    else this.selectRect(this.expandForMerges(rect), { row: rect.r1, col: rect.c1 });
    this.focusGrid();
    return true;
  }

  get selectionLabel(): string {
    const s = this.selection;
    const r = this.activeRange;
    if (s.ranges.length === 1 && r.r1 === r.r2 && r.c1 === r.c2) return toA1(s.active.row, s.active.col);
    const merged = this.mergeAt(s.active.row, s.active.col);
    if (
      s.ranges.length === 1 &&
      merged &&
      merged.r1 === r.r1 &&
      merged.c1 === r.c1 &&
      merged.r2 === r.r2 &&
      merged.c2 === r.c2
    )
      return toA1(s.active.row, s.active.col);
    return rectLabel(r);
  }

  /** Data bounds of the active sheet (at least A1). */
  dataBounds(sheet: SheetModel): Rect {
    return { r1: 1, c1: 1, r2: Math.max(1, sheet.maxRow), c2: Math.max(1, sheet.maxCol) };
  }

  hasValue(sheet: SheetModel, row: number, col: number): boolean {
    const c = sheet.cells.get(cellKey(row, col));
    return !!c && (!!c.formula || (!!c.value && !("empty" in c.value)));
  }

  /** Ctrl+arrow: the data edge in direction (dr, dc), Excel semantics. */
  dataEdge(from: Cell, dr: number, dc: number, limitRows: number, limitCols: number): Cell {
    const sheet = this.sheet;
    if (!sheet) return from;
    const inBounds = (r: number, c: number) => r >= 1 && c >= 1 && r <= limitRows && c <= limitCols;
    let r = from.row;
    let c = from.col;
    const filled = (rr: number, cc: number) => this.hasValue(sheet, rr, cc);
    if (!inBounds(r + dr, c + dc)) return from;
    if (filled(r, c) && filled(r + dr, c + dc)) {
      while (inBounds(r + dr, c + dc) && filled(r + dr, c + dc)) {
        r += dr;
        c += dc;
      }
      return { row: r, col: c };
    }
    // Skip the gap to the next filled cell, or stop at the edge.
    const stop = dr > 0 ? Math.max(sheet.maxRow, 0) : dc > 0 ? Math.max(sheet.maxCol, 0) : 0;
    r += dr;
    c += dc;
    while (inBounds(r, c) && !filled(r, c)) {
      const past = dr > 0 ? r > stop : dc > 0 ? c > stop : false;
      if (past) return { row: dr > 0 ? limitRows : r, col: dc > 0 ? limitCols : c };
      r += dr;
      c += dc;
    }
    if (!inBounds(r, c))
      return { row: Math.min(Math.max(1, r - dr), limitRows), col: Math.min(Math.max(1, c - dc), limitCols) };
    return { row: r, col: c };
  }

  // -------------------------------------------------------------------------
  // Applying
  // -------------------------------------------------------------------------

  isDisabled(control: string): KernelError | undefined {
    return this.disabled.get(control);
  }

  /** Apply one batch for `control`. Refusals are shown with their code;
   * module-level ones (`disablesControl`) disable the control for the
   * session. `explain` turns a refusal into the message shown. */
  async run(control: string, batch: Op[], label: string, opts: RunOpts = {}): Promise<ApplyResult | null> {
    if (!this.state || batch.length === 0) return null;
    const result = await this.host.apply(batch, { label, source: SOURCE });
    this.report(control, label, result, opts);
    return result;
  }

  private report(control: string, label: string, result: ApplyResult, opts: RunOpts): void {
    if (!result.ok) {
      const e = result.error;
      if (disablesControl(e)) this.disabled.set(control, e);
      this.notice = { kind: "error", code: e.code, text: opts.explain ? opts.explain(e) : `${label}: ${e.message}` };
    } else if (this.notice?.kind === "error") this.notice = null;
    this.changed();
  }

  setNotice(n: Notice | null): void {
    this.notice = n;
    this.changed();
  }

  setView(view: "grid" | "print"): void {
    if (view === this.view) return;
    if (this.editing) this.commitEdit(null);
    this.view = view;
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  beginEdit(initial: string | null, source: "cell" | "bar" = "cell"): void {
    const sheet = this.sheet;
    if (!sheet || !this.state) return;
    const { row, col } = this.selection.active;
    const text = initial ?? editText(sheet.cells.get(cellKey(row, col)));
    this.editing = { text, source, mode: initial === null ? "edit" : "enter", sheetId: sheet.sheetId, row, col };
    this.changed();
  }

  setEditText(text: string): void {
    if (!this.editing) return;
    this.editing = { ...this.editing, text };
    this.changed();
  }

  cancelEdit(): void {
    this.editing = null;
    this.changed();
    this.focusGrid();
  }

  /** Commit the editor; `move` then moves the active cell (Enter: down). */
  commitEdit(move: { dr: number; dc: number } | null): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const sheet = this.model?.byId.get(e.sheetId);
    const before = sheet ? editText(sheet.cells.get(cellKey(e.row, e.col))) : "";
    if (sheet && e.text !== before) {
      const value = parseInput(e.text);
      const key = `${e.sheetId}:${cellKey(e.row, e.col)}`;
      this.pending.set(key, "formula" in value ? "" : e.text);
      void this.run("edit", [ops.setCell(e.sheetId, e.row, e.col, value)], `Edit ${toA1(e.row, e.col)}`).finally(() => {
        this.pending.delete(key);
        this.changed();
      });
    }
    if (move) this.moveActive(move.dr, move.dc);
    this.changed();
    this.focusGrid();
  }

  /** Move the active cell; Enter/Tab inside a multi-cell selection cycle
   * within it like Excel. */
  moveActive(dr: number, dc: number, withinSelection = false): void {
    const s = this.selection;
    const r = this.activeRange;
    const multi = s.ranges.length === 1 && (r.r1 !== r.r2 || r.c1 !== r.c2) && r.r2 < MAX_ROWS && r.c2 < MAX_COLS;
    if (withinSelection && multi) {
      let row = s.active.row + dr;
      let col = s.active.col + dc;
      if (dc !== 0 && (col > r.c2 || col < r.c1)) {
        col = dc > 0 ? r.c1 : r.c2;
        row += dc;
      }
      if (dr !== 0 && (row > r.r2 || row < r.r1)) {
        row = dr > 0 ? r.r1 : r.r2;
        col += dr;
      }
      if (row > r.r2) row = r.r1;
      if (row < r.r1) row = r.r2;
      if (col > r.c2) col = r.c1;
      if (col < r.c1) col = r.c2;
      this.setSelection({ ranges: s.ranges, active: { row, col }, anchor: s.anchor });
      return;
    }
    // Leave a merged cell from its far edge.
    const merged = this.mergeAt(s.active.row, s.active.col);
    const fromRow = merged && dr > 0 ? merged.r2 : s.active.row;
    const fromCol = merged && dc > 0 ? merged.c2 : s.active.col;
    this.selectCell(fromRow + dr, fromCol + dc);
  }

  // -------------------------------------------------------------------------
  // Clearing, clipboard, fill
  // -------------------------------------------------------------------------

  /** Tight rectangles of non-empty cells inside each selected range. */
  private occupied(sheet: SheetModel, ranges: Rect[]): Rect[] {
    const out: Rect[] = [];
    for (const range of ranges) {
      let r1 = Infinity;
      let c1 = Infinity;
      let r2 = 0;
      let c2 = 0;
      for (const c of sheet.cells.values()) {
        if (!rectContains(range, c.row, c.col) || !this.hasValue(sheet, c.row, c.col)) continue;
        r1 = Math.min(r1, c.row);
        c1 = Math.min(c1, c.col);
        r2 = Math.max(r2, c.row);
        c2 = Math.max(c2, c.col);
      }
      if (r2 > 0) out.push({ r1, c1, r2, c2 });
    }
    return out;
  }

  /** Delete/Backspace: clear values and formulas of the occupied part of
   * the selection (formats stay). */
  clearSelection(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const rects = this.occupied(sheet, this.selection.ranges);
    if (rects.length === 0) return;
    void this.run(
      "clear",
      rects.map((r) => ops.deleteCells(sheet.sheetId, r)),
      "Clear cells",
    );
  }

  /** TSV of the active range (display strings, bounded by the data). */
  copyText(): string {
    const sheet = this.sheet;
    if (!sheet) return "";
    const range = rectIntersect(this.activeRange, this.dataBounds(sheet));
    if (!range) return "";
    const rows: string[][] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row: string[] = [];
      for (let c = range.c1; c <= range.c2; c++)
        row.push(this.displayText(sheet, sheet.cells.get(cellKey(r, c)), r, c));
      rows.push(row);
    }
    return toTsv(rows);
  }

  onCopy(event: ClipboardEvent, cut: boolean): void {
    const sheet = this.sheet;
    if (!sheet || !event.clipboardData) return;
    const range = rectIntersect(this.activeRange, this.dataBounds(sheet)) ?? this.activeRange;
    const tsv = this.copyText();
    event.clipboardData.setData("text/plain", tsv);
    event.preventDefault();
    this.clip = { sheetId: sheet.sheetId, rect: range, tsv, cut };
    this.changed();
  }

  onPaste(event: ClipboardEvent): void {
    const sheet = this.sheet;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!sheet || !text) return;
    event.preventDefault();
    const at = this.selection.active;
    const clip = this.clip;
    const model = this.model;
    if (clip && clip.tsv === text && model?.byId.has(clip.sheetId)) {
      // In-app: the engine's copy rebases references and carries formats.
      const h = clip.rect.r2 - clip.rect.r1 + 1;
      const w = clip.rect.c2 - clip.rect.c1 + 1;
      const sel = this.activeRange;
      const sh = sel.r2 - sel.r1 + 1;
      const sw = sel.c2 - sel.c1 + 1;
      const fills = sel.r2 < MAX_ROWS && sel.c2 < MAX_COLS && sh % h === 0 && sw % w === 0 && (sh > h || sw > w);
      const target = fills ? sel : { r1: at.row, c1: at.col, r2: at.row + h - 1, c2: at.col + w - 1 };
      const copy = ops.copyRange(clip.sheetId, clip.rect, sheet.sheetId, target);
      const rest = clip.cut ? (clip.sheetId === sheet.sheetId ? rectSubtract(clip.rect, target) : [clip.rect]) : [];
      if (clip.cut) this.clip = null;
      this.selectRect(target, { row: target.r1, col: target.c1 });
      const label = clip.cut ? "Cut and paste" : "Paste";
      void this.run("paste", [copy, ...rest.map((r) => ops.deleteCells(clip.sheetId, r))], label);
      return;
    }
    const rows = parseTsv(text);
    if (rows.length === 0 || rows[0]!.length === 0) return;
    const values = rows.map((r) => r.map((cell) => parseInput(cell)));
    const target = { r1: at.row, c1: at.col, r2: at.row + rows.length - 1, c2: at.col + rows[0]!.length - 1 };
    if (target.r2 > MAX_ROWS || target.c2 > MAX_COLS) {
      this.setNotice({ kind: "error", text: "Paste does not fit below/right of the active cell" });
      return;
    }
    this.selectRect(target, { row: target.r1, col: target.c1 });
    void this.run("paste", [ops.setBlock(sheet.sheetId, at.row, at.col, values)], "Paste");
  }

  clearClip(): void {
    if (!this.clip) return;
    this.clip = null;
    this.changed();
  }

  /** Cmd/Ctrl+D (down) and Cmd/Ctrl+R (right) with the engine's copy. */
  fill(direction: "down" | "right"): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const r = this.activeRange;
    if (r.r2 === MAX_ROWS && direction === "down") return;
    if (r.c2 === MAX_COLS && direction === "right") return;
    let source: Rect;
    let target: Rect;
    if (direction === "down") {
      if (r.r1 === r.r2) {
        if (r.r1 === 1) return;
        source = { ...r, r1: r.r1 - 1, r2: r.r1 - 1 };
        target = r;
      } else {
        source = { ...r, r2: r.r1 };
        target = { ...r, r1: r.r1 + 1 };
      }
    } else if (r.c1 === r.c2) {
      if (r.c1 === 1) return;
      source = { ...r, c1: r.c1 - 1, c2: r.c1 - 1 };
      target = r;
    } else {
      source = { ...r, c2: r.c1 };
      target = { ...r, c1: r.c1 + 1 };
    }
    void this.run(
      `fill-${direction}`,
      [ops.copyRange(sheet.sheetId, source, sheet.sheetId, target)],
      direction === "down" ? "Fill down" : "Fill right",
    );
  }

  /** Fill handle: copy the active range down or right over `to` (the
   * selection grown along one axis), repeating it like Excel: constants
   * copy, formulas rebase (no series inference). One batch: the whole
   * repeats in one `copy`, a partial repeat in a second one. */
  fillTo(to: Rect): void {
    const sheet = this.sheet;
    if (!sheet || this.disabled.has("fill-handle")) return;
    const from = this.activeRange;
    const batch = ops.fillOps(sheet.sheetId, from, to);
    if (batch.length === 0) return;
    this.selectRect(to, this.selection.active);
    void this.run("fill-handle", batch, to.r2 > from.r2 ? "Fill down" : "Fill right");
  }

  // -------------------------------------------------------------------------
  // Sort
  // -------------------------------------------------------------------------

  /** Sort by the active cell's column: the selected range, or (one cell
   * selected) the block of data around it, as Excel. Whole rows/columns are
   * clipped to the used area. A first row of text over a row with other
   * values is kept on top as a header. */
  sortSelection(order: "ascending" | "descending"): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const active = this.selection.active;
    const sel = this.activeRange;
    const range =
      sel.r1 === sel.r2 && sel.c1 === sel.c2
        ? this.currentRegion(sheet, active)
        : ops.clipFullLines(sel, this.usedArea(sheet));
    if (!range || range.r2 <= range.r1) {
      this.setNotice({ kind: "error", text: "Sort: select a range with more than one row of data." });
      return;
    }
    const header = this.looksLikeHeader(sheet, range);
    this.selectRect(range, { row: Math.max(range.r1, Math.min(range.r2, active.row)), col: active.col });
    void this.run(
      `sort-${order === "ascending" ? "asc" : "desc"}`,
      [ops.sortRange(sheet.sheetId, range, active.col, order, header)],
      order === "ascending" ? "Sort A to Z" : "Sort Z to A",
    );
  }

  /** The rectangle of data around `at`, grown until no adjacent row or
   * column (diagonals included) has a value; null when `at` and its
   * neighbours are empty. */
  private currentRegion(sheet: SheetModel, at: Cell): Rect | null {
    const r: Rect = { r1: at.row, c1: at.col, r2: at.row, c2: at.col };
    const lim = this.dataBounds(sheet);
    const rowHas = (row: number, c1: number, c2: number) => {
      for (let c = Math.max(1, c1); c <= Math.min(lim.c2, c2); c++) if (this.hasValue(sheet, row, c)) return true;
      return false;
    };
    const colHas = (col: number, r1: number, r2: number) => {
      for (let row = Math.max(1, r1); row <= Math.min(lim.r2, r2); row++)
        if (this.hasValue(sheet, row, col)) return true;
      return false;
    };
    for (let grown = true; grown;) {
      grown = false;
      if (r.r1 > 1 && rowHas(r.r1 - 1, r.c1 - 1, r.c2 + 1)) (r.r1--, (grown = true));
      if (r.r2 < lim.r2 && rowHas(r.r2 + 1, r.c1 - 1, r.c2 + 1)) (r.r2++, (grown = true));
      if (r.c1 > 1 && colHas(r.c1 - 1, r.r1 - 1, r.r2 + 1)) (r.c1--, (grown = true));
      if (r.c2 < lim.c2 && colHas(r.c2 + 1, r.r1 - 1, r.r2 + 1)) (r.c2++, (grown = true));
    }
    for (let row = r.r1; row <= r.r2; row++) if (rowHas(row, r.c1, r.c2)) return r;
    return null;
  }

  /** First row all text, and some column whose second row holds a value
   * that is not text. */
  private looksLikeHeader(sheet: SheetModel, r: Rect): boolean {
    let text = 0;
    let differs = false;
    for (let c = r.c1; c <= r.c2; c++) {
      const top = sheet.cells.get(cellKey(r.r1, c));
      const below = sheet.cells.get(cellKey(r.r1 + 1, c));
      if (this.hasValue(sheet, r.r1, c)) {
        if (!top?.value || !("string" in top.value) || top.formula) return false;
        text++;
      }
      if (below?.value && !("empty" in below.value) && !("string" in below.value)) differs = true;
    }
    return text > 0 && differs;
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  /** Format the selection. Whole rows/columns/sheet are clipped to the
   * used area (`ops.clipFullLines`): the engine formats ranges, not
   * `col:`/`row:`/sheet targets. */
  format(control: string, patch: ops.FormatPatch, label: string): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const used = this.usedArea(sheet);
    void this.run(
      control,
      this.selection.ranges.map((r) => ops.formatRect(sheet.sheetId, ops.clipFullLines(r, used), patch)),
      label,
    );
  }

  /** Effective style of the active cell (as far as it is known). */
  get activeStyle(): CellStyle {
    const sheet = this.sheet;
    if (!sheet) return {};
    const { row, col } = this.selection.active;
    return this.styleOf(sheet, row, col);
  }

  resizeCols(c1: number, c2: number, px: number): void {
    const sheet = this.sheet;
    if (!sheet) return;
    void this.run("resize-col", [ops.columnWidth(sheet.sheetId, c1, c2, pxToChars(px))], "Resize column");
  }

  resizeRows(r1: number, r2: number, px: number): void {
    const sheet = this.sheet;
    if (!sheet) return;
    void this.run("resize-row", [ops.rowHeight(sheet.sheetId, r1, r2, pxToPt(px))], "Resize row");
  }

  // -------------------------------------------------------------------------
  // Structure
  // -------------------------------------------------------------------------

  private rowsSpan(): [number, number] {
    const r = this.activeRange;
    const sheet = this.sheet;
    const r2 = r.r2 === MAX_ROWS && sheet ? Math.max(r.r1, sheet.maxRow) : r.r2;
    return [r.r1, r2];
  }

  private colsSpan(): [number, number] {
    const r = this.activeRange;
    const sheet = this.sheet;
    const c2 = r.c2 === MAX_COLS && sheet ? Math.max(r.c1, sheet.maxCol) : r.c2;
    return [r.c1, c2];
  }

  insertRows(where: "above" | "below"): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const [r1, r2] = this.rowsSpan();
    const count = r2 - r1 + 1;
    const op =
      where === "above"
        ? ops.insertRows(sheet.sheetId, r1, count, "before")
        : ops.insertRows(sheet.sheetId, r2, count, "after");
    void this.run(`insert-rows-${where}`, [op], count === 1 ? "Insert row" : `Insert ${count} rows`);
  }

  insertCols(where: "left" | "right"): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const [c1, c2] = this.colsSpan();
    const count = c2 - c1 + 1;
    const op =
      where === "left"
        ? ops.insertCols(sheet.sheetId, c1, count, "before")
        : ops.insertCols(sheet.sheetId, c2, count, "after");
    void this.run(`insert-cols-${where}`, [op], count === 1 ? "Insert column" : `Insert ${count} columns`);
  }

  deleteRows(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const [r1, r2] = this.rowsSpan();
    void this.run(
      "delete-rows",
      ops.deleteRows(sheet.sheetId, r1, r2),
      r1 === r2 ? "Delete row" : `Delete ${r2 - r1 + 1} rows`,
    );
  }

  deleteCols(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const [c1, c2] = this.colsSpan();
    void this.run(
      "delete-cols",
      ops.deleteCols(sheet.sheetId, c1, c2),
      c1 === c2 ? "Delete column" : `Delete ${c2 - c1 + 1} columns`,
    );
  }

  // -------------------------------------------------------------------------
  // Hidden rows and columns
  // -------------------------------------------------------------------------

  /** Hidden in the engine grid or by the hidden reason of a cell node in
   * that row/column. */
  isHidden(sheet: SheetModel, axis: "row" | "col", i: number): boolean {
    const layout = this.layout(sheet);
    return axis === "row"
      ? sheet.hiddenRows.has(i) || layout.hiddenRows.has(i)
      : sheet.hiddenCols.has(i) || layout.hiddenCols.has(i);
  }

  /** Hidden indices in `lo..hi`, ascending. */
  hiddenIn(sheet: SheetModel, axis: "row" | "col", lo: number, hi: number): number[] {
    const layout = this.layout(sheet);
    const all = axis === "row" ? [sheet.hiddenRows, layout.hiddenRows] : [sheet.hiddenCols, layout.hiddenCols];
    const out = new Set<number>();
    for (const set of all) for (const i of set) if (i >= lo && i <= hi) out.add(i);
    return [...out].sort((a, b) => a - b);
  }

  /** The run of hidden indices that ends right before `i` (what the double
   * line in the header in front of `i` stands for), or null. */
  hiddenRunBefore(sheet: SheetModel, axis: "row" | "col", i: number): [number, number] | null {
    let lo = i - 1;
    while (lo >= 1 && this.isHidden(sheet, axis, lo)) lo--;
    return lo + 1 <= i - 1 ? [lo + 1, i - 1] : null;
  }

  /** The run of hidden indices that starts right after `i`, or null. */
  hiddenRunAfter(sheet: SheetModel, axis: "row" | "col", i: number): [number, number] | null {
    const max = axis === "row" ? MAX_ROWS : MAX_COLS;
    let hi = i + 1;
    while (hi <= max && this.isHidden(sheet, axis, hi)) hi++;
    return hi - 1 >= i + 1 ? [i + 1, hi - 1] : null;
  }

  /** The selected rows (`row`) or columns (`col`), bounded by the data for
   * whole-sheet selections. */
  axisSpan(axis: "row" | "col"): [number, number] {
    return axis === "row" ? this.rowsSpan() : this.colsSpan();
  }

  /** Hidden indices that Unhide on the selected rows/columns shows: those
   * inside the selection plus the hidden runs right before and after it. */
  unhideCandidates(axis: "row" | "col"): number[] {
    const sheet = this.sheet;
    if (!sheet) return [];
    const [lo, hi] = this.axisSpan(axis);
    const before = this.hiddenRunBefore(sheet, axis, lo);
    const after = this.hiddenRunAfter(sheet, axis, hi);
    return this.hiddenIn(sheet, axis, before ? before[0] : lo, after ? after[1] : hi);
  }

  /** Hide the selected rows/columns (one `visibility` op per index). */
  hideSelection(axis: "row" | "col"): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const [lo, hi] = this.axisSpan(axis);
    const count = hi - lo + 1;
    if (count > MAX_VISIBILITY_OPS) {
      this.setNotice({
        kind: "error",
        text: `Hide works on at most ${MAX_VISIBILITY_OPS.toLocaleString("en-US")} ${axis === "row" ? "rows" : "columns"} at a time.`,
      });
      return;
    }
    const batch =
      axis === "row"
        ? ops.rowVisibility(sheet.sheetId, lo, hi, "hidden")
        : ops.colVisibility(sheet.sheetId, lo, hi, "hidden");
    const noun = axis === "row" ? (count === 1 ? "row" : "rows") : count === 1 ? "column" : "columns";
    void this.run(`hide-${axis}`, batch, count === 1 ? `Hide ${noun}` : `Hide ${count} ${noun}`);
  }

  /** Show hidden indices (`unhideCandidates` by default). */
  unhide(axis: "row" | "col", indices: number[] = this.unhideCandidates(axis)): void {
    const sheet = this.sheet;
    if (!sheet || indices.length === 0) return;
    const batch = indices.flatMap((i) =>
      axis === "row"
        ? ops.rowVisibility(sheet.sheetId, i, i, "visible")
        : ops.colVisibility(sheet.sheetId, i, i, "visible"),
    );
    const noun = axis === "row" ? (indices.length === 1 ? "row" : "rows") : indices.length === 1 ? "column" : "columns";
    void this.run(
      `unhide-${axis}`,
      batch,
      indices.length === 1 ? `Unhide ${noun}` : `Unhide ${indices.length} ${noun}`,
    );
  }

  // -------------------------------------------------------------------------
  // Hyperlinks
  // -------------------------------------------------------------------------

  private linksKey: { history: readonly HistoryEntry[] | null; revision: number; map: LinkMap } = {
    history: null,
    revision: -1,
    map: new Map(),
  };

  /** Links set by this session's batches up to the current revision. */
  private get sessionLinks(): LinkMap {
    const snap = this.host.getSnapshot();
    const revision = snap.state?.revision ?? 0;
    if (this.linksKey.history !== snap.history || this.linksKey.revision !== revision) {
      this.linksKey = { history: snap.history, revision, map: deriveSessionLinks(snap.history, revision) };
    }
    return this.linksKey.map;
  }

  /** The link of a cell: the engine's `hyperlink` member of its node, else
   * a link set in this session, else a literal `=HYPERLINK()` target.
   * `source` says which: only cell links (not formulas) can be removed. */
  linkAt(sheet: SheetModel, row: number, col: number): (Link & { source: "engine" | "session" | "formula" }) | null {
    const cell = sheet.cells.get(cellKey(row, col));
    const own = nodeLink(cell?.node.hyperlink);
    if (own) return { ...own, source: "engine" };
    const set = this.sessionLinks.get(sheet.sheetId)?.get(cellKey(row, col));
    if (set) return { ...set, source: "session" };
    const f = formulaLink(cell?.formula);
    return f ? { ...f, source: "formula" } : null;
  }

  /** Cell whose link the dialog edits; null when closed. */
  linkDialog: { sheetId: number; row: number; col: number } | null = null;

  openLinkDialog(): void {
    const sheet = this.sheet;
    if (!sheet || this.disabled.has("hyperlink")) return;
    if (this.editing) this.commitEdit(null);
    const { row, col } = this.selection.active;
    this.linkDialog = { sheetId: sheet.sheetId, row, col };
    this.changed();
  }

  closeLinkDialog(): void {
    if (!this.linkDialog) return;
    this.linkDialog = null;
    this.changed();
    this.focusGrid();
  }

  /** Set the dialog cell's link from what the user typed. Returns an error
   * to show in the dialog (which stays open), or null when the link was
   * applied or the refusal went to the notice banner. */
  async saveLink(text: string, tooltip: string): Promise<string | null> {
    const at = this.linkDialog;
    if (!at) return null;
    const parsed = parseLinkInput(text);
    if ("error" in parsed) return parsed.error;
    const result = await this.run(
      "hyperlink",
      [ops.setHyperlink(at.sheetId, at.row, at.col, parsed, tooltip.trim() || undefined)],
      "Insert link",
      {
        explain: (e) =>
          e.code === "unsupported"
            ? `Insert link: ${toA1(at.row, at.col)} is part of a link that spans several cells, which the engine cannot change. ${e.message}`
            : `Insert link: ${e.message}`,
      },
    );
    if (result && !result.ok && result.error.code === "hyperlink-url-invalid") {
      this.notice = null;
      this.changed();
      return `The engine does not accept that address: it needs a scheme such as https:, no spaces, and at most 2,079 characters (${result.error.code}).`;
    }
    this.closeLinkDialog();
    return null;
  }

  /** Remove the active cell's link (cell links only, not `=HYPERLINK()`). */
  removeLink(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const { row, col } = this.selection.active;
    void this.run("hyperlink", [ops.removeHyperlink(sheet.sheetId, row, col)], "Remove link");
  }

  /** Follow a link: http(s) and mailto open in a new tab without opener or
   * referrer; an internal location selects its cell. */
  followLink(link: Link): void {
    if (link.location) {
      if (!this.goto(link.location))
        this.setNotice({ kind: "error", text: `The link points at ${link.location}, which is not in this workbook.` });
      return;
    }
    const url = openableUrl(link.url);
    if (!url) {
      this.setNotice({
        kind: "error",
        text: `Only http, https and mailto links open from the editor (${link.url ?? "no address"}).`,
      });
      return;
    }
    globalThis.open?.(url, "_blank", "noopener,noreferrer");
  }

  // -------------------------------------------------------------------------
  // Recalculation
  // -------------------------------------------------------------------------

  /** Evaluate every formula and store its result (`recalculate` op). */
  recalculate(): void {
    void this.run("recalc", [ops.recalculate()], "Recalculate");
  }

  async mergeSelection(): Promise<void> {
    const sheet = this.sheet;
    if (!sheet) return;
    const r = this.activeRange;
    if (r.r1 === r.r2 && r.c1 === r.c2) return;
    const result = await this.run("merge", [ops.merge(sheet.sheetId, r)], "Merge cells");
    if (result && !result.ok && result.error.code === "merge-would-discard") {
      const ok = globalThis.confirm?.(`${result.error.message}\n\nMerge anyway and keep only the top-left value?`);
      if (ok) await this.run("merge", [ops.merge(sheet.sheetId, r, true)], "Merge cells");
    }
  }

  unmergeSelection(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    void this.run("unmerge", [ops.unmerge(sheet.sheetId, this.activeRange)], "Unmerge cells");
  }

  freezeAtSelection(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const { row, col } = this.selection.active;
    const at = row === 1 && col === 1 ? null : { row, col };
    void this.run(
      "freeze",
      [ops.freeze(sheet.sheetId, at)],
      at ? `Freeze panes at ${toA1(row, col)}` : "Unfreeze panes",
    );
  }

  unfreeze(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    void this.run("unfreeze", [ops.freeze(sheet.sheetId, null)], "Unfreeze panes");
  }

  // -------------------------------------------------------------------------
  // Sheets
  // -------------------------------------------------------------------------

  async addSheet(): Promise<void> {
    const model = this.model;
    const sheet = this.sheet;
    if (!model || !sheet) return;
    const taken = new Set(model.sheets.map((s) => s.name.toLowerCase()));
    let n = model.sheets.length + 1;
    while (taken.has(`sheet${n}`)) n++;
    const result = await this.run("add-sheet", [ops.insertSheet(sheet.sheetId, `Sheet${n}`)], "Add sheet");
    const created = result?.ok ? result.transaction.ops[0]?.created : undefined;
    const id = created ? /^sheet:#(\d+)$/.exec(created)?.[1] : undefined;
    if (id) this.switchSheet(Number(id));
  }

  async renameSheet(sheetId: number, name: string): Promise<boolean> {
    const sheet = this.model?.byId.get(sheetId);
    const clean = name.trim();
    if (!sheet || !clean || clean === sheet.name) return true;
    const result = await this.run("rename-sheet", [ops.renameSheet(sheetId, clean)], `Rename sheet to ${clean}`);
    return !!result?.ok;
  }

  async deleteSheet(sheetId: number): Promise<void> {
    const model = this.model;
    const sheet = model?.byId.get(sheetId);
    if (!model || !sheet) return;
    if (model.sheets.filter((s) => s.visible).length <= 1) return;
    const ok = globalThis.confirm?.(`Delete sheet "${sheet.name}"? Formulas that refer to it become #REF!.`) ?? true;
    if (!ok) return;
    const index = model.sheets.indexOf(sheet);
    const result = await this.run("delete-sheet", [ops.deleteSheet(sheetId)], `Delete sheet ${sheet.name}`);
    if (result?.ok) {
      const next = this.model?.sheets.filter((s) => s.visible);
      const pick = next?.[Math.min(index, next.length - 1)];
      if (pick) this.switchSheet(pick.sheetId);
    }
  }

  moveSheet(sheetId: number, anchorId: number, position: "before" | "after"): void {
    if (sheetId === anchorId) return;
    void this.run("move-sheet", [ops.moveSheet(sheetId, anchorId, position)], "Move sheet");
  }

  /** Copy a sheet next to it as "Name (2)" and switch to the copy (tables
   * get new names). A sheet the engine cannot copy (drawings, comments,
   * pivots) refuses `unsupported`: the refusal is explained and Duplicate
   * stays enabled. */
  async duplicateSheet(sheetId: number): Promise<void> {
    const model = this.model;
    const sheet = model?.byId.get(sheetId);
    if (!model || !sheet) return;
    const taken = new Set(model.sheets.map((s) => s.name.toLowerCase()));
    const base = sheet.name.replace(/ \(\d+\)$/, "");
    let n = 2;
    let name = "";
    do {
      const suffix = ` (${n++})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    } while (taken.has(name.toLowerCase()));
    const result = await this.run("duplicate-sheet", [ops.copySheet(sheetId, name)], `Duplicate sheet ${sheet.name}`, {
      explain: (e) =>
        e.code === "unsupported"
          ? `Cannot duplicate "${sheet.name}": the engine cannot copy a sheet that holds drawings, charts, comments or pivot tables (older engine modules also cannot copy one with tables). Nothing was changed. Engine: ${e.message}`
          : `Duplicate sheet ${sheet.name}: ${e.message}`,
    });
    const created = result?.ok ? result.transaction.ops[0]?.created : undefined;
    const id = created ? sheetIdOf(created) : null;
    if (id !== null) this.switchSheet(id);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  stats(): { sum: number; count: number; numeric: number } | null {
    const sheet = this.sheet;
    if (!sheet) return null;
    const s = this.selection;
    let sum = 0;
    let count = 0;
    let numeric = 0;
    const seen = new Set<number>();
    const area = s.ranges.reduce((a, r) => a + (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1), 0);
    if (area <= 1) return null;
    const visit = (c: CellData) => {
      const key = cellKey(c.row, c.col);
      if (seen.has(key)) return;
      seen.add(key);
      if (!this.hasValue(sheet, c.row, c.col)) return;
      count++;
      if (c.value && "number" in c.value) {
        numeric++;
        sum += c.value.number;
      }
    };
    if (area > sheet.cells.size) {
      for (const c of sheet.cells.values()) if (s.ranges.some((r) => rectContains(r, c.row, c.col))) visit(c);
    } else {
      for (const r of s.ranges)
        for (let row = r.r1; row <= r.r2; row++)
          for (let col = r.c1; col <= r.c2; col++) {
            const c = sheet.cells.get(cellKey(row, col));
            if (c) visit(c);
          }
    }
    return { sum, count, numeric };
  }

  // -------------------------------------------------------------------------
  // Truncated views: ranged observes for the viewport
  // -------------------------------------------------------------------------

  /** Called by the grid when the viewport settles. Loads cells the engine
   * left out of a truncated view (`state.truncated`), 200 rows at a time. */
  ensureViewport(vp: Viewport): void {
    this.viewport = vp;
    const state = this.state;
    const sheet = this.sheet;
    if (!state?.truncated || !sheet || typeof this.host.kernel.query !== "function") return;
    const block = 200;
    const c2 = Math.min(MAX_COLS, Math.max(vp.c2 + 10, 26));
    for (let b = Math.floor((vp.r1 - 1) / block); b <= Math.floor((vp.r2 - 1) / block); b++) {
      const r1 = b * block + 1;
      const r2 = Math.min(MAX_ROWS, r1 + block - 1);
      const label = `${sheet.name}!${toA1(r1, 1)}:${toA1(r2, c2)}`;
      const key = `${state.sha256}|${label}`;
      const done = this.loadedRanges.get(state.sha256) ?? [];
      if (done.includes(label) || this.rangesInFlight.has(key)) continue;
      this.rangesInFlight.add(key);
      loadRange(this.host.kernel, state.doc, `sheet:#${sheet.sheetId}/range:${toA1(r1, 1)}:${toA1(r2, c2)}`)
        .then((res) => {
          const list = this.extra.get(res.sha256) ?? [];
          list.push(...res.nodes);
          this.extra.set(res.sha256, list);
          const labels = this.loadedRanges.get(res.sha256) ?? [];
          labels.push(label);
          this.loadedRanges.set(res.sha256, labels);
        })
        .catch((cause) => {
          this.readError = errorOf(cause);
        })
        .finally(() => {
          this.rangesInFlight.delete(key);
          this.changed();
        });
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private focusFn: (() => void) | null = null;

  registerFocus(fn: (() => void) | null): void {
    this.focusFn = fn;
  }

  focusGrid(): void {
    this.focusSeq++;
    this.focusFn?.();
  }

  private handled = new WeakSet<KeyboardEvent>();

  /** Grid keyboard handling (not while editing). Returns true when handled;
   * each event is handled at most once even if the shell forwards it too. */
  handleKey(event: KeyboardEvent, openMenu?: () => void): boolean {
    if (this.handled.has(event)) return true;
    if (this.editing || !this.sheet) return false;
    const done = this.keyAction(event, openMenu);
    if (done) {
      this.handled.add(event);
      event.preventDefault();
      event.stopPropagation();
    }
    return done;
  }

  /** The grid key table (`keys.ts`), then typing a character starts
   * editing the active cell with it. */
  private keyAction(e: KeyboardEvent, openMenu?: () => void): boolean {
    if (dispatch(GRID_KEYS, { store: this, event: e, openMenu })) return true;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      this.beginEdit(e.key);
      return true;
    }
    return false;
  }

  /** Arrow keys: move (`extend`: grow the active range; `edge`: to the
   * edge of the data, Excel's Ctrl+arrow). */
  arrowKey(dr: number, dc: number, extend: boolean, edge: boolean): void {
    const s = this.selection;
    if (edge) {
      const limitRows = Math.max(10000, (this.sheet?.maxRow ?? 0) + 1000);
      const limitCols = Math.max(100, (this.sheet?.maxCol ?? 0) + 20);
      const to = this.dataEdge(extend ? this.extentCorner(dr, dc) : s.active, dr, dc, limitRows, limitCols);
      if (extend) this.extendTo(to.row, to.col);
      else this.selectCell(to.row, to.col);
    } else if (extend) {
      const corner = this.extentCorner(dr, dc);
      this.extendTo(corner.row + dr, corner.col + dc);
    } else this.moveActive(dr, dc);
  }

  /** Home: start of the row; `sheet`: A1. */
  homeKey(sheet: boolean, extend: boolean): void {
    this.selectCell(sheet ? 1 : this.selection.active.row, 1, extend ? "extend" : "replace");
  }

  /** End: last value in the row; `sheet`: the last used cell. */
  endKey(sheet: boolean, extend: boolean): void {
    const s = this.sheet;
    if (!s) return;
    const mode = extend ? "extend" : "replace";
    if (sheet) {
      this.selectCell(Math.max(1, s.maxRow), Math.max(1, s.maxCol), mode);
      return;
    }
    const row = this.selection.active.row;
    let last = 1;
    for (const c of s.cells.values()) if (c.row === row && this.hasValue(s, c.row, c.col)) last = Math.max(last, c.col);
    this.selectCell(row, last, mode);
  }

  /** PageDown (`dir` 1) / PageUp (-1) by the visible rows. */
  pageKey(dir: 1 | -1, extend: boolean): void {
    const dr = dir * Math.max(1, (this.viewport?.pageRows ?? 20) - 1);
    if (extend) {
      const corner = this.extentCorner(dir, 0);
      this.extendTo(corner.row + dr, corner.col);
    } else this.selectCell(this.selection.active.row + dr, this.selection.active.col);
  }

  toggleBold(): void {
    this.format("bold", ops.bold(!this.activeStyle.bold), "Bold");
  }

  toggleItalic(): void {
    this.format("italic", ops.italic(!this.activeStyle.italic), "Italic");
  }

  /** Alt+Enter in the cell editor: a line break at the caret (at the end
   * when the textarea has not taken focus yet). */
  insertEditNewline(target: EventTarget | null): void {
    const ed = this.editing;
    if (!ed) return;
    if (target instanceof HTMLTextAreaElement) {
      const at = target.selectionStart;
      this.setEditText(`${target.value.slice(0, at)}\n${target.value.slice(target.selectionEnd)}`);
      requestAnimationFrame(() => target.setSelectionRange(at + 1, at + 1));
    } else this.setEditText(`${ed.text}\n`);
  }

  /** F2 while editing: enter mode (arrows commit) <-> edit mode. */
  toggleEditMode(): boolean {
    if (!this.editing) return false;
    this.editing = { ...this.editing, mode: this.editing.mode === "enter" ? "edit" : "enter" };
    this.changed();
    return true;
  }

  /** The corner of the active range opposite the anchor, on the side a
   * shift+arrow in (dr, dc) moves. */
  private extentCorner(dr: number, dc: number): Cell {
    const s = this.selection;
    const r = this.activeRange;
    const row =
      dr === 0
        ? s.anchor.row === r.r1
          ? r.r2
          : r.r1
        : s.anchor.row === r.r1 && r.r2 !== r.r1
          ? r.r2
          : s.anchor.row === r.r2 && r.r1 !== r.r2
            ? r.r1
            : dr > 0
              ? r.r2
              : r.r1;
    const col =
      dc === 0
        ? s.anchor.col === r.c1
          ? r.c2
          : r.c1
        : s.anchor.col === r.c1 && r.c2 !== r.c1
          ? r.c2
          : s.anchor.col === r.c2 && r.c1 !== r.c2
            ? r.c1
            : dc > 0
              ? r.c2
              : r.c1;
    return { row, col };
  }
}

const clampRow = (r: number) => Math.min(MAX_ROWS, Math.max(1, r));
const clampCol = (c: number) => Math.min(MAX_COLS, Math.max(1, c));

const isEmptyValue = (v: Record<string, unknown> | null | undefined) => !v || "empty" in v;

/** A model cell and a viewport cell hold the same value (both empty, or the
 * same typed value). */
export function sameValue(model: CellData | undefined, vp: VpCell | null): boolean {
  const a = model?.value as Record<string, unknown> | undefined;
  const b = vp?.value;
  if (isEmptyValue(a) || isEmptyValue(b)) return isEmptyValue(a) && isEmptyValue(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sheet and cell an address points at, for `host.reveal`: `sheet:#N`,
 * `sheet:@N` or `sheet:Name`, optionally with `/cell:C4`, `/range:A1:K50`,
 * `/row:@N` or `/col:B`; table addresses (`table:T[/row:…[/col:…]]`) go to
 * their first cell in the model. Row or column 0 = keep that scroll axis.
 * Null when the address is not in this workbook.
 */
export function resolveAddress(
  model: WorkbookModel,
  address: string,
): { sheetId: number; row: number; col: number } | null {
  const m = /^sheet:([^/]+)(?:\/(.*))?$/.exec(address);
  if (!m) {
    for (const s of model.sheets)
      for (const c of s.cells.values())
        if (c.id === address || c.id.startsWith(`${address}/`)) return { sheetId: s.sheetId, row: c.row, col: c.col };
    const owner = model.ownerOf.get(address);
    return owner !== undefined ? { sheetId: owner, row: 0, col: 0 } : null;
  }
  const key = m[1]!;
  const sheet = key.startsWith("#")
    ? model.byId.get(Number(key.slice(1)))
    : key.startsWith("@")
      ? model.sheets.find((s) => s.position === Number(key.slice(1)))
      : model.sheets.find((s) => s.name === key);
  if (!sheet) return null;
  const rest = m[2] ?? "";
  const cell = /^cell:(.+)$/.exec(rest);
  const range = /^range:(.+)$/.exec(rest);
  const row = /^row:@?(\d+)$/.exec(rest);
  const col = /^col:([A-Za-z]{1,3})$/.exec(rest);
  const at = cell ? parseA1(cell[1]!) : range ? parseRange(range[1]!) : null;
  if (at)
    return "row" in at
      ? { sheetId: sheet.sheetId, row: at.row, col: at.col }
      : { sheetId: sheet.sheetId, row: at.r1, col: at.c1 };
  if (row) return { sheetId: sheet.sheetId, row: Number(row[1]), col: 0 };
  if (col) return { sheetId: sheet.sheetId, row: 0, col: colToNum(col[1]!.toUpperCase()) };
  return { sheetId: sheet.sheetId, row: 0, col: 0 };
}

export { isErrorValue };
