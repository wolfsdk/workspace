import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ENGINE_CHANNEL,
  ENGINE_FORMATS,
  ENGINE_MODULE_NAME,
  EngineLoadError,
  type EngineLoadCode,
  type EngineFormat,
  checksumOf,
  engineModuleName,
  fetchEngineBytes,
  inferEngineFormat,
  resolveEngine,
  sha256Hex,
} from "../src/loader.ts";

const CHANNEL = "https://downloads.test/wolf";
const MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const encoder = new TextEncoder();

type Route = Uint8Array | string | number | Error;

/** A `fetch` that serves `routes` by exact URL (404 for anything else) and
 * records every URL it was asked for. */
function fakeFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (typeof route === "number") return new Response("", { status: route, statusText: "Nope" });
    if (route === undefined) return new Response("", { status: 404, statusText: "Not Found" });
    const body = typeof route === "string" ? encoder.encode(route) : route;
    return new Response(body.slice(), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requested };
}

async function failure(promise: Promise<unknown>): Promise<{ code: EngineLoadCode; url: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineLoadError);
    const error = e as EngineLoadError;
    return { code: error.code, url: error.url, message: error.message };
  }
  throw new Error("expected an EngineLoadError");
}

describe("checksumOf", () => {
  const hex = "a".repeat(64);
  test("finds exactly one valid line, with or without a leading *", () => {
    expect(checksumOf(`${hex}  ${ENGINE_MODULE_NAME}\n${"b".repeat(64)}  other.wasm\n`, ENGINE_MODULE_NAME)).toBe(hex);
    expect(checksumOf(`${hex} *${ENGINE_MODULE_NAME}\r\n`, ENGINE_MODULE_NAME)).toBe(hex);
    expect(checksumOf(`${hex.toUpperCase()}  ${ENGINE_MODULE_NAME}`, ENGINE_MODULE_NAME)).toBe(hex);
  });

  test("refuses a missing, duplicated or malformed entry", () => {
    expect(checksumOf(`${hex}  other.wasm`, ENGINE_MODULE_NAME)).toBeNull();
    expect(checksumOf(`${hex}  ${ENGINE_MODULE_NAME}\n${hex}  ${ENGINE_MODULE_NAME}`, ENGINE_MODULE_NAME)).toBeNull();
    expect(checksumOf(`${"a".repeat(63)}  ${ENGINE_MODULE_NAME}`, ENGINE_MODULE_NAME)).toBeNull();
    expect(checksumOf(`${hex}  ${ENGINE_MODULE_NAME} extra`, ENGINE_MODULE_NAME)).toBeNull();
    expect(checksumOf("", ENGINE_MODULE_NAME)).toBeNull();
  });
});

