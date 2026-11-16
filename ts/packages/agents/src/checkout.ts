import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { newUuid } from "./paths.ts";
import { folderPart, git, head, headLabel, projectPart, validBranch } from "./worktree.ts";

/**
 * A project's branches and worktrees as the lead manages them (the lead's checkout tools, ts/checkouttools.ts):
 * what's there, a new branch from an up-to-date base, deleting one only when its work is merged or pushed,
 * and merging one into another without ever leaving a half-done merge behind.
 */

/** Fetching, checking out and merging a big project take a while. */
const LONG_MS = 120_000;
const FETCH_MS = 60_000;

const ok = async (p: Promise<unknown>): Promise<boolean> =>
  p.then(
    () => true,
    () => false,
  );
const orNull = async (p: Promise<string>): Promise<string | null> => p.then((s) => (s === "" ? null : s)).catch(() => null);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The same folder, however it's written ("C:/x" and "C:\\x", a link and its target). */
export function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  return resolve(a) === resolve(b) || real(a) === real(b);
}

/** One of git's worktrees of a project: the first (`main`) is its own checkout. `branch` is "" when detached. */
export interface Tree {
  path: string;
  branch: string;
  head: string;
  main: boolean;
  locked: boolean;
}

export async function trees(repo: string): Promise<Tree[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const list: Tree[] = [];
  for (const raw of out.split("\n")) {
    const l = raw.trimEnd();
    const last = list[list.length - 1];
    if (l.startsWith("worktree ")) list.push({ path: resolve(l.slice(9)), branch: "", head: "", main: list.length === 0, locked: false });
    else if (!last) continue;
    else if (l.startsWith("HEAD ")) last.head = l.slice(5, 12);
    else if (l.startsWith("branch refs/heads/")) last.branch = l.slice(18);
    else if (l === "locked" || l.startsWith("locked ")) last.locked = true;
  }
  return list;
}

/** The worktree `which` names: its folder's name or path, or the branch checked out there; "main" or "checkout" is the project's own. */
export function findTree(list: readonly Tree[], which: string): Tree | undefined {
  const w = which.trim();
  if (w === "") return undefined;
  if (w === "main" || w === "checkout") {
    const own = list.find((t) => t.main);
    if (own) return own;
  }
  return list.find((t) => samePath(t.path, w)) ?? list.find((t) => basename(t.path) === w) ?? list.find((t) => t.branch === w);
}

export async function exists(dir: string, ref: string): Promise<boolean> {
  return ok(git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
}

export async function isLocal(dir: string, branch: string): Promise<boolean> {
  return ok(git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
}

/** Whether every commit of `a` is in `b`. */
export async function contains(dir: string, b: string, a: string): Promise<boolean> {
  return ok(git(dir, ["merge-base", "--is-ancestor", a, b]));
}

/** The remote a branch goes to: its upstream's, else "origin", else the only one; null without remotes. */
export async function remoteOf(dir: string, branch = ""): Promise<string | null> {
  if (branch !== "") {
    const r = await orNull(git(dir, ["config", "--get", `branch.${branch}.remote`]));
    if (r !== null && r !== ".") return r;
  }
  const all = ((await orNull(git(dir, ["remote"]))) ?? "").split("\n").map((x) => x.trim()).filter((x) => x !== "");
  return all.includes("origin") ? "origin" : (all[0] ?? null);
}

/** The project's default branch: its remote's HEAD, else main, master… as it has them, else the checkout's branch. */
export async function defaultBranch(repo: string): Promise<string> {
  const remote = await remoteOf(repo);
  if (remote !== null) {
    const s = await orNull(git(repo, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]));
    if (s?.startsWith(`${remote}/`)) return s.slice(remote.length + 1);
  }
  const named = await orNull(git(repo, ["config", "--get", "init.defaultBranch"]));
  for (const b of [named, "main", "master", "trunk", "develop"]) {
    if (b === null) continue;
    if (await isLocal(repo, b)) return b;
    if (remote !== null && (await exists(repo, `refs/remotes/${remote}/${b}`))) return b;
  }
  const h = await head(repo);
  return h && h.branch !== "" ? h.branch : "main";
}

/** How far `a` is ahead of and behind `b`; null when either isn't there. */
export async function aheadBehind(dir: string, a: string, b: string): Promise<{ ahead: number; behind: number } | null> {
  const out = await orNull(git(dir, ["rev-list", "--left-right", "--count", `${a}...${b}`]));
  if (out === null) return null;
  const [x, y] = out.split(/\s+/).map(Number);
  return x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y) ? null : { ahead: x, behind: y };
}

