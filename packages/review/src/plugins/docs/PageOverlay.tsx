import type { Address, Region } from "@wolfsdk/protocol";
import type { PageOverlayProps } from "../../host/index.ts";
import { useEditor } from "../../host/index.ts";
import { isReactorKernel } from "@wolfsdk/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  deleteColumn,
  deleteRow,
  editNeighbour,
  findMatches,
  insertColumn,
  insertRow,
  mergeParagraph,
  splitParagraph,
} from "./actions.ts";
import { CaretLayer, caretPointerDown, registerLayer } from "./CaretEditor.tsx";
import { type Binding, CHORD_KEYS, dispatch, type KeyContext, TAB_KEYS } from "./shortcuts.ts";
import { textIsComplete } from "./textedit.ts";
import { useDocs, type DocsStore, type Editing } from "./store.ts";

type Box = { left: number; top: number; width: number; height: number };

const EDITOR_FONT = `Carlito, Calibri, "Liberation Sans", Arial, sans-serif`;
const LINE_FACTOR = 1.2;

function boxOf(region: Region, pxPerPt: number): Box {
  const [x, y, w, h] = region.bbox_pt;
  return { left: x * pxPerPt, top: y * pxPerPt, width: w * pxPerPt, height: h * pxPerPt };
}

function union(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Lines `text` wraps to at `size` px in `width` px (greedy word wrap). */
function wrappedLines(text: string, size: number, width: number): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const ctx = measureContext!;
  ctx.font = `${size}px ${EDITOR_FONT}`;
  let lines = 0;
  for (const hard of text.split("\n")) {
    lines += 1;
    let line = 0;
    for (const word of hard.split(/(?<=\s)/)) {
      const w = ctx.measureText(word.replace(/\t/g, "    ")).width;
      if (line > 0 && line + w > width) {
        lines += 1;
        line = w;
      } else line += w;
    }
  }
  return lines;
}

/** Font size and line height (CSS px) that make `text` fill the drawn box the way the page does. */
export function estimateFont(
  text: string,
  width: number,
  height: number,
): { size: number; lineHeight: number; lines: number } {
  if (text.trim() === "") {
    const size = Math.max(6, Math.min(72, height / LINE_FACTOR));
    return { size, lineHeight: height, lines: 1 };
  }
  let best = { size: 12, lineHeight: height, lines: 1, error: Infinity };
  for (let size = 5; size <= 96; size += 0.5) {
    const lines = wrappedLines(text, size, width);
    const error = Math.abs(lines * size * LINE_FACTOR - height);
    if (error < best.error) best = { size, lineHeight: height / lines, lines, error };
    if (lines * size * LINE_FACTOR > height * 1.6) break;
  }
  return { size: best.size, lineHeight: best.lineHeight, lines: best.lines };
}

/** Rough caret offset for a double-click at (x, y) inside a paragraph box. */
function caretFromPoint(text: string, box: Box, x: number, y: number): number {
  const { lines } = estimateFont(text, box.width, box.height);
  const line = Math.max(0, Math.min(lines - 1, Math.floor(((y - box.top) / box.height) * lines)));
  const within = Math.max(0, Math.min(1, (x - box.left) / box.width));
  return Math.round(((line + within) / lines) * text.length);
}

type BoxContext = KeyContext & { el: HTMLTextAreaElement };

const BOX = "in the text box editor (no exact caret layout)";
const atStart = (el: HTMLTextAreaElement) => el.selectionStart === el.selectionEnd && el.selectionStart === 0;
const atEnd = (el: HTMLTextAreaElement) => el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length;

