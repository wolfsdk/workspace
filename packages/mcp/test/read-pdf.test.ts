import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { ReadError } from "../src/read/model.ts";
import { openPdf } from "../src/read/pdf.ts";
import { writeZip } from "../src/read/zip.ts";

/** The bytes of `text`, one byte per character (the same as UTF-8 for ASCII). */
function encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) out[at] = text.charCodeAt(at) & 0xff;
  return out;
}

/** The bytes as a string of one character per byte, to embed stream data in a PDF that is built as text. */
function binary(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function hex(bytes: Uint8Array): string {
  return `${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/(.{32})/g, "$1\n")}>`;
}

function ascii85(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 4) {
    const size = Math.min(4, bytes.length - at);
    let value = 0;
    for (let k = 0; k < 4; k++) value = value * 256 + (k < size ? (bytes[at + k] ?? 0) : 0);
    const digits: number[] = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(value % 85);
      value = Math.floor(value / 85);
    }
    out += String.fromCharCode(...digits.slice(0, size + 1).map((digit) => digit + 33));
  }
  return `${out.replace(/(.{20})/g, "$1\n")}~>`;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** PNG row filtering of `data` in rows of `columns` bytes, row n using filter `tags[n % tags.length]`; the last row is padded with spaces. */
function pngEncode(data: Uint8Array, columns: number, tags: readonly number[]): Uint8Array {
  const rows = Math.ceil(data.length / columns);
  const sample = (row: number, column: number): number => (row < 0 || column < 0 ? 0 : (data[row * columns + column] ?? 32));
  const out = new Uint8Array(rows * (columns + 1));
  for (let row = 0; row < rows; row++) {
    const tag = tags[row % tags.length] ?? 0;
    out[row * (columns + 1)] = tag;
    for (let column = 0; column < columns; column++) {
      const left = sample(row, column - 1);
      const up = sample(row - 1, column);
      const upLeft = sample(row - 1, column - 1);
      let predicted = 0;
      if (tag === 1) predicted = left;
      else if (tag === 2) predicted = up;
      else if (tag === 3) predicted = (left + up) >> 1;
      else if (tag === 4) predicted = paeth(left, up, upLeft);
      out[row * (columns + 1) + 1 + column] = (sample(row, column) - predicted) & 0xff;
    }
  }
  return out;
}

/** TIFF predictor 2 (horizontal differencing) of `data` in rows of `columns` bytes, padded with spaces. */
function tiffEncode(data: Uint8Array, columns: number): Uint8Array {
  const rows = Math.ceil(data.length / columns);
  const out = new Uint8Array(rows * columns);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const value = data[row * columns + column] ?? 32;
      const previous = column === 0 ? 0 : (data[row * columns + column - 1] ?? 32);
      out[row * columns + column] = (value - previous) & 0xff;
    }
  }
  return out;
}

/** The object body of a stream with `entries` in its dictionary; `length` is the /Length written (the real one by default). */
function stream(entries: string, data: string, length = data.length): string {
  return `<< ${entries} /Length ${length} >>\nstream\n${data}\nendstream`;
}

function flate(content: string, entries = ""): string {
  return stream(`/Filter /FlateDecode ${entries}`, binary(deflateSync(encode(content))));
}

type Obj = readonly [number, string];

/** A classic PDF: the objects in the order given, then an xref table (right unless `badXref`) and a trailer. */
function classicPdf(objects: readonly Obj[], options: { trailer?: string; badXref?: boolean } = {}): string {
  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const [num, body] of objects) {
    offsets.set(num, out.length);
    out += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const size = Math.max(...objects.map(([num]) => num)) + 1;
  const xref = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let num = 1; num < size; num++) {
    const at = options.badXref ? 7 : (offsets.get(num) ?? 0);
    out += `${String(at).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R${options.trailer ?? ""} >>\nstartxref\n${options.badXref ? 3 : xref}\n%%EOF\n`;
  return out;
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/** A PDF with one page per entry of `contents`: an entry starting with `<<` is the whole content object (a stream with a
 * filter), any other is the text of an unfiltered content stream. The pages inherit a 612 x 792 media box and the font `/F1`
 * (object 3); page i (from 0) is object 4 + 2i and its content object 5 + 2i. `extra` objects must use numbers from 90 up. */
function pagesPdf(
  contents: readonly string[],
  config: { extra?: readonly Obj[]; resources?: string; badXref?: boolean; trailer?: string } = {},
): string {
  const kids = contents.map((_, index) => `${4 + 2 * index} 0 R`).join(" ");
  const objects: Obj[] = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [
      2,
      `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} /MediaBox [0 0 612 792] /Resources << ${config.resources ?? "/Font << /F1 3 0 R >>"} >> >>`,
    ],
    [3, FONT],
  ];
  contents.forEach((body, index) => {
    const content = body.startsWith("<<") ? body : stream("", body);
    objects.push([4 + 2 * index, `<< /Type /Page /Parent 2 0 R /Contents ${5 + 2 * index} 0 R >>`], [5 + 2 * index, content]);
  });
  return classicPdf([...objects, ...(config.extra ?? [])], config);
}

