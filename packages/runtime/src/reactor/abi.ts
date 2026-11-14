/**
 * The only file that touches the wolf-web reactor ABI
 * (`docs/wolf-web-reactor-abi.md`, version 1): instantiation, the
 * compatibility check, the `wolf_alloc` / `wolf_call` / `wolf_free` buffer
 * protocol, trap capture, and the response shapes the kernel reads.
 * Environment-neutral (browser, Worker, Node, bun).
 */
import { WASI, File, OpenFile } from "@bjorn3/browser_wasi_shim";

/** The module's default environment (ABI "Determinism members"); the kernel
 * passes clock, timezone, locale and seed on every request. */
export const PINNED = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 } as const;

/** Commands the kernel needs: a module lacking one is refused at start-up. */
export const REQUIRED_COMMANDS = [
  "version",
  "open",
  "close",
  "save",
  "observe",
  "apply",
  "diff",
  "layout",
  "render_page_png",
  "display_list",
  "hit_test",
  "caret_rects",
  "text_layout",
  "fonts",
  "resource",
  "sheet_viewport",
] as const;

/** Version 1 commands the kernel uses only on request (`query` verb
 * `extract`, `damageReport`); a module lacking one answers those calls with
 * `unsupported`. */
export const OPTIONAL_COMMANDS = ["extract", "recalc", "damage_report"] as const;

/** `extract` payloads (`options.what`, the CLI's `--what`). */
export const EXTRACT_WHAT = ["text", "structure", "markdown", "chunks", "barcodes"] as const;

/** The one import module a `wasm32-wasip1` module may name (ABI "Imports"). */
const WASI_MODULE = "wasi_snapshot_preview1";

/** Exports of version 1 with their kinds and parameter counts (ABI "Exports"). */
const EXPORTS: readonly { name: string; kind: string; params?: number }[] = [
  { name: "memory", kind: "memory" },
  { name: "_initialize", kind: "function", params: 0 },
  { name: "wolf_alloc", kind: "function", params: 1 },
  { name: "wolf_free", kind: "function", params: 2 },
  { name: "wolf_call", kind: "function", params: 2 },
];

type Exports = {
  memory: WebAssembly.Memory;
  wolf_alloc(len: number): number;
  wolf_free(ptr: number, len: number): void;
  wolf_call(ptr: number, len: number): bigint;
};

/** A module refusal (`ok: false` with `error`). */
export type ModuleError = { code: string; message: string; [member: string]: unknown };

/** An agent-cli.v1 receipt, as the engine wrote it. */
export type Receipt = {
  status?: string;
  exit?: { category?: string; code?: number };
  errors?: { code: string; message: string; [member: string]: unknown }[];
  warnings?: { code: string; message: string; [member: string]: unknown }[];
  inputs?: { path: string; format?: string; sha256?: string; bytes?: number }[];
  outputs?: { path: string; format?: string; schema?: string; sha256?: string; bytes?: number }[];
  observation?: { regions?: unknown[]; unrendered?: string[]; view?: { truncated?: boolean } };
  transaction?: Record<string, unknown>;
  diff?: { changes?: unknown[] };
  [member: string]: unknown;
};

export type Output = { path: string; data: Uint8Array };

/** Members common to every response; command members are read by name. */
export type Response = {
  ok: boolean;
  ms: number;
  error?: ModuleError;
  receipt?: Receipt;
  [member: string]: unknown;
};

export type OpenResponse = Response & { doc: number; format: string; sha256: string; bytes: number; revision: number };
export type SaveResponse = Response & { bytes: Uint8Array; sha256: string; revision: number };
export type EngineResponse = Response & { outputs?: Output[] };
/** `apply.pages`: the relayout of the new revision (null with `relayout: false`). */
export type ApplyPages = {
  compared: boolean;
  count: number;
  changed: number[];
  removed: number[];
  hashes: string[];
  layout_ms: number;
};
export type ApplyResponse = EngineResponse & {
  committed: boolean;
  revision: number;
  sha256: string;
  diff: unknown;
  pages?: ApplyPages | null;
};
export type RenderResponse = Response & {
  png: Uint8Array;
  page: number;
  size_pt: [number, number];
  pixel_size: [number, number];
  layout_cached: boolean;
};
export type VersionResponse = Response & {
  engine: string;
  clock: string;
  timezone: string;
  locale: string;
  seed: number;
};

