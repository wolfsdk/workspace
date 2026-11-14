/**
 * Plugin-local state for one `EditorHost`: the in-place editor, track
 * changes, refused (disabled) features, find state, and a serial action
 * queue. Every document change goes through `run`, which first commits
 * pending typing, builds ops against the current revision, applies them with
 * `host.apply`, and re-derives cached addresses.
 */
import { KernelRequestError, type Address, type ApplyResult, type DocState, type KernelError, type Op, type TransactionSummary } from "@wolfsdk/protocol";
import { type EditorHost } from "../../host/index.ts";
import { isReactorKernel } from "@wolfsdk/protocol";
import { useEffect, useState } from "preact/hooks";
import { buildModel, remapAll, remapper, type DocModel, type Remapper } from "./addresses.ts";
import { cleanText, createdRevisions, isoNow, type FontFormat, type Track } from "./ops.ts";
import { changedRange, sameStoredText, spliceOps } from "./textedit.ts";

export const SOURCE = "docs";

export type Editing = {
  /** Increments every time an editor opens (component key). */
  session: number;
  para: Address;
  /** Text the engine holds for `para`. */
  base: string;
  /** Local text in the editor. */
  text: string;
  selStart: number;
  selEnd: number;
  /** Page the editor (caret mode: the caret) is drawn on. */
  page: number;
  /** `caret`: a caret drawn over the page from the engine's text layout (reactor kernel);
   * `box`: a textarea over the paragraph box (command kernel, or no exact layout). */
  mode: "caret" | "box";
  /** The selection was extended leftwards: the moving end is `selStart`. */
  backward: boolean;
  /** At a row boundary the caret sits on the end of the earlier row (End, a click past a row's end). */
  upstream: boolean;
  /** Page x (pt) Up/Down aim for; null until the first vertical move. */
  goalX: number | null;
};

export type Notice = { kind: "info" | "error"; text: string; code?: string };

export type FindState = { open: boolean; query: string; replace: string; index: number; focus: number };

export type Compose = "comment" | "link" | "table" | null;

/** Formatting this session applied to whole paragraphs (the engine's view has none yet). */
export type FormatMemory = FontFormat & { style?: string };

export type DocsUi = {
  track: boolean;
  author: string;
  editing: Editing | null;
  disabled: Record<string, KernelError>;
  notice: Notice | null;
  find: FindState;
  /** Toolbar compose row open (comment, link or table form). */
  compose: Compose;
  /** `revision:#n` addresses the last apply created (receipt `ops[].revisions`). */
  freshRevisions: Address[];
};

export type Done = {
  result: Extract<ApplyResult, { ok: true }>;
  before: DocState;
  remap: Remapper;
};

export type Plan = {
  ops: Op[];
  /** Selection after the apply; default: the previous selection remapped. */
  select?: (done: Done) => Address[] | null;
  after?: (done: Done) => void | Promise<void>;
  /** Bring the first selected node into view after the apply (structure changes). */
  reveal?: boolean;
};

export type RunOptions = {
  /** Control id disabled for the session when the engine lacks the op kind. */
  feature?: string;
  /** Do not commit the open editor first (the commit itself). */
  skipCommit?: boolean;
};

export class UserError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Refusals that mean the module lacks the operation: the control is disabled
 * for the session. Every other code is a notice and the control stays: `unsupported`
 * names a construct in this document (a merged row, a field), `usage` is a
 * malformed request. Operations whose `op-kind-mismatch` is about the target
 * (`join-paragraph` at a table or section boundary) run without a `feature`.
 */
const CAPABILITY_CODES: Record<string, true> = { "op-kind-mismatch": true, "op-not-implemented": true };
const COMMIT_DELAY_MS = 800;

const remapCache = new WeakMap<DocState, { after: DocState; remap: Remapper }>();

function cachedRemapper(before: DocState, after: DocState, tx: TransactionSummary | null): Remapper {
  const hit = remapCache.get(before);
  if (hit && hit.after === after) return hit.remap;
  const remap = remapper(before, after, tx);
  remapCache.set(before, { after, remap });
  return remap;
}

