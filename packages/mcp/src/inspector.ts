// A `WorkspaceDocInspector` backed by engine workers.
//
// - The `text` and `markdown` views of a whole document come from the engine's own extractors, which read every
//   format the engine opens.
// - The `structure` view of a Word document, whole or below a `target`, comes from the engine's `observe`: it
//   lists what the built-in reader does not read (sections with their headers and footers, comments and
//   replies, tracked revisions, pictures, links) at the addresses the engine resolves in an edit. Sections,
//   with their headers and footers, come first, so a cut of a long document keeps them.
// - The `text` view of a Word document below a `target` the built-in reader does not resolve (a header
//   paragraph, a span, a comment) comes from `observe` too.
//
// Anything else (the `cells` view, the `structure` view of another format) is declined, and the built-in
// reader answers it.
import type { ReactorPipeOutput } from "@wolfsdk/protocol/workspace";
import { ask, type EnginePool, withOpenDocument } from "./engine.ts";
import type { DocContent, InspectRequest, StructureNode, WorkspaceDocInspector } from "./hooks.ts";
import { type BlockMeta, ReadError, readDocument } from "./read/index.ts";

const SUFFIX = { text: ".txt", markdown: ".md" } as const;
const VIEW_SUFFIX = ".view.json";
/** More than any document the room holds has; the server cuts the answer to the caller's `max_nodes`. */
const MAX_OBSERVED_NODES = 100_000;
const decoder = new TextDecoder();

/** One node of an `agent-api.v1.view`, as far as this file reads it (`docs/agent-api.md`, section 4). */
type ViewNode = { id: string; kind: string; parent?: string | null; text?: string; label?: string } & Record<string, unknown>;

/** The scalar members of a view node a reader needs to choose or describe a part, copied into `meta`. */
const META_MEMBERS = ["channel", "hidden_reason", "list_level", "alt_text", "media_type", "url", "bookmark", "tooltip", "author", "date", "anchor", "revision_kind"] as const;

/** Kinds whose `text` is content of their own. A cell and a run repeat the text of a paragraph. */
const TEXT_KINDS: Readonly<Record<string, true>> = { paragraph: true, comment: true, reply: true, revision: true };

/** Whether `target` names a paragraph or a part of one, where the runs are what the caller is after. */
const belowParagraph = (target: string | undefined): boolean => target !== undefined && /(^|\/)para:[^/]+(\/[^/]+)?$/.test(target);

/** The heading level a paragraph style gives, by the rule of the built-in reader (`read/docx.ts`): `Heading 2`
 * is level 2 and `Title` level 1. The view does not carry an outline level set any other way. */
function headingLevel(format: unknown): number | undefined {
  if (typeof format !== "object" || format === null) return undefined;
  const { style, style_name } = format as { style?: unknown; style_name?: unknown };
  for (const key of [style, style_name]) {
    if (typeof key !== "string") continue;
    const level = Number(/^heading\s*([1-9])$/i.exec(key)?.[1]);
    if (level >= 1) return level;
    if (/^title$/i.test(key)) return 1;
  }
  return undefined;
}

/** The name of a paragraph's style when it says something (`Normal` does not). */
function styleLabel(format: unknown): string | undefined {
  if (typeof format !== "object" || format === null) return undefined;
  const { style, style_name } = format as { style?: unknown; style_name?: unknown };
  const name = typeof style_name === "string" ? style_name : style;
  return typeof name === "string" && name !== "" && name !== "Normal" ? name : undefined;
}

function metaOf(node: ViewNode, level: number | undefined): BlockMeta | undefined {
  const meta: BlockMeta = {};
  if (level !== undefined) meta.level = level;
  for (const member of META_MEMBERS) {
    const value = node[member];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") meta[member] = value;
  }
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/** The view as structure nodes. `whole` is the view of a whole document: its sections, with the headers and
 * footers below them, move ahead of the body, which the engine lists first. */
function structureOf(nodes: readonly ViewNode[], withRuns: boolean, whole: boolean): StructureNode[] {
  const parents = new Map<string, string>();
  for (const node of nodes) if (typeof node.parent === "string") parents.set(node.id, node.parent);
  const known = new Set(nodes.map((node) => node.id));
  // A parent the view does not hold (the view is below a target) is above the top of this view.
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let at = parents.get(id); at !== undefined && known.has(at) && depth < nodes.length; at = parents.get(at)) depth++;
    return depth;
  };
  const first: StructureNode[] = [];
  const rest: StructureNode[] = [];
  for (const node of nodes) {
    if (node.kind === "run" && !withRuns) continue;
    const paragraph = node.kind === "paragraph";
    const level = paragraph ? headingLevel(node.format) : undefined;
    const label = typeof node.label === "string" ? node.label : paragraph ? styleLabel(node.format) : undefined;
    const meta = metaOf(node, level);
    (whole && node.id.startsWith("section:") ? first : rest).push({
      address: node.id,
      kind: level === undefined ? node.kind : "heading",
      depth: depthOf(node.id),
      ...(label === undefined ? {} : { label }),
      ...(typeof node.text === "string" && node.text !== "" ? { text: node.text } : {}),
      ...(meta ? { meta } : {}),
    });
  }
  return [...first, ...rest];
}

