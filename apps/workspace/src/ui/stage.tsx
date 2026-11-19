/** @jsxImportSource preact */
// Center stage: one `<wolf-review>` for the life of the page. In head mode it edits the head of the active
// document and sends the local edits as a commit or a proposal; in review mode it shows an open proposal over the
// head it was made against, change by change, and its decision goes back to the room. Agent activity of the
// document lands on the element's presence bar as it happens. A shared link (`shareMode`) has no element and no
// engine: its stage paints the server's display-list snapshot instead, see `snapshot-stage.tsx`.
import type { RoomActivityEvent, WolfReviewElement, WolfReviewSubmitDetail } from "@wolfsdk/review";
import type { EngineSource } from "@wolfsdk/review";
import type { RoomActor, RoomProposal, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type WorkspaceApi } from "../lib/api.ts";
import { type Page, type RoomClient, RoomRequestError } from "../lib/room-client.ts";
import { type ActivityItem, type DocumentSummary, presenceFor, proposalSize } from "../lib/room-state.ts";
import { batchFromSession, isActivityFor, isOwnCommit, isOwnNewProposal, outcomeOf, reviewInputOf } from "../lib/review.ts";
import { isReviewable, shortSha, type Theme } from "../lib/session.ts";
import { ActorBadge, downloadBytes, EmptyState, FormatPill, Icon, type Toast } from "./common.tsx";
import { SharedSnapshotStage } from "./snapshot-stage.tsx";

export type StageProps = {
  api: WorkspaceApi;
  client: RoomClient | null;
  roomId: string | null;
  actor: RoomActor;
  doc: DocumentSummary | null;
  /** The open proposal under review, or null for head mode. */
  proposal: RoomProposal | null;
  proposalIds: readonly string[];
  activity: readonly ActivityItem[];
  engine: EngineSource | null;
  theme: Theme;
  deciding: boolean;
  subscribe(listener: (event: RoomServerEvent) => void): () => void;
  onSelection(address: string | null): void;
  onDirty(changes: number): void;
  onExitReview(): void;
  onDecide(proposal: RoomProposal, decision: "approve" | "reject"): void;
  onDownloadPreview(proposal: RoomProposal): void;
  notify(tone: Toast["tone"], text: string): void;
  /** A shared link: paint the server's display-list snapshot, with no `<wolf-review>` and no engine. */
  shareMode?: boolean;
  /** In `shareMode`, the pages to paint instead of the snapshot the server holds for the open document. */
  snapshotPages?: readonly Page[];
  /** A guest: local edits go out as a proposal only, and the stage offers no decision and no download. */
  guest?: boolean;
};

type Opened = { doc: string; revision: number; sha256: string; mode: "head" | "review" | "pdf" };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function Stage(props: StageProps) {
  if (props.shareMode) {
    return <SharedSnapshotStage api={props.api} roomId={props.roomId} doc={props.doc} snapshotPages={props.snapshotPages} activity={props.activity} />;
  }
  return <EditorStage {...props} />;
}

