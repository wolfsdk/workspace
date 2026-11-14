/**
 * Every DOCX operation the docs plugin sends, in one place. Shapes follow
 * `docs/ops-docx.md` and `docs/engine-ops-docx.md` (`splice-text`,
 * `split-paragraph`, `join-paragraph`, `set-list`, range formatting,
 * alignment, strike and highlight). Correct a shape here and every caller
 * follows; `scripts/ops-check.ts` compares these constructors with the
 * examples in engine-ops-docx.md.
 */
import type { Address, Op } from "@wolfsdk/protocol";

/** `revision:#n` addresses the batch's tracked operations created (engine-ops-docx.md, receipt changes). */
export function createdRevisions(transaction: { ops: { [member: string]: unknown }[] }): Address[] {
  const out: Address[] = [];
  for (const op of transaction.ops) {
    if (Array.isArray(op.revisions)) for (const id of op.revisions) if (typeof id === "string") out.push(id);
  }
  return out;
}

/** Tracked-change metadata (`track` member). */
export type Track = { author: string; created?: string };

/** Characters XML 1.0 cannot store. The engine accepts them and then writes
 * an unreadable document (ops-docx.md 4.1 HAZARD), so strip before sending. */
const XML_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(XML_INVALID, "");
}

function withTrack<T extends Op>(op: T, track: Track | null | undefined): T {
  return track ? { ...op, track: { ...track } } : op;
}

/** ISO 8601 UTC to the second, the form the engine stores in `w:date`. */
export function isoNow(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Replace characters [start, end) of a paragraph's observe `text` (Unicode
 * scalar values; a tab or text-wrapping break counts one) with `text`;
 * `start == end` inserts. Only touched runs change. Editing-ops module only.
 */
export function spliceText(target: Address, start: number, end: number, text: string, track?: Track | null): Op {
  return withTrack({ op: "splice-text", target, start, end, text: cleanText(text) }, track);
}

/** Replace the whole text of a paragraph or table cell. Flattens the paragraph to one run (engine-ops-docx.md, UI rules): last resort only. */
export function setText(target: Address, text: string, track?: Track | null): Op {
  return withTrack({ op: "set", target, value: { text: cleanText(text) } }, track);
}

/** Offsets in the engine's unit (Unicode scalar values) for a JS string offset (UTF-16 code units). */
export function scalarOffset(text: string, utf16: number): number {
  let n = 0;
  for (let i = 0; i < utf16 && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) i++;
    n++;
  }
  return n;
}

/** Literal, case-sensitive replace inside one paragraph. `occurrence`
 * defaults to every match in the engine; pass "first" for a single edit. */
export function replaceText(
  target: Address,
  find: string,
  replace: string,
  options: { occurrence?: "first" | "all" | number; track?: Track | null } = {},
): Op {
  const op: Op = { op: "replace-text", target, find: cleanText(find), replace: cleanText(replace) };
  if (options.occurrence !== undefined) op.occurrence = options.occurrence;
  return withTrack(op, options.track);
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

export type Position = "before" | "after";

export function insertParagraph(
  anchor: Address,
  position: Position,
  text: string,
  options: { style?: string; track?: Track | null } = {},
): Op {
  const node: { kind: string; text: string; style?: string } = { kind: "paragraph", text: cleanText(text) };
  if (options.style) node.style = options.style;
  return withTrack({ op: "insert", anchor, position, node }, options.track);
}

/** Copy of `from` (properties, runs and text) placed next to `anchor`. */
export function cloneParagraph(anchor: Address, position: Position, from: Address): Op {
  return { op: "insert", anchor, position, node: { kind: "paragraph", from } };
}

/** Delete a paragraph, comment, reply, table row or table. */
export function deleteNode(target: Address, track?: Track | null): Op {
  return withTrack({ op: "delete", target }, track);
}

export function moveParagraph(target: Address, anchor: Address, position: Position): Op {
  return { op: "move", target, anchor, position };
}

/** Enter: the paragraph keeps [0, offset), a new paragraph after it (same paragraph properties) gets the rest; `created` names it. Offset 0 puts the new empty paragraph before. No `track` member (engine-ops-docx.md, Answers A1). */
export function splitParagraph(target: Address, offset: number): Op {
  return { op: "split-paragraph", target, offset };
}

/** Backspace at offset 0: the previous sibling paragraph takes `target`'s content and keeps its own properties and address; `target` goes. No `track` member. */
export function joinParagraph(target: Address): Op {
  return { op: "join-paragraph", target };
}

export type ParagraphFormat = {
  style?: string;
  space_before?: number;
  space_after?: number;
  left?: number;
  right?: number;
  first_line?: number;
  line_spacing?: number;
  page_break_before?: boolean;
  alignment?: "left" | "center" | "right" | "justify";
};

export function formatParagraph(target: Address, paragraph: ParagraphFormat): Op {
  return { op: "format", target, format: { paragraph: { ...paragraph } } };
}

export type FontFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: "none" | "single" | "double";
  /** Points, a multiple of 0.5 from 1 to 409. */
  size?: number;
  name?: string;
  /** `#RRGGBB`. */
  color?: string;
  strike?: boolean;
  /** Word highlight name or "none". */
  highlight?: string;
};

/** Character formatting on a paragraph (every run), a run, or a span address. */
export function formatFont(target: Address, font: FontFormat): Op {
  return { op: "format", target, format: { font: { ...font } } };
}

