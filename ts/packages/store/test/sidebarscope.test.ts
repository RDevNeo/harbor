import { expect, test } from "bun:test";
import { inScope } from "../src/sidebartree.ts";

const chat = (id: number, home: string, repoId: number | null) => ({ id, home, repoId });
const repo = (id: number) => ({ id });
const used = new Set(["ts:laptop"]);
const has = (h: string) => used.has(h);

test("copies from PCs this account doesn't use go, with the projects known only from them", () => {
  const chats = [chat(1, "", 10), chat(2, "ts:laptop", 11), chat(3, "ts:other", 12), chat(4, "ts:other", 10), chat(5, "ts:other", null)];
  const asked: number[] = [];
  const r = inScope(chats, [repo(10), repo(11), repo(12), repo(13)], has, (x) => (asked.push(x.id), false));
  expect(r.chats.map((c) => c.id)).toEqual([1, 2]);
  // 10 has a chat of its own, 11 one from a PC it uses; 12 only the other PC's; 13 none at all.
  expect(r.repos.map((x) => x.id)).toEqual([10, 11, 13]);
  expect(asked).toEqual([12]);
});

test("a project whose folder is here stays though only hidden copies use it", () => {
  const r = inScope([chat(3, "ts:other", 12)], [repo(12)], has, () => true);
  expect(r.chats).toEqual([]);
  expect(r.repos.map((x) => x.id)).toEqual([12]);
});

test("nothing hidden: nothing is asked", () => {
  const r = inScope([chat(1, "", 10), chat(2, "ts:laptop", 10)], [repo(10)], has, () => {
    throw new Error("asked");
  });
  expect(r.chats.length).toBe(2);
  expect(r.repos.length).toBe(1);
});
