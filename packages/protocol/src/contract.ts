/**
 * Wolf Review kernel contract (frozen).
 *
 * This file is the whole interface between editor UIs and the `wolf` Office
 * engine running as WebAssembly. A UI never talks to the engine directly: it
 * holds a `KernelClient`, opens a document, reads `DocState`, and turns every
 * user action into engine operations (`Op[]`) passed to `apply`.
 *
 * Ground rules
 * - Engine data passes through untouched. Operations go to `wolf transact`
 *   verbatim; view nodes, regions, diff changes and errors are exactly the
 *   JSON the engine wrote (field names are the engine's snake_case).
 *   Engine reference: wolfsuite `docs/agent-api.md` (agent-api.v1).
 * - Every value here is structured-cloneable, so the same shapes cross a
 *   Web Worker boundary. Byte payloads are `Uint8Array`.
 * - A document is a linear chain of revisions. Revision 0 is the opened
 *   file; each successful `apply` adds one revision. `undo`/`redo`/`goto`
 *   move a cursor along the chain without running the engine. `apply` while
 *   the cursor is not at the end drops the revisions after the cursor.
 * - Calls on one kernel are serialised: a call issued while another is
 *   running waits its turn; calls never interleave.
 * - Determinism: every engine run uses a fixed clock and seed
 *   (default `2026-01-01T00:00:00Z`, seed 0) so a saved file is byte-for-byte
 *   reproducible with native `wolf transact` replaying `session()`.
 *
 * This file is dependency-free. The one runtime export is
 * `KernelRequestError`, the error type rejected promises carry.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Opaque handle for an open document, unique within one kernel. */
export type DocId = string;

/** Formats the engine edits. Detected from the engine's receipt (content
 * sniffing), never from the file name. */
export type DocFormat = "docx" | "pptx" | "xlsx";

/**
 * Canonical semantic address of a node, for example `para:~2a9256c0`,
 * `slide:#256/shape:#2`, `sheet:#1/cell:B2`. Grammar: agent-api.md section 3.
 * DOCX paragraph addresses are content-derived and change when the text
 * changes; follow `ApplyResult.transaction.address_map` to keep a selection.
 */
export type Address = string;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/**
 * One kernel instance. Implementations: the Web Worker client
 * (`@wolfsdk/runtime/client`, `createReactorKernelClient`) and the
 * in-process Node/bun kernel (`@wolfsdk/runtime/node`,
 * `createNodeReactorKernel`); both behave identically.
 *
 * Failures: `apply` resolves `{ ok: false, error }` for an engine refusal or
 * a trap. Every other method rejects with a `KernelRequestError` whose
 * `.error` is a `KernelError` (engine refusal, trap, unknown doc, revision out
 * of range, unknown page). Promises never reject with anything else.
 */
export interface KernelClient {
  /** Observe the file with a PNG render of every page and store it as
   * revision 0. `name` is only used to name the file inside the engine's
   * sandbox (and in `SessionLog`); the format comes from the engine.
   * The worker client copies `bytes`, so the caller keeps its buffer. */
  open(bytes: Uint8Array, name: string): Promise<DocState>;

  /** Run `transact` on the current revision (bound by its sha256), observe
   * the result, and diff it against the current revision. On success the
   * result becomes the new current revision (redo tail dropped). On refusal
   * nothing changes. `at` runs this batch with the given clock and zone
   * instead of the kernel's own: pass a `SessionLog` batch's `clock` /
   * `timezone` to replay it into another document with the same bytes. */
  apply(doc: DocId, ops: Op[], at?: BatchEnvironment): Promise<ApplyResult>;

  /** Move the cursor one revision back / forward. No engine run. At either
   * end of the chain this is a no-op that returns the current state. */
  undo(doc: DocId): Promise<DocState>;
  redo(doc: DocId): Promise<DocState>;

  /** Move the cursor to `revision` (0 .. revisionCount - 1). No engine run.
   * Out of range rejects with code `revision-out-of-range`. */
  goto(doc: DocId, revision: number): Promise<DocState>;

  /** One page of the current revision as PNG at `scale`.
   * `scale` is pixels per point: 1 = 72 DPI, 2 = 144 DPI. The engine takes
   * an integer `--dpi`, so the effective scale is `round(72 * scale) / 72`
   * (see `PageImage.dpi` / `PageImage.scale`). A scale matching the render
   * done by `open`/`apply` (`PageInfo.dpi`) is served from cache; any other
   * scale re-renders that one page. Today this is a PNG; a display list is
   * planned behind the same call. */
  page(doc: DocId, page: number, scale: number): Promise<PageImage>;

