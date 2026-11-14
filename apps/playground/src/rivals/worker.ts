/// Worker entry: boots Pyodide with no network of its own. The scripts load by
/// same-origin URL; every other file arrives as bytes the page fetched and checked
/// against its pinned sha256, and is served to Pyodide by a replacement `fetch`
/// that answers `wolf-asset://` URLs and the wasm URL from bytes and rejects
/// everything else. `plan.ts` decides which URL each step uses.
import type { PyodideAPI, loadPyodide as LoadPyodide } from "pyodide";
import type { AssetRef } from "../lab/index.ts";
import { ADAPTER_SOURCE } from "./adapters.ts";
import { planLoad } from "./plan.ts";
import { lockdownOrThrow } from "./lockdown.ts";
import type { FromWorker, PythonResult, ToWorker } from "./protocol.ts";
import { createAssetFetch, lookupIn } from "./shim.ts";

type WorkerScope = {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};
// The worker global typed for the messages this protocol sends; the DOM and WebWorker libs disagree on `postMessage`.
const scope = globalThis as unknown as WorkerScope;

const pending = new Map<number, { resolve: (bytes: Uint8Array<ArrayBuffer>) => void; reject: (error: Error) => void }>();
let nextRequest = 1;
let pyodide: PyodideAPI | null = null;
let runEdit: ((rival: string, intentJson: string, src: string, dst: string) => string) | null = null;

function requestAsset(ref: AssetRef): Promise<Uint8Array<ArrayBuffer>> {
  const reqId = nextRequest++;
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  pending.set(reqId, { resolve, reject });
  scope.postMessage({ type: "asset-request", reqId, id: ref.id });
  return promise;
}

/** Load a script by URL. The URL is a runtime value, so a static import cannot name it. */
async function importScript(url: string): Promise<Record<string, unknown>> {
  return await import(/* @vite-ignore */ url);
}

async function boot(refs: AssetRef[], scriptBase: string): Promise<{ python: string; versions: Record<string, string> }> {
  const plan = planLoad(refs, scriptBase);
  globalThis.fetch = createAssetFetch({ lookup: lookupIn(refs), load: requestAsset, aliases: plan.aliases });

  // pyodide.mjs imports pyodide.asm.js itself, from indexURL (same-origin script too).
  const loader = await importScript(plan.loaderUrl);
  const loadPyodide = loader.loadPyodide as typeof LoadPyodide;
  const api = await loadPyodide({
    indexURL: plan.indexURL,
    lockFileURL: plan.lockFileURL,
    stdLibURL: plan.stdLibURL,
    stdout: () => {},
    stderr: () => {},
    checkAPIVersion: false,
  });
  for (const wheel of plan.wheels) {
    await api.loadPackage(wheel.url, { messageCallback: () => {}, errorCallback: () => {} });
  }
  api.runPython(ADAPTER_SOURCE);
  const versionsJson: string = api.runPython(
    `import json, importlib.metadata as m\njson.dumps({n: m.version(n) for n in ("openpyxl", "python-docx", "python-pptx", "lxml", "Pillow", "XlsxWriter")})`,
  );
  const python: string = api.runPython("import sys\nsys.version.split()[0]");
  const fn = api.globals.get("run_edit");
  // Boot work that needs the runtime's own network and loader surface is finished. Close the
  // global scope before `pyodide` and `runEdit` are set: no run can start until this returns,
  // so no Python the visitor supplied (or a rival library reading their file) ever sees it open.
  lockdownOrThrow(globalThis);
  pyodide = api;
  runEdit = (rival, intentJson, src, dst) => fn(rival, intentJson, src, dst);
  return { python, versions: JSON.parse(versionsJson) as Record<string, string> };
}

function removeTree(api: PyodideAPI, dir: string): void {
  for (const name of api.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    if (api.FS.isDir(api.FS.stat(path).mode)) removeTree(api, path);
    else api.FS.unlink(path);
  }
  api.FS.rmdir(dir);
}

function run(message: Extract<ToWorker, { type: "run" }>): void {
  const api = pyodide;
  const edit = runEdit;
  const started = performance.now();
  if (!api || !edit) {
    scope.postMessage({ type: "result", id: message.id, output: null, ms: 0, ok: false, error: "the Python runtime is not ready", stdout: "", stderr: "", version: null });
    return;
  }
  const dir = `/work/run-${message.id}`;
  const src = `${dir}/input${message.ext}`;
  const dst = `${dir}/output${message.ext}`;
  let result: PythonResult;
  let output: Uint8Array<ArrayBuffer> | null = null;
  try {
    api.FS.mkdirTree(dir);
    api.FS.writeFile(src, message.bytes);
    result = JSON.parse(edit(message.rival, message.intentJson, src, dst)) as PythonResult;
    if (api.FS.analyzePath(dst).exists) {
      const read = api.FS.readFile(dst);
      output = new Uint8Array(read.byteLength);
      output.set(read);
    }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error), stdout: "", stderr: "", version: null };
  } finally {
    try {
      removeTree(api, dir);
    } catch {
      // The scratch directory is gone with the worker anyway.
    }
  }
  scope.postMessage({ type: "result", id: message.id, output, ms: performance.now() - started, ...result }, output ? [output.buffer] : []);
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      boot(message.assets, message.scriptBase).then(
        ({ python, versions }) => scope.postMessage({ type: "ready", python, versions }),
        (error: unknown) => scope.postMessage({ type: "boot-error", message: error instanceof Error ? error.message : String(error) }),
      );
      return;
    case "asset": {
      const request = pending.get(message.reqId);
      pending.delete(message.reqId);
      request?.resolve(message.bytes);
      return;
    }
    case "asset-error": {
      const request = pending.get(message.reqId);
      pending.delete(message.reqId);
      request?.reject(new Error(message.message));
      return;
    }
    case "run":
      run(message);
      return;
  }
};
