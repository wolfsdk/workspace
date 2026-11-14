import { expect, test } from "bun:test";
import {
  DECISION_SCHEMA,
  canonical,
  SESSION_CONTRACT,
  SESSION_SCHEMA,
  entryDecisionDoc,
  hunksOf,
  isoSeconds,
  sha256Hex,
  validateDecision,
  validateSession,
  type SessionExport,
} from "../src/index.ts";
import decisionSchema from "../schemas/review-decision.v1.schema.json" with { type: "json" };
import sessionSchema from "../schemas/review-session.v1.schema.json" with { type: "json" };
import { twoOpEntry } from "./fixtures.ts";

async function buildSession(): Promise<SessionExport> {
  const entry = twoOpEntry();
  const identity = `sha256:${await sha256Hex(canonical(entry.diff))}`;
  entry.transaction = { ...entry.transaction, diff: { changes: entry.diff, identity } } as typeof entry.transaction;
  const decidedAt = Date.UTC(2026, 0, 2);
  const review_decision = await entryDecisionDoc({
    entry,
    decision: "approve",
    docName: "book.xlsx",
    seen: new Map(),
    decidedAt,
  });
  return {
    contract: SESSION_CONTRACT,
    document: { name: "book.xlsx", format: "xlsx" },
    original_sha256: entry.baseSha256,
    final_sha256: entry.resultSha256,
    current_sha256: entry.resultSha256,
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
        hunks: hunksOf(entry).map((h) => ({ op: h.op, decision: "approve", change_indices: [...h.changeIndices] })),
        rejected_ops: [],
        review_decision,
      },
    ],
    parts: null,
  };
}

test("the contract id and schema ids are the wolfsdk ones", () => {
  expect(SESSION_CONTRACT).toBe("wolfsdk.review-session.v1");
  expect(sessionSchema.$id).toBe("https://wolfsdk.com/schemas/review-session.v1.schema.json");
  expect(sessionSchema.properties.contract.const).toBe("wolfsdk.review-session.v1");
  expect(SESSION_SCHEMA.$id).toBe(sessionSchema.$id);
  expect(DECISION_SCHEMA.$id).toBe(decisionSchema.$id);
});

test("a session export built from record.ts validates against the session schema", async () => {
  const file = await buildSession();
  expect(file.contract).toBe("wolfsdk.review-session.v1");
  expect(validateDecision(file.entries[0]!.review_decision)).toEqual([]);
  expect(validateSession(file)).toEqual([]);
});

test("a session with a wrong contract id or an inconsistent summary is rejected", async () => {
  const file = await buildSession();
  expect(validateSession({ ...file, contract: "wolf-editor.review-session.v1" }).length).toBeGreaterThan(0);
  expect(validateSession({ ...file, summary: { approve: 0, reject: 1, undecided: 0 } }).length).toBeGreaterThan(0);
});
