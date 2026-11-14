/**
 * Playground contracts. Every mode, the shell and the ported helpers code
 * against these types and never against each other's internals.
 *
 * Engine vocabulary (`Op`, `Change`, `Region`, `ViewNode`, ...) is the
 * protocol's, untouched. Everything the playground shows comes from the
 * engine running in this tab: there are no recordings and no recorded claims.
 */
import type {
  Address,
  Change,
  DocFormat,
  KernelClient,
  KernelError,
  Op,
  Region,
  TypedValue,
  ViewNode,
} from "@wolfsdk/protocol";
import type { EngineSource } from "@wolfsdk/runtime/loader";
import type { ComponentType } from "preact";

export type { EngineSource };

export type { Address, Change, DocFormat, KernelClient, KernelError, Op, Region, TypedValue, ViewNode };

// ---------------------------------------------------------------------------
// Identity, environment, assets
// ---------------------------------------------------------------------------

export type ModeId = "review" | "mangle-off" | "xray" | "recalc";
export type RivalId = "openpyxl" | "python-docx" | "python-pptx";

/** Which engine module is in use, as this page loaded it. */
export type EngineIdentity = {
  /** Release version from the engine channel, when the module came from one. */
  version: string | null;
  /** Lowercase hex sha256 of the module as fetched. */
  moduleSha256: string;
  moduleBytes: number;
  /** URL the module was fetched from. */
  url: string;
};

/** The pinned run environment. Same bytes come out only under the same one. */
export type Environment = { clock: string; timezone: string; locale: string; seed: number };

/** A file the page fetches for a helper, addressed by content. `id` is its
 * lowercase hex sha256. `path` is a logical name (`rivals/pyodide/pyodide.asm.wasm`),
 * unique within one list. */
export type AssetRef = { id: string; path: string; bytes: number; type: string };

/** Read-only access to fetched helper assets. Rejects for an id or path the
 * list does not hold, and for bytes whose sha256 is not the listed one. */
export interface LabAssets {
  get(ref: AssetRef | string): Promise<Uint8Array<ArrayBuffer>>;
  /** Every asset this source can serve. */
  list(): readonly AssetRef[];
}

// ---------------------------------------------------------------------------
// Documents and the engine facade
// ---------------------------------------------------------------------------

export type StepStatus = "applied" | "rejected" | "conflict";

export type LabStep = {
  index: number;
  label: string;
  author?: string;
  ops: Op[];
  /** sha256 before and after this step. For a skipped step both equal the
   * bytes it was skipped on. */
  baseSha256: string;
  resultSha256: string;
  changes: Change[];
  partsWritten: string[];
  delta?: PackageDelta;
  status: StepStatus;
  /** Present when `status` is `conflict`. */
  error?: KernelError;
  ms: number;
};

export type LabPage = { page: number; widthPt: number; heightPt: number };

/** An immutable snapshot. Every engine call that changes a document returns
 * a new snapshot with the same `id`. */
export type LabDoc = {
  id: string;
  name: string;
  format: DocFormat;
  /** sha256 of the current bytes. */
  sha256: string;
  /** sha256 of the bytes as opened. */
  baseSha256: string;
  steps: LabStep[];
  pages: LabPage[];
  /** The engine's view. */
  nodes: ViewNode[];
  regions: Region[];
};

export type PageRaster = {
  page: number;
  png: Uint8Array<ArrayBuffer>;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  /** Regions on this page, boxes in points. */
  regions: Region[];
};

export type EngineStatus = {
  /** `idle`: nothing loaded yet; `loading`: fetching or compiling; `ready`. */
  phase: "idle" | "loading" | "ready";
  /** Set while the module is being fetched and compiled. */
  loading: { phase: "resolve" | "transfer" | "compile" } | null;
  /** Why the engine is unavailable, when the last load failed. */
  error: KernelError | null;
};

/**
 * The one engine surface the playground modes use, over the reactor kernel
 * client of `@wolfsdk/runtime/client`.
 *
 * Failures: methods reject with an `Error` whose `cause` is a `KernelError`
 * when the engine refuses or traps. `apply` on a refusal rejects and leaves
 * the document unchanged.
 */
