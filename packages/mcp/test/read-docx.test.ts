import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { openDocx } from "../src/read/docx.ts";
import { ReadError } from "../src/read/model.ts";
import { writeZip } from "../src/read/zip.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const STYLES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const rels = (...items: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">` +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' +
  "</w:styles>";

const documentXml = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:w14="${W14}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (text: string, props = "", attrs = ""): string => `<w:p${attrs}>${props ? `<w:pPr>${props}</w:pPr>` : ""}${run(text)}</w:p>`;
const cell = (...paragraphs: string[]): string => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraphs.join("")}</w:tc>`;
const row = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`;

/** A minimal Word package holding `body`. */
function docx(body: string, options: { styles?: boolean } = {}): Uint8Array {
  const withStyles = options.styles ?? true;
  return writeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: rels(`<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="word/document.xml"/>`) },
    { name: "word/document.xml", data: documentXml(body) },
    ...(withStyles
      ? [
          { name: "word/_rels/document.xml.rels", data: rels(`<Relationship Id="rId1" Type="${STYLES}" Target="styles.xml"/>`) },
          { name: "word/styles.xml", data: STYLES_XML },
        ]
      : []),
  ]);
}

const BODY = [
  // para 1: Title with a paraId
  para("Master Services Agreement", '<w:pStyle w:val="Title"/>', ' w14:paraId="0a1b2c3d"'),
  // para 2: Heading1 holding the bookmark Intro
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="Intro"/>${run("Introduction")}<w:bookmarkEnd w:id="1"/></w:p>`,
  // para 3: a nested list item
  para("First item", '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr>'),
  // para 4: tab, tracked deletion, line break, and a hidden bookmark
  `<w:p w14:paraId="5C7700d1"><w:bookmarkStart w:id="2" w:name="_GoBack"/><w:r><w:t>Pay</w:t><w:tab/><w:t>in 30</w:t></w:r>` +
    `<w:del w:id="9" w:author="a"><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:br/><w:t>days</w:t></w:r></w:p>`,
  // table 1 (paras 5 to 9)
  `<w:tbl><w:tblPr><w:tblCaption w:val="Fees"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>` +
    row(cell(para("Item")), cell(para("Price"))) +
    row(cell(para("Support")), cell(para("$5|mo"), para("net 30"))) +
    "</w:tbl>",
  // para 10 inside a content control, para 11 empty, para 12 last
  `<w:sdt><w:sdtPr><w:alias w:val="Wrapper"/></w:sdtPr><w:sdtContent>${para("Wrapped")}</w:sdtContent></w:sdt>`,
  "<w:p/>",
  para("Closing"),
].join("");

const doc = openDocx(docx(BODY));