  /** The current revision's file bytes (exactly what `wolf transact` wrote). */
  save(doc: DocId): Promise<Uint8Array<ArrayBuffer>>;

  /** Everything needed to reproduce the current revision natively: the
   * original file's sha256 plus the op batches from revision 0 to the
   * current revision, in order. */
  session(doc: DocId): Promise<SessionLog>;

  /** Run one read-only engine verb against the current revision and return
   * its receipt and output files. For data `DocState` does not carry: a
   * ranged view of a large sheet (`observe` with `--target
   * sheet:#1/range:A1:K50`), display strings or structure (`extract --what
   * text|structure`). The kernel supplies the file path, `--outdir`,
   * `--clock` and `--seed`; `args` holds the remaining flags. Never changes
   * the revision store. Rejects with `KernelRequestError` (`usage` for a
   * verb outside the allowed set, or the engine's own refusal).
   *
   * `extract` is optional in the reactor module: a build without it rejects
   * with `unsupported`. Display strings, merges, styles and geometry are
   * always available from `sheetViewport` (`isReactorKernel`,
   * `@wolfsdk/protocol`). */
  query(doc: DocId, request: QueryRequest): Promise<QueryResult>;

  /** Run the engine's two-file diff (`wolf diff before after`) and return its
   * changes, the list `ApplyResult.diff` carries for one batch. The files
   * need not be open documents; nothing is stored and no revision is
   * created. Runs with the kernel's own clock and zone. The worker clients
   * copy both arrays, so the caller keeps its buffers.
   *
   * An empty list means the engine's diff reports no change. It is not proof
   * of equal content: the diff does not report every kind of change
   * (`docs/transaction-diff-vs-diff.md`). Rejects with `KernelRequestError`
   * when the engine refuses, for example two files of different formats. */
  diff(before: Uint8Array, after: Uint8Array): Promise<DiffResult>;

  /** Forget the document and all its revisions. */
  close(doc: DocId): Promise<void>;
}

export type QueryRequest = {
  verb: "observe" | "extract";
  /** Extra CLI flags, e.g. `["--target", "sheet:#1/range:A1:K50"]`. */
  args: string[];
};

export type QueryResult = {
  /** The engine's JSON receipt, untouched. */
  receipt: Record<string, unknown>;
  /** Files the run wrote to its outdir (view JSON, text, PNG), by base name. */
  files: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
  timings: Timings;
};

export type DiffResult = {
  /** The diff receipt's `diff.changes[]`, untouched. */
  changes: Change[];
  timings: Timings;
};

// ---------------------------------------------------------------------------
// Document state
// ---------------------------------------------------------------------------

/** Snapshot of one revision plus the cursor bookkeeping around it. */
export type DocState = {
  doc: DocId;
  /** Sandbox file name derived from `open(…, name)` (ASCII-safe). */
  name: string;
  format: DocFormat;
  /** Index of the current revision: 0 = as opened. */
  revision: number;
  /** Length of the revision chain (current revision + undo + redo stack). */
  revisionCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Lowercase hex sha256 of this revision's file bytes. */
  sha256: string;
  /** The engine's view (`<stem>.view.json` `nodes`), flat, document order,
   * untouched. */
  nodes: ViewNode[];
  /** Child addresses per node address, in document order, derived from the
   * nodes' `parent` links (the engine's own `children` member is a count).
   * Top-level nodes are under the key `""`. */
  childIds: Record<Address, Address[]>;
  /** Every top-level member of the engine's view other than `nodes` and
   * `truncated`, untouched: always `contract`, `format` and `source_sha256`;
   * for XLSX on newer engines also `workbook` (style table) and `sheets`
   * (grid metadata). A UI tests for the member it needs and ignores the rest. */
  viewMeta: Record<string, unknown>;
  /** Pages the render produced, ascending. May be empty (an XLSX workbook
   * whose sheets print nothing) or skip pages; never assume 1..n. */
  pages: PageInfo[];
  /** Drawn boxes bound to view nodes, at the render resolution in `pages`.
   * One node may have several regions (paragraph split across pages,
   * repeated print titles). */
  regions: Region[];
  /** Node addresses on rendered pages that produced no region (text inside
   * PPTX shapes, sections, …). `observation.unrendered`, untouched. */
  unrendered: Address[];
  /** The view was cut by the engine's node limit. */
  truncated: boolean;
  /** Engine warnings from the observe that produced this revision. */
  warnings: KernelWarning[];
  /** Cost of the call that returned this state (undo/redo/goto: no engine
   * runs, so only `totalMs`). */
  timings: Timings;
};

