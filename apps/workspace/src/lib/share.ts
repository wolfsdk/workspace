// Share links from the browser: the page a link opens (`/s/<token>`), the prompt that connects someone's own agent to
// it, what the public page loads with no credential, and the Share dialog of a member as a plain state machine the
// dialog renders.
import type { RoomActor } from "@wolfsdk/protocol/workspace";
import { ApiError, type GuestScope, type PublicShare, type Share, type ShareGuests, WorkspaceApi } from "./api.ts";
import type { Page } from "./room-client.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether the signed-in caller gets the Share control: a member user. The server refuses agents and guests the
 * share routes. */
export const canShare = (actor: RoomActor, guest: GuestScope | null): boolean => guest === null && actor.kind === "user";

/** The token of a share page path, `/s/<token>` (a trailing `/` allowed), or null for every other path. */
export function shareTokenOf(pathname: string): string | null {
  return /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname)?.[1] ?? null;
}

/** The address of the page a share link opens. */
export const sharePageUrl = (origin: string, token: string): string => `${origin.replace(/\/$/, "")}/s/${token}`;

/** What a person pastes into their own agent to connect it to a shared document: the link, and where the agent finds
 * its instructions. `connect` is the path the server names (`PublicShare.connect`). */
export function agentPrompt(origin: string, token: string, connect: string): string {
  const base = origin.replace(/\/$/, "");
  return [
    `Connect to this shared Wolf Workspace document and help me edit it: ${sharePageUrl(base, token)}`,
    `Instructions for agents: ${base}${connect}`,
  ].join("\n");
}

/** The client of a share page: no credential, and no sign-in page on a refusal, because a visitor has neither. */
export const publicApiFor = (origin: string, fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): WorkspaceApi =>
  new WorkspaceApi(origin, null, fetchImpl);

/** A refusal that means the link does not resolve: unknown and ended links answer the same 404. */
const isEnded = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

/** What a share page shows: still loading; a link that no longer resolves; a server that did not answer; or the
 * shared document, with its painted pages unless they did not load (`problem` says why). */
export type SharedPageState =
  | { kind: "loading" }
  | { kind: "ended" }
  | { kind: "failed"; error: string }
  | { kind: "shared"; share: PublicShare; pages: readonly Page[] | null; problem: string | null };

/** Load a share page: `GET /api/share/<token>` and its snapshot, and nothing that needs a credential. */
export async function loadSharedPage(api: WorkspaceApi, token: string): Promise<SharedPageState> {
  const [meta, pages] = await Promise.allSettled([api.publicShare(token), api.publicSnapshot(token)]);
  if (meta.status === "rejected") return isEnded(meta.reason) ? { kind: "ended" } : { kind: "failed", error: message(meta.reason) };
  if (pages.status === "rejected") {
    return isEnded(pages.reason) ? { kind: "ended" } : { kind: "shared", share: meta.value, pages: null, problem: message(pages.reason) };
  }
  return { kind: "shared", share: meta.value, pages: pages.value, problem: null };
}

// ---------------------------------------------------------------------------
// The Share dialog
// ---------------------------------------------------------------------------

/** What the Share dialog of a member shows.
 * - `phase`: `loading` until the server answers, then `unshared` or `shared`; `failed` when it did not answer.
 * - `connect`: the agent instructions path of the live link, from its public metadata; null when there is none.
 * - `confirmingStop`: Stop sharing was chosen once and waits for the second, confirming choice.
 * - `guests`: the guests of the document behind a hosting front; null where nothing lists them. */
export type ShareDialogState = {
  phase: "loading" | "unshared" | "shared" | "failed";
  share: Share | null;
  connect: string | null;
  busy: "create" | "stop" | null;
  confirmingStop: boolean;
  error: string | null;
  guests: ShareGuests | null;
  guestsError: string | null;
  removing: string | null;
};

/** The dialog before the server has answered. */
export const SHARE_DIALOG_LOADING: ShareDialogState = {
  phase: "loading",
  share: null,
  connect: null,
  busy: null,
  confirmingStop: false,
  error: null,
  guests: null,
  guestsError: null,
  removing: null,
};

