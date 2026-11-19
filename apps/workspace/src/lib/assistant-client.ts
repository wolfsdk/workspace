// The assistant panel without Preact (`wolfsdk.assistant.v1`): what the server says of the assistant (its state,
// its model, the seat's allowance), the conversation on show (its finished turns), the task running now as it
// streams, and the messages the panel sends. `applyAssistantEvent` is the pure reducer of validated events.
// `AssistantSession` puts it on the room's socket: every event is validated before it counts and every message
// before it goes out (one that fails is dropped and becomes the visible problem, never a throw); each time the room
// goes live it asks for the status and then for the latest conversation; when the month of the allowance ends it
// asks for the status again, so a panel left open takes requests in the new month; and a task the connection drops
// under ends here with a note until the server tells it again or the conversation reloads.
import {
  ASSISTANT_ALLOWANCE_EXHAUSTED,
  type AssistantAllowance,
  type AssistantClientMessage,
  type AssistantRequest,
  type AssistantServerEvent,
  type AssistantState,
  type AssistantStep,
  type AssistantTurn,
  validateAssistantClientMessage,
  validateAssistantEvent,
} from "@wolfsdk/protocol/workspace";
import type { ConnectionStatus } from "./room-client.ts";

/** An ask the server has not answered yet, under the `request_id` it went with. */
export type AssistantPendingAsk = { request_id: string; request: AssistantRequest };

/** A task between `assistant.task.started` and `assistant.task.finished`, as far as it has streamed. */
export type AssistantLiveTask = {
  task_id: string;
  /** What was asked, when the ask went from this page; null otherwise. */
  request: AssistantRequest | null;
  started_at: string;
  /** One entry per step number, in order: the second announcement of a step replaces the first. */
  steps: AssistantStep[];
  /** The answer so far: every `assistant.text` delta, in order. */
  text: string;
  /** The `request_id` of a cancel that went out and was not refused; null when none did. */
  cancel_request_id: string | null;
};

/** What the panel shows above the request box until the next ask: a refusal of the server (its `code` and
 * `message`), a message or event that failed the contract (`INVALID`), or an ask the connection lost (`OFFLINE`). */
export type AssistantProblem = { code: string; message: string };

export type AssistantView = {
  /** Whether the room's socket is live. Nothing goes out while it is not. */
  online: boolean;
  /** Null until the server answers `assistant.status`. */
  state: AssistantState | null;
  model: string | null;
  allowance: AssistantAllowance | null;
  /** The conversation the next ask continues; null starts one. */
  conversation_id: string | null;
  /** The finished turns of that conversation, oldest first. */
  turns: AssistantTurn[];
  pending: AssistantPendingAsk | null;
  live: AssistantLiveTask | null;
  /** The task the connection dropped under, as far as it had streamed. It stays until the server tells it again
   * or the conversation reloads with its turn. */
  dropped: AssistantLiveTask | null;
  problem: AssistantProblem | null;
};

export const EMPTY_ASSISTANT: AssistantView = {
  online: false,
  state: null,
  model: null,
  allowance: null,
  conversation_id: null,
  turns: [],
  pending: null,
  live: null,
  dropped: null,
  problem: null,
};

/** Whether the panel shows at all: the server has an assistant for this seat, with tasks left or not. With no
 * status yet, or `not_configured`, there is no panel. */
export const assistantShown = (view: AssistantView): boolean => view.state === "ready" || view.state === "allowance_exhausted";

/** Whether an ask can go out now: the room is live, the assistant is ready, and no ask or task is under way. */
export const canAsk = (view: AssistantView): boolean => view.online && view.state === "ready" && view.pending === null && view.live === null;

/** The proposals a task opened so far, in the order of the steps that opened them. */
export const proposalsOpened = (steps: readonly AssistantStep[]): string[] => steps.flatMap((s) => (s.proposal_id === undefined ? [] : [s.proposal_id]));

/** Where an ask goes: on in the conversation on show, or into a new one. The earlier conversation stays stored by
 * the server, and its tasks still count. */
export type AssistantConversationChoice = "continue" | "new";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type ClientMessage<T extends AssistantClientMessage["type"]> = Extract<AssistantClientMessage, { type: T }>;

let requests = 0;

/** A `request_id` no other assistant message of this page has used. */
const nextRequestId = (): string => `assistant-${++requests}`;

export const statusMessage = (): ClientMessage<"assistant.status"> => ({ type: "assistant.status", request_id: nextRequestId() });

/** The stored turns of `conversationId`, or of this user's latest conversation in the room with null. */
export const historyMessage = (conversationId: string | null): ClientMessage<"assistant.history"> => ({
  type: "assistant.history",
  request_id: nextRequestId(),
  conversation_id: conversationId,
});

/** `request` in `conversationId`, or in a new conversation with null. */
export const askMessage = (conversationId: string | null, request: AssistantRequest): ClientMessage<"assistant.ask"> => ({
  type: "assistant.ask",
  request_id: nextRequestId(),
  conversation_id: conversationId,
  text: request.text,
  doc_name: request.doc_name,
  target_address: request.target_address,
});

