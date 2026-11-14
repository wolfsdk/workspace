import type { HistoryEntry } from "./history.ts";
import { changesOf } from "./model.ts";
import { canonical } from "./record.ts";

/** The changes one op of an entry caused (`op` = index in `entry.ops`), or, with
 * `op === null`, the changes that carry no `cause` (recalculated dependents).
 * `changeIndices` index `changesOf(entry)`. */
export type Hunk = { revision: number; op: number | null; changeIndices: number[] };

/** One hunk per op of `entry.ops`, in op order (an op with no reported change
 * still yields a hunk with no changes), then one trailing hunk with `op: null`
 * when some changes carry no `cause`. A `cause` outside `entry.ops` counts as none. */
export function hunksOf(entry: HistoryEntry): Hunk[] {
  const hunks: Hunk[] = entry.ops.map((_, op) => ({ revision: entry.revision, op, changeIndices: [] }));
  const loose: number[] = [];
  changesOf(entry).forEach((change, index) => {
    const hunk = typeof change.cause === "number" ? hunks[change.cause] : undefined;
    if (hunk) hunk.changeIndices.push(index);
    else loose.push(index);
  });
  if (loose.length) hunks.push({ revision: entry.revision, op: null, changeIndices: loose });
  return hunks;
}

/** Canonical JSON of a hunk's change records in order, without `cause`:
 * two hunks show the reviewer the same thing when these are equal. */
export function hunkRecords(entry: HistoryEntry, hunk: Hunk): string {
  const changes = changesOf(entry);
  return canonical(
    hunk.changeIndices.map((i) => {
      const { cause: _cause, ...rest } = changes[i]!;
      return rest;
    }),
  );
}
