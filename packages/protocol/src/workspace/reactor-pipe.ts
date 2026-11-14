// The reactor pipe (`wolfsdk.reactor-pipe.v1`): the framing and the request and response envelopes of
// `wolf reactor-serve`, the native process that serves the `agent_api::web` version 2 commands over its
// standard input and output. The commands, their fields and their semantics are those of
// `wolf_web.wasm` (docs/wolf-web-reactor-abi.md); the pipe changes only how buffers travel and adds the
// `entitlement` command and PDF documents. Nothing here touches the DOM, Preact or a kernel.
import type { DocFormat } from "../contract.ts";
import { validateSchema, type Schema } from "../session/record.ts";
import pipeSchema from "../../schemas/reactor-pipe.v1.schema.json" with { type: "json" };

export const REACTOR_PIPE_CONTRACT = "wolfsdk.reactor-pipe.v1";
export const REACTOR_PIPE_SCHEMA: Schema = pipeSchema;

/** Formats a workspace holds: the three the engine edits, plus PDF (read and render only). */
export type WorkspaceDocFormat = DocFormat | "pdf";

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** A frame is this header, `json_bytes` bytes of UTF-8 JSON, then `bin_count` binary segments, each a
 * little-endian u32 length followed by that many bytes. The header is three little-endian u32:
 * `req_id`, `json_bytes`, `bin_count`. A response carries the `req_id` of its request. */
export const REACTOR_PIPE_HEADER_BYTES = 12;
export const REACTOR_PIPE_MAX_U32 = 4_294_967_295;
/** Largest JSON body a frame may carry (64 MiB). */
export const REACTOR_PIPE_MAX_JSON_BYTES = 67_108_864;
/** Most binary segments one frame may carry. */
export const REACTOR_PIPE_MAX_BIN_COUNT = 1024;

export type ReactorPipeHeader = { req_id: number; json_bytes: number; bin_count: number };

/** Names binary segment `bin` (0-based, in frame order) of exactly `len` bytes. */
export type ReactorPipeBlob = { bin: number; len: number };

/** The 12 header bytes of `header`. Throws a `RangeError` for a header the contract refuses. */
export function encodeReactorPipeHeader(header: ReactorPipeHeader): Uint8Array<ArrayBuffer> {
  const problems = validateReactorPipeHeader(header);
  if (problems.length) throw new RangeError(`invalid reactor pipe header: ${problems.join("; ")}`);
  const bytes = new Uint8Array(REACTOR_PIPE_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.req_id, true);
  view.setUint32(4, header.json_bytes, true);
  view.setUint32(8, header.bin_count, true);
  return bytes;
}

