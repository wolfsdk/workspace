// The eight tools of `wolfsdk.mcp-workspace.v1`, over a `RoomService`. Each tool is a few room calls and a
// result: it reads or writes through the service (so every guarantee of the room holds: revisions, proposals,
// the session log) and announces what it is doing with `agent.activity` while it runs. The tool list itself
// (names, schemas, descriptions) lives in `@wolfsdk/protocol`; this file only runs the calls that validated.
import {
  type McpWorkspaceCall,
  type McpWorkspaceToolName,
  type PackBinding,
  type PackManifest,
  type PackSelector,
  type PackTargetKind,
  type RoomActor,
  type RoomAgentActivity,
  type RoomHead,
  type RoomProposal,
  type RoomState,
  type RoomThread,
} from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, readOnlyFailure, type ReadOnlyMode, type Result, type RoomFailure, type RoomService } from "@wolfsdk/server";
import {
  type CellView,
  type DocContent,
  type DocView,
  PackRefreshError,
  type PackRefresher,
  type StructureNode,
  VisualPageError,
  type VisualRenderer,
  type WorkspaceDocInspector,
} from "./hooks.ts";
import { blankDocument, type Block, type CellEntry, type CellValue, type ReadableDocument, ReadError, readDocument } from "./read/index.ts";
import { errorResult, type ImageBlock, imageBlock, okResult, type ToolResult } from "./results.ts";

export type WorkspaceToolsOptions = {
  service: RoomService;
  /** The room every tool works in. */
  roomId: string;
  /** Reads documents better than the built-in readers do; a request it declines falls back to them. */
  inspector?: WorkspaceDocInspector;
  /** Draws pages for `doc_inspect_visual`. Without it that tool answers `BAD_REQUEST`. */
  renderer?: VisualRenderer;
  /** Lists and refreshes packs. Without it `pack_link_refresh` answers `BAD_REQUEST`. */
  packs?: PackRefresher;
  /** The manifests (`pack.wolf.json`) of the workspace's packs. With it `workspace_list` lists the packs of these
   * manifests and describes each binding: its target kind, the cells it reads (a defined name or table resolved to
   * its sheet cell or range), the value the room's head of the source workbook holds there, and the target it
   * writes. Without it the packs come from `packs.listPacks`, by binding id only. The manifests are asked for on
   * every `workspace_list`. */
  packManifests?: () => Promise<PackManifest[]>;
  /** The workspace refuses every write. The four write tools (`doc_create`, `doc_edit`, `comment_reply`,
   * `pack_link_refresh`) answer with that refusal before they read or validate anything else. The room service
   * refuses the same writes itself: this makes the answer come first, and covers a refresher that would report the
   * refusal as a failed binding. Pass the value the room service was given. */
  readOnly?: ReadOnlyMode;
};

type Args<N extends McpWorkspaceToolName> = Extract<McpWorkspaceCall, { name: N }>["arguments"];

/** The tools that write to the room: what a read-only workspace refuses. */
const WRITE_TOOLS: Readonly<Record<string, true>> = { doc_create: true, doc_edit: true, comment_reply: true, pack_link_refresh: true };

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_MAX_NODES = 400;
const DEFAULT_DPI = 96;
/** Pages one `doc_inspect_visual` call renders: each is an image the agent pays for. */
export const MAX_VISUAL_PAGES = 8;
const PREVIEW_CHARS = 160;
const SNIPPET_CONTEXT = 60;
/** Maximum characters inspected per unit during regular-expression search. */
const REGEX_UNIT_CHARS = 20_000;
/** Wall-clock deadline for a regular-expression scan in its isolated worker before `terminate()`. */
const REGEX_SEARCH_TIMEOUT_MS = 500;
const failure = (f: RoomFailure): ToolResult => errorResult(f.code, f.message, "detail" in f ? f.detail : undefined);

function preview(text: string, limit = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
}

function node(block: Block): StructureNode {
  const out: StructureNode = { address: block.address, kind: block.kind, depth: block.depth };
  if (block.label !== undefined && block.label !== "") out.label = block.label;
  const text = preview(block.text);
  if (text !== "") out.text = text;
  if (block.aliases && block.aliases.length > 0) out.aliases = [...block.aliases];
  if (block.meta && Object.keys(block.meta).length > 0) out.meta = block.meta;
  return out;
}

/** `node` with its text cut to a preview. An inspector lists a unit with its whole text. */
function previewed(node: StructureNode): StructureNode {
  if (node.text === undefined || node.text.length <= PREVIEW_CHARS) return node;
  return { ...node, text: preview(node.text) };
}

/** What the built-in reader makes of `view`. */
function builtIn(doc: ReadableDocument, view: DocView, target: string | undefined): DocContent {
  switch (view) {
    case "structure":
      return { view, nodes: doc.blocks(target).map(node) };
    case "text":
      return { view, text: doc.text(target) };
    case "markdown":
      return { view, text: doc.markdown(target) };
    case "cells":
      return {
        view,
        cells: doc.cells(target).map((cell): CellView => {
          const out: CellView = { address: cell.address, value: cell.value };
          if (cell.formula !== undefined) out.formula = cell.formula;
          return out;
        }),
      };
  }
}

/** The first `max` lines of `text`, and whether there were more. */
function cutLines(text: string, max: number): { text: string; lines: number; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, lines: lines.length, truncated: false };
  return { text: lines.slice(0, max).join("\n"), lines: lines.length, truncated: true };
}

type Span = { start: number; end: number };
type Matcher = (text: string) => Span | undefined;

/** Case-insensitive literal matcher. */
function literalMatcher(query: string): Matcher {
  const needle = query.toLowerCase();
  return (text) => {
    const hay = text.toLowerCase();
    if (hay.length === text.length) {
      const at = hay.indexOf(needle);
      return at < 0 ? undefined : { start: at, end: at + needle.length };
    }
    const at = text.indexOf(query);
    return at < 0 ? undefined : { start: at, end: at + query.length };
  };
}

