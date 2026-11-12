import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fm from "../src/foldermove.ts";
import { sessionDir } from "../src/movechat.ts";

const base = mkdtempSync(join(tmpdir(), "hts-foldermove-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(base, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const cand = (over: Partial<fm.Cand>): fm.Cand => ({ dev: "1", ino: "10", mark: null, gitdir: null, names: [], ...over });

test("rewrite moves a folder and what's in it, nothing else", () => {
  expect(fm.rewrite("/h/P/app", "/h/P", "/h/Q")).toBe("/h/Q/app");
  expect(fm.rewrite("/h/P", "/h/P", "/h/Q")).toBe("/h/Q");
  expect(fm.rewrite("/h/Projects", "/h/P", "/h/Q")).toBe("/h/Projects");
  expect(fm.under("/h/P2", "/h/P")).toBe(false);
});

test("a checkout matches by its id on any disk, never by an inode alone", () => {
  const id: fm.Ident = { dev: "1", ino: "10", mark: "m1" };
  expect(fm.matches(id, cand({ dev: "2", ino: "99", mark: "m1" }), "/h/app")).toBe(true);
  expect(fm.matches(id, cand({ mark: "m2" }), "/h/app")).toBe(false);
  expect(fm.matches(id, cand({}), "/h/app")).toBe(false);
});

test("a worktree matches by its admin folder when that still names its old place (or by inode), never a new worktree that took the name", () => {
  const id: fm.Ident = { dev: "1", ino: "10", gitdir: "/h/app/.git/worktrees/x" };
  // Moved to another disk: a new inode, git's admin folder still names the old place.
  expect(fm.matches(id, cand({ dev: "2", ino: "5", gitdir: "/h/app/.git/worktrees/x", back: "/h/wt/x/.git" }), "/h/wt/x")).toBe(true);
  // A new worktree made with the same name: its admin folder names the new one.
  expect(fm.matches(id, cand({ dev: "1", ino: "5", gitdir: "/h/app/.git/worktrees/x", back: "/h/other/x/.git" }), "/h/wt/x")).toBe(false);
  expect(fm.matches(id, cand({ gitdir: "/h/app/.git/worktrees/x", back: "/h/other/x/.git" }), "/h/wt/x")).toBe(true);
  // Its checkout moved too: the same inode and admin name.
  expect(fm.matches(id, cand({ gitdir: "/h/old/app/.git/worktrees/x" }), "/h/wt/x")).toBe(true);
  expect(fm.matches(id, cand({ ino: "11", gitdir: "/h/old/app/.git/worktrees/x" }), "/h/wt/x")).toBe(false);
  expect(fm.matches(id, cand({ gitdir: "/h/app/.git/worktrees/y" }), "/h/wt/x")).toBe(false);
  expect(fm.matches(id, cand({ ino: "6", gitdir: "/h/new/app/.git/worktrees/x", back: "/h/wt/x/.git" }), "/h/wt/x", (g) => g.replace("/h/app", "/h/new/app"))).toBe(true);
});

test("a plain folder matches by inode only with some of its names: a new folder on a reused inode doesn't", () => {
  const id: fm.Ident = { dev: "1", ino: "10", names: ["a.md", "b.md", "notes"] };
  expect(fm.matches(id, cand({ names: ["a.md", "b.md", "c.md", "notes"] }), "/h/n")).toBe(true);
  expect(fm.matches(id, cand({ names: ["other"] }), "/h/n")).toBe(false);
  expect(fm.matches(id, cand({ ino: "11", names: ["a.md", "b.md", "notes"] }), "/h/n")).toBe(false);
  expect(fm.matches({ dev: "1", ino: "10", names: [] }, cand({ names: ["x"] }), "/h/n")).toBe(true);
});

test("identOf writes a checkout's id into its .git once, and reads a worktree's admin folder", () => {
  const d = fresh();
  const repo = join(d, "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const a = fm.identOf(repo);
  expect(a?.mark).toBeString();
  expect(readFileSync(join(repo, ".git", fm.MARK_FILE), "utf8").trim()).toBe(a?.mark ?? "");
  expect(fm.identOf(repo)?.mark).toBe(a?.mark);
  const wt = join(d, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${repo}/.git/worktrees/wt\n`);
  expect(fm.identOf(wt)).toMatchObject({ gitdir: `${repo}/.git/worktrees/wt` });
  expect(fm.mainOf(`${repo}/.git/worktrees/wt`)).toBe(repo);
  expect(fm.identOf(join(d, "nope"))).toBeNull();
});

test("locate finds a renamed project, a moved folder of projects, and leaves dot folders and dependencies out", async () => {
  const h = fresh();
  const app = join(h, "Projects", "app");
  const notes = join(h, "Projects", "notes");
  mkdirSync(join(app, ".git"), { recursive: true });
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "a.md"), "");
  const ids = new Map([
    [app, fm.identOf(app) as fm.Ident],
    [notes, fm.identOf(notes) as fm.Ident],
  ]);
  renameSync(app, join(h, "Projects", "app2"));
  mkdirSync(join(h, "Documents", "deep"), { recursive: true });
  renameSync(notes, join(h, "Documents", "deep", "notes"));
  const got = await fm.locate(ids, [join(h, "Projects"), h]);
  expect(got).toEqual(new Map([[app, join(h, "Projects", "app2")], [notes, join(h, "Documents", "deep", "notes")]]));
  // In a dot folder or node_modules: not looked in.
  mkdirSync(join(h, ".hidden"));
  mkdirSync(join(h, "node_modules"));
  renameSync(join(h, "Projects", "app2"), join(h, ".hidden", "app2"));
  renameSync(join(h, "Documents", "deep", "notes"), join(h, "node_modules", "notes"));
  expect((await fm.locate(ids, [h])).size).toBe(0);
});

test("two copies of a checkout: the one with its inode is it; two without: neither", async () => {
  const h = fresh();
  const app = join(h, "app");
  mkdirSync(join(app, ".git"), { recursive: true });
  const ids = new Map([[app, fm.identOf(app) as fm.Ident]]);
  renameSync(app, join(h, "moved"));
  cpSync(join(h, "moved"), join(h, "copy"), { recursive: true });
  expect(await fm.locate(ids, [h])).toEqual(new Map([[app, join(h, "moved")]]));
  cpSync(join(h, "moved"), join(h, "copy2"), { recursive: true });
  rmSync(join(h, "moved"), { recursive: true });
  expect((await fm.locate(ids, [h])).size).toBe(0);
});

test("locate stops at its limits", async () => {
  const h = fresh();
  const app = join(h, "app");
  mkdirSync(join(app, ".git"), { recursive: true });
  const ids = new Map([[app, fm.identOf(app) as fm.Ident]]);
  mkdirSync(join(h, "a", "b", "c", "d", "e"), { recursive: true });
  renameSync(app, join(h, "a", "b", "c", "d", "e", "app"));
  expect((await fm.locate(ids, [h], { dirs: 1000, depth: 3, ms: 5000 })).size).toBe(0);
  expect((await fm.locate(ids, [h], { dirs: 1000, depth: 6, ms: 5000 })).size).toBe(1);
  expect((await fm.locate(ids, [h], { dirs: 3, depth: 6, ms: 5000 })).size).toBe(0);
});

test("trashed: the Trash's .trashinfo names the folder or one it was in, and its copy is still in the Trash", () => {
  const h = fresh();
  const t = fm.trashDir(h);
  mkdirSync(join(t, "info"), { recursive: true });
  mkdirSync(join(t, "files", "my app"), { recursive: true });
  writeFileSync(join(t, "info", "my app.trashinfo"), `[Trash Info]\nPath=${encodeURI(join(h, "Projects", "my app"))}\nDeletionDate=2026-11-11T10:00:00\n`);
  expect(fm.trashed(join(h, "Projects", "my app"), h)).toBe(true);
  expect(fm.trashed(join(h, "Projects", "my app", "sub"), h)).toBe(true);
  expect(fm.trashed(join(h, "Projects", "other"), h)).toBe(false);
  // Restored (gone from the Trash): not trashed anymore.
  rmSync(join(t, "files", "my app"), { recursive: true });
  expect(fm.trashed(join(h, "Projects", "my app"), h)).toBe(false);
});

test("copySessions copies each account's sessions and memory of a folder to its new path, leaving the old and newer copies", () => {
  const h = fresh();
  const cfg = join(h, ".claude2");
  const from = join(h, "Projects", "app");
  const to = join(h, "Documents", "app");
  mkdirSync(to, { recursive: true });
  const src = sessionDir(cfg, from);
  mkdirSync(join(src, "memory"), { recursive: true });
  writeFileSync(join(src, "s1.jsonl"), "old");
  writeFileSync(join(src, "memory", "MEMORY.md"), "m");
  const dst = sessionDir(cfg, to);
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, "s1.jsonl"), "newer");
  expect(fm.copySessions([cfg, cfg, join(h, "none")], from, to)).toBe(1);
  expect(readFileSync(join(dst, "s1.jsonl"), "utf8")).toBe("newer");
  expect(readFileSync(join(dst, "memory", "MEMORY.md"), "utf8")).toBe("m");
  expect(readFileSync(join(src, "s1.jsonl"), "utf8")).toBe("old");
});
