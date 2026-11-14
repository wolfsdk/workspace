/**
 * Replay recipes for a playground `Journal`. Every emitter is a pure function of the
 * journal: no clock, no randomness, object keys of recorded ops sorted, so
 * the same journal always gives the same string.
 *
 * Native replay follows `SessionLog` of `@wolfsdk/protocol` and
 * `wolf transact` in `docs/agent-cli-contract.md` section 2: one
 * transaction per applied step, each bound to its input by `--sha256`, each
 * writing `<outdir>/<input name>`, which is the next step's input.
 */
import type { SessionLog } from "@wolfsdk/protocol";
import type { Journal, Op } from "../lab/index.ts";

export type BatchFile = Pick<SessionLog, "clock" | "timezone" | "locale" | "seed"> & {
  batches: { ops: SessionLog["batches"][number]["ops"] }[];
};

type Entry = Journal["entries"][number];

/** File name the batch file is downloaded under and the scripts read. */
export const BATCH_FILE = "wolf-batches.json";

/** Deep copy with object keys in code-unit order and `undefined` members dropped. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = sortKeys(member);
    }
    return out;
  }
  return value;
}

export function toBatches(journal: Journal): BatchFile {
  const { clock, timezone, locale, seed } = journal.environment;
  return {
    clock,
    timezone,
    locale,
    seed,
    batches: plan(journal).runs.map((run) => ({ ops: run.ops })),
  };
}

/** `toBatches` as the text of `wolf-batches.json`. */
export function batchesJson(journal: Journal): string {
  return `${JSON.stringify(toBatches(journal), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Shared replay plan
// ---------------------------------------------------------------------------

type Run = { number: number; entry: Entry; ops: Op[]; input: string; outdir: string; output: string };

type Plan = {
  name: string;
  runs: Run[];
  /** Steps left out (rejected or conflicted), for the record. */
  skipped: Entry[];
  /** Path of the bytes whose sha256 must equal `journal.resultSha256`. */
  final: string;
};

/** The file name without any directory part; outputs keep the input's name. */
function fileName(journal: Journal): string {
  const base = journal.file.name.split(/[\\/]/).pop() ?? "";
  return base === "" || base === "." || base === ".." ? `document.${journal.file.format}` : base;
}

function plan(journal: Journal): Plan {
  const name = fileName(journal);
  const runs: Run[] = [];
  let input = name;
  for (const entry of journal.entries) {
    if (entry.status !== "applied") continue;
    const number = runs.length + 1;
    const outdir = `out/${number}`;
    const output = `${outdir}/${name}`;
    runs.push({ number, entry, ops: sortKeys(entry.ops) as Op[], input, outdir, output });
    input = output;
  }
  return { name, runs, skipped: journal.entries.filter((e) => e.status !== "applied"), final: input };
}

/** A string literal in Python and TypeScript source (a JSON string is both). */
function quoted(text: string): string {
  return JSON.stringify(text);
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

function stepTitle(entry: Entry): string {
  const label = oneLine(entry.label) || "Untitled step";
  return entry.author ? `${label} (${oneLine(entry.author)})` : label;
}

/** Header lines shared by every script, without a comment prefix. */
function header(journal: Journal, p: Plan): string[] {
  const { clock, timezone, locale, seed } = journal.environment;
  const engine = journal.engine
    ? `Recorded with engine ${journal.engine.version === null ? "module" : `version ${journal.engine.version}`}, module sha256 ${journal.engine.moduleSha256}.`
    : "No engine build is recorded for this journal.";
  const left = p.skipped.length === 0 ? "" : `, ${p.skipped.length} left out (rejected or conflicted)`;
  return [
    `Source: ${p.name}, sha256 ${journal.file.sha256}.`,
    `Steps: ${journal.entries.length} recorded, ${p.runs.length} applied${left}.`,
    `Environment: clock ${clock}, time zone ${timezone}, locale ${locale}, seed ${seed}.`,
    engine,
    `Expected result sha256: ${journal.resultSha256}.`,
  ];
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function sh(word: string): string {
  return /^[A-Za-z0-9._/:+=@%,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The documented flags of one `wolf transact` run, without the program name. */
function transactArgs(journal: Journal, run: Run, opsPath: string): string[] {
  const { clock, timezone, locale, seed } = journal.environment;
  return [
    "transact",
    run.input,
    "--sha256",
    run.entry.baseSha256,
    "--ops",
    opsPath,
    "--outdir",
    run.outdir,
    "--clock",
    clock,
    "--timezone",
    timezone,
    "--locale",
    locale,
    "--seed",
    String(seed),
  ];
}

export function toCli(journal: Journal): string {
  const p = plan(journal);
  const lines = [
    "#!/bin/sh",
    "# Replays a Wolf Playground journal with the wolf CLI and checks the result digest.",
    `# Put ${p.name} in this directory, then run: sh replay.sh`,
    "# Set WOLF to the wolf binary if it is not on PATH.",
    ...header(journal, p).map((l) => `# ${l}`),
    "set -eu",
    'WOLF="${WOLF:-wolf}"',
  ];
  const skippedAt = new Map(p.skipped.map((e) => [e.index, e]));
  const emitSkipped = (upTo: number) => {
    for (const [index, entry] of skippedAt) {
      if (index >= upTo) continue;
      lines.push("", `# Step ${index + 1} left out (${entry.status}): ${stepTitle(entry)}`);
      skippedAt.delete(index);
    }
  };
  for (const run of p.runs) {
    emitSkipped(run.entry.index);
    const opsPath = `ops-${run.number}.json`;
    lines.push(
      "",
      `# Batch ${run.number}, step ${run.entry.index + 1}: ${stepTitle(run.entry)}`,
      `cat > ${opsPath} <<'WOLF_OPS'`,
      run.ops.length === 0 ? "[]" : `[\n${run.ops.map((op) => `  ${JSON.stringify(op)}`).join(",\n")}\n]`,
      "WOLF_OPS",
      `"$WOLF" ${transactArgs(journal, run, opsPath).map(sh).join(" ")}`,
    );
  }
  emitSkipped(Number.POSITIVE_INFINITY);
  const check = `${journal.resultSha256}  ${p.final}`;
  lines.push(
    "",
    "# Check the result against the journal.",
    "if command -v sha256sum >/dev/null 2>&1; then",
    `  echo ${sh(check)} | sha256sum -c -`,
    "else",
    `  echo ${sh(check)} | shasum -a 256 -c -`,
    "fi",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

export function toPython(journal: Journal): string {
  const p = plan(journal);
  return [
    "#!/usr/bin/env python3",
    "# Replays a Wolf Playground journal with the wolf CLI and checks the result digest.",
    `# Put ${p.name} and ${BATCH_FILE} (the Batches tab) in this directory,`,
    "# then run: python3 replay.py",
    "# Set WOLF to the wolf binary if it is not on PATH.",
    ...header(journal, p).map((l) => `# ${l}`),
    "import hashlib",
    "import json",
    "import os",
    "import pathlib",
    "import subprocess",
    "import sys",
    "",
    'WOLF = os.environ.get("WOLF", "wolf")',
    `SOURCE = pathlib.Path(${quoted(p.name)})`,
    `BATCHES = pathlib.Path(${quoted(BATCH_FILE)})`,
    `SOURCE_SHA256 = ${quoted(journal.file.sha256)}`,
    `EXPECTED_SHA256 = ${quoted(journal.resultSha256)}`,
    "",
    "",
    "def sha256(path):",
    "    return hashlib.sha256(path.read_bytes()).hexdigest()",
    "",
    "",
    'log = json.loads(BATCHES.read_text(encoding="utf-8"))',
    "current = SOURCE",
    "if sha256(current) != SOURCE_SHA256:",
    '    sys.exit(f"{SOURCE} is not the file this journal was recorded on")',
    'for number, batch in enumerate(log["batches"], start=1):',
    '    ops = pathlib.Path(f"ops-{number}.json")',
    '    ops.write_text(json.dumps(batch["ops"]), encoding="utf-8")',
    '    outdir = pathlib.Path("out") / str(number)',
    "    argv = [",
    '        WOLF, "transact", str(current),',
    '        "--sha256", sha256(current),',
    '        "--ops", str(ops),',
    '        "--outdir", str(outdir),',
    '        "--clock", log["clock"],',
    '        "--timezone", log["timezone"],',
    '        "--locale", log["locale"],',
    '        "--seed", str(log["seed"]),',
    "    ]",
    "    run = subprocess.run(argv, capture_output=True, text=True)",
    "    if run.returncode != 0:",
    '        sys.exit(f"wolf transact failed on batch {number} (exit {run.returncode})\\n{run.stdout}{run.stderr}")',
    "    current = outdir / SOURCE.name",
    "",
    "actual = sha256(current)",
    "if actual != EXPECTED_SHA256:",
    '    sys.exit(f"{current}: sha256 {actual}, expected {EXPECTED_SHA256}")',
    'print(f"{current}: sha256 {actual} matches the journal")',
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** `wolf_transact` takes an unchanged `agent-cli.v1` request (agent-cli
 * contract section 9.1); paths are workspace-relative. */
export function toMcp(journal: Journal): string {
  const p = plan(journal);
  const { clock, timezone, locale, seed } = journal.environment;
  const doc = {
    server: "wolfsuite-agent",
    source: { path: p.name, sha256: journal.file.sha256 },
    expect: { path: p.final, sha256: journal.resultSha256 },
    calls: p.runs.map((run) => ({
      name: "wolf_transact",
      arguments: {
        contract_version: "v1",
        document_kind: "request",
        request_id: `playground-batch-${run.number}`,
        verb: "transact",
        inputs: [{ path: run.input, format: journal.file.format, sha256: run.entry.baseSha256 }],
        output_dir: run.outdir,
        options: { ops: run.ops },
        determinism: { locale, clock: { instant: clock, timezone }, random_seed: seed },
      },
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

export function toTypeScript(journal: Journal): string {
  const p = plan(journal);
  return [
    "// Replays a Wolf Playground journal with the reactor kernel and checks the result digest.",
    "// Run it from the sdk/web workspace of a repository checkout: the Node entry point",
    "// @wolfsdk/runtime/node is not published to npm. With the Batches tab saved as",
    `// ${BATCH_FILE} beside the document: bun <file> <doc> <module> [${BATCH_FILE}]`,
    `// (<doc> defaults to ${p.name}, <module> to wolf_web.wasm).`,
    ...header(journal, p).map((l) => `// ${l}`),
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import type { Op } from "@wolfsdk/protocol";',
    'import { createNodeReactorKernel } from "@wolfsdk/runtime/node";',
    "",
    `const [source = ${quoted(p.name)}, modulePath = "wolf_web.wasm", batchesPath = ${quoted(BATCH_FILE)}] = process.argv.slice(2);`,
    `const SOURCE_SHA256 = ${quoted(journal.file.sha256)};`,
    `const EXPECTED_SHA256 = ${quoted(journal.resultSha256)};`,
    "const log = JSON.parse(readFileSync(batchesPath, \"utf8\")) as {",
    "  clock: string;",
    "  timezone: string;",
    "  locale: string;",
    "  seed: number;",
    "  batches: { ops: Op[] }[];",
    "};",
    'const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");',
    "",
    "const bytes = new Uint8Array(readFileSync(source));",
    "if (sha256(bytes) !== SOURCE_SHA256) throw new Error(`${source} is not the file this journal was recorded on`);",
    "const kernel = createNodeReactorKernel(modulePath, {",
    "  environment: { clock: log.clock, timezone: log.timezone, locale: log.locale, seed: log.seed },",
    "});",
    `const opened = await kernel.open(bytes, ${quoted(p.name)});`,
    "for (const [index, batch] of log.batches.entries()) {",
    "  const result = await kernel.apply(opened.doc, batch.ops);",
    "  if (!result.ok) throw new Error(`batch ${index + 1} refused: ${result.error.code}: ${result.error.message}`);",
    "}",
    "const actual = sha256(await kernel.save(opened.doc));",
    "if (actual !== EXPECTED_SHA256) throw new Error(`sha256 ${actual}, expected ${EXPECTED_SHA256}`);",
    "console.log(`sha256 ${actual} matches the journal`);",
    "",
  ].join("\n");
}
