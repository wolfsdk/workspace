/**
 * Text editing on the slide with a caret and selection drawn from the
 * engine's glyph layout (reactor kernel, `text_layout`; textlayout.ts). The
 * text stays painted by the engine; this draws the caret, the selection and,
 * until the engine lays out an edit, the pending text at the caret.
 *
 * Model. `text` is the editor's copy of the shape or cell text, `synced` the
 * text the document holds as far as this editor knows, and the geometry is
 * the layout of `geom.text` (the document's text at the last revision this
 * editor measured). Offsets are UTF-16 offsets of `text`; geometry questions
 * (hit test, Up/Down, Home/End) go through the single-span difference
 * between `geom.text` and `text`. Edits are committed after an 800 ms pause
 * (and on leaving, navigation by pointer or line, formatting, undo) with
 * `writeShapeText`/`writeCellText`, which pick shape, paragraph or run
 * `set` without flattening mixed formatting.
 *
 * Input. A hidden textarea at the caret takes keys, text input
 * (`beforeinput`), composition (shown underlined at the caret, sent at
 * `compositionend`) and the clipboard; it holds the selected text, selected,
 * so the browser's own copy and cut fire.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { isReactorKernel, type TextLayout } from "@wolfsdk/protocol";
import { useEditor, type EditorHost } from "../../host/index.ts";
import { activeElement } from "./dom.ts";
import { CARET_KEYS, dispatch, IS_MAC, type CaretActions } from "./keys.ts";
import { beginTextEdit, toggleFont, writeCellText, writeShapeText } from "./actions.ts";
import { deckOf, isCut, type Box } from "./model.ts";
import { storeOf, type Editing } from "./store.ts";
import {
  clipboardText,
  LINE_BREAK,
  mapBack,
  mapForward,
  nextGrapheme,
  PARAGRAPH,
  paragraphAt,
  pastedText,
  prevGrapheme,
  textDiff,
  wordAt,
  wordLeft,
  wordRight,
  type Span,
} from "./textedit.ts";
import {
  caretBounds,
  caretBox,
  cellGeometry,
  hitText,
  lineEdge,
  selectionBoxes,
  shapeGeometry,
  verticalMove,
  type CaretBox,
  type CaretPos,
  type Mat,
  type TextGeometry,
  type Unusable,
} from "./textlayout.ts";

const PAUSE_MS = 800;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 4;
/** Points of slack around the edited box that still place the caret. */
const HIT_MARGIN_PT = 4;

type Sel = { anchor: number; focus: number; upstream: boolean };

type Model = {
  geom: TextGeometry | null;
  text: string;
  synced: string;
  sel: Sel;
  /** Line-space x kept by consecutive Up/Down moves. */
  goalX: number | null;
  composing: string | null;
  timer: number | undefined;
  chain: Promise<void>;
  drag: { unit: "char" | "word" | "para"; origin: { start: number; end: number } } | null;
  lastClick: { t: number; x: number; y: number; count: number };
  closed: boolean;
};

/** The table text the layout object paints (display_list `objects`), cached
 * per revision and page: the display list is the whole page. */
let tableTextCache: { key: string; text: string } | null = null;

