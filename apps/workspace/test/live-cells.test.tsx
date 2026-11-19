/** @jsxImportSource preact */
// Live cells of an XLSX head, against a fake server that keeps the two sheets of model.xlsx: what an entry puts in a
// cell, the requests the client makes, a draft sent with Enter, conflicts the server finds and conflicts a later read
// finds, the server not answering, a workbook or a cell that may only be read, sheets that move, the other members,
// and the grid each state draws. Handlers are reached through the vnodes of the render, as a key or a click would
// reach them. No engine: no `<wolf-review>`, and no request but the live cells route.
import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { ApiError, type CellValue, type LiveCellWrite, type LivePeer, type LiveRefusal, WorkspaceApi } from "../src/lib/api.ts";
import {
  a1Of,
  columnName,
  draftKey,
  editRefusal,
  entryOf,
  LiveCellsModel,
  parseA1,
  rangeOf,
  sameValue,
  shownOf,
  valueOfEntry,
} from "../src/lib/live-cells.ts";
import { documentSummaries } from "../src/lib/room-state.ts";
import { LiveCellsView } from "../src/ui/live-cells.tsx";
import { Stage, type StageProps } from "../src/ui/stage.tsx";
import { ALICE, head, jsonResponse, proposal, room, SCOUT } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const ROUTE = `${ORIGIN}/api/rooms/q3-close/docs/model.xlsx/live-cells`;
const FORMULA = "=Assumptions!B2*(1+Assumptions!B3)";
const UNATTESTED: LiveRefusal = { code: "LIVE_CELLS_UNATTESTED", message: "model.xlsx has no attestation that its cells may be written one by one." };
const B2 = draftKey("Assumptions", "B2");

type Seen = { method: string; url: string; body: unknown; cache: RequestCache | undefined };
type Sheet = { name: string; cells: Record<string, CellValue> };
type Refusal = { status: number; code: string; message: string };

const num = (value: CellValue | undefined): number => (value && "number" in value ? value.number : 0);

/** A server keeping model.xlsx at revision 4: Assumptions (A1 a label, B2 1000, B3 0.08) and Model (B2 a formula over
 * both, which it calculates; `displays` holds what it calculates for other formulas). It refuses a write over a value
 * that changed (`CELL_CONFLICT`) or over sheets that changed (`STRUCTURE_CONFLICT`), and every write of a workbook it
 * reads only. `down` is a server that does not answer; `failReads` is how many reads next it does not answer; `refuse`
 * refuses the next write. */
