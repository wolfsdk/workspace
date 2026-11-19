// Live cells over the unified port: the reads, writes and selections of `.../docs/<doc>/live-cells`, over a real room server
// (its database, blobs and session log) with the in-memory grid engine of `fixtures/grid-engine.ts`.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomActor, RoomSessionEntry } from "@wolfsdk/protocol/workspace";
import { type ReadOnlyMode, RoomServer, scopedService } from "@wolfsdk/server";
import { startWorkspaceServer, tokenOf, type WorkspaceServer, type WorkspaceServerOptions } from "../src/http.ts";
import { FORMULA_CLASS, formulaProblem, LiveCells, type LiveCaller, type LiveReply, PRESENCE_MAX, PRESENCE_TTL_MS } from "../src/live-cells.ts";
import { GridEngine, type Grid, gridBytes, GridPool, gridSha256 } from "./fixtures/grid-engine.ts";

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

/** Two sheets: scalar cells, a formula with its calculated display, an error constant, and a merged range. */
const BOOK: Grid = {
  sheets: [
    {
      name: "Assumptions",
      cells: {
        A1: { value: { string: "Model" }, display: "Model" },
        A2: { value: { string: "Revenue" }, display: "Revenue" },
        B2: { value: { number: 1000 }, display: "1,000.00" },
        B3: { value: { number: 0.08 }, display: "0.08" },
        C2: { formula: "=B2*2", display: "2,000.00" },
        D1: { value: { error: "#DIV/0!" }, display: "#DIV/0!" },
      },
      merged: ["F1:H2"],
    },
    { name: "Model", cells: { B2: { formula: "=Assumptions!B2*(1+Growth)", display: "1,080.00" } } },
  ],
};
const HIDDEN: Grid = {
  sheets: [
    { name: "Hidden", visibility: "hidden", cells: { A1: { value: { string: "secret" }, display: "secret" } } },
    { name: "Shown", cells: { A1: { value: { string: "open" }, display: "open" } } },
  ],
};
const DOC = "book.xlsx";
const PATH = `/api/rooms/r1/docs/${DOC}/live-cells`;

let dir: string;
let room: RoomServer;
let server: WorkspaceServer;
let pool: GridPool;
let clock = 1_000_000;

