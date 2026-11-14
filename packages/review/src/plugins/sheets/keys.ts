/**
 * The plugin's keyboard table. One list drives both the dispatch (grid keys
 * through `SheetsStore.handleKey`, editor keys through the cell editor and
 * the formula bar) and the declarative `EditorPlugin.shortcuts` the shell
 * lists. Entries without `run` are handled by the browser: copy, cut and
 * paste arrive as clipboard events (`SheetsStore.onCopy` / `onPaste`).
 *
 * Keys use the core form `Mod+Shift+K` (`Mod`: Cmd on macOS, Ctrl
 * elsewhere; key names per `KeyboardEvent.key`).
 */
import type { Shortcut } from "../../host/index.ts";
import type { SheetsStore } from "./store.ts";

export type KeyContext = {
  store: SheetsStore;
  event: KeyboardEvent;
  /** Opens the cell context menu at the active cell (grid focus only). */
  openMenu?: () => void;
};

export type Binding = Shortcut & {
  /** Handles the key; false lets it through (a disabled control, nothing to do). */
  run?: (ctx: KeyContext) => boolean;
};

type Parsed = { mod: boolean; shift: boolean; alt: boolean; key: string };

function parse(keys: string): Parsed {
  const parts = keys.split("+");
  // `Mod++` would name the plus key; none is bound here.
  const key = parts.pop()!;
  return { mod: parts.includes("Mod"), shift: parts.includes("Shift"), alt: parts.includes("Alt"), key };
}

/** Whether `event` is exactly the combination `keys`. Letter keys compare
 * case-insensitively (Shift turns `z` into `Z`). */
export function matches(keys: string, event: KeyboardEvent): boolean {
  const p = parse(keys);
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const want = p.key.length === 1 ? p.key.toLowerCase() : p.key;
  return (
    key === want && p.mod === (event.metaKey || event.ctrlKey) && p.shift === event.shiftKey && p.alt === event.altKey
  );
}

/** Run the first binding of `table` matching the event; false when none
 * matched or the matching one let the key through. */
export function dispatch(table: readonly Binding[], ctx: KeyContext): boolean {
  for (const b of table) if (b.run && matches(b.keys, ctx.event)) return b.run(ctx);
  return false;
}

const ARROWS: [string, number, number][] = [
  ["ArrowUp", -1, 0],
  ["ArrowDown", 1, 0],
  ["ArrowLeft", 0, -1],
  ["ArrowRight", 0, 1],
];
const ARROW_NAME: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

const NAV = "Navigation";
const SEL = "Selection";
const EDIT = "Editing";
const CELLS = "Cells";
const FMT = "Formatting";
const HIST = "History";

const always = (fn: (ctx: KeyContext) => void) => (ctx: KeyContext) => {
  fn(ctx);
  return true;
};

