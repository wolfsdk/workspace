/** @jsxImportSource preact */
// Wolf Workspace: sign in with an actor token, pick a room, and work its documents with the agents in it.
import type { EngineSource } from "@wolfsdk/review";
import type { RoomActor, RoomProposal } from "@wolfsdk/protocol/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError, type PackStatus, type RoomRow, WorkspaceApi } from "./lib/api.ts";
import { documentSummaries, historyOf, participantsOf, proposalsOf, threadsOf } from "./lib/room-state.ts";
import { isDecided } from "./lib/review.ts";
import { describeEngine, engineFor, formatOfFile, initialTheme, shareModeOf, takeToken, type Theme, THEME_KEY, TOKEN_KEY } from "./lib/session.ts";
import { ActorBadge, ConnectionDot, downloadBytes, Icon, modKey, type Toast, Toasts } from "./ui/common.tsx";
import { LeftRail } from "./ui/left-rail.tsx";
import { type CommentPost, RightRail, type RightTab } from "./ui/right-rail.tsx";
import { SignIn } from "./ui/sign-in.tsx";
import { Stage } from "./ui/stage.tsx";
import { Switcher, type SwitcherItem } from "./ui/switcher.tsx";
import { useRoom } from "./use-room.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The token of the page, taken once: it leaves the address bar before anything renders. */
function initialToken(): string | null {
  const taken = takeToken(location.search, sessionStorage);
  if (taken.search !== location.search) history.replaceState(null, "", `${location.pathname}${taken.search}${location.hash}`);
  return taken.token;
}

type Signed = { token: string; actor: RoomActor; api: WorkspaceApi };

export function App() {
  const [boot] = useState(initialToken);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [booting, setBooting] = useState(boot !== null);
  const [switchingToken, setSwitchingToken] = useState(false);

  // A token counts once the server says whom it stands for; a refused one leaves the current session as it was.
  const signIn = useCallback(async (next: string): Promise<void> => {
    setChecking(true);
    const api = new WorkspaceApi(location.origin, next);
    try {
      const { actor } = await api.me();
      sessionStorage.setItem(TOKEN_KEY, next);
      setSigned({ token: next, actor, api });
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

  useEffect(() => {
    if (boot !== null) void signIn(boot).finally(() => setBooting(false));
  }, [boot, signIn]);

  if (booting) {
    return (
      <div class="gate">
        <p class="gate-status" role="status">
          Signing in
        </p>
      </div>
    );
  }
  if (signed === null) {
    return <SignIn error={authError} busy={checking} onSubmit={(next) => void signIn(next)} />;
  }
  return (
    <Workspace
      key={`${signed.actor.kind}:${signed.actor.id}:${signed.token}`}
      api={signed.api}
      token={signed.token}
      actor={signed.actor}
      switchingToken={switchingToken}
      onSwitchToken={(open) => {
        setAuthError(null);
        setSwitchingToken(open);
      }}
      onSignIn={(next) => void signIn(next)}
      signInError={authError}
      checking={checking}
      onSignOut={() => {
        sessionStorage.removeItem(TOKEN_KEY);
        setSigned(null);
      }}
    />
  );
}

type WorkspaceProps = {
  api: WorkspaceApi;
  token: string;
  actor: RoomActor;
  switchingToken: boolean;
  onSwitchToken(open: boolean): void;
  onSignIn(token: string): void;
  signInError: string | null;
  checking: boolean;
  onSignOut(): void;
};

function Workspace({ api, token, actor, switchingToken, onSwitchToken, onSignIn, signInError, checking, onSignOut }: WorkspaceProps) {
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
  const dirty = useRef(0);
  const toastId = useRef(0);

  const room = useRoom(token, roomId);
  const view = room.view;

  const notify = useCallback((tone: Toast["tone"], text: string): void => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), tone === "danger" ? 9000 : 5000);
  }, []);

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
    void api.pack().then(setPack, () => setPack(null));
  }, [api, loadRooms]);

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

  return (
    <div class={`app${leftOpen ? "" : " no-left"}${rightOpen ? "" : " no-right"}`}>
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
        <span class="me" title={shareMode ? "Shared snapshot: no engine is loaded" : engine === undefined ? undefined : `Engine: ${describeEngine(engine)}`}>
          <ActorBadge actor={actor} />
          <span class={`role role--${actor.kind}`}>{actor.kind === "agent" ? "Agent" : "User"}</span>
        </span>
        <button type="button" class="button button--small button--quiet" onClick={() => onSwitchToken(true)}>
          Switch token
        </button>
        <button type="button" class="button button--small button--quiet" onClick={onSignOut}>
          Sign out
        </button>
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
      {switchingToken ? <SignIn error={signInError} busy={checking} onSubmit={onSignIn} onCancel={() => onSwitchToken(false)} /> : null}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((t) => t.id !== id))} />
    </div>
  );
}