export interface LabEngine {
  /** Identity of the module in use, once loaded. */
  readonly identity: EngineIdentity | null;
  status(): EngineStatus;
  /** Fetch, verify and compile the module. Resolves when ready; idempotent. */
  load(): Promise<void>;
  /** Open a file. Loads the engine first if needed. */
  openFile(bytes: Uint8Array, name: string): Promise<LabDoc>;
  /** Append one step. */
  apply(doc: LabDoc, ops: Op[], label: string, author?: string): Promise<LabDoc>;
  /** PNG of one page of the snapshot at `pxPerPt` (1 = 72 DPI). */
  pageImage(doc: LabDoc, page: number, pxPerPt: number): Promise<PageRaster>;
  /** Content the reader does not see, from engine output only. */
  findings(doc: LabDoc): Promise<Finding[]>;
  /** Stored values against the engine's recalculation, from the engine's
   * damage report. `null` when the document is not a workbook. */
  recalcReport(doc: LabDoc): Promise<RecalcResult | null>;
  /** File bytes of the snapshot. */
  bytes(doc: LabDoc): Promise<Uint8Array<ArrayBuffer>>;
  /** Replay recipe for the snapshot. */
  journal(doc: LabDoc): Journal;
  close(doc: LabDoc): Promise<void>;
  /** Called when `status()` or `identity` changes. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stop the kernel and forget every open document. Later calls reject. */
  dispose(): void;
}

/** Everything needed to reproduce a snapshot outside the browser. */
export type Journal = {
  file: { name: string; format: DocFormat; sha256: string };
  environment: Environment;
  engine: EngineIdentity | null;
  /** Every step in order, including rejected ones (kept for the record). */
  entries: {
    index: number;
    label: string;
    author?: string;
    ops: Op[];
    status: StepStatus;
    baseSha256: string;
    resultSha256: string;
  }[];
  /** sha256 of the snapshot's bytes. */
  resultSha256: string;
};

// ---------------------------------------------------------------------------
// Package verification (independent of the engine)
// ---------------------------------------------------------------------------

export type MemberInfo = {
  name: string;
  /** ZIP compression method (0 stored, 8 deflate). */
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** sha256 of the raw compressed stream. */
  streamSha256: string;
  /** Byte offsets in the archive: local header start and stream start. */
  headerOffset: number;
  dataOffset: number;
};

export type PackageInfo = { bytes: number; sha256: string; members: MemberInfo[] };

/**
 * - `identical-stream`: same method and identical compressed bytes. The only
 *   verdict that proves the member was carried over untouched.
 * - `same-bytes-recompressed`: identical content, different compressed stream.
 * - `xml-equivalent`: content differs only by serialisation.
 * - `changed` / `removed` / `added`.
 */
export type MemberVerdict =
  | "identical-stream"
  | "same-bytes-recompressed"
  | "xml-equivalent"
  | "changed"
  | "removed"
  | "added";

export const MEMBER_VERDICTS: readonly MemberVerdict[] = [
  "identical-stream",
  "same-bytes-recompressed",
  "xml-equivalent",
  "changed",
  "removed",
  "added",
];

export type MemberDelta = { name: string; verdict: MemberVerdict; bytesBefore: number; bytesAfter: number };

export type PackageDelta = {
  before: PackageInfo;
  after: PackageInfo;
  verdicts: MemberDelta[];
  counts: Record<MemberVerdict, number>;
  /** Compressed bytes of `identical-stream` members over the compressed
   * bytes of all members of `before`. 0..1. */
  untouchedByteShare: number;
};

export interface LabVerifier {
  readPackage(bytes: Uint8Array): Promise<PackageInfo>;
  comparePackages(before: Uint8Array, after: Uint8Array): Promise<PackageDelta>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
}

// ---------------------------------------------------------------------------
// Rivals
// ---------------------------------------------------------------------------

export type EditIntent =
  | { kind: "set-cell"; sheet: string; a1: string; value: string | number }
  | { kind: "replace-text"; find: string; replace: string }
  | { kind: "set-shape-text"; slide: number; shape: string; text: string }
  | { kind: "user-script"; python: string };

export type RivalLoss = {
  category: string;
  members: string[];
  /** `data-loss`: a part was dropped. `rewrite`: a part was re-serialised
   * without being dropped. */
  severity: "data-loss" | "rewrite";
};

export type RivalRecord = {
  rival: RivalId;
  version: string;
  intent: EditIntent;
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  outputBytes?: Uint8Array<ArrayBuffer>;
  delta?: PackageDelta;
  losses: RivalLoss[];
  ms: number;
};

