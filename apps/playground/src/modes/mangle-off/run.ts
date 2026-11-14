/**
 * The I/O of Mangle-Off against the playground interfaces only: what the
 * comparison starts from, the two lanes of one run, and page previews.
 *
 * Every outcome (applied, refused, conflict, rival exception, unsupported)
 * comes back as a lane; the run functions do not throw.
 */
import type {
  DocFormat,
  EditIntent,
  LabDoc,
  LabEngine,
  LabVerifier,
  ModeDeps,
  Op,
  PackageDelta,
  PackageInfo,
  RivalRecord,
} from "../../lab/index.ts";
import {
  changedBytes,
  kernelErrorOf,
  type LaneView,
  type OfferedRival,
  type PreviewPlan,
  rivalLaneFromFailure,
  rivalLaneFromRecord,
  rivalLaneUnsupported,
  wolfLaneFromFailure,
  wolfLaneFromStep,
  wolfLaneNoOps,
} from "./model.ts";

/** Author recorded on the steps this mode appends. */
export const AUTHOR = "Mangle-Off";
export const PX_PER_PT = 1.5;

/** Package of the open snapshot, or `null` when the verifier cannot read it. */
export async function inputInfo(engine: LabEngine, doc: LabDoc, verifier: LabVerifier): Promise<PackageInfo | null> {
  try {
    return await verifier.readPackage(await engine.bytes(doc));
  } catch {
    return null;
  }
}

/** The bytes both lanes start from: the current snapshot of the visitor's file. */
export type RunInput = { bytes: Uint8Array<ArrayBuffer>; name: string; doc: LabDoc };

export async function comparisonInput(engine: LabEngine, doc: LabDoc): Promise<RunInput> {
  return { bytes: await engine.bytes(doc), name: doc.name, doc };
}

export type RunContext = {
  engine: LabEngine;
  deps: ModeDeps;
  format: DocFormat;
  /** Package of the input, for lanes that produced no delta. */
  info: PackageInfo | null;
  onDoc: (doc: LabDoc) => void;
};

async function compare(ctx: RunContext, before: Uint8Array, after: Uint8Array): Promise<PackageDelta | null> {
  try {
    return await ctx.deps.verifier.comparePackages(before, after);
  } catch {
    return null;
  }
}

function tick(ctx: RunContext, delta: PackageDelta | null): void {
  if (delta) ctx.deps.geiger.tick(changedBytes(delta));
}

/**
 * Apply the intent with Wolf to the open snapshot. The document is the
 * shell's own (same id), so the step is reported through `onDoc`; the shell
 * owns its lifetime and nothing is closed here.
 */
export async function runWolf(ctx: RunContext, input: RunInput, intent: EditIntent, caption: string): Promise<LaneView> {
  let ops: Op[];
  try {
    ops = ctx.deps.wolfOpsFor(intent, input.doc);
  } catch (error) {
    return wolfLaneNoOps(ctx.info, caption, error instanceof Error ? error.message : String(error));
  }
  if (ops.length === 0) return wolfLaneNoOps(ctx.info, caption);
  let next: LabDoc;
  try {
    next = await ctx.engine.apply(input.doc, ops, caption, AUTHOR);
  } catch (error) {
    return wolfLaneFromFailure(error, ctx.info, caption);
  }
  ctx.onDoc(next);
  const step = next.steps.at(-1);
  if (!step) return wolfLaneNoOps(ctx.info, caption, "The engine returned no step.");
  let delta = step.delta ?? null;
  if (!delta && step.status === "applied") {
    delta = await ctx.engine.bytes(next).then(
      (after) => compare(ctx, input.bytes, after),
      () => null,
    );
  }
  tick(ctx, delta);
  return wolfLaneFromStep(step, delta, ctx.info, await renderFirstPage(ctx, next), next.sha256);
}

/** Page 1 of a snapshot as PNG bytes, or the reason it could not be rendered. */
async function renderFirstPage(ctx: RunContext, doc: LabDoc): Promise<PreviewPlan> {
  try {
    return { kind: "png", png: (await ctx.engine.pageImage(doc, 1, PX_PER_PT)).png };
  } catch (error) {
    const detail = kernelErrorOf(error)?.code ?? (error instanceof Error ? error.message : String(error));
    return { kind: "none", reason: `The page could not be shown: ${detail}` };
  }
}

/** Run the intent with the rival on the run's input bytes. */
export async function runRival(
  ctx: RunContext,
  offer: OfferedRival,
  input: RunInput,
  intent: EditIntent,
  caption: string,
): Promise<{ lane: LaneView; record: RivalRecord | null }> {
  if (!ctx.deps.rivals.supports(offer.rival, ctx.format, intent.kind)) {
    return { lane: rivalLaneUnsupported(offer.rival, ctx.info, caption), record: null };
  }
  let record: RivalRecord;
  try {
    record = await ctx.deps.rivals.run(offer.rival, input.bytes, intent);
  } catch (error) {
    return { lane: rivalLaneFromFailure(offer.rival, error, ctx.info, caption), record: null };
  }
  const delta = record.delta ?? (record.outputBytes ? await compare(ctx, input.bytes, record.outputBytes) : null);
  tick(ctx, delta);
  return { lane: rivalLaneFromRecord(record, ctx.info, delta), record };
}

/** PNG bytes for a lane's preview plan. A rival's output is opened, rendered and closed here. */
export async function resolvePreview(engine: LabEngine, plan: PreviewPlan, outputName: string): Promise<Uint8Array<ArrayBuffer>> {
  switch (plan.kind) {
    case "png":
      return plan.png;
    case "open-output": {
      const opened = await engine.openFile(plan.bytes, outputName);
      try {
        return (await engine.pageImage(opened, 1, PX_PER_PT)).png;
      } finally {
        await engine.close(opened).catch(() => undefined);
      }
    }
    case "none":
      throw new Error(plan.reason);
  }
}
