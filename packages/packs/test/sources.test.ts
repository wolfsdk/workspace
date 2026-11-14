// What a pack reads: a workbook as saved, or a CSV or SQL snapshot pinned by its hash.
import { describe, expect, test } from "bun:test";
import { openSource, parseCsv } from "../src/sources.ts";
import { MemoryStore } from "../src/store.ts";
import { evaluatorFor } from "./evaluators.ts";
import { bytesOf, codeOf, DETERMINISM, QUARTERS, sha256, STYLE, xlsx } from "./fixtures.ts";

const XLSX_SOURCE = { id: "fin", kind: "xlsx", doc_name: "fin.xlsx", determinism: { ...DETERMINISM } } as const;

const snapshot = (kind: "csv_snapshot" | "sql_snapshot", name: string, bytes: Uint8Array, pin: string | null = sha256(bytes)) => ({
  source: { id: "snap", kind, doc_name: name, determinism: { ...DETERMINISM, ...(pin === null ? {} : { snapshot_sha256: pin }) } },
  store: new MemoryStore([[name, bytes]]),
});

describe("csv", () => {
  test("parses RFC 4180 records", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n1,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", ""],
    ]);
    expect(parseCsv("\ufeffa,b")).toEqual([["a", "b"]]);
    expect(parseCsv('"multi\nline",2')).toEqual([["multi\nline", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });

  test("an unterminated quote is refused", async () => {
    expect(await codeOf(() => parseCsv('a,"b'))).toBe("bad-snapshot");
  });
});

describe("a workbook source", () => {
  const store = new MemoryStore([
    [
      "fin.xlsx",
      xlsx({
        rows: [...QUARTERS, ["Total", { v: 4568000, s: STYLE.thousands, f: "SUM(B2:B4)" }, null]],
        names: { Headline: "Fin!$B$2", Pair: "Fin!$B$2:$C$2", Label: '"Quarterly"' },
        table: { name: "Quarters", ref: "A1:C4" },
      }),
    ],
  ]);

  test("reads a cell with its own number format", async () => {
    const reader = await openSource(XLSX_SOURCE, store, undefined);
    expect(reader.select({ type: "cell", sheet: "Fin", ref: "B2" })).toEqual([[{ value: 1234567.891, format: '"$"#,##0.00' }]]);
    expect(reader.select({ type: "cell", sheet: "fin", ref: "A2" })).toEqual([[{ value: "Q1", format: null }]]);
    expect(reader.select({ type: "cell", sheet: "Fin", ref: "Z9" })).toEqual([[{ value: null, format: null }]]);
  });

  test("reads a range, a table and a defined name", async () => {
    const reader = await openSource(XLSX_SOURCE, store, undefined);
    expect(reader.select({ type: "range", sheet: "Fin", ref: "A2:B3" }).map((row) => row.map((c) => c.value))).toEqual([
      ["Q1", 1234567.891],
      ["Q2", 2345678.5],
    ]);
    expect(reader.select({ type: "table", name: "Quarters" })).toHaveLength(4);
    expect(reader.select({ type: "defined_name", name: "Headline" })[0]?.[0]?.value).toBe(1234567.891);
    expect(reader.select({ type: "defined_name", name: "Pair" })).toHaveLength(1);
    expect(reader.select({ type: "defined_name", name: "Label" })).toEqual([[{ value: "Quarterly", format: null }]]);
  });

  test("a formula cell is read as its cached value", async () => {
    const reader = await openSource(XLSX_SOURCE, store, undefined);
    expect(reader.select({ type: "cell", sheet: "Fin", ref: "B5" })[0]?.[0]).toEqual({ value: 4568000, format: "#,##0" });
  });

  test("names what is not there", async () => {
    const reader = await openSource(XLSX_SOURCE, store, undefined);
    expect(await codeOf(() => reader.select({ type: "cell", sheet: "Nope", ref: "A1" }))).toBe("unknown-sheet");
    expect(await codeOf(() => reader.select({ type: "table", name: "Nope" }))).toBe("unknown-table");
    expect(await codeOf(() => reader.select({ type: "defined_name", name: "Nope" }))).toBe("unknown-name");
    expect(await codeOf(() => openSource({ ...XLSX_SOURCE, doc_name: "missing.xlsx" }, store, undefined))).toBe("source-missing");
  });

  test("reads dates under the 1904 system of the workbook", async () => {
    const dated = new MemoryStore([["fin.xlsx", xlsx({ rows: [[{ v: 43831, s: STYLE.date }]], date1904: true })]]);
    expect((await openSource(XLSX_SOURCE, dated, undefined)).date1904).toBe(true);
  });

  test("an evaluator recalculates before anything is read", async () => {
    const reader = await openSource(XLSX_SOURCE, store, evaluatorFor((bytes) => bytes));
    expect(reader.select({ type: "cell", sheet: "Fin", ref: "B2" })[0]?.[0]?.value).toBe(1234567.891);
    const changed = await openSource(XLSX_SOURCE, store, evaluatorFor(() => xlsx({ rows: [["Q1", 42]] })));
    expect(changed.select({ type: "cell", sheet: "Fin", ref: "B1" })[0]?.[0]?.value).toBe(42);
  });
});