const REGEX_WORKER_SOURCE = `
self.onmessage = (ev) => {
  const { query, limit, maxChars, texts } = ev.data;
  const pattern = new RegExp(query, "giu");
  const matches = [];
  let truncated = false;
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i];
    const subject = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    pattern.lastIndex = 0;
    let span = null;
    for (let m = pattern.exec(subject); m; m = pattern.exec(subject)) {
      if (m[0].length > 0) {
        span = { start: m.index, end: m.index + m[0].length };
        break;
      }
      pattern.lastIndex += 1;
    }
    if (!span) continue;
    if (matches.length === limit) {
      truncated = true;
      break;
    }
    matches.push({ index: i, start: span.start, end: span.end });
  }
  self.postMessage({ matches, truncated });
};
`;

async function runRegexSearchInWorker(
  query: string,
  texts: readonly string[],
  limit: number,
): Promise<{ ok: true; matches: { index: number; start: number; end: number }[]; truncated: boolean } | { ok: false }> {
  if (texts.length === 0) return { ok: true, matches: [], truncated: false };
  const blobUrl = URL.createObjectURL(new Blob([REGEX_WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(blobUrl);
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false });
    }, REGEX_SEARCH_TIMEOUT_MS);
    worker.onmessage = (ev: MessageEvent<{ matches: { index: number; start: number; end: number }[]; truncated: boolean }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, matches: ev.data.matches, truncated: ev.data.truncated });
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false });
    };
    worker.postMessage({ query, limit, maxChars: REGEX_UNIT_CHARS, texts });
  });
}

/** `text` around `span`, whitespace collapsed, `...` where it was cut. */
function snippet(text: string, span: Span): string {
  let from = Math.max(0, span.start - SNIPPET_CONTEXT);
  let to = Math.min(text.length, span.end + SNIPPET_CONTEXT);
  if (from > 0 && (text.charCodeAt(from) & 0xfc00) === 0xdc00) from--;
  if (to < text.length && (text.charCodeAt(to - 1) & 0xfc00) === 0xd800) to++;
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "..." : ""}${body}${to < text.length ? "..." : ""}`;
}

const MENTION = /(?<![A-Za-z0-9._:-])@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/g;

/** The kind of every actor the room has seen, by id. */
function knownActors(room: RoomState): Map<string, RoomActor["kind"]> {
  const known = new Map<string, RoomActor["kind"]>();
  const see = (actor: { id: string; kind: RoomActor["kind"] }): void => {
    if (!known.has(actor.id)) known.set(actor.id, actor.kind);
  };
  for (const entry of room.session_log) see(entry.author);
  for (const proposal of room.proposals) see(proposal.author);
  for (const thread of room.comments) {
    for (const mention of thread.mentions) see(mention);
    for (const message of thread.messages) see(message.author);
  }
  return known;
}

/** The `@id` mentions of `body` that name an actor the room has seen, and the ids that name nobody. */
function mentionsOf(body: string, known: ReadonlyMap<string, RoomActor["kind"]>): { mentions: { kind: RoomActor["kind"]; id: string }[]; unresolved: string[] } {
  const mentions: { kind: RoomActor["kind"]; id: string }[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const written = match[1] as string;
    // "@alice." ends a sentence: the id of the actor is the longest of the two readings that the room knows.
    const id = [written, written.replace(/[._:-]+$/, "")].find((candidate) => known.has(candidate));
    if (id === undefined) {
      const bare = written.replace(/[._:-]+$/, "");
      if (!unresolved.includes(bare)) unresolved.push(bare);
    } else if (!seen.has(id)) {
      seen.add(id);
      mentions.push({ kind: known.get(id) as RoomActor["kind"], id });
    }
  }
  return { mentions, unresolved };
}

// Pack bindings -------------------------------------------------------------------------------------------------

/** Cells of a range source value `workspace_list` shows; `doc_read` of `source_address` reads all of them. */
const MAX_BINDING_VALUE_CELLS = 50;

/** One binding of a pack as `workspace_list` describes it (`$defs.pack_binding_definition` of the schema). */
type BindingDefinition = {
  id: string;
  kind: PackTargetKind;
  selector: PackSelector;
  source_doc: string | null;
  source_address: string | null;
  source_revision?: number;
  value?: CellValue | CellValue[][];
  value_truncated?: true;
  target_doc: string;
  target_address: string;
  problem?: string;
};

/** A source workbook as the room holds it, with its defined names once asked for, or why it can not be read. */
type SourceBook = { doc: ReadableDocument; revision: number; names?: Block[] } | { problem: string };

/** What a binding reads: an area of one sheet, a constant (a defined name such as `0.2`), or why neither. */
type SourceArea = { sheet: string; ref: string };
type Resolution = { area: SourceArea } | { constant: CellValue } | { problem: string };

/** What `workspace_list` makes of a binding's source. */
type SourceRead = { address: string | null; revision?: number; value?: CellValue | CellValue[][]; truncated?: boolean; problem?: string };

/** `name` as an Agent API address key, written the way the built-in readers write one: `%`, `/` and control
 * characters percent-encoded, and a leading `#`, `@` or `~` too. */
function addressKey(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === "%" || ch === "/" || code < 0x20 ? `%${code.toString(16).toUpperCase().padStart(2, "0")}` : ch;
  }
  const first = out.charAt(0);
  if (first === "#" || first === "@" || first === "~") out = `%${(first.codePointAt(0) ?? 0).toString(16).toUpperCase()}${out.slice(1)}`;
  return out;
}

/** An A1 reference or range with its `$` anchors dropped. */
const bareRef = (ref: string): string => ref.replace(/\$/g, "").toUpperCase();

function cellOf(ref: string): { col: number; row: number } | undefined {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

function colName(col: number): string {
  let out = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

/** The Agent API address of `area`: `sheet:<name>/cell:B2` or `sheet:<name>/range:A1:C4`, which `doc_read` takes. */
function areaAddress(area: SourceArea): string {
  return `sheet:${addressKey(area.sheet)}/${area.ref.includes(":") ? "range" : "cell"}:${area.ref}`;
}

/** The Agent API address of a binding's target: a `docx_bookmark` names its bookmark, every other kind is already
 * an address. */
function targetAddress(binding: PackBinding): string {
  return binding.target_kind === "docx_bookmark" ? `bookmark:${addressKey(binding.target_address)}` : binding.target_address;
}

const DEFINED_AREA = /^(?:'((?:[^']|'')+)'|([^'!]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/;

