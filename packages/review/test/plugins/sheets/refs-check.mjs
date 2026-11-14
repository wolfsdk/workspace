#!/usr/bin/env bun
// Unit checks for the pure helpers: A1 references, name-box input, rectangle
// arithmetic, typed-value parsing and TSV clipboard round trips.
//
//   bun test/plugins/sheets/refs-test.mjs
import { deepStrictEqual } from "node:assert";
import * as r from "../../../src/plugins/sheets/refs.ts";
import * as p from "../../../src/plugins/sheets/parse.ts";

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

const rect = (r1, c1, r2, c2) => ({ r1, c1, r2, c2 });

check("colToNum", ["A", "Z", "AA", "XFD"].map(r.colToNum), [1, 26, 27, 16384]);
check("numToCol", [1, 26, 27, 16384].map(r.numToCol), ["A", "Z", "AA", "XFD"]);
check("toA1", r.toA1(10, 28), "AB10");
check(
  "parseA1",
  [r.parseA1("B2"), r.parseA1("$C$10")],
  [
    { row: 2, col: 2 },
    { row: 10, col: 3 },
  ],
);
check("parseA1 out of grid", [r.parseA1("XFE1"), r.parseA1("A0"), r.parseA1("hello")], [null, null, null]);
check("parseRange normalises", r.parseRange("C3:A1"), rect(1, 1, 3, 3));
check("parseRange columns", r.parseRange("B:D"), rect(1, 2, r.MAX_ROWS, 4));
check("parseRange rows", r.parseRange("3:5"), rect(3, 1, 5, r.MAX_COLS));
check(
  "rectLabel",
  [r.rectLabel(rect(1, 2, r.MAX_ROWS, 4)), r.rectLabel(rect(3, 1, 5, r.MAX_COLS)), r.rectLabel(rect(1, 1, 2, 2))],
  ["B:D", "3:5", "A1:B2"],
);
check("rectLabel all", r.rectLabel(rect(1, 1, r.MAX_ROWS, r.MAX_COLS)), "All");
check("rectToA1 single", r.rectToA1(rect(4, 3, 4, 3)), "C4");
check("rectContains", [r.rectContains(rect(1, 1, 3, 3), 2, 2), r.rectContains(rect(1, 1, 3, 3), 4, 2)], [true, false]);
check(
  "rectIntersect",
  [r.rectIntersect(rect(1, 1, 3, 3), rect(2, 2, 5, 5)), r.rectIntersect(rect(1, 1, 1, 1), rect(2, 2, 2, 2))],
  [rect(2, 2, 3, 3), null],
);
check("rectSubtract count", r.rectSubtract(rect(1, 1, 3, 3), rect(2, 2, 2, 2)).length, 4);
check(
  "rectSubtract cells",
  r.rectSubtract(rect(1, 1, 3, 3), rect(2, 2, 2, 2)).reduce((n, x) => n + (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1), 0),
  8,
);
check("rectSubtract disjoint", r.rectSubtract(rect(1, 1, 1, 1), rect(5, 5, 5, 5)), [rect(1, 1, 1, 1)]);
check("parseNameBox local", r.parseNameBox(" B2 "), { sheet: null, rect: rect(2, 2, 2, 2) });
check("parseNameBox sheet", r.parseNameBox("Sheet2!C5"), { sheet: "Sheet2", rect: rect(5, 3, 5, 3) });
check("parseNameBox quoted", r.parseNameBox("'My ''Sheet'!A1:B2"), { sheet: "My 'Sheet", rect: rect(1, 1, 2, 2) });
check("parseNameBox invalid", [r.parseNameBox("zz!"), r.parseNameBox("")], [null, null]);

check("parseNumber", ["12", "-3.5", "1,234.5", "12%", "(42)", "$1,200", "1e3", "abc", "1,23"].map(p.parseNumber), [
  12,
  -3.5,
  1234.5,
  0.12,
  -42,
  1200,
  1000,
  null,
  null,
]);
check("parseInput", ["=SUM(A1)", "12", "TRUE", "", "'12", "hi"].map(p.parseInput), [
  { formula: "=SUM(A1)" },
  { number: 12 },
  { boolean: true },
  { empty: true },
  { string: "12" },
  { string: "hi" },
]);
const grid = [
  ["a", "b\tc"],
  ['x"y', "multi\nline"],
];
check("parseTsv quoted", p.parseTsv('a\t"b\tc"\n"x""y"\t"multi\nline"\n'), grid);
check("TSV round trip", p.parseTsv(p.toTsv(grid)), grid);
check("parseTsv CRLF", p.parseTsv("1\t2\r\n3\t4\r\n"), [
  ["1", "2"],
  ["3", "4"],
]);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
