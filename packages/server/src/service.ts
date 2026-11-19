// The in-process service interface of the workspace room server. Another package (the MCP endpoint) calls
// this interface; the WebSocket endpoint of this package calls it too. It is transport-free: no socket, no
// HTTP, no process, and every value is a `@wolfsdk/protocol/workspace` type. A method either returns the value
// it promises or a `RoomFailure` that maps one to one onto an `error` event of `wolfsdk.room.v1`; it throws
// only for a bug or a broken disk.
//
// Every call that changes a room is atomic: the session log, the head, the proposals and the events it
// announces are stored together, or nothing is. The events a call announces reach every subscriber after the
// state is stored, in `seq` order.
import type {
  RoomActor,
  RoomAgentActivity,
  RoomBatch,
  RoomConflictDetail,
  RoomErrorCode,
  RoomHead,
  RoomMention,
  RoomProposal,
  RoomServerEvent,
  RoomSessionEntry,
  RoomState,
  RoomThread,
  WorkspaceDocFormat,
} from "@wolfsdk/protocol/workspace";

/** The stable code of a refusal that the plan of the customer caused, not the licence: the limit that was reached.
 * The message of such a refusal starts with it. On the wire the code stays `LICENSE_LIMIT`, the one code of the
 * contract for a limit, so a client that knows nothing of plans still reads the refusal correctly. */
export type PlanLimitReason = "plan-seat-limit" | "plan-workspace-limit";

/** The stable code of the refusal of a write that a read-only workspace gives. The message of such a refusal starts
 * with it, and ends with the reason the workspace is read-only and the way out of it. On the wire the code is
 * `LICENSE_LIMIT`, as for a plan limit: the workspace is not allowed to change, and a client that knows nothing of
 * read-only mode reads the refusal as the limit of what it may do. */
export type ReadOnlyReason = "workspace-read-only";

/** A workspace that serves reads and refuses every write, with the words that say why and what to do about it. */
export type ReadOnlyMode = {
  /** Why the workspace is read-only, in the words of the party that runs it ("The trial ended on 2026-11-28."). */
  reason: string;
  /** What to do about it ("https://example.com/upgrade"): it ends the message of a refusal. */
  upgrade: string;
};

/** A cap a plan puts on the licence. The server admits the smaller of the two limits. */
export type PlanCap = {
  /** The most seats the plan admits, or `null` for no limit of the plan. */
  maxSeats: number | null;
  /** The most workspaces the plan serves, or `null` for no limit of the plan. */
  maxWorkspaces: number | null;
  /** What the plan is called in a refusal ("the free plan admits..."). Default `current`. */
  name?: string;
  /** What to do about a refusal, in the words of the party that sells the plan: it ends the message. */
  upgrade: string;
};

/** Why a call did not happen. `REVISION_MISMATCH` carries the head the writer must rebase on. `ENGINE_FAILED`
 * means the engine could not run the request: nothing was stored, the request was not judged, and the same
 * request can succeed later. `BAD_REQUEST` is a request the engine judged and refused. `reason` is set on a
 * `LICENSE_LIMIT` that a plan or read-only mode caused. */
export type RoomFailure =
  | { code: "REVISION_MISMATCH"; message: string; detail: RoomConflictDetail }
  | { code: RoomErrorCode; message: string; reason?: PlanLimitReason | ReadOnlyReason };

export type Result<T> = { ok: true; value: T } | { ok: false; error: RoomFailure };

/** `doc.edit` of the room contract, minus the transport's `request_id`. */
export type EditRequest = {
  doc_name: string;
  /** The revision the batch was written against. Anything but the current head revision is refused. */
  base_revision: number;
  /** `commit` applies the batch to the head at once; `propose` holds it as an open proposal. */
  mode: "propose" | "commit";
  /** The batch to apply. The client may pin any of `clock`, `timezone`, `locale` and `seed`; the server pins the
   * rest when it accepts the batch, so the batch a proposal or a session entry holds always names all four. */
  batch: RoomBatch;
};

/** What `edit` answers. A proposal says whether it already existed: a batch whose document, base revision and ops
 * equal those of a proposal already open (a pack refreshed twice, an agent repeating its edit) opens nothing, and
 * the answer is that open proposal with `existed: true`. A proposal the edit opened has `existed: false`. */
export type EditOutcome =
  | { mode: "commit"; head: RoomHead; entry: RoomSessionEntry }
  | { mode: "propose"; proposal: RoomProposal; existed: boolean };

/** `proposal.decide` of the room contract. */
export type DecideRequest = { proposal_id: string; decision: "approve" | "reject" };

/** The proposal after the decision, the session entries an approval committed (none for a rejection) and the
 * head of its document afterwards. */
export type DecideOutcome = { proposal: RoomProposal; entries: RoomSessionEntry[]; head: RoomHead };

/** `comment.post` of the room contract, minus the transport's `request_id`. */
export type CommentRequest = {
  /** `null` opens a thread; an id replies to that thread. */
  thread_id: string | null;
  doc_name: string;
  target_address: string;
  body: string;
  mentions: RoomMention[];
  /** Append the message and mark the thread resolved (a reply only: a new thread has nothing to resolve). A post
   * without it leaves `resolved` as it was. */
  resolve?: boolean;
};

