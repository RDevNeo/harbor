import { expect, test } from "bun:test";
import type { Item } from "@harbor/store";
import { fingerprint } from "../src/phone.ts";

test("fingerprints_see_what_changes", () => {
  const tool = (result: string | null): Item => ({ kind: "tool", id: "t1", name: "Bash", summary: "ls", input: "{}", result, is_error: false });
  expect(fingerprint(tool(null))).not.toBe(fingerprint(tool("a\nb")));
  expect(fingerprint(tool("a\nb"))).toBe(fingerprint(tool("a\nb")));
  const text = (t: string): Item => ({ kind: "text", text: t, at: 1 });
  expect(fingerprint(text("Hel"))).not.toBe(fingerprint(text("Hello")));
  expect(fingerprint(text("x"))).not.toBe(fingerprint({ kind: "thinking", text: "x" }));
  expect(fingerprint({ kind: "error", text: "a" })).not.toBe(fingerprint({ kind: "error", text: "b" }));
});
