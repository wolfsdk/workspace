// Live cells of an XLSX head, for a member in the browser: a window of one sheet read over HTTP (`GET
// /api/rooms/<room>/docs/<doc>/live-cells`), a draft for each cell the person typed in, each draft written on its own
// over the value and revision of the read it was typed on (`PUT`), and the cell the person is on announced to the
// other members (`POST`). The server refuses a write whose cell or sheets moved on since that read (409
// `CELL_CONFLICT`, `STRUCTURE_CONFLICT`); a later read that finds the cell changed under a draft says the same before
// anything is sent. Either way the draft stays, and only the person decides what wins. Reapplying a draft writes it over
// what the person was shown, at the revision of the read that showed it, so a cell or sheets written since are refused
// again and shown; a draft whose sheets changed is not reapplied at all, as a sheet's name does not prove it is the same
// sheet. The server also says when a workbook, or one of its cells, may be read but not written here; the page then
// reads, selects and keeps drafts, and writes nothing. No engine runs in the page: the server calculates, and the grid
// shows what it says.
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { ApiError, type CellValue, type LiveCell, type LiveCells, type LivePeer, type LiveRefusal, type LiveSheet, type WorkspaceApi } from "./api.ts";
import { follow } from "./live-follow.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The window of a sheet the grid shows: 8 columns and 15 rows from its top left cell (A1:H15 at first). */
export const VIEW_COLS = 8;
export const VIEW_ROWS = 15;
/** The last column (XFD) and row of a worksheet, from 0. */
const LAST_COL = 16_383;
const LAST_ROW = 1_048_575;
/** How often the cell a person stays on is announced again: the server forgets an announcement after 30 seconds. */
export const ANNOUNCE_MS = 15_000;
/** Refusals of a write that hold for every cell of the workbook, not for the one written. */
const WORKBOOK_REFUSALS: Readonly<Record<string, true>> = { LICENSE_LIMIT: true, LIVE_CELLS_UNATTESTED: true, LIVE_CELLS_UNSUPPORTED: true, FORBIDDEN: true };

/** A cell by its column and row, from 0. */
export type CellRef = { col: number; row: number };

/** The cell of an address like `B2` (case and `$` markers ignored), or null for anything else. */
export function parseA1(text: string): CellRef | null {
  const match = /^\s*\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})\s*$/.exec(text);
  if (match === null) return null;
  let col = 0;
  for (const letter of match[1]!.toUpperCase()) col = col * 26 + (letter.charCodeAt(0) - 64);
  const row = Number(match[2]);
  return col - 1 > LAST_COL || row - 1 > LAST_ROW ? null : { col: col - 1, row: row - 1 };
}

