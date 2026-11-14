/**
 * The element's kernel: one long-lived reactor engine instance per element
 * (`wolf_web.wasm`, vector pages), started the way `mountEditor` starts it
 * (../shell/mount.tsx), with the element's shared compiled module handed to
 * its worker. The client replaces a crashed worker and restores its documents.
 */
import { KernelRequestError, type KernelError } from "@wolfsdk/protocol";
import { createReactorKernelClient, type WorkerReactorKernelClient } from "@wolfsdk/runtime/client";
import type { EngineSource } from "@wolfsdk/runtime/loader";
import reactorWorkerUrl from "@wolfsdk/runtime/worker?worker&url";
import type { EditorHost } from "../host/index.ts";
import { workerFactory, workerSource, type EngineLoad } from "../shell/engine.ts";
import type { KernelStatsSnapshot } from "../shell/index.ts";

export type Kernel = {
  client: WorkerReactorKernelClient;
  /** For the shell's Performance popover. */
  stats: () => Promise<KernelStatsSnapshot>;
};

type ClientStats = { client: { restarts: number; restoreFailures: { doc: string; error: KernelError }[] } };

function toKernelError(cause: unknown): KernelError {
  if (cause instanceof KernelRequestError) return cause.error;
  return { code: "kernel-failed", message: cause instanceof Error ? cause.message : String(cause) };
}

const shims = new Map<string, string>();

/**
 * The kernel worker (`?worker&url`: emitted as its own chunk next to the
 * bundle and located relative to this module). Same origin as the page:
 * started from its own URL. Another origin (the bundle on a CDN): browsers
 * refuse cross-origin worker URLs, so a same-origin `blob:` module worker
 * imports it (needs CORS on the bundle's origin, which a cross-origin module
 * script needs anyway, and `worker-src blob:` under a CSP).
 */
function spawn(): Worker {
  const url = new URL(reactorWorkerUrl, import.meta.url);
  if (url.origin === globalThis.location.origin) return new Worker(url, { type: "module", name: "wolf-reactor" });
  let shim = shims.get(url.href);
  if (!shim) {
    shim = URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};\n`], { type: "text/javascript" }));
    shims.set(url.href, shim);
  }
  return new Worker(shim, { type: "module", name: "wolf-reactor" });
}

export function startKernel(
  source: EngineSource,
  module: Promise<WebAssembly.Module>,
  environment: { clock: "live" } | undefined,
  engine: EngineLoad,
  host: () => EditorHost,
): Kernel {
  const create = workerFactory(module, spawn);
  let stats!: () => Promise<ClientStats>;
  const spawned = watchRestarts(engine, host, () => stats());
  /** Fail the engine state when the kernel cannot serve anything: the fatal state offers Retry. */
  const closed = (cause: unknown): never => {
    const error = toKernelError(cause);
    if (error.code === "kernel-closed" || error.code === "engine-incompatible") engine.failed(error);
    throw cause;
  };

  const createWorker = (): Worker => {
    spawned();
    return create();
  };
  const client = createReactorKernelClient({
    engine: workerSource(source),
    environment,
    worker: createWorker(),
    createWorker,
  });
  stats = () => client.stats();
  return {
    client,
    stats: async () => {
      const s = await client.stats().catch(closed);
      return {
        pngCache: s.pngCache,
        displayListCache: s.displayListCache,
        memoryBytes: s.memoryBytes,
        lastDeterminism: s.lastDeterminism,
        restarts: s.client.restarts,
        restoreFailures: s.client.restoreFailures.length,
      };
    },
  };
}

/**
 * Called on every worker spawn; from the second one on (a crash replaced the
 * worker), checks the document on screen came back, as the shell does: the
 * engine fails when it did not, the host reports `kernel-restarted` when it did.
 */
function watchRestarts(
  engine: EngineLoad,
  host: () => EditorHost,
  clientStats: () => Promise<ClientStats>,
): () => void {
  let spawned = 0;
  let checking: Promise<void> | null = null;
  async function checkRestore(): Promise<void> {
    try {
      const s = await clientStats();
      const doc = host().getSnapshot().state?.doc;
      const lost = s.client.restoreFailures.find((f) => f.doc === doc);
      if (lost) {
        engine.failed({
          code: lost.error.code,
          message: `The engine worker stopped and the document could not be restored: ${lost.error.message}`,
        });
      } else {
        host().reportError({
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
    if (spawned++ > 0) checking ??= Promise.resolve().then(checkRestore);
  };
}
