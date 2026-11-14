import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReactorKernelClient } from "@wolfsdk/protocol";
import { DEFAULT_ENGINE_CHANNEL, inferEngineFormat } from "@wolfsdk/runtime/loader";
import { renderPage, type DisplayList, type FontRef, type TextRun } from "@wolfsdk/runtime/vector";
import {
  engineForDocument,
  engineFormatOf,
  engineSourceFor,
  engineSourceOf,
  initialEngineSource,
  sameEngine,
} from "../../src/element/engine.ts";
import { engineLoad, engineModule } from "../../src/shell/engine.ts";
import { VectorPages, attachFontPack, fontPackOf } from "../../src/shell/vector.ts";

/** The smallest valid WebAssembly module: magic and version, no sections. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const EMPTY_SHA = createHash("sha256").update(EMPTY_MODULE).digest("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

/** A `fetch` that serves `files` by absolute URL (404 otherwise) and records every request. */
function serve(files: Record<string, string | Uint8Array>): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fake = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(typeof body === "string" ? body : body.slice(), { status: 200 });
  };
  return { fetch: fake as typeof fetch, requests };
}

/** A fresh channel root per test, so the per-page module cache never answers for another test. */
let channels = 0;
function channel(): string {
  return `https://split.test/c${++channels}`;
}

/** A stored ZIP holding `part` (local file header only), as an OOXML package starts. */
function ooxml(part: string): Uint8Array {
  const name = encoder.encode(part);
  const header = new Uint8Array(30 + name.length);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}
const DOCX = ooxml("word/document.xml");
const XLSX = ooxml("xl/workbook.xml");
const PDF = encoder.encode("%PDF-1.7\n");

/** A release with split modules for `formats` next to `wolf_web.wasm` (every module the empty one). */
function release(formats: string[]) {
  const root = channel();
  const names = ["wolf_web.wasm", ...formats.map((f) => `wolf_web_${f}.wasm`)];
  const files: Record<string, string | Uint8Array> = {
    [`${root}/latest.txt`]: "3.0.0\n",
    [`${root}/v3.0.0/SHA256SUMS`]: names.map((n) => `${EMPTY_SHA}  ${n}\n`).join(""),
  };
  for (const n of names) files[`${root}/v3.0.0/${n}`] = EMPTY_MODULE;
  return { root, ...serve(files) };
}

const attrs = (values: Record<string, string>) => (name: string) => values[name] ?? null;

