/** @jsxImportSource preact */
import { describe, expect, test } from "bun:test";
import { MEMBER_VERDICTS } from "../src/lab/index.ts";
import { sampleDelta, samplePackage } from "../src/lab/testing.ts";
import { render } from "preact-render-to-string";
import { AnatomyMap, ByteRibbon, Legend } from "../src/anatomy/index.ts";

describe("AnatomyMap", () => {
  test("renders every member of a package without a delta", () => {
    const html = render(<AnatomyMap info={samplePackage} label="File anatomy" />);
    expect(html).toContain('aria-label="File anatomy"');
    expect(html).toContain('data-compared="false"');
    for (const m of samplePackage.members) expect(html).toContain(`data-member="${m.name}"`);
    expect(html).not.toContain("data-verdict");
    expect(html).not.toContain("<button");
  });

  test("marks verdicts, highlights, and renders buttons when selectable", () => {
    const delta = sampleDelta(["xl/worksheets/sheet1.xml", "xl/styles.xml"]);
    const html = render(
      <AnatomyMap info={delta.after} delta={delta} highlight={["xl/styles.xml"]} onSelect={() => {}} label="After edit" />,
    );
    expect(html).toContain('data-compared="true"');
    expect(html).toContain("<button");
    for (const v of delta.verdicts) expect(html).toMatch(new RegExp(`data-member="${v.name.replace(/[[\].]/g, "\\$&")}"[^>]*data-verdict="${v.verdict}"`));
    expect(html).toMatch(/data-member="xl\/styles\.xml"[^>]*data-highlight="true"/);
    expect(html).toContain("highlighted");
  });

  test("says so when there is nothing to show", () => {
    const html = render(<AnatomyMap info={{ bytes: 0, sha256: "", members: [] }} label="Empty" />);
    expect(html).toContain("no package members");
  });
});

describe("ByteRibbon", () => {
  test("labels the untouched share from the delta and marks changed spans", () => {
    const delta = sampleDelta();
    const html = render(<ByteRibbon info={samplePackage} delta={delta} label="Bytes" />);
    expect(html).toContain("Untouched: 48.0%");
    expect(html).toContain('data-verdict="changed"');
    expect(html).toContain("wr-mark");
    expect(html).toContain("1 changed span");
  });

  test("asks for an edit without a delta", () => {
    const html = render(<ByteRibbon info={samplePackage} label="Bytes" />);
    expect(html).toContain("Apply an edit");
    expect(html).not.toContain("Untouched");
  });
});

describe("Legend", () => {
  test("lists every verdict with a label and a definition", () => {
    const html = render(<Legend />);
    for (const v of MEMBER_VERDICTS) expect(html).toContain(`data-verdict="${v}"`);
    expect(html).toContain("Carried over untouched.");
    expect(html).not.toContain("\u2014");
  });

  test("lists only the verdicts asked for", () => {
    const html = render(<Legend verdicts={["changed"]} />);
    expect(html).toContain('data-verdict="changed"');
    expect(html).not.toContain('data-verdict="added"');
  });
});
