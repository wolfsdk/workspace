import type { PageInfo } from "@wolfsdk/protocol";

/** Space around the page column and between pages, in CSS pixels (not scaled by zoom). */
export const PAGE_PAD = 24;
export const PAGE_GAP = 16;

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_PRESETS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/** Zoom the shell picks for a newly opened document: fit width, but no larger than this. */
export const INITIAL_ZOOM_CAP = 1.5;

export type FitMode = "width" | "page" | null;

/** Positions of every page box inside the scroller's content, in CSS pixels. */
export type PageLayout = {
  zoom: number;
  tops: number[];
  lefts: number[];
  widths: number[];
  heights: number[];
  contentWidth: number;
  contentHeight: number;
};

export function layoutPages(pages: PageInfo[], zoom: number, viewportWidth: number): PageLayout {
  const widths = pages.map((p) => Math.max(1, Math.round(p.widthPt * zoom)));
  const heights = pages.map((p) => Math.max(1, Math.round(p.heightPt * zoom)));
  const widest = widths.reduce((a, b) => Math.max(a, b), 0);
  const contentWidth = Math.max(viewportWidth, widest + 2 * PAGE_PAD);
  const tops: number[] = [];
  const lefts: number[] = [];
  let y = PAGE_PAD;
  for (let i = 0; i < pages.length; i++) {
    tops.push(y);
    lefts.push(Math.round((contentWidth - widths[i]!) / 2));
    y += heights[i]! + PAGE_GAP;
  }
  const contentHeight = pages.length ? y - PAGE_GAP + PAGE_PAD : 0;
  return { zoom, tops, lefts, widths, heights, contentWidth, contentHeight };
}

/** Index of the page whose box (plus the gap below it) contains content y. */
export function pageIndexAt(layout: PageLayout, y: number): number {
  const { tops } = layout;
  if (!tops.length) return -1;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Next preset above (`direction` 1) or below (-1) the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const eps = 1e-3;
  if (direction > 0) return ZOOM_PRESETS.find((z) => z > zoom + eps) ?? ZOOM_MAX;
  return [...ZOOM_PRESETS].reverse().find((z) => z < zoom - eps) ?? ZOOM_MIN;
}

export function fitWidthZoom(pages: PageInfo[], viewportWidth: number): number {
  const widest = pages.reduce((a, p) => Math.max(a, p.widthPt), 0);
  if (!widest) return 1;
  return clampZoom((viewportWidth - 2 * PAGE_PAD) / widest);
}

export function fitPageZoom(page: PageInfo | undefined, viewportWidth: number, viewportHeight: number): number {
  if (!page) return 1;
  return clampZoom(
    Math.min((viewportWidth - 2 * PAGE_PAD) / page.widthPt, (viewportHeight - 2 * PAGE_PAD) / page.heightPt),
  );
}

/**
 * Scale (image pixels per point) to request for a page. The render made by
 * `open`/`apply` (`PageInfo.dpi`) is free; use it whenever it is at least as
 * sharp as needed. Sharper renders are quantised to quarter steps so small
 * zoom changes reuse the same image, and capped to keep PNGs reasonable.
 */
export function pickScale(page: PageInfo, wanted: number): number {
  const cached = page.dpi / 72;
  if (wanted <= cached) return cached;
  return Math.min(6, Math.ceil(wanted * 4) / 4);
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
