// Packages built in memory for the tests: a workbook, a Word document and a PowerPoint deck small enough to read
// whole, with the structures a pack binds (a table, a bookmark, a headline, a chart with its embedded workbook).
// Nothing here is a committed binary; every package is a zip made from the XML below.
import type { PackBinding, PackManifest, RoomOp } from "@wolfsdk/protocol/workspace";
import { PackError } from "../src/errors.ts";
import { sha256Hex } from "../src/hash.ts";
import { OoxmlPackage } from "../src/ooxml.ts";
import { buildZip, type ZipSource } from "../src/zip.ts";

export const sha256 = sha256Hex;
export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const rels = (...items: [id: string, type: string, target: string][]): string =>
  `${XML}<Relationships xmlns="${PKG_REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

const contentTypes = (...overrides: string[]): string =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`;

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A workbook ---------------------------------------------------------------------------------------------

/** Style indexes of the workbook fixture: the `cellXfs` it declares, by what each is formatted as. */
export const STYLE = { general: 0, currency: 1, percent: 2, date: 3, thousands: 4 } as const;

export type FixtureCell = number | string | boolean | null | { v: number | string | null; s?: number; f?: string };

const column = (index: number): string => String.fromCharCode(65 + index);

export type WorkbookOptions = {
  rows: FixtureCell[][];
  sheet?: string;
  date1904?: boolean;
  /** `name: formula`, such as `Revenue: "Fin!$B$2"`. */
  names?: Record<string, string>;
  table?: { name: string; ref: string };
};

