import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalXml, comparePackages, PackageError, readPackage, sha256Hex, type PackageErrorCode } from "../src/lab/verify.ts";
import { buildZip, crc32, type TestEntry } from "./zip.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const BODY = "<sheetData>" + Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i * 7}</v></c></row>`).join("") + "</sheetData>";
const XML_BEFORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<root xmlns="urn:a" xmlns:r="urn:r" b="2" a="1">\n  <item r:id="x" kind='k'>text &amp; more</item>\n  <empty></empty>\n</root>`;
const XML_TWIN = `<root a="1" b="2" xmlns:r="urn:r" xmlns="urn:a"><item kind="k" r:id="x">text &#38; more</item><empty/></root>`;

function expectPackageError(error: unknown, code: PackageErrorCode) {
  expect(error).toBeInstanceOf(PackageError);
  expect((error as PackageError).name).toBe("PackageError");
  expect((error as PackageError).code).toBe(code);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("sha256Hex", () => {
  test("matches node:crypto", async () => {
    const data = enc("wolf lab");
    expect(await sha256Hex(data)).toBe(nodeSha(data));
    expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("readPackage", () => {
  test("reports every member with its stream digest and byte span", async () => {
    const entries: TestEntry[] = [
      { name: "[Content_Types].xml", data: "<Types/>", method: 0 },
      { name: "xl/worksheets/sheet1.xml", data: BODY, method: 8 },
    ];
    const zip = buildZip(entries);
    const info = await readPackage(zip);
    expect(info.bytes).toBe(zip.length);
    expect(info.sha256).toBe(nodeSha(zip));
    expect(info.members.map((m) => m.name)).toEqual(["[Content_Types].xml", "xl/worksheets/sheet1.xml"]);
    const [stored, deflated] = info.members;
    expect(stored).toMatchObject({ method: 0, size: 8, compressedSize: 8, crc32: crc32(enc("<Types/>")), headerOffset: 0, dataOffset: 30 + 19 });
    expect(zip.subarray(stored!.dataOffset, stored!.dataOffset + 8)).toEqual(enc("<Types/>"));
    expect(deflated!.method).toBe(8);
    expect(deflated!.size).toBe(enc(BODY).length);
    expect(deflated!.compressedSize).toBeLessThan(deflated!.size);
    expect(deflated!.headerOffset).toBe(stored!.dataOffset + 8);
    expect(deflated!.dataOffset).toBe(deflated!.headerOffset + 30 + "xl/worksheets/sheet1.xml".length);
    expect(deflated!.streamSha256).toBe(nodeSha(zip.subarray(deflated!.dataOffset, deflated!.dataOffset + deflated!.compressedSize)));
  });

  test("a truncated archive throws PackageError truncated", async () => {
    const zip = buildZip([{ name: "a.xml", data: BODY, method: 8 }]);
    expectPackageError(await rejection(readPackage(zip.subarray(0, Math.floor(zip.length / 2)))), "truncated");
  });

  test("a stream that runs past the file is reported as truncated", async () => {
    const zip = buildZip([{ name: "a.xml", data: BODY, method: 8 }]);
    const info = await readPackage(zip);
    const cd = info.members[0]!.dataOffset + info.members[0]!.compressedSize;
    new DataView(zip.buffer).setUint32(cd + 20, 0x00ffffff, true); // central compressed size
    expectPackageError(await rejection(readPackage(zip)), "truncated");
  });

  test("bytes that are not a ZIP throw not-a-zip", async () => {
    expectPackageError(await rejection(readPackage(enc("hello, this is not a package at all"))), "not-a-zip");
    expectPackageError(await rejection(readPackage(new Uint8Array(3))), "not-a-zip");
  });

  test("ZIP64 is detected and refused explicitly", async () => {
    const zip = buildZip([{ name: "a.xml", data: "<a/>", method: 0 }]);
    const end = zip.length - 22;
    const view = new DataView(zip.buffer);
    view.setUint16(end + 8, 0xffff, true);
    view.setUint16(end + 10, 0xffff, true);
    expectPackageError(await rejection(readPackage(zip)), "zip64-unsupported");

    const sized = buildZip([{ name: "a.xml", data: "<a/>", method: 0 }]);
    const cd = 30 + 5 + 4;
    new DataView(sized.buffer).setUint32(cd + 24, 0xffffffff, true);
    expectPackageError(await rejection(readPackage(sized)), "zip64-unsupported");
  });
});

describe("comparePackages", () => {
  const before = buildZip([
    { name: "[Content_Types].xml", data: "<Types><Default Extension=\"xml\"/></Types>", method: 0 },
    { name: "xl/worksheets/sheet1.xml", data: BODY, method: 8, level: 9 },
    { name: "xl/styles.xml", data: XML_BEFORE, method: 8 },
    { name: "xl/sharedStrings.xml", data: "<sst><si><t>Q3</t></si></sst>", method: 8 },
    { name: "xl/media/logo.bin", data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), method: 0 },
    { name: "docProps/app.xml", data: "<Properties/>", method: 8 },
  ]);
  const after = buildZip([
    // Same bytes, same stream, at a different offset: still identical-stream.
    { name: "xl/media/logo.bin", data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), method: 0 },
    { name: "[Content_Types].xml", data: "<Types><Default Extension=\"xml\"/></Types>", method: 0 },
    { name: "xl/worksheets/sheet1.xml", data: BODY, method: 8, level: 1 },
    { name: "xl/styles.xml", data: XML_TWIN, method: 8 },
    { name: "xl/sharedStrings.xml", data: "<sst><si><t>Q4</t></si></sst>", method: 8 },
    { name: "xl/comments1.xml", data: "<comments/>", method: 8 },
  ]);

  test("assigns each verdict", async () => {
    const delta = await comparePackages(before, after);
    const verdict = Object.fromEntries(delta.verdicts.map((v) => [v.name, v.verdict]));
    expect(verdict).toEqual({
      "[Content_Types].xml": "identical-stream",
      "xl/worksheets/sheet1.xml": "same-bytes-recompressed",
      "xl/styles.xml": "xml-equivalent",
      "xl/sharedStrings.xml": "changed",
      "xl/media/logo.bin": "identical-stream",
      "docProps/app.xml": "removed",
      "xl/comments1.xml": "added",
    });
    expect(delta.verdicts.map((v) => v.name)).toEqual([
      "[Content_Types].xml", "xl/worksheets/sheet1.xml", "xl/styles.xml", "xl/sharedStrings.xml",
      "xl/media/logo.bin", "docProps/app.xml", "xl/comments1.xml",
    ]);
    expect(delta.counts).toEqual({
      "identical-stream": 2, "same-bytes-recompressed": 1, "xml-equivalent": 1, changed: 1, removed: 1, added: 1,
    });
    // The recompressed twin really has a different stream.
    const a = delta.before.members.find((m) => m.name === "xl/worksheets/sheet1.xml")!;
    const b = delta.after.members.find((m) => m.name === "xl/worksheets/sheet1.xml")!;
    expect(a.streamSha256).not.toBe(b.streamSha256);
    expect(a.crc32).toBe(b.crc32);

    const sizes = new Map(delta.before.members.map((m) => [m.name, m.compressedSize]));
    const total = [...sizes.values()].reduce((x, y) => x + y, 0);
    const untouched = sizes.get("[Content_Types].xml")! + sizes.get("xl/media/logo.bin")!;
    expect(delta.untouchedByteShare).toBeCloseTo(untouched / total, 12);
    const removed = delta.verdicts.find((v) => v.verdict === "removed")!;
    expect(removed).toMatchObject({ bytesBefore: sizes.get("docProps/app.xml"), bytesAfter: 0 });
    const added = delta.verdicts.find((v) => v.verdict === "added")!;
    expect(added.bytesBefore).toBe(0);
    expect(added.bytesAfter).toBeGreaterThan(0);
  });

  test("stored against deflated with the same content is same-bytes-recompressed", async () => {
    const a = buildZip([{ name: "a.bin", data: BODY, method: 0 }]);
    const b = buildZip([{ name: "a.bin", data: BODY, method: 8 }]);
    const delta = await comparePackages(a, b);
    expect(delta.verdicts[0]!.verdict).toBe("same-bytes-recompressed");
    expect(delta.untouchedByteShare).toBe(0);
  });

  test("a package compared with itself is fully identical", async () => {
    const delta = await comparePackages(before, before);
    expect(delta.verdicts.every((v) => v.verdict === "identical-stream")).toBe(true);
    expect(delta.untouchedByteShare).toBe(1);
  });

  test("a non-XML member with different content is changed without inflating", async () => {
    const a = buildZip([{ name: "a.bin", data: new Uint8Array([1, 2, 3]), method: 0 }]);
    const b = buildZip([{ name: "a.bin", data: new Uint8Array([1, 2, 4]), method: 0 }]);
    expect((await comparePackages(a, b)).verdicts[0]!.verdict).toBe("changed");
  });

  test("a corrupt deflate stream is refused, not guessed", async () => {
    const a = buildZip([{ name: "a.xml", data: BODY, method: 8 }]);
    const b = buildZip([{ name: "a.xml", data: BODY.replace("<v>7</v>", "<v>8</v>"), method: 8 }]);
    const info = await readPackage(b);
    const m = info.members[0]!;
    b.fill(0xff, m.dataOffset, m.dataOffset + Math.min(16, m.compressedSize));
    expectPackageError(await rejection(comparePackages(a, b)), "malformed");
  });
});

describe("canonicalXml", () => {
  const same = (a: string, b: string) => {
    const x = canonicalXml(enc(a));
    expect(x).not.toBeNull();
    expect(x).toBe(canonicalXml(enc(b)));
  };
  const differ = (a: string, b: string) => expect(canonicalXml(enc(a))).not.toBe(canonicalXml(enc(b)));

  test("ignores attribute order, namespace declaration order, declaration and inter-element whitespace", () => {
    same(XML_BEFORE, XML_TWIN);
    same(`<a\n  x="1"\r\n  y="2"/>`, `<a y="2" x="1"></a>`);
    same(`<a><![CDATA[1 < 2]]></a>`, `<a>1 &lt; 2</a>`);
  });

  test("never ignores text content", () => {
    differ(`<r><t>a</t></r>`, `<r><t>b</t></r>`);
    differ(`<r><t> </t></r>`, `<r><t></t></r>`);
    differ(`<r><t>a b</t></r>`, `<r><t>a  b</t></r>`);
    differ(`<p>one <b>two</b></p>`, `<p>one<b>two</b></p>`);
    differ(`<r xml:space="preserve"> <b/></r>`, `<r xml:space="preserve"><b/></r>`);
    differ(`<r a="1"/>`, `<r a="2"/>`);
    differ(`<r a="1"/>`, `<r a="1" b="1"/>`);
    differ(`<w:r xmlns:w="urn:w"/>`, `<x:r xmlns:x="urn:w"/>`);
    differ(`<r><!-- a --></r>`, `<r><!-- b --></r>`);
  });

  test("drops a namespace declaration only when its prefix is provably unused", () => {
    const R = 'xmlns:r="urn:r"';
    same(`<root xmlns="urn:a" ${R} count="37"><x/></root>`, `<root count="37" xmlns="urn:a"><x/></root>`);
    // The default namespace declaration is never dropped.
    differ(`<root xmlns="urn:a"/>`, `<root/>`);
    // Uses inside attribute values: a token, a QName, a token in a list.
    differ(`<root xmlns:mc="urn:mc" ${R} mc:Ignorable="r"/>`, `<root xmlns:mc="urn:mc" mc:Ignorable="r"/>`);
    differ(`<root xmlns:mc="urn:mc" ${R} mc:Ignorable="x14ac r"/>`, `<root xmlns:mc="urn:mc" mc:Ignorable="x14ac r"/>`);
    differ(`<root xmlns:xsi="urn:xsi" ${R}><v xsi:type="r:Foo"/></root>`, `<root xmlns:xsi="urn:xsi"><v xsi:type="r:Foo"/></root>`);
    differ(`<root ${R}><t>see r:Foo</t></root>`, `<root><t>see r:Foo</t></root>`);
    // Uses as an element or attribute name prefix.
    differ(`<root ${R}><r:x/></root>`, `<root><r:x/></root>`);
    differ(`<root ${R}><x r:id="rId1"/></root>`, `<root><x r:id="rId1"/></root>`);
    // Declared on another element, still unused: dropped.
    same(`<root><x ${R}/></root>`, `<root><x/></root>`);
    // Prefixes are never renamed.
    differ(`<root xmlns:r="urn:r"><x r:id="1"/></root>`, `<root xmlns:q="urn:r"><x q:id="1"/></root>`);
  });

  test("refuses what it cannot canonicalise", () => {
    expect(canonicalXml(enc(`<!DOCTYPE r [<!ENTITY e "x">]><r>&e;</r>`))).toBeNull();
    expect(canonicalXml(enc(`<r><a></r>`))).toBeNull();
    expect(canonicalXml(enc(`<r/><s/>`))).toBeNull();
    expect(canonicalXml(enc(`<r>a & b</r>`))).toBeNull();
    expect(canonicalXml(enc(`<r a="1" a="2"/>`))).toBeNull();
    expect(canonicalXml(new Uint8Array([0x3c, 0x72, 0x3e, 0xff, 0x3c, 0x2f, 0x72, 0x3e]))).toBeNull();
  });
});
