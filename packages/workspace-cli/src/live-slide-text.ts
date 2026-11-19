// Live slide text: `GET` and `PUT /api/rooms/<room>/docs/<doc>/live-slide-text`, the run-by-run collaboration on the text
// of the shapes of one PPTX deck at its head.
//
//   GET   the ordinary text shapes of the deck at the head (`shapes`: their id and a label with the slide), the runs of
//         one of them (`?shape=<exact shape id>`, else the first), and whether and why the deck may be written here
//         (`editable`, `refusal`). A run is the unit of a write: its text changes and nothing else of it does, so the
//         formatting of the run and of the runs beside it is whatever the document has.
//   PUT   the text of one run, over what the caller read in it (`expected`) at the revision of that read. It commits one
//         native `set` of the run's text through the room service, so it is one session entry like any other edit. A write
//         against a head that moved on is kept only when the history since the revision of the read is complete and is
//         nothing but such `set`s of other runs; any other history, and any history that is not all there, is
//         `STRUCTURE_CONFLICT`, whatever else the span holds; the same run, even when it came back to what was read, is
//         `RUN_CONFLICT`, which carries the text the run holds now. The caller keeps its draft and decides.
//
// What is a shape of live slide text. The engine's view of a deck names the paragraphs and runs of a shape, and the rows
// of a table, the series of a chart, the notes of a slide, but not what hides inside a run. A shape is listed when the
// view shows it as plain text and nothing else: every child is a paragraph, every child of a paragraph is a run, the
// numbering of both is unbroken, and the text of each level is what the level below it adds up to. A table, a chart, a
// picture, a group, the notes of a slide and a shape that holds anything else are not listed, and a run is addressed only
// by the id the view gives it (`slide:#256/shape:#2/para:@1/run:@1`).
//
// What the server will write. The released engine (0.2.25) does not say whether a run is a field, a hyperlink or other
// special text, or whether the position ids of a deck are unambiguous, so no deck is writable by default. A deck is
// writable when the sha256 of its head bytes is one the operator attested (`--live-slide-text-attest`: bytes the operator
// reviewed as ordinary text with none of that), or the result of this server's own validated write on bytes that were
// writable: one run, to text that is not blank and has no line breaks or control characters, which leaves such a deck
// as it was. The set of writable digests is content-addressed and lives in memory: after a restart, attest the head again.
//
// The identity of a caller is the member the token stands for. Guests, agents and a read-only workspace are refused
// by the route before anything here runs.
import type { RoomHead, RoomSessionEntry } from "@wolfsdk/protocol/workspace";
import { ROOM_REVISION_MISMATCH } from "@wolfsdk/protocol/workspace";
import { EngineFault, type RoomService, type WorkerPool } from "@wolfsdk/server";
import { ask, askWithSegments } from "./engine.ts";
import {
  bad,
  closeDocument,
  documentLog,
  engineReply,
  fail,
  isObject,
  type LiveCaller,
  type LiveError,
  type LiveReply,
  Lru,
  provenSpan,
  STRUCTURE_CONFLICT,
  Writable,
  WriteQueue,
} from "./live-shared.ts";

export type LiveSlideTextOptions = {
  /** The engine workers a read opens a head with. */
  pool: Pick<WorkerPool, "withWorker">;
  /** The sha256 (64 hex digits) of each PPTX file the operator attests: reviewed as ordinary text, with no field,
   * hyperlink or other special text in a run and no ambiguous position id. Nothing else is writable until a write of this
   * server inherits from one of them. */
  attested: readonly string[];
};

export const LIVE_SLIDE_TEXT_UNATTESTED = "LIVE_SLIDE_TEXT_UNATTESTED";
export const LIVE_SLIDE_TEXT_UNSUPPORTED = "LIVE_SLIDE_TEXT_UNSUPPORTED";
export const RUN_CONFLICT = "RUN_CONFLICT";
export const RUN_UNSUPPORTED = "RUN_UNSUPPORTED";
export const UNKNOWN_SHAPE = "UNKNOWN_SHAPE";

/** Most characters of the text of one run, read or written. */
export const MAX_RUN_TEXT = 4096;
/** Most bytes of the body of a write: two texts of the most characters, each escaped, and the rest of the members. */
export const MAX_WRITE_BYTES = 64 * 1024;
/** Most parts of a deck the engine is asked to describe; a deck with more is read as unsupported. */
export const MAX_DECK_NODES = 50_000;
/** Most shapes listed, and most characters of run text a deck may hold, for it to be read at all. */
export const MAX_SHAPES = 1000;
export const MAX_DECK_TEXT = 2_000_000;
const MAX_LABEL = 120;
const MAX_ATTEMPTS = 4;
const DECKS_CAP = 8;
const INHERITED_CAP = 1024;

