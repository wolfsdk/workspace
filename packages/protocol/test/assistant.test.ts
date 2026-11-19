import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_ALLOWANCE_EXHAUSTED,
  ASSISTANT_CLIENT_MESSAGE_TYPES,
  ASSISTANT_CONTRACT,
  ASSISTANT_ERROR_CODES,
  ASSISTANT_OUTCOMES,
  ASSISTANT_REQUEST_MAX_CHARS,
  ASSISTANT_SCHEMA,
  ASSISTANT_SERVER_EVENT_TYPES,
  ASSISTANT_STATES,
  ASSISTANT_STEP_STATUSES,
  ASSISTANT_TOOL_NAMES,
  MCP_WORKSPACE_TOOL_NAMES,
  ROOM_CLIENT_MESSAGE_TYPES,
  ROOM_SERVER_EVENT_TYPES,
  assistantPeriod,
  assistantPeriodEnd,
  isAssistantMessage,
  summarizeAssistantUsage,
  validateAssistantClientMessage,
  validateAssistantEvent,
  validateAssistantTurn,
  validateAssistantUsageSummary,
  validateRoomClientMessage,
  validateRoomEvent,
  type AssistantTurn,
} from "../src/workspace/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
/** A deep copy of `base` that `change` has edited. */
const edit = <T>(base: T, change: (copy: Json) => void): unknown => {
  const copy = structuredClone(base) as Json;
  change(copy);
  return copy;
};
/** `problems` is not empty and names `fragment`. */
const refused = (problems: string[], fragment: string): void => {
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join("\n")).toContain(fragment);
};

const T1 = "2026-11-14T09:00:00Z";
const T2 = "2026-11-14T09:00:41.500Z";
const T3 = "2026-11-14T09:05:00Z";
const USER = { kind: "user", id: "u-1", name: "Ada" } as const;
const ASSISTANT = { kind: "agent", id: "assistant:u-1", name: "Assistant" } as const;
const USAGE = { model_calls: 3, prompt_tokens: 9200, cached_tokens: 6100, completion_tokens: 410 };
const ALLOWANCE = { period: "2026-11", limit: 300, used: 12, resets_at: "2026-12-01T00:00:00Z" };
const SPENT = { ...ALLOWANCE, used: 300 };
const UNMETERED = { ...ALLOWANCE, limit: null, used: 4012 };

const TURN: AssistantTurn = {
  contract: ASSISTANT_CONTRACT,
  task_id: "task-1",
  conversation_id: "conv-1",
  room_id: "room-1",
  workspace_id: "ws-1",
  user: USER,
  assistant: ASSISTANT,
  request: { text: "Tighten the summary and fix the total in table 2", doc_name: "report.docx", target_address: "para:~2a9256c0" },
  outcome: "proposed",
  answer: "I shortened the summary and corrected the total.",
  failure: null,
  steps: [
    { step: 1, tool: "doc_read", doc_name: "report.docx", status: "ok", summary: "Read the structure of report.docx" },
    { step: 2, tool: "doc_edit", doc_name: "report.docx", status: "failed", summary: "The engine refused: unknown target" },
    { step: 3, tool: "doc_edit", doc_name: "report.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" },
  ],
  proposal_ids: ["prop-7"],
  model: "deepseek-v4.1-flash",
  usage: USAGE,
  started_at: T1,
  finished_at: T2,
};
const ANSWERED: AssistantTurn = {
  ...TURN,
  task_id: "task-2",
  request: { text: "How many tables does this have?", doc_name: "report.docx", target_address: null },
  outcome: "answered",
  answer: "Two.",
  steps: [{ step: 1, tool: "doc_read", doc_name: "report.docx", status: "ok" }],
  proposal_ids: [],
  usage: { model_calls: 2, prompt_tokens: 5000, cached_tokens: 0, completion_tokens: 12 },
  started_at: T3,
  finished_at: T3,
};

