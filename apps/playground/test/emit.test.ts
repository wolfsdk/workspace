import { describe, expect, test } from "bun:test";
import type { Journal, Op } from "../src/lab/index.ts";
import { sampleEnvironment, sampleIdentity } from "../src/lab/testing.ts";
import { toBatches, toCli, toMcp, toPython, toTypeScript } from "../src/codegen/index.ts";

const hex = (c: string) => c.repeat(64);
const set = (cell: string, n: number): Op[] => [{ op: "set", target: `sheet:#1/cell:${cell}`, value: { number: n } }];

/** Four steps: 0 applied, 1 rejected, 2 restored (applied again after a
 * reject), 3 conflicted. */
function journal(overrides: Partial<Journal> = {}): Journal {
  return {
    file: { name: "q3 model's.xlsx", format: "xlsx", sha256: hex("a") },
    environment: sampleEnvironment,
    engine: sampleIdentity,
    entries: [
      { index: 0, label: "Set A1", author: "agent", ops: set("A1", 1), status: "applied", baseSha256: hex("a"), resultSha256: hex("b") },
      { index: 1, label: "Set A2", ops: set("A2", 2), status: "rejected", baseSha256: hex("b"), resultSha256: hex("b") },
      { index: 2, label: "Set A3\nrestored", ops: set("A3", 3), status: "applied", baseSha256: hex("b"), resultSha256: hex("c") },
      { index: 3, label: "Set A4", ops: set("A4", 4), status: "conflict", baseSha256: hex("c"), resultSha256: hex("c") },
    ],
    resultSha256: hex("c"),
    ...overrides,
  };
}

const EMITTERS = { toCli, toPython, toMcp, toTypeScript, toBatches: (j: Journal) => JSON.stringify(toBatches(j)) };

describe("toBatches", () => {
  test("keeps only applied steps, in order, with the journal's environment", () => {
    expect(toBatches(journal())).toEqual({
      clock: sampleEnvironment.clock,
      timezone: sampleEnvironment.timezone,
      locale: sampleEnvironment.locale,
      seed: sampleEnvironment.seed,
      batches: [{ ops: set("A1", 1) }, { ops: set("A3", 3) }],
    });
  });

  test("a restored step is applied again; rejecting every step leaves no batch", () => {
    const base = journal();
    const restored = journal({ entries: base.entries.map((e) => ({ ...e, status: "applied" as const })) });
    expect(toBatches(restored).batches.map((b) => b.ops)).toEqual([set("A1", 1), set("A2", 2), set("A3", 3), set("A4", 4)]);
    const none = journal({ entries: base.entries.map((e) => ({ ...e, status: "rejected" as const })) });
    expect(toBatches(none).batches).toEqual([]);
  });

  test("works without a recorded engine", () => {
    const j = journal({ engine: null });
    expect(toBatches(j).batches).toHaveLength(2);
    for (const emit of [toCli, toPython, toTypeScript]) expect(emit(j)).toContain("No engine build is recorded");
  });
});

describe("determinism", () => {
  test("same input gives identical strings", () => {
    for (const [name, emit] of Object.entries(EMITTERS)) {
      expect(emit(journal()), name).toBe(emit(structuredClone(journal())));
    }
  });

  test("key order of recorded ops does not change the output", () => {
    const reordered = journal();
    reordered.entries = reordered.entries.map((e) => ({
      ...e,
      ops: e.ops.map((op) => Object.fromEntries(Object.entries(op).reverse()) as Op),
    }));
    for (const [name, emit] of Object.entries(EMITTERS)) expect(emit(reordered), name).toBe(emit(journal()));
  });
});

