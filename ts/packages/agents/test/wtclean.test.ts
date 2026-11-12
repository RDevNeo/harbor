import { afterAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as wc from "../src/wtclean.ts";

// Each test is dozens of git processes on real repositories (the remote one about twice its siblings'): a
// loaded sandbox makes that several times slower without anything waiting on anything.
setDefaultTimeout(20_000);

const base = mkdtempSync(join(tmpdir(), "hts-wtclean-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
// No hooks of this PC's own in the test repositories.
Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null" });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", dir, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const ON: wc.Prefs = { worktree: true, branch: true, remote: false };
let n = 0;
let repo = "";
let bare = "";

/** A project pushed to a bare origin, and a worktree on `harbor/x<n>` with two commits, pushed; GitHub squash-merges it into main. */
function project(): { dir: string; branch: string; pr: wc.Merged } {
  const root = join(base, `p${++n}`);
  bare = join(root, "origin.git");
  repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "-u", "origin", "main");
  const branch = `harbor/x${n}`;
  const dir = join(root, "worktrees", `proj-x${n}`);
  git(repo, "worktree", "add", "-q", "-b", branch, dir);
  for (const f of ["b", "c"]) {
    writeFileSync(join(dir, `${f}.txt`), `${f}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", f);
  }
  git(dir, "push", "-q", "-u", "origin", branch);
  const head = git(dir, "rev-parse", "HEAD");
  // The squash merge: one new commit on main with the branch's changes, none of its commits.
  git(repo, "merge", "-q", "--squash", branch);
  git(repo, "commit", "-q", "-m", "Squashed (#7)");
  git(repo, "push", "-q", "origin", "main");
  return { dir, branch, pr: { number: 7, branch, head } };
}

const hasBranch = (b: string): boolean => Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).success;
const onRemote = (b: string): boolean => git(repo, "ls-remote", "--heads", "origin", `refs/heads/${b}`) !== "";

beforeEach(() => {
  repo = "";
});

test("a_squash_merged_worktree_and_its_branch_go_though_git_branch_d_would_refuse", async () => {
  const { dir, branch, pr } = project();
  // git alone doesn't see it merged: why the PR's state decides.
  expect(Bun.spawnSync(["git", "-C", repo, "branch", "-d", branch]).success).toBe(false);
  const ck = await wc.check(repo, dir, pr);
  expect(ck.ok).toBe(true);
  if (!ck.ok) return;
  expect(ck.plan).toMatchObject({ here: true, branch, tip: pr.head, remote: { name: "origin", branch } });
  const done = await wc.clean(ck.plan, ON, pr);
  expect(done).toEqual({ branch: "deleted", branchWhy: "", remote: "off", remoteWhy: "" });
  expect(existsSync(dir)).toBe(false);
  expect(hasBranch(branch)).toBe(false);
  expect(git(repo, "worktree", "list")).not.toContain(dir);
  // Its branch on the remote stays unless asked.
  expect(onRemote(branch)).toBe(true);
  const [text, detail] = wc.notice("~/w/proj-x", pr, done, "~/proj", "main");
  expect(text).toBe(`Worktree removed: ${branch} was merged (PR #7)`);
  expect(detail).toContain(`Branch ${branch}: deleted here`);
  expect(detail).toContain("project's checkout, ~/proj on main");
});

test("a_dirty_worktree_stays_and_says_why", async () => {
  const { dir, pr } = project();
  writeFileSync(join(dir, "b.txt"), "changed\n");
  writeFileSync(join(dir, "new.txt"), "new\n");
  const ck = await wc.check(repo, dir, pr);
  expect(ck).toEqual({ ok: false, why: "it has 2 uncommitted changes", later: false });
  expect(existsSync(dir)).toBe(true);
});

test("a_commit_that_isnt_in_the_pr_keeps_the_worktree_and_the_branch", async () => {
  const { dir, branch, pr } = project();
  writeFileSync(join(dir, "d.txt"), "d\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "after the merge");
  const ck = await wc.check(repo, dir, pr);
  expect(ck).toEqual({ ok: false, why: `${branch} has commits that aren't in PR #7`, later: false });
  // Behind the PR's head is fine (pushed from elsewhere, then merged).
  git(dir, "reset", "-q", "--hard", "HEAD~2");
  expect((await wc.check(repo, dir, pr)).ok).toBe(true);
});

test("with_the_branch_toggle_off_the_branch_stays", async () => {
  const { dir, branch, pr } = project();
  const ck = await wc.check(repo, dir, pr);
  if (!ck.ok) throw new Error(ck.why);
  const done = await wc.clean(ck.plan, { ...ON, branch: false }, pr);
  expect(done.branch).toBe("kept");
  expect(existsSync(dir)).toBe(false);
  expect(hasBranch(branch)).toBe(true);
});

test("the_remote_branch_goes_only_when_asked_and_only_at_the_prs_head", async () => {
  const a = project();
  const ck = await wc.check(repo, a.dir, a.pr);
  if (!ck.ok) throw new Error(ck.why);
  expect(await wc.clean(ck.plan, { ...ON, remote: true }, a.pr)).toMatchObject({ branch: "deleted", remote: "deleted" });
  expect(onRemote(a.branch)).toBe(false);
  // Someone pushed more to it after the merge: it stays there.
  const b = project();
  const other = join(base, `other${n}`);
  git(base, "clone", "-q", "-b", b.branch, bare, other);
  writeFileSync(join(other, "e.txt"), "e\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "more");
  git(other, "push", "-q", "origin", b.branch);
  const ck2 = await wc.check(repo, b.dir, b.pr);
  if (!ck2.ok) throw new Error(ck2.why);
  expect(await wc.clean(ck2.plan, { ...ON, remote: true }, b.pr)).toMatchObject({ remote: "kept", remoteWhy: `origin/${b.branch} has commits that aren't in PR #7` });
  expect(onRemote(b.branch)).toBe(true);
});

test("the_projects_own_checkout_and_a_head_github_didnt_give_are_never_cleaned", async () => {
  const { dir, pr } = project();
  expect(await wc.check(repo, repo, pr)).toMatchObject({ ok: false, why: "it's the project's own checkout" });
  expect(await wc.check(repo, dir, { ...pr, head: "" })).toMatchObject({ ok: false, later: true });
  // Switched to another branch since: not this PR's any more.
  git(dir, "switch", "-q", "-c", "other");
  expect(await wc.check(repo, dir, pr)).toMatchObject({ ok: false, why: `it's on other now, not ${pr.branch}` });
});

test("a_worktree_folder_already_gone_still_takes_its_merged_branch", async () => {
  const { dir, branch, pr } = project();
  rmSync(dir, { recursive: true, force: true });
  const ck = await wc.check(repo, dir, pr);
  if (!ck.ok) throw new Error(ck.why);
  expect(ck.plan.here).toBe(false);
  expect((await wc.clean(ck.plan, ON, pr)).branch).toBe("deleted");
  expect(hasBranch(branch)).toBe(false);
});

test("prefs_default_to_worktree_and_branch_on_remote_off", () => {
  const kv = new Map<string, string>();
  const get = { get: (k: string) => kv.get(k) ?? null };
  expect(wc.prefsOf(get)).toEqual({ worktree: true, branch: true, remote: false });
  kv.set(wc.KEYS.branch, "0");
  kv.set(wc.KEYS.remote, "1");
  expect(wc.prefsOf(get)).toEqual({ worktree: true, branch: false, remote: true });
});
