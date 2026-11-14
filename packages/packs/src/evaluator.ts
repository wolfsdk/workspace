// Recalculation of an XLSX source. Without an evaluator a source is read as saved (the cached value of every
// formula cell). With one, the workbook is recalculated under the source's own determinism (clock, seed,
// timezone, locale) first, and the recalculated workbook is what the pack reads.
import type { ReactorPipeCommand, ReactorPipeRefusal, ReactorPipeRequest, ReactorPipeResponse, PackDeterminism } from "@wolfsdk/protocol/workspace";
import type { EngineWorker, WorkerPool } from "@wolfsdk/server";
import { PackError } from "./errors.ts";

export type EvaluationRequest = { name: string; bytes: Uint8Array; determinism: PackDeterminism };

export interface XlsxEvaluator {
  /** The workbook `bytes` after a recalculation under `determinism`. */
  recalculate(request: EvaluationRequest): Promise<Uint8Array>;
}

/** The success response of command `C`; `recalc` shares one response shape with `observe`, `extract` and `damage_report`. */
type Answer<C extends ReactorPipeCommand> = Exclude<ReactorPipeResponse, ReactorPipeRefusal> extends infer R ? (R extends { cmd: infer K } ? (C extends K ? R : never) : never) : never;

/** The response to `request`, narrowed to its command, or a refusal as a `PackError`. */
async function ask<C extends ReactorPipeCommand>(
  worker: EngineWorker,
  request: ReactorPipeRequest & { cmd: C },
  segments: readonly Uint8Array[] = [],
): Promise<{ body: Answer<C>; segments: Uint8Array[] }> {
  const { body, segments: out } = await worker.call(request, segments);
  if ("error" in body && body.error !== undefined) throw new PackError("engine-refused", `the engine refused ${request.cmd}: ${body.error.code}: ${body.error.message}`);
  if (body.cmd !== request.cmd) throw new PackError("engine-fault", `the engine answered ${String(body.cmd)} to ${request.cmd}`);
  // The cmd member was just compared with the request's, which is what `Answer<C>` says.
  const answer = body as Answer<C>;
  return { body: answer, segments: out };
}

/** Recalculates through an engine pool: open, `recalc` under the source's determinism, close. */
export class PoolXlsxEvaluator implements XlsxEvaluator {
  private readonly pool: WorkerPool;

  constructor(pool: WorkerPool) {
    this.pool = pool;
  }

  recalculate({ name, bytes, determinism }: EvaluationRequest): Promise<Uint8Array> {
    return this.pool.withWorker(async (worker) => {
      const opened = await ask(
        worker,
        {
          cmd: "open",
          bytes: { bin: 0, len: bytes.length },
          name,
          format: "xlsx",
          clock: determinism.clock,
          seed: determinism.seed,
          timezone: determinism.timezone ?? null,
          locale: determinism.locale ?? null,
        },
        [bytes],
      );
      const doc = opened.body.doc;
      try {
        const { body, segments } = await ask(worker, {
          cmd: "recalc",
          doc,
          clock: determinism.clock,
          seed: determinism.seed,
          timezone: determinism.timezone ?? null,
          locale: determinism.locale ?? null,
        });
        const output = body.outputs?.[0];
        if (!body.ok || output === undefined) {
          throw new PackError("recalc-failed", `the engine could not recalculate ${name}: ${JSON.stringify(body.receipt).slice(0, 300)}`);
        }
        const recalculated = segments[output.data.bin];
        if (recalculated === undefined) throw new PackError("engine-fault", `the engine's recalculation of ${name} has no bytes segment`);
        return recalculated;
      } finally {
        try {
          const { body } = await worker.call({ cmd: "close", doc });
          if (!body.ok || "error" in body) worker.discard();
        } catch {
          worker.discard();
        }
      }
    });
  }
}
