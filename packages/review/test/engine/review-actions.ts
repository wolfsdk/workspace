// Check `review-actions`: the review actions of `ReviewStore` against the real engine, per format.
// Ported from the prototype review package's check script (its package-level entry also ran the label,
// recorded-diff and parts checks; here those are the pure unit tests next to `test/review/`, and the
// package gate is the `parts-gate` check).
//
// Flow: apply three recorded batches, check hunks, step, flip, reject the newest, reject only the first
// (and a forced refusal that must restore state), per-hunk decisions and submit gating on a second
// host, manual ops, then export the decision file and validate it.
import { boxesOnPage, changesOf, sideShown, validateSession } from "@wolfsdk/protocol";
import { createEditorHost } from "../../src/host/host.ts";
import { reviewStore } from "../../src/review/store.ts";
import { BASE, baseBytes, createAsserter, sessionBatches, type Asserter, type CheckOutcome, type EngineContext, type Format } from "./harness.ts";

export async function run(ctx: EngineContext, fmt: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const notes: string[] = [];
  const kernel = ctx.kernel();
  const bytes = baseBytes(fmt);
  const batches = sessionBatches(fmt);
  const host = createEditorHost(kernel);
  const store = reviewStore(host);
  await host.open(bytes, BASE[fmt]);
  const original = host.getSnapshot().state!.sha256;
  for (const [i, ops] of batches.slice(0, 3).entries()) {
    const r = await host.apply(ops, { label: `batch ${i + 1}`, source: "check" });
    ok(r.ok, `${fmt}: batch ${i + 1} applies`);
  }
  let snap = host.getSnapshot();
  ok(snap.history.length === 3, `${fmt}: three entries`);
  ok(
    snap.history[0]!.diff.length > 0,
    `${fmt}: first entry has a diff (diffs: ${snap.history.map((e) => e.diff.length)})`,
  );
  // hunks: every change index of an entry belongs to exactly one hunk; one hunk per op
  for (const e of snap.history) {
    const hunks = store.hunks(e);
    const seen = hunks.flatMap((h) => h.changeIndices).sort((x, y) => x - y);
    ok(
      seen.length === changesOf(e).length && seen.every((v, i) => v === i),
      `${fmt}: hunks of ${e.label} cover each change once (${seen.length}/${changesOf(e).length})`,
    );
    ok(
      hunks.filter((h) => h.op !== null).every((h, i) => h.op === i) &&
        hunks.filter((h) => h.op !== null).length === e.ops.length,
      `${fmt}: one hunk per op of ${e.label}`,
    );
  }
  ok(
    store.submitBlockers().some((b) => b.code === "undecided"),
    `${fmt}: undecided blocks submit before any decision`,
  );
  // stepping + overlays
  await store.step(0);
  ok(host.getSnapshot().state!.sha256 === original, `${fmt}: back to original`);
  await store.inspect(snap.history[0]!);
  const e1 = snap.history[0]!;
  let state = host.getSnapshot().state!;
  ok(sideShown(e1, state) === "after", `${fmt}: after side shown`);
  const boxes = state.regions.length ? boxesOnPage(e1, "after", state.regions) : [];
  notes.push(`entry 1 changes=${e1.diff.length}, overlay boxes (all pages)=${boxes.length}`);
  await store.flip();
  state = host.getSnapshot().state!;
  ok(state.revision === 0 && sideShown(e1, state) === "before", `${fmt}: flip to before`);
  await store.flip();
  ok(host.getSnapshot().state!.revision === 1, `${fmt}: flip returns`);
  await store.inspect(snap.history[2]!);
  // reject the newest
  store.approve(snap.history[0]!);
  await store.reject(snap.history[2]!);
  snap = host.getSnapshot();
  ok(
    snap.state!.revision === 2 && snap.state!.sha256 === snap.history[1]!.resultSha256,
    `${fmt}: reject last steps back to entry 2 result sha`,
  );
  ok(snap.history.length === 3, `${fmt}: rejected entry stays in redo tail`);
  ok(store.decisionOf(snap.history[2]!) === "reject", `${fmt}: decision recorded`);
  // reject only the first
  await host.goto(3);
  const before = host.getSnapshot().history.slice();
  await store.reject(before[0]!);
  ok(store.ui.choosing === 1, `${fmt}: reject of older entry asks`);
  const r = await store.rejectOnly(before[0]!);
  snap = host.getSnapshot();
  if (r.ok) {
    notes.push(`reject-only re-applied; revision ${snap.state!.revision}, entries ${snap.history.length}`);
    // Entry 3 was rejected at the end of the chain: it is not re-applied but removed (kept as rejected).
    // History: entry 2 re-applied, then the rejected batch of entry 1 in the redo tail; cursor on entry 2.
    ok(
      snap.history.length === 2 && host.getSnapshot().state!.revision === 1,
      `${fmt}: reject-only leaves entry 2 current and the rejected batch in the redo tail`,
    );
    ok(snap.history[0]!.baseSha256 === original, `${fmt}: first remaining entry starts at original`);
    ok(store.decisionOf(snap.history[1]!) === "reject", `${fmt}: rejected batch marked rejected`);
    ok(
      snap.history[1]!.resultSha256 === before[1]!.resultSha256,
      `${fmt}: commutation probe reproduces the original entry 2 result`,
    );
    const removedLast = store.dropped.find((d) => d.entry.resultSha256 === before[2]!.resultSha256);
    ok(removedLast && store.decisionOf(removedLast.entry) === "reject", `${fmt}: later decision carried over`);
    const removedFirst = store.dropped.find((d) => d.entry.resultSha256 === before[0]!.resultSha256);
    ok(removedFirst && store.decisionOf(removedFirst.entry) === "reject", `${fmt}: rejected entry listed as removed`);
    const log = await kernel.session(snap.state!.doc);
    ok(
      log.batches.length === 1 && JSON.stringify(log.batches[0]!.ops) === JSON.stringify(before[1]!.ops),
      `${fmt}: session holds only the kept entry's ops`,
    );
  } else if (r.reason === "refused") {
    notes.push(`reject-only refused at "${r.failedLabel}" (${r.error.code}); restored=${r.restored}`);
    ok(
      r.restored && snap.history.length === 3 && host.getSnapshot().state!.revision === 3,
      `${fmt}: refusal restores state`,
    );
  } else {
    notes.push(`reject-only coupled (${r.coupled.map((c) => `${c.kind} ${c.revision}/${c.op}`).join(", ")})`);
    ok(
      r.restored && snap.history.length === 3 && host.getSnapshot().state!.revision === 3,
      `${fmt}: coupled refusal restores state`,
    );
    ok(store.ui.coupled?.restored === true, `${fmt}: coupled notice set`);
    ok(
      store.submitBlockers().some((b) => b.code === "coupled"),
      `${fmt}: coupled blocks submit`,
    );
    store.patch({ coupled: null });
  }
  // second host: per-hunk decisions, submit gating, engine refusal of an unknown target
  const host2 = createEditorHost(kernel);
  const store2 = reviewStore(host2);
  await host2.open(bytes, BASE[fmt]);
  const a = await host2.apply(batches[0]!, { label: "first", source: "check" });
  ok(a.ok, `${fmt}: first applies`);
  // per-hunk decisions and submit
  {
    const entry = host2.getSnapshot().history[0]!;
    const hunks = store2.hunks(entry);
    ok(store2.decisionOf(entry) === "pending", `${fmt}: new entry pending`);
    ok(
      store2.submitBlockers().some((x) => x.code === "undecided"),
      `${fmt}: undecided hunk blocks submit`,
    );
    for (const h of hunks.slice(0, -1)) store2.setHunkDecision(entry, h.op, "approve");
    ok(
      hunks.length < 2 || store2.decisionOf(entry) === "pending",
      `${fmt}: entry stays pending while a hunk is undecided`,
    );
    store2.setHunkDecision(entry, hunks.at(-1)!.op, "approve");
    ok(store2.decisionOf(entry) === "approve", `${fmt}: all hunks approved -> entry approved`);
    ok(
      hunks.every((h) => store2.hunkDecisionOf(entry, h.op) === "approve"),
      `${fmt}: hunk decisions approved`,
    );
    store2.setHunkDecision(entry, hunks[0]!.op, "pending");
    ok(store2.decisionOf(entry) === "pending", `${fmt}: clearing one hunk -> entry pending`);
    store2.setHunkDecision(entry, hunks[0]!.op, "approve");
    ok(
      store2
        .submitBlockers()
        .map((x) => x.code)
        .join() === "parts-unchecked",
      `${fmt}: only the parts check blocks once every hunk is approved`,
    );
    await store2.refreshParts();
    for (const f of store2.partsCheck.report?.unexplained ?? []) store2.acknowledgePart(f.name);
    const blockers = store2.submitBlockers();
    ok(blockers.length === 0, `${fmt}: nothing blocks submit at head: ${JSON.stringify(blockers)}`);
    ok((await store2.submit()) === false && !store2.hasSubmitHandler, `${fmt}: submit without handler is false`);
    let calls = 0;
    store2.setSubmitHandler(async () => {
      calls++;
    });
    ok((await store2.submit()) === true && calls === 1, `${fmt}: submit runs the handler once`);
    await host2.goto(0);
    ok(
      store2.submitBlockers().some((x) => x.code === "not-at-head"),
      `${fmt}: not-at-head after stepping back`,
    );
    ok((await store2.submit()) === false && calls === 1, `${fmt}: blocked submit does not call the handler`);
    const early = await store2.buildExport();
    ok(
      early && early.entries.every((e) => e.decision !== "approve" && e.hunks.every((h) => h.decision !== "approve")),
      `${fmt}: entry beyond the cursor is not exported as approved`,
    );
    await host2.goto(1);
    store2.setSubmitHandler(null);
  }
  const b = await host2.apply([{ op: "set", target: "para:~definitely-missing", value: { text: "x" } }], {
    label: "bad",
    source: "check",
    quiet: true,
  });
  ok(!b.ok, `${fmt}: engine refuses unknown target (${b.ok ? "" : b.error.code})`);
  const manual = await store2.applyManual("not json");
  ok(!manual.ok && manual.code === "invalid-json", `${fmt}: manual ops parse error`);
  const manual2 = await store2.applyManual(JSON.stringify([{ op: "set", target: "nope:1", value: { text: "x" } }]));
  ok(!manual2.ok, `${fmt}: manual refusal shows code ${manual2.ok ? "" : manual2.code}`);
  // export
  const doc = await store.buildExport();
  ok(doc, `${fmt}: export builds`);
  ok(doc.original_sha256 === original, `${fmt}: original sha`);
  const listed = doc.entries.filter((e) => e.in_history);
  ok(doc.final_sha256 === (listed.at(-1)?.result_sha256 ?? doc.current_sha256), `${fmt}: final sha`);
  ok(
    doc.entries.every((e) => Array.isArray(e.hunks) && Array.isArray(e.rejected_ops)),
    `${fmt}: export has hunks and rejected_ops`,
  );
  ok(
    doc.entries.every(
      (e) =>
        e.hunks.flatMap((h) => h.change_indices).length === e.review_decision.decisions.length &&
        e.hunks.every((h) => h.change_indices.every((i) => e.review_decision.decisions[i]!.decision === h.decision)),
    ),
    `${fmt}: each change carries its hunk's decision`,
  );
  if (r.ok) {
    const gone = doc.entries.find((e) => !e.in_history && e.result_sha256 === before[0]!.resultSha256);
    ok(
      gone && gone.decision === "reject" && gone.rejected_ops.length === before[0]!.ops.length,
      `${fmt}: removed entry exported with its rejected ops`,
    );
    ok(
      !doc.entries.some((e) => e.in_history && e.decision === "approve" && e.result_sha256 === before[0]!.resultSha256),
      `${fmt}: rejected ops never exported as approved`,
    );
  }
  const problems = validateSession(doc);
  ok(problems.length === 0, `${fmt}: decision file valid: ${problems.join("; ")}`);
  ok(
    doc.entries.every((e) => e.review_decision.diff_identity_verified),
    `${fmt}: diff identities verify`,
  );
  notes.push(`summary ${JSON.stringify(doc.summary)}, entries ${doc.entries.length}`);
  await host.close();
  await host2.close();
  return { checks: ok.count, notes };
}
