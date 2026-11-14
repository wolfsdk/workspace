import type { KernelError } from "@wolfsdk/protocol";
import {
  DEFAULT_ENGINE_CHANNEL,
  EngineLoadError,
  fetchEngineBytes,
  resolveEngine,
  type EngineSource,
  type ResolvedEngine,
} from "@wolfsdk/runtime/loader";

/**
 * Load progress of the engine module, for the loading and fatal states.
 *
 * The module is resolved on its channel (`latest.txt`, then the `SHA256SUMS`
 * line of `wolf_web.wasm`, or of `wolf_web_<format>.wasm` for a source with a
 * `format`) or taken from an exact URL, fetched on the main
 * thread with its bytes counted against `Content-Length`, checked against its
 * SHA-256, and compiled once per source on the page. Every kernel worker that
 * uses the same source gets the compiled module in its `init` message, so no
 * worker downloads or compiles anything. A failed load keeps the loader's
 * error code (`channel-unreachable`, `bad-version`, `bad-format`, `missing-checksum`,
 * `checksum-mismatch`, `http-error`) and the URL it failed on, which the fatal
 * state shows.
 */
export type EngineStage = "downloading" | "downloaded" | "compiling" | "ready" | "failed";

export type EngineStatus = {
  stage: EngineStage;
  /** Bytes received so far and the module size when the server sent it. */
  loaded: number;
  total: number | null;
  downloadMs: number | null;
  /** Bytes that crossed the network (Resource Timing `transferSize`): 0 when the
   * HTTP cache answered, null when the browser does not say. */
  transferred: number | null;
  /** The module URL, version and checksum once resolved; null before. */
  resolved: ResolvedEngine | null;
  error: KernelError | null;
};

export type EngineLoad = {
  getStatus(): EngineStatus;
  subscribe(listener: () => void): () => void;
  /** Resolves once the module is compiled (or immediately after a failed load). */
  downloaded(): Promise<void>;
  /** The first document call is about to need the module. */
  compiling(): void;
  /** The worker has the compiled module. */
  compiled(): void;
  failed(error: KernelError): void;
};

/** A resolved, verified and compiled engine module. */
export type EngineModule = { resolved: ResolvedEngine; module: WebAssembly.Module };

/** One engine source: the compile promise plus the status the shell shows. */
type ModuleLoad = {
  result: Promise<EngineModule>;
  status: EngineStatus;
  listeners: Set<() => void>;
};

const loads = new Map<string, ModuleLoad>();
/**
 * Compiled modules by resolved URL and checksum: sources that resolve to the
 * same module (a format whose release has no split module falls back to
 * `wolf_web.wasm`) download and compile it once.
 */
const modules = new Map<string, Promise<WebAssembly.Module>>();
/** Identity of each custom `fetch` in a source, for the cache key. */
const fetchIds = new WeakMap<typeof fetch, number>();
let nextFetchId = 1;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The canonical form of a source, as the loader receives it and the cache keys it:
 * - with `url`: the URL made absolute against the document base (or the worker
 *   location), plus `sha256` and `fetch` when given; `channel`, `version` and `format` do not apply;
 * - without: `channel` (default `DEFAULT_ENGINE_CHANNEL`, no trailing slash), then
 *   `version`, `format`, `sha256` and `fetch` when given.
 * Empty strings count as absent and `sha256` is lowercased.
 */
export function normalizeSource(source: EngineSource = {}): EngineSource {
  const sha256 = source.sha256 ? source.sha256.trim().toLowerCase() : undefined;
  const extra: EngineSource = {};
  if (sha256) extra.sha256 = sha256;
  if (source.fetch) extra.fetch = source.fetch;
  if (source.url !== undefined && String(source.url) !== "") {
    const base = globalThis.document?.baseURI ?? globalThis.location?.href;
    let url: string;
    try {
      url = new URL(source.url, base).href;
    } catch {
      url = String(source.url);
    }
    return { url, ...extra };
  }
  const channel = (source.channel || DEFAULT_ENGINE_CHANNEL).replace(/\/+$/, "");
  const version = source.version?.trim();
  const normalized: EngineSource = { channel };
  if (version) normalized.version = version;
  if (source.format) normalized.format = source.format;
  return { ...normalized, ...extra };
}

