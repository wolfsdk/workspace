import { describe, expect, test } from "bun:test";
import type { AssetRef } from "../src/lab/index.ts";
import { assetTarget, assetUrl, createAssetFetch, lookupIn } from "../src/rivals/shim.ts";

const refs: AssetRef[] = [
  { id: "a".repeat(64), path: "rivals/pyodide/pyodide.mjs", bytes: 3, type: "text/javascript" },
  { id: "b".repeat(64), path: "rivals/wheels/x-1.0-py3-none-any.whl", bytes: 2, type: "application/zip" },
];

function shim() {
  const loaded: string[] = [];
  const fetchShim = createAssetFetch({
    lookup: lookupIn(refs),
    load: async (ref) => {
      loaded.push(ref.id);
      return new Uint8Array([1, 2, 3]);
    },
  });
  return { fetchShim, loaded };
}

describe("worker fetch shim", () => {
  test("serves an asset by logical path and by id", async () => {
    const { fetchShim, loaded } = shim();
    const byPath = await fetchShim(assetUrl("rivals/pyodide/pyodide.mjs"));
    expect(byPath.status).toBe(200);
    expect(byPath.headers.get("content-type")).toBe("text/javascript");
    expect([...new Uint8Array(await byPath.arrayBuffer())]).toEqual([1, 2, 3]);
    const byId = await fetchShim(assetUrl("b".repeat(64)));
    expect(byId.status).toBe(200);
    expect(loaded).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  test("answers 404 for an asset scheme URL the manifest does not list", async () => {
    const { fetchShim, loaded } = shim();
    const response = await fetchShim(assetUrl("rivals/missing.bin"));
    expect(response.status).toBe(404);
    expect(loaded).toEqual([]);
  });

  test.each([
    "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.asm.wasm",
    "http://localhost:8000/x",
    "//evil.example/x",
    "/rivals/pyodide/pyodide.mjs",
    "rivals/pyodide/pyodide.mjs",
    "file:///etc/passwd",
    "data:text/plain,hi",
    "blob:https://example.com/1234",
    "wolf-asset:/missing-slashes",
    "WOLF-ASSET://rivals/pyodide/pyodide.mjs",
    "wolf-asset://",
    "",
  ])("rejects %p", async (url) => {
    const { fetchShim, loaded } = shim();
    await expect(fetchShim(url)).rejects.toThrow(TypeError);
    expect(loaded).toEqual([]);
  });

  test("rejects a URL object and a Request that are not asset URLs", async () => {
    const { fetchShim, loaded } = shim();
    await expect(fetchShim(new URL("https://example.com/a.whl"))).rejects.toThrow(TypeError);
    await expect(fetchShim(new Request("https://example.com/a.whl"))).rejects.toThrow(TypeError);
    await expect(fetchShim(undefined as never)).rejects.toThrow(TypeError);
    expect(loaded).toEqual([]);
  });

  test("assetTarget decodes escapes and drops the query", () => {
    expect(assetTarget("wolf-asset://rivals/wheels/a%20b.whl?x=1#y")).toBe("rivals/wheels/a b.whl");
    expect(assetTarget("wolf-asset://%E0%A4%A")).toBeNull();
    expect(assetTarget(42)).toBeNull();
  });

  test("answers an aliased URL from its target asset, ignoring query and fragment, and blocks its neighbours", async () => {
    const loaded: string[] = [];
    const aliased = createAssetFetch({
      lookup: lookupIn(refs),
      load: async (ref) => {
        loaded.push(ref.id);
        return new Uint8Array([9]);
      },
      aliases: new Map([["https://play.invalid/pyodide/0.29.5/pyodide.asm.wasm", "rivals/pyodide/pyodide.mjs"]]),
    });
    const hit = await aliased("https://play.invalid/pyodide/0.29.5/pyodide.asm.wasm?v=1#x");
    expect(hit.status).toBe(200);
    expect(loaded).toEqual(["a".repeat(64)]);
    await expect(aliased("https://play.invalid/pyodide/0.29.5/pyodide.asm.js")).rejects.toThrow(TypeError);
    await expect(aliased("https://play.invalid/pyodide/0.29.5/pyodide.asm.wasm.map")).rejects.toThrow(TypeError);
  });
});
