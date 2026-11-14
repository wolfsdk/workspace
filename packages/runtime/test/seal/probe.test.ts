import { describe, expect, test } from "bun:test";
import type { EgressVector } from "../../src/seal/types.ts";
import {
  type FormObservation,
  type Observed,
  VECTORS,
  classify,
  formOutcome,
  matcher,
  navigationWatch,
  otherSite,
  tagged,
} from "../../src/seal/probe.ts";

const NONCE = "0123456789abcdef";
const none = { violations: [], reports: 0 };
const ran = (note: string, extra: Partial<Observed["attempt"]> = {}): Observed => ({ attempt: { note, ...extra }, evidence: none });
const violated = (note: string, directive: string, blockedURI = ""): Observed => ({
  attempt: { note },
  evidence: { violations: [{ directive, blockedURI }], reports: 0 },
});

describe("probe vectors", () => {
  test("covers every EgressVector once", () => {
    const all: EgressVector[] = [
      "fetch",
      "xhr",
      "websocket",
      "eventsource",
      "beacon",
      "image",
      "form",
      "prefetch",
      "preconnect",
      "dns-prefetch",
      "navigation",
      "webrtc",
      "worker-fetch",
    ];
    expect([...VECTORS].sort()).toEqual(all.sort());
    expect(new Set(VECTORS).size).toBe(all.length);
  });
});

describe("targets", () => {
  test("the other site never resolves and is unique to the vector and run", () => {
    const a = otherSite("fetch", NONCE);
    expect(a.hostname).toBe(`wolf-lab-fetch-${NONCE}.invalid`);
    expect(a.searchParams.get("vector")).toBe("fetch");
    expect(a.searchParams.get("probe")).toBe(NONCE);
    expect(otherSite("image", NONCE).hostname).not.toBe(a.hostname);
    for (const vector of VECTORS) expect(otherSite(vector, NONCE).hostname.endsWith(".invalid")).toBe(true);
  });

  test("a canary violation is matched on its full tagged URL, in any scheme", () => {
    const canary = tagged(new URL("https://lab.test/lab/canary"), "websocket", NONCE);
    const match = matcher(canary, false);
    expect(match(canary.href)).toBe(true);
    expect(match(`wss://lab.test/lab/canary?vector=websocket&probe=${NONCE}`)).toBe(true);
    expect(match(JSON.stringify({ url: canary.href }))).toBe(true);
    // Another vector's late event, or the bare origin, is not this attempt.
    expect(match(`https://lab.test/lab/canary?vector=fetch&probe=${NONCE}`)).toBe(false);
    expect(match("https://lab.test")).toBe(false);
  });

  test("an other-site violation is matched on its host, even cut to the origin", () => {
    const other = otherSite("image", NONCE);
    const match = matcher(other, true);
    expect(match(other.origin)).toBe(true);
    expect(match(otherSite("fetch", NONCE).origin)).toBe(false);
  });
});

describe("classify", () => {
  test("a violation for the canary means blocked by the browser", () => {
    expect(classify("fetch", violated("The request failed", "connect-src"), ran("x"), true)).toEqual({
      vector: "fetch",
      outcome: "blocked",
      enforcedBy: "browser",
      detail: "The page's security policy refused it (connect-src).",
    });
  });

  test("violations reported by the worker count", () => {
    const worker = ran("", { violations: [{ directive: "connect-src", blockedURI: "https://lab.test/x" }] });
    expect(classify("worker-fetch", worker, ran("x"), true).outcome).toBe("blocked");
  });

  test("a connection-allowlist report means blocked", () => {
    const reported: Observed = { attempt: { note: "x" }, evidence: { violations: [], reports: 1 } };
    expect(classify("webrtc", reported)).toMatchObject({ outcome: "blocked", enforcedBy: "browser" });
  });

  test("a same-origin request that got through is not blocked, even when the other site was refused", () => {
    const result = classify("prefetch", ran("The prefetch completed"), violated("The prefetch failed", "default-src"), true);
    expect(result.outcome).toBe("allowed");
    expect(result.enforcedBy).toBe("code");
    expect(result.detail).toBe(
      "The prefetch completed. It reaches this site only: the same request to another site, an address ending in .invalid that never resolves, was refused by the browser.",
    );
  });

  test("a failure without browser evidence is allowed, never blocked", () => {
    const result = classify("fetch", ran("The request failed (TypeError: Failed to fetch)"), ran("The request failed"), true);
    expect(result.outcome).toBe("allowed");
    expect(result.detail).toContain("No browser policy refused it, nor the same request to another site");
  });

  test("a hint tried at the other site only", () => {
    expect(classify("preconnect", ran("The page asked the browser to open a connection to another site"))).toEqual({
      vector: "preconnect",
      outcome: "allowed",
      enforcedBy: "code",
      detail: "The page asked the browser to open a connection to another site. No browser policy refused it.",
    });
    expect(classify("dns-prefetch", violated("x", "default-src")).outcome).toBe("blocked");
  });

  test("an explicit refusal is blocked; an untested vector says so", () => {
    expect(classify("form", ran("", { refused: "The browser dropped the form before sending it" }), ran("x")).detail).toBe(
      "The browser dropped the form before sending it.",
    );
    expect(classify("prefetch", ran("", { untested: "No prefetch here" }), ran("x"))).toEqual({
      vector: "prefetch",
      outcome: "not-tested",
      enforcedBy: "none",
      detail: "No prefetch here.",
    });
  });

  test("detail text is plain: no em dash, sentences end with a full stop", () => {
    for (const vector of VECTORS) {
      for (const result of [
        classify(vector, ran("x"), ran("y"), true),
        classify(vector, ran("x"), violated("y", "img-src"), true),
        classify(vector, violated("x", "img-src")),
        classify(vector, ran("x")),
      ]) {
        expect(result.detail).not.toContain("\u2014");
        expect(result.detail!.endsWith(".")).toBe(true);
        expect(result.detail!.includes("..")).toBe(false);
      }
    }
  });
});

