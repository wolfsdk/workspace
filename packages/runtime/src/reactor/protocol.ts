/** Messages between `client.ts` (main thread) and `worker.ts`. */
import type { BatchEnvironment, KernelError } from "@wolfsdk/protocol";
import type { EngineSource } from "../loader.ts";
import type { ReactorEngineKernel, ReactorKernelOptions } from "./engine.ts";

export type ReactorMethod = Exclude<keyof ReactorEngineKernel, "kind" | "revisionEnvironment">;

/** An `EngineSource` a worker can receive (structured-cloneable: no `fetch`). */
export type WorkerEngineSource = Omit<EngineSource, "fetch">;

export type ToWorker =
  /** Where the module comes from, first present member wins: `module`, an
   * already compiled module (a restart, or one compiled on the page);
   * `bytes`, compiled in the worker; `engine`, resolved and fetched in the
   * worker (`@wolfsdk/runtime/loader`; default: the public channel). A
   * worker that compiles the module itself posts it back once. */
  | {
      type: "init";
      options: ReactorKernelOptions;
      module?: WebAssembly.Module;
      bytes?: Uint8Array;
      engine?: WorkerEngineSource;
    }
  | { type: "call"; id: number; method: ReactorMethod; args: unknown[] }
  /** Test hook: throw from the message handler, as a worker crash would. */
  | { type: "crash" };

export type FromWorker =
  | { type: "module"; module: WebAssembly.Module }
  /** `env`: clock and zone of the revision a successful `apply` produced. */
  | { type: "result"; id: number; ok: true; value: unknown; env?: Required<BatchEnvironment> }
  | { type: "result"; id: number; ok: false; error: KernelError };
