/**
 * Vector pages (`@wolfsdk/runtime/vector`) for a
 * reactor kernel: display lists painted on a canvas with the engine's own faces
 * and images, PNG per page when the renderer says it approximated something.
 *
 * One `VectorPages` per kernel (fonts and images are content hashes shared by
 * every document); one `VectorDoc` per open document, disposed when another
 * document opens or the host closes it. Display lists are cached per revision
 * and page, never by page hash alone: the hash covers only what the page draws
 * and leaves out source tags (`object_id`, `object_offset`) and font/image
 * table indices, which differ between revisions that draw the same page. The
 * page hash only decides whether a canvas needs repainting.
 *
 * Extended font pack: the element attaches the pack of the module a kernel
 * runs (`attachFontPack`, one `FontPackLoader` per pack URL, so documents and
 * kernels of the same release share downloaded faces). A run whose face lacks
 * its script is drawn with a stand-in while its pack face downloads, then the
 * canvases that drew stand-ins are painted again (`ResourceCache.repaint`).
 */
import type { DocId, KernelError, ReactorKernelClient } from "@wolfsdk/protocol";
import {
  FontPackLoader,
  ResourceCache,
  ResourceStore,
  fontPackUrl,
  parseDisplayList,
  parseFonts,
  parseResource,
  type DisplayList,
  type FaceInfo,
  type RenderStats,
  type UsedFace,
} from "@wolfsdk/runtime/vector";
import { toKernelError } from "./util.ts";

type Json = Record<string, unknown>;

/** Pack loaders by manifest URL (shared by every kernel of a release). */
const PACKS = new Map<string, FontPackLoader>();
/** The pack of each kernel's engine module. */
const KERNEL_PACKS = new WeakMap<object, FontPackLoader>();

/**
 * Use the extended font pack of the release that serves `moduleUrl` for the
 * pages of `kernel` (`fonts/wolf_web_font_pack.json` next to the module; a
 * release without one answers 404 and draws as before). `fetch` reaches an
 * authenticated host. Returns the loader, shared by every kernel of the release.
 */
export function attachFontPack(kernel: object, moduleUrl: string | URL, fetch?: typeof globalThis.fetch): FontPackLoader {
  const url = fontPackUrl(moduleUrl);
  let pack = PACKS.get(url);
  if (!pack) PACKS.set(url, (pack = new FontPackLoader(url, { fetch })));
  KERNEL_PACKS.set(kernel, pack);
  return pack;
}

/** The pack `attachFontPack` gave `kernel`, if any. */
export function fontPackOf(kernel: object): FontPackLoader | null {
  return KERNEL_PACKS.get(kernel) ?? null;
}

/** Display lists kept per document (each holds its Path2D and glyph caches). */
const LIST_CACHE = 48;
/** Revisions whose page hashes are remembered (undo/redo moves among them). */
const HASH_CACHE = 8;

/**
 * Cache key of one revision: its index and sha256. The index separates two
 * revisions with the same bytes made at different clocks (a live clock), which
 * the kernel lays out with their own clock.
 */
export function revisionKey(state: { revision: number; sha256: string }): string {
  return `${state.revision}:${state.sha256}`;
}

export type VectorPage = {
  /** Revision (`revisionKey`) the display list belongs to. */
  revision: string;
  /** Page hash of the display list (`display_list.page_hash`): what the page draws. */
  hash: string;
  dl: DisplayList;
  /** `display_list` call plus `prepare` (faces and images fetched by handle). */
  loadMs: number;
};

/**
 * Why a painted page must be shown as the engine's PNG instead, or null when
 * it is vector-safe (INTEGRATION.md, "What falls back"). An image the browser
 * cannot decode keeps vector: the renderer draws a frame where the engine does.
 */
export function fallbackReason(dl: DisplayList, stats: RenderStats): string | null {
  const unknown = Object.keys(dl.unknown);
  if (unknown.length) return `display list holds ${unknown.join(", ")}, which the vector renderer does not model`;
  if (stats.text.fallback > 0) return `${stats.text.fallback} text runs had no font face (drawn in a browser family)`;
  for (const key of Object.keys(stats.skipped)) {
    if (key.startsWith("image not decodable")) continue;
    return `drawn approximately: ${key}`;
  }
  return null;
}

