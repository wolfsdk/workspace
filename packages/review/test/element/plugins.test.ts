import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { EditorPlugin } from "../../src/host/index.ts";
import {
  PLUGIN_IDS,
  PluginLoadError,
  REVIEW_PLUGIN_IDS,
  createPluginLoader,
  createPluginSession,
  isLazyPlugin,
  missingPlugins,
  parsePlugins,
  pluginIdsFor,
  pluginStyles,
  selectPlugins,
  type LazyPluginId,
  type PluginChunk,
  type PluginImports,
} from "../../src/element/plugins.ts";
import { reviewPlugin } from "../../src/review/index.ts";

const Toolbar = () => null;

/** A chunk whose plugin carries a toolbar, so read-only mode has something to drop. */
function chunk(id: LazyPluginId): PluginChunk {
  return { plugin: { id, Toolbar } as EditorPlugin, styles: `.${id}{}` };
}

/** Imports that resolve to `chunk(id)` and count their calls; `fail` ids reject until `heal` is called. */
function imports(fail: LazyPluginId[] = []): { imports: PluginImports; calls: Record<LazyPluginId, number>; heal: () => void } {
  const calls: Record<LazyPluginId, number> = { docs: 0, slides: 0, sheets: 0 };
  const broken = new Set<LazyPluginId>(fail);
  const make = (id: LazyPluginId) => async (): Promise<PluginChunk> => {
    calls[id]++;
    if (broken.has(id)) throw new Error(`${id} chunk 404`);
    return chunk(id);
  };
  return {
    imports: { docs: make("docs"), slides: make("slides"), sheets: make("sheets") },
    calls,
    heal: () => broken.clear(),
  };
}

describe("plugin loader", () => {
  test("nothing is loaded until it is asked for", () => {
    const { imports: i, calls } = imports();
    const loader = createPluginLoader(i);
    expect(loader.loaded("sheets")).toBeUndefined();
    expect(calls).toEqual({ docs: 0, slides: 0, sheets: 0 });
  });

  test("a chunk is fetched once, however often and however concurrently it is requested", async () => {
    const { imports: i, calls } = imports();
    const loader = createPluginLoader(i);
    const [a, b] = await Promise.all([loader.load(["sheets"]), loader.load(["sheets", "docs"])]);
    await loader.load(["sheets"]);
    expect(a.map((c) => c.plugin.id)).toEqual(["sheets"]);
    expect(b.map((c) => c.plugin.id)).toEqual(["sheets", "docs"]);
    expect(calls).toEqual({ docs: 1, slides: 0, sheets: 1 });
    expect(loader.loaded("sheets")?.styles).toBe(".sheets{}");
    expect(loader.loaded("slides")).toBeUndefined();
  });

  test("a failed chunk rejects with its id, the others still load, and the next request retries it", async () => {
    const { imports: i, calls, heal } = imports(["slides"]);
    const loader = createPluginLoader(i);
    const failure = await loader.load(["docs", "slides"]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginLoadError);
    expect((failure as PluginLoadError).id).toBe("slides");
    expect((failure as PluginLoadError).message).toContain("slides chunk 404");
    expect(loader.loaded("docs")).toBeDefined();
    expect(loader.loaded("slides")).toBeUndefined();

    heal();
    await loader.load(["docs", "slides"]);
    expect(loader.loaded("slides")?.plugin.id).toBe("slides");
    expect(calls).toEqual({ docs: 1, slides: 2, sheets: 0 });
  });

  test("a rejected request waits for every other request before it reports", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { imports: i } = imports(["docs"]);
    const slow = imports();
    const loader = createPluginLoader({
      ...i,
      sheets: async () => {
        await gate;
        return slow.imports.sheets();
      },
    });
    let settled = false;
    const result = loader.load(["docs", "sheets"]).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await result).toBeInstanceOf(PluginLoadError);
    expect(loader.loaded("sheets")).toBeDefined();
  });
});