describe("openDocx structure", () => {
  test("lists every block with canonical addresses, aliases, kinds and depths", () => {
    expect(doc.format).toBe("docx");
    expect(doc.blocks().map((b) => [b.address, b.kind, b.depth])).toEqual([
      ["para:#0A1B2C3D", "heading", 0],
      ["para:@2", "heading", 0],
      ["bookmark:Intro", "bookmark", 0],
      ["para:@3", "paragraph", 0],
      ["para:#5C7700D1", "paragraph", 0],
      ["table:@1", "table", 0],
      ["table:@1/row:@1", "row", 1],
      ["table:@1/row:@1/cell:@1", "cell", 2],
      ["para:@5", "paragraph", 3],
      ["table:@1/row:@1/cell:@2", "cell", 2],
      ["para:@6", "paragraph", 3],
      ["table:@1/row:@2", "row", 1],
      ["table:@1/row:@2/cell:@1", "cell", 2],
      ["para:@7", "paragraph", 3],
      ["table:@1/row:@2/cell:@2", "cell", 2],
      ["para:@8", "paragraph", 3],
      ["para:@9", "paragraph", 3],
      ["para:@10", "paragraph", 0],
      ["para:@11", "paragraph", 0],
      ["para:@12", "paragraph", 0],
    ]);
  });

  test("a paragraph with a paraId aliases its position, counted through the table", () => {
    const blocks = doc.blocks();
    expect(blocks[0]?.aliases).toEqual(["para:@1"]);
    expect(blocks[4]?.aliases).toEqual(["para:@4"]);
    expect(blocks[3]?.aliases).toBeUndefined();
    expect(doc.blocks("para:@12")[0]?.text).toBe("Closing");
    expect(doc.blocks("para:@7")[0]?.text).toBe("Support");
  });

  test("headings carry level and style label, list items their level", () => {
    const [title, heading, , item] = doc.blocks();
    expect(title).toMatchObject({ kind: "heading", label: "Title", meta: { level: 1 }, text: "Master Services Agreement" });
    expect(heading).toMatchObject({ kind: "heading", label: "heading 1", meta: { level: 1 } });
    expect(item).toMatchObject({ kind: "paragraph", meta: { list_level: 1 }, text: "First item" });
  });

  test("a table has its caption alias, dimensions, and cell text joined by newlines", () => {
    const table = doc.blocks("table:@1")[0];
    expect(table).toMatchObject({ aliases: ["table:Fees"], label: "Fees", meta: { rows: 2, columns: 2 }, text: "" });
    expect(doc.blocks("table:@1/row:@2/cell:@2")[0]?.text).toBe("$5|mo\nnet 30");
  });

  test("bookmarks follow their paragraph; names starting with an underscore are skipped", () => {
    const addresses = doc.blocks().map((b) => b.address);
    expect(addresses.indexOf("bookmark:Intro")).toBe(addresses.indexOf("para:@2") + 1);
    expect(addresses.some((a) => a.includes("_GoBack"))).toBe(false);
    expect(doc.blocks("bookmark:Intro")).toEqual([{ address: "bookmark:Intro", kind: "bookmark", depth: 0, text: "Introduction" }]);
  });

  test("paragraph text takes tabs and breaks and leaves tracked deletions out", () => {
    expect(doc.blocks("para:@4")[0]?.text).toBe("Pay\tin 30\ndays");
  });

  test("section:body is not a block but selects everything", () => {
    expect(doc.blocks().some((b) => b.address.startsWith("section:"))).toBe(false);
    expect(doc.blocks("section:body")).toEqual(doc.blocks());
    expect(doc.text("section:body")).toBe(doc.text());
  });
});

describe("openDocx views", () => {
  test("text is one line per paragraph and one tab-joined line per row", () => {
    expect(doc.text()).toBe(
      [
        "Master Services Agreement",
        "Introduction",
        "First item",
        "Pay\tin 30\ndays",
        "Item\tPrice",
        "Support\t$5|mo net 30",
        "Wrapped",
        "Closing",
      ].join("\n"),
    );
  });

  test("markdown has headings, indented list items and pipe tables, one blank line apart", () => {
    expect(doc.markdown()).toBe(
      [
        "# Master Services Agreement",
        "# Introduction",
        "  - First item",
        "Pay\tin 30\ndays",
        "| Item | Price |\n| --- | --- |\n| Support | $5\\|mo<br>net 30 |",
        "Wrapped",
        "Closing",
      ].join("\n\n"),
    );
  });

  test("units are the non-empty paragraphs, table paragraphs included", () => {
    expect(doc.units()).toEqual([
      { address: "para:#0A1B2C3D", text: "Master Services Agreement" },
      { address: "para:@2", text: "Introduction" },
      { address: "para:@3", text: "First item" },
      { address: "para:#5C7700D1", text: "Pay\tin 30\ndays" },
      { address: "para:@5", text: "Item" },
      { address: "para:@6", text: "Price" },
      { address: "para:@7", text: "Support" },
      { address: "para:@8", text: "$5|mo" },
      { address: "para:@9", text: "net 30" },
      { address: "para:@10", text: "Wrapped" },
      { address: "para:@12", text: "Closing" },
    ]);
  });

  test("a Word document has no cells view", () => {
    expect(() => doc.cells()).toThrow(ReadError);
    try {
      doc.cells();
    } catch (error) {
      expect((error as ReadError).code).toBe("unsupported-view");
    }
  });
});

