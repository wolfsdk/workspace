// The room as the browser holds it: the last `room.snapshot`, kept current by the events after it, plus the live
// stream of agent activity. Pure functions over `@wolfsdk/protocol/workspace` values; no DOM, no socket.
import type {
  RoomActor,
  RoomAgentActivity,
  RoomProposal,
  RoomDocument,
  RoomServerEvent,
  RoomSessionEntry,
  RoomState,
  RoomThread,
  WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";

/** One `agent.activity` event as the activity stream lists it. */
export type ActivityItem = Extract<RoomServerEvent, { type: "agent.activity" }>;

export type RoomView = {
  room: RoomState | null;
  /** Agent activity, newest first, at most `ACTIVITY_LIMIT`. */
  activity: ActivityItem[];
};

export const ACTIVITY_LIMIT = 200;
export const EMPTY_VIEW: RoomView = { room: null, activity: [] };

const upsert = <T>(items: readonly T[], item: T, same: (a: T) => boolean): T[] => {
  const at = items.findIndex(same);
  return at < 0 ? [...items, item] : items.map((existing, i) => (i === at ? item : existing));
};

/** The view after `event`. A snapshot replaces the room; any other event before the first snapshot, or with a
 * `seq` the room already has (a replay after a reconnect), changes nothing. `error` events never change it. */
export function applyRoomEvent(view: RoomView, event: RoomServerEvent): RoomView {
  if (event.type === "error") return view;
  if (event.type === "room.snapshot") return { ...view, room: event.room };
  const room = view.room;
  if (room === null || event.seq <= room.seq) return view;
  const next: RoomState = { ...room, seq: event.seq };
  switch (event.type) {
    case "doc.added":
      next.documents = upsert(room.documents, event.document, (d) => d.head.name === event.document.head.name);
      return { ...view, room: next };
    case "doc.committed": {
      const same = (d: RoomDocument): boolean => d.head.name === event.head.name;
      // The page hashes stay until `pages.invalidated` replaces them.
      next.documents = upsert(room.documents, { ...room.documents.find(same), head: event.head }, same);
      next.session_log = [...room.session_log, event.entry];
      return { ...view, room: next };
    }
    case "proposal.updated":
      next.proposals = upsert(room.proposals, event.proposal, (p) => p.proposal_id === event.proposal.proposal_id);
      return { ...view, room: next };
    case "pages.invalidated":
      next.documents = room.documents.map((d) => (d.head.name === event.doc_name ? { ...d, page_hashes: event.page_hashes } : d));
      return { ...view, room: next };
    case "comment.updated":
      next.comments = upsert(room.comments, event.thread, (t) => t.thread_id === event.thread.thread_id);
      return { ...view, room: next };
    case "agent.activity":
      return { room: next, activity: [event, ...view.activity].slice(0, ACTIVITY_LIMIT) };
  }
}

/** The highest `seq` the view has seen: what a reconnect passes as `since_seq`. Null before the first snapshot. */
export const lastSeqOf = (view: RoomView): number | null => view.room?.seq ?? null;

export type DocumentSummary = {
  name: string;
  format: WorkspaceDocFormat;
  revision: number;
  sha256: string;
  updated_at: string;
  openProposals: number;
  openThreads: number;
};

/** The documents of a room, by name, with their open proposals and unresolved threads counted. */
export function documentSummaries(room: RoomState | null): DocumentSummary[] {
  if (room === null) return [];
  return room.documents
    .map(({ head }) => ({
      name: head.name,
      format: head.format,
      revision: head.revision,
      sha256: head.sha256,
      updated_at: head.updated_at,
      openProposals: room.proposals.filter((p) => p.doc_name === head.name && p.status === "open").length,
      openThreads: room.comments.filter((t) => t.doc_name === head.name && !t.resolved).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Proposals of one document (or of all, for `null`): open ones first, then newest first. */
export function proposalsOf(room: RoomState | null, doc: string | null): RoomProposal[] {
  if (room === null) return [];
  return room.proposals
    .filter((p) => doc === null || p.doc_name === doc)
    .sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.created_at.localeCompare(a.created_at));
}

/** Threads of one document: unresolved first, then by their latest message, newest first. */
export function threadsOf(room: RoomState | null, doc: string | null): RoomThread[] {
  if (room === null) return [];
  const latest = (t: RoomThread): string => t.messages.at(-1)?.created_at ?? "";
  return room.comments
    .filter((t) => doc === null || t.doc_name === doc)
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || latest(b).localeCompare(latest(a)));
}

/** Session commits of one document (or all), newest first. */
export function historyOf(room: RoomState | null, doc: string | null): RoomSessionEntry[] {
  if (room === null) return [];
  return room.session_log.filter((e) => doc === null || e.doc_name === doc).sort((a, b) => b.seq - a.seq);
}

/** How many batches and ops a proposal holds. */
export function proposalSize(proposal: RoomProposal): { batches: number; ops: number } {
  return { batches: proposal.batches.length, ops: proposal.batches.reduce((n, b) => n + b.ops.length, 0) };
}

/** Everyone the room has seen act (authors, approvers, commenters, agents at work), one entry per kind and id. */
export function participantsOf(view: RoomView): RoomActor[] {
  const seen = new Map<string, RoomActor>();
  const add = (actor: RoomActor): void => {
    if (!seen.has(`${actor.kind}:${actor.id}`)) seen.set(`${actor.kind}:${actor.id}`, actor);
  };
  const room = view.room;
  if (room !== null) {
    for (const p of room.proposals) add(p.author);
    for (const e of room.session_log) {
      add(e.author);
      if (e.approved_by) add(e.approved_by);
    }
    for (const t of room.comments) for (const m of t.messages) add(m.author);
  }
  for (const a of view.activity) add({ kind: "agent", id: a.agent.id, name: a.agent.name });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The latest activity of each agent on `doc` (room-wide activity included), oldest first: what to replay into a
 * freshly opened `<wolf-review>` so its presence bar starts current. Agents whose latest word is `idle` drop out. */
export function presenceFor(activity: readonly ActivityItem[], doc: string): ActivityItem[] {
  const latest = new Map<string, ActivityItem>();
  for (const item of activity) {
    if (item.doc_name !== null && item.doc_name !== doc) continue;
    if (!latest.has(item.agent.id)) latest.set(item.agent.id, item);
  }
  return [...latest.values()].filter((item) => item.activity !== "idle").sort((a, b) => a.seq - b.seq);
}

export const ACTIVITY_LABEL: Record<RoomAgentActivity, string> = {
  reading: "Reading",
  searching: "Searching",
  inspecting: "Inspecting",
  proposing: "Proposing",
  committing: "Committing",
  replying: "Replying",
  idle: "Idle",
};
