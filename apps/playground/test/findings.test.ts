import { expect, test } from "bun:test";
import type { LabDoc, ViewNode } from "../src/lab/index.ts";
import { findingsFromView } from "../src/lab/findings.ts";
import { wolfOpsFor } from "../src/lab/ops.ts";

const node = (id: string, extra: Partial<ViewNode> = {}): ViewNode => ({
  id,
  kind: "paragraph",
  parent: null,
  visible: true,
  ...extra,
});

const docx = (nodes: ViewNode[], regions: { object_id: string; page: number; bbox_pt: [number, number, number, number] }[] = []) =>
  findingsFromView({
    format: "docx",
    nodes,
    regions: regions.map((r) => ({ ...r, bbox_px: r.bbox_pt, kind: "text" }) as never),
  });

test("an empty view yields no findings", () => {
  expect(findingsFromView({ format: "xlsx", nodes: [], regions: [] })).toEqual([]);
});

test("every hidden node the engine gives a reason for becomes a finding; one without a reason does not", () => {
  const out = docx([
    node("p:1", { visible: false, hidden_reason: "vanish", text: "secret" }),
    node("p:2", { visible: false, hidden_reason: "zero-size", text: "tiny" }),
    node("p:3", { visible: false, text: "no reason" }),
  ]);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ id: "observe:hidden:p:1", kind: "hidden", reason: "vanish", text: "secret", chars: 6, source: "observe" });
  expect(out[0]!.page).toBeUndefined();
  expect(out[1]).toMatchObject({ id: "observe:hidden:p:2", reason: "zero-size" });
});

test("ids and order are deterministic and follow document order", () => {
  const nodes = [
    node("p:1", { visible: false, hidden_reason: "vanish", text: "a" }),
    node("c:1", { kind: "comment", channel: "comments", text: "note" }),
    node("p:9", { alt_text: "chart of sales" }),
  ];
  const first = docx(nodes);
  expect(first.map((f) => f.id)).toEqual(["observe:hidden:p:1", "observe:comment:c:1", "observe:alt-text:p:9"]);
  expect(docx(nodes)).toEqual(first);
  expect(docx([...nodes].reverse()).map((f) => f.id)).toEqual(["observe:alt-text:p:9", "observe:comment:c:1", "observe:hidden:p:1"]);
});

test("location comes only from the flagged node's own region, and containers are marked", () => {
  const out = docx(
    [
      node("p:1", { visible: false, hidden_reason: "vanish", text: "a" }),
      node("r:1", { parent: "p:1", visible: true, kind: "run" }),
      node("p:2", { visible: false, hidden_reason: "vanish", text: "b" }),
    ],
    [{ object_id: "p:1", page: 2, bbox_pt: [1, 2, 3, 4] }],
  );
  expect(out[0]).toMatchObject({ page: 2, bboxPt: [1, 2, 3, 4], granularity: "container" });
  expect(out[1]!.page).toBeUndefined();
  expect(out[1]!.granularity).toBeUndefined();
});

const fakeDoc = (format: LabDoc["format"], nodes: ViewNode[] = []) => ({ format, nodes }) as LabDoc;

test("wolfOpsFor builds addresses the engine resolves", () => {
  expect(wolfOpsFor({ kind: "set-cell", sheet: "Model", a1: "b2", value: 5 }, fakeDoc("xlsx"))).toEqual([
    { op: "set", target: "sheet:Model/cell:B2", value: { number: 5 } },
  ]);
  expect(wolfOpsFor({ kind: "set-cell", sheet: "Model", a1: "B2", value: "x" }, fakeDoc("xlsx"))).toEqual([
    { op: "set", target: "sheet:Model/cell:B2", value: { string: "x" } },
  ]);
  expect(() => wolfOpsFor({ kind: "set-cell", sheet: "M", a1: "A1", value: 1 }, fakeDoc("docx"))).toThrow();
  expect(wolfOpsFor({ kind: "replace-text", find: "a", replace: "b" }, fakeDoc("docx"))[0]).toMatchObject({ op: "replace-text" });
  const deck = fakeDoc("pptx", [node("slide:#1/shape:#2", { kind: "shape", text: "hello world" })]);
  expect(wolfOpsFor({ kind: "replace-text", find: "hello", replace: "bye" }, deck)).toEqual([
    { op: "replace-text", target: "slide:#1/shape:#2", find: "hello", replace: "bye" },
  ]);
  expect(() => wolfOpsFor({ kind: "replace-text", find: "", replace: "b" }, deck)).toThrow();
});
