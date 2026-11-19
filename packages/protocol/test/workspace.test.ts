import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMUNITY_SELFHOST_MAX_SEATS,
  COMMUNITY_SELFHOST_MAX_WORKSPACES,
  MCP_WORKSPACE_CONTRACT,
  MCP_WORKSPACE_SCHEMA,
  MCP_WORKSPACE_TOOLS,
  MCP_WORKSPACE_TOOLS_MAX_BYTES,
  MCP_WORKSPACE_TOOLS_MAX_TOKENS,
  MCP_WORKSPACE_TOOL_NAMES,
  PACK_CONTRACT,
  PACK_FIT_POLICIES,
  PACK_FIT_POLICIES_BY_TARGET,
  PACK_MANIFEST_FILE,
  PACK_SCHEMA,
  PACK_TARGET_KINDS,
  REACTOR_PIPE_COMMANDS,
  REACTOR_PIPE_CONTRACT,
  REACTOR_PIPE_ERROR_CODES,
  REACTOR_PIPE_HEADER_BYTES,
  REACTOR_PIPE_LICENSE_ERROR_CODES,
  REACTOR_PIPE_MAX_BIN_COUNT,
  REACTOR_PIPE_MAX_JSON_BYTES,
  REACTOR_PIPE_PDF_COMMANDS,
  REACTOR_PIPE_SCHEMA,
  REACTOR_PIPE_WEB_COMMANDS,
  ROOM_AGENT_ACTIVITIES,
  ROOM_CLIENT_MESSAGE_TYPES,
  ROOM_CONTRACT,
  ROOM_ERROR_CODES,
  ROOM_PROPOSAL_STATUSES,
  ROOM_SCHEMA,
  ROOM_SERVER_EVENT_TYPES,
  decodeReactorPipeHeader,
  encodeReactorPipeHeader,
  isWorkspaceInstant,
  mcpToolsBytes,
  mcpToolsTokenEstimate,
  validateMcpToolCall,
  validatePackManifest,
  validateReactorPipeEnvelope,
  validateReactorPipeHeader,
  validateReactorPipeRequest,
  validateReactorPipeResponse,
  validateRoomClientMessage,
  validateRoomEvent,
  validateRoomSnapshot,
  type ReactorPipeCommand,
} from "../src/index.ts";
import * as index from "../src/index.ts";
import * as workspace from "../src/workspace/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const H = (digit: string): string => digit.repeat(64);
const CLOCK = "2026-11-13T09:00:00Z";
const utf8 = (text: string): number => new TextEncoder().encode(text).length;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
/** A deep copy of `base` that `change` has edited. */
const edit = <T>(base: T, change: (copy: Json) => void): unknown => {
  const copy = structuredClone(base) as Json;
  change(copy);
  return copy;
};
/** Expect `problems` to be non-empty and to mention `fragment`. */
const refused = (problems: string[], fragment: string): void => {
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join("\n")).toContain(fragment);
};

// ---------------------------------------------------------------------------
// Reactor pipe
// ---------------------------------------------------------------------------

const DET = { clock: CLOCK, timezone: "UTC", locale: "en-US", seed: 0 };
const BUDGET = { held_bytes: 1_073_741_824, document_bytes: 268_435_456, documents: 16, derived_bytes: 268_435_456 };
const ok = (cmd: string) => ({ cmd, ok: true, ms: 1.5 });
const bin = (n: number, len: number) => ({ bin: n, len });

/** One request per command, with the lengths of the binary segments that follow it on the wire. */
const REQUESTS: Record<ReactorPipeCommand, [body: Json, bins: number[]]> = {
  version: [{ cmd: "version" }, []],
  budget: [{ cmd: "budget", held_bytes: 1_048_576, documents: 8 }, []],
  open: [{ cmd: "open", bytes: bin(0, 4096), name: "report.docx", format: "docx", clock: CLOCK, timezone: "UTC", locale: "en-US", seed: 7 }, [4096]],
  close: [{ cmd: "close", doc: 1 }, []],
  save: [{ cmd: "save", doc: 1 }, []],
  undo: [{ cmd: "undo", doc: 1 }, []],
  redo: [{ cmd: "redo", doc: 1 }, []],
  observe: [{ cmd: "observe", doc: 1, options: { detail: "full" }, clock: null, seed: 3 }, []],
  apply: [{ cmd: "apply", doc: 1, ops: [{ op: "set_text", target: "para:~2a9256c0", text: "Hi" }], relayout: true }, []],
  diff: [{ cmd: "diff", doc: 1, against: 2 }, []],
  extract: [{ cmd: "extract", doc: 1, options: { what: ["text", "markdown"] } }, []],
  recalc: [{ cmd: "recalc", doc: 1, clock: CLOCK, seed: 0 }, []],
  damage_report: [{ cmd: "damage_report", doc: 1, options: { baselines: ["openpyxl", "libreoffice"], timeout_ms: 5000 } }, []],
  layout: [{ cmd: "layout", doc: 1 }, []],
  render_page_png: [{ cmd: "render_page_png", doc: 1, page: 1, scale: 2 }, []],
  display_list: [{ cmd: "display_list", doc: 1, page: 1 }, []],
  hit_test: [{ cmd: "hit_test", doc: 1, page: 1, x_pt: 72.5, y_pt: 100 }, []],
  caret_rects: [{ cmd: "caret_rects", doc: 1, object_id: "para:~2a9256c0", start: 0, end: 5 }, []],
  text_layout: [{ cmd: "text_layout", doc: 1, object_id: "para:~2a9256c0" }, []],
  fonts: [{ cmd: "fonts", doc: 1 }, []],
  resource: [{ cmd: "resource", handle: "font:abc123" }, []],
  sheet_viewport: [{ cmd: "sheet_viewport", doc: 1, sheet: "Sheet1", row0: 1, col0: 1, rows: 50, cols: 20 }, []],
  entitlement: [{ cmd: "entitlement" }, []],
};

const ENTITLEMENT = {
  ...ok("entitlement"),
  tier: "community",
  max_workspaces: 1,
  max_seats: 5,
  sso: false,
  oem_offline_wasm: false,
  key_id: null,
  expires_at: null,
};

/** One success response per command, with the lengths of the binary segments that follow it. */
const RESPONSES: Record<ReactorPipeCommand, [body: Json, bins: number[]]> = {
  version: [{ ...ok("version"), engine: "wolf 1.0.0", clock: CLOCK, timezone: "UTC", locale: "en-US", seed: 0, abi: 2, budget: BUDGET }, []],
  budget: [
    {
      ...ok("budget"),
      budget: BUDGET,
      held: { documents: 1, floor_bytes: 1024, reactor_derived_bytes: 0, derived_bytes: 0, resources: 0, resource_tombstones: 0 },
    },
    [],
  ],
  open: [{ ...ok("open"), doc: 1, format: "pdf", sha256: H("a"), bytes: 4096, revision: 0, determinism: DET }, []],
  close: [{ ...ok("close"), doc: 1 }, []],
  save: [{ ...ok("save"), doc: 1, revision: 1, sha256: H("b"), bytes: bin(0, 4096) }, [4096]],
  undo: [{ ...ok("undo"), doc: 1, revision: 0, sha256: H("a"), undo_depth: 0, redo_depth: 1 }, []],
  redo: [{ ...ok("redo"), doc: 1, revision: 1, sha256: H("b"), undo_depth: 1, redo_depth: 0 }, []],
  observe: [{ ...ok("observe"), receipt: { ok: true }, outputs: [{ path: "view.json", data: bin(0, 12) }, { path: "text.txt", data: bin(1, 5) }], format: "docx" }, [12, 5]],
  apply: [
    {
      ...ok("apply"),
      committed: true,
      revision: 2,
      base_sha256: H("a"),
      sha256: H("b"),
      determinism: DET,
      receipt: { ok: true },
      diff: null,
      pages: { compared: true, count: 2, changed: [2], removed: [], hashes: [H("1"), H("2")], layout_ms: 3 },
    },
    [],
  ],
  diff: [{ ...ok("diff"), receipt: { changes: [] } }, []],
  extract: [{ ...ok("extract"), receipt: { ok: true }, outputs: [{ path: "doc.md", data: bin(0, 9) }], format: "pdf" }, [9]],
  recalc: [{ ...ok("recalc"), receipt: { ok: true } }, []],
  damage_report: [{ ...ok("damage_report"), ok: false, receipt: { errors: [{ code: "baseline-missing" }] } }, []],
  layout: [
    {
      ...ok("layout"),
      cached: false,
      layout_ms: 4.2,
      summary: { format: "pdf", pages: 2, runs: 10, determinism: DET },
      page_hashes: [H("1"), H("2")],
    },
    [],
  ],
  render_page_png: [
    { ...ok("render_page_png"), page: 1, size_pt: [612, 792], pixel_size: [1224, 1584], layout_cached: true, png: bin(0, 2048), format: "pdf" },
    [2048],
  ],
  display_list: [
    {
      ...ok("display_list"),
      page: 1,
      page_hash: H("1"),
      ir: {},
      fonts: [],
      images: [],
      runs: [],
      objects: {},
      regions: [],
      layout_cached: true,
    },
    [],
  ],
  hit_test: [{ ...ok("hit_test"), page: 1, object_id: null, offset: null, rendered_offset: null, synthetic: false, inside_text: false }, []],
  caret_rects: [{ ...ok("caret_rects"), object_id: "para:~2a9256c0", start: 0, end: 5, length: 5, rects: [{ page: 1, x: 72, y: 72, w: 30, h: 12 }] }, []],
  text_layout: [{ ...ok("text_layout"), object_id: "para:~2a9256c0", text: "Hello", length: 5, source_text: true, rendered: "Hello", lines: [] }, []],
  fonts: [{ ...ok("fonts"), format: "docx", requests: [], faces: [] }, []],
  resource: [{ ...ok("resource"), handle: "font:abc123", kind: "font", mime: "font/ttf", bytes: bin(0, 64) }, [64]],
  sheet_viewport: [
    {
      ...ok("sheet_viewport"),
      sheet: "Sheet1",
      sheets: [],
      used_range: null,
      row0: 1,
      col0: 1,
      rows: 50,
      cols: 20,
      cells: [],
      columns: [],
      row_heights: [],
      merged: [],
      styles: {},
      revision: 0,
    },
    [],
  ],
  entitlement: [ENTITLEMENT, []],
};

const frame = (kind: "request" | "response", body: Json, bins: number[], req_id = 7) => ({
  contract: REACTOR_PIPE_CONTRACT,
  kind,
  header: { req_id, json_bytes: utf8(JSON.stringify(body)), bin_count: bins.length },
  body,
});

