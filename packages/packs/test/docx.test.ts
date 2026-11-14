// Word targets: what the planner says, what the applier writes, and that nothing else in the package moves.
import { describe, expect, test } from "bun:test";
import { DocxDocument } from "../src/docx.ts";
import { changedParts, codeOf, docx, partText, textOfSet, withPart } from "./fixtures.ts";

const table = (address: string, fit_policy: "none" | "grow" | "truncate" | "fail" = "none") => ({ id: "t", target_address: address, fit_policy });
const bookmark = (fit_policy: "none" | "truncate" | "fail" = "none", address = "Headline") => ({ id: "b", target_address: address, fit_policy });

/** Apply `ops` to `bytes` and return the document written. */
function applied(bytes: Uint8Array, ops: readonly { op: string }[]): Uint8Array {
  const doc = new DocxDocument(bytes, "report.docx");
  doc.apply(ops);
  return doc.save();
}

const FIGURES = [
  ["Quarter", "Revenue"],
  ["Q1", "$1.2M"],
  ["Q2", "$2.3M"],
];

describe("a table", () => {
  test("that already holds the figures needs nothing, and a no-op apply returns the very bytes", () => {
    const bytes = docx({ table: FIGURES });
    const doc = new DocxDocument(bytes, "report.docx");
    expect(doc.planTable(table("Revenue", "grow"), FIGURES)).toEqual({ ops: [], notes: [] });
    expect(doc.planTable(table("table:Revenue"), FIGURES).ops).toEqual([]);
    doc.apply([]);
    expect(doc.save()).toBe(bytes);
  });

  test("is planned cell by cell, by caption or by position", () => {
    const doc = new DocxDocument(docx({ table: [["Quarter", "Revenue"], ["Q1", "old"]] }), "report.docx");
    const planned = doc.planTable(table("@1"), [["Quarter", "Revenue"], ["Q1", "$1.2M"]]);
    expect(planned.ops).toEqual([{ op: "set", target: "table:@1/row:@2/cell:@2", value: { text: "$1.2M" } }]);
    expect(doc.planTable(table("Revenue"), [["Quarter", "Revenue"], ["Q1", "$1.2M"]]).ops[0]?.target).toBe("table:Revenue/row:@2/cell:@2");
  });

  test("is written in place: only word/document.xml changes, and the formatting of each cell stays", () => {
    const before = docx({ table: [["Quarter", "Revenue"], ["old", "old"]] });
    const doc = new DocxDocument(before, "report.docx");
    const { ops } = doc.planTable(table("Revenue"), [["Quarter", "Revenue"], ["Q1 & Q2", "$1.2M <net>"]]);
    expect(ops).toHaveLength(2);
    const after = applied(before, ops);
    expect(changedParts(before, after)).toEqual(["word/document.xml"]);
    const xml = partText(after, "word/document.xml");
    expect(xml).toContain("Q1 &amp; Q2");
    expect(xml).toContain("$1.2M &lt;net&gt;");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("Untouched closing paragraph.");
    expect(new DocxDocument(after, "report.docx").planTable(table("Revenue"), [["Quarter", "Revenue"], ["Q1 & Q2", "$1.2M <net>"]]).ops).toEqual([]);
  });

  test("a value with a line break or a tab keeps it", () => {
    const before = docx({ table: [["a", "b"]] });
    const ops = new DocxDocument(before, "report.docx").planTable(table("Revenue"), [["one\ntwo", "x\ty"]]).ops;
    const after = applied(before, ops);
    expect(partText(after, "word/document.xml")).toMatch(/one<\/w:t><\/w:r><w:r>.*<w:br\/>.*two/);
    expect(new DocxDocument(after, "report.docx").planTable(table("Revenue"), [["one\ntwo", "x\ty"]]).ops).toEqual([]);
  });

  test("grow adds the rows the source has, in the order of the source", () => {
    const before = docx({ table: [["Quarter", "Revenue"], ["Q1", "old"]] });
    const doc = new DocxDocument(before, "report.docx");
    const planned = doc.planTable(table("Revenue", "grow"), [...FIGURES, ["Q3", "$0.9M"], ["Q4", "$1.1M"]]);
    expect(planned.ops.map((op) => [op.op, op.anchor ?? op.target])).toEqual([
      ["set", "table:Revenue/row:@2/cell:@2"],
      ["insert-row", "table:Revenue/row:@2"],
      ["insert-row", "table:Revenue/row:@3"],
      ["insert-row", "table:Revenue/row:@4"],
    ]);
    expect(planned.notes.join(" ")).toContain("grows by 3 rows");
    const after = applied(before, planned.ops);
    const reopened = new DocxDocument(after, "report.docx");
    expect(reopened.planTable(table("Revenue", "fail"), [...FIGURES, ["Q3", "$0.9M"], ["Q4", "$1.1M"]]).ops).toEqual([]);
    const xml = partText(after, "word/document.xml");
    expect(xml.indexOf("Q1")).toBeLessThan(xml.indexOf("Q2"));
    expect(xml.indexOf("Q2")).toBeLessThan(xml.indexOf("Q3"));
    expect(xml.indexOf("Q3")).toBeLessThan(xml.indexOf("Q4"));
  });

  test("without grow, rows that do not fit are said so and left out; fail refuses them", async () => {
    const doc = new DocxDocument(docx({ table: FIGURES.slice(0, 2) }), "report.docx");
    const kept = doc.planTable(table("Revenue", "truncate"), FIGURES);
    expect(kept.notes.join(" ")).toContain("1 source rows do not fit");
    expect(kept.ops.every((op) => op.op === "set")).toBe(true);
    expect(await codeOf(() => doc.planTable(table("Revenue", "fail"), FIGURES))).toBe("table-overflow");
    expect(await codeOf(() => doc.planTable(table("Revenue", "grow"), [["a", "b", "c"]]))).toBe("table-overflow");
  });

  test("is refused when it cannot be told apart or filled", async () => {
    const bytes = docx();
    expect(await codeOf(() => new DocxDocument(bytes, "report.docx").planTable(table("Nope"), FIGURES))).toBe("address-unresolved");
    expect(await codeOf(() => new DocxDocument(bytes, "report.docx").planTable(table("table:~Quarter Revenue"), FIGURES))).toBe("unsupported-address");
    const merged = withPart(bytes, "word/document.xml", (xml) => xml.replace("<w:tcW", '<w:gridSpan w:val="1"/><w:tcW'));
    expect(await codeOf(() => new DocxDocument(merged, "report.docx").planTable(table("Revenue"), FIGURES))).toBe("unsupported-target");
    const doubled = withPart(bytes, "word/document.xml", (xml) => xml.replace(/<w:tbl>[\s\S]*<\/w:tbl>/, (t) => t + t));
    expect(await codeOf(() => new DocxDocument(doubled, "report.docx").planTable(table("Revenue"), FIGURES))).toBe("address-ambiguous");
    expect(await codeOf(() => new DocxDocument(new Uint8Array([1, 2, 3]), "report.docx"))).toBe("package-bad-zip");
  });

  test("an apply that is refused writes nothing", async () => {
    const doc = new DocxDocument(docx(), "report.docx");
    expect(await codeOf(() => doc.apply([{ op: "set", target: "table:Revenue/row:@9/cell:@1", value: { text: "x" } }]))).toBe("address-unresolved");
    expect(await codeOf(() => doc.apply([{ op: "delete", target: "table:Revenue" }]))).toBe("unsupported-op");
    expect(await codeOf(() => doc.apply([{ op: "insert-row", anchor: "table:Revenue/row:@1", position: "after", cells: ["a", "b", "c"] }]))).toBe("table-row-width-mismatch");
    expect(doc.save()).toBe(doc.save());
  });
});

