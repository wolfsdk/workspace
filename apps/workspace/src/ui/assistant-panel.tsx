/** @jsxImportSource preact */
// The assistant panel beside the open document (`wolfsdk.assistant.v1`): the turns of the conversation, the task
// running now as its steps and answer stream in, a card for each proposal the assistant opened, the request box,
// and a control that starts a new conversation (the earlier one stays stored, and its tasks still count).
// Before the server says it has an assistant, or when it says `not_configured`, there is no panel at all.
// `useAssistant` keeps the view of the room's connection; `AssistantPanel` holds whether the next ask starts a new
// conversation; `AssistantPanelView` only draws.
import {
  ASSISTANT_REQUEST_MAX_CHARS,
  type AssistantOutcome,
  type AssistantRequest,
  type AssistantStep,
  type AssistantStepStatus,
  type AssistantTurn,
  type RoomProposal,
} from "@wolfsdk/protocol/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type AssistantConversationChoice,
  type AssistantLiveTask,
  AssistantSession,
  type AssistantView,
  assistantShown,
  canAsk,
  EMPTY_ASSISTANT,
} from "../lib/assistant-client.ts";
import type { RoomHandle } from "../use-room.ts";
import { EmptyState, Icon, Time } from "./common.tsx";

export type AssistantHandle = {
  view: AssistantView;
  /** False when the ask did not go out; the view's problem says why. */
  ask(request: AssistantRequest, conversation?: AssistantConversationChoice): boolean;
  cancel(): void;
};

/** The assistant of the joined room: one session per room connection, which hears the room's assistant messages,
 * asks for the status and then the conversation each time the room goes live, asks for the status again when the
 * month of the allowance ends, and starts empty for another room. */
export function useAssistant(room: Pick<RoomHandle, "status" | "sendAssistant" | "subscribeAssistant">): AssistantHandle {
  const { status, sendAssistant, subscribeAssistant } = room;
  const [view, setView] = useState<AssistantView>(EMPTY_ASSISTANT);
  // `sendAssistant` is new for every room client, so a session lives exactly as long as one.
  const session = useMemo(() => new AssistantSession(sendAssistant, setView), [sendAssistant]);

  useEffect(() => {
    setView(session.view);
    const unsubscribe = subscribeAssistant((event) => session.receive(event));
    return () => {
      unsubscribe();
      session.dispose();
    };
  }, [session, subscribeAssistant]);

  useEffect(() => {
    session.connection(status);
  }, [session, status]);

  const ask = useCallback((request: AssistantRequest, conversation?: AssistantConversationChoice): boolean => session.ask(request, conversation), [session]);
  const cancel = useCallback((): void => void session.cancel(), [session]);
  return { view, ask, cancel };
}

export type AssistantPanelProps = {
  view: AssistantView;
  /** The document open beside the panel, and the selection in it as an address: what an ask is about. */
  docName: string | null;
  selection: string | null;
  /** The proposals of the room: the status of each one the assistant opened. */
  proposals: readonly RoomProposal[];
  /** A shared-link snapshot: there is no engine to open a diff in, so the cards offer no Inspect Diff. */
  shareMode?: boolean;
  /** Ask, in the conversation on show or (`"new"`) in a new one. */
  onAsk(request: AssistantRequest, conversation?: AssistantConversationChoice): boolean;
  onCancel(): void;
  /** Opens the review of a proposal, as Inspect Diff of the right rail does. */
  onInspect(proposal: RoomProposal): void;
};

export type AssistantPanelViewProps = AssistantPanelProps & {
  /** The user chose a new conversation and has not asked in it yet: the earlier turns are put away. */
  fresh: boolean;
  onNewConversation(): void;
};

type CardProps = Pick<AssistantPanelProps, "proposals" | "shareMode" | "onInspect">;

