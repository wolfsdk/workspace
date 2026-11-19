import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ReadError } from "../src/read/model.ts";
import type { ReadableDocument } from "../src/read/model.ts";
import { openPptx } from "../src/read/pptx.ts";
import { writeZip } from "../src/read/zip.ts";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const para = (text: string, level = 0): string => `<a:p>${level > 0 ? `<a:pPr lvl="${level}"/>` : ""}<a:r><a:t>${text}</a:t></a:r></a:p>`;
const textBody = (paras: string): string => `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>`;

function sp(id: number, name: string, paras: string, ph = ""): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/>${textBody(paras)}</p:sp>`;
}

const pic = (id: number, name: string): string =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="company logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`;

const group = (id: number, name: string, children: string): string =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${children}</p:grpSp>`;

const connector = (id: number): string =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>`;

function table(id: number, name: string, rows: string[][]): string {
  const trs = rows.map((row) => `<a:tr h="370840">${row.map((cell) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(cell)}</a:txBody></a:tc>`).join("")}</a:tr>`).join("");
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid/>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

const chart = (id: number, name: string, rid = "rId9"): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;

/** `c:pt` entries of a cache: `undefined` leaves the index out, as a chart does for a blank point. */
const pts = (values: readonly (string | undefined)[]): string =>
  `<c:ptCount val="${values.length}"/>${values.map((value, i) => (value === undefined ? "" : `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`)).join("")}`;
const strRef = (f: string, values: readonly (string | undefined)[]): string => `<c:strRef><c:f>${f}</c:f><c:strCache>${pts(values)}</c:strCache></c:strRef>`;
const numRef = (f: string, values: readonly (string | undefined)[]): string =>
  `<c:numRef><c:f>${f}</c:f><c:numCache><c:formatCode>General</c:formatCode>${pts(values)}</c:numCache></c:numRef>`;
const ser = (idx: number, tx: string, cat: string, val: string): string =>
  `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx>${tx}</c:tx><c:cat>${cat}</c:cat><c:val>${val}</c:val></c:ser>`;

/** A chart part: a bar chart with Sales (a referenced name) and Cost (a literal name, Q2 blank), one series filtered
 * out in an extension, and a line chart whose categories are two-level and whose values are a literal. */
function chartXml(): string {
  const quarters = strRef("Sheet1!$A$2:$A$4", ["Q1", "Q2", "Q3"]);
  const filtered =
    '<c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:filteredBarSeries xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart">' +
    `<c15:ser>${ser(9, strRef("Sheet1!$E$1", ["Hidden"]), quarters, numRef("Sheet1!$E$2:$E$4", ["1", "2", "3"]))}</c15:ser></c15:filteredBarSeries></c:ext></c:extLst>`;
  const bar =
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>` +
    ser(0, strRef("Sheet1!$B$1", ["Sales"]), quarters, numRef("Sheet1!$B$2:$B$4", ["10", "20.5", "30"])) +
    ser(1, "<c:v>Cost</c:v>", quarters, numRef("Sheet1!$C$2:$C$4", ["4", undefined, "6"])) +
    `${filtered}<c:axId val="1"/><c:axId val="2"/></c:barChart>`;
  const twoLevel =
    `<c:multiLvlStrRef><c:f>Sheet1!$F$2:$G$3</c:f><c:multiLvlStrCache><c:ptCount val="2"/>` +
    `<c:lvl><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:lvl><c:lvl><c:pt idx="0"><c:v>2026</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef>`;
  const line = `<c:lineChart><c:grouping val="standard"/>${ser(2, strRef("Sheet1!$D$1", ["Target"]), twoLevel, `<c:numLit>${pts(["7", "x"])}</c:numLit>`)}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`;
  return `${XML}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ${NS}><c:chart><c:plotArea><c:layout/>${bar}${line}<c:catAx/><c:valAx/></c:plotArea></c:chart></c:chartSpace>`;
}

/** `charts` maps a slide relationship id to the chart part it names. */
type SlideSpec = { id: number; shapes: string; hidden?: boolean; notes?: string; charts?: Record<string, string> };

/** A minimal package: `[Content_Types].xml`, `_rels/.rels`, the presentation with its rels, each slide with its
 * notes and chart parts. */
