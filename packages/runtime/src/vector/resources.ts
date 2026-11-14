/**
 * Font faces, images and licence texts the reactor serves by handle, fetched with its
 * `resource` command.
 *
 * `ResourceStore` is one per reactor instance: handles are content hashes (licence texts:
 * the bundled face's `license_file` path), so a face or image fetched for one document serves
 * every other. Faces (parsed outlines, or a registered `FontFace` when the face has no `glyf`
 * outlines) and licence texts live until the store is disposed; images (`ImageBitmap`) are
 * reference-counted by the documents that use them.
 *
 * `ResourceCache` is one per open document: it loads what a page needs (`prepare`), answers
 * the renderer (`face`, `image`), records which faces were drawn (`usedFaces`) and their
 * licences (`licenses`), and releases its images on `dispose`. Images are resolved by the
 * IR image-table `id` the page's ops use, never by position in `display_list.images`.
 *
 * Without a canvas page (e.g. a spreadsheet grid drawn with browser text): `loadFonts` takes
 * a document's font list and registers each engine face as a `FontFace`, answering its CSS
 * family (`cssFont`), origin and licence entry; `usedFaces`/`licenses` then cover those faces.
 *
 * With an extended font pack (`ResourceStoreOptions.fontPack`), a run whose engine face lacks
 * the glyphs of its script, or whose family the engine substituted while the pack has it, is
 * drawn with the pack's face (`ResourceCache.packFace`). A face not downloaded yet is fetched in
 * the background; the paint draws a stand-in meanwhile and `onFontLoaded` asks for a repaint
 * (`ResourceCache.repaint`).
 */
import type { Resource } from "./abi.ts";
import {
  FontPackError,
  detectExtendedScripts,
  extendedScriptOf,
  type FontPackEntry,
  type FontPackLoader,
  type FontPackRequest,
} from "../font-pack.ts";
import type { BundledFace, DisplayList, FaceInfo, FontRef, FontsInfo, TextRun } from "./model.ts";
import { fallbackFamilies, renderPage, type Ctx2D, type RenderOptions } from "./render.ts";
import { parseSfnt, type SfntFace } from "./sfnt.ts";

export type FaceEntry = {
  /** Parsed TrueType outlines, or `null` (CFF or unparsable: drawn via `cssFamily`). */
  outline: SfntFace | null;
  /** Unique CSS family of a registered `FontFace`, when `outline` is null. */
  cssFamily: string | null;
  paths: Map<number, Path2D | null>;
};

/** Fetch one resource's bytes by handle (the reactor's `resource` command). */
export type ResourceFetch = (handle: string) => Promise<Resource>;

/** Where a drawn face came from. */
export type FaceOrigin = "document" | "bundled" | "unknown";

/** A face a document's pages were drawn with, for a "Fonts" notice. */
export type UsedFace = {
  handle: string;
  /** Families the document asked for that this face served. */
  requested: string[];
  /** Family of the face itself. */
  family: string;
  /**
   * `document`: the document carried the face (`embedded_in_document`, or `embedded` on the
   * display list). `bundled`: compiled into the module, with a manifest entry. `unknown`: not a
   * document face and `fonts` gave no manifest entry (or was not noted yet).
   */
  origin: FaceOrigin;
  embeddedInDocument: boolean;
  /** Licence entry of a face compiled into the module; null for document faces or when `fonts` was not noted. */
  bundled: BundledFace | null;
  /** False until the document's `fonts` response was passed to `noteFonts`. */
  known: boolean;
};

/** One licence the bundled faces drawn for a document fall under, with its text. */
export type FontLicense = {
  /** `license_file` path from the manifest; also the `resource` handle of its text. */
  licenseFile: string;
  /** SPDX-style id (`OFL-1.1`, `Apache-2.0`). */
  license: string;
  /** Face families (with versions) under this licence. */
  faces: { family: string; version: string; upstreamUrl: string }[];
  /** UTF-8 text served by the module; null when it could not be fetched (see `error`). */
  text: string | null;
  error: string | null;
};

