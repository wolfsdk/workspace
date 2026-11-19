/** @jsxImportSource preact */
// Small pieces every pane uses: icons, pills, badges, times, the toast stack.
import type { RoomActor, WorkspaceDocFormat } from "@wolfsdk/protocol/workspace";
import type { ComponentChildren } from "preact";
import type { ConnectionStatus } from "../lib/room-client.ts";
import { formatPacificTime } from "../lib/time.ts";

const PATHS = {
  rooms: "M3 4.5h10M3 8h10M3 11.5h6",
  doc: "M4.5 2.5h5l2.5 2.5v8.5h-7.5zM9.5 2.5V5H12",
  upload: "M8 11V3M5 6l3-3 3 3M3 13h10",
  download: "M8 3v8M5 8l3 3 3-3M3 13h10",
  plus: "M8 3.5v9M3.5 8h9",
  search: "M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.5 10.5l3 3",
  sun: "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z",
  panelLeft: "M2.5 3.5h11v9h-11zM6 3.5v9",
  panelRight: "M2.5 3.5h11v9h-11zM10 3.5v9",
  check: "M3.5 8.5l3 3 6-7",
  x: "M4 4l8 8M12 4l-8 8",
  anchor: "M8 4.5v9M5 7h6M3.5 10a4.5 4.5 0 0 0 9 0",
  refresh: "M12.5 6A5 5 0 0 0 3.2 6.5M3.5 10a5 5 0 0 0 9.3-.5M12.5 2.5V6H9M3.5 13.5V10H7",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  key: "M10 9.5a3.5 3.5 0 1 0-3.3-2.3L2.5 11.5v2h2v-1.5H6v-1.5h1.5l.6-.6A3.5 3.5 0 0 0 10 9.5z",
  link: "M6.5 9.5l3-3M7.5 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M8.5 11.5l-1 1A2.5 2.5 0 0 1 4 9l1-1",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function FormatPill({ format }: { format: WorkspaceDocFormat }) {
  return <span class={`pill pill--${format}`}>{format.toUpperCase()}</span>;
}

export function ActorBadge({ actor, you = false }: { actor: RoomActor; you?: boolean }) {
  return (
    <span class={`actor actor--${actor.kind}`} title={`${actor.kind === "agent" ? "Agent" : "User"} ${actor.id}`}>
      <span class="actor-mark" aria-hidden="true">
        {actor.kind === "agent" ? "A" : actor.name.slice(0, 1).toUpperCase()}
      </span>
      <span class="actor-name">{actor.name}</span>
      {you ? <span class="actor-you">you</span> : null}
    </span>
  );
}

export type SessionControlsProps = {
  actor: RoomActor;
  /** The account a hosting front signed in; null on a self-hosted server. */
  account: { email: string; name: string } | null;
  /** The tooltip of the signed-in actor. */
  title?: string;
  /** The actor is a guest of shared documents: the role says so. */
  guest?: boolean;
  /** Opens the token dialog. Absent behind a hosting front: the front holds the session and the page has no token. */
  onSwitchToken?: () => void;
  /** The hosting front's page where the signed-in person makes agent tokens. Absent when the front names none. */
  accountPage?: string;
  /** The hosting front's page of the plan and the trial's dates. Absent when the front names none. */
  plansPage?: string;
  onSignOut(): void;
  signingOut?: boolean;
};

/** Who is signed in, in the top bar, with the way to switch token (self-hosted only) and to sign out. Behind a hosting
 * front that names them, also the way to the page that makes agent tokens and to the page of the plan. */
export function SessionControls({ actor, account, title, guest = false, onSwitchToken, accountPage, plansPage, onSignOut, signingOut = false }: SessionControlsProps) {
  return (
    <>
      <span class="me" title={title}>
        <ActorBadge actor={actor} />
        <span class={`role role--${guest ? "guest" : actor.kind}`}>{guest ? "Guest" : actor.kind === "agent" ? "Agent" : "User"}</span>
        {account ? (
          <span class="status status--muted" title={`Signed in as ${account.name || account.email}`}>
            {account.email || account.name}
          </span>
        ) : null}
      </span>
      {onSwitchToken ? (
        <button type="button" class="button button--small button--quiet" onClick={onSwitchToken}>
          Switch token
        </button>
      ) : null}
      {accountPage ? (
        <a class="button button--small button--quiet" href={accountPage} title="Make an agent token: the account page shows the address an MCP client connects to">
          Connect an agent
        </a>
      ) : null}
      {plansPage ? (
        <a class="button button--small button--quiet" href={plansPage} title="Your plan, and when the trial ends">
          Plan
        </a>
      ) : null}
      <button type="button" class="button button--small button--quiet" disabled={signingOut} onClick={onSignOut}>
        {signingOut ? "Signing out" : "Sign out"}
      </button>
    </>
  );
}

/** A Pacific time, with the instant in the tooltip and the `datetime` attribute. */
export function Time({ at }: { at: string }) {
  return (
    <time class="time" dateTime={at} title={at}>
      {formatPacificTime(at)}
    </time>
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  closed: "Offline",
};

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  return (
    <span class={`connection connection--${status}`} role="status" aria-live="polite">
      <span class="connection-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <p class="empty-title">{title}</p>
      {children ? <div class="empty-body">{children}</div> : null}
    </div>
  );
}

export type Toast = { id: number; tone: "info" | "success" | "warning" | "danger"; text: string };

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss(id: number): void }) {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class={`toast toast--${toast.tone}`} role={toast.tone === "danger" ? "alert" : "status"}>
          <span>{toast.text}</span>
          <button type="button" class="icon-button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Save `bytes` as `name` through a temporary link. */
export function downloadBytes(name: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  // BlobPart wants an ArrayBuffer-backed view; copy only if the bytes sit on a shared buffer.
  const own = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
  const url = URL.createObjectURL(new Blob([own], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `Cmd` on a Mac, `Ctrl` elsewhere. */
export const modKey = (): string => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl");

/** `1 change`, `2 changes`. */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
