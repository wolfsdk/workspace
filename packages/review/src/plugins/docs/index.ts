import type { EditorHost, EditorPlugin } from "../../host/index.ts";
import { deleteImage, isImage, pageOf } from "./actions.ts";
import { textIsComplete } from "./textedit.ts";
import { BOX_KEYS, DocsPageOverlay } from "./PageOverlay.tsx";
import { CARET_KEYS } from "./CaretEditor.tsx";
import { COMMENT_EDIT_KEYS, CommentsPanel, REPLY_KEYS, TrackedChangesPanel } from "./Panels.tsx";
import {
  type Binding,
  CHORD_KEYS,
  closeFind,
  dispatch,
  FIND_KEY,
  type KeyContext,
  listShortcuts,
  TAB_KEYS,
} from "./shortcuts.ts";
import { storeFor } from "./store.ts";
import { confirmDelete, DocsToolbar, FIND_BAR_KEYS } from "./Toolbar.tsx";
import styles from "./style.css?inline";

/** The plugin's stylesheet text: the element adopts it in its shadow root once the plugin's chunk loads. */
export { styles };

/** The event's real origin: a window/document listener sees the shadow host as `target`. */
function typingTarget(event: Event): boolean {
  const origin = event.composedPath()[0] ?? event.target;
  const el = origin as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** Move the paragraph selection to the previous / next drawn paragraph. */
function stepSelection(host: EditorHost, step: -1 | 1, extend: boolean): boolean {
  const store = storeFor(host);
  const model = store.model();
  const snapshot = host.getSnapshot();
  if (!model) return false;
  const drawn = model.paras.filter((p) => pageOf(model.state, p.id) !== null);
  if (drawn.length === 0) return false;
  const current = snapshot.selection[0];
  const at = current === undefined ? -1 : drawn.findIndex((p) => p.id === current);
  const next = drawn[at < 0 ? (step > 0 ? 0 : drawn.length - 1) : Math.max(0, Math.min(drawn.length - 1, at + step))]!;
  host.reveal({ address: next.id });
  if (extend && current !== undefined) host.select([next.id, ...snapshot.selection.filter((id) => id !== next.id)]);
  else host.select([next.id]);
  return true;
}

const SELECTED = "with paragraphs selected, not typing";

/** Selection mode: no text editor open and the focus outside any text field. */
const SELECTION_KEYS: readonly Binding[] = [
  {
    keys: "ArrowUp",
    label: "Select the previous paragraph",
    group: "Paragraphs",
    when: "when not typing",
    extend: true,
    run: ({ store, event }) => stepSelection(store.host, -1, event.shiftKey),
  },
  {
    keys: "ArrowDown",
    label: "Select the next paragraph",
    group: "Paragraphs",
    when: "when not typing",
    extend: true,
    run: ({ store, event }) => stepSelection(store.host, 1, event.shiftKey),
  },
  {
    keys: "Enter",
    label: "Edit the selected paragraph",
    group: "Paragraphs",
    when: SELECTED,
    run: ({ store }) => {
      const state = store.host.getSnapshot().state!;
      const id = store.host.getSnapshot().selection[0];
      const para = id ? store.model()?.byId.get(id) : undefined;
      const page = id ? pageOf(state, id) : null;
      if (!para || page === null) return false;
      if (!textIsComplete(para))
        store.fail("docs-text-cut", "This paragraph's text is cut in the engine view and cannot be edited in place.");
      else store.startEdit(para.id, page, null);
      return true;
    },
  },
  {
    keys: "Delete",
    label: "Delete the selected paragraphs or picture",
    group: "Paragraphs",
    when: SELECTED,
    run: ({ store }) => deleteSelected(store.host),
  },
  {
    keys: "Backspace",
    label: "Delete the selected paragraphs or picture",
    group: "Paragraphs",
    when: SELECTED,
    run: ({ store }) => deleteSelected(store.host),
  },
  {
    keys: "Escape",
    label: "Close find",
    group: "Find",
    when: "while the find bar is open",
    run: ({ store }) => {
      if (!store.ui.find.open) return false;
      closeFind(store);
      return true;
    },
  },
];

function deleteSelected(host: EditorHost): boolean {
  const store = storeFor(host);
  const selection = host.getSnapshot().selection;
  if (selection.length === 1 && isImage(store.model(), selection[0])) {
    void deleteImage(store, selection[0]!);
    return true;
  }
  if (selection.length === 0 || !store.model()?.byId.has(selection[0]!)) return false;
  void confirmDelete(store);
  return true;
}

function onKeyDown(event: KeyboardEvent, host: EditorHost): boolean {
  const state = host.getSnapshot().state;
  if (!state || state.format !== "docx") return false;
  const ctx: KeyContext = { store: storeFor(host), event };
  if (dispatch([FIND_KEY], ctx)) return true;
  if (typingTarget(event) || ctx.store.ui.editing) return false;
  return dispatch(CHORD_KEYS, ctx) || dispatch(TAB_KEYS, ctx) || dispatch(SELECTION_KEYS, ctx);
}

export const docsPlugin: EditorPlugin = {
  id: "docs",
  formats: ["docx"],
  Toolbar: DocsToolbar,
  PageOverlay: DocsPageOverlay,
  sidePanels: [
    { id: "docs-comments", title: "Comments", Component: CommentsPanel },
    { id: "docs-changes", title: "Tracked changes", Component: TrackedChangesPanel },
  ],
  onKeyDown,
  // Every key the plugin handles: this list is built from the same tables that dispatch them.
  shortcuts: listShortcuts(
    CHORD_KEYS,
    TAB_KEYS,
    SELECTION_KEYS,
    CARET_KEYS,
    BOX_KEYS,
    FIND_BAR_KEYS,
    REPLY_KEYS,
    COMMENT_EDIT_KEYS,
  ),
};
