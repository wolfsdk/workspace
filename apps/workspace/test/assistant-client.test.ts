// The assistant panel's state without Preact: event sequences of `wolfsdk.assistant.v1` in, the view out, and every
// message the page sends checked against the contract. Time is a fake clock the tests move by hand.
import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_CONTRACT,
  ASSISTANT_REQUEST_MAX_CHARS,
  type AssistantAllowance,
  type AssistantClientMessage,
  type AssistantServerEvent,
  type AssistantTurn,
  validateAssistantClientMessage,
  validateAssistantEvent,
} from "@wolfsdk/protocol/workspace";
import {
  applyAssistantEvent,
  ASSISTANT_RESET_SLACK_MS,
  askMessage,
  type AssistantClock,
  AssistantSession,
  assistantShown,
  cancelMessage,
  canAsk,
  EMPTY_ASSISTANT,
  historyMessage,
  proposalsOpened,
  statusMessage,
} from "../src/lib/assistant-client.ts";

const T0 = "2026-11-14T08:00:00Z";
const T1 = "2026-11-14T09:00:00Z";
const T2 = "2026-11-14T09:00:41Z";
const ALLOWANCE: AssistantAllowance = { period: "2026-11", limit: 300, used: 12, resets_at: "2026-12-01T00:00:00Z" };
const SPENT: AssistantAllowance = { ...ALLOWANCE, used: 300 };
const DECEMBER: AssistantAllowance = { period: "2026-12", limit: 300, used: 0, resets_at: "2027-01-01T00:00:00Z" };
const MODEL = "deepseek-v4.1-flash";
const REQUEST = { text: "Tighten the summary", doc_name: "memo.docx", target_address: "/body/p[2]" };
/** The longest delay a browser timer keeps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function turn(over: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    contract: ASSISTANT_CONTRACT,
    task_id: "task-1",
    conversation_id: "conv-1",
    room_id: "q3-close",
    workspace_id: "default",
    user: { kind: "user", id: "alice", name: "Alice Chen" },
    assistant: { kind: "agent", id: "assistant:alice", name: "Assistant" },
    request: REQUEST,
    outcome: "proposed",
    answer: "I shortened the summary.",
    failure: null,
    steps: [
      { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok", summary: "Read the structure of memo.docx" },
      { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" },
    ],
    proposal_ids: ["prop-7"],
    model: MODEL,
    usage: { model_calls: 3, prompt_tokens: 9200, cached_tokens: 6100, completion_tokens: 410 },
    started_at: T1,
    finished_at: T2,
    ...over,
  };
}

const EARLIER = turn({
  task_id: "task-0",
  request: { text: "How many tables are there?", doc_name: "memo.docx", target_address: null },
  outcome: "answered",
  answer: "Two.",
  steps: [{ step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok" }],
  proposal_ids: [],
  started_at: T0,
  finished_at: T0,
});

/** A clock that moves only when a test moves it. `advance` runs every timer that falls due on the way, in order. */
type FakeClock = AssistantClock & {
  /** Every delay a timer was set for, in order. */
  delays: number[];
  /** When each armed timer falls due, in milliseconds. */
  armed(): number[];
  advance(ms: number): void;
};

function fakeClock(start = T1): FakeClock {
  let now = Date.parse(start);
  let ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const delays: number[] = [];
  return {
    now: () => now,
    setTimer(run, ms) {
      delays.push(ms);
      timers.set(++ids, { at: now + ms, run });
      return ids;
    },
    clearTimer: (timer) => void timers.delete(timer as number),
    delays,
    armed: () => [...timers.values()].map((t) => t.at),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = end;
    },
  };
}

/** A session on a fake socket, the messages it wrote, and the events it hears. */
type Harness = {
  session: AssistantSession;
  sent: AssistantClientMessage[];
  /** Set `offline` to make the socket refuse what is written. */
  socket: { offline: boolean };
  clock: FakeClock;
  deliver: (event: AssistantServerEvent) => void;
  last: () => AssistantClientMessage;
};

/** A session on a fake socket and a fake clock: every message it writes must pass the contract, and `offline` makes
 * the socket refuse. */
