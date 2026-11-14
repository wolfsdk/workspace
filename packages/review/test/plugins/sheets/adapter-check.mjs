#!/usr/bin/env bun
// Unit checks for the grid-metadata adapter (docs/engine-ops-xlsx.md, "Grid
// metadata in observe") against that doc's member lists and its
// merged-widths-frozen sample (B2 display "Merged hidden span", style 1 =
// center/center wrap rotation 45, solid fill #FFF2CC; merge B2:D4, hidden
// column C and row 3, frozen pane at E5), plus the older-module fallback
// and `host.reveal` address resolution, and the reactor kernel's
// `sheetViewport` mapping against real replies (`viewport-replies.json`:
// the engine module, windows A1:Z100 of merged-widths-frozen, Regions of
// names-tables and Model of model-finance; rows/columns at defaults left
// out).
//
//   bun test/plugins/sheets/adapter-test.mjs
import { deepStrictEqual } from "node:assert";
import {
  cellStyle,
  deriveSessionLayout,
  engineLayout,
  parseEngineGrid,
  parseEngineStyles,
  charsToPx,
  ptToPx,
  numberFits,
  numberX,
} from "../../../src/plugins/sheets/meta.ts";
import { hasEngineGrid, parseViewMeta } from "../../../src/plugins/sheets/reads.ts";
import { buildModel } from "../../../src/plugins/sheets/model.ts";
import { resolveAddress } from "../../../src/plugins/sheets/store.ts";
import { deriveSessionLinks, formulaLink, linkInputText, nodeLink, openableUrl, parseLinkInput } from "../../../src/plugins/sheets/links.ts";
import {
  clipFullLines,
  colVisibility,
  columnWidth,
  copySheet,
  deleteCells,
  fillOps,
  formatRect,
  recalculate,
  removeHyperlink,
  rowHeight,
  rowVisibility,
  setHyperlink,
} from "../../../src/plugins/sheets/ops.ts";
import { BAR_KEYS, dispatch, EDIT_KEYS, GRID_KEYS, matches, SHORTCUTS } from "../../../src/plugins/sheets/keys.ts";
import { MAX_COLS, MAX_ROWS } from "../../../src/plugins/sheets/refs.ts";
import { cellKey } from "../../../src/plugins/sheets/model.ts";
import { readFileSync } from "node:fs";
import {
  emptyBook,
  frozenOf,
  mergeReply,
  tileKey,
  tileOf,
  tilesFor,
  tileWindow,
  TILE_COLS,
  TILE_ROWS,
  viewportLayout,
  vpText,
} from "../../../src/plugins/sheets/viewport.ts";
import { sameValue } from "../../../src/plugins/sheets/store.ts";

