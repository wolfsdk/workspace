// A small deck engine that lives in memory, for the tests of live slide text. A deck is canonical JSON (the same deck always
// has the same bytes and so the same sha256), the room server's `DocumentEngine` applies the `set` of a run or of a
// paragraph and the `delete` of a shape to it, and `DeckPool` answers the three commands live slide text sends a worker
// (`open`, `observe`, `close`) with a view whose nodes are named as the released engine names them: `slide:#256`,
// `slide:#256/shape:#2`, `.../para:@1`, `.../para:@1/run:@1`, the rows and cells of a table, the notes of a slide.
import { createHash } from "node:crypto";
import type { ReactorPipeEntitlement, ReactorPipeRequest, RoomBatch, RoomOp } from "@wolfsdk/protocol/workspace";
import { type DocumentEngine, EngineRefusal, type EngineWorker, type ReplayInput, type ReplayResult, type WorkerPool } from "@wolfsdk/server";

export type DeckRun = { text: string; bold?: boolean; italic?: boolean };
export type DeckParagraph = {
  runs: DeckRun[];
  /** The text the view gives the paragraph when it is not what the runs add up to: a field, a line break, a hyperlink. */
  shown?: string;
};
export type DeckShape = {
  id: number;
  /** A text box unless it says otherwise. A table has `rows` (cells of one paragraph of one run each) instead of paragraphs. */
  kind?: "shape" | "table" | "chart" | "picture";
  name: string;
  visible?: boolean;
  paragraphs: DeckParagraph[];
  rows?: string[][];
};
export type DeckSlide = { id: number; shapes: DeckShape[]; notes?: string[] };
export type Deck = { slides: DeckSlide[] };

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a deck: equal decks are equal bytes. */
export const deckBytes = (deck: Deck): Uint8Array => encoder.encode(JSON.stringify(deck));
export const deckSha256 = (deck: Deck): string => sha256(deckBytes(deck));

/** The deck in some bytes the room holds, or a refusal when they are not a deck. */
export function parseDeck(bytes: Uint8Array): Deck {
  try {
    const deck = JSON.parse(new TextDecoder().decode(bytes)) as Deck;
    if (Array.isArray(deck.slides)) return deck;
  } catch {
    // Refused below.
  }
  throw new EngineRefusal("invalid-input", "the bytes are not a deck", "open");
}

const RUN_TARGET = /^slide:#([0-9]+)\/shape:#([0-9]+)\/para:@([0-9]+)\/run:@([0-9]+)$/;
const PARAGRAPH_TARGET = /^slide:#([0-9]+)\/shape:#([0-9]+)\/para:@([0-9]+)$/;
const SHAPE_TARGET = /^slide:#([0-9]+)\/shape:#([0-9]+)$/;

const shapeOf = (deck: Deck, slide: string, shape: string): DeckShape | undefined => deck.slides.find((s) => s.id === Number(slide))?.shapes.find((s) => s.id === Number(shape));

function applyOp(deck: Deck, op: RoomOp): void {
  const target = typeof op.target === "string" ? op.target : "";
  if (op.op === "delete") {
    const match = SHAPE_TARGET.exec(target);
    const slide = match === null ? undefined : deck.slides.find((s) => s.id === Number(match[1]));
    if (match === null || slide === undefined || shapeOf(deck, match[1]!, match[2]!) === undefined) throw new EngineRefusal("address-unresolved", `no shape ${target}`, "apply", "target");
    slide.shapes = slide.shapes.filter((s) => s.id !== Number(match[2]));
    return;
  }
  if (op.op !== "set") throw new EngineRefusal("unknown-op", `the op ${JSON.stringify(op.op)} is not known`, "apply", "op");
  const value = op.value;
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string") {
    throw new EngineRefusal("op-kind-mismatch", "a text set takes an object with text", "apply", "value");
  }
  const text = value.text;
  const run = RUN_TARGET.exec(target);
  if (run !== null) {
    if (/[\n\r\v\u2028\u2029]/.test(text)) throw new EngineRefusal("op-kind-mismatch", "PPTX run set takes text without line or paragraph breaks", "apply", "value");
    const found = shapeOf(deck, run[1]!, run[2]!)?.paragraphs[Number(run[3]) - 1]?.runs[Number(run[4]) - 1];
    if (found === undefined) throw new EngineRefusal("address-unresolved", `no run ${target}`, "apply", "target");
    found.text = text;
    return;
  }
  const paragraph = PARAGRAPH_TARGET.exec(target);
  const owner = paragraph === null ? undefined : shapeOf(deck, paragraph[1]!, paragraph[2]!)?.paragraphs[Number(paragraph[3]) - 1];
  if (paragraph === null || owner === undefined) throw new EngineRefusal("address-unresolved", `no part ${target}`, "apply", "target");
  // The paragraph keeps one run: what a set of the paragraph does to the formatting of its runs.
  owner.runs = [{ text }];
  delete owner.shown;
}

