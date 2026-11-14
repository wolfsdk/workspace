// The room server: the rules of `wolfsdk.room.v1` on top of a store (SQLite), a blob store (document bytes)
// and an engine (the reactor pipe). It implements `RoomService` and is the only writer of room state.
//
// How a change happens, always in this order:
//   1. Validate the request with the protocol validators and check who is asking.
//   2. Take the lock of the document. One writer per document at a time, so exactly one commit wins a revision.
//   3. Do the engine work (replay the batch on the head bytes, dry-run the other open proposals). Nothing is
//      stored yet: an engine refusal, fault, crash or timeout leaves the room exactly as it was.
//   4. In one synchronous SQLite transaction write the blob-backed state change and every event it announces;
//      each event is validated with `validateRoomEvent` and the resulting room with `validateRoomSnapshot`
//      before the transaction ends, so no invalid state is ever stored or announced.
//   5. Broadcast the events to subscribers, in the same synchronous block as the transaction: a client that
//      joins either sees an event in its backlog or receives it live, never both and never neither.
import {
  isWorkspaceInstant,
  type ReactorPipeEntitlement,
  type RoomActor,
  type RoomBatch,
  type RoomConflictDetail,
  type RoomDocument,
  type RoomHead,
  type RoomPinnedBatch,
  type RoomProposal,
  type RoomServerEvent,
  type RoomSessionEntry,
  type RoomState,
  type RoomThread,
  ROOM_REVISION_MISMATCH,
  validateRoomClientMessage,
  validateRoomEvent,
  validateRoomSnapshot,
  type WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";
import { BlobStore } from "./blobs.ts";
import type { DocumentEngine, ReplayResult } from "./engine.ts";
import { EngineFault, EngineRefusal } from "./errors.ts";
import { KeyedLock } from "./lock.ts";
import type {
  ActivityReport,
  CommentRequest,
  DecideOutcome,
  DecideRequest,
  DocumentRead,
  EditOutcome,
  EditRequest,
  PreviewRead,
  Result,
  RoomFailure,
  RoomListener,
  RoomService,
  RoomSubscription,
} from "./service.ts";
import { claimDatabase, type RoomRow, RoomStore, type SeatRow } from "./store.ts";

/** What a caller asks to do in a room; the `authorize` hook decides per action. */
export type RoomAction = "create" | "add_document" | "join" | "read" | "edit" | "decide" | "comment" | "activity";

export type RoomServerOptions = {
  /** The SQLite file. Created when absent. */
  dbPath: string;
  /** The directory of the content-addressed document bytes. */
  blobDir: string;
  engine: DocumentEngine;
  /** The clock of every timestamp the server writes. Default: the system clock. */
  now?: () => Date;
  /** Ids of proposals, threads and messages; they must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. */
  newId?: () => string;
  /** How many recent events a room keeps for `since_seq` resume. Older ones are forgotten and a client
   * that far behind gets a snapshot. Default 10 000. */
  replayWindow?: number;
  /** Decide whether `actor` may do `action` in the room. Absent: everyone may. `false` is `FORBIDDEN`. */
  authorize?: (actor: RoomActor, action: RoomAction, roomId: string) => boolean | Promise<boolean>;
  /** The timezone a batch runs under when its client pinned none. Default `UTC`. */
  timezone?: string;
  /** The locale a batch runs under when its client pinned none. Default `en-US`. */
  locale?: string;
  /** The seed of a batch whose client pinned none. Default: a random unsigned 32-bit integer. */
  seed?: () => number;
  /** The signed-in user an agent acts under, or `null` for an agent that signs in with an identity of its own.
   * The first acts on its operator's seat, which the operator takes if it holds none yet; the second takes a seat
   * of its own. Absent: every agent signs in on its own. The server asks on every request of an agent that holds
   * no seat of its own, and about once a minute for one that does; an agent that took a seat of its own and is
   * later given an operator gives that seat up the next time the server asks. */
  operatorOf?: (agent: RoomActor) => { id: string; name: string } | null | Promise<{ id: string; name: string } | null>;
};

type Failure = { ok: false; error: RoomFailure };
type SeqEvent = Exclude<RoomServerEvent, { type: "error" }>;
type Verdict = { proposal: RoomProposal; status: "superseded" | "conflicted" };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORMATS: readonly string[] = ["docx", "xlsx", "pptx", "pdf"] satisfies WorkspaceDocFormat[];
/** The longest engine message a caller sees. */
const MESSAGE_CHARS = 500;
/** The one lock of the things no room owns: workspaces, room ids and seats. */
const ADMIN = "admin";
/** How long the server trusts that an agent holding a seat of its own still signs in on its own, before it asks
 * `operatorOf` again. */
const OPERATOR_RECHECK_MS = 60_000;
/** How long the server trusts its last reading of the licence for an identity that already holds a seat. An
 * identity that asks for a seat always has the licence read for it. */
const LICENCE_RECHECK_MS = 60_000;

/** A subscription and the identity that joined. */
type Subscriber = { listener: RoomListener; kind: SeatRow["kind"]; id: string; name: string };

/** A limit of the licence: a whole number, or `null` for no limit. */
const isLimit = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);

const failure = (code: Exclude<RoomFailure["code"], "REVISION_MISMATCH">, message: string): Failure => ({ ok: false, error: { code, message } });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function badRequest(problems: readonly string[]): Failure {
  return failure("BAD_REQUEST", problems.slice(0, 5).join("; "));
}

/** The pages of `next` that differ from `previous` (1-based, all of them when there is no `previous`) and the
 * pages of `previous` that no longer exist. */