const SERVER_EVENTS = {
  "assistant.status": { type: "assistant.status", request_id: "req-1", state: "ready", model: "deepseek-v4.1-flash", allowance: ALLOWANCE },
  "assistant.task.started": { type: "assistant.task.started", request_id: "req-2", task_id: "task-1", conversation_id: "conv-1", allowance: ALLOWANCE, started_at: T1 },
  "assistant.step": { type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "report.docx", status: "running" } },
  "assistant.text": { type: "assistant.text", task_id: "task-1", delta: "I shortened" },
  "assistant.task.finished": { type: "assistant.task.finished", task_id: "task-1", turn: TURN },
  "assistant.conversation": { type: "assistant.conversation", request_id: "req-3", conversation_id: "conv-1", turns: [TURN, ANSWERED] },
  "assistant.error": { type: "assistant.error", request_id: "req-2", code: "BUSY", message: "a task is already running" },
} as const;
const EXHAUSTED = { type: "assistant.error", request_id: "req-2", code: ASSISTANT_ALLOWANCE_EXHAUSTED, message: "300 of 300 tasks used", allowance: SPENT };

const CLIENT_MESSAGES = {
  "assistant.status": { type: "assistant.status", request_id: "req-1" },
  "assistant.ask": { type: "assistant.ask", request_id: "req-2", conversation_id: null, text: "Tighten the summary", doc_name: "report.docx", target_address: null },
  "assistant.cancel": { type: "assistant.cancel", request_id: "req-4", task_id: "task-1" },
  "assistant.history": { type: "assistant.history", request_id: "req-3", conversation_id: null },
} as const;

describe("assistant: contract", () => {
  const defs = ASSISTANT_SCHEMA.$defs as Json;

  test("the contract, its schema and its message types", () => {
    expect(ASSISTANT_CONTRACT).toBe("wolfsdk.assistant.v1");
    expect(ASSISTANT_SCHEMA.$id).toBe("https://wolfsdk.com/schemas/assistant.v1.schema.json");
    expect(Object.keys(SERVER_EVENTS)).toEqual([...ASSISTANT_SERVER_EVENT_TYPES]);
    expect(Object.keys(CLIENT_MESSAGES)).toEqual([...ASSISTANT_CLIENT_MESSAGE_TYPES]);
    expect(defs.serverEvent.anyOf.length).toBe(ASSISTANT_SERVER_EVENT_TYPES.length + 1);
    expect(defs.clientMessage.anyOf.length).toBe(ASSISTANT_CLIENT_MESSAGE_TYPES.length);
  });

  test("the enums of the schema are the constants of the module", () => {
    expect(defs.outcome.enum).toEqual([...ASSISTANT_OUTCOMES]);
    expect(defs.stepStatus.enum).toEqual([...ASSISTANT_STEP_STATUSES]);
    expect(defs.assistantState.enum).toEqual([...ASSISTANT_STATES]);
    expect(defs.ev_error.properties.code.enum).toEqual([...ASSISTANT_ERROR_CODES]);
    expect(defs.ev_allowance_exhausted.properties.code.const).toBe(ASSISTANT_ALLOWANCE_EXHAUSTED);
    expect(defs.askText.maxLength).toBe(ASSISTANT_REQUEST_MAX_CHARS);
  });

  test("the error codes name an unconfigured server and a used-up allowance", () => {
    expect(ASSISTANT_ERROR_CODES).toContain("NOT_CONFIGURED");
    expect(ASSISTANT_ALLOWANCE_EXHAUSTED).toBe("ALLOWANCE_EXHAUSTED");
    expect(ASSISTANT_ERROR_CODES as readonly string[]).not.toContain(ASSISTANT_ALLOWANCE_EXHAUSTED);
  });

  test("a step names one of the eight tools of wolfsdk.mcp-workspace.v1, and no other", () => {
    expect(defs.tool.enum).toEqual([...MCP_WORKSPACE_TOOL_NAMES]);
    expect(ASSISTANT_TOOL_NAMES).toBe(MCP_WORKSPACE_TOOL_NAMES);
    expect(defs.tool.enum.length).toBe(8);
  });

  test("no assistant message is a room message, and no room message is an assistant message", () => {
    for (const type of ASSISTANT_CLIENT_MESSAGE_TYPES) expect(ROOM_CLIENT_MESSAGE_TYPES as readonly string[]).not.toContain(type);
    for (const type of ASSISTANT_SERVER_EVENT_TYPES) expect(ROOM_SERVER_EVENT_TYPES as readonly string[]).not.toContain(type);
    for (const type of [...ASSISTANT_CLIENT_MESSAGE_TYPES, ...ASSISTANT_SERVER_EVENT_TYPES]) expect(type.startsWith("assistant.")).toBe(true);
    for (const type of [...ROOM_CLIENT_MESSAGE_TYPES, ...ROOM_SERVER_EVENT_TYPES]) expect(isAssistantMessage({ type })).toBe(false);
    for (const message of Object.values(CLIENT_MESSAGES)) {
      expect(isAssistantMessage(message)).toBe(true);
      refused(validateRoomClientMessage(message), "is not a room client message");
    }
    for (const event of Object.values(SERVER_EVENTS)) refused(validateRoomEvent(event), "is not a room server event");
    for (const other of [null, "assistant.ask", [], { type: 7 }, {}]) expect(isAssistantMessage(other)).toBe(false);
  });

  test("the room contract is as it was frozen: its schema file is untouched by this contract", () => {
    const room = readFileSync(join(import.meta.dir, "../schemas/room.v1.schema.json"), "utf8");
    expect(room).not.toContain("assistant");
  });
});

