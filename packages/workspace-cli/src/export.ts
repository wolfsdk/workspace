// `GET /api/export` of `serve`: every document of one workspace, at its head, as one ZIP archive with a manifest
// that names each room, document and revision (`exportWorkspace` of `@wolfsdk/server` writes it).
//
// A server may hold rooms of more than one workspace (`POST /api/rooms` takes a `workspace_id`), so the export walks
// the rooms of one workspace only: the one `?workspace=` names, else the server's own (`workspaceId`), else the one
// workspace its rooms belong to. Each room of that workspace is read as the caller, so whoever the `authorize` hook of
// the room service keeps out of a room of the workspace (a member of another workspace) is refused before the first
// byte, and a room of another workspace never decides whether this export works. A caller whose token belongs to
// another workspace's server is not known here at all, and `serve` answers 401 before this runs.
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { exportWorkspace, type RoomFailure, type RoomService, type WorkspaceExport } from "@wolfsdk/server";

/** Why an export was refused: a room failure of the walk, or a workspace the server holds nothing of. */
export type ExportRefusal = RoomFailure | { code: "UNKNOWN_WORKSPACE"; message: string };

/** The workspace an export walks, and its archive. */
export type PlannedExport = { workspace_id: string; archive: WorkspaceExport };

export type ExportPlan = { ok: true; value: PlannedExport } | { ok: false; error: ExportRefusal };

export type ExportRequest = {
  /** The workspace `?workspace=` names, already checked to be an id, or `null`. */
  named: string | null;
  /** The workspace of the server (`WorkspaceServerOptions.workspaceId`), or `null`. */
  configured: string | null;
  /** The clock of `exported_at`. Default: the system clock. */
  now?: () => Date;
};

/** The workspace of a server that holds no room and was given none, as `createRoom` of `serve` names it. */
const DEFAULT_WORKSPACE = "default";

/** `service` as one workspace sees it: `listRooms` lists the rooms of `workspaceId` only, and every other member is
 * the service's own, bound to it. */
export function workspaceRooms(service: RoomService, workspaceId: string): RoomService {
  const listRooms: RoomService["listRooms"] = async () => (await service.listRooms()).filter((row) => row.workspace_id === workspaceId);
  return new Proxy(service, {
    get(target, key) {
      if (key === "listRooms") return listRooms;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Decide the workspace of an export and plan its archive for `actor`. Nothing is read from a document here: a
 * refusal (a room the actor may not read, a workspace that is not named when the server holds several, a workspace
 * the server holds nothing of) comes before the archive does. Works in a read-only workspace: it writes nothing. */
export async function planExport(service: RoomService, actor: RoomActor, request: ExportRequest): Promise<ExportPlan> {
  const held = [...new Set((await service.listRooms()).map((row) => row.workspace_id))].sort();
  let workspaceId: string;
  if (request.named !== null) {
    workspaceId = request.named;
    if (workspaceId !== request.configured && !held.includes(workspaceId)) {
      return { ok: false, error: { code: "UNKNOWN_WORKSPACE", message: `this server holds no room of workspace ${JSON.stringify(workspaceId)}` } };
    }
  } else if (request.configured !== null) {
    workspaceId = request.configured;
  } else if (held.length <= 1) {
    workspaceId = held[0] ?? DEFAULT_WORKSPACE;
  } else {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: `this server holds the workspaces ${held.map((id) => JSON.stringify(id)).join(", ")}: name one with ?workspace=<id>` },
    };
  }
  const planned = await exportWorkspace(workspaceRooms(service, workspaceId), actor, request.now ? { now: request.now } : {});
  return planned.ok ? { ok: true, value: { workspace_id: workspaceId, archive: planned.value } } : planned;
}

/** The response of a planned export: the archive, streamed one chunk at a time as the client reads it. A document that
 * cannot be read after the archive began ends the response early, and the archive has no directory then. */
export function exportResponse({ workspace_id, archive }: PlannedExport): Response {
  const chunks = archive.chunks[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return?.();
    },
  });
  const day = archive.exported_at.slice(0, 10).replaceAll("-", "");
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="wolf-workspace-export-${day}.zip"`,
      "cache-control": "no-store",
      "x-wolf-workspace": workspace_id,
      "x-wolf-rooms": String(archive.rooms),
      "x-wolf-documents": String(archive.documents),
    },
  });
}
