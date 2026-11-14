import { describe, expect, test } from "bun:test";
import {
  SESSION_CONTRACT,
  boxesOnPage,
  outlined,
  placeTags,
  readingOrder,
  validateDecision,
  type Change,
  type DocState,
  type HistoryEntry,
  type KernelClient,
  type Region,
} from "@wolfsdk/protocol";
import type { EditorHost, EditorSnapshot } from "../../src/host/index.ts";
import { CompareStore } from "../../src/review/compare.ts";
import { ReviewStore } from "../../src/review/store.ts";
import {
  extractText,
  hitTestLocal,
  parseDisplayList,
  parseTextLayout,
  renderPage,
  selectionRects,
  type Ctx2D,
} from "../../../runtime/src/vector/index.ts";

function makeRegion(objectId: string, bbox: [number, number, number, number]): Region {
  return {
    object_id: objectId,
    page: 1,
    bbox_pt: bbox,
    bbox_px: bbox,
  };
}

function makeEntry(revision: number, baseSha256: string, resultSha256: string, changes: Change[]): HistoryEntry {
  return {
    revision,
    label: `Batch ${revision}`,
    source: "agent",
    ops: [{ op: "replace-text", address: "p:1", find: "old", replace: "new" }] as unknown as HistoryEntry["ops"],
    diff: changes,
    transaction: {
      base_sha256: baseSha256,
      result_sha256: resultSha256,
      committed: true,
      address_map: [{ before: "p:before-1", after: "p:1" }],
      ops: [],
      diff: {
        changes,
        counts: { modified: changes.length },
        identity: `sha256:${"c".repeat(64)}`,
      },
    },
    baseSha256,
    resultSha256,
    appliedAt: 1_700_000_000_000,
  } as unknown as HistoryEntry;
}