/** What the defined name `wanted` stands for, chosen as a pack refresh chooses it: the exact name before a
 * case-insensitive match, a workbook-scoped name before a sheet-scoped one. */
function definedName(names: readonly Block[], wanted: string): Resolution {
  const matches = names.filter((name) => name.label === wanted || name.label?.toLowerCase() === wanted.toLowerCase());
  const exact = matches.filter((name) => name.label === wanted);
  const pool = exact.length > 0 ? exact : matches;
  const workbook = pool.filter((name) => name.meta?.sheet === null);
  const chosen = workbook.length > 0 ? workbook : pool;
  const [name] = chosen;
  if (name === undefined) return { problem: `the workbook has no defined name ${JSON.stringify(wanted)}` };
  if (chosen.length > 1) return { problem: `the defined name ${JSON.stringify(wanted)} is scoped to several sheets` };
  const formula = name.text.trim();
  const area = DEFINED_AREA.exec(formula);
  if (area) return { area: { sheet: area[1] !== undefined ? area[1].replace(/''/g, "'") : (area[2] as string), ref: bareRef(area[3] as string) } };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(formula)) return { constant: Number(formula) };
  const text = /^"((?:[^"]|"")*)"$/.exec(formula);
  if (text) return { constant: (text[1] as string).replace(/""/g, '"') };
  return { problem: `the defined name ${JSON.stringify(wanted)} is ${JSON.stringify(formula)}: not a cell, a range or a constant` };
}

/** The sheet area of the table `name`, header row included, as a pack refresh reads it. */
function tableArea(doc: ReadableDocument, name: string): Resolution {
  let blocks: Block[];
  try {
    blocks = doc.blocks(`table:${addressKey(name)}`);
  } catch (error) {
    if (error instanceof ReadError) return { problem: `the workbook has no table ${JSON.stringify(name)}` };
    throw error;
  }
  const sheet = blocks[0]?.meta?.sheet;
  const ref = blocks[0]?.meta?.ref;
  if (typeof sheet !== "string" || typeof ref !== "string") return { problem: `the table ${JSON.stringify(name)} has no sheet range` };
  return { area: { sheet, ref: bareRef(ref) } };
}

/** The defined names of `book`, read once. */
function namesOf(book: { doc: ReadableDocument; names?: Block[] }): Block[] {
  book.names ??= book.doc.blocks().filter((block) => block.kind === "name");
  return book.names;
}

function resolveSelector(selector: PackSelector, book: { doc: ReadableDocument; names?: Block[] }): Resolution {
  switch (selector.type) {
    case "cell":
    case "range":
      return { area: { sheet: selector.sheet, ref: bareRef(selector.ref) } };
    case "table":
      return tableArea(book.doc, selector.name);
    case "defined_name":
      return definedName(namesOf(book), selector.name);
  }
}

/** The stored values of `area`: one value for a cell, rows of values for a range (cut to
 * `MAX_BINDING_VALUE_CELLS`). A formula cell holds its cached value. */
function areaValue(doc: ReadableDocument, area: SourceArea): { value: CellValue | CellValue[][]; truncated: boolean } | { problem: string } {
  let cells: CellEntry[];
  try {
    cells = doc.cells(areaAddress(area));
  } catch (error) {
    if (error instanceof ReadError) return { problem: error.message };
    throw error;
  }
  const values = new Map(cells.map((cell) => [cell.ref, cell.value]));
  const [first, last = first] = area.ref.split(":");
  const from = cellOf(first as string);
  const to = cellOf(last as string);
  if (!from || !to) return { problem: `${area.ref} is not a cell or range of the sheet grid` };
  if (!area.ref.includes(":")) return { value: values.get(area.ref) ?? null, truncated: false };
  const width = to.col - from.col + 1;
  const height = to.row - from.row + 1;
  const cols = Math.min(width, MAX_BINDING_VALUE_CELLS);
  const rows = Math.min(height, Math.max(1, Math.floor(MAX_BINDING_VALUE_CELLS / cols)));
  const grid: CellValue[][] = [];
  for (let r = from.row; r < from.row + rows; r++) {
    const row: CellValue[] = [];
    for (let c = from.col; c < from.col + cols; c++) row.push(values.get(`${colName(c)}${r}`) ?? null);
    grid.push(row);
  }
  return { value: grid, truncated: cols < width || rows < height };
}

/** What `binding` reads from `book` (its source workbook as the room holds it). */
function readSource(binding: PackBinding, book: SourceBook): SourceRead {
  const direct = binding.selector.type === "cell" || binding.selector.type === "range" ? areaAddress({ sheet: binding.selector.sheet, ref: bareRef(binding.selector.ref) }) : null;
  if ("problem" in book) return { address: direct, problem: book.problem };
  const resolved = resolveSelector(binding.selector, book);
  if ("problem" in resolved) return { address: null, revision: book.revision, problem: resolved.problem };
  if ("constant" in resolved) return { address: null, revision: book.revision, value: resolved.constant };
  const address = areaAddress(resolved.area);
  const read = areaValue(book.doc, resolved.area);
  if ("problem" in read) return { address, revision: book.revision, problem: read.problem };
  return { address, revision: book.revision, value: read.value, truncated: read.truncated };
}

/** `binding` as `workspace_list` lists it, its members in the order an agent reads them: what it reads, the value
 * there, then where it writes. */
function bindingDefinition(binding: PackBinding, sourceDoc: string | null, read: SourceRead): BindingDefinition {
  return {
    id: binding.id,
    kind: binding.target_kind,
    selector: binding.selector,
    source_doc: sourceDoc,
    source_address: read.address,
    ...(read.revision === undefined ? {} : { source_revision: read.revision }),
    ...("value" in read ? { value: read.value } : {}),
    ...(read.truncated === true ? { value_truncated: true as const } : {}),
    target_doc: binding.target_doc,
    target_address: targetAddress(binding),
    ...(read.problem === undefined ? {} : { problem: read.problem }),
  };
}

