/**
 * Slides UI state shared by the plugin's slots (toolbar, rail, page
 * overlays, notes bar, key handler). One store per `EditorHost`; document
 * state itself stays in the host.
 */
import { useEffect, useState } from "preact/hooks";
import type { Address, KernelError } from "@wolfsdk/protocol";
import type { EditorHost } from "../../host/index.ts";
import type { Box } from "./model.ts";
import type { Capability } from "./ops.ts";

export type InsertMode =
  { kind: "textbox" } | { kind: "shape"; geometry: string } | { kind: "table"; rows: number; cols: number };

/**
 * Text editing of a shape or table cell. `caret`: a caret and selection
 * drawn on the slide from the engine's glyph layout (reactor kernel,
 * CaretEditor.tsx); `box`: the editing box over the shape (TextEditor.tsx).
 */
export type Editing = {
  target: Address;
  kind: "shape" | "cell";
  page: number;
  mode: "caret" | "box";
  /** Slide point (points) the user double-clicked: the caret goes there;
   * `client` is the click's viewport point (a third click selects the
   * paragraph). */
  at?: { x: number; y: number; client?: [number, number] };
  /** Caret mode: select the whole text on entry (Tab into a cell). */
  selectAll?: boolean;
  /** Reactor kernel in box mode: why the caret editor cannot take this text. */
  reason?: string;
};

/** Live geometry shown while dragging, nudging, or until a commit lands. */
export type Preview = {
  page: number;
  boxes: Record<Address, Box>;
  guides: { x: number[]; y: number[] };
  /** Table column/row border being dragged (points). */
  tableLine?: { axis: "x" | "y"; at: number; from: number; to: number };
};

export type FontToggles = { bold?: boolean; italic?: boolean; underline?: boolean };

export type Notice = { text: string; tone: "info" | "error" };

export type UiState = {
  /** Capabilities the engine refused this session, with the refusal. */
  disabled: Partial<Record<Capability, KernelError>>;
  notice: Notice | null;
  insert: InsertMode | null;
  editing: Editing | null;
  preview: Preview | null;
  /** Font toggles this session applied per target (the view has no format). */
  fontMemory: Record<Address, FontToggles>;
  /** Layout names listed by the engine for document `doc` (null: none listed). */
  layouts: { doc: string; names: string[] | null } | null;
  /** Slide show page, or null when not presenting. */
  show: number | null;
  /** First cell of a shift-click cell range. */
  cellAnchor: Address | null;
  /** Shapes copied (or cut: removed when pasted) within this deck. Addresses
   * follow `address_map`; paste clones them with the engine. */
  clipboard: { doc: string; shapes: Address[]; cut: boolean } | null;
  /** Speaker notes pane under the canvas: body height in CSS px and whether
   * it is collapsed to its header. Kept for the session. */
  notesPane: { height: number; collapsed: boolean };
};

const INITIAL: UiState = {
  disabled: {},
  notice: null,
  insert: null,
  editing: null,
  preview: null,
  fontMemory: {},
  layouts: null,
  show: null,
  cellAnchor: null,
  clipboard: null,
  notesPane: { height: 96, collapsed: false },
};

export class SlidesStore {
  state: UiState = INITIAL;
  private listeners = new Set<() => void>();
  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const stores = new WeakMap<EditorHost, SlidesStore>();

export function storeOf(host: EditorHost): SlidesStore {
  let store = stores.get(host);
  if (!store) {
    store = new SlidesStore();
    stores.set(host, store);
  }
  return store;
}

export function useSlides(host: EditorHost): [UiState, SlidesStore] {
  const store = storeOf(host);
  const [state, setState] = useState(store.state);
  useEffect(() => {
    setState(store.state);
    return store.subscribe(() => setState(store.state));
  }, [store]);
  return [state, store];
}
