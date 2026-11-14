import { describe, expect, test } from "bun:test";
import { REACTOR_PIPE_HEADER_BYTES, decodeReactorPipeHeader, type ReactorPipeResponse } from "@wolfsdk/protocol/workspace";
import { EngineFault } from "../src/errors.ts";
import { FrameReader, PipeConnection, encodeFrame, type PipeTransport } from "../src/pipe.ts";
import { failureOf } from "./fixtures/harness.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** A stream that delivers `chunks`, then ends (or stays open when `open`). */
function streamOf(chunks: Uint8Array[], open = false): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!open) controller.close();
    },
  });
}

/** The bytes of `whole` cut into pieces of `size`. */
function slices(whole: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < whole.length; at += size) out.push(whole.slice(at, at + size));
  return out;
}

describe("frame codec", () => {
  test("a frame is a 12-byte header, the JSON body, then each segment behind its length", () => {
    const frame = encodeFrame(7, { cmd: "close", doc: 1 }, [bytes(1, 2, 3), bytes()]);
    const header = decodeReactorPipeHeader(frame);
    const json = new TextEncoder().encode(JSON.stringify({ cmd: "close", doc: 1 }));
    expect(header).toEqual({ req_id: 7, json_bytes: json.length, bin_count: 2 });
    expect(frame.length).toBe(REACTOR_PIPE_HEADER_BYTES + json.length + (4 + 3) + (4 + 0));
    const at = REACTOR_PIPE_HEADER_BYTES + json.length;
    expect([...frame.slice(at, at + 7)]).toEqual([3, 0, 0, 0, 1, 2, 3]);
    expect([...frame.slice(at + 7)]).toEqual([0, 0, 0, 0]);
  });

  test("a reader gives back what the encoder wrote, however the stream is chopped", async () => {
    const body = { cmd: "open", ok: true, note: "héllo ✓" };
    const segments = [bytes(9, 8, 7, 6), bytes(), bytes(5)];
    const whole = new Uint8Array([...encodeFrame(41, body, segments), ...encodeFrame(42, { second: true })]);
    for (const size of [1, 2, 5, 13, whole.length]) {
      const reader = new FrameReader(streamOf(slices(whole, size)));
      const first = await reader.read();
      expect(first?.header.req_id).toBe(41);
      expect(first?.body).toEqual(body);
      expect(first?.segments.map((s) => [...s])).toEqual(segments.map((s) => [...s]));
      const second = await reader.read();
      expect(second?.header.req_id).toBe(42);
      expect(second?.body).toEqual({ second: true });
      expect(second?.segments).toEqual([]);
      expect(await reader.read()).toBeNull();
    }
  });
});

describe("FrameReader faults", () => {
  const whole = encodeFrame(1, { ok: true }, [bytes(1, 2, 3, 4)]);

  test("a stream that ends between frames is a clean end, not a fault", async () => {
    expect(await new FrameReader(streamOf([])).read()).toBeNull();
  });

  test("a stream that ends inside a frame is a fault, wherever it ends", async () => {
    const headerEnd = REACTOR_PIPE_HEADER_BYTES;
    const bodyEnd = headerEnd + JSON.stringify({ ok: true }).length;
    const cuts: [number, RegExp][] = [
      [5, /inside a frame header/],
      [headerEnd + 2, /inside a frame body/],
      [bodyEnd + 2, /before binary segment 0|inside binary segment 0/],
      [bodyEnd + 4 + 2, /inside binary segment 0/],
    ];
    for (const [cut, message] of cuts) {
      await expect(new FrameReader(streamOf([whole.slice(0, cut)])).read()).rejects.toThrow(message);
    }
  });

  test("a header the contract refuses is a fault", async () => {
    const reader = new FrameReader(streamOf([new Uint8Array(REACTOR_PIPE_HEADER_BYTES).fill(0xff)]));
    const fault = await failureOf(reader.read(), EngineFault);
    expect(fault.message).toMatch(/malformed frame header/);
  });

  test("a body that is not UTF-8 JSON is a fault", async () => {
    for (const body of [bytes(0xff, 0xfe, 0xfd), new TextEncoder().encode("{not json")]) {
      const frame = new Uint8Array(REACTOR_PIPE_HEADER_BYTES + body.length);
      new DataView(frame.buffer).setUint32(0, 1, true);
      new DataView(frame.buffer).setUint32(4, body.length, true);
      frame.set(body, REACTOR_PIPE_HEADER_BYTES);
      await expect(new FrameReader(streamOf([frame])).read()).rejects.toThrow(/malformed frame body/);
    }
  });

  test("a segment that announces more than the limit is refused before the host waits for it", async () => {
    const frame = encodeFrame(1, { ok: true }, [new Uint8Array(100)]);
    await expect(new FrameReader(streamOf([frame], true), 50).read()).rejects.toThrow(/over the limit of 50/);
  });
});

