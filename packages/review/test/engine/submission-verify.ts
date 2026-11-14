// Verifier of a review submission for the `submission` check. Nothing the browser sends is trusted: the
// file a caller keeps is the output of replaying the session's operations on the base file. Ported
// from the prototype review demo's server-side verifier; the replay runs on a kernel the caller
// passes in (a second, pinned reactor kernel next to the one the review ran on) instead of a spawned
// replay tool, and the demo server process itself has no counterpart here (`postSubmission` is its
// request handling without the transport).
//
// Checks, in order (each `pass`, `fail` or `skipped`, with a detail line):
//   proposal-known      (by id only) the submission names a proposal the verifier knows; when it does
//                       not, this fails and nothing else runs
//   base-sha256         sha256 of the verifier's base file equals session.originalSha256
//   bytes-sha256        sha256 of the submitted bytes equals the submitted sha256
//   wasm-replay         replays session.batches on the base, every batch with the clock and zone the
//                       session records for it (the batch's own `clock`/`timezone`, else the session's),
//                       locale en-US and seed 0; every step must reproduce the batch's baseSha256 and
//                       resultSha256 and the output sha256 must equal the submitted sha256. Fails on a
//                       locale other than en-US, a seed other than 0, a clock that is not a UTC instant to
//                       the second (YYYY-MM-DDTHH:MM:SSZ), a zone that is not an IANA name or not one this
//                       runtime knows, a submitted name that is not the session's, or the engine's refusal.
//                       The times come from the reviewer's browser and are not checked against any clock
//                       here: any clock that makes the replay produce the submitted sha256 proves the bytes
//                       are exactly those operations applied to the base at that time.
//   rejected-absent     the decision export agrees with the session: nothing is `pending`; entries 1..n in
//                       history map to session batches 1..n and are approved; entries past them (redo tail)
//                       or removed are rejected; each batch has one op hunk per op. With the proposal: the
//                       session batches are the proposal's batches in order, each minus exactly its entry's
//                       `rejected_ops` by index, and each rejected op is the proposal's op at that index.
//                       Without it: no op of a batch deep-equals one of its rejected ops
//   parts-acknowledged  `decision.parts` (the store's package parts check): `checked_sha256` is the
//                       submitted sha256 and every `unexplained` part is `acknowledged: true`. Skipped when
//                       the decision has no `parts` member, or when it is null and the file is the base file;
//                       null with batches fails
// Verdict `verified` when every check passes or is skipped, otherwise `rejected`.
import { createHash } from "node:crypto";
import type { KernelClient, Op } from "@wolfsdk/protocol";
import type { Proposal } from "./submission-proposals.ts";

/** Untrusted JSON as submitted: the checks below validate every member they read. */
type Json = any;

/** The pinned environment (`ReactorKernelOptions.environment` default). Locale and seed must always be these. */
export const PINNED = { clock: "2026-01-01T00:00:00Z", timezone: "UTC", locale: "en-US", seed: 0 } as const;
/** The clock form the kernel records: a UTC instant to the second. */
const CLOCK_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** IANA zone name shape (`UTC`, `America/New_York`, `Etc/GMT+5`); the engine refuses unknown ones. */
const ZONE_FORM = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export type Check = { name: string; status: "pass" | "fail" | "skipped"; detail: string };
export type Verdict = {
  verdict: "verified" | "rejected";
  failed: string[];
  checks: Check[];
  /** The replay output (the file to keep); null unless the replay succeeded. */
  output: Uint8Array | null;
  outputSha256: string | null;
};

/** What the page posts, as far as the verifier reads it. */
export type Submission = {
  name?: string;
  sha256: string;
  session: Json;
  bytes: string | Uint8Array;
  decision: Json;
};

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** True when the runtime's time zone database knows `zone`. */
function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

type PlannedBatch = { clock: string; timezone: string };

/**
 * The replay of a session: per batch the clock and zone it ran with (its own, else the session's), and
 * the problems that make a faithful replay impossible.
 */
