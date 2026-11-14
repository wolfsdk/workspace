import type { AssetRef, LabAssets } from "../lab/index.ts";
import { PYODIDE_VERSION } from "./plan.ts";

/**
 * Every file the rivals worker reads besides the two Pyodide scripts, pinned
 * by sha256 and size. The three runtime files come from the `pyodide` npm
 * package and are served by this app beside the scripts (`url` relative to
 * the script directory); the wheels are fetched from the Pyodide CDN and from
 * PyPI. A file whose bytes do not hash to `id` is refused, wherever it came from.
 */
export type RivalSource = AssetRef & { url: string };

const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PYPI = "https://files.pythonhosted.org/packages/";

export const RIVAL_SOURCES: readonly RivalSource[] = [
  {
    path: "rivals/pyodide/pyodide-lock.json",
    url: "pyodide-lock.json",
    id: "14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d",
    bytes: 122027,
    type: "application/json",
  },
  {
    path: "rivals/pyodide/pyodide.asm.wasm",
    url: "pyodide.asm.wasm",
    id: "54309a5a2cfd757b1f0fdbc9093c92503f7b341500110329d932487183912718",
    bytes: 8647684,
    type: "application/wasm",
  },
  {
    path: "rivals/pyodide/python_stdlib.zip",
    url: "python_stdlib.zip",
    id: "831fd1e535084b972f87c6a35275de3d236efd5166f5e77ce89497710635e73c",
    bytes: 2424003,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
    url: `${CDN}lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl`,
    id: "726fd93726e98fb9472d6ded592bc1a564e7e1bf1895bd51fb86cd0b03aac43f",
    bytes: 1637504,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl",
    url: `${CDN}pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl`,
    id: "57d88e2ac283c21830b4ee920cb73fbbf5c46df62d967089fce5fec46548bd7b",
    bytes: 1037865,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/typing_extensions-4.15.0-py3-none-any.whl",
    url: `${CDN}typing_extensions-4.15.0-py3-none-any.whl`,
    id: "42190f892f6219350c50e107954f57cb6196acac818fece4a7d21689c94f71de",
    bytes: 44613,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/openpyxl-3.1.5-py2.py3-none-any.whl",
    url: `${PYPI}c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl`,
    id: "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2",
    bytes: 250910,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/et_xmlfile-2.0.0-py3-none-any.whl",
    url: `${PYPI}c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl`,
    id: "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa",
    bytes: 18059,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/python_docx-1.2.0-py3-none-any.whl",
    url: `${PYPI}d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl`,
    id: "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
    bytes: 252987,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/python_pptx-1.0.2-py3-none-any.whl",
    url: `${PYPI}d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49/python_pptx-1.0.2-py3-none-any.whl`,
    id: "160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba",
    bytes: 472788,
    type: "application/zip",
  },
  {
    path: "rivals/wheels/xlsxwriter-3.3.1-py3-none-any.whl",
    url: `${PYPI}88/eb/1e6af9959a567901a7e7c7cef2e75883e487df223ed67f9a8977ff863bd8/xlsxwriter-3.3.1-py3-none-any.whl`,
    id: "8e2c89e59d733fe59e112317218c64fbbc276d90a8c144ebd6f7fa15e7ab184a",
    bytes: 180583,
    type: "application/zip",
  },
];

export type FetchedAssetsOptions = {
  /** Absolute URL that relative source URLs resolve against (the Pyodide script directory). */
  base: string;
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
  sources?: readonly RivalSource[];
  fetch?: typeof fetch;
};

/**
 * Assets fetched on first use and kept for the page's lifetime. Each file is
 * fetched once; a failed fetch or a hash mismatch rejects that read and the
 * next read tries again.
 */
export function createFetchedAssets(options: FetchedAssetsOptions): LabAssets {
  const sources = options.sources ?? RIVAL_SOURCES;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const loaded = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

  async function load(source: RivalSource): Promise<Uint8Array<ArrayBuffer>> {
    const url = new URL(source.url, options.base).href;
    let response: Response;
    try {
      response = await doFetch(url);
    } catch (error) {
      throw new Error(`could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha = await options.sha256Hex(bytes);
    if (sha !== source.id) throw new Error(`${source.path} does not match its pinned sha256 (got ${sha})`);
    return bytes;
  }

  return {
    get(ref) {
      const key = typeof ref === "string" ? ref : ref.id;
      const source = byId.get(key) ?? byPath.get(key);
      if (!source) return Promise.reject(new Error(`no such asset: ${key}`));
      let pending = loaded.get(source.id);
      if (!pending) {
        pending = load(source);
        loaded.set(source.id, pending);
        pending.catch(() => loaded.delete(source.id));
      }
      // A copy: callers may transfer what they receive.
      return pending.then((bytes) => bytes.slice());
    },
    list() {
      return sources.map(({ id, path, bytes, type }) => ({ id, path, bytes, type }));
    },
  };
}
