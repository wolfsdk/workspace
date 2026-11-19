// The assistant service against a scripted endpoint: a `fetch` that answers each model call from a list, in
// process. No key leaves the test. Every event a connection is sent is checked against the contract. The
// first part drives the service directly; the last part drives it through the WebSocket endpoint, on a real
// local port, with the room server and the stand-in reactor behind it.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantToolResult } from "@wolfsdk/assistant";
import {
  validateAssistantEvent,
  validateAssistantTurn,
  validateRoomEvent,
  type AssistantAgent,
  type AssistantServerEvent,
  type AssistantTurn,
  type McpWorkspaceCall,
  type RoomActor,
} from "@wolfsdk/protocol/workspace";
import { assistantAgentOf, AssistantService, type AssistantConnection, type AssistantServiceOptions, type AssistantToolRunner } from "../src/assistant.ts";
import { startWsServer, type WsServer } from "../src/ws.ts";
import { alice, bob, type Harness as RoomHarness, makeHarness, robot, seedRoom } from "./fixtures/harness.ts";

// The socket tests flush writes to disk and open sockets: on a busy host one can take many seconds.
setDefaultTimeout(120_000);

/** Stands in for the key: any text a connection must never be sent. */
const KEY = "placeholder-for-the-key";
const ENDPOINT = { url: "https://model.invalid/v1/chat/completions", model: "open-model-1", key: KEY };
const ADA: RoomActor = { kind: "user", id: "ada", name: "Ada" };
const BOB: RoomActor = { kind: "user", id: "bob", name: "Bob" };
const ROOMS = [
  { room_id: "room-1", workspace_id: "ws-1" },
  { room_id: "room-2", workspace_id: "ws-1" },
  { room_id: "room-3", workspace_id: "ws-2" },
];

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };
type Reply = { text?: string; tools?: { name: string; arguments: unknown }[]; usage?: Usage };
/** One scripted answer: a streamed completion, or a call that hangs until it is aborted. */
type Scripted = Reply | "hang";
type Sent = { messages: { role: string; content: unknown }[] };

function streamed(reply: Reply, call: number): Response {
  const chunks: unknown[] = [];
  if (reply.text) chunks.push({ choices: [{ delta: { content: reply.text } }] });
  (reply.tools ?? []).forEach((tool, index) => {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${call}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
  if (reply.usage) chunks.push({ choices: [], usage: reply.usage });
  return new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });
}

/** A model that answers its calls from `script`, in the order they arrive. */
function model(script: Scripted[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const scripted = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const call = sent.length;
    sent.push(JSON.parse(String(init?.body)) as Sent);
    const next = script[call];
    if (next === undefined) throw new Error(`the script has no answer for model call ${call + 1}`);
    if (next !== "hang") return streamed(next, call);
    const { promise, reject } = Promise.withResolvers<Response>();
    const aborted = (): void => reject(new DOMException("aborted", "AbortError"));
    if (init?.signal?.aborted) aborted();
    else init?.signal?.addEventListener("abort", aborted);
    return promise;
  };
  return { fetch: scripted as typeof fetch, sent };
}

type TestConnection = AssistantConnection & { roomId: string | null; open: boolean; events: AssistantServerEvent[]; next(): Promise<void> };

/** A connection that records what it is sent, checked against the contract. */
function connect(actor: RoomActor, roomId: string | null = "room-1"): TestConnection {
  const events: AssistantServerEvent[] = [];
  let arrived = Promise.withResolvers<void>();
  return {
    actor,
    roomId,
    open: true,
    events,
    /** Resolves when the next event is sent. */
    next: () => arrived.promise,
    send(event) {
      expect(validateAssistantEvent(event)).toEqual([]);
      expect(JSON.stringify(event)).not.toContain(KEY);
      events.push(structuredClone(event));
      arrived.resolve();
      arrived = Promise.withResolvers<void>();
    },
  };
}

const EDIT = { name: "doc_edit", arguments: { doc: "terms.docx", base_revision: 3, mode: "commit", ops: [{ op: "replace-text", target: "para:#5C7700D1", find: "10%", replace: "12%" }] } };
const PROPOSAL = { mode: "propose", proposal_id: "prop-1", status: "open", doc: "terms.docx", base_revision: 3, ops: 1 };
const ok = (data: Record<string, unknown>): AssistantToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

type ToolCall = { roomId: string; agent: AssistantAgent; call: McpWorkspaceCall };
type Harness = { service: AssistantService; sent: Sent[]; tools: ToolCall[]; clock: { instant: string } };

const open: AssistantService[] = [];
afterEach(async () => {
  for (const service of open.splice(0)) await service.close();
});

