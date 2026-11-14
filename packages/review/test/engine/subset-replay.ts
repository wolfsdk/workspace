// Check `subset-replay`: soundness of `ReviewStore.rejectOps` / `rejectOnly` against the real engine, per
// format. Ported from the prototype review package's subset-check script.
//
// Clock: the host kernel runs pinned (clock 2026-01-01T00:00:00Z, zone UTC, locale en-US, seed 0), and
// so does the reference kernel, so reference bytes are comparable with the host's sha256. The live pass
// opens the host kernel with a live clock and proposes batch i of every case at its own explicit clock
// and zone (`proposedAt`: a different day and time per batch, zones alternating UTC and
// America/New_York), so no result depends on wall time or on two batches landing in the same second.
// Its reference replays the kept batches, each with the clock and zone it was proposed at, and the
// kernel session at the cursor must carry those clocks. Every live case must give the same verdict as
// the same case of the pinned pass.
//
// Reference replay: the prototype replayed the kept session with a separate command-module tool (and,
// with `--native`, on a worker host). Here the reference is an in-process replay on a SECOND kernel on
// the same module: open the base file, `apply` the kept batches in order (live pass: each with its
// proposal clock and zone), `save`, sha256 of the saved bytes. It shares no state with the host, the
// store or the history; the host's chain is compared with it batch by batch and at the end.
//
// Part A, drop-each-op matrix over fixtures/<fmt>/sessions/session-20.json (all 20 batches): for every
// batch b with two or more ops and every op i, a fresh host applies batches 0..b and calls
// rejectOps(entry b, [i]); for every b >= 1 a fresh host applies 0..b and calls rejectOnly(entry b-1).
// Verdict: independent (ok), coupled, or refused.
//   independent: the host sha256 equals the reference replay of the kept session (bytes saved from the
//     host too), every kept batch's result sha256 equals the reference's, the kernel session log equals
//     the kept session, hunk decisions follow the reset rule (below), and submitBlockers() has no
//     `not-at-head`.
//   coupled / refused: `restored` is true (and `ui.coupled.restored` for coupled) and the chain
//     (resultSha256 list, cursor) is unchanged.
// Reset rule: every hunk is approved before the call; after ok, a kept hunk (old op index mapped to the
// new one, later entries by position) stays `approve` only when (a) its change records (canonical JSON
// of each change without `cause`, in order) are unchanged and (b), for the replacement and every
// re-applied later entry, the view node (`host.node(address)`) of every address its changes name is
// unchanged between the original final revision and the new current revision; else it is `pending` and
// submitBlockers() contains `undecided`. Entries before the target are not re-applied, so only (a)
// applies to them. Resets are counted by reason: records (a), else state (b).
//
// Part B, seeded cases and controls (`subset-replay-cases.ts`): each applies in full on the one pinned
// module (the prototype probed them against a capped build of it). The engine finding about XLSX
// in-batch resolution is kept there as an informational case. Three controls are added in the port
// (a kept comment, a kept tracked change, a kept NOW()): the prototype's time-stamp controls reject
// the time-stamped op, so their kept session carries no time stamp and the live reference replay was
// never sensitive to the per-batch clocks (checked here by replaying the reference without them: only
// these three cases, in the live pass, then fail).
//
// Part C of the prototype (`--native`: replay one matrix case per format and every control with the
// native binary on a worker host over ssh) is not portable and is reported as a skipped part.
//
// Time budget: the pinned pass always runs the full matrix. The live pass costs about as much as the
// pinned one (measured on the development machine, pinned / live seconds: docx 32.5 / 27.0, pptx
// 303.8 / 292.2, xlsx 3.7 / 3.6). When twice the measured pinned time exceeds `LIVE_BUDGET_MS` (four
// minutes), the live pass runs the matrix over the first `LIVE_RESTRICTED_BATCHES` batches and all of
// Part B, and says so in the `timing` note and as a skipped part; otherwise it covers every batch.
import { createHash } from "node:crypto";
import { canonical, changesOf } from "@wolfsdk/protocol";
import type { BatchEnvironment, Op } from "@wolfsdk/protocol";
import type { ReactorEngineKernel } from "@wolfsdk/runtime/node";
import { createEditorHost } from "../../src/host/host.ts";
import type { EditorHost, HistoryEntry } from "../../src/host/index.ts";
import { reviewStore } from "../../src/review/store.ts";
import type { ReviewStore } from "../../src/review/store.ts";
import { BASE, CheckFailure, baseBytes, createAsserter, sessionBatches } from "./harness.ts";
import type { Asserter, CheckOutcome, EngineContext, Format } from "./harness.ts";
import { SEEDS } from "./subset-replay-cases.ts";
import type { Action, Seed } from "./subset-replay-cases.ts";

