// The three hooks an embedder plugs in: a reader and a renderer backed by engine workers (here a scripted
// worker, so what the server sends the engine is what the test checks), and a pack refresher.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactorPipeRequest } from "@wolfsdk/protocol/workspace";
import type { EngineWorker } from "@wolfsdk/server";
import {
  MAX_VISUAL_PAGES,
  PackRefreshError,
  engineInspector,
  engineRenderer,
  type PackRefreshRequest,
  type PackRefresher,
  type VisualRenderer,
} from "../src/index.ts";
import type { EnginePool } from "../src/engine.ts";
import { alice, callTool, dataOf, disposeAll, listen, makeWorkspace, must, openSession, robot, toolErrorOf } from "./fixtures/workspace.ts";

afterEach(disposeAll);

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const DETERMINISM = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 };

type Script = {
  pages?: number;
  /** What `extract` returns as a text file, by suffix. */
  extracted?: Partial<Record<".txt" | ".md", string>>;
  /** Make `close` fail, so the worker must be thrown away. */
  badClose?: boolean;
  refuse?: { cmd: ReactorPipeRequest["cmd"]; code: string; message: string };
};

/** A pool of one scripted worker that records what it was asked. */
function scriptedPool(script: Script = {}) {
  const asked: ReactorPipeRequest[] = [];
  const opened: Uint8Array[] = [];
  const discarded: number[] = [];
  const worker: EngineWorker = {
    discard: () => void discarded.push(1),
    async call(req, segments = []) {
      asked.push(req);
      const refusal = script.refuse;
      if (refusal && refusal.cmd === req.cmd) return { body: { cmd: req.cmd, ok: false, ms: 0, error: { code: refusal.code, message: refusal.message } }, segments: [] } as never;
      switch (req.cmd) {
        case "open": {
          const bytes = segments[req.bytes.bin] as Uint8Array;
          opened.push(bytes);
          return { body: { cmd: "open", ok: true, ms: 0, doc: 7, format: req.format, sha256: sha256(bytes), bytes: bytes.length, revision: 0, determinism: DETERMINISM }, segments: [] } as never;
        }
        case "close":
          return { body: { cmd: "close", ok: !script.badClose, ms: 0, doc: req.doc }, segments: [] } as never;
        case "extract": {
          const what = req.options?.what?.[0];
          const suffix = what === "markdown" ? ".md" : ".txt";
          const text = script.extracted?.[suffix];
          if (text === undefined) return { body: { cmd: "extract", ok: true, ms: 0, receipt: {}, outputs: [] }, segments: [] } as never;
          return { body: { cmd: "extract", ok: true, ms: 0, receipt: {}, outputs: [{ path: `out/doc${suffix}`, data: { bin: 0, len: text.length } }] }, segments: [new TextEncoder().encode(text)] } as never;
        }
        case "layout":
          return { body: { cmd: "layout", ok: true, ms: 0, cached: false, layout_ms: 0, summary: { format: "docx", pages: script.pages ?? 3, determinism: DETERMINISM }, page_hashes: [] }, segments: [] } as never;
        case "render_page_png":
          return { body: { cmd: "render_page_png", ok: true, ms: 0, page: req.page, size_pt: [612, 792], pixel_size: [816, 1056], layout_cached: true, png: { bin: 0, len: PNG.length } }, segments: [PNG] } as never;
        default:
          throw new Error(`unexpected command ${req.cmd}`);
      }
    },
  };
  const pool: EnginePool = { withWorker: (job) => job(worker) };
  return { pool, asked, opened, discarded };
}

describe("engineInspector", () => {
  test("reads whole-document text and markdown through the engine's extractor", async () => {
    const { pool, asked, opened } = scriptedPool({ extracted: { ".txt": "FROM THE ENGINE", ".md": "# From the engine" } });
    const workspace = await makeWorkspace({ inspector: engineInspector(pool) });
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" })).text).toBe("FROM THE ENGINE");
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "markdown" })).markdown).toBe("# From the engine");
    expect(asked.map((r) => r.cmd)).toEqual(["open", "extract", "close", "open", "extract", "close"]);
    expect(asked[1]).toMatchObject({ cmd: "extract", doc: 7, options: { what: ["text"] } });
    expect(asked[4]).toMatchObject({ cmd: "extract", options: { what: ["markdown"] } });
    expect(opened[0]?.length).toBeGreaterThan(100);
  });

  test("declines what it can not read better, so the built-in reader answers", async () => {
    const { pool, asked } = scriptedPool({ extracted: { ".txt": "FROM THE ENGINE" } });
    const workspace = await makeWorkspace({ inspector: engineInspector(pool) });
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx" })).view).toBe("structure");
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text", target: "para:@2" })).text).toBe("Revenue grew in Q3.");
    expect(dataOf(await callTool(session, "doc_read", { doc: "model.xlsx", view: "cells" })).view).toBe("cells");
    expect(asked).toEqual([]);
  });

  test("falls back to the built-in reader when the engine has nothing to say", async () => {
    const { pool } = scriptedPool({ extracted: {} });
    const workspace = await makeWorkspace({ inspector: engineInspector(pool) });
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" })).text).toContain("Revenue grew in Q3.");
  });

  test("an engine refusal is a BAD_REQUEST that names the engine's code", async () => {
    const { pool } = scriptedPool({ refuse: { cmd: "extract", code: "unsupported", message: "no extractor" } });
    const workspace = await makeWorkspace({ inspector: engineInspector(pool) });
    const session = await openSession(workspace.mcp);
    expect(toolErrorOf(await callTool(session, "doc_read", { doc: "brief.docx", view: "text" }))).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "unsupported" } });
  });

  test("a worker that can not close the document is not reused", async () => {
    const { pool, discarded } = scriptedPool({ extracted: { ".txt": "x" }, badClose: true });
    const workspace = await makeWorkspace({ inspector: engineInspector(pool) });
    const session = await openSession(workspace.mcp);
    await callTool(session, "doc_read", { doc: "brief.docx", view: "text" });
    expect(discarded).toEqual([1]);
  });
});

