/**
 * User actions. Each builds its ops from `ops.ts` against the revision current
 * when it runs (`store.run`), so addresses are never stale.
 */
import type { Address, DocState, ViewNode } from "@wolfsdk/protocol";
import {
  bodyNeighbour,
  cellAddress,
  neighbour,
  paraInCell,
  rowAddress,
  spanAddress,
  spanUsable,
  stepCell,
  tableAddress,
  type DocModel,
  type Para,
} from "./addresses.ts";
import * as ops from "./ops.ts";
import { styleById, type CellPosition, type ListKind } from "./structure.ts";
import { UserError, type Done, type DocsStore, type FormatMemory } from "./store.ts";
import { spliceOps, textIsComplete } from "./textedit.ts";

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/** Paragraphs the action applies to: the open editor's, else the selected ones. */
export function targetParas(store: DocsStore, model: DocModel): Para[] {
  const editing = store.ui.editing;
  if (editing) {
    const para = model.byId.get(editing.para);
    return para ? [para] : [];
  }
  const out: Para[] = [];
  for (const id of store.host.getSnapshot().selection) {
    const para = model.byId.get(id);
    if (para && !out.includes(para)) out.push(para);
  }
  return out;
}

function primary(store: DocsStore, model: DocModel): Para {
  const para = targetParas(store, model)[0];
  if (!para) throw new UserError("docs-no-selection", "Select a paragraph first.");
  return para;
}

function bodyOnly(para: Para, what: string): void {
  if (!para.body) throw new UserError("docs-header-footer", `${what} is not available in headers and footers.`);
}

export function pageOf(state: DocState, id: Address): number | null {
  return state.regions.find((r) => r.object_id === id)?.page ?? null;
}

/** Address the op at `index` created, if it is in the new revision. */
function created(done: Done, index: number): Address | null {
  const id = done.result.transaction.ops[index]?.created;
  return id && done.result.state.nodes.some((n) => n.id === id) ? id : null;
}

/** Open the editor on `id` in the new revision. The previous editor's text is already part of the applied batch. */
function editAt(store: DocsStore, id: Address | null, caret: number | null): void {
  const state = store.host.getSnapshot().state;
  store.cancelEdit();
  if (!id || !state) return;
  store.startEdit(id, pageOf(state, id) ?? 1, caret);
  store.host.reveal({ address: id });
}

/** The text range selected in the open editor, as a span address, when the engine can bind it. */
function editorSpan(store: DocsStore, model: DocModel): Address | null {
  const editing = store.ui.editing;
  if (!editing || editing.selEnd <= editing.selStart) return null;
  const para = model.byId.get(editing.para);
  if (!para) return null;
  const text = para.node.text ?? "";
  if (!spanUsable(text, editing.selStart, editing.selEnd)) {
    throw new UserError(
      "docs-span-ambiguous",
      "The engine addresses a text range by its first occurrence in the paragraph; select text that occurs once (no tabs, line breaks or slashes), or clear the selection to format the whole paragraph.",
    );
  }
  return spanAddress(para.id, text.slice(editing.selStart, editing.selEnd));
}

// ---------------------------------------------------------------------------
// In-place editor structure (split, merge, Tab)
// ---------------------------------------------------------------------------

/**
 * Enter in the editor. Untracked: the typed text (selection removed) as one
 * splice, then `split-paragraph` at the caret. `split-paragraph` does not take
 * `track` (engine-ops-docx.md, Answers A1), so in track-changes mode the text
 * after the caret is a tracked deletion here and a tracked new paragraph after
 * this one; the new paragraph takes the default run formatting.
 */
