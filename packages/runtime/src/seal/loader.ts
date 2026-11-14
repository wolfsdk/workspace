/**
 * Loader side: the sealed page (`/lab/` by default). It has the network and
 * never receives a visitor's file. It fetches the manifest, tells the vault
 * frame about it, and answers the vault's `get` requests with verified bytes.
 */
import type { LabManifest } from "./types.ts";
import { type BusEvent, MSG_MANIFEST, type ManifestMessage, checkManifest, createAssetServer } from "./bus.ts";
import { POLICY_HEADER_NAMES } from "./policy.ts";
import { post } from "./post.ts";

export type LoaderOptions = {
  /** The vault <iframe>. */
  frame: HTMLIFrameElement;
  /** URL of manifest.json, relative to the loader page. */
  manifestUrl: string;
  onState?: (state: { phase: "manifest" | "ready" | "error"; manifest?: LabManifest; error?: string }) => void;
};

/** The manifest this page loaded, for `registerOffline`. */
let loaded: Promise<LabManifest> | null = null;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchManifest(url: URL): Promise<LabManifest> {
  const response = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`manifest.json answered ${response.status}`);
  return checkManifest(await response.json());
}

/**
 * The vault policy headers on a fresh response for the vault page, by
 * lowercase name. The vault cannot read the headers of its own response, so
 * the loader requests the same URL (no-store, the way the frame's navigation
 * revalidates) and keeps only the names the policy defines. Empty when the
 * page cannot be fetched or does not answer 200.
 */
export async function observeVaultHeaders(url: string): Promise<Record<string, string>> {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    // Read to the end, never cancel: the browser reports a cancelled body as a
    // failed request (Chromium: net::ERR_ABORTED), and a first-visit budget
    // receipt must not contain one. The vault page is small. Offline, sw.js
    // answers this from its cache with the same policy headers.
    await response.arrayBuffer();
    if (!response.ok) return {};
    const observed: Record<string, string> = {};
    for (const name of POLICY_HEADER_NAMES) {
      const value = response.headers.get(name);
      if (value !== null) observed[name.toLowerCase()] = value;
    }
    return observed;
  } catch {
    return {};
  }
}

/** True once the frame shows the vault document (not its initial about:blank). */
function vaultLoaded(frame: HTMLIFrameElement): boolean {
  const doc = frame.contentDocument;
  return doc !== null && doc.readyState === "complete" && doc.location.href !== "about:blank";
}

/** Fetch the manifest, then serve assets to the vault by sha256. Resolves
 * when the bus is live; rejects (after an `error` state) when the manifest
 * cannot be loaded. */
export async function startLoader({ frame, manifestUrl, onState }: LoaderOptions): Promise<void> {
  const origin = window.location.origin;
  const base = new URL(manifestUrl, document.baseURI);
  let manifest: LabManifest;
  const policyHeaders = frame.src ? observeVaultHeaders(frame.src) : Promise.resolve({});
  onState?.({ phase: "manifest" });
  try {
    loaded = fetchManifest(base);
    manifest = await loaded;
  } catch (error) {
    onState?.({ phase: "error", error: message(error) });
    throw error;
  }

  const server = createAssetServer({
    manifest,
    origin,
    vault: () => frame.contentWindow,
    load: async (ref) => {
      const response = await fetch(new URL(`cas/${ref.id}`, base), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      return response.arrayBuffer();
    },
    digest: sha256Hex,
    onReject: (reason, event) => console.warn(`asset bus dropped a message (${reason})`, event.origin),
  });

  window.addEventListener("message", (event: MessageEvent) => {
    const busEvent: BusEvent = { data: event.data, origin: event.origin, source: event.source };
    void server.handle(busEvent).then((answer) => {
      // Re-check the window: the frame may have navigated while bytes loaded.
      const vault = frame.contentWindow;
      if (!answer || !vault || event.source !== vault) return;
      post(vault, answer.message, { targetOrigin: origin, transfer: answer.transfer });
    });
  });

  const announcement: ManifestMessage = { type: MSG_MANIFEST, manifest, policyHeaders: await policyHeaders };
  // Through `post`, never a direct tail call: see post.ts (WebKit reports the receiver as the source).
  const announce = () => {
    const vault = frame.contentWindow;
    if (vault) post(vault, announcement, { targetOrigin: origin });
  };
  frame.addEventListener("load", announce);
  if (vaultLoaded(frame)) announce();
  onState?.({ phase: "ready", manifest });
}

/**
 * Register the service worker (`sw.js`, scope: the base path) that keeps the
 * hashed build for offline use. Resolves when it controls the page or when
 * the browser has no service workers; rejects when registration or install
 * fails. The build id goes into the script URL so each build installs anew.
 */
export async function registerOffline(): Promise<void> {
  const container = navigator.serviceWorker;
  if (!container || !window.isSecureContext) return;
  const manifest = await (loaded ?? fetchManifest(new URL("manifest.json", document.baseURI)));
  const script = new URL(`sw.js?v=${encodeURIComponent(manifest.build)}`, document.baseURI);
  const registration = await container.register(script, {
    scope: new URL("./", document.baseURI).pathname,
    updateViaCache: "none",
  });
  if (container.controller) return;
  const installing = registration.installing ?? registration.waiting;
  // Active but not in control: a hard reload bypasses the worker for this page.
  if (!installing) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  container.addEventListener("controllerchange", () => resolve(), { once: true });
  installing.addEventListener("statechange", () => {
    if (installing.state === "redundant") reject(new Error("the offline cache could not be installed"));
  });
  return promise;
}
