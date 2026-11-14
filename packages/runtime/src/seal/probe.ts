/**
 * Egress probe. Run inside the vault: it tries each way a page can send data
 * out and reports per vector whether the browser refused it. The playground
 * UI and the end-to-end specs both use it; the specs also check the canary server
 * for hits and that no request leaves the origin.
 *
 * Each request vector is tried twice, one after the other:
 *
 * - against the canary URL the caller picks (the Lab's own origin), so a
 *   request that gets through is seen by the server;
 * - against another site that cannot exist: `wolf-lab-<vector>-<nonce>.invalid`
 *   (RFC 6761, never resolves), so a request that gets through goes nowhere.
 *
 * `blocked` needs the browser's own evidence about the canary attempt: a
 * `securitypolicyviolation` event naming that URL, a `connection-allowlist`
 * report naming it, a policy error thrown by the API, or (form) the browser
 * dropping the submission as the frame's sandbox requires: before its submit
 * event, or after it without starting the navigation that sends a form
 * (`formOutcome`). A request that merely failed, or that the probe cannot see, is
 * `allowed`: nothing showed that a policy stopped it. When the canary
 * attempt is allowed but the other-site attempt was refused, the detail says
 * the vector reaches this site only.
 *
 * The connection hints (preconnect, dns-prefetch) send no HTTP request a
 * server could log, so they are tried against the other site only.
 *
 * WebRTC is never connected. The probe creates a peer connection with no
 * ICE servers, asks it for an offer and closes it, without setting the
 * offer, so no candidate gathering starts and nothing is sent. Evidence:
 * a policy error from the constructor or a `webrtc` violation means
 * `blocked`. Chromium's Connection-Allowlist, where enforced, throws
 * NotAllowedError from the constructor itself, so starting a connection
 * would show nothing more. A constructor and an offer mean the browser
 * allows it. If the page removed
 * the constructors (`lockdown.ts`) and the browser would allow them, the
 * result is `removed`, never `blocked`.
 *
 * The probe tests this page's own context. It cannot detect hostile code: a
 * script on the same origin can act through the loader page instead, which
 * this probe does not test.
 */
import type { EgressVector, ProbeEgress, VectorResult } from "./types.ts";
import { originalPeerConnection, webRtcRemoved } from "./lockdown.ts";
import { post } from "./post.ts";

export const VECTORS: readonly EgressVector[] = [
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

export type Violation = { directive: string; blockedURI: string };

/** What one attempt observed, before browser evidence is matched to it. */
export type Attempt = {
  /** What happened, as a sentence without its full stop. */
  note: string;
  /** The browser refused it with a policy error or as its sandbox requires. */
  refused?: string;
  /** Could not be tried in this browser or context. */
  untested?: string;
  /** Violations seen in another realm (the probe worker). */
  violations?: Violation[];
  /** The browser allows it, but the page removed the API from its own realm. */
  removed?: string;
};

/** Browser evidence about one target, already matched to it. */
export type Evidence = { violations: readonly Violation[]; reports: number };

/** One attempt with the evidence gathered for its target. */
export type Observed = { attempt: Attempt; evidence: Evidence };

const TIMEOUT_MS = 2500;
const LONG_TIMEOUT_MS = 4000;
/** Wait after each attempt: violation events are dispatched as tasks. */
const GRACE_MS = 300;
const OTHER_SITE = "another site, an address ending in .invalid that never resolves";

const errorText = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const isPolicyError = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === "SecurityError" || error.name === "NotAllowedError");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`'s value, or `"timeout"` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const directivesOf = (violations: readonly Violation[]): string =>
  [...new Set(violations.map((v) => v.directive))].join(", ");

/** Why the browser refused an attempt, as a sentence; null when it did not show that it did. */
function refusal(observed: Observed): string | null {
  const { attempt, evidence } = observed;
  const violations = [...evidence.violations, ...(attempt.violations ?? [])];
  if (violations.length > 0) return `The page's security policy refused it (${directivesOf(violations)}).`;
  if (evidence.reports > 0) return "The browser reported that it refused the connection.";
  if (attempt.refused) return `${attempt.refused}.`;
  return null;
}

/**
 * Turn the attempts for one vector into a result. `canary` is the attempt
 * against the caller's URL, `other` the one against the `.invalid` site.
 * Vectors tried against the other site only pass that as `canary` and no
 * `other`; `sameOrigin` says whether `canary` was this page's own origin.
 */