export function splitParagraph(store: DocsStore): Promise<unknown> {
  return store.run(
    "Split paragraph",
    (model) => {
      const editing = store.ui.editing;
      const para = editing && model.byId.get(editing.para);
      if (!editing || !para) return null;
      const track = store.track();
      if (!track) {
        const text = editing.text.slice(0, editing.selStart) + editing.text.slice(editing.selEnd);
        const edit = spliceOps(para, editing.base, text, null) ?? [];
        const offset = ops.scalarOffset(text, editing.selStart);
        const atStart = offset === 0 && text !== "";
        return {
          ops: [...edit, ops.splitParagraph(para.id, offset)],
          after: (done) => {
            // Offset 0 puts the new empty paragraph before; the caret stays at the start of this one.
            const next = atStart ? done.remap(para.id) : (created(done, edit.length) ?? followingPara(done, para.id));
            editAt(store, next, 0);
          },
        };
      }
      const left = editing.text.slice(0, editing.selStart);
      const right = editing.text.slice(editing.selEnd);
      if (left === "" && editing.text === editing.base && editing.base !== "") {
        // Caret at the start: a tracked empty paragraph above keeps this one intact.
        return {
          ops: [ops.insertParagraph(para.id, "before", "", { track })],
          select: (done) => [done.remap(para.id) ?? para.id],
          after: () => store.patchEditing({ selStart: 0, selEnd: 0 }),
        };
      }
      const edit = spliceOps(para, editing.base, left, track) ?? [];
      return {
        ops: [...edit, ops.insertParagraph(para.id, "after", ops.cleanText(right), { track })],
        after: (done) => editAt(store, created(done, edit.length) ?? followingPara(done, para.id), 0),
      };
    },
    { skipCommit: true },
  );
}

function followingPara(done: Done, base: Address): Address | null {
  const now = done.remap(base);
  const paras = done.result.state.nodes.filter((n) => n.kind === "paragraph");
  const at = paras.findIndex((n) => n.id === now);
  return at >= 0 ? (paras[at + 1]?.id ?? null) : null;
}

/**
 * Backspace at offset 0 (`direction` -1) or Delete at the end (+1).
 * Untracked: `join-paragraph`, which moves the second paragraph's content to
 * the end of the first, keeping its runs. `join-paragraph` does not take
 * `track`, so in track-changes mode the second paragraph's text is a tracked
 * insertion at the end of the first and the second paragraph a tracked
 * deletion. A join at a table or section boundary is refused by the engine
 * (`op-kind-mismatch`) for that construct only.
 */
export function mergeParagraph(store: DocsStore, direction: -1 | 1): Promise<unknown> {
  return store.run(
    direction < 0 ? "Merge with previous paragraph" : "Merge with next paragraph",
    (model) => {
      const editing = store.ui.editing;
      const para = editing && model.byId.get(editing.para);
      if (!editing || !para) return null;
      const other = neighbour(model, para, direction);
      if (!other) return null;
      const track = store.track();
      const own = spliceOps(para, editing.base, editing.text, track) ?? [];
      const first = direction < 0 ? other : para;
      const second = direction < 0 ? para : other;
      const firstText = direction < 0 ? (other.node.text ?? "") : ops.cleanText(editing.text);
      if (!track) {
        // `join-paragraph` targets the second paragraph; the first keeps its address and properties.
        return {
          ops: [...own, ops.joinParagraph(second.id)],
          after: (done) => editAt(store, done.remap(first.id), firstText.length),
        };
      }
      const secondText = direction < 0 ? ops.cleanText(editing.text) : (other.node.text ?? "");
      if (!textIsComplete(other))
        throw new UserError("docs-text-cut", "The neighbouring paragraph is too long to merge from its view text.");
      const append =
        secondText === ""
          ? []
          : [
              ops.spliceText(
                first.id,
                ops.scalarOffset(firstText, firstText.length),
                ops.scalarOffset(firstText, firstText.length),
                secondText,
                track,
              ),
            ];
      return {
        ops: [...own, ...append, ops.deleteNode(second.id, track)],
        after: (done) => editAt(store, done.remap(first.id), firstText.length),
      };
    },
    { skipCommit: true },
  );
}

/**
 * Paste several lines at the editor's selection: the first line joins the
 * text before the selection, every further line becomes a paragraph after
 * it, and the text after the selection follows the last line. The caret
 * lands at the end of the pasted text.
 */
