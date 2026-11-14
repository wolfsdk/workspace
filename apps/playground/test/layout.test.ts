import { describe, expect, test } from "bun:test";
import type { MemberInfo, MemberVerdict, PackageDelta, PackageInfo } from "../src/lab/index.ts";
import { samplePackage, sampleDelta } from "../src/lab/testing.ts";
import { changedSpans, layoutTreemap, ribbonSegments, squarify, type Rect } from "../src/anatomy/layout.ts";
import { memberRole } from "../src/anatomy/roles.ts";
import { advanceMotion, formatShare, initialMotion, untouchedLabel } from "../src/anatomy/verdicts.ts";
import { clickCount, clickOffsets, createGeiger } from "../src/anatomy/geiger.ts";

const member = (name: string, compressedSize: number, headerOffset: number): MemberInfo => ({
  name,
  method: 8,
  crc32: 0,
  compressedSize,
  size: compressedSize * 3,
  streamSha256: "0".repeat(64),
  headerOffset,
  dataOffset: headerOffset + 30 + name.length,
});

/** A package with every role, sizes spread over three orders of magnitude. */
function bigPackage(): PackageInfo {
  const names: [string, number][] = [
    ["[Content_Types].xml", 1200],
    ["_rels/.rels", 300],
    ["word/document.xml", 48000],
    ["word/_rels/document.xml.rels", 900],
    ["word/styles.xml", 7000],
    ["word/theme/theme1.xml", 6000],
    ["word/media/image1.png", 90000],
    ["word/media/image2.jpeg", 30000],
    ["customXml/item1.xml", 250],
    ["word/vbaProject.bin", 15000],
    ["word/charts/chart1.xml", 4000],
    ["xl/pivotTables/pivotTable1.xml", 3500],
    ["docProps/core.xml", 400],
    ["word/settings.xml", 2200],
    ["word/header1.xml", 1100],
    ["word/footer1.xml", 1100],
    ["word/fontTable.xml", 1500],
    ["word/empty.xml", 0],
  ];
  let offset = 0;
  const members = names.map(([name, size]) => {
    const m = member(name, size, offset);
    offset = m.dataOffset + size + 16;
    return m;
  });
  return { bytes: offset + 2000, sha256: "f".repeat(64), members };
}

const area = (r: Rect) => r.w * r.h;
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const EPS = 1e-6;

describe("memberRole", () => {
  test("groups part names by OOXML role", () => {
    const cases: [string, string][] = [
      ["word/document.xml", "body"],
      ["xl/worksheets/sheet1.xml", "body"],
      ["xl/sharedStrings.xml", "body"],
      ["ppt/slides/slide3.xml", "body"],
      ["xl/styles.xml", "styles"],
      ["ppt/slideLayouts/slideLayout1.xml", "styles"],
      ["word/theme/theme1.xml", "styles"],
      ["word/media/image1.png", "media"],
      ["ppt/embeddings/oleObject1.bin", "media"],
      ["_rels/.rels", "relationships"],
      ["xl/worksheets/_rels/sheet1.xml.rels", "relationships"],
      ["customXml/itemProps1.xml", "custom-xml"],
      ["xl/vbaProject.bin", "vba"],
      ["word/vbaData.xml", "vba"],
      ["xl/charts/chart1.xml", "charts"],
      ["xl/charts/style1.xml", "charts"],
      ["xl/pivotCache/pivotCacheDefinition1.xml", "pivot"],
      ["[Content_Types].xml", "other"],
      ["docProps/app.xml", "other"],
    ];
    for (const [name, role] of cases) expect(`${name}=${memberRole(name)}`).toBe(`${name}=${role}`);
  });
});

describe("squarify", () => {
  test("fills the rectangle exactly with areas proportional to weights", () => {
    const weights = [60, 25, 9, 4, 1, 1];
    const rect = { x: 3, y: 5, w: 40, h: 25 };
    const rects = squarify(weights, rect);
    const total = weights.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => expect(area(r) / area(rect)).toBeCloseTo(weights[i]! / total, 9));
    expect(rects.reduce((s, r) => s + area(r), 0)).toBeCloseTo(area(rect), 9);
  });

  test("zero total gives zero-area rectangles", () => {
    expect(squarify([0, 0], { x: 0, y: 0, w: 10, h: 10 }).map(area)).toEqual([0, 0]);
  });
});