/** The header at the start of `bytes`. Throws a `RangeError` for too few bytes or a header the contract refuses. */
export function decodeReactorPipeHeader(bytes: Uint8Array): ReactorPipeHeader {
  if (bytes.byteLength < REACTOR_PIPE_HEADER_BYTES)
    throw new RangeError(`a reactor pipe header is ${REACTOR_PIPE_HEADER_BYTES} bytes, got ${bytes.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, REACTOR_PIPE_HEADER_BYTES);
  const header = { req_id: view.getUint32(0, true), json_bytes: view.getUint32(4, true), bin_count: view.getUint32(8, true) };
  const problems = validateReactorPipeHeader(header);
  if (problems.length) throw new RangeError(`invalid reactor pipe header: ${problems.join("; ")}`);
  return header;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The 22 commands of `agent_api::web` version 2, in dispatch order. */
export const REACTOR_PIPE_WEB_COMMANDS = [
  "version",
  "budget",
  "open",
  "close",
  "save",
  "undo",
  "redo",
  "observe",
  "apply",
  "diff",
  "extract",
  "recalc",
  "damage_report",
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

/** Every command of the pipe: the 22 web commands and `entitlement`. */
export const REACTOR_PIPE_COMMANDS = [...REACTOR_PIPE_WEB_COMMANDS, "entitlement"] as const;

export type ReactorPipeCommand = (typeof REACTOR_PIPE_COMMANDS)[number];

/** Commands that read the content of a PDF document. Every other command that needs a document answers
 * `unsupported` for a PDF; `close`, `save`, `version`, `budget`, `resource` and `entitlement` do not depend on the format. */
export const REACTOR_PIPE_PDF_COMMANDS = ["open", "layout", "display_list", "render_page_png", "extract"] as const;

export const REACTOR_PIPE_EXTRACT_WHAT = ["text", "structure", "markdown", "chunks", "barcodes"] as const;
export type ReactorPipeExtractWhat = (typeof REACTOR_PIPE_EXTRACT_WHAT)[number];

/** Refusals `wolf reactor-serve` makes because of the running licence (see `entitlement`). */
export const REACTOR_PIPE_LICENSE_ERROR_CODES = [
  "license-seat-limit",
  "license-workspace-limit",
  "license-oem-required",
  "license-invalid",
] as const;
export type ReactorPipeLicenseErrorCode = (typeof REACTOR_PIPE_LICENSE_ERROR_CODES)[number];

/** Every refusal code this contract names: the module's own (ABI "Error codes") and the licence codes.
 * A refusal may also carry any other kebab-case code, because the engine's admission and package codes are open-ended. */
export const REACTOR_PIPE_ERROR_CODES = [
  "bad-request",
  "unknown-doc",
  "format-mismatch",
  "unsupported",
  "bad-determinism",
  "render-failed",
  "bad-page",
  "bad-range",
  "unknown-object",
  "unknown-resource",
  "invalid-input",
  "reactor-document-limit",
  "reactor-document-memory-limit",
  "reactor-host-memory-limit",
  "session-history-empty",
  "internal-error",
  ...REACTOR_PIPE_LICENSE_ERROR_CODES,
] as const;

export type ReactorPipeErrorCode = (typeof REACTOR_PIPE_ERROR_CODES)[number];

/** The keyless community self-host grant (LICENSE-WOLF-COMMUNITY-SELFHOST.txt). */
export const COMMUNITY_SELFHOST_MAX_WORKSPACES = 1;
export const COMMUNITY_SELFHOST_MAX_SEATS = 5;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Per-call (or, for `open`, stored) determinism members. A missing member or `null` keeps the current value. */
export type ReactorPipeDeterminism = {
  clock?: string | null;
  timezone?: string | null;
  locale?: string | null;
  seed?: number | null;
};

/** Determinism as responses echo it. */
export type ReactorPipeResolvedDeterminism = { clock: string; timezone: string; locale: string; seed: number };

export type ReactorPipeRequest =
  | { cmd: "version" }
  | { cmd: "budget"; held_bytes?: number; document_bytes?: number; documents?: number; derived_bytes?: number }
  | ({ cmd: "open"; bytes: ReactorPipeBlob; name?: string; format?: WorkspaceDocFormat } & ReactorPipeDeterminism)
  | { cmd: "close" | "save" | "undo" | "redo" | "fonts"; doc: number }
  | ({ cmd: "observe"; doc: number; options?: Record<string, unknown> } & ReactorPipeDeterminism)
  | ({ cmd: "apply"; doc: number; ops: unknown; options?: Record<string, unknown>; relayout?: boolean } & ReactorPipeDeterminism)
  | ({ cmd: "diff"; doc: number; against: number; options?: Record<string, unknown> } & ReactorPipeDeterminism)
  | ({
      cmd: "extract";
      doc: number;
      options?: { what?: ReactorPipeExtractWhat[]; [member: string]: unknown };
    } & ReactorPipeDeterminism)
  | {
      cmd: "recalc";
      doc: number;
      clock: string;
      seed: number;
      timezone?: string | null;
      locale?: string | null;
      options?: Record<string, unknown>;
    }
  | {
      cmd: "damage_report";
      doc: number;
      options?: {
        baselines?: ("openpyxl" | "python-docx" | "python-pptx" | "libreoffice")[];
        output_stem?: string;
        timeout_ms?: number;
      };
    }
  | ({ cmd: "layout"; doc: number } & ReactorPipeDeterminism)
  | { cmd: "render_page_png"; doc: number; page: number; scale?: number }
  | { cmd: "display_list"; doc: number; page: number }
  | { cmd: "hit_test"; doc: number; page: number; x_pt: number; y_pt: number }
  | { cmd: "caret_rects"; doc: number; object_id: string; start: number; end?: number }
  | { cmd: "text_layout"; doc: number; object_id: string }
  | { cmd: "resource"; handle: string }
  | { cmd: "sheet_viewport"; doc: number; sheet?: string | number; row0?: number; col0?: number; rows?: number; cols?: number }
  | { cmd: "entitlement" };

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

type Base<C extends ReactorPipeCommand, Ok extends boolean = true> = { cmd: C; ok: Ok; ms: number };

export type ReactorPipeError = { code: string; message: string; argument?: string; [member: string]: unknown };

/** A refusal: `error` is present and no command members follow. `cmd` is omitted when the request body
 * was not valid JSON or `cmd` was missing, not a string, or unknown. Branch on `error` first. */
export type ReactorPipeRefusal = { cmd?: ReactorPipeCommand; ok: false; ms: number; error: ReactorPipeError };

export type ReactorPipeBudget = { held_bytes: number; document_bytes: number; documents: number; derived_bytes: number };

export type ReactorPipeHeld = {
  documents: number;
  floor_bytes: number;
  reactor_derived_bytes: number;
  derived_bytes: number;
  resources: number;
  resource_tombstones: number;
};

export type ReactorPipeOutput = { path: string; data: ReactorPipeBlob };

export type ReactorPipePages = {
  compared: boolean;
  count: number;
  changed: number[];
  removed: number[];
  hashes: string[];
  layout_ms?: number;
};

export type ReactorPipeResponse =
  | ReactorPipeRefusal
  | (Base<"version"> & {
      engine: string;
      clock: string;
      timezone: string;
      locale: string;
      seed: number;
      abi: 2;
      budget: ReactorPipeBudget;
    })
  | (Base<"budget"> & { budget: ReactorPipeBudget; held: ReactorPipeHeld })
  | (Base<"open"> & {
      doc: number;
      format: WorkspaceDocFormat;
      sha256: string;
      bytes: number;
      revision: number;
      determinism: ReactorPipeResolvedDeterminism;
    })
  | (Base<"close", boolean> & { doc: number })
  | (Base<"save"> & { doc: number; revision: number; sha256: string; bytes: ReactorPipeBlob })
  | (Base<"undo" | "redo"> & { doc: number; revision: number; sha256: string; undo_depth: number; redo_depth: number })
  | (Base<"observe" | "extract" | "recalc" | "damage_report", boolean> & {
      receipt: Record<string, unknown>;
      outputs?: ReactorPipeOutput[];
      format?: WorkspaceDocFormat;
    })
  | (Base<"apply", boolean> & {
      committed: boolean;
      revision: number;
      base_sha256?: string;
      sha256: string;
      determinism?: ReactorPipeResolvedDeterminism;
      receipt: Record<string, unknown>;
      diff?: Record<string, unknown> | null;
      pages?: ReactorPipePages | null;
      outputs?: ReactorPipeOutput[];
    })
  | (Base<"diff", boolean> & { receipt: Record<string, unknown> })
  | (Base<"layout"> & {
      cached: boolean;
      layout_ms: number;
      summary: {
        format: WorkspaceDocFormat;
        pages: number;
        runs?: number;
        tagged_runs?: number;
        regions?: number;
        objects?: number;
        fonts?: number;
        images?: number;
        determinism: ReactorPipeResolvedDeterminism;
      };
      page_hashes: string[];
    })
  | (Base<"render_page_png"> & {
      page: number;
      size_pt: [number, number];
      pixel_size: [number, number] | null;
      layout_cached: boolean;
      png: ReactorPipeBlob;
      format?: WorkspaceDocFormat;
    })
  | (Base<"display_list"> & {
      page: number;
      page_hash: string;
      ir: Record<string, unknown>;
      fonts: Record<string, unknown>[];
      images: Record<string, unknown>[];
      runs: Record<string, unknown>[];
      objects: Record<string, unknown>;
      regions: Record<string, unknown>[];
      layout_cached: boolean;
      format?: WorkspaceDocFormat;
    })
  | (Base<"hit_test"> & {
      page: number;
      object_id: string | null;
      offset: number | null;
      rendered_offset: number | null;
      synthetic: boolean;
      inside_text: boolean;
      run?: number;
      run_offset?: number;
      caret?: [number, number, number, number];
      sheet?: string;
      a1?: string;
    })
  | (Base<"caret_rects"> & {
      object_id: string;
      start: number;
      end: number;
      length: number;
      rects: { page: number; x: number; y: number; w: number; h: number }[];
    })
  | (Base<"text_layout"> & {
      object_id: string;
      text: string;
      length: number;
      source_text: boolean;
      rendered: string;
      lines: Record<string, unknown>[];
      sheet?: string;
      a1?: string;
    })
  | (Base<"fonts"> & {
      format: WorkspaceDocFormat;
      requests: Record<string, unknown>[];
      faces: Record<string, unknown>[];
    })
  | (Base<"resource"> & {
      handle: string;
      kind: "font" | "image" | "license";
      mime: string;
      bytes: ReactorPipeBlob;
    })
  | (Base<"sheet_viewport"> & {
      sheet: string;
      sheets: Record<string, unknown>[];
      used_range?: string | null;
      row0: number;
      col0: number;
      rows: number;
      cols: number;
      cells: Record<string, unknown>[];
      columns: Record<string, unknown>[];
      row_heights: Record<string, unknown>[];
      merged: string[];
      styles: Record<string, unknown>;
      revision: number;
    })
  | (Base<"entitlement"> & ReactorPipeEntitlement);

export type ReactorPipeTier = "community" | "commercial" | "oem";

/** What the running process is licensed for. `null` limits mean unlimited. */
export type ReactorPipeEntitlement = {
  tier: ReactorPipeTier;
  max_workspaces: number | null;
  max_seats: number | null;
  sso: boolean;
  oem_offline_wasm: boolean;
  key_id: string | null;
  expires_at: string | null;
};

/** One decoded frame. `body` is the JSON text of the frame, parsed. */
export type ReactorPipeFrame =
  | { contract: typeof REACTOR_PIPE_CONTRACT; kind: "request"; header: ReactorPipeHeader; body: ReactorPipeRequest }
  | { contract: typeof REACTOR_PIPE_CONTRACT; kind: "response"; header: ReactorPipeHeader; body: ReactorPipeResponse };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The `$defs` entry that validates the request of a command. */
const REQUEST_DEF: Record<ReactorPipeCommand, string> = {
  version: "req_version",
  budget: "req_budget",
  open: "req_open",
  close: "req_doc",
  save: "req_doc",
  undo: "req_doc",
  redo: "req_doc",
  fonts: "req_doc",
  observe: "req_observe",
  apply: "req_apply",
  diff: "req_diff",
  extract: "req_extract",
  recalc: "req_recalc",
  damage_report: "req_damage_report",
  layout: "req_layout",
  render_page_png: "req_render_page_png",
  display_list: "req_display_list",
  hit_test: "req_hit_test",
  caret_rects: "req_caret_rects",
  text_layout: "req_text_layout",
  resource: "req_resource",
  sheet_viewport: "req_sheet_viewport",
  entitlement: "req_entitlement",
};

/** The `$defs` entry that validates the response of a command. */
const RESPONSE_DEF: Record<ReactorPipeCommand, string> = {
  version: "res_version",
  budget: "res_budget",
  open: "res_open",
  close: "res_close",
  save: "res_save",
  undo: "res_history",
  redo: "res_history",
  observe: "res_receipt",
  extract: "res_receipt",
  recalc: "res_receipt",
  damage_report: "res_receipt",
  apply: "res_apply",
  diff: "res_diff",
  layout: "res_layout",
  render_page_png: "res_render_page_png",
  display_list: "res_display_list",
  hit_test: "res_hit_test",
  caret_rects: "res_caret_rects",
  text_layout: "res_text_layout",
  fonts: "res_fonts",
  resource: "res_resource",
  sheet_viewport: "res_sheet_viewport",
  entitlement: "res_entitlement",
};

/** The def of `cmd` in `table`. Own keys only: `constructor` and `__proto__` are not commands. */
const defOf = (table: Record<ReactorPipeCommand, string>, cmd: unknown): string | undefined =>
  typeof cmd === "string" && Object.hasOwn(table, cmd) ? table[cmd as ReactorPipeCommand] : undefined;

/** The evaluator behind `validateSchema` does not read `maximum` or `exclusiveMinimum`; the pipe schema uses
 * them for the header, `scale` and nothing else, so this pass reads them off the same schema. */
function bounds(schema: Schema, value: unknown, root: Schema, path: string, out: string[]): void {
  if (schema.$ref) {
    let node: unknown = root;
    for (const k of schema.$ref.replace(/^#\//, "").split("/")) node = isObject(node) ? node[k] : undefined;
    if (isObject(node)) bounds(node as Schema, value, root, path, out);
    return;
  }
  if (typeof value === "number") {
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${path}: above maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
      out.push(`${path}: not above ${schema.exclusiveMinimum}`);
    return;
  }
  if (isObject(value) && schema.properties)
    for (const [k, sub] of Object.entries(schema.properties)) if (k in value) bounds(sub, value[k], root, `${path}.${k}`, out);
}

function validateDef(def: string, value: unknown): string[] {
  const root: Schema = { $defs: REACTOR_PIPE_SCHEMA.$defs, $ref: `#/$defs/${def}` };
  const out = validateSchema(root, value);
  bounds(root, value, root, "$", out);
  return out;
}

const under = (path: string, problems: string[]): string[] => problems.map((p) => p.replace(/^\$/, path));

/** Problems of a frame header (empty when valid). */
export function validateReactorPipeHeader(header: unknown): string[] {
  return validateDef("header", header);
}

/** Problems of a request body, a JSON object with `cmd` (empty when valid). */
export function validateReactorPipeRequest(body: unknown): string[] {
  if (!isObject(body)) return ["$: expected object"];
  const def = defOf(REQUEST_DEF, body.cmd);
  if (!def) return [`$.cmd: ${JSON.stringify(body.cmd)} is not a reactor pipe command`];
  return validateDef(def, body);
}

function entitlementProblems(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const { tier, max_workspaces, max_seats, sso, oem_offline_wasm, key_id, expires_at } = body;
  if (tier === "community") {
    if (typeof max_workspaces !== "number" || max_workspaces > COMMUNITY_SELFHOST_MAX_WORKSPACES)
      out.push(`$.max_workspaces: a community entitlement allows at most ${COMMUNITY_SELFHOST_MAX_WORKSPACES} workspace`);
    if (typeof max_seats !== "number" || max_seats > COMMUNITY_SELFHOST_MAX_SEATS)
      out.push(`$.max_seats: a community entitlement allows at most ${COMMUNITY_SELFHOST_MAX_SEATS} seats`);
    if (sso !== false) out.push("$.sso: a community entitlement has no SSO");
    if (key_id !== null) out.push("$.key_id: a community entitlement is keyless");
    if (expires_at !== null) out.push("$.expires_at: a community entitlement does not expire");
  } else if ((tier === "commercial" || tier === "oem") && key_id === null) {
    out.push(`$.key_id: a ${tier} entitlement comes from a licence key`);
  }
  if (oem_offline_wasm === true && tier !== "oem") out.push("$.oem_offline_wasm: only an oem entitlement may embed the module offline");
  return out;
}

/** Problems of a response body, a JSON object with `cmd` (empty when valid). A refusal (`error` present)
 * is checked as a refusal whatever the command. */
export function validateReactorPipeResponse(body: unknown): string[] {
  if (!isObject(body)) return ["$: expected object"];
  const command = defOf(RESPONSE_DEF, body.cmd);
  const def = body.error !== undefined ? "res_error" : command;
  if (!def) return [`$.cmd: ${JSON.stringify(body.cmd)} is not a reactor pipe command`];
  const out = validateDef(def, body);
  if (def === "res_error" && body.cmd !== undefined && !command)
    out.push(`$.cmd: ${JSON.stringify(body.cmd)} is not a reactor pipe command`);
  if (out.length === 0 && body.cmd === "entitlement" && def === "res_entitlement") out.push(...entitlementProblems(body));
  return out;
}

/** Binary handles of a validated body, by the members that carry them: `open.bytes`, `save.bytes`,
 * `render_page_png.png`, `resource.bytes` and every `outputs[].data`. Receipts never contain handles. */
function blobHandles(body: Record<string, unknown>): { path: string; bin: number; len: number }[] {
  const found: { path: string; bin: number; len: number }[] = [];
  const take = (path: string, v: unknown) => {
    if (isObject(v) && typeof v.bin === "number" && typeof v.len === "number") found.push({ path, bin: v.bin, len: v.len });
  };
  for (const member of ["bytes", "png"]) if (isObject(body[member])) take(`$.body.${member}`, body[member]);
  if (Array.isArray(body.outputs))
    body.outputs.forEach((o: unknown, i) => {
      if (isObject(o)) take(`$.body.outputs[${i}].data`, o.data);
    });
  return found;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Problems of one decoded frame `{contract, kind, header, body}` (empty when valid): the header, the body
 * for its kind, and what the two must agree on. The binary handles of the body must be exactly the segments
 * `header.bin_count` announces (each `bin` below it, none twice), and `json_bytes` can not be shorter than
 * the compact serialization of the body. With `binLengths` (the length of each segment as read from the
 * wire), `bin_count` must equal their number and every handle's `len` the length of its segment. */
export function validateReactorPipeEnvelope(frame: unknown, binLengths?: readonly number[]): string[] {
  if (!isObject(frame)) return ["$: expected object"];
  const out: string[] = [];
  if (frame.contract !== REACTOR_PIPE_CONTRACT) out.push(`$.contract: expected ${JSON.stringify(REACTOR_PIPE_CONTRACT)}`);
  for (const k of Object.keys(frame)) if (!["contract", "kind", "header", "body"].includes(k)) out.push(`$: unexpected ${k}`);
  for (const k of ["kind", "header", "body"]) if (!(k in frame)) out.push(`$: missing ${k}`);
  const kind = frame.kind;
  if ("kind" in frame && kind !== "request" && kind !== "response") out.push(`$.kind: expected "request" or "response"`);
  const headerProblems = "header" in frame ? under("$.header", validateReactorPipeHeader(frame.header)) : [];
  const bodyProblems =
    "body" in frame && (kind === "request" || kind === "response")
      ? under("$.body", kind === "request" ? validateReactorPipeRequest(frame.body) : validateReactorPipeResponse(frame.body))
      : [];
  out.push(...headerProblems, ...bodyProblems);
  if (out.length || !isObject(frame.body) || !isObject(frame.header)) return out;

  const { json_bytes, bin_count } = frame.header as ReactorPipeHeader;
  if (json_bytes < utf8Bytes(JSON.stringify(frame.body))) out.push("$.header.json_bytes: shorter than the body");
  const handles = blobHandles(frame.body);
  const seen = new Set<number>();
  for (const h of handles) {
    if (h.bin >= bin_count) out.push(`${h.path}.bin: ${h.bin} is not below bin_count ${bin_count}`);
    else if (seen.has(h.bin)) out.push(`${h.path}.bin: segment ${h.bin} is named twice`);
    seen.add(h.bin);
  }
  if (handles.length !== bin_count) out.push(`$.header.bin_count: ${bin_count} segments announced, the body names ${handles.length}`);
  if (binLengths) {
    if (binLengths.length !== bin_count) out.push(`$.header.bin_count: ${bin_count} announced, ${binLengths.length} read`);
    for (const h of handles) {
      const read = binLengths[h.bin];
      if (read !== undefined && read !== h.len) out.push(`${h.path}.len: ${h.len} but segment ${h.bin} has ${read} bytes`);
    }
  }
  return out;
}
