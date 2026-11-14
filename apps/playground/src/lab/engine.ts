import { createReactorKernelClient, type DamageReportResult } from "@wolfsdk/runtime/client";
import { EngineLoadError, fetchEngineBytes, resolveEngine, type EngineSource } from "@wolfsdk/runtime/loader";
import { KernelRequestError } from "@wolfsdk/protocol";
import { ByteCache } from "./cache.ts";
import { findingsFromView } from "./findings.ts";
import {
  asLabError,
  docOf,
  errorWithCause,
  type LiveSession,
  openLive,
  type PlanStep,
  planOf,
  replay,
  type ReplayDeps,
} from "./live-engine.ts";
import { DAMAGE_REPORT_JSON, recalcFromDamageReport } from "./recalc.ts";
import type {
  EngineIdentity,
  EngineStatus,
  Environment,
  Finding,
  Journal,
  KernelClient,
  KernelError,
  LabDoc,
  LabEngine,
  LabVerifier,
  Op,
  PageRaster,
  RecalcResult,
} from "./types.ts";

export { findingsFromView, type FindingsInput } from "./findings.ts";
export { wolfOpsFor } from "./ops.ts";

/** The kernel this facade drives: any `KernelClient`, plus the damage report
 * call when the runtime has it, and a way to stop the worker. */
export type EngineKernel = KernelClient & {
  damageReport?: (doc: string) => Promise<DamageReportResult>;
  terminate?: () => void;
};

export type LabEngineOptions = {
  /** Where the engine module comes from (`@wolfsdk/runtime/loader`). */
  source: EngineSource;
  /** Computes `LabStep.delta` and the module's sha256. */
  verifier: LabVerifier;
  /** Create the kernel. Default: the reactor worker client fed with the
   * module the loader resolves and verifies from `source`. Tests pass the
   * in-process node kernel. */
  createKernel?: () => Promise<EngineKernel>;
};

/** Revisions of file bytes kept for diffing and download. */
const CACHE_BYTES = 128 * 1024 * 1024;

/** The environment the reactor kernel runs under unless told otherwise. */
const KERNEL_ENVIRONMENT: Environment = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 };

/** The account Recalc gives when the engine build has no damage report. */
const NO_DAMAGE_REPORT = "this engine build has no damage report call";

type Loaded = { kernel: EngineKernel; identity: EngineIdentity | null };

function failure(code: string, message: string): Error {
  return errorWithCause({ code, message });
}

/** A module that predates the call answers it as an unknown command. */
function isUnknownCommand(e: unknown): boolean {
  if (!(e instanceof KernelRequestError)) return false;
  return e.error.code === "bad-request" && e.error.message.includes("damage_report");
}

