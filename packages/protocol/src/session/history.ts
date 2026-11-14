import type { Change, Op, TransactionSummary } from "../contract.ts";

/** One applied batch in the revision chain. `history[i]` produced revision `i + 1`. Declared here
 * because the session model reads it; the review host re-exports this type for its history. */
export type HistoryEntry = {
  /** Revision this batch produced. */
  revision: number;
  /** Short human label supplied by the caller of `apply` ("Bold", "Type text"). */
  label: string;
  /** Plugin id that issued the batch. */
  source: string;
  ops: Op[];
  diff: Change[];
  transaction: TransactionSummary;
  baseSha256: string;
  resultSha256: string;
  /** When the batch was applied, epoch milliseconds. */
  appliedAt: number;
};
