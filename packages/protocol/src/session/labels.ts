/**
 * Readable list items for one history entry, built from the engine's diff.
 *
 * The raw diff is one record per changed node and property. Several records belong together
 * (a `format` op reports the shape, its paragraphs and its runs; a column delete reports every
 * row as removed and added; a z-order change names the shapes that were passed, not the one the
 * user dragged). `describeEntry` folds those into items with a neutral label, keeps every
 * original change index in `indices` for the expandable detail, and tags a group so the panel can
 * show headings when an entry mixes kinds of change.
 *
 * Pure: no host access. Names come through `ctx.nameOf`.
 */
import type { Address, Change } from "../contract.ts";
import type { HistoryEntry } from "./history.ts";
import { addressMapOf, changesOf, formatTyped } from "./model.ts";

export type ChangeKind = Change["change"];

export type Item = {
  /** Index (into the entry's changes) of the change selected when the item is clicked. */
  primary: number;
  /** Every change folded into the item, ascending, including `primary`. */
  indices: number[];
  label: string;
  /** Address shown under the label. */
  address: Address;
  kind: ChangeKind;
  /** `before -> after` line for a single modified property. */
  values?: { property?: string; before: string; after: string };
  /** Extra lines (folded counts, z-order numbers). */
  notes: string[];
  group: string;
};

/** Node data the diff does not carry (names of shapes, kind and text of tracked revisions). */
export type LabelNode = { label?: string; text?: string; revision_kind?: string };
export type LabelContext = {
  nameOf?: (address: Address) => string | undefined;
  nodeOf?: (address: Address) => LabelNode | undefined;
};

const HIGHLIGHT_WORDS = (s: string): string => titleCase(s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
const isOff = (v: unknown): boolean => {
  const s = plain(v).toLowerCase();
  return s === "false" || s === "none" || s === "off" || s === "";
};

/** Short phrase for a `format.*` property change; unknown members keep their property name. */
export function formatLabel(property: string, after: unknown): string {
  const member = property.replace(/^format\.(font\.|paragraph\.)?/, "");
  const set = (what: string): string => `${what}: ${plain(after) || "none"}`;
  switch (member) {
    case "strike":
      return `Strikethrough ${isOff(after) ? "off" : "on"}`;
    case "bold":
      return `Bold ${isOff(after) ? "off" : "on"}`;
    case "italic":
      return `Italic ${isOff(after) ? "off" : "on"}`;
    case "underline":
      return `Underline ${isOff(after) ? "off" : "on"}`;
    case "highlight":
      return isOff(after) ? "Highlight removed" : `Highlight: ${HIGHLIGHT_WORDS(plain(after))}`;
    case "size":
      return set("Font size");
    case "name":
      return set("Font");
    case "color":
      return set("Text colour");
    case "style":
      return set("Style");
    case "alignment":
    case "alignment.horizontal":
      return set("Alignment");
    case "alignment.vertical":
      return set("Vertical alignment");
    case "left":
      return set("Left indent");
    case "space_after":
      return set("Space after");
    case "space_before":
      return set("Space before");
    case "fill.kind":
      return plain(after) === "none" ? "Fill removed" : "Fill added";
    case "fill.color":
      return set("Fill colour");
    case "line.kind":
      return plain(after) === "none" ? "Outline removed" : "Outline added";
    case "line.color":
      return set("Outline colour");
    case "line.width":
      return set("Outline width");
    default:
      return `Format ${member}`;
  }
}

export const GROUP_CONTENT = "Content";
export const GROUP_FORMAT = "Formatting";
export const GROUP_LAYOUT = "Position and size";
export const GROUP_LINES = "Columns and rows";
export const GROUP_SHEET = "Sheet";
export const GROUP_LINKS = "Links";
export const GROUP_ORDER = [GROUP_CONTENT, GROUP_FORMAT, GROUP_LAYOUT, GROUP_LINES, GROUP_SHEET, GROUP_LINKS];

/** Own members of a plain object value; empty for anything else. */
const members = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};