describe("openDocx targets", () => {
  test("a paragraph is addressed by id (any case), position and alias", () => {
    for (const target of ["para:#5C7700D1", "para:#5c7700d1", "para:@4"]) {
      expect(doc.blocks(target).map((b) => b.address)).toEqual(["para:#5C7700D1"]);
    }
    expect(doc.text("para:@4")).toBe("Pay\tin 30\ndays");
    expect(doc.markdown("para:@3")).toBe("  - First item");
  });

  test("a table target returns the table, its rows, cells and their paragraphs", () => {
    const expected = doc.blocks().slice(5, 17).map((b) => b.address);
    expect(doc.blocks("table:@1").map((b) => b.address)).toEqual(expected);
    expect(doc.blocks("table:Fees").map((b) => b.address)).toEqual(expected);
    expect(doc.blocks("table:@1/row:@2").map((b) => b.address)).toEqual([
      "table:@1/row:@2",
      "table:@1/row:@2/cell:@1",
      "para:@7",
      "table:@1/row:@2/cell:@2",
      "para:@8",
      "para:@9",
    ]);
    expect(doc.blocks("table:Fees/row:@2/cell:@1").map((b) => b.address)).toEqual(["table:@1/row:@2/cell:@1", "para:@7"]);
  });

  test("views restrict to the target", () => {
    expect(doc.text("table:Fees")).toBe("Item\tPrice\nSupport\t$5|mo net 30");
    expect(doc.text("table:@1/row:@2")).toBe("Support\t$5|mo net 30");
    expect(doc.text("table:@1/row:@2/cell:@2")).toBe("$5|mo\nnet 30");
    expect(doc.text("para:@5")).toBe("Item");
    expect(doc.markdown("table:@1")).toBe("| Item | Price |\n| --- | --- |\n| Support | $5\\|mo<br>net 30 |");
    expect(doc.markdown("bookmark:Intro")).toBe("");
  });

  test("a paragraph is found by its text fingerprint, and .n picks the n-th duplicate under the same parent", () => {
    const fingerprint = (text: string): string => createHash("sha256").update(text.normalize("NFC").replace(/\s+/g, " ")).digest("hex").slice(0, 8);
    expect(doc.blocks(`para:~${fingerprint("Closing")}`).map((b) => b.address)).toEqual(["para:@12"]);
    expect(doc.blocks(`para:~${fingerprint("Wrapped").toUpperCase()}`).map((b) => b.address)).toEqual(["para:@10"]);

    const twins = openDocx(docx([para("Same  text"), para("other"), para("Same text")].join("")));
    const fp = fingerprint("Same text");
    expect(twins.blocks(`para:~${fp}`).map((b) => b.address)).toEqual(["para:@1"]);
    expect(twins.blocks(`para:~${fp}.1`).map((b) => b.address)).toEqual(["para:@1"]);
    expect(twins.blocks(`para:~${fp}.2`).map((b) => b.address)).toEqual(["para:@3"]);
    expect(() => twins.blocks(`para:~${fp}.3`)).toThrow(ReadError);
  });

  test("a target that names nothing, or is a grammar this reader does not read, is address-unresolved", () => {
    for (const target of ["para:@99", "para:#NOPE", "para:~00000000", "table:@1/row:@9", "table:Nope", "bookmark:Missing", "bookmark:_GoBack", "slide:#1", "para:@4/run:@1", "section:#1F00AA01"]) {
      let caught: unknown;
      try {
        doc.blocks(target);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReadError);
      expect((caught as ReadError).code).toBe("address-unresolved");
      expect((caught as ReadError).message).toBe(`${target} names nothing in this document`);
    }
    expect(() => doc.text("para:@99")).toThrow(ReadError);
    expect(() => doc.markdown("para:@99")).toThrow(ReadError);
  });
});