async function start(options: Partial<WorkspaceServerOptions> = {}, attested: string[] = [gridSha256(BOOK)]): Promise<WorkspaceServer> {
  pool = new GridPool();
  server = startWorkspaceServer({
    service: room,
    authenticate: (request) => {
      const token = tokenOf(request);
      return token === null ? null : (TOKENS.get(token) ?? null);
    },
    liveCells: { pool, attested, now: () => clock },
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
const send = (method: "PUT" | "POST", body: unknown, token = "t-ada", path = PATH) =>
  call(path, { method, headers: { ...auth(token), "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }).then(answer);
const write = (body: Record<string, unknown>, token = "t-ada") => send("PUT", { sheet: 1, ...body }, token);
const announce = (sheet: number, a1: string, token = "t-ada") => send("POST", { sheet, a1 }, token);
/** One cell of a read, by its address. */
const cellOf = (body: { cells: { a1: string; value?: unknown; display?: string }[] }, a1: string): { a1: string; value?: unknown; display?: string } | undefined => body.cells.find((c) => c.a1 === a1);

/** The session entries of the room, all documents. */
async function sessionLog(): Promise<RoomSessionEntry[]> {
  const state = await room.getRoom("r1", ADA);
  if (!state.ok) throw new Error(state.error.message);
  return state.value.session_log;
}

/** The ids of the peers in the body of a `LiveCells` read. */
function peerIdsOf(reply: LiveReply): string[] {
  if (!("body" in reply) || typeof reply.body !== "object" || reply.body === null || !("peers" in reply.body) || !Array.isArray(reply.body.peers)) {
    throw new Error(`the reply is not a read: ${JSON.stringify(reply)}`);
  }
  return reply.body.peers.map((peer: { id: string }) => peer.id);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wolfsdk-live-cells-"));
  room = new RoomServer({ dbPath: join(dir, "rooms.sqlite"), blobDir: join(dir, "blobs"), engine: new GridEngine() });
  expect((await room.createRoom(ADA, { room_id: "r1", workspace_id: "ws" })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: DOC, format: "xlsx", bytes: gridBytes(BOOK) })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: "hidden.xlsx", format: "xlsx", bytes: gridBytes(HIDDEN) })).ok).toBe(true);
  expect((await room.addDocument("r1", ADA, { name: "notes.docx", format: "docx", bytes: gridBytes(BOOK) })).ok).toBe(true);
  clock = 1_000_000;
  await start();
});

afterEach(async () => {
  await server?.stop();
  await room.close();
  await rm(dir, { recursive: true, force: true });
});

describe("reading a window", () => {
  test("answers the cells with formulas as text, the display, the sheets, the merged ranges and no peers", async () => {
    const { status, body, response } = await read("?sheet=1&range=A1:H3");
    expect(status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      revision: 0,
      sheet: 1,
      sheets: [
        { id: 1, name: "Assumptions" },
        { id: 2, name: "Model" },
      ],
      editable: true,
      refusal: null,
      merged: ["F1:H2"],
      cells: [
        { a1: "A1", value: { string: "Model" } },
        { a1: "A2", value: { string: "Revenue" } },
        { a1: "B2", value: { number: 1000 }, display: "1,000.00" },
        { a1: "B3", value: { number: 0.08 }, display: "0.08" },
        { a1: "C2", value: { formula: "=B2*2" }, display: "2,000.00" },
        { a1: "D1", value: null, display: "#DIV/0!", editable: false },
      ],
      peers: [],
    });
  });

  test("reads another sheet, and a single cell given as B2 or as B2:B2", async () => {
    const model = await read("?sheet=2&range=B2");
    expect(model.body.sheet).toBe(2);
    expect(model.body.cells).toEqual([{ a1: "B2", value: { formula: "=Assumptions!B2*(1+Growth)" }, display: "1,080.00" }]);
    const one = await read("?sheet=1&range=b2:b2");
    expect(one.body.cells).toEqual([{ a1: "B2", value: { number: 1000 }, display: "1,000.00" }]);
    expect((await read("?sheet=1&range=B2")).body.cells).toEqual(one.body.cells);
  });

  test("takes the first visible sheet and A1:T50 when the request names none, and lists no hidden sheet", async () => {
    const { status, body } = await read("", "t-ada", "/api/rooms/r1/docs/hidden.xlsx/live-cells");
    expect(status).toBe(200);
    expect(body.sheet).toBe(2);
    expect(body.sheets).toEqual([{ id: 2, name: "Shown" }]);
    expect(body.cells).toEqual([{ a1: "A1", value: { string: "open" } }]);
    const hidden = await read("?sheet=1", "t-ada", "/api/rooms/r1/docs/hidden.xlsx/live-cells");
    expect(hidden.status).toBe(400);
    expect(hidden.body.error.code).toBe("BAD_REQUEST");
  });

  test("refuses a window that is not one, or too big", async () => {
    const refused = ["A1:ZZZ9999", "B2:A1", "$B$2", "B2:C3:D4", "", "A1:GS5", "A1:A1001", "A1:GR51", "1A", "A0"];
    for (const range of refused) {
      const { status, body } = await read(`?range=${encodeURIComponent(range)}`);
      expect([range, status, body.error?.code]).toEqual([range, 400, "BAD_REQUEST"]);
    }
    expect((await read("?sheet=0")).status).toBe(400);
    expect((await read("?sheet=one")).status).toBe(400);
    expect((await read("?sheet=3")).status).toBe(400);
    expect((await read("?range=A1:GR50")).status).toBe(200);
    expect((await read("?range=A1:A1000")).status).toBe(200);
  });

  test("answers the room's errors, and 400 for a document that is not a workbook", async () => {
    const missing = await read("", "t-ada", "/api/rooms/r1/docs/nope.xlsx/live-cells");
    expect([missing.status, missing.body.error.code]).toEqual([404, "UNKNOWN_DOCUMENT"]);
    const unknownRoom = await read("", "t-ada", "/api/rooms/nope/docs/book.xlsx/live-cells");
    expect([unknownRoom.status, unknownRoom.body.error.code]).toEqual([404, "UNKNOWN_ROOM"]);
    const word = await read("", "t-ada", "/api/rooms/r1/docs/notes.docx/live-cells");
    expect([word.status, word.body.error.code]).toEqual([400, "BAD_REQUEST"]);
  });

  test("reads a head once per window: the same window again, from anyone, does not open it again", async () => {
    await read("?sheet=1&range=A1:H3");
    expect(pool.opens).toBe(1);
    await read("?sheet=1&range=A1:H3", "t-lin");
    expect(pool.opens).toBe(1);
    await read("?sheet=1&range=A1:C3");
    expect(pool.opens).toBe(2);
    expect((await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 5 } })).status).toBe(200);
    const after = pool.opens;
    await read("?sheet=1&range=A1:H3");
    expect(pool.opens).toBe(after + 1);
  });
});

describe("which workbooks are writable", () => {
  test("none by default: it reads, says why it does not write, and refuses a write", async () => {
    await server.stop();
    await start({}, []);
    const { body } = await read("?range=A1:B2");
    expect(body.editable).toBe(false);
    expect(body.refusal.code).toBe("LIVE_CELLS_UNATTESTED");
    expect(body.refusal.message).toContain(gridSha256(BOOK));
    expect(body.refusal.message).toContain("--live-cells-attest");
    expect(body.cells).toHaveLength(3);
    const refused = await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 1 } });
    expect([refused.status, refused.body.error.code]).toEqual([403, "LIVE_CELLS_UNATTESTED"]);
    expect((await announce(1, "B2")).status).toBe(204);
    expect((await read()).body.revision).toBe(0);
  });

  test("a digest the operator attested is writable, and one that is not 64 hexadecimal digits is not accepted", () => {
    expect(() => new LiveCells(room, { pool, attested: ["cace0634"] })).toThrow(RangeError);
    expect(() => new LiveCells(room, { pool, attested: ["G".repeat(64)] })).toThrow(RangeError);
    const live = new LiveCells(room, { pool, attested: [gridSha256(BOOK).toUpperCase()] });
    expect(live.writable(gridSha256(BOOK))).toBe(true);
    expect(live.writable(gridSha256(HIDDEN))).toBe(false);
  });

  test("a head that another kind of edit made is not writable, and the attestation stays with the bytes", async () => {
    expect((await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 2000 } })).status).toBe(200);
    expect((await write({ revision: 1, a1: "B3", expected: { number: 0.08 }, value: { number: 0.1 } })).status).toBe(200);
    // A `set` of a room member that does not come through live cells: nothing says what else it did.
    const edited = await room.edit("r1", LIN, {
      doc_name: DOC,
      base_revision: 2,
      mode: "commit",
      batch: { ops: [{ op: "set", target: "sheet:#1/cell:B9", value: { number: 9 } }] },
    });
    expect(edited.ok).toBe(true);
    const { body } = await read("?range=A1:B9");
    expect([body.revision, body.editable, body.refusal.code]).toEqual([3, false, "LIVE_CELLS_UNATTESTED"]);
    expect(cellOf(body, "B9")?.value).toEqual({ number: 9 });
    const refused = await write({ revision: 3, a1: "B4", expected: null, value: { number: 4 } });
    expect([refused.status, refused.body.error.code]).toEqual([403, "LIVE_CELLS_UNATTESTED"]);
  });
});

