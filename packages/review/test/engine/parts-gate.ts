// Engine check `parts-gate`: the unexplained-parts gate on submit, against the real engine. Ported from the
// prototype review package's parts-gate-check script. One call covers one format:
// 1. Per format, 4 fixture session batches, all approved: the gate is `parts-unchecked` until `refreshParts`,
//    then matches `buildPartsReport` called directly; acknowledging every finding lets `submit()` through, and
//    the export lists them as acknowledged.
// 2. A goto or a new apply makes the report stale; `submit()` refreshes by itself.
// 3. DOCX seeded case (insert-hyperlink leaves word/_rels/document.xml.rels unnamed): submit is blocked until
//    acknowledged; the acknowledgement survives an edit of another part and lapses when the relationships part
//    changes again; after `rejectOnly` the report is for the new cursor.
// 4. DOCX: a kernel whose session reports another original sha256: the check fails, submit stays blocked.
// 5. Acknowledgement keys: SHA-256 of the part content, so same-size and CRC-32-colliding contents differ.
// Cases 3 and 4 are DOCX cases (they name word/ parts and DOCX anchors), as in the prototype, which ran them
// only when DOCX was among the formats; cases 1, 2 and 5 run for every format.
import { deflateRawSync } from "node:zlib";
import { buildPartsReport, canonical, partContent, validateSession } from "@wolfsdk/protocol";
import type { KernelClient, Op } from "@wolfsdk/protocol";
import { createEditorHost } from "../../src/host/host.ts";
import type { EditorHost, HistoryEntry } from "../../src/host/index.ts";
import { originalBytes } from "../../src/review/original.ts";
import { partKey, reviewStore } from "../../src/review/store.ts";
import type { ReviewStore } from "../../src/review/store.ts";
import { baseBytes, BASE, createAsserter, sessionBatches } from "./harness.ts";
import type { Asserter, CheckOutcome, EngineContext, Format } from "./harness.ts";

const RELS = "word/_rels/document.xml.rels";

const codes = (store: ReviewStore): string[] => store.submitBlockers().map((b) => b.code);
const partsCodes = (store: ReviewStore): string[] =>
  codes(store).filter((c) => c === "parts-unchecked" || c === "unexplained-parts");
const approveAll = (store: ReviewStore): void => {
  for (const e of store.history()) if (store.decisionOf(e) !== "reject") store.setDecision(e, "approve");
};
const unexplainedNames = (store: ReviewStore): string[] =>
  store.partsCheck.report?.unexplained.map((f) => f.name) ?? [];

async function apply(ok: Asserter, host: EditorHost, ops: Op[], label: string, tag: string): Promise<void> {
  const r = await host.apply(ops, { label, source: "check" });
  ok(r.ok, `${tag}: "${label}" applies${r.ok ? "" : ` (${r.error.code}: ${r.error.message})`}`);
}

/** The report `refreshParts` must have produced: same inputs, computed here. */
async function directReport(host: EditorHost) {
  const snap = host.getSnapshot();
  const revision = snap.state!.revision;
  const entries = snap.history.filter((e: HistoryEntry) => e.revision <= revision);
  return buildPartsReport((await originalBytes(host)).bytes, await host.save(), entries);
}

async function refreshTimed(store: ReviewStore): Promise<number> {
  const t0 = performance.now();
  await store.refreshParts();
  return performance.now() - t0;
}

function assertReady(ok: Asserter, store: ReviewStore, tag: string): void {
  const pc = store.partsCheck;
  ok(
    pc.status === "ready" && pc.sha256 === store.host.getSnapshot().state!.sha256 && pc.report,
    `${tag}: report ready for the current sha256 (${pc.status}${pc.error ? `: ${pc.error}` : ""})`,
  );
}

type Facts = { notes: string[]; data: Record<string, unknown> };