const NOT_PPTX = "live slide text is for PPTX documents";
const HISTORY_CHANGED = "the deck changed in ways other than the writes of single runs since your read: read it again";

const SHAPE_ID = /^slide:#[1-9][0-9]{0,8}\/shape:#[1-9][0-9]{0,8}$/;
const RUN_ID = /^slide:#[1-9][0-9]{0,8}\/shape:#[1-9][0-9]{0,8}\/para:@[1-9][0-9]{0,5}\/run:@[1-9][0-9]{0,5}$/;

// --- text --------------------------------------------------------------------------------------------------------

/** Line and paragraph breaks, tabs and the other control characters (the native run `set` takes none of the breaks, and
 * stores the rest where a document cannot hold them), the two separators that break lines, noncharacters, and halves of
 * surrogate pairs. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why `text` is not the text of a run, or null. Whether it may be blank is for the caller: a blank run is read, never written. */
function textProblem(text: string): string | null {
  if (text.length > MAX_RUN_TEXT) return `text is at most ${MAX_RUN_TEXT} characters`;
  if (UNSAFE.test(text)) return "text may not hold line breaks, tabs or other control characters";
  return null;
}

// --- what the engine says of a head ------------------------------------------------------------------------------

type Run = { id: string; text: string };
type Shape = { id: string; label: string; runs: Run[] };
/** The shapes live slide text lists, in the order of the deck, and the text of each of their runs by id. */
type Deck = { shapes: Shape[]; texts: Map<string, string> };
/** A deck, or the reason it is read as a whole and not listed. */
type Observed = Deck | string;