/** A service whose model answers from `script`. The clock stands still until a test moves it. */
function serve(script: Scripted[], options: Partial<AssistantServiceOptions> = {}): Harness {
  const scripted = model(script);
  const tools: ToolCall[] = [];
  const clock = { instant: "2026-11-14T09:00:00.000Z" };
  const service = new AssistantService({
    endpoint: ENDPOINT,
    allowance: null,
    storePath: ":memory:",
    rooms: { listRooms: async () => ROOMS },
    tools: async (roomId, agent, call) => {
      tools.push({ roomId, agent, call: structuredClone(call) });
      return ok(PROPOSAL);
    },
    fetch: scripted.fetch,
    now: () => clock.instant,
    ...options,
  });
  open.push(service);
  return { service, sent: scripted.sent, tools, clock };
}

let requests = 0;
const ask = (text: string, conversationId: string | null = null) => ({
  type: "assistant.ask",
  request_id: `req-${++requests}`,
  conversation_id: conversationId,
  text,
  doc_name: "terms.docx",
  target_address: null,
});
const status = () => ({ type: "assistant.status", request_id: `req-${++requests}` });
const history = (conversationId: string | null) => ({ type: "assistant.history", request_id: `req-${++requests}`, conversation_id: conversationId });

const types = (connection: TestConnection): string[] => connection.events.map((event) => event.type);
const last = (connection: TestConnection): AssistantServerEvent => connection.events.at(-1) as AssistantServerEvent;
const turnsOf = (connection: TestConnection): AssistantTurn[] => connection.events.flatMap((event) => (event.type === "assistant.task.finished" ? [event.turn] : []));
const taskOf = (connection: TestConnection): string => connection.events.flatMap((event) => (event.type === "assistant.task.started" ? [event.task_id] : [])).at(-1) as string;

/** Wait until `count` tasks have finished on `connection`. */
async function finished(connection: TestConnection, count = 1): Promise<AssistantTurn> {
  while (turnsOf(connection).length < count) await connection.next();
  const turns = turnsOf(connection);
  expect(turns).toHaveLength(count);
  return turns.at(-1) as AssistantTurn;
}

describe("assistant service: a task", () => {
  test("an ask is answered with started, step, text and finished, and its edit is a proposal by the user's agent", async () => {
    const { service, tools } = serve([{ tools: [EDIT] }, { text: "I proposed the change.", usage: { prompt_tokens: 40, completion_tokens: 6 } }]);
    const ada = connect(ADA);
    await service.handle(ada, ask("Change the fee to 12%"));
    const turn = await finished(ada);

    expect(types(ada)).toEqual(["assistant.task.started", "assistant.step", "assistant.step", "assistant.text", "assistant.task.finished"]);
    expect(validateAssistantTurn(turn)).toEqual([]);
    expect(turn).toMatchObject({ outcome: "proposed", proposal_ids: ["prop-1"], room_id: "room-1", workspace_id: "ws-1", user: ADA, model: "open-model-1", answer: "I proposed the change." });

    // The model asked to commit; the tool handler was asked to propose, as an agent, in the room of the ask.
    const agent = assistantAgentOf(ADA);
    expect(agent.kind).toBe("agent");
    expect(turn.assistant).toEqual(agent);
    expect(tools).toEqual([{ roomId: "room-1", agent, call: { name: "doc_edit", arguments: { ...EDIT.arguments, mode: "propose" } } as McpWorkspaceCall }]);
    // The room server asks who operates that agent: the user who asked, so its calls act on her seat.
    expect(service.operatorOf(agent)).toEqual({ id: "ada", name: "Ada" });
    expect(service.operatorOf({ kind: "agent", id: "another-agent", name: "Another" })).toBeNull();
    expect(service.operatorOf(ADA)).toBeNull();
  });

  test("an agent, a connection in no room, a room the server does not hold and a malformed message are refused", async () => {
    const { service, sent } = serve([]);
    const cases: [TestConnection, unknown, string, string | null][] = [
      [connect({ kind: "agent", id: "outside-agent", name: "Outside" }), ask("hello"), "FORBIDDEN", "set"],
      [connect(ADA, null), status(), "NOT_IN_ROOM", "set"],
      [connect(ADA, "room-9"), ask("hello"), "NOT_IN_ROOM", "set"],
      [connect(ADA), { type: "assistant.ask", request_id: "req-bad", text: 7 }, "BAD_REQUEST", "req-bad"],
      [connect(ADA), { type: "assistant.dance" }, "BAD_REQUEST", null],
    ];
    for (const [connection, message, code, requestId] of cases) {
      await service.handle(connection, message);
      expect(connection.events).toHaveLength(1);
      expect(last(connection)).toMatchObject({ type: "assistant.error", code });
      if (requestId !== "set") expect(last(connection)).toMatchObject({ request_id: requestId });
    }
    expect(sent).toEqual([]);
  });

  test("with no endpoint the status says not configured and an ask is refused", async () => {
    const { service, sent } = serve([], { endpoint: null, allowance: 5 });
    const ada = connect(ADA);
    await service.handle(ada, { type: "assistant.status", request_id: "req-s" });
    expect(last(ada)).toEqual({ type: "assistant.status", request_id: "req-s", state: "not_configured", model: null, allowance: null });
    await service.handle(ada, ask("hello"));
    expect(last(ada)).toMatchObject({ type: "assistant.error", code: "NOT_CONFIGURED" });
    expect(sent).toEqual([]);
  });
});

