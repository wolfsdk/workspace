import { describe, expect, test } from "bun:test";
import type { AssetRef } from "../src/lab/index.ts";
import { checkScriptBase, planLoad, PYODIDE_VERSION, SCRIPT_DIR, SCRIPT_FILES } from "../src/rivals/plan.ts";
import { ASSET_SCHEME } from "../src/rivals/shim.ts";

const BASE = `https://play.invalid/${SCRIPT_DIR}`;

const ref = (path: string, n: number): AssetRef => ({ id: n.toString(16).padStart(64, "0"), path, bytes: n, type: "application/octet-stream" });
const refs: AssetRef[] = [
  ref("rivals/pyodide/pyodide.asm.wasm", 1),
  ref("rivals/pyodide/python_stdlib.zip", 2),
  ref("rivals/pyodide/pyodide-lock.json", 3),
  ref("rivals/wheels/python_pptx-1.0.2-py3-none-any.whl", 4),
  ref("rivals/wheels/openpyxl-3.1.5-py2.py3-none-any.whl", 5),
  ref("rivals/wheels/lxml-6.0.2-cp313-cp313-pyemscripten_2025_0_wasm32.whl", 6),
  ref("rivals/wheels/typing_extensions-4.15.0-py3-none-any.whl", 7),
  ref("rivals/wheels/et_xmlfile-2.0.0-py3-none-any.whl", 8),
  ref("rivals/wheels/python_docx-1.2.0-py3-none-any.whl", 9),
];

describe("planLoad", () => {
  const plan = planLoad(refs, BASE);

  test("script URLs sit under the script base: the loader module, the asm script, the index", () => {
    expect(plan.loaderUrl).toBe(`${BASE}pyodide.mjs`);
    expect(plan.asmUrl).toBe(`${BASE}pyodide.asm.js`);
    expect(plan.indexURL).toBe(BASE);
    expect([...SCRIPT_FILES]).toEqual(["pyodide.mjs", "pyodide.asm.js"]);
    expect(SCRIPT_DIR).toBe(`pyodide/${PYODIDE_VERSION}/`);
    expect(PYODIDE_VERSION).toBe("0.29.5");
  });

  test("every URL is either a same-origin script URL or a wolf-asset URL; none is blob, data or remote", () => {
    const base = new URL(BASE);
    const scriptUrls = [plan.loaderUrl, plan.asmUrl, plan.indexURL];
    for (const url of scriptUrls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(base.origin);
      expect(parsed.pathname.startsWith(base.pathname)).toBe(true);
    }
    const assetUrls = [plan.stdLibURL, plan.lockFileURL, ...plan.wheels.map((w) => w.url)];
    for (const url of assetUrls) expect(url.startsWith(ASSET_SCHEME)).toBe(true);
    for (const url of [...scriptUrls, ...assetUrls, plan.wasmUrl, ...plan.aliases.keys()]) expect(url).not.toMatch(/^(blob|data|javascript):/);
  });

  test("the wasm is answered from bytes: its beside-the-script URL aliases the wasm asset", () => {
    expect(plan.wasmUrl).toBe(`${BASE}pyodide.asm.wasm`);
    expect(plan.aliases.get(plan.wasmUrl)).toBe("rivals/pyodide/pyodide.asm.wasm");
    expect(plan.aliases.size).toBe(1);
  });

  test("wheels load dependencies first, then rivals, and unlisted wheels last", () => {
    const names = plan.wheels.map((w) => w.ref.path.slice(w.ref.path.lastIndexOf("/") + 1).split("-")[0]);
    expect(names).toEqual(["typing_extensions", "et_xmlfile", "lxml", "openpyxl", "python_docx", "python_pptx"]);
    const extra = planLoad([...refs, ref("rivals/wheels/aaa-1.0-py3-none-any.whl", 10)], BASE);
    expect(extra.wheels.at(-1)!.ref.path).toBe("rivals/wheels/aaa-1.0-py3-none-any.whl");
  });

  test("a missing runtime asset names the path", () => {
    expect(() => planLoad(refs.filter((r) => !r.path.endsWith("pyodide-lock.json")), BASE)).toThrow(/rivals\/pyodide\/pyodide-lock\.json/);
  });
});

describe("checkScriptBase", () => {
  test("accepts an absolute http(s) directory URL", () => {
    expect(checkScriptBase(BASE).href).toBe(BASE);
    expect(checkScriptBase("http://localhost:5173/pyodide/0.29.5/").protocol).toBe("http:");
  });

  test.each([
    ["relative", "/pyodide/0.29.5/"],
    ["not a directory", "https://play.invalid/pyodide/0.29.5"],
    ["blob", "blob:https://play.invalid/1234"],
    ["data", "data:text/javascript,1"],
    ["query", "https://play.invalid/pyodide/0.29.5/?x=1"],
    ["fragment", "https://play.invalid/pyodide/0.29.5/#x"],
  ])("rejects %s", (_name, value) => {
    expect(() => checkScriptBase(value)).toThrow(/script base/);
  });
});