describe("assistant: turn", () => {
  test("a task that proposed and a task that answered are valid", () => {
    expect(validateAssistantTurn(TURN)).toEqual([]);
    expect(validateAssistantTurn(ANSWERED)).toEqual([]);
  });

  test("every outcome is valid, with a failure exactly when it failed", () => {
    for (const outcome of ASSISTANT_OUTCOMES) {
      const turn = edit(ANSWERED, (t) => ((t.outcome = outcome), (t.failure = outcome === "failed" ? "the model endpoint answered 503" : null)));
      if (outcome === "proposed") refused(validateAssistantTurn(turn), "opened at least one proposal");
      else expect(validateAssistantTurn(turn)).toEqual([]);
    }
    refused(validateAssistantTurn(edit(TURN, (t) => (t.failure = "boom"))), "is set exactly when the outcome is failed");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.outcome = "failed"))), "is set exactly when the outcome is failed");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.outcome = "abandoned"))), "not in enum");
  });

  test("a task cut short may keep the proposals it had opened; an answered task has none, and has an answer", () => {
    for (const outcome of ["cancelled", "turn_limit", "token_limit"]) expect(validateAssistantTurn(edit(TURN, (t) => (t.outcome = outcome)))).toEqual([]);
    refused(validateAssistantTurn(edit(TURN, (t) => (t.outcome = "answered"))), "an answered task opened no proposal");
    refused(validateAssistantTurn(edit(ANSWERED, (t) => (t.answer = ""))), "an answered task has an answer");
    expect(validateAssistantTurn(edit(TURN, (t) => (t.answer = "")))).toEqual([]);
  });

  test("the user is a user and the assistant is an agent", () => {
    refused(validateAssistantTurn(edit(TURN, (t) => (t.user = ASSISTANT))), '$.user.kind: expected "user"');
    refused(validateAssistantTurn(edit(TURN, (t) => (t.assistant = USER))), '$.assistant.kind: expected "agent"');
  });

  test("steps are numbered from 1 in order, and none is still running", () => {
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[1].step = 3))), "$.steps[1].step: 3 does not follow 1");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[0].step = 0))), "below minimum");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[0].status = "running"))), "a finished task has no running step");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[0].tool = "doc_delete"))), "not in enum");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[0].summary = ""))), "too short");
    expect(validateAssistantTurn(edit(ANSWERED, (t) => (t.steps = [])))).toEqual([]);
  });

  test("the proposals of a turn are the ones its steps opened, once each and in order", () => {
    refused(validateAssistantTurn(edit(TURN, (t) => (t.proposal_ids = []))), "are not the proposals its steps opened");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.proposal_ids = ["prop-7", "prop-8"]))), "are not the proposals its steps opened");
    refused(validateAssistantTurn(edit(TURN, (t) => delete t.steps[2].proposal_id)), "are not the proposals its steps opened");
    refused(validateAssistantTurn(edit(TURN, (t) => ((t.steps[0].proposal_id = "prop-7"), (t.proposal_ids = ["prop-7", "prop-7"])))), "a proposal is listed twice");
    refused(validateAssistantTurn(edit(TURN, (t) => ((t.steps[1].proposal_id = "prop-6"), (t.proposal_ids = ["prop-6", "prop-7"])))), "a step that is failed opened no proposal");
    const two = edit(TURN, (t) => ((t.steps[0].proposal_id = "prop-6"), (t.proposal_ids = ["prop-6", "prop-7"])));
    expect(validateAssistantTurn(two)).toEqual([]);
    refused(validateAssistantTurn(edit(two, (t) => t.proposal_ids.reverse())), "in order");
  });

  test("usage counts the model calls of the task and their prompt, cached and completion tokens", () => {
    for (const key of ["model_calls", "prompt_tokens", "cached_tokens", "completion_tokens"]) {
      refused(validateAssistantTurn(edit(TURN, (t) => delete t.usage[key])), `missing ${key}`);
      refused(validateAssistantTurn(edit(TURN, (t) => (t.usage[key] = -1))), "below minimum");
      refused(validateAssistantTurn(edit(TURN, (t) => (t.usage[key] = 1.5))), "expected integer");
    }
    refused(validateAssistantTurn(edit(TURN, (t) => (t.usage.cached_tokens = 9201))), "$.usage.cached_tokens: 9201 is more than the 9200 prompt tokens");
    expect(validateAssistantTurn(edit(TURN, (t) => (t.usage.cached_tokens = 9200)))).toEqual([]);
    refused(validateAssistantTurn(edit(TURN, (t) => (t.usage.model_calls = 0))), "a task is counted at its first model call");
  });

  test("its times are calendar instants, finished not before started", () => {
    refused(validateAssistantTurn(edit(TURN, (t) => (t.started_at = "2026-02-30T00:00:00Z"))), "$.started_at: not a calendar instant");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.finished_at = "2026-11-14T25:00:00Z"))), "$.finished_at: not a calendar instant");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.finished_at = "2026-11-14 09:00:41Z"))), "does not match");
    refused(validateAssistantTurn(edit(TURN, (t) => ((t.started_at = T2), (t.finished_at = T1)))), "$.finished_at: is before started_at");
    expect(validateAssistantTurn(edit(TURN, (t) => (t.finished_at = t.started_at)))).toEqual([]);
  });

  test("a request is at most the documented length, and names a document and a selection or null", () => {
    expect(validateAssistantTurn(edit(TURN, (t) => (t.request.text = "x".repeat(ASSISTANT_REQUEST_MAX_CHARS))))).toEqual([]);
    refused(validateAssistantTurn(edit(TURN, (t) => (t.request.text = "x".repeat(ASSISTANT_REQUEST_MAX_CHARS + 1)))), "longer than 16000 characters");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.request.text = ""))), "too short");
    refused(validateAssistantTurn(edit(TURN, (t) => delete t.request.target_address)), "missing target_address");
    expect(validateAssistantTurn(edit(TURN, (t) => ((t.request.doc_name = null), (t.request.target_address = null))))).toEqual([]);
  });

  test("the shape is closed: contract, members, ids", () => {
    refused(validateAssistantTurn(edit(TURN, (t) => (t.contract = "wolfsdk.assistant.v2"))), 'expected "wolfsdk.assistant.v1"');
    refused(validateAssistantTurn(edit(TURN, (t) => (t.cost_usd = 0.006))), "unexpected cost_usd");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.steps[0].arguments = {}))), "unexpected arguments");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.task_id = "task 1"))), "does not match");
    refused(validateAssistantTurn(edit(TURN, (t) => (t.model = ""))), "too short");
    for (const member of Object.keys(TURN)) refused(validateAssistantTurn(edit(TURN, (t) => delete t[member])), `missing ${member}`);
    refused(validateAssistantTurn(null), "expected object");
  });
});

