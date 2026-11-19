// Sign-in and page settings: the actor token or the hosting front's session, the engine override, the theme, and the
// format of a picked file.
import type { EngineSource } from "@wolfsdk/review";
import type { RoomActor, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import { ApiError, WorkspaceApi } from "./api.ts";
import { roomSocketUrl } from "./room-client.ts";

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

// ---------------------------------------------------------------------------
// Behind a hosting front
// ---------------------------------------------------------------------------
//
// On a hosted service a front sits before the Workspace server and owns everything under `/-/` on the page's own
// origin. A person signs in there; the front keeps the session in an HttpOnly cookie and sets the upstream
// `Authorization` header on every request and socket upgrade it forwards, so the page holds no token. On a
// self-hosted server nothing owns the prefix, and `GET /-/session` gets whatever an unknown path gets.

/** Where the hosting front answers for the signed-in session. */
export const HOSTED_SESSION_PATH = "/-/session";

/** The person a hosting front signed in, and where its sign-in page and its sign-out endpoint are. A front may also
 * name the page where that person makes agent tokens (`accountPage`) and the page of the plan and the trial's dates
 * (`plansPage`); the top bar links to each one it names. */
export type HostedSession = { account: { email: string; name: string }; signIn: string; signOut: string; accountPage?: string; plansPage?: string };

/** How the page signs in: an actor token it sends itself, or a hosting front's session it never sees. */
export type Credential = { kind: "token"; token: string } | { kind: "hosted"; session: HostedSession };

/** What the page needs from the browser to talk to its server and to leave: a test passes fakes. */
export type PageIo = {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Open `path` on the page's own origin, as `location.assign` does. */
  navigate(path: string): void;
};

/** A path on the page's own origin: one leading `/`, never `//` or `/\`, so following it cannot leave the origin. */
const isOwnPath = (value: unknown): value is string => typeof value === "string" && /^\/(?![/\\])/.test(value);

/** The session in an answer of `GET /-/session`, or null for anything not of the contract's shape: an account with a
 * string email and name, and `signIn` and `signOut` paths on the page's own origin. `accountPage` and `plansPage` are
 * optional: one that is absent or is not a path on the page's own origin is left out, and the session still counts. */
export function hostedSessionOf(value: unknown): HostedSession | null {
  if (typeof value !== "object" || value === null) return null;
  const { account, signIn, signOut } = value as Record<string, unknown>;
  if (typeof account !== "object" || account === null || !isOwnPath(signIn) || !isOwnPath(signOut)) return null;
  const { email, name } = account as Record<string, unknown>;
  if (typeof email !== "string" || typeof name !== "string") return null;
  const { accountPage, plansPage } = value as Record<string, unknown>;
  return {
    account: { email, name },
    signIn,
    signOut,
    ...(isOwnPath(accountPage) ? { accountPage } : {}),
    ...(isOwnPath(plansPage) ? { plansPage } : {}),
  };
}

/** Ask the hosting front once who is signed in: `GET /-/session` on the page's own origin. Only a 200 JSON answer of
 * the contract's shape counts; a 401, the app page as HTML, a 404 or a failed request all mean "not hosted", and the
 * page shows the token form. */
export async function probeHostedSession(fetchImpl: PageIo["fetch"]): Promise<HostedSession | null> {
  try {
    const response = await fetchImpl(HOSTED_SESSION_PATH, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
    if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) return null;
    return hostedSessionOf(await response.json());
  } catch {
    return null;
  }
}

/** How this page starts. A token of the address or the tab (see `takeToken`) wins and asks nothing, so an operator
 * can still use one deliberately behind a hosting front; without one, `probe` asks the front once. Null: show the
 * token form. */
export async function startCredential(token: string | null, probe: () => Promise<HostedSession | null>): Promise<Credential | null> {
  if (token !== null) return { kind: "token", token };
  const session = await probe();
  return session === null ? null : { kind: "hosted", session };
}

/** The API client for a credential. Behind a hosting front it sends no `Authorization` header, and a 401 from any
 * call (the session expired or was revoked) sends the browser to the front's sign-in page. */
export function apiFor(credential: Credential, origin: string, io: PageIo): WorkspaceApi {
  if (credential.kind === "token") return new WorkspaceApi(origin, credential.token, io.fetch);
  const { signIn } = credential.session;
  return new WorkspaceApi(origin, null, io.fetch, { onUnauthorized: () => io.navigate(signIn) });
}

/** The room socket URL for a credential: with `?token=` for a token, with no `token` parameter behind a front. */
export const socketUrlFor = (credential: Credential, origin: string): string =>
  roomSocketUrl(origin, credential.kind === "token" ? credential.token : null);

/** End the hosting front's session (`POST` its `signOut` path), then open its sign-in page. A sign-out the front
 * refuses or that never reaches it throws `SIGN_OUT_FAILED` and navigates nowhere, so nobody is told they left while
 * the session still holds. */
export async function signOutHosted(session: HostedSession, io: PageIo): Promise<void> {
  const retry = "Try Sign out again, or close the browser to end the session.";
  let response: Response;
  try {
    response = await io.fetch(session.signOut, { method: "POST", credentials: "same-origin" });
  } catch (e) {
    throw new ApiError(0, "SIGN_OUT_FAILED", `Sign out did not reach the server (POST ${session.signOut}: ${e instanceof Error ? e.message : String(e)}). ${retry}`);
  }
  if (!response.ok) throw new ApiError(response.status, "SIGN_OUT_FAILED", `Sign out did not finish: POST ${session.signOut} answered ${response.status}. ${retry}`);
  io.navigate(session.signIn);
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
