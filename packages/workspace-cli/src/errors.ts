import type { ReadOnlyMode } from "@wolfsdk/server";

/** The command line was wrong, or a file it names is: reported with the usage, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Why a customer's plan record holds its workspace read-only: the trial ended (owner decision
 * `workspace-cloud-trial-end-read-only-delete-day-44-20261113`), or the paid plan lapsed because a payment failed, the
 * plan was cancelled, or the card issuer reversed a payment (`workspace-cloud-lapsed-paid-plan-delete-90-days-20261113`). */
export type PlanReadOnlyReason = "trial-ended" | "payment-failed" | "plan-cancelled" | "chargeback";

export const PLAN_READ_ONLY_REASONS: readonly PlanReadOnlyReason[] = ["trial-ended", "payment-failed", "plan-cancelled", "chargeback"];

/** The read-only mark of a customer's plan record: why the workspace is read-only, since when, and the page to pay on.
 * A plan record without a mark is a read-write workspace. */
export type PlanReadOnly = {
  reason: PlanReadOnlyReason;
  /** ISO 8601: when the trial or the plan ended, or the payment failed or was reversed. */
  since: string;
  /** The page the customer pays on, an absolute `https:` or `http:` URL. */
  payUrl: string;
};

/** The most characters of the reason or the upgrade of a read-only mode, as `RoomServer` and `serve` take them. */
const READ_ONLY_CHARS = 300;

const REASON_WORDS: Record<PlanReadOnlyReason, (day: string) => string> = {
  "trial-ended": (day) => `The trial ended on ${day}.`,
  "payment-failed": (day) => `A payment for the plan failed on ${day}.`,
  "plan-cancelled": (day) => `The plan was cancelled and ended on ${day}.`,
  chargeback: (day) => `The card issuer reversed a payment for the plan (a chargeback) on ${day}.`,
};

/** The read-only mode of `mark`: the reason on the plan record with its day (UTC), and the page to pay on. A write
 * refused while the mark stands answers `workspace-read-only: <reason> <upgrade>` in these words, whichever path it
 * came by. Throws a `TypeError` for a mark that is not one (an unknown reason, a date that does not parse, a page
 * that is not an absolute web address, or words over 300 characters): a refusal never says something unfounded. */
export function planReadOnlyMode(mark: PlanReadOnly): ReadOnlyMode {
  if (!PLAN_READ_ONLY_REASONS.includes(mark.reason)) {
    throw new TypeError(`the read-only reason of a plan record is one of ${PLAN_READ_ONLY_REASONS.join(", ")}, not ${JSON.stringify(mark.reason)}`);
  }
  const at = typeof mark.since === "string" ? new Date(mark.since) : new Date(Number.NaN);
  if (Number.isNaN(at.getTime())) throw new TypeError(`the read-only date of a plan record is an ISO 8601 date, not ${JSON.stringify(mark.since)}`);
  let page: URL | null = null;
  try {
    page = new URL(mark.payUrl);
  } catch {
    // Answered below.
  }
  if (page === null || (page.protocol !== "https:" && page.protocol !== "http:")) {
    throw new TypeError(`the page to pay on is an absolute https: or http: URL, not ${JSON.stringify(mark.payUrl)}`);
  }
  const mode = { reason: REASON_WORDS[mark.reason](at.toISOString().slice(0, 10)), upgrade: `To keep editing, pay at ${mark.payUrl}.` };
  if (mode.upgrade.length > READ_ONLY_CHARS) throw new TypeError(`the page to pay on makes the refusal longer than ${READ_ONLY_CHARS} characters`);
  return mode;
}
