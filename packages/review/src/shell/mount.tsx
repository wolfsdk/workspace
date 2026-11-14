import { render } from "preact";
import type { KernelError } from "@wolfsdk/protocol";
import {
  createReactorKernelClient,
  type ReactorKernelClientOptions,
  type WorkerReactorKernelClient,
} from "@wolfsdk/runtime/client";
import { ENGINE_MODULE_NAME, type EngineSource } from "@wolfsdk/runtime/loader";
import ReactorWorker from "@wolfsdk/runtime/worker?worker";
import { createEditorHost, type EditorHost, type EditorPlugin } from "../host/index.ts";
import {
  EditorApp,
  type KernelStatsSnapshot,
  type PageMode,
  type SaveHandler,
  type Sample,
  type Theme,
} from "./EditorApp.tsx";
import { engineLoad, engineModule, workerFactory, workerSource, type EngineLoad } from "./engine.ts";
import { toKernelError } from "./util.ts";

export type MountOptions = {
  /** Where the engine module comes from: an exact `url`, or a `channel` (default
   * `https://wolfsdk.com/download/wolf`) with an optional `version` and `sha256`. The module is
   * fetched, checked against its SHA-256 and compiled once per source on the page. */
  engine?: EngineSource;
  /** File name of the module for the Performance popover; default `wolf_web.wasm`. */
  moduleName?: string;
  /** Page drawing; default `vector`. */
  pages?: PageMode;
  plugins: EditorPlugin[];
  samples?: Sample[];
  /** Kernel options, forwarded untouched to `createReactorKernelClient({ engine, ...kernel })`
   * (for example `environment: { clock: "live" }`). Passing `worker` or `createWorker` here
   * replaces the shell's worker factory, and the kernel then loads its own module. */
  kernel?: Record<string, unknown>;
  /** Colour theme; `auto` (default) follows the system. `setTheme` changes it later. */
  theme?: Theme;
  /** Write the file name and dirty mark into `document.title`. Default true; embeds pass false. */
  documentTitle?: boolean;
  /** Receives the bytes on Save and Save as; return true when handled, so the shell skips its download. */
  onSave?: SaveHandler;
  /** localStorage key prefix for the layout (panel widths, collapsed panels). Default
   * `"wolf-review"`; null keeps the layout in memory only. */
  storageKey?: string | null;
  /** Ask before the page unloads with unsaved edits. Default true; embeds pass false. */
  unloadGuard?: boolean;
  /** Side-panel tab shown first (`EditorAppProps.initialPanel`). Default: the Inspector. */
  initialPanel?: string;
  /** Undo and redo buttons and shortcuts (`EditorAppProps.history`). Default true. */
  history?: boolean;
  /** Called once the engine module is compiled. */
  onReady?: () => void;
};

export type MountedEditor = {
  /** Current host and kernel. A retry after a failed engine load replaces both. */
  readonly host: EditorHost;
  readonly kernel: WorkerReactorKernelClient;
  setTheme(theme: Theme): void;
  /** Unmount the app and stop the kernel worker. */
  unmount(): void;
};

/** The engine's pinned clock when no option overrides it (`KernelOptions.clock`). */
const PINNED_CLOCK = "2026-01-01T00:00:00Z";

/** Status-bar label for the clock the kernel runs the engine with. */
function clockLabel(kernel: Record<string, unknown>): string {
  const environment = kernel.environment;
  const options = kernel.options;
  const pick = (v: unknown) => (typeof v === "object" && v !== null && "clock" in v ? v.clock : undefined);
  const clock =
    pick(environment) ??
    pick(options) ??
    (typeof options === "object" && options !== null && "environment" in options
      ? pick(options.environment)
      : undefined);
  if (clock === "live") return "Live clock";
  return `Pinned clock ${(typeof clock === "string" ? clock : PINNED_CLOCK).slice(0, 10)}`;
}

type Started = {
  client: WorkerReactorKernelClient;
  stats: () => Promise<KernelStatsSnapshot>;
};

