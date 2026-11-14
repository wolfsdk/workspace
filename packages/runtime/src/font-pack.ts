/**
 * The extended font pack: faces a release leaves out of its engine modules (Arabic, Armenian,
 * Hebrew, Thai, the Indic scripts and emoji, plus a few document families), served next to
 * them as `v<VERSION>/fonts/<file>` and listed in `v<VERSION>/fonts/wolf_web_font_pack.json`:
 *
 *   { "schema": "wolf-web-font-pack.v1",
 *     "fonts": [{ "file", "family", "style", "script", "bytes", "sha256" }, ...] }
 *
 * `FontPackLoader` reads that manifest once (an HTTP 404 means the release has no pack: `null`,
 * never an error), finds the face a run needs by family and style or by the scripts in its text
 * (`detectExtendedScripts`), and downloads each face once. The bytes are refused unless their
 * SHA-256 is the manifest's, before anything parses or registers them. Faces are parsed for
 * outline drawing and, where a `FontFaceSet` exists, registered as `FontFace`
 * `wolf-pack-<first 16 hex of the sha256>`; they stay for the loader's life, shared by every
 * document. No DOM needed: runs on a page, in a Worker, in Node and in bun.
 */
import type { FaceEntry } from "./vector/resources.ts";
import { parseSfnt } from "./vector/sfnt.ts";

export const WOLF_WEB_FONT_PACK_SCHEMA = "wolf-web-font-pack.v1";
export const FONT_PACK_NAME = "wolf_web_font_pack.json";

export type FontPackEntry = {
  /** File name next to the manifest (`NotoSansThai-Regular.ttf`). */
  file: string;
  family: string;
  /** `regular`, `bold`, `italic` or `bold_italic`. */
  style: string;
  /** Script the face covers (`thai`, `arabic`, `emoji`, ...); null for a face that serves a document family. */
  script: string | null;
  bytes: number;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
};

export type FontPackManifest = { schema: typeof WOLF_WEB_FONT_PACK_SCHEMA; fonts: FontPackEntry[] };

/** What a run needs from the pack: a family (and style) the engine did not have, or scripts its face lacks. */
export type FontPackRequest = { family?: string | null; bold?: boolean; italic?: boolean; scripts?: readonly string[] };

export type FontPackErrorCode =
  /** The manifest is not `wolf-web-font-pack.v1` or holds a record the loader refuses. */
  | "bad-manifest"
  /** The manifest or a font could not be fetched (network failure or HTTP error other than a manifest 404). */
  | "http-error"
  /** A font's bytes hash to something else than its manifest record says. */
  | "checksum-mismatch"
  /** A font with the right checksum that neither parses nor registers as a `FontFace`. */
  | "bad-font";

export class FontPackError extends Error {
  readonly code: FontPackErrorCode;
  /** The URL the load failed on. */
  readonly url: string;
  constructor(code: FontPackErrorCode, message: string, url: string) {
    super(message);
    this.name = "FontPackError";
    this.code = code;
    this.url = url;
  }
}

