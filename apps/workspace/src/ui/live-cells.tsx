/** @jsxImportSource preact */
// Live cells of an XLSX head, for a member: a window of one sheet, a formula bar, and the other members on their
// cells, with no engine in the page. `LiveCellsModel` reads and writes the cells; `LiveCellsView` draws one state of
// it; `LiveCellsStage` follows the room while it is open and keeps the drafts from going with the page unasked.
import { useEffect, useRef, useState } from "preact/hooks";
import type { LiveCell } from "../lib/api.ts";
import {
  a1Of,
  cellRefusal,
  columnName,
  draftAt,
  draftKey,
  editRefusal,
  entryOf,
  type CellContent,
  type CellDraft,
  type LiveCellsModel,
  type LiveCellsState,
  parseA1,
  rangeOf,
  reapplicable,
  shownOf,
  shownSheet,
  valueOfEntry,
  VIEW_COLS,
  VIEW_ROWS,
} from "../lib/live-cells.ts";
import type { DocumentSummary } from "../lib/room-state.ts";
import { FormatPill, plural } from "./common.tsx";

/** The step of each arrow key, as columns and rows. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Text a number format leaves a number as: `1,000`, `8%`, `(12.5)`, `$3`. */
const NUMERIC = /^[-+(]?[$\u20ac\u00a3]?\d[\d,]*(?:\.\d+)?%?\)?$/;

/** Whether a cell reads as a number, so it sits to the right as a spreadsheet puts it. */
function alignsRight(cell: LiveCell | undefined, draft: CellDraft | undefined): boolean {
  const value = draft !== undefined ? valueOfEntry(draft.text) : (cell?.value ?? null);
  if (value === null) return false;
  if ("number" in value) return true;
  return draft === undefined && "formula" in value && cell?.display !== undefined && NUMERIC.test(cell.display.trim());
}

/** A hue of its own for each member, the same on every page. */
function hueOf(id: string): number {
  let hue = 0;
  for (const ch of id) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return hue;
}

/** What the grid is doing, in a word or two. */
function statusOf(state: LiveCellsState): string {
  if (state.phase === "loading") return "Loading the cells";
  if (state.phase === "failed") return "Not loaded";
  if (state.offline) return "Offline";
  if (Object.values(state.drafts).some((d) => d.status === "saving")) return "Saving";
  return state.editable ? "Live" : "Read-only";
}

/** An entry as a notice quotes it. */
const quoted = (text: string): string => (text === "" ? "blank" : text);

/** What a cell holds as a notice quotes it: the entry that puts it there (a formula, not only what it calculates), with
 * the text the server calculated for it when that reads otherwise, as `=B3*8192 (655.36)`. */
function heldOf(content: CellContent | null): string {
  const entry = entryOf(content?.value ?? null);
  if (entry === "") return "blank";
  return content?.display !== undefined && content.display !== entry ? `${entry} (${content.display})` : entry;
}

export type LiveCellsViewProps = {
  model: LiveCellsModel;
  state: LiveCellsState;
  doc: DocumentSummary;
  onClose(): void;
};

/** One state of the live cells of `doc`: the banner with the members on the sheet, the formula bar, what stops a
 * write, and the grid. */
