/**
 * Environment-neutral reactor kernel: the frozen `KernelClient` (plus the
 * `ReactorKernelClient` layout calls) over one long-lived `wolf_web.wasm`
 * instance. No DOM, Node or Worker APIs here; `worker.ts` and `node.ts`
 * wrap it.
 *
 * Revision store. Every revision keeps its file bytes, so
 * `undo`/`redo`/`goto`/`save`/`session` never run the engine. The module
 * holds one document per handle and `apply` mutates a handle in place, so a
 * handle is a disposable cache of one revision: it carries that revision's
 * layout (lowered display list), which costs 10 to 440 ms to rebuild, while
 * re-opening a handle from the retained bytes costs 0.1 to 0.6 ms
 * (measured). Handles live in a kernel-wide LRU (`maxHandles`, default 8);
 * an evicted or trap-lost handle is re-opened on demand. `apply` opens a
 * fresh handle from the base bytes, applies there, and keeps the base handle
 * (and its layout) for undo and for the `diff` the contract requires.
 *
 * The first instance is checked against version 1 of the ABI
 * (`docs/wolf-web-reactor-abi.md`, "Compatibility"): imports, exports and
 * their parameter counts, the `version` reply and every command the kernel
 * needs. A module that fails the check refuses every call with
 * `engine-incompatible`; a command the module answers `unknown cmd` (one of
 * the optional ones) refuses with `unsupported`.
 *
 * A trap drops the whole instance (its heap is no longer trustworthy); the
 * next call instantiates a new one from the compiled module and re-opens
 * handles from the retained bytes, so the revision store survives.
 */
import {
  KernelRequestError,
  type ApplyResult,
  type BatchEnvironment,
  type Change,
  type DiffResult,
  type DocFormat,
  type DocId,
  type DocState,
  type EngineRun,
  type KernelError,
  type KernelWarning,
  type Op,
  type PageImage,
  type PageInfo,
  type PageChanges,
  type QueryResult,
  type Region,
  type SessionLog,
  type Timings,
  type TransactionSummary,
  type ViewNode,
  type CaretRects,
  type DisplayList,
  type HitTest,
  type FontReport,
  type LayoutInfo,
  type Resource,
  type ReactorKernelClient,
  type SheetViewport,
  type TextLayout,
} from "@wolfsdk/protocol";
import { EngineLoadError } from "../loader.ts";
import {
  EngineIncompatible,
  PINNED,
  Reactor,
  ReactorTrap,
  checkEngine,
  isUnknownCommand,
  lowerExtractArgs,
  lowerObserveArgs,
  type ApplyPages,
  type ApplyResponse,
  type EngineInfo,
  type EngineResponse,
  type ModuleError,
  type OpenResponse,
  type Receipt,
  type RenderResponse,
  type Response,
  type SaveResponse,
} from "./abi.ts";

export type { EngineInfo } from "./abi.ts";

export type ReactorEnvironment = {
  /** ISO instant, or `"live"` to stamp each apply with the current time. */
  clock?: "live" | string;
  /** IANA zone. */
  timezone?: string;
  /** BCP 47 tag. */
  locale?: string;
  seed?: number;
};

export type ReactorKernelOptions = {
  /** Run environment. Default pinned: clock `2026-01-01T00:00:00Z`, `UTC`,
   * `en-US`, seed 0. `clock: "live"` stamps each apply with the current
   * second and (unless `timezone` is given) the runtime's IANA zone;
   * `session()` records both per batch. Malformed values, and a zone the
   * module does not know (checked for every format), refuse with the
   * module's `bad-determinism`. */
  environment?: ReactorEnvironment;
  /** DPI reported by `open`/`apply` (`PageInfo.dpi`, `bbox_px`). Default 150. */
  renderDpi?: number;
  /** `lazy` (default): `open`/`apply` lay out at 1 DPI for regions and page
   * sizes; PNGs come from `page()`. `eager`: render every page at
   * `renderDpi` during `open`/`apply`. */
  render?: "lazy" | "eager";
  /** Module document handles kept open across all documents (>= 2).
   * Default 8. */
  maxHandles?: number;
  /** Bound on cached page PNGs across documents, in bytes (LRU). Pages are
   * keyed by the module's page hash, so a page unchanged by an edit (and
   * every page after undo/redo/goto) is served from this cache. Default
   * 64 MiB. */
  pngCacheBytes?: number;
  /** Display lists kept (LRU, keyed by revision, page and page hash). Default 64. */
  displayListCacheEntries?: number;
  /** Linear-memory ceiling, used to classify an allocation trap as
   * `wasm-memory-limit`. Default 4 GiB (the module links no cap). */
  memoryLimitBytes?: number;
};

export type ModuleSource = WebAssembly.Module | (() => Promise<WebAssembly.Module>);

/** `damageReport`: the module's `damage_report` run on one revision. */
export type DamageReportResult = {
  /** The receipt `wolf damage-report` prints, untouched. Exit code 0 is a
   * complete report, 1 a partial one: no baseline tool runs inside the
   * module, so each baseline is reported `not-run`. */
  receipt: Record<string, unknown>;
  /** The report files, `/mem/out/damage-report.json` and
   * `/mem/out/damage-report.md`, sorted by path. */
  outputs: { path: string; data: Uint8Array }[];
  timings: Timings;
};

/** `ReactorKernelClient` plus diagnostics used by tools. */
export type ReactorEngineKernel = ReactorKernelClient & {
  /** Clock and zone revision `revision` of `doc` was produced with. */
  revisionEnvironment(doc: DocId, revision: number): Required<BatchEnvironment>;
  /** Run the module's `damage_report` on the current revision of `doc`
   * (ABI `damage_report`: Wolf's no-op save and, for XLSX, its
   * recalculation, compared with the original). Leaves the document
   * unchanged. A module without the command rejects with `unsupported`; a
   * refused report (exit 2, 3 or 4) rejects with the receipt's first error. */
  damageReport(doc: DocId): Promise<DamageReportResult>;
  /** Test hook: make the live instance trap for real (as an engine bug
   * would). Resolves with the classified error; the next call
   * re-instantiates and restores every open document (sha256 checked). */
  debugTrap(): Promise<KernelError>;
  stats(): Promise<ReactorStats>;
};