function diffPages(previous: readonly string[] | undefined, next: readonly string[]): { changed: number[]; removed: number[] } {
  const changed: number[] = [];
  for (const [i, hash] of next.entries()) if (previous?.[i] !== hash) changed.push(i + 1);
  const removed: number[] = [];
  for (let page = next.length + 1; page <= (previous?.length ?? 0); page++) removed.push(page);
  return { changed, removed };
}

/** What one transaction announces. `send` validates before it stores: an invalid event is a bug in this
 * file, and throwing rolls the whole transaction back. */
class Tx {
  readonly events: SeqEvent[] = [];
  private readonly store: RoomStore;
  private readonly roomId: string;

  constructor(store: RoomStore, roomId: string) {
    this.store = store;
    this.roomId = roomId;
  }

  /** The next `seq` of the room. */
  next(): number {
    return this.store.bumpSeq(this.roomId);
  }

  send(event: SeqEvent): void {
    const problems = validateRoomEvent(event);
    if (problems.length > 0) throw new Error(`refusing to announce an invalid ${event.type}: ${problems.join("; ")}`);
    this.store.appendEvent(this.roomId, event);
    this.events.push(event);
  }
}

export class RoomServer implements RoomService {
  private readonly store: RoomStore;
  private readonly blobs: BlobStore;
  private readonly engine: DocumentEngine;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly replayWindow: number;
  private readonly authorize: RoomServerOptions["authorize"];
  private readonly timezone: string;
  private readonly locale: string;
  private readonly seed: () => number;
  private readonly operatorOf: RoomServerOptions["operatorOf"];
  private readonly locks = new KeyedLock();
  private readonly listeners = new Map<string, Set<Subscriber>>();
  /** When `operatorOf` last said that a seated agent signs in on its own, by agent id. */
  private readonly standaloneAt = new Map<string, number>();
  /** The user whose seat an agent acted on in its last request, by agent id. An agent that acted on a seat of
   * its own is not here. */
  private readonly operators = new Map<string, string>();
  /** When the licence was last read, on the wall clock: the room clock stamps events and need not move. */
  private licenceReadAt: number | null = null;
  private readonly unlock: () => void;

  /** Opens the database and checks every stored room: a server never starts on state that would not pass
   * `validateRoomSnapshot`, and never on a database another server has open. */
  constructor(options: RoomServerOptions) {
    this.unlock = claimDatabase(options.dbPath);
    try {
      this.store = new RoomStore(options.dbPath);
    } catch (e) {
      this.unlock();
      throw e;
    }
    this.blobs = new BlobStore(options.blobDir);
    this.engine = options.engine;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.replayWindow = options.replayWindow ?? 10_000;
    this.authorize = options.authorize;
    this.timezone = options.timezone ?? "UTC";
    this.locale = options.locale ?? "en-US";
    this.seed = options.seed ?? randomSeed;
    this.operatorOf = options.operatorOf;
    try {
      for (const row of this.store.rooms()) this.snapshotOf(row.room_id);
    } catch (e) {
      this.store.close();
      this.unlock();
      throw e;
    }
  }

  /** Stop the engine and close the database. Calls still running when this is called fail. */
  async close(): Promise<void> {
    try {
      await this.engine.close();
    } finally {
      this.store.close();
      this.unlock();
    }
  }

  /** The identities the server has admitted to a seat: users, and agents that sign in with an identity of their own. */
  listSeats(): SeatRow[] {
    return this.store.seats();
  }

  /** Free the seat of an identity. `false` when it had none. Its subscriptions, and those of the agents that act
   * on its seat, end. */
  releaseSeat(kind: SeatRow["kind"], id: string): boolean {
    if (kind === "agent") this.standaloneAt.delete(id);
    const freed = this.store.removeSeat(kind, id);
    if (freed) this.endUnseated();
    return freed;
  }

  // Rooms ------------------------------------------------------------------------------------------------

  createRoom(actor: RoomActor, input: { room_id: string; workspace_id: string }): Promise<Result<RoomState>> {
    const { room_id: roomId, workspace_id: workspaceId } = input;
    if (!ID.test(roomId)) return Promise.resolve(badRequest([`room_id ${JSON.stringify(roomId)} is not a valid id`]));
    if (!ID.test(workspaceId)) return Promise.resolve(badRequest([`workspace_id ${JSON.stringify(workspaceId)} is not a valid id`]));
    const actorProblem = this.actorProblem(actor);
    if (actorProblem) return Promise.resolve(actorProblem);
    return this.checked(actor, "create", roomId, async () => {
      if (this.store.room(roomId) !== null) return failure("BAD_REQUEST", `room ${roomId} exists`);
      const limits = await this.limits();
      if (!limits.ok) return limits;
      const max = limits.value.max_workspaces;
      if (max !== null && !this.store.hasWorkspace(workspaceId) && this.store.workspaceCount() >= max) {
        return failure("LICENSE_LIMIT", `this licence serves ${max} workspace${max === 1 ? "" : "s"}; ${workspaceId} would be one more`);
      }
      const seat = await this.admitSeat(await this.seatHolder(actor), actor);
      if (seat) return seat;
      this.store.transaction(() => {
        this.store.insertRoom(roomId, workspaceId, this.stamp());
        this.snapshotOf(roomId);
      });
      return ok(this.snapshotOf(roomId));
    });
  }

  listRooms(): Promise<RoomRow[]> {
    return Promise.resolve(this.store.rooms());
  }

