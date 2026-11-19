// Live slide text of a PPTX head, for a member in the browser: the text runs of one shape read over HTTP (`GET
// /api/rooms/<room>/docs/<doc>/live-slide-text?shape=`), a draft for each run the person typed in, and each draft
// written on its own over the text and revision of the read it was typed on (`PUT`). Two people may write two runs of
// one shape from the same read. The server refuses a write whose run was written since that read, even back to the
// same text (409 `RUN_CONFLICT`), or whose shape's runs changed (`STRUCTURE_CONFLICT`); a later read that finds the
// run's text changed under a draft says the same before anything is sent. Either way the draft stays beside the text
// that won, and the person keeps the current text or types theirs again over it: nothing here writes a draft over text
// the person was not shown. A run keeps its formatting in the deck; the page reads and sends its plain text only, and
// runs no engine.
import { ApiError, type LiveRefusal, type LiveSlideRun, type LiveSlideShape, type LiveSlideText, type WorkspaceApi } from "./api.ts";
import { follow } from "./live-follow.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const RUN_CONFLICT = "RUN_CONFLICT";
export const STRUCTURE_CONFLICT = "STRUCTURE_CONFLICT";
/** A read of a shape that is not in the deck any more (or may no longer be read so). */
const UNKNOWN_SHAPE = "UNKNOWN_SHAPE";

/** The key of a draft: the native ids of its shape and its run. */
export const draftKey = (shape: string, run: string): string => `${shape}\n${run}`;

/** - `editing`: typed and not sent.
 * - `saving`: sent, and not answered yet.
 * - `unsent`: sent while the server did not answer; it goes again once the server answers.
 * - `conflict`: the run or its shape moved on since the read it was typed on; it waits for the person's choice. */
export type DraftStatus = "editing" | "saving" | "unsent" | "conflict";

/** Why a draft cannot go as it is. `local` is a conflict a read found before anything was sent. `current` is the
 * text of the run as the newest read of its shape found it, null when the run or its shape is gone, and undefined
 * until such a read answers; `at` is the revision of that read. */
export type RunConflict = { code: string; message: string; local: boolean; current?: string | null; at?: number };

/** What a person typed in one run, with the run's text in the read they typed it on and that read's revision: the
 * write sends both, so the server can tell whether anything else wrote the run in between. */
export type RunDraft = {
  shape: string;
  run: string;
  text: string;
  expected: string;
  revision: number;
  status: DraftStatus;
  conflict: RunConflict | null;
  /** The last refusal of the draft other than a conflict: text or a run the server does not take. */
  error: string | null;
  /** The text of a draft that lost a conflict, kept on show while the person types theirs again over the text that
   * won; null for any other draft. */
  earlier: string | null;
};

/** What the page shows.
 * - `phase`: `loading` until the first read, `failed` when it did not come, then `ready`.
 * - `error`: why the last read was refused; `offline`: the server did not answer the last call.
 * - `editable` false, with the server's `refusal`: the deck is read, but no run of it may be written here.
 * - `shapes`: the shapes that may be read; `shape`: the one on show (null before the first read, and for a deck with
 *   none); `runs`: its runs, from the last read; `loaded`: that read was of `shape`.
 * - `drafts`: every unsaved run of the deck, by `draftKey`, of this shape or another. */
export type LiveSlideTextState = {
  phase: "loading" | "ready" | "failed";
  error: string | null;
  offline: boolean;
  editable: boolean;
  refusal: LiveRefusal | null;
  revision: number | null;
  shapes: readonly LiveSlideShape[];
  shape: string | null;
  runs: readonly LiveSlideRun[];
  loaded: boolean;
  drafts: Readonly<Record<string, RunDraft>>;
};

export const LIVE_SLIDE_TEXT_LOADING: LiveSlideTextState = {
  phase: "loading",
  error: null,
  offline: false,
  editable: true,
  refusal: null,
  revision: null,
  shapes: [],
  shape: null,
  runs: [],
  loaded: false,
  drafts: {},
};