function harness(clock = fakeClock()): Harness {
  const sent: AssistantClientMessage[] = [];
  const socket = { offline: false };
  const session = new AssistantSession(
    (message) => {
      expect(validateAssistantClientMessage(message)).toEqual([]);
      if (socket.offline) return false;
      sent.push(message);
      return true;
    },
    () => undefined,
    clock,
  );
  /** Deliver one server event; a valid one is checked against the contract first, so the fixtures stay honest. */
  const deliver = (event: AssistantServerEvent): void => {
    expect(validateAssistantEvent(event)).toEqual([]);
    session.receive(event);
  };
  const last = (): AssistantClientMessage => sent.at(-1)!;
  return { session, sent, socket, clock, deliver, last };
}

/** Live, then `allowance` (ready, or exhausted when used up), then the conversation the server has. */
function ready(h: Harness, turns: AssistantTurn[] = [], allowance = ALLOWANCE): void {
  h.session.connection("live");
  const state = allowance.limit !== null && allowance.used >= allowance.limit ? "allowance_exhausted" : "ready";
  h.deliver({ type: "assistant.status", request_id: h.last().request_id, state, model: MODEL, allowance });
  h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: turns[0]?.conversation_id ?? null, turns });
}

/** Ask, and have the server take the ask as `task-1` of `conv-1`. Returns the ask's `request_id`. */
function started(h: Harness): string {
  expect(h.session.ask(REQUEST)).toBe(true);
  const ask = h.last();
  h.deliver({ type: "assistant.task.started", request_id: ask.request_id, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: T1 });
  return ask.request_id;
}

const types = (messages: AssistantClientMessage[]): string[] => messages.map((m) => m.type);

describe("the assistant status", () => {
  test("going live asks for the status; a ready status asks for the latest conversation, which a reload restores", () => {
    const h = harness();
    h.session.connection("connecting");
    expect(h.sent).toEqual([]);
    expect(assistantShown(h.session.view)).toBe(false);

    h.session.connection("live");
    expect(types(h.sent)).toEqual(["assistant.status"]);
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "ready", model: MODEL, allowance: ALLOWANCE });
    expect(h.session.view).toMatchObject({ state: "ready", model: MODEL, allowance: ALLOWANCE });
    expect(h.last()).toMatchObject({ type: "assistant.history", conversation_id: null });

    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER, turn()] });
    expect(h.session.view.conversation_id).toBe("conv-1");
    expect(h.session.view.turns.map((t) => t.task_id)).toEqual(["task-0", "task-1"]);
    expect(assistantShown(h.session.view)).toBe(true);
    expect(canAsk(h.session.view)).toBe(true);
    // The next ask continues that conversation.
    h.session.ask(REQUEST);
    expect(h.last()).toMatchObject({ type: "assistant.ask", conversation_id: "conv-1" });
  });

  test("not_configured: no panel, and no conversation is asked for", () => {
    const h = harness();
    h.session.connection("live");
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "not_configured", model: null, allowance: null });
    expect(types(h.sent)).toEqual(["assistant.status"]);
    expect(assistantShown(h.session.view)).toBe(false);
    expect(canAsk(h.session.view)).toBe(false);
    expect(h.session.ask(REQUEST)).toBe(false);
    expect(h.sent).toHaveLength(1);
    // With no allowance there is no month to wait for.
    expect(h.clock.armed()).toEqual([]);
  });

  test("allowance_exhausted: the conversation still comes back, and nothing can be asked", () => {
    const h = harness();
    h.session.connection("live");
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "allowance_exhausted", model: MODEL, allowance: SPENT });
    expect(h.last()).toMatchObject({ type: "assistant.history", conversation_id: null });
    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER] });
    expect(assistantShown(h.session.view)).toBe(true);
    expect(h.session.view.turns).toEqual([EARLIER]);
    expect(h.session.ask(REQUEST)).toBe(false);
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history"]);
  });
});