const STEP_STATUS: Record<AssistantStepStatus, { label: string; tone: string }> = {
  running: { label: "Running", tone: "info" },
  ok: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** How a turn ended, when it is not a plain answer. */
const OUTCOME: Record<Exclude<AssistantOutcome, "answered">, { label: string; tone: string }> = {
  proposed: { label: "Proposed changes", tone: "info" },
  cancelled: { label: "Stopped", tone: "muted" },
  failed: { label: "Failed", tone: "danger" },
  turn_limit: { label: "Reached the step limit", tone: "warning" },
  token_limit: { label: "Reached the token limit", tone: "warning" },
};

const PROPOSAL_STATUS: Record<RoomProposal["status"], { label: string; tone: string }> = {
  open: { label: "Open", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  superseded: { label: "Superseded", tone: "muted" },
  conflicted: { label: "Conflicted", tone: "warning" },
};

/** The assistant panel: `AssistantPanelView`, with the choice of a new conversation held until the next ask goes
 * out in it. */
export function AssistantPanel(props: AssistantPanelProps) {
  const [fresh, setFresh] = useState(false);
  const { onAsk } = props;
  const ask = useCallback(
    (request: AssistantRequest): boolean => {
      const sent = onAsk(request, fresh ? "new" : "continue");
      if (sent) setFresh(false);
      return sent;
    },
    [onAsk, fresh],
  );
  const startNew = useCallback(() => setFresh(true), []);
  return <AssistantPanelView {...props} fresh={fresh} onAsk={ask} onNewConversation={startNew} />;
}

export function AssistantPanelView(props: AssistantPanelViewProps) {
  const { view, docName, selection, fresh, onAsk, onCancel, onNewConversation } = props;
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const liveId = view.live?.task_id ?? null;

  // The box empties once the server takes the ask; a refused ask keeps its text to send again.
  useEffect(() => {
    if (liveId !== null) setDraft("");
  }, [liveId]);

  // Follow the conversation as it grows.
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [view.turns, view.pending, view.live, view.dropped, fresh]);

  if (!assistantShown(view)) return null;

  const { allowance, live } = view;
  // A new conversation puts the earlier turns away; the server keeps them.
  const turns = fresh ? [] : view.turns;
  const dropped = fresh ? null : view.dropped;
  const exhausted = view.state === "allowance_exhausted";
  const askable = canAsk(view);
  const cancelling = live !== null && live.cancel_request_id !== null;
  const empty = turns.length === 0 && view.pending === null && live === null && dropped === null;
  // Nothing to leave, or a request under way that belongs to the conversation on show.
  const renewable = !fresh && view.pending === null && live === null && (view.conversation_id !== null || view.turns.length > 0 || view.dropped !== null);
  const submit = (): void => {
    const text = draft.trim();
    if (text !== "" && askable) onAsk({ text, doc_name: docName, target_address: selection });
  };
  const placeholder = exhausted
    ? "No assistant tasks left this month"
    : !view.online
      ? "Waiting for the room to reconnect"
      : docName
        ? `Ask for a change to ${docName}`
        : "Ask for a change";

  return (
    <aside class="rail rail--assistant" aria-label="Assistant">
      <div class="rail-section assistant-head">
        <div class="rail-heading">
          <h2>Assistant</h2>
          {allowance !== null && allowance.limit !== null ? (
            <span class="assistant-meter">
              {allowance.used} of {allowance.limit} tasks this month
            </span>
          ) : null}
          <button type="button" class="button button--small" disabled={!renewable} title="Start a new conversation; this one stays saved" onClick={onNewConversation}>
            <Icon name="plus" size={14} />
            New conversation
          </button>
        </div>
        {view.model ? <p class="assistant-model">{view.model}</p> : null}
      </div>
      <div class="assistant-log" ref={log}>
        {empty ? (
          fresh ? (
            <EmptyState title="New conversation">
              <p>The next request starts a new conversation. The earlier one stays saved and comes back when you reload.</p>
            </EmptyState>
          ) : (
            <EmptyState title="No requests yet">
              <p>Ask for a change to the open document. The assistant opens proposals for you to review and never commits them.</p>
            </EmptyState>
          )
        ) : (
          <ol class="assistant-turns">
            {turns.map((turn) => (
              <Turn key={turn.task_id} turn={turn} {...props} />
            ))}
            {dropped ? <Task task={dropped} dropped {...props} /> : null}
            {view.pending ? (
              <li class="assistant-turn" aria-busy="true">
                <Request request={view.pending.request} />
                <p class="hint hint--progress">Waiting for the assistant</p>
              </li>
            ) : null}
            {live ? <Task task={live} dropped={false} {...props} /> : null}
          </ol>
        )}
      </div>
      <div class="rail-section assistant-foot">
        {exhausted && allowance !== null ? (
          <div class="notice notice--warning assistant-exhausted" role="status">
            <span>
              This month's assistant tasks are used up. They reset <Time at={allowance.resets_at} />. Editing, review and comments still work.
            </span>
          </div>
        ) : null}
        {view.problem ? (
          <div class="notice notice--danger" role="alert">
            {view.problem.message}
          </div>
        ) : null}
        <form
          class="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            class="input composer-input"
            rows={3}
            maxLength={ASSISTANT_REQUEST_MAX_CHARS}
            aria-label="Request to the assistant"
            placeholder={placeholder}
            value={draft}
            disabled={!askable}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div class="composer-bar">
            <span class="assistant-context" title="What the request is about">
              {docName ? <code class="chip chip--static">{docName}</code> : null}
              {selection ? <code class="chip chip--static">{selection}</code> : null}
            </span>
            <span class="composer-actions">
              {live ? (
                <button type="button" class="button button--small button--danger-quiet" disabled={cancelling || !view.online} onClick={onCancel}>
                  <Icon name="x" size={14} />
                  {cancelling ? "Stopping" : "Stop"}
                </button>
              ) : (
                <button type="submit" class="button button--small button--primary" disabled={!askable || draft.trim() === ""}>
                  Ask
                </button>
              )}
            </span>
          </div>
        </form>
      </div>
    </aside>
  );
}

function Turn({ turn, ...cards }: { turn: AssistantTurn } & CardProps) {
  return (
    <li class="assistant-turn">
      <Request request={turn.request} at={turn.started_at} />
      <Steps steps={turn.steps} />
      {turn.answer !== "" ? <p class="assistant-answer">{turn.answer}</p> : null}
      {turn.outcome === "answered" ? null : (
        <p class="assistant-outcome">
          <span class={`status status--${OUTCOME[turn.outcome].tone}`}>{OUTCOME[turn.outcome].label}</span>
        </p>
      )}
      {turn.failure !== null ? <p class="assistant-failure">{turn.failure}</p> : null}
      <ProposalCards steps={turn.steps} {...cards} />
    </li>
  );
}

/** The live task as it streams, or the one the connection dropped under, as far as it got. */
function Task({ task, dropped, ...cards }: { task: AssistantLiveTask; dropped: boolean } & CardProps) {
  return (
    <li class="assistant-turn" aria-busy={dropped ? undefined : "true"}>
      {task.request ? <Request request={task.request} at={task.started_at} /> : null}
      <Steps steps={task.steps} />
      {task.text !== "" ? <p class="assistant-answer">{task.text}</p> : null}
      {dropped ? (
        <div class="notice notice--warning">The connection dropped before this task finished. Its result shows here when the conversation reloads.</div>
      ) : (
        <p class="hint hint--progress">{task.cancel_request_id !== null ? "Stopping" : "Working"}</p>
      )}
      <ProposalCards steps={task.steps} {...cards} />
    </li>
  );
}

function Request({ request, at }: { request: AssistantRequest; at?: string }) {
  return (
    <div class="assistant-request">
      <p class="assistant-request-text">{request.text}</p>
      {request.doc_name || request.target_address || at ? (
        <p class="assistant-meta">
          {request.doc_name ? <span>{request.doc_name}</span> : null}
          {request.target_address ? <code>{request.target_address}</code> : null}
          {at ? <Time at={at} /> : null}
        </p>
      ) : null}
    </div>
  );
}

function Steps({ steps }: { steps: readonly AssistantStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol class="assistant-steps" aria-label="Steps">
      {steps.map((s) => (
        <li key={s.step} class="assistant-step">
          <span class="assistant-step-head">
            <code>{s.tool}</code>
            {s.doc_name ? <span class="assistant-step-doc">{s.doc_name}</span> : null}
            <span class={`status status--${STEP_STATUS[s.status].tone}`}>{STEP_STATUS[s.status].label}</span>
          </span>
          {s.summary ? <span class="assistant-step-summary">{s.summary}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** An Agent API operation name as words: `replace-text` is "replace text". */
const opWords = (op: string): string => op.replace(/[-_.]+/g, " ").trim().toLowerCase();

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The change of a proposal in words, for the title of its card: the label of its edit; else what its operations
 * do, on which document; else, when the room has not listed it yet, the summary of the step that opened it. Never
 * its id. */
export function proposalTitle(proposal: RoomProposal | undefined, step: AssistantStep): string {
  const label = proposal?.batches.map((b) => b.label?.trim() ?? "").find((l) => l !== "");
  if (label) return label;
  if (proposal) {
    const ops = proposal.batches.flatMap((b) => b.ops);
    const kinds = [...new Set(ops.map((o) => opWords(o.op)).filter((k) => k !== ""))];
    if (ops.length === 1 && kinds.length === 1) return `${capitalized(kinds[0]!)} in ${proposal.doc_name}`;
    if (ops.length > 1) return `${ops.length} changes to ${proposal.doc_name}${kinds.length > 0 && kinds.length <= 3 ? `: ${kinds.join(", ")}` : ""}`;
    return `A change to ${proposal.doc_name}`;
  }
  const summary = step.summary?.trim();
  if (summary && summary !== step.proposal_id) return summary;
  return step.doc_name ? `A proposed change to ${step.doc_name}` : "A proposed change";
}

/** A card per proposal the assistant opened, in the order of the steps that opened them, with its status in the
 * room. An open one offers Inspect Diff, which opens the same review as the right rail. */
function ProposalCards({ steps, proposals, shareMode, onInspect }: { steps: readonly AssistantStep[] } & CardProps) {
  const opened = steps.filter((s) => s.proposal_id !== undefined);
  if (opened.length === 0) return null;
  return (
    <ul class="cards" aria-label="Proposals">
      {opened.map((step) => {
        const id = step.proposal_id!;
        const proposal = proposals.find((p) => p.proposal_id === id);
        const title = proposalTitle(proposal, step);
        return (
          <li key={id} class="card" data-proposal-id={id}>
            <div class="card-row">
              <p class="card-title">{title}</p>
              {proposal ? <span class={`status status--${PROPOSAL_STATUS[proposal.status].tone}`}>{PROPOSAL_STATUS[proposal.status].label}</span> : null}
            </div>
            {proposal ? <p class="card-meta">Proposed on {proposal.doc_name}</p> : null}
            {proposal?.status === "open" && !shareMode ? (
              <div class="card-actions">
                <button type="button" class="button button--small" aria-label={`Inspect Diff of ${title}`} onClick={() => onInspect(proposal)}>
                  <Icon name="eye" size={14} />
                  Inspect Diff
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
