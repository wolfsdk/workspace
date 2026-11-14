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

/** Why a call did not happen. `REVISION_MISMATCH` carries the head the writer must rebase on. `ENGINE_FAILED`
 * means the engine could not run the request: nothing was stored, the request was not judged, and the same
 * request can succeed later. `BAD_REQUEST` is a request the engine judged and refused. */
export type RoomFailure =
  | { code: "REVISION_MISMATCH"; message: string; detail: RoomConflictDetail }
  | { code: RoomErrorCode; message: string };

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

export type EditOutcome =
  | { mode: "commit"; head: RoomHead; entry: RoomSessionEntry }
  | { mode: "propose"; proposal: RoomProposal };

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
   * judged it and `ENGINE_FAILED` when the engine could not run it. Edits of one document are serialized. */
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
