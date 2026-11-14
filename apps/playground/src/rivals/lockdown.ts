/// Closes the worker global scope before any untrusted Python runs. Pyodide exposes
/// the whole JavaScript global to Python (`from js import ...`), so every capability
/// the run does not need is removed here, from the object and from its prototype chain.

/**
 * Names removed after Pyodide and the wheels have loaded. A dotted name is a property of
 * the object before the dot (`navigator.storage` is `globalThis.navigator.storage`).
 *
 * - Storage and a way to start code: `caches`, `indexedDB`, `Worker`, `SharedWorker`,
 *   `importScripts`, `navigator.serviceWorker`, `navigator.storage`.
 * - Ways out of the worker: `fetch` (nothing after boot reads through it, and the replacement
 *   installed at boot only answers asset URLs), `Request`, `Response` (the only way to build a cache entry or
 *   a fetch reply), `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`,
 *   `RTCPeerConnection`, `RTCDataChannel`, `BroadcastChannel`, `navigator.sendBeacon`.
 *
 * `postMessage` and `onmessage` stay: they are how the worker answers the page.
 */
export const LOCKDOWN_NAMES: readonly string[] = [
  "caches",
  "indexedDB",
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "importScripts",
  "navigator.serviceWorker",
  "navigator.storage",
  "navigator.sendBeacon",
  "fetch",
  "Request",
  "Response",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "WebTransport",
  "RTCPeerConnection",
  "RTCDataChannel",
];

export type LockdownReport = {
  /** Present before the lockdown and unreachable after it. */
  removed: string[];
  /** Not present in this engine to begin with. */
  absent: string[];
  /** Still reachable after every attempt. A caller must refuse to run when this is not empty. */
  blocked: string[];
};

const refused = (name: string) => () => {
  throw new TypeError(`${name} is closed in the rivals worker`);
};

/** `value` is unreachable when it is not `in` the object, or when reading it throws. */
function unreachable(holder: object, key: string): boolean {
  if (!(key in holder)) return true;
  try {
    (holder as Record<string, unknown>)[key];
    return false;
  } catch {
    return true;
  }
}

/** Remove one own property: delete it, or replace it with a getter and setter that throw. */
function dropOwn(holder: object, key: string): void {
  if (Reflect.deleteProperty(holder, key) && !Object.hasOwn(holder, key)) return;
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (descriptor && descriptor.configurable === false) return; // cannot be changed; the caller's check reports it
  Object.defineProperty(holder, key, { configurable: true, enumerable: false, get: refused(key), set: refused(key) });
}

function closeProperty(owner: object, key: string): boolean {
  for (let holder: object | null = owner; holder; holder = Object.getPrototypeOf(holder) as object | null) {
    if (Object.hasOwn(holder, key)) dropOwn(holder, key);
  }
  return unreachable(owner, key);
}

/** Apply `names` to `scope`. Never throws; the report says what is left. */
export function lockdown(scope: object, names: readonly string[] = LOCKDOWN_NAMES): LockdownReport {
  const report: LockdownReport = { removed: [], absent: [], blocked: [] };
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    let owner: unknown = scope;
    if (dot !== -1) {
      for (const part of name.slice(0, dot).split(".")) {
        owner = owner && (typeof owner === "object" || typeof owner === "function") ? (owner as Record<string, unknown>)[part] : undefined;
      }
    }
    const key = name.slice(dot + 1);
    if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
      report.absent.push(name);
      continue;
    }
    const existed = key in owner;
    if (!closeProperty(owner, key)) report.blocked.push(name);
    else (existed ? report.removed : report.absent).push(name);
  }
  return report;
}

/** Throws when anything is still reachable: the worker must not run untrusted Python. */
export function lockdownOrThrow(scope: object, names: readonly string[] = LOCKDOWN_NAMES): LockdownReport {
  const report = lockdown(scope, names);
  if (report.blocked.length > 0) {
    throw new Error(`the worker could not close ${report.blocked.join(", ")}, so it will not run Python`);
  }
  return report;
}
