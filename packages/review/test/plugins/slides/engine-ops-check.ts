/**
 * Adapter check against `docs/engine-ops-pptx.md` without the new module:
 * builds observe views shaped like the doc's examples, drives the plugin's
 * actions through a recording host and compares the ops it sends (and what
 * it reads back) with the documented shapes.
 *
 *   bun test/plugins/slides/engine-ops-check.ts
 */
import type { Address, ApplyResult, DocState, Op, ViewNode } from "@wolfsdk/protocol";
import type { EditorHost, EditorSnapshot } from "../../../src/host/index.ts";
import {
  duplicateShapes,
  formatState,
  pasteShapes,
  copyShapes,
  restackShapes,
  stepShapes,
  writeCellText,
  writeShapeText,
  insertPictureFile,
} from "../../../src/plugins/slides/actions.ts";
import { deckOf } from "../../../src/plugins/slides/model.ts";
import { insertPicture, runsEdit } from "../../../src/plugins/slides/ops.ts";
import { storeOf } from "../../../src/plugins/slides/store.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}\n     got      ${a}\n     expected ${e}`);
  }
}

type NodeSpec = Omit<ViewNode, "visible"> & { visible?: boolean };
function docState(specs: NodeSpec[], doc = "d1"): DocState {
  const nodes = specs.map((n) => ({ visible: true, ...n })) as ViewNode[];
  const childIds: Record<Address, Address[]> = {};
  for (const n of nodes) (childIds[n.parent ?? ""] ??= []).push(n.id);
  return {
    doc,
    name: "t.pptx",
    format: "pptx",
    revision: 0,
    revisionCount: 1,
    canUndo: false,
    canRedo: false,
    sha256: "0".repeat(64),
    nodes,
    childIds,
    viewMeta: {},
    pages: [{ page: 1, widthPx: 960, heightPx: 720, widthPt: 720, heightPt: 540, dpi: 96 }],
    regions: [],
  } as unknown as DocState;
}

/** Records `apply` calls; answers each with `respond(ops)`. */
function fakeHost(state: DocState, selection: Address[], respond: (ops: Op[]) => ApplyResult) {
  const calls: { ops: Op[]; label?: string }[] = [];
  let snap: EditorSnapshot = {
    state,
    selection,
    zoom: 1,
    currentPage: 1,
    busy: false,
    history: [],
    lastError: null,
    reveal: null,
  };
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const listeners = new Set<() => void>();
  const host = {
    getSnapshot: () => snap,
    node: (id: Address) => byId.get(id),
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    apply: async (ops: Op[], opts?: { label?: string }) => {
      calls.push({ ops, label: opts?.label });
      return respond(ops);
    },
    select: (sel: Address[]) => {
      snap = { ...snap, selection: sel };
    },
    setCurrentPage: () => {},
    reveal: () => {},
    reportError: () => {},
    undo: async () => {},
  } as unknown as EditorHost;
  return { host, calls, selection: () => snap.selection };
}

function ok(state: DocState, created: (Address | undefined)[]): ApplyResult {
  return {
    ok: true,
    state,
    diff: [],
    pageChanges: null,
    transaction: {
      base_sha256: "",
      result_sha256: "",
      committed: true,
      address_map: [],
      ops: created.map((c, index) => ({ index, op: "x", ...(c ? { created: c } : {}) })),
      diff: { changes: [], counts: {}, identity: "" },
    },
  } as ApplyResult;
}

