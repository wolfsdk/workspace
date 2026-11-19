// Live cells: `GET`, `PUT` and `POST /api/rooms/<room>/docs/<doc>/live-cells`, the cell-by-cell collaboration on the head
// of one XLSX document.
//
//   GET   a window of one sheet at the head: the cells (a formula as its text, with the value the engine calculated as
//         `display`), the sheets, the merged ranges that reach into the window, the other members' selections that are
//         in it, and whether and why the workbook may be written here (`editable`, `refusal`).
//   PUT   one cell, over what the caller read in it (`expected`) at the revision of that read. It commits one `set`
//         through the room service, so it is one session entry like any other edit. A write against a head that moved
//         on is kept only when the history since the revision of the read is complete and is nothing but `set`s of
//         other cells; any other history, and any history that is not all there, is `STRUCTURE_CONFLICT`, whatever else
//         the span holds; the same cell, even when it came back to what was read, is `CELL_CONFLICT`. The caller keeps
//         its draft and decides. A draft that is written again over a newer read says the revision it was first written
//         at (`draftRevision`, default `revision`, from 0 to `revision`): the history since then must be nothing but
//         `set`s of single cells too, and its writes of the cell itself are the ones the newer read has resolved.
//   POST  the cell the caller is on, for the others' reads until it expires.
//
// What the server will write. The released engine (0.2.25) neither reports sheet protection or locked cells nor tells
// an ordinary formula from a shared, array or spill one, so no workbook is writable by default. A workbook is writable
// when the sha256 of its head bytes is one the operator attested (`--live-cells-attest`: bytes the operator reviewed as
// unprotected, with standalone scalar values and formulas only), or the result of this server's own validated write on
// bytes that were writable: a write is a typed scalar, or a formula of the class below, to a plain cell. The set of
// writable digests is content-addressed and lives in memory: after a restart, attest the head again.
//
// The identity of a caller is the member the token stands for. Guests, agents and a read-only workspace are refused
// by the route before anything here runs.
import type { RoomActor, RoomHead, RoomSessionEntry } from "@wolfsdk/protocol/workspace";
import { ROOM_REVISION_MISMATCH } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker, type RoomFailure, type RoomService, type WorkerPool } from "@wolfsdk/server";
import { ask, askWithSegments } from "./engine.ts";

/** What one cell holds, as live cells reads and writes it: a formula keeps its leading `=`. `null` is a blank cell. */
export type CellValue = { string: string } | { number: number } | { boolean: boolean } | { formula: string } | null;

export type LiveCellsOptions = {
  /** The engine workers a read opens a head with. */
  pool: Pick<WorkerPool, "withWorker">;
  /** The sha256 (64 hex digits) of each XLSX file the operator attests: reviewed as unprotected and made of standalone
   * scalar values and formulas only. Nothing else is writable until a write of this server inherits from one of them. */
  attested: readonly string[];
  /** The clock of the selections, in milliseconds. Default `Date.now`. */
  now?: () => number;
};

/** Who is calling, as the route resolved it from the token: a member, never a guest or an agent. */
export type LiveCaller = {
  roomId: string;
  doc: string;
  actor: RoomActor;
  /** The refusal of a write now (a read-only workspace), or `null`. */
  refusal: RoomFailure | null;
};

type LiveError = { status: number; error: { code: string; message: string; [member: string]: unknown } };

/** What the route sends: a JSON body, an empty 204, an error body with its status, or a failure of the room service. */
export type LiveReply = { status: 200; body: unknown } | { status: 204 } | LiveError | { failure: RoomFailure };

export const LIVE_CELLS_UNATTESTED = "LIVE_CELLS_UNATTESTED";
export const CELL_CONFLICT = "CELL_CONFLICT";
export const STRUCTURE_CONFLICT = "STRUCTURE_CONFLICT";
export const CELL_UNSUPPORTED = "CELL_UNSUPPORTED";
export const UNSUPPORTED_FORMULA = "UNSUPPORTED_FORMULA";

export const DEFAULT_RANGE = "A1:T50";
export const MAX_WINDOW_CELLS = 10_000;
export const MAX_WINDOW_ROWS = 1000;
export const MAX_WINDOW_COLS = 200;
/** How long an announced selection lasts. */
export const PRESENCE_TTL_MS = 30_000;
/** Most selections of one workbook that are live at once; the one announced longest ago goes first. */
export const PRESENCE_MAX = 64;
const WORKBOOKS_MAX = 256;
const MAX_ATTEMPTS = 4;
const MAX_REBASE = 256;
const WINDOWS_CAP = 64;
const STRUCTURES_CAP = 64;
const INHERITED_CAP = 1024;
const MAX_STRING = 32_767;
const MAX_FORMULA = 1024;
const MAX_ROW = 1_048_576;
const MAX_COL = 16_384;