describe("form", () => {
  const VAULT_SANDBOX = new Set(["allow-scripts", "allow-same-origin", "allow-downloads"]);
  const seen = (change: Partial<FormObservation>): FormObservation => ({
    submitted: true,
    loaded: false,
    navigationStarted: false,
    sandbox: VAULT_SANDBOX,
    ...change,
  });
  const result = (change: Partial<FormObservation>) => classify("form", { attempt: formOutcome(seen(change)), evidence: none });

  test("dropped before the submit event in a frame without allow-forms (Chromium, Firefox): blocked", () => {
    expect(result({ submitted: false, navigationStarted: null })).toEqual({
      vector: "form",
      outcome: "blocked",
      enforcedBy: "browser",
      detail: "The browser dropped the form before sending it, as the sandbox of this page's frame requires.",
    });
  });

  test("submit event, then no navigation of the target, in a frame without allow-forms (WebKit): blocked", () => {
    expect(result({})).toEqual({
      vector: "form",
      outcome: "blocked",
      enforcedBy: "browser",
      detail:
        "The browser fired the form's submit event but never started sending the form, as the sandbox of this page's frame requires.",
    });
  });

  test("without a working navigate event the absence of a load proves nothing: allowed, saying exactly that", () => {
    const r = result({ navigationStarted: null });
    expect(r.outcome).toBe("allowed");
    expect(r.detail).toBe(
      "The form's submit event fired and nothing loaded. This browser gives the page no way to see whether the form was sent. No browser policy refused it.",
    );
  });

  test("a started navigation or a loaded response is never blocked", () => {
    expect(result({ navigationStarted: true }).outcome).toBe("allowed");
    expect(result({ navigationStarted: true }).detail).toStartWith("The browser started sending the form, and nothing loaded in time.");
    expect(result({ loaded: true, navigationStarted: true }).outcome).toBe("allowed");
    expect(result({ loaded: true, navigationStarted: null }).outcome).toBe("allowed");
  });

  test("forms allowed by the sandbox, or no sandbox: no navigation is not claimed as a block", () => {
    expect(result({ sandbox: new Set([...VAULT_SANDBOX, "allow-forms"]) }).outcome).toBe("allowed");
    expect(result({ sandbox: null }).outcome).toBe("allowed");
    expect(result({ submitted: false, sandbox: null }).outcome).toBe("allowed");
  });

  test("a form-action violation still decides, whatever the page saw", () => {
    const attempt = formOutcome(seen({ navigationStarted: true }));
    const r = classify("form", { attempt, evidence: { violations: [{ directive: "form-action", blockedURI: "" }], reports: 0 } });
    expect(r).toMatchObject({ outcome: "blocked", enforcedBy: "browser" });
  });
});

describe("navigationWatch", () => {
  /** A frame whose window has a Navigation API that fires `navigate` for every location change. */
  function fakeFrame(options: { href?: string; navigation?: boolean; fireControl?: boolean } = {}) {
    const navigation = new EventTarget();
    const fire = (url: string) => {
      const event = new Event("navigate");
      Object.defineProperty(event, "destination", { value: { url } });
      navigation.dispatchEvent(event);
    };
    const replaced: string[] = [];
    const win = {
      navigation: options.navigation === false ? undefined : navigation,
      location: {
        href: options.href ?? "about:srcdoc",
        replace(url: string) {
          replaced.push(url);
          if (options.fireControl !== false) fire(`about:srcdoc${url}`);
        },
      },
    };
    return { frame: { contentWindow: win } as unknown as HTMLIFrameElement, fire, replaced };
  }
  const ready = Promise.resolve();

  test("a control navigation that fires arms the watch; a later navigate means the browser started sending", async () => {
    const { frame, fire, replaced } = fakeFrame();
    const watch = await navigationWatch(frame, ready);
    expect(replaced).toEqual(["#wolf-lab-navigation-control"]);
    expect(watch?.started()).toBe(false);
    fire("https://lab.test/lab/canary?vector=form");
    expect(watch?.started()).toBe(true);
  });

  test("no watch when the control fires nothing, the API is missing, or the frame is not its srcdoc", async () => {
    expect(await navigationWatch(fakeFrame({ fireControl: false }).frame, ready)).toBeNull();
    expect(await navigationWatch(fakeFrame({ navigation: false }).frame, ready)).toBeNull();
    expect(await navigationWatch(fakeFrame({ href: "about:blank" }).frame, ready)).toBeNull();
  });
});