function replayPlan(session: Json): { problems: string[]; clocks: PlannedBatch[] } {
  if (!session || typeof session !== "object" || !Array.isArray(session.batches))
    return { problems: ["session has no batches array"], clocks: [] };
  const problems: string[] = [];
  for (const key of ["locale", "seed"] as const)
    if (session[key] !== PINNED[key])
      problems.push(`session ${key} ${JSON.stringify(session[key])} is not ${JSON.stringify(PINNED[key])}`);
  const clocks = (session.batches as Json[]).map((batch, i) => {
    if (!batch || !Array.isArray(batch.ops) || batch.ops.length === 0) problems.push(`batch ${i + 1} has no ops`);
    else if (!batch.ops.every((op: unknown) => op && typeof op === "object" && !Array.isArray(op)))
      problems.push(`batch ${i + 1} holds a non-object op`);
    const clock = batch?.clock ?? session.clock;
    const timezone = batch?.timezone ?? session.timezone;
    if (
      typeof clock !== "string" ||
      !CLOCK_FORM.test(clock) ||
      Number.isNaN(Date.parse(clock)) ||
      new Date(clock).toISOString().replace(".000Z", "Z") !== clock
    )
      problems.push(`batch ${i + 1} clock ${JSON.stringify(clock)} is not a UTC instant YYYY-MM-DDTHH:MM:SSZ`);
    if (typeof timezone !== "string" || !ZONE_FORM.test(timezone))
      problems.push(`batch ${i + 1} timezone ${JSON.stringify(timezone)} is not an IANA zone name`);
    else if (!knownZone(timezone))
      problems.push(`batch ${i + 1} timezone ${JSON.stringify(timezone)} is not a zone this runtime knows`);
    return { clock, timezone } as PlannedBatch;
  });
  return { problems, clocks };
}

/** One line on the clocks a replay ran with, for the check's detail. */
function clocksDetail(clocks: PlannedBatch[]): string {
  if (clocks.every((c) => c.clock === PINNED.clock && c.timezone === PINNED.timezone))
    return `pinned clock ${PINNED.clock} ${PINNED.timezone}`;
  const distinct = new Set(clocks.map((c) => `${c.clock} ${c.timezone}`));
  const zones = [...new Set(clocks.map((c) => c.timezone))].join(", ");
  return `each batch at its recorded clock (${distinct.size} distinct, ${clocks[0]!.clock} to ${clocks.at(-1)!.clock}, zone ${zones})`;
}

/** Canonical JSON (sorted keys) for comparing ops. Independent of the review store's own helper. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type Decided = { ok: boolean; detail: string; ops: Op[][] | null };

/**
 * Check `rejected-absent`. Decision export semantics: entry `decision` is approve | reject | pending (also
 * on `hunks[]` and `review_decision.decisions[]`); in-history entries come first in revision order and entry
 * k <= session.revision is session batch k; in-history entries after it are the redo tail; an entry whose ops
 * were all rejected has `in_history: false` and no batch; `rejected_ops[].index` is the op's position in the
 * originally proposed batch and a kept batch holds the other ops in their original order. `proposal` is the
 * verifier's own copy of the proposed batches. When it is given and the check passes, `ops` holds the
 * verifier's own copy of every session batch (the matched proposed batch minus its rejected ops), which is
 * what the replay runs; otherwise `ops` is null.
 */
