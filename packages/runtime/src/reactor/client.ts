/**
 * Main-thread `ReactorKernelClient` backed by a dedicated Web Worker that
 * holds the reactor instance (one per session). Results with byte payloads
 * (`page`, `save`, `query` files, `damageReport` outputs, `resource`) are
 * transferred, not copied; `open` copies its input so the caller keeps its
 * buffer.
 *
 * The engine module comes from `module` (compiled, or its bytes), else from
 * `engine` (`@wolfsdk/runtime/loader`: the public channel by default, SHA-256
 * checked), resolved and fetched inside the worker. A source with a custom
 * `fetch` (which cannot cross into a worker) is resolved and fetched here and
 * its bytes handed over.
 *
 * Recovery, two levels:
 * - A module trap (engine bug, out of memory) is handled inside the worker:
 *   the instance is dropped, the next call instantiates a new one from the
 *   compiled module and re-opens every open document's current revision
 *   from its retained bytes, checking its sha256 (`engine.ts`).
 * - A worker crash is handled here: the client keeps each open document's
 *   original bytes and op batches (with the clock each ran at). Every
 *   pending call rejects with `kernel-closed` (`apply` resolves it as a
 *   refusal); a new worker starts with the already-compiled module, each
 *   document is re-opened and its batches replayed (sha256 checked per
 *   batch), and the cursor restored. Document ids stay the same. Calls
 *   issued during the restore wait for it.
 *
 * `resource` answers are cached by handle (a content hash) for the life of
 * the client; the returned `bytes` are shared, do not mutate them.
 */
import {
  KernelRequestError,
  type ApplyResult,
  type BatchEnvironment,
  type DocId,
  type DiffResult,
  type DocState,
  type KernelError,
  type Op,
  type ReactorKernelClient,
  type Resource,
} from "@wolfsdk/protocol";
import { EngineLoadError, fetchEngineBytes, resolveEngine, type EngineSource } from "../loader.ts";
import type {
  DamageReportResult,
  ReactorEnvironment,
  ReactorKernelOptions,
  ReactorStats,
} from "./engine.ts";
import type { FromWorker, ReactorMethod, ToWorker, WorkerEngineSource } from "./protocol.ts";

export type {
  DamageReportResult,
  EngineInfo,
  ReactorEnvironment,
  ReactorKernelOptions,
  ReactorStats,
} from "./engine.ts";

export type ReactorKernelClientOptions = {
  /** Where the engine module comes from (`@wolfsdk/runtime/loader`): an
   * exact `url`, or a `channel` (default the public one) with an optional
   * `version` and `sha256`. Relative URLs resolve against the page. */
  engine?: EngineSource;
  /** Exact URL of `wolf_web.wasm`, resolved against the page URL; the same
   * as `engine.url`, and wins over it. Serve it as `application/wasm` so the
   * worker compiles it while it downloads (no checksum given). */
  moduleUrl?: string | URL;
  /** A compiled module, or the module's bytes (copied); wins over `engine`
   * and `moduleUrl`. */
  module?: WebAssembly.Module | Uint8Array;
  /** Clock, zone, locale and seed of every engine run. Default pinned
   * (`2026-01-01T00:00:00Z`, `UTC`, `en-US`, 0); `clock: "live"` stamps each
   * `apply` with the current time. Same as `options.environment`, and wins
   * over it. */
  environment?: ReactorEnvironment;
  /** Kernel options (render DPI, caches, handle cap, memory ceiling). */
  options?: ReactorKernelOptions;
  /** Restart a crashed worker and restore its documents. Default true. */
  restart?: boolean;
  /** The first worker (must run `worker.ts`); default spawns one. */
  worker?: Worker;
  /** Spawns restarted workers; default spawns `worker.ts`. */
  createWorker?: () => Worker;
};

export type ReactorClientStats = ReactorStats & {
  client: {
    /** Worker restarts after a crash. */
    restarts: number;
    /** Documents a restart could not restore (they are closed). */
    restoreFailures: { doc: DocId; error: KernelError }[];
    /** Resources held by the client cache. */
    resources: number;
  };
};

