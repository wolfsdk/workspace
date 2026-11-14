/**
 * In-process reactor kernel for Node and bun: same semantics as the Web
 * Worker client, without a worker. The module is read and compiled lazily on
 * the first call (reported as `timings.compileMs`, together with the
 * instantiation and the start-up check), then reused.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createReactorEngineKernel, type ReactorEngineKernel, type ReactorKernelOptions } from "./engine.ts";

export type {
  DamageReportResult,
  EngineInfo,
  ReactorEngineKernel,
  ReactorEnvironment,
  ReactorKernelOptions,
  ReactorStats,
} from "./engine.ts";

/** `vendor/wolf_web.wasm` at the root of the web workspace. */
export const DEFAULT_REACTOR_MODULE_PATH = fileURLToPath(new URL("../../../../vendor/wolf_web.wasm", import.meta.url));

export function createNodeReactorKernel(
  modulePath: string = DEFAULT_REACTOR_MODULE_PATH,
  options: ReactorKernelOptions = {},
): ReactorEngineKernel {
  return createReactorEngineKernel(async () => WebAssembly.compile(await readFile(modulePath)), options);
}