export class DocsStore {
  readonly host: EditorHost;
  ui: DocsUi = {
    track: false,
    author: "Wolf Review",
    editing: null,
    disabled: {},
    notice: null,
    find: { open: false, query: "", replace: "", index: 0, focus: 0 },
    compose: null,
    freshRevisions: [],
  };
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastState: DocState | null;
  /** The host's history array: an apply replaces it, undo/redo/goto keep it. */
  private lastHistory: readonly unknown[] = [];
  private sessions = 0;
  /** Editors closed by opening another one before their typing was committed. */
  private detached: Editing[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: EditorHost) {
    this.host = host;
    this.lastState = host.getSnapshot().state;
    this.lastHistory = host.getSnapshot().history;
    host.subscribe(() => this.onHost());
  }

  // -------------------------------------------------------------------------
  // Observable state
  // -------------------------------------------------------------------------

  set(patch: Partial<DocsUi>): void {
    this.ui = { ...this.ui, ...patch };
    for (const l of [...this.listeners]) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  patchEditing(patch: Partial<Editing>): void {
    if (this.ui.editing) this.set({ editing: { ...this.ui.editing, ...patch } });
  }

  info(text: string): void {
    this.set({ notice: { kind: "info", text } });
  }

  fail(code: string, text: string): void {
    this.set({ notice: { kind: "error", code, text } });
  }

  /** Show a thrown error: typed user/edit errors and kernel refusals with their code, anything else as a plugin failure. */
  report(cause: unknown): void {
    if (cause instanceof UserError) this.fail(cause.code, cause.message);
    else if (cause instanceof KernelRequestError) this.fail(cause.error.code, cause.error.message);
    else this.fail("docs-plugin-failure", String(cause));
  }

  track(): Track | null {
    return this.ui.track ? { author: this.ui.author, created: isoNow() } : null;
  }

  /** View model of the current revision. */
  model(): DocModel | null {
    const state = this.host.getSnapshot().state;
    if (!state || state.format !== "docx") return null;
    return buildModel(state);
  }

  /** The model, or a user error when no DOCX document is open. */
  requireModel(): DocModel {
    const model = this.model();
    if (!model) throw new UserError("docs-no-document", "No DOCX document is open.");
    return model;
  }

  private onHost(): void {
    const snapshot = this.host.getSnapshot();
    const state = snapshot.state;
    if (state === this.lastState) return;
    const before = this.lastState;
    this.lastState = state;
    const historyChanged = snapshot.history !== this.lastHistory;
    this.lastHistory = snapshot.history;
    if (!state || !before || state.doc !== before.doc || state.format !== "docx") {
      this.clearTimer();
      // A notice belongs to the document it was about; refusals (`disabled`) are per module, so they stay for the session.
      this.set({ editing: null, notice: null, freshRevisions: [], find: { ...this.ui.find, index: 0 } });
      return;
    }
    const entry = snapshot.history.find((h) => h.revision === state.revision && h.baseSha256 === before.sha256);
    const replay = !!entry && entry.resultSha256 === state.sha256;
    // A redo replays a recorded transaction (its address map still applies) but is not a new edit.
    const viaApply = replay && historyChanged;
    const remap = cachedRemapper(before, state, replay ? entry!.transaction : null);
    const patch: Partial<DocsUi> = {};
    this.detached = this.detached.flatMap((edit) => {
      const para = remap(edit.para);
      return para ? [{ ...edit, para }] : [];
    });
    const editing = this.ui.editing;
    if (editing) {
      const next = remap(editing.para);
      if (next) patch.editing = { ...editing, para: next };
      else {
        this.clearTimer();
        patch.editing = null;
        patch.notice = {
          kind: "info",
          text: "The paragraph being edited is gone in this revision; the editor closed.",
        };
      }
    }
    if (!viaApply && editing && patch.editing) {
      // Undo/redo/goto: the caret goes to the end of the text that changed.
      const node = this.host.node(patch.editing.para);
      const text = node?.text ?? "";
      const caret =
        text === editing.text
          ? { selStart: Math.min(editing.selStart, text.length), selEnd: Math.min(editing.selEnd, text.length) }
          : (() => {
              const change = changedRange(editing.text, text);
              const at = change.start + change.text.length;
              return { selStart: at, selEnd: at };
            })();
      patch.editing = { ...patch.editing, base: text, text, ...caret, backward: false, upstream: false, goalX: null };
    }
    this.set(patch);
  }

  // -------------------------------------------------------------------------
  // Serial actions
  // -------------------------------------------------------------------------

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Build ops against the current revision and apply them. Resolves null when
   * nothing was applied (no-op, refusal, or user error, all shown as a notice). */
  run(
    label: string,
    build: (model: DocModel) => Plan | null | Promise<Plan | null>,
    options: RunOptions = {},
  ): Promise<Done | null> {
    return this.enqueue(async () => {
      if (options.skipCommit) this.clearTimer();
      else if (this.ui.editing && !(await this.commitNow())) return null;
      return this.applyPlan(label, build, options);
    });
  }

  /** Commit pending typing, then run `work` (no apply) against the current model. */
  task(work: (model: DocModel) => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      if (this.ui.editing && !(await this.commitNow())) return;
      try {
        await work(this.requireModel());
      } catch (cause) {
        this.report(cause);
      }
    });
  }

  private async applyPlan(
    label: string,
    build: (model: DocModel) => Plan | null | Promise<Plan | null>,
    options: RunOptions,
  ): Promise<Done | null> {
    const model = this.model();
    if (!model) return null;
    let plan: Plan | null;
    try {
      plan = await build(model);
    } catch (cause) {
      this.report(cause);
      return null;
    }
    if (!plan || plan.ops.length === 0) return null;
    const before = this.host.getSnapshot().state!;
    const selection = this.host.getSnapshot().selection;
    const result = await this.host.apply(plan.ops, { label, source: SOURCE });
    if (!result.ok) {
      this.refused(result.error, options);
      return null;
    }
    const remap = cachedRemapper(before, result.state, result.transaction);
    const done: Done = { result, before, remap };
    const next = plan.select?.(done) ?? remapAll(remap, selection);
    this.host.select(next);
    if (plan.reveal && next[0]) this.host.reveal({ address: next[0] });
    this.set({ notice: null, freshRevisions: createdRevisions(result.transaction) });
    await plan.after?.(done);
    return done;
  }

  private refused(error: KernelError, options: RunOptions): void {
    const capability = CAPABILITY_CODES[error.code] === true;
    if (options.feature && capability) {
      this.set({ disabled: { ...this.ui.disabled, [options.feature]: error } });
    }
    this.set({ notice: { kind: "error", code: error.code, text: error.message } });
  }

  // -------------------------------------------------------------------------
  // In-place editor
  // -------------------------------------------------------------------------

  startEdit(para: Address, page: number, caret: number | null = null, mode?: Editing["mode"]): void {
    const node = this.host.node(para);
    if (!node || node.kind !== "paragraph") return;
    const old = this.ui.editing;
    if (old && old.text !== old.base) {
      // Keep the previous paragraph's typing: commit it in the queue under its own address.
      this.detached.push(old);
      void this.enqueue(() => this.flushDetached());
    }
    const text = node.text ?? "";
    const at = Math.max(0, Math.min(text.length, caret ?? text.length));
    this.clearTimer();
    this.sessions += 1;
    this.set({
      editing: {
        session: this.sessions,
        para,
        base: text,
        text,
        selStart: at,
        selEnd: at,
        page,
        mode: mode ?? (isReactorKernel(this.host.kernel) ? "caret" : "box"),
        backward: false,
        upstream: false,
        goalX: null,
      },
    });
    this.host.select([para]);
  }

  /** Undo / redo from the caret editor: pending typing is committed first, so undo takes it back. */
  undoRedo(direction: "undo" | "redo"): Promise<void> {
    this.clearTimer();
    return this.enqueue(async () => {
      if (!(await this.commitNow())) return;
      const state = this.host.getSnapshot().state;
      if (direction === "undo" ? state?.canUndo : state?.canRedo)
        await (direction === "undo" ? this.host.undo() : this.host.redo());
      else this.info(direction === "undo" ? "Nothing to undo." : "Nothing to redo.");
    });
  }

  /** Local typing: no engine call until the pause timer, blur or a commit key. */
  input(text: string, selStart: number, selEnd: number): void {
    this.patchEditing({ text, selStart, selEnd });
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.commit(false);
    }, COMMIT_DELAY_MS);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
  }

  /** Send pending typing; `close` also closes the editor (only if it is still the same editor). */
  commit(close: boolean): Promise<boolean> {
    this.clearTimer();
    const session = this.ui.editing?.session;
    return this.enqueue(async () => {
      const ok = await this.commitNow();
      if (ok && close && this.ui.editing?.session === session) this.set({ editing: null });
      return ok;
    });
  }

  cancelEdit(): void {
    this.clearTimer();
    this.set({ editing: null });
  }

  private async flushDetached(): Promise<void> {
    while (this.detached.length > 0) {
      const edit = this.detached.shift()!;
      await this.applyTextEdit(edit);
    }
  }

  /** Apply one editor's pending text. Resolves the stored text, or null on failure. */
  private async applyTextEdit(edit: Editing): Promise<string | null> {
    const model = this.model();
    const para = model?.byId.get(edit.para);
    if (!model || !para) {
      this.fail(
        "docs-edit-target-missing",
        "The edited paragraph is not in the current revision; its typing was not saved.",
      );
      return null;
    }
    const ops = spliceOps(para, edit.base, edit.text, this.track());
    if (!ops) return cleanText(edit.text);
    const result = await this.host.apply(ops, { label: "Type text", source: SOURCE });
    if (!result.ok) {
      this.refused(result.error, {});
      return null;
    }
    this.set({ freshRevisions: createdRevisions(result.transaction) });
    const remap = cachedRemapper(model.state, result.state, result.transaction);
    const now = remap(para.id);
    const viewText = (now && this.host.node(now)?.text) ?? "";
    const typed = cleanText(edit.text);
    // A view text cut with U+2026 that agrees with the typed text stands for the typed text.
    const actual = sameStoredText(viewText, typed) ? typed : viewText;
    if (!this.ui.track && actual !== typed) {
      this.fail(
        "docs-edit-mismatch",
        "The engine stored different text than was typed. The editor now shows the stored text.",
      );
    } else this.set({ notice: null });
    return actual;
  }

  /** Commit the open editor inside the queue. Keeps it open with its caret. */
  private async commitNow(): Promise<boolean> {
    this.clearTimer();
    await this.flushDetached();
    const editing = this.ui.editing;
    if (!editing) return true;
    const sent = editing.text;
    const stored = await this.applyTextEdit(editing);
    if (stored === null) return false;
    // `onHost` already moved `editing.para` to the paragraph's new address.
    const now = this.ui.editing;
    if (!now || now.session !== editing.session) return true;
    const matched = stored === cleanText(sent);
    this.patchEditing(
      matched || this.ui.track
        ? { base: stored, text: now.text === sent ? stored : now.text }
        : {
            base: stored,
            text: stored,
            selStart: Math.min(now.selStart, stored.length),
            selEnd: Math.min(now.selEnd, stored.length),
          },
    );
    this.host.select([now.para]);
    return true;
  }
}

const stores = new WeakMap<EditorHost, DocsStore>();

export function storeFor(host: EditorHost): DocsStore {
  let store = stores.get(host);
  if (!store) stores.set(host, (store = new DocsStore(host)));
  return store;
}

/** Re-render on every store change. */
export function useDocs(host: EditorHost): [DocsStore, DocsUi] {
  const store = storeFor(host);
  const [ui, setUi] = useState(store.ui);
  useEffect(() => {
    setUi(store.ui);
    return store.subscribe(() => setUi(store.ui));
  }, [store]);
  return [store, ui];
}
