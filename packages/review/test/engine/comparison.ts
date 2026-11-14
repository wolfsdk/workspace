// Before/after comparison (shadow document) against the real engine, ported from the prototype review
// package's compare-check.ts. Per format: open, apply four session batches, inspect entry 3, enable
// comparison and check that the host never moves, the shadow validates and its page 1 is the "before"
// page; then a history rewrite, the one-time goto route for the original bytes, and closing the
// document. Then `original.ts` directly: capture and goto routes, a second document (the next format
// of `OTHER`), no document, a capture that raced an apply, and concurrent reads.
//
// The whole sequence runs twice per format, each time on its own node reactor kernel of the pinned
// module: first on the pinned clock, then on the live clock (`environment: { clock: "live" }`), where
// every batch is stamped with the time it ran and the shadow must replay that clock to reach the same
// bytes (the live pass sleeps past a clock tick before the shadow is built, so a replay on any other
// clock would differ). Every assertion of the prototype runs in both passes.
//
// Not ported: the prototype's command kernel (only the reactor kernel exists here; the prototype
// ran this very check on it with its `--reactor` switch) and its `--measure` mode, a report of memory
// and timings that asserts nothing. The shadow's open and mirror timings are kept in `data`.
import { setTimeout as sleep } from "node:timers/promises";
import type { KernelClient, Op } from "@wolfsdk/protocol";
import { createEditorHost } from "../../src/host/host.ts";
import type { EditorHost } from "../../src/host/index.ts";
import { compareStore, type CompareStore } from "../../src/review/compare.ts";
import { originalBytes, originalHostMoves, watchOriginal } from "../../src/review/original.ts";
import { reviewStore } from "../../src/review/store.ts";
import {
  BASE,
  CheckFailure,
  OTHER,
  baseBytes,
  createAsserter,
  sameBytes,
  sessionBatches,
  type Asserter,
  type CheckOutcome,
  type EngineContext,
  type Format,
} from "./harness.ts";

const SOURCE = "compare-check";

/** Bytes behind an object URL (the before pages of the comparison are `blob:` URLs). */
const bytesAt = async (url: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(url)).arrayBuffer());

/** Every published (revision, sha256) of `host` until `stop()`. */
function record(host: EditorHost) {
  const seen: string[] = [];
  const stop = host.subscribe(() => {
    const s = host.getSnapshot().state;
    seen.push(s ? `${s.revision}:${s.sha256}` : "none");
  });
  return { seen, stop };
}

/** Resolves once `pred()` holds, checked on every compare store change. */
function until(compare: CompareStore, pred: () => boolean, what: string, ms = 120_000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (pred()) resolve();
  const timer = setTimeout(() => reject(new CheckFailure(`timed out waiting for ${what} (${compare.reason})`)), ms);
  const off = compare.subscribe(() => {
    if (pred()) resolve();
  });
  return promise.finally(() => {
    clearTimeout(timer);
    off();
  });
}

async function applyAll(ok: Asserter, host: EditorHost, batches: Op[][], label: string): Promise<void> {
  for (const [i, ops] of batches.entries()) {
    const r = await host.apply(ops, { label: `batch ${i + 1}`, source: SOURCE });
    ok(r.ok, `${label}: batch ${i + 1} applies`);
  }
}

/** Apply the first of `candidates` the engine accepts; returns its index or -1. */
async function applyFirst(host: EditorHost, candidates: Op[][], label: string): Promise<number> {
  for (const [i, ops] of candidates.entries()) {
    const r = await host.apply(ops, { label, source: SOURCE, quiet: true });
    if (r.ok) return i;
  }
  return -1;
}

/** What one pass of `checkFormat` reports (counts and timings of the shadow, the first page that changed). */
type ShadowFacts = { opens: number; applies: number; gotos: number; openMs: number; mirrorMs: number; changedPage: number };

