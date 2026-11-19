/** @jsxImportSource preact */
// The assistant panel as rendered HTML, fed by a session that heard real `wolfsdk.assistant.v1` events. Handlers are
// reached through the vnodes of the render, as a click would reach them. The session's clock is a fake one.
import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import {
  ASSISTANT_CONTRACT,
  ASSISTANT_REQUEST_MAX_CHARS,
  type AssistantAllowance,
  type AssistantClientMessage,
  type AssistantRequest,
  type AssistantStep,
  type AssistantTurn,
  type RoomActor,
  type RoomProposal,
  validateAssistantEvent,
} from "@wolfsdk/protocol/workspace";
import { ASSISTANT_RESET_SLACK_MS, type AssistantClock, AssistantSession, type AssistantView, EMPTY_ASSISTANT } from "../src/lib/assistant-client.ts";
import { formatPacificTime } from "../src/lib/time.ts";
import { AssistantPanel, type AssistantPanelProps, AssistantPanelView, proposalTitle } from "../src/ui/assistant-panel.tsx";
import { RightRail } from "../src/ui/right-rail.tsx";
import { ALICE, batch, proposal, SCOUT } from "./fixtures.ts";

const noop = (): void => undefined;

const MODEL = "deepseek-v4.1-flash";
const ALLOWANCE: AssistantAllowance = { period: "2026-11", limit: 300, used: 12, resets_at: "2026-12-01T00:00:00Z" };
const SPENT: AssistantAllowance = { ...ALLOWANCE, used: 300 };
const DECEMBER: AssistantAllowance = { period: "2026-12", limit: 300, used: 0, resets_at: "2027-01-01T00:00:00Z" };
const UNMETERED: AssistantAllowance = { ...ALLOWANCE, limit: null, used: 4012 };
const ASSISTANT: RoomActor = { kind: "agent", id: "assistant:alice", name: "Assistant" };
const REQUEST: AssistantRequest = { text: "Tighten the summary", doc_name: "memo.docx", target_address: "/body/p[2]" };

function turn(over: Partial<AssistantTurn>): AssistantTurn {
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
    started_at: "2026-11-14T09:00:00Z",
    finished_at: "2026-11-14T09:00:41Z",
    ...over,
  };
}