/** Character formatting on characters [start, end) of a paragraph (scalar-value offsets). */
export function formatFontRange(target: Address, start: number, end: number, font: FontFormat): Op {
  return { op: "format", target, range: { start, end }, format: { font: { ...font } } };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** New list item next to an existing one; `level` omitted copies the anchor's. */
export function insertListItem(anchor: Address, position: Position, text: string, level?: number): Op {
  const op: Op = { op: "insert-list-item", anchor, position, text: cleanText(text) };
  if (level !== undefined) op.level = level;
  return op;
}

export function setListLevel(target: Address, level: number): Op {
  return { op: "set-list-level", target, level };
}

export type ListSetting = "bullet" | "numbered" | "none";

/** Make a paragraph a bulleted / numbered list item (joining a neighbouring list of that kind) or plain. `level` omitted keeps the current one. Editing-ops module only. */
export function setList(target: Address, list: ListSetting, level?: number): Op {
  const op: Op = { op: "set-list", target, list };
  if (level !== undefined) op.level = level;
  return op;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type CellFormat = {
  /** `#RRGGBB` or "none". */
  shading?: string;
  align?: "left" | "center" | "right" | "both";
  vertical_align?: "top" | "center" | "bottom";
};

export function editCell(target: Address, format: CellFormat): Op {
  return { op: "edit-cell", target, ...format };
}

/** New row cloned from `anchor`'s structure; `cells` may be shorter than the row. */
export function insertRow(anchor: Address, position: Position, cells: string[]): Op {
  return { op: "insert-row", anchor, position, cells: cells.map(cleanText) };
}

/** Remove grid column `index` (0-based, as `insert-column`) and one cell per row. */
export function deleteColumn(table: Address, index: number): Op {
  return { op: "delete-column", target: table, index };
}

/** Remove a picture (`para:X/image:@n`); the media part stays. */
export function deleteImage(image: Address): Op {
  return { op: "delete", target: image };
}

/** New column at `index` (0 .. column count); one string per row at most. */
export function insertColumn(table: Address, index: number, cells: string[] = []): Op {
  const op: Op = { op: "insert-column", target: table, index };
  if (cells.length > 0) op.cells = cells.map(cleanText);
  return op;
}

/** Rectangular table after/before a body-level paragraph. */
export function insertTable(anchor: Address, position: Position, rows: string[][]): Op {
  return { op: "insert", anchor, position, node: { kind: "table", rows: rows.map((r) => r.map(cleanText)) } };
}

// ---------------------------------------------------------------------------
// Comments and review
// ---------------------------------------------------------------------------

export type Person = { author: string; initials?: string; created?: string };

function personNode(kind: "comment" | "reply", text: string, who: Person): Record<string, unknown> {
  const node: Record<string, unknown> = { kind, text: cleanText(text), author: who.author };
  if (who.initials) node.initials = who.initials;
  if (who.created) node.created = who.created;
  return node;
}

/** Replace a comment's text, one paragraph per line; only `word/comments.xml` changes. */
export function setCommentText(comment: Address, text: string): Op {
  return { op: "set", target: comment, value: { text: cleanText(text) } };
}

/** Comment on a paragraph or a `para:X/span:text` range. */
export function insertComment(anchor: Address, text: string, who: Person): Op {
  return { op: "insert", anchor, position: "last-child", node: personNode("comment", text, who) };
}

export function insertReply(comment: Address, text: string, who: Person): Op {
  return { op: "insert", anchor: comment, position: "last-child", node: personNode("reply", text, who) };
}

/** Accept or reject a revision, or every revision in a paragraph / span. */
export function review(target: Address, action: "accept" | "reject", author?: string): Op {
  const op: Op = { op: "review", target, action };
  if (author) op.author = author;
  return op;
}

// ---------------------------------------------------------------------------
// Hyperlinks and images
// ---------------------------------------------------------------------------

export type LinkTarget = { url: string } | { bookmark: string };

/** New linked text at the end of a paragraph (`last-child`) or after a span. */
export function insertHyperlink(
  anchor: Address,
  position: "last-child" | "after",
  text: string,
  target: LinkTarget,
  tooltip?: string,
): Op {
  const op: Op = { op: "insert-hyperlink", anchor, position, text: cleanText(text), ...target };
  if (tooltip) op.tooltip = cleanText(tooltip);
  return op;
}

export function retargetHyperlink(target: Address, change: { url?: string; text?: string; tooltip?: string }): Op {
  const op: Op = { op: "retarget-hyperlink", target };
  if (change.url !== undefined) op.url = change.url;
  if (change.text !== undefined) op.text = cleanText(change.text);
  if (change.tooltip !== undefined) op.tooltip = cleanText(change.tooltip);
  return op;
}

export type ImageMedia = "image/png" | "image/jpeg" | "image/gif" | "image/bmp";

/** Picture in a new paragraph (`before`/`after`) or at the end of the anchor (`last-child`). */
export function insertImage(
  anchor: Address,
  position: Position | "last-child",
  image: { mediaType: ImageMedia; base64: string; altText?: string; cxEmu: number; cyEmu: number },
): Op {
  const node: Record<string, unknown> = {
    kind: "image",
    media_type: image.mediaType,
    data: image.base64,
    extent: { cx_emu: Math.max(1, Math.round(image.cxEmu)), cy_emu: Math.max(1, Math.round(image.cyEmu)) },
  };
  if (image.altText) node.alt_text = cleanText(image.altText);
  return { op: "insert", anchor, position, node };
}
