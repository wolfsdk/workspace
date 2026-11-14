import { describe, expect, test } from "bun:test";
import type { VectorResult } from "../../src/seal/types.ts";
import { EXPECTED_EGRESS, type EgressBrowser, egressMismatches } from "../../src/seal/expected.ts";
import { VECTORS } from "../../src/seal/probe.ts";

const BROWSERS: EgressBrowser[] = ["chromium", "firefox", "webkit"];

/** The results the table expects, as the probe would report them. */
function asExpected(browser: EgressBrowser): VectorResult[] {
  return VECTORS.map((vector) => {
    const want = EXPECTED_EGRESS[browser].vectors[vector];
    return { vector, outcome: want.outcome, enforcedBy: want.outcome === "blocked" ? "browser" : "code" };
  });
}

describe("expected egress table", () => {
  test("covers every vector in every browser; every excused entry has a reason", () => {
    for (const browser of BROWSERS) {
      const table = EXPECTED_EGRESS[browser];
      expect(Object.keys(table.vectors).sort()).toEqual([...VECTORS].sort());
      expect(table.basis.length).toBeGreaterThan(0);
      for (const want of Object.values(table.vectors)) {
        if (want.outcome !== "blocked") expect(want.reason.endsWith(".")).toBe(true);
      }
    }
  });

  test("records the runs so far", () => {
    expect(EXPECTED_EGRESS.chromium.vectors.prefetch.outcome).toBe("allowed");
    expect(EXPECTED_EGRESS.chromium.vectors.webrtc.outcome).toBe("removed");
    expect(EXPECTED_EGRESS.firefox.vectors.prefetch.outcome).toBe("blocked");
    expect(EXPECTED_EGRESS.firefox.vectors.webrtc.outcome).toBe("removed");
    expect(EXPECTED_EGRESS.webkit.vectors.prefetch.outcome).toBe("not-tested");
    expect(EXPECTED_EGRESS.webkit.vectors.form.outcome).toBe("blocked");
    for (const browser of BROWSERS) expect(EXPECTED_EGRESS[browser].basis).toStartWith("Recorded: ");
    // Navigation is never browser-blocked while the vault is same-origin with the loader.
    for (const browser of BROWSERS) expect(EXPECTED_EGRESS[browser].vectors.navigation.outcome).toBe("allowed");
  });

  test("agreeing results give no mismatch", () => {
    for (const browser of BROWSERS) expect(egressMismatches(browser, asExpected(browser))).toEqual([]);
  });

  test("fails in both directions, on a missing vector, and on a block the browser did not enforce", () => {
    const results = asExpected("firefox");
    const swap = (vector: string, change: Partial<VectorResult>) =>
      results.map((r) => (r.vector === vector ? { ...r, ...change } : r));
    expect(egressMismatches("firefox", swap("fetch", { outcome: "allowed" }))).toEqual([
      "fetch: expected blocked, got allowed.",
    ]);
    const tightened = egressMismatches("firefox", swap("webrtc", { outcome: "blocked", enforcedBy: "browser" }));
    expect(tightened).toHaveLength(1);
    expect(tightened[0]).toContain("tighten the table");
    expect(egressMismatches("firefox", results.slice(1))).toEqual(["fetch: missing from the results."]);
    expect(egressMismatches("firefox", swap("image", { enforcedBy: "code" }))).toEqual([
      "image: blocked, but not by the browser (code).",
    ]);
  });
});
