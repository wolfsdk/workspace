// The three places an embedder plugs into the MCP server. Each is optional, and the server works without any of
// them: `doc_read` and `doc_search` fall back to the built-in readers of `./read`, and a tool whose hook is
// missing answers with a clear `BAD_REQUEST` instead of pretending.
import type { RoomActor, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import type { RoomService } from "@wolfsdk/server";
import type { BlockMeta, CellValue } from "./read/index.ts";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type DocView = "structure" | "text" | "markdown" | "cells";

/** One addressable unit in the `structure` view. */
export type StructureNode = {
  address: string;
  kind: string;
  depth: number;
  label?: string;
  /** A preview of the unit's own text. */
  text?: string;
  aliases?: string[];
  meta?: BlockMeta;
};

/** One worksheet cell in the `cells` view. */
export type CellView = { address: string; value: CellValue; formula?: string };

/** A document read in one view, whole: the server cuts it to `max_nodes`. */
export type DocContent =
  | { view: "structure"; nodes: StructureNode[] }
  | { view: "text" | "markdown"; text: string }
  | { view: "cells"; cells: CellView[] };

export type InspectRequest = {
  format: WorkspaceDocFormat;
  name: string;
  /** The head of the document. */
  bytes: Uint8Array;
  view: DocView;
  /** An Agent API address that restricts the view. Absent: the whole document. */
  target?: string;
};

/** A reader of documents backed by something better than the built-in parsers (the engine, for one). `read`
 * returns `undefined` to decline a request, and the built-in reader then answers it. It throws `ReadError`
 * (from `./read`) for a `target` that names nothing, and any other error is a fault of the inspector. */
export interface WorkspaceDocInspector {
  read(request: InspectRequest): Promise<DocContent | undefined>;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type VisualRequest = {
  format: WorkspaceDocFormat;
  name: string;
  bytes: Uint8Array;
  /** 1-based, distinct, in the order the caller gave them. */
  pages: number[];
  dpi: 72 | 96 | 150;
  /** Measure only: a page needs a size, not a PNG. */
  preflight: boolean;
};

export type VisualPage = {
  page: number;
  size_pt: [number, number];
  /** The size of the PNG at the requested dpi, when the renderer knows it. */
  pixel_size?: [number, number];
  /** The page as PNG. Absent for a preflight. */
  png?: Uint8Array;
};

export type VisualResult = { page_count: number; pages: VisualPage[] };

/** Draws pages of a document. Throws `VisualPageError` for a page the document does not have. */
export interface VisualRenderer {
  inspect(request: VisualRequest): Promise<VisualResult>;
}

/** A requested page that is not in the document. */
export class VisualPageError extends Error {
  readonly page: number;
  readonly pageCount: number;

  constructor(page: number, pageCount: number) {
    super(`page ${page} is not in a document of ${pageCount} page${pageCount === 1 ? "" : "s"}`);
    this.name = "VisualPageError";
    this.page = page;
    this.pageCount = pageCount;
  }
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

export type PackSummary = { pack: string; bindings: string[]; title?: string };

export type PackRefreshRequest = {
  roomService: RoomService;
  roomId: string;
  actor: RoomActor;
  pack: string;
  /** The binding ids to refresh. Absent: all of them. */
  bindings: readonly string[] | undefined;
  mode: "propose" | "commit";
  /** Announce progress to the room as the agent that is refreshing. Resolves when the room has the event. */
  report(detail: string): Promise<void>;
};

export type PackBindingRefresh = {
  binding: string;
  status: "updated" | "unchanged" | "failed";
  doc?: string;
  proposal_id?: string;
  revision?: number;
  message?: string;
};

export type PackRefreshResult = { pack: string; mode: "propose" | "commit"; bindings: PackBindingRefresh[] };

/** Recalculates the sources of a pack and rewrites its bound targets through the room service. */
export interface PackRefresher {
  /** The packs of the workspace, for `workspace_list`. */
  listPacks?(): Promise<PackSummary[]>;
  /** Refresh `pack`. Throws `PackRefreshError` for a pack or binding that does not exist. */
  refreshPack(request: PackRefreshRequest): Promise<PackRefreshResult>;
}

/** A refresh that can not start because of what was asked (an unknown pack, an unknown binding). */
export class PackRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackRefreshError";
  }
}
