/**
 * Response headers for every sealed-page response. The single source of truth
 * for the dev and preview server, the production site block and the policy
 * block inside the page's offline service worker (`sw.js`). Pure and
 * dependency free: safe to import from Node.
 *
 * `'self'` means the whole origin. The seal holds only on an origin that
 * serves the sealed page and nothing else.
 */
import type { HeaderTarget } from "./types.ts";

/** The app's base path. Never an origin. */
export const LAB_BASE = "/lab/";

type Directive = readonly [name: string, ...sources: string[]];

const serialize = (directives: readonly Directive[]): string => directives.map((d) => d.join(" ")).join("; ");

/**
 * The vault (and every script it or its workers load). No network scheme is
 * allowed anywhere: `connect-src blob:` exists only because the engine worker
 * fetches its module from a `blob:` URL the vault made from bus bytes.
 * `font-src 'self'` serves the bundled Archivo face from tokens.css; it adds
 * no channel that `script-src 'self'` does not already open (same origin).
 */
export const VAULT_DIRECTIVES: readonly Directive[] = [
  ["default-src", "'none'"],
  ["connect-src", "blob:"],
  ["form-action", "'none'"],
  ["script-src", "'self'", "'wasm-unsafe-eval'"],
  ["worker-src", "'self'", "blob:"],
  ["img-src", "blob:", "data:"],
  ["style-src", "'self'"],
  ["font-src", "'self'"],
  ["frame-ancestors", "'self'"],
  ["base-uri", "'none'"],
];

/**
 * The loader. It fetches the manifest and content-addressed files from its
 * own origin and nothing else. Same-origin vault code can call into this
 * document: requests made in its context are held to the origin, but a
 * navigation of the top page through it is not.
 * The service worker script gets these headers too: it needs `connect-src
 * 'self'` to precache, which the vault policy forbids.
 */
export const LOADER_DIRECTIVES: readonly Directive[] = [
  ["default-src", "'none'"],
  ["connect-src", "'self'"],
  ["form-action", "'none'"],
  ["script-src", "'self'"],
  ["worker-src", "'self'"],
  ["frame-src", "'self'"],
  ["img-src", "'self'"],
  ["style-src", "'self'"],
  ["font-src", "'self'"],
  ["manifest-src", "'self'"],
  ["frame-ancestors", "'self'"],
  ["base-uri", "'none'"],
];

/** Anything that is not a document or a script. If one is opened directly
 * it renders sandboxed with nothing allowed. */
export const ASSET_DIRECTIVES: readonly Directive[] = [
  ["default-src", "'none'"],
  ["form-action", "'none'"],
  ["frame-ancestors", "'none'"],
  ["base-uri", "'none'"],
  ["sandbox"],
];

export const VAULT_CSP = serialize(VAULT_DIRECTIVES);
export const LOADER_CSP = serialize(LOADER_DIRECTIVES);
export const ASSET_CSP = serialize(ASSET_DIRECTIVES);

/** Powerful features nothing in the Lab uses. Only widely recognised
 * feature names, so browsers do not log unknown-feature warnings. */
export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "display-capture=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
  "publickey-credentials-get=()",
  "clipboard-read=()",
  "clipboard-write=(self)",
  "fullscreen=(self)",
].join(", ");

/**
 * A proposed network-layer allowlist (own origin only) meant to cover what
 * CSP does not: WebRTC, DNS prefetch, preconnect, navigations, redirects.
 * Chromium's implementation (commit ec5518554846) makes the RTCPeerConnection
 * constructor throw NotAllowedError under it, but Chromium 158.0.8127.18
 * created one under this header (run at build 108c5d23e64348fa), so no
 * browser has been observed enforcing any part of it. It costs nothing where
 * it is ignored; the probe reports a vector blocked only on the browser's
 * own evidence.
 */
export const CONNECTION_ALLOWLIST = "(response-origin)";

const common = (): Record<string, string> => ({
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const documentHeaders = (csp: string): Record<string, string> => ({
  "Content-Security-Policy": csp,
  "Connection-Allowlist": CONNECTION_ALLOWLIST,
  "Cross-Origin-Opener-Policy": "same-origin",
  ...common(),
  "Permissions-Policy": PERMISSIONS_POLICY,
  "X-DNS-Prefetch-Control": "off",
});

/** Header names of the vault policy: what the loader keeps when it
 * observes the vault document's response headers. */
export const POLICY_HEADER_NAMES: readonly string[] = Object.keys(documentHeaders(VAULT_CSP));

/** Response headers for one kind of Lab response. A fresh object per call. */
export function headersFor(target: HeaderTarget): Record<string, string> {
  switch (target) {
    case "loader":
      return documentHeaders(LOADER_CSP);
    case "vault":
      return documentHeaders(VAULT_CSP);
    case "script":
      // Workers take their policy from their own script response, so every
      // script carries the vault policy. (Documents ignore it on scripts.)
      return {
        "Content-Security-Policy": VAULT_CSP,
        "Connection-Allowlist": CONNECTION_ALLOWLIST,
        ...common(),
      };
    case "asset":
      return { "Content-Security-Policy": ASSET_CSP, ...common() };
  }
}

/**
 * Which header set each path gets, relative to the base path. Patterns are
 * Caddy `path` matcher patterns: exact, `*suffix` or `prefix*`. Rules are
 * checked in order; the first match wins. A site-config generator turns them
 * into mutually exclusive matchers, so order there does not matter.
 * `.ts`/`.tsx` exist only under the dev server, which serves sources.
 */
export const ROUTES: readonly { target: Exclude<HeaderTarget, "asset">; paths: readonly string[] }[] = [
  { target: "loader", paths: ["/", "/index.html", "/sw.js"] },
  { target: "vault", paths: ["/vault/", "/vault/index.html"] },
  { target: "script", paths: ["*.js", "*.mjs", "*.ts", "*.tsx"] },
];

/** Content-addressed or hash-named: safe to cache forever. */
export const IMMUTABLE_PATHS: readonly string[] = ["/assets/*", "/cas/*"];
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE = "no-cache";

function matches(pattern: string, path: string): boolean {
  if (pattern.startsWith("*")) return path.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/** Path relative to `base` with a leading slash, or null when outside it. */
function relative(pathname: string, base: string): string | null {
  if (pathname === base.slice(0, -1)) return "/";
  if (!pathname.startsWith(base)) return null;
  return `/${pathname.slice(base.length)}`;
}

/** Header target for a request pathname (query already removed). Paths
 * outside `base` get the asset set. */
export function targetForPath(pathname: string, base = LAB_BASE): HeaderTarget {
  const path = relative(pathname, base);
  if (path === null) return "asset";
  for (const route of ROUTES) if (route.paths.some((p) => matches(p, path))) return route.target;
  return "asset";
}

export function cacheControlFor(pathname: string, base = LAB_BASE): string {
  const path = relative(pathname, base);
  return path !== null && IMMUTABLE_PATHS.some((p) => matches(p, path)) ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}

/** The dev and preview server map: every header a response at `pathname`
 * gets, including Cache-Control. */
export function headersForPath(pathname: string, base = LAB_BASE): Record<string, string> {
  return { ...headersFor(targetForPath(pathname, base)), "Cache-Control": cacheControlFor(pathname, base) };
}