/** The text below a target: a line per paragraph, comment, reply and revision, or the text of the one part the
 * target names (a span, a run, a link; the alternative text of a picture). */
function textOf(nodes: readonly ViewNode[]): string {
  const lines = nodes.filter((node) => TEXT_KINDS[node.kind] && typeof node.text === "string").map((node) => node.text as string);
  if (lines.length > 0) return lines.join("\n");
  const first = nodes[0];
  if (first === undefined) return "";
  if (typeof first.text === "string") return first.text;
  return typeof first.alt_text === "string" ? first.alt_text : "";
}

type Observed = { ok: boolean; receipt: Record<string, unknown>; outputs?: ReactorPipeOutput[] };

const unresolved = (target: string): ReadError => new ReadError("address-unresolved", `${target} names nothing in this document`);

/** The nodes of the view the engine wrote, or a `ReadError` when it says the target names nothing. */
function viewNodes(body: Observed, segments: readonly Uint8Array[], target: string | undefined): ViewNode[] {
  if (!body.ok) {
    const errors = Array.isArray(body.receipt.errors) ? (body.receipt.errors as { code?: unknown; message?: unknown }[]) : [];
    if (target !== undefined && errors.some((error) => error.code === "address-unresolved")) throw unresolved(target);
    throw new Error(`the engine could not observe the document: ${errors.map((error) => String(error.message ?? error.code)).join("; ") || "no reason given"}`);
  }
  const output = body.outputs?.find((candidate) => candidate.path.endsWith(VIEW_SUFFIX));
  const blob = output ? segments[output.data.bin] : undefined;
  if (!blob) throw new Error("the engine observed the document and returned no view");
  const view = JSON.parse(decoder.decode(blob)) as { nodes?: unknown };
  return Array.isArray(view.nodes) ? (view.nodes as ViewNode[]) : [];
}

const SPAN = "/span:";

/** The view of a Word document the engine observes, whole or below `target`. The engine resolves a span (and
 * refuses one whose words the paragraph does not hold) but lists no node for it: a span is its own words. */
function observe(pool: EnginePool, request: InspectRequest): Promise<ViewNode[]> {
  const { target } = request;
  return withOpenDocument(pool, request, async (worker, doc) => {
    const options = { max_nodes: MAX_OBSERVED_NODES, ...(target === undefined ? {} : { targets: [target] }) };
    const { body, segments } = await ask(worker, { cmd: "observe", doc, options });
    const nodes = viewNodes(body, segments, target);
    const span = target === undefined ? -1 : target.indexOf(SPAN);
    if (nodes.length > 0 || target === undefined || span < 0) return nodes;
    return [{ id: target, kind: "span", parent: target.slice(0, span), text: target.slice(span + SPAN.length) }];
  });
}

export function engineInspector(pool: EnginePool): WorkspaceDocInspector {
  return {
    async read(request: InspectRequest): Promise<DocContent | undefined> {
      const { view, target } = request;
      if (request.format === "docx" && view === "structure") {
        return { view, nodes: structureOf(await observe(pool, request), belowParagraph(target), target === undefined) };
      }
      if (request.format === "docx" && view === "text" && target !== undefined) {
        // What the built-in reader resolves reads as it always did (a table as rows); the engine answers the rest.
        try {
          return { view, text: readDocument("docx", request.bytes).text(target) };
        } catch (error) {
          if (!(error instanceof ReadError) || error.code !== "address-unresolved") throw error;
        }
        return { view, text: textOf(await observe(pool, request)) };
      }
      if (target !== undefined || (view !== "text" && view !== "markdown")) return undefined;
      return withOpenDocument(pool, request, async (worker, doc) => {
        const { body, segments } = await ask(worker, { cmd: "extract", doc, options: { what: [view] } });
        if (!body.ok) return undefined;
        const output = body.outputs?.find((candidate) => candidate.path.endsWith(SUFFIX[view]));
        const blob = output ? segments[output.data.bin] : undefined;
        return blob ? { view, text: decoder.decode(blob) } : undefined;
      });
    },
  };
}
