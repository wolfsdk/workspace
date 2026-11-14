/** Pure geometry for direct manipulation: snapping, resizing, scaling a
 * multi-selection. Points throughout. */
import type { Box } from "./model.ts";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Handles that change the box origin (need shape `move`). */
export const ORIGIN_HANDLES: Record<Handle, boolean> = {
  nw: true,
  n: true,
  ne: true,
  e: false,
  se: false,
  s: false,
  sw: true,
  w: true,
};

export type SnapTargets = { x: number[]; y: number[] };

/** Slide edges and centre plus the edges and centres of other shapes. */
export function snapTargets(slideW: number, slideH: number, others: Box[]): SnapTargets {
  const x = [0, slideW / 2, slideW];
  const y = [0, slideH / 2, slideH];
  for (const b of others) {
    x.push(b.x, b.x + b.w / 2, b.x + b.w);
    y.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { x, y };
}

/** Best correction bringing one of `edges` onto a target within `tolerance`. */
function snapAxis(edges: number[], targets: number[], tolerance: number): { delta: number; at: number[] } {
  let best = Infinity;
  let delta = 0;
  for (const e of edges)
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) < Math.abs(best) && Math.abs(d) <= tolerance) {
        best = d;
        delta = d;
      }
    }
  if (best === Infinity) return { delta: 0, at: [] };
  const at = [...new Set(edges.map((e) => e + delta).filter((v) => targets.some((t) => Math.abs(t - v) < 0.01)))];
  return { delta, at };
}

/** Snap a moved box; returns the corrected box and guide positions. */
export function snapMove(box: Box, targets: SnapTargets, tolerance: number): { box: Box; guides: SnapTargets } {
  const sx = snapAxis([box.x, box.x + box.w / 2, box.x + box.w], targets.x, tolerance);
  const sy = snapAxis([box.y, box.y + box.h / 2, box.y + box.h], targets.y, tolerance);
  return { box: { ...box, x: box.x + sx.delta, y: box.y + sy.delta }, guides: { x: sx.at, y: sy.at } };
}

const MIN = 4;

/**
 * Resize `start` by dragging `handle` by (dx, dy); moving edges snap to
 * `targets`; `keepRatio` holds the aspect ratio on corner handles.
 */
export function resizeBox(
  start: Box,
  handle: Handle,
  dx: number,
  dy: number,
  targets: SnapTargets | null,
  tolerance: number,
  keepRatio: boolean,
): { box: Box; guides: SnapTargets } {
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  const guides: SnapTargets = { x: [], y: [] };
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  if (west) x0 += dx;
  if (east) x1 += dx;
  if (north) y0 += dy;
  if (south) y1 += dy;
  if (targets) {
    if (west || east) {
      const s = snapAxis([west ? x0 : x1], targets.x, tolerance);
      if (west) x0 += s.delta;
      else x1 += s.delta;
      guides.x = s.at;
    }
    if (north || south) {
      const s = snapAxis([north ? y0 : y1], targets.y, tolerance);
      if (north) y0 += s.delta;
      else y1 += s.delta;
      guides.y = s.at;
    }
  }
  if (x1 - x0 < MIN) west ? (x0 = x1 - MIN) : (x1 = x0 + MIN);
  if (y1 - y0 < MIN) north ? (y0 = y1 - MIN) : (y1 = y0 + MIN);
  if (keepRatio && (west || east) && (north || south) && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w / h > ratio) {
      const nh = w / ratio;
      north ? (y0 = y1 - nh) : (y1 = y0 + nh);
    } else {
      const nw = h * ratio;
      west ? (x0 = x1 - nw) : (x1 = x0 + nw);
    }
    guides.x = [];
    guides.y = [];
  }
  return { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, guides };
}

/** Map `box` from the frame `from` into the frame `to` (multi-selection resize). */
export function remap(box: Box, from: Box, to: Box): Box {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (box.x - from.x) * sx, y: to.y + (box.y - from.y) * sy, w: box.w * sx, h: box.h * sy };
}
