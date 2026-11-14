import { describe, expect, test } from "bun:test";
import { hunksOf, type Change, type Decision, type HistoryEntry, type SheetViewport } from "@wolfsdk/protocol";
import replies from "../plugins/sheets/viewport-replies.json";
import {
  COL_CAP,
  COL_STEP,
  DEFAULT_SHEET_VIEW,
  ROW_CAP,
  ROW_STEP,
  VIEW_LABELS,
  alignOf,
  cellAddress,
  cellAt,
  cellBoxes,
  cellKey,
  cellRect,
  changedCells,
  colToNum,
  layoutOf,
  mergeDecision,
  numToCol,
  parseCellAddress,
  revealOffset,
  sheetMarks,
  sheetTabs,
  usedExtent,
  windowFor,
  type ReviewReads,
} from "../../src/review/sheetReview.ts";

/** The engine's recorded reply for a 6x6 sheet with a merge B2:D4, hidden column C and hidden row 3. */
const merged = replies["merged-widths-frozen"] as unknown as SheetViewport;

const change = (address: string, cause: number | undefined, kind = "cell"): Change =>
  ({ address, change: "modified", kind, parts: [], ...(cause === undefined ? {} : { cause }) }) as Change;

/** A history entry of `ops` ops whose changes are `changes` (each names the op that caused it). */
function entry(revision: number, ops: number, changes: Change[]): HistoryEntry {
  return {
    revision,
    label: `change ${revision}`,
    source: "test",
    ops: Array.from({ length: ops }, () => ({})) as unknown as HistoryEntry["ops"],
    diff: changes,
    transaction: {
      base_sha256: `b${revision}`,
      result_sha256: `r${revision}`,
      committed: true,
      address_map: [],
      ops: [],
      diff: { changes, counts: {}, identity: `i${revision}` },
    },
    baseSha256: `b${revision}`,
    resultSha256: `r${revision}`,
    appliedAt: 0,
  } as unknown as HistoryEntry;
}

/** Review reads over `history`, deciding each hunk by `decisions["revision:op"]` (undecided otherwise). */
function reads(history: HistoryEntry[], decisions: Record<string, Decision> = {}): ReviewReads {
  return {
    history: () => history,
    hunks: (e) => hunksOf(e),
    hunkDecisionOf: (e, op) => decisions[`${e.revision}:${op}`] ?? "pending",
  };
}