/** The formulas a write may carry, in words. */
export const FORMULA_CLASS = "a formula built from numbers, same-sheet A1 cell references (such as B3 or $B$3), + - * / ^, unary + and -, and parentheses";

// --- A1 ----------------------------------------------------------------------------------------------------------

type Cell = { row: number; col: number };
type Rect = { row0: number; col0: number; rows: number; cols: number };

const CELL = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnLetters(col: number): string {
  let letters = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** `B2` as a cell, or null for anything that is not one inside the grid of a sheet (a `$`, a range, a lowercase name). */
export function parseCell(text: string): Cell | null {
  const match = CELL.exec(text);
  if (match === null) return null;
  const col = columnNumber(match[1]!);
  const row = Number(match[2]);
  return col <= MAX_COL && row <= MAX_ROW ? { row, col } : null;
}

export const cellName = (cell: Cell): string => `${columnLetters(cell.col)}${cell.row}`;

/** `A1:H15`, `B2:B2` or `B2` as a window, or the reason it is not one. */
function parseRange(text: string): Rect | string {
  const parts = text.toUpperCase().split(":");
  if (parts.length > 2) return `${JSON.stringify(text)} is not a range: use A1:H15, B2:B2 or B2`;
  const from = parseCell(parts[0]!);
  const to = parseCell(parts[1] ?? parts[0]!);
  if (from === null || to === null) return `${JSON.stringify(text)} is not a range of cells inside the sheet: use A1:H15, B2:B2 or B2, without $`;
  if (to.row < from.row || to.col < from.col) return `${JSON.stringify(text)} must run from its top left cell to its bottom right`;
  const rows = to.row - from.row + 1;
  const cols = to.col - from.col + 1;
  if (rows > MAX_WINDOW_ROWS || cols > MAX_WINDOW_COLS || rows * cols > MAX_WINDOW_CELLS) {
    return `a window is at most ${MAX_WINDOW_CELLS} cells, ${MAX_WINDOW_ROWS} rows and ${MAX_WINDOW_COLS} columns`;
  }
  return { row0: from.row, col0: from.col, rows, cols };
}

const within = (rect: Rect, cell: Cell): boolean =>
  cell.row >= rect.row0 && cell.row < rect.row0 + rect.rows && cell.col >= rect.col0 && cell.col < rect.col0 + rect.cols;

/** The anchor, and so the whole of the range, when `cell` is inside a merged range `a1` of the engine and is not its anchor. */
function coveredByMerge(merged: readonly string[], cell: Cell): boolean {
  for (const range of merged) {
    const [first, last] = range.split(":");
    const from = first === undefined ? null : parseCell(first);
    const to = last === undefined ? from : parseCell(last);
    if (from === null || to === null) continue;
    const inside = cell.row >= from.row && cell.row <= to.row && cell.col >= from.col && cell.col <= to.col;
    if (inside && (cell.row !== from.row || cell.col !== from.col)) return true;
  }
  return false;
}

// --- the formulas a write may carry ------------------------------------------------------------------------------

const NUMBER = /[0-9]+(?:\.[0-9]+)?|\.[0-9]+/y;
const REFERENCE = /\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})/y;

/** Why `formula` is not one of the formulas a write may carry, or null when it is. The class is a deliberate minimum, so
 * that what is written is an ordinary scalar formula whatever the engine would accept: numbers, same-sheet A1 references
 * (not ranges, not other sheets, not names, not functions), the operators + - * / ^ with unary signs, and parentheses,
 * with no spaces. A formula that refers to its own cell is circular and is refused. */
export function formulaProblem(formula: string, own: Cell): string | null {
  if (!formula.startsWith("=")) return "a formula starts with =";
  if (formula.length > MAX_FORMULA) return `a formula is at most ${MAX_FORMULA} characters`;
  const unsupported = `this server writes only ${FORMULA_CLASS}`;
  let at = 1;
  let depth = 0;
  let circular = false;
  const nested = (parse: () => boolean): boolean => {
    if (++depth > 64) return false;
    const ok = parse();
    depth--;
    return ok;
  };
  const atom = (): boolean => {
    const c = formula[at];
    if (c === "(") {
      at++;
      if (!nested(expression) || formula[at] !== ")") return false;
      at++;
      return true;
    }
    if (c !== undefined && (c === "." || (c >= "0" && c <= "9"))) {
      NUMBER.lastIndex = at;
      const match = NUMBER.exec(formula);
      if (match === null) return false;
      at += match[0].length;
      return true;
    }
    REFERENCE.lastIndex = at;
    const match = REFERENCE.exec(formula);
    if (match === null) return false;
    const col = columnNumber(match[1]!);
    const row = Number(match[2]);
    if (col > MAX_COL || row > MAX_ROW) return false;
    if (col === own.col && row === own.row) circular = true;
    at += match[0].length;
    return true;
  };
  const unary = (): boolean => {
    if (formula[at] === "+" || formula[at] === "-") {
      at++;
      return nested(unary);
    }
    if (!atom()) return false;
    if (formula[at] === "^") {
      at++;
      return nested(unary);
    }
    return true;
  };
  const term = (): boolean => {
    if (!unary()) return false;
    while (formula[at] === "*" || formula[at] === "/") {
      at++;
      if (!unary()) return false;
    }
    return true;
  };
  const expression = (): boolean => {
    if (!term()) return false;
    while (formula[at] === "+" || formula[at] === "-") {
      at++;
      if (!term()) return false;
    }
    return true;
  };
  if (!expression() || at !== formula.length) return unsupported;
  return circular ? "a formula may not refer to its own cell" : null;
}

