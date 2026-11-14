import { KernelRequestError, type DocState } from "@wolfsdk/protocol";
import type { KernelClient, KernelError, LabDoc, LabStep, LabVerifier, Op } from "./types.ts";
import type { ByteCache } from "./cache.ts";

/** Kernel codes that mean the engine failed, as opposed to refusing the batch. */
const TRAP_CODES: Record<string, true> = {
  "wasm-trap": true,
  "wasm-memory-limit": true,
  "kernel-closed": true,
  "wasm-compile-failed": true,
  "engine-no-receipt": true,
};

export function errorWithCause(error: KernelError): Error {
  return new Error(`${error.code}: ${error.message}`, { cause: error });
}

/** Turns a rejected kernel call into the Error shape `LabEngine` documents. */
export function asLabError(e: unknown): Error {
  if (e instanceof KernelRequestError) return errorWithCause(e.error);
  return e instanceof Error ? e : new Error(String(e));
}

/** One step of a replay: run it against the kernel, or skip it. */
export type PlanStep = {
  index: number;
  label: string;
  author?: string;
  ops: Op[];
  run: boolean;
  /** Status of a skipped step. */
  skip: "rejected" | "conflict";
  /** The step as it stood before; a skipped step keeps its record. */
  prior?: LabStep;
};

export type ReplayDeps = {
  verifier: LabVerifier;
  cache: ByteCache;
};

type Rev = { key: string; sha: string; record: LabStep | null };

/** The kernel revision chain of one open document, plus a queue that keeps
 * calls on it in order (the kernel has one cursor per document). */
export class LiveSession<K extends KernelClient = KernelClient> {
  readonly kernel: K;
  readonly docId: string;
  readonly name: string;
  readonly revs: Rev[];
  /** Kernel cursor as this session knows it; -1 when unknown. */
  cursor = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(kernel: K, state: DocState) {
    this.kernel = kernel;
    this.docId = state.doc;
    this.name = state.name;
    this.revs = [{ key: "base", sha: state.sha256, record: null }];
  }

  get baseSha256(): string {
    return this.revs[0]!.sha;
  }

  /** Run `fn` after every earlier call on this session has settled. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export async function openLive<K extends KernelClient>(
  kernel: K,
  bytes: Uint8Array,
  name: string,
  cache: ByteCache,
): Promise<LiveSession<K>> {
  let state: DocState;
  try {
    state = await kernel.open(bytes, name);
  } catch (e) {
    throw asLabError(e);
  }
  cache.set(state.sha256, bytes);
  return new LiveSession(kernel, state);
}

function keyOf(step: PlanStep): string {
  return `${step.index}|${JSON.stringify(step.ops)}`;
}

function withAuthor(step: LabStep, author: string | undefined): LabStep {
  if (author === undefined) delete step.author;
  else step.author = author;
  return step;
}

function skipped(p: PlanStep, sha: string): LabStep {
  const prior = p.prior;
  const step: LabStep = {
    index: p.index,
    label: p.label,
    ops: p.ops,
    baseSha256: sha,
    resultSha256: sha,
    changes: prior && p.skip === "rejected" ? prior.changes : [],
    partsWritten: prior && p.skip === "rejected" ? prior.partsWritten : [],
    status: p.skip,
    ms: 0,
  };
  if (prior?.delta && p.skip === "rejected") step.delta = prior.delta;
  if (p.skip === "conflict" && prior?.error) step.error = prior.error;
  return withAuthor(step, p.author);
}

/**
 * Bring the kernel to the state the plan describes and return the resulting
 * steps and view. Revisions already in the chain are reused while the plan
 * agrees with it; the rest are applied one at a time, so a refused step
 * becomes a `conflict` and the later steps still run.
 *
 * A trap rejects: the kernel is left wherever it was and the cursor is marked
 * unknown so the next call moves it explicitly.
 */
export async function replay(
  session: LiveSession,
  plan: PlanStep[],
  deps: ReplayDeps,
): Promise<{ steps: LabStep[]; state: DocState }> {
  const { kernel, docId, revs } = session;
  const steps: LabStep[] = [];
  let r = 0;
  let diverged = false;
  let state: DocState | null = null;
  let sha = revs[0]!.sha;

  try {
    for (const p of plan) {
      if (!p.run) {
        steps.push(skipped(p, sha));
        continue;
      }
      const next = revs[r + 1];
      if (!diverged && next && next.key === keyOf(p) && next.record) {
        r += 1;
        sha = next.sha;
        steps.push(withAuthor({ ...next.record, index: p.index, label: p.label, status: "applied" }, p.author));
        continue;
      }
      diverged = true;
      if (session.cursor !== r) {
        state = await kernel.goto(docId, r);
        session.cursor = r;
      }
      const before = deps.cache.get(sha) ?? (await kernel.save(docId));
      deps.cache.set(sha, before);
      const t0 = performance.now();
      const result = await kernel.apply(docId, p.ops);
      if (!result.ok) {
        if (TRAP_CODES[result.error.code] === true) {
          session.cursor = -1;
          throw errorWithCause(result.error);
        }
        const conflict: LabStep = {
          index: p.index,
          label: p.label,
          ops: p.ops,
          baseSha256: sha,
          resultSha256: sha,
          changes: [],
          partsWritten: [],
          status: "conflict",
          error: result.error,
          ms: performance.now() - t0,
        };
        steps.push(withAuthor(conflict, p.author));
        continue;
      }
      const ms = performance.now() - t0;
      const after = await kernel.save(docId);
      deps.cache.set(result.state.sha256, after);
      const delta = await deps.verifier.comparePackages(before, after);
      const step: LabStep = {
        index: p.index,
        label: p.label,
        ops: p.ops,
        baseSha256: sha,
        resultSha256: result.state.sha256,
        changes: result.transaction.diff.changes,
        partsWritten: result.transaction.parts_written as string[],
        delta,
        status: "applied",
        ms,
      };
      withAuthor(step, p.author);
      revs.length = r + 1;
      revs.push({ key: keyOf(p), sha: result.state.sha256, record: step });
      r += 1;
      session.cursor = r;
      sha = result.state.sha256;
      state = result.state;
      steps.push({ ...step });
    }
    if (!state || state.revision !== r || session.cursor !== r) {
      state = await kernel.goto(docId, r);
      session.cursor = r;
    }
  } catch (e) {
    throw asLabError(e);
  }
  return { steps, state };
}

/** The plan that reproduces `doc` as it stands: applied and conflicted steps run
 * (a conflict is retried, since an earlier change may have cleared it), the rest
 * keep their status. */
export function planOf(doc: LabDoc): PlanStep[] {
  return doc.steps.map((s) => {
    const p: PlanStep = {
      index: s.index,
      label: s.label,
      ops: s.ops,
      run: s.status !== "rejected",
      skip: s.status === "conflict" ? "conflict" : "rejected",
      prior: s,
    };
    if (s.author !== undefined) p.author = s.author;
    return p;
  });
}

export function docOf(base: { id: string; name: string }, session: LiveSession, steps: LabStep[], state: DocState): LabDoc {
  return {
    id: base.id,
    name: base.name,
    format: state.format,
    sha256: state.sha256,
    baseSha256: session.baseSha256,
    steps,
    pages: state.pages.map((p) => ({ page: p.page, widthPt: p.widthPt, heightPt: p.heightPt })),
    nodes: state.nodes,
    regions: state.regions,
  };
}
