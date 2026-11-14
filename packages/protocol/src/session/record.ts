// The review record: the decision file the review panel writes (`wolfsdk.review-session.v1`, one
// `wolfsuite.review-decision.v1` document per entry), built and checked without the editor. Nothing
// here touches the DOM, Preact or a kernel, so other surfaces that review recorded batches can write
// the same file (`@wolfsdk/protocol`).
import type { Change, Op } from "../contract.ts";
import decisionSchema from "../../schemas/review-decision.v1.schema.json" with { type: "json" };
import sessionSchema from "../../schemas/review-session.v1.schema.json" with { type: "json" };

export type Decision = "approve" | "reject" | "pending";
export type ChangeType = Change["change"];

export const DECISION_CONTRACT = "wolfsuite.review-decision.v1";
export const SESSION_CONTRACT = "wolfsdk.review-session.v1";

/** Same bytes as wolfsuite `canonical_json`: sorted keys, no whitespace. */
export function canonical(value: unknown, floatNumbers = false): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v, floatNumbers)).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            (floatNumbers && k === "number" && Number.isInteger(o[k]) ? `${o[k]}.0` : canonical(o[k], floatNumbers)),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type DecisionDoc = {
  contract: typeof DECISION_CONTRACT;
  receipt: { path: string; sha256: string };
  base_receipt: null;
  request_identity: null;
  base_sha256: string;
  result_sha256: string;
  diff_identity: string;
  diff_identity_verified: boolean;
  complete: boolean;
  counts: { approve: number; reject: number; pending: number };
  decisions: {
    index: number;
    address: string;
    change: ChangeType;
    kind: string;
    cause?: number;
    decision: Decision;
    regions: { before: string | null; after: string | null };
  }[];
  decided_at: string;
};

/** Whether `identity` (the engine's `transaction.diff.identity`) names exactly `changes`. */
export async function diffIdentityVerified(identity: string, changes: Change[]): Promise<boolean> {
  // JSON.parse loses the difference between 30 and 30.0; the engine's typed `number`
  // values are floats, so a second attempt writes integral numbers with ".0".
  return (
    identity === "sha256:" + (await sha256Hex(canonical(changes))) ||
    identity === "sha256:" + (await sha256Hex(canonical(changes, true)))
  );
}

/** One `wolfsuite.review-decision.v1` document for one applied batch. `changes` and `diffIdentity` are the
 * batch's `transaction.diff` as the engine returned it. Each change takes `changeDecision(index)` (default:
 * `decision`); `regions(index)` names the region object ids the change was seen on (default: none). */
export async function decisionDoc(args: {
  receiptPath: string;
  baseSha256: string;
  resultSha256: string;
  changes: Change[];
  diffIdentity: string;
  decision: Decision;
  changeDecision?: (index: number) => Decision;
  regions?: (index: number) => { before: string | null; after: string | null };
  decidedAt: number;
}): Promise<DecisionDoc> {
  const { changes, decision, changeDecision, regions } = args;
  const counts = { approve: 0, reject: 0, pending: 0 };
  const decisions = changes.map((c, index) => {
    const d = changeDecision ? changeDecision(index) : decision;
    counts[d] += 1;
    const row: DecisionDoc["decisions"][number] = {
      index,
      address: c.address,
      change: c.change,
      kind: c.kind,
      decision: d,
      regions: regions ? regions(index) : { before: null, after: null },
    };
    if (typeof c.cause === "number") row.cause = c.cause;
    return row;
  });
  return {
    contract: DECISION_CONTRACT,
    receipt: { path: args.receiptPath, sha256: args.resultSha256 },
    base_receipt: null,
    request_identity: null,
    base_sha256: args.baseSha256,
    result_sha256: args.resultSha256,
    diff_identity: args.diffIdentity,
    diff_identity_verified: await diffIdentityVerified(args.diffIdentity, changes),
    complete: decision !== "pending" && counts.pending === 0,
    counts,
    decisions,
    decided_at: isoSeconds(args.decidedAt),
  };
}

/** Identity of the engine module that produced the batches. */
export type EngineIdentity = {
  version: string;
  commit: string;
  moduleSha256: string;
  moduleBytes: number;
  builtAt: string;
};

export type SessionEntry = {
  revision: number;
  label: string;
  source: string;
  applied_at: string;
  decision: Decision;
  in_history: boolean;
  base_sha256: string;
  result_sha256: string;
  /** One per hunk of the entry (`hunksOf`); `change_indices` index the entry's changes. */
  hunks: { op: number | null; decision: Decision; change_indices: number[] }[];
  /** Ops removed from this entry by `rejectOps`, at their index in the originally proposed batch. */
  rejected_ops: { index: number; op: Op }[];
  review_decision: DecisionDoc;
  /** The batch no longer applies after an earlier entry was rejected; its decision is pending. */
  conflict?: { code: string; message: string };
  /** A recorded batch re-executed live: whether it reached the recorded result sha256. */
  verified?: "tape-match" | "tape-mismatch";
};

