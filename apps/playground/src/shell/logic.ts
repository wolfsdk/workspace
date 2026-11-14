/**
 * Pure shell logic: mode availability, drop validation, the engine chip and
 * the shell state reducer. No DOM, no engine.
 */
import type {
  DocFormat,
  EngineSource,
  EngineStatus,
  KernelError,
  LabDoc,
  LabMode,
  LabStep,
  ModeId,
  PickedFile,
} from "../lab/index.ts";
// The anatomy views' byte formatter (1024 divisor, KB and MB labels), so one file never shows two sizes.
import { formatBytes } from "../anatomy/index.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function isKernelError(value: unknown): value is KernelError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

/** The structured `KernelError` behind a rejection. Engine refusals carry it
 * as `Error.cause`; anything else becomes `internal` with its message. */
export function kernelErrorOf(error: unknown, fallbackCode = "internal"): KernelError {
  if (error instanceof Error && isKernelError(error.cause)) return error.cause;
  if (isKernelError(error)) return error;
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// Mode availability
// ---------------------------------------------------------------------------

export type ModeContext = {
  /** Format of the picked file; `null` before anything is picked. */
  format: DocFormat | null;
};

export type Availability = { available: true } | { available: false; reason: string };

const listFormats = (formats: readonly string[]): string =>
  formats.length <= 1 ? (formats[0] ?? "") : `${formats.slice(0, -1).join(", ")} and ${formats.at(-1)}`;

/**
 * Whether `mode` can run on what is picked, with a one-line reason when not.
 * A mode that mounts its own surface runs with or without a file; a mode that
 * works on the engine snapshot needs a file of one of its formats.
 */
export function modeAvailability(mode: LabMode, ctx: ModeContext): Availability {
  if (ctx.format === null) {
    return mode.kind === "surface" ? { available: true } : { available: false, reason: "Drop a file first." };
  }
  if (mode.formats.length > 0 && !mode.formats.includes(ctx.format)) {
    return {
      available: false,
      reason: `${mode.title} works on ${listFormats(mode.formats)} files, not ${ctx.format}.`,
    };
  }
  return { available: true };
}

/** First available mode among `preferred`, then in `modes` order. */
export function pickMode(modes: LabMode[], ctx: ModeContext, preferred: (ModeId | null | undefined)[] = []): ModeId | null {
  const ok = (id: ModeId | null | undefined) => {
    const mode = modes.find((m) => m.id === id);
    return mode !== undefined && modeAvailability(mode, ctx).available;
  };
  for (const id of preferred) if (ok(id)) return id!;
  return modes.find((m) => modeAvailability(m, ctx).available)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Drop validation
// ---------------------------------------------------------------------------

/** Largest visitor file the playground opens: the whole file is held in the tab. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = [".docx", ".xlsx", ".pptx"] as const;

export type DropCheck =
  | { ok: true; format: DocFormat }
  | { ok: false; code: "no-file" | "several-files" | "unsupported-type" | "empty" | "too-large"; message: string };

/** Check a dropped or chosen file before reading it. */
export function validateDrop(files: { name: string; size: number }[], limit = MAX_FILE_BYTES): DropCheck {
  if (files.length === 0) return { ok: false, code: "no-file", message: "No file arrived. Drop a file or choose one." };
  if (files.length > 1) {
    return {
      ok: false,
      code: "several-files",
      message: "Drop one file at a time. The playground inspects a single document.",
    };
  }
  const { name, size } = files[0]!;
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return {
      ok: false,
      code: "unsupported-type",
      message: `The playground opens .docx, .xlsx and .pptx files. "${name}" is not one of them. Choose a Word, Excel or PowerPoint file.`,
    };
  }
  if (size === 0) return { ok: false, code: "empty", message: `"${name}" is empty. Choose a file that has content.` };
  if (size > limit) {
    return {
      ok: false,
      code: "too-large",
      message: `"${name}" is ${formatBytes(size)}. The playground opens files up to ${formatBytes(limit)}. Save a smaller copy of the document and drop that instead.`,
    };
  }
  return { ok: true, format: extension.slice(1) as DocFormat };
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const stepName = (s: LabStep) => `Step ${s.index + 1} "${s.label}"`;

/** Screen-reader text for a snapshot change, or `null` when nothing a visitor
 * would notice changed. */
export function describeDocChange(prev: LabDoc | null, next: LabDoc): string | null {
  const sha = `Snapshot sha256 starts ${next.sha256.slice(0, 12)}.`;
  if (!prev || prev.id !== next.id) {
    const steps = next.steps.length === 1 ? "1 step" : `${next.steps.length} steps`;
    return `Opened ${next.name}, ${steps}. ${sha}`;
  }
  if (prev.sha256 === next.sha256 && prev.steps.length === next.steps.length) {
    const same = prev.steps.every((s, i) => s.status === next.steps[i]!.status);
    if (same) return null;
  }
  const parts: string[] = [];
  for (const step of next.steps) {
    const before = prev.steps[step.index];
    if (!before) {
      parts.push(
        step.status === "conflict"
          ? `${stepName(step)} could not be applied: ${step.error?.code ?? "conflict"}.`
          : `${stepName(step)} ${step.status}.`,
      );
      continue;
    }
    if (before.status === step.status) continue;
    if (step.status === "conflict") parts.push(`${stepName(step)} no longer applies: ${step.error?.code ?? "conflict"}.`);
    else if (step.status === "rejected") parts.push(`${stepName(step)} rejected.`);
    else parts.push(`${stepName(step)} restored.`);
  }
  parts.push(sha);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** One entry of the engine field. */
export type EngineChoice = { id: string; label: string; source: EngineSource };

export type EngineChip = {
  label: "Not loaded" | "Loading" | "Ready" | "Unavailable";
  loading: boolean;
  detail: string;
};

const LOADING_DETAIL: Record<NonNullable<EngineStatus["loading"]>["phase"], string> = {
  resolve: "Resolving the engine release",
  transfer: "Downloading and checking the engine module",
  compile: "Compiling the engine module",
};

export function engineChip(status: EngineStatus): EngineChip {
  if (status.loading) return { label: "Loading", loading: true, detail: LOADING_DETAIL[status.loading.phase] };
  if (status.phase === "ready") return { label: "Ready", loading: false, detail: "Engine module loaded" };
  if (status.error) {
    return { label: "Unavailable", loading: false, detail: `The engine did not load: ${status.error.code}` };
  }
  return { label: "Not loaded", loading: false, detail: "The engine loads when a mode needs it" };
}

/** A short line naming where an engine source comes from. */
export function describeSource(source: EngineSource): string {
  if (source.url !== undefined) return `Module ${String(source.url)}`;
  const channel = source.channel ?? "the release channel";
  return source.version ? `Version ${source.version} from ${channel}` : `Latest release from ${channel}`;
}

// ---------------------------------------------------------------------------
// Shell state
// ---------------------------------------------------------------------------

export type OwnFile = { name: string; size: number; format: DocFormat; sha256: string | null };

export type Toast = { id: number; tone: "info" | "error"; message: string };

export type ShellState = {
  engine: EngineStatus;
  /** Where the engine module comes from, for the playground's engine and the
   * review element alike. */
  source: EngineSource;
  /** `opening`: the engine is opening `picked` for a mode that needs a snapshot. */
  phase: "idle" | "reading" | "opening" | "ready" | "failed";
  /** Bumped by every pick; results for an older pick are dropped. */
  seq: number;
  file: OwnFile | null;
  /** The picked file's bytes, once read. */
  picked: PickedFile | null;
  /** The engine snapshot of `picked`, opened on the first mode that needs it. */
  doc: LabDoc | null;
  modeId: ModeId | null;
  error: KernelError | null;
  dropError: string | null;
  announcement: { n: number; text: string };
  toasts: Toast[];
  nextToast: number;
};

export type ShellAction =
  | { type: "engine"; status: EngineStatus }
  | { type: "source"; source: EngineSource; status: EngineStatus }
  | { type: "pick"; seq: number; file: OwnFile }
  | { type: "picked"; seq: number; picked: PickedFile; sha256: string; modeId: ModeId | null }
  | { type: "open-start"; seq: number }
  | { type: "opened"; seq: number; doc: LabDoc }
  | { type: "open-failed"; seq: number; error: KernelError }
  | { type: "doc"; doc: LabDoc }
  | { type: "mode"; modeId: ModeId }
  | { type: "drop-rejected"; message: string }
  | { type: "toast"; tone: "info" | "error"; message: string }
  | { type: "toast-dismiss"; id: number }
  | { type: "announce"; text: string };

export function initialShellState(engine: EngineStatus, source: EngineSource, modeId: ModeId | null): ShellState {
  return {
    engine,
    source,
    phase: "idle",
    seq: 0,
    file: null,
    picked: null,
    doc: null,
    modeId,
    error: null,
    dropError: null,
    announcement: { n: 0, text: "" },
    toasts: [],
    nextToast: 1,
  };
}

const announce = (state: ShellState, text: string | null): ShellState["announcement"] =>
  text ? { n: state.announcement.n + 1, text } : state.announcement;

export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "engine": {
      const { status } = action;
      let text: string | null = null;
      if (status.phase === "ready" && state.engine.phase !== "ready") text = "The engine is ready.";
      else if (status.error && status.error !== state.engine.error) {
        text = `The engine did not load: ${status.error.code}. ${status.error.message}`;
      }
      return { ...state, engine: status, announcement: announce(state, text) };
    }
    case "source":
      // A new engine forgets every snapshot of the old one; the picked file stays.
      return {
        ...state,
        source: action.source,
        engine: action.status,
        phase: state.phase === "reading" ? "reading" : "idle",
        doc: null,
        error: null,
        announcement: announce(state, `Engine changed. ${describeSource(action.source)}.`),
      };
    case "pick":
      return {
        ...state,
        phase: "reading",
        seq: action.seq,
        file: action.file,
        picked: null,
        doc: null,
        error: null,
        dropError: null,
      };
    case "picked":
      if (action.seq !== state.seq || !state.file) return state;
      return {
        ...state,
        phase: "idle",
        file: { ...state.file, sha256: action.sha256 },
        picked: action.picked,
        modeId: action.modeId,
      };
    case "open-start":
      if (action.seq !== state.seq) return state;
      return { ...state, phase: "opening", error: null };
    case "opened":
      if (action.seq !== state.seq) return state;
      return {
        ...state,
        phase: "ready",
        doc: action.doc,
        error: null,
        announcement: announce(state, describeDocChange(state.doc, action.doc)),
      };
    case "open-failed":
      if (action.seq !== state.seq) return state;
      return {
        ...state,
        phase: "failed",
        error: action.error,
        announcement: announce(state, `Could not open: ${action.error.code}. ${action.error.message}`),
      };
    case "doc":
      // A snapshot of a document that is no longer open is stale.
      if (!state.doc || action.doc.id !== state.doc.id || action.doc === state.doc) return state;
      return { ...state, doc: action.doc, announcement: announce(state, describeDocChange(state.doc, action.doc)) };
    case "mode":
      return state.modeId === action.modeId ? state : { ...state, modeId: action.modeId };
    case "drop-rejected":
      return { ...state, dropError: action.message, announcement: announce(state, action.message) };
    case "toast":
      return {
        ...state,
        toasts: [...state.toasts, { id: state.nextToast, tone: action.tone, message: action.message }],
        nextToast: state.nextToast + 1,
        announcement: announce(state, action.message),
      };
    case "toast-dismiss":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "announce":
      return { ...state, announcement: announce(state, action.text) };
  }
}