export type WorkerReactorKernelClient = ReactorKernelClient & {
  /** The module's `damage_report` on the current revision of `doc`; the
   * document is unchanged. Rejects with `unsupported` when the module lacks
   * the command. */
  damageReport(doc: DocId): Promise<DamageReportResult>;
  stats(): Promise<ReactorClientStats>;
  /** Test hooks: a real module trap inside the worker, and a worker crash. */
  debugTrap(): Promise<KernelError>;
  debugCrashWorker(): void;
  /** Stop the worker; pending and later calls reject with `kernel-closed`. */
  terminate(): void;
};

type Mirror = {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  batches: { ops: Op[]; at: Required<BatchEnvironment>; sha256: string }[];
  cursor: number;
};

type Pending = {
  resolve: (reply: { value: unknown; env?: Required<BatchEnvironment> }) => void;
  reject: (e: KernelRequestError) => void;
};

/** How the first `init` names the module (`ToWorker` `init`). */
type InitSource = { module?: WebAssembly.Module; bytes?: Uint8Array<ArrayBuffer>; engine?: WorkerEngineSource };

function spawnDefault(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "wolf-reactor" });
}

function errorOf(e: unknown): KernelError {
  return e instanceof KernelRequestError
    ? e.error
    : { code: "kernel-internal", message: e instanceof Error ? e.message : String(e) };
}

/** `value` made absolute against the page, when there is one. */
function absolute(value: string | URL): string {
  try {
    return new URL(value, globalThis.location?.href).href;
  } catch {
    return String(value);
  }
}

/** The engine source with its URLs absolute (a worker resolves relative URLs
 * against its own script, not the page). */
function pageSource(engine: EngineSource, moduleUrl: string | URL | undefined): EngineSource {
  const source: EngineSource = { ...engine };
  if (moduleUrl !== undefined) source.url = moduleUrl;
  if (source.url !== undefined && String(source.url) !== "") source.url = absolute(source.url);
  if (source.channel) source.channel = absolute(source.channel);
  return source;
}