describe("reactor pipe: commands", () => {
  test("the pipe speaks the 22 agent_api::web commands plus entitlement", () => {
    expect(REACTOR_PIPE_WEB_COMMANDS).toHaveLength(22);
    expect(REACTOR_PIPE_COMMANDS).toHaveLength(23);
    expect([...(REACTOR_PIPE_COMMANDS as readonly string[])].sort()).toEqual(Object.keys(REQUESTS).sort());
    expect([...(REACTOR_PIPE_COMMANDS as readonly string[])].sort()).toEqual(Object.keys(RESPONSES).sort());
    expect(REACTOR_PIPE_COMMANDS.slice(0, 22)).toEqual([...REACTOR_PIPE_WEB_COMMANDS]);
    expect(REACTOR_PIPE_COMMANDS[22]).toBe("entitlement");
    expect(REACTOR_PIPE_CONTRACT).toBe("wolfsdk.reactor-pipe.v1");
    expect(REACTOR_PIPE_SCHEMA.$id).toBe("https://wolfsdk.com/schemas/reactor-pipe.v1.schema.json");
  });

  for (const cmd of REACTOR_PIPE_COMMANDS) {
    test(`${cmd}: request and response frames are valid`, () => {
      const [request, requestBins] = REQUESTS[cmd];
      const [response, responseBins] = RESPONSES[cmd];
      expect(validateReactorPipeRequest(request)).toEqual([]);
      expect(validateReactorPipeResponse(response)).toEqual([]);
      expect(validateReactorPipeEnvelope(frame("request", request, requestBins), requestBins)).toEqual([]);
      expect(validateReactorPipeEnvelope(frame("response", response, responseBins), responseBins)).toEqual([]);
    });

    test(`${cmd}: a request is not a response and the other way round`, () => {
      refused(validateReactorPipeRequest(RESPONSES[cmd][0]), "$");
      refused(validateReactorPipeResponse(REQUESTS[cmd][0]), "$");
    });

    test(`${cmd}: a refusal is valid for every licence and engine code`, () => {
      for (const code of [...REACTOR_PIPE_ERROR_CODES, "admission-denied", "package-bad-zip"]) {
        const refusal = { cmd, ok: false, ms: 0.2, error: { code, message: "refused", argument: "doc" } };
        expect(validateReactorPipeResponse(refusal)).toEqual([]);
      }
    });
  }

  test("a request member the command does not take is refused", () => {
    for (const cmd of REACTOR_PIPE_COMMANDS)
      refused(validateReactorPipeRequest({ ...REQUESTS[cmd][0], surprise: 1 }), "unexpected surprise");
  });

  test("a request with a member missing is refused", () => {
    refused(validateReactorPipeRequest({ cmd: "close" }), "missing doc");
    refused(validateReactorPipeRequest({ cmd: "open" }), "missing bytes");
    refused(validateReactorPipeRequest({ cmd: "apply", doc: 1 }), "missing ops");
    refused(validateReactorPipeRequest({ cmd: "diff", doc: 1 }), "missing against");
    refused(validateReactorPipeRequest({ cmd: "recalc", doc: 1, seed: 0 }), "missing clock");
    refused(validateReactorPipeRequest({ cmd: "recalc", doc: 1, clock: CLOCK }), "missing seed");
    refused(validateReactorPipeRequest({ cmd: "hit_test", doc: 1, page: 1, x_pt: 1 }), "missing y_pt");
    refused(validateReactorPipeRequest({ cmd: "caret_rects", doc: 1, object_id: "p" }), "missing start");
    refused(validateReactorPipeRequest({ cmd: "resource" }), "missing handle");
  });

  test("an unknown command, a prototype key and a non-object are refused", () => {
    refused(validateReactorPipeRequest({ cmd: "format_disk" }), "is not a reactor pipe command");
    refused(validateReactorPipeRequest({ cmd: "constructor" }), "is not a reactor pipe command");
    refused(validateReactorPipeRequest({ cmd: "__proto__" }), "is not a reactor pipe command");
    refused(validateReactorPipeRequest({ cmd: "toString" }), "is not a reactor pipe command");
    refused(validateReactorPipeRequest({}), "is not a reactor pipe command");
    refused(validateReactorPipeRequest([]), "expected object");
    refused(validateReactorPipeRequest(null), "expected object");
    refused(validateReactorPipeResponse("version"), "expected object");
    refused(validateReactorPipeResponse({ cmd: "constructor", ok: true, ms: 0 }), "is not a reactor pipe command");
    refused(validateReactorPipeResponse({ cmd: "constructor", ok: false, ms: 0, error: { code: "bad-request", message: "x" } }), "is not a reactor pipe command");
  });

  test("handles are 1-based, durations and counts are not negative", () => {
    refused(validateReactorPipeRequest({ cmd: "close", doc: 0 }), "below minimum");
    refused(validateReactorPipeRequest({ cmd: "close", doc: 1.5 }), "expected integer");
    refused(validateReactorPipeRequest({ cmd: "render_page_png", doc: 1, page: 0 }), "below minimum");
    refused(validateReactorPipeRequest({ cmd: "budget", held_bytes: 0 }), "below minimum");
    refused(validateReactorPipeRequest({ cmd: "recalc", doc: 1, clock: CLOCK, seed: -1 }), "below minimum");
    refused(validateReactorPipeRequest({ cmd: "caret_rects", doc: 1, object_id: "p", start: -1 }), "below minimum");
    refused(validateReactorPipeResponse({ ...RESPONSES.version[0], ms: -1 }), "below minimum");
    refused(validateReactorPipeResponse({ ...RESPONSES.version[0], abi: 1 }), "expected 2");
    refused(validateReactorPipeResponse({ ...RESPONSES.open[0], sha256: "ABC" }), "does not match");
  });

  test("render_page_png scale is above 0 and at most 16", () => {
    for (const scale of [0.25, 1, 16]) expect(validateReactorPipeRequest({ cmd: "render_page_png", doc: 1, page: 1, scale })).toEqual([]);
    for (const scale of [0, -1, 16.01, 100]) refused(validateReactorPipeRequest({ cmd: "render_page_png", doc: 1, page: 1, scale }), "$.scale");
    refused(validateReactorPipeRequest({ cmd: "render_page_png", doc: 1, page: 1, scale: "2" }), "expected number");
  });

  test("determinism members are RFC 3339 UTC clocks, strings and unsigned seeds, or null to keep the current one", () => {
    expect(validateReactorPipeRequest({ cmd: "layout", doc: 1, clock: null, timezone: null, locale: null, seed: null })).toEqual([]);
    refused(validateReactorPipeRequest({ cmd: "layout", doc: 1, clock: "yesterday" }), "does not match");
    refused(validateReactorPipeRequest({ cmd: "layout", doc: 1, clock: "2026-11-13T09:00:00+02:00" }), "does not match");
    refused(validateReactorPipeRequest({ cmd: "layout", doc: 1, timezone: "" }), "too short");
    refused(validateReactorPipeRequest({ cmd: "layout", doc: 1, seed: 1.5 }), "expected integer");
    refused(validateReactorPipeRequest({ cmd: "recalc", doc: 1, clock: null, seed: 0 }), "expected string");
  });

  test("extract takes the documented selectors only, damage_report the documented baselines", () => {
    expect(validateReactorPipeRequest({ cmd: "extract", doc: 1, options: { what: ["text", "structure", "markdown", "chunks", "barcodes"] } })).toEqual([]);
    refused(validateReactorPipeRequest({ cmd: "extract", doc: 1, options: { what: ["pixels"] } }), "not in enum");
    refused(validateReactorPipeRequest({ cmd: "damage_report", doc: 1, options: { baselines: ["word"] } }), "not in enum");
    refused(validateReactorPipeRequest({ cmd: "damage_report", doc: 1, options: { extra: true } }), "unexpected extra");
  });

  test("sheet_viewport takes a sheet name or a 1-based sheet index", () => {
    expect(validateReactorPipeRequest({ cmd: "sheet_viewport", doc: 1, sheet: 2 })).toEqual([]);
    expect(validateReactorPipeRequest({ cmd: "sheet_viewport", doc: 1 })).toEqual([]);
    refused(validateReactorPipeRequest({ cmd: "sheet_viewport", doc: 1, sheet: 0 }), "matches none of anyOf");
    refused(validateReactorPipeRequest({ cmd: "sheet_viewport", doc: 1, sheet: "" }), "matches none of anyOf");
    refused(validateReactorPipeRequest({ cmd: "sheet_viewport", doc: 1, rows: 0 }), "below minimum");
  });
});

describe("reactor pipe: PDF", () => {
  test("pdf is a document format on exactly the commands that read it", () => {
    expect([...REACTOR_PIPE_PDF_COMMANDS].sort()).toEqual(["display_list", "extract", "layout", "open", "render_page_png"]);
    for (const cmd of REACTOR_PIPE_PDF_COMMANDS) expect(REACTOR_PIPE_COMMANDS).toContain(cmd);
  });

  test("open names the formats docx, xlsx, pptx and pdf", () => {
    for (const format of ["docx", "xlsx", "pptx", "pdf"])
      expect(validateReactorPipeRequest({ cmd: "open", bytes: bin(0, 10), format })).toEqual([]);
    refused(validateReactorPipeRequest({ cmd: "open", bytes: bin(0, 10), format: "odt" }), "not in enum");
    refused(validateReactorPipeRequest({ cmd: "open", bytes: bin(0, 10), format: "PDF" }), "not in enum");
  });

  test("every response that reports a format accepts pdf and refuses an unknown one", () => {
    const withFormat = (cmd: ReactorPipeCommand, format: string): Json => {
      const body = structuredClone(RESPONSES[cmd][0]);
      if (cmd === "layout") body.summary.format = format;
      else body.format = format;
      return body;
    };
    for (const cmd of ["open", "extract", "layout", "render_page_png", "fonts"] as const) {
      expect(validateReactorPipeResponse(withFormat(cmd, "pdf"))).toEqual([]);
      refused(validateReactorPipeResponse(withFormat(cmd, "rtf")), "not in enum");
    }
  });

  test("the other commands answer a PDF with unsupported", () => {
    for (const cmd of REACTOR_PIPE_COMMANDS.filter((c) => !(REACTOR_PIPE_PDF_COMMANDS as readonly string[]).includes(c)))
      expect(validateReactorPipeResponse({ cmd, ok: false, ms: 0, error: { code: "unsupported", message: "a PDF has no such view", argument: "doc" } })).toEqual([]);
  });
});

describe("reactor pipe: refusals", () => {
  test("the contract names the licence refusals", () => {
    expect([...REACTOR_PIPE_LICENSE_ERROR_CODES]).toEqual(["license-seat-limit", "license-workspace-limit", "license-oem-required", "license-invalid"]);
    for (const code of REACTOR_PIPE_LICENSE_ERROR_CODES) expect(REACTOR_PIPE_ERROR_CODES).toContain(code);
    const knownInSchema = (REACTOR_PIPE_SCHEMA.$defs as Json).knownErrorCode.enum as string[];
    expect([...knownInSchema].sort()).toEqual([...REACTOR_PIPE_ERROR_CODES].sort());
  });

  test("a refusal has ok false, ms, and an error with a kebab-case code and a message", () => {
    const refusal = { cmd: "open", ok: false, ms: 1, error: { code: "license-seat-limit", message: "6 of 5 seats" } };
    const unattributed = { ok: false, ms: 0.1, error: { code: "bad-request", message: "unknown cmd", argument: "cmd" } };
    expect(validateReactorPipeResponse(refusal)).toEqual([]);
    expect(validateReactorPipeResponse(unattributed)).toEqual([]);
    expect(
      validateReactorPipeEnvelope({
        contract: REACTOR_PIPE_CONTRACT,
        kind: "response",
        header: { req_id: 9, json_bytes: JSON.stringify(unattributed).length, bin_count: 0 },
        body: unattributed,
      }),
    ).toEqual([]);
    refused(validateReactorPipeResponse({ ...refusal, ok: true }), "expected false");
    refused(validateReactorPipeResponse({ ...refusal, error: { code: "SeatLimit", message: "x" } }), "does not match");
    refused(validateReactorPipeResponse({ ...refusal, error: { code: "seat limit", message: "x" } }), "does not match");
    refused(validateReactorPipeResponse({ ...refusal, error: { code: "seat-limit" } }), "missing message");
    refused(validateReactorPipeResponse({ ...refusal, error: "no" }), "expected object");
    refused(validateReactorPipeResponse({ ...refusal, cmd: "nope" }), "not in enum");
    refused(validateReactorPipeResponse({ ...unattributed, cmd: null }), "not in enum");
  });

  test("a response without error must carry its command's members", () => {
    refused(validateReactorPipeResponse({ cmd: "save", ok: true, ms: 1 }), "missing doc");
    refused(validateReactorPipeResponse({ ...RESPONSES.save[0], ok: false }), "expected true");
  });
});