/** What `loadFonts` needs of a document font; `FontRef` and `FontRequest` both satisfy it. */
export type FontSpec = {
  id: number;
  /** Requested family, for `usedFaces` and the CSS fallback. */
  family: string;
  weight: number;
  italic: boolean;
  /** Content handle of the engine's face; null when the module named none. */
  face: string | null;
  faceIndex: number;
  /** The document carried the face (display list `embedded`, `fonts` request `embedded`). */
  embedded?: boolean;
};

/** One document font, ready for browser text. */
export type DocumentFont<F extends FontSpec = FontSpec> = {
  font: F;
  /** Family of the registered `FontFace` (`wolf-<handle prefix>`); null when no face loaded. */
  cssFamily: string | null;
  origin: FaceOrigin;
  /** Manifest entry of a bundled face (licence); null for document faces and unknown origin. */
  bundled: BundledFace | null;
};

/**
 * CSS `font` shorthand for a document font at `sizePx`: the engine's face by its registered
 * family with no weight or style (the face already has them; descriptors would make the
 * browser synthesise bold or oblique), else the requested family's fallback list.
 */
export function cssFont(f: DocumentFont, sizePx: number): string {
  if (f.cssFamily) return `${sizePx}px "${f.cssFamily}"`;
  return `${f.font.italic ? "italic " : ""}${f.font.weight} ${sizePx}px ${fallbackFamilies(f.font.family)}`;
}

function fontSet(): FontFaceSet | null {
  const g = globalThis as { fonts?: FontFaceSet; document?: Document };
  return g.document?.fonts ?? g.fonts ?? null;
}

type ImageSlot = { bitmap: Promise<ImageBitmap | null>; refs: number; ready: ImageBitmap | null };

export type ResourceStoreOptions = {
  /** The extended font pack of the engine module, read when a run needs it (so a pack known
   * only once the module resolved still applies); null or absent: none. */
  fontPack?: () => FontPackLoader | null;
  /** The pack's manifest or a pack face arrived after a paint drew a stand-in for it (`entry`:
   * the face, null for the manifest): repaint (`ResourceCache.repaint`). */
  onFontLoaded?: (entry: FontPackEntry | null) => void;
};

/** A pack face for one run: `shaped` when the run is drawn as a whole so the browser shapes its script. */
export type PackFace = { face: FaceEntry; shaped: boolean };

export class ResourceStore {
  readonly #fetch: ResourceFetch;
  readonly #options: ResourceStoreOptions;
  readonly #faces = new Map<string, Promise<FaceEntry | null>>();
  readonly #bytes = new Map<string, Promise<Uint8Array>>();
  readonly #css = new Map<string, Promise<string | null>>();
  readonly #cssReady = new Map<string, string>();
  readonly #ready = new Map<string, FaceEntry>();
  readonly #images = new Map<string, ImageSlot>();
  readonly #info = new Map<string, FaceInfo>();
  readonly #licenses = new Map<string, Promise<string>>();
  readonly #fontFaces: FontFace[] = [];
  /** Pack loads this store waits on (each notifies `onFontLoaded` once). */
  readonly #packJobs = new Set<Promise<unknown>>();
  /** Handles (and pack font URLs) that failed to load or decode, with the reason. */
  readonly failures = new Map<string, string>();
  #disposed = false;

  constructor(fetch: ResourceFetch, options: ResourceStoreOptions = {}) {
    this.#fetch = fetch;
    this.#options = options;
  }

  /** Load the pack's manifest, when there is a pack (resolves to null without one). */
  async loadPackManifest(): Promise<unknown> {
    return this.#options.fontPack?.()?.loadManifest() ?? null;
  }

