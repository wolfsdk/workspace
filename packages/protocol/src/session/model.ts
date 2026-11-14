import type { Address, Change, DocState, Region } from "../contract.ts";
import type { HistoryEntry } from "./history.ts";
import { decisionDoc, type ChangeType, type Decision, type DecisionDoc } from "./record.ts";

export const CHANGE_TYPES: ChangeType[] = ["added", "modified", "removed", "moved"];

/** Render an engine typed value (`{number}`, `{string}`, `{formula}`, `{text}`, ...) readably. */
export function formatTyped(v: unknown): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v !== "object" || Array.isArray(v)) return JSON.stringify(v);
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length !== 1) return JSON.stringify(v);
  const [k, val] = entries[0]!;
  switch (k) {
    case "empty":
      return "(empty)";
    case "number":
    case "boolean":
      return String(val);
    case "string":
    case "text":
      return JSON.stringify(String(val));
    case "formula": {
      const f = String(val);
      return f.startsWith("=") ? f : "=" + f;
    }
    case "instruction":
      return `field { ${String(val)} }`;
    default:
      return JSON.stringify(v);
  }
}

export function countsByType(changes: Change[]): Record<ChangeType, number> {
  const c: Record<ChangeType, number> = { added: 0, modified: 0, removed: 0, moved: 0 };
  for (const ch of changes) if (ch.change in c) c[ch.change] += 1;
  return c;
}

export function countsText(changes: Change[]): string {
  const c = countsByType(changes);
  const parts = CHANGE_TYPES.filter((t) => c[t] > 0).map((t) => `${c[t]} ${t}`);
  return parts.length ? parts.join(", ") : "no changes";
}

/** 12-hour AM/PM time. */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Base-revision address of a change (`null` for `added`). */
export function beforeAddress(change: Change, addressMap: { before: Address; after: Address }[]): Address | null {
  if (change.change === "added") return null;
  if (change.change === "removed") return change.address;
  if (change.change === "moved") return change.from ?? null;
  return addressMap.find((m) => m.after === change.address)?.before ?? change.address;
}

/** Address of a change in the result revision (`null` for `removed`). */
export function afterAddress(change: Change): Address | null {
  return change.change === "removed" ? null : change.address;
}

/** The changes of an entry, with `cause`, as the engine reported them. */
export const changesOf = (entry: HistoryEntry): Change[] => entry.transaction.diff?.changes ?? entry.diff;

export const addressMapOf = (entry: HistoryEntry) => entry.transaction.address_map ?? [];

export type Side = "before" | "after";

/** Which side of `entry` the current state shows, or null when it is neither. */
export function sideShown(entry: HistoryEntry, state: DocState | null): Side | null {
  if (!state) return null;
  if (state.revision === entry.revision && state.sha256 === entry.resultSha256) return "after";
  if (state.revision === entry.revision - 1 && state.sha256 === entry.baseSha256) return "before";
  return null;
}

/** Address a change occupies on the shown side. */
export function addressOnSide(entry: HistoryEntry, change: Change, side: Side): Address | null {
  return side === "after" ? afterAddress(change) : beforeAddress(change, addressMapOf(entry));
}

export type Box = { index: number; change: Change; address: Address; region: Region };

/** Boxes to draw on `page`: one per (change, matching region). */
export function boxesOnPage(entry: HistoryEntry, side: Side, regions: Region[]): Box[] {
  const out: Box[] = [];
  changesOf(entry).forEach((change, index) => {
    const address = addressOnSide(entry, change, side);
    if (!address) return;
    for (const region of regions) if (region.object_id === address) out.push({ index, change, address, region });
  });
  return out;
}

/** Whether change `index` of `entry` has an outline on any page of `state`: a region carries its
 * address on the shown side. Null while `state` shows neither side of the entry. */
export function outlined(entry: HistoryEntry, index: number, state: DocState | null): boolean | null {
  const side = sideShown(entry, state);
  if (!side) return null;
  const change = changesOf(entry)[index];
  const address = change ? addressOnSide(entry, change, side) : null;
  return address !== null && state!.regions.some((region) => region.object_id === address);
}

/** `[x, y, width, height]` from the page's top-left corner, in one unit (the overlay uses CSS px). */
export type Rect = [number, number, number, number];

/** Indices of `rects` in reading order: top to bottom, then left to right, then in their given
 * order (so the outlines stacked on one object keep the order of their changes). */
export function readingOrder(rects: Rect[]): number[] {
  return rects.map((_, i) => i).sort((a, b) => rects[a]![1] - rects[b]![1] || rects[a]![0] - rects[b]![0] || a - b);
}