describe("reactor pipe: entitlement", () => {
  const tier = (tierName: string, over: Json = {}) => ({ ...ENTITLEMENT, tier: tierName, ...over });

  test("the community limits are one workspace and five seats", () => {
    expect(COMMUNITY_SELFHOST_MAX_WORKSPACES).toBe(1);
    expect(COMMUNITY_SELFHOST_MAX_SEATS).toBe(5);
  });

  test("community, commercial and oem entitlements are valid", () => {
    expect(validateReactorPipeResponse(tier("community"))).toEqual([]);
    expect(validateReactorPipeResponse(tier("community", { max_seats: 3, max_workspaces: 1 }))).toEqual([]);
    expect(validateReactorPipeResponse(tier("commercial", { max_workspaces: 10, max_seats: 250, sso: true, key_id: "key-2026-01", expires_at: "2027-01-01T00:00:00Z" }))).toEqual([]);
    expect(validateReactorPipeResponse(tier("commercial", { max_workspaces: null, max_seats: null, sso: true, key_id: "k1" }))).toEqual([]);
    expect(validateReactorPipeResponse(tier("oem", { max_workspaces: null, max_seats: null, oem_offline_wasm: true, key_id: "oem-1" }))).toEqual([]);
  });

  test("a community entitlement is keyless, has no SSO and stays within 1 workspace and 5 seats", () => {
    refused(validateReactorPipeResponse(tier("community", { key_id: "k1" })), "$.key_id");
    refused(validateReactorPipeResponse(tier("community", { expires_at: "2027-01-01T00:00:00Z" })), "$.expires_at");
    refused(validateReactorPipeResponse(tier("community", { sso: true })), "$.sso");
    refused(validateReactorPipeResponse(tier("community", { max_seats: 6 })), "$.max_seats");
    refused(validateReactorPipeResponse(tier("community", { max_seats: null })), "$.max_seats");
    refused(validateReactorPipeResponse(tier("community", { max_workspaces: 2 })), "$.max_workspaces");
    refused(validateReactorPipeResponse(tier("community", { max_workspaces: null })), "$.max_workspaces");
    refused(validateReactorPipeResponse(tier("community", { oem_offline_wasm: true })), "$.oem_offline_wasm");
  });

  test("a commercial or oem entitlement comes from a key, and only oem may embed the module offline", () => {
    refused(validateReactorPipeResponse(tier("commercial", { key_id: null })), "$.key_id");
    refused(validateReactorPipeResponse(tier("oem", { key_id: null })), "$.key_id");
    refused(validateReactorPipeResponse(tier("commercial", { key_id: "k1", oem_offline_wasm: true })), "$.oem_offline_wasm");
  });

  test("the shape is closed: a tier, limits that are unsigned or null, booleans, and an instant or null", () => {
    refused(validateReactorPipeResponse(tier("enterprise")), "not in enum");
    refused(validateReactorPipeResponse(tier("commercial", { key_id: "k", max_seats: -1 })), "below minimum");
    refused(validateReactorPipeResponse(tier("commercial", { key_id: "k", max_seats: "5" })), "expected integer|null");
    refused(validateReactorPipeResponse(tier("commercial", { key_id: "k", sso: "yes" })), "expected boolean");
    refused(validateReactorPipeResponse(tier("commercial", { key_id: "k", expires_at: "soon" })), "does not match");
    refused(validateReactorPipeResponse(edit(ENTITLEMENT, (e) => delete e.key_id)), "missing key_id");
    refused(validateReactorPipeResponse(edit(ENTITLEMENT, (e) => delete e.max_seats)), "missing max_seats");
  });
});

describe("reactor pipe: framing", () => {
  test("a header is 12 little-endian bytes: req_id, json_bytes, bin_count", () => {
    expect(REACTOR_PIPE_HEADER_BYTES).toBe(12);
    const bytes = encodeReactorPipeHeader({ req_id: 0x01020304, json_bytes: 258, bin_count: 3 });
    expect(Array.from(bytes)).toEqual([4, 3, 2, 1, 2, 1, 0, 0, 3, 0, 0, 0]);
    expect(decodeReactorPipeHeader(bytes)).toEqual({ req_id: 0x01020304, json_bytes: 258, bin_count: 3 });
  });

  test("a header decodes from the front of a longer buffer, at any offset", () => {
    const header = { req_id: 4_294_967_295, json_bytes: REACTOR_PIPE_MAX_JSON_BYTES, bin_count: REACTOR_PIPE_MAX_BIN_COUNT };
    const wire = new Uint8Array(40);
    wire.set(encodeReactorPipeHeader(header), 5);
    expect(decodeReactorPipeHeader(wire.subarray(5))).toEqual(header);
    expect(REACTOR_PIPE_MAX_JSON_BYTES).toBe(64 * 1024 * 1024);
    expect(REACTOR_PIPE_MAX_BIN_COUNT).toBe(1024);
  });

  test("a header outside u32, 64 MiB of JSON or 1024 segments is refused", () => {
    expect(validateReactorPipeHeader({ req_id: 0, json_bytes: 0, bin_count: 0 })).toEqual([]);
    refused(validateReactorPipeHeader({ req_id: 4_294_967_296, json_bytes: 0, bin_count: 0 }), "above maximum");
    refused(validateReactorPipeHeader({ req_id: -1, json_bytes: 0, bin_count: 0 }), "below minimum");
    refused(validateReactorPipeHeader({ req_id: 1.5, json_bytes: 0, bin_count: 0 }), "expected integer");
    refused(validateReactorPipeHeader({ req_id: 0, json_bytes: REACTOR_PIPE_MAX_JSON_BYTES + 1, bin_count: 0 }), "above maximum");
    refused(validateReactorPipeHeader({ req_id: 0, json_bytes: 0, bin_count: REACTOR_PIPE_MAX_BIN_COUNT + 1 }), "above maximum");
    refused(validateReactorPipeHeader({ req_id: 0, json_bytes: 0 }), "missing bin_count");
    refused(validateReactorPipeHeader({ req_id: 0, json_bytes: 0, bin_count: 0, flags: 1 }), "unexpected flags");
    refused(validateReactorPipeHeader("header"), "expected object");
    expect(() => encodeReactorPipeHeader({ req_id: 2 ** 32, json_bytes: 0, bin_count: 0 })).toThrow(RangeError);
    expect(() => encodeReactorPipeHeader({ req_id: 0, json_bytes: -1, bin_count: 0 })).toThrow(RangeError);
    expect(() => decodeReactorPipeHeader(new Uint8Array(11))).toThrow(RangeError);
    const oversized = new Uint8Array(12);
    new DataView(oversized.buffer).setUint32(4, REACTOR_PIPE_MAX_JSON_BYTES + 1, true);
    expect(() => decodeReactorPipeHeader(oversized)).toThrow(RangeError);
  });

  test("a frame names its contract, its kind, its header and its body, and nothing else", () => {
    const good = frame("request", REQUESTS.version[0], []);
    expect(validateReactorPipeEnvelope(good)).toEqual([]);
    refused(validateReactorPipeEnvelope({ ...good, contract: "wolfsdk.reactor-pipe.v2" }), "$.contract");
    refused(validateReactorPipeEnvelope({ ...good, kind: "notice" }), "$.kind");
    refused(validateReactorPipeEnvelope({ ...good, extra: 1 }), "unexpected extra");
    refused(validateReactorPipeEnvelope({ contract: good.contract, kind: good.kind, body: good.body }), "missing header");
    refused(validateReactorPipeEnvelope({ contract: good.contract, kind: good.kind, header: good.header }), "missing body");
    refused(validateReactorPipeEnvelope({ ...good, header: { ...good.header, bin_count: 2000 } }), "$.header.bin_count");
    refused(validateReactorPipeEnvelope({ ...good, body: { cmd: "nope" } }), "$.body.cmd");
    refused(validateReactorPipeEnvelope(null), "expected object");
  });

  test("a response body is not a request frame and a request body is not a response frame", () => {
    refused(validateReactorPipeEnvelope(frame("request", RESPONSES.version[0], [])), "$.body");
    refused(validateReactorPipeEnvelope(frame("response", REQUESTS.version[0], [])), "$.body");
  });

  test("json_bytes may not be shorter than the body, and may be longer (padding or whitespace)", () => {
    const good = frame("request", REQUESTS.apply[0], []);
    expect(validateReactorPipeEnvelope({ ...good, header: { ...good.header, json_bytes: good.header.json_bytes + 10 } })).toEqual([]);
    refused(validateReactorPipeEnvelope({ ...good, header: { ...good.header, json_bytes: good.header.json_bytes - 1 } }), "json_bytes");
  });

  test("json_bytes counts UTF-8 bytes, not characters", () => {
    const body = { cmd: "resource", handle: "font:\u00e9\u00e9\u00e9" };
    const exact = frame("request", body, []);
    expect(exact.header.json_bytes).toBeGreaterThan(JSON.stringify(body).length);
    expect(validateReactorPipeEnvelope(exact)).toEqual([]);
    refused(validateReactorPipeEnvelope({ ...exact, header: { ...exact.header, json_bytes: JSON.stringify(body).length } }), "json_bytes");
  });

  test("the binary handles of a body are exactly the segments the header announces", () => {
    const open = REQUESTS.open[0];
    const good = frame("request", open, [4096]);
    expect(validateReactorPipeEnvelope(good, [4096])).toEqual([]);
    refused(validateReactorPipeEnvelope({ ...good, header: { ...good.header, bin_count: 0 } }), "is not below bin_count");
    refused(validateReactorPipeEnvelope({ ...good, header: { ...good.header, bin_count: 2 } }), "2 segments announced, the body names 1");
    refused(validateReactorPipeEnvelope(frame("request", edit(open, (b) => (b.bytes.bin = 3)) as Json, [4096])), "is not below bin_count");
    refused(validateReactorPipeEnvelope(frame("request", REQUESTS.version[0], [8])), "1 segments announced, the body names 0");
  });

  test("a segment is named once, and its length is the one read from the wire", () => {
    const observe = RESPONSES.observe[0];
    const good = frame("response", observe, [12, 5]);
    expect(validateReactorPipeEnvelope(good, [12, 5])).toEqual([]);
    refused(validateReactorPipeEnvelope(frame("response", edit(observe, (b) => (b.outputs[1].data.bin = 0)) as Json, [12, 5])), "named twice");
    refused(validateReactorPipeEnvelope(good, [12, 6]), "segment 1 has 6 bytes");
    refused(validateReactorPipeEnvelope(good, [12]), "2 announced, 1 read");
    refused(validateReactorPipeEnvelope(good, [12, 5, 1]), "2 announced, 3 read");
  });

  test("png, bytes and output data are all binary handles", () => {
    for (const cmd of ["save", "render_page_png", "resource", "extract"] as const) {
      const [body, bins] = RESPONSES[cmd];
      expect(bins.length).toBeGreaterThan(0);
      refused(validateReactorPipeEnvelope(frame("response", body, [])), "is not below bin_count");
    }
  });

  test("a binary handle is a closed {bin, len} object, and a buffer is never inline JSON", () => {
    refused(validateReactorPipeRequest({ cmd: "open", bytes: { bin: 0, len: 1, base64: "AAAA" } }), "unexpected base64");
    refused(validateReactorPipeRequest({ cmd: "open", bytes: "AAAA" }), "expected object");
    refused(validateReactorPipeRequest({ cmd: "open", bytes: { bin: -1, len: 1 } }), "below minimum");
    refused(validateReactorPipeRequest({ cmd: "open", bytes: { bin: 0 } }), "missing len");
  });
});

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

