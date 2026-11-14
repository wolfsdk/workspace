// A `VisualRenderer` backed by engine workers: `layout` counts the pages and `render_page_png` draws each one
// at `dpi / 72` of its natural size. A preflight draws at a tenth of that scale, because the engine reports a
// page's size only with a rendering, and keeps the pixels to itself.
import { EngineFault } from "@wolfsdk/server";
import { ask, type EnginePool, withOpenDocument } from "./engine.ts";
import { type VisualPage, VisualPageError, type VisualRenderer, type VisualRequest, type VisualResult } from "./hooks.ts";

const PREFLIGHT_SCALE = 0.1;

export function engineRenderer(pool: EnginePool): VisualRenderer {
  return {
    inspect(request: VisualRequest): Promise<VisualResult> {
      return withOpenDocument(pool, request, async (worker, doc) => {
        const layout = await ask(worker, { cmd: "layout", doc });
        const pageCount = layout.body.summary.pages;
        for (const page of request.pages) if (page > pageCount) throw new VisualPageError(page, pageCount);
        const pages: VisualPage[] = [];
        for (const page of request.pages) {
          const scale = request.preflight ? PREFLIGHT_SCALE : request.dpi / 72;
          const { body, segments } = await ask(worker, { cmd: "render_page_png", doc, page, scale });
          const entry: VisualPage = { page, size_pt: body.size_pt };
          if (!request.preflight) {
            const png = segments[body.png.bin];
            if (!png) throw new EngineFault(`render_page_png of page ${page} has no png segment`);
            entry.png = png;
            if (body.pixel_size) entry.pixel_size = body.pixel_size;
          }
          pages.push(entry);
        }
        return { page_count: pageCount, pages };
      });
    },
  };
}