/** Why no run on show may be typed in now, or null when one may: the shape on show has not been read yet (`loading`),
 * or the deck may not be written here (`deck`, the server's refusal says why). */
export function editRefusal(state: LiveSlideTextState): { kind: "loading" | "deck"; message: string } | null {
  if (state.phase !== "ready" || !state.loaded) return { kind: "loading", message: "The text has not loaded yet." };
  if (!state.editable) return { kind: "deck", message: state.refusal?.message ?? "The server does not let anyone write this deck here." };
  if (state.shape === null) return { kind: "deck", message: "No shape of this deck has text that can be written live." };
  return null;
}

/** Whether the person may type a draft in `conflict` again over the text that won: once a read has shown that text,
 * and not over runs of the shape that changed, where the same id may be another run. */
export const retypable = (conflict: RunConflict): boolean =>
  conflict.code !== STRUCTURE_CONFLICT && typeof conflict.current === "string" && conflict.at !== undefined;

/** The live text of one PPTX document in one room, for one member. It holds the runs of the shape on show, the drafts
 * and the state of the connection, and tells every listener of each change. Nothing here writes a run the person did
 * not send (Enter, Save), and nothing sends a draft over a run that moved on. */
export class LiveSlideTextModel {
  readonly #api: WorkspaceApi;
  readonly #roomId: string;
  readonly #doc: string;
  readonly #listeners = new Set<(state: LiveSlideTextState) => void>();
  #state: LiveSlideTextState = LIVE_SLIDE_TEXT_LOADING;
  /** Reads are numbered; an answer older than one already shown is dropped. */
  #issued = 0;
  #applied = 0;
  #reading = 0;
  /** Reads in a row the server did not answer: the poll waits longer after each. */
  #failures = 0;

  constructor(api: WorkspaceApi, roomId: string, doc: string) {
    this.#api = api;
    this.#roomId = roomId;
    this.#doc = doc;
  }

  get state(): LiveSlideTextState {
    return this.#state;
  }