/** An in-memory worker: `answer` turns the frame it was written into the bytes it replies with. */
function scripted(
  answer: (written: Uint8Array) => Uint8Array[] | null,
): { transport: PipeTransport; written: Uint8Array[]; destroyed: () => number } {
  const { promise: ready, resolve } = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const output = new ReadableStream<Uint8Array>({ start: resolve });
  const written: Uint8Array[] = [];
  let destroyed = 0;
  const transport: PipeTransport = {
    async write(frame) {
      written.push(frame);
      const controller = await ready;
      for (const chunk of answer(frame) ?? []) controller.enqueue(chunk);
    },
    output,
    destroy() {
      destroyed++;
    },
    diagnostics: () => "stderr says: boom",
  };
  return { transport, written, destroyed: () => destroyed };
}

const reqIdOf = (frame: Uint8Array): number => new DataView(frame.buffer, frame.byteOffset).getUint32(0, true);
const entitlementBody: ReactorPipeResponse = {
  cmd: "entitlement",
  ok: true,
  ms: 0.1,
  tier: "community",
  max_workspaces: 1,
  max_seats: 5,
  sso: false,
  oem_offline_wasm: false,
  key_id: null,
  expires_at: null,
};

describe("PipeConnection", () => {
  test("returns the validated response to the request it sent, with its req_id", async () => {
    const { transport, written } = scripted((frame) => [encodeFrame(reqIdOf(frame), entitlementBody)]);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    const first = await connection.call({ cmd: "entitlement" });
    const second = await connection.call({ cmd: "entitlement" });
    expect(first.body).toEqual(entitlementBody);
    expect(written.map(reqIdOf)).toEqual([1, 2]);
    expect(connection.broken).toBe(false);
  });

  test("a refusal is a result, even one with no cmd", async () => {
    const refusal: ReactorPipeResponse = { ok: false, ms: 0.1, error: { code: "bad-request", message: "no cmd" } };
    const { transport } = scripted((frame) => [encodeFrame(reqIdOf(frame), refusal)]);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    const { body } = await connection.call({ cmd: "entitlement" });
    expect(body).toEqual(refusal);
    expect(connection.broken).toBe(false);
  });

  test("a request the contract refuses is never written", async () => {
    const { transport, written } = scripted(() => null);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    // `bytes` claims a segment that is not sent.
    const promise = connection.call({ cmd: "open", bytes: { bin: 0, len: 4 } });
    await expect(promise).rejects.toThrow(/invalid reactor pipe request/);
    expect(written).toEqual([]);
    expect(connection.broken).toBe(false);
  });

  test("an answer to another request breaks the connection and ends the worker", async () => {
    const { transport, destroyed } = scripted((frame) => [encodeFrame(reqIdOf(frame) + 1, entitlementBody)]);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    const fault = await failureOf(connection.call({ cmd: "entitlement" }), EngineFault);
    expect(fault.message).toMatch(/req_id 2, expected 1/);
    expect(fault.message).toMatch(/worker stderr: stderr says: boom/);
    expect(connection.broken).toBe(true);
    expect(destroyed()).toBe(1);
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/connection is closed/);
  });

  test("a response that does not validate breaks the connection", async () => {
    const { transport, destroyed } = scripted((frame) => [encodeFrame(reqIdOf(frame), { cmd: "entitlement", ok: true, ms: 0.1 })]);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/invalid response to entitlement/);
    expect(connection.broken).toBe(true);
    expect(destroyed()).toBe(1);
  });

  test("a response to another command breaks the connection", async () => {
    const closeBody = { cmd: "close", ok: true, ms: 0.1, doc: 1 };
    const { transport } = scripted((frame) => [encodeFrame(reqIdOf(frame), closeBody)]);
    const connection = new PipeConnection(transport, { timeoutMs: 5000 });
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/answers close, expected entitlement/);
    expect(connection.broken).toBe(true);
  });

  test("a worker that ends before it answers breaks the connection", async () => {
    const { transport } = scripted(() => null);
    const connection = new PipeConnection({ ...transport, output: streamOf([]) }, { timeoutMs: 5000 });
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/exited before it answered/);
    expect(connection.broken).toBe(true);
  });

  test("a worker that never answers is cut off at the timeout", async () => {
    const { transport, destroyed } = scripted(() => null);
    const connection = new PipeConnection(transport, { timeoutMs: 40 });
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/did not answer entitlement within 40 ms/);
    expect(connection.broken).toBe(true);
    expect(destroyed()).toBe(1);
  });

  test("a half-written answer is a fault, not a hang", async () => {
    const frame = encodeFrame(1, entitlementBody);
    const { transport } = scripted(() => [frame.slice(0, frame.length - 3)]);
    const connection = new PipeConnection({ ...transport, output: streamOf([frame.slice(0, frame.length - 3)]) }, { timeoutMs: 5000 });
    await expect(connection.call({ cmd: "entitlement" })).rejects.toThrow(/inside a frame body/);
    expect(connection.broken).toBe(true);
  });
});
