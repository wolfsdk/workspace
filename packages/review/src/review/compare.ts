/**
 * Before/after comparison. A second ("shadow") document on `host.kernel`
 * mirrors the host's history: opened from the original file bytes, with the
 * history's batches applied in order and every step checked by sha256. The
 * revision before an inspected entry is then one `goto` on the shadow (no
 * engine run), and the host's own document never moves.
 *
 * Original bytes come from `original.ts`: watched from the store's creation,
 * so they are normally kept from revision 0 without moving the host; when
 * the store first meets a document past revision 0 the module's one-time
 * goto route runs while the toggle shows "Preparing comparison". The shadow
 * must also open with the history's root sha256.
 */
import type { BatchEnvironment, DocId, DocState } from "@wolfsdk/protocol";
import type { EditorHost, HistoryEntry } from "../host/index.ts";
import { originalBytes, originalHostMoves, watchOriginal, type OriginalRoute } from "./original.ts";
import { reviewStore } from "./store.ts";

export type CompareStatus = "off" | "loading" | "ready" | "unavailable";

/** A before page: object URL owned by the store, and the page size in points. */
export type BeforePage = { url: string; widthPt: number; heightPt: number };

/** How the original bytes were obtained for the current document. */
export type BaseRoute = OriginalRoute;

export type CompareStats = {
  /** Shadow documents opened (one per build). */
  opens: number;
  /** Batches applied to the shadow. */
  applies: number;
  /** `goto` calls on the shadow. */
  gotos: number;
  /** Times the host was moved to read the original bytes. */
  hostMoves: number;
  baseRoute: BaseRoute | null;
  /** Wall time of the last shadow open, ms. */
  openMs: number;
  /** Wall time of the last mirror extension (applies only), ms. */
  mirrorMs: number;
};

/** One mirrored batch: `chain[i]` produced shadow revision `i + 1`. */
type Link = { revision: number; baseSha256: string; resultSha256: string };

const CACHE_LIMIT = 12;
const RELEASE_AFTER_MS = 30_000;
const PREPARING = "Preparing comparison";

class Stale extends Error {}
class Mismatch extends Error {}

const stores = new WeakMap<EditorHost, CompareStore>();
export const compareStore = (host: EditorHost): CompareStore => stores.get(host) ?? new CompareStore(host);

export class CompareStore {
  readonly host: EditorHost;
  enabled = false;
  /** Divider position, 0 (all after) to 1 (all before). */
  position = 0.5;
  status: CompareStatus = "off";
  /** Why the status is what it is ("Preparing comparison", or the unavailable reason). */
  reason = "";
  version = 0;
  readonly stats: CompareStats;