const SLIDE = /^slide:#[1-9][0-9]*$/;
const SHAPE_PART = /^(slide:#[1-9][0-9]*)\/shape:#[1-9][0-9]*(?:\/(.+))?$/;
const PARAGRAPH = /^para:@([1-9][0-9]*)$/;
const RUN = /^para:@([1-9][0-9]*)\/run:@([1-9][0-9]*)$/;

type DraftRun = { n: number; text: unknown };
type DraftParagraph = { n: number; text: unknown; children: unknown; runs: DraftRun[] };
type Draft = { id: string; slide: string; node: Record<string, unknown> | undefined; sound: boolean; paragraphs: Map<number, DraftParagraph> };

/** The label a person sees for a shape: its slide, and its name in the document. */
function labelOf(slide: number, draft: Draft): string {
  const name = typeof draft.node?.label === "string" ? draft.node.label : "";
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim() || draft.id.slice(draft.id.lastIndexOf("/") + 1);
  return `Slide ${slide}: ${clean.slice(0, MAX_LABEL)}`;
}

/** The runs of a shape the view shows as plain text, or null for a shape that shows anything else. */
function runsOf(draft: Draft, shape: Record<string, unknown>): Run[] | null {
  const paragraphs = [...draft.paragraphs.values()];
  if (paragraphs.length === 0 || shape.children !== paragraphs.length) return null;
  const runs: Run[] = [];
  const lines: string[] = [];
  for (const [i, paragraph] of paragraphs.entries()) {
    if (paragraph.n !== i + 1 || paragraph.children !== paragraph.runs.length) return null;
    let line = "";
    for (const [j, run] of paragraph.runs.entries()) {
      if (run.n !== j + 1 || typeof run.text !== "string" || textProblem(run.text) !== null) return null;
      line += run.text;
      runs.push({ id: `${draft.id}/para:@${paragraph.n}/run:@${run.n}`, text: run.text });
    }
    // Text the runs do not add up to is a break, a field or a hyperlink that the view shows in another way.
    if ((paragraph.text ?? "") !== line) return null;
    lines.push(line);
  }
  return (shape.text ?? "") === lines.join("\n") && runs.length > 0 ? runs : null;
}

/** The deck the engine's view describes: the shapes that are plain text, or the reason the deck is not read. */
function deckOf(view: unknown): Observed {
  if (!isObject(view) || !Array.isArray(view.nodes)) throw new EngineFault("the engine's view of the deck has no nodes");
  if (view.truncated !== false) return `the deck has more than ${MAX_DECK_NODES} parts, more than live slide text reads`;
  const slides = new Map<string, number>();
  const drafts = new Map<string, Draft>();
  for (const node of view.nodes) {
    if (!isObject(node) || typeof node.id !== "string" || typeof node.kind !== "string") throw new EngineFault("the engine described a part of the deck without an id and a kind");
    if (SLIDE.test(node.id)) {
      if (node.kind === "slide") {
        if (slides.has(node.id)) return `the deck names the slide ${node.id} twice`;
        slides.set(node.id, slides.size + 1);
      }
      continue;
    }
    const part = SHAPE_PART.exec(node.id);
    if (part === null) continue;
    const rest = part[2];
    const shapeId = rest === undefined ? node.id : node.id.slice(0, node.id.length - rest.length - 1);
    let draft = drafts.get(shapeId);
    if (draft === undefined) {
      draft = { id: shapeId, slide: part[1]!, node: undefined, sound: true, paragraphs: new Map() };
      drafts.set(shapeId, draft);
    }
    if (rest === undefined) {
      if (draft.node !== undefined || node.kind !== "shape") draft.sound = false;
      else draft.node = node;
      continue;
    }
    const paragraph = PARAGRAPH.exec(rest);
    if (paragraph !== null) {
      const n = Number(paragraph[1]);
      if (node.kind !== "paragraph" || draft.paragraphs.has(n)) draft.sound = false;
      else draft.paragraphs.set(n, { n, text: node.text, children: node.children, runs: [] });
      continue;
    }
    const run = RUN.exec(rest);
    const owner = run === null ? undefined : draft.paragraphs.get(Number(run[1]));
    // Anything else below a shape (a row, a column, a chart, a nested shape) is not a paragraph of plain text.
    if (run === null || owner === undefined || node.kind !== "run") draft.sound = false;
    else owner.runs.push({ n: Number(run[2]), text: node.text });
  }
  const shapes: Shape[] = [];
  const texts = new Map<string, string>();
  let held = 0;
  for (const draft of drafts.values()) {
    const slide = slides.get(draft.slide);
    const shape = draft.node;
    if (!draft.sound || slide === undefined || shape === undefined || shape.visible === false) continue;
    const runs = runsOf(draft, shape);
    if (runs === null) continue;
    for (const run of runs) {
      held += run.text.length;
      texts.set(run.id, run.text);
    }
    if (held > MAX_DECK_TEXT) return `the deck holds more than ${MAX_DECK_TEXT} characters of shape text, more than live slide text reads`;
    shapes.push({ id: draft.id, label: labelOf(slide, draft), runs });
    if (shapes.length > MAX_SHAPES) return `the deck has more than ${MAX_SHAPES} text shapes, more than live slide text lists`;
  }
  return { shapes, texts };
}

/** The runs a session entry wrote, when it is nothing but `set`s of the text of single runs (the kind of write this
 * server makes), else null. */
function runsWritten(entry: RoomSessionEntry): string[] | null {
  const written: string[] = [];
  for (const op of entry.batch.ops) {
    if (op.op !== "set" || typeof op.target !== "string" || !RUN_ID.test(op.target)) return null;
    if (Object.keys(op).some((key) => key !== "op" && key !== "target" && key !== "value")) return null;
    const { value } = op;
    if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.text !== "string") return null;
    written.push(op.target);
  }
  return written;
}

// --- the service -------------------------------------------------------------------------------------------------

type Parsed = { revision: number; target: string; expected: string; text: string };

const WRITE_KEYS: Record<string, true> = { revision: true, target: true, expected: true, text: true };

export class LiveSlideText {
  readonly #service: RoomService;
  readonly #pool: Pick<WorkerPool, "withWorker">;
  readonly #writable: Writable;
  readonly #queue = new WriteQueue();
  readonly #decks = new Lru<Observed>(DECKS_CAP);
  readonly #flights = new Map<string, Promise<Observed>>();

  constructor(service: RoomService, options: LiveSlideTextOptions) {
    this.#service = service;
    this.#pool = options.pool;
    this.#writable = new Writable(options.attested, INHERITED_CAP);
  }

  /** Whether the head with this digest may be written run by run. */
  writable(sha256: string): boolean {
    return this.#writable.has(sha256);
  }

  // GET ------------------------------------------------------------------------------------------------------------

