/** @jsxImportSource preact */
// Right rail: proposals to review, comment threads anchored in the document, and the session history.
import type { RoomActor, RoomMention, RoomProposal, RoomSessionEntry, RoomThread } from "@wolfsdk/protocol/workspace";
import { useState } from "preact/hooks";
import { ACTIVITY_LABEL, type ActivityItem, proposalSize } from "../lib/room-state.ts";
import { mentionHandle, mentionsIn, shortSha } from "../lib/session.ts";
import { ActorBadge, EmptyState, Icon, Time } from "./common.tsx";

export type RightTab = "proposals" | "comments" | "history";

export type CommentPost = {
  thread_id: string | null;
  target_address: string;
  body: string;
  mentions: RoomMention[];
  resolve?: boolean;
};

export type RightRailProps = {
  tab: RightTab;
  onTab(tab: RightTab): void;
  actor: RoomActor;
  activeDoc: string | null;
  allDocs: boolean;
  onAllDocs(all: boolean): void;
  proposals: RoomProposal[];
  focusedProposal: string | null;
  deciding: string | null;
  onInspect(proposal: RoomProposal): void;
  onDecide(proposal: RoomProposal, decision: "approve" | "reject"): void;
  onDownloadPreview(proposal: RoomProposal): void;
  threads: RoomThread[];
  selection: string | null;
  participants: RoomActor[];
  onComment(post: CommentPost): Promise<boolean>;
  history: RoomSessionEntry[];
  activity: ActivityItem[];
  /** A shared-link snapshot: there is no engine to open a diff in, so proposals offer no Inspect Diff. */
  shareMode?: boolean;
  /** A guest: proposals show with no Approve, Reject or preview download, since a guest decides nothing and exports
   * nothing. */
  guest?: boolean;
};

const TABS: { id: RightTab; label: string }[] = [
  { id: "proposals", label: "Proposals" },
  { id: "comments", label: "Comments" },
  { id: "history", label: "History" },
];

export function RightRail(props: RightRailProps) {
  const open = props.proposals.filter((p) => p.status === "open").length;
  const unresolved = props.threads.filter((t) => !t.resolved).length;
  const counts: Record<RightTab, number> = { proposals: open, comments: unresolved, history: 0 };
  return (
    <aside class="rail rail--right" aria-label="Review">
      <div class="tabs" role="tablist" aria-label="Review panels">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={props.tab === tab.id}
            aria-controls={`panel-${tab.id}`}
            class={`tab${props.tab === tab.id ? " is-active" : ""}`}
            onClick={() => props.onTab(tab.id)}
          >
            {tab.label}
            {counts[tab.id] > 0 ? <span class="tab-count">{counts[tab.id]}</span> : null}
          </button>
        ))}
      </div>
      <div class="scope">
        <label class="toggle">
          <input type="checkbox" checked={props.allDocs} onChange={(e) => props.onAllDocs(e.currentTarget.checked)} />
          <span>All documents</span>
        </label>
        <span class="scope-doc" title={props.activeDoc ?? undefined}>
          {props.allDocs ? "Whole room" : (props.activeDoc ?? "No document")}
        </span>
      </div>
      <div class="panel" role="tabpanel" id={`panel-${props.tab}`} aria-labelledby={`tab-${props.tab}`}>
        {props.tab === "proposals" ? <Proposals {...props} /> : null}
        {props.tab === "comments" ? <Comments {...props} /> : null}
        {props.tab === "history" ? <History {...props} /> : null}
      </div>
    </aside>
  );
}

const STATUS_TONE: Record<RoomProposal["status"], string> = {
  open: "info",
  approved: "success",
  rejected: "danger",
  superseded: "muted",
  conflicted: "warning",
};

const STATUS_LABEL: Record<RoomProposal["status"], string> = {
  open: "Open",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
  conflicted: "Conflicted",
};

