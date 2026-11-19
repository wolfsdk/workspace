/**
 * Main view of a workbook in the review plugin: the sheets of the open revision as a read-only
 * grid, with every cell the reviewed change sets touched outlined and tagged with its change
 * type as a changed paragraph is on a page (the selected change's outline ringed), filled by the
 * reviewer's decision on it, and a toggle to the engine's printed pages (the shell's page view,
 * passed in as `pages`).
 *
 * It reads `sheet_viewport` windows from the reactor kernel and holds no editing state, so it
 * stays in the review entry; the sheets plugin (toolbar, menus, in-cell editor) is a lazy chunk
 * this file never imports.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isReactorKernel, type SheetViewport } from "@wolfsdk/protocol";
import { useEditor, type MainViewProps } from "../host/index.ts";
import { useReview } from "./hooks.ts";
import {
  COL_CAP,
  COL_HEADER_PX,
  DEFAULT_SHEET_VIEW,
  ROW_CAP,
  ROW_HEADER_PX,
  VIEW_LABELS,
  cellAddress,
  cellAt,
  cellBoxes,
  cellKey,
  cellOutlines,
  cellRect,
  changedCells,
  layoutOf,
  numToCol,
  parseCellAddress,
  revealOffset,
  selectedCellKey,
  sheetMarks,
  sheetTabs,
  usedExtent,
  windowFor,
  type CellAddress,
  type ChangedCell,
  type SheetViewMode,
} from "./sheetReview.ts";

/** One `sheet_viewport` read: the request it answers (`key`) and its reply or failure. */
type Read = { key: string; sheet: string; reply: SheetViewport | null; error: string | null };

const NO_READ: Read = { key: "", sheet: "", reply: null, error: null };

const DECISION_WORDS = { approve: "approved", reject: "rejected", pending: "undecided" } as const;

