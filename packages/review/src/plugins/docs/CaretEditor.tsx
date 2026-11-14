/**
 * Caret editing on the reactor kernel: a caret and selection drawn over the
 * page from the engine's `text_layout`, a hidden textarea at the caret that
 * takes typing, IME composition and the clipboard, and keyboard navigation
 * computed from the laid-out clusters.
 *
 * Typing is batched exactly as in the text-box editor (`DocsStore.input`,
 * committed after a pause, on navigation, or before any other action); until
 * the engine has laid the new text out, the typed text is previewed inline at
 * the caret over the old layout. Every key that needs geometry first commits
 * pending typing and reads the new revision's layout, in order (`queue`).
 *
 * A selection stays inside one paragraph: a drag that leaves it is clamped
 * to the paragraph it started in.
 */
import { KernelRequestError, type Address, type DocState } from "@wolfsdk/protocol";
import { type EditorHost } from "../../host/index.ts";
import { isReactorKernel, type ReactorKernelClient } from "@wolfsdk/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { mergeParagraph, pageOf, pasteLines, splitParagraph } from "./actions.ts";
import {
  buildCaretLayout,
  caretAt,
  graphemeStops,
  nextGrapheme,
  prevGrapheme,
  rangeRects,
  stopAt,
  stopInRow,
  wordAt,
  wordLeft,
  wordRight,
  type CaretLayout,
  type CaretPos,
} from "./caret.ts";
import { cleanText } from "./ops.ts";
import { CHORD_KEYS, dispatch, MAC, TAB_KEYS, WORD, type Binding } from "./shortcuts.ts";
import type { DocsStore, Editing } from "./store.ts";
import { changedRange, sameStoredText } from "./textedit.ts";

const EDITOR_FONT = `Carlito, Calibri, "Liberation Sans", Arial, sans-serif`;

// ---------------------------------------------------------------------------
// Layout cache
// ---------------------------------------------------------------------------

/** `ok`: the laid-out text (the full source text even when the view cut it) and its rows. */
export type LayoutResult =
  { kind: "ok"; layout: CaretLayout; text: string } | { kind: "empty" } | { kind: "unusable"; reason: string };

const pending = new Map<string, Promise<LayoutResult>>();
const settled = new Map<string, LayoutResult>();
const CACHE_LIMIT = 400;

const keyOf = (state: DocState, id: Address): string => `${state.doc}|${state.sha256}|${id}`;

async function fetchLayout(kernel: ReactorKernelClient, state: DocState, id: Address): Promise<LayoutResult> {
  const text = state.nodes.find((n) => n.id === id)?.text ?? "";
  let raw;
  try {
    raw = await kernel.textLayout(state.doc, id);
  } catch (cause) {
    // A paragraph without painted text (empty, or only tabs) has no layout (`unknown-object`): an empty one's caret comes from its box.
    if (text === "") return { kind: "empty" };
    const code = cause instanceof KernelRequestError ? ` (${cause.error.code})` : "";
    return { kind: "unusable", reason: `the engine gave no text layout${code}` };
  }
  const built = buildCaretLayout(raw);
  if ("unusable" in built) return { kind: "unusable", reason: built.unusable };
  if (built.rows.length === 0)
    return text === "" ? { kind: "empty" } : { kind: "unusable", reason: "none of its text is painted" };
  if (raw.length === text.length) return { kind: "ok", layout: built, text };
  // The view cut a long text with U+2026: the display list carries the full source text.
  if (raw.length > text.length && text.endsWith("\u2026")) {
    const list = await kernel.displayList(state.doc, built.rows[0]!.page).catch(() => null);
    const full = list?.objects[id]?.text;
    if (typeof full === "string" && full.length === raw.length && sameStoredText(text, full))
      return { kind: "ok", layout: built, text: full };
  }
  return { kind: "unusable", reason: "its text layout and view text disagree" };
}

/** Layout of paragraph `id` in revision `state`, cached by document content. Never rejects. */
export function loadLayout(host: EditorHost, state: DocState, id: Address): Promise<LayoutResult> {
  const key = keyOf(state, id);
  const done = settled.get(key);
  if (done) return Promise.resolve(done);
  let load = pending.get(key);
  if (!load) {
    const kernel = host.kernel;
    load = (
      isReactorKernel(kernel)
        ? fetchLayout(kernel, state, id)
        : Promise.resolve<LayoutResult>({ kind: "unusable", reason: "the kernel has no text layout" })
    )
      .catch((cause: unknown): LayoutResult => ({ kind: "unusable", reason: String(cause) }))
      .then((result) => {
        pending.delete(key);
        settled.set(key, result);
        if (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value!);
        return result;
      });
    pending.set(key, load);
  }
  return load;
}