const T1 = "2026-11-13T09:00:00Z";
const T2 = "2026-11-13T09:05:00Z";
const T3 = "2026-11-13T09:10:00.250Z";
const USER = { kind: "user", id: "u-1", name: "Ada" };
const AGENT = { kind: "agent", id: "agent-1", name: "Review agent" };
const BATCH = { ops: [{ op: "set_text", target: "para:~2a9256c0", text: "Hello" }], label: "fix greeting" };
/** The four determinism members a stored batch always names. */
const PIN = { clock: CLOCK, timezone: "UTC", locale: "en-US", seed: 7 };
const PINNED = { ...BATCH, ...PIN };
const MEMO_HEAD = { revision: 2, sha256: H("c"), format: "docx", name: "memo.docx", updated_at: T3 };
const ENTRY_1 = {
  seq: 3,
  doc_name: "memo.docx",
  revision: 1,
  base_sha256: H("a"),
  result_sha256: H("b"),
  author: USER,
  batch: PINNED,
  proposal_id: null,
  approved_by: null,
  committed_at: T2,
};
const ENTRY_2 = {
  seq: 5,
  doc_name: "memo.docx",
  revision: 2,
  base_sha256: H("b"),
  result_sha256: H("c"),
  author: AGENT,
  batch: { ...PINNED, clock: T2 },
  proposal_id: "prop-1",
  approved_by: USER,
  committed_at: T3,
};
const PROPOSAL_1 = {
  proposal_id: "prop-1",
  doc_name: "memo.docx",
  base_revision: 1,
  author: AGENT,
  status: "approved",
  batches: [PINNED],
  preview_sha256: H("c"),
  created_at: T2,
};
const PROPOSAL_2 = {
  proposal_id: "prop-2",
  doc_name: "budget.xlsx",
  base_revision: 0,
  author: AGENT,
  status: "open",
  batches: [{ ops: [{ op: "set_cell", target: "sheet:#1/cell:B2", value: 42 }], ...PIN }],
  preview_sha256: H("e"),
  created_at: T3,
};
const THREAD = {
  thread_id: "thread-1",
  doc_name: "memo.docx",
  target_address: "para:~2a9256c0",
  mentions: [{ kind: "agent", id: "agent-1" }],
  messages: [
    { message_id: "m-1", author: USER, body: "Check this @agent-1", created_at: T2 },
    { message_id: "m-2", author: AGENT, body: "Fixed", created_at: T3 },
  ],
  resolved: false,
};
const ROOM = {
  contract: ROOM_CONTRACT,
  room_id: "room-1",
  workspace_id: "ws-1",
  seq: 7,
  documents: [
    { head: MEMO_HEAD, page_hashes: [H("1"), H("2")] },
    { head: { revision: 0, sha256: H("d"), format: "xlsx", name: "budget.xlsx", updated_at: T1 } },
    { head: { revision: 0, sha256: H("f"), format: "pdf", name: "terms.pdf", updated_at: T1 } },
  ],
  session_log: [ENTRY_1, ENTRY_2],
  proposals: [PROPOSAL_1, PROPOSAL_2],
  comments: [THREAD],
};

const SERVER_EVENTS: Record<string, Json> = {
  "room.snapshot": { type: "room.snapshot", seq: 7, room: ROOM },
  "doc.added": { type: "doc.added", seq: 2, document: { head: { revision: 0, sha256: H("d"), format: "xlsx", name: "budget.xlsx", updated_at: T1 } } },
  "doc.committed": { type: "doc.committed", seq: 5, head: MEMO_HEAD, entry: ENTRY_2 },
  "proposal.updated": { type: "proposal.updated", seq: 6, proposal: PROPOSAL_2 },
  "pages.invalidated": {
    type: "pages.invalidated",
    seq: 5,
    doc_name: "memo.docx",
    revision: 2,
    sha256: H("c"),
    page_hashes: [H("1"), H("2")],
    changed: [2],
    removed: [3],
  },
  "comment.updated": { type: "comment.updated", seq: 7, thread: THREAD },
  "agent.activity": { type: "agent.activity", seq: 7, agent: { id: "agent-1", name: "Review agent" }, doc_name: "memo.docx", activity: "proposing", detail: "section 2", at: T3 },
  error: { type: "error", request_id: "req-1", code: "FORBIDDEN", message: "read-only seat" },
};
const MISMATCH = {
  type: "error",
  request_id: "req-9",
  code: "REVISION_MISMATCH",
  message: "memo.docx is at revision 2",
  detail: { doc_name: "memo.docx", base_revision: 1, head: MEMO_HEAD },
};

const CLIENT_MESSAGES: Record<string, Json> = {
  "room.join": { type: "room.join", request_id: "req-1", room_id: "room-1", since_seq: null },
  "doc.edit": { type: "doc.edit", request_id: "req-2", doc_name: "memo.docx", base_revision: 2, mode: "commit", batch: BATCH },
  "proposal.decide": { type: "proposal.decide", request_id: "req-3", proposal_id: "prop-2", decision: "approve" },
  "comment.post": {
    type: "comment.post",
    request_id: "req-4",
    thread_id: null,
    doc_name: "memo.docx",
    target_address: "para:~2a9256c0",
    body: "Looks right",
    mentions: [{ kind: "user", id: "u-1" }],
  },
};

describe("room: contract", () => {
  test("the contract, its schema and its message types", () => {
    expect(ROOM_CONTRACT).toBe("wolfsdk.room.v1");
    expect(ROOM_SCHEMA.$id).toBe("https://wolfsdk.com/schemas/room.v1.schema.json");
    expect([...ROOM_PROPOSAL_STATUSES]).toEqual(["open", "approved", "rejected", "superseded", "conflicted"]);
    expect([...(ROOM_SERVER_EVENT_TYPES as readonly string[])].sort()).toEqual(Object.keys(SERVER_EVENTS).sort());
    expect([...(ROOM_CLIENT_MESSAGE_TYPES as readonly string[])].sort()).toEqual(Object.keys(CLIENT_MESSAGES).sort());
    const defs = ROOM_SCHEMA.$defs as Json;
    expect(defs.proposalStatus.enum).toEqual([...ROOM_PROPOSAL_STATUSES]);
    expect(defs.agentActivity.enum).toEqual([...ROOM_AGENT_ACTIVITIES]);
    expect(defs.ev_error.properties.code.enum).toEqual([...ROOM_ERROR_CODES]);
  });

  test("the schema defs behind each message type exist", () => {
    const defs = Object.keys(ROOM_SCHEMA.$defs as Json);
    for (const def of ["roomState", "head", "proposal", "thread", "sessionEntry", "pinnedBatch", "conflictDetail", "ev_doc_added", "serverEvent", "clientMessage"]) expect(defs).toContain(def);
  });
});

describe("room: snapshot", () => {
  test("a snapshot of documents, log, proposals and threads is valid", () => {
    expect(validateRoomSnapshot(ROOM)).toEqual([]);
  });

  test("an empty room is valid", () => {
    expect(validateRoomSnapshot({ contract: ROOM_CONTRACT, room_id: "r", workspace_id: "w", seq: 0, documents: [], session_log: [], proposals: [], comments: [] })).toEqual([]);
  });

  test("every proposal status is valid", () => {
    for (const status of ROOM_PROPOSAL_STATUSES) {
      const preview = status === "open" || status === "approved" ? H("e") : null;
      expect(validateRoomSnapshot(edit(ROOM, (r) => Object.assign(r.proposals[1], { status, preview_sha256: preview })))).toEqual([]);
    }
  });

  test("a rejected, superseded or conflicted proposal may have no preview; an open or approved one may not", () => {
    for (const status of ["rejected", "superseded", "conflicted"])
      expect(validateRoomSnapshot(edit(ROOM, (r) => Object.assign(r.proposals[1], { status, preview_sha256: null })))).toEqual([]);
    for (const status of ["open", "approved"])
      refused(validateRoomSnapshot(edit(ROOM, (r) => Object.assign(r.proposals[1], { status, preview_sha256: null }))), "has a preview");
  });

  test("the shape is closed: contract, members, ids, hashes, formats, instants", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.contract = "wolfsdk.room.v2"))), "$.contract");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.extra = 1))), "unexpected extra");
    refused(validateRoomSnapshot(edit(ROOM, (r) => delete r.workspace_id)), "missing workspace_id");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.room_id = "has space"))), "$.room_id");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.room_id = ""))), "$.room_id");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.seq = -1))), "below minimum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.sha256 = "xyz"))), "does not match");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.format = "odt"))), "not in enum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.updated_at = "yesterday"))), "does not match");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.extra = 1))), "unexpected extra");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].status = "pending"))), "not in enum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].author.kind = "bot"))), "not in enum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => delete r.session_log[0].batch)), "missing batch");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].revision = 0))), "below minimum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].resolved = "no"))), "expected boolean");
    refused(validateRoomSnapshot([]), "expected object");
    refused(validateRoomSnapshot(null), "expected object");
  });

  test("an instant that matches the pattern but is not on the calendar is refused", () => {
    expect(isWorkspaceInstant("2028-02-29T23:59:59Z")).toBe(true);
    expect(isWorkspaceInstant("2026-11-13T09:00:00.123456Z")).toBe(true);
    for (const bad of ["2026-13-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T09:60:00Z", "2026-11-13T09:00:60Z", "2026-00-10T00:00:00Z", "2026-11-13T09:00:00", "2026-11-13T09:00:00+01:00", "2100-02-29T00:00:00Z"])
      expect(isWorkspaceInstant(bad)).toBe(false);
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[1].head.updated_at = "2026-13-45T99:99:99Z"))), "not a calendar instant");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].committed_at = "2026-02-30T00:00:00Z"))), "not a calendar instant");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[1].created_at = "2026-11-31T00:00:00Z"))), "not a calendar instant");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].messages[0].created_at = "2026-11-13T25:00:00Z"))), "not a calendar instant");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].batch.clock = "2026-11-13T09:99:00Z"))), "not a calendar instant");
  });

  test("document names are unique and every record names a document of the room", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[1].head.name = "memo.docx"))), "names two documents");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].doc_name = "ghost.docx"))), "is not a document of the room");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].doc_name = "ghost.docx"))), "is not a document of the room");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].doc_name = "ghost.docx"))), "is not a document of the room");
  });

  test("the log is in commit order, within the room's seq, one revision at a time, each based on the one before", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].seq = 3))), "does not follow 3");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].seq = 2))), "does not follow 3");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].seq = 8))), "is ahead of room seq 7");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].seq = 0))), "does not follow 0");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].revision = 2))), "does not follow 0");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].revision = 4))), "does not follow 1");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].base_sha256 = H("9")))), "is not the result of revision 1");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].batch.ops = []))), "at least one op");
  });

  test("a head is the last revision of the log: its number, its sha256 and its time", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.revision = 3))), "the log ends at 2");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.sha256 = H("9")))), "is not the result of revision 2");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[0].head.updated_at = T1))), "is not the commit time of revision 2");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.documents[1].head.revision = 1))), "the log ends at 0");
  });

  test("proposal ids and thread ids are unique; a proposal is based on a revision that exists", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[1].proposal_id = "prop-1"))), "is used twice");
    refused(validateRoomSnapshot(edit(ROOM, (r) => r.comments.push(structuredClone(r.comments[0])))), "is used twice");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].base_revision = 3))), "is ahead of head revision 2");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].batches = []))), "at least one batch");
  });

  test("a log entry from a proposal names an approved proposal for the same document", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].proposal_id = "prop-9"))), "is not a proposal of the room");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].status = "rejected"))), "is not an approved proposal");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].proposal_id = "prop-2"))), "is not an approved proposal");
  });

  test("every batch of the log and of a proposal pins its clock, timezone, locale and seed", () => {
    for (const member of ["clock", "timezone", "locale", "seed"]) {
      refused(validateRoomSnapshot(edit(ROOM, (r) => delete r.session_log[0].batch[member])), `missing ${member}`);
      refused(validateRoomSnapshot(edit(ROOM, (r) => delete r.proposals[1].batches[0][member])), `missing ${member}`);
    }
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].batch.seed = -1))), "below minimum");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].batch.seed = 1.5))), "expected integer");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.proposals[0].batches[0].locale = ""))), "too short");
    expect(validateRoomSnapshot(edit(ROOM, (r) => Object.assign(r.session_log[1].batch, { timezone: "Europe/Paris", locale: "fr-FR", seed: 0 })))).toEqual([]);
  });

  test("a log entry names its approver: null for a direct commit, a user for a proposal, never an agent", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[0].approved_by = USER))), "a direct commit has no approver");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].approved_by = null))), "a commit from a proposal names its approver");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].approved_by = AGENT))), "a proposal is approved by a user, not an agent");
    refused(validateRoomSnapshot(edit(ROOM, (r) => delete r.session_log[0].approved_by)), "missing approved_by");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.session_log[1].approved_by = { kind: "user", id: "u-2" }))), "matches none of anyOf");
  });

  test("a thread has messages with distinct ids", () => {
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].messages = []))), "at least one message");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].messages[1].message_id = "m-1"))), "is used twice");
    refused(validateRoomSnapshot(edit(ROOM, (r) => (r.comments[0].messages[0].body = ""))), "too short");
  });
});

