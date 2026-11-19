/** @jsxImportSource preact */
// The Share dialog of the open document, for a member: make a link anyone can open with no account, copy it or a
// prompt that connects someone's own agent, end it after a confirmation, and behind a hosting front see and remove
// the guests the link let in. `ShareDialogModel` keeps the state; `ShareDialogView` draws one state of it.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WorkspaceApi } from "../lib/api.ts";
import { agentPrompt, SHARE_DIALOG_LOADING, type ShareDialogState, ShareDialogModel, sharePageUrl } from "../lib/share.ts";
import { Icon, Time } from "./common.tsx";

/** What was copied last, for the confirmation beside the control. */
export type Copied = "link" | "prompt" | null;

export type ShareDialogViewProps = {
  state: ShareDialogState;
  docName: string;
  /** The page's own origin: the link and the prompt are addresses on it. */
  origin: string;
  copied: Copied;
  copyError: string | null;
  onCreate(): void;
  onCopy(kind: "link" | "prompt", text: string): void;
  onAskStop(): void;
  onKeepSharing(): void;
  onStop(): void;
  onRemoveGuest(id: string): void;
  onRetry(): void;
  onClose(): void;
};

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** One state of the Share dialog. */
export function ShareDialogView(props: ShareDialogViewProps) {
  const { state, docName, origin, copied } = props;
  const share = state.share;
  const link = share === null ? null : sharePageUrl(origin, share.token);
  const guests = state.guests;
  const showGuests = state.guestsError !== null || (guests !== null && (state.phase === "shared" || guests.guests.length > 0));
  return (
    <div class="sheet share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
      <div class="share-head">
        <h2 id="share-title" class="sheet-title">
          Share <span class="share-doc">{docName}</span>
        </h2>
        <button type="button" class="icon-button" aria-label="Close" title="Close" onClick={props.onClose}>
          <Icon name="x" />
        </button>
      </div>
      {state.phase === "loading" ? (
        <p class="hint" role="status">
          Checking for a link
        </p>
      ) : null}
      {state.phase === "failed" ? (
        <>
          <p class="sheet-error" role="alert">
            The link did not load: {state.error}
          </p>
          <div class="sheet-actions">
            <button type="button" class="button" data-autofocus onClick={props.onRetry}>
              Try again
            </button>
          </div>
        </>
      ) : null}
      {state.phase === "unshared" ? (
        <>
          <p class="sheet-lede">
            Anyone with the link sees the pages of {docName} as they are now, read-only and with no account. A person who
            has the link can connect their own agent to propose edits.
          </p>
          <div class="sheet-actions">
            <button type="button" class="button button--primary" data-autofocus disabled={state.busy !== null} onClick={props.onCreate}>
              <Icon name="link" size={14} />
              {state.busy === "create" ? "Creating link" : "Create link"}
            </button>
          </div>
        </>
      ) : null}
      {state.phase === "shared" && link !== null && share !== null ? (
        <>
          <div class="field">
            <label class="field-label" for="share-link">
              Link
            </label>
            <div class="share-link">
              <input id="share-link" class="input input--mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" class="button" data-autofocus={state.confirmingStop ? undefined : true} onClick={() => props.onCopy("link", link)}>
                {copied === "link" ? <Icon name="check" size={14} /> : null}
                {copied === "link" ? "Copied" : "Copy"}
              </button>
            </div>
            <p class="hint">
              Anyone with the link sees the pages read-only. Shared <Time at={share.created_at} />.
            </p>
          </div>
          {state.connect !== null ? (
            <button
              type="button"
              class="button button--quiet share-prompt-button"
              onClick={() => props.onCopy("prompt", agentPrompt(origin, share.token, state.connect!))}
            >
              {copied === "prompt" ? <Icon name="check" size={14} /> : null}
              {copied === "prompt" ? "Prompt copied" : "Copy prompt for an agent"}
            </button>
          ) : null}
          {state.confirmingStop ? (
            <div class="notice notice--warning share-confirm" role="group" aria-labelledby="share-confirm-text">
              <span id="share-confirm-text">Stop sharing {docName}? The link stops working for everyone who has it.</span>
              <span class="notice-actions">
                <button type="button" class="button button--small button--quiet" data-autofocus disabled={state.busy !== null} onClick={props.onKeepSharing}>
                  Keep sharing
                </button>
                <button type="button" class="button button--small button--danger" disabled={state.busy !== null} onClick={props.onStop}>
                  {state.busy === "stop" ? "Stopping" : "Stop sharing"}
                </button>
              </span>
            </div>
          ) : (
            <div class="sheet-actions">
              <button type="button" class="button button--quiet button--danger-quiet" onClick={props.onAskStop}>
                Stop sharing
              </button>
            </div>
          )}
        </>
      ) : null}
      {state.error !== null && state.phase !== "failed" ? (
        <p class="sheet-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {props.copyError !== null ? (
        <p class="sheet-error" role="alert">
          {props.copyError}
        </p>
      ) : null}
      <p class="visually-hidden" role="status" aria-live="polite">
        {copied === "link" ? "Link copied." : copied === "prompt" ? "Prompt for an agent copied." : ""}
      </p>
      {showGuests ? <GuestSection state={state} onRemove={props.onRemoveGuest} /> : null}
    </div>
  );
}

