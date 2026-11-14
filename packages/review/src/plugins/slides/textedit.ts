/**
 * Plain-text editing helpers for the caret editor: grapheme and word
 * boundaries (`Intl.Segmenter`), paragraph bounds, and the single-span
 * difference between two texts used to map offsets across an edit. Offsets
 * are UTF-16 code units, the unit of the engine's source offsets.
 */

/** Paragraph separator in a shape or cell text, as observe reports it. */
export const PARAGRAPH = "\n";
/** Line break inside a paragraph (`<a:br/>`), docs/engine-ops-pptx.md. */
export const LINE_BREAK = "\u000b";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** Grapheme boundaries of `text`, 0 and `text.length` included. */
function graphemeStops(text: string): number[] {
  const stops = [...graphemes.segment(text)].map((s) => s.index);
  stops.push(text.length);
  return stops;
}

export function nextGrapheme(text: string, offset: number): number {
  for (const stop of graphemeStops(text)) if (stop > offset) return stop;
  return text.length;
}

export function prevGrapheme(text: string, offset: number): number {
  let last = 0;
  for (const stop of graphemeStops(text)) {
    if (stop >= offset) break;
    last = stop;
  }
  return last;
}

type Word = { start: number; end: number };

function wordSpans(text: string): Word[] {
  const out: Word[] = [];
  for (const s of words.segment(text)) if (s.isWordLike) out.push({ start: s.index, end: s.index + s.segment.length });
  return out;
}

/** Start of the word before `offset` (Alt/Ctrl+Left); 0 when none. */
export function wordLeft(text: string, offset: number): number {
  let best = 0;
  for (const w of wordSpans(text)) if (w.start < offset) best = w.start;
  return best;
}

/**
 * Alt/Ctrl+Right: the end of the next word on macOS, the start of the next
 * word elsewhere (the platforms' own conventions); the text end when none.
 */
export function wordRight(text: string, offset: number, toEnd: boolean): number {
  for (const w of wordSpans(text)) {
    if (toEnd && w.end > offset) return w.end;
    if (!toEnd && w.start > offset) return w.start;
  }
  return text.length;
}

/** The word (or other segment) under `offset`, for a double-click. */
export function wordAt(text: string, offset: number): Word {
  let fallback: Word | null = null;
  for (const s of words.segment(text)) {
    const span = { start: s.index, end: s.index + s.segment.length };
    if (offset >= span.start && offset < span.end) return s.isWordLike || !fallback ? span : fallback;
    if (offset === span.end && s.isWordLike) fallback = span;
  }
  return fallback ?? { start: offset, end: offset };
}

/** Bounds of the paragraph holding `offset` (without its separator). */
export function paragraphAt(text: string, offset: number): Word {
  const start = text.lastIndexOf(PARAGRAPH, offset - 1) + 1;
  const next = text.indexOf(PARAGRAPH, offset);
  return { start, end: next < 0 ? text.length : next };
}

/** `before` and `after` differ only in `[start, endBefore)` -> `[start, endAfter)`. */
export type Span = { start: number; endBefore: number; endAfter: number };

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Common head and tail of two texts, never splitting a surrogate pair.
 * `hint` (the caret in `after`) places an ambiguous pure insertion or
 * deletion: a second "l" typed after "Hel" in "Hello" is at the caret, not
 * after the existing "l". */
export function textDiff(before: string, after: string, hint?: number): Span {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  let start = p;
  let endBefore = before.length - s;
  let endAfter = after.length - s;
  if (hint !== undefined && endBefore === start) {
    // Pure insertion: slide left through equal characters to end at the hint.
    while (endAfter > hint && start > 0 && after.charCodeAt(start - 1) === after.charCodeAt(endAfter - 1)) {
      start--;
      endBefore--;
      endAfter--;
    }
  } else if (hint !== undefined && endAfter === start) {
    // Pure deletion: slide left to start at the hint.
    while (start > hint && before.charCodeAt(start - 1) === before.charCodeAt(endBefore - 1)) {
      start--;
      endBefore--;
      endAfter--;
    }
  }
  while (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  while (endBefore < before.length && isLow(before.charCodeAt(endBefore))) {
    endBefore++;
    endAfter++;
  }
  return { start, endBefore, endAfter };
}

/** Where `offset` in `before` lands in `after`: unchanged ahead of the span,
 * shifted behind it, the end of the new text inside it. */
export function mapForward(span: Span, offset: number): number {
  if (offset <= span.start) return offset;
  if (offset >= span.endBefore) return offset + span.endAfter - span.endBefore;
  return span.endAfter;
}

/** Inverse of `mapForward` for offsets of `after`; inside the new text: null. */
export function mapBack(span: Span, offset: number): number | null {
  if (offset <= span.start) return offset;
  if (offset >= span.endAfter) return offset - span.endAfter + span.endBefore;
  return null;
}

/** Plain text for the clipboard: line breaks become newlines. */
export function clipboardText(text: string): string {
  return text.replaceAll(LINE_BREAK, "\n");
}

/** Clipboard text to insert: CRLF/CR to paragraph separators, other control
 * characters except tab dropped. */
export function pastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000c-\u001f\u007f]/g, "");
}