describe("plugin ids", () => {
  test("review is the one eager plugin", () => {
    expect(PLUGIN_IDS).toEqual(["docs", "slides", "sheets", "review"]);
    expect(PLUGIN_IDS.filter(isLazyPlugin)).toEqual(["docs", "slides", "sheets"]);
    expect(isLazyPlugin("review")).toBe(false);
  });

  test("the plugins attribute keeps its documented order and reports unknown tokens", () => {
    expect(parsePlugins(null)).toEqual({ ids: [...PLUGIN_IDS], unknown: [] });
    expect(parsePlugins("review  docs")).toEqual({ ids: ["docs", "review"], unknown: [] });
    expect(parsePlugins("sheets nope")).toEqual({ ids: ["sheets"], unknown: ["nope"] });
    expect(parsePlugins("")).toEqual({ ids: [], unknown: [] });
  });

  test("review mode is the review plugin whatever the attribute says; edit mode follows it", () => {
    expect(pluginIdsFor("review", "docs slides sheets")).toEqual({ ids: REVIEW_PLUGIN_IDS, unknown: [] });
    expect(pluginIdsFor("review", null).ids).toEqual(["review"]);
    expect(pluginIdsFor("edit", "sheets")).toEqual({ ids: ["sheets"], unknown: [] });
    expect(pluginIdsFor("edit", null).ids).toEqual([...PLUGIN_IDS]);
  });

  test("missingPlugins lists the authoring chunks still to fetch", async () => {
    const { imports: i } = imports();
    const loader = createPluginLoader(i);
    expect(missingPlugins(["review"], loader)).toEqual([]);
    expect(missingPlugins(["docs", "sheets", "review"], loader)).toEqual(["docs", "sheets"]);
    await loader.load(["docs"]);
    expect(missingPlugins(["docs", "sheets", "review"], loader)).toEqual(["sheets"]);
  });
});

describe("plugin selection", () => {
  test("review mode renders at once, with no authoring chunk loaded", () => {
    const loader = createPluginLoader(imports().imports);
    expect(selectPlugins(REVIEW_PLUGIN_IDS, true, loader)).toEqual([{ ...reviewPlugin, Toolbar: undefined }]);
  });

  test("loaded plugins come back in key-routing order, review last, unloaded ones left out", async () => {
    const loader = createPluginLoader(imports().imports);
    expect(selectPlugins(PLUGIN_IDS, false, loader).map((p) => p.id)).toEqual(["review"]);
    await loader.load(["sheets", "docs"]);
    expect(selectPlugins(PLUGIN_IDS, false, loader).map((p) => p.id)).toEqual(["docs", "sheets", "review"]);
    expect(selectPlugins(["sheets"], false, loader).map((p) => p.id)).toEqual(["sheets"]);
  });

  test("read-only drops each toolbar and keeps the plugin", async () => {
    const loader = createPluginLoader(imports().imports);
    await loader.load(["docs"]);
    const editable = selectPlugins(["docs", "review"], false, loader);
    const readonly = selectPlugins(["docs", "review"], true, loader);
    expect(editable[0]?.Toolbar).toBe(Toolbar);
    expect(readonly.map((p) => p.id)).toEqual(["docs", "review"]);
    expect(readonly.every((p) => p.Toolbar === undefined)).toBe(true);
  });

  test("the review plugin serves the workbook's main view, the sheets plugin its own", () => {
    expect(reviewPlugin.MainView).toBeDefined();
    expect(reviewPlugin.mainViewFormats).toEqual(["xlsx"]);
  });

  test("stylesheets come from the loaded authoring plugins only", async () => {
    const loader = createPluginLoader(imports().imports);
    expect(pluginStyles(PLUGIN_IDS, loader)).toEqual([]);
    await loader.load(["slides", "docs"]);
    expect(pluginStyles(PLUGIN_IDS, loader)).toEqual([".docs{}", ".slides{}"]);
  });
});

