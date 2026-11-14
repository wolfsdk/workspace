// The wire of `wolfsdk.reactor-pipe.v1`: frames (a 12-byte header, a JSON body, binary segments) over a byte
// stream, and one connection that sends a request and reads its response. Every request is validated before
// it is written and every response before it is returned, with the validators of `@wolfsdk/protocol`.
import {
  REACTOR_PIPE_CONTRACT,
  REACTOR_PIPE_HEADER_BYTES,
  decodeReactorPipeHeader,
  encodeReactorPipeHeader,
  validateReactorPipeEnvelope,
  type ReactorPipeHeader,
  type ReactorPipeRequest,
  type ReactorPipeResponse,
} from "@wolfsdk/protocol/workspace";
import { EngineFault } from "./errors.ts";

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** Largest binary segment the host accepts from a worker: a bound on what a corrupt length can make it wait for. */
export const DEFAULT_MAX_SEGMENT_BYTES = 512 * 1024 * 1024;

export type Frame = { header: ReactorPipeHeader; body: unknown; segments: Uint8Array[] };

/** One frame as bytes: header, compact JSON body, then each segment behind its u32LE length. */
export function encodeFrame(req_id: number, body: object, segments: readonly Uint8Array[] = []): Uint8Array {
  const json = utf8.encode(JSON.stringify(body));
  const header = encodeReactorPipeHeader({ req_id, json_bytes: json.length, bin_count: segments.length });
  let size = header.length + json.length;
  for (const s of segments) size += 4 + s.length;
  const out = new Uint8Array(size);
  out.set(header, 0);
  out.set(json, header.length);
  let at = header.length + json.length;
  const view = new DataView(out.buffer);
  for (const s of segments) {
    view.setUint32(at, s.length, true);
    out.set(s, at + 4);
    at += 4 + s.length;
  }
  return out;
}

/** Bytes read from a stream and not yet consumed. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Remove and return the first `n` bytes. The caller guarantees `length >= n`. */
  take(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const first = this.chunks[0]!;
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.length -= n;
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.chunks[0]!;
      const want = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, want), at);
      at += want;
      if (want === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(want);
    }
    this.length -= n;
    return out;
  }
}