function buildPptx(slides: SlideSpec[], options: { skipMain?: boolean; mainXml?: string } = {}): Uint8Array {
  const files: { name: string; data: string }[] = [
    {
      name: "[Content_Types].xml",
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    },
  ];
  if (options.skipMain) return writeZip(files);
  const list = slides.map((slide, i) => `<p:sldId id="${slide.id}" r:id="rId${i + 2}"/>`).join("");
  files.push({
    name: "ppt/presentation.xml",
    data: options.mainXml ?? `${XML}<p:presentation ${NS}><p:sldMasterIdLst/><p:sldIdLst>${list}</p:sldIdLst></p:presentation>`,
  });
  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides
      .map((slide, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join("")}</Relationships>`,
  });
  slides.forEach((slide, i) => {
    files.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `${XML}<p:sld ${NS}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${slide.shapes}</p:spTree></p:cSld></p:sld>`,
    });
    const rels: string[] = [];
    if (slide.notes !== undefined) {
      rels.push(`<Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`);
      files.push({
        name: `ppt/notesSlides/notesSlide${i + 1}.xml`,
        data:
          `${XML}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
          `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
          sp(3, "Notes Placeholder 2", slide.notes, '<p:ph type="body" idx="1"/>') +
          sp(4, "Slide Number Placeholder 3", '<a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p>', '<p:ph type="sldNum" idx="5"/>') +
          "</p:spTree></p:cSld></p:notes>",
      });
    }
    Object.entries(slide.charts ?? {}).forEach(([rid, xml], k) => {
      const part = `chart${i + 1}_${k + 1}.xml`;
      rels.push(`<Relationship Id="${rid}" Type="${REL}/chart" Target="../charts/${part}"/>`);
      files.push({ name: `ppt/charts/${part}`, data: xml });
    });
    if (rels.length > 0) files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: `${XML}<Relationships xmlns="${RELS_NS}">${rels.join("")}</Relationships>` });
  });
  return writeZip(files);
}

function fixture(): Uint8Array {
  const slide1 =
    sp(2, "Title 1", para("Quarterly Review"), '<p:ph type="title"/>') +
    sp(3, "Content Placeholder 2", para("Revenue grew") + para("EMEA led", 1), '<p:ph idx="1"/>') +
    group(4, "Group 4", sp(5, "Child Box", para("Inside group"))) +
    pic(6, "Logo") +
    table(7, "Table 7", [
      ["Region", "Q1"],
      ["EMEA", "10"],
    ]) +
    connector(8);
  const slide2 = sp(2, "Title 1", para("Appendix"), '<p:ph type="title"/>') + sp(3, "Note", para("A")) + sp(4, "Note", para("B"));
  return buildPptx([
    { id: 256, shapes: slide1, notes: para("Remember to mention churn.") },
    { id: 300, shapes: slide2, hidden: true },
  ]);
}

/** One slide holding a title, the chart frame `Chart 1` whose part is `chartXml`, and a table. */
const chartDeck = (): ReadableDocument =>
  openPptx(
    buildPptx([
      {
        id: 256,
        shapes: sp(2, "Title 1", para("Revenue"), '<p:ph type="title"/>') + chart(4, "Chart 1") + table(5, "Table 5", [["a"]]),
        charts: { rId9: chartXml() },
      },
    ]),
  );

function readError(fn: () => unknown): ReadError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReadError) return error;
    throw error;
  }
  throw new Error("expected a ReadError");
}

const addresses = (doc: ReadableDocument, target?: string): string[] => doc.blocks(target).map((block) => block.address);

describe("openPptx structure", () => {
  const doc = openPptx(fixture());

  test("lists slides, shapes, rows, cells and notes in document order with depths", () => {
    expect(doc.format).toBe("pptx");
    expect(doc.blocks().map((block) => [block.address, block.kind, block.depth])).toEqual([
      ["slide:#256", "slide", 0],
      ["slide:#256/shape:#2", "shape", 1],
      ["slide:#256/shape:#3", "shape", 1],
      ["slide:#256/shape:#4", "group", 1],
      ["slide:#256/shape:#5", "shape", 2],
      ["slide:#256/shape:#6", "picture", 1],
      ["slide:#256/shape:#7", "table", 1],
      ["slide:#256/shape:#7/row:@1", "row", 2],
      ["slide:#256/shape:#7/row:@1/cell:@1", "cell", 3],
      ["slide:#256/shape:#7/row:@1/cell:@2", "cell", 3],
      ["slide:#256/shape:#7/row:@2", "row", 2],
      ["slide:#256/shape:#7/row:@2/cell:@1", "cell", 3],
      ["slide:#256/shape:#7/row:@2/cell:@2", "cell", 3],
      ["slide:#256/notes", "notes", 1],
      ["slide:#300", "slide", 0],
      ["slide:#300/shape:#2", "shape", 1],
      ["slide:#300/shape:#3", "shape", 1],
      ["slide:#300/shape:#4", "shape", 1],
    ]);
  });

  test("slide blocks carry the title label, the positional alias and the meta", () => {
    const blocks = doc.blocks();
    const first = blocks[0];
    const second = blocks[14];
    expect(first).toEqual({
      address: "slide:#256",
      aliases: ["slide:@1"],
      kind: "slide",
      depth: 0,
      text: "",
      label: "Quarterly Review",
      meta: { slide_id: 256, index: 1, shapes: 6 },
    });
    expect(second?.aliases).toEqual(["slide:@2"]);
    expect(second?.label).toBe("Appendix");
    expect(second?.meta).toEqual({ slide_id: 300, index: 2, shapes: 3, hidden: true });
  });

  test("shape blocks carry name aliases only when the name is unique, text and meta", () => {
    const byAddress = new Map(doc.blocks().map((block) => [block.address, block]));
    const title = byAddress.get("slide:#256/shape:#2");
    expect(title?.aliases).toEqual(["slide:#256/shape:Title 1"]);
    expect(title?.label).toBe("Title 1");
    expect(title?.text).toBe("Quarterly Review");
    expect(title?.meta).toEqual({ placeholder: "title", paragraphs: 1 });
    const body = byAddress.get("slide:#256/shape:#3");
    expect(body?.text).toBe("Revenue grew\nEMEA led");
    expect(body?.meta).toEqual({ placeholder: "obj", paragraphs: 2 });
    expect(byAddress.get("slide:#256/shape:#5")?.text).toBe("Inside group");
    expect(byAddress.get("slide:#256/shape:#5")?.meta).toEqual({ placeholder: null, paragraphs: 1 });
    expect(byAddress.get("slide:#256/shape:#6")?.aliases).toEqual(["slide:#256/shape:Logo"]);
    expect(byAddress.get("slide:#256/shape:#7")?.meta).toEqual({ placeholder: null, paragraphs: 0, rows: 2, columns: 2 });
    expect(byAddress.get("slide:#300/shape:#3")?.aliases).toBeUndefined();
    expect(byAddress.get("slide:#300/shape:#4")?.aliases).toBeUndefined();
    expect(byAddress.get("slide:#256")?.meta?.hidden).toBeUndefined();
  });

  test("rows join cells with a tab, cells carry their text, notes read the body placeholder only", () => {
    const byAddress = new Map(doc.blocks().map((block) => [block.address, block]));
    expect(byAddress.get("slide:#256/shape:#7/row:@2")?.text).toBe("EMEA\t10");
    expect(byAddress.get("slide:#256/shape:#7/row:@2/cell:@2")?.text).toBe("10");
    const notes = byAddress.get("slide:#256/notes");
    expect(notes?.text).toBe("Remember to mention churn.");
    expect(notes?.meta).toEqual({ paragraphs: 1 });
  });
});

describe("openPptx views", () => {
  const doc = openPptx(fixture());

  test("text lists each slide under a heading, table rows tab-joined, notes last", () => {
    expect(doc.text()).toBe(
      [
        "# Slide 1 - Quarterly Review",
        "Quarterly Review",
        "Revenue grew",
        "EMEA led",
        "Inside group",
        "Region\tQ1",
        "EMEA\t10",
        "Notes: ",
        "Remember to mention churn.",
        "# Slide 2 - Appendix",
        "Appendix",
        "A",
        "B",
      ].join("\n"),
    );
  });

  test("markdown has slide sections, bullets for body placeholders, pipe tables and quoted notes", () => {
    expect(doc.markdown()).toBe(
      [
        "## Slide 1: Quarterly Review",
        "- Revenue grew\n  - EMEA led",
        "Inside group",
        "| Region | Q1 |\n| --- | --- |\n| EMEA | 10 |",
        "> Remember to mention churn.",
        "## Slide 2: Appendix",
        "A",
        "B",
      ].join("\n\n"),
    );
  });

  test("units are one per shape paragraph, table cell and notes paragraph", () => {
    expect(doc.units()).toEqual([
      { address: "slide:#256/shape:#2/para:@1", text: "Quarterly Review" },
      { address: "slide:#256/shape:#3/para:@1", text: "Revenue grew" },
      { address: "slide:#256/shape:#3/para:@2", text: "EMEA led" },
      { address: "slide:#256/shape:#5/para:@1", text: "Inside group" },
      { address: "slide:#256/shape:#7/row:@1/cell:@1", text: "Region" },
      { address: "slide:#256/shape:#7/row:@1/cell:@2", text: "Q1" },
      { address: "slide:#256/shape:#7/row:@2/cell:@1", text: "EMEA" },
      { address: "slide:#256/shape:#7/row:@2/cell:@2", text: "10" },
      { address: "slide:#256/notes/para:@1", text: "Remember to mention churn." },
      { address: "slide:#300/shape:#2/para:@1", text: "Appendix" },
      { address: "slide:#300/shape:#3/para:@1", text: "A" },
      { address: "slide:#300/shape:#4/para:@1", text: "B" },
    ]);
  });

  test("a presentation has no cells view", () => {
    const error = readError(() => doc.cells());
    expect(error.code).toBe("unsupported-view");
    expect(error.message).toBe("a presentation has no cells view");
  });
});

describe("openPptx targets", () => {
  const doc = openPptx(fixture());

  test("slide:@n and slide:#id name the same slide and everything below it", () => {
    expect(addresses(doc, "slide:@2")).toEqual(["slide:#300", "slide:#300/shape:#2", "slide:#300/shape:#3", "slide:#300/shape:#4"]);
    expect(addresses(doc, "slide:#300")).toEqual(addresses(doc, "slide:@2"));
    expect(doc.text("slide:@2")).toBe(["# Slide 2 - Appendix", "Appendix", "A", "B"].join("\n"));
    expect(doc.markdown("slide:@2")).toBe(["## Slide 2: Appendix", "A", "B"].join("\n\n"));
  });

  test("the notes target returns the notes block", () => {
    expect(doc.blocks("slide:#256/notes").map((block) => [block.address, block.text])).toEqual([["slide:#256/notes", "Remember to mention churn."]]);
    expect(addresses(doc, "slide:@1/notes")).toEqual(["slide:#256/notes"]);
    expect(doc.text("slide:#256/notes")).toBe("Notes: \nRemember to mention churn.");
    expect(doc.markdown("slide:#256/notes")).toBe("> Remember to mention churn.");
  });

  test("shapes resolve by id, by unique name and by position, and groups bring their members", () => {
    expect(addresses(doc, "slide:#256/shape:#3")).toEqual(["slide:#256/shape:#3"]);
    expect(addresses(doc, "slide:#256/shape:Content Placeholder 2")).toEqual(["slide:#256/shape:#3"]);
    expect(addresses(doc, "slide:@1/shape:@2")).toEqual(["slide:#256/shape:#3"]);
    expect(addresses(doc, "slide:#256/shape:#4")).toEqual(["slide:#256/shape:#4", "slide:#256/shape:#5"]);
    expect(addresses(doc, "slide:#256/shape:#5")).toEqual(["slide:#256/shape:#5"]);
  });

  test("a table frame, a row and a cell return themselves and what lies below", () => {
    expect(addresses(doc, "slide:#256/shape:#7/row:@2")).toEqual([
      "slide:#256/shape:#7/row:@2",
      "slide:#256/shape:#7/row:@2/cell:@1",
      "slide:#256/shape:#7/row:@2/cell:@2",
    ]);
    expect(addresses(doc, "slide:#256/shape:Table 7/row:@1/cell:@2")).toEqual(["slide:#256/shape:#7/row:@1/cell:@2"]);
    expect(doc.text("slide:#256/shape:#7")).toBe("Region\tQ1\nEMEA\t10");
    expect(doc.markdown("slide:#256/shape:#7/row:@2/cell:@1")).toBe("EMEA");
  });

  test("a para target returns its shape block", () => {
    expect(addresses(doc, "slide:#256/shape:#3/para:@2")).toEqual(["slide:#256/shape:#3"]);
    expect(addresses(doc, "slide:#256/notes/para:@1")).toEqual(["slide:#256/notes"]);
  });

  test("a fingerprint key picks the shape or paragraph with that text", () => {
    const fp = createHash("sha256").update("Quarterly Review").digest("hex").slice(0, 8);
    expect(addresses(doc, `slide:#256/shape:~${fp}`)).toEqual(["slide:#256/shape:#2"]);
    expect(addresses(doc, `slide:#256/shape:#2/para:~${fp}`)).toEqual(["slide:#256/shape:#2"]);
    const dup = createHash("sha256").update("A").digest("hex").slice(0, 8);
    expect(addresses(doc, `slide:#300/shape:~${dup}.1`)).toEqual(["slide:#300/shape:#3"]);
  });

  test("an address that names nothing, or is not understood, is address-unresolved", () => {
    for (const target of [
      "slide:#999",
      "slide:@3",
      "slide:@0",
      "slide:#256/shape:#99",
      "slide:#256/shape:Nope",
      "slide:#300/shape:Note",
      "slide:#300/notes",
      "slide:#256/shape:#3/para:@3",
      "slide:#256/shape:#6/row:@1",
      "slide:#256/shape:#7/row:@3",
      "slide:#256/shape:#3/chart",
      "para:@1",
      "sheet:#1",
      "slide:#256/shape:~00000000",
    ]) {
      const error = readError(() => doc.blocks(target));
      expect(error.code).toBe("address-unresolved");
      expect(error.message).toBe(`${target} names nothing in this document`);
    }
    expect(readError(() => doc.text("slide:#999")).code).toBe("address-unresolved");
    expect(readError(() => doc.markdown("slide:#999")).code).toBe("address-unresolved");
  });
});