async function sessionFlow(ok: Asserter, kernel: KernelClient, format: Format, facts: Facts): Promise<void> {
  const tag = `${format} session`;
  const host = createEditorHost(kernel);
  const store = reviewStore(host);
  await host.open(baseBytes(format), BASE[format]);
  ok(codes(store).length === 0, `${tag}: nothing applied, nothing blocks (${codes(store)})`);
  const batches = sessionBatches(format);
  for (const [i, ops] of batches.slice(0, 4).entries()) await apply(ok, host, ops, `batch ${i + 1}`, tag);
  approveAll(store);
  ok(store.partsCheck.status === "stale", `${tag}: stale before refresh`);
  ok(
    codes(store).length === 1 && codes(store)[0] === "parts-unchecked",
    `${tag}: only parts-unchecked before refresh (${codes(store)})`,
  );
  const refreshMs = await refreshTimed(store);
  assertReady(ok, store, tag);
  const direct = await directReport(host);
  const got = store.partsCheck.report!;
  ok(canonical(got) === canonical(direct), `${tag}: report equals buildPartsReport called directly`);
  const unexplained = direct.unexplained.map((f) => f.name);
  facts.notes.push(
    `${format}: changed ${got.changed}, recompressed ${got.recompressed.length}, unexplained [${direct.unexplained.map((f) => `${f.name} (${f.verdict})`).join(", ")}]`,
  );
  facts.data.changed = got.changed;
  facts.data.recompressed = got.recompressed.length;
  facts.data.unexplained = direct.unexplained.map((f) => ({ name: f.name, verdict: f.verdict }));
  facts.data.refreshMs = Math.round(refreshMs * 10) / 10;
  const blockers = store.submitBlockers();
  if (unexplained.length) {
    ok(
      blockers.length === 1 &&
        blockers[0]!.code === "unexplained-parts" &&
        blockers[0]!.message.startsWith(`${unexplained.length} part`),
      `${tag}: unexplained-parts names the count (${JSON.stringify(blockers)})`,
    );
    for (const name of unexplained.slice(0, -1)) ok(store.acknowledgePart(name), `${tag}: acknowledge ${name}`);
    ok(codes(store).includes("unexplained-parts"), `${tag}: still blocked while one finding is open`);
    ok(store.acknowledgePart(unexplained.at(-1)!), `${tag}: acknowledge the last finding`);
  }
  ok(!store.acknowledgePart("no/such/part.xml"), `${tag}: acknowledging a part that is not a finding does nothing`);
  ok(codes(store).length === 0, `${tag}: nothing blocks once every finding is acknowledged (${codes(store)})`);
  const submits = { n: 0 };
  // Read through a function: a direct `submits.n === 1` check would narrow the property to a literal type.
  const calls = (): number => submits.n;
  store.setSubmitHandler(async () => {
    submits.n++;
  });
  ok((await store.submit()) === true && calls() === 1, `${tag}: submit runs the handler once`);
  const doc = await store.buildExport();
  ok(doc?.parts, `${tag}: export has parts`);
  ok(doc.parts.checked_sha256 === host.getSnapshot().state!.sha256, `${tag}: export parts tied to the current sha256`);
  ok(
    doc.parts.changed === direct.changed &&
      canonical(doc.parts.unexplained.map((f) => f.name)) === canonical(unexplained) &&
      doc.parts.unexplained.every((f) => f.acknowledged),
    `${tag}: export lists every finding as acknowledged`,
  );
  const problems = validateSession(doc);
  ok(problems.length === 0, `${tag}: decision file valid: ${problems.join("; ")}`);

  // goto: stale, then back on the checked revision the same report holds again
  await host.goto(3);
  ok(store.partsCheck.status === "stale", `${tag}: goto makes the report stale`);
  ok(partsCodes(store).includes("parts-unchecked"), `${tag}: goto blocks with parts-unchecked`);
  await host.goto(4);
  assertReady(ok, store, `${tag}: back on revision 4`);
  // new apply: stale; submit refreshes by itself
  await apply(ok, host, batches[4]!, "batch 5", tag);
  approveAll(store);
  ok(store.partsCheck.status === "stale", `${tag}: apply makes the report stale`);
  ok(partsCodes(store).includes("parts-unchecked"), `${tag}: apply blocks with parts-unchecked`);
  let submitted = await store.submit();
  assertReady(ok, store, `${tag}: submit refreshed`);
  ok(submitted === (codes(store).length === 0), `${tag}: submit result matches the refreshed blockers`);
  if (!submitted) {
    for (const name of unexplainedNames(store)) store.acknowledgePart(name);
    submitted = await store.submit();
  }
  ok(submitted && calls() === 2, `${tag}: submit after the refresh runs the handler (${codes(store)})`);
  await host.close();
}