// doc_edit ops ------------------------------------------------------------------------------------------------

type EditFormat = "docx" | "xlsx" | "pptx";

/** The Agent API operations a `doc_edit` batch may hold for each format, with the members each takes, as the engine
 * names them (`docs/agent-api.md` section 5.1; the operation guide of `@wolfsdk/assistant` names the same). The first
 * op of each format is the one for a text change. A refusal for an op name the engine does not know answers with
 * this list, so an agent that guessed a name is told the ones that exist instead of guessing again. */
const EDIT_OPS: Readonly<Record<EditFormat, Readonly<Record<string, string>>>> = {
  docx: {
    "replace-text": '{target, find, replace}: literal replacement inside a paragraph, run or span, for changing a few words',
    set: '{target, value: {"text": "..."}}: replace the whole text of a paragraph, run, span, table cell or field',
    "splice-text": "{target, start, end, text}: replace characters start to end of a paragraph",
    insert: '{anchor, position, node: {"kind": "paragraph", "text": "..."}}: add a paragraph, comment, reply or hyperlink',
    delete: "{target}: remove a paragraph, run, span, table or table row",
    move: "{target, anchor, position}: move a paragraph before or after another",
    format: '{target, format}: {"font": {...}} on a paragraph, run or span, {"paragraph": {...}} on a paragraph',
    "split-paragraph": "{target, offset}",
    "join-paragraph": "{target}: join a paragraph to the one before it",
    "insert-hyperlink": "{anchor, position, text, url}",
    "retarget-hyperlink": "{target, url}",
    "insert-row": '{anchor, position, cells: ["..."]}',
    "insert-column": "{target, index}",
    "delete-column": "{target, index}",
    "edit-cell": "{target, shading, align, vertical_align}",
    "insert-list-item": "{anchor, position, text, level}",
    "set-list-level": "{target, level}",
    "set-list": "{target, list, level}",
    review: '{target, action: "accept" or "reject"}',
  },
  xlsx: {
    set: '{target, value: {"string": "..."} or {"number": 1} or {"formula": "=..."}}, or {target, values}: write cells',
    "replace-text": "{target, find, replace}: literal replacement in the cell text of a range, sheet or the workbook",
    insert: "{anchor, position, node}: add a row, column, sheet, table, chart, comment or defined name",
    delete: "{target}: remove a row, column, sheet or table; a cell or range is cleared",
    format: "{target, format}",
    copy: "{source, target}",
    sort: "{target, keys, header}",
    autofilter: "{target, action, criteria}",
    resize: "{target, range}",
    rename: "{target, name}",
    move: "{target, anchor, position}",
    merge: "{target}",
    unmerge: "{target}",
    freeze: "{target, cell}",
    visibility: "{target, state}",
    hyperlink: "{target, action, url}",
    recalculate: '{target: "workbook"}',
  },
  pptx: {
    "replace-text": "{target, find, replace}: literal replacement inside a shape, paragraph, run, table cell or notes",
    set: '{target, value: {"text": "..."}}: replace the whole text of a shape, paragraph, run, table cell or notes, or a chart point',
    insert: '{anchor, position, node}: add a slide, shape or chart, for example node {"kind": "slide", "from": "slide:#258"}',
    delete: "{target}: remove a slide or shape",
    format: "{target, format}",
    move: "{target, anchor, position} or {target, offset}",
    copy: "{source, target, position}",
    group: "{target, shapes}",
    ungroup: "{target}",
    "insert-row": "{anchor, position}",
    "insert-column": "{target, index}",
    resize: "{target, extent}",
    "append-chart-category": "{target, label, values}",
    "remove-chart-category": "{target, category}",
    "relabel-chart-category": "{target, category, label}",
    "reorder-chart-categories": "{target, order}",
    "add-chart-series": "{target, name, values}",
    "drop-chart-series": "{target, series}",
    "relabel-chart-series": "{target, series, name}",
  },
};

/** The engine's refusal of an op name it does not know: `options.ops[].op is not a supported Agent API operation`
 * from the request check, `unknown operation` from the transaction, `unknown-op` as a refusal code. */
const UNKNOWN_OP_REFUSAL = /ops\[\]\.op\b|\bunknown operation\b|\bunknown-op\b/;

/** The words of an op name, lowercased and sorted: `replace_text`, `replaceText`, `text.replace` and
 * `replace-text` all have the words `replace text`. */
function opWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .sort()
    .join(" ");
}

/** The op of `known` that `name` spells differently, if exactly one has its words. */
function opMeant(name: string, known: Readonly<Record<string, string>>): string | undefined {
  const words = opWords(name);
  const matches = Object.keys(known).filter((op) => opWords(op) === words);
  return matches.length === 1 ? matches[0] : undefined;
}

export class WorkspaceTools {
  readonly #service: RoomService;
  readonly #roomId: string;
  readonly #inspector: WorkspaceDocInspector | undefined;
  readonly #renderer: VisualRenderer | undefined;
  readonly #packs: PackRefresher | undefined;
  readonly #packManifests: (() => Promise<PackManifest[]>) | undefined;
  readonly #readOnly: ReadOnlyMode | undefined;

  constructor(options: WorkspaceToolsOptions) {
    this.#service = options.service;
    this.#roomId = options.roomId;
    this.#inspector = options.inspector;
    this.#renderer = options.renderer;
    this.#packs = options.packs;
    this.#packManifests = options.packManifests;
    this.#readOnly = options.readOnly;
  }

