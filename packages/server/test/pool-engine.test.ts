// The process pool and the engine on top of it, driven against the stand-in reactor over real pipes. The
// hashes the tests expect are computed here with `node:crypto`, not taken from the code under test.
import { afterEach, describe, expect, test } from "bun:test";
import type { RoomBatch } from "@wolfsdk/protocol/workspace";
import { EngineFault, EngineRefusal, PoolEngine, WorkerPool } from "../src/index.ts";
import { bytesOf, failureOf, FAKE_REACTOR, makePool, sha256, textOf } from "./fixtures/harness.ts";

const pools: WorkerPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function engineOn(options: Parameters<typeof makePool>[0] = {}): { pool: WorkerPool; engine: PoolEngine } {
  const pool = makePool(options);
  pools.push(pool);
  return { pool, engine: new PoolEngine(pool) };
}

const batch = (...ops: RoomBatch["ops"]): RoomBatch => ({ ops });
const append = (text: string): RoomBatch => batch({ op: "append", text });
const input = (text: string, batches: RoomBatch[], save = true, pages = false) => ({
  format: "docx" as const,
  name: "doc.docx",
  bytes: bytesOf(text),
  batches,
  save,
  pages,
});

describe("entitlement", () => {
  test("is the answer of the engine: the keyless community grant", async () => {
    const { engine } = engineOn();
    expect(await engine.entitlement()).toEqual({
      tier: "community",
      max_workspaces: 1,
      max_seats: 5,
      sso: false,
      oem_offline_wasm: false,
      key_id: null,
      expires_at: null,
    });
  });

  test("passes a keyed grant and unlimited (null) limits through unchanged", async () => {
    const { engine } = engineOn({ env: { FAKE_TIER: "commercial", FAKE_KEYED: "1", FAKE_MAX_WORKSPACES: "null", FAKE_MAX_SEATS: "50" } });
    expect(await engine.entitlement()).toMatchObject({
      tier: "commercial",
      max_workspaces: null,
      max_seats: 50,
      key_id: "test-key-1",
      expires_at: "2099-01-01T00:00:00Z",
    });
  });
});

describe("replay", () => {
  test("no batch: the bytes come back as given, with their hash", async () => {
    const { engine } = engineOn();
    const result = await engine.replay(input("hello", []));
    expect(textOf(result.bytes ?? new Uint8Array())).toBe("hello");
    expect(result.base_sha256).toBe(sha256(bytesOf("hello")));
    expect(result.steps).toEqual([]);
  });

  test("batches apply in order and every step carries the hash of the bytes it produced", async () => {
    const { engine } = engineOn();
    const result = await engine.replay(input("a", [append("b"), batch({ op: "replace", find: "b", text: "B" }), append("c")]));
    expect(result.steps).toEqual([
      { base_sha256: sha256(bytesOf("a")), sha256: sha256(bytesOf("ab")) },
      { base_sha256: sha256(bytesOf("ab")), sha256: sha256(bytesOf("aB")) },
      { base_sha256: sha256(bytesOf("aB")), sha256: sha256(bytesOf("aBc")) },
    ]);
    expect(textOf(result.bytes ?? new Uint8Array())).toBe("aBc");
    expect(sha256(result.bytes ?? new Uint8Array())).toBe(result.steps[2]?.sha256 ?? "");
  });

  test("a dry run that does not save returns no bytes", async () => {
    const { engine } = engineOn();
    const result = await engine.replay(input("a", [append("b")], false));
    expect(result.bytes).toBeNull();
    expect(result.steps).toHaveLength(1);
  });

  test("page hashes are those of the document after the last batch", async () => {
    const { engine } = engineOn();
    const result = await engine.replay(input("one\ftwo", [append("\fthree")], true, true));
    expect(result.page_hashes).toEqual(["one", "two", "three"].map((page) => sha256(bytesOf(page))));
    expect((await engine.replay(input("one\ftwo", [append("\fthree")], true, false))).page_hashes).toBeNull();
  });

  test("page hashes of a document the batches leave alone come from layout", async () => {
    const { engine } = engineOn();
    const result = await engine.replay(input("one\ftwo", [], true, true));
    expect(result.page_hashes).toEqual(["one", "two"].map((page) => sha256(bytesOf(page))));
  });
});

describe("what the engine refuses", () => {
  test("a batch that fails commits nothing, names the typed error, and leaves the worker usable", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const refusal = await failureOf(engine.replay(input("a", [append("b"), batch({ op: "fail", message: "no such cell" })])), EngineRefusal);
    expect(refusal.code).toBe("op-failed");
    expect(refusal.message).toMatch(/no such cell/);
    expect(refusal.isLicense).toBe(false);
    // The same process serves the next job, and the failed batch left no trace in it.
    expect(textOf((await engine.replay(input("a", []))).bytes ?? new Uint8Array())).toBe("a");
    expect(pool.spawned).toBe(1);
  });

  test("a refusal with no cmd is a refusal of the command that was asked", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const refusal = await failureOf(engine.replay(input("a", [batch({ op: "refuse_nocmd" })])), EngineRefusal);
    expect([refusal.code, refusal.cmd]).toEqual(["bad-request", "apply"]);
    expect(refusal.message).toMatch(/no cmd, on purpose/);
    expect(pool.spawned).toBe(1);
  });

  test("a document the engine will not open is refused at open", async () => {
    const { engine } = engineOn();
    const refusal = await failureOf(engine.replay(input("!!bad bytes", [])), EngineRefusal);
    expect([refusal.code, refusal.cmd, refusal.argument]).toEqual(["invalid-input", "open", "bytes"]);
  });

  test("a format the engine does not edit is refused at apply", async () => {
    const { engine } = engineOn();
    const refusal = await failureOf(engine.replay({ ...input("x", [append("y")]), format: "pdf", name: "doc.pdf" }), EngineRefusal);
    expect([refusal.code, refusal.cmd]).toEqual(["unsupported", "apply"]);
  });
});