function read(pdf: string | Uint8Array) {
  return openPdf(typeof pdf === "string" ? encode(pdf) : pdf);
}

function readError(run: () => unknown): ReadError {
  try {
    run();
  } catch (error) {
    if (error instanceof ReadError) return error;
    throw error;
  }
  throw new Error("expected a ReadError");
}

const PAGE1 = "BT\n/F1 12 Tf\n14 TL\n72 720 Td\n(Hello \\(World\\)) Tj\nT*\n[(Kern) 20 (ed) -300 (words)] TJ\nT*\n<48656C6C6F> Tj\nET";
const PAGE1_TEXT = "Hello (World)\nKerned words\nHello";
const PAGE2 = "BT /F1 10 Tf 72 700 Td (First line) Tj 0 -12 Td (Second line) Tj 150 0 Td (Column) Tj ET\nBT /F1 10 Tf 72 660 Td (\\101\\102C \\\\ \\() Tj ET";
const PAGE2_TEXT = "First line\nSecond line Column\nABC \\ (";

function twoPages(): string {
  return classicPdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> >>"],
    [3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"],
    [4, stream("", PAGE1)],
    [5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] /Contents 6 0 R >>"],
    [6, stream("", PAGE2)],
    [7, FONT],
  ]);
}

describe("openPdf structure and views", () => {
  const doc = read(twoPages());

  test("lists one page block per page with its geometry", () => {
    expect(doc.format).toBe("pdf");
    expect(doc.blocks()).toEqual([
      {
        address: "page:1",
        aliases: ["page:@1"],
        kind: "page",
        depth: 0,
        text: PAGE1_TEXT,
        meta: { page: 1, lines: 3, chars: 32, width_pt: 612, height_pt: 792 },
      },
      {
        address: "page:2",
        aliases: ["page:@2"],
        kind: "page",
        depth: 0,
        text: PAGE2_TEXT,
        meta: { page: 2, lines: 3, chars: 37, width_pt: 595.276, height_pt: 841.89 },
      },
    ]);
  });

  test("breaks lines on y moves, joins kerned runs and spaces a wide TJ adjustment, a forward jump and escapes", () => {
    const [first, second] = doc.blocks();
    expect(first?.text).toBe("Hello (World)\nKerned words\nHello");
    expect(second?.text).toBe("First line\nSecond line Column\nABC \\ (");
  });

  test("text puts a heading before each page, a page target only its lines", () => {
    expect(doc.text()).toBe(`# Page 1\n${PAGE1_TEXT}\n\n# Page 2\n${PAGE2_TEXT}`);
    expect(doc.text("page:2")).toBe(PAGE2_TEXT);
    expect(doc.text("page:@1")).toBe(PAGE1_TEXT);
  });

  test("markdown makes each line a paragraph under a page heading", () => {
    expect(doc.markdown()).toBe(
      "## Page 1\n\nHello (World)\n\nKerned words\n\nHello\n\n## Page 2\n\nFirst line\n\nSecond line Column\n\nABC \\ (",
    );
    expect(doc.markdown("page:1")).toBe("## Page 1\n\nHello (World)\n\nKerned words\n\nHello");
  });

  test("a target restricts blocks to that page and accepts the alias", () => {
    expect(doc.blocks("page:2").map((block) => block.address)).toEqual(["page:2"]);
    expect(doc.blocks("page:@2")).toEqual(doc.blocks("page:2"));
  });

  test("units are one per non-empty page", () => {
    expect(doc.units()).toEqual([
      { address: "page:1", text: PAGE1_TEXT },
      { address: "page:2", text: PAGE2_TEXT },
    ]);
  });

  test("a target that names nothing is address-unresolved", () => {
    for (const target of ["page:0", "page:3", "page:01", "page:", "para:@1", "page:@1/block:~abcd1234", "sheet:#1", ""]) {
      const error = readError(() => doc.blocks(target));
      expect(error.code).toBe("address-unresolved");
      expect(error.message).toBe(`${target} names nothing in this document`);
      expect(readError(() => doc.text(target)).code).toBe("address-unresolved");
      expect(readError(() => doc.markdown(target)).code).toBe("address-unresolved");
    }
  });

  test("there is no cells view", () => {
    const error = readError(() => doc.cells());
    expect(error.code).toBe("unsupported-view");
    expect(error.message).toBe("a PDF has no cells view");
  });
});

