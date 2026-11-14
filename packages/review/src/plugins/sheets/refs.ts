/**
 * A1 reference helpers: column letters, cell and range parsing, rectangle
 * arithmetic and name-box input.
 *
 * Rows and columns are 1-based throughout the package. Fill down/right and
 * in-app paste use the engine's `copy` op, which rebases references itself
 * (docs/ops-xlsx.md 4.7).
 */

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

export type Cell = { row: number; col: number };
export type Rect = { r1: number; c1: number; r2: number; c2: number };

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n;
}

export function numToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function toA1(row: number, col: number): string {
  return `${numToCol(col)}${row}`;
}

/** `B2`, `$B$2`, `b2` -> {row, col}; null when malformed or out of bounds. */
export function parseA1(text: string): Cell | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text.trim());
  if (!m) return null;
  const col = colToNum(m[1]!);
  const row = Number(m[2]);
  if (col < 1 || col > MAX_COLS || row < 1 || row > MAX_ROWS) return null;
  return { row, col };
}

export function normRect(r: Rect): Rect {
  return {
    r1: Math.min(r.r1, r.r2),
    c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2),
    c2: Math.max(r.c1, r.c2),
  };
}

/** `A1:C3`, `C3:A1`, `B2` (single cell), `A:C` (columns), `2:5` (rows). */
export function parseRange(text: string): Rect | null {
  const t = text.trim();
  const parts = t.split(":");
  if (parts.length === 1) {
    const c = parseA1(t);
    return c ? { r1: c.row, c1: c.col, r2: c.row, c2: c.col } : null;
  }
  if (parts.length !== 2) return null;
  const [a, b] = parts as [string, string];
  const ca = parseA1(a);
  const cb = parseA1(b);
  if (ca && cb) return normRect({ r1: ca.row, c1: ca.col, r2: cb.row, c2: cb.col });
  const colA = /^\$?([A-Za-z]{1,3})$/.exec(a);
  const colB = /^\$?([A-Za-z]{1,3})$/.exec(b);
  if (colA && colB) {
    const c1 = colToNum(colA[1]!);
    const c2 = colToNum(colB[1]!);
    if (c1 < 1 || c2 < 1 || c1 > MAX_COLS || c2 > MAX_COLS) return null;
    return normRect({ r1: 1, c1, r2: MAX_ROWS, c2 });
  }
  const rowA = /^\$?(\d{1,7})$/.exec(a);
  const rowB = /^\$?(\d{1,7})$/.exec(b);
  if (rowA && rowB) {
    const r1 = Number(rowA[1]);
    const r2 = Number(rowB[1]);
    if (r1 < 1 || r2 < 1 || r1 > MAX_ROWS || r2 > MAX_ROWS) return null;
    return normRect({ r1, c1: 1, r2, c2: MAX_COLS });
  }
  return null;
}

export function rectToA1(r: Rect): string {
  if (r.r1 === r.r2 && r.c1 === r.c2) return toA1(r.r1, r.c1);
  return `${toA1(r.r1, r.c1)}:${toA1(r.r2, r.c2)}`;
}

/** Display form for the name box: whole columns `B:D`, whole rows `3:5`. */
export function rectLabel(r: Rect): string {
  if (r.r1 === 1 && r.r2 === MAX_ROWS && r.c1 === 1 && r.c2 === MAX_COLS) return "All";
  if (r.r1 === 1 && r.r2 === MAX_ROWS) return `${numToCol(r.c1)}:${numToCol(r.c2)}`;
  if (r.c1 === 1 && r.c2 === MAX_COLS) return `${r.r1}:${r.r2}`;
  return rectToA1(r);
}

export function rectContains(r: Rect, row: number, col: number): boolean {
  return row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
}

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const r = { r1: Math.max(a.r1, b.r1), c1: Math.max(a.c1, b.c1), r2: Math.min(a.r2, b.r2), c2: Math.min(a.c2, b.c2) };
  return r.r1 <= r.r2 && r.c1 <= r.c2 ? r : null;
}

/** `a` minus `b` as up to four disjoint rectangles. */
export function rectSubtract(a: Rect, b: Rect): Rect[] {
  const i = rectIntersect(a, b);
  if (!i) return [a];
  const out: Rect[] = [];
  if (a.r1 < i.r1) out.push({ r1: a.r1, c1: a.c1, r2: i.r1 - 1, c2: a.c2 });
  if (i.r2 < a.r2) out.push({ r1: i.r2 + 1, c1: a.c1, r2: a.r2, c2: a.c2 });
  if (a.c1 < i.c1) out.push({ r1: i.r1, c1: a.c1, r2: i.r2, c2: i.c1 - 1 });
  if (i.c2 < a.c2) out.push({ r1: i.r1, c1: i.c2 + 1, r2: i.r2, c2: a.c2 });
  return out;
}

export type NameBoxTarget = { sheet: string | null; rect: Rect };

/** Name-box input: `B2`, `A1:C3`, `Sheet2!C5`, `'My Sheet'!A1:B2`. */
export function parseNameBox(text: string): NameBoxTarget | null {
  const t = text.trim();
  if (!t) return null;
  const bang = t.lastIndexOf("!");
  if (bang < 0) {
    const rect = parseRange(t);
    return rect ? { sheet: null, rect } : null;
  }
  let sheet = t.slice(0, bang).trim();
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const rect = parseRange(t.slice(bang + 1));
  if (!sheet || !rect) return null;
  return { sheet, rect };
}