  getRoom(roomId: string, actor: RoomActor): Promise<Result<RoomState>> {
    return this.guarded(actor, "read", roomId, () => ok(this.snapshotOf(roomId)));
  }

  // Documents --------------------------------------------------------------------------------------------

  addDocument(
    roomId: string,
    actor: RoomActor,
    input: { name: string; format: WorkspaceDocFormat; bytes: Uint8Array },
  ): Promise<Result<RoomHead>> {
    const { name, format, bytes } = input;
    if (name.length === 0) return Promise.resolve(badRequest(["a document needs a name"]));
    if (!FORMATS.includes(format)) return Promise.resolve(badRequest([`${JSON.stringify(format)} is not a document format`]));
    return this.guarded(actor, "add_document", roomId, () =>
      this.locks.run(docKey(roomId, name), async (): Promise<Result<RoomHead>> => {
        if (this.store.document(roomId, name) !== null) return failure("BAD_REQUEST", `document ${name} exists in ${roomId}`);
        let replay: ReplayResult;
        try {
          replay = await this.engine.replay({ format, name, bytes, batches: [], save: false, pages: true });
        } catch (e) {
          return this.engineFailure(e);
        }
        const sha256 = await this.blobs.put(bytes);
        const document: RoomDocument = { head: { revision: 0, sha256, format, name, updated_at: this.stamp() } };
        if (replay.page_hashes !== null) document.page_hashes = replay.page_hashes;
        this.mutate(roomId, (tx) => {
          this.store.insertDocument(roomId, document);
          tx.send({ type: "doc.added", seq: tx.next(), document });
        });
        return ok(document.head);
      }),
    );
  }

  readHead(roomId: string, actor: RoomActor, docName: string): Promise<Result<DocumentRead>> {
    return this.guarded(actor, "read", roomId, async () => {
      const document = this.store.document(roomId, docName);
      if (document === null) return failure("UNKNOWN_DOCUMENT", `no document ${docName} in ${roomId}`);
      const read: DocumentRead = { head: document.head, bytes: await this.bytesOf(document.head.sha256) };
      if (document.page_hashes) read.page_hashes = document.page_hashes;
      return ok(read);
    });
  }

  readPreview(roomId: string, actor: RoomActor, proposalId: string): Promise<Result<PreviewRead>> {
    return this.guarded(actor, "read", roomId, async () => {
      const proposal = this.store.proposal(roomId, proposalId);
      if (proposal === null) return failure("UNKNOWN_PROPOSAL", `no proposal ${proposalId} in ${roomId}`);
      if (proposal.preview_sha256 === null) return failure("BAD_REQUEST", `proposal ${proposalId} has no preview`);
      return ok({ proposal, bytes: await this.bytesOf(proposal.preview_sha256) });
    });
  }

  // Edits ------------------------------------------------------------------------------------------------

  edit(roomId: string, actor: RoomActor, request: EditRequest): Promise<Result<EditOutcome>> {
    const problems = validateRoomClientMessage({ type: "doc.edit", request_id: "service", ...request });
    if (problems.length > 0) return Promise.resolve(badRequest(problems));
    return this.guarded(actor, "edit", roomId, () =>
      this.locks.run(docKey(roomId, request.doc_name), async (): Promise<Result<EditOutcome>> => {
        const document = this.store.document(roomId, request.doc_name);
        if (document === null) return failure("UNKNOWN_DOCUMENT", `no document ${request.doc_name} in ${roomId}`);
        if (document.head.format === "pdf") return failure("BAD_REQUEST", `${request.doc_name} is a PDF; PDF documents are read-only`);
        if (request.base_revision !== document.head.revision) return this.mismatch(request, document.head);
        return request.mode === "commit"
          ? this.commit(roomId, actor, document, request.batch)
          : this.propose(roomId, actor, document, request.batch);
      }),
    );
  }

  private mismatch(request: EditRequest, head: RoomHead): Failure {
    const detail: RoomConflictDetail = { doc_name: request.doc_name, base_revision: request.base_revision, head };
    return {
      ok: false,
      error: {
        code: ROOM_REVISION_MISMATCH,
        message: `${request.doc_name} is at revision ${head.revision}, not ${request.base_revision}`,
        detail,
      },
    };
  }

  /** Apply `batch` to the head and record it. The caller holds the document lock. */
  private async commit(roomId: string, actor: RoomActor, document: RoomDocument, requested: RoomBatch): Promise<Result<EditOutcome>> {
    const { head } = document;
    const batch = this.pin(requested);
    const replay = await this.replayOnHead(head, [batch], true);
    if (!replay.ok) return replay;
    await this.blobs.put(replay.value.bytes);
    const verdicts = await this.reevaluate(roomId, head, replay.value.bytes, null);
    const result = this.mutate(roomId, (tx) =>
      this.landCommits(tx, roomId, document, replay.value, [batch], actor, null, verdicts),
    );
    const [entry] = result.entries;
    if (entry === undefined) throw new Error("a commit produced no session entry");
    return ok({ mode: "commit", head: result.head, entry });
  }

