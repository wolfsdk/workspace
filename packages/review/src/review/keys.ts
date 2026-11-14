/**
 * Every key the review panel handles, in one table. The same table drives the plugin's
 * `onKeyDown` (scope "global"), the change list's own handler (scope "list": the focus is on a
 * change row), the change outlines' handler on the pages (scope "outline": the focus is on an
 * outline) and the `shortcuts` the plugin declares, so they cannot drift apart.
 *
 * Modifier keys other than the ones written in `keys` must be up. Letter keys also match
 * `KeyboardEvent.code`, so `Alt+Shift+A` still fires on macOS where Option+A types another character.
 */
import { describeEntry } from "@wolfsdk/protocol";
import type { EditorHost, HistoryEntry, Shortcut } from "../host/index.ts";
import { reviewStore, type ReviewStore } from "./store.ts";

type Scope = "global" | "list" | "outline";

type Binding = Shortcut & {
  scope: Scope;
  /** Returns false when it did nothing (the key is then not consumed). */
  run: (ctx: {
    store: ReviewStore;
    host: EditorHost;
    row: Row | null;
    /** The focused change outline (scope "outline"). */
    outline: HTMLElement | null;
  }) => Promise<boolean> | boolean;
};

/** The change the keyboard focus is on: a change row (`primary`: its primary change record) or a
 * change outline on a page (`primary`: the outline's change record). */
export type Row = { revision: number; primary: number };

const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function matches(
  event: Pick<KeyboardEvent, "key" | "code" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">,
  keys: string,
): boolean {
  const parts = keys.split("+");
  const key = parts.pop()!;
  const want = new Set(parts);
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (want.has("Mod") !== mod) return false;
  if (want.has("Alt") !== event.altKey) return false;
  if (want.has("Shift") !== event.shiftKey) return false;
  // A bare Ctrl/Meta that is not `Mod` is never part of a binding here.
  if (isMac() ? event.ctrlKey : event.metaKey) return false;
  if (event.key === key) return true;
  if (key === "Space") return event.key === " ";
  if (key.length === 1)
    return event.key.toLowerCase() === key.toLowerCase() || event.code === `Key${key.toUpperCase()}`;
  return false;
}

/** The mounted panel element. Queries start here, not at `document`, so they work inside a shadow root. */
let panelEl: HTMLElement | null = null;
export const registerPanel = (el: HTMLElement | null): void => {
  panelEl = el;
};
const q = (selector: string): HTMLElement | null => panelEl?.querySelector<HTMLElement>(selector) ?? null;
const rowButton = (revision: number, primary: number): HTMLElement | null =>
  q(`[data-testid="review-change-${revision}-${primary}"] .we-review-change-btn`);
const rowButtons = (): HTMLElement[] =>
  panelEl ? [...panelEl.querySelectorAll<HTMLElement>('[data-testid="review-entries"] .we-review-change-btn')] : [];

/** The element holding the keyboard focus, looked up in the panel's own root (document or shadow root). */
const activeElement = (): Element | null => {
  const root = panelEl?.getRootNode();
  return root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
};

/** Run `fn` after the panel has re-rendered. */
const afterRender = (fn: () => void): void => {
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

/** Put the focus back into the list: the row, else the entry's first row, else its "go" button. */
function focusEntry(revision: number): void {
  for (let r = revision; r >= 1; r--) {
    const target =
      q(`[data-testid="review-entry-${r}-changes"] .we-review-change-btn`) ?? q(`[data-testid="review-entry-${r}-go"]`);
    if (target) return target.focus();
  }
  rowButtons()[0]?.focus();
}

const focusInPanel = (): boolean => {
  const active = activeElement();
  return active !== null && panelEl?.contains(active) === true;
};

function moveFocus(to: "next" | "previous" | "first" | "last", from: HTMLElement | null): boolean {
  const rows = rowButtons();
  if (rows.length === 0) return false;
  const at = from ? rows.indexOf(from) : -1;
  const index =
    to === "first"
      ? 0
      : to === "last"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, at + (to === "next" ? 1 : -1)));
  rows[index]!.focus();
  return true;
}

