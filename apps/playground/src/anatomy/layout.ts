/**
 * Pure layout for the anatomy views. No DOM, no Preact: importable from any
 * runtime and covered directly by the tests.
 */
import type { MemberVerdict, PackageDelta, PackageInfo } from "../lab/index.ts";
import { ROLE_ORDER, memberRole, type AnatomyRole } from "./roles.ts";

export type Rect = { x: number; y: number; w: number; h: number };

export type TreemapItem = {
  /** Unique within one layout: the member name, suffixed when a name repeats. */
  key: string;
  name: string;
  role: AnatomyRole;
  /** Compressed bytes. For a removed member, its size before the edit. */
  bytes: number;
  verdict?: MemberVerdict;
};
export type TreemapCell = TreemapItem & Rect;
export type TreemapGroup = Rect & { role: AnatomyRole; bytes: number; cells: TreemapCell[] };
export type TreemapLayout = { width: number; height: number; bytes: number; groups: TreemapGroup[] };
export type TreemapOptions = { delta?: PackageDelta; width?: number; height?: number };

/**
 * Members of `info` with their verdicts from `delta`. Members the delta marks
 * `removed` and `info` no longer holds are appended, sized by their bytes
 * before the edit, so a removal stays visible.
 */
export function treemapItems(info: PackageInfo, delta?: PackageDelta): TreemapItem[] {
  const verdicts = new Map<string, MemberVerdict>();
  for (const v of delta?.verdicts ?? []) verdicts.set(v.name, v.verdict);
  const seen = new Map<string, number>();
  const items: TreemapItem[] = [];
  const push = (name: string, bytes: number, verdict: MemberVerdict | undefined) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    items.push({ key: n === 1 ? name : `${name}#${n}`, name, role: memberRole(name), bytes: size, verdict });
  };
  for (const m of info.members) push(m.name, m.compressedSize, verdicts.get(m.name));
  for (const v of delta?.verdicts ?? []) if (v.verdict === "removed" && !seen.has(v.name)) push(v.name, v.bytesBefore, "removed");
  return items;
}

const byBytesThenName = (a: TreemapItem, b: TreemapItem) =>
  b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Squarified treemap (Bruls, Huizing, van Wijk) of member compressed bytes,
 * two levels deep: role groups, then members inside each group. Every
 * rectangle's area is its share of `width * height`; zero-byte members get a
 * zero-area rectangle. Order is fully determined by bytes, then name.
 */