  /** Hold `batch` as an open proposal against the head, with the bytes it would produce as its preview. */
  private async propose(roomId: string, actor: RoomActor, document: RoomDocument, requested: RoomBatch): Promise<Result<EditOutcome>> {
    const { head } = document;
    const batch = this.pin(requested);
    const replay = await this.replayOnHead(head, [batch], false);
    if (!replay.ok) return replay;
    const previewSha = await this.blobs.put(replay.value.bytes);
    const proposal: RoomProposal = {
      proposal_id: this.newId(),
      doc_name: head.name,
      base_revision: head.revision,
      author: actor,
      status: "open",
      batches: [batch],
      preview_sha256: previewSha,
      created_at: this.stamp(),
    };
    this.mutate(roomId, (tx) => {
      this.store.insertProposal(roomId, proposal);
      tx.send({ type: "proposal.updated", seq: tx.next(), proposal });
    });
    return ok({ mode: "propose", proposal });
  }

  /** Replay `batches` on the head bytes, asking for the result bytes (always) and page hashes (when
   * `pages`). The engine's refusal or fault becomes the failure; nothing is stored. */
  private async replayOnHead(
    head: RoomHead,
    batches: readonly RoomBatch[],
    pages: boolean,
  ): Promise<{ ok: true; value: ReplayResult & { bytes: Uint8Array } } | Failure> {
    const base = await this.bytesOf(head.sha256);
    try {
      const replay = await this.engine.replay({ format: head.format, name: head.name, bytes: base, batches, save: true, pages });
      return { ok: true, value: savedReplay(replay, batches.length) };
    } catch (e) {
      return this.engineFailure(e);
    }
  }

  /** Dry-run the open proposals of the document (but `except`) on the bytes the head is about to have, to
   * tell which could still be applied (`superseded`: the head moved, the proposal is stale) and which no
   * longer can (`conflicted`). Only a refusal that is about the proposal itself proves a conflict. A worker
   * fault, a licence refusal and a refusal that says nothing about the request (a budget, an internal error)
   * prove nothing about it, so they count as `superseded`. */
  private async reevaluate(roomId: string, head: RoomHead, bytes: Uint8Array, except: string | null): Promise<Verdict[]> {
    const verdicts: Verdict[] = [];
    for (const proposal of this.store.openProposals(roomId, head.name)) {
      if (proposal.proposal_id === except) continue;
      let status: Verdict["status"] = "superseded";
      try {
        await this.engine.replay({ format: head.format, name: head.name, bytes, batches: proposal.batches, save: false, pages: false });
      } catch (e) {
        if (e instanceof EngineRefusal && !e.isLicense && !e.isEngineFailure) status = "conflicted";
        else if (!(e instanceof EngineRefusal || e instanceof EngineFault)) throw e;
      }
      verdicts.push({ proposal, status });
    }
    return verdicts;
  }

  /** Inside a transaction: write the session entries of `batches` (one `doc.committed` each, with the approval
   * that let them in, if there was one), the new head and its page changes, and move the `verdicts` proposals. */
  private landCommits(
    tx: Tx,
    roomId: string,
    document: RoomDocument,
    replay: ReplayResult & { bytes: Uint8Array },
    batches: readonly RoomPinnedBatch[],
    author: RoomActor,
    approval: { proposalId: string; approver: RoomActor } | null,
    verdicts: readonly Verdict[],
  ): { entries: RoomSessionEntry[]; head: RoomHead } {
    const at = this.stamp();
    const entries: RoomSessionEntry[] = [];
    let head = document.head;
    for (const [i, batch] of batches.entries()) {
      const step = replay.steps[i];
      if (step === undefined) throw new Error("the engine reported fewer steps than batches");
      const seq = tx.next();
      const entry: RoomSessionEntry = {
        seq,
        doc_name: head.name,
        revision: head.revision + 1,
        base_sha256: step.base_sha256,
        result_sha256: step.sha256,
        author,
        batch,
        proposal_id: approval?.proposalId ?? null,
        approved_by: approval?.approver ?? null,
        committed_at: at,
      };
      head = { revision: entry.revision, sha256: step.sha256, format: head.format, name: head.name, updated_at: at };
      this.store.appendEntry(roomId, entry);
      tx.send({ type: "doc.committed", seq, head, entry });
      entries.push(entry);
    }
    this.store.setHead(roomId, head, replay.page_hashes);
    if (replay.page_hashes !== null) {
      const { changed, removed } = diffPages(document.page_hashes, replay.page_hashes);
      tx.send({
        type: "pages.invalidated",
        seq: tx.next(),
        doc_name: head.name,
        revision: head.revision,
        sha256: head.sha256,
        page_hashes: replay.page_hashes,
        changed,
        removed,
      });
    }
    for (const verdict of verdicts) {
      const proposal: RoomProposal = { ...verdict.proposal, status: verdict.status };
      this.store.saveProposal(roomId, proposal);
      tx.send({ type: "proposal.updated", seq: tx.next(), proposal });
    }
    return { entries, head };
  }

  // Proposals --------------------------------------------------------------------------------------------

  decideProposal(roomId: string, actor: RoomActor, request: DecideRequest): Promise<Result<DecideOutcome>> {
    const problems = validateRoomClientMessage({ type: "proposal.decide", request_id: "service", ...request });
    if (problems.length > 0) return Promise.resolve(badRequest(problems));
    // A proposal is decided by a person. This is not the `authorize` hook's to give away: an agent that could
    // approve its own proposal (or another's) would make the review step a formality.
    if (actor.kind === "agent") return Promise.resolve(failure("FORBIDDEN", `${actor.name} is an agent; only a user decides a proposal`));
    return this.guarded(actor, "decide", roomId, async (): Promise<Result<DecideOutcome>> => {
      const found = this.store.proposal(roomId, request.proposal_id);
      if (found === null) return failure("UNKNOWN_PROPOSAL", `no proposal ${request.proposal_id} in ${roomId}`);
      return this.locks.run(docKey(roomId, found.doc_name), async () =>
        request.decision === "approve" ? this.approve(roomId, request.proposal_id, actor) : this.reject(roomId, request.proposal_id),
      );
    });
  }