  /** Run one validated call as `actor` (an agent). Never throws: a failure is a result with `isError`. */
  async call(actor: RoomActor, call: McpWorkspaceCall): Promise<ToolResult> {
    try {
      if (WRITE_TOOLS[call.name] === true) {
        const refused = this.#readOnlyRefusal();
        if (refused !== null) return refused;
      }
      switch (call.name) {
        case "workspace_list":
          return await this.#workspaceList(actor, call.arguments);
        case "doc_read":
          return await this.#docRead(actor, call.arguments);
        case "doc_search":
          return await this.#docSearch(actor, call.arguments);
        case "doc_create":
          return await this.#docCreate(actor, call.arguments);
        case "doc_edit":
          return await this.#docEdit(actor, call.arguments);
        case "doc_inspect_visual":
          return await this.#docInspectVisual(actor, call.arguments);
        case "pack_link_refresh":
          return await this.#packLinkRefresh(actor, call.arguments);
        case "comment_reply":
          return await this.#commentReply(actor, call.arguments);
      }
    } catch (error) {
      return failureOf(error);
    }
  }

  /** The refusal of a write tool in a read-only workspace, else `null`. */
  #readOnlyRefusal(): ToolResult | null {
    return this.#readOnly === undefined ? null : failure(readOnlyFailure(this.#readOnly));
  }

  // Shared ------------------------------------------------------------------------------------------------

  /** Announce `activity` for the length of `run`, and `idle` after it, whatever happened. A room that refuses
   * the announcement (the document is gone, say) does not stop the tool: the announcement is a courtesy to
   * the people looking at the room, and the tool's own call reports the real problem. */
  async #during<T>(actor: RoomActor, activity: RoomAgentActivity, docName: string | null, detail: string | undefined, run: () => Promise<T>): Promise<T> {
    await this.#announce(actor, activity, docName, detail);
    try {
      return await run();
    } finally {
      await this.#announce(actor, "idle", docName, undefined);
    }
  }

  async #announce(actor: RoomActor, activity: RoomAgentActivity, docName: string | null, detail: string | undefined): Promise<void> {
    await this.#service.reportActivity(this.#roomId, actor, detail === undefined ? { doc_name: docName, activity } : { doc_name: docName, activity, detail });
  }

  #room(actor: RoomActor): Promise<Result<RoomState>> {
    return this.#service.getRoom(this.#roomId, actor);
  }

  // workspace_list ----------------------------------------------------------------------------------------

  async #workspaceList(actor: RoomActor, args: Args<"workspace_list">): Promise<ToolResult> {
    const room = await this.#room(actor);
    if (!room.ok) return failure(room.error);
    const state = room.value;
    const open = state.proposals.filter((proposal) => proposal.status === "open");
    const openThreads = state.comments.filter((thread) => !thread.resolved);
    const matching = state.documents.filter((document) => args.format === undefined || document.head.format === args.format);
    const limit = args.limit ?? DEFAULT_LIST_LIMIT;
    const documents = matching.slice(0, limit).map(({ head }) => ({
      name: head.name,
      format: head.format,
      revision: head.revision,
      sha256: head.sha256,
      updated_at: head.updated_at,
      open_proposals: open.filter((proposal) => proposal.doc_name === head.name).length,
      open_threads: openThreads.filter((thread) => thread.doc_name === head.name).length,
    }));
    const data: Record<string, unknown> = {
      room_id: state.room_id,
      seq: state.seq,
      documents,
      total_documents: matching.length,
      truncated: matching.length > documents.length,
      proposals: open.map((proposal) => ({
        proposal_id: proposal.proposal_id,
        doc_name: proposal.doc_name,
        base_revision: proposal.base_revision,
        author: proposal.author.id,
        created_at: proposal.created_at,
        ops: proposal.batches.reduce((sum, batch) => sum + batch.ops.length, 0),
      })),
      threads: openThreads.map((thread) => ({
        thread_id: thread.thread_id,
        doc_name: thread.doc_name,
        target_address: thread.target_address,
        mentions: thread.mentions.map((mention) => mention.id),
        messages: thread.messages.map((message) => ({ author: message.author.id, body: message.body, created_at: message.created_at })),
      })),
      packs: await this.#packList(actor, state),
    };
    return okResult(data);
  }

  /** The packs of the workspace: from the manifests, each binding described, when the server has them; else the
   * refresher's summaries. */
  async #packList(actor: RoomActor, state: RoomState): Promise<unknown[]> {
    if (this.#packManifests === undefined) return this.#packs?.listPacks ? await this.#packs.listPacks() : [];
    const manifests = await this.#packManifests();
    const books = new Map<string, Promise<SourceBook>>();
    const bookOf = (name: string): Promise<SourceBook> => {
      let book = books.get(name);
      if (book === undefined) {
        book = this.#sourceBook(actor, state, name);
        books.set(name, book);
      }
      return book;
    };
    const packs: unknown[] = [];
    for (const manifest of manifests) {
      const definitions: BindingDefinition[] = [];
      for (const binding of manifest.bindings) {
        const source = manifest.sources.find((candidate) => candidate.id === binding.source_id);
        let read: SourceRead;
        if (source === undefined) read = { address: null, problem: `the pack has no source ${JSON.stringify(binding.source_id)}` };
        else if (source.kind !== "xlsx") read = { address: null, problem: `a ${source.kind} source is read by pack_link_refresh only` };
        else read = readSource(binding, await bookOf(source.doc_name));
        definitions.push(bindingDefinition(binding, source?.doc_name ?? null, read));
      }
      packs.push({ pack: manifest.pack_id, bindings: manifest.bindings.map((binding) => binding.id), title: manifest.name, definitions });
    }
    return packs;
  }

  /** The room's head of the source workbook `name`, parsed. */
  async #sourceBook(actor: RoomActor, state: RoomState, name: string): Promise<SourceBook> {
    const held = state.documents.find((document) => document.head.name === name);
    if (held === undefined) return { problem: `the room holds no document ${JSON.stringify(name)}` };
    if (held.head.format !== "xlsx") return { problem: `${name} is ${held.head.format}, not a workbook` };
    const read = await this.#service.readHead(this.#roomId, actor, name);
    if (!read.ok) return { problem: `${read.error.code}: ${read.error.message}` };
    try {
      return { doc: readDocument("xlsx", read.value.bytes), revision: read.value.head.revision };
    } catch (error) {
      if (error instanceof ReadError) return { problem: error.message };
      throw error;
    }
  }

  // doc_read ----------------------------------------------------------------------------------------------

  async #docRead(actor: RoomActor, args: Args<"doc_read">): Promise<ToolResult> {
    const view = args.view ?? "structure";
    const read = await this.#service.readHead(this.#roomId, actor, args.doc);
    if (!read.ok) return failure(read.error);
    const { head, bytes } = read.value;
    if (view === "cells" && head.format !== "xlsx") {
      return errorResult("BAD_REQUEST", `the cells view reads a workbook; ${head.name} is ${head.format}`, { reason: "unsupported-view" });
    }
    const detail = args.target === undefined ? view : `${view} ${args.target}`;
    const content = await this.#during(actor, "reading", head.name, detail, () => this.#content(head, bytes, view, args.target));
    return okResult(this.#viewData(head, content, args));
  }

  async #content(head: RoomHead, bytes: Uint8Array, view: DocView, target: string | undefined): Promise<DocContent> {
    if (this.#inspector) {
      const request = { format: head.format, name: head.name, bytes, view, ...(target === undefined ? {} : { target }) };
      const answered = await this.#inspector.read(request);
      if (answered) return answered;
    }
    return builtIn(readDocument(head.format, bytes), view, target);
  }

  #viewData(head: RoomHead, content: DocContent, args: Args<"doc_read">): Record<string, unknown> {
    const max = args.max_nodes ?? DEFAULT_MAX_NODES;
    const data: Record<string, unknown> = { doc: head.name, format: head.format, revision: head.revision, sha256: head.sha256, view: content.view };
    if (args.target !== undefined) data.target = args.target;
    switch (content.view) {
      case "structure":
        data.nodes = content.nodes.slice(0, max).map(previewed);
        data.total = content.nodes.length;
        data.truncated = content.nodes.length > max;
        break;
      case "cells":
        data.cells = content.cells.slice(0, max);
        data.total = content.cells.length;
        data.truncated = content.cells.length > max;
        break;
      case "text":
      case "markdown": {
        const cut = cutLines(content.text, max);
        data[content.view] = cut.text;
        data.total = cut.lines;
        data.truncated = cut.truncated;
        break;
      }
    }
    return data;
  }

  // doc_search --------------------------------------------------------------------------------------------

  async #docSearch(actor: RoomActor, args: Args<"doc_search">): Promise<ToolResult> {
    const regex = args.regex === true;
    const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
    const matcher = regex ? null : literalMatcher(args.query);

    let names: string[];
    if (args.doc !== undefined) {
      names = [args.doc];
    } else {
      const room = await this.#room(actor);
      if (!room.ok) return failure(room.error);
      names = room.value.documents.map((document) => document.head.name);
    }
    return this.#during(actor, "searching", args.doc ?? null, preview(args.query, 80), async () => {
      const hits: { doc: string; address: string; snippet: string; revision: number }[] = [];
      const skipped: { doc: string; reason: string }[] = [];
      const regexCorpus: { doc: string; revision: number; address: string; text: string }[] = [];
      let truncated = false;
      let searched = 0;
      scan: for (const name of names) {
        const read = await this.#service.readHead(this.#roomId, actor, name);
        if (!read.ok) {
          if (args.doc !== undefined) return failure(read.error);
          continue;
        }
        const { head, bytes } = read.value;
        let units: { address: string; text: string }[];
        try {
          units = readDocument(head.format, bytes).units();
        } catch (error) {
          if (!(error instanceof ReadError) || args.doc !== undefined) throw error;
          skipped.push({ doc: head.name, reason: error.message });
          continue;
        }
        units = [...units, ...(await this.#unitsOutsideBody(head, bytes))];
        searched++;
        if (matcher) {
          for (const unit of units) {
            const span = matcher(unit.text);
            if (!span) continue;
            if (hits.length === limit) {
              truncated = true;
              break scan;
            }
            hits.push({ doc: head.name, address: unit.address, snippet: snippet(unit.text, span), revision: head.revision });
          }
        } else {
          for (const unit of units) {
            regexCorpus.push({ doc: head.name, revision: head.revision, address: unit.address, text: unit.text });
          }
        }
      }
      if (!matcher) {
        const scanned = await runRegexSearchInWorker(
          args.query,
          regexCorpus.map((u) => u.text),
          limit,
        );
        if (!scanned.ok) {
          return errorResult("BAD_REQUEST", "regular-expression search exceeded the execution time limit", { reason: "regex-timeout" });
        }
        truncated = scanned.truncated;
        for (const m of scanned.matches) {
          const unit = regexCorpus[m.index]!;
          hits.push({
            doc: unit.doc,
            address: unit.address,
            snippet: snippet(unit.text, { start: m.start, end: m.end }),
            revision: unit.revision,
          });
        }
      }
      const data: Record<string, unknown> = { query: args.query, regex, hits, truncated, searched };
      if (skipped.length > 0) data.skipped = skipped;
      return okResult(data);
    });
  }

  /** The text of a Word document the built-in reader does not read, as search units at the addresses the
   * inspector lists: the paragraphs of headers and footers, and comments with their replies. */
  async #unitsOutsideBody(head: RoomHead, bytes: Uint8Array): Promise<{ address: string; text: string }[]> {
    if (!this.#inspector || head.format !== "docx") return [];
    const answered = await this.#inspector.read({ format: head.format, name: head.name, bytes, view: "structure" });
    if (answered?.view !== "structure") return [];
    const units: { address: string; text: string }[] = [];
    for (const node of answered.nodes) {
      if (node.text === undefined || node.text === "") continue;
      const outside = node.kind === "comment" || node.kind === "reply" || ((node.kind === "paragraph" || node.kind === "heading") && node.address.startsWith("section:"));
      if (outside) units.push({ address: node.address, text: node.text });
    }
    return units;
  }

  // doc_create --------------------------------------------------------------------------------------------

  async #docCreate(actor: RoomActor, args: Args<"doc_create">): Promise<ToolResult> {
    const { name, format } = args;
    if (!name.toLowerCase().endsWith(`.${format}`)) {
      return errorResult("BAD_REQUEST", `the name of a ${format} document ends in .${format}: ${JSON.stringify(name)}`, { reason: "name-extension" });
    }
    let bytes: Uint8Array;
    if (args.template === undefined) {
      bytes = blankDocument(format);
    } else {
      const template = await this.#service.readHead(this.#roomId, actor, args.template);
      if (!template.ok) return failure(template.error);
      if (template.value.head.format !== format) {
        return errorResult("BAD_REQUEST", `template ${args.template} is ${template.value.head.format}, not ${format}`, { reason: "template-format" });
      }
      bytes = template.value.bytes;
    }
    const added = await this.#service.addDocument(this.#roomId, actor, { name, format, bytes });
    if (!added.ok) return failure(added.error);
    let head = added.value;
    const data: Record<string, unknown> = { doc: name, format };
    if (args.template !== undefined) data.template = args.template;
    if (args.ops !== undefined) {
      const ops = args.ops;
      const edited = await this.#during(actor, "committing", name, `${ops.length} op${ops.length === 1 ? "" : "s"}`, () =>
        this.#service.edit(this.#roomId, actor, { doc_name: name, base_revision: head.revision, mode: "commit", batch: { ops } }),
      );
      if (!edited.ok) {
        // The document exists at revision 0; say so, so the agent edits it instead of creating it again.
        const created = { doc: name, revision: head.revision, sha256: head.sha256 };
        const failed = edited.error;
        return errorResult(failed.code, failed.message, "detail" in failed ? { created, cause: failed.detail } : { created });
      }
      if (edited.value.mode === "commit") {
        head = edited.value.head;
        data.entry_id = edited.value.entry.seq;
      }
    }
    data.revision = head.revision;
    data.sha256 = head.sha256;
    return okResult(data);
  }

  // doc_edit ----------------------------------------------------------------------------------------------

  /** The agent is announced as proposing (or committing) by the room itself, in the transaction that takes the
   * batch, ahead of the edit's own event: the room reads the announcement, then `doc.committed` (or the proposal),
   * then `idle`. A refused batch changed nothing and is announced as nothing, so no row reads as a proposal that
   * was never made. An announcement sent before the room judged the batch could not be taken back. */
  async #docEdit(actor: RoomActor, args: Args<"doc_edit">): Promise<ToolResult> {
    const { doc, mode, ops } = args;
    const batch = args.message === undefined ? { ops } : { ops, label: args.message };
    const detail = args.message ?? `${ops.length} op${ops.length === 1 ? "" : "s"}`;
    const announce = { doc_name: doc, activity: mode === "propose" ? "proposing" : "committing", detail: preview(detail, 120) } as const;
    const edited = await this.#service.edit(this.#roomId, actor, { doc_name: doc, base_revision: args.base_revision, mode, batch }, { announce });
    if (!edited.ok) return await this.#editRefusal(actor, doc, ops, edited.error);
    await this.#announce(actor, "idle", doc, undefined);
    const outcome = edited.value;
    if (outcome.mode === "propose") return okResult({ ...proposalData(outcome.proposal), existed: outcome.existed });
    return okResult({
      mode: "commit",
      doc,
      revision: outcome.head.revision,
      sha256: outcome.head.sha256,
      entry_id: outcome.entry.seq,
      base_sha256: outcome.entry.base_sha256,
    });
  }

  /** The answer to a refused batch. A refusal of an op name the engine does not know names, in the same answer, the
   * ops of the document's format, the members each takes, and the op meant when a name only spells one differently
   * (`replace_text`, `replaceText` or `text.replace` for `replace-text`). */
  async #editRefusal(actor: RoomActor, doc: string, ops: readonly { op: string }[], refused: RoomFailure): Promise<ToolResult> {
    if (refused.code !== "BAD_REQUEST" || !UNKNOWN_OP_REFUSAL.test(refused.message)) return failure(refused);
    const room = await this.#room(actor);
    const format = room.ok ? room.value.documents.find((document) => document.head.name === doc)?.head.format : undefined;
    if (format !== "docx" && format !== "xlsx" && format !== "pptx") return failure(refused);
    const known = EDIT_OPS[format];
    const unknown = [...new Set(ops.map((op) => op.op).filter((name) => !Object.hasOwn(known, name)))];
    const meant: Record<string, string> = {};
    for (const name of unknown) {
      const op = opMeant(name, known);
      if (op !== undefined) meant[name] = op;
    }
    const named = unknown.map((name) => (meant[name] === undefined ? JSON.stringify(name) : `${JSON.stringify(name)} (did you mean ${meant[name]}?)`));
    const which = named.length === 0 ? "" : `${named.join(", ")} ${named.length === 1 ? "is not an op" : "are not ops"} of ${format}. `;
    const message =
      `${refused.message}. ${which}The ops of ${format} are ${Object.keys(known).join(", ")}; ` +
      "detail.ops of this answer gives the members of each (the Agent API operation schema).";
    const detail = { reason: "unknown-op", format, unknown_ops: unknown, ...(Object.keys(meant).length > 0 ? { did_you_mean: meant } : {}), ops: known };
    return errorResult("BAD_REQUEST", message, detail);
  }

  // doc_inspect_visual ------------------------------------------------------------------------------------

  async #docInspectVisual(actor: RoomActor, args: Args<"doc_inspect_visual">): Promise<ToolResult> {
    const renderer = this.#renderer;
    if (!renderer) return errorResult("BAD_REQUEST", "this server has no renderer, so it can not draw pages", { reason: "no-renderer" });
    const pages = [...new Set(args.pages ?? [1])];
    if (pages.length > MAX_VISUAL_PAGES) {
      return errorResult("BAD_REQUEST", `ask for at most ${MAX_VISUAL_PAGES} pages in one call: each is an image`, { reason: "too-many-pages", max: MAX_VISUAL_PAGES });
    }
    const dpi = args.dpi ?? DEFAULT_DPI;
    const preflight = args.preflight === true;

    const read = await this.#service.readHead(this.#roomId, actor, args.doc);
    if (!read.ok) return failure(read.error);
    const { head } = read.value;
    let bytes = read.value.bytes;
    const data: Record<string, unknown> = { doc: head.name, format: head.format, revision: head.revision, sha256: head.sha256 };
    if (args.proposal_id !== undefined) {
      const previewed = await this.#service.readPreview(this.#roomId, actor, args.proposal_id);
      if (!previewed.ok) return failure(previewed.error);
      const { proposal } = previewed.value;
      if (proposal.doc_name !== head.name) {
        return errorResult("BAD_REQUEST", `proposal ${proposal.proposal_id} is for ${proposal.doc_name}, not ${head.name}`, { reason: "proposal-document" });
      }
      bytes = previewed.value.bytes;
      data.proposal_id = proposal.proposal_id;
      data.base_revision = proposal.base_revision;
    }

    const detail = preflight ? "preflight" : `page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`;
    const rendered = await this.#during(actor, "inspecting", head.name, detail, () =>
      renderer.inspect({ format: head.format, name: head.name, bytes, pages, dpi, preflight }),
    );

    let imageTokens = 0;
    const images: ImageBlock[] = [];
    const described = rendered.pages.map((page) => {
      const [width, height] = page.pixel_size ?? [Math.ceil((page.size_pt[0] * dpi) / 72), Math.ceil((page.size_pt[1] * dpi) / 72)];
      // The cost of an image to an agent is about one token per 750 pixels.
      const tokens = Math.ceil((width * height) / 750);
      imageTokens += tokens;
      if (page.png) images.push(imageBlock(page.png));
      return { page: page.page, size_pt: page.size_pt, pixel_size: [width, height], estimated_image_tokens: tokens };
    });
    data.page_count = rendered.page_count;
    data.dpi = dpi;
    data.preflight = preflight;
    data.pages = described;
    data.estimated_image_tokens = imageTokens;
    return okResult(data, images);
  }

  // pack_link_refresh -------------------------------------------------------------------------------------

  async #packLinkRefresh(actor: RoomActor, args: Args<"pack_link_refresh">): Promise<ToolResult> {
    const packs = this.#packs;
    if (!packs) {
      return errorResult("BAD_REQUEST", "this server has no pack refresher, so there is no pack manifest to refresh", { reason: "no-pack-refresher" });
    }
    const mode = args.mode ?? "propose";
    // The room answers a proposal equal to an open one with that open proposal, and the refresher reports it as
    // updated all the same. The proposals open before the refresh tell such a binding apart: it wrote nothing, so
    // it is `unchanged` with `existed: true` and its proposal id, not counted as updated. (A person opening the
    // same proposal while the refresh runs still reads as updated.)
    let openBefore = new Set<string>();
    if (mode === "propose") {
      const room = await this.#room(actor);
      if (!room.ok) return failure(room.error);
      openBefore = new Set(room.value.proposals.flatMap((proposal) => (proposal.status === "open" ? [proposal.proposal_id] : [])));
    }
    const activity: RoomAgentActivity = mode === "commit" ? "committing" : "proposing";
    const report = (detail: string): Promise<void> => this.#announce(actor, activity, null, preview(detail, 120));
    const result = await this.#during(actor, activity, null, `refresh ${args.pack}`, () =>
      packs.refreshPack({ roomService: this.#service, roomId: this.#roomId, actor, pack: args.pack, bindings: args.bindings, mode, report }),
    );
    const bindings = result.bindings.map((binding) =>
      binding.status === "updated" && binding.proposal_id !== undefined && openBefore.has(binding.proposal_id)
        ? { ...binding, status: "unchanged" as const, existed: true }
        : binding,
    );
    return okResult({
      pack: result.pack,
      mode: result.mode,
      bindings,
      updated: bindings.filter((binding) => binding.status === "updated").length,
      failed: bindings.filter((binding) => binding.status === "failed").length,
    });
  }

  // comment_reply -----------------------------------------------------------------------------------------

  async #commentReply(actor: RoomActor, args: Args<"comment_reply">): Promise<ToolResult> {
    const room = await this.#room(actor);
    if (!room.ok) return failure(room.error);
    const thread = room.value.comments.find((candidate) => candidate.thread_id === args.thread_id);
    if (!thread) return errorResult("UNKNOWN_THREAD", `no comment thread ${args.thread_id} in ${this.#roomId}`);
    const { mentions, unresolved } = mentionsOf(args.body, knownActors(room.value));
    const posted = await this.#during(actor, "replying", thread.doc_name, thread.thread_id, () =>
      this.#service.postComment(this.#roomId, actor, {
        thread_id: thread.thread_id,
        doc_name: thread.doc_name,
        target_address: thread.target_address,
        body: args.body,
        mentions,
        resolve: args.resolve === true,
      }),
    );
    if (!posted.ok) return failure(posted.error);
    const data: Record<string, unknown> = { thread: posted.value satisfies RoomThread };
    if (unresolved.length > 0) data.unresolved_mentions = unresolved;
    return okResult(data);
  }
}