function EditorStage(props: StageProps) {
  const { api, client, roomId, actor, doc, proposal } = props;
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [element, setElement] = useState<WolfReviewElement | null>(null);
  /** `failed` once the element reports an error before its engine is ready (it shows the error and a Retry). */
  const [engineState, setEngineState] = useState<"loading" | "ready" | "failed">("loading");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [local, setLocal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<"commit" | "propose" | null>(null);
  const [reload, setReload] = useState(0);
  /** What the element shows, for its event listeners. */
  const modeRef = useRef<"head" | "review" | "idle">("idle");
  const localRef = useRef(0);
  const openedRef = useRef<Opened | null>(null);
  /** Set by "Reload latest head": open the head even over local edits. */
  const forceRef = useRef(false);
  /** The commit in flight: its own `doc.committed` reloads the head instead of raising a conflict. */
  const committingRef = useRef<{ doc: string; base: number } | null>(null);

  const setLocalChanges = (n: number): void => {
    localRef.current = n;
    setLocal(n);
    latest.current.onDirty(n);
  };

  // One element for the life of the stage, as a page embeds it.
  useEffect(() => {
    const el = document.createElement("wolf-review");
    el.setAttribute("unload-guard", "");
    // Before it connects, so it starts on the chosen engine and not on the release channel.
    if (props.engine) el.engine = props.engine;
    el.theme = props.theme;
    const onReady = (): void => setEngineState("ready");
    const onError = (): void => setEngineState((state) => (state === "loading" ? "failed" : state));
    const onChange = (event: CustomEvent<{ revision: number }>): void => {
      if (modeRef.current === "head") setLocalChanges(event.detail.revision);
    };
    const onSelection = (event: CustomEvent<{ addresses: string[] }>): void => latest.current.onSelection(event.detail.addresses[0] ?? null);
    const onSubmit = (event: CustomEvent<WolfReviewSubmitDetail>): void => {
      // The room keeps the decision; the element's decision-file download is not needed.
      event.preventDefault();
      const current = latest.current;
      if (current.proposal === null) return;
      if (current.guest) return current.notify("warning", "A guest proposes edits. A member of the workspace approves or rejects them.");
      if (current.actor.kind === "agent") return current.notify("warning", "Only a user can approve or reject a proposal.");
      const outcome = outcomeOf(event.detail.decision.summary);
      if (outcome === "approve" || outcome === "reject") return current.onDecide(current.proposal, outcome);
      current.notify(
        "warning",
        outcome === "mixed"
          ? "The room approves or rejects a proposal as a whole. Approve every change to approve it, or reject the proposal."
          : "Decide every change before you submit the review.",
      );
    };
    el.addEventListener("wolf-ready", onReady);
    el.addEventListener("wolf-error", onError);
    el.addEventListener("wolf-change", onChange);
    el.addEventListener("wolf-selection", onSelection);
    el.addEventListener("wolf-review-submit", onSubmit);
    host.current!.append(el);
    setElement(el);
    return () => {
      el.removeEventListener("wolf-ready", onReady);
      el.removeEventListener("wolf-error", onError);
      el.removeEventListener("wolf-change", onChange);
      el.removeEventListener("wolf-selection", onSelection);
      el.removeEventListener("wolf-review-submit", onSubmit);
      el.remove();
    };
  }, []);

  useEffect(() => {
    if (element) element.theme = props.theme;
  }, [element, props.theme]);

  const docName = doc?.name ?? null;
  const headRevision = doc?.revision ?? null;
  const format = doc?.format ?? null;
  const proposalId = proposal?.proposal_id ?? null;

  // Open the head, or the proposal over it, whenever the document, its head or the focus changes.
  useEffect(() => {
    if (element === null || roomId === null || docName === null || headRevision === null || format === null) {
      modeRef.current = "idle";
      openedRef.current = null;
      setOpened(null);
      setConflict(null);
      return;
    }
    const current = openedRef.current;
    const committing = committingRef.current;
    const ownCommit = committing !== null && committing.doc === docName && headRevision === committing.base + 1;
    if (proposalId === null && !forceRef.current && !ownCommit && current?.mode === "head" && current.doc === docName && localRef.current > 0) {
      // Someone else moved the head under local edits: keep them and say so.
      setConflict(current.revision === headRevision ? null : headRevision);
      return;
    }
    forceRef.current = false;
    setConflict(null);
    let cancelled = false;
    const run = async (): Promise<void> => {
      setLoading(true);
      setLoadError(null);
      try {
        if (!isReviewable(format)) {
          modeRef.current = "idle";
          if (openedRef.current !== null && openedRef.current.mode !== "pdf") await element.close().catch(() => undefined);
          const next: Opened = { doc: docName, revision: headRevision, sha256: doc?.sha256 ?? "", mode: "pdf" };
          openedRef.current = next;
          setOpened(next);
          setLocalChanges(0);
          return;
        }
        const head = await api.head(roomId, docName);
        if (cancelled) return;
        const target = latest.current.proposal;
        if (target !== null && target.proposal_id === proposalId) {
          modeRef.current = "review";
          element.mode = "review";
          const result = await element.openReview(reviewInputOf(target, head.bytes));
          if (result.refused) {
            latest.current.notify(
              "warning",
              `Change ${result.refused.index + 1} of ${target.proposal_id} did not apply here: ${result.refused.error.message}`,
            );
          }
        } else {
          modeRef.current = "head";
          element.mode = "edit";
          await element.open(head.bytes, docName);
        }
        if (cancelled) return;
        setLocalChanges(0);
        const next: Opened = { doc: docName, revision: head.revision ?? headRevision, sha256: head.sha256, mode: target !== null ? "review" : "head" };
        openedRef.current = next;
        setOpened(next);
        // Start the presence bar from what the agents of this document are doing now.
        element.agentActivities = [];
        for (const item of presenceFor(latest.current.activity, docName)) element.applyRoomActivityEvent(item as RoomActivityEvent);
      } catch (e) {
        if (cancelled) return;
        // The element shows its own refusals and engine failures (with a Retry); the stage reports the server's.
        if (e instanceof ApiError) setLoadError(e.message);
        // What the element still holds is the document it had before: close it rather than leave another
        // document's pages, revision and hash under this one's name. Closing drops the element's own error, so
        // the stage says why this document is not shown.
        if (openedRef.current !== null && openedRef.current.doc !== docName) {
          if (openedRef.current.mode !== "pdf") await element.close().catch(() => undefined);
          openedRef.current = null;
          setOpened(null);
          setLocalChanges(0);
          if (!(e instanceof ApiError)) setLoadError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [element, api, roomId, docName, headRevision, format, proposalId, reload]);

  // Live agent presence for the open document.
  useEffect(() => {
    if (element === null || docName === null) return;
    return props.subscribe((event) => {
      if (isActivityFor(event, docName)) element.applyRoomActivityEvent(event as RoomActivityEvent);
    });
  }, [element, docName, props.subscribe]);

  const send = async (mode: "commit" | "propose"): Promise<void> => {
    if (client === null || element === null || opened === null || docName === null) return;
    setBusy(mode);
    const base = opened.revision;
    try {
      const batch = batchFromSession(await element.session(), label);
      if (batch === null) return props.notify("info", "There are no local changes to send.");
      if (mode === "commit") {
        committingRef.current = { doc: docName, base };
        await client.request(
          { type: "doc.edit", doc_name: docName, base_revision: base, mode: "commit", batch },
          (event) => isOwnCommit(event, actor.id, docName, base),
        );
        setLocalChanges(0);
        setLabel("");
        props.notify("success", `Committed revision ${base + 1} of ${docName}.`);
      } else {
        const known = new Set(props.proposalIds);
        const event = await client.request(
          { type: "doc.edit", doc_name: docName, base_revision: base, mode: "propose", batch },
          (candidate) => isOwnNewProposal(candidate, actor.id, docName, known),
        );
        setLabel("");
        // The edits live in the proposal now: show the head again.
        setLocalChanges(0);
        forceRef.current = true;
        setReload((n) => n + 1);
        const id = event.type === "proposal.updated" ? event.proposal.proposal_id : "";
        props.notify("success", `Proposal ${id} is open for review.`);
      }
    } catch (e) {
      if (e instanceof RoomRequestError && e.code === "REVISION_MISMATCH" && e.detail) {
        setConflict(e.detail.head.revision);
        props.notify("warning", `The head moved to revision ${e.detail.head.revision}. Reload it to edit the latest version.`);
      } else {
        props.notify("danger", e instanceof Error ? e.message : String(e));
      }
    } finally {
      committingRef.current = null;
      setBusy(null);
    }
  };

  const reloadHead = (): void => {
    forceRef.current = true;
    setReload((n) => n + 1);
  };

  const downloadCopy = async (): Promise<void> => {
    if (element === null || docName === null) return;
    downloadBytes(docName, await element.save());
  };

  const downloadHead = async (): Promise<void> => {
    if (roomId === null || docName === null) return;
    try {
      downloadBytes(docName, (await api.head(roomId, docName)).bytes);
    } catch (e) {
      props.notify("danger", e instanceof Error ? e.message : String(e));
    }
  };

  const isAgent = actor.kind === "agent";
  const guest = props.guest === true;
  const reviewing = proposal !== null && opened?.mode === "review";
  const size = proposal ? proposalSize(proposal) : null;
  const showElement = doc !== null && format !== null && isReviewable(format);

  return (
    <main class="stage" aria-label="Document">
      {doc === null ? null : proposal !== null ? (
        <div class="banner banner--review" role="region" aria-label="Proposal review">
          <div class="banner-text">
            <span class="banner-kicker">Reviewing Proposal</span>
            <span class="banner-title">
              <code>{proposal.proposal_id}</code> by <ActorBadge actor={proposal.author} you={proposal.author.id === actor.id} />
            </span>
            {size ? (
              <span class="banner-meta">
                {plural(size.batches, "batch", "batches")}, {plural(size.ops, "op", "ops")} on r{proposal.base_revision} of {proposal.doc_name}
              </span>
            ) : null}
          </div>
          <div class="banner-actions">
            {proposal.preview_sha256 && !guest ? (
              <button type="button" class="button button--small button--quiet" onClick={() => props.onDownloadPreview(proposal)}>
                <Icon name="download" size={14} />
                Preview
              </button>
            ) : null}
            <button type="button" class="button button--small button--quiet" onClick={props.onExitReview}>
              Back to head
            </button>
            {guest ? null : (
              <>
                <button
                  type="button"
                  class="button button--small button--danger"
                  disabled={isAgent || props.deciding || !reviewing}
                  title={isAgent ? "Only a user can reject a proposal" : undefined}
                  onClick={() => props.onDecide(proposal, "reject")}
                >
                  <Icon name="x" size={14} />
                  Reject Proposal
                </button>
                <button
                  type="button"
                  class="button button--small button--success"
                  disabled={isAgent || props.deciding || !reviewing}
                  title={isAgent ? "Only a user can approve a proposal" : undefined}
                  onClick={() => props.onDecide(proposal, "approve")}
                >
                  <Icon name="check" size={14} />
                  {props.deciding ? "Deciding" : "Approve Proposal"}
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div class="banner" role="region" aria-label="Head">
          <div class="banner-text">
            <span class="banner-title">
              <FormatPill format={doc.format} />
              <span class="banner-doc" title={doc.name}>
                {doc.name}
              </span>
              <span class="badge">r{opened?.revision ?? doc.revision}</span>
            </span>
            <span class="banner-meta">
              {opened?.sha256 ? <code title={opened.sha256}>sha256 {shortSha(opened.sha256)}</code> : null}
              {local > 0 ? <span class="dirty">{plural(local, "local change", "local changes")}</span> : <span>No local changes</span>}
            </span>
          </div>
          {opened?.mode === "head" ? (
            <form
              class="banner-actions"
              onSubmit={(e) => {
                e.preventDefault();
                void send("propose");
              }}
            >
              <input
                class="input input--compact"
                placeholder="Summary of your change"
                aria-label="Summary of your change"
                value={label}
                onInput={(e) => setLabel(e.currentTarget.value)}
              />
              <button type="submit" class={`button button--small${guest ? " button--primary" : ""}`} disabled={local === 0 || busy !== null || conflict !== null}>
                {busy === "propose" ? "Proposing" : "Propose Edit"}
              </button>
              {guest ? null : (
                <button
                  type="button"
                  class="button button--small button--primary"
                  disabled={local === 0 || busy !== null || conflict !== null}
                  onClick={() => void send("commit")}
                >
                  {busy === "commit" ? "Committing" : "Commit Edit"}
                </button>
              )}
            </form>
          ) : null}
        </div>
      )}
      {conflict !== null && opened !== null ? (
        <div class="notice notice--warning stage-notice" role="alert">
          <span>
            Revision {conflict} of {opened.doc} landed while you edited revision {opened.revision}. Your{" "}
            {plural(local, "local change stays", "local changes stay")} here until you reload.
          </span>
          <span class="notice-actions">
            <button type="button" class="button button--small button--quiet" onClick={() => void downloadCopy()}>
              Download my copy
            </button>
            <button type="button" class="button button--small" onClick={reloadHead}>
              Reload latest head
            </button>
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div class="notice notice--danger stage-notice" role="alert">
          <span>The document did not open: {loadError}</span>
          <button type="button" class="button button--small" onClick={reloadHead}>
            Try again
          </button>
        </div>
      ) : null}
      <div class={`stage-canvas${showElement ? "" : " is-hidden"}${loading ? " is-loading" : ""}`} ref={host} aria-busy={loading} />
      {!showElement ? (
        <div class="stage-empty">
          {doc === null ? (
            <EmptyState title="Open a document">
              <p>Pick a document on the left, or drop a DOCX, XLSX, PPTX or PDF file there to add it to the room.</p>
            </EmptyState>
          ) : (
            <EmptyState title={`${doc.name} is a PDF`}>
              <p>The room keeps PDF documents read-only. Agents read and inspect them through MCP.</p>
              {guest ? null : (
                <button type="button" class="button button--small" onClick={() => void downloadHead()}>
                  <Icon name="download" size={14} />
                  Download head
                </button>
              )}
            </EmptyState>
          )}
        </div>
      ) : null}
      {showElement && engineState === "loading" && !loadError ? <p class="stage-status">Loading the Wolf engine</p> : null}
    </main>
  );
}