export function createLabEngine(options: LabEngineOptions): LabEngine {
  const { source, verifier } = options;
  const cache = new ByteCache(CACHE_BYTES);
  const sessions = new Map<string, LiveSession<EngineKernel>>();
  const listeners = new Set<() => void>();
  let identity: EngineIdentity | null = null;
  let kernel: EngineKernel | null = null;
  let pending: Promise<void> | null = null;
  let loading: EngineStatus["loading"] = null;
  let error: KernelError | null = null;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const deps: ReplayDeps = { verifier, cache };

  async function defaultKernel(): Promise<Loaded> {
    loading = { phase: "resolve" };
    notify();
    const resolved = await resolveEngine(source);
    loading = { phase: "transfer" };
    notify();
    const bytes = await fetchEngineBytes(resolved, source.fetch ? { fetch: source.fetch } : undefined);
    loading = { phase: "compile" };
    notify();
    const moduleSha256 = await verifier.sha256Hex(bytes);
    // The worker client fetches the module by URL, also when it restarts after
    // a crash, so the blob URL lives as long as this page.
    const moduleUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/wasm" }));
    const client = createReactorKernelClient({ moduleUrl });
    await client.stats();
    return {
      kernel: client,
      identity: { version: resolved.version, moduleSha256, moduleBytes: bytes.byteLength, url: resolved.url },
    };
  }

  function load(): Promise<void> {
    if (kernel) return Promise.resolve();
    if (disposed) return Promise.reject(failure("kernel-closed", "this engine was replaced"));
    pending ??= (async () => {
      try {
        const made: Loaded = options.createKernel
          ? { kernel: await options.createKernel(), identity: null }
          : await defaultKernel();
        if (disposed) {
          made.kernel.terminate?.();
          throw failure("kernel-closed", "this engine was replaced");
        }
        kernel = made.kernel;
        identity = made.identity;
        error = null;
      } catch (e) {
        const labError = asLabError(e);
        const cause = labError.cause as KernelError | undefined;
        error = cause ?? {
          code: e instanceof EngineLoadError ? e.code : "engine-unavailable",
          message: labError.message,
        };
        throw labError;
      } finally {
        loading = null;
        pending = null;
        notify();
      }
    })();
    return pending;
  }

  function sessionOf(doc: LabDoc): LiveSession<EngineKernel> {
    const session = sessions.get(doc.id);
    if (!session) throw failure("doc-unknown", `document ${doc.id} is not open`);
    return session;
  }

  function snapshot(doc: LabDoc, session: LiveSession, steps: LabDoc["steps"], state: Parameters<typeof docOf>[3]): LabDoc {
    return docOf({ id: doc.id, name: doc.name }, session, steps, state);
  }

  /** Move the kernel to `doc`. A snapshot the kernel is already on is
   * returned as it is. */
  async function materialize(doc: LabDoc, session: LiveSession): Promise<LabDoc> {
    if (session.cursor >= 0 && session.revs[session.cursor]?.sha === doc.sha256) return doc;
    const out = await replay(session, planOf(doc), deps);
    const live = snapshot(doc, session, out.steps, out.state);
    // Callers answer for `doc` from the kernel's state, so the replay has to
    // land on the same bytes. A snapshot the engine here does not reproduce is
    // refused, never served or cached under the sha256 it claims.
    if (live.sha256 !== doc.sha256) {
      throw failure(
        "replay-mismatch",
        `re-running the steps in this tab reached sha256 ${live.sha256} where this snapshot had ${doc.sha256}`,
      );
    }
    return live;
  }

  const engine: LabEngine = {
    get identity() {
      return identity;
    },
    status() {
      return { phase: kernel ? "ready" : loading ? "loading" : "idle", loading, error };
    },
    load,

    async openFile(bytes, name) {
      await load();
      const session = await openLive(kernel!, bytes, name, cache);
      sessions.set(session.docId, session);
      const out = await session.run(() => replay(session, [], deps));
      return docOf({ id: session.docId, name }, session, out.steps, out.state);
    },

    async apply(doc, ops: Op[], label, author) {
      const session = sessionOf(doc);
      return session.run(async () => {
        const plan = planOf(doc);
        const added: PlanStep = { index: doc.steps.length, label, ops, run: true, skip: "conflict" };
        if (author !== undefined) added.author = author;
        const out = await replay(session, [...plan, added], deps);
        const step = out.steps.at(-1)!;
        if (step.status === "conflict") throw errorWithCause(step.error!);
        if (step.baseSha256 !== doc.sha256) {
          throw failure("stale-document", "the document changed since this snapshot was taken");
        }
        return snapshot(doc, session, out.steps, out.state);
      });
    },

    async pageImage(doc, page, pxPerPt): Promise<PageRaster> {
      const session = sessionOf(doc);
      return session.run(async () => {
        const live = await materialize(doc, session);
        try {
          const img = await session.kernel.page(session.docId, page, pxPerPt);
          return {
            page,
            png: img.png,
            widthPx: img.widthPx,
            heightPx: img.heightPx,
            widthPt: (img.widthPx * 72) / img.dpi,
            heightPt: (img.heightPx * 72) / img.dpi,
            regions: live.regions.filter((r) => r.page === page),
          };
        } catch (e) {
          throw asLabError(e);
        }
      });
    },

    async findings(doc): Promise<Finding[]> {
      return findingsFromView({ format: doc.format, nodes: doc.nodes, regions: doc.regions });
    },

    async recalcReport(doc): Promise<RecalcResult | null> {
      if (doc.format !== "xlsx") return null;
      const session = sessionOf(doc);
      const call = session.kernel.damageReport?.bind(session.kernel);
      if (!call) return { kind: "unavailable", reason: NO_DAMAGE_REPORT };
      return session.run(async () => {
        await materialize(doc, session);
        const t0 = performance.now();
        let result: DamageReportResult;
        try {
          result = await call(session.docId);
        } catch (e) {
          if (isUnknownCommand(e)) return { kind: "unavailable", reason: NO_DAMAGE_REPORT };
          throw asLabError(e);
        }
        const ms = performance.now() - t0;
        const json = result.outputs.find((o) => o.path === DAMAGE_REPORT_JSON);
        if (!json) throw failure("engine-no-report", `the damage report wrote no ${DAMAGE_REPORT_JSON}`);
        return recalcFromDamageReport(json.data, ms);
      });
    },

    async bytes(doc) {
      const hit = cache.get(doc.sha256);
      if (hit) return hit;
      const session = sessionOf(doc);
      return session.run(async () => {
        await materialize(doc, session);
        try {
          const saved = await session.kernel.save(session.docId);
          cache.set(doc.sha256, saved);
          return saved;
        } catch (e) {
          throw asLabError(e);
        }
      });
    },

    journal(doc): Journal {
      sessionOf(doc);
      return {
        file: { name: doc.name, format: doc.format, sha256: doc.baseSha256 },
        environment: KERNEL_ENVIRONMENT,
        engine: identity,
        entries: doc.steps.map((s) => {
          const e: Journal["entries"][number] = {
            index: s.index,
            label: s.label,
            ops: s.ops,
            status: s.status,
            baseSha256: s.baseSha256,
            resultSha256: s.resultSha256,
          };
          if (s.author !== undefined) e.author = s.author;
          return e;
        }),
        resultSha256: doc.sha256,
      };
    },

    async close(doc) {
      const session = sessions.get(doc.id);
      if (!session) return;
      sessions.delete(doc.id);
      await session.run(() => session.kernel.close(session.docId)).catch(() => undefined);
    },

    dispose() {
      disposed = true;
      sessions.clear();
      kernel?.terminate?.();
      kernel = null;
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return engine;
}
