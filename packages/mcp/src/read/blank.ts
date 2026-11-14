// The smallest valid package of each format `doc_create` makes: what an agent starts from when it names no
// template. A Word document holds one empty paragraph (so `para:@1` is an anchor), a workbook one empty sheet
// `Sheet1`, a presentation one blank slide on the blank layout. The bytes are deterministic: the same call
// returns the same bytes, so the head of a new document has the same sha256 everywhere.
import { writeZip } from "./zip.ts";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument";

const contentTypes = (overrides: ReadonlyArray<readonly [string, string]>): string =>
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("") +
  "</Types>";

const relationships = (items: ReadonlyArray<readonly [string, string, string]>): string =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("") +
  "</Relationships>";

function docx(): Uint8Array {
  const style = (id: string, name: string, extra = "", basedOn = "Normal"): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/><w:qFormat/>${extra}</w:style>`;
  const heading = (n: number, size: number): string =>
    style(`Heading${n}`, `heading ${n}`, `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr>`);
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes([["word/document.xml", `${CT}.wordprocessingml.document.main+xml`], ["word/styles.xml", `${CT}.wordprocessingml.styles+xml`]]) },
    { name: "_rels/.rels", data: relationships([["rId1", "officeDocument", "word/document.xml"]]) },
    { name: "word/_rels/document.xml.rels", data: relationships([["rId1", "styles", "styles.xml"]]) },
    {
      name: "word/document.xml",
      data:
        `${XML}<w:document xmlns:w="${NS_W}"><w:body><w:p/>` +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
        "</w:body></w:document>",
    },
    {
      name: "word/styles.xml",
      data:
        `${XML}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
        '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        style("Title", "Title", '<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="56"/></w:rPr>') +
        heading(1, 32) +
        heading(2, 26) +
        heading(3, 24) +
        "</w:styles>",
    },
  ]);
}

function xlsx(): Uint8Array {
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes([["xl/workbook.xml", `${CT}.spreadsheetml.sheet.main+xml`], ["xl/worksheets/sheet1.xml", `${CT}.spreadsheetml.worksheet+xml`], ["xl/styles.xml", `${CT}.spreadsheetml.styles+xml`]]) },
    { name: "_rels/.rels", data: relationships([["rId1", "officeDocument", "xl/workbook.xml"]]) },
    { name: "xl/_rels/workbook.xml.rels", data: relationships([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "styles", "styles.xml"]]) },
    { name: "xl/workbook.xml", data: `${XML}<workbook xmlns="${NS_S}" xmlns:r="${NS_R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/worksheets/sheet1.xml", data: `${XML}<worksheet xmlns="${NS_S}"><sheetData/></worksheet>` },
    {
      name: "xl/styles.xml",
      data:
        `${XML}<styleSheet xmlns="${NS_S}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    },
  ]);
}

const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function pptx(): Uint8Array {
  const accent = (n: number, rgb: string): string => `<a:accent${n}><a:srgbClr val="${rgb}"/></a:accent${n}>`;
  const line = '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const theme =
    `${XML}<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements>` +
    '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    accent(1, "4472C4") + accent(2, "ED7D31") + accent(3, "A5A5A5") + accent(4, "FFC000") + accent(5, "5B9BD5") + accent(6, "70AD47") +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>` +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["ppt/presentation.xml", `${CT}.presentationml.presentation.main+xml`],
        ["ppt/slideMasters/slideMaster1.xml", `${CT}.presentationml.slideMaster+xml`],
        ["ppt/slideLayouts/slideLayout1.xml", `${CT}.presentationml.slideLayout+xml`],
        ["ppt/slides/slide1.xml", `${CT}.presentationml.slide+xml`],
        ["ppt/theme/theme1.xml", `${CT}.theme+xml`],
      ]),
    },
    { name: "_rels/.rels", data: relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
    {
      name: "ppt/presentation.xml",
      data:
        `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    },
    { name: "ppt/_rels/presentation.xml.rels", data: relationships([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId2", "slide", "slides/slide1.xml"], ["rId3", "theme", "theme/theme1.xml"]]) },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data:
        `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]) },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      data:
        `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
    },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]) },
    {
      name: "ppt/slides/slide1.xml",
      data:
        `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
        "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
    },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: relationships([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]) },
    { name: "ppt/theme/theme1.xml", data: theme },
  ]);
}

/** The blank package of `format`. */
export function blankDocument(format: "docx" | "xlsx" | "pptx"): Uint8Array {
  switch (format) {
    case "docx":
      return docx();
    case "xlsx":
      return xlsx();
    case "pptx":
      return pptx();
  }
}