const S = "slide:#256";
// tiny.pptx-like slide: shape #2 (formatted as in the doc's format example),
// #3 at x 822960 y 1371600, #4; group #5 with children #6 and #7; #8 on top.
const formatted = {
  fill: { kind: "solid", color: "#FF0000" },
  line: { kind: "solid", color: "#00FF00", width: 2 },
  alignment: { horizontal: "center", vertical: "center" },
  font: { bold: true, italic: true, underline: "single", size: 24, color: "#0000FF", name: "Arial" },
};
const g = (x: number, y: number, extra: object = {}) => ({ x, y, cx: 6858000, cy: 1097280, ...extra });
const nodes: NodeSpec[] = [
  { id: S, kind: "slide", parent: null },
  {
    id: `${S}/shape:#2`,
    kind: "shape",
    parent: S,
    label: "Title 1",
    text: "Hello",
    format: formatted,
    geometry: g(731520, 457200),
  },
  {
    id: `${S}/shape:#2/para:@1`,
    kind: "paragraph",
    parent: `${S}/shape:#2`,
    text: "Hello",
    format: { alignment: { horizontal: "center" } },
  },
  {
    id: `${S}/shape:#2/para:@1/run:@1`,
    kind: "run",
    parent: `${S}/shape:#2/para:@1`,
    text: "Hello",
    format: { font: formatted.font },
  },
  // Mixed runs, theme fill, inherited size.
  {
    id: `${S}/shape:#3`,
    kind: "shape",
    parent: S,
    label: "Body 2",
    text: "One\nTwo",
    format: { fill: { kind: "solid", color: "scheme:accent1" } },
    geometry: g(822960, 1371600),
  },
  { id: `${S}/shape:#3/para:@1`, kind: "paragraph", parent: `${S}/shape:#3`, text: "One" },
  {
    id: `${S}/shape:#3/para:@1/run:@1`,
    kind: "run",
    parent: `${S}/shape:#3/para:@1`,
    text: "One",
    format: { font: { bold: true } },
  },
  { id: `${S}/shape:#3/para:@2`, kind: "paragraph", parent: `${S}/shape:#3`, text: "Two" },
  { id: `${S}/shape:#3/para:@2/run:@1`, kind: "run", parent: `${S}/shape:#3/para:@2`, text: "Two" },
  // No fill textbox, two paragraphs with identical (empty) formatting.
  {
    id: `${S}/shape:#4`,
    kind: "shape",
    parent: S,
    label: "TextBox 3",
    text: "A\nB",
    format: { fill: { kind: "none" } },
    geometry: g(0, 0),
  },
  { id: `${S}/shape:#4/para:@1`, kind: "paragraph", parent: `${S}/shape:#4`, text: "A" },
  { id: `${S}/shape:#4/para:@1/run:@1`, kind: "run", parent: `${S}/shape:#4/para:@1`, text: "A" },
  { id: `${S}/shape:#4/para:@2`, kind: "paragraph", parent: `${S}/shape:#4`, text: "B" },
  { id: `${S}/shape:#4/para:@2/run:@1`, kind: "run", parent: `${S}/shape:#4/para:@2`, text: "B" },
  { id: `${S}/shape:#5`, kind: "shape", parent: S, label: "Group 4", geometry: g(100, 100) },
  {
    id: `${S}/shape:#6`,
    kind: "shape",
    parent: S,
    label: "Rect 5",
    text: "",
    geometry: g(100, 100, { group: `${S}/shape:#5` }),
  },
  {
    id: `${S}/shape:#7`,
    kind: "shape",
    parent: S,
    label: "Rect 6",
    text: "",
    geometry: g(200, 200, { group: `${S}/shape:#5` }),
  },
  // Table: cells with paragraph and run children.
  { id: `${S}/shape:#8`, kind: "shape", parent: S, label: "Table 7", geometry: g(0, 3000000) },
  { id: `${S}/shape:#8/col:@1`, kind: "col", parent: `${S}/shape:#8`, value: { number: 3000000 } },
  { id: `${S}/shape:#8/row:@1`, kind: "row", parent: `${S}/shape:#8`, value: { number: 370840 } },
  {
    id: `${S}/shape:#8/row:@1/cell:@1`,
    kind: "cell",
    parent: `${S}/shape:#8/row:@1`,
    text: "c",
    format: { fill: { kind: "solid", color: "#112233" }, font: { bold: true, color: "#FFFFFF", size: 14 } },
  },
  { id: `${S}/shape:#8/row:@1/cell:@1/para:@1`, kind: "paragraph", parent: `${S}/shape:#8/row:@1/cell:@1`, text: "c" },
  {
    id: `${S}/shape:#8/row:@1/cell:@1/para:@1/run:@1`,
    kind: "run",
    parent: `${S}/shape:#8/row:@1/cell:@1/para:@1`,
    text: "c",
    format: { font: { bold: true, color: "#FFFFFF", size: 14 } },
  },
];
const state = docState(nodes);
const id = (n: number) => `${S}/shape:#${n}`;

// Model: cell children do not leak into shapes or the table grid.
const deck = deckOf(state);
check("deck shapes (cell para/run children not counted)", [...deck.shapes.keys()], [2, 3, 4, 5, 6, 7, 8].map(id));
check(
  "table grid",
  deck.shapes.get(id(8))!.table!.cells.map((r) => r.map((c) => c?.id)),
  [[`${id(8)}/row:@1/cell:@1`]],
);
check(
  "groups",
  [6, 7, 2].map((n) => deck.shapes.get(id(n))!.group),
  [id(5), id(5), null],
);