/** Decodes frames from a byte stream. */
export class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly queue = new ByteQueue();
  private readonly maxSegmentBytes: number;
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>, maxSegmentBytes: number = DEFAULT_MAX_SEGMENT_BYTES) {
    this.reader = stream.getReader();
    this.maxSegmentBytes = maxSegmentBytes;
  }

  /** Buffer at least `n` bytes. `false` when the stream ended first (the bytes that did arrive stay queued). */
  private async fill(n: number): Promise<boolean> {
    while (this.queue.length < n) {
      if (this.ended) return false;
      const { done, value } = await this.reader.read();
      if (done) {
        this.ended = true;
        return false;
      }
      this.queue.push(value);
    }
    return true;
  }

  /** The next frame, `null` when the stream ended cleanly between frames. A stream that ends inside a frame,
   * a header the contract refuses, a body that is not UTF-8 JSON, or a segment past the limit is an `EngineFault`. */
  async read(): Promise<Frame | null> {
    if (!(await this.fill(REACTOR_PIPE_HEADER_BYTES))) {
      if (this.queue.length === 0) return null;
      throw new EngineFault(`worker stream ended inside a frame header (${this.queue.length} of ${REACTOR_PIPE_HEADER_BYTES} bytes)`);
    }
    let header: ReactorPipeHeader;
    try {
      header = decodeReactorPipeHeader(this.queue.take(REACTOR_PIPE_HEADER_BYTES));
    } catch (e) {
      throw new EngineFault(`malformed frame header: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!(await this.fill(header.json_bytes))) throw new EngineFault("worker stream ended inside a frame body");
    const raw = this.queue.take(header.json_bytes);
    let body: unknown;
    try {
      body = JSON.parse(utf8Strict.decode(raw));
    } catch {
      throw new EngineFault("malformed frame body: not UTF-8 JSON");
    }
    const segments: Uint8Array[] = [];
    for (let i = 0; i < header.bin_count; i++) {
      if (!(await this.fill(4))) throw new EngineFault(`worker stream ended before binary segment ${i}`);
      const lenBytes = this.queue.take(4);
      const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, true);
      if (len > this.maxSegmentBytes) throw new EngineFault(`binary segment ${i} announces ${len} bytes, over the limit of ${this.maxSegmentBytes}`);
      if (!(await this.fill(len))) throw new EngineFault(`worker stream ended inside binary segment ${i}`);
      segments.push(this.queue.take(len));
    }
    return { header, body, segments };
  }

  cancel(): void {
    this.ended = true;
    this.reader.cancel().catch(() => {});
  }
}

/** What a connection sits on: a way to write bytes to the worker, the worker's output, and a way to end it. */
export type PipeTransport = {
  write(bytes: Uint8Array): Promise<void>;
  output: ReadableStream<Uint8Array>;
  /** Terminate the worker. Called once, when the connection breaks. */
  destroy(): void;
  /** Free text the worker wrote to standard error, for the message of a fault. */
  diagnostics(): string;
};

export type PipeResult = { body: ReactorPipeResponse; segments: Uint8Array[] };

/** One worker's request/response channel. One call at a time; a connection that failed is broken for good. */
export class PipeConnection {
  private readonly transport: PipeTransport;
  private readonly reader: FrameReader;
  private readonly timeoutMs: number;
  private nextId = 1;
  private busy = false;
  private breakReason: string | null = null;

  constructor(transport: PipeTransport, options: { timeoutMs: number; maxSegmentBytes?: number }) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs;
    this.reader = new FrameReader(transport.output, options.maxSegmentBytes);
  }

  get broken(): boolean {
    return this.breakReason !== null;
  }

  /** End the connection and the worker behind it. */
  break(reason: string): EngineFault {
    if (this.breakReason === null) {
      this.breakReason = reason;
      this.reader.cancel();
      this.transport.destroy();
    }
    const detail = this.transport.diagnostics();
    return new EngineFault(detail ? `${reason} (worker stderr: ${detail})` : reason);
  }

  /** Send `request` (with `segments`) and return the validated response. A refusal is returned as a body with
   * `error`, not thrown. Throws `EngineFault` and breaks the connection on a crash, a timeout, a malformed or
   * invalid frame, or a response that answers another request. Throws `RangeError` without writing when the
   * request itself is not valid. */
  async call(request: ReactorPipeRequest, segments: readonly Uint8Array[] = []): Promise<PipeResult> {
    if (this.breakReason !== null) throw new EngineFault(`worker connection is closed: ${this.breakReason}`);
    if (this.busy) throw new Error("a pipe connection serves one call at a time");
    const req_id = this.nextId;
    this.nextId = this.nextId >= 0xffff_ffff ? 1 : this.nextId + 1;
    const frame = encodeFrame(req_id, request, segments);
    const header = decodeReactorPipeHeader(frame);
    const problems = validateReactorPipeEnvelope(
      { contract: REACTOR_PIPE_CONTRACT, kind: "request", header, body: request },
      segments.map((s) => s.length),
    );
    if (problems.length) throw new RangeError(`invalid reactor pipe request: ${problems.join("; ")}`);

    this.busy = true;
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(this.break(`worker did not answer ${request.cmd} within ${this.timeoutMs} ms`)),
      this.timeoutMs,
    );
    try {
      const exchange = (async (): Promise<PipeResult> => {
        try {
          await this.transport.write(frame);
        } catch (e) {
          throw this.break(`cannot write to the worker: ${e instanceof Error ? e.message : String(e)}`);
        }
        let received: Frame | null;
        try {
          received = await this.reader.read();
        } catch (e) {
          if (e instanceof EngineFault) throw this.break(e.message);
          throw this.break(`cannot read from the worker: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (received === null) throw this.break("worker exited before it answered");
        return this.accept(request, req_id, received);
      })();
      return await Promise.race([exchange, deadline.promise]);
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }

  private accept(request: ReactorPipeRequest, req_id: number, frame: Frame): PipeResult {
    const problems = validateReactorPipeEnvelope(
      { contract: REACTOR_PIPE_CONTRACT, kind: "response", header: frame.header, body: frame.body },
      frame.segments.map((s) => s.length),
    );
    if (problems.length) throw this.break(`invalid response to ${request.cmd}: ${problems.slice(0, 3).join("; ")}`);
    if (frame.header.req_id !== req_id) throw this.break(`response carries req_id ${frame.header.req_id}, expected ${req_id}`);
    const body = frame.body as ReactorPipeResponse;
    if (body.cmd !== undefined && body.cmd !== request.cmd) throw this.break(`response answers ${body.cmd}, expected ${request.cmd}`);
    return { body, segments: frame.segments };
  }
}