describe("room: server events", () => {
  for (const [type, event] of Object.entries(SERVER_EVENTS))
    test(`${type} is valid`, () => {
      expect(validateRoomEvent(event)).toEqual([]);
    });

  test("a REVISION_MISMATCH error carries the document, the stale revision and the head", () => {
    expect(validateRoomEvent(MISMATCH)).toEqual([]);
    expect(validateRoomEvent(edit(MISMATCH, (e) => (e.request_id = null)))).toEqual([]);
    refused(validateRoomEvent(edit(MISMATCH, (e) => delete e.detail)), "missing detail");
    refused(validateRoomEvent(edit(MISMATCH, (e) => (e.detail.base_revision = 2))), "there is no mismatch");
    refused(validateRoomEvent(edit(MISMATCH, (e) => (e.detail.doc_name = "other.docx"))), "is not the document of the conflict");
    refused(validateRoomEvent(edit(MISMATCH, (e) => (e.detail.head.revision = -1))), "below minimum");
  });

  test("every other error code is valid, and REVISION_MISMATCH is not one of them", () => {
    for (const code of ROOM_ERROR_CODES) expect(validateRoomEvent({ type: "error", request_id: null, code, message: "no" })).toEqual([]);
    refused(validateRoomEvent({ type: "error", request_id: "r", code: "TEAPOT", message: "no" }), "not in enum");
    refused(validateRoomEvent({ type: "error", request_id: "r", code: "REVISION_MISMATCH", message: "no" }), "missing detail");
  });

  test("ENGINE_FAILED is an error code, and an unknown code is still refused", () => {
    expect(ROOM_ERROR_CODES).toContain("ENGINE_FAILED");
    expect(validateRoomEvent({ type: "error", request_id: "r-1", code: "ENGINE_FAILED", message: "the engine timed out" })).toEqual([]);
    refused(validateRoomEvent({ type: "error", request_id: "r-1", code: "ENGINE_BROKEN", message: "no" }), "not in enum");
  });

  test("doc.added announces a document at revision 0", () => {
    const base = SERVER_EVENTS["doc.added"];
    expect(validateRoomEvent(edit(base, (e) => (e.document.page_hashes = [H("1"), H("2")])))).toEqual([]);
    refused(validateRoomEvent(edit(base, (e) => (e.document.head.revision = 1))), "$.document.head.revision: a document is added at revision 0");
    refused(validateRoomEvent(edit(base, (e) => (e.document.head.updated_at = "2026-02-30T00:00:00Z"))), "not a calendar instant");
    refused(validateRoomEvent(edit(base, (e) => delete e.document)), "missing document");
    refused(validateRoomEvent(edit(base, (e) => (e.document.head.format = "odt"))), "not in enum");
  });

  test("doc.committed names the approver of the proposal it came from, and only a user", () => {
    const base = SERVER_EVENTS["doc.committed"];
    refused(validateRoomEvent(edit(base, (e) => (e.entry.approved_by = null))), "a commit from a proposal names its approver");
    refused(validateRoomEvent(edit(base, (e) => (e.entry.approved_by = AGENT))), "a proposal is approved by a user, not an agent");
    refused(validateRoomEvent(edit(base, (e) => ((e.entry.proposal_id = null), (e.entry.approved_by = USER)))), "a direct commit has no approver");
    expect(validateRoomEvent(edit(base, (e) => ((e.entry.proposal_id = null), (e.entry.approved_by = null))))).toEqual([]);
    refused(validateRoomEvent(edit(base, (e) => delete e.entry.batch.seed)), "missing seed");
  });

  test("a snapshot carries the room it names, at the seq it names", () => {
    refused(validateRoomEvent(edit(SERVER_EVENTS["room.snapshot"], (e) => (e.seq = 6))), "is not the seq of the room");
    refused(validateRoomEvent(edit(SERVER_EVENTS["room.snapshot"], (e) => (e.room.documents[0].head.revision = 9))), "$.room.documents[0].head.revision");
    refused(validateRoomEvent(edit(SERVER_EVENTS["room.snapshot"], (e) => delete e.room)), "missing room");
  });

  test("doc.committed: the head is the entry's result, in the seq of the event", () => {
    const base = SERVER_EVENTS["doc.committed"];
    refused(validateRoomEvent(edit(base, (e) => (e.seq = 6))), "is not the seq of the event");
    refused(validateRoomEvent(edit(base, (e) => (e.head.name = "budget.xlsx"))), "is not the document of the entry");
    refused(validateRoomEvent(edit(base, (e) => (e.head.revision = 3))), "is not the revision of the entry");
    refused(validateRoomEvent(edit(base, (e) => (e.head.sha256 = H("9")))), "is not the result of the entry");
    refused(validateRoomEvent(edit(base, (e) => (e.head.updated_at = T1))), "is not the commit time of the entry");
    refused(validateRoomEvent(edit(base, (e) => (e.entry.batch.ops = []))), "at least one op");
  });

  test("pages.invalidated: changed pages exist in the new revision, removed pages do not", () => {
    const base = SERVER_EVENTS["pages.invalidated"];
    expect(validateRoomEvent(edit(base, (e) => Object.assign(e, { changed: [], removed: [] })))).toEqual([]);
    expect(validateRoomEvent(edit(base, (e) => Object.assign(e, { changed: [1, 2], removed: [3, 4] })))).toEqual([]);
    refused(validateRoomEvent(edit(base, (e) => (e.changed = [3]))), "is not one of the 2 pages");
    refused(validateRoomEvent(edit(base, (e) => (e.removed = [2]))), "is still a page of the revision");
    refused(validateRoomEvent(edit(base, (e) => (e.changed = [1, 1]))), "is listed twice");
    refused(validateRoomEvent(edit(base, (e) => (e.removed = [3, 3]))), "is listed twice");
    refused(validateRoomEvent(edit(base, (e) => (e.changed = [0]))), "below minimum");
    refused(validateRoomEvent(edit(base, (e) => (e.page_hashes = ["abc"]))), "does not match");
    refused(validateRoomEvent(edit(base, (e) => delete e.removed)), "missing removed");
  });

  test("proposal.updated, comment.updated and agent.activity carry valid records", () => {
    refused(validateRoomEvent(edit(SERVER_EVENTS["proposal.updated"], (e) => (e.proposal.preview_sha256 = null))), "has a preview");
    refused(validateRoomEvent(edit(SERVER_EVENTS["comment.updated"], (e) => (e.thread.messages = []))), "at least one message");
    refused(validateRoomEvent(edit(SERVER_EVENTS["agent.activity"], (e) => (e.activity = "dancing"))), "not in enum");
    refused(validateRoomEvent(edit(SERVER_EVENTS["agent.activity"], (e) => (e.at = "2026-13-13T00:00:00Z"))), "not a calendar instant");
    for (const activity of ROOM_AGENT_ACTIVITIES) expect(validateRoomEvent(edit(SERVER_EVENTS["agent.activity"], (e) => (e.activity = activity)))).toEqual([]);
    expect(validateRoomEvent(edit(SERVER_EVENTS["agent.activity"], (e) => ((e.doc_name = null), delete e.detail)))).toEqual([]);
  });

  test("an unknown or missing type, an extra member and a non-object are refused", () => {
    refused(validateRoomEvent({ type: "room.deleted", seq: 1 }), "is not a room server event");
    refused(validateRoomEvent({ type: "constructor", seq: 1 }), "is not a room server event");
    refused(validateRoomEvent({ type: "__proto__" }), "is not a room server event");
    refused(validateRoomEvent({ seq: 1 }), "is not a room server event");
    refused(validateRoomEvent(edit(SERVER_EVENTS["comment.updated"], (e) => (e.extra = 1))), "unexpected extra");
    refused(validateRoomEvent(edit(SERVER_EVENTS["comment.updated"], (e) => delete e.seq)), "missing seq");
    refused(validateRoomEvent("room.snapshot"), "expected object");
    refused(validateRoomEvent(null), "expected object");
  });
});