export function classify(
  vector: EgressVector,
  canary: Observed,
  other: Observed | null = null,
  sameOrigin = false,
): VectorResult {
  const refused = refusal(canary);
  if (refused) return { vector, outcome: "blocked", enforcedBy: "browser", detail: refused };
  if (canary.attempt.untested) return { vector, outcome: "not-tested", enforcedBy: "none", detail: `${canary.attempt.untested}.` };
  if (canary.attempt.removed) {
    return { vector, outcome: "removed", enforcedBy: "code", detail: `${canary.attempt.note}. ${canary.attempt.removed}.` };
  }
  const head = `${canary.attempt.note}.`;
  if (!other) return { vector, outcome: "allowed", enforcedBy: "code", detail: `${head} No browser policy refused it.` };
  const otherRefused = refusal(other) !== null;
  const where = sameOrigin ? "It reaches this site only" : "It reached the test address";
  const detail = otherRefused
    ? `${head} ${where}: the same request to ${OTHER_SITE}, was refused by the browser.`
    : `${head} No browser policy refused it, nor the same request to ${OTHER_SITE}.`;
  return { vector, outcome: "allowed", enforcedBy: "code", detail };
}

/** The sandbox tokens of the frame holding this document; null when it is
 * not framed, the frame element cannot be read, or it has no sandbox. */
function sandboxTokens(): Set<string> | null {
  if (window.top === window) return null;
  let frame: Element | null = null;
  try {
    frame = window.frameElement;
  } catch {
    frame = null;
  }
  const attr = frame?.getAttribute("sandbox");
  return attr === null || attr === undefined ? null : new Set(attr.split(/\s+/).filter(Boolean));
}

/** True when a script here can reach the window above it: the parent is
 * same-origin and not cut off by a sandbox without allow-same-origin. */
function parentReachable(): boolean {
  try {
    return window.parent !== window && window.parent.location.href !== "";
  } catch {
    return false;
  }
}

/** Navigation is detected, never executed: an attempt that worked would
 * take the visitor off the page. */
function navigationResult(): VectorResult {
  const decided = (outcome: VectorResult["outcome"], enforcedBy: VectorResult["enforcedBy"], detail: string) => ({
    vector: "navigation" as const,
    outcome,
    enforcedBy,
    detail,
  });
  if (window.top === window) {
    return decided("allowed", "code", "This page is open on its own, so a script here could navigate it. Not attempted.");
  }
  if (parentReachable()) {
    return decided(
      "allowed",
      "code",
      "This page shares its origin with the page that holds it, so a script here could navigate the top page through that page. Not attempted.",
    );
  }
  return decided(
    "not-tested",
    "none",
    "The page that holds this one is out of reach, and an attempt that worked would leave the Lab, so it was not attempted.",
  );
}

async function fetchAttempt(url: URL): Promise<Attempt> {
  try {
    const response = await within(
      fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }),
      TIMEOUT_MS,
    );
    return { note: response === "timeout" ? "The request did not finish in time" : "The request completed" };
  } catch (error) {
    if (isPolicyError(error)) return { note: "", refused: `The browser refused it with an error (${errorText(error)})` };
    return { note: `The request failed (${errorText(error)})` };
  }
}

async function xhrAttempt(url: URL): Promise<Attempt> {
  const xhr = new XMLHttpRequest();
  const done = new Promise<string>((resolve) => {
    xhr.onload = () => resolve(`The request completed with status ${xhr.status}`);
    xhr.onerror = () => resolve("The request failed");
  });
  xhr.open("GET", url);
  xhr.send();
  const result = await within(done, TIMEOUT_MS);
  xhr.abort();
  return { note: result === "timeout" ? "The request did not finish in time" : result };
}

async function websocketAttempt(url: URL): Promise<Attempt> {
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl);
  const done = new Promise<string>((resolve) => {
    socket.onopen = () => resolve("The socket opened");
    socket.onerror = () => resolve("The socket failed");
  });
  const result = await within(done, TIMEOUT_MS);
  socket.close();
  return { note: result === "timeout" ? "The socket did not open in time" : result };
}

async function eventSourceAttempt(url: URL): Promise<Attempt> {
  const source = new EventSource(url);
  const done = new Promise<string>((resolve) => {
    source.onopen = () => resolve("The stream opened");
    source.onerror = () => resolve("The stream failed");
  });
  const result = await within(done, TIMEOUT_MS);
  source.close();
  return { note: result === "timeout" ? "The stream did not open in time" : result };
}