describe("openPdf filters", () => {
  test("reads a Flate compressed content stream", () => {
    const doc = read(pagesPdf([flate("BT /F1 12 Tf 72 720 Td (Compressed) Tj 0 -14 Td (second line) Tj ET")]));
    expect(doc.blocks().map((block) => block.text)).toEqual(["Compressed\nsecond line"]);
  });

  test("concatenates a /Contents array of streams, through a filter chain", () => {
    const deflated = encode("(Across streams) Tj ET");
    const pdf = classicPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents [4 0 R 5 0 R] >>"],
      [4, stream("", "BT /F1 12 Tf 72 700 Td")],
      [5, stream("/Filter [/ASCIIHexDecode /FlateDecode]", hex(deflateSync(deflated)))],
      [6, FONT],
    ]);
    expect(read(pdf).text("page:1")).toBe("Across streams");
  });

  test("reads an ASCII85 stream whose last group is partial", () => {
    const content = encode("BT /F1 12 Tf 72 700 Td (Eighty five) Tj ET");
    expect(content.length % 4).toBe(2);
    const doc = read(pagesPdf([stream("/Filter /ASCII85Decode", ascii85(content))]));
    expect(doc.text("page:1")).toBe("Eighty five");
  });

  test("undoes every PNG row filter", () => {
    const content = encode("BT /F1 12 Tf 72 700 Td (PNG predictors) Tj 0 -14 Td (all row filters) Tj ET");
    const data = binary(deflateSync(pngEncode(content, 8, [0, 1, 2, 3, 4])));
    const doc = read(pagesPdf([stream("/Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 8 >>", data)]));
    expect(doc.text("page:1")).toBe("PNG predictors\nall row filters");
  });

  test("undoes the TIFF predictor", () => {
    const content = encode("BT /F1 12 Tf 72 700 Td (TIFF predictor) Tj ET");
    const data = binary(deflateSync(tiffEncode(content, 8)));
    const doc = read(pagesPdf([stream("/Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 8 >>", data)]));
    expect(doc.text("page:1")).toBe("TIFF predictor");
  });

  test("a stream with a filter it does not decode, and a page without contents, give empty pages", () => {
    const pdf = classicPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 /MediaBox [0 0 612 792] /Resources << /Font << /F1 8 0 R >> >> >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"],
      [4, stream("/Filter /DCTDecode", "\u00ff\u00d8\u00ff\u00e0 not really a picture")],
      [5, "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>"],
      [6, stream("", "BT /F1 12 Tf 72 700 Td (Second) Tj ET")],
      [7, "<< /Type /Page /Parent 2 0 R >>"],
      [8, FONT],
    ]);
    const doc = read(pdf);
    expect(doc.blocks().map((block) => block.meta)).toEqual([
      { page: 1, lines: 0, chars: 0, width_pt: 612, height_pt: 792 },
      { page: 2, lines: 1, chars: 6, width_pt: 612, height_pt: 792 },
      { page: 3, lines: 0, chars: 0, width_pt: 612, height_pt: 792 },
    ]);
    expect(doc.text()).toBe("# Page 1\n\n# Page 2\nSecond\n\n# Page 3");
    expect(doc.units()).toEqual([{ address: "page:2", text: "Second" }]);
    expect(doc.markdown("page:1")).toBe("## Page 1");
    expect(doc.text("page:3")).toBe("");
  });
});