describe("resolveEngine", () => {
  test("an exact url skips the channel and keeps a given checksum, lowercased", async () => {
    const { fetcher, requested } = fakeFetch({});
    const sha = "C".repeat(64);
    expect(await resolveEngine({ url: "https://cdn.test/w.wasm", fetch: fetcher })).toEqual({
      url: "https://cdn.test/w.wasm",
      version: null,
      sha256: null,
    });
    expect(await resolveEngine({ url: new URL("https://cdn.test/w.wasm"), sha256: sha, fetch: fetcher })).toEqual({
      url: "https://cdn.test/w.wasm",
      version: null,
      sha256: "c".repeat(64),
    });
    expect(requested).toEqual([]);
  });

  test("reads latest.txt and the module line of SHA256SUMS", async () => {
    const sha = await sha256Hex(MODULE);
    const { fetcher, requested } = fakeFetch({
      [`${CHANNEL}/latest.txt`]: "0.2.24\n",
      [`${CHANNEL}/v0.2.24/SHA256SUMS`]: `${"d".repeat(64)}  wolf\n${sha}  ${ENGINE_MODULE_NAME}\n`,
    });
    expect(await resolveEngine({ channel: `${CHANNEL}/`, fetch: fetcher })).toEqual({
      url: `${CHANNEL}/v0.2.24/${ENGINE_MODULE_NAME}`,
      version: "0.2.24",
      sha256: sha,
    });
    expect(requested).toEqual([`${CHANNEL}/latest.txt`, `${CHANNEL}/v0.2.24/SHA256SUMS`]);
  });

  test("a given version skips latest.txt; a given checksum skips SHA256SUMS", async () => {
    const { fetcher, requested } = fakeFetch({ [`${CHANNEL}/v1.0.0-rc.1/SHA256SUMS`]: `${"e".repeat(64)}  ${ENGINE_MODULE_NAME}` });
    expect((await resolveEngine({ channel: CHANNEL, version: "1.0.0-rc.1", fetch: fetcher })).sha256).toBe("e".repeat(64));
    expect(requested).toEqual([`${CHANNEL}/v1.0.0-rc.1/SHA256SUMS`]);
    const given = await resolveEngine({ channel: CHANNEL, version: "1.0.0", sha256: "f".repeat(64), fetch: fetcher });
    expect(given).toEqual({ url: `${CHANNEL}/v1.0.0/${ENGINE_MODULE_NAME}`, version: "1.0.0", sha256: "f".repeat(64) });
    expect(requested).toHaveLength(1);
  });

  test("defaults to the public channel", async () => {
    const { fetcher, requested } = fakeFetch({});
    await failure(resolveEngine({ fetch: fetcher }));
    expect(requested).toEqual([`${DEFAULT_ENGINE_CHANNEL}/latest.txt`]);
  });

  test("latest.txt unreachable or answering an HTTP error is channel-unreachable", async () => {
    const offline = fakeFetch({ [`${CHANNEL}/latest.txt`]: new TypeError("Failed to fetch") });
    expect(await failure(resolveEngine({ channel: CHANNEL, fetch: offline.fetcher }))).toMatchObject({
      code: "channel-unreachable",
      url: `${CHANNEL}/latest.txt`,
    });
    const missing = fakeFetch({});
    expect((await failure(resolveEngine({ channel: CHANNEL, fetch: missing.fetcher }))).code).toBe(
      "channel-unreachable",
    );
  });

  test("a version that is not MAJOR.MINOR.PATCH is bad-version", async () => {
    const { fetcher } = fakeFetch({ [`${CHANNEL}/latest.txt`]: "<html>latest</html>" });
    expect(await failure(resolveEngine({ channel: CHANNEL, fetch: fetcher }))).toMatchObject({
      code: "bad-version",
      url: `${CHANNEL}/latest.txt`,
    });
    expect((await failure(resolveEngine({ channel: CHANNEL, version: "v0.2", fetch: fetcher }))).code).toBe(
      "bad-version",
    );
  });

  test("SHA256SUMS unreachable is channel-unreachable; missing or without the module is missing-checksum", async () => {
    const sums = `${CHANNEL}/v0.2.24/SHA256SUMS`;
    const offline = fakeFetch({ [sums]: new TypeError("Failed to fetch") });
    expect((await failure(resolveEngine({ channel: CHANNEL, version: "0.2.24", fetch: offline.fetcher }))).code).toBe(
      "channel-unreachable",
    );
    const missing = fakeFetch({});
    expect(await failure(resolveEngine({ channel: CHANNEL, version: "0.2.24", fetch: missing.fetcher }))).toMatchObject({
      code: "missing-checksum",
      url: sums,
    });
    const other = fakeFetch({ [sums]: `${"a".repeat(64)}  wolf` });
    expect((await failure(resolveEngine({ channel: CHANNEL, version: "0.2.24", fetch: other.fetcher }))).code).toBe(
      "missing-checksum",
    );
  });

  test("a given checksum that is not 64 hex digits is missing-checksum", async () => {
    expect((await failure(resolveEngine({ url: "https://cdn.test/w.wasm", sha256: "abc" }))).code).toBe(
      "missing-checksum",
    );
  });
});

describe("engineModuleName", () => {
  test("is the module for one format, or the module for every format without one", () => {
    expect(engineModuleName()).toBe("wolf_web.wasm");
    expect(engineModuleName()).toBe(ENGINE_MODULE_NAME);
    expect(engineModuleName("docx")).toBe("wolf_web_docx.wasm");
    expect(engineModuleName("xlsx")).toBe("wolf_web_xlsx.wasm");
    expect(engineModuleName("pptx")).toBe("wolf_web_pptx.wasm");
    expect(engineModuleName("pdf")).toBe("wolf_web_pdf.wasm");
    expect([...ENGINE_FORMATS]).toEqual(["docx", "xlsx", "pptx", "pdf"]);
  });
});