/** What the start-up check learned about a module (`checkEngine`). */
export type EngineInfo = {
  /** `version.engine`: `wolf <version> (commit <commit>)`. */
  build: string;
  /** The module's default determinism (`version`). */
  defaults: { clock: string; timezone: string; locale: string; seed: number };
  /** Commands of `REQUIRED_COMMANDS` and `OPTIONAL_COMMANDS` the module
   * implements, in that order. */
  commands: string[];
};

/** `wolf_call` (or `wolf_alloc`) trapped. The instance must be dropped. */
export class ReactorTrap extends Error {
  readonly cause: unknown;
  /** Module stderr written during the failed call. */
  readonly stderr: string;
  readonly memoryBytes: number;
  constructor(cause: unknown, stderr: string, memoryBytes: number) {
    super(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
    this.name = "ReactorTrap";
    this.cause = cause;
    this.stderr = stderr;
    this.memoryBytes = memoryBytes;
  }
}

/** The module does not speak version 1 of the ABI: an import, an export or
 * its signature differs, `version` answers out of shape, or a required
 * command is missing. */
export class EngineIncompatible extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`the engine module does not implement wolf-web reactor ABI version 1: ${problems.join("; ")}`);
    this.name = "EngineIncompatible";
    this.problems = problems;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A `{ptr, len}` module buffer handle: exactly those two integer members. */
export function isBlob(value: unknown): value is { ptr: number; len: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const v = value as { ptr?: unknown; len?: unknown };
  return keys.length === 2 && Number.isInteger(v.ptr) && Number.isInteger(v.len);
}

/** Split a `wolf_call` result into the response location (high 32 bits:
 * pointer, low 32 bits: length). The `i64` arrives signed. */
export function unpackResult(packed: bigint): { ptr: number; len: number } {
  const u = BigInt.asUintN(64, packed);
  return { ptr: Number(u >> 32n), len: Number(u & 0xffffffffn) };
}

/** A `bad-request` refusal of a command the module does not implement
 * (ABI "Compatibility": message `unknown cmd <name>`). */
export function isUnknownCommand(error: ModuleError | undefined): boolean {
  return error?.code === "bad-request" && typeof error.message === "string" && /^unknown cmd\b/.test(error.message);
}

/** Problems with a compiled module's imports and exports (ABI "Imports",
 * "Exports"); empty when it fits. Parameter counts are checked after
 * instantiation (`Reactor.create`). */