/** Create the kernel worker and the host, and render the editor into `element`. */
export function mountEditor(element: HTMLElement, options: MountOptions): MountedEditor {
  const {
    engine: source = {},
    pages = "vector",
    plugins,
    samples,
    kernel = {},
    documentTitle = true,
    onSave,
    storageKey = "wolf-review",
    unloadGuard = true,
    initialPanel,
    history = true,
    onReady,
  } = options;
  let theme: Theme = options.theme ?? "auto";
  let host!: EditorHost;
  let client!: WorkerReactorKernelClient;
  let generation = 0;
  let paint = () => {};
  const ownWorkers = !("worker" in kernel) && !("createWorker" in kernel);

  /**
   * The client spawns its worker again only after a crash, to restore the open documents.
   * Returns the hook the worker factory calls on every spawn: from the second on it checks
   * that the document on screen came back (a toast), or fails the engine (the fatal state,
   * with Retry) when it did not.
   */
  function watchRestarts(
    engine: EngineLoad,
    clientStats: () => Promise<{
      client: { restarts: number; restoreFailures: { doc: string; error: KernelError }[] };
    }>,
  ): () => void {
    let spawned = 0;
    let checking: Promise<void> | null = null;
    async function checkRestore(): Promise<void> {
      try {
        const s = await clientStats();
        const doc = host.getSnapshot().state?.doc;
        const lost = s.client.restoreFailures.find((f) => f.doc === doc);
        if (lost) {
          engine.failed({
            code: lost.error.code,
            message: `The engine worker stopped and the document could not be restored: ${lost.error.message}`,
          });
        } else {
          host.reportError({
            code: "kernel-restarted",
            message: `The engine worker stopped and was restarted (${s.client.restarts} so far); the document was restored.`,
          });
        }
      } catch (cause) {
        engine.failed(toKernelError(cause));
      } finally {
        checking = null;
      }
    }
    return () => {
      if (spawned++ > 0) checking ??= Promise.resolve().then(() => checkRestore());
    };
  }

  function startReactor(engine: EngineLoad, module: Promise<WebAssembly.Module>): Started {
    let c!: WorkerReactorKernelClient;
    const spawned = watchRestarts(engine, () => c.stats());
    const spawnWorker = workerFactory(module, () => new ReactorWorker({ name: "wolf-reactor" }));
    const createWorker = (): Worker => {
      spawned();
      return spawnWorker();
    };
    // Forwarded as given: options the kernel adds later need no shell change.
    const clientOptions: ReactorKernelClientOptions = ownWorkers
      ? { engine: workerSource(source), worker: createWorker(), createWorker, ...kernel }
      : { engine: source, ...kernel };
    c = createReactorKernelClient(clientOptions);
    return {
      client: c,
      stats: async () => {
        try {
          const s = await c.stats();
          return {
            pngCache: s.pngCache,
            displayListCache: s.displayListCache,
            memoryBytes: s.memoryBytes,
            lastDeterminism: s.lastDeterminism,
            restarts: s.client.restarts,
            restoreFailures: s.client.restoreFailures.length,
          };
        } catch (cause) {
          // A closed kernel (a restart that could not start) or an engine the client refuses
          // cannot serve anything: the fatal state offers Retry.
          const error: KernelError = toKernelError(cause);
          if (error.code === "kernel-closed" || error.code === "engine-incompatible") engine.failed(error);
          throw cause;
        }
      },
    };
  }

  function start() {
    const engine = engineLoad(source);
    const module = engineModule(source).then((m) => m.module);
    let ready = false;
    const compiled = () => {
      engine.compiled();
      if (ready) return;
      ready = true;
      onReady?.();
    };
    module.then(compiled, () => {});
    const started = startReactor(engine, module);
    client = started.client;
    host = createEditorHost(client);
    const kernelLabel = `reactor (${options.moduleName ?? ENGINE_MODULE_NAME})`;
    const gen = ++generation;
    paint = () =>
      render(
        <EditorApp
          key={gen}
          host={host}
          plugins={plugins}
          samples={samples}
          environmentLabel={clockLabel(kernel)}
          kernelLabel={kernelLabel}
          pages={pages}
          engine={engine}
          onEngineReady={compiled}
          onRetry={retry}
          theme={theme}
          documentTitle={documentTitle}
          onSave={onSave}
          storageKey={storageKey}
          unloadGuard={unloadGuard}
          initialPanel={initialPanel}
          history={history}
          kernelStats={started.stats}
        />,
        element,
      );
    paint();
  }

  function retry() {
    client.terminate();
    start();
  }

  start();
  return {
    get host() {
      return host;
    },
    get kernel() {
      return client;
    },
    setTheme(next) {
      theme = next;
      paint();
    },
    unmount() {
      render(null, element);
      client.terminate();
    },
  };
}
