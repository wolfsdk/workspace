// The Workspace assistant (`wolfsdk.assistant.v1`): the panel beside a document where a signed-in user asks
// for a change, and the assistant makes it with the tools of `wolfsdk.mcp-workspace.v1`. This module holds the
// messages a server exchanges with that user's connection, the turn a server stores for every finished task,
// and the usage of a workspace in a month. The assistant never commits: every change it makes is a proposal of
// the room, decided by a user. Assistant messages travel beside `wolfsdk.room.v1`, never inside it, and
// assistant events go only to the connection that asked. Nothing here touches the DOM, Preact or a kernel. The
// schema checks the shape of every value; the functions below add what a schema can not say (steps are
// numbered, proposals agree with steps, an allowance resets with its month).
import { validateSchema, type Schema } from "../session/record.ts";
import assistantSchema from "../../schemas/assistant.v1.schema.json" with { type: "json" };
import { MCP_WORKSPACE_TOOL_NAMES, type McpWorkspaceToolName } from "./mcp.ts";
import { isWorkspaceInstant } from "./room.ts";

export const ASSISTANT_CONTRACT = "wolfsdk.assistant.v1";
export const ASSISTANT_SCHEMA: Schema = assistantSchema;

/** The tools a step can name: the eight of `wolfsdk.mcp-workspace.v1`. */
export const ASSISTANT_TOOL_NAMES = MCP_WORKSPACE_TOOL_NAMES;

/** The longest request a user can send, in UTF-16 code units (`maxLength` of the schema). */
export const ASSISTANT_REQUEST_MAX_CHARS = 16_000;

/** How a task ended. `proposed`: it opened at least one proposal. `answered`: it answered without changing
 * anything. `cancelled`: the user stopped it. `failed`: the model or the server could not finish it.
 * `turn_limit` and `token_limit`: it reached a cap of the server. A task that ended any other way than
 * `answered` may still have opened proposals. */
export const ASSISTANT_OUTCOMES = ["answered", "proposed", "cancelled", "failed", "turn_limit", "token_limit"] as const;
export type AssistantOutcome = (typeof ASSISTANT_OUTCOMES)[number];

export const ASSISTANT_STEP_STATUSES = ["running", "ok", "failed"] as const;
export type AssistantStepStatus = (typeof ASSISTANT_STEP_STATUSES)[number];

/** `ready`: a request will be taken. `not_configured`: the server has no model endpoint.
 * `allowance_exhausted`: the seat has used its tasks for the month. */
export const ASSISTANT_STATES = ["ready", "not_configured", "allowance_exhausted"] as const;
export type AssistantState = (typeof ASSISTANT_STATES)[number];

/** `code` of an `assistant.error` event that is not an exhausted allowance. */
export const ASSISTANT_ERROR_CODES = ["BAD_REQUEST", "NOT_IN_ROOM", "NOT_CONFIGURED", "FORBIDDEN", "BUSY", "UNKNOWN_TASK", "UNKNOWN_CONVERSATION"] as const;
export type AssistantErrorCode = (typeof ASSISTANT_ERROR_CODES)[number];

/** `code` of the `assistant.error` event that refuses an ask at the limit of the allowance. The assistant
 * stops until the allowance resets; editing, review, comments and outside agents continue. */
export const ASSISTANT_ALLOWANCE_EXHAUSTED = "ALLOWANCE_EXHAUSTED";

export const ASSISTANT_SERVER_EVENT_TYPES = [
  "assistant.status",
  "assistant.task.started",
  "assistant.step",
  "assistant.text",
  "assistant.task.finished",
  "assistant.conversation",
  "assistant.error",
] as const;
export type AssistantServerEventType = (typeof ASSISTANT_SERVER_EVENT_TYPES)[number];