describe("the month of the allowance", () => {
  test("a panel left open at the limit asks for the status when the UTC month ends, and takes requests in the new month", () => {
    const h = harness(fakeClock("2026-11-30T23:00:00Z"));
    ready(h, [EARLIER], SPENT);
    expect(canAsk(h.session.view)).toBe(false);
    expect(h.clock.armed()).toEqual([Date.parse(SPENT.resets_at) + ASSISTANT_RESET_SLACK_MS]);

    // One hour later the month has ended, but this page waits a little for a server clock behind its own.
    h.clock.advance(60 * 60 * 1000);
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history"]);
    h.clock.advance(ASSISTANT_RESET_SLACK_MS);
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history", "assistant.status"]);

    // The answer names the new month: the panel takes requests again, with the conversation it had, and asks for
    // no conversation (the one on show is current).
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "ready", model: MODEL, allowance: DECEMBER });
    expect(h.session.view).toMatchObject({ state: "ready", allowance: DECEMBER, conversation_id: "conv-1", turns: [EARLIER], problem: null });
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history", "assistant.status"]);
    expect(canAsk(h.session.view)).toBe(true);
    expect(h.session.ask(REQUEST)).toBe(true);
    expect(h.last()).toMatchObject({ type: "assistant.ask", conversation_id: "conv-1" });
    // And it waits toward the end of the new month: a month away, so the first step of a far wait.
    expect(h.clock.armed()).toEqual([h.clock.now() + MAX_TIMER_MS]);
  });

  test("a status that still names the old month, or a socket that does not take the question, asks again after the slack, never in a loop", () => {
    const h = harness(fakeClock("2026-11-30T23:59:00Z"));
    ready(h, [], SPENT);
    h.clock.advance(60_000 + ASSISTANT_RESET_SLACK_MS);
    const asked = h.last();
    expect(asked.type).toBe("assistant.status");

    // The server's clock is further behind: it still says November.
    h.deliver({ type: "assistant.status", request_id: asked.request_id, state: "allowance_exhausted", model: MODEL, allowance: SPENT });
    h.clock.advance(ASSISTANT_RESET_SLACK_MS - 1);
    expect(h.last()).toBe(asked);
    h.clock.advance(1);
    expect(h.last()).not.toBe(asked);
    expect(h.last().type).toBe("assistant.status");

    // The socket refuses the next question: it is asked again after the slack, not at once.
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "allowance_exhausted", model: MODEL, allowance: SPENT });
    h.socket.offline = true;
    const before = h.sent.length;
    h.clock.advance(ASSISTANT_RESET_SLACK_MS);
    expect(h.session.view.problem?.code).toBe("OFFLINE");
    expect(h.clock.delays.filter((ms) => ms <= 0)).toEqual([]);
    expect(h.clock.armed()).toEqual([h.clock.now() + ASSISTANT_RESET_SLACK_MS]);
    h.socket.offline = false;
    h.clock.advance(ASSISTANT_RESET_SLACK_MS);
    expect(h.sent.slice(before).map((m) => m.type)).toEqual(["assistant.status"]);
  });

  test("a reset further away than a browser timer keeps is waited for in steps", () => {
    const h = harness(fakeClock("2026-11-01T00:00:00Z"));
    ready(h, [], SPENT);
    const due = Date.parse(SPENT.resets_at) + ASSISTANT_RESET_SLACK_MS;
    expect(h.clock.delays).toEqual([MAX_TIMER_MS]);
    h.clock.advance(MAX_TIMER_MS);
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history"]);
    expect(h.clock.armed()).toEqual([due]);
    h.clock.advance(due - h.clock.now());
    expect(h.last().type).toBe("assistant.status");
  });

  test("going offline or closing the panel stops the wait; coming back asks for the status anyway", () => {
    const h = harness(fakeClock("2026-11-30T23:00:00Z"));
    ready(h, [], SPENT);
    h.session.connection("reconnecting");
    expect(h.clock.armed()).toEqual([]);
    h.clock.advance(2 * 60 * 60 * 1000);
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history"]);

    h.session.connection("live");
    expect(types(h.sent)).toEqual(["assistant.status", "assistant.history", "assistant.status"]);
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "ready", model: MODEL, allowance: DECEMBER });
    expect(canAsk(h.session.view)).toBe(true);
    expect(h.clock.armed()).toHaveLength(1);

    h.session.dispose();
    expect(h.clock.armed()).toEqual([]);
    h.deliver({ type: "assistant.status", request_id: "late", state: "ready", model: MODEL, allowance: DECEMBER });
    expect(h.clock.armed()).toEqual([]);
  });
});

