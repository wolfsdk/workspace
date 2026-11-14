import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { formatClockTime, isReactorKernel, type DocFormat, type KernelError, type Timings } from "@wolfsdk/protocol";
import { useEditor, type EditorHost, type EditorPlugin } from "../host/index.ts";
import { ErrorToast, OverflowRow, PopoverButton, ShortcutsSheet, Splitter } from "./chrome.tsx";
import { SHELL_BINDINGS, findCollisions, keysOf, listShortcuts, matches, type ShellAction } from "./shortcuts.ts";
import { FontsSheet } from "./FontsSheet.tsx";
import { PanelTabs } from "./PanelTabs.tsx";
import type { EngineLoad, EngineStatus } from "./engine.ts";
import { FormatIcon, Icon, Logo, type IconName } from "./icons.tsx";
import { Inspector } from "./Inspector.tsx";
import { PageScroller, type RenderInfo } from "./PageScroller.tsx";
import { PluginBoundary } from "./PluginBoundary.tsx";
import { ZOOM_PRESETS, clampZoom, formatZoom, stepZoom, type FitMode } from "./layout.ts";
import {
  FatalState,
  Landing,
  LoadingStages,
  checkFile,
  describeOpenFailure,
  type OpenProblem,
  type OpenProgress,
  type Sample,
} from "./states.tsx";
import {
  MIME,
  OPEN_ACCEPT,
  downloadBytes,
  fileNameFromUrl,
  isEditableTarget,
  saveBytesAs,
  toKernelError,
} from "./util.ts";
import { VectorPages } from "./vector.ts";

export type { Sample } from "./states.tsx";
export type Theme = "light" | "dark" | "auto";
/** Takes the saved bytes instead of the shell's download; return true when handled. */
export type SaveHandler = (bytes: Uint8Array, name: string, format: DocFormat) => boolean | Promise<boolean>;
/** The parts of the kernel's `stats()` the Performance popover shows (`mountEditor` maps
 * the reactor client's stats onto it). */
export type KernelStatsSnapshot = {
  pngCache?: { entries: number; bytes: number; hits: number; misses: number };
  /** Reactor display lists cached by revision and page. */
  displayListCache?: { entries: number; hits: number; misses: number };
  /** `determinism` of the most recent engine receipt (null before the first). */
  lastDeterminism?: Record<string, unknown> | null;
  /** Linear memory of the live engine instance (reactor). */
  memoryBytes?: number;
  /** Worker restarts after a crash, and documents a restart could not restore. */
  restarts?: number;
  restoreFailures?: number;
};
export type KernelStatsSource = () => Promise<KernelStatsSnapshot>;
/** How the page view draws: `vector` (display lists on a canvas, PNG per page on fallback)
 * or `png` (engine page images). */
export type PageMode = "vector" | "png";

export type EditorAppProps = {
  host: EditorHost;
  plugins: EditorPlugin[];
  samples?: Sample[];
  /** Engine clock shown in the status bar, e.g. `Live clock` or `Pinned clock 2026-01-01`. */
  environmentLabel?: string;
  /** Kernel name for the Performance popover, e.g. `reactor (wolf_web.wasm)`. */
  kernelLabel?: string;
  /** Page drawing; default `vector`, which applies only when `host.kernel` is a reactor kernel. */
  pages?: PageMode;
  /** Module download and compile progress (`mountEditor` supplies it). */
  engine?: EngineLoad;
  /** Called when an open succeeded, so the engine is compiled whatever spawned the worker. */
  onEngineReady?: () => void;
  /** Start a fresh kernel after the engine failed to load; without it Retry reloads the page. */
  onRetry?: () => void;
  theme?: Theme;
  /** Write the file name into `document.title` and take shortcuts typed with nothing focused. Default true. */
  documentTitle?: boolean;
  onSave?: SaveHandler;
  /** localStorage key prefix for the panel layout; null keeps it in memory. Default `wolf-review`. */
  storageKey?: string | null;
  /** Ask before the page unloads with unsaved edits (`beforeunload`). Default true; embeds in
   * another site's page pass false. */
  unloadGuard?: boolean;
  /** Side-panel tab shown first: a panel id as in `shell-tab-<id>` (for example `review`), or
   * `<plugin id>/<panel id>` when two plugins use the same panel id. Default: the Inspector. A
   * format plugin's panel appears when a document of that format opens; the tab is selected then. */
  initialPanel?: string;
  /** Undo and redo in the toolbar, with their shortcuts. Default true. With false the shell
   * offers neither; `host.undo()` and `host.redo()` still work for the embedding page. */
  history?: boolean;
  kernelStats?: KernelStatsSource;
};

const INSPECTOR_TAB = "inspector";

type Layout = { leftOpen: boolean; sideOpen: boolean; leftWidth: number; sideWidth: number };
const LAYOUT: Layout = { leftOpen: true, sideOpen: true, leftWidth: 220, sideWidth: 340 };
/** Editor width (px) below which the rail and side panel float over the canvas. */
const NARROW = 760;
const LEFT_MIN = 140;
const LEFT_MAX = 420;
const SIDE_MIN = 240;
const SIDE_MAX = 640;

function loadLayout(storageKey: string | null): Layout {
  if (!storageKey) return LAYOUT;
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(`${storageKey}:layout`) ?? "null");
    if (typeof raw !== "object" || raw === null) return LAYOUT;
    const r = raw as Partial<Record<keyof Layout, unknown>>;
    const num = (v: unknown, d: number, lo: number, hi: number) =>
      typeof v === "number" && v >= lo && v <= hi ? v : d;
    return {
      leftOpen: typeof r.leftOpen === "boolean" ? r.leftOpen : LAYOUT.leftOpen,
      sideOpen: typeof r.sideOpen === "boolean" ? r.sideOpen : LAYOUT.sideOpen,
      leftWidth: num(r.leftWidth, LAYOUT.leftWidth, LEFT_MIN, LEFT_MAX),
      sideWidth: num(r.sideWidth, LAYOUT.sideWidth, SIDE_MIN, SIDE_MAX),
    };
  } catch {
    return LAYOUT;
  }
}

