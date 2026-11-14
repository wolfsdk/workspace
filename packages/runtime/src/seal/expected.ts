/**
 * What `probeEgress` is expected to report in each browser the end-to-end
 * suite runs, against a preview with the generated headers. The seal spec
 * imports this table and fails on any result that differs from it in
 * either direction: a vector that gets through where the table says
 * `blocked`, and a vector the table excuses that the browser now blocks
 * (tighten the table then). Every entry that is not `blocked` carries its
 * reason.
 */
import type { EgressVector, VectorResult } from "./types.ts";
import { VECTORS } from "./probe.ts";

export type EgressBrowser = "chromium" | "firefox" | "webkit";

export type ExpectedVector =
  | { outcome: "blocked" }
  | { outcome: Exclude<VectorResult["outcome"], "blocked">; reason: string };

export type BrowserExpectation = {
  /** Where the expectation comes from: a recorded run, or the specifications only. */
  basis: string;
  vectors: Record<EgressVector, ExpectedVector>;
};

const BLOCKED: ExpectedVector = { outcome: "blocked" };

const NAVIGATION: ExpectedVector = {
  outcome: "allowed",
  reason: "The vault is same-origin with the loader, so a script can navigate the top page through it; no shipped policy governs navigation.",
};
const PRECONNECT: ExpectedVector = {
  outcome: "allowed",
  reason: "No CSP directive covers preconnect, and the page cannot observe whether a connection was opened.",
};
const DNS_PREFETCH: ExpectedVector = {
  outcome: "allowed",
  reason: "No CSP directive covers DNS, and the page cannot observe whether a lookup happened.",
};
const WEBRTC_REMOVED: ExpectedVector = {
  outcome: "removed",
  reason: "No policy this browser enforces covers WebRTC (CSP webrtc is not implemented, and there is no Connection-Allowlist); the page removes the constructors, which a new frame gets back.",
};
const WEBRTC_REMOVED_CHROMIUM: ExpectedVector = {
  outcome: "removed",
  reason:
    "Chromium created a peer connection although the vault sends Connection-Allowlist. Chromium refuses under that header in the RTCPeerConnection constructor, which the probe calls, so this build did not enforce the header's WebRTC part; the page removes the constructors, which a new frame gets back.",
};

/** Every vector `blocked` except the ones given. */
function expect(basis: string, excused: Partial<Record<EgressVector, ExpectedVector>>): BrowserExpectation {
  const vectors = Object.fromEntries(VECTORS.map((v) => [v, excused[v] ?? BLOCKED])) as Record<EgressVector, ExpectedVector>;
  return { basis, vectors };
}

export const EXPECTED_EGRESS: Record<EgressBrowser, BrowserExpectation> = {
  chromium: expect(
    "Recorded: Chromium 158.0.8127.18, build 34cf8169b563dcab (end-to-end run 3; also build 108c5d23e64348fa): canary hit for same-origin prefetch only; every vector blocked by the browser except prefetch, preconnect, dns-prefetch, navigation and webrtc (removed). An earlier run (headless shell 1254, build at 3bec3e6, a probe that configured a STUN server) was reported as refusing WebRTC; later runs do not reproduce it.",
    {
      prefetch: {
        outcome: "allowed",
        reason: "Chromium sends a same-origin prefetch under the vault policy (observed at the canary); it reaches this site only.",
      },
      preconnect: PRECONNECT,
      "dns-prefetch": DNS_PREFETCH,
      navigation: NAVIGATION,
      webrtc: WEBRTC_REMOVED_CHROMIUM,
    },
  ),
  firefox: expect(
    "Recorded: Firefox 159.0, build 34cf8169b563dcab (end-to-end run 3; also build 108c5d23e64348fa): no canary hits; every vector blocked by the browser except preconnect, dns-prefetch, navigation and webrtc (removed).",
    { preconnect: PRECONNECT, "dns-prefetch": DNS_PREFETCH, navigation: NAVIGATION, webrtc: WEBRTC_REMOVED },
  ),
  webkit: expect(
    "Recorded: WebKit 27.2 (Playwright build), build 34cf8169b563dcab (end-to-end run 3): no canary hits; every vector blocked by the browser except form, preconnect, dns-prefetch, navigation, webrtc (removed) and prefetch (not tested). Except form: that run's probe reported it allowed (submit event fired, nothing loaded, no policy report) because WebKit fires the submit event in a frame without allow-forms. The probe now also watches the target frame's navigate event, so form is expected blocked by the sandbox; not yet recorded.",
    {
      prefetch: { outcome: "not-tested", reason: "WebKit does not support prefetch links, so the probe does not try one." },
      preconnect: PRECONNECT,
      "dns-prefetch": DNS_PREFETCH,
      navigation: NAVIGATION,
      webrtc: WEBRTC_REMOVED,
    },
  ),
};

/** One sentence per difference between `results` and the table; empty when they agree. */
export function egressMismatches(browser: EgressBrowser, results: readonly VectorResult[]): string[] {
  const expected = EXPECTED_EGRESS[browser].vectors;
  const problems: string[] = [];
  const seen = new Set<EgressVector>();
  for (const result of results) {
    if (seen.has(result.vector)) problems.push(`${result.vector}: reported more than once.`);
    seen.add(result.vector);
    const want = expected[result.vector];
    if (!want) {
      problems.push(`${result.vector}: not in the table.`);
      continue;
    }
    if (result.outcome === want.outcome) {
      if (want.outcome === "blocked" && result.enforcedBy !== "browser") {
        problems.push(`${result.vector}: blocked, but not by the browser (${result.enforcedBy}).`);
      }
      continue;
    }
    problems.push(
      want.outcome === "blocked"
        ? `${result.vector}: expected blocked, got ${result.outcome}. ${result.detail ?? ""}`.trim()
        : `${result.vector}: expected ${want.outcome} (${want.reason}), got ${result.outcome}; tighten the table if the browser now blocks it.`,
    );
  }
  for (const vector of VECTORS) if (!seen.has(vector)) problems.push(`${vector}: missing from the results.`);
  return problems;
}
