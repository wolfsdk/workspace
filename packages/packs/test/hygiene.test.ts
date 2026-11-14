// What the open-core package must never contain: engine binaries, source maps, office archives, machine-specific
// paths, the editor product, em dashes. And what it must declare: its licence. This file is skipped by the scan
// because it names the things it looks for.
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
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.name !== SELF) found.push(path);
  }
  return found;
}

const listing = await files(ROOT);
const text = await Promise.all(
  listing.map(async (path) => ({ path: relative(ROOT, path), content: await readFile(path, "utf8") })),
);
const manifest: Manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

describe("the package", () => {
  test("is Apache-2.0 and private until it is published on purpose", () => {
    expect(manifest.name).toBe("@wolfsdk/packs");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.private).toBe(true);
  });

  test("ships no engine binary, source map or archive, and builds its documents in memory", () => {
    const banned = /\.(wasm|map|node|dylib|so|dll|exe|zip|tgz|gz|xlsx|docx|pptx)$/;
    expect(listing.filter((path) => banned.test(path)).map((path) => relative(ROOT, path))).toEqual([]);
  });

  test("names no machine path and no editor product", () => {
    const banned = /\/Users\/|\/home\/|C:\\\\Users|wolf-editor/;
    expect(text.filter(({ content }) => banned.test(content)).map(({ path }) => path)).toEqual([]);
  });

  test("has no em dash in its prose", () => {
    expect(text.filter(({ content }) => content.includes("\u2014")).map(({ path }) => path)).toEqual([]);
  });

  test("depends on the frozen protocol and the server and nothing else outside the runtime", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@wolfsdk/protocol", "@wolfsdk/server"]);
  });
});