export function pasteLines(store: DocsStore, lines: string[]): Promise<unknown> {
  return store.run(
    "Paste",
    (model) => {
      const editing = store.ui.editing;
      const para = editing && model.byId.get(editing.para);
      if (!editing || !para || lines.length < 2) return null;
      const track = store.track();
      const left = editing.text.slice(0, editing.selStart) + lines[0]!;
      const right = editing.text.slice(editing.selEnd);
      const rest = lines.slice(1);
      const last = rest[rest.length - 1]!;
      rest[rest.length - 1] = last + right;
      const edit = spliceOps(para, editing.base, left, track) ?? [];
      // Inserts at the same anchor keep request order (docs/ops-docx.md), so they go in line order.
      const inserts = rest.map((text) => ops.insertParagraph(para.id, "after", text, { track }));
      return {
        ops: [...edit, ...inserts],
        after: (done) => {
          const now = done.remap(para.id);
          const paras = done.result.state.nodes.filter((n) => n.kind === "paragraph");
          const at = paras.findIndex((n) => n.id === now);
          editAt(store, at >= 0 ? (paras[at + lines.length - 1]?.id ?? null) : null, last.length);
        },
      };
    },
    { skipCommit: true },
  );
}

/** Tab / Shift+Tab in a table: edit (or, without an open editor, select) the next / previous cell. */
export function tabToCell(store: DocsStore, step: 1 | -1): Promise<void> {
  return store.task((model) => {
    const editing = store.ui.editing;
    const para = model.byId.get(editing?.para ?? store.host.getSnapshot().selection[0] ?? "");
    if (!para?.cell) return;
    const next = stepCell(model, para.cell, step);
    const target = next && paraInCell(model, next);
    if (!target) {
      store.info(step > 0 ? "Last cell of the table." : "First cell of the table.");
      return;
    }
    if (!editing) {
      store.host.select([target.id]);
      store.host.reveal({ address: target.id });
      return;
    }
    editAt(store, target.id, null);
    store.patchEditing({ selStart: 0, selEnd: (target.node.text ?? "").length });
  });
}

