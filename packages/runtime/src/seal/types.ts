/**
 * The types the seal kit shares with a sealed page: the content-addressed
 * build manifest the loader serves to the vault, and the egress probe result.
 */

/** Which engine build a sealed page serves. */
export type EngineIdentity = {
  /** The module's own `version` output. */
  version: string;
  /** Source commit the module was built from. */
  commit: string;
  /** Lowercase hex sha256 of the `.wasm` file. */
  moduleSha256: string;
  moduleBytes: number;
  /** ISO 8601. */
  builtAt: string;
};

/** A file of the build, addressed by content. `id` is its lowercase hex
 * sha256 and the only thing the asset bus accepts. `path` is a logical name
 * (`engine/wolf_web.wasm`, `rivals/pyodide/pyodide.asm.wasm`,
 * `scenarios/contract-redline/page-1-step-3.png`), unique within a manifest. */
export type AssetRef = { id: string; path: string; bytes: number; type: string };

/** A scenario the manifest names: the document it opens and its recording.
 * Other fields belong to the page and pass through the bus unchanged. */
export type ManifestScenario = { id: string; file: AssetRef; tape: AssetRef; [field: string]: unknown };

export type LabManifest = {
  schema: "wolf-lab-manifest.v1";
  /** Build id (content hash of the asset list and the script list). */
  build: string;
  engine: { identity: EngineIdentity; module: AssetRef } | null;
  scenarios: ManifestScenario[];
  capabilities: AssetRef;
  claims: AssetRef;
  rivalTruth: AssetRef;
  /** Every asset the bus may serve, including the ones named above. */
  assets: AssetRef[];
  /** Scripts the vault loads by path (`rivals/<version>/<file>`), not through
   * the bus. Listed so the offline worker can check each against its sha256. */
  scripts?: { path: string; sha256: string; bytes: number }[];
};

/** Read-only access to build assets from inside the vault. The vault has no
 * network: this is the only way bytes other than the visitor's file get in.
 * Rejects for an id or path the manifest does not list. */
export interface LabAssets {
  get(ref: AssetRef | string): Promise<Uint8Array<ArrayBuffer>>;
  /** Look up by logical path. */
  resolve(path: string): AssetRef | undefined;
  manifest(): LabManifest;
}

export type EgressVector =
  | "fetch"
  | "xhr"
  | "websocket"
  | "eventsource"
  | "beacon"
  | "image"
  | "form"
  | "prefetch"
  | "navigation"
  | "webrtc"
  | "preconnect"
  | "dns-prefetch"
  | "worker-fetch";

export type VectorResult = {
  vector: EgressVector;
  /** `removed`: the page deleted the API before its own scripts ran, but the
   * browser would allow it. Weaker than `blocked` and never counted as blocked. */
  outcome: "blocked" | "allowed" | "removed" | "not-tested";
  /** `browser`: blocked by policy the browser enforces. `code`: the page does
   * not attempt it, or removed the API (`removed`), but nothing stops it. */
  enforcedBy: "browser" | "code" | "none";
  detail?: string;
};

export type ProbeEgress = (canaryUrl: string) => Promise<VectorResult[]>;

/** Which response a header set is for. */
export type HeaderTarget = "loader" | "vault" | "script" | "asset";