  /** The proposal, read again under the document lock, if it is still open. */
  private openProposal(roomId: string, proposalId: string): { proposal: RoomProposal; document: RoomDocument } | Failure {
    const proposal = this.store.proposal(roomId, proposalId);
    if (proposal === null) return failure("UNKNOWN_PROPOSAL", `no proposal ${proposalId} in ${roomId}`);
    if (proposal.status !== "open") return failure("PROPOSAL_NOT_OPEN", `proposal ${proposalId} is ${proposal.status}`);
    const document = this.store.document(roomId, proposal.doc_name);
    if (document === null) throw new Error(`proposal ${proposalId} names ${proposal.doc_name}, which does not exist`);
    return { proposal, document };
  }

  private reject(roomId: string, proposalId: string): Result<DecideOutcome> {
    const open = this.openProposal(roomId, proposalId);
    if ("ok" in open) return open;
    const proposal: RoomProposal = { ...open.proposal, status: "rejected" };
    this.mutate(roomId, (tx) => {
      this.store.saveProposal(roomId, proposal);
      tx.send({ type: "proposal.updated", seq: tx.next(), proposal });
    });
    return ok({ proposal, entries: [], head: open.document.head });
  }

  /** Commit every batch of the proposal on the head, with the proposal's id and `approver` on each entry. The
   * batches are pinned, so the replay runs under the clock, timezone, locale and seed the preview ran under, and it
   * must reproduce the preview the approver was shown: a replay that does not is `ENGINE_FAILED` and commits
   * nothing. A batch the engine refuses because of the batch means the proposal no longer applies: it becomes
   * `conflicted`. A refusal of the licence, or one that says nothing about the request (a budget, an internal
   * error), leaves the proposal open. */
  private async approve(roomId: string, proposalId: string, approver: RoomActor): Promise<Result<DecideOutcome>> {
    const open = this.openProposal(roomId, proposalId);
    if ("ok" in open) return open;
    const { proposal, document } = open;
    const { head } = document;
    const base = await this.bytesOf(head.sha256);
    let replay: ReplayResult & { bytes: Uint8Array };
    try {
      replay = savedReplay(
        await this.engine.replay({ format: head.format, name: head.name, bytes: base, batches: proposal.batches, save: true, pages: true }),
        proposal.batches.length,
      );
    } catch (e) {
      if (e instanceof EngineRefusal && !e.isLicense && !e.isEngineFailure) {
        const conflicted: RoomProposal = { ...proposal, status: "conflicted" };
        this.mutate(roomId, (tx) => {
          this.store.saveProposal(roomId, conflicted);
          tx.send({ type: "proposal.updated", seq: tx.next(), proposal: conflicted });
        });
      }
      return this.engineFailure(e);
    }
    const final = replay.steps.at(-1)?.sha256;
    if (final !== proposal.preview_sha256) {
      return failure("ENGINE_FAILED", `replaying proposal ${proposalId} gives ${final ?? "no document"}, not the preview ${proposal.preview_sha256}; nothing was committed`);
    }
    await this.blobs.put(replay.bytes);
    const verdicts = await this.reevaluate(roomId, head, replay.bytes, proposalId);
    const approved: RoomProposal = { ...proposal, status: "approved" };
    const landed = this.mutate(roomId, (tx) => {
      this.store.saveProposal(roomId, approved);
      tx.send({ type: "proposal.updated", seq: tx.next(), proposal: approved });
      return this.landCommits(tx, roomId, document, replay, proposal.batches, proposal.author, { proposalId, approver }, verdicts);
    });
    return ok({ proposal: approved, entries: landed.entries, head: landed.head });
  }

  // Comments and activity --------------------------------------------------------------------------------

  postComment(roomId: string, actor: RoomActor, request: CommentRequest): Promise<Result<RoomThread>> {
    const problems = validateRoomClientMessage({ type: "comment.post", request_id: "service", ...request });
    if (problems.length > 0) return Promise.resolve(badRequest(problems));
    return this.guarded(actor, "comment", roomId, () => {
      const existing = request.thread_id === null ? null : this.store.thread(roomId, request.thread_id);
      if (request.thread_id !== null && existing === null) return failure("UNKNOWN_THREAD", `no thread ${request.thread_id} in ${roomId}`);
      if (existing === null) {
        if (this.store.document(roomId, request.doc_name) === null) return failure("UNKNOWN_DOCUMENT", `no document ${request.doc_name} in ${roomId}`);
      } else if (existing.doc_name !== request.doc_name || existing.target_address !== request.target_address) {
        return failure("BAD_REQUEST", `thread ${existing.thread_id} is about ${existing.doc_name} at ${existing.target_address}`);
      }
      const created = this.stamp();
      const reply = { message_id: this.newId(), author: actor, body: request.body, created_at: created };
      const mentions = [...(existing?.mentions ?? [])];
      for (const mention of request.mentions) {
        if (!mentions.some((m) => m.kind === mention.kind && m.id === mention.id)) mentions.push(mention);
      }
      const thread: RoomThread = existing
        ? { ...existing, mentions, messages: [...existing.messages, reply], resolved: existing.resolved || request.resolve === true }
        : {
            thread_id: this.newId(),
            doc_name: request.doc_name,
            target_address: request.target_address,
            mentions,
            messages: [reply],
            resolved: false,
          };
      this.mutate(roomId, (tx) => {
        if (existing) this.store.saveThread(roomId, thread);
        else this.store.insertThread(roomId, thread);
        tx.send({ type: "comment.updated", seq: tx.next(), thread });
      });
      return ok(thread);
    });
  }