function GuestSection({ state, onRemove }: { state: ShareDialogState; onRemove(id: string): void }) {
  const guests = state.guests;
  return (
    <section class="share-guests" aria-labelledby="share-guests-title">
      <header class="rail-heading">
        <h2 id="share-guests-title">Guests</h2>
        {guests !== null ? (
          <span class="badge">
            {guests.guests.length} of {guests.limit} guests
          </span>
        ) : null}
      </header>
      {state.guestsError !== null ? (
        <p class="sheet-error" role="alert">
          {state.guestsError}
        </p>
      ) : null}
      {guests === null ? null : guests.guests.length === 0 ? (
        <p class="hint">A person who connects an agent through the link joins as a guest, up to {guests.limit}. Guests propose edits; they take no seat.</p>
      ) : (
        <ul class="share-guest-list">
          {guests.guests.map((guest) => (
            <li key={guest.id} class="share-guest">
              <span class="share-guest-who">
                <strong>{guest.name || guest.email}</strong>
                {guest.name ? <span class="share-guest-email">{guest.email}</span> : null}
                <span class="share-guest-email">
                  Joined <Time at={guest.added_at} />
                </span>
              </span>
              <button
                type="button"
                class="button button--small button--danger-quiet"
                aria-label={`Remove ${guest.name || guest.email}`}
                disabled={state.removing !== null}
                onClick={() => onRemove(guest.id)}
              >
                {state.removing === guest.id ? "Removing" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type ShareDialogProps = {
  api: WorkspaceApi;
  roomId: string;
  docName: string;
  /** Behind a hosting front, which lists the guests of the document. */
  hosted: boolean;
  onClose(): void;
};

/** The Share dialog over the workspace: focus moves into it, Tab stays in it, Escape closes it, and focus goes back
 * to the control that opened it. */
export function ShareDialog({ api, roomId, docName, hosted, onClose }: ShareDialogProps) {
  const [state, setState] = useState<ShareDialogState>(SHARE_DIALOG_LOADING);
  const [copied, setCopied] = useState<Copied>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const model = useMemo(() => new ShareDialogModel(api, roomId, docName, { hosted, onChange: setState }), [api, roomId, docName, hosted]);
  const scrim = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void model.load();
  }, [model]);

  // Focus into the dialog on open, and back where it was on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scrim.current?.querySelector<HTMLElement>('[role="dialog"]')?.focus();
    return () => {
      window.clearTimeout(copiedTimer.current);
      before?.focus();
    };
  }, []);

  // Each new step puts focus on its main action, unless the person is in a field.
  const step = `${state.phase}:${state.confirmingStop}`;
  useEffect(() => {
    const dialog = scrim.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && dialog.contains(active)) return;
    dialog.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")?.focus();
  }, [step]);

  const copy = (kind: "link" | "prompt", text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyError(null);
        setCopied(kind);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(null), 2500);
      },
      () => setCopyError(kind === "link" ? "This browser did not let the page copy. Select the link and copy it." : "This browser did not let the page copy the prompt."),
    );
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const dialog = scrim.current?.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="sheet-scrim" ref={scrim} onKeyDown={onKeyDown} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <ShareDialogView
        state={state}
        docName={docName}
        origin={location.origin}
        copied={copied}
        copyError={copyError}
        onCreate={() => void model.create()}
        onCopy={copy}
        onAskStop={() => model.askStop()}
        onKeepSharing={() => model.keepSharing()}
        onStop={() => void model.stop()}
        onRemoveGuest={(id) => void model.removeGuest(id)}
        onRetry={() => void model.load()}
        onClose={onClose}
      />
    </div>
  );
}