describe("assistant: allowance", () => {
  const status = SERVER_EVENTS["assistant.status"];

  test("a month ends at the first instant of the next one, in UTC", () => {
    expect(assistantPeriod("2026-11-30T23:59:59.999Z")).toBe("2026-11");
    expect(assistantPeriodEnd("2026-11")).toBe("2026-12-01T00:00:00Z");
    expect(assistantPeriodEnd("2026-12")).toBe("2027-01-01T00:00:00Z");
    expect(assistantPeriodEnd("2028-02")).toBe("2028-03-01T00:00:00Z");
  });

  test("an allowance names its month, its limit or null, the tasks used and when it resets", () => {
    for (const allowance of [ALLOWANCE, SPENT, UNMETERED, { ...ALLOWANCE, used: 0 }]) {
      const state = allowance === SPENT ? "allowance_exhausted" : "ready";
      expect(validateAssistantEvent(edit(status, (e) => ((e.allowance = allowance), (e.state = state))))).toEqual([]);
    }
    // The shape, read where the allowance is not optional, so each problem is named.
    const started = SERVER_EVENTS["assistant.task.started"];
    for (const member of ["period", "limit", "used", "resets_at"]) refused(validateAssistantEvent(edit(started, (e) => delete e.allowance[member])), `missing ${member}`);
    refused(validateAssistantEvent(edit(started, (e) => (e.allowance.period = "2026-13"))), "does not match");
    refused(validateAssistantEvent(edit(started, (e) => (e.allowance.period = "2026-1"))), "does not match");
    refused(validateAssistantEvent(edit(started, (e) => (e.allowance.limit = -1))), "below minimum");
    refused(validateAssistantEvent(edit(started, (e) => (e.allowance.used = 1.5))), "expected integer");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance.period = "2026-13"))), "$.allowance: matches none of anyOf");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance.used = 301))), "$.allowance.used: 301 is over the limit of 300");
  });

  test("it resets with its month, not a day sooner or later", () => {
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance.resets_at = "2026-11-30T00:00:00Z"))), "is not the first instant after 2026-11");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance.resets_at = "2027-01-01T00:00:00Z"))), "is not the first instant after 2026-11");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance.resets_at = "2026-12-32T00:00:00Z"))), "not a calendar instant");
    expect(validateAssistantEvent(edit(status, (e) => (e.allowance.resets_at = "2026-12-01T00:00:00.000Z")))).toEqual([]);
  });
});

