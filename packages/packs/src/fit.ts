// The fit model of a pack. A pack must give the same answer on every machine, so "does this text fit" is a
// formula and not a font measurement: an average character is half an em wide, a line is 1.2 em tall, a line
// breaks wherever the box is full (words are not kept whole) and at every newline. The formula is
// conservative for proportional text and exact for nothing; what it promises is determinism.
import { PackError } from "./errors.ts";

export const AVERAGE_CHARACTER_EM = 0.5;
export const LINE_HEIGHT_EM = 1.2;
/** The smallest size `shrink_to_fit` goes down to, in points. */
export const MINIMUM_SHRUNK_POINTS = 10;
export const ELLIPSIS = "\u2026";

/** The text area of a target: its width, and its height or `null` for exactly one line. */
export type Box = { widthPt: number; heightPt: number | null };

const length = (text: string): number => [...text].length;

export function charactersPerLine(sizePt: number, box: Box): number {
  return Math.floor(box.widthPt / (AVERAGE_CHARACTER_EM * sizePt));
}

export function lineCapacity(sizePt: number, box: Box): number {
  return box.heightPt === null ? 1 : Math.floor(box.heightPt / (LINE_HEIGHT_EM * sizePt));
}

/** Lines `text` needs at `sizePt` in `box`; `Infinity` when not even one character fits a line. */
export function linesNeeded(text: string, sizePt: number, box: Box): number {
  const perLine = charactersPerLine(sizePt, box);
  if (perLine < 1) return text === "" ? 1 : Number.POSITIVE_INFINITY;
  return text.split(/\r\n|\n|\r/).reduce((sum, line) => sum + Math.max(1, Math.ceil(length(line) / perLine)), 0);
}

export function fits(text: string, sizePt: number, box: Box): boolean {
  return linesNeeded(text, sizePt, box) <= lineCapacity(sizePt, box);
}

/** The longest prefix of `text` that, with an ellipsis, fits; `null` when not even the ellipsis fits. */
export function truncateToFit(text: string, sizePt: number, box: Box): string | null {
  if (fits(text, sizePt, box)) return text;
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, middle).join("") + ELLIPSIS, sizePt, box)) low = middle;
    else high = middle - 1;
  }
  const cut = characters.slice(0, low).join("") + ELLIPSIS;
  return fits(cut, sizePt, box) ? cut : null;
}

/** The largest size not above `currentPt` at which `text` fits: `currentPt` itself, else whole points down to
 * the minimum; `null` when it fits at none. */
export function shrinkedSize(text: string, currentPt: number, box: Box): number | null {
  if (fits(text, currentPt, box)) return currentPt;
  for (let size = Math.ceil(currentPt) - 1; size >= MINIMUM_SHRUNK_POINTS; size--) {
    if (fits(text, size, box)) return size;
  }
  return null;
}

export function doesNotFit(what: string, text: string): PackError {
  const shown = length(text) > 40 ? `${[...text].slice(0, 40).join("")}${ELLIPSIS}` : text;
  return new PackError("text-does-not-fit", `${JSON.stringify(shown)} does not fit ${what}`);
}