type Mode = "pinned" | "live";
type Verdict = "independent" | "coupled" | "refused";

type CaseResult = {
  mode: Mode;
  part: "matrix" | "seeded";
  name: string;
  action: "reject-ops" | "reject-only";
  batch: number;
  op: number | null;
  verdict: Verdict | null;
  couplingKinds: string[];
  /** Kept hunks reset to pending: by changed records, and by changed view nodes only. */
  resetRecords: number;
  resetState: number;
  ms: number;
  failure: string | null;
};

/** Everything one pass (pinned or live) shares. */
type Pass = {
  ok: Asserter;
  mode: Mode;
  format: Format;
  /** Base file of the format and its file name. */
  original: Uint8Array;
  name: string;
  /** Kernel the hosts run on: pinned, or (live pass) a live-clock kernel. */
  kernel: ReactorEngineKernel;
  /** Second, pinned kernel that replays the kept batches independently of host and store. */
  ref: ReactorEngineKernel;
  log: (message: string) => void;
};

/** Time budget for the pinned and the live pass of one format together, in milliseconds. */
const LIVE_BUDGET_MS = 240_000;
/** Leading session batches the live matrix covers when the budget would be exceeded. */
const LIVE_RESTRICTED_BATCHES = 5;

/** Live pass: the clock and zone batch `i` of a case is proposed at, distinct for every `i`. */
const proposedAt = (i: number): BatchEnvironment => ({
  clock: new Date(Date.UTC(2026, 2, 2 + i, 8 + (i % 9), (13 * i) % 60, (7 * i) % 60)).toISOString().replace(".000Z", "Z"),
  timezone: i % 2 ? "America/New_York" : "UTC",
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const records = (entry: HistoryEntry, op: number | null): string[] =>
  changesOf(entry)
    .filter((c) => (op === null ? c.cause == null : c.cause === op))
    .map((c) => {
      const { cause: _cause, ...rest } = c;
      return canonical(rest);
    });

/** Independent replay of `batches` on the reference kernel (batch i with `ats[i]`): the sha256 of the
 * saved bytes and the result sha256 after every batch. */
async function reference(
  p: Pass,
  label: string,
  batches: Op[][],
  ats: (BatchEnvironment | undefined)[],
): Promise<{ sha: string; steps: string[] }> {
  const ok: Asserter = p.ok;
  const ref = p.ref;
  const opened = await ref.open(p.original, p.name);
  try {
    let state = opened;
    const steps: string[] = [];
    for (const [i, ops] of batches.entries()) {
      const r = await ref.apply(state.doc, ops, ats[i]);
      ok(r.ok, `${label}: reference replay of batch ${i + 1} applies${r.ok ? "" : ` (${r.error.code} ${r.error.message})`}`);
      state = r.state;
      steps.push(r.state.sha256);
    }
    const sha = sha256(await ref.save(state.doc));
    ok(sha === state.sha256, `${label}: reference saved bytes ${sha} equal its reported sha256 ${state.sha256}`);
    return { sha, steps };
  } finally {
    await ref.close(opened.doc);
  }
}

type Reset = { records: number; state: number };
type Pair = { before: HistoryEntry; after: HistoryEntry; opOf: (newOp: number) => number; reapplied: boolean };

/** Expected decisions after a successful reject; counts the hunks reset to pending by reason. */
function checkDecisions(
  ok: Asserter,
  host: EditorHost,
  store: ReviewStore,
  label: string,
  pairs: Pair[],
  nodesBefore: Map<string, string>,
): Reset {
  const reset: Reset = { records: 0, state: 0 };
  for (const { before, after, opOf, reapplied } of pairs) {
    const changes = changesOf(after);
    for (const h of store.hunks(after)) {
      const now = records(after, h.op);
      const was = records(before, h.op === null ? null : opOf(h.op));
      const sameRecords = now.length === was.length && now.every((x, i) => x === was[i]);
      // Entries before the target are not re-applied: their revision is unchanged, and a view
      // node differing at the new head only reflects the rejected edit itself.
      const sameState =
        !reapplied ||
        h.changeIndices.every((i) => {
          const address = changes[i]!.address;
          return nodesBefore.get(address) === canonical(host.node(address) ?? null);
        });
      const expected = sameRecords && sameState ? "approve" : "pending";
      if (!sameRecords) reset.records++;
      else if (!sameState) reset.state++;
      const got = store.hunkDecisionOf(after, h.op);
      ok(
        got === expected,
        `${label}: hunk ${after.revision}/${h.op ?? "none"} is ${expected} (records ${sameRecords ? "same" : "changed"}, state ${sameState ? "same" : "changed"}), got ${got}`,
      );
    }
  }
  const blockers = store.submitBlockers().map((b) => b.code);
  const pending = reset.records + reset.state > 0;
  ok(blockers.includes("undecided") === pending, `${label}: submitBlockers ${pending ? "include" : "exclude"} undecided`);
  ok(!blockers.includes("not-at-head"), `${label}: submitBlockers exclude not-at-head after the reject`);
  return reset;
}

type Run = {
  verdict: Verdict;
  kinds: string[];
  reset: Reset;
  keptHunk: (op: number | null) => string;
};

/** Fresh host: open, apply `batches` (one entry each), approve everything, run `action`, check. */
async function runCase(p: Pass, label: string, batches: Op[][], action: Action): Promise<Run> {
  const ok: Asserter = p.ok;
  const host: EditorHost = createEditorHost(p.kernel);
  const store = reviewStore(host);
  try {
    await host.open(p.original, p.name);
    const ats = batches.map((_, i) => (p.mode === "live" ? proposedAt(i) : undefined));
    for (const [i, ops] of batches.entries()) {
      const r = await host.apply(ops, { label: `batch ${i + 1}`, source: "subset-replay", at: ats[i] });
      ok(r.ok, `${label}: batch ${i + 1} applies${r.ok ? "" : ` (${r.error.code} ${r.error.message})`}`);
    }
    const history = host.getSnapshot().history.slice();
    ok(history.length === batches.length, `${label}: ${batches.length} entries`);
    for (const e of history) store.setDecision(e, "approve");
    const shas = history.map((e) => e.resultSha256);
    const cursor = host.getSnapshot().state!.revision;
    // View nodes at the original final revision of every address any entry's changes name.
    const nodesBefore = new Map<string, string>();
    for (const e of history)
      for (const c of changesOf(e)) nodesBefore.set(c.address, canonical(host.node(c.address) ?? null));
    const target = history[action.entry]!;
    const r = action.kind === "ops" ? await store.rejectOps(target, action.ops) : await store.rejectOnly(target);
    const snap = host.getSnapshot();
    if (!r.ok) {
      const coupled = r.reason === "coupled";
      const kinds = r.reason === "coupled" ? [...new Set(r.coupled.map((c) => c.kind))].sort() : [];
      ok(r.restored, `${label}: ${coupled ? "coupled" : "refused"} result reports restored`);
      ok(
        snap.history.length === shas.length && snap.history.every((e, i) => e.resultSha256 === shas[i]),
        `${label}: chain restored`,
      );
      ok(snap.state!.revision === cursor, `${label}: cursor restored (${snap.state!.revision} vs ${cursor})`);
      if (r.reason === "coupled") {
        ok(r.coupled.length > 0, `${label}: coupled result names at least one coupling`);
        ok(store.ui.coupled?.revision === target.revision, `${label}: ui.coupled names revision ${target.revision}`);
        ok(store.ui.coupled?.restored === true, `${label}: ui.coupled.restored is true`);
        ok(
          !kinds.includes("unverifiable"),
          `${label}: no coupling is unverifiable (${r.coupled.map((c) => c.detail).join(" | ")})`,
        );
      }
      return { verdict: coupled ? "coupled" : "refused", kinds, reset: { records: 0, state: 0 }, keptHunk: () => "n/a" };
    }
    // Independent: compare with the reference replay of the kept session (live pass: with the proposal
    // clocks). Entries up to the cursor are the kept chain; the rejected ops stay beyond it as a
    // redo-tail entry decided `reject`.
    const head = snap.state!.revision;
    const chain = snap.history.filter((e) => e.revision <= head);
    for (const e of snap.history.filter((e) => e.revision > head))
      ok(store.decisionOf(e) === "reject", `${label}: redo-tail entry ${e.revision} "${e.label}" is rejected`);
    const kept: Op[][] = [...batches.slice(0, action.entry), ...batches.slice(action.entry + 1)];
    let keptAt: (BatchEnvironment | undefined)[];
    let pairs: Pair[];
    if (action.kind === "ops") {
      const keptIdx = target.ops.map((_, i) => i).filter((i) => !action.ops.includes(i));
      const keptOps = keptIdx.map((i) => target.ops[i]!);
      kept.splice(action.entry, 0, keptOps);
      keptAt = ats;
      ok(chain.length === history.length, `${label}: kept entry count unchanged (${chain.length} vs ${history.length})`);
      const replacement = ("entry" in r ? r.entry : null) as HistoryEntry | null;
      ok(replacement, `${label}: replacement entry present`);
      ok(JSON.stringify(replacement.ops) === JSON.stringify(keptOps), `${label}: replacement ops equal kept ops`);
      ok(chain[action.entry] === replacement, `${label}: replacement entry is at the target's position`);
      pairs = chain.map((after, i) => ({
        before: history[i]!,
        after,
        opOf: i === action.entry ? (j: number) => keptIdx[j]! : (j: number) => j,
        reapplied: i >= action.entry,
      }));
    } else {
      keptAt = ats.filter((_, i) => i !== action.entry);
      ok(chain.length === history.length - 1, `${label}: one kept entry fewer (${chain.length} vs ${history.length})`);
      ok(head === cursor - 1, `${label}: cursor one revision back (${head} vs ${cursor})`);
      pairs = chain.map((after, i) => ({
        before: history[i < action.entry ? i : i + 1]!,
        after,
        opOf: (j: number) => j,
        reapplied: i >= action.entry,
      }));
      for (const [i, e] of chain.entries())
        ok(JSON.stringify(e.ops) === JSON.stringify(kept[i]), `${label}: entry ${i + 1} ops equal kept batch`);
    }
    const ref = await reference(p, label, kept, keptAt);
    ok(
      ref.sha === snap.state!.sha256,
      `${label}: host sha ${snap.state!.sha256} equals ${p.mode} reference replay ${ref.sha}`,
    );
    const hostSaved = sha256(await host.save());
    ok(hostSaved === ref.sha, `${label}: host saved bytes ${hostSaved} equal ${p.mode} reference replay ${ref.sha}`);
    const log = await host.kernel.session(snap.state!.doc);
    const session = log.batches.slice(0, head);
    const logged = session.map((b) => JSON.stringify(b.ops));
    ok(
      logged.length === kept.length && logged.every((b, i) => b === JSON.stringify(kept[i])),
      `${label}: kernel session at the cursor equals the kept session`,
    );
    ok(
      session.length === ref.steps.length && session.every((b, i) => b.resultSha256 === ref.steps[i]),
      `${label}: kernel session result sha256 of every kept batch equals the reference replay's`,
    );
    if (p.mode === "live")
      for (const [i, b] of session.entries()) {
        const want = keptAt[i]!;
        const got = { clock: b.clock ?? log.clock, timezone: b.timezone ?? log.timezone };
        ok(
          got.clock === want.clock && got.timezone === want.timezone,
          `${label}: kept batch ${i + 1} ran at ${want.clock} ${want.timezone}, got ${got.clock} ${got.timezone}`,
        );
      }
    // None of the rejected ops at the target position (unless a kept op is the same op).
    const atTarget = new Set((log.batches[action.entry]?.ops ?? []).map((o) => JSON.stringify(o)));
    const keptAtTarget = new Set((kept[action.entry] ?? []).map((o) => JSON.stringify(o)));
    const rejectedIdx = action.kind === "ops" ? action.ops : target.ops.map((_, i) => i);
    for (const i of rejectedIdx) {
      const rejected = JSON.stringify(target.ops[i]);
      if (!keptAtTarget.has(rejected))
        ok(!atTarget.has(rejected), `${label}: session batch ${action.entry + 1} lacks rejected op ${i}`);
    }
    const reset = checkDecisions(ok, host, store, label, pairs, nodesBefore);
    const entryAfter = chain[Math.min(action.entry, chain.length - 1)]!;
    return { verdict: "independent", kinds: [], reset, keptHunk: (op) => store.hunkDecisionOf(entryAfter, op) };
  } finally {
    await host.close();
  }
}

/** Runs one case; a failure is recorded on the result (and reported by the caller), not thrown. */
async function record(
  p: Pass,
  part: "matrix" | "seeded",
  name: string,
  batches: Op[][],
  action: Action,
  check: (run: Run) => void,
): Promise<CaseResult> {
  const started = performance.now();
  const result: CaseResult = {
    mode: p.mode,
    part,
    name,
    action: action.kind === "ops" ? "reject-ops" : "reject-only",
    batch: action.entry,
    op: action.kind === "ops" ? action.ops[0]! : null,
    verdict: null,
    couplingKinds: [],
    resetRecords: 0,
    resetState: 0,
    ms: 0,
    failure: null,
  };
  try {
    const run = await runCase(p, `${p.format} ${p.mode} ${name}`, batches, action);
    Object.assign(result, {
      verdict: run.verdict,
      couplingKinds: run.kinds,
      resetRecords: run.reset.records,
      resetState: run.reset.state,
    });
    check(run);
  } catch (e) {
    result.failure = (e instanceof Error ? e.message : String(e)).replace(/^FAIL: /, "");
    p.log(`  ${p.format} ${p.mode} ${name}: FAILED ${result.failure}`);
  }
  result.ms = Math.round(performance.now() - started);
  return result;
}

/** Part A over the first `batchLimit` session batches, then Part B for the format. */
async function runPass(p: Pass, session: Op[][], seeds: Seed[], batchLimit: number): Promise<CaseResult[]> {
  const ok: Asserter = p.ok;
  const results: CaseResult[] = [];
  const batches = session.slice(0, batchLimit);
  for (const [b, ops] of batches.entries()) {
    if (ops.length < 2) continue;
    for (let i = 0; i < ops.length; i++)
      results.push(
        await record(p, "matrix", `batch ${b + 1} drop op ${i}`, batches.slice(0, b + 1), { kind: "ops", entry: b, ops: [i] }, () => {}),
      );
  }
  for (let b = 1; b < batches.length; b++)
    results.push(
      await record(p, "matrix", `batch ${b + 1} reject-only batch ${b}`, batches.slice(0, b + 1), { kind: "only", entry: b - 1 }, () => {}),
    );
  for (const seed of seeds)
    results.push(
      await record(p, "seeded", seed.name, seed.batches, seed.action, (run) => {
        const label = `${seed.fmt} ${p.mode} ${seed.name}`;
        if (seed.expect === "coupled-or-refused")
          ok(run.verdict !== "independent", `${label}: must be coupled or refused, got ${run.verdict}`);
        if (seed.expect === "independent") ok(run.verdict === "independent", `${label}: must be ok, got ${run.verdict}`);
        if (seed.control) ok(run.reset.records + run.reset.state === 0, `${label}: control keeps every kept hunk approved`);
        if (seed.keptHunk) {
          const got = run.keptHunk(seed.keptHunk.op);
          ok(
            got === seed.keptHunk.decision,
            `${label}: kept hunk ${seed.keptHunk.op} is ${seed.keptHunk.decision}, got ${got}`,
          );
        }
      }),
    );
  return results;
}

/** Verdict counts of the matrix rows of one pass. */
type Tally = {
  cases: number;
  independent: number;
  coupled: number;
  coupledRefused: number;
  coupledDiffers: number;
  coupledUnverifiable: number;
  refused: number;
  resetCases: number;
  resetRecords: number;
  resetState: number;
  failed: number;
};

function tally(rows: CaseResult[]): Tally {
  const coupled = rows.filter((r) => r.verdict === "coupled");
  const by = (kind: string) => coupled.filter((r) => r.couplingKinds.includes(kind)).length;
  return {
    cases: rows.length,
    independent: rows.filter((r) => r.verdict === "independent").length,
    coupled: coupled.length,
    coupledRefused: by("refused"),
    coupledDiffers: by("differs"),
    coupledUnverifiable: by("unverifiable"),
    refused: rows.filter((r) => r.verdict === "refused").length,
    resetCases: rows.filter((r) => r.resetRecords + r.resetState > 0).length,
    resetRecords: rows.reduce((n, r) => n + r.resetRecords, 0),
    resetState: rows.reduce((n, r) => n + r.resetState, 0),
    failed: rows.filter((r) => r.failure).length,
  };
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

function tallyLine(mode: Mode, t: Tally, batches: number, ms: number): string {
  return `${mode} matrix: ${t.cases} cases over ${batches} batches: independent ${t.independent}, coupled ${t.coupled} (refused ${t.coupledRefused}/differs ${t.coupledDiffers}/unverifiable ${t.coupledUnverifiable}), refused ${t.refused}, reset cases ${t.resetCases} (hunks records ${t.resetRecords}/state ${t.resetState}), ${seconds(ms)} s with Part B`;
}

export async function run(ctx: EngineContext, format: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const notes: string[] = [];
  const session = sessionBatches(format);
  const seeds = SEEDS.filter((s) => s.fmt === format);
  const original = baseBytes(format);
  // One kernel per role for the whole run: the pinned host kernel, the live-clock host kernel, and the
  // pinned reference kernel both passes replay on.
  const ref = ctx.kernel();
  const common = { ok, format, original, name: BASE[format], ref, log: ctx.log };
  const pinned: Pass = { ...common, mode: "pinned", kernel: ctx.kernel() };
  const live: Pass = {
    ...common,
    mode: "live",
    kernel: ctx.kernel({ environment: { clock: "live", timezone: "UTC", locale: "en-US", seed: 0 } }),
  };

  ctx.log(`subset-replay ${format}: pinned pass (${session.length} batches)`);
  let started = performance.now();
  const pinnedResults = await runPass(pinned, session, seeds, session.length);
  const pinnedMs = performance.now() - started;

  // Measured rule: a live pass costs about what the pinned pass did (docx 32.5 s / 27.0 s, pptx 303.8 s /
  // 292.2 s, xlsx 3.7 s / 3.6 s on the development machine). When both would exceed the budget, the live
  // matrix covers only the first `LIVE_RESTRICTED_BATCHES` batches (Part B always runs in full).
  const restricted = 2 * pinnedMs > LIVE_BUDGET_MS;
  const liveBatches = restricted ? Math.min(session.length, LIVE_RESTRICTED_BATCHES) : session.length;
  ctx.log(`subset-replay ${format}: live pass (${liveBatches} batches, pinned took ${seconds(pinnedMs)} s)`);
  started = performance.now();
  const liveResults = await runPass(live, session, seeds, liveBatches);
  const liveMs = performance.now() - started;

  // Every live case must give the verdict of the same case of the pinned pass.
  const pinnedBy = new Map(pinnedResults.map((r) => [`${r.part}|${r.name}`, r]));
  const drift: string[] = [];
  for (const r of liveResults) {
    const twin = pinnedBy.get(`${r.part}|${r.name}`);
    ok(twin, `${format} live ${r.name}: the pinned pass ran the same case`);
    if (r.failure || twin.failure) continue;
    ok(r.verdict === twin.verdict, `${format} ${r.name}: live verdict ${r.verdict} equals pinned verdict ${twin.verdict}`);
    const same =
      r.couplingKinds.join() === twin.couplingKinds.join() && r.resetRecords === twin.resetRecords && r.resetState === twin.resetState;
    if (!same)
      drift.push(
        `${r.name}: live ${r.couplingKinds.join("+") || "-"} reset ${r.resetRecords}/${r.resetState}, pinned ${twin.couplingKinds.join("+") || "-"} reset ${twin.resetRecords}/${twin.resetState}`,
      );
  }

  const matrix = (rows: CaseResult[]) => rows.filter((r) => r.part === "matrix");
  const seeded = (rows: CaseResult[]) => rows.filter((r) => r.part === "seeded");
  const pinnedTally = tally(matrix(pinnedResults));
  const liveTally = tally(matrix(liveResults));
  notes.push(tallyLine("pinned", pinnedTally, session.length, pinnedMs));
  notes.push(tallyLine("live", liveTally, liveBatches, liveMs));
  notes.push(
    `timing: pinned ${seconds(pinnedMs)} s + live ${seconds(liveMs)} s = ${seconds(pinnedMs + liveMs)} s (budget ${LIVE_BUDGET_MS / 1000} s for the pair); ${
      restricted
        ? `live pass RESTRICTED to the first ${liveBatches} of ${session.length} batches plus all ${seeds.length} seeded cases (a full live pass was estimated at the pinned pass's ${seconds(pinnedMs)} s, ${seconds(2 * pinnedMs)} s for the pair)`
        : `live pass covers all ${session.length} batches and all ${seeds.length} seeded cases`
    }`,
  );
  notes.push(
    drift.length
      ? `live differs from pinned beyond the verdict in ${drift.length} cases (coupling kinds or reset counts): ${drift.join("; ")}`
      : `live and pinned agree on verdict, coupling kinds and reset counts in all ${liveResults.length} live cases`,
  );
  const seededPinned = seeded(pinnedResults);
  const seededLive = seeded(liveResults);
  const verdictOf = (rows: CaseResult[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.verdict ?? "error", (counts.get(r.verdict ?? "error") ?? 0) + 1);
    return [...counts].map(([v, n]) => `${v} ${n}`).join(", ") || "none";
  };
  notes.push(
    `seeded cases (${seeds.length}): pinned ${verdictOf(seededPinned)}; live ${verdictOf(seededLive)}; controls ${seeds.filter((s) => s.control).length} keep every kept hunk approved`,
  );
  for (const seed of seeds.filter((s) => s.expect === "any")) {
    const verdicts = [...seededPinned, ...seededLive].filter((r) => r.name === seed.name).map((r) => `${r.mode} ${r.verdict ?? "error"}`);
    notes.push(`informational case "${seed.name}": ${verdicts.join(", ")} (any verdict accepted; an ok verdict matched the reference)`);
  }

  const failed = [...pinnedResults, ...liveResults].filter((r) => r.failure);
  if (failed.length) {
    const total = pinnedResults.length + liveResults.length;
    throw new CheckFailure(
      `${format}: ${failed.length} of ${total} subset-replay cases failed (${ok.count} assertions passed); first: ${failed
        .slice(0, 3)
        .map((r) => `[${r.mode} ${r.name}] ${r.failure}`)
        .join(" | ")}`,
    );
  }

  const row = (r: CaseResult) => ({
    mode: r.mode,
    part: r.part,
    name: r.name,
    action: r.action,
    batch: r.batch,
    op: r.op,
    verdict: r.verdict,
    couplingKinds: r.couplingKinds,
    resetRecords: r.resetRecords,
    resetState: r.resetState,
    ms: r.ms,
  });
  return {
    checks: ok.count,
    notes,
    skipped: [
      {
        part: "native-replay",
        reason: "needs ssh access to a worker host and native-replay.sh, neither is part of this workspace",
      },
      ...(restricted
        ? [
            {
              part: `live-matrix-batches-${liveBatches + 1}-${session.length}`,
              reason: `a full live pass was estimated at ${seconds(pinnedMs)} s (the pinned pass's time), over the ${LIVE_BUDGET_MS / 1000} s budget for both passes; the live matrix covers batches 1-${liveBatches} and every seeded case`,
            },
          ]
        : []),
    ],
    data: {
      format,
      batches: session.length,
      liveBatches,
      liveRestricted: restricted,
      pinned: { ...pinnedTally, seconds: Number(seconds(pinnedMs)) },
      live: { ...liveTally, seconds: Number(seconds(liveMs)) },
      liveDriftCases: drift.length,
      seeded: [...seededPinned, ...seededLive].map(row),
      cases: [...matrix(pinnedResults), ...matrix(liveResults)].map(row),
    },
  };
}
