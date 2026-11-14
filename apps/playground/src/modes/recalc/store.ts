/**
 * The Recalculate result, shared by the stage (which starts it) and the rail
 * (which lists it). One entry per document id; a new snapshot of that
 * document starts again from `idle`.
 */
import type { LabDoc, LabEngine, RecalcReport } from "../../lab/index.ts";
import { useEffect, useState } from "preact/hooks";

export type RecalcRun =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; report: RecalcReport }
  /** The engine did not check this workbook; `reason` is its own account. */
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; code: string; message: string };

export interface RecalcStore {
  get(doc: LabDoc): RecalcRun;
  /** Ask the engine for the report. A second call while one runs joins it. */
  run(engine: LabEngine, doc: LabDoc): Promise<RecalcRun>;
  subscribe(listener: () => void): () => void;
}

const IDLE: RecalcRun = { phase: "idle" };

export function createRecalcStore(): RecalcStore {
  const entries = new Map<string, { sha256: string; run: RecalcRun; pending?: Promise<RecalcRun> }>();
  const listeners = new Set<() => void>();

  const set = (doc: LabDoc, run: RecalcRun, pending?: Promise<RecalcRun>) => {
    entries.set(doc.id, { sha256: doc.sha256, run, pending });
    for (const listener of [...listeners]) listener();
  };
  const current = (doc: LabDoc) => {
    const entry = entries.get(doc.id);
    return entry?.sha256 === doc.sha256 ? entry : undefined;
  };

  return {
    get: (doc) => current(doc)?.run ?? IDLE,
    run(engine, doc) {
      const entry = current(doc);
      if (entry?.pending) return entry.pending;
      const pending = engine.recalcReport(doc).then(
        (result): RecalcRun =>
          result === null
            ? { phase: "unavailable", reason: "this document is not a workbook" }
            : result.kind === "report"
              ? { phase: "done", report: result.report }
              : { phase: "unavailable", reason: result.reason },
        (error: unknown): RecalcRun => ({ phase: "error", ...kernelError(error) }),
      );
      set(doc, { phase: "running" }, pending);
      return pending.then((run) => {
        // A newer snapshot of the same document replaced this one meanwhile.
        if (current(doc)) set(doc, run);
        return run;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The `KernelError` an engine rejection carries as `cause`, or a stand-in. */
export function kernelError(error: unknown): { code: string; message: string } {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  if (cause && typeof cause.code === "string") {
    return { code: cause.code, message: typeof cause.message === "string" ? cause.message : cause.code };
  }
  return { code: "recalc-failed", message: error instanceof Error ? error.message : String(error) };
}

/** The store every Recalc stage and rail in this page share. */
export const recalcStore: RecalcStore = createRecalcStore();

/** Current run for `doc`, re-rendering when the store changes. */
export function useRecalcRun(store: RecalcStore, doc: LabDoc): RecalcRun {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);
  return store.get(doc);
}
