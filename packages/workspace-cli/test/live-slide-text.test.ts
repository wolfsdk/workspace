// Live slide text over the unified port: the reads and writes of `.../docs/<doc>/live-slide-text`, over a real room server
// (its database, blobs and session log) with the in-memory deck engine of `fixtures/deck-engine.ts`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor, RoomOp, RoomSessionEntry } from "@wolfsdk/protocol/workspace";
import { type ReadOnlyMode, RoomServer, scopedService } from "@wolfsdk/server";
import { startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";
import type { LiveCaller } from "../src/live-shared.ts";
import { LiveSlideText, MAX_RUN_TEXT, MAX_WRITE_BYTES } from "../src/live-slide-text.ts";
import { type Deck, DeckEngine, deckBytes, DeckPool, deckSha256, parseDeck } from "./fixtures/deck-engine.ts";

setDefaultTimeout(120_000);

const ADA: RoomActor = { kind: "user", id: "ada", name: "Ada" };
const LIN: RoomActor = { kind: "user", id: "lin", name: "Lin" };
const ROBOT: RoomActor = { kind: "agent", id: "robot", name: "Robot" };
const GUEST: RoomActor = { kind: "user", id: "guest", name: "Guest" };
const TOKENS = new Map<string, RoomActor>([
  ["t-ada", ADA],
  ["t-lin", LIN],
  ["t-robot", ROBOT],
  ["t-guest", GUEST],
]);
const MODE: ReadOnlyMode = { reason: "The trial ended on 2026-11-28.", upgrade: "https://cloud.example.test/upgrade" };

/** Two slides. On the first: a text box of two runs of different formatting, one of two paragraphs, and what live slide
 * text does not list (a table, a chart, a picture, a hidden box, a box with a field, a box with no paragraph), and notes. */
const DECK: Deck = {
  slides: [
    {
      id: 256,
      shapes: [
        { id: 2, name: "TextBox 1", paragraphs: [{ runs: [{ text: "North", bold: true }, { text: "South", italic: true }] }] },
        { id: 3, name: "TextBox 2", paragraphs: [{ runs: [{ text: "Fast PPTX" }] }, { runs: [{ text: "Lossless first" }] }] },
        { id: 4, kind: "table", name: "Table 3", paragraphs: [], rows: [["a", "b"]] },
        { id: 5, kind: "chart", name: "Chart 4", paragraphs: [] },
        { id: 6, kind: "picture", name: "Picture 5", paragraphs: [] },
        { id: 7, name: "Hidden", visible: false, paragraphs: [{ runs: [{ text: "secret" }] }] },
        { id: 8, name: "Field", paragraphs: [{ runs: [{ text: "7" }], shown: "Slide 7 of 9" }] },
        { id: 9, name: "Empty", paragraphs: [] },
      ],
      notes: ["Speaker notes"],
    },
    { id: 257, shapes: [{ id: 2, name: "Title", paragraphs: [{ runs: [{ text: "Second" }] }] }] },
  ],
};
const PICTURES: Deck = { slides: [{ id: 256, shapes: [{ id: 2, kind: "picture", name: "Picture 1", paragraphs: [] }] }] };

const DOC = "deck.pptx";
const PATH = `/api/rooms/r1/docs/${DOC}/live-slide-text`;
const SHAPE = "slide:#256/shape:#2";
const NORTH = `${SHAPE}/para:@1/run:@1`;
const SOUTH = `${SHAPE}/para:@1/run:@2`;
const FAST = "slide:#256/shape:#3/para:@1/run:@1";
const LOSSLESS = "slide:#256/shape:#3/para:@2/run:@1";
const SECOND = "slide:#257/shape:#2/para:@1/run:@1";

let dir: string;
let room: RoomServer;
let server: WorkspaceServer;
let pool: DeckPool;

async function start(options: Partial<WorkspaceServerOptions> = {}, attested: string[] = [deckSha256(DECK)]): Promise<WorkspaceServer> {
  pool = new DeckPool();
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    liveSlideText: { pool, attested },
    ...options,
  });
  return server;
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${server.url}${path}`, init);

/** The status and parsed JSON body of a response (`null` for an empty one): what `JSON.parse` leaves, for `expect` to check. */
async function answer(response: Response) {
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text), response };
}

const read = (query = "", token = "t-ada", path = PATH) => call(`${path}${query}`, { headers: auth(token) }).then(answer);
const send = (body: unknown, token = "t-ada", path = PATH) =>
  call(path, { method: "PUT", headers: { ...auth(token), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }).then(answer);
const write = (revision: number, target: string, expected: string, text: string, token = "t-ada") => send({ revision, target, expected, text }, token);
const texts = (body: { runs: { text: string }[] }): string[] => body.runs.map((run) => run.text);

/** The session entries of the room, all documents. */
async function sessionLog(): Promise<RoomSessionEntry[]> {
  const state = await room.getRoom("r1", ADA);
  if (!state.ok) throw new Error(state.error.message);
  return state.value.session_log;
}

async function head(): Promise<{ revision: number; sha256: string }> {
  const read = await room.readHead("r1", ADA, DOC);
  if (!read.ok) throw new Error(read.error.message);
  return read.value.head;
}

/** The deck the room holds at the head, as the engine stores it: where the formatting of the runs shows. */
async function deckAtHead(): Promise<Deck> {
  const read = await room.readHead("r1", ADA, DOC);
  if (!read.ok) throw new Error(read.error.message);
  return parseDeck(read.value.bytes);
}

/** A batch of ops committed to the head by a member, through the room: history that live slide text did not write. */
async function commit(ops: RoomOp[], actor: RoomActor = LIN): Promise<void> {
  const edited = await room.edit("r1", actor, { doc_name: DOC, base_revision: (await head()).revision, mode: "commit", batch: { ops } });
  expect(edited.ok).toBe(true);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-live-slide-text-"));
  room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new DeckEngine() });
  expect((await room.createRoom(ADA, { room_id: "r1", workspace_id: "ws" })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: DOC, format: "pptx", bytes: deckBytes(DECK) })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: "pictures.pptx", format: "pptx", bytes: deckBytes(PICTURES) })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: "notes.docx", format: "docx", bytes: deckBytes(DECK) })).ok).toBe(true);
  await start();
});

afterEach(async () => {
  await server?.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

describe("reading the text of a shape", () => {
  test("answers the text shapes with their slides, the runs of the first, and nothing the deck holds besides", async () => {
    const { status, body, response } = await read();
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Not the table, the chart, the picture, the hidden box, the box with a field, the box with no paragraph, the notes.
    expect(body).toEqual({
      revision: 0,
      shapes: [
        { id: SHAPE, label: "Slide 1: TextBox 1" },
        { id: "slide:#256/shape:#3", label: "Slide 1: TextBox 2" },
        { id: "slide:#257/shape:#2", label: "Slide 2: Title" },
      ],
      shape: SHAPE,
      runs: [
        { id: NORTH, text: "North" },
        { id: SOUTH, text: "South" },
      ],
      editable: true,
      refusal: null,
    });
  });

  test("reads the runs of the shape that is asked for, the paragraphs of it, and another slide's", async () => {
    const two = await read(`?shape=${encodeURIComponent("slide:#256/shape:#3")}`);
    expect(two.body.shape).toBe("slide:#256/shape:#3");
    expect(two.body.runs).toEqual([
      { id: FAST, text: "Fast PPTX" },
      { id: LOSSLESS, text: "Lossless first" },
    ]);
    expect(two.body.shapes).toHaveLength(3);
    const second = await read(`?shape=${encodeURIComponent("slide:#257/shape:#2")}`, "t-lin");
    expect(second.body.runs).toEqual([{ id: SECOND, text: "Second" }]);
  });

  test("refuses a shape that is not the id of one, and answers 404 with the revision for one that is not listed", async () => {
    for (const shape of ["", "2", "slide:#256", "slide:#256/shape:#2/para:@1", NORTH, "slide:#0/shape:#2", "slide:#256/shape:#2\n"]) {
      const bad = await read(`?shape=${encodeURIComponent(shape)}`);
      expect([shape, bad.status, bad.body.error.code]).toEqual([shape, 400, "BAD_REQUEST"]);
    }
    // Gone, never there, or a table, a chart, a picture, a hidden box, a box with a field or with no paragraph.
    for (const n of [1, 4, 5, 6, 7, 8, 9, 99]) {
      const gone = await read(`?shape=${encodeURIComponent(`slide:#256/shape:#${n}`)}`);
      expect([n, gone.status, gone.body.error.code, gone.body.error.revision]).toEqual([n, 404, "UNKNOWN_SHAPE", 0]);
    }
    expect((await read(`?shape=${encodeURIComponent("slide:#999/shape:#2")}`)).status).toBe(404);
  });

  test("answers the room's errors, and 400 for a document that is not a deck", async () => {
    const missing = await read("", "t-ada", "/api/rooms/r1/docs/nope.pptx/live-slide-text");
    expect([missing.status, missing.body.error.code]).toEqual([404, "UNKNOWN_DOCUMENT"]);
    const unknownRoom = await read("", "t-ada", "/api/rooms/nope/docs/deck.pptx/live-slide-text");
    expect([unknownRoom.status, unknownRoom.body.error.code]).toEqual([404, "UNKNOWN_ROOM"]);
    const word = await read("", "t-ada", "/api/rooms/r1/docs/notes.docx/live-slide-text");
    expect([word.status, word.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    const put = await send({ revision: 0, target: NORTH, expected: "North", text: "West" }, "t-ada", "/api/rooms/r1/docs/notes.docx/live-slide-text");
    expect([put.status, put.body.error.code]).toEqual([400, "BAD_REQUEST"]);
  });

  test("a deck with no shape of plain text lists none, says why it is not writable, and answers 404 for a shape that is asked for", async () => {
    const path = "/api/rooms/r1/docs/pictures.pptx/live-slide-text";
    const { status, body } = await read("", "t-ada", path);
    expect(status).toBe(200);
    expect([body.shapes, body.shape, body.runs, body.editable, body.refusal.code]).toEqual([[], null, [], false, "LIVE_SLIDE_TEXT_UNSUPPORTED"]);
    const asked = await read(`?shape=${encodeURIComponent("slide:#256/shape:#2")}`, "t-ada", path);
    expect([asked.status, asked.body.shape]).toEqual([404, undefined]);
  });

  test("a deck the engine cuts short is read as unsupported, not as a deck of what was left", async () => {
    pool.nodeLimit = 3;
    const { status, body } = await read();
    expect(status).toBe(200);
    expect([body.shapes, body.shape, body.runs, body.editable, body.refusal.code]).toEqual([[], null, [], false, "LIVE_SLIDE_TEXT_UNSUPPORTED"]);
    expect(body.refusal.message).toContain("more than");
    const asked = await read(`?shape=${encodeURIComponent(SHAPE)}`);
    expect([asked.status, asked.body.shape, asked.body.refusal.code]).toEqual([200, null, "LIVE_SLIDE_TEXT_UNSUPPORTED"]);
    const refused = await write(0, NORTH, "North", "West");
    expect([refused.status, refused.body.error.code]).toEqual([422, "LIVE_SLIDE_TEXT_UNSUPPORTED"]);
    expect((await head()).revision).toBe(0);
  });

  test("an engine that says the view is of other bytes is a failure of the engine, not a deck", async () => {
    pool.claimedSha256 = "0".repeat(64);
    const { status, body } = await read();
    expect([status, body.error.code]).toEqual([503, "ENGINE_FAILED"]);
  });

  test("reads a head once: the same head again, from anyone and for any shape, does not open it again", async () => {
    await read();
    expect([pool.opens, pool.observes]).toEqual([1, 1]);
    await read("", "t-lin");
    await read(`?shape=${encodeURIComponent("slide:#256/shape:#3")}`);
    expect([pool.opens, pool.observes]).toEqual([1, 1]);
    expect((await write(0, NORTH, "North", "West")).status).toBe(200);
    // The write used the deck of the head it read; the head it made is opened by the next read, once.
    expect(pool.opens).toBe(1);
    await read();
    await read("", "t-lin");
    expect(pool.opens).toBe(2);
  });
});

describe("which decks are writable", () => {
  test("none by default: it reads, says why it does not write, and refuses a write", async () => {
    await server.stop();
    await start({}, []);
    const { body } = await read();
    expect(body.editable).toBe(false);
    expect(body.refusal.code).toBe("LIVE_SLIDE_TEXT_UNATTESTED");
    expect(body.refusal.message).toContain(deckSha256(DECK));
    expect(body.refusal.message).toContain("--live-slide-text-attest");
    expect(texts(body)).toEqual(["North", "South"]);
    const refused = await write(0, NORTH, "North", "West");
    expect([refused.status, refused.body.error.code]).toEqual([403, "LIVE_SLIDE_TEXT_UNATTESTED"]);
    expect((await read()).body.revision).toBe(0);
  });

  test("a digest the operator attested is writable, and one that is not 64 hexadecimal digits is not accepted", () => {
    expect(() => new LiveSlideText(room, { pool, attested: ["cace0634"] })).toThrow(RangeError);
    expect(() => new LiveSlideText(room, { pool, attested: ["G".repeat(64)] })).toThrow(RangeError);
    const live = new LiveSlideText(room, { pool, attested: [deckSha256(DECK).toUpperCase()] });
    expect(live.writable(deckSha256(DECK))).toBe(true);
    expect(live.writable(deckSha256(PICTURES))).toBe(false);
  });

  test("the bytes of its own writes are writable, and the attestation stays with the bytes", async () => {
    expect((await write(0, NORTH, "North", "West")).status).toBe(200);
    expect((await write(1, NORTH, "West", "Nord")).status).toBe(200);
    expect((await read()).body.editable).toBe(true);
    // Back to the bytes of the upload: attested, whoever wrote them.
    expect((await write(2, NORTH, "Nord", "North")).status).toBe(200);
    expect((await head()).sha256).toBe(deckSha256(DECK));
    expect((await read()).body.editable).toBe(true);
  });

  test("a head that another kind of edit made is not writable", async () => {
    expect((await write(0, NORTH, "North", "West")).status).toBe(200);
    // A `set` of a room member that does not come through live slide text: nothing says what else it did.
    await commit([{ op: "set", target: FAST, value: { text: "Fast" } }]);
    const { body } = await read();
    expect([body.revision, body.editable, body.refusal.code]).toEqual([2, false, "LIVE_SLIDE_TEXT_UNATTESTED"]);
    expect(texts(await read(`?shape=${encodeURIComponent("slide:#256/shape:#3")}`).then((r) => r.body))).toEqual(["Fast", "Lossless first"]);
    const refused = await write(2, SOUTH, "South", "East");
    expect([refused.status, refused.body.error.code]).toEqual([403, "LIVE_SLIDE_TEXT_UNATTESTED"]);
  });
});

describe("writing a run", () => {
  test("commits one set of the run, as the member, and keeps the formatting of the run and of the run beside it", async () => {
    const wrote = await write(0, NORTH, "North", "West");
    expect([wrote.status, wrote.body]).toEqual([200, { revision: 1 }]);
    const { body } = await read();
    expect([body.revision, texts(body)]).toEqual([1, ["West", "South"]]);
    expect((await deckAtHead()).slides[0]!.shapes[0]!.paragraphs[0]!.runs).toEqual([
      { text: "West", bold: true },
      { text: "South", italic: true },
    ]);
    const log = await sessionLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.author).toEqual(ADA);
    expect(log[0]!.batch.label).toBe("live slide text");
    expect(log[0]!.batch.ops).toEqual([{ op: "set", target: NORTH, value: { text: "West" } }]);
  });

  test("writes a run of another paragraph, of another shape and of another slide, and takes text that is spaced and not Latin", async () => {
    expect((await write(0, LOSSLESS, "Lossless first", "  Zuerst: verlustfrei \u{1F680} ")).body).toEqual({ revision: 1 });
    expect((await write(1, SECOND, "Second", "\u7B2C\u4E8C")).body).toEqual({ revision: 2 });
    const deck = await deckAtHead();
    expect(deck.slides[0]!.shapes[1]!.paragraphs.map((p) => p.runs[0]!.text)).toEqual(["Fast PPTX", "  Zuerst: verlustfrei \u{1F680} "]);
    expect(deck.slides[1]!.shapes[0]!.paragraphs[0]!.runs[0]!.text).toBe("\u7B2C\u4E8C");
  });

  test("a write that changes nothing makes no revision", async () => {
    const same = await write(0, NORTH, "North", "North");
    expect([same.status, same.body]).toEqual([200, { revision: 0 }]);
    expect(await sessionLog()).toHaveLength(0);
  });

  test("keeps a run long and a run of one character, and refuses a longer one", async () => {
    const long = "x".repeat(MAX_RUN_TEXT);
    expect((await write(0, NORTH, "North", long)).body).toEqual({ revision: 1 });
    expect((await write(1, NORTH, long, "y")).body).toEqual({ revision: 2 });
    const over = await write(2, NORTH, "y", "x".repeat(MAX_RUN_TEXT + 1));
    expect([over.status, over.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    const bigExpected = await write(2, NORTH, "x".repeat(MAX_RUN_TEXT + 1), "z");
    expect([bigExpected.status, bigExpected.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    expect((await head()).revision).toBe(2);
  });

  test("refuses text a run cannot take: blank, a line break, a tab or other control character, a lone surrogate", async () => {
    const cases: [string, string][] = [
      ["blank", ""],
      ["a line feed", "a\nb"],
      ["a carriage return", "a\rb"],
      ["a vertical tab", "a\u000Bb"],
      ["a tab", "a\tb"],
      ["NUL", "a\u0000b"],
      ["escape", "a\u001Bb"],
      ["DEL", "a\u007Fb"],
      ["a C1 control", "a\u0085b"],
      ["a line separator", "a\u2028b"],
      ["a paragraph separator", "a\u2029b"],
      ["a noncharacter", "a\uFFFEb"],
      ["a lone high surrogate", "a\uD800b"],
      ["a lone low surrogate", "a\uDC00b"],
    ];
    for (const [what, text] of cases) {
      const refused = await write(0, NORTH, "North", text);
      expect([what, refused.status, refused.body.error.code]).toEqual([what, 400, "BAD_REQUEST"]);
    }
    expect((await head()).revision).toBe(0);
    expect(await sessionLog()).toHaveLength(0);
  });

  test("refuses a request that is not a write of one run, whatever the head", async () => {
    const good = { revision: 0, target: NORTH, expected: "North", text: "West" };
    const bodies: [string, unknown][] = [
      ["no revision", { ...good, revision: undefined }],
      ["a revision that is not a whole number", { ...good, revision: 0.5 }],
      ["a negative revision", { ...good, revision: -1 }],
      ["a revision that is text", { ...good, revision: "0" }],
      ["no target", { ...good, target: undefined }],
      ["a shape for a target", { ...good, target: SHAPE }],
      ["a paragraph for a target", { ...good, target: `${SHAPE}/para:@1` }],
      ["a run with a leading zero", { ...good, target: `${SHAPE}/para:@01/run:@1` }],
      ["a run with a suffix", { ...good, target: `${NORTH}/x` }],
      ["no expected", { ...good, expected: undefined }],
      ["an expected that is a number", { ...good, expected: 1 }],
      ["no text", { ...good, text: undefined }],
      ["a text that is a value", { ...good, text: { text: "West" } }],
      ["a member it does not know", { ...good, bold: true }],
      ["a draft revision of live cells", { ...good, draftRevision: 0 }],
      ["a list", [good]],
      ["null", null],
      ["a string", "North"],
    ];
    for (const [what, body] of bodies) {
      const refused = await send(body);
      expect([what, refused.status, refused.body.error.code]).toEqual([what, 400, "BAD_REQUEST"]);
    }
    const notJson = await send("{ not json");
    expect([notJson.status, notJson.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    expect((await head()).revision).toBe(0);
  });

  test("refuses a body of more than the bytes a write can take, without reading the rest", async () => {
    const big = JSON.stringify({ revision: 0, target: NORTH, expected: "North", text: "x".repeat(MAX_WRITE_BYTES) });
    const refused = await send(big);
    expect([refused.status, refused.body.error.code]).toEqual([413, "BAD_REQUEST"]);
    const chunked = await call(PATH, {
      method: "PUT",
      headers: { ...auth("t-ada"), "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit).then(answer);
    expect([chunked.status, chunked.body.error.code]).toEqual([413, "BAD_REQUEST"]);
    expect((await head()).revision).toBe(0);
  });

  test("names a run that is not one of a text shape: unknown, in a table, in a hidden or field shape, or past the end", async () => {
    const targets = [
      "slide:#256/shape:#2/para:@1/run:@3",
      "slide:#256/shape:#2/para:@2/run:@1",
      "slide:#256/shape:#4/para:@1/run:@1",
      "slide:#256/shape:#7/para:@1/run:@1",
      "slide:#256/shape:#8/para:@1/run:@1",
      "slide:#256/shape:#99/para:@1/run:@1",
      "slide:#999/shape:#2/para:@1/run:@1",
    ];
    for (const target of targets) {
      const refused = await write(0, target, "secret", "West");
      expect([target, refused.status, refused.body.error.code]).toEqual([target, 422, "RUN_UNSUPPORTED"]);
    }
    expect((await head()).revision).toBe(0);
  });
});

/** Native ids are unsigned 32-bit numbers, up to ten digits: a deck whose slide and shape numbers are the largest and some
 * near them, and numbers one past what a deck can hold. */
const WIDE: Deck = {
  slides: [
    {
      id: 4294967295,
      shapes: [
        { id: 4294967295, name: "Largest", paragraphs: [{ runs: [{ text: "Bold ", bold: true }, { text: "ordinary" }] }] },
        { id: 1234567890, name: "Ten digits", paragraphs: [{ runs: [{ text: "Ten digits" }] }] },
        { id: 4294967296, name: "Past the largest", paragraphs: [{ runs: [{ text: "not listed" }] }] },
        { id: 9999999999, name: "Past the largest by far", paragraphs: [{ runs: [{ text: "not listed" }] }] },
      ],
    },
    { id: 4294967296, shapes: [{ id: 2, name: "Slide past the largest", paragraphs: [{ runs: [{ text: "not listed" }] }] }] },
    { id: 256, shapes: [{ id: 3, name: "Ordinary", paragraphs: [{ runs: [{ text: "Ordinary" }] }] }] },
  ],
};
const WIDE_DOC = "wide.pptx";
const WIDE_PATH = `/api/rooms/r1/docs/${WIDE_DOC}/live-slide-text`;
const LARGEST = "slide:#4294967295/shape:#4294967295";
const TEN = "slide:#4294967295/shape:#1234567890";
const idsOf = (body: { shapes: { id: string }[] }): string[] => body.shapes.map((shape) => shape.id);

describe("native ids of ten digits", () => {
  beforeEach(async () => {
    expect((await room.addDocument("r1", ADA, { name: WIDE_DOC, format: "pptx", bytes: deckBytes(WIDE) })).ok).toBe(true);
    await server.stop();
    await start({}, [deckSha256(WIDE)]);
  });

  test("a listed shape whose ids have ten digits is selected, and an ordinary run of it is edited", async () => {
    const listed = await read("", "t-ada", WIDE_PATH);
    expect(listed.status).toBe(200);
    expect(idsOf(listed.body)).toContain(TEN);
    expect(listed.body.editable).toBe(true);
    const selected = await read(`?shape=${encodeURIComponent(TEN)}`, "t-ada", WIDE_PATH);
    expect([selected.status, selected.body.shape]).toEqual([200, TEN]);
    expect(selected.body.runs).toEqual([{ id: `${TEN}/para:@1/run:@1`, text: "Ten digits" }]);
    const wrote = await send({ revision: 0, target: `${TEN}/para:@1/run:@1`, expected: "Ten digits", text: "Ten digits, edited" }, "t-ada", WIDE_PATH);
    expect([wrote.status, wrote.body]).toEqual([200, { revision: 1 }]);
    const again = await read(`?shape=${encodeURIComponent(TEN)}`, "t-lin", WIDE_PATH);
    expect([again.body.revision, texts(again.body)]).toEqual([1, ["Ten digits, edited"]]);
    const log = await sessionLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.batch.ops).toEqual([{ op: "set", target: `${TEN}/para:@1/run:@1`, value: { text: "Ten digits, edited" } }]);
  });

  test("4294967295 is an id and 4294967296 is not: the list offers what a request takes, and a request past the largest is refused", async () => {
    const listed = await read("", "t-ada", WIDE_PATH);
    // Nothing under a number past the largest is listed, as a shape or on a slide.
    expect(idsOf(listed.body)).toEqual([LARGEST, TEN, "slide:#256/shape:#3"]);
    for (const shape of idsOf(listed.body)) {
      expect([shape, (await read(`?shape=${encodeURIComponent(shape)}`, "t-ada", WIDE_PATH)).status]).toEqual([shape, 200]);
    }
    const largest = await read(`?shape=${encodeURIComponent(LARGEST)}`, "t-ada", WIDE_PATH);
    expect(texts(largest.body)).toEqual(["Bold ", "ordinary"]);
    const refused = [
      "slide:#4294967296/shape:#2",
      "slide:#4294967295/shape:#4294967296",
      "slide:#4294967295/shape:#9999999999",
      "slide:#10000000000/shape:#2",
      "slide:#256/shape:#10000000000",
    ];
    for (const shape of refused) {
      const bad = await read(`?shape=${encodeURIComponent(shape)}`, "t-ada", WIDE_PATH);
      expect([shape, bad.status, bad.body.error.code]).toEqual([shape, 400, "BAD_REQUEST"]);
      const refusedWrite = await send({ revision: 0, target: `${shape}/para:@1/run:@1`, expected: "not listed", text: "West" }, "t-ada", WIDE_PATH);
      expect([shape, refusedWrite.status, refusedWrite.body.error.code]).toEqual([shape, 400, "BAD_REQUEST"]);
    }
    expect((await read("", "t-ada", WIDE_PATH)).body.revision).toBe(0);
    const wrote = await send({ revision: 0, target: `${LARGEST}/para:@1/run:@2`, expected: "ordinary", text: "extraordinary" }, "t-ada", WIDE_PATH);
    expect([wrote.status, wrote.body]).toEqual([200, { revision: 1 }]);
  });
});

describe("two members writing", () => {
  test("different runs of one shape from the same revision both land, and each keeps its formatting", async () => {
    expect((await write(0, NORTH, "North", "West", "t-ada")).body).toEqual({ revision: 1 });
    const second = await write(0, SOUTH, "South", "East", "t-lin");
    expect([second.status, second.body]).toEqual([200, { revision: 2 }]);
    const { body } = await read();
    expect([body.revision, texts(body)]).toEqual([2, ["West", "East"]]);
    expect((await deckAtHead()).slides[0]!.shapes[0]!.paragraphs[0]!.runs).toEqual([
      { text: "West", bold: true },
      { text: "East", italic: true },
    ]);
    expect((await sessionLog()).map((entry) => entry.author)).toEqual([ADA, LIN]);
  });

  test("the same run is a conflict that carries the run as it is now, and commits nothing", async () => {
    await write(0, NORTH, "North", "West", "t-ada");
    const lost = await write(0, NORTH, "North", "Nord", "t-lin");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "RUN_CONFLICT", revision: 1, current: "West" });
    expect((await read()).body.revision).toBe(1);
    expect(texts((await read()).body)).toEqual(["West", "South"]);
    // The loser keeps the draft, reads again and decides: writing over the winner it has now seen lands.
    const decided = await write(1, NORTH, "West", "Nord", "t-lin");
    expect([decided.status, decided.body]).toEqual([200, { revision: 2 }]);
  });

  test("a run that came back to what was read is still a conflict", async () => {
    await write(0, NORTH, "North", "West", "t-ada");
    await write(1, NORTH, "West", "North", "t-ada");
    const lost = await write(0, NORTH, "North", "Nord", "t-lin");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "RUN_CONFLICT", revision: 2, current: "North" });
    expect((await sessionLog())).toHaveLength(2);
  });

  test("a run that is not what was read is a conflict at the head, too", async () => {
    const lost = await write(0, NORTH, "Nope", "West");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "RUN_CONFLICT", revision: 0, current: "North" });
    expect(await sessionLog()).toHaveLength(0);
  });

  test("a read from a revision the deck has not reached is a structure conflict", async () => {
    const lost = await write(5, NORTH, "North", "West");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "STRUCTURE_CONFLICT", revision: 0 });
  });

  test("writes of one deck from many members at once all land, one after another", async () => {
    const edits: [string, string, string][] = [
      [NORTH, "North", "n"],
      [SOUTH, "South", "s"],
      [FAST, "Fast PPTX", "f"],
      [LOSSLESS, "Lossless first", "l"],
      [SECOND, "Second", "t"],
    ];
    const answers = await Promise.all(edits.map(([target, expected, text], i) => write(0, target, expected, text, i % 2 === 0 ? "t-ada" : "t-lin")));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answers.map((a) => a.body.revision).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(texts((await read()).body)).toEqual(["n", "s"]);
    expect(texts((await read(`?shape=${encodeURIComponent("slide:#256/shape:#3")}`)).body)).toEqual(["f", "l"]);
    expect(texts((await read(`?shape=${encodeURIComponent("slide:#257/shape:#2")}`)).body)).toEqual(["t"]);
  });

  test("two writes of one run at once: one lands, the other is told what the run holds", async () => {
    const answers = await Promise.all([write(0, NORTH, "North", "ada", "t-ada"), write(0, NORTH, "North", "lin", "t-lin")]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const winner = answers[0]!.status === 200 ? "ada" : "lin";
    expect(answers.find((a) => a.status === 409)!.body.error).toMatchObject({ code: "RUN_CONFLICT", revision: 1, current: winner });
    expect(texts((await read()).body)).toEqual([winner, "South"]);
  });
});

describe("history that is not writes of the text of runs", () => {
  const liveOf = (...attested: string[]): LiveSlideText => new LiveSlideText(room, { pool, attested });
  const caller: LiveCaller = { roomId: "r1", doc: DOC, actor: ADA, refusal: null };
  const put = (live: LiveSlideText, revision: number, target: string, expected: string, text: string, actor: RoomActor = ADA) =>
    live.put({ ...caller, actor }, { revision, target, expected, text });
  const structure = (revision: number) => ({ status: 409, error: { code: "STRUCTURE_CONFLICT", revision } });

  test("a shape deleted since the read is a structure conflict, whoever's write it is, and a read of the head lands", async () => {
    await commit([{ op: "delete", target: "slide:#256/shape:#3" }]);
    // The operator attests both the upload and the head the delete made.
    const live = liveOf(deckSha256(DECK), (await head()).sha256);
    expect(await put(live, 0, NORTH, "North", "West")).toMatchObject(structure(1));
    expect(await put(live, 1, NORTH, "North", "West")).toEqual({ status: 200, body: { revision: 2 } });
  });

  test("a paragraph set since the read is a structure conflict, not a run that is gone, and the runs it left are what is read", async () => {
    await commit([{ op: "set", target: `${SHAPE}/para:@1`, value: { text: "Nord" } }]);
    const live = liveOf((await head()).sha256);
    expect(await put(live, 0, SOUTH, "South", "East")).toMatchObject(structure(1));
    // From the head the run is not there any more.
    expect(await put(live, 1, SOUTH, "South", "East")).toMatchObject({ status: 422, error: { code: "RUN_UNSUPPORTED" } });
    expect(await put(live, 1, NORTH, "Nord", "West")).toEqual({ status: 200, body: { revision: 2 } });
  });

  test("a set that carries more than the text is not a write of text", async () => {
    await commit([{ op: "set", target: SOUTH, value: { text: "Sud", bold: true } }]);
    const live = liveOf((await head()).sha256);
    expect(await put(live, 0, NORTH, "North", "West")).toMatchObject(structure(1));
  });

  test("a set of the text of a run, from outside, is history of the kind that is rebased over", async () => {
    await commit([{ op: "set", target: SOUTH, value: { text: "East" } }]);
    const live = liveOf((await head()).sha256);
    expect(await put(live, 0, NORTH, "North", "West")).toEqual({ status: 200, body: { revision: 2 } });
    expect(await put(live, 0, SOUTH, "South", "Sud")).toMatchObject({ status: 409, error: { code: "RUN_CONFLICT", current: "East" } });
  });

  test("history that is not all there is not rebased over", async () => {
    const hidden = new Proxy(room, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const result = member.apply(target, args);
          if (property !== "getRoom") return result;
          return Promise.resolve(result).then((state) => (state.ok ? { ...state, value: { ...state.value, session_log: state.value.session_log.filter((entry: RoomSessionEntry) => entry.revision !== 1) } } : state));
        };
      },
    });
    const live = new LiveSlideText(hidden, { pool, attested: [deckSha256(DECK)] });
    expect(await put(live, 0, NORTH, "North", "West")).toEqual({ status: 200, body: { revision: 1 } });
    expect(await put(live, 1, NORTH, "West", "Nord")).toEqual({ status: 200, body: { revision: 2 } });
    expect(await put(live, 0, FAST, "Fast PPTX", "Fast")).toMatchObject(structure(2));
    // The same read through the room as it is lands.
    expect(await put(liveOf(deckSha256(DECK), (await head()).sha256), 0, FAST, "Fast PPTX", "Fast")).toEqual({ status: 200, body: { revision: 3 } });
  });

  test("a read some revisions old lands when none of the writes since touched its run, and conflicts when one did", async () => {
    const live = liveOf(deckSha256(DECK));
    for (const [i, [expected, text]] of [["North", "a1"], ["a1", "a2"], ["a2", "a3"]].entries()) {
      expect(await put(live, i, NORTH, expected!, text!)).toEqual({ status: 200, body: { revision: i + 1 } });
    }
    // From before the first write, of a run none of the three wrote.
    expect(await put(live, 0, SOUTH, "South", "s1")).toEqual({ status: 200, body: { revision: 4 } });
    // From revision 2, of the run the third write wrote.
    expect(await put(live, 2, NORTH, "a2", "x")).toMatchObject({ status: 409, error: { code: "RUN_CONFLICT", revision: 4, current: "a3" } });
    // From revision 3, of the same run: only the write of the other run came since.
    expect(await put(live, 3, NORTH, "a3", "x")).toEqual({ status: 200, body: { revision: 5 } });
  });
});

describe("who may use it", () => {
  test("members only: no token is 401, an agent and a guest are 403, on both methods", async () => {
    await server.stop();
    const scopeOf = (actor: RoomActor) => (actor.id === GUEST.id ? { access: "view" as const, docs: [{ room_id: "r1", doc_name: DOC }] } : null);
    await start({ service: scopedService(room, scopeOf), scopeOf });
    const none = await call(PATH);
    expect([none.status, (await none.json()).error.code]).toEqual([401, "UNAUTHORIZED"]);
    for (const token of ["t-robot", "t-guest"]) {
      const results = [await read("", token), await write(0, NORTH, "North", "West", token)];
      for (const result of results) expect([token, result.status, result.body.error.code]).toEqual([token, 403, "FORBIDDEN"]);
    }
    expect((await head()).revision).toBe(0);
    expect((await read("", "t-lin")).status).toBe(200);
  });

  test("a read-only workspace reads, says so, and refuses a write before it reads the request", async () => {
    await server.stop();
    await start({ readOnly: MODE });
    const { body } = await read();
    expect(body.editable).toBe(false);
    expect(body.refusal).toEqual({ code: "LICENSE_LIMIT", message: `workspace-read-only: ${MODE.reason} ${MODE.upgrade}` });
    expect(texts(body)).toEqual(["North", "South"]);
    expect(body.shapes).toHaveLength(3);
    const put = await send("{ not json");
    expect([put.status, put.body.error.code]).toEqual([402, "LICENSE_LIMIT"]);
    const valid = await write(0, NORTH, "North", "West");
    expect([valid.status, valid.body.error.code]).toEqual([402, "LICENSE_LIMIT"]);
    expect((await head()).revision).toBe(0);
  });

  test("answers 405 to other methods, and 501 where the server has no engine for it", async () => {
    for (const method of ["DELETE", "POST", "PATCH"]) {
      const refused = await call(PATH, { method, headers: auth("t-ada") });
      expect([method, refused.status, refused.headers.get("allow")]).toEqual([method, 405, "GET, PUT"]);
    }
    await server.stop();
    await start({ liveSlideText: null });
    const { status, body } = await read();
    expect([status, body.error.code]).toEqual([501, "NO_LIVE_SLIDE_TEXT"]);
    const put = await write(0, NORTH, "North", "West");
    expect([put.status, put.body.error.code]).toEqual([501, "NO_LIVE_SLIDE_TEXT"]);
  });
});
