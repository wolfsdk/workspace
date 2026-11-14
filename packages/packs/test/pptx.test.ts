// PowerPoint targets: table, headline and chart series; what is planned, what is written, and that nothing else moves.
import { describe, expect, test } from "bun:test";
import { OoxmlPackage } from "../src/ooxml.ts";
import { PptxDocument } from "../src/pptx.ts";
import { XlsxWorkbook } from "../src/xlsx.ts";
import { changedParts, codeOf, partText, pptx, textOfSet, withPart } from "./fixtures.ts";

type Policy = "none" | "grow" | "shrink_to_fit" | "truncate" | "fail";
const at = (address: string, fit_policy: Policy = "none") => ({ id: "b", target_address: address, fit_policy });

const TABLE = "slide:@1/shape:Table 1";
const HEADLINE = "slide:#256/shape:#2";
const SERIES = "slide:@1/shape:Chart 1/chart/series:Sales";

/** Apply `ops` to `bytes` and return the deck written. */
function applied(bytes: Uint8Array, ops: readonly { op: string }[]): Uint8Array {
  const deck = new PptxDocument(bytes, "deck.pptx");
  deck.apply(ops);
  return deck.save();
}

const FIGURES = [
  ["Quarter", "Revenue"],
  ["Q1", "$1.2M"],
  ["Q2", "$2.3M"],
];

describe("a table", () => {
  test("that already holds the figures needs nothing, and a no-op apply returns the very bytes", () => {
    const bytes = pptx({ table: FIGURES });
    const deck = new PptxDocument(bytes, "deck.pptx");
    expect(deck.planTable(at(TABLE, "grow"), FIGURES)).toEqual({ ops: [], notes: [] });
    deck.apply([]);
    expect(deck.save()).toBe(bytes);
  });

  test("is planned cell by cell against the canonical address of the shape", () => {
    const deck = new PptxDocument(pptx({ table: [["Quarter", "Revenue"], ["Q1", "old"]] }), "deck.pptx");
    expect(deck.planTable(at(TABLE), FIGURES.slice(0, 2)).ops).toEqual([{ op: "set", target: "slide:#256/shape:#3/row:@2/cell:@2", value: { text: "$1.2M" } }]);
    expect(deck.planTable(at("slide:#256/shape:#3"), FIGURES.slice(0, 2)).ops).toHaveLength(1);
  });

  test("is written in place: only the slide changes, and the run formatting of each cell stays", () => {
    const before = pptx({ table: [["Quarter", "Revenue"], ["old", "old"]] });
    const { ops } = new PptxDocument(before, "deck.pptx").planTable(at(TABLE), [["Quarter", "Revenue"], ["Q1 & Q2", "<net>"]]);
    const after = applied(before, ops);
    expect(changedParts(before, after)).toEqual(["ppt/slides/slide1.xml"]);
    const xml = partText(after, "ppt/slides/slide1.xml");
    expect(xml).toContain("Q1 &amp; Q2");
    expect(xml).toContain("&lt;net&gt;");
    expect(xml).toContain('sz="1400"');
    expect(new PptxDocument(after, "deck.pptx").planTable(at(TABLE), [["Quarter", "Revenue"], ["Q1 & Q2", "<net>"]]).ops).toEqual([]);
  });

  test("grow adds the rows the source has, in the order of the source", () => {
    const before = pptx({ table: [["Quarter", "Revenue"], ["Q1", "old"]] });
    const wanted = [...FIGURES, ["Q3", "$0.9M"], ["Q4", "$1.1M"]];
    const planned = new PptxDocument(before, "deck.pptx").planTable(at(TABLE, "grow"), wanted);
    // Every anchor is a row the deck has before the batch: an engine resolves all of them up front.
    expect(planned.ops.map((op) => [op.op, op.anchor ?? op.target])).toEqual([
      ["set", "slide:#256/shape:#3/row:@2/cell:@2"],
      ["insert-row", "slide:#256/shape:#3/row:@2"],
      ["insert-row", "slide:#256/shape:#3/row:@2"],
      ["insert-row", "slide:#256/shape:#3/row:@2"],
    ]);
    const after = applied(before, planned.ops);
    const xml = partText(after, "ppt/slides/slide1.xml");
    for (const [a, b] of [["Q1", "Q2"], ["Q2", "Q3"], ["Q3", "Q4"]] as const) expect(xml.indexOf(`>${a}<`)).toBeLessThan(xml.indexOf(`>${b}<`));
    expect(new PptxDocument(after, "deck.pptx").planTable(at(TABLE, "fail"), wanted).ops).toEqual([]);
  });

  test("without grow, rows that do not fit are said so; fail refuses them", async () => {
    const deck = new PptxDocument(pptx({ table: FIGURES.slice(0, 2) }), "deck.pptx");
    expect(deck.planTable(at(TABLE, "truncate"), FIGURES).notes.join(" ")).toContain("1 source rows do not fit");
    expect(await codeOf(() => deck.planTable(at(TABLE, "fail"), FIGURES))).toBe("table-overflow");
  });

  test("addresses that a pack does not resolve are refused by name", async () => {
    const deck = new PptxDocument(pptx(), "deck.pptx");
    expect(await codeOf(() => deck.planTable(at("slide:@1/shape:Nope"), FIGURES))).toBe("address-unresolved");
    expect(await codeOf(() => deck.planTable(at("slide:@9/shape:Table 1"), FIGURES))).toBe("address-unresolved");
    expect(await codeOf(() => deck.planTable(at("slide:~abc/shape:Table 1"), FIGURES))).toBe("unsupported-address");
    expect(await codeOf(() => deck.planTable(at("shape:@1"), FIGURES))).toBe("unsupported-address");
    expect(await codeOf(() => deck.planTable(at("Table 1"), FIGURES))).toBe("bad-target-address");
    expect(await codeOf(() => deck.planTable(at("slide:@1/shape:Title 1"), FIGURES))).toBe("unsupported-target");
    const merged = withPart(pptx(), "ppt/slides/slide1.xml", (xml) => xml.replace("<a:tc>", '<a:tc gridSpan="2">'));
    expect(await codeOf(() => new PptxDocument(merged, "deck.pptx").planTable(at(TABLE), FIGURES))).toBe("unsupported-target");
  });

  test("an apply that is refused writes nothing", async () => {
    const deck = new PptxDocument(pptx(), "deck.pptx");
    expect(await codeOf(() => deck.apply([{ op: "set", target: "slide:#256/shape:#3/row:@9/cell:@1", value: { text: "x" } }]))).toBe("address-unresolved");
    expect(await codeOf(() => deck.apply([{ op: "delete", target: "slide:#256/shape:#3" }]))).toBe("unsupported-op");
    expect(await codeOf(() => deck.apply([{ op: "insert-row", anchor: "slide:#256/shape:#3/row:@1", position: "after", cells: ["a"] }]))).toBe("table-row-width-mismatch");
  });
});