/** Mounted change outline layers (one per page that draws outlines), per host. */
const layersByHost = new WeakMap<EditorHost, Set<HTMLElement>>();

/** The outline layers of `host`; overlay.tsx adds and removes its layer elements. */
export function outlineLayers(host: EditorHost): Set<HTMLElement> {
  let layers = layersByHost.get(host);
  if (!layers) layersByHost.set(host, (layers = new Set()));
  return layers;
}

/** Every change outline on the host's mounted pages in reading order: pages in order, then each
 * page's outlines in DOM order, which overlay.tsx keeps top to bottom, then left to right. */
export function outlinesOf(host: EditorHost): HTMLElement[] {
  const layers = [...outlineLayers(host)].sort((a, b) => Number(a.dataset.page) - Number(b.dataset.page));
  return layers.flatMap((layer) => [...layer.querySelectorAll<HTMLElement>(":scope > .we-review-box")]);
}

/** Give outline `to` the name of its listbox (page and revision) as its description when the focus
 * comes to it from outside that listbox: from elsewhere (`from` null or not an outline) or from
 * another page. A screen reader then names the listbox once on the way in; the overlay's focus pass
 * drops the description once the focus has left `to`. */
export function enterContext(to: HTMLElement, from: Element | null): void {
  const layer = to.parentElement;
  if (layer?.id && from?.parentElement !== layer) to.setAttribute("aria-describedby", layer.id);
}

/** Move the focus among the outlines. At either end it stays (the key is still consumed). */
function moveOutline(host: EditorHost, to: "next" | "previous" | "first" | "last", from: HTMLElement): boolean {
  const all = outlinesOf(host);
  const at = all.indexOf(from);
  const index =
    to === "first"
      ? 0
      : to === "last"
        ? all.length - 1
        : Math.max(0, Math.min(all.length - 1, at + (to === "next" ? 1 : -1)));
  const next = all[index];
  if (next && next !== from) {
    enterContext(next, from);
    next.focus();
  }
  return true;
}

/** Focus the panel's row of change record `index` of entry `revision` (the item that folds it),
 * else as `focusEntry`. False when nothing in the panel took the focus. */
export function focusChange(store: ReviewStore, revision: number, index: number): boolean {
  const entry = store.history().find((e) => e.revision === revision);
  const item = entry ? describeEntry(entry).find((i) => i.indices.includes(index)) : undefined;
  const row = item ? rowButton(revision, item.primary) : null;
  if (row) row.focus();
  else focusEntry(revision);
  return focusInPanel();
}

async function undoEntry(store: ReviewStore, revision: number): Promise<boolean> {
  const entry = store.history().find((e) => e.revision === revision) ?? store.inspectedEntry();
  if (!entry) return false;
  await store.reject(entry);
  afterRender(() => {
    if (store.ui.choosing === entry.revision) q(`[data-testid="review-entry-${entry.revision}-reject-after"]`)?.focus();
    else focusEntry(entry.revision);
  });
  return true;
}

async function step(store: ReviewStore, delta: number): Promise<boolean> {
  const keepFocus = focusInPanel();
  const moved = await store.moveChange(delta);
  if (!moved) return false;
  if (keepFocus) afterRender(() => focusChange(store, moved.revision, moved.index));
  return true;
}

const inspectedRevision = (store: ReviewStore, row: Row | null): number | null =>
  row?.revision ?? store.inspectedEntry()?.revision ?? null;

/** The hunk of the selected change (the focused row, else the panel's selection) when its
 * entry has more than one op. A single-op entry is decided as a whole. */
function selectedHunk(store: ReviewStore, row: Row | null): { entry: HistoryEntry; op: number | null } | null {
  const sel = row ? { revision: row.revision, index: row.primary } : store.ui.selectedChange;
  if (!sel) return null;
  const entry = store.history().find((e) => e.revision === sel.revision);
  if (!entry || entry.ops.length < 2) return null;
  const hunk = store.hunks(entry).find((h) => h.changeIndices.includes(sel.index));
  return hunk ? { entry, op: hunk.op } : null;
}