/** Keys on the grid (not while a cell or the formula bar is being edited). */
export const GRID_KEYS: readonly Binding[] = [
  ...ARROWS.flatMap(([key, dr, dc]): Binding[] => [
    {
      keys: key,
      label: `Move ${ARROW_NAME[key]} (over a merged range as one cell)`,
      group: NAV,
      run: always(({ store }) => store.arrowKey(dr, dc, false, false)),
    },
    {
      keys: `Shift+${key}`,
      label: `Extend the selection ${ARROW_NAME[key]}`,
      group: SEL,
      run: always(({ store }) => store.arrowKey(dr, dc, true, false)),
    },
    {
      keys: `Mod+${key}`,
      label: `Jump ${ARROW_NAME[key]} to the edge of the data`,
      group: NAV,
      run: always(({ store }) => store.arrowKey(dr, dc, false, true)),
    },
    {
      keys: `Mod+Shift+${key}`,
      label: `Extend the selection ${ARROW_NAME[key]} to the edge of the data`,
      group: SEL,
      run: always(({ store }) => store.arrowKey(dr, dc, true, true)),
    },
  ]),
  {
    keys: "Tab",
    label: "Move right (within a selected range)",
    group: NAV,
    run: always(({ store }) => store.moveActive(0, 1, true)),
  },
  {
    keys: "Shift+Tab",
    label: "Move left (within a selected range)",
    group: NAV,
    run: always(({ store }) => store.moveActive(0, -1, true)),
  },
  {
    keys: "Enter",
    label: "Move down (within a selected range)",
    group: NAV,
    run: always(({ store }) => store.moveActive(1, 0, true)),
  },
  {
    keys: "Shift+Enter",
    label: "Move up (within a selected range)",
    group: NAV,
    run: always(({ store }) => store.moveActive(-1, 0, true)),
  },
  {
    keys: "Home",
    label: "Go to the start of the row",
    group: NAV,
    run: always(({ store }) => store.homeKey(false, false)),
  },
  {
    keys: "Shift+Home",
    label: "Extend the selection to the start of the row",
    group: SEL,
    run: always(({ store }) => store.homeKey(false, true)),
  },
  { keys: "Mod+Home", label: "Go to A1", group: NAV, run: always(({ store }) => store.homeKey(true, false)) },
  {
    keys: "Mod+Shift+Home",
    label: "Extend the selection to A1",
    group: SEL,
    run: always(({ store }) => store.homeKey(true, true)),
  },
  {
    keys: "End",
    label: "Go to the last value in the row",
    group: NAV,
    run: always(({ store }) => store.endKey(false, false)),
  },
  {
    keys: "Shift+End",
    label: "Extend the selection to the last value in the row",
    group: SEL,
    run: always(({ store }) => store.endKey(false, true)),
  },
  {
    keys: "Mod+End",
    label: "Go to the last used cell",
    group: NAV,
    run: always(({ store }) => store.endKey(true, false)),
  },
  {
    keys: "Mod+Shift+End",
    label: "Extend the selection to the last used cell",
    group: SEL,
    run: always(({ store }) => store.endKey(true, true)),
  },
  { keys: "PageDown", label: "Move down one screen", group: NAV, run: always(({ store }) => store.pageKey(1, false)) },
  { keys: "PageUp", label: "Move up one screen", group: NAV, run: always(({ store }) => store.pageKey(-1, false)) },
  {
    keys: "Shift+PageDown",
    label: "Extend the selection down one screen",
    group: SEL,
    run: always(({ store }) => store.pageKey(1, true)),
  },
  {
    keys: "Shift+PageUp",
    label: "Extend the selection up one screen",
    group: SEL,
    run: always(({ store }) => store.pageKey(-1, true)),
  },
  {
    keys: "Mod+a",
    label: "Select the used range; again for the whole sheet",
    group: SEL,
    run: always(({ store }) => store.selectAll()),
  },
  { keys: "F2", label: "Edit the active cell", group: EDIT, run: always(({ store }) => store.beginEdit(null)) },
  {
    keys: "Delete",
    label: "Clear the selected cells",
    group: CELLS,
    run: always(({ store }) => store.clearSelection()),
  },
  {
    keys: "Backspace",
    label: "Clear the selected cells",
    group: CELLS,
    run: always(({ store }) => store.clearSelection()),
  },
  { keys: "Mod+c", label: "Copy the selection (tab-separated text)", group: CELLS },
  { keys: "Mod+x", label: "Cut the selection (cleared when pasted)", group: CELLS },
  { keys: "Mod+v", label: "Paste (formulas rebased when copied in this workbook)", group: CELLS },
  {
    keys: "Escape",
    label: "Remove the copy marquee",
    group: CELLS,
    when: "after copy or cut",
    run: ({ store }) => !!store.clip && (store.clearClip(), true),
  },
  {
    keys: "Mod+d",
    label: "Fill down",
    group: CELLS,
    run: ({ store }) => !store.isDisabled("fill-down") && (store.fill("down"), true),
  },
  {
    keys: "Mod+r",
    label: "Fill right",
    group: CELLS,
    run: ({ store }) => !store.isDisabled("fill-right") && (store.fill("right"), true),
  },
  {
    keys: "Mod+k",
    label: "Insert or edit a link",
    group: CELLS,
    run: ({ store }) => !store.isDisabled("hyperlink") && (store.openLinkDialog(), true),
  },
  {
    keys: "Mod+b",
    label: "Bold",
    group: FMT,
    run: ({ store }) => !store.isDisabled("bold") && (store.toggleBold(), true),
  },
  {
    keys: "Mod+i",
    label: "Italic",
    group: FMT,
    run: ({ store }) => !store.isDisabled("italic") && (store.toggleItalic(), true),
  },
  { keys: "Mod+z", label: "Undo", group: HIST, run: always(({ store }) => void store.host.undo()) },
  { keys: "Mod+Shift+z", label: "Redo", group: HIST, run: always(({ store }) => void store.host.redo()) },
  { keys: "Mod+y", label: "Redo", group: HIST, run: always(({ store }) => void store.host.redo()) },
  {
    keys: "Shift+F10",
    label: "Open the cell menu",
    group: CELLS,
    when: "grid focused",
    run: ({ openMenu }) => !!openMenu && (openMenu(), true),
  },
  {
    keys: "ContextMenu",
    label: "Open the cell menu",
    group: CELLS,
    when: "grid focused",
    run: ({ openMenu }) => !!openMenu && (openMenu(), true),
  },
];