const EMU_PER_PT = 12700;

/** Plain scalar of an engine typed value (`{number: 3}` -> "3", `{string: "a"}` -> "a"). */
export function plain(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "object") return String(v);
  const e = Object.entries(members(v));
  if (e.length === 1) {
    const [k, val] = e[0]!;
    if (k === "empty") return "";
    if (k === "number" || k === "string" || k === "text" || k === "boolean") return String(val);
    if (k === "formula") return String(val);
  }
  return formatTyped(v);
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  const n = members(v).number;
  return typeof n === "number" ? n : null;
};

/** True for an absent, empty or false value. */
export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "") return true;
  if (typeof v === "object") {
    const o = members(v);
    if (o.empty === true) return true;
    const e = Object.entries(o);
    if (e.length === 1) return isBlank(e[0]![1]) && e[0]![0] !== "number";
  }
  return false;
}

const trim = (n: number): string => String(Math.round(n * 100) / 100);
const pt = (emu: number): string => trim(emu / EMU_PER_PT);

/** Link target of a hyperlink diff value: a plain string (`https://...`, or `#Sheet!A1` for an in-workbook location). */
function linkText(v: unknown): string | null {
  const s = plain(v);
  return s === "" ? null : s;
}

const tail = (address: Address): string => address.slice(address.lastIndexOf("/") + 1);
const sheetOf = (address: Address): Address | null => /^sheet:[^/]+/.exec(address)?.[0] ?? null;

/** Address of the shape, table cell or paragraph that owns a paragraph/run/span child. */
export function ownerAddress(address: Address): Address {
  return address.replace(/\/(para|run|span):[^/]*(\/.*)?$/, "");
}

const canon = (v: unknown): string => JSON.stringify(v ?? null);

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Draft = Omit<Item, "notes" | "group"> & { notes?: string[]; group?: string };

