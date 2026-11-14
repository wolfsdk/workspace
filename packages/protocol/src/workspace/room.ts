// The collaboration room (`wolfsdk.room.v1`): the state of one room (documents with canonical heads, the
// session log, proposals, comment threads) and the JSON messages of its WebSocket. Nothing here touches the
// DOM, Preact or a kernel. The schema checks the shape of every value; the functions below add what a
// schema can not say (heads agree with the log, ids are unique, pages invalidated are real pages).
import { validateSchema, type Schema } from "../session/record.ts";
import roomSchema from "../../schemas/room.v1.schema.json" with { type: "json" };
import type { WorkspaceDocFormat } from "./reactor-pipe.ts";

export const ROOM_CONTRACT = "wolfsdk.room.v1";
export const ROOM_SCHEMA: Schema = roomSchema;

export const ROOM_PROPOSAL_STATUSES = ["open", "approved", "rejected", "superseded", "conflicted"] as const;
export type RoomProposalStatus = (typeof ROOM_PROPOSAL_STATUSES)[number];

export const ROOM_AGENT_ACTIVITIES = ["reading", "searching", "inspecting", "proposing", "committing", "replying", "idle"] as const;
export type RoomAgentActivity = (typeof ROOM_AGENT_ACTIVITIES)[number];

/** `code` of an `error` event that is not a revision mismatch. `ENGINE_FAILED` means the engine could not run
 * the request (it crashed, timed out, reached a memory or document budget, reported an internal error, or did
 * not reproduce a proposal's preview): nothing was stored, the request itself was not judged, and the same
 * request can succeed later. `BAD_REQUEST` stays the code for a request the engine judged and refused. */
export const ROOM_ERROR_CODES = [
  "BAD_REQUEST",
  "UNKNOWN_ROOM",
  "UNKNOWN_DOCUMENT",
  "UNKNOWN_PROPOSAL",
  "UNKNOWN_THREAD",
  "FORBIDDEN",
  "PROPOSAL_NOT_OPEN",
  "LICENSE_LIMIT",
  "ENGINE_FAILED",
] as const;
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[number];

/** `code` of the `error` event that answers a `doc.edit` made against a stale revision. */
export const ROOM_REVISION_MISMATCH = "REVISION_MISMATCH";

export const ROOM_SERVER_EVENT_TYPES = [
  "room.snapshot",
  "doc.added",
  "doc.committed",
  "proposal.updated",
  "pages.invalidated",
  "comment.updated",
  "agent.activity",
  "error",
] as const;
export type RoomServerEventType = (typeof ROOM_SERVER_EVENT_TYPES)[number];

