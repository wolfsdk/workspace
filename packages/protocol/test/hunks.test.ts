import { expect, test } from "bun:test";
import { hunkRecords, hunksOf } from "../src/index.ts";
import { twoOpEntry } from "./fixtures.ts";

test("a two-op batch yields one hunk per op plus a trailing hunk for changes with no cause", () => {
  const entry = twoOpEntry();
  expect(hunksOf(entry)).toEqual([
    { revision: 1, op: 0, changeIndices: [0] },
    { revision: 1, op: 1, changeIndices: [1] },
    { revision: 1, op: null, changeIndices: [2] },
  ]);
});

test("an op with no reported change still yields an empty hunk, and a cause outside the ops counts as none", () => {
  const entry = twoOpEntry();
  entry.diff = [{ ...entry.diff[0]!, cause: 7 }];
  expect(hunksOf(entry)).toEqual([
    { revision: 1, op: 0, changeIndices: [] },
    { revision: 1, op: 1, changeIndices: [] },
    { revision: 1, op: null, changeIndices: [0] },
  ]);
});

test("hunkRecords ignores the cause of the changes", () => {
  const entry = twoOpEntry();
  const [first] = hunksOf(entry);
  const before = hunkRecords(entry, first!);
  entry.diff[0] = { ...entry.diff[0]!, cause: 1 };
  expect(hunkRecords(entry, first!)).toBe(before);
});