async function beaconAttempt(url: URL): Promise<Attempt> {
  const queued = navigator.sendBeacon(url, "wolf-lab-egress-probe");
  // A refusal to queue is not a policy finding by itself; a violation is.
  return { note: queued ? "The browser queued the beacon" : "The browser did not queue the beacon" };
}

async function imageAttempt(url: URL): Promise<Attempt> {
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  const done = new Promise<string>((resolve) => {
    image.onload = () => resolve("The image loaded");
    image.onerror = () => resolve("The image request failed");
  });
  image.src = url.href;
  const result = await within(done, TIMEOUT_MS);
  image.removeAttribute("src");
  return { note: result === "timeout" ? "The image did not load in time" : result };
}

/** How long a form attempt waits for the hidden frame: its own document, the control, a response. */
const FORM_WAIT_MS = 1200;
/** The fragment of the control navigation; same-document, so nothing is requested. */
const CONTROL_FRAGMENT = "wolf-lab-navigation-control";

/** What the page saw of one form submission. */
export type FormObservation = {
  /** The form's submit event fired. */
  submitted: boolean;
  /** The hidden target frame loaded a response. */
  loaded: boolean;
  /** Whether the browser started a navigation of the target frame (its
   * `navigate` event fired); null when this browser gives the page no
   * working navigate event to watch. */
  navigationStarted: boolean | null;
  /** Sandbox tokens of the frame holding this page; null when not sandboxed or unreadable. */
  sandbox: ReadonlySet<string> | null;
};

/**
 * The form attempt's result from what the page saw. A browser sends a form
 * only by navigating its target, and fires the target's `navigate` event
 * before any request (HTML, "navigate", for a same-origin target document
 * that is not the initial about:blank). So with a working navigate event:
 * no event means nothing was sent.
 */
export function formOutcome({ submitted, loaded, navigationStarted, sandbox }: FormObservation): Attempt {
  const formsBlocked = sandbox !== null && !sandbox.has("allow-forms");
  if (!submitted) {
    if (formsBlocked) {
      return { note: "", refused: "The browser dropped the form before sending it, as the sandbox of this page's frame requires" };
    }
    return { note: "The form was not submitted, and the browser gave no reason" };
  }
  if (loaded) return { note: "The form was submitted and the hidden frame loaded a response" };
  if (navigationStarted === null) {
    return {
      note: "The form's submit event fired and nothing loaded. This browser gives the page no way to see whether the form was sent",
    };
  }
  if (navigationStarted) return { note: "The browser started sending the form, and nothing loaded in time" };
  if (formsBlocked) {
    return {
      note: "",
      refused:
        "The browser fired the form's submit event but never started sending the form, as the sandbox of this page's frame requires",
    };
  }
  return { note: "The form's submit event fired, but the browser never started sending it and gave no reason" };
}

export type NavigationWatch = { started(): boolean };

/**
 * Watch the target frame's `navigate` event (Navigation API). The frame
 * holds a srcdoc document, so it is same-origin and not the initial
 * about:blank, the two conditions for the event. A control navigation, a
 * same-document fragment replace that requests nothing and adds no history
 * entry, must fire the event first; otherwise null, and the form result
 * claims nothing from the event's absence.
 */
export async function navigationWatch(frame: HTMLIFrameElement, ready: Promise<unknown>): Promise<NavigationWatch | null> {
  if ((await within(ready, FORM_WAIT_MS)) === "timeout") return null;
  let win: Window | null;
  try {
    win = frame.contentWindow;
    if (!win || win.location.href !== "about:srcdoc") return null;
  } catch {
    return null;
  }
  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  if (!navigation) return null;
  let control = false;
  let started = false;
  navigation.addEventListener("navigate", (event) => {
    const destination = (event as Event & { destination?: { url?: string } }).destination?.url ?? "";
    if (destination.endsWith(`#${CONTROL_FRAGMENT}`)) control = true;
    else started = true;
  });
  try {
    win.location.replace(`#${CONTROL_FRAGMENT}`);
  } catch {
    return null;
  }
  await sleep(0);
  return control ? { started: () => started } : null;
}