const IN_CELL = "editing in the cell";
const EDITING = "editing a cell or the formula bar";

/** Keys while a cell is being edited (the in-cell editor; the formula bar
 * takes the entries without `cellOnly`). */
export const EDIT_KEYS: readonly (Binding & { cellOnly?: boolean })[] = [
  {
    keys: "Enter",
    label: "Commit and move down",
    group: EDIT,
    when: EDITING,
    run: always(({ store }) => store.commitEdit({ dr: 1, dc: 0 })),
  },
  {
    keys: "Shift+Enter",
    label: "Commit and move up",
    group: EDIT,
    when: EDITING,
    run: always(({ store }) => store.commitEdit({ dr: -1, dc: 0 })),
  },
  {
    keys: "Tab",
    label: "Commit and move right",
    group: EDIT,
    when: EDITING,
    run: always(({ store }) => store.commitEdit({ dr: 0, dc: 1 })),
  },
  {
    keys: "Shift+Tab",
    label: "Commit and move left",
    group: EDIT,
    when: EDITING,
    run: always(({ store }) => store.commitEdit({ dr: 0, dc: -1 })),
  },
  {
    keys: "Escape",
    label: "Cancel the edit",
    group: EDIT,
    when: EDITING,
    run: always(({ store }) => store.cancelEdit()),
  },
  {
    keys: "Alt+Enter",
    label: "New line in the cell",
    group: EDIT,
    when: IN_CELL,
    cellOnly: true,
    run: always(({ store, event }) => store.insertEditNewline(event.target)),
  },
  {
    keys: "F2",
    label: "Switch between enter mode (arrows commit) and edit mode (arrows move the caret)",
    group: EDIT,
    when: IN_CELL,
    cellOnly: true,
    run: ({ store }) => store.toggleEditMode(),
  },
  ...ARROWS.map(([key, dr, dc]) => ({
    keys: key,
    label: `Commit and move ${ARROW_NAME[key]}`,
    group: EDIT,
    when: "typing over a cell (enter mode)",
    cellOnly: true,
    run: ({ store }: KeyContext) => store.editing?.mode === "enter" && (store.commitEdit({ dr, dc }), true),
  })),
];

/** Formula bar: the editor keys that apply outside the cell. */
export const BAR_KEYS: readonly Binding[] = EDIT_KEYS.filter((b) => !b.cellOnly);

/** `EditorPlugin.shortcuts`: the table without its handlers. */
export const SHORTCUTS: Shortcut[] = [...GRID_KEYS, ...EDIT_KEYS].map(({ keys, label, group, when }) => ({
  keys,
  label,
  group: group ? `Sheets: ${group}` : "Sheets",
  ...(when ? { when } : {}),
}));