export const cancelMessage = (taskId: string): ClientMessage<"assistant.cancel"> => ({ type: "assistant.cancel", request_id: nextRequestId(), task_id: taskId });

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** The view after one event that passed `validateAssistantEvent`. A step or text of a task other than the live one
 * changes nothing; a finished turn always joins its conversation. A server tells a running task again (its start,
 * each step so far and its text so far) to a connection that comes back while it runs: the start of a task this
 * page already shows keeps what was asked and a cancel under way, and ends the note of a dropped one. */
export function applyAssistantEvent(view: AssistantView, event: AssistantServerEvent): AssistantView {
  switch (event.type) {
    case "assistant.status":
      return { ...view, state: event.state, model: event.model, allowance: event.allowance };
    case "assistant.conversation": {
      const dropped = view.dropped !== null && event.turns.some((t) => t.task_id === view.dropped?.task_id) ? null : view.dropped;
      return { ...view, conversation_id: event.conversation_id, turns: event.turns, dropped };
    }
    case "assistant.task.started": {
      const ask = view.pending?.request_id === event.request_id ? view.pending : null;
      const live = view.live?.task_id === event.task_id ? view.live : null;
      const known = live ?? (view.dropped?.task_id === event.task_id ? view.dropped : null);
      return {
        ...view,
        // The task that uses the last one of the month: nothing more can be asked, before any refusal says so.
        state: event.allowance.limit !== null && event.allowance.used >= event.allowance.limit ? "allowance_exhausted" : view.state,
        conversation_id: event.conversation_id,
        turns: event.conversation_id === view.conversation_id ? view.turns : [],
        allowance: event.allowance,
        pending: ask === null ? view.pending : null,
        live: {
          task_id: event.task_id,
          request: ask?.request ?? known?.request ?? null,
          started_at: event.started_at,
          steps: [],
          text: "",
          cancel_request_id: live?.cancel_request_id ?? null,
        },
        dropped: view.dropped?.task_id === event.task_id ? null : view.dropped,
      };
    }
    case "assistant.step": {
      const live = view.live;
      if (live === null || live.task_id !== event.task_id) return view;
      const steps = [...live.steps.filter((s) => s.step !== event.step.step), event.step].sort((a, b) => a.step - b.step);
      return { ...view, live: { ...live, steps } };
    }
    case "assistant.text": {
      const live = view.live;
      if (live === null || live.task_id !== event.task_id) return view;
      return { ...view, live: { ...live, text: live.text + event.delta } };
    }
    case "assistant.task.finished": {
      const { turn } = event;
      const earlier = turn.conversation_id === view.conversation_id ? view.turns.filter((t) => t.task_id !== turn.task_id) : [];
      return {
        ...view,
        conversation_id: turn.conversation_id,
        turns: [...earlier, turn],
        live: view.live?.task_id === event.task_id ? null : view.live,
        dropped: view.dropped?.task_id === event.task_id ? null : view.dropped,
      };
    }
    case "assistant.error": {
      // A refusal without a request_id, or with the ask's, answers the ask: nothing started.
      const answersAsk = event.request_id === null || event.request_id === view.pending?.request_id;
      if (event.code === ASSISTANT_ALLOWANCE_EXHAUSTED) {
        return { ...view, state: "allowance_exhausted", allowance: event.allowance, pending: null, problem: null };
      }
      const live = view.live !== null && view.live.cancel_request_id !== null && view.live.cancel_request_id === event.request_id ? { ...view.live, cancel_request_id: null } : view.live;
      return { ...view, pending: answersAsk ? null : view.pending, live, problem: { code: event.code, message: event.message } };
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** The clock of a session: the current instant in milliseconds, and a one-shot timer. */
export type AssistantClock = {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
};

const BROWSER_CLOCK: AssistantClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** How long after the end of the month the status is asked: a server clock a little behind this page's already
 * counts in the new month. Once that instant has passed, the status is asked again after as long each time an
 * answer still names the old month or the socket did not take the question. */
export const ASSISTANT_RESET_SLACK_MS = 5_000;

/** The longest delay a browser timer keeps (about 24.8 days): a month can be longer, so a far reset is waited
 * for in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The assistant of one room connection: the view `applyAssistantEvent` keeps, and the messages that keep it current.
 * `send` writes one message on the room's socket and says whether it went out; `onChange` hears every new view. */
export class AssistantSession {
  #view: AssistantView = EMPTY_ASSISTANT;
  readonly #send: (message: AssistantClientMessage) => boolean;
  readonly #onChange: (view: AssistantView) => void;
  readonly #clock: AssistantClock;
  /** The `request_id` of the status asked for when the room went live: its answer asks for the conversation. */
  #syncRequest: string | null = null;
  /** The end of the allowance's month the reset timer waits for, and the timer; null when none is armed. */
  #resetAt: string | null = null;
  #resetTimer: unknown = null;
  #disposed = false;

  constructor(send: (message: AssistantClientMessage) => boolean, onChange: (view: AssistantView) => void = () => undefined, clock: AssistantClock = BROWSER_CLOCK) {
    this.#send = send;
    this.#onChange = onChange;
    this.#clock = clock;
  }

  get view(): AssistantView {
    return this.#view;
  }

  /** The room's connection is now `status`. Going live asks for the status, whose answer asks for the latest
   * conversation. Leaving live ends the running task here with a note, and drops an ask the server never took. */
  connection(status: ConnectionStatus): void {
    const online = status === "live";
    if (online === this.#view.online) return;
    if (!online) {
      this.#syncRequest = null;
      const { live, pending } = this.#view;
      this.#update({
        ...this.#view,
        online: false,
        pending: null,
        live: null,
        dropped: live ?? this.#view.dropped,
        problem:
          pending === null ? this.#view.problem : { code: "OFFLINE", message: "The connection dropped before the assistant took the request. Send it again when the room is back." },
      });
      return;
    }
    this.#update({ ...this.#view, online: true });
    const sync = statusMessage();
    if (this.#write(sync)) this.#syncRequest = sync.request_id;
  }

  /** One assistant message of the socket, not yet validated. One that fails the contract is dropped and becomes the
   * problem. */
  receive(raw: unknown): void {
    const problems = validateAssistantEvent(raw);
    if (problems.length > 0) {
      const type = typeof raw === "object" && raw !== null && "type" in raw && typeof raw.type === "string" ? raw.type : "event";
      const message = `The server sent an ${type} this page cannot read, so it was ignored (${problems.join("; ")}).`;
      this.#update({ ...this.#view, problem: { code: "INVALID", message } });
      return;
    }
    const event = raw as AssistantServerEvent;
    this.#update(applyAssistantEvent(this.#view, event));
    if (event.type === "assistant.status" && event.request_id === this.#syncRequest) {
      this.#syncRequest = null;
      if (event.state !== "not_configured") this.#write(historyMessage(null));
    }
  }

  /** Ask for `request` in the conversation on show, or in a new one. A new conversation leaves the earlier one on
   * the server and shows no turn until its own come. False when nothing went out: `canAsk` says no, or the message
   * failed the contract or the socket (the problem says which). */
  ask(request: AssistantRequest, conversation: AssistantConversationChoice = "continue"): boolean {
    if (!canAsk(this.#view)) return false;
    const fresh = conversation === "new";
    const message = askMessage(fresh ? null : this.#view.conversation_id, request);
    if (!this.#write(message)) return false;
    const shown = fresh ? { conversation_id: null, turns: [], dropped: null } : {};
    this.#update({ ...this.#view, ...shown, pending: { request_id: message.request_id, request }, problem: null });
    return true;
  }

  /** Stop the live task. It still ends with `assistant.task.finished`, outcome `cancelled`. False when there is no
   * live task, a cancel is already out, or nothing went out. */
  cancel(): boolean {
    const live = this.#view.live;
    if (live === null || live.cancel_request_id !== null) return false;
    const message = cancelMessage(live.task_id);
    if (!this.#write(message)) return false;
    this.#update({ ...this.#view, live: { ...live, cancel_request_id: message.request_id } });
    return true;
  }

  /** Stop the reset timer for good: the panel is gone. */
  dispose(): void {
    this.#disposed = true;
    this.#arm(null);
  }

  /** Send `message` once it passes the contract. One that fails, or that the socket does not take, becomes the
   * problem. */
  #write(message: AssistantClientMessage): boolean {
    const problems = validateAssistantClientMessage(message);
    if (problems.length > 0) {
      this.#update({ ...this.#view, problem: { code: "INVALID", message: `The ${message.type} was not sent: ${problems.join("; ")}.` } });
      return false;
    }
    if (this.#send(message)) return true;
    this.#update({ ...this.#view, problem: { code: "OFFLINE", message: "The room is not connected. Try again when it is back." } });
    return false;
  }

  #update(view: AssistantView): void {
    this.#view = view;
    // While live, wait for the end of the allowance's month; going offline asks again on the way back anyway.
    this.#arm(view.online && !this.#disposed ? (view.allowance?.resets_at ?? null) : null);
    this.#onChange(view);
  }

  /** Wait for `resetsAt` and then ask for the status, or wait for nothing with null. */
  #arm(resetsAt: string | null): void {
    if (resetsAt === this.#resetAt) return;
    if (this.#resetTimer !== null) this.#clock.clearTimer(this.#resetTimer);
    this.#resetTimer = null;
    this.#resetAt = resetsAt;
    if (resetsAt !== null) this.#wait(resetsAt);
  }

  #wait(resetsAt: string): void {
    const due = Date.parse(resetsAt) + ASSISTANT_RESET_SLACK_MS;
    const left = due - this.#clock.now();
    // Past the instant, the status was asked already (or could not be): ask again only after the slack, never in a loop.
    const delay = left > 0 ? Math.min(left, MAX_TIMER_MS) : ASSISTANT_RESET_SLACK_MS;
    this.#resetTimer = this.#clock.setTimer(() => {
      this.#resetTimer = null;
      if (this.#clock.now() < due) return this.#wait(resetsAt);
      // Forget the month, so that a status still naming it waits again; one naming the next month waits for its end.
      this.#resetAt = null;
      this.#write(statusMessage());
    }, delay);
  }
}