describe("cell addresses", () => {
  test("columns convert both ways", () => {
    expect(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"].map(colToNum)).toEqual([1, 26, 27, 52, 53, 702, 703]);
    expect([1, 26, 27, 52, 53, 702, 703].map(numToCol)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });

  test("a cell node address parses and rebuilds", () => {
    expect(parseCellAddress("sheet:#2/cell:AB17")).toEqual({ sheetId: 2, a1: "AB17", row: 17, col: 28 });
    expect(cellAddress(2, "AB17")).toBe("sheet:#2/cell:AB17");
    expect(cellKey(2, "AB17")).toBe("2!AB17");
  });

  test("anything but a cell node is not a cell", () => {
    for (const address of ["sheet:#2", "sheet:#2/row:3", "sheet:#2/cell:B", "slide:#1/shape:#2", "", "sheet:#2/cell:B2/run:#1"]) {
      expect(parseCellAddress(address)).toBeNull();
    }
  });
});

describe("changed cells", () => {
  test("a rejected hunk shows over an undecided one, that over an approved one", () => {
    expect(mergeDecision("approve", "approve")).toBe("approve");
    expect(mergeDecision("approve", "pending")).toBe("pending");
    expect(mergeDecision("pending", "reject")).toBe("reject");
    expect(mergeDecision("reject", "approve")).toBe("reject");
  });

  test("each cell takes the decision of the hunk that changed it; other nodes are left out", () => {
    const history = [
      entry(1, 2, [
        change("sheet:#1/cell:B2", 0),
        change("sheet:#1/cell:C3", 1),
        change("sheet:#1/row:3", 0, "row"),
        change("sheet:#1/cell:D4", undefined),
        change("sheet:#2/cell:B2", 1),
      ]),
    ];
    const cells = changedCells(reads(history, { "1:0": "approve", "1:1": "reject" }));
    expect([...cells.keys()].sort()).toEqual(["1!B2", "1!C3", "1!D4", "2!B2"]);
    expect(cells.get("1!B2")).toMatchObject({ sheetId: 1, a1: "B2", row: 2, col: 2, decision: "approve", records: 1 });
    expect(cells.get("1!C3")?.decision).toBe("reject");
    // A change with no cause belongs to the trailing `op: null` hunk, undecided here.
    expect(cells.get("1!D4")?.decision).toBe("pending");
    // The same a1 on another sheet is its own cell.
    expect(cells.get("2!B2")?.decision).toBe("reject");
  });

  test("a cell changed by several change sets merges their decisions and names the latest record", () => {
    const first = entry(1, 1, [change("sheet:#1/cell:B2", 0), change("sheet:#1/cell:C3", 0)]);
    const second = entry(2, 1, [change("sheet:#1/cell:B2", 0), change("sheet:#1/cell:C3", 0)]);
    const cells = changedCells(reads([first, second], { "1:0": "approve", "2:0": "pending" }));
    expect(cells.get("1!B2")).toMatchObject({ decision: "pending", records: 2, index: 0 });
    expect(cells.get("1!B2")?.entry).toBe(second);

    const rejected = changedCells(reads([first, second], { "1:0": "reject", "2:0": "approve" }));
    expect(rejected.get("1!C3")?.decision).toBe("reject");
  });

  test("a history with no changes marks nothing", () => {
    expect(changedCells(reads([])).size).toBe(0);
    expect(changedCells(reads([entry(1, 1, [])])).size).toBe(0);
  });

  test("sheets carry the count and combined decision of their changed cells", () => {
    const history = [entry(1, 2, [change("sheet:#1/cell:A1", 0), change("sheet:#1/cell:A2", 1), change("sheet:#3/cell:A1", 0)])];
    const marks = sheetMarks(changedCells(reads(history, { "1:0": "approve", "1:1": "pending" })));
    expect(marks.get(1)).toEqual({ count: 2, decision: "pending" });
    expect(marks.get(3)).toEqual({ count: 1, decision: "approve" });
    expect(marks.has(2)).toBe(false);
  });
});

describe("sheet tabs and view", () => {
  test("the tabs are the sheet nodes in document order, named by their label", () => {
    const nodes = [
      { id: "sheet:#1", kind: "sheet", label: "Summary" },
      { id: "sheet:#1/cell:A1", kind: "cell" },
      { id: "sheet:#4", kind: "sheet" },
      { id: "sheet:#2", kind: "sheet", label: "Data" },
      { id: "sheet:#2/table:#1", kind: "table", label: "T" },
    ];
    expect(sheetTabs(nodes)).toEqual([
      { sheetId: 1, name: "Summary" },
      { sheetId: 4, name: "sheet:#4" },
      { sheetId: 2, name: "Data" },
    ]);
    expect(sheetTabs([])).toEqual([]);
  });

  test("a workbook opens on its sheet grid, with the printed pages one toggle away", () => {
    expect(DEFAULT_SHEET_VIEW).toBe("grid");
    expect(VIEW_LABELS).toEqual({ grid: "Sheet Grid", pages: "Printed Pages" });
  });
});

describe("read window", () => {
  test("the used range gives the extent; anything else gives none", () => {
    expect(usedExtent("A1:F6")).toEqual({ rows: 6, cols: 6 });
    expect(usedExtent("B7")).toEqual({ rows: 7, cols: 2 });
    expect(usedExtent("AA3:AB10")).toEqual({ rows: 10, cols: 28 });
    for (const bad of [null, undefined, "", "Sheet1!A1", "A:B"]) expect(usedExtent(bad)).toBeNull();
  });

  test("before the extent is known one step is read; a small sheet still shows a small grid", () => {
    expect(windowFor(null, [], 0)).toEqual({ rows: ROW_STEP, cols: COL_STEP, truncated: false });
    expect(windowFor({ rows: 6, cols: 6 }, [], 0)).toEqual({ rows: 20, cols: 10, truncated: false });
    expect(windowFor({ rows: 150, cols: 30 }, [], 0)).toEqual({ rows: 150, cols: 30, truncated: false });
  });

  test("a big sheet is cut at the step and grows a step at a time, up to the caps", () => {
    const big = { rows: 5000, cols: 300 };
    expect(windowFor(big, [], 0)).toEqual({ rows: ROW_STEP, cols: COL_STEP, truncated: true });
    expect(windowFor(big, [], 2)).toEqual({ rows: ROW_STEP * 3, cols: COL_STEP * 3, truncated: true });
    expect(windowFor(big, [], 1000)).toEqual({ rows: ROW_CAP, cols: COL_CAP, truncated: true });
    expect(windowFor({ rows: 300, cols: 50 }, [], 0).truncated).toBe(true);
    expect(windowFor({ rows: 300, cols: 50 }, [], 1)).toEqual({ rows: 300, cols: 50, truncated: false });
  });

  test("every changed cell is inside the window, up to the caps", () => {
    const far = [{ row: 450, col: 90 }];
    expect(windowFor(null, far, 0)).toEqual({ rows: 450, cols: 90, truncated: false });
    expect(windowFor({ rows: 5000, cols: 300 }, far, 0)).toEqual({ rows: 450, cols: 90, truncated: true });
    expect(windowFor({ rows: 9000, cols: 900 }, [{ row: 8000, col: 800 }], 0)).toEqual({
      rows: ROW_CAP,
      cols: COL_CAP,
      truncated: true,
    });
  });
});

describe("grid layout", () => {
  // Columns: A 64 (default), B 70, C hidden, D 114, E 154, F 64. Rows: 20 (15 pt), 32, hidden, 40, 20, 20.
  const layout = layoutOf(merged, 6, 6);

  test("offsets follow the engine's widths and heights and skip hidden lines", () => {
    expect(layout.colX).toEqual([0, 64, 134, 134, 248, 402, 466]);
    expect(layout.rowY).toEqual([0, 20, 52, 52, 92, 112, 132]);
    expect(layout.width).toBe(466);
    expect(layout.height).toBe(132);
  });

  test("a point finds its cell, never a hidden one, and nothing outside the grid", () => {
    expect(cellAt(layout, 0, 0)).toEqual({ row: 1, col: 1 });
    expect(cellAt(layout, 63, 19)).toEqual({ row: 1, col: 1 });
    expect(cellAt(layout, 64, 20)).toEqual({ row: 2, col: 2 });
    expect(cellAt(layout, 140, 60)).toEqual({ row: 4, col: 4 });
    expect(cellAt(layout, 465, 131)).toEqual({ row: 6, col: 6 });
    expect(cellAt(layout, 466, 10)).toBeNull();
    expect(cellAt(layout, 10, 132)).toBeNull();
    expect(cellAt(layout, -1, 10)).toBeNull();
    expect(cellAt(layout, 10, -1)).toBeNull();
  });

  test("a cell's box has the cell's own width and height, zero for a hidden line", () => {
    expect(cellRect(layout, 2, 2)).toEqual({ x: 64, y: 20, w: 70, h: 32 });
    expect(cellRect(layout, 2, 3).w).toBe(0);
    expect(cellRect(layout, 3, 2).h).toBe(0);
  });

  test("a sheet with no overrides uses the engine's default sizes", () => {
    const plain = layoutOf({ ...merged, columns: [], row_heights: [], hidden_cols: [], hidden_rows: [] }, 3, 2);
    expect(plain.colX).toEqual([0, 64, 128]);
    expect(plain.rowY).toEqual([0, 20, 40, 60]);
  });
});

describe("reveal offset", () => {
  const view = { left: 100, top: 50, width: 400, height: 300 };
  const inset = { x: 44, y: 24 };

  test("a cell in view does not scroll", () => {
    expect(revealOffset({ x: 200, y: 100, w: 64, h: 20 }, view, inset)).toEqual({ left: 100, top: 50 });
  });

  test("a cell under the sticky headers or past the far edge scrolls just enough", () => {
    expect(revealOffset({ x: 120, y: 60, w: 60, h: 20 }, view, inset)).toEqual({ left: 76, top: 36 });
    expect(revealOffset({ x: 500, y: 400, w: 60, h: 20 }, view, inset)).toEqual({ left: 160, top: 120 });
    expect(revealOffset({ x: 10, y: 5, w: 20, h: 10 }, view, inset)).toEqual({ left: 0, top: 0 });
  });
});

describe("cell boxes", () => {
  const layout = layoutOf(merged, 6, 6);
  const boxes = cellBoxes(merged, layout, 6, 6, []);
  const box = (a1: string) => boxes.find((b) => b.a1 === a1);

  test("a merged range is one box over its visible lines, and the cells it covers are not drawn", () => {
    expect(box("B2")).toMatchObject({ x: 64, y: 20, w: 184, h: 72, text: "Merged hidden span" });
    for (const covered of ["C2", "D2", "B3", "C3", "D3", "B4", "C4", "D4"]) expect(box(covered)).toBeUndefined();
  });

  test("hidden lines draw nothing; other cells keep their text and place", () => {
    expect(boxes.some((b) => b.col === 3 || b.row === 3)).toBe(false);
    expect(box("A1")).toMatchObject({ x: 0, y: 0, w: 64, h: 20, text: "R1C1", formula: null });
    expect(box("F6")).toMatchObject({ x: 402, y: 112, w: 64, h: 20 });
  });

  test("a window cuts the boxes at its rows and columns", () => {
    const small = cellBoxes(merged, layoutOf(merged, 2, 2), 2, 2, []);
    expect(small.map((b) => b.a1).sort()).toEqual(["A1", "A2", "B1", "B2"]);
    // The merge is cut at the window's edge.
    expect(small.find((b) => b.a1 === "B2")).toMatchObject({ w: 70, h: 32 });
  });

  test("a changed cell with no content still gets a box, once", () => {
    const empty = { a1: "E9", row: 9, col: 5 };
    const wide = layoutOf(merged, 10, 6);
    const all = cellBoxes(merged, wide, 10, 6, [empty, empty, { a1: "A1", row: 1, col: 1 }]);
    expect(all.filter((b) => b.a1 === "E9")).toHaveLength(1);
    expect(all.find((b) => b.a1 === "E9")).toMatchObject({ text: "", formula: null, w: 154 });
    expect(all.filter((b) => b.a1 === "A1")).toHaveLength(1);
    expect(all.find((b) => b.a1 === "A1")?.text).toBe("R1C1");
    // Outside the window: not drawn.
    expect(cellBoxes(merged, layout, 6, 6, [{ a1: "A9", row: 9, col: 1 }]).some((b) => b.a1 === "A9")).toBe(false);
  });

  test("alignment is the cell style's, else numbers right and booleans and errors centred", () => {
    expect(alignOf({ alignment: { horizontal: "center" } } as SheetViewport["styles"][string], { number: 1 })).toBe("center");
    expect(alignOf(undefined, { number: 1 })).toBe("right");
    expect(alignOf(undefined, { boolean: true })).toBe("center");
    expect(alignOf(undefined, { error: "#DIV/0!" })).toBe("center");
    expect(alignOf(undefined, { string: "x" })).toBe("left");
    expect(alignOf(undefined, null)).toBe("left");
  });
});