describe("plugin session lifecycle", () => {
  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  test("stop() clears cached plugins so an engine restart while chunks are in-flight re-selects them", async () => {
    const { promise: gate, resolve: releaseSheets } = Promise.withResolvers<void>();
    const loader = createPluginLoader({
      docs: async () => chunk("docs"),
      slides: async () => chunk("slides"),
      sheets: async () => {
        await gate;
        return chunk("sheets");
      },
    });
    const ps = createPluginSession(loader);
    let activeSession = 1;
    let session1Updates = 0;
    let session2Updates = 0;

    // Session 1 starts in edit mode while `sheets` is still downloading -> partial set first.
    const s1Host = {
      isCurrent: () => activeSession === 1,
      adoptStyles: () => {},
      onUpdate: () => {
        session1Updates++;
      },
      reportError: () => {},
    };
    expect(ps.get("edit", "sheets review", false, s1Host).map((p) => p.id)).toEqual(["review"]);

    // Caller sets `el.engine = { format: "xlsx", ... }`, which calls `#stop()` then `#start()` (Session 2).
    ps.stop();
    activeSession = 2;
    const s2Styles: string[] = [];
    const s2Host = {
      isCurrent: () => activeSession === 2,
      adoptStyles: (styles: readonly string[]) => s2Styles.push(...styles),
      onUpdate: () => {
        session2Updates++;
      },
      reportError: () => {},
    };
    // Session 2 must re-choose (not reuse Session 1's partial cached array) and subscribe to `sheets`.
    expect(ps.get("edit", "sheets review", false, s2Host).map((p) => p.id)).toEqual(["review"]);

    releaseSheets();
    await loader.load(["sheets"]);
    await flushMicrotasks();

    expect(session1Updates).toBe(0);
    expect(session2Updates).toBe(1);
    expect(ps.get("edit", "sheets review", false, s2Host).map((p) => p.id)).toEqual(["sheets", "review"]);
    expect(s2Styles).toContain(".sheets{}");
  });

  test("stop() resets unknown-plugin reporting for the new session and invalidate() retries failed chunks", async () => {
    const { imports: i, heal } = imports(["docs"]);
    const loader = createPluginLoader(i);
    const ps = createPluginSession(loader);
    const errors: string[] = [];
    const { promise: firstFail, resolve: onFirstFail } = Promise.withResolvers<void>();
    const { promise: healedUpdate, resolve: onHealedUpdate } = Promise.withResolvers<void>();
    const host = {
      isCurrent: () => true,
      adoptStyles: () => {},
      onUpdate: () => onHealedUpdate(),
      reportError: (e: { code: string; argument?: string }) => {
        errors.push(`${e.code}:${e.argument ?? ""}`);
        if (e.code === "plugin-load-failed") onFirstFail();
      },
    };

    ps.get("edit", "docs bogus", false, host);
    await firstFail;
    expect(errors).toEqual(["plugin-unknown:bogus", "plugin-load-failed:docs"]);

    // Cached call within same session does not re-emit unknown or retry until invalidated.
    ps.get("edit", "docs bogus", false, host);
    expect(errors.length).toBe(2);

    heal();
    ps.stop();
    ps.get("edit", "docs bogus", false, host);
    await healedUpdate;
    expect(errors).toEqual(["plugin-unknown:bogus", "plugin-load-failed:docs", "plugin-unknown:bogus"]);
    expect(ps.get("edit", "docs bogus", false, host).map((p) => p.id)).toEqual(["docs"]);
  });
});

/** Every `.ts` and `.tsx` file under `dir`, recursively. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("entry graph", () => {
  const src = join(import.meta.dir, "..", "..", "src");
  const outside = sourcesUnder(src).filter((file) => !relative(src, file).startsWith("plugins/"));

  test("no file outside src/plugins imports an authoring plugin statically", () => {
    const staticImport = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["'][^"']*\/plugins\/[^"']*["']|(?:^|\n)\s*import\s*["'][^"']*\/plugins\/[^"']*["']/;
    const offenders = outside.filter((file) => staticImport.test(readFileSync(file, "utf8"))).map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });

  test("the loader table is the only reference to the authoring plugins, and each is a dynamic import", () => {
    const dynamic = /import\(\s*["'][^"']*\/plugins\/([a-z]+)\/index\.ts["']\s*\)/g;
    const referencing = outside.filter((file) => /\/plugins\/(docs|slides|sheets)\b/.test(readFileSync(file, "utf8")));
    expect(referencing.map((f) => relative(src, f))).toEqual(["element/plugins.ts"]);
    const text = readFileSync(join(src, "element", "plugins.ts"), "utf8");
    expect([...text.matchAll(dynamic)].map((m) => m[1]).sort()).toEqual(["docs", "sheets", "slides"]);
  });
});