describe("a task", () => {
  test("streams in: its steps by number, the second announcement replacing the first, its text, its proposal, then its turn", () => {
    const h = harness();
    ready(h);
    expect(h.session.ask(REQUEST)).toBe(true);
    const ask = h.last();
    expect(ask).toMatchObject({ type: "assistant.ask", conversation_id: null, text: "Tighten the summary", doc_name: "memo.docx", target_address: "/body/p[2]" });
    expect(h.session.view.pending).toEqual({ request_id: ask.request_id, request: REQUEST });
    expect(canAsk(h.session.view)).toBe(false);

    h.deliver({ type: "assistant.task.started", request_id: ask.request_id, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: T1 });
    expect(h.session.view.pending).toBeNull();
    expect(h.session.view.conversation_id).toBe("conv-1");
    expect(h.session.view.allowance?.used).toBe(13);
    expect(h.session.view.live).toMatchObject({ task_id: "task-1", request: REQUEST, steps: [], text: "" });

    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "running" } });
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "running" } });
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok", summary: "Read the structure of memo.docx" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    h.deliver({
      type: "assistant.step",
      task_id: "task-1",
      step: { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" },
    });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: " the summary." });
    // Events of another task change nothing.
    h.deliver({ type: "assistant.step", task_id: "task-9", step: { step: 1, tool: "doc_search", doc_name: null, status: "running" } });
    h.deliver({ type: "assistant.text", task_id: "task-9", delta: "elsewhere" });

    const live = h.session.view.live!;
    expect(live.steps.map((s) => [s.step, s.status])).toEqual([
      [1, "ok"],
      [2, "ok"],
    ]);
    expect(live.steps[0]!.summary).toBe("Read the structure of memo.docx");
    expect(proposalsOpened(live.steps)).toEqual(["prop-7"]);
    expect(live.text).toBe("I shortened the summary.");

    h.deliver({ type: "assistant.task.finished", task_id: "task-1", turn: turn() });
    expect(h.session.view.live).toBeNull();
    expect(h.session.view.turns).toEqual([turn()]);
    expect(canAsk(h.session.view)).toBe(true);
  });

  test("cancel stops the live task once; a refused cancel can be sent again, and the task ends as cancelled", () => {
    const h = harness();
    ready(h);
    started(h);
    h.session.cancel();
    const cancel = h.last();
    expect(cancel).toMatchObject({ type: "assistant.cancel", task_id: "task-1" });
    expect(h.session.view.live?.cancel_request_id).toBe(cancel.request_id);
    h.session.cancel();
    expect(h.sent.filter((m) => m.type === "assistant.cancel")).toHaveLength(1);

    h.deliver({ type: "assistant.error", request_id: cancel.request_id, code: "UNKNOWN_TASK", message: "no such task" });
    expect(h.session.view.live?.cancel_request_id).toBeNull();
    expect(h.session.view.problem).toEqual({ code: "UNKNOWN_TASK", message: "no such task" });
    h.session.cancel();
    expect(h.sent.filter((m) => m.type === "assistant.cancel")).toHaveLength(2);

    const cancelled = turn({ outcome: "cancelled", answer: "", steps: [], proposal_ids: [] });
    h.deliver({ type: "assistant.task.finished", task_id: "task-1", turn: cancelled });
    expect(h.session.view.live).toBeNull();
    expect(h.session.view.turns.at(-1)?.outcome).toBe("cancelled");
  });
});