function checkDecision(decision: Json, session: Json, sha256: string, proposal: Op[][] | undefined): Decided {
  if (!decision || typeof decision !== "object" || !Array.isArray(decision.entries))
    return { ok: false, detail: "decision has no entries array", ops: null };
  const problems: string[] = [];
  const kept: Op[][] = [];
  const batches: Json[] = Array.isArray(session?.batches) ? session.batches : [];
  if (session?.revision !== undefined && session.revision !== batches.length)
    problems.push(`session revision ${session.revision} is not its ${batches.length} batches`);
  if (decision.summary && Number(decision.summary.undecided) > 0)
    problems.push(`summary counts ${decision.summary.undecided} undecided`);
  if (decision.current_sha256 !== undefined && decision.current_sha256 !== sha256)
    problems.push(`decision current_sha256 ${decision.current_sha256} is not the submitted sha256`);
  /** Decision entry of each session batch, by batch index. */
  const byBatch: Json[] = [];
  let rejected = 0;
  let wholly = 0;
  for (const entry of decision.entries as Json[]) {
    const revision = entry?.revision;
    const removed = entry?.in_history === false;
    const inFile = !removed && Number.isInteger(revision) && revision >= 1 && revision <= batches.length;
    const tag = `entry ${revision ?? "?"}${removed ? " (removed)" : inFile ? "" : " (redo tail)"}`;
    if (entry?.decision === "pending") problems.push(`${tag} is pending`);
    else if (inFile && entry?.decision !== "approve")
      problems.push(`${tag} is ${JSON.stringify(entry?.decision)}, not approve`);
    else if (!inFile && entry?.decision !== "reject")
      problems.push(`${tag} is ${JSON.stringify(entry?.decision)} but not in the file`);
    if (!inFile) wholly++;
    for (const hunk of Array.isArray(entry?.hunks) ? entry.hunks : [])
      if (hunk?.decision === "pending") problems.push(`${tag} hunk ${hunk.op ?? hunk.index ?? "?"} is pending`);
    for (const d of entry?.review_decision?.decisions ?? [])
      if (d?.decision === "pending") problems.push(`${tag} change ${d.index} is pending`);
    if (entry?.rejected_ops !== undefined && !Array.isArray(entry.rejected_ops)) {
      problems.push(`${tag} rejected_ops is not an array`);
      continue;
    }
    const ops: Json[] = entry?.rejected_ops ?? [];
    rejected += ops.length;
    const indices = ops.map((r) => r?.index);
    if (ops.some((r) => !Number.isInteger(r?.index) || r.index < 0 || !r.op || typeof r.op !== "object"))
      problems.push(`${tag} has a malformed rejected op`);
    else if (new Set(indices).size !== indices.length) problems.push(`${tag} rejects one op index twice`);
    if (!inFile) continue; // no session batch: none of its ops were replayed
    if (byBatch[revision - 1]) problems.push(`${tag} appears twice`);
    byBatch[revision - 1] = entry;
    const batch = batches[revision - 1];
    if (entry.base_sha256 !== undefined && entry.base_sha256 !== batch.baseSha256)
      problems.push(`${tag} base_sha256 differs from session batch ${revision}`);
    if (entry.result_sha256 !== undefined && entry.result_sha256 !== batch.resultSha256)
      problems.push(`${tag} result_sha256 differs from session batch ${revision}`);
    if (Array.isArray(entry.hunks)) {
      const opHunks = entry.hunks.filter((h: Json) => h?.op !== null && h?.op !== undefined).length;
      if (opHunks !== batch.ops.length)
        problems.push(`${tag} has ${opHunks} op hunks but session batch ${revision} holds ${batch.ops.length} ops`);
    }
    if (ops.some((r) => r.index >= batch.ops.length + ops.length))
      problems.push(`${tag} rejects an op index past the proposed batch`);
    if (!proposal) {
      const present = new Set((batch.ops as Json[]).map(canonicalJson));
      for (const r of ops)
        if (r?.op && present.has(canonicalJson(r.op)))
          problems.push(`${tag} rejected op ${r.index} (${r.op.op}) is still in session batch ${revision}`);
    }
  }
  for (let k = 0; k < batches.length; k++)
    if (!byBatch[k]) problems.push(`session batch ${k + 1} has no decision entry`);
  if (proposal && problems.length === 0) {
    // Each session batch must be the next proposed batch (in order, skipping wholly rejected ones) minus
    // exactly the ops its entry rejects, compared position by position.
    let next = 0;
    for (let k = 0; k < batches.length; k++) {
      const rejects = new Map<number, Json>((byBatch[k].rejected_ops ?? []).map((r: Json) => [r.index, r.op]));
      let found = -1;
      for (let j = next; j < proposal.length && found < 0; j++) {
        const ops = proposal[j]!;
        if (ops.length !== batches[k].ops.length + rejects.size) continue;
        if (![...rejects].every(([i, op]) => i < ops.length && canonicalJson(ops[i]) === canonicalJson(op))) continue;
        if (canonicalJson(ops.filter((_, i) => !rejects.has(i))) === canonicalJson(batches[k].ops)) found = j;
      }
      if (found >= 0) kept.push(proposal[found]!.filter((_, i) => !rejects.has(i)));
      else {
        problems.push(
          `session batch ${k + 1} is not a proposed batch after batch ${next} minus the ${rejects.size} op(s) its entry rejects`,
        );
        break;
      }
      next = found + 1;
    }
    const skipped = proposal.length - batches.length;
    if (problems.length === 0 && skipped > wholly)
      problems.push(`${skipped} proposed batches are not in the file but only ${wholly} entries are rejected as a whole`);
  }
  return problems.length
    ? { ok: false, detail: problems.join("; "), ops: null }
    : {
        ok: true,
        detail:
          `${decision.entries.length} entries decided (${batches.length} in the file), ${rejected} rejected op(s) absent from the session` +
          (proposal
            ? `, every batch matches the ${proposal.length}-batch proposal by position`
            : ", no proposal given: position checks skipped"),
        ops: proposal ? kept : null,
      };
}