/** Which kind of kernel call produced a state, read from its timings. */
function callLabel(t: Timings): string {
  if (t.transactMs !== undefined) return "apply";
  if (t.observeMs !== undefined) return "open";
  return "undo or redo";
}

const ms = (v: number) => `${Math.round(v)} ms`;
const mib = (v: number) => `${(v / 2 ** 20).toFixed(1)} MiB`;

/** One line from a receipt's `determinism`: clock (12-hour, in the run's zone), source, locale, seed, fonts. */
function determinismText(d: Record<string, unknown>): string {
  const clock = (d.clock ?? {}) as { instant?: unknown; timezone?: unknown };
  const zone = typeof clock.timezone === "string" ? clock.timezone : "UTC";
  let when = typeof clock.instant === "string" ? clock.instant : "unknown instant";
  const date = typeof clock.instant === "string" ? new Date(clock.instant) : null;
  if (date && !Number.isNaN(date.getTime())) {
    try {
      when = date.toLocaleString("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "medium", hour12: true });
    } catch {
      // Unknown zone name in this browser: keep the instant as the engine wrote it.
    }
  }
  const parts = [`clock ${when} ${zone}`];
  if (typeof d.clock_source === "string") parts[0] += ` (${d.clock_source})`;
  if (typeof d.locale === "string") parts.push(d.locale);
  if (d.random_seed !== undefined) parts.push(`seed ${String(d.random_seed)}`);
  const dirs = Array.isArray(d.font_dirs) ? d.font_dirs.length : 0;
  parts.push(d.system_fonts === false && dirs === 0 ? "no system fonts" : "system fonts used");
  return parts.join(", ");
}

function PerformancePanel(props: {
  timings: Timings | null;
  render: RenderInfo | null;
  sha256: string | null;
  engine: EngineStatus | null;
  stats: KernelStatsSnapshot | null;
  kernelLabel?: string;
  /** Page drawing in effect, with the pages that fell back to PNG. */
  drawing: string;
  onFonts: (() => void) | null;
}) {
  const { timings, render, engine, stats } = props;
  const parts: string[] = [];
  if (timings?.compileMs) parts.push(`compile ${ms(timings.compileMs)}`);
  if (timings?.transactMs !== undefined) parts.push(`transact ${ms(timings.transactMs)}`);
  if (timings?.observeMs !== undefined) parts.push(`observe ${ms(timings.observeMs)}`);
  if (timings?.diffMs !== undefined) parts.push(`diff ${ms(timings.diffMs)}`);
  const runs =
    timings?.runs.map((r) => `${r.verb}: ${ms(r.ms)}, exit ${r.exitCode ?? "none"}, memory ${mib(r.memoryBytes)}`) ??
    [];
  return (
    <div class="we-shell-perf">
      <div class="we-shell-perf-title">Performance</div>
      <dl class="we-shell-perf-list">
        {props.kernelLabel && (
          <>
            <dt>Kernel</dt>
            <dd data-testid="shell-perf-kernel">{props.kernelLabel}</dd>
          </>
        )}
        <dt>Page drawing</dt>
        <dd data-testid="shell-perf-drawing">{props.drawing}</dd>
        <dt>Last call</dt>
        <dd data-testid="shell-status-timings" title={runs.join("\n") || "no engine runs"}>
          {timings ? (
            <>
              {callLabel(timings)} {ms(timings.totalMs)}
              {parts.length ? ` (${parts.join(", ")})` : ""}
            </>
          ) : (
            "none yet"
          )}
        </dd>
        {runs.length > 0 && (
          <>
            <dt>Engine runs</dt>
            <dd>
              {runs.map((r) => (
                <div key={r}>{r}</div>
              ))}
            </dd>
          </>
        )}
        <dt>Last page drawn</dt>
        {render ? (
          <dd
            data-testid="shell-status-render"
            title={
              render.kind === "vector"
                ? "Display list fetched and painted (unchanged pages are not redrawn)"
                : "Last page render the engine ran (not served from cache)"
            }
          >
            page {render.page}, {ms(render.ms)}, {render.kind === "vector" ? "vector" : "engine PNG"} at {render.dpi}{" "}
            dpi
          </dd>
        ) : (
          <dd>none since the document opened</dd>
        )}
        {stats && (
          <>
            {stats.displayListCache && (
              <>
                <dt>Display lists</dt>
                <dd data-testid="shell-perf-lists">
                  {stats.displayListCache.entries} cached, {stats.displayListCache.hits} hits /{" "}
                  {stats.displayListCache.misses} misses
                </dd>
              </>
            )}
            {stats.pngCache && (
              <>
                <dt>Page cache</dt>
                <dd>
                  {stats.pngCache.entries} pages, {mib(stats.pngCache.bytes)}, {stats.pngCache.hits} hits /{" "}
                  {stats.pngCache.misses} misses
                </dd>
              </>
            )}
            {stats.memoryBytes !== undefined && (
              <>
                <dt>Engine memory</dt>
                <dd data-testid="shell-perf-memory">{mib(stats.memoryBytes)}</dd>
              </>
            )}
            {stats.restarts !== undefined && stats.restarts > 0 && (
              <>
                <dt>Worker restarts</dt>
                <dd data-testid="shell-perf-restarts">
                  {stats.restarts}
                  {stats.restoreFailures ? `, ${stats.restoreFailures} documents not restored` : ", documents restored"}
                </dd>
              </>
            )}
            {stats.lastDeterminism && (
              <>
                <dt>Last engine run</dt>
                <dd data-testid="shell-perf-determinism">{determinismText(stats.lastDeterminism)}</dd>
              </>
            )}
          </>
        )}
        {props.onFonts && (
          <>
            <dt>Fonts</dt>
            <dd>
              <button
                class="we-btn we-btn--small we-btn--outline"
                title="Faces drawn on the pages and their licences"
                aria-label="Fonts and licences"
                data-testid="shell-perf-fonts"
                onClick={props.onFonts}
              >
                Fonts and licences
              </button>
            </dd>
          </>
        )}
        {engine && (
          <>
            <dt>Engine module</dt>
            <dd data-testid="shell-perf-engine">
              {engine.stage === "ready" ? "compiled" : engine.stage}
              {engine.downloadMs !== null
                ? engine.transferred === 0
                  ? `, ${mib(engine.loaded)} from the browser cache in ${ms(engine.downloadMs)}`
                  : `, ${mib(engine.loaded)} loaded in ${ms(engine.downloadMs)}${
                      engine.transferred ? ` (${mib(engine.transferred)} over the network)` : ""
                    }`
                : ""}
            </dd>
          </>
        )}
        {props.sha256 && (
          <>
            <dt>Revision sha256</dt>
            <dd>
              <code class="we-shell-sha" data-testid="shell-sha" title={`sha256 ${props.sha256}`}>
                {props.sha256}
              </code>
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function ToolButton(props: {
  label: string;
  title: string;
  testid: string;
  onClick: () => void;
  icon: IconName;
  text?: string;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      class={`we-btn${props.text ? "" : " we-btn--icon"}`}
      title={props.title}
      aria-label={props.label}
      aria-pressed={props.pressed}
      data-testid={props.testid}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} />
      {props.text && <span class="we-shell-btn-text">{props.text}</span>}
    </button>
  );
}

function useEngineStatus(engine: EngineLoad | undefined): EngineStatus | null {
  const [status, setStatus] = useState(() => engine?.getStatus() ?? null);
  useEffect(() => {
    if (!engine) return;
    setStatus(engine.getStatus());
    return engine.subscribe(() => setStatus(engine.getStatus()));
  }, [engine]);
  return status;
}

/** Whether `plugin` replaces the page view for a document of `format` (`MainView`, within `mainViewFormats`). */
function hasMainView(plugin: EditorPlugin, format: DocFormat | undefined): boolean {
  if (!plugin.MainView) return false;
  return !plugin.mainViewFormats || (format !== undefined && plugin.mainViewFormats.includes(format));
}

export function EditorApp({
  host,
  plugins,
  samples = [],
  environmentLabel,
  kernelLabel,
  pages = "vector",
  engine,
  onEngineReady,
  onRetry,
  theme = "auto",
  documentTitle = true,
  onSave,
  storageKey = "wolf-review",
  unloadGuard = true,
  initialPanel,
  history = true,
  kernelStats,
}: EditorAppProps) {
  const snapshot = useEditor(host);
  const { state, busy, lastError, zoom, currentPage } = snapshot;
  const format = state?.format;
  const engineStatus = useEngineStatus(engine);

  const active = useMemo(
    () => plugins.filter((p) => !p.formats || (format !== undefined && p.formats.includes(format))),
    [plugins, format],
  );
  const mainPlugin = active.find((p) => hasMainView(p, format));
  const overlays = useMemo(() => active.filter((p) => p.PageOverlay), [active]);
  // The shortcut table: the open format's plugins, or every plugin before a document is open.
  const shortcutList = useMemo(() => listShortcuts(plugins, format ?? null, history), [plugins, format, history]);
  const shortcutCollisions = useMemo(() => {
    if (format) return findCollisions(shortcutList);
    const seen = new Map<string, ReturnType<typeof findCollisions>[number]>();
    for (const f of ["docx", "pptx", "xlsx"] as const) {
      for (const c of findCollisions(listShortcuts(plugins, f, history))) {
        seen.set(`${c.keys}|${c.when ?? ""}|${c.entries.map((e) => e.source + e.label).join()}`, c);
      }
    }
    return [...seen.values()];
  }, [plugins, format, history, shortcutList]);
  const panels = active.flatMap((plugin) =>
    (plugin.sidePanels ?? []).map((panel) => ({
      key: `${plugin.id}/${panel.id}`,
      plugin: plugin.id,
      panel,
      title: panel.title,
    })),
  );
  // Two plugins may pick the same title ("Changes"); name the plugin on those tabs.
  for (const entry of panels) {
    if (panels.some((other) => other !== entry && other.panel.title === entry.panel.title)) {
      entry.title = `${entry.panel.title} (${entry.plugin})`;
    }
  }

  const [opening, setOpening] = useState<OpenProgress | null>(null);
  /** Why the last open failed, shown on the landing page while no document is open. */
  const [problem, setProblem] = useState<OpenProblem | null>(null);
  /** Text of the polite live region (`shell-live`): opens, saves, undo and redo. */
  const [announcement, setAnnouncement] = useState("");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>(null);
  const [tab, setTab] = useState(initialPanel ?? INSPECTOR_TAB);
  const [layout, setLayoutState] = useState(() => loadLayout(storageKey));
  const [dragging, setDragging] = useState(false);
  const [render, setRender] = useState<RenderInfo | null>(null);
  const [warningsDismissed, setWarningsDismissed] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [perfOpen, setPerfOpen] = useState(false);
  const [stats, setStats] = useState<KernelStatsSnapshot | null>(null);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  /** The floating rail or panel open while narrow (session only, not saved). */
  const [overlay, setOverlay] = useState<"left" | "side" | null>(null);
  // Vector pages need a reactor kernel; the Fonts and licences sheet uses it in either page mode.
  const vector = useMemo(() => (isReactorKernel(host.kernel) ? new VectorPages(host.kernel) : null), [host]);
  useEffect(() => () => vector?.dispose(), [vector]);
  const drawVector = !!vector && pages === "vector";
  const fileInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const ptbRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  /** File name the user opened or saved as, per document (the kernel keeps an ASCII-safe sandbox name). */
  const names = useRef(new Map<string, string>());
  /** sha256 of the last saved (or opened) revision, per document. */
  const saved = useRef<{ doc: string; sha: string } | null>(null);
  if (state && saved.current?.doc !== state.doc) saved.current = { doc: state.doc, sha: state.sha256 };

  const dirty = !!state && saved.current?.sha !== state.sha256;
  const fileName = state ? (names.current.get(state.doc) ?? state.name) : null;
  const activeTab =
    tab === INSPECTOR_TAB ? tab : (panels.find((p) => p.key === tab || p.panel.id === tab)?.key ?? INSPECTOR_TAB);
  const fatal = engineStatus?.stage === "failed" ? engineStatus.error : null;

  function setLayout(patch: Partial<Layout>) {
    setLayoutState((current) => {
      const next = { ...current, ...patch };
      if (storageKey) {
        try {
          globalThis.localStorage?.setItem(`${storageKey}:layout`, JSON.stringify(next));
        } catch {
          // Storage full or blocked: the layout still applies for this session.
        }
      }
      return next;
    });
  }

  useEffect(() => {
    setSavedAt(null);
    setRender(null);
    setFontsOpen(false);
    // The document closed: release its display lists and images.
    if (!state) vector?.closeDoc();
  }, [state?.doc]);

  useEffect(() => {
    if (!documentTitle) return;
    document.title = fileName ? `${dirty ? "* " : ""}${fileName} - Wolf Review` : "Wolf Review";
  }, [fileName, dirty, documentTitle]);

  // Kernel statistics for the Performance popover, while it is open.
  useEffect(() => {
    if (!perfOpen || !kernelStats) return;
    let live = true;
    const poll = () =>
      kernelStats().then(
        (s) => live && setStats(s),
        () => {},
      );
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [perfOpen, kernelStats]);

  // Unsaved-changes guard for closing or reloading the tab.
  useEffect(() => {
    if (!dirty || !unloadGuard) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, unloadGuard]);

  function confirmDiscard(): boolean {
    return !dirty || globalThis.confirm(`Discard unsaved changes to ${fileName}?`);
  }

  function usesPagesFor(f: DocFormat): boolean {
    return !plugins.some((p) => hasMainView(p, f) && (!p.formats || p.formats.includes(f)));
  }

  /** A failed open: on the landing page as a notice, over an open document as a toast. */
  function showProblem(p: OpenProblem) {
    if (host.getSnapshot().state) {
      host.reportError({ code: p.code, message: `${p.title}. ${p.detail}${p.message ? ` (${p.message})` : ""}` });
    } else {
      host.clearError();
      setProblem(p);
    }
  }

  async function openBytes(bytes: Uint8Array, name: string) {
    const pre = checkFile(name, bytes.length, bytes.subarray(0, 4));
    if (pre) {
      setOpening(null);
      showProblem(pre);
      return;
    }
    setProblem(null);
    const engineStages = !!engine && engine.getStatus().stage !== "ready";
    setOpening({ name, step: engineStages ? "engine" : "open", engineStages });
    if (engine) {
      await engine.downloaded();
      if (engine.getStatus().stage === "failed") {
        setOpening(null);
        return;
      }
      engine.compiling();
    }
    setOpening({ name, step: "open", engineStages });
    try {
      const opened = await host.open(bytes, name);
      names.current.set(opened.doc, name);
      setAnnouncement(`Opened ${name}, ${opened.pages.length} ${opened.pages.length === 1 ? "page" : "pages"}`);
      onEngineReady?.();
      // Keep the stages up until the first page image is on screen.
      if (usesPagesFor(opened.format) && opened.pages.length > 0) setOpening({ name, step: "page", engineStages });
      else setOpening(null);
    } catch (cause) {
      const error = toKernelError(cause);
      setOpening(null);
      if (error.code === "wasm-compile-failed" && engine) {
        engine.failed(error);
        host.clearError();
        return;
      }
      // The engine stopped (crash, closed kernel): the fatal state or the restart toast speaks for it.
      if (error.code === "kernel-closed" || error.code === "kernel-restarted") return;
      showProblem(describeOpenFailure(error, name));
    }
  }

  async function openFile(file: File) {
    if (!confirmDiscard()) return;
    // Size and type first: a 2 GB video dropped by mistake is never read into memory.
    const head = new Uint8Array(
      await file
        .slice(0, 4)
        .arrayBuffer()
        .catch(() => new ArrayBuffer(0)),
    );
    const pre = checkFile(file.name, file.size, head);
    if (pre) {
      showProblem(pre);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (cause) {
      const error = toKernelError(cause, "file-read-failed");
      showProblem({
        name: file.name,
        code: error.code,
        message: error.message,
        title: `${file.name} could not be read from disk`,
        detail:
          "The browser could not read the file. Check that it still exists and is not locked by another program, then choose it again.",
      });
      return;
    }
    await openBytes(bytes, file.name);
  }

  async function openSample(sample: Sample) {
    if (!confirmDiscard()) return;
    const name = fileNameFromUrl(sample.url);
    setProblem(null);
    setOpening({ name, step: "file", engineStages: !!engine && engine.getStatus().stage !== "ready" });
    let response: Response | null = null;
    let failure: KernelError | null = null;
    try {
      response = await fetch(sample.url);
      if (!response.ok)
        failure = {
          code: "sample-fetch-failed",
          message: `GET ${sample.url} answered ${response.status} ${response.statusText}`,
        };
    } catch (cause) {
      failure = toKernelError(cause, "sample-fetch-failed");
    }
    if (failure || !response) {
      setOpening(null);
      showProblem({
        name,
        code: failure?.code ?? "sample-fetch-failed",
        message: failure?.message,
        title: `The sample ${name} could not be downloaded`,
        detail: "Check the connection to the server this page came from, then choose the sample again.",
      });
      return;
    }
    await openBytes(new Uint8Array(await response.arrayBuffer()), name);
  }

  function markSaved() {
    const current = host.getSnapshot().state;
    if (!current) return;
    saved.current = { doc: current.doc, sha: current.sha256 };
    setSavedAt(new Date());
    setAnnouncement(`Saved ${names.current.get(current.doc) ?? current.name}`);
  }

  async function save() {
    if (!state || !fileName) return;
    try {
      const bytes = await host.save();
      if (!(onSave && (await onSave(bytes, fileName, state.format))))
        downloadBytes(bytes, fileName, MIME[state.format]);
      markSaved();
    } catch (cause) {
      host.reportError(toKernelError(cause, "save-failed"));
    }
  }

  async function saveAs() {
    if (!state || !fileName) return;
    try {
      const bytes = await host.save();
      if (onSave && (await onSave(bytes, fileName, state.format))) {
        markSaved();
        return;
      }
      const chosen = await saveBytesAs(bytes, fileName, state.format);
      if (!chosen) return;
      names.current.set(state.doc, chosen);
      markSaved();
    } catch (cause) {
      host.reportError(toKernelError(cause, "save-failed"));
    }
  }

  async function closeDocument() {
    if (!state || !confirmDiscard()) return;
    await host.close().catch((cause: unknown) => host.reportError(toKernelError(cause)));
  }

  function zoomTo(next: number) {
    setFitMode(null);
    host.setZoom(clampZoom(next));
  }

  /** F6 order: toolbar, plugin tools, left rail, canvas, side panel (the ones on screen). */
  function cycleRegion(back: boolean) {
    const regions = [toolbarRef.current, ptbRef.current, leftRef.current, mainRef.current, sideRef.current].filter(
      (el): el is HTMLElement => !!el && !el.hidden && el.offsetParent !== null,
    );
    if (!regions.length) return;
    const root = rootRef.current?.getRootNode() as Document | ShadowRoot | undefined;
    const focused = root?.activeElement ?? null;
    const at = regions.findIndex((r) => focused && r.contains(focused));
    const next = regions[(at + (back ? -1 : 1) + regions.length) % regions.length]!;
    const first =
      next === toolbarRef.current || next === ptbRef.current
        ? next.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)")
        : null;
    (first ?? next).focus();
  }

  function goToPage(which: "next" | "previous" | "first" | "last"): boolean {
    const snap = host.getSnapshot();
    const count = snap.state?.pages.length ?? 0;
    if (!count || !usesPagesFor(snap.state!.format)) return false;
    const page =
      which === "first"
        ? 1
        : which === "last"
          ? count
          : Math.min(count, Math.max(1, snap.currentPage + (which === "next" ? 1 : -1)));
    host.setCurrentPage(page);
    host.reveal({ page });
    return true;
  }

  const actions: Record<ShellAction, () => unknown> = {
    undo: () => {
      if (host.getSnapshot().state?.canUndo)
        void host.undo().then(
          () => setAnnouncement("Undone"),
          () => {},
        );
    },
    redo: () => {
      if (host.getSnapshot().state?.canRedo)
        void host.redo().then(
          () => setAnnouncement("Redone"),
          () => {},
        );
    },
    save: () => void save(),
    saveAs: () => void saveAs(),
    open: () => fileInput.current?.click(),
    zoomIn: () => zoomTo(stepZoom(host.getSnapshot().zoom, 1)),
    zoomOut: () => zoomTo(stepZoom(host.getSnapshot().zoom, -1)),
    zoomReset: () => zoomTo(1),
    nextRegion: () => cycleRegion(false),
    previousRegion: () => cycleRegion(true),
    shortcuts: () => setShortcutsOpen(true),
    nextPage: () => goToPage("next"),
    previousPage: () => goToPage("previous"),
    firstPage: () => goToPage("first"),
    lastPage: () => goToPage("last"),
  };
  const latest = useRef({ active, actions, openFile });
  latest.current = { active, actions, openFile };

  // Keys pressed inside the editor: the shell's global shortcuts (registry `phase: "first"`),
  // then each active plugin in order, then the shell's fallbacks (page keys, Escape).
  // Listening on the root (not window) keeps two editors on one page, and the embedding page, apart.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const run = (event: KeyboardEvent, phase: "first" | "last", target: EventTarget | null): boolean => {
      for (const b of SHELL_BINDINGS) {
        if (!b.action || b.phase !== phase || !matches(event, b.shortcut.keys)) continue;
        if (!history && (b.action === "undo" || b.action === "redo")) continue;
        // Page keys belong to the page view: not in toolbars, rails, panels or popovers.
        if (
          phase === "last" &&
          !(target === document.body || (target instanceof Node && mainRef.current?.contains(target)))
        )
          return false;
        if (latest.current.actions[b.action]() === false) return false;
        event.preventDefault();
        return true;
      }
      return false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Inside a shadow root `event.target` is the host; the composed path names the real element.
      const target = event.composedPath()[0] ?? event.target;
      if (isEditableTarget(target)) return;
      if (run(event, "first", target)) return;
      for (const plugin of latest.current.active) {
        if (!plugin.onKeyDown) continue;
        let handled = false;
        try {
          handled = plugin.onKeyDown(event, host);
        } catch (cause) {
          host.reportError({ ...toKernelError(cause, "plugin-failed"), argument: plugin.id });
          continue;
        }
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (run(event, "last", target)) return;
      if (event.key === "Escape") {
        if (host.getSnapshot().lastError) {
          event.preventDefault();
          host.clearError();
        } else if (host.getSnapshot().selection.length) {
          event.preventDefault();
          host.select([]);
        }
      }
    };
    root.addEventListener("keydown", onKeyDown);
    // The page-owning editor also takes keys typed while nothing is focused (right after load).
    const onWindowKey = (event: KeyboardEvent) => {
      const target = event.composedPath()[0];
      if (target === document.body || target === document.documentElement || target === document) onKeyDown(event);
    };
    if (documentTitle) window.addEventListener("keydown", onWindowKey);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onWindowKey);
    };
  }, [host, documentTitle, history]);

  // Drop a file anywhere on the editor to open it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (event.defaultPrevented || !hasFiles(event)) return;
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file) void latest.current.openFile(file);
    };
    root.addEventListener("dragenter", onEnter);
    root.addEventListener("dragover", onOver);
    root.addEventListener("dragleave", onLeave);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("dragenter", onEnter);
      root.removeEventListener("dragover", onOver);
      root.removeEventListener("dragleave", onLeave);
      root.removeEventListener("drop", onDrop);
    };
  }, []);

  // Below NARROW px the rail and side panel float over the canvas instead of squeezing it,
  // closed until asked for. The choice is for this width only: the saved layout is untouched.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const isNarrow = root.getBoundingClientRect().width < NARROW;
      setNarrow(isNarrow);
      if (!isNarrow) setOverlay(null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const pageIndex = state ? state.pages.findIndex((p) => p.page === currentPage) : -1;
  const showWarnings =
    !!state && (state.truncated || state.warnings.length > 0) && warningsDismissed !== `${state.doc}:${state.revision}`;
  const zoomOptions = ZOOM_PRESETS.some((z) => Math.abs(z - zoom) < 1e-3)
    ? ZOOM_PRESETS
    : [...ZOOM_PRESETS, zoom].sort((a, b) => a - b);
  const docControls = !state;
  const usesPages = !!state && !mainPlugin;
  const leftRails = active.filter((p) => p.LeftRail);
  const bottomBars = active.filter((p) => p.BottomBar);
  const belowCanvas = active.filter((p) => p.BelowCanvas);
  const toolbars = active.filter((p) => p.Toolbar);
  const docKey = state?.doc ?? "none";
  const leftShown = leftRails.length > 0 && (narrow ? overlay === "left" : layout.leftOpen);
  const sideShown = !!state && (narrow ? overlay === "side" : layout.sideOpen);
  const toggleLeft = () =>
    narrow ? setOverlay((o) => (o === "left" ? null : "left")) : setLayout({ leftOpen: !layout.leftOpen });
  const toggleSide = () =>
    narrow ? setOverlay((o) => (o === "side" ? null : "side")) : setLayout({ sideOpen: !layout.sideOpen });
  /** Escape inside a floating rail or panel closes it and returns focus to its toggle. */
  const closeOverlayOnEscape = (which: "left" | "side") => (event: KeyboardEvent) => {
    if (!narrow || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    setOverlay(null);
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-testid=shell-${which === "left" ? "rail" : "side"}-toggle]`)
      ?.focus();
  };
  const pageStage = opening?.step === "page";

  let canvas: ComponentChildren;
  if (fatal) {
    canvas = <FatalState error={fatal} onRetry={onRetry ?? (() => location.reload())} />;
  } else if (!state) {
    canvas = opening ? (
      <LoadingStages progress={opening} engine={engineStatus} testid="shell-loading" />
    ) : (
      <Landing
        samples={samples}
        problem={problem}
        engine={engineStatus}
        onDismissProblem={() => setProblem(null)}
        onOpen={actions.open}
        onSample={(s) => void openSample(s)}
      />
    );
  } else {
    const pageView = (
      <PageScroller
        vector={drawVector ? vector : null}
        host={host}
        snapshot={snapshot}
        overlays={overlays}
        fitMode={fitMode}
        onFitModeChange={setFitMode}
        onRender={setRender}
        onShown={() => setOpening((o) => (o?.step === "page" ? null : o))}
      />
    );
    if (mainPlugin) {
      const MainView = mainPlugin.MainView!;
      canvas = (
        <PluginBoundary key={`${mainPlugin.id}:${docKey}`} host={host} plugin={mainPlugin.id} slot="MainView">
          <MainView host={host} pages={pageView} />
        </PluginBoundary>
      );
    } else {
      canvas = pageView;
    }
  }

  const status: { text: string; tone: string; testid: string; title: string } | null = !state
    ? null
    : dirty
      ? { text: "Unsaved changes", tone: "warning", testid: "shell-dirty", title: "Changed since the last save" }
      : savedAt
        ? { text: `Saved ${formatClockTime(savedAt)}`, tone: "success", testid: "shell-status-saved", title: "Saved" }
        : { text: "No changes", tone: "", testid: "shell-clean", title: "Same as the opened file" };

  return (
    <div class="we-shell" data-testid="shell-app" data-theme={theme} ref={rootRef} tabIndex={-1}>
      <header class="we-shell-titlebar">
        <span class="we-shell-brand" data-testid="shell-title">
          <Logo />
          <span>Wolf Review</span>
        </span>
        {state ? (
          <div class="we-shell-doc" aria-label="Document">
            <span class="we-shell-doc-sep" aria-hidden="true" />
            <FormatIcon format={state.format} size={18} />
            <span class="we-shell-filename" data-testid="shell-filename" title={fileName ?? ""}>
              {fileName}
            </span>
            <span class={`we-shell-badge we-shell-badge-${state.format}`} data-testid="shell-format">
              {state.format.toUpperCase()}
            </span>
            {status && (
              <span
                class={`we-chip${status.tone ? ` we-chip--${status.tone}` : ""}`}
                data-testid={status.testid}
                title={status.title}
              >
                {status.text}
              </span>
            )}
            <span
              class="we-shell-revision"
              data-testid="shell-revision"
              title={`Revision ${state.revision} of ${state.revisionCount - 1} (0 is the opened file)`}
            >
              Revision {state.revision} of {state.revisionCount - 1}
            </span>
          </div>
        ) : (
          <span class="we-shell-muted we-shell-nodoc">No document open</span>
        )}
        <span class="we-shell-spacer" />
        {opening && (
          <span class="we-chip we-chip--info we-shell-busy" aria-hidden="true" data-testid="shell-busy">
            <span class="we-shell-spinner" aria-hidden="true" />
            Opening {opening.name}
          </span>
        )}
        <button
          class="we-btn we-btn--icon we-btn--small"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          data-testid="shell-shortcuts-open"
          onClick={() => setShortcutsOpen(true)}
        >
          <Icon name="keyboard" />
        </button>
      </header>

      <div
        class="we-shell-toolbar"
        role="toolbar"
        aria-label={history ? "File, history and zoom" : "File and zoom"}
        data-testid="shell-toolbar"
        ref={toolbarRef}
      >
        <ToolButton
          icon="open"
          text="Open"
          label="Open"
          title={`Open a file (${keysOf("open")})`}
          testid="shell-open"
          onClick={actions.open}
        />
        {samples.length > 0 && (
          <select
            class="we-select we-shell-samples-select"
            title="Open a sample document"
            aria-label="Open a sample document"
            data-testid="shell-samples"
            value=""
            onChange={(e) => {
              const sample = samples[Number(e.currentTarget.value)];
              e.currentTarget.value = "";
              if (sample) void openSample(sample);
            }}
          >
            <option value="" disabled>
              Samples
            </option>
            {samples.map((s, i) => (
              <option key={s.url} value={String(i)}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <ToolButton
          icon="save"
          text="Save"
          label="Save"
          title={`Save: download the file (${keysOf("save")})`}
          testid="shell-save"
          onClick={actions.save}
          disabled={docControls}
        />
        <ToolButton
          icon="saveAs"
          label="Save as"
          title={`Save as (${keysOf("saveAs")})`}
          testid="shell-save-as"
          onClick={actions.saveAs}
          disabled={docControls}
        />
        <ToolButton
          icon="close"
          label="Close"
          title="Close the document"
          testid="shell-close"
          onClick={() => void closeDocument()}
          disabled={docControls}
        />
        <span class="we-sep" />
        {history && (
          <ToolButton
            icon="undo"
            label="Undo"
            title={`Undo (${keysOf("undo")})`}
            testid="shell-undo"
            onClick={actions.undo}
            disabled={!state?.canUndo}
          />
        )}
        {history && (
          <ToolButton
            icon="redo"
            label="Redo"
            title={`Redo (${keysOf("redo")})`}
            testid="shell-redo"
            onClick={actions.redo}
            disabled={!state?.canRedo}
          />
        )}
        {history && <span class="we-sep" />}
        <ToolButton
          icon="minus"
          label="Zoom out"
          title={`Zoom out (${keysOf("zoomOut")})`}
          testid="shell-zoom-out"
          onClick={actions.zoomOut}
          disabled={docControls}
        />
        <select
          class="we-select we-shell-zoom-select"
          title={`Zoom (${keysOf("zoomReset")} for 100%)`}
          aria-label="Zoom"
          data-testid="shell-zoom-select"
          value={String(zoom)}
          disabled={docControls}
          onChange={(e) => zoomTo(Number(e.currentTarget.value))}
        >
          {zoomOptions.map((z) => (
            <option key={z} value={String(z)}>
              {formatZoom(z)}
            </option>
          ))}
        </select>
        <ToolButton
          icon="plus"
          label="Zoom in"
          title={`Zoom in (${keysOf("zoomIn")})`}
          testid="shell-zoom-in"
          onClick={actions.zoomIn}
          disabled={docControls}
        />
        <ToolButton
          icon="fitWidth"
          label="Fit width"
          title="Fit the page width to the window"
          testid="shell-fit-width"
          pressed={fitMode === "width"}
          disabled={!usesPages}
          onClick={() => setFitMode(fitMode === "width" ? null : "width")}
        />
        <ToolButton
          icon="fitPage"
          label="Fit page"
          title="Fit the whole page in the window"
          testid="shell-fit-page"
          pressed={fitMode === "page"}
          disabled={!usesPages}
          onClick={() => setFitMode(fitMode === "page" ? null : "page")}
        />
        <span class="we-shell-spacer" />
        {leftRails.length > 0 && (
          <ToolButton
            icon="panelLeft"
            label="Left rail"
            title={leftShown ? "Hide the left rail" : "Show the left rail"}
            testid="shell-rail-toggle"
            pressed={leftShown}
            onClick={toggleLeft}
          />
        )}
        <ToolButton
          icon="panelRight"
          label="Panels"
          title={sideShown ? "Hide the side panels" : "Show the side panels"}
          testid="shell-side-toggle"
          disabled={docControls}
          pressed={sideShown}
          onClick={toggleSide}
        />
      </div>

      {toolbars.length > 0 && (
        <div class="we-shell-ptb-region" ref={ptbRef} tabIndex={-1} aria-label="Format tools">
          <OverflowRow testid="shell-plugin-toolbars">
            {toolbars.map((plugin) => {
              const Toolbar = plugin.Toolbar!;
              return (
                <div class="we-shell-ptb-item" key={plugin.id} data-testid={`shell-plugin-toolbar-${plugin.id}`}>
                  <PluginBoundary key={docKey} host={host} plugin={plugin.id} slot="Toolbar">
                    <Toolbar host={host} />
                  </PluginBoundary>
                </div>
              );
            })}
          </OverflowRow>
        </div>
      )}

      {showWarnings && state && (
        <div class="we-notice we-notice--warning we-shell-warnings" role="status" data-testid="shell-warnings">
          <Icon name="alert" />
          <div class="we-shell-warning-list">
            {state.truncated && (
              <div data-testid="shell-warning-truncated">
                <strong>view-truncated</strong> The engine cut the view at its node limit; some objects are not listed.
              </div>
            )}
            {state.warnings.map((w, i) => (
              <div key={i} data-testid={`shell-warning-${i}`}>
                <strong>{w.code}</strong> {w.message}
              </div>
            ))}
          </div>
          <button
            class="we-btn we-btn--small"
            title="Hide warnings for this revision"
            aria-label="Hide warnings for this revision"
            data-testid="shell-warnings-dismiss"
            onClick={() => setWarningsDismissed(`${state.doc}:${state.revision}`)}
          >
            Hide
          </button>
        </div>
      )}

      <div class="we-shell-body">
        {leftRails.length > 0 && (
          <>
            <aside
              class={`we-shell-left${narrow ? " is-overlay" : ""}`}
              data-testid="shell-left-rail"
              aria-label="Left rail"
              tabIndex={-1}
              ref={leftRef}
              hidden={!leftShown}
              style={{ width: `${layout.leftWidth}px` }}
              onKeyDown={closeOverlayOnEscape("left")}
            >
              {leftRails.map((plugin) => {
                const LeftRail = plugin.LeftRail!;
                return (
                  <PluginBoundary key={`${plugin.id}:${docKey}`} host={host} plugin={plugin.id} slot="LeftRail">
                    <LeftRail host={host} />
                  </PluginBoundary>
                );
              })}
            </aside>
            {leftShown && !narrow && (
              <Splitter
                edge="left"
                width={layout.leftWidth}
                min={LEFT_MIN}
                max={LEFT_MAX}
                label="Left rail width"
                testid="shell-left-splitter"
                onResize={(w) => setLayout({ leftWidth: w })}
              />
            )}
          </>
        )}

        <main class="we-shell-main" data-testid="shell-main" aria-label="Document canvas" tabIndex={-1} ref={mainRef}>
          {busy && !opening && <div class="we-shell-busybar" aria-hidden="true" />}
          {canvas}
          {belowCanvas.length > 0 && (
            <div class="we-shell-below-canvas" data-testid="shell-below-canvas">
              {belowCanvas.map((plugin) => {
                const BelowCanvas = plugin.BelowCanvas!;
                return (
                  <PluginBoundary key={`${plugin.id}:${docKey}`} host={host} plugin={plugin.id} slot="BelowCanvas">
                    <BelowCanvas host={host} />
                  </PluginBoundary>
                );
              })}
            </div>
          )}
          {state && opening && !fatal && (
            <div class={`we-shell-veil${pageStage ? " is-passive" : ""}`} data-testid="shell-opening">
              <LoadingStages progress={opening} engine={engineStatus} compact testid="shell-opening-stages" />
            </div>
          )}
          {lastError && (
            <div class="we-shell-toasts">
              <ErrorToast error={lastError} onDismiss={() => host.clearError()} />
            </div>
          )}
        </main>

        {sideShown && (
          <>
            {!narrow && (
              <Splitter
                edge="right"
                width={layout.sideWidth}
                min={SIDE_MIN}
                max={SIDE_MAX}
                label="Side panel width"
                testid="shell-side-splitter"
                onResize={(w) => setLayout({ sideWidth: w })}
              />
            )}
            <aside
              class={`we-shell-side${narrow ? " is-overlay" : ""}`}
              data-testid="shell-side"
              aria-label="Side panels"
              tabIndex={-1}
              ref={sideRef}
              style={{ width: `${layout.sideWidth}px` }}
              onKeyDown={closeOverlayOnEscape("side")}
            >
              <PanelTabs
                tabs={[
                  { key: INSPECTOR_TAB, id: "inspector", title: "Inspector" },
                  ...panels.map((p) => ({ key: p.key, id: p.panel.id, title: p.title })),
                ]}
                active={activeTab}
                onSelect={setTab}
              />
              <div
                class="we-shell-panel"
                role="tabpanel"
                id="we-shell-panel-inspector"
                aria-labelledby="we-shell-tab-inspector"
                hidden={activeTab !== INSPECTOR_TAB}
                data-testid="shell-panel-inspector"
              >
                <Inspector host={host} snapshot={snapshot} />
              </div>
              {panels.map(({ key, plugin, panel }) => {
                const Panel = panel.Component;
                return (
                  <div
                    key={key}
                    class="we-shell-panel"
                    role="tabpanel"
                    id={`we-shell-panel-${panel.id}`}
                    aria-labelledby={`we-shell-tab-${panel.id}`}
                    hidden={activeTab !== key}
                    data-testid={`shell-panel-${panel.id}`}
                  >
                    <PluginBoundary key={docKey} host={host} plugin={plugin} slot={`panel ${panel.id}`}>
                      <Panel host={host} />
                    </PluginBoundary>
                  </div>
                );
              })}
            </aside>
          </>
        )}
      </div>

      <div class="we-shell-sr-only" role="status" aria-live="polite" data-testid="shell-live">
        {announcement}
      </div>
      <footer class="we-shell-statusbar" data-testid="shell-bottom">
        <div class="we-shell-bottom-plugins">
          {bottomBars.map((plugin) => {
            const BottomBar = plugin.BottomBar!;
            return (
              <PluginBoundary key={`${plugin.id}:${docKey}`} host={host} plugin={plugin.id} slot="BottomBar">
                <BottomBar host={host} />
              </PluginBoundary>
            );
          })}
        </div>
        <div class="we-shell-status" aria-label="Status">
          {usesPages && state.pages.length > 0 && (
            <span data-testid="shell-status-page">
              Page {pageIndex + 1} of {state.pages.length}
            </span>
          )}
          {state && <span data-testid="shell-status-zoom">{formatZoom(zoom)}</span>}
          {environmentLabel && (
            <span data-testid="shell-status-clock" title="Clock the engine stamps edits with">
              {environmentLabel}
            </span>
          )}
          <PopoverButton
            label="Performance"
            title="Engine timings and caches"
            testid="shell-perf"
            panelTestid="shell-perf-panel"
            icon={<Icon name="gauge" />}
            text="Performance"
            onOpenChange={setPerfOpen}
          >
            {(closePerf) => (
              <PerformancePanel
                timings={state?.timings ?? null}
                render={render}
                sha256={state?.sha256 ?? null}
                engine={engineStatus}
                stats={stats}
                kernelLabel={kernelLabel}
                drawing={
                  drawVector
                    ? `vector${state ? `, ${vector.current(state.doc)?.fallbacks.size ?? 0} pages on PNG fallback` : ""}`
                    : "engine PNG"
                }
                onFonts={
                  vector && state
                    ? () => {
                        closePerf();
                        setFontsOpen(true);
                      }
                    : null
                }
              />
            )}
          </PopoverButton>
        </div>
      </footer>

      {dragging && (
        <div class="we-shell-drop" data-testid="shell-drop-overlay">
          <div class="we-shell-drop-card">
            <Icon name="upload" size={32} />
            <div>Drop to open</div>
            <div class="we-shell-muted">DOCX, PPTX or XLSX</div>
          </div>
        </div>
      )}
      {shortcutsOpen && (
        <ShortcutsSheet list={shortcutList} collisions={shortcutCollisions} onClose={() => setShortcutsOpen(false)} />
      )}
      {fontsOpen && vector && state && (
        <FontsSheet
          vector={vector}
          vdoc={vector.forDoc(state.doc)}
          onClose={() => {
            setFontsOpen(false);
            // The Fonts button lived in the closed Performance popover: focus its opener instead.
            rootRef.current?.querySelector<HTMLElement>("[data-testid=shell-perf]")?.focus();
          }}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept={OPEN_ACCEPT}
        hidden
        data-testid="shell-file-input"
        aria-label="Open file"
        onChange={(e) => {
          const input = e.currentTarget;
          const file = input.files?.[0];
          input.value = "";
          if (file) void openFile(file);
        }}
      />
    </div>
  );
}