describe("openPptx chart series", () => {
  const doc = chartDeck();
  const SERIES = "slide:#256/shape:#4/chart/series";

  test("a series address, as a pack binding writes it, reads the name, categories and values of the chart cache", () => {
    const target = "slide:@1/shape:Chart 1/chart/series:Sales";
    expect(doc.blocks(target)).toEqual([
      { address: `${SERIES}:@1`, aliases: [`${SERIES}:Sales`], kind: "series", depth: 2, text: "Sales", label: "Sales", meta: { chart_type: "barChart", points: 3 } },
      { address: `${SERIES}:@1/point:@1`, aliases: [`${SERIES}:@1/point:Q1`], kind: "point", depth: 3, text: "10", label: "Q1", meta: { category: "Q1", value: 10 } },
      { address: `${SERIES}:@1/point:@2`, aliases: [`${SERIES}:@1/point:Q2`], kind: "point", depth: 3, text: "20.5", label: "Q2", meta: { category: "Q2", value: 20.5 } },
      { address: `${SERIES}:@1/point:@3`, aliases: [`${SERIES}:@1/point:Q3`], kind: "point", depth: 3, text: "30", label: "Q3", meta: { category: "Q3", value: 30 } },
    ]);
    expect(doc.text(target)).toBe("Sales\nQ1\t10\nQ2\t20.5\nQ3\t30");
    expect(doc.markdown(target)).toBe("| Category | Sales |\n| --- | --- |\n| Q1 | 10 |\n| Q2 | 20.5 |\n| Q3 | 30 |");
    for (const same of [`${SERIES}:@1`, `${SERIES}:Sales`, "slide:#256/shape:#4/chart/series:@1"]) expect(doc.blocks(same)).toEqual(doc.blocks(target));
  });

  test("a point resolves by category or position; a blank cached value reads as null", () => {
    expect(addresses(doc, "slide:@1/shape:Chart 1/chart/series:Sales/point:Q2")).toEqual([`${SERIES}:@1/point:@2`]);
    expect(doc.text(`${SERIES}:@1/point:@2`)).toBe("Q2\t20.5");
    expect(doc.markdown(`${SERIES}:Sales/point:Q2`)).toBe("| Category | Value |\n| --- | --- |\n| Q2 | 20.5 |");
    const cost = doc.blocks(`${SERIES}:Cost`);
    expect(cost[0]?.address).toBe(`${SERIES}:@2`);
    expect(cost.slice(1).map((block) => [block.text, block.meta])).toEqual([
      ["4", { category: "Q1", value: 4 }],
      ["", { category: "Q2", value: null }],
      ["6", { category: "Q3", value: 6 }],
    ]);
    expect(doc.text(`${SERIES}:Cost`)).toBe("Cost\nQ1\t4\nQ2\t\nQ3\t6");
  });

  test("the chart frame lists its series addresses, extension series excluded, with their points", () => {
    const blocks = doc.blocks("slide:@1/shape:Chart 1");
    expect(blocks[0]).toEqual({ address: "slide:#256/shape:#4", aliases: ["slide:#256/shape:Chart 1"], kind: "chart", depth: 1, text: "", label: "Chart 1", meta: { placeholder: null, paragraphs: 0, series: 3 } });
    expect(blocks.filter((block) => block.kind === "series").map((block) => [block.address, block.aliases, block.label, block.meta])).toEqual([
      [`${SERIES}:@1`, [`${SERIES}:Sales`], "Sales", { chart_type: "barChart", points: 3 }],
      [`${SERIES}:@2`, [`${SERIES}:Cost`], "Cost", { chart_type: "barChart", points: 3 }],
      [`${SERIES}:@3`, [`${SERIES}:Target`], "Target", { chart_type: "lineChart", points: 2 }],
    ]);
    expect(blocks).toHaveLength(1 + 3 + 3 + 3 + 2);
    expect(doc.blocks("slide:#256/shape:#4/chart")).toEqual(blocks);
    expect(doc.blocks(`${SERIES}:Target`).slice(1).map((block) => [block.label, block.meta])).toEqual([
      ["Jan", { category: "Jan", value: 7 }],
      ["Feb", { category: "Feb", value: null }],
    ]);
  });

  test("whole-document views carry the chart data and search units leave it out", () => {
    expect(doc.text()).toBe(["# Slide 1 - Revenue", "Revenue", "Sales", "Q1\t10", "Q2\t20.5", "Q3\t30", "Cost", "Q1\t4", "Q2\t", "Q3\t6", "Target", "Jan\t7", "Feb\tx", "a"].join("\n"));
    expect(doc.markdown("slide:#256/shape:#4").split("\n\n")).toHaveLength(3);
    expect(doc.units()).toEqual([
      { address: "slide:#256/shape:#2/para:@1", text: "Revenue" },
      { address: "slide:#256/shape:#5/row:@1/cell:@1", text: "a" },
    ]);
  });

  test("series and point addresses that name nothing are address-unresolved", () => {
    for (const target of [
      "slide:#256/shape:#4/series:@1",
      "slide:#256/shape:#4/chart/series:@4",
      "slide:#256/shape:#4/chart/series:Nope",
      "slide:#256/shape:#4/chart/series:Sales/point:Q9",
      "slide:#256/shape:#4/chart/series:Sales/point:@4",
      "slide:#256/shape:#4/chart/row:@1",
      "slide:#256/shape:#4/chart/chart/series:@1",
      "slide:#256/shape:#4/chart/series:@1/chart",
      "slide:#256/shape:#5/chart/series:@1",
      "slide:#256/shape:#2/chart/series:@1",
    ]) {
      const error = readError(() => doc.blocks(target));
      expect(error.code).toBe("address-unresolved");
      expect(error.message).toBe(`${target} names nothing in this document`);
    }
  });
});

