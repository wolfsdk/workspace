import { describe, expect, test } from "bun:test";
import type { EditIntent, RivalId } from "../src/lab/index.ts";
import { FakeAssets, fakeVerifier } from "../src/lab/testing.ts";
import { createRivals } from "../src/rivals/index.ts";
import type { RivalsWorker } from "../src/rivals/index.ts";
import type { FromWorker, ToWorker } from "../src/rivals/protocol.ts";

type Behaviour = {
  /** What the fake worker does with a run message; `null` never answers. */
  onRun: (message: Extract<ToWorker, { type: "run" }>) => FromWorker | null;
  /** Asset ids to request before reporting ready. */
  requestAssets?: string[];
  bootError?: string;
};

class FakeWorker implements RivalsWorker {
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly received: ToWorker[] = [];
  readonly assetBytes: Uint8Array[] = [];
  #waiting = 0;

  readonly behaviour: Behaviour;

  constructor(behaviour: Behaviour) {
    this.behaviour = behaviour;
  }

  emit(message: FromWorker): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.(new MessageEvent("message", { data: message }));
    });
  }

  postMessage(message: ToWorker): void {
    this.received.push(message);
    switch (message.type) {
      case "init":
        if (this.behaviour.bootError) this.emit({ type: "boot-error", message: this.behaviour.bootError });
        else if (this.behaviour.requestAssets?.length) {
          this.#waiting = this.behaviour.requestAssets.length;
          this.behaviour.requestAssets.forEach((id, index) => this.emit({ type: "asset-request", reqId: index + 1, id }));
        } else this.emit({ type: "ready", python: "3.13.2", versions: { openpyxl: "3.1.5" } });
        return;
      case "asset":
        this.assetBytes.push(message.bytes);
        if (--this.#waiting === 0) this.emit({ type: "ready", python: "3.13.2", versions: { openpyxl: "3.1.5" } });
        return;
      case "asset-error":
        this.emit({ type: "boot-error", message: message.message });
        return;
      case "run": {
        const reply = this.behaviour.onRun(message);
        if (reply) this.emit(reply);
        return;
      }
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const intent: EditIntent = { kind: "set-cell", sheet: "Sheet1", a1: "A1", value: 1 };
const ok = (id: number): FromWorker => ({
  type: "result",
  id,
  output: new Uint8Array([1, 2, 3]),
  ms: 7,
  ok: true,
  error: null,
  stdout: "hello",
  stderr: "",
  version: "3.1.5",
});

const SCRIPT_BASE = "https://play.invalid/pyodide/0.29.5/";

function setup(behaviours: Behaviour[], timeoutMs = 50) {
  const workers: FakeWorker[] = [];
  const assets = new FakeAssets({ "rivals/pyodide/pyodide.mjs": new Uint8Array([9, 9]), "scenarios/other.bin": new Uint8Array([1]) });
  const rivals = createRivals({
    assets,
    verifier: fakeVerifier,
    scriptBase: SCRIPT_BASE,
    timeoutMs,
    createWorker: () => {
      const worker = new FakeWorker(behaviours[Math.min(workers.length, behaviours.length - 1)]!);
      workers.push(worker);
      return worker;
    },
  });
  return { rivals, workers, assets };
}

describe("createRivals", () => {
  test("starts no worker until the first run", async () => {
    const { rivals, workers } = setup([{ onRun: (m) => ok(m.id) }]);
    expect(workers).toHaveLength(0);
    rivals.supports("openpyxl", "xlsx", "user-script");
    expect(workers).toHaveLength(0);
    const record = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(workers).toHaveLength(1);
    expect(record.ok).toBe(true);
    rivals.dispose();
  });

  test("sends only rivals assets, answers asset requests, and fills the record", async () => {
    const { rivals, workers, assets } = setup([{ onRun: (m) => ok(m.id), requestAssets: [] }]);
    const wheel = assets.resolve("rivals/pyodide/pyodide.mjs")!;
    const result = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    const init = workers[0]!.received[0];
    expect(init?.type === "init" && init.assets.map((a) => a.path)).toEqual(["rivals/pyodide/pyodide.mjs"]);
    expect(init?.type === "init" && init.scriptBase).toBe(SCRIPT_BASE);
    expect(result).toMatchObject({ rival: "openpyxl", version: "3.1.5", ok: true, ms: 7, stdout: "hello" });
    expect([...result.outputBytes!]).toEqual([1, 2, 3]);
    expect(result.delta).toBeDefined();
    expect(wheel.bytes).toBe(2);
    rivals.dispose();
  });

  test("serves an asset request from the bus and refuses an id it does not list", async () => {
    const { rivals, workers, assets } = setup([{ onRun: (m) => ok(m.id) }]);
    const id = assets.resolve("rivals/pyodide/pyodide.mjs")!.id;
    workers.length = 0;
    const second = setup([{ onRun: (m) => ok(m.id), requestAssets: [id] }]);
    const record = await second.rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(record.ok).toBe(true);
    expect([...second.workers[0]!.assetBytes[0]!]).toEqual([9, 9]);
    const bad = setup([{ onRun: (m) => ok(m.id), requestAssets: ["f".repeat(64)] }]);
    const failed = await bad.rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("did not start");
    rivals.dispose();
    second.rivals.dispose();
    bad.rivals.dispose();
  });

  test("a run past the limit stops the worker, reports it, and the next run starts a new one", async () => {
    let calls = 0;
    const { rivals, workers } = setup([{ onRun: (m) => (++calls === 1 ? null : ok(m.id)) }], 30);
    const slow = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(slow.ok).toBe(false);
    expect(slow.error).toContain("timed out");
    expect(workers[0]!.terminated).toBe(true);
    const next = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(next.ok).toBe(true);
    expect(workers).toHaveLength(2);
    rivals.dispose();
  });

  test("runs are serialised", async () => {
    const order: number[] = [];
    const { rivals } = setup([
      {
        onRun: (m) => {
          order.push(m.id);
          return ok(m.id);
        },
      },
    ]);
    const bytes = new Uint8Array([5]);
    const records = await Promise.all([1, 2, 3].map(() => rivals.run("openpyxl", bytes, intent)));
    expect(records.every((r) => r.ok)).toBe(true);
    expect(order).toEqual([1, 2, 3]);
    rivals.dispose();
  });

  test("a boot failure is a failed record, not a throw", async () => {
    const { rivals, workers } = setup([{ onRun: () => null, bootError: "wheel missing" }]);
    const record = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(record).toMatchObject({ ok: false });
    expect(record.error).toContain("wheel missing");
    expect(workers[0]!.terminated).toBe(true);
    rivals.dispose();
  });

  test("a script that wrote nothing comes back as the worker's error", async () => {
    const { rivals } = setup([
      { onRun: (m) => ({ type: "result", id: m.id, output: null, ms: 1, ok: false, error: "the script did not write OUTPUT_PATH", stdout: "", stderr: "", version: null }) },
    ]);
    const record = await rivals.run("openpyxl", new Uint8Array([5]), { kind: "user-script", python: "pass" });
    expect(record.ok).toBe(false);
    expect(record.error).toContain("OUTPUT_PATH");
    expect(record.outputBytes).toBeUndefined();
    rivals.dispose();
  });

  test("dispose stops the worker and later runs fail without starting another", async () => {
    const { rivals, workers } = setup([{ onRun: (m) => ok(m.id) }]);
    await rivals.run("openpyxl", new Uint8Array([5]), intent);
    rivals.dispose();
    expect(workers[0]!.terminated).toBe(true);
    const after = await rivals.run("openpyxl", new Uint8Array([5]), intent);
    expect(after.ok).toBe(false);
    expect(workers).toHaveLength(1);
  });

  test("an intent the rival has no adapter for is refused without a worker", async () => {
    const { rivals, workers } = setup([{ onRun: (m) => ok(m.id) }]);
    const record = await rivals.run("python-docx" satisfies RivalId, new Uint8Array([5]), intent);
    expect(record.ok).toBe(false);
    expect(workers).toHaveLength(0);
    rivals.dispose();
  });
});

describe("supports", () => {
  test("allows the rival's adapter kinds, a pasted script included, on the rival's format only", () => {
    const rivals = createRivals({
      assets: new FakeAssets(),
      verifier: fakeVerifier,
      scriptBase: SCRIPT_BASE,
      createWorker: () => {
        throw new Error("no worker needed");
      },
    });
    expect(rivals.supports("openpyxl", "xlsx", "set-cell")).toBe(true);
    expect(rivals.supports("openpyxl", "docx", "set-cell")).toBe(false);
    expect(rivals.supports("python-docx", "docx", "replace-text")).toBe(true);
    expect(rivals.supports("python-docx", "docx", "set-cell")).toBe(false);
    expect(rivals.supports("python-pptx", "pptx", "set-shape-text")).toBe(true);
    expect(rivals.supports("python-pptx", "pptx", "user-script")).toBe(true);
    expect(rivals.supports("python-pptx", "xlsx", "user-script")).toBe(false);
  });
});
