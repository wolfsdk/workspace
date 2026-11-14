import { expect, test } from "bun:test";
import { buildPartsReport, comparePackages, describeFinding, unexplainedParts } from "../src/index.ts";
import { twoOpEntry, writeZip } from "./fixtures.ts";

const original = writeZip([
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "xl/worksheets/sheet1.xml", data: "<sheet>1</sheet>" },
  { name: "xl/styles.xml", data: "<styles/>" },
]);
const current = writeZip([
  { name: "[Content_Types].xml", data: "<Types/>" },
  { name: "xl/worksheets/sheet1.xml", data: "<sheet>2</sheet>" },
  { name: "docProps/core.xml", data: "<cp/>" },
]);

test("comparePackages reports an added, a removed and a changed part", () => {
  const { identical, deltas } = comparePackages(original, current);
  expect(identical).toEqual(["[Content_Types].xml"]);
  expect(deltas).toEqual([
    { name: "docProps/core.xml", status: "added" },
    { name: "xl/styles.xml", status: "removed" },
    { name: "xl/worksheets/sheet1.xml", status: "changed" },
  ]);
});

test("unexplainedParts drops parts named by a reviewed change, ignoring a leading slash", () => {
  const { deltas } = comparePackages(original, current);
  expect(unexplainedParts(deltas, ["/xl/worksheets/sheet1.xml"]).map((d) => d.name)).toEqual([
    "docProps/core.xml",
    "xl/styles.xml",
  ]);
});

test("buildPartsReport explains the part a change names and flags the others", () => {
  const report = buildPartsReport(original, current, [twoOpEntry()]);
  expect(report.changed).toBe(3);
  expect(report.findings.map((f) => [f.name, f.status, f.verdict])).toEqual([
    ["docProps/core.xml", "added", "unreported"],
    ["xl/styles.xml", "removed", "unreported"],
    ["xl/worksheets/sheet1.xml", "changed", "explained"],
  ]);
  expect(report.unexplained.map((f) => f.name)).toEqual(["docProps/core.xml", "xl/styles.xml"]);
  expect(report.findings[0]!.detail).toMatchObject({ sizeBefore: null, sizeAfter: 5 });
  expect(report.findings[1]!.detail).toMatchObject({ sizeBefore: 9, sizeAfter: null });
  expect(describeFinding(report.findings[2]!).length).toBeGreaterThan(0);
});
