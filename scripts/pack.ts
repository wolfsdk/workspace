#!/usr/bin/env bun
/**
 * Pack the server-side Wolf Workspace packages for npm.
 *
 *   bun scripts/pack.ts            stage each package, write its tarball and SHA256SUMS to pack/
 *   bun scripts/pack.ts --check    also refuse the tarballs unless they work from a clean install
 *
 * These packages ship TypeScript source and run on Bun; nothing is compiled. A published package
 * is its `src/` (and `schemas/`), its README and licence, and a publish manifest derived from the
 * workspace one: `private` and `scripts` dropped, each `workspace:*` dependency pinned to the
 * version of that package. `@wolfsdk/workspace` also carries the compiled UI
 * (`apps/workspace/dist`) as `ui/`, so build the UI first (`bun run build`).
 *
 * `@wolfsdk/review` has its own build (packages/review/scripts). `@wolfsdk/runtime` is not
 * published on its own: the review element and the UI bundle what they use of it.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const webRoot = resolve(import.meta.dir, "..");
const packDir = join(webRoot, "pack");
const REPOSITORY = "https://github.com/wolfsdk/workspace";
const BUN_RANGE = ">=1.4.0";

/** Directories under `packages/`, each before the packages that depend on it. */
const PACKAGES = ["protocol", "server", "mcp", "packs", "workspace-cli"] as const;

interface WorkspaceManifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  sideEffects?: boolean;
  bin?: Record<string, string>;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
}

interface Packed {
  dir: string;
  name: string;
  version: string;
  tarball: string;
}

