/** @jsxImportSource preact */
// The page of a share link, `/s/<token>`: anyone who holds the link sees the painted pages of the document, who shared
// it, and a prompt that connects their own agent to it. It signs nobody in, asks no hosting front for a session and
// opens no room socket: it reads `GET /api/share/<token>` and its snapshot, and nothing else.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { WorkspaceApi } from "../lib/api.ts";
import type { DocumentSummary } from "../lib/room-state.ts";
import { initialTheme } from "../lib/session.ts";
import { agentPrompt, loadSharedPage, publicApiFor, type SharedPageState } from "../lib/share.ts";
import { EmptyState, Icon, Time } from "./common.tsx";
import { SharedSnapshotStage } from "./snapshot-stage.tsx";

/** Where a visitor goes to sign in: the workspace itself, which runs its usual sign-in. */
const SIGN_IN_PATH = "/";

export type SharedPageViewProps = {
  state: SharedPageState;
  token: string;
  /** The page's own origin: the prompt names addresses on it. */
  origin: string;
  /** The client the pages came through; the stage paints the pages it is given and asks it for nothing. */
  api: WorkspaceApi;
  promptCopied: boolean;
  copyError: string | null;
  onCopyPrompt(text: string): void;
  onRetry(): void;
};

/** One state of a share page. */
export function SharedPageView({ state, token, origin, api, promptCopied, copyError, onCopyPrompt, onRetry }: SharedPageViewProps) {
  return (
    <div class="shared-page">
      <header class="topbar shared-topbar">
        <span class="brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-name">Wolf Workspace</span>
        </span>
        <span class="topbar-spacer" />
        <a class="button button--small button--quiet" href={SIGN_IN_PATH}>
          Sign in
        </a>
      </header>
      {state.kind === "loading" ? (
        <main class="shared-empty">
          <p class="gate-status" role="status">
            Opening the shared document
          </p>
        </main>
      ) : null}
      {state.kind === "ended" ? (
        <main class="shared-empty">
          <EmptyState title="This link is no longer shared">
            <p>Ask the person who sent it for a new link.</p>
          </EmptyState>
        </main>
      ) : null}
      {state.kind === "failed" ? (
        <main class="shared-empty">
          <div class="notice notice--danger" role="alert">
            <span>The shared document did not open: {state.error}</span>
            <button type="button" class="button button--small" onClick={onRetry}>
              Try again
            </button>
          </div>
        </main>
      ) : null}
      {state.kind === "shared" ? (
        <SharedDocument
          state={state}
          token={token}
          origin={origin}
          api={api}
          promptCopied={promptCopied}
          copyError={copyError}
          onCopyPrompt={onCopyPrompt}
          onRetry={onRetry}
        />
      ) : null}
    </div>
  );
}

type SharedDocumentProps = Omit<SharedPageViewProps, "state"> & { state: Extract<SharedPageState, { kind: "shared" }> };

function SharedDocument({ state, token, origin, api, promptCopied, copyError, onCopyPrompt, onRetry }: SharedDocumentProps) {
  const { share, pages, problem } = state;
  // A link carries no hash of the head, so the banner shows none.
  const doc: DocumentSummary = {
    name: share.doc_name,
    format: share.format,
    revision: share.revision,
    sha256: "",
    updated_at: share.updated_at,
    openProposals: 0,
    openThreads: 0,
  };
  const prompt = share.connect === null ? null : agentPrompt(origin, token, share.connect);
  return (
    <div class="shared-body">
      <div class="shared-main">
        <p class="shared-byline">
          Shared by <strong>{share.shared_by}</strong>
          <span aria-hidden="true"> · </span>
          Updated <Time at={share.updated_at} />
        </p>
        {pages !== null ? (
          <SharedSnapshotStage api={api} roomId={null} doc={doc} snapshotPages={pages} activity={[]} presence={false} />
        ) : (
          <main class="shared-empty">
            <div class="notice notice--danger" role="alert">
              <span>
                The pages of {share.doc_name} did not load: {problem}
              </span>
              <button type="button" class="button button--small" onClick={onRetry}>
                Try again
              </button>
            </div>
          </main>
        )}
      </div>
      {prompt !== null ? (
        <aside class="shared-agent" aria-labelledby="shared-agent-title">
          <h2 id="shared-agent-title" class="shared-agent-title">
            Edit with your agent
          </h2>
          <p class="sheet-lede">
            Paste this prompt into your AI agent. It asks you to approve the connection, then proposes edits to{" "}
            {share.doc_name} for the people who shared it to review.
          </p>
          <textarea class="input input--mono shared-prompt" readOnly rows={4} aria-label="Prompt for your agent" value={prompt} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" class="button button--primary" onClick={() => onCopyPrompt(prompt)}>
            {promptCopied ? <Icon name="check" size={14} /> : null}
            {promptCopied ? "Prompt copied" : "Copy prompt"}
          </button>
          {copyError !== null ? (
            <p class="sheet-error" role="alert">
              {copyError}
            </p>
          ) : null}
          <p class="visually-hidden" role="status" aria-live="polite">
            {promptCopied ? "Prompt copied." : ""}
          </p>
        </aside>
      ) : null}
    </div>
  );
}

/** The page of a share link: loads it once with no credential, and again on Try again. */
export function SharedPage({ token }: { token: string }) {
  const api = useMemo(() => publicApiFor(location.origin, (input, init) => fetch(input, init)), []);
  const [state, setState] = useState<SharedPageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [promptCopied, setPromptCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // The visitor's theme, as the workspace would show it; the page stores nothing.
  useEffect(() => {
    document.documentElement.dataset.theme = initialTheme(localStorage, matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void loadSharedPage(api, token).then((next) => !cancelled && setState(next));
    return () => {
      cancelled = true;
    };
  }, [api, token, attempt]);

  useEffect(() => {
    document.title = state.kind === "shared" ? `${state.share.doc_name}, shared on Wolf Workspace` : "Wolf Workspace";
  }, [state]);

  useEffect(() => {
    if (!promptCopied) return;
    const timer = window.setTimeout(() => setPromptCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [promptCopied]);

  const copyPrompt = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyError(null);
        setPromptCopied(true);
      },
      () => setCopyError("This browser did not let the page copy. Select the prompt and copy it."),
    );
  };

  return (
    <SharedPageView
      state={state}
      token={token}
      origin={location.origin}
      api={api}
      promptCopied={promptCopied}
      copyError={copyError}
      onCopyPrompt={copyPrompt}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}
