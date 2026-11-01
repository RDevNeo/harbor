import { expect, test } from "bun:test";
import type { Account } from "@harbor/agents";
import { emptyText, favoritesValue, parseFavorites, pickerRows } from "../src/picker.ts";

const acc = (id: string, kind: Account["kind"], bin: string | null): Account => ({ id, kind, name: id, email: "", badge: "", plan: "", configDir: null, bin, loggedIn: true, usage: [] });
const claude = acc("claude", "Claude", "/usr/bin/claude");
const codex = acc("codex", "Codex", null);

test("favourites keep their order and drop malformed entries", () => {
  const f = parseFavorites("claude|claude-opus-5-5,bad,codex|gpt");
  expect(f).toEqual([
    ["claude", "claude-opus-5-5"],
    ["codex", "gpt"],
  ]);
  expect(favoritesValue(f)).toBe("claude|claude-opus-5-5,codex|gpt");
  expect(parseFavorites("")).toEqual([]);
});

test("the rail shows an account's models, the rest behind More models", () => {
  const { rows, more } = pickerRows({ rail: "claude", search: "", more: false, hover: 0 }, [claude, codex], [], null);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.account === "claude" && r.enabled)).toBe(true);
  if (more) {
    const inside = pickerRows({ rail: "claude", search: "", more: true, hover: 0 }, [claude, codex], [], null);
    expect(inside.rows.length).toBe(more[1]);
  }
});

test("search covers installed accounts only, and a locked provider greys the others", () => {
  const found = pickerRows({ rail: null, search: "opus", more: false, hover: 0 }, [claude, codex], [], null);
  expect(found.rows.map((r) => r.account)).not.toContain("codex");
  expect(found.rows.some((r) => r.model.includes("opus"))).toBe(true);
  const locked = pickerRows({ rail: "claude", search: "", more: false, hover: 0 }, [claude], [], "Codex");
  expect(locked.rows.every((r) => !r.enabled)).toBe(true);
});

test("favourites list unknown models by their id, and say how to add some when empty", () => {
  const { rows } = pickerRows({ rail: null, search: "", more: false, hover: 0 }, [claude], [["claude", "my-model"], ["gone", "x"]], null);
  expect(rows.map((r) => [r.label, r.model])).toEqual([["my-model", "my-model"]]);
  expect(emptyText({ rail: null, search: "", more: false, hover: 0 })).toBe("Star a model to pin it here.");
  expect(emptyText({ rail: null, search: "zz", more: false, hover: 0 })).toBe("No match — press Enter to use it as a model id.");
});
