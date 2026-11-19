// The room service as an identity that is not a member sees it. A guest of a shared document, or the viewer of a
// share link, may reach a short list of (room, document) pairs and nothing else: this wrapper applies that list to
// every call and every event of the room, on top of any `RoomService`.
//
// What the caller must never learn is what else exists. A room, document, proposal or thread outside the list is
// refused here, with the failure the service gives for one that does not exist, in the same words. A write to a thing
// outside the list never reaches the service, whatever the request holds: the answer cannot depend on whether the
// thing exists. Events and snapshots carry the pairs in scope and no others.
import type { RoomActor, RoomServerEvent, RoomState } from "@wolfsdk/protocol/workspace";
import type {
  ActivityReport,
  CommentRequest,
  DecideRequest,
  EditRequest,
  RoomFailure,
  RoomListener,
  RoomService,
} from "./service.ts";

/** What an identity that is not a member may reach. `view` reads; `propose` also comments and proposes edits. */
export type AccessScope = { access: "view" | "propose"; docs: readonly { room_id: string; doc_name: string }[] };

/** The scope of an identity, or `null` for a member, who is not limited. Asked on every call. */
export type ScopeOf = (actor: RoomActor) => AccessScope | null | Promise<AccessScope | null>;

const failure = (code: Exclude<RoomFailure["code"], "REVISION_MISMATCH">, message: string): { ok: false; error: RoomFailure } => ({
  ok: false,
  error: { code, message },
});

/** A scope looked up by room: the documents of each room that the caller reaches. */
type Reach = ReadonlyMap<string, ReadonlySet<string>>;

function reachOf(scope: AccessScope): Reach {
  const rooms = new Map<string, Set<string>>();
  for (const { room_id, doc_name } of scope.docs) {
    const docs = rooms.get(room_id);
    if (docs === undefined) rooms.set(room_id, new Set([doc_name]));
    else docs.add(doc_name);
  }
  return rooms;
}

/** The state of a room with the documents in `docs`, and what is about them, only. Every kept entry still passes
 * `validateRoomSnapshot`: a session entry, proposal or thread is kept with its document, and a document keeps all of
 * its own entries. */
function filterState(state: RoomState, docs: ReadonlySet<string>): RoomState {
  return {
    ...state,
    documents: state.documents.filter((d) => docs.has(d.head.name)),
    session_log: state.session_log.filter((e) => docs.has(e.doc_name)),
    proposals: state.proposals.filter((p) => docs.has(p.doc_name)),
    comments: state.comments.filter((t) => docs.has(t.doc_name)),
  };
}

/** The event as the caller may see it, or `null` when it is about a document out of scope. An event of a type this
 * version does not know is not delivered: it cannot be shown to be about a document in scope. */
function filterEvent(event: RoomServerEvent, docs: ReadonlySet<string>): RoomServerEvent | null {
  switch (event.type) {
    case "room.snapshot":
      return { ...event, room: filterState(event.room, docs) };
    case "doc.added":
      return docs.has(event.document.head.name) ? event : null;
    case "doc.committed":
      return docs.has(event.head.name) ? event : null;
    case "proposal.updated":
      return docs.has(event.proposal.doc_name) ? event : null;
    case "pages.invalidated":
      return docs.has(event.doc_name) ? event : null;
    case "comment.updated":
      return docs.has(event.thread.doc_name) ? event : null;
    case "agent.activity":
      return event.doc_name !== null && docs.has(event.doc_name) ? event : null;
    case "error":
      return event;
    default:
      return null;
  }
}

/** `service` with the scope of each caller applied. A caller whose scope is `null` is a member: its calls reach
 * `service` untouched. A caller with a scope may read the documents it names; with `propose` access it may also
 * comment on them and propose edits to them. It may not commit, decide a proposal, create a room or add a document. */