/** The letters of a column: 0 is A, 26 is AA. */
export function columnName(col: number): string {
  let name = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export const a1Of = (ref: CellRef): string => `${columnName(ref.col)}${ref.row + 1}`;

/** The range a window from `origin` covers, as the read asks for it. */
export const rangeOf = (origin: CellRef): string =>
  `${a1Of(origin)}:${a1Of({ col: origin.col + VIEW_COLS - 1, row: origin.row + VIEW_ROWS - 1 })}`;

const clamp = (n: number, max: number): number => Math.min(Math.max(n, 0), max);

/** The top left cell of a window that starts at `origin` and is moved just enough to show `ref`. */
function originShowing(origin: CellRef, ref: CellRef): CellRef {
  const col = ref.col < origin.col ? ref.col : ref.col >= origin.col + VIEW_COLS ? ref.col - VIEW_COLS + 1 : origin.col;
  const row = ref.row < origin.row ? ref.row : ref.row >= origin.row + VIEW_ROWS ? ref.row - VIEW_ROWS + 1 : origin.row;
  return col === origin.col && row === origin.row ? origin : { col, row };
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/** What a person's entry in the formula bar puts in the cell: nothing for an empty entry, a formula for one that
 * starts with `=`, TRUE or FALSE, a number (`1000`, `.08`, `1,000.5`, `8%`), and text for anything else or anything
 * after a leading `'`. */
export function valueOfEntry(text: string): CellValue {
  if (text === "") return null;
  if (text.startsWith("'")) return { string: text.slice(1) };
  if (text.startsWith("=") && text.length > 1) return { formula: text };
  const trimmed = text.trim();
  if (/^(true|false)$/i.test(trimmed)) return { boolean: trimmed.toLowerCase() === "true" };
  const percent = trimmed.endsWith("%");
  const body = (percent ? trimmed.slice(0, -1) : trimmed).trim();
  const number = NUMBER.test(body) || GROUPED.test(body) ? Number(body.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(number)) return { string: text };
  return { number: percent ? number / 100 : number };
}

export function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b;
  if ("formula" in a) return "formula" in b && a.formula === b.formula;
  if ("number" in a) return "number" in b && a.number === b.number;
  if ("boolean" in a) return "boolean" in b && a.boolean === b.boolean;
  return "string" in b && a.string === b.string;
}

/** The entry that puts `value` back in its cell: the formula with its `=`, and text that would read as something
 * else with a leading `'`. */
export function entryOf(value: CellValue): string {
  if (value === null) return "";
  if ("formula" in value) return value.formula.startsWith("=") ? value.formula : `=${value.formula}`;
  if ("number" in value) return String(value.number);
  if ("boolean" in value) return value.boolean ? "TRUE" : "FALSE";
  return sameValue(valueOfEntry(value.string), value) ? value.string : `'${value.string}`;
}

/** What a cell shows in the grid: the text the server calculated for it, else what it holds. */
export function shownOf(cell: { value: CellValue; display?: string } | null | undefined): string {
  if (cell === null || cell === undefined) return "";
  if (cell.display !== undefined) return cell.display;
  const value = cell.value;
  return value !== null && "string" in value ? value.string : entryOf(value);
}

/** The key of a draft: its sheet by name, as ids are places that move when sheets are added or removed, and its cell. */
export const draftKey = (sheet: string, a1: string): string => `${sheet}!${a1}`;

/** - `editing`: typed and not sent.
 * - `saving`: sent (or being read again before a resend), and not answered yet.
 * - `unsent`: sent while the server did not answer; it goes again once the server answers.
 * - `conflict`: the cell or the sheets moved on since the read it was typed on; it waits for the person's choice. */
export type DraftStatus = "editing" | "saving" | "unsent" | "conflict";

/** What a cell holds, with the text the server calculated for it. */
export type CellContent = { value: CellValue; display?: string };

/** Why a draft cannot go as it is. `local` is a conflict a read found before anything was sent. `current` is the cell
 * as a read found it (null when blank), and `at` the revision of that read and the id it had for the draft's sheet;
 * both are undefined until such a read answers. */
export type CellConflict = { code: string; message: string; local: boolean; current?: CellContent | null; at?: { revision: number; sheet: number } };

const STRUCTURE_CONFLICT = "STRUCTURE_CONFLICT";

/** The conflict of a draft whose sheets changed since the read it was typed on. */
const sheetsChanged = (a1: string): Pick<CellConflict, "code" | "message"> => ({
  code: STRUCTURE_CONFLICT,
  message: `The sheets of the workbook changed after you began editing ${a1}.`,
});

/** Whether a draft in `conflict` may be written over what the cell holds now. Not over sheets that changed: a sheet of
 * the same name may be another sheet, so the person keeps the current cell and types the entry again. */
export const reapplicable = (conflict: CellConflict): boolean => conflict.code !== STRUCTURE_CONFLICT;

/** What a person typed in one cell, with what the cell held in the read they typed it on and that read's revision:
 * the write sends both, so the server can tell whether anything else changed the cell in between. `sheet` is the id
 * the sheet named `name` had in that read, and `origin` that read's revision, which stays for the life of the draft:
 * a reapplied draft is checked from the newer read its notice showed (`revision`, `expected`), and its sheets from
 * `origin` on. */
export type CellDraft = {
  name: string;
  sheet: number;
  a1: string;
  text: string;
  expected: CellValue;
  revision: number;
  origin: number;
  status: DraftStatus;
  conflict: CellConflict | null;
  /** The last refusal of the draft other than a conflict: a formula the engine refused, a cell it does not write. */
  error: string | null;
};

/** What the grid shows.
 * - `phase`: `loading` until the first read, `failed` when it did not come, then `ready`.
 * - `error`: why the last read was refused; `offline`: the server did not answer the last call.
 * - `editable` false, with the server's `refusal`: the workbook is read, but no cell of it may be written here.
 * - `cells`: the cells that are not blank of the last read, by address (kept while the window moves, until the next
 *   read); `read`: the sheet and range that read covered; `merged`: the merged ranges reaching into it; `peers`: the
 *   other members on it.
 * - `origin`: the top left cell of the window; `selected`: the cell the person is on.
 * - `drafts`: every unsaved cell of the workbook, by `draftKey`, on this sheet or another. */
export type LiveCellsState = {
  phase: "loading" | "ready" | "failed";
  error: string | null;
  offline: boolean;
  editable: boolean;
  refusal: LiveRefusal | null;
  revision: number | null;
  sheet: number | null;
  sheets: readonly LiveSheet[];
  cells: Readonly<Record<string, LiveCell>>;
  read: string | null;
  merged: readonly string[];
  peers: readonly LivePeer[];
  origin: CellRef;
  selected: string;
  drafts: Readonly<Record<string, CellDraft>>;
};

export const LIVE_CELLS_LOADING: LiveCellsState = {
  phase: "loading",
  error: null,
  offline: false,
  editable: true,
  refusal: null,
  revision: null,
  sheet: null,
  sheets: [],
  cells: {},
  read: null,
  merged: [],
  peers: [],
  origin: { col: 0, row: 0 },
  selected: "A1",
  drafts: {},
};

/** The name of the sheet on show, or null before the first read. */
export const shownSheet = (state: LiveCellsState): string | null => state.sheets.find((s) => s.id === state.sheet)?.name ?? null;

/** The draft of a cell of the sheet on show. */
export function draftAt(state: LiveCellsState, a1: string): CellDraft | undefined {
  const name = shownSheet(state);
  return name === null ? undefined : state.drafts[draftKey(name, a1)];
}

/** Why one cell of the window may not be written here, though its workbook may: a cell the server marks so, or a
 * cell inside a merged range other than its top left one. Null for a cell that may be written. */
export function cellRefusal(state: LiveCellsState, a1: string): string | null {
  if (state.cells[a1]?.editable === false) return `The server does not write ${a1} cell by cell.`;
  const ref = parseA1(a1);
  if (ref === null) return null;
  for (const range of state.merged) {
    const [from, to = from] = range.split(":").map(parseA1);
    if (!from || !to) continue;
    const inside = ref.col >= from.col && ref.col <= to.col && ref.row >= from.row && ref.row <= to.row;
    if (inside && (ref.col !== from.col || ref.row !== from.row)) return `${a1} is part of the merged cells ${range}: its value is in ${a1Of(from)}.`;
  }
  return null;
}

/** Why the selected cell may not be typed in now, or null when it may: the window on show has not been read yet
 * (`loading`), the workbook may not be written here (`workbook`, the server's refusal says why), or the cell may not
 * (`cell`). */
export function editRefusal(state: LiveCellsState): { kind: "loading" | "workbook" | "cell"; message: string } | null {
  if (state.phase !== "ready" || state.sheet === null || state.read !== `${state.sheet}!${rangeOf(state.origin)}`) {
    return { kind: "loading", message: "The cells have not loaded yet." };
  }
  if (!state.editable) return { kind: "workbook", message: state.refusal?.message ?? "The server does not let anyone write this workbook here." };
  const cell = cellRefusal(state, state.selected);
  return cell === null ? null : { kind: "cell", message: cell };
}

/** What a read of one cell alone found: the revision it read, the id its sheet has there (null when the sheet is gone),
 * and the cell. */
type Inspected = { revision: number; sheet: number | null; cell: CellContent | null };

/** The live cells of one XLSX document in one room, for one member. It holds the window, the drafts and the state of
 * the connection, and tells every listener of each change. Nothing here writes a cell the person did not send (Enter,
 * Delete, Reapply), and nothing sends a draft over a cell that moved on. */
export class LiveCellsModel {
  readonly #api: WorkspaceApi;
  readonly #roomId: string;
  readonly #doc: string;
  readonly #actorId: string;
  readonly #listeners = new Set<(state: LiveCellsState) => void>();
  #state: LiveCellsState = LIVE_CELLS_LOADING;
  /** Reads are numbered; an answer older than one already shown is dropped. */
  #issued = 0;
  #applied = 0;
  #reading = 0;
  /** Reads in a row the server did not answer: the poll waits longer after each. */
  #failures = 0;
  #announcing: Promise<void> | null = null;
  #announceAgain = false;
  #announcedAt = 0;

  constructor(api: WorkspaceApi, roomId: string, doc: string, actor: RoomActor) {
    this.#api = api;
    this.#roomId = roomId;
    this.#doc = doc;
    this.#actorId = actor.id;
  }

  get state(): LiveCellsState {
    return this.#state;
  }

  /** Listen to every new state; returns the unsubscribe. */
  subscribe(listener: (state: LiveCellsState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #set(next: Partial<LiveCellsState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /** Change one draft (`null` drops it). A draft that is gone stays gone. */
  #draft(key: string, patch: Partial<CellDraft> | null): void {
    const current = this.#state.drafts[key];
    if (current === undefined) return;
    const drafts = { ...this.#state.drafts };
    if (patch === null) delete drafts[key];
    else drafts[key] = { ...current, ...patch };
    this.#set({ drafts });
  }

  /** Read the window again. An answer for a window or sheet the grid has left, or older than what it shows, changes
   * nothing. */
  async refresh(): Promise<void> {
    const { sheet, origin } = this.#state;
    const token = ++this.#issued;
    this.#reading++;
    try {
      const read = await this.#api.liveCells(this.#roomId, this.#doc, sheet, rangeOf(origin));
      const now = this.#state;
      const left = now.sheet !== sheet || now.origin.col !== origin.col || now.origin.row !== origin.row;
      if (token < this.#applied || left || (now.revision !== null && read.revision < now.revision)) return;
      this.#applied = token;
      this.#failures = 0;
      // Sheets were added, removed or reordered, and ids are places: follow the sheet on show by its name.
      const shown = now.sheets.find((s) => s.id === sheet)?.name;
      const moved = shown === undefined || read.sheets.find((s) => s.id === read.sheet)?.name === shown ? undefined : read.sheets.find((s) => s.name === shown);
      if (moved !== undefined) {
        this.#set({ sheet: moved.id, sheets: read.sheets, cells: {}, read: null, merged: [], peers: [] });
        await this.refresh();
        return;
      }
      const wasOffline = now.offline;
      this.#apply(read);
      if (sheet === null) void this.announce();
      if (wasOffline) await this.resendUnsent();
    } catch (e) {
      if (token < this.#applied) return;
      const phase = this.#state.phase === "ready" ? "ready" : "failed";
      if (e instanceof ApiError) {
        this.#set({ phase, error: e.message });
      } else {
        this.#failures++;
        this.#set({ phase, offline: true, error: phase === "failed" ? message(e) : this.#state.error });
      }
    } finally {
      this.#reading--;
    }
  }

  #apply(read: LiveCells): void {
    const cells: Record<string, LiveCell> = {};
    for (const cell of read.cells) {
      const ref = parseA1(cell.a1);
      if (ref !== null) cells[a1Of(ref)] = cell;
    }
    const { origin } = this.#state;
    const name = read.sheets.find((s) => s.id === read.sheet)?.name;
    // A draft whose cell this read shows changed since the read it was typed on goes no further on its own.
    const drafts = { ...this.#state.drafts };
    for (const [key, draft] of Object.entries(drafts)) {
      if (draft.name !== name || draft.status === "saving" || draft.status === "conflict") continue;
      const ref = parseA1(draft.a1)!;
      if (ref.col < origin.col || ref.col >= origin.col + VIEW_COLS || ref.row < origin.row || ref.row >= origin.row + VIEW_ROWS) continue;
      const cell = cells[draft.a1];
      if (sameValue(cell?.value ?? null, draft.expected)) continue;
      const current = cell === undefined ? null : { value: cell.value, display: cell.display };
      const at = { revision: read.revision, sheet: read.sheet };
      // The name of the sheet is at another place than in the read the draft was typed on: the sheets changed.
      const why = draft.sheet === read.sheet ? { code: "CELL_CONFLICT", message: `${draft.a1} changed after you began editing it.` } : sheetsChanged(draft.a1);
      drafts[key] = { ...draft, status: "conflict", conflict: { ...why, local: true, current, at } };
    }
    this.#set({
      phase: "ready",
      error: null,
      offline: false,
      editable: read.editable !== false,
      refusal: read.editable === false ? (read.refusal ?? null) : null,
      revision: read.revision,
      sheet: read.sheet,
      sheets: read.sheets,
      cells,
      read: `${read.sheet}!${rangeOf(origin)}`,
      merged: read.merged ?? [],
      peers: read.peers.flatMap((peer) => {
        const ref = parseA1(peer.a1);
        return peer.id === this.#actorId || peer.sheet !== read.sheet || ref === null ? [] : [{ ...peer, a1: a1Of(ref) }];
      }),
      drafts,
    });
  }

  /** Read one cell of the sheet named `name` afresh, by the id the sheet has in the last read. */
  async #inspect(name: string, a1: string): Promise<Inspected> {
    const id = this.#state.sheets.find((s) => s.name === name)?.id;
    if (id === undefined) return { revision: this.#state.revision ?? 0, sheet: null, cell: null };
    const read = await this.#api.liveCells(this.#roomId, this.#doc, id, `${a1}:${a1}`);
    const found = read.sheet === id && read.sheets.find((s) => s.id === id)?.name === name;
    const cell = read.cells.find((c) => parseA1(c.a1) !== null && a1Of(parseA1(c.a1)!) === a1);
    return { revision: read.revision, sheet: found ? id : null, cell: cell === undefined ? null : { value: cell.value, display: cell.display } };
  }

  /** Go to a cell, moving the window to show it, and tell the others. */
  select(a1: string): void {
    const ref = parseA1(a1);
    if (ref === null) return;
    const target = a1Of(ref);
    const origin = originShowing(this.#state.origin, ref);
    const moved = origin !== this.#state.origin;
    const changed = target !== this.#state.selected;
    this.#set(moved ? { selected: target, origin } : { selected: target });
    if (moved) void this.refresh();
    if (changed) void this.announce();
  }

  /** Go to the next cell in a direction, as an arrow key does. */
  move(dCol: number, dRow: number): void {
    const at = parseA1(this.#state.selected)!;
    this.select(a1Of({ col: clamp(at.col + dCol, LAST_COL), row: clamp(at.row + dRow, LAST_ROW) }));
  }

  /** Move the window a page in a direction, and the selected cell with it. */
  page(dCol: number, dRow: number): void {
    const { origin } = this.#state;
    const next = { col: clamp(origin.col + dCol * VIEW_COLS, LAST_COL - VIEW_COLS + 1), row: clamp(origin.row + dRow * VIEW_ROWS, LAST_ROW - VIEW_ROWS + 1) };
    if (next.col === origin.col && next.row === origin.row) return;
    const at = parseA1(this.#state.selected)!;
    const selected = a1Of({ col: at.col + next.col - origin.col, row: at.row + next.row - origin.row });
    this.#set({ origin: next, selected });
    void this.refresh();
    void this.announce();
  }

  /** Go to a typed address; false when it is not one. */
  goTo(text: string): boolean {
    if (parseA1(text) === null) return false;
    this.select(text);
    return true;
  }

  /** Show another sheet, from its top left cell. Drafts of every sheet stay. */
  setSheet(id: number): void {
    if (id === this.#state.sheet || !this.#state.sheets.some((s) => s.id === id)) return;
    this.#set({ sheet: id, origin: { col: 0, row: 0 }, selected: "A1", cells: {}, read: null, merged: [], peers: [] });
    void this.refresh();
    void this.announce();
  }

  /** The person typed `text` as the entry of the selected cell. The first keystroke starts a draft over what the
   * last read found in the cell. */
  edit(text: string): void {
    const { sheet, selected, cells, drafts, revision } = this.#state;
    const name = shownSheet(this.#state);
    if (editRefusal(this.#state) !== null || sheet === null || name === null || revision === null) return;
    const key = draftKey(name, selected);
    if (drafts[key] !== undefined) {
      this.#draft(key, { text, error: null });
      return;
    }
    const draft: CellDraft = { name, sheet, a1: selected, text, expected: cells[selected]?.value ?? null, revision, origin: revision, status: "editing", conflict: null, error: null };
    this.#set({ drafts: { ...drafts, [key]: draft } });
  }

  /** Drop the draft of the selected cell, as Escape does; one in conflict waits for Keep current or Reapply. */
  revert(): void {
    const name = shownSheet(this.#state);
    if (name === null) return;
    const key = draftKey(name, this.#state.selected);
    const status = this.#state.drafts[key]?.status;
    if (status === "editing" || status === "unsent") this.#draft(key, null);
  }

  /** Whether a draft may go now. The workbook's refusal is on show already; a cell's goes on the draft. A cell outside
   * the sheet on show is the server's to judge. */
  #mayGo(key: string, draft: CellDraft): boolean {
    if (!this.#state.editable) return false;
    const refused = draft.name === shownSheet(this.#state) ? cellRefusal(this.#state, draft.a1) : null;
    if (refused !== null) this.#draft(key, { error: refused });
    return refused === null;
  }

  /** Send a draft, by its `draftKey`, as Enter does. A draft in conflict or on its way is left as it is. */
  async submit(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined || draft.status === "saving" || draft.status === "conflict") return;
    if (!this.#mayGo(key, draft)) return;
    const value = valueOfEntry(draft.text);
    if (sameValue(value, draft.expected)) {
      this.#draft(key, null);
      return;
    }
    const { text, a1 } = draft;
    this.#draft(key, { status: "saving", error: null });
    let revision: number;
    try {
      const write = { revision: draft.revision, sheet: draft.sheet, a1, expected: draft.expected, value };
      revision = await this.#api.writeLiveCell(this.#roomId, this.#doc, draft.origin === draft.revision ? write : { ...write, draftRevision: draft.origin });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        this.#draft(key, { status: "conflict", conflict: { code: e.code, message: e.message, local: false } });
        await Promise.all([this.#inspectConflict(key), this.refresh()]);
      } else if (e instanceof ApiError && Object.hasOwn(WORKBOOK_REFUSALS, e.code)) {
        this.#draft(key, { status: "editing" });
        this.#set({ editable: false, refusal: { code: e.code, message: e.message } });
      } else if (e instanceof ApiError) {
        this.#draft(key, { status: "editing", error: e.message });
      } else {
        this.#draft(key, { status: "unsent" });
        this.#set({ offline: true });
      }
      return;
    }
    this.#set({ offline: false });
    // What the person typed on while it was sent stays a draft, a new one over the value that landed.
    if (this.#state.drafts[key]?.text !== text) {
      this.#draft(key, { status: "editing", expected: value, revision, origin: revision });
      await this.refresh();
      return;
    }
    // The draft stays on show until the read after the write has the cell as the server calculated it.
    await this.refresh();
    if (this.#state.drafts[key]?.text !== text) return;
    if (shownSheet(this.#state) === draft.name && (this.#state.revision ?? 0) < revision) this.#set({ cells: { ...this.#state.cells, [a1]: { a1, value } } });
    this.#draft(key, null);
  }

  /** Read what the cell of a draft in conflict holds now, for its notice. */
  async #inspectConflict(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined) return;
    try {
      const fresh = await this.#inspect(draft.name, draft.a1);
      const now = this.#state.drafts[key];
      const conflict = now?.conflict;
      if (now === undefined || conflict === null || conflict === undefined) return;
      if (fresh.sheet === null) {
        this.#draft(key, { error: `The sheet ${draft.name} is not in the workbook any more.` });
        return;
      }
      // An answer older than the read the notice shows changes nothing.
      if (conflict.at !== undefined && fresh.revision < conflict.at.revision) return;
      // The name of the sheet is at another place than in the read the draft was typed on: the sheets changed.
      const moved = fresh.sheet === now.sheet ? {} : sheetsChanged(now.a1);
      this.#draft(key, { conflict: { ...conflict, ...moved, current: fresh.cell, at: { revision: fresh.revision, sheet: fresh.sheet } }, error: null });
    } catch (e) {
      if (e instanceof ApiError) this.#draft(key, { error: e.message });
      else this.#set({ offline: true });
    }
  }

  /** Drop a draft, by its `draftKey`, in favour of what the cell holds now. */
  async useCurrent(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined || draft.status === "saving") return;
    this.#draft(key, null);
    await this.refresh();
  }

  /** Write a draft in conflict, by its `draftKey`, over what its notice shows the cell holds, at the revision of the
   * read that found it: the person chose their entry over that. Whatever was written to the cell or the sheets since
   * that read, the server refuses, and the notice shows it for the person to choose again. While what the cell holds
   * is not known, this reads it and writes nothing. A draft whose sheets changed is not reapplied. */
  async reapply(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft?.status !== "conflict" || draft.conflict === null || !reapplicable(draft.conflict)) return;
    if (!this.#mayGo(key, draft)) return;
    const { current, at } = draft.conflict;
    if (current === undefined || at === undefined) {
      await this.#inspectConflict(key);
      return;
    }
    this.#draft(key, { status: "editing", sheet: at.sheet, revision: at.revision, expected: current?.value ?? null, conflict: null, error: null });
    await this.submit(key);
  }

  /** Send again every draft the server did not answer. */
  async resendUnsent(): Promise<void> {
    for (const [key, draft] of Object.entries(this.#state.drafts)) {
      if (draft.status === "unsent") await this.submit(key);
    }
  }

  /** Try the server again: read the window, then send what did not go. */
  async retry(): Promise<void> {
    await this.refresh();
    if (!this.#state.offline) await this.resendUnsent();
  }

  /** Tell the others which cell the person is on. Announcements go one at a time, and the last one asked for goes
   * last. Who is where is a courtesy: a refusal of it changes nothing on the page. */
  announce(): Promise<void> {
    if (this.#announcing !== null) {
      this.#announceAgain = true;
      return this.#announcing;
    }
    const { sheet, selected } = this.#state;
    if (sheet === null) return Promise.resolve();
    this.#announcedAt = Date.now();
    this.#announcing = this.#api
      .announceLiveCell(this.#roomId, this.#doc, { sheet, a1: selected })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError)) this.#set({ offline: true });
      })
      .finally(() => {
        this.#announcing = null;
        if (this.#announceAgain) {
          this.#announceAgain = false;
          void this.announce();
        }
      });
    return this.#announcing;
  }

  /** Follow the room while the grid is open (see `follow`), and announce the selected cell again before it expires.
   * Returns the stop. */
  start(): () => void {
    return follow({
      tick: () => {
        if (this.#reading === 0) void this.refresh();
        if (Date.now() - this.#announcedAt >= ANNOUNCE_MS) void this.announce();
      },
      failures: () => this.#failures,
      online: () => void this.retry(),
      offline: () => this.#set({ offline: true }),
      shown: () => void this.refresh(),
    });
  }
}
