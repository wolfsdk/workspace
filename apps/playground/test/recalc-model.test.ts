import { describe, expect, test } from "bun:test";
import type { RecalcReport } from "../src/lab/index.ts";
import { FakeLabEngine, sampleFile, sampleRecalc } from "../src/lab/testing.ts";
import {
  cellLabel,
  DEFAULT_SORT,
  difference,
  formatAbsolute,
  formatRelative,
  nextSort,
  recalcAccess,
  recalcRows,
  showValue,
  sortRows,
} from "../src/modes/recalc/model.ts";

const cell = (a1: string, cached: RecalcReport["cells"][number]["cached"], computed: RecalcReport["cells"][number]["computed"]) => ({
  address: `sheet:#1/cell:${a1}`,
  sheet: "Model",
  a1,
  cached,
  computed,
});

describe("mismatch table from a report", () => {
  test("one row per reported cell, with both values and the numeric difference", () => {
    const rows = recalcRows(sampleRecalc);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.label).toBe("Model!B6");
    expect(row!.formula).toBe("=SUM(B2:B5)");
    expect(row!.cached).toEqual({ kind: "number", text: "9999", number: 9999 });
    expect(row!.computed).toEqual({ kind: "number", text: "1540", number: 1540 });
    expect(row!.diff).toEqual({ kind: "numeric", absolute: 8459, relative: 8459 / 9999 });
    expect(formatAbsolute(row!.diff)).toBe("8,459");
    expect(formatRelative(row!.diff)).toBe("84.6%");
  });

  test("an empty report gives no rows", () => {
    expect(recalcRows({ formulas: 3, ms: 1, cells: [] })).toEqual([]);
  });

  test("sheet names that need quoting are quoted", () => {
    expect(cellLabel("Q3 Model", "B7")).toBe("'Q3 Model'!B7");
    expect(cellLabel("Bob's", "A1")).toBe("'Bob''s'!A1");
    expect(cellLabel("Data", "B7")).toBe("Data!B7");
  });
});

describe("value and difference formatting", () => {
  test("numbers keep every digit; differences are rounded for reading", () => {
    const cached = showValue({ number: 1 });
    const computed = showValue({ number: 1259.7120000000002 });
    expect(computed.text).toBe("1259.7120000000002");
    const d = difference(cached, computed);
    expect(formatAbsolute(d)).toBe("1,258.71");
    expect(formatRelative(d)).toBe("125,871%");
    expect(showValue({ number: -0 }).text).toBe("0");
    expect(formatAbsolute(difference(showValue({ number: 1 }), showValue({ number: 123456790 })))).toBe("123,456,789");
  });

  test("tiny numeric differences use exponent notation", () => {
    const d = difference(showValue({ number: 0.3 }), showValue({ number: 0.1 + 0.2 }));
    expect(d.kind).toBe("numeric");
    expect(formatAbsolute(d)).toBe("5.55e-17");
    expect(formatRelative(d)).toBe("1.85e-14%");
  });

  test("a stored zero has no relative difference", () => {
    const d = difference(showValue({ number: 0 }), showValue({ number: 5 }));
    expect(formatAbsolute(d)).toBe("5");
    expect(formatRelative(d)).toBe("not defined, stored value is 0");
  });

  test("text values are quoted and have no numeric difference", () => {
    const cached = showValue({ string: "1080" });
    expect(cached).toEqual({ kind: "text", text: '"1080"' });
    const d = difference(cached, showValue({ number: 1080 }));
    expect(d).toEqual({ kind: "not-numeric", reason: "text and number" });
    expect(formatAbsolute(d)).toBe("does not apply");
    expect(formatRelative(d)).toBe("does not apply");
    expect(difference(showValue({ text: "a" }), showValue({ string: "b" }))).toEqual({
      kind: "not-numeric",
      reason: "both are text",
    });
  });

  test("booleans", () => {
    expect(showValue({ boolean: true })).toEqual({ kind: "boolean", text: "TRUE" });
    expect(showValue({ boolean: false })).toEqual({ kind: "boolean", text: "FALSE" });
    expect(difference(showValue({ boolean: true }), showValue({ boolean: false }))).toEqual({
      kind: "not-numeric",
      reason: "both are true or false",
    });
  });

  test("error values are the engine's error strings", () => {
    expect(showValue({ string: "#DIV/0!" })).toEqual({ kind: "error", text: "#DIV/0!" });
    expect(showValue({ string: "#N/A" }).kind).toBe("error");
    expect(showValue({ string: "#n/a" }).kind).toBe("text");
    const d = difference(showValue({ string: "#REF!" }), showValue({ number: 4 }));
    expect(d).toEqual({ kind: "not-numeric", reason: "error value and number" });
    expect(formatAbsolute(d)).toBe("does not apply");
  });

  test("blanks: no stored value, or an empty value", () => {
    expect(showValue(null)).toEqual({ kind: "blank", text: "blank" });
    expect(showValue({ empty: true })).toEqual({ kind: "blank", text: "blank" });
    const d = difference(showValue(null), showValue({ number: 7 }));
    expect(d).toEqual({ kind: "not-numeric", reason: "blank and number" });
    expect(formatRelative(d)).toBe("does not apply");
  });
});

describe("sorting", () => {
  const rows = recalcRows({
    formulas: 4,
    ms: 1,
    cells: [
      cell("B10", { number: 10 }, { number: 11 }),
      cell("AA1", { string: "x" }, { number: 1 }),
      cell("B2", { number: 100 }, { number: 50 }),
      cell("C1", { number: 1 }, { number: 2 }),
    ],
  });
  const order = (key: Parameters<typeof nextSort>[1], dir: "asc" | "desc") =>
    sortRows(rows, { key, dir }).map((r) => r.a1);

  test("by cell: column, then row", () => {
    expect(order("cell", "asc")).toEqual(["B2", "B10", "C1", "AA1"]);
    expect(order("cell", "desc")).toEqual(["AA1", "C1", "B10", "B2"]);
  });

  test("by difference: non-numeric rows stay last", () => {
    expect(order("absolute", "desc")).toEqual(["B2", "B10", "C1", "AA1"]);
    expect(order("absolute", "asc")).toEqual(["B10", "C1", "B2", "AA1"]);
    expect(order("relative", "desc")).toEqual(["C1", "B2", "B10", "AA1"]);
  });

  test("by value: numbers before other kinds", () => {
    expect(order("cached", "asc")).toEqual(["C1", "B10", "B2", "AA1"]);
  });

  test("nextSort flips the active column and starts differences at the largest", () => {
    expect(nextSort(DEFAULT_SORT, "cell")).toEqual({ key: "cell", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "absolute")).toEqual({ key: "absolute", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "computed")).toEqual({ key: "computed", dir: "asc" });
  });
});

describe("access", () => {
  test("a workbook can be recalculated", async () => {
    const doc = await new FakeLabEngine().openFile(sampleFile.bytes, sampleFile.name);
    expect(recalcAccess(doc)).toEqual({ kind: "workbook" });
  });

  test("a document that is not a workbook", async () => {
    const doc = { ...(await new FakeLabEngine().openFile(new Uint8Array(4), "memo.docx")), format: "docx" as const };
    expect(recalcAccess(doc)).toEqual({ kind: "not-a-workbook", format: "docx" });
  });
});
