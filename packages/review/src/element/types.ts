import type {
  Address,
  ApplyResult,
  DocFormat,
  DocState,
  KernelError,
  Op,
  SessionLog,
} from "@wolfsdk/protocol/contract";
import type { EngineFormat, EngineLoadCode, EngineSource, ResolvedEngine } from "@wolfsdk/runtime/loader";
import type { AgentActivity, AgentPresence, RoomActivityEvent } from "./activity.ts";

export type { Address, ApplyResult, DocFormat, DocState, KernelError, Op, SessionLog };
export type { EngineFormat, EngineLoadCode, EngineSource, ResolvedEngine };
export type { AgentActivity, AgentPresence, RoomActivityEvent };

/** The `engine-format` attribute: one document format's split module, or `auto` (the module of each opened document). */
export type WolfEngineFormat = EngineFormat | "auto";

/** The `engine` property: an `EngineSource` whose `format` may also be `auto`. */
export type WolfEngineSource = Omit<EngineSource, "format"> & { format?: WolfEngineFormat };

/** The feature plugins the element can load, in key-routing order. */
export type WolfPluginId = "docs" | "slides" | "sheets" | "review";

/** The `mode` attribute: `review` (default; review proposed changes, then submit) or `edit`. */
export type WolfMode = "edit" | "review";

/** `wolf-ready`: the engine module is fetched, verified and compiled; documents can open. */
export type WolfReadyDetail = {
  /** Absolute URL of the engine module. */
  moduleUrl: string;
  /** Engine version from the channel, or null for a module given by `engine-src`. */
  version: string | null;
  /** Lowercase hex SHA-256 the module was checked against, or null when none was given or published. */
  sha256: string | null;
};

/** `wolf-open`: a document opened (from `open`, `src`, the file picker or a drop). */
export type WolfOpenDetail = {
  /** File name as given to `open` (or the `name` attribute / last `src` path segment). */
  name: string;
  format: DocFormat;
  /** Number of rendered pages (`state.pages.length`; may be 0 for a workbook that prints nothing). */
  pages: number;
  /** Lowercase hex sha256 of the opened bytes. */
  sha256: string;
};

/** Where a committed revision came from. */
export type WolfChangeSource = "undo" | "redo" | (string & {});

/** `wolf-change`: a batch was committed, or undo/redo moved the revision cursor. */
export type WolfChangeDetail = {
  /** The current revision after the change (0 = as opened). */
  revision: number;
  /** sha256 of the document bytes at that revision (`save()` returns exactly these bytes). */
  sha256: string;
  /** The applied batch; for `undo` the batches undone, for `redo` the batches re-applied (in order). */
  ops: Op[];
  /** Plugin id that issued the batch (`docs`, `sheets`, …), `embed` for `element.apply`, or `undo` / `redo`. */
  source: WolfChangeSource;
};

/** `wolf-save`: the user saved from the editor UI. Cancelable: `preventDefault()` skips the download. */
export type WolfSaveDetail = {
  bytes: Uint8Array;
  sha256: string;
  /** File name the download would use. */
  name: string;
};

/** `wolf-error`: an engine refusal (`address-unresolved`, …), a kernel failure, an engine load failure
 * (`channel-unreachable`, `bad-version`, `bad-format`, `missing-checksum`, `checksum-mismatch`, `http-error`,
 * each with the failing URL in `argument`, or `wasm-compile-failed`), or an element error (`readonly`,
 * `src-fetch-failed`, `plugin-unknown`, `plugin-load-failed`, …). */
export type WolfErrorDetail = KernelError;

/** `wolf-selection`: the selected node addresses changed (primary first; empty when cleared). */
export type WolfSelectionDetail = {
  addresses: Address[];
};

/** `wolf-review-agent-activity`: the agents shown as present changed (the live ones, `idle` agents removed). */
export type WolfAgentActivityDetail = {
  agents: AgentPresence[];
};