export type SessionExport = {
  contract: typeof SESSION_CONTRACT;
  document: { name: string; format: string };
  original_sha256: string;
  final_sha256: string;
  current_sha256: string;
  summary: { approve: number; reject: number; undecided: number };
  complete: boolean;
  decided_at: string;
  /** The engine module the entries were applied with, when the writer knows it. */
  engine?: EngineIdentity;
  entries: SessionEntry[];
  /** Package parts of the current revision against the original file; null when the current revision has not been checked. */
  parts: {
    checked_sha256: string;
    changed: number;
    recompressed: string[];
    unexplained: {
      name: string;
      status: "added" | "removed" | "changed";
      verdict: "explained" | "unnamed" | "unreported";
      acknowledged: boolean;
    }[];
  } | null;
};

// Minimal JSON-schema evaluator covering the keywords the two schemas use (type, const, enum,
// pattern, minimum, minLength, required, properties, additionalProperties, items, anyOf, $ref to
// "#/..." or to the other schema's $id).
export type Schema = {
  $id?: string;
  $ref?: string;
  anyOf?: Schema[];
  const?: unknown;
  enum?: unknown[];
  type?: string | string[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  items?: Schema;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  [keyword: string]: unknown;
};

export const DECISION_SCHEMA: Schema = decisionSchema;
export const SESSION_SCHEMA: Schema = sessionSchema;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "number":
      return typeof v === "number";
    default:
      return true;
  }
}

function resolve(ref: string, root: Schema): Schema | undefined {
  let node: unknown = root;
  for (const k of ref.replace(/^#\//, "").split("/")) node = isObject(node) ? node[k] : undefined;
  return isObject(node) ? (node as Schema) : undefined;
}

function check(schema: Schema, value: unknown, root: Schema, path: string, out: string[]): void {
  if (schema.$ref) {
    const external = [DECISION_SCHEMA, SESSION_SCHEMA].find((s) => s.$id === schema.$ref);
    if (external) return check(external, value, external, path, out);
    const target = resolve(schema.$ref, root);
    if (!target) return void out.push(`${path}: unresolved $ref ${schema.$ref}`);
    return check(target, value, root, path, out);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => {
      const o: string[] = [];
      check(s, value, root, path, o);
      return o.length === 0;
    });
    if (!ok) out.push(`${path}: matches none of anyOf`);
    return;
  }
  if ("const" in schema && value !== schema.const) out.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) return void out.push(`${path}: expected ${types.join("|")}`);
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      out.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength && value.length < schema.minLength) out.push(`${path}: too short`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
    out.push(`${path}: below minimum`);
  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((v, i) => check(items, v, root, `${path}[${i}]`, out));
  }
  if (isObject(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) check(sub, v, root, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected ${k}`);
    }
  }
}

/** Problems of `value` against `schema` (empty when valid). A `$ref` to the other packaged schema's `$id` resolves. */
export function validateSchema(schema: Schema, value: unknown): string[] {
  const out: string[] = [];
  check(schema, value, schema, "$", out);
  return out;
}

/** Problems of a `wolfsuite.review-decision.v1` document (empty when valid). */
export function validateDecision(doc: unknown, schema: Schema = DECISION_SCHEMA): string[] {
  return validateSchema(schema, doc);
}

/** Problems of a `wolfsdk.review-session.v1` file: its schema, every entry's decision document (against
 * `decision`, default the packaged copy), and the members that must agree with each other. */
export function validateSession(file: unknown, decision: Schema = DECISION_SCHEMA): string[] {
  const out = validateSchema(SESSION_SCHEMA, file).filter((p) => !/^\$\.entries\[\d+\]\.review_decision/.test(p));
  if (!isObject(file)) return out;
  const counts = { approve: 0, reject: 0, undecided: 0 };
  const entries = Array.isArray(file.entries) ? file.entries : [];
  entries.forEach((e: unknown, i) => {
    if (!isObject(e)) return;
    if (e.decision === "approve" || e.decision === "reject") counts[e.decision]++;
    else counts.undecided++;
    if (e.conflict !== undefined && e.decision !== "pending")
      out.push(`$.entries[${i}]: a conflicting entry must be pending`);
    const rd = e.review_decision;
    if (!isObject(rd)) return;
    for (const p of validateDecision(rd, decision)) out.push(`$.entries[${i}].review_decision${p.slice(1)}`);
    if (rd.result_sha256 !== e.result_sha256)
      out.push(`$.entries[${i}]: result sha256 differs from its review_decision`);
    if (rd.base_sha256 !== e.base_sha256) out.push(`$.entries[${i}]: base sha256 differs from its review_decision`);
  });
  const summary = isObject(file.summary) ? file.summary : {};
  for (const k of ["approve", "reject", "undecided"] as const)
    if (counts[k] !== summary[k]) out.push(`$.summary.${k}: ${String(summary[k])} != ${counts[k]}`);
  if (file.complete !== (counts.undecided === 0)) out.push("$.complete: disagrees with summary.undecided");
  return out;
}
