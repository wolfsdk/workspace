/**
 * Wolf Review UI contract (frozen alongside `contract.ts`).
 *
 * The shell owns one `EditorHost` per open document view. Feature packages
 * (docs, slides, sheets, review) never talk to each other: each exports one
 * `EditorPlugin`, and the shell composes them. A plugin reads the snapshot,
 * renders its slots, and mutates the document only through `host.apply`.
 *
 * Rules for plugin authors:
 * - Mutate documents only through `host.apply(ops)`. Never call
 *   `host.kernel.apply` directly: the host keeps history, selection and
 *   error state in step.
 * - Every refusal is shown to the user with its `code`. `host.apply` already
 *   records it in `snapshot.lastError`; do not swallow it.
 * - Never keep document bytes. Ask the host (`save`) when you need them.
 * - Addresses can change on edit (see `TransactionSummary.address_map`).
 *   The host remaps `snapshot.selection`; remap any address you cache
 *   yourself, or re-derive it from the new `DocState`.
 */

import type { ComponentChildren, ComponentType } from "preact";
import type {
  Address,
  ApplyResult,
  BatchEnvironment,
  DocFormat,
  DocState,
  HistoryEntry,
  KernelClient,
  KernelError,
  Op,
  PageImage,
  Region,
  ViewNode,
} from "@wolfsdk/protocol";

/** One applied batch in the revision chain. `history[i]` produced revision `i + 1`. */
export type { HistoryEntry } from "@wolfsdk/protocol";

/** Immutable view of the editor. A new object is published on every change. */
export type EditorSnapshot = {
  /** Null until a document is open. */
  state: DocState | null;
  /** Selected node addresses, primary first. */
  selection: Address[];
  /** CSS pixels per point. 1 = 100 %. Page images are requested at `zoom * devicePixelRatio`. */
  zoom: number;
  /** Page number the user is looking at (a value from `state.pages[].page`). */
  currentPage: number;
  /** A kernel call issued through the host is in flight. */
  busy: boolean;
  /** Applied batches leading to the newest revision (includes the redo tail). */
  history: HistoryEntry[];
  /** Most recent refusal, until `clearError` or the next successful apply. */
  lastError: KernelError | null;
  /** Latest request to bring a page or node into view. The shell scrolls when
   * `seq` changes; it does not change the selection. Null until first used
   * and after a document is opened or closed. */
  reveal: RevealRequest | null;
};

/** Exactly one of `page` (a value from `state.pages[].page`) or `address`. */
export type RevealTarget = { page: number } | { address: Address };
export type RevealRequest = RevealTarget & { seq: number };

export type ApplyOptions = {
  /** Label for the history list. */
  label?: string;
  /** Plugin id. */
  source?: string;
  /** Keep `lastError` untouched on refusal (the caller shows it inline). */
  quiet?: boolean;
  /** Clock and zone to run this batch with instead of the kernel's own (passed to
   * `KernelClient.apply`). Replaying a recorded batch with its `SessionLog` clock and
   * zone reproduces its bytes on a live-clock kernel. Omit for a new edit. */
  at?: BatchEnvironment;
};

export interface EditorHost {
  readonly kernel: KernelClient;
  getSnapshot(): EditorSnapshot;
  /** Returns the unsubscribe function. The listener runs after every publish. */
  subscribe(listener: () => void): () => void;

  /** Open a document, replacing the current one. Rejects with `KernelRequestError`. */
  open(bytes: Uint8Array, name: string): Promise<DocState>;
  /** The only way to change the document. Serialised: calls run in issue order. */
  apply(ops: Op[], options?: ApplyOptions): Promise<ApplyResult>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  goto(revision: number): Promise<void>;
  save(): Promise<Uint8Array>;
  close(): Promise<void>;

  select(ids: Address[], options?: { additive?: boolean }): void;
  setZoom(zoom: number): void;
  setCurrentPage(page: number): void;
  /** Scroll a page or a node's first region into view without selecting it. */
  reveal(target: RevealTarget): void;
  clearError(): void;
  /** Surface an error that did not come from `apply` (file read, plugin failure). */
  reportError(error: KernelError): void;

  /** Node lookup in the current state. */
  node(id: Address): ViewNode | undefined;
  /** Regions of one page in the current state. */
  regionsOn(page: number): Region[];
  /** Page image for the current revision, cached per (revision, page, scale). */
  pageImage(page: number, scale: number): Promise<PageImage>;
  /** Object URL of that image, owned and revoked by the host. */
  pageImageUrl(page: number, scale: number): Promise<string>;
}

export type PluginProps = { host: EditorHost };

/** Props of a plugin's `MainView`. `pages` is the shell's own page view of the open document, ready to
 * draw: a view that offers the printed pages next to its own renders it as a child. */
export type MainViewProps = PluginProps & { pages: ComponentChildren };

/** Props of a layer drawn over one page image. The layer's box is the page:
 * `widthPx` x `heightPx` CSS pixels, origin top-left, `pxPerPt` CSS pixels per point. */
export type PageOverlayProps = PluginProps & {
  page: number;
  pxPerPt: number;
  widthPx: number;
  heightPx: number;
};

export type SidePanel = {
  id: string;
  title: string;
  Component: ComponentType<PluginProps>;
};

/** One keyboard shortcut for the shell's shortcut table. */
export type Shortcut = {
  /** `Mod+Shift+K` form: `Mod` is Cmd on macOS and Ctrl elsewhere; key names follow `KeyboardEvent.key`. */
  keys: string;
  label: string;
  /** Table section ("Text", "Cells"). Defaults to the plugin's id. */
  group?: string;
  /** When it applies, in words ("while editing a cell"). */
  when?: string;
};

export type EditorPlugin = {
  id: string;
  /** Formats the plugin is active for. Omit for all formats. */
  formats?: DocFormat[];
  /** Controls placed in the toolbar row. */
  Toolbar?: ComponentType<PluginProps>;
  /** Left rail (slide thumbnails, sheet list, outline). */
  LeftRail?: ComponentType<PluginProps>;
  /** Replaces the shell's default page scroller for this format (the sheets grid). */
  MainView?: ComponentType<MainViewProps>;
  /** Formats `MainView` is used for. Omit for every format the plugin is active for. A plugin that is
   * active for all formats (the review plugin) names the one its main view serves. */
  mainViewFormats?: DocFormat[];
  /** Drawn above each page inside the default page scroller, above the shell's
   * own region layer. Pointer events reach it first; let them through
   * (`pointer-events: none` on the layer, `auto` on your handles) unless you
   * handle them. */
  PageOverlay?: ComponentType<PageOverlayProps>;
  /** Right-hand panels, shown as tabs. */
  sidePanels?: SidePanel[];
  /** Region between the canvas and the bottom strip, in the canvas column
   * (speaker notes). The plugin owns its height; the canvas takes the rest. */
  BelowCanvas?: ComponentType<PluginProps>;
  /** Bottom strip (sheet tabs, status). */
  BottomBar?: ComponentType<PluginProps>;
  /** Global key handler. Return true when handled (the shell then stops propagation). */
  onKeyDown?: (event: KeyboardEvent, host: EditorHost) => boolean;
  /** Shortcuts the plugin handles in `onKeyDown`. Declarative only: the shell
   * lists them in its shortcut table and reports collisions; it does not dispatch them. */
  shortcuts?: Shortcut[];
};
