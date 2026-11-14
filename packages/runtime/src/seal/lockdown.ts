/**
 * Removes the WebRTC constructors from this realm when it is evaluated.
 * A sealed page's entries (the loader page and the vault page) start with
 * the bare side-effect import `import "@wolfsdk/runtime/seal/lockdown";`
 * as their first statement, so it runs before any other module of the page.
 * `index.ts` imports it too; a module evaluates once. It imports nothing, so
 * no other package is evaluated before the deletion.
 *
 * Why: no page policy a browser has been observed enforcing covers WebRTC
 * (CSP `webrtc` is implemented nowhere; Chromium 158 did not enforce the
 * `Connection-Allowlist` header the vault sends). This is a
 * page measure, weaker than a browser policy: a script that appends an
 * iframe gets a fresh realm with the constructors back (CSP `frame-src` does
 * not govern `about:blank` or `srcdoc` frames), so it stops honest code from
 * opening a connection, not hostile code. The probe reports it as `removed`,
 * never as `blocked`.
 *
 * The original `RTCPeerConnection` is kept here so the probe can still test
 * what the browser itself allows on the page.
 */

/** The globals deleted: every constructor that opens or carries a peer connection. */
export const WEBRTC_GLOBALS: readonly string[] = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceTransport",
  "RTCSctpTransport",
  "RTCDtlsTransport",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
];

type PeerConnectionConstructor = typeof RTCPeerConnection;

let removed: string[] = [];
let original: PeerConnectionConstructor | undefined;

/**
 * Delete `WEBRTC_GLOBALS` from `realm` and return the names that were
 * present and are now gone. A name that could not be deleted is not listed.
 */
export function removeWebRtc(realm: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): string[] {
  const gone: string[] = [];
  for (const name of WEBRTC_GLOBALS) {
    if (!(name in realm)) continue;
    if (name === "RTCPeerConnection") original ??= realm[name] as PeerConnectionConstructor;
    try {
      delete realm[name];
    } catch {
      // Non-configurable in this engine: leave it and do not report it.
    }
    if (!(name in realm)) gone.push(name);
  }
  removed = [...new Set([...removed, ...gone])];
  return gone;
}

/** Names this page removed from its own realm. */
export const webRtcRemoved = (): readonly string[] => removed;

/** The `RTCPeerConnection` the browser provided, kept for the probe. */
export const originalPeerConnection = (): PeerConnectionConstructor | undefined => original;

removeWebRtc();
