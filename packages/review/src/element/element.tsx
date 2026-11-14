import { render } from "preact";
import {
  KernelRequestError,
  type ApplyResult,
  type DocState,
  type KernelError,
  type Op,
  type SessionLog,
} from "@wolfsdk/protocol/contract";
import { ENGINE_MODULE_NAME, type EngineSource, type ResolvedEngine } from "@wolfsdk/runtime/loader";
import { createEditorHost, type EditorHost, type EditorSnapshot } from "../host/index.ts";
import { reviewStore } from "../review/index.ts";
import { EditorApp, type EngineLoad } from "../shell/index.ts";
import { attachFontPack } from "../shell/vector.ts";
import {
  ENGINE_ATTRIBUTES,
  engineForDocument,
  engineFormatOf,
  engineLoad,
  engineModule,
  engineSourceFor,
  engineSourceOf,
  initialEngineSource,
  sameEngine,
} from "./engine.ts";
import { AgentActivityBar } from "./activity-bar.tsx";
import { normalizeAgentActivities, reduceAgentActivities } from "./activity.ts";
import { startKernel, type Kernel } from "./kernels.ts";
import { createPluginSession } from "./plugins.ts";
import { adoptCss, adoptStyles } from "./styles.ts";
import type { AgentPresence, RoomActivityEvent } from "./activity.ts";
import type {
  WolfChangeDetail,
  WolfEngineFormat,
  WolfEngineSource,
  WolfMode,
  WolfOpenDetail,
  WolfReviewBatch,
  WolfReviewEventMap,
  WolfReviewInput,
  WolfReviewOpenResult,
  WolfReviewSubmitDetail,
  WolfSaveDetail,
} from "./types.ts";

type Clock = "live" | "pinned";

/** One running engine: created when the element is in the document. */
type Session = {
  /** The engine configuration in canonical form (`engineSourceOf`); its `format` may be `auto`. */
  config: WolfEngineSource;
  /** The module source running; null while `auto` waits for a document to pick one. */
  source: EngineSource | null;
  /** The module's URL, version and checksum once it loaded. */
  resolved: ResolvedEngine | null;
  clock: Clock;
  kernel: Kernel;
  /** Module download and compile status for the shell's loading and fatal states; null while waiting for a document. */
  engine: EngineLoad | null;
  /** The host the shell's reference implementation keeps (history, selection, errors). */
  host: EditorHost;
  /** `host` behind the element's guards; the shell, the plugins and `element.apply` all use it. */
  ui: EditorHost;
  unsubscribe: () => void;
  ready: boolean;
  /** The mode last given to the review store of `ui` (`setMode`). */
  review: boolean;
  /** True while `ui`'s review store holds this element's submit handler. */
  submit: boolean;
};

/** Pinned clock the kernel uses when none is given (`KernelOptions.environment.clock`). */
const PINNED_CLOCK_DAY = "2026-01-01";

/** The load status of a session waiting for a document (`engine-format="auto"`): no module yet. */
const WAITING: EngineLoad = {
  getStatus: () => ({
    stage: "downloading",
    loaded: 0,
    total: null,
    downloadMs: null,
    transferred: null,
    resolved: null,
    error: null,
  }),
  subscribe: () => () => {},
  downloaded: () => new Promise(() => {}),
  compiling() {},
  compiled() {},
  failed() {},
};

