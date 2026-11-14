/**
 * The one shortcut registry: the shell's own keys (bound to shell actions and
 * dispatched here) and the keys plugins declare in `EditorPlugin.shortcuts`
 * (listed and checked for collisions; plugins dispatch them in `onKeyDown`).
 * The shortcut table and every control title read from it.
 */
import type { DocFormat } from "@wolfsdk/protocol";
import type { EditorPlugin, Shortcut } from "../host/index.ts";

export const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

export type ShellAction =
  | "open"
  | "save"
  | "saveAs"
  | "undo"
  | "redo"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "nextRegion"
  | "previousRegion"
  | "shortcuts"
  | "nextPage"
  | "previousPage"
  | "firstPage"
  | "lastPage";

export type ShellBinding = {
  shortcut: Shortcut;
  /** Shell action the keys run; none for keys listed only (pointer gestures, keys the page layer handles). */
  action?: ShellAction;
  /**
   * `first`: before the plugins' `onKeyDown` (global commands). `last`: only when no plugin
   * handled the key (page navigation, which a plugin may own for its format).
   */
  phase?: "first" | "last";
  /** Same action under another key, matched but not listed (`Mod+=` beside `Mod++`). */
  alias?: boolean;
};

const S = (keys: string, label: string, group: string, when?: string): Shortcut =>
  when ? { keys, label, group, when } : { keys, label, group };

export const SHELL_BINDINGS: ShellBinding[] = [
  { shortcut: S("Mod+O", "Open a file", "File"), action: "open", phase: "first" },
  { shortcut: S("Mod+S", "Save (downloads the file)", "File"), action: "save", phase: "first" },
  { shortcut: S("Mod+Shift+S", "Save as", "File"), action: "saveAs", phase: "first" },
  { shortcut: S("Mod+Z", "Undo", "Edit"), action: "undo", phase: "first" },
  { shortcut: S("Mod+Shift+Z", "Redo", "Edit"), action: "redo", phase: "first" },
  { shortcut: S("Mod+Y", "Redo", "Edit"), action: "redo", phase: "first" },
  { shortcut: S("Mod++", "Zoom in", "View"), action: "zoomIn", phase: "first" },
  { shortcut: S("Mod+=", "Zoom in", "View"), action: "zoomIn", phase: "first", alias: true },
  { shortcut: S("Mod+-", "Zoom out", "View"), action: "zoomOut", phase: "first" },
  { shortcut: S("Mod+_", "Zoom out", "View"), action: "zoomOut", phase: "first", alias: true },
  { shortcut: S("Mod+0", "Zoom to 100%", "View"), action: "zoomReset", phase: "first" },
  { shortcut: S("Mod+Wheel", "Zoom at the pointer (or pinch)", "View") },
  { shortcut: S("PageDown", "Next page", "Navigate", "on the pages"), action: "nextPage", phase: "last" },
  { shortcut: S("PageUp", "Previous page", "Navigate", "on the pages"), action: "previousPage", phase: "last" },
  { shortcut: S("Home", "First page", "Navigate", "on the pages"), action: "firstPage", phase: "last" },
  { shortcut: S("End", "Last page", "Navigate", "on the pages"), action: "lastPage", phase: "last" },
  {
    shortcut: S("F6", "Next region: toolbar, rail, pages, side panel", "Navigate"),
    action: "nextRegion",
    phase: "first",
  },
  { shortcut: S("Shift+F6", "Previous region", "Navigate"), action: "previousRegion", phase: "first" },
  { shortcut: S("Tab", "Next object on the page (Shift+Tab: previous)", "Navigate", "on a focused page") },
  { shortcut: S("Enter", "Select the focused object (Shift+Enter adds it)", "Navigate", "on a focused page") },
  { shortcut: S("Escape", "Close a menu or popup, then clear the selection", "Navigate") },
  { shortcut: S("?", "Show this list", "Help"), action: "shortcuts", phase: "first" },
];

type Chord = { mod: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; key: string };

