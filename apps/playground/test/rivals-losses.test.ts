import { describe, expect, test } from "bun:test";
import { MEMBER_VERDICTS, type MemberVerdict, type PackageDelta } from "../src/lab/index.ts";
import { samplePackage } from "../src/lab/testing.ts";
import { categoryOf, lossesFromDelta } from "../src/rivals/losses.ts";

function countsOf(verdicts: readonly MemberVerdict[]): Record<MemberVerdict, number> {
  const counts = Object.fromEntries(MEMBER_VERDICTS.map((v) => [v, 0])) as Record<MemberVerdict, number>;
  for (const verdict of verdicts) counts[verdict]++;
  return counts;
}

function delta(members: [string, MemberVerdict][]): PackageDelta {
  return {
    before: samplePackage,
    after: samplePackage,
    verdicts: members.map(([name, verdict]) => ({ name, verdict, bytesBefore: 10, bytesAfter: 10 })),
    counts: countsOf(members.map(([, verdict]) => verdict)),
    untouchedByteShare: 0,
  };
}

describe("category of a member", () => {
  test("unknown members fall in other", () => {
    expect(categoryOf("xl/unheard/of.xml")).toBe("other");
  });
});

describe("losses from a package delta", () => {
  test("a rewritten member is a rewrite", () => {
    const losses = lossesFromDelta(
      delta([
        ["[Content_Types].xml", "identical-stream"],
        ["xl/worksheets/sheet1.xml", "changed"],
        ["xl/styles.xml", "xml-equivalent"],
      ]),
    );
    expect(losses).toEqual([{ category: "worksheet", members: ["xl/worksheets/sheet1.xml (changed)"], severity: "rewrite" }]);
  });

  test("a category with every member removed is data loss", () => {
    const losses = lossesFromDelta(
      delta([
        ["xl/charts/chart1.xml", "removed"],
        ["xl/charts/chart2.xml", "removed"],
        ["xl/worksheets/sheet1.xml", "changed"],
      ]),
    );
    expect(losses.find((l) => l.category === "chart")).toEqual({
      category: "chart",
      members: ["xl/charts/chart1.xml (removed)", "xl/charts/chart2.xml (removed)"],
      severity: "data-loss",
    });
  });

  test("a category with a surviving member is a rewrite, and calc-chain is never data loss", () => {
    const losses = lossesFromDelta(
      delta([
        ["xl/media/image1.png", "removed"],
        ["xl/media/image2.png", "identical-stream"],
        ["xl/calcChain.xml", "removed"],
      ]),
    );
    expect(losses.find((l) => l.category === "media")?.severity).toBe("rewrite");
    expect(losses.find((l) => l.category === "calc-chain")?.severity).toBe("rewrite");
  });

  test("an untouched package has no losses", () => {
    expect(lossesFromDelta(delta([["word/document.xml", "identical-stream"]]))).toEqual([]);
  });
});
