import type { EditorPlugin } from "../host/index.ts";
import { reviewPlugin } from "../review/index.ts";
import type { WolfMode, WolfPluginId } from "./types.ts";

/** Key-routing order (the shell asks each `onKeyDown` in this order). */
export const PLUGIN_IDS: readonly WolfPluginId[] = ["docs", "slides", "sheets", "review"];

/** The plugin set of `mode="review"`, whatever the `plugins` attribute says. */
export const REVIEW_PLUGIN_IDS: readonly WolfPluginId[] = ["review"];

/** The plugins that are separate chunks, fetched when the page asks for them (everything but `review`). */
export type LazyPluginId = Exclude<WolfPluginId, "review">;

/** One loaded authoring plugin: the plugin and its stylesheet text, which the element adopts once. */
export type PluginChunk = { plugin: EditorPlugin; styles: string };

export type PluginImports = Record<LazyPluginId, () => Promise<PluginChunk>>;

/**
 * The only references to the authoring plugins. Each one is a dynamic `import()`, so the bundler
 * emits it as its own chunk; a static import anywhere in the entry's graph would pull it back in
 * (`scripts/check.ts` fails the package when that happens).
 */
const IMPORTS: PluginImports = {
  docs: () => import("../plugins/docs/index.ts").then((m) => ({ plugin: m.docsPlugin, styles: m.styles })),
  slides: () => import("../plugins/slides/index.ts").then((m) => ({ plugin: m.slidesPlugin, styles: m.styles })),
  sheets: () => import("../plugins/sheets/index.ts").then((m) => ({ plugin: m.sheetsPlugin, styles: m.styles })),
};

export function isLazyPlugin(id: WolfPluginId): id is LazyPluginId {
  return id !== "review";
}