export function LiveCellsView({ model, state, doc, onClose }: LiveCellsViewProps) {
  const grid = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** The address being typed in the address box, or null while it shows the selected cell. */
  const [address, setAddress] = useState<string | null>(null);
  const { origin, selected, sheet } = state;
  const at = parseA1(selected)!;
  const refusal = editRefusal(state);
  const shown = shownSheet(state);
  const drafts = Object.entries(state.drafts);
  /** The key of the selected cell's draft, there or not. */
  const selectedKey = shown === null ? null : draftKey(shown, selected);
  const selectedDraft = draftAt(state, selected);
  const entry = selectedDraft !== undefined ? selectedDraft.text : entryOf(state.cells[selected]?.value ?? null);
  const unsent = drafts.filter(([, d]) => d.status === "unsent").length;
  const conflicts = drafts.filter(([, d]) => d.conflict !== null).sort(([a], [b]) => a.localeCompare(b));
  const peersAt = new Map<string, string[]>();
  for (const peer of state.peers) peersAt.set(peer.a1, [...(peersAt.get(peer.a1) ?? []), peer.name]);

  // Keyboard focus follows the selected cell while it is in the grid.
  useEffect(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.dataset.liveCell === undefined || !grid.current?.contains(active)) return;
    grid.current.querySelector<HTMLElement>(`[data-live-cell="${selected}"]`)?.focus();
  }, [selected, origin]);

  // Both run after the render the model's change asks for, which puts the cell or the entry in place.
  const focusCell = (): void => {
    setTimeout(() => grid.current?.querySelector<HTMLElement>(`[data-live-cell="${model.state.selected}"]`)?.focus(), 0);
  };
  const focusInput = (): void => {
    input.current?.focus();
    setTimeout(() => input.current?.setSelectionRange(input.current.value.length, input.current.value.length), 0);
  };

  const onGridKey = (e: KeyboardEvent): void => {
    if (!(e.target instanceof HTMLElement) || e.target.dataset.liveCell === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = ARROWS[e.key];
    if (step !== undefined) {
      e.preventDefault();
      model.move(step[0], step[1]);
      return;
    }
    switch (e.key) {
      case "PageUp":
      case "PageDown":
        e.preventDefault();
        model.page(0, e.key === "PageUp" ? -1 : 1);
        return;
      case "Home":
        e.preventDefault();
        model.select(a1Of({ col: 0, row: at.row }));
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        focusInput();
        return;
      case "Escape":
        model.revert();
        return;
      case "Delete":
      case "Backspace":
        if (refusal !== null || selectedKey === null) return;
        e.preventDefault();
        model.edit("");
        void model.submit(selectedKey);
        return;
    }
    if (e.key.length === 1 && refusal === null) {
      e.preventDefault();
      model.edit(e.key);
      focusInput();
    }
  };

  const onInputKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (selectedKey !== null) void model.submit(selectedKey);
      focusCell();
    } else if (e.key === "Escape") {
      e.preventDefault();
      model.revert();
      focusCell();
    }
  };

  const onAddressKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (address === null || model.goTo(address)) {
        setAddress(null);
        focusCell();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAddress(null);
      focusCell();
    }
  };

  const rows = Array.from({ length: VIEW_ROWS }, (_, r) => origin.row + r);
  const cols = Array.from({ length: VIEW_COLS }, (_, c) => origin.col + c);
  const place = (row: number, col: number): string => `grid-row:${row - origin.row + 2};grid-column:${col - origin.col + 2}`;
  const loaded = refusal?.kind !== "loading";

  return (
    <main class="stage stage--live" aria-label="Document">
      <div class="banner banner--live" role="region" aria-label="Live cells">
        <div class="banner-text">
          <span class="banner-kicker">Live cells</span>
          <span class="banner-title">
            <FormatPill format={doc.format} />
            <span class="banner-doc" title={doc.name}>
              {doc.name}
            </span>
            <span class="badge">r{state.revision ?? doc.revision}</span>
          </span>
          <span class="banner-meta">
            <span data-testid="live-cells-status" role="status">
              {statusOf(state)}
            </span>
            {drafts.length > 0 ? (
              <span class="dirty" data-testid="live-cells-draft-count">
                {plural(drafts.length, "unsaved cell", "unsaved cells")}
              </span>
            ) : (
              <span data-testid="live-cells-draft-count">No unsaved cells</span>
            )}
          </span>
        </div>
        {state.peers.length === 0 ? (
          <span class="hint">No one else on this sheet</span>
        ) : (
          <ul class="presence" aria-label="Members on this sheet">
            {state.peers.map((peer) => (
              <li key={peer.id} class="presence-item">
                <span class="live-peer-dot" style={`--peer-hue:${hueOf(peer.id)}`} aria-hidden="true" />
                <span>
                  <strong>{peer.name}</strong> on {peer.a1}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div class="banner-actions">
          <button type="button" class="button button--small button--quiet" data-testid="live-cells-close" onClick={onClose}>
            Close live cells
          </button>
        </div>
      </div>
      <div class="live-bar">
        <label class="select live-sheet">
          <span class="visually-hidden">Sheet</span>
          <select
            data-testid="live-cells-sheet"
            value={sheet === null ? "" : String(sheet)}
            disabled={state.sheets.length === 0}
            onChange={(e) => model.setSheet(Number(e.currentTarget.value))}
          >
            {state.sheets.map((s) => {
              const waiting = drafts.filter(([, d]) => d.name === s.name).length;
              return (
                <option key={s.id} value={String(s.id)}>
                  {waiting > 0 ? `${s.name} (${waiting} unsaved)` : s.name}
                </option>
              );
            })}
          </select>
        </label>
        <input
          class="input input--compact input--mono live-address"
          data-testid="live-cells-address"
          aria-label="Cell address"
          aria-invalid={address !== null && parseA1(address) === null}
          spellcheck={false}
          value={address ?? selected}
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={onAddressKey}
          onBlur={() => setAddress(null)}
        />
        <input
          ref={input}
          class="input input--mono live-input"
          data-testid="live-cells-input"
          aria-label={`Entry of ${selected}`}
          spellcheck={false}
          autocomplete="off"
          readOnly={refusal !== null}
          title={refusal?.message}
          placeholder={refusal?.kind === "workbook" ? "Read-only" : undefined}
          value={entry}
          onInput={(e) => model.edit(e.currentTarget.value)}
          onKeyDown={onInputKey}
        />
        <span class="live-pager">
          <span class="live-range">{rangeOf(origin)}</span>
          <button type="button" class="icon-button" aria-label="Previous columns" title="Previous columns" disabled={origin.col === 0} onClick={() => model.page(-1, 0)}>
            {"\u2190"}
          </button>
          <button type="button" class="icon-button" aria-label="Next columns" title="Next columns" onClick={() => model.page(1, 0)}>
            {"\u2192"}
          </button>
          <button type="button" class="icon-button" aria-label="Previous rows" title="Previous rows" disabled={origin.row === 0} onClick={() => model.page(0, -1)}>
            {"\u2191"}
          </button>
          <button type="button" class="icon-button" aria-label="Next rows" title="Next rows" onClick={() => model.page(0, 1)}>
            {"\u2193"}
          </button>
        </span>
      </div>
      {!state.editable ? (
        <div class="notice notice--info stage-notice" role="note" data-testid="live-cells-refusal" data-code={state.refusal?.code}>
          <span>
            Read-only here: {state.refusal?.message ?? "the server does not let anyone write this workbook here."} You can read and select its
            cells; none of them can be written live.
            {drafts.length > 0 ? ` Your ${plural(drafts.length, "unsaved cell stays", "unsaved cells stay")} on this page.` : ""}
          </span>
        </div>
      ) : null}
      {state.offline ? (
        <div class="notice notice--warning stage-notice" role="alert" data-testid="live-cells-offline">
          <span>
            The server is not answering.{" "}
            {unsent > 0
              ? `${plural(unsent, "cell waits", "cells wait")} to be sent, and ${unsent === 1 ? "goes" : "go"} once it answers.`
              : "What you type stays on this page until it answers."}
          </span>
          <button type="button" class="button button--small" data-testid="live-cells-resend" onClick={() => void model.retry()}>
            {unsent > 0 ? "Send again" : "Try again"}
          </button>
        </div>
      ) : state.error !== null ? (
        <div class="notice notice--danger stage-notice" role="alert" data-testid="live-cells-load-error">
          <span>The cells did not load: {state.error}</span>
          <button type="button" class="button button--small" onClick={() => void model.refresh()}>
            Try again
          </button>
        </div>
      ) : null}
      {conflicts.map(([key, draft]) => {
        const conflict = draft.conflict!;
        const here = draft.name === shown;
        const blocked = !state.editable ? (state.refusal?.message ?? "This workbook is read-only here.") : here ? cellRefusal(state, draft.a1) : null;
        const retype = reapplicable(conflict) ? null : "Your entry cannot be reapplied over sheets that changed: keep the current cell, then type it again.";
        const saving = draft.status === "saving";
        return (
          <div
            key={key}
            class="notice notice--warning stage-notice live-conflict"
            role="alert"
            data-testid="live-cells-conflict"
            data-cell={draft.a1}
            data-sheet={draft.name}
          >
            <span>
              <strong>{here ? draft.a1 : `${draft.name}!${draft.a1}`}</strong>: {conflict.message} You entered <code>{quoted(draft.text)}</code>;{" "}
              {conflict.current === undefined ? (
                "reading what it holds now."
              ) : (
                <>
                  it holds <code>{heldOf(conflict.current)}</code> now.
                </>
              )}
              {retype !== null ? ` ${retype}` : ""}
              {draft.error !== null ? ` ${draft.error}` : ""}
            </span>
            <span class="notice-actions">
              <button
                type="button"
                class="button button--small button--quiet"
                data-testid="live-cells-use-current"
                disabled={saving}
                onClick={() => void model.useCurrent(key)}
              >
                Keep current
              </button>
              <button
                type="button"
                class="button button--small"
                data-testid="live-cells-reapply"
                disabled={saving || blocked !== null || retype !== null}
                title={blocked ?? retype ?? undefined}
                onClick={() => void model.reapply(key)}
              >
                {saving ? "Reapplying" : "Reapply mine"}
              </button>
            </span>
          </div>
        );
      })}
      {selectedDraft !== undefined && selectedDraft.conflict === null && selectedDraft.error !== null ? (
        <div class="notice notice--danger stage-notice" role="alert" data-testid="live-cells-error">
          <span>
            {selected}: {selectedDraft.error} Your entry stays here: change it and press Enter, or press Escape to drop it.
          </span>
        </div>
      ) : null}
      {refusal?.kind === "cell" ? (
        <div class="notice notice--info stage-notice" role="note" data-testid="live-cells-locked">
          <span>{refusal.message}</span>
        </div>
      ) : null}
      <div class="live-scroll">
        <div
          ref={grid}
          class={`live-grid${loaded ? "" : " is-loading"}`}
          role="grid"
          aria-label={`${shown ?? "Cells"} ${rangeOf(origin)}`}
          aria-busy={!loaded}
          aria-readonly={!state.editable}
          onKeyDown={onGridKey}
        >
          <div class="live-row" role="row">
            <div class="live-head live-corner" role="columnheader" style="grid-row:1;grid-column:1" />
            {cols.map((col) => (
              <div
                key={`c${col - origin.col}`}
                class={`live-head${col === at.col ? " is-current" : ""}`}
                role="columnheader"
                style={`grid-row:1;grid-column:${col - origin.col + 2}`}
              >
                {columnName(col)}
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <div key={`r${row - origin.row}`} class="live-row" role="row">
              <div class={`live-head${row === at.row ? " is-current" : ""}`} role="rowheader" style={`grid-row:${row - origin.row + 2};grid-column:1`}>
                {row + 1}
              </div>
              {cols.map((col) => {
                const a1 = a1Of({ col, row });
                const cell = state.cells[a1];
                const draft = draftAt(state, a1);
                const locked = loaded ? cellRefusal(state, a1) : null;
                const isSelected = a1 === selected;
                const classes = [
                  "live-cell",
                  isSelected ? "is-selected" : "",
                  alignsRight(cell, draft) ? "is-number" : "",
                  draft !== undefined ? `is-dirty is-${draft.status}` : "",
                  draft?.error ? "is-error" : "",
                  locked !== null ? "is-locked" : "",
                ];
                return (
                  <div
                    key={`${row - origin.row}:${col - origin.col}`}
                    class={classes.filter(Boolean).join(" ")}
                    role="gridcell"
                    tabIndex={isSelected ? 0 : -1}
                    aria-selected={isSelected}
                    aria-readonly={!state.editable || locked !== null}
                    data-live-cell={a1}
                    data-value={cell === undefined ? "" : entryOf(cell.value)}
                    data-dirty={draft !== undefined ? "true" : undefined}
                    data-status={draft?.status}
                    title={draft?.error ?? locked ?? undefined}
                    style={place(row, col)}
                    onClick={() => model.select(a1)}
                    onDblClick={() => {
                      model.select(a1);
                      focusInput();
                    }}
                  >
                    {draft !== undefined ? draft.text : shownOf(cell)}
                  </div>
                );
              })}
              {cols.flatMap((col) => {
                const a1 = a1Of({ col, row });
                const names = peersAt.get(a1);
                if (names === undefined) return [];
                const hue = hueOf(state.peers.find((p) => p.a1 === a1)!.id);
                return [
                  <div key={`p${a1}`} class="live-peer" data-peer-cell={a1} aria-hidden="true" style={`${place(row, col)};--peer-hue:${hue}`}>
                    <span class="live-peer-name">{names.join(", ")}</span>
                  </div>,
                ];
              })}
            </div>
          ))}
        </div>
      </div>
      {state.phase === "loading" ? <p class="stage-status">Loading the cells</p> : null}
    </main>
  );
}

export type LiveCellsStageProps = {
  model: LiveCellsModel;
  doc: DocumentSummary;
  onClose(): void;
};

/** The live cells of `doc` while they are open: read now, whenever the head moves on and on the model's own beat,
 * and closed or left only after the person agrees to drop what was not saved. */
export function LiveCellsStage({ model, doc, onClose }: LiveCellsStageProps) {
  const [state, setState] = useState<LiveCellsState>(model.state);
  const unsaved = Object.keys(state.drafts).length;

  useEffect(() => {
    setState(model.state);
    return model.subscribe(setState);
  }, [model]);

  useEffect(() => model.start(), [model]);

  // The head moved on (a cell written here or by someone else, an edit committed): read the window again.
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
    if (unsaved === 0 || confirm(`Discard ${plural(unsaved, "unsaved cell", "unsaved cells")} of ${doc.name}?`)) onClose();
  };

  return <LiveCellsView model={model} state={state} doc={doc} onClose={close} />;
}