/** Toggle one hunk between approved and pending. */
export function toggleHunk(store: ReviewStore, entry: HistoryEntry, op: number | null): void {
  store.setHunkDecision(entry, op, store.hunkDecisionOf(entry, op) === "approve" ? "pending" : "approve");
}

/** After a reject: the focus goes to a coupled notice when the store raised one, else back to the list. */
export function focusAfterReject(store: ReviewStore, revision: number): void {
  afterRender(() => {
    const notice = store.ui.coupled ? q('[data-testid="review-coupled-dismiss"]') : null;
    if (notice) notice.focus();
    else focusEntry(revision);
  });
}

/** Reject ops of an entry, then place the focus as `focusAfterReject`. */
export async function rejectHunk(store: ReviewStore, entry: HistoryEntry, ops: number[]): Promise<boolean> {
  const revision = entry.revision;
  await store.rejectOps(entry, ops);
  focusAfterReject(store, revision);
  return true;
}

/** The table. Order is the order of the shortcut list. */
export const BINDINGS: Binding[] = [
  {
    keys: "Alt+ArrowDown",
    label: "Select the next change in the list",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store }) => step(store, 1),
  },
  {
    keys: "Alt+ArrowUp",
    label: "Select the previous change in the list",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store }) => step(store, -1),
  },
  {
    keys: "Alt+Enter",
    label: "Reveal the selected change on the page",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store }) => store.revealSelected(),
  },
  {
    keys: "Alt+Shift+A",
    label: "Approve or unapprove the selected change, else the inspected change set",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store, row }) => {
      const hunk = selectedHunk(store, row);
      if (hunk) {
        toggleHunk(store, hunk.entry, hunk.op);
        return true;
      }
      const rev = inspectedRevision(store, row);
      const entry = rev === null ? undefined : store.history().find((e) => e.revision === rev);
      if (!entry) return false;
      store.approve(entry);
      return true;
    },
  },
  {
    keys: "Alt+Shift+R",
    label: "Reject the selected change, else undo (reject) the inspected change set",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store, row }) => {
      const hunk = selectedHunk(store, row);
      // The hunk no op caused follows the ops; it has no reject of its own.
      if (hunk) return hunk.op === null ? false : rejectHunk(store, hunk.entry, [hunk.op]);
      const rev = inspectedRevision(store, row);
      return rev === null ? false : undoEntry(store, rev);
    },
  },
  {
    keys: "Alt+Shift+E",
    label: "Download the decision file",
    group: "Review",
    when: "Outside text fields",
    scope: "global",
    run: ({ store }) => store.downloadExport(),
  },
  {
    keys: "ArrowDown",
    label: "Next change in the list",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: ({ row }) => row !== null && moveFocus("next", activeRow()),
  },
  {
    keys: "ArrowUp",
    label: "Previous change in the list",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: ({ row }) => row !== null && moveFocus("previous", activeRow()),
  },
  {
    keys: "Home",
    label: "First change in the list",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: ({ row }) => row !== null && moveFocus("first", activeRow()),
  },
  {
    keys: "End",
    label: "Last change in the list",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: ({ row }) => row !== null && moveFocus("last", activeRow()),
  },
  {
    keys: "Enter",
    label: "Select the change and reveal it on the page",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: async ({ store, row }) => {
      const entry = row ? store.history().find((e) => e.revision === row.revision) : undefined;
      if (!row || !entry) return false;
      await store.selectChange(entry, row.primary);
      return true;
    },
  },
  {
    keys: "Delete",
    label: "Undo (reject) the focused change set; focus stays in the list",
    group: "Review list",
    when: "A change is focused",
    scope: "list",
    run: ({ store, row }) => (row ? undoEntry(store, row.revision) : false),
  },
  {
    keys: "ArrowRight",
    label: "Next change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "next", outline),
  },
  {
    keys: "ArrowDown",
    label: "Next change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "next", outline),
  },
  {
    keys: "ArrowLeft",
    label: "Previous change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "previous", outline),
  },
  {
    keys: "ArrowUp",
    label: "Previous change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "previous", outline),
  },
  {
    keys: "Home",
    label: "First change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "first", outline),
  },
  {
    keys: "End",
    label: "Last change outline on the pages",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ host, outline }) => outline !== null && moveOutline(host, "last", outline),
  },
  {
    keys: "Enter",
    label: "Select the focused change, as a click does",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ outline }) => {
      outline?.click();
      return outline !== null;
    },
  },
  {
    keys: "Space",
    label: "Select the focused change, as a click does",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ outline }) => {
      outline?.click();
      return outline !== null;
    },
  },
  {
    keys: "Escape",
    label: "Back to the change in the panel's list",
    group: "Review page",
    when: "A change outline is focused",
    scope: "outline",
    run: ({ store, row }) => row !== null && focusChange(store, row.revision, row.primary),
  },
];

