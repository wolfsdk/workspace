// The HTTP API of `wolfsdk-workspace serve`, from the browser: every call carries the bearer token, or no
// `Authorization` header at all behind a hosting front, which authenticates the call from its session cookie.
import type { RoomActor, RoomHead, RoomState, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import { decodeDisplayListSnapshot, type Page } from "@wolfsdk/runtime/ws-room";

export type RoomRow = { room_id: string; workspace_id: string; seq: number };

export type PackBinding = { binding_id: string; target_doc: string; target_address: string; status: "fresh" | "stale" | "refreshed"; ops: number; notes: string[] };
/** The linked pack as the server judged it: against the heads of `room`, or on disk when `room` is null. */
export type PackStatus = {
  dir: string;
  room?: string | null;
  report: { pack_id: string; fresh: boolean; bindings: PackBinding[] };
  /** Judge the pack again, against the heads of `roomId` (the server's default room when null): a commit to a
   * source or target changes what is stale. Null once the server has no pack. */
  reload?(roomId: string | null): Promise<PackStatus | null>;
};
export type PackRefresh = PackStatus & { refreshed: string[] };

/** The documents a guest may reach. A guest reads, comments on and proposes edits to these and nothing else. */
export type GuestScope = { docs: { room_id: string; doc_name: string }[] };

/** Who the caller is: its actor, and its scope when it is a guest (null for a member, and from a server that predates
 * guests). */
export type Me = { actor: RoomActor; guest: GuestScope | null };

/** The live share link of a document, as a member sees it. `path` is the page of the link, `/s/<token>`. */
export type Share = { token: string; path: string; room_id: string; doc_name: string; created_at: string; created_by: RoomActor };

/** What anyone holding a live link learns of the document: its name and head, who shared it, and where an agent finds
 * its instructions (`connect`, a path with `?share=<token>`, or null when the server offers none). */
export type PublicShare = {
  room_id: string;
  doc_name: string;
  format: WorkspaceDocFormat;
  revision: number;
  updated_at: string;
  shared_by: string;
  connect: string | null;
};

/** A guest of a shared document, as the hosting front lists them. */
export type ShareGuest = { id: string; email: string; name: string; added_at: string };

/** The guests of a document and how many it may have. */
export type ShareGuests = { guests: ShareGuest[]; limit: number };

/** What one cell holds, as live cells read and write it: text, a number, a boolean, or a formula with its leading `=`.
 * Null is a blank cell. */
export type CellValue = { string: string } | { number: number } | { boolean: boolean } | { formula: string } | null;

/** One cell of a read: its address, what it holds, and the text the engine calculated for it when there is one.
 * `editable` false marks a cell the server would not write (an error constant, say). A cell the read leaves out is
 * blank. */
export type LiveCell = { a1: string; value: CellValue; display?: string; editable?: boolean };

/** A sheet of the workbook: `id` is its place among the sheets, from 1. */
export type LiveSheet = { id: number; name: string };

/** Another member and the cell they are on, while their announcement of it lasts. */
export type LivePeer = { id: string; name: string; sheet: number; a1: string };

/** Why no cell of a workbook may be written live, in the server's words: `LICENSE_LIMIT` (a read-only workspace),
 * `LIVE_CELLS_UNATTESTED` (bytes the server has not been told are safe to write cell by cell),
 * `LIVE_CELLS_UNSUPPORTED`. */
export type LiveRefusal = { code: string; message: string };

/** A window of one sheet at one revision of the head, with the other members on its cells. `editable` false, with
 * the `refusal` that says why, is a workbook the server reads but does not let anyone write here; it can change from
 * one read to the next. `merged` lists the merged ranges that reach into the window, as `D1:F1`. */
export type LiveCells = {
  revision: number;
  sheet: number;
  sheets: LiveSheet[];
  cells: LiveCell[];
  peers: LivePeer[];
  editable: boolean;
  refusal: LiveRefusal | null;
  merged?: string[];
};

/** One cell written over what a read at `revision` found in it (`expected`). A draft reapplied over a newer read also
 * sends `draftRevision`, the revision of the read it was typed on: the sheets must not have changed since then either. */
export type LiveCellWrite = { revision: number; draftRevision?: number; sheet: number; a1: string; expected: CellValue; value: CellValue };

/** A refused call: the `error.code` and `error.message` of the body, and the HTTP status. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Bytes of a document with the receipts the server sends with them. */
export type DocumentBytes = { bytes: Uint8Array; sha256: string; revision: number | null };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type WorkspaceApiOptions = {
  /** Called with every refusal of status 401 before the call throws it. Behind a hosting front a 401 means the session
   * expired or was revoked, and the app sends the browser to the front's sign-in page from here. */
  onUnauthorized?(error: ApiError): void;
};

export class WorkspaceApi {
  readonly #base: string;
  readonly #token: string | null;
  readonly #fetch: Fetch;
  readonly #onUnauthorized: ((error: ApiError) => void) | undefined;

  /** `token` null sends no `Authorization` header (never an empty `Bearer`): the hosting front sets it upstream. */
  constructor(base: string, token: string | null, fetchImpl: Fetch = (input, init) => fetch(input, init), options: WorkspaceApiOptions = {}) {
    this.#base = base.replace(/\/$/, "");
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#onUnauthorized = options.onUnauthorized;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.#token !== null) headers.authorization = `Bearer ${this.#token}`;
    const response = await this.#fetch(`${this.#base}${path}`, { ...init, headers });
    if (response.ok) return response;
    let code = `HTTP_${response.status}`;
    let message = response.statusText || `the server answered ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null) {
        const error = body.error as { code?: unknown; message?: unknown };
        if (typeof error.code === "string") code = error.code;
        if (typeof error.message === "string") message = error.message;
      }
    } catch {
      // Not JSON: the status says enough.
    }
    const error = new ApiError(response.status, code, message);
    if (response.status === 401) this.#onUnauthorized?.(error);
    throw error;
  }

  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.#call(path, init)).json()) as T;
  }

  async #bytes(path: string): Promise<DocumentBytes> {
    const response = await this.#call(path);
    const revision = response.headers.get("x-wolf-revision");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      sha256: response.headers.get("x-wolf-sha256") ?? "",
      revision: revision === null ? null : Number(revision),
    };
  }

  /** Who the caller is. `GET /api/me`; a `guest` the server leaves out counts as null. */
  async me(): Promise<Me> {
    const body = await this.#json<{ actor: RoomActor; guest?: GuestScope | null }>("/api/me");
    return { actor: body.actor, guest: body.guest ?? null };
  }

  async rooms(): Promise<RoomRow[]> {
    return (await this.#json<{ rooms: RoomRow[] }>("/api/rooms")).rooms;
  }

  createRoom(roomId: string): Promise<RoomState> {
    return this.#json("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room_id: roomId }) });
  }

  async upload(roomId: string, file: File): Promise<RoomHead> {
    const form = new FormData();
    form.append("file", file, file.name);
    return (await this.#json<{ head: RoomHead }>(`/api/rooms/${encodeURIComponent(roomId)}/docs`, { method: "POST", body: form })).head;
  }

  head(roomId: string, doc: string): Promise<DocumentBytes> {
    return this.#bytes(`/api/rooms/${encodeURIComponent(roomId)}/docs/${encodeURIComponent(doc)}/head`);
  }

  preview(roomId: string, proposalId: string): Promise<DocumentBytes> {
    return this.#bytes(`/api/rooms/${encodeURIComponent(roomId)}/proposals/${encodeURIComponent(proposalId)}/preview`);
  }

  /** The display-list pages of the head of `doc`, as the server painted them: what a shared link shows without
   * opening an engine. `GET /api/rooms/<room>/docs/<doc>/snapshot`; the body is UTF-8 JSON, `{ "pages": [...] }`
   * with one `display_list` response per page (see `decodeDisplayListSnapshot`). */
  async snapshot(roomId: string, doc: string): Promise<Page[]> {
    const response = await this.#call(`/api/rooms/${encodeURIComponent(roomId)}/docs/${encodeURIComponent(doc)}/snapshot`);
    return decodeDisplayListSnapshot(new Uint8Array(await response.arrayBuffer()));
  }

  /** The linked pack judged against the heads of `roomId` (the server's default room when null), or null when the
   * server has none. */
  async pack(roomId: string | null = null): Promise<PackStatus | null> {
    try {
      return this.#reloadable(await this.#json<PackStatus>(roomId === null ? "/api/pack" : `/api/pack?room=${encodeURIComponent(roomId)}`));
    } catch (e) {
      if (e instanceof ApiError && e.code === "NO_PACK") return null;
      throw e;
    }
  }

  async refreshPack(): Promise<PackRefresh> {
    return this.#reloadable(await this.#json<PackRefresh>("/api/pack/refresh", { method: "POST" }));
  }

  #reloadable<T extends PackStatus>(status: T): T {
    return { ...status, reload: (roomId: string | null) => this.pack(roomId) };
  }

  #docPath(roomId: string, doc: string): string {
    return `/api/rooms/${encodeURIComponent(roomId)}/docs/${encodeURIComponent(doc)}`;
  }

  /** The live share link of a document, or null. `GET /api/rooms/<room>/docs/<doc>/share`, for a member user. */
  async shareOf(roomId: string, doc: string): Promise<Share | null> {
    return (await this.#json<{ share: Share | null }>(`${this.#docPath(roomId, doc)}/share`)).share;
  }

  /** Make the share link of a document, or get the live one. `PUT /api/rooms/<room>/docs/<doc>/share`. */
  async share(roomId: string, doc: string): Promise<Share> {
    return (await this.#json<{ share: Share }>(`${this.#docPath(roomId, doc)}/share`, { method: "PUT" })).share;
  }

  /** End the share link of a document: it stops working for everyone who has it. `DELETE .../share`. */
  async unshare(roomId: string, doc: string): Promise<void> {
    await this.#call(`${this.#docPath(roomId, doc)}/share`, { method: "DELETE" });
  }

  /** A window of one sheet of an XLSX head: `GET /api/rooms/<room>/docs/<doc>/live-cells?sheet=&range=`, for a member.
   * `sheet` null asks for the first visible sheet; the answer names the sheet it read. Never from the HTTP cache: the
   * grid reads it again to follow the room. */
  liveCells(roomId: string, doc: string, sheet: number | null, range: string): Promise<LiveCells> {
    const query = new URLSearchParams(sheet === null ? { range } : { sheet: String(sheet), range });
    return this.#json(`${this.#docPath(roomId, doc)}/live-cells?${query}`, { cache: "no-store" });
  }

  /** Write one cell over what a read found in it. `PUT .../live-cells` answers the revision the write made. A cell or
   * sheets that moved on since that read throw `CELL_CONFLICT` or `STRUCTURE_CONFLICT` (409); a workbook no one may
   * write here `LIVE_CELLS_UNATTESTED` (403) or `LICENSE_LIMIT` (402); a cell or entry it cannot take
   * `CELL_UNSUPPORTED` (422). */
  async writeLiveCell(roomId: string, doc: string, write: LiveCellWrite): Promise<number> {
    const body = await this.#json<{ revision: number }>(`${this.#docPath(roomId, doc)}/live-cells`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(write),
    });
    return body.revision;
  }

  /** Say which cell the caller is on, for the others' reads until it expires. `POST .../live-cells` answers 204; the
   * server knows who is asking. */
  async announceLiveCell(roomId: string, doc: string, at: { sheet: number; a1: string }): Promise<void> {
    await this.#call(`${this.#docPath(roomId, doc)}/live-cells`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(at),
    });
  }

  /** What a share link shows. `GET /api/share/<token>` needs no credential; an unknown or ended link throws
   * `SHARE_NOT_FOUND` with status 404. */
  publicShare(token: string): Promise<PublicShare> {
    return this.#json<{ share: PublicShare }>(`/api/share/${encodeURIComponent(token)}`).then((body) => body.share);
  }

  /** The painted pages of the head a share link shows. `GET /api/share/<token>/snapshot` needs no credential and
   * answers the body of `snapshot`, or the same 404 as `publicShare`. */
  async publicSnapshot(token: string): Promise<Page[]> {
    const response = await this.#call(`/api/share/${encodeURIComponent(token)}/snapshot`);
    return decodeDisplayListSnapshot(new Uint8Array(await response.arrayBuffer()));
  }

  /** The guests of a document, from the hosting front: `GET /-/share/guests?room=&doc=`. Null where nothing answers
   * for them: a front without the route (404), or an answer of another shape (a server's app page). */
  async shareGuests(roomId: string, doc: string): Promise<ShareGuests | null> {
    let body: unknown;
    try {
      body = await this.#json(`/-/share/guests?${new URLSearchParams({ room: roomId, doc })}`);
    } catch (e) {
      if ((e instanceof ApiError && e.status === 404) || e instanceof SyntaxError) return null;
      throw e;
    }
    if (typeof body !== "object" || body === null || !("guests" in body) || !Array.isArray(body.guests)) return null;
    const limit = "limit" in body && typeof body.limit === "number" ? body.limit : 3;
    return { guests: body.guests as ShareGuest[], limit };
  }

  /** Take a guest off a document: their session and agent tokens stop working for it at once.
   * `DELETE /-/share/guests/<account id>?room=&doc=`. */
  async removeShareGuest(roomId: string, doc: string, id: string): Promise<void> {
    await this.#call(`/-/share/guests/${encodeURIComponent(id)}?${new URLSearchParams({ room: roomId, doc })}`, { method: "DELETE" });
  }
}