async function seededFlow(ok: Asserter, kernel: KernelClient): Promise<void> {
  const tag = "docx seeded";
  const host = createEditorHost(kernel);
  const store = reviewStore(host);
  await host.open(baseBytes("docx"), BASE.docx);
  const submits = { n: 0 };
  // Read through a function: a direct `submits.n === 1` check would narrow the property to a literal type.
  const calls = (): number => submits.n;
  store.setSubmitHandler(async () => {
    submits.n++;
  });
  const link = (anchor: string, url: string): Op[] => [
    { op: "insert-hyperlink", anchor, position: "last-child", text: " See site", url } as Op,
  ];
  await apply(ok, host, link("para:~86bd68b3", "https://example.com/a"), "hyperlink a", tag);
  approveAll(store);
  await store.refreshParts();
  assertReady(ok, store, tag);
  const first = store.partsCheck.report!.unexplained.find((f) => f.name === RELS);
  ok(first && first.verdict === "unnamed", `${tag}: ${RELS} unnamed (${unexplainedNames(store)})`);
  ok(codes(store).includes("unexplained-parts"), `${tag}: unexplained-parts blocks`);
  ok((await store.submit()) === false && calls() === 0, `${tag}: submit blocked, handler not called`);
  for (const name of unexplainedNames(store)) store.acknowledgePart(name);
  ok(store.partAcknowledged(RELS), `${tag}: ${RELS} acknowledged`);
  ok((await store.submit()) === true && calls() === 1, `${tag}: submit after acknowledging`);
  const acked = await store.buildExport();
  ok(
    acked?.parts?.unexplained.some((f) => f.name === RELS && f.verdict === "unnamed" && f.acknowledged),
    `${tag}: export lists ${RELS} as acknowledged`,
  );

  // an edit of another part: the acknowledgement survives
  await apply(
    ok,
    host,
    [{ op: "set", target: "para:~5c74b0a5", value: { text: "Published 1 October 2026" } }],
    "date",
    tag,
  );
  approveAll(store);
  ok(!store.partAcknowledged(RELS), `${tag}: no acknowledgement reads on a stale report`);
  await store.refreshParts();
  assertReady(ok, store, `${tag}: after the date edit`);
  ok(unexplainedNames(store).includes(RELS), `${tag}: ${RELS} still unexplained`);
  ok(store.partAcknowledged(RELS), `${tag}: acknowledgement survives a change to another part`);

  // the relationships part changes again: the acknowledgement lapses
  await apply(ok, host, link("para:~cb035d44", "https://example.com/b"), "hyperlink b", tag);
  approveAll(store);
  await store.refreshParts();
  assertReady(ok, store, `${tag}: after hyperlink b`);
  ok(unexplainedNames(store).includes(RELS), `${tag}: ${RELS} unexplained after hyperlink b`);
  ok(!store.partAcknowledged(RELS), `${tag}: acknowledgement lapses when the part changes again`);
  ok(codes(store).includes("unexplained-parts"), `${tag}: blocked again`);
  ok((await store.submit()) === false && calls() === 1, `${tag}: submit blocked again`);

  // rejectOnly: the report follows the new cursor and only in-history entries
  const date = store.history().find((e) => e.label === "date")!;
  const shaBefore = host.getSnapshot().state!.sha256;
  const r = await store.rejectOnly(date);
  ok(r.ok, `${tag}: reject the date edit (${r.ok ? "" : r.reason})`);
  const state = host.getSnapshot().state!;
  ok(state.sha256 !== shaBefore && state.revision === 2, `${tag}: cursor on the new revision 2`);
  ok(store.partsCheck.status === "stale", `${tag}: report stale after rejectOnly`);
  await store.refreshParts();
  assertReady(ok, store, `${tag}: after rejectOnly`);
  const report = store.partsCheck.report!;
  ok(
    canonical(report.revisions) === canonical([1, 2]),
    `${tag}: report covers revisions 1 and 2 (${report.revisions})`,
  );
  ok(canonical(report) === canonical(await directReport(host)), `${tag}: report after rejectOnly equals the direct one`);
  ok(
    store
      .history()
      .filter((e) => e.revision <= state.revision)
      .every((e) => e.label !== "date"),
    `${tag}: the rejected edit is not before the cursor`,
  );
  for (const name of unexplainedNames(store)) store.acknowledgePart(name);
  ok((await store.submit()) === true && calls() === 2, `${tag}: submit after rejectOnly and acknowledging`);
  await host.close();
}