describe("layoutTreemap", () => {
  const info = bigPackage();
  const layout = layoutTreemap(info, { width: 160, height: 100 });
  const cells = layout.groups.flatMap((g) => g.cells);
  const total = info.members.reduce((s, m) => s + m.compressedSize, 0);

  test("every member appears once", () => {
    expect(cells.map((c) => c.name).sort()).toEqual(info.members.map((m) => m.name).sort());
    expect(layout.bytes).toBe(total);
  });

  test("cell and group areas are proportional to compressed bytes", () => {
    for (const c of cells) expect(Math.abs(area(c) / (160 * 100) - c.bytes / total)).toBeLessThan(EPS);
    for (const g of layout.groups) expect(Math.abs(area(g) / (160 * 100) - g.bytes / total)).toBeLessThan(EPS);
  });

  test("cells stay inside their group and the frame", () => {
    for (const g of layout.groups) {
      expect(g.x).toBeGreaterThanOrEqual(-EPS);
      expect(g.y).toBeGreaterThanOrEqual(-EPS);
      expect(g.x + g.w).toBeLessThanOrEqual(160 + EPS);
      expect(g.y + g.h).toBeLessThanOrEqual(100 + EPS);
      for (const c of g.cells) {
        expect(c.x).toBeGreaterThanOrEqual(g.x - EPS);
        expect(c.y).toBeGreaterThanOrEqual(g.y - EPS);
        expect(c.x + c.w).toBeLessThanOrEqual(g.x + g.w + EPS);
        expect(c.y + c.h).toBeLessThanOrEqual(g.y + g.h + EPS);
      }
    }
  });

  test("no two cells overlap", () => {
    for (let i = 0; i < cells.length; i++)
      for (let j = i + 1; j < cells.length; j++) expect(overlap(cells[i]!, cells[j]!)).toBeLessThan(EPS);
  });

  test("groups by role", () => {
    const roles = Object.fromEntries(layout.groups.map((g) => [g.role, g.cells.map((c) => c.name).sort()]));
    expect(roles.media).toEqual(["word/media/image1.png", "word/media/image2.jpeg"]);
    expect(roles.vba).toEqual(["word/vbaProject.bin"]);
    expect(Object.keys(roles).sort()).toEqual(
      ["body", "charts", "custom-xml", "media", "other", "pivot", "relationships", "styles", "vba"].sort(),
    );
  });

  test("ordering is stable: same input, or the same members in another order, gives the same layout", () => {
    expect(layoutTreemap(info, { width: 160, height: 100 })).toEqual(layout);
    const reversed = { ...info, members: [...info.members].reverse() };
    expect(layoutTreemap(reversed, { width: 160, height: 100 })).toEqual(layout);
  });

  test("equal sizes are ordered by name", () => {
    const flat: PackageInfo = {
      bytes: 1000,
      sha256: "",
      members: ["word/c.xml", "word/a.xml", "word/b.xml"].map((n, i) => member(n, 100, i * 200)),
    };
    const order = layoutTreemap(flat).groups.flatMap((g) => g.cells.map((c) => c.name));
    expect(order).toEqual(["word/a.xml", "word/b.xml", "word/c.xml"]);
  });

  test("verdicts come from the delta and removed members stay visible", () => {
    const delta: PackageDelta = {
      ...sampleDelta(["xl/styles.xml"]),
      verdicts: [
        ...sampleDelta(["xl/styles.xml"]).verdicts,
        { name: "xl/calcChain.xml", verdict: "removed", bytesBefore: 300, bytesAfter: 0 },
      ],
    };
    const mapped = layoutTreemap(samplePackage, { delta }).groups.flatMap((g) => g.cells);
    const byName = Object.fromEntries(mapped.map((c) => [c.name, c]));
    expect(byName["xl/styles.xml"]!.verdict).toBe("changed");
    expect(byName["xl/workbook.xml"]!.verdict).toBe("identical-stream");
    expect(byName["xl/calcChain.xml"]!.verdict).toBe("removed");
    expect(byName["xl/calcChain.xml"]!.bytes).toBe(300);
  });

  test("duplicate names get distinct keys", () => {
    const dup: PackageInfo = { bytes: 500, sha256: "", members: [member("a.xml", 10, 0), member("a.xml", 10, 100)] };
    const keys = layoutTreemap(dup).groups.flatMap((g) => g.cells.map((c) => c.key));
    expect(new Set(keys).size).toBe(2);
  });
});