describe("room: client messages", () => {
  for (const [type, message] of Object.entries(CLIENT_MESSAGES))
    test(`${type} is valid`, () => {
      expect(validateRoomClientMessage(message)).toEqual([]);
    });

  test("room.join resumes at a seq or asks for a snapshot", () => {
    expect(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => (m.since_seq = 12)))).toEqual([]);
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => (m.since_seq = -1))), "below minimum");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => (m.since_seq = 1.5))), "expected integer|null");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => delete m.since_seq)), "missing since_seq");
  });

  test("doc.edit is a propose or a commit of a non-empty batch against a revision", () => {
    expect(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.mode = "propose")))).toEqual([]);
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.mode = "merge"))), "not in enum");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.batch.ops = []))), "at least one op");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.batch.ops = [{ target: "x" }]))), "missing op");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => delete m.base_revision)), "missing base_revision");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.base_revision = -1))), "below minimum");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["doc.edit"], (m) => (m.batch.clock = "2026-02-31T00:00:00Z"))), "not a calendar instant");
  });

  test("doc.edit may pin any of the clock, timezone, locale and seed", () => {
    const pinned = (pin: Json) => edit(CLIENT_MESSAGES["doc.edit"], (m) => Object.assign(m.batch, pin));
    expect(validateRoomClientMessage(pinned({ locale: "de-DE" }))).toEqual([]);
    expect(validateRoomClientMessage(pinned({ seed: 42 }))).toEqual([]);
    expect(validateRoomClientMessage(pinned(PIN))).toEqual([]);
    refused(validateRoomClientMessage(pinned({ seed: -1 })), "below minimum");
    refused(validateRoomClientMessage(pinned({ seed: 0.5 })), "expected integer");
    refused(validateRoomClientMessage(pinned({ locale: "" })), "too short");
    refused(validateRoomClientMessage(pinned({ timezone: "" })), "too short");
  });

  test("comment.post can resolve a thread it replies to, and not one it opens", () => {
    const post = (change: (m: Json) => void) => edit(CLIENT_MESSAGES["comment.post"], change);
    expect(validateRoomClientMessage(post((m) => ((m.thread_id = "thread-1"), (m.resolve = true))))).toEqual([]);
    expect(validateRoomClientMessage(post((m) => (m.resolve = false)))).toEqual([]);
    refused(validateRoomClientMessage(post((m) => (m.resolve = true))), "$.resolve: a new thread has nothing to resolve");
    refused(validateRoomClientMessage(post((m) => ((m.thread_id = "thread-1"), (m.resolve = "yes")))), "expected boolean");
  });

  test("proposal.decide approves or rejects, comment.post opens or continues a thread", () => {
    expect(validateRoomClientMessage(edit(CLIENT_MESSAGES["proposal.decide"], (m) => (m.decision = "reject")))).toEqual([]);
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["proposal.decide"], (m) => (m.decision = "maybe"))), "not in enum");
    expect(validateRoomClientMessage(edit(CLIENT_MESSAGES["comment.post"], (m) => (m.thread_id = "thread-1")))).toEqual([]);
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["comment.post"], (m) => (m.body = ""))), "too short");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["comment.post"], (m) => (m.mentions = [{ kind: "team", id: "t" }]))), "not in enum");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["comment.post"], (m) => delete m.thread_id)), "missing thread_id");
  });

  test("an unknown type, an extra member and a non-object are refused", () => {
    refused(validateRoomClientMessage({ type: "room.leave", request_id: "r" }), "is not a room client message");
    refused(validateRoomClientMessage({ type: "constructor" }), "is not a room client message");
    refused(validateRoomClientMessage({ type: "error", request_id: "r" }), "is not a room client message");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => (m.extra = 1))), "unexpected extra");
    refused(validateRoomClientMessage(edit(CLIENT_MESSAGES["room.join"], (m) => (m.request_id = ""))), "$.request_id");
    refused(validateRoomClientMessage(7), "expected object");
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const MCP_CALLS: Record<string, Json> = {
  workspace_list: { name: "workspace_list", arguments: { format: "pdf", limit: 25 } },
  doc_read: { name: "doc_read", arguments: { doc: "budget.xlsx", view: "cells", target: "sheet:#1/range:A1:K50", max_nodes: 200 } },
  doc_search: { name: "doc_search", arguments: { query: "Q3 revenue", doc: "budget.xlsx", regex: false, limit: 10 } },
  doc_create: { name: "doc_create", arguments: { name: "plan.docx", format: "docx", template: "memo.docx", ops: [{ op: "set_text", target: "para:~2a9256c0", text: "Plan" }] } },
  doc_edit: { name: "doc_edit", arguments: { doc: "memo.docx", base_revision: 2, mode: "propose", ops: [{ op: "set_text", target: "para:~2a9256c0", text: "Hi" }], message: "fix greeting" } },
  doc_inspect_visual: { name: "doc_inspect_visual", arguments: { doc: "deck.pptx", pages: [1, 2, 3], dpi: 150, preflight: true, proposal_id: "prop-1" } },
  pack_link_refresh: { name: "pack_link_refresh", arguments: { pack: "q3-board-pack", bindings: ["revenue_table", "headline"], mode: "commit" } },
  comment_reply: { name: "comment_reply", arguments: { thread_id: "thread-1", body: "Done, thanks @u-1", resolve: true } },
};
const mcpCall = (name: string, change: (args: Json) => void) => edit(MCP_CALLS[name], (c) => change(c.arguments));

