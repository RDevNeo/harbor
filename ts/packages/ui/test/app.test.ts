import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { clipMiddle, copiedFiles, percentDecode } from "../src/logic/app.ts";

test("percent_decode_survives_non_ascii_after_percent", () => {
  expect(percentDecode("/tmp/%1é")).toBe("/tmp/%1é");
  expect(percentDecode("/tmp/%éx")).toBe("/tmp/%éx");
  expect(percentDecode("/tmp/a%20b%zz")).toBe("/tmp/a b%zz");
  copiedFiles("file:///tmp/%1é", existsSync);
});

test("clips_the_middle_of_long_text", () => {
  expect(clipMiddle("short", 10)).toBe("short");
  const s = `${"a".repeat(600)}${"b".repeat(600)}`;
  const c = clipMiddle(s, 300);
  expect(c.startsWith("a".repeat(200)) && c.endsWith("b".repeat(100))).toBe(true);
  expect(c.includes("(900 bytes cut)")).toBe(true);
  // Never cuts inside a character.
  const e = clipMiddle("é".repeat(1000), 101);
  expect(e.startsWith("é") && e.endsWith("é")).toBe(true);
});
