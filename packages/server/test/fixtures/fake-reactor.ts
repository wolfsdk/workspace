// A stand-in for `wolf reactor-serve`, for the tests of the room server: a small executable that speaks
// `wolfsdk.reactor-pipe.v1` over standard input and output. It is NOT an engine. Its "documents" are UTF-8
// text, its "ops" are the handful below, and its hashes are the SHA-256 of what it holds, so the server's
// checks (the hashes a worker reports must be the hashes of the bytes it returns) are real checks.
//
// It reads and writes frames with its own codec on purpose, not the one in `src/pipe.ts`, so a mistake
// in the server's framing is not mirrored here. Its own responses go through the protocol's validators
// before they are written, except where an op asks for a deliberately broken answer.
//
// Run: `bun fake-reactor.ts`. Environment:
//   FAKE_TIER            community (default) | commercial | oem
//   FAKE_KEYED           1: report a key id and an expiry (a keyed licence)
//   FAKE_MAX_WORKSPACES  number or "null" (unlimited); default 1
//   FAKE_MAX_SEATS       number or "null"; default 5
//
// Ops (`ops` of `apply` is an array of these objects):
//   {op:"append", text}   {op:"set_text", text}   {op:"fail", message}  fail the batch: ok:false, nothing committed
//   {op:"replace", find, text}  replace the first `find` with `text`; fails the batch when `find` is absent
//   {op:"crash"}          exit before answering   {op:"hang"}           never answer
//   {op:"garbage"}        write bytes that are no frame
//   {op:"truncate"}       write half a frame, then exit
//   {op:"wrong_req_id"}   answer with another req_id
//   {op:"lie_sha"}        report a sha256 the saved bytes do not have
//   {op:"refuse_nocmd"}   answer with a refusal that has no `cmd`
//   {op:"invalid_response"} answer with a body that fails the response validator
//   {op:"refuse_while_exists", path, code}  refuse the batch with the refusal `code` (`reactor-document-limit`,
//                         `internal-error`, ...) while a file exists at `path`: a refusal about the engine that is there for
//                         a while and then is not, not about the batch
//   {op:"stamp"}          append `clock|timezone|locale|seed` of the apply request to the text: the determinism a batch was
//                         applied under becomes visible in the bytes (`-` for a member the request did not carry)
//   {op:"append_file", path}  append the content of the file at `path`: an op whose result depends on something outside the
//                         document, so that replaying it later can give other bytes (an engine that is not deterministic)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type ReactorPipeRequest, validateReactorPipeRequest, validateReactorPipeResponse } from "@wolfsdk/protocol/workspace";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ZERO_SHA = "0".repeat(64);

// Frames ---------------------------------------------------------------------------------------------------

const stdin = Bun.stdin.stream().getReader();
let pending = new Uint8Array(0);

/** Exactly `n` bytes of input, or `null` when the input ended first. */
async function take(n: number): Promise<Uint8Array | null> {
  while (pending.length < n) {
    const { done, value } = await stdin.read();
    if (done) return null;
    const joined = new Uint8Array(pending.length + value.length);
    joined.set(pending);
    joined.set(value, pending.length);
    pending = joined;
  }
  const out = pending.slice(0, n);
  pending = pending.slice(n);
  return out;
}

type InFrame = { reqId: number; body: unknown; segments: Uint8Array[] };

async function readFrame(): Promise<InFrame | null> {
  const head = await take(12);
  if (head === null) return null;
  const view = new DataView(head.buffer, head.byteOffset, 12);
  const reqId = view.getUint32(0, true);
  const jsonBytes = view.getUint32(4, true);
  const binCount = view.getUint32(8, true);
  const json = await take(jsonBytes);
  if (json === null) return null;
  const segments: Uint8Array[] = [];
  for (let i = 0; i < binCount; i++) {
    const lengthBytes = await take(4);
    if (lengthBytes === null) return null;
    const data = await take(new DataView(lengthBytes.buffer).getUint32(0, true));
    if (data === null) return null;
    segments.push(data);
  }
  let body: unknown;
  try {
    body = JSON.parse(decoder.decode(json));
  } catch {
    body = undefined;
  }
  return { reqId, body, segments };
}

function frameBytes(reqId: number, body: unknown, segments: readonly Uint8Array[] = []): Uint8Array {
  const json = encoder.encode(JSON.stringify(body));
  let size = 12 + json.length;
  for (const s of segments) size += 4 + s.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, reqId, true);
  view.setUint32(4, json.length, true);
  view.setUint32(8, segments.length, true);
  out.set(json, 12);
  let at = 12 + json.length;
  for (const s of segments) {
    view.setUint32(at, s.length, true);
    out.set(s, at + 4);
    at += 4 + s.length;
  }
  return out;
}