describe("toCli", () => {
  const cli = toCli(journal());

  test("one transact per applied step, chained by sha256 and output path", () => {
    const runs = cli.split("\n").filter((l) => l.startsWith('"$WOLF" transact'));
    expect(runs).toEqual([
      `"$WOLF" transact 'q3 model'\\''s.xlsx' --sha256 ${hex("a")} --ops ops-1.json --outdir out/1 --clock 2026-01-01T00:00:00Z --timezone UTC --locale en-US --seed 0`,
      `"$WOLF" transact 'out/1/q3 model'\\''s.xlsx' --sha256 ${hex("b")} --ops ops-2.json --outdir out/2 --clock 2026-01-01T00:00:00Z --timezone UTC --locale en-US --seed 0`,
    ]);
    expect(cli).not.toContain("cell:A2");
    expect(cli).not.toContain("cell:A4");
    expect(cli).toContain("# Step 2 left out (rejected): Set A2");
    expect(cli).toContain("# Step 4 left out (conflict): Set A4");
    expect(cli).toContain("# Batch 2, step 3: Set A3 restored");
  });

  test("ends with a sha256 check of the last output", () => {
    const tail = cli.trimEnd().split("\n").slice(-5);
    expect(tail[1]).toBe(`  echo '${hex("c")}  out/2/q3 model'\\''s.xlsx' | sha256sum -c -`);
    expect(tail[3]).toBe(`  echo '${hex("c")}  out/2/q3 model'\\''s.xlsx' | shasum -a 256 -c -`);
  });

  test("parses as POSIX shell", () => {
    const run = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(cli) });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});

describe("toPython", () => {
  test("names the batch file and both digests, and parses", () => {
    const script = toPython(journal());
    expect(script).toContain('BATCHES = pathlib.Path("wolf-batches.json")');
    expect(script).toContain(`SOURCE_SHA256 = "${hex("a")}"`);
    expect(script).toContain(`EXPECTED_SHA256 = "${hex("c")}"`);
    expect(script).toContain('WOLF, "transact", str(current),');
    const python = Bun.which("python3");
    if (!python) return;
    const run = Bun.spawnSync([python, "-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
      stdin: new TextEncoder().encode(script),
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});

describe("toMcp", () => {
  test("wolf_transact calls carry agent-cli.v1 requests chained through the workspace", () => {
    const doc = JSON.parse(toMcp(journal()));
    expect(doc.expect).toEqual({ path: "out/2/q3 model's.xlsx", sha256: hex("c") });
    expect(doc.calls).toHaveLength(2);
    expect(doc.calls[1]).toEqual({
      name: "wolf_transact",
      arguments: {
        contract_version: "v1",
        document_kind: "request",
        request_id: "playground-batch-2",
        verb: "transact",
        inputs: [{ path: "out/1/q3 model's.xlsx", format: "xlsx", sha256: hex("b") }],
        output_dir: "out/2",
        options: { ops: set("A3", 3) },
        determinism: { locale: "en-US", clock: { instant: "2026-01-01T00:00:00Z", timezone: "UTC" }, random_seed: 0 },
      },
    });
  });

  test("no applied step: no calls, the source is the expected result", () => {
    const j = journal({ entries: [], resultSha256: hex("a") });
    expect(JSON.parse(toMcp(j))).toMatchObject({ calls: [], expect: { path: "q3 model's.xlsx", sha256: hex("a") } });
  });
});

describe("toTypeScript", () => {
  test("replays through createNodeReactorKernel from a repository checkout and checks both digests", () => {
    const code = toTypeScript(journal());
    expect(code).toContain('import type { Op } from "@wolfsdk/protocol";');
    expect(code).toContain('import { createNodeReactorKernel } from "@wolfsdk/runtime/node";');
    expect(code).toContain("// Run it from the sdk/web workspace of a repository checkout");
    expect(code).toContain("bun <file> <doc> <module> [wolf-batches.json]");
    expect(code).toContain(`const [source = "q3 model's.xlsx", modulePath = "wolf_web.wasm", batchesPath = "wolf-batches.json"] = process.argv.slice(2);`);
    expect(code).toContain(`const EXPECTED_SHA256 = "${hex("c")}";`);
    expect(code).toContain(`const SOURCE_SHA256 = "${hex("a")}";`);
  });
});