export function scopedService(service: RoomService, scopeOf: ScopeOf): RoomService {
  const noRoom = (roomId: string) => failure("UNKNOWN_ROOM", `no room ${roomId}`);
  const noDocument = (roomId: string, name: string) => failure("UNKNOWN_DOCUMENT", `no document ${name} in ${roomId}`);

  return {
    async createRoom(actor, input) {
      if ((await scopeOf(actor)) === null) return service.createRoom(actor, input);
      return failure("FORBIDDEN", "a guest of a shared document does not create rooms");
    },

    listRooms: () => service.listRooms(),

    async getRoom(roomId, actor) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.getRoom(roomId, actor);
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      const state = await service.getRoom(roomId, actor);
      return state.ok ? { ok: true, value: filterState(state.value, docs) } : state;
    },

    async addDocument(roomId, actor, input) {
      if ((await scopeOf(actor)) === null) return service.addDocument(roomId, actor, input);
      return failure("FORBIDDEN", "a guest of a shared document does not add documents");
    },

    async readHead(roomId, actor, docName) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.readHead(roomId, actor, docName);
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      const read = await service.readHead(roomId, actor, docName);
      return read.ok && !docs.has(read.value.head.name) ? noDocument(roomId, docName) : read;
    },

    async readPreview(roomId, actor, proposalId) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.readPreview(roomId, actor, proposalId);
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      const read = await service.readPreview(roomId, actor, proposalId);
      return read.ok && !docs.has(read.value.proposal.doc_name)
        ? failure("UNKNOWN_PROPOSAL", `no proposal ${proposalId} in ${roomId}`)
        : read;
    },

    async edit(roomId, actor, request: EditRequest) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.edit(roomId, actor, request);
      if (scope.access === "view") return failure("FORBIDDEN", "a viewer of a shared document does not edit it");
      if (request.mode === "commit") return failure("FORBIDDEN", "a guest proposes an edit; a member of the workspace commits it");
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      if (!docs.has(request.doc_name)) return noDocument(roomId, request.doc_name);
      return service.edit(roomId, actor, request);
    },

    async decideProposal(roomId, actor, request: DecideRequest) {
      if ((await scopeOf(actor)) === null) return service.decideProposal(roomId, actor, request);
      return failure("FORBIDDEN", "a guest of a shared document does not decide proposals");
    },

    async postComment(roomId, actor, request: CommentRequest) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.postComment(roomId, actor, request);
      if (scope.access === "view") return failure("FORBIDDEN", "a viewer of a shared document does not comment");
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      if (request.thread_id === null) {
        return docs.has(request.doc_name) ? service.postComment(roomId, actor, request) : noDocument(roomId, request.doc_name);
      }
      // A reply names a thread, and the thread says which document it is about: one of another document is not seen.
      const room = await service.getRoom(roomId, actor);
      if (!room.ok) return room;
      const thread = room.value.comments.find((t) => t.thread_id === request.thread_id);
      if (thread !== undefined && docs.has(thread.doc_name)) return service.postComment(roomId, actor, request);
      return failure("UNKNOWN_THREAD", `no thread ${request.thread_id} in ${roomId}`);
    },

    async reportActivity(roomId, agent, report: ActivityReport) {
      const scope = await scopeOf(agent);
      if (scope === null) return service.reportActivity(roomId, agent, report);
      if (scope.access === "view") return failure("FORBIDDEN", "a viewer of a shared document does not report activity");
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      if (report.doc_name !== null && !docs.has(report.doc_name)) return noDocument(roomId, report.doc_name);
      return service.reportActivity(roomId, agent, report);
    },

    async join(roomId, actor, sinceSeq, listener: RoomListener) {
      const scope = await scopeOf(actor);
      if (scope === null) return service.join(roomId, actor, sinceSeq, listener);
      const docs = reachOf(scope).get(roomId);
      if (docs === undefined) return noRoom(roomId);
      return service.join(roomId, actor, sinceSeq, (event) => {
        const seen = filterEvent(event, docs);
        if (seen !== null) listener(seen);
      });
    },
  };
}
