/**
 * Web Worker entry. On `init` it takes the compiled module it was given, or
 * compiles the bytes it was given, or resolves and fetches the module from
 * its engine source (`@wolfsdk/runtime/loader`: SHA-256 checked when the
 * source names a checksum; streaming compile when the server sends
 * `application/wasm` and there is no checksum to check). A module it
 * compiled itself is posted back so a restarted worker skips the compile.
 * It then serves `ReactorKernelClient` calls; the engine kernel serialises
 * them.
 */
import { KernelRequestError, type ApplyResult, type KernelError } from "@wolfsdk/protocol";
import { EngineLoadError, fetchEngineBytes, resolveEngine } from "../loader.ts";
import { createReactorEngineKernel, type ReactorEngineKernel } from "./engine.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

let kernel: ReactorEngineKernel | null = null;

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Compile the module an `init` names (not a compiled one). Fetch failures
 * are `EngineLoadError`s with the loader's codes. */
async function load(msg: Extract<ToWorker, { type: "init" }>): Promise<WebAssembly.Module> {
  if (msg.bytes) return WebAssembly.compile(msg.bytes as Uint8Array<ArrayBuffer>);
  const resolved = await resolveEngine(msg.engine ?? {});
  if (resolved.sha256 !== null) {
    return WebAssembly.compile((await fetchEngineBytes(resolved)) as Uint8Array<ArrayBuffer>);
  }
  const { url } = resolved;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new EngineLoadError("http-error", `GET ${url} failed: ${describe(e)}`, url);
  }
  if (!response.ok)
    throw new EngineLoadError("http-error", `GET ${url}: ${response.status} ${response.statusText}`.trim(), url);
  if (response.headers.get("content-type")?.startsWith("application/wasm")) {
    return WebAssembly.compileStreaming(response);
  }
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch (e) {
    throw new EngineLoadError("http-error", `GET ${url}: reading the body failed: ${describe(e)}`, url);
  }
  return WebAssembly.compile(body);
}

/** Buffers in a result that can move to the main thread without a copy. */
function transferables(value: unknown): Transferable[] {
  if (value instanceof Uint8Array) return [value.buffer as ArrayBuffer];
  if (!value || typeof value !== "object") return [];
  const v = value as { png?: unknown; bytes?: unknown; files?: unknown; outputs?: unknown };
  if (v.png instanceof Uint8Array) return [v.png.buffer as ArrayBuffer];
  if (v.bytes instanceof Uint8Array) return [v.bytes.buffer as ArrayBuffer];
  if (Array.isArray(v.files))
    return v.files.flatMap((f: { bytes?: unknown }) =>
      f.bytes instanceof Uint8Array ? [f.bytes.buffer as ArrayBuffer] : [],
    );
  if (Array.isArray(v.outputs))
    return v.outputs.flatMap((o: { data?: unknown }) =>
      o.data instanceof Uint8Array ? [o.data.buffer as ArrayBuffer] : [],
    );
  return [];
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  // Thrown synchronously so it reaches the Worker's `error` event (a rejection
  // from the async handler below would not).
  if (event.data.type === "crash") throw new Error("worker crash requested (test hook)");
  void handle(event.data);
};

async function handle(msg: Exclude<ToWorker, { type: "crash" }>): Promise<void> {
  if (msg.type === "init") {
    let compiled: Promise<WebAssembly.Module>;
    if (msg.module) compiled = Promise.resolve(msg.module);
    else {
      compiled = load(msg);
      compiled.then(
        (module) => self.postMessage({ type: "module", module } satisfies FromWorker),
        () => undefined, // the first call reports the load failure
      );
    }
    kernel = createReactorEngineKernel(() => compiled, msg.options);
    return;
  }
  let reply: FromWorker;
  try {
    if (!kernel) throw new KernelRequestError({ code: "kernel-closed", message: "worker received a call before init" });
    const method = kernel[msg.method] as (...args: unknown[]) => Promise<unknown>;
    const value = await method(...msg.args);
    reply = { type: "result", id: msg.id, ok: true, value };
    if (msg.method === "apply" && (value as ApplyResult).ok) {
      const state = (value as Extract<ApplyResult, { ok: true }>).state;
      reply.env = kernel.revisionEnvironment(state.doc, state.revision);
    }
    self.postMessage(reply, transferables(value));
    return;
  } catch (e) {
    const error: KernelError =
      e instanceof KernelRequestError
        ? e.error
        : { code: "kernel-internal", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    reply = { type: "result", id: msg.id, ok: false, error };
  }
  self.postMessage(reply);
}
