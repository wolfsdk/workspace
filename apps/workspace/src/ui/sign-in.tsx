/** @jsxImportSource preact */
// The token sheet: the gate before the workspace on a self-hosted server, and the "Switch token" dialog inside it.
// Behind a hosting front the page has no token and shows neither: the front's own page signs people in, and
// `HostedGate` covers a server that did not answer.
import { useState } from "preact/hooks";
import { Icon } from "./common.tsx";

export function SignIn({
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  error: string | null;
  busy: boolean;
  onSubmit(token: string): void;
  /** Present when a session is open: the sheet is a dialog over it. */
  onCancel?: () => void;
}) {
  const [token, setToken] = useState("");
  return (
    <div class={onCancel ? "sheet-scrim" : "gate"} onClick={(e) => e.target === e.currentTarget && onCancel?.()}>
      <form
        class="sheet"
        role="dialog"
        aria-modal={onCancel ? "true" : undefined}
        aria-labelledby="sign-in-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim() !== "") onSubmit(token.trim());
        }}
      >
        <div class="sheet-brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-name">Wolf Workspace</span>
        </div>
        <h1 id="sign-in-title" class="sheet-title">
          {onCancel ? "Switch token" : "Sign in with your access token"}
        </h1>
        <p class="sheet-lede">
          Your administrator lists each token in the actors file of this server. The token stays in this tab and is
          sent only to this server.
        </p>
        <label class="field">
          <span class="field-label">Access token</span>
          <span class="field-input field-input--icon">
            <Icon name="key" />
            <input
              type="password"
              autoComplete="off"
              spellcheck={false}
              autoFocus
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
              placeholder="Paste your token"
            />
          </span>
        </label>
        {error ? (
          <p class="sheet-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="sheet-actions">
          {onCancel ? (
            <button type="button" class="button button--quiet" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button type="submit" class="button button--primary" disabled={busy || token.trim() === ""}>
            {busy ? "Checking" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The gate behind a hosting front when the server did not say who the session stands for (a 401 has already sent
 * the browser to the front's sign-in page): what went wrong and a way to try again. It never offers the token form,
 * because the front holds the session and the page has no token. */
export function HostedGate({ error, busy, onRetry }: { error: string; busy: boolean; onRetry(): void }) {
  return (
    <div class="gate">
      <div class="sheet" role="alertdialog" aria-labelledby="hosted-gate-title">
        <div class="sheet-brand">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span class="brand-name">Wolf Workspace</span>
        </div>
        <h1 id="hosted-gate-title" class="sheet-title">
          The workspace did not open
        </h1>
        <p class="sheet-error" role="alert">
          {error}
        </p>
        <div class="sheet-actions">
          <button type="button" class="button button--primary" disabled={busy} onClick={onRetry}>
            {busy ? "Trying again" : "Try again"}
          </button>
        </div>
      </div>
    </div>
  );
}
