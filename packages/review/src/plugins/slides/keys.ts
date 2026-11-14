/**
 * The plugin's keyboard tables. Each table drives its dispatch and the
 * declarative `EditorPlugin.shortcuts` the shell lists, so they cannot
 * drift:
 * - `SLIDE_KEYS`: the plugin's `onKeyDown` (shapes and cells on the slide);
 * - `CARET_KEYS`: the caret text editor (CaretEditor.tsx);
 * - `RAIL_KEYS`, `SHOW_KEYS`: the slide list and the slide show
 *   (LeftRail.tsx, SlideShow.tsx);
 * - `BOX_CLOSE`, `BOX_SAVE`: the editing box (TextEditor.tsx matches them).
 * Entries without `run` are handled by the browser: copy, cut and paste
 * arrive as clipboard events.
 *
 * Keys use the core form `Mod+Shift+K` (`Mod`: Cmd on macOS, Ctrl
 * elsewhere; key names per `KeyboardEvent.key`). Word and line moves differ
 * per platform, so the caret table is built for the running one.
 */
import type { EditorHost, Shortcut } from "../../host/index.ts";
import {
  beginTextEdit,
  canEditText,
  copyShapes,
  currentSlide,
  cycleShapes,
  deleteSelection,
  duplicateShapes,
  formatTargets,
  notify,
  nudge,
  restackShapes,
  selectedCells,
  selectedShapes,
  stepShapes,
  toggleFont,
} from "./actions.ts";
import { storeOf } from "./store.ts";

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type Binding<C> = Shortcut & {
  /** Handles the key; false lets it through (nothing to do). */
  run?: (ctx: C, event: KeyboardEvent) => boolean;
};

/** Whether `event` is exactly the combination `keys`. Letter keys compare
 * case-insensitively (Shift turns `z` into `Z`). */
export function matches(keys: string, event: KeyboardEvent): boolean {
  const parts = keys.split("+");
  const key = parts.pop()!;
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  const other = IS_MAC ? event.ctrlKey : event.metaKey;
  if (
    parts.includes("Mod") !== mod ||
    other ||
    parts.includes("Shift") !== event.shiftKey ||
    parts.includes("Alt") !== event.altKey
  )
    return false;
  const got = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return got === (key.length === 1 ? key.toLowerCase() : key);
}

/** Run the first binding matching the event; false when none matched or
 * the matching one let the key through. */
export function dispatch<C>(table: readonly Binding<C>[], ctx: C, event: KeyboardEvent): boolean {
  for (const b of table) if (b.run && matches(b.keys, event)) return b.run(ctx, event);
  return false;
}

// ---------------------------------------------------------------------------
// Slide: shapes and cells
// ---------------------------------------------------------------------------

/** One CSS pixel at 100 % zoom in points (9525 EMU). */
const PX = 0.75;
const SHAPES = "Slides: Shapes";
const TEXT = "Slides: Text";
const VIEW = "Slides: Slides";

const arrows: [string, string, number, number][] = [
  ["ArrowLeft", "left", -1, 0],
  ["ArrowRight", "right", 1, 0],
  ["ArrowUp", "up", 0, -1],
  ["ArrowDown", "down", 0, 1],
];

const nudgeKeys = arrows.flatMap(([key, name, dx, dy]): Binding<EditorHost>[] =>
  [false, true].map((big) => ({
    keys: big ? `Shift+${key}` : key,
    label: `Nudge ${name} ${big ? "10 px" : "1 px"}`,
    group: SHAPES,
    when: "shapes selected",
    run: (host) => {
      if (!selectedShapes(host).length) return false;
      const step = (big ? 10 : 1) * PX;
      nudge(host, dx * step, dy * step);
      return true;
    },
  })),
);

function editSelected(host: EditorHost): boolean {
  const page = host.getSnapshot().currentPage;
  const cells = selectedCells(host);
  const shapes = selectedShapes(host);
  if (cells.length === 1) {
    beginTextEdit(host, cells[0]!.node.id, "cell", page);
    return true;
  }
  if (shapes.length !== 1) return false;
  if (!canEditText(shapes[0]!)) notify(host, `${shapes[0]!.label} has no editable text here.`);
  else beginTextEdit(host, shapes[0]!.id, "shape", page);
  return true;
}

const ready = (host: EditorHost) => !host.getSnapshot().busy;

/** The plugin's `onKeyDown` (no text entry focused, not presenting, not
 * editing text). */
