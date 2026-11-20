/** @jsxImportSource preact */
// Live slide text of a PPTX head, against a fake server that keeps deck.pptx as the mixed-format deck has it: one
// slide, a title box of two runs (North, bold; South, italic) and a body box of two paragraphs. The requests the client
// makes, a run sent with Enter or Save, two members writing two runs of one shape from the same read, the same run
// written twice (back to the same text too), conflicts a later read finds, runs and shapes that move, the server not
// answering, a deck that may only be read, and the fields each state draws. Handlers are reached through the vnodes of
// the render, as a key or a click would reach them. No engine: no `<wolf-review>`, and no request but the live slide
// text route.
import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { ApiError, type LiveRefusal, type LiveSlideRunWrite, WorkspaceApi } from "../src/lib/api.ts";
import { draftKey, editRefusal, LiveSlideTextModel } from "../src/lib/live-slide-text.ts";
import { documentSummaries } from "../src/lib/room-state.ts";
import { LiveSlideTextView } from "../src/ui/live-slide-text.tsx";
import { Stage, type StageProps } from "../src/ui/stage.tsx";
import { ALICE, head, jsonResponse, proposal, room, SCOUT } from "./fixtures.ts";

const ORIGIN = "https://acme.cloud.example.com";
const ROUTE = `${ORIGIN}/api/rooms/q3-close/docs/deck.pptx/live-slide-text`;
const TITLE = "slide:#256/shape:#2";
const BODY = "slide:#256/shape:#3";
const NORTH = `${TITLE}/para:@1/run:@1`;
const SOUTH = `${TITLE}/para:@1/run:@2`;
const FAST = `${BODY}/para:@1/run:@1`;
const K_NORTH = draftKey(TITLE, NORTH);
const K_SOUTH = draftKey(TITLE, SOUTH);
const UNATTESTED: LiveRefusal = { code: "LIVE_SLIDE_TEXT_UNATTESTED", message: "deck.pptx has no attestation that its text may be written run by run." };

type Seen = { method: string; url: string; body: unknown; cache: RequestCache | undefined };
type Run = { id: string; text: string };
type Shape = { id: string; label: string; runs: Run[]; structure: number };
type Refusal = { status: number; code: string; message: string };
type Deck = {
  revision: number;
  shapes: Shape[];
  /** The revision each run was last written at. */
  written: Record<string, number>;
  editable: boolean;
  refusal: LiveRefusal | null;
  /** Refuses the next write. */
  refuse: Refusal | null;
};

/** deck.pptx at revision 4, as the mixed-format fixture has it. */
function mixedDeck(): Deck {
  return {
    revision: 4,
    shapes: [
      { id: TITLE, label: "Slide 1: TextBox 1", runs: [{ id: NORTH, text: "North" }, { id: SOUTH, text: "South" }], structure: 0 },
      { id: BODY, label: "Slide 1: TextBox 2", runs: [{ id: FAST, text: "Fast PPTX" }, { id: `${BODY}/para:@2/run:@1`, text: "Lossless first" }], structure: 0 },
    ],
    written: {},
    editable: true,
    refusal: null,
    refuse: null,
  };
}

/** A server keeping the decks of `q3-close` by name (deck.pptx at first). It refuses a write over a run written since
 * the read it names, even back to the text that read found (`RUN_CONFLICT`), over runs of a shape that changed since
 * (`STRUCTURE_CONFLICT`), and every write of a deck it reads only. `net.down` is a server that does not answer. */
