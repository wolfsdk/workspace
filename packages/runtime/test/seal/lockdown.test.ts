import { afterEach, describe, expect, test } from "bun:test";
import { classify, webrtcAttempt } from "../../src/seal/probe.ts";
import type * as Lockdown from "../../src/seal/lockdown.ts";
import { WEBRTC_GLOBALS, originalPeerConnection, removeWebRtc, webRtcRemoved } from "../../src/seal/lockdown.ts";

const realm = globalThis as unknown as Record<string, unknown>;

/** A peer connection that can be created and make an offer, and records what it was asked. */
class FakePeerConnection {
  static created: unknown[] = [];
  closed = false;
  constructor(config?: unknown) {
    FakePeerConnection.created.push(config);
  }
  createDataChannel() {
    return {};
  }
  async createOffer() {
    return { type: "offer", sdp: "" };
  }
  setLocalDescription() {
    throw new Error("the probe must not start gathering");
  }
  close() {
    this.closed = true;
  }
}

class RefusingPeerConnection {
  constructor() {
    throw new DOMException('RTCPeerConnection construction is disallowed by the "Connection-Allowlist" header.', "NotAllowedError");
  }
}

function install(value: unknown): void {
  for (const name of WEBRTC_GLOBALS) realm[name] = name === "RTCPeerConnection" ? value : class {};
}

afterEach(() => {
  for (const name of WEBRTC_GLOBALS) delete realm[name];
});

describe("lockdown", () => {
  test("evaluating the module removes every WebRTC global", async () => {
    install(FakePeerConnection);
    // Dynamic on purpose: the test is the module's evaluation. A query gives a
    // fresh instance, evaluated now against the fakes; a static import has
    // already run against a global without them.
    const fresh = (await import(`../../src/seal/lockdown.ts?evaluate=${Date.now()}`)) as typeof Lockdown;
    for (const name of WEBRTC_GLOBALS) expect(name in realm).toBe(false);
    expect([...fresh.webRtcRemoved()].sort()).toEqual([...WEBRTC_GLOBALS].sort());
    expect(fresh.originalPeerConnection()).toBe(FakePeerConnection as unknown as typeof RTCPeerConnection);
  });

  test("removeWebRtc reports only names that were present", () => {
    realm.RTCPeerConnection = FakePeerConnection;
    const fake: Record<string, unknown> = { RTCDataChannel: class {} };
    expect(removeWebRtc(fake)).toEqual(["RTCDataChannel"]);
    expect(Object.keys(fake)).toEqual([]);
  });
});

describe("probe, webrtc", () => {
  // One sequence: the lockdown module keeps the first constructor it removed.
  test("blocked on a policy error, allowed while reachable, removed once the page deleted it", async () => {
    expect(originalPeerConnection()).toBeUndefined();

    install(RefusingPeerConnection);
    const refused = classify("webrtc", { attempt: await webrtcAttempt(), evidence: { violations: [], reports: 0 } });
    expect(refused).toMatchObject({ outcome: "blocked", enforcedBy: "browser" });
    expect(refused.detail).toContain("NotAllowedError");

    install(FakePeerConnection);
    FakePeerConnection.created = [];
    const allowed = classify("webrtc", { attempt: await webrtcAttempt(), evidence: { violations: [], reports: 0 } });
    expect(allowed.outcome).toBe("allowed");
    expect(allowed.enforcedBy).toBe("code");
    expect(allowed.detail).toContain("named no server and started no connection, so nothing was sent");
    // No ICE servers, ever.
    expect(FakePeerConnection.created).toEqual([undefined]);

    removeWebRtc();
    expect(webRtcRemoved()).toContain("RTCPeerConnection");
    expect("RTCPeerConnection" in realm).toBe(false);
    const removed = classify("webrtc", { attempt: await webrtcAttempt(), evidence: { violations: [], reports: 0 } });
    expect(removed.outcome).toBe("removed");
    expect(removed.enforcedBy).toBe("code");
    expect(removed.detail).toContain("The page removed the peer connection API");
    expect(removed.detail).toContain("A script that creates a new frame can still reach it.");

    // A webrtc violation still means blocked, whatever the page did.
    const violated = classify("webrtc", {
      attempt: await webrtcAttempt(),
      evidence: { violations: [{ directive: "webrtc", blockedURI: "" }], reports: 0 },
    });
    expect(violated).toMatchObject({ outcome: "blocked", enforcedBy: "browser" });
  });
});
