// A `DocumentEngine` that lives in memory, for the tests of the MCP server. It is not an engine: it knows two
// edits of Word packages (below) and refuses every other op the way the real one refuses what it does not know.
// Its hashes are the SHA-256 of the bytes it returns, so the checks of the room server are real checks.
//
// Ops of a `.docx` document:
//   {op: "append_paragraph", text}        add a paragraph at the end of the body
//   {op: "replace_text", find, text}      replace the first `find` of the text of the body; refused when absent
// A page is two paragraphs, so a small edit moves a page hash.
import { createHash } from "node:crypto";
import type { ReactorPipeEntitlement, RoomBatch, RoomOp } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, EngineRefusal, type ReplayInput, type ReplayResult } from "@wolfsdk/server";
import { ZipArchive, writeZip } from "../../src/read/index.ts";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BODY = "word/document.xml";

function paragraphs(xml: string): string[] {
  return xml.match(/<w:p(?: [^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g) ?? [];
}

function rewrite(bytes: Uint8Array, change: (xml: string) => string): Uint8Array {
  let zip: ZipArchive;
  try {
    zip = ZipArchive.open(bytes);
  } catch {
    throw new EngineRefusal("invalid-input", "the bytes are not a Word package", "apply");
  }
  const files = zip.names().map((name) => ({ name, data: name === BODY ? change(zip.text(name)) : zip.bytes(name) }));
  return writeZip(files);
}

function applyOp(bytes: Uint8Array, op: RoomOp): Uint8Array {
  switch (op.op) {
    case "append_paragraph": {
      if (typeof op.text !== "string") throw new EngineRefusal("invalid-argument", "append_paragraph needs a text", "apply", "text");
      const paragraph = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(op.text)}</w:t></w:r></w:p>`;
      return rewrite(bytes, (xml) => {
        const at = xml.includes("<w:sectPr") ? xml.indexOf("<w:sectPr") : xml.lastIndexOf("</w:body>");
        if (at < 0) throw new EngineRefusal("invalid-input", "the document has no body", "apply");
        return xml.slice(0, at) + paragraph + xml.slice(at);
      });
    }
    case "replace_text": {
      if (typeof op.find !== "string" || typeof op.text !== "string") {
        throw new EngineRefusal("invalid-argument", "replace_text needs find and text", "apply", "find");
      }
      const find = escapeXml(op.find);
      return rewrite(bytes, (xml) => {
        const at = xml.indexOf(find);
        if (at < 0) throw new EngineRefusal("text-not-found", `no ${JSON.stringify(op.find)} in the document`, "apply", "find");
        return xml.slice(0, at) + escapeXml(op.text as string) + xml.slice(at + find.length);
      });
    }
    default:
      throw new EngineRefusal("unknown-op", `the op ${JSON.stringify(op.op)} is not known`, "apply", "op");
  }
}

function applyBatch(format: string, bytes: Uint8Array, batch: RoomBatch): Uint8Array {
  if (format !== "docx") throw new EngineRefusal("unsupported-format", `ops are not supported for ${format}`, "apply");
  return batch.ops.reduce(applyOp, bytes);
}

function pageHashes(bytes: Uint8Array): string[] | null {
  let xml: string;
  try {
    xml = ZipArchive.open(bytes).text(BODY);
  } catch {
    return null;
  }
  const all = paragraphs(xml);
  const pages: string[] = [];
  for (let i = 0; i < Math.max(all.length, 1); i += 2) pages.push(sha256(all.slice(i, i + 2).join("")));
  return pages;
}

export const MEMORY_ENTITLEMENT: ReactorPipeEntitlement = {
  tier: "commercial",
  max_workspaces: null,
  max_seats: null,
  sso: false,
  oem_offline_wasm: false,
  key_id: null,
  expires_at: null,
};

export class MemoryEngine implements DocumentEngine {
  /** Every replay asked of the engine, in order. */
  readonly replays: ReplayInput[] = [];

  async entitlement(): Promise<ReactorPipeEntitlement> {
    return MEMORY_ENTITLEMENT;
  }

  async replay(input: ReplayInput): Promise<ReplayResult> {
    this.replays.push(input);
    let bytes = input.bytes;
    const steps: ReplayResult["steps"] = [];
    for (const batch of input.batches) {
      const before = sha256(bytes);
      bytes = applyBatch(input.format, bytes, batch);
      steps.push({ base_sha256: before, sha256: sha256(bytes) });
    }
    return {
      format: input.format,
      base_sha256: sha256(input.bytes),
      steps,
      bytes: input.save ? bytes : null,
      page_hashes: input.pages && input.format === "docx" ? pageHashes(bytes) : null,
    };
  }

  async close(): Promise<void> {}
}

/** The package of a Word document with one paragraph per line of `lines`. */
export function wordDocument(lines: readonly string[]): Uint8Array {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const rels = (target: string, type: string): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;
  const body = lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join("");
  return writeZip([
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    { name: "_rels/.rels", data: rels("word/document.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument") },
    { name: BODY, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ]);
}

export const bytesOfText = (text: string): Uint8Array => encoder.encode(text);