export function SheetReviewView({ host, pages }: MainViewProps) {
  const snap = useEditor(host);
  const store = useReview(host);
  const state = snap.state;
  const kernel = isReactorKernel(host.kernel) ? host.kernel : null;
  const [view, setView] = useState<SheetViewMode>(DEFAULT_SHEET_VIEW);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [more, setMore] = useState(0);
  const [focus, setFocus] = useState<CellAddress | null>(null);
  const [read, setRead] = useState<Read>(NO_READ);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const tabs = useMemo(() => sheetTabs(state?.nodes ?? []), [state?.nodes]);
  const sheet = tabs.find((t) => t.sheetId === activeId) ?? tabs[0] ?? null;
  const changed = useMemo(() => changedCells(store), [store, store.version, snap.history]);
  const marks = useMemo(() => sheetMarks(changed), [changed]);
  const onSheet = useMemo(() => [...changed.values()].filter((c) => c.sheetId === sheet?.sheetId), [changed, sheet?.sheetId]);

  const readWindow = windowFor(null, onSheet, more);
  const key = state && sheet ? `${state.doc}:${state.revision}:${state.sha256}:${sheet.name}:${readWindow.rows}x${readWindow.cols}` : "";

  // Read the active sheet of the shown revision. A reply for another request is dropped.
  useEffect(() => {
    if (view !== "grid" || !kernel || !state || !sheet) return;
    let live = true;
    const name = sheet.name;
    kernel.sheetViewport(state.doc, name, 1, 1, readWindow.rows, readWindow.cols).then(
      (reply) => {
        if (live) setRead({ key, sheet: name, reply, error: null });
      },
      (cause: unknown) => {
        if (live) setRead({ key, sheet: name, reply: null, error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => {
      live = false;
    };
  }, [view, kernel, key]);

  // The host's selection and reveal requests (the changes panel, the keyboard) move the grid's focus and sheet.
  const selected = snap.selection[0] ?? null;
  const revealed = snap.reveal && "address" in snap.reveal ? snap.reveal.address : null;
  const goTo = (address: string | null) => {
    const cell = address ? parseCellAddress(address) : null;
    if (!cell) return;
    setFocus(cell);
    if (cell.sheetId !== sheet?.sheetId && tabs.some((t) => t.sheetId === cell.sheetId)) {
      setActiveId(cell.sheetId);
      setMore(0);
    }
  };
  useEffect(() => goTo(selected), [selected]);
  useEffect(() => goTo(revealed), [snap.reveal?.seq]);

  // A reply of the sheet shown stays up while the next one loads; one of another sheet does not.
  const reply = read.sheet === sheet?.name ? read.reply : null;
  const model = useMemo(() => {
    if (!reply) return null;
    const win = windowFor(usedExtent(reply.used_range), onSheet, more);
    const layout = layoutOf(reply, win.rows, win.cols);
    return { win, layout, boxes: cellBoxes(reply, layout, win.rows, win.cols, onSheet) };
  }, [reply, onSheet, more]);

  // The change selected in the changes panel (or by a click on its cell) rings its cell's outline.
  const selectedChange = store.ui.selectedChange;
  const selectedKey = useMemo(() => selectedCellKey(store.history(), selectedChange), [store, store.version, snap.history, selectedChange]);
  const outlines = useMemo(
    () => (model && sheet ? cellOutlines(model.boxes, changed, sheet.sheetId, selectedKey, [model.layout.width, model.layout.height]) : []),
    [model, changed, sheet?.sheetId, selectedKey],
  );

  // Bring the focused cell into view once its sheet is drawn.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !model || !focus || focus.sheetId !== sheet?.sheetId) return;
    const cell = cellRect(model.layout, focus.row, focus.col);
    const target = { ...cell, x: cell.x + ROW_HEADER_PX, y: cell.y + COL_HEADER_PX };
    const next = revealOffset(
      target,
      { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight },
      { x: ROW_HEADER_PX, y: COL_HEADER_PX },
    );
    if (next.left !== el.scrollLeft || next.top !== el.scrollTop) el.scrollTo(next.left, next.top);
  }, [model, focus, sheet?.sheetId]);

  const pick = (event: MouseEvent) => {
    const el = body.current;
    if (!el || !model || !sheet) return;
    // The sticky row headers float over the scrolled cells; a click on them picks nothing.
    if (event.target instanceof Element && event.target.closest(".we-rv-sheet-rowheads")) return;
    // A click on a changed cell's outline or tag picks that cell, even where the tag lies over another.
    const outline = event.target instanceof Element ? event.target.closest<HTMLElement>(".we-rv-sheet-outline") : null;
    const box = el.getBoundingClientRect();
    const at = outline?.dataset.cell ? parseCellAddress(cellAddress(sheet.sheetId, outline.dataset.cell)) : null;
    const hit = at ?? cellAt(model.layout, event.clientX - box.left - ROW_HEADER_PX, event.clientY - box.top);
    if (!hit) return;
    const a1 = `${numToCol(hit.col)}${hit.row}`;
    setFocus({ sheetId: sheet.sheetId, a1, row: hit.row, col: hit.col });
    const target = changed.get(cellKey(sheet.sheetId, a1));
    if (target) {
      void store.selectChange(target.entry, target.index);
      return;
    }
    const address = cellAddress(sheet.sheetId, a1);
    if (host.node(address)) host.select([address]);
  };

  const focusBox = focus && focus.sheetId === sheet?.sheetId && model ? model.boxes.find((b) => b.a1 === focus.a1) : undefined;
  const focusText = focusBox ? (focusBox.formula ?? focusBox.text) : "";
  const focusLabel = focus ? `${tabs.find((t) => t.sheetId === focus.sheetId)?.name ?? ""}!${focus.a1}` : "";
  const counts = { approve: 0, reject: 0, pending: 0 };
  for (const cell of onSheet) counts[cell.decision]++;
  const grid = kernel !== null && view === "grid";

  return (
    <div class="we-rv-sheet" data-testid="review-sheet">
      <div class="we-rv-sheet-head">
        <div class="we-rv-sheet-toggle" role="group" aria-label="Workbook view">
          {(["grid", "pages"] as const).map((mode) => (
            <button
              type="button"
              class="we-btn"
              key={mode}
              aria-pressed={(grid ? "grid" : "pages") === mode}
              data-testid={`review-sheet-${mode}`}
              onClick={() => setView(mode)}
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>
        {grid && (
          <>
            <span class="we-rv-sheet-ref" data-testid="review-sheet-ref" title="Selected cell">
              {focusLabel}
            </span>
            <span class="we-rv-sheet-text" data-testid="review-sheet-text" title={focusText}>
              {focusText}
            </span>
            <span class="we-rv-sheet-legend" aria-label="Changed cells on this sheet">
              {(["pending", "approve", "reject"] as const).map(
                (decision) =>
                  counts[decision] > 0 && (
                    <span class={`we-rv-sheet-chip we-rv-d-${decision}`} key={decision} data-testid={`review-sheet-count-${decision}`}>
                      {counts[decision]} {DECISION_WORDS[decision]}
                    </span>
                  ),
              )}
            </span>
          </>
        )}
      </div>
      {!grid ? (
        <div class="we-rv-sheet-pages" data-testid="review-sheet-pages-view">
          {view === "grid" && (
            <p class="we-rv-sheet-note" role="status">
              The sheet grid needs the reactor engine; showing the printed pages instead.
            </p>
          )}
          {pages}
        </div>
      ) : (
        <>
          <div class="we-rv-sheet-main">
            {read.error !== null && read.sheet === sheet?.name && (
              <p class="we-rv-sheet-note we-rv-sheet-note--error" role="alert" data-testid="review-sheet-error">
                The sheet could not be read: {read.error}
              </p>
            )}
            {model && reply ? (
              <div class="we-rv-sheet-scroll" ref={scroller} aria-busy={read.key !== key} data-testid="review-sheet-cells">
                <div class="we-rv-sheet-colheads" style={{ width: `${ROW_HEADER_PX + model.layout.width}px`, height: `${COL_HEADER_PX}px` }}>
                  <div class="we-rv-sheet-corner" style={{ width: `${ROW_HEADER_PX}px`, height: `${COL_HEADER_PX}px` }} />
                  {Array.from({ length: model.win.cols }, (_, i) => {
                    const w = model.layout.colX[i + 1]! - model.layout.colX[i]!;
                    return w > 0 ? (
                      <div
                        class={`we-rv-sheet-head-cell${focus?.col === i + 1 && focus.sheetId === sheet?.sheetId ? " we-rv-sheet-head-cell--on" : ""}`}
                        key={i}
                        style={{ left: `${ROW_HEADER_PX + model.layout.colX[i]!}px`, width: `${w}px`, height: `${COL_HEADER_PX}px` }}
                      >
                        {numToCol(i + 1)}
                      </div>
                    ) : null;
                  })}
                </div>
                <div
                  class="we-rv-sheet-body"
                  ref={body}
                  style={{ width: `${ROW_HEADER_PX + model.layout.width}px`, height: `${model.layout.height}px` }}
                  onClick={pick}
                >
                  <div class="we-rv-sheet-rowheads" style={{ width: `${ROW_HEADER_PX}px`, height: `${model.layout.height}px` }}>
                    {Array.from({ length: model.win.rows }, (_, i) => {
                      const h = model.layout.rowY[i + 1]! - model.layout.rowY[i]!;
                      return h > 0 ? (
                        <div
                          class={`we-rv-sheet-head-cell${focus?.row === i + 1 && focus.sheetId === sheet?.sheetId ? " we-rv-sheet-head-cell--on" : ""}`}
                          key={i}
                          style={{ top: `${model.layout.rowY[i]!}px`, height: `${h}px`, width: `${ROW_HEADER_PX}px` }}
                        >
                          {i + 1}
                        </div>
                      ) : null;
                    })}
                  </div>
                  {model.layout.colX.slice(1).map((x, i) => (
                    <div class="we-rv-sheet-vline" key={`v${i}`} style={{ left: `${ROW_HEADER_PX + x}px` }} />
                  ))}
                  {model.layout.rowY.slice(1).map((y, i) => (
                    <div class="we-rv-sheet-hline" key={`h${i}`} style={{ top: `${y}px`, left: `${ROW_HEADER_PX}px` }} />
                  ))}
                  {model.boxes.map((box) => {
                    const hit: ChangedCell | undefined = sheet ? changed.get(cellKey(sheet.sheetId, box.a1)) : undefined;
                    const style: Record<string, string> = {
                      left: `${ROW_HEADER_PX + box.x}px`,
                      top: `${box.y}px`,
                      width: `${box.w}px`,
                      height: `${box.h}px`,
                    };
                    if (box.fill) style.background = box.fill;
                    if (box.color) style.color = box.color;
                    if (box.bold) style.fontWeight = "700";
                    if (box.italic) style.fontStyle = "italic";
                    const cls = `we-rv-sheet-cell we-rv-sheet-cell--${box.align}${hit ? ` we-rv-sheet-cell--changed we-rv-d-${hit.decision}` : ""}${
                      focus?.a1 === box.a1 && focus.sheetId === sheet?.sheetId ? " we-rv-sheet-cell--focus" : ""
                    }`;
                    return (
                      <div
                        class={cls}
                        key={box.a1}
                        style={style}
                        data-cell={box.a1}
                        data-decision={hit?.decision}
                        title={hit ? `${box.a1}: ${hit.change}, ${DECISION_WORDS[hit.decision]} change` : box.a1}
                      >
                        {box.text}
                      </div>
                    );
                  })}
                  {outlines.map((o) => (
                    // The page outline's look; a click on it bubbles to `pick`, which picks its cell.
                    <div
                      class={`we-review-box we-review-${o.change} we-rv-sheet-outline${o.selected ? " we-review-selected" : ""}${
                        o.decision === "reject" ? " we-review-rejected" : ""
                      }`}
                      key={o.key}
                      style={{ left: `${ROW_HEADER_PX + o.box.x}px`, top: `${o.box.y}px`, width: `${o.box.w}px`, height: `${o.box.h}px` }}
                      aria-hidden="true"
                      data-testid={`review-sheet-outline-${o.a1}`}
                      data-cell={o.a1}
                      data-change={o.change}
                      data-selected={o.selected}
                    >
                      <span
                        class={`we-review-tag${o.tag.free ? "" : " we-review-tag-on-demand"}`}
                        style={{
                          left: `calc(${o.tag.x - o.box.x}px - var(--we-review-border))`,
                          top: `calc(${o.tag.y - o.box.y}px - var(--we-review-border))`,
                        }}
                      >
                        {o.change}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : read.error === null ? (
              <p class="we-rv-sheet-note" role="status" data-testid="review-sheet-loading">
                {sheet ? "Reading the sheet" : "This workbook has no sheets."}
              </p>
            ) : null}
            {model?.win.truncated && (
              <p class="we-rv-sheet-note" role="status" data-testid="review-sheet-truncated">
                Showing the first {model.win.rows} rows and {model.win.cols} columns.{" "}
                {(model.win.rows < ROW_CAP || model.win.cols < COL_CAP) && (
                  <button type="button" class="we-btn" onClick={() => setMore(more + 1)}>
                    Show more
                  </button>
                )}{" "}
                Printed Pages shows the whole sheet.
              </p>
            )}
          </div>
          <div class="we-rv-sheet-tabs" role="tablist" aria-label="Sheets" data-testid="review-sheet-tabs">
            {tabs.map((tab) => {
              const mark = marks.get(tab.sheetId);
              return (
                <button
                  type="button"
                  role="tab"
                  class="we-rv-sheet-tab"
                  key={tab.sheetId}
                  aria-selected={tab.sheetId === sheet?.sheetId}
                  data-testid={`review-sheet-tab-${tab.sheetId}`}
                  onClick={() => {
                    setActiveId(tab.sheetId);
                    setMore(0);
                  }}
                >
                  {tab.name}
                  {mark && (
                    <span class={`we-rv-sheet-badge we-rv-d-${mark.decision}`} title={`${mark.count} changed cells`}>
                      {mark.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