describe("engine-format", () => {
  test("maps onto the source's format, any case; other values and engine-src drop it", () => {
    expect(engineSourceOf(attrs({ "engine-format": "DOCX" }), null)).toEqual({
      channel: DEFAULT_ENGINE_CHANNEL,
      format: "docx",
    });
    expect(engineSourceOf(attrs({ "engine-format": " auto " }), null).format).toBe("auto");
    expect(engineSourceOf(attrs({ "engine-format": "odt" }), null)).toEqual({ channel: DEFAULT_ENGINE_CHANNEL });
    expect(engineSourceOf(attrs({ "engine-format": "pdf", "engine-src": "https://a.test/m.wasm" }), null)).toEqual({
      url: "https://a.test/m.wasm",
    });
    expect(engineSourceOf(attrs({ "engine-format": "pdf" }), { channel: "https://p.test/", format: "auto" })).toEqual({
      channel: "https://p.test",
      format: "auto",
    });
    expect(engineFormatOf("PPTX")).toBe("pptx");
    expect(engineFormatOf("")).toBeUndefined();
  });

  test("a different format restarts the engine; auto is its own setting", () => {
    expect(sameEngine({ format: "auto" }, { format: "auto" })).toBe(true);
    expect(sameEngine({ format: "auto" }, {})).toBe(false);
    expect(sameEngine({ format: "auto" }, { format: "docx" })).toBe(false);
    expect(sameEngine({ url: "https://a.test/m.wasm", format: "auto" }, { url: "https://a.test/m.wasm" })).toBe(true);
  });

  test("the module at start: the configured format, the src name under auto, or none to wait", () => {
    const base = { channel: "https://c.test" };
    // No engine-format: wolf_web.wasm at once, as before.
    expect(initialEngineSource(base, null, null)).toEqual({ channel: "https://c.test" });
    expect(initialEngineSource(base, "/docs/memo.docx", null)).toEqual({ channel: "https://c.test" });
    expect(initialEngineSource({ ...base, format: "xlsx" }, null, null)).toEqual({ channel: "https://c.test", format: "xlsx" });
    const auto = { ...base, format: "auto" as const };
    expect(initialEngineSource(auto, "https://files.test/memo.docx?sig=1", null)).toEqual({
      channel: "https://c.test",
      format: "docx",
    });
    expect(initialEngineSource(auto, "/download?id=7", "Budget.XLSX")).toEqual({ channel: "https://c.test", format: "xlsx" });
    expect(initialEngineSource(auto, "/download?id=7", null)).toBeNull();
    expect(initialEngineSource(auto, null, null)).toBeNull();
    // An exact URL is loaded as given.
    expect(initialEngineSource({ url: "https://a.test/m.wasm" }, "/memo.docx", null)).toEqual({ url: "https://a.test/m.wasm" });
  });

  test("engine-format=docx loads wolf_web_docx.wasm alone", async () => {
    const { root, fetch, requests } = release(["docx", "xlsx"]);
    const source = initialEngineSource({ channel: root, format: "docx", fetch }, null, null)!;
    const { resolved } = await engineModule(source);
    expect(resolved.url).toBe(`${root}/v3.0.0/wolf_web_docx.wasm`);
    expect(requests).toEqual([`${root}/latest.txt`, `${root}/v3.0.0/SHA256SUMS`, `${root}/v3.0.0/wolf_web_docx.wasm`]);
  });

  test("auto waits for a document, then loads its format's module and switches when the next needs another", async () => {
    const { root, fetch, requests } = release(["docx", "xlsx", "pdf"]);
    const config = engineSourceOf(attrs({}), { channel: root, format: "auto", fetch });
    expect(initialEngineSource(config, null, null)).toBeNull();
    expect(requests).toEqual([]); // nothing downloaded before a document

    // First document: a .docx (told by its bytes, whatever its name).
    const first = await engineForDocument(config, null, DOCX, "upload.bin");
    expect(first).toEqual(engineSourceFor(config, "docx"));
    const docx = await engineModule(first!);
    expect(docx.resolved.url).toBe(`${root}/v3.0.0/wolf_web_docx.wasm`);

    // Same format again: stay.
    expect(await engineForDocument(config, first, DOCX, "again.docx")).toBeNull();

    // A workbook: switch to wolf_web_xlsx.wasm (fetched while deciding, so the new session reuses it).
    const second = await engineForDocument(config, first, XLSX, "Book1.xlsx");
    expect(second).toEqual(engineSourceFor(config, "xlsx"));
    const xlsx = await engineModule(second!);
    expect(xlsx.resolved.url).toBe(`${root}/v3.0.0/wolf_web_xlsx.wasm`);
    expect(requests.filter((u) => u.endsWith("wolf_web_xlsx.wasm")).length).toBe(1);

    // Back to a document: the compiled module comes from the page cache, nothing is fetched.
    const before = requests.length;
    const back = await engineForDocument(config, second, DOCX, "memo.docx");
    expect(back).toEqual(first);
    expect(await engineModule(back!)).toBe(docx);
    expect(requests.length).toBe(before);

    // A name alone tells the format when the bytes do not; nothing at all keeps the running module.
    expect(await engineForDocument(config, second, PDF, "scan")).toEqual(engineSourceFor(config, "pdf"));
    expect(await engineForDocument(config, second, new Uint8Array([1, 2, 3]), "notes.txt")).toBeNull();
    expect(await engineForDocument(config, null, new Uint8Array([1, 2, 3]), "notes.txt")).toEqual(engineSourceFor(config));
  });

  test("only auto switches", async () => {
    const docx = { channel: "https://c.test", format: "docx" as const };
    expect(await engineForDocument(docx, engineSourceFor(docx, "docx"), XLSX, "Book1.xlsx")).toBeNull();
    expect(await engineForDocument({ channel: "https://c.test" }, { channel: "https://c.test" }, XLSX, "Book1.xlsx")).toBeNull();
  });

  test("a release without split modules serves every format from one wolf_web.wasm, downloaded once", async () => {
    const { root, fetch, requests } = release([]);
    const config = engineSourceOf(attrs({}), { channel: root, format: "auto", fetch });
    const first = (await engineForDocument(config, null, DOCX, "memo.docx"))!;
    const docxLoad = engineLoad(first);
    const docx = await engineModule(first);
    expect(docx.resolved).toEqual({ url: `${root}/v3.0.0/wolf_web.wasm`, version: "3.0.0", sha256: EMPTY_SHA });
    // The workbook resolves to the same module: the element keeps its session.
    expect(await engineForDocument(config, first, XLSX, "Book1.xlsx")).toBeNull();
    // And the monolith source itself shares the compiled module.
    const monolithLoad = engineLoad(engineSourceFor(config));
    const monolith = await engineModule(engineSourceFor(config));
    expect(monolith.module).toBe(docx.module);
    expect(requests.filter((u) => u.endsWith(".wasm"))).toEqual([`${root}/v3.0.0/wolf_web.wasm`]);
    expect(docxLoad.getStatus().stage).toBe("ready");
    expect(monolithLoad.getStatus()).toMatchObject({ stage: "ready", transferred: 0 });
  });

  test("format detection is re-exported for hosts", () => {
    expect(inferEngineFormat({ bytes: XLSX })).toBe("xlsx");
  });
});