/** The text box editor's keys (it dispatches them; also the plugin's shortcut list). */
export const BOX_KEYS: readonly Binding<BoxContext>[] = [
  {
    keys: "Escape",
    label: "Cancel the typing not yet saved",
    group: "Text box",
    when: BOX,
    run: ({ store }) => store.cancelEdit(),
  },
  {
    keys: "Mod+Enter",
    label: "Save the typing and stop editing",
    group: "Text box",
    when: BOX,
    run: ({ store }) => void store.commit(true),
  },
  {
    keys: "Enter",
    label: "Split the paragraph",
    group: "Text box",
    when: BOX,
    run: ({ store }) => void splitParagraph(store),
  },
  {
    keys: "Backspace",
    label: "At the start: join with the paragraph before",
    group: "Text box",
    when: BOX,
    run: ({ store, el }) => atStart(el) && (void mergeParagraph(store, -1), true),
  },
  {
    keys: "Delete",
    label: "At the end: join with the paragraph after",
    group: "Text box",
    when: BOX,
    run: ({ store, el }) => atEnd(el) && (void mergeParagraph(store, 1), true),
  },
  ...TAB_KEYS,
  {
    keys: "Tab",
    label: "Tab character",
    group: "Text box",
    when: BOX,
    run: ({ store, el }) => {
      el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
      store.input(el.value, el.selectionStart, el.selectionEnd);
    },
  },
  {
    keys: "ArrowUp",
    label: "At the start: edit the paragraph before",
    group: "Text box",
    when: BOX,
    run: ({ store, el }) => atStart(el) && (void editNeighbour(store, -1), true),
  },
  {
    keys: "ArrowDown",
    label: "At the end: edit the paragraph after",
    group: "Text box",
    when: BOX,
    run: ({ store, el }) => atEnd(el) && (void editNeighbour(store, 1), true),
  },
  ...CHORD_KEYS,
];

function InlineEditor({ store, editing, box }: { store: DocsStore; editing: Editing; box: Box }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const font = useMemo(() => estimateFont(editing.base, box.width, box.height), [editing.base, box.width, box.height]);

  // Focus and restore the caret when the editor (re)mounts.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(editing.selStart, editing.selEnd);
  }, [editing.session]);

  // Text replaced from outside (stored text differs): put the caret back.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.value === editing.text) return;
    el.value = editing.text;
    el.setSelectionRange(editing.selStart, editing.selEnd);
  }, [editing.text]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(box.height, el.scrollHeight)}px`;
  });

  const syncSelection = () => {
    const el = ref.current;
    if (el && (el.selectionStart !== editing.selStart || el.selectionEnd !== editing.selEnd)) {
      store.patchEditing({ selStart: el.selectionStart, selEnd: el.selectionEnd });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    syncSelection();
    dispatch(BOX_KEYS, { store, event: e, el: ref.current! });
  };

  const onBlur = (e: FocusEvent) => {
    // Removing a focused editor (another editor replaced it) also blurs; that one is already handled.
    if (store.ui.editing?.session !== editing.session) return;
    const next = e.relatedTarget as HTMLElement | null;
    // Toolbar controls marked as keepers act on the editor's selection: stay open.
    const keep = !!next?.closest("[data-we-docs-keep]");
    void store.commit(!keep);
  };

  return (
    <>
      <div
        class="we-docs-mask"
        style={{
          left: `${box.left - 2}px`,
          top: `${box.top - 1}px`,
          width: `${box.width + 4}px`,
          height: `${box.height + 2}px`,
        }}
      />
      <textarea
        ref={ref}
        class="we-docs-editor"
        data-testid="docs-editor"
        data-address={editing.para}
        aria-label="Edit paragraph text"
        title="Enter splits, Backspace at the start merges, Escape cancels, Cmd/Ctrl+Enter commits"
        spellcheck={true}
        value={editing.text}
        style={{
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.width}px`,
          minHeight: `${box.height}px`,
          fontSize: `${font.size}px`,
          lineHeight: `${font.lineHeight}px`,
          fontFamily: EDITOR_FONT,
        }}
        onInput={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement;
          store.input(el.value, el.selectionStart, el.selectionEnd);
        }}
        onSelect={syncSelection}
        onKeyUp={syncSelection}
        onMouseUp={syncSelection}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
    </>
  );
}

type CellMenuAt = { x: number; y: number; para: Address };