async function loadGeometry(host: EditorHost, editing: Editing): Promise<TextGeometry | Unusable> {
  const kernel = host.kernel;
  const state = host.getSnapshot().state;
  if (!state || !isReactorKernel(kernel)) return { unusable: "the kernel has no text layout" };
  const text = host.node(editing.target)?.text ?? "";
  if (isCut(text)) return { unusable: "the engine cut this text in the view" };
  try {
    if (editing.kind === "shape") {
      if (!text) return { unusable: "the text is empty" };
      return shapeGeometry(await kernel.textLayout(state.doc, editing.target), editing.page, text);
    }
    const deck = deckOf(state);
    const at = deck.cells.get(editing.target);
    const table = at && deck.shapes.get(at.table);
    if (!table?.table) return { unusable: "the cell's table is not in the view" };
    const cells = table.table.cells.flat().filter((c) => !!c);
    const index = cells.findIndex((c) => c!.id === editing.target);
    const key = `${state.doc}:${state.revision}:${editing.page}:${table.id}`;
    const [layout, tableText]: [TextLayout, string] = await Promise.all([
      kernel.textLayout(state.doc, table.id),
      tableTextCache?.key === key
        ? tableTextCache.text
        : kernel.displayList(state.doc, editing.page).then((dl) => {
            const t = dl.objects[table.id]?.text ?? "";
            tableTextCache = { key, text: t };
            return t;
          }),
    ]);
    return cellGeometry(
      layout,
      editing.page,
      tableText,
      cells.map((c) => c!.text ?? ""),
      index,
    );
  } catch (error) {
    return { unusable: `text_layout: ${(error as Error).message}` };
  }
}

/** Geometry of the emptied text: one line where the old text began. */
function emptyGeometry(previous: TextGeometry): TextGeometry {
  const first = previous.lines[0]!;
  return { text: "", lines: [{ ...first, clusters: [], start: 0, end: 0, estimated: true }] };
}

/** CSS transform from line space to overlay pixels. */
function lineSpace(m: Mat, k: number): JSX.CSSProperties {
  return {
    transform: `matrix(${m[0] * k}, ${m[1] * k}, ${m[2] * k}, ${m[3] * k}, ${m[4] * k}, ${m[5] * k})`,
    transformOrigin: "0 0",
  };
}

const scaleOf = (m: Mat) => Math.hypot(m[0], m[1]) || 1;

