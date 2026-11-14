// Check `submission`: the review submit path end to end without a browser. Real `ReviewStore` output is
// verified by the verifier in `submission-verify.ts` (replay of the submitted session on a second kernel),
// then tampered with, and every tampered copy must be rejected naming the expected verifier check.
// Ported from the prototype review package's submission-check script; the proposals are in
// `submission-proposals.ts`.
//
// Per proposal of the format, each scenario runs on a fresh host opened the way the embed opens a review:
// store mode "review", a submit handler, `host.open(base)`, then `host.apply(batch, { source: "proposal",
// label })` per batch. The submit handler builds what the embed's submit handler puts in its event
// (`bytes`, `sha256`, `name`, the kernel's `session`, the store's `buildExport()` decision) plus the
// `proposal` id the page posts. Every submit first runs the package parts check and acknowledges each
// unexplained part through `acknowledgePart`; the first submit that has one is also shown blocked until then.
//   A approve every hunk; Submit is free; verified.
//   B (session proposals; xlsx-repeated: its one batch of two identical ops; xlsx-dated) approve all,
//     `rejectOps` one op (tried in order; coupled or refused ones recorded, each must restore), approve the
//     rest; verified, and its sha256 differs from A (the same as A for xlsx-repeated).
//   C (session proposals) `rejectOnly` a middle batch (tried from the middle out; refusals recorded),
//     approve the rest; verified.
//   D (xlsx-dependent) `rejectOnly(entry 1)` is refused as coupled and restored, sha256 unchanged,
//     `ui.coupled` set; approving both clears it and the submission verifies.
//   E `rejectWithAfter(entry 1)`; records whether Submit is free; if so verified as the base file.
// Tampering on each session B submission (must be rejected, naming the check): a flipped byte
// (bytes-sha256); the rejected op put back, with A's session, bytes and sha256 so only the decision
// disagrees (rejected-absent); a `rejected_ops` entry deleted (rejected-absent); on C the removed entry's
// decision flipped to approve (rejected-absent). On the xlsx B submission, hand-built `decision.parts`
// members: acknowledged (verified), unacknowledged and checked on another sha256 (rejected on
// parts-acknowledged), null (rejected), absent (skipped). Clock tampering on each session B submission:
// batch 1's clock made malformed and its zone made unknown (rejected on wasm-replay by the verifier's own
// plan checks, before any replay); on the xlsx-dated B submission batch 1's clock moved by a day (its
// TODAY() cache no longer replays: rejected on wasm-replay). Every verification runs as the server does
// (by proposal id, against the verifier's own copy of base and proposal) and, for comparison, without
// the proposal (the ad hoc form).
// Server path: the bodies of a few scenarios are posted in-process through `postSubmission` (the demo
// server's request handling without its transport), plus an unknown and a missing proposal id.
// Modes: pinned (the kernel's pinned clock) and live (a live-clock kernel, batch i of every proposal
// proposed at its own explicit clock and zone, alternating UTC and America/New_York, so every submission
// carries per-batch clocks; the session of A, B and C must record each kept batch at the clock it was
// proposed at; xlsx-dated is also reviewed once at wall-clock time). The same scenarios must give the same
// verdicts in both modes.
import { SESSION_CONTRACT, canonical, validateSession } from "@wolfsdk/protocol";
import type { BatchEnvironment, Op, SessionExport, SessionLog } from "@wolfsdk/protocol";
import { basename } from "node:path";
import { createEditorHost } from "../../src/host/host.ts";
import type { EditorHost, HistoryEntry } from "../../src/host/index.ts";
import { reviewStore } from "../../src/review/store.ts";
import type { ReviewStore } from "../../src/review/store.ts";
import {
  createAsserter,
  fixtureBytes,
  type Asserter,
  type CheckOutcome,
  type EngineContext,
  type Format,
  type SkippedPart,
} from "./harness.ts";
import { MULTI_OP_REVISION, allProposals, proposalsFor, type Batch, type Proposal } from "./submission-proposals.ts";
import { postSubmission, verifyProposalSubmission, verifySubmission, type ProposalEnv, type Verdict } from "./submission-verify.ts";