function server() {
  const book = {
    revision: 4,
    /** The revision of the last change to the sheets themselves. */
    structure: 0,
    sheets: [
      { name: "Assumptions", cells: { A1: { string: "Revenue" }, B2: { number: 1000 }, B3: { number: 0.08 } } },
      { name: "Model", cells: { B2: { formula: FORMULA } } },
    ] as Sheet[],
    editable: true,
    refusal: null as LiveRefusal | null,
    merged: [] as string[],
    locked: [] as string[],
    peers: [] as LivePeer[],
    down: false,
    refuse: null as Refusal | null,
    displays: {} as Record<string, string>,
    failReads: 0,
  };
  const seen: Seen[] = [];
  const display = (value: CellValue): string | undefined => {
    if (value === null || !("formula" in value)) return undefined;
    if (value.formula !== FORMULA) return book.displays[value.formula];
    const inputs = book.sheets.find((s) => s.name === "Assumptions")!.cells;
    return String(Math.round(num(inputs.B2) * (1 + num(inputs.B3)) * 100) / 100);
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url: input, body, cache: init?.cache });
    if (book.down) throw new TypeError("Failed to fetch");
    if (method === "GET" && book.failReads > 0) {
      book.failReads--;
      throw new TypeError("Failed to fetch");
    }
    const url = new URL(input);
    if (`${url.origin}${url.pathname}` !== ROUTE) return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such path" } });
    if (method === "POST") return new Response(null, { status: 204 });
    if (method === "PUT") {
      const write = body as LiveCellWrite;
      const refused: Refusal | null = book.refuse ?? (book.editable ? null : { status: 403, ...book.refusal! });
      book.refuse = null;
      if (refused !== null) return jsonResponse(refused.status, { error: { code: refused.code, message: refused.message } });
      if (write.revision < book.structure) {
        return jsonResponse(409, { error: { code: "STRUCTURE_CONFLICT", message: `The sheets changed after revision ${write.revision}.` } });
      }
      const cells = book.sheets[write.sheet - 1]!.cells;
      if (!sameValue(cells[write.a1] ?? null, write.expected)) {
        return jsonResponse(409, { error: { code: "CELL_CONFLICT", message: `${write.a1} changed after revision ${write.revision}.` } });
      }
      if (write.value === null) delete cells[write.a1];
      else cells[write.a1] = write.value;
      book.revision++;
      return jsonResponse(200, { revision: book.revision });
    }
    const id = Number(url.searchParams.get("sheet") ?? "1");
    const sheet = book.sheets[id - 1];
    if (sheet === undefined) return jsonResponse(404, { error: { code: "SHEET_NOT_FOUND", message: `There is no sheet ${id}.` } });
    const [from, to] = url.searchParams.get("range")!.split(":").map((a1) => parseA1(a1)!);
    const inside = (a1: string): boolean => {
      const ref = parseA1(a1)!;
      return ref.col >= from!.col && ref.col <= to!.col && ref.row >= from!.row && ref.row <= to!.row;
    };
    const cells = Object.entries(sheet.cells)
      .filter(([a1]) => inside(a1))
      .map(([a1, value]) => {
        const shown = display(value);
        return { a1, value, ...(shown === undefined ? {} : { display: shown }), ...(book.locked.includes(a1) ? { editable: false } : {}) };
      });
    return jsonResponse(200, {
      revision: book.revision,
      sheet: id,
      sheets: book.sheets.map((s, i) => ({ id: i + 1, name: s.name })),
      cells,
      peers: book.peers,
      editable: book.editable,
      refusal: book.refusal,
      merged: book.merged,
    });
  };
  return {
    book,
    seen,
    api: new WorkspaceApi(ORIGIN, null, fetch),
    writes: (): LiveCellWrite[] => seen.filter((s) => s.method === "PUT").map((s) => s.body as LiveCellWrite),
    announced: (): unknown[] => seen.filter((s) => s.method === "POST").map((s) => s.body),
  };
}

type Server = ReturnType<typeof server>;

/** Another member writes a cell of Assumptions. */
function writtenElsewhere(fake: Server, a1: string, value: CellValue): void {
  fake.book.sheets[0]!.cells[a1] = value;
  fake.book.revision++;
}

async function opened(fake: Server = server()): Promise<{ fake: Server; model: LiveCellsModel }> {
  const model = new LiveCellsModel(fake.api, "q3-close", "model.xlsx", ALICE);
  await model.refresh();
  return { fake, model };
}

/** Let what a handler started run to its end: the fake server answers at once, so a few turns of the loop do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
}

type Handler = (event?: unknown) => unknown;
const keyDown = (key: string) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined });

const DOC = documentSummaries(room({ documents: [{ head: head("model.xlsx", 4) }] }))[0]!;

/** Render `node`, keeping every vnode created on the way so a test can reach a handler as a key or a click would. */
function rendered(node: VNode): { html: string; vnodes: VNode[] } {
  const vnodes: VNode[] = [];
  const previous = options.vnode;
  options.vnode = (vnode) => {
    vnodes.push(vnode);
    previous?.(vnode);
  };
  try {
    return { html: render(node), vnodes };
  } finally {
    options.vnode = previous;
  }
}

/** The text of rendered HTML a reader sees: no tags, so no attributes. */
const visible = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** The grid of `model` as it renders now: its text, its controls by test id, and its cells and peers by address. */
function view(model: LiveCellsModel) {
  const { html, vnodes } = rendered(<LiveCellsView model={model} state={model.state} doc={DOC} onClose={() => undefined} />);
  const props = vnodes.map((v) => v.props as Record<string, unknown>);
  return {
    html,
    text: visible(html),
    has: (testid: string): boolean => html.includes(`data-testid="${testid}"`),
    get: (testid: string): Record<string, unknown> => {
      const found = props.find((p) => p["data-testid"] === testid);
      expect(found).toBeDefined();
      return found!;
    },
    cell: (a1: string): Record<string, unknown> => props.find((p) => p["data-live-cell"] === a1)!,
    peer: (a1: string): Record<string, unknown> | undefined => props.find((p) => p["data-peer-cell"] === a1),
  };
}