describe("mcp: tool list and budget", () => {
  test("eight tools, in order", () => {
    expect(MCP_WORKSPACE_CONTRACT).toBe("wolfsdk.mcp-workspace.v1");
    expect(MCP_WORKSPACE_SCHEMA.$id).toBe("https://wolfsdk.com/schemas/mcp-workspace.v1.schema.json");
    expect(MCP_WORKSPACE_TOOLS.map((t) => t.name)).toEqual([...MCP_WORKSPACE_TOOL_NAMES]);
    expect(MCP_WORKSPACE_TOOL_NAMES).toEqual([
      "workspace_list",
      "doc_read",
      "doc_search",
      "doc_create",
      "doc_edit",
      "doc_inspect_visual",
      "pack_link_refresh",
      "comment_reply",
    ]);
    expect(Object.keys(MCP_CALLS).sort()).toEqual([...MCP_WORKSPACE_TOOL_NAMES].sort());
    expect((MCP_WORKSPACE_SCHEMA.properties as Json).name.enum).toEqual([...MCP_WORKSPACE_TOOL_NAMES]);
  });

  test("the serialized tool list is under 14000 UTF-8 bytes and 3500 tokens", () => {
    const bytes = utf8(JSON.stringify(MCP_WORKSPACE_TOOLS));
    expect(mcpToolsBytes()).toBe(bytes);
    expect(bytes).toBeLessThan(MCP_WORKSPACE_TOOLS_MAX_BYTES);
    expect(MCP_WORKSPACE_TOOLS_MAX_BYTES).toBe(14_000);
    expect(mcpToolsTokenEstimate()).toBe(Math.ceil(bytes / 4));
    expect(mcpToolsTokenEstimate()).toBeLessThanOrEqual(MCP_WORKSPACE_TOOLS_MAX_TOKENS);
    expect(MCP_WORKSPACE_TOOLS_MAX_TOKENS).toBe(3_500);
    expect(mcpToolsTokenEstimate()).toBeLessThan(4_000);
  });

  test("the token estimate is UTF-8 bytes over four, rounded up", () => {
    const tool = (description: string) => [{ name: "workspace_list" as const, description, inputSchema: {} }];
    expect(mcpToolsBytes(tool("abc"))).toBe(utf8(JSON.stringify(tool("abc"))));
    const a = tool("x".repeat(1));
    const b = tool("\u00e9".repeat(1));
    expect(mcpToolsBytes(b)).toBe(mcpToolsBytes(a) + 1);
    expect(mcpToolsTokenEstimate(a)).toBe(Math.ceil(mcpToolsBytes(a) / 4));
    expect(mcpToolsTokenEstimate([])).toBe(1);
  });

  test("each tool has a name, a description and a self-contained object inputSchema", () => {
    for (const tool of MCP_WORKSPACE_TOOLS) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
    }
  });

  test("doc_edit takes a mode and a base_revision, doc_inspect_visual a dpi, pages and preflight", () => {
    const tool = (name: string) => MCP_WORKSPACE_TOOLS.find((t) => t.name === name)?.inputSchema as Json;
    const edit_ = tool("doc_edit");
    expect(edit_.required).toEqual(["doc", "base_revision", "mode", "ops"]);
    expect(edit_.properties.mode.enum).toEqual(["propose", "commit"]);
    expect(edit_.properties.base_revision.type).toBe("integer");
    const visual = tool("doc_inspect_visual");
    expect(visual.properties.dpi.enum).toEqual([72, 96, 150]);
    expect(visual.properties.pages.type).toBe("array");
    expect(visual.properties.preflight.type).toBe("boolean");
    expect(tool("workspace_list").required).toBeUndefined();
    expect(tool("doc_create").properties.format.enum).toEqual(["docx", "xlsx", "pptx"]);
  });

  // A model endpoint that decodes tool calls against the schema treats an object with no
  // additionalProperties as closed: with ops declared as `{op}` only, it can never write the
  // target or value of an op and never ends the call.
  test("every object in a tool schema says whether it is open, and edit ops are open", () => {
    const undeclared: string[] = [];
    const walk = (node: Json, path: string) => {
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${path}[${i}]`));
      if (node === null || typeof node !== "object") return;
      if (node.type === "object" && typeof node.additionalProperties !== "boolean") undeclared.push(path);
      for (const [key, child] of Object.entries(node)) walk(child as Json, `${path}.${key}`);
    };
    for (const tool of MCP_WORKSPACE_TOOLS) walk(tool.inputSchema as Json, tool.name);
    expect(undeclared).toEqual([]);
    for (const name of ["doc_edit", "doc_create"]) {
      const schema = MCP_WORKSPACE_TOOLS.find((t) => t.name === name)?.inputSchema as Json;
      expect(schema.properties.ops.items.additionalProperties).toBe(true);
    }
  });
});

describe("mcp: tools/call", () => {
  for (const [name, call] of Object.entries(MCP_CALLS))
    test(`${name}: a full call and a minimal call are valid`, () => {
      expect(validateMcpToolCall(call)).toEqual([]);
      const tool = MCP_WORKSPACE_TOOLS.find((t) => t.name === name);
      const required = tool?.inputSchema.required ?? [];
      const minimal = Object.fromEntries(required.map((k) => [k, call.arguments[k]]));
      expect(validateMcpToolCall({ name, arguments: minimal })).toEqual([]);
    });

  test("a missing required argument is refused for every tool that has one", () => {
    for (const tool of MCP_WORKSPACE_TOOLS)
      for (const key of tool.inputSchema.required ?? []) refused(validateMcpToolCall(mcpCall(tool.name, (a) => delete a[key])), `$.arguments: missing ${key}`);
  });

  test("an argument the tool does not take is refused for every tool", () => {
    for (const name of MCP_WORKSPACE_TOOL_NAMES) refused(validateMcpToolCall(mcpCall(name, (a) => (a.surprise = 1))), "$.arguments: unexpected surprise");
  });

  test("an unknown tool, a missing member and a non-object are refused", () => {
    refused(validateMcpToolCall({ name: "doc_delete", arguments: {} }), "not in enum");
    refused(validateMcpToolCall({ name: "constructor", arguments: {} }), "not in enum");
    refused(validateMcpToolCall({ arguments: {} }), "missing name");
    refused(validateMcpToolCall({ name: "workspace_list" }), "missing arguments");
    refused(validateMcpToolCall({ name: "workspace_list", arguments: [] }), "expected object");
    refused(validateMcpToolCall({ name: "workspace_list", arguments: {}, extra: 1 }), "unexpected extra");
    refused(validateMcpToolCall(null), "expected object");
    refused(validateMcpToolCall("workspace_list"), "expected object");
  });

  test("doc_edit: mode and base_revision are checked", () => {
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.mode = "merge"))), "$.arguments.mode");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.base_revision = -1))), "$.arguments.base_revision");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.base_revision = "2"))), "$.arguments.base_revision");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.base_revision = 2.5))), "$.arguments.base_revision");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.ops = []))), "$.arguments.ops: fewer than 1 items");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.ops = [{ target: "x" }]))), "missing op");
    refused(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.ops = [{ op: "" }]))), "too short");
    expect(validateMcpToolCall(mcpCall("doc_edit", (a) => (a.base_revision = 0)))).toEqual([]);
  });

  test("doc_inspect_visual: dpi, pages and preflight are checked", () => {
    for (const dpi of [72, 96, 150]) expect(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.dpi = dpi)))).toEqual([]);
    for (const dpi of [100, 300, "96"]) refused(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.dpi = dpi))), "$.arguments.dpi");
    refused(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.pages = [0]))), "$.arguments.pages[0]");
    refused(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.pages = []))), "fewer than 1 items");
    refused(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.pages = "1"))), "expected array");
    refused(validateMcpToolCall(mcpCall("doc_inspect_visual", (a) => (a.preflight = "yes"))), "expected boolean");
  });

  test("workspace_list, doc_read, doc_create and comment_reply: enums and bounds are checked", () => {
    refused(validateMcpToolCall(mcpCall("workspace_list", (a) => (a.format = "odt"))), "$.arguments.format");
    refused(validateMcpToolCall(mcpCall("workspace_list", (a) => (a.limit = 0))), "$.arguments.limit");
    refused(validateMcpToolCall(mcpCall("doc_read", (a) => (a.view = "html"))), "$.arguments.view");
    refused(validateMcpToolCall(mcpCall("doc_read", (a) => (a.max_nodes = 0))), "$.arguments.max_nodes");
    refused(validateMcpToolCall(mcpCall("doc_read", (a) => (a.doc = ""))), "$.arguments.doc");
    refused(validateMcpToolCall(mcpCall("doc_create", (a) => (a.format = "pdf"))), "$.arguments.format");
    refused(validateMcpToolCall(mcpCall("doc_create", (a) => (a.ops = []))), "fewer than 1 items");
    refused(validateMcpToolCall(mcpCall("comment_reply", (a) => (a.body = ""))), "$.arguments.body");
    refused(validateMcpToolCall(mcpCall("comment_reply", (a) => (a.resolve = "true"))), "expected boolean");
  });

  test("doc_search: a regular-expression search needs a valid expression", () => {
    expect(validateMcpToolCall(mcpCall("doc_search", (a) => ((a.regex = true), (a.query = "Q[1-4] revenue"))))).toEqual([]);
    refused(validateMcpToolCall(mcpCall("doc_search", (a) => ((a.regex = true), (a.query = "Q[1-4 revenue")))), "not a valid regular expression");
    expect(validateMcpToolCall(mcpCall("doc_search", (a) => ((a.regex = false), (a.query = "Q[1-4 revenue"))))).toEqual([]);
    refused(validateMcpToolCall(mcpCall("doc_search", (a) => (a.query = ""))), "$.arguments.query");
  });

  test("pack_link_refresh: a binding is named once, and mode is propose or commit", () => {
    refused(validateMcpToolCall(mcpCall("pack_link_refresh", (a) => (a.bindings = ["a", "b", "a"]))), "is named twice");
    refused(validateMcpToolCall(mcpCall("pack_link_refresh", (a) => (a.bindings = []))), "fewer than 1 items");
    refused(validateMcpToolCall(mcpCall("pack_link_refresh", (a) => (a.mode = "dry-run"))), "$.arguments.mode");
  });
});

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

const PACK = {
  contract: PACK_CONTRACT,
  pack_id: "q3-board-pack",
  name: "Q3 board pack",
  sources: [
    { id: "model", kind: "xlsx", doc_name: "model.xlsx", determinism: { clock: CLOCK, seed: 0, timezone: "UTC", locale: "en-US" } },
    { id: "orders", kind: "csv_snapshot", doc_name: "orders.csv", determinism: { clock: CLOCK, seed: 1, snapshot_sha256: H("a") } },
    { id: "ledger", kind: "sql_snapshot", doc_name: "ledger.sql", determinism: { clock: CLOCK, seed: 2, snapshot_sha256: H("b") } },
  ],
  bindings: [
    {
      id: "revenue_table",
      source_id: "model",
      selector: { type: "range", sheet: "Summary", ref: "A1:E12" },
      target_doc: "board.docx",
      target_format: "docx",
      target_kind: "docx_table",
      target_address: "table:~11aa22bb",
      number_format: "#,##0.00",
      fit_policy: "grow",
    },
    {
      id: "net_income",
      source_id: "model",
      selector: { type: "defined_name", name: "NetIncome" },
      target_doc: "board.docx",
      target_format: "docx",
      target_kind: "docx_bookmark",
      target_address: "net_income",
      number_format: null,
      fit_policy: "truncate",
    },
    {
      id: "orders_table",
      source_id: "orders",
      selector: { type: "table", name: "Orders" },
      target_doc: "deck.pptx",
      target_format: "pptx",
      target_kind: "pptx_table",
      target_address: "shape:~33cc44dd",
      number_format: null,
      fit_policy: "none",
    },
    {
      id: "revenue_series",
      source_id: "ledger",
      selector: { type: "range", sheet: "Sheet1", ref: "$B$2:$B$13" },
      target_doc: "deck.pptx",
      target_format: "pptx",
      target_kind: "pptx_chart_series",
      target_address: "chart:~55ee66ff/series:1",
      number_format: "0.0%",
      fit_policy: "fail",
    },
    {
      id: "headline",
      source_id: "model",
      selector: { type: "cell", sheet: "Summary", ref: "B2" },
      target_doc: "deck.pptx",
      target_format: "pptx",
      target_kind: "pptx_fit_headline",
      target_address: "shape:~77aa88bb",
      number_format: "$#,##0",
      fit_policy: "shrink_to_fit",
    },
  ],
};
const bindingWith = (index: number, over: Json) => edit(PACK, (p) => Object.assign(p.bindings[index], over));

describe("pack: manifest", () => {
  test("a manifest with every source kind and every target kind is valid", () => {
    expect(PACK_CONTRACT).toBe("wolfsdk.pack.v1");
    expect(PACK_MANIFEST_FILE).toBe("pack.wolf.json");
    expect(PACK_SCHEMA.$id).toBe("https://wolfsdk.com/schemas/pack.v1.schema.json");
    expect(validatePackManifest(PACK)).toEqual([]);
    expect(new Set(PACK.bindings.map((b) => b.target_kind))).toEqual(new Set(PACK_TARGET_KINDS));
    expect(new Set(PACK.sources.map((s) => s.kind))).toEqual(new Set(["xlsx", "csv_snapshot", "sql_snapshot"]));
  });

  test("a pack with no bindings yet is valid", () => {
    expect(validatePackManifest(edit(PACK, (p) => (p.bindings = [])))).toEqual([]);
  });

  test("the shape is closed", () => {
    refused(validatePackManifest(edit(PACK, (p) => (p.contract = "wolfsdk.pack.v2"))), "$.contract");
    refused(validatePackManifest(edit(PACK, (p) => delete p.name)), "missing name");
    refused(validatePackManifest(edit(PACK, (p) => (p.extra = 1))), "unexpected extra");
    refused(validatePackManifest(edit(PACK, (p) => (p.pack_id = "Q3 Pack"))), "$.pack_id");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].kind = "parquet"))), "not in enum");
    refused(validatePackManifest(edit(PACK, (p) => delete p.sources[0].determinism.seed)), "missing seed");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].determinism.seed = -1))), "below minimum");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].determinism.clock = "noon"))), "does not match");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[1].determinism.snapshot_sha256 = "abc"))), "does not match");
    refused(validatePackManifest(bindingWith(0, { target_format: "xlsx" })), "not in enum");
    refused(validatePackManifest(bindingWith(0, { target_kind: "docx_image" })), "not in enum");
    refused(validatePackManifest(bindingWith(0, { fit_policy: "squash" })), "not in enum");
    refused(validatePackManifest(bindingWith(0, { number_format: "" })), "too short");
    refused(validatePackManifest(bindingWith(0, { selector: { type: "pivot", name: "x" } })), "matches none of anyOf");
    refused(validatePackManifest(edit(PACK, (p) => delete p.bindings[0].number_format)), "missing number_format");
    refused(validatePackManifest(edit(PACK, (p) => (p.bindings[0].id = "1st"))), "$.bindings[0].id");
    refused(validatePackManifest([]), "expected object");
    refused(validatePackManifest(null), "expected object");
  });

  test("selectors: a cell, a range, a table or a defined name", () => {
    for (const selector of [
      { type: "cell", sheet: "S", ref: "$A$1" },
      { type: "cell", sheet: "S", ref: "XFD1048576" },
      { type: "range", sheet: "S", ref: "A1:A1" },
      { type: "table", name: "Orders" },
      { type: "defined_name", name: "_Net.Income2" },
    ]) {
      const target =
        selector.type === "cell"
          ? { target_kind: "pptx_fit_headline", target_format: "pptx", target_doc: "d.pptx", fit_policy: "none" }
          : { target_kind: "docx_table", target_format: "docx", target_doc: "d.docx", fit_policy: "none" };
      expect(validatePackManifest(bindingWith(selector.type === "cell" ? 4 : 0, { selector, ...target }))).toEqual([]);
    }
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "b2" } })), "matches none of anyOf");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "A1:B2" } })), "matches none of anyOf");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "ABCD1" } })), "matches none of anyOf");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "", ref: "A1" } })), "matches none of anyOf");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "defined_name", name: "1Name" } })), "matches none of anyOf");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "A1", extra: 1 } })), "matches none of anyOf");
  });

  test("a cell or range reference is on the sheet grid, and a range runs forward", () => {
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "XFE1" } })), "is not a cell of the sheet grid");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "A1048577" } })), "is not a cell of the sheet grid");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "cell", sheet: "S", ref: "A0" } })), "is not a cell of the sheet grid");
    refused(validatePackManifest(bindingWith(0, { selector: { type: "range", sheet: "S", ref: "B2:A1" } })), "runs backwards");
    refused(validatePackManifest(bindingWith(0, { selector: { type: "range", sheet: "S", ref: "A5:B2" } })), "runs backwards");
    refused(validatePackManifest(bindingWith(0, { selector: { type: "range", sheet: "S", ref: "A1:XFE5" } })), "is not a range of the sheet grid");
  });

  test("ids are unique and every binding names a source of the pack", () => {
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[1].id = "model"))), "is used twice");
    refused(validatePackManifest(edit(PACK, (p) => (p.bindings[1].id = "revenue_table"))), "is used twice");
    refused(validatePackManifest(bindingWith(0, { source_id: "ghost" })), "is not a source of the pack");
  });

  test("a target kind belongs to its target format and its document", () => {
    refused(validatePackManifest(bindingWith(0, { target_format: "pptx", target_doc: "board.pptx" })), "docx_table is not a pptx target");
    refused(validatePackManifest(bindingWith(2, { target_format: "docx", target_doc: "deck.docx" })), "pptx_table is not a docx target");
    refused(validatePackManifest(bindingWith(0, { target_doc: "board.pptx" })), "a docx target is a .docx document");
    refused(validatePackManifest(bindingWith(2, { target_doc: "deck" })), "a pptx target is a .pptx document");
    expect(validatePackManifest(bindingWith(0, { target_doc: "BOARD.DOCX" }))).toEqual([]);
  });

  test("the fit policy matrix: each target kind honours only the policies it can", () => {
    expect(Object.keys(PACK_FIT_POLICIES_BY_TARGET).sort()).toEqual([...PACK_TARGET_KINDS].sort());
    expect(PACK_FIT_POLICIES_BY_TARGET).toEqual({
      docx_table: ["none", "grow", "truncate", "fail"],
      pptx_table: ["none", "grow", "truncate", "fail"],
      docx_bookmark: ["none", "truncate", "fail"],
      pptx_chart_series: ["none", "fail"],
      pptx_fit_headline: ["none", "shrink_to_fit", "truncate", "fail"],
    });
    const index = (kind: string) => PACK.bindings.findIndex((b) => b.target_kind === kind);
    for (const kind of PACK_TARGET_KINDS)
      for (const fit_policy of PACK_FIT_POLICIES) {
        const allowed = PACK_FIT_POLICIES_BY_TARGET[kind].includes(fit_policy);
        const problems = validatePackManifest(bindingWith(index(kind), { fit_policy }));
        if (allowed) expect(problems).toEqual([]);
        else refused(problems, `$.bindings[${index(kind)}].fit_policy: ${fit_policy} does not apply to ${kind}`);
      }
  });

  test("a bookmark and a headline take one value, a table and a chart series a block", () => {
    refused(validatePackManifest(bindingWith(1, { selector: { type: "range", sheet: "S", ref: "A1:B2" } })), "docx_bookmark takes one value, not a range");
    refused(validatePackManifest(bindingWith(1, { selector: { type: "table", name: "T" } })), "docx_bookmark takes one value, not a table");
    refused(validatePackManifest(bindingWith(4, { selector: { type: "range", sheet: "S", ref: "A1:B2" } })), "pptx_fit_headline takes one value, not a range");
    refused(validatePackManifest(bindingWith(0, { selector: { type: "cell", sheet: "S", ref: "A1" } })), "docx_table takes a block of values, not one cell");
    refused(validatePackManifest(bindingWith(3, { selector: { type: "cell", sheet: "S", ref: "A1" } })), "pptx_chart_series takes a block of values, not one cell");
    expect(validatePackManifest(bindingWith(1, { selector: { type: "cell", sheet: "S", ref: "C3" } }))).toEqual([]);
    expect(validatePackManifest(bindingWith(3, { selector: { type: "table", name: "Series" } }))).toEqual([]);
  });

  test("two bindings never write the same target", () => {
    const twice = edit(PACK, (p) => p.bindings.push({ ...p.bindings[1], id: "net_income_again" }));
    refused(validatePackManifest(twice), "is bound twice");
    const otherDoc = edit(PACK, (p) => p.bindings.push({ ...p.bindings[1], id: "net_income_other", target_doc: "other.docx" }));
    expect(validatePackManifest(otherDoc)).toEqual([]);
  });
});

describe("pack: determinism", () => {
  test("a CSV or SQL snapshot names its sha256; an XLSX source, which is the document, does not", () => {
    refused(validatePackManifest(edit(PACK, (p) => delete p.sources[1].determinism.snapshot_sha256)), "csv_snapshot names the sha256 of its snapshot");
    refused(validatePackManifest(edit(PACK, (p) => delete p.sources[2].determinism.snapshot_sha256)), "sql_snapshot names the sha256 of its snapshot");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].determinism.snapshot_sha256 = H("c")))), "an xlsx source is the document itself");
  });

  test("a source clock is a real instant and an xlsx source is an .xlsx document", () => {
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].determinism.clock = "2026-13-40T00:00:00Z"))), "not a calendar instant");
    refused(validatePackManifest(edit(PACK, (p) => (p.sources[0].doc_name = "model.csv"))), "an xlsx source is an .xlsx document");
    expect(validatePackManifest(edit(PACK, (p) => (p.sources[0].doc_name = "Model.XLSX")))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schemas and sources
// ---------------------------------------------------------------------------

const PACKAGE = join(import.meta.dir, "..");
const REPO = join(PACKAGE, "../../../..");
const SCHEMA_FILES = ["reactor-pipe.v1.schema.json", "room.v1.schema.json", "mcp-workspace.v1.schema.json", "pack.v1.schema.json", "assistant.v1.schema.json"];
const readSchema = (file: string): Json => JSON.parse(readFileSync(join(PACKAGE, "schemas", file), "utf8")) as Json;

/** Keywords the evaluator behind `validateSchema` reads, annotations, and the ones a validator here enforces by hand. */
const EVALUATED = ["type", "const", "enum", "pattern", "minLength", "minimum", "required", "properties", "additionalProperties", "items", "anyOf", "$ref"];
const ANNOTATIONS = ["$schema", "$id", "$defs", "title", "description", "default"];
const HAND_CHECKED: Record<string, string[]> = {
  "reactor-pipe.v1.schema.json": ["maximum", "exclusiveMinimum"],
  "mcp-workspace.v1.schema.json": ["minItems"],
  "assistant.v1.schema.json": ["maxLength"],
};

function keywordProblems(node: unknown, path: string, allowed: Set<string>, out: string[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const schema = node as Json;
  for (const key of Object.keys(schema)) if (!allowed.has(key) && !key.startsWith("x-")) out.push(`${path}: keyword ${key} is read by no validator`);
  for (const [name, sub] of Object.entries((schema.$defs ?? {}) as Json)) keywordProblems(sub, `${path}.$defs.${name}`, allowed, out);
  for (const [name, sub] of Object.entries((schema.properties ?? {}) as Json)) keywordProblems(sub, `${path}.${name}`, allowed, out);
  if (schema.items) keywordProblems(schema.items, `${path}[]`, allowed, out);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((sub: unknown, i: number) => keywordProblems(sub, `${path}.anyOf[${i}]`, allowed, out));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") keywordProblems(schema.additionalProperties, `${path}.+`, allowed, out);
}

function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, found));
  else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") found.push(v);
      else refs(v, found);
    }
  }
  return found;
}

describe("schemas", () => {
  test("each schema is a draft 2020-12 document with its https://wolfsdk.com/schemas/ $id", () => {
    const ids: Record<string, string> = {};
    for (const file of SCHEMA_FILES) {
      const schema = readSchema(file);
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toBe(`https://wolfsdk.com/schemas/${file}`);
      expect(typeof schema.title).toBe("string");
      expect(typeof schema.description).toBe("string");
      ids[file] = schema.$id;
    }
    expect(new Set(Object.values(ids)).size).toBe(5);
    expect(workspace.REACTOR_PIPE_SCHEMA.$id).toBe(ids["reactor-pipe.v1.schema.json"]);
    expect(workspace.ROOM_SCHEMA.$id).toBe(ids["room.v1.schema.json"]);
    expect(workspace.MCP_WORKSPACE_SCHEMA.$id).toBe(ids["mcp-workspace.v1.schema.json"]);
    expect(workspace.PACK_SCHEMA.$id).toBe(ids["pack.v1.schema.json"]);
    expect(workspace.ASSISTANT_SCHEMA.$id).toBe(ids["assistant.v1.schema.json"]);
  });

  test("the contract of each schema is the constant the module exports", () => {
    expect(JSON.stringify(readSchema("reactor-pipe.v1.schema.json"))).toContain(`"const":"${REACTOR_PIPE_CONTRACT}"`);
    expect((readSchema("room.v1.schema.json").$defs.roomState.properties.contract as Json).const).toBe(ROOM_CONTRACT);
    expect((readSchema("pack.v1.schema.json").properties.contract as Json).const).toBe(PACK_CONTRACT);
    expect(readSchema("mcp-workspace.v1.schema.json").description).toContain(MCP_WORKSPACE_CONTRACT);
    for (const def of ["turn", "usageSummary"]) expect((readSchema("assistant.v1.schema.json").$defs[def].properties.contract as Json).const).toBe(workspace.ASSISTANT_CONTRACT);
  });

  test("every keyword is one a validator reads, and every $ref resolves inside its own file", () => {
    for (const file of SCHEMA_FILES) {
      const schema = readSchema(file);
      const allowed = new Set([...EVALUATED, ...ANNOTATIONS, ...(HAND_CHECKED[file] ?? [])]);
      const problems: string[] = [];
      keywordProblems(schema, "$", allowed, problems);
      for (const tool of (schema["x-wolfsdk-tools"] ?? []) as Json[]) keywordProblems(tool.inputSchema, `$.${tool.name}`, allowed, problems);
      expect(problems).toEqual([]);
      for (const ref of refs(schema)) {
        expect(ref.startsWith("#/$defs/")).toBe(true);
        expect(Object.keys(schema.$defs)).toContain(ref.slice("#/$defs/".length));
      }
    }
  });

  test("the keywords the evaluator ignores are enforced by hand, where a schema relies on them", () => {
    const pipe = JSON.stringify(readSchema("reactor-pipe.v1.schema.json"));
    expect(pipe).toContain('"maximum"');
    for (const file of ["room.v1.schema.json", "pack.v1.schema.json"]) expect(JSON.stringify(readSchema(file))).not.toMatch(/"(maximum|minItems|maxItems|exclusiveMinimum|uniqueItems|oneOf|allOf|if|not)"/);
    expect(JSON.stringify(readSchema("mcp-workspace.v1.schema.json"))).not.toMatch(/"(maximum|maxItems|exclusiveMinimum|uniqueItems|oneOf|allOf|if|not)"/);
    const assistant = JSON.stringify(readSchema("assistant.v1.schema.json"));
    expect(assistant).toContain(`"maxLength":${workspace.ASSISTANT_REQUEST_MAX_CHARS}`);
    expect(assistant).not.toMatch(/"(maximum|minItems|maxItems|exclusiveMinimum|uniqueItems|oneOf|allOf|if|not)"/);
  });

  test("the exports of the workspace barrel are the five contracts, reachable from the package index", () => {
    for (const name of ["validateReactorPipeEnvelope", "validateRoomSnapshot", "validateMcpToolCall", "validatePackManifest", "validateAssistantTurn", "mcpToolsTokenEstimate", "MCP_WORKSPACE_TOOLS"])
      expect(typeof (workspace as Json)[name]).not.toBe("undefined");
    for (const name of Object.keys(workspace)) expect((index as Json)[name]).toBe((workspace as Json)[name]);
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Json;
    expect(manifest.exports["./workspace"]).toBe("./src/workspace/index.ts");
    for (const kept of [".", "./contract", "./reactor", "./session", "./schemas/*"]) expect(manifest.exports[kept]).toBeDefined();
  });
});

