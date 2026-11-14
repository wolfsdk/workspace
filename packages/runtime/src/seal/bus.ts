/**
 * The asset bus between the loader (network, no visitor file) and the vault
 * (visitor file, no network). Free of DOM wiring so both ends are testable:
 * `loader.ts` and `vault.ts` connect these to `window` messages.
 *
 * Protocol, all over `window.postMessage` (always through `post` in
 * `post.ts`, never a direct call; see the WebKit note there) with the page's
 * own origin as the target origin:
 *
 *   loader -> vault  { type: "wolf-lab-manifest", manifest, policyHeaders }  after each vault load
 *   vault  -> loader { type: "get", id }                             id: sha256 hex in the manifest
 *   loader -> vault  { type: "wolf-lab-asset", id, bytes }           bytes: transferred ArrayBuffer
 *   loader -> vault  { type: "wolf-lab-asset-error", id, error }     listed id that could not be served
 *
 * The loader accepts nothing but `get`, only from the vault frame's window,
 * only from its own origin, only for ids the manifest lists. Anything else is
 * dropped without an answer.
 *
 * `policyHeaders` are the vault policy headers the loader observed on a
 * fresh response for the vault page (lowercase names, only names the policy
 * defines). The vault cannot read its own response headers, so this is what
 * the UI reports as the policy in force.
 */
import type { AssetRef, LabAssets, LabManifest } from "./types.ts";

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const MSG_MANIFEST = "wolf-lab-manifest";
export const MSG_ASSET = "wolf-lab-asset";
export const MSG_ASSET_ERROR = "wolf-lab-asset-error";

export type GetRequest = { type: "get"; id: string };
export type ManifestMessage = { type: typeof MSG_MANIFEST; manifest: LabManifest; policyHeaders: Record<string, string> };
export type AssetReply =
  | { type: typeof MSG_ASSET; id: string; bytes: ArrayBuffer }
  | { type: typeof MSG_ASSET_ERROR; id: string; error: string };

/** What a `message` event carries, without the DOM type. */
export type BusEvent = { data: unknown; origin: string; source: unknown };

export type RejectReason = "origin" | "source" | "shape" | "unlisted";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The id of a well-formed `get` request, or null. Exactly two own keys,
 * `type === "get"`, lowercase 64-hex id. Nothing else passes. */
export function parseGetRequest(data: unknown): string | null {
  if (!isRecord(data) || Object.getPrototypeOf(data) !== Object.prototype) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("id")) return null;
  if (data.type !== "get" || typeof data.id !== "string" || !SHA256_HEX.test(data.id)) return null;
  return data.id;
}

function isRef(value: unknown): value is AssetRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    SHA256_HEX.test(value.id) &&
    typeof value.path === "string" &&
    typeof value.bytes === "number" &&
    typeof value.type === "string"
  );
}

/** Checks the manifest's shape and that every asset it names is listed in
 * `assets`, the bus allowlist. Throws with the first problem. */
export function checkManifest(value: unknown): LabManifest {
  if (!isRecord(value) || value.schema !== "wolf-lab-manifest.v1") throw new Error("manifest has the wrong schema");
  if (!Array.isArray(value.assets) || !value.assets.every(isRef)) throw new Error("manifest assets are malformed");
  if (!Array.isArray(value.scenarios)) throw new Error("manifest scenarios are malformed");
  const manifest = value as LabManifest;
  const listed = new Set(manifest.assets.map((ref) => ref.id));
  const named: [string, unknown][] = [
    ["capabilities", manifest.capabilities],
    ["claims", manifest.claims],
    ["rivalTruth", manifest.rivalTruth],
  ];
  if (manifest.engine) named.push(["engine.module", manifest.engine.module]);
  for (const scenario of manifest.scenarios) {
    named.push([`scenario ${scenario.id} file`, scenario.file], [`scenario ${scenario.id} tape`, scenario.tape]);
  }
  for (const [what, ref] of named) {
    if (!isRef(ref)) throw new Error(`manifest ${what} is malformed`);
    if (!listed.has(ref.id)) throw new Error(`manifest ${what} is not in the asset list`);
  }
  return manifest;
}

export type AssetServerOptions = {
  manifest: LabManifest;
  /** The loader's own origin; the vault is same-origin. */
  origin: string;
  /** The vault frame's window (read on every message: the frame may reload). */
  vault: () => unknown;
  /** Fetch the bytes of a listed asset. */
  load: (ref: AssetRef) => Promise<ArrayBuffer>;
  /** Lowercase hex sha256. */
  digest: (bytes: ArrayBuffer) => Promise<string>;
  onReject?: (reason: RejectReason, event: BusEvent) => void;
};

export type Answer = { message: AssetReply; transfer: ArrayBuffer[] };