// 3. Observe format.
{
  const { host } = fakeHost(state, [], () => ok(state, []));
  check("format: doc example shape", formatState(host, id(2)), {
    bold: true,
    italic: true,
    underline: true,
    name: "Arial",
    size: 24,
    color: { hex: "#0000FF" },
    fill: { kind: "solid", hex: "#FF0000" },
    line: { kind: "solid", hex: "#00FF00" },
    lineWidth: 2,
    horizontal: "center",
    vertical: "center",
  });
  check("format: theme fill, mixed bold, unset size", formatState(host, id(3)), {
    bold: "mixed",
    fill: { kind: "solid", theme: "scheme:accent1" },
  });
  check("format: no fill", formatState(host, id(4)), { fill: { kind: "none" } });
  check("format: table cell", formatState(host, `${id(8)}/row:@1/cell:@1`), {
    bold: true,
    size: 14,
    color: { hex: "#FFFFFF" },
    fill: { kind: "solid", hex: "#112233" },
  });
  // Module without observe format: session memory.
  const bare = docState(
    [
      { id: S, kind: "slide", parent: null },
      { id: id(2), kind: "shape", parent: S, text: "x" },
    ],
    "d2",
  );
  const b = fakeHost(bare, [id(2)], () => ok(bare, []));
  storeOf(b.host).set({ fontMemory: { [id(2)]: { bold: true } } });
  check("format: module without format falls back to session memory", formatState(b.host, id(2)), { bold: true });
}

// 1 + 2. Duplicate: copy with ABSOLUTE offset = source + 10 pt; select `created`.
{
  const f = fakeHost(state, [id(3)], () => ok(state, [id(9)]));
  await duplicateShapes(f.host);
  check("duplicate op", f.calls[0]!.ops, [
    {
      op: "copy",
      source: id(3),
      target: S,
      position: "last-child",
      offset: { x_emu: 822960 + 127000, y_emu: 1371600 + 127000 },
    },
  ]);
  check("duplicate selects created", f.selection(), [id(9)]);
}
// Cut + paste: copy without offset (lands on the source box), then delete.
{
  const f = fakeHost(state, [id(3)], () => ok(state, [id(9), undefined]));
  copyShapes(f.host, true);
  await pasteShapes(f.host);
  check("cut-paste ops", f.calls[0]!.ops, [
    { op: "copy", source: id(3), target: S, position: "last-child" },
    { op: "delete", target: id(3) },
  ]);
  check("cut-paste selects created", f.selection(), [id(9)]);
}
// Group copy: selection is the returned group address.
{
  const f = fakeHost(state, [id(5)], () => ok(state, [id(10)]));
  await duplicateShapes(f.host);
  check("group duplicate selects created group", f.selection(), [id(10)]);
}

// 4. Z-order.
async function zops(sel: number[], run: (h: EditorHost) => Promise<void>) {
  const f = fakeHost(state, sel.map(id), () => ok(state, []));
  await run(f.host);
  return f.calls.map((c) => c.ops);
}
// Top-level order: #2 #3 #4 #5 #8 (grouped #6 #7 skipped).
check("front (top level)", await zops([2], (h) => restackShapes(h, "front")), [
  [{ op: "move", target: id(2), anchor: S, position: "last-child" }],
]);
check("back (top level)", await zops([8], (h) => restackShapes(h, "back")), [
  [{ op: "move", target: id(8), anchor: S, position: "first-child" }],
]);
check("forward one (top level)", await zops([3], (h) => stepShapes(h, "forward")), [
  [{ op: "move", target: id(3), anchor: id(4), position: "after" }],
]);
check("backward one (top level)", await zops([4], (h) => stepShapes(h, "backward")), [
  [{ op: "move", target: id(4), anchor: id(3), position: "before" }],
]);
check("front keeps order of several", await zops([2, 3], (h) => restackShapes(h, "front")), [
  [
    { op: "move", target: id(2), anchor: S, position: "last-child" },
    { op: "move", target: id(3), anchor: S, position: "last-child" },
  ],
]);
// In group #5: #6 behind #7.
check("front (in group)", await zops([6], (h) => restackShapes(h, "front")), [
  [{ op: "move", target: id(6), anchor: id(7), position: "after" }],
]);
check("back (in group)", await zops([7], (h) => restackShapes(h, "back")), [
  [{ op: "move", target: id(7), anchor: id(6), position: "before" }],
]);
check("forward one (in group)", await zops([6], (h) => stepShapes(h, "forward")), [
  [{ op: "move", target: id(6), anchor: id(7), position: "after" }],
]);
check("already at front (in group)", await zops([7], (h) => restackShapes(h, "front")), []);