describe("a running task told again", () => {
  test("on the way back after a drop, the task is live again with what was asked, its steps and its text, and can be stopped", () => {
    const h = harness();
    ready(h, [EARLIER]);
    const askId = started(h);
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "running" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    h.session.connection("reconnecting");
    expect(h.session.view.dropped).toMatchObject({ task_id: "task-1" });

    // The way back: the status goes out; the server tells the running task as far as it has gone, then answers.
    h.session.connection("live");
    const status = h.last();
    expect(status.type).toBe("assistant.status");
    h.deliver({ type: "assistant.task.started", request_id: askId, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: T1 });
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok", summary: "Read the structure of memo.docx" } });
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened the summary." });
    h.deliver({ type: "assistant.status", request_id: status.request_id, state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    // The stored conversation does not hold the running task yet; the task stays live beside it.
    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER] });

    const view = h.session.view;
    expect(view.dropped).toBeNull();
    expect(view.live).toEqual({ task_id: "task-1", request: REQUEST, started_at: T1, steps: turn().steps, text: "I shortened the summary.", cancel_request_id: null });
    expect(view.turns).toEqual([EARLIER]);
    expect(proposalsOpened(view.live!.steps)).toEqual(["prop-7"]);
    expect(canAsk(view)).toBe(false);

    expect(h.session.cancel()).toBe(true);
    expect(h.last()).toMatchObject({ type: "assistant.cancel", task_id: "task-1" });
    h.deliver({ type: "assistant.task.finished", task_id: "task-1", turn: turn({ outcome: "cancelled" }) });
    expect(h.session.view.live).toBeNull();
    expect(h.session.view.turns.map((t) => t.task_id)).toEqual(["task-0", "task-1"]);
  });

  test("after a reload the task is live with no request of this page, and can be stopped", () => {
    const h = harness();
    h.session.connection("live");
    const status = h.last();
    h.deliver({ type: "assistant.task.started", request_id: "assistant-from-before", task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: T1 });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    h.deliver({ type: "assistant.status", request_id: status.request_id, state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER] });
    expect(h.session.view.live).toMatchObject({ task_id: "task-1", request: null, text: "I shortened" });
    expect(h.session.view.turns).toEqual([EARLIER]);
    expect(h.session.cancel()).toBe(true);
  });

  test("on the same connection, the task is not doubled and a cancel under way stays under way", () => {
    const h = harness();
    ready(h);
    const askId = started(h);
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    expect(h.session.cancel()).toBe(true);
    const cancelId = h.session.view.live?.cancel_request_id;

    h.deliver({ type: "assistant.task.started", request_id: askId, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: T1 });
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    expect(h.session.view.live).toMatchObject({ request: REQUEST, text: "I shortened", cancel_request_id: cancelId });
    expect(h.session.view.live?.steps).toHaveLength(1);
    expect(h.session.cancel()).toBe(false);
  });
});

describe("a new conversation", () => {
  test("asks with no conversation and shows none of the earlier turns; the next ask continues the new one", () => {
    const h = harness();
    ready(h, [EARLIER, turn()]);
    expect(h.session.ask(REQUEST, "new")).toBe(true);
    expect(h.last()).toMatchObject({ type: "assistant.ask", conversation_id: null, text: REQUEST.text });
    expect(h.session.view).toMatchObject({ conversation_id: null, turns: [], pending: { request: REQUEST } });

    const askId = h.last().request_id;
    h.deliver({ type: "assistant.task.started", request_id: askId, task_id: "task-5", conversation_id: "conv-2", allowance: { ...ALLOWANCE, used: 13 }, started_at: T2 });
    expect(h.session.view).toMatchObject({ conversation_id: "conv-2", turns: [], live: { task_id: "task-5", request: REQUEST } });
    // A task of the earlier conversation counts as any other.
    expect(h.session.view.allowance?.used).toBe(13);
    const fresh = turn({ task_id: "task-5", conversation_id: "conv-2", started_at: T2, finished_at: T2 });
    h.deliver({ type: "assistant.task.finished", task_id: "task-5", turn: fresh });
    expect(h.session.view.turns).toEqual([fresh]);

    h.session.ask(REQUEST);
    expect(h.last()).toMatchObject({ type: "assistant.ask", conversation_id: "conv-2" });
  });

  test("puts away the note of a dropped task; an ask the socket did not take leaves the conversation on show", () => {
    const h = harness();
    ready(h, [EARLIER]);
    h.socket.offline = true;
    expect(h.session.ask(REQUEST, "new")).toBe(false);
    expect(h.session.view).toMatchObject({ conversation_id: "conv-1", turns: [EARLIER], pending: null });
    h.socket.offline = false;

    started(h);
    h.session.connection("reconnecting");
    h.session.connection("live");
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER] });
    expect(h.session.view.dropped).toMatchObject({ task_id: "task-1" });
    expect(h.session.ask(REQUEST, "new")).toBe(true);
    expect(h.session.view.dropped).toBeNull();
  });
});

