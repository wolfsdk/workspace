// OPC relationships: the `_rels/<part>.rels` files that connect the parts of an OOXML package.
import { attr, childElements, parseXml } from "./xml.ts";
import type { ZipArchive } from "./zip.ts";

export type Relationship = {
  id: string;
  /** The relationship type URI. */
  type: string;
  /** The target part name (no leading slash) for an internal relationship; the URI as written for an external one. */
  target: string;
  external: boolean;
};

/** The part name `target` names when written in a relationship of `base` (a part name such as `xl/workbook.xml`):
 * absolute when it starts with `/`, otherwise relative to the directory of `base`, with `.` and `..` resolved. */
export function resolvePartName(base: string, target: string): string {
  const segments = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** The relationships of the package itself (`part` is the empty string) or of one part, by id. Empty when the
 * part has no relationships file. */
export function relationshipsOf(zip: ZipArchive, part: string): Map<string, Relationship> {
  const slash = part.lastIndexOf("/");
  const file = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const out = new Map<string, Relationship>();
  const text = zip.optionalText(file);
  if (text === undefined) return out;
  for (const el of childElements(parseXml(text), "Relationship")) {
    const id = attr(el, "Id");
    const target = attr(el, "Target");
    if (id === undefined || target === undefined) continue;
    const external = attr(el, "TargetMode") === "External";
    out.set(id, { id, type: attr(el, "Type") ?? "", target: external ? target : resolvePartName(part, target), external });
  }
  return out;
}
