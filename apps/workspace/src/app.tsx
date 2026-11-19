/** @jsxImportSource preact */
// Wolf Workspace: sign in with an actor token (or, behind a hosting front, with the front's session and no token),
// pick a room, and work its documents with the agents in it.
import type { EngineSource } from "@wolfsdk/review";
import type { RoomActor, RoomProposal } from "@wolfsdk/protocol/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, type GuestScope, type PackStatus, type RoomRow, type WorkspaceApi } from "./lib/api.ts";
import { assistantShown } from "./lib/assistant-client.ts";
import { documentSummaries, historyOf, participantsOf, proposalsOf, threadsOf } from "./lib/room-state.ts";
import { isDecided } from "./lib/review.ts";
import { canShare } from "./lib/share.ts";
import {
  apiFor,
  type Credential,
  describeEngine,
  engineFor,
  formatOfFile,
  type HostedSession,
  initialTheme,
  type PageIo,
  probeHostedSession,
  shareModeOf,
  signOutHosted,
  socketUrlFor,
  startCredential,
  takeToken,
  type Theme,
  THEME_KEY,
  TOKEN_KEY,
} from "./lib/session.ts";
import { AssistantPanel, useAssistant } from "./ui/assistant-panel.tsx";
import { ConnectionDot, downloadBytes, Icon, modKey, SessionControls, type Toast, Toasts } from "./ui/common.tsx";
import { LeftRail } from "./ui/left-rail.tsx";
import { type CommentPost, RightRail, type RightTab } from "./ui/right-rail.tsx";
import { HostedGate, SignIn } from "./ui/sign-in.tsx";
import { ShareDialog } from "./ui/share-dialog.tsx";
import { Stage } from "./ui/stage.tsx";
import { Switcher, type SwitcherItem } from "./ui/switcher.tsx";
import { useRoom } from "./use-room.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The browser the page talks through: its own origin's `fetch`, and `location.assign` to leave. */
const PAGE: PageIo = { fetch: (input, init) => fetch(input, init), navigate: (path) => location.assign(path) };

/** The token of the page, taken once: it leaves the address bar before anything renders. */
function initialToken(): string | null {
  const taken = takeToken(location.search, sessionStorage);
  if (taken.search !== location.search) history.replaceState(null, "", `${location.pathname}${taken.search}${location.hash}`);
  return taken.token;
}

/** A signed-in page: the credential it signed in with (a token, or a hosting front's session that holds no token),
 * the actor the server says it stands for, its scope when it is a guest, and the API client for it. */
type Signed = { credential: Credential; actor: RoomActor; guest: GuestScope | null; api: WorkspaceApi };