describe("a worker that cannot be trusted", () => {
  test("crash mid-batch: a fault, the next job gets a fresh process", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const fault = await failureOf(engine.replay(input("a", [append("b"), batch({ op: "crash" })])), EngineFault);
    expect(fault.message).toMatch(/worker exited before it answered/);
    expect(pool.spawned).toBe(1);
    expect(textOf((await engine.replay(input("a", [append("z")]))).bytes ?? new Uint8Array())).toBe("az");
    expect(pool.spawned).toBe(2);
  });

  test("bytes that are no frame: a fault naming the frame header", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "garbage" })])), EngineFault);
    expect(fault.message).toMatch(/malformed frame header/);
    expect((await engine.replay(input("a", []))).steps).toEqual([]);
    expect(pool.spawned).toBe(2);
  });

  test("half a frame, then the end: a fault, not a hang and not a result", async () => {
    const { engine } = engineOn({ poolSize: 1 });
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "truncate" })])), EngineFault);
    expect(fault.message).toMatch(/inside a frame body/);
  });

  test("a hung worker times out; its process is replaced", async () => {
    const { engine, pool } = engineOn({ poolSize: 1, callTimeoutMs: 400 });
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "hang" })])), EngineFault);
    expect(fault.message).toMatch(/did not answer apply within 400 ms/);
    expect(textOf((await engine.replay(input("a", []))).bytes ?? new Uint8Array())).toBe("a");
    expect(pool.spawned).toBe(2);
  });

  test("an answer to another request is a fault", async () => {
    const { engine } = engineOn();
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "wrong_req_id" })])), EngineFault);
    expect(fault.message).toMatch(/carries req_id \d+, expected \d+/);
  });

  test("a body the response validator refuses is a fault", async () => {
    const { engine } = engineOn();
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "invalid_response" })])), EngineFault);
    expect(fault.message).toMatch(/invalid response to apply/);
  });

  test("a worker that reports a hash the saved bytes do not have is a fault", async () => {
    const { engine } = engineOn();
    const fault = await failureOf(engine.replay(input("a", [batch({ op: "lie_sha" })])), EngineFault);
    expect(fault.message).toMatch(/worker saved bytes that hash to/);
  });

  test("an executable that cannot be started is a fault naming it", async () => {
    const pool = new WorkerPool({ command: ["wolfsdk-no-such-executable"] });
    pools.push(pool);
    const fault = await failureOf(new PoolEngine(pool).entitlement(), EngineFault);
    expect(fault.message).toMatch(/cannot start worker \["wolfsdk-no-such-executable"\]/);
  });
});

describe("the pool", () => {
  test("one worker serves jobs one at a time and is reused", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const results = await Promise.all(["a", "b", "c", "d"].map((text) => engine.replay(input(text, [append("!")]))));
    expect(results.map((r) => textOf(r.bytes ?? new Uint8Array()))).toEqual(["a!", "b!", "c!", "d!"]);
    expect(pool.spawned).toBe(1);
  });

  test("jobs never see each other's documents, even on a size-2 pool", async () => {
    const { engine, pool } = engineOn({ poolSize: 2 });
    const texts = Array.from({ length: 12 }, (_, i) => `doc-${i}`);
    const results = await Promise.all(texts.map((text) => engine.replay(input(text, [append("-end")]))));
    expect(results.map((r) => textOf(r.bytes ?? new Uint8Array()))).toEqual(texts.map((t) => `${t}-end`));
    expect(pool.spawned).toBe(2);
  });

  test("a closed pool refuses work, and a job waiting for a worker fails with it", async () => {
    const { engine, pool } = engineOn({ poolSize: 1 });
    const running = failureOf(engine.replay(input("a", [batch({ op: "hang" })])), EngineFault);
    const waiting = failureOf(engine.replay(input("b", [])), EngineFault);
    await pool.close();
    expect((await running).message).toMatch(/worker stopped/);
    expect((await waiting).message).toMatch(/worker pool is closed/);
    await expect(engine.entitlement()).rejects.toThrow(/worker pool is closed/);
  });

  test("refuses a pool with no command or no room for a worker", () => {
    expect(() => new WorkerPool({ command: [] })).toThrow(/worker command is empty/);
    expect(() => new WorkerPool({ command: [process.execPath, FAKE_REACTOR], size: 0 })).toThrow(/pool size/);
  });
});