function server() {
  const decks: Record<string, Deck> = { "deck.pptx": mixedDeck() };
  const net = { down: false };
  const seen: Seen[] = [];
  const holds: { reach: () => void; gate: Promise<void> }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url: input, body, cache: init?.cache });
    if (net.down) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    const match = /^\/api\/rooms\/q3-close\/docs\/([^/]+)\/live-slide-text$/.exec(url.pathname);
    const deck = match === null ? undefined : decks[decodeURIComponent(match[1]!)];
    if (url.origin !== ORIGIN || deck === undefined) return jsonResponse(404, { error: { code: "NOT_FOUND", message: "no such path" } });
    if (method === "PUT") {
      const write = body as LiveSlideRunWrite;
      const refused: Refusal | null = deck.refuse ?? (deck.editable ? null : { status: 403, ...deck.refusal! });
      deck.refuse = null;
      if (refused !== null) return jsonResponse(refused.status, { error: { code: refused.code, message: refused.message } });
      const shape = deck.shapes.find((s) => s.runs.some((r) => r.id === write.target));
      if (shape === undefined || write.revision < shape.structure) {
        return jsonResponse(409, { error: { code: "STRUCTURE_CONFLICT", message: `The runs of the shape changed after revision ${write.revision}.`, revision: deck.revision } });
      }
      const run = shape.runs.find((r) => r.id === write.target)!;
      if ((deck.written[run.id] ?? 0) > write.revision || run.text !== write.expected) {
        return jsonResponse(409, {
          error: { code: "RUN_CONFLICT", message: `The run was written after revision ${write.revision}.`, revision: deck.revision, current: run.text },
        });
      }
      run.text = write.text;
      deck.revision++;
      deck.written[run.id] = deck.revision;
      return jsonResponse(200, { revision: deck.revision });
    }
    const asked = url.searchParams.get("shape");
    const shape = asked === null ? deck.shapes[0] : deck.shapes.find((s) => s.id === asked);
    if (asked !== null && shape === undefined) {
      return jsonResponse(404, { error: { code: "UNKNOWN_SHAPE", message: `There is no shape ${asked}.`, revision: deck.revision } });
    }
    const reply = jsonResponse(200, {
      revision: deck.revision,
      shapes: deck.shapes.map(({ id, label }) => ({ id, label })),
      shape: shape?.id ?? null,
      runs: shape?.runs.map((r) => ({ ...r })) ?? [],
      editable: deck.editable,
      refusal: deck.refusal,
    });
    const held = holds.shift();
    if (held !== undefined) {
      held.reach();
      await held.gate;
    }
    return reply;
  };
  return {
    decks,
    deck: decks["deck.pptx"]!,
    net,
    seen,
    api: new WorkspaceApi(ORIGIN, null, fetch),
    writes: (): LiveSlideRunWrite[] => seen.filter((s) => s.method === "PUT").map((s) => s.body as LiveSlideRunWrite),
    /** The text of each run of the title box of a deck. */
    title: (name = "deck.pptx"): string[] => decks[name]!.shapes[0]!.runs.map((r) => r.text),
    /** The next read of a deck takes the deck as it is when it is asked and answers only once `release` is called;
     * `reached` settles when the read has been asked. Reads queue: each call holds the next read not held yet. */
    holdRead: (): { reached: Promise<void>; release: () => void } => {
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      holds.push({ reach: reached.resolve, gate: gate.promise });
      return { reached: reached.promise, release: gate.resolve };
    },
  };
}

type Server = ReturnType<typeof server>;

/** Another member writes a run of deck.pptx. */
function writtenElsewhere(fake: Server, id: string, text: string): void {
  const run = fake.deck.shapes.flatMap((s) => s.runs).find((r) => r.id === id)!;
  run.text = text;
  fake.deck.revision++;
  fake.deck.written[id] = fake.deck.revision;
}

async function opened(fake: Server = server(), doc = "deck.pptx"): Promise<{ fake: Server; model: LiveSlideTextModel }> {
  const model = new LiveSlideTextModel(fake.api, "q3-close", doc);
  await model.refresh();
  return { fake, model };
}

