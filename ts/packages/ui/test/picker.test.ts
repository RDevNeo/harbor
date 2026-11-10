import { expect, test } from "bun:test";
import type { Account } from "@harbor/agents";
import { tipParts } from "../src/logic/tips.ts";
import { emptyText, favoritesValue, migrateFavorites, parseFavorites, pickerRows, railStep, railTip, workspaceLine } from "../src/picker.ts";

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

test("the rail's tooltip: the account, its plan and usage", () => {
  const a: Account = { ...claude, badge: "C1", email: "ana@example.com", plan: "Max", usage: [{ label: "5h", percent: 0.4, resetsAt: null }] };
  expect(tipParts(railTip(a))).toEqual({ rich: true, title: "Claude · C1", sub: "ana@example.com", body: "", rows: [{ label: "Plan", value: "Max" }, { label: "5h", value: "40% used" }], hint: "" });
  const out = tipParts(railTip({ ...codex, loggedIn: false }));
  expect([out.sub, out.body, out.rows]).toEqual(["codex", "Not signed in — Settings › Providers", []]);
});

test("Tab and Shift+Tab step the rail: the favourites, then each account, round", () => {
  const ids = ["claude", "codex", "opencode@ts:laptop/opencode"];
  expect(railStep(ids, null, 1)).toBe("claude");
  expect(railStep(ids, "claude", 1)).toBe("codex");
  expect(railStep(ids, "opencode@ts:laptop/opencode", 1)).toBeNull();
  expect(railStep(ids, null, -1)).toBe("opencode@ts:laptop/opencode");
  expect(railStep(ids, "claude", -1)).toBeNull();
  // One no longer on the rail starts from the favourites.
  expect(railStep(ids, "gone", 1)).toBe("claude");
  expect(railStep([], null, 1)).toBeNull();
});

test("a model row's second line is its owner's workspace, without the provider", () => {
  expect(workspaceLine({ shown: "Fizz", person: "Dana Reyes" })).toBe("Fizz's Workspace");
  expect(workspaceLine({ shown: "", person: "Dana Reyes" })).toBe("Dana Reyes's Workspace");
  expect(workspaceLine({ shown: "", person: "" })).toBeNull();
  expect(workspaceLine(undefined)).toBeNull();
});

test("a favorite on another PC's OpenCode by its old id moves to the entry that PC's copy is in now", () => {
  const shared = [
    { id: "opencode", kind: "opencode", copies: [{ pc: "", account: "opencode" }, { pc: "ts:laptop", account: "opencode" }] },
    { id: "opencode:abc", kind: "opencode", copies: [{ pc: "ts:desk", account: "opencode" }] },
  ];
  const list: [string, string][] = [
    ["opencode@ts:laptop/opencode", "nvidia/glm"],
    ["opencode@ts:desk/opencode", "x/y"],
    ["opencode", "nvidia/glm"],
    ["opencode@ts:gone/opencode", "a/b"],
    ["claude", "claude-opus-5-5"],
  ];
  expect(migrateFavorites(list, shared)).toEqual([
    ["opencode", "nvidia/glm"],
    ["opencode:abc", "x/y"],
    ["opencode@ts:gone/opencode", "a/b"],
    ["claude", "claude-opus-5-5"],
  ]);
  expect(migrateFavorites([["claude", "m"]], shared)).toBeNull();
});
