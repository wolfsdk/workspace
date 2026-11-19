// One call to an engine worker, narrowed to the command it answered.
import type { ReactorPipeCommand, ReactorPipeRefusal, ReactorPipeRequest, ReactorPipeResponse } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type EngineWorker } from "@wolfsdk/server";

/** The answer that is not a refusal and is for command `C`. A response member may answer several commands (`extract`
 * shares one with `observe`, `recalc` and `damage_report`), so it is matched by `C` being one of them. */
export type Answer<C extends ReactorPipeCommand> =
  Exclude<ReactorPipeResponse, ReactorPipeRefusal> extends infer R ? (R extends { cmd: infer K } ? ([C] extends [K] ? R : never) : never) : never;

/** The answer to `request`, narrowed to its command, with the binary segments that came with it. `EngineRefusal` when
 * the worker said no, `EngineFault` when it answered another command. */
export async function askWithSegments<C extends ReactorPipeCommand>(
  worker: EngineWorker,
  request: ReactorPipeRequest & { cmd: C },
  segments: readonly Uint8Array[] = [],
): Promise<{ body: Answer<C>; segments: Uint8Array[] }> {
  const answer = await worker.call(request, segments);
  const { body } = answer;
  if ("error" in body && body.error !== undefined) throw new EngineRefusal(body.error.code, body.error.message, body.cmd ?? request.cmd, body.error.argument);
  if (body.cmd !== request.cmd) throw new EngineFault(`worker answered ${String(body.cmd)} to ${request.cmd}`);
  return { body: body as Answer<C>, segments: answer.segments };
}

/** The answer to `request`, narrowed to its command. */
export async function ask<C extends ReactorPipeCommand>(worker: EngineWorker, request: ReactorPipeRequest & { cmd: C }, segments: readonly Uint8Array[] = []): Promise<Answer<C>> {
  return (await askWithSegments<C>(worker, request, segments)).body;
}