/** Let what a handler started run to its end: the fake server answers at once, so a few turns of the loop do. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
}

type Handler = (event?: unknown) => unknown;
const keyDown = (key: string) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined });

const DOC = documentSummaries(room({ documents: [{ head: head("deck.pptx", 4) }] }))[0]!;

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

/** The text of `model` as it renders now: its text, its controls by test id, and the field and Save of each run. */
function view(model: LiveSlideTextModel) {
  const { html, vnodes } = rendered(<LiveSlideTextView model={model} state={model.state} doc={DOC} onClose={() => undefined} />);
  const props = vnodes.map((v) => v.props as Record<string, unknown>);
  const choices = vnodes.filter((v) => v.type === "option").map((v) => v.props as Record<string, unknown>);
  return {
    html,
    text: visible(html),
    has: (testid: string): boolean => html.includes(`data-testid="${testid}"`),
    get: (testid: string): Record<string, unknown> => {
      const found = props.find((p) => p["data-testid"] === testid);
      expect(found).toBeDefined();
      return found!;
    },
    run: (id: string): Record<string, unknown> | undefined => props.find((p) => p["data-slide-run"] === id),
    save: (id: string): Record<string, unknown> => props.find((p) => p["data-testid"] === "live-slide-text-save" && p["data-run"] === id)!,
    option: (id: string): Record<string, unknown> | undefined => choices.find((p) => p.value === id),
  };
}

describe("the live slide text route", () => {
  test("reads the first shape or a named one never from the cache, and writes a run over what a read found", async () => {
    const fake = server();
    expect((await fake.api.liveSlideText("q3-close", "deck.pptx", null)).shape).toBe(TITLE);
    expect((await fake.api.liveSlideText("q3-close", "deck.pptx", BODY)).runs.map((r) => r.text)).toEqual(["Fast PPTX", "Lossless first"]);
    const write: LiveSlideRunWrite = { revision: 4, target: NORTH, expected: "North", text: "West" };
    expect(await fake.api.writeLiveSlideRun("q3-close", "deck.pptx", write)).toBe(5);
    expect(fake.seen.map((s) => [s.method, s.url, s.cache])).toEqual([
      ["GET", ROUTE, "no-store"],
      ["GET", `${ROUTE}?shape=slide%3A%23256%2Fshape%3A%233`, "no-store"],
      ["PUT", ROUTE, undefined],
    ]);
    expect(fake.seen[2]!.body).toEqual(write);
  });

  test("a refused write throws the code and status of the server's envelope", async () => {
    const fake = server();
    writtenElsewhere(fake, NORTH, "West");
    const write: LiveSlideRunWrite = { revision: 4, target: NORTH, expected: "North", text: "Up" };
    const refused = await fake.api.writeLiveSlideRun("q3-close", "deck.pptx", write).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 409, code: "RUN_CONFLICT" });
  });
});