export interface LabRivals {
  /** Formats and intents a rival handles. */
  supports(rival: RivalId, format: DocFormat, intent: EditIntent["kind"]): boolean;
  run(rival: RivalId, bytes: Uint8Array, intent: EditIntent): Promise<RivalRecord>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Findings and recalculation
// ---------------------------------------------------------------------------

export type Finding = {
  id: string;
  kind: "hidden" | "tracked" | "comment" | "notes" | "alt-text";
  /** The engine's own reason string (`vanish`, `hidden-row`, ...), or the
   * channel name for comments, notes and alt text. Never invented in JS. */
  reason: string;
  address: Address;
  /** Present only when the engine located it on a rendered page. */
  page?: number;
  bboxPt?: [number, number, number, number];
  text?: string;
  chars?: number;
  /** `container`: the engine flagged an enclosing node that also holds visible
   * children (seen for DOCX `vanish`, which lands on the paragraph), so `text`
   * includes content the reader does see. Absent or `exact`: the flagged node
   * is the hidden content itself. */
  granularity?: "exact" | "container";
  source: "observe";
};

export type RecalcReport = {
  /** Formula cells whose saved cache the engine compared, when it says. */
  formulas: number | null;
  ms: number;
  /** Cells whose stored value differs from the engine's computed value. */
  cells: {
    address: Address;
    sheet: string;
    a1: string;
    formula?: string;
    cached: TypedValue | null;
    computed: TypedValue;
  }[];
};

/** A recalculation result. `unavailable` carries the engine's reason when it
 * did not check this workbook (an engine build without the call, or a
 * recalculation the engine reported as not run). */
export type RecalcResult =
  | { kind: "report"; report: RecalcReport }
  | { kind: "unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Presentation contracts (components and helpers injected into modes)
// ---------------------------------------------------------------------------

export type AnatomyMapProps = {
  info: PackageInfo;
  delta?: PackageDelta;
  highlight?: string[];
  onSelect?: (member: string) => void;
  /** Accessible name. */
  label: string;
};
export type ByteRibbonProps = { info: PackageInfo; delta?: PackageDelta; label: string };
export type LegendProps = { verdicts?: readonly MemberVerdict[] };
export interface Geiger {
  tick(changedBytes: number): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  dispose(): void;
}
export type CodeDrawerProps = { journal: Journal };

/** Everything a mode may use besides the engine. Wired once in
 * `src/main.tsx`; tests pass fakes. */
export type ModeDeps = {
  verifier: LabVerifier;
  rivals: LabRivals;
  AnatomyMap: ComponentType<AnatomyMapProps>;
  ByteRibbon: ComponentType<ByteRibbonProps>;
  Legend: ComponentType<LegendProps>;
  CodeDrawer: ComponentType<CodeDrawerProps>;
  geiger: Geiger;
  wolfOpsFor: (intent: EditIntent, doc: LabDoc) => Op[];
};

export type LabEvent =
  | { type: "journal-changed"; doc: LabDoc }
  | { type: "toast"; tone: "info" | "error"; message: string };

export interface LabBus {
  emit(event: LabEvent): void;
  on(listener: (event: LabEvent) => void): () => void;
}

/** A file the visitor picked, as read from disk. */
export type PickedFile = { name: string; bytes: Uint8Array<ArrayBuffer> };

/** What the shell hands a mode that works on its engine snapshot. */
export type ModeProps = {
  engine: LabEngine;
  /** The picked file as read from disk. */
  file: PickedFile;
  /** The engine snapshot of `file`. */
  doc: LabDoc;
  /** Report a new snapshot (after apply) to the shell. */
  onDoc: (doc: LabDoc) => void;
  deps: ModeDeps;
  bus: LabBus;
};

/** What the shell hands a mode that mounts its own engine (the review
 * element): the picked file, if any, and the engine the visitor chose. */
export type SurfaceProps = {
  file: PickedFile | null;
  engine: EngineSource;
};

type ModeBase = {
  id: ModeId;
  title: string;
  /** One line under the title. No numbers. */
  summary: string;
  formats: DocFormat[];
};

export type LabMode =
  | (ModeBase & { kind: "doc"; Stage: ComponentType<ModeProps>; Rail?: ComponentType<ModeProps> })
  | (ModeBase & { kind: "surface"; Stage: ComponentType<SurfaceProps> });