export const ROOM_CLIENT_MESSAGE_TYPES = ["room.join", "doc.edit", "proposal.decide", "comment.post"] as const;
export type RoomClientMessageType = (typeof ROOM_CLIENT_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoomActorKind = "agent" | "user";
export type RoomActor = { kind: RoomActorKind; id: string; name: string };
export type RoomMention = { kind: RoomActorKind; id: string };

/** The canonical head of one document: the last committed revision. */
export type RoomHead = { revision: number; sha256: string; format: WorkspaceDocFormat; name: string; updated_at: string };
export type RoomDocument = { head: RoomHead; page_hashes?: string[] };

/** One Agent API operation, passed to the engine untouched. */
export type RoomOp = { op: string; [member: string]: unknown };
/** One operation batch. A client may pin any of `clock`, `timezone`, `locale` and `seed` in `doc.edit`; the
 * server pins the rest when it accepts the batch. */
export type RoomBatch = { ops: RoomOp[]; label?: string; clock?: string; timezone?: string; locale?: string; seed?: number };
/** A batch of a proposal or of a session entry: it names the clock, timezone, locale and seed it ran under, so
 * replaying a document's entries reproduces its head `sha256` and replaying a proposal at approval reproduces
 * its preview. */
export type RoomPinnedBatch = RoomBatch & { clock: string; timezone: string; locale: string; seed: number };

export type RoomSessionEntry = {
  seq: number;
  doc_name: string;
  revision: number;
  base_sha256: string;
  result_sha256: string;
  author: RoomActor;
  batch: RoomPinnedBatch;
  proposal_id: string | null;
  /** The user who approved the proposal this commit came from; null for a direct commit. */
  approved_by: RoomActor | null;
  committed_at: string;
};

export type RoomProposal = {
  proposal_id: string;
  doc_name: string;
  base_revision: number;
  author: RoomActor;
  status: RoomProposalStatus;
  batches: RoomPinnedBatch[];
  preview_sha256: string | null;
  created_at: string;
};

export type RoomMessage = { message_id: string; author: RoomActor; body: string; created_at: string };
export type RoomThread = {
  thread_id: string;
  doc_name: string;
  target_address: string;
  mentions: RoomMention[];
  messages: RoomMessage[];
  resolved: boolean;
};

export type RoomConflictDetail = { doc_name: string; base_revision: number; head: RoomHead };

export type RoomState = {
  contract: typeof ROOM_CONTRACT;
  room_id: string;
  workspace_id: string;
  seq: number;
  documents: RoomDocument[];
  session_log: RoomSessionEntry[];
  proposals: RoomProposal[];
  comments: RoomThread[];
};

export type RoomServerEvent =
  | { type: "room.snapshot"; seq: number; room: RoomState }
  | { type: "doc.added"; seq: number; document: RoomDocument }
  | { type: "doc.committed"; seq: number; head: RoomHead; entry: RoomSessionEntry }
  | { type: "proposal.updated"; seq: number; proposal: RoomProposal }
  | {
      type: "pages.invalidated";
      seq: number;
      doc_name: string;
      revision: number;
      sha256: string;
      page_hashes: string[];
      changed: number[];
      removed: number[];
    }
  | { type: "comment.updated"; seq: number; thread: RoomThread }
  | {
      type: "agent.activity";
      seq: number;
      agent: { id: string; name: string };
      doc_name: string | null;
      activity: RoomAgentActivity;
      detail?: string;
      at: string;
    }
  | { type: "error"; request_id: string | null; code: typeof ROOM_REVISION_MISMATCH; message: string; detail: RoomConflictDetail }
  | { type: "error"; request_id: string | null; code: RoomErrorCode; message: string };

export type RoomClientMessage =
  | { type: "room.join"; request_id: string; room_id: string; since_seq: number | null }
  | { type: "doc.edit"; request_id: string; doc_name: string; base_revision: number; mode: "propose" | "commit"; batch: RoomBatch }
  | { type: "proposal.decide"; request_id: string; proposal_id: string; decision: "approve" | "reject" }
  | {
      type: "comment.post";
      request_id: string;
      thread_id: string | null;
      doc_name: string;
      target_address: string;
      body: string;
      mentions: RoomMention[];
      /** Mark the thread resolved with this message (reply only). */
      resolve?: boolean;
    };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function validateDef(def: string, value: unknown): string[] {
  return validateSchema({ $defs: ROOM_SCHEMA.$defs, $ref: `#/$defs/${def}` }, value);
}

/** Whether `text` is an RFC 3339 UTC instant (`2026-11-13T09:30:00Z`, optional fraction) that exists on the
 * calendar. The timestamp pattern of the schemas alone admits `2026-13-45T99:99:99Z`; this reads the parts. */
export function isWorkspaceInstant(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(text);
  if (!m) return false;
  const [year = 0, month = 0, day = 0, hour = 99, minute = 99, second = 99] = m.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60;
}

function instant(path: string, text: string, out: string[]): void {
  if (!isWorkspaceInstant(text)) out.push(`${path}: not a calendar instant`);
}

function batchProblems(path: string, batch: RoomBatch, out: string[]): void {
  if (batch.ops.length === 0) out.push(`${path}.ops: a batch has at least one op`);
  if (batch.clock !== undefined) instant(`${path}.clock`, batch.clock, out);
}

function proposalProblems(path: string, p: RoomProposal, out: string[]): void {
  instant(`${path}.created_at`, p.created_at, out);
  if (p.batches.length === 0) out.push(`${path}.batches: a proposal has at least one batch`);
  p.batches.forEach((b, i) => batchProblems(`${path}.batches[${i}]`, b, out));
  if ((p.status === "open" || p.status === "approved") && p.preview_sha256 === null)
    out.push(`${path}.preview_sha256: ${p.status} proposal has a preview`);
}

function threadProblems(path: string, t: RoomThread, out: string[]): void {
  if (t.messages.length === 0) out.push(`${path}.messages: a thread has at least one message`);
  const ids = new Set<string>();
  t.messages.forEach((m, i) => {
    if (ids.has(m.message_id)) out.push(`${path}.messages[${i}].message_id: ${JSON.stringify(m.message_id)} is used twice`);
    ids.add(m.message_id);
    instant(`${path}.messages[${i}].created_at`, m.created_at, out);
  });
}

/** The approver of a session entry: null exactly when the entry is a direct commit, and a user otherwise (a
 * proposal is approved by a person, never by an agent). */
function approverProblems(path: string, e: RoomSessionEntry, out: string[]): void {
  if (e.proposal_id === null) {
    if (e.approved_by !== null) out.push(`${path}.approved_by: a direct commit has no approver`);
  } else if (e.approved_by === null) {
    out.push(`${path}.approved_by: a commit from a proposal names its approver`);
  } else if (e.approved_by.kind !== "user") {
    out.push(`${path}.approved_by.kind: a proposal is approved by a user, not an agent`);
  }
}

/** What a schema can not say about a room that has the right shape. Revisions count commits: the entries of
 * a document carry revisions 1, 2, 3, ..., each based on the result of the one before, and the head of the
 * document is the last of them (revision 0, no entry, for a document nothing was committed to). */
function roomProblems(path: string, room: RoomState, out: string[]): void {
  const heads = new Map<string, RoomHead>();
  room.documents.forEach((d, i) => {
    if (heads.has(d.head.name)) out.push(`${path}.documents[${i}].head.name: ${JSON.stringify(d.head.name)} names two documents`);
    heads.set(d.head.name, d.head);
    instant(`${path}.documents[${i}].head.updated_at`, d.head.updated_at, out);
  });

  const proposals = new Map<string, RoomProposal>();
  room.proposals.forEach((p, i) => {
    const at = `${path}.proposals[${i}]`;
    if (proposals.has(p.proposal_id)) out.push(`${at}.proposal_id: ${JSON.stringify(p.proposal_id)} is used twice`);
    proposals.set(p.proposal_id, p);
    const head = heads.get(p.doc_name);
    if (!head) out.push(`${at}.doc_name: ${JSON.stringify(p.doc_name)} is not a document of the room`);
    else if (p.base_revision > head.revision) out.push(`${at}.base_revision: ${p.base_revision} is ahead of head revision ${head.revision}`);
    proposalProblems(at, p, out);
  });

  const last = new Map<string, RoomSessionEntry>();
  let seq = 0;
  room.session_log.forEach((e, i) => {
    const at = `${path}.session_log[${i}]`;
    if (e.seq <= seq) out.push(`${at}.seq: ${e.seq} does not follow ${seq}`);
    if (e.seq > room.seq) out.push(`${at}.seq: ${e.seq} is ahead of room seq ${room.seq}`);
    seq = e.seq;
    instant(`${at}.committed_at`, e.committed_at, out);
    batchProblems(`${at}.batch`, e.batch, out);
    approverProblems(at, e, out);
    if (!heads.has(e.doc_name)) return void out.push(`${at}.doc_name: ${JSON.stringify(e.doc_name)} is not a document of the room`);
    const prior = last.get(e.doc_name);
    if (e.revision !== (prior?.revision ?? 0) + 1) out.push(`${at}.revision: ${e.revision} does not follow ${prior?.revision ?? 0}`);
    if (prior && e.base_sha256 !== prior.result_sha256) out.push(`${at}.base_sha256: is not the result of revision ${prior.revision}`);
    if (e.proposal_id !== null) {
      const p = proposals.get(e.proposal_id);
      if (!p) out.push(`${at}.proposal_id: ${JSON.stringify(e.proposal_id)} is not a proposal of the room`);
      else if (p.doc_name !== e.doc_name || p.status !== "approved")
        out.push(`${at}.proposal_id: ${JSON.stringify(e.proposal_id)} is not an approved proposal for ${JSON.stringify(e.doc_name)}`);
    }
    last.set(e.doc_name, e);
  });

  room.documents.forEach((d, i) => {
    const at = `${path}.documents[${i}].head`;
    const entry = last.get(d.head.name);
    if (d.head.revision !== (entry?.revision ?? 0)) out.push(`${at}.revision: ${d.head.revision}, the log ends at ${entry?.revision ?? 0}`);
    if (entry && d.head.sha256 !== entry.result_sha256) out.push(`${at}.sha256: is not the result of revision ${entry.revision}`);
    if (entry && d.head.updated_at !== entry.committed_at) out.push(`${at}.updated_at: is not the commit time of revision ${entry.revision}`);
  });

  const threads = new Set<string>();
  room.comments.forEach((t, i) => {
    const at = `${path}.comments[${i}]`;
    if (threads.has(t.thread_id)) out.push(`${at}.thread_id: ${JSON.stringify(t.thread_id)} is used twice`);
    threads.add(t.thread_id);
    if (!heads.has(t.doc_name)) out.push(`${at}.doc_name: ${JSON.stringify(t.doc_name)} is not a document of the room`);
    threadProblems(at, t, out);
  });
}

/** Problems of a room state `wolfsdk.room.v1` (empty when valid): its shape, then the agreement of heads, log,
 * proposals and threads. */
export function validateRoomSnapshot(state: unknown): string[] {
  const out = validateSchema(ROOM_SCHEMA, state);
  if (out.length === 0) roomProblems("$", state as RoomState, out);
  return out;
}

const SERVER_EVENT_DEF: Record<Exclude<RoomServerEventType, "error">, string> = {
  "room.snapshot": "ev_room_snapshot",
  "doc.added": "ev_doc_added",
  "doc.committed": "ev_doc_committed",
  "proposal.updated": "ev_proposal_updated",
  "pages.invalidated": "ev_pages_invalidated",
  "comment.updated": "ev_comment_updated",
  "agent.activity": "ev_agent_activity",
};

const CLIENT_MESSAGE_DEF: Record<RoomClientMessageType, string> = {
  "room.join": "msg_room_join",
  "doc.edit": "msg_doc_edit",
  "proposal.decide": "msg_proposal_decide",
  "comment.post": "msg_comment_post",
};

function serverEventDef(event: Record<string, unknown>): string | undefined {
  const { type } = event;
  if (type === "error") return event.code === ROOM_REVISION_MISMATCH ? "ev_revision_mismatch" : "ev_error";
  return typeof type === "string" && Object.hasOwn(SERVER_EVENT_DEF, type)
    ? SERVER_EVENT_DEF[type as Exclude<RoomServerEventType, "error">]
    : undefined;
}

function pageList(path: string, pages: number[], ok: (page: number) => boolean, rule: string, out: string[]): void {
  const seen = new Set<number>();
  pages.forEach((page, i) => {
    if (!ok(page)) out.push(`${path}[${i}]: page ${page} ${rule}`);
    if (seen.has(page)) out.push(`${path}[${i}]: page ${page} is listed twice`);
    seen.add(page);
  });
}

/** What a schema can not say about one server event of the right shape. A session entry's `seq` is the
 * `seq` of the `doc.committed` event that announced it. */
function eventProblems(def: string, event: Record<string, unknown>, out: string[]): void {
  switch (def) {
    case "ev_room_snapshot": {
      const e = event as Extract<RoomServerEvent, { type: "room.snapshot" }>;
      if (e.seq !== e.room.seq) out.push(`$.seq: ${e.seq} is not the seq of the room, ${e.room.seq}`);
      roomProblems("$.room", e.room, out);
      return;
    }
    case "ev_doc_added": {
      const { head } = (event as Extract<RoomServerEvent, { type: "doc.added" }>).document;
      if (head.revision !== 0) out.push("$.document.head.revision: a document is added at revision 0");
      instant("$.document.head.updated_at", head.updated_at, out);
      return;
    }
    case "ev_doc_committed": {
      const { head, entry, seq } = event as Extract<RoomServerEvent, { type: "doc.committed" }>;
      if (entry.seq !== seq) out.push(`$.entry.seq: ${entry.seq} is not the seq of the event, ${seq}`);
      if (head.name !== entry.doc_name) out.push("$.head.name: is not the document of the entry");
      if (head.revision !== entry.revision) out.push("$.head.revision: is not the revision of the entry");
      if (head.sha256 !== entry.result_sha256) out.push("$.head.sha256: is not the result of the entry");
      if (head.updated_at !== entry.committed_at) out.push("$.head.updated_at: is not the commit time of the entry");
      instant("$.entry.committed_at", entry.committed_at, out);
      batchProblems("$.entry.batch", entry.batch, out);
      approverProblems("$.entry", entry, out);
      return;
    }
    case "ev_proposal_updated":
      proposalProblems("$.proposal", (event as Extract<RoomServerEvent, { type: "proposal.updated" }>).proposal, out);
      return;
    case "ev_pages_invalidated": {
      const e = event as Extract<RoomServerEvent, { type: "pages.invalidated" }>;
      const count = e.page_hashes.length;
      pageList("$.changed", e.changed, (p) => p <= count, `is not one of the ${count} pages of the revision`, out);
      pageList("$.removed", e.removed, (p) => p > count, `is still a page of the revision (${count} pages)`, out);
      return;
    }
    case "ev_comment_updated":
      threadProblems("$.thread", (event as Extract<RoomServerEvent, { type: "comment.updated" }>).thread, out);
      return;
    case "ev_agent_activity":
      instant("$.at", (event as Extract<RoomServerEvent, { type: "agent.activity" }>).at, out);
      return;
    case "ev_revision_mismatch": {
      const { detail } = event as { detail: RoomConflictDetail };
      if (detail.head.name !== detail.doc_name) out.push("$.detail.head.name: is not the document of the conflict");
      if (detail.base_revision === detail.head.revision) out.push("$.detail.base_revision: equals the head revision, there is no mismatch");
      return;
    }
  }
}

/** Problems of one server event, a JSON text message of the room WebSocket (empty when valid). The event is
 * checked against the shape its `type` (and, for `error`, its `code`) names. */
export function validateRoomEvent(event: unknown): string[] {
  if (!isObject(event)) return ["$: expected object"];
  const def = serverEventDef(event);
  if (!def) return [`$.type: ${JSON.stringify(event.type)} is not a room server event`];
  const out = validateDef(def, event);
  if (out.length === 0) eventProblems(def, event, out);
  return out;
}

/** Problems of one client message of the room WebSocket (empty when valid). */
export function validateRoomClientMessage(message: unknown): string[] {
  if (!isObject(message)) return ["$: expected object"];
  const { type } = message;
  const def = typeof type === "string" && Object.hasOwn(CLIENT_MESSAGE_DEF, type) ? CLIENT_MESSAGE_DEF[type as RoomClientMessageType] : undefined;
  if (!def) return [`$.type: ${JSON.stringify(type)} is not a room client message`];
  const out = validateDef(def, message);
  if (out.length === 0 && def === "msg_doc_edit") batchProblems("$.batch", (message as RoomClientMessage & { type: "doc.edit" }).batch, out);
  if (out.length === 0 && def === "msg_comment_post" && message.resolve === true && message.thread_id === null)
    out.push("$.resolve: a new thread has nothing to resolve");
  return out;
}