describe("writing a cell", () => {
  test("commits one set, as the member, whatever the value: number, text, boolean, formula, clear", async () => {
    const steps: [string, Record<string, unknown>, unknown][] = [
      ["B3", { expected: { number: 0.08 }, value: { number: 0.125 } }, { number: 0.125 }],
      ["A3", { expected: null, value: { string: "Growth" } }, { string: "Growth" }],
      ["B4", { expected: null, value: { boolean: true } }, { boolean: true }],
      ["B5", { expected: null, value: { formula: "=B2*B3" } }, { formula: "=B2*B3" }],
      ["A3", { expected: { string: "Growth" }, value: null }, null],
    ];
    for (const [i, [a1, step, now]] of steps.entries()) {
      const wrote = await write({ revision: i, a1, ...step });
      expect([a1, wrote.status, wrote.body]).toEqual([a1, 200, { revision: i + 1 }]);
      const { body } = await read(`?range=${a1}`);
      expect([a1, body.revision, body.cells[0]?.value ?? null]).toEqual([a1, i + 1, now]);
    }
    const { body } = await read("?range=A1:H5");
    expect(cellOf(body, "B5")).toEqual({ a1: "B5", value: { formula: "=B2*B3" } });
    expect(cellOf(body, "A3")).toBeUndefined();
    const log = await sessionLog();
    expect(log).toHaveLength(5);
    expect(log.map((entry) => entry.author)).toEqual([ADA, ADA, ADA, ADA, ADA]);
    expect(log.map((entry) => entry.batch.label)).toEqual(Array(5).fill("live cell"));
    expect(log[0]!.batch.ops).toEqual([{ op: "set", target: "sheet:#1/cell:B3", value: { number: 0.125 } }]);
    expect(log[3]!.batch.ops).toEqual([{ op: "set", target: "sheet:#1/cell:B5", value: { formula: "=B2*B3" } }]);
    expect(log[4]!.batch.ops).toEqual([{ op: "set", target: "sheet:#1/cell:A3", value: { empty: true } }]);
  });

  test("writes a cell of another sheet by its place", async () => {
    const wrote = await send("PUT", { revision: 0, sheet: 2, a1: "C3", expected: null, value: { string: "note" } });
    expect(wrote.status).toBe(200);
    expect((await read("?sheet=2&range=C3")).body.cells).toEqual([{ a1: "C3", value: { string: "note" } }]);
  });

  test("keeps the formula text apart from its value: expected is compared as typed, never as shown", async () => {
    const byValue = await write({ revision: 0, a1: "C2", expected: { number: 2000 }, value: { number: 1 } });
    expect([byValue.status, byValue.body.error.code, byValue.body.error.current]).toEqual([409, "CELL_CONFLICT", { formula: "=B2*2" }]);
    const byDisplay = await write({ revision: 0, a1: "C2", expected: { string: "2,000.00" }, value: { number: 1 } });
    expect(byDisplay.status).toBe(409);
    const byText = await write({ revision: 0, a1: "C2", expected: { formula: "=B2*2" }, value: { formula: "=B2*3" } });
    expect([byText.status, byText.body]).toEqual([200, { revision: 1 }]);
  });

  test("a write that changes nothing makes no revision", async () => {
    const same = await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 1000 } });
    expect([same.status, same.body]).toEqual([200, { revision: 0 }]);
    const blank = await write({ revision: 0, a1: "E5", expected: null, value: null });
    expect([blank.status, blank.body]).toEqual([200, { revision: 0 }]);
    expect((await read()).body.revision).toBe(0);
  });

  test("refuses what live cells cannot take: a merged cell, an error constant, text it cannot hold", async () => {
    const inside = await write({ revision: 0, a1: "G2", expected: null, value: { number: 1 } });
    expect([inside.status, inside.body.error.code]).toEqual([422, "CELL_UNSUPPORTED"]);
    expect((await write({ revision: 0, a1: "F1", expected: null, value: { number: 1 } })).status).toBe(200);
    const constant = await write({ revision: 1, a1: "D1", expected: null, value: { number: 1 } });
    expect([constant.status, constant.body.error.code]).toEqual([422, "CELL_UNSUPPORTED"]);
    for (const text of ["a\u0000b", "x".repeat(32_768), "lone \ud800 surrogate"]) {
      const refused = await write({ revision: 1, a1: "A9", expected: null, value: { string: text } });
      expect([refused.status, refused.body.error.code]).toEqual([422, "CELL_UNSUPPORTED"]);
    }
    const empty = await write({ revision: 1, a1: "A9", expected: null, value: { string: "" } });
    expect([empty.status, empty.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    const tabs = await write({ revision: 1, a1: "A9", expected: null, value: { string: "a\tb\nc" } });
    expect(tabs.status).toBe(200);
  });

  test("refuses a formula outside the class, in words, and commits nothing", async () => {
    for (const formula of ["=SUM(A1:A2)", "=Model!B2", "=A1 + 1", "=B4+1", "B2*2", "=", "=1e3", "=\"x\""]) {
      const refused = await write({ revision: 0, a1: "B4", expected: null, value: { formula } });
      expect([formula, refused.status, refused.body.error.code]).toEqual([formula, 422, "UNSUPPORTED_FORMULA"]);
    }
    const message = (await write({ revision: 0, a1: "B4", expected: null, value: { formula: "=SUM(A1:A2)" } })).body.error.message;
    expect(message).toContain(FORMULA_CLASS);
    expect((await read()).body.revision).toBe(0);
  });

  test("refuses a request that is not a write, whatever the head", async () => {
    const ok = { revision: 0, sheet: 1, a1: "B4", expected: null, value: { number: 1 } };
    const bad: [string, unknown][] = [
      ["not JSON", "{"],
      ["an array", "[]"],
      ["an unknown member", { ...ok, who: "ada" }],
      ["a $ address", { ...ok, a1: "$B$4" }],
      ["a range", { ...ok, a1: "B4:B5" }],
      ["no address", { ...ok, a1: undefined }],
      ["sheet 0", { ...ok, sheet: 0 }],
      ["a sheet name", { ...ok, sheet: "Assumptions" }],
      ["a negative revision", { ...ok, revision: -1 }],
      ["a fractional revision", { ...ok, revision: 1.5 }],
      ["no expected", { revision: 0, sheet: 1, a1: "B4", value: null }],
      ["no value", { revision: 0, sheet: 1, a1: "B4", expected: null }],
      ["two kinds in one value", { ...ok, value: { number: 1, string: "x" } }],
      ["a number as text", { ...ok, value: { number: "1" } }],
      ["an unknown kind", { ...ok, value: { date: "2026-11-28" } }],
      ["a value that is not a cell", { ...ok, value: 1 }],
      ["a sheet that is not there", { ...ok, sheet: 3 }],
    ];
    for (const [what, body] of bad) {
      const refused = await send("PUT", body);
      expect([what, refused.status, refused.body.error.code]).toEqual([what, 400, "BAD_REQUEST"]);
    }
    expect((await read()).body.revision).toBe(0);
  });
});