describe("openPptx edges", () => {
  test("a:br is a newline and a:fld contributes its text", () => {
    const paragraph = '<a:p><a:r><a:t>Page </a:t></a:r><a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld><a:br/><a:r><a:t>next &amp; last</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p>';
    const doc = openPptx(buildPptx([{ id: 5, shapes: sp(2, "Box", paragraph) }]));
    expect(doc.blocks("slide:#5/shape:#2")[0]?.text).toBe("Page 3\nnext & last\n");
    expect(doc.blocks("slide:#5/shape:#2")[0]?.meta).toEqual({ placeholder: null, paragraphs: 2 });
    expect(doc.text()).toBe("# Slide 1\nPage 3\nnext & last");
    expect(doc.units()).toEqual([{ address: "slide:#5/shape:#2/para:@1", text: "Page 3\nnext & last" }]);
  });

  test("shapes inside mc:AlternateContent are read and a chart frame is a chart", () => {
    const alt = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p14">${sp(2, "Wrapped", para("Hello"))}</mc:Choice><mc:Fallback>${sp(9, "Fallback", para("Old"))}</mc:Fallback></mc:AlternateContent>`;
    const doc = openPptx(buildPptx([{ id: 7, shapes: alt + chart(3, "Sales Chart") }]));
    expect(doc.blocks().map((block) => [block.address, block.kind])).toEqual([
      ["slide:#7", "slide"],
      ["slide:#7/shape:#2", "shape"],
      ["slide:#7/shape:#3", "chart"],
    ]);
    expect(addresses(doc, "slide:#7/shape:Sales Chart/chart")).toEqual(["slide:#7/shape:#3"]);
  });

  test("names with reserved characters are escaped in the alias and resolve back", () => {
    const doc = openPptx(buildPptx([{ id: 8, shapes: sp(2, "#1 a/b", para("x")) }]));
    expect(doc.blocks("slide:#8/shape:#2")[0]?.aliases).toEqual(["slide:#8/shape:%231 a%2Fb"]);
    expect(addresses(doc, "slide:#8/shape:%231 a%2Fb")).toEqual(["slide:#8/shape:#2"]);
  });

  test("a slide with no title has no label, an empty notes body emits no notes block, list levels indent", () => {
    const body = sp(2, "Body", para("one", 0) + para("two", 2) + para("plain"), '<p:ph type="body" idx="1"/>');
    const doc = openPptx(buildPptx([{ id: 9, shapes: body, notes: "<a:p><a:r><a:t> </a:t></a:r></a:p>" }]));
    const [slide] = doc.blocks();
    expect(slide?.label).toBeUndefined();
    expect(addresses(doc)).toEqual(["slide:#9", "slide:#9/shape:#2"]);
    expect(doc.markdown()).toBe("## Slide 1\n\n- one\n    - two\n- plain");
  });

  test("an explicit bullet marks a non-placeholder paragraph and buNone clears a body one", () => {
    const bulleted = '<a:p><a:pPr><a:buChar char="-"/></a:pPr><a:r><a:t>point</a:t></a:r></a:p>';
    const plain = '<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>flat</a:t></a:r></a:p>';
    const doc = openPptx(buildPptx([{ id: 1, shapes: sp(2, "A", bulleted) + sp(3, "B", plain, '<p:ph idx="1"/>') }]));
    expect(doc.markdown()).toBe("## Slide 1\n\n- point\n\nflat");
  });

  test("table cells escape pipes in markdown and ragged rows are padded", () => {
    const doc = openPptx(buildPptx([{ id: 1, shapes: table(2, "T", [["a|b", "c", "d"], ["e"]]) }]));
    expect(doc.markdown()).toBe("## Slide 1\n\n| a\\|b | c | d |\n| --- | --- | --- |\n| e |  |  |");
  });

  test("an empty slide list gives empty views", () => {
    const doc = openPptx(buildPptx([]));
    expect(doc.blocks()).toEqual([]);
    expect(doc.text()).toBe("");
    expect(doc.markdown()).toBe("");
    expect(doc.units()).toEqual([]);
  });
});