/** One proposed batch of `openReview`. `clock` (a UTC instant, `2026-03-02T08:00:00Z`) and
 * `timezone` (an IANA zone) are when and where the proposal ran it: the batch runs with them
 * instead of the element's clock (each defaults to the element's own), as a `SessionLog` batch's
 * `clock` / `timezone` do. The session log records them, so a replay reproduces the bytes. */
export type WolfReviewBatch = { ops: Op[]; label?: string; clock?: string; timezone?: string };

/** `openReview` input: the document as proposed against, and the proposed batches in order. */
export type WolfReviewInput = {
  base: Uint8Array | Blob | File;
  /** File name, as for `open`. */
  name: string;
  /** One history entry each; a bare `Op[]` gets the label `Proposed change <n>` (1-based). */
  batches: (WolfReviewBatch | Op[])[];
};

/** `openReview` result: how many batches applied, and the first refused one (later ones were not tried). */
export type WolfReviewOpenResult = {
  applied: number;
  refused: { index: number; error: KernelError } | null;
};

/** One history entry of the review decision file. */
export type WolfReviewDecisionEntry = {
  revision: number;
  label: string;
  source: string;
  applied_at: string;
  decision: "approve" | "reject" | "pending";
  in_history: boolean;
  base_sha256: string;
  result_sha256: string;
  /** One per proposed operation of the entry (`op: null` holds changes no operation claims); `change_indices`
   * index the changes of `review_decision`. */
  hunks: { op: number | null; decision: "approve" | "reject" | "pending"; change_indices: number[] }[];
  /** Operations the reviewer removed from this entry, at their index in the batch as it was proposed. */
  rejected_ops: { index: number; op: Op }[];
  /** The entry's `wolfsuite.review-decision.v1` document (one decision per change). */
  review_decision: { contract: string; [key: string]: unknown };
};

/** The review decision file (`wolfsdk.review-session.v1`), as the review panel's download writes it. */
export type WolfReviewDecision = {
  contract: "wolfsdk.review-session.v1";
  document: { name: string; format: string };
  original_sha256: string;
  final_sha256: string;
  current_sha256: string;
  summary: { approve: number; reject: number; undecided: number };
  /** True when no change is undecided. */
  complete: boolean;
  decided_at: string;
  entries: WolfReviewDecisionEntry[];
  /** Package parts of the current revision compared with the original file, outside the engine. `unexplained`
   * lists parts that changed without a reviewed change naming them (`unnamed`: the engine reported writing the
   * part; `unreported`: it did not); submit requires each to be acknowledged. Null when not checked. */
  parts: {
    checked_sha256: string;
    changed: number;
    recompressed: string[];
    unexplained: {
      name: string;
      status: "added" | "removed" | "changed";
      verdict: "explained" | "unnamed" | "unreported";
      acknowledged: boolean;
    }[];
  } | null;
};

/** `wolf-review-submit`: the reviewer submitted in review mode. Cancelable: `preventDefault()` skips the
 * decision file download. The bytes come from the browser: replay `session` natively before trusting them. */
export type WolfReviewSubmitDetail = {
  /** The current revision's bytes (as `save()`), which hold only the approved changes. */
  bytes: Uint8Array;
  /** sha256 of the current revision, as the engine reported it. */
  sha256: string;
  /** File name as given to `open` / `openReview`. */
  name: string;
  /** The operation log of the current revision (as `session()`), for native replay with `wolf transact`. */
  session: SessionLog;
  decision: WolfReviewDecision;
};

export interface WolfReviewEventMap {
  "wolf-ready": CustomEvent<WolfReadyDetail>;
  "wolf-open": CustomEvent<WolfOpenDetail>;
  "wolf-change": CustomEvent<WolfChangeDetail>;
  "wolf-save": CustomEvent<WolfSaveDetail>;
  "wolf-error": CustomEvent<WolfErrorDetail>;
  "wolf-selection": CustomEvent<WolfSelectionDetail>;
  "wolf-review-submit": CustomEvent<WolfReviewSubmitDetail>;
  "wolf-review-agent-activity": CustomEvent<WolfAgentActivityDetail>;
}
