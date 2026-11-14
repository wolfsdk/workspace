/**
 * Where the engine module comes from, and how its bytes are checked.
 *
 * A channel is a download root laid out as the public installer reads it:
 * `<channel>/latest.txt` holds the current version, `<channel>/v<VERSION>/`
 * holds the release with its `SHA256SUMS` (lines `<hex>  <name>`, a leading
 * `*` on the name allowed) and the engine module: `wolf_web.wasm` (all
 * formats) and, when the release ships them, one slimmer
 * `wolf_web_<format>.wasm` per format (`docx`, `xlsx`, `pptx`, `pdf`).
 * `resolveEngine` turns an `EngineSource` into one module URL with the
 * version and checksum it expects; `fetchEngineBytes` downloads it and
 * refuses bytes whose SHA-256 differs. Same version and checksum rules as the
 * installer. No DOM: runs on a page, in a Worker, in Node and in bun.
 */

export const DEFAULT_ENGINE_CHANNEL = "https://wolfsdk.com/download/wolf";
export const ENGINE_MODULE_NAME = "wolf_web.wasm";

/** The document formats that may have their own engine module. */
export type EngineFormat = "docx" | "xlsx" | "pptx" | "pdf";

export const ENGINE_FORMATS: readonly EngineFormat[] = ["docx", "xlsx", "pptx", "pdf"];

/** The file name of the module for `format` (`wolf_web_docx.wasm`), or of the
 * module for every format (`wolf_web.wasm`) when there is no `format`. */
export function engineModuleName(format?: EngineFormat): string {
  return format ? `wolf_web_${format}.wasm` : ENGINE_MODULE_NAME;
}

const ZIP_PREFIXES: readonly [string, EngineFormat][] = [
  ["word/", "docx"],
  ["xl/", "xlsx"],
  ["ppt/", "pptx"],
];

/** The OOXML format a ZIP's entry names declare (`word/`, `xl/`, `ppt/`), read from its local file
 * headers in order; undefined when none of the names it reaches says. */
function zipFormat(bytes: Uint8Array): EngineFormat | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder("latin1");
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const nameLength = dv.getUint16(p + 26, true);
    const start = p + 30;
    const name = latin1.decode(bytes.subarray(start, start + nameLength));
    for (const [prefix, format] of ZIP_PREFIXES) if (name.startsWith(prefix)) return format;
    const next = start + nameLength + dv.getUint16(p + 28, true);
    const size = dv.getUint32(p + 18, true);
    // A streamed entry (general purpose bit 3) may carry its size after the data: find the next header.
    if (dv.getUint16(p + 6, true) & 8 && size === 0) {
      p = next;
      while (p + 4 <= bytes.length && dv.getUint32(p, true) !== 0x04034b50) p++;
    } else p = next + size;
  }
  return undefined;
}

