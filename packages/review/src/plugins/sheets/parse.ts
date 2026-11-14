/**
 * Typed-value parsing for user input (cell editor, formula bar, paste) and
 * TSV clipboard encoding.
 */
import type { TypedValue } from "@wolfsdk/protocol";

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/** A plain or formatted number: `12`, `-3.5`, `1,234.5`, `12%`, `(42)`,
 * `$1,200`, `1e3`. Null when `text` is not a number. */
export function parseNumber(text: string): number | null {
  let t = text.trim();
  if (!t) return null;
  let negative = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    negative = true;
    t = t.slice(1, -1).trim();
  }
  let percent = false;
  if (t.endsWith("%")) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  // Optional currency sign, before or after a leading minus.
  if (/^[-+]?\$/.test(t)) t = t.replace("$", "");
  if (t.startsWith("-") && negative) return null;
  if (GROUPED_RE.test(t)) t = t.replace(/,/g, "");
  if (!NUMBER_RE.test(t)) return null;
  let n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (percent) n = n / 100;
  if (negative) n = -n;
  return Object.is(n, -0) ? 0 : n;
}

/**
 * User input -> engine typed value:
 * `=...` -> formula, numbers (see `parseNumber`) -> number, TRUE/FALSE ->
 * boolean, empty -> empty, a leading apostrophe forces text, otherwise
 * string.
 */
export function parseInput(text: string): TypedValue {
  if (text === "") return { empty: true };
  if (text.startsWith("'")) return { string: text.slice(1) };
  if (text.startsWith("=") && text.length > 1) return { formula: text };
  const upper = text.trim().toUpperCase();
  if (upper === "TRUE") return { boolean: true };
  if (upper === "FALSE") return { boolean: false };
  const n = parseNumber(text);
  if (n !== null) return { number: n };
  return { string: text };
}

/** Parse clipboard TSV (Excel / Google Sheets / plain text). Quoted fields
 * may contain tabs, newlines and doubled quotes. Trailing empty line dropped. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const n = text.length;
  let atFieldStart = true;
  while (i < n) {
    const ch = text[i]!;
    if (atFieldStart && ch === '"') {
      // Quoted field.
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += text[j];
        j++;
      }
      if (closed && (j >= n || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")) {
        field = value;
        i = j;
        atFieldStart = false;
        continue;
      }
      // Not a well-formed quoted field: read it literally.
    }
    if (ch === "\t") {
      row.push(field);
      field = "";
      atFieldStart = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atFieldStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    atFieldStart = false;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r));
}

function tsvField(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvField).join("\t")).join("\n");
}