describe("refusals", () => {
  test("ALLOWANCE_EXHAUSTED sets the allowance and the exhausted state, and clears the ask", () => {
    const h = harness();
    ready(h, [EARLIER], { ...ALLOWANCE, used: 299 });
    h.session.ask(REQUEST);
    h.deliver({ type: "assistant.error", request_id: h.last().request_id, code: "ALLOWANCE_EXHAUSTED", message: "300 of 300 tasks used", allowance: SPENT });
    expect(h.session.view).toMatchObject({ state: "allowance_exhausted", allowance: SPENT, pending: null, problem: null });
    expect(h.session.view.turns).toEqual([EARLIER]);
    expect(assistantShown(h.session.view)).toBe(true);
    expect(canAsk(h.session.view)).toBe(false);
  });

  test("the task that uses the last one of the month runs to its end, and nothing more can be asked", () => {
    const h = harness();
    ready(h, [EARLIER], { ...ALLOWANCE, used: 299 });
    h.session.ask(REQUEST);
    h.deliver({ type: "assistant.task.started", request_id: h.last().request_id, task_id: "task-1", conversation_id: "conv-1", allowance: SPENT, started_at: T1 });
    expect(h.session.view).toMatchObject({ state: "allowance_exhausted", allowance: SPENT, live: { task_id: "task-1" } });
    h.deliver({ type: "assistant.task.finished", task_id: "task-1", turn: turn() });
    expect(h.session.view.turns.at(-1)?.task_id).toBe("task-1");
    expect(canAsk(h.session.view)).toBe(false);
    expect(h.session.ask(REQUEST)).toBe(false);
  });

  test("BUSY and NOT_IN_ROOM show their message and clear the ask, which can then go again", () => {
    const h = harness();
    ready(h);
    h.session.ask(REQUEST);
    h.deliver({ type: "assistant.error", request_id: h.last().request_id, code: "BUSY", message: "a task is already running" });
    expect(h.session.view.pending).toBeNull();
    expect(h.session.view.problem).toEqual({ code: "BUSY", message: "a task is already running" });
    expect(canAsk(h.session.view)).toBe(true);

    expect(h.session.ask(REQUEST)).toBe(true);
    expect(h.session.view.problem).toBeNull();
    h.deliver({ type: "assistant.error", request_id: null, code: "NOT_IN_ROOM", message: "join the room first" });
    expect(h.session.view.pending).toBeNull();
    expect(h.session.view.problem?.code).toBe("NOT_IN_ROOM");
  });

  test("an event that fails the contract is dropped and shown as a problem, never thrown", () => {
    const h = harness();
    ready(h);
    started(h);
    const before = h.session.view.live;
    const invalid: unknown[] = [
      { type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "shell_exec", doc_name: null, status: "running" } },
      { type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_edit", doc_name: null, status: "running", proposal_id: "prop-1" } },
      { type: "assistant.text", task_id: "task-1", delta: "" },
      { type: "assistant.status", request_id: "r", state: "ready", model: MODEL, allowance: SPENT },
      "assistant.text",
    ];
    for (const event of invalid) {
      expect(() => h.session.receive(event)).not.toThrow();
      expect(h.session.view.problem?.code).toBe("INVALID");
    }
    expect(h.session.view.problem?.message).toContain("this page cannot read");
    expect(h.session.view.live).toBe(before);
    expect(h.session.view.state).toBe("ready");
  });
});

