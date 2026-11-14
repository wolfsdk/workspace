// Runs the engine checks (one `run(ctx, format)` per check file) and turns each into a `CheckResult`.
// A thrown `Skipped` makes a skipped result naming the missing module command; any other throw is a
// failed result. Nothing here swallows an error or counts a skip as a pass.
import {
  CHECK_IDS,
  CheckFailure,
  Skipped,
  type CheckId,
  type CheckOutcome,
  type CheckResult,
  type EngineContext,
  type Format,
} from "./harness.ts";

type CheckModule = { run(ctx: EngineContext, format: Format): Promise<CheckOutcome> };

const LOADERS: Record<CheckId, () => Promise<CheckModule>> = {
  "review-actions": () => import("./review-actions.ts"),
  comparison: () => import("./comparison.ts"),
  "parts-gate": () => import("./parts-gate.ts"),
  "subset-replay": () => import("./subset-replay.ts"),
  "unexplained-parts": () => import("./unexplained-parts.ts"),
  submission: () => import("./submission.ts"),
};

/**
 * Runs `run` as check `id` on `format` and reports what happened: passed (with the outcome), skipped
 * (a thrown `Skipped`, naming the module command), or failed (any other throw).
 */
export async function executeCheck(
  ctx: EngineContext,
  id: CheckId,
  format: Format,
  run: CheckModule["run"],
): Promise<CheckResult> {
  const started = performance.now();
  const finish = (partial: Omit<CheckResult, "check" | "format" | "ms" | "notes" | "skipped"> & Partial<CheckResult>): CheckResult => ({
    check: id,
    format,
    ms: Math.round(performance.now() - started),
    notes: [],
    skipped: [],
    ...partial,
  });
  try {
    const outcome = await run(ctx, format);
    return finish({
      status: "passed",
      checks: outcome.checks,
      notes: outcome.notes ?? [],
      skipped: outcome.skipped ?? [],
      data: outcome.data,
    });
  } catch (error) {
    if (error instanceof Skipped) {
      return finish({ status: "skipped", checks: 0, skipped: [{ part: id, command: error.command, reason: error.message }] });
    }
    const message = error instanceof Error ? (error instanceof CheckFailure ? error.message : `${error.name}: ${error.message}`) : String(error);
    return finish({ status: "failed", checks: 0, error: message });
  }
}

/** Runs check `id` on `format`. */
export async function runCheck(ctx: EngineContext, id: CheckId, format: Format): Promise<CheckResult> {
  return executeCheck(ctx, id, format, async (c, f) => (await LOADERS[id]()).run(c, f));
}

/** Runs `ids` x `formats` in order (checks outer, formats inner); `onResult` sees each result as it lands. */
export async function runChecks(
  ctx: EngineContext,
  ids: readonly CheckId[],
  formats: readonly Format[],
  onResult: (result: CheckResult) => void = () => {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const id of ids) {
    for (const format of formats) {
      const result = await runCheck(ctx, id, format);
      results.push(result);
      onResult(result);
    }
  }
  return results;
}

export function isCheckId(name: string): name is CheckId {
  return (CHECK_IDS as readonly string[]).includes(name);
}