describe("openPdf fonts", () => {
  const CMAP = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "3 beginbfchar",
    "<0003> <0020>",
    "<0010> <00E9>",
    "<0040> <D83DDE00>",
    "endbfchar",
    "2 beginbfrange",
    "<0024> <0026> <0041>",
    "<0030> <0032> [<0058> <0059> <005A>]",
    "endbfrange",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");

  test("decodes a Type0 font through its ToUnicode CMap, both range forms and a surrogate pair", () => {
    const pdf = pagesPdf(
      [
        "BT /F1 12 Tf 72 700 Td <0024 0025 0026 0003 0010 0030 0031 0032 0040> Tj ET",
        "BT /F2 12 Tf 72 700 Td <0048 0069 0021 0020 0394 03A9> Tj ET",
      ],
      {
        resources: "/Font << /F1 90 0 R /F2 92 0 R >>",
        extra: [
          [
            90,
            "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Test /Encoding /Identity-H /DescendantFonts [93 0 R] /ToUnicode 91 0 R >>",
          ],
          [91, stream("", CMAP)],
          [92, "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Plain /Encoding /Identity-H /DescendantFonts [93 0 R] >>"],
          [
            93,
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
          ],
        ],
      },
    );
    const doc = read(pdf);
    expect(doc.text("page:1")).toBe("ABC \u00e9XYZ\u{1F600}");
    // Without a ToUnicode CMap the two-byte codes are UTF-16BE code units.
    expect(doc.text("page:2")).toBe("Hi! \u0394\u03a9");
  });

  test("decodes WinAnsi high bytes and applies /Differences with glyph names", () => {
    const pdf = pagesPdf(
      [
        "BT /F1 12 Tf 72 700 Td (\\223quoted\\224 caf\\351 \\225 \\200 \\226) Tj ET\nBT /F2 12 Tf 72 680 Td (\\001 \\002 \\003 A B C) Tj ET",
      ],
      {
        resources: "/Font << /F1 3 0 R /F2 90 0 R >>",
        extra: [
          [
            90,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /Type /Encoding /Differences [1 /bullet /endash /emdash 65 /Aacute /uni20AC /fi] >> >>",
          ],
        ],
      },
    );
    expect(read(pdf).text("page:1")).toBe("\u201cquoted\u201d caf\u00e9 \u2022 \u20ac \u2013\n\u2022 \u2013 \u2014 \u00c1 \u20ac \ufb01");
  });
});

describe("openPdf content stream layout", () => {
  test("positions lines with Tm and cm, and puts a space where a run jumps forward on its line", () => {
    const content = [
      "BT /F1 12 Tf 1 0 0 1 72 700 Tm (A) Tj 1 0 0 1 72 686 Tm (B) Tj 1 0 0 1 200 686 Tm (C) Tj ET",
      "q 1 0 0 1 0 -40 cm BT /F1 12 Tf 1 0 0 1 72 700 Tm (D) Tj ET Q",
      "BT /F1 12 Tf 1 0 0 1 72 600 Tm (E) Tj ET",
    ].join("\n");
    expect(read(pagesPdf([stream("", content)])).text("page:1")).toBe("A\nB C\nD\nE");
  });

  test("follows TD, T*, the quote operators and the leading", () => {
    const content = [
      "BT /F1 12 Tf 72 700 Td (a) Tj 0 -12 TD (b) Tj T* (c) Tj ET",
      "BT /F1 12 Tf 72 600 Td 12 TL (one) Tj (two) ' 1 2 (three) \" ET",
    ].join("\n");
    expect(read(pagesPdf([stream("", content)])).text("page:1")).toBe("a\nb\nc\none\ntwo\nthree");
  });

  test("a TJ adjustment of -200 joins the runs and one below it is a word space", () => {
    const content = "BT /F1 12 Tf 72 700 Td [(x) -200 (y) -201 (z)] TJ ET";
    expect(read(pagesPdf([stream("", content)])).text("page:1")).toBe("xy z");
  });

  test("skips the binary data of an inline image", () => {
    const content = [
      "BT /F1 12 Tf 72 700 Td (before) Tj ET",
      "BI /W 2 /H 2 /CS /G /BPC 8 ID ((\u0000\u0001) EI",
      "BT /F1 12 Tf 72 650 Td (after) Tj ET",
    ].join("\n");
    expect(read(pagesPdf([stream("", content)])).text("page:1")).toBe("before\nafter");
  });

  test("descends into a form XObject with its own resources and matrix", () => {
    const pdf = pagesPdf(
      ["BT /F1 12 Tf 72 700 Td (Before) Tj ET\nq 1 0 0 1 72 650 cm /Fm0 Do Q\nBT /F1 12 Tf 72 600 Td (After) Tj ET"],
      {
        resources: "/Font << /F1 3 0 R >> /XObject << /Fm0 90 0 R >>",
        extra: [
          [
            90,
            stream(
              "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 20] /Resources << /Font << /F9 91 0 R >> >>",
              "BT /F9 12 Tf 0 0 Td (Form A) Tj ET",
            ),
          ],
          [91, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /Aacute] >> >>"],
        ],
      },
    );
    expect(read(pdf).text("page:1")).toBe("Before\nForm \u00c1\nAfter");
  });

  test("stops a form that draws itself after four levels", () => {
    const pdf = pagesPdf(["/Fm0 Do"], {
      resources: "/Font << /F1 3 0 R >> /XObject << /Fm0 90 0 R >>",
      extra: [
        [
          90,
          stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F1 3 0 R >> /XObject << /Fm0 90 0 R >> >>",
            "BT /F1 12 Tf (X) Tj ET /Fm0 Do",
          ),
        ],
      ],
    });
    expect(read(pdf).text("page:1")).toBe("XXXX");
  });
});