describe("a bookmark", () => {
  test("is planned as one set and keeps the run formatting and the text around it", () => {
    const before = docx({ bookmark: "stale" });
    const doc = new DocxDocument(before, "report.docx");
    const planned = doc.planBookmark(bookmark(), "$3.6M");
    expect(planned.ops).toEqual([{ op: "set", target: "bookmark:Headline", value: { text: "$3.6M" } }]);
    const after = applied(before, planned.ops);
    expect(changedParts(before, after)).toEqual(["word/document.xml"]);
    const xml = partText(after, "word/document.xml");
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="Headline"/>');
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("Revenue was ");
    expect(xml).toContain("$3.6M");
    expect(xml).not.toContain("stale");
    expect(new DocxDocument(after, "report.docx").planBookmark(bookmark(), "$3.6M").ops).toEqual([]);
  });

  test("a bookmark address may carry its key", () => {
    const doc = new DocxDocument(docx({ bookmark: "same" }), "report.docx");
    expect(doc.planBookmark(bookmark("none", "bookmark:Headline"), "same").ops).toEqual([]);
  });

  test("is refused when there is none, or it holds more than text", async () => {
    const bytes = docx();
    expect(await codeOf(() => new DocxDocument(bytes, "report.docx").planBookmark(bookmark("none", "Nope"), "x"))).toBe("address-unresolved");
    const withField = withPart(bytes, "word/document.xml", (xml) => xml.replace("<w:t>old</w:t>", '<w:fldChar w:fldCharType="begin"/>'));
    expect(await codeOf(() => new DocxDocument(withField, "report.docx").planBookmark(bookmark(), "x"))).toBe("unsupported-target");
  });

  test("truncate cuts the value to the width of its line, fail refuses it, none writes it whole", async () => {
    // A 3000 twip page with 1440 twip margins on both sides leaves no width at all; 6000 twips leaves 150pt.
    const narrow = docx({ bookmark: "x", pageWidth: 6000 });
    const long = "a long headline that cannot fit in one narrow line of eleven point text";
    const cut = new DocxDocument(narrow, "report.docx").planBookmark(bookmark("truncate"), long);
    const written = cut.ops[0];
    expect(written?.op).toBe("set");
    const text = textOfSet(written);
    expect(text.endsWith("\u2026")).toBe(true);
    expect(text.length).toBeLessThan(long.length);
    expect(cut.notes.join(" ")).toContain("truncated");
    expect(await codeOf(() => new DocxDocument(narrow, "report.docx").planBookmark(bookmark("fail"), long))).toBe("text-does-not-fit");
    expect(new DocxDocument(narrow, "report.docx").planBookmark(bookmark("none"), long).ops[0]?.value).toEqual({ text: long });
  });
});