// ---------------------------------------------------------------------------
// Per-store registry: page layers and the ordered key queue
// ---------------------------------------------------------------------------

type Registry = {
  layers: Map<number, { el: HTMLElement; pxPerPt: number }>;
  chain: Promise<void>;
  /** Queued steps not finished yet; typed characters wait behind them. */
  busy: number;
};

const registries = new WeakMap<DocsStore, Registry>();

function registry(store: DocsStore): Registry {
  let reg = registries.get(store);
  if (!reg) registries.set(store, (reg = { layers: new Map(), chain: Promise.resolve(), busy: 0 }));
  return reg;
}

/** Called by each page overlay: page `page`'s layer element, for pointer coordinates and scrolling. */
export function registerLayer(store: DocsStore, page: number, el: HTMLElement, pxPerPt: number): () => void {
  const reg = registry(store);
  const entry = { el, pxPerPt };
  reg.layers.set(page, entry);
  return () => {
    if (reg.layers.get(page) === entry) reg.layers.delete(page);
  };
}

/** Run `work` after every earlier caret step, in order. */
function queue(store: DocsStore, work: () => unknown): void {
  const reg = registry(store);
  reg.busy += 1;
  reg.chain = reg.chain.then(async () => {
    try {
      await work();
    } catch (cause) {
      store.report(cause);
    } finally {
      reg.busy -= 1;
    }
  });
}

type Ctx = { editing: Editing; text: string; layout: CaretLayout | null; state: DocState };

/** Commit pending typing, then the open caret editor with its paragraph's current layout. */
async function context(store: DocsStore): Promise<Ctx | null> {
  let editing = store.ui.editing;
  if (!editing || editing.mode !== "caret") return null;
  if (editing.text !== editing.base) {
    await store.commit(false);
    editing = store.ui.editing;
    if (!editing || editing.mode !== "caret" || editing.text !== editing.base) return null;
  }
  const state = store.host.getSnapshot().state;
  if (!state) return null;
  const result = await loadLayout(store.host, state, editing.para);
  editing = store.ui.editing;
  if (!editing || editing.mode !== "caret") return null;
  if (result.kind === "unusable") {
    fallBack(store, result.reason);
    return null;
  }
  if (result.kind === "ok" && result.text !== editing.base && sameStoredText(editing.base, result.text)) {
    store.patchEditing({ base: result.text, text: result.text });
    editing = store.ui.editing!;
  }
  return { editing, text: editing.text, layout: result.kind === "ok" ? result.layout : null, state };
}