describe("openPdf damaged and modern files", () => {
  test("reads a file whose xref offsets are wrong, with a direct and an indirect stream length that do not fit", () => {
    const indirect = "BT /F1 12 Tf 72 700 Td (Indirect length) Tj ET";
    const pdf = pagesPdf(
      [
        stream("", "BT /F1 12 Tf 72 700 Td (Wrong length) Tj ET", 3),
        `<< /Length 90 0 R >>\nstream\n${indirect}\nendstream`,
        stream("", "BT /F1 12 Tf 72 700 Td (Short stream) Tj ET", 9999),
      ],
      { badXref: true, extra: [[90, String(indirect.length)]] },
    );
    const doc = read(pdf);
    expect(doc.blocks().map((block) => block.text)).toEqual(["Wrong length", "Indirect length", "Short stream"]);
  });

  test("finds the catalog when the file ends before any xref or trailer", () => {
    const full = pagesPdf([stream("", PAGE1), stream("", PAGE2)]);
    const cut = full.slice(0, full.indexOf("xref"));
    expect(cut).not.toContain("trailer");
    expect(read(cut).blocks().map((block) => block.text)).toEqual([PAGE1_TEXT, PAGE2_TEXT]);
  });

  test("falls back to the page objects in file order when the page tree is unusable", () => {
    const pdf = classicPdf([
      [1, "<< /Type /Catalog /Pages 99 0 R >>"],
      [2, "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 100 200] /Resources << /Font << /F1 7 0 R >> >> >>"],
      [5, "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>"],
      [6, stream("", "BT /F1 12 Tf 72 700 Td (File order first) Tj ET")],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"],
      [4, stream("", "BT /F1 12 Tf 72 700 Td (File order second) Tj ET")],
      [7, FONT],
    ]);
    const doc = read(pdf);
    expect(doc.blocks().map((block) => [block.address, block.text, block.meta?.width_pt, block.meta?.height_pt])).toEqual([
      ["page:1", "File order first", 100, 200],
      ["page:2", "File order second", 100, 200],
    ]);
  });

  test("walks nested page tree nodes in order and lets a node override the inherited media box", () => {
    const pdf = classicPdf([
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, "<< /Type /Pages /Kids [10 0 R 3 0 R] /Count 2 /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> >>"],
      [3, "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>"],
      [4, "<< /Type /Page /Parent 10 0 R /Contents 6 0 R >>"],
      [5, stream("", "BT /F1 12 Tf 72 700 Td (Second in order) Tj ET")],
      [6, stream("", "BT /F1 12 Tf 72 700 Td (First in order) Tj ET")],
      [7, FONT],
      [10, "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 /MediaBox [0 0 300 400] >>"],
    ]);
    const doc = read(pdf);
    expect(doc.blocks().map((block) => [block.text, block.meta?.width_pt, block.meta?.height_pt])).toEqual([
      ["First in order", 300, 400],
      ["Second in order", 612, 792],
    ]);
  });

  test("a later definition of an object wins, as in an incremental update", () => {
    const original = pagesPdf([stream("", "BT /F1 12 Tf 72 700 Td (Old text) Tj ET")]);
    const updated = `${original}5 0 obj\n${stream("", "BT /F1 12 Tf 72 700 Td (New text) Tj ET")}\nendobj\ntrailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`;
    expect(read(updated).text("page:1")).toBe("New text");
  });

  test("reads objects held in an object stream, through a cross-reference stream and a PNG predictor", () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources 8 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    ];
    const numbers = [1, 2, 3, 6];
    let header = "";
    let offset = 0;
    bodies.forEach((body, index) => {
      header += `${numbers[index]} ${offset} `;
      offset += body.length + 1;
    });
    const packed = pngEncode(encode(header + bodies.join(" ")), 16, [2]);
    const objectStream = stream(
      `/Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 16 >>`,
      binary(deflateSync(packed)),
    );
    const file = [
      "%PDF-1.5",
      `4 0 obj\n${stream("", "BT /F1 12 Tf 10 50 Td (Packed objects) Tj ET")}\nendobj`,
      "8 0 obj\n<< /Font << /F1 6 0 R >> >>\nendobj",
      `5 0 obj\n${objectStream}\nendobj`,
      `7 0 obj\n${stream("/Type /XRef /Size 9 /W [1 2 1] /Root 1 0 R", "\u0000".repeat(36))}\nendobj`,
      "startxref\n0\n%%EOF\n",
    ].join("\n");
    const doc = read(file);
    expect(doc.blocks()).toEqual([
      {
        address: "page:1",
        aliases: ["page:@1"],
        kind: "page",
        depth: 0,
        text: "Packed objects",
        meta: { page: 1, lines: 1, chars: 14, width_pt: 200, height_pt: 100 },
      },
    ]);
  });

  test("keeps the first 5000 pages", () => {
    const kids = Array.from({ length: 5001 }, (_, index) => `${3 + index} 0 R`).join(" ");
    const objects: Obj[] = [
      [1, "<< /Type /Catalog /Pages 2 0 R >>"],
      [2, `<< /Type /Pages /Kids [${kids}] /Count 5001 >>`],
    ];
    for (let index = 0; index < 5001; index++) objects.push([3 + index, "<< /Type /Page /Parent 2 0 R >>"]);
    const doc = read(classicPdf(objects));
    const blocks = doc.blocks();
    expect(blocks.length).toBe(5000);
    expect(blocks[4999]?.address).toBe("page:5000");
    expect(blocks[4999]?.meta).toEqual({ page: 5000, lines: 0, chars: 0, width_pt: null, height_pt: null });
    expect(readError(() => doc.blocks("page:5001")).code).toBe("address-unresolved");
  });
});