/**
 * One node of the engine's view, exactly as `observe` wrote it.
 * Known members are typed; any member a newer engine adds is still present
 * (index signature). There is no separate "raw" object: this is the raw node.
 */
export type ViewNode = {
  /** Canonical address. Equals `Region.object_id` for drawn nodes. */
  id: Address;
  /** Node kind, e.g. docx `section | paragraph | run | header | footer |
   * table | row | cell | comment | reply | revision | image | hyperlink`,
   * pptx `slide | shape | paragraph | run | chart | series | point | col |
   * row | cell`, xlsx `sheet | cell | table | …`. Open set. */
  kind: string;
  /** Address of the parent node, `null` at top level. */
  parent: Address | null;
  /** Hidden content is labelled, not dropped. */
  visible: boolean;
  /** Why `visible` is false: `hidden-sheet`, `very-hidden-sheet`,
   * `hidden-row`, `hidden-column`, `hidden-slide`, `off-canvas`, `vanish`,
   * `tracked-deletion`, `zero-size`, `same-color-text`, `outside-render`. */
  hidden_reason?: string;
  /** Number of child nodes (a count, not ids; see `DocState.childIds`). */
  children?: number;
  /** Human label: sheet name, shape name, header/footer kind, … */
  label?: string;
  /** Plain text. Long text is cut by the engine and ends in U+2026. */
  text?: string;
  /** Typed value (XLSX cells, PPTX table cells / chart points). */
  value?: TypedValue;
  /** XLSX formula, with leading `=`. */
  formula?: string;
  /** XLSX cell reference such as `B2`. */
  a1?: string;
  /** XLSX cell hyperlink (`<hyperlink>` on the sheet, not a `=HYPERLINK()`
   * formula). `url` is an external target, `location` an in-workbook one
   * such as `Data!A1`. Absent on engine builds that do not report links. */
  hyperlink?: { url?: string; location?: string; tooltip?: string };
  /** Content channel: `body`, `comments`, `tracked-deletions`, … */
  channel?: string;
  /** DOCX list items: zero-based numbering level. */
  list_level?: number;
  /** DOCX comment / reply / revision nodes. */
  author?: string;
  initials?: string;
  date?: string;
  anchor?: Address;
  revision_kind?: "ins" | "del";
  /** DOCX image and hyperlink nodes. */
  extent?: { cx_emu: number; cy_emu: number };
  media_type?: string;
  relationship?: string;
  alt_text?: string;
  url?: string;
  bookmark?: string;
  tooltip?: string;
  [member: string]: unknown;
};

/** A typed value with exactly one member (agent-api.md section 5.1). */
export type TypedValue =
  | { number: number }
  | { string: string }
  | { boolean: boolean }
  | { formula: string }
  | { text: string }
  | { instruction: string }
  | { empty: true };

/** One rendered page of the current revision. */
export type PageInfo = {
  /** 1-based page (DOCX page, PPTX slide position, XLSX printed page). */
  page: number;
  /** Raster size of the cached PNG. */
  widthPx: number;
  heightPx: number;
  /** Page size in points (`widthPx * 72 / dpi`). */
  widthPt: number;
  heightPt: number;
  /** Resolution of the cached PNG (engine default 150). Region `bbox_px`
   * values in `DocState.regions` are at this resolution. */
  dpi: number;
};

/** A drawn object bound to a view node (`observation.regions[]`).
 * Boxes are `[x, y, width, height]` from the page's top-left corner. */
export type Region = {
  /** Address of the view node that was drawn. */
  object_id: Address;
  page: number;
  /** Pixels at the render resolution (`PageInfo.dpi` or `PageImage.dpi`). */
  bbox_px: [number, number, number, number];
  /** Points, resolution independent: multiply by `scale` to place an
   * overlay on a `PageImage`. */
  bbox_pt: [number, number, number, number];
  /** The box was clipped to the page. */
  clipped?: boolean;
  [member: string]: unknown;
};

/** PNG of one page. */
export type PageImage = {
  page: number;
  /** Exact-size, caller-owned buffer (usable directly in a `Blob`). */
  png: Uint8Array<ArrayBuffer>;
  widthPx: number;
  heightPx: number;
  /** Effective resolution the engine rendered at. */
  dpi: number;
  /** Effective pixels per point (`dpi / 72`); may differ slightly from the
   * requested scale because `dpi` is an integer. */
  scale: number;
  /** The scale passed to `page()`. */
  requestedScale: number;
  /** `cache`: the render from `open`/`apply`; `render`: a fresh engine run. */
  source: "cache" | "render";
  /** Regions on this page with `bbox_px` at this image's `dpi`. */
  regions: Region[];
  timings: Timings;
};