/** The page's POST body. */
type Body = {
  proposal: string;
  name: string;
  sha256: string;
  session: SessionLog;
  decision: SessionExport;
  bytes: string;
};
/** A body as posted, possibly with a hand-edited decision. */
type Posted = Omit<Body, "decision"> & { decision: unknown };
type Parts = NonNullable<SessionExport["parts"]>;

type Row = {
  proposal: string;
  scenario: string;
  expected: "verified" | "rejected";
  verdict: string;
  verdictWithoutProposal: string;
  failed: string[];
  submittedSha256: string;
  replaySha256: string | null;
  note: string;
};
type PostRow = { case: string; expected: string; verdict: string; failed: string[] };

type State = {
  ok: Asserter;
  note: (line: string) => void;
  ctx: EngineContext;
  format: Format;
  proposals: Proposal[];
  env: ProposalEnv;
};

/** Live mode: the clock and zone batch `i` of a proposal is proposed at, distinct for every `i`. */
const proposedAt = (i: number): Required<BatchEnvironment> => ({
  clock: new Date(Date.UTC(2026, 2, 2 + i, 8 + (i % 9), (13 * i) % 60, (7 * i) % 60)).toISOString().replace(".000Z", "Z"),
  timezone: i % 2 ? "America/New_York" : "UTC",
});
/** Clock and zone each batch of `session` ran with (its own, else the session's). */
const clocksOf = (session: SessionLog) =>
  session.batches.map((b) => ({ clock: b.clock ?? session.clock, timezone: b.timezone ?? session.timezone }));

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 12) : "-");
const fields = (b: Posted) => ({ name: b.name, sha256: b.sha256, session: b.session, bytes: b.bytes, decision: b.decision });

export async function run(ctx: EngineContext, format: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const notes: string[] = [];
  const state: State = {
    ok,
    note: (line) => {
      if (!notes.includes(line)) notes.push(line);
    },
    ctx,
    format,
    proposals: proposalsFor(format),
    // The verifier replays on a second pinned kernel: every batch it replays carries its own explicit clock.
    env: { kernel: ctx.kernel(), cache: { runs: new Map(), requested: 0 }, known: allProposals(), baseBytes: fixtureBytes },
  };
  const pinned = await review(state, false);
  const live = await review(state, true);
  const skipped: SkippedPart[] = [
    { part: "demo-server", reason: "no review demo server exists in this workspace" },
    {
      part: "native-replay",
      reason: "needs ssh access to a worker host and native-replay.sh, neither is part of this workspace",
    },
  ];
  if (!pinned.blockedShown && !live.blockedShown)
    skipped.push({
      part: "blocked-submit",
      reason: `no ${format} scenario produced an unexplained part, so there was nothing to block Submit on`,
    });
  for (const [mode, m] of [
    ["pinned", pinned],
    ["live", live],
  ] as const)
    notes.push(
      `${mode}: ${m.documents} store documents validated against ${SESSION_CONTRACT}, ${m.rows.length} verifications in ${(m.ms / 1000).toFixed(1)}s (${m.verified} verified, ${m.tamperRejected} tampered copies rejected on ${[...new Set(m.tamper.flatMap((t) => t.failed))].join(", ")}), ${m.post.length} in-process posts`,
    );
  notes.push(
    `verifier: ${state.env.cache.requested} wasm-replay checks reached a replay, ${state.env.cache.runs.size} distinct replays ran on a second pinned kernel (a session verified again with only its decision, bytes or ad hoc form changed is replayed once; every check still compares with its own sha256)`,
  );
  return {
    checks: ok.count,
    notes,
    skipped,
    data: {
      format,
      replay: {
        kernel: "second pinned reactor kernel, each batch at its own clock and zone",
        requested: state.env.cache.requested,
        distinct: state.env.cache.runs.size,
      },
      modes: { pinned, live },
    },
  };
}