let failed = 0;
let passed = 0;
function check(name, actual, expected) {
  try {
    deepStrictEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.log(`FAIL ${name}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

// A sheet grid with every member the doc lists.
const grid = {
  index: 0,
  state: "visible",
  used_range: "A1:F6",
  default_row_height: 15,
  default_col_width: null,
  base_col_width: 8,
  cols: [
    { min: 1, max: 1, width: 12.7109375, hidden: false },
    { min: 3, max: 3, width: 9.140625, hidden: true },
    { min: 5, max: 6, hidden: false, style: 2 },
  ],
  rows: [
    { row: 1, height: 30, hidden: false },
    { row: 3, hidden: true },
    { row: 6, hidden: false, style: 2 },
  ],
  merges: ["B2:D4"],
  pane: { state: "frozen", x_split: 4, y_split: 4, top_left_cell: "E5" },
  gridlines: true,
  tab_color: "#00FF00",
};
const workbook = {
  date1904: false,
  styles: [
    {
      number_format: "General",
      font: {
        name: "Calibri",
        size: 11,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        color: "#000000",
      },
      fill: null,
      borders: { left: null, right: null, top: null, bottom: null },
      alignment: { horizontal: "general", vertical: "bottom", wrap: false, indent: 0, rotation: 0 },
    },
    {
      number_format: "General",
      font: {
        name: "Calibri",
        size: 11,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        color: "#000000",
      },
      fill: { pattern: "solid", color: "#FFF2CC", background: null },
      borders: { left: null, right: null, top: null, bottom: null },
      alignment: { horizontal: "center", vertical: "center", wrap: true, indent: 0, rotation: 45 },
    },
    {
      number_format: "0.00%",
      font: {
        name: "Calibri",
        size: 11,
        bold: true,
        italic: true,
        underline: "single",
        strike: true,
        color: "#FF0000",
      },
      fill: { pattern: "none", color: null, background: null },
      borders: {
        left: null,
        right: null,
        top: { style: "thin", color: "#000000" },
        bottom: { style: "double", color: "#1F4E79" },
      },
      alignment: { horizontal: "right", vertical: "top", wrap: false, indent: 0, rotation: 0 },
    },
  ],
};

const g = parseEngineGrid(grid);
check("grid parsed", g !== null, true);
check(
  "col widths",
  [...g.colWidths],
  [
    [1, 12.7109375],
    [3, 9.140625],
  ],
);
check("hidden cols", [...g.hiddenCols], [3]);
check("hidden rows", [...g.hiddenRows], [3]);
check("row heights", [...g.rowHeights], [[1, 30]]);
check(
  "col styles",
  [...g.colStyles],
  [
    [5, 2],
    [6, 2],
  ],
);
check("row styles", [...g.rowStyles], [[6, 2]]);
check("merges", g.merges, [{ r1: 2, c1: 2, r2: 4, c2: 4 }]);
check("merges as objects", parseEngineGrid({ merges: [{ range: "B2:D4" }] }).merges, [{ r1: 2, c1: 2, r2: 4, c2: 4 }]);
check("frozen at E5", g.frozen, { rows: 4, cols: 4 });
check("frozen from top_left_cell only", parseEngineGrid({ pane: { state: "frozen", top_left_cell: "B3" } }).frozen, {
  rows: 2,
  cols: 1,
});
check(
  "split pane is not frozen",
  parseEngineGrid({ pane: { state: "split", x_split: 1200, y_split: 600 } }).frozen,
  null,
);
check("default col px from base 8", g.defaultColPx, 64);
check("default col px from width", parseEngineGrid({ default_col_width: 20 }).defaultColPx, charsToPx(20));
check("default row px", g.defaultRowPx, ptToPx(15));
check("tab color", g.tabColor, "#00FF00");
check("used range", g.usedRange, { r1: 1, c1: 1, r2: 6, c2: 6 });
check("gridlines off", parseEngineGrid({ gridlines: false }).gridlines, false);
check("absent grid", [parseEngineGrid(undefined), parseEngineGrid(null), parseEngineGrid(3)], [null, null, null]);

const styles = parseEngineStyles(workbook);
check("style 0 (defaults) draws nothing but names its font", styles[0], { font: "Calibri", valign: "bottom" });
check("style 1 (doc sample)", styles[1], {
  font: "Calibri",
  fill: "#FFF2CC",
  halign: "center",
  valign: "center",
  wrap: true,
});
check("style 2", styles[2], {
  bold: true,
  italic: true,
  underline: true,
  strike: true,
  font: "Calibri",
  color: "#FF0000",
  top: { style: "thin", color: "#000000" },
  bottom: { style: "double", color: "#1F4E79" },
  halign: "right",
  valign: "top",
});
check("no workbook", parseEngineStyles(undefined), null);

const layout = engineLayout(g);
check("cell style by index", cellStyle(1, layout, styles, 2, 2), styles[1]);
check("row style for empty cell", cellStyle(undefined, layout, styles, 6, 1).bold, true);
check("col style for empty cell", cellStyle(undefined, layout, styles, 2, 5).bold, true);
check("cell style wins over row/col", cellStyle(0, layout, styles, 6, 5).bold, undefined);
check("no style table", cellStyle(1, layout, null, 2, 2), {});
check("engine layout has no session rules", layout.rules, []);

// Older module: session replay, no engine members.
const history = [
  { ops: [{ op: "format", target: "sheet:#1/range:A1:B1", format: { column_width: 20, font: { bold: true } } }] },
  { ops: [{ op: "freeze", target: "sheet:#1", cell: "B3" }] },
  { ops: [{ op: "insert", anchor: "sheet:#1/col:A", position: "before", node: { kind: "col", count: 1 } }] },
];
const old = deriveSessionLayout(1, history, 3);
check(
  "replay widths shift with insert",
  [...old.colWidths],
  [
    [2, 20],
    [3, 20],
  ],
);
check("replay frozen", old.frozen, { rows: 2, cols: 1 });
check("replay rule styles", cellStyle(undefined, old, null, 1, 2).bold, true);
check("replay merges come from extract", old.merges, null);

// DocState.viewMeta (view-level members other than nodes/truncated).
const meta = parseViewMeta({ workbook, sheets: [{ id: "sheet:#1", label: "layout_stress", grid }] });
check("viewMeta styles", meta.styles?.[1], styles[1]);
check(
  "viewMeta grids",
  meta.grids.map((s) => [s.id, s.label, s.grid.frozen]),
  [["sheet:#1", "layout_stress", { rows: 4, cols: 4 }]],
);
check("viewMeta {} (older module)", parseViewMeta({}), { styles: null, grids: [] });
check("viewMeta without sheets", parseViewMeta({ workbook }).grids, []);

// Feature detection on DocState nodes.
const sheetNode = { id: "sheet:#1", kind: "sheet", parent: null, visible: true, label: "layout_stress" };
const cellNode = {
  id: "sheet:#1/cell:A1",
  kind: "cell",
  parent: "sheet:#1",
  visible: true,
  a1: "A1",
  value: { string: "R1C1" },
};
check("old module", hasEngineGrid([sheetNode, cellNode]), false);
check("grid on sheet", hasEngineGrid([{ ...sheetNode, grid }, cellNode]), true);
check("display on cell", hasEngineGrid([sheetNode, { ...cellNode, display: "R1C1", type: "string", style: 0 }]), true);
const oldMeta = {
  contract: "agent-api.v1.view",
  format: "xlsx",
  source_sha256: "f4a778a56b0edb331e85d3193b2938ab5030e441c960fa453cecbae23839e240",
};
check("old module viewMeta is not grid metadata", hasEngineGrid([sheetNode, cellNode], oldMeta), false);
check("old module viewMeta parses to nothing", parseViewMeta(oldMeta), { styles: null, grids: [] });
check("viewMeta workbook", hasEngineGrid([sheetNode, cellNode], { ...oldMeta, workbook }), true);
check("viewMeta sheets", hasEngineGrid([sheetNode, cellNode], { ...oldMeta, sheets: [] }), true);

// host.reveal address resolution.
const model = buildModel([
  sheetNode,
  cellNode,
  { id: "sheet:#2", kind: "sheet", parent: null, visible: true, label: "Regions" },
  { id: "table:Regions", kind: "table", parent: null, visible: true },
  {
    id: "table:Regions/row:North/col:Q3",
    kind: "cell",
    parent: "table:Regions",
    visible: true,
    a1: "C4",
    value: { number: 1 },
  },
]);
check("cell", resolveAddress(model, "sheet:#2/cell:C5"), { sheetId: 2, row: 5, col: 3 });
check("range", resolveAddress(model, "sheet:#1/range:B2:D4"), { sheetId: 1, row: 2, col: 2 });
check("by name", resolveAddress(model, "sheet:Regions/cell:A1"), { sheetId: 2, row: 1, col: 1 });
check("by position", resolveAddress(model, "sheet:@2"), { sheetId: 2, row: 0, col: 0 });
check("row", resolveAddress(model, "sheet:#1/row:@40"), { sheetId: 1, row: 40, col: 0 });
check("col", resolveAddress(model, "sheet:#1/col:AB"), { sheetId: 1, row: 0, col: 28 });
check("table cell", resolveAddress(model, "table:Regions/row:North/col:Q3"), { sheetId: 2, row: 4, col: 3 });
check("table", resolveAddress(model, "table:Regions"), { sheetId: 2, row: 4, col: 3 });
check("unknown", [resolveAddress(model, "sheet:#9/cell:A1"), resolveAddress(model, "slide:3")], [null, null]);
// Width/height changes: new module reports them at col:/row: addresses
// (kind col/row), the old one at the op's cell or a full-line range.
check("diff width at col:E", resolveAddress(model, "sheet:#1/col:E"), { sheetId: 1, row: 0, col: 5 });
check("diff height at row:@3", resolveAddress(model, "sheet:#1/row:@3"), { sheetId: 1, row: 3, col: 0 });
check("old diff width at range:E1:E1048576", resolveAddress(model, "sheet:#1/range:E1:E1048576"), {
  sheetId: 1,
  row: 1,
  col: 5,
});
check("old diff width at cell:E3", resolveAddress(model, "sheet:#1/cell:E3"), { sheetId: 1, row: 3, col: 5 });

// docs/engine-ops-xlsx.md "Grid metadata in observe": the doc's real
// sample, verbatim (the `...` elisions dropped).
const docGrid = JSON.parse(
  '{"index":0,"state":"visible","used_range":"A1:F6","default_row_height":15,"default_col_width":null,"base_col_width":8,"cols":[{"min":2,"max":2,"width":10,"hidden":false},{"min":3,"max":3,"hidden":true}],"rows":[{"row":2,"height":24,"hidden":false},{"row":3,"hidden":true}],"merges":["B2:D4"],"pane":{"state":"frozen","x_split":4,"y_split":4,"top_left_cell":"E5"},"gridlines":true,"tab_color":null}',
);
const dg = parseEngineGrid(docGrid);
check("doc sample: widths (chars)", [...dg.colWidths], [[2, 10]]);
check("doc sample: hidden col without width", [...dg.hiddenCols], [3]);
check("doc sample: heights (points)", [...dg.rowHeights], [[2, 24]]);
check("doc sample: hidden row without height", [...dg.hiddenRows], [3]);
check("doc sample: merges", dg.merges, [{ r1: 2, c1: 2, r2: 4, c2: 4 }]);
check("doc sample: frozen x/y split", dg.frozen, { rows: 4, cols: 4 });
check("doc sample: default col from base_col_width 8", dg.defaultColPx, 64);
check("doc sample: default row 15pt", dg.defaultRowPx, 20);
check("doc sample: tab_color null", dg.tabColor, undefined);
check("doc sample: gridlines", dg.gridlines, true);
check("doc sample: used range", dg.usedRange, { r1: 1, c1: 1, r2: 6, c2: 6 });
const docLayout = engineLayout(dg);
check(
  "doc sample: layout from engine",
  [docLayout.fromEngine, docLayout.merges.length, [...docLayout.hiddenCols]],
  [true, 1, [3]],
);

// Next-module op shapes (docs/engine-ops-xlsx.md examples).
check("op recalculate", recalculate(), { op: "recalculate", target: "workbook" });
check("op hyperlink set url", setHyperlink(2, 1, 1, { url: "https://example.com/a" }, "Open"), {
  op: "hyperlink",
  target: "sheet:#2/cell:A1",
  action: "set",
  url: "https://example.com/a",
  tooltip: "Open",
});
check("op hyperlink set location", setHyperlink(2, 1, 1, { location: "Data!A1" }), {
  op: "hyperlink",
  target: "sheet:#2/cell:A1",
  action: "set",
  location: "Data!A1",
});
check("op hyperlink remove", removeHyperlink(2, 1, 1), {
  op: "hyperlink",
  target: "sheet:#2/cell:A1",
  action: "remove",
});
check("op delete range", deleteCells(2, { r1: 1, c1: 1, r2: 2, c2: 2 }), {
  op: "delete",
  target: "sheet:#2/range:A1:B2",
});
check("op delete cell", deleteCells(2, { r1: 3, c1: 2, r2: 3, c2: 2 }), { op: "delete", target: "sheet:#2/cell:B3" });
check("op row hide", rowVisibility(2, 2, 3, "hidden"), [
  { op: "visibility", target: "sheet:#2/row:@2", state: "hidden" },
  { op: "visibility", target: "sheet:#2/row:@3", state: "hidden" },
]);
check("op col show", colVisibility(2, 2, 2, "visible"), [
  { op: "visibility", target: "sheet:#2/col:B", state: "visible" },
]);
check("op sheet copy", copySheet(1, "Regions copy"), {
  op: "insert",
  anchor: "sheet:#1",
  position: "after",
  node: { kind: "sheet", key: "Regions copy", from: "sheet:#1" },
});

// Links: input parsing, node member, formulas, session replay.
check("link input https", parseLinkInput("https://example.com/a"), { url: "https://example.com/a" });
check("link input bare host", parseLinkInput("example.com"), { url: "https://example.com" });
check("link input email", parseLinkInput("a@example.com"), { url: "mailto:a@example.com" });
check("link input location", parseLinkInput("Data!A1"), { location: "Data!A1" });
check("link input #location quoted", parseLinkInput("#'My Data'!$B$2"), { location: "'My Data'!$B$2" });
check("link input spaces", "error" in parseLinkInput("http://a b"), true);
check("link input empty", "error" in parseLinkInput("  "), true);
check(
  "openable",
  [
    openableUrl("https://x.y/"),
    openableUrl("mailto:a@b.c"),
    openableUrl("javascript:alert(1)"),
    openableUrl("file:///etc"),
    openableUrl("nope"),
  ],
  ["https://x.y/", "mailto:a@b.c", null, null, null],
);
check("node link", nodeLink({ url: "https://x.y", tooltip: "t" }), { url: "https://x.y", tooltip: "t" });
check("node link location as stored (no #)", nodeLink({ location: "Data!A1", tooltip: "go" }), {
  location: "Data!A1",
  tooltip: "go",
});
check("node link absent", [nodeLink(undefined), nodeLink({}), nodeLink({ tooltip: "t" })], [null, null, null]);
check("link input #name is a location", parseLinkInput("#Totals"), { location: "Totals" });
check("link input # alone", "error" in parseLinkInput("#"), true);
check(
  "link bar text",
  [
    linkInputText({ url: "https://a.b" }),
    linkInputText({ location: "Data!A1" }),
    linkInputText({ location: "'My Data'!B2" }),
    linkInputText({ location: "Totals" }),
    linkInputText(null),
  ],
  ["https://a.b", "Data!A1", "'My Data'!B2", "#Totals", ""],
);
check(
  "link bar text round-trips",
  ["Data!A1", "Totals", "'My Data'!B2"].map((location) => parseLinkInput(linkInputText({ location }))),
  [{ location: "Data!A1" }, { location: "Totals" }, { location: "'My Data'!B2" }],
);
check("formula link", formulaLink('=HYPERLINK("https://example.com","site")'), { url: "https://example.com" });
check("formula link internal", formulaLink('=hyperlink("#Data!A1")'), { location: "Data!A1" });
check("formula link computed", formulaLink("=HYPERLINK(A1)"), null);
const entry = (ops, extra = {}) => ({
  ops,
  diff: [],
  transaction: { ops: ops.map((_, index) => ({ index })) },
  ...extra,
});
const linkHistory = [
  entry([setHyperlink(2, 5, 1, { url: "https://a.example" }), setHyperlink(2, 6, 2, { location: "Data!A1" })]),
  entry([{ op: "insert", anchor: "sheet:#2/row:@1", position: "before", node: { kind: "row", count: 2 } }]),
  entry([{ op: "delete", target: "sheet:#2/col:A" }]),
  entry([deleteCells(2, { r1: 8, c1: 1, r2: 8, c2: 1 })]),
  entry([copySheet(2, "Copy")], { transaction: { ops: [{ index: 0, created: "sheet:#5" }] } }),
  entry([removeHyperlink(5, 8, 1)]),
];
const sessLinks = deriveSessionLinks(linkHistory, linkHistory.length);
check("session: A5 (now A7) dropped with column A", sessLinks.get(2).get(cellKey(7, 1)), undefined);
check("session: B6 -> A8 after +2 rows, -col A", sessLinks.get(2).get(cellKey(8, 1)), { location: "Data!A1" });
check("session: cell delete keeps link", sessLinks.get(2).size, 1);
check("session: copy carries links, then removed on the copy", sessLinks.get(5).size, 0);
check("session: revision bounds replay", deriveSessionLinks(linkHistory, 1).get(2).get(cellKey(5, 1)), {
  url: "https://a.example",
});
check(
  "session: resolved address wins",
  deriveSessionLinks(
    [
      entry([{ op: "hyperlink", target: "sheet:Data/cell:C3", action: "set", url: "https://r.example" }], {
        transaction: { ops: [{ index: 0, resolved: "sheet:#3/cell:C3" }] },
      }),
    ],
    1,
  )
    .get(3)
    .get(cellKey(3, 3)),
  { url: "https://r.example" },
);

// Formatting: the engine refuses sheet/col/row targets, so whole lines
// are clipped to the used area and sent as ranges.
const used = { r1: 1, c1: 1, r2: 40, c2: 6 };
check("format cell range", formatRect(1, { r1: 2, c1: 2, r2: 3, c2: 4 }, { font: { bold: true } }), {
  op: "format",
  target: "sheet:#1/range:B2:D3",
  format: { font: { bold: true } },
});
check(
  "format single cell",
  formatRect(1, { r1: 2, c1: 2, r2: 2, c2: 2 }, { font: { bold: true } }).target,
  "sheet:#1/cell:B2",
);
check("clip whole column", clipFullLines({ r1: 1, c1: 2, r2: MAX_ROWS, c2: 3 }, used), { r1: 1, c1: 2, r2: 40, c2: 3 });
check("clip whole row", clipFullLines({ r1: 3, c1: 1, r2: 4, c2: MAX_COLS }, used), { r1: 3, c1: 1, r2: 4, c2: 6 });
check("clip whole sheet", clipFullLines({ r1: 1, c1: 1, r2: MAX_ROWS, c2: MAX_COLS }, used), used);
check("clip column past used area", clipFullLines({ r1: 1, c1: 9, r2: MAX_ROWS, c2: 9 }, used), {
  r1: 1,
  c1: 9,
  r2: 40,
  c2: 9,
});
check(
  "clip empty sheet keeps first cell",
  clipFullLines({ r1: 1, c1: 1, r2: MAX_ROWS, c2: MAX_COLS }, { r1: 1, c1: 1, r2: 0, c2: 0 }),
  { r1: 1, c1: 1, r2: 1, c2: 1 },
);
check("clip leaves partial ranges", clipFullLines({ r1: 2, c1: 2, r2: MAX_ROWS, c2: 2 }, used), {
  r1: 2,
  c1: 2,
  r2: MAX_ROWS,
  c2: 2,
});
check(
  "format targets never col:/row:/sheet",
  [formatRect(1, clipFullLines({ r1: 1, c1: 1, r2: MAX_ROWS, c2: MAX_COLS }, used), {}).target],
  ["sheet:#1/range:A1:F40"],
);
check("width through a cell", columnWidth(1, 5, 5, 20).target, "sheet:#1/cell:E1");
check("height through a cell", rowHeight(1, 3, 3, 30).target, "sheet:#1/cell:A3");

// Reactor kernel: sheetViewport replies -> grid data.
const replies = JSON.parse(readFileSync(new URL("./viewport-replies.json", import.meta.url), "utf8"));
const mwBook = emptyBook("sha-a", 0);
const mw = mergeReply(mwBook, replies["merged-widths-frozen"], tileKey(0, 0));
check("vp: tile loaded", [...mw.tiles], [0]);
check(
  "vp: widths px (B 70, D 114, E 154; hidden C not a width)",
  [...mw.colPx],
  [
    [2, 70],
    [4, 114],
    [5, 154],
  ],
);
check(
  "vp: heights px (2: 24pt=32, 4: 30pt=40)",
  [...mw.rowPx],
  [
    [2, 32],
    [4, 40],
  ],
);
check("vp: hidden row 3 / col 3", [[...mw.hiddenRows], [...mw.hiddenCols]], [[3], [3]]);
check("vp: merge B2:D4", [...mw.merges.values()], [{ r1: 2, c1: 2, r2: 4, c2: 4 }]);
check("vp: frozen at E5", mw.frozen, { rows: 4, cols: 4 });
check("vp: defaults", [mw.defaultColPx, mw.defaultRowPx, mw.gridlines], [64, 20, true]);
check("vp: display of B2", vpText(mw.cells.get(cellKey(2, 2))), "Merged hidden span");
check("vp: style 1 (center/center wrap, fill #FFF2CC)", mwBook.styles.get(1), {
  font: "Calibri",
  fill: "#FFF2CC",
  halign: "center",
  valign: "center",
  wrap: true,
});
check("vp: used range", mwBook.used.get("layout_stress"), { r1: 1, c1: 1, r2: 6, c2: 6 });
const mwLayout = viewportLayout(mw, mwBook.used.get("layout_stress"));
check(
  "vp: layout",
  [mwLayout.fromEngine, mwLayout.merges, mwLayout.frozen, mwLayout.usedRange.r2, mwLayout.colPx.get(5)],
  [true, [{ r1: 2, c1: 2, r2: 4, c2: 4 }], { rows: 4, cols: 4 }, 6, 154],
);

const ntBook = emptyBook("sha-b", 0);
const nt = mergeReply(ntBook, replies["names-tables"], tileKey(0, 0));
check("vp: number format display B4", vpText(nt.cells.get(cellKey(4, 2))), "8,900");
check("vp: title style: bold 14pt", ntBook.styles.get(1), { bold: true, sizePt: 14, font: "Calibri" });
check("vp: right-aligned header", ntBook.styles.get(2).halign, "right");
check("vp: top border", ntBook.styles.get(4).top, { style: "thin", color: "#000000" });
check("vp: black font left to the theme", ntBook.styles.get(0), { font: "Calibri" });
check(
  "vp: every sheet's used range",
  [...ntBook.used],
  [
    ["Regions", { r1: 1, c1: 1, r2: 10, c2: 3 }],
    ["Summary", { r1: 1, c1: 1, r2: 7, c2: 2 }],
  ],
);
check("vp: widths A 182 B 84", [nt.colPx.get(1), nt.colPx.get(2)], [182, 84]);

const mfBook = emptyBook("sha-c", 0);
const mf = mergeReply(mfBook, replies["model-finance"], tileKey(0, 0));
check("vp: model-finance frozen B2", mf.frozen, { rows: 1, cols: 1 });
check("vp: model-finance B1 #,##0.00", vpText(mf.cells.get(cellKey(1, 2))), "2,026.00");
check(
  "vp: uncalculated formula shows empty",
  [vpText(mf.cells.get(cellKey(2, 2))), mf.cells.get(cellKey(2, 2)).formula],
  ["", "=Assumptions!B2*(1+Growth)"],
);
check("vp: header fill + white bold font", mfBook.styles.get(1), {
  bold: true,
  font: "Calibri",
  color: "#FFFFFF",
  fill: "#17365D",
});

// Two tiles of one sheet accumulate; a later reply replaces a row's state.
const twoBook = emptyBook("sha-d", 1);
mergeReply(twoBook, { ...replies["merged-widths-frozen"], cells: [], merged: ["B2:D4"] }, tileKey(0, 0));
const two = mergeReply(
  twoBook,
  {
    ...replies["merged-widths-frozen"],
    row0: 101,
    cells: [
      {
        a1: "A101",
        row: 101,
        col: 1,
        value: { number: 1.5 },
        formula: null,
        display: "1.50",
        display_trimmed: "##",
        color: "#FF0000",
        style_id: 0,
      },
    ],
    merged: ["A101:B102"],
    hidden_rows: [],
    hidden_cols: [],
    row_heights: [{ row: 3, height_pt: 15, height_px: 20, hidden: false, custom: false }],
    columns: [],
  },
  tileKey(1, 0),
);
check("vp: merges union, deduped", [...two.merges.keys()], ["B2:D4", "A101:B102"]);
check("vp: row 3 shown again by a later reply", two.hiddenRows.has(3), false);
check(
  "vp: numbers paint display (not the engine's display_trimmed), colour kept",
  [vpText(two.cells.get(cellKey(101, 1))), two.cells.get(cellKey(101, 1)).color],
  ["1.50", "#FF0000"],
);
check("vp: version counts merged tiles", two.version, 2);

// Tiles.
check("tile size", [TILE_ROWS, TILE_COLS], [100, 26]);
check(
  "tile of",
  [tileOf(1, 1), tileOf(100, 26), tileOf(101, 27), tileOf(5001, 11)],
  [0, 0, tileKey(1, 1), tileKey(50, 0)],
);
check("tile window", tileWindow(tileKey(2, 1)), { row0: 201, col0: 27, rows: 100, cols: 26 });
check("tile window clipped at the sheet edge", tileWindow(tileOf(1048576, 16384)), {
  row0: 1048501,
  col0: 16381,
  rows: 76,
  cols: 4,
});
check("tiles: top-left view + margin, nearest first", tilesFor({ r1: 1, c1: 1, r2: 30, c2: 10 }, null, null), [
  0,
  tileKey(0, 1),
  tileKey(1, 0),
  tileKey(1, 1),
]);
const deep = tilesFor({ r1: 2000, c1: 1, r2: 2030, c2: 10 }, { rows: 1, cols: 1 }, { r1: 1, c1: 1, r2: 5101, c2: 37 });
check("tiles: scrolled deep, nearest the view first", deep.slice(0, 3), [
  tileKey(20, 0),
  tileKey(19, 0),
  tileKey(20, 1),
]);
check("tiles: frozen rows tile included", deep.includes(tileKey(0, 0)) && deep.includes(tileKey(0, 1)), true);
check(
  "tiles: view rows 1801-2200 + frozen row 1, columns A-AZ: 10 tiles, not the sheet",
  [deep.length, Math.max(...deep.map((t) => Math.floor(t / 1024)))],
  [10, 21],
);
check(
  "tiles: past the used range only the first tile",
  tilesFor({ r1: 900, c1: 1, r2: 930, c2: 10 }, null, { r1: 1, c1: 1, r2: 110, c2: 30 }).every(
    (t) => tileWindow(t).row0 <= 110 || t === 0,
  ),
  true,
);
check(
  "frozen: split pane is not frozen",
  [frozenOf({ top_left_cell: "C3", mode: "split" }), frozenOf({ top_left_cell: "C3" }), frozenOf(null)],
  [null, { rows: 2, cols: 2 }, null],
);

// A previous revision's cell paints only while its value is the model's.
const vpCell = (value) => ({ display: "", color: null, style: null, value, formula: null });
check(
  "same value",
  [
    sameValue({ value: { number: 1 } }, vpCell({ number: 1 })),
    sameValue({ value: { number: 2 } }, vpCell({ number: 1 })),
    sameValue(undefined, null),
    sameValue({ value: { empty: true } }, null),
    sameValue(undefined, vpCell({ string: "x" })),
  ],
  [true, false, true, true, false],
);

// Number fit (model-finance, sheet Model, B1 from the real reply): bold
// Calibri 11pt (`style_id` 4) "2,026.00" in the default 64 px column.
// Excel shows it in full. The grid's font for it (bold 13px system-ui)
// measures 58.93 px in Chromium on macOS (Carlito Bold at 14.67px: 51.34
// px); the old rule reserved 2x4 px padding (56 px) and painted ###.
{
  const mf = replies["model-finance"];
  const b1 = mf.cells.find((c) => c.a1 === "B1");
  const bStyle = mf.styles[String(b1.style_id)].font;
  check(
    "fit: B1 reply",
    [b1.display, bStyle.bold, bStyle.size_pt, mf.default_col_width_px],
    ["2,026.00", true, 11, 64],
  );
  check("fit: 58.93 px number in a 64 px column fits", numberFits(58.93, mf.default_col_width_px), true);
  check("fit: wider than the full width -> ###", numberFits(64.5, 64), false);
  check(
    "fit: right-aligned keeps what padding fits",
    [
      numberX("right", 100, 64, 58.93, 4),
      numberX("right", 100, 64, 40, 4),
      numberX("left", 100, 64, 62, 4),
      numberX("center", 100, 64, 40, 4),
    ],
    [100 + 64 - 2.535 - 58.93, 100 + 64 - 4 - 40, 101, 112],
  );
}

// Fill handle batches.
const B2 = { r1: 2, c1: 2, r2: 3, c2: 3 };
check("fill: down by whole repeats", fillOps(1, B2, { ...B2, r2: 7 }), [
  { op: "copy", source: "sheet:#1/range:B2:C3", target: "sheet:#1/range:B4:C7", paste: "all" },
]);
check("fill: down with a partial repeat", fillOps(1, B2, { ...B2, r2: 6 }), [
  { op: "copy", source: "sheet:#1/range:B2:C3", target: "sheet:#1/range:B4:C5", paste: "all" },
  { op: "copy", source: "sheet:#1/range:B2:C2", target: "sheet:#1/range:B6:C6", paste: "all" },
]);
check("fill: one row less than a repeat", fillOps(1, B2, { ...B2, r2: 4 }), [
  { op: "copy", source: "sheet:#1/range:B2:C2", target: "sheet:#1/range:B4:C4", paste: "all" },
]);
check("fill: right from one cell", fillOps(2, { r1: 5, c1: 1, r2: 5, c2: 1 }, { r1: 5, c1: 1, r2: 5, c2: 4 }), [
  { op: "copy", source: "sheet:#2/cell:A5", target: "sheet:#2/range:B5:D5", paste: "all" },
]);
check(
  "fill: not down/right -> nothing",
  [fillOps(1, B2, B2), fillOps(1, B2, { ...B2, r1: 1 }), fillOps(1, B2, { ...B2, r2: 5, c2: 5 })],
  [[], [], []],
);

// Keyboard table.
const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
check(
  "keys: matches",
  [
    matches("Mod+Shift+z", ev("Z", { metaKey: true, shiftKey: true })),
    matches("Mod+z", ev("z", { ctrlKey: true })),
    matches("Mod+z", ev("z", { ctrlKey: true, shiftKey: true })),
    matches("Shift+ArrowUp", ev("ArrowUp")),
    matches("Alt+Enter", ev("Enter", { altKey: true })),
  ],
  [true, true, false, false, true],
);
{
  const calls = [];
  const fake = new Proxy(
    { clip: null, editing: { mode: "enter" }, isDisabled: (c) => c === "fill-down" },
    { get: (t, p) => (p in t ? t[p] : (...a) => calls.push([p, ...a])) },
  );
  const run = (table, e) => [dispatch(table, { store: fake, event: e }), calls.splice(0)];
  check("keys: Shift+ArrowDown extends", run(GRID_KEYS, ev("ArrowDown", { shiftKey: true })), [
    true,
    [["arrowKey", 1, 0, true, false]],
  ]);
  check(
    "keys: Mod+Shift+ArrowLeft extends to the data edge",
    run(GRID_KEYS, ev("ArrowLeft", { metaKey: true, shiftKey: true })),
    [true, [["arrowKey", 0, -1, true, true]]],
  );
  check(
    "keys: Delete and Backspace clear",
    [run(GRID_KEYS, ev("Delete")), run(GRID_KEYS, ev("Backspace"))],
    [
      [true, [["clearSelection"]]],
      [true, [["clearSelection"]]],
    ],
  );
  check("keys: Mod+A selects all", run(GRID_KEYS, ev("a", { ctrlKey: true })), [true, [["selectAll"]]]);
  check(
    "keys: Mod+C/X/V go to the clipboard events",
    [
      run(GRID_KEYS, ev("c", { metaKey: true }))[0],
      run(GRID_KEYS, ev("x", { metaKey: true }))[0],
      run(GRID_KEYS, ev("v", { metaKey: true }))[0],
    ],
    [false, false, false],
  );
  check("keys: a disabled fill-down lets Mod+D through", run(GRID_KEYS, ev("d", { metaKey: true })), [false, []]);
  check("keys: Escape without a copy marquee passes", run(GRID_KEYS, ev("Escape")), [false, []]);
  check("keys: editor Enter commits down", run(EDIT_KEYS, ev("Enter")), [true, [["commitEdit", { dr: 1, dc: 0 }]]]);
  check("keys: editor arrow in enter mode commits", run(EDIT_KEYS, ev("ArrowRight")), [
    true,
    [["commitEdit", { dr: 0, dc: 1 }]],
  ]);
  check(
    "keys: formula bar has no arrow/F2/Alt+Enter",
    [
      run(BAR_KEYS, ev("ArrowRight"))[0],
      run(BAR_KEYS, ev("F2"))[0],
      run(BAR_KEYS, ev("Enter", { altKey: true }))[0],
      run(BAR_KEYS, ev("Tab", { shiftKey: true })),
    ],
    [false, false, false, [true, [["commitEdit", { dr: 0, dc: -1 }]]]],
  );
}
const keyList = SHORTCUTS.map((s) => `${s.keys}${s.when ? ` (${s.when})` : ""}`);
check("shortcuts: no duplicate key in one mode", keyList.length, new Set(keyList).size);
check(
  "shortcuts: listed",
  [
    "Mod+c",
    "Mod+x",
    "Mod+v",
    "Delete",
    "Backspace",
    "Shift+ArrowUp",
    "Mod+a",
    "F2",
    "Enter",
    "Tab",
    "Shift+Tab",
    "Mod+z",
    "Mod+Shift+z",
  ].every((k) => SHORTCUTS.some((s) => s.keys === k)),
  true,
);
check(
  "shortcuts: shape",
  SHORTCUTS.every((s) => typeof s.label === "string" && s.group.startsWith("Sheets") && !("run" in s)),
  true,
);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
