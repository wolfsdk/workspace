// What the open-core app must never contain: engine binaries, source maps, office archives, machine-specific
// paths, private names, the retired editor product, em dashes. And what it must declare: its licence and its
// dependencies. This file is skipped by the scan because it names the things it looks for.
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

interface Manifest {
  name?: string;
  license?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
}

const ROOT = join(import.meta.dir, "..");
const SELF = basename(import.meta.path);

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.name !== SELF) found.push(path);
  }
  return found;
}

const listing = await files(ROOT);
const text = await Promise.all(listing.map(async (path) => ({ path: relative(ROOT, path), content: await readFile(path, "utf8") })));
const manifest: Manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

describe("the workspace app", () => {
  test("is Apache-2.0 and private until it is published on purpose", () => {
    expect(manifest.name).toBe("@wolfsdk/workspace-app");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.private).toBe(true);
  });

  test("ships no engine binary, source map, database or archive", () => {
    const banned = /\.(wasm|map|sqlite|db|node|dylib|so|dll|exe|zip|tgz|gz|xlsx|docx|pptx|pdf)$/;
    expect(listing.filter((path) => banned.test(path)).map((path) => relative(ROOT, path))).toEqual([]);
  });

  // Private host names are the export guard's to check (scripts/export_wolfsdk_workspace.py): naming them here
  // would put them in the export.
  test("names no machine path, private repository or retired editor product", () => {
    const banned = [
      /\/Users\/|\/home\/|C:\\\\Users/,
      /wolfiesch\/wolfsuite|SynthGL\/wolfxl/i,
      /wolf[\s_-]?editor/i,
    ];
    expect(text.filter(({ content }) => banned.some((re) => re.test(content))).map(({ path }) => path)).toEqual([]);
  });

  test("has no em dash anywhere", () => {
    expect(text.filter(({ content }) => content.includes("\u2014")).map(({ path }) => path)).toEqual([]);
  });

  test("depends only on the frozen protocol, the review element, the runtime room client and Preact", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@wolfsdk/protocol", "@wolfsdk/review", "@wolfsdk/runtime", "preact"]);
  });

  test("formats every time it shows through the Pacific 12-hour formatter", () => {
    const sources = text.filter(({ path }) => path.startsWith("src/"));
    const formatters = sources.filter(({ content }) => /Intl\.DateTimeFormat|toLocale(Time|Date)?String/.test(content)).map(({ path }) => path);
    expect(formatters).toEqual(["src/lib/time.ts"]);
    const time = sources.find(({ path }) => path === "src/lib/time.ts")!.content;
    expect(time).toContain('"America/Los_Angeles"');
    expect(time).toContain("hour12: true");
  });
});
