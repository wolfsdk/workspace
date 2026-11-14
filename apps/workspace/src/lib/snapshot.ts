// A shared-link snapshot on the page: the server's display-list pages painted onto `<canvas>` elements by the vector
// renderer alone. Nothing here fetches an engine or instantiates a module.
import { type Ctx2D, type Page, type RenderOptions, type RenderStats, renderDisplayListSnapshot, SNAPSHOT_PX_PER_PT, SNAPSHOT_RENDER, snapshotCanvasSize } from "./room-client.ts";

/** The part of a `<canvas>` the painter uses; a test passes a fake. */
export type PageCanvas = {
  width: number;
  height: number;
  style: { width: string; height: string };
  getContext(contextId: "2d"): Ctx2D | null;
};

/** Paint `pages` onto `canvases`, one canvas per page in page order. Each canvas gets a backing store of `pixelRatio`
 * device pixels per CSS pixel and the CSS size of the page at 96 dpi, so the page stays sharp on a dense screen. */
export function paintSnapshot(pages: readonly Page[], canvases: readonly PageCanvas[], pixelRatio: number): RenderStats[] {
  if (canvases.length < pages.length) throw new Error(`the snapshot has ${pages.length} pages and ${canvases.length} canvases`);
  const options: RenderOptions = { ...SNAPSHOT_RENDER, pxPerPt: SNAPSHOT_PX_PER_PT * pixelRatio };
  let next = 0;
  return renderDisplayListSnapshot(
    pages,
    (page) => {
      const canvas = canvases[next++]!;
      const size = snapshotCanvasSize(page, options);
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.style.width = `${Math.round(page.width * SNAPSHOT_PX_PER_PT)}px`;
      canvas.style.height = `${Math.round(page.height * SNAPSHOT_PX_PER_PT)}px`;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("this browser gave no 2D canvas context");
      return ctx;
    },
    options,
  );
}