describe("a csv snapshot", () => {
  const csv = bytesOf("Region,Units,Code\nNorth,10,007\nSouth,2.5,\n");

  test("is read as a sheet: header on row 1, plain numbers as numbers, leading zeros kept as text", async () => {
    const { source, store } = snapshot("csv_snapshot", "data/units.csv", csv);
    const reader = await openSource(source, store, undefined);
    expect(reader.select({ type: "range", sheet: "Sheet1", ref: "A1:C3" }).map((row) => row.map((c) => c.value))).toEqual([
      ["Region", "Units", "Code"],
      ["North", 10, "007"],
      ["South", 2.5, null],
    ]);
    expect(reader.select({ type: "cell", sheet: "units", ref: "B2" })[0]?.[0]?.value).toBe(10);
    expect(reader.select({ type: "defined_name", name: "Units" }).map((row) => row[0]?.value)).toEqual([10, 2.5]);
    expect(reader.select({ type: "table", name: "units" })).toHaveLength(3);
  });

  test("is refused when its hash is not the one the manifest pins", async () => {
    const { source, store } = snapshot("csv_snapshot", "units.csv", csv, "0".repeat(64));
    expect(await codeOf(() => openSource(source, store, undefined))).toBe("snapshot-sha256-mismatch");
    const unpinned = snapshot("csv_snapshot", "units.csv", csv, null);
    expect(await codeOf(() => openSource(unpinned.source, unpinned.store, undefined))).toBe("snapshot-sha256-mismatch");
  });

  test("a ragged record is refused", async () => {
    const { source, store } = snapshot("csv_snapshot", "units.csv", bytesOf("a,b\n1,2,3\n"));
    expect(await codeOf(() => openSource(source, store, undefined))).toBe("bad-snapshot");
  });
});

describe("a sql snapshot", () => {
  test("is a query result as columns and rows, or as an array of row objects", async () => {
    const columns = snapshot("sql_snapshot", "q.json", bytesOf(JSON.stringify({ columns: ["k", "v"], rows: [["a", 1], ["b", null]] })));
    const objects = snapshot("sql_snapshot", "q.json", bytesOf(JSON.stringify([{ k: "a", v: 1 }, { k: "b" }])));
    for (const { source, store } of [columns, objects]) {
      const reader = await openSource(source, store, undefined);
      expect(reader.select({ type: "range", sheet: "Sheet1", ref: "A1:B3" }).map((row) => row.map((c) => c.value))).toEqual([
        ["k", "v"],
        ["a", 1],
        ["b", null],
      ]);
    }
  });

  test("anything else is refused", async () => {
    for (const text of ["not json", '{"columns":["a"]}', '{"columns":["a"],"rows":[[{"x":1}]]}']) {
      const { source, store } = snapshot("sql_snapshot", "q.json", bytesOf(text));
      expect(await codeOf(() => openSource(source, store, undefined))).toBe("bad-snapshot");
    }
  });
});