export function CaretEditor({
  host,
  editing,
  box,
  pxPerPt,
}: {
  host: EditorHost;
  editing: Editing;
  box: Box;
  pxPerPt: number;
}) {
  const snap = useEditor(host);
  const store = storeOf(host);
  const k = pxPerPt;
  const area = useRef<HTMLTextAreaElement>(null);
  const hitArea = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const render = () => setTick((t) => t + 1);
  const [saving, setSaving] = useState(false);
  const [focused, setFocused] = useState(false);
  const initial = host.node(editing.target)?.text ?? "";
  const model = useRef<Model>({
    geom: null,
    text: initial,
    synced: initial,
    sel: { anchor: 0, focus: 0, upstream: false },
    goalX: null,
    composing: null,
    timer: undefined,
    chain: Promise.resolve(),
    drag: null,
    lastClick: { t: 0, x: 0, y: 0, count: 0 },
    closed: false,
  });
  const m = model.current;
  const state = snap.state;

  // -------------------------------------------------------------------------
  // Geometry: measured for every revision while editing.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let stale = false;
    void loadGeometry(host, editing).then((g) => {
      if (stale || m.closed) return;
      if ("unusable" in g) {
        const now = host.node(editing.target)?.text ?? "";
        if (m.geom && now === "") g = emptyGeometry(m.geom);
        else {
          store.set({ editing: { ...editing, mode: "box", reason: g.unusable } });
          return;
        }
      }
      const first = !m.geom;
      const before = m.synced;
      if (first) {
        m.text = m.synced = g.text;
        const len = g.text.length;
        if (editing.selectAll) m.sel = { anchor: 0, focus: len, upstream: false };
        else if (editing.at) {
          const pos = hitText(g, editing.at.x, editing.at.y);
          m.sel = { anchor: pos.offset, focus: pos.offset, upstream: pos.upstream };
          const client = editing.at.client;
          if (client) m.lastClick = { t: performance.now(), x: client[0], y: client[1], count: 2 };
        } else m.sel = { anchor: len, focus: len, upstream: false };
      } else if (m.text === m.synced || m.text === g.text) {
        // Nothing unsent: follow the document (an undo, a commit, a change
        // the engine made), keeping the caret on the mapped offset.
        const d = textDiff(before, g.text, m.sel.focus);
        m.sel = { anchor: mapForward(d, m.sel.anchor), focus: mapForward(d, m.sel.focus), upstream: m.sel.upstream };
        m.text = m.synced = g.text;
      }
      m.geom = g;
      syncArea();
      render();
      // A toolbar control (font list) took focus for a format: give it back.
      const active = area.current && activeElement(area.current);
      if (active instanceof HTMLElement && active !== area.current && active.closest("[role=toolbar]"))
        area.current!.focus({ preventScroll: true });
    });
    return () => {
      stale = true;
    };
  }, [state?.doc, state?.revision, editing.target]);

  // Leave when the edited node goes away or another selection replaces it.
  useEffect(() => {
    if (!host.node(editing.target) || !snap.selection.includes(editing.target)) leave(false);
  }, [snap.selection, state?.revision, editing.target]);

  useEffect(() => {
    area.current?.focus({ preventScroll: true });
    return () => {
      m.closed = true;
      flush();
    };
  }, [editing.target]);

  // `beforeinput` and composition events by name: Preact maps `on*` props
  // with no matching DOM property (composition events) case-sensitively.
  const handlers = useRef({ onBeforeInput, onCompositionStart, onCompositionUpdate, onCompositionEnd });
  handlers.current = { onBeforeInput, onCompositionStart, onCompositionUpdate, onCompositionEnd };
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const listeners: [string, (e: Event) => void][] = [
      ["beforeinput", (e) => handlers.current.onBeforeInput(e as InputEvent)],
      ["compositionstart", () => handlers.current.onCompositionStart()],
      ["compositionupdate", (e) => handlers.current.onCompositionUpdate(e as CompositionEvent)],
      ["compositionend", (e) => handlers.current.onCompositionEnd(e as CompositionEvent)],
    ];
    for (const [type, fn] of listeners) el.addEventListener(type, fn);
    return () => {
      for (const [type, fn] of listeners) el.removeEventListener(type, fn);
    };
  }, []);

  // Keep the hidden input at the caret (input method windows open there).
  useLayoutEffect(() => syncArea(), [m.sel.anchor, m.sel.focus, m.text]);

  // -------------------------------------------------------------------------
  // Model helpers
  // -------------------------------------------------------------------------
  const lo = () => Math.min(m.sel.anchor, m.sel.focus);
  const hi = () => Math.max(m.sel.anchor, m.sel.focus);
  const span = (): Span | null => (m.geom ? textDiff(m.geom.text, m.text, m.sel.focus) : null);
  const toBase = (offset: number): number => {
    const s = span();
    return s ? (mapBack(s, offset) ?? s.start) : offset;
  };
  const toLocal = (offset: number): number => {
    const s = span();
    return s ? mapForward(s, offset) : offset;
  };

  function syncArea() {
    const el = area.current;
    if (!el || m.composing !== null) return;
    const selected = m.text.slice(lo(), hi());
    if (el.value !== selected) el.value = selected;
    el.select();
  }

  function setSel(anchor: number, focus: number, upstream = false, keepGoal = false) {
    m.sel = { anchor, focus, upstream };
    if (!keepGoal) m.goalX = null;
    syncArea();
    render();
  }

  function moveTo(focus: number, extend: boolean, upstream = false, keepGoal = false) {
    setSel(extend ? m.sel.anchor : focus, focus, upstream, keepGoal);
  }

  /** Replace the selection (or `[from, to)`) with `insert`. */
  function replace(insert: string, from = lo(), to = hi()) {
    if (m.composing !== null) return;
    m.text = m.text.slice(0, from) + insert + m.text.slice(to);
    const at = from + insert.length;
    m.sel = { anchor: at, focus: at, upstream: false };
    m.goalX = null;
    syncArea();
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(m.timer);
    m.timer = window.setTimeout(() => flush(), PAUSE_MS);
  }

  /** Commit the unsent text; serialised so commits never overlap. */
  function flush(): Promise<void> {
    clearTimeout(m.timer);
    if (m.composing !== null) {
      if (!m.closed) m.timer = window.setTimeout(() => flush(), PAUSE_MS);
      return m.chain;
    }
    m.chain = m.chain.then(async () => {
      const text = m.text;
      if (text === m.synced) return;
      if (!m.closed) setSaving(true);
      const outcome =
        editing.kind === "cell"
          ? await writeCellText(host, editing.target, text, m.sel.focus)
          : await writeShapeText(host, editing.target, text, m.sel.focus);
      if (!m.closed) setSaving(false);
      if (outcome.status === "done") {
        m.synced = text;
      } else if (m.text === text) {
        // Refused (the host shows why): back to what the document holds.
        m.text = m.synced;
        const len = m.text.length;
        m.sel = { anchor: Math.min(m.sel.anchor, len), focus: Math.min(m.sel.focus, len), upstream: false };
        if (!m.closed) {
          syncArea();
          render();
        }
      }
    });
    return m.chain;
  }

  function leave(commit = true) {
    if (m.closed) return;
    if (commit) void flush();
    if (store.state.editing?.target === editing.target) store.set({ editing: null });
  }

  // -------------------------------------------------------------------------
  // Geometry-backed navigation
  // -------------------------------------------------------------------------
  const basePos = (): CaretPos => ({ offset: toBase(m.sel.focus), upstream: m.sel.upstream });

  function caretAt(pos: CaretPos): CaretBox | null {
    const g = m.geom;
    if (!g) return null;
    return caretBox(g, pos) ?? caretBox(g, { offset: pos.offset, upstream: !pos.upstream });
  }

  function vertical(dir: -1 | 1, extend: boolean) {
    const g = m.geom;
    if (!g) return;
    const pos = basePos();
    const goal = m.goalX ?? caretAt(pos)?.x ?? 0;
    const next = verticalMove(g, pos, dir, goal);
    moveTo(toLocal(next.offset), extend, next.upstream, true);
    m.goalX = goal;
  }

  function lineEnd(end: boolean, extend: boolean) {
    const g = m.geom;
    if (!g) return;
    const next = lineEdge(g, basePos(), end);
    moveTo(toLocal(next.offset), extend, next.upstream);
  }

  function hitLocal(e: PointerEvent): CaretPos | null {
    const g = m.geom;
    const layer = hitArea.current?.parentElement;
    if (!g || !layer) return null;
    const r = layer.getBoundingClientRect();
    const pos = hitText(g, (e.clientX - r.left) / k, (e.clientY - r.top) / k);
    return { offset: toLocal(pos.offset), upstream: pos.upstream };
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    area.current?.focus({ preventScroll: true });
    if (m.text !== m.synced) void flush();
    const pos = hitLocal(e);
    if (!pos) return;
    const now = performance.now();
    const last = m.lastClick;
    const near = Math.hypot(e.clientX - last.x, e.clientY - last.y) <= MULTI_CLICK_PX;
    const count = now - last.t < MULTI_CLICK_MS && near ? (last.count % 3) + 1 : 1;
    m.lastClick = { t: now, x: e.clientX, y: e.clientY, count };
    if (count === 1) {
      m.drag = { unit: "char", origin: { start: pos.offset, end: pos.offset } };
      if (e.shiftKey) moveTo(pos.offset, true, pos.upstream);
      else setSel(pos.offset, pos.offset, pos.upstream);
    } else {
      const unit = count === 2 ? "word" : "para";
      const w = unit === "word" ? wordAt(m.text, pos.offset) : paragraphAt(m.text, pos.offset);
      m.drag = { unit, origin: w };
      setSel(w.start, w.end);
    }
    hitArea.current?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    const d = m.drag;
    if (!d) return;
    e.stopPropagation();
    const pos = hitLocal(e);
    if (!pos) return;
    if (d.unit === "char") {
      if (pos.offset !== m.sel.focus) setSel(m.sel.anchor, pos.offset, pos.upstream);
      return;
    }
    const w = d.unit === "word" ? wordAt(m.text, pos.offset) : paragraphAt(m.text, pos.offset);
    if (w.start < d.origin.start) setSel(d.origin.end, w.start);
    else setSel(d.origin.start, Math.max(w.end, d.origin.end));
  }

  function onPointerUp(e: PointerEvent) {
    if (!m.drag) return;
    e.stopPropagation();
    m.drag = null;
    if (hitArea.current?.hasPointerCapture(e.pointerId)) hitArea.current.releasePointerCapture(e.pointerId);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  async function undoRedo(redo: boolean) {
    if (!redo && m.text !== m.synced) {
      // Unsent typing: undo drops it locally.
      clearTimeout(m.timer);
      m.text = m.synced;
      const len = m.text.length;
      setSel(Math.min(m.sel.anchor, len), Math.min(m.sel.focus, len));
      return;
    }
    await flush();
    const s = host.getSnapshot().state;
    if (redo ? s?.canRedo : s?.canUndo) await (redo ? host.redo() : host.undo());
  }

  function nextCell(back: boolean) {
    const s = host.getSnapshot().state;
    if (!s) return;
    const deck = deckOf(s);
    const at = deck.cells.get(editing.target);
    const table = at && deck.shapes.get(at.table);
    const cells = table?.table?.cells.flat().filter((c) => !!c) ?? [];
    const i = cells.findIndex((c) => c!.id === editing.target);
    const next = cells[i + (back ? -1 : 1)];
    if (!next) return;
    void flush();
    host.select([next.id]);
    store.set({ cellAnchor: next.id });
    beginTextEdit(host, next.id, "cell", editing.page, { selectAll: true });
  }

  const actions: CaretActions = {
    isCell: editing.kind === "cell",
    leave: () => leave(),
    selectAll: () => setSel(0, m.text.length),
    undo: (redo) => void undoRedo(redo),
    format: (kind) => void flush().then(() => toggleFont(host, kind)),
    char: (right, extend) => {
      if (!extend && m.sel.anchor !== m.sel.focus) return moveTo(right ? hi() : lo(), false);
      moveTo(right ? nextGrapheme(m.text, m.sel.focus) : prevGrapheme(m.text, m.sel.focus), extend);
    },
    word: (right, extend) =>
      moveTo(right ? wordRight(m.text, m.sel.focus, IS_MAC) : wordLeft(m.text, m.sel.focus), extend),
    lineEdge: (end, extend) => lineEnd(end, extend),
    textEdge: (end, extend) => moveTo(end ? m.text.length : 0, extend),
    vertical: (down, extend) => {
      if (!extend && m.sel.anchor !== m.sel.focus) moveTo(down ? hi() : lo(), false);
      vertical(down ? 1 : -1, extend);
    },
    erase: (forward, unit) => {
      if (m.sel.anchor !== m.sel.focus) return replace("");
      const at = m.sel.focus;
      let other: number;
      if (unit === "line") {
        const g = m.geom;
        other = Math.min(g ? toLocal(lineEdge(g, basePos(), false).offset) : at, at);
      } else if (unit === "word") other = forward ? wordRight(m.text, at, true) : wordLeft(m.text, at);
      else other = forward ? nextGrapheme(m.text, at) : prevGrapheme(m.text, at);
      if (other !== at) replace("", Math.min(at, other), Math.max(at, other));
    },
    insert: (text) => replace(text),
    tab: (back) => nextCell(back),
  };

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (dispatch(CARET_KEYS, actions, e)) e.preventDefault();
  }

  function onBeforeInput(e: InputEvent) {
    const type = e.inputType;
    if (type.startsWith("insertComposition") || e.isComposing) return;
    e.preventDefault();
    if (type === "insertText" || type === "insertReplacementText")
      replace(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
    else if (type === "insertParagraph") replace(PARAGRAPH);
    else if (type === "insertLineBreak") replace(LINE_BREAK);
    else if (type.startsWith("delete") && m.sel.anchor !== m.sel.focus) replace("");
    else if (type === "deleteContentBackward") replace("", prevGrapheme(m.text, m.sel.focus), m.sel.focus);
    else if (type === "deleteContentForward") replace("", m.sel.focus, nextGrapheme(m.text, m.sel.focus));
  }

  function onCompositionStart() {
    clearTimeout(m.timer);
    m.composing = "";
    render();
  }
  function onCompositionUpdate(e: CompositionEvent) {
    m.composing = e.data;
    render();
  }
  function onCompositionEnd(e: CompositionEvent) {
    m.composing = null;
    if (area.current) area.current.value = "";
    replace(e.data ?? "");
  }

  function onCopy(e: ClipboardEvent, cut: boolean) {
    e.stopPropagation();
    if (m.sel.anchor === m.sel.focus || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", clipboardText(m.text.slice(lo(), hi())));
    if (cut) replace("");
  }

  function onPaste(e: ClipboardEvent) {
    e.stopPropagation();
    e.preventDefault();
    const text = pastedText(e.clipboardData?.getData("text/plain") ?? "");
    if (text) replace(text);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  const g = m.geom;
  const composing = m.composing;
  // The text as shown: unsent edits plus the composition at the selection.
  const shown = composing === null ? m.text : m.text.slice(0, lo()) + composing + m.text.slice(hi());
  const focusShown = composing === null ? m.sel.focus : lo() + composing.length;
  const pending = g ? textDiff(g.text, shown, focusShown) : null;
  const hasPending = !!pending && (pending.start !== pending.endBefore || pending.start !== pending.endAfter);

  let caret: CaretBox | null = null;
  let chip: { at: CaretBox; before: string; composed: string; after: string; caretInside: boolean } | null = null;
  let selection: { m: Mat; x: number; y: number; w: number; h: number }[] = [];
  let deleted: typeof selection = [];
  if (g && pending) {
    if (hasPending) {
      const at = caretAt({ offset: pending.start, upstream: true }) ?? caretAt({ offset: 0, upstream: false });
      const inserted = shown.slice(pending.start, pending.endAfter);
      const inside = focusShown >= pending.start && focusShown <= pending.endAfter;
      if (at && inserted) {
        const split = inside ? focusShown - pending.start : inserted.length;
        const cStart = composing === null ? -1 : lo() - pending.start;
        const cEnd = cStart + (composing?.length ?? 0);
        // before | composed | after, with the caret after `before` + `composed`
        // when the composition holds it.
        if (composing !== null && cStart >= 0 && cEnd <= inserted.length)
          chip = {
            at,
            before: inserted.slice(0, cStart),
            composed: inserted.slice(cStart, cEnd),
            after: inserted.slice(cEnd),
            caretInside: inside,
          };
        else
          chip = {
            at,
            before: inserted.slice(0, split),
            composed: "",
            after: inserted.slice(split),
            caretInside: inside,
          };
      }
      if (pending.endBefore > pending.start) deleted = selectionBoxes(g, pending.start, pending.endBefore);
      if (!inside || !chip)
        caret = caretAt({ offset: mapBack(pending, focusShown) ?? pending.start, upstream: m.sel.upstream });
    } else caret = caretAt({ offset: m.sel.focus, upstream: m.sel.upstream });
    if (m.sel.anchor !== m.sel.focus && composing === null) selection = selectionBoxes(g, toBase(lo()), toBase(hi()));
  }
  const imeAt = caret ? caretBounds(caret) : chip ? caretBounds(chip.at) : null;

  const pad = HIT_MARGIN_PT;
  const label = editing.kind === "cell" ? "Cell text" : "Shape text";
  const pendingText = (s: string) => s.replaceAll(PARAGRAPH, "\u00b6").replaceAll(LINE_BREAK, "\u21b5");
  const caretW = (c: CaretBox) => 1.5 / (k * scaleOf(c.m));
  const caretClass = `we-slides-caret${focused ? "" : " we-slides-caret-idle"}`;

  return (
    <>
      <div
        ref={hitArea}
        class="we-slides-caret-area"
        data-testid="slides-caret-editor"
        data-target={editing.target}
        data-anchor={m.sel.anchor}
        data-focus={m.sel.focus}
        data-pending={hasPending ? "true" : "false"}
        data-synced={m.text === m.synced ? "true" : "false"}
        style={{
          left: `${(box.x - pad) * k}px`,
          top: `${(box.y - pad) * k}px`,
          width: `${(box.w + 2 * pad) * k}px`,
          height: `${(box.h + 2 * pad) * k}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDblClick={(e) => e.stopPropagation()}
      />
      {selection.length > 0 && (
        <div class="we-slides-text-selection" data-testid="slides-text-selection" aria-hidden="true">
          {selection.map((r, i) => (
            <div key={i} class="we-slides-line-space" style={lineSpace(r.m, k)}>
              <div
                class="we-slides-text-selection-rect"
                style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }}
              />
            </div>
          ))}
        </div>
      )}
      {deleted.map((r, i) => (
        <div key={`d${i}`} class="we-slides-line-space" style={lineSpace(r.m, k)} aria-hidden="true">
          <div
            class="we-slides-text-deleted"
            style={{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }}
          />
        </div>
      ))}
      {chip && (
        <div class="we-slides-line-space" style={lineSpace(chip.at.m, k)} aria-hidden="true">
          <div
            class="we-slides-text-pending"
            data-testid="slides-text-pending"
            style={{
              left: `${chip.at.x}px`,
              top: `${chip.at.top}px`,
              height: `${chip.at.bottom - chip.at.top}px`,
              fontSize: `${(chip.at.bottom - chip.at.top) * 0.72}px`,
              lineHeight: `${chip.at.bottom - chip.at.top}px`,
            }}
          >
            {pendingText(chip.before)}
            {chip.composed && (
              <span class="we-slides-text-composing" data-testid="slides-text-composition">
                {pendingText(chip.composed)}
              </span>
            )}
            {chip.caretInside && (
              <span
                key={`c${focusShown}`}
                class={`${caretClass} we-slides-caret-inline`}
                data-testid="slides-caret"
                style={{ width: `${caretW(chip.at)}px` }}
              />
            )}
            {pendingText(chip.after)}
          </div>
        </div>
      )}
      {caret && (
        <div class="we-slides-line-space" style={lineSpace(caret.m, k)} aria-hidden="true">
          <div
            key={`c${m.sel.focus}:${m.text.length}`}
            class={caretClass}
            data-testid="slides-caret"
            data-offset={m.sel.focus}
            style={{
              left: `${caret.x}px`,
              top: `${caret.top}px`,
              width: `${caretW(caret)}px`,
              height: `${caret.bottom - caret.top}px`,
            }}
          />
        </div>
      )}
      <textarea
        ref={area}
        class="we-slides-ime"
        data-testid="slides-ime"
        aria-label={label}
        aria-multiline="true"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        style={
          imeAt
            ? {
                left: `${imeAt.x * k}px`,
                top: `${imeAt.y * k}px`,
                height: `${Math.max(imeAt.h * k, 8)}px`,
                fontSize: `${Math.max(imeAt.h * k * 0.72, 8)}px`,
              }
            : { left: `${box.x * k}px`, top: `${box.y * k}px` }
        }
        onKeyDown={onKeyDown}
        onCopy={(e) => onCopy(e, false)}
        onCut={(e) => onCopy(e, true)}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          void flush();
        }}
      />
      {(saving || !g) && (
        <div
          class="we-slides-caret-status"
          data-testid="slides-caret-status"
          style={{ left: `${box.x * k}px`, top: `${(box.y + box.h) * k + 4}px` }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {!g ? "Measuring text" : "Saving"}
        </div>
      )}
    </>
  );
}
