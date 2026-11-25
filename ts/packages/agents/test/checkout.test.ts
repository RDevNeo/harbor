import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as co from "../src/checkout.ts";
import * as wt from "../src/worktree.ts";

// Windows' git takes ten times as long per command: its tests get the time (setDefaultTimeout holds per file).
if (process.platform === "win32") setDefaultTimeout(60_000);

const base = mkdtempSync(join(tmpdir(), "hts-co-"));
// No hooks of this PC's own in the test repositories (each has its own identity: env would reach other test files).
Object.assign(process.env, {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function g(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function ident(dir: string): void {
  g(dir, "config", "user.name", "t");
  g(dir, "config", "user.email", "t@example.com");
}

function commit(dir: string, file: string, text: string, msg = file): void {
  writeFileSync(join(dir, file), text);
  g(dir, "add", file);
  g(dir, "commit", "-qm", msg);
}

/** A project on main with one commit, and a clone of it ("origin") when `remote`. */
function repo(tag: string, remote = false): string {
  const d = join(base, tag);
  mkdirSync(d, { recursive: true });
  g(d, "init", "-q", "-b", "main");
  ident(d);
  commit(d, "a.txt", "a\n", "a");
  if (!remote) return d;
  const bare = join(base, `${tag}.git`);
  g(base, "clone", "-q", "--bare", d, bare);
  g(d, "remote", "add", "origin", bare);
  g(d, "fetch", "-q", "origin");
  g(d, "remote", "set-head", "origin", "main");
  return d;
}

test("the_default_branch_comes_from_the_remote_head_else_main", async () => {
  const d = repo("dflt");
  g(d, "switch", "-qc", "work");
  expect(await co.defaultBranch(d)).toBe("main");
  const r = repo("dflt-remote", true);
  g(r, "branch", "-m", "main", "trunk");
  expect(await co.defaultBranch(r)).toBe("main");
});

test("a_new_branch_starts_from_the_remotes_newer_copy_and_has_no_upstream", async () => {
  const d = repo("fresh", true);
  // Someone else pushed to main meanwhile: the local main is behind.
  const other = join(base, "fresh-other");
  g(base, "clone", "-q", join(base, "fresh.git"), other);
  ident(other);
  commit(other, "b.txt", "b\n", "b");
  g(other, "push", "-q", "origin", "main");
  const fresh = await co.freshBase(d, "main");
  expect(fresh.ref).toBe("origin/main");
  const dir = await co.addTree(d, join(base, "trees"), "feature/x", fresh.ref);
  expect(basename(dir)).toBe("fresh-feature-x");
  expect(existsSync(join(dir, "b.txt"))).toBe(true);
  expect((await wt.head(dir))?.branch).toBe("feature/x");
  expect(() => g(d, "rev-parse", "--abbrev-ref", "feature/x@{upstream}")).toThrow();
  // A local main with commits origin hasn't stays the base.
  commit(d, "c.txt", "c\n", "c");
  g(d, "merge", "-q", "--no-edit", "origin/main");
  commit(d, "d.txt", "d\n", "d");
  expect((await co.freshBase(d, "main")).ref).toBe("main");
  await expect(co.addTree(d, join(base, "trees"), "feature/x", "main")).rejects.toThrow("already exists");
});

test("create_switch_and_rename_in_a_checkout", async () => {
  const d = repo("switch");
  writeFileSync(join(d, "wip.txt"), "wip");
  await co.switchNew(d, "topic", "main");
  // Uncommitted changes come along.
  expect(await wt.head(d)).toMatchObject({ branch: "topic", dirty: 1 });
  await expect(co.switchNew(d, "bad name", "main")).rejects.toThrow("isn't a valid branch name");
  await co.branchAt(d, "later", "main");
  expect(await co.isLocal(d, "later")).toBe(true);
  expect(await co.renameLocal(d, "topic", "topic-2")).toBeNull();
  expect((await wt.head(d))?.branch).toBe("topic-2");
  await expect(co.renameLocal(d, "nope", "x")).rejects.toThrow("no local branch");
});

test("an_unmerged_unpushed_branch_is_deleted_only_with_force", async () => {
  const d = repo("delete", true);
  g(d, "switch", "-qc", "work");
  commit(d, "w.txt", "w\n", "w");
  g(d, "switch", "-q", "main");
  expect(await co.keptIn(d, "work", "main")).toBeNull();
  await expect(co.deleteBranch(d, "work", "main", false)).rejects.toThrow("1 commit that aren't merged into main or pushed");
  await expect(co.deleteBranch(d, "main", "main", true)).rejects.toThrow("default branch");
  // Pushed, it may go: the remote keeps the work.
  g(d, "push", "-q", "origin", "work");
  expect(await co.keptIn(d, "work", "main")).toBe("pushed to origin/work");
  expect(await co.deleteBranch(d, "work", "main", false)).toContain("Deleted branch work");
  g(d, "switch", "-qc", "lost");
  commit(d, "l.txt", "l\n", "l");
  g(d, "switch", "-q", "main");
  expect(await co.deleteBranch(d, "lost", "main", true)).toContain("brings its unmerged commits back");
  expect(await co.isLocal(d, "lost")).toBe(false);
});

test("a_worktree_with_uncommitted_changes_is_removed_only_with_force", async () => {
  const d = repo("remove");
  const dir = await co.addTree(d, join(base, "trees-rm"), "hub/x", "main");
  writeFileSync(join(dir, "a.txt"), "changed\n");
  await expect(co.removeTree(d, dir, false)).rejects.toThrow("1 uncommitted change");
  expect(existsSync(dir)).toBe(true);
  expect(await co.removeTree(d, dir, true)).toContain("discarded its 1 uncommitted change");
  expect(existsSync(dir)).toBe(false);
  expect(co.findTree(await co.trees(d), "checkout")?.main).toBe(true);
});

test("merges_fast_forward_or_with_a_commit_where_the_branch_is_or_isnt_checked_out", async () => {
  const d = repo("merge");
  const dir = await co.addTree(d, join(base, "trees-m"), "hub/work", "main");
  commit(dir, "w.txt", "w\n", "w");
  // main is checked out in the project's checkout: it's fast-forwarded there.
  const ff = await co.merge(d, "hub/work", "main", "auto", join(base, "scratch"));
  expect(ff).toMatchObject({ how: "fast-forward" });
  expect(readFileSync(join(d, "w.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("w\n");
  expect((await co.merge(d, "hub/work", "main", "auto", join(base, "scratch"))).how).toBe("up to date");
  // Into a branch checked out nowhere: a fast-forward moves the ref, a merge commit happens in a scratch worktree that goes after.
  g(d, "branch", "release", "main~1");
  expect((await co.merge(d, "main", "release", "auto", join(base, "scratch"))).how).toBe("fast-forward");
  g(d, "branch", "release2", "main~1");
  commit(dir, "w2.txt", "w2\n", "w2");
  const mc = await co.merge(d, "hub/work", "release2", "no-ff", join(base, "scratch"));
  expect(mc).toMatchObject({ how: "merge commit", dir: null });
  expect(g(d, "show", "release2:w2.txt")).toBe("w2");
  expect((await co.trees(d)).length).toBe(2);
  // ff-only refuses when the branches went apart.
  commit(d, "m.txt", "m\n", "m");
  await expect(co.merge(d, "hub/work", "main", "ff-only", join(base, "scratch"))).rejects.toThrow("can't be fast-forwarded");
  expect((await co.merge(d, "hub/work", "main", "auto", join(base, "scratch"))).how).toBe("merge commit");
});

test("a_conflicting_merge_is_aborted_and_leaves_the_checkout_as_it_was", async () => {
  const d = repo("conflict");
  g(d, "switch", "-qc", "other");
  commit(d, "a.txt", "theirs\n", "theirs");
  g(d, "switch", "-q", "main");
  commit(d, "a.txt", "ours\n", "ours");
  const before = g(d, "rev-parse", "HEAD");
  const err = await co.merge(d, "other", "main", "auto", join(base, "scratch")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(co.MergeConflict);
  expect((err as co.MergeConflict).files).toEqual(["a.txt"]);
  expect((err as Error).message).toContain("the merge was aborted");
  expect(g(d, "rev-parse", "HEAD")).toBe(before);
  expect(g(d, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(d, "a.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("ours\n");
  // Into a branch checked out nowhere: the scratch worktree goes, the branch stays where it was.
  g(d, "branch", "side", "main");
  const side = g(d, "rev-parse", "side");
  await expect(co.merge(d, "other", "side", "auto", join(base, "scratch"))).rejects.toBeInstanceOf(co.MergeConflict);
  expect(g(d, "rev-parse", "side")).toBe(side);
  expect((await co.trees(d)).length).toBe(1);
  // A checkout with uncommitted changes isn't merged into.
  writeFileSync(join(d, "x.txt"), "x");
  await expect(co.merge(d, "other", "main", "auto", join(base, "scratch"))).rejects.toThrow("uncommitted change");
});

test("the_status_line_says_dirty_ahead_behind_and_pushed", async () => {
  const d = repo("status", true);
  g(d, "switch", "-qc", "work");
  commit(d, "w.txt", "w\n", "w");
  writeFileSync(join(d, "x.txt"), "x");
  expect(await co.branchLine(d, "main")).toBe("work · 1 uncommitted change · 1 ahead, 0 behind origin/main · not pushed");
  g(d, "push", "-qu", "origin", "work");
  expect(await co.branchLine(d, "main")).toContain("upstream origin/work: 0 ahead, 0 behind");
  const rows = await co.branchRows(d, "main");
  expect(rows.map((r) => r.name).sort()).toEqual(["main", "work"]);
  expect(rows.find((r) => r.name === "work")).toMatchObject({ upstream: "origin/work", merged: false });
});
