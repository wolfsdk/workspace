/**
 * Build @wolfsdk/review into `dist/`, which is the package as published:
 * the Vite library build (element, worker, CSS), declarations for the public
 * entries (with the private workspace packages they reference copied in), the
 * README, the licence, the publish manifest and sizes. `--pack` also writes
 * the tarball to `pack/`.
 *
 *   bun scripts/build.ts [--pack]
 *
 * The workspace manifest (`package.json` next to this directory) points at the
 * sources and is private; `dist/package.json` is the manifest npm sees.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { entrySizes } from "./entry.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(pkgDir, "../..");
const dist = join(pkgDir, "dist");
const args = process.argv.slice(2);

/** The public entries: export path, bundle file, source file. */
const ENTRIES = [
  { path: ".", js: "wolf-review.js", src: "index" },
  { path: "./auto", js: "auto.js", src: "auto" },
  { path: "./react", js: "react.js", src: "react" },
  { path: "./protocol", js: "protocol.js", src: "protocol" },
  { path: "./seal", js: "seal.js", src: "seal" },
] as const;

/** Bare specifiers the published declarations may keep: the optional React peer. */
const ALLOWED_BARE = new Set(["react"]);

function run(command: string, argv: string[], cwd = pkgDir, allowFailure = false): string {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(output);
    throw new Error(`${command} ${argv.join(" ")} exited with ${result.status}`);
  }
  return output;
}

function bin(name: string): string {
  for (const dir of [pkgDir, webRoot]) {
    const path = join(dir, "node_modules/.bin", name);
    if (existsSync(path)) return path;
  }
  throw new Error(`${name} is not installed (run bun install in sdk/web)`);
}

// 1. JavaScript, worker and CSS.
process.stdout.write(run(bin("vite"), ["build"]));

// 2. Declarations. tsc emits every source file of the program (this package and the
// workspace packages it imports) under `dist/.types-tmp/packages/<dir>/`.
const tmp = join(dist, ".types-tmp");
const tsc = run(bin("tsc"), ["-p", "tsconfig.types.json"], pkgDir, true);
const diagnostics = tsc.split("\n").filter((line) => /error TS\d+/.test(line));
if (diagnostics.length) throw new Error(`type errors while emitting declarations:\n${diagnostics.join("\n")}`);

