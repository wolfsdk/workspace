// What every document reader of this package produces, whatever the format. A reader parses the package once
// (`readDocument` in `index.ts`) and then answers the four views `doc_read` has, plus the text units that
// `doc_search` matches against. Addresses follow the Agent API grammar of `docs/agent-api.md`.
import type { WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";

export type BlockMeta = Record<string, string | number | boolean | null>;

/** One addressable unit of a document, listed by the `structure` view in document order. */
export type Block = {
  /** The canonical address: `para:#3A1F09C2` (or `para:@3` when the file has no id), `table:@1`,
   * `slide:#258/shape:#4`, `sheet:#1`, `page:2`. */
  address: string;
  /** Other addresses that name the same unit (`para:@3` for a paragraph that has a `w14:paraId`). */
  aliases?: readonly string[];
  /** `heading`, `paragraph`, `table`, `row`, `slide`, `shape`, `notes`, `sheet`, `bookmark`, `page`, ... */
  kind: string;
  /** Nesting below the document: 0 for a top-level unit (a body paragraph, a slide, a sheet, a page). */
  depth: number;
  /** The plain text of the unit itself, children excluded; empty for a container such as a table. */
  text: string;
  /** A name or style: the sheet name, the shape name, `Heading1`. */
  label?: string;
  /** Format specific scalars: `rows`, `columns`, `level`, `sheet_id`, `dimension`, `slide_id`. */
  meta?: BlockMeta;
};

export type CellValue = string | number | boolean | null;

/** One stored cell of a worksheet, as the file holds it: dates are serial numbers and a formula cell carries
 * its cached value. */
export type CellEntry = {
  sheet: string;
  sheet_id: number;
  /** A1 reference, no sheet and no `$`. */
  ref: string;
  /** `sheet:#<sheet_id>/cell:<ref>`. */
  address: string;
  value: CellValue;
  /** The formula with a leading `=`, for a formula cell. */
  formula?: string;
  type: "number" | "string" | "boolean" | "error" | "empty";
};

/** A piece of text that search matches against and reports at `address`. */
export type SearchUnit = { address: string; text: string };

/** `invalid-input`: the bytes are not a package of this format. `address-unresolved`: `target` names nothing in
 * the document, or is an address grammar this reader does not read. `unsupported-view`: the view does not apply
 * to this format (`cells` of a Word document). */
export type ReadErrorCode = "invalid-input" | "address-unresolved" | "unsupported-view";

export class ReadError extends Error {
  readonly code: ReadErrorCode;

  constructor(code: ReadErrorCode, message: string) {
    super(message);
    this.name = "ReadError";
    this.code = code;
  }
}

/** A parsed document. Parsing happens once, in the function that returns it; each method reads the result and
 * is deterministic. `target` is an Agent API address of this format: the view is restricted to that unit and
 * what lies below it, and an address that names nothing throws `ReadError` `address-unresolved`. */
export interface ReadableDocument {
  readonly format: WorkspaceDocFormat;
  /** The addressable units in document order, those at or below `target` when it is given. */
  blocks(target?: string): Block[];
  /** The text of the document, one paragraph, table row or line per line, those at or below `target`. A table
   * row is its cells joined by a tab; a worksheet is its used rows the same way, with a line `# <sheet name>`
   * before it. */
  text(target?: string): string;
  /** The same content as markdown: `# ` headings, pipe tables, `- ` list items, `## Slide n` and `## Page n`
   * sections, one blank line between blocks. */
  markdown(target?: string): string;
  /** The stored cells of a workbook in sheet, row, column order, restricted to `target` (a `sheet:` address with
   * an optional `/cell:<A1>` or `/range:<A1>:<A1>`). Throws `unsupported-view` for any other format. */
  cells(target?: string): CellEntry[];
  /** What search matches against, in document order: a text unit per paragraph, table cell, shape paragraph or
   * notes paragraph, per non-empty worksheet cell (`text` is the value, then two spaces and the formula for a
   * formula cell), per PDF page. */
  units(): SearchUnit[];
}