// ---------------------------------------------------------------------------
// Operations (input to `apply`), passed to `wolf transact` untouched
// ---------------------------------------------------------------------------

/**
 * One engine operation (agent-api.md section 5.1). Common shapes are typed
 * for autocompletion; `OpenOp` admits every other operation and member
 * (`format`, `review`, `sort`, chart edits, …). The kernel never inspects or
 * rewrites an op: the engine validates it and refuses with a typed error.
 * A batch (`Op[]`) is atomic: all apply or none.
 */
export type Op = SetOp | ReplaceTextOp | InsertOp | DeleteOp | MoveOp | OpenOp;

/** Replace a value, formula, text, or field instruction; formatting kept.
 * `values` writes an XLSX block (rows of typed values). */
export type SetOp = {
  op: "set";
  target: Address;
  value?: TypedValue;
  values?: TypedValue[][];
  /** DOCX: record as a tracked revision. */
  track?: boolean;
  [member: string]: unknown;
};

export type ReplaceTextOp = {
  op: "replace-text";
  target: Address;
  find: string;
  replace: string;
  occurrence?: number | "all" | string;
  track?: boolean;
  [member: string]: unknown;
};

/** Insert a node (`row`, `sheet`, `paragraph`, `slide`, `shape`, `table`,
 * `col`, `chart`, `comment`, `image`, `hyperlink`, …). The created address
 * is reported in `TransactionSummary.ops[i].created`. */
export type InsertOp = {
  op: "insert";
  anchor: Address;
  position: "before" | "after" | "first-child" | "last-child" | string;
  node: { kind: string; [member: string]: unknown };
  track?: boolean;
  [member: string]: unknown;
};

export type DeleteOp = {
  op: "delete";
  target: Address;
  track?: boolean;
  [member: string]: unknown;
};

export type MoveOp = {
  op: "move";
  target: Address;
  anchor: Address;
  position: "before" | "after" | string;
  [member: string]: unknown;
};

/** Any other engine operation, passed through as is. */
export type OpenOp = { op: string; [member: string]: unknown };

// ---------------------------------------------------------------------------
// Apply result, diff and transaction summary
// ---------------------------------------------------------------------------

export type ApplyResult =
  | {
      ok: true;
      /** The new current revision. */
      state: DocState;
      /** `wolf diff` of the previous revision against the new one. It compares
       * files, so it can be empty for a real change (a sheet move) and it merges
       * paragraph and span formatting; to decide what to redraw compare
       * `state.sha256`, and to describe a batch read `transaction.diff` first
       * (measured on 63 batches: `docs/transaction-diff-vs-diff.md`). */
      diff: Change[];
      /** The transact receipt's `transaction` member (address map, resolved
       * ops, parts written, and the diff of this batch with a `cause` op index
       * on each record, which the review panel reads). */
      transaction: TransactionSummary;
      /** Pages of the new revision whose rendering differs from the previous
       * revision's, when the kernel knows (the reactor compares page hashes).
       * `null` when it does not: treat every page as changed. */
      pageChanges: PageChanges | null;
    }
  | {
      ok: false;
      /** First error of the refusal (engine receipt `errors[0]`, or a kernel
       * trap code). */
      error: KernelError;
      /** All errors of the refusal, in receipt order. */
      errors: KernelError[];
      timings: Timings;
    };

export type PageChanges = {
  /** Page count of the new revision. */
  count: number;
  /** 1-based pages whose content hash changed (or that are new). */
  changed: number[];
  /** 1-based pages of the previous revision that no longer exist. */
  removed: number[];
};

/** One semantic change (`$defs/diffSummary` `changes[]`), untouched. */
export type Change = {
  /** Canonical address in the result revision (base revision for
   * `removed`). */
  address: Address;
  change: "added" | "removed" | "modified" | "moved";
  kind: string;
  /** Package parts touched, e.g. `word/document.xml`. */
  parts: string[];
  /** `modified`: the property (`text`, `value`, `formula`, `format.*`, …)
   * with typed `before` / `after`. */
  property?: string;
  before?: TypedValue | unknown;
  after?: TypedValue | unknown;
  /** `moved`: base-revision address. */
  from?: Address;
  /** Index of the op that caused it (transaction diff only; dependent
   * changes such as recalculated formulas have none). */
  cause?: number;
  [member: string]: unknown;
};