const write = (bytes: Uint8Array): Promise<number> => Bun.write(Bun.stdout, bytes);

/** Write a response after checking it against the contract. */
async function respond(reqId: number, body: Record<string, unknown>, segments: readonly Uint8Array[] = []): Promise<void> {
  const problems = validateReactorPipeResponse(body);
  if (problems.length > 0) {
    console.error(`fake-reactor built an invalid response: ${problems.join("; ")} ${JSON.stringify(body)}`);
    process.exit(70);
  }
  await write(frameBytes(reqId, body, segments));
}

const refuse = (cmd: string | undefined, code: string, message: string, argument?: string): Record<string, unknown> => ({
  ...(cmd === undefined ? {} : { cmd }),
  ok: false,
  ms: 0.01,
  error: { code, message, ...(argument === undefined ? {} : { argument }) },
});

// Documents ------------------------------------------------------------------------------------------------

type Doc = { format: string; text: string; revision: number; pages: string[] };

const docs = new Map<number, Doc>();
let nextDoc = 1;

const pagesOf = (text: string): string[] => text.split("\f").map((page) => sha256(encoder.encode(page)));

const DETERMINISM = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 };
/** A document whose text starts with this is edited but never laid out, like a deck with no slide layout. */
const NO_LAYOUT = "~nolayout";

type Op = { op: string; text?: string; find?: string; message?: string; path?: string; code?: string };

const limit = (name: string, fallback: number): number | null => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "null" ? null : Number(raw);
};

function entitlement(): Record<string, unknown> {
  const keyed = process.env.FAKE_KEYED === "1";
  return {
    cmd: "entitlement",
    ok: true,
    ms: 0.01,
    tier: process.env.FAKE_TIER ?? "community",
    max_workspaces: limit("FAKE_MAX_WORKSPACES", 1),
    max_seats: limit("FAKE_MAX_SEATS", 5),
    sso: false,
    oem_offline_wasm: false,
    key_id: keyed ? "test-key-1" : null,
    expires_at: keyed ? "2099-01-01T00:00:00Z" : null,
  };
}

async function handle(frame: InFrame): Promise<void> {
  const { reqId, body, segments } = frame;
  const cmd = typeof body === "object" && body !== null && "cmd" in body ? body.cmd : undefined;
  const problems = validateReactorPipeRequest(body);
  if (problems.length > 0) {
    // A body that names a command of the contract but is invalid for it is refused by that command. Anything
    // else (not JSON, no cmd, an unknown cmd) is refused without a `cmd`.
    const known = typeof cmd === "string" && !problems[0]!.includes("is not a reactor pipe command");
    return respond(reqId, refuse(known ? cmd : undefined, "bad-request", problems[0]!));
  }
  // `validateReactorPipeRequest` found no problem: the body has the shape of the contract.
  const request = body as ReactorPipeRequest;
  switch (request.cmd) {
    case "entitlement":
      return respond(reqId, entitlement());
    case "open": {
      const bytes = segments[request.bytes.bin];
      if (!bytes || bytes.length !== request.bytes.len) return respond(reqId, refuse("open", "bad-request", "bytes segment missing", "bytes"));
      const text = decoder.decode(bytes);
      if (text.startsWith("!!bad")) return respond(reqId, refuse("open", "invalid-input", "not a document", "bytes"));
      const format = request.format ?? "docx";
      const doc = nextDoc++;
      docs.set(doc, { format, text, revision: 0, pages: pagesOf(text) });
      return respond(reqId, {
        cmd: "open",
        ok: true,
        ms: 0.01,
        doc,
        format,
        sha256: sha256(bytes),
        bytes: bytes.length,
        revision: 0,
        determinism: DETERMINISM,
      });
    }
    case "close": {
      const doc = request.doc;
      if (!docs.delete(doc)) return respond(reqId, refuse("close", "unknown-doc", `no document ${doc}`, "doc"));
      return respond(reqId, { cmd: "close", ok: true, ms: 0.01, doc });
    }
    case "save": {
      const doc = request.doc;
      const held = docs.get(doc);
      if (!held) return respond(reqId, refuse("save", "unknown-doc", `no document ${doc}`, "doc"));
      const bytes = encoder.encode(held.text);
      return respond(reqId, { cmd: "save", ok: true, ms: 0.01, doc, revision: held.revision, sha256: sha256(bytes), bytes: { bin: 0, len: bytes.length } }, [bytes]);
    }
    case "layout": {
      const doc = request.doc;
      const held = docs.get(doc);
      if (!held) return respond(reqId, refuse("layout", "unknown-doc", `no document ${doc}`, "doc"));
      if (held.text.startsWith(NO_LAYOUT)) return respond(reqId, refuse("layout", "unsupported", "this document has no layout", "doc"));
      return respond(reqId, {
        cmd: "layout",
        ok: true,
        ms: 0.01,
        cached: false,
        layout_ms: 0.01,
        summary: { format: held.format, pages: held.pages.length, determinism: DETERMINISM },
        page_hashes: held.pages,
      });
    }
    case "apply":
      return apply(reqId, request);
    default:
      return respond(reqId, refuse(request.cmd, "unsupported", `fake-reactor does not implement ${request.cmd}`));
  }
}