describe("forbidden strings", () => {
  const workspaceDir = join(PACKAGE, "src/workspace");
  const sources = readdirSync(workspaceDir).map((f) => join(workspaceDir, f));
  const schemas = SCHEMA_FILES.map((f) => join(PACKAGE, "schemas", f));
  const external = [
    join(REPO, "packaging/public-install/LICENSE-WOLF-COMMUNITY-SELFHOST.txt"),
    join(REPO, "docs/reactor/reactor-pipe-v1.md"),
    join(REPO, "docs/wolf-workspace-architecture.md"),
  ].filter((f) => existsSync(f));

  const FORBIDDEN: [RegExp, string][] = [
    [/wolf[\s_-]?editor/i, "old package or element name"],
    [/\/(Users|home)\/[A-Za-z0-9_.-]+\//, "absolute machine path"],
    [/[\u2013\u2014]/, "en or em dash"],
  ];

  test("the contract sources and schemas hold none of them", () => {
    expect(sources.length).toBe(6);
    for (const file of [...sources, ...schemas]) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, what] of FORBIDDEN) expect(pattern.test(text) ? `${what} in ${file}` : "").toBe("");
    }
  });

  test("the licence and the two specs hold none of them when they are in the tree", () => {
    for (const file of external) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, what] of FORBIDDEN) expect(pattern.test(text) ? `${what} in ${file}` : "").toBe("");
    }
  });

  test("the workspace sources import nothing outside the package: no workspace specifier, no DOM, no framework", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) expect(m[1]?.startsWith(".")).toBe(true);
      expect(text).not.toMatch(/@wolfsdk\//);
      expect(text).not.toMatch(/\bfrom\s*["'](preact|react|lit)/);
      expect(text).not.toMatch(/\b(window|navigator|localStorage)\b/);
      // `$.document.head.revision` in a problem message is a JSON path, not a read of the DOM.
      expect(text).not.toMatch(/(?<!\$\.)\bdocument\.(create|query|get|body|head)/);
    }
  });

  test("the community self-host licence grants one workspace and five signed-in users and reserves the rest", () => {
    const file = join(REPO, "packaging/public-install/LICENSE-WOLF-COMMUNITY-SELFHOST.txt");
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    for (const part of ["SynthGL, Inc.", "Version: 2026-11-13", "one (1) workspace", "five (5)", "WOLF_LICENSE_KEY", "Ed25519", "SSO", "OIDC", "wolf_web", "Commercial Order Terms", "trial@wolfxl.com"])
      expect(text).toContain(part);
  });
});