/** What the plugin declares: the table without its handlers. */
export const SHORTCUTS: Shortcut[] = BINDINGS.map(({ keys, label, group, when }) => ({ keys, label, group, when }));

const activeRow = (): HTMLElement | null => {
  const active = activeElement();
  return active instanceof HTMLElement && active.classList.contains("we-review-change-btn") ? active : null;
};

/** The element the key went to, seen through open shadow roots. */
const originOf = (event: Event): EventTarget | null => event.composedPath()[0] ?? event.target;

/** Row (revision, primary index) of a focused change button, read from its list item's test id. */
export function rowOf(target: EventTarget | null): Row | null {
  if (!(target instanceof HTMLElement)) return null;
  const button = target.closest(".we-review-change-btn");
  const item = button?.closest("[data-review-revision]");
  if (!(button instanceof HTMLElement) || !(item instanceof HTMLElement)) return null;
  const revision = Number(item.dataset.reviewRevision);
  const primary = Number(item.dataset.reviewPrimary);
  return Number.isInteger(revision) && Number.isInteger(primary) ? { revision, primary } : null;
}

const inTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;

/** Plugin `onKeyDown`: the global bindings. */
export function handleGlobalKey(event: KeyboardEvent, host: EditorHost): boolean {
  if (event.defaultPrevented || inTextField(originOf(event))) return false;
  const binding = BINDINGS.find((b) => b.scope === "global" && matches(event, b.keys));
  if (!binding) return false;
  const store = reviewStore(host);
  if (!host.getSnapshot().state) return false;
  event.preventDefault();
  void binding.run({ store, host, row: rowOf(originOf(event)), outline: null });
  return true;
}

/** Key handler of the change list (focus on a change row). */
export function handleListKey(event: KeyboardEvent, host: EditorHost): void {
  const row = rowOf(originOf(event));
  if (!row) return;
  const binding = BINDINGS.find((b) => matches(event, b.keys) && (b.scope === "list" || b.scope === "global"));
  if (!binding) return;
  event.preventDefault();
  event.stopPropagation();
  void binding.run({ store: reviewStore(host), host, row, outline: null });
}

/** The change outline (`.we-review-box` in its page layer) a key went to, and its change. */
function outlineOf(target: EventTarget | null): { outline: HTMLElement; row: Row } | null {
  if (!(target instanceof HTMLElement) || !target.classList.contains("we-review-box")) return null;
  const revision = Number(target.parentElement?.dataset.revision);
  const primary = Number(target.dataset.index);
  return Number.isInteger(revision) && Number.isInteger(primary)
    ? { outline: target, row: { revision, primary } }
    : null;
}

/** Key handler of the change outlines on a page (focus on an outline): the outline bindings, and
 * the global ones with the focused outline's change as the row. A handled key does not reach the
 * shell or other plugins; an outline binding that did nothing (Escape with no panel) passes it on. */
export function handleOutlineKey(event: KeyboardEvent, host: EditorHost): void {
  const at = outlineOf(originOf(event));
  if (!at || event.defaultPrevented) return;
  const binding = BINDINGS.find((b) => matches(event, b.keys) && (b.scope === "outline" || b.scope === "global"));
  if (!binding) return;
  if (binding.run({ store: reviewStore(host), host, row: at.row, outline: at.outline }) === false) return;
  event.preventDefault();
  event.stopPropagation();
}

export { focusEntry, afterRender };