/** sha256 of `bytes` as lowercase hex, or null without WebCrypto (an insecure context). */
async function sha256Of(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
  const digest = new Uint8Array(await subtle.digest("SHA-256", view));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function errorOf(cause: unknown, code: string): KernelError {
  if (cause instanceof KernelRequestError) return cause.error;
  return { code, message: cause instanceof Error ? cause.message : String(cause) };
}

/** Batch source and ops of the step from `prev` to `next` (both with a state of the same document). */
function changeOf(prev: EditorSnapshot, next: EditorSnapshot): Pick<WolfChangeDetail, "ops" | "source"> {
  const from = prev.state!.revision;
  const to = next.state!.revision;
  if (to > from) {
    const entry = next.history[to - 1];
    // `apply` replaces the history tail with a new entry; redo walks the existing one.
    if (to === from + 1 && entry && entry !== prev.history[to - 1]) return { ops: entry.ops, source: entry.source };
    return { ops: next.history.slice(from, to).flatMap((e) => e.ops), source: "redo" };
  }
  return { ops: prev.history.slice(to, from).flatMap((e) => e.ops), source: "undo" };
}

function fileNameOf(url: string): string {
  try {
    const last = new URL(url, document.baseURI).pathname.split("/").pop();
    return last ? decodeURIComponent(last) : "document";
  } catch {
    return "document";
  }
}

/**
 * `<wolf-review>`: the whole Wolf review and editing UI (shell plus the docs, slides, sheets
 * and review plugins) in an open shadow root, running the engine in its own
 * Web Worker. See the package README for the attribute, method and event reference.
 */
export class WolfReviewElement extends HTMLElement {
  static readonly observedAttributes = [
    ...ENGINE_ATTRIBUTES,
    "src",
    "name",
    "clock",
    "readonly",
    "plugins",
    "theme",
    "unload-guard",
    "mode",
  ];

  /** The `engine` property; null reads the engine attributes. */
  #engine: WolfEngineSource | null = null;

  #mount: HTMLDivElement;
  #session: Session | null = null;
  #last: EditorSnapshot | null = null;
  /** File name of the `open` in flight (the kernel keeps an ASCII-safe sandbox name). */
  #openName: string | null = null;
  /** File name of the open document as given to `open` (the kernel keeps an ASCII-safe sandbox name). */
  #docName: string | null = null;
  #pluginSession = createPluginSession();
  #srcSeq = 0;
  #openSeq = 0;
  /** The agents shown as present (live ones only). */
  #agents: AgentPresence[] = [];

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    adoptStyles(root);
    this.#mount = document.createElement("div");
    this.#mount.className = "wolf-embed-root";
    this.#mount.setAttribute("part", "root");
    root.append(this.#mount);
  }

  // --- attributes as properties ------------------------------------------------

  /** `engine-src`: exact URL of the engine module, resolved against the document base URL. Skips the
   * channel; `engine-sha256`, when given, is still checked. */
  get engineSrc(): string | null {
    return this.getAttribute("engine-src");
  }
  set engineSrc(value: string | null) {
    this.#reflect("engine-src", value);
  }

  /** `engine-channel`: root holding `latest.txt` and `v<VERSION>/` (default `https://wolfsdk.com/download/wolf`). */
  get engineChannel(): string | null {
    return this.getAttribute("engine-channel");
  }
  set engineChannel(value: string | null) {
    this.#reflect("engine-channel", value);
  }

  /** `engine-version`: engine version on the channel (default: the channel's `latest.txt`). */
  get engineVersion(): string | null {
    return this.getAttribute("engine-version");
  }
  set engineVersion(value: string | null) {
    this.#reflect("engine-version", value);
  }

  /** `engine-sha256`: expected lowercase hex SHA-256 of the module (default: the channel's `SHA256SUMS` line). */
  get engineSha256(): string | null {
    return this.getAttribute("engine-sha256");
  }
  set engineSha256(value: string | null) {
    this.#reflect("engine-sha256", value);
  }

  /** `engine-format`: `docx`, `xlsx`, `pptx` or `pdf` loads that format's split module (`wolf_web_<format>.wasm`,
   * or `wolf_web.wasm` on a release without it); `auto` loads the module of each document opened, switching
   * when the next one needs another. Without it the element loads `wolf_web.wasm`. `engine-src` ignores it. */
  get engineFormat(): WolfEngineFormat | null {
    return engineFormatOf(this.getAttribute("engine-format")) ?? null;
  }
  set engineFormat(value: WolfEngineFormat | null) {
    this.#reflect("engine-format", value);
  }

  /** The engine source in effect. Setting a `WolfEngineSource` (which may carry a custom `fetch`) replaces the
   * five engine attributes as a whole; null goes back to them. A different source restarts the engine. */
  get engine(): WolfEngineSource {
    return engineSourceOf((name) => this.getAttribute(name), this.#engine);
  }
  set engine(value: WolfEngineSource | null) {
    this.#engine = value;
    this.#engineChanged();
  }

  /** `src`: URL of a document to fetch and open once the engine starts (and whenever it changes). */
  get src(): string | null {
    return this.getAttribute("src");
  }
  set src(value: string | null) {
    this.#reflect("src", value);
  }

  /** `name`: file name for `src` (default: the last path segment of `src`). */
  get name(): string | null {
    return this.getAttribute("name");
  }
  set name(value: string | null) {
    this.#reflect("name", value);
  }

  /** `clock`: `live` (default; each edit runs at the current time) or `pinned` (2026-01-01, byte-reproducible).
   * Applies in both modes. Changing it restarts the engine. */
  get clock(): Clock {
    return this.getAttribute("clock") === "pinned" ? "pinned" : "live";
  }
  set clock(value: Clock) {
    this.setAttribute("clock", value);
  }

  /** `mode`: `review` (default; the review plugin only, no plugin toolbars and no undo/redo buttons,
   * submit through `wolf-review-submit`) or `edit` (every plugin). Other values mean `review`. Switching
   * keeps the engine, its clock and the open document. */
  get mode(): WolfMode {
    return this.getAttribute("mode") === "edit" ? "edit" : "review";
  }
  set mode(value: WolfMode) {
    this.setAttribute("mode", value);
  }

  /** `readonly`: no plugin toolbars; every edit, undo and redo is refused with `readonly`. */
  get readOnly(): boolean {
    return this.hasAttribute("readonly");
  }
  set readOnly(value: boolean) {
    this.toggleAttribute("readonly", value);
  }

  /** `plugins`: space-separated subset of `docs slides sheets review` (default all). */
  get plugins(): string | null {
    return this.getAttribute("plugins");
  }
  set plugins(value: string | null) {
    this.#reflect("plugins", value);
  }

  /** `theme`: `light`, `dark` or `auto` (default). */
  get theme(): "light" | "dark" | "auto" {
    const value = this.getAttribute("theme");
    return value === "light" || value === "dark" ? value : "auto";
  }
  set theme(value: "light" | "dark" | "auto") {
    this.setAttribute("theme", value);
  }

  /** `unload-guard`: ask the browser to confirm leaving the page while the document has unsaved edits (default off). */
  get unloadGuard(): boolean {
    return this.hasAttribute("unload-guard");
  }
  set unloadGuard(value: boolean) {
    this.toggleAttribute("unload-guard", value);
  }

  /** The agents shown as present in the bar above the editor: live ones only (`idle` and empty ids are dropped on set). */
  get agentActivities(): AgentPresence[] {
    return this.#agents.map((agent) => ({ ...agent }));
  }
  set agentActivities(value: readonly AgentPresence[]) {
    this.#agents = normalizeAgentActivities(value);
    this.#render();
  }

  // --- state -------------------------------------------------------------------

  /** The open document's current state, or null. */
  get state(): DocState | null {
    return this.#session?.host.getSnapshot().state ?? null;
  }

  /** True once `wolf-ready` fired for the current engine. */
  get ready(): boolean {
    return this.#session?.ready ?? false;
  }

  // --- methods -----------------------------------------------------------------

  /** Open a document, replacing the current one. Rejects (and fires `wolf-error`) on refusal. */
  async open(data: Uint8Array | Blob | File, name: string): Promise<void> {
    this.#require();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
    await this.#require().ui.open(bytes, name);
  }

  /** The current revision's bytes (no download, no `wolf-save`). */
  async save(): Promise<Uint8Array> {
    return this.#require().host.save();
  }

  /** Apply one batch of engine ops through the same host as the UI (history, selection, `wolf-change`). */
  async apply(ops: Op[]): Promise<ApplyResult> {
    return this.#require().ui.apply(ops, { source: "embed", label: "Embed apply" });
  }

  async undo(): Promise<void> {
    await this.#require().ui.undo();
  }

  async redo(): Promise<void> {
    await this.#require().ui.redo();
  }

  /** Close the document (the engine keeps running). */
  async close(): Promise<void> {
    await this.#require().ui.close();
  }

  /** The operation log of the open document, for native replay with `wolf transact`. */
  async session(): Promise<SessionLog> {
    const { host, kernel } = this.#require();
    await this.#idle(host);
    const state = host.getSnapshot().state;
    if (!state) throw new KernelRequestError({ code: "doc-unknown", message: "no document is open" });
    return kernel.client.session(state.doc);
  }

  /**
   * Open `base` (as `open`), then apply each proposed batch in order (as `apply`; one history
   * entry per batch, source `proposal`). A batch with `clock` and/or `timezone` runs at that
   * clock and zone instead of the element's own (`ApplyOptions.at`), so a proposal made at known
   * times reproduces its bytes on a live-clock element. Stops at the first refused batch: the
   * earlier batches stay applied and the refusal fires `wolf-error`. Rejects when `base` does not open.
   */
  async openReview(input: WolfReviewInput): Promise<WolfReviewOpenResult> {
    this.#require();
    const bytes = input.base instanceof Uint8Array ? input.base : new Uint8Array(await input.base.arrayBuffer());
    await this.#require().ui.open(bytes, input.name);
    const { ui } = this.#require();
    for (const [index, batch] of input.batches.entries()) {
      const { ops, label, clock, timezone }: WolfReviewBatch = Array.isArray(batch) ? { ops: batch } : batch;
      const at = clock !== undefined || timezone !== undefined ? { clock, timezone } : undefined;
      const result = await ui.apply(ops, { source: "proposal", label: label ?? `Proposed change ${index + 1}`, at });
      if (!result.ok) return { applied: index, refused: { index, error: result.error } };
    }
    return { applied: input.batches.length, refused: null };
  }

  /** Apply one room `agent.activity` event to the presence bar (`idle` removes the agent); fires `wolf-review-agent-activity`. */
  applyRoomActivityEvent(event: RoomActivityEvent): void {
    this.#agents = reduceAgentActivities(this.#agents, event);
    this.#render();
    this.#emit("wolf-review-agent-activity", { agents: this.agentActivities });
  }

  /** Submit the review as the panel's Submit button does: false while a blocker stands (undecided
   * changes, a coupled rejection, …) or outside review mode; otherwise fires `wolf-review-submit`. */
  async submitReview(): Promise<boolean> {
    return reviewStore(this.#require().ui).submit();
  }

  // --- typed events --------------------------------------------------------------

  addEventListener<K extends keyof WolfReviewEventMap>(
    type: K,
    listener: (this: WolfReviewElement, event: WolfReviewEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: WolfReviewElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof WolfReviewEventMap>(
    type: K,
    listener: (this: WolfReviewElement, event: WolfReviewEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (this: WolfReviewElement, event: HTMLElementEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }

  // --- lifecycle -----------------------------------------------------------------

  connectedCallback(): void {
    if (!this.#session) this.#start();
  }

  disconnectedCallback(): void {
    // Moving the element (remove + insert in one task) keeps the engine and the document.
    queueMicrotask(() => {
      if (!this.isConnected) this.#stop();
    });
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null): void {
    if (before === after) return;
    const session = this.#session;
    switch (name) {
      case "mode":
        // The clock does not depend on the mode, so the engine and the document stay.
        if (session) this.#modeChanged(session);
        return;
      case "engine-src":
      case "engine-channel":
      case "engine-version":
      case "engine-sha256":
      case "engine-format":
        // The `engine` property, when set, wins over the attributes.
        if (!this.#engine) this.#engineChanged();
        return;
      case "clock": {
        if (!this.isConnected) return;
        if (session && session.clock === this.clock) return;
        const source = session?.source;
        this.#stop();
        this.#start(source ?? undefined);
        return;
      }
      case "src":
        if (session && after) void this.#loadSrc(after);
        return;
      case "readonly":
      case "plugins":
        this.#pluginSession.invalidate();
        this.#render();
        return;
      case "theme":
      case "unload-guard":
        this.#render();
        return;
    }
  }

  // --- internals -----------------------------------------------------------------

  #reflect(attribute: string, value: string | null): void {
    if (value === null) this.removeAttribute(attribute);
    else this.setAttribute(attribute, value);
  }

  /** Restart the engine when the source in effect no longer matches the running one. */
  #engineChanged(): void {
    if (!this.isConnected) return;
    const session = this.#session;
    if (session && sameEngine(session.config, this.engine)) return;
    this.#stop();
    this.#start();
  }

  #require(): Session {
    if (this.#session) return this.#session;
    throw new KernelRequestError({
      code: "editor-not-started",
      message: "<wolf-review> starts once it is in the document",
    });
  }

  #emit<K extends keyof WolfReviewEventMap>(type: K, detail: WolfReviewEventMap[K]["detail"]): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Start a session on `source`; without one, on the module the configuration picks (`initialEngineSource`),
   * and null waits for a document (`engine-format="auto"`). `openSrc`: open the `src` attribute's document.
   */
  #start(source?: EngineSource | null, openSrc = true): void {
    if (!this.isConnected) return;
    const config = this.engine;
    if (source === undefined) source = initialEngineSource(config, this.getAttribute("src"), this.getAttribute("name"));
    const clock = this.clock;
    // Waiting for a document: no module (the kernel worker holds its calls) and no load status to show.
    const loaded = source ? engineModule(source) : new Promise<never>(() => {});
    const module = loaded.then((m) => m.module);
    const engine = source ? engineLoad(source) : null;
    let host!: EditorHost;
    const kernel = startKernel(
      source ?? engineSourceFor(config),
      module,
      clock === "live" ? { clock: "live" } : undefined,
      engine ?? WAITING,
      () => host,
    );
    host = createEditorHost(kernel.client);
    const session: Session = {
      config,
      source,
      resolved: null,
      clock,
      kernel,
      engine,
      host,
      ui: this.#guard(host),
      unsubscribe: () => {},
      ready: false,
      review: false,
      submit: false,
    };
    this.#session = session;
    this.#last = host.getSnapshot();
    session.unsubscribe = host.subscribe(() => this.#published(host.getSnapshot()));
    this.#syncReview(session);
    loaded.then(
      ({ resolved }) => {
        if (this.#session !== session) return;
        session.ready = true;
        session.resolved = resolved;
        // The release's extended font pack, next to the module (fetched when a page needs a face of it).
        attachFontPack(kernel.client, resolved.url, source?.fetch);
        this.#render();
        this.#emit("wolf-ready", { moduleUrl: resolved.url, version: resolved.version, sha256: resolved.sha256 });
      },
      (cause: unknown) => {
        // The shell shows the failure (and Retry) from `session.engine`; the page gets the event.
        if (this.#session === session)
          this.#emit("wolf-error", session.engine?.getStatus().error ?? errorOf(cause, "wasm-compile-failed"));
      },
    );
    this.#render();
    const src = this.getAttribute("src");
    if (src && openSrc) void this.#loadSrc(src);
  }

  #stop(keepOpens = false): void {
    const session = this.#session;
    if (!session) return;
    this.#session = null;
    this.#last = null;
    this.#docName = null;
    if (!keepOpens) {
      this.#srcSeq++;
      this.#openSeq++;
    }
    this.#pluginSession.stop();
    session.unsubscribe();
    if (session.submit) reviewStore(session.ui).setSubmitHandler(null);
    render(null, this.#mount);
    session.kernel.client.terminate();
  }

  #render(): void {
    const session = this.#session;
    if (!session) return;
    const plugins = this.#pluginSession.get(this.mode, this.getAttribute("plugins"), this.readOnly, {
      isCurrent: () => this.#session === session,
      adoptStyles: (styles) => {
        const root = this.shadowRoot;
        if (root) for (const css of styles) adoptCss(root, css);
      },
      onUpdate: () => this.#render(),
      reportError: (error) => session.host.reportError(error),
    });
    const environmentLabel = session.clock === "live" ? "live clock" : `pinned clock ${PINNED_CLOCK_DAY}`;
    const version = session.resolved?.version;
    const moduleName = session.resolved?.url.split(/[?#]/)[0].split("/").pop() || ENGINE_MODULE_NAME;
    render(
      <>
        <AgentActivityBar agents={this.#agents} />
        <EditorApp
          key={this.mode === "review" ? "review" : "edit"}
          initialPanel={this.mode === "review" ? "review" : undefined}
          history={this.mode !== "review" && !this.readOnly}
          host={session.ui}
          plugins={plugins}
          environmentLabel={environmentLabel}
          kernelLabel={`reactor (${moduleName}${version ? ` ${version}` : ""})`}
          pages="vector"
          engine={session.engine ?? undefined}
          onRetry={() => this.#restart()}
          theme={this.theme}
          documentTitle={false}
          unloadGuard={this.unloadGuard}
          onSave={(bytes, name) => this.#userSave(bytes, name)}
          storageKey={null}
          kernelStats={session.kernel.stats}
        />
      </>,
      this.#mount,
    );
  }

  #restart(): void {
    const source = this.#session?.source;
    this.#stop();
    this.#start(source ?? undefined);
  }

  /**
   * Open `bytes` on the active session, switching engine modules first under `engine-format="auto"`
   * (`engineForDocument`) when the running module does not serve the document's format. Monotonically
   * sequenced by `#openSeq` so an older in-flight switch never terminates or overrides a newer open.
   */
  async #openRouted(fallbackHost: EditorHost, bytes: Uint8Array, name: string): Promise<DocState> {
    const seq = ++this.#openSeq;
    this.#srcSeq++;
    const initial = this.#session;
    if (!initial) throw new KernelRequestError({ code: "editor-not-started", message: "<wolf-review> is disconnected" });
    if (initial.config.format === "auto") {
      const candidate = await engineForDocument(initial.config, initial.source, bytes, name);
      if (seq !== this.#openSeq || !this.#session) {
        throw new KernelRequestError({ code: "open-superseded", message: "open superseded by a newer open" });
      }
      const current = this.#session;
      const needed =
        current === initial ? candidate : await engineForDocument(current.config, current.source, bytes, name);
      if (seq !== this.#openSeq || !this.#session) {
        throw new KernelRequestError({ code: "open-superseded", message: "open superseded by a newer open" });
      }
      if (needed) {
        this.#stop(true);
        this.#start(needed, false);
      }
    }
    const active = this.#session?.host ?? fallbackHost;
    this.#openName = name;
    return active.open(bytes, name);
  }

  /** Save or Save as in the editor UI: `wolf-save`; a cancelled event means the page took the bytes (no download). */
  async #userSave(bytes: Uint8Array, name: string): Promise<boolean> {
    const sha256 = (await sha256Of(bytes)) ?? this.#session?.host.getSnapshot().state?.sha256 ?? "";
    const detail: WolfSaveDetail = { bytes, sha256, name };
    return !this.dispatchEvent(
      new CustomEvent("wolf-save", { detail, bubbles: true, composed: true, cancelable: true }),
    );
  }

  /** `mode` changed: same engine, clock and document; new plugin set and review store mode. */
  #modeChanged(session: Session): void {
    this.#pluginSession.invalidate();
    this.#syncReview(session);
    this.#render();
  }

  /**
   * Give the review store of `ui` (the host the plugins receive) the element's mode, and hold
   * the submit handler while review mode has a document open (cleared on close, stop and
   * leaving review mode).
   */
  #syncReview(session: Session): void {
    const review = this.mode === "review";
    if (review !== session.review) {
      session.review = review;
      reviewStore(session.ui).setMode(review ? "review" : "edit");
    }
    const submit = review && !!session.host.getSnapshot().state;
    if (submit !== session.submit) {
      session.submit = submit;
      reviewStore(session.ui).setSubmitHandler(submit ? () => this.#submitHandler(session) : null);
    }
  }

  /** The review store's submit: `wolf-review-submit`; unless cancelled, the decision file downloads. */
  async #submitHandler(session: Session): Promise<void> {
    const { host, kernel } = session;
    await this.#idle(host);
    const state = host.getSnapshot().state;
    if (!state) throw new KernelRequestError({ code: "doc-unknown", message: "no document is open" });
    const store = reviewStore(session.ui);
    const bytes = await host.save();
    const log = await kernel.client.session(state.doc);
    const decision = await store.buildExport();
    if (!decision) throw new KernelRequestError({ code: "doc-unknown", message: "no document is open" });
    const detail: WolfReviewSubmitDetail = {
      bytes,
      sha256: state.sha256,
      name: this.#docName ?? state.name,
      session: log,
      decision,
    };
    const taken = !this.dispatchEvent(
      new CustomEvent("wolf-review-submit", { detail, bubbles: true, composed: true, cancelable: true }),
    );
    if (!taken) await store.downloadExport();
  }

  /** The host the shell and the element API use: read-only guards and open names. */
  #guard(host: EditorHost): EditorHost {
    const refuse = (action: string): KernelError => {
      const error: KernelError = { code: "readonly", message: `This editor is read-only: ${action} is not allowed.` };
      host.reportError(error);
      return error;
    };
    return {
      ...host,
      open: (bytes, name) => this.#openRouted(host, bytes, name),
      apply: async (ops, options) => {
        if (!this.readOnly) return host.apply(ops, options);
        const error = refuse("editing");
        return { ok: false, error, errors: [error], timings: { compileMs: 0, totalMs: 0, runs: [] } };
      },
      undo: async () => (this.readOnly ? void refuse("undo") : host.undo()),
      redo: async () => (this.readOnly ? void refuse("redo") : host.redo()),
      goto: async (revision) => (this.readOnly ? void refuse("moving through history") : host.goto(revision)),
    };
  }

  #published(snapshot: EditorSnapshot): void {
    const prev = this.#last;
    this.#last = snapshot;
    if (!prev) return;
    const { state } = snapshot;
    const before = prev.state;
    const session = this.#session;
    if (session && !state !== !before) this.#syncReview(session);
    if (state && state !== before) {
      if (!before || state.doc !== before.doc) {
        const detail: WolfOpenDetail = {
          name: this.#openName ?? state.name,
          format: state.format,
          pages: state.pages.length,
          sha256: state.sha256,
        };
        this.#openName = null;
        this.#docName = detail.name;
        this.#emit("wolf-open", detail);
      } else if (state.revision !== before.revision || state.sha256 !== before.sha256) {
        this.#emit("wolf-change", { revision: state.revision, sha256: state.sha256, ...changeOf(prev, snapshot) });
      }
    }
    if (snapshot.lastError && snapshot.lastError !== prev.lastError) this.#emit("wolf-error", snapshot.lastError);
    const { selection } = snapshot;
    if (
      selection !== prev.selection &&
      (selection.length !== prev.selection.length || selection.some((a, i) => a !== prev.selection[i]))
    ) {
      this.#emit("wolf-selection", { addresses: [...snapshot.selection] });
    }
  }

  async #loadSrc(src: string): Promise<void> {
    if (!this.#session) return;
    const seq = ++this.#srcSeq;
    const name = this.getAttribute("name") ?? fileNameOf(src);
    let bytes: Uint8Array;
    try {
      const response = await fetch(new URL(src, document.baseURI));
      if (!response.ok) throw new Error(`GET ${src} answered ${response.status} ${response.statusText}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      if (seq === this.#srcSeq)
        this.#session?.host.reportError({ ...errorOf(cause, "src-fetch-failed"), code: "src-fetch-failed", argument: src });
      return;
    }
    if (seq !== this.#srcSeq || !this.#session) return;
    // A refusal is already published as `lastError` (banner and `wolf-error`).
    await this.#session.ui.open(bytes, name).catch(() => {});
  }

  async #idle(host: EditorHost): Promise<void> {
    if (!host.getSnapshot().busy) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const off = host.subscribe(() => {
      if (host.getSnapshot().busy) return;
      off();
      resolve();
    });
    await promise;
  }
}