describe("resolveEngine with a format", () => {
  const release = `${CHANNEL}/v0.3.0`;
  const sums = `${release}/SHA256SUMS`;
  const mono = "1".repeat(64);
  const docx = "2".repeat(64);
  const xlsx = "3".repeat(64);
  const manifest = (...lines: [string, string][]) => lines.map(([hash, name]) => `${hash}  ${name}\n`).join("");

  test("a release that lists the module of the format resolves to it, with its own checksum", async () => {
    const { fetcher, requested } = fakeFetch({
      [`${CHANNEL}/latest.txt`]: "0.3.0\n",
      [sums]: manifest([mono, "wolf_web.wasm"], [docx, "wolf_web_docx.wasm"], [xlsx, "wolf_web_xlsx.wasm"]),
    });
    expect(await resolveEngine({ channel: CHANNEL, format: "docx", fetch: fetcher })).toEqual({
      url: `${release}/wolf_web_docx.wasm`,
      version: "0.3.0",
      sha256: docx,
    });
    expect((await resolveEngine({ channel: CHANNEL, format: "xlsx", fetch: fetcher })).sha256).toBe(xlsx);
    expect(requested).toEqual([`${CHANNEL}/latest.txt`, sums, `${CHANNEL}/latest.txt`, sums]);
  });

  test("a release without the module of the format falls back to wolf_web.wasm and its checksum", async () => {
    const { fetcher, requested } = fakeFetch({
      [sums]: manifest([mono, "wolf_web.wasm"], [docx, "wolf_web_docx.wasm"]),
    });
    expect(await resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "pptx", fetch: fetcher })).toEqual({
      url: `${release}/wolf_web.wasm`,
      version: "0.3.0",
      sha256: mono,
    });
    // One SHA256SUMS answer decides both the miss and the fallback checksum.
    expect(requested).toEqual([sums]);
  });

  test("a given sha256 is kept: for the per-format module on a hit, for the fallback on a miss", async () => {
    const pin = "A".repeat(64);
    const hit = fakeFetch({ [sums]: manifest([mono, "wolf_web.wasm"], [docx, "wolf_web_docx.wasm"]) });
    expect(await resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", sha256: pin, fetch: hit.fetcher })).toEqual({
      url: `${release}/wolf_web_docx.wasm`,
      version: "0.3.0",
      sha256: "a".repeat(64),
    });
    const miss = fakeFetch({ [sums]: manifest([mono, "wolf_web.wasm"]) });
    expect(await resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", sha256: pin, fetch: miss.fetcher })).toEqual({
      url: `${release}/wolf_web.wasm`,
      version: "0.3.0",
      sha256: "a".repeat(64),
    });
    expect(hit.requested).toEqual([sums]);
    expect(miss.requested).toEqual([sums]);
  });

  test("a given sha256 without a format still skips SHA256SUMS, and an exact url ignores the format", async () => {
    const { fetcher, requested } = fakeFetch({});
    expect(await resolveEngine({ channel: CHANNEL, version: "0.3.0", sha256: "b".repeat(64), fetch: fetcher })).toEqual({
      url: `${release}/wolf_web.wasm`,
      version: "0.3.0",
      sha256: "b".repeat(64),
    });
    expect(await resolveEngine({ url: "https://cdn.test/m.wasm", format: "pdf", fetch: fetcher })).toEqual({
      url: "https://cdn.test/m.wasm",
      version: null,
      sha256: null,
    });
    expect(requested).toEqual([]);
  });

  test("a format that is not docx, xlsx, pptx or pdf is bad-format, before any request", async () => {
    const { fetcher, requested } = fakeFetch({});
    for (const format of ["doc", "../docx", "DOCX", "docx.wasm"]) {
      expect(
        await failure(resolveEngine({ channel: CHANNEL, format: format as EngineFormat, fetch: fetcher })),
      ).toMatchObject({ code: "bad-format", url: CHANNEL });
    }
    expect(requested).toEqual([]);
  });

  test("refuses a release whose SHA256SUMS lists neither module, or answers an HTTP error", async () => {
    const neither = fakeFetch({ [sums]: manifest([docx, "wolf_web_xlsx.wasm"], [mono, "wolf"]) });
    expect(
      await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "pptx", fetch: neither.fetcher })),
    ).toMatchObject({ code: "missing-checksum", url: sums });
    const message = (
      await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "pptx", fetch: neither.fetcher }))
    ).message;
    expect(message).toContain("wolf_web_pptx.wasm or wolf_web.wasm");
    const pinned = await failure(
      resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "pptx", sha256: mono, fetch: neither.fetcher }),
    );
    expect(pinned.code).toBe("missing-checksum");
    const missing = fakeFetch({});
    expect(
      (await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", fetch: missing.fetcher }))).code,
    ).toBe("missing-checksum");
    const offline = fakeFetch({ [sums]: new TypeError("Failed to fetch") });
    expect(
      (await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", fetch: offline.fetcher }))).code,
    ).toBe("channel-unreachable");
  });

  test("a corrupt per-format line is refused, never a reason to fall back", async () => {
    const malformed = fakeFetch({ [sums]: `${"c".repeat(63)}  wolf_web_docx.wasm\n${mono}  wolf_web.wasm\n` });
    expect(
      await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", fetch: malformed.fetcher })),
    ).toMatchObject({ code: "missing-checksum", url: sums });
    const twice = fakeFetch({ [sums]: manifest([docx, "wolf_web_docx.wasm"], [docx, "wolf_web_docx.wasm"], [mono, "wolf_web.wasm"]) });
    expect(
      (await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", fetch: twice.fetcher }))).code,
    ).toBe("missing-checksum");
    // The fallback module's own line has to be valid too.
    const badFallback = fakeFetch({ [sums]: `${mono}  wolf_web.wasm\n${mono}  wolf_web.wasm\n` });
    expect(
      (await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "pdf", fetch: badFallback.fetcher }))).code,
    ).toBe("missing-checksum");
  });

  test("a given sha256 that is not 64 hex digits is refused before SHA256SUMS is read", async () => {
    const { fetcher, requested } = fakeFetch({ [sums]: manifest([docx, "wolf_web_docx.wasm"]) });
    expect(
      await failure(resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", sha256: "abc", fetch: fetcher })),
    ).toMatchObject({ code: "missing-checksum", url: `${release}/wolf_web_docx.wasm` });
    expect(requested).toEqual([]);
  });

  test("the resolved module downloads, and refuses bytes another checksum describes", async () => {
    const good = await sha256Hex(MODULE);
    const { fetcher } = fakeFetch({
      [sums]: manifest([mono, "wolf_web.wasm"], [good, "wolf_web_docx.wasm"], [mono, "wolf_web_xlsx.wasm"]),
      [`${release}/wolf_web_docx.wasm`]: MODULE,
      [`${release}/wolf_web_xlsx.wasm`]: MODULE,
    });
    const docxModule = await resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "docx", fetch: fetcher });
    expect(await fetchEngineBytes(docxModule, { fetch: fetcher })).toEqual(MODULE);
    const xlsxModule = await resolveEngine({ channel: CHANNEL, version: "0.3.0", format: "xlsx", fetch: fetcher });
    expect(await failure(fetchEngineBytes(xlsxModule, { fetch: fetcher }))).toMatchObject({
      code: "checksum-mismatch",
      url: `${release}/wolf_web_xlsx.wasm`,
    });
  });

  test("each call reads the release afresh: one latest.txt and one SHA256SUMS per resolve, nothing kept between calls", async () => {
    const files: Record<string, Route> = {
      [`${CHANNEL}/latest.txt`]: "0.3.0",
      [sums]: manifest([mono, "wolf_web.wasm"]),
    };
    const { fetcher, requested } = fakeFetch(files);
    expect((await resolveEngine({ channel: CHANNEL, format: "docx", fetch: fetcher })).url).toBe(`${release}/wolf_web.wasm`);
    // The release gains the per-format module: the next resolve sees it.
    files[sums] = manifest([mono, "wolf_web.wasm"], [docx, "wolf_web_docx.wasm"]);
    expect((await resolveEngine({ channel: CHANNEL, format: "docx", fetch: fetcher })).url).toBe(
      `${release}/wolf_web_docx.wasm`,
    );
    expect(requested).toEqual([`${CHANNEL}/latest.txt`, sums, `${CHANNEL}/latest.txt`, sums]);
  });
});