describe("assistant: usage summary", () => {
  const OTHER = edit(ANSWERED, (t) => ((t.task_id = "task-3"), (t.user = { kind: "user", id: "u-2", name: "Grace" }))) as AssistantTurn;
  const SUMMARY = summarizeAssistantUsage("ws-1", "2026-11", [TURN, ANSWERED, OTHER]);

  test("the usage of a workspace in a month is its tasks and their tokens, in total and per seat", () => {
    expect(SUMMARY).toEqual({
      contract: ASSISTANT_CONTRACT,
      workspace_id: "ws-1",
      period: "2026-11",
      tasks: 3,
      usage: { model_calls: 7, prompt_tokens: 19200, cached_tokens: 6100, completion_tokens: 434 },
      seats: [
        { user_id: "u-1", tasks: 2, usage: { model_calls: 5, prompt_tokens: 14200, cached_tokens: 6100, completion_tokens: 422 } },
        { user_id: "u-2", tasks: 1, usage: { model_calls: 2, prompt_tokens: 5000, cached_tokens: 0, completion_tokens: 12 } },
      ],
    });
    expect(validateAssistantUsageSummary(SUMMARY)).toEqual([]);
  });

  test("turns of another workspace or another month are not counted; a month is the one a task started in", () => {
    const elsewhere = edit(TURN, (t) => (t.workspace_id = "ws-2")) as AssistantTurn;
    const december = edit(TURN, (t) => ((t.started_at = "2026-12-01T00:00:00Z"), (t.finished_at = "2026-12-01T00:00:09Z"))) as AssistantTurn;
    const lastSecond = edit(TURN, (t) => ((t.started_at = "2026-11-30T23:59:59Z"), (t.finished_at = "2026-12-01T00:00:09Z"))) as AssistantTurn;
    expect(summarizeAssistantUsage("ws-1", "2026-11", [elsewhere, december]).tasks).toBe(0);
    expect(summarizeAssistantUsage("ws-1", "2026-11", [elsewhere, december]).seats).toEqual([]);
    expect(summarizeAssistantUsage("ws-1", "2026-11", [lastSecond]).tasks).toBe(1);
    expect(summarizeAssistantUsage("ws-1", "2026-12", [december, lastSecond]).tasks).toBe(1);
    expect(validateAssistantUsageSummary(summarizeAssistantUsage("ws-1", "2026-10", []))).toEqual([]);
  });

  test("the totals are the sums of the seats, and a seat appears once", () => {
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => (s.tasks = 4))), "$.tasks: is not the sum of the seats");
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => (s.usage.completion_tokens = 435))), "$.usage.completion_tokens: is not the sum of the seats");
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => (s.seats[1].user_id = "u-1"))), 'is listed twice');
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => ((s.seats[1].usage.cached_tokens = 5001), (s.usage.cached_tokens = 11101)))), "is more than the 5000 prompt tokens");
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => (s.period = "November"))), "does not match");
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => (s.seats[0].name = "Ada"))), "unexpected name");
    refused(validateAssistantUsageSummary(edit(SUMMARY, (s) => delete s.contract)), "missing contract");
  });
});

