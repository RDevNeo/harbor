import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, head } from "./worktree.ts";

/**
 * Merged worktrees cleaned up (worktreeclean.ts runs it): once a chat's branch has a merged PR,
 * its worktree goes and, if wanted, its branch, here and on its remote. Merged is GitHub's word,
 * not git's: a squash or rebase merge leaves the branch's commits out of main, so `git branch -d`
 * would refuse. What makes it safe is the PR's head commit: nothing uncommitted, and the branch
 * holds no commit the PR didn't have.
 */

/** kv keys (account settings, synced): the worktree goes (default on), its local branch too (on), its branch on the remote too (off). */
export const KEYS = { worktree: "wt_clean_merged", branch: "wt_clean_branch", remote: "wt_clean_remote" } as const;

export interface Prefs {
  worktree: boolean;
  branch: boolean;
  remote: boolean;
}

export function prefsOf(kv: { get(k: string): string | null }): Prefs {
  return { worktree: kv.get(KEYS.worktree) !== "0", branch: kv.get(KEYS.branch) !== "0", remote: kv.get(KEYS.remote) === "1" };
}

/** A merged PR as chatpr.ts found it: its number, the local branch it was found for, its head commit. */
export interface Merged {
  number: number;
  branch: string;
  head: string;
}

/** What may go: the worktree (`here`: its folder is still there), its branch at `tip` (null: no such branch any more), and where the branch is pushed. */
export interface Plan {
  repo: string;
  dir: string;
  here: boolean;
  branch: string;
  tip: string | null;
  remote: { name: string; branch: string } | null;
}

/** Why it stays: `later` when it may go by itself later (GitHub didn't say enough yet), else something the user has to do. */
export interface Keep {
  why: string;
  later: boolean;
}

export type Check = { ok: true; plan: Plan } | ({ ok: false } & Keep);

const LONG_MS = 60_000;

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const orNull = (p: Promise<string>): Promise<string | null> => p.then((s) => (s === "" ? null : s)).catch(() => null);
const keep = (why: string, later = false): Check => ({ ok: false, why, later });

/** git's worktrees of `repo`: the first is its own checkout. */
async function worktreeList(repo: string): Promise<{ path: string; locked: boolean }[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const list: { path: string; locked: boolean }[] = [];
  for (const l of out.split("\n")) {
    if (l.startsWith("worktree ")) list.push({ path: l.slice(9), locked: false });
    else if ((l === "locked" || l.startsWith("locked ")) && list.length > 0) {
      const last = list[list.length - 1];
      if (last) last.locked = true;
    }
  }
  return list;
}

/** Where a branch is pushed: its upstream, else origin under its own name. */
async function pushedTo(repo: string, branch: string): Promise<{ name: string; branch: string } | null> {
  const r = await orNull(git(repo, ["config", "--get", `branch.${branch}.remote`]));
  const name = r !== null && r !== "." ? r : "origin";
  if ((await orNull(git(repo, ["remote", "get-url", name]))) === null) return null;
  const merge = await orNull(git(repo, ["config", "--get", `branch.${branch}.merge`]));
  return { name, branch: merge?.startsWith("refs/heads/") ? merge.slice(11) : branch };
}

/** Whether `tip` is the PR's head or comes before it; the head is fetched from GitHub's pull ref when this clone hasn't got it. */
async function inPr(repo: string, tip: string, pr: Merged, remote: string | null): Promise<boolean> {
  if (tip === pr.head) return true;
  const has = async (): Promise<boolean> => (await orNull(git(repo, ["cat-file", "-t", pr.head]))) === "commit";
  if (!(await has())) {
    const remotes = [...new Set(["upstream", remote ?? "origin", "origin"])];
    for (const r of remotes) {
      if ((await orNull(git(repo, ["remote", "get-url", r]))) === null) continue;
      await git(repo, ["fetch", "--no-tags", "--quiet", r, `refs/pull/${pr.number}/head`], LONG_MS).catch(() => "");
      if (await has()) break;
    }
    if (!(await has())) return false;
  }
  return git(repo, ["merge-base", "--is-ancestor", tip, pr.head]).then(
    () => true,
    () => false,
  );
}