describe("two members writing", () => {
  test("different cells from the same revision both land, the second on the head the first made", async () => {
    expect((await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 2000 } }, "t-ada")).body).toEqual({ revision: 1 });
    const second = await write({ revision: 0, a1: "B3", expected: { number: 0.08 }, value: { number: 0.125 } }, "t-lin");
    expect([second.status, second.body]).toEqual([200, { revision: 2 }]);
    const { body } = await read("?range=B2:B3");
    expect(body.cells.map((c: { value: unknown }) => c.value)).toEqual([{ number: 2000 }, { number: 0.125 }]);
  });

  test("the same cell is a conflict that carries the cell as it is now, and commits nothing", async () => {
    await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { formula: "=B3*8192" } }, "t-ada");
    const lost = await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { formula: "=B3*2" } }, "t-lin");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "CELL_CONFLICT", revision: 1, current: { formula: "=B3*8192" } });
    expect((await read()).body.revision).toBe(1);
  });

  test("a cell that came back to what was read is still a conflict", async () => {
    await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 7 } }, "t-ada");
    await write({ revision: 1, a1: "B2", expected: { number: 7 }, value: { number: 1000 } }, "t-ada");
    const lost = await write({ revision: 0, a1: "B2", expected: { number: 1000 }, value: { number: 5 } }, "t-lin");
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "CELL_CONFLICT", revision: 2, current: { number: 1000 } });
  });

  test("a cell that is not what was read is a conflict at the head, too", async () => {
    const lost = await write({ revision: 0, a1: "B3", expected: { number: 9 }, value: { number: 1 } });
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "CELL_CONFLICT", revision: 0, current: { number: 0.08 } });
  });

  test("a read from a revision the workbook has not reached is a structure conflict", async () => {
    const lost = await write({ revision: 5, a1: "B3", expected: { number: 0.08 }, value: { number: 1 } });
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatchObject({ code: "STRUCTURE_CONFLICT", revision: 0 });
  });

  test("writes of one workbook from many members at once all land, one after another", async () => {
    const cells = ["D2", "D3", "D4", "D5", "D6", "D7"];
    const answers = await Promise.all(cells.map((a1, i) => write({ revision: 0, a1, expected: null, value: { number: i } }, i % 2 === 0 ? "t-ada" : "t-lin")));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(answers.map((a) => a.body.revision).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const { body } = await read("?range=D2:D7");
    expect(body.revision).toBe(6);
    expect(body.cells.map((c: { value: unknown }) => c.value)).toEqual([0, 1, 2, 3, 4, 5].map((number) => ({ number })));
  });

  test("two writes of one cell at once: one lands, the other is told what the cell holds", async () => {
    const answers = await Promise.all([
      write({ revision: 0, a1: "E2", expected: null, value: { string: "ada" } }, "t-ada"),
      write({ revision: 0, a1: "E2", expected: null, value: { string: "lin" } }, "t-lin"),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const winner = answers[0]!.status === 200 ? "ada" : "lin";
    expect(answers.find((a) => a.status === 409)!.body.error).toMatchObject({ code: "CELL_CONFLICT", revision: 1, current: { string: winner } });
    expect((await read("?range=E2")).body.cells).toEqual([{ a1: "E2", value: { string: winner } }]);
  });

  test("history that is not writes of cells is a structure conflict, whoever's write it is", async () => {
    const edited = await room.edit("r1", LIN, {
      doc_name: DOC,
      base_revision: 0,
      mode: "commit",
      batch: { ops: [{ op: "merge", target: "sheet:#1/range:J1:K2" }] },
    });
    expect(edited.ok).toBe(true);
    const head = await room.readHead("r1", ADA, DOC);
    if (!head.ok) throw new Error("no head");
    // The operator attests both the upload and the head the merge made.
    const live = new LiveCells(room, { pool, attested: [gridSha256(BOOK), head.value.head.sha256], now: () => clock });
    const caller = { roomId: "r1", doc: DOC, actor: ADA, refusal: null };
    const stale = await live.put(caller, { revision: 0, sheet: 1, a1: "B3", expected: { number: 0.08 }, value: { number: 1 } });
    expect(stale).toMatchObject({ status: 409, error: { code: "STRUCTURE_CONFLICT", revision: 1 } });
    const fresh = await live.put(caller, { revision: 1, sheet: 1, a1: "B3", expected: { number: 0.08 }, value: { number: 1 } });
    expect(fresh).toEqual({ status: 200, body: { revision: 2 } });
  });

  test("a read some revisions old lands when none of the writes since touched its cell, and conflicts when one did", async () => {
    const live = new LiveCells(room, { pool, attested: [gridSha256(BOOK)], now: () => clock });
    const caller: LiveCaller = { roomId: "r1", doc: DOC, actor: ADA, refusal: null };
    for (let i = 0; i < 3; i++) {
      const wrote = await live.put(caller, { revision: i, sheet: 1, a1: "E2", expected: i === 0 ? null : { number: i }, value: { number: i + 1 } });
      expect(wrote).toEqual({ status: 200, body: { revision: i + 1 } });
    }
    // From before the first write, of a cell none of the three wrote.
    expect(await live.put(caller, { revision: 0, sheet: 1, a1: "E3", expected: null, value: { number: 1 } })).toEqual({ status: 200, body: { revision: 4 } });
    // From revision 2, of the cell the third write wrote.
    expect(await live.put(caller, { revision: 2, sheet: 1, a1: "E2", expected: { number: 2 }, value: { number: 9 } })).toMatchObject({
      status: 409,
      error: { code: "CELL_CONFLICT", revision: 4, current: { number: 3 } },
    });
    // From revision 3, of the same cell: only the write of E3 came since.
    expect(await live.put(caller, { revision: 3, sheet: 1, a1: "E2", expected: { number: 3 }, value: { number: 9 } })).toEqual({ status: 200, body: { revision: 5 } });
  });
});

describe("history that is not writes of cells, and a draft written again", () => {
  const liveOf = (...attested: string[]): LiveCells => new LiveCells(room, { pool, attested, now: () => clock });
  const put = (live: LiveCells, body: Record<string, unknown>, actor: RoomActor = ADA) => live.put({ roomId: "r1", doc: DOC, actor, refusal: null }, { sheet: 1, ...body });
  const head = async (): Promise<{ revision: number; sha256: string }> => {
    const read = await room.readHead("r1", ADA, DOC);
    if (!read.ok) throw new Error(read.error.message);
    return read.value.head;
  };
  /** A `merge`, committed to the head by the room: history that live cells does not write. */
  const merge = async (range: string): Promise<void> => {
    const { revision } = await head();
    const edited = await room.edit("r1", LIN, { doc_name: DOC, base_revision: revision, mode: "commit", batch: { ops: [{ op: "merge", target: `sheet:#1/range:${range}` }] } });
    expect(edited.ok).toBe(true);
  };
  const structure = (revision: number) => ({ status: 409, error: { code: "STRUCTURE_CONFLICT", revision } });

  test("structure and then a write of the cell is a structure conflict, not a cell conflict", async () => {
    await merge("J1:K2");
    const live = liveOf((await head()).sha256);
    expect(await put(live, { revision: 1, a1: "E2", expected: null, value: { string: "ada" } })).toEqual({ status: 200, body: { revision: 2 } });
    expect(await put(live, { revision: 0, a1: "E2", expected: null, value: { string: "lin" } }, LIN)).toMatchObject(structure(2));
  });

  test("a write of the cell and then structure is a structure conflict, not a cell conflict", async () => {
    expect(await put(liveOf(gridSha256(BOOK)), { revision: 0, a1: "E2", expected: null, value: { string: "ada" } })).toEqual({ status: 200, body: { revision: 1 } });
    await merge("J1:K2");
    const live = liveOf((await head()).sha256);
    expect(await put(live, { revision: 0, a1: "E2", expected: null, value: { string: "lin" } }, LIN)).toMatchObject(structure(2));
  });

  test("structure is a structure conflict when the cell is what was read, too", async () => {
    const first = liveOf(gridSha256(BOOK));
    expect(await put(first, { revision: 0, a1: "E2", expected: null, value: { number: 5 } })).toEqual({ status: 200, body: { revision: 1 } });
    expect(await put(first, { revision: 1, a1: "E2", expected: { number: 5 }, value: null })).toEqual({ status: 200, body: { revision: 2 } });
    await merge("J1:K2");
    const live = liveOf((await head()).sha256);
    // E2 is blank again, as it was read at revision 0 and at revision 2.
    for (const revision of [0, 2]) {
      expect([revision, await put(live, { revision, a1: "E2", expected: null, value: { string: "lin" } }, LIN)]).toMatchObject([revision, structure(3)]);
    }
  });

  test("a draft written again lands over the writes of its cell that the newer read has seen", async () => {
    expect((await write({ revision: 0, a1: "E2", expected: null, value: { string: "ada" } }, "t-ada")).status).toBe(200);
    const lost = await write({ revision: 0, a1: "E2", expected: null, value: { string: "lin" } }, "t-lin");
    expect([lost.status, lost.body.error.code]).toEqual([409, "CELL_CONFLICT"]);
    const again = await write({ revision: 1, draftRevision: 0, a1: "E2", expected: { string: "ada" }, value: { string: "lin" } }, "t-lin");
    expect([again.status, again.body]).toEqual([200, { revision: 2 }]);
    expect((await read("?range=E2")).body.cells).toEqual([{ a1: "E2", value: { string: "lin" } }]);
  });

  test("a draft written again is still compared with the cell at its read, and still conflicts with a write since it", async () => {
    await write({ revision: 0, a1: "E2", expected: null, value: { string: "ada" } }, "t-ada");
    const stale = await write({ revision: 1, draftRevision: 0, a1: "E2", expected: { string: "other" }, value: { string: "lin" } }, "t-lin");
    expect([stale.status, stale.body.error]).toEqual([409, expect.objectContaining({ code: "CELL_CONFLICT", revision: 1, current: { string: "ada" } })]);
    await write({ revision: 1, a1: "E2", expected: { string: "ada" }, value: { string: "ada2" } }, "t-ada");
    const since = await write({ revision: 1, draftRevision: 0, a1: "E2", expected: { string: "ada" }, value: { string: "lin" } }, "t-lin");
    expect([since.status, since.body.error]).toEqual([409, expect.objectContaining({ code: "CELL_CONFLICT", revision: 2, current: { string: "ada2" } })]);
  });

  test("a draft written again over structure since it was written is a structure conflict, over a read that is the head", async () => {
    expect(await put(liveOf(gridSha256(BOOK)), { revision: 0, a1: "E2", expected: null, value: { string: "ada" } })).toEqual({ status: 200, body: { revision: 1 } });
    await merge("J1:K2");
    const live = liveOf((await head()).sha256);
    const draft = { revision: 2, a1: "E2", expected: { string: "ada" }, value: { string: "lin" } };
    expect(await put(live, { ...draft, draftRevision: 0 }, LIN)).toMatchObject(structure(2));
    // The same write without the revision of the draft is the read at the head it always was.
    expect(await put(live, draft, LIN)).toEqual({ status: 200, body: { revision: 3 } });
  });

  test("a draft written again counts the structure only from the revision it was written at", async () => {
    await merge("J1:K2");
    const live = liveOf((await head()).sha256);
    expect(await put(live, { revision: 1, a1: "E2", expected: null, value: { string: "ada" } })).toEqual({ status: 200, body: { revision: 2 } });
    const again = (draftRevision: number) => put(live, { revision: 2, draftRevision, a1: "E2", expected: { string: "ada" }, value: { string: "lin" } }, LIN);
    expect(await again(0)).toMatchObject(structure(2));
    expect(await again(1)).toEqual({ status: 200, body: { revision: 3 } });
  });

  test("draftRevision is a whole number from 0 up to revision", async () => {
    const bad: [string, unknown][] = [["after the revision", 1], ["negative", -1], ["fractional", 0.5], ["text", "0"], ["null", null]];
    for (const [what, draftRevision] of bad) {
      const refused = await write({ revision: 0, draftRevision, a1: "E2", expected: null, value: { number: 1 } });
      expect([what, refused.status, refused.body.error.code]).toEqual([what, 400, "BAD_REQUEST"]);
    }
    expect((await read()).body.revision).toBe(0);
    expect((await write({ revision: 0, draftRevision: 0, a1: "E2", expected: null, value: { number: 1 } })).body).toEqual({ revision: 1 });
  });

  test("the history is read once, and only for a read behind the head or a draft written again", async () => {
    let reads = 0;
    const counting = new Proxy(room, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (property === "getRoom") reads++;
          return member.apply(target, args);
        };
      },
    });
    const live = new LiveCells(counting, { pool, attested: [gridSha256(BOOK)], now: () => clock });
    const writes: [string, Record<string, unknown>, number][] = [
      ["at the head", { revision: 0, a1: "E2", expected: null, value: { number: 1 } }, 0],
      ["behind the head", { revision: 0, a1: "E3", expected: null, value: { number: 2 } }, 1],
      ["behind the head and written again", { revision: 1, draftRevision: 0, a1: "E4", expected: null, value: { number: 3 } }, 1],
      ["written again at the head", { revision: 3, draftRevision: 2, a1: "E5", expected: null, value: { number: 4 } }, 1],
      ["at the head again", { revision: 4, a1: "E6", expected: null, value: { number: 5 } }, 0],
    ];
    for (const [i, [what, body, fetched]] of writes.entries()) {
      const before = reads;
      expect([what, await put(live, body)]).toEqual([what, { status: 200, body: { revision: i + 1 } }]);
      expect([what, reads - before]).toEqual([what, fetched]);
    }
  });
});