export const SLIDE_KEYS: readonly Binding<EditorHost>[] = [
  {
    keys: "Escape",
    label: "Cancel insert, select the table of a cell, or clear the selection",
    group: SHAPES,
    run: (host) => {
      const store = storeOf(host);
      const cells = selectedCells(host);
      if (store.state.insert) store.set({ insert: null });
      else if (cells.length) host.select([cells[0]!.table.id]);
      else if (host.getSnapshot().selection.length) host.select([]);
      else return false;
      return true;
    },
  },
  {
    keys: "F5",
    label: "Present from the current slide",
    group: VIEW,
    run: (host) => (storeOf(host).set({ show: host.getSnapshot().currentPage }), true),
  },
  ...["Delete", "Backspace"].map((keys): Binding<EditorHost> => ({
    keys,
    label: "Delete the selected shapes",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => {
      if (!host.getSnapshot().selection.length || !ready(host)) return false;
      void deleteSelection(host);
      return true;
    },
  })),
  {
    keys: "Mod+a",
    label: "Select every shape on the slide",
    group: SHAPES,
    run: (host) => {
      const slide = currentSlide(host);
      if (!slide) return false;
      host.select(slide.shapes.map((s) => s.id));
      return true;
    },
  },
  {
    keys: "Mod+d",
    label: "Duplicate the selected shapes",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => {
      if (!selectedShapes(host).length || !ready(host)) return false;
      void duplicateShapes(host);
      return true;
    },
  },
  ...(["bold", "italic", "underline"] as const).map((kind): Binding<EditorHost> => ({
    keys: `Mod+${kind[0]}`,
    label: `${kind[0]!.toUpperCase()}${kind.slice(1)} (whole shape or cell)`,
    group: TEXT,
    when: "shapes or cells selected",
    run: (host) => {
      if (!formatTargets(host).length || !ready(host)) return false;
      void toggleFont(host, kind);
      return true;
    },
  })),
  {
    keys: "Mod+c",
    label: "Copy the selected shapes",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => copyShapes(host, false),
  },
  {
    keys: "Mod+x",
    label: "Cut the selected shapes",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => copyShapes(host, true),
  },
  { keys: "Mod+v", label: "Paste shapes, or an image as a picture", group: SHAPES },
  {
    keys: "Mod+Shift+ArrowUp",
    label: "Bring to front",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => (selectedShapes(host).length && ready(host) ? (void restackShapes(host, "front"), true) : false),
  },
  {
    keys: "Mod+ArrowUp",
    label: "Bring forward",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => (selectedShapes(host).length && ready(host) ? (void stepShapes(host, "forward"), true) : false),
  },
  {
    keys: "Mod+ArrowDown",
    label: "Send backward",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => (selectedShapes(host).length && ready(host) ? (void stepShapes(host, "backward"), true) : false),
  },
  {
    keys: "Mod+Shift+ArrowDown",
    label: "Send to back",
    group: SHAPES,
    when: "shapes selected",
    run: (host) => (selectedShapes(host).length && ready(host) ? (void restackShapes(host, "back"), true) : false),
  },
  ...[false, true].map((back): Binding<EditorHost> => ({
    keys: back ? "Shift+Tab" : "Tab",
    label: back ? "Select the previous shape" : "Select the next shape",
    group: SHAPES,
    when: "the slide has focus (not a control)",
    run: (host, event) => {
      // Keep Tab for focus movement among controls (toolbar, rail, menus).
      const origin = event.composedPath()[0] ?? event.target;
      const control =
        origin instanceof Element &&
        origin.closest("button, a[href], input, select, textarea, [role=toolbar], [role=menu], [role=listbox]");
      return !control && cycleShapes(host, back);
    },
  })),
  ...nudgeKeys,
  ...["Enter", "F2"].map((keys): Binding<EditorHost> => ({
    keys,
    label: "Edit the text of the selected shape or cell",
    group: TEXT,
    when: "one shape or cell selected",
    run: editSelected,
  })),
];

// ---------------------------------------------------------------------------
// Caret text editor
// ---------------------------------------------------------------------------

/** What the caret editor exposes to its key table. */
export type CaretActions = {
  leave(): void;
  selectAll(): void;
  undo(redo: boolean): void;
  format(kind: "bold" | "italic" | "underline"): void;
  /** Left/Right by grapheme (collapses a selection without Shift). */
  char(right: boolean, extend: boolean): void;
  word(right: boolean, extend: boolean): void;
  lineEdge(end: boolean, extend: boolean): void;
  textEdge(end: boolean, extend: boolean): void;
  vertical(down: boolean, extend: boolean): void;
  erase(forward: boolean, unit: "char" | "word" | "line"): void;
  insert(text: string): void;
  tab(back: boolean): void;
  isCell: boolean;
};

