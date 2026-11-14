import styles from "./style.css?inline";
import type { EditorHost, EditorPlugin } from "../../host/index.ts";
import { SheetsBottomBar } from "./BottomBar.tsx";
import { SheetsMainView } from "./MainView.tsx";
import { SHORTCUTS } from "./keys.ts";
import { getStore } from "./store.ts";
import { SheetsToolbar } from "./Toolbar.tsx";

/** The plugin's stylesheet text: the element adopts it in its shadow root once the plugin's chunk loads. */
export { styles };
export type { Selection, Editing, Notice } from "./store.ts";
export type { FormatPatch, NumberFormatPreset, BorderPreset, HAlign } from "./ops.ts";

/** Keys reaching the shell while nothing in particular has focus (the grid
 * handles its own keys first; the store handles each event at most once).
 * The real target is `composedPath()[0]`: inside a shadow root (the
 * `<wolf-review>` element) a window/document listener sees `event.target`
 * retargeted to the host element. A focused shadow host itself counts as
 * idle. */
function onKeyDown(event: KeyboardEvent, host: EditorHost): boolean {
  if (host.getSnapshot().state?.format !== "xlsx") return false;
  const target = event.composedPath()[0] ?? event.target;
  const idle =
    !target ||
    target === document.body ||
    target === document.documentElement ||
    target instanceof ShadowRoot ||
    (target instanceof Element && target.shadowRoot !== null);
  const inGrid = target instanceof HTMLElement && target.classList.contains("we-sheets-grid");
  if (!idle && !inGrid) return false;
  return getStore(host).handleKey(event);
}

export const sheetsPlugin: EditorPlugin = {
  id: "sheets",
  formats: ["xlsx"],
  Toolbar: SheetsToolbar,
  MainView: SheetsMainView,
  BottomBar: SheetsBottomBar,
  onKeyDown,
  shortcuts: SHORTCUTS,
};