describe("assistant service: a running task", () => {
  test("does not hold up its connection, allows no second one for the user in the room, and stops on cancel", async () => {
    const { service } = serve(["hang", { text: "Bob's answer." }, { text: "Ada again." }]);
    const ada = connect(ADA);
    // `handle` returns while the model call is still open: the connection's next request is not held up.
    await service.handle(ada, ask("first"));
    expect(types(ada)).toEqual(["assistant.task.started"]);
    await service.handle(ada, status());
    expect(last(ada)).toMatchObject({ type: "assistant.status", state: "ready" });

    await service.handle(ada, ask("second"));
    expect(last(ada)).toMatchObject({ type: "assistant.error", code: "BUSY" });
    // Another user in the same room is not kept waiting by her task.
    const bob = connect(BOB);
    await service.handle(bob, ask("mine"));
    expect((await finished(bob)).outcome).toBe("answered");
    expect(turnsOf(ada)).toEqual([]);

    const task = taskOf(ada);
    await service.handle(bob, { type: "assistant.cancel", request_id: "req-c1", task_id: task });
    expect(last(bob)).toMatchObject({ type: "assistant.error", code: "UNKNOWN_TASK", request_id: "req-c1" });
    await service.handle(ada, { type: "assistant.cancel", request_id: "req-c2", task_id: task });
    const turn = await finished(ada);
    expect(turn).toMatchObject({ task_id: task, outcome: "cancelled" });
    expect(validateAssistantTurn(turn)).toEqual([]);

    // The room is free for her again.
    await service.handle(ada, ask("third"));
    expect((await finished(ada, 2)).answer).toBe("Ada again.");
  });

  test("follows its user to the connection she comes back on, and to no other open one", async () => {
    const { service } = serve(["hang"]);
    const first = connect(ADA);
    await service.handle(first, ask("first"));
    const task = taskOf(first);

    // A second tab of the same user does not take the events of the tab that asked.
    const tab = connect(ADA);
    await service.handle(tab, status());
    // The first socket drops; she joins again on a new one.
    first.open = false;
    const back = connect(ADA);
    await service.handle(back, status());
    await service.handle(back, { type: "assistant.cancel", request_id: "req-c", task_id: task });
    expect((await finished(back)).task_id).toBe(task);
    expect(turnsOf(first)).toEqual([]);
    expect(types(tab)).toEqual(["assistant.status"]);
  });

  test("tells the connection she comes back on the task as far as it has gone: its start, its steps and its text so far", async () => {
    const { service } = serve([{ text: "Changing the fee. ", tools: [EDIT] }, "hang"]);
    const first = connect(ADA);
    await service.handle(first, ask("Change the fee to 12%"));
    // The edit has ended and the task says the paragraph break that comes before its second model call, which
    // hangs: the task runs with a step and some text behind it.
    const texts = (): string[] => first.events.flatMap((event) => (event.type === "assistant.text" ? [event.delta] : []));
    while (texts().length < 2) await first.next();
    const [started] = first.events;
    expect(started?.type).toBe("assistant.task.started");
    const task = taskOf(first);
    const steps = first.events.flatMap((event) => (event.type === "assistant.step" ? [event] : []));
    const text = texts().join("");
    expect(text).toBe("Changing the fee. \n\n");

    // The socket drops under the running task; she comes back on a new one and asks for the status, as the panel does.
    first.open = false;
    const told = first.events.length;
    const back = connect(ADA);
    const asked = status();
    await service.handle(back, asked);
    expect(back.events).toEqual([
      started as AssistantServerEvent,
      steps.at(-1) as AssistantServerEvent,
      { type: "assistant.text", task_id: task, delta: text },
      { type: "assistant.status", request_id: asked.request_id, state: "ready", model: "open-model-1", allowance: { period: "2026-11", limit: null, used: 1, resets_at: "2026-12-01T00:00:00Z" } },
    ]);
    expect(steps.at(-1)).toMatchObject({ step: { step: 1, tool: "doc_edit", status: "ok", proposal_id: "prop-1" } });

    // A status asked again on the connection the task now follows tells it again: the panel asks one each time
    // the room goes live, which may be on the same socket.
    await service.handle(back, status());
    expect(types(back).slice(4)).toEqual(["assistant.task.started", "assistant.step", "assistant.text", "assistant.status"]);

    // She can stop it from there, and its turn comes to her there.
    await service.handle(back, { type: "assistant.cancel", request_id: "req-stop", task_id: task });
    const turn = await finished(back);
    expect(turn).toMatchObject({ task_id: task, outcome: "cancelled", proposal_ids: ["prop-1"] });
    expect(validateAssistantTurn(turn)).toEqual([]);
    expect(first.events).toHaveLength(told);
  });

  test("tells a task nothing before its first model call, and a finished one not at all", async () => {
    const { service } = serve([{ text: "Done." }]);
    const first = connect(ADA);
    await service.handle(first, ask("quick"));
    await finished(first);
    first.open = false;
    const back = connect(ADA);
    await service.handle(back, status());
    expect(types(back)).toEqual(["assistant.status"]);
  });
});