function parse(keys: string): Chord {
  // The last `+` separates the key, so `Mod++` is Mod and `+`.
  const parts = keys.endsWith("++") ? [...keys.slice(0, -2).split("+"), "+"] : keys.split("+");
  const key = parts.pop() ?? "";
  const has = (name: string) => parts.some((p) => p.toLowerCase() === name);
  return {
    mod: has("mod"),
    ctrl: has("ctrl"),
    meta: has("cmd") || has("meta"),
    alt: has("alt") || has("option"),
    shift: has("shift"),
    key,
  };
}

/** A single printed character other than a letter: its shifted form is part of the key (`?`, `+`). */
const symbolKey = (key: string) => key.length === 1 && key.toLowerCase() === key.toUpperCase();

/** Canonical form for collision checks; `Mod` is resolved for this platform. */
export function canonical(keys: string): string {
  const c = parse(keys);
  const ctrl = c.ctrl || (c.mod && !IS_MAC);
  const meta = c.meta || (c.mod && IS_MAC);
  const key = c.key.length === 1 ? c.key.toLowerCase() : c.key;
  const shift = c.shift && !symbolKey(c.key);
  return [ctrl && "ctrl", meta && "meta", c.alt && "alt", shift && "shift", key].filter(Boolean).join("+");
}

export function matches(event: KeyboardEvent, keys: string): boolean {
  const c = parse(keys);
  // `Mod` takes Ctrl or Cmd, so Ctrl+Z also undoes on macOS; other chords are exact.
  if (c.mod ? !(event.ctrlKey || event.metaKey) : event.ctrlKey !== c.ctrl || event.metaKey !== c.meta) return false;
  if (event.altKey !== c.alt) return false;
  if (symbolKey(c.key)) return event.key === c.key;
  if (event.shiftKey !== c.shift) return false;
  return c.key.length === 1 ? event.key.toLowerCase() === c.key.toLowerCase() : event.key === c.key;
}

/** `Mod+Shift+S` as this platform names it: `Cmd+Shift+S` or `Ctrl+Shift+S`. */
export function displayKeys(keys: string): string {
  return keys
    .split("+")
    .map((p) => (p === "Mod" ? (IS_MAC ? "Cmd" : "Ctrl") : p))
    .join("+");
}

/** Keys of the shell action for control titles, e.g. `Save (Cmd+S)`. */
export function keysOf(action: ShellAction): string {
  const b = SHELL_BINDINGS.find((x) => x.action === action && !x.alias);
  return b ? displayKeys(b.shortcut.keys) : "";
}

export type ListedShortcut = Shortcut & { source: string; group: string };
export type Collision = { keys: string; when?: string; entries: ListedShortcut[] };

/** Every listed shortcut for a document format (shell first, then plugins active for it).
 * `history` false leaves out the shell's undo and redo (`EditorAppProps.history`). */
export function listShortcuts(plugins: EditorPlugin[], format: DocFormat | null, history = true): ListedShortcut[] {
  const out: ListedShortcut[] = SHELL_BINDINGS.filter(
    (b) => !b.alias && (history || (b.action !== "undo" && b.action !== "redo")),
  ).map((b) => ({
    ...b.shortcut,
    group: b.shortcut.group ?? "General",
    source: "shell",
  }));
  for (const p of plugins) {
    if (format && p.formats && !p.formats.includes(format)) continue;
    for (const s of p.shortcuts ?? []) out.push({ ...s, group: s.group ?? p.id, source: p.id });
  }
  return out;
}

/**
 * Keys bound twice in the same context (`when`): two sources, or one source with two
 * meanings. Pointer gestures are not keys and are skipped.
 */
export function findCollisions(list: ListedShortcut[]): Collision[] {
  const by = new Map<string, ListedShortcut[]>();
  for (const s of list) {
    if (/wheel/i.test(s.keys)) continue;
    const k = `${canonical(s.keys)}|${s.when ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  const out: Collision[] = [];
  for (const entries of by.values()) {
    const distinct = new Set(entries.map((e) => `${e.source}|${e.label}`));
    if (distinct.size > 1) out.push({ keys: entries[0]!.keys, when: entries[0]!.when, entries });
  }
  return out;
}