describe("fetchEngineBytes", () => {
  const url = `${CHANNEL}/v0.2.24/${ENGINE_MODULE_NAME}`;

  test("returns the bytes when the checksum matches, and unchecked bytes without one", async () => {
    const { fetcher } = fakeFetch({ [url]: MODULE });
    const sha256 = await sha256Hex(MODULE);
    expect(await fetchEngineBytes({ url, version: "0.2.24", sha256 }, { fetch: fetcher })).toEqual(MODULE);
    expect(await fetchEngineBytes({ url, version: null, sha256: null }, { fetch: fetcher })).toEqual(MODULE);
  });

  test("refuses bytes with another checksum", async () => {
    const { fetcher } = fakeFetch({ [url]: MODULE });
    const result = await failure(fetchEngineBytes({ url, version: "0.2.24", sha256: "0".repeat(64) }, { fetch: fetcher }));
    expect(result).toMatchObject({ code: "checksum-mismatch", url });
    expect(result.message).toContain(await sha256Hex(MODULE));
  });

  test("a network failure or an HTTP error is http-error", async () => {
    const offline = fakeFetch({ [url]: new TypeError("Failed to fetch") });
    expect(await failure(fetchEngineBytes({ url, version: null, sha256: null }, { fetch: offline.fetcher }))).toMatchObject({
      code: "http-error",
      url,
    });
    const refused = fakeFetch({ [url]: 403 });
    const result = await failure(fetchEngineBytes({ url, version: null, sha256: null }, { fetch: refused.fetcher }));
    expect(result.code).toBe("http-error");
    expect(result.message).toContain("403");
  });
});

