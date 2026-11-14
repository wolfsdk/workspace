/**
 * The plugin's keyboard tables. Each table both dispatches its keys and
 * feeds the declarative `EditorPlugin.shortcuts` list (`listShortcuts`), so
 * the two cannot drift. This file holds the matching, the formatting chords
 * (shared by selection mode and both text editors) and the Tab keys; the
 * selection-mode, caret-editor and text-box tables sit next to their
 * handlers (`index.ts`, `CaretEditor.tsx`, `PageOverlay.tsx`).
 *
 * Keys use the core form `Mod+Shift+K` (`Mod`: Cmd on macOS, Ctrl
 * elsewhere; key names per `KeyboardEvent.key`). With Alt or Shift a
 * letter or digit also matches by physical key (`event.code`), because
 * those modifiers change `event.key` (Alt+1 is `¡` on a Mac keyboard).
 */
import type { Shortcut } from "../../host/index.ts";
import { applyHeading, indentParagraphs, tabToCell, toggleFont, toggleList, toggleUnderline } from "./actions.ts";
import type { Compose, DocsStore } from "./store.ts";

export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** The word-step modifier: Alt (Option) on macOS, Ctrl elsewhere. */
export const WORD = MAC ? "Alt" : "Mod";

export type KeyContext = { store: DocsStore; event: KeyboardEvent };

export type Binding<C extends KeyContext = KeyContext> = Shortcut & {
  /** Shift is optional and extends the selection; listed as a second `Shift+` row. */
  extend?: boolean;
  /** Handles the key (the default is then prevented); `false` lets it through.
   * Without `run` the browser handles the key (clipboard). */
  run?: (ctx: C, extend: boolean) => boolean | void;
};

type Parsed = { mod: boolean; alt: boolean; shift: boolean; key: string };
const parsed = new Map<string, Parsed>();

function parse(keys: string): Parsed {
  let p = parsed.get(keys);
  if (!p) {
    const parts = keys.split("+");
    const key = parts.pop()!;
    p = { mod: parts.includes("Mod"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), key };
    parsed.set(keys, p);
  }
  return p;
}

function physical(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return null;
}

/** Whether `event` is the combination `keys` (Shift optional when `extend`). */
export function matches(keys: string, event: KeyboardEvent, extend = false): boolean {
  const p = parse(keys);
  if (event.metaKey !== (MAC && p.mod) || event.ctrlKey !== (!MAC && p.mod) || event.altKey !== p.alt) return false;
  if (!extend && event.shiftKey !== p.shift) return false;
  if (p.key.length > 1) return event.key === p.key;
  if (event.key.toLowerCase() === p.key.toLowerCase()) return true;
  return (p.alt || p.shift || event.shiftKey) && event.code === physical(p.key);
}

/** Run the first binding of `table` that matches and accepts the key. */
export function dispatch<C extends KeyContext>(table: readonly Binding<C>[], ctx: C): boolean {
  const e = ctx.event;
  for (const b of table) {
    if (!b.run || !matches(b.keys, e, b.extend)) continue;
    if (b.run(ctx, b.extend === true && e.shiftKey) === false) continue;
    e.preventDefault();
    return true;
  }
  return false;
}

/** The declarative rows of `tables` for the shell (`Shift+` rows for extending bindings).
 * A binding shared by several tables (the chords, Tab) is listed once. */
export function listShortcuts(...tables: readonly (readonly Binding<never>[])[]): Shortcut[] {
  const rows: Shortcut[] = [];
  const seen = new Set<Binding<never>>();
  for (const table of tables) {
    for (const binding of table) {
      if (seen.has(binding)) continue;
      seen.add(binding);
      const { keys, label, group, when, extend } = binding;
      const row = (keys: string, label: string): Shortcut => ({
        keys,
        label,
        ...(group ? { group } : {}),
        ...(when ? { when } : {}),
      });
      rows.push(row(keys, label));
      if (extend) {
        const parts = keys.split("+");
        const key = parts.pop()!;
        rows.push(row([...parts, "Shift", key].join("+"), `${label}, extending the selection`));
      }
    }
  }
  return rows;
}

/** `Mod+Shift+7` for people: `Cmd+Shift+7` on macOS, `Ctrl+Shift+7` elsewhere. */
export function displayKeys(keys: string): string {
  return keys
    .split("+")
    .map((k) =>
      k === "Mod" ? (MAC ? "Cmd" : "Ctrl") : k === "Alt" && MAC ? "Option" : k.length === 1 ? k.toUpperCase() : k,
    )
    .join("+");
}

export function openFind(store: DocsStore): void {
  store.set({ find: { ...store.ui.find, open: true, focus: store.ui.find.focus + 1 } });
}

export function closeFind(store: DocsStore): void {
  store.set({ find: { ...store.ui.find, open: false } });
}

export function openCompose(store: DocsStore, mode: Compose): void {
  store.set({ compose: mode });
}