describe("addresses and entries", () => {
  test("an address reads as its cell, with case and $ markers ignored, up to XFD1048576", () => {
    expect(parseA1("$b$2")).toEqual({ col: 1, row: 1 });
    expect(parseA1("XFD1048576")).toEqual({ col: 16_383, row: 1_048_575 });
    expect(parseA1("XFE1")).toBeNull();
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("Model!B2")).toBeNull();
    expect([0, 25, 26, 701, 16_383].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "XFD"]);
    expect(a1Of({ col: 27, row: 9 })).toBe("AB10");
    expect(rangeOf({ col: 0, row: 0 })).toBe("A1:H15");
  });

  test("an entry puts a number, a boolean, a formula, text or nothing in the cell", () => {
    expect(valueOfEntry("1000")).toEqual({ number: 1000 });
    expect(valueOfEntry(".08")).toEqual({ number: 0.08 });
    expect(valueOfEntry("1,000.5")).toEqual({ number: 1000.5 });
    expect(valueOfEntry("8%")).toEqual({ number: 0.08 });
    expect(valueOfEntry("true")).toEqual({ boolean: true });
    expect(valueOfEntry("=B2*2")).toEqual({ formula: "=B2*2" });
    expect(valueOfEntry("'0123")).toEqual({ string: "0123" });
    expect(valueOfEntry("Revenue")).toEqual({ string: "Revenue" });
    expect(valueOfEntry("=")).toEqual({ string: "=" });
    expect(valueOfEntry("")).toBeNull();
  });

  test("the entry of a value puts it back as it was, and a cell shows the server's text before what it holds", () => {
    for (const value of [{ number: 0.08 }, { boolean: false }, { formula: "=B2*2" }, { string: "0123" }, { string: "TRUE" }, { string: "Revenue" }, null]) {
      expect(valueOfEntry(entryOf(value))).toEqual(value);
    }
    expect(entryOf({ formula: "B2*2" })).toBe("=B2*2");
    expect(shownOf({ value: { formula: FORMULA }, display: "1080" })).toBe("1080");
    expect(shownOf({ value: { string: "0123" } })).toBe("0123");
    expect(shownOf(undefined)).toBe("");
  });
});

describe("the live cells route", () => {
  test("reads a window never from the cache, writes a cell over what a read found, and announces a cell", async () => {
    const fake = server();
    await fake.api.liveCells("q3-close", "model.xlsx", null, "A1:H15");
    await fake.api.liveCells("q3-close", "model.xlsx", 2, "B2:B2");
    const write: LiveCellWrite = { revision: 4, sheet: 1, a1: "B2", expected: { number: 1000 }, value: { number: 1200 } };
    expect(await fake.api.writeLiveCell("q3-close", "model.xlsx", write)).toBe(5);
    await fake.api.announceLiveCell("q3-close", "model.xlsx", { sheet: 1, a1: "B2" });
    expect(fake.seen.map((s) => [s.method, s.url, s.cache])).toEqual([
      ["GET", `${ROUTE}?range=A1%3AH15`, "no-store"],
      ["GET", `${ROUTE}?sheet=2&range=B2%3AB2`, "no-store"],
      ["PUT", ROUTE, undefined],
      ["POST", ROUTE, undefined],
    ]);
    expect(fake.seen[2]!.body).toEqual(write);
    expect(fake.seen[3]!.body).toEqual({ sheet: 1, a1: "B2" });
  });

  test("a refused write throws the code and status of the server's envelope", async () => {
    const fake = server();
    fake.book.refuse = { status: 409, code: "STRUCTURE_CONFLICT", message: "The sheets changed." };
    const write: LiveCellWrite = { revision: 4, sheet: 1, a1: "B2", expected: { number: 1000 }, value: null };
    const refused = await fake.api.writeLiveCell("q3-close", "model.xlsx", write).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, code: "STRUCTURE_CONFLICT", message: "The sheets changed." });
  });
});

