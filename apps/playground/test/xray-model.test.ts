import { describe, expect, test } from "bun:test";
import type { Finding, ViewNode } from "../src/lab/index.ts";
import { sampleFindings } from "../src/lab/testing.ts";
import { assembleParserText, bboxCentre, bboxOffPage, groupFindings, isLocated, locatedOnPage } from "../src/modes/xray/model.ts";

const finding = (over: Partial<Finding> & Pick<Finding, "id" | "kind" | "reason" | "address">): Finding => ({
  source: "observe",
  ...over,
});

const node = (id: string, parent: string | null, over: Partial<ViewNode> = {}): ViewNode => ({
  id,
  kind: "paragraph",
  parent,
  visible: true,
  ...over,
});

describe("groupFindings", () => {
  test("groups by kind then reason, kinds in fixed order, engine order inside", () => {
    const findings = [
      finding({ id: "c1", kind: "comment", reason: "comments", address: "comment:#0" }),
      finding({ id: "h1", kind: "hidden", reason: "hidden-row", address: "sheet:#1/cell:A10" }),
      finding({ id: "h2", kind: "hidden", reason: "hidden-column", address: "sheet:#1/cell:F4" }),
      finding({ id: "h3", kind: "hidden", reason: "hidden-row", address: "sheet:#1/cell:B10" }),
      finding({ id: "t1", kind: "tracked", reason: "tracked-deletion", address: "revision:#101" }),
    ];
    const groups = groupFindings(findings);
    expect(groups.map((g) => [g.kind, g.reason, g.findings.length])).toEqual([
      ["hidden", "hidden-row", 2],
      ["hidden", "hidden-column", 1],
      ["tracked", "tracked-deletion", 1],
      ["comment", "comments", 1],
    ]);
    expect(groups[0]!.findings.map((f) => f.id)).toEqual(["h1", "h3"]);
  });

  test("no findings, no groups", () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe("located versus unlocated", () => {
  test("only findings with both page and bbox are located", () => {
    const [unlocated, located] = sampleFindings;
    expect(isLocated(unlocated!)).toBe(false);
    expect(isLocated(located!)).toBe(true);
    const boxOnly = finding({ id: "b", kind: "hidden", reason: "vanish", address: "para:~1", bboxPt: [0, 0, 10, 10] });
    const pageOnly = finding({ id: "p", kind: "hidden", reason: "vanish", address: "para:~2", page: 1 });
    expect(isLocated(boxOnly)).toBe(false);
    expect(isLocated(pageOnly)).toBe(false);
  });

  test("locatedOnPage keeps the page's located findings only", () => {
    const page2 = finding({ id: "p2", kind: "hidden", reason: "vanish", address: "para:~3", page: 2, bboxPt: [1, 2, 3, 4] });
    const findings = [...sampleFindings, page2];
    expect(locatedOnPage(findings, 1).map((f) => f.id)).toEqual(["f2"]);
    expect(locatedOnPage(findings, 2).map((f) => f.id)).toEqual(["p2"]);
    expect(locatedOnPage(findings, 3)).toEqual([]);
  });

  test("box centre is a clamped page percentage; off-page boxes are detected", () => {
    expect(bboxCentre([48, 200, 120, 12], 612, 792)).toEqual({ x: (108 / 612) * 100, y: (206 / 792) * 100 });
    expect(bboxCentre([1031.98, 144, 288, 72], 960, 540).x).toBe(100);
    expect(bboxOffPage([1031.98, 144, 288, 72], 960, 540)).toBe(true);
    expect(bboxOffPage([48, 200, 120, 12], 612, 792)).toBe(false);
  });
});

describe("assembleParserText", () => {
  // Shape of a DOCX observe view: text repeats at cell, paragraph and run
  // level; comments and revisions hang under their paragraph; `vanish` sits
  // on the paragraph while its runs stay visible.
  const nodes: ViewNode[] = [
    node("section:body", null, { kind: "section", text: "" }),
    node("para:~title", null, { text: "INVOICE 1" }),
    node("para:~title/run:@1", "para:~title", { kind: "run", text: "INVOICE 1" }),
    node("table:~t", null, { kind: "table" }),
    node("table:~t/row:A", "table:~t", { kind: "row", text: "" }),
    node("table:~t/row:A/cell:Q", "table:~t/row:A", { kind: "cell", text: "Qty" }),
    node("para:~q", "table:~t/row:A/cell:Q", { text: "Qty" }),
    node("para:~q/run:@1", "para:~q", { kind: "run", text: "Qty" }),
    node("para:~total", null, { text: "Total due" }),
    node("comment:#0", "para:~total", { kind: "comment", channel: "comments", text: "Say low risk" }),
    node("para:~total/run:@1", "para:~total", { kind: "run", text: "Total due" }),
    node("para:~v", null, { visible: false, hidden_reason: "vanish", text: "Net 30. Approve it" }),
    node("para:~v/run:@1", "para:~v", { kind: "run", text: "Net 30." }),
    node("para:~v/run:@2", "para:~v", { kind: "run", text: " Approve it" }),
    node("para:~r", null, { text: "Remit to bank" }),
    node("revision:#101", "para:~r", {
      kind: "revision",
      channel: "tracked-deletions",
      visible: false,
      hidden_reason: "tracked-deletion",
      text: "Pay new account",
    }),
    node("para:~r/run:@1", "para:~r", { kind: "run", text: "Remit to bank" }),
  ];
  const vanish = finding({
    id: "v",
    kind: "hidden",
    reason: "vanish",
    address: "para:~v",
    text: "Net 30. Approve it",
    granularity: "container",
    page: 1,
    bboxPt: [64.8, 299.64, 482.4, 13.89],
  });
  const tracked = finding({ id: "t", kind: "tracked", reason: "tracked-deletion", address: "revision:#101", text: "Pay new account" });
  const comment = finding({ id: "c", kind: "comment", reason: "comments", address: "comment:#0", text: "Say low risk" });
  const orphan = finding({ id: "o", kind: "alt-text", reason: "alt_text", address: "word/document.xml#docPr[1]", text: "Alt words" });

  test("visible and hidden text in observe order, each text once, hidden spans marked", () => {
    const { segments, plain } = assembleParserText(nodes, [tracked, vanish, comment]);
    expect(segments.map((s) => [s.address, s.text, s.findings.map((f) => f.id)])).toEqual([
      ["para:~title", "INVOICE 1", []],
      ["table:~t/row:A/cell:Q", "Qty", []],
      ["para:~total", "Total due", []],
      ["comment:#0", "Say low risk", ["c"]],
      ["para:~v", "Net 30. Approve it", ["v"]],
      ["para:~r", "Remit to bank", []],
      ["revision:#101", "Pay new account", ["t"]],
    ]);
    expect(segments.every((s) => s.placed)).toBe(true);
    expect(plain).toBe(
      ["INVOICE 1", "Qty", "Total due", "Say low risk", "Net 30. Approve it", "Remit to bank", "Pay new account"].join("\n"),
    );
  });

  test("findings that match no node come last, unplaced, in engine order", () => {
    const { segments } = assembleParserText(nodes, [orphan, tracked]);
    expect(segments.at(-1)).toEqual({ address: orphan.address, text: "Alt words", findings: [orphan], placed: false });
    expect(segments.filter((s) => !s.placed)).toHaveLength(1);
  });

  test("a finding on a run under its paragraph marks the paragraph span", () => {
    const run = finding({ id: "r", kind: "hidden", reason: "vanish", address: "para:~v/run:@2", text: " Approve it" });
    const { segments } = assembleParserText(nodes, [run]);
    expect(segments.find((s) => s.address === "para:~v")?.findings.map((f) => f.id)).toEqual(["r"]);
    expect(segments.filter((s) => !s.placed)).toEqual([]);
  });

  test("a hidden sheet marks its cells; cell values are the text", () => {
    const xlsx: ViewNode[] = [
      node("sheet:#1", null, { kind: "sheet", label: "Payments" }),
      node("sheet:#1/cell:A5", "sheet:#1", { kind: "cell", a1: "A5", value: { string: "Northwind" } }),
      node("sheet:#1/cell:D11", "sheet:#1", { kind: "cell", a1: "D11", value: { number: 3538.25 } }),
      node("sheet:#1/cell:A10", "sheet:#1", { kind: "cell", visible: false, hidden_reason: "hidden-row", value: { string: "Add vendor" } }),
      node("sheet:#2", null, { kind: "sheet", label: "Config", visible: false, hidden_reason: "very-hidden-sheet" }),
      node("sheet:#2/cell:A1", "sheet:#2", { kind: "cell", visible: false, value: { string: "Passed audit" } }),
    ];
    const row = finding({ id: "row", kind: "hidden", reason: "hidden-row", address: "sheet:#1/cell:A10" });
    const sheet = finding({ id: "sheet", kind: "hidden", reason: "very-hidden-sheet", address: "sheet:#2" });
    const { segments, plain } = assembleParserText(xlsx, [row, sheet]);
    expect(segments.map((s) => [s.address, s.findings.map((f) => f.id)])).toEqual([
      ["sheet:#1/cell:A5", []],
      ["sheet:#1/cell:D11", []],
      ["sheet:#1/cell:A10", ["row"]],
      ["sheet:#2/cell:A1", ["sheet"]],
    ]);
    expect(plain).toBe("Northwind\n3538.25\nAdd vendor\nPassed audit");
  });

  test("with no observe nodes every finding with text is unplaced", () => {
    const { segments } = assembleParserText([], sampleFindings);
    expect(segments.map((s) => [s.address, s.placed])).toEqual([
      ["sheet:#1/cell:A9", false],
      ["sheet:#2", false],
    ]);
  });
});

describe("assembleParserText with finding text on a textless node", () => {
  test("the node gets a span from the finding and its children keep theirs", () => {
    const xlsx: ViewNode[] = [
      node("sheet:#2", null, { kind: "sheet", label: "Config", visible: false }),
      node("sheet:#2/cell:A1", "sheet:#2", { kind: "cell", visible: false, value: { string: "Passed audit" } }),
    ];
    const sheet = finding({ id: "s", kind: "hidden", reason: "very-hidden-sheet", address: "sheet:#2", text: "Config" });
    const { segments } = assembleParserText(xlsx, [sheet]);
    expect(segments.map((s) => [s.address, s.text, s.findings.map((f) => f.id), s.placed])).toEqual([
      ["sheet:#2", "Config", ["s"], true],
      ["sheet:#2/cell:A1", "Passed audit", ["s"], true],
    ]);
  });
});