async function formAttempt(url: URL, name: string): Promise<Attempt> {
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  frame.srcdoc = "<!doctype html><title>Wolf Lab form probe</title>";
  const form = document.createElement("form");
  form.method = "post";
  form.action = url.href;
  form.target = name;
  form.hidden = true;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "probe";
  field.value = "form";
  form.append(field);
  const own = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  document.body.append(frame, form);
  try {
    const watch = await navigationWatch(frame, own);
    let submitted = false;
    form.addEventListener("submit", () => (submitted = true));
    // Attached after the frame's own document loaded, so only a response counts.
    const response = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
    // requestSubmit runs the submission steps a click would, submit event
    // included; a sandbox without allow-forms ends them before that event in
    // Chromium and Firefox, and after it in WebKit.
    form.requestSubmit();
    const loaded = submitted && (await within(response, FORM_WAIT_MS)) !== "timeout";
    return formOutcome({
      submitted,
      loaded,
      navigationStarted: watch ? watch.started() : null,
      sandbox: sandboxTokens(),
    });
  } finally {
    form.remove();
    frame.remove();
  }
}

/** A `<link rel>` request or hint. Only prefetch fires load and error events. */
async function linkAttempt(url: URL, rel: "prefetch" | "preconnect" | "dns-prefetch"): Promise<Attempt> {
  const link = document.createElement("link");
  if (!link.relList.supports(rel)) return { note: "", untested: `This browser does not support ${rel} links` };
  link.rel = rel;
  link.href = rel === "prefetch" ? url.href : url.origin;
  if (rel !== "prefetch") {
    document.head.append(link);
    await sleep(GRACE_MS);
    link.remove();
    const what = rel === "preconnect" ? "open a connection to" : "look up";
    return { note: `The page asked the browser to ${what} ${OTHER_SITE}. This test cannot see whether it did` };
  }
  const done = new Promise<string>((resolve) => {
    link.onload = () => resolve("The prefetch completed");
    link.onerror = () => resolve("The prefetch failed");
  });
  document.head.append(link);
  const result = await within(done, TIMEOUT_MS);
  link.remove();
  return { note: result === "timeout" ? "The prefetch did not finish in time" : result };
}

/**
 * Create a peer connection with no ICE servers, ask it for an offer, close
 * it. The offer is never set, so no candidates are gathered and nothing is
 * sent. Uses the browser's own constructor even when the page removed it.
 */
export async function webrtcAttempt(): Promise<Attempt> {
  const removed = webRtcRemoved().includes("RTCPeerConnection");
  const PeerConnection = originalPeerConnection() ?? (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!PeerConnection) return { note: "", untested: "This browser offers no peer connections on this page" };
  let pc: RTCPeerConnection;
  try {
    pc = new PeerConnection();
  } catch (error) {
    if (isPolicyError(error)) return { note: "", refused: `The browser refused to create a peer connection (${errorText(error)})` };
    return { note: "", untested: `A peer connection could not be created (${errorText(error)})` };
  }
  try {
    pc.createDataChannel("wolf-lab-egress-probe");
    await pc.createOffer();
  } catch (error) {
    if (isPolicyError(error)) return { note: "", refused: `The browser refused to set up a peer connection (${errorText(error)})` };
    return { note: "", untested: `A peer connection could not make an offer (${errorText(error)})` };
  } finally {
    pc.close();
  }
  const note =
    "The browser let this page create a peer connection and make a connection offer. The probe named no server and started no connection, so nothing was sent";
  if (!removed) return { note };
  return {
    note,
    removed:
      "The page removed the peer connection API before its other scripts ran, so they cannot use it. A script that creates a new frame can still reach it",
  };
}

/** Reply of `probe-worker.ts`. */
export type WorkerProbeReply = { note: string; refused?: string; violations: Violation[] };

async function workerFetchAttempt(url: URL): Promise<Attempt> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./probe-worker.ts", import.meta.url), { type: "module", name: "wolf-lab-egress-probe" });
  } catch (error) {
    return { note: "", untested: `The test worker could not start (${errorText(error)})` };
  }
  const reply = new Promise<Attempt>((resolve) => {
    worker.onmessage = (event: MessageEvent<WorkerProbeReply>) => resolve(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      resolve({ note: "", untested: `The test worker failed (${event.message || "no message"})` });
    };
  });
  post(worker, { url: url.href });
  const result = await within(reply, LONG_TIMEOUT_MS);
  worker.terminate();
  return result === "timeout" ? { note: "", untested: "The test worker did not answer in time" } : result;
}

/** `base` tagged with the vector and run id, so the server can attribute a hit. */
export function tagged(base: URL, vector: EgressVector, nonce: string): URL {
  const url = new URL(base);
  url.searchParams.set("vector", vector);
  url.searchParams.set("probe", nonce);
  return url;
}

