// Sign-in and page settings: the actor token, the engine override, the theme, and the format of a picked file.
import type { EngineSource } from "@wolfsdk/review";
import type { RoomActor, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";

export const TOKEN_KEY = "wolf-workspace.token";
export const THEME_KEY = "wolf-workspace.theme";

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The token to sign in with: `?token=` of the page (stored for the tab, then dropped from the address bar so it
 * does not end up in a bookmark or a screenshot), else the one stored for the tab. `search` comes back without it. */
export function takeToken(search: string, storage: KeyValue): { token: string | null; search: string } {
  const params = new URLSearchParams(search);
  const given = params.get("token")?.trim();
  if (given) {
    storage.setItem(TOKEN_KEY, given);
    params.delete("token");
    const rest = params.toString();
    return { token: given, search: rest === "" ? "" : `?${rest}` };
  }
  return { token: storage.getItem(TOKEN_KEY), search };
}

/** Where `<wolf-review>` loads its engine from:
 * - `?engine=<url>`: a module URL when it ends in `.wasm`, otherwise a channel root (`latest.txt`, `v<VERSION>/`);
 * - otherwise this server's `/wasm` channel when it serves one;
 * - otherwise null: the element's own release channel. */
export function engineSourceFor(param: string | null, localChannel: boolean, origin: string): EngineSource | null {
  const given = param?.trim();
  if (given) {
    const url = new URL(given, origin);
    return /\.wasm$/i.test(url.pathname) ? { url: url.toString() } : { channel: url.toString().replace(/\/$/, "") };
  }
  return localChannel ? { channel: new URL("/wasm", origin).toString() } : null;
}

/** Whether the page is a shared-link snapshot: `?share=1` or `?snapshot=1` (also `true`, or the bare parameter). A
 * shared link shows the server's display-list pages and loads no engine. */
export function shareModeOf(search: string): boolean {
  const params = new URLSearchParams(search);
  return ["share", "snapshot"].some((key) => {
    const value = params.get(key)?.trim().toLowerCase();
    return value === "" || value === "1" || value === "true";
  });
}

/** The engine `<wolf-review>` loads for this page, see `engineSourceFor`. Probing the server's `/wasm` channel is
 * the only request this makes; a shared snapshot makes none, because it opens no engine. */
export async function engineFor(
  params: URLSearchParams,
  shareMode: boolean,
  origin: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Pick<Response, "ok">> = (input, init) => fetch(input, init),
): Promise<EngineSource | null> {
  if (shareMode) return null;
  const given = params.get("engine");
  const local = given ? false : await fetchImpl("/wasm/latest.txt", { method: "GET" }).then((r) => r.ok, () => false);
  return engineSourceFor(given, local, origin);
}

/** A short description of an engine source for the status bar. */
export function describeEngine(source: EngineSource | null): string {
  if (source === null) return "Release channel";
  if (source.url !== undefined) return `Module ${String(source.url)}`;
  return `Channel ${source.channel ?? ""}`;
}

export type Theme = "light" | "dark";

/** The stored theme, else the system's. */
export function initialTheme(storage: KeyValue, prefersDark: boolean): Theme {
  const stored = storage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

const FORMATS: Record<string, WorkspaceDocFormat> = { docx: "docx", xlsx: "xlsx", pptx: "pptx", pdf: "pdf" };

/** The document format of a file name, from its extension; null for anything the room does not hold. */
export function formatOfFile(name: string): WorkspaceDocFormat | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (FORMATS[name.slice(dot + 1).toLowerCase()] ?? null);
}

/** Formats `<wolf-review>` opens; a PDF in the room is downloaded, not opened. */
export const isReviewable = (format: WorkspaceDocFormat): format is "docx" | "xlsx" | "pptx" => format !== "pdf";

export const actorLabel = (actor: RoomActor): string => (actor.kind === "agent" ? "Agent" : "User");

/** Agents named in a comment: every agent of `candidates` whose `@id` or `@name` (spaces dropped) the body holds. */
export function mentionsIn(body: string, candidates: readonly RoomActor[]): { kind: RoomActor["kind"]; id: string }[] {
  const words = new Set((body.match(/@[\w.-]+/g) ?? []).map((w) => w.slice(1).toLowerCase()));
  return candidates
    .filter((a) => words.has(a.id.toLowerCase()) || words.has(a.name.replace(/\s+/g, "").toLowerCase()))
    .map((a) => ({ kind: a.kind, id: a.id }));
}

/** The handle `mentionsIn` recognizes for an actor. */
export const mentionHandle = (actor: RoomActor): string => `@${actor.id}`;

/** A room id the server accepts, from what someone typed: lowercase, words joined by dashes. */
export function roomIdFrom(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `ab12cd34` from a sha256. */
export const shortSha = (sha: string): string => sha.replace(/^sha256:/, "").slice(0, 8);