export function layoutTreemap(info: PackageInfo, options: TreemapOptions = {}): TreemapLayout {
  const width = options.width ?? 100;
  const height = options.height ?? 100;
  const items = treemapItems(info, options.delta).sort(byBytesThenName);
  const byRole = new Map<AnatomyRole, TreemapItem[]>();
  for (const item of items) {
    const list = byRole.get(item.role);
    if (list) list.push(item);
    else byRole.set(item.role, [item]);
  }
  const groups = [...byRole].map(([role, members]) => ({
    role,
    members,
    bytes: members.reduce((sum, m) => sum + m.bytes, 0),
  }));
  groups.sort((a, b) => b.bytes - a.bytes || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const total = groups.reduce((sum, g) => sum + g.bytes, 0);
  const groupRects = squarify(
    groups.map((g) => g.bytes),
    { x: 0, y: 0, w: width, h: height },
  );
  return {
    width,
    height,
    bytes: total,
    groups: groups.map((g, i) => {
      const rect = groupRects[i]!;
      const cellRects = squarify(
        g.members.map((m) => m.bytes),
        rect,
      );
      return { ...rect, role: g.role, bytes: g.bytes, cells: g.members.map((m, j) => ({ ...m, ...cellRects[j]! })) };
    }),
  };
}

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(max: number, min: number, sum: number, side: number): number {
  const s2 = sum * sum;
  const w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/** Squarify `weights` (sorted descending) into `rect`. */
export function squarify(weights: readonly number[], rect: Rect): Rect[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const out: Rect[] = [];
  if (!(total > 0) || !(rect.w > 0) || !(rect.h > 0)) {
    for (let i = 0; i < weights.length; i++) out.push({ x: rect.x, y: rect.y, w: 0, h: 0 });
    return out;
  }
  const scale = (rect.w * rect.h) / total;
  const areas = weights.map((w) => w * scale);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    if (!(areas[i]! > 0)) {
      out.push({ x, y, w: 0, h: 0 });
      i++;
      continue;
    }
    const side = Math.min(w, h);
    let end = i + 1;
    let sum = areas[i]!;
    let best = worst(areas[i]!, areas[i]!, sum, side);
    while (end < areas.length && areas[end]! > 0) {
      const next = sum + areas[end]!;
      const ratio = worst(areas[i]!, areas[end]!, next, side);
      if (ratio > best) break;
      best = ratio;
      sum = next;
      end++;
    }
    const last = end === areas.length || !(areas[end]! > 0);
    if (w >= h) {
      // Column on the left, filling the full height.
      const colW = last ? w : sum / h;
      let cy = y;
      for (let k = i; k < end; k++) {
        const ch = k === end - 1 ? y + h - cy : areas[k]! / colW;
        out.push({ x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      w = Math.max(0, w - colW);
    } else {
      // Row on top, filling the full width.
      const rowH = last ? h : sum / w;
      let cx = x;
      for (let k = i; k < end; k++) {
        const cw = k === end - 1 ? x + w - cx : areas[k]! / rowH;
        out.push({ x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      h = Math.max(0, h - rowH);
    }
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Byte ribbon
// ---------------------------------------------------------------------------

/**
 * One run of bytes in file order. `member` covers a local header and its
 * compressed stream; `structure` is every other byte of the archive (data
 * descriptors, central directory, end record, or anything between members).
 */
export type RibbonSegment =
  | { kind: "member"; start: number; end: number; name: string; verdict?: MemberVerdict }
  | { kind: "structure"; start: number; end: number };

/**
 * Segments covering `[0, info.bytes)` exactly once, in byte order. Member
 * spans are clipped to the file and to the previous member, so overlapping or
 * out-of-range offsets never double-count a byte.
 */
export function ribbonSegments(info: PackageInfo, delta?: PackageDelta): RibbonSegment[] {
  const size = Number.isFinite(info.bytes) && info.bytes > 0 ? info.bytes : 0;
  const verdicts = new Map<string, MemberVerdict>();
  for (const v of delta?.verdicts ?? []) verdicts.set(v.name, v.verdict);
  const members = info.members
    .map((m, index) => ({ m, index }))
    .sort((a, b) => a.m.headerOffset - b.m.headerOffset || a.index - b.index);
  const out: RibbonSegment[] = [];
  let cursor = 0;
  for (const { m } of members) {
    const start = Math.max(cursor, Math.min(size, m.headerOffset));
    const end = Math.min(size, Math.max(m.dataOffset + m.compressedSize, m.headerOffset));
    if (!(end > start)) continue;
    if (start > cursor) out.push({ kind: "structure", start: cursor, end: start });
    const verdict = verdicts.get(m.name);
    out.push(verdict ? { kind: "member", start, end, name: m.name, verdict } : { kind: "member", start, end, name: m.name });
    cursor = end;
  }
  if (size > cursor) out.push({ kind: "structure", start: cursor, end: size });
  return out;
}

/** A member segment whose bytes are not an identical stream of the original. */
export function isChangedSegment(segment: RibbonSegment): boolean {
  return segment.kind === "member" && segment.verdict !== undefined && segment.verdict !== "identical-stream";
}

/** Changed member segments merged where they touch, in byte order. */
export function changedSpans(segments: readonly RibbonSegment[]): { start: number; end: number; members: string[] }[] {
  const spans: { start: number; end: number; members: string[] }[] = [];
  for (const s of segments) {
    if (s.kind !== "member" || !isChangedSegment(s)) continue;
    const prev = spans.at(-1);
    if (prev && prev.end === s.start) {
      prev.end = s.end;
      prev.members.push(s.name);
    } else spans.push({ start: s.start, end: s.end, members: [s.name] });
  }
  return spans;
}