async function checkFormat(ok: Asserter, kernel: KernelClient, format: Format, live: boolean, tag: string): Promise<ShadowFacts> {
  const bytes = baseBytes(format);
  const batches = sessionBatches(format);
  const host = createEditorHost(kernel);
  const store = reviewStore(host);
  // Created before `open`, as the plugin is: it keeps revision 0 bytes while the host is there.
  const compare = compareStore(host);
  await host.open(bytes, BASE[format]);
  await applyAll(ok, host, batches.slice(0, 4), tag);
  const history = host.getSnapshot().history.slice();
  ok(history.length === 4, `${tag}: four entries`);
  const e3 = history[2]!;
  await store.inspect(e3);
  const at = host.getSnapshot().state!;
  ok(at.revision === 3 && at.sha256 === e3.resultSha256, `${tag}: host shows entry 3`);

  // Live clock: let the clock move on so the shadow's batches only match by replaying it.
  if (live) await sleep(1100);
  // Enable and compare without moving the host.
  const rec = record(host);
  const statuses: string[] = [];
  const offStatus = compare.subscribe(() => statuses.push(compare.status));
  compare.setEnabled(true);
  await until(compare, () => compare.status === "ready" || compare.status === "unavailable", "ready");
  ok(compare.status === "ready", `${tag}: status ready (${compare.reason})`);
  ok(compare.stats.baseRoute === "captured" && compare.stats.hostMoves === 0, `${tag}: base bytes captured at open`);
  const shadow = compare.shadowState!;
  ok(shadow && shadow.doc !== at.doc, `${tag}: shadow is its own document`);
  ok(shadow.revision === 2 && shadow.sha256 === e3.baseSha256, `${tag}: shadow sha equals entry 3 base`);
  const before = await compare.beforePage(1, 1);
  ok(before, `${tag}: before page 1 exists`);
  ok(before.url.startsWith("blob:"), `${tag}: before page is an object URL`);
  ok((await compare.beforePage(1, 1)) === before, `${tag}: before page cached`);
  const beforeBytes = await bytesAt(before.url);
  const afterBytes = (await host.pageImage(1, 1)).png;
  rec.stop();
  offStatus();
  ok(
    rec.seen.every((s) => s === `${at.revision}:${at.sha256}`),
    `${tag}: host revision and sha never changed (${[...new Set(rec.seen)].join(", ")})`,
  );
  ok(statuses.includes("loading"), `${tag}: status went through loading`);

  // Independent reference: a separate host moved by goto.
  const ref = createEditorHost(kernel);
  await ref.open(bytes, BASE[format]);
  await applyAll(ok, ref, batches.slice(0, 4), `${tag} reference`);
  await ref.goto(2);
  const refBefore = (await ref.pageImage(1, 1)).png;
  await ref.goto(3);
  const refAfter = (await ref.pageImage(1, 1)).png;
  const differs = !sameBytes(refBefore, refAfter);
  let changedPage = differs ? 1 : 0;
  let changedBefore: Uint8Array | null = null;
  if (!differs) {
    // Page 1 unchanged (a PPTX change on a later slide): also check the first page that changed.
    await ref.goto(2);
    const laterBefore = new Map<number, Uint8Array>();
    for (const { page: p } of ref.getSnapshot().state!.pages.slice(1))
      laterBefore.set(p, (await ref.pageImage(p, 1)).png);
    await ref.goto(3);
    const pagesAfter = new Set(ref.getSnapshot().state!.pages.map((info) => info.page));
    for (const [p, png] of laterBefore) {
      if (!pagesAfter.has(p) || sameBytes(png, (await ref.pageImage(p, 1)).png)) continue;
      changedPage = p;
      changedBefore = png;
      break;
    }
  }
  await ref.close();
  if (differs) ok(!sameBytes(beforeBytes, afterBytes), `${tag}: before page differs from the host's page`);
  ok(sameBytes(beforeBytes, refBefore), `${tag}: before page equals the reference before page`);
  if (changedBefore) {
    const other = await compare.beforePage(changedPage, 1);
    ok(other, `${tag}: before page ${changedPage} exists`);
    const otherBytes = await bytesAt(other.url);
    ok(!sameBytes(otherBytes, (await host.pageImage(changedPage, 1)).png), `${tag}: before page ${changedPage} differs`);
    ok(sameBytes(otherBytes, changedBefore), `${tag}: before page ${changedPage} equals the reference`);
  }
  const facts: ShadowFacts = {
    opens: compare.stats.opens,
    applies: compare.stats.applies,
    gotos: compare.stats.gotos,
    openMs: compare.stats.openMs,
    mirrorMs: compare.stats.mirrorMs,
    changedPage,
  };

  // History rewrite: back to revision 1 and two different batches.
  const opens = compare.stats.opens;
  const applies = compare.stats.applies;
  await host.goto(1);
  const rest = batches.slice(4);
  const x2 = await applyFirst(host, rest, "rewrite 2");
  ok(x2 >= 0, `${tag}: a different batch applies at revision 1`);
  const x3 = await applyFirst(host, rest.slice(x2 + 1), "rewrite 3");
  ok(x3 >= 0, `${tag}: a second different batch applies`);
  const rewritten = host.getSnapshot().history.slice();
  ok(
    rewritten.length === 3 && rewritten[0]!.resultSha256 === history[0]!.resultSha256,
    `${tag}: rewrite keeps entry 1`,
  );
  ok(rewritten[1]!.resultSha256 !== history[1]!.resultSha256, `${tag}: entry 2 replaced`);
  await store.inspect(rewritten[2]!);
  const at2 = host.getSnapshot().state!;
  const rec2 = record(host);
  const before2 = await compare.beforePage(1, 1);
  rec2.stop();
  ok(compare.status === "ready", `${tag}: ready after rewrite (${compare.reason})`);
  ok(compare.stats.opens === opens, `${tag}: rewrite kept the shadow (no re-open)`);
  ok(
    compare.stats.applies - applies === 1,
    `${tag}: rewrite re-applied one batch (${compare.stats.applies - applies})`,
  );
  ok(compare.mirrored === 2, `${tag}: mirror holds entries 1 and 2`);
  ok(compare.shadowState!.sha256 === rewritten[2]!.baseSha256, `${tag}: rebuilt shadow validates`);
  ok(before2 && before2.url !== before.url, `${tag}: new before page after rewrite`);
  ok(
    rec2.seen.every((s) => s === `${at2.revision}:${at2.sha256}`),
    `${tag}: host still not moved by the comparison after rewrite`,
  );

  // Close: the shadow goes with the document.
  const shadowDoc = compare.shadowState!.doc;
  await host.close();
  await until(compare, () => compare.status === "unavailable", "closed status", 10_000);
  ok(compare.reason === "No document is open", `${tag}: status says no document`);
  await compare.dispose();
  ok(compare.shadowState === null, `${tag}: shadow state dropped`);
  let rejected = false;
  await kernel.page(shadowDoc, 1, 1).then(
    () => {},
    () => {
      rejected = true;
    },
  );
  ok(rejected, `${tag}: kernel.page on the closed shadow rejects`);

  // One-time route: a store that first meets the document past revision 0.
  const late = createEditorHost(kernel);
  await late.open(bytes, BASE[format]);
  await applyAll(ok, late, batches.slice(0, 4), `${tag} late`);
  // Created past revision 0 too, in case the review store watches the original bytes.
  const lateReview = reviewStore(late);
  const lateHistory = late.getSnapshot().history.slice();
  await lateReview.inspect(lateHistory[2]!);
  const lateAt = late.getSnapshot().state!;
  const lateCompare = compareStore(late);
  const rec3 = record(late);
  const reasons: string[] = [];
  const offReason = lateCompare.subscribe(() => reasons.push(lateCompare.reason));
  lateCompare.setEnabled(true);
  await until(lateCompare, () => lateCompare.status === "ready" || lateCompare.status === "unavailable", "late ready");
  rec3.stop();
  offReason();
  ok(lateCompare.status === "ready", `${tag}: late store ready (${lateCompare.reason})`);
  ok(
    lateCompare.stats.baseRoute === "goto" && lateCompare.stats.hostMoves === 1,
    `${tag}: late store used the goto route once`,
  );
  ok(reasons.includes("Preparing comparison"), `${tag}: late store showed Preparing comparison`);
  const moved = [...new Set(rec3.seen)];
  ok(
    moved.every((s) => s === `${lateAt.revision}:${lateAt.sha256}` || s.startsWith("0:")) &&
      rec3.seen.at(-1) === `${lateAt.revision}:${lateAt.sha256}`,
    `${tag}: goto route only visits revision 0 and returns (${moved.map((s) => s.split(":")[0]).join(", ")})`,
  );
  const lateNow = late.getSnapshot();
  ok(
    lateNow.history.length === 4 && lateNow.history.every((e, i) => e.resultSha256 === lateHistory[i]!.resultSha256),
    `${tag}: goto route kept the history`,
  );
  ok(lateCompare.shadowState!.sha256 === lateHistory[2]!.baseSha256, `${tag}: late shadow validates`);
  await late.close();
  await lateCompare.dispose();
  return facts;
}

