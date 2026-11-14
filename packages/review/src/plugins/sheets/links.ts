/**
 * Cell hyperlinks: where the grid learns which cells carry a link.
 *
 * Three sources, merged by `linkAt` in the store:
 *
 * 1. The engine: the `hyperlink` member of a cell node (`ViewNode.hyperlink`,
 *    `{url}` or `{location}` plus `tooltip` when stored; `location` is the
 *    stored attribute without a leading `#`; a link on a multi-cell range is
 *    repeated on every observed cell node in it). Covers links in the file.
 * 2. This session's `hyperlink` ops (`deriveSessionLinks`): every applied
 *    batch up to the current revision, replayed with the positional shifts
 *    of row/column inserts and deletes, sheet deletes and copies. Needed on
 *    a module whose observe has no `hyperlink` member. A sort is not
 *    followed: its `moved` records name table rows by key with `from`
 *    equal to `address` (no row numbers), and the engine owns the links
 *    after it (source 1, re-read every revision).
 * 3. `=HYPERLINK("url", ...)` formulas whose first argument is a string
 *    literal (`formulaLink`); `#Sheet!A1` there is an internal location.
 */
import type { Op, ViewNode } from "@wolfsdk/protocol";
import type { HistoryEntry } from "../../host/index.ts";
import { cellKey } from "./model.ts";
import { colToNum, parseA1 } from "./refs.ts";

export type Link = { url?: string; location?: string; tooltip?: string };

/** Links by sheetId, then by `cellKey(row, col)`. */
export type LinkMap = Map<number, Map<number, Link>>;

const ROW_OF = 16400;
const rowOfKey = (k: number) => Math.floor(k / ROW_OF);
const colOfKey = (k: number) => k % ROW_OF;

/** A cell node's `hyperlink` member; null when absent or empty. */
export function nodeLink(v: ViewNode["hyperlink"]): Link | null {
  if (!v) return null;
  const link: Link = {};
  if (v.url) link.url = v.url;
  else if (v.location) link.location = v.location;
  else return null;
  if (v.tooltip) link.tooltip = v.tooltip;
  return link;
}

/** The link a `hyperlink` set op writes (`url` or `location`, `tooltip`). */
function opLink(op: Op): Link | null {
  const link: Link = {};
  if (typeof op.url === "string" && op.url) link.url = op.url;
  else if (typeof op.location === "string" && op.location) link.location = op.location;
  else return null;
  if (typeof op.tooltip === "string" && op.tooltip) link.tooltip = op.tooltip;
  return link;
}

/** `=HYPERLINK("https://...", ...)` with a literal first argument. */
export function formulaLink(formula: string | undefined): Link | null {
  if (!formula) return null;
  const m = /^=\s*HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i.exec(formula);
  if (!m) return null;
  const text = m[1]!.replace(/""/g, '"');
  if (!text) return null;
  return text.startsWith("#") ? { location: text.slice(1) } : { url: text };
}

/** Schemes a Cmd/Ctrl+click may open in a new tab. */
export function openableUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const INTERNAL = /^(?:'[^']+'|[^\s!'#]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;

/** The link-bar text for a link: the URL, a `Sheet!A1` location as is, and
 * any other location (a defined name, say) with a leading `#` so that
 * `parseLinkInput` reads it back as a location. */
export function linkInputText(link: Link | null | undefined): string {
  if (!link) return "";
  if (link.url) return link.url;
  if (!link.location) return "";
  return INTERNAL.test(link.location) ? link.location : `#${link.location}`;
}

/**
 * What the user typed in the link dialog -> an op target, or an error.
 * `#anything` and `Sheet!A1` are internal locations (sent without the `#`,
 * the form the file stores); `name@host` becomes `mailto:`; a bare host
 * gets `https://`. The engine itself refuses a URL without a scheme, with
 * spaces or over 2,079 chars (`hyperlink-url-invalid`).
 */
export function parseLinkInput(text: string): { url: string } | { location: string } | { error: string } {
  const t = text.trim();
  if (!t) return { error: "Enter a web address, an email address or a cell reference such as Sheet1!A1." };
  if (t.startsWith("#")) {
    const loc = t.slice(1).trim();
    return loc ? { location: loc } : { error: "Enter a cell reference or name after #, such as #Sheet1!A1." };
  }
  if (INTERNAL.test(t)) return { location: t };
  if (/\s/.test(t)) return { error: "A link address cannot contain spaces." };
  let url = t;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^[^@/]+@[^@/]+\.[^@/]+$/.test(url) ? `mailto:${url}` : `https://${url}`;
  if (url.length > 2079) return { error: "A link address can be at most 2,079 characters." };
  return { url };
}