/** Check `parts-acknowledged`: the store's package parts check, as the decision exported it. */
function checkParts(decision: Json, session: Json, sha256: string): { status: Check["status"]; detail: string } {
  if (!decision || typeof decision !== "object" || !("parts" in decision))
    return { status: "skipped", detail: "the decision has no parts member (exported by a store without the parts check)" };
  const parts = decision.parts;
  const batches = Array.isArray(session?.batches) ? session.batches.length : 0;
  if (parts === null)
    return batches === 0
      ? { status: "skipped", detail: "parts is null and the file is the base file: nothing to check" }
      : { status: "fail", detail: `parts is null: a file with ${batches} batch(es) was submitted without a parts check` };
  if (typeof parts !== "object" || !Array.isArray(parts.unexplained))
    return { status: "fail", detail: "parts has no unexplained array" };
  const problems: string[] = [];
  if (parts.checked_sha256 !== sha256)
    problems.push(`parts were checked on ${parts.checked_sha256 ?? "no file"}, not the submitted ${sha256}`);
  const open = (parts.unexplained as Json[]).filter((u) => u?.acknowledged !== true);
  if (open.length)
    problems.push(
      `${open.length} unexplained part(s) not acknowledged: ${open.map((u) => `${u?.name} (${u?.status})`).join(", ")}`,
    );
  return problems.length
    ? { status: "fail", detail: problems.join("; ") }
    : {
        status: "pass",
        detail: `parts checked on the submitted file: ${parts.changed} changed, ${parts.unexplained.length} unexplained, all acknowledged`,
      };
}

type ReplayBatch = { ops: Op[]; baseSha256?: string; resultSha256?: string; clock: string; timezone: string };
type Replayed = { ok: true; bytes: Uint8Array; sha256: string } | { ok: false; detail: string };

/**
 * Replays already run, by input (base file, batches, clocks). A replay is a function of exactly those, so
 * the same session submitted again (the ad hoc form of a verification, a copy with only its decision or
 * bytes edited) is served from here instead of being replayed a second time. Every verification still
 * compares the replay output with its own submitted sha256 and runs every other check itself.
 */
export type ReplayCache = { runs: Map<string, Promise<Replayed>>; requested: number };

/**
 * Replay `batches` on `base` on `kernel`, each batch at its own clock and zone (`apply(..., at)`), checking
 * every step's base and result sha256. The document is closed before returning.
 */