  reportActivity(roomId: string, agent: RoomActor, report: ActivityReport): Promise<Result<void>> {
    if (agent.kind !== "agent") return Promise.resolve(failure("FORBIDDEN", "only an agent reports agent activity"));
    return this.guarded(agent, "activity", roomId, () => {
      if (report.doc_name !== null && this.store.document(roomId, report.doc_name) === null) {
        return failure("UNKNOWN_DOCUMENT", `no document ${report.doc_name} in ${roomId}`);
      }
      const event = (seq: number): SeqEvent => ({
        type: "agent.activity",
        seq,
        agent: { id: agent.id, name: agent.name },
        doc_name: report.doc_name,
        activity: report.activity,
        ...(report.detail === undefined ? {} : { detail: report.detail }),
        at: this.stamp(),
      });
      const problems = validateRoomEvent(event(1));
      if (problems.length > 0) return badRequest(problems);
      this.mutate(roomId, (tx) => tx.send(event(tx.next())));
      return ok(undefined);
    });
  }

  // Subscriptions ----------------------------------------------------------------------------------------

  join(roomId: string, actor: RoomActor, sinceSeq: number | null, listener: RoomListener): Promise<Result<RoomSubscription>> {
    const problems = validateRoomClientMessage({ type: "room.join", request_id: "service", room_id: roomId, since_seq: sinceSeq });
    if (problems.length > 0) return Promise.resolve(badRequest(problems));
    return this.guarded(actor, "join", roomId, () => {
      // Nothing below awaits: the backlog and the registration happen between two events, never across one.
      // A stored room that cannot produce its backlog is damaged: that is thrown to the caller, not hidden
      // behind a subscription that never delivers anything.
      const events = this.backlog(roomId, sinceSeq);
      try {
        for (const event of events) listener(event);
      } catch {
        // A listener that throws is dropped, as it would be by `publish`.
        return ok({ unsubscribe() {} });
      }
      let subscribers = this.listeners.get(roomId);
      if (subscribers === undefined) {
        subscribers = new Set();
        this.listeners.set(roomId, subscribers);
      }
      const registered = subscribers;
      const subscriber: Subscriber = { listener, kind: actor.kind, id: actor.id, name: actor.name };
      registered.add(subscriber);
      return ok({
        unsubscribe() {
          registered.delete(subscriber);
        },
      });
    });
  }

  /** What a client that has everything up to `since` is missing: the events after it when the log still has
   * all of them, else the whole room. */
  private backlog(roomId: string, since: number | null): RoomServerEvent[] {
    const room = this.store.room(roomId);
    if (room === null) throw new Error(`room ${roomId} vanished`);
    if (since !== null && since <= room.seq) {
      if (since === room.seq) return [];
      const events: RoomServerEvent[] = [];
      for (const [i, row] of this.store.eventsAfter(roomId, since).entries()) {
        if (row.seq !== since + 1 + i) break;
        events.push(row.event);
      }
      if (events.length === room.seq - since) {
        for (const event of events) {
          const problems = validateRoomEvent(event);
          if (problems.length > 0) throw new Error(`stored ${event.type} is invalid: ${problems.join("; ")}`);
        }
        return events;
      }
    }
    const state = this.snapshotOf(roomId);
    const snapshot: RoomServerEvent = { type: "room.snapshot", seq: state.seq, room: state };
    const problems = validateRoomEvent(snapshot);
    if (problems.length > 0) throw new Error(`room.snapshot of ${roomId} is invalid: ${problems.join("; ")}`);
    return [snapshot];
  }