const CELL_ITEMS: { id: string; label: string; feature?: string; run: (store: DocsStore) => Promise<unknown> }[] = [
  { id: "row-above", label: "Insert row above", run: (s) => insertRow(s, "above") },
  { id: "row-below", label: "Insert row below", run: (s) => insertRow(s, "below") },
  { id: "row-delete", label: "Delete row", run: (s) => deleteRow(s) },
  { id: "col-left", label: "Insert column left", run: (s) => insertColumn(s, "left") },
  { id: "col-right", label: "Insert column right", run: (s) => insertColumn(s, "right") },
  { id: "col-delete", label: "Delete column", feature: "col-delete", run: (s) => deleteColumn(s) },
];

/** Right-click menu on a table cell paragraph. Closes on an item, a press outside it, or Escape. */
function CellMenu({ store, at, close }: { store: DocsStore; at: CellMenuAt; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const down = (e: MouseEvent) => {
      if (!e.composedPath().includes(ref.current!)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      class="we-menu we-docs-ctx"
      role="menu"
      aria-label="Table"
      data-testid="docs-ctx"
      style={{ left: `${at.x}px`, top: `${at.y}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {CELL_ITEMS.map((item) => {
        const refused = item.feature ? store.ui.disabled[item.feature] : undefined;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            class="we-menu-item"
            data-testid={`docs-ctx-${item.id}`}
            title={refused ? `${item.label}: refused by the engine (${refused.code}) ${refused.message}` : item.label}
            aria-label={item.label}
            disabled={!!refused}
            onClick={() => {
              close();
              void item.run(store);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

const pictureKey = (id: Address): string => id.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function DocsPageOverlay({ host, page, pxPerPt }: PageOverlayProps) {
  const snapshot = useEditor(host);
  const [store, ui] = useDocs(host);
  const layer = useRef<HTMLDivElement>(null);
  const [cellMenu, setCellMenu] = useState<CellMenuAt | null>(null);
  useLayoutEffect(
    () => (layer.current ? registerLayer(store, page, layer.current, pxPerPt) : undefined),
    [store, page, pxPerPt, layer.current],
  );
  // Reactor kernel: a click places a caret from the engine's text layout instead of selecting the paragraph box.
  const caretKernel = isReactorKernel(host.kernel);
  const state = snapshot.state;
  const regions = state ? host.regionsOn(page) : [];
  const model = store.model();
  const selected = new Set(snapshot.selection);
  const matches = ui.find.open ? findMatches(model, ui.find.query) : [];
  const current = matches.length > 0 ? matches[Math.min(ui.find.index, matches.length - 1)] : undefined;
  const hits = new Set(matches.map((m) => m.para));

  if (!state || state.format !== "docx") return null;

  const editing = ui.editing;
  const caretMode = editing?.mode === "caret";
  const editRegions = editing ? state.regions.filter((r) => r.object_id === editing.para) : [];
  const editPage = editRegions.some((r) => r.page === editing?.page) ? editing?.page : editRegions[0]?.page;
  const editBoxes = editRegions.filter((r) => r.page === page).map((r) => boxOf(r, pxPerPt));

  return (
    <div class="we-docs-layer" ref={layer} data-testid={`docs-layer-${page}`}>
      {regions.map((region, i) => {
        const id = region.object_id;
        const box = boxOf(region, pxPerPt);
        const para = model?.byId.get(id);
        const classes = ["we-docs-hit"];
        const editingThis = editing?.para === id;
        if (selected.has(id) && !(caretMode && editingThis)) classes.push("we-docs-selected");
        if (para?.cell) classes.push("we-docs-cell");
        if (hits.has(id)) classes.push("we-docs-match");
        if (current?.para === id) classes.push("we-docs-match-current");
        if (editingThis) classes.push(caretMode ? "we-docs-caret-host" : "we-docs-hidden");
        if (caretKernel && para) classes.push("we-docs-text");
        return (
          <div
            key={`${id}#${i}`}
            class={classes.join(" ")}
            data-testid="docs-para"
            data-address={id}
            data-page={page}
            title={para?.cell ? `Table ${para.cell.table}, row ${para.cell.row}, cell ${para.cell.col}` : undefined}
            style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}
            onMouseDown={(e) => {
              if (caretKernel && para && e.button === 0 && !e.metaKey && !e.ctrlKey) {
                // Keep the focus in the caret's textarea and the browser off page text.
                e.preventDefault();
                host.setCurrentPage(page);
                caretPointerDown(store, page, id, e);
                return;
              }
              // Keep a double-click from selecting page text.
              if (e.detail > 1) e.preventDefault();
            }}
            onClick={(e) => {
              if (caretKernel && para && !e.metaKey && !e.ctrlKey) return;
              host.setCurrentPage(page);
              host.select([id], { additive: e.shiftKey || e.metaKey || e.ctrlKey });
            }}
            onContextMenu={(e) => {
              if (!para?.cell) return;
              e.preventDefault();
              if (ui.editing && ui.editing.para !== id) void store.commit(true);
              host.setCurrentPage(page);
              host.select([id]);
              const rect = layer.current!.getBoundingClientRect();
              setCellMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top, para: id });
            }}
            onDblClick={(e) => {
              if (caretKernel && para) return;
              if (!para || !textIsComplete(para)) {
                store.fail(
                  "docs-text-cut",
                  "This paragraph's text is cut in the engine view and cannot be edited in place.",
                );
                return;
              }
              const rect = layer.current!.getBoundingClientRect();
              const caret = caretFromPoint(para.node.text ?? "", box, e.clientX - rect.left, e.clientY - rect.top);
              store.startEdit(id, page, caret);
            }}
          />
        );
      })}
      {(() => {
        // Pictures have no drawn region of their own: a selected paragraph (or picture) shows a chip per picture to select it; Delete/Backspace removes the selected one.
        const seen = new Set<Address>();
        return regions.flatMap((region) => {
          const para = model?.byId.get(region.object_id);
          if (!para || seen.has(para.id) || editing?.para === para.id) return [];
          const pictures = para.inline.filter((n) => n.kind === "image");
          if (pictures.length === 0 || !(selected.has(para.id) || pictures.some((n) => selected.has(n.id)))) return [];
          seen.add(para.id);
          const box = boxOf(region, pxPerPt);
          return [
            <div key={`pics-${para.id}`} class="we-docs-pics" style={{ left: `${box.left}px`, top: `${box.top}px` }}>
              {pictures.map((n, i) => {
                const on = selected.has(n.id);
                const label = `Picture ${i + 1}${typeof n.alt_text === "string" && n.alt_text ? `: ${n.alt_text}` : ""}`;
                return (
                  <button
                    key={n.id}
                    type="button"
                    class="we-chip we-docs-pic"
                    data-testid={`docs-image-${pictureKey(n.id)}`}
                    data-address={n.id}
                    aria-pressed={on}
                    title={on ? `${label} (selected: Delete or Backspace removes it)` : `Select ${label}`}
                    aria-label={on ? `${label}, selected` : `Select ${label}`}
                    onClick={() => host.select([n.id])}
                  >
                    {label}
                  </button>
                );
              })}
            </div>,
          ];
        });
      })()}
      {cellMenu && <CellMenu store={store} at={cellMenu} close={() => setCellMenu(null)} />}
      {editing && caretMode && editBoxes.length > 0 && (
        <CaretLayer
          store={store}
          host={host}
          state={state}
          editing={editing}
          page={page}
          pxPerPt={pxPerPt}
          boxes={editBoxes}
        />
      )}
      {editing && !caretMode && editBoxes.length > 0 && editPage === page && (
        <InlineEditor key={editing.session} store={store} editing={editing} box={union(editBoxes)} />
      )}
      {editing &&
        !caretMode &&
        editPage !== page &&
        editBoxes.map((box, i) => (
          <div
            key={`cont-${i}`}
            class="we-docs-mask we-docs-continued"
            title="This paragraph is being edited on another page"
            style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}
          />
        ))}
    </div>
  );
}
