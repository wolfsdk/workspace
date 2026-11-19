/** @jsxImportSource preact */
// Live slide text of a PPTX head, for a member: the text runs of one shape, each in a field of its own, with no engine
// in the page. `LiveSlideTextModel` reads and writes the runs; `LiveSlideTextView` draws one state of it;
// `LiveSlideTextStage` follows the room while it is open and keeps the drafts from going with the page unasked. A field
// holds the plain text of its run: the run's formatting stays as the deck has it, and is not shown here.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  draftKey,
  editRefusal,
  type LiveSlideTextModel,
  type LiveSlideTextState,
  retypable,
  type RunDraft,
  STRUCTURE_CONFLICT,
} from "../lib/live-slide-text.ts";
import type { DocumentSummary } from "../lib/room-state.ts";
import { EmptyState, FormatPill, plural } from "./common.tsx";

/** What the text is doing, in a word or two. */
function statusOf(state: LiveSlideTextState): string {
  if (state.phase === "loading") return "Loading the text";
  if (state.phase === "failed") return "Not loaded";
  if (state.offline) return "Offline";
  if (Object.values(state.drafts).some((d) => d.status === "saving")) return "Saving";
  return state.editable ? "Live" : "Read-only";
}

/** Text as a notice quotes it. */
const quoted = (text: string): string => (text === "" ? "empty" : text);

export type LiveSlideTextViewProps = {
  model: LiveSlideTextModel;
  state: LiveSlideTextState;
  doc: DocumentSummary;
  onClose(): void;
};

/** One state of the live slide text of `doc`: the banner, the shape on show, what stops a write, the conflicts that
 * wait for the person, and a field for each run of the shape. */