describe("the connection", () => {
  test("dropping during a task ends it here with what streamed; the return asks again and restores the turn from history", () => {
    const h = harness();
    ready(h, [EARLIER]);
    started(h);
    h.deliver({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "running" } });
    h.deliver({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });

    h.session.connection("reconnecting");
    expect(h.session.view.online).toBe(false);
    expect(h.session.view.live).toBeNull();
    expect(h.session.view.dropped).toMatchObject({ task_id: "task-1", text: "I shortened" });
    expect(canAsk(h.session.view)).toBe(false);
    expect(h.session.ask(REQUEST)).toBe(false);

    const before = h.sent.length;
    h.session.connection("live");
    expect(types(h.sent.slice(before))).toEqual(["assistant.status"]);
    h.deliver({ type: "assistant.status", request_id: h.last().request_id, state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    expect(h.last()).toMatchObject({ type: "assistant.history", conversation_id: null });
    h.deliver({ type: "assistant.conversation", request_id: h.last().request_id, conversation_id: "conv-1", turns: [EARLIER, turn()] });
    expect(h.session.view.dropped).toBeNull();
    expect(h.session.view.turns.map((t) => t.task_id)).toEqual(["task-0", "task-1"]);
    expect(canAsk(h.session.view)).toBe(true);
  });

  test("an ask the server never took is dropped with the connection and says so", () => {
    const h = harness();
    ready(h);
    h.session.ask(REQUEST);
    h.session.connection("reconnecting");
    expect(h.session.view.pending).toBeNull();
    expect(h.session.view.problem?.code).toBe("OFFLINE");
    // Nothing had started, so no task is left half shown.
    expect(h.session.view.dropped).toBeNull();
  });

  test("a socket that does not take the message leaves no pending ask", () => {
    const h = harness();
    ready(h);
    h.socket.offline = true;
    expect(h.session.ask(REQUEST)).toBe(false);
    expect(h.session.view.pending).toBeNull();
    expect(h.session.view.problem?.code).toBe("OFFLINE");
  });
});

describe("messages", () => {
  test("every message built passes the contract, each with a fresh request_id", () => {
    const messages: AssistantClientMessage[] = [
      statusMessage(),
      historyMessage(null),
      historyMessage("conv-1"),
      askMessage(null, REQUEST),
      askMessage("conv-1", { text: "x".repeat(ASSISTANT_REQUEST_MAX_CHARS), doc_name: null, target_address: null }),
      cancelMessage("task-1"),
    ];
    for (const message of messages) expect(validateAssistantClientMessage(message)).toEqual([]);
    expect(new Set(messages.map((m) => m.request_id)).size).toBe(messages.length);
  });

  test("an ask that fails the contract goes nowhere and shows as a problem", () => {
    const sent: AssistantClientMessage[] = [];
    const session = new AssistantSession((message) => (sent.push(message), true), () => undefined, fakeClock());
    session.connection("live");
    session.receive({ type: "assistant.status", request_id: sent[0]!.request_id, state: "ready", model: MODEL, allowance: ALLOWANCE });
    const before = sent.length;
    expect(session.ask({ text: "x".repeat(ASSISTANT_REQUEST_MAX_CHARS + 1), doc_name: null, target_address: null })).toBe(false);
    expect(session.ask({ ...REQUEST, text: "" })).toBe(false);
    expect(sent).toHaveLength(before);
    expect(session.view.problem?.code).toBe("INVALID");
    expect(session.view.pending).toBeNull();
  });

  test("the reducer leaves the view it was given as it was, and a turn of another conversation starts that one", () => {
    const view = { ...EMPTY_ASSISTANT, state: "ready" as const, conversation_id: "conv-1", turns: [EARLIER] };
    const next = applyAssistantEvent(view, { type: "assistant.task.finished", task_id: "task-1", turn: turn() });
    expect(view.turns).toEqual([EARLIER]);
    expect(next.turns).toEqual([EARLIER, turn()]);
    const other = applyAssistantEvent(view, { type: "assistant.task.finished", task_id: "task-5", turn: turn({ task_id: "task-5", conversation_id: "conv-2" }) });
    expect(other.conversation_id).toBe("conv-2");
    expect(other.turns.map((t) => t.task_id)).toEqual(["task-5"]);
  });
});