/**
 * Cache key of a source: two sources with the same key load the same module
 * once. A custom `fetch` is part of the key by identity.
 */
export function engineKey(source: EngineSource = {}): string {
  const s = normalizeSource(source);
  let fetchId = 0;
  if (s.fetch) {
    fetchId = fetchIds.get(s.fetch) ?? nextFetchId++;
    fetchIds.set(s.fetch, fetchId);
  }
  return JSON.stringify([
    s.url === undefined ? null : String(s.url),
    s.channel ?? null,
    s.version ?? null,
    s.format ?? null,
    s.sha256 ?? null,
    fetchId,
  ]);
}

/** The source as a worker can receive it (structured-cloneable: no `fetch`). */
export function workerSource(source: EngineSource = {}): EngineSource {
  const { fetch: _fetch, ...rest } = normalizeSource(source);
  return rest;
}

/** A load failure as the fatal state and `wolf-error` show it: the loader's code and the URL it failed on. */
export function engineError(cause: unknown, url: string | null, downloaded: boolean): KernelError {
  if (cause instanceof EngineLoadError) return { code: cause.code, message: cause.message, argument: cause.url };
  const error: KernelError = {
    code: downloaded ? "wasm-compile-failed" : "module-download-failed",
    message: message(cause),
  };
  if (url) error.argument = url;
  return error;
}

/** Bytes of `url` that crossed the network (0 from the HTTP cache), or null without a timing entry. */
function transferredBytes(url: string | null): number | null {
  if (!url || typeof performance.getEntriesByName !== "function") return null;
  const timing = performance.getEntriesByName(url, "resource").at(-1) as PerformanceResourceTiming | undefined;
  return timing ? timing.transferSize : null;
}

