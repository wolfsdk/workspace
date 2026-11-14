// Shared parts of the engine-backed checks of @wolfsdk/review. Every check lives in its own file next
// to this one and exports `run(ctx, format)`; `run.ts` runs them, `scripts/engine-checks.ts` is the CLI
// and `engine.test.ts` the `bun test` entry. All of them run on the node reactor kernel of
// `@wolfsdk/runtime` against one pinned `wolf_web.wasm`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Op } from "@wolfsdk/protocol";
import { createNodeReactorKernel, DEFAULT_REACTOR_MODULE_PATH } from "@wolfsdk/runtime/node";
import type { ReactorEngineKernel, ReactorKernelOptions } from "@wolfsdk/runtime/node";

export type Format = "docx" | "pptx" | "xlsx";
export const FORMATS: readonly Format[] = ["docx", "pptx", "xlsx"];

/** The six checks, in the order the runner reports them. */
export const CHECK_IDS = [
  "review-actions",
  "comparison",
  "parts-gate",
  "subset-replay",
  "unexplained-parts",
  "submission",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** `sdk/web/fixtures/` as a directory path ending in a slash. */
export const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

/** The document each format's recorded session (`<fmt>/sessions/session-20.json`) was recorded on. */
export const BASE: Record<Format, string> = {
  docx: "images-hdrftr.docx",
  pptx: "deck-13.pptx",
  xlsx: "names-tables.xlsx",
};

/** Another format whose base file a check opens as a second document next to the first. */
export const OTHER: Record<Format, Format> = { docx: "pptx", pptx: "xlsx", xlsx: "docx" };

/** Bytes of `fixtures/<relative path>`. */
export function fixtureBytes(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES_DIR + relative));
}

/** The base file of `format`. */
export const baseBytes = (format: Format): Uint8Array => fixtureBytes(`${format}/${BASE[format]}`);

/** The 20 recorded batches of `format` (the file holds op arrays, or `{ name, ops }` objects). */
export function sessionBatches(format: Format): Op[][] {
  const text = readFileSync(`${FIXTURES_DIR}${format}/sessions/session-20.json`, "utf8");
  return (JSON.parse(text) as (Op[] | { ops: Op[] })[]).map((b) => (Array.isArray(b) ? b : b.ops));
}

/** Byte-wise equality. */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Raised by `ok` for a failed assertion. */
export class CheckFailure extends Error {
  constructor(message: string) {
    super(`FAIL: ${message}`);
    this.name = "CheckFailure";
  }
}

/** Counting assertion: `ok(condition, message)` throws `CheckFailure` and otherwise adds one to `count`. */
export type Asserter = {
  (condition: unknown, message: string): asserts condition;
  readonly count: number;
};

export function createAsserter(): Asserter {
  let count = 0;
  const ok = ((condition: unknown, message: string) => {
    if (!condition) throw new CheckFailure(message);
    count++;
  }) as { (condition: unknown, message: string): asserts condition; count: number };
  Object.defineProperty(ok, "count", { get: () => count });
  return ok;
}

/** A whole check that cannot run on this module: `command` is the ABI command the module lacks. */
export class Skipped extends Error {
  command: string;
  constructor(command: string, reason: string) {
    super(reason);
    this.name = "Skipped";
    this.command = command;
  }
}

/** Part of a check that did not run (the rest did); reported, never silent. */
export type SkippedPart = { part: string; command?: string; reason: string };

/** What one `run(ctx, format)` returns. A check that fails throws; one that cannot run at all throws `Skipped`. */
export type CheckOutcome = {
  /** Assertions that passed (`ok.count`). */
  checks: number;
  /** One line per notable fact of the run (counts, verdict tallies, probes). */
  notes?: string[];
  /** Parts of this check that did not run, each with the reason. */
  skipped?: SkippedPart[];
  /** Structured numbers worth recording in the evidence file. */
  data?: Record<string, unknown>;
};

export type EngineContext = {
  /** Absolute path of the module every kernel of this run loads. */
  modulePath: string;
  /** A new node reactor kernel on that module (pinned clock `2026-01-01T00:00:00Z`, UTC, en-US, seed 0 unless `options` says otherwise). Close nothing: kernels are garbage collected with their handles. */
  kernel(options?: ReactorKernelOptions): ReactorEngineKernel;
  /** `version.engine` of the module: `wolf <version> (commit <commit>)`. */
  build: string;
  /** Commands the module exports (`kernel.stats().engine.commands`). */
  commands: readonly string[];
  /** Whether the module exports `command`. */
  has(command: string): boolean;
  /** Throws `Skipped` naming `command` when the module lacks it. Call before the first use of `extract`, `recalc` or `damage_report`. */
  require(command: string): void;
  /** Progress line (stderr). */
  log(message: string): void;
};

export type EngineCheck = {
  id: CheckId;
  run(ctx: EngineContext, format: Format): Promise<CheckOutcome>;
};

/** One row of the report: a check on one format. */
export type CheckResult = {
  check: CheckId;
  format: Format;
  status: "passed" | "skipped" | "failed";
  checks: number;
  ms: number;
  notes: string[];
  /** Whole-check skip (`command` is the missing module command) or partial skips of a passed check. */
  skipped: SkippedPart[];
  /** First failure message; set only when `status` is `failed`. */
  error?: string;
  data?: Record<string, unknown>;
};

/**
 * Module path: an explicit argument, else `WOLF_WEB_WASM`, else `vendor/wolf_web.wasm` of the web
 * workspace. The first one given decides: a named file that does not exist gives null, never the next
 * candidate. Returns null when no file exists there.
 */
export function resolveModulePath(explicit?: string): string | null {
  const path = explicit || process.env.WOLF_WEB_WASM || DEFAULT_REACTOR_MODULE_PATH;
  return existsSync(path) ? path : null;
}

/** Builds the context: reads the command list from a first kernel's `stats().engine` (one start-up of the module). */
export async function createContext(modulePath: string, log: (message: string) => void = () => {}): Promise<EngineContext> {
  const probe = createNodeReactorKernel(modulePath);
  // `stats().engine` is null until the module has started: open and close the smallest fixture.
  const opened = await probe.open(fixtureBytes("docx/tiny.docx"), "tiny.docx");
  await probe.close(opened.doc);
  const engine = (await probe.stats()).engine;
  if (!engine) throw new Error(`${modulePath}: the module did not report its engine`);
  const commands = [...engine.commands];
  const has = (command: string) => commands.includes(command);
  return {
    modulePath,
    build: engine.build,
    kernel: (options) => createNodeReactorKernel(modulePath, options),
    commands,
    has,
    require(command) {
      if (!has(command)) throw new Skipped(command, `the module does not export the "${command}" command`);
    },
    log,
  };
}