export type ShareDialogOptions = {
  /** Behind a hosting front, which lists and removes the guests of a document. */
  hosted: boolean;
  /** Called with every new state. */
  onChange(state: ShareDialogState): void;
};

/** The Share dialog of one document: find its link, make one, end it after a confirmation, and list and remove its
 * guests behind a hosting front. Every change goes to `onChange`. */
export class ShareDialogModel {
  readonly #api: WorkspaceApi;
  readonly #roomId: string;
  readonly #doc: string;
  readonly #options: ShareDialogOptions;
  #state: ShareDialogState = SHARE_DIALOG_LOADING;

  constructor(api: WorkspaceApi, roomId: string, doc: string, options: ShareDialogOptions) {
    this.#api = api;
    this.#roomId = roomId;
    this.#doc = doc;
    this.#options = options;
  }

  /** The state on show. */
  get state(): ShareDialogState {
    return this.#state;
  }

  #set(next: Partial<ShareDialogState>): void {
    this.#state = { ...this.#state, ...next };
    this.#options.onChange(this.#state);
  }

  /** Where an agent finds its instructions for the link, or null when the server offers none or did not say. */
  async #connectOf(share: Share): Promise<string | null> {
    try {
      return (await this.#api.publicShare(share.token)).connect;
    } catch {
      return null;
    }
  }

  /** Ask for the link of the document and, behind a hosting front, its guests. */
  async load(): Promise<void> {
    this.#set({ ...SHARE_DIALOG_LOADING });
    const guests = this.#options.hosted ? this.#loadGuests() : Promise.resolve();
    try {
      const share = await this.#api.shareOf(this.#roomId, this.#doc);
      const connect = share === null ? null : await this.#connectOf(share);
      this.#set({ phase: share === null ? "unshared" : "shared", share, connect });
    } catch (e) {
      this.#set({ phase: "failed", error: message(e) });
    }
    await guests;
  }

  async #loadGuests(): Promise<void> {
    try {
      this.#set({ guests: await this.#api.shareGuests(this.#roomId, this.#doc), guestsError: null });
    } catch (e) {
      this.#set({ guests: null, guestsError: `The guests did not load: ${message(e)}` });
    }
  }

  /** Make the link (or get the live one) and show it. */
  async create(): Promise<void> {
    if (this.#state.busy !== null) return;
    this.#set({ busy: "create", error: null });
    try {
      const share = await this.#api.share(this.#roomId, this.#doc);
      const connect = await this.#connectOf(share);
      this.#set({ phase: "shared", share, connect, busy: null });
    } catch (e) {
      this.#set({ busy: null, error: `The link was not created: ${message(e)}` });
    }
  }

  /** The first choice of Stop sharing: ask before ending the link. */
  askStop(): void {
    if (this.#state.phase === "shared") this.#set({ confirmingStop: true, error: null });
  }

  /** Back out of Stop sharing: the link stays. */
  keepSharing(): void {
    this.#set({ confirmingStop: false });
  }

  /** End the link, once Stop sharing was confirmed; nothing happens without the confirmation. */
  async stop(): Promise<void> {
    if (!this.#state.confirmingStop || this.#state.busy !== null) return;
    this.#set({ busy: "stop", error: null });
    try {
      await this.#api.unshare(this.#roomId, this.#doc);
      this.#set({ phase: "unshared", share: null, connect: null, busy: null, confirmingStop: false });
    } catch (e) {
      this.#set({ busy: null, confirmingStop: false, error: `Sharing did not stop: ${message(e)}` });
    }
  }

  /** Take a guest off the document. */
  async removeGuest(id: string): Promise<void> {
    if (this.#state.removing !== null) return;
    this.#set({ removing: id, guestsError: null });
    try {
      await this.#api.removeShareGuest(this.#roomId, this.#doc, id);
      const current = this.#state.guests;
      this.#set({ removing: null, guests: current === null ? null : { ...current, guests: current.guests.filter((g) => g.id !== id) } });
    } catch (e) {
      this.#set({ removing: null, guestsError: `The guest was not removed: ${message(e)}` });
    }
  }
}
