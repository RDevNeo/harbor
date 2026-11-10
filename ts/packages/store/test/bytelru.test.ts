import { expect, test } from "bun:test";
import { ByteLru, stringBytes } from "../src/bytelru.ts";

const lru = (budget: number, more: Partial<ConstructorParameters<typeof ByteLru<string, string>>[0]> = {}) => new ByteLru<string, string>({ budget, size: (v) => v.length, ...more });

test("a byte budget evicts the least recently used first", () => {
  const c = lru(10);
  c.set("a", "aaaa");
  c.set("b", "bbbb");
  expect(c.get("a")).toBe("aaaa");
  c.set("c", "cccc");
  expect([...c.keys()]).toEqual(["a", "c"]);
  expect(c.bytes).toBe(8);
  expect(c.peek("b")).toBeUndefined();
});

test("a value over the per-entry cap is served by the caller but not kept, and drops the stale one", () => {
  const c = lru(100, { maxEntry: 5 });
  c.set("k", "old");
  expect(c.set("k", "too long")).toBe(false);
  expect(c.has("k")).toBe(false);
  expect(c.bytes).toBe(0);
});

test("pinned entries stay over the budget and still count; they go once unpinned", () => {
  const pins = new Set(["big"]);
  const gone: string[] = [];
  const c = lru(4, { pinned: (k) => pins.has(k), evicted: (k) => gone.push(k) });
  c.set("big", "xxxxxxxx");
  c.set("s", "yy");
  expect([...c.keys()]).toEqual(["big"]);
  expect(c.bytes).toBe(8);
  pins.clear();
  c.trim();
  expect(c.size).toBe(0);
  expect(gone).toEqual(["s", "big"]);
});

test("replacing or deleting keeps the total exact; peek leaves the order alone", () => {
  const c = lru(10);
  c.set("a", "1");
  c.set("b", "22");
  c.set("a", "333");
  expect(c.bytes).toBe(5);
  expect([...c.keys()]).toEqual(["b", "a"]);
  c.peek("b");
  expect([...c.keys()]).toEqual(["b", "a"]);
  c.delete("b");
  expect(c.bytes).toBe(3);
  c.clear();
  expect([c.size, c.bytes]).toEqual([0, 0]);
  expect(stringBytes("abc")).toBe(38);
});
