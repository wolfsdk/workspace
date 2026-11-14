// Replays the engine diffs recorded from the merged module (recorded/diffs.json) through
// describeEntry and compares the item labels with recorded/labels.json (reviewed by hand; update
// it together with an intended label change).
import { readFileSync } from "node:fs";
import { describeEntry, type HistoryEntry } from "@wolfsdk/protocol";

type Rec = {
  id: string;
  ok: boolean;
  ops: unknown[];
  diff: unknown[];
  transaction: { ops: unknown[]; address_map: unknown[]; changes: unknown[] };
};
const here = (f: string) => new URL(`./recorded/${f}`, import.meta.url);

export function recordedEntry(r: Rec): HistoryEntry {
  return {
    revision: 1,
    label: r.id,
    source: "recorded",
    ops: r.ops,
    diff: r.diff,
    transaction: {
      base_sha256: "a",
      result_sha256: "b",
      committed: true,
      address_map: r.transaction.address_map,
      ops: r.transaction.ops,
      diff: { changes: r.transaction.changes, counts: {}, identity: "" },
    },
    baseSha256: "a",
    resultSha256: "b",
    appliedAt: 0,
  } as unknown as HistoryEntry;
}

export function recordedLabels(): Record<string, string[]> {
  const rec: Rec[] = JSON.parse(readFileSync(here("diffs.json"), "utf8"));
  return Object.fromEntries(
    rec.filter((r) => r.ok).map((r) => [r.id, describeEntry(recordedEntry(r)).map((i) => i.label)]),
  );
}

export function runRecordedChecks(ok: (c: unknown, m: string) => void): void {
  const want: Record<string, string[]> = JSON.parse(readFileSync(here("labels.json"), "utf8"));
  const got = recordedLabels();
  for (const [id, labels] of Object.entries(want)) {
    ok(
      JSON.stringify(got[id]) === JSON.stringify(labels),
      `recorded ${id}: labels ${JSON.stringify(got[id])?.slice(0, 300)} != ${JSON.stringify(labels).slice(0, 300)}`,
    );
  }
  ok(
    Object.keys(got).every((id) => id in want),
    "every recorded case has expected labels",
  );
  // The two diffs are equal for every format except DOCX formatting and a XLSX sheet move (see docs notes).
  const rec: Rec[] = JSON.parse(readFileSync(here("diffs.json"), "utf8"));
  ok(rec.filter((r) => r.ok).length >= 60, "recorded cases present");
}
