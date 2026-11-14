import {
  SESSION_CONTRACT,
  addressOnSide,
  buildPartsReport,
  canonical,
  changesOf,
  comparePackages,
  describeEntry,
  entryDecisionDoc,
  entryKey,
  hunkRecords,
  hunksOf,
  isoSeconds,
  opsOfEntry,
  parseManualOps,
  partContent,
  revealTarget,
  sideShown,
  type Address,
  type ApplyResult,
  type BatchEnvironment,
  type Change,
  type Decision,
  type DecisionDoc,
  type DocState,
  type Hunk,
  type KernelClient,
  type KernelError,
  type Op,
  type PartFinding,
  type PartsReport,
  type SessionExport,
} from "@wolfsdk/protocol";
import type { EditorHost, HistoryEntry } from "../host/index.ts";
import { originalBytes, watchOriginal } from "./original.ts";

export type DroppedEntry = { entry: HistoryEntry };

/** Reviewer-facing UI state kept beside the editor snapshot. */
export type ReviewUi = {
  inspected: number | null;
  /** Revision the reviewer was at before flipping to the "before" side. */
  origin: number | null;
  /** Revision whose reject choice (this+after / only this) is open. */
  choosing: number | null;
  expanded: Set<number>;
  selectedChange: { revision: number; index: number } | null;
  working: string | null;
  notice: string | null;
  failure: { code: string; message: string; label?: string } | null;
  /** Last rejection refused because kept and rejected hunks do not commute; cleared by the next action. */
  coupled: CoupledNotice | null;
};

/** Why a rejection was refused: a kept hunk (`revision` of the entry, `op`) or a
 * later entry (`op: null`) whose result depends on the rejected ops. `kind`:
 * `refused` (the rejected ops no longer apply), `differs` (package parts come out
 * different, named in `detail`), `unverifiable` (the two results could not be read
 * or compared). */
export type Coupling = {
  revision: number;
  op: number | null;
  kind: "refused" | "differs" | "unverifiable";
  detail: string;
};

export type CoupledNotice = { revision: number; ops: number[]; coupled: Coupling[]; restored: boolean };

type RejectFailure =
  | { ok: false; reason: "refused"; failedLabel: string; error: KernelError; restored: boolean }
  | { ok: false; reason: "coupled"; coupled: Coupling[]; restored: boolean };

/** `entry` is the replacement entry, `null` when every op was rejected. */
export type RejectOpsResult = { ok: true; entry: HistoryEntry | null } | RejectFailure;
export type RejectOnlyResult = { ok: true } | RejectFailure;

export type SubmitBlocker = {
  code: "no-document" | "undecided" | "working" | "coupled" | "parts-unchecked" | "unexplained-parts" | "not-at-head";
  message: string;
};

/** The package-part check of one revision (`sha256`). Any other current sha256 reads as `stale`. */
export type PartsCheck = {
  status: "stale" | "checking" | "ready" | "failed";
  sha256: string | null;
  report: PartsReport | null;
  error: string | null;
};