/** A plugin chunk that did not load (network failure, a stale deployment): the id and the underlying cause. */
export class PluginLoadError extends Error {
  readonly id: LazyPluginId;
  constructor(id: LazyPluginId, cause: unknown) {
    super(`The ${id} plugin could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PluginLoadError";
    this.id = id;
  }
}

export type PluginLoader = {
  /** The plugin once its chunk is loaded, else undefined. */
  loaded(id: LazyPluginId): PluginChunk | undefined;
  /** Fetch the chunks of `ids` (each at most once). Once every request has settled, rejects with the
   * `PluginLoadError` of the first that failed; the ones that loaded stay available through `loaded`. */
  load(ids: readonly LazyPluginId[]): Promise<PluginChunk[]>;
};

/**
 * A plugin loader over `imports`. A successful chunk is kept for the page's lifetime; a failed one
 * is dropped, so the next request fetches it again.
 */
export function createPluginLoader(imports: PluginImports = IMPORTS): PluginLoader {
  const pending = new Map<LazyPluginId, Promise<PluginChunk>>();
  const done = new Map<LazyPluginId, PluginChunk>();
  const one = (id: LazyPluginId): Promise<PluginChunk> => {
    const cached = pending.get(id);
    if (cached) return cached;
    const request = imports[id]().then(
      (chunk) => {
        done.set(id, chunk);
        return chunk;
      },
      (cause: unknown) => {
        pending.delete(id);
        throw new PluginLoadError(id, cause);
      },
    );
    pending.set(id, request);
    return request;
  };
  return {
    loaded: (id) => done.get(id),
    load: async (ids) => {
      const results = await Promise.allSettled(ids.map(one));
      const chunks: PluginChunk[] = [];
      let failure: { reason: unknown } | null = null;
      for (const result of results) {
        if (result.status === "fulfilled") chunks.push(result.value);
        else failure ??= { reason: result.reason };
      }
      if (failure) throw failure.reason;
      return chunks;
    },
  };
}

/** The loader the element uses. */
export const pluginLoader: PluginLoader = createPluginLoader();

function isPluginId(token: string): token is WolfPluginId {
  return (PLUGIN_IDS as readonly string[]).includes(token);
}

/** Parse the `plugins` attribute (space-separated; null = all). Unknown tokens are returned separately. */
export function parsePlugins(value: string | null): { ids: WolfPluginId[]; unknown: string[] } {
  if (value === null) return { ids: [...PLUGIN_IDS], unknown: [] };
  const tokens = value.split(/\s+/).filter(Boolean);
  return { ids: PLUGIN_IDS.filter((id) => tokens.includes(id)), unknown: tokens.filter((t) => !isPluginId(t)) };
}

/** The plugin ids a mode renders: review mode has the review plugin only, whatever `plugins` says. */
export function pluginIdsFor(
  mode: WolfMode,
  attribute: string | null,
): { ids: readonly WolfPluginId[]; unknown: string[] } {
  if (mode === "review") return { ids: REVIEW_PLUGIN_IDS, unknown: [] };
  return parsePlugins(attribute);
}

/** The ids of `ids` whose chunk is not loaded yet. */
export function missingPlugins(ids: readonly WolfPluginId[], loader: PluginLoader = pluginLoader): LazyPluginId[] {
  return ids.filter(isLazyPlugin).filter((id) => !loader.loaded(id));
}

/**
 * The plugins to render, in key-routing order. An authoring plugin whose chunk is not loaded is
 * left out (the element renders again when it arrives). Read-only drops each plugin's `Toolbar`
 * (its editing controls); views, rails, panels and overlays stay, and every edit they try is
 * refused by the element's host (`readonly`).
 */
export function selectPlugins(
  ids: readonly WolfPluginId[],
  readonly: boolean,
  loader: PluginLoader = pluginLoader,
): EditorPlugin[] {
  const plugins: EditorPlugin[] = [];
  for (const id of PLUGIN_IDS) {
    if (!(ids as readonly string[]).includes(id)) continue;
    const plugin = id === "review" ? reviewPlugin : loader.loaded(id)?.plugin;
    if (plugin) plugins.push(readonly && plugin.Toolbar ? { ...plugin, Toolbar: undefined } : plugin);
  }
  return plugins;
}

/** Stylesheet text of every loaded authoring plugin in `ids`. */
export function pluginStyles(ids: readonly WolfPluginId[], loader: PluginLoader = pluginLoader): string[] {
  return ids.filter(isLazyPlugin).flatMap((id) => loader.loaded(id)?.styles ?? []);
}

export type PluginSessionHost = {
  isCurrent(): boolean;
  adoptStyles(styles: readonly string[]): void;
  onUpdate(): void;
  reportError(error: { code: string; message: string; argument?: string }): void;
};

export type PluginSession = {
  /** Current plugins for `mode`, `attribute` and `readonly`, fetching any unloaded chunks once. */
  get(mode: WolfMode, attribute: string | null, readonly: boolean, host: PluginSessionHost): EditorPlugin[];
  /** Re-choose plugins on the next `get` (`mode`, `plugins` or `readonly` changed). */
  invalidate(): void;
  /** End the engine session: drop cached plugins, cancel in-flight callbacks and reset unknown-plugin reporting. */
  stop(): void;
};

export function createPluginSession(loader: PluginLoader = pluginLoader): PluginSession {
  let cached: EditorPlugin[] | null = null;
  let reportedUnknown = "";
  let seq = 0;
  const build = (ids: readonly WolfPluginId[], readonly: boolean, host: PluginSessionHost): EditorPlugin[] => {
    host.adoptStyles(pluginStyles(ids, loader));
    return selectPlugins(ids, readonly, loader);
  };
  return {
    get(mode, attribute, readonly, host) {
      if (cached) return cached;
      const { ids, unknown } = pluginIdsFor(mode, attribute);
      const key = unknown.join(" ");
      if (key && key !== reportedUnknown) {
        host.reportError({
          code: "plugin-unknown",
          message: `Unknown plugin "${unknown[0]}"; use any of: docs slides sheets review`,
          argument: key,
        });
      }
      reportedUnknown = key;
      const currentSeq = ++seq;
      const effectiveReadonly = readonly || mode === "review";
      const missing = missingPlugins(ids, loader);
      if (missing.length > 0) {
        const arrived = (): boolean => {
          if (currentSeq !== seq || !host.isCurrent()) return false;
          const next = build(ids, effectiveReadonly, host);
          const changed = cached === null || next.length !== cached.length;
          cached = next;
          if (changed) host.onUpdate();
          return true;
        };
        loader.load(missing).then(
          () => void arrived(),
          (cause: unknown) => {
            if (!arrived()) return;
            const failed = cause instanceof PluginLoadError;
            host.reportError({
              code: "plugin-load-failed",
              message: cause instanceof Error ? cause.message : String(cause),
              ...(failed ? { argument: cause.id } : {}),
            });
          },
        );
      }
      cached = build(ids, effectiveReadonly, host);
      return cached;
    },
    invalidate() {
      cached = null;
      seq++;
    },
    stop() {
      cached = null;
      reportedUnknown = "";
      seq++;
    },
  };
}