/** Workspace packages by name: directory and `exports` map. */
type Workspace = { dir: string; exports: Record<string, string> };
const workspaces = new Map<string, Workspace>();
for (const dir of readdirSync(join(webRoot, "packages"))) {
  const manifestPath = join(webRoot, "packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string; exports?: unknown };
  const exports: Record<string, string> = {};
  if (typeof manifest.exports === "string") exports["."] = manifest.exports;
  else if (manifest.exports && typeof manifest.exports === "object") {
    for (const [key, value] of Object.entries(manifest.exports)) if (typeof value === "string") exports[key] = value;
  }
  workspaces.set(manifest.name, { dir, exports });
}

/** The source file (relative to the web root) a workspace specifier names, or null. */
function workspaceTarget(specifier: string): string | null {
  const match = /^(@wolfsdk\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const workspace = workspaces.get(match[1]!);
  if (!workspace) return null;
  const sub = `.${match[2] ?? ""}`;
  let target = workspace.exports[sub];
  if (!target) {
    for (const [key, value] of Object.entries(workspace.exports)) {
      if (!key.endsWith("/*") || !sub.startsWith(key.slice(0, -1))) continue;
      target = value.replace("*", sub.slice(key.length - 1));
      break;
    }
  }
  if (!target) throw new Error(`${specifier} is not exported by ${match[1]}`);
  return posix.join("packages", workspace.dir, target);
}

/** The declaration file for a source path (relative to the web root, any of .ts/.tsx/.js), or null. */
function declarationOf(source: string): string | null {
  if (source.endsWith(".json")) return source;
  const base = source.replace(/\.(d\.ts|tsx?|jsx?|mjs)$/, "");
  for (const candidate of [`${base}.d.ts`, `${base}/index.d.ts`]) if (existsSync(join(tmp, candidate))) return candidate;
  return null;
}

/** `packages/<dir>/rest` (web-root relative) to its place under `dist/types/<dir>/rest`. */
function publishedPath(source: string): string {
  return join(dist, "types", source.replace(/^packages\//, ""));
}

const types = join(dist, "types");
rmSync(types, { recursive: true, force: true });
const SPECIFIER = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
/** A line of a doc comment or line comment: its specifiers are prose, not imports. */
const COMMENT_LINE = /^\s*(\*|\/\*|\/\/)/;
const queue = ENTRIES.map((entry) => `packages/review/src/${entry.src}.d.ts`);
const seen = new Set<string>();
const unresolved: string[] = [];
while (queue.length) {
  const file = queue.shift()!;
  if (seen.has(file)) continue;
  seen.add(file);
  const out = publishedPath(file);
  mkdirSync(dirname(out), { recursive: true });
  if (file.endsWith(".json")) {
    copyFileSync(join(webRoot, file), out);
    continue;
  }
  const rewrite = (line: string): string => {
    if (COMMENT_LINE.test(line)) return line;
    return line.replace(SPECIFIER, (all, lead: string, quote: string, spec: string) => {
      let target: string | null;
      if (spec.startsWith(".")) target = posix.join(posix.dirname(file), spec);
      else {
        target = workspaceTarget(spec);
        if (!target) {
          if (!ALLOWED_BARE.has(spec)) unresolved.push(`${file}: ${spec}`);
          return all;
        }
      }
      const declaration = declarationOf(target);
      if (!declaration) {
        unresolved.push(`${file}: ${spec} (no declaration for ${target})`);
        return all;
      }
      queue.push(declaration);
      let path = posix.relative(posix.dirname(file.replace(/^packages\//, "")), declaration.replace(/^packages\//, ""));
      if (!path.startsWith(".")) path = `./${path}`;
      if (!declaration.endsWith(".json")) path = path.replace(/\.d\.ts$/, ".js");
      return `${lead}${quote}${path}${quote}`;
    });
  };
  writeFileSync(out, readFileSync(join(tmp, file), "utf8").split("\n").map(rewrite).join("\n"));
}
rmSync(tmp, { recursive: true, force: true });
if (unresolved.length) throw new Error(`declarations reference modules a consumer cannot resolve:\n${unresolved.join("\n")}`);

// 3. Publish manifest, README and licence.
const workspaceManifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown> & {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
};
const typesOf = (src: string) => `./types/review/src/${src}.d.ts`;
const manifest = {
  name: workspaceManifest.name,
  version: workspaceManifest.version,
  description: workspaceManifest.description,
  license: workspaceManifest.license,
  repository: workspaceManifest.repository,
  type: "module",
  sideEffects: ["./auto.js", "./react.js", "./seal.js"],
  exports: {
    ...Object.fromEntries(ENTRIES.map((e) => [e.path, { types: typesOf(e.src), default: `./${e.js}` }])),
    "./wolf-review.css": "./wolf-review.css",
    "./package.json": "./package.json",
  },
  files: ["*.js", "*.css", "assets", "chunks", "types", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
  peerDependencies: workspaceManifest.peerDependencies,
  peerDependenciesMeta: workspaceManifest.peerDependenciesMeta,
};
writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(join(pkgDir, "README.md"), join(dist, "README.md"));
copyFileSync(join(pkgDir, "LICENSE"), join(dist, "LICENSE"));
copyFileSync(join(webRoot, "THIRD_PARTY_NOTICES.txt"), join(dist, "THIRD_PARTY_NOTICES.txt"));

// 4. Sizes (no engine module is part of the package).
const sizes: { file: string; raw: number; gzip: number }[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== types) walk(path);
    } else if (/\.(js|css)$/.test(name)) {
      const bytes = readFileSync(path);
      sizes.push({ file: relative(dist, path), raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
    }
  }
};
walk(dist);
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
for (const s of sizes) console.log(`${s.file.padEnd(40)} ${kib(s.raw).padStart(11)}  gzip ${kib(s.gzip).padStart(10)}`);
const total = sizes.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip }), { raw: 0, gzip: 0 });
console.log(`${"total".padEnd(40)} ${kib(total.raw).padStart(11)}  gzip ${kib(total.gzip).padStart(10)}`);
// What `<wolf-review mode="review">` fetches before it renders (wolf-review.js and its static imports) versus what loads on demand.
const entry = entrySizes(dist);
console.log(`${"review entry JS (eager)".padEnd(40)} ${"".padStart(11)}  gzip ${kib(entry.reviewEntryJsGzip).padStart(10)}`);
console.log(`${"review entry + external CSS".padEnd(40)} ${"".padStart(11)}  gzip ${kib(entry.reviewEntryWithExternalCssGzip).padStart(10)}`);
console.log(`${"authoring chunks (on demand)".padEnd(40)} ${"".padStart(11)}  gzip ${kib(entry.authoringChunksGzip).padStart(10)}`);
// Kept next to the build for size tracking; not in `files`, so not packed.
writeFileSync(join(dist, "sizes.json"), `${JSON.stringify({ files: sizes, total, ...entry }, null, 2)}\n`);

// 5. Tarball.
if (args.includes("--pack")) {
  const packDir = join(pkgDir, "pack");
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  process.stdout.write(run("bun", ["pm", "pack", "--destination", resolve(packDir)], dist));
  const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one tarball in ${packDir}, found ${tarballs.join(", ")}`);
  console.log(`packed ${relative(pkgDir, join(packDir, tarballs[0]!))}`);
}
