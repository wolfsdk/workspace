import type { AssetRef } from "../lab/index.ts";

/** Every URL the rivals worker may fetch starts with this scheme. */
export const ASSET_SCHEME = "wolf-asset://";

const HEX64 = /^[0-9a-f]{64}$/;

/** `wolf-asset://<logical path or sha256 id>`. */
export function assetUrl(pathOrId: string): string {
  return `${ASSET_SCHEME}${pathOrId}`;
}

function urlText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object" && "url" in input && typeof input.url === "string") return input.url;
  return null;
}

/**
 * The asset target named by a fetch input, or `null` when the input is not an
 * asset URL. Accepts the three shapes `fetch` takes.
 */
export function assetTarget(input: unknown): string | null {
  const text = urlText(input);
  if (text === null || !text.startsWith(ASSET_SCHEME)) return null;
  const rest = text.slice(ASSET_SCHEME.length).replace(/[?#].*$/, "");
  if (rest === "") return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

export type AssetFetchOptions = {
  /** Logical path or id to an asset, or `undefined` when no such asset is listed. */
  lookup: (target: string) => AssetRef | undefined;
  load: (ref: AssetRef) => Promise<Uint8Array<ArrayBuffer>>;
  /**
   * Exact URLs (query and fragment ignored) answered with an asset target as if the
   * target's asset URL had been requested. Pyodide fetches its wasm at a fixed URL
   * beside its script; this serves that one URL from bytes instead of the network.
   */
  aliases?: ReadonlyMap<string, string>;
};

/**
 * A `fetch` that serves only asset-bus files. Any other URL rejects with a
 * `TypeError`, as a network failure would; nothing leaves the worker.
 */
export function createAssetFetch(options: AssetFetchOptions): typeof fetch {
  const shim = async (input: unknown): Promise<Response> => {
    const text = urlText(input);
    const target = assetTarget(input) ?? (text === null ? undefined : options.aliases?.get(text.replace(/[?#].*$/, ""))) ?? null;
    if (target === null) {
      const shown = text ?? String(input);
      throw new TypeError(`fetch blocked: the rivals worker only reads ${ASSET_SCHEME} URLs (got ${shown.slice(0, 120)})`);
    }
    const ref = options.lookup(target);
    if (!ref) return new Response(`no asset named ${target}`, { status: 404, statusText: "Not Found" });
    const bytes = await options.load(ref);
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": ref.type, "content-length": String(bytes.byteLength) },
    });
  };
  return shim as unknown as typeof fetch;
}

/** Lookup over an `AssetRef` list: a 64-hex target is an id, anything else is a logical path. */
export function lookupIn(refs: readonly AssetRef[]): (target: string) => AssetRef | undefined {
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const byPath = new Map(refs.map((ref) => [ref.path, ref]));
  return (target) => (HEX64.test(target) ? byId.get(target) : byPath.get(target));
}
