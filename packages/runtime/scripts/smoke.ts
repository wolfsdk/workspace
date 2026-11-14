// Smoke test of the in-process reactor kernel on a real engine module:
//   bun packages/runtime/scripts/smoke.ts [path/to/wolf_web.wasm]
// (default module: vendor/wolf_web.wasm at the root of the web workspace).
// For one DOCX, one XLSX and one PPTX fixture (fixtures/<format>/): open, apply one batch known
// to apply, save, record the batch as a review session with the session functions of
// `@wolfsdk/protocol` and validate it against the packaged review-session schema. Prints one JSON
// line per format and exits non-zero on the first failure.
import { readFileSync } from "node:fs";
import {
  KernelRequestError,
  SESSION_CONTRACT,
  entryDecisionDoc,
  hunksOf,
  isoSeconds,
  validateSession,
  type DocFormat,
  type HistoryEntry,
  type Op,
  type SessionExport,
} from "@wolfsdk/protocol";
import { sha256Hex } from "../src/loader.ts";
import { DEFAULT_REACTOR_MODULE_PATH, createNodeReactorKernel } from "../src/reactor/node.ts";

type Case = { format: DocFormat; fixture: string; label: string; ops: Op[] };

// One operation per format that a module built from main accepts, so the smoke holds on a
// release module and not only on a module that carries the editor operations.
const CASES: Case[] = [
  {
    format: "docx",
    fixture: "docx/tiny.docx",
    label: "Replace text",
    ops: [{ op: "replace-text", target: "para:#1A000002", find: "supplier", replace: "vendor" }] as Op[],
  },
  {
    format: "xlsx",
    fixture: "xlsx/names-tables.xlsx",
    label: "Set value",
    ops: [{ op: "set", target: "sheet:Regions/cell:B3", value: { number: 123 } }] as Op[],
  },
  {
    format: "pptx",
    fixture: "pptx/tiny.pptx",
    label: "Replace text",
    ops: [{ op: "replace-text", target: "slide:#256/shape:#2", find: "WolfPPT", replace: "Wolf Review" }] as Op[],
  },
];

const fixtures = new URL("../../../fixtures/", import.meta.url);
const modulePath = process.argv[2] || DEFAULT_REACTOR_MODULE_PATH;
const kernel = createNodeReactorKernel(modulePath);

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(c: Case): Promise<Record<string, unknown>> {
  const name = c.fixture.slice(c.fixture.lastIndexOf("/") + 1);
  const bytes = new Uint8Array(readFileSync(new URL(c.fixture, fixtures)));
  const opened = await kernel.open(bytes, name);
  check(opened.format === c.format, `${c.fixture}: opened as ${opened.format}`);
  check(opened.sha256 === (await sha256Hex(bytes)), `${c.fixture}: revision 0 is not the input`);

  const appliedAt = Date.now();
  const applied = await kernel.apply(opened.doc, c.ops);
  if (!applied.ok) throw new Error(`${c.fixture}: refused: ${JSON.stringify(applied.error)}`);
  const { state } = applied;
  check(state.revision === 1, `${c.fixture}: revision ${state.revision} after one batch`);
  check(state.sha256 !== opened.sha256, `${c.fixture}: the batch changed nothing`);

  const saved = await kernel.save(opened.doc);
  check((await sha256Hex(saved)) === state.sha256, `${c.fixture}: saved bytes differ from the revision`);

  const entry: HistoryEntry = {
    revision: state.revision,
    label: c.label,
    source: "smoke",
    ops: c.ops,
    diff: applied.diff,
    transaction: applied.transaction,
    baseSha256: opened.sha256,
    resultSha256: state.sha256,
    appliedAt,
  };
  const decidedAt = Date.now();
  const session: SessionExport = {
    contract: SESSION_CONTRACT,
    document: { name: state.name, format: state.format },
    original_sha256: opened.sha256,
    final_sha256: state.sha256,
    current_sha256: state.sha256,
    summary: { approve: 1, reject: 0, undecided: 0 },
    complete: true,
    decided_at: isoSeconds(decidedAt),
    entries: [
      {
        revision: entry.revision,
        label: entry.label,
        source: entry.source,
        applied_at: isoSeconds(entry.appliedAt),
        decision: "approve",
        in_history: true,
        base_sha256: entry.baseSha256,
        result_sha256: entry.resultSha256,
        hunks: hunksOf(entry).map((h) => ({
          op: h.op,
          decision: "approve" as const,
          change_indices: [...h.changeIndices],
        })),
        rejected_ops: [],
        review_decision: await entryDecisionDoc({
          entry,
          decision: "approve",
          docName: state.name,
          seen: new Map(),
          decidedAt,
        }),
      },
    ],
    parts: null,
  };
  // Through JSON, as a consumer reads the exported file.
  const problems = validateSession(JSON.parse(JSON.stringify(session)));
  check(problems.length === 0, `${c.fixture}: session export is invalid:\n  ${problems.join("\n  ")}`);
  await kernel.close(opened.doc);

  return {
    format: c.format,
    fixture: c.fixture,
    ops: c.ops.length,
    revision: state.revision,
    saved_bytes: saved.byteLength,
    session_valid: true,
  };
}

let failed = false;
for (const c of CASES) {
  try {
    console.log(JSON.stringify(await run(c)));
  } catch (e) {
    failed = true;
    const reason = e instanceof KernelRequestError ? JSON.stringify(e.error) : e instanceof Error ? e.message : String(e);
    console.error(`FAIL ${c.format} ${c.fixture}: ${reason}`);
    break;
  }
}
process.exit(failed ? 1 : 0);