describe("doc_inspect_visual", () => {
  async function visual(script: Script = {}) {
    const scripted = scriptedPool(script);
    const workspace = await makeWorkspace({ renderer: engineRenderer(scripted.pool) });
    return { ...scripted, workspace, session: await openSession(workspace.mcp) };
  }

  test("returns the page as an image after the text that describes it", async () => {
    const { session, asked } = await visual();
    const result = await callTool(session, "doc_inspect_visual", { doc: "brief.docx" });
    expect(result.content.map((b) => b.type)).toEqual(["text", "image"]);
    const image = result.content[1];
    expect(image).toEqual({ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
    const data = dataOf(result);
    expect(data).toMatchObject({ doc: "brief.docx", revision: 0, page_count: 3, dpi: 96, preflight: false });
    expect(data.pages).toEqual([{ page: 1, size_pt: [612, 792], pixel_size: [816, 1056], estimated_image_tokens: Math.ceil((816 * 1056) / 750) }]);
    expect(data.estimated_image_tokens).toBe(Math.ceil((816 * 1056) / 750));
    expect(asked.find((r) => r.cmd === "render_page_png")).toMatchObject({ page: 1, scale: 96 / 72 });
  });

  test("several pages come as several images, in the order asked, each at the dpi asked", async () => {
    const { session, asked } = await visual();
    const result = await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages: [3, 1, 3], dpi: 150 });
    expect(result.content.map((b) => b.type)).toEqual(["text", "image", "image"]);
    expect((dataOf(result).pages as { page: number }[]).map((p) => p.page)).toEqual([3, 1]);
    const scales = asked.filter((r) => r.cmd === "render_page_png").map((r) => (r as { scale: number }).scale);
    expect(scales).toEqual([150 / 72, 150 / 72]);
  });

  test("a preflight measures the pages and sends no image", async () => {
    const { session, asked } = await visual();
    const result = await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages: [1, 2], preflight: true });
    expect(result.content.map((b) => b.type)).toEqual(["text"]);
    expect(dataOf(result)).toMatchObject({ preflight: true, page_count: 3 });
    expect(asked.filter((r) => r.cmd === "render_page_png").every((r) => (r as { scale: number }).scale === 0.1)).toBe(true);
  });

  test("a page the document does not have is BAD_REQUEST with the page count", async () => {
    const { session } = await visual({ pages: 2 });
    const error = toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages: [3] }));
    expect(error).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "page-out-of-range", page: 3, page_count: 2 } });
  });

  test("more pages than one call may draw is refused before anything is drawn", async () => {
    const { session, asked } = await visual({ pages: 20 });
    const pages = Array.from({ length: MAX_VISUAL_PAGES + 1 }, (_, i) => i + 1);
    const error = toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(asked).toEqual([]);
    const eight = await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages: pages.slice(0, MAX_VISUAL_PAGES) });
    expect(eight.content).toHaveLength(1 + MAX_VISUAL_PAGES);
  });

  test("draws the preview of a proposal, not the head", async () => {
    const { session, workspace, opened } = await visual();
    const proposed = dataOf(await callTool(session, "doc_edit", { doc: "brief.docx", base_revision: 0, mode: "propose", ops: [{ op: "append_paragraph", text: "Proposed" }] }));
    const preview = await callTool(session, "doc_inspect_visual", { doc: "brief.docx", proposal_id: proposed.proposal_id });
    expect(dataOf(preview)).toMatchObject({ proposal_id: proposed.proposal_id, base_revision: 0 });
    expect(sha256(opened.at(-1) as Uint8Array)).toBe(proposed.preview_sha256 as string);
    const head = must(await workspace.room.readHead("room", alice, "brief.docx"));
    expect(sha256(head.bytes)).not.toBe(proposed.preview_sha256 as string);
    expect(toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "model.xlsx", proposal_id: proposed.proposal_id })).detail).toEqual({ reason: "proposal-document" });
    expect(toolErrorOf(await callTool(session, "doc_inspect_visual", { doc: "brief.docx", proposal_id: "nope" })).code).toBe("UNKNOWN_PROPOSAL");
  });

  test("announces inspecting while it draws", async () => {
    const { session, workspace } = await visual();
    const events = await listen(workspace);
    await callTool(session, "doc_inspect_visual", { doc: "brief.docx" });
    expect(events.flatMap((e) => (e.type === "agent.activity" ? [e.activity] : []))).toEqual(["inspecting", "idle"]);
  });

  test("a renderer of the embedder's own is called with the request the tool built", async () => {
    const seen: unknown[] = [];
    const renderer: VisualRenderer = {
      async inspect(req) {
        seen.push({ format: req.format, name: req.name, pages: req.pages, dpi: req.dpi, preflight: req.preflight });
        return { page_count: 1, pages: [{ page: 1, size_pt: [100, 100], png: PNG }] };
      },
    };
    const workspace = await makeWorkspace({ renderer });
    const session = await openSession(workspace.mcp);
    const result = await callTool(session, "doc_inspect_visual", { doc: "brief.docx", pages: [1], dpi: 72 });
    expect(seen).toEqual([{ format: "docx", name: "brief.docx", pages: [1], dpi: 72, preflight: false }]);
    expect(dataOf(result).pages).toEqual([{ page: 1, size_pt: [100, 100], pixel_size: [100, 100], estimated_image_tokens: Math.ceil(10000 / 750) }]);
  });
});