// ---------------------------------------------------------------------------
// Session replay
// ---------------------------------------------------------------------------

const SHEET_REF = /^sheet:#(\d+)$/;
const CELL_REF = /^sheet:#(\d+)\/cell:([A-Z]+\d+)$/;
const ROW_REF = /^sheet:#(\d+)\/row:@(\d+)$/;
const COL_REF = /^sheet:#(\d+)\/col:([A-Z]+)$/;

function sheetLinks(map: LinkMap, sheetId: number): Map<number, Link> {
  let m = map.get(sheetId);
  if (!m) {
    m = new Map();
    map.set(sheetId, m);
  }
  return m;
}

/** Shift the links of one sheet: `delta` > 0 inserts before `at`, < 0
 * deletes `-delta` indices from `at`. */
function shift(links: Map<number, Link>, axis: "row" | "col", at: number, delta: number): Map<number, Link> {
  const out = new Map<number, Link>();
  for (const [k, link] of links) {
    let row = rowOfKey(k);
    let col = colOfKey(k);
    const i = axis === "row" ? row : col;
    let n = i;
    if (i >= at) {
      if (delta < 0 && i < at - delta) continue;
      n = i + delta;
    }
    if (axis === "row") row = n;
    else col = n;
    out.set(cellKey(row, col), link);
  }
  return out;
}

/** The canonical target of op `i` of an entry: the receipt's `resolved`
 * address when it has one (ops addressed by name or position), else the
 * op's own `target`/`anchor`. */
function resolvedOf(entry: HistoryEntry, i: number, own: unknown): string {
  const r = entry.transaction?.ops?.find((o) => o.index === i)?.resolved;
  return typeof r === "string" ? r : typeof own === "string" ? own : "";
}

function replayOp(map: LinkMap, entry: HistoryEntry, i: number, op: Op): void {
  switch (op.op) {
    case "hyperlink": {
      const m = CELL_REF.exec(resolvedOf(entry, i, op.target));
      const at = m ? parseA1(m[2]!) : null;
      if (!m || !at) return;
      const links = sheetLinks(map, Number(m[1]));
      if (op.action === "remove") links.delete(cellKey(at.row, at.col));
      else if (op.action === "set") {
        const link = opLink(op);
        if (link) links.set(cellKey(at.row, at.col), link);
      }
      return;
    }
    case "insert": {
      const anchor = resolvedOf(entry, i, op.anchor);
      const node = op.node as { kind?: string; count?: number; from?: string } | undefined;
      const count = node?.count ?? 1;
      const after = op.position === "after" ? 1 : 0;
      const row = ROW_REF.exec(anchor);
      if (row && node?.kind === "row") {
        const id = Number(row[1]);
        map.set(id, shift(sheetLinks(map, id), "row", Number(row[2]) + after, count));
      }
      const col = COL_REF.exec(anchor);
      if (col && node?.kind === "col") {
        const id = Number(col[1]);
        map.set(id, shift(sheetLinks(map, id), "col", colToNum(col[2]!) + after, count));
      }
      // Sheet copy: the copy carries the source's links.
      if (node?.kind === "sheet" && typeof node.from === "string") {
        const created = entry.transaction?.ops?.find((o) => o.index === i)?.created;
        const to = typeof created === "string" ? SHEET_REF.exec(created) : null;
        const from = SHEET_REF.exec(node.from) ?? SHEET_REF.exec(resolvedOf(entry, i, undefined));
        if (to && from && map.get(Number(from[1]))?.size) map.set(Number(to[1]), new Map(map.get(Number(from[1]))));
      }
      return;
    }
    case "delete": {
      const target = resolvedOf(entry, i, op.target);
      const row = ROW_REF.exec(target);
      if (row) map.set(Number(row[1]), shift(sheetLinks(map, Number(row[1])), "row", Number(row[2]), -1));
      const col = COL_REF.exec(target);
      if (col) map.set(Number(col[1]), shift(sheetLinks(map, Number(col[1])), "col", colToNum(col[2]!), -1));
      const sheet = SHEET_REF.exec(target);
      if (sheet) map.delete(Number(sheet[1]));
      // A cell/range delete clears values only: links stay.
      return;
    }
  }
}

/** Links set in this session: `history[0 .. revision-1]` replayed. */
export function deriveSessionLinks(history: readonly HistoryEntry[], revision: number): LinkMap {
  const map: LinkMap = new Map();
  for (const entry of history.slice(0, revision)) {
    entry.ops.forEach((op, i) => replayOp(map, entry, i, op));
  }
  return map;
}
