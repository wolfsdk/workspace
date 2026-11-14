import styles from "./style.css?inline";
import type { EditorHost, EditorPlugin } from "../../host/index.ts";
import { SlidesRail } from "./LeftRail.tsx";
import { SlidesNotes } from "./Notes.tsx";
import { SlidesOverlay } from "./Overlay.tsx";
import { typing } from "./dom.ts";
import { dispatch, SHORTCUTS, SLIDE_KEYS } from "./keys.ts";
import { storeOf } from "./store.ts";
import { SlidesToolbar } from "./Toolbar.tsx";

/** The plugin's stylesheet text: the element adopts it in its shadow root once the plugin's chunk loads. */
export { styles };
export type { FormatPatch, FontPatch, EmuRect, Capability } from "./ops.ts";

/** The slide keys (keys.ts `SLIDE_KEYS`): not in a text entry, not
 * presenting, not editing text. Cmd/Ctrl+V is left to the browser: the
 * `paste` event (Toolbar.tsx) pastes copied shapes or an image from the
 * system clipboard. */
function onKeyDown(event: KeyboardEvent, host: EditorHost): boolean {
  if (host.getSnapshot().state?.format !== "pptx" || typing(event)) return false;
  const ui = storeOf(host).state;
  if (ui.show !== null || ui.editing) return false;
  return dispatch(SLIDE_KEYS, host, event);
}

export const slidesPlugin: EditorPlugin = {
  id: "slides",
  formats: ["pptx"],
  Toolbar: SlidesToolbar,
  LeftRail: SlidesRail,
  PageOverlay: SlidesOverlay,
  BelowCanvas: SlidesNotes,
  onKeyDown,
  shortcuts: SHORTCUTS,
};