function siblingUrl(base: string | URL, rel: string): string {
  if (base instanceof URL) return new URL(rel, base).href;
  try {
    return new URL(rel, base).href;
  } catch {
    const g = globalThis as { location?: { href?: string }; document?: { baseURI?: string } };
    const origin = g.location?.href ?? g.document?.baseURI;
    if (origin) {
      try {
        return new URL(rel, new URL(base, origin)).href;
      } catch {
        // Fall back to path-relative sibling resolution when origin is non-hierarchical.
      }
    }
    return base.replace(/[^/?#]*([?#].*)?$/, "") + rel;
  }
}

/** The pack manifest of the release that serves the engine module at `moduleUrl`. */
export function fontPackUrl(moduleUrl: string | URL): string {
  return siblingUrl(moduleUrl, `fonts/${FONT_PACK_NAME}`);
}

const FILE = /^[A-Za-z0-9._-]+\.(ttf|otf|ttc)$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A manifest as the loader accepts it; any record it refuses (unsafe file name, repeated file,
 * checksum that is not 64 lowercase hex digits, ...) refuses the whole manifest (`bad-manifest`). */
export function parseFontPackManifest(json: unknown, url = FONT_PACK_NAME): FontPackManifest {
  const bad = (why: string) => new FontPackError("bad-manifest", `${url}: ${why}`, url);
  const doc = json as { schema?: unknown; fonts?: unknown } | null;
  if (!doc || typeof doc !== "object" || doc.schema !== WOLF_WEB_FONT_PACK_SCHEMA)
    throw bad(`schema must be ${WOLF_WEB_FONT_PACK_SCHEMA}`);
  if (!Array.isArray(doc.fonts)) throw bad("fonts must be a list");
  const seen = new Set<string>();
  const fonts = doc.fonts.map((record: unknown): FontPackEntry => {
    const { file, family, style, script, bytes, sha256 } = (record ?? {}) as Record<string, unknown>;
    if (typeof file !== "string" || !FILE.test(file) || file.includes("..") || seen.has(file))
      throw bad(`invalid or repeated font file ${JSON.stringify(file)}`);
    seen.add(file);
    if (typeof family !== "string" || !family || typeof style !== "string" || !style)
      throw bad(`${file} needs a family and a style`);
    if (script != null && typeof script !== "string") throw bad(`${file} has a script that is not a name`);
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) throw bad(`${file} has no byte size`);
    if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw bad(`${file} has no valid sha256`);
    return { file, family, style, script: script ?? null, bytes, sha256 };
  });
  return { schema: WOLF_WEB_FONT_PACK_SCHEMA, fonts };
}

/** Code point ranges of the scripts the pack serves, by its `script` tags. */
const SCRIPT_RANGES: readonly (readonly [number, number, string])[] = [
  [0x0530, 0x058f, "armenian"],
  [0x0590, 0x05ff, "hebrew"],
  [0x0600, 0x06ff, "arabic"],
  [0x0750, 0x077f, "arabic"],
  [0x0870, 0x08ff, "arabic"],
  [0x0900, 0x097f, "devanagari"],
  [0x0980, 0x09ff, "bengali"],
  [0x0a00, 0x0a7f, "gurmukhi"],
  [0x0a80, 0x0aff, "gujarati"],
  [0x0b00, 0x0b7f, "oriya"],
  [0x0b80, 0x0bff, "tamil"],
  [0x0c00, 0x0c7f, "telugu"],
  [0x0c80, 0x0cff, "kannada"],
  [0x0d00, 0x0d7f, "malayalam"],
  [0x0d80, 0x0dff, "sinhala"],
  [0x0e00, 0x0e7f, "thai"],
  [0xa8e0, 0xa8ff, "devanagari"],
  [0xfb13, 0xfb17, "armenian"],
  [0xfb1d, 0xfb4f, "hebrew"],
  [0xfb50, 0xfdff, "arabic"],
  [0xfe70, 0xfefc, "arabic"],
  [0x1f1e6, 0x1f1ff, "emoji"],
  [0x1f300, 0x1faff, "emoji"],
];

/** The pack `script` tag of `codePoint`, or null for a code point the engine modules cover themselves. */
export function extendedScriptOf(codePoint: number): string | null {
  if (codePoint < 0x0530) return null;
  for (const [from, to, script] of SCRIPT_RANGES) if (codePoint >= from && codePoint <= to) return script;
  return null;
}

/** The pack scripts `text` uses, in order of first use (`["thai", "emoji"]`); empty for text the modules cover. */
export function detectExtendedScripts(text: string): string[] {
  const found: string[] = [];
  for (const ch of text) {
    const script = extendedScriptOf(ch.codePointAt(0)!);
    if (script && !found.includes(script)) found.push(script);
  }
  return found;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class FontPackLoader {
  /** The manifest URL; font files resolve against it. */
  readonly url: string;
  /** URLs (manifest or font) that failed, with the reason. */
  readonly failures = new Map<string, string>();
  readonly #fetch: typeof fetch | undefined;
  #manifest: FontPackManifest | null | undefined = undefined;
  #manifestJob: Promise<FontPackManifest | null> | null = null;
  readonly #jobs = new Map<string, Promise<FaceEntry>>();
  readonly #faces = new Map<string, FaceEntry>();

  /** `url`: the manifest (`fontPackUrl(moduleUrl)`); `fetch`: for authenticated hosting. */
  constructor(url: string | URL, options: { fetch?: typeof fetch } = {}) {
    this.url = String(url);
    this.#fetch = options.fetch;
  }

  /** The manifest once loaded; null when the release has none (or it was refused: see `failures`); undefined before. */
  get manifest(): FontPackManifest | null | undefined {
    return this.#manifest;
  }

  /** Fetch the manifest, once. Never rejects: a 404 is null quietly, any other failure null with its reason in `failures`. */
  loadManifest(): Promise<FontPackManifest | null> {
    this.#manifestJob ??= (async () => {
      try {
        const response = await this.#get(this.url);
        if (response.status === 404) return null;
        if (!response.ok)
          throw new FontPackError("http-error", `GET ${this.url}: ${response.status} ${response.statusText}`.trim(), this.url);
        return parseFontPackManifest(await response.json(), this.url);
      } catch (e) {
        this.failures.set(this.url, describe(e));
        return null;
      }
    })().then((manifest) => (this.#manifest = manifest));
    return this.#manifestJob;
  }

  /**
   * The face for `request`, synchronously (null before the manifest loaded): a face of the
   * requested family (case-insensitive) first, else one of the first requested script the pack
   * serves. Among a family's faces the requested style wins, then bold for bold italic, then regular.
   */
  find(request: FontPackRequest): FontPackEntry | null {
    const fonts = this.#manifest?.fonts;
    if (!fonts) return null;
    const styles = [
      request.bold ? (request.italic ? "bolditalic" : "bold") : request.italic ? "italic" : "regular",
      request.bold ? "bold" : "regular",
      "regular",
    ];
    const pick = (matches: (entry: FontPackEntry) => boolean): FontPackEntry | null => {
      const all = fonts.filter(matches);
      for (const style of styles) {
        const hit = all.find((entry) => entry.style.toLowerCase().replace(/[^a-z]/g, "") === style);
        if (hit) return hit;
      }
      return all[0] ?? null;
    };
    const family = request.family?.trim().toLowerCase();
    const named = family ? pick((entry) => entry.family.toLowerCase() === family) : null;
    if (named) return named;
    for (const script of request.scripts ?? []) {
      const hit = pick((entry) => entry.script === script);
      if (hit) return hit;
    }
    return null;
  }

  /** Absolute URL of a manifest record's file. */
  fileUrl(entry: FontPackEntry): string {
    return siblingUrl(this.url, entry.file);
  }

  /** The loaded face of `entry` (synchronous; `loadFace` first). */
  face(entry: FontPackEntry): FaceEntry | null {
    return this.#faces.get(this.fileUrl(entry)) ?? null;
  }

  /**
   * Download `entry` once, check its SHA-256 against the record (`checksum-mismatch` before
   * anything reads the bytes), parse its outlines and register it as a `FontFace` where a
   * `FontFaceSet` exists. A failure is kept: the file is not fetched again.
   */
  loadFace(entry: FontPackEntry): Promise<FaceEntry> {
    const url = this.fileUrl(entry);
    let job = this.#jobs.get(url);
    if (!job) {
      job = this.#load(entry, url);
      this.#jobs.set(url, job);
      job.catch((e: unknown) => this.failures.set(url, describe(e)));
    }
    return job;
  }

  async #load(entry: FontPackEntry, url: string): Promise<FaceEntry> {
    const response = await this.#get(url);
    if (!response.ok)
      throw new FontPackError("http-error", `GET ${url}: ${response.status} ${response.statusText}`.trim(), url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const actual = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (actual !== entry.sha256)
      throw new FontPackError("checksum-mismatch", `${url} has SHA-256 ${actual}, expected ${entry.sha256}`, url);
    let outline = null;
    try {
      outline = parseSfnt(bytes, 0);
    } catch {
      // Not a TrueType face this reader understands: the FontFace alone draws it.
    }
    const cssFamily = await register(bytes, entry);
    if (!outline && !cssFamily) throw new FontPackError("bad-font", `${url} neither parses nor registers as a font`, url);
    const face: FaceEntry = { outline, cssFamily, paths: new Map() };
    this.#faces.set(url, face);
    return face;
  }

  async #get(url: string): Promise<Response> {
    try {
      return await (this.#fetch ?? globalThis.fetch.bind(globalThis))(url);
    } catch (e) {
      throw new FontPackError("http-error", `GET ${url} failed: ${describe(e)}`, url);
    }
  }
}

/** Register a verified face as `FontFace` `wolf-pack-<sha256 prefix>`; null without a `FontFaceSet` or when the browser refuses it. */
async function register(bytes: Uint8Array, entry: FontPackEntry): Promise<string | null> {
  const g = globalThis as { fonts?: FontFaceSet; document?: Document };
  const set = g.document?.fonts ?? g.fonts;
  if (!set || typeof FontFace === "undefined") return null;
  try {
    const family = `wolf-pack-${entry.sha256.slice(0, 16)}`;
    const face = new FontFace(family, bytes.slice().buffer);
    await face.load();
    set.add(face);
    return family;
  } catch {
    return null;
  }
}