export function describeEntry(entry: HistoryEntry, ctx: LabelContext = {}): Item[] {
  const changes = changesOf(entry);
  const used = new Set<number>();
  const out: Item[] = [];
  const push = (d: Draft): void => {
    for (const i of d.indices) used.add(i);
    out.push({ ...d, notes: d.notes ?? [], group: d.group ?? GROUP_CONTENT });
  };
  const name = (address: Address): string => ctx.nameOf?.(address) ?? tail(address);
  const free = (i: number): boolean => !used.has(i);

  // DOCX delete-column / insert-column: the table fingerprint changes, so every row shows as removed
  // under the old table address and added under the new one. Fold them into one entry named from
  // the op. Column indexes in the op are 0-based; the label shows the 1-based column number.
  const ops = entry.transaction.ops ?? [];
  for (const op of ops) {
    if ((op.op !== "delete-column" && op.op !== "insert-column") || !op.resolved) continue;
    const oldTable = op.resolved;
    const newTable = addressMapOf(entry).find((m) => m.before === oldTable)?.after ?? oldTable;
    const under = (a: Address, root: Address): boolean => a === root || a.startsWith(`${root}/`);
    const indices = changes.flatMap((c, i) =>
      free(i) &&
      (under(c.address, oldTable) ||
        under(c.address, newTable) ||
        (c.kind === "paragraph" && (c.change === "added" || c.change === "removed")))
        ? [i]
        : [],
    );
    if (indices.length === 0) continue;
    const column = members(entry.ops[op.index]).index;
    const primary = indices.find((i) => changes[i]!.address === newTable) ?? indices[0]!;
    const verb = op.op === "delete-column" ? "deleted" : "inserted";
    push({
      primary,
      indices,
      kind: "modified",
      label: typeof column === "number" ? `Table column ${column + 1} ${verb}` : `Table column ${verb}`,
      address: newTable,
      notes: [`${indices.length} row and cell records folded`],
    });
  }

  // XLSX recalculate: every dependent cell is reported as a `modified` value with no cause.
  const rawOps = entry.ops as {
    op?: string;
    target?: string;
    anchor?: string;
    position?: string;
    node?: { kind?: string };
  }[];
  if (rawOps.some((o) => o?.op === "recalculate")) {
    const indices = changes.flatMap((c, i) =>
      free(i) &&
      c.change === "modified" &&
      c.kind === "cell" &&
      (c.property === "value" || c.property === "formula") &&
      c.cause === undefined
        ? [i]
        : [],
    );
    if (indices.length > 0) {
      push({
        primary: indices[0]!,
        indices,
        kind: "modified",
        label: `Recalculated ${indices.length} cell${indices.length === 1 ? "" : "s"}`,
        address: changes[indices[0]!]!.address,
        notes: [],
        group: GROUP_SHEET,
      });
    }
  }

  // XLSX sort: the engine reports each moved table row with `from` equal to its address (no positions).
  const sorted = changes.flatMap((c, i) =>
    free(i) && c.change === "moved" && c.kind === "row" && c.from === c.address ? [i] : [],
  );
  if (sorted.length > 0 && rawOps.some((o) => o?.op === "sort")) {
    push({
      primary: sorted[0]!,
      indices: sorted,
      kind: "moved",
      label: `Sorted: ${sorted.length} row${sorted.length === 1 ? "" : "s"} reordered`,
      address: changes[sorted[0]!]!.address,
      notes: [`rows: ${sorted.map((i) => tail(changes[i]!.address).replace(/^row:/, "")).join(", ")}`],
      group: GROUP_LINES,
    });
  }

  // XLSX row/column insert and delete: every shifted cell is reported; fold them into one item.
  rawOps.forEach((o, n) => {
    const line = /\/(row|col):(@?\w+)$/.exec(String(o?.anchor ?? o?.target ?? ""));
    const isInsert = o?.op === "insert" && (o.node?.kind === "row" || o.node?.kind === "col");
    if (!line || !(isInsert || o?.op === "delete")) return;
    const resolved = ops.find((t) => t.index === n)?.resolved;
    const sheet = sheetOf(typeof resolved === "string" ? resolved : String(o?.anchor ?? o?.target));
    const indices = changes.flatMap((c, i) =>
      free(i) && c.kind === "cell" && sheetOf(c.address) === sheet ? [i] : [],
    );
    if (indices.length === 0) return;
    const what = line[1] === "row" ? "Row" : "Column";
    const ref = line[2]!.replace(/^@/, "");
    push({
      primary: indices[0]!,
      indices,
      kind: "modified",
      label: isInsert ? `${what} inserted ${o.position ?? "before"} ${ref}` : `${what} ${ref} deleted`,
      address: changes[indices[0]!]!.address,
      notes: [`${indices.length} cell records folded`],
      group: GROUP_LINES,
    });
  });

  // DOCX Enter / Backspace-join: the paragraphs and runs the engine touched are one edit.
  for (const op of ops) {
    if ((op.op !== "split-paragraph" && op.op !== "join-paragraph") || typeof op.resolved !== "string") continue;
    const survivors =
      op.op === "join-paragraph"
        ? addressMapOf(entry).flatMap((m) =>
            m.before.startsWith(`${op.resolved}/`) && typeof m.after === "string" ? [ownerAddress(m.after)] : [],
          )
        : [];
    const owners = [op.resolved, ...survivors, ...(typeof op.created === "string" ? [op.created] : [])];
    const under = (a: Address): boolean => owners.some((r) => a === r || a.startsWith(`${r}/`));
    const indices = changes.flatMap((c, i) => (free(i) && under(c.address) ? [i] : []));
    if (indices.length === 0) continue;
    push({
      primary: indices[0]!,
      indices,
      kind: op.op === "split-paragraph" ? "added" : "removed",
      label: op.op === "split-paragraph" ? "Paragraph split" : "Paragraphs joined",
      address: op.resolved,
      notes: [`${indices.length} paragraph and run records folded`],
    });
  }

  // Insert of a comment, link or picture (or picture delete): the engine also reports the runs it split or removed.
  for (const op of ops) {
    const raw = rawOps[op.index];
    const target =
      typeof op.created === "string"
        ? op.created
        : raw?.op === "delete" && /\/image:/.test(String(raw.target))
          ? String(op.resolved ?? raw.target)
          : null;
    if (!target || !/(^comment:|\/(link|image):)/.test(target)) continue;
    const i = changes.findIndex((c, n) => free(n) && c.address === target);
    if (i < 0) continue;
    const para = target.startsWith("comment:") ? String(op.resolved) : target.replace(/\/(link|image):[^/]*$/, "");
    const runs = changes.flatMap((c, n) =>
      free(n) && n !== i && c.kind === "run" && c.address.startsWith(`${para}/run:`) ? [n] : [],
    );
    const d = describeOne(changes[i]!, i, name);
    push({
      ...d,
      indices: [i, ...runs].sort((a, b) => a - b),
      notes: [...(d.notes ?? []), ...(runs.length ? [`${runs.length} run records folded`] : [])],
    });
  }

  // DOCX list conversion: list_level, format.list.kind and format.list.num_id are one change.
  const isList = (c: Change): boolean => c.property === "list_level" || c.property?.startsWith("format.list.") === true;
  const listOwners = new Set(changes.flatMap((c, i) => (free(i) && isList(c) ? [c.address] : [])));
  for (const owner of listOwners) {
    const indices = changes.flatMap((c, i) => (free(i) && c.address === owner && isList(c) ? [i] : []));
    const kindIdx = indices.find((i) => changes[i]!.property === "format.list.kind");
    const level = indices.find((i) => changes[i]!.property === "list_level");
    const after = kindIdx === undefined ? "" : plain(changes[kindIdx]!.after);
    const levelNo = level === undefined ? null : num(changes[level]!.after);
    push({
      primary: indices[0]!,
      indices,
      kind: "modified",
      label: after ? `List: ${after}${levelNo !== null ? ` (level ${levelNo})` : ""}` : "List removed",
      address: owner,
      notes: [],
      group: GROUP_FORMAT,
    });
  }

  // DOCX range format: splitting runs is reported as run text edits and added runs next to the `span` record.
  const spanParas = new Set(changes.flatMap((c, i) => (free(i) && c.kind === "span" ? [c.address] : [])));
  for (const para of spanParas) {
    const spans = changes.flatMap((c, i) => (free(i) && c.kind === "span" && c.address === para ? [i] : []));
    const splits = changes.flatMap((c, i) =>
      free(i) &&
      c.kind === "run" &&
      c.address.startsWith(`${para}/run:`) &&
      (c.change === "added" || c.property === "text")
        ? [i]
        : [],
    );
    const byProperty = new Map<string, number[]>();
    for (const i of spans) {
      const p = changes[i]!.property ?? "";
      (byProperty.get(p) ?? byProperty.set(p, []).get(p)!).push(i);
    }
    let first = true;
    for (const [property, indices] of byProperty) {
      const c = changes[indices[0]!]!;
      const folded = first ? splits : [];
      first = false;
      push({
        primary: indices[0]!,
        indices: [...indices, ...folded].sort((a, b) => a - b),
        kind: "modified",
        label: formatLabel(property, c.after),
        address: para,
        values: { before: formatTyped(c.before), after: formatTyped(c.after) },
        notes: [
          "character range (the diff carries no offsets)",
          ...(folded.length ? [`${folded.length} run-split records folded`] : []),
        ],
        group: GROUP_FORMAT,
      });
    }
  }

  // Text edits: a paragraph edit is also reported on its runs and on the shape that owns it.
  const textIdx = changes.flatMap((c, i) => (free(i) && c.change === "modified" && c.property === "text" ? [i] : []));
  for (const p of textIdx.filter((i) => changes[i]!.kind === "paragraph")) {
    const pa = changes[p]!.address;
    const runs = textIdx.filter(
      (i) => free(i) && changes[i]!.kind === "run" && changes[i]!.address.startsWith(`${pa}/run:`),
    );
    const shapes = textIdx.filter(
      (i) =>
        free(i) &&
        changes[i]!.kind !== "run" &&
        changes[i]!.kind !== "paragraph" &&
        pa.startsWith(`${changes[i]!.address}/para:`),
    );
    const added = changes.flatMap((c, i) =>
      free(i) && c.change === "added" && c.kind === "run" && c.address.startsWith(`${pa}/run:`) ? [i] : [],
    );
    const all = [p, ...runs, ...shapes, ...added].sort((a, b) => a - b);
    push({
      primary: p,
      indices: all,
      kind: "modified",
      label: "Text edited (paragraph)",
      address: pa,
      values: { before: formatTyped(changes[p]!.before), after: formatTyped(changes[p]!.after) },
      notes: all.length > 1 ? [`${all.length - 1} run and shape records folded`] : [],
    });
  }

  // DOCX tracked typing: a tracked splice-text creates one deletion plus one insertion revision and
  // consecutive keystrokes grow the same insertion, so all revision records of a batch are one change.
  const tracked = new Set(
    ops.flatMap((op) =>
      Array.isArray(op.revisions) ? op.revisions.filter((r): r is string => typeof r === "string") : [],
    ),
  );
  const revIdx = changes.flatMap((c, i) => (free(i) && (c.kind === "revision" || tracked.has(c.address)) ? [i] : []));
  if (revIdx.length > 0) {
    const parts = revIdx.map((i) => {
      const c = changes[i]!;
      const node = ctx.nodeOf?.(c.address);
      const kind = typeof c.revision_kind === "string" ? c.revision_kind : node?.revision_kind;
      const text = typeof c.text === "string" ? c.text : node?.text;
      return { kind, text };
    });
    const ins = parts.filter((p) => p.kind === "ins");
    const del = parts.filter((p) => p.kind === "del");
    const said = (word: string, ps: { text?: string }[]): string[] => {
      const t = ps.map((p) => p.text ?? "").join("");
      return t ? [`${word} "${t}"`] : [];
    };
    const detail = [...said("deleted", del), ...said("inserted", ins)];
    const counts = [
      del.length ? `${del.length} deletion${del.length === 1 ? "" : "s"}` : "",
      ins.length ? `${ins.length} insertion${ins.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    push({
      primary: revIdx[0]!,
      indices: revIdx,
      kind: "added",
      label: `Tracked edit${detail.length ? `: ${detail.join(", ")}` : counts.length ? ` (${counts.join(", ")})` : ""}`,
      address: changes[revIdx[0]!]!.address,
      notes: revIdx.length > 1 ? [`${revIdx.length} tracked revision records`] : [],
    });
  }

  // PPTX z-order: `moved` on shapes. The engine reports the smallest set of reordered shapes, which
  // may be the ones that were passed rather than the one the user moved: neutral label, one item per slide.
  const zBySlide = new Map<string, number[]>();
  changes.forEach((c, i) => {
    if (!free(i) || c.change !== "moved" || !/\/shape:[^/]+$/.test(c.address)) return;
    const slide = c.address.slice(0, c.address.lastIndexOf("/shape:"));
    (zBySlide.get(slide) ?? zBySlide.set(slide, []).get(slide)!).push(i);
  });
  for (const [slide, indices] of zBySlide) {
    const names = indices.map((i) => name(changes[i]!.address));
    const notes = indices.flatMap((i) => {
      const c = changes[i]!;
      const b = num(c.before);
      const a = num(c.after);
      return b !== null && a !== null ? [`${name(c.address)}: position ${b} -> ${a}`] : [];
    });
    push({
      primary: indices[0]!,
      indices,
      kind: "moved",
      label: `Stacking order changed: ${names.join(", ")}`,
      address: slide,
      notes,
      group: GROUP_LAYOUT,
    });
  }

  // Shape move / resize: geometry members of one shape.
  const geometry = new Map<
    string,
    { x?: number; y?: number; cx?: number; cy?: number; idx: Partial<Record<"x" | "y" | "cx" | "cy", number>> }
  >();
  changes.forEach((c, i) => {
    const m = /^geometry\.(x|y|cx|cy)$/.exec(c.property ?? "");
    if (!free(i) || c.change !== "modified" || !m) return;
    const g = geometry.get(c.address) ?? { idx: {} };
    const k = m[1] as "x" | "y" | "cx" | "cy";
    g.idx[k] = i;
    geometry.set(c.address, g);
  });
  for (const [address, g] of geometry) {
    const get = (k: "x" | "y" | "cx" | "cy", side: "before" | "after") => {
      const i = g.idx[k];
      return i === undefined ? null : num(changes[i]![side]);
    };
    const pair = (a: "x" | "cx", b: "y" | "cy") => {
      const idx = [g.idx[a], g.idx[b]].filter((i): i is number => i !== undefined);
      if (idx.length === 0) return;
      const show = (side: "before" | "after", ka: "x" | "cx", kb: "y" | "cy"): string => {
        const va = get(ka, side);
        const vb = get(kb, side);
        return `${va === null ? "?" : pt(va)}${ka === "x" ? ", " : " x "}${vb === null ? "?" : pt(vb)}`;
      };
      push({
        primary: idx[0]!,
        indices: idx.sort((p, q) => p - q),
        kind: "modified",
        label: `${name(address)} ${a === "x" ? "moved" : "resized"} (points)`,
        address,
        values: { before: show("before", a, b), after: show("after", a, b) },
        group: GROUP_LAYOUT,
      });
    };
    pair("x", "y");
    pair("cx", "cy");
  }

  // Sheet move: the diff has only `moved` with `from` equal to the address; the position is in the op.
  changes.forEach((c, i) => {
    if (!free(i) || c.change !== "moved" || c.kind !== "sheet") return;
    const o = rawOps.find((r) => r?.op === "move" && String(r.target ?? "").startsWith("sheet:"));
    push({
      primary: i,
      indices: [i],
      kind: "moved",
      label: o?.anchor
        ? `Sheet ${name(c.address)} moved ${o.position ?? "after"} ${tail(String(o.anchor)).replace(/^sheet:/, "")}`
        : `Sheet ${name(c.address)} moved`,
      address: c.address,
      notes: [],
      group: GROUP_SHEET,
    });
  });

  // PPTX picture insert: the diff reports a plain `shape`; only the op says it is an image.
  for (const op of ops) {
    const raw = rawOps[op.index];
    if (op.op !== "insert" || raw?.node?.kind !== "image" || typeof op.created !== "string") continue;
    const i = changes.findIndex(
      (c, n) => free(n) && c.change === "added" && c.address === op.created && /\/shape:[^/]+$/.test(c.address),
    );
    if (i >= 0)
      push({
        primary: i,
        indices: [i],
        kind: "added",
        label: `Picture added: ${name(op.created)}`,
        address: op.created,
        notes: [],
      });
  }

  // Format: a shape or cell also reports its paragraphs and runs. Same property and value on one owner
  // folds into one item (detail stays expandable).
  const formatGroups = new Map<string, number[]>();
  changes.forEach((c, i) => {
    if (
      !free(i) ||
      c.change !== "modified" ||
      c.kind === "col" ||
      c.kind === "row" ||
      !c.property?.startsWith("format.")
    )
      return;
    // The engine reports paragraph properties twice (`format.left` and `format.paragraph.left`) and a
    // bold run beside a bold paragraph (`format.bold`, `format.font.bold`): one key per member and value.
    const stem = `${ownerAddress(c.address)}\u0000${c.property.replace(/^format\.(font\.|paragraph\.)?/, "")}\u0000${canon(c.after)}`;
    const key = `${stem}\u0000${isBlank(c.before) ? "*" : canon(c.before)}`;
    (formatGroups.get(key) ?? formatGroups.set(key, []).get(key)!).push(i);
  });
  // A record with no `before` is the engine's second spelling of a property reported with a value: join it.
  for (const [key, indices] of [...formatGroups]) {
    if (!key.endsWith("\u0000*")) continue;
    const stem = key.slice(0, -2);
    const host = [...formatGroups.keys()].find((k) => k !== key && k.startsWith(`${stem}\u0000`));
    if (!host) continue;
    formatGroups.get(host)!.push(...indices);
    formatGroups.delete(key);
  }
  for (const indices of formatGroups.values()) {
    indices.sort((a, b) => a - b);
    const first = changes[indices[0]!]!;
    const owner = ownerAddress(first.address);
    const primary = indices.find((i) => changes[i]!.address === owner) ?? indices[0]!;
    push({
      primary,
      indices,
      kind: "modified",
      label: formatLabel(first.property!, first.after),
      address: owner,
      values: { before: formatTyped(first.before), after: formatTyped(first.after) },
      notes: indices.length > 1 ? [`${indices.length - 1} paragraph or run records folded`] : [],
      group: GROUP_FORMAT,
    });
  }

  // Everything else: one item per change.
  changes.forEach((c, i) => {
    if (!free(i)) return;
    push(describeOne(c, i, name));
  });

  // Stable order: group order, then first change index.
  return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.primary - b.primary);
}

function describeOne(c: Change, index: number, name: (a: Address) => string): Draft {
  const base: Pick<Draft, "primary" | "indices" | "kind" | "address"> = {
    primary: index,
    indices: [index],
    kind: c.change,
    address: c.address,
  };
  const ba = { before: formatTyped(c.before), after: formatTyped(c.after) };
  const sheet = sheetOf(c.address);
  const where = (): string => {
    const s = sheet ? name(sheet) : null;
    return s && s !== sheet ? ` (${s})` : "";
  };

  // XLSX line (column / row) records.
  if (c.kind === "col" || c.kind === "row") {
    const line =
      c.kind === "col"
        ? `Column ${/col:([A-Za-z]+)$/.exec(c.address)?.[1] ?? "?"}`
        : `Row ${/row:@?(\d+)$/.exec(c.address)?.[1] ?? "?"}`;
    if (c.property === "format.column_width" || c.property === "format.row_height") {
      const what = c.kind === "col" ? "width" : "height";
      return {
        ...base,
        label: `${line} ${what} ${plain(c.before) || "default"} -> ${plain(c.after) || "default"}${where()}`,
        group: GROUP_LINES,
      };
    }
    if (c.property === "state") {
      const hidden = plain(c.after) === "hidden";
      return { ...base, label: `${line} ${hidden ? "hidden" : "shown"}${where()}`, group: GROUP_LINES };
    }
    return {
      ...base,
      label: `${line} ${c.change}${where()}`,
      values: c.change === "modified" ? { property: c.property, ...ba } : undefined,
      group: GROUP_LINES,
    };
  }

  // XLSX sheet-level records.
  if (c.kind === "sheet" && c.property === "name") {
    return { ...base, label: `Sheet renamed ${plain(c.before)} -> ${plain(c.after)}`, group: GROUP_SHEET };
  }
  if (c.property === "merge") {
    const range = tail(c.address).replace(/^(range|cell):/, "");
    return {
      ...base,
      label: isBlank(c.after) ? `Cells unmerged: ${range}${where()}` : `Cells merged: ${range}${where()}`,
      values: { property: "merge", ...ba },
      group: GROUP_SHEET,
    };
  }
  if (c.property === "freeze") {
    return {
      ...base,
      label: isBlank(c.after) ? `Freeze panes removed${where()}` : `Freeze panes set${where()}`,
      values: { property: "freeze", ...ba },
      group: GROUP_SHEET,
    };
  }
  if (c.property === "hyperlink") {
    const cell = tail(c.address).replace(/^cell:/, "");
    const b = linkText(c.before);
    const a = linkText(c.after);
    const verb = !b && a ? "added" : b && !a ? "removed" : "changed";
    return {
      ...base,
      label: `Link ${verb} on ${cell}${where()}`,
      values: { property: "hyperlink", before: b ?? "(none)", after: a ?? "(none)" },
      group: GROUP_LINKS,
    };
  }

  // PPTX slides and shapes.
  if (c.kind === "slide") {
    if (c.change === "moved") {
      const b = num(c.before);
      const a = num(c.after);
      return {
        ...base,
        label: b !== null && a !== null ? `Slide moved ${b} -> ${a}` : "Slide moved",
        notes: c.from ? [`from ${c.from}`] : [],
        group: GROUP_LAYOUT,
      };
    }
    if (c.change === "added") return { ...base, label: "Slide added" };
    if (c.change === "removed") return { ...base, label: "Slide deleted" };
  }
  if (/\/shape:[^/]+$/.test(c.address) && (c.change === "added" || c.change === "removed")) {
    const noun = "Shape";
    return { ...base, label: `${noun} ${c.change === "added" ? "added" : "deleted"}: ${name(c.address)}` };
  }

  // Pictures and comments (DOCX and others).
  if (c.kind === "hyperlink") return { ...base, label: `Link ${c.change === "removed" ? "removed" : c.change}` };
  if (c.kind === "image") {
    return { ...base, label: `Picture ${c.change === "removed" ? "deleted" : c.change}` };
  }
  if (c.kind === "comment" || c.kind === "reply") {
    const noun = titleCase(c.kind);
    if (c.change === "modified") {
      return {
        ...base,
        label: `${noun} ${c.property === "text" || !c.property ? "edited" : `${c.property} changed`}`,
        values: { property: c.property, ...ba },
      };
    }
    return { ...base, label: `${noun} ${c.change === "removed" ? "deleted" : c.change}` };
  }

  // Default: what the engine said.
  return {
    ...base,
    label:
      c.change === "modified" && c.property === "text"
        ? `Text edited (${c.kind})`
        : c.change === "modified" && c.property === "value"
          ? `Value changed (${c.kind})`
          : c.change === "modified" && c.property === "formula"
            ? `Formula changed (${c.kind})`
            : `${c.change} ${c.kind}`,
    values: c.change === "modified" ? { property: c.property, ...ba } : undefined,
    notes: c.change === "moved" && c.from ? [`from ${c.from}`] : [],
  };
}

/**
 * Node to scroll to for a change address. A column or row address (`sheet:#2/col:E`,
 * `sheet:#2/row:@3`) has no node of its own in every view; fall back to the first cell of that
 * line that the view carries. Returns null when nothing is known.
 */
export function revealTarget(address: Address, has: (a: Address) => boolean): Address | null {
  if (has(address)) return address;
  const col = /^(.*)\/col:([A-Za-z]+)$/.exec(address);
  if (col) {
    for (let r = 1; r <= 5; r++) if (has(`${col[1]}/cell:${col[2]}${r}`)) return `${col[1]}/cell:${col[2]}${r}`;
    return null;
  }
  const row = /^(.*)\/row:@?(\d+)$/.exec(address);
  if (row) {
    for (const c of ["A", "B", "C", "D"])
      if (has(`${row[1]}/cell:${c}${row[2]}`)) return `${row[1]}/cell:${c}${row[2]}`;
  }
  return null;
}