describe("live slide text", () => {
  test("the first read shows the first shape the server offers, each run in a field of its own, with no engine", async () => {
    const { fake, model } = await opened();
    expect(model.state).toMatchObject({ phase: "ready", revision: 4, shape: TITLE, editable: true, refusal: null, loaded: true });
    expect(editRefusal(model.state)).toBeNull();
    const v = view(model);
    expect(v.html).not.toContain("wolf-review");
    expect(v.get("live-slide-text-status").children).toBe("Live");
    expect(v.get("live-slide-text-shape").value).toBe(TITLE);
    expect(v.option(TITLE)?.children).toBe("Slide 1: TextBox 1");
    expect(v.option(BODY)?.children).toBe("Slide 1: TextBox 2");
    expect(v.run(NORTH)).toMatchObject({ value: "North", readOnly: false, "aria-label": "Run 1 of Slide 1: TextBox 1" });
    expect(v.run(SOUTH)).toMatchObject({ value: "South", readOnly: false });
    expect(v.text).toContain("Each field is the plain text of one run. Its formatting stays as the deck has it and is not shown here.");
    expect(v.text).toContain("No unsaved runs");
    expect(fake.seen.every((s) => s.url.startsWith(ROUTE) && s.method === "GET")).toBe(true);
  });

  test("Enter writes the run over the text the read found, leaves the run beside it as it was, and drops the draft", async () => {
    const { fake, model } = await opened();
    let v = view(model);
    (v.run(NORTH)!.onInput as Handler)({ currentTarget: { value: "West" } });
    v = view(model);
    expect(v.run(NORTH)).toMatchObject({ value: "West", "data-dirty": "true", "data-current": "North", "data-status": "editing" });
    expect(v.get("live-slide-text-draft-count").children).toBe("1 unsaved run");
    expect(v.save(NORTH).disabled).toBe(false);
    expect(v.save(SOUTH).disabled).toBe(true);

    (v.run(NORTH)!.onKeyDown as Handler)(keyDown("Enter"));
    await settle();
    expect(fake.writes()).toEqual([{ revision: 4, target: NORTH, expected: "North", text: "West" }]);
    expect(fake.title()).toEqual(["West", "South"]);
    expect(model.state.drafts).toEqual({});
    expect(model.state.revision).toBe(5);
    v = view(model);
    expect(v.run(NORTH)).toMatchObject({ value: "West", "data-dirty": undefined });
    expect(v.run(SOUTH)!.value).toBe("South");
  });

  test("Save sends the run's draft, and Escape drops one that was not sent", async () => {
    const { fake, model } = await opened();
    model.edit(SOUTH, "East");
    (view(model).save(SOUTH).onClick as Handler)();
    await settle();
    expect(fake.writes()).toEqual([{ revision: 4, target: SOUTH, expected: "South", text: "East" }]);
    model.edit(NORTH, "Up");
    (view(model).run(NORTH)!.onKeyDown as Handler)(keyDown("Escape"));
    expect(model.state.drafts).toEqual({});
    expect(fake.writes()).toHaveLength(1);
  });

  test("two members write two runs of one shape from the same read, and both land", async () => {
    const fake = server();
    const { model: alice } = await opened(fake);
    const { model: bob } = await opened(fake);
    alice.edit(NORTH, "West");
    bob.edit(SOUTH, "East");
    await alice.submit(K_NORTH);
    await bob.submit(K_SOUTH);
    expect(fake.writes()).toEqual([
      { revision: 4, target: NORTH, expected: "North", text: "West" },
      { revision: 4, target: SOUTH, expected: "South", text: "East" },
    ]);
    expect(fake.title()).toEqual(["West", "East"]);
    expect(bob.state.drafts).toEqual({});
    await alice.refresh();
    expect(view(alice).run(SOUTH)!.value).toBe("East");
  });

  test("a draft stays as typed while reads bring the other runs on, and goes over the read it was typed on", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    writtenElsewhere(fake, SOUTH, "East");
    await model.refresh();
    expect(model.state.revision).toBe(5);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "West", expected: "North", revision: 4 });
    const v = view(model);
    expect(v.run(NORTH)!.value).toBe("West");
    expect(v.run(SOUTH)!.value).toBe("East");
    await model.submit(K_NORTH);
    expect(fake.writes()).toEqual([{ revision: 4, target: NORTH, expected: "North", text: "West" }]);
    expect(fake.title()).toEqual(["West", "East"]);
  });

  test("the same run written by two members keeps the loser's draft beside the text that won, and writes nothing over it", async () => {
    const fake = server();
    const { model: alice } = await opened(fake);
    const { model: bob } = await opened(fake);
    alice.edit(NORTH, "West");
    bob.edit(NORTH, "Northwest");
    await alice.submit(K_NORTH);
    await bob.submit(K_NORTH);
    expect(fake.title()).toEqual(["West", "South"]);
    expect(bob.state.drafts[K_NORTH]).toMatchObject({
      status: "conflict",
      text: "Northwest",
      conflict: { code: "RUN_CONFLICT", local: false, current: "West", at: 5 },
    });
    let v = view(bob);
    expect(v.get("live-slide-text-conflict")).toMatchObject({ "data-run": NORTH, "data-shape": TITLE, "data-code": "RUN_CONFLICT" });
    expect(v.text).toContain("Slide 1: TextBox 1, run 1 :");
    expect(v.text).toContain("You typed Northwest ; it says West now.");
    expect(v.html).toContain('<code data-conflict="mine">Northwest</code>');
    expect(v.html).toContain('<code data-conflict="current">West</code>');
    expect(v.run(NORTH)).toMatchObject({ value: "Northwest", readOnly: true, "data-current": "West", "data-status": "conflict" });
    expect(v.save(NORTH).disabled).toBe(true);
    expect(v.get("live-slide-text-retype").disabled).toBe(false);

    // Nothing sends it as it is: no keystroke, no Enter, no Save.
    bob.edit(NORTH, "Northwest!");
    await bob.submit(K_NORTH);
    expect(bob.state.drafts[K_NORTH]?.text).toBe("Northwest");
    expect(fake.writes()).toHaveLength(2);

    (v.get("live-slide-text-use-current").onClick as Handler)();
    await settle();
    expect(bob.state.drafts).toEqual({});
    v = view(bob);
    expect(v.has("live-slide-text-conflict")).toBe(false);
    expect(v.run(NORTH)!.value).toBe("West");
    expect(fake.writes()).toHaveLength(2);
  });

  test("a run written and written back to the same text is still a conflict, and the person types theirs again over a newer read only", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    writtenElsewhere(fake, NORTH, "Up");
    writtenElsewhere(fake, NORTH, "North");
    await model.submit(K_NORTH);
    expect(fake.title()).toEqual(["North", "South"]);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "conflict", text: "West", conflict: { code: "RUN_CONFLICT", current: "North", at: 6 } });
    let v = view(model);
    expect(v.text).toContain("You typed West ; it says North now.");

    (v.get("live-slide-text-retype").onClick as Handler)();
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "North", expected: "North", revision: 6, earlier: "West", conflict: null });
    expect(fake.writes()).toHaveLength(1);
    v = view(model);
    expect(v.has("live-slide-text-conflict")).toBe(false);
    expect(v.run(NORTH)).toMatchObject({ value: "North", readOnly: false });
    expect(v.text).toContain("You had typed West before the run changed to North .");

    // A newer winner is never written over: the draft typed again goes over the read that showed North, and is refused.
    model.edit(NORTH, "West");
    writtenElsewhere(fake, NORTH, "Northeast");
    await model.submit(K_NORTH);
    expect(fake.writes().at(-1)).toEqual({ revision: 6, target: NORTH, expected: "North", text: "West" });
    expect(fake.title()).toEqual(["Northeast", "South"]);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "conflict", text: "West", conflict: { current: "Northeast", at: 7 } });

    model.retype(K_NORTH);
    model.edit(NORTH, "West");
    await model.submit(K_NORTH);
    expect(fake.writes().at(-1)).toEqual({ revision: 7, target: NORTH, expected: "Northeast", text: "West" });
    expect(fake.title()).toEqual(["West", "South"]);
    expect(model.state.drafts).toEqual({});
  });

  test("a read that finds the run changed under a draft holds the draft back before anything is sent", async () => {
    const { fake, model } = await opened();
    model.edit(SOUTH, "East");
    writtenElsewhere(fake, SOUTH, "Southeast");
    await model.refresh();
    expect(model.state.drafts[K_SOUTH]).toMatchObject({ status: "conflict", text: "East", conflict: { code: "RUN_CONFLICT", local: true, current: "Southeast", at: 5 } });
    await model.submit(K_SOUTH);
    expect(fake.writes()).toEqual([]);
    expect(view(model).text).toContain("You typed East ; it says Southeast now.");
  });

  test("a run that already says what the person typed leaves nothing to choose", async () => {
    const { fake, model } = await opened();
    model.edit(SOUTH, "East");
    writtenElsewhere(fake, SOUTH, "East");
    await model.refresh();
    expect(model.state.drafts).toEqual({});
    expect(fake.writes()).toEqual([]);
  });

  test("runs of a shape that moved are not typed again by id: the person keeps the current text", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    // A run is put before North: the ids are places, so the first run is now another run.
    fake.deck.shapes[0]!.runs = [
      { id: NORTH, text: "Due " },
      { id: SOUTH, text: "North" },
      { id: `${TITLE}/para:@1/run:@3`, text: "South" },
    ];
    fake.deck.revision++;
    fake.deck.shapes[0]!.structure = fake.deck.revision;
    await model.submit(K_NORTH);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "conflict", conflict: { code: "STRUCTURE_CONFLICT", current: "Due " } });
    let v = view(model);
    expect(v.get("live-slide-text-retype").disabled).toBe(true);
    expect(v.text).toContain("Keep the current text, then type yours again in the run you mean.");
    model.retype(K_NORTH);
    expect(model.state.drafts[K_NORTH]?.status).toBe("conflict");

    (v.get("live-slide-text-use-current").onClick as Handler)();
    await settle();
    expect(model.state.drafts).toEqual({});
    v = view(model);
    expect(v.run(SOUTH)!.value).toBe("North");
    expect(fake.writes()).toHaveLength(1);
  });

  test("a draft of a run a read no longer finds waits as a change of the runs", async () => {
    const { fake, model } = await opened();
    model.edit(SOUTH, "East");
    fake.deck.shapes[0]!.runs.pop();
    fake.deck.revision++;
    fake.deck.shapes[0]!.structure = fake.deck.revision;
    await model.refresh();
    expect(model.state.drafts[K_SOUTH]).toMatchObject({ status: "conflict", conflict: { code: "STRUCTURE_CONFLICT", local: true, current: null } });
    const v = view(model);
    expect(v.text).toContain("You typed East ; it is not in the deck any more.");
    expect(v.get("live-slide-text-retype").disabled).toBe(true);
    expect(v.run(SOUTH)).toBeUndefined();
  });

  test("text typed on while a run is sent stays a draft over the text that landed", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    const sent = model.submit(K_NORTH);
    model.edit(NORTH, "Western");
    await sent;
    expect(fake.writes()).toEqual([{ revision: 4, target: NORTH, expected: "North", text: "West" }]);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Western", expected: "West", revision: 5 });
  });

  test("a read begun before a save and answered after it does not turn the next edit into a conflict", async () => {
    const { fake, model } = await opened();
    const before = fake.holdRead();
    const after = fake.holdRead();
    model.edit(NORTH, "West");
    // The first read takes the deck at revision 4 and waits; the save lands as revision 5 while it does.
    const early = model.refresh();
    const sent = model.submit(K_NORTH);
    model.edit(NORTH, "Western");
    // The read after the save has been asked for, so the save was answered and the draft is over what landed.
    await after.reached;
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Western", expected: "West", revision: 5 });
    // The earlier read answers now, with the text from before the save.
    before.release();
    await early;
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Western", expected: "West", revision: 5, conflict: null });
    expect(model.state.revision).toBe(4);
    after.release();
    await sent;
    expect(model.state.revision).toBe(5);
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Western", expected: "West", revision: 5, conflict: null });
    // The next edit is an ordinary draft, and it lands over the text of the save.
    model.edit(NORTH, "Westerner");
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Westerner", conflict: null });
    await model.submit(K_NORTH);
    expect(fake.writes()).toEqual([
      { revision: 4, target: NORTH, expected: "North", text: "West" },
      { revision: 5, target: NORTH, expected: "West", text: "Westerner" },
    ]);
    expect(fake.title()).toEqual(["Westerner", "South"]);
    expect(model.state.drafts).toEqual({});
  });

  test("a read of a revision newer than the save, with the run written by someone else, is still a conflict", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    const sent = model.submit(K_NORTH);
    model.edit(NORTH, "Western");
    await sent;
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "Western", expected: "West", revision: 5, conflict: null });
    writtenElsewhere(fake, NORTH, "Nord");
    await model.refresh();
    expect(model.state.revision).toBe(6);
    expect(model.state.drafts[K_NORTH]).toMatchObject({
      status: "conflict",
      text: "Western",
      conflict: { code: "RUN_CONFLICT", local: true, current: "Nord", at: 6 },
    });
    await model.submit(K_NORTH);
    expect(fake.writes()).toEqual([{ revision: 4, target: NORTH, expected: "North", text: "West" }]);
  });

  test("another shape keeps its own drafts, and an answer for a shape the page left changes nothing", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    model.setShape(BODY);
    model.setShape(TITLE);
    await settle();
    expect(model.state.shape).toBe(TITLE);
    expect(model.state.runs.map((r) => r.id)).toEqual([NORTH, SOUTH]);

    model.setShape(BODY);
    await settle();
    expect(fake.seen.at(-1)!.url).toBe(`${ROUTE}?shape=slide%3A%23256%2Fshape%3A%233`);
    let v = view(model);
    expect(v.run(NORTH)).toBeUndefined();
    expect(v.run(FAST)!.value).toBe("Fast PPTX");
    expect(v.option(TITLE)?.children).toBe("Slide 1: TextBox 1 (1 unsaved)");
    model.edit(FAST, "Faster PPTX");
    expect(Object.keys(model.state.drafts).sort()).toEqual([K_NORTH, draftKey(BODY, FAST)].sort());

    // A draft of a shape not on show still goes when it is sent.
    await model.submit(K_NORTH);
    expect(fake.writes()).toEqual([{ revision: 4, target: NORTH, expected: "North", text: "West" }]);
    v = view(model);
    expect(v.get("live-slide-text-draft-count").children).toBe("1 unsaved run");
  });

  test("a shape that left the deck takes its drafts with it into conflict, and the page shows the first shape there is", async () => {
    const { fake, model } = await opened();
    model.setShape(BODY);
    await settle();
    model.edit(FAST, "Faster PPTX");
    fake.deck.shapes.pop();
    fake.deck.revision++;
    await model.refresh();
    await settle();
    expect(model.state.shape).toBe(TITLE);
    expect(model.state.drafts[draftKey(BODY, FAST)]).toMatchObject({ status: "conflict", conflict: { code: "STRUCTURE_CONFLICT", current: null } });
    const v = view(model);
    expect(v.get("live-slide-text-conflict")["data-shape"]).toBe(BODY);
    expect(v.get("live-slide-text-retype").disabled).toBe(true);
    expect(v.has("live-slide-text-load-error")).toBe(false);
  });

  test("a deck the server reads only shows its refusal, reads every shape, and takes no keystroke", async () => {
    const fake = server();
    fake.deck.editable = false;
    fake.deck.refusal = UNATTESTED;
    const { model } = await opened(fake);
    expect(model.state).toMatchObject({ editable: false, refusal: UNATTESTED });
    expect(editRefusal(model.state)).toEqual({ kind: "deck", message: UNATTESTED.message });
    model.edit(NORTH, "West");
    expect(model.state.drafts).toEqual({});
    const v = view(model);
    expect(v.get("live-slide-text-refusal")["data-code"]).toBe("LIVE_SLIDE_TEXT_UNATTESTED");
    expect(v.text).toContain(UNATTESTED.message);
    expect(v.get("live-slide-text-status").children).toBe("Read-only");
    expect(v.run(NORTH)).toMatchObject({ readOnly: true, value: "North" });
    expect(v.save(NORTH).disabled).toBe(true);
    model.setShape(BODY);
    await settle();
    expect(model.state.runs.map((r) => r.text)).toEqual(["Fast PPTX", "Lossless first"]);
    expect(fake.writes()).toEqual([]);
  });

  test("a write the server refuses for the whole deck turns the page read-only and keeps the draft", async () => {
    const { fake, model } = await opened();
    model.edit(NORTH, "West");
    fake.deck.refuse = { status: 402, code: "LICENSE_LIMIT", message: "This workspace is read-only." };
    await model.submit(K_NORTH);
    expect(model.state).toMatchObject({ editable: false, refusal: { code: "LICENSE_LIMIT", message: "This workspace is read-only." } });
    expect(model.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "West", error: null });
    const v = view(model);
    expect(v.text).toContain("Your 1 unsaved run stays on this page.");
    expect(v.run(NORTH)).toMatchObject({ readOnly: true, value: "West" });
    await model.submit(K_NORTH);
    expect(fake.writes()).toHaveLength(1);
  });

  test("text the server does not take stays as typed, with the refusal beside it", async () => {
    const { fake, model } = await opened();
    const refusal = "The text of a run may not hold a line break.";
    fake.deck.refuse = { status: 400, code: "BAD_REQUEST", message: refusal };
    model.edit(SOUTH, "So\tuth");
    await model.submit(K_SOUTH);
    expect(model.state.drafts[K_SOUTH]).toMatchObject({ status: "editing", text: "So\tuth", error: refusal });
    expect(model.state.editable).toBe(true);
    const v = view(model);
    expect(v.get("live-slide-text-error").role).toBe("alert");
    expect(v.text).toContain(refusal);
    expect(v.run(SOUTH)).toMatchObject({ readOnly: false, "aria-invalid": true });
  });

  test("a draft the server did not answer stays, and goes when the person sends it again", async () => {
    const { fake, model } = await opened();
    model.edit(SOUTH, "East");
    fake.net.down = true;
    await model.submit(K_SOUTH);
    expect(model.state.offline).toBe(true);
    expect(model.state.drafts[K_SOUTH]).toMatchObject({ status: "unsent", text: "East" });
    const v = view(model);
    expect(v.text).toContain("1 run waits to be sent");
    expect(v.get("live-slide-text-status").children).toBe("Offline");
    expect(v.get("live-slide-text-resend").children).toBe("Send again");

    fake.net.down = false;
    (v.get("live-slide-text-resend").onClick as Handler)();
    await settle();
    expect(fake.title()).toEqual(["North", "East"]);
    expect(model.state.offline).toBe(false);
    expect(model.state.drafts).toEqual({});
  });

  test("drafts belong to their document: the same native ids in two decks are written to their own deck only", async () => {
    const fake = server();
    fake.decks["pitch.pptx"] = mixedDeck();
    const { model: deck } = await opened(fake, "deck.pptx");
    const { model: pitch } = await opened(fake, "pitch.pptx");
    deck.edit(NORTH, "West");
    pitch.edit(NORTH, "Nord");
    await pitch.submit(K_NORTH);
    expect(deck.state.drafts[K_NORTH]).toMatchObject({ status: "editing", text: "West" });
    await deck.submit(K_NORTH);
    expect(fake.seen.filter((s) => s.method === "PUT").map((s) => s.url)).toEqual([`${ORIGIN}/api/rooms/q3-close/docs/pitch.pptx/live-slide-text`, ROUTE]);
    expect(fake.writes().map((w) => w.text)).toEqual(["Nord", "West"]);
    expect(fake.title("pitch.pptx")).toEqual(["Nord", "South"]);
    expect(fake.title("deck.pptx")).toEqual(["West", "South"]);
  });

  test("a deck with no shape to write shows so, with the server's refusal", async () => {
    const fake = server();
    fake.deck.shapes = [];
    fake.deck.editable = false;
    fake.deck.refusal = { code: "LIVE_SLIDE_TEXT_UNSUPPORTED", message: "deck.pptx has no shape text that may be written run by run." };
    const { model } = await opened(fake);
    expect(model.state).toMatchObject({ shape: null, loaded: true, editable: false });
    const v = view(model);
    expect(v.text).toContain("No text to write live");
    expect(v.get("live-slide-text-shape").disabled).toBe(true);
    expect(v.get("live-slide-text-refusal")["data-code"]).toBe("LIVE_SLIDE_TEXT_UNSUPPORTED");
  });
});

describe("the stage", () => {
  const noop = (): void => undefined;
  const memo = documentSummaries(room({ documents: [{ head: head("memo.docx", 3) }] }))[0]!;
  const model = documentSummaries(room({ documents: [{ head: head("model.xlsx", 2) }] }))[0]!;

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

  const offers = (over: Partial<StageProps> = {}): { slides: boolean; cells: boolean } => {
    const html = render(<Stage {...stageProps(over)} />);
    return { slides: html.includes('data-testid="live-slide-text-open"'), cells: html.includes('data-testid="live-cells-open"') };
  };

  test("offers live slide text on the head of a PPTX document to a user who is a member, and to no one else", () => {
    expect(offers()).toEqual({ slides: true, cells: false });
    expect(offers({ guest: true })).toEqual({ slides: false, cells: false });
    expect(offers({ actor: SCOUT })).toEqual({ slides: false, cells: false });
    expect(offers({ doc: memo })).toEqual({ slides: false, cells: false });
    expect(offers({ doc: model })).toEqual({ slides: false, cells: true });
    expect(offers({ proposal: proposal("p-1", "deck.pptx") })).toEqual({ slides: false, cells: false });
  });
});