/** The never-resolving other site for one vector of one run. */
export function otherSite(vector: EgressVector, nonce: string): URL {
  return tagged(new URL(`https://wolf-lab-${vector}-${nonce}.invalid/canary`), vector, nonce);
}

/**
 * Whether a violation's blockedURI or a report body is about `target`. The
 * canary is matched on its full tagged URL in any scheme (a socket reports
 * ws:), so a late event from another vector is never attributed to it. A
 * cross-origin URL may be cut down to its origin, so with `viaHost` the host
 * decides; the other site's host is unique to its vector and run.
 */
export function matcher(target: URL, viaHost: boolean): (uri: string) => boolean {
  if (viaHost) return (uri) => uri.includes(target.hostname);
  const rest = target.href.slice(target.protocol.length);
  return (uri) => uri.includes(rest);
}

type Recorder = {
  /** Run one attempt and gather the evidence that `match` says is about it.
   * Violations of `directive` count whatever URL they name. */
  observe(match: (uri: string) => boolean, run: () => Promise<Attempt>, directive?: string): Promise<Observed>;
  stop(): void;
};

function recorder(): Recorder {
  const violations: Violation[] = [];
  const onViolation = (event: SecurityPolicyViolationEvent) =>
    violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
  document.addEventListener("securitypolicyviolation", onViolation);
  // Only connection-allowlist reports: CSP reports duplicate the event above.
  const reports: string[] = [];
  const take = (batch: readonly Report[]) => {
    for (const report of batch) if (report.type === "connection-allowlist") reports.push(JSON.stringify(report.body ?? {}));
  };
  const observer = typeof ReportingObserver === "undefined" ? null : new ReportingObserver((batch) => take(batch));
  observer?.observe();
  return {
    async observe(match, run, directive) {
      const relevant = (v: Violation) => v.directive === directive || match(v.blockedURI);
      const seen = violations.length;
      const reported = reports.length;
      let attempt: Attempt;
      try {
        attempt = await run();
      } catch (error) {
        attempt = isPolicyError(error)
          ? { note: "", refused: `The browser refused it with an error (${errorText(error)})` }
          : { note: `The attempt failed (${errorText(error)})` };
      }
      await sleep(GRACE_MS);
      take(observer?.takeRecords() ?? []);
      const evidence: Evidence = {
        violations: violations.slice(seen).filter(relevant),
        reports: reports.slice(reported).filter(match).length,
      };
      return { attempt: { ...attempt, violations: (attempt.violations ?? []).filter(relevant) }, evidence };
    },
    stop() {
      document.removeEventListener("securitypolicyviolation", onViolation);
      observer?.disconnect();
    },
  };
}

export const probeEgress: ProbeEgress = async (canaryUrl) => {
  const canary = new URL(canaryUrl, window.location.href);
  const sameOrigin = canary.origin === window.location.origin;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const requests: Partial<Record<EgressVector, (target: URL, label: string) => Promise<Attempt>>> = {
    fetch: fetchAttempt,
    xhr: xhrAttempt,
    websocket: websocketAttempt,
    eventsource: eventSourceAttempt,
    beacon: beaconAttempt,
    image: imageAttempt,
    form: (target, label) => formAttempt(target, `wolf-lab-egress-${label}`),
    prefetch: (target) => linkAttempt(target, "prefetch"),
    "worker-fetch": workerFetchAttempt,
  };

  const record = recorder();
  const results: VectorResult[] = [];
  try {
    for (const vector of VECTORS) {
      if (vector === "navigation") {
        results.push(navigationResult());
        continue;
      }
      if (vector === "preconnect" || vector === "dns-prefetch") {
        const target = otherSite(vector, nonce);
        results.push(classify(vector, await record.observe(matcher(target, true), () => linkAttempt(target, vector))));
        continue;
      }
      if (vector === "webrtc") {
        // Nothing is requested, so only a `webrtc` violation can name it.
        results.push(classify(vector, await record.observe(() => false, webrtcAttempt, "webrtc")));
        continue;
      }
      const attempt = requests[vector]!;
      const canaryTarget = tagged(canary, vector, nonce);
      const other = otherSite(vector, nonce);
      const atCanary = await record.observe(matcher(canaryTarget, !sameOrigin), () => attempt(canaryTarget, `${nonce}-a`));
      const atOther = await record.observe(matcher(other, true), () => attempt(other, `${nonce}-b`));
      results.push(classify(vector, atCanary, atOther, sameOrigin));
    }
  } finally {
    record.stop();
  }
  return results;
};