/** Arrow up/down at the edge of the editor: continue in the neighbouring paragraph. */
export function editNeighbour(store: DocsStore, step: -1 | 1): Promise<void> {
  return store.task((model) => {
    const editing = store.ui.editing;
    const para = editing && model.byId.get(editing.para);
    if (!para) return;
    for (let i = para.index + step; i >= 0 && i < model.paras.length; i += step) {
      const next = model.paras[i]!;
      if (pageOf(model.state, next.id) !== null && textIsComplete(next)) {
        editAt(store, next.id, step > 0 ? 0 : null);
        return;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Paragraph operations
// ---------------------------------------------------------------------------

export function insertParagraphNear(store: DocsStore, where: "above" | "below"): Promise<unknown> {
  return store.run(where === "above" ? "Insert paragraph above" : "Insert paragraph below", (model) => {
    const para = primary(store, model);
    bodyOnly(para, "Inserting a paragraph");
    return {
      ops: [ops.insertParagraph(para.id, where === "above" ? "before" : "after", "", { track: store.track() })],
      select: (done) => {
        const id = created(done, 0);
        return id ? [id] : null;
      },
      after: (done) => editAt(store, created(done, 0), 0),
    };
  });
}

export function deleteParagraphs(store: DocsStore, ids?: Address[]): Promise<unknown> {
  return store.run("Delete paragraph", (model) => {
    const paras = ids ? ids.flatMap((id) => model.byId.get(id) ?? []) : targetParas(store, model);
    if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
    for (const para of paras) bodyOnly(para, "Deleting a paragraph");
    const track = store.track();
    const last = paras[paras.length - 1]!;
    const after = bodyNeighbour(model, last, 1) ?? bodyNeighbour(model, paras[0]!, -1);
    store.cancelEdit();
    return {
      ops: paras.map((p) => ops.deleteNode(p.id, track)),
      select: (done) => {
        const next = after ? done.remap(after.id) : null;
        return next ? [next] : [];
      },
      reveal: true,
    };
  });
}

export function moveParagraph(store: DocsStore, step: -1 | 1): Promise<unknown> {
  return store.run(step < 0 ? "Move paragraph up" : "Move paragraph down", (model) => {
    const para = primary(store, model);
    bodyOnly(para, "Moving a paragraph");
    if (para.cell)
      throw new UserError("docs-move-in-table", "Paragraphs inside table cells cannot be moved by the engine.");
    const anchor = bodyNeighbour(model, para, step);
    if (!anchor) return null;
    return {
      ops: [ops.moveParagraph(para.id, anchor.id, step < 0 ? "before" : "after")],
      select: (done) => [done.remap(para.id) ?? para.id],
      reveal: true,
    };
  });
}

export function applyStyle(store: DocsStore, styleId: string): Promise<unknown> {
  return store.run(`Style ${styleId}`, (model) => {
    if (!model.pkg.styles.some((s) => s.id === styleId)) {
      throw new UserError("docs-style-unknown", `The document defines no paragraph style "${styleId}".`);
    }
    const paras = targetParas(store, model);
    if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
    return { ops: paras.map((p) => ops.formatParagraph(p.id, { style: styleId })) };
  });
}

/** Heading level 1-9, or 0 for the default paragraph style. */
export function applyHeading(store: DocsStore, level: number): Promise<unknown> {
  const model = store.model();
  if (!model) return Promise.resolve(null);
  const style = level === 0 ? styleById(model.pkg, null) : model.pkg.styles.find((s) => s.heading === level);
  if (!style) {
    store.fail(
      "docs-style-unknown",
      level === 0
        ? "The document has no default paragraph style."
        : `The document defines no "heading ${level}" style.`,
    );
    return Promise.resolve(null);
  }
  return applyStyle(store, style.id);
}

/** Indent (+1) / outdent (-1): list level for list items, left indent otherwise. */
export function indentParagraphs(store: DocsStore, step: 1 | -1): Promise<unknown> {
  return store.run(
    step > 0 ? "Indent" : "Outdent",
    (model) => {
      const paras = targetParas(store, model);
      if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
      const out = [];
      for (const para of paras) {
        if (para.node.list_level !== undefined) {
          const level = Math.max(0, Math.min(8, para.node.list_level + step));
          if (level !== para.node.list_level) out.push(ops.setListLevel(para.id, level));
        } else {
          const left = para.pkg?.leftPt ?? 0;
          const next = Math.max(0, Math.min(1584, left + step * 36));
          if (next !== left) out.push(ops.formatParagraph(para.id, { left: next }));
        }
      }
      return out.length > 0 ? { ops: out } : null;
    },
    { feature: "indent" },
  );
}

export function alignParagraphs(
  store: DocsStore,
  alignment: "left" | "center" | "right" | "justify",
): Promise<unknown> {
  return store.run(
    `Align ${alignment}`,
    (model) => {
      const paras = targetParas(store, model);
      if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
      return { ops: paras.map((p) => ops.formatParagraph(p.id, { alignment })) };
    },
    { feature: "align" },
  );
}

// ---------------------------------------------------------------------------
// Character formatting
// ---------------------------------------------------------------------------

export type FontKey = keyof ops.FontFormat;

export type Alignment = "left" | "center" | "right" | "justify";

/** What the toolbar shows: a member absent is unknown or mixed. */
export type KnownFormat = FormatMemory & { alignment?: Alignment; list?: ListKind | null };

/**
 * Formatting the toolbar shows for a paragraph, from observe: paragraph
 * `format` (style, alignment, list) and run `format` (character members) for
 * the runs under the editor's selection or caret, else every run.
 */
export function knownFormat(store: DocsStore, para: Para | undefined): KnownFormat {
  if (!para) return {};
  const model = store.model();
  const editing = store.ui.editing;
  const range = editing && editing.para === para.id ? { start: editing.selStart, end: editing.selEnd } : null;
  return {
    ...paragraphFormat(para.node),
    ...(model ? characterFormat(model.state, para.id, range) : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Paragraph `format` from observe (engine-ops-docx.md, observe members). */
function paragraphFormat(node: ViewNode): KnownFormat {
  const out: KnownFormat = {};
  const format = record(node.format);
  if (!format) return out;
  if (typeof format.style === "string") out.style = format.style;
  if (
    format.alignment === "left" ||
    format.alignment === "center" ||
    format.alignment === "right" ||
    format.alignment === "justify"
  )
    out.alignment = format.alignment;
  if (format.list === null) out.list = null;
  const list = record(format.list);
  if (list) out.list = list.kind === "bullet" ? "bullet" : list.kind === "numbered" ? "number" : null;
  return out;
}

/** One run's `format` as toolbar members. */
function runFormat(format: Record<string, unknown>): FormatMemory {
  const out: FormatMemory = {};
  if (typeof format.bold === "boolean") out.bold = format.bold;
  if (typeof format.italic === "boolean") out.italic = format.italic;
  if (typeof format.underline === "string") out.underline = format.underline as ops.FontFormat["underline"];
  if (typeof format.strike === "boolean") out.strike = format.strike;
  if (typeof format.size === "number") out.size = format.size;
  if (typeof format.name === "string") out.name = format.name;
  // "auto" is the automatic colour: no direct value to show.
  if (typeof format.color === "string" && format.color !== "auto") out.color = format.color;
  if (typeof format.highlight === "string") out.highlight = format.highlight;
  return out;
}

/**
 * Character formatting shared by the runs of a paragraph that overlap
 * [start, end) (UTF-16 offsets into the paragraph text); a collapsed range
 * takes the run before the caret. Members that differ between runs are left
 * out (mixed).
 */
function characterFormat(state: DocState, para: Address, range: { start: number; end: number } | null): FormatMemory {
  const picked: FormatMemory[] = [];
  let at = 0;
  let first: FormatMemory | null = null;
  for (const node of state.nodes) {
    if (node.parent !== para) continue;
    const start = at;
    at += (node.text ?? "").length;
    const format = node.kind === "run" ? record(node.format) : null;
    if (!format) continue;
    const run = runFormat(format);
    first ??= run;
    const hit = !range
      ? true
      : range.end > range.start
        ? start < range.end && at > range.start
        : start < range.start && range.start <= at;
    if (hit) picked.push(run);
  }
  if (picked.length === 0 && first) picked.push(first);
  if (picked.length === 0) return {};
  const out: Record<string, unknown> = { ...picked[0] };
  for (const run of picked.slice(1)) {
    for (const key of Object.keys(out)) if ((run as Record<string, unknown>)[key] !== out[key]) delete out[key];
  }
  return out as FormatMemory;
}

/** The editor's selection as a scalar-value range, or null when nothing is selected. */
function editorRange(store: DocsStore, model: DocModel): { para: Para; start: number; end: number } | null {
  const editing = store.ui.editing;
  if (!editing || editing.selEnd <= editing.selStart) return null;
  const para = model.byId.get(editing.para);
  if (!para) return null;
  const text = para.node.text ?? "";
  return { para, start: ops.scalarOffset(text, editing.selStart), end: ops.scalarOffset(text, editing.selEnd) };
}

/**
 * Character formatting for the editor's selection (`format` with a `range`),
 * else for whole paragraphs. `format` does not take `track`, so in
 * track-changes mode the change is applied untracked.
 */
export function formatFont(store: DocsStore, font: ops.FontFormat, label: string, feature: string): Promise<unknown> {
  return store.run(
    label,
    (model) => {
      const range = editorRange(store, model);
      if (range) return { ops: [ops.formatFontRange(range.para.id, range.start, range.end, font)] };
      const paras = targetParas(store, model);
      if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
      return { ops: paras.map((p) => ops.formatFont(p.id, font)) };
    },
    { feature },
  );
}

/** Bold / italic / strike toggles: off when the known state is on, else on. */
export function toggleFont(store: DocsStore, key: "bold" | "italic" | "strike"): Promise<unknown> {
  const model = store.model();
  const para = model ? targetParas(store, model)[0] : undefined;
  const on = knownFormat(store, para)[key] === true;
  const label = { bold: "Bold", italic: "Italic", strike: "Strikethrough" }[key];
  return formatFont(store, { [key]: !on }, label, key);
}

export function toggleUnderline(store: DocsStore): Promise<unknown> {
  const model = store.model();
  const para = model ? targetParas(store, model)[0] : undefined;
  const current = knownFormat(store, para).underline;
  const on = current !== undefined && current !== "none";
  return formatFont(store, { underline: on ? "none" : "single" }, "Underline", "underline");
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Toggle bulleted / numbered list membership: `set-list` on every target
 * paragraph, `none` when the first is already that kind (numbering that comes
 * from the paragraph style is overridden the same way). `set-list` does not
 * take `track`, so in track-changes mode the change is applied untracked.
 */
export function toggleList(store: DocsStore, kind: ListKind): Promise<unknown> {
  const label = kind === "bullet" ? "Bulleted list" : "Numbered list";
  return store.run(
    label,
    (model) => {
      const paras = targetParas(store, model);
      if (paras.length === 0) throw new UserError("docs-no-selection", "Select a paragraph first.");
      const on = paragraphFormat(paras[0]!.node).list === kind;
      const setting: ops.ListSetting = on ? "none" : kind === "bullet" ? "bullet" : "numbered";
      return { ops: paras.map((p) => ops.setList(p.id, setting)) };
    },
    { feature: "list" },
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function cellOf(store: DocsStore, model: DocModel): { para: Para; full: DocModel } {
  const para = primary(store, model);
  if (!para.cell) throw new UserError("docs-not-in-table", "Select a paragraph inside a table cell first.");
  return { para, full: model };
}

/** 0-based grid column where a cell starts (observe `grid_column`), and how many it spans. */
function gridOf(cell: CellPosition): { start: number; span: number } {
  return { start: cell.gridCol ?? cell.col - 1, span: cell.colSpan ?? 1 };
}

export function insertTable(store: DocsStore, rows: number, cols: number): Promise<unknown> {
  return store.run("Insert table", (full) => {
    let para = primary(store, full);
    bodyOnly(para, "Inserting a table");
    if (para.cell) {
      // Tables go next to body-level paragraphs: use the paragraph after this table.
      para = bodyNeighbour(full, para, 1) ?? bodyNeighbour(full, para, -1) ?? para;
      if (para.cell)
        throw new UserError("docs-table-anchor", "No body paragraph next to this table to anchor a new table.");
    }
    const grid = Array.from({ length: Math.max(1, rows) }, () => Array.from({ length: Math.max(1, cols) }, () => ""));
    return {
      ops: [ops.insertTable(para.id, "after", grid)],
      select: (done) => [done.remap(para.id) ?? para.id],
      reveal: true,
    };
  });
}

export function insertRow(store: DocsStore, where: "above" | "below"): Promise<unknown> {
  return store.run(where === "above" ? "Insert row above" : "Insert row below", (model) => {
    const { para, full } = cellOf(store, model);
    const cell = para.cell!;
    const width = full.tables.get(cell.table)?.rows[cell.row - 1] ?? 1;
    return {
      ops: [
        ops.insertRow(
          rowAddress(cell.table, cell.row),
          where === "above" ? "before" : "after",
          Array.from({ length: width }, () => ""),
        ),
      ],
      select: (done) => [done.remap(para.id) ?? para.id],
      reveal: true,
    };
  });
}

export function deleteRow(store: DocsStore): Promise<unknown> {
  return store.run("Delete row", (model) => {
    const { para, full } = cellOf(store, model);
    const cell = para.cell!;
    const shape = full.tables.get(cell.table);
    if (shape && shape.rows.length <= 1)
      throw new UserError("docs-last-row", "This is the only row; delete the table instead.");
    const neighbourRow = cell.row < (shape?.rows.length ?? 0) ? cell.row + 1 : cell.row - 1;
    const stay = paraInCell(full, { table: cell.table, row: neighbourRow, col: 1 });
    store.cancelEdit();
    return {
      ops: [ops.deleteNode(rowAddress(cell.table, cell.row))],
      select: (done) => {
        const id = stay ? done.remap(stay.id) : null;
        return id ? [id] : [];
      },
      reveal: true,
    };
  });
}

export function insertColumn(store: DocsStore, where: "left" | "right"): Promise<unknown> {
  return store.run(where === "left" ? "Insert column left" : "Insert column right", (model) => {
    const { para } = cellOf(store, model);
    const cell = para.cell!;
    const grid = gridOf(cell);
    return {
      ops: [ops.insertColumn(tableAddress(cell.table), where === "left" ? grid.start : grid.start + grid.span)],
      select: (done) => [done.remap(para.id) ?? para.id],
      reveal: true,
    };
  });
}

export function deleteColumn(store: DocsStore): Promise<unknown> {
  return store.run(
    "Delete column",
    (model) => {
      const { para, full } = cellOf(store, model);
      const cell = para.cell!;
      const shape = full.tables.get(cell.table);
      if (shape && Math.max(...shape.rows) <= 1)
        throw new UserError("docs-last-column", "This is the only column; delete the table instead.");
      // Stay in the same row, in the cell that takes this one's place (or the one before it).
      const stay = paraInCell(full, { ...cell, col: cell.col + 1 }) ?? paraInCell(full, { ...cell, col: cell.col - 1 });
      store.cancelEdit();
      return {
        ops: [ops.deleteColumn(tableAddress(cell.table), gridOf(cell).start)],
        select: (done) => {
          const id = stay ? done.remap(stay.id) : null;
          return id ? [id] : [];
        },
        reveal: true,
      };
    },
    { feature: "col-delete" },
  );
}

export const isImage = (model: DocModel | null, id: Address | undefined): boolean =>
  !!model && !!id && model.state.nodes.some((n) => n.id === id && n.kind === "image");

/** Delete the selected picture; the paragraph holding it is selected afterwards. */
export function deleteImage(store: DocsStore, image: Address): Promise<unknown> {
  return store.run(
    "Delete picture",
    (model) => {
      const node = model.state.nodes.find((n) => n.id === image && n.kind === "image");
      if (!node) throw new UserError("docs-image-missing", "This picture is not in the current revision.");
      const para = typeof node.parent === "string" ? node.parent : null;
      return {
        ops: [ops.deleteImage(image)],
        select: (done) => {
          const id = para ? done.remap(para) : null;
          return id ? [id] : [];
        },
      };
    },
    { feature: "image-delete" },
  );
}

export function formatCell(store: DocsStore, format: ops.CellFormat, label: string): Promise<unknown> {
  return store.run(
    label,
    (model) => {
      const cells = targetParas(store, model)
        .map((p) => p.cell)
        .filter((c): c is NonNullable<typeof c> => !!c);
      if (cells.length === 0) throw new UserError("docs-not-in-table", "Select a paragraph inside a table cell first.");
      const unique = [...new Map(cells.map((c) => [cellAddress(c), c])).keys()];
      return { ops: unique.map((address) => ops.editCell(address, format)), reveal: true };
    },
    { feature: "cell" },
  );
}

// ---------------------------------------------------------------------------
// Comments and tracked changes
// ---------------------------------------------------------------------------

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 4);
}

function person(store: DocsStore): ops.Person {
  const author = store.ui.author.trim() || "Wolf Review";
  return { author, initials: initialsOf(author), created: ops.isoNow() };
}

export function addComment(store: DocsStore, text: string): Promise<unknown> {
  return store.run("Add comment", (model) => {
    if (!text.trim()) throw new UserError("docs-comment-empty", "Write the comment text first.");
    const para = primary(store, model);
    bodyOnly(para, "Commenting");
    const anchor = editorSpan(store, model) ?? para.id;
    return {
      ops: [ops.insertComment(anchor, text, person(store))],
      select: (done) => [done.remap(para.id) ?? para.id],
    };
  });
}

export function replyToComment(store: DocsStore, comment: Address, text: string): Promise<unknown> {
  return store.run("Reply to comment", () => {
    if (!text.trim()) throw new UserError("docs-comment-empty", "Write the reply text first.");
    return { ops: [ops.insertReply(comment, text, person(store))] };
  });
}

export function deleteComment(store: DocsStore, id: Address): Promise<unknown> {
  return store.run("Delete comment", () => ({ ops: [ops.deleteNode(id)] }));
}

export function editComment(store: DocsStore, id: Address, text: string): Promise<Done | null> {
  return store.run(
    "Edit comment",
    (model) => {
      if (!text.trim()) throw new UserError("docs-comment-empty", "A comment needs text; delete it instead.");
      if (!model.state.nodes.some((n) => n.id === id))
        throw new UserError("docs-comment-missing", "This comment is not in the current revision.");
      return { ops: [ops.setCommentText(id, text)] };
    },
    { feature: "comment-edit" },
  );
}

export function reviewRevisions(store: DocsStore, ids: Address[], action: "accept" | "reject"): Promise<unknown> {
  const what = ids.length === 1 ? "change" : "all changes";
  return store.run(`${action === "accept" ? "Accept" : "Reject"} ${what}`, (model) => {
    const present = ids.filter((id) => model.state.nodes.some((n) => n.id === id));
    if (present.length === 0) return null;
    return { ops: present.map((id) => ops.review(id, action)) };
  });
}

// ---------------------------------------------------------------------------
// Find and replace
// ---------------------------------------------------------------------------

export type Match = { para: Address; offset: number; ordinal: number };

export function findMatches(model: DocModel | null, query: string): Match[] {
  if (!model || query === "") return [];
  const out: Match[] = [];
  for (const para of model.paras) {
    const text = para.node.text ?? "";
    let ordinal = 0;
    for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + Math.max(1, query.length))) {
      out.push({ para: para.id, offset: i, ordinal: ordinal++ });
    }
  }
  return out;
}

export function replaceOne(store: DocsStore, match: Match, query: string, replacement: string): Promise<unknown> {
  return store.run("Replace", (model) => {
    const para = model.byId.get(match.para);
    const text = para?.node.text ?? "";
    if (!para || text.slice(match.offset, match.offset + query.length) !== query) {
      throw new UserError("docs-match-stale", "The match moved; search again.");
    }
    const start = ops.scalarOffset(text, match.offset);
    const end = ops.scalarOffset(text, match.offset + query.length);
    return {
      ops: [ops.spliceText(para.id, start, end, replacement, store.track())],
      select: (done) => [done.remap(para.id) ?? para.id],
    };
  });
}

export function replaceAll(store: DocsStore, query: string, replacement: string): Promise<unknown> {
  let expected = 0;
  return store
    .run(`Replace all "${query}"`, (model) => {
      if (query === "") return null;
      const paras = model.paras.filter((p) => (p.node.text ?? "").includes(query));
      expected = findMatches(model, query).length;
      if (paras.length === 0) {
        store.info(`No matches for "${query}".`);
        return null;
      }
      const track = store.track();
      return { ops: paras.map((p) => ops.replaceText(p.id, query, replacement, { occurrence: "all", track })) };
    })
    .then((done) => {
      if (!done) return;
      const replaced = done.result.transaction.ops.reduce(
        (sum, op) => sum + (typeof op.matches === "number" ? op.matches : 0),
        0,
      );
      if (replaced < expected) {
        store.fail(
          "docs-replace-partial",
          `Replaced ${replaced} of ${expected} matches; the rest cross differently formatted runs, which the engine does not join.`,
        );
      } else store.info(`Replaced ${replaced} ${replaced === 1 ? "match" : "matches"}.`);
    });
}

// ---------------------------------------------------------------------------
// Hyperlinks and images
// ---------------------------------------------------------------------------

export function insertLink(store: DocsStore, text: string, target: ops.LinkTarget, tooltip: string): Promise<unknown> {
  return store.run("Insert link", (model) => {
    if (!text.trim()) throw new UserError("docs-link-text", "Enter the link text.");
    const para = primary(store, model);
    const span = editorSpan(store, model);
    return {
      ops: [ops.insertHyperlink(span ?? para.id, span ? "after" : "last-child", text, target, tooltip || undefined)],
      select: (done) => [done.remap(para.id) ?? para.id],
    };
  });
}

export function retargetLink(
  store: DocsStore,
  link: Address,
  change: { url?: string; text?: string; tooltip?: string },
): Promise<unknown> {
  return store.run("Edit link", () => ({ ops: [ops.retargetHyperlink(link, change)] }));
}

const MEDIA: Record<string, ops.ImageMedia> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/gif",
  "image/bmp": "image/bmp",
};
const EMU_PER_PX = 9525;
const EMU_PER_PT = 12700;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function insertImageFile(store: DocsStore, file: File): Promise<unknown> {
  const mediaType = MEDIA[file.type];
  if (!mediaType) {
    store.fail(
      "docs-image-type",
      `Pictures must be PNG, JPEG, GIF or BMP (this file is ${file.type || "of unknown type"}).`,
    );
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    store.fail("docs-image-unreadable", "The picture could not be decoded to read its size.");
    return null;
  }
  return store.run("Insert picture", (model) => {
    const para = primary(store, model);
    bodyOnly(para, "Inserting a picture");
    const region = model.state.regions.find((r) => r.object_id === para.id);
    const maxEmu = (region ? region.bbox_pt[2] : 468) * EMU_PER_PT;
    let cx = width * EMU_PER_PX;
    let cy = height * EMU_PER_PX;
    if (cx > maxEmu) {
      cy = (cy * maxEmu) / cx;
      cx = maxEmu;
    }
    return {
      ops: [
        ops.insertImage(para.id, "after", {
          mediaType,
          base64: toBase64(bytes),
          altText: file.name.replace(/\.[^.]+$/, ""),
          cxEmu: cx,
          cyEmu: cy,
        }),
      ],
      select: (done) => {
        const id = created(done, 0);
        const holder = id?.replace(/\/image:@\d+$/, "");
        return holder ? [holder] : null;
      },
    };
  });
}
