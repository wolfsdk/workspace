// The task loop against a scripted endpoint: a `fetch` that answers each model call from a list, in process.
// No socket is opened and no key leaves the test.
import { describe, expect, test } from "bun:test";
import {
  MCP_WORKSPACE_TOOLS,
  validateAssistantEvent,
  validateAssistantTurn,
  type AssistantServerEvent,
  type AssistantTurn,
  type McpWorkspaceCall,
} from "@wolfsdk/protocol/workspace";
import { ASSISTANT_CHAT_TOOLS, operationGuide, runAssistantTask, type AssistantTask, type AssistantTaskOptions, type AssistantToolResult } from "../src/index.ts";

/** Stands in for the key: any text the task must never repeat. */
const KEY = "placeholder-for-the-key";
const ENDPOINT = { url: "https://model.invalid/v1/chat/completions", model: "open-model-1", key: KEY };

const TASK: AssistantTask = {
  task_id: "task-1",
  conversation_id: "conv-1",
  room_id: "room-1",
  workspace_id: "ws-1",
  user: { kind: "user", id: "ada", name: "Ada" },
  assistant: { kind: "agent", id: "assistant", name: "Assistant" },
  request: { text: "Change the fee to 12%", doc_name: "terms.docx", target_address: "para:#5C7700D1" },
};

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number }; prompt_cache_hit_tokens?: number };
type ToolAsk = { name: string; arguments: unknown };
type Reply = { text?: string; tools?: ToolAsk[]; usage?: Usage };
/** One scripted answer: a completion (streamed unless `plain`), an error status, or a call that hangs until
 * it is aborted. */
type Scripted = (Reply & { plain?: true }) | { status: number; body?: string } | "hang";
type Sent = { headers: Headers; body: { model: string; messages: { role: string; content: unknown; tool_call_id?: string }[]; tools: unknown[]; stream: boolean } };

const sse = (chunks: unknown[]): Response =>
  new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), { headers: { "content-type": "text/event-stream" } });

function streamed(reply: Reply, call: number): Response {
  const chunks: unknown[] = [];
  // Text in two pieces, and each tool call with its arguments in two pieces, as a provider streams them.
  const text = reply.text ?? "";
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) if (piece !== "") chunks.push({ choices: [{ delta: { content: piece } }] });
  (reply.tools ?? []).forEach((tool, index) => {
    const args = JSON.stringify(tool.arguments);
    const cut = Math.ceil(args.length / 2);
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${call}_${index}`, type: "function", function: { name: tool.name, arguments: args.slice(0, cut) } }] } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(cut) } }] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
  if (reply.usage) chunks.push({ choices: [], usage: reply.usage });
  return sse(chunks);
}

function plain(reply: Reply, call: number): Response {
  const tool_calls = (reply.tools ?? []).map((tool, index) => ({ id: `call_${call}_${index}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }));
  return Response.json({ choices: [{ message: { role: "assistant", content: reply.text ?? null, tool_calls } }], usage: reply.usage });
}

function endpoint(script: Scripted[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const scripted = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const call = sent.length;
    sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = script[call];
    if (next === undefined) throw new Error(`the script has no answer for model call ${call + 1}`);
    if (next === "hang") {
      const { promise, reject } = Promise.withResolvers<Response>();
      const aborted = (): void => reject(new DOMException("aborted", "AbortError"));
      if (init?.signal?.aborted) aborted();
      else init?.signal?.addEventListener("abort", aborted);
      return promise;
    }
    if ("status" in next) return new Response(next.body ?? "", { status: next.status });
    return next.plain ? plain(next, call) : streamed(next, call);
  };
  return { fetch: scripted as typeof fetch, sent };
}

const ok = (data: Record<string, unknown>): AssistantToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const refused = (code: string, message: string): AssistantToolResult => {
  const data = { error: { code, message } };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
};

const READ: ToolAsk = { name: "doc_read", arguments: { doc: "terms.docx", view: "text" } };
const EDIT: ToolAsk = {
  name: "doc_edit",
  arguments: { doc: "terms.docx", base_revision: 3, mode: "commit", ops: [{ op: "replace-text", target: "para:#5C7700D1", find: "10%", replace: "12%" }] },
};
const PROPOSAL = { mode: "propose", proposal_id: "prop-1", status: "open", doc: "terms.docx", base_revision: 3, ops: 1 };