export function App() {
  const [boot] = useState(initialToken);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [hostedError, setHostedError] = useState<{ session: HostedSession; error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [booting, setBooting] = useState(true);
  const [switchingToken, setSwitchingToken] = useState(false);

  // A token counts once the server says whom it stands for; a refused one leaves the current session as it was.
  const signIn = useCallback(async (next: string): Promise<void> => {
    setChecking(true);
    const credential: Credential = { kind: "token", token: next };
    const api = apiFor(credential, location.origin, PAGE);
    try {
      const { actor, guest } = await api.me();
      sessionStorage.setItem(TOKEN_KEY, next);
      setSigned({ credential, actor, guest, api });
      setAuthError(null);
      setSwitchingToken(false);
    } catch (e) {
      setAuthError(e instanceof ApiError && e.status === 401 ? "This server does not know that token." : message(e));
      setSigned((current) => {
        if (current === null) sessionStorage.removeItem(TOKEN_KEY);
        return current;
      });
    } finally {
      setChecking(false);
    }
  }, []);

  // Behind a hosting front the session cookie stands for the person: nothing goes to tab storage and the token form
  // never shows. A 401 has the api open the front's sign-in page; any other failure offers to try again.
  const enterHosted = useCallback(async (session: HostedSession): Promise<void> => {
    setChecking(true);
    const credential: Credential = { kind: "hosted", session };
    const api = apiFor(credential, location.origin, PAGE);
    try {
      const { actor, guest } = await api.me();
      setSigned({ credential, actor, guest, api });
      setHostedError(null);
    } catch (e) {
      const error =
        e instanceof ApiError && e.status === 401
          ? "Your session has ended. Opening the sign-in page."
          : `The server did not say who is signed in (GET /api/me: ${message(e)}).`;
      setHostedError({ session, error });
    } finally {
      setChecking(false);
    }
  }, []);

  // Start: a token of the address or the tab signs in as it always has; without one the page asks the hosting front
  // once, before showing anything, and shows the token form when nothing answers for a session.
  useEffect(() => {
    void startCredential(boot, () => probeHostedSession(PAGE.fetch))
      .then((credential) => (credential === null ? undefined : credential.kind === "token" ? signIn(credential.token) : enterHosted(credential.session)))
      .finally(() => setBooting(false));
  }, [boot, signIn, enterHosted]);

  if (booting) {
    return (
      <div class="gate">
        <p class="gate-status" role="status">
          Signing in
        </p>
      </div>
    );
  }
  if (signed === null && hostedError !== null) {
    const { session, error } = hostedError;
    return <HostedGate error={error} busy={checking} onRetry={() => void enterHosted(session)} />;
  }
  if (signed === null) {
    return <SignIn error={authError} busy={checking} onSubmit={(next) => void signIn(next)} />;
  }
  const { credential } = signed;
  const hosted = credential.kind === "hosted" ? credential.session : null;
  return (
    <Workspace
      key={`${signed.actor.kind}:${signed.actor.id}:${credential.kind === "token" ? credential.token : "hosted"}`}
      api={signed.api}
      socketUrl={socketUrlFor(credential, location.origin)}
      actor={signed.actor}
      guest={signed.guest}
      account={hosted?.account ?? null}
      accountPage={hosted?.accountPage}
      plansPage={hosted?.plansPage}
      switchingToken={switchingToken}
      onSwitchToken={
        hosted
          ? null
          : (open) => {
              setAuthError(null);
              setSwitchingToken(open);
            }
      }
      onSignIn={(next) => void signIn(next)}
      signInError={authError}
      checking={checking}
      onSignOut={
        hosted
          ? () => signOutHosted(hosted, PAGE)
          : () => {
              sessionStorage.removeItem(TOKEN_KEY);
              setSigned(null);
            }
      }
    />
  );
}

type WorkspaceProps = {
  api: WorkspaceApi;
  /** The room socket: with `?token=` for a token, with no `token` parameter behind a hosting front. */
  socketUrl: string;
  actor: RoomActor;
  /** The documents the actor is limited to when it is a guest; null for a member. A guest proposes and comments, and
   * sees none of what it is refused: room creation, uploads, the pack, decisions, export, the assistant and sharing. */
  guest: GuestScope | null;
  /** The account a hosting front signed in; null on a self-hosted server. */
  account: HostedSession["account"] | null;
  /** The hosting front's pages for agent tokens and for the plan, when it names them (see `HostedSession`). */
  accountPage?: string;
  plansPage?: string;
  switchingToken: boolean;
  /** Null behind a hosting front: the front holds the session, so there is no token to switch. */
  onSwitchToken: ((open: boolean) => void) | null;
  onSignIn(token: string): void;
  signInError: string | null;
  checking: boolean;
  /** Leaves the session; a sign-out that did not finish rejects with what to do, and the page stays. */
  onSignOut(): Promise<void> | void;
};

function Workspace({ api, socketUrl, actor, guest, account, accountPage, plansPage, switchingToken, onSwitchToken, onSignIn, signInError, checking, onSignOut }: WorkspaceProps) {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  /** `?share=1`: a shared link shows the server's display-list snapshot and loads no engine. */
  const shareMode = useMemo(() => shareModeOf(location.search), []);
  const [theme, setTheme] = useState<Theme>(() => initialTheme(localStorage, matchMedia("(prefers-color-scheme: dark)").matches));
  const [engine, setEngine] = useState<EngineSource | null | undefined>(undefined);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [roomId, setRoomId] = useState<string | null>(params.get("room"));
  const [docName, setDocName] = useState<string | null>(params.get("doc"));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [tab, setTab] = useState<RightTab>("proposals");
  const [allDocs, setAllDocs] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [switcher, setSwitcher] = useState(false);
  const [pack, setPack] = useState<PackStatus | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [signingOut, setSigningOut] = useState(false);
  const [sharing, setSharing] = useState(false);
  const dirty = useRef(0);
  const toastId = useRef(0);

  const room = useRoom(socketUrl, roomId);
  const view = room.view;
  const assistant = useAssistant(room);

  const notify = useCallback((tone: Toast["tone"], text: string): void => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === "danger" ? 9000 : 5000);
  }, []);

  // Behind a hosting front a refused socket upgrade looks like any lost connection (a browser WebSocket shows no HTTP
  // status), so ask the server who the caller is once per outage: an ended session answers 401, and the api opens the
  // front's sign-in page.
  const hosted = account !== null;
  useEffect(() => {
    if (hosted && room.status === "reconnecting") void api.me().catch(() => undefined);
  }, [hosted, room.status, api]);

  // A sign-out that did not finish keeps the page and says why; one that did has already left it.
  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (e) {
      notify("danger", message(e));
      setSigningOut(false);
    }
  };

  // Theme on the page and on the element.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Engine: `?engine=`, else this server's `/wasm` channel when it has one, else the release channel. A shared
  // snapshot opens no engine, so it never asks `/wasm` for one.
  useEffect(() => {
    let cancelled = false;
    void engineFor(params, shareMode, location.origin).then((source) => !cancelled && setEngine(source));
    return () => {
      cancelled = true;
    };
  }, [params, shareMode]);

  const loadRooms = useCallback(async (): Promise<RoomRow[]> => {
    try {
      const list = await api.rooms();
      setRooms(list);
      return list;
    } catch (e) {
      notify("danger", `The rooms did not load: ${message(e)}`);
      return [];
    }
  }, [api, notify]);

  useEffect(() => {
    void loadRooms().then((list) => {
      setRoomId((current) => (current !== null && list.some((r) => r.room_id === current) ? current : (list[0]?.room_id ?? null)));
    });
    // A guest is refused the pack: it does not ask.
    if (guest === null) void api.pack().then(setPack, () => setPack(null));
  }, [api, loadRooms, guest]);

  const documents = useMemo(() => documentSummaries(view.room), [view.room]);
  const activeDoc = documents.find((d) => d.name === docName) ?? null;

  // Keep a document open: the one asked for, else the first.
  useEffect(() => {
    if (view.room === null) return;
    if (docName === null || !documents.some((d) => d.name === docName)) setDocName(documents[0]?.name ?? null);
  }, [view.room, documents, docName]);

  // The address bar names the room and document, never the token.
  useEffect(() => {
    const next = new URLSearchParams(location.search);
    if (roomId) next.set("room", roomId);
    else next.delete("room");
    if (docName) next.set("doc", docName);
    else next.delete("doc");
    const search = next.toString();
    history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}`);
  }, [roomId, docName]);

  const focused = view.room?.proposals.find((p) => p.proposal_id === focusId) ?? null;
  const reviewing = focused !== null && focused.status === "open" && focused.doc_name === docName ? focused : null;

  // Leave review mode when the proposal under review closes (decided here, by someone else, or superseded).
  useEffect(() => {
    if (focusId === null || view.room === null) return;
    const proposal = view.room.proposals.find((p) => p.proposal_id === focusId);
    if (proposal === undefined || proposal.status !== "open") {
      setFocusId(null);
      if (proposal && deciding === null) notify("info", `Proposal ${proposal.proposal_id} is ${proposal.status} now.`);
    }
  }, [view.room, focusId, deciding, notify]);

  const confirmDiscard = (): boolean =>
    dirty.current === 0 || confirm(`Discard ${dirty.current === 1 ? "1 local change" : `${dirty.current} local changes`} to ${docName}?`);

  const selectDoc = (name: string): void => {
    if (name === docName && focusId === null) return;
    if (!confirmDiscard()) return;
    setFocusId(null);
    setSelection(null);
    setDocName(name);
  };

  const selectRoom = (id: string): void => {
    if (id === roomId || !confirmDiscard()) return;
    setFocusId(null);
    setSelection(null);
    setDocName(null);
    setRoomId(id);
  };

  const createRoom = async (id: string): Promise<boolean> => {
    try {
      await api.createRoom(id);
      await loadRooms();
      selectRoom(id);
      notify("success", `Room ${id} is ready. Drop documents into it.`);
      return true;
    } catch (e) {
      notify("danger", message(e));
      return false;
    }
  };

  const upload = async (files: File[]): Promise<void> => {
    if (roomId === null) return;
    let last: string | null = null;
    for (const file of files) {
      if (formatOfFile(file.name) === null) {
        notify("warning", `${file.name} is not a DOCX, XLSX, PPTX or PDF file.`);
        continue;
      }
      setUploading(file.name);
      try {
        const head = await api.upload(roomId, file);
        last = head.name;
      } catch (e) {
        notify("danger", `${file.name}: ${message(e)}`);
      }
    }
    setUploading(null);
    if (last !== null) {
      notify("success", files.length === 1 ? `Added ${last}.` : `Added ${files.length} documents.`);
      if (dirty.current === 0) {
        setFocusId(null);
        setDocName(last);
      }
    }
  };

  const downloadHead = async (name: string): Promise<void> => {
    if (roomId === null) return;
    try {
      downloadBytes(name, (await api.head(roomId, name)).bytes);
    } catch (e) {
      notify("danger", message(e));
    }
  };

  const downloadPreview = async (proposal: RoomProposal): Promise<void> => {
    if (roomId === null) return;
    try {
      const preview = await api.preview(roomId, proposal.proposal_id);
      const dot = proposal.doc_name.lastIndexOf(".");
      const name = dot < 0 ? `${proposal.doc_name}.${proposal.proposal_id}` : `${proposal.doc_name.slice(0, dot)}.${proposal.proposal_id}${proposal.doc_name.slice(dot)}`;
      downloadBytes(name, preview.bytes);
    } catch (e) {
      notify("danger", message(e));
    }
  };

  const refreshPack = async (): Promise<void> => {
    setPackBusy(true);
    try {
      const result = await api.refreshPack();
      setPack(result);
      notify("success", result.refreshed.length === 0 ? "Every binding was fresh." : `Refreshed ${result.refreshed.join(", ")}.`);
    } catch (e) {
      notify("danger", `The pack did not refresh: ${message(e)}`);
    } finally {
      setPackBusy(false);
    }
  };

  const decide = async (proposal: RoomProposal, decision: "approve" | "reject"): Promise<void> => {
    if (room.client === null) return;
    setDeciding(proposal.proposal_id);
    try {
      await room.client.request({ type: "proposal.decide", proposal_id: proposal.proposal_id, decision }, (event) =>
        isDecided(event, proposal.proposal_id, decision),
      );
      notify(decision === "approve" ? "success" : "info", `${decision === "approve" ? "Approved" : "Rejected"} ${proposal.proposal_id}.`);
      setFocusId((current) => (current === proposal.proposal_id ? null : current));
    } catch (e) {
      notify("danger", message(e));
    } finally {
      setDeciding(null);
    }
  };

  const inspect = (proposal: RoomProposal): void => {
    if (proposal.doc_name !== docName && !confirmDiscard()) return;
    setDocName(proposal.doc_name);
    setFocusId(proposal.proposal_id);
  };

  const comment = async (post: CommentPost): Promise<boolean> => {
    const doc = docName;
    if (room.client === null || doc === null) return false;
    try {
      await room.client.request({ type: "comment.post", doc_name: doc, ...post }, (event) => {
        if (event.type !== "comment.updated") return false;
        const last = event.thread.messages.at(-1);
        const mine = last !== undefined && last.author.id === actor.id && last.body === post.body;
        return post.thread_id === null ? mine && event.thread.target_address === post.target_address : mine && event.thread.thread_id === post.thread_id;
      });
      return true;
    } catch (e) {
      notify("danger", message(e));
      return false;
    }
  };

  // Cmd+K or Ctrl+K: the quick switcher (unless the document editor took the keystroke).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setSwitcher((open) => !open);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const switcherItems = useMemo<SwitcherItem[]>(
    () => [
      ...documents.map((d) => ({
        kind: "doc" as const,
        id: d.name,
        format: d.format,
        meta: `r${d.revision}${d.openProposals > 0 ? `, ${d.openProposals} open` : ""}`,
      })),
      ...rooms.map((r) => ({ kind: "room" as const, id: r.room_id, meta: r.room_id === roomId ? "Current room" : r.workspace_id })),
    ],
    [documents, rooms, roomId],
  );

  const scope = allDocs ? null : docName;
  const proposals = useMemo(() => proposalsOf(view.room, scope), [view.room, scope]);
  const threads = useMemo(() => threadsOf(view.room, scope), [view.room, scope]);
  const history_ = useMemo(() => historyOf(view.room, scope), [view.room, scope]);
  const participants = useMemo(() => participantsOf(view), [view]);
  const proposalIds = useMemo(() => view.room?.proposals.map((p) => p.proposal_id) ?? [], [view.room]);
  const showAssistant = guest === null && assistantShown(assistant.view);
  const shareable = roomId !== null && activeDoc !== null && canShare(actor, guest);

  return (
    <div class={`app${leftOpen ? "" : " no-left"}${rightOpen ? "" : " no-right"}${showAssistant ? " has-assistant" : ""}`}>
      <header class="topbar">
        <button
          type="button"
          class="icon-button"
          aria-label={leftOpen ? "Hide rooms and documents" : "Show rooms and documents"}
          aria-pressed={leftOpen}
          title={leftOpen ? "Hide rooms and documents" : "Show rooms and documents"}
          onClick={() => setLeftOpen(!leftOpen)}
        >
          <Icon name="panelLeft" />
        </button>
        <span class="brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-name">Wolf Workspace</span>
        </span>
        <span class="crumbs" aria-label="Location">
          {roomId ? <span class="crumb">{roomId}</span> : <span class="crumb crumb--muted">No room</span>}
          {docName ? (
            <>
              <span class="crumb-sep" aria-hidden="true">/</span>
              <span class="crumb crumb--doc">{docName}</span>
            </>
          ) : null}
        </span>
        <button type="button" class="search-button" onClick={() => setSwitcher(true)} title="Switch document or room">
          <Icon name="search" size={14} />
          <span>Jump to</span>
          <kbd>{modKey()} K</kbd>
        </button>
        <span class="topbar-spacer" />
        {shareable ? (
          <button type="button" class="button button--small" aria-haspopup="dialog" title={`Share ${activeDoc.name} by link`} onClick={() => setSharing(true)}>
            <Icon name="link" size={14} />
            Share
          </button>
        ) : null}
        {roomId ? <ConnectionDot status={room.status} /> : null}
        <button
          type="button"
          class="icon-button"
          aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
          title={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
        <SessionControls
          actor={actor}
          account={account}
          guest={guest !== null}
          title={shareMode ? "Shared snapshot: no engine is loaded" : engine === undefined ? undefined : `Engine: ${describeEngine(engine)}`}
          onSwitchToken={onSwitchToken ? () => onSwitchToken(true) : undefined}
          accountPage={accountPage}
          plansPage={plansPage}
          onSignOut={() => void signOut()}
          signingOut={signingOut}
        />
        <button
          type="button"
          class="icon-button"
          aria-label={rightOpen ? "Hide the review panel" : "Show the review panel"}
          aria-pressed={rightOpen}
          title={rightOpen ? "Hide the review panel" : "Show the review panel"}
          onClick={() => setRightOpen(!rightOpen)}
        >
          <Icon name="panelRight" />
        </button>
      </header>
      {room.lastError ? (
        <div class="notice notice--danger app-notice" role="alert">
          {room.lastError.code === "UNKNOWN_ROOM" ? `Room ${roomId} does not exist on this server.` : `${room.lastError.code}: ${room.lastError.message}`}
        </div>
      ) : null}
      {leftOpen ? (
        <LeftRail
          rooms={rooms}
          roomId={roomId}
          documents={documents}
          activeDoc={docName}
          pack={pack}
          packBusy={packBusy}
          uploading={uploading}
          guest={guest !== null}
          onSelectRoom={selectRoom}
          onCreateRoom={createRoom}
          onSelectDoc={selectDoc}
          onUpload={(files) => void upload(files)}
          onDownloadHead={(name) => void downloadHead(name)}
          onRefreshPack={() => void refreshPack()}
        />
      ) : null}
      {engine === undefined && !shareMode ? (
        <main class="stage">
          <p class="stage-status">Finding the Wolf engine</p>
        </main>
      ) : (
        <Stage
          api={api}
          client={room.client}
          roomId={roomId}
          actor={actor}
          doc={activeDoc}
          proposal={reviewing}
          proposalIds={proposalIds}
          activity={view.activity}
          guest={guest !== null}
          engine={engine ?? null}
          shareMode={shareMode}
          theme={theme}
          deciding={deciding !== null}
          subscribe={room.subscribe}
          onSelection={setSelection}
          onDirty={(n) => {
            dirty.current = n;
          }}
          onExitReview={() => setFocusId(null)}
          onDecide={(p, d) => void decide(p, d)}
          onDownloadPreview={(p) => void downloadPreview(p)}
          notify={notify}
        />
      )}
      {guest === null ? (
        <AssistantPanel
          view={assistant.view}
          docName={activeDoc?.name ?? null}
          selection={selection}
          proposals={view.room?.proposals ?? []}
          shareMode={shareMode}
          onAsk={assistant.ask}
          onCancel={assistant.cancel}
          onInspect={inspect}
        />
      ) : null}
      {rightOpen ? (
        <RightRail
          tab={tab}
          onTab={setTab}
          actor={actor}
          activeDoc={docName}
          allDocs={allDocs}
          onAllDocs={setAllDocs}
          proposals={proposals}
          focusedProposal={reviewing?.proposal_id ?? null}
          deciding={deciding}
          onInspect={inspect}
          onDecide={(p, d) => void decide(p, d)}
          onDownloadPreview={(p) => void downloadPreview(p)}
          threads={threads}
          selection={selection}
          participants={participants}
          onComment={comment}
          history={history_}
          activity={view.activity}
          shareMode={shareMode}
          guest={guest !== null}
        />
      ) : null}
      {switcher ? (
        <Switcher
          items={switcherItems}
          onClose={() => setSwitcher(false)}
          onPick={(item) => {
            setSwitcher(false);
            if (item.kind === "doc") selectDoc(item.id);
            else selectRoom(item.id);
          }}
        />
      ) : null}
      {sharing && shareable ? (
        <ShareDialog api={api} roomId={roomId} docName={activeDoc.name} hosted={account !== null} onClose={() => setSharing(false)} />
      ) : null}
      {switchingToken && onSwitchToken ? <SignIn error={signInError} busy={checking} onSubmit={onSignIn} onCancel={() => onSwitchToken(false)} /> : null}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))} />
    </div>
  );
}