function Proposals({ proposals, history, actor, allDocs, shareMode, guest, focusedProposal, deciding, onInspect, onDecide, onDownloadPreview }: RightRailProps) {
  if (proposals.length === 0) {
    return (
      <EmptyState title="No proposals">
        <p>Proposals from agents and teammates appear here for review.</p>
      </EmptyState>
    );
  }
  const isAgent = actor.kind === "agent";
  return (
    <ul class="cards">
      {guest ? (
        <li class="notice notice--info">You are a guest here. Your edits go in as proposals, and a member of the workspace approves or rejects them.</li>
      ) : isAgent ? (
        <li class="notice notice--info">You are signed in as an agent. Only a user can approve or reject a proposal.</li>
      ) : null}
      {proposals.map((proposal) => {
        const size = proposalSize(proposal);
        const open = proposal.status === "open";
        // The commit an approval made carries the approver; the card shows who accepted it.
        const approver =
          proposal.status === "approved" ? (history.find((h) => h.proposal_id === proposal.proposal_id && h.approved_by !== null)?.approved_by ?? null) : null;
        const busy = deciding === proposal.proposal_id;
        return (
          <li key={proposal.proposal_id} class={`card${focusedProposal === proposal.proposal_id ? " is-focused" : ""}`}>
            <div class="card-row">
              <ActorBadge actor={proposal.author} you={proposal.author.id === actor.id} />
              <span class={`status status--${STATUS_TONE[proposal.status]}`}>{STATUS_LABEL[proposal.status]}</span>
            </div>
            <p class="card-title">{proposal.batches[0]?.label ?? proposal.proposal_id}</p>
            <p class="card-meta">
              <code>{proposal.proposal_id}</code>
              {allDocs ? <span> on {proposal.doc_name}</span> : null}
              <span>
                {" "}
                · {size.batches} {size.batches === 1 ? "batch" : "batches"}, {size.ops} {size.ops === 1 ? "op" : "ops"} on r{proposal.base_revision}
              </span>
            </p>
            <p class="card-meta">
              <Time at={proposal.created_at} />
            </p>
            {approver ? (
              <p class="card-meta">
                approved by <strong>{approver.name}</strong>
              </p>
            ) : null}
            <div class="card-actions">
              {open && !shareMode ? (
                <button type="button" class="button button--small" onClick={() => onInspect(proposal)}>
                  <Icon name="eye" size={14} />
                  Inspect Diff
                </button>
              ) : null}
              {proposal.preview_sha256 && !guest ? (
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`Download preview of ${proposal.proposal_id}`}
                  title={`Download preview (${shortSha(proposal.preview_sha256)})`}
                  onClick={() => onDownloadPreview(proposal)}
                >
                  <Icon name="download" size={14} />
                </button>
              ) : null}
              {open && !guest ? (
                <span class="card-decide">
                  <button
                    type="button"
                    class="button button--small button--danger-quiet"
                    disabled={isAgent || busy}
                    title={isAgent ? "Only a user can reject a proposal" : undefined}
                    onClick={() => onDecide(proposal, "reject")}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    class="button button--small button--success"
                    disabled={isAgent || busy}
                    title={isAgent ? "Only a user can approve a proposal" : undefined}
                    onClick={() => onDecide(proposal, "approve")}
                  >
                    {busy ? "Deciding" : "Approve"}
                  </button>
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Composer({
  placeholder,
  submitLabel,
  participants,
  onSubmit,
  extra,
}: {
  placeholder: string;
  submitLabel: string;
  participants: RoomActor[];
  onSubmit(body: string, mentions: RoomMention[], resolve: boolean): Promise<boolean>;
  extra?: "resolve";
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const agents = participants.filter((p) => p.kind === "agent");
  const send = async (resolve: boolean): Promise<void> => {
    if (body.trim() === "" && !resolve) return;
    setBusy(true);
    const text = body.trim() === "" ? "Resolved." : body.trim();
    if (await onSubmit(text, mentionsIn(text, participants), resolve)) setBody("");
    setBusy(false);
  };
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send(false);
      }}
    >
      <textarea
        class="input composer-input"
        rows={2}
        placeholder={placeholder}
        value={body}
        onInput={(e) => setBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send(false);
          }
        }}
      />
      <div class="composer-bar">
        {agents.length > 0 ? (
          <span class="mentions" aria-label="Mention an agent">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                class="chip"
                title={`Mention ${agent.name}`}
                onClick={() => setBody((current) => `${current}${current === "" || current.endsWith(" ") ? "" : " "}${mentionHandle(agent)} `)}
              >
                {mentionHandle(agent)}
              </button>
            ))}
          </span>
        ) : (
          <span />
        )}
        <span class="composer-actions">
          {extra === "resolve" ? (
            <button type="button" class="button button--small button--quiet" disabled={busy} onClick={() => void send(true)}>
              <Icon name="check" size={14} />
              Resolve
            </button>
          ) : null}
          <button type="submit" class="button button--small button--primary" disabled={busy || body.trim() === ""}>
            {submitLabel}
          </button>
        </span>
      </div>
    </form>
  );
}