/** What an agent reports about itself: announced to the room as an `agent.activity` event. */
export type ActivityReport = { doc_name: string | null; activity: RoomAgentActivity; detail?: string };

/** The head of a document with its bytes, as the engine would open them. */
export type DocumentRead = { head: RoomHead; page_hashes?: string[]; bytes: Uint8Array };

/** The preview of a proposal: the document as it would be if the proposal were approved now. */
export type PreviewRead = { proposal: RoomProposal; bytes: Uint8Array };

/** Receives the events of a room. Called synchronously, in `seq` order, and never re-entered. An exception
 * thrown by a listener unsubscribes it. An `error` event is the last one a listener receives: the server has ended
 * the subscription (the identity lost its seat), and the client must join again. */
export type RoomListener = (event: RoomServerEvent) => void;

export type RoomSubscription = { unsubscribe(): void };

export interface RoomService {
  /** Create a room in a workspace. Fails with `LICENSE_LIMIT` when the workspace is one more than the
   * entitlement allows, and with `BAD_REQUEST` when the room id is taken. */
  createRoom(actor: RoomActor, input: { room_id: string; workspace_id: string }): Promise<Result<RoomState>>;

  /** The ids of the rooms this server holds. */
  listRooms(): Promise<{ room_id: string; workspace_id: string; seq: number }[]>;

  /** The full state of a room (a value that passes `validateRoomSnapshot`). Reading takes a seat like any other
   * call: `LICENSE_LIMIT` when `actor` has none and none is left. */
  getRoom(room_id: string, actor: RoomActor): Promise<Result<RoomState>>;

  /** Add a document at revision 0: its head is the SHA-256 of `bytes`. The engine opens the bytes first;
   * bytes it refuses are `BAD_REQUEST`. The room announces the addition with a `doc.added` event. */
  addDocument(
    room_id: string,
    actor: RoomActor,
    input: { name: string; format: WorkspaceDocFormat; bytes: Uint8Array },
  ): Promise<Result<RoomHead>>;

  /** The head of a document and its bytes. */
  readHead(room_id: string, actor: RoomActor, doc_name: string): Promise<Result<DocumentRead>>;

  /** The preview bytes of a proposal that has one. */
  readPreview(room_id: string, actor: RoomActor, proposal_id: string): Promise<Result<PreviewRead>>;

  /** `doc.edit`: commit a batch to the head, or hold it as a proposal. A stale `base_revision` is
   * `REVISION_MISMATCH`; a batch the engine refuses commits nothing, and is `BAD_REQUEST` when the engine
   * judged it and `ENGINE_FAILED` when the engine could not run it. Edits of one document are serialized. A
   * proposal equal to an open one answers with that proposal and `existed: true` (see `EditOutcome`). */
  edit(room_id: string, actor: RoomActor, request: EditRequest): Promise<Result<EditOutcome>>;

  /** `proposal.decide`: approve (commit the proposal's batches, replayed as stored, with the proposal's id and the
   * approving user on every entry) or reject. An agent is refused with `FORBIDDEN`, whatever the authorize hook
   * admits: only a user decides. A proposal that is not `open` is `PROPOSAL_NOT_OPEN`. An approval the engine
   * could not run, or whose replay does not reproduce the preview, is `ENGINE_FAILED` and leaves the proposal open. */
  decideProposal(room_id: string, actor: RoomActor, request: DecideRequest): Promise<Result<DecideOutcome>>;

  /** `comment.post`: open a thread, or reply to one and optionally resolve it. */
  postComment(room_id: string, actor: RoomActor, request: CommentRequest): Promise<Result<RoomThread>>;

  /** Announce what an agent is doing. Takes a `seq` like every event. */
  reportActivity(room_id: string, agent: RoomActor, report: ActivityReport): Promise<Result<void>>;

  /** `room.join`: subscribe `listener`. Before any live event it receives, in order, what the client
   * missed: the events after `since_seq`, or one `room.snapshot` when `since_seq` is `null`, ahead of the
   * room, or older than the retained events. The promise rejects when the stored room is damaged (a stored
   * event or the snapshot no longer validates). */
  join(room_id: string, actor: RoomActor, since_seq: number | null, listener: RoomListener): Promise<Result<RoomSubscription>>;
}

/** The live link of a shared document: whoever holds `token` may view the document with no account. */
export type ShareLink = { token: string; room_id: string; doc_name: string; created_by: RoomActor; created_at: string };

/** The share links of a server. Links live in the room database, so they survive a restart and travel with its
 * backup. A document has at most one live link, and a link ends with its document. */
export interface ShareLinks {
  /** The live link of a document, or `null`. */
  shareOf(room_id: string, doc_name: string): ShareLink | null;

  /** Make the link of a document, or answer the live one with `existed: true`. Fails as an unknown room or
   * document does, and as any write does while the workspace is read-only. */
  share(room_id: string, doc_name: string, by: RoomActor): Promise<Result<{ link: ShareLink; existed: boolean }>>;

  /** End the live link of a document, also while the workspace is read-only. `false` when it had none. An ended
   * token never resolves again. */
  unshare(room_id: string, doc_name: string): boolean;

  /** The live link a token names, or `null`: an unknown token and an ended one cannot be told apart. */
  resolveShare(token: string): ShareLink | null;
}