describe("sha256Hex", () => {
  test("is the lowercase hex SHA-256", async () => {
    expect(await sha256Hex(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

/** A stored (uncompressed) ZIP of `entries` in order: local file headers only, as `inferEngineFormat` reads them. */
function zip(entries: [name: string, body: string][], streamed = false): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, body] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(body);
    const header = new Uint8Array(30);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, streamed ? 8 : 0, true);
    dv.setUint32(18, streamed ? 0 : data.length, true);
    dv.setUint32(22, streamed ? 0 : data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    parts.push(header, nameBytes, data);
    // A streamed entry's data descriptor (signature, crc, sizes) follows its data.
    if (streamed) parts.push(new Uint8Array([0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  }
  // Central directory end record, so the bytes are a whole archive.
  parts.push(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("inferEngineFormat", () => {
  const types: [string, string] = ["[Content_Types].xml", "<Types/>"];
  const rels: [string, string] = ["_rels/.rels", "<Relationships/>"];

  test("%PDF- bytes are pdf, whatever the name says", () => {
    expect(inferEngineFormat({ bytes: encoder.encode("%PDF-1.7\n%\xe2\xe3\n1 0 obj") })).toBe("pdf");
    expect(inferEngineFormat({ bytes: encoder.encode("%PDF-2.0"), name: "report.docx" })).toBe("pdf");
  });

  test("an OOXML package is told by its part names, in header order", () => {
    expect(inferEngineFormat({ bytes: zip([types, rels, ["word/document.xml", "<w:document/>"]]) })).toBe("docx");
    expect(inferEngineFormat({ bytes: zip([types, ["xl/workbook.xml", "<workbook/>"]]) })).toBe("xlsx");
    expect(inferEngineFormat({ bytes: zip([types, rels, ["ppt/presentation.xml", "<p:presentation/>"]]) })).toBe("pptx");
    // The bytes win over a misleading name.
    expect(inferEngineFormat({ bytes: zip([["xl/workbook.xml", ""]]), name: "deck.pptx" })).toBe("xlsx");
  });

  test("streamed entries (sizes after the data) are skipped by searching for the next header", () => {
    expect(inferEngineFormat({ bytes: zip([types, rels, ["word/document.xml", "<w:document/>"]], true) })).toBe("docx");
  });

  test("a ZIP without OOXML parts and other bytes fall back to the name, then the URL", () => {
    const plain = zip([["readme.txt", "hello"]]);
    expect(inferEngineFormat({ bytes: plain })).toBeUndefined();
    expect(inferEngineFormat({ bytes: plain, name: "Book1.XLSX" })).toBe("xlsx");
    expect(inferEngineFormat({ bytes: encoder.encode("not a document"), url: "https://cdn.test/a/memo.docx" })).toBe("docx");
  });

  test("names and URLs: any case, query and fragment ignored, name before URL", () => {
    expect(inferEngineFormat({ name: "Q3 Deck.PPTX" })).toBe("pptx");
    expect(inferEngineFormat({ name: "scan.pdf" })).toBe("pdf");
    expect(inferEngineFormat({ url: "https://cdn.test/files/memo.docx?token=abc&v=2#page=3" })).toBe("docx");
    expect(inferEngineFormat({ url: "/sheets/budget.xlsx#Sheet2" })).toBe("xlsx");
    expect(inferEngineFormat({ name: "budget.xlsx", url: "https://cdn.test/memo.docx" })).toBe("xlsx");
    expect(inferEngineFormat({ name: "notes.txt", url: "https://cdn.test/memo.docx" })).toBe("docx");
  });

  test("nothing to go on is undefined", () => {
    expect(inferEngineFormat({})).toBeUndefined();
    expect(inferEngineFormat({ name: "archive.docx.zip" })).toBeUndefined();
    expect(inferEngineFormat({ url: "https://cdn.test/download?file=memo.docx" })).toBeUndefined();
    expect(inferEngineFormat({ bytes: new Uint8Array([0x50, 0x4b]) })).toBeUndefined();
    expect(inferEngineFormat({ name: null, url: null, bytes: null })).toBeUndefined();
  });
});