// --- extended font pack: vector repaint -------------------------------------------------------

/** A 2D context that records `fillText` calls with the font in effect, and resolves `next` on each. */
function recordingContext() {
  const texts: { text: string; font: string }[] = [];
  let waiters: (() => void)[] = [];
  const state: Record<string | symbol, unknown> = { canvas: { width: 200, height: 100 }, font: "" };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === "fillText")
        return (text: string) => {
          texts.push({ text, font: String(target.font) });
          for (const w of waiters) w();
          waiters = [];
        };
      return key in target ? target[key] : () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const next = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push(resolve);
    return promise;
  };
  return { ctx, texts, next };
}

function page(text: string, font: Partial<FontRef> = {}): DisplayList {
  const fontRef: FontRef = {
    id: 0,
    family: "Calibri",
    weight: 400,
    italic: false,
    unitsPerEm: null,
    embedded: false,
    face: null,
    faceIndex: 0,
    resolvedFamily: null,
    substituted: false,
    ...font,
  };
  const n = [...text].length;
  const run = {
    index: 0,
    engineRun: 0,
    font: 0,
    size: 12,
    x: 10,
    y: 20,
    vertical: false,
    text,
    glyphs: {
      ids: new Array(n).fill(0),
      advances: new Array(n).fill(6),
      dx: new Array(n).fill(0),
      dy: new Array(n).fill(0),
      clusters: [...text].map((_, i) => encoder.encode([...text].slice(0, i).join("")).length),
      shapedByHost: false,
    },
    mode: "fill",
    fill: { kind: "solid", color: "#000000", transparent: false },
    stroke: null,
    objectId: null,
    objectOffset: 0,
    ctm: [1, 0, 0, 1, 0, 0],
    charX: [],
    bbox: { x: 10, y: 8, w: 6 * n, h: 12 },
    approximate: false,
  } as TextRun;
  return {
    page: 0,
    width: 200,
    height: 100,
    label: null,
    ops: [{ kind: "text", run }],
    runs: [run],
    fonts: [fontRef],
    images: [],
    objects: {},
    regions: [],
    links: [],
    unknown: {},
  } as unknown as DisplayList;
}

const g = globalThis as Record<string, unknown>;
const saved = { FontFace: g.FontFace, fonts: g.fonts };
afterEach(() => {
  g.FontFace = saved.FontFace;
  g.fonts = saved.fonts;
});

/** A `FontFaceSet` and `FontFace` for bun, which has neither: faces load at once and are kept by family. */
function fakeFontFaces() {
  const added: string[] = [];
  g.FontFace = class {
    family: string;
    constructor(family: string) {
      this.family = family;
    }
    load() {
      return Promise.resolve(this);
    }
  };
  g.fonts = { add: (face: { family: string }) => added.push(face.family), delete: () => true };
  return added;
}