type ModeResult = {
  ms: number;
  /** Some scenario produced an unexplained part and was shown blocked until it was acknowledged. */
  blockedShown: boolean;
  documents: number;
  /** Verifications whose expected verdict was `verified`. */
  verified: number;
  tamperRejected: number;
  rows: Row[];
  /** The tampered copies, each with the verifier checks that rejected it. */
  tamper: { proposal: string; scenario: string; failed: string[] }[];
  post: PostRow[];
};

/** All scenarios of `state.proposals` in one mode: pinned (`live` false) or live. */
async function review(state: State, live: boolean): Promise<ModeResult> {
  const { note, ctx, format, env } = state;
  const ok: Asserter = state.ok;
  const started = Date.now();
  const kernel = ctx.kernel(live ? { environment: { clock: "live" } } : undefined);
  const rows: Row[] = [];
  /** Bodies kept for the in-process post cases. */
  const forPost = new Map<string, Body>();
  /** The parts finding summary of each submitted body, for its result row. */
  const partsNotes = new WeakMap<object, string>();
  let blockedShown = false;
  /** Submission documents the store produced, each validated against the session schema. */
  let documents = 0;
  const mode = live ? "live" : "pinned";

  type Opened = { host: EditorHost; store: ReviewStore; baseSha256: string; taken: () => Body | null };
  /** A fresh host opened the way the embed opens a review. In live mode each batch runs at
   * `proposedAt(i)` unless `wall` (then at the kernel's live clock). */
  async function openReview(p: Proposal, wall = false): Promise<Opened> {
    const host = createEditorHost(kernel);
    const store = reviewStore(host);
    store.setMode("review");
    const name = basename(p.base);
    await host.open(fixtureBytes(p.base), name);
    let taken: Body | null = null;
    store.setSubmitHandler(async () => {
      const current = host.getSnapshot().state!;
      const bytes = await host.save();
      const session = await host.kernel.session(current.doc);
      const decision = (await store.buildExport())!;
      taken = { proposal: p.id, name, sha256: current.sha256, session, decision, bytes: Buffer.from(bytes).toString("base64") };
    });
    for (const [index, batch] of p.batches.entries()) {
      const at = live && !wall ? proposedAt(index) : undefined;
      const r = await host.apply(batch.ops, { source: "proposal", label: batch.label, at });
      ok(r.ok, `${mode} ${p.id}: proposed batch ${index + 1} applies${r.ok ? "" : ` (${r.error.code}: ${r.error.message})`}`);
    }
    return { host, store, baseSha256: host.getSnapshot().history[0]!.baseSha256, taken: () => taken };
  }

  const entryAt = (o: Opened, revision: number): HistoryEntry =>
    o.host.getSnapshot().history.find((e) => e.revision === revision)!;

  /** Approve every hunk (and every hunk-less entry) still pending at or before the cursor. */
  function approveRest(o: Opened): number {
    const at = o.host.getSnapshot().state!.revision;
    let n = 0;
    for (const e of o.host.getSnapshot().history) {
      if (e.revision > at || o.store.decisionOf(e) === "reject") continue;
      const hunks = o.store.hunks(e);
      if (hunks.length === 0 && o.store.decisionOf(e) === "pending") {
        o.store.setDecision(e, "approve");
        n++;
      }
      for (const h of hunks)
        if (o.store.hunkDecisionOf(e, h.op) === "pending") {
          o.store.setHunkDecision(e, h.op, "approve");
          n++;
        }
    }
    return n;
  }

  /** Run the parts check, acknowledge its findings, submit; the exported decision must be a valid session file. */
  async function submit(o: Opened, label: string): Promise<Body> {
    const tag = `${mode} ${label}`;
    await o.store.refreshParts();
    const pc = o.store.partsCheck;
    const history = o.host.getSnapshot().history.length;
    ok(history === 0 || pc.status === "ready", `${tag}: parts check is ready (${pc.status})`);
    const findings = pc.report?.unexplained ?? [];
    const partsNote = `${findings.length} unexplained part(s)${findings.length ? `: ${findings.map((f) => `${f.name} (${f.status})`).join(", ")}` : ""}`;
    if (findings.length) note(`${label}: ${partsNote}`);
    if (findings.length && !blockedShown) {
      blockedShown = true;
      const codes = o.store.submitBlockers().map((b) => b.code);
      ok(codes.includes("unexplained-parts"), `${tag}: an unacknowledged part blocks Submit (${codes.join(", ")})`);
      ok(!(await o.store.submit()) && o.taken() === null, `${tag}: submit() refuses while a part is unacknowledged`);
      note(`${label}: Submit blocked by unexplained-parts before acknowledging ${findings.length} part(s)`);
    }
    for (const f of findings) ok(o.store.acknowledgePart(f.name), `${tag}: acknowledgePart(${f.name})`);
    const blockers = o.store.submitBlockers();
    ok(blockers.length === 0, `${tag}: Submit is free (${blockers.map((b) => b.code).join(", ") || "no blockers"})`);
    ok(await o.store.submit(), `${tag}: submit() ran the handler`);
    const body = o.taken();
    ok(body !== null, `${tag}: the submit handler produced a body`);
    const problems = validateSession(body.decision);
    ok(
      body.decision.contract === SESSION_CONTRACT && problems.length === 0,
      `${tag}: the exported decision validates as ${SESSION_CONTRACT} (${problems.slice(0, 3).join("; ") || body.decision.contract})`,
    );
    ok(
      history === 0 ||
        (body.decision.parts?.checked_sha256 === body.sha256 && body.decision.parts.unexplained.every((u) => u.acknowledged)),
      `${tag}: exported parts were checked on the submitted file and are all acknowledged`,
    );
    documents++;
    partsNotes.set(body, partsNote);
    return body;
  }

  /** The tampered copies, with the checks that named them. */
  const tamper: ModeResult["tamper"] = [];
  async function verify(
    p: Proposal,
    scenario: string,
    body: Posted,
    opts: { expect?: "verified" | "rejected"; failing?: string; note?: string } = {},
  ): Promise<Verdict> {
    const expect = opts.expect ?? "verified";
    const asServer = await verifyProposalSubmission({ ...fields(body), proposal: body.proposal }, env);
    const without = await verifySubmission(fields(body), {
      kernel: env.kernel,
      cache: env.cache,
      base: { name: basename(p.base), bytes: fixtureBytes(p.base) },
    });
    const failedText = asServer.checks
      .filter((c) => c.status === "fail")
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; ");
    const label = `${mode} ${p.id} ${scenario}`;
    ok(asServer.verdict === expect, `${label}: verdict ${asServer.verdict}, expected ${expect}. ${failedText}`);
    if (opts.failing)
      ok(
        asServer.failed.includes(opts.failing),
        `${label}: failing check ${asServer.failed.join(", ") || "none"} includes ${opts.failing}`,
      );
    if (expect === "rejected") tamper.push({ proposal: p.id, scenario, failed: asServer.failed });
    rows.push({
      proposal: p.id,
      scenario,
      expected: expect,
      verdict: asServer.verdict,
      verdictWithoutProposal: without.verdict === asServer.verdict ? "same" : `${without.verdict} (${without.failed.join(", ")})`,
      failed: asServer.failed,
      submittedSha256: body.sha256,
      replaySha256: asServer.outputSha256,
      note: [opts.note, partsNotes.get(body)].filter(Boolean).join("; "),
    });
    ctx.log(
      `${label}: ${asServer.verdict}${asServer.failed.length ? ` (${asServer.failed.join(", ")})` : ""} submitted ${short(body.sha256)} replay ${short(asServer.outputSha256)}` +
        (without.verdict !== asServer.verdict ? ` [without proposal: ${without.verdict}]` : ""),
    );
    return asServer;
  }

  /** Live mode: session batch k ran at the clock and zone proposal batch `kept[k]` was proposed at. */
  function checkClocks(p: Proposal, scenario: string, body: Body, kept: number[]): void {
    if (!live) return;
    const got = clocksOf(body.session);
    const want = kept.map(proposedAt);
    ok(
      got.length === want.length &&
        got.every((c, k) => c.clock === want[k]!.clock && c.timezone === want[k]!.timezone) &&
        new Set(got.map((c) => c.clock)).size === got.length,
      `live ${p.id} ${scenario}: the session records every kept batch at its own proposed clock (${got.map((c) => `${c.clock} ${c.timezone}`).join(", ")})`,
    );
  }

  for (const p of state.proposals) {
    const proposalOps: Op[][] = p.batches.map((b: Batch) => b.ops);
    const allIndexes = proposalOps.map((_, i) => i);
    const fromSession = p.kind === "session";
    ctx.log(`${mode} ${p.id}`);

    // A: approve everything.
    const a = await openReview(p);
    approveRest(a);
    const bodyA = await submit(a, `${p.id}-A`);
    await verify(p, "A approve all", bodyA);
    checkClocks(p, "A", bodyA, allIndexes);
    forPost.set(`${p.id}-A`, bodyA);
    await a.host.close();

    if (p.kind !== "dependent") {
      // B: reject one op of a multi-op batch.
      const b = await openReview(p);
      const revision = fromSession ? MULTI_OP_REVISION[p.format] : 1;
      const target = entryAt(b, revision);
      ok(target && target.ops.length > 1, `${mode} ${p.id}: entry ${revision} has several ops`);
      approveRest(b);
      let chosen: number | null = null;
      for (let op = 0; op < target.ops.length && chosen === null; op++) {
        const before = b.host.getSnapshot().state!.sha256;
        const r = await b.store.rejectOps(entryAt(b, revision), [op]);
        if (r.ok) chosen = op;
        else {
          const why =
            r.reason === "coupled"
              ? r.coupled.map((c) => `${c.kind}: ${c.detail}`).join(" | ")
              : `${r.error.code}: ${r.error.message}`;
          note(`${p.id} B: rejectOps(entry ${revision}, [${op}]) refused, ${r.reason}: ${why}`);
          ok(r.restored && b.host.getSnapshot().state!.sha256 === before, `${mode} ${p.id} B: refused op ${op} restores the chain`);
          b.store.patch({ coupled: null });
        }
      }
      ok(chosen !== null, `${mode} ${p.id} B: some op of entry ${revision} rejects independently`);
      const reset = approveRest(b);
      const bodyB = await submit(b, `${p.id}-B`);
      const rejectedOp = proposalOps[revision - 1]![chosen]!;
      const kept = bodyB.session.batches[revision - 1]?.ops ?? [];
      ok(
        canonical(kept) === canonical(proposalOps[revision - 1]!.filter((_, i) => i !== chosen)),
        `${mode} ${p.id} B: session batch ${revision} is the proposal minus op ${chosen}`,
      );
      const entry = bodyB.decision.entries.find((e) => e.revision === revision && e.in_history);
      ok(
        entry?.rejected_ops.length === 1 &&
          entry.rejected_ops[0]!.index === chosen &&
          canonical(entry.rejected_ops[0]!.op) === canonical(rejectedOp),
        `${mode} ${p.id} B: decision entry ${revision} lists rejected op ${chosen}`,
      );
      const vb = await verify(p, `B rejectOps entry ${revision} op ${chosen}`, bodyB, {
        note:
          `${reset} hunk(s) re-approved after the rejection` +
          (p.kind === "repeated" ? "; without the proposal check d cannot tell the kept copy from the rejected one" : ""),
      });
      // Rejecting one of two identical sets leaves the cell as A set it, so there the file is A's.
      if (p.kind === "repeated")
        ok(vb.outputSha256 === bodyA.sha256, `${mode} ${p.id} B: rejecting one copy gives scenario A's file`);
      else ok(vb.outputSha256 !== bodyA.sha256, `${mode} ${p.id} B: replay output differs from scenario A`);
      forPost.set(`${p.id}-B`, bodyB);
      checkClocks(p, "B", bodyB, allIndexes);

      /** bodyB with batch 1's clock and/or zone replaced; the rest exactly as submitted. */
      const withClock = (override: BatchEnvironment): Posted => {
        const t = structuredClone(bodyB);
        t.session.batches[0] = { ...t.session.batches[0]!, ...override };
        return t;
      };
      if (fromSession) {
        await verify(p, "B tamper: batch 1 clock malformed", withClock({ clock: "yesterday" }), {
          expect: "rejected",
          failing: "wasm-replay",
        });
        await verify(p, "B tamper: batch 1 zone unknown to the engine", withClock({ timezone: "Mars/Olympus" }), {
          expect: "rejected",
          failing: "wasm-replay",
        });
      }
      if (p.kind === "dated") {
        const first = clocksOf(bodyB.session)[0]!;
        const later = new Date(Date.parse(first.clock) + 86_400_000).toISOString().replace(".000Z", "Z");
        await verify(p, "B tamper: batch 1 clock moved by a day", withClock({ clock: later, timezone: first.timezone }), {
          expect: "rejected",
          failing: "wasm-replay",
          note: `${first.clock} -> ${later}`,
        });
      }

      if (fromSession) {
        // Tampering.
        const flipped = Buffer.from(bodyB.bytes, "base64");
        flipped[flipped.length >> 1]! ^= 1;
        await verify(p, "B tamper: flipped byte", { ...bodyB, bytes: flipped.toString("base64") }, {
          expect: "rejected",
          failing: "bytes-sha256",
        });
        const back = structuredClone(bodyB);
        back.session = structuredClone(bodyA.session);
        back.sha256 = bodyA.sha256;
        back.bytes = bodyA.bytes;
        back.decision.current_sha256 = bodyA.sha256;
        if (back.decision.parts) back.decision.parts.checked_sha256 = bodyA.sha256;
        // Keep the decision's per-batch sha256 in step with the swapped session, so only the rejected op disagrees.
        for (const e of back.decision.entries) {
          const sb = back.session.batches[e.revision - 1];
          if (e.in_history && sb) {
            e.base_sha256 = sb.baseSha256;
            e.result_sha256 = sb.resultSha256;
          }
        }
        await verify(p, "B tamper: rejected op put back (A's session and bytes)", back, {
          expect: "rejected",
          failing: "rejected-absent",
        });
        const dropped = structuredClone(bodyB);
        for (const e of dropped.decision.entries) if (e.revision === revision && e.in_history) e.rejected_ops = [];
        await verify(p, "B tamper: rejected_ops entry deleted", dropped, { expect: "rejected", failing: "rejected-absent" });
        forPost.set(`${p.id}-B-dropped`, dropped);

        if (p.format === "xlsx") {
          // Hand-built parts members (the verifier's parts-acknowledged check on its own).
          const finding = { name: "xl/styles.xml", status: "changed", verdict: "unnamed" } as const;
          const withParts = (parts: unknown): Posted => ({ ...bodyB, decision: { ...bodyB.decision, parts } });
          const ready: Parts = { checked_sha256: bodyB.sha256, changed: 3, recompressed: [], unexplained: [{ ...finding, acknowledged: true }] };
          await verify(p, "B parts: hand-built, acknowledged", withParts(ready));
          await verify(p, "B parts: hand-built, unacknowledged", withParts({ ...ready, unexplained: [{ ...finding, acknowledged: false }] }), {
            expect: "rejected",
            failing: "parts-acknowledged",
          });
          await verify(p, "B parts: hand-built, checked on another sha256", withParts({ ...ready, checked_sha256: bodyA.sha256 }), {
            expect: "rejected",
            failing: "parts-acknowledged",
          });
          await verify(p, "B parts: null with batches", withParts(null), { expect: "rejected", failing: "parts-acknowledged" });
          const { parts: _parts, ...noParts } = bodyB.decision;
          const va = await verify(p, "B parts: member absent", { ...bodyB, decision: noParts });
          ok(
            va.checks.find((c) => c.name === "parts-acknowledged")?.status === "skipped",
            `${mode} ${p.id} B parts absent: parts-acknowledged is skipped`,
          );
        }
      }
      await b.host.close();
    }

    if (fromSession) {
      // C: reject only a middle batch.
      const c = await openReview(p);
      approveRest(c);
      const n = p.batches.length;
      const mid = Math.ceil(n / 2);
      const order = [mid, ...Array.from({ length: n }, (_, i) => i + 1).filter((r) => r !== mid && r > 1 && r < n)];
      let removed: number | null = null;
      for (const r of order) {
        const before = c.host.getSnapshot().state!.sha256;
        const res = await c.store.rejectOnly(entryAt(c, r));
        if (res.ok) {
          removed = r;
          break;
        }
        const why =
          res.reason === "coupled"
            ? res.coupled.map((x) => `${x.kind}: ${x.detail}`).join(" | ")
            : `${res.error.code}: ${res.error.message}`;
        note(`${p.id} C: rejectOnly(entry ${r}) refused, ${res.reason}: ${why}`);
        ok(res.restored && c.host.getSnapshot().state!.sha256 === before, `${mode} ${p.id} C: refused entry ${r} restores the chain`);
        c.store.patch({ coupled: null });
      }
      ok(removed !== null, `${mode} ${p.id} C: some middle batch can be rejected alone`);
      const reset = approveRest(c);
      const bodyC = await submit(c, `${p.id}-C`);
      ok(bodyC.session.batches.length === n - 1, `${mode} ${p.id} C: session has ${n - 1} batches`);
      const gone = bodyC.decision.entries.find((e) => !e.in_history && e.revision === removed);
      ok(
        gone?.decision === "reject" && gone.rejected_ops.length === proposalOps[removed - 1]!.length,
        `${mode} ${p.id} C: removed entry ${removed} is rejected with all its ops`,
      );
      await verify(p, `C rejectOnly entry ${removed}`, bodyC, { note: `${reset} hunk(s) re-approved after the rejection` });
      checkClocks(p, "C", bodyC, allIndexes.filter((i) => i !== removed - 1));
      const flippedDecision = structuredClone(bodyC);
      for (const e of flippedDecision.decision.entries)
        if (!e.in_history && e.revision === removed) {
          e.decision = "approve";
          for (const h of e.hunks) h.decision = "approve";
        }
      await verify(p, "C tamper: removed entry flipped to approve", flippedDecision, {
        expect: "rejected",
        failing: "rejected-absent",
      });
      await c.host.close();
    }

    if (p.kind === "dependent") {
      // D: the dependent proposal refuses "reject only the insert".
      const d = await openReview(p);
      const before = d.host.getSnapshot().state!;
      const r = await d.store.rejectOnly(entryAt(d, 1));
      ok(
        !r.ok && r.reason === "coupled" && r.restored,
        `${mode} ${p.id} D: rejectOnly(entry 1) is refused as coupled and restored (${JSON.stringify(r.ok ? r : { reason: r.reason, restored: r.restored })})`,
      );
      note(
        `${p.id} D: rejectOnly(entry 1) coupled: ${r.coupled.map((x) => `${x.kind} rev ${x.revision} op ${x.op}: ${x.detail}`).join(" | ")}`,
      );
      const after = d.host.getSnapshot().state!;
      ok(after.sha256 === before.sha256 && after.revision === before.revision, `${mode} ${p.id} D: document unchanged`);
      ok(d.store.ui.coupled !== null, `${mode} ${p.id} D: ui.coupled is set`);
      ok(
        d.store.submitBlockers().some((x) => x.code === "coupled"),
        `${mode} ${p.id} D: the coupled notice blocks Submit`,
      );
      approveRest(d);
      ok(d.store.ui.coupled === null, `${mode} ${p.id} D: approving clears the notice`);
      const bodyD = await submit(d, `${p.id}-D`);
      await verify(p, "D coupled refusal, then approve both", bodyD);
      await d.host.close();
    }

    if (live && p.kind === "dated") {
      // Live only: no explicit clocks, so every batch runs at the kernel's own live clock.
      const wallStart = Date.now();
      const w = await openReview(p, true);
      approveRest(w);
      const bodyW = await submit(w, `${p.id}-wall`);
      await verify(p, "A approve all, batches at the wall clock", bodyW);
      const stamps = clocksOf(bodyW.session).map((c) => Date.parse(c.clock));
      ok(
        stamps.length === proposalOps.length && stamps.every((t) => t >= Math.floor(wallStart / 1000) * 1000 && t <= Date.now()),
        `live ${p.id} wall: every batch ran at a real clock during this run (${clocksOf(bodyW.session)
          .map((c) => `${c.clock} ${c.timezone}`)
          .join(", ")})`,
      );
      await w.host.close();
    }

    // E: reject everything.
    const e = await openReview(p);
    await e.store.rejectWithAfter(entryAt(e, 1));
    const blockers = e.store.submitBlockers().map((x) => x.code);
    note(`${p.id} E: after rejecting every batch, submitBlockers() = [${blockers.join(", ")}]`);
    // store.submit() runs the parts check itself, so only blockers other than the parts ones keep Submit shut.
    ok(
      blockers.every((code) => code === "parts-unchecked" || code === "unexplained-parts"),
      `${mode} ${p.id} E: Submit stays free with everything rejected (${blockers.join(", ")})`,
    );
    const bodyE = await submit(e, `${p.id}-E`);
    ok(bodyE.sha256 === e.baseSha256 && bodyE.session.batches.length === 0, `${mode} ${p.id} E: submits the base file`);
    await verify(p, "E reject all", bodyE);
    await e.host.close();
  }

  // The server path: bodies posted in-process as the page posts them, plus an unknown and a missing proposal id.
  const cases: { case: string; body: Body | undefined; proposal?: string | null; expected: "verified" | "rejected"; failing?: string }[] = [
    { case: `${format} A approve all`, body: forPost.get(`${format}-A`), expected: "verified" },
    { case: `${format} B reject one op`, body: forPost.get(`${format}-B`), expected: "verified" },
    {
      case: `${format} B tamper: rejected_ops entry deleted`,
      body: forPost.get(`${format}-B-dropped`),
      expected: "rejected",
      failing: "rejected-absent",
    },
    ...(format === "xlsx"
      ? [{ case: "xlsx-repeated B reject one of two identical ops", body: forPost.get("xlsx-repeated-B"), expected: "verified" as const }]
      : []),
    { case: "unknown proposal id", body: forPost.get(`${format}-A`), proposal: `${format}-unknown`, expected: "rejected", failing: "proposal-known" },
    { case: "missing proposal id", body: forPost.get(`${format}-A`), proposal: null, expected: "rejected", failing: "proposal-known" },
  ];
  const post: PostRow[] = [];
  for (const c of cases) {
    ok(c.body, `${mode} post ${c.case}: a body to post`);
    const { proposal, ...rest } = c.body;
    // `base` is a field the page no longer sends; the verifier must ignore it (it names the DOCX base even for
    // XLSX and PPTX proposals here).
    const posted = { ...rest, base: "docx/images-hdrftr.docx", ...(c.proposal === null ? {} : { proposal: c.proposal ?? proposal }) };
    const answer = await postSubmission(posted, env);
    ok(
      answer.verdict === c.expected && (!c.failing || answer.failed.includes(c.failing)),
      `${mode} post ${c.case}: ${answer.verdict} (${answer.failed.join(", ") || "no failed checks"}), expected ${c.expected}${c.failing ? ` on ${c.failing}` : ""}`,
    );
    post.push({
      case: c.case,
      expected: `${c.expected}${c.failing ? ` (${c.failing})` : ""}`,
      verdict: answer.verdict,
      failed: answer.failed,
    });
  }

  return {
    ms: Date.now() - started,
    blockedShown,
    documents,
    verified: rows.filter((r) => r.expected === "verified").length,
    tamperRejected: tamper.length,
    rows,
    tamper,
    post,
  };
}