describe("assistant service: the allowance", () => {
  test("counts a task at its first model call, refuses an ask at the limit, and resets with the month", async () => {
    const { service, sent, clock } = serve(["hang", { text: "Bob's answer." }, { text: "A new month." }], { allowance: 1 });
    const ada = connect(ADA);
    await service.handle(ada, status());
    expect(last(ada)).toMatchObject({ state: "ready", model: "open-model-1", allowance: { period: "2026-11", limit: 1, used: 0, resets_at: "2026-12-01T00:00:00Z" } });

    // The first model call is open and nothing has finished: the task already counts.
    await service.handle(ada, ask("first"));
    expect(last(ada)).toMatchObject({ type: "assistant.task.started", allowance: { limit: 1, used: 1 } });
    await service.handle(ada, status());
    expect(last(ada)).toMatchObject({ state: "allowance_exhausted", allowance: { used: 1 } });

    // Her seat is at the limit in every room; a refused ask starts nothing and counts nothing.
    const elsewhere = connect(ADA, "room-2");
    await service.handle(elsewhere, ask("second"));
    expect(elsewhere.events).toHaveLength(1);
    expect(last(elsewhere)).toMatchObject({ type: "assistant.error", code: "ALLOWANCE_EXHAUSTED", allowance: { period: "2026-11", limit: 1, used: 1 } });
    expect(sent).toHaveLength(1);

    // The allowance is of a seat: another user asks freely.
    const bob = connect(BOB);
    await service.handle(bob, ask("mine"));
    expect((await finished(bob)).outcome).toBe("answered");

    clock.instant = "2026-12-01T00:00:00.000Z";
    await service.handle(elsewhere, status());
    expect(last(elsewhere)).toMatchObject({ state: "ready", allowance: { period: "2026-12", limit: 1, used: 0, resets_at: "2027-01-01T00:00:00Z" } });
    await service.handle(elsewhere, ask("third"));
    expect((await finished(elsewhere)).answer).toBe("A new month.");
  });

  test("a status asked on the same connection after the UTC month changed reports the new month with nothing used, and the seat asks again", async () => {
    const { service, clock } = serve([{ text: "The last of the year." }, { text: "The first of the year." }], { allowance: 1 });
    clock.instant = "2026-12-31T23:59:59.999Z";
    const ada = connect(ADA);
    await service.handle(ada, ask("before midnight"));
    const december = await finished(ada);
    await service.handle(ada, status());
    expect(last(ada)).toMatchObject({ state: "allowance_exhausted", allowance: { period: "2026-12", limit: 1, used: 1, resets_at: "2027-01-01T00:00:00Z" } });
    await service.handle(ada, ask("refused"));
    expect(last(ada)).toMatchObject({ type: "assistant.error", code: "ALLOWANCE_EXHAUSTED" });

    // The clock of the service crosses midnight UTC of the first, a year boundary too. The connection is the
    // same one: no reconnect, no reload, only another status.
    clock.instant = "2027-01-01T00:00:00.000Z";
    const asked = status();
    await service.handle(ada, asked);
    expect(last(ada)).toEqual({
      type: "assistant.status",
      request_id: asked.request_id,
      state: "ready",
      model: "open-model-1",
      allowance: { period: "2027-01", limit: 1, used: 0, resets_at: "2027-02-01T00:00:00Z" },
    });
    await service.handle(ada, ask("after midnight", december.conversation_id));
    const january = await finished(ada, 2);
    expect(january).toMatchObject({ answer: "The first of the year.", conversation_id: december.conversation_id, started_at: "2027-01-01T00:00:00.000Z" });
    expect(ada.events.flatMap((event) => (event.type === "assistant.task.started" ? [event.allowance] : [])).at(-1)).toMatchObject({ period: "2027-01", used: 1 });
    // Each month keeps its own task.
    expect(service.usage("ws-1", "2026-12").tasks).toBe(1);
    expect(service.usage("ws-1", "2027-01").tasks).toBe(1);
  });

  test("unset, the server does not meter; a limit below what a seat has used shows the seat at the limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assistant-"));
    try {
      const storePath = join(dir, "assistant.sqlite");
      const unmetered = serve([{ text: "One." }, { text: "Two." }], { storePath });
      const ada = connect(ADA);
      await unmetered.service.handle(ada, ask("one"));
      await finished(ada);
      await unmetered.service.handle(ada, ask("two"));
      await finished(ada, 2);
      await unmetered.service.handle(ada, status());
      expect(last(ada)).toMatchObject({ state: "ready", allowance: { limit: null, used: 2 } });
      await unmetered.service.close();
      open.length = 0;

      const metered = serve([], { storePath, allowance: 1 });
      await metered.service.handle(ada, status());
      expect(last(ada)).toMatchObject({ state: "allowance_exhausted", allowance: { limit: 1, used: 1 } });
      expect(() => serve([], { allowance: 1.5 })).toThrow("whole number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("assistant service: what is stored", () => {
  test("turns survive a restart: the usage of a workspace in a month per seat, and a conversation continued", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assistant-"));
    try {
      const storePath = join(dir, "assistant.sqlite");
      const before = serve(
        [
          { text: "Ada, one.", usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } } },
          { text: "Bob, one.", usage: { prompt_tokens: 300, completion_tokens: 5 } },
          { text: "Ada, two.", usage: { prompt_tokens: 2000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1500 } } },
          { text: "Another workspace.", usage: { prompt_tokens: 7, completion_tokens: 1 } },
        ],
        { storePath },
      );
      const ada = connect(ADA);
      const bob = connect(BOB, "room-2");
      const other = connect(ADA, "room-3");
      await before.service.handle(ada, ask("What is the fee?"));
      const first = await finished(ada);
      await before.service.handle(bob, ask("mine"));
      await finished(bob);
      await before.service.handle(ada, ask("And the term?", first.conversation_id));
      const second = await finished(ada, 2);
      await before.service.handle(other, ask("elsewhere"));
      await finished(other);
      await before.service.close();
      open.length = 0;

      const after = serve([{ text: "Ada, three." }], { storePath });
      expect(after.service.usage("ws-1", "2026-11")).toEqual({
        contract: "wolfsdk.assistant.v1",
        workspace_id: "ws-1",
        period: "2026-11",
        tasks: 3,
        usage: { model_calls: 3, prompt_tokens: 3300, cached_tokens: 2100, completion_tokens: 55 },
        seats: [
          { user_id: "ada", tasks: 2, usage: { model_calls: 2, prompt_tokens: 3000, cached_tokens: 2100, completion_tokens: 50 } },
          { user_id: "bob", tasks: 1, usage: { model_calls: 1, prompt_tokens: 300, cached_tokens: 0, completion_tokens: 5 } },
        ],
      });
      expect(after.service.usage("ws-1", "2026-12").tasks).toBe(0);
      expect(after.service.usage("ws-2", "2026-11")).toMatchObject({ tasks: 1, seats: [{ user_id: "ada", tasks: 1 }] });

      // Her latest conversation in the room, as stored.
      const again = connect(ADA);
      await after.service.handle(again, { type: "assistant.history", request_id: "req-h1", conversation_id: null });
      expect(last(again)).toEqual({ type: "assistant.conversation", request_id: "req-h1", conversation_id: first.conversation_id, turns: [first, second] });
      // A conversation is its user's, in its room.
      const bobAgain = connect(BOB);
      await after.service.handle(bobAgain, { type: "assistant.history", request_id: "req-h2", conversation_id: first.conversation_id });
      expect(last(bobAgain)).toMatchObject({ type: "assistant.error", code: "UNKNOWN_CONVERSATION", request_id: "req-h2" });
      await after.service.handle(bobAgain, ask("continue hers", first.conversation_id));
      expect(last(bobAgain)).toMatchObject({ type: "assistant.error", code: "UNKNOWN_CONVERSATION" });
      await after.service.handle(bobAgain, { type: "assistant.history", request_id: "req-h3", conversation_id: null });
      expect(last(bobAgain)).toEqual({ type: "assistant.conversation", request_id: "req-h3", conversation_id: null, turns: [] });

      // The model is given the stored turns of the conversation it continues.
      await after.service.handle(again, ask("And the notice period?", first.conversation_id));
      const third = await finished(again);
      expect(third.conversation_id).toBe(first.conversation_id);
      const context = JSON.stringify(after.sent[0]?.messages);
      for (const said of ["What is the fee?", "Ada, one.", "And the term?", "Ada, two.", "And the notice period?"]) expect(context).toContain(said);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a new conversation leaves the earlier one stored and readable, and every task of both still counts", async () => {
    const { service, sent } = serve(
      [
        { text: "The fee is 10%.", usage: { prompt_tokens: 100, completion_tokens: 5 } },
        { text: "The term is a year.", usage: { prompt_tokens: 200, completion_tokens: 6 } },
        { text: "A fresh start.", usage: { prompt_tokens: 50, completion_tokens: 3 } },
      ],
      { allowance: 10 },
    );
    const ada = connect(ADA);
    await service.handle(ada, ask("What is the fee?"));
    const first = await finished(ada);
    await service.handle(ada, ask("And the term?", first.conversation_id));
    const second = await finished(ada, 2);

    // The panel's new conversation: an ask with no conversation.
    await service.handle(ada, ask("Summarize the parties", null));
    const fresh = await finished(ada, 3);
    expect(fresh.conversation_id).not.toBe(first.conversation_id);
    // The model starts the new conversation without the earlier one.
    const context = JSON.stringify(sent[2]?.messages);
    for (const earlier of ["What is the fee?", "The fee is 10%.", "And the term?"]) expect(context).not.toContain(earlier);

    // The earlier conversation stays stored and can be read; the latest is the new one.
    await service.handle(ada, history(first.conversation_id));
    expect(last(ada)).toMatchObject({ type: "assistant.conversation", conversation_id: first.conversation_id, turns: [first, second] });
    await service.handle(ada, history(null));
    expect(last(ada)).toMatchObject({ type: "assistant.conversation", conversation_id: fresh.conversation_id, turns: [fresh] });
    // The tasks of both conversations count, in the usage of the workspace and in the allowance of the seat.
    expect(service.usage("ws-1", "2026-11")).toMatchObject({ tasks: 3, usage: { model_calls: 3, prompt_tokens: 350, completion_tokens: 14 }, seats: [{ user_id: "ada", tasks: 3 }] });
    await service.handle(ada, status());
    expect(last(ada)).toMatchObject({ state: "ready", allowance: { limit: 10, used: 3 } });
  });
});