describe("live cells", () => {
  test("the first read shows the first sheet with no engine and no other request, and announces where the person is", async () => {
    const { fake, model } = await opened();
    expect(model.state).toMatchObject({ phase: "ready", sheet: 1, revision: 4, editable: true, refusal: null });
    expect(model.state.sheets.map((s) => s.name)).toEqual(["Assumptions", "Model"]);
    expect(fake.seen[0]!.url).toBe(`${ROUTE}?range=A1%3AH15`);
    await settle();
    expect(fake.announced()).toEqual([{ sheet: 1, a1: "A1" }]);
    const v = view(model);
    expect(v.html).not.toContain("wolf-review");
    expect(v.get("live-cells-status").children).toBe("Live");
    expect(v.text).toContain("No unsaved cells");
    expect(v.cell("A1").children).toBe("Revenue");
    expect(v.cell("B2").children).toBe("1000");
    expect(v.cell("B3")["data-value"]).toBe("0.08");
    expect(v.cell("C9")["data-value"]).toBe("");
    expect(fake.seen.every((s) => s.url.startsWith(ROUTE))).toBe(true);
  });

  test("Enter in the formula bar writes the cell over what the read found, stays on it, and shows what the server calculated", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    let v = view(model);
    expect(v.get("live-cells-input").value).toBe("1000");
    expect(v.get("live-cells-input").readOnly).toBe(false);
    (v.get("live-cells-input").onInput as Handler)({ currentTarget: { value: "1200" } });
    v = view(model);
    expect(v.cell("B2").children).toBe("1200");
    expect(v.cell("B2")["data-dirty"]).toBe("true");
    expect(v.cell("B2")["data-value"]).toBe("1000");
    expect(v.get("live-cells-draft-count").children).toBe("1 unsaved cell");

    (v.get("live-cells-input").onKeyDown as Handler)(keyDown("Enter"));
    await settle();
    expect(fake.writes()).toEqual([{ revision: 4, sheet: 1, a1: "B2", expected: { number: 1000 }, value: { number: 1200 } }]);
    expect(model.state.drafts).toEqual({});
    expect(model.state.selected).toBe("B2");
    expect(model.state.revision).toBe(5);
    v = view(model);
    expect(v.cell("B2").children).toBe("1200");
    expect(v.cell("B2")["data-dirty"]).toBeUndefined();

    model.setSheet(2);
    await settle();
    v = view(model);
    expect(v.cell("B2").children).toBe("1296");
    expect(v.cell("B2")["data-value"]).toBe(FORMULA);
  });

  test("Escape drops a draft that was not sent", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("5");
    const v = view(model);
    (v.get("live-cells-input").onKeyDown as Handler)(keyDown("Escape"));
    expect(model.state.drafts).toEqual({});
    expect(fake.writes()).toEqual([]);
  });

  test("a write the server finds in conflict keeps the draft and what the cell holds now, until the person reapplies theirs", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    writtenElsewhere(fake, "B2", { number: 1500 });
    await model.submit(B2);
    expect(model.state.drafts[B2]).toMatchObject({
      status: "conflict",
      text: "1200",
      conflict: { code: "CELL_CONFLICT", local: false, current: { value: { number: 1500 } } },
    });
    let v = view(model);
    expect(v.get("live-cells-conflict")["data-cell"]).toBe("B2");
    expect(v.text).toContain("You entered 1200 ; it holds 1500 now.");
    expect(v.cell("B2").children).toBe("1200");
    expect(v.cell("B2")["data-value"]).toBe("1500");
    expect(v.get("live-cells-reapply").disabled).toBe(false);

    (v.get("live-cells-reapply").onClick as Handler)();
    await settle();
    expect(fake.writes().at(-1)).toEqual({ revision: 5, draftRevision: 4, sheet: 1, a1: "B2", expected: { number: 1500 }, value: { number: 1200 } });
    expect(fake.book.sheets[0]!.cells.B2).toEqual({ number: 1200 });
    expect(model.state.drafts).toEqual({});
    v = view(model);
    expect(v.has("live-cells-conflict")).toBe(false);
  });

  test("Keep current drops the draft in conflict and writes nothing", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    writtenElsewhere(fake, "B2", { number: 1500 });
    await model.submit(B2);
    (view(model).get("live-cells-use-current").onClick as Handler)();
    await settle();
    expect(model.state.drafts).toEqual({});
    expect(model.state.cells.B2?.value).toEqual({ number: 1500 });
    expect(fake.writes()).toHaveLength(1);
  });

  test("Reapply writes over only what the notice shows: a cell written again since stays in conflict, showing the latest", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    writtenElsewhere(fake, "B2", { number: 1500 });
    await model.submit(B2);
    expect(model.state.drafts[B2]?.conflict).toMatchObject({ current: { value: { number: 1500 } }, at: { revision: 5, sheet: 1 } });
    writtenElsewhere(fake, "B2", { number: 1700 });

    (view(model).get("live-cells-reapply").onClick as Handler)();
    await settle();
    expect(fake.writes().at(-1)).toEqual({ revision: 5, draftRevision: 4, sheet: 1, a1: "B2", expected: { number: 1500 }, value: { number: 1200 } });
    expect(fake.book.sheets[0]!.cells.B2).toEqual({ number: 1700 });
    expect(model.state.drafts[B2]).toMatchObject({
      status: "conflict",
      text: "1200",
      conflict: { code: "CELL_CONFLICT", current: { value: { number: 1700 } }, at: { revision: 6, sheet: 1 } },
    });
    const v = view(model);
    expect(v.text).toContain("You entered 1200 ; it holds 1700 now.");
    expect(v.get("live-cells-reapply").disabled).toBe(false);

    (v.get("live-cells-reapply").onClick as Handler)();
    await settle();
    expect(fake.writes().at(-1)).toEqual({ revision: 6, draftRevision: 4, sheet: 1, a1: "B2", expected: { number: 1700 }, value: { number: 1200 } });
    expect(fake.book.sheets[0]!.cells.B2).toEqual({ number: 1200 });
    expect(model.state.drafts).toEqual({});
  });

  test("Reapply over a cell no read has answered for reads it and writes nothing; over a blank cell it expects blank", async () => {
    const { fake, model } = await opened();
    const key = draftKey("Assumptions", "C2");
    model.select("C2");
    model.edit("Margin");
    fake.book.refuse = { status: 409, code: "CELL_CONFLICT", message: "C2 was written since your read." };
    fake.book.failReads = 2;
    await model.submit(key);
    expect(model.state.drafts[key]).toMatchObject({ status: "conflict", conflict: { code: "CELL_CONFLICT" } });
    expect(model.state.drafts[key]?.conflict?.current).toBeUndefined();
    expect(view(model).text).toContain("You entered Margin ; reading what it holds now.");

    await model.reapply(key);
    expect(fake.writes()).toHaveLength(1);
    expect(model.state.drafts[key]).toMatchObject({ status: "conflict", conflict: { current: null, at: { revision: 4, sheet: 1 } } });
    expect(view(model).text).toContain("You entered Margin ; it holds blank now.");

    await model.reapply(key);
    expect(fake.writes().at(-1)).toEqual({ revision: 4, sheet: 1, a1: "C2", expected: null, value: { string: "Margin" } });
    expect(fake.book.sheets[0]!.cells.C2).toEqual({ string: "Margin" });
    expect(model.state.drafts).toEqual({});
  });

  test("a conflict over a formula quotes the formula that won with what it calculates, not only the calculated text", async () => {
    const { fake, model } = await opened();
    fake.book.displays["=B3*8192"] = "655.36";
    model.select("C3");
    model.edit("=B3*2");
    writtenElsewhere(fake, "C3", { formula: "=B3*8192" });
    const key = draftKey("Assumptions", "C3");
    await model.submit(key);
    expect(model.state.drafts[key]?.conflict?.current).toEqual({ value: { formula: "=B3*8192" }, display: "655.36" });
    let v = view(model);
    expect(v.text).toContain("You entered =B3*2 ; it holds =B3*8192 (655.36) now.");
    expect(v.cell("C3")["data-value"]).toBe("=B3*8192");

    // A later read finds the same before anything is sent.
    await model.useCurrent(key);
    model.edit("=B3*2");
    fake.book.displays["=B3*4096"] = "327.68";
    writtenElsewhere(fake, "C3", { formula: "=B3*4096" });
    await model.refresh();
    expect(model.state.drafts[key]?.conflict).toMatchObject({ local: true, current: { value: { formula: "=B3*4096" }, display: "327.68" } });
    v = view(model);
    expect(v.text).toContain("You entered =B3*2 ; it holds =B3*4096 (327.68) now.");
  });

  test("a read that finds the cell changed under a draft holds the draft back before anything is sent", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    writtenElsewhere(fake, "B2", { number: 1500 });
    await model.refresh();
    expect(model.state.drafts[B2]).toMatchObject({ status: "conflict", text: "1200", conflict: { local: true, current: { value: { number: 1500 } } } });
    await model.submit(B2);
    expect(fake.writes()).toEqual([]);
    expect(view(model).cell("B2").children).toBe("1200");
  });

  test("a draft the server did not answer stays, and goes when the person sends it again", async () => {
    const { fake, model } = await opened();
    model.select("B3");
    model.edit("9%");
    fake.book.down = true;
    const key = draftKey("Assumptions", "B3");
    await model.submit(key);
    expect(model.state.offline).toBe(true);
    expect(model.state.drafts[key]).toMatchObject({ status: "unsent", text: "9%" });
    const v = view(model);
    expect(v.has("live-cells-offline")).toBe(true);
    expect(v.text).toContain("1 cell waits to be sent");
    expect(v.get("live-cells-resend").children).toBe("Send again");
    expect(v.get("live-cells-status").children).toBe("Offline");
    expect(v.cell("B3").children).toBe("9%");

    fake.book.down = false;
    (v.get("live-cells-resend").onClick as Handler)();
    await settle();
    expect(fake.book.sheets[0]!.cells.B3).toEqual({ number: 0.09 });
    expect(model.state.offline).toBe(false);
    expect(model.state.drafts).toEqual({});
  });

  test("a workbook the server reads only shows its refusal, reads and selects, and takes no entry", async () => {
    const fake = server();
    fake.book.editable = false;
    fake.book.refusal = UNATTESTED;
    const { model } = await opened(fake);
    model.select("B2");
    await settle();
    expect(model.state).toMatchObject({ editable: false, refusal: UNATTESTED });
    expect(editRefusal(model.state)).toEqual({ kind: "workbook", message: UNATTESTED.message });
    model.edit("1200");
    expect(model.state.drafts).toEqual({});
    expect(fake.announced()).toContainEqual({ sheet: 1, a1: "B2" });
    const v = view(model);
    expect(v.get("live-cells-refusal")["data-code"]).toBe("LIVE_CELLS_UNATTESTED");
    expect(v.text).toContain(UNATTESTED.message);
    expect(v.get("live-cells-status").children).toBe("Read-only");
    expect(v.get("live-cells-input")).toMatchObject({ readOnly: true, value: "1000" });
    expect(v.cell("B2").children).toBe("1000");
    expect(fake.writes()).toEqual([]);
  });

  test("drafts typed before the workbook turned read-only stay on show and are neither sent nor reapplied", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    fake.book.editable = false;
    fake.book.refusal = UNATTESTED;
    await model.refresh();
    await model.submit(B2);
    expect(model.state.drafts[B2]).toMatchObject({ status: "editing", text: "1200" });
    let v = view(model);
    expect(v.cell("B2").children).toBe("1200");
    expect(v.cell("B2")["data-dirty"]).toBe("true");
    expect(v.text).toContain("Your 1 unsaved cell stays on this page.");
    expect(v.get("live-cells-input").readOnly).toBe(true);

    writtenElsewhere(fake, "B2", { number: 1500 });
    await model.refresh();
    expect(model.state.drafts[B2]?.status).toBe("conflict");
    v = view(model);
    expect(v.get("live-cells-reapply").disabled).toBe(true);
    expect(v.get("live-cells-use-current").disabled).toBe(false);
    await model.reapply(B2);
    expect(fake.writes()).toEqual([]);
  });

  test("a write the server refuses for the whole workbook turns the grid read-only and keeps the draft", async () => {
    const { fake, model } = await opened();
    model.select("B2");
    model.edit("1200");
    fake.book.refuse = { status: 403, ...UNATTESTED };
    await model.submit(B2);
    expect(model.state).toMatchObject({ editable: false, refusal: UNATTESTED });
    expect(model.state.drafts[B2]).toMatchObject({ status: "editing", text: "1200", error: null });
    expect(view(model).has("live-cells-refusal")).toBe(true);
  });

  test("an entry the server refuses stays as typed, with the refusal beside it", async () => {
    const { fake, model } = await opened();
    const refusal = "The engine does not take =SUM( as a formula.";
    fake.book.refuse = { status: 422, code: "CELL_UNSUPPORTED", message: refusal };
    model.select("C2");
    model.edit("=SUM(");
    const key = draftKey("Assumptions", "C2");
    await model.submit(key);
    expect(model.state.drafts[key]).toMatchObject({ status: "editing", text: "=SUM(", error: refusal });
    expect(model.state.editable).toBe(true);
    const v = view(model);
    expect(v.has("live-cells-error")).toBe(true);
    expect(v.text).toContain(refusal);
    expect(v.cell("C2").children).toBe("=SUM(");
  });

  test("a merged cell other than its first, and a cell the server marks, may be read but not written", async () => {
    const fake = server();
    fake.book.merged = ["D1:F1"];
    fake.book.locked = ["B3"];
    const { model } = await opened(fake);
    model.select("E1");
    expect(editRefusal(model.state)).toEqual({ kind: "cell", message: "E1 is part of the merged cells D1:F1: its value is in D1." });
    model.edit("x");
    expect(model.state.drafts).toEqual({});
    const v = view(model);
    expect(v.has("live-cells-locked")).toBe(true);
    expect(v.get("live-cells-input").readOnly).toBe(true);
    model.select("B3");
    expect(editRefusal(model.state)?.kind).toBe("cell");
    model.select("D1");
    expect(editRefusal(model.state)).toBeNull();
  });

  test("no cell takes an entry before the window on show has been read", async () => {
    const fake = server();
    const model = new LiveCellsModel(fake.api, "q3-close", "model.xlsx", ALICE);
    expect(editRefusal(model.state)?.kind).toBe("loading");
    await model.refresh();
    model.page(0, 1);
    expect(model.state.selected).toBe("A16");
    expect(editRefusal(model.state)?.kind).toBe("loading");
    model.edit("x");
    expect(model.state.drafts).toEqual({});
    await settle();
    expect(editRefusal(model.state)).toBeNull();
    expect(fake.seen.some((s) => s.url === `${ROUTE}?sheet=1&range=A16%3AH30`)).toBe(true);
  });

  test("a sheet added before the one on show moves its id: the grid and its drafts follow the sheet by name, and a draft over the changed sheets is typed again, not reapplied", async () => {
    const { fake, model } = await opened();
    model.setSheet(2);
    await settle();
    model.select("C3");
    model.edit("Check");
    fake.book.sheets.unshift({ name: "Cover", cells: {} });
    fake.book.revision++;
    fake.book.structure = fake.book.revision;
    await model.refresh();
    expect(model.state.sheet).toBe(3);
    expect(model.state.cells.B2?.value).toEqual({ formula: FORMULA });
    const key = draftKey("Model", "C3");
    expect(Object.keys(model.state.drafts)).toEqual([key]);
    expect(view(model).cell("C3").children).toBe("Check");

    await model.submit(key);
    expect(model.state.drafts[key]).toMatchObject({ status: "conflict", conflict: { code: "STRUCTURE_CONFLICT", current: null } });
    let v = view(model);
    expect(v.text).toContain("Your entry cannot be reapplied over sheets that changed: keep the current cell, then type it again.");
    expect(v.get("live-cells-reapply").disabled).toBe(true);
    await model.reapply(key);
    expect(fake.writes()).toHaveLength(1);
    expect(model.state.drafts[key]?.status).toBe("conflict");

    (v.get("live-cells-use-current").onClick as Handler)();
    await settle();
    expect(model.state.drafts).toEqual({});
    model.select("C3");
    model.edit("Check");
    await model.submit(key);
    expect(fake.writes().at(-1)).toEqual({ revision: 5, sheet: 3, a1: "C3", expected: null, value: { string: "Check" } });
    expect(fake.book.sheets[2]!.cells.C3).toEqual({ string: "Check" });
    expect(fake.book.sheets[1]!.cells.C3).toBeUndefined();
    expect(model.state.drafts).toEqual({});
    v = view(model);
    expect(v.has("live-cells-conflict")).toBe(false);
  });

  test("a read that finds a draft's cell changed on a sheet whose name moved holds it as a change of the sheets", async () => {
    const { fake, model } = await opened();
    model.setSheet(2);
    await settle();
    model.select("C3");
    model.edit("Check");
    const key = draftKey("Model", "C3");
    fake.book.sheets.unshift({ name: "Cover", cells: {} });
    fake.book.sheets[2]!.cells.C3 = { string: "Done" };
    fake.book.revision++;
    fake.book.structure = fake.book.revision;
    await model.refresh();
    expect(model.state.drafts[key]).toMatchObject({ status: "conflict", conflict: { code: "STRUCTURE_CONFLICT", local: true, current: { value: { string: "Done" } } } });
    expect(view(model).get("live-cells-reapply").disabled).toBe(true);
    await model.reapply(key);
    expect(fake.writes()).toEqual([]);
  });

  test("the other members on the sheet show on their cells, and the person is not among them", async () => {
    const fake = server();
    fake.book.peers = [
      { id: "bob", name: "Bob Diaz", sheet: 1, a1: "B3" },
      { id: "alice", name: "Alice Chen", sheet: 1, a1: "A1" },
      { id: "cy", name: "Cy Park", sheet: 2, a1: "B2" },
    ];
    const { model } = await opened(fake);
    expect(model.state.peers).toEqual([{ id: "bob", name: "Bob Diaz", sheet: 1, a1: "B3" }]);
    const v = view(model);
    expect(v.text).toContain("Bob Diaz on B3");
    expect(v.peer("B3")).toBeDefined();
    expect(v.html).toMatch(/data-peer-cell="B3"[^>]*>\s*<span class="live-peer-name">Bob Diaz<\/span>/);
    expect(v.peer("A1")).toBeUndefined();
    expect(v.cell("B3").children).toBe("0.08");
  });
});