function extensionFormat(path: string | null | undefined): EngineFormat | undefined {
  const match = path ? /\.(docx|xlsx|pptx|pdf)$/i.exec(path.split(/[?#]/)[0]!) : null;
  return match ? (match[1]!.toLowerCase() as EngineFormat) : undefined;
}

/**
 * The engine format of a document: from its `bytes` when given (`%PDF-` within the first
 * 1024 bytes is `pdf`; a ZIP is `docx`, `xlsx` or `pptx` by its first `word/`, `xl/` or `ppt/`
 * entry), else from the extension of `name`, then of `url` (query and fragment ignored, any
 * case). Undefined when none of them says.
 */
export function inferEngineFormat(input: {
  name?: string | null;
  url?: string | null;
  bytes?: Uint8Array | null;
}): EngineFormat | undefined {
  const { bytes } = input;
  if (bytes && bytes.length >= 5) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (head.includes("%PDF-")) return "pdf";
    if (head.startsWith("PK\x03\x04")) {
      const format = zipFormat(bytes);
      if (format) return format;
    }
  }
  return extensionFormat(input.name) ?? extensionFormat(input.url);
}

export type EngineSource = {
  /** Exact module URL; skips channel resolution (and `format`). */
  url?: string | URL;
  /** Root holding `latest.txt` and `v<VERSION>/`; default `DEFAULT_ENGINE_CHANNEL`. */
  channel?: string;
  /** Default: the trimmed body of `<channel>/latest.txt`. */
  version?: string;
  /**
   * The one document format the module has to serve. On a channel, the
   * release's `wolf_web_<format>.wasm` is used when its `SHA256SUMS` lists
   * it; a release without it falls back to the module for every format,
   * `ENGINE_MODULE_NAME`. Default: `ENGINE_MODULE_NAME`.
   */
  format?: EngineFormat;
  /** Expected SHA-256, lowercase hex; default: the module's line of
   * `<channel>/v<VERSION>/SHA256SUMS` (`engineModuleName(format)`, or
   * `ENGINE_MODULE_NAME` for a release without that module). */
  sha256?: string;
  fetch?: typeof fetch;
};

/** One module URL with what is known about it: `version` is null for an
 * exact `url`; `sha256` is null when an exact `url` came without one (the
 * bytes are then not checked). */
export type ResolvedEngine = { url: string; version: string | null; sha256: string | null };

export type EngineLoadCode =
  /** `latest.txt` or `SHA256SUMS` could not be fetched (network failure, or
   * `latest.txt` answered with an HTTP error). */
  | "channel-unreachable"
  /** The version (given, or read from `latest.txt`) is not `MAJOR.MINOR.PATCH`
   * with an optional `-pre.release` suffix. */
  | "bad-version"
  /** `SHA256SUMS` is missing (HTTP error) or lacks exactly one valid line
   * for the module (or, with a `format`, for both its module and the module
   * for every format), or a given `sha256` is not 64 hex digits. */
  | "missing-checksum"
  /** The module's bytes hash to something else than expected. */
  | "checksum-mismatch"
  /** The module itself could not be fetched (network failure or HTTP error). */
  | "http-error"
  /** The `format` is none of `docx`, `xlsx`, `pptx`, `pdf`. */
  | "bad-format";

export class EngineLoadError extends Error {
  readonly code: EngineLoadCode;
  /** The URL the load failed on. */
  readonly url: string;
  constructor(code: EngineLoadCode, message: string, url: string) {
    super(message);
    this.name = "EngineLoadError";
    this.code = code;
    this.url = url;
  }
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET `url`; a network failure throws `EngineLoadError` with `code`. */
async function get(
  url: string,
  code: EngineLoadCode,
  fetcher: typeof fetch | undefined,
  signal?: AbortSignal,
): Promise<globalThis.Response> {
  const f = fetcher ?? globalThis.fetch.bind(globalThis);
  try {
    return await f(url, signal ? { signal } : undefined);
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new EngineLoadError(code, `GET ${url} failed: ${describe(e)}`, url);
  }
}

/** What a `SHA256SUMS` body says about one module name: no line at all
 * (`absent`), lines the installer refuses (more than one, or not
 * `<64 hex>  <name>`: `invalid`), or the one valid checksum (`listed`). */
type Listing = { status: "absent" } | { status: "invalid" } | { status: "listed"; sha256: string };

function listing(sums: string, name: string): Listing {
  let found: string | null = null;
  let count = 0;
  for (const line of sums.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2 || fields[1]!.replace(/^\*/, "") !== name) continue;
    count += 1;
    const hash = fields[0]!.toLowerCase();
    if (fields.length !== 2 || !SHA256.test(hash)) return { status: "invalid" };
    found = hash;
  }
  if (count === 0) return { status: "absent" };
  return count === 1 && found ? { status: "listed", sha256: found } : { status: "invalid" };
}

/** The expected checksum of `name` in a `SHA256SUMS` body: exactly one line
 * `<64 hex>  <name>` (or `*<name>`), as the installer requires; null
 * otherwise. */
export function checksumOf(sums: string, name: string): string | null {
  const entry = listing(sums, name);
  return entry.status === "listed" ? entry.sha256 : null;
}

/** A given `sha256`, lowercased; refuses anything but 64 hex digits. */
function expectedSha(sha256: string | undefined, url: string): string | null {
  if (sha256 === undefined) return null;
  const hex = sha256.trim().toLowerCase();
  if (!SHA256.test(hex))
    throw new EngineLoadError("missing-checksum", `sha256 must be 64 hex digits, got "${sha256}"`, url);
  return hex;
}

/** `format` as a known `EngineFormat`, or undefined when there is none;
 * anything else is `bad-format` (it becomes part of a URL path). */
function engineFormatOf(format: unknown, channel: string): EngineFormat | undefined {
  if (!format) return undefined;
  if (!ENGINE_FORMATS.includes(format as EngineFormat))
    throw new EngineLoadError(
      "bad-format",
      `format must be one of ${ENGINE_FORMATS.join(", ")}, got "${String(format).slice(0, 40)}"`,
      channel,
    );
  return format as EngineFormat;
}

/** The body of a release's `SHA256SUMS`. */
async function releaseSums(sumsUrl: string, fetcher: typeof fetch | undefined): Promise<string> {
  const sums = await get(sumsUrl, "channel-unreachable", fetcher);
  if (!sums.ok)
    throw new EngineLoadError(
      "missing-checksum",
      `GET ${sumsUrl}: ${sums.status} ${sums.statusText}`.trim(),
      sumsUrl,
    );
  return sums.text();
}

/**
 * The module URL of `source` with its version and expected SHA-256.
 * `url` wins over `channel`, `version` and `format`. Otherwise the version is
 * `source.version` or `<channel>/latest.txt`, and the checksum is
 * `source.sha256` or the module's line in `<channel>/v<VERSION>/SHA256SUMS`.
 *
 * With a `format`, the module is `wolf_web_<format>.wasm` when the release's
 * `SHA256SUMS` has a line for it, and `wolf_web.wasm` (every format) when it
 * has none for it but one for that; a line for neither is `missing-checksum`.
 * A per-format line the installer would refuse (duplicate, malformed) is
 * `missing-checksum` as well, never a reason to fall back. A given `sha256`
 * is the checksum of whichever of the two modules is chosen: without a
 * `format` it settles the module and `SHA256SUMS` is not read, with one
 * `SHA256SUMS` still chooses the module.
 */
export async function resolveEngine(source: EngineSource = {}): Promise<ResolvedEngine> {
  if (source.url !== undefined && String(source.url) !== "") {
    const url = String(source.url);
    return { url, version: null, sha256: expectedSha(source.sha256, url) };
  }
  const channel = (source.channel || DEFAULT_ENGINE_CHANNEL).replace(/\/+$/, "");
  const format = engineFormatOf(source.format, channel);
  let version = source.version?.trim();
  if (!version) {
    const latest = `${channel}/latest.txt`;
    const response = await get(latest, "channel-unreachable", source.fetch);
    if (!response.ok)
      throw new EngineLoadError(
        "channel-unreachable",
        `GET ${latest}: ${response.status} ${response.statusText}`.trim(),
        latest,
      );
    version = (await response.text()).trim();
    if (!VERSION.test(version))
      throw new EngineLoadError(
        "bad-version",
        `${latest} must hold one version such as 0.2.24, got "${version.slice(0, 40)}"`,
        latest,
      );
  } else if (!VERSION.test(version)) {
    throw new EngineLoadError("bad-version", `version must look like 0.2.24, got "${version}"`, channel);
  }
  const release = `${channel}/v${version}`;
  const sumsUrl = `${release}/SHA256SUMS`;
  const wanted = engineModuleName(format);
  const given = expectedSha(source.sha256, `${release}/${wanted}`);
  if (given && !format) return { url: `${release}/${wanted}`, version, sha256: given };
  const sums = await releaseSums(sumsUrl, source.fetch);
  let name = wanted;
  let entry = listing(sums, name);
  if (format && entry.status === "absent") {
    name = ENGINE_MODULE_NAME;
    entry = listing(sums, name);
  }
  const url = `${release}/${name}`;
  const sha256 = given ?? (entry.status === "listed" ? entry.sha256 : null);
  if (entry.status === "absent" || sha256 === null) {
    const missing = name === wanted ? name : `${wanted} or ${name}`;
    throw new EngineLoadError(
      "missing-checksum",
      `${sumsUrl} must contain exactly one valid entry for ${missing}`,
      sumsUrl,
    );
  }
  return { url, version, sha256 };
}

/** Lowercase hex SHA-256 of `bytes` (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Download the resolved module, streaming its body into one buffer, and
 * check its SHA-256 when `resolved.sha256` is set (`checksum-mismatch`
 * otherwise). A network failure or an HTTP error is `http-error`.
 */
export async function fetchEngineBytes(
  resolved: ResolvedEngine,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const { url } = resolved;
  const response = await get(url, "http-error", options.fetch, options.signal);
  if (!response.ok)
    throw new EngineLoadError("http-error", `GET ${url}: ${response.status} ${response.statusText}`.trim(), url);
  let bytes: Uint8Array;
  try {
    bytes = await readBody(response);
  } catch (e) {
    if (options.signal?.aborted) throw e;
    throw new EngineLoadError("http-error", `GET ${url}: reading the body failed: ${describe(e)}`, url);
  }
  if (resolved.sha256 !== null) {
    const actual = await sha256Hex(bytes);
    if (actual !== resolved.sha256)
      throw new EngineLoadError(
        "checksum-mismatch",
        `${url} has SHA-256 ${actual}, expected ${resolved.sha256}`,
        url,
      );
  }
  return bytes;
}

/** The whole body as one exact-size buffer, read chunk by chunk (into a
 * buffer of `Content-Length` bytes when the response is not encoded). */
async function readBody(response: globalThis.Response): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const declared = response.headers.get("content-encoding") ? 0 : Number(response.headers.get("content-length"));
  let buffer = new Uint8Array(declared > 0 ? declared : 1 << 20);
  let length = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.max(buffer.byteLength * 2, length + value.byteLength));
      grown.set(buffer.subarray(0, length));
      buffer = grown;
    }
    buffer.set(value, length);
    length += value.byteLength;
  }
  return length === buffer.byteLength ? buffer : buffer.slice(0, length);
}

export {
  FONT_PACK_NAME,
  FontPackError,
  FontPackLoader,
  WOLF_WEB_FONT_PACK_SCHEMA,
  detectExtendedScripts,
  extendedScriptOf,
  fontPackUrl,
  parseFontPackManifest,
  type FontPackEntry,
  type FontPackErrorCode,
  type FontPackManifest,
  type FontPackRequest,
} from "./font-pack.ts";
