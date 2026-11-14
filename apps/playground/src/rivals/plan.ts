import type { AssetRef } from "../lab/index.ts";
import { assetUrl } from "./shim.ts";

/** The Pyodide build the staged files come from. */
export const PYODIDE_VERSION = "0.29.5";

/** Where the app serves the Pyodide package files, relative to its base URL. */
export const SCRIPT_DIR = `pyodide/${PYODIDE_VERSION}/`;

/** The scripts the worker loads by URL. Every other file arrives as bytes from the page, pinned by sha256. */
export const SCRIPT_FILES = ["pyodide.mjs", "pyodide.asm.js"] as const;

/** Bytes that Pyodide reads through `fetch`; they arrive from the page as `rivals/pyodide/<file>`. */
const DATA_DIR = "rivals/pyodide/";
const WASM = "pyodide.asm.wasm";
const STDLIB = "python_stdlib.zip";
const LOCK = "pyodide-lock.json";
const WHEEL_DIR = "rivals/wheels/";

/** Wheels load in this order so each finds its dependencies; unlisted wheels load last, by name. */
const WHEEL_ORDER = ["typing_extensions", "et_xmlfile", "lxml", "pillow", "xlsxwriter", "openpyxl", "python_docx", "python_pptx"];

/**
 * Every URL the worker hands to the runtime:
 *
 * - `loaderUrl` is imported as a module: a same-origin script URL.
 * - `indexURL` is where Pyodide imports `pyodide.asm.js` from: same-origin script.
 * - `stdLibURL`, `lockFileURL` and the wheel URLs are `wolf-asset://` URLs read by the
 *   worker's own `fetch`, which answers them from bytes the page verified. The worker
 *   makes no network request of its own.
 * - `aliases` maps the one URL Pyodide builds for its wasm (beside the script) to the
 *   wasm asset, so that read is answered from bytes too.
 */
export type LoadPlan = {
  scriptBase: string;
  loaderUrl: string;
  asmUrl: string;
  indexURL: string;
  stdLibURL: string;
  lockFileURL: string;
  wasmUrl: string;
  aliases: Map<string, string>;
  /** Wheel assets in install order, each with the URL passed to `loadPackage`. */
  wheels: { ref: AssetRef; url: string }[];
};

function wheelRank(path: string): number {
  const file = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const index = WHEEL_ORDER.findIndex((name) => file.startsWith(`${name}-`));
  return index === -1 ? WHEEL_ORDER.length : index;
}

/** A script base must be an absolute http(s) URL ending in a slash, so the scripts it names are same-origin script URLs. */
export function checkScriptBase(scriptBase: string): URL {
  let url: URL;
  try {
    url = new URL(scriptBase);
  } catch {
    throw new Error(`the script base must be an absolute URL (got ${scriptBase.slice(0, 80)})`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.pathname.endsWith("/") || url.search !== "" || url.hash !== "") {
    throw new Error(`the script base must be an http(s) directory URL (got ${scriptBase.slice(0, 80)})`);
  }
  return url;
}

export function planLoad(refs: readonly AssetRef[], scriptBase: string): LoadPlan {
  const base = checkScriptBase(scriptBase).href;
  const paths = new Map(refs.map((ref) => [ref.path, ref]));
  const need = (path: string): AssetRef => {
    const ref = paths.get(path);
    if (!ref) throw new Error(`the rival assets do not include ${path}`);
    return ref;
  };
  const dataRefs = [need(`${DATA_DIR}${WASM}`), need(`${DATA_DIR}${STDLIB}`), need(`${DATA_DIR}${LOCK}`)];
  const wheels = refs
    .filter((ref) => ref.path.startsWith(WHEEL_DIR) && ref.path.endsWith(".whl"))
    .sort((a, b) => wheelRank(a.path) - wheelRank(b.path) || (a.path < b.path ? -1 : 1))
    .map((ref) => ({ ref, url: assetUrl(ref.path) }));
  const wasmUrl = `${base}${WASM}`;
  return {
    scriptBase: base,
    loaderUrl: `${base}${SCRIPT_FILES[0]}`,
    asmUrl: `${base}${SCRIPT_FILES[1]}`,
    indexURL: base,
    stdLibURL: assetUrl(dataRefs[1]!.path),
    lockFileURL: assetUrl(dataRefs[2]!.path),
    wasmUrl,
    aliases: new Map([[wasmUrl, dataRefs[0]!.path]]),
    wheels,
  };
}