describe("the stage", () => {
  const noop = (): void => undefined;
  const memo = documentSummaries(room({ documents: [{ head: head("memo.docx", 3) }] }))[0]!;

  function stageProps(over: Partial<StageProps> = {}): StageProps {
    return {
      api: server().api,
      client: null,
      roomId: "q3-close",
      actor: ALICE,
      doc: DOC,
      proposal: null,
      proposalIds: [],
      activity: [],
      engine: null,
      theme: "light",
      deciding: false,
      subscribe: () => noop,
      onSelection: noop,
      onDirty: noop,
      onExitReview: noop,
      onDecide: noop,
      onDownloadPreview: noop,
      notify: noop,
      ...over,
    };
  }

  const offersLiveCells = (over: Partial<StageProps> = {}): boolean => render(<Stage {...stageProps(over)} />).includes('data-testid="live-cells-open"');

  test("offers live cells on the head of an XLSX document to a user who is a member, and to no one else", () => {
    expect(offersLiveCells()).toBe(true);
    expect(offersLiveCells({ guest: true })).toBe(false);
    expect(offersLiveCells({ actor: SCOUT })).toBe(false);
    expect(offersLiveCells({ doc: memo })).toBe(false);
    expect(offersLiveCells({ proposal: proposal("p-1", "model.xlsx") })).toBe(false);
  });
});