describe("pack_link_refresh", () => {
  function refresher(calls: PackRefreshRequest[]): PackRefresher {
    return {
      async listPacks() {
        return [{ pack: "kpis", bindings: ["revenue", "costs"], title: "Quarterly KPIs" }];
      },
      async refreshPack(req) {
        calls.push(req);
        if (req.pack !== "kpis") throw new PackRefreshError(`no pack ${req.pack}`);
        await req.report("recalculating");
        return {
          pack: req.pack,
          mode: req.mode,
          bindings: [
            { binding: "revenue", status: "updated", doc: "brief.docx", revision: 1 },
            { binding: "costs", status: "unchanged" },
            { binding: "tax", status: "failed", message: "no source" },
          ],
        };
      },
    };
  }

  test("hands the room service, the actor and the request to the refresher, and summarises its answer", async () => {
    const calls: PackRefreshRequest[] = [];
    const workspace = await makeWorkspace({ packs: refresher(calls) });
    const session = await openSession(workspace.mcp);
    const events = await listen(workspace);
    const data = dataOf(await callTool(session, "pack_link_refresh", { pack: "kpis", bindings: ["revenue", "tax"] }));
    expect(data).toMatchObject({ pack: "kpis", mode: "propose", updated: 1, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ roomId: "room", pack: "kpis", bindings: ["revenue", "tax"], mode: "propose", actor: robot });
    expect(calls[0]?.roomService).toBe(workspace.room);
    const activity = events.flatMap((e) => (e.type === "agent.activity" ? [[e.activity, e.detail ?? null]] : []));
    expect(activity).toEqual([["proposing", "refresh kpis"], ["proposing", "recalculating"], ["idle", null]]);
  });

  test("commit mode and all bindings by default", async () => {
    const calls: PackRefreshRequest[] = [];
    const workspace = await makeWorkspace({ packs: refresher(calls) });
    const session = await openSession(workspace.mcp);
    await callTool(session, "pack_link_refresh", { pack: "kpis", mode: "commit" });
    expect(calls[0]).toMatchObject({ mode: "commit", bindings: undefined });
  });

  test("a pack that does not exist is BAD_REQUEST", async () => {
    const workspace = await makeWorkspace({ packs: refresher([]) });
    const session = await openSession(workspace.mcp);
    const error = toolErrorOf(await callTool(session, "pack_link_refresh", { pack: "ghost" }));
    expect(error).toMatchObject({ code: "BAD_REQUEST", detail: { reason: "pack-refresh" } });
    expect(error.message).toBe("no pack ghost");
  });

  test("workspace_list names the packs the refresher knows", async () => {
    const workspace = await makeWorkspace({ packs: refresher([]) });
    const session = await openSession(workspace.mcp);
    expect(dataOf(await callTool(session, "workspace_list")).packs).toEqual([{ pack: "kpis", bindings: ["revenue", "costs"], title: "Quarterly KPIs" }]);
  });

  test("a refresher that breaks is INTERNAL, and the agent still goes idle", async () => {
    const packs: PackRefresher = {
      async refreshPack() {
        throw new Error("source offline");
      },
    };
    const workspace = await makeWorkspace({ packs });
    const session = await openSession(workspace.mcp);
    const events = await listen(workspace);
    expect(toolErrorOf(await callTool(session, "pack_link_refresh", { pack: "kpis" }))).toMatchObject({ code: "INTERNAL", message: "source offline" });
    expect(events.flatMap((e) => (e.type === "agent.activity" ? [e.activity] : [])).at(-1)).toBe("idle");
    expect(alice.kind).toBe("user");
  });
});