const STALE: PartsCheck = { status: "stale", sha256: null, report: null, error: null };
const norm = (name: string): string => name.replace(/^\//, "");

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Acknowledgement key of an unexplained part in `zip`: name, status and the SHA-256 of its uncompressed
 * content (`-` for a removed part), so an acknowledgement lapses on any change to that part. */
export async function partKey(zip: Uint8Array, name: string, status: PartFinding["status"]): Promise<string> {
  if (status === "removed") return `${name}|removed|-`;
  const content = partContent(zip, name);
  if (!content) throw new Error(`${name} is missing from the saved file`);
  return `${name}|${status}|${await sha256Of(content)}`;
}

/** An approved hunk as it was before a rejection: its change records (`hunkRecords`)
 * and the `address` of each of its changes, whose view nodes must not change either. */
type ApprovedHunk = { records: string; addresses: Address[] };
type Carry = {
  entry: HistoryEntry;
  rejected: boolean;
  own: Decision | undefined;
  approved: Map<number | null, ApprovedHunk>;
  origIndex: number[] | undefined;
  rejectedOps: { index: number; op: Op }[] | undefined;
};

const hunkKey = (entry: HistoryEntry, op: number | null): string => `${entryKey(entry)}#${op === null ? "none" : op}`;
const sameEntry =
  (a: HistoryEntry) =>
  (b: HistoryEntry): boolean =>
    b.revision === a.revision && b.resultSha256 === a.resultSha256;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Tracked-change markup whose `w:id` the engine numbers in apply order: insertions, deletions,
 * moves and property changes. */
const REVISION_TAG =
  /<w:(?:ins|del|moveFrom|moveTo|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|rPrChange|pPrChange|sectPrChange|tblPrChange|tblGridChange|trPrChange|tcPrChange|numberingChange|cellIns|cellDel|cellMerge)\b[^>]*>/g;

/** The parts of `names` whose content still differs between the two packages once the `w:id` of every
 * tracked change is set aside. The engine numbers a tracked change's `w:id` in apply order, so
 * applying kept ops before rejected ones renumbers the same revisions; ids carry no content. */
function differInContent(before: Uint8Array, after: Uint8Array, names: string[]): string[] {
  const text = new TextDecoder("utf-8");
  const strip = (bytes: Uint8Array | null): string | null =>
    bytes && text.decode(bytes).replace(REVISION_TAG, (tag) => tag.replace(/\sw:id="[^"]*"/, ""));
  return names.filter((name) => {
    if (!name.endsWith(".xml")) return true;
    const a = strip(partContent(before, name));
    return a === null || a !== strip(partContent(after, name));
  });
}

/** Op kinds whose effects the engine's two-document diff reports. It misses
 * `format`, `move`, sort and sheet-structure changes (in documents, decks and
 * workbooks alike: the diff can come back empty while the package parts
 * differ), so its empty answer proves nothing for batches holding any other kind. */
const DIFF_REPORTED_OPS: Record<string, true> = {
  set: true,
  "replace-text": true,
  "splice-text": true,
  insert: true,
  delete: true,
};

/** An empty two-document diff proves equal content for ops in `DIFF_REPORTED_OPS`.
 * Refusals count as not proven. */
async function kernelDiffIsEmpty(kernel: KernelClient, before: Uint8Array, after: Uint8Array): Promise<boolean> {
  try {
    return (await kernel.diff(before, after)).changes.length === 0;
  } catch {
    return false;
  }
}

const stores = new WeakMap<EditorHost, ReviewStore>();
export const reviewStore = (host: EditorHost): ReviewStore => stores.get(host) ?? new ReviewStore(host);

export class ReviewStore {
  ui: ReviewUi = {
    inspected: null,
    origin: null,
    choosing: null,
    expanded: new Set(),
    selectedChange: null,
    working: null,
    notice: null,
    failure: null,
    coupled: null,
  };
  version = 0;
  /** Entry decisions by `entryKey`: "reject" for a rejected entry; "approve" only for an entry without hunks. */
  readonly decisions = new Map<string, Decision>();
  /** Approved hunks, keyed `entryKey#op` (`#none` for the hunk of changes without a cause). */
  readonly hunkDecisions = new Set<string>();
  mode: "edit" | "review" = "edit";
  /** First page of each region object per revision sha, keyed `sha|address`. */
  readonly pageOf = new Map<string, number>();
  readonly seenRegions = new Map<string, Set<string>>();
  readonly dropped: DroppedEntry[] = [];
  private doc: string | null = null;
  private listeners = new Set<() => void>();
  private readonly hunkCache = new WeakMap<HistoryEntry, Hunk[]>();
  /** Rejected-op batches `rejectOps` leaves in the redo tail; not exported, not counted. */
  private readonly probes = new WeakSet<HistoryEntry>();
  /** Per replacement entry: ops removed from it, at their index in the original batch. */
  private readonly rejectedOps = new Map<string, { index: number; op: Op }[]>();
  /** Per replacement entry: original batch index of each of its ops. */
  private readonly origIndex = new Map<string, number[]>();
  private submitHandler: (() => Promise<void>) | null = null;
  private submitting = false;
  /** Last parts check, and per unexplained part its acknowledgement key (`name|status|content`). */
  private parts: { check: PartsCheck; keys: Map<string, string> } | null = null;
  private partsRun: { sha256: string; promise: Promise<void> } | null = null;
  /** Acknowledged unexplained parts by key; a key names the part's content, so it lapses when the part changes. */
  private readonly acknowledged = new Set<string>();

  readonly host: EditorHost;

  constructor(host: EditorHost) {
    this.host = host;
    stores.set(host, this);
    host.subscribe(() => this.observe());
    watchOriginal(host);
    this.observe();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  patch(p: Partial<ReviewUi>): void {
    this.ui = { ...this.ui, ...p };
    this.bump();
  }

  /** Record times, seen regions; reset when another document opens. */
  private observe(): void {
    const snap = this.host.getSnapshot();
    const docId = snap.state?.doc ?? null;
    if (docId !== this.doc) {
      this.doc = docId;
      this.decisions.clear();
      this.hunkDecisions.clear();
      this.rejectedOps.clear();
      this.origIndex.clear();
      this.pageOf.clear();
      this.seenRegions.clear();
      this.dropped.length = 0;
      this.parts = null;
      this.acknowledged.clear();
      // `mode` and the submit handler belong to the host and survive a new document.
      this.ui = {
        ...this.ui,
        inspected: null,
        origin: null,
        choosing: null,
        expanded: new Set(),
        selectedChange: null,
        notice: null,
        failure: null,
        coupled: null,
      };
    }
    if (snap.state && !this.seenRegions.has(snap.state.sha256)) {
      const sha = snap.state.sha256;
      this.seenRegions.set(sha, new Set(snap.state.regions.map((r) => r.object_id)));
      for (const r of snap.state.regions)
        if (!this.pageOf.has(`${sha}|${r.object_id}`)) this.pageOf.set(`${sha}|${r.object_id}`, r.page);
    }
    this.bump();
  }

  // ------------------------------------------------------------ queries

  history(): HistoryEntry[] {
    return this.host.getSnapshot().history;
  }

  /** Reject when the entry is rejected; approve when every hunk is approved; else pending. */
  decisionOf(entry: HistoryEntry): Decision {
    const own = this.decisions.get(entryKey(entry));
    if (own === "reject") return "reject";
    const hunks = this.hunks(entry);
    if (hunks.length === 0) return own ?? "pending";
    return hunks.every((h) => this.hunkDecisions.has(hunkKey(entry, h.op))) ? "approve" : "pending";
  }

  hunks(entry: HistoryEntry): Hunk[] {
    let hunks = this.hunkCache.get(entry);
    if (!hunks) {
      hunks = hunksOf(entry);
      this.hunkCache.set(entry, hunks);
    }
    return hunks;
  }

  hunkDecisionOf(entry: HistoryEntry, op: number | null): Decision {
    if (this.isRejected(entry)) return "reject";
    return this.hunkDecisions.has(hunkKey(entry, op)) ? "approve" : "pending";
  }

  private isRejected(entry: HistoryEntry): boolean {
    return this.decisions.get(entryKey(entry)) === "reject";
  }

  private inHistory(entry: HistoryEntry): boolean {
    return this.history().some(sameEntry(entry));
  }

  /** The entry under inspection: the explicit choice, else the current revision's entry. */
  inspectedEntry(): HistoryEntry | null {
    const snap = this.host.getSnapshot();
    const byRev = (r: number) => snap.history.find((e) => e.revision === r) ?? null;
    if (this.ui.inspected !== null) {
      const e = byRev(this.ui.inspected);
      if (e) return e;
    }
    return snap.state && snap.state.revision > 0 ? byRev(snap.state.revision) : null;
  }

  /** Counts entries (history and removed ones); the probe batches of `rejectOps` are not counted. */
  summary(): { approve: number; reject: number; undecided: number } {
    const s = { approve: 0, reject: 0, undecided: 0 };
    const all = [...this.history().filter((e) => !this.probes.has(e)), ...this.dropped.map((d) => d.entry)];
    for (const e of all) {
      const d = this.decisionOf(e);
      if (d === "approve") s.approve++;
      else if (d === "reject") s.reject++;
      else s.undecided++;
    }
    return s;
  }

  // ------------------------------------------------------------ navigation

  async inspect(entry: HistoryEntry): Promise<void> {
    this.patch({
      inspected: entry.revision,
      origin: null,
      choosing: null,
      expanded: new Set(this.ui.expanded).add(entry.revision),
    });
    if (this.host.getSnapshot().state?.revision !== entry.revision) await this.host.goto(entry.revision);
    this.revealEntry(entry);
  }

  /** Scroll the shell to the first changed node of `entry` that exists on the shown side, else to its page. */
  private revealEntry(entry: HistoryEntry): void {
    const state = this.host.getSnapshot().state;
    const side = state ? sideShown(entry, state) : null;
    if (!state || !side) return;
    const has = (a: string): boolean => Boolean(this.host.node(a));
    for (const change of changesOf(entry)) {
      const address = addressOnSide(entry, change, side);
      const target = address ? revealTarget(address, has) : null;
      if (target) return this.host.reveal({ address: target });
    }
    for (const change of changesOf(entry)) {
      const address = addressOnSide(entry, change, side);
      const region = address ? state.regions.find((r) => r.object_id === address) : undefined;
      if (region) return this.host.reveal({ page: region.page });
    }
  }

  toggleExpanded(revision: number): void {
    const next = new Set(this.ui.expanded);
    if (!next.delete(revision)) next.add(revision);
    this.patch({ expanded: next });
  }

  /** Move to `revision` and inspect its entry (revision 0 inspects nothing). */
  async step(revision: number): Promise<void> {
    const snap = this.host.getSnapshot();
    if (!snap.state) return;
    const target = Math.max(0, Math.min(snap.history.length, revision));
    const entry = snap.history.find((e) => e.revision === target) ?? null;
    this.patch({ inspected: entry?.revision ?? null, origin: null, choosing: null });
    if (target !== snap.state.revision) await this.host.goto(target);
  }

  stepBy(delta: number): Promise<void> {
    return this.step((this.host.getSnapshot().state?.revision ?? 0) + delta);
  }

  /** Select a change's address; when the shown side does not carry it, say so. */
  async selectChange(entry: HistoryEntry, index: number): Promise<void> {
    const change = changesOf(entry)[index];
    if (!change) return;
    this.patch({ inspected: entry.revision, selectedChange: { revision: entry.revision, index }, choosing: null });
    let state = this.host.getSnapshot().state;
    if (state && !sideShown(entry, state)) {
      await this.host.goto(entry.revision);
      state = this.host.getSnapshot().state;
    }
    const side = state ? sideShown(entry, state) : null;
    const address = side === "before" ? (change.change === "moved" ? change.from : change.address) : change.address;
    const target = address ? revealTarget(address, (a) => Boolean(this.host.node(a))) : null;
    if (target) {
      this.host.select([target]);
      this.host.reveal({ address: target });
      return;
    }
    // Deleted node: reveal the page it was drawn on in the base revision, if known.
    const base = change.change === "removed" ? change.address : address;
    const page = base ? this.pageOf.get(`${entry.baseSha256}|${base}`) : undefined;
    if (page !== undefined) this.host.reveal({ page });
  }

  /** Change records as the panel lists them: newest change set first, then its list items top to
   * bottom, each item's primary record first, then the records folded into it. */
  changeSequence(): { entry: HistoryEntry; index: number }[] {
    return [...this.history()]
      .reverse()
      .flatMap((entry) =>
        describeEntry(entry).flatMap((item) =>
          [item.primary, ...item.indices.filter((i) => i !== item.primary)].map((index) => ({ entry, index })),
        ),
      );
  }

  /** Select the next (`+1`) or previous (`-1`) change record in `changeSequence()` order and reveal it. */
  async moveChange(delta: number): Promise<{ revision: number; index: number } | null> {
    const seq = this.changeSequence();
    if (seq.length === 0) return null;
    const sel = this.ui.selectedChange;
    const at = sel ? seq.findIndex((s) => s.entry.revision === sel.revision && s.index === sel.index) : -1;
    const next = at < 0 ? (delta > 0 ? 0 : seq.length - 1) : Math.max(0, Math.min(seq.length - 1, at + delta));
    const target = seq[next]!;
    this.patch({ expanded: new Set(this.ui.expanded).add(target.entry.revision) });
    await this.selectChange(target.entry, target.index);
    return { revision: target.entry.revision, index: target.index };
  }

  /** Reveal the selected change again (scrolls the page to it). Returns false when none is selected. */
  async revealSelected(): Promise<boolean> {
    const sel = this.ui.selectedChange;
    const entry = sel ? this.history().find((e) => e.revision === sel.revision) : undefined;
    if (!sel || !entry) return false;
    await this.selectChange(entry, sel.index);
    return true;
  }

  /** Save the decision file through the browser's download. Returns false when no document is open. */
  async downloadExport(): Promise<boolean> {
    const doc = await this.buildExport();
    if (!doc) return false;
    const stem = doc.document.name.replace(/\.[^.]+$/, "");
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}.review-decision.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  /** Flip between `revision - 1` and `revision` of the inspected entry; the
   * second flip returns to the revision the reviewer was at. */
  async flip(): Promise<void> {
    const entry = this.inspectedEntry();
    const cur = this.host.getSnapshot().state?.revision;
    if (!entry || cur === undefined) return;
    if (cur === entry.revision - 1) {
      const back = this.ui.origin ?? entry.revision;
      this.patch({ origin: null });
      await this.host.goto(back);
    } else {
      this.patch({ inspected: entry.revision, origin: cur });
      await this.host.goto(entry.revision - 1);
    }
  }

  // ------------------------------------------------------------ decisions

  private clearCoupled(): void {
    if (this.ui.coupled) this.ui = { ...this.ui, coupled: null };
  }

  /** Drop the entry decision and every hunk decision of `entry`. */
  private clearDecisions(entry: HistoryEntry): void {
    this.decisions.delete(entryKey(entry));
    for (const h of this.hunks(entry)) this.hunkDecisions.delete(hunkKey(entry, h.op));
  }

  approve(entry: HistoryEntry): void {
    this.setDecision(entry, this.decisionOf(entry) === "approve" ? "pending" : "approve");
  }

  /** Set every hunk of `entry`. Entries no longer in the history only take "reject". */
  setDecision(entry: HistoryEntry, d: Decision): void {
    if (d !== "reject" && !this.inHistory(entry)) return;
    this.clearCoupled();
    this.clearDecisions(entry);
    const hunks = this.hunks(entry);
    if (d === "reject" || (d === "approve" && hunks.length === 0)) this.decisions.set(entryKey(entry), d);
    else if (d === "approve") for (const h of hunks) this.hunkDecisions.add(hunkKey(entry, h.op));
    this.bump();
  }

  /** Approve or clear one hunk. On a rejected entry this lifts the rejection (other hunks keep their state). */
  setHunkDecision(entry: HistoryEntry, op: number | null, d: "approve" | "pending"): void {
    if (!this.inHistory(entry)) return;
    this.clearCoupled();
    if (this.isRejected(entry)) this.decisions.delete(entryKey(entry));
    if (d === "approve") this.hunkDecisions.add(hunkKey(entry, op));
    else this.hunkDecisions.delete(hunkKey(entry, op));
    this.bump();
  }

  /** Reject click: an entry with only rejected entries after it steps back; an older one opens the choice. */
  async reject(entry: HistoryEntry): Promise<void> {
    const after = this.history().filter((e) => e.revision > entry.revision);
    if (after.every((e) => this.isRejected(e))) return this.rejectWithAfter(entry);
    this.patch({ choosing: entry.revision, coupled: null });
  }

  /** Reject `entry` and every later entry; the cursor goes to before `entry`
   * (never forward). Rejected entries stay in the redo tail. */
  async rejectWithAfter(entry: HistoryEntry): Promise<void> {
    const hist = this.history();
    for (const e of hist) if (e.revision >= entry.revision) this.decisions.set(entryKey(e), "reject");
    this.patch({ choosing: null, notice: null, failure: null, coupled: null, inspected: entry.revision });
    const cur = this.host.getSnapshot().state?.revision ?? 0;
    if (cur >= entry.revision) await this.host.goto(entry.revision - 1);
  }

  /** Reject only `entry`: `rejectOps` with every op of the entry. */
  async rejectOnly(entry: HistoryEntry): Promise<RejectOnlyResult> {
    const r = await this.rejectOps(
      entry,
      entry.ops.map((_, i) => i),
    );
    return r.ok ? { ok: true } : r;
  }

  private carryOf(entry: HistoryEntry): Carry {
    const key = entryKey(entry);
    const rejected = this.isRejected(entry);
    const approved = new Map<number | null, ApprovedHunk>();
    const changes = changesOf(entry);
    if (!rejected)
      for (const h of this.hunks(entry))
        if (this.hunkDecisions.has(hunkKey(entry, h.op)))
          approved.set(h.op, {
            records: hunkRecords(entry, h),
            addresses: [...new Set(h.changeIndices.map((i) => changes[i]!.address))],
          });
    return {
      entry,
      rejected,
      own: this.decisions.get(key),
      approved,
      origIndex: this.origIndex.get(key),
      rejectedOps: this.rejectedOps.get(key),
    };
  }

  /** View node at `address` in the current revision as canonical JSON (`null` when absent). */
  private nodeJson(address: Address): string {
    return canonical(this.host.node(address) ?? null);
  }

  /** Reject ops `ops` (indices into `entry.ops`) in one re-apply: go to the
   * revision before `entry`, apply the kept ops as one batch, re-apply every
   * later entry verbatim, then prove the rejection sound by applying the
   * rejected ops on top: the result must equal the original newest revision
   * (same sha256, or no package part added, removed or changed). The rejected
   * batch then stays in the redo tail, marked rejected, and the cursor is on the
   * new newest kept revision. A refusal, or a result that differs or cannot be
   * verified, rebuilds the original chain and cursor (`restored` says whether that worked).
   *
   * Every replayed batch runs with the clock and zone its original batch ran with
   * (the kernel's session log, read at the top of the chain before anything moves):
   * the kept ops and the rejected ops with `entry`'s, each later entry with its own,
   * and so does the rebuild of the original chain. On a live-clock kernel this keeps
   * time stamps (comment and tracked-change dates, `NOW()` caches) equal to the
   * original ones, so the comparison only sees what the rejection changed.
   *
   * Rejected entries at the end of the chain are not re-applied: they move to
   * `dropped`. An approval carries over to the replacement entry and to each
   * re-applied entry only when the hunk's change records and the view nodes at
   * its change addresses are unchanged; otherwise the hunk is pending again. */
  async rejectOps(entry: HistoryEntry, ops: number[]): Promise<RejectOpsResult> {
    const host = this.host;
    // A parts check may move the host (`originalBytes` by goto); let it finish first.
    await this.partsRun?.promise;
    const snap0 = host.getSnapshot();
    const state0 = snap0.state;
    if (!state0) throw new Error("no document is open");
    if (this.ui.working) throw new Error(`another review action is running (${this.ui.working})`);
    const hist = snap0.history.slice();
    const idx = hist.findIndex(sameEntry(entry));
    if (idx < 0) throw new Error("entry is no longer in the history");
    entry = hist[idx]!;
    const chosen = new Set<number>();
    for (const i of ops) {
      if (!Number.isInteger(i) || i < 0 || i >= entry.ops.length)
        throw new Error(`${i} is not an op index of "${entry.label}"`);
      chosen.add(i);
    }
    if (chosen.size === 0) return { ok: true, entry };
    const rejected = [...chosen].sort((a, b) => a - b);
    const kept = entry.ops.map((_, i) => i).filter((i) => !chosen.has(i));
    let end = hist.length - 1;
    while (end > idx && this.isRejected(hist[end]!)) end--;
    const later = hist.slice(idx + 1, end + 1);
    const parked = hist.slice(end + 1);
    const head = hist[end]!;
    const startRevision = state0.revision;
    const doc = state0.doc;
    const wasProbe = hist.map((e) => this.probes.has(e));
    const carries = [entry, ...later].map((e) => this.carryOf(e));
    const origin = carries[0]!.origIndex ?? entry.ops.map((_, i) => i);
    const removed = [
      ...(carries[0]!.rejectedOps ?? []),
      ...rejected.map((i) => ({ index: origin[i]!, op: entry.ops[i]! })),
    ].sort((a, b) => a.index - b.index);
    this.patch({
      working: "Rejecting and re-applying later changes",
      choosing: null,
      notice: null,
      failure: null,
      coupled: null,
    });

    /** Clock and zone each entry of `hist` originally ran with, filled before the first move. */
    const envs = new Map<HistoryEntry, BatchEnvironment>();
    const reapply = (e: HistoryEntry): Promise<ApplyResult> =>
      host.apply(opsOfEntry(e), { label: e.label, source: e.source, quiet: true, at: envs.get(e) });
    // `host.goto` reports a failed move in `lastError` only; make it throw.
    const moveTo = async (revision: number): Promise<void> => {
      await host.goto(revision);
      if (host.getSnapshot().state?.revision !== revision)
        throw new Error(host.getSnapshot().lastError?.message ?? `could not go to revision ${revision}`);
    };
    let touched = false;
    /** Rebuild the original chain (deterministic engine) and cursor. */
    const restore = async (): Promise<boolean> => {
      try {
        if (touched) {
          await moveTo(entry.revision - 1);
          for (const e of hist.slice(idx)) if (!(await reapply(e)).ok) return false;
        }
        await moveTo(startRevision);
      } catch {
        return false;
      }
      const now = host.getSnapshot().history;
      const same = now.length === hist.length && now.every((e, i) => e.resultSha256 === hist[i]!.resultSha256);
      if (same)
        now.forEach((e, i) => {
          if (wasProbe[i]) this.probes.add(e);
        });
      return same;
    };

    const headNodes = new Map<Address, string>();
    type Outcome =
      | { kind: "refused"; label: string; error: KernelError }
      | { kind: "coupled"; coupled: Coupling[] }
      | { kind: "ok" };
    const attempt = async (): Promise<Outcome> => {
      // The session log covers the revisions up to the cursor: read it at the top of the chain.
      await moveTo(hist.length);
      const log = await host.kernel.session(doc);
      hist.forEach((e, i) => {
        const b = log.batches[i];
        if (b?.resultSha256 === e.resultSha256)
          envs.set(e, { clock: b.clock ?? log.clock, timezone: b.timezone ?? log.timezone });
      });
      await moveTo(head.revision);
      const headBytes = await host.save();
      for (const c of carries)
        for (const hunk of c.approved.values())
          for (const a of hunk.addresses) if (!headNodes.has(a)) headNodes.set(a, this.nodeJson(a));
      await moveTo(entry.revision - 1);
      if (kept.length) {
        touched = true;
        const r = await host.apply(
          kept.map((i) => entry.ops[i]!),
          { label: entry.label, source: entry.source, quiet: true, at: envs.get(entry) },
        );
        if (!r.ok) return { kind: "refused", label: entry.label, error: r.error };
      }
      for (const e of later) {
        touched = true;
        const r = await reapply(e);
        if (!r.ok) return { kind: "refused", label: e.label, error: r.error };
      }
      const prime = host.getSnapshot().state!.revision;
      touched = true;
      // The rejected ops run with `entry`'s clock too: their own time stamps (comment and
      // tracked-change dates, `NOW()` caches) then match the original head's.
      const probe = await host.apply(
        rejected.map((i) => entry.ops[i]!),
        { label: `Rejected: ${entry.label}`, source: entry.source, quiet: true, at: envs.get(entry) },
      );
      if (!probe.ok)
        return {
          kind: "coupled",
          coupled: rejected.map((op) => ({
            revision: entry.revision,
            op,
            kind: "refused",
            detail: `The rejected operations no longer apply after the kept ones (${probe.error.code}: ${probe.error.message}).`,
          })),
        };
      const coupled =
        probe.state.sha256 === head.resultSha256
          ? []
          : await this.couplings({ entry, rejected, kept, later, headBytes });
      await moveTo(prime);
      return coupled.length ? { kind: "coupled", coupled } : { kind: "ok" };
    };

    const restoredText = (restored: boolean): string =>
      restored ? "Previous state restored." : "The previous state could not be fully restored.";
    let outcome: Outcome;
    try {
      outcome = await attempt();
    } catch (e) {
      const restored = await restore();
      this.patch({
        working: null,
        failure: { code: "host-failure", message: messageOf(e), label: entry.label },
        notice: `Reject failed: ${messageOf(e)}. ${restoredText(restored)}`,
      });
      throw e;
    }
    if (outcome.kind === "refused") {
      const { label, error } = outcome;
      const restored = await restore();
      this.patch({
        working: null,
        failure: { code: error.code, message: error.message, label },
        notice: `Reject: "${label}" no longer applies without the rejected operations (${error.code}). ${restoredText(restored)}`,
      });
      return { ok: false, reason: "refused", failedLabel: label, error, restored };
    }
    if (outcome.kind === "coupled") {
      const { coupled } = outcome;
      const restored = await restore();
      const unverifiable = coupled.some((c) => c.kind === "unverifiable");
      this.patch({
        working: null,
        coupled: { revision: entry.revision, ops: rejected, coupled, restored },
        failure: { code: "coupled", message: coupled[0]!.detail, label: entry.label },
        notice: unverifiable
          ? `Not rejected: the result could not be verified. ${restoredText(restored)}`
          : `Not rejected: kept changes depend on the rejected ones. ${restoredText(restored)}`,
      });
      return { ok: false, reason: "coupled", coupled, restored };
    }

    // Committed. Layout: entries before `entry`, the replacement (when ops are
    // kept), the re-applied later entries, the probe (redo tail, cursor before it).
    const fresh = host.getSnapshot().history;
    let at = idx;
    const replacement = kept.length ? fresh[at++]! : null;
    const laterNew = later.map((_, i) => fresh[at + i]!);
    const probeEntry = fresh[at + later.length]!;
    // Old keys first: the probe usually reproduces the old head's revision and sha256.
    for (const c of carries) {
      this.clearDecisions(c.entry);
      this.rejectedOps.delete(entryKey(c.entry));
      this.origIndex.delete(entryKey(c.entry));
    }
    let reset = 0;
    /** Carry `from`'s decisions to `to` hunk by hunk (`oldOp` maps a new op index
     * to the old one); approvals of ops in `leaving` disappear without counting as reset. */
    const carry = (
      from: Carry,
      to: HistoryEntry,
      oldOp: (op: number | null) => number | null,
      leaving: ReadonlySet<number>,
    ): void => {
      if (from.rejected) {
        this.decisions.set(entryKey(to), "reject");
        return;
      }
      const hunks = this.hunks(to);
      if (hunks.length === 0 && from.own === "approve") this.decisions.set(entryKey(to), "approve");
      const carried = new Set<number | null>();
      for (const h of hunks) {
        const op = oldOp(h.op);
        const before = from.approved.get(op);
        if (
          before &&
          before.records === hunkRecords(to, h) &&
          before.addresses.every((a) => headNodes.get(a) === this.nodeJson(a))
        ) {
          this.hunkDecisions.add(hunkKey(to, h.op));
          carried.add(op);
        }
      }
      for (const op of from.approved.keys()) if (!carried.has(op) && !(op !== null && leaving.has(op))) reset++;
    };
    if (replacement) {
      carry(carries[0]!, replacement, (j) => (j === null ? null : kept[j]!), chosen);
      this.origIndex.set(
        entryKey(replacement),
        kept.map((i) => origin[i]!),
      );
      this.rejectedOps.set(entryKey(replacement), removed);
    }
    laterNew.forEach((now, i) => {
      const from = carries[i + 1]!;
      carry(from, now, (op) => op, new Set<number>());
      if (from.origIndex) this.origIndex.set(entryKey(now), from.origIndex);
      if (from.rejectedOps) this.rejectedOps.set(entryKey(now), from.rejectedOps);
    });
    this.probes.add(probeEntry);
    this.clearDecisions(probeEntry);
    this.decisions.set(entryKey(probeEntry), "reject");
    if (!replacement) {
      this.decisions.set(entryKey(entry), "reject");
      this.rejectedOps.set(entryKey(entry), removed);
      this.dropped.push({ entry });
    }
    parked.forEach((e, i) => {
      if (!wasProbe[end + 1 + i]) this.dropped.push({ entry: e });
    });
    const reapplied = `${plural(later.length, "later change", "later changes")} re-applied.`;
    const again = reset
      ? ` ${plural(reset, "approved edit", "approved edits")} changed and ${reset === 1 ? "needs" : "need"} review again.`
      : "";
    this.patch({
      working: null,
      inspected: null,
      notice:
        (replacement
          ? `Rejected ${rejected.length} of ${entry.ops.length} operations in "${entry.label}"; `
          : `Rejected "${entry.label}"; `) +
        reapplied +
        again,
    });
    return { ok: true, entry: replacement };
  }

  /** Couplings when the probe's sha256 differs from the original newest revision.
   * Empty when the packages still match part by part (only recompressed parts
   * differ) or, when every op involved is a kind the engine diff reports, a kernel
   * two-document diff is empty. Differing parts are traced to
   * the kept ops and later entries whose changes touch them; when none is
   * found the rejected ops themselves are named. `unverifiable` only when the
   * two results could not be read or compared. */
  private async couplings(a: {
    entry: HistoryEntry;
    rejected: number[];
    kept: number[];
    later: HistoryEntry[];
    headBytes: Uint8Array;
  }): Promise<Coupling[]> {
    const { entry, rejected } = a;
    const own = (kind: Coupling["kind"], detail: string): Coupling[] =>
      rejected.map((op) => ({ revision: entry.revision, op, kind, detail }));
    let differing: string[];
    try {
      const bytes = await this.host.save();
      differing = comparePackages(a.headBytes, bytes)
        .deltas.filter((d) => d.status !== "recompressed")
        .map((d) => d.name);
      if (differing.length === 0) return [];
      differing = differInContent(a.headBytes, bytes, differing);
      if (differing.length === 0) return [];
      const reported = [a.entry, ...a.later].every((e) => e.ops.every((op) => DIFF_REPORTED_OPS[op.op] === true));
      if (reported && (await kernelDiffIsEmpty(this.host.kernel, a.headBytes, bytes))) return [];
    } catch (e) {
      return own("unverifiable", `The two results could not be compared: ${messageOf(e)}`);
    }
    const kind: Coupling["kind"] = "differs";
    const detail = `Without the rejected operations these parts come out different: ${differing.join(", ")}.`;
    const parts = new Set(differing);
    const touches = (c: Change): boolean => Array.isArray(c.parts) && c.parts.some((p) => parts.has(p));
    const out: Coupling[] = [];
    const changes = changesOf(entry);
    for (const op of a.kept)
      if (changes.some((c) => c.cause === op && touches(c))) out.push({ revision: entry.revision, op, kind, detail });
    for (const e of a.later) if (changesOf(e).some(touches)) out.push({ revision: e.revision, op: null, kind, detail });
    return out.length ? out : own(kind, detail);
  }

  // ------------------------------------------------------------ package parts

  /** The parts check of the current revision; `stale` when there is none for its sha256. */
  get partsCheck(): PartsCheck {
    const sha = this.host.getSnapshot().state?.sha256;
    const p = this.parts;
    return sha && p && p.check.sha256 === sha ? p.check : STALE;
  }

  /** Compare the saved current revision with the original file part by part, against the change
   * records of the entries up to the cursor. Does nothing while a review action runs or when the
   * current revision is already checked. Checks run one at a time; a result is kept only while the
   * cursor is still on the revision it was computed for. */
  refreshParts(): Promise<void> {
    const state = this.host.getSnapshot().state;
    if (!state || this.ui.working) return Promise.resolve();
    if (this.partsRun?.sha256 === state.sha256) return this.partsRun.promise;
    if (this.partsCheck.status === "ready") return Promise.resolve();
    const run = { sha256: state.sha256, promise: this.checkParts(state.doc, state.sha256, this.partsRun?.promise) };
    this.partsRun = run;
    void run.promise.then(() => {
      if (this.partsRun === run) this.partsRun = null;
    });
    return run.promise;
  }

  private async checkParts(doc: DocState["doc"], sha: string, previous: Promise<void> | undefined): Promise<void> {
    await previous;
    const current = (): boolean => {
      const s = this.host.getSnapshot().state;
      return s?.doc === doc && s.sha256 === sha;
    };
    if (!current() || this.ui.working) return;
    const keep = (check: PartsCheck, keys = new Map<string, string>()): void => {
      if (!current()) return;
      this.parts = { check, keys };
      this.bump();
    };
    keep({ status: "checking", sha256: sha, report: null, error: null });
    try {
      const original = await originalBytes(this.host);
      if (!current()) return;
      const bytes = await this.host.save();
      const snap = this.host.getSnapshot();
      if (!current()) return;
      if ((await sha256Of(bytes)) !== sha) throw new Error("the saved file does not match the current revision");
      const revision = snap.state!.revision;
      const entries = snap.history.filter((e) => e.revision <= revision && !this.probes.has(e));
      const report = buildPartsReport(original.bytes, bytes, entries);
      const keys = new Map<string, string>();
      for (const f of report.unexplained) keys.set(f.name, await partKey(bytes, f.name, f.status));
      keep({ status: "ready", sha256: sha, report, error: null }, keys);
    } catch (e) {
      keep({ status: "failed", sha256: sha, report: null, error: messageOf(e) });
    }
  }

  private ackKey(name: string): string | null {
    const p = this.parts;
    return p && p.check === this.partsCheck ? (p.keys.get(norm(name)) ?? null) : null;
  }

  /** Whether the reviewer accepted this unexplained part of the current check. */
  partAcknowledged(name: string): boolean {
    const key = this.ackKey(name);
    return key !== null && this.acknowledged.has(key);
  }

  /** Accept (or withdraw) one unexplained finding of the current check. The acknowledgement holds
   * for the part's present content only. False when `name` is not an unexplained part of it. */
  acknowledgePart(name: string, on = true): boolean {
    const key = this.ackKey(name);
    if (!key) return false;
    if (on) this.acknowledged.add(key);
    else this.acknowledged.delete(key);
    this.bump();
    return true;
  }

  // ------------------------------------------------------------ mode and submit

  setMode(mode: "edit" | "review"): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.bump();
  }

  get hasSubmitHandler(): boolean {
    return this.submitHandler !== null;
  }

  setSubmitHandler(fn: (() => Promise<void>) | null): void {
    this.submitHandler = fn;
    this.bump();
  }

  /** Why the current revision cannot be submitted yet; empty when it can. */
  submitBlockers(): SubmitBlocker[] {
    const snap = this.host.getSnapshot();
    const state = snap.state;
    if (!state) return [{ code: "no-document", message: "Open a document before submitting." }];
    const out: SubmitBlocker[] = [];
    if (this.ui.working) out.push({ code: "working", message: `Wait until "${this.ui.working}" finishes.` });
    if (this.ui.coupled)
      out.push({
        code: "coupled",
        message: "A rejection was refused because kept edits depend on it. Reject them together or dismiss the notice.",
      });
    let pending = 0;
    const rejectedIn: number[] = [];
    let ahead = false;
    for (const e of snap.history) {
      if (e.revision > state.revision) {
        if (!this.isRejected(e)) ahead = true;
      } else if (this.isRejected(e)) rejectedIn.push(e.revision);
      else {
        const hunks = this.hunks(e);
        if (hunks.length === 0) pending += this.decisionOf(e) === "pending" ? 1 : 0;
        else pending += hunks.filter((h) => !this.hunkDecisions.has(hunkKey(e, h.op))).length;
      }
    }
    if (pending)
      out.push({ code: "undecided", message: `${plural(pending, "edit is", "edits are")} still undecided.` });
    if (rejectedIn.length)
      out.push({
        code: "undecided",
        message: `The current revision still contains rejected edits (revision ${rejectedIn.join(", ")}). Go back before them.`,
      });
    if (ahead) out.push({ code: "not-at-head", message: "Go back to the latest revision before submitting." });
    // Nothing applied: the file is the original, nothing to check.
    if (snap.history.length) {
      const pc = this.partsCheck;
      if (pc.status !== "ready" || !pc.report)
        out.push({
          code: "parts-unchecked",
          message:
            pc.status === "failed"
              ? `The file could not be checked for changes that no reviewed edit explains: ${pc.error}`
              : pc.status === "checking"
                ? "The file is still being checked for changes that no reviewed edit explains."
                : "The file has not been checked yet for changes that no reviewed edit explains.",
        });
      else {
        const open = pc.report.unexplained.filter((f) => !this.partAcknowledged(f.name)).length;
        if (open)
          out.push({
            code: "unexplained-parts",
            message: `${plural(open, "part of the file", "parts of the file")} changed without a reviewed change explaining ${open === 1 ? "it" : "them"}.`,
          });
      }
    }
    return out;
  }

  /** Run the submit handler. False when there is none, a submit is running, or something blocks it.
   * Checks the package parts of the current revision first when that has not been done. */
  async submit(): Promise<boolean> {
    const handler = this.submitHandler;
    if (!handler || this.submitting) return false;
    const partsCodes: SubmitBlocker["code"][] = ["parts-unchecked", "unexplained-parts"];
    if (this.submitBlockers().some((b) => !partsCodes.includes(b.code))) return false;
    this.submitting = true;
    try {
      if (this.partsCheck.status !== "ready") await this.refreshParts();
      if (this.submitBlockers().length) return false;
      await handler();
      return true;
    } finally {
      this.submitting = false;
    }
  }

  // ------------------------------------------------------------ manual ops

  /** Apply a reviewer-typed ops array. Returns the refusal (also kept in the UI by the caller). */
  async applyManual(text: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const parsed = parseManualOps(text);
    if (!parsed.ok) return parsed;
    this.clearCoupled();
    const r = await this.host.apply(parsed.ops, { label: "Manual ops", source: "review", quiet: true });
    if (r.ok) {
      this.patch({ inspected: r.state.revision, origin: null });
      return { ok: true };
    }
    return { ok: false, code: r.error.code, message: r.error.message };
  }

  // ------------------------------------------------------------ export

  /** Session decision file. Probe batches are left out; an entry beyond the
   * current revision is never exported as approved (it is not in the file). */
  async buildExport(): Promise<SessionExport | null> {
    const snap = this.host.getSnapshot();
    const state = snap.state;
    if (!state) return null;
    const now = Date.now();
    const pc = this.partsCheck;
    const parts: SessionExport["parts"] =
      pc.status === "ready" && pc.report && pc.sha256
        ? {
            checked_sha256: pc.sha256,
            changed: pc.report.changed,
            recompressed: [...pc.report.recompressed],
            unexplained: pc.report.unexplained.map((f) => ({
              name: f.name,
              status: f.status,
              verdict: f.verdict,
              acknowledged: this.partAcknowledged(f.name),
            })),
          }
        : null;
    const listed = snap.history.filter((e) => !this.probes.has(e));
    const rows = [
      ...listed.map((entry) => ({ entry, inHistory: true })),
      ...this.dropped.map((d) => ({ entry: d.entry, inHistory: false })),
    ];
    const entries: SessionExport["entries"] = [];
    const s = { approve: 0, reject: 0, undecided: 0 };
    for (const { entry, inHistory } of rows) {
      const beyond = inHistory && entry.revision > state.revision;
      const cap = (d: Decision): Decision => (beyond && d === "approve" ? "pending" : d);
      const decision = cap(this.decisionOf(entry));
      const hunks = this.hunks(entry).map((h) => ({
        op: h.op,
        decision: cap(this.hunkDecisionOf(entry, h.op)),
        change_indices: [...h.changeIndices],
      }));
      const owner = new Map<number, Decision>();
      for (const h of hunks) for (const i of h.change_indices) owner.set(i, h.decision);
      if (decision === "approve") s.approve++;
      else if (decision === "reject") s.reject++;
      else s.undecided++;
      entries.push({
        revision: entry.revision,
        label: entry.label,
        source: entry.source,
        applied_at: isoSeconds(entry.appliedAt),
        decision,
        in_history: inHistory,
        base_sha256: entry.baseSha256,
        result_sha256: entry.resultSha256,
        hunks,
        rejected_ops: this.rejectedOps.get(entryKey(entry)) ?? [],
        review_decision: await entryDecisionDoc({
          entry,
          decision,
          changeDecision: (i) => owner.get(i) ?? decision,
          docName: state.name,
          seen: this.seenRegions,
          decidedAt: now,
        }),
      });
    }
    return {
      contract: SESSION_CONTRACT,
      document: { name: state.name, format: state.format },
      original_sha256: snap.history[0]?.baseSha256 ?? this.dropped[0]?.entry.baseSha256 ?? state.sha256,
      final_sha256: listed.at(-1)?.resultSha256 ?? state.sha256,
      current_sha256: state.sha256,
      summary: s,
      complete: s.undecided === 0,
      decided_at: isoSeconds(now),
      entries,
      parts,
    };
  }
}