function applyBatch(bytes: Uint8Array, batch: RoomBatch): Uint8Array {
  const deck = parseDeck(bytes);
  for (const op of batch.ops) applyOp(deck, op);
  return deckBytes(deck);
}

export const DECK_ENTITLEMENT: ReactorPipeEntitlement = {
  tier: "commercial",
  max_workspaces: null,
  max_seats: null,
  sso: false,
  oem_offline_wasm: false,
  key_id: null,
  expires_at: null,
};

/** The `DocumentEngine` of the room server over decks. */
export class DeckEngine implements DocumentEngine {
  async entitlement(): Promise<ReactorPipeEntitlement> {
    return DECK_ENTITLEMENT;
  }

  async replay(input: ReplayInput): Promise<ReplayResult> {
    parseDeck(input.bytes);
    let bytes = input.bytes;
    const steps: ReplayResult["steps"] = [];
    for (const batch of input.batches) {
      const before = sha256(bytes);
      bytes = applyBatch(bytes, batch);
      steps.push({ base_sha256: before, sha256: sha256(bytes) });
    }
    return { format: input.format, base_sha256: sha256(input.bytes), steps, bytes: input.save ? bytes : null, page_hashes: null };
  }

  async close(): Promise<void> {}
}

type Node = Record<string, unknown>;

const shown = (paragraph: DeckParagraph): string => paragraph.shown ?? paragraph.runs.map((run) => run.text).join("");

function runNode(id: string, parent: string, run: DeckRun): Node {
  const font: Record<string, boolean> = {};
  if (run.bold) font.bold = true;
  if (run.italic) font.italic = true;
  return { children: 0, ...(Object.keys(font).length === 0 ? {} : { format: { font } }), id, kind: "run", parent, text: run.text, visible: true };
}

function paragraphNodes(shape: string, n: number, paragraph: DeckParagraph): Node[] {
  const id = `${shape}/para:@${n}`;
  const runs = paragraph.runs.map((run, i) => runNode(`${id}/run:@${i + 1}`, id, run));
  return [{ children: runs.length, id, kind: "paragraph", parent: shape, text: shown(paragraph), visible: true }, ...runs];
}