describe("carried viewer and wolf-editor capabilities", () => {
  test("page overlays: boxesOnPage, outlined, readingOrder, and placeTags bind changes to page regions", () => {
    const changes: Change[] = [
      { address: "p:1", change: "modified", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
      { address: "p:added", change: "added", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
      { address: "p:removed", change: "removed", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
      {
        address: "p:moved-after",
        from: "p:moved-before",
        change: "moved",
        kind: "paragraph",
        parts: ["word/document.xml"],
        cause: 0,
      } as Change,
    ];
    const entry = makeEntry(1, "sha-base", "sha-after", changes);

    const beforeRegions: Region[] = [
      makeRegion("p:before-1", [72, 100, 400, 24]),
      makeRegion("p:removed", [72, 140, 400, 24]),
      makeRegion("p:moved-before", [72, 180, 400, 24]),
    ];
    const afterRegions: Region[] = [
      makeRegion("p:1", [72, 100, 400, 24]),
      makeRegion("p:added", [72, 140, 400, 24]),
      makeRegion("p:moved-after", [72, 220, 400, 24]),
    ];

    const beforeBoxes = boxesOnPage(entry, "before", beforeRegions);
    expect(beforeBoxes.map((b) => [b.index, b.address])).toEqual([
      [0, "p:before-1"],
      [2, "p:removed"],
      [3, "p:moved-before"],
    ]);

    const afterBoxes = boxesOnPage(entry, "after", afterRegions);
    expect(afterBoxes.map((b) => [b.index, b.address])).toEqual([
      [0, "p:1"],
      [1, "p:added"],
      [3, "p:moved-after"],
    ]);

    const afterState = {
      doc: "doc-1",
      name: "q3-model.xlsx",
      format: "xlsx",
      revision: 1,
      sha256: "sha-after",
      pages: [{ page: 1, width_pt: 612, height_pt: 792 }],
      regions: afterRegions,
      view: { tree: [] },
    } as unknown as DocState;
    expect(outlined(entry, 0, afterState)).toBe(true);
    expect(outlined(entry, 2, afterState)).toBe(false);

    expect(
      readingOrder([
        [100, 200, 50, 20],
        [50, 100, 50, 20],
        [120, 100, 50, 20],
      ]),
    ).toEqual([1, 2, 0]);

    const placements = placeTags(
      [
        { box: [72, 100, 200, 24], text: "Modified paragraph", size: [110, 18] },
        { box: [72, 100, 200, 24], text: "Modified paragraph", size: [110, 18] },
        { box: [0, 0, 612, 792], text: "Full page", size: [80, 18] },
      ],
      [
        [72, 100, 200, 24],
        [72, 140, 200, 24],
      ],
      [612, 792],
    );
    expect(placements).toHaveLength(3);
    expect(placements[0]!.free).toBe(true);
    expect(placements[1]!.free).toBe(false);
    expect(placements[1]!.rect).toEqual(placements[0]!.rect);
    expect(placements[2]!.free).toBe(false);
  });

  test("review panel store and decision download: hunk approval, navigation, and <stem>.review-decision.json export", async () => {
    const entry = makeEntry(1, "a".repeat(64), "b".repeat(64), [
      { address: "p:1", change: "modified", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
    ]);
    const state: DocState = {
      doc: "doc-1",
      name: "q3-model.xlsx",
      format: "xlsx",
      revision: 1,
      sha256: "b".repeat(64),
      pages: [{ page: 1, width_pt: 612, height_pt: 792 }],
      regions: [makeRegion("p:1", [72, 100, 400, 24])],
      view: { tree: [{ id: "p:1", kind: "paragraph" }] },
    } as unknown as DocState;

    const emptyZip = new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]);
    const listeners = new Set<() => void>();
    const revealed: unknown[] = [];
    const selected: string[][] = [];
    let currentState = state;
    const host: EditorHost = {
      kernel: {
        save: async () => emptyZip,
      } as unknown as KernelClient,
      save: async () => emptyZip,
      getSnapshot: (): EditorSnapshot =>
        ({
          state: currentState,
          history: [entry],
          selection: [],
          busy: false,
          lastError: null,
        }) as unknown as EditorSnapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      node: (addr: string) => (addr === "p:1" ? ({ id: "p:1" } as never) : undefined),
      select: (addrs: string[]) => selected.push(addrs),
      reveal: (target: unknown) => revealed.push(target),
      goto: async (rev: number) => {
        currentState = {
          ...state,
          revision: rev,
          sha256: rev === 0 ? "a".repeat(64) : "b".repeat(64),
        };
        for (const l of listeners) l();
      },
    } as unknown as EditorHost;

    const store = new ReviewStore(host);
    expect(store.summary()).toEqual({ approve: 0, reject: 0, undecided: 1 });

    const moved = await store.moveChange(1);
    expect(moved).toEqual({ revision: 1, index: 0 });
    expect(selected).toEqual([["p:1"]]);
    expect(revealed).toContainEqual({ address: "p:1" });

    store.setHunkDecision(entry, 0, "approve");
    expect(store.hunkDecisionOf(entry, 0)).toBe("approve");
    expect(store.decisionOf(entry)).toBe("approve");
    expect(store.summary()).toEqual({ approve: 1, reject: 0, undecided: 0 });

    const exported = await store.buildExport();
    expect(exported).not.toBeNull();
    expect(exported!.contract).toBe(SESSION_CONTRACT);
    expect(exported!.document.name).toBe("q3-model.xlsx");
    expect(exported!.complete).toBe(true);
    expect(validateDecision(exported!.entries[0]!.review_decision)).toEqual([]);

    let downloadedName = "";
    let downloadedHref = "";
    let clicked = false;
    const prevDoc = globalThis.document;
    try {
      globalThis.document = {
        createElement: (tag: string) => {
          expect(tag).toBe("a");
          return {
            set href(v: string) {
              downloadedHref = v;
            },
            set download(v: string) {
              downloadedName = v;
            },
            click() {
              clicked = true;
            },
            remove() {},
          };
        },
        body: { append() {} },
      } as unknown as Document;
      const ok = await store.downloadExport();
      expect(ok).toBe(true);
      expect(clicked).toBe(true);
      expect(downloadedName).toBe("q3-model.review-decision.json");
      expect(downloadedHref.startsWith("blob:")).toBe(true);
    } finally {
      globalThis.document = prevDoc;
    }
  });

  test("before/after comparison: CompareStore mirrors history on a shadow document without moving the host", async () => {
    const baseBytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await crypto.subtle.digest("SHA-256", baseBytes);
    const baseSha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const entry = makeEntry(1, baseSha, "sha-1", [
      { address: "p:1", change: "modified", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
    ]);
    const entry2 = makeEntry(2, "sha-1", "sha-2", [
      { address: "p:1", change: "modified", kind: "paragraph", parts: ["word/document.xml"], cause: 0 } as Change,
    ]);
    const rev0State: DocState = {
      doc: "host-doc",
      name: "services-agreement.docx",
      format: "docx",
      revision: 0,
      sha256: baseSha,
      pages: [{ page: 1, widthPt: 612, heightPt: 792 }],
      regions: [],
      view: { tree: [] },
    } as unknown as DocState;
    const rev1State: DocState = {
      ...rev0State,
      revision: 1,
      sha256: "sha-1",
    };
    const rev2State: DocState = {
      ...rev0State,
      revision: 2,
      sha256: "sha-2",
    };

    const hostListeners = new Set<() => void>();
    let currentHostState: DocState = rev0State;
    let currentHistory: HistoryEntry[] = [];
    let shadowRev = 0;

    const kernel: KernelClient = {
      session: async () => ({ originalSha256: baseSha, entries: [] }) as never,
      save: async (doc: string) => {
        expect(doc).toBe("host-doc");
        return baseBytes;
      },
      open: async (bytes: Uint8Array, name: string) => {
        expect(bytes).toEqual(baseBytes);
        expect(name).toBe("services-agreement.docx");
        shadowRev = 0;
        return { ...rev0State, doc: "shadow-doc" };
      },
      apply: async (doc: string) => {
        expect(doc).toBe("shadow-doc");
        shadowRev = 1;
        return {
          ok: true,
          state: { ...rev1State, doc: "shadow-doc" },
          transaction: entry.transaction,
        };
      },
      goto: async (doc: string, rev: number) => {
        expect(doc).toBe("shadow-doc");
        shadowRev = rev;
        return { ...(rev === 0 ? rev0State : rev1State), doc: "shadow-doc" };
      },
      page: async (doc: string, page: number) => {
        expect(doc).toBe("shadow-doc");
        expect(page).toBe(1);
        expect(shadowRev).toBe(1);
        return {
          page: 1,
          width_pt: 612,
          height_pt: 792,
          dpi: 144,
          png: new Uint8Array([137, 80, 78, 71]),
        };
      },
      close: async () => {},
    } as unknown as KernelClient;

    const host: EditorHost = {
      kernel,
      save: async () => baseBytes,
      getSnapshot: (): EditorSnapshot =>
        ({
          state: currentHostState,
          history: currentHistory,
          selection: [],
          busy: false,
          lastError: null,
        }) as unknown as EditorSnapshot,
      subscribe: (fn: () => void) => {
        hostListeners.add(fn);
        return () => hostListeners.delete(fn);
      },
      node: () => undefined,
      select: () => {},
      reveal: () => {},
      goto: async () => {
        throw new Error("host.goto must not be called when original bytes were captured at revision 0");
      },
    } as unknown as EditorHost;

    const cmp = new CompareStore(host);
    await Promise.resolve();
    currentHostState = rev2State;
    currentHistory = [entry, entry2];
    for (const l of hostListeners) l();
    cmp.setEnabled(true);
    const before = await cmp.beforePage(1, 1);
    expect(cmp.status).toBe("ready");
    expect(cmp.mirrored).toBe(1);
    expect(cmp.stats.opens).toBe(1);
    expect(cmp.stats.applies).toBe(1);
    expect(cmp.stats.hostMoves).toBe(0);
    expect(before).not.toBeNull();
    expect(before!.widthPt).toBe(612);
    expect(before!.heightPt).toBe(792);
    await cmp.dispose();
  });

  test("vector page renderer: parseDisplayList, renderPage, parseTextLayout, extractText, hitTestLocal, and selectionRects", () => {
    const dl = parseDisplayList({
      ok: true,
      page: 1,
      ir: {
        size: { width: 612, height: 792 },
        label: "Page 1",
        ops: [
          {
            fill: {
              path: [{ move_to: { x: 72, y: 72 } }, { line_to: { x: 272, y: 72 } }, { line_to: { x: 272, y: 172 } }, "close"],
              paint: { solid: { r: 20, g: 40, b: 80, a: 255 } },
              fill_rule: "non_zero",
            },
          },
          {
            stroke: {
              path: [{ move_to: { x: 72, y: 200 } }, { line_to: { x: 272, y: 200 } }],
              paint: { solid: { r: 0, g: 0, b: 0, a: 255 } },
              style: { width: 1 },
            },
          },
          {
            glyph_run: {
              font: 0,
              size: 12,
              origin: { x: 72, y: 100 },
              fill: { solid: { r: 0, g: 0, b: 0, a: 255 } },
              shaping: "pending",
              text: "Hi",
              object_id: "p:1",
              object_offset: 0,
            },
          },
        ],
      },
      runs: [{ run: 0, object_id: "p:1", object_offset: 0, char_x: [72, 79, 86], bbox: [72, 88, 14, 16] }],
      fonts: [{ id: 0, family: "Inter", weight: 400, style: "normal" }],
      images: [],
      objects: { "p:1": { text: "Hi", rendered: "Hi", source_text: true } },
      regions: [{ object_id: "p:1", bbox: [72, 88, 14, 16] }],
    });

    expect(dl.page).toBe(1);
    expect(dl.width).toBe(612);
    expect(dl.height).toBe(792);
    expect(dl.ops).toHaveLength(3);
    expect(dl.regions).toEqual([{ objectId: "p:1", bbox: { x: 72, y: 88, w: 14, h: 16 } }]);

    const prevPath2D = globalThis.Path2D;
    if (!globalThis.Path2D) {
      globalThis.Path2D = class MockPath2D {
        moveTo() {}
        lineTo() {}
        bezierCurveTo() {}
        quadraticCurveTo() {}
        closePath() {}
        rect() {}
        addPath() {}
      } as unknown as typeof Path2D;
    }
    try {
      const calls: string[] = [];
      const ctx = {
        canvas: { width: 612, height: 792 },
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        miterLimit: 10,
        font: "",
        textBaseline: "alphabetic",
        textAlign: "left",
        save: () => calls.push("save"),
        restore: () => calls.push("restore"),
        setTransform: () => calls.push("setTransform"),
        transform: () => calls.push("transform"),
        scale: () => calls.push("scale"),
        translate: () => calls.push("translate"),
        fillRect: () => calls.push("fillRect"),
        fill: () => calls.push("fill"),
        stroke: () => calls.push("stroke"),
        setLineDash: () => {},
        measureText: (t: string) => ({ width: t.length * 7 }),
        fillText: (t: string) => calls.push(`fillText:${t}`),
      } as unknown as Ctx2D;

      const stats = renderPage(ctx, dl, { pxPerPt: 1, background: "#ffffff" });
      expect(stats.ops).toBe(3);
      expect(stats.text.fallback).toBe(1);
      expect(calls).toContain("fillRect");
      expect(calls.filter((c) => c === "fill")).toHaveLength(2);
      expect(calls).toContain("fillText:Hi");
    } finally {
      globalThis.Path2D = prevPath2D;
    }

    const layout = parseTextLayout({
      ok: true,
      object_id: "p:1",
      length: 2,
      lines: [
        {
          page: 1,
          transform: [1, 0, 0, 1, 0, 0],
          box: [72, 88, 14, 16],
          baseline: 100,
          ascent: 10,
          descent: 4,
          clusters: [
            { x: 72, advance: 7, run: 0, rendered_start: 0, rendered_end: 1, source_start: 0, source_end: 1 },
            { x: 79, advance: 7, run: 0, rendered_start: 1, rendered_end: 2, source_start: 1, source_end: 2 },
          ],
        },
      ],
    });
    const layouts = new Map([["p:1", layout]]);
    expect(extractText(dl, { x: 0, y: 0, w: 612, h: 792 })).toBe("Hi");
    const hit = hitTestLocal(dl, 75, 95, layouts);
    expect(hit).not.toBeNull();
    expect(hit!.objectId).toBe("p:1");
    const rects = selectionRects(dl, "p:1", 0, 2, layouts);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.w).toBeGreaterThan(0);
  });
});