/** Resolve, fetch (counting bytes), verify and compile `source`; cached per source, failures are not. */
function moduleLoad(source: EngineSource): ModuleLoad {
  const key = engineKey(source);
  const cached = loads.get(key);
  if (cached) return cached;
  const normalized = normalizeSource(source);
  const load: ModuleLoad = {
    result: Promise.resolve() as unknown as Promise<EngineModule>,
    status: {
      stage: "downloading",
      loaded: 0,
      total: null,
      downloadMs: null,
      transferred: null,
      resolved: null,
      error: null,
    },
    listeners: new Set(),
  };
  const set = (patch: Partial<EngineStatus>) => {
    load.status = { ...load.status, ...patch };
    for (const listener of load.listeners) listener();
  };
  const baseFetch = normalized.fetch ?? globalThis.fetch.bind(globalThis);
  let moduleUrl: string | null = normalized.url === undefined ? null : String(normalized.url);
  let downloaded = false;

  /** `fetch` that counts the module body as it streams; other requests (channel files) pass through. */
  const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url !== moduleUrl || !response.ok || !response.body) return response;
    const length = Number(response.headers.get("content-length"));
    // A compressed response's Content-Length counts encoded bytes, which the stream does not see.
    set({ total: length > 0 && !response.headers.get("content-encoding") ? length : null });
    let loaded = 0;
    let shown = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        // Publish about every 1 % of a 50 MB module, not every chunk.
        if (loaded - shown > 512 * 1024) {
          shown = loaded;
          set({ loaded });
        }
        controller.enqueue(chunk);
      },
      flush() {
        set({ loaded });
      },
    });
    return new Response(response.body.pipeThrough(counter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;

  const started = performance.now();
  load.result = (async () => {
    const resolved = await resolveEngine({ ...normalized, fetch: baseFetch });
    moduleUrl = resolved.url;
    set({ resolved });
    const id = `${resolved.url}#${resolved.sha256 ?? ""}`;
    let module = modules.get(id);
    if (module) {
      downloaded = true;
      set({ stage: "compiling", downloadMs: performance.now() - started, transferred: 0 });
    } else {
      module = (async () => {
        const bytes = await fetchEngineBytes(resolved, { fetch: counting });
        downloaded = true;
        set({
          stage: "compiling",
          loaded: bytes.byteLength,
          downloadMs: performance.now() - started,
          transferred: transferredBytes(resolved.url),
        });
        return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
      })();
      modules.set(id, module);
      module.catch(() => modules.delete(id));
    }
    return { resolved, module: await module };
  })();
  load.result.then(
    // The resource timing entry can land after the body's last chunk; read it again once compiled.
    () => set({ stage: "ready", transferred: load.status.transferred ?? transferredBytes(moduleUrl) }),
    (cause: unknown) => {
      loads.delete(key);
      set({ stage: "failed", error: engineError(cause, moduleUrl, downloaded) });
    },
  );
  loads.set(key, load);
  return load;
}

/** The compiled module for `source` (shared with every consumer of the same source). */
export function engineModule(source: EngineSource = {}): Promise<EngineModule> {
  return moduleLoad(source).result;
}

/**
 * One consumer's view of the module load. A failure the kernel reports later
 * (`failed`) marks this consumer only; `compiling` and `compiled` are no-ops
 * because the module is compiled before any worker receives it.
 */
export function engineLoad(source: EngineSource = {}): EngineLoad {
  const shared = moduleLoad(source);
  const listeners = new Set<() => void>();
  let own: EngineStatus | null = null;
  return {
    getStatus: () => own ?? shared.status,
    subscribe(listener) {
      listeners.add(listener);
      shared.listeners.add(listener);
      return () => {
        listeners.delete(listener);
        shared.listeners.delete(listener);
      };
    },
    downloaded: () =>
      shared.result.then(
        () => {},
        () => {},
      ),
    compiling() {},
    compiled() {},
    failed(error) {
      own = { ...shared.status, stage: "failed", error };
      for (const listener of listeners) listener();
    },
  };
}

function isInit(message: unknown): message is { type: "init"; module?: WebAssembly.Module } {
  return typeof message === "object" && message !== null && "type" in message && message.type === "init";
}

/**
 * `createWorker` for `createReactorKernelClient` (called again after a crash):
 * holds back everything posted to a new worker until the module settles, then
 * posts `init` with the compiled module (or unchanged after a failed load, so
 * the worker reports the failure on its first call) followed by the held messages.
 */
export function workerFactory(module: Promise<WebAssembly.Module>, spawn: () => Worker): () => Worker {
  return () => {
    const worker = spawn();
    const post = worker.postMessage.bind(worker) as (...args: unknown[]) => void;
    let held: unknown[][] | null = [];
    worker.postMessage = ((...args: unknown[]) => {
      if (held) held.push(args);
      else post(...args);
    }) as Worker["postMessage"];
    const flush = (compiledModule: WebAssembly.Module | undefined) => {
      const queue = held ?? [];
      held = null;
      for (const args of queue) {
        const [message, ...rest] = args;
        if (compiledModule && isInit(message) && !message.module) {
          try {
            post({ ...message, module: compiledModule }, ...rest);
            // A worker given its module posts nothing back, but the client learns the module
            // from that reply (it needs it to restart a crashed worker): answer for the worker.
            worker.dispatchEvent(new MessageEvent("message", { data: { type: "module", module: compiledModule } }));
            continue;
          } catch {
            // A runtime that cannot clone modules: the worker loads its own.
          }
        }
        post(message, ...rest);
      }
    };
    module.then(flush, () => flush(undefined));
    return worker;
  };
}