function fallBack(store: DocsStore, reason: string): void {
  if (store.ui.editing?.mode !== "caret") return;
  store.patchEditing({ mode: "box" });
  store.info(
    `Exact caret positions are not available for this paragraph (${reason}); it opens in the text box editor.`,
  );
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const focusOf = (e: Editing): number => (e.backward ? e.selStart : e.selEnd);
const anchorOf = (e: Editing): number => (e.backward ? e.selEnd : e.selStart);

/** Move the selection's moving end to `focus` (extending, or collapsing onto it). */
function place(store: DocsStore, ctx: Ctx, focus: number, extend: boolean, extra: Partial<Editing> = {}): void {
  const anchor = extend ? anchorOf(ctx.editing) : focus;
  const upstream = extra.upstream ?? false;
  const pos = ctx.layout ? caretAt(ctx.layout, focus, upstream) : null;
  const page = pos?.page ?? ctx.editing.page;
  store.patchEditing({
    selStart: Math.min(anchor, focus),
    selEnd: Math.max(anchor, focus),
    backward: focus < anchor,
    upstream,
    goalX: null,
    ...extra,
    page,
  });
  if (!registry(store).layers.has(page)) store.host.reveal({ page });
}

/** Replace [start, end) of the editor's text with `insert` (pending until the commit). */
function editText(store: DocsStore, start: number, end: number, insert: string): void {
  const editing = store.ui.editing;
  if (!editing) return;
  const text = editing.text.slice(0, start) + insert + editing.text.slice(end);
  const at = start + insert.length;
  store.input(text, at, at);
  store.patchEditing({ backward: false, upstream: false, goalX: null });
}

/** The paragraph Up/Down/Left/Right continue in: the next one in reading order in the same story that is on a page. */
function adjacentPara(store: DocsStore, state: DocState, id: Address, step: -1 | 1): Address | null {
  const model = store.model();
  const para = model?.byId.get(id);
  if (!model || !para) return null;
  const story = (a: Address) => a.slice(0, a.lastIndexOf("para:"));
  for (let i = para.index + step; i >= 0 && i < model.paras.length; i += step) {
    const next = model.paras[i]!;
    if (story(next.id) !== story(id)) return null;
    if (pageOf(state, next.id) !== null) return next.id;
  }
  return null;
}

/** Open the caret in paragraph `id`: on its first/last row at `goalX` (Up/Down), or at its start/end (Left/Right). */
async function enterPara(store: DocsStore, ctx: Ctx, id: Address, step: -1 | 1, goalX: number | null): Promise<void> {
  const result = await loadLayout(store.host, ctx.state, id);
  const page = pageOf(ctx.state, id) ?? ctx.editing.page;
  if (result.kind === "unusable") {
    store.startEdit(id, page, step > 0 ? 0 : null, "box");
    store.info(
      `Exact caret positions are not available for this paragraph (${result.reason}); it opens in the text box editor.`,
    );
    return;
  }
  if (result.kind === "empty") {
    store.startEdit(id, page, 0);
    store.patchEditing({ goalX });
    return;
  }
  const { layout, text } = result;
  const row = step > 0 ? layout.rows[0]! : layout.rows[layout.rows.length - 1]!;
  const stop =
    goalX === null
      ? { offset: step > 0 ? 0 : text.length, upstream: false }
      : stopInRow(row, goalX, graphemeStops(text));
  store.startEdit(id, row.page, stop.offset);
  store.patchEditing({ base: text, text, selStart: stop.offset, selEnd: stop.offset, goalX, upstream: stop.upstream });
  if (!registry(store).layers.has(row.page)) store.host.reveal({ page: row.page });
}

function horizontal(store: DocsStore, step: -1 | 1, word: boolean, extend: boolean): void {
  queue(store, async () => {
    const ctx = await context(store);
    if (!ctx) return;
    const { editing, text } = ctx;
    if (!extend && !word && editing.selEnd > editing.selStart) {
      place(store, ctx, step < 0 ? editing.selStart : editing.selEnd, false);
      return;
    }
    const focus = focusOf(editing);
    if (!extend && focus === (step < 0 ? 0 : text.length)) {
      const next = adjacentPara(store, ctx.state, editing.para, step);
      if (next) await enterPara(store, ctx, next, step === -1 ? -1 : 1, null);
      return;
    }
    const to = word
      ? step < 0
        ? wordLeft(text, focus)
        : wordRight(text, focus)
      : step < 0
        ? prevGrapheme(text, focus)
        : nextGrapheme(text, focus);
    place(store, ctx, to, extend);
  });
}

function vertical(store: DocsStore, step: -1 | 1, extend: boolean): void {
  queue(store, async () => {
    const ctx = await context(store);
    if (!ctx) return;
    const { editing, layout, text } = ctx;
    const pos = layout ? caretAt(layout, focusOf(editing), editing.upstream) : null;
    const goal = editing.goalX ?? pos?.x ?? null;
    const row = pos && layout ? layout.rows[pos.row + step] : undefined;
    if (row) {
      const stop = stopInRow(row, goal ?? row.glyphs[0]!.x0, graphemeStops(text));
      place(store, ctx, stop.offset, extend, { upstream: stop.upstream, goalX: goal });
      return;
    }
    // Past the paragraph's first or last row.
    const edge = step < 0 ? 0 : text.length;
    const next = extend ? null : adjacentPara(store, ctx.state, editing.para, step);
    if (next) await enterPara(store, ctx, next, step, goal);
    else place(store, ctx, edge, extend, { goalX: goal });
  });
}

/** Home / End: the start or end of the caret's row; with `paragraph`, of the paragraph. */
function lineEdge(store: DocsStore, end: boolean, paragraph: boolean, extend: boolean): void {
  queue(store, async () => {
    const ctx = await context(store);
    if (!ctx) return;
    const { editing, layout, text } = ctx;
    const pos = layout && !paragraph ? caretAt(layout, focusOf(editing), editing.upstream) : null;
    const row = pos && layout ? layout.rows[pos.row] : undefined;
    if (!row) place(store, ctx, end ? text.length : 0, extend);
    else place(store, ctx, end ? row.end : row.start, extend, { upstream: end });
  });
}

/** Backspace / Delete: the selection, else one grapheme, a word (`word`) or to the row start (`line`). */
function erase(store: DocsStore, step: -1 | 1, word: boolean, line: boolean): void {
  const run = async () => {
    const editing = store.ui.editing;
    if (!editing || editing.mode !== "caret") return;
    const { text, selStart, selEnd } = editing;
    if (selEnd > selStart) {
      editText(store, selStart, selEnd, "");
      return;
    }
    if (step < 0 && selStart === 0) {
      await mergeParagraph(store, -1);
      return;
    }
    if (step > 0 && selStart === text.length) {
      await mergeParagraph(store, 1);
      return;
    }
    if (line) {
      const ctx = await context(store);
      if (!ctx) return;
      const pos = ctx.layout ? caretAt(ctx.layout, selStart, ctx.editing.upstream) : null;
      const row = pos && ctx.layout ? ctx.layout.rows[pos.row] : undefined;
      const to = row ? (step < 0 ? row.start : row.end) : step < 0 ? 0 : ctx.text.length;
      if (to !== selStart) editText(store, Math.min(to, selStart), Math.max(to, selStart), "");
      return;
    }
    const to = word
      ? step < 0
        ? wordLeft(text, selStart)
        : wordRight(text, selStart)
      : step < 0
        ? prevGrapheme(text, selStart)
        : nextGrapheme(text, selStart);
    editText(store, Math.min(to, selStart), Math.max(to, selStart), "");
  };
  if (registry(store).busy > 0 || line) queue(store, run);
  else void run();
}

/** Insert typed or pasted single-line text at the selection. */
function insert(store: DocsStore, text: string): void {
  const run = () => {
    const editing = store.ui.editing;
    if (editing?.mode === "caret") editText(store, editing.selStart, editing.selEnd, text);
  };
  if (registry(store).busy > 0) queue(store, run);
  else run();
}

function selectAll(store: DocsStore): void {
  queue(store, async () => {
    const ctx = await context(store);
    if (!ctx) return;
    store.patchEditing({ selStart: 0, selEnd: ctx.text.length, backward: false, upstream: true, goalX: null });
  });
}

// ---------------------------------------------------------------------------
// Keys (this table dispatches them and is the plugin's shortcut list)
// ---------------------------------------------------------------------------

const TYPING = "while typing in a paragraph";
const on = (
  keys: string,
  label: string,
  group: string,
  run: (store: DocsStore, extend: boolean) => unknown,
  extend = false,
): Binding => ({
  keys,
  label,
  group,
  when: TYPING,
  extend,
  run: ({ store }, ext) => void run(store, ext),
});

export const CARET_KEYS: readonly Binding[] = [
  on("ArrowLeft", "Previous character", "Caret", (s, x) => horizontal(s, -1, false, x), true),
  on("ArrowRight", "Next character", "Caret", (s, x) => horizontal(s, 1, false, x), true),
  on(`${WORD}+ArrowLeft`, "Previous word start", "Caret", (s, x) => horizontal(s, -1, true, x), true),
  on(`${WORD}+ArrowRight`, "Next word end", "Caret", (s, x) => horizontal(s, 1, true, x), true),
  on("ArrowUp", "Line above (into the previous paragraph or page)", "Caret", (s, x) => vertical(s, -1, x), true),
  on("ArrowDown", "Line below (into the next paragraph or page)", "Caret", (s, x) => vertical(s, 1, x), true),
  on("Home", "Start of the line", "Caret", (s, x) => lineEdge(s, false, false, x), true),
  on("End", "End of the line", "Caret", (s, x) => lineEdge(s, true, false, x), true),
  on("Mod+Home", "Start of the paragraph", "Caret", (s, x) => lineEdge(s, false, true, x), true),
  on("Mod+End", "End of the paragraph", "Caret", (s, x) => lineEdge(s, true, true, x), true),
  ...(MAC
    ? [
        on("Mod+ArrowLeft", "Start of the line", "Caret", (s, x) => lineEdge(s, false, false, x), true),
        on("Mod+ArrowRight", "End of the line", "Caret", (s, x) => lineEdge(s, true, false, x), true),
        on("Mod+ArrowUp", "Start of the paragraph", "Caret", (s, x) => lineEdge(s, false, true, x), true),
        on("Mod+ArrowDown", "End of the paragraph", "Caret", (s, x) => lineEdge(s, true, true, x), true),
      ]
    : []),
  on("Mod+a", "Select the paragraph", "Caret", selectAll),
  on("Backspace", "Delete the previous character (at the start: join with the paragraph before)", "Typing", (s) =>
    erase(s, -1, false, false),
  ),
  on("Delete", "Delete the next character (at the end: join with the paragraph after)", "Typing", (s) =>
    erase(s, 1, false, false),
  ),
  on(`${WORD}+Backspace`, "Delete the previous word", "Typing", (s) => erase(s, -1, true, false)),
  on(`${WORD}+Delete`, "Delete the next word", "Typing", (s) => erase(s, 1, true, false)),
  ...(MAC ? [on("Mod+Backspace", "Delete to the start of the line", "Typing", (s) => erase(s, -1, false, true))] : []),
  on("Enter", "Split the paragraph", "Typing", (s) => queue(s, () => splitParagraph(s))),
  on("Shift+Enter", "Line break in the paragraph", "Typing", (s) => insert(s, "\n")),
  on("Mod+Enter", "Save the typing and stop editing", "Typing", (s) => s.commit(true)),
  on("Escape", "Save the typing and stop editing", "Typing", (s) => s.commit(true)),
  ...TAB_KEYS,
  on("Tab", "Tab character", "Typing", (s) => insert(s, "\t")),
  on("Mod+z", "Undo (pending typing is saved first)", "History", (s) => queue(s, () => s.undoRedo("undo"))),
  on("Mod+Shift+z", "Redo", "History", (s) => queue(s, () => s.undoRedo("redo"))),
  ...(MAC ? [] : [on("Mod+y", "Redo", "History", (s) => queue(s, () => s.undoRedo("redo")))]),
  // Handled by the browser as clipboard events (plain text).
  { keys: "Mod+c", label: "Copy the selected text", group: "Clipboard", when: TYPING },
  { keys: "Mod+x", label: "Cut the selected text", group: "Clipboard", when: TYPING },
  { keys: "Mod+v", label: "Paste plain text (several lines become paragraphs)", group: "Clipboard", when: TYPING },
  ...CHORD_KEYS,
];

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

function pointOn(store: DocsStore, clientX: number, clientY: number): { page: number; x: number; y: number } | null {
  let best: { page: number; x: number; y: number } | null = null;
  let distance = Infinity;
  for (const [page, { el, pxPerPt }] of registry(store).layers) {
    const r = el.getBoundingClientRect();
    const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    if (d < distance) {
      distance = d;
      best = { page, x: (clientX - r.left) / pxPerPt, y: (clientY - r.top) / pxPerPt };
    }
  }
  return best;
}

/**
 * Mouse down on a paragraph of page `page`: place the caret (engine hit
 * test), select a word (double click) or the paragraph (triple click), or
 * extend the selection (Shift). A drag that follows extends the selection
 * inside the paragraph it started in.
 */
export function caretPointerDown(store: DocsStore, page: number, id: Address, event: MouseEvent): void {
  const at = pointOn(store, event.clientX, event.clientY);
  if (!at) return;
  const clicks = event.detail;
  const shift = event.shiftKey;
  const drag: {
    up: boolean;
    para: Address | null;
    layout: CaretLayout | null;
    text: string;
    anchor: number;
    clamped: boolean;
    last: MouseEvent | null;
  } = {
    up: false,
    para: null,
    layout: null,
    text: "",
    anchor: 0,
    clamped: false,
    last: null,
  };
  // Told once the button is up: a notice appearing mid-drag would move the page under the pointer.
  const tell = () => {
    if (drag.up && drag.clamped)
      store.info("A selection stays inside one paragraph: it ends at the edge of the paragraph it started in.");
  };
  const moveTo = (ev: MouseEvent) => {
    const editing = store.ui.editing;
    if (!drag.layout || !editing || editing.para !== drag.para) return;
    const p = pointOn(store, ev.clientX, ev.clientY);
    if (!p) return;
    const stop = stopAt(drag.layout, p.page, p.x, p.y, graphemeStops(drag.text));
    const pos = caretAt(drag.layout, stop.offset, stop.upstream);
    store.patchEditing({
      selStart: Math.min(drag.anchor, stop.offset),
      selEnd: Math.max(drag.anchor, stop.offset),
      backward: stop.offset < drag.anchor,
      upstream: stop.upstream,
      goalX: null,
      page: pos?.page ?? editing.page,
    });
    drag.clamped = stop.outside;
  };
  const onMove = (ev: MouseEvent) => {
    if (drag.layout) moveTo(ev);
    else drag.last = ev;
  };
  const onUp = () => {
    drag.up = true;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (drag.layout) tell();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  queue(store, async () => {
    const open = store.ui.editing;
    if (open && open.text !== open.base) await store.commit(false);
    const state = store.host.getSnapshot().state;
    const kernel = store.host.kernel;
    if (!state || !isReactorKernel(kernel)) return;
    const editing = store.ui.editing;
    if (shift && editing?.mode === "caret") {
      const ctx = await context(store);
      if (!ctx) return;
      const stop = ctx.layout
        ? stopAt(ctx.layout, at.page, at.x, at.y, graphemeStops(ctx.text))
        : { offset: 0, upstream: false, outside: false };
      place(store, ctx, stop.offset, true, { upstream: stop.upstream });
      Object.assign(drag, {
        para: ctx.editing.para,
        layout: ctx.layout,
        text: ctx.text,
        anchor: anchorOf(ctx.editing),
      });
    } else {
      const hit = await kernel.hitTest(state.doc, at.page, at.x, at.y).catch(() => null);
      const target = hit?.object_id && store.host.node(hit.object_id)?.kind === "paragraph" ? hit.object_id : id;
      const result = await loadLayout(store.host, state, target);
      if (result.kind === "unusable") {
        store.startEdit(target, at.page, null, "box");
        store.info(
          `Exact caret positions are not available for this paragraph (${result.reason}); it opens in the text box editor.`,
        );
        return;
      }
      const layout = result.kind === "ok" ? result.layout : null;
      const text = result.kind === "ok" ? result.text : "";
      const local = layout
        ? stopAt(layout, at.page, at.x, at.y, graphemeStops(text))
        : { offset: 0, upstream: false, outside: false };
      const offset =
        hit?.object_id === target && typeof hit.offset === "number" ? Math.min(hit.offset, text.length) : local.offset;
      const upstream = local.offset === offset && local.upstream;
      let [start, end] = [offset, offset];
      if (clicks === 2) [start, end] = wordAt(text, offset);
      else if (clicks >= 3) [start, end] = [0, text.length];
      const same = editing?.mode === "caret" && editing.para === target;
      if (!same) store.startEdit(target, at.page, offset);
      const pos = layout ? caretAt(layout, end, upstream) : null;
      store.patchEditing({
        base: text,
        text,
        selStart: start,
        selEnd: end,
        backward: false,
        upstream,
        goalX: null,
        page: pos?.page ?? at.page,
      });
      Object.assign(drag, { para: target, layout, text, anchor: start });
    }
    // A drag that moved (and maybe ended) while the layout loaded still selects to its last point.
    if (clicks > 1) return;
    if (drag.last) moveTo(drag.last);
    tell();
  });
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

type Box = { left: number; top: number; width: number; height: number };

type Composition = { value: string; start: number; end: number; caret: number };

function deepActive(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** Layout of the open editor's paragraph; while the next revision's layout loads, the previous one of the same editor session. */
function useEditorLayout(host: EditorHost, state: DocState, editing: Editing): LayoutResult | null {
  const key = keyOf(state, editing.para);
  const [, rerender] = useState(0);
  const last = useRef<{ session: number; result: LayoutResult } | null>(null);
  useEffect(() => {
    if (settled.has(key)) return;
    let live = true;
    void loadLayout(host, state, editing.para).then(() => {
      if (live) rerender((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [key]);
  const now = settled.get(key);
  if (now) {
    last.current = { session: editing.session, result: now };
    return now;
  }
  return last.current?.session === editing.session ? last.current.result : null;
}

/** Split the pending text at the caret and the composition range, for the inline preview. */
function previewPieces(
  text: string,
  caret: number | null,
  compose: [number, number] | null,
): { text: string; underline: boolean; caret: boolean }[] {
  const cuts = new Set([0, text.length]);
  if (caret !== null) cuts.add(caret);
  if (compose) {
    cuts.add(compose[0]);
    cuts.add(compose[1]);
  }
  const points = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const out: { text: string; underline: boolean; caret: boolean }[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (caret === p) out.push({ text: "", underline: false, caret: true });
    const q = points[i + 1];
    if (q === undefined) break;
    out.push({ text: text.slice(p, q), underline: !!compose && p >= compose[0] && q <= compose[1], caret: false });
  }
  return out;
}

type LayerProps = {
  store: DocsStore;
  host: EditorHost;
  state: DocState;
  editing: Editing;
  page: number;
  pxPerPt: number;
  /** The paragraph's boxes on this page (CSS px). */
  boxes: Box[];
};

/** Caret, selection and pending-text preview of the open editor on one page; the caret's page also holds the hidden textarea. */
export function CaretLayer({ store, host, state, editing, page, pxPerPt, boxes }: LayerProps) {
  const result = useEditorLayout(host, state, editing);
  const ime = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<HTMLElement | null>(null);
  const setCaretRef = (el: HTMLElement | null) => {
    caretRef.current = el;
  };
  const composing = useRef<{ start: number; rest: number } | null>(null);
  const [compose, setCompose] = useState<Composition | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (result?.kind === "unusable") fallBack(store, result.reason);
  }, [result]);

  const layout = result?.kind === "ok" ? result.layout : null;
  const laidText = result?.kind === "ok" ? result.text : "";
  // The view cut the paragraph's text: edit the full text the layout came from.
  useEffect(() => {
    if (
      result?.kind === "ok" &&
      editing.text === editing.base &&
      result.text !== editing.base &&
      sameStoredText(editing.base, result.text)
    ) {
      store.patchEditing({ base: result.text, text: result.text });
    }
  }, [result, editing.base]);

  const ready = result !== null && result.kind !== "unusable";
  const display = compose?.value ?? editing.text;
  // Text the engine has not laid out yet (pending typing, composition, or a revision whose layout is loading).
  const change = ready && display !== laidText ? changedRange(laidText, display) : null;
  const focus = compose ? compose.caret : focusOf(editing);
  const box = boxes[0];
  const boxCaret: CaretPos | null = box
    ? { row: 0, page, x: box.left / pxPerPt, top: box.top / pxPerPt, bottom: (box.top + box.height) / pxPerPt }
    : null;
  // A paragraph without text: the caret at the start of its box on the editor's page.
  const own = editing.page === page ? boxCaret : null;
  const anchorPos = change ? (layout ? caretAt(layout, change.start, editing.upstream) : own) : null;
  const caretPos = !ready ? null : change ? anchorPos : layout ? caretAt(layout, focus, editing.upstream) : own;
  // The textarea sits on the caret's page; while the first layout loads, on the editor's page at the paragraph box.
  const imeHere = layout && caretPos ? caretPos.page === page : editing.page === page;
  const imePos = caretPos ?? boxCaret;
  const caretKey = caretPos ? `${caretPos.page}:${caretPos.x}:${caretPos.top}:${focus}:${display.length}` : "";

  // Keep the textarea's value and selection on the editor's (typing goes in at the right place).
  useLayoutEffect(() => {
    const el = ime.current;
    if (!el || composing.current) return;
    if (el.value !== editing.text) el.value = editing.text;
    if (el.selectionStart !== editing.selStart || el.selectionEnd !== editing.selEnd) {
      el.setSelectionRange(editing.selStart, editing.selEnd, editing.backward ? "backward" : "forward");
    }
  });

  // A new editor, or the caret moved onto this page: the textarea takes the focus.
  useLayoutEffect(() => {
    if (imeHere) ime.current?.focus({ preventScroll: true });
  }, [imeHere, editing.session]);

  // After a toolbar button took the focus to act on the selection, typing continues here.
  useLayoutEffect(() => {
    const el = ime.current;
    const active = deepActive();
    if (!el || active === el) return;
    if (
      !active ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.closest("[data-we-docs-keep]"))
    )
      el.focus({ preventScroll: true });
  }, [editing.para, editing.selStart, editing.selEnd, editing.text]);

  useLayoutEffect(() => {
    if (imeHere && focused) caretRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [caretKey, imeHere, focused]);

  if (result?.kind === "unusable") return null;

  const px = (pt: number) => `${pt * pxPerPt}px`;
  const selection =
    ready && !change && layout && editing.selEnd > editing.selStart
      ? rangeRects(layout, editing.selStart, editing.selEnd).filter((r) => r.page === page)
      : [];
  const masks =
    change && layout && change.end > change.start
      ? rangeRects(layout, change.start, change.end).filter((r) => r.page === page)
      : [];
  const caretClass = `we-docs-caret${focused ? "" : " we-docs-caret-idle"}`;

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const el = ime.current;
    const now = store.ui.editing;
    if (!el || !now) return;
    if (registry(store).busy === 0 && (el.selectionStart !== now.selStart || el.selectionEnd !== now.selEnd))
      el.setSelectionRange(now.selStart, now.selEnd);
    if (dispatch(CARET_KEYS, { store, event: e })) return;
    // A character typed while earlier keys still wait for the engine goes in after them.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && [...e.key].length === 1 && registry(store).busy > 0) {
      e.preventDefault();
      insert(store, e.key);
    }
  };

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    if (composing.current) {
      const c = composing.current;
      setCompose({ value: el.value, start: c.start, end: c.start + el.value.length - c.rest, caret: el.selectionEnd });
      return;
    }
    if (el.value === store.ui.editing?.text) return;
    store.input(el.value, el.selectionStart, el.selectionEnd);
    store.patchEditing({ backward: false, upstream: false, goalX: null });
  };

  const onCompositionStart = () => {
    const el = ime.current!;
    composing.current = { start: el.selectionStart, rest: el.value.length - (el.selectionEnd - el.selectionStart) };
    setCompose({ value: el.value, start: el.selectionStart, end: el.selectionStart, caret: el.selectionStart });
  };

  const onCompositionEnd = () => {
    const el = ime.current!;
    composing.current = null;
    setCompose(null);
    // Nothing reaches the engine before the composition ends.
    if (el.value !== store.ui.editing?.text) {
      store.input(el.value, el.selectionStart, el.selectionEnd);
      store.patchEditing({ backward: false, upstream: false, goalX: null });
    }
  };

  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    const now = store.ui.editing;
    e.preventDefault();
    if (!now || now.selEnd <= now.selStart || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", now.text.slice(now.selStart, now.selEnd));
    if (cut) erase(store, -1, false, false);
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = cleanText(e.clipboardData?.getData("text/plain") ?? "");
    if (!text) return;
    const lines = text.split("\n");
    if (lines.length === 1) insert(store, text);
    else queue(store, () => pasteLines(store, lines));
  };

  const onBlur = (e: FocusEvent) => {
    setFocused(false);
    const session = editing.session;
    const next = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    // Toolbar controls marked as keepers act on the selection: commit typing, stay open.
    if (next?.closest("[data-we-docs-keep]")) {
      void store.commit(false);
      return;
    }
    setTimeout(() => {
      const now = store.ui.editing;
      if (!now || now.session !== session || now.mode !== "caret") return;
      // The caret moved to another page: that page's textarea has the focus now.
      if (deepActive()?.classList.contains("we-docs-ime")) return;
      void store.commit(true);
    }, 0);
  };

  const snippet = editing.text.trim().slice(0, 60);
  const caretHere = caretPos !== null && caretPos.page === page;
  const inChip = change !== null && focus >= change.start && focus <= change.start + change.text.length;
  const chipPieces =
    change && anchorPos?.page === page
      ? previewPieces(
          change.text,
          inChip ? focus - change.start : null,
          compose ? [compose.start - change.start, compose.end - change.start] : null,
        )
      : null;

  return (
    <>
      {selection.length > 0 && (
        <div
          class="we-docs-selection"
          data-testid="docs-selection"
          data-start={editing.selStart}
          data-end={editing.selEnd}
        >
          {selection.map((r, i) => (
            <div
              key={i}
              class="we-docs-selection-rect"
              data-testid="docs-selection-rect"
              style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }}
            />
          ))}
        </div>
      )}
      {masks.map((r, i) => (
        <div
          key={`m${i}`}
          class="we-docs-pending-mask"
          style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }}
        />
      ))}
      {chipPieces && anchorPos && (
        <div
          class="we-docs-pending"
          data-testid="docs-pending"
          style={{
            left: px(anchorPos.x),
            top: px(anchorPos.top),
            height: px(anchorPos.bottom - anchorPos.top),
            lineHeight: px(anchorPos.bottom - anchorPos.top),
            fontSize: px((anchorPos.bottom - anchorPos.top) * 0.8),
            fontFamily: EDITOR_FONT,
          }}
        >
          {chipPieces.map((piece, i) =>
            piece.caret ? (
              <span
                key={i}
                ref={setCaretRef}
                class={`${caretClass} we-docs-caret-inline`}
                data-testid="docs-caret"
                data-offset={focus}
                data-address={editing.para}
              />
            ) : (
              <span key={i} class={piece.underline ? "we-docs-compose" : undefined}>
                {piece.text}
              </span>
            ),
          )}
        </div>
      )}
      {caretHere && !chipPieces && (
        <div
          key={caretKey}
          ref={setCaretRef}
          class={caretClass}
          data-testid="docs-caret"
          data-offset={focus}
          data-address={editing.para}
          aria-hidden="true"
          style={{ left: px(caretPos.x), top: px(caretPos.top), height: px(caretPos.bottom - caretPos.top) }}
        />
      )}
      {imeHere && imePos && (
        <textarea
          ref={ime}
          class="we-docs-ime"
          data-testid="docs-ime"
          data-address={editing.para}
          aria-label={snippet ? `Editing paragraph: ${snippet}` : "Editing an empty paragraph"}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          {...{ autocorrect: "off" }}
          style={{
            left: px(imePos.x),
            top: px(imePos.top),
            height: px(imePos.bottom - imePos.top),
            fontSize: px((imePos.bottom - imePos.top) * 0.8),
          }}
          onKeyDown={onKeyDown}
          onInput={onInput}
          // Lower-case names: Chromium has no `oncompositionstart` property, so Preact would keep `CompositionStart`.
          {...{ oncompositionstart: onCompositionStart, oncompositionend: onCompositionEnd }}
          onCopy={(e) => onCopy(e, false)}
          onCut={(e) => onCopy(e, true)}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={onBlur}
        />
      )}
    </>
  );
}