describe("the formulas a write may carry", () => {
  const own = { row: 50, col: 50 };

  test("are numbers, same-sheet A1 references, + - * / ^, unary signs and parentheses", () => {
    const accepted = ["=B3*8192", "=1+2", "=-(A1+2)^2/3", "=$A$1*B2", "=.5*A1", "=((A1))", "=A1^-2", "=+A1", "=10/4-A2*B2+C3", "=XFD1048576*2"];
    for (const formula of accepted) expect([formula, formulaProblem(formula, own)]).toEqual([formula, null]);
  });

  test("are nothing else: no function, range, other sheet, name, text, space, exponent, array, percent or error", () => {
    const refused = [
      "=SUM(A1:A3)", "=A1:B2", "=Sheet2!A1", "='Sheet 2'!A1", "=A1 +1", "=A1+ 1", "=b3*2", "=1e5", "=", "=(", "=1+", "=A1)", "=\"x\"", "=TRUE",
      "=A1&B1", "=Growth", "=A0", "=XFE1", "=A1048577", "=1.", "=SUM(", "=@A1", "={1,2}", "=A1%", "=1,5", "=A1>1", "=#REF!", "=[1]A1", "=A1#",
      "=NOW()", "=A1B1", "=1 2",
    ];
    for (const formula of refused) expect([formula, formulaProblem(formula, own)]).toEqual([formula, expect.stringContaining(FORMULA_CLASS)]);
    expect(formulaProblem("B2*2", own)).toBe("a formula starts with =");
  });

  test("are not circular, and not so long or so deep as to be a problem", () => {
    expect(formulaProblem("=A1+1", { row: 1, col: 1 })).toBe("a formula may not refer to its own cell");
    expect(formulaProblem("=2*$A$1", { row: 1, col: 1 })).toBe("a formula may not refer to its own cell");
    expect(formulaProblem(`=${"(".repeat(100)}1${")".repeat(100)}`, own)).toContain(FORMULA_CLASS);
    expect(formulaProblem(`=${"-".repeat(100)}1`, own)).toContain(FORMULA_CLASS);
    expect(formulaProblem(`=${"1+".repeat(600)}1`, own)).toBe("a formula is at most 1024 characters");
  });
});