describe("openPdf invalid input", () => {
  test("refuses an encrypted file named by its trailer", () => {
    const pdf = pagesPdf([stream("", "BT ET")], {
      extra: [[90, "<< /Filter /Standard /V 1 /R 2 /O (owner) /U (user) /P -4 >>"]],
      trailer: " /Encrypt 90 0 R",
    });
    const error = readError(() => read(pdf));
    expect(error.code).toBe("invalid-input");
    expect(error.message).toBe("the PDF is encrypted");
  });

  test("refuses an encrypted file named by its cross-reference stream", () => {
    const file = [
      "%PDF-1.5",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      `7 0 obj\n${stream("/Type /XRef /Size 8 /Root 1 0 R /Encrypt 9 0 R", "")}\nendobj`,
      "startxref\n0\n%%EOF\n",
    ].join("\n");
    const error = readError(() => read(file));
    expect(error.code).toBe("invalid-input");
    expect(error.message).toBe("the PDF is encrypted");
  });

  test("refuses bytes that are not a PDF", () => {
    const zip = writeZip([{ name: "word/document.xml", data: "<w:document/>" }]);
    for (const bytes of [encode("hello world"), zip, new Uint8Array(0), encode("%PDF")]) {
      expect(readError(() => openPdf(bytes)).code).toBe("invalid-input");
    }
  });

  test("wants the header within the first 1024 bytes", () => {
    const late = readError(() => read(`${"x".repeat(1100)}${twoPages()}`));
    expect(late.code).toBe("invalid-input");
    expect(late.message).toContain("%PDF-");
    expect(read(`${"x".repeat(900)}\n${twoPages()}`).blocks().length).toBe(2);
  });

  test("refuses a header with no objects behind it", () => {
    const error = readError(() => read("%PDF-1.7\n%%EOF\n"));
    expect(error.code).toBe("invalid-input");
    expect(error.message).toBe("the PDF holds no objects");
  });
});
