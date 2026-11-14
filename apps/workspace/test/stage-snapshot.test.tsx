/** @jsxImportSource preact */
// A shared link: the server's display-list pages on canvases, no `<wolf-review>`, no engine probe, no `.wasm`, and the
// room still live over its WebSocket.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { decodeDisplayListSnapshot, type Ctx2D } from "../src/lib/room-client.ts";
import { WorkspaceApi } from "../src/lib/api.ts";
import { documentSummaries } from "../src/lib/room-state.ts";
import { engineFor, shareModeOf } from "../src/lib/session.ts";
import { type PageCanvas, paintSnapshot } from "../src/lib/snapshot.ts";
import { SharedSnapshotStage } from "../src/ui/snapshot-stage.tsx";
import { Stage, type StageProps } from "../src/ui/stage.tsx";
import { activityEvent, ALICE, displayListPage, head, room, snapshotBytes } from "./fixtures.ts";

const noop = (): void => undefined;
const doc = documentSummaries(room({ documents: [{ head: head("memo.docx", 3) }] }))[0]!;
const pages = decodeDisplayListSnapshot(snapshotBytes(displayListPage(1, "Hi"), displayListPage(2, "Yo")));

function unreachableApi(): { api: WorkspaceApi; calls: string[] } {
  const calls: string[] = [];
  const api = new WorkspaceApi("http://127.0.0.1:8787", "t", async (url) => {
    calls.push(url);
    throw new Error("not reachable in a server render");
  });
  return { api, calls };
}

function stageProps(over: Partial<StageProps> = {}): StageProps {
  return {
    api: unreachableApi().api,
    client: null,
    roomId: "q3-close",
    actor: ALICE,
    doc,
    proposal: null,
    proposalIds: [],
    activity: [],
    engine: null,
    theme: "light",
    deciding: false,
    subscribe: () => noop,
    onSelection: noop,
    onDirty: noop,
    onExitReview: noop,
    onDecide: noop,
    onDownloadPreview: noop,
    notify: noop,
    ...over,
  };
}

describe("a shared snapshot page", () => {
  test("shows the read-only banner, the room metadata and one canvas per server page, with no review element", () => {
    const html = render(<SharedSnapshotStage api={unreachableApi().api} roomId="q3-close" doc={doc} snapshotPages={pages} activity={[]} />);
    expect(html).toContain("Shared snapshot · zero WASM");
    expect(html).toContain("Read-only");
    expect(html).toContain("room q3-close");
    expect(html).toContain("memo.docx");
    expect(html).toContain(">r3<");
    expect(html).toContain("2 pages");
    expect(html.match(/<canvas /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Page 1"');
    expect(html).toContain('aria-label="Page 2"');
    expect(html).not.toContain("wolf-review");
    expect(html).not.toContain("Loading the Wolf engine");
    expect(html).not.toContain("Propose Edit");
    expect(html).not.toContain("\u2014");
  });

  test("Stage in share mode renders the snapshot stage and not the editor", () => {
    const html = render(<Stage {...stageProps({ shareMode: true, snapshotPages: pages })} />);
    expect(html).toContain("Shared snapshot · zero WASM");
    expect(html.match(/<canvas /g)).toHaveLength(2);
    expect(html).not.toContain("No local changes");
    expect(html).not.toContain("Loading the Wolf engine");
    // Without share mode the same props give the editor stage, which waits for its engine.
    const editor = render(<Stage {...stageProps()} />);
    expect(editor).toContain("Loading the Wolf engine");
    expect(editor).toContain("No local changes");
    expect(editor).not.toContain("Shared snapshot");
    expect(editor).not.toContain("<canvas");
  });

  test("asks the server for the snapshot only when it was not handed pages", () => {
    const { api, calls } = unreachableApi();
    const loading = render(<SharedSnapshotStage api={api} roomId="q3-close" doc={doc} activity={[]} />);
    expect(loading).toContain("Loading the snapshot");
    expect(loading).not.toContain("<canvas");
    // A server render runs no effect: nothing was requested yet, and handed pages never request anything.
    expect(calls).toEqual([]);
  });

  test("an empty room offers to open a document", () => {
    const html = render(<SharedSnapshotStage api={unreachableApi().api} roomId="q3-close" doc={null} activity={[]} />);
    expect(html).toContain("Open a document");
    expect(html).not.toContain("Shared snapshot ·");
  });

  test("shows live agent.activity presence for the open document, and drops agents that went idle", () => {
    const scout = { id: "scout", name: "Scout" };
    const atlas = { id: "atlas", name: "Atlas" };
    const activity = [
      activityEvent(14, atlas, "searching", "other.docx"),
      activityEvent(13, scout, "reading", "memo.docx", "section 2"),
      activityEvent(12, atlas, "idle", null),
      activityEvent(11, scout, "inspecting", "memo.docx"),
    ];
    const html = render(<SharedSnapshotStage api={unreachableApi().api} roomId="q3-close" doc={doc} snapshotPages={pages} activity={activity} />);
    expect(html).toContain("<strong>Scout</strong> reading");
    expect(html).toContain("section 2");
    expect(html).not.toContain("inspecting");
    expect(html).not.toContain("Atlas");
    expect(html).not.toContain("No agents at work");
    const quiet = render(<SharedSnapshotStage api={unreachableApi().api} roomId="q3-close" doc={doc} snapshotPages={pages} activity={[]} />);
    expect(quiet).toContain("No agents at work");
  });
});

describe("share mode of a page", () => {
  test("?share=1 and ?snapshot=1 turn it on, anything else leaves it off", () => {
    expect(shareModeOf("?room=q3&share=1")).toBe(true);
    expect(shareModeOf("?snapshot=1&doc=memo.docx")).toBe(true);
    expect(shareModeOf("?share=true")).toBe(true);
    expect(shareModeOf("?share")).toBe(true);
    expect(shareModeOf("?share=0")).toBe(false);
    expect(shareModeOf("?room=q3")).toBe(false);
    expect(shareModeOf("")).toBe(false);
  });

  test("a shared page never asks the server for an engine, a normal page asks once", async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string): Promise<{ ok: boolean }> => {
      asked.push(url);
      return { ok: true };
    };
    expect(await engineFor(new URLSearchParams("share=1"), true, "http://127.0.0.1:8787", fetchImpl)).toBeNull();
    expect(asked).toEqual([]);
    expect(await engineFor(new URLSearchParams(""), false, "http://127.0.0.1:8787", fetchImpl)).toEqual({ channel: "http://127.0.0.1:8787/wasm" });
    expect(asked).toEqual(["/wasm/latest.txt"]);
    expect(await engineFor(new URLSearchParams("engine=https://cdn.example.com/wolf/"), false, "http://127.0.0.1:8787", fetchImpl)).toEqual({
      channel: "https://cdn.example.com/wolf",
    });
    expect(asked).toHaveLength(1);
  });
});