describe("extended font pack", () => {
  const FONT = encoder.encode("not parsed as outlines: drawn through FontFace");
  const thai = {
    file: "NotoSansThai-Regular.ttf",
    family: "Noto Sans Thai",
    style: "regular",
    script: "thai",
    bytes: FONT.byteLength,
    sha256: sha256(FONT),
  };

  function packRelease(font: Uint8Array) {
    const root = channel();
    const served = serve({
      [`${root}/v3.0.0/fonts/wolf_web_font_pack.json`]: JSON.stringify({ schema: "wolf-web-font-pack.v1", fonts: [thai] }),
      [`${root}/v3.0.0/fonts/${thai.file}`]: font,
    });
    return { root, ...served };
  }

  test("kernels of one release share a loader", () => {
    const a = {};
    const b = {};
    const root = channel();
    const pack = attachFontPack(a, `${root}/v1/wolf_web_docx.wasm`);
    expect(attachFontPack(b, `${root}/v1/wolf_web_xlsx.wasm`)).toBe(pack);
    expect(fontPackOf(a)).toBe(pack);
    expect(pack.url).toBe(`${root}/v1/fonts/wolf_web_font_pack.json`);
    expect(fontPackOf({})).toBeNull();
  });

  test("a Thai run draws a stand-in, then the canvas repaints with the verified pack face once it arrives", async () => {
    const added = fakeFontFaces();
    const { root, fetch, requests } = packRelease(FONT);
    const kernel = {} as ReactorKernelClient;
    const pages = new VectorPages(kernel);
    attachFontPack(kernel, `${root}/v3.0.0/wolf_web_docx.wasm`, fetch);
    const doc = pages.forDoc("doc-1" as never);
    const dl = page("สวัสดี");
    await doc.cache.prepare(dl);

    const { ctx, texts, next } = recordingContext();
    const repainted = next().then(() => next()); // the stand-in paint, then the repaint
    const first = renderPage(ctx, dl, { pxPerPt: 1, resources: doc.cache });
    expect(first.pendingFonts).toBe(1);
    expect(first.text).toMatchObject({ pack: 1, fallback: 0 });
    expect(texts[0]!.font).not.toContain("wolf-pack-");

    await repainted;
    const family = `wolf-pack-${thai.sha256.slice(0, 16)}`;
    expect(added).toEqual([family]);
    expect(texts.at(-1)).toEqual({ text: "สวัสดี", font: `400 12px "${family}", ${texts.at(-1)!.font.split(`"${family}", `)[1]}` });

    const again = renderPage(ctx, dl, { pxPerPt: 1, resources: doc.cache });
    expect(again.pendingFonts).toBe(0);
    expect(again.text.pack).toBe(1);
    expect(pages.repaint()).toBe(0);
    expect(requests.filter((u) => u.endsWith(".ttf")).length).toBe(1);
    pages.dispose();
  });

  test("a Latin run never asks for the pack", async () => {
    const { root, fetch, requests } = packRelease(FONT);
    const kernel = {} as ReactorKernelClient;
    const pages = new VectorPages(kernel);
    attachFontPack(kernel, `${root}/v3.0.0/wolf_web.wasm`, fetch);
    const doc = pages.forDoc("doc-2" as never);
    const dl = page("Hello");
    await doc.cache.prepare(dl);
    const stats = renderPage(recordingContext().ctx, dl, { pxPerPt: 1, resources: doc.cache });
    expect(stats.pendingFonts).toBe(0);
    expect(stats.text.pack).toBe(0);
    expect(requests).toEqual([]);
    pages.dispose();
  });

  test("a face that fails its checksum is refused and recorded; the page keeps its own drawing", async () => {
    const added = fakeFontFaces();
    const { root, fetch } = packRelease(encoder.encode("tampered bytes"));
    const kernel = {} as ReactorKernelClient;
    const pages = new VectorPages(kernel);
    const pack = attachFontPack(kernel, `${root}/v3.0.0/wolf_web.wasm`, fetch);
    const doc = pages.forDoc("doc-3" as never);
    const dl = page("สวัสดี");
    await doc.cache.prepare(dl);
    renderPage(recordingContext().ctx, dl, { pxPerPt: 1, resources: doc.cache });
    await pack.loadFace(pack.manifest!.fonts[0]!).catch(() => {});
    await Promise.resolve();
    const stats = renderPage(recordingContext().ctx, dl, { pxPerPt: 1, resources: doc.cache });
    expect(stats.pendingFonts).toBe(0);
    expect(stats.text.pack).toBe(0);
    expect(added).toEqual([]);
    expect(pages.store.failures.get(`${root}/v3.0.0/fonts/${thai.file}`)).toStartWith("checksum-mismatch: ");
    pages.dispose();
  });
});
