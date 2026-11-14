/**
 * What a page fetches to mount `<wolf-review mode="review">`, measured on a built package
 * (`dist/` or the unpacked tarball). Shared by `build.ts` (which writes `sizes.json`) and
 * `check.ts` (which enforces the budget on the tarball).
 *
 * The entry is `wolf-review.js` and every module it reaches through a static `import` or
 * `export ... from`: those load before the element renders. A dynamic `import()` is not part of it:
 * the authoring plugin chunks (docs, slides, sheets) are fetched on demand. The engine worker
 * (`assets/`) and the separate entries (`auto.js`, `react.js`, `protocol.js`, `seal.js`) are
 * reported apart, since a page does not fetch them as part of the element's own code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { gzipSync } from "node:zlib";

/** The file a page imports to get the element. */
export const REVIEW_ENTRY = "wolf-review.js";

/** The authoring plugins, each its own chunk under `chunks/` (named by the build config). */
export const AUTHORING_PLUGINS = ["docs", "slides", "sheets"] as const;

const PLUGIN_CHUNK = /^chunks\/plugin-(docs|slides|sheets)-[A-Za-z0-9_-]+\.js$/;

/**
 * A statically loaded relative module: `import x from "./a.js"`, `import "./a.js"`,
 * `export { x } from "./a.js"`, in any of the quote styles the minifier writes. `import("./a.js")`
 * does not match: after `import` comes `(`, which the clause pattern excludes.
 */
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^'"`();]*?\bfrom\s*)?(["'`])(\.{1,2}\/[^"'`]+)\1/g;

/** The relative specifiers `code` loads at once, in order of appearance. */
export function staticImports(code: string): string[] {
  return [...code.matchAll(STATIC_IMPORT)].map((m) => m[2]!);
}

/** A relative module loaded on demand: `import("./a.js")` with a string literal (the minifier writes a template literal). */
const DYNAMIC_IMPORT = /\bimport\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*\)/g;

/** The relative specifiers `code` loads with `import()`, in order of appearance. */
export function dynamicImports(code: string): string[] {
  return [...code.matchAll(DYNAMIC_IMPORT)].map((m) => m[2]!);
}

/** Every `.js` and `.css` file under `root`, as posix paths relative to it. */
export function codeFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|css)$/.test(name)) out.push(relative(root, path).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * `entry` and every file it loads statically, by path relative to `root` (entry first, then
 * breadth first). Throws when a static import names a file that is not in the package: the
 * accounting would otherwise silently miss it.
 */
export function staticClosure(root: string, entry: string = REVIEW_ENTRY): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    order.push(file);
    let code: string;
    try {
      code = readFileSync(join(root, file), "utf8");
    } catch {
      throw new Error(`${file} is statically imported but is not in the package`);
    }
    for (const specifier of staticImports(code)) queue.push(posix.join(posix.dirname(file), specifier));
  }
  return order;
}

export const gzipOf = (root: string, file: string): number => gzipSync(readFileSync(join(root, file)), { level: 9 }).length;

export type EntrySizes = {
  /** Gzipped `wolf-review.js` plus the shared chunks it imports statically: the code fetched before the element renders. The stylesheet is inlined into `wolf-review.js`, so it is already in here. */
  reviewEntryJsGzip: number;
  /** Gzipped `wolf-review.css`, the same stylesheet as a file for consumers that load it themselves. */
  reviewCssGzip: number;
  /** `reviewEntryJsGzip + reviewCssGzip`: the entry when its CSS is fetched as a separate file too. */
  reviewEntryWithExternalCssGzip: number;
  /** Gzipped chunks fetched on demand (the authoring plugins and anything only they share). */
  authoringChunksGzip: number;
  /** Gzipped engine worker under `assets/`, fetched when an engine starts. */
  engineWorkerGzip: number;
  /** The files of the entry, each with its gzipped size. */
  reviewEntryFiles: { file: string; gzip: number }[];
  /** The on-demand chunks, each with its gzipped size. */
  authoringChunks: { file: string; gzip: number }[];
};

/** Entry accounting of the built package at `root`. */
export function entrySizes(root: string): EntrySizes {
  const all = codeFilesUnder(root);
  const closure = staticClosure(root);
  const inEntry = new Set(closure);
  const sized = (files: string[]) => files.map((file) => ({ file, gzip: gzipOf(root, file) }));
  const sum = (items: { gzip: number }[]) => items.reduce((n, i) => n + i.gzip, 0);
  const reviewEntryFiles = sized(closure);
  const authoringChunks = sized(all.filter((f) => f.startsWith("chunks/") && !inEntry.has(f)));
  const reviewEntryJsGzip = sum(reviewEntryFiles);
  const reviewCssGzip = gzipOf(root, "wolf-review.css");
  return {
    reviewEntryJsGzip,
    reviewCssGzip,
    reviewEntryWithExternalCssGzip: reviewEntryJsGzip + reviewCssGzip,
    authoringChunksGzip: sum(authoringChunks),
    engineWorkerGzip: sum(sized(all.filter((f) => f.startsWith("assets/")))),
    reviewEntryFiles,
    authoringChunks,
  };
}

/** The packed chunk files of each authoring plugin (paths relative to the package root); an empty list means it is not packed. */
export function pluginChunks(files: readonly string[]): Record<(typeof AUTHORING_PLUGINS)[number], string[]> {
  const out: Record<(typeof AUTHORING_PLUGINS)[number], string[]> = { docs: [], slides: [], sheets: [] };
  for (const file of files) {
    const match = PLUGIN_CHUNK.exec(file);
    if (match) out[match[1] as (typeof AUTHORING_PLUGINS)[number]].push(file);
  }
  return out;
}