  /** Send `events` to the subscribers of the room, in order. A subscriber that throws is dropped, and one whose
   * identity no longer has a seat is ended first: a seat can also be freed straight in the database. */
  private publish(roomId: string, events: readonly SeqEvent[]): void {
    const subscribers = this.listeners.get(roomId);
    if (subscribers === undefined) return;
    for (const subscriber of [...subscribers]) {
      if (!this.seated(subscriber)) {
        this.end(subscribers, subscriber);
        continue;
      }
      try {
        for (const event of events) subscriber.listener(event);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }

  /** Whether the identity of a subscription still has a seat: its own, or for an agent that acted on its
   * operator's seat, that one. An agent that is handing its own seat to its operator has one all the way. */
  private seated(subscriber: Subscriber): boolean {
    if (this.store.hasSeat(subscriber.kind, subscriber.id)) return true;
    const operator = subscriber.kind === "agent" ? this.operators.get(subscriber.id) : undefined;
    return operator !== undefined && this.store.hasSeat("user", operator);
  }

  /** End a subscription: the listener receives one `error` event, its last. */
  private end(subscribers: Set<Subscriber>, subscriber: Subscriber): void {
    subscribers.delete(subscriber);
    try {
      subscriber.listener({ type: "error", request_id: null, code: "LICENSE_LIMIT", message: `${subscriber.name} no longer holds a seat; join again to take one` });
    } catch {
      // The listener is gone either way.
    }
  }

  /** End every subscription whose identity no longer has a seat. */
  private endUnseated(): void {
    for (const subscribers of this.listeners.values()) {
      for (const subscriber of [...subscribers]) if (!this.seated(subscriber)) this.end(subscribers, subscriber);
    }
  }

  // Shared parts -----------------------------------------------------------------------------------------

  /** One synchronous transaction that changes a room, then the broadcast of what it announced. */
  private mutate<T>(roomId: string, work: (tx: Tx) => T): T {
    const tx = new Tx(this.store, roomId);
    const value = this.store.transaction(() => {
      const result = work(tx);
      const state = this.snapshotOf(roomId);
      this.store.pruneEvents(roomId, state.seq - this.replayWindow);
      return result;
    });
    this.publish(roomId, tx.events);
    return value;
  }

  /** The stored room, which must be a valid `wolfsdk.room.v1` state; anything else is a bug or damage. */
  private snapshotOf(roomId: string): RoomState {
    const state = this.store.snapshot(roomId);
    if (state === null) throw new Error(`room ${roomId} does not exist`);
    const problems = validateRoomSnapshot(state);
    if (problems.length > 0) throw new Error(`room ${roomId} is not a valid ${state.contract} state: ${problems.slice(0, 5).join("; ")}`);
    return state;
  }

  private async bytesOf(sha256: string): Promise<Uint8Array> {
    const bytes = await this.blobs.get(sha256);
    if (bytes === null) throw new Error(`the bytes ${sha256} are missing from the blob store`);
    return bytes;
  }

  private stamp(): string {
    const text = this.now().toISOString();
    if (!isWorkspaceInstant(text)) throw new Error(`the clock gave ${text}, which is not an RFC 3339 UTC instant`);
    return text;
  }

  /** `batch` with the members its client did not pin filled in: the server's clock now, its timezone and locale, and
   * a seed. The pinned batch is what is replayed, stored and announced, so replaying it later gives the same bytes. */
  private pin(batch: RoomBatch): RoomPinnedBatch {
    return {
      ...batch,
      clock: batch.clock ?? this.stamp(),
      timezone: batch.timezone ?? this.timezone,
      locale: batch.locale ?? this.locale,
      seed: batch.seed ?? this.seed(),
    };
  }

  /** The failure of a request the engine did not carry out. The licence is `LICENSE_LIMIT`. A fault of the worker,
   * and a refusal that says nothing about the request, are `ENGINE_FAILED`: nothing was judged and the same request can
   * succeed later. Any other refusal is the engine's judgement of the request: `BAD_REQUEST`. */
  private engineFailure(e: unknown): Failure {
    if (e instanceof EngineRefusal) {
      const code = e.isLicense ? "LICENSE_LIMIT" : e.isEngineFailure ? "ENGINE_FAILED" : "BAD_REQUEST";
      return failure(code, e.message.slice(0, MESSAGE_CHARS));
    }
    if (e instanceof EngineFault) return failure("ENGINE_FAILED", `the engine failed: ${e.message}`.slice(0, MESSAGE_CHARS));
    throw e;
  }

  private actorProblem(actor: RoomActor): Failure | null {
    if (actor.kind !== "agent" && actor.kind !== "user") return badRequest([`actor kind ${JSON.stringify(actor.kind)} is neither agent nor user`]);
    if (!ID.test(actor.id)) return badRequest([`actor id ${JSON.stringify(actor.id)} is not a valid id`]);
    if (actor.name.length === 0) return badRequest(["an actor needs a name"]);
    return null;
  }

  /** The licence the engine runs under, or `LICENSE_LIMIT`: a server that cannot read its licence, or reads limits
   * that are not whole numbers, admits nobody. A licence that admits fewer seats than are taken frees the newest
   * ones, so the roster never holds more seats than the last reading of the licence admits. */
  private async limits(): Promise<Result<ReactorPipeEntitlement>> {
    let read: ReactorPipeEntitlement;
    try {
      read = await this.engine.entitlement();
    } catch (e) {
      if (e instanceof EngineRefusal || e instanceof EngineFault) {
        return failure("LICENSE_LIMIT", `the licence could not be read: ${e.message}`.slice(0, MESSAGE_CHARS));
      }
      throw e;
    }
    if (!isLimit(read.max_seats) || !isLimit(read.max_workspaces)) {
      return failure("LICENSE_LIMIT", "the licence could not be read: its limits are not whole numbers");
    }
    this.licenceReadAt = Date.now();
    if (read.max_seats !== null) this.trimSeats(read.max_seats);
    return ok(read);
  }

  /** Free the seats beyond `max`, newest first, and end their subscriptions. An identity that lost its seat takes
   * one again with its next request, if one is left by then. */
  private trimSeats(max: number): void {
    const excess = this.store.seats().slice(max);
    if (excess.length === 0) return;
    this.store.transaction(() => {
      for (const seat of excess) this.store.removeSeat(seat.kind, seat.id);
    });
    for (const seat of excess) if (seat.kind === "agent") this.standaloneAt.delete(seat.id);
    this.endUnseated();
  }

  private licenceStale(): boolean {
    if (this.licenceReadAt === null) return true;
    const age = Date.now() - this.licenceReadAt;
    // A wall clock that was set back says nothing about the age of the reading.
    return age < 0 || age >= LICENCE_RECHECK_MS;
  }

  /** Read the licence again when the last reading is too old to trust. The caller holds the `admin` lock, so
   * requests that arrive together read it once. */
  private async recheckLicence(): Promise<Failure | null> {
    if (!this.licenceStale()) return null;
    const limits = await this.limits();
    return limits.ok ? null : limits;
  }

  /** The identity whose seat `actor` acts on: itself (the same object), or for an agent that a signed-in user
   * operates, that user. An agent without a seat of its own is asked about on every request, because acting on a
   * seat that is no longer its operator's would get past the licence. An agent that holds a seat of its own is
   * asked about again only every `OPERATOR_RECHECK_MS`: being late there only keeps a seat a little too long. */
  private async seatHolder(actor: RoomActor): Promise<RoomActor> {
    if (actor.kind === "user" || this.operatorOf === undefined) return actor;
    const now = this.now().getTime();
    const asked = this.standaloneAt.get(actor.id);
    let operator: { id: string; name: string } | null = null;
    if (asked === undefined || now - asked >= OPERATOR_RECHECK_MS || !this.store.hasSeat("agent", actor.id)) {
      operator = await this.operatorOf(actor);
      if (operator === null && this.store.hasSeat("agent", actor.id)) this.standaloneAt.set(actor.id, now);
      else this.standaloneAt.delete(actor.id);
    }
    return operator === null ? actor : { kind: "user", id: operator.id, name: operator.name };
  }

  /** Note whose seat the subscriptions of `actor` now go by. Not before `holder` was admitted: until then they
   * go by the seat `actor` acted on before, so an agent whose operator changes keeps its subscription. */
  private follow(actor: RoomActor, holder: RoomActor): void {
    if (actor.kind !== "agent") return;
    if (holder === actor) this.operators.delete(actor.id);
    else this.operators.set(actor.id, holder.id);
  }

  /** Admit `holder`, the seat holder of `actor`, to a seat unless it holds one, or refuse with `LICENSE_LIMIT`.
   * An agent that took a seat of its own and now has an operator gives that seat up in the same step, so the
   * operator can take the very seat the agent held. The caller holds the `admin` lock. */
  private async admitSeat(holder: RoomActor, actor: RoomActor): Promise<Failure | null> {
    try {
      const problem = this.actorProblem(holder);
      if (problem) return problem;
      if (this.store.hasSeat(holder.kind, holder.id)) {
        if (holder !== actor) this.store.removeSeat(actor.kind, actor.id);
        return null;
      }
      const limits = await this.limits();
      if (!limits.ok) return limits;
      // Read after the await, not before it: `releaseSeat` takes no lock and may have freed the agent's seat meanwhile.
      const vacated = holder !== actor && this.store.hasSeat(actor.kind, actor.id);
      // A holder without a seat that still has subscriptions lost its seat in the database, not through
      // `releaseSeat`: they end before it takes a seat again.
      this.endUnseated();
      const max = limits.value.max_seats;
      if (max !== null && this.store.seatCount() - (vacated ? 1 : 0) >= max) {
        return failure("LICENSE_LIMIT", `this licence admits ${max} seat${max === 1 ? "" : "s"}; ${holder.name} would take one more`);
      }
      const at = this.stamp();
      this.store.transaction(() => {
        if (vacated) this.store.removeSeat(actor.kind, actor.id);
        this.store.addSeat({ kind: holder.kind, id: holder.id, name: holder.name, first_seen_at: at });
      });
      if (holder.kind === "agent" && this.operatorOf !== undefined) this.standaloneAt.set(holder.id, Date.parse(at));
      return null;
    } finally {
      // In the same step as the seats above, so that no event finds the agent between two seats.
      this.follow(actor, holder);
    }
  }

  /** Run `work` for `actor` in an existing room: the room exists, the actor may act, the licence was read not
   * long ago, and an identity that takes a seat has one. */
  private async guarded<T>(actor: RoomActor, action: RoomAction, roomId: string, work: () => Promise<Result<T>> | Result<T>): Promise<Result<T>> {
    if (this.store.room(roomId) === null) return failure("UNKNOWN_ROOM", `no room ${roomId}`);
    const problem = this.actorProblem(actor);
    if (problem) return problem;
    if (this.authorize && !(await this.authorize(actor, action, roomId))) {
      return failure("FORBIDDEN", `${actor.name} may not ${action.replace("_", " ")} in ${roomId}`);
    }
    if (this.licenceStale()) {
      const refused = await this.locks.run(ADMIN, () => this.recheckLicence());
      if (refused) return refused;
    }
    const holder = await this.seatHolder(actor);
    const vacates = holder !== actor && this.store.hasSeat(actor.kind, actor.id);
    if (vacates || !this.store.hasSeat(holder.kind, holder.id)) {
      const refused = await this.locks.run(ADMIN, () => this.admitSeat(holder, actor));
      if (refused) return refused;
    } else this.follow(actor, holder);
    return work();
  }

  /** `guarded`, for a room that does not exist yet: the authorize hook and the licence still apply, and the
   * work runs under the `admin` lock so that room ids, workspaces and seats are counted one caller at a time. */
  private async checked<T>(actor: RoomActor, action: RoomAction, roomId: string, work: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.authorize && !(await this.authorize(actor, action, roomId))) {
      return failure("FORBIDDEN", `${actor.name} may not ${action} room ${roomId}`);
    }
    return this.locks.run(ADMIN, work);
  }
}

const docKey = (roomId: string, docName: string): string => `${roomId}\0${docName}`;

/** A random unsigned 32-bit integer. */
const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

/** The replay with its bytes present, or an `EngineFault` (the engine was asked to save and did not). */
function savedReplay(replay: ReplayResult, batches: number): ReplayResult & { bytes: Uint8Array } {
  if (replay.bytes === null) throw new EngineFault("the engine saved no bytes");
  if (replay.steps.length !== batches) throw new EngineFault(`the engine applied ${replay.steps.length} of ${batches} batches`);
  return { ...replay, bytes: replay.bytes };
}
