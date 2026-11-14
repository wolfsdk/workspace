// A small, tolerant XML reader for OOXML parts: elements, attributes and text, with the five predefined
// entities and numeric character references. It reads no DTD (a DOCTYPE is skipped, never expanded), so a
// part can not make it allocate through entities, and it bounds nesting depth. Names keep their prefix
// (`w:p`); `local` is the part after the colon, which is what the readers match on.

export type XmlElement = { name: string; local: string; attrs: Record<string, string>; children: XmlNode[] };
export type XmlNode = XmlElement | string;

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

/** Deepest element nesting the reader accepts. */
export const XML_MAX_DEPTH = 256;

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

const NAME_END = /[\s/>=]/;
const localOf = (name: string): string => name.slice(name.indexOf(":") + 1);

/** Parse the root element of an XML document. Throws `XmlError` for markup it can not read. */
export function parseXml(source: string): XmlElement {
  const len = source.length;
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;

  const skipTo = (needle: string, what: string): void => {
    const end = source.indexOf(needle, i);
    if (end < 0) throw new XmlError(`unterminated ${what}`);
    i = end + needle.length;
  };

  while (i < len) {
    const lt = source.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      if (top) throw new XmlError(`unclosed element ${top.name}`);
      break;
    }
    if (lt > i && top) {
      const text = source.slice(i, lt);
      top.children.push(decodeEntities(text));
    }
    i = lt;
    if (source.startsWith("<!--", i)) {
      skipTo("-->", "comment");
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i);
      if (end < 0) throw new XmlError("unterminated CDATA section");
      if (top) top.children.push(source.slice(i + 9, end));
      i = end + 3;
    } else if (source.startsWith("<?", i)) {
      skipTo("?>", "processing instruction");
    } else if (source.startsWith("<!", i)) {
      // A DOCTYPE: skipped as a whole, including an internal subset in brackets.
      const open = source.indexOf("[", i);
      const close = source.indexOf(">", i);
      if (close < 0) throw new XmlError("unterminated declaration");
      if (open >= 0 && open < close) skipTo("]>", "DOCTYPE subset");
      else i = close + 1;
    } else if (source.startsWith("</", i)) {
      const close = source.indexOf(">", i);
      if (close < 0) throw new XmlError("unterminated end tag");
      const name = source.slice(i + 2, close).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`end tag ${name} does not match ${open ? open.name : "an open element"}`);
      i = close + 1;
    } else {
      // A start tag.
      let j = i + 1;
      while (j < len && !NAME_END.test(source[j] as string)) j++;
      const name = source.slice(i + 1, j);
      if (name.length === 0) throw new XmlError("start tag without a name");
      const element: XmlElement = { name, local: localOf(name), attrs: {}, children: [] };
      let selfClosing = false;
      for (;;) {
        while (j < len && /\s/.test(source[j] as string)) j++;
        if (j >= len) throw new XmlError(`unterminated start tag ${name}`);
        const c = source[j];
        if (c === ">") {
          j++;
          break;
        }
        if (c === "/") {
          if (source[j + 1] !== ">") throw new XmlError(`stray / in start tag ${name}`);
          selfClosing = true;
          j += 2;
          break;
        }
        const from = j;
        while (j < len && !NAME_END.test(source[j] as string)) j++;
        const attrName = source.slice(from, j);
        while (j < len && /\s/.test(source[j] as string)) j++;
        if (attrName.length === 0 || source[j] !== "=") throw new XmlError(`attribute without a value in ${name}`);
        j++;
        while (j < len && /\s/.test(source[j] as string)) j++;
        const quote = source[j];
        if (quote !== '"' && quote !== "'") throw new XmlError(`attribute ${attrName} of ${name} is not quoted`);
        const end = source.indexOf(quote, j + 1);
        if (end < 0) throw new XmlError(`unterminated attribute ${attrName}`);
        element.attrs[attrName] = decodeEntities(source.slice(j + 1, end));
        j = end + 1;
      }
      i = j;
      if (top) top.children.push(element);
      else if (root) throw new XmlError("more than one root element");
      else root = element;
      if (!selfClosing) {
        if (stack.length >= XML_MAX_DEPTH) throw new XmlError(`elements nest deeper than ${XML_MAX_DEPTH}`);
        stack.push(element);
      }
    }
  }
  if (stack.length > 0) throw new XmlError(`unclosed element ${(stack[stack.length - 1] as XmlElement).name}`);
  if (!root) throw new XmlError("no root element");
  return root;
}

/** The value of attribute `name` (as written, with its prefix). A prefixed name that is absent is matched on
 * its local part among prefixed attributes, so a part that binds the namespace to another prefix still reads. */
export function attr(el: XmlElement, name: string): string | undefined {
  const exact = el.attrs[name];
  if (exact !== undefined || !name.includes(":")) return exact;
  const local = localOf(name);
  for (const key of Object.keys(el.attrs)) if (key.includes(":") && localOf(key) === local) return el.attrs[key];
  return undefined;
}

/** The element children of `el`, those named `local` (any prefix) when it is given. */
export function childElements(el: XmlElement, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) if (typeof child !== "string" && (local === undefined || child.local === local)) out.push(child);
  return out;
}

export function firstChild(el: XmlElement, local: string): XmlElement | undefined {
  for (const child of el.children) if (typeof child !== "string" && child.local === local) return child;
  return undefined;
}

/** Every descendant named `local`, in document order (not descending into a match). */
export function descendants(el: XmlElement, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const child of el.children) {
    if (typeof child === "string") continue;
    if (child.local === local) out.push(child);
    else descendants(child, local, out);
  }
  return out;
}

/** All the text under `el`, concatenated in document order. */
export function textOf(el: XmlElement): string {
  let out = "";
  for (const child of el.children) out += typeof child === "string" ? child : textOf(child);
  return out;
}