export type ReactorStats = {
  /** Open module handles. */
  handles: number;
  /** Linear memory of the live instance (0 when none). */
  memoryBytes: number;
  /** Instances created (1 + restarts after traps). */
  instances: number;
  /** Documents checked by sha256 after re-instantiation, and failures. */
  restored: number;
  restoreFailures: { doc: DocId; error: KernelError }[];
  pngCache: { entries: number; bytes: number; limitBytes: number; hits: number; misses: number };
  displayListCache: { entries: number; limit: number; hits: number; misses: number };
  resources: number;
  environment: { clock: string; timezone: string; locale: string; seed: number };
  /** `determinism` member of the most recent engine receipt (the native
   * receipt's member: clock, timezone, locale, seed, system fonts, font
   * directories). */
  lastDeterminism: Record<string, unknown> | null;
  /** Build, default determinism and commands of the module, from the
   * start-up check; null before the first instance. */
  engine: EngineInfo | null;
};

const DEFAULT_DPI = 150;
const DEFAULT_MAX_HANDLES = 8;
const DEFAULT_PNG_CACHE = 64 * 1024 * 1024;
const DEFAULT_LIST_CACHE = 64;
const DEFAULT_MEMORY_LIMIT = 4 * 1024 * 1024 * 1024;
const WASM_PAGE = 65536;
const FORMATS: readonly DocFormat[] = ["docx", "pptx", "xlsx"];
const VIEW_SCHEMA = "agent-api.v1.view";
const OUT_PREFIX = "/mem/out/";
const LAYOUT_DPI = 1;
const decoder = new TextDecoder();

type TimingKey = "observeMs" | "transactMs" | "diffMs" | "renderMs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Thrown inside a call when a run refuses; carries all errors. */
class Refusal extends Error {
  readonly errors: KernelError[];
  constructor(errors: KernelError[]) {
    super(errors[0]?.message ?? "refused");
    this.errors = errors;
  }
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new Refusal([{ code, message, ...extra }]);
}

/** ASCII-safe document name. */
export function sandboxName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base || "document";
}