export class VectorDoc {
  readonly doc: DocId;
  readonly cache: ResourceCache;
  readonly #kernel: ReactorKernelClient;
  readonly #hashes = new Map<string, Promise<string[]>>();
  readonly #lists = new Map<string, Promise<VectorPage>>();
  /** Page hash -> reason it is shown as PNG. */
  readonly fallbacks = new Map<string, string>();
  #disposed = false;

  constructor(kernel: ReactorKernelClient, store: ResourceStore, doc: DocId) {
    this.#kernel = kernel;
    this.doc = doc;
    this.cache = new ResourceCache(store);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Page hashes of the revision `rev` (`layoutInfo`, cached in the module after an apply). */
  hashes(rev: string): Promise<string[]> {
    let hashes = this.#hashes.get(rev);
    if (!hashes) {
      hashes = this.#kernel.layoutInfo(this.doc).then((info) => info.page_hashes);
      this.#hashes.set(rev, hashes);
      hashes.catch(() => this.#hashes.delete(rev));
      if (this.#hashes.size > HASH_CACHE) this.#hashes.delete(this.#hashes.keys().next().value!);
    }
    return hashes;
  }

  /** Display list of `page` in the current revision `rev`, with its resources loaded. */
  page(page: number, rev: string): Promise<VectorPage> {
    const key = `${rev}#${page}`;
    const known = this.#lists.get(key);
    if (known) {
      // Most recently used last.
      this.#lists.delete(key);
      this.#lists.set(key, known);
      return known;
    }
    const started = performance.now();
    const loading = (async (): Promise<VectorPage> => {
      const raw = await this.#kernel.displayList(this.doc, page);
      const dl = parseDisplayList(raw as unknown as Json);
      if (this.#disposed) throw new Error("document closed");
      await this.cache.prepare(dl);
      return { revision: rev, hash: raw.page_hash, dl, loadMs: performance.now() - started };
    })();
    this.#lists.set(key, loading);
    loading.catch(() => this.#lists.delete(key));
    if (this.#lists.size > LIST_CACHE) this.#lists.delete(this.#lists.keys().next().value!);
    return loading;
  }

  /** Faces of the whole laid-out document with licence entries; also gives `usedFaces` its licence data. */
  async fonts(): Promise<FaceInfo[]> {
    const info = parseFonts((await this.#kernel.fonts(this.doc)) as unknown as Json);
    this.cache.store.noteFonts(info);
    return info.faces;
  }

  /** Faces drawn on the pages shown so far. */
  usedFaces(): UsedFace[] {
    return this.cache.usedFaces();
  }

  dispose(): void {
    this.#disposed = true;
    this.#lists.clear();
    this.#hashes.clear();
    this.cache.dispose();
  }
}

export type LicenceText = { ok: true; text: string } | { ok: false; error: KernelError };

export class VectorPages {
  readonly kernel: ReactorKernelClient;
  readonly store: ResourceStore;
  #doc: VectorDoc | null = null;

  constructor(kernel: ReactorKernelClient) {
    this.kernel = kernel;
    this.store = new ResourceStore(async (handle) => parseResource((await kernel.resource(handle)) as unknown as Json), {
      fontPack: () => fontPackOf(kernel),
      onFontLoaded: () => this.repaint(),
    });
  }

  /** Paint again the open document's canvases that drew stand-ins for pack faces; returns how many. */
  repaint(): number {
    return this.#doc?.disposed === false ? this.#doc.cache.repaint() : 0;
  }

  /** The document's vector state; opening another document disposes the previous one's. */
  forDoc(doc: DocId): VectorDoc {
    if (this.#doc?.doc === doc) return this.#doc;
    this.#doc?.dispose();
    this.#doc = new VectorDoc(this.kernel, this.store, doc);
    return this.#doc;
  }

  /** The open document's state, if pages were drawn for it. */
  current(doc: DocId | undefined): VectorDoc | null {
    return doc && this.#doc?.doc === doc ? this.#doc : null;
  }

  /** The host closed its document. */
  closeDoc(): void {
    this.#doc?.dispose();
    this.#doc = null;
  }

  /**
   * Licence text of a bundled face by its `license_file` path, through
   * `ResourceStore.licenseText` (cached per store). Module builds without
   * licence files answer `unknown-resource`.
   */
  async licence(path: string): Promise<LicenceText> {
    try {
      return { ok: true, text: await this.store.licenseText(path) };
    } catch (cause) {
      return { ok: false, error: toKernelError(cause) };
    }
  }

  dispose(): void {
    this.closeDoc();
    this.store.dispose();
  }
}
