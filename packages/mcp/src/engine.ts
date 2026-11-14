// The two ways this package talks to an engine worker (`wolfsdk.reactor-pipe.v1`), shared by the engine backed
// inspector and renderer: ask one command and get its typed answer, and hold one document open for a job.
import type { ReactorPipeCommand, ReactorPipeRequest, ReactorPipeResponse, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker, type WorkerPool } from "@wolfsdk/server";

/** What the engine backed hooks need of a `WorkerPool`: leasing a worker for one job. */
export type EnginePool = Pick<WorkerPool, "withWorker">;

/** The response member of `C`. A member can answer several commands (`observe` and `extract` share one), so this
 * picks those whose `cmd` includes `C` rather than those that equal it. */
type Answer<C extends ReactorPipeCommand> =
  ReactorPipeResponse extends infer R ? (R extends { cmd: infer K } ? ([C] extends [K] ? R : never) : never) : never;

/** The answer to `request`, narrowed to its command. Throws `EngineRefusal` when the worker said no and
 * `EngineFault` when it answered something else. */
export async function ask<C extends ReactorPipeCommand>(
  worker: EngineWorker,
  request: ReactorPipeRequest & { cmd: C },
  segments: readonly Uint8Array[] = [],
): Promise<{ body: Answer<C>; segments: Uint8Array[] }> {
  const { body, segments: out } = await worker.call(request, segments);
  if ("error" in body && body.error !== undefined) throw new EngineRefusal(body.error.code, body.error.message, body.cmd ?? request.cmd, body.error.argument);
  if (body.cmd !== request.cmd) throw new EngineFault(`worker answered ${String(body.cmd)} to ${request.cmd}`);
  return { body: body as Answer<C>, segments: out };
}

/** Open `bytes` in a worker to itself, run `job` on the handle and close it. A worker that can not say it
 * closed the document is not reused. */
export function withOpenDocument<T>(
  pool: EnginePool,
  input: { format: WorkspaceDocFormat; name: string; bytes: Uint8Array },
  job: (worker: EngineWorker, doc: number) => Promise<T>,
): Promise<T> {
  return pool.withWorker(async (worker) => {
    const opened = await ask(worker, { cmd: "open", bytes: { bin: 0, len: input.bytes.length }, name: input.name, format: input.format }, [input.bytes]);
    const doc = opened.body.doc;
    try {
      return await job(worker, doc);
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