function hasTarget(store: DocsStore): boolean {
  return store.ui.editing !== null || store.host.getSnapshot().selection.length > 0;
}

/** A chord that acts on the selected paragraphs or the edited text; without either it passes. */
function onTarget(action: (store: DocsStore) => unknown): (ctx: KeyContext) => boolean {
  return ({ store }) => {
    if (!hasTarget(store)) return false;
    void action(store);
    return true;
  };
}

const TARGET = "with paragraphs selected or while editing text";

export const FIND_KEY: Binding = {
  keys: "Mod+f",
  label: "Find and replace",
  group: "Find",
  run: ({ store }) => openFind(store),
};

/** Formatting and insertion chords: selection mode and both text editors. */
export const CHORD_KEYS: readonly Binding[] = [
  FIND_KEY,
  { keys: "Mod+b", label: "Bold", group: "Formatting", when: TARGET, run: onTarget((s) => toggleFont(s, "bold")) },
  { keys: "Mod+i", label: "Italic", group: "Formatting", when: TARGET, run: onTarget((s) => toggleFont(s, "italic")) },
  { keys: "Mod+u", label: "Underline", group: "Formatting", when: TARGET, run: onTarget(toggleUnderline) },
  {
    keys: "Mod+Alt+1",
    label: "Heading 1",
    group: "Formatting",
    when: TARGET,
    run: onTarget((s) => applyHeading(s, 1)),
  },
  {
    keys: "Mod+Alt+2",
    label: "Heading 2",
    group: "Formatting",
    when: TARGET,
    run: onTarget((s) => applyHeading(s, 2)),
  },
  {
    keys: "Mod+Alt+3",
    label: "Heading 3",
    group: "Formatting",
    when: TARGET,
    run: onTarget((s) => applyHeading(s, 3)),
  },
  {
    keys: "Mod+Shift+7",
    label: "Numbered list on/off",
    group: "Formatting",
    when: TARGET,
    run: onTarget((s) => toggleList(s, "number")),
  },
  {
    keys: "Mod+Shift+8",
    label: "Bulleted list on/off",
    group: "Formatting",
    when: TARGET,
    run: onTarget((s) => toggleList(s, "bullet")),
  },
  {
    keys: "Mod+k",
    label: "Insert hyperlink",
    group: "Insert",
    when: TARGET,
    run: onTarget((s) => openCompose(s, "link")),
  },
  {
    keys: "Mod+Alt+m",
    label: "Add comment",
    group: "Insert",
    when: TARGET,
    run: onTarget((s) => openCompose(s, "comment")),
  },
];

/** Control titles: the chord of each toolbar action, as people read it. */
export const SHORTCUTS = {
  find: displayKeys("Mod+f"),
  bold: displayKeys("Mod+b"),
  italic: displayKeys("Mod+i"),
  underline: displayKeys("Mod+u"),
  link: displayKeys("Mod+k"),
  comment: displayKeys("Mod+Alt+m"),
  numbered: displayKeys("Mod+Shift+7"),
  bullets: displayKeys("Mod+Shift+8"),
} as const;

/** Handle a formatting chord. Returns true (and prevents the default) when it was one of ours. */
export function handleChord(store: DocsStore, event: KeyboardEvent): boolean {
  return dispatch(CHORD_KEYS, { store, event });
}

function tabPara(store: DocsStore) {
  const id = store.ui.editing?.para ?? store.host.getSnapshot().selection[0];
  return id ? store.model()?.byId.get(id) : undefined;
}

/** Tab / Shift+Tab: next / previous cell in a table, list level in a list item. */
export const TAB_KEYS: readonly Binding[] = [
  {
    keys: "Tab",
    label: "Next table cell",
    group: "Tables and lists",
    when: "in a table cell",
    run: ({ store }) => !!tabPara(store)?.cell && (void tabToCell(store, 1), true),
  },
  {
    keys: "Shift+Tab",
    label: "Previous table cell",
    group: "Tables and lists",
    when: "in a table cell",
    run: ({ store }) => !!tabPara(store)?.cell && (void tabToCell(store, -1), true),
  },
  {
    keys: "Tab",
    label: "Demote the list item one level",
    group: "Tables and lists",
    when: "in a list item",
    run: ({ store }) => tabPara(store)?.node.list_level !== undefined && (void indentParagraphs(store, 1), true),
  },
  {
    keys: "Shift+Tab",
    label: "Promote the list item one level",
    group: "Tables and lists",
    when: "in a list item",
    run: ({ store }) => tabPara(store)?.node.list_level !== undefined && (void indentParagraphs(store, -1), true),
  },
];

/** Tab keys; false when the paragraph is neither in a table nor a list (the caller decides what Tab does). */
export function handleTab(store: DocsStore, event: KeyboardEvent): boolean {
  return dispatch(TAB_KEYS, { store, event });
}
