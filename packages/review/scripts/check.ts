/**
 * Build and pack @wolfsdk/review, then check the tarball as a consumer gets it:
 *
 * - the file list: every export target present; an MIT `LICENSE`; no engine module
 *   (`.wasm`), source map or TypeScript source;
 * - the engine source: the packed code loads the module from the wolfsdk.com channel
 *   by default;
 * - the entry: the authoring plugins (docs, slides, sheets) are separate chunks that the entry
 *   loads with `import()`, never statically, and the code `<wolf-review mode="review">` fetches
 *   up front (`wolf-review.js` and its static imports, gzipped) stays within
 *   `REVIEW_ENTRY_JS_GZIP_MAX`;
 * - the manifest: public, no workspace or bundled dependencies;
 * - the text: no workspace specifier left unresolved, no old package names,
 *   no absolute machine paths;
 * - `protocol.js` runs without a DOM and names the current contracts;
 * - the declarations typecheck in a consumer project (strict, no skipLibCheck).
 *
 *   bun scripts/check.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUTHORING_PLUGINS, dynamicImports, entrySizes, pluginChunks, type EntrySizes } from "./entry.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(pkgDir, "../..");
const packDir = join(pkgDir, "pack");
const problems: string[] = [];

/**
 * Budget for the code a page fetches before `<wolf-review mode="review">` renders: `wolf-review.js`
 * plus the shared chunks it imports statically, gzipped (level 9). The stylesheet is inlined into
 * `wolf-review.js`, so it counts here; `wolf-review.css` (the same text as a file) does not.
 * Before the plugins were split out this was about 191 KiB; it is about 101 KiB now, and the
 * limit leaves room for ordinary growth, not for a plugin moving back into the entry.
 */
const REVIEW_ENTRY_JS_GZIP_MAX = 108 * 1024;
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

