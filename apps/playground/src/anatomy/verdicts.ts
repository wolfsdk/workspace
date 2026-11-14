import type { MemberVerdict, PackageDelta } from "../lab/index.ts";

/** Short name and one-line plain definition for each verdict. */
export const VERDICT_TEXT: Record<MemberVerdict, { label: string; definition: string }> = {
  "identical-stream": {
    label: "Identical stream",
    definition: "The same compressed bytes as before. Carried over untouched.",
  },
  "same-bytes-recompressed": {
    label: "Recompressed",
    definition: "The same content, compressed again into different bytes.",
  },
  "xml-equivalent": {
    label: "XML equivalent",
    definition: "The same XML meaning, written out differently.",
  },
  changed: { label: "Changed", definition: "The content differs from before." },
  removed: { label: "Removed", definition: "Present before, missing now." },
  added: { label: "Added", definition: "New in this file." },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A 0..1 share as a percentage rounded down to 0.1, so it never overstates. */
export function formatShare(share: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  return `${(Math.floor(clamped * 1000 + 1e-9) / 10).toFixed(1)}%`;
}

/** Sentence for the untouched share, read from the delta. */
export function untouchedLabel(share: number): string {
  return `Untouched: ${formatShare(share)} of the original compressed member bytes are carried over as identical streams.`;
}

/**
 * Animation state of the anatomy map across deltas. `shifted` holds the
 * members whose verdict moved since the previous delta; `generation` grows on
 * every new delta so the view can restart its animation.
 */
export type MotionState = {
  delta: PackageDelta | undefined;
  verdicts: ReadonlyMap<string, MemberVerdict>;
  shifted: ReadonlySet<string>;
  generation: number;
};

export const initialMotion: MotionState = {
  delta: undefined,
  verdicts: new Map(),
  shifted: new Set(),
  generation: 0,
};

/** A member with no recorded verdict reads as untouched. */
const BASELINE: MemberVerdict = "identical-stream";

export function advanceMotion(state: MotionState, delta: PackageDelta | undefined): MotionState {
  if (delta === state.delta) return state;
  const verdicts = new Map<string, MemberVerdict>();
  for (const v of delta?.verdicts ?? []) verdicts.set(v.name, v.verdict);
  const shifted = new Set<string>();
  for (const [name, verdict] of verdicts) if ((state.verdicts.get(name) ?? BASELINE) !== verdict) shifted.add(name);
  for (const [name, verdict] of state.verdicts) if (!verdicts.has(name) && verdict !== BASELINE) shifted.add(name);
  return { delta, verdicts, shifted, generation: state.generation + 1 };
}