/** Whether worktree `dir` of project `repo` may go now that `pr` is merged, and what goes with it. */
export async function check(repo: string, dir: string, pr: Merged): Promise<Check> {
  if (pr.head === "") return keep(`GitHub didn't say which commit PR #${pr.number} merged`, true);
  if (pr.branch === "") return keep(`PR #${pr.number} has no branch here`, true);
  if (real(dir) === real(repo)) return keep("it's the project's own checkout");
  if (!isDir(join(repo, ".git")) && !isFile(join(repo, ".git"))) return keep(`${repo} isn't a git repository`);
  const here = isDir(dir);
  let tip: string | null;
  if (here) {
    if (!isFile(join(dir, ".git"))) return keep("its folder isn't a linked worktree");
    let list: { path: string; locked: boolean }[];
    try {
      list = await worktreeList(repo);
    } catch (e) {
      return keep(`git couldn't list the worktrees: ${said(e)}`, true);
    }
    const me = real(dir);
    const at = list.findIndex((w) => real(w.path) === me);
    if (at < 0) return keep(`git doesn't list it as a worktree of ${repo}`);
    if (at === 0) return keep("it's the project's own checkout");
    if (list[at]?.locked === true) return keep("git has it locked (`git worktree unlock`)");
    const h = await head(dir);
    if (!h) return keep("git can't read it", true);
    if (h.dirty > 0) return keep(`it has ${h.dirty} uncommitted change${h.dirty === 1 ? "" : "s"}`);
    if (h.branch === "") return keep(`it's detached at ${h.detached}, not on ${pr.branch}`);
    if (h.branch !== pr.branch) return keep(`it's on ${h.branch} now, not ${pr.branch}`);
    tip = await orNull(git(dir, ["rev-parse", "HEAD"]));
    if (tip === null) return keep("git can't read its commit", true);
  } else tip = await orNull(git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${pr.branch}`]));
  const remote = await pushedTo(repo, pr.branch);
  if (tip !== null && !(await inPr(repo, tip, pr, remote?.name ?? null))) return keep(`${pr.branch} has commits that aren't in PR #${pr.number}`);
  return { ok: true, plan: { repo, dir, here, branch: pr.branch, tip, remote } };
}

/** What a cleanup did: the worktree went; the branch went or stayed (and why); the remote branch went, stayed or wasn't asked. */
export interface Cleaned {
  branch: "deleted" | "kept" | "none";
  branchWhy: string;
  remote: "deleted" | "kept" | "gone" | "off";
  remoteWhy: string;
}

/** The project's default branch (origin/HEAD, else main or master), never deleted. */
async function defaultBranch(repo: string): Promise<string> {
  const sym = await orNull(git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]));
  if (sym?.startsWith("origin/")) return sym.slice(7);
  return (await orNull(git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]))) !== null ? "main" : "master";
}

/** Removes the worktree of a `check`ed plan (git refuses if anything changed since), then its branch and remote branch as `prefs` say; the commits stay safe in the merged PR. */
export async function clean(p: Plan, prefs: Prefs, pr: Merged): Promise<Cleaned> {
  if (p.here) await git(p.repo, ["worktree", "remove", p.dir]);
  else await git(p.repo, ["worktree", "prune"]).catch(() => "");
  const out: Cleaned = { branch: "none", branchWhy: "", remote: "off", remoteWhy: "" };
  if (p.tip !== null) {
    if (!prefs.branch) [out.branch, out.branchWhy] = ["kept", "Also delete their branches is off"];
    else {
      const now = await orNull(git(p.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`]));
      const checkedOut = await orNull(git(p.repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
      if (now === null) out.branch = "none";
      else if (now !== p.tip) [out.branch, out.branchWhy] = ["kept", "it moved meanwhile"];
      else if (p.branch === (await defaultBranch(p.repo)) || p.branch === checkedOut) [out.branch, out.branchWhy] = ["kept", "the project's checkout uses it"];
      else {
        try {
          // -D: a squash merge's branch isn't merged as far as git knows; check made sure it holds nothing the PR didn't.
          await git(p.repo, ["branch", "-D", p.branch]);
          out.branch = "deleted";
        } catch (e) {
          [out.branch, out.branchWhy] = ["kept", said(e)];
        }
      }
    }
  }
  if (prefs.remote && p.remote !== null) {
    const { name, branch } = p.remote;
    try {
      const line = await git(p.repo, ["ls-remote", "--heads", name, `refs/heads/${branch}`], LONG_MS);
      const sha = line.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`))?.split("\t")[0] ?? "";
      if (sha === "") out.remote = "gone";
      else if (sha !== pr.head) [out.remote, out.remoteWhy] = ["kept", `${name}/${branch} has commits that aren't in PR #${pr.number}`];
      else {
        await git(p.repo, ["push", "--quiet", name, "--delete", branch], LONG_MS);
        await git(p.repo, ["update-ref", "-d", `refs/remotes/${name}/${branch}`]).catch(() => "");
        out.remote = "deleted";
      }
    } catch (e) {
      [out.remote, out.remoteWhy] = ["kept", said(e)];
    }
  }
  return out;
}

/** The chat's notice: "Worktree removed: harbor/x was merged (PR #12)", and its detail. */
export function notice(folder: string, pr: Merged, done: Cleaned, repo: string, checkout: string): [string, string] {
  const text = `Worktree removed: ${pr.branch} was merged (PR #${pr.number})`;
  const lines = [`Folder: ${folder} (removed)`];
  if (done.branch === "deleted") lines.push(`Branch ${pr.branch}: deleted here`);
  else if (done.branch === "kept") lines.push(`Branch ${pr.branch}: kept (${done.branchWhy})`);
  if (done.remote === "deleted") lines.push("Its branch on GitHub: deleted");
  else if (done.remote === "gone") lines.push("Its branch on GitHub: already deleted");
  else if (done.remote === "kept") lines.push(`Its branch on GitHub: kept (${done.remoteWhy})`);
  lines.push(`The chat now works in the project's checkout, ${repo}${checkout === "" ? "" : ` on ${checkout}`}: Move to a new worktree under the composer gives it one again.`);
  return [text, lines.join("\n")];
}

/** The chat's notice when its merged worktree stays: "Kept the worktree: PR #12 was merged, but it has 2 uncommitted changes". */
export function keptNotice(pr: Merged, why: string): [string, string] {
  return [`Kept the worktree: PR #${pr.number} was merged, but ${why}`, "Harbor removes a merged worktree only when nothing would be lost. Commit, push or discard what's left, or remove it yourself."];
}