/** The nodes of a deck as the engine's view names them, in document order. */
export function deckNodes(deck: Deck): Node[] {
  const nodes: Node[] = [];
  for (const slide of deck.slides) {
    const slideId = `slide:#${slide.id}`;
    nodes.push({ children: slide.shapes.length, id: slideId, kind: "slide", parent: null, visible: true });
    for (const shape of slide.shapes) {
      const id = `${slideId}/shape:#${shape.id}`;
      const geometry = { cx: 7315200, cy: 640080, x: 731520, y: 457200 };
      const kind = shape.kind ?? "shape";
      if (kind === "table") {
        const rows = shape.rows ?? [];
        nodes.push({ children: rows.length, geometry, id, kind: "table", label: shape.name, parent: slideId, visible: true });
        for (const [r, cells] of rows.entries()) {
          const row = `${id}/row:@${r + 1}`;
          nodes.push({ children: cells.length, id: row, kind: "row", parent: id, visible: true });
          for (const [c, text] of cells.entries()) {
            const cell = `${row}/cell:@${c + 1}`;
            nodes.push({ children: 1, id: cell, kind: "cell", parent: row, text, visible: true });
            nodes.push(...paragraphNodes(cell, 1, { runs: [{ text }] }));
          }
        }
        continue;
      }
      if (kind === "chart") {
        nodes.push({ children: 1, geometry, id, kind: "chart", label: shape.name, parent: slideId, visible: true });
        nodes.push({ children: 1, id: `${id}/chart`, kind: "chart", parent: id, visible: true });
        nodes.push({ children: 0, id: `${id}/chart/series:Revenue`, kind: "series", parent: `${id}/chart`, visible: true });
        continue;
      }
      if (kind === "picture") {
        nodes.push({ children: 0, geometry, id, kind: "picture", label: shape.name, parent: slideId, visible: true });
        continue;
      }
      nodes.push({
        children: shape.paragraphs.length,
        format: { fill: { kind: "none" } },
        geometry,
        id,
        kind: "shape",
        label: shape.name,
        parent: slideId,
        text: shape.paragraphs.map(shown).join("\n"),
        visible: shape.visible ?? true,
      });
      for (const [i, paragraph] of shape.paragraphs.entries()) nodes.push(...paragraphNodes(id, i + 1, paragraph));
    }
    if (slide.notes !== undefined) {
      const notes = `${slideId}/notes`;
      nodes.push({ children: slide.notes.length, id: notes, kind: "notes", parent: slideId, visible: true });
      for (const [i, text] of slide.notes.entries()) nodes.push(...paragraphNodes(notes, i + 1, { runs: [{ text }] }));
    }
  }
  return nodes;
}

/** The part of the released engine's worker that live slide text reads, over decks. Counts what it was asked. */
export class DeckPool implements Pick<WorkerPool, "withWorker"> {
  /** Documents opened, and so reads that were not answered from a cache. */
  opens = 0;
  /** Views made. */
  observes = 0;
  /** The most nodes a view holds, whatever it was asked for; a deck with more is cut and says it was (`null`: no limit of its own). */
  nodeLimit: number | null = null;
  /** The sha256 the view claims to be of, when it is not the bytes' own. */
  claimedSha256: string | null = null;
  readonly #docs = new Map<number, { deck: Deck; sha256: string }>();
  #next = 1;

  withWorker<T>(job: (worker: EngineWorker) => Promise<T>): Promise<T> {
    const worker: EngineWorker = { call: (request, segments = []) => this.#call(request, segments), discard: () => undefined };
    return job(worker);
  }

  async #call(request: ReactorPipeRequest, segments: readonly Uint8Array[]): Promise<{ body: never; segments: Uint8Array[] }> {
    const answer = (body: Record<string, unknown>, out: Uint8Array[] = []) => ({ body: { ms: 0, ok: true, ...body } as never, segments: out });
    switch (request.cmd) {
      case "open": {
        const bytes = segments[request.bytes.bin]!;
        this.opens++;
        const doc = this.#next++;
        this.#docs.set(doc, { deck: parseDeck(bytes), sha256: sha256(bytes) });
        return answer({ cmd: "open", doc, format: "pptx", sha256: sha256(bytes), bytes: bytes.length, revision: 0, determinism: { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 } });
      }
      case "observe": {
        const open = this.#docs.get(request.doc)!;
        this.observes++;
        const asked = typeof request.options?.max_nodes === "number" ? request.options.max_nodes : Number.POSITIVE_INFINITY;
        const limit = Math.min(asked, this.nodeLimit ?? Number.POSITIVE_INFINITY);
        const all = deckNodes(open.deck);
        const nodes = all.slice(0, limit);
        const view = { contract: "agent-api.v1.view", format: "pptx", nodes, source_sha256: this.claimedSha256 ?? open.sha256, truncated: nodes.length < all.length };
        const data = encoder.encode(JSON.stringify(view));
        return answer({ cmd: "observe", receipt: {}, format: "pptx", outputs: [{ path: "/mem/out/deck.view.json", data: { bin: 0, len: data.length } }] }, [data]);
      }
      case "close":
        this.#docs.delete(request.doc);
        return answer({ cmd: "close", doc: request.doc });
      default:
        throw new Error(`the deck pool does not answer ${request.cmd}`);
    }
  }
}