  /**
   * The pack face for `request`, synchronously: the face once loaded; `"pending"` while the
   * pack's manifest or the face downloads (`onFontLoaded` fires when it arrives); null without a
   * pack, when it has no face for the request, or when the face failed (reason in `failures`,
   * keyed by the font's URL: a checksum mismatch is `FontPackError` `checksum-mismatch`).
   */
  packFace(request: FontPackRequest): FaceEntry | "pending" | null {
    const pack = this.#options.fontPack?.();
    if (!pack || this.#disposed) return null;
    if (pack.manifest === undefined) {
      this.#watch(pack.loadManifest(), null);
      return "pending";
    }
    const entry = pack.find(request);
    if (!entry) return null;
    const face = pack.face(entry);
    if (face) return face;
    const failed = pack.failures.get(pack.fileUrl(entry));
    if (failed !== undefined) {
      if (!this.failures.has(pack.fileUrl(entry))) this.failures.set(pack.fileUrl(entry), failed);
      return null;
    }
    this.#watch(pack.loadFace(entry), entry);
    return "pending";
  }

  #watch(job: Promise<unknown>, entry: FontPackEntry | null): void {
    if (this.#packJobs.has(job)) return;
    this.#packJobs.add(job);
    job.then(
      (loaded) => {
        if (!this.#disposed && loaded) this.#options.onFontLoaded?.(entry);
      },
      (err: unknown) => {
        if (entry)
          this.failures.set(
            this.#options.fontPack?.()?.fileUrl(entry) ?? entry.file,
            err instanceof FontPackError ? `${err.code}: ${err.message}` : String(err),
          );
      },
    );
  }

  /** Record the faces (and licence entries) a `fonts` response lists. */
  noteFonts(info: FontsInfo): void {
    for (const f of info.faces) if (f.face) this.#info.set(f.face, f);
  }

  faceInfo(handle: string): FaceInfo | null {
    return this.#info.get(handle) ?? null;
  }

  /** The loaded face of a handle (synchronous; `loadFace` first). */
  face(handle: string): FaceEntry | null {
    return this.#ready.get(handle) ?? null;
  }

  loadFace(handle: string, faceIndex: number): Promise<FaceEntry | null> {
    let job = this.#faces.get(handle);
    if (!job) {
      job = this.#faceBytes(handle)
        .then((bytes) => this.#addFace(handle, bytes, faceIndex))
        .then(
          (entry) => {
            if (entry) this.#ready.set(handle, entry);
            return entry;
          },
          (err: unknown) => {
            this.failures.set(handle, String(err));
            return null;
          },
        );
      this.#faces.set(handle, job);
    }
    return job;
  }

  /** Face bytes by handle, fetched once. */
  #faceBytes(handle: string): Promise<Uint8Array> {
    let job = this.#bytes.get(handle);
    if (!job) {
      job = this.#fetch(handle).then((r) => r.bytes);
      this.#bytes.set(handle, job);
      job.catch(() => this.#bytes.delete(handle));
    }
    return job;
  }

  async #addFace(handle: string, bytes: Uint8Array, faceIndex: number): Promise<FaceEntry | null> {
    if (this.#disposed) return null;
    const entry: FaceEntry = { outline: parseSfnt(bytes, faceIndex), cssFamily: null, paths: new Map() };
    if (!entry.outline) {
      entry.cssFamily = await this.registerFace(handle, faceIndex);
      if (!entry.cssFamily) return null;
    }
    return entry;
  }

  /**
   * Register a face as a `FontFace` in `document.fonts` (or a Worker's `self.fonts`) under a
   * family unique to the face, `wolf-<first 16 hex of the handle>`, and resolve to that family
   * once it is loaded. Registered once per handle for the store's life (the handle is a content
   * hash, so documents share it); null when it cannot be registered (no `FontFaceSet` in this
   * context, a face inside a collection, bytes the browser rejects: reason in `failures`).
   * Use the family without weight or style (`cssFont`): the face already is that weight and
   * style, and a descriptor would make the browser synthesise bold or oblique on top.
   */
  registerFace(handle: string, faceIndex = 0): Promise<string | null> {
    let job = this.#css.get(handle);
    if (!job) {
      job = this.#faceBytes(handle)
        .then(async (bytes) => {
          if (this.#disposed) return null;
          if (faceIndex !== 0) throw new Error(`face ${faceIndex} of a collection cannot be registered as a FontFace`);
          const set = fontSet();
          if (!set) throw new Error("no FontFaceSet (document.fonts or WorkerGlobalScope.fonts) in this context");
          const family = `wolf-${handle.slice(0, 16)}`;
          const face = new FontFace(family, bytes.slice().buffer);
          await face.load();
          if (this.#disposed) return null;
          set.add(face);
          this.#fontFaces.push(face);
          this.#cssReady.set(handle, family);
          return family;
        })
        .catch((err: unknown) => {
          this.failures.set(handle, String(err));
          return null;
        });
      this.#css.set(handle, job);
    }
    return job;
  }

  /** CSS family of a face registered with `registerFace` (synchronous; null until loaded). */
  cssFamily(handle: string): string | null {
    return this.#cssReady.get(handle) ?? null;
  }

  /** Take a reference on an image; resolves to null when it cannot be fetched or decoded. */
  acquireImage(handle: string, mime: string | null): Promise<ImageBitmap | null> {
    let slot = this.#images.get(handle);
    if (!slot) {
      const s: ImageSlot = { refs: 0, ready: null, bitmap: Promise.resolve(null) };
      s.bitmap = this.#fetch(handle)
        .then((r) => createImageBitmap(new Blob([r.bytes.slice().buffer], { type: r.mime || mime || "" })))
        .then(
          (b) => {
            if (this.#disposed || s.refs === 0) {
              b.close();
              return null;
            }
            s.ready = b;
            return b;
          },
          (err: unknown) => {
            this.failures.set(handle, String(err));
            return null;
          },
        );
      this.#images.set(handle, (slot = s));
    }
    slot.refs++;
    return slot.bitmap;
  }

  image(handle: string): ImageBitmap | null {
    return this.#images.get(handle)?.ready ?? null;
  }

  releaseImage(handle: string): void {
    const slot = this.#images.get(handle);
    if (!slot || --slot.refs > 0) return;
    slot.ready?.close();
    this.#images.delete(handle);
  }

  /**
   * Licence text of a bundled face, by its manifest `license_file` path: the module serves it
   * through `resource` (`kind: "license"`, UTF-8 text). Cached for the store's life; rejects
   * when the module does not serve it (`unknown-resource` before module `2e019999…`).
   */
  licenseText(licenseFile: string): Promise<string> {
    let job = this.#licenses.get(licenseFile);
    if (!job) {
      job = this.#fetch(licenseFile).then((r) => {
        if (r.kind !== "license") throw new Error(`resource ${licenseFile}: kind ${r.kind || "none"}, not license`);
        return new TextDecoder("utf-8").decode(r.bytes);
      });
      this.#licenses.set(licenseFile, job);
      job.catch(() => this.#licenses.delete(licenseFile));
    }
    return job;
  }

  /** Close every bitmap, unregister every `FontFace`, and drop all caches. */
  dispose(): void {
    this.#disposed = true;
    for (const s of this.#images.values()) s.ready?.close();
    this.#images.clear();
    const set = fontSet();
    for (const f of this.#fontFaces) set?.delete(f);
    this.#fontFaces.length = 0;
    this.#faces.clear();
    this.#bytes.clear();
    this.#css.clear();
    this.#cssReady.clear();
    this.#ready.clear();
    this.#info.clear();
    this.#licenses.clear();
  }
}

/** Pack scripts per run (`detectExtendedScripts` of its text). */
const runScripts = new WeakMap<TextRun, string[]>();

/**
 * What `run`, drawn with `font` whose engine face is `face`, needs from the pack, or null when
 * the engine face serves it: the run's pack scripts when the face lacks glyphs for them (an
 * outline face without them in its cmap; a `FontFace`-only face that the engine shaped to glyph
 * 0; no face at all), else the requested family when the engine substituted another one.
 */
function packRequest(run: TextRun, font: FontRef, face: FaceEntry | null): FontPackRequest | null {
  if (run.vertical) return null;
  let scripts = runScripts.get(run);
  if (!scripts) runScripts.set(run, (scripts = detectExtendedScripts(run.text)));
  const request = { family: font.family, bold: font.weight >= 600, italic: font.italic };
  if (scripts.length) {
    const outline = face?.outline;
    let missing = !outline && (!face?.cssFamily || !!run.glyphs?.ids.includes(0));
    if (outline)
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!;
        if (extendedScriptOf(cp) && outline.glyphFor(cp) === 0) {
          missing = true;
          break;
        }
      }
    if (missing) return { ...request, scripts };
  }
  return font.substituted ? request : null;
}

export class ResourceCache {
  readonly store: ResourceStore;
  /** Face handle -> requested families drawn with it. */
  readonly #used = new Map<string, Set<string>>();
  /** Face handles the display list marked `embedded` (the face came from the document). */
  readonly #embedded = new Set<string>();
  /** Image handles this document holds a reference on. */
  readonly #images = new Set<string>();
  /**
   * IR image-table id -> content handle, learned from every page prepared so far. The ids are
   * the document's image table (module `2e019999…`: `images-hdrftr.docx` lists id 1 alone on
   * page 7), so a page whose list lacks an id its ops use still resolves it.
   */
  readonly #imageIds = new Map<number, string>();
  /** The last paint on each context that drew stand-ins for pack faces still loading. */
  readonly #pending = new Map<Ctx2D, { dl: DisplayList; opts: RenderOptions }>();
  #disposed = false;

  constructor(store: ResourceStore) {
    this.store = store;
  }

  /** Load every face and image `dl` references, so `renderPage` can draw it synchronously. */
  async prepare(dl: DisplayList): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    const drawn = new Set(dl.runs.map((r) => r.font));
    for (const f of dl.fonts) {
      if (!f.face) continue;
      if (drawn.has(f.id)) this.#noteUse(f);
      if (!this.store.face(f.face)) jobs.push(this.store.loadFace(f.face, f.faceIndex));
    }
    for (const m of dl.images) {
      if (!m.handle || this.#disposed) continue;
      this.#imageIds.set(m.id, m.handle);
      if (this.#images.has(m.handle)) continue;
      this.#images.add(m.handle);
      jobs.push(this.store.acquireImage(m.handle, m.mime));
    }
    await Promise.all(jobs);
    // A run that needs the pack: its manifest (small, once per pack) is known before the first
    // paint; the faces download in the background (`repaint` once they arrive).
    const fonts = new Map(dl.fonts.map((f) => [f.id, f]));
    const needs = dl.runs.filter((run) => {
      const font = fonts.get(run.font);
      return font && packRequest(run, font, this.face(font));
    });
    if (!needs.length || this.#disposed) return;
    await this.store.loadPackManifest();
    for (const run of needs) this.packFace(run, fonts.get(run.font)!);
  }

  face(font: FontRef): FaceEntry | null {
    return font.face ? this.store.face(font.face) : null;
  }

  /** The pack face to draw `run` with instead of `font`'s engine face (`ResourceStore.packFace`);
   * null when the engine face serves it or the pack has nothing for it. */
  packFace(run: TextRun, font: FontRef): PackFace | "pending" | null {
    const request = packRequest(run, font, this.face(font));
    const face = request && this.store.packFace(request);
    if (!face || face === "pending") return face;
    return { face, shaped: !!request.scripts };
  }

  /** For `renderPage`: remember the paint on `ctx` while it drew stand-ins (`pending`), else forget it. */
  notePaint(ctx: Ctx2D, dl: DisplayList, opts: RenderOptions, pending: boolean): void {
    if (pending && !this.#disposed) this.#pending.set(ctx, { dl, opts });
    else this.#pending.delete(ctx);
  }

  /** Paint again every page whose last paint drew stand-ins for pack faces (call on
   * `onFontLoaded`); a face still loading keeps its page for the next call. Returns the pages painted. */
  repaint(): number {
    const paints = [...this.#pending];
    this.#pending.clear();
    for (const [ctx, { dl, opts }] of paints) renderPage(ctx, dl, opts);
    return paints.length;
  }

  #noteUse(f: FontSpec): void {
    if (!f.face) return;
    let fams = this.#used.get(f.face);
    if (!fams) this.#used.set(f.face, (fams = new Set()));
    fams.add(f.family);
    if (f.embedded) this.#embedded.add(f.face);
  }

  /**
   * Load a document's fonts for drawing text with the browser (no canvas page needed): every
   * face is registered once per store as a `FontFace` (`ResourceStore.registerFace`), and each
   * font is answered with its CSS family, origin and licence entry. Takes `display_list.fonts`
   * (`DisplayList.fonts`) or the `fonts` command's requests (`parseFonts(res).requests`); the
   * faces count as used for `usedFaces` and `licenses`. Call `store.noteFonts` with the
   * document's `fonts` response first for origin and licence data.
   */
  async loadFonts<F extends FontSpec>(fonts: readonly F[]): Promise<DocumentFont<F>[]> {
    const families = await Promise.all(
      fonts.map((f) => {
        if (!f.face || this.#disposed) return Promise.resolve(null);
        this.#noteUse(f);
        return this.store.registerFace(f.face, f.faceIndex);
      }),
    );
    return fonts.map((font, i) => {
      const o = font.face ? this.#origin(font.face) : { origin: "unknown" as const, bundled: null };
      return { font, cssFamily: families[i], origin: o.origin, bundled: o.bundled };
    });
  }

  #origin(handle: string): { origin: FaceOrigin; embeddedInDocument: boolean; bundled: BundledFace | null } {
    const info = this.store.faceInfo(handle);
    const embeddedInDocument = info ? info.embeddedInDocument : this.#embedded.has(handle);
    const bundled = embeddedInDocument ? null : (info?.bundled ?? null);
    return { origin: embeddedInDocument ? "document" : bundled ? "bundled" : "unknown", embeddedInDocument, bundled };
  }

  /** The bitmap of IR image `id` on `dl` (by id, never by list position); null if not decoded. */
  image(dl: DisplayList, id: number): ImageBitmap | null {
    const handle = dl.images.find((m) => m.id === id)?.handle ?? this.#imageIds.get(id);
    return handle ? this.store.image(handle) : null;
  }

  /** Faces drawn on the pages prepared so far, with licence entries (see `ResourceStore.noteFonts`). */
  usedFaces(): UsedFace[] {
    return [...this.#used].map(([handle, fams]) => {
      const info = this.store.faceInfo(handle);
      const o = this.#origin(handle);
      return {
        handle,
        requested: [...fams].sort(),
        family: info?.family ?? [...fams][0] ?? "",
        origin: o.origin,
        embeddedInDocument: o.embeddedInDocument,
        bundled: o.bundled,
        known: info !== null,
      };
    });
  }

  /**
   * Licences of the bundled faces drawn so far, grouped by licence file, with the text the
   * module serves. Document faces carry no licence data from the module and are not listed.
   */
  async licenses(): Promise<FontLicense[]> {
    const byFile = new Map<string, FontLicense>();
    for (const f of this.usedFaces()) {
      const b = f.origin === "bundled" ? f.bundled : null;
      if (!b?.licenseFile) continue;
      let l = byFile.get(b.licenseFile);
      if (!l)
        byFile.set(
          b.licenseFile,
          (l = { licenseFile: b.licenseFile, license: b.license, faces: [], text: null, error: null }),
        );
      if (!l.faces.some((x) => x.family === b.family && x.version === b.version))
        l.faces.push({ family: b.family, version: b.version, upstreamUrl: b.upstreamUrl });
    }
    const out = [...byFile.values()].sort((a, b) => a.licenseFile.localeCompare(b.licenseFile));
    await Promise.all(
      out.map((l) =>
        this.store.licenseText(l.licenseFile).then(
          (t) => {
            l.text = t;
          },
          (err: unknown) => {
            l.error = err instanceof Error ? err.message : String(err);
          },
        ),
      ),
    );
    return out;
  }

  /** Release this document's images; faces stay in the store for other documents. */
  dispose(): void {
    this.#disposed = true;
    for (const h of this.#images) this.store.releaseImage(h);
    this.#images.clear();
    this.#used.clear();
    this.#embedded.clear();
    this.#imageIds.clear();
    this.#pending.clear();
  }
}