describe("ribbonSegments", () => {
  function expectExactCover(info: PackageInfo) {
    const segments = ribbonSegments(info);
    if (info.bytes === 0) return expect(segments).toEqual([]);
    expect(segments[0]!.start).toBe(0);
    expect(segments.at(-1)!.end).toBe(info.bytes);
    for (let i = 0; i < segments.length; i++) {
      expect(segments[i]!.end).toBeGreaterThan(segments[i]!.start);
      if (i > 0) expect(segments[i]!.start).toBe(segments[i - 1]!.end);
    }
    expect(segments.reduce((s, x) => s + (x.end - x.start), 0)).toBe(info.bytes);
  }

  test("cover the file exactly once in byte order", () => {
    expectExactCover(bigPackage());
    expectExactCover(samplePackage);
  });

  test("overlapping, unsorted and out-of-range members never double-count", () => {
    expectExactCover({
      bytes: 1000,
      sha256: "",
      members: [member("b.xml", 400, 300), member("a.xml", 500, 0), member("far.xml", 50, 5000), member("c.xml", 10, 990)],
    });
  });

  test("an empty file has no segments", () => {
    expectExactCover({ bytes: 0, sha256: "", members: [] });
  });

  test("members keep their verdicts and changed spans merge where they touch", () => {
    const info: PackageInfo = {
      bytes: 300,
      sha256: "",
      members: [
        { ...member("a", 70, 0), dataOffset: 30 },
        { ...member("b", 70, 100), dataOffset: 130 },
        { ...member("c", 70, 200), dataOffset: 230 },
      ],
    };
    const verdicts: [string, MemberVerdict][] = [
      ["a", "identical-stream"],
      ["b", "changed"],
      ["c", "xml-equivalent"],
    ];
    const delta = {
      ...sampleDelta(),
      verdicts: verdicts.map(([name, verdict]) => ({ name, verdict, bytesBefore: 70, bytesAfter: 70 })),
    };
    const segments = ribbonSegments(info, delta);
    expect(segments.map((s) => (s.kind === "member" ? `${s.name}:${s.verdict}` : "zip"))).toEqual([
      "a:identical-stream",
      "b:changed",
      "c:xml-equivalent",
    ]);
    expect(changedSpans(segments)).toEqual([{ start: 100, end: 300, members: ["b", "c"] }]);
  });
});

describe("untouched share label", () => {
  test("reads the share from the delta and rounds down", () => {
    const delta = sampleDelta();
    expect(delta.untouchedByteShare).toBeCloseTo((400 + 600 + 1800 + 900) / 7700, 12);
    expect(untouchedLabel(delta.untouchedByteShare)).toBe(
      "Untouched: 48.0% of the original compressed member bytes are carried over as identical streams.",
    );
    expect(formatShare(0.99999)).toBe("99.9%");
    expect(formatShare(1)).toBe("100.0%");
    expect(formatShare(0.57)).toBe("57.0%");
    expect(formatShare(Number.NaN)).toBe("0.0%");
  });
});

describe("advanceMotion", () => {
  test("marks members whose verdict moved since the previous delta", () => {
    const first = sampleDelta(["xl/worksheets/sheet1.xml"]);
    const a = advanceMotion(initialMotion, first);
    expect([...a.shifted]).toEqual(["xl/worksheets/sheet1.xml"]);
    expect(advanceMotion(a, first)).toBe(a);
    const b = advanceMotion(a, sampleDelta(["xl/styles.xml"]));
    expect([...b.shifted].sort()).toEqual(["xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    expect(b.generation).toBe(a.generation + 1);
    const c = advanceMotion(b, undefined);
    expect([...c.shifted]).toEqual(["xl/styles.xml"]);
  });
});

describe("geiger", () => {
  test("click count grows with changed bytes and is capped", () => {
    expect(clickCount(0)).toBe(0);
    expect(clickCount(-5)).toBe(0);
    expect(clickCount(Number.NaN)).toBe(0);
    expect(clickCount(1)).toBe(1);
    expect(clickCount(1024)).toBe(6);
    expect(clickCount(1e12)).toBe(12);
    const offsets = clickOffsets(5, () => 0.5);
    expect(offsets).toHaveLength(5);
    expect(offsets.every((o) => o >= 0 && o < 1)).toBe(true);
  });

  test("is muted by default and safe without AudioContext", () => {
    const g = createGeiger();
    expect(g.muted).toBe(true);
    g.tick(1000);
    g.setMuted(false);
    expect(g.muted).toBe(false);
    g.tick(1000);
    g.dispose();
    expect(g.muted).toBe(true);
  });

  test("schedules clicks only when unmuted", () => {
    const started: number[] = [];
    let closed = false;
    class FakeContext {
      sampleRate = 8000;
      currentTime = 1;
      state = "suspended";
      destination = {};
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
      close() {
        closed = true;
        return Promise.resolve();
      }
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
      createBuffer(_channels: number, length: number) {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start: (t: number) => started.push(t) };
      }
    }
    const g = globalThis as { AudioContext?: unknown };
    const saved = g.AudioContext;
    g.AudioContext = FakeContext;
    try {
      const geiger = createGeiger();
      geiger.tick(1024);
      expect(started).toHaveLength(0);
      geiger.setMuted(false);
      geiger.tick(1024);
      expect(started).toHaveLength(clickCount(1024));
      expect(started.every((t) => t > 1)).toBe(true);
      geiger.setMuted(true);
      geiger.tick(1024);
      expect(started).toHaveLength(clickCount(1024));
      geiger.dispose();
      expect(closed).toBe(true);
    } finally {
      g.AudioContext = saved;
    }
  });
});
