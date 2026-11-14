import { expect, test } from "bun:test";
import { runLabelChecks } from "./labels-check.ts";
import { runRecordedChecks } from "./recorded-check.ts";

/** Each runner reports every failed case; the test lists them all. */
function failuresOf(run: (ok: (c: unknown, m: string) => void) => void): string[] {
  const failures: string[] = [];
  run((c, m) => {
    if (!c) failures.push(m);
  });
  return failures;
}

test("change labels, grouping and review key bindings", () => {
  expect(failuresOf(runLabelChecks)).toEqual([]);
});

test("labels of the recorded engine diffs", () => {
  expect(failuresOf(runRecordedChecks)).toEqual([]);
});