describe("who may use it", () => {
  test("members only: no token is 401, an agent and a guest are 403, on all three methods", async () => {
    await server.stop();
    const scopeOf = (actor: RoomActor) => (actor.id === GUEST.id ? { access: "view" as const, docs: [{ room_id: "r1", doc_name: DOC }] } : null);
    await start({ service: scopedService(room, scopeOf), scopeOf });
    const none = await call(PATH);
    expect([none.status, (await none.json()).error.code]).toEqual([401, "UNAUTHORIZED"]);
    for (const token of ["t-robot", "t-guest"]) {
      const results = [
        await read("", token),
        await send("PUT", { revision: 0, sheet: 1, a1: "B4", expected: null, value: { number: 1 } }, token),
        await announce(1, "B4", token),
      ];
      for (const result of results) expect([token, result.status, result.body.error.code]).toEqual([token, 403, "FORBIDDEN"]);
    }
    expect((await read("", "t-lin")).status).toBe(200);
  });

  test("a read-only workspace reads, says so, and refuses a write and a selection before it reads the request", async () => {
    await server.stop();
    await start({ readOnly: MODE });
    const { body } = await read("?range=A1:B2");
    expect(body.editable).toBe(false);
    expect(body.refusal).toEqual({ code: "LICENSE_LIMIT", message: `workspace-read-only: ${MODE.reason} ${MODE.upgrade}` });
    expect(body.cells).toHaveLength(3);
    const put = await send("PUT", "{ not json", "t-ada");
    expect([put.status, put.body.error.code]).toEqual([402, "LICENSE_LIMIT"]);
    const post = await announce(1, "B2");
    expect([post.status, post.body.error.code]).toEqual([402, "LICENSE_LIMIT"]);
  });

  test("answers 405 to other methods, and 501 where the server has no engine for it", async () => {
    const deleted = await call(PATH, { method: "DELETE", headers: auth("t-ada") });
    expect([deleted.status, deleted.headers.get("allow")]).toEqual([405, "GET, PUT, POST"]);
    await server.stop();
    await start({ liveCells: null });
    const { status, body } = await read();
    expect([status, body.error.code]).toEqual([501, "NO_LIVE_CELLS"]);
  });
});

