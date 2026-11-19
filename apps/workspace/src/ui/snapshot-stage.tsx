/** @jsxImportSource preact */
// Center stage of a shared link: the server's display-list pages of the open document, painted on canvases with the
// vector renderer. It opens no `<wolf-review>`, probes no engine channel and loads no `.wasm`. The room still speaks
// over its WebSocket, so the head, its revision and the agents at work stay current on the page.
import { useEffect, useRef, useState } from "preact/hooks";
import type { WorkspaceApi } from "../lib/api.ts";
import type { Page } from "../lib/room-client.ts";
import { ACTIVITY_LABEL, type ActivityItem, type DocumentSummary, presenceFor } from "../lib/room-state.ts";
import { shortSha } from "../lib/session.ts";
import { paintSnapshot } from "../lib/snapshot.ts";
import { EmptyState, FormatPill } from "./common.tsx";

export type SharedSnapshotStageProps = {
  api: WorkspaceApi;
  roomId: string | null;
  doc: DocumentSummary | null;
  /** Pages to paint as they are, instead of the snapshot the server holds for the head of `doc`. */
  snapshotPages?: readonly Page[];
  /** Agent activity of the room, newest first: what the presence list shows. */
  activity: readonly ActivityItem[];
  /** Whether the banner shows who is at work: false on a page with no room socket, which cannot know. Default true. */
  presence?: boolean;
};

type Fetched = { doc: string; pages: readonly Page[] };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function SharedSnapshotStage({ api, roomId, doc, snapshotPages, activity, presence: showPresence = true }: SharedSnapshotStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docName = doc?.name ?? null;
  const revision = doc?.revision ?? null;
  const pages = snapshotPages ?? (fetched !== null && fetched.doc === docName ? fetched.pages : null);

  // The server's snapshot of the head: again whenever the head moves, so the page follows the room.
  useEffect(() => {
    setError(null);
    if (snapshotPages !== undefined || roomId === null || docName === null) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    api.snapshot(roomId, docName).then(
      (next) => {
        if (!cancelled) setFetched({ doc: docName, pages: next });
      },
      (e: unknown) => {
        if (!cancelled) setError(message(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, roomId, docName, revision, snapshotPages]);

  useEffect(() => {
    if (pages === null || host.current === null) return;
    try {
      paintSnapshot(pages, [...host.current.querySelectorAll("canvas")], globalThis.devicePixelRatio || 1);
    } catch (e) {
      setError(message(e));
    }
  }, [pages]);

  const presence = docName === null ? [] : presenceFor(activity, docName);

  return (
    <main class="stage stage--snapshot" aria-label="Document">
      {doc === null ? null : (
        <div class="banner banner--snapshot" role="region" aria-label="Shared snapshot">
          <div class="banner-text">
            <span class="banner-kicker">Shared snapshot · zero WASM</span>
            <span class="banner-title">
              <FormatPill format={doc.format} />
              <span class="banner-doc" title={doc.name}>
                {doc.name}
              </span>
              <span class="badge">r{doc.revision}</span>
            </span>
            <span class="banner-meta">
              <span>Read-only</span>
              {roomId !== null ? <span>room {roomId}</span> : null}
              {pages !== null ? (
                <span>
                  {pages.length} {pages.length === 1 ? "page" : "pages"}
                </span>
              ) : null}
              {doc.sha256 !== "" ? <code title={doc.sha256}>sha256 {shortSha(doc.sha256)}</code> : null}
            </span>
          </div>
          {!showPresence ? null : presence.length === 0 ? (
            <span class="hint">No agents at work</span>
          ) : (
            <ul class="presence" aria-label="Agents at work">
              {presence.map((item) => (
                <li key={item.agent.id} class={`presence-item activity-row--${item.activity}`}>
                  <span class="activity-dot" aria-hidden="true" />
                  <span>
                    <strong>{item.agent.name}</strong> {ACTIVITY_LABEL[item.activity].toLowerCase()}
                    {item.detail ? <span class="activity-detail"> {item.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error !== null ? (
        <div class="notice notice--danger stage-notice" role="alert">
          The snapshot did not load: {error}
        </div>
      ) : null}
      {doc === null ? (
        <div class="stage-empty">
          <EmptyState title="Open a document">
            <p>Pick a document on the left to see the server's snapshot of it.</p>
          </EmptyState>
        </div>
      ) : (
        <div class={`stage-canvas snapshot-pages${pages === null && error === null ? " is-loading" : ""}`} ref={host} aria-busy={pages === null && error === null}>
          {pages?.map((page) => (
            <canvas key={page.page} class="snapshot-page" role="img" aria-label={page.label ?? `Page ${page.page}`} data-page={page.page} />
          ))}
        </div>
      )}
      {doc !== null && pages === null && error === null ? <p class="stage-status">Loading the snapshot</p> : null}
    </main>
  );
}