  async get(caller: LiveCaller, query: URLSearchParams): Promise<LiveReply> {
    const asked = query.get("shape");
    if (asked !== null && !SHAPE_ID.test(asked)) return bad("shape is the id of a shape, such as slide:#256/shape:#2");
    const read = await this.#service.readHead(caller.roomId, caller.actor, caller.doc);
    if (!read.ok) return { failure: read.error };
    const { head, bytes } = read.value;
    if (head.format !== "pptx") return bad(NOT_PPTX);
    let deck: Observed;
    try {
      deck = await this.#deck(head, bytes);
    } catch (e) {
      return engineReply(e);
    }
    const shapes = typeof deck === "string" ? [] : deck.shapes;
    const shape = asked === null ? (shapes[0] ?? null) : (shapes.find((candidate) => candidate.id === asked) ?? null);
    if (shape === null && asked !== null && typeof deck !== "string") {
      return fail(
        404,
        UNKNOWN_SHAPE,
        `${asked} is not a text shape of ${head.name} at revision ${head.revision}: it is gone, or it is a table, chart, picture, group or other shape that live slide text does not write`,
        { revision: head.revision },
      );
    }
    let refusal: { code: string; message: string } | null = null;
    if (caller.refusal !== null) refusal = { code: caller.refusal.code, message: caller.refusal.message };
    else if (typeof deck === "string") refusal = { code: LIVE_SLIDE_TEXT_UNSUPPORTED, message: deck };
    else if (shapes.length === 0) refusal = { code: LIVE_SLIDE_TEXT_UNSUPPORTED, message: `${head.name} has no shape of plain text that live slide text can write` };
    else if (!this.#writable.has(head.sha256)) refusal = { code: LIVE_SLIDE_TEXT_UNATTESTED, message: this.#unattested(head) };
    return {
      status: 200,
      body: {
        revision: head.revision,
        shapes: shapes.map(({ id, label }) => ({ id, label })),
        shape: shape?.id ?? null,
        runs: shape === null ? [] : shape.runs.map(({ id, text }) => ({ id, text })),
        editable: refusal === null,
        refusal,
      },
    };
  }

  // PUT ------------------------------------------------------------------------------------------------------------

  /** Writes to one document go one at a time here, so that members writing different runs together do not race each
   * other for the revision. A write of another kind can still win it: that is retried below. */
  put(caller: LiveCaller, body: Record<string, unknown>): Promise<LiveReply> {
    const parsed = this.#parseWrite(body);
    if ("status" in parsed) return Promise.resolve(parsed);
    return this.#queue.run(caller.roomId, caller.doc, () => this.#write(caller, parsed));
  }

  async #write(caller: LiveCaller, parsed: Parsed): Promise<LiveReply> {
    const { revision, target, expected, text } = parsed;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const read = await this.#service.readHead(caller.roomId, caller.actor, caller.doc);
      if (!read.ok) return { failure: read.error };
      const { head, bytes } = read.value;
      if (head.format !== "pptx") return bad(NOT_PPTX);
      if (!this.#writable.has(head.sha256)) return fail(403, LIVE_SLIDE_TEXT_UNATTESTED, this.#unattested(head));
      let deck: Observed;
      try {
        deck = await this.#deck(head, bytes);
      } catch (e) {
        return engineReply(e);
      }
      if (typeof deck === "string") return fail(422, LIVE_SLIDE_TEXT_UNSUPPORTED, deck);
      if (revision > head.revision) {
        return fail(409, STRUCTURE_CONFLICT, "the deck is older than your copy: read it again", { revision: head.revision });
      }
      // A read that is behind the head is kept only over history proven to be nothing but writes of the text of single runs.
      // Those change no id, so the run a read named is the run the head has; whether one of them wrote it is the conflict.
      let touched = false;
      if (revision < head.revision) {
        const log = await documentLog(this.#service, caller);
        if ("failure" in log) return log;
        const span = provenSpan(log, revision, head, "deck", HISTORY_CHANGED);
        if (typeof span === "string") return fail(409, STRUCTURE_CONFLICT, span, { revision: head.revision });
        for (const entry of span) {
          const written = runsWritten(entry);
          if (written === null) return fail(409, STRUCTURE_CONFLICT, HISTORY_CHANGED, { revision: head.revision });
          if (written.includes(target)) touched = true;
        }
      }
      const now = deck.texts.get(target);
      if (now === undefined) return fail(422, RUN_UNSUPPORTED, `${target} is not a run of a shape of plain text in ${head.name} at revision ${head.revision}`);
      if (touched) return fail(409, RUN_CONFLICT, `${target} was written since your read`, { revision: head.revision, current: now });
      if (now !== expected) return fail(409, RUN_CONFLICT, `${target} holds something other than what you read`, { revision: head.revision, current: now });
      if (now === text) return { status: 200, body: { revision: head.revision } };
      const edit = await this.#service.edit(caller.roomId, caller.actor, {
        doc_name: caller.doc,
        base_revision: head.revision,
        mode: "commit",
        batch: { ops: [{ op: "set", target, value: { text } }], label: "live slide text" },
      });
      if (edit.ok) {
        if (edit.value.mode !== "commit") return { failure: { code: "ENGINE_FAILED", message: "the room held the write as a proposal" } };
        // The base was a writable head and the write passed the checks above: the bytes it made are writable too.
        this.#writable.inherit(edit.value.head.sha256);
        return { status: 200, body: { revision: edit.value.head.revision } };
      }
      // Someone committed between the read and the write: read again, and prove again that what came in is disjoint.
      if (edit.error.code !== ROOM_REVISION_MISMATCH) return { failure: edit.error };
    }
    return fail(409, STRUCTURE_CONFLICT, "the deck kept changing: read it again");
  }

  #parseWrite(body: Record<string, unknown>): Parsed | LiveError {
    for (const key of Object.keys(body)) if (!Object.hasOwn(WRITE_KEYS, key)) return bad(`${JSON.stringify(key)} is not a member of a write`);
    const { revision, target, expected, text } = body;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return bad("revision is the revision of the read, from 0");
    if (typeof target !== "string" || !RUN_ID.test(target)) return bad("target is the id of a run of a shape, such as slide:#256/shape:#2/para:@1/run:@1");
    if (typeof expected !== "string" || typeof text !== "string") return bad("a write has expected and text: the run as read, and the run as it is to be, both text");
    const problem = expected.length > MAX_RUN_TEXT ? `expected is at most ${MAX_RUN_TEXT} characters` : text === "" ? "a run keeps its text: write at least one character" : textProblem(text);
    if (problem !== null) return bad(problem);
    return { revision, target, expected, text } satisfies Parsed;
  }

  #unattested(head: RoomHead): string {
    return (
      `the bytes of ${head.name} at revision ${head.revision} (sha256 ${head.sha256}) are not attested for live slide text writes: ` +
      "an operator who has reviewed the deck for fields, hyperlinks and other special text starts the server with --live-slide-text-attest <sha256>"
    );
  }

  // The engine --------------------------------------------------------------------------------------------------

  /** The deck of a head as the engine observes it: one read per head at a time, and one kept for the heads read last. */
  #deck(head: RoomHead, bytes: Uint8Array): Promise<Observed> {
    const known = this.#decks.get(head.sha256);
    if (known !== undefined) return Promise.resolve(known);
    let flight = this.#flights.get(head.sha256);
    if (flight === undefined) {
      flight = this.#load(head, bytes).finally(() => this.#flights.delete(head.sha256));
      this.#flights.set(head.sha256, flight);
      void flight.then((deck) => this.#decks.set(head.sha256, deck), () => undefined);
    }
    return flight;
  }

  #load(head: RoomHead, bytes: Uint8Array): Promise<Observed> {
    return this.#pool.withWorker(async (worker) => {
      const opened = await ask(worker, { cmd: "open", bytes: { bin: 0, len: bytes.length }, name: head.name, format: "pptx" }, [bytes]);
      try {
        if (opened.format !== "pptx" || opened.sha256 !== head.sha256) throw new EngineFault(`the engine opened ${head.name} as ${opened.format} with sha256 ${opened.sha256}, not the head ${head.sha256}`);
        const { body, segments } = await askWithSegments(worker, { cmd: "observe", doc: opened.doc, options: { max_nodes: MAX_DECK_NODES } });
        if (!body.ok) {
          const errors = Array.isArray(body.receipt.errors) ? (body.receipt.errors as { code?: unknown; message?: unknown }[]) : [];
          return `the engine could not observe the deck: ${errors.map((error) => String(error.message ?? error.code)).join("; ").slice(0, 300) || "no reason given"}`;
        }
        const output = body.outputs?.find((candidate) => candidate.path.endsWith(".view.json"));
        const segment = output === undefined ? undefined : segments[output.data.bin];
        if (segment === undefined) throw new EngineFault("the engine did not return a view of the deck");
        let view: unknown;
        try {
          view = JSON.parse(new TextDecoder().decode(segment));
        } catch (e) {
          if (e instanceof SyntaxError) throw new EngineFault("the engine's view of the deck is not JSON");
          throw e;
        }
        if (isObject(view) && view.source_sha256 !== undefined && view.source_sha256 !== head.sha256) throw new EngineFault("the engine's view is of other bytes than the head");
        return deckOf(view);
      } finally {
        await closeDocument(worker, opened.doc);
      }
    });
  }
}
