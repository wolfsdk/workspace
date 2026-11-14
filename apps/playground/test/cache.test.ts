import { expect, test } from "bun:test";
import { ByteCache } from "../src/lab/cache.ts";

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

test("returns copies, so callers cannot change cached bytes", () => {
  const cache = new ByteCache(100);
  const source = bytes(4, 7);
  cache.set("a", source);
  source[0] = 0;
  const first = cache.get("a")!;
  expect(first[0]).toBe(7);
  first[0] = 9;
  expect(cache.get("a")![0]).toBe(7);
});

test("evicts the least recently used entry past the cap", () => {
  const cache = new ByteCache(10);
  cache.set("a", bytes(4));
  cache.set("b", bytes(4));
  cache.get("a");
  cache.set("c", bytes(4));
  expect(cache.has("a")).toBe(true);
  expect(cache.has("b")).toBe(false);
  expect(cache.has("c")).toBe(true);
  expect(cache.bytes).toBe(8);
});

test("does not keep a single entry larger than the cap and replaces on re-set", () => {
  const cache = new ByteCache(10);
  cache.set("big", bytes(11));
  expect(cache.has("big")).toBe(false);
  cache.set("a", bytes(4));
  cache.set("a", bytes(6));
  expect(cache.bytes).toBe(6);
  expect(cache.size).toBe(1);
});