/** The transact receipt's `transaction` member, untouched. */
export type TransactionSummary = {
  base_sha256: string;
  result_sha256: string;
  committed: boolean;
  /** Old address -> new canonical address for every node whose address
   * changed (DOCX paragraphs re-hash when their text changes). */
  address_map: { before: Address; after: Address }[];
  /** Per op: its index, kind, resolved target and, for inserts, `created`. */
  ops: { index: number; op: string; resolved?: Address; created?: Address; [member: string]: unknown }[];
  diff: { changes: Change[]; counts: Record<string, number>; identity: string };
  [member: string]: unknown;
};

// ---------------------------------------------------------------------------
// Session log (native replay)
// ---------------------------------------------------------------------------

/**
 * Replay recipe for the current revision. Natively:
 *   for each batch i: wolf transact <file_i> --sha256 <batch.baseSha256>
 *     --ops <batch.ops as JSON file> --outdir <dir> --clock <clock> --seed <seed>
 * where file_0 is the original and file_{i+1} is batch i's output. The final
 * output's sha256 equals `DocState.sha256` / `batches.at(-1).resultSha256`.
 */
export type SessionLog = {
  name: string;
  format: DocFormat;
  /** sha256 of the bytes passed to `open`. */
  originalSha256: string;
  /** Current revision (= batches.length). */
  revision: number;
  /** Run environment every batch used unless the batch overrides it. The
   * engine pins the rest itself for this surface: no system fonts, no font
   * directories (built-in faces only). Receipts echo all of it under
   * `determinism`. */
  clock: string;
  /** IANA zone passed as `--timezone` with the clock. */
  timezone: string;
  /** BCP 47 tag passed as `--locale`. */
  locale: string;
  seed: number;
  /** `clock` / `timezone` are present on a batch that ran with a different
   * clock than the session's (live-clock kernels stamp every batch with the
   * time it was applied, so `TODAY()` is right for the user and native replay
   * still reproduces the bytes). */
  batches: { ops: Op[]; baseSha256: string; resultSha256: string; clock?: string; timezone?: string }[];
};

/** Clock and zone of one apply (a `SessionLog` batch's `clock` / `timezone`). */
export type BatchEnvironment = { clock?: string; timezone?: string };

// ---------------------------------------------------------------------------
// Errors, warnings, timings
// ---------------------------------------------------------------------------

/**
 * A refusal. Engine refusals are the receipt's `errors[]` entries passed
 * through unchanged (`address-unresolved`, `op-kind-mismatch`, `usage`,
 * `invariant-violated`, …; see agent-api.md section 7). Kernel codes:
 * - `wasm-memory-limit`  the engine ran out of linear memory (128 MiB cap)
 * - `wasm-trap`          any other WebAssembly trap (panic, stack overflow)
 * - `wasm-compile-failed` the module could not be fetched or compiled
 * - `engine-no-receipt`  the engine exited without a parseable receipt
 * - `engine-output-missing` the receipt names an output the sandbox lacks
 * - `doc-unknown`, `revision-out-of-range`, `page-unknown`
 * - `kernel-closed`      the worker was terminated or crashed
 */
export type KernelError = {
  code: string;
  message: string;
  /** The offending argument (address, flag, …) when the engine names one. */
  argument?: string;
  [member: string]: unknown;
};

/** Receipt `warnings[]`, untouched (for example `view-truncated`). */
export type KernelWarning = { code: string; message: string; [member: string]: unknown };

/** Wall-clock milliseconds measured by the kernel around one client call. */
export type Timings = {
  /** Time spent compiling the module during this call: non-zero only for the
   * first call after the kernel was created. */
  compileMs: number;
  /** Sum of engine runs per verb within this call (absent when not run). */
  observeMs?: number;
  transactMs?: number;
  diffMs?: number;
  /** Page re-render (`page()` at a non-cached scale). */
  renderMs?: number;
  /** Whole call inside the kernel, including (de)serialisation of files. */
  totalMs: number;
  /** Every engine invocation in this call, in order. */
  runs: EngineRun[];
};

export type EngineRun = {
  verb: string;
  ms: number;
  exitCode: number | null;
  /** Linear memory size when the run ended. */
  memoryBytes: number;
};

/** Rejection type of every `KernelClient` method except `apply`. */
export class KernelRequestError extends Error {
  readonly error: KernelError;
  constructor(error: KernelError) {
    super(`${error.code}: ${error.message}`);
    this.name = "KernelRequestError";
    this.error = error;
  }
}
