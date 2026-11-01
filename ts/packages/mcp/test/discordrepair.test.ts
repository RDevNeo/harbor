import { expect, test } from "bun:test";
import { SYSTEM, readScript, tools } from "../src/discordrepair.ts";

test("repair has no way to send or read messages", () => {
  const names = tools().map((t) => (typeof t === "object" && t !== null && !Array.isArray(t) ? t.name : ""));
  expect(names.some((n) => typeof n === "string" && n.startsWith("discord_"))).toBe(false);
  for (const n of ["eval", "query", "click", "key"]) expect(names).toContain(n);
  expect(SYSTEM).toContain("isn't signed in");
});

test("read_script finds its place", () => {
  const s = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  expect(readScript(s, "", 20)).toContain("Lines 1–20 of 100");
  const at = readScript(s, "line 50", 30);
  expect(at).toContain("line 50\n");
  expect(at.startsWith("Lines 40–69")).toBe(true);
});