async function replayOn(kernel: KernelClient, base: Uint8Array, name: string, batches: ReplayBatch[]): Promise<Replayed> {
  let doc: string | undefined;
  try {
    let state = await kernel.open(base, name);
    doc = state.doc;
    for (const [i, b] of batches.entries()) {
      const at = `${b.clock} ${b.timezone}`;
      if (b.baseSha256 !== undefined && b.baseSha256 !== state.sha256)
        return { ok: false, detail: `batch ${i + 1} starts from ${state.sha256}, the session records base ${b.baseSha256}` };
      const r = await kernel.apply(doc, b.ops, { clock: b.clock, timezone: b.timezone });
      if (!r.ok) return { ok: false, detail: `batch ${i + 1} refused at ${at}: ${r.error.code}: ${r.error.message}` };
      if (b.resultSha256 !== undefined && b.resultSha256 !== r.state.sha256)
        return {
          ok: false,
          detail: `batch ${i + 1} at ${at} gives ${r.state.sha256}, the session records result ${b.resultSha256}`,
        };
      state = r.state;
    }
    const bytes = await kernel.save(doc);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== state.sha256)
      return { ok: false, detail: `replay output hashes to ${sha256}, not the revision's ${state.sha256}` };
    return { ok: true, bytes, sha256 };
  } catch (error) {
    return { ok: false, detail: `replay failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (doc !== undefined) await kernel.close(doc).catch(() => {});
  }
}

function toBytes(bytes: unknown): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof bytes === "string") return new Uint8Array(Buffer.from(bytes, "base64"));
  throw new TypeError("bytes must be a Uint8Array or a base64 string");
}

/** Where the replay runs and the verifier's own copy of the base file. */
export type VerifyEnv = { kernel: KernelClient; base: { name: string; bytes: Uint8Array }; cache: ReplayCache };

/**
 * Verifies `submission` against the base file in `env`. `proposal`: the proposed batches (op arrays) from
 * the caller's own records, never from the submission; enables the position-exact form of `rejected-absent`.
 */
export async function verifySubmission(
  submission: Submission & { proposal?: Op[][] },
  env: VerifyEnv,
): Promise<Verdict> {
  const { name, sha256, session, bytes, decision, proposal } = submission;
  const checks: Check[] = [];
  const add = (check: string, status: Check["status"], detail: string) => checks.push({ name: check, status, detail });
  const baseSha = sha256Hex(env.base.bytes);

  add(
    "base-sha256",
    session?.originalSha256 === baseSha ? "pass" : "fail",
    `base ${env.base.name} ${baseSha}, session original ${session?.originalSha256 ?? "missing"}`,
  );

  let submitted: Uint8Array | null = null;
  try {
    submitted = toBytes(bytes);
  } catch (error) {
    add("bytes-sha256", "fail", error instanceof Error ? error.message : String(error));
  }
  if (submitted) {
    const got = sha256Hex(submitted);
    const wellFormed = typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256);
    add(
      "bytes-sha256",
      wellFormed && got === sha256 ? "pass" : "fail",
      `bytes (${submitted.byteLength}) hash to ${got}, submitted sha256 ${wellFormed ? sha256 : JSON.stringify(sha256)}`,
    );
  }

  // wasm-replay and rejected-absent: replay one session log, per batch the operations (the verifier's own
  // copy when the proposal is known and rejected-absent passes, else the session's), the clock and zone the
  // session records for it, and its base and result sha256 for the step checks.
  let output: Uint8Array | null = null;
  let outputSha256: string | null = null;
  const { problems, clocks } = replayPlan(session);
  if (name !== undefined && session?.name !== undefined && name !== session.name)
    problems.push(`submitted name ${JSON.stringify(name)} is not the session name ${JSON.stringify(session.name)}`);
  // rejected-absent first: it yields the operations to replay. Reported in the usual order below.
  const d = checkDecision(decision, session, sha256, proposal);
  if (problems.length) add("wasm-replay", "fail", problems.join("; "));
  else if (session.batches.length === 0) {
    // Everything was rejected: the approved file is the base file.
    output = env.base.bytes;
    outputSha256 = baseSha;
    add("wasm-replay", baseSha === sha256 ? "pass" : "fail", `no batches: the output is the base file ${baseSha}`);
  } else {
    const planned: ReplayBatch[] = (session.batches as Json[]).map((b, i) => ({
      ops: d.ops?.[i] ?? b.ops,
      baseSha256: typeof b.baseSha256 === "string" ? b.baseSha256 : undefined,
      resultSha256: typeof b.resultSha256 === "string" ? b.resultSha256 : undefined,
      clock: clocks[i]!.clock,
      timezone: clocks[i]!.timezone,
    }));
    const key = JSON.stringify([env.base.name, planned]);
    env.cache.requested++;
    let replay = env.cache.runs.get(key);
    if (!replay) {
      replay = replayOn(env.kernel, env.base.bytes, env.base.name, planned);
      env.cache.runs.set(key, replay);
    }
    const r = await replay;
    const what = `${planned.length} batch(es) of ${d.ops ? "the verifier's copy of the proposal" : "the session's operations"}, ${clocksDetail(clocks)}`;
    if (!r.ok) add("wasm-replay", "fail", `${what}: ${r.detail}`);
    else {
      output = r.bytes;
      outputSha256 = r.sha256;
      add("wasm-replay", r.sha256 === sha256 ? "pass" : "fail", `${what}, replayed on a second kernel, output ${r.sha256}`);
    }
  }
  add("rejected-absent", d.ok ? "pass" : "fail", d.detail);
  const f = checkParts(decision, session, sha256);
  add("parts-acknowledged", f.status, f.detail);

  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  return { verdict: failed.length ? "rejected" : "verified", failed, checks, output, outputSha256 };
}

/** What the verifier knows about proposals: their records, and the base files by fixtures-relative path. */
export type ProposalEnv = {
  kernel: KernelClient;
  cache: ReplayCache;
  known: readonly Proposal[];
  baseBytes(relative: string): Uint8Array;
};

/**
 * What the server runs: the submission names its proposal by id, and the base file and proposed batches come
 * from the verifier's records, never from the submission. A missing or unknown id fails `proposal-known`
 * and nothing else runs.
 */
export async function verifyProposalSubmission(
  submission: Submission & { proposal?: unknown },
  env: ProposalEnv,
): Promise<Verdict> {
  const id = submission.proposal;
  const known = typeof id === "string" ? env.known.find((p) => p.id === id) : undefined;
  if (!known) {
    const detail = `${id === undefined ? "the submission names no proposal" : `unknown proposal ${JSON.stringify(id)}`}; expected one of ${env.known.map((p) => p.id).join(", ")}`;
    return {
      verdict: "rejected",
      failed: ["proposal-known"],
      checks: [{ name: "proposal-known", status: "fail", detail }],
      output: null,
      outputSha256: null,
    };
  }
  const result = await verifySubmission(
    { ...submission, proposal: known.batches.map((b) => b.ops) },
    { kernel: env.kernel, cache: env.cache, base: { name: known.base.split("/").at(-1)!, bytes: env.baseBytes(known.base) } },
  );
  result.checks.unshift({
    name: "proposal-known",
    status: "pass",
    detail: `proposal ${known.id}: base ${known.base}, ${known.batches.length} proposed batch(es)`,
  });
  return result;
}

/** The answer to one post, as the demo server's `/submit` gave it. */
export type PostAnswer = { verdict: Verdict["verdict"]; checks: Check[]; failed: string[]; sha256: string | null };

/**
 * One request of the demo server without its transport: `body` goes through a JSON round trip as it would
 * on the wire, and only the fields the server reads are used (`proposal`, `name`, `sha256`, `session`,
 * `bytes`, `decision`); anything else it carries, such as a stale `base` member, is ignored.
 */
export async function postSubmission(body: object, env: ProposalEnv): Promise<PostAnswer> {
  const wire = JSON.parse(JSON.stringify(body)) as Json;
  const result = await verifyProposalSubmission(
    {
      proposal: wire.proposal,
      name: wire.name,
      sha256: wire.sha256,
      session: wire.session,
      bytes: wire.bytes,
      decision: wire.decision,
    },
    env,
  );
  return { verdict: result.verdict, checks: result.checks, failed: result.failed, sha256: result.outputSha256 };
}
