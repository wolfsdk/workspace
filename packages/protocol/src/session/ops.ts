/**
 * Every operation this package sends to the engine is built or forwarded here.
 * The review plugin invents no operation shapes: it only forwards
 *  - operations a reviewer typed (validated as "a JSON array of objects with an `op` string"), and
 *  - the `ops` of earlier history entries, verbatim, when re-applying them.
 */
import type { Op } from "../contract.ts";
import type { HistoryEntry } from "./history.ts";

export type ParsedOps = { ok: true; ops: Op[] } | { ok: false; code: string; message: string };

/** Parse the "Manual ops" textarea. Accepts an array of operations, or a
 * session batch object `{ "ops": [...] }`. */
export function parseManualOps(text: string): ParsedOps {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: "invalid-json", message: e instanceof Error ? e.message : String(e) };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { ops?: unknown }).ops)) {
    value = (value as { ops: unknown[] }).ops;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, code: "invalid-ops", message: "Expected a non-empty JSON array of operations." };
  }
  for (const [i, op] of value.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof (op as { op?: unknown }).op !== "string") {
      return { ok: false, code: "invalid-ops", message: `Item ${i} is not an operation object with an "op" string.` };
    }
  }
  return { ok: true, ops: value as Op[] };
}

/** The operations to replay for a history entry (verbatim). */
export const opsOfEntry = (entry: HistoryEntry): Op[] => entry.ops;
