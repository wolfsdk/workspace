import { describe, expect, test } from "bun:test";
import { lockdown, lockdownOrThrow, LOCKDOWN_NAMES } from "../src/rivals/lockdown.ts";

const keep = ["postMessage", "onmessage"];

/** A global whose names live in different places, as they do in browsers. */
function fakeScope() {
  const navigatorProto = {} as Record<string, unknown>;
  Object.defineProperty(navigatorProto, "storage", { configurable: true, get: () => ({ estimate: 1 }) });
  navigatorProto.sendBeacon = () => true;
  const navigator = Object.create(navigatorProto) as object;
  const scopeProto = { Worker: class {}, SharedWorker: class {} } as Record<string, unknown>;
  Object.defineProperty(scopeProto, "indexedDB", { configurable: true, get: () => ({}) });
  const scope = Object.create(scopeProto) as Record<string, unknown>;
  Object.assign(scope, {
    caches: {},
    BroadcastChannel: class {},
    importScripts: () => {},
    fetch: () => {},
    Request: class {},
    Response: class {},
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    RTCPeerConnection: class {},
    postMessage: () => {},
    onmessage: null,
    navigator,
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
  return { scope, navigator: navigator as Record<string, unknown> };
}

describe("lockdown", () => {
  test("names the capabilities that start code, store data, or leave the worker", () => {
    for (const name of ["caches", "Worker", "SharedWorker", "BroadcastChannel", "indexedDB", "importScripts", "navigator.serviceWorker", "navigator.storage", "navigator.sendBeacon", "WebTransport", "RTCPeerConnection", "RTCDataChannel", "XMLHttpRequest", "WebSocket", "EventSource", "Response"]) {
      expect(LOCKDOWN_NAMES).toContain(name);
    }
    for (const name of keep) expect(LOCKDOWN_NAMES).not.toContain(name);
  });

  test("makes every listed name unreachable, on the object and on its prototype chain", () => {
    const { scope, navigator } = fakeScope();
    const report = lockdown(scope);
    expect(report.blocked).toEqual([]);
    for (const name of LOCKDOWN_NAMES) {
      const owner = name.startsWith("navigator.") ? navigator : scope;
      const key = name.slice(name.lastIndexOf(".") + 1);
      const reachable = (() => {
        if (!(key in owner)) return false;
        try {
          owner[key];
          return true;
        } catch {
          return false;
        }
      })();
      expect(reachable, name).toBe(false);
    }
    expect(report.removed).toEqual(expect.arrayContaining(["caches", "Worker", "indexedDB", "navigator.storage", "navigator.sendBeacon", "RTCPeerConnection"]));
    expect(report.absent).toEqual(expect.arrayContaining(["WebTransport", "RTCDataChannel"]));
  });

  test("keeps what the worker needs to answer the page", () => {
    const { scope } = fakeScope();
    lockdown(scope);
    expect(typeof scope.postMessage).toBe("function");
    expect("onmessage" in scope).toBe(true);
  });

  test("replaces a property that cannot be deleted with a getter that throws", () => {
    const scope = {} as Record<string, unknown>;
    Object.defineProperty(scope, "caches", { configurable: true, value: {} });
    // A Proxy that refuses delete stands in for an engine that does.
    const refusing = new Proxy(scope, { deleteProperty: () => false });
    const report = lockdown(refusing, ["caches"]);
    expect(report).toEqual({ removed: ["caches"], absent: [], blocked: [] });
    expect(() => refusing.caches).toThrow(/closed in the rivals worker/);
  });

  test("reports a non-configurable property as blocked, and lockdownOrThrow refuses to continue", () => {
    const scope = {} as Record<string, unknown>;
    Object.defineProperty(scope, "caches", { configurable: false, value: {} });
    expect(lockdown(scope, ["caches"]).blocked).toEqual(["caches"]);
    expect(() => lockdownOrThrow(scope, ["caches"])).toThrow(/caches/);
  });

  test("treats a name on a missing owner as absent", () => {
    const report = lockdown({}, ["navigator.storage"]);
    expect(report).toEqual({ removed: [], absent: ["navigator.storage"], blocked: [] });
  });
});