  /** Listen to every new state; returns the unsubscribe. */
  subscribe(listener: (state: LiveSlideTextState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #set(next: Partial<LiveSlideTextState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /** Change one draft (`null` drops it). A draft that is gone stays gone. */
  #draft(key: string, patch: Partial<RunDraft> | null): void {
    const current = this.#state.drafts[key];
    if (current === undefined) return;
    const drafts = { ...this.#state.drafts };
    if (patch === null) delete drafts[key];
    else drafts[key] = { ...current, ...patch };
    this.#set({ drafts });
  }

  /** Read the shape on show again (the first shape the server offers before any read). An answer for a shape the page
   * has left, or older than what it shows, changes nothing. */
  async refresh(): Promise<void> {
    const asked = this.#state.shape;
    const token = ++this.#issued;
    this.#reading++;
    try {
      const read = await this.#api.liveSlideText(this.#roomId, this.#doc, asked);
      const now = this.#state;
      if (token < this.#applied || now.shape !== asked || (now.revision !== null && read.revision < now.revision)) return;
      this.#applied = token;
      this.#failures = 0;
      const wasOffline = now.offline;
      this.#apply(read);
      if (wasOffline) await this.resendUnsent();
    } catch (e) {
      if (token < this.#applied) return;
      const phase = this.#state.phase === "ready" ? "ready" : "failed";
      if (e instanceof ApiError && e.code === UNKNOWN_SHAPE && asked !== null) {
        if (this.#state.shape !== asked) return;
        // The shape is gone: what was typed in it waits for the person, and the page shows the first shape there is.
        this.#applied = token;
        this.#failures = 0;
        const at = this.#state.revision ?? 0;
        const drafts = { ...this.#state.drafts };
        for (const [key, draft] of Object.entries(drafts)) {
          if (draft.shape === asked) drafts[key] = afterRead(draft, null, at)!;
        }
        this.#set({ shape: null, runs: [], loaded: false, drafts });
        await this.refresh();
      } else if (e instanceof ApiError) {
        this.#set({ phase, error: e.message });
      } else {
        this.#failures++;
        this.#set({ phase, offline: true, error: phase === "failed" ? message(e) : this.#state.error });
      }
    } finally {
      this.#reading--;
    }
  }

  #apply(read: LiveSlideText): void {
    const drafts = { ...this.#state.drafts };
    if (read.shape !== null) {
      const texts = new Map(read.runs.map((run) => [run.id, run.text]));
      for (const [key, draft] of Object.entries(drafts)) {
        if (draft.shape !== read.shape) continue;
        const after = afterRead(draft, texts.get(draft.run) ?? null, read.revision);
        if (after === null) delete drafts[key];
        else drafts[key] = after;
      }
    }
    this.#set({
      phase: "ready",
      error: null,
      offline: false,
      editable: read.editable !== false,
      refusal: read.editable === false ? (read.refusal ?? null) : null,
      revision: read.revision,
      shapes: read.shapes,
      shape: read.shape,
      runs: read.runs,
      loaded: true,
      drafts,
    });
  }

  /** Show another shape. Drafts of every shape stay. */
  setShape(id: string): void {
    if (id === this.#state.shape || !this.#state.shapes.some((s) => s.id === id)) return;
    this.#set({ shape: id, runs: [], loaded: false });
    void this.refresh();
  }

  /** The person typed `text` in the run `run` of the shape on show. The first keystroke starts a draft over the text
   * the last read found in the run; a draft in conflict takes no keystroke until the person chooses. */
  edit(run: string, text: string): void {
    const { shape, runs, drafts, revision } = this.#state;
    if (editRefusal(this.#state) !== null || shape === null || revision === null) return;
    const found = runs.find((r) => r.id === run);
    if (found === undefined) return;
    const key = draftKey(shape, run);
    const draft = drafts[key];
    if (draft !== undefined) {
      if (draft.status !== "conflict") this.#draft(key, { text, error: null });
      return;
    }
    this.#set({ drafts: { ...drafts, [key]: { shape, run, text, expected: found.text, revision, status: "editing", conflict: null, error: null, earlier: null } } });
  }

  /** Drop the draft of a run of the shape on show, as Escape does; one in conflict waits for the person's choice. */
  revert(run: string): void {
    const { shape } = this.#state;
    if (shape === null) return;
    const key = draftKey(shape, run);
    const status = this.#state.drafts[key]?.status;
    if (status === "editing" || status === "unsent") this.#draft(key, null);
  }

  /** Send a draft, by its `draftKey`, as Enter or Save does. A draft in conflict or on its way is left as it is. */
  async submit(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined || draft.status === "saving" || draft.status === "conflict" || !this.#state.editable) return;
    if (draft.text === draft.expected) {
      this.#draft(key, null);
      return;
    }
    const { text } = draft;
    this.#draft(key, { status: "saving", error: null });
    let revision: number;
    try {
      revision = await this.#api.writeLiveSlideRun(this.#roomId, this.#doc, { revision: draft.revision, target: draft.run, expected: draft.expected, text });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        this.#draft(key, { status: "conflict", conflict: { code: e.code, message: e.message, local: false } });
        await this.#inspect(key);
      } else if (e instanceof ApiError && (e.status === 402 || e.status === 403)) {
        this.#draft(key, { status: "editing" });
        this.#set({ editable: false, refusal: { code: e.code, message: e.message } });
      } else if (e instanceof ApiError) {
        this.#draft(key, { status: "editing", error: e.message });
      } else {
        this.#draft(key, { status: "unsent" });
        this.#set({ offline: true });
      }
      return;
    }
    this.#set({ offline: false });
    // What the person typed on while it was sent stays a draft, a new one over the text that landed.
    if (this.#state.drafts[key]?.text !== text) {
      this.#draft(key, { status: "editing", expected: text, revision, earlier: null });
      await this.refresh();
      return;
    }
    // The draft stays on show until the read after the write has the run as written.
    await this.refresh();
    if (this.#state.drafts[key]?.text !== text) return;
    const now = this.#state;
    if (now.shape === draft.shape && (now.revision ?? 0) < revision) this.#set({ runs: now.runs.map((r) => (r.id === draft.run ? { ...r, text } : r)) });
    this.#draft(key, null);
  }

  /** Read what the run of a draft in conflict says now, for its notice: the shape on show is read again, another shape
   * on its own. */
  async #inspect(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined) return;
    if (draft.shape === this.#state.shape) {
      await this.refresh();
      return;
    }
    try {
      const read = await this.#api.liveSlideText(this.#roomId, this.#doc, draft.shape);
      const now = this.#state.drafts[key];
      if (now === undefined || read.shape !== draft.shape) return;
      const after = afterRead(now, read.runs.find((r) => r.id === draft.run)?.text ?? null, read.revision);
      this.#draft(key, after);
    } catch (e) {
      const now = this.#state.drafts[key];
      if (e instanceof ApiError && e.code === UNKNOWN_SHAPE) {
        if (now !== undefined) this.#draft(key, afterRead(now, null, this.#state.revision ?? 0));
      } else if (e instanceof ApiError) {
        this.#draft(key, { error: e.message });
      } else {
        this.#set({ offline: true });
      }
    }
  }

  /** Drop a draft, by its `draftKey`, in favour of what the run says now. */
  async useCurrent(key: string): Promise<void> {
    const draft = this.#state.drafts[key];
    if (draft === undefined || draft.status === "saving") return;
    this.#draft(key, null);
    if (draft.shape === this.#state.shape) await this.refresh();
  }

  /** Begin a draft in `conflict` again, by its `draftKey`, over the text that won: the run's input holds that text, at
   * the revision of the read that showed it, and what the person had typed stays on show beside it as `earlier`. Only
   * what they type and send from there is written. Over runs of a shape that changed, or before a read has shown the
   * text that won, this does nothing. */
  retype(key: string): void {
    const draft = this.#state.drafts[key];
    const conflict = draft?.conflict;
    if (draft?.status !== "conflict" || conflict === null || conflict === undefined || !retypable(conflict) || !this.#state.editable) return;
    const current = conflict.current!;
    this.#draft(key, { status: "editing", text: current, expected: current, revision: conflict.at!, conflict: null, error: null, earlier: draft.text });
    this.setShape(draft.shape);
  }

  /** Send again every draft the server did not answer. */
  async resendUnsent(): Promise<void> {
    for (const [key, draft] of Object.entries(this.#state.drafts)) {
      if (draft.status === "unsent") await this.submit(key);
    }
  }

  /** Try the server again: read the shape, then send what did not go. */
  async retry(): Promise<void> {
    await this.refresh();
    if (!this.#state.offline) await this.resendUnsent();
  }

  /** Follow the room while the text is open (see `follow`). Returns the stop. */
  start(): () => void {
    return follow({
      tick: () => {
        if (this.#reading === 0) void this.refresh();
      },
      failures: () => this.#failures,
      online: () => void this.retry(),
      offline: () => this.#set({ offline: true }),
      shown: () => void this.refresh(),
    });
  }
}

/** A draft after a read at `at` found `current` in its run (null: no such run, or no such shape): the same draft, a
 * draft in conflict showing that text, or null when the run already says what the person typed and there is nothing
 * left to choose. A draft on its way is the write's to settle. */
function afterRead(draft: RunDraft, current: string | null, at: number): RunDraft | null {
  if (draft.status === "saving") return draft;
  if (current === draft.text && current !== draft.expected) return null;
  if (draft.conflict !== null) {
    if (draft.conflict.at !== undefined && at < draft.conflict.at) return draft;
    return { ...draft, conflict: { ...draft.conflict, current, at } };
  }
  if (current === draft.expected) return draft;
  const why =
    current === null
      ? { code: STRUCTURE_CONFLICT, message: "The run is not in the deck any more." }
      : { code: RUN_CONFLICT, message: "The run changed after you began editing it." };
  return { ...draft, status: "conflict", conflict: { ...why, local: true, current, at } };
}
