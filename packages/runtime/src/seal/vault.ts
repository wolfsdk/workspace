/**
 * Vault side: the `/lab/vault/` document. It holds the visitor's file and has
 * no network; every build asset arrives over the bus from the loader.
 *
 * Assets arrive as bytes. The engine module is compiled inside the vault's
 * own worker from a `blob:` URL (the vault policy allows `blob:` in
 * `connect-src` and `'wasm-unsafe-eval'`), so no compiled
 * `WebAssembly.Module` crosses the bus: `LabAssets` and the reactor client
 * both take bytes or a URL.
 *
 * The loader's announcement also carries the vault policy headers it
 * observed on the vault page's response; `vaultPolicyHeaders` returns them.
 */
import type { LabAssets } from "./types.ts";
import {
  type AssetClient,
  MSG_ASSET,
  MSG_ASSET_ERROR,
  MSG_MANIFEST,
  checkManifest,
  createAssetClient,
  parseLoaderMessage,
} from "./bus.ts";
import { POLICY_HEADER_NAMES } from "./policy.ts";
import { post } from "./post.ts";

const HEADER_NAMES: ReadonlySet<string> = new Set(POLICY_HEADER_NAMES.map((name) => name.toLowerCase()));
let observed: Record<string, string> = {};

/** The vault policy headers the loader observed, by lowercase name. Empty
 * until `createVaultAssets` resolves, and when the loader saw none. */
export function vaultPolicyHeaders(): Record<string, string> {
  return { ...observed };
}

/** Connect to the loader's asset bus. Resolves with the manifest's assets
 * once the loader announces it. */
export function createVaultAssets(): Promise<LabAssets> {
  const parent = window.parent;
  if (parent === window) {
    return Promise.reject(new Error("this page works only inside the Lab; open the Lab page instead"));
  }
  const origin = window.location.origin;
  const { promise, resolve, reject } = Promise.withResolvers<LabAssets>();
  let client: AssetClient | null = null;

  // Registered synchronously, so it is in place before the loader's first
  // announcement (sent on the frame's load event, after module scripts ran).
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== origin) return;
    const msg = parseLoaderMessage(event.data, HEADER_NAMES);
    if (!msg) return;
    if (msg.type === MSG_MANIFEST) {
      if (client) return; // A repeat announcement after a loader-side reload changes nothing.
      try {
        const manifest = checkManifest(msg.manifest);
        client = createAssetClient(manifest, (request) => post(parent, request, { targetOrigin: origin }));
        observed = { ...msg.policyHeaders };
        resolve(client);
      } catch (error) {
        reject(error);
      }
      return;
    }
    if (msg.type === MSG_ASSET || msg.type === MSG_ASSET_ERROR) client?.receive(msg);
  });
  return promise;
}