const CARET = "editing text on the slide";
const CARET_GROUP = "Slides: Text editing";
const WORD = IS_MAC ? "Alt" : "Mod";

function moves(
  keys: [string, string],
  labels: [string, string],
  run: (c: CaretActions, second: boolean, extend: boolean) => void,
): Binding<CaretActions>[] {
  return keys.flatMap((key, i) =>
    [false, true].map((extend) => ({
      keys: extend ? key.replace(/([^+]+)$/, "Shift+$1") : key,
      label: extend ? `Extend the selection: ${labels[i]!.toLowerCase()}` : labels[i]!,
      group: CARET_GROUP,
      when: CARET,
      run: (c: CaretActions) => (run(c, i === 1, extend), true),
    })),
  );
}

export const CARET_KEYS: readonly Binding<CaretActions>[] = [
  {
    keys: "Escape",
    label: "Leave text editing (the shape stays selected)",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.leave(), true),
  },
  { keys: "Mod+Enter", label: "Leave text editing", group: CARET_GROUP, when: CARET, run: (c) => (c.leave(), true) },
  {
    keys: "Mod+a",
    label: "Select all text of the shape or cell",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.selectAll(), true),
  },
  { keys: "Mod+z", label: "Undo", group: CARET_GROUP, when: CARET, run: (c) => (c.undo(false), true) },
  { keys: "Mod+Shift+z", label: "Redo", group: CARET_GROUP, when: CARET, run: (c) => (c.undo(true), true) },
  ...(IS_MAC
    ? []
    : [
        {
          keys: "Mod+y",
          label: "Redo",
          group: CARET_GROUP,
          when: CARET,
          run: (c: CaretActions) => (c.undo(true), true),
        },
      ]),
  ...(["bold", "italic", "underline"] as const).map((kind): Binding<CaretActions> => ({
    keys: `Mod+${kind[0]}`,
    label: `${kind[0]!.toUpperCase()}${kind.slice(1)} (the engine formats the whole shape or cell)`,
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.format(kind), true),
  })),
  { keys: "Mod+c", label: "Copy the selected text", group: CARET_GROUP, when: CARET },
  { keys: "Mod+x", label: "Cut the selected text", group: CARET_GROUP, when: CARET },
  { keys: "Mod+v", label: "Paste plain text (lines become paragraphs)", group: CARET_GROUP, when: CARET },
  ...moves(["ArrowLeft", "ArrowRight"], ["Previous character", "Next character"], (c, right, extend) =>
    c.char(right, extend),
  ),
  ...moves(
    [`${WORD}+ArrowLeft`, `${WORD}+ArrowRight`],
    ["Previous word", IS_MAC ? "End of the word" : "Next word"],
    (c, right, extend) => c.word(right, extend),
  ),
  ...moves(["ArrowUp", "ArrowDown"], ["Line above", "Line below"], (c, down, extend) => c.vertical(down, extend)),
  ...moves(["Home", "End"], ["Start of the line", "End of the line"], (c, end, extend) => c.lineEdge(end, extend)),
  ...(IS_MAC
    ? [
        ...moves(["Mod+ArrowLeft", "Mod+ArrowRight"], ["Start of the line", "End of the line"], (c, end, extend) =>
          c.lineEdge(end, extend),
        ),
        ...moves(["Mod+ArrowUp", "Mod+ArrowDown"], ["Start of the text", "End of the text"], (c, end, extend) =>
          c.textEdge(end, extend),
        ),
      ]
    : moves(["Mod+Home", "Mod+End"], ["Start of the text", "End of the text"], (c, end, extend) =>
        c.textEdge(end, extend),
      )),
  {
    keys: "Backspace",
    label: "Delete the previous character (joins paragraphs at a paragraph start)",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.erase(false, "char"), true),
  },
  {
    keys: "Delete",
    label: "Delete the next character",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.erase(true, "char"), true),
  },
  {
    keys: `${WORD}+Backspace`,
    label: "Delete the previous word",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.erase(false, "word"), true),
  },
  {
    keys: `${WORD}+Delete`,
    label: "Delete the next word",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.erase(true, "word"), true),
  },
  ...(IS_MAC
    ? [
        {
          keys: "Mod+Backspace",
          label: "Delete to the start of the line",
          group: CARET_GROUP,
          when: CARET,
          run: (c: CaretActions) => (c.erase(false, "line"), true),
        },
      ]
    : []),
  { keys: "Enter", label: "New paragraph", group: CARET_GROUP, when: CARET, run: (c) => (c.insert("\n"), true) },
  {
    keys: "Shift+Enter",
    label: "Line break within the paragraph",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.insert("\u000b"), true),
  },
  {
    keys: "Tab",
    label: "Next cell (in a table), else a tab character",
    group: CARET_GROUP,
    when: CARET,
    run: (c) => (c.isCell ? c.tab(false) : c.insert("\t"), true),
  },
  {
    keys: "Shift+Tab",
    label: "Previous cell",
    group: CARET_GROUP,
    when: `${CARET} in a table cell`,
    run: (c) => (c.isCell ? (c.tab(true), true) : false),
  },
];