describe("assistant: server events", () => {
  for (const [type, event] of Object.entries(SERVER_EVENTS))
    test(`${type} is valid`, () => {
      expect(validateAssistantEvent(event)).toEqual([]);
    });

  test("a status says ready, not configured or out of tasks, and agrees with its allowance", () => {
    const status = SERVER_EVENTS["assistant.status"];
    expect(validateAssistantEvent(edit(status, (e) => ((e.state = "not_configured"), (e.model = null), (e.allowance = null))))).toEqual([]);
    refused(validateAssistantEvent(edit(status, (e) => (e.state = "not_configured"))), "an assistant that is not configured has no model");
    refused(validateAssistantEvent(edit(status, (e) => ((e.state = "not_configured"), (e.model = null)))), "an assistant that is not configured has no allowance");
    refused(validateAssistantEvent(edit(status, (e) => (e.model = null))), "a ready assistant names its model");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance = null))), "a ready assistant names the allowance of the seat");
    refused(validateAssistantEvent(edit(status, (e) => (e.state = "allowance_exhausted"))), "$.state: allowance_exhausted, with 12 used of 300");
    refused(validateAssistantEvent(edit(status, (e) => (e.allowance = SPENT))), "$.state: ready, with 300 used of 300");
    refused(validateAssistantEvent(edit(status, (e) => ((e.allowance = UNMETERED), (e.state = "allowance_exhausted")))), "with 4012 used of no limit");
    refused(validateAssistantEvent(edit(status, (e) => (e.state = "paused"))), "not in enum");
  });

  test("a started task is already counted, in the month it started", () => {
    const started = SERVER_EVENTS["assistant.task.started"];
    expect(validateAssistantEvent(edit(started, (e) => (e.allowance = SPENT)))).toEqual([]);
    expect(validateAssistantEvent(edit(started, (e) => (e.allowance = UNMETERED)))).toEqual([]);
    refused(validateAssistantEvent(edit(started, (e) => (e.allowance.used = 0))), "the allowance already counts the task");
    refused(validateAssistantEvent(edit(started, (e) => (e.started_at = "2026-12-01T00:00:00Z"))), "is not the month the task started in");
    refused(validateAssistantEvent(edit(started, (e) => (e.started_at = "2026-11-31T00:00:00Z"))), "not a calendar instant");
    refused(validateAssistantEvent(edit(started, (e) => delete e.conversation_id)), "missing conversation_id");
  });

  test("a step is announced running, then ok or failed; only a step that is ok opened a proposal", () => {
    const step = SERVER_EVENTS["assistant.step"];
    for (const status of ASSISTANT_STEP_STATUSES) expect(validateAssistantEvent(edit(step, (e) => (e.step.status = status)))).toEqual([]);
    expect(validateAssistantEvent(edit(step, (e) => Object.assign(e.step, { tool: "doc_edit", status: "ok", proposal_id: "prop-7" })))).toEqual([]);
    refused(validateAssistantEvent(edit(step, (e) => (e.step.proposal_id = "prop-7"))), "a step that is running opened no proposal");
    refused(validateAssistantEvent(edit(step, (e) => (e.step.step = 0))), "below minimum");
    refused(validateAssistantEvent(edit(step, (e) => delete e.step.doc_name)), "missing doc_name");
    expect(validateAssistantEvent(edit(step, (e) => Object.assign(e.step, { tool: "workspace_list", doc_name: null })))).toEqual([]);
  });

  test("text arrives in pieces that are not empty", () => {
    refused(validateAssistantEvent(edit(SERVER_EVENTS["assistant.text"], (e) => (e.delta = ""))), "too short");
    refused(validateAssistantEvent(edit(SERVER_EVENTS["assistant.text"], (e) => delete e.task_id)), "missing task_id");
  });

  test("a finished task carries its stored turn, checked like any turn", () => {
    const finished = SERVER_EVENTS["assistant.task.finished"];
    refused(validateAssistantEvent(edit(finished, (e) => (e.task_id = "task-9"))), "$.turn.task_id: is not the task of the event");
    refused(validateAssistantEvent(edit(finished, (e) => (e.turn.proposal_ids = []))), "$.turn.proposal_ids: are not the proposals its steps opened");
    refused(validateAssistantEvent(edit(finished, (e) => (e.turn.usage.cached_tokens = 99999))), "$.turn.usage.cached_tokens");
    refused(validateAssistantEvent(edit(finished, (e) => delete e.turn.usage)), "missing usage");
  });

  test("a conversation lists its own turns once each, oldest first; no conversation has none", () => {
    const conversation = SERVER_EVENTS["assistant.conversation"];
    expect(validateAssistantEvent(edit(conversation, (e) => ((e.conversation_id = null), (e.turns = []))))).toEqual([]);
    expect(validateAssistantEvent(edit(conversation, (e) => (e.turns = [])))).toEqual([]);
    refused(validateAssistantEvent(edit(conversation, (e) => (e.conversation_id = null))), "no conversation has no turns");
    refused(validateAssistantEvent(edit(conversation, (e) => (e.turns[1].conversation_id = "conv-2"))), "$.turns[1].conversation_id: is not the conversation of the event");
    refused(validateAssistantEvent(edit(conversation, (e) => (e.turns[1].task_id = "task-1"))), "is listed twice");
    refused(validateAssistantEvent(edit(conversation, (e) => e.turns.reverse())), "$.turns[1].started_at: is before the turn it follows");
    refused(validateAssistantEvent(edit(conversation, (e) => (e.turns[0].outcome = "answered"))), "$.turns[0].outcome: an answered task opened no proposal");
  });

  test("every error code is valid; a used-up allowance is its own error and carries the allowance", () => {
    const error = SERVER_EVENTS["assistant.error"];
    for (const code of ASSISTANT_ERROR_CODES) expect(validateAssistantEvent(edit(error, (e) => (e.code = code)))).toEqual([]);
    expect(validateAssistantEvent(edit(error, (e) => (e.request_id = null)))).toEqual([]);
    refused(validateAssistantEvent(edit(error, (e) => (e.code = "REVISION_MISMATCH"))), "not in enum");
    refused(validateAssistantEvent(edit(error, (e) => (e.allowance = SPENT))), "unexpected allowance");
    expect(validateAssistantEvent(EXHAUSTED)).toEqual([]);
    refused(validateAssistantEvent(edit(EXHAUSTED, (e) => delete e.allowance)), "missing allowance");
    refused(validateAssistantEvent(edit(EXHAUSTED, (e) => (e.allowance = ALLOWANCE))), "has tasks left, the allowance is not exhausted");
    refused(validateAssistantEvent(edit(EXHAUSTED, (e) => (e.allowance = UNMETERED))), "has tasks left, the allowance is not exhausted");
    refused(validateAssistantEvent(edit(EXHAUSTED, (e) => (e.allowance.resets_at = "2026-12-02T00:00:00Z"))), "is not the first instant after 2026-11");
  });

  test("an unknown or missing type, a room event, an extra member and a non-object are refused", () => {
    refused(validateAssistantEvent({ type: "assistant.deleted" }), "is not an assistant server event");
    refused(validateAssistantEvent({ type: "assistant.ask", request_id: "req-1" }), "is not an assistant server event");
    refused(validateAssistantEvent({ type: "agent.activity", seq: 1 }), "is not an assistant server event");
    refused(validateAssistantEvent({ type: "constructor" }), "is not an assistant server event");
    refused(validateAssistantEvent({ type: "__proto__" }), "is not an assistant server event");
    refused(validateAssistantEvent({ task_id: "task-1" }), "is not an assistant server event");
    refused(validateAssistantEvent(edit(SERVER_EVENTS["assistant.text"], (e) => (e.seq = 1))), "unexpected seq");
    refused(validateAssistantEvent("assistant.text"), "expected object");
    refused(validateAssistantEvent(null), "expected object");
  });
});

