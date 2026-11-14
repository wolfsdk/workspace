import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FONT_PACK_NAME,
  FontPackError,
  FontPackLoader,
  WOLF_WEB_FONT_PACK_SCHEMA,
  detectExtendedScripts,
  extendedScriptOf,
  fontPackUrl,
  parseFontPackManifest,
  type FontPackEntry,
} from "../src/loader.ts";
import { ResourceStore } from "../src/vector/index.ts";

const ROOT = join(import.meta.dir, "../../../../..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A TrueType face with one square glyph (gid 1, advance 600 of 1000 units) mapped from each code
 * point of `cps` (cmap format 12), enough for `parseSfnt`.
 */
function ttf(cps: number[]): Uint8Array {
  const u16 = (...v: number[]) => v.flatMap((n) => [(n >> 8) & 0xff, n & 0xff]);
  const u32 = (...v: number[]) => v.flatMap((n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const head = new Array(54).fill(0);
  head.splice(18, 2, ...u16(1000));
  head.splice(36, 8, ...u16(0, 0, 500, 500));
  const hhea = new Array(36).fill(0);
  hhea.splice(4, 4, ...u16(800, 0x10000 - 200));
  hhea.splice(34, 2, ...u16(2));
  const maxp = [...u32(0x00005000), ...u16(2)];
  const hmtx = [...u16(600, 0), ...u16(600, 0)];
  // One contour, four on-curve points (0,0) (500,0) (500,500) (0,500) as int16 deltas.
  const square = [...u16(1, 0, 0, 500, 500), ...u16(3), ...u16(0), 1, 1, 1, 1, ...u16(0, 500, 0, 0x10000 - 500), ...u16(0, 0, 500, 0), 0, 0];
  const loca = u16(0, 0, square.length / 2);
  const cmap = [
    ...u16(0, 1),
    ...u16(3, 10),
    ...u32(12),
    ...u16(12, 0),
    ...u32(16 + 12 * cps.length, 0, cps.length),
    ...cps.flatMap((cp) => u32(cp, cp, 1)),
  ];
  const tables: [string, number[]][] = [
    ["cmap", cmap],
    ["glyf", square],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
  ];
  let offset = 12 + 16 * tables.length;
  const directory = [...u32(0x00010000), ...u16(tables.length, 0, 0, 0)];
  const data: number[] = [];
  for (const [tag, body] of tables) {
    directory.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(0, offset, body.length));
    const padded = [...body, ...new Array((4 - (body.length % 4)) % 4).fill(0)];
    data.push(...padded);
    offset += padded.length;
  }
  return new Uint8Array([...directory, ...data]);
}

type Route = Uint8Array | string | number | object;

/** A `fetch` that serves `routes` by URL (404 otherwise; a number is that status) and counts requests. */
function serve(routes: Record<string, Route>) {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("", { status: 404, statusText: "Not Found" });
    if (typeof route === "number") return new Response("", { status: route, statusText: "Nope" });
    if (route instanceof Uint8Array) return new Response(route.slice(), { status: 200 });
    return new Response(typeof route === "string" ? route : JSON.stringify(route), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetcher, requests };
}

const THAI = ttf([0x0e01, 0x0e02, 0x0e33]);
const HEBREW = ttf([0x05d0, 0x05d1]);

function entry(file: string, family: string, style: string, script: string | null, bytes: Uint8Array): FontPackEntry {
  return { file, family, style, script, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

let packs = 0;
/** A fresh release root per test, serving `fonts` (file -> bytes) and the manifest of `records`. */
function release(records: FontPackEntry[], fonts: Record<string, Uint8Array>) {
  const base = `https://cdn.test/wolf${++packs}/v1.0.0`;
  const routes: Record<string, Route> = { [`${base}/fonts/${FONT_PACK_NAME}`]: { schema: WOLF_WEB_FONT_PACK_SCHEMA, fonts: records } };
  for (const [file, bytes] of Object.entries(fonts)) routes[`${base}/fonts/${file}`] = bytes;
  const served = serve(routes);
  const loader = new FontPackLoader(fontPackUrl(`${base}/wolf_web_docx.wasm`), { fetch: served.fetch });
  return { base, loader, ...served };
}

/** The extended pack's records as `scripts/build_wolf_web.py` stages them, or null without python3 and the fonts. */
function buildRecords(): (FontPackEntry & { path: string })[] | null {
  const run = spawnSync(
    "python3",
    [
      "-c",
      "import json, sys; sys.path.insert(0, 'scripts'); import build_wolf_web as b\n" +
        "print(json.dumps([dict(r, path=str(b.FONT_CRATE / 'fonts' / r['file'])) for r in b.extended_fonts()]))",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return run.status === 0 ? JSON.parse(run.stdout) : null;
}
const BUILD = existsSync(join(ROOT, "scripts/build_wolf_web.py")) ? buildRecords() : null;

describe("manifest", () => {
  const good = entry("NotoSansThai-Regular.ttf", "Noto Sans Thai", "regular", "thai", THAI);

  test("resolves next to the engine module", () => {
    expect(fontPackUrl("https://cdn.test/wolf/v1.2.3/wolf_web_xlsx.wasm")).toBe(
      "https://cdn.test/wolf/v1.2.3/fonts/wolf_web_font_pack.json",
    );
  });

  test("accepts a v1 manifest and keeps each record", () => {
    const manifest = parseFontPackManifest({ schema: WOLF_WEB_FONT_PACK_SCHEMA, fonts: [good, { ...good, file: "Lateef-Bold.ttf", script: null }] });
    expect(manifest.fonts).toEqual([good, { ...good, file: "Lateef-Bold.ttf", script: null }]);
  });

  test("refuses another schema, unsafe file names, repeats and bad checksums", () => {
    const refused = (fonts: unknown[], schema = WOLF_WEB_FONT_PACK_SCHEMA) => {
      try {
        parseFontPackManifest({ schema, fonts });
      } catch (e) {
        expect(e).toBeInstanceOf(FontPackError);
        return (e as FontPackError).code;
      }
      return "accepted";
    };
    expect(refused([good], "wolf-web-font-pack.v2" as typeof WOLF_WEB_FONT_PACK_SCHEMA)).toBe("bad-manifest");
    for (const file of ["../etc/passwd.ttf", "sub/dir.ttf", "/abs.ttf", "a..b.ttf", "font.woff2", "font ttf", ""])
      expect(refused([{ ...good, file }])).toBe("bad-manifest");
    expect(refused([good, good])).toBe("bad-manifest");
    expect(refused([{ ...good, sha256: good.sha256.toUpperCase() }])).toBe("bad-manifest");
    expect(refused([{ ...good, sha256: good.sha256.slice(1) }])).toBe("bad-manifest");
    expect(refused([{ ...good, bytes: 0 }])).toBe("bad-manifest");
    expect(refused([{ ...good, family: "" }])).toBe("bad-manifest");
    expect(refused([{ ...good, file: "Noto.otf" }, { ...good, file: "Noto.ttc" }])).toBe("accepted");
  });
});

describe("scripts", () => {
  const SAMPLES: Record<string, string> = {
    armenian: "Բարեւ",
    hebrew: "שלום",
    arabic: "مرحبا",
    devanagari: "नमस्ते",
    bengali: "নমস্কার",
    gurmukhi: "ਸਤਿ",
    gujarati: "નમસ્તે",
    oriya: "ନମସ୍କାର",
    tamil: "வணக்கம்",
    telugu: "నమస్తే",
    kannada: "ನಮಸ್ಕಾರ",
    malayalam: "നമസ്കാരം",
    sinhala: "ආයුබෝවන්",
    thai: "สวัสดี",
    emoji: "🎉",
  };

  test("each script of the pack is told by its text", () => {
    for (const [script, text] of Object.entries(SAMPLES)) expect(detectExtendedScripts(text)).toEqual([script]);
  });

  test("text the engine modules cover needs nothing; mixed text lists each script once, in order", () => {
    expect(detectExtendedScripts("Hello, World! Ünïcödé €100 \u2014 中文 日本語 한국어 Ελληνικά Кириллица")).toEqual([]);
    expect(detectExtendedScripts("Total ฿100 สวัสดี 🎉 and שלום, then สวัสดี again 🎉")).toEqual(["thai", "emoji", "hebrew"]);
    expect(extendedScriptOf(0x41)).toBeNull();
    expect(extendedScriptOf(0x1f600)).toBe("emoji");
  });

  test.skipIf(!BUILD)("the script tags are exactly those scripts/build_wolf_web.py stages", () => {
    const tags = new Set(BUILD!.map((r) => r.script).filter((s): s is string => !!s));
    expect([...tags].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  test.skipIf(!BUILD)("the staged manifest parses, and a real face loads, verifies and covers its script", async () => {
    const records = BUILD!.map(({ path: _path, ...record }) => record);
    expect(parseFontPackManifest({ schema: WOLF_WEB_FONT_PACK_SCHEMA, fonts: records }).fonts.length).toBe(records.length);
    const thai = BUILD!.find((r) => r.script === "thai" && r.style === "regular")!;
    const bytes = new Uint8Array(readFileSync(thai.path));
    const { file, family, style, script, sha256: digest } = thai;
    const pack = release([{ file, family, style, script, bytes: bytes.byteLength, sha256: digest }], { [file]: bytes });
    await pack.loader.loadManifest();
    const found = pack.loader.find({ scripts: ["thai"] })!;
    const face = await pack.loader.loadFace(found);
    expect(face.outline!.glyphFor(0x0e2a)).toBeGreaterThan(0);
  });
});

describe("FontPackLoader", () => {
  const thaiRegular = entry("NotoSansThai-Regular.ttf", "Noto Sans Thai", "regular", "thai", THAI);
  const thaiBold = entry("NotoSansThai-Bold.ttf", "Noto Sans Thai", "bold", "thai", THAI);
  const hebrew = entry("NotoSansHebrew-Regular.ttf", "Noto Sans Hebrew", "regular", "hebrew", HEBREW);
  const lateef = entry("Lateef-Regular.ttf", "Lateef", "regular", null, HEBREW);

  test("finds by family and style (regular when the style is missing), else by script", async () => {
    const { loader } = release([thaiRegular, thaiBold, hebrew, lateef], {});
    expect(loader.find({ scripts: ["thai"] })).toBeNull(); // before the manifest
    await loader.loadManifest();
    expect(loader.find({ family: "noto sans THAI", bold: true })).toEqual(thaiBold);
    expect(loader.find({ family: "Noto Sans Thai", italic: true })).toEqual(thaiRegular);
    expect(loader.find({ family: "Noto Sans Hebrew", bold: true, italic: true })).toEqual(hebrew);
    expect(loader.find({ family: "Lateef" })).toEqual(lateef);
    expect(loader.find({ family: "Calibri", scripts: ["emoji", "hebrew"] })).toEqual(hebrew);
    expect(loader.find({ family: "Calibri", bold: true, scripts: ["thai"] })).toEqual(thaiBold);
    expect(loader.find({ family: "Calibri" })).toBeNull();
  });

  test("downloads each face once, verifies it, and parses its outlines", async () => {
    const { loader, base, requests } = release([thaiRegular], { [thaiRegular.file]: THAI });
    await Promise.all([loader.loadManifest(), loader.loadManifest()]);
    const [a, b] = await Promise.all([loader.loadFace(thaiRegular), loader.loadFace(thaiRegular)]);
    expect(a).toBe(b);
    expect(await loader.loadFace(thaiRegular)).toBe(a);
    expect(loader.face(thaiRegular)).toBe(a);
    expect(a.outline!.glyphFor(0x0e01)).toBe(1);
    expect(a.outline!.outline(1)!.cmds.length).toBeGreaterThan(0);
    expect(a.cssFamily).toBeNull(); // no FontFaceSet here
    expect(requests).toEqual([`${base}/fonts/${FONT_PACK_NAME}`, `${base}/fonts/${thaiRegular.file}`]);
  });

  test("resolves manifest and font URLs when the engine module URL is path-relative", async () => {
    const manifestUrl = fontPackUrl("/channel/v1.2.0/wolf_web_docx.wasm");
    expect(manifestUrl).toBe("/channel/v1.2.0/fonts/wolf_web_font_pack.json");
    const served = serve({
      [manifestUrl]: { schema: WOLF_WEB_FONT_PACK_SCHEMA, fonts: [thaiRegular] },
      [`/channel/v1.2.0/fonts/${thaiRegular.file}`]: THAI,
    });
    const loader = new FontPackLoader(manifestUrl, { fetch: served.fetch });
    await loader.loadManifest();
    const face = await loader.loadFace(thaiRegular);
    expect(face.outline!.glyphFor(0x0e01)).toBeGreaterThan(0);
    expect(served.requests).toEqual([manifestUrl, `/channel/v1.2.0/fonts/${thaiRegular.file}`]);
  });

  test("a release without a pack (404) is null quietly", async () => {
    const { fetch, requests } = serve({});
    const loader = new FontPackLoader(fontPackUrl("http://localhost:8080/fixtures/wolf_web.wasm"), { fetch });
    expect(await loader.loadManifest()).toBeNull();
    expect(await loader.loadManifest()).toBeNull();
    expect(loader.manifest).toBeNull();
    expect(loader.failures.size).toBe(0);
    expect(requests).toEqual(["http://localhost:8080/fixtures/fonts/wolf_web_font_pack.json"]);
  });

  test("another HTTP error or a refused manifest is null with the reason", async () => {
    const url = "https://cdn.test/broken/fonts/wolf_web_font_pack.json";
    const failing = new FontPackLoader(url, { fetch: serve({ [url]: 503 }).fetch });
    expect(await failing.loadManifest()).toBeNull();
    expect(failing.failures.get(url)).toContain("503");
    const refused = new FontPackLoader(url, { fetch: serve({ [url]: { schema: "other", fonts: [] } }).fetch });
    expect(await refused.loadManifest()).toBeNull();
    expect(refused.failures.get(url)).toContain(WOLF_WEB_FONT_PACK_SCHEMA);
  });

  test("bytes that do not match the checksum are refused before parsing, and not fetched again", async () => {
    const tampered = ttf([0x0e01, 0x0e02]);
    const { loader, base, requests } = release([thaiRegular], { [thaiRegular.file]: tampered });
    await loader.loadManifest();
    const error = await loader.loadFace(thaiRegular).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FontPackError);
    expect((error as FontPackError).code).toBe("checksum-mismatch");
    expect((error as FontPackError).url).toBe(`${base}/fonts/${thaiRegular.file}`);
    expect(loader.face(thaiRegular)).toBeNull();
    await loader.loadFace(thaiRegular).catch(() => {});
    expect(requests.filter((u) => u.endsWith(".ttf")).length).toBe(1);
    expect(loader.failures.get(`${base}/fonts/${thaiRegular.file}`)).toContain("expected");
  });
});

describe("ResourceStore with a font pack", () => {
  const thai = entry("NotoSansThai-Regular.ttf", "Noto Sans Thai", "regular", "thai", THAI);
  const noFetch = async () => {
    throw new Error("no engine resources here");
  };

  test("a pack face is pending until it arrives, then served synchronously; onFontLoaded fires once per load", async () => {
    const { loader } = release([thai], { [thai.file]: THAI });
    const loaded: (FontPackEntry | null)[] = [];
    const store = new ResourceStore(noFetch, { fontPack: () => loader, onFontLoaded: (e) => loaded.push(e) });
    expect(store.packFace({ scripts: ["thai"] })).toBe("pending"); // manifest
    await store.loadPackManifest();
    expect(store.packFace({ scripts: ["thai"] })).toBe("pending"); // face
    expect(store.packFace({ scripts: ["thai"] })).toBe("pending");
    await loader.loadFace(thai);
    await Promise.resolve();
    const face = store.packFace({ scripts: ["thai"] });
    expect(face).toBe(loader.face(thai)!);
    expect(store.packFace({ scripts: ["hebrew"] })).toBeNull();
    expect(loaded).toEqual([null, thai]);
  });

  test("without a pack nothing is pending", () => {
    expect(new ResourceStore(noFetch).packFace({ scripts: ["thai"] })).toBeNull();
    expect(new ResourceStore(noFetch, { fontPack: () => null }).packFace({ scripts: ["thai"] })).toBeNull();
  });

  test("a checksum mismatch is recorded in failures and the run keeps its engine face", async () => {
    const { loader, base } = release([thai], { [thai.file]: ttf([0x0e01]) });
    const store = new ResourceStore(noFetch, { fontPack: () => loader });
    await store.loadPackManifest();
    expect(store.packFace({ scripts: ["thai"] })).toBe("pending");
    await loader.loadFace(thai).catch(() => {});
    await Promise.resolve();
    expect(store.packFace({ scripts: ["thai"] })).toBeNull();
    expect(store.failures.get(`${base}/fonts/${thai.file}`)).toStartWith("checksum-mismatch: ");
  });
});
