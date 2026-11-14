import type { EditIntent, LabAssets, LabRivals, LabVerifier, PackageDelta, RivalId, RivalRecord } from "../lab/index.ts";
import { RIVAL_EXT, RIVAL_FORMAT, RIVAL_INTENTS } from "./adapters.ts";
import { lossesFromDelta } from "./losses.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

export { ADAPTER_SOURCE } from "./adapters.ts";
export { categoryOf, lossesFromDelta } from "./losses.ts";
export { PYODIDE_VERSION, SCRIPT_DIR, SCRIPT_FILES, planLoad } from "./plan.ts";
export type { LoadPlan } from "./plan.ts";
export { assetTarget, assetUrl, createAssetFetch } from "./shim.ts";
export { createFetchedAssets, RIVAL_SOURCES } from "./sources.ts";
export type { FetchedAssetsOptions, RivalSource } from "./sources.ts";

/** The part of `Worker` that createRivals uses; tests supply their own. */
export type RivalsWorker = {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
};

export type RivalsOptions = {
  assets: LabAssets;
  verifier: LabVerifier;
  /** Wall-clock limit for one run; the worker is terminated past it. Default 60 000. */
  timeoutMs?: number;
  createWorker?: () => RivalsWorker;
  /**
   * Absolute URL of the directory that serves `pyodide.mjs` and `pyodide.asm.js` as script
   * (`SCRIPT_DIR` under the app base), on the page's own origin.
   */
  scriptBase: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
/** Booting Pyodide and loading the wheels; terminated past this. */
const BOOT_TIMEOUT_MS = 120_000;

type Booted = { python: string; versions: Record<string, string> };
type RunResult = Extract<FromWorker, { type: "result" }>;

type Session = {
  worker: RivalsWorker;
  ready: Promise<Booted>;
  /** Settles the in-flight run, if any. */
  settle: ((result: RunResult | Error) => void) | null;
  /** Rejects the boot wait and the in-flight run. */
  fail: (error: Error) => void;
};

function defaultWorker(): RivalsWorker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRivals(options: RivalsOptions): LabRivals {
  const { assets, verifier, scriptBase } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createWorker = options.createWorker ?? defaultWorker;

  let session: Session | null = null;
  let disposed = false;
  let nextRun = 1;
  let queue: Promise<unknown> = Promise.resolve();

  function post(worker: RivalsWorker, message: ToWorker, transfer: Transferable[] = []): void {
    worker.postMessage(message, transfer);
  }

  function startSession(): Session {
    const worker = createWorker();
    const { promise: ready, resolve: bootDone, reject: bootFailed } = Promise.withResolvers<Booted>();
    ready.catch(() => {}); // a boot failure is reported by the run that waits on it
    const current: Session = {
      worker,
      ready,
      settle: null,
      fail: (error) => {
        bootFailed(error);
        current.settle?.(error);
      },
    };
    const fail = current.fail;
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.type) {
        case "asset-request":
          assets.get(message.id).then(
            (bytes) => {
              // Copy: the asset source may hand out a kept buffer and a transfer would detach it.
              const copy = new Uint8Array(bytes);
              post(worker, { type: "asset", reqId: message.reqId, bytes: copy }, [copy.buffer]);
            },
            (error: unknown) => post(worker, { type: "asset-error", reqId: message.reqId, message: describe(error) }),
          );
          return;
        case "ready":
          bootDone({ python: message.python, versions: message.versions });
          return;
        case "boot-error":
          fail(new Error(message.message));
          return;
        case "result":
          current.settle?.(message);
          return;
      }
    };
    worker.onerror = (event: ErrorEvent) => fail(new Error(event.message || "the rivals worker stopped"));
    const rivalAssets = assets.list().filter((ref) => ref.path.startsWith("rivals/"));
    post(worker, { type: "init", assets: rivalAssets, scriptBase });
    return current;
  }

  function endSession(reason: Error): void {
    const ending = session;
    session = null;
    if (!ending) return;
    ending.worker.terminate();
    ending.fail(reason);
  }

  function failure(rival: RivalId, intent: EditIntent, error: string, ms: number, version = ""): RivalRecord {
    return { rival, version, intent, ok: false, error, losses: [], ms };
  }

  async function execute(rival: RivalId, bytes: Uint8Array, intent: EditIntent): Promise<RivalRecord> {
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;
    if (disposed) return failure(rival, intent, "the rivals runner was disposed", 0);
    if (RIVAL_FORMAT[rival] === undefined || !RIVAL_INTENTS[rival].includes(intent.kind)) {
      return failure(rival, intent, `${rival} has no ${intent.kind} adapter`, 0);
    }

    const active = (session ??= startSession());
    let booted: Booted;
    const bootTimer = setTimeout(() => {
      if (session === active) endSession(new Error(`no response after ${BOOT_TIMEOUT_MS / 1000} s`));
    }, BOOT_TIMEOUT_MS);
    try {
      booted = await active.ready;
    } catch (error) {
      if (session === active) endSession(new Error("boot failed"));
      return failure(rival, intent, `the Python runtime did not start: ${describe(error)}`, elapsed());
    } finally {
      clearTimeout(bootTimer);
    }

    const id = nextRun++;
    const { promise, resolve } = Promise.withResolvers<RunResult | Error>();
    active.settle = resolve;
    const timer = setTimeout(() => {
      if (session === active) endSession(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s; the Python worker was stopped`));
    }, timeoutMs);
    const input = new Uint8Array(bytes);
    post(
      active.worker,
      {
        type: "run",
        id,
        rival,
        kind: intent.kind,
        intentJson: JSON.stringify(intent),
        ext: RIVAL_EXT[rival],
        bytes: input,
      },
      [input.buffer],
    );
    const result = await promise;
    clearTimeout(timer);
    active.settle = null;
    if (result instanceof Error) return failure(rival, intent, result.message, elapsed(), booted.versions[rival] ?? "");

    const version = result.version ?? booted.versions[rival] ?? "";
    const record: RivalRecord = {
      rival,
      version,
      intent,
      ok: result.ok,
      losses: [],
      ms: result.ms,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    if (result.error) record.error = result.error;
    if (!result.ok || !result.output) return record;

    record.outputBytes = result.output;
    let delta: PackageDelta;
    try {
      delta = await verifier.comparePackages(bytes, result.output);
    } catch (error) {
      record.stderr = `${record.stderr ?? ""}${record.stderr ? "\n" : ""}package comparison failed: ${describe(error)}`;
      return record;
    }
    record.delta = delta;
    record.losses = lossesFromDelta(delta);
    return record;
  }

  return {
    supports(rival, format, kind) {
      return RIVAL_FORMAT[rival] === format && RIVAL_INTENTS[rival].includes(kind);
    },
    run(rival, bytes, intent) {
      // One run at a time: the interpreter is single-threaded and a timeout stops the whole worker.
      const next = queue.then(() => execute(rival, bytes, intent));
      queue = next.catch(() => {});
      return next;
    },
    dispose() {
      disposed = true;
      endSession(new Error("the rivals runner was disposed"));
    },
  };
}