describe("assistant: client messages", () => {
  for (const [type, message] of Object.entries(CLIENT_MESSAGES))
    test(`${type} is valid`, () => {
      expect(validateAssistantClientMessage(message)).toEqual([]);
    });

  test("an ask continues a conversation or starts one, about a document and a selection or neither", () => {
    const ask = CLIENT_MESSAGES["assistant.ask"];
    expect(validateAssistantClientMessage(edit(ask, (m) => Object.assign(m, { conversation_id: "conv-1", doc_name: null, target_address: "para:~2a9256c0" })))).toEqual([]);
    for (const member of Object.keys(ask)) {
      if (member !== "type") refused(validateAssistantClientMessage(edit(ask, (m) => delete m[member])), `missing ${member}`);
    }
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.text = ""))), "too short");
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.doc_name = ""))), "matches none of anyOf");
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.conversation_id = "conv 1"))), "matches none of anyOf");
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.mode = "commit"))), "unexpected mode");
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.model = "another-model"))), "unexpected model");
  });

  test("an ask is at most the documented length", () => {
    const ask = CLIENT_MESSAGES["assistant.ask"];
    expect(validateAssistantClientMessage(edit(ask, (m) => (m.text = "x".repeat(ASSISTANT_REQUEST_MAX_CHARS))))).toEqual([]);
    refused(validateAssistantClientMessage(edit(ask, (m) => (m.text = "x".repeat(ASSISTANT_REQUEST_MAX_CHARS + 1)))), "$.text: longer than 16000 characters");
  });

  test("cancel names a task, history a conversation or null, and every message a request id", () => {
    refused(validateAssistantClientMessage(edit(CLIENT_MESSAGES["assistant.cancel"], (m) => delete m.task_id)), "missing task_id");
    refused(validateAssistantClientMessage(edit(CLIENT_MESSAGES["assistant.history"], (m) => delete m.conversation_id)), "missing conversation_id");
    expect(validateAssistantClientMessage(edit(CLIENT_MESSAGES["assistant.history"], (m) => (m.conversation_id = "conv-1")))).toEqual([]);
    for (const message of Object.values(CLIENT_MESSAGES)) {
      refused(validateAssistantClientMessage(edit(message, (m) => delete m.request_id)), "missing request_id");
      refused(validateAssistantClientMessage(edit(message, (m) => (m.request_id = ""))), "does not match");
    }
  });

  test("an unknown or missing type, a room message, a server event and a non-object are refused", () => {
    refused(validateAssistantClientMessage({ type: "assistant.approve", request_id: "req-1" }), "is not an assistant client message");
    refused(validateAssistantClientMessage({ type: "proposal.decide", request_id: "req-1", proposal_id: "prop-7", decision: "approve" }), "is not an assistant client message");
    refused(validateAssistantClientMessage(SERVER_EVENTS["assistant.text"]), "is not an assistant client message");
    refused(validateAssistantClientMessage({ type: "toString" }), "is not an assistant client message");
    refused(validateAssistantClientMessage({ request_id: "req-1" }), "is not an assistant client message");
    refused(validateAssistantClientMessage([]), "expected object");
    refused(validateAssistantClientMessage(undefined), "expected object");
  });
});