// --- values ------------------------------------------------------------------------------------------------------

/** The value in a request, or the reason it is not one. */
function parseValue(raw: unknown, field: string): CellValue | { problem: string } {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return { problem: `${field} is null or one of {"string"}, {"number"}, {"boolean"}, {"formula"}` };
  const keys = Object.keys(raw);
  const key = keys[0];
  const value = (raw as Record<string, unknown>)[key ?? ""];
  if (keys.length !== 1 || key === undefined) return { problem: `${field} holds exactly one of string, number, boolean, formula` };
  if (key === "string" && typeof value === "string") return { string: value };
  if (key === "formula" && typeof value === "string") return { formula: value };
  if (key === "boolean" && typeof value === "boolean") return { boolean: value };
  if (key === "number" && typeof value === "number" && Number.isFinite(value)) return { number: value };
  return { problem: `${field}.${key} is not a valid ${key === "number" ? "finite number" : key}` };
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why a cell may not be written with `value`, as the error to answer, or null. */
function valueProblem(value: CellValue, cell: Cell): LiveError | null {
  if (value === null || "number" in value || "boolean" in value) return null;
  if ("formula" in value) {
    const problem = formulaProblem(value.formula, cell);
    return problem === null ? null : fail(422, UNSUPPORTED_FORMULA, problem);
  }
  if (value.string === "") return fail(400, "BAD_REQUEST", "write null to clear a cell: an empty string is not a value");
  if (value.string.length > MAX_STRING) return fail(422, CELL_UNSUPPORTED, `text is at most ${MAX_STRING} characters`);
  if (CONTROL.test(value.string)) return fail(422, CELL_UNSUPPORTED, "text may not hold control characters other than tab and line breaks");
  return null;
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b;
  if ("string" in a) return "string" in b && a.string === b.string;
  if ("number" in a) return "number" in b && a.number === b.number;
  if ("boolean" in a) return "boolean" in b && a.boolean === b.boolean;
  return "formula" in b && a.formula === b.formula;
}

// --- what the engine says of a head ------------------------------------------------------------------------------

type SheetInfo = { id: number; name: string; visible: boolean };
type SeenCell = { a1: string; row: number; col: number; value: CellValue; display: string; editable: boolean };
type View = { sheet: number; sheets: SheetInfo[]; merged: string[]; cells: SeenCell[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The cell the engine reports, in the terms of a write: a formula by its text (never the value it calculated), else the
 * typed value. A cell that holds something a write could not put back is `editable: false`, and has no value. */
function seeCell(raw: unknown): SeenCell | null {
  if (!isObject(raw) || typeof raw.a1 !== "string") throw new EngineFault("the engine described a cell without an address");
  const cell = parseCell(raw.a1);
  if (cell === null) throw new EngineFault(`the engine described a cell at ${JSON.stringify(raw.a1)}`);
  const display = typeof raw.display === "string" ? raw.display : "";
  const seen = (value: CellValue, editable: boolean): SeenCell => ({ a1: raw.a1 as string, row: cell.row, col: cell.col, value, display, editable });
  const { formula, value } = raw;
  if (formula !== null && formula !== undefined) {
    return typeof formula === "string" && formula.startsWith("=") && formula.length > 1 ? seen({ formula }, true) : seen(null, false);
  }
  if (value === null || value === undefined) return null;
  if (isObject(value)) {
    const keys = Object.keys(value);
    const [key] = keys;
    const inner = key === undefined ? undefined : value[key];
    if (keys.length === 1 && key === "string" && typeof inner === "string") return seen({ string: inner }, true);
    if (keys.length === 1 && key === "number" && typeof inner === "number" && Number.isFinite(inner)) return seen({ number: inner }, true);
    if (keys.length === 1 && (key === "bool" || key === "boolean") && typeof inner === "boolean") return seen({ boolean: inner }, true);
  }
  return seen(null, false);
}

/** Least-recently-used map, for what is cheap to read again. */
class Lru<V> {
  readonly #map = new Map<string, V>();
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value as string);
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}

/** The sheets of a head from the structure the engine extracts: their place (the id live cells uses), name and visibility. */
function sheetsOfStructure(structure: unknown): SheetInfo[] {
  if (!isObject(structure) || !Array.isArray(structure.sheets)) throw new EngineFault("the engine's structure of the workbook has no sheets");
  return structure.sheets.map((sheet: unknown) => {
    if (!isObject(sheet) || typeof sheet.index !== "number" || !Number.isInteger(sheet.index) || sheet.index < 1 || typeof sheet.name !== "string") {
      throw new EngineFault("the engine's structure of the workbook names a sheet without a place or a name");
    }
    return { id: sheet.index, name: sheet.name, visible: sheet.kind === "worksheet" && sheet.visibility === "visible" };
  });
}

// --- the eligibility of a head -----------------------------------------------------------------------------------

/** The digests of the bytes this server writes cells of. The operator's are fixed; the digests of this server's own
 * writes are kept up to a limit, oldest out first: a head that dropped out needs attesting again. */
class Writable {
  readonly #attested: ReadonlySet<string>;
  readonly #inherited = new Lru<true>(INHERITED_CAP);
  constructor(attested: readonly string[]) {
    for (const digest of attested) {
      if (!/^[0-9a-f]{64}$/i.test(digest)) throw new RangeError(`${JSON.stringify(digest)} is not a sha256 digest (64 hexadecimal digits)`);
    }
    this.#attested = new Set(attested.map((digest) => digest.toLowerCase()));
  }
  has(sha256: string): boolean {
    return this.#attested.has(sha256) || this.#inherited.has(sha256);
  }
  inherit(sha256: string): void {
    this.#inherited.set(sha256, true);
  }
}

// --- selections --------------------------------------------------------------------------------------------------

type Selection = { actor: RoomActor; sheet: number; a1: string; cell: Cell; expires: number };

/** The selections announced, by workbook and then by member: one each, expiring, capped. */
class Selections {
  readonly #books = new Map<string, Map<string, Selection>>();
  readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  #live(book: Map<string, Selection>): void {
    const now = this.now();
    for (const [key, selection] of book) if (selection.expires <= now) book.delete(key);
  }

  announce(workbook: string, actor: RoomActor, sheet: number, a1: string, cell: Cell): void {
    let book = this.#books.get(workbook);
    if (book === undefined) {
      if (this.#books.size >= WORKBOOKS_MAX) {
        for (const [key, other] of this.#books) {
          this.#live(other);
          if (other.size === 0) this.#books.delete(key);
        }
        if (this.#books.size >= WORKBOOKS_MAX) this.#books.delete(this.#books.keys().next().value as string);
      }
      book = new Map();
      this.#books.set(workbook, book);
    }
    this.#live(book);
    const key = `${actor.kind}:${actor.id}`;
    // Reinserting moves the member to the end, so the first entry is always the one announced longest ago.
    book.delete(key);
    if (book.size >= PRESENCE_MAX) book.delete(book.keys().next().value as string);
    book.set(key, { actor, sheet, a1, cell, expires: this.now() + PRESENCE_TTL_MS });
  }

  /** The live selections of others on `sheet` inside `rect`. */
  peers(workbook: string, caller: RoomActor, sheet: number, rect: Rect): { id: string; name: string; sheet: number; a1: string }[] {
    const book = this.#books.get(workbook);
    if (book === undefined) return [];
    this.#live(book);
    const own = `${caller.kind}:${caller.id}`;
    const peers: { id: string; name: string; sheet: number; a1: string }[] = [];
    for (const [key, selection] of book) {
      if (key !== own && selection.sheet === sheet && within(rect, selection.cell)) {
        peers.push({ id: selection.actor.id, name: selection.actor.name, sheet: selection.sheet, a1: selection.a1 });
      }
    }
    return peers;
  }
}

// --- the service -------------------------------------------------------------------------------------------------

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): LiveError => ({ status, error: { code, message, ...extra } });
const bad = (message: string): LiveError => fail(400, "BAD_REQUEST", message);

function engineReply(e: unknown): LiveReply {
  if (e instanceof EngineRefusal) return { failure: { code: e.isEngineFailure || e.isLicense ? "ENGINE_FAILED" : "BAD_REQUEST", message: e.message } };
  if (e instanceof EngineFault) return { failure: { code: "ENGINE_FAILED", message: e.message } };
  throw e;
}

const SET_TARGET = /^sheet:(#[0-9]+|[^/#][^/]*)\/cell:([A-Za-z]{1,3}[0-9]{1,7})$/;

/** The cells a session entry wrote, when it is nothing but `set`s of single cells (the kind of write this server makes), else null. */
function cellsWritten(entry: RoomSessionEntry, sheets: readonly SheetInfo[]): { sheet: number; cell: Cell }[] | null {
  const written: { sheet: number; cell: Cell }[] = [];
  for (const op of entry.batch.ops) {
    if (op.op !== "set" || typeof op.target !== "string") return null;
    if (Object.keys(op).some((key) => key !== "op" && key !== "target" && key !== "value")) return null;
    const match = SET_TARGET.exec(op.target);
    if (match === null) return null;
    let sheet: number | undefined;
    if (match[1]!.startsWith("#")) {
      sheet = Number(match[1]!.slice(1));
    } else {
      let name: string;
      try {
        name = decodeURIComponent(match[1]!);
      } catch {
        return null;
      }
      sheet = sheets.find((s) => s.name === name)?.id;
    }
    const cell = parseCell(match[2]!.toUpperCase());
    if (sheet === undefined || !sheets.some((s) => s.id === sheet) || cell === null) return null;
    written.push({ sheet, cell });
  }
  return written;
}

type Proof = { conflict: null } | { conflict: "cell" } | { conflict: "structure"; message: string };

const HISTORY_CHANGED = "the workbook changed in ways other than the writes of single cells since your read: read it again";

/** What the history of one document from `base.revision` to `head` did, from its session entries `log`. Everything
 * committed after the base must be proven, by an unbroken chain of entries that ends at the head bytes, to be nothing
 * but writes of single cells: history that is anything else, or not all there, is a structural conflict, whatever else
 * the span holds. Only a span that is proven so can have written the base cell, and that is a cell conflict, even when
 * the cell came back to what was read. Otherwise the span is disjoint from the cell. */
function proveSpan(log: readonly RoomSessionEntry[], base: { revision: number; sheet: number; cell: Cell }, head: RoomHead, sheets: readonly SheetInfo[]): Proof {
  const structure = (message: string): Proof => ({ conflict: "structure", message });
  const span = head.revision - base.revision;
  if (span > MAX_REBASE) return structure(`the workbook has ${span} newer revisions than your read: read it again`);
  const entries = log.filter((entry) => entry.revision > base.revision && entry.revision <= head.revision).sort((a, b) => a.revision - b.revision);
  if (entries.length !== span || entries.some((entry, i) => entry.revision !== base.revision + 1 + i)) return structure(HISTORY_CHANGED);
  // The entry before the first one pins the revision of the read to the bytes the chain starts from.
  const anchor = base.revision === 0 ? null : log.find((entry) => entry.revision === base.revision);
  if (base.revision > 0 && (anchor === undefined || anchor === null || entries[0]!.base_sha256 !== anchor.result_sha256)) return structure(HISTORY_CHANGED);
  for (let i = 1; i < entries.length; i++) if (entries[i]!.base_sha256 !== entries[i - 1]!.result_sha256) return structure(HISTORY_CHANGED);
  if (entries.length > 0 && entries[entries.length - 1]!.result_sha256 !== head.sha256) return structure(HISTORY_CHANGED);
  let touched = false;
  for (const entry of entries) {
    const written = cellsWritten(entry, sheets);
    if (written === null) return structure(HISTORY_CHANGED);
    if (written.some((w) => w.sheet === base.sheet && w.cell.row === base.cell.row && w.cell.col === base.cell.col)) touched = true;
  }
  return touched ? { conflict: "cell" } : { conflict: null };
}

type Parsed = { revision: number; draftRevision: number; sheet: number; a1: string; cell: Cell; expected: CellValue; value: CellValue };

const WRITE_KEYS: Record<string, true> = { revision: true, draftRevision: true, sheet: true, a1: true, expected: true, value: true };

export class LiveCells {
  readonly #service: RoomService;
  readonly #pool: Pick<WorkerPool, "withWorker">;
  readonly #writable: Writable;
  readonly #selections: Selections;
  readonly #views = new Lru<View>(WINDOWS_CAP);
  readonly #structures = new Lru<SheetInfo[]>(STRUCTURES_CAP);
  readonly #flights = new Map<string, Promise<View | string>>();
  readonly #writes = new Map<string, Promise<void>>();

  constructor(service: RoomService, options: LiveCellsOptions) {
    this.#service = service;
    this.#pool = options.pool;
    this.#writable = new Writable(options.attested);
    this.#selections = new Selections(options.now ?? Date.now);
  }

  /** Whether the head with this digest may be written cell by cell. */
  writable(sha256: string): boolean {
    return this.#writable.has(sha256);
  }

  // GET ------------------------------------------------------------------------------------------------------------

  async get(caller: LiveCaller, query: URLSearchParams): Promise<LiveReply> {
    const range = parseRange(query.get("range") ?? DEFAULT_RANGE);
    if (typeof range === "string") return bad(range);
    let sheet: number | null = null;
    const asked = query.get("sheet");
    if (asked !== null) {
      sheet = /^[0-9]{1,6}$/.test(asked) ? Number(asked) : 0;
      if (sheet < 1) return bad("sheet is the number of a sheet, from 1");
    }
    const read = await this.#service.readHead(caller.roomId, caller.actor, caller.doc);
    if (!read.ok) return { failure: read.error };
    const { head, bytes } = read.value;
    if (head.format !== "xlsx") return bad("live cells are for XLSX documents");
    let view: View | string;
    try {
      view = await this.#view(head, bytes, sheet, range);
    } catch (e) {
      return engineReply(e);
    }
    if (typeof view === "string") return bad(view);
    let refusal: { code: string; message: string } | null = null;
    if (caller.refusal !== null) refusal = { code: caller.refusal.code, message: caller.refusal.message };
    else if (!this.#writable.has(head.sha256)) refusal = { code: LIVE_CELLS_UNATTESTED, message: this.#unattested(head) };
    return {
      status: 200,
      body: {
        revision: head.revision,
        sheet: view.sheet,
        sheets: view.sheets.filter((s) => s.visible).map(({ id, name }) => ({ id, name })),
        editable: refusal === null,
        refusal,
        merged: view.merged,
        cells: view.cells.map(({ a1, value, display, editable }) => ({
          a1,
          value,
          ...(display === "" || (value !== null && "string" in value && value.string === display) ? {} : { display }),
          ...(editable ? {} : { editable: false }),
        })),
        peers: this.#selections.peers(`${caller.roomId}\0${caller.doc}`, caller.actor, view.sheet, range),
      },
    };
  }

  // POST -----------------------------------------------------------------------------------------------------------

  async post(caller: LiveCaller, body: Record<string, unknown>): Promise<LiveReply> {
    const { sheet, a1 } = body;
    if (Object.keys(body).some((key) => key !== "sheet" && key !== "a1")) return bad("send sheet and a1 only");
    if (typeof sheet !== "number" || !Number.isInteger(sheet) || sheet < 1) return bad("sheet is the number of a sheet, from 1");
    const cell = typeof a1 === "string" ? parseCell(a1.toUpperCase()) : null;
    if (cell === null) return bad("a1 is one cell inside the sheet, such as B2, without $");
    const read = await this.#service.readHead(caller.roomId, caller.actor, caller.doc);
    if (!read.ok) return { failure: read.error };
    const { head, bytes } = read.value;
    if (head.format !== "xlsx") return bad("live cells are for XLSX documents");
    let sheets: SheetInfo[];
    try {
      sheets = await this.#sheets(head, bytes);
    } catch (e) {
      return engineReply(e);
    }
    if (!sheets.some((s) => s.id === sheet && s.visible)) return bad(`sheet ${sheet} is not a visible worksheet`);
    this.#selections.announce(`${caller.roomId}\0${caller.doc}`, caller.actor, sheet, cellName(cell), cell);
    return { status: 204 };
  }

  // PUT ------------------------------------------------------------------------------------------------------------

  /** Writes to one document go one at a time here, so that members writing different cells together do not race each
   * other for the revision. A write of another kind can still win it: that is retried below. */
  put(caller: LiveCaller, body: Record<string, unknown>): Promise<LiveReply> {
    const parsed = this.#parseWrite(body);
    if ("status" in parsed) return Promise.resolve(parsed);
    const key = `${caller.roomId}\0${caller.doc}`;
    const turn = (this.#writes.get(key) ?? Promise.resolve()).then(() => this.#write(caller, parsed));
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#writes.set(key, tail);
    void tail.then(() => {
      if (this.#writes.get(key) === tail) this.#writes.delete(key);
    });
    return turn;
  }

  async #write(caller: LiveCaller, parsed: Parsed): Promise<LiveReply> {
    const { revision, draftRevision, sheet, cell, expected, value } = parsed;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const read = await this.#service.readHead(caller.roomId, caller.actor, caller.doc);
      if (!read.ok) return { failure: read.error };
      const { head, bytes } = read.value;
      if (head.format !== "xlsx") return bad("live cells are for XLSX documents");
      if (!this.#writable.has(head.sha256)) return fail(403, LIVE_CELLS_UNATTESTED, this.#unattested(head));
      let seen: View | string;
      let sheets: SheetInfo[];
      try {
        seen = await this.#view(head, bytes, sheet, { row0: cell.row, col0: cell.col, rows: 1, cols: 1 });
        sheets = await this.#sheets(head, bytes);
      } catch (e) {
        return engineReply(e);
      }
      if (typeof seen === "string") {
        return revision === head.revision
          ? bad(seen)
          : fail(409, STRUCTURE_CONFLICT, `${seen}: the workbook changed since your read`, { revision: head.revision });
      }
      const current = seen.cells.find((c) => c.row === cell.row && c.col === cell.col);
      if (coveredByMerge(seen.merged, cell)) return fail(422, CELL_UNSUPPORTED, `${cellName(cell)} is inside a merged range and is not its first cell`);
      if (current !== undefined && !current.editable) return fail(422, CELL_UNSUPPORTED, `${cellName(cell)} holds something live cells cannot write over`);
      const now = current?.value ?? null;
      if (revision > head.revision) {
        return fail(409, STRUCTURE_CONFLICT, "the workbook is older than your copy: read it again", { revision: head.revision });
      }
      // The history is read once, and only when it is needed: for a read that is behind the head, or for a draft that is
      // being reapplied (written at a revision before the read it is now written over).
      if (draftRevision < revision || revision < head.revision) {
        const log = await this.#log(caller);
        if ("failure" in log) return log;
        // A reapplied draft: what changed since it was written must be nothing but writes of single cells. Its writes of
        // this very cell are what the caller has since read and resolved, so only they are let through.
        if (draftRevision < revision) {
          const drafted = proveSpan(log, { revision: draftRevision, sheet, cell }, head, sheets);
          if (drafted.conflict === "structure") return fail(409, STRUCTURE_CONFLICT, drafted.message, { revision: head.revision });
        }
        if (revision < head.revision) {
          const proof = proveSpan(log, { revision, sheet, cell }, head, sheets);
          if (proof.conflict === "structure") return fail(409, STRUCTURE_CONFLICT, proof.message, { revision: head.revision });
          if (proof.conflict === "cell") {
            return fail(409, CELL_CONFLICT, `${cellName(cell)} was written since your read`, { revision: head.revision, current: now });
          }
        }
      }
      if (!sameValue(now, expected)) {
        return fail(409, CELL_CONFLICT, `${cellName(cell)} holds something other than what you read`, { revision: head.revision, current: now });
      }
      if (sameValue(now, value)) return { status: 200, body: { revision: head.revision } };
      const edit = await this.#service.edit(caller.roomId, caller.actor, {
        doc_name: caller.doc,
        base_revision: head.revision,
        mode: "commit",
        batch: { ops: [{ op: "set", target: `sheet:#${sheet}/cell:${cellName(cell)}`, value: value === null ? { empty: true } : value }], label: "live cell" },
      });
      if (edit.ok) {
        if (edit.value.mode !== "commit") return { failure: { code: "ENGINE_FAILED", message: "the room held the write as a proposal" } };
        // The base was a writable head and the write passed the checks above: the bytes it made are writable too.
        this.#writable.inherit(edit.value.head.sha256);
        return { status: 200, body: { revision: edit.value.head.revision } };
      }
      // Someone committed between the read and the write: read again, and prove again that what came in is disjoint.
      if (edit.error.code !== ROOM_REVISION_MISMATCH) return { failure: edit.error };
    }
    return fail(409, STRUCTURE_CONFLICT, "the workbook kept changing: read it again");
  }

  #parseWrite(body: Record<string, unknown>): Parsed | LiveError {
    for (const key of Object.keys(body)) if (!Object.hasOwn(WRITE_KEYS, key)) return bad(`${JSON.stringify(key)} is not a member of a write`);
    const { revision, sheet, a1 } = body;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return bad("revision is the revision of the read, from 0");
    if (typeof sheet !== "number" || !Number.isInteger(sheet) || sheet < 1) return bad("sheet is the number of a sheet, from 1");
    const cell = typeof a1 === "string" ? parseCell(a1.toUpperCase()) : null;
    if (cell === null || typeof a1 !== "string") return bad("a1 is one cell inside the sheet, such as B2, without $");
    const draftRevision = "draftRevision" in body ? body.draftRevision : revision;
    if (typeof draftRevision !== "number" || !Number.isSafeInteger(draftRevision) || draftRevision < 0 || draftRevision > revision) {
      return bad("draftRevision is the revision the draft was first written at: a whole number from 0 up to revision");
    }
    if (!("expected" in body) || !("value" in body)) return bad("a write has expected and value: the cell as read, and the cell as it is to be");
    const expected = parseValue(body.expected, "expected");
    if (expected !== null && "problem" in expected) return bad(expected.problem);
    const value = parseValue(body.value, "value");
    if (value !== null && "problem" in value) return bad(value.problem);
    const problem = valueProblem(value, cell);
    if (problem !== null) return problem;
    return { revision, draftRevision, sheet, a1: cellName(cell), cell, expected, value };
  }

  /** The entries of the session log that are this document's, or why the room could not be read. */
  async #log(caller: LiveCaller): Promise<RoomSessionEntry[] | { failure: RoomFailure }> {
    const room = await this.#service.getRoom(caller.roomId, caller.actor);
    if (!room.ok) return { failure: room.error };
    return room.value.session_log.filter((entry) => entry.doc_name === caller.doc);
  }

  #unattested(head: RoomHead): string {
    return (
      `the bytes of ${head.name} at revision ${head.revision} (sha256 ${head.sha256}) are not attested for live cell writes: ` +
      "an operator who has reviewed the workbook for protected cells and special formulas starts the server with --live-cells-attest <sha256>"
    );
  }

  // The engine --------------------------------------------------------------------------------------------------

  /** The sheets of a head: from the structure the engine extracts, once per head. */
  async #sheets(head: RoomHead, bytes: Uint8Array): Promise<SheetInfo[]> {
    const known = this.#structures.get(head.sha256);
    if (known !== undefined) return known;
    await this.#view(head, bytes, null, { row0: 1, col0: 1, rows: 1, cols: 1 });
    const sheets = this.#structures.get(head.sha256);
    if (sheets === undefined) throw new EngineFault("the engine did not describe the workbook");
    return sheets;
  }

  /** A window of the head as the engine reads it, or the reason a sheet cannot be read. One read per head, sheet and window at a time. */
  #view(head: RoomHead, bytes: Uint8Array, sheet: number | null, rect: Rect): Promise<View | string> {
    const key = `${head.sha256}|${sheet ?? 0}|${rect.row0}|${rect.col0}|${rect.rows}|${rect.cols}`;
    const cached = this.#views.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    let flight = this.#flights.get(key);
    if (flight === undefined) {
      flight = this.#load(head, bytes, sheet, rect).finally(() => this.#flights.delete(key));
      this.#flights.set(key, flight);
      void flight.then((view) => {
        if (typeof view !== "string") this.#views.set(key, view);
      }, () => undefined);
    }
    return flight;
  }

  #load(head: RoomHead, bytes: Uint8Array, wanted: number | null, rect: Rect): Promise<View | string> {
    return this.#pool.withWorker(async (worker) => {
      const { doc } = await ask(worker, { cmd: "open", bytes: { bin: 0, len: bytes.length }, name: head.name, format: "xlsx" }, [bytes]);
      try {
        let sheets = this.#structures.get(head.sha256);
        if (sheets === undefined) {
          sheets = await this.#structureOf(worker, doc);
          this.#structures.set(head.sha256, sheets);
        }
        const sheet = wanted ?? sheets.find((s) => s.visible)?.id;
        if (sheet === undefined) return "the workbook has no visible worksheet";
        if (!sheets.some((s) => s.id === sheet && s.visible)) return `sheet ${sheet} is not a visible worksheet`;
        const viewport = await ask(worker, { cmd: "sheet_viewport", doc, sheet, ...rect });
        const cells: SeenCell[] = [];
        for (const raw of viewport.cells) {
          const seen = seeCell(raw);
          if (seen !== null && within(rect, seen)) cells.push(seen);
        }
        if (!Array.isArray(viewport.merged) || viewport.merged.some((range) => typeof range !== "string")) throw new EngineFault("the engine described merged ranges that are not text");
        return { sheet, sheets, merged: viewport.merged, cells } satisfies View;
      } finally {
        await this.#close(worker, doc);
      }
    });
  }

  async #structureOf(worker: EngineWorker, doc: number): Promise<SheetInfo[]> {
    const { body, segments } = await askWithSegments(worker, { cmd: "extract", doc, options: { what: ["structure"] } });
    const output = body.outputs?.find((o) => typeof o.path === "string" && o.path.endsWith(".structure.json"));
    const segment = output === undefined ? undefined : segments[output.data.bin];
    if (segment === undefined) throw new EngineFault("the engine did not return the structure of the workbook");
    try {
      return sheetsOfStructure(JSON.parse(new TextDecoder().decode(segment)));
    } catch (e) {
      if (e instanceof SyntaxError) throw new EngineFault("the structure of the workbook is not JSON");
      throw e;
    }
  }

  /** A worker that cannot say it closed the document is not reused. */
  async #close(worker: EngineWorker, doc: number): Promise<void> {
    try {
      const { body } = await worker.call({ cmd: "close", doc });
      if (!body.ok || "error" in body) worker.discard();
    } catch {
      worker.discard();
    }
  }
}
