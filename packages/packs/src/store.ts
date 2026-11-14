// Where a pack's files live. A pack is a directory: `pack.wolf.json` and every source and target document it
// names, by a name relative to that directory. A name that would leave the directory is refused, never joined.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PackError } from "./errors.ts";

export interface PackReader {
  /** The bytes of `name`, or `undefined` when the pack has no such file. */
  read(name: string): Promise<Uint8Array | undefined>;
}

export interface PackStore extends PackReader {
  /** Replace the files `files` names, all or none: a failure leaves every file as it was. */
  writeAll(files: ReadonlyMap<string, Uint8Array>): Promise<void>;
}

/** `name` as a path inside the pack, or a refusal when it is absolute, empty or climbs out of the pack. */
export function packPath(name: string): string {
  const parts = name.split("/");
  if (name === "" || name.startsWith("/") || name.includes("\\") || name.includes("\0") || parts.some((p) => p === ".." || p === "" || /^[A-Za-z]:/.test(p))) {
    throw new PackError("path-outside-pack", `${JSON.stringify(name)} is not a file name inside the pack`);
  }
  return parts.filter((p) => p !== ".").join("/");
}

export class DirectoryStore implements PackStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(join(this.directory, packPath(name))));
    } catch (e) {
      if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Stage every file beside its target, then rename them into place: a refusal while staging touches nothing. */
  async writeAll(files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const staged: { temp: string; target: string }[] = [];
    try {
      for (const [name, bytes] of files) {
        const target = join(this.directory, packPath(name));
        const temp = `${target}.wolf-refresh-${process.pid}`;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(temp, bytes);
        staged.push({ temp, target });
      }
    } catch (e) {
      await Promise.all(staged.map((s) => rm(s.temp, { force: true })));
      throw e;
    }
    for (const { temp, target } of staged) await rename(temp, target);
  }
}

export class MemoryStore implements PackStore {
  readonly files: Map<string, Uint8Array>;

  constructor(files: Iterable<readonly [string, Uint8Array]> = []) {
    this.files = new Map(files);
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    return this.files.get(packPath(name));
  }

  async writeAll(files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const checked = [...files].map(([name, bytes]) => [packPath(name), bytes] as const);
    for (const [name, bytes] of checked) this.files.set(name, bytes);
  }
}