function pngSize(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pageOfPath(path: string): number | null {
  const m = /-(\d+)\.png$/.exec(path);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Exact-size copy whose buffer can be transferred. */
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.slice();
}

function classifyTrap(trap: ReactorTrap, limit: number): KernelError {
  const tail = trap.stderr.trim().split("\n").slice(-5).join("\n");
  const message = tail ? `${trap.message}\n${tail}` : trap.message;
  const allocFailure = /memory allocation of \d+ bytes failed|out of memory|capacity overflow/i.test(trap.stderr);
  const growFailure = trap.cause instanceof RangeError && /memory/i.test(trap.cause.message);
  const atCeiling = trap.memoryBytes >= limit - 2 * WASM_PAGE;
  if (allocFailure || growFailure || atCeiling) {
    return { code: "wasm-memory-limit", message, memory_bytes: trap.memoryBytes, memory_limit_bytes: limit };
  }
  return { code: "wasm-trap", message, memory_bytes: trap.memoryBytes };
}

/** Module refusal codes -> kernel codes (contract `KernelError`).
 * `bad-determinism` stays its own code: a clock, zone, locale or seed the
 * engine does not accept. */
function moduleError(cmd: string, error: ModuleError): KernelError {
  const code =
    error.code === "bad-page"
      ? "page-unknown"
      : error.code === "bad-request"
        ? "usage"
        : error.code === "unknown-doc"
          ? "kernel-internal"
          : error.code;
  return code === error.code
    ? { ...error, message: `${cmd}: ${error.message}` }
    : { ...error, code, message: `${cmd}: ${error.message}`, module_code: error.code };
}

/** Pages that differ between the base revision's page hashes and an
 * apply's relayout (`apply.pages`), compared here against the hashes the
 * client holds for the base. `null` (unknown: lay out when the pages are
 * next shown) when the apply did not relay out (`pages: null`, XLSX) or the
 * base was never laid out. The module's own `changed` is not used: it
 * compares against the last layout the module computed for the handle,
 * which is not necessarily the base (`compared: false` when there was none). */
function changesBetween(base: string[] | null, pages: ApplyPages | null): PageChanges | null {
  if (!base || !pages || !Array.isArray(pages.hashes)) return null;
  const count = pages.count ?? pages.hashes.length;
  const changed: number[] = [];
  pages.hashes.forEach((h, i) => {
    if (h !== base[i]) changed.push(i + 1);
  });
  const removed: number[] = [];
  for (let p = count + 1; p <= base.length; p++) removed.push(p);
  return { count, changed, removed };
}

/** A response minus the module's envelope, plus `timings`. */
function result<T>(res: Response, timings: Timings): T {
  const { ok: _ok, ms: _ms, error: _error, ...rest } = res;
  return { ...rest, timings } as T;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

type Snapshot = {
  nodes: ViewNode[];
  childIds: Record<string, string[]>;
  pages: PageInfo[];
  regions: Region[];
  unrendered: string[];
  truncated: boolean;
  viewMeta: Record<string, unknown>;
  warnings: KernelWarning[];
};

/** One observe with its page PNGs at the render DPI. */
type Observed = Snapshot & { pngs: Map<number, Uint8Array> };

type Revision = {
  bytes: Uint8Array;
  sha256: string;
  snapshot: Snapshot;
  /** Page renders keyed `${page}@${dpi}`, with their regions at that DPI. */
  renders: Map<string, { png: Uint8Array; regions: Region[] }>;
  /** Ops that produced this revision from the previous one (null for 0). */
  batch: Op[] | null;
  /** Open module handle holding these bytes, or null. */
  handle: number | null;
  /** Clock and zone this revision was produced (and is observed) under. */
  env: RunEnv;
  /** The module's page hashes for this revision (`layout.page_hashes`,
   * `apply.pages.hashes`), once it has been laid out. */
  pageHashes: string[] | null;
};

type Doc = {
  id: DocId;
  name: string;
  format: DocFormat;
  originalSha256: string;
  revisions: Revision[];
  cursor: number;
};

type CallCtx = { start: number; compileMs: number; runs: EngineRun[]; perVerb: Partial<Record<TimingKey, number>> };
type RunEnv = { clock: string; timezone: string };

/** Now, to the second (`2026-11-12T09:30:00Z`). */
function nowInstant(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The runtime's IANA zone, `UTC` when `Intl` reports none or an unknown one. */
function runtimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "Etc/Unknown" && knownZone(zone) ? zone : PINNED.timezone;
  } catch {
    return PINNED.timezone;
  }
}

const zoneChecks = new Map<string, boolean>();
/** Whether the JavaScript runtime knows `zone` (IANA). */
function knownZone(zone: string): boolean {
  let ok = zoneChecks.get(zone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      ok = true;
    } catch {
      ok = false;
    }
    zoneChecks.set(zone, ok);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

export function createReactorEngineKernel(
  source: ModuleSource,
  options: ReactorKernelOptions = {},
): ReactorEngineKernel {
  const renderDpi = options.renderDpi ?? DEFAULT_DPI;
  const lazy = (options.render ?? "lazy") === "lazy";
  const maxHandles = Math.max(2, options.maxHandles ?? DEFAULT_MAX_HANDLES);
  const memoryLimit = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT;
  const environment = options.environment ?? {};
  const live = environment.clock === "live";
  const fixedClock = live ? null : (environment.clock ?? PINNED.clock);
  const timezone = environment.timezone ?? (live ? runtimeZone() : PINNED.timezone);
  const locale = environment.locale ?? PINNED.locale;
  const seed = environment.seed ?? PINNED.seed;
  /** Environment of a new run: the fixed clock, or now. */
  const freshEnv = (): RunEnv => ({ clock: fixedClock ?? nowInstant(), timezone });
  /** Determinism members of a module request (ABI "Determinism members").
   * The module validates them for every format and refuses with
   * `bad-determinism`. */
  const determinism = (e: RunEnv) => ({ clock: e.clock, timezone: e.timezone, locale, seed });

  let modulePromise: Promise<WebAssembly.Module> | null =
    source instanceof WebAssembly.Module ? Promise.resolve(source) : null;
  let reactor: Reactor | null = null;
  let instances = 0;
  let restored = 0;
  /** `determinism` member of the most recent engine receipt. */
  let lastDeterminism: Record<string, unknown> | null = null;
  /** What the start-up check learned about the module, once it passed. */
  let engineInfo: EngineInfo | null = null;
  /** The start-up check's refusal: the module is never instantiated again. */
  let incompatible: KernelError | null = null;
  const restoreFailures: { doc: DocId; error: KernelError }[] = [];
  /** Page PNGs by `${pageHash}@${dpi}` (LRU, bytes bounded). */
  const pngCache = new Map<string, Uint8Array>();
  let pngCacheBytes = 0;
  const pngLimit = options.pngCacheBytes ?? DEFAULT_PNG_CACHE;
  /** Display lists (LRU) by revision bytes, environment, page and page hash;
   * `page` and `timings` are per call. Not by page hash alone: the hash covers
   * what the page draws, not its source tags (`object_id`, offsets) or table
   * indices, which differ between revisions that draw the same page. */
  const listCache = new Map<string, DisplayList>();
  const listLimit = Math.max(1, options.displayListCacheEntries ?? DEFAULT_LIST_CACHE);
  const cacheStats = { pngHits: 0, pngMisses: 0, listHits: 0, listMisses: 0 };
  /** Resources by handle (content hashes; valid for the instance's life and,
   * being content addressed, across instances). */
  const resources = new Map<string, Resource>();
  /** Open module handles, least recently used first. */
  const handles = new Map<number, Revision>();
  const docs = new Map<DocId, Doc>();
  let nextDoc = 1;
  let queue: Promise<unknown> = Promise.resolve();

  /** Serialise every call: a call starts only after the previous settled. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const out = queue.then(fn, fn);
    queue = out.catch(() => undefined);
    return out;
  }

  function newCtx(): CallCtx {
    return { start: performance.now(), compileMs: 0, runs: [], perVerb: {} };
  }

  function timings(ctx: CallCtx): Timings {
    const t: Timings = {
      compileMs: round(ctx.compileMs),
      totalMs: round(performance.now() - ctx.start),
      runs: ctx.runs,
    };
    for (const [key, ms] of Object.entries(ctx.perVerb)) t[key as TimingKey] = round(ms);
    return t;
  }

  /** Compile (once), instantiate (once per trap) and, on the first instance,
   * check the module against version 1 of the ABI. */
  async function getReactor(ctx: CallCtx): Promise<Reactor> {
    if (reactor) return reactor;
    if (incompatible) throw new Refusal([incompatible]);
    const t = performance.now();
    try {
      modulePromise ??= (source as () => Promise<WebAssembly.Module>)();
      let mod: WebAssembly.Module;
      try {
        mod = await modulePromise;
      } catch (e) {
        modulePromise = null;
        // A channel or download failure keeps the loader's code and URL.
        if (e instanceof EngineLoadError) fail(e.code, e.message, { argument: e.url });
        fail("wasm-compile-failed", e instanceof Error ? e.message : String(e));
      }
      let created: Reactor;
      try {
        created = await Reactor.create(mod);
        engineInfo ??= checkEngine(created);
      } catch (e) {
        if (e instanceof EngineIncompatible) {
          incompatible = { code: "engine-incompatible", message: e.message, problems: e.problems };
          throw new Refusal([incompatible]);
        }
        if (e instanceof ReactorTrap) throw new Refusal([classifyTrap(e, memoryLimit)]);
        fail("wasm-trap", `instantiation failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      }
      reactor = created;
      instances += 1;
      if (instances > 1) await restoreDocuments(ctx);
      return created;
    } finally {
      ctx.compileMs += performance.now() - t;
    }
  }

  /** After re-instantiation (a trap dropped the previous instance): re-open
   * the current revision of every open document from its retained bytes and
   * check its sha256 (`handleOf` refuses a mismatch). A document that fails
   * is closed and listed in `stats().restoreFailures`. */
  async function restoreDocuments(ctx: CallCtx): Promise<void> {
    for (const doc of [...docs.values()]) {
      try {
        await handleOf(ctx, doc, doc.revisions[doc.cursor]!);
        restored += 1;
      } catch (e) {
        docs.delete(doc.id);
        restoreFailures.push({ doc: doc.id, error: e instanceof Refusal ? e.errors[0]! : internal(e) });
      }
    }
  }

  /** Page hashes of `rev`, laying it out if no hash is known yet. */
  async function hashesOf(ctx: CallCtx, doc: Doc, rev: Revision): Promise<string[]> {
    if (rev.pageHashes) return rev.pageHashes;
    const handle = await handleOf(ctx, doc, rev);
    const res = await exec<Response & { page_hashes?: string[] }>(ctx, null, { cmd: "layout", doc: handle });
    rev.pageHashes = res.page_hashes ?? [];
    return rev.pageHashes;
  }

  function cachePng(key: string, png: Uint8Array): void {
    const old = pngCache.get(key);
    if (old) pngCacheBytes -= old.byteLength;
    pngCache.delete(key);
    if (png.byteLength > pngLimit) return;
    pngCache.set(key, png);
    pngCacheBytes += png.byteLength;
    for (const [k, v] of pngCache) {
      if (pngCacheBytes <= pngLimit) break;
      pngCache.delete(k);
      pngCacheBytes -= v.byteLength;
    }
  }

  function cachedPng(key: string): Uint8Array | undefined {
    const png = pngCache.get(key);
    if (png) {
      pngCache.delete(key);
      pngCache.set(key, png);
    }
    return png;
  }

  /** Forget the instance after a trap; revisions re-open lazily. */
  function dropInstance(): void {
    reactor = null;
    for (const rev of handles.values()) rev.handle = null;
    handles.clear();
  }

  /** One module call. Traps drop the instance and refuse; module refusals
   * become `Refusal`s, a command the module lacks `unsupported`. Engine
   * receipts are checked by `engine()`. */
  async function exec<T extends Response>(
    ctx: CallCtx,
    key: TimingKey | null,
    request: Record<string, unknown> & { cmd: string },
    inputs?: Record<string, Uint8Array>,
  ): Promise<T> {
    const r = await getReactor(ctx);
    const t = performance.now();
    let res: T;
    try {
      res = r.call<T>(request, inputs);
    } catch (e) {
      const ms = performance.now() - t;
      if (!(e instanceof ReactorTrap)) throw e;
      ctx.runs.push({ verb: request.cmd, ms: round(ms), exitCode: null, memoryBytes: e.memoryBytes });
      if (key) ctx.perVerb[key] = (ctx.perVerb[key] ?? 0) + ms;
      dropInstance();
      throw new Refusal([classifyTrap(e, memoryLimit)]);
    }
    const ms = performance.now() - t;
    const exitCode = res.receipt?.exit?.code ?? (res.ok ? 0 : 1);
    ctx.runs.push({ verb: request.cmd, ms: round(ms), exitCode, memoryBytes: r.memoryBytes });
    if (key) ctx.perVerb[key] = (ctx.perVerb[key] ?? 0) + ms;
    if (isUnknownCommand(res.error))
      fail("unsupported", `${request.cmd}: this engine module does not implement ${request.cmd}`, {
        argument: request.cmd,
        module_code: res.error!.code,
      });
    if (res.error) throw new Refusal([moduleError(request.cmd, res.error)]);
    return res;
  }

  /** The receipt of a succeeded engine run, or the run's errors.
   * `fonts: false` for runs that lay nothing out (`extract`,
   * `damage_report`): their receipt is not checked for pinned fonts.
   * `succeeded` overrides the receipt's `status === "succeeded"`. */
  function engine(cmd: string, res: Response, check: { fonts?: boolean; succeeded?: boolean } = {}): Receipt {
    const r = res.receipt;
    if (!r || typeof r !== "object") fail("engine-no-receipt", `${cmd} returned no receipt`);
    const det = r.determinism as { system_fonts?: boolean; font_dirs?: unknown[] } | undefined;
    if (check.fonts !== false && det && typeof det === "object") {
      lastDeterminism = det as Record<string, unknown>;
      // The editor's reproducibility rests on built-in fonts only.
      if (det.system_fonts !== false || (det.font_dirs?.length ?? 0) > 0)
        fail("environment-not-pinned", `${cmd} ran with system fonts or font directories`, { determinism: det });
    }
    if (!(check.succeeded ?? r.status === "succeeded")) {
      const errors: KernelError[] =
        Array.isArray(r.errors) && r.errors.length
          ? r.errors
          : [
              {
                code: `exit-${r.exit?.category ?? r.exit?.code ?? "unknown"}`,
                message: `${cmd} ${r.status ?? "failed"}`,
              },
            ];
      throw new Refusal(errors);
    }
    return r;
  }

  function touch(handle: number, rev: Revision): void {
    handles.delete(handle);
    handles.set(handle, rev);
  }

  /** Close one handle (best effort: a dropped instance has none). */
  async function closeHandle(ctx: CallCtx, rev: Revision): Promise<void> {
    const h = rev.handle;
    if (h === null) return;
    rev.handle = null;
    handles.delete(h);
    if (reactor) await exec(ctx, null, { cmd: "close", doc: h }).catch(() => undefined);
  }

  /** Register a handle and evict the least recently used beyond the cap,
   * never one listed in `keep`. */
  async function register(ctx: CallCtx, rev: Revision, handle: number, keep: Revision[] = []): Promise<void> {
    rev.handle = handle;
    touch(handle, rev);
    for (const [, old] of handles) {
      if (handles.size <= maxHandles) break;
      if (old === rev || keep.includes(old)) continue;
      await closeHandle(ctx, old);
    }
  }

  /** Open `bytes` as a new module document whose requests default to `env`. */
  async function openHandle(ctx: CallCtx, name: string, bytes: Uint8Array, env: RunEnv): Promise<OpenResponse> {
    return exec<OpenResponse>(ctx, null, { cmd: "open", name, ...determinism(env) }, { bytes });
  }

  /** The module handle holding `rev`, re-opened from its bytes if needed. */
  async function handleOf(ctx: CallCtx, doc: Doc, rev: Revision, keep: Revision[] = []): Promise<number> {
    if (rev.handle !== null && handles.has(rev.handle) && reactor) {
      touch(rev.handle, rev);
      return rev.handle;
    }
    const opened = await openHandle(ctx, doc.name, rev.bytes, rev.env);
    if (opened.sha256 !== rev.sha256) {
      await exec(ctx, null, { cmd: "close", doc: opened.doc }).catch(() => undefined);
      fail("kernel-internal", `re-opened revision has sha256 ${opened.sha256}, expected ${rev.sha256}`);
    }
    await register(ctx, rev, opened.doc, keep);
    return opened.doc;
  }

  /** observe + PNG render of every page of `handle` at `dpi`. */
  async function observeAt(ctx: CallCtx, handle: number, dpi: number) {
    const res = await exec<EngineResponse>(ctx, "observeMs", {
      cmd: "observe",
      doc: handle,
      options: { render: { to: "png", dpi } },
    });
    const r = engine("observe", res);
    const files = new Map((res.outputs ?? []).map((o) => [o.path, o.data]));
    const output = (path: string): Uint8Array => {
      const bytes = files.get(path);
      if (!bytes) fail("engine-output-missing", `receipt names ${path} but the module returned no such output`);
      return bytes;
    };
    const outputs = r.outputs ?? [];
    const viewOut = outputs.find((o) => o.schema === VIEW_SCHEMA);
    if (!viewOut) fail("engine-output-missing", "observe receipt lists no view output");
    // Engine output, `agent-api.v1.view` (agent-api.md section 4).
    const view = JSON.parse(decoder.decode(output(viewOut.path))) as {
      nodes?: ViewNode[];
      truncated?: boolean;
    } & Record<string, unknown>;
    // Every other top-level member of the view, untouched (`DocState.viewMeta`).
    const { nodes: viewNodes, truncated: viewTruncated, ...viewMeta } = view;
    const pngs = new Map<number, Uint8Array>();
    for (const o of outputs) {
      if (o.format !== "png") continue;
      const page = pageOfPath(o.path);
      if (page !== null) pngs.set(page, output(o.path));
    }
    // Render report (render-report.v1): exact page sizes in points.
    let pageSizes: { page: number; widthPt: number; heightPt: number }[] | null = null;
    const reportPath = (r.render_report as { path?: string } | undefined)?.path;
    const reportBytes = reportPath ? files.get(reportPath) : undefined;
    if (reportBytes) {
      const report = JSON.parse(decoder.decode(reportBytes)) as {
        outputs?: { pages?: { number: number; size_pt?: { width: number; height: number } }[] }[];
      };
      const listed = report.outputs?.[0]?.pages;
      if (listed?.every((p) => p.size_pt))
        pageSizes = listed.map((p) => ({ page: p.number, widthPt: p.size_pt!.width, heightPt: p.size_pt!.height }));
    }
    const observation = r.observation ?? {};
    return {
      nodes: viewNodes ?? [],
      truncated: Boolean(viewTruncated ?? observation.view?.truncated),
      viewMeta,
      regions: (observation.regions ?? []) as Region[],
      unrendered: observation.unrendered ?? [],
      warnings: r.warnings ?? [],
      pngs,
      pageSizes,
    };
  }

  /** The open/apply view of `handle`. Lazy (default): lay out at 1 DPI for
   * regions and page sizes and derive `PageInfo` / `bbox_px` at `renderDpi`;
   * PNGs come from `page()`. Eager, or a module without a render report:
   * render every page at `renderDpi`. */
  async function observeHandle(ctx: CallCtx, handle: number): Promise<Observed> {
    let o = await observeAt(ctx, handle, lazy ? LAYOUT_DPI : renderDpi);
    let pages: PageInfo[];
    let regions: Region[];
    if (lazy && o.pageSizes) {
      // Raster size at `renderDpi`: the engine rounds up (`ceil(pt * dpi /
      // 72)`); `bbox_px` is `bbox_pt * (dpi / 72)`.
      pages = o.pageSizes
        .map(({ page, widthPt, heightPt }) => {
          const widthPx = Math.ceil((widthPt * renderDpi) / 72);
          const heightPx = Math.ceil((heightPt * renderDpi) / 72);
          return {
            page,
            widthPx,
            heightPx,
            widthPt: (widthPx * 72) / renderDpi,
            heightPt: (heightPx * 72) / renderDpi,
            dpi: renderDpi,
          };
        })
        .sort((a, b) => a.page - b.page);
      const scale = renderDpi / 72;
      regions = o.regions.map((r) => ({
        ...r,
        bbox_px: [r.bbox_pt[0] * scale, r.bbox_pt[1] * scale, r.bbox_pt[2] * scale, r.bbox_pt[3] * scale],
      }));
      o.pngs.clear();
    } else {
      if (lazy) o = await observeAt(ctx, handle, renderDpi);
      pages = [...o.pngs.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, png]) => {
          const { width, height } = pngSize(png);
          return {
            page,
            widthPx: width,
            heightPx: height,
            widthPt: (width * 72) / renderDpi,
            heightPt: (height * 72) / renderDpi,
            dpi: renderDpi,
          };
        });
      regions = o.regions;
    }
    const childIds: Record<string, string[]> = {};
    for (const n of o.nodes) (childIds[n.parent ?? ""] ??= []).push(n.id);
    return {
      nodes: o.nodes,
      childIds,
      pages,
      regions,
      unrendered: o.unrendered,
      truncated: o.truncated,
      viewMeta: o.viewMeta,
      warnings: o.warnings,
      pngs: o.pngs,
    };
  }

  function newRevision(bytes: Uint8Array, sha256: string, batch: Op[] | null, o: Observed, env: RunEnv): Revision {
    const { pngs, ...snapshot } = o;
    const renders = new Map<string, { png: Uint8Array; regions: Region[] }>();
    for (const [page, png] of pngs)
      renders.set(`${page}@${renderDpi}`, { png, regions: snapshot.regions.filter((r) => r.page === page) });
    return { bytes, sha256, snapshot, renders, batch, handle: null, env, pageHashes: null };
  }

  function getDoc(id: DocId): Doc {
    const doc = docs.get(id);
    if (!doc) fail("doc-unknown", `no open document ${id}`);
    return doc;
  }

  function stateOf(doc: Doc, ctx: CallCtx): DocState {
    const rev = doc.revisions[doc.cursor]!;
    return {
      doc: doc.id,
      name: doc.name,
      format: doc.format,
      revision: doc.cursor,
      revisionCount: doc.revisions.length,
      canUndo: doc.cursor > 0,
      canRedo: doc.cursor < doc.revisions.length - 1,
      sha256: rev.sha256,
      ...rev.snapshot,
      timings: timings(ctx),
    };
  }

  function internal(e: unknown): KernelError {
    return { code: "kernel-internal", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }

  /** Wrap a call: serialise, check the environment, and turn every failure
   * into a KernelRequestError. */
  function call<T>(fn: (ctx: CallCtx) => Promise<T>): Promise<T> {
    return serial(async () => {
      const ctx = newCtx();
      try {
        return await fn(ctx);
      } catch (e) {
        if (e instanceof Refusal) throw new KernelRequestError(e.errors[0]!);
        if (e instanceof KernelRequestError) throw e;
        throw new KernelRequestError(internal(e));
      }
    });
  }

  /** A document-scoped module reply, stamped with the revision it was read
   * from as `DocState` names it. The module's `revision` member (sheet
   * viewport) counts commits on one handle; each revision lives in its own
   * handle here, so it is replaced, never passed through. */
  function ofRevision<T>(res: Response, ctx: CallCtx, revision: number, rev: Revision): T {
    return { ...result<Record<string, unknown>>(res, timings(ctx)), revision, sha256: rev.sha256 } as T;
  }

  /** A reactor layout call on the current revision of `id`. */
  function layoutCall<T>(
    id: DocId,
    request: (handle: number) => Record<string, unknown> & { cmd: string },
  ): Promise<T> {
    return call(async (ctx) => {
      const doc = getDoc(id);
      const revision = doc.cursor;
      const rev = doc.revisions[revision]!;
      const handle = await handleOf(ctx, doc, rev);
      const res = await exec(ctx, null, request(handle));
      return ofRevision<T>(res, ctx, revision, rev);
    });
  }

  return {
    kind: "reactor",

    open: (bytes, name) =>
      call(async (ctx) => {
        const safe = sandboxName(name);
        const copy = own(bytes);
        await getReactor(ctx);
        const env0 = freshEnv();
        const opened = await openHandle(ctx, safe, copy, env0);
        let committed = false;
        try {
          if (!FORMATS.includes(opened.format as DocFormat))
            fail("format-unsupported", `engine read ${name} as ${opened.format}; the editor handles docx, pptx, xlsx`);
          const o = await observeHandle(ctx, opened.doc);
          const revision = newRevision(copy, opened.sha256, null, o, env0);
          const doc: Doc = {
            id: `doc-${nextDoc++}`,
            name: safe,
            format: opened.format as DocFormat,
            originalSha256: opened.sha256,
            revisions: [revision],
            cursor: 0,
          };
          await register(ctx, revision, opened.doc);
          committed = true;
          docs.set(doc.id, doc);
          return stateOf(doc, ctx);
        } finally {
          if (!committed && reactor) await exec(ctx, null, { cmd: "close", doc: opened.doc }).catch(() => undefined);
        }
      }),

    apply: (id: DocId, ops: Op[], at?: BatchEnvironment) =>
      serial(async (): Promise<ApplyResult> => {
        const ctx = newCtx();
        let fresh: number | null = null;
        try {
          const doc = getDoc(id);
          const base = doc.revisions[doc.cursor]!;
          const baseHandle = await handleOf(ctx, doc, base);
          // Apply on a fresh copy of the base so the base handle (and its
          // layout) stays for undo and for the diff below.
          const runEnv: RunEnv = { clock: at?.clock ?? freshEnv().clock, timezone: at?.timezone ?? timezone };
          const opened = await openHandle(ctx, doc.name, base.bytes, runEnv);
          fresh = opened.doc;
          // DOCX/PPTX: `relayout: true` lays the new revision out inside the
          // call and returns its page hashes, so unchanged pages keep their
          // images. XLSX: no relayout (the grid reads `sheet_viewport`); the
          // printed pages are laid out when shown, `pageChanges` is null.
          const relayout = doc.format !== "xlsx";
          const tx = await exec<ApplyResponse>(ctx, "transactMs", {
            cmd: "apply",
            doc: fresh,
            ops,
            relayout,
            ...determinism(runEnv),
          });
          const receipt = engine("apply", tx);
          const transaction = receipt.transaction as TransactionSummary | undefined;
          if (!transaction) fail("engine-no-receipt", "apply receipt has no transaction summary");
          if (!tx.committed) fail("engine-output-missing", "apply succeeded but did not commit");
          const saved = await exec<SaveResponse>(ctx, null, { cmd: "save", doc: fresh });
          const o = await observeHandle(ctx, fresh);
          const df = await exec<EngineResponse>(ctx, "diffMs", {
            cmd: "diff",
            doc: baseHandle,
            against: fresh,
            ...determinism(runEnv),
          });
          const diff = (engine("diff", df).diff?.changes ?? []) as Change[];
          // Commit only after every run succeeded; drop the redo tail.
          const revision = newRevision(saved.bytes, saved.sha256, structuredClone(ops), o, runEnv);
          revision.pageHashes = tx.pages?.hashes ?? null;
          const pageChanges = changesBetween(base.pageHashes, tx.pages ?? null);
          for (const dropped of doc.revisions.splice(doc.cursor + 1)) await closeHandle(ctx, dropped);
          doc.revisions.push(revision);
          doc.cursor += 1;
          await register(ctx, revision, fresh, [base]);
          fresh = null;
          return { ok: true, state: stateOf(doc, ctx), diff, transaction, pageChanges };
        } catch (e) {
          if (fresh !== null && reactor) await exec(ctx, null, { cmd: "close", doc: fresh }).catch(() => undefined);
          if (e instanceof Refusal) return { ok: false, error: e.errors[0]!, errors: e.errors, timings: timings(ctx) };
          const error = internal(e);
          return { ok: false, error, errors: [error], timings: timings(ctx) };
        }
      }),

    undo: (id) =>
      call(async (ctx) => {
        const doc = getDoc(id);
        if (doc.cursor > 0) doc.cursor -= 1;
        return stateOf(doc, ctx);
      }),

    redo: (id) =>
      call(async (ctx) => {
        const doc = getDoc(id);
        if (doc.cursor < doc.revisions.length - 1) doc.cursor += 1;
        return stateOf(doc, ctx);
      }),

    goto: (id, revision) =>
      call(async (ctx) => {
        const doc = getDoc(id);
        if (!Number.isInteger(revision) || revision < 0 || revision >= doc.revisions.length) {
          fail("revision-out-of-range", `revision ${revision} is outside 0..${doc.revisions.length - 1}`, {
            argument: String(revision),
          });
        }
        doc.cursor = revision;
        return stateOf(doc, ctx);
      }),

    page: (id, page, scale) =>
      call(async (ctx): Promise<PageImage> => {
        const doc = getDoc(id);
        const rev = doc.revisions[doc.cursor]!;
        if (!rev.snapshot.pages.some((p) => p.page === page)) {
          fail("page-unknown", `revision ${doc.cursor} rendered no page ${page}`, { argument: String(page) });
        }
        if (!(scale > 0) || !Number.isFinite(scale))
          fail("usage", `scale must be a positive number, got ${scale}`, { argument: String(scale) });
        const dpi = Math.max(1, Math.round(72 * scale));
        // Eager renders live on the revision; everything else in the
        // page-hash cache shared by all revisions and documents.
        let png = rev.renders.get(`${page}@${dpi}`)?.png;
        const hash = rev.pageHashes?.[page - 1];
        if (!png && hash) png = cachedPng(`${hash}@${dpi}`);
        let source: PageImage["source"] = "cache";
        if (png) cacheStats.pngHits += 1;
        else {
          cacheStats.pngMisses += 1;
          const handle = await handleOf(ctx, doc, rev);
          const res = await exec<RenderResponse>(ctx, "renderMs", {
            cmd: "render_page_png",
            doc: handle,
            page,
            scale: dpi / 72,
          });
          png = res.png;
          // The render laid the revision out: its hashes are now one cached
          // `layout` call away.
          const hashes = await hashesOf(ctx, doc, rev);
          if (hashes[page - 1]) cachePng(`${hashes[page - 1]}@${dpi}`, png);
          source = "render";
        }
        // Region boxes do not depend on the resolution: `bbox_px` is
        // `bbox_pt * dpi / 72` (the engine's own rule, verified exact at
        // 150 DPI on every fixture region).
        const regions = rev.snapshot.regions
          .filter((r) => r.page === page)
          .map((r) => ({ ...r, bbox_px: r.bbox_pt.map((v) => (v * dpi) / 72) as Region["bbox_px"] }));
        const { width, height } = pngSize(png);
        return {
          page,
          png: own(png),
          widthPx: width,
          heightPx: height,
          dpi,
          scale: dpi / 72,
          requestedScale: scale,
          source,
          regions,
          timings: timings(ctx),
        };
      }),

    save: (id) =>
      call(async () => {
        const doc = getDoc(id);
        return own(doc.revisions[doc.cursor]!.bytes);
      }),

    session: (id) =>
      call(async (): Promise<SessionLog> => {
        const doc = getDoc(id);
        const env0 = doc.revisions[0]!.env;
        const batches = doc.revisions.slice(1, doc.cursor + 1).map((rev, i) => ({
          ops: structuredClone(rev.batch!),
          baseSha256: doc.revisions[i]!.sha256,
          resultSha256: rev.sha256,
          ...(rev.env.clock !== env0.clock || rev.env.timezone !== env0.timezone
            ? { clock: rev.env.clock, timezone: rev.env.timezone }
            : {}),
        }));
        return {
          name: doc.name,
          format: doc.format,
          originalSha256: doc.originalSha256,
          revision: doc.cursor,
          clock: env0.clock,
          timezone: env0.timezone,
          locale,
          seed,
          batches,
        };
      }),

    query: (id, request) =>
      call(async (ctx): Promise<QueryResult> => {
        const doc = getDoc(id);
        const verb = request?.verb as string;
        if (verb !== "observe" && verb !== "extract")
          fail("usage", `query verb must be observe or extract, got ${String(verb)}`, {
            argument: String(verb),
          });
        const args = request.args ?? [];
        if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
          fail("usage", "query args must be an array of strings");
        const lowered = verb === "observe" ? lowerObserveArgs(args) : lowerExtractArgs(args);
        if ("flag" in lowered) fail("usage", lowered.message, { argument: lowered.flag });
        const handle = await handleOf(ctx, doc, doc.revisions[doc.cursor]!);
        const res = await exec<EngineResponse>(ctx, verb === "observe" ? "observeMs" : null, {
          cmd: verb,
          doc: handle,
          options: lowered.options,
        });
        const receipt = engine(verb, res, { fonts: verb === "observe" });
        const files: QueryResult["files"] = (res.outputs ?? [])
          .filter((o) => o.path.startsWith(OUT_PREFIX))
          .map((o) => ({ name: o.path.slice(OUT_PREFIX.length), bytes: own(o.data) }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return { receipt, files, timings: timings(ctx) };
      }),

    damageReport: (id) =>
      call(async (ctx): Promise<DamageReportResult> => {
        const doc = getDoc(id);
        const handle = await handleOf(ctx, doc, doc.revisions[doc.cursor]!);
        const res = await exec<EngineResponse>(ctx, null, { cmd: "damage_report", doc: handle, options: {} });
        // `ok`: exit 0 (complete) or 1 (partial, the baselines are not run
        // inside the module); 2, 3 and 4 are refusals in the receipt.
        const receipt = engine("damage_report", res, { fonts: false, succeeded: res.ok });
        const outputs = (res.outputs ?? [])
          .map((o) => ({ path: o.path, data: own(o.data) }))
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { receipt, outputs, timings: timings(ctx) };
      }),

    diff: (before, after) =>
      call(async (ctx): Promise<DiffResult> => {
        const env = freshEnv();
        // Two handles outside the LRU, closed before the call returns. The
        // module reads the format from the content, so the names carry none.
        const opened: number[] = [];
        try {
          opened.push((await openHandle(ctx, "before", before, env)).doc);
          opened.push((await openHandle(ctx, "after", after, env)).doc);
          const df = await exec<EngineResponse>(ctx, "diffMs", {
            cmd: "diff",
            doc: opened[0],
            against: opened[1],
            ...determinism(env),
          });
          return { changes: (engine("diff", df).diff?.changes ?? []) as Change[], timings: timings(ctx) };
        } finally {
          // A trap dropped the instance and its handles with it.
          for (const h of opened) if (reactor) await exec(ctx, null, { cmd: "close", doc: h }).catch(() => undefined);
        }
      }),

    close: (id) =>
      call(async (ctx) => {
        const doc = getDoc(id);
        docs.delete(id);
        for (const rev of doc.revisions) await closeHandle(ctx, rev);
      }),

    displayList: (id, page) =>
      call(async (ctx): Promise<DisplayList> => {
        const doc = getDoc(id);
        const revision = doc.cursor;
        const rev = doc.revisions[revision]!;
        const hash = rev.pageHashes?.[page - 1];
        const keyOf = (h: string) => `${rev.sha256}|${rev.env.clock}|${rev.env.timezone}#${page}@${h}`;
        const hit = hash ? listCache.get(keyOf(hash)) : undefined;
        if (hit && hash) {
          cacheStats.listHits += 1;
          listCache.delete(keyOf(hash));
          listCache.set(keyOf(hash), hit);
          // Two revisions with the same bytes share an entry: the revision is stamped per call.
          return { ...structuredClone(hit), page, revision, sha256: rev.sha256, timings: timings(ctx) };
        }
        cacheStats.listMisses += 1;
        const handle = await handleOf(ctx, doc, rev);
        const res = await exec(ctx, null, { cmd: "display_list", doc: handle, page });
        const list = ofRevision<DisplayList>(res, ctx, revision, rev);
        if (!rev.pageHashes) await hashesOf(ctx, doc, rev);
        const key = typeof list.page_hash === "string" ? keyOf(list.page_hash) : null;
        if (key) {
          listCache.set(key, structuredClone(list));
          for (const k of listCache.keys()) {
            if (listCache.size <= listLimit) break;
            listCache.delete(k);
          }
        }
        list.timings = timings(ctx);
        return list;
      }),
    layoutInfo: (id) => layoutCall<LayoutInfo>(id, (doc) => ({ cmd: "layout", doc })),
    hitTest: (id, page, xPt, yPt) =>
      layoutCall<HitTest>(id, (doc) => ({ cmd: "hit_test", doc, page, x_pt: xPt, y_pt: yPt })),
    caretRects: (id, objectId, start, end) =>
      layoutCall<CaretRects>(id, (doc) => ({
        cmd: "caret_rects",
        doc,
        object_id: objectId,
        start,
        ...(end === undefined ? {} : { end }),
      })),
    textLayout: (id, objectId) =>
      layoutCall<TextLayout>(id, (doc) => ({ cmd: "text_layout", doc, object_id: objectId })),
    fonts: (id) => layoutCall<FontReport>(id, (doc) => ({ cmd: "fonts", doc })),
    resource: (handle) =>
      call(async (ctx): Promise<Resource> => {
        let r = resources.get(handle);
        if (!r) {
          const res = await exec<Response & { bytes: Uint8Array }>(ctx, null, { cmd: "resource", handle });
          r = result<Resource>(res, timings(ctx));
          resources.set(handle, r);
        }
        return { ...r, bytes: own(r.bytes), timings: timings(ctx) };
      }),

    revisionEnvironment: (id, revision) => {
      const rev = getDoc(id).revisions[revision];
      if (!rev)
        fail("revision-out-of-range", `revision ${revision} of ${id} does not exist`, { argument: String(revision) });
      return { ...rev.env };
    },
    sheetViewport: (id, sheet, row0, col0, rows, cols) =>
      layoutCall<SheetViewport>(id, (doc) => ({ cmd: "sheet_viewport", doc, sheet, row0, col0, rows, cols })),

    debugTrap: () =>
      serial(async (): Promise<KernelError> => {
        const r = await getReactor(newCtx());
        try {
          return r.trap();
        } catch (e) {
          if (!(e instanceof ReactorTrap)) throw e;
          dropInstance();
          return classifyTrap(e, memoryLimit);
        }
      }),

    stats: () =>
      serial(async () => ({
        handles: handles.size,
        memoryBytes: reactor?.memoryBytes ?? 0,
        instances,
        restored,
        restoreFailures: [...restoreFailures],
        pngCache: {
          entries: pngCache.size,
          bytes: pngCacheBytes,
          limitBytes: pngLimit,
          hits: cacheStats.pngHits,
          misses: cacheStats.pngMisses,
        },
        displayListCache: {
          entries: listCache.size,
          limit: listLimit,
          hits: cacheStats.listHits,
          misses: cacheStats.listMisses,
        },
        resources: resources.size,
        environment: { clock: live ? "live" : fixedClock!, timezone, locale, seed },
        lastDeterminism,
        engine: engineInfo,
      })),
  };
}