  private listeners = new Set<() => void>();
  /** Host document the shadow belongs to. */
  private doc: DocId | null = null;
  private shadow: DocState | null = null;
  private rootSha = "";
  private chain: Link[] = [];
  /** Host document whose comparison failed; no retry until re-enabled or another document opens. */
  private failedFor: DocId | null = null;
  /** Bumped on every teardown; in-flight work for an older value stops. */
  private gen = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private syncing = false;
  private cache = new Map<string, Promise<BeforePage | null>>();
  private urls = new Set<string>();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: EditorHost) {
    this.host = host;
    this.stats = {
      opens: 0,
      applies: 0,
      gotos: 0,
      get hostMoves() {
        return originalHostMoves(host);
      },
      baseRoute: null,
      openMs: 0,
      mirrorMs: 0,
    };
    stores.set(host, this);
    watchOriginal(host);
    host.subscribe(() => this.observe());
    reviewStore(host).subscribe(() => {
      if (this.enabled) this.schedule();
    });
    this.observe();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The shadow's current state (validated revisions only), or null. */
  get shadowState(): DocState | null {
    return this.shadow;
  }

  /** Revisions mirrored and validated so far. */
  get mirrored(): number {
    return this.chain.length;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.clearReleaseTimer();
    if (on) {
      this.failedFor = null;
      this.setStatus(this.shadow ? "ready" : "loading", this.shadow ? "" : PREPARING);
      this.schedule();
      return;
    }
    this.setStatus("off", "");
    // A quick off and on keeps the shadow; staying off closes it.
    const timer = setTimeout(() => void this.release(), RELEASE_AFTER_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.releaseTimer = timer;
  }

  setPosition(position: number): void {
    const next = Math.min(1, Math.max(0, position));
    if (next === this.position) return;
    this.position = next;
    this.bump();
  }

  /** Turn comparison off and close the shadow now. */
  dispose(): Promise<void> {
    this.enabled = false;
    this.clearReleaseTimer();
    this.setStatus("off", "");
    return this.release();
  }

  /** Page `page` of the revision before the inspected entry at `scale`
   * pixels per point, or null when that revision has no such page. Rejects
   * when comparison is off, not validated, or the inspection moved on. */
  beforePage(page: number, scale: number): Promise<BeforePage | null> {
    const entry = this.wanted();
    if (!this.enabled || !entry) return Promise.reject(new Error("Nothing to compare"));
    const sha = entry.baseSha256;
    const key = `${this.doc}|${sha}|${page}@${scale}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const gen = this.gen;
    const made = this.serial(async (): Promise<BeforePage | null> => {
      await this.syncLocked();
      const shadow = this.shadow;
      if (gen !== this.gen || this.status !== "ready" || !shadow)
        throw new Error(this.reason || "Comparison is not ready");
      if (shadow.sha256 !== sha) throw new Stale("The inspected change moved on");
      const info = shadow.pages.find((p) => p.page === page);
      if (!info) return null;
      const image = await this.host.kernel.page(shadow.doc, page, scale);
      if (gen !== this.gen) throw new Stale("The document changed");
      const url = URL.createObjectURL(new Blob([image.png], { type: "image/png" }));
      this.urls.add(url);
      return { url, widthPt: info.widthPt, heightPt: info.heightPt };
    });
    this.cache.set(key, made);
    made.catch(() => {
      if (this.cache.get(key) === made) this.cache.delete(key);
    });
    // Evict the oldest images of other revisions or scales only: every page of the document
    // asks at once, so a deck with more pages than the limit would revoke images still shown.
    const live = (k: string) => k.startsWith(`${this.doc}|${sha}|`) && k.endsWith(`@${scale}`);
    for (const [oldKey, old] of [...this.cache]) {
      if (this.cache.size <= CACHE_LIMIT) break;
      if (live(oldKey)) continue;
      this.cache.delete(oldKey);
      void old.then(
        (p) => p && this.revoke(p.url),
        () => {},
      );
    }
    return made;
  }

  // ------------------------------------------------------------ internals

  private bump(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  private setStatus(status: CompareStatus, reason: string): void {
    if (status === this.status && reason === this.reason) return;
    this.status = status;
    this.reason = reason;
    this.bump();
  }

  private clearReleaseTimer(): void {
    clearTimeout(this.releaseTimer ?? undefined);
    this.releaseTimer = null;
  }

  /** The inspected entry when the host shows its result or later. */
  private wanted(): HistoryEntry | null {
    const state = this.host.getSnapshot().state;
    const entry = reviewStore(this.host).inspectedEntry();
    return state && entry && state.revision >= entry.revision ? entry : null;
  }

  private observe(): void {
    const state = this.host.getSnapshot().state;
    const doc = state?.doc ?? null;
    if (doc !== this.doc) {
      this.doc = doc;
      this.failedFor = null;
      void this.release();
      if (this.enabled) this.setStatus(doc ? "loading" : "unavailable", doc ? PREPARING : "No document is open");
    }
    if (this.enabled) this.schedule();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Coalesce host and review changes into one sync at a time. */
  private schedule(): void {
    this.dirty = true;
    if (this.syncing) return;
    this.syncing = true;
    void (async () => {
      while (this.dirty) {
        this.dirty = false;
        await this.serial(() => this.syncLocked()).catch(() => {});
      }
      this.syncing = false;
    })();
  }

  /** Bring the shadow to the revision before the wanted entry. Runs inside `serial`. */
  private async syncLocked(): Promise<void> {
    const gen = this.gen;
    const snap = this.host.getSnapshot();
    const state = snap.state;
    if (!this.enabled || !state || this.failedFor === state.doc) return;
    try {
      if (!this.shadow) await this.build(state, gen);
      const entry = this.wanted();
      if (entry) await this.mirrorTo(entry.revision - 1, gen);
      if (gen === this.gen && this.enabled) this.setStatus("ready", "");
    } catch (cause) {
      if (cause instanceof Stale || gen !== this.gen) return;
      this.failedFor = state.doc;
      await this.closeShadow();
      const message = cause instanceof Error ? cause.message : String(cause);
      this.setStatus("unavailable", `Comparison unavailable: ${message}`);
    }
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Stale("The document changed");
  }

  /** Open the shadow from the original bytes. */
  private async build(state: DocState, gen: number): Promise<void> {
    this.setStatus("loading", PREPARING);
    const history = this.host.getSnapshot().history;
    const rootSha = history[0]?.baseSha256 ?? state.sha256;
    const original = await originalBytes(this.host);
    this.check(gen);
    if (original.sha256 !== rootSha) throw new Mismatch("the original file is not the one the history starts from");
    const started = performance.now();
    const opened = await this.host.kernel.open(original.bytes, state.name);
    this.stats.opens++;
    this.stats.openMs = Math.round(performance.now() - started);
    if (gen !== this.gen || opened.sha256 !== rootSha) {
      await this.host.kernel.close(opened.doc).catch(() => {});
      this.check(gen);
      throw new Mismatch("the original file could not be recovered (sha256 differs)");
    }
    this.stats.baseRoute = original.route;
    this.shadow = opened;
    this.rootSha = rootSha;
    this.chain = [];
  }

  /** Move the shadow to `target`, keeping the prefix that still matches the
   * host's history and re-applying the rest, each step checked by sha256. */
  private async mirrorTo(target: number, gen: number): Promise<void> {
    const kernel = this.host.kernel;
    const history = this.host.getSnapshot().history;
    const hostDoc = this.host.getSnapshot().state!.doc;
    let keep = 0;
    while (keep < this.chain.length && keep < history.length) {
      const link = this.chain[keep]!;
      const entry = history[keep]!;
      const same =
        link.revision === entry.revision &&
        link.baseSha256 === entry.baseSha256 &&
        link.resultSha256 === entry.resultSha256;
      if (!same) break;
      keep++;
    }
    this.chain.length = keep;
    const expected = (revision: number): string =>
      revision === 0 ? this.rootSha : this.chain[revision - 1]!.resultSha256;
    const moveTo = async (revision: number): Promise<void> => {
      if (this.shadow!.revision === revision && this.shadow!.sha256 === expected(revision)) return;
      const state = await kernel.goto(this.shadow!.doc, revision);
      this.stats.gotos++;
      this.check(gen);
      if (state.sha256 !== expected(revision))
        throw new Mismatch(`revision ${revision} of the copy has other contents`);
      this.shadow = state;
    };
    if (target <= keep) return moveTo(target);
    await moveTo(keep);
    this.setStatus("loading", PREPARING);
    const envs = await this.environments(hostDoc);
    this.check(gen);
    const started = performance.now();
    for (const entry of history.slice(keep, target)) {
      if (this.shadow!.sha256 !== entry.baseSha256)
        throw new Mismatch(`the copy does not start where change ${entry.revision} started`);
      const result = await kernel.apply(this.shadow!.doc, entry.ops, envs.get(entry.resultSha256));
      this.stats.applies++;
      this.check(gen);
      if (!result.ok)
        throw new Mismatch(`the engine refused change ${entry.revision} on the copy (${result.error.code})`);
      if (result.state.revision !== entry.revision || result.state.sha256 !== entry.resultSha256)
        throw new Mismatch(`change ${entry.revision} gave different file contents on the copy`);
      this.shadow = result.state;
      this.chain.push({ revision: entry.revision, baseSha256: entry.baseSha256, resultSha256: entry.resultSha256 });
    }
    this.stats.mirrorMs = Math.round(performance.now() - started);
  }

  /** Clock and zone each host batch ran with, by result sha256, so a
   * live-clock kernel reproduces the same bytes. Empty when unavailable. */
  private async environments(hostDoc: DocId): Promise<Map<string, BatchEnvironment>> {
    const envs = new Map<string, BatchEnvironment>();
    try {
      const log = await this.host.kernel.session(hostDoc);
      for (const b of log.batches)
        envs.set(b.resultSha256, { clock: b.clock ?? log.clock, timezone: b.timezone ?? log.timezone });
    } catch {
      // The host document may be closing; apply without a clock.
    }
    return envs;
  }

  private revoke(url: string): void {
    if (this.urls.delete(url)) URL.revokeObjectURL(url);
  }

  private async closeShadow(): Promise<void> {
    const shadow = this.shadow;
    this.shadow = null;
    this.chain = [];
    this.rootSha = "";
    this.cache.clear();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    if (shadow) await this.host.kernel.close(shadow.doc).catch(() => {});
  }

  /** Stop in-flight work, close the shadow and revoke its images. */
  private release(): Promise<void> {
    this.gen++;
    this.clearReleaseTimer();
    // Drop cached images now so no layer is handed one for the old shadow.
    this.cache.clear();
    return this.serial(() => this.closeShadow());
  }
}
