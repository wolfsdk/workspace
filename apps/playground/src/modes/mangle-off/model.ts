/**
 * Mangle-Off view-model. Pure functions from rival records and package
 * deltas to what the lanes show. No DOM, no engine calls: the Stage
 * component does the I/O and renders these.
 */
import {
  type DocFormat,
  type EditIntent,
  type KernelError,
  type LabRivals,
  type LabStep,
  MEMBER_VERDICTS,
  type MemberVerdict,
  type PackageDelta,
  type PackageInfo,
  type RivalId,
  type RivalLoss,
  type RivalRecord,
} from "../../lab/index.ts";

export type LaneWho = "wolf" | RivalId;
export type LaneState = "idle" | "running" | "done" | "error";
export type EditableKind = Exclude<EditIntent["kind"], "user-script">;

export const RIVALS: readonly RivalId[] = ["openpyxl", "python-docx", "python-pptx"];

// ---------------------------------------------------------------------------
// Verdict wording
// ---------------------------------------------------------------------------

/** How a verdict reads to the visitor. Only `identical-stream` is untouched. */
export type VerdictClass = "untouched" | "rewritten" | "changed" | "lost" | "added";

export function verdictClass(verdict: MemberVerdict): VerdictClass {
  switch (verdict) {
    case "identical-stream":
      return "untouched";
    case "same-bytes-recompressed":
    case "xml-equivalent":
      return "rewritten";
    case "changed":
      return "changed";
    case "removed":
      return "lost";
    case "added":
      return "added";
  }
}

export function verdictLabel(verdict: MemberVerdict): string {
  switch (verdict) {
    case "identical-stream":
      return "Untouched";
    case "same-bytes-recompressed":
      return "Rewritten without content change (recompressed)";
    case "xml-equivalent":
      return "Rewritten without content change (XML written again)";
    case "changed":
      return "Changed";
    case "removed":
      return "Lost";
    case "added":
      return "Added";
  }
}

export type CountRow = { verdict: MemberVerdict; label: string; count: number };

export function countRows(delta: PackageDelta): CountRow[] {
  return MEMBER_VERDICTS.map((verdict) => ({ verdict, label: verdictLabel(verdict), count: delta.counts[verdict] ?? 0 }));
}