// ---- acknowledgement key: content identity ----

const enc = new TextEncoder();
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal one-disk archive of `items` (no ZIP64), stored or deflated. */
function zipOf(items: { name: string; data: Uint8Array }[], deflate = false): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff);
  const u32 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const rows = items.map((it) => {
    const name = enc.encode(it.name);
    const packed = deflate ? new Uint8Array(deflateRawSync(it.data)) : it.data;
    return { name, packed, crc: crc32(it.data), size: it.data.length, offset: 0 };
  });
  const fields = (r: (typeof rows)[number]) => {
    u16(20);
    u16(0x0800);
    u16(deflate ? 8 : 0);
    u16(0);
    u16(0x21);
    u32(r.crc);
    u32(r.packed.length);
    u32(r.size);
    u16(r.name.length);
    u16(0);
  };
  for (const r of rows) {
    r.offset = out.length;
    u32(0x04034b50);
    fields(r);
    out.push(...r.name, ...r.packed);
  }
  const cd = out.length;
  for (const r of rows) {
    u32(0x02014b50);
    u16(20);
    fields(r);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(r.offset);
    out.push(...r.name);
  }
  const cdSize = out.length - cd;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(rows.length);
  u16(rows.length);
  u32(cdSize);
  u32(cd);
  u16(0);
  return new Uint8Array(out);
}

async function keyIdentity(ok: Asserter): Promise<void> {
  const tag = "ack key";
  const rel = (url: string) =>
    enc.encode(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url}" TargetMode="External"/></Relationships>`,
    );
  const a = rel("https://example.com/a");
  const b = rel("https://example.com/b");
  ok(a.length === b.length, `${tag}: same size`);
  const za = zipOf([{ name: RELS, data: a }]);
  const zb = zipOf([{ name: RELS, data: b }]);
  ok(canonical([...partContent(za, RELS)!]) === canonical([...a]), `${tag}: partContent reads the stored part`);
  ok(partContent(za, "word/missing.xml") === null, `${tag}: partContent of a missing part is null`);
  ok(
    (await partKey(za, RELS, "changed")) !== (await partKey(zb, RELS, "changed")),
    `${tag}: same size, different content, different keys`,
  );
  ok(
    (await partKey(za, RELS, "changed")) === (await partKey(zipOf([{ name: RELS, data: a }], true), RELS, "changed")),
    `${tag}: same content stored or deflated gives the same key`,
  );
  ok((await partKey(za, RELS, "removed")) === `${RELS}|removed|-`, `${tag}: removed part key`);
  // Two same-size contents with the same CRC-32 (birthday search): a CRC-32 plus size key would match them.
  // Deterministic xorshift hex strings: sequential decimal strings vary in too few bits to collide.
  const seen = new Map<number, Uint8Array>();
  let pair: [Uint8Array, Uint8Array] | null = null;
  let s = 0x9e3779b9;
  const next = (): string => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0).toString(16).padStart(8, "0");
  };
  for (let i = 0; i < 1 << 20 && !pair; i++) {
    const data = enc.encode(`<x>${next()}${next()}</x>`);
    const c = crc32(data);
    const prev = seen.get(c);
    if (prev) pair = [prev, data];
    else seen.set(c, data);
  }
  ok(pair && pair[0].length === pair[1].length, `${tag}: CRC-32 collision found`);
  const [x, y] = pair;
  ok(crc32(x) === crc32(y), `${tag}: the pair shares its CRC-32`);
  const doc = "word/document.xml";
  ok(
    (await partKey(zipOf([{ name: doc, data: x }]), doc, "changed")) !==
      (await partKey(zipOf([{ name: doc, data: y }]), doc, "changed")),
    `${tag}: a CRC-32 collision of the same size gives different keys`,
  );
}

