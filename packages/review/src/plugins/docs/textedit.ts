/**
 * Turn "paragraph text went from `base` to `next`" into the smallest engine
 * edit: one `splice-text` over the changed characters, which keeps every run,
 * link and picture outside them.
 */
import type { Op } from "@wolfsdk/protocol";
import type { Para } from "./addresses.ts";
import { cleanText, scalarOffset, spliceText, type Track } from "./ops.ts";

/** The view cuts long text with U+2026; such a paragraph cannot be edited from its view text. */
export function textIsComplete(para: Para): boolean {
  const text = para.node.text ?? "";
  if (!text.endsWith("\u2026")) return true;
  return para.runs.map((r) => r.text ?? "").join("") === text;
}

/** The view text equals `full`, or is `full` cut with U+2026 (long paragraphs). */
export function sameStoredText(view: string, full: string): boolean {
  if (view === full) return true;
  return view.endsWith("\u2026") && view.length < full.length && full.startsWith(view.slice(0, -1));
}

/** The changed stretch: base[start, end) became `text` (UTF-16 offsets). */
export function changedRange(base: string, next: string): { start: number; end: number; text: string } {
  let p = 0;
  while (p < base.length && p < next.length && base[p] === next[p]) p++;
  // Do not cut a surrogate pair.
  if (p > 0 && /[\uD800-\uDBFF]/.test(base[p - 1]!)) p--;
  let s = 0;
  while (s < base.length - p && s < next.length - p && base[base.length - 1 - s] === next[next.length - 1 - s]) s++;
  if (s > 0 && /[\uDC00-\uDFFF]/.test(base[base.length - s]!)) s--;
  return { start: p, end: base.length - s, text: next.slice(p, next.length - s) };
}

/** One `splice-text` for the change, or null when nothing changed. */
export function spliceOps(para: Para, base: string, nextRaw: string, track: Track | null): Op[] | null {
  const next = cleanText(nextRaw);
  if (next === base) return null;
  const { start, end, text } = changedRange(base, next);
  return [spliceText(para.id, scalarOffset(base, start), scalarOffset(base, end), text, track)];
}