function proposalData(proposal: RoomProposal): Record<string, unknown> {
  return {
    mode: "propose",
    proposal_id: proposal.proposal_id,
    status: proposal.status,
    doc: proposal.doc_name,
    base_revision: proposal.base_revision,
    preview_sha256: proposal.preview_sha256,
    ops: proposal.batches.reduce((sum, batch) => sum + batch.ops.length, 0),
  };
}

/** The result for something a tool threw: what the caller asked for was not possible, or a hook broke. */
function failureOf(error: unknown): ToolResult {
  if (error instanceof ReadError) return errorResult("BAD_REQUEST", error.message, { reason: error.code });
  if (error instanceof VisualPageError) return errorResult("BAD_REQUEST", error.message, { reason: "page-out-of-range", page: error.page, page_count: error.pageCount });
  if (error instanceof PackRefreshError) return errorResult("BAD_REQUEST", error.message, { reason: "pack-refresh" });
  if (error instanceof EngineRefusal) return errorResult(error.isLicense ? "LICENSE_LIMIT" : "BAD_REQUEST", error.message, { reason: error.code });
  if (error instanceof EngineFault) return errorResult("INTERNAL", `the engine failed: ${error.message}`);
  return errorResult("INTERNAL", error instanceof Error ? error.message : String(error));
}