const ANSWERED = turn({
  task_id: "task-0",
  request: { text: "How many tables are there?", doc_name: "memo.docx", target_address: null },
  outcome: "answered",
  answer: "There are two tables.",
  steps: [{ step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok" }],
  proposal_ids: [],
  started_at: "2026-11-14T08:00:00Z",
  finished_at: "2026-11-14T08:00:09Z",
});
const PROPOSED = turn({});
const FAILED = turn({
  task_id: "task-2",
  request: { text: "Fix the total in table 2", doc_name: "memo.docx", target_address: null },
  outcome: "failed",
  answer: "",
  failure: "The model endpoint did not answer in time",
  steps: [{ step: 1, tool: "doc_read", doc_name: "memo.docx", status: "failed", summary: "The engine refused: unknown target" }],
  proposal_ids: [],
  started_at: "2026-11-14T09:05:00Z",
  finished_at: "2026-11-14T09:05:30Z",
});

/** The proposal the assistant opened, as the room lists it: its edit is labelled "Shorten the summary". */
const OPENED: RoomProposal = proposal("prop-7", "memo.docx", { author: ASSISTANT, batches: [batch(2, "Shorten the summary")] });
const OPENED_TITLE = "Shorten the summary";

/** A clock that moves only when `advance` moves it, running the timers that fall due. */
function fakeClock(start: string): AssistantClock & { advance(ms: number): void } {
  let now = Date.parse(start);
  const timers = new Map<number, { at: number; run: () => void }>();
  let ids = 0;
  return {
    now: () => now,
    setTimer(run, ms) {
      timers.set(++ids, { at: now + ms, run });
      return ids;
    },
    clearTimer: (timer) => void timers.delete(timer as number),
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

type Connected = { session: AssistantSession; hear: (event: unknown) => void; lastId: () => string; sent: AssistantClientMessage[] };

/** A session on a socket that takes everything. It goes live and hears the status and the conversation the server
 * answers with; `hear` delivers more events, each checked against the contract first. */
function connected(allowance: AssistantAllowance | null, turns: AssistantTurn[] = [], clock = fakeClock("2026-11-14T09:00:00Z")): Connected {
  const sent: AssistantClientMessage[] = [];
  const session = new AssistantSession(
    (message) => {
      sent.push(message);
      return true;
    },
    noop,
    clock,
  );
  const hear = (event: unknown): void => {
    expect(validateAssistantEvent(event)).toEqual([]);
    session.receive(event);
  };
  const lastId = (): string => sent.at(-1)!.request_id;
  session.connection("live");
  if (allowance === null) {
    hear({ type: "assistant.status", request_id: lastId(), state: "not_configured", model: null, allowance: null });
  } else {
    const state = allowance.limit !== null && allowance.used >= allowance.limit ? "allowance_exhausted" : "ready";
    hear({ type: "assistant.status", request_id: lastId(), state, model: MODEL, allowance });
    hear({ type: "assistant.conversation", request_id: lastId(), conversation_id: turns[0]?.conversation_id ?? null, turns });
  }
  return { session, hear, lastId, sent };
}

function props(view: AssistantView, over: Partial<AssistantPanelProps> = {}): AssistantPanelProps {
  return {
    view,
    docName: "memo.docx",
    selection: "/body/p[2]",
    proposals: [OPENED],
    onAsk: () => true,
    onCancel: noop,
    onInspect: noop,
    ...over,
  };
}

/** Render `node`, keeping every vnode created on the way so a test can reach a handler as a click would. */
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

/** The props of the first `button` vnode `match` picks. */
function button(vnodes: VNode[], match: (props: Record<string, unknown>) => boolean): Record<string, unknown> {
  const found = vnodes.find((v) => v.type === "button" && match(v.props as Record<string, unknown>));
  expect(found).toBeDefined();
  return found!.props as Record<string, unknown>;
}

/** The text a vnode's children spell, ignoring nested elements. */
const label = (props: Record<string, unknown>): string => [props.children].flat().filter((c) => typeof c === "string").join("");

/** The text of rendered HTML a reader sees: no tags, so no attributes. */
const visible = (html: string): string => html.replace(/<[^>]*>/g, " ");

const disabledBox = /<textarea[^>]*\sdisabled/;
const exhaustedNotice = /<div class="notice notice--warning assistant-exhausted"[^]*?<\/div>/;

describe("AssistantPanel", () => {
  test("renders nothing before the status arrives, or when the server has no assistant", () => {
    expect(render(<AssistantPanel {...props({ ...EMPTY_ASSISTANT, online: true })} />)).toBe("");
    const { session } = connected(null);
    expect(session.view.state).toBe("not_configured");
    expect(render(<AssistantPanel {...props(session.view)} />)).toBe("");
  });

  test("a live task shows each step as it streams, the answer so far, and a card that opens the review of its proposal", () => {
    const { session, hear, lastId } = connected(ALLOWANCE);
    expect(session.ask(REQUEST)).toBe(true);
    hear({ type: "assistant.task.started", request_id: lastId(), task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: "2026-11-14T09:00:00Z" });
    hear({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "running" } });
    hear({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_read", doc_name: "memo.docx", status: "ok", summary: "Read the structure of memo.docx" } });
    hear({ type: "assistant.step", task_id: "task-1", step: { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "running" } });
    hear({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });

    const streaming = render(<AssistantPanel {...props(session.view)} />);
    expect(streaming).toContain("Tighten the summary");
    expect(streaming.match(/class="assistant-step"/g)).toHaveLength(2);
    expect(streaming).toContain("doc_read");
    expect(streaming).toContain("doc_edit");
    expect(streaming).toContain("Read the structure of memo.docx");
    expect(streaming.match(/>Running</g)).toHaveLength(1);
    expect(streaming.match(/>Done</g)).toHaveLength(1);
    expect(streaming).toContain("I shortened");
    expect(streaming).toContain("13 of 300 tasks this month");
    expect(streaming).not.toContain("Inspect Diff");

    hear({ type: "assistant.step", task_id: "task-1", step: { step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" } });
    hear({ type: "assistant.text", task_id: "task-1", delta: " the summary." });

    const inspected: string[] = [];
    let cancels = 0;
    const { html, vnodes } = rendered(
      <AssistantPanel
        {...props(session.view, {
          onInspect: (p) => inspected.push(p.proposal_id),
          onCancel: () => cancels++,
        })}
      />,
    );
    expect(html.match(/class="assistant-step"/g)).toHaveLength(2);
    expect(html).not.toContain(">Running<");
    expect(html).toContain("Proposed 2 changes");
    expect(html).toContain("I shortened the summary.");
    // The request box waits for the task; the task can be stopped.
    expect(html).toMatch(disabledBox);

    (button(vnodes, (p) => p["aria-label"] === `Inspect Diff of ${OPENED_TITLE}`).onClick as () => void)();
    expect(inspected).toEqual(["prop-7"]);
    (button(vnodes, (p) => label(p) === "Stop").onClick as () => void)();
    expect(cancels).toBe(1);

    // A shared-link snapshot has no engine for the diff, and a decided proposal has no review left to open.
    expect(render(<AssistantPanel {...props(session.view, { shareMode: true })} />)).not.toContain("Inspect Diff");
    expect(render(<AssistantPanel {...props(session.view, { proposals: [{ ...OPENED, status: "approved" }] })} />)).not.toContain("Inspect Diff");
  });

  test("a restored conversation shows every earlier turn: request, steps, answer, outcome, failure, and its proposals", () => {
    const { session } = connected(ALLOWANCE, [ANSWERED, PROPOSED, FAILED]);
    const inspected: string[] = [];
    const { html, vnodes } = rendered(<AssistantPanel {...props(session.view, { onInspect: (p) => inspected.push(p.proposal_id) })} />);

    expect(html.match(/class="assistant-turn"/g)).toHaveLength(3);
    for (const t of [ANSWERED, PROPOSED, FAILED]) expect(html).toContain(t.request.text);
    expect(html).toContain("There are two tables.");
    expect(html).toContain("I shortened the summary.");
    expect(html).toContain("The model endpoint did not answer in time");
    expect(html).toContain("The engine refused: unknown target");
    // An outcome is shown for every turn but the plain answer.
    expect(html.match(/class="assistant-outcome"/g)).toHaveLength(2);
    expect(html).not.toMatch(disabledBox);
    expect(html).toMatch(new RegExp(`maxlength="${ASSISTANT_REQUEST_MAX_CHARS}"`, "i"));

    (button(vnodes, (p) => p["aria-label"] === `Inspect Diff of ${OPENED_TITLE}`).onClick as () => void)();
    expect(inspected).toEqual(["prop-7"]);
  });

  test("an exhausted allowance says when it resets and disables the request box; earlier turns and the review stay", () => {
    const { session } = connected(SPENT, [ANSWERED]);
    expect(session.view.state).toBe("allowance_exhausted");
    const html = render(
      <>
        <AssistantPanel {...props(session.view)} />
        <RightRail
          tab="proposals"
          onTab={noop}
          actor={ALICE}
          activeDoc="memo.docx"
          allDocs={false}
          onAllDocs={noop}
          proposals={[OPENED]}
          focusedProposal={null}
          deciding={null}
          onInspect={noop}
          onDecide={noop}
          onDownloadPreview={noop}
          threads={[]}
          selection={null}
          participants={[ALICE, SCOUT]}
          onComment={async () => true}
          history={[]}
          activity={[]}
        />
      </>,
    );
    const notice = html.match(exhaustedNotice)?.[0] ?? "";
    expect(notice).toContain(formatPacificTime(SPENT.resets_at));
    expect(html).toMatch(disabledBox);
    expect(html).toContain("300 of 300 tasks this month");
    expect(html).toContain(ANSWERED.request.text);
    expect(html).toContain("There are two tables.");
    // The right rail still offers the review of the open proposal.
    expect(html.match(/>Approve</g)).toHaveLength(1);
    expect(html).toContain("Inspect Diff");
  });

  test("a panel left open at the limit takes requests again once the UTC month turns, with no reconnect or reload", () => {
    const clock = fakeClock("2026-11-30T23:00:00Z");
    const { session, hear, lastId, sent } = connected(SPENT, [ANSWERED], clock);
    const before = render(<AssistantPanel {...props(session.view)} />);
    expect(before).toMatch(exhaustedNotice);
    expect(before).toMatch(disabledBox);

    clock.advance(60 * 60 * 1000 + ASSISTANT_RESET_SLACK_MS);
    expect(sent.at(-1)?.type).toBe("assistant.status");
    hear({ type: "assistant.status", request_id: lastId(), state: "ready", model: MODEL, allowance: DECEMBER });

    const asked: AssistantRequest[] = [];
    const { html, vnodes } = rendered(<AssistantPanel {...props(session.view, { onAsk: (r) => (asked.push(r), true) })} />);
    expect(html).not.toMatch(exhaustedNotice);
    expect(html).not.toMatch(disabledBox);
    expect(html).toContain("0 of 300 tasks this month");
    expect(html).toContain("Ask for a change to memo.docx");
    expect(html).toContain(ANSWERED.request.text);
    // The request goes out as one in the conversation on show.
    expect(session.ask(REQUEST)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "assistant.ask", conversation_id: "conv-1" });
    expect(vnodes.some((v) => v.type === "textarea")).toBe(true);
  });

  test("a metered allowance shows tasks used against the limit; an unmetered one shows no meter", () => {
    expect(render(<AssistantPanel {...props(connected(ALLOWANCE).session.view)} />)).toContain("12 of 300 tasks this month");
    const unmetered = render(<AssistantPanel {...props(connected(UNMETERED).session.view)} />);
    expect(unmetered).toContain('aria-label="Assistant"');
    expect(unmetered).not.toContain("assistant-meter");
    expect(unmetered).not.toContain("4012");
  });

  test("a task the connection drops under keeps what streamed, with a note, until the conversation reloads", () => {
    const { session, hear, lastId } = connected(ALLOWANCE, [ANSWERED]);
    session.ask(REQUEST);
    hear({ type: "assistant.task.started", request_id: lastId(), task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: "2026-11-14T09:00:00Z" });
    hear({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    session.connection("reconnecting");

    const html = render(<AssistantPanel {...props(session.view)} />);
    expect(html).toContain("I shortened");
    expect(html).toMatch(/class="notice notice--warning"/);
    expect(html).not.toContain('aria-busy="true"');
    expect(html).toMatch(disabledBox);
    expect(html).not.toContain(">Stop<");

    session.connection("live");
    hear({ type: "assistant.status", request_id: lastId(), state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    hear({ type: "assistant.conversation", request_id: lastId(), conversation_id: "conv-1", turns: [ANSWERED, PROPOSED] });
    const back = render(<AssistantPanel {...props(session.view)} />);
    expect(back.match(/class="assistant-turn"/g)).toHaveLength(2);
    expect(back).not.toMatch(/class="notice notice--warning"/);
    expect(back).not.toMatch(disabledBox);
  });

  test("a task the server tells again on the way back shows live, with its steps, text and proposal, and Stop", () => {
    const { session, hear, lastId } = connected(ALLOWANCE, [ANSWERED]);
    session.ask(REQUEST);
    const askId = lastId();
    hear({ type: "assistant.task.started", request_id: askId, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: "2026-11-14T09:00:00Z" });
    hear({ type: "assistant.text", task_id: "task-1", delta: "I shortened" });
    session.connection("reconnecting");

    session.connection("live");
    const status = lastId();
    hear({ type: "assistant.task.started", request_id: askId, task_id: "task-1", conversation_id: "conv-1", allowance: { ...ALLOWANCE, used: 13 }, started_at: "2026-11-14T09:00:00Z" });
    hear({ type: "assistant.step", task_id: "task-1", step: { step: 1, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7" } });
    hear({ type: "assistant.text", task_id: "task-1", delta: "I shortened the summary." });
    hear({ type: "assistant.status", request_id: status, state: "ready", model: MODEL, allowance: { ...ALLOWANCE, used: 13 } });
    hear({ type: "assistant.conversation", request_id: lastId(), conversation_id: "conv-1", turns: [ANSWERED] });

    let cancels = 0;
    const { html, vnodes } = rendered(<AssistantPanel {...props(session.view, { onCancel: () => cancels++ })} />);
    // Live again: no note of a dropped task, the request it came from, its step, its text and its proposal card.
    expect(html).not.toMatch(/class="notice notice--warning"/);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(REQUEST.text);
    expect(html).toContain("I shortened the summary.");
    expect(html).toContain(">Working<");
    expect(html).toContain(OPENED_TITLE);
    const stop = button(vnodes, (p) => label(p) === "Stop");
    expect(stop.disabled).toBe(false);
    (stop.onClick as () => void)();
    expect(cancels).toBe(1);
    // A new conversation waits for the running task to end.
    expect(button(vnodes, (p) => label(p) === "New conversation").disabled).toBe(true);
  });

  test("uses no em dash", () => {
    const html = render(<AssistantPanel {...props(connected(SPENT, [ANSWERED, PROPOSED, FAILED]).session.view)} />);
    expect(html).not.toContain("\u2014");
  });
});

describe("a new conversation", () => {
  test("the control starts one when there is a conversation to leave; the next ask continues the one on show until then", () => {
    const { session } = connected(ALLOWANCE, [ANSWERED, PROPOSED]);
    const choices: (string | undefined)[] = [];
    const { vnodes } = rendered(<AssistantPanel {...props(session.view, { onAsk: (_r, choice) => (choices.push(choice), true) })} />);
    expect(button(vnodes, (p) => label(p) === "New conversation").disabled).toBe(false);
    // The panel hands its view an ask that says which conversation it goes in.
    const inner = vnodes.find((v) => v.type === AssistantPanelView)!.props as unknown as { onAsk(r: AssistantRequest): boolean; fresh: boolean };
    expect(inner.fresh).toBe(false);
    expect(inner.onAsk(REQUEST)).toBe(true);
    expect(choices).toEqual(["continue"]);

    // With nothing on show there is nothing to leave.
    const { vnodes: empty } = rendered(<AssistantPanel {...props(connected(ALLOWANCE).session.view)} />);
    expect(button(empty, (p) => label(p) === "New conversation").disabled).toBe(true);
  });

  test("chosen, it puts the earlier turns away and says the earlier conversation stays saved", () => {
    const { session } = connected(ALLOWANCE, [ANSWERED, PROPOSED]);
    let started = 0;
    const { html, vnodes } = rendered(<AssistantPanelView {...props(session.view)} fresh={false} onNewConversation={() => started++} />);
    expect(html.match(/class="assistant-turn"/g)).toHaveLength(2);
    (button(vnodes, (p) => label(p) === "New conversation").onClick as () => void)();
    expect(started).toBe(1);

    const { html: fresh, vnodes: freshNodes } = rendered(<AssistantPanelView {...props(session.view)} fresh onNewConversation={noop} />);
    expect(fresh).not.toContain('class="assistant-turn"');
    expect(fresh).not.toContain(ANSWERED.request.text);
    expect(fresh).toContain("The earlier one stays saved");
    expect(fresh).not.toMatch(disabledBox);
    expect(button(freshNodes, (p) => label(p) === "New conversation").disabled).toBe(true);
    // The allowance is the seat's, whatever the conversation.
    expect(fresh).toContain("12 of 300 tasks this month");
  });
});

describe("a proposal card", () => {
  const step = (over: Partial<AssistantStep> = {}): AssistantStep => ({ step: 2, tool: "doc_edit", doc_name: "memo.docx", status: "ok", summary: "Proposed 2 changes", proposal_id: "prop-7", ...over });
  const unlabelled = (ops: number): RoomProposal => proposal("prop-7", "memo.docx", { author: ASSISTANT, batches: [batch(ops)] });

  test("is titled by the change in words, never by its id", () => {
    expect(proposalTitle(OPENED, step())).toBe("Shorten the summary");
    expect(proposalTitle(unlabelled(1), step())).toBe("Set in memo.docx");
    expect(proposalTitle(unlabelled(3), step())).toBe("3 changes to memo.docx: set");
    // Not listed by the room yet: the summary of the step that opened it, unless that is only the id.
    expect(proposalTitle(undefined, step())).toBe("Proposed 2 changes");
    expect(proposalTitle(undefined, step({ summary: "prop-7" }))).toBe("A proposed change to memo.docx");
    expect(proposalTitle(undefined, step({ summary: undefined, doc_name: null }))).toBe("A proposed change");
  });

  test("shows no raw proposal id to the reader, and its Inspect Diff names the change", () => {
    const { session } = connected(ALLOWANCE, [PROPOSED]);
    for (const proposals of [[OPENED], [unlabelled(3)], []]) {
      const { html, vnodes } = rendered(<AssistantPanel {...props(session.view, { proposals })} />);
      expect(visible(html)).not.toContain("prop-7");
      expect(html).toContain('data-proposal-id="prop-7"');
      if (proposals.length > 0) expect(button(vnodes, (p) => label(p) === "Inspect Diff")["aria-label"]).toBe(`Inspect Diff of ${proposalTitle(proposals[0], step())}`);
    }
  });
});