export function LiveSlideTextView({ model, state, doc, onClose }: LiveSlideTextViewProps) {
  const list = useRef<HTMLOListElement>(null);
  const { shape } = state;
  const refusal = editRefusal(state);
  const drafts = Object.entries(state.drafts);
  const unsent = drafts.filter(([, d]) => d.status === "unsent").length;
  const conflicts = drafts.filter(([, d]) => d.conflict !== null).sort(([a], [b]) => a.localeCompare(b));
  const labelOf = (id: string): string => state.shapes.find((s) => s.id === id)?.label ?? id;
  const label = shape === null ? "" : labelOf(shape);
  /** A run as a notice names it: its shape, and its place there while the shape is on show. */
  const runName = (draft: RunDraft): string => {
    const at = draft.shape === shape ? state.runs.findIndex((r) => r.id === draft.run) : -1;
    return `${labelOf(draft.shape)}, ${at < 0 ? draft.run : `run ${at + 1}`}`;
  };

  // Runs after the render the model's change asks for, which puts the run's field in place.
  const focusRun = (run: string): void => {
    setTimeout(() => list.current?.querySelector<HTMLInputElement>(`[data-slide-run="${CSS.escape(run)}"]`)?.focus(), 0);
  };

  const onRunKey = (run: string, e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (shape !== null) void model.submit(draftKey(shape, run));
    } else if (e.key === "Escape") {
      e.preventDefault();
      model.revert(run);
    }
  };

  return (
    <main class="stage stage--live" aria-label="Document">
      <div class="banner banner--live" role="region" aria-label="Live slide text">
        <div class="banner-text">
          <span class="banner-kicker">Live slide text</span>
          <span class="banner-title">
            <FormatPill format={doc.format} />
            <span class="banner-doc" title={doc.name}>
              {doc.name}
            </span>
            <span class="badge">r{state.revision ?? doc.revision}</span>
          </span>
          <span class="banner-meta">
            <span data-testid="live-slide-text-status" role="status">
              {statusOf(state)}
            </span>
            {drafts.length > 0 ? (
              <span class="dirty" data-testid="live-slide-text-draft-count">
                {plural(drafts.length, "unsaved run", "unsaved runs")}
              </span>
            ) : (
              <span data-testid="live-slide-text-draft-count">No unsaved runs</span>
            )}
          </span>
        </div>
        <div class="banner-actions">
          <button type="button" class="button button--small button--quiet" data-testid="live-slide-text-close" onClick={onClose}>
            Close live slide text
          </button>
        </div>
      </div>
      <div class="live-bar">
        <label class="select live-shape">
          <span class="visually-hidden">Shape</span>
          <select
            data-testid="live-slide-text-shape"
            value={shape ?? ""}
            disabled={state.shapes.length === 0}
            onChange={(e) => model.setShape(e.currentTarget.value)}
          >
            {state.shapes.map((s) => {
              const waiting = drafts.filter(([, d]) => d.shape === s.id).length;
              return (
                <option key={s.id} value={s.id}>
                  {waiting > 0 ? `${s.label} (${waiting} unsaved)` : s.label}
                </option>
              );
            })}
          </select>
        </label>
        <span class="live-hint">Each field is the plain text of one run. Its formatting stays as the deck has it and is not shown here.</span>
      </div>
      {!state.editable ? (
        <div class="notice notice--info stage-notice" role="note" data-testid="live-slide-text-refusal" data-code={state.refusal?.code}>
          <span>
            Read-only here: {state.refusal?.message ?? "the server does not let anyone write this deck here."} You can read the text of its shapes;
            none of it can be written live.
            {drafts.length > 0 ? ` Your ${plural(drafts.length, "unsaved run stays", "unsaved runs stay")} on this page.` : ""}
          </span>
        </div>
      ) : null}
      {state.offline ? (
        <div class="notice notice--warning stage-notice" role="alert" data-testid="live-slide-text-offline">
          <span>
            The server is not answering.{" "}
            {unsent > 0
              ? `${plural(unsent, "run waits", "runs wait")} to be sent, and ${unsent === 1 ? "goes" : "go"} once it answers.`
              : "What you type stays on this page until it answers."}
          </span>
          <button type="button" class="button button--small" data-testid="live-slide-text-resend" onClick={() => void model.retry()}>
            {unsent > 0 ? "Send again" : "Try again"}
          </button>
        </div>
      ) : state.error !== null ? (
        <div class="notice notice--danger stage-notice" role="alert" data-testid="live-slide-text-load-error">
          <span>The text did not load: {state.error}</span>
          <button type="button" class="button button--small" onClick={() => void model.refresh()}>
            Try again
          </button>
        </div>
      ) : null}
      {conflicts.map(([key, draft]) => {
        const conflict = draft.conflict!;
        const saving = draft.status === "saving";
        const blocked = !state.editable
          ? (state.refusal?.message ?? "This deck is read-only here.")
          : conflict.code === STRUCTURE_CONFLICT || conflict.current === null
            ? "The runs changed: keep the current text, then type yours again in the run you mean."
            : retypable(conflict)
              ? null
              : "Reading what the run says now.";
        return (
          <div
            key={key}
            class="notice notice--warning stage-notice live-conflict"
            role="alert"
            data-testid="live-slide-text-conflict"
            data-run={draft.run}
            data-shape={draft.shape}
            data-code={conflict.code}
          >
            <span>
              <strong>{runName(draft)}</strong>: {conflict.message} You typed <code data-conflict="mine">{quoted(draft.text)}</code>;{" "}
              {conflict.current === undefined ? (
                "reading what it says now."
              ) : conflict.current === null ? (
                "it is not in the deck any more."
              ) : (
                <>
                  it says <code data-conflict="current">{quoted(conflict.current)}</code> now.
                </>
              )}
              {conflict.code === STRUCTURE_CONFLICT ? " Keep the current text, then type yours again in the run you mean." : ""}
              {draft.error !== null ? ` ${draft.error}` : ""}
            </span>
            <span class="notice-actions">
              <button
                type="button"
                class="button button--small button--quiet"
                data-testid="live-slide-text-use-current"
                disabled={saving}
                onClick={() => void model.useCurrent(key)}
              >
                Keep current
              </button>
              <button
                type="button"
                class="button button--small"
                data-testid="live-slide-text-retype"
                disabled={saving || blocked !== null}
                title={blocked ?? "Put the current text in the run's field, with yours beside it, to type yours again over it"}
                onClick={() => {
                  model.retype(key);
                  focusRun(draft.run);
                }}
              >
                Type mine again
              </button>
            </span>
          </div>
        );
      })}
      <div class="live-scroll">
        {state.loaded && shape === null ? (
          <div class="stage-empty">
            <EmptyState title="No text to write live">
              <p>No shape of {doc.name} has text that can be written run by run here.</p>
            </EmptyState>
          </div>
        ) : (
          <ol ref={list} class={`slide-runs${state.loaded ? "" : " is-loading"}`} aria-label={`Text runs of ${label}`} aria-busy={!state.loaded}>
            {shape === null
              ? null
              : state.runs.map((run, i) => {
                  const key = draftKey(shape, run.id);
                  const draft = state.drafts[key];
                  const status = draft?.status;
                  const sendable = refusal === null && (status === "editing" || status === "unsent");
                  const classes = ["slide-run", draft !== undefined ? `is-dirty is-${status}` : "", draft?.error ? "is-error" : ""];
                  return (
                    <li key={run.id} class={classes.filter(Boolean).join(" ")}>
                      <span class="slide-run-name" aria-hidden="true">
                        Run {i + 1}
                      </span>
                      <input
                        class="input slide-run-input"
                        data-testid="live-slide-text-run"
                        data-slide-run={run.id}
                        data-current={run.text}
                        data-dirty={draft !== undefined ? "true" : undefined}
                        data-status={status}
                        aria-label={`Run ${i + 1} of ${label}`}
                        aria-invalid={draft?.error ? true : undefined}
                        autocomplete="off"
                        readOnly={refusal !== null || status === "conflict"}
                        title={refusal?.message ?? (status === "conflict" ? "Choose in the notice what this run keeps" : undefined)}
                        value={draft?.text ?? run.text}
                        onInput={(e) => model.edit(run.id, e.currentTarget.value)}
                        onKeyDown={(e) => onRunKey(run.id, e)}
                      />
                      <button
                        type="button"
                        class="button button--small"
                        data-testid="live-slide-text-save"
                        data-run={run.id}
                        disabled={!sendable}
                        onClick={() => void model.submit(key)}
                      >
                        {status === "saving" ? "Saving" : "Save"}
                      </button>
                      {draft !== undefined && draft.earlier !== null && draft.conflict === null ? (
                        <p class="slide-run-note" data-testid="live-slide-text-earlier">
                          You had typed <code>{quoted(draft.earlier)}</code> before the run changed to <code>{quoted(draft.expected)}</code>. Type yours again
                          over it and press Enter, or press Escape to keep the run as it is.
                        </p>
                      ) : null}
                      {draft !== undefined && draft.conflict === null && draft.error !== null ? (
                        <p class="slide-run-note is-error" role="alert" data-testid="live-slide-text-error">
                          {draft.error} Your text stays here: change it and press Enter, or press Escape to drop it.
                        </p>
                      ) : null}
                    </li>
                  );
                })}
          </ol>
        )}
      </div>
      {state.phase === "loading" ? <p class="stage-status">Loading the text</p> : null}
    </main>
  );
}

