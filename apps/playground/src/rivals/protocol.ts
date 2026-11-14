import type { AssetRef, RivalId } from "../lab/index.ts";

/** Messages from the page to the rivals worker. */
export type ToWorker =
  /** `scriptBase`: absolute URL of the directory the app serves pyodide.mjs and pyodide.asm.js from (same origin as the worker). */
  | { type: "init"; assets: AssetRef[]; scriptBase: string }
  | { type: "asset"; reqId: number; bytes: Uint8Array<ArrayBuffer> }
  | { type: "asset-error"; reqId: number; message: string }
  | { type: "run"; id: number; rival: RivalId; kind: string; intentJson: string; ext: string; bytes: Uint8Array<ArrayBuffer> };

/** What one Python run reports. */
export type PythonResult = {
  ok: boolean;
  error: string | null;
  stdout: string;
  stderr: string;
  /** Library version as installed in the interpreter, if it imported. */
  version: string | null;
};

/** Messages from the rivals worker to the page. */
export type FromWorker =
  | { type: "asset-request"; reqId: number; id: string }
  | { type: "ready"; python: string; versions: Record<string, string> }
  | { type: "boot-error"; message: string }
  | ({ type: "result"; id: number; output: Uint8Array<ArrayBuffer> | null; ms: number } & PythonResult);