async function failingOriginal(ok: Asserter, kernel: KernelClient): Promise<void> {
  const tag = "original mismatch";
  // Same kernel, but session() reports another original sha256, so originalBytes must reject.
  const wrapped = new Proxy(kernel, {
    get(target, prop, receiver) {
      if (prop === "session")
        return async (doc: Parameters<KernelClient["session"]>[0]) => ({
          ...(await target.session(doc)),
          originalSha256: "0".repeat(64),
        });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const host = createEditorHost(wrapped);
  const store = reviewStore(host);
  await host.open(baseBytes("docx"), BASE.docx);
  await apply(ok, host, sessionBatches("docx")[0]!, "batch 1", tag);
  approveAll(store);
  await store.refreshParts();
  const pc = store.partsCheck;
  ok(pc.status === "failed" && pc.error && pc.report === null, `${tag}: check failed (${pc.status}: ${pc.error})`);
  ok(host.getSnapshot().state!.revision === 1, `${tag}: host back on revision 1`);
  const blockers = store.submitBlockers();
  ok(
    blockers.length === 1 &&
      blockers[0]!.code === "parts-unchecked" &&
      blockers[0]!.message.includes("could not be checked"),
    `${tag}: parts-unchecked says why (${JSON.stringify(blockers)})`,
  );
  const submits = { n: 0 };
  // Read through a function: a direct `submits.n === 0` check would narrow the property to a literal type.
  const calls = (): number => submits.n;
  store.setSubmitHandler(async () => {
    submits.n++;
  });
  ok((await store.submit()) === false && calls() === 0, `${tag}: submit never passes`);
  ok(store.partsCheck.status === "failed", `${tag}: still failed after the submit retry`);
  ok((await store.buildExport())?.parts === null, `${tag}: export has no parts`);
  await host.close();
}

/** Runs every case that applies to `format`; one kernel is reused across the hosts. */
export async function run(ctx: EngineContext, format: Format): Promise<CheckOutcome> {
  const ok: Asserter = createAsserter();
  const facts: Facts = { notes: [], data: {} };
  const kernel = ctx.kernel();
  ctx.log(`parts-gate ${format}: session flow`);
  await sessionFlow(ok, kernel, format, facts);
  if (format === "docx") {
    ctx.log("parts-gate docx: seeded flow");
    await seededFlow(ok, kernel);
    ctx.log("parts-gate docx: original mismatch");
    await failingOriginal(ok, kernel);
    facts.notes.push("docx cases ran: seeded hyperlink flow (relationships part), original sha256 mismatch");
  } else {
    facts.notes.push(`${format}: the docx cases (seeded relationships flow, original mismatch) are docx-only as in the prototype and ran with the docx format`);
  }
  ctx.log(`parts-gate ${format}: acknowledgement key identity`);
  await keyIdentity(ok);
  return { checks: ok.count, notes: facts.notes, data: { ...facts.data, docxCasesRan: format === "docx" } };
}