export function moduleProblems(module: WebAssembly.Module): string[] {
  const problems: string[] = [];
  const foreign = [...new Set(WebAssembly.Module.imports(module).map((i) => i.module))].filter(
    (m) => m !== WASI_MODULE,
  );
  if (foreign.length) problems.push(`imports from ${foreign.join(", ")} (only ${WASI_MODULE} is allowed)`);
  const exported = new Map(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
  for (const e of EXPORTS) {
    const kind = exported.get(e.name);
    if (kind === undefined) problems.push(`no export ${e.name}`);
    else if (kind !== e.kind) problems.push(`export ${e.name} is a ${kind}, expected a ${e.kind}`);
  }
  return problems;
}

/** One live reactor instance. Single threaded and synchronous. */
export class Reactor {
  readonly #exports: Exports;
  readonly #stderr: File;
  #stderrSeen = 0;

  private constructor(instance: WebAssembly.Instance, stderr: File) {
    this.#exports = instance.exports as unknown as Exports;
    this.#stderr = stderr;
  }

  /** Check the module's imports and exports, instantiate it, check the
   * exports' parameter counts and run `_initialize` once. Throws
   * `EngineIncompatible` when the module does not fit version 1. */
  static async create(module: WebAssembly.Module): Promise<Reactor> {
    const problems = moduleProblems(module);
    if (problems.length) throw new EngineIncompatible(problems);
    const stderr = new File([]);
    // No preopened directories: the reactor never opens a file.
    const wasi = new WASI(
      ["wolf-web"],
      [],
      [new OpenFile(new File([])), new OpenFile(new File([])), new OpenFile(stderr)],
      { debug: false },
    );
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    for (const e of EXPORTS) {
      if (e.params === undefined) continue;
      const fn = instance.exports[e.name] as (...args: unknown[]) => unknown;
      if (fn.length !== e.params) problems.push(`export ${e.name} takes ${fn.length} parameters, expected ${e.params}`);
    }
    if (problems.length) throw new EngineIncompatible(problems);
    wasi.initialize(instance as unknown as Parameters<WASI["initialize"]>[0]);
    return new Reactor(instance, stderr);
  }

  /** Linear memory size now. */
  get memoryBytes(): number {
    return this.#exports.memory.buffer.byteLength;
  }

  #put(bytes: Uint8Array): { ptr: number; len: number } {
    const ptr = this.#exports.wolf_alloc(bytes.length);
    new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  #take(ptr: number, len: number): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(this.#exports.memory.buffer, ptr, len).slice();
    this.#exports.wolf_free(ptr, len);
    return copy;
  }

  /** Replace every `{ptr, len}` module buffer with an owned copy. */
  #resolve(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.#resolve(v));
    if (isBlob(value)) return this.#take(value.ptr, value.len);
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) obj[key] = this.#resolve(obj[key]);
    }
    return value;
  }

  /** Stderr bytes written since the previous call. */
  #newStderr(): string {
    const data = this.#stderr.data;
    const text = decoder.decode(data.subarray(this.#stderrSeen));
    this.#stderrSeen = data.length;
    return text;
  }

  /** Make the module trap for real (a request buffer that starts at the end
   * of linear memory, so its first byte read is out of bounds), for restore
   * tests. The instance is unusable after. */
  trap(): never {
    try {
      this.#exports.wolf_call(this.memoryBytes, 64);
    } catch (e) {
      throw new ReactorTrap(e, this.#newStderr(), this.memoryBytes);
    }
    throw new Error("wolf_call read past linear memory without trapping");
  }

  /**
   * Run one request. `inputs` maps request fields to byte payloads (passed
   * as module buffers, never through JSON). Throws `ReactorTrap` when the
   * module traps; otherwise returns the parsed response with every output
   * buffer replaced by a `Uint8Array`. An input buffer the module never read
   * (the command is unknown to it) is freed here (ABI "Ownership rules").
   */
  call<T extends Response = Response>(request: Record<string, unknown>, inputs: Record<string, Uint8Array> = {}): T {
    let response: Response;
    try {
      const full: Record<string, unknown> = { ...request };
      const given: { ptr: number; len: number }[] = [];
      for (const [key, bytes] of Object.entries(inputs)) {
        const blob = this.#put(bytes);
        given.push(blob);
        full[key] = blob;
      }
      const req = this.#put(encoder.encode(JSON.stringify(full)));
      const { ptr, len } = unpackResult(this.#exports.wolf_call(req.ptr, req.len));
      response = JSON.parse(decoder.decode(this.#take(ptr, len))) as Response;
      if (given.length && isUnknownCommand(response.error))
        for (const blob of given) this.#exports.wolf_free(blob.ptr, blob.len);
    } catch (e) {
      if (e instanceof SyntaxError) throw e;
      throw new ReactorTrap(e, this.#newStderr(), this.memoryBytes);
    }
    this.#newStderr();
    // The receipt is engine JSON and never carries module buffers.
    const receipt = response.receipt;
    delete response.receipt;
    const resolved = this.#resolve(response) as Response;
    if (receipt !== undefined) resolved.receipt = receipt;
    return resolved as T;
  }
}

/**
 * Start-up check (ABI "Compatibility"): `version` must answer in shape, and
 * every command of `REQUIRED_COMMANDS` must be known to the module. Each
 * command is sent with no fields: a module that implements it refuses with
 * `bad-request` naming a missing field and changes nothing; only `unknown
 * cmd <name>` means it is absent. Throws `EngineIncompatible`.
 */
export function checkEngine(reactor: Reactor): EngineInfo {
  const problems: string[] = [];
  const v = reactor.call<VersionResponse>({ cmd: "version" });
  const shaped =
    v.ok === true &&
    typeof v.engine === "string" &&
    /^wolf \S+ \(commit [^)]+\)/.test(v.engine) &&
    typeof v.clock === "string" &&
    typeof v.timezone === "string" &&
    typeof v.locale === "string" &&
    Number.isInteger(v.seed);
  if (!shaped)
    problems.push(
      v.error
        ? `version refused: ${v.error.code}: ${v.error.message}`
        : `version answered out of shape: ${JSON.stringify(v).slice(0, 200)}`,
    );
  const commands: string[] = [];
  for (const cmd of [...REQUIRED_COMMANDS, ...OPTIONAL_COMMANDS]) {
    const known = cmd === "version" ? shaped || !isUnknownCommand(v.error) : !isUnknownCommand(reactor.call({ cmd }).error);
    if (known) commands.push(cmd);
    else if ((REQUIRED_COMMANDS as readonly string[]).includes(cmd)) problems.push(`no command ${cmd}`);
  }
  if (problems.length) throw new EngineIncompatible(problems);
  return {
    build: v.engine,
    defaults: { clock: v.clock, timezone: v.timezone, locale: v.locale, seed: v.seed },
    commands,
  };
}

/** Lower `wolf observe` CLI flags to the `options` member of the reactor's
 * `observe` request (the same lowering `wolf` itself does, crates/wolf
 * `cli.rs lower_api_args`). Only flags that land in `options` are
 * accepted; anything else returns the offending flag. */
export function lowerObserveArgs(
  args: string[],
): { options: Record<string, unknown> } | { flag: string; message: string } {
  const options: Record<string, unknown> = {};
  const render: Record<string, unknown> = {};
  const push = (key: string, value: string) => ((options[key] ??= []) as string[]).push(value);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const takesValue = [
      "--target",
      "--channel",
      "--depth",
      "--max-nodes",
      "--render",
      "--dpi",
      "--scale-to",
      "--scale-to-x",
      "--scale-to-y",
      "--pages",
    ];
    if (!takesValue.includes(flag)) {
      return {
        flag,
        message: `${flag}: the reactor's observe takes only ${takesValue.join(", ")} (clock, seed, locale and fonts are pinned by the module; paths are supplied by the kernel)`,
      };
    }
    const value = args[++i];
    if (value === undefined) return { flag, message: `${flag} needs a value` };
    const int = (): number | null => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : null);
    switch (flag) {
      case "--target":
        push("targets", value);
        break;
      case "--channel":
        push("channels", value);
        break;
      case "--depth":
      case "--max-nodes": {
        const n = int();
        if (n === null) return { flag, message: `${flag} needs a non-negative integer, got ${value}` };
        options[flag === "--depth" ? "depth" : "max_nodes"] = n;
        break;
      }
      case "--render":
        render.to = value;
        break;
      case "--dpi": {
        const n = Number(value);
        if (!Number.isFinite(n)) return { flag, message: `--dpi needs a number, got ${value}` };
        render.dpi = n;
        break;
      }
      case "--pages": {
        const m = /^(\d*)(?:-(\d*))?$/.exec(value);
        const first = m?.[1] ? Number.parseInt(m[1], 10) : undefined;
        const last = m?.[2] !== undefined ? (m[2] ? Number.parseInt(m[2], 10) : undefined) : first;
        if (!m || (first === undefined && last === undefined) || first === 0 || last === 0)
          return { flag, message: `--pages needs <n> or <first>-<last>, got ${value}` };
        render.pages = { ...(first !== undefined ? { first } : {}), ...(last !== undefined ? { last } : {}) };
        break;
      }
      default: {
        const n = int();
        if (n === null) return { flag, message: `${flag} needs a non-negative integer, got ${value}` };
        render[flag.slice(2).replaceAll("-", "_")] = n;
      }
    }
  }
  if (Object.keys(render).length) options.render = render;
  return { options };
}

/** Lower `wolf extract` CLI flags to the `options` member of the reactor's
 * `extract` request. Only `--what` lands in `options`; it may repeat and
 * takes a comma-separated list of `EXTRACT_WHAT` entries, kept in first-seen
 * order without duplicates. No `--what` leaves the engine's default. */
export function lowerExtractArgs(
  args: string[],
): { options: Record<string, unknown> } | { flag: string; message: string } {
  const what: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag !== "--what") {
      return {
        flag,
        message: `${flag}: the reactor's extract takes only --what (clock, seed, locale and fonts are pinned by the module; paths are supplied by the kernel)`,
      };
    }
    const value = args[++i];
    if (value === undefined) return { flag, message: "--what needs a value" };
    for (const part of value.split(",")) {
      const item = part.trim();
      if (!(EXTRACT_WHAT as readonly string[]).includes(item))
        return { flag, message: `--what takes ${EXTRACT_WHAT.join(", ")} (comma-separated), got ${value}` };
      if (!what.includes(item)) what.push(item);
    }
  }
  return { options: what.length ? { what } : {} };
}
