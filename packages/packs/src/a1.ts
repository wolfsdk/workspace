// A1 references: columns as letters, rows as numbers, `$` anchors ignored.
import { PackError } from "./errors.ts";

export type CellAddress = { column: number; row: number };
export type RangeAddress = { from: CellAddress; to: CellAddress };

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(column: number): string {
  let n = column;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseCell(ref: string): CellAddress {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) throw new PackError("bad-reference", `${JSON.stringify(ref)} is not a cell reference`);
  return { column: columnNumber(m[1] ?? ""), row: Number(m[2]) };
}

/** `A1` or `A1:C3`; a single cell is a range of one. */
export function parseRange(ref: string): RangeAddress {
  const [a, b, extra] = ref.split(":");
  if (a === undefined || extra !== undefined) throw new PackError("bad-reference", `${JSON.stringify(ref)} is not a range reference`);
  const from = parseCell(a);
  const to = parseCell(b ?? a);
  return {
    from: { column: Math.min(from.column, to.column), row: Math.min(from.row, to.row) },
    to: { column: Math.max(from.column, to.column), row: Math.max(from.row, to.row) },
  };
}

export const cellName = (a: CellAddress): string => `${columnLetters(a.column)}${a.row}`;

export function rangeName(r: RangeAddress): string {
  return r.from.column === r.to.column && r.from.row === r.to.row ? cellName(r.from) : `${cellName(r.from)}:${cellName(r.to)}`;
}