export type AssetServer = {
  /** The answer to send back to `event.source`, or null for a rejected message. */
  handle(event: BusEvent): Promise<Answer | null>;
};

export function createAssetServer(options: AssetServerOptions): AssetServer {
  const listed = new Map(options.manifest.assets.map((ref) => [ref.id, ref]));
  const reject = (reason: RejectReason, event: BusEvent): null => {
    options.onReject?.(reason, event);
    return null;
  };
  return {
    async handle(event) {
      if (event.origin !== options.origin) return reject("origin", event);
      const vault = options.vault();
      if (vault == null || event.source !== vault) return reject("source", event);
      const id = parseGetRequest(event.data);
      if (id === null) return reject("shape", event);
      const ref = listed.get(id);
      if (!ref) return reject("unlisted", event);
      try {
        const bytes = await options.load(ref);
        if (bytes.byteLength !== ref.bytes) throw new Error(`size ${bytes.byteLength} differs from the manifest`);
        if ((await options.digest(bytes)) !== id) throw new Error("sha256 differs from the manifest");
        return { message: { type: MSG_ASSET, id, bytes }, transfer: [bytes] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { message: { type: MSG_ASSET_ERROR, id, error: `${ref.path}: ${reason}` }, transfer: [] };
      }
    },
  };
}

/** A plain object of string values whose names are all in `allowed`. */
function isHeaderRecord(value: unknown, allowed: ReadonlySet<string>): value is Record<string, string> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([name, text]) => allowed.has(name) && typeof text === "string");
}

/** Parse a loader -> vault message; null when it is not one. A manifest
 * message has exactly `type`, `manifest` and `policyHeaders`, with header
 * names from `policyHeaderNames` (lowercase). */
export function parseLoaderMessage(
  data: unknown,
  policyHeaderNames: ReadonlySet<string> = new Set(),
): ManifestMessage | AssetReply | null {
  if (!isRecord(data)) return null;
  if (data.type === MSG_MANIFEST) {
    const keys = Object.keys(data);
    const exact = keys.length === 3 && ["type", "manifest", "policyHeaders"].every((key) => keys.includes(key));
    return exact && isRecord(data.manifest) && isHeaderRecord(data.policyHeaders, policyHeaderNames)
      ? (data as ManifestMessage)
      : null;
  }
  if (typeof data.id !== "string" || !SHA256_HEX.test(data.id)) return null;
  if (data.type === MSG_ASSET && data.bytes instanceof ArrayBuffer) return data as AssetReply;
  if (data.type === MSG_ASSET_ERROR && typeof data.error === "string") return data as AssetReply;
  return null;
}

/** Assets at or under this size are kept in the vault after the first read. */
export const VAULT_CACHE_MAX_BYTES = 1 << 20;

export type AssetClient = LabAssets & {
  /** Feed a loader reply in. */
  receive(reply: AssetReply): void;
};

/**
 * Vault side. `get` refuses ids and paths the manifest does not list before
 * anything is sent, shares one request per id, and hands every caller its
 * own copy (callers may transfer or detach what they get).
 */
export function createAssetClient(manifest: LabManifest, send: (request: GetRequest) => void): AssetClient {
  const byId = new Map(manifest.assets.map((ref) => [ref.id, ref]));
  const byPath = new Map(manifest.assets.map((ref) => [ref.path, ref]));
  const pending = new Map<string, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
  const inflight = new Map<string, Promise<ArrayBuffer>>();
  const cache = new Map<string, ArrayBuffer>();

  const fetchOnce = (ref: AssetRef): Promise<ArrayBuffer> => {
    const hit = cache.get(ref.id);
    if (hit) return Promise.resolve(hit);
    let request = inflight.get(ref.id);
    if (!request) {
      const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();
      pending.set(ref.id, { resolve, reject });
      request = promise.finally(() => inflight.delete(ref.id));
      inflight.set(ref.id, request);
      send({ type: "get", id: ref.id });
    }
    return request;
  };

  return {
    async get(ref) {
      const id = typeof ref === "string" ? ref : ref.id;
      const listed = byId.get(id);
      if (!listed) throw new Error(`asset not in manifest: ${id}`);
      const bytes = await fetchOnce(listed);
      if (bytes.byteLength <= VAULT_CACHE_MAX_BYTES) cache.set(id, bytes);
      return new Uint8Array(bytes.slice(0));
    },
    resolve(path) {
      return byPath.get(path);
    },
    manifest() {
      return manifest;
    },
    receive(reply) {
      const waiter = pending.get(reply.id);
      if (!waiter) return;
      pending.delete(reply.id);
      if (reply.type === MSG_ASSET) waiter.resolve(reply.bytes);
      else waiter.reject(new Error(`asset could not be loaded: ${reply.error}`));
    },
  };
}