/** Bytes the edit wrote or dropped, for the geiger tick. */
export function changedBytes(delta: PackageDelta): number {
  let total = 0;
  for (const member of delta.verdicts) {
    if (member.verdict === "identical-stream") continue;
    total += member.verdict === "removed" ? member.bytesBefore : member.bytesAfter;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Loss list
// ---------------------------------------------------------------------------

export type LossItem = { kind: "lost" | "rewritten"; label: string; members: string[] };

/**
 * What a lane lost or rewrote beyond the edit: the rival's own loss records
 * first, then every removed or rewritten member of the delta that those
 * records do not already name.
 */
export function lossItems(delta: PackageDelta | null, losses: readonly RivalLoss[] = []): LossItem[] {
  const items: LossItem[] = losses.map((loss) => ({
    kind: loss.severity === "data-loss" ? "lost" : "rewritten",
    label: loss.severity === "data-loss" ? `Lost: ${loss.category}` : `Rewritten without content change: ${loss.category}`,
    members: [...loss.members],
  }));
  if (!delta) return items;
  const named = new Set(losses.flatMap((loss) => loss.members));
  for (const member of delta.verdicts) {
    if (named.has(member.name)) continue;
    const cls = verdictClass(member.verdict);
    if (cls === "lost") items.push({ kind: "lost", label: `Lost: ${member.name}`, members: [member.name] });
    if (cls === "rewritten") {
      items.push({ kind: "rewritten", label: `${verdictLabel(member.verdict)}: ${member.name}`, members: [member.name] });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Rivals offered for a format
// ---------------------------------------------------------------------------

export type OfferedRival = { rival: RivalId };

/** Rivals the runner has an edit or script adapter for on `format`. */
export function offeredRivals(supports: LabRivals["supports"], format: DocFormat): OfferedRival[] {
  const kind = editableKind(format);
  return RIVALS.filter((rival) => supports(rival, format, kind) || supports(rival, format, "user-script")).map((rival) => ({
    rival,
  }));
}

export function noLaneMessage(format: DocFormat): string {
  return `No rival library edits ${format.toUpperCase()} files here.`;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export function editableKind(format: DocFormat): EditableKind {
  switch (format) {
    case "xlsx":
      return "set-cell";
    case "docx":
      return "replace-text";
    case "pptx":
      return "set-shape-text";
  }
}

export function emptyIntent(kind: EditableKind): EditIntent {
  switch (kind) {
    case "set-cell":
      return { kind, sheet: "", a1: "", value: "" };
    case "replace-text":
      return { kind, find: "", replace: "" };
    case "set-shape-text":
      return { kind, slide: 1, shape: "", text: "" };
  }
}

/** An empty edit form for the format's one editable kind. */
export function defaultIntentFor(format: DocFormat): EditIntent {
  return emptyIntent(editableKind(format));
}

export function intentValid(intent: EditIntent): boolean {
  switch (intent.kind) {
    case "set-cell":
      return intent.sheet.trim() !== "" && intent.a1.trim() !== "";
    case "replace-text":
      return intent.find !== "";
    case "set-shape-text":
      return intent.shape.trim() !== "" && Number.isInteger(intent.slide) && intent.slide >= 1;
    case "user-script":
      return intent.python.trim() !== "";
  }
}

/** Step label and lane caption for an intent. */
export function intentLabel(intent: EditIntent): string {
  switch (intent.kind) {
    case "set-cell":
      return `Set ${intent.sheet}!${intent.a1} to ${JSON.stringify(intent.value)}`;
    case "replace-text":
      return `Replace ${JSON.stringify(intent.find)} with ${JSON.stringify(intent.replace)}`;
    case "set-shape-text":
      return `Set the text of shape ${intent.shape} on slide ${intent.slide} to ${JSON.stringify(intent.text)}`;
    case "user-script":
      return "Your script";
  }
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export type LaneError = {
  kind: "refusal" | "conflict" | "exception" | "unsupported" | "no-ops";
  title: string;
  code?: string;
  detail?: string;
};

/** What the page preview should show. The Stage resolves `open-output` to
 * PNG bytes; `png` was rendered during the run, before the document it came
 * from was closed. */
export type PreviewPlan =
  | { kind: "none"; reason: string }
  | { kind: "png"; png: Uint8Array<ArrayBuffer> }
  | { kind: "open-output"; bytes: Uint8Array<ArrayBuffer> };

export type LaneView = {
  who: LaneWho;
  title: string;
  state: LaneState;
  caption: string;
  info: PackageInfo | null;
  delta: PackageDelta | null;
  losses: LossItem[];
  error: LaneError | null;
  note: string | null;
  preview: PreviewPlan;
  /** sha256 of the file this lane's result is, when known. */
  resultSha256: string | null;
  stdout?: string;
  stderr?: string;
};

export const NOT_RUN = "Not run yet.";

export function laneTitle(who: LaneWho, version?: string): string {
  if (who === "wolf") return "Wolf";
  return version ? `${who} ${version}` : who;
}

export function idleLane(who: LaneWho, info: PackageInfo | null, note: string = NOT_RUN, version?: string): LaneView {
  return {
    who,
    title: laneTitle(who, version),
    state: "idle",
    caption: "",
    info,
    delta: null,
    losses: [],
    error: null,
    resultSha256: null,
    note,
    preview: { kind: "none", reason: note },
  };
}

export function runningLane(lane: LaneView, caption: string): LaneView {
  return { ...lane, state: "running", caption, note: "Running.", error: null, preview: { kind: "none", reason: "Running." }, resultSha256: null };
}

/** Rival lane from one record. An exception is a result: the lane ends in
 * `error` and says what was raised. */
export function rivalLaneFromRecord(
  record: RivalRecord,
  input: PackageInfo | null,
  delta: PackageDelta | null = record.delta ?? null,
): LaneView {
  const error: LaneError | null = record.ok
    ? null
    : { kind: "exception", title: `${record.rival} raised an error`, detail: record.error ?? "No error text was returned." };
  return {
    who: record.rival,
    title: laneTitle(record.rival, record.version),
    state: record.ok ? "done" : "error",
    caption: intentLabel(record.intent),
    info: delta?.before ?? input,
    delta,
    losses: lossItems(delta, record.losses),
    error,
    note: null,
    preview: rivalPreviewPlan(record),
    resultSha256: null,
    stdout: record.stdout,
    stderr: record.stderr,
  };
}

export function rivalPreviewPlan(record: RivalRecord): PreviewPlan {
  if (!record.outputBytes) return { kind: "none", reason: "The rival returned no output file." };
  return { kind: "open-output", bytes: record.outputBytes };
}

/** Wolf lane from the step `engine.apply` appended, with the snapshot's
 * sha256 and a preview rendered before that snapshot was closed. A step that
 * did not apply is a conflict, shown as the result. */
export function wolfLaneFromStep(
  step: LabStep,
  delta: PackageDelta | null,
  input: PackageInfo | null,
  preview: PreviewPlan,
  resultSha256: string,
): LaneView {
  const conflict = step.status !== "applied";
  return {
    who: "wolf",
    title: laneTitle("wolf"),
    state: conflict ? "error" : "done",
    caption: step.label,
    info: delta?.before ?? input,
    delta,
    losses: lossItems(delta),
    error: conflict
      ? {
          kind: "conflict",
          title: step.status === "conflict" ? "Wolf reported a conflict" : "Wolf did not apply this edit",
          code: step.error?.code,
          detail: step.error?.message,
        }
      : null,
    note: null,
    preview,
    resultSha256,
  };
}

/** The `KernelError` behind a rejected engine call, if there is one. */
export function kernelErrorOf(error: unknown): KernelError | null {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (!cause || typeof cause !== "object" || !("code" in cause) || typeof cause.code !== "string") return null;
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : cause.code;
  return { ...cause, code: cause.code, message };
}

export const WOLF_REFUSED = "Wolf refused this edit";

export function wolfLaneFromFailure(
  error: unknown,
  input: PackageInfo | null,
  caption: string,
  title: string = WOLF_REFUSED,
): LaneView {
  const kernel = kernelErrorOf(error);
  return {
    ...idleLane("wolf", input),
    state: "error",
    caption,
    note: null,
    preview: { kind: "none", reason: "Wolf wrote no new file." },
    error: {
      kind: "refusal",
      title,
      code: kernel?.code,
      detail: kernel?.message ?? (error instanceof Error ? error.message : String(error)),
    },
  };
}

export function wolfLaneNoOps(input: PackageInfo | null, caption: string, detail?: string): LaneView {
  return {
    ...idleLane("wolf", input),
    state: "error",
    caption,
    note: null,
    preview: { kind: "none", reason: "Wolf wrote no new file." },
    error: { kind: "no-ops", title: "Wolf has no operation for this edit", detail },
  };
}

export function rivalLaneUnsupported(rival: RivalId, input: PackageInfo | null, caption: string): LaneView {
  return {
    ...idleLane(rival, input, ""),
    state: "error",
    caption,
    note: null,
    preview: { kind: "none", reason: "The rival wrote no new file." },
    error: { kind: "unsupported", title: `The playground has no ${rival} script for this edit on this format` },
  };
}

export function rivalLaneFromFailure(rival: RivalId, error: unknown, input: PackageInfo | null, caption: string): LaneView {
  return {
    ...idleLane(rival, input, ""),
    state: "error",
    caption,
    note: null,
    preview: { kind: "none", reason: "The rival wrote no new file." },
    error: {
      kind: "exception",
      title: `${rival} did not finish`,
      code: kernelErrorOf(error)?.code,
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

export type Lanes = { wolf: LaneView; rival: LaneView | null };

/** Lanes before any run: both idle. */
export function initialLanes(rival: OfferedRival | null, info: PackageInfo | null): Lanes {
  return { wolf: idleLane("wolf", info), rival: rival ? idleLane(rival.rival, info) : null };
}