// ---------------------------------------------------------------------------
// Keys handled by other elements
// ---------------------------------------------------------------------------

/** The editing box (TextEditor.tsx): command kernel, or text the caret
 * editor cannot take. */
export const BOX_CLOSE: Shortcut = {
  keys: "Escape",
  label: "Close the editing box (unsaved text is dropped)",
  group: TEXT,
  when: "in the text editing box",
};
export const BOX_SAVE: Shortcut = {
  keys: "Mod+Enter",
  label: "Save and close the editing box",
  group: TEXT,
  when: "in the text editing box",
};
const BOX_KEYS: readonly Shortcut[] = [BOX_CLOSE, BOX_SAVE];

/** What the slide list exposes to its key table (LeftRail.tsx); each
 * returns false when it has nothing to do. */
export type RailActions = {
  step(by: -1 | 1): boolean;
  move(by: -1 | 1): boolean;
  edge(end: boolean): boolean;
  remove(): boolean;
  duplicate(): boolean;
  menu(): boolean;
};

const RAIL = "in the slide list";

/** The slide list (LeftRail.tsx). */
export const RAIL_KEYS: readonly Binding<RailActions>[] = [
  ...(
    [
      ["ArrowUp", -1],
      ["PageUp", -1],
      ["ArrowDown", 1],
      ["PageDown", 1],
    ] as const
  ).flatMap(([key, by]): Binding<RailActions>[] => [
    { keys: key, label: by < 0 ? "Previous slide" : "Next slide", group: VIEW, when: RAIL, run: (r) => r.step(by) },
    ...["Mod", "Alt"].map((m) => ({
      keys: `${m}+${key}`,
      label: by < 0 ? "Move the slide up" : "Move the slide down",
      group: VIEW,
      when: RAIL,
      run: (r: RailActions) => r.move(by),
    })),
  ]),
  { keys: "Home", label: "First slide", group: VIEW, when: RAIL, run: (r) => r.edge(false) },
  { keys: "End", label: "Last slide", group: VIEW, when: RAIL, run: (r) => r.edge(true) },
  { keys: "Delete", label: "Delete the slide", group: VIEW, when: RAIL, run: (r) => r.remove() },
  { keys: "Backspace", label: "Delete the slide", group: VIEW, when: RAIL, run: (r) => r.remove() },
  { keys: "Mod+d", label: "Duplicate the slide", group: VIEW, when: RAIL, run: (r) => r.duplicate() },
  { keys: "Shift+F10", label: "Slide menu", group: VIEW, when: RAIL, run: (r) => r.menu() },
  { keys: "ContextMenu", label: "Slide menu", group: VIEW, when: RAIL, run: (r) => r.menu() },
];

/** What the slide show exposes to its key table (SlideShow.tsx). */
export type ShowActions = { step(by: -1 | 1): void; edge(end: boolean): void; close(): void };

/** The slide show (SlideShow.tsx). */
export const SHOW_KEYS: readonly Binding<ShowActions>[] = [
  ...["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].map((keys): Binding<ShowActions> => ({
    keys,
    label: "Next slide",
    group: VIEW,
    when: "presenting",
    run: (s) => (s.step(1), true),
  })),
  ...["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].map((keys): Binding<ShowActions> => ({
    keys,
    label: "Previous slide",
    group: VIEW,
    when: "presenting",
    run: (s) => (s.step(-1), true),
  })),
  { keys: "Home", label: "First slide", group: VIEW, when: "presenting", run: (s) => (s.edge(false), true) },
  { keys: "End", label: "Last slide", group: VIEW, when: "presenting", run: (s) => (s.edge(true), true) },
  { keys: "Escape", label: "End the slide show", group: VIEW, when: "presenting", run: (s) => (s.close(), true) },
];

const declared = ({ keys, label, group, when }: Shortcut): Shortcut => ({
  keys,
  label,
  ...(group ? { group } : {}),
  ...(when ? { when } : {}),
});

/** `EditorPlugin.shortcuts`: every table without its handlers. */
export const SHORTCUTS: Shortcut[] = [...SLIDE_KEYS, ...CARET_KEYS, ...BOX_KEYS, ...RAIL_KEYS, ...SHOW_KEYS].map(
  declared,
);