describe("a headline", () => {
  const SHORT = "Revenue grew";
  const LONG = "Revenue grew by twenty three percent year over year";

  test("is one set of its text, and nothing else of the deck changes", () => {
    const before = pptx({ headline: "old" });
    const planned = new PptxDocument(before, "deck.pptx").planHeadline(at(HEADLINE), SHORT);
    expect(planned.ops).toEqual([{ op: "set", target: "slide:#256/shape:#2", value: { text: SHORT } }]);
    const after = applied(before, planned.ops);
    expect(changedParts(before, after)).toEqual(["ppt/slides/slide1.xml"]);
    const xml = partText(after, "ppt/slides/slide1.xml");
    expect(xml).toContain(`<a:t>${SHORT}</a:t>`);
    expect(xml).toContain('sz="3200" b="1"');
    expect(new PptxDocument(after, "deck.pptx").planHeadline(at(HEADLINE), SHORT).ops).toEqual([]);
  });

  test("shrink_to_fit sets a smaller size when the text needs it, and only then", () => {
    const deck = new PptxDocument(pptx({ headline: "old" }), "deck.pptx");
    expect(deck.planHeadline(at(HEADLINE, "shrink_to_fit"), SHORT).ops).toHaveLength(1);
    const shrunk = deck.planHeadline(at(HEADLINE, "shrink_to_fit"), LONG);
    expect(shrunk.ops).toHaveLength(2);
    expect(shrunk.ops[1]).toEqual({ op: "format", target: "slide:#256/shape:#2", format: { font: { size: 27 } } });
    expect(shrunk.notes.join(" ")).toContain("shrinks from 32 to 27 points");
  });

  test("a shrunk headline is written at the size and reads back as fresh", () => {
    const before = pptx({ headline: "old" });
    const { ops } = new PptxDocument(before, "deck.pptx").planHeadline(at(HEADLINE, "shrink_to_fit"), LONG);
    const after = applied(before, ops);
    const xml = partText(after, "ppt/slides/slide1.xml");
    expect(xml).toContain('sz="2700"');
    expect(xml).not.toContain('sz="3200"');
    expect(new PptxDocument(after, "deck.pptx").planHeadline(at(HEADLINE, "shrink_to_fit"), LONG).ops).toEqual([]);
  });

  test("shrink_to_fit refuses text that fits at no size down to the floor", async () => {
    const deck = new PptxDocument(pptx({ headline: "old", headlineWidthPt: 120, headlineHeightPt: 20 }), "deck.pptx");
    expect(await codeOf(() => deck.planHeadline(at(HEADLINE, "shrink_to_fit"), LONG))).toBe("text-does-not-fit");
  });

  test("truncate cuts the text with an ellipsis, fail refuses it, none and grow-less policies write it whole", async () => {
    const deck = new PptxDocument(pptx({ headline: "old" }), "deck.pptx");
    const cut = textOfSet(deck.planHeadline(at(HEADLINE, "truncate"), LONG).ops[0]);
    expect(cut.endsWith("\u2026")).toBe(true);
    expect(cut.length).toBeLessThan(LONG.length);
    expect(await codeOf(() => deck.planHeadline(at(HEADLINE, "fail"), LONG))).toBe("text-does-not-fit");
    expect(textOfSet(deck.planHeadline(at(HEADLINE, "none"), LONG).ops[0])).toBe(LONG);
  });

  test("a shape that has no text or no size is refused", async () => {
    const noText = withPart(pptx(), "ppt/slides/slide1.xml", (xml) => xml.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, ""));
    expect(await codeOf(() => new PptxDocument(noText, "deck.pptx").planHeadline(at(HEADLINE), SHORT))).toBe("unsupported-target");
    const noSize = withPart(pptx(), "ppt/slides/slide1.xml", (xml) => xml.replace(/<a:ext cx="6096000" cy="914400"\/>/, ""));
    expect(await codeOf(() => new PptxDocument(noSize, "deck.pptx").planHeadline(at(HEADLINE, "fail"), SHORT))).toBe("unsupported-target");
  });
});