/** Run a task against `script`, with tools answered by `tools` in order of call. */
async function run(script: Scripted[], tools: (AssistantToolResult | (() => AssistantToolResult | Promise<AssistantToolResult>))[] = [], extra: Partial<AssistantTaskOptions> = {}) {
  const model = endpoint(script);
  const events: AssistantServerEvent[] = [];
  const calls: McpWorkspaceCall[] = [];
  let tick = 0;
  const turn = await runAssistantTask({
    endpoint: ENDPOINT,
    task: TASK,
    fetch: model.fetch,
    emit: (event) => events.push(structuredClone(event)),
    now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, tick++)).toISOString(),
    execute: async (call) => {
      const answer = tools[calls.length];
      calls.push(structuredClone(call));
      if (answer === undefined) throw new Error("the test has no tool answer for this call");
      return typeof answer === "function" ? await answer() : answer;
    },
    ...extra,
  });
  return { turn, events, calls, sent: model.sent };
}

/** What every task must hold, whatever its ending. */
function expectSound(turn: AssistantTurn, events: AssistantServerEvent[]): void {
  expect(validateAssistantTurn(turn)).toEqual([]);
  for (const event of events) expect(validateAssistantEvent(event)).toEqual([]);
  expect(events.at(-1)).toEqual({ type: "assistant.task.finished", task_id: "task-1", turn });
  expect(events.filter((event) => event.type === "assistant.task.finished")).toHaveLength(1);
  const deltas = events.flatMap((event) => (event.type === "assistant.text" ? [event.delta] : []));
  expect(deltas.join("")).toBe(turn.answer);
  expect(JSON.stringify([turn, events])).not.toContain(KEY);
}

describe("assistant task: what the model is sent", () => {
  test("the rules, the guide of the open document's format, the request with its selection, and the eight tools", async () => {
    const { sent, turn, events } = await run([{ text: "The fee is 10%." }]);
    expectSound(turn, events);
    const { headers, body } = sent[0]!;
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(body.model).toBe("open-model-1");
    expect(body.stream).toBe(true);
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    const system = String(body.messages[0]!.content);
    expect(system).toContain(operationGuide("docx"));
    expect(system).not.toContain(operationGuide("xlsx"));
    expect(body.messages[1]!.content).toBe("Change the fee to 12%\n\nOpen document: terms.docx\nSelection: para:#5C7700D1");
    expect(body.tools).toEqual(JSON.parse(JSON.stringify(ASSISTANT_CHAT_TOOLS)));
    expect(ASSISTANT_CHAT_TOOLS.map((tool) => [tool.function.name, tool.function.description, tool.function.parameters])).toEqual(
      MCP_WORKSPACE_TOOLS.map((tool) => [tool.name, tool.description, tool.inputSchema]),
    );
  });

  test("a task that names no document gets the guide of every format", async () => {
    const { sent } = await run([{ text: "Two documents." }], [], { task: { ...TASK, request: { text: "What is in this room?", doc_name: null, target_address: null } } });
    const system = String(sent[0]!.body.messages[0]!.content);
    for (const format of ["docx", "xlsx", "pptx", "pdf"] as const) expect(system).toContain(operationGuide(format));
    expect(sent[0]!.body.messages[1]!.content).toBe("What is in this room?");
  });

  test("the earlier turns of the conversation come before the request", async () => {
    const first = (await run([{ tools: [EDIT] }, { text: "Proposed 12%." }], [ok(PROPOSAL)])).turn;
    const { sent } = await run([{ text: "Yes, one proposal is open." }], [], { history: [first], task: { ...TASK, task_id: "task-2", request: { text: "Did you change it?", doc_name: null, target_address: null } } });
    expect(sent[0]!.body.messages.slice(1)).toEqual([
      { role: "user", content: "Change the fee to 12%\n\nOpen document: terms.docx\nSelection: para:#5C7700D1" },
      { role: "assistant", content: "Proposed 12%.\n(Proposals opened: prop-1)" },
      { role: "user", content: "Did you change it?" },
    ]);
  });
});

