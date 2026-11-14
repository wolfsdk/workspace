// The HTTP API of `wolfsdk-workspace serve`, from the browser: every call carries the bearer token.
import type { RoomActor, RoomHead, RoomState } from "@wolfsdk/protocol/workspace";
import { decodeDisplayListSnapshot, type Page } from "@wolfsdk/runtime/ws-room";

export type RoomRow = { room_id: string; workspace_id: string; seq: number };

export type PackBinding = { binding_id: string; target_doc: string; target_address: string; status: "fresh" | "stale" | "refreshed"; ops: number; notes: string[] };
export type PackStatus = { dir: string; report: { pack_id: string; fresh: boolean; bindings: PackBinding[] } };
export type PackRefresh = PackStatus & { refreshed: string[] };

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

export class WorkspaceApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: Fetch;

  constructor(base: string, token: string, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
    this.#base = base.replace(/\/$/, "");
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.#token}` },
    });
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
    throw new ApiError(response.status, code, message);
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

  me(): Promise<{ actor: RoomActor }> {
    return this.#json("/api/me");
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

  /** The linked pack, or null when the server has none. */
  async pack(): Promise<PackStatus | null> {
    try {
      return await this.#json<PackStatus>("/api/pack");
    } catch (e) {
      if (e instanceof ApiError && e.code === "NO_PACK") return null;
      throw e;
    }
  }

  refreshPack(): Promise<PackRefresh> {
    return this.#json("/api/pack/refresh", { method: "POST" });
  }
}