// Text: only what changed is written; runs keep their formatting.
{
  const write = async (target: Address, text: string, caret?: number, cell = false) => {
    const f = fakeHost(state, [], () => ok(state, []));
    await (cell ? writeCellText(f.host, target, text, caret) : writeShapeText(f.host, target, text, caret));
    return f.calls.map((c) => c.ops);
  };
  const R = (shape: number, p: number, r = 1) => `${id(shape)}/para:@${p}/run:@${r}`;
  check("edit in a run: run set", await write(id(4), "A\nC"), [[{ op: "set", target: R(4, 2), value: { text: "C" } }]]);
  check("edit in a run keeps other paragraphs", await write(id(3), "One\nThree"), [
    [{ op: "set", target: R(3, 2), value: { text: "Three" } }],
  ]);
  check("line break: paragraph set", await write(id(4), "A\nB\u000bx"), [
    [{ op: "set", target: `${id(4)}/para:@2`, value: { text: "B\u000bx" } }],
  ]);
  check("Enter: paragraph insert after", await write(id(4), "A\nB\nnew"), [
    [{ op: "insert", anchor: `${id(4)}/para:@2`, position: "after", node: { kind: "paragraph", text: "new" } }],
  ]);
  check("join: run set + paragraph delete", await write(id(4), "AB"), [
    [
      { op: "set", target: R(4, 1), value: { text: "AB" } },
      { op: "delete", target: `${id(4)}/para:@2` },
    ],
  ]);
  check("cell: run set", await write(`${id(8)}/row:@1/cell:@1`, "cd", 2, true), [
    [{ op: "set", target: `${id(8)}/row:@1/cell:@1/para:@1/run:@1`, value: { text: "cd" } }],
  ]);
}
// runsEdit: paragraph "Fast PPTX" = "Fast " + "PPTX".
{
  const runs = [
    { address: "r1", text: "Fast " },
    { address: "r2", text: "PPTX" },
  ];
  const set = (address: string, text: string) => ({ op: "set", target: address, value: { text } });
  check("runs: typing at a boundary continues the run before", runsEdit(runs, "Fast PPTX", "Fast xPPTX", 6), [
    set("r1", "Fast x"),
  ]);
  check("runs: typing at the start goes to the first run", runsEdit(runs, "Fast PPTX", "xFast PPTX", 1), [
    set("r1", "xFast "),
  ]);
  check("runs: inside the second run", runsEdit(runs, "Fast PPTX", "Fast PPxTX", 8), [set("r2", "PPxTX")]);
  check("runs: replacement across runs", runsEdit(runs, "Fast PPTX", "FaZTX", 3), [set("r1", "FaZ"), set("r2", "TX")]);
  check("runs: delete a whole run", runsEdit(runs, "Fast PPTX", "Fast ", 5), [set("r2", "")]);
  check("runs: line break is not a run edit", runsEdit(runs, "Fast PPTX", "Fast \u000bPPTX", 6), null);
  const broken = [
    { address: "r1", text: "Line one" },
    { address: "r2", text: "line two" },
  ];
  check(
    "runs: removing a break is not a run edit",
    runsEdit(broken, "Line one\u000bline two", "Line oneline two", 8),
    null,
  );
  check(
    "runs: after a break goes to the run after it",
    runsEdit(broken, "Line one\u000bline two", "Line one\u000bXline two", 10),
    [set("r2", "Xline two")],
  );
}

// 5. Exact members (unknown members are refused with `usage`).
const pic = insertPicture(
  S,
  { x: 914400, y: 2743200, cx: 1828800, cy: 914400 },
  { mediaType: "image/png", base64: "AA==", sha256: "ab", altText: "Logo" },
);
check("picture insert members", Object.keys(pic.node as object).sort(), [
  "alt_text",
  "data",
  "extent",
  "kind",
  "media_type",
  "offset",
  "sha256",
]);
{
  const f = fakeHost(state, [], () => ok(state, [id(9)]));
  globalThis.Image = class {
    src = "";
    naturalWidth = 0;
    naturalHeight = 0;
    decode() {
      return Promise.reject(new Error("no decoder"));
    }
  } as never;
  await insertPictureFile(f.host, new File([new Uint8Array([1])], "x.tiff", { type: "image/tiff" }));
  check("TIFF is not offered (engine takes png/jpeg/gif/bmp)", f.calls.length, 0);
  await insertPictureFile(f.host, new File([new Uint8Array([1])], "logo.png", { type: "image/png" }));
  check("picture insert selects created", f.selection(), [id(9)]);
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