export function xlsx(options: WorkbookOptions): Uint8Array {
  const sheet = options.sheet ?? "Fin";
  const strings: string[] = [];
  const stringIndex = (s: string): number => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const cell = (value: FixtureCell, r: number, c: number): string => {
    const ref = `${column(c)}${r + 1}`;
    const { v, s, f } = typeof value === "object" && value !== null ? value : { v: value, s: undefined, f: undefined };
    const style = s === undefined ? "" : ` s="${s}"`;
    const formula = f === undefined ? "" : `<f>${escape(f)}</f>`;
    if (v === null) return `<c r="${ref}"${style}/>`;
    if (typeof v === "string") return `<c r="${ref}"${style} t="s">${formula}<v>${stringIndex(v)}</v></c>`;
    if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${style}>${formula}<v>${v}</v></c>`;
  };
  const rows = options.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => cell(value, r, c)).join("")}</row>`).join("");
  const names = Object.entries(options.names ?? {});
  const files: ZipSource[] = [
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "_rels/.rels", data: rels(["rId1", "officeDocument", "xl/workbook.xml"]) },
    {
      name: "xl/workbook.xml",
      data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets>${
        names.length === 0 ? "" : `<definedNames>${names.map(([name, formula]) => `<definedName name="${name}">${escape(formula)}</definedName>`).join("")}</definedNames>`
      }</workbook>`,
    },
    { name: "xl/_rels/workbook.xml.rels", data: rels(["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "styles", "styles.xml"], ["rId3", "sharedStrings", "sharedStrings.xml"]) },
    {
      name: "xl/styles.xml",
      data: `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="3"/></cellXfs></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `${XML}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${rows}</sheetData>${options.table === undefined ? "" : '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'}</worksheet>`,
    },
  ];
  if (options.table !== undefined) {
    files.push(
      { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels(["rId1", "table", "../tables/table1.xml"]) },
      { name: "xl/tables/table1.xml", data: `${XML}<table xmlns="${MAIN}" id="1" name="${options.table.name}" displayName="${options.table.name}" ref="${options.table.ref}"/>` },
    );
  }
  // The shared strings are written last: building the rows above is what fills them.
  files.push({ name: "xl/sharedStrings.xml", data: `${XML}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`).join("")}</sst>` });
  return buildZip(files);
}

/** The quarterly figures every pack test reads: a header row, then one row per quarter. */
export const QUARTERS: FixtureCell[][] = [
  ["Quarter", "Revenue", "Margin"],
  ["Q1", { v: 1234567.891, s: STYLE.currency }, { v: 0.1234, s: STYLE.percent }],
  ["Q2", { v: 2345678.5, s: STYLE.currency }, { v: 0.2, s: STYLE.percent }],
  ["Q3", { v: 987654.321, s: STYLE.currency }, { v: 0.05, s: STYLE.percent }],
];

// A Word document ----------------------------------------------------------------------------------------

export type DocxOptions = {
  /** The text of the bookmarked run of the first paragraph. */
  bookmark?: string;
  /** Rows of the captioned table; the first is a header. */
  table?: string[][];
  caption?: string;
  /** Page and column widths in twips, so a narrow cell makes a line that cannot hold much. */
  pageWidth?: number;
  columnWidth?: number;
  /** Font size in half points of the table text. */
  halfPoints?: number;
};

const wp = (text: string, halfPoints?: number): string =>
  `<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr>${halfPoints === undefined ? "" : `<w:sz w:val="${halfPoints}"/>`}<w:b/></w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`;

export function docx(options: DocxOptions = {}): Uint8Array {
  const table = options.table ?? [
    ["Quarter", "Revenue"],
    ["old", "old"],
  ];
  const width = options.columnWidth ?? 3000;
  const grid = (table[0] ?? []).map(() => `<w:gridCol w:w="${width}"/>`).join("");
  const rows = table
    .map((row) => `<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>${row.map((text) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${wp(text, options.halfPoints)}</w:tc>`).join("")}</w:tr>`)
    .join("");
  const body =
    `<w:p><w:r><w:t xml:space="preserve">Revenue was </w:t></w:r><w:bookmarkStart w:id="1" w:name="Headline"/><w:r><w:rPr><w:i/></w:rPr><w:t>${escape(options.bookmark ?? "old")}</w:t></w:r><w:bookmarkEnd w:id="1"/><w:r><w:t>.</w:t></w:r></w:p>` +
    `<w:tbl><w:tblPr><w:tblCaption w:val="${options.caption ?? "Revenue"}"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
    `<w:p><w:r><w:t>Untouched closing paragraph.</w:t></w:r></w:p>` +
    `<w:sectPr><w:pgSz w:w="${options.pageWidth ?? 12240}" w:h="15840"/><w:pgMar w:left="1440" w:right="1440" w:top="1440" w:bottom="1440"/></w:sectPr>`;
  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "_rels/.rels", data: rels(["rId1", "officeDocument", "word/document.xml"]) },
    { name: "word/document.xml", data: `${XML}<w:document xmlns:w="${WORD}"><w:body>${body}</w:body></w:document>` },
    { name: "docProps/core.xml", data: `${XML}<coreProperties/>` },
  ]);
}

// A PowerPoint deck --------------------------------------------------------------------------------------

export type PptxOptions = {
  headline?: string;
  /** Font size of the headline in hundredths of a point. */
  headlineSize?: number;
  /** Width of the headline box in points. */
  headlineWidthPt?: number;
  headlineHeightPt?: number;
  table?: string[][];
  /** The values the chart's first series holds, in its cache and in its embedded workbook. */
  series?: number[];
  /** Leave the embedded workbook's series cells as formulas. */
  workbookFormulas?: boolean;
};

const EMU = 12700;

export function pptx(options: PptxOptions = {}): Uint8Array {
  const table = options.table ?? [
    ["Quarter", "Revenue"],
    ["old", "old"],
  ];
  const series = options.series ?? [1, 2, 3];
  const cells = (row: string[]): string =>
    row.map((text) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>${escape(text)}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`).join("");
  const tableXml = `<a:tbl><a:tblPr/><a:tblGrid>${(table[0] ?? []).map(() => '<a:gridCol w="2000000"/>').join("")}</a:tblGrid>${table.map((row) => `<a:tr h="370840">${cells(row)}</a:tr>`).join("")}</a:tbl>`;
  const slide =
    `${XML}<p:sld xmlns:a="${DRAWING}" xmlns:r="${REL}" xmlns:p="${PRESENTATION}"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round((options.headlineWidthPt ?? 480) * EMU)}" cy="${Math.round((options.headlineHeightPt ?? 72) * EMU)}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${options.headlineSize ?? 3200}" b="1"/><a:t>${escape(options.headline ?? "old")}</a:t></a:r><a:endParaRPr lang="en-US" sz="${options.headlineSize ?? 3200}"/></a:p></p:txBody></p:sp>` +
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="1000000"/><a:ext cx="4000000" cy="741680"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tableXml}</a:graphicData></a:graphic></p:graphicFrame>` +
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="3000000"/><a:ext cx="4000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="${CHART}"><c:chart xmlns:c="${CHART}" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>` +
    `</p:spTree></p:cSld></p:sld>`;
  const points = series.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
  const chart =
    `${XML}<c:chartSpace xmlns:c="${CHART}" xmlns:a="${DRAWING}" xmlns:r="${REL}"><c:chart><c:plotArea><c:barChart>` +
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${series.length + 1}</c:f><c:strCache><c:ptCount val="${series.length}"/>${series.map((_, i) => `<c:pt idx="${i}"><c:v>Q${i + 1}</c:v></c:pt>`).join("")}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$${series.length + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${series.length}"/>${points}</c:numCache></c:numRef></c:val></c:ser>` +
    `</c:barChart></c:plotArea></c:chart><c:externalData r:id="rId1"/></c:chartSpace>`;
  const embedded = xlsx({
    sheet: "Sheet1",
    rows: [["", "Sales"], ...series.map((v, i): FixtureCell[] => [`Q${i + 1}`, options.workbookFormulas ? { v, f: `${v}+0` } : v])],
  });
  return buildZip([
    { name: "[Content_Types].xml", data: contentTypes() },
    { name: "_rels/.rels", data: rels(["rId1", "officeDocument", "ppt/presentation.xml"]) },
    { name: "ppt/presentation.xml", data: `${XML}<p:presentation xmlns:p="${PRESENTATION}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", data: rels(["rId1", "slide", "slides/slide1.xml"]) },
    { name: "ppt/slides/slide1.xml", data: slide },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: rels(["rId2", "chart", "../charts/chart1.xml"]) },
    { name: "ppt/charts/chart1.xml", data: chart },
    { name: "ppt/charts/_rels/chart1.xml.rels", data: rels(["rId1", "package", "../embeddings/Microsoft_Excel_Sheet1.xlsx"]) },
    { name: "ppt/embeddings/Microsoft_Excel_Sheet1.xlsx", data: embedded },
  ]);
}

// A pack -------------------------------------------------------------------------------------------------

export const DETERMINISM = { clock: "2026-01-02T03:04:05Z", seed: 7, timezone: "UTC", locale: "en-US" } as const;

export function binding(partial: Partial<PackBinding> & Pick<PackBinding, "id" | "target_kind" | "target_address" | "selector">): PackBinding {
  const format = partial.target_kind.startsWith("docx") ? "docx" : "pptx";
  return { source_id: "fin", target_doc: `deck.${format}`, target_format: format, number_format: null, fit_policy: "none", ...partial };
}

export function manifest(bindings: PackBinding[], source: Partial<PackManifest["sources"][number]> = {}): PackManifest {
  return {
    contract: "wolfsdk.pack.v1",
    pack_id: "quarterly",
    name: "Quarterly pack",
    sources: [{ id: "fin", kind: "xlsx", doc_name: "fin.xlsx", determinism: { ...DETERMINISM }, ...source }],
    bindings,
  };
}

export const manifestBytes = (value: PackManifest): Uint8Array => bytesOf(JSON.stringify(value, null, 2));

/** The code of the `PackError` `run` throws; `undefined` when it throws nothing, or something else. */
export async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (e) {
    return e instanceof PackError ? e.code : undefined;
  }
  return undefined;
}

/** The text of a part of a package. */
export function partText(bytes: Uint8Array, part: string): string {
  const text = new OoxmlPackage(bytes).text(part);
  if (text === undefined) throw new Error(`the package has no part ${part}`);
  return text;
}

/** The bytes of a part of a package, `undefined` when it has none. */
export const partBytes = (bytes: Uint8Array, part: string): Uint8Array | undefined => new OoxmlPackage(bytes).bytes(part);

/** The package with the text of `part` passed through `edit`. */
export function withPart(bytes: Uint8Array, part: string, edit: (text: string) => string): Uint8Array {
  const pkg = new OoxmlPackage(bytes);
  pkg.setText(part, edit(partText(bytes, part)));
  return pkg.save();
}

/** The names of the parts of a package whose bytes differ between `before` and `after`, or that only one has. */
export function changedParts(before: Uint8Array, after: Uint8Array): string[] {
  const a = new OoxmlPackage(before);
  const b = new OoxmlPackage(after);
  const names = new Set([...a.archive.entries, ...b.archive.entries].map((e) => e.name));
  return [...names].filter((name) => sha256(a.bytes(name) ?? new Uint8Array()) !== sha256(b.bytes(name) ?? new Uint8Array())).sort();
}

/** The text a `set` op writes. */
export function textOfSet(op: RoomOp | undefined): string {
  const value = op?.value;
  if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "string") return value.text;
  throw new Error(`not a set of text: ${JSON.stringify(op)}`);
}