function run(command: string, argv: string[], cwd = pkgDir): { ok: boolean; output: string } {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function must(command: string, argv: string[], cwd = pkgDir): string {
  const { ok, output } = run(command, argv, cwd);
  if (!ok) {
    process.stderr.write(output);
    throw new Error(`${command} ${argv.join(" ")} failed`);
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

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

// 1. Build and pack.
process.stdout.write(must("bun", ["scripts/build.ts", "--pack"]));
const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (!tarball) throw new Error("no tarball in pack/");
const unpacked = join(packDir, "unpacked");
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
must("tar", ["-xzf", join(packDir, tarball), "-C", unpacked]);
const root = join(unpacked, "package");
const files = filesUnder(root).map((path) => relative(root, path));

// 2. File list.
for (const file of files) {
  if (file.endsWith(".wasm")) problems.push(`engine module in the package: ${file}`);
  if (file.endsWith(".map")) problems.push(`source map in the package: ${file}`);
  if (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")) problems.push(`TypeScript source in the package: ${file}`);
}
for (const required of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt", "wolf-review.css"]) {
  if (!files.includes(required)) problems.push(`missing ${required}`);
}
if (files.includes("LICENSE") && !readFileSync(join(root, "LICENSE"), "utf8").startsWith("MIT License"))
  problems.push("LICENSE is not the MIT licence text");

/** Resolve an installed npm package directory from the declaring package, workspace, or root node_modules. */
function resolveInstalledPackage(pkgName: string, fromDir?: string): string | null {
  const workspacePackageDirs = readdirSync(join(webRoot, "packages")).map((name) => join(webRoot, "packages", name));
  const searchBases = [...(fromDir ? [fromDir] : []), pkgDir, webRoot, ...workspacePackageDirs];
  for (const base of searchBases) {
    const candidate = join(base, "node_modules", pkgName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (existsSync(base)) {
      let cur = realpathSync(base);
      while (cur && cur !== dirname(cur)) {
        if (basename(cur) === "node_modules") {
          const inNodeModules = join(cur, pkgName);
          if (existsSync(join(inNodeModules, "package.json"))) return inNodeModules;
        }
        const nested = join(cur, "node_modules", pkgName);
        if (existsSync(join(nested, "package.json"))) return nested;
        cur = dirname(cur);
      }
    }
  }
  return null;
}

/** Collect every npm dependency bundled into @wolfsdk/review mapped to the directory that declared it. */
function collectBundledPackages(): Map<string, string> {
  const workspaceDirs = new Map<string, string>();
  for (const name of readdirSync(join(webRoot, "packages"))) {
    const dir = join(webRoot, "packages", name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
    if (pkg.name) workspaceDirs.set(pkg.name, dir);
  }
  const bundled = new Map<string, string>();
  const visitedWorkspaces = new Set<string>();
  const wsQueue = ["@wolfsdk/review"];
  while (wsQueue.length) {
    const wsName = wsQueue.shift()!;
    if (visitedWorkspaces.has(wsName)) continue;
    visitedWorkspaces.add(wsName);
    const wsDir = workspaceDirs.get(wsName);
    if (!wsDir) continue;
    const pkg = JSON.parse(readFileSync(join(wsDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (range.startsWith("workspace:") || dep.startsWith("@wolfsdk/")) {
        wsQueue.push(dep);
      } else if (!bundled.has(dep)) {
        bundled.set(dep, wsDir);
      }
    }
  }
  const pkgQueue = [...bundled.keys()];
  while (pkgQueue.length) {
    const dep = pkgQueue.shift()!;
    const dir = resolveInstalledPackage(dep, bundled.get(dep));
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const sub of Object.keys(pkg.dependencies ?? {})) {
      if (!bundled.has(sub)) {
        bundled.set(sub, dir);
        pkgQueue.push(sub);
      }
    }
  }
  return new Map([...bundled.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Verify that `noticesText` records the version header and every license file of each bundled package. */
function checkBundledNotices(noticesText: string, bundledPackages: ReadonlyMap<string, string>): string[] {
  const missing: string[] = [];
  for (const [pkgName, fromDir] of bundledPackages) {
    const dir = resolveInstalledPackage(pkgName, fromDir);
    if (!dir) {
      missing.push(`bundled dependency ${pkgName} is not installed in node_modules`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    const header = `${pkgName} ${pkg.version ?? ""}`.trim();
    if (!noticesText.includes(header)) {
      missing.push(`THIRD_PARTY_NOTICES.txt has no notice header for bundled dependency ${header}`);
      continue;
    }
    const licenseFiles = readdirSync(dir)
      .filter((entry) => /^(LICENSE|LICENCE|COPYING)([._-].*)?$/i.test(entry))
      .sort();
    if (!licenseFiles.length) {
      missing.push(`bundled dependency ${header} has no LICENSE file in ${dir}`);
      continue;
    }
    for (const licenseFile of licenseFiles) {
      const licenseBody = readFileSync(join(dir, licenseFile), "utf8").trim();
      if (!noticesText.includes(licenseBody)) {
        missing.push(`THIRD_PARTY_NOTICES.txt is missing the verbatim ${licenseFile} text of ${header}`);
      }
    }
  }
  return missing;
}

const bundledPackages = collectBundledPackages();
if (files.includes("THIRD_PARTY_NOTICES.txt")) {
  const packedNotices = readFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), "utf8");
  const repoNotices = readFileSync(join(webRoot, "THIRD_PARTY_NOTICES.txt"), "utf8");
  if (packedNotices !== repoNotices) {
    problems.push("packed THIRD_PARTY_NOTICES.txt differs from sdk/web/THIRD_PARTY_NOTICES.txt");
  }
  problems.push(...checkBundledNotices(packedNotices, bundledPackages));
  // Self-check that omitting any bundled dependency causes checkBundledNotices to fail.
  for (const [pkgName, fromDir] of bundledPackages) {
    const dir = resolveInstalledPackage(pkgName, fromDir);
    if (!dir) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    const stripped = packedNotices.replaceAll(`${pkgName} ${pkg.version ?? ""}`.trim(), "");
    if (checkBundledNotices(stripped, bundledPackages).length === 0) {
      problems.push(`checkBundledNotices did not fail when ${pkgName} was removed from THIRD_PARTY_NOTICES.txt`);
    }
  }
}
// The wrapper ships without the engine, so the default it loads from is part of the package contract.
const DEFAULT_CHANNEL = "https://wolfsdk.com/download/wolf";
const packedCode = files.filter((file) => file.endsWith(".js")).map((file) => readFileSync(join(root, file), "utf8"));
if (!packedCode.some((text) => text.includes(DEFAULT_CHANNEL)))
  problems.push(`no packed module names the default engine channel ${DEFAULT_CHANNEL}`);

// 2b. The entry and its lazy chunks. A page that mounts `<wolf-review mode="review">` fetches
// `wolf-review.js` and its static imports; each authoring plugin must be one packed chunk outside
// that set, reached by an `import()`, and every `import()` in the package must name a packed file.
const PACKED_JS = files.filter((file) => file.endsWith(".js"));
for (const file of PACKED_JS) {
  const base = posix.dirname(file);
  for (const specifier of dynamicImports(readFileSync(join(root, file), "utf8"))) {
    if (!files.includes(posix.join(base, specifier))) problems.push(`${file} imports ${specifier} with import(), which is not in the package`);
  }
}
let entry: EntrySizes | null = null;
try {
  entry = entrySizes(root);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}
if (entry) {
  const eager = entry.reviewEntryFiles.map((item) => item.file);
  const lazyTargets = new Set(
    eager.flatMap((file) =>
      dynamicImports(readFileSync(join(root, file), "utf8")).map((specifier) => posix.join(posix.dirname(file), specifier)),
    ),
  );
  const chunks = pluginChunks(files);
  for (const id of AUTHORING_PLUGINS) {
    if (chunks[id].length !== 1) {
      problems.push(`the ${id} plugin is ${chunks[id].length} packed chunks, expected one chunks/plugin-${id}-<hash>.js`);
    }
    for (const file of chunks[id]) {
      if (eager.includes(file)) problems.push(`${file} is loaded statically by the review entry; it must load on demand`);
      else if (!lazyTargets.has(file)) problems.push(`nothing in the review entry imports ${file} with import()`);
    }
  }
  if (entry.reviewEntryJsGzip > REVIEW_ENTRY_JS_GZIP_MAX) {
    const parts = entry.reviewEntryFiles.map((item) => `${item.file} ${kib(item.gzip)}`).join(", ");
    problems.push(
      `the review entry is ${kib(entry.reviewEntryJsGzip)} gzipped (${parts}); the budget is ${kib(REVIEW_ENTRY_JS_GZIP_MAX)}`,
    );
  }
  // `sizes.json` is what the build recorded; it must say what the tarball holds.
  const recorded = JSON.parse(readFileSync(join(pkgDir, "dist/sizes.json"), "utf8")) as Partial<EntrySizes>;
  for (const key of ["reviewEntryJsGzip", "reviewCssGzip", "reviewEntryWithExternalCssGzip", "authoringChunksGzip"] as const) {
    if (recorded[key] !== entry[key]) problems.push(`dist/sizes.json ${key} is ${recorded[key]}, the packed files measure ${entry[key]}`);
  }
}

// 3. Manifest.
type Manifest = {
  name: string;
  private?: boolean;
  license?: string;
  exports: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
};
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
if (manifest.name !== "@wolfsdk/review") problems.push(`package name is ${manifest.name}`);
if (manifest.private) problems.push("the published manifest is private");
if (manifest.license !== "MIT") problems.push(`licence is ${manifest.license}`);
if (manifest.dependencies && Object.keys(manifest.dependencies).length)
  problems.push(`published dependencies: ${Object.keys(manifest.dependencies).join(", ")}`);
for (const [path, target] of Object.entries(manifest.exports)) {
  const targets = typeof target === "string" ? [target] : Object.values(target);
  for (const file of targets) if (!existsSync(join(root, file))) problems.push(`export ${path} names missing ${file}`);
}

// 4. Text. Workspace specifiers count only in code: comment lines and the README name packages in prose.
const WORKSPACE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']@wolfsdk\/(?!review\b)/;
const COMMENT_LINE = /^\s*(\*|\/\*|\/\/)/;
const FORBIDDEN: [RegExp, string][] = [
  [/wolf[\s_-]?editor/i, "old package or element name"],
  [/\/(Users|home)\/[A-Za-z0-9_.-]+\//, "absolute machine path"],
];
const excerpt = (text: string, index: number) => JSON.stringify(text.slice(Math.max(0, index - 40), index + 60));
for (const file of files) {
  if (!/\.(js|css|d\.ts|json|md)$/.test(file)) continue;
  const text = readFileSync(join(root, file), "utf8");
  for (const [pattern, what] of FORBIDDEN) {
    const match = pattern.exec(text);
    if (match) problems.push(`${what} in ${file}: ${excerpt(text, match.index)}`);
  }
  if (!/\.(js|d\.ts)$/.test(file)) continue;
  const declarations = file.endsWith(".d.ts");
  for (const line of text.split("\n")) {
    if (declarations && COMMENT_LINE.test(line)) continue;
    const match = WORKSPACE_SPECIFIER.exec(line);
    if (match) problems.push(`unresolved workspace specifier in ${file}: ${excerpt(line, match.index)}`);
  }
}
// The README and licence are read by people outside the project: no em or en dashes.
for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
  if (!files.includes(file)) continue;
  const text = readFileSync(join(root, file), "utf8");
  const match = /[\u2013\u2014]/.exec(text);
  if (match) problems.push(`dash character in ${file}: ${excerpt(text, match.index)}`);
}

// 5. The protocol entry without a DOM.
// Dynamic: the module is the bundle this script just built and unpacked.
const protocol = (await import(pathToFileURL(join(root, "protocol.js")).href)) as Record<string, unknown>;
if (protocol.SESSION_CONTRACT !== "wolfsdk.review-session.v1")
  problems.push(`protocol.js SESSION_CONTRACT is ${String(protocol.SESSION_CONTRACT)}`);
if (protocol.DECISION_CONTRACT !== "wolfsuite.review-decision.v1")
  problems.push(`protocol.js DECISION_CONTRACT is ${String(protocol.DECISION_CONTRACT)}`);

// 6. Declarations in a consumer project. It sits under this package so `@types/react` resolves.
const consumer = join(packDir, "consumer");
rmSync(consumer, { recursive: true, force: true });
mkdirSync(join(consumer, "node_modules/@wolfsdk"), { recursive: true });
symlinkSync(root, join(consumer, "node_modules/@wolfsdk/review"), "dir");
// Its own package scope: without one, `@wolfsdk/review` self-resolves to this workspace
// package's sources instead of the unpacked tarball.
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    files: ["consumer.ts"],
  }),
);
writeFileSync(
  join(consumer, "consumer.ts"),
  `import { defineWolfReview, KernelRequestError, WolfReviewElement, type EngineSource, type WolfReviewSubmitDetail } from "@wolfsdk/review";
import "@wolfsdk/review/auto";
import { WolfReview, type WolfReviewProps } from "@wolfsdk/review/react";
import { SESSION_CONTRACT, validateSession } from "@wolfsdk/review/protocol";
import * as seal from "@wolfsdk/review/seal";

const ctor: typeof WolfReviewElement = defineWolfReview();
const element: WolfReviewElement = document.createElement("wolf-review");
element.addEventListener("wolf-ready", (event) => {
  const version: string | null = event.detail.version;
  void version;
});
element.addEventListener("wolf-review-submit", (event) => {
  const detail: WolfReviewSubmitDetail = event.detail;
  void detail;
});
const source: EngineSource = { channel: "https://example.com/wolf", version: "1.0.0" };
element.engine = source;
const props: WolfReviewProps = { engineVersion: "1.0.0", mode: "review", onError: (event) => void event.detail.code };
void [ctor, KernelRequestError, WolfReview, props, SESSION_CONTRACT, validateSession, seal];
`,
);
const typecheck = run(bin("tsc"), ["-p", consumer]);
if (!typecheck.ok) problems.push(`consumer typecheck failed:\n${typecheck.output}`);

if (problems.length) {
  console.error(`@wolfsdk/review package check failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
rmSync(unpacked, { recursive: true, force: true });
rmSync(consumer, { recursive: true, force: true });
console.log(
  `@wolfsdk/review package check passed: ${files.length} files in ${tarball}; review entry ${kib(entry!.reviewEntryJsGzip)} gzipped (budget ${kib(REVIEW_ENTRY_JS_GZIP_MAX)})`,
);