/** The ref a comparison with `branch` uses: its remote-tracking copy when there is one, else the local branch. */
export async function compareRef(dir: string, branch: string): Promise<string> {
  const r = await remoteOf(dir, branch);
  return r !== null && (await exists(dir, `refs/remotes/${r}/${branch}`)) ? `${r}/${branch}` : branch;
}

/** Where a new branch starts from `base`: a branch is brought up to date first (its remote's copy fetched, and taken when the local one has
 *  nothing it lacks); a remote branch, tag or commit as it is. `note` says when the local copy was kept or the fetch failed. */
export async function freshBase(repo: string, base: string): Promise<{ ref: string; note: string }> {
  const b = base.trim();
  const local = await isLocal(repo, b);
  const remote = await remoteOf(repo, local ? b : "");
  let note = "";
  if (remote !== null && (local || !(await exists(repo, b)))) {
    const got = await ok(git(repo, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${b}:refs/remotes/${remote}/${b}`], FETCH_MS));
    if (!got && local) note = `couldn't fetch ${remote}/${b}: it starts from the local ${b}`;
  }
  const tracking = remote === null ? null : `${remote}/${b}`;
  const there = tracking !== null && (await exists(repo, `refs/remotes/${tracking}`));
  if (!local) {
    if (there && tracking !== null) return { ref: tracking, note };
    if (await exists(repo, b)) return { ref: b, note };
    throw new Error(`no branch or commit '${b}'`);
  }
  if (!there || tracking === null) return { ref: b, note };
  if (await contains(repo, tracking, b)) return { ref: tracking, note };
  return { ref: b, note: note !== "" ? note : `the local ${b} has commits ${tracking} hasn't: it starts from the local one` };
}

async function freeName(repo: string, name: string): Promise<string> {
  const n = name.trim();
  if (!(await validBranch(repo, n))) throw new Error(`“${n}” isn't a valid branch name`);
  if (await isLocal(repo, n)) throw new Error(`a branch named “${n}” already exists: switch_branch switches to it`);
  return n;
}

/** A new branch `name` at `base`, without an upstream (it's pushed under its own name). */
export async function branchAt(repo: string, name: string, base: string): Promise<void> {
  const n = await freeName(repo, name);
  await git(repo, ["branch", "--no-track", n, base]);
}

/** Switches checkout `dir` to a new branch `name` at `base`; git refuses rather than lose uncommitted changes, which come along. */
export async function switchNew(dir: string, name: string, base: string): Promise<void> {
  const n = await freeName(dir, name);
  await git(dir, ["switch", "--no-track", "-c", n, base], LONG_MS);
}

/** A new worktree of `repo` in `rootDir` on a new branch `name` at `base`, its folder named after the branch ("<project>-<name>"). */
export async function addTree(repo: string, rootDir: string, name: string, base: string): Promise<string> {
  const n = await freeName(repo, name);
  const want = `${projectPart(repo)}-${folderPart(n) || "work"}`;
  let dir = join(rootDir, want);
  for (let i = 2; existsSync(dir) && i < 100; i++) dir = join(rootDir, `${want}-${i}`);
  if (existsSync(dir)) throw new Error(`no free folder for ${want} in ${rootDir}`);
  mkdirSync(rootDir, { recursive: true });
  await git(repo, ["worktree", "add", "--no-track", "-b", n, dir, base], LONG_MS);
  return dir;
}

/** Renames local branch `old` to `name` (checked out or not), here only: what's left on its remote, when it was pushed. */
export async function renameLocal(repo: string, old: string, name: string): Promise<string | null> {
  if (!(await isLocal(repo, old))) throw new Error(`no local branch '${old}'`);
  const n = await freeName(repo, name);
  const up = await orNull(git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${old}@{upstream}`]));
  await git(repo, ["branch", "-m", old, n]);
  if (up === null) return null;
  await ok(git(repo, ["branch", "--unset-upstream", n]));
  return `${up} keeps its name; push ${n} to publish it under the new one`;
}

/** Where `branch`'s work is kept besides itself: "merged into main", "pushed to origin/x"; null when only the branch has it. */
export async function keptIn(repo: string, branch: string, def: string): Promise<string | null> {
  const places: [string, string][] = [[def, `merged into ${def}`]];
  const dr = await remoteOf(repo, def);
  if (dr !== null) places.push([`refs/remotes/${dr}/${def}`, `merged into ${dr}/${def}`]);
  const up = await orNull(git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]));
  if (up !== null) places.push([`refs/remotes/${up}`, `pushed to ${up}`]);
  const r = await remoteOf(repo, branch);
  if (r !== null) places.push([`refs/remotes/${r}/${branch}`, `pushed to ${r}/${branch}`]);
  for (const [ref, said] of places) if ((await exists(repo, ref)) && (await contains(repo, ref, `refs/heads/${branch}`))) return said;
  return null;
}

/** Deletes local branch `branch`: only once its work is merged into `def` or pushed, unless `force`. Says where it went and its last commit. */
export async function deleteBranch(repo: string, branch: string, def: string, force: boolean): Promise<string> {
  if (!(await isLocal(repo, branch))) throw new Error(`no local branch '${branch}'`);
  if (branch === def) throw new Error(`${branch} is the project's default branch: it's never deleted`);
  const tip = await git(repo, ["rev-parse", "--short", `refs/heads/${branch}`]);
  const kept = await keptIn(repo, branch, def);
  if (kept === null && !force) {
    const n = (await aheadBehind(repo, `refs/heads/${branch}`, def))?.ahead ?? 0;
    throw new Error(`${branch} has ${plural(n, "commit")} that aren't merged into ${def} or pushed: merge or push it first, or pass force: true to delete them`);
  }
  await git(repo, ["branch", "-D", branch]);
  const restore = `\`git branch ${branch} ${tip}\` brings its unmerged commits back while git keeps them`;
  return `Deleted branch ${branch} (was ${tip}; ${kept ?? restore})`;
}

/** Removes worktree `dir`: refused when it has uncommitted changes, unless `force` (then they're discarded, said in the answer). */
export async function removeTree(repo: string, dir: string, force: boolean): Promise<string> {
  const h = await head(dir);
  const dirty = h?.dirty ?? 0;
  if (dirty > 0 && !force) throw new Error(`${dir} has ${plural(dirty, "uncommitted change")}: commit them to its branch first, or pass force: true to discard them`);
  await git(repo, ["worktree", "remove", ...(dirty > 0 || h === null ? ["--force"] : []), dir], LONG_MS);
  return `Removed the worktree ${basename(dir)}${dirty > 0 ? ` and discarded its ${plural(dirty, "uncommitted change")}` : ""}`;
}

export type MergeMode = "auto" | "ff-only" | "no-ff";

export interface MergeDone {
  how: "up to date" | "fast-forward" | "merge commit";
  tip: string;
  /** The checkout it happened in (null: none had `into`, so a scratch one did). */
  dir: string | null;
}

/** A merge that stopped on conflicts: the merge was aborted, the checkout is as it was. */
export class MergeConflict extends Error {
  constructor(
    readonly files: string[],
    from: string,
    into: string,
  ) {
    super(`merging ${from} into ${into} conflicts in ${files.length === 0 ? "some files" : files.slice(0, 20).join(", ")}${files.length > 20 ? ` and ${files.length - 20} more` : ""}. Nothing was merged: the merge was aborted and ${into} is as it was. Resolve it on ${from} (merge ${into} into it there, fix the conflicts, commit), then merge again`);
  }
}

/** Merges `from` into local branch `into`, in the checkout that has `into` (it must have no uncommitted changes), else in a scratch worktree
 *  under `scratch`, or by moving the ref when it's a fast-forward. On a conflict the merge is aborted and MergeConflict thrown. */
export async function merge(repo: string, from: string, into: string, mode: MergeMode, scratch: string): Promise<MergeDone> {
  if (!(await exists(repo, from))) throw new Error(`no branch or commit '${from}'`);
  if (!(await isLocal(repo, into))) throw new Error(`no local branch '${into}' to merge into`);
  const tipOf = (r: string): Promise<string> => git(repo, ["rev-parse", "--short", `${r}^{commit}`]);
  if (await contains(repo, `refs/heads/${into}`, from)) return { how: "up to date", tip: await tipOf(`refs/heads/${into}`), dir: null };
  const ff = await contains(repo, from, `refs/heads/${into}`);
  if (mode === "ff-only" && !ff) throw new Error(`${into} can't be fast-forwarded to ${from}: each has commits the other hasn't. mode 'auto' or 'no-ff' makes a merge commit`);
  const tree = (await trees(repo)).find((t) => t.branch === into);
  if (!tree && ff && mode !== "no-ff") {
    const old = await git(repo, ["rev-parse", `refs/heads/${into}`]);
    const to = await git(repo, ["rev-parse", `${from}^{commit}`]);
    await git(repo, ["update-ref", "-m", `merge ${from}: Fast-forward`, `refs/heads/${into}`, to, old]);
    return { how: "fast-forward", tip: await tipOf(`refs/heads/${into}`), dir: null };
  }
  let dir = tree?.path ?? null;
  let temp: string | null = null;
  if (dir !== null) {
    const h = await head(dir);
    if (h && h.dirty > 0) throw new Error(`${into} is checked out in ${dir}, which has ${plural(h.dirty, "uncommitted change")}: commit them first, then merge`);
  } else {
    temp = join(scratch, `.merge-${projectPart(repo)}-${[...newUuid()].filter((c) => /[0-9a-f]/i.test(c)).slice(0, 8).join("")}`);
    mkdirSync(scratch, { recursive: true });
    await git(repo, ["worktree", "add", temp, into], LONG_MS);
    dir = temp;
  }
  try {
    const before = await git(dir, ["rev-parse", "HEAD"]);
    const flag = mode === "ff-only" ? "--ff-only" : mode === "no-ff" ? "--no-ff" : "--ff";
    try {
      await git(dir, ["merge", "--no-edit", flag, from], LONG_MS);
    } catch (e) {
      const files = ((await orNull(git(dir, ["diff", "--name-only", "--diff-filter=U"]))) ?? "").split("\n").map((x) => x.trim()).filter((x) => x !== "");
      const merging = await ok(git(dir, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]));
      if (merging) await ok(git(dir, ["merge", "--abort"]));
      // Back where it started, whatever the merge left (it was clean before).
      if ((await orNull(git(dir, ["rev-parse", "HEAD"]))) !== before) await ok(git(dir, ["reset", "--hard", before]));
      if (merging || files.length > 0) throw new MergeConflict(files, from, into);
      throw new Error(`merging ${from} into ${into} failed: ${why(e)}`);
    }
    const parents = (await git(dir, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(/\s+/).length - 1;
    return { how: parents > 1 ? "merge commit" : "fast-forward", tip: await git(dir, ["rev-parse", "--short", "HEAD"]), dir: temp === null ? dir : null };
  } finally {
    if (temp !== null) await ok(git(repo, ["worktree", "remove", "--force", temp], LONG_MS));
  }
}

/** One local branch for the status: its upstream and how far off it is, when it was last committed to, and its last commit's subject. */
export interface BranchRow {
  name: string;
  upstream: string;
  track: string;
  when: string;
  subject: string;
  merged: boolean;
}

export async function branchRows(repo: string, def: string, limit = 30): Promise<BranchRow[]> {
  const out = await git(repo, ["for-each-ref", "--sort=-committerdate", `--count=${limit}`, "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:relative)%09%(subject)", "refs/heads"]);
  const merged = new Set(((await orNull(git(repo, ["for-each-ref", "--format=%(refname:short)", "--merged", await compareRef(repo, def), "refs/heads"]))) ?? "").split("\n").map((x) => x.trim()));
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [name = "", upstream = "", track = "", when = "", ...rest] = l.split("\t");
      return { name, upstream, track, when, subject: rest.join("\t"), merged: name !== def && merged.has(name) };
    });
}

/** What the status says about a checkout's branch: "harbor/x · 2 uncommitted changes · 3 ahead, 1 behind origin/main · pushed to origin/harbor/x (1 ahead)". */
export async function branchLine(dir: string, def: string): Promise<string> {
  const h = await head(dir);
  if (!h) return `${dir} isn't a git checkout`;
  const parts = [headLabel(h), h.dirty === 0 ? "no uncommitted changes" : plural(h.dirty, "uncommitted change")];
  if (h.branch !== "") {
    const base = await compareRef(dir, def);
    if (h.branch !== def) {
      const ab = await aheadBehind(dir, "HEAD", base);
      if (ab) parts.push(`${ab.ahead} ahead, ${ab.behind} behind ${base}`);
    }
    const up = await orNull(git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
    if (up === null) {
      const r = await remoteOf(dir, h.branch);
      const same = r === null ? null : `${r}/${h.branch}`;
      const ab = same !== null && (await exists(dir, `refs/remotes/${same}`)) ? await aheadBehind(dir, "HEAD", same) : null;
      parts.push(ab && same !== null ? `${same}: ${ab.ahead} ahead, ${ab.behind} behind` : "not pushed");
    } else {
      const ab = await aheadBehind(dir, "HEAD", up);
      parts.push(ab ? `upstream ${up}: ${ab.ahead} ahead, ${ab.behind} behind` : `upstream ${up}`);
    }
  }
  return parts.join(" · ");
}
