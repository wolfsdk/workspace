// An OOXML package held in memory: parts read on demand, edits collected as whole-part replacements, and a
// `save` that writes only the parts that changed (see `writeZip`). A package nothing was replaced in saves as
// the very bytes it was opened from.
import { PackError } from "./errors.ts";
import { parseXml, type XNode } from "./xml.ts";
import { encodeUtf8, readZip, readEntry, readEntryText, writeZip, type ZipArchive } from "./zip.ts";

export const NS = {
  word: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  presentation: "http://schemas.openxmlformats.org/presentationml/2006/main",
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  spreadsheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  relationships: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
} as const;

export type Relationship = { id: string; type: string; target: string; external: boolean };

/** `target` as a part name, resolved against the part the relationship belongs to. */
export function resolvePartName(fromPart: string, target: string): string {
  const segments = target.startsWith("/") ? [] : fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export function relsPartOf(part: string): string {
  const at = part.lastIndexOf("/");
  return `${part.slice(0, at + 1)}_rels/${part.slice(at + 1)}.rels`;
}

export class OoxmlPackage {
  readonly archive: ZipArchive;
  private readonly original: Uint8Array;
  private readonly replaced = new Map<string, Uint8Array>();
  private readonly texts = new Map<string, string>();

  constructor(bytes: Uint8Array) {
    this.original = bytes;
    this.archive = readZip(bytes);
  }

  has(part: string): boolean {
    return this.archive.entries.some((e) => e.name === part);
  }

  /** The text of a part as it is now (an edit made through `setText` is visible). */
  text(part: string): string | undefined {
    const edited = this.texts.get(part);
    if (edited !== undefined) return edited;
    return readEntryText(this.archive, part);
  }

  requireText(part: string): string {
    const text = this.text(part);
    if (text === undefined) throw new PackError("package-missing-part", `the package has no part ${JSON.stringify(part)}`);
    return text;
  }

  xml(part: string): { src: string; root: XNode } {
    const src = this.requireText(part);
    return { src, root: parseXml(src, part) };
  }

  bytes(part: string): Uint8Array | undefined {
    return this.replaced.get(part) ?? readEntry(this.archive, part);
  }

  setText(part: string, text: string): void {
    this.texts.set(part, text);
    this.replaced.set(part, encodeUtf8(text));
  }

  setBytes(part: string, bytes: Uint8Array): void {
    this.texts.delete(part);
    this.replaced.set(part, bytes);
  }

  relationships(part: string): Relationship[] {
    const rels = this.text(relsPartOf(part));
    if (rels === undefined) return [];
    const root = parseXml(rels, relsPartOf(part));
    return root.children
      .filter((c) => c.name.endsWith("Relationship"))
      .map((c) => {
        const external = c.attrs.TargetMode === "External";
        const target = c.attrs.Target ?? "";
        return { id: c.attrs.Id ?? "", type: c.attrs.Type ?? "", target: external ? target : resolvePartName(part, target), external };
      });
  }

  relationship(part: string, id: string): Relationship {
    const found = this.relationships(part).find((r) => r.id === id);
    if (found === undefined) throw new PackError("package-bad-relationship", `${part} has no relationship ${JSON.stringify(id)}`);
    return found;
  }

  /** The package as bytes: the original when nothing was replaced. */
  save(): Uint8Array {
    return this.replaced.size === 0 ? this.original : writeZip(this.archive, this.replaced);
  }

  get changed(): boolean {
    return this.replaced.size > 0;
  }
}
