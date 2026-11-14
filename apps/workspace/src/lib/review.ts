// Between the room and `<wolf-review>`: a proposal becomes the element's review input, local edits become one
// `doc.edit` batch, and the element's review decision becomes a room decision.
import type { Op, SessionLog } from "@wolfsdk/protocol/contract";
import type { RoomBatch, RoomOp, RoomProposal, RoomServerEvent } from "@wolfsdk/protocol/workspace";

/** One batch as `openReview` takes it (`WolfReviewBatch` of `@wolfsdk/review`). */
export type ReviewBatch = { ops: Op[]; label?: string; clock?: string; timezone?: string };

/** What `el.openReview` takes for `proposal` over the bytes it was proposed against. Each batch keeps the clock
 * and zone it ran under in the room, so the element reproduces the preview the server computed. */
export function reviewInputOf(proposal: RoomProposal, base: Uint8Array): { base: Uint8Array; name: string; batches: ReviewBatch[] } {
  return {
    base,
    name: proposal.doc_name,
    batches: proposal.batches.map((batch, index) => ({
      // A room op is an Agent API op passed through untouched: the element speaks the same ops.
      ops: batch.ops as unknown as Op[],
      label: batch.label ?? `Change ${index + 1} of ${proposal.proposal_id}`,
      clock: batch.clock,
      timezone: batch.timezone,
    })),
  };
}

/** The local edits of the element (its session log since the head was opened) as one room batch: the ops in the
 * order they ran, and the label given. Null when there is nothing to send. */
export function batchFromSession(session: Pick<SessionLog, "batches" | "locale">, label: string): RoomBatch | null {
  const ops = session.batches.flatMap((batch) => batch.ops as unknown as RoomOp[]);
  if (ops.length === 0) return null;
  const text = label.trim();
  return { ops, ...(text === "" ? {} : { label: text }), locale: session.locale };
}

export type ReviewOutcome = "approve" | "reject" | "mixed" | "incomplete";

/** What a submitted review decision means for the whole proposal: the room approves or rejects a proposal as a
 * whole, so a review that approves some changes and rejects others is `mixed`. */
export function outcomeOf(summary: { approve: number; reject: number; undecided: number }): ReviewOutcome {
  if (summary.undecided > 0) return "incomplete";
  if (summary.reject === 0) return "approve";
  if (summary.approve === 0) return "reject";
  return "mixed";
}

/** Whether `event` is the commit of a `doc.edit` this actor sent for `doc` on top of `base`. */
export const isOwnCommit = (event: RoomServerEvent, actorId: string, doc: string, base: number): boolean =>
  event.type === "doc.committed" && event.head.name === doc && event.entry.author.id === actorId && event.head.revision === base + 1;

/** Whether `event` opens a proposal of this actor for `doc` that was not known before. */
export const isOwnNewProposal = (event: RoomServerEvent, actorId: string, doc: string, known: ReadonlySet<string>): boolean =>
  event.type === "proposal.updated" &&
  event.proposal.doc_name === doc &&
  event.proposal.author.id === actorId &&
  event.proposal.status === "open" &&
  !known.has(event.proposal.proposal_id);

/** Whether `event` is `proposalId` taking `decision`. A proposal that leaves open another way (an approval the
 * engine refuses makes it `conflicted`) is not the decision: the server's `error` follows and fails the request. */
export const isDecided = (event: RoomServerEvent, proposalId: string, decision: "approve" | "reject"): boolean =>
  event.type === "proposal.updated" &&
  event.proposal.proposal_id === proposalId &&
  event.proposal.status === (decision === "approve" ? "approved" : "rejected");

/** Whether a room activity event is about `doc` (or the whole room), and so belongs on its presence bar. */
export const isActivityFor = (event: RoomServerEvent, doc: string): boolean => event.type === "agent.activity" && (event.doc_name === null || event.doc_name === doc);