describe("a chart series", () => {
  test("is planned point by point and fresh when it already holds the values", () => {
    const deck = new PptxDocument(pptx({ series: [1, 2, 3] }), "deck.pptx");
    expect(deck.planChartSeries(at(SERIES), [1, 2, 3])).toEqual({ ops: [], notes: [] });
    expect(deck.planChartSeries(at(SERIES), [1, 5, 3]).ops).toEqual([{ op: "set", target: "slide:#256/shape:#4/chart/series:Sales/point:@2", value: { number: 5 } }]);
    expect(deck.planChartSeries(at("slide:@1/shape:@3/chart/series:@1"), [9, 2, 3]).ops[0]?.target).toBe("slide:#256/shape:#4/chart/series:@1/point:@1");
  });

  test("writes the cache of the chart and the cells of its embedded workbook, and nothing else", () => {
    const before = pptx({ series: [1, 2, 3] });
    const { ops } = new PptxDocument(before, "deck.pptx").planChartSeries(at(SERIES), [10.5, 2, 30]);
    const after = applied(before, ops);
    expect(changedParts(before, after)).toEqual(["ppt/charts/chart1.xml", "ppt/embeddings/Microsoft_Excel_Sheet1.xlsx"]);
    const chart = partText(after, "ppt/charts/chart1.xml");
    expect(chart).toContain('<c:pt idx="0"><c:v>10.5</c:v></c:pt>');
    expect(chart).toContain('<c:pt idx="2"><c:v>30</c:v></c:pt>');
    const embedded = new OoxmlPackage(after).bytes("ppt/embeddings/Microsoft_Excel_Sheet1.xlsx");
    expect(embedded).toBeDefined();
    const workbook = new XlsxWorkbook(embedded ?? new Uint8Array(), "embedded.xlsx");
    expect(workbook.block("Sheet1", { from: { column: 2, row: 2 }, to: { column: 2, row: 4 } }).map((row) => row[0]?.value)).toEqual([10.5, 2, 30]);
    expect(new PptxDocument(after, "deck.pptx").planChartSeries(at(SERIES), [10.5, 2, 30]).ops).toEqual([]);
  });

  test("fewer values than points leave the rest as they are; more are said so, or refused by fail", async () => {
    const deck = new PptxDocument(pptx({ series: [1, 2, 3] }), "deck.pptx");
    expect(deck.planChartSeries(at(SERIES), [1, 2]).notes.join(" ")).toContain("1 points");
    expect(deck.planChartSeries(at(SERIES), [1, 2, 3, 4]).notes.join(" ")).toContain("1 source values do not fit");
    expect(await codeOf(() => deck.planChartSeries(at(SERIES, "fail"), [1, 2, 3, 4]))).toBe("series-overflow");
  });

  test("a series whose workbook cell holds a formula is refused, never overwritten", async () => {
    const before = pptx({ series: [1, 2, 3], workbookFormulas: true });
    const { ops } = new PptxDocument(before, "deck.pptx").planChartSeries(at(SERIES), [7, 2, 3]);
    expect(await codeOf(() => applied(before, ops))).toBe("unsupported-target");
  });

  test("names what is not a chart or has no such series", async () => {
    const deck = new PptxDocument(pptx(), "deck.pptx");
    expect(await codeOf(() => deck.planChartSeries(at("slide:@1/shape:Table 1/chart/series:Sales"), [1]))).toBe("unsupported-target");
    expect(await codeOf(() => deck.planChartSeries(at("slide:@1/shape:Chart 1/chart/series:Nope"), [1]))).toBe("address-unresolved");
    expect(await codeOf(() => deck.planChartSeries(at("slide:@1/shape:Chart 1"), [1]))).toBe("bad-target-address");
  });
});
