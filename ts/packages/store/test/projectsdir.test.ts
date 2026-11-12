import { expect, test } from "bun:test";
import { normalize } from "node:path";
import * as pd from "../src/projectsdir.ts";

// Paths as this system writes them ("\\" on Windows).
const n = normalize;

const kv = (v: string | null) => ({ get: (k: string) => (k === pd.KEY ? v : null) });

test("without a Projects folder: ~/Projects for projects, Harbor's data folder for worktrees, home for chats", () => {
  expect(pd.chosen(kv(null), "/h")).toBeNull();
  expect(pd.projectsDir(kv(null), "/h")).toBe(n("/h/Projects"));
  expect(pd.worktreesDir(kv(""), "/h", "/d")).toBe(n("/d/worktrees"));
  expect(pd.chatsDir(kv(null), "/h")).toBe("/h");
});

test("with one: everything in it, worktrees in .worktrees, chats in chats; ~ and trailing slashes understood", () => {
  for (const v of ["/h/Documents/work", "~/Documents/work/", "/h/Documents//work"]) {
    expect(pd.projectsDir(kv(v), "/h")).toBe(n("/h/Documents/work"));
    expect(pd.worktreesDir(kv(v), "/h", "/d")).toBe(n("/h/Documents/work/.worktrees"));
    expect(pd.chatsDir(kv(v), "/h")).toBe(n("/h/Documents/work/chats"));
  }
  expect(pd.chosen(kv("relative"), "/h")).toBeNull();
  expect(pd.parse("~/x/", "/h")).toEqual({ dir: n("/h/x") });
  expect(pd.parse("x", "/h")).toEqual({ err: "Use a full path, like ~/Projects" });
  expect(pd.parse(" ", "/h")).toEqual({ err: "Pick a folder" });
});