describe("assistant task: endings", () => {
  test("an answer with no tool call", async () => {
    const started: string[] = [];
    const { turn, events, calls, sent } = await run([{ text: "The fee is 10% of the invoice.", usage: { prompt_tokens: 900, completion_tokens: 12 } }], [], { started: (at) => started.push(at) });
    expectSound(turn, events);
    expect(turn).toMatchObject({ outcome: "answered", answer: "The fee is 10% of the invoice.", failure: null, steps: [], proposal_ids: [], model: "open-model-1" });
    expect(turn.usage).toEqual({ model_calls: 1, prompt_tokens: 900, cached_tokens: 0, completion_tokens: 12 });
    expect(events.filter((event) => event.type === "assistant.text").length).toBe(2);
    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(started).toEqual([turn.started_at]);
  });

  test("a read followed by a proposal: the edit runs as propose, and the usage is the sum of every model call", async () => {
    const { turn, events, calls, sent } = await run(
      [
        { text: "Reading the terms.", tools: [READ], usage: { prompt_tokens: 1000, completion_tokens: 20 } },
        { tools: [EDIT], usage: { prompt_tokens: 1500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } } },
        { text: "I proposed changing the fee to 12%.", usage: { prompt_tokens: 1700, completion_tokens: 15, prompt_cache_hit_tokens: 1500 }, plain: true },
      ],
      [ok({ doc: "terms.docx", revision: 3, text: "The fee is 10%." }), ok(PROPOSAL)],
    );
    expectSound(turn, events);
    expect(turn.outcome).toBe("proposed");
    expect(turn.proposal_ids).toEqual(["prop-1"]);
    expect(turn.answer).toBe("Reading the terms.\n\nI proposed changing the fee to 12%.");
    expect(turn.steps).toEqual([
      { step: 1, tool: "doc_read", doc_name: "terms.docx", status: "ok", summary: "read terms.docx as text" },
      { step: 2, tool: "doc_edit", doc_name: "terms.docx", status: "ok", summary: "proposed 1 change to terms.docx", proposal_id: "prop-1" },
    ]);
    expect(turn.usage).toEqual({ model_calls: 3, prompt_tokens: 4200, cached_tokens: 2500, completion_tokens: 75 });

    // The model asked to commit; the room was asked to propose.
    expect(calls[1]).toEqual({ name: "doc_edit", arguments: { ...(EDIT.arguments as object), mode: "propose" } } as McpWorkspaceCall);
    // Each step is announced running, then ended, under one number.
    expect(events.flatMap((event) => (event.type === "assistant.step" ? [[event.step.step, event.step.status]] : []))).toEqual([
      [1, "running"],
      [1, "ok"],
      [2, "running"],
      [2, "ok"],
    ]);
    // The model saw its own call and the tool's answer before it went on.
    expect(sent[1]!.body.messages.slice(2).map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(sent[1]!.body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_0_0", content: JSON.stringify({ doc: "terms.docx", revision: 3, text: "The fee is 10%." }) });
  });

  test("a refusal of the room is fed back to the model, which corrects itself", async () => {
    const { turn, events, calls, sent } = await run([{ tools: [EDIT] }, { tools: [READ] }, { tools: [EDIT] }, { text: "Proposed." }], [
      refused("REVISION_MISMATCH", "base_revision 3 is not the head 4"),
      ok({ doc: "terms.docx", revision: 4 }),
      ok(PROPOSAL),
    ]);
    expectSound(turn, events);
    expect(turn.outcome).toBe("proposed");
    expect(turn.steps.map((step) => [step.tool, step.status, step.summary])).toEqual([
      ["doc_edit", "failed", "refused: base_revision 3 is not the head 4"],
      ["doc_read", "ok", "read terms.docx as text"],
      ["doc_edit", "ok", "proposed 1 change to terms.docx"],
    ]);
    expect(sent[1]!.body.messages.at(-1)).toMatchObject({ role: "tool", content: JSON.stringify({ error: { code: "REVISION_MISMATCH", message: "base_revision 3 is not the head 4" } }) });
    expect(calls).toHaveLength(3);
  });

  test("a call that fails the tool's schema, or names no tool, never reaches the room and is fed back", async () => {
    const { turn, events, calls, sent } = await run(
      [{ tools: [{ name: "doc_edit", arguments: { doc: "terms.docx", ops: [] } }, { name: "doc_approve", arguments: {} }] }, { text: "I could not make that change." }],
      [],
    );
    expectSound(turn, events);
    expect(calls).toEqual([]);
    expect(turn.outcome).toBe("answered");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]).toMatchObject({ step: 1, tool: "doc_edit", status: "failed" });
    const [first, second] = sent[1]!.body.messages.slice(-2);
    expect(String(first!.content)).toContain("BAD_REQUEST");
    expect(String(second!.content)).toContain("there is no tool doc_approve");
  });

  test("the turn cap: a model that never stops is stopped at the last model call it is allowed", async () => {
    const { turn, events, calls, sent } = await run([{ tools: [READ] }, { tools: [READ] }, { tools: [READ] }, { tools: [READ] }], [ok({ revision: 3 }), ok({ revision: 3 }), ok({ revision: 3 })], {
      limits: { maxModelCalls: 3 },
    });
    expectSound(turn, events);
    expect(turn.outcome).toBe("turn_limit");
    expect(turn.usage.model_calls).toBe(3);
    expect(sent).toHaveLength(3);
    expect(calls).toHaveLength(3);
  });

  test("the token cap: no further model call once the task has used its tokens", async () => {
    const { turn, events, sent } = await run([{ tools: [READ], usage: { prompt_tokens: 4000, completion_tokens: 1000 } }, { text: "never asked" }], [ok({ revision: 3 })], { limits: { maxTokens: 5000 } });
    expectSound(turn, events);
    expect(turn.outcome).toBe("token_limit");
    expect(turn.usage).toEqual({ model_calls: 1, prompt_tokens: 4000, cached_tokens: 0, completion_tokens: 1000 });
    expect(sent).toHaveLength(1);
    expect(turn.steps).toHaveLength(1);
  });

  test("a cancel while a tool runs ends the task without another model call", async () => {
    const abort = new AbortController();
    const { turn, events, sent } = await run(
      [{ text: "Reading.", tools: [READ, EDIT] }, { text: "never asked" }],
      [
        () => {
          abort.abort();
          return ok({ revision: 3 });
        },
      ],
      { signal: abort.signal },
    );
    expectSound(turn, events);
    expect(turn.outcome).toBe("cancelled");
    expect(turn.steps.map((step) => step.tool)).toEqual(["doc_read"]);
    expect(turn.proposal_ids).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("a cancel while the model is thinking ends the task", async () => {
    const abort = new AbortController();
    const pending = run(["hang"], [], { signal: abort.signal, started: () => queueMicrotask(() => abort.abort()) });
    const { turn, events } = await pending;
    expectSound(turn, events);
    expect(turn).toMatchObject({ outcome: "cancelled", answer: "", failure: null });
    expect(turn.usage.model_calls).toBe(1);
  });

  test("an endpoint failure ends the task as failed, and says why without the key", async () => {
    const { turn, events } = await run([{ tools: [READ], usage: { prompt_tokens: 100, completion_tokens: 5 } }, { status: 503, body: `upstream refused ${KEY}` }], [ok({ revision: 3 })]);
    expectSound(turn, events);
    expect(turn).toMatchObject({ outcome: "failed", failure: "the model endpoint answered 503" });
    expect(turn.usage).toEqual({ model_calls: 2, prompt_tokens: 100, cached_tokens: 0, completion_tokens: 5 });
    expect(turn.steps).toHaveLength(1);
  });

  test("an endpoint that can not be reached, or that quotes the key in its error, fails the task cleanly", async () => {
    const unreachable = await runAssistantTask({
      endpoint: ENDPOINT,
      task: TASK,
      emit: () => {},
      execute: async () => ok({}),
      fetch: (async () => {
        throw new TypeError(`connect failed with ${KEY}`);
      }) as unknown as typeof fetch,
    });
    expect(validateAssistantTurn(unreachable)).toEqual([]);
    expect(unreachable).toMatchObject({ outcome: "failed", failure: "the model endpoint could not be reached" });

    const quoted = await runAssistantTask({
      endpoint: ENDPOINT,
      task: TASK,
      emit: () => {},
      execute: async () => ok({}),
      fetch: (async () => Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } })) as unknown as typeof fetch,
    });
    expect(validateAssistantTurn(quoted)).toEqual([]);
    expect(quoted.failure).toBe("the model endpoint reported an error: Incorrect API key provided: [key]");
  });

  test("a model that says nothing and calls nothing fails the task", async () => {
    const { turn, events } = await run([{}]);
    expectSound(turn, events);
    expect(turn).toMatchObject({ outcome: "failed", failure: "the model gave no answer", answer: "" });
  });
});

describe("assistant task: page images", () => {
  const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  const drawn: AssistantToolResult = { content: [{ type: "text", text: '{"pages":[1]}' }, png], structuredContent: { pages: [1] } };
  const LOOK: ToolAsk = { name: "doc_inspect_visual", arguments: { doc: "terms.docx", pages: [1] } };

  test("are left out for a model that reads text", async () => {
    const { sent } = await run([{ tools: [LOOK] }, { text: "Looked." }], [drawn]);
    const after = sent[1]!.body.messages.slice(2);
    expect(after.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(String(after[1]!.content)).toContain("1 page image not shown");
    expect(JSON.stringify(after)).not.toContain(png.data);
  });

  test("follow the tool answers for a model that reads images", async () => {
    const { sent } = await run([{ tools: [LOOK] }, { text: "Looked." }], [drawn], { images: true });
    const after = sent[1]!.body.messages.slice(2);
    expect(after.map((message) => message.role)).toEqual(["assistant", "tool", "user"]);
    expect(after[2]!.content).toEqual([
      { type: "text", text: "The page images of the calls above:" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } },
    ]);
  });
});