describe("openDocx edges", () => {
  test("a nested table counts as the next table and flattens into rows", () => {
    const nested = openDocx(
      docx(
        `<w:tbl>${row(cell(para("Outer"), `<w:tbl>${row(cell(para("Inner")))}</w:tbl>`))}</w:tbl>`,
      ),
    );
    expect(nested.blocks().map((b) => [b.address, b.depth])).toEqual([
      ["table:@1", 0],
      ["table:@1/row:@1", 1],
      ["table:@1/row:@1/cell:@1", 2],
      ["para:@1", 3],
      ["table:@2", 3],
      ["table:@2/row:@1", 4],
      ["table:@2/row:@1/cell:@1", 5],
      ["para:@2", 6],
    ]);
    expect(nested.text()).toBe("Outer\nInner");
    expect(nested.markdown()).toBe("| Outer |\n| --- |\n\n| Inner |\n| --- |");
    expect(nested.blocks("table:@2").length).toBe(4);
  });

  test("wrappers are read through: hyperlinks, insertions, smart tags, simple fields, no-break hyphens", () => {
    const wrapped = openDocx(
      docx(
        `<w:p><w:hyperlink w:anchor="x">${run("link")}</w:hyperlink><w:ins w:id="1" w:author="a">${run(" added")}</w:ins>` +
          `<w:smartTag w:uri="u" w:element="e">${run(" tag")}</w:smartTag><w:fldSimple w:instr="PAGE">${run(" 1")}</w:fldSimple>` +
          `<w:r><w:noBreakHyphen/><w:t>x</w:t></w:r><w:r><w:cr/><w:t>y</w:t></w:r></w:p>`,
      ),
    );
    expect(wrapped.blocks("para:@1")[0]?.text).toBe("link added tag 1-x\ny");
  });

  test("outline levels make headings, and numId 0 is not a list", () => {
    const outlined = openDocx(
      docx(
        [
          para("Deep", '<w:outlineLvl w:val="2"/>'),
          para("Plain", '<w:outlineLvl w:val="9"/>'),
          para("Not numbered", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>'),
          para("Numbered", '<w:numPr><w:numId w:val="1"/></w:numPr>'),
          para("Styled", '<w:pStyle w:val="Heading2"/>'),
        ].join(""),
        { styles: false },
      ),
    );
    const blocks = outlined.blocks();
    expect(blocks[0]).toMatchObject({ kind: "heading", meta: { level: 3 } });
    expect(blocks[1]).toMatchObject({ kind: "paragraph" });
    expect(blocks[2]?.meta).toBeUndefined();
    expect(blocks[3]?.meta).toEqual({ list_level: 0 });
    expect(blocks[4]).toMatchObject({ kind: "heading", label: "Heading2", meta: { level: 2 } });
    expect(outlined.markdown()).toBe(["### Deep", "Plain", "Not numbered", "- Numbered", "## Styled"].join("\n\n"));
  });

  test("the main part is found through the officeDocument relationship, with a fallback to word/document.xml", () => {
    const moved = writeZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: rels(`<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="/word/main.xml"/>`) },
      { name: "word/main.xml", data: documentXml(para("Moved")) },
    ]);
    expect(openDocx(moved).text()).toBe("Moved");
    const bare = writeZip([{ name: "word/document.xml", data: documentXml(para("Bare")) }]);
    expect(openDocx(bare).text()).toBe("Bare");
  });

  test("a bookmark carries at most the first 200 characters of its paragraph", () => {
    const long = "x".repeat(300);
    const bookmarked = openDocx(docx(`<w:p><w:bookmarkStart w:id="1" w:name="A/B"/>${run(long)}</w:p>`));
    expect(bookmarked.blocks("bookmark:A%2FB")[0]?.text).toBe("x".repeat(200));
    expect(bookmarked.blocks("para:@1")[0]?.text).toBe(long);
  });

  test("an empty body has no blocks and empty views", () => {
    const empty = openDocx(docx(""));
    expect(empty.blocks()).toEqual([]);
    expect(empty.text()).toBe("");
    expect(empty.markdown()).toBe("");
    expect(empty.units()).toEqual([]);
  });
});

describe("openDocx invalid input", () => {
  const invalid = (bytes: Uint8Array): void => {
    let caught: unknown;
    try {
      openDocx(bytes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadError);
    expect((caught as ReadError).code).toBe("invalid-input");
  };

  test("bytes that are not a zip", () => {
    invalid(new TextEncoder().encode("this is not a Word document"));
    invalid(new Uint8Array(0));
  });

  test("a zip without the main part", () => {
    invalid(writeZip([{ name: "[Content_Types].xml", data: CONTENT_TYPES }]));
  });

  test("a main part that is not well-formed XML or not a Word document", () => {
    invalid(writeZip([{ name: "word/document.xml", data: "<w:document><w:body></w:document>" }]));
    invalid(writeZip([{ name: "word/document.xml", data: `<w:worksheet xmlns:w="${W}"/>` }]));
  });
});
