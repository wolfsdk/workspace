// A small XML scanner for OOXML parts. It builds a tree whose nodes carry their offsets in the source text, so
// an edit is a splice of the original string and everything it does not touch stays byte for byte. It is not a
// validating parser: it reads the well-formed XML that Office and the Wolf engine write, and refuses what it
// would have to guess about (a DOCTYPE, which could carry entities; mismatched tags).
import { PackError } from "./errors.ts";

export type XNode = {
  /** The qualified name as written (`w:tbl`). */
  name: string;
  attrs: Record<string, string>;
  /** Offset of the `<` of the opening tag. */
  start: number;
  /** Offset just after the `>` of the opening tag: where the content starts. */
  openEnd: number;
  /** Offset of the `</` of the closing tag, or `openEnd` for an empty element: where the content ends. */
  closeStart: number;
  /** Offset just after the element. */
  end: number;
  selfClosing: boolean;
  parent: XNode | null;
  children: XNode[];
};

const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (named !== undefined) return NAMED[named] ?? whole;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/** Characters XML 1.0 can not store. A bound value that holds one is refused before anything is written. */
export const XML_INVALID_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src: string, part = "xml"): XNode {
  const fail = (message: string): PackError => new PackError("package-bad-xml", `${part}: ${message}`);
  let root: XNode | null = null;
  let current: XNode | null = null;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 4);
      if (close < 0) throw fail("unterminated comment");
      i = close + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const close = src.indexOf("]]>", lt + 9);
      if (close < 0) throw fail("unterminated CDATA section");
      i = close + 3;
    } else if (src.startsWith("<?", lt)) {
      const close = src.indexOf("?>", lt + 2);
      if (close < 0) throw fail("unterminated processing instruction");
      i = close + 2;
    } else if (src.startsWith("<!", lt)) {
      throw fail("a DOCTYPE or declaration is not allowed");
    } else if (src.startsWith("</", lt)) {
      const close = src.indexOf(">", lt + 2);
      if (close < 0) throw fail("unterminated closing tag");
      const name = src.slice(lt + 2, close).trim();
      if (current === null || current.name !== name) throw fail(`closing tag </${name}> does not match ${current === null ? "any open element" : `<${current.name}>`}`);
      current.closeStart = lt;
      current.end = close + 1;
      current = current.parent;
      i = close + 1;
    } else {
      // An opening tag: find its `>` outside quotes.
      let j = lt + 1;
      let quote = "";
      for (; j < src.length; j++) {
        const ch = src[j] ?? "";
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") break;
      }
      if (j >= src.length) throw fail("unterminated opening tag");
      const selfClosing = src[j - 1] === "/";
      const inner = src.slice(lt + 1, selfClosing ? j - 1 : j);
      const nameEnd = inner.search(/[\s]/);
      const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
      if (name === "") throw fail("an element has no name");
      const attrs: Record<string, string> = {};
      if (nameEnd >= 0) {
        ATTRIBUTE.lastIndex = 0;
        for (let m = ATTRIBUTE.exec(inner); m !== null; m = ATTRIBUTE.exec(inner)) attrs[m[1] ?? ""] = decodeXml(m[2] ?? m[3] ?? "");
      }
      const node: XNode = {
        name,
        attrs,
        start: lt,
        openEnd: j + 1,
        closeStart: j + 1,
        end: j + 1,
        selfClosing,
        parent: current,
        children: [],
      };
      if (current) current.children.push(node);
      else if (root === null) root = node;
      else throw fail("more than one root element");
      if (!selfClosing) current = node;
      i = j + 1;
    }
  }
  if (current !== null) throw fail(`<${current.name}> is not closed`);
  if (root === null) throw fail("no root element");
  return root;
}

/** The decoded text of a leaf element (`w:t`, `a:t`, `c:v`, `v`). */
export function leafText(src: string, node: XNode): string {
  const raw = src.slice(node.openEnd, node.closeStart);
  return decodeXml(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, data: string) => data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")));
}

/** Whether `node` is the element `name`: a bare name matches under any namespace prefix, a prefixed one exactly. */
export function isNamed(node: XNode, name: string): boolean {
  return node.name === name || (!name.includes(":") && node.name.endsWith(`:${name}`));
}

export function childrenNamed(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => isNamed(c, name));
}

export function firstChild(node: XNode, name: string): XNode | undefined {
  return node.children.find((c) => isNamed(c, name));
}

/** Every descendant (not the node itself) in document order. */
export function* descendants(node: XNode): Generator<XNode> {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}

export function descendantsNamed(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  for (const d of descendants(node)) if (isNamed(d, name)) out.push(d);
  return out;
}

export function firstDescendant(node: XNode, name: string): XNode | undefined {
  for (const d of descendants(node)) if (isNamed(d, name)) return d;
  return undefined;
}

/**
 * Qualified-name builder for a namespace: the prefix the root binds to `uri` (the default namespace gives no
 * prefix), else `fallback`. `names("tbl")` is `w:tbl` in a document that binds `w` to the Word namespace.
 */
export function namespace(root: XNode, uri: string, fallback: string): (local: string) => string {
  let prefix = fallback;
  for (const [key, value] of Object.entries(root.attrs)) {
    if (value !== uri) continue;
    if (key === "xmlns") prefix = "";
    else if (key.startsWith("xmlns:")) prefix = key.slice(6);
    else continue;
    break;
  }
  return (local) => (prefix === "" ? local : `${prefix}:${local}`);
}

export type Splice = { start: number; end: number; text: string; order: number };

/**
 * Apply splices to `src`. Replacements must not overlap; insertions (start equals end) at one offset keep the
 * order they were given in.
 */
export function applySplices(src: string, splices: readonly Splice[], part: string): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
  let out = "";
  let at = 0;
  for (const s of sorted) {
    if (s.start < at) throw new PackError("overlapping-edits", `${part}: two edits touch the same content`);
    out += src.slice(at, s.start) + s.text;
    at = s.end;
  }
  return out + src.slice(at);
}