describe("openPptx invalid input", () => {
  test("bytes that are not a zip are invalid-input", () => {
    const error = readError(() => openPptx(new TextEncoder().encode("this is not a presentation")));
    expect(error.code).toBe("invalid-input");
  });

  test("empty and truncated input are invalid-input", () => {
    expect(readError(() => openPptx(new Uint8Array(0))).code).toBe("invalid-input");
    expect(readError(() => openPptx(fixture().subarray(0, 40))).code).toBe("invalid-input");
  });

  test("a zip without the presentation part is invalid-input", () => {
    const error = readError(() => openPptx(buildPptx([], { skipMain: true })));
    expect(error.code).toBe("invalid-input");
    expect(error.message).toContain("no presentation part");
  });

  test("a malformed presentation part is invalid-input", () => {
    expect(readError(() => openPptx(buildPptx([], { mainXml: "<p:presentation" }))).code).toBe("invalid-input");
    expect(readError(() => openPptx(buildPptx([], { mainXml: `${XML}<other/>` }))).code).toBe("invalid-input");
  });

  test("a slide that names a missing part is invalid-input", () => {
    const bytes = buildPptx([{ id: 1, shapes: "" }], { mainXml: `${XML}<p:presentation ${NS}><p:sldIdLst><p:sldId id="1" r:id="rId40"/></p:sldIdLst></p:presentation>` });
    expect(readError(() => openPptx(bytes)).code).toBe("invalid-input");
  });
});