async function apply(reqId: number, request: Extract<ReactorPipeRequest, { cmd: "apply" }>): Promise<void> {
  const doc = request.doc;
  const held = docs.get(doc);
  if (!held) return respond(reqId, refuse("apply", "unknown-doc", `no document ${doc}`, "doc"));
  if (held.format === "pdf") return respond(reqId, refuse("apply", "unsupported", "a PDF is not edited", "doc"));
  const ops: Op[] = Array.isArray(request.ops) ? request.ops : [];
  const baseSha = sha256(encoder.encode(held.text));
  /** The batch fails: nothing is committed and the typed errors go in the receipt. */
  const failed = (message: string): Promise<void> =>
    respond(reqId, {
      cmd: "apply",
      ok: false,
      ms: 0.01,
      committed: false,
      revision: held.revision,
      base_sha256: baseSha,
      sha256: baseSha,
      receipt: { errors: [{ code: "op-failed", message }] },
    });
  let text = held.text;
  let lie = false;
  for (const op of ops) {
    switch (op.op) {
      case "append":
        text += op.text ?? "";
        break;
      case "set_text":
        text = op.text ?? "";
        break;
      case "fail":
        return failed(op.message ?? "the op failed");
      case "replace": {
        const at = text.indexOf(op.find ?? "");
        if (at < 0) return failed(`${JSON.stringify(op.find)} is not in the document`);
        text = text.slice(0, at) + (op.text ?? "") + text.slice(at + (op.find ?? "").length);
        break;
      }
      case "crash":
        process.exit(3);
        break;
      case "hang":
        // A live timer keeps the process alive: it is hung, not exited.
        setInterval(() => {}, 60_000);
        await Promise.withResolvers<never>().promise;
        break;
      case "garbage":
        await write(new Uint8Array(12).fill(0xff));
        return;
      case "truncate": {
        const whole = frameBytes(reqId, { cmd: "apply", ok: true, ms: 0.01, committed: true, revision: 1, sha256: ZERO_SHA, receipt: {} });
        await write(whole.slice(0, whole.length - 5));
        process.exit(0);
        break;
      }
      case "wrong_req_id":
        return respond(reqId + 1, entitlement());
      case "lie_sha":
        lie = true;
        break;
      case "refuse_nocmd":
        return respond(reqId, refuse(undefined, "bad-request", "no cmd, on purpose"));
      case "invalid_response":
        await write(frameBytes(reqId, { cmd: "apply", ok: true, ms: 0.01 }));
        return;
      case "append_file":
        text += readFileSync(op.path ?? "", "utf8");
        break;
      case "refuse_while_exists":
        if (existsSync(op.path ?? "")) return respond(reqId, refuse("apply", op.code ?? "internal-error", "refused on purpose", "ops"));
        break;
      case "stamp":
        text += [request.clock, request.timezone, request.locale, request.seed].map((member) => member ?? "-").join("|");
        break;
      default:
        return respond(reqId, refuse("apply", "invalid-input", `unknown op ${JSON.stringify(op.op)}`, "ops"));
    }
  }
  const next = encoder.encode(text);
  const before = held.pages;
  held.text = text;
  held.revision += 1;
  held.pages = pagesOf(text);
  // A document the engine edits but cannot lay out. Like wolf 0.2.25, the fake has changed the document by the
  // time it refuses the relayout, so the handle is no longer at the base the caller thinks it is.
  if (request.relayout === true && text.startsWith(NO_LAYOUT)) return respond(reqId, refuse("apply", "unsupported", "this document has no layout", "doc"));
  const response: Record<string, unknown> = {
    cmd: "apply",
    ok: true,
    ms: 0.01,
    committed: true,
    revision: held.revision,
    base_sha256: baseSha,
    sha256: lie ? ZERO_SHA : sha256(next),
    receipt: { ops: ops.length },
  };
  if (request.relayout === true) {
    const changed: number[] = [];
    for (let i = 0; i < held.pages.length; i++) if (before[i] !== held.pages[i]) changed.push(i + 1);
    const removed: number[] = [];
    for (let i = held.pages.length; i < before.length; i++) removed.push(i + 1);
    response.pages = { compared: true, count: held.pages.length, changed, removed, hashes: held.pages };
  }
  return respond(reqId, response);
}

for (;;) {
  const frame = await readFrame();
  if (frame === null) process.exit(0);
  await handle(frame);
}