/** A tag to place: its box, its text and its rendered size. */
export type TagRequest = { box: Rect; text: string; size: [number, number] };

/** Where one tag goes. `free: false`: the tag would cover other content (or repeats the tag of an
 * identical box, at the same place), so the overlay shows it only on demand. */
export type TagPlacement = { rect: Rect; free: boolean };

/** Edges closer than this count as touching, not overlapping. */
const TOLERANCE = 1;

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > TOLERANCE && h > TOLERANCE ? w * h : 0;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer[0] <= inner[0] + TOLERANCE &&
    outer[1] <= inner[1] + TOLERANCE &&
    outer[0] + outer[2] >= inner[0] + inner[2] - TOLERANCE &&
    outer[1] + outer[3] >= inner[1] + inner[3] - TOLERANCE
  );
}

/** Place one tag per box on a page of `pageSize`. `regions` are every content region of the page,
 * the boxes' own included; a region that contains a box (its own region, its table, sheet or slide)
 * is that box's container and never an obstacle for its tag. Per box, in order, the first candidate
 * that stays on the page and covers no other region and no free tag placed before it wins:
 * above (start, then end aligned), right (top), below (start, end), left (top), right and left
 * (bottom aligned). A box with no such candidate gets the on-page candidate covering the least
 * area, or, when none fits on the page (a box that fills the page), its own top-left inner corner;
 * both with `free: false`. A box equal to an earlier one with the same text (several changes of
 * one object) shares that tag's place with `free: false`, so the page shows the text once. */
export function placeTags(tags: TagRequest[], regions: Rect[], pageSize: [number, number]): TagPlacement[] {
  const [pw, ph] = pageSize;
  const freeTags: Rect[] = [];
  const placed = new Map<string, Rect>();
  return tags.map(({ box, text, size: [w, h] }): TagPlacement => {
    const key = `${text} ${box.join(",")}`;
    const shared = placed.get(key);
    if (shared) return { rect: shared, free: false };
    const [x, y, bw, bh] = box;
    const obstacles = regions.filter((r) => !contains(r, box)).concat(freeTags);
    const corners: [number, number][] = [
      [x, y - h],
      [x + bw - w, y - h],
      [x + bw, y],
      [x, y + bh],
      [x + bw - w, y + bh],
      [x - w, y],
      [x + bw, y + bh - h],
      [x - w, y + bh - h],
    ];
    let best: Rect | null = null;
    let bestCost = Infinity;
    for (const [cx, cy] of corners) {
      if (cx < 0 || cy < 0 || cx + w > pw || cy + h > ph) continue;
      const c: Rect = [cx, cy, w, h];
      let cost = 0;
      for (const o of obstacles) cost += overlapArea(c, o);
      if (cost === 0) {
        freeTags.push(c);
        placed.set(key, c);
        return { rect: c, free: true };
      }
      if (cost < bestCost) [best, bestCost] = [c, cost];
    }
    const rect: Rect = best ?? [Math.max(0, Math.min(x, pw - w)), Math.max(0, Math.min(y, ph - h)), w, h];
    placed.set(key, rect);
    return { rect, free: false };
  });
}

export const entryKey = (e: HistoryEntry): string => `${e.revision}:${e.resultSha256}`;

/** One `wolfsuite.review-decision.v1` document for a history entry. Each change
 * carries the decision of the hunk that owns it (`changeDecision`, default: the
 * entry decision). `seen` holds object ids of regions observed per revision sha
 * (a side never visited reports null). */
export async function entryDecisionDoc(args: {
  entry: HistoryEntry;
  decision: Decision;
  changeDecision?: (index: number) => Decision;
  docName: string;
  seen: Map<string, Set<string>>;
  decidedAt: number;
}): Promise<DecisionDoc> {
  const { entry, decision, changeDecision, docName, seen, decidedAt } = args;
  const changes = changesOf(entry);
  const map = addressMapOf(entry);
  return decisionDoc({
    receiptPath: `wolf-review:${docName}#revision-${entry.revision}`,
    baseSha256: entry.baseSha256,
    resultSha256: entry.resultSha256,
    changes,
    diffIdentity: entry.transaction.diff?.identity ?? "",
    decision,
    changeDecision,
    regions: (index) => {
      const b = beforeAddress(changes[index]!, map);
      const a = afterAddress(changes[index]!);
      return {
        before: b && seen.get(entry.baseSha256)?.has(b) ? b : null,
        after: a && seen.get(entry.resultSha256)?.has(a) ? a : null,
      };
    },
    decidedAt,
  });
}
