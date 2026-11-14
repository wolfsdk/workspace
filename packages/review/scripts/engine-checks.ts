/**
 * Runs the engine-backed checks of @wolfsdk/review on DOCX, PPTX and XLSX against one `wolf_web.wasm`,
 * on the node reactor kernel of @wolfsdk/runtime:
 *
 *   bun packages/review/scripts/engine-checks.ts [path/to/wolf_web.wasm] [options]
 *
 * Checks: review-actions, comparison, parts-gate, subset-replay, unexplained-parts, submission
 * (sources in test/engine/). Module path: the argument, else `WOLF_WEB_WASM`, else
 * `vendor/wolf_web.wasm`; no module is an error (exit 1). A check that needs a command the module
 * lacks is reported SKIPPED with the command's name, never as a pass; the exit code stays 0 for a skip
 * unless `--strict` is given. Any failed check exits 1.
 *
 *   --check <id>     run only this check (repeatable)
 *   --format <fmt>   run only this format: docx, pptx or xlsx (repeatable)
 *   --json <file>    write the module identity and every result as JSON
 *   --strict         a skipped check or part counts as a failure
 *   --verbose        print each check's progress lines (stderr) while it runs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { CHECK_IDS, FORMATS, createContext, resolveModulePath, type CheckId, type CheckResult, type Format } from "../test/engine/harness.ts";
import { isCheckId, runChecks } from "../test/engine/run.ts";

const USAGE =
  "usage: engine-checks.ts [path/to/wolf_web.wasm] [--check <id>]... [--format docx|pptx|xlsx]... [--json <file>] [--strict] [--verbose]";

const checks: CheckId[] = [];
const formats: Format[] = [];
let modulePath: string | undefined;
let jsonOut: string | undefined;
let strict = false;
let verbose = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--strict") strict = true;
  else if (arg === "--verbose") verbose = true;
  else if (arg === "--json") jsonOut = argv[++i];
  else if (arg === "--check" || arg === "--format") {
    const value = argv[++i];
    if (arg === "--check" && value && isCheckId(value)) checks.push(value);
    else if (arg === "--format" && value && (FORMATS as readonly string[]).includes(value)) formats.push(value as Format);
    else fail(`${arg} needs ${arg === "--check" ? CHECK_IDS.join(", ") : FORMATS.join(", ")} (got ${value})\n${USAGE}`);
  } else if (arg.startsWith("--") || modulePath) fail(`unexpected argument ${arg}\n${USAGE}`);
  else modulePath = arg;
}
if (jsonOut === undefined && argv.includes("--json")) fail(USAGE);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const resolved = resolveModulePath(modulePath);
if (!resolved) {
  fail(
    `no engine module: ${modulePath ?? "give a path, set WOLF_WEB_WASM or put one at vendor/wolf_web.wasm"} (the checks never pass without the module)`,
  );
}
const moduleBytes = readFileSync(resolved);
const sha256 = createHash("sha256").update(moduleBytes).digest("hex");
const ctx = await createContext(resolved, (message) => {
  if (verbose) console.error(message);
});
console.log(`module ${basename(resolved)} sha256 ${sha256} (${moduleBytes.length} bytes), engine ${ctx.build}`);
console.log(`commands: ${ctx.commands.join(", ")}`);

const label = (r: CheckResult) => `${r.check} ${r.format}`.padEnd(26);
const results = await runChecks(
  ctx,
  checks.length ? checks : CHECK_IDS,
  formats.length ? formats : FORMATS,
  (r) => {
    const status = r.status === "passed" ? "PASS   " : r.status === "skipped" ? "SKIPPED" : "FAIL   ";
    const detail =
      r.status === "failed"
        ? r.error
        : r.status === "skipped"
          ? r.skipped.map((s) => `${s.command ?? s.part}: ${s.reason}`).join("; ")
          : `${r.checks} checks`;
    console.log(`${status} ${label(r)} ${(r.ms / 1000).toFixed(1)}s  ${detail}`);
    for (const note of r.notes) console.log(`          ${note}`);
    if (r.status === "passed") for (const s of r.skipped) console.log(`          skipped part ${s.part}${s.command ? ` (${s.command})` : ""}: ${s.reason}`);
  },
);

const failed = results.filter((r) => r.status === "failed");
const skipped = results.filter((r) => r.status === "skipped" || r.skipped.length);
const passed = results.filter((r) => r.status === "passed");
const total = results.reduce((n, r) => n + r.checks, 0);
console.log(
  `${passed.length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped of ${results.length} (${total} assertions); ${skipped.length} with skipped parts`,
);

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify(
      {
        schema: "wolfsdk.engine-checks.v1",
        module: { file: basename(resolved), sha256, bytes: moduleBytes.length, engine: ctx.build, commands: ctx.commands },
        results,
      },
      null,
      2,
    )}\n`,
  );
}
process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
