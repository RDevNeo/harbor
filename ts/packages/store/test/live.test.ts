import { expect, test } from "bun:test";
import { liveSince } from "../src/live.ts";

const now = () => 5_000;

test("a turn on this PC reads as running from its start", () => {
  expect(liveSince(1_000, null, now)).toBe(1_000);
  expect(liveSince(1_000, { running: false, sinceMs: null }, now)).toBe(1_000);
});

test("a copy running at its home PC reads as running from the start it says", () => {
  expect(liveSince(null, { running: true, sinceMs: 2_000 }, now)).toBe(2_000);
  expect(liveSince(null, { running: true, sinceMs: null }, now)).toBe(5_000);
});

test("a copy idle at its home PC reads as idle", () => {
  expect(liveSince(null, { running: false, sinceMs: 2_000 }, now)).toBeNull();
});

test("neither: idle", () => {
  expect(liveSince(null, null, now)).toBeNull();
  expect(liveSince(null, undefined, now)).toBeNull();
});