async function checkOriginal(ok: Asserter, kernel: KernelClient, format: Format, tag: string): Promise<void> {
  const bytes = baseBytes(format);
  const batches = sessionBatches(format);

  // Capture route: watched before `open`, the host never moves.
  const host = createEditorHost(kernel);
  watchOriginal(host);
  watchOriginal(host);
  await host.open(bytes, BASE[format]);
  await applyAll(ok, host, batches.slice(0, 4), `${tag} original`);
  const at = host.getSnapshot().state!;
  const rec = record(host);
  const captured = await originalBytes(host);
  rec.stop();
  ok(captured.route === "captured", `${tag} original: capture route (${captured.route})`);
  ok(originalHostMoves(host) === 0, `${tag} original: capture route never moved the host`);
  ok(rec.seen.length === 0 && host.getSnapshot().state!.sha256 === at.sha256, `${tag} original: host unchanged`);
  ok(sameBytes(captured.bytes, bytes), `${tag} original: captured bytes equal the fixture file`);
  ok(captured.sha256 === (await kernel.session(at.doc)).originalSha256, `${tag} original: sha256 equals the session's`);
  ok((await originalBytes(host)) === captured, `${tag} original: second call reuses the read`);

  // A second document in the same host gets its own bytes.
  const otherFormat = OTHER[format];
  const otherBytes = baseBytes(otherFormat);
  await host.open(otherBytes, BASE[otherFormat]);
  const second = await originalBytes(host);
  ok(sameBytes(second.bytes, otherBytes) && !sameBytes(second.bytes, bytes), `${tag} original: second document's bytes`);
  ok(second.route === "captured" && originalHostMoves(host) === 0, `${tag} original: second document captured`);

  // No document open.
  await host.close();
  const noDoc = await originalBytes(host).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  ok(noDoc === "No document is open", `${tag} original: rejects with no document (${noDoc})`);
  const fresh = createEditorHost(kernel);
  ok(
    await originalBytes(fresh).then(
      () => false,
      () => true,
    ),
    `${tag} original: rejects on a host never opened`,
  );

  // A capture that raced an apply is wrong; the goto route takes over once.
  const raced = createEditorHost(kernel);
  watchOriginal(raced);
  const opening = raced.open(bytes, BASE[format]);
  const applying = raced.apply(batches[0]!, { label: "raced", source: SOURCE });
  await opening;
  ok((await applying).ok, `${tag} original: raced batch applies`);
  const fallback = await originalBytes(raced);
  ok(
    fallback.route === "goto" && originalHostMoves(raced) === 1,
    `${tag} original: wrong capture fell back to goto once`,
  );
  ok(sameBytes(fallback.bytes, bytes), `${tag} original: fallback bytes equal the fixture file`);
  ok(raced.getSnapshot().state!.revision === 1, `${tag} original: raced host back at revision 1`);
  await raced.close();

  // Goto route: first asked after the host moved on, cursor inside the history.
  const late = createEditorHost(kernel);
  await late.open(bytes, BASE[format]);
  await applyAll(ok, late, batches.slice(0, 4), `${tag} original late`);
  await late.goto(2);
  const lateAt = late.getSnapshot().state!;
  const lateHistory = late.getSnapshot().history.slice();
  const rec2 = record(late);
  const one = originalBytes(late);
  const two = originalBytes(late);
  const [a, b] = await Promise.all([one, two]);
  rec2.stop();
  ok(a === b, `${tag} original: concurrent calls share one read`);
  ok(a.route === "goto", `${tag} original: goto route (${a.route})`);
  ok(originalHostMoves(late) === 1, `${tag} original: concurrent calls moved the host once`);
  // Entries into revision 0: a "0:" state not preceded by one.
  const visits = rec2.seen.filter((s, i) => s.startsWith("0:") && !rec2.seen[i - 1]?.startsWith("0:")).length;
  ok(visits === 1, `${tag} original: exactly one visit to revision 0 (${visits})`);
  ok(rec2.seen.at(-1) === `${lateAt.revision}:${lateAt.sha256}`, `${tag} original: cursor back at revision 2`);
  const lateNow = late.getSnapshot().history;
  ok(
    lateNow.length === 4 && lateNow.every((e, i) => e.resultSha256 === lateHistory[i]!.resultSha256),
    `${tag} original: goto route kept the history`,
  );
  ok(sameBytes(a.bytes, bytes), `${tag} original: goto bytes equal the fixture file`);
  await originalBytes(late);
  ok(originalHostMoves(late) === 1, `${tag} original: later call does not move the host`);
  await late.close();
}

export async function run(ctx: EngineContext, format: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const notes: string[] = [];
  const data: Record<string, unknown> = {};
  for (const live of [false, true]) {
    const clock = live ? "live" : "pinned";
    const tag = live ? `${format} (live clock)` : format;
    ctx.log(`comparison ${format}: ${clock} clock`);
    // One kernel per pass, reused across the fresh hosts of both parts, as the prototype does.
    const kernel = live ? ctx.kernel({ environment: { clock: "live" } }) : ctx.kernel();
    const before = ok.count;
    const facts = await checkFormat(ok, kernel, format, live, tag);
    const afterShadow = ok.count;
    await checkOriginal(ok, kernel, format, tag);
    notes.push(
      `${clock} clock: ${ok.count - before} checks (${afterShadow - before} comparison, ${ok.count - afterShadow} original);` +
        ` shadow ready, opens=${facts.opens} applies=${facts.applies} gotos=${facts.gotos};` +
        ` first changed page: ${facts.changedPage || "none"}`,
    );
    data[clock] = { checks: ok.count - before, ...facts };
  }
  return { checks: ok.count, notes, data };
}
