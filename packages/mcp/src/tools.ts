// The eight tools of `wolfsdk.mcp-workspace.v1`, over a `RoomService`. Each tool is a few room calls and a
// result: it reads or writes through the service (so every guarantee of the room holds: revisions, proposals,
// the session log) and announces what it is doing with `agent.activity` while it runs. The tool list itself
// (names, schemas, descriptions) lives in `@wolfsdk/protocol`; this file only runs the calls that validated.
import {
  type McpWorkspaceCall,
  type McpWorkspaceToolName,
  type RoomActor,
  type RoomAgentActivity,
  type RoomHead,
  type RoomProposal,
  type RoomState,
  type RoomThread,
} from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, type Result, type RoomFailure, type RoomService } from "@wolfsdk/server";
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
import { blankDocument, type Block, type ReadableDocument, ReadError, readDocument } from "./read/index.ts";
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
};

type Args<N extends McpWorkspaceToolName> = Extract<McpWorkspaceCall, { name: N }>["arguments"];

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

export class WorkspaceTools {
  readonly #service: RoomService;
  readonly #roomId: string;
  readonly #inspector: WorkspaceDocInspector | undefined;
  readonly #renderer: VisualRenderer | undefined;
  readonly #packs: PackRefresher | undefined;

  constructor(options: WorkspaceToolsOptions) {
    this.#service = options.service;
    this.#roomId = options.roomId;
    this.#inspector = options.inspector;
    this.#renderer = options.renderer;
    this.#packs = options.packs;
  }

  /** Run one validated call as `actor` (an agent). Never throws: a failure is a result with `isError`. */
  async call(actor: RoomActor, call: McpWorkspaceCall): Promise<ToolResult> {
    try {
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
      packs: this.#packs?.listPacks ? await this.#packs.listPacks() : [],
    };
    return okResult(data);
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
        data.nodes = content.nodes.slice(0, max);
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
        let units;
        try {
          units = readDocument(head.format, bytes).units();
        } catch (error) {
          if (!(error instanceof ReadError) || args.doc !== undefined) throw error;
          skipped.push({ doc: head.name, reason: error.message });
          continue;
        }
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

  async #docEdit(actor: RoomActor, args: Args<"doc_edit">): Promise<ToolResult> {
    const { doc, mode, ops } = args;
    const batch = args.message === undefined ? { ops } : { ops, label: args.message };
    const detail = args.message ?? `${ops.length} op${ops.length === 1 ? "" : "s"}`;
    const edited = await this.#during(actor, mode === "propose" ? "proposing" : "committing", doc, preview(detail, 120), () =>
      this.#service.edit(this.#roomId, actor, { doc_name: doc, base_revision: args.base_revision, mode, batch }),
    );
    if (!edited.ok) return failure(edited.error);
    const outcome = edited.value;
    if (outcome.mode === "propose") return okResult(proposalData(outcome.proposal));
    return okResult({
      mode: "commit",
      doc,
      revision: outcome.head.revision,
      sha256: outcome.head.sha256,
      entry_id: outcome.entry.seq,
      base_sha256: outcome.entry.base_sha256,
    });
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
    const activity: RoomAgentActivity = mode === "commit" ? "committing" : "proposing";
    const report = (detail: string): Promise<void> => this.#announce(actor, activity, null, preview(detail, 120));
    const result = await this.#during(actor, activity, null, `refresh ${args.pack}`, () =>
      packs.refreshPack({ roomService: this.#service, roomId: this.#roomId, actor, pack: args.pack, bindings: args.bindings, mode, report }),
    );
    return okResult({
      pack: result.pack,
      mode: result.mode,
      bindings: result.bindings,
      updated: result.bindings.filter((binding) => binding.status === "updated").length,
      failed: result.bindings.filter((binding) => binding.status === "failed").length,
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