export type LiveSlideTextStageProps = {
  model: LiveSlideTextModel;
  doc: DocumentSummary;
  onClose(): void;
};

/** The live slide text of `doc` while it is open: read now, whenever the head moves on and on the model's own beat,
 * and closed or left only after the person agrees to drop what was not saved. */
export function LiveSlideTextStage({ model, doc, onClose }: LiveSlideTextStageProps) {
  const [state, setState] = useState<LiveSlideTextState>(model.state);
  const unsaved = Object.keys(state.drafts).length;

  useEffect(() => {
    setState(model.state);
    return model.subscribe(setState);
  }, [model]);

  useEffect(() => model.start(), [model]);

  // The head moved on (a run written here or by someone else, an edit committed): read the shape again.
  useEffect(() => {
    void model.refresh();
  }, [model, doc.revision]);

  useEffect(() => {
    if (unsaved === 0) return;
    const guard = (e: BeforeUnloadEvent): void => e.preventDefault();
    addEventListener("beforeunload", guard);
    return () => removeEventListener("beforeunload", guard);
  }, [unsaved > 0]);

  const close = (): void => {
    if (unsaved === 0 || confirm(`Discard ${plural(unsaved, "unsaved run", "unsaved runs")} of ${doc.name}?`)) onClose();
  };

  return <LiveSlideTextView model={model} state={state} doc={doc} onClose={close} />;
}