export const ASSISTANT_CLIENT_MESSAGE_TYPES = ["assistant.status", "assistant.ask", "assistant.cancel", "assistant.history"] as const;
export type AssistantClientMessageType = (typeof ASSISTANT_CLIENT_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssistantUser = { kind: "user"; id: string; name: string };
export type AssistantAgent = { kind: "agent"; id: string; name: string };

/** One tool call of a task. A server announces a step when it starts and again when it ends, under the same
 * number. */
export type AssistantStep = {
  /** 1-based position among the steps of the task. */
  step: number;
  tool: McpWorkspaceToolName;
  doc_name: string | null;
  status: AssistantStepStatus;
  /** One line a person can read: what was read, changed or refused. */
  summary?: string;
  /** The proposal of the room this step opened. */
  proposal_id?: string;
};

export type AssistantRequest = {
  text: string;
  /** The document open beside the panel. */
  doc_name: string | null;
  /** The selection in that document, as an Agent API address. */
  target_address: string | null;
};

/** Tokens of the chat-completions calls of a task, or of tasks summed. `cached_tokens` is the part of
 * `prompt_tokens` the provider served from its prompt cache. */
export type AssistantUsage = { model_calls: number; prompt_tokens: number; cached_tokens: number; completion_tokens: number };

/** The assistant tasks of one seat in one calendar month (UTC). A task counts when its first model call is
 * made. `limit` is null when the server does not meter. */
export type AssistantAllowance = { period: string; limit: number | null; used: number; resets_at: string };

/** One finished task, as a server stores it. */
export type AssistantTurn = {
  contract: typeof ASSISTANT_CONTRACT;
  task_id: string;
  /** The tasks of one conversation are the context of the next. */
  conversation_id: string;
  room_id: string;
  workspace_id: string;
  /** Who asked, and whose seat the task counts against. */
  user: AssistantUser;
  /** The agent actor the assistant acted as in the room: the author of its proposals. */
  assistant: AssistantAgent;
  request: AssistantRequest;
  outcome: AssistantOutcome;
  /** Empty when the assistant gave no text. */
  answer: string;
  /** Why the task failed, for outcome `failed`; null otherwise. */
  failure: string | null;
  steps: AssistantStep[];
  /** The proposals the task opened, in the order of the steps that opened them. */
  proposal_ids: string[];
  model: string;
  usage: AssistantUsage;
  started_at: string;
  finished_at: string;
};

export type AssistantSeatUsage = { user_id: string; tasks: number; usage: AssistantUsage };

/** The assistant usage of one workspace in one calendar month: its counted tasks and their tokens, in total
 * and per seat. */
export type AssistantUsageSummary = {
  contract: typeof ASSISTANT_CONTRACT;
  workspace_id: string;
  period: string;
  tasks: number;
  usage: AssistantUsage;
  seats: AssistantSeatUsage[];
};

export type AssistantServerEvent =
  | { type: "assistant.status"; request_id: string; state: AssistantState; model: string | null; allowance: AssistantAllowance | null }
  | {
      type: "assistant.task.started";
      request_id: string;
      task_id: string;
      conversation_id: string;
      /** The allowance with this task already counted. */
      allowance: AssistantAllowance;
      started_at: string;
    }
  | { type: "assistant.step"; task_id: string; step: AssistantStep }
  | { type: "assistant.text"; task_id: string; delta: string }
  | { type: "assistant.task.finished"; task_id: string; turn: AssistantTurn }
  | { type: "assistant.conversation"; request_id: string; conversation_id: string | null; turns: AssistantTurn[] }
  | { type: "assistant.error"; request_id: string | null; code: typeof ASSISTANT_ALLOWANCE_EXHAUSTED; message: string; allowance: AssistantAllowance }
  | { type: "assistant.error"; request_id: string | null; code: AssistantErrorCode; message: string };

export type AssistantClientMessage =
  | { type: "assistant.status"; request_id: string }
  | {
      type: "assistant.ask";
      request_id: string;
      /** The conversation to continue, or null to start one. */
      conversation_id: string | null;
      text: string;
      doc_name: string | null;
      target_address: string | null;
    }
  | { type: "assistant.cancel"; request_id: string; task_id: string }
  /** The stored turns of a conversation of this user in the room, or of the latest one with null. */
  | { type: "assistant.history"; request_id: string; conversation_id: string | null };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function validateDef(def: string, value: unknown): string[] {
  return validateSchema({ $defs: ASSISTANT_SCHEMA.$defs, $ref: `#/$defs/${def}` }, value);
}

/** The month (`2026-11`) an instant falls in, in UTC. */
export function assistantPeriod(instant: string): string {
  return instant.slice(0, 7);
}

/** The first instant of the month after `period`: when an allowance of that month resets. */
export function assistantPeriodEnd(period: string): string {
  const [year = 0, month = 0] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().replace(".000Z", "Z");
}

function requestTextProblems(path: string, text: string, out: string[]): void {
  if (text.length > ASSISTANT_REQUEST_MAX_CHARS) out.push(`${path}: longer than ${ASSISTANT_REQUEST_MAX_CHARS} characters`);
}

function usageProblems(path: string, usage: AssistantUsage, out: string[]): void {
  if (usage.cached_tokens > usage.prompt_tokens) out.push(`${path}.cached_tokens: ${usage.cached_tokens} is more than the ${usage.prompt_tokens} prompt tokens`);
}

function allowanceProblems(path: string, a: AssistantAllowance, out: string[]): void {
  if (!isWorkspaceInstant(a.resets_at)) out.push(`${path}.resets_at: not a calendar instant`);
  else if (Date.parse(a.resets_at) !== Date.parse(assistantPeriodEnd(a.period))) out.push(`${path}.resets_at: is not the first instant after ${a.period}`);
  if (a.limit !== null && a.used > a.limit) out.push(`${path}.used: ${a.used} is over the limit of ${a.limit}`);
}

const exhausted = (a: AssistantAllowance): boolean => a.limit !== null && a.used >= a.limit;

function stepProblems(path: string, s: AssistantStep, out: string[]): void {
  if (s.proposal_id !== undefined && s.status !== "ok") out.push(`${path}.proposal_id: a step that is ${s.status} opened no proposal`);
}

/** What a schema can not say about a turn of the right shape. */
function turnProblems(path: string, t: AssistantTurn, out: string[]): void {
  requestTextProblems(`${path}.request.text`, t.request.text, out);
  usageProblems(`${path}.usage`, t.usage, out);
  if (t.usage.model_calls < 1) out.push(`${path}.usage.model_calls: a task is counted at its first model call`);

  const started = isWorkspaceInstant(t.started_at);
  const finished = isWorkspaceInstant(t.finished_at);
  if (!started) out.push(`${path}.started_at: not a calendar instant`);
  if (!finished) out.push(`${path}.finished_at: not a calendar instant`);
  if (started && finished && Date.parse(t.finished_at) < Date.parse(t.started_at)) out.push(`${path}.finished_at: is before started_at`);

  const opened: string[] = [];
  t.steps.forEach((s, i) => {
    const at = `${path}.steps[${i}]`;
    if (s.step !== i + 1) out.push(`${at}.step: ${s.step} does not follow ${i}`);
    if (s.status === "running") out.push(`${at}.status: a finished task has no running step`);
    stepProblems(at, s, out);
    if (s.proposal_id !== undefined) opened.push(s.proposal_id);
  });
  if (new Set(t.proposal_ids).size !== t.proposal_ids.length) out.push(`${path}.proposal_ids: a proposal is listed twice`);
  if (opened.length !== t.proposal_ids.length || opened.some((id, i) => id !== t.proposal_ids[i]))
    out.push(`${path}.proposal_ids: are not the proposals its steps opened, in order`);

  if (t.outcome === "proposed" && t.proposal_ids.length === 0) out.push(`${path}.outcome: a proposed task opened at least one proposal`);
  if (t.outcome === "answered" && t.proposal_ids.length > 0) out.push(`${path}.outcome: an answered task opened no proposal`);
  if (t.outcome === "answered" && t.answer === "") out.push(`${path}.answer: an answered task has an answer`);
  if ((t.outcome === "failed") !== (t.failure !== null)) out.push(`${path}.failure: is set exactly when the outcome is failed`);
}

/** Problems of a stored turn `wolfsdk.assistant.v1` (empty when valid): its shape, then the agreement of its
 * steps, proposals, outcome, usage and times. */
export function validateAssistantTurn(turn: unknown): string[] {
  const out = validateSchema(ASSISTANT_SCHEMA, turn);
  if (out.length === 0) turnProblems("$", turn as AssistantTurn, out);
  return out;
}

const sumUsage = (parts: AssistantUsage[]): AssistantUsage =>
  parts.reduce(
    (sum, u) => ({
      model_calls: sum.model_calls + u.model_calls,
      prompt_tokens: sum.prompt_tokens + u.prompt_tokens,
      cached_tokens: sum.cached_tokens + u.cached_tokens,
      completion_tokens: sum.completion_tokens + u.completion_tokens,
    }),
    { model_calls: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 },
  );

/** The usage of `turns` as one summary: the turns of `workspaceId` that started in `period`, per seat in the
 * order each seat first appears. */
export function summarizeAssistantUsage(workspaceId: string, period: string, turns: readonly AssistantTurn[]): AssistantUsageSummary {
  const bySeat = new Map<string, AssistantTurn[]>();
  for (const t of turns) {
    if (t.workspace_id !== workspaceId || assistantPeriod(t.started_at) !== period) continue;
    const seat = bySeat.get(t.user.id);
    if (seat) seat.push(t);
    else bySeat.set(t.user.id, [t]);
  }
  const seats = [...bySeat].map(([user_id, own]) => ({ user_id, tasks: own.length, usage: sumUsage(own.map((t) => t.usage)) }));
  return {
    contract: ASSISTANT_CONTRACT,
    workspace_id: workspaceId,
    period,
    tasks: seats.reduce((n, s) => n + s.tasks, 0),
    usage: sumUsage(seats.map((s) => s.usage)),
    seats,
  };
}

/** Problems of a usage summary `wolfsdk.assistant.v1` (empty when valid): its shape, then that every seat
 * appears once and the totals are the sums of the seats. */
export function validateAssistantUsageSummary(summary: unknown): string[] {
  const out = validateDef("usageSummary", summary);
  if (out.length > 0) return out;
  const s = summary as AssistantUsageSummary;
  const seen = new Set<string>();
  s.seats.forEach((seat, i) => {
    if (seen.has(seat.user_id)) out.push(`$.seats[${i}].user_id: ${JSON.stringify(seat.user_id)} is listed twice`);
    seen.add(seat.user_id);
    usageProblems(`$.seats[${i}].usage`, seat.usage, out);
  });
  if (s.tasks !== s.seats.reduce((n, seat) => n + seat.tasks, 0)) out.push("$.tasks: is not the sum of the seats");
  const total = sumUsage(s.seats.map((seat) => seat.usage));
  for (const key of ["model_calls", "prompt_tokens", "cached_tokens", "completion_tokens"] as const)
    if (s.usage[key] !== total[key]) out.push(`$.usage.${key}: is not the sum of the seats`);
  return out;
}

const SERVER_EVENT_DEF: Record<Exclude<AssistantServerEventType, "assistant.error">, string> = {
  "assistant.status": "ev_status",
  "assistant.task.started": "ev_task_started",
  "assistant.step": "ev_step",
  "assistant.text": "ev_text",
  "assistant.task.finished": "ev_task_finished",
  "assistant.conversation": "ev_conversation",
};

const CLIENT_MESSAGE_DEF: Record<AssistantClientMessageType, string> = {
  "assistant.status": "msg_status",
  "assistant.ask": "msg_ask",
  "assistant.cancel": "msg_cancel",
  "assistant.history": "msg_history",
};

function serverEventDef(event: Record<string, unknown>): string | undefined {
  const { type } = event;
  if (type === "assistant.error") return event.code === ASSISTANT_ALLOWANCE_EXHAUSTED ? "ev_allowance_exhausted" : "ev_error";
  return typeof type === "string" && Object.hasOwn(SERVER_EVENT_DEF, type)
    ? SERVER_EVENT_DEF[type as Exclude<AssistantServerEventType, "assistant.error">]
    : undefined;
}

/** What a schema can not say about one server event of the right shape. */
function eventProblems(def: string, event: Record<string, unknown>, out: string[]): void {
  switch (def) {
    case "ev_status": {
      const e = event as Extract<AssistantServerEvent, { type: "assistant.status" }>;
      if (e.state === "not_configured") {
        if (e.model !== null) out.push("$.model: an assistant that is not configured has no model");
        if (e.allowance !== null) out.push("$.allowance: an assistant that is not configured has no allowance");
        return;
      }
      if (e.model === null) out.push(`$.model: a ${e.state} assistant names its model`);
      if (e.allowance === null) return void out.push(`$.allowance: a ${e.state} assistant names the allowance of the seat`);
      allowanceProblems("$.allowance", e.allowance, out);
      if ((e.state === "allowance_exhausted") !== exhausted(e.allowance))
        out.push(`$.state: ${e.state}, with ${e.allowance.used} used of ${e.allowance.limit === null ? "no limit" : e.allowance.limit}`);
      return;
    }
    case "ev_task_started": {
      const e = event as Extract<AssistantServerEvent, { type: "assistant.task.started" }>;
      allowanceProblems("$.allowance", e.allowance, out);
      if (e.allowance.used < 1) out.push("$.allowance.used: the allowance already counts the task");
      if (!isWorkspaceInstant(e.started_at)) out.push("$.started_at: not a calendar instant");
      else if (assistantPeriod(e.started_at) !== e.allowance.period) out.push("$.allowance.period: is not the month the task started in");
      return;
    }
    case "ev_step":
      stepProblems("$.step", (event as Extract<AssistantServerEvent, { type: "assistant.step" }>).step, out);
      return;
    case "ev_task_finished": {
      const e = event as Extract<AssistantServerEvent, { type: "assistant.task.finished" }>;
      if (e.turn.task_id !== e.task_id) out.push("$.turn.task_id: is not the task of the event");
      turnProblems("$.turn", e.turn, out);
      return;
    }
    case "ev_conversation": {
      const e = event as Extract<AssistantServerEvent, { type: "assistant.conversation" }>;
      if (e.conversation_id === null && e.turns.length > 0) out.push("$.turns: no conversation has no turns");
      const tasks = new Set<string>();
      e.turns.forEach((t, i) => {
        const at = `$.turns[${i}]`;
        if (e.conversation_id !== null && t.conversation_id !== e.conversation_id) out.push(`${at}.conversation_id: is not the conversation of the event`);
        if (tasks.has(t.task_id)) out.push(`${at}.task_id: ${JSON.stringify(t.task_id)} is listed twice`);
        tasks.add(t.task_id);
        const before = e.turns[i - 1];
        if (before && Date.parse(t.started_at) < Date.parse(before.started_at)) out.push(`${at}.started_at: is before the turn it follows`);
        turnProblems(at, t, out);
      });
      return;
    }
    case "ev_allowance_exhausted": {
      const { allowance } = event as { allowance: AssistantAllowance };
      allowanceProblems("$.allowance", allowance, out);
      if (!exhausted(allowance)) out.push("$.allowance: has tasks left, the allowance is not exhausted");
      return;
    }
  }
}

/** Problems of one server event of the assistant (empty when valid). The event is checked against the shape
 * its `type` (and, for `assistant.error`, its `code`) names. */
export function validateAssistantEvent(event: unknown): string[] {
  if (!isObject(event)) return ["$: expected object"];
  const def = serverEventDef(event);
  if (!def) return [`$.type: ${JSON.stringify(event.type)} is not an assistant server event`];
  const out = validateDef(def, event);
  if (out.length === 0) eventProblems(def, event, out);
  return out;
}

/** Problems of one client message of the assistant (empty when valid). */
export function validateAssistantClientMessage(message: unknown): string[] {
  if (!isObject(message)) return ["$: expected object"];
  const { type } = message;
  const def =
    typeof type === "string" && Object.hasOwn(CLIENT_MESSAGE_DEF, type) ? CLIENT_MESSAGE_DEF[type as AssistantClientMessageType] : undefined;
  if (!def) return [`$.type: ${JSON.stringify(type)} is not an assistant client message`];
  const out = validateDef(def, message);
  if (out.length === 0 && def === "msg_ask") requestTextProblems("$.text", (message as AssistantClientMessage & { type: "assistant.ask" }).text, out);
  return out;
}

/** Whether a parsed message of a connection belongs to this contract rather than to `wolfsdk.room.v1`: its
 * `type` begins `assistant.`. A server routes on this before it validates. */
export function isAssistantMessage(message: unknown): boolean {
  return isObject(message) && typeof message.type === "string" && message.type.startsWith("assistant.");
}
