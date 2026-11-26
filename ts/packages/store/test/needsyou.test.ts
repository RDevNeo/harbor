import { expect, test } from "bun:test";
import { needsYou } from "../src/sidebartree.ts";

const chat = (id: number, role = "lead", retired = false) => ({ id, role, retired });

test("the Projects tab counts the sidebar's chats left unread, not subagents or retired ones", () => {
  const chats = [chat(1), chat(2), chat(3, "sub"), chat(4, "lead", true), chat(5)];
  const unread = new Set([1, 3, 4, 5]);
  expect(needsYou(chats, (id) => unread.has(id))).toBe(2);
  // Opening a chat takes it off the count.
  unread.delete(1);
  expect(needsYou(chats, (id) => unread.has(id))).toBe(1);
  unread.delete(5);
  expect(needsYou(chats, (id) => unread.has(id))).toBe(0);
});

test("a chat unread but gone from the list doesn't count", () => {
  expect(needsYou([chat(1)], (id) => id === 9)).toBe(0);
  expect(needsYou([], () => true)).toBe(0);
});