/** A canvas whose 2D context records what it is asked to paint. */
function fakeCanvas(): PageCanvas & { calls: string[] } {
  const calls: string[] = [];
  const canvas = { width: 0, height: 0, style: { width: "", height: "" }, calls } as PageCanvas & { calls: string[] };
  const ctx = {
    canvas,
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
    setLineDash: noop,
    measureText: (t: string) => ({ width: t.length * 7 }),
    fillText: (t: string) => calls.push(`fillText:${t}`),
  } as unknown as Ctx2D;
  canvas.getContext = () => ctx;
  return canvas;
}

describe("painting the snapshot", () => {
  const previousPath2D = globalThis.Path2D;
  beforeAll(() => {
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
  });
  afterAll(() => {
    globalThis.Path2D = previousPath2D;
  });

  test("sizes each canvas to its page at the device pixel ratio and paints it with no fetch and no WebAssembly", () => {
    const fetches: string[] = [];
    const wasm: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL) => {
      fetches.push(String(input));
      throw new Error("a shared snapshot must not fetch");
    }) as unknown as typeof fetch;
    const api = WebAssembly as unknown as Record<string, unknown>;
    const names = ["instantiate", "compile", "instantiateStreaming", "compileStreaming"];
    const real = new Map(names.map((name) => [name, api[name]]));
    for (const name of names) {
      api[name] = () => {
        wasm.push(name);
        throw new Error("a shared snapshot must not instantiate a module");
      };
    }
    const canvases = [fakeCanvas(), fakeCanvas()];
    try {
      const stats = paintSnapshot(pages, canvases, 2);
      expect(stats).toHaveLength(2);
      for (const s of stats) expect(s.ops).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      for (const [name, value] of real) api[name] = value;
    }
    expect(fetches).toEqual([]);
    expect(wasm).toEqual([]);
    for (const canvas of canvases) {
      // 612 x 792 pt: 816 x 1056 CSS px at 96 dpi, twice that in device pixels.
      expect([canvas.width, canvas.height]).toEqual([1632, 2112]);
      expect([canvas.style.width, canvas.style.height]).toEqual(["816px", "1056px"]);
      expect(canvas.calls).toContain("fillRect");
      expect(canvas.calls).toContain("fill");
    }
    expect(canvases[0]!.calls).toContain("fillText:Hi");
    expect(canvases[1]!.calls).toContain("fillText:Yo");
  });

  test("refuses fewer canvases than pages and a canvas with no 2D context", () => {
    expect(() => paintSnapshot(pages, [fakeCanvas()], 1)).toThrow("the snapshot has 2 pages and 1 canvases");
    const blind: PageCanvas = { width: 0, height: 0, style: { width: "", height: "" }, getContext: () => null };
    expect(() => paintSnapshot(pages.slice(0, 1), [blind], 1)).toThrow("no 2D canvas context");
  });
});