type Wire = { type: string; [member: string]: unknown };

/** A socket that remembers every event it is sent, and what the contract of each has against it. A wait that
 * is never satisfied ends with the test runner's own timeout. */
class Socket {
  readonly events: Wire[] = [];
  readonly invalid: string[] = [];
  private arrived = Promise.withResolvers<void>();
  private readonly socket: WebSocket;
  private readonly ended = Promise.withResolvers<void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as Wire;
      this.invalid.push(...(event.type.startsWith("assistant.") ? validateAssistantEvent(event) : validateRoomEvent(event)));
      this.events.push(event);
      this.arrived.resolve();
      this.arrived = Promise.withResolvers<void>();
    };
    socket.onclose = () => this.ended.resolve();
  }

  static async connect(url: string, as: string): Promise<Socket> {
    const socket = new WebSocket(`${url}?as=${as}`);
    const opened = Promise.withResolvers<void>();
    socket.onopen = () => opened.resolve();
    socket.onerror = () => opened.reject(new Error(`could not connect as ${as}`));
    await opened.promise;
    return new Socket(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  of(type: string): Wire[] {
    return this.events.filter((event) => event.type === type);
  }

  /** The `n`th event of a type, once it has arrived. */
  async nth(type: string, n = 1): Promise<Wire> {
    while (this.of(type).length < n) await this.arrived.promise;
    return this.of(type)[n - 1] as Wire;
  }

  assistant(): string[] {
    return this.events.flatMap((event) => (event.type.startsWith("assistant.") ? [event.type] : []));
  }

  close(): void {
    this.socket.close();
  }

  /** Close, and wait until the closing handshake is over: the server has seen the socket go. */
  async closed(): Promise<void> {
    this.socket.close();
    await this.ended.promise;
  }
}

describe("assistant service: through the WebSocket endpoint", () => {
  let h: RoomHarness;
  let ws: WsServer;
  let service: AssistantService | null = null;
  let sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      expect(socket.invalid).toEqual([]);
      socket.close();
    }
    sockets = [];
    await ws.stop();
    await service?.close();
    service = null;
    await h.dispose();
  });

  const actorFor = (name: string | null): RoomActor | null => (name === "alice" ? alice : name === "bob" ? bob : name === "robot" ? robot : null);

  /** The `doc_edit` handler of the test: the edit the model asked for, made in the real room as the agent. */
  const roomTools: AssistantToolRunner = async (roomId, agent, call) => {
    if (call.name !== "doc_edit") throw new Error(`the test has no handler for ${call.name}`);
    const { doc, base_revision, mode } = call.arguments;
    const edited = await h.server.edit(roomId, agent, { doc_name: doc, base_revision, mode, batch: { ops: [{ op: "append", text: "!" }] } });
    if (!edited.ok) return { content: [{ type: "text", text: edited.error.message }], structuredContent: { error: edited.error }, isError: true };
    if (edited.value.mode !== "propose") throw new Error("the assistant committed");
    return ok({ mode: "propose", proposal_id: edited.value.proposal.proposal_id, status: "open" });
  };

  /** A room server with one room and one document, an endpoint, and (unless `assistant` is false) the assistant. */
  async function start(script: Scripted[], options: { allowance?: number | null; assistant?: false } = {}): Promise<void> {
    h = await makeHarness({ operatorOf: (agent) => service?.operatorOf(agent) ?? null });
    await seedRoom(h);
    if (options.assistant !== false) {
      service = new AssistantService({
        endpoint: ENDPOINT,
        allowance: options.allowance ?? null,
        storePath: join(h.dir, "assistant.sqlite"),
        rooms: h.server,
        tools: roomTools,
        fetch: model(script).fetch,
      });
    }
    ws = startWsServer({
      service: h.server,
      authenticate: (request) => actorFor(new URL(request.url).searchParams.get("as")),
      ...(service ? { assistant: service } : {}),
    });
  }

  async function joined(as: string): Promise<Socket> {
    const socket = await Socket.connect(ws.url, as);
    sockets.push(socket);
    socket.send({ type: "room.join", request_id: "join", room_id: "room", since_seq: null });
    return socket;
  }

  const DOC_EDIT = { name: "doc_edit", arguments: { doc: "doc.docx", base_revision: 0, mode: "commit", ops: [{ op: "replace-text", target: "p1", find: "hello", replace: "goodbye" }] } };
  const askFor = (requestId: string) => ({ type: "assistant.ask", request_id: requestId, conversation_id: null, text: "Say goodbye instead", doc_name: "doc.docx", target_address: null });
  const commit = (requestId: string, base: number) => ({ type: "doc.edit", request_id: requestId, doc_name: "doc.docx", base_revision: base, mode: "commit", batch: { ops: [{ op: "append", text: "?" }] } });

  test("an ask becomes a proposal only a user approves; at the limit the assistant stops and editing continues", async () => {
    await start([{ tools: [DOC_EDIT] }, { text: "I proposed the change." }], { allowance: 1 });
    const a = await joined("alice");
    // Sent on the heels of the join, as the panel does: answered after it, in the order of the connection.
    a.send({ type: "assistant.status", request_id: "s-1" });
    expect(await a.nth("assistant.status")).toMatchObject({ request_id: "s-1", state: "ready", allowance: { limit: 1, used: 0 } });

    a.send(askFor("a-1"));
    const done = await a.nth("assistant.task.finished");
    expect(a.assistant()).toEqual(["assistant.status", "assistant.task.started", "assistant.step", "assistant.step", "assistant.text", "assistant.task.finished"]);
    const turn = done.turn as AssistantTurn;
    expect(validateAssistantTurn(turn)).toEqual([]);
    expect(turn).toMatchObject({ outcome: "proposed", user: alice, workspace_id: "ws", room_id: "room" });

    // The room announced the proposal: opened by her agent, on her seat, and not applied.
    const agent = assistantAgentOf(alice);
    const opened = await a.nth("proposal.updated");
    expect(opened).toMatchObject({ proposal: { proposal_id: turn.proposal_ids[0], status: "open", author: agent } });
    expect(h.server.listSeats().map((seat) => [seat.kind, seat.id])).toEqual([["user", "alice"]]);
    expect(a.of("doc.committed")).toEqual([]);
    // An agent does not decide it.
    const r = await joined("robot");
    r.send({ type: "proposal.decide", request_id: "d-0", proposal_id: turn.proposal_ids[0], decision: "approve" });
    expect(await r.nth("error")).toMatchObject({ request_id: "d-0", code: "FORBIDDEN" });

    // The allowance of her seat is used: the assistant refuses, and says so.
    a.send(askFor("a-2"));
    expect(await a.nth("assistant.error")).toMatchObject({ request_id: "a-2", code: "ALLOWANCE_EXHAUSTED", allowance: { limit: 1, used: 1 } });
    a.send({ type: "assistant.status", request_id: "s-2" });
    expect(await a.nth("assistant.status", 2)).toMatchObject({ request_id: "s-2", state: "allowance_exhausted" });

    // On the same connection she approves the proposal, edits and comments as before.
    a.send({ type: "proposal.decide", request_id: "d-1", proposal_id: turn.proposal_ids[0], decision: "approve" });
    expect(await a.nth("proposal.updated", 2)).toMatchObject({ proposal: { status: "approved" } });
    expect(await a.nth("doc.committed")).toMatchObject({ entry: { author: agent, proposal_id: turn.proposal_ids[0] } });
    a.send(commit("e-1", 1));
    expect(await a.nth("doc.committed", 2)).toMatchObject({ entry: { author: alice } });
    a.send({ type: "comment.post", request_id: "c-1", thread_id: null, doc_name: "doc.docx", target_address: "p1", body: "done", mentions: [] });
    expect(await a.nth("comment.updated")).toMatchObject({ thread: { doc_name: "doc.docx" } });
    expect(a.of("error")).toEqual([]);
  });

  test("a running task does not hold up the other requests of its connection, and cancel stops it", async () => {
    await start(["hang"]);
    const a = await joined("alice");
    a.send(askFor("a-1"));
    const started = await a.nth("assistant.task.started");
    // The model call is open. Her edit behind it on the same connection is committed all the same.
    a.send(commit("e-1", 0));
    expect(await a.nth("doc.committed")).toMatchObject({ entry: { author: alice } });
    expect(a.of("assistant.task.finished")).toEqual([]);
    a.send(askFor("a-2"));
    expect(await a.nth("assistant.error")).toMatchObject({ request_id: "a-2", code: "BUSY" });

    a.send({ type: "assistant.cancel", request_id: "x-1", task_id: started.task_id });
    expect(await a.nth("assistant.task.finished")).toMatchObject({ task_id: started.task_id, turn: { outcome: "cancelled" } });
  });

  test("a client that joins again while its task runs is told the running task, with its steps and text so far, and can stop it", async () => {
    await start([{ text: "Proposing it now.", tools: [DOC_EDIT] }, "hang"]);
    const a = await joined("alice");
    a.send({ type: "assistant.status", request_id: "s-1" });
    await a.nth("assistant.status");
    a.send(askFor("a-1"));
    const started = await a.nth("assistant.task.started");
    const opened = await a.nth("assistant.step", 2);
    expect(opened).toMatchObject({ step: { status: "ok" } });
    // The paragraph break the task says before its second model call, which stays open.
    await a.nth("assistant.text", 2);
    await a.closed();

    // A new socket of hers: the join, then the status the panel asks for each time the room goes live.
    const b = await joined("alice");
    b.send({ type: "assistant.status", request_id: "s-2" });
    await b.nth("assistant.status");
    expect(b.assistant()).toEqual(["assistant.task.started", "assistant.step", "assistant.text", "assistant.status"]);
    expect(await b.nth("assistant.task.started")).toEqual(started);
    expect(await b.nth("assistant.step")).toEqual(opened);
    expect(await b.nth("assistant.text")).toEqual({ type: "assistant.text", task_id: started.task_id, delta: "Proposing it now.\n\n" });

    b.send({ type: "assistant.cancel", request_id: "x-1", task_id: started.task_id });
    expect(await b.nth("assistant.task.finished")).toMatchObject({ task_id: started.task_id, turn: { outcome: "cancelled" } });
  });

  test("an endpoint started without the assistant says it is not configured and refuses a task, as the workspace server does", async () => {
    await start([], { assistant: false });
    const a = await joined("alice");
    a.send({ type: "assistant.status", request_id: "s-1" });
    expect(await a.nth("assistant.status")).toEqual({ type: "assistant.status", request_id: "s-1", state: "not_configured", model: null, allowance: null });
    a.send(askFor("a-1"));
    expect(await a.nth("assistant.error")).toMatchObject({ request_id: "a-1", code: "NOT_CONFIGURED" });
    a.send({ type: "assistant.history", request_id: "h-1", conversation_id: null });
    expect(await a.nth("assistant.conversation")).toEqual({ type: "assistant.conversation", request_id: "h-1", conversation_id: null, turns: [] });
    // The room is untouched: no error of the room contract, and editing goes on.
    a.send(commit("e-1", 0));
    expect(await a.nth("doc.committed")).toMatchObject({ entry: { author: alice } });
    expect(a.of("error")).toEqual([]);
  });
});