function run(command: string, args: string[], cwd: string): string {
  const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${output}`);
  return output;
}

const readManifest = (dir: string): WorkspaceManifest =>
  JSON.parse(readFileSync(join(webRoot, "packages", dir, "package.json"), "utf8")) as WorkspaceManifest;

const manifests = new Map(PACKAGES.map((dir) => [dir, readManifest(dir)]));
const versionOf = new Map([...manifests.values()].map((m) => [m.name, m.version]));

/** Copy what ships of one package into `out` and write its publish manifest. */
function stage(dir: (typeof PACKAGES)[number], out: string): void {
  const pkgDir = join(webRoot, "packages", dir);
  const source = manifests.get(dir)!;
  const missing = (["description", "license"] as const).filter((field) => !source[field]);
  if (missing.length) throw new Error(`${source.name}: package.json has no ${missing.join(" or ")}`);

  const files = ["src", "README.md", "LICENSE"];
  cpSync(join(pkgDir, "src"), join(out, "src"), { recursive: true });
  if (existsSync(join(pkgDir, "schemas"))) {
    cpSync(join(pkgDir, "schemas"), join(out, "schemas"), { recursive: true });
    files.push("schemas");
  }
  if (!existsSync(join(pkgDir, "README.md"))) throw new Error(`${source.name}: no README.md`);
  cpSync(join(pkgDir, "README.md"), join(out, "README.md"));
  // A package with its own terms carries its own licence file; the others are under the root Apache-2.0 text.
  if (existsSync(join(pkgDir, "LICENSE"))) cpSync(join(pkgDir, "LICENSE"), join(out, "LICENSE"));
  else if (source.license === "Apache-2.0") cpSync(join(webRoot, "LICENSE"), join(out, "LICENSE"));
  else throw new Error(`${source.name}: licence ${source.license} needs a LICENSE file in packages/${dir}`);

  if (dir === "workspace-cli") {
    const ui = join(webRoot, "apps", "workspace", "dist");
    if (!existsSync(join(ui, "index.html"))) throw new Error("the workspace UI is not built: run `bun run build` first");
    cpSync(ui, join(out, "ui"), { recursive: true });
    // The UI bundle contains third-party code.
    cpSync(join(webRoot, "THIRD_PARTY_NOTICES.txt"), join(out, "THIRD_PARTY_NOTICES.txt"));
    files.push("ui", "THIRD_PARTY_NOTICES.txt");
  }

  const dependencies = Object.fromEntries(
    Object.entries(source.dependencies ?? {}).map(([name, range]) => {
      if (!range.startsWith("workspace:")) return [name, range];
      const version = versionOf.get(name);
      if (version === undefined) throw new Error(`${source.name} depends on ${name}, which is not published`);
      return [name, version];
    }),
  );
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    repository: { type: "git", url: `git+${REPOSITORY}.git`, directory: `packages/${dir}` },
    homepage: `${REPOSITORY}/tree/main/packages/${dir}#readme`,
    bugs: `${REPOSITORY}/issues`,
    type: "module",
    sideEffects: source.sideEffects,
    engines: { bun: BUN_RANGE },
    bin: source.bin,
    exports: { ...source.exports, "./package.json": "./package.json" },
    files,
    dependencies: Object.keys(dependencies).length ? dependencies : undefined,
  };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function pack(): Packed[] {
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  // Staged outside the checkout: its .gitignore names `pack/`, and a packer honours ignore files above it.
  const stageRoot = mkdtempSync(join(tmpdir(), "wolfsdk-pack-"));
  try {
    return PACKAGES.map((dir) => {
      const out = join(stageRoot, dir);
      mkdirSync(out, { recursive: true });
      stage(dir, out);
      const before = new Set(readdirSync(packDir));
      run("bun", ["pm", "pack", "--destination", packDir], out);
      const made = readdirSync(packDir).filter((f) => f.endsWith(".tgz") && !before.has(f));
      if (made.length !== 1) throw new Error(`expected one new tarball for ${dir}, found ${made.join(", ") || "none"}`);
      const { name, version } = manifests.get(dir)!;
      return { dir, name, version, tarball: made[0]! };
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function writeDigests(packed: Packed[]): void {
  const lines = packed.map(({ tarball }) => {
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(packDir, tarball))).digest("hex");
    return `${digest}  ${tarball}`;
  });
  writeFileSync(join(packDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** What is wrong with one unpacked tarball. */
function inspect(pkg: Packed, root: string): string[] {
  const problems: string[] = [];
  const files = walk(root).map((path) => relative(root, path));
  const has = (path: string) => files.includes(path.replace(/^\.\//, ""));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown> & {
    bin?: Record<string, string>;
    exports: Record<string, string>;
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };

  for (const required of ["README.md", "LICENSE"]) if (!has(required)) problems.push(`no ${required}`);
  if ("private" in manifest) problems.push("the manifest is private");
  if ("scripts" in manifest) problems.push("the manifest has scripts");
  if (manifest.engines?.bun !== BUN_RANGE) problems.push("the manifest does not name the Bun it runs on");
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith("@wolfsdk/") && range !== versionOf.get(name)) problems.push(`${name} is ${range}, not a packed version`);
  }
  for (const file of files) {
    if (/\.(wasm|map|node|dylib|so|dll|exe|zip|tgz|gz|sqlite|db)$/.test(file)) problems.push(`binary or archive in the package: ${file}`);
    if (/(^|\/)test\/|\.test\.ts$/.test(file)) problems.push(`test file in the package: ${file}`);
  }
  for (const [key, target] of Object.entries(manifest.exports)) {
    const found = target.includes("*") ? files.some((file) => `./${file}`.startsWith(target.slice(0, target.indexOf("*")))) : has(target);
    if (!found) problems.push(`export ${key} points at ${target}, which is not in the package`);
  }
  for (const [command, target] of Object.entries(manifest.bin ?? {})) {
    if (!has(target)) problems.push(`bin ${command} points at ${target}, which is not in the package`);
    else if (!readFileSync(join(root, target), "utf8").startsWith("#!/usr/bin/env bun\n")) problems.push(`bin ${command} has no Bun shebang`);
  }
  for (const file of files) {
    if (/\.(png|jpg|woff2?|ico)$/.test(file)) continue;
    if (/\/(Users|home)\/[A-Za-z0-9_.-]+\//.test(readFileSync(join(root, file), "utf8"))) problems.push(`machine path in ${file}`);
  }
  return problems.map((problem) => `${pkg.name}: ${problem}`);
}

/** The compiler options `bun init` gives a new project: a consumer's tsc checks this source under them. */
const CONSUMER_COMPILER_OPTIONS = {
  lib: ["ESNext"],
  target: "ESNext",
  module: "Preserve",
  moduleDetection: "force",
  moduleResolution: "bundler",
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  noFallthroughCasesInSwitch: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  resolveJsonModule: true,
  types: ["bun"],
  typeRoots: [join(webRoot, "node_modules", "@types")],
};

/** Install the tarballs into an empty project and use them the way a consumer does. */
async function useFromCleanInstall(packed: Packed[]): Promise<string[]> {
  const problems: string[] = [];
  const consumer = mkdtempSync(join(tmpdir(), "wolfsdk-consumer-"));
  try {
    // Each package resolves the others from these tarballs, not from the registry.
    const fromTarball = Object.fromEntries(packed.map((pkg) => [pkg.name, `file:${join(packDir, pkg.tarball)}`]));
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "consumer", private: true, type: "module", dependencies: fromTarball, overrides: fromTarball }, null, 2)}\n`,
    );
    run("bun", ["install"], consumer);

    for (const pkg of packed) problems.push(...inspect(pkg, join(consumer, "node_modules", pkg.name)));

    // Every entry imports and type-checks.
    const entries = packed.flatMap((pkg) =>
      Object.keys(manifests.get(pkg.dir as (typeof PACKAGES)[number])!.exports)
        .filter((key) => !key.includes("*"))
        .map((key) => `${pkg.name}${key.slice(1)}`),
    );
    writeFileSync(join(consumer, "entries.ts"), `${entries.map((entry) => `import ${JSON.stringify(entry)};`).join("\n")}\n`);
    writeFileSync(join(consumer, "tsconfig.json"), `${JSON.stringify({ compilerOptions: CONSUMER_COMPILER_OPTIONS, include: ["entries.ts"] }, null, 2)}\n`);
    for (const [what, command, args] of [
      ["import", "bun", ["entries.ts"]],
      ["type-check", join(webRoot, "node_modules", ".bin", "tsc"), ["-p", "."]],
    ] as const) {
      try {
        run(command, [...args], consumer);
      } catch (e) {
        problems.push(`the entries do not ${what} in a consumer project:\n${(e as Error).message}`);
      }
    }

    // The command line runs, and `serve` answers with the packed UI. The engine is started only when a
    // document is opened, so this needs none.
    const cli = join(consumer, "node_modules", ".bin", "wolfsdk-workspace");
    try {
      if (!run(cli, ["help"], consumer).includes("wolfsdk-workspace serve")) problems.push("`wolfsdk-workspace help` does not list serve");
    } catch (e) {
      problems.push(`\`wolfsdk-workspace help\` failed:\n${(e as Error).message}`);
    }
    writeFileSync(join(consumer, "actors.json"), JSON.stringify({ "check-token": { kind: "user", id: "check", name: "Check" } }));
    mkdirSync(join(consumer, "blobs"));
    const serve = Bun.spawn(
      [cli, "serve", "--db", "rooms.sqlite", "--blobs", "blobs", "--engine", process.execPath, "--actors", "actors.json", "--port", "0"],
      { cwd: consumer, stdout: "pipe", stderr: "pipe" },
    );
    try {
      let output = "";
      const decoder = new TextDecoder();
      const deadline = AbortSignal.timeout(20_000);
      for await (const chunk of serve.stdout) {
        output += decoder.decode(chunk);
        if (/^mcp /m.test(output) || deadline.aborted) break;
      }
      const url = /^workspace (http:\S+)/m.exec(output)?.[1];
      if (url === undefined) {
        problems.push(`\`wolfsdk-workspace serve\` did not serve the packed UI:\n${output}${await new Response(serve.stderr).text()}`);
      } else {
        const health = await fetch(new URL("/api/health", url));
        if (!health.ok) problems.push(`GET /api/health answered ${health.status}`);
        const page = await fetch(url);
        if (!page.ok || !(await page.text()).toLowerCase().includes("<!doctype html")) problems.push(`GET ${new URL(url).pathname} did not return the UI`);
      }
    } finally {
      serve.kill();
      await serve.exited;
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
  return problems;
}

const packed = pack();
writeDigests(packed);
for (const pkg of packed) console.log(`packed ${pkg.name}@${pkg.version}  pack/${pkg.tarball}`);

if (process.argv.includes("--check")) {
  const problems = await useFromCleanInstall(packed);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`checked ${packed.length} packages from a clean install`);
}
