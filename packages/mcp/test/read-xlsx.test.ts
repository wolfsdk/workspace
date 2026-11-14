import { describe, expect, test } from "bun:test";
import { ReadError } from "../src/read/model.ts";
import { openXlsx } from "../src/read/xlsx.ts";
import { writeZip } from "../src/read/zip.ts";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS = `xmlns="${MAIN}" xmlns:r="${REL}"`;
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const contentTypes = (extra = ""): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${extra}</Types>`;

const rels = (items: ReadonlyArray<[id: string, type: string, target: string]>): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const ROOT_RELS = rels([["rId1", "officeDocument", "xl/workbook.xml"]]);

/** Two worksheets (the second hidden), a chartsheet and a sheet whose part is missing, a table, shared strings
 * with rich text, and workbook and sheet scoped defined names. */
function fixture(): Uint8Array {
  const workbook =
    `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets>` +
    `<sheet name="Data" sheetId="1" r:id="rId1"/>` +
    `<sheet name="Archive" sheetId="2" state="hidden" r:id="rId2"/>` +
    `<sheet name="Chart" sheetId="3" r:id="rId3"/>` +
    `<sheet name="Ghost" sheetId="4" r:id="rId4"/>` +
    `</sheets><definedNames>` +
    `<definedName name="TaxRate">Data!$B$1</definedName>` +
    `<definedName name="Local" localSheetId="1">Archive!$A$1:$A$3</definedName>` +
    `</definedNames></workbook>`;
  const sst =
    `<sst ${NS} count="3" uniqueCount="3">` +
    `<si><r><t xml:space="preserve">Hello </t></r><r><rPr><b/></rPr><t>World</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si>` +
    `<si><t>Item</t></si><si><t>Pipe|Value</t></si></sst>`;
  const data =
    `<worksheet ${NS}><dimension ref="A1:D6"/><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>0.2</v></c><c r="C1" t="b"><v>1</v></c><c r="E1" s="1"/></row>` +
    `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="inlineStr"><is><t>inline</t></is></c>` +
    `<c r="D2" t="e"><v>#DIV/0!</v></c></row>` +
    `<row r="3"><c r="A3"><v>5</v></c><c r="C3"><f>SUM(A3:B3)</f><v>5</v></c></row>` +
    `<row r="5"><c r="A5" t="str"><f>"a""b"&amp;A1</f><v>x</v></c></row>` +
    `<row><c t="inlineStr"><is><t>no ref</t></is></c><c><v>7</v></c></row>` +
    `</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;
  const archive =
    `<worksheet ${NS}><sheetData>` +
    `<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>Next</t></is></c>` +
    `<c r="D1"><f t="shared" ref="D1:D2" si="1">$A$1+A1+LEN("A1")</f><v>4</v></c></row>` +
    `<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A1+1</f><v>2</v></c>` +
    `<c r="D2"><f t="shared" si="1"/><v>5</v></c></row>` +
    `<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>3</v></c></row>` +
    `</sheetData></worksheet>`;
  const table =
    `<table ${NS} id="1" name="Items" displayName="Items" ref="A2:C3"><tableColumns count="3">` +
    `<tableColumn id="1" name="Item"/><tableColumn id="2" name="Pipe|Value"/><tableColumn id="3" name="inline"/>` +
    `</tableColumns></table>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: workbook },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "worksheet", "worksheets/sheet2.xml"],
        ["rId3", "chartsheet", "chartsheets/sheet1.xml"],
        ["rId4", "worksheet", "worksheets/missing.xml"],
        ["rId5", "sharedStrings", "sharedStrings.xml"],
      ]),
    },
    { name: "xl/sharedStrings.xml", data: sst },
    { name: "xl/worksheets/sheet1.xml", data: data },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels([["rId1", "table", "../tables/table1.xml"]]) },
    { name: "xl/worksheets/sheet2.xml", data: archive },
    { name: "xl/chartsheets/sheet1.xml", data: `<chartsheet ${NS}/>` },
    { name: "xl/tables/table1.xml", data: table },
  ]);
}