export function createReactorKernelClient({
  engine = {},
  moduleUrl,
  module,
  environment,
  options = {},
  restart = true,
  worker,
  createWorker = spawnDefault,
}: ReactorKernelClientOptions = {}): WorkerReactorKernelClient {
  const kernelOptions: ReactorKernelOptions = { ...options, environment: environment ?? options.environment };
  const pending = new Map<number, Pending>();
  const mirrors = new Map<DocId, Mirror>();
  /** Client document id -> id inside the current worker, and back. */
  const toWorker = new Map<DocId, DocId>();
  const fromWorker = new Map<DocId, DocId>();
  const resources = new Map<string, Promise<Resource>>();
  let w: Worker = worker ?? createWorker();
  /** The compiled module, once known: every restarted worker gets it. */
  let compiled: WebAssembly.Module | undefined = module instanceof WebAssembly.Module ? module : undefined;
  let nextId = 1;
  let closed: KernelError | null = null;
  /** A module the client fetched itself could not be loaded. */
  let loadFailure: KernelError | null = null;
  let restarts = 0;
  const restoreFailures: { doc: DocId; error: KernelError }[] = [];

  function rejectPending(error: KernelError): void {
    for (const p of pending.values()) p.reject(new KernelRequestError(error));
    pending.clear();
  }

  function shutdown(error: KernelError): void {
    closed = error;
    rejectPending(error);
  }

  function crashed(message: string): void {
    const error: KernelError = { code: "kernel-closed", message };
    w.terminate();
    if (!restart || !compiled || closed) {
      shutdown(error);
      return;
    }
    rejectPending(error);
    restarts += 1;
    ready = restore();
  }

  function start(next: Worker, source: InitSource): void {
    w = next;
    w.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data;
      if (msg.type === "module") {
        compiled = msg.module;
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve({ value: msg.value, env: msg.env });
      else p.reject(new KernelRequestError(msg.error));
    };
    w.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      crashed(`worker crashed: ${event.message}`);
    };
    w.onmessageerror = () => crashed("worker sent an unreadable message");
    const init = { type: "init", options: kernelOptions, ...source } satisfies ToWorker;
    w.postMessage(init, source.bytes ? [source.bytes.buffer] : []);
  }

  /** The first worker's module source; a custom `fetch` is used here. */
  async function firstSource(): Promise<InitSource> {
    if (compiled) return { module: compiled };
    if (module instanceof WebAssembly.Module) return { module };
    if (module) return { bytes: new Uint8Array(module) };
    const source = pageSource(engine, moduleUrl);
    if (!source.fetch) return { engine: source };
    const bytes = await fetchEngineBytes(await resolveEngine(source), { fetch: source.fetch });
    return { bytes: new Uint8Array(bytes) };
  }

  let ready: Promise<void> = firstSource().then(
    (source) => start(w, source),
    (e: unknown) => {
      loadFailure =
        e instanceof EngineLoadError
          ? { code: e.code, message: e.message, argument: e.url }
          : { code: "wasm-compile-failed", message: e instanceof Error ? e.message : String(e) };
      w.terminate();
    },
  );

  function post(method: ReactorMethod, args: unknown[], transfer: Transferable[] = []) {
    if (closed) return Promise.reject(new KernelRequestError(closed));
    if (loadFailure) return Promise.reject(new KernelRequestError(loadFailure));
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown; env?: Required<BatchEnvironment> }>();
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "call", id, method, args } satisfies ToWorker, transfer);
    return promise;
  }

  function link(doc: DocId, inWorker: DocId): void {
    toWorker.set(doc, inWorker);
    fromWorker.set(inWorker, doc);
  }

  function unlink(doc: DocId): void {
    const inWorker = toWorker.get(doc);
    toWorker.delete(doc);
    if (inWorker !== undefined) fromWorker.delete(inWorker);
    mirrors.delete(doc);
  }

  function workerDoc(doc: DocId): DocId {
    const inWorker = toWorker.get(doc);
    if (inWorker === undefined)
      throw new KernelRequestError({ code: "doc-unknown", message: `no open document ${doc}` });
    return inWorker;
  }

  /** Rewrite worker document ids in a result to client ids. */
  function clientState<T>(value: T): T {
    const v = value as { doc?: unknown; state?: { doc?: unknown } };
    if (v && typeof v === "object") {
      if (typeof v.doc === "string") v.doc = fromWorker.get(v.doc) ?? v.doc;
      if (v.state && typeof v.state.doc === "string") v.state.doc = fromWorker.get(v.state.doc) ?? v.state.doc;
    }
    return value;
  }

  /** A call on an open document, after any restore. */
  async function onDoc<T>(method: ReactorMethod, doc: DocId, rest: unknown[] = []): Promise<T> {
    await ready;
    const { value } = await post(method, [workerDoc(doc), ...rest]);
    return clientState(value as T);
  }

  /** Track the cursor of undo/redo/goto. */
  async function moved(doc: DocId, state: Promise<DocState>): Promise<DocState> {
    const s = await state;
    const m = mirrors.get(doc);
    if (m) m.cursor = s.revision;
    return s;
  }

  async function restore(): Promise<void> {
    start(createWorker(), { module: compiled! });
    toWorker.clear();
    fromWorker.clear();
    for (const [doc, m] of [...mirrors]) {
      let inWorker: DocId | null = null;
      try {
        const copy = new Uint8Array(m.bytes);
        const opened = (await post("open", [copy, m.name], [copy.buffer])).value as DocState;
        inWorker = opened.doc;
        link(doc, inWorker);
        for (const [i, b] of m.batches.entries()) {
          const result = (await post("apply", [inWorker, b.ops, b.at])).value as ApplyResult;
          if (!result.ok) throw new KernelRequestError(result.error);
          if (result.state.sha256 !== b.sha256)
            throw new KernelRequestError({
              code: "restore-mismatch",
              message: `replaying batch ${i} of ${doc} gave ${result.state.sha256}, expected ${b.sha256}`,
            });
        }
        if (m.cursor !== m.batches.length) await post("goto", [inWorker, m.cursor]);
      } catch (e) {
        restoreFailures.push({ doc, error: errorOf(e) });
        unlink(doc);
        if (inWorker !== null && !closed) await post("close", [inWorker]).catch(() => undefined);
      }
    }
  }

  return {
    kind: "reactor",
    async open(bytes, name) {
      await ready;
      // `new Uint8Array(x)` copies; `slice()` on a Node Buffer would not.
      const copy = new Uint8Array(bytes);
      const retained = new Uint8Array(bytes);
      const state = (await post("open", [copy, name], [copy.buffer])).value as DocState;
      let doc = state.doc;
      for (let n = 1; toWorker.has(doc); n++) doc = `doc-r${restarts}-${n}`;
      link(doc, state.doc);
      mirrors.set(doc, { name, bytes: retained, batches: [], cursor: 0 });
      state.doc = doc;
      return state;
    },
    // A trap or a dead worker must not reject `apply`: it resolves a refusal.
    async apply(doc, ops, at) {
      try {
        await ready;
        const { value, env } = await post("apply", [workerDoc(doc), ops, at]);
        const result = clientState(value as ApplyResult);
        const m = mirrors.get(doc);
        if (result.ok && m && env) {
          m.batches.splice(m.cursor);
          m.batches.push({ ops: structuredClone(ops), at: env, sha256: result.state.sha256 });
          m.cursor = result.state.revision;
        }
        return result;
      } catch (e) {
        const error = errorOf(e);
        return { ok: false as const, error, errors: [error], timings: { compileMs: 0, totalMs: 0, runs: [] } };
      }
    },
    undo: (doc) => moved(doc, onDoc<DocState>("undo", doc)),
    redo: (doc) => moved(doc, onDoc<DocState>("redo", doc)),
    goto: (doc, revision) => moved(doc, onDoc<DocState>("goto", doc, [revision])),
    page: (doc, page, scale) => onDoc("page", doc, [page, scale]),
    save: (doc) => onDoc("save", doc),
    session: (doc) => onDoc("session", doc),
    query: (doc, request) => onDoc("query", doc, [request]),
    damageReport: (doc) => onDoc("damageReport", doc),
    async diff(before, after) {
      await ready;
      // Copies, as in `open`: the caller keeps its buffers.
      const a = new Uint8Array(before);
      const b = new Uint8Array(after);
      return (await post("diff", [a, b], [a.buffer, b.buffer])).value as DiffResult;
    },
    async close(doc) {
      await onDoc<void>("close", doc);
      unlink(doc);
    },
    displayList: (doc, page) => onDoc("displayList", doc, [page]),
    layoutInfo: (doc) => onDoc("layoutInfo", doc),
    hitTest: (doc, page, xPt, yPt) => onDoc("hitTest", doc, [page, xPt, yPt]),
    caretRects: (doc, objectId, start, end) => onDoc("caretRects", doc, [objectId, start, end]),
    textLayout: (doc, objectId) => onDoc("textLayout", doc, [objectId]),
    fonts: (doc) => onDoc("fonts", doc),
    sheetViewport: (doc, sheet, row0, col0, rows, cols) => onDoc("sheetViewport", doc, [sheet, row0, col0, rows, cols]),
    resource(handle) {
      let r = resources.get(handle);
      if (!r) {
        r = ready.then(() => post("resource", [handle])).then(({ value }) => value as Resource);
        resources.set(handle, r);
        r.catch(() => resources.delete(handle));
      }
      return r;
    },
    async stats() {
      await ready;
      const s = (await post("stats", [])).value as ReactorStats;
      return { ...s, client: { restarts, restoreFailures: [...restoreFailures], resources: resources.size } };
    },
    async debugTrap() {
      await ready;
      return (await post("debugTrap", [])).value as KernelError;
    },
    debugCrashWorker() {
      w.postMessage({ type: "crash" } satisfies ToWorker);
    },
    terminate() {
      w.terminate();
      shutdown({ code: "kernel-closed", message: "kernel terminated" });
    },
  };
}