function Comments({ threads, activeDoc, selection, participants, actor, onComment }: RightRailProps) {
  const [anchor, setAnchor] = useState("");
  return (
    <div class="comments">
      {activeDoc ? (
        <section class="new-thread" aria-label="New comment">
          <div class="anchor-row">
            <label class="anchor-field">
              <span class="field-label">Anchor</span>
              <input
                class="input input--mono"
                placeholder="Address, like /body/p[3]"
                value={anchor}
                onInput={(e) => setAnchor(e.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              class="button button--small"
              disabled={selection === null}
              title={selection === null ? "Select something in the document first" : `Anchor to ${selection}`}
              onClick={() => selection !== null && setAnchor(selection)}
            >
              <Icon name="anchor" size={14} />
              Anchor to selection
            </button>
          </div>
          {selection !== null ? (
            <p class="hint">
              Selected <code class="chip chip--static">{selection}</code>
            </p>
          ) : null}
          <Composer
            placeholder={anchor.trim() === "" ? "Pick an anchor, then write a comment" : `Comment on ${anchor.trim()}`}
            submitLabel="Comment"
            participants={participants}
            onSubmit={(body, mentions) =>
              anchor.trim() === ""
                ? Promise.resolve(false)
                : onComment({ thread_id: null, target_address: anchor.trim(), body, mentions }).then((ok) => {
                    if (ok) setAnchor("");
                    return ok;
                  })
            }
          />
        </section>
      ) : null}
      {threads.length === 0 ? (
        <EmptyState title="No comments">
          <p>Select something in the document, click Anchor to selection, and start a thread.</p>
        </EmptyState>
      ) : (
        <ul class="cards">
          {threads.map((thread) => (
            <li key={thread.thread_id} class={`card thread${thread.resolved ? " is-resolved" : ""}`}>
              <div class="card-row">
                <code class="chip chip--static" title={`${thread.doc_name} ${thread.target_address}`}>
                  {thread.target_address}
                </code>
                <span class={`status status--${thread.resolved ? "success" : "info"}`}>{thread.resolved ? "Resolved" : "Open"}</span>
              </div>
              <ol class="messages">
                {thread.messages.map((message) => (
                  <li key={message.message_id} class="message">
                    <div class="message-head">
                      <ActorBadge actor={message.author} you={message.author.id === actor.id} />
                      <Time at={message.created_at} />
                    </div>
                    <p class="message-body">{message.body}</p>
                  </li>
                ))}
              </ol>
              {thread.resolved ? (
                <button
                  type="button"
                  class="button button--small button--quiet"
                  title="A resolved thread stays resolved: this starts a new thread at the same anchor"
                  onClick={() =>
                    void onComment({
                      thread_id: null,
                      target_address: thread.target_address,
                      body: `Reopened from thread ${thread.thread_id}.`,
                      mentions: thread.mentions,
                    })
                  }
                >
                  Reopen
                </button>
              ) : (
                <Composer
                  placeholder="Reply"
                  submitLabel="Reply"
                  participants={participants}
                  extra="resolve"
                  onSubmit={(body, mentions, resolve) =>
                    onComment({ thread_id: thread.thread_id, target_address: thread.target_address, body, mentions, resolve })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function History({ history, activity, allDocs, activeDoc }: RightRailProps) {
  const live = activity.filter((a) => allDocs || a.doc_name === null || a.doc_name === activeDoc).slice(0, 30);
  return (
    <div class="history">
      <section aria-labelledby="activity-title">
        <h3 id="activity-title" class="panel-heading">
          Agent activity
        </h3>
        {live.length === 0 ? (
          <p class="hint">No agent activity since you joined.</p>
        ) : (
          <ol class="activity">
            {live.map((item) => (
              <li key={item.seq} class={`activity-row activity-row--${item.activity}`}>
                <span class="activity-dot" aria-hidden="true" />
                <span class="activity-text">
                  <strong>{item.agent.name}</strong> {ACTIVITY_LABEL[item.activity].toLowerCase()}
                  {item.detail ? <span class="activity-detail"> {item.detail}</span> : null}
                  {allDocs && item.doc_name ? <span class="activity-detail"> in {item.doc_name}</span> : null}
                </span>
                <Time at={item.at} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="commits-title">
        <h3 id="commits-title" class="panel-heading">
          Commits
        </h3>
        {history.length === 0 ? (
          <p class="hint">No commits yet. Committed edits and approved proposals appear here.</p>
        ) : (
          <ol class="timeline">
            {history.map((entry) => (
              <li key={entry.seq} class="timeline-row">
                <div class="timeline-head">
                  <span class="badge">r{entry.revision}</span>
                  <span class="timeline-label">{entry.batch.label ?? `${entry.batch.ops.length} ${entry.batch.ops.length === 1 ? "op" : "ops"}`}</span>
                </div>
                <div class="timeline-meta">
                  <ActorBadge actor={entry.author} />
                  {entry.approved_by ? (
                    <span>
                      approved by <strong>{entry.approved_by.name}</strong>
                    </span>
                  ) : null}
                  {entry.proposal_id ? <code>{entry.proposal_id}</code> : null}
                </div>
                <div class="timeline-meta">
                  <span>#{entry.seq}</span>
                  {allDocs ? <span>{entry.doc_name}</span> : null}
                  <code title={entry.result_sha256}>sha256 {shortSha(entry.result_sha256)}</code>
                  <Time at={entry.committed_at} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