/** A one-sheet workbook around `sheetData` rows. */
function single(rows: string, sheetName = "Sheet1"): Uint8Array {
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]) },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>` },
  ]);
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ReadError ? error.code : `other:${String(error)}`;
  }
  return "none";
};

describe("xlsx reader: structure", () => {
  const doc = openXlsx(fixture());

  test("lists sheets with their rows, then tables, then names", () => {
    const blocks = doc.blocks();
    expect(blocks.map((b) => b.address)).toEqual([
      "sheet:#1",
      "sheet:#1/row:@1",
      "sheet:#1/row:@2",
      "sheet:#1/row:@3",
      "sheet:#1/row:@5",
      "sheet:#1/row:@6",
      "sheet:#2",
      "sheet:#2/row:@1",
      "sheet:#2/row:@2",
      "sheet:#2/row:@3",
      "table:Items",
      "name:TaxRate",
      "sheet:#2/name:Local",
    ]);
    expect(blocks.map((b) => [b.kind, b.depth])).toEqual([
      ["sheet", 0],
      ["row", 1],
      ["row", 1],
      ["row", 1],
      ["row", 1],
      ["row", 1],
      ["sheet", 0],
      ["row", 1],
      ["row", 1],
      ["row", 1],
      ["table", 0],
      ["name", 0],
      ["name", 0],
    ]);
  });

  test("sheet blocks carry aliases, label and metadata; the chartsheet and the missing part are skipped", () => {
    const blocks = doc.blocks();
    const data = blocks[0];
    const archive = blocks[6];
    expect(data).toEqual({
      address: "sheet:#1",
      aliases: ["sheet:Data", "sheet:@1"],
      kind: "sheet",
      depth: 0,
      text: "",
      label: "Data",
      meta: { sheet_id: 1, dimension: "A1:D6", rows: 5, cells: 12, hidden: false },
    });
    expect(archive?.aliases).toEqual(["sheet:Archive", "sheet:@2"]);
    expect(archive?.meta).toEqual({ sheet_id: 2, dimension: "A1:D3", rows: 3, cells: 8, hidden: true });
    expect(doc.blocks().filter((b) => b.kind === "sheet")).toHaveLength(2);
  });

  test("row blocks hold the row values joined by a tab, gaps kept", () => {
    const rows = doc.blocks("sheet:#1").filter((b) => b.kind === "row");
    expect(rows.map((b) => b.text)).toEqual(["Hello World\t0.2\tTRUE", "Item\tPipe|Value\tinline\t#DIV/0!", "5\t\t5", "x", "no ref\t7"]);
    expect(rows[0]?.meta).toEqual({ cells: 3 });
  });

  test("table and defined name blocks", () => {
    expect(doc.blocks("table:Items")).toEqual([
      {
        address: "table:Items",
        kind: "table",
        depth: 0,
        text: "",
        label: "Items",
        meta: { sheet: "Data", ref: "A2:C3", columns: "Item, Pipe|Value, inline" },
      },
    ]);
    expect(doc.blocks("name:taxrate")).toEqual([
      { address: "name:TaxRate", kind: "name", depth: 0, text: "Data!$B$1", label: "TaxRate", meta: { sheet: null, hidden: false } },
    ]);
    expect(doc.blocks("sheet:#2/name:Local")[0]?.text).toBe("Archive!$A$1:$A$3");
  });
});

describe("xlsx reader: targets", () => {
  const doc = openXlsx(fixture());

  test("a sheet is addressed by id, name (exact, then any case) and position, and brings the names scoped to it", () => {
    const expected = ["sheet:#2", "sheet:#2/row:@1", "sheet:#2/row:@2", "sheet:#2/row:@3", "sheet:#2/name:Local"];
    for (const target of ["sheet:#2", "sheet:Archive", "sheet:archive", "sheet:@2"]) {
      expect(doc.blocks(target).map((b) => b.address)).toEqual(expected);
    }
  });

  test("a cell, range, row or column target returns the row blocks it touches", () => {
    expect(doc.blocks("sheet:Archive/cell:B3").map((b) => b.address)).toEqual(["sheet:#2/row:@3"]);
    expect(doc.blocks("sheet:#2/range:$B$2:$D$3").map((b) => b.address)).toEqual(["sheet:#2/row:@2", "sheet:#2/row:@3"]);
    expect(doc.blocks("sheet:#2/col:D").map((b) => b.address)).toEqual(["sheet:#2/row:@1", "sheet:#2/row:@2"]);
    expect(doc.blocks("sheet:#2/row:@3").map((b) => b.text)).toEqual(["3\t3"]);
    expect(doc.blocks("sheet:#2/range:C1:C3")).toEqual([]);
    expect(doc.blocks("table:Items/col:Item").map((b) => b.address)).toEqual(["sheet:#1/row:@3"]);
    expect(doc.blocks("table:Items/row:@1").map((b) => b.address)).toEqual(["sheet:#1/row:@3"]);
  });

  test("cells returns the stored cells inside the rectangle in row-major order", () => {
    expect(doc.cells("sheet:#2/range:$B$2:$D$3").map((c) => c.ref)).toEqual(["B2", "D2", "B3"]);
    expect(doc.cells("sheet:#2/range:D3:B2").map((c) => c.ref)).toEqual(["B2", "D2", "B3"]);
    expect(doc.cells("sheet:#2/col:D").map((c) => c.ref)).toEqual(["D1", "D2"]);
    expect(doc.cells("sheet:archive/row:@1").map((c) => c.ref)).toEqual(["A1", "B1", "D1"]);
    expect(doc.cells("sheet:#2/cell:C2")).toEqual([]);
    expect(doc.cells("table:Items").map((c) => c.address)).toEqual([
      "sheet:#1/cell:A2",
      "sheet:#1/cell:B2",
      "sheet:#1/cell:C2",
      "sheet:#1/cell:A3",
      "sheet:#1/cell:C3",
    ]);
    expect(doc.cells("table:Items/col:Pipe|Value")).toEqual([]);
    expect(doc.cells("table:Items/row:@1/col:inline").map((c) => c.ref)).toEqual(["C3"]);
    expect(doc.cells("name:TaxRate").map((c) => c.ref)).toEqual(["B1"]);
    expect(doc.cells("sheet:archive/name:local").map((c) => c.ref)).toEqual(["A1", "A2", "A3"]);
  });

  test("a table row is found by the key in its first column", () => {
    expect(doc.cells("table:Items/row:5").map((c) => c.ref)).toEqual(["A3", "C3"]);
    expect(codeOf(() => doc.cells("table:Items/row:nothing"))).toBe("address-unresolved");
  });

  test("an address that names nothing, or is not read, is address-unresolved", () => {
    for (const target of [
      "sheet:Nope",
      "sheet:#9",
      "sheet:@3",
      "sheet:#1/cell:ZZZZ1",
      "sheet:#1/cell:A1:B2",
      "sheet:#1/range:A1",
      "sheet:#1/row:3",
      "sheet:#1/col:1",
      "sheet:#1/name:Nope",
      "sheet:#1/chart:@1",
      "sheet:#1/cell:A1/extra",
      "sheet:Data/row:~1a2b3c4d",
      "table:Nope",
      "table:Items/col:Missing",
      "name:Local",
      "para:@1",
      "slide:#256",
      "page:2",
      "nonsense",
    ]) {
      expect(codeOf(() => doc.blocks(target))).toBe("address-unresolved");
      expect(codeOf(() => doc.text(target))).toBe("address-unresolved");
      expect(codeOf(() => doc.cells(target))).toBe("address-unresolved");
    }
    expect(() => doc.blocks("sheet:Nope")).toThrow("sheet:Nope names nothing in this document");
  });
});

describe("xlsx reader: cells", () => {
  const doc = openXlsx(fixture());
  const at = (target: string) => doc.cells(target)[0];

  test("a shared formula follower reads the master formula shifted to its own position", () => {
    expect(doc.cells("sheet:#2/cell:B3")).toEqual([
      { sheet: "Archive", sheet_id: 2, ref: "B3", address: "sheet:#2/cell:B3", value: 3, formula: "=A2+1", type: "number" },
    ]);
    expect(at("sheet:#2/cell:B2")?.formula).toBe("=A1+1");
    expect(at("sheet:#2/cell:D1")?.formula).toBe('=$A$1+A1+LEN("A1")');
    expect(at("sheet:#2/cell:D2")?.formula).toBe('=$A$1+A2+LEN("A1")');
  });

  test("values and types follow the cell type attribute", () => {
    const byRef = new Map(doc.cells("sheet:Data").map((c) => [c.ref, c]));
    expect(byRef.get("A1")).toMatchObject({ value: "Hello World", type: "string" });
    expect(byRef.get("B1")).toMatchObject({ value: 0.2, type: "number" });
    expect(byRef.get("C1")).toMatchObject({ value: true, type: "boolean" });
    expect(byRef.get("C2")).toMatchObject({ value: "inline", type: "string" });
    expect(byRef.get("D2")).toMatchObject({ value: "#DIV/0!", type: "error" });
    expect(byRef.get("C3")).toMatchObject({ value: 5, type: "number", formula: "=SUM(A3:B3)" });
    expect(byRef.get("A5")).toMatchObject({ value: "x", type: "string", formula: '="a""b"&A1' });
    expect(byRef.get("A6")).toMatchObject({ value: "no ref", address: "sheet:#1/cell:A6" });
    expect(byRef.get("B6")).toMatchObject({ value: 7, address: "sheet:#1/cell:B6" });
    expect(byRef.has("E1")).toBe(false);
    expect(doc.cells()).toHaveLength(20);
  });
});

describe("xlsx reader: views", () => {
  const doc = openXlsx(fixture());

  test("text is a heading and the used rows per sheet, hidden sheets included", () => {
    expect(doc.text()).toBe(
      [
        "# Data",
        "Hello World\t0.2\tTRUE",
        "Item\tPipe|Value\tinline\t#DIV/0!",
        "5\t\t5",
        "x",
        "no ref\t7",
        "# Archive",
        "1\tNext\t\t4",
        "2\t2\t\t5",
        "3\t3",
      ].join("\n"),
    );
    expect(doc.text("sheet:@2")).toBe("# Archive\n1\tNext\t\t4\n2\t2\t\t5\n3\t3");
    expect(doc.text("sheet:#1/range:A2:B3")).toBe("# Data\nItem\tPipe|Value\n5");
    expect(doc.text("table:items")).toBe("# Data\nItem\tPipe|Value\tinline\n5\t\t5");
    expect(doc.text("name:TaxRate")).toBe("# Data\n0.2");
  });

  test("markdown is a pipe table per sheet with the first used row as the header", () => {
    expect(doc.markdown()).toBe(
      [
        "## Data",
        "",
        "| Hello World | 0.2 | TRUE |  |",
        "| --- | --- | --- | --- |",
        "| Item | Pipe\\|Value | inline | #DIV/0! |",
        "| 5 |  | 5 |  |",
        "| x |  |  |  |",
        "| no ref | 7 |  |  |",
        "",
        "## Archive",
        "",
        "| 1 | Next |  | 4 |",
        "| --- | --- | --- | --- |",
        "| 2 | 2 |  | 5 |",
        "| 3 | 3 |  |  |",
      ].join("\n"),
    );
    expect(doc.markdown("sheet:#2/range:A2:B3")).toBe("## Archive\n\n| 2 | 2 |\n| --- | --- |\n| 3 | 3 |");
    expect(doc.markdown("sheet:#2/range:C1:C3")).toBe("## Archive");
  });

  test("units are the non-empty cells, a formula cell with its formula after two spaces", () => {
    const units = doc.units();
    expect(units).toHaveLength(20);
    expect(units[0]).toEqual({ address: "sheet:#1/cell:A1", text: "Hello World" });
    expect(units).toContainEqual({ address: "sheet:#1/cell:C3", text: "5  =SUM(A3:B3)" });
    expect(units).toContainEqual({ address: "sheet:#2/cell:B3", text: "3  =A2+1" });
    expect(units).toContainEqual({ address: "sheet:#1/cell:C1", text: "TRUE" });
    expect(units).toContainEqual({ address: "sheet:#1/cell:D2", text: "#DIV/0!" });
  });
});

describe("xlsx reader: edges", () => {
  test("shared formulas shift plain A1 references only", () => {
    const rows =
      `<row r="1"><c r="C1"><f t="shared" ref="C1:D3" si="0">SUM($A1:B$2)+'My Sheet'!C3+"A1"+Tbl[[#This Row],[Col]]+COUNT(A:B)+SUM(1:2)+LOG10(A1)+Q1!A1</f><v>0</v></c>` +
      `<c r="D1"><f t="shared" si="0"/><v>0</v></c></row>` +
      `<row r="2"><c r="D2"><f t="shared" si="0"/><v>0</v></c></row>` +
      `<row r="3"><c r="C3"><f t="shared" si="0"/><v>0</v></c></row>`;
    const doc = openXlsx(single(rows));
    const formula = (ref: string) => doc.cells(`sheet:#1/cell:${ref}`)[0]?.formula;
    expect(formula("C1")).toBe(`=SUM($A1:B$2)+'My Sheet'!C3+"A1"+Tbl[[#This Row],[Col]]+COUNT(A:B)+SUM(1:2)+LOG10(A1)+Q1!A1`);
    expect(formula("D1")).toBe(`=SUM($A1:C$2)+'My Sheet'!D3+"A1"+Tbl[[#This Row],[Col]]+COUNT(B:C)+SUM(1:2)+LOG10(B1)+Q1!B1`);
    expect(formula("D2")).toBe(`=SUM($A2:C$2)+'My Sheet'!D4+"A1"+Tbl[[#This Row],[Col]]+COUNT(B:C)+SUM(2:3)+LOG10(B2)+Q1!B2`);
    expect(formula("C3")).toBe(`=SUM($A3:B$2)+'My Sheet'!C5+"A1"+Tbl[[#This Row],[Col]]+COUNT(A:B)+SUM(3:4)+LOG10(A3)+Q1!A3`);
  });

  test("a follower whose shift would leave the grid reports the master formula unshifted", () => {
    const rows = `<row r="10"><c r="XFC10"><f t="shared" ref="XFC10:XFD10" si="1">XFD1</f><v>1</v></c><c r="XFD10"><f t="shared" si="1"/><v>1</v></c></row>`;
    const doc = openXlsx(single(rows));
    expect(doc.cells("sheet:#1/cell:XFD10")[0]?.formula).toBe("=XFD1");
  });

  test("a sheet name is escaped in its alias and unescaped in a target", () => {
    const doc = openXlsx(single(`<row r="1"><c r="A1"><v>1</v></c></row>`, "#Tag/1"));
    expect(doc.blocks()[0]?.aliases).toEqual(["sheet:%23Tag%2F1", "sheet:@1"]);
    expect(doc.blocks("sheet:%23Tag%2F1")).toHaveLength(2);
    expect(doc.blocks("sheet:#1")).toHaveLength(2);
    expect(codeOf(() => doc.blocks("sheet:#Tag/1"))).toBe("address-unresolved");
  });

  test("cells out of order are sorted, a tab or line break in a value stays on its line, units keep the raw value", () => {
    const rows =
      `<row r="5"><c r="A5" t="inlineStr"><is><t>a&#9;b&#10;c</t></is></c></row>` + `<row r="7"><c r="B7"><v>2</v></c><c r="A7"><v>1</v></c></row>`;
    const doc = openXlsx(single(rows));
    expect(doc.text()).toBe("# Sheet1\na b c\n1\t2");
    expect(doc.cells().map((c) => c.ref)).toEqual(["A5", "A7", "B7"]);
    expect(doc.units()[0]?.text).toBe("a\tb\nc");
  });

  test("a workbook with no cells has a sheet with no dimension", () => {
    const doc = openXlsx(single(""));
    expect(doc.blocks()).toEqual([
      {
        address: "sheet:#1",
        aliases: ["sheet:Sheet1", "sheet:@1"],
        kind: "sheet",
        depth: 0,
        text: "",
        label: "Sheet1",
        meta: { sheet_id: 1, dimension: null, rows: 0, cells: 0, hidden: false },
      },
    ]);
    expect(doc.text()).toBe("# Sheet1");
    expect(doc.markdown()).toBe("## Sheet1");
    expect(doc.units()).toEqual([]);
  });

  test("the workbook part is found through the package relationships and falls back to xl/workbook.xml", () => {
    const sheet = `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>3</v></c></row></sheetData></worksheet>`;
    const workbook = `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const moved = writeZip([
      { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "/book/main.xml"]]) },
      { name: "book/main.xml", data: workbook },
      { name: "book/_rels/main.xml.rels", data: rels([["rId1", "worksheet", "sheets/s.xml"]]) },
      { name: "book/sheets/s.xml", data: sheet },
    ]);
    expect(openXlsx(moved).text()).toBe("# S\n3");
    const bare = writeZip([
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/_rels/workbook.xml.rels", data: rels([["rId1", "worksheet", "worksheets/s.xml"]]) },
      { name: "xl/worksheets/s.xml", data: sheet },
    ]);
    expect(openXlsx(bare).text()).toBe("# S\n3");
  });
});

describe("xlsx reader: invalid input", () => {
  test("bytes that are not a zip", () => {
    expect(codeOf(() => openXlsx(new TextEncoder().encode("this is not a zip archive at all")))).toBe("invalid-input");
    expect(codeOf(() => openXlsx(new Uint8Array(0)))).toBe("invalid-input");
  });

  test("a zip without the workbook part", () => {
    expect(codeOf(() => openXlsx(writeZip([{ name: "docProps/core.xml", data: "<x/>" }])))).toBe("invalid-input");
  });

  test("a workbook part that is not well formed or is not a workbook", () => {
    const withWorkbook = (data: string): Uint8Array => writeZip([{ name: "xl/workbook.xml", data }]);
    expect(codeOf(() => openXlsx(withWorkbook("<workbook><sheets>")))).toBe("invalid-input");
    expect(codeOf(() => openXlsx(withWorkbook("<document/>")))).toBe("invalid-input");
  });

  test("a worksheet part that is not well formed", () => {
    const bad = writeZip([
      { name: "xl/workbook.xml", data: `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: rels([["rId1", "worksheet", "worksheets/s.xml"]]) },
      { name: "xl/worksheets/s.xml", data: "<worksheet><sheetData><row></worksheet>" },
    ]);
    expect(codeOf(() => openXlsx(bad))).toBe("invalid-input");
  });
});