describe("selections", () => {
  test("an announced cell is in the reads of the others that include it, and not in the caller's own", async () => {
    expect((await announce(1, "B2")).status).toBe(204);
    expect((await announce(1, "b3", "t-lin")).status).toBe(204);
    const lin = await read("?sheet=1&range=A1:H5", "t-lin");
    expect(lin.body.peers).toEqual([{ id: "ada", name: "Ada", sheet: 1, a1: "B2" }]);
    const ada = await read("?sheet=1&range=A1:H5", "t-ada");
    expect(ada.body.peers).toEqual([{ id: "lin", name: "Lin", sheet: 1, a1: "B3" }]);
  });

  test("a read has the peers of its sheet and of its window only", async () => {
    await announce(1, "B2");
    expect((await read("?sheet=2&range=A1:H5", "t-lin")).body.peers).toEqual([]);
    expect((await read("?sheet=1&range=D1:H5", "t-lin")).body.peers).toEqual([]);
    expect((await read("?sheet=1&range=B2", "t-lin")).body.peers).toHaveLength(1);
    expect((await announce(2, "A1")).status).toBe(204);
    expect((await read("?sheet=2&range=A1:H5", "t-lin")).body.peers).toEqual([{ id: "ada", name: "Ada", sheet: 2, a1: "A1" }]);
    expect((await read("?sheet=1&range=A1:H5", "t-lin")).body.peers).toEqual([]);
  });

  test("a selection expires, and is kept by announcing it again", async () => {
    await announce(1, "B2");
    clock += PRESENCE_TTL_MS - 1;
    expect((await read("?range=A1:H5", "t-lin")).body.peers).toHaveLength(1);
    clock += 1;
    expect((await read("?range=A1:H5", "t-lin")).body.peers).toEqual([]);
    await announce(1, "B2");
    clock += PRESENCE_TTL_MS - 1;
    expect((await read("?range=A1:H5", "t-lin")).body.peers).toHaveLength(1);
  });

  test("refuses a selection that is not one, and one on a sheet that is not there or not shown", async () => {
    const bad: unknown[] = [
      { sheet: 1 },
      { a1: "B2" },
      { sheet: 0, a1: "B2" },
      { sheet: 1.5, a1: "B2" },
      { sheet: "1", a1: "B2" },
      { sheet: 1, a1: "$B$2" },
      { sheet: 1, a1: "B2:B3" },
      { sheet: 1, a1: "XFE1" },
      { sheet: 3, a1: "B2" },
      { sheet: 1, a1: "B2", who: "lin" },
    ];
    for (const body of bad) {
      const refused = await send("POST", body);
      expect([JSON.stringify(body), refused.status, refused.body.error.code]).toEqual([JSON.stringify(body), 400, "BAD_REQUEST"]);
    }
    const hidden = await send("POST", { sheet: 1, a1: "A1" }, "t-ada", "/api/rooms/r1/docs/hidden.xlsx/live-cells");
    expect(hidden.status).toBe(400);
    expect((await send("POST", { sheet: 2, a1: "A1" }, "t-ada", "/api/rooms/r1/docs/hidden.xlsx/live-cells")).status).toBe(204);
    expect((await read("?range=A1:H5", "t-lin")).body.peers).toEqual([]);
  });

  test("a workbook keeps at most PRESENCE_MAX selections: the one announced longest ago goes first", async () => {
    const live = new LiveCells(room, { pool, attested: [], now: () => clock });
    const member = (i: number): LiveCaller => ({ roomId: "r1", doc: DOC, actor: { kind: "user", id: `u${i}`, name: `User ${i}` }, refusal: null });
    const peerIds = async (): Promise<string[]> => {
      const reply = await live.get({ roomId: "r1", doc: DOC, actor: LIN, refusal: null }, new URLSearchParams("range=A1:H5"));
      return peerIdsOf(reply);
    };
    const total = PRESENCE_MAX + 6;
    for (let i = 0; i < total; i++) expect(await live.post(member(i), { sheet: 1, a1: "B2" })).toEqual({ status: 204 });
    const ids = await peerIds();
    expect(ids).toHaveLength(PRESENCE_MAX);
    expect(ids[0]).toBe("u6");
    expect(ids.at(-1)).toBe(`u${total - 1}`);
    // A member who announces again moves to the end instead of taking a second place.
    await live.post(member(6), { sheet: 1, a1: "B2" });
    const again = await peerIds();
    expect(again).toHaveLength(PRESENCE_MAX);
    expect(again[0]).toBe("u7");
    expect(again.at(-1)).toBe("u6");
  });
});
