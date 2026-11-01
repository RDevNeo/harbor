import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { outputWithin } from "./git.ts";
import { dataDir, home, newUuid } from "./paths.ts";
import { childPath } from "./providers.ts";
import { rankFiles } from "./rank.ts";
import { askWithin, type Env } from "./recap.ts";

const GIT_TIMEOUT_MS = 15_000;
/** Checking out a big project takes a while. */
const ADD_TIMEOUT_MS = 120_000;

/** git in `dir`; its first error line (without "error:"/"fatal:") when it fails. */
export async function git(dir: string, args: string[], limitMs = GIT_TIMEOUT_MS): Promise<string> {
  let out;
  try {
    out = await outputWithin(["git", "-c", "core.fsmonitor=false", "-C", dir, ...args], limitMs, { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  } catch (e) {
    throw new Error(`git: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code === 0) return out.stdout.trimEnd();
  const line = out.stderr
    .split("\n")
    .map((l) => l.replace(/^(error: )+/, "").replace(/^(fatal: )+/, "").trim())
    .find((l) => l !== "" && !l.startsWith("hint:"));
  throw new Error(line ?? "git failed");
}

const ok = async (p: Promise<unknown>): Promise<boolean> =>
  p.then(
    () => true,
    () => false,
  );
const orNull = async (p: Promise<string>): Promise<string | null> => p.catch(() => null);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A folder's branch ("" when detached: then `detached` is the short commit) and how many files differ from it. */
export interface Head {
  branch: string;
  detached: string;
  dirty: number;
}

export function headLabel(h: Head): string {
  return h.branch === "" ? `detached at ${h.detached}` : h.branch;
}

export async function head(dir: string): Promise<Head | null> {
  const s = await orNull(git(dir, ["status", "--porcelain=v2", "--branch"]));
  if (s === null) return null;
  const h: Head = { branch: "", detached: "", dirty: 0 };
  for (const l of s.split("\n")) {
    if (l.startsWith("# branch.head ")) {
      const b = l.slice(14);
      h.branch = b === "(detached)" ? "" : b;
    } else if (l.startsWith("# branch.oid ")) h.detached = [...l.slice(13)].slice(0, 7).join("");
    else if (!l.startsWith("#") && l !== "") h.dirty++;
  }
  return h;
}

/** Local and remote-tracking branches, most recently committed first (remote HEAD aliases left out). */
export interface Branches {
  local: string[];
  remote: string[];
}

export async function branches(dir: string): Promise<Branches> {
  const out = await git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  const b: Branches = { local: [], remote: [] };
  for (const r of out.split("\n")) {
    if (r.startsWith("refs/heads/")) b.local.push(r.slice(11));
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) b.remote.push(r.slice(13));
  }
  return b;
}

/** One row of the branch picker. */
export interface Row {
  name: string;
  remote: boolean;
}

function afterSlash(r: string): string | undefined {
  const i = r.indexOf("/");
  return i < 0 ? undefined : r.slice(i + 1);
}

/** The picker's rows for `query`: all of them (local first, then remote ones without a local one) by recency when it's empty, else the best matches first. */
export function rank(b: Branches, query: string, limit: number): Row[] {
  const remote = b.remote.filter((r) => {
    const n = afterSlash(r);
    return n === undefined || !b.local.includes(n);
  });
  const q = query.trim();
  if (q === "") return [...b.local.map((name) => ({ name, remote: false })), ...remote.map((name) => ({ name, remote: true }))].slice(0, limit);
  return rankFiles([...b.local, ...remote], q, limit).map((name) => ({ name, remote: !b.local.includes(name) }));
}

export async function validBranch(dir: string, name: string): Promise<boolean> {
  return name.trim() !== "" && (await ok(git(dir, ["check-ref-format", "--branch", name.trim()])));
}

/** Switches `dir` to `name` (a local branch, or a remote one: a local branch tracking it is made). Git refuses rather than overwrite uncommitted changes. */
export async function switchTo(dir: string, name: string, remote: boolean): Promise<void> {
  if (!remote) {
    await git(dir, ["switch", name]);
    return;
  }
  const local = afterSlash(name) ?? name;
  try {
    await git(dir, ["switch", "--track", name]);
  } catch {
    await git(dir, ["switch", local]);
  }
}

export async function create(dir: string, name: string): Promise<void> {
  const n = name.trim();
  if (!(await validBranch(dir, n))) throw new Error(`“${n}” isn't a valid branch name`);
  await git(dir, ["switch", "-c", n]);
}

/** Where worktrees go: outside every project, in Harbor's data folder. */
export function root(): string {
  return join(dataDir(), "worktrees");
}

/** Words that say little about what a chat is about, left out of its worktree's name. */
const FILLER = new Set([
  "a", "an", "the", "to", "of", "and", "or", "in", "on", "at", "by", "for", "from", "with", "into", "as", "is", "are", "be", "it", "its", "that", "this", "these",
  "there", "here", "so", "i", "im", "me", "my", "we", "our", "you", "your", "can", "could", "would", "should", "please", "pls", "lets", "let", "just", "also", "now",
  "then", "when", "where", "what", "how", "why", "do", "does", "some", "all", "about", "hey", "hi", "ok", "okay",
  // Portuguese, as people write to Harbor in it too.
  "o", "os", "as", "um", "uma", "de", "da", "do", "das", "dos", "e", "que", "para", "pra", "por", "com", "em", "no", "na", "nos", "nas", "eu", "voce", "quero",
  "queria", "preciso", "pode", "favor", "se", "isso", "esse", "essa", "ao", "aos",
]);

const FOLD: Record<string, string> = {};
for (const [to, from] of [
  ["a", "áàâãäå"],
  ["e", "éèêë"],
  ["i", "íìîï"],
  ["o", "óòôõö"],
  ["u", "úùûü"],
  ["c", "ç"],
  ["n", "ñ"],
] as const)
  for (const c of from) FOLD[c] = to;

function fold(c: string): string | null {
  const l = [...c.toLowerCase()][0] ?? c;
  if (/^[a-z0-9]$/.test(l)) return l;
  return FOLD[l] ?? null;
}

/** "Fix the login bug where users…" → "fix-login-bug-users": always a valid ref, "" when nothing's left. */
export function slug(about: string): string {
  const line = about.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  // Links and apostrophes ("let's", "don't") aren't words of their own.
  const words: string[] = line
    .split(/\s+/)
    .filter((w) => w !== "" && !w.includes("://"))
    .flatMap((w) => [...w.replace(/['’]/g, "")].map((c) => fold(c) ?? " ").join("").split(" "))
    .filter((w) => w !== "");
  const kept = words.filter((w) => !FILLER.has(w));
  const pick = kept.length === 0 ? words : kept;
  let out = "";
  for (const w of pick.slice(0, 5)) {
    if (out !== "" && out.length + 1 + w.length > 32) break;
    if (out !== "") out += "-";
    out += w.slice(0, 32);
  }
  return out;
}

/** How long a new worktree waits for its name from Claude before it's made with `slug`'s. */
export const timing = { nameWaitMs: 5000, nameLateMs: 45_000 };

const NAME_SYSTEM =
  "You name git branches. You get the first message a user sent an AI coding agent. Reply with a short name for the task it asks for: 2 to 5 lowercase English words joined by hyphens, only a-z and 0-9, like inline-chat-mention-links or fix-login-redirect. Say what is to be done, not how the user phrased it; no filler words. Reply with only the name: no prefix, quotes or explanation.";

/** Asks for a worktree's name: Claude's answer, cleaned (`cleanName`). */
export type Namer = () => Promise<string | null>;

/** A Namer asking Haiku through this Claude account what the chat is about; null when the message gives nothing to name. */
export function namer(bin: string, env: Env, about: string): Namer | null {
  const text = [...about.trim()].slice(0, 2000).join("");
  if (slug(text) === "") return null;
  return () => askWithin(bin, env, NAME_SYSTEM, `<message>\n${text}\n</message>`, timing.nameLateMs).then(cleanName, () => null);
}

/** Claude's answer as a branch and folder name. Only a-z, 0-9 and "-", at most 5 words and 40 characters; null when it isn't a name. */
export function cleanName(answer: string): string | null {
  let line = answer.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (line === undefined) return null;
  line = line.replace(/^[`"'*.]+|[`"'*.]+$/g, "");
  // "harbor/x", "feature/x": the name is the last part.
  line = (line.split("/").pop() ?? line).trim();
  if (line.split(/\s+/).filter((w) => w !== "").length > 5 || line.includes(":")) return null;
  const s = [...line].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : "-")).join("");
  let out = "";
  for (const w of s.split("-").filter((x) => x !== "").slice(0, 5)) {
    if (out !== "" && out.length + 1 + w.length > 40) break;
    if (out !== "") out += "-";
    out += w.slice(0, 40);
  }
  return out.length >= 3 && /[a-z]/.test(out) ? out : null;
}

/** The project's part of its worktrees' folder names. */
export function projectPart(repo: string): string {
  const n = basename(repo) || "project";
  return [...n].map((c) => (/^[A-Za-z0-9\-_.]$/.test(c) ? c : "-")).join("");
}

/** A branch as the end of a folder name: "harbor/fix-login" → "fix-login", "feature/a b" → "feature-a-b". */
export function folderPart(branch: string): string {
  const b = branch.startsWith("harbor/") ? branch.slice(7) : branch;
  const s = [...b].map((c) => (/^[A-Za-z0-9_.]$/.test(c) ? c.toLowerCase() : "-")).join("");
  return s
    .split("-")
    .filter((p) => p !== "")
    .join("-")
    .replace(/^\.+|\.+$/g, "");
}

/** Whether `name` is `want` or `want-<n>` (a name made unique). */
export function isNamed(name: string, want: string): boolean {
  if (name === want) return true;
  if (!name.startsWith(`${want}-`)) return false;
  return /^\d+$/.test(name.slice(want.length + 1));
}

/** Every branch name the repository knows, local and remote ("harbor/x" for "origin/harbor/x" too). */
async function takenBranches(repo: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const b = await branches(repo);
    for (const l of b.local) set.add(l);
    for (const r of b.remote) {
      const n = afterSlash(r);
      if (n !== undefined) set.add(n);
    }
  } catch {
    // not a repository: no branch names taken
  }
  return set;
}

/** `want`, or `want-2`, `want-3`…: the first whose folder and branch (`harbor/<id>`) are both free. */
function freeId(rootDir: string, project: string, want: string, taken: Set<string>): string | null {
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? want : `${want}-${n}`;
    if (!existsSync(join(rootDir, `${project}-${id}`)) && !taken.has(`harbor/${id}`)) return id;
  }
  return null;
}

/** Renames a worktree just made (nothing works in it yet) to `name`; null when it can't or already is. */
async function renameNew(repo: string, dir: string, name: string): Promise<string | null> {
  const rootDir = dirname(dir);
  const project = projectPart(repo);
  const base = basename(dir);
  if (!base.startsWith(`${project}-`)) return null;
  const id = base.slice(project.length + 1);
  if (isNamed(id, name)) return null;
  const old = (await head(dir))?.branch;
  if (old === undefined) return null;
  const fresh = freeId(rootDir, project, name, await takenBranches(repo));
  if (fresh === null) return null;
  if (!(await ok(git(dir, ["branch", "-m", old, `harbor/${fresh}`])))) return null;
  const to = join(rootDir, `${project}-${fresh}`);
  try {
    moveDir(dir, to);
  } catch {
    await ok(git(dir, ["branch", "-m", `harbor/${fresh}`, old]));
    return null;
  }
  return to;
}

/** Makes a worktree of `repo` in `rootDir` on a new branch `harbor/<slug>` from `base` ("" for the checkout's HEAD). Returns its folder. */
async function addIn(rootDir: string, repo: string, base: string, about: string): Promise<string> {
  const project = projectPart(repo);
  const s = slug(about);
  const taken = await takenBranches(repo);
  let last = "";
  let n = 1;
  let tries = 0;
  while (tries < 4 && n < 100) {
    const id = s === "" ? [...newUuid()].filter((c) => /[0-9a-f]/i.test(c)).slice(0, 6).join("") : n === 1 ? s : `${s}-${n}`;
    n++;
    const dir = join(rootDir, `${project}-${id}`);
    const branch = `harbor/${id}`;
    if (existsSync(dir) || taken.has(branch)) continue;
    tries++;
    mkdirSync(rootDir, { recursive: true });
    const args = ["worktree", "add", "-b", branch, dir];
    if (base !== "") args.push(base);
    try {
      await git(repo, args, ADD_TIMEOUT_MS);
      return dir;
    } catch (e) {
      last = why(e);
    }
  }
  throw new Error(`couldn't make a worktree: ${last}`);
}

/** Where a branch is pushed: its upstream or, without one, a remote with a branch of its name; and whether it has an upstream. */
async function pushed(dir: string, branch: string): Promise<[string, string, boolean] | null> {
  const cfg = async (k: string): Promise<string | null> => {
    const v = await orNull(git(dir, ["config", "--get", `branch.${branch}.${k}`]));
    return v === null || v === "" ? null : v;
  };
  const remote = await cfg("remote");
  const merge = await cfg("merge");
  if (remote !== null && remote !== "." && merge !== null) return [remote, merge.startsWith("refs/heads/") ? merge.slice(11) : merge, true];
  const remotes = await orNull(git(dir, ["remote"]));
  if (remotes === null) return null;
  for (const r of remotes.split("\n").map((x) => x.trim()).filter((x) => x !== "")) {
    if (await ok(git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${r}/${branch}`]))) return [r, branch, false];
  }
  return null;
}

/** What the rename form says about the branch on its remote: "origin/harbor/x", or null when it was never pushed. */
export async function pushedAs(dir: string): Promise<string | null> {
  const h = await head(dir);
  if (!h || h.branch === "") return null;
  const p = await pushed(dir, h.branch);
  return p ? `${p[0]}/${p[1]}` : null;
}

/** A branch renamed: from what, to what, and what happened on its remote (null: never pushed). */
export interface Renamed {
  old: string;
  branch: string;
  remote: string | null;
}

/** owner/name of a GitHub remote URL (prs.rs). */
export function githubRepo(remote: string): string | null {
  const r = remote.trim();
  let rest: string | undefined;
  for (const p of ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/", "ssh://git@github.com:22/", "git://github.com/"]) {
    if (r.startsWith(p)) {
      rest = r.slice(p.length);
      break;
    }
  }
  if (rest === undefined && r.startsWith("https://")) {
    const x = r.slice(8);
    const at = x.indexOf("@");
    if (at >= 0 && x.slice(at + 1).startsWith("github.com/")) rest = x.slice(at + 1 + 11);
  }
  if (rest === undefined) return null;
  const parts = rest.replace(/\/+$/, "").split("/");
  const o = parts[0];
  let n = parts[1];
  if (o === undefined || n === undefined) return null;
  if (n.endsWith(".git")) n = n.slice(0, -4);
  return o !== "" && n !== "" ? `${o}/${n}` : null;
}

/** On GitHub a pushed branch is renamed through its API, so its pull requests follow; elsewhere the new name is pushed. */
export async function renameBranch(dir: string, name: string, onRemote: boolean): Promise<Renamed> {
  const fresh = name.trim();
  const h = await head(dir);
  if (!h) throw new Error(`${dir} isn't a git worktree`);
  if (h.branch === "") throw new Error(`it's detached at ${h.detached}: switch to a branch first`);
  const old = h.branch;
  if (fresh === old) return { old, branch: old, remote: null };
  if (!(await validBranch(dir, fresh))) throw new Error(`“${fresh}” isn't a valid branch name`);
  if (await ok(git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${fresh}`]))) throw new Error(`a branch named “${fresh}” already exists`);
  const up = await pushed(dir, old);
  await git(dir, ["branch", "-m", old, fresh]);
  let remote: string | null = null;
  if (up) {
    const [r, there, tracked] = up;
    if (!onRemote) {
      if (tracked) await ok(git(dir, ["branch", "--unset-upstream", fresh]));
      remote = `${r}/${there} keeps its name; push again to publish ${fresh}`;
    } else {
      const url = await orNull(git(dir, ["remote", "get-url", r]));
      const repo = url === null ? null : githubRepo(url);
      let gh = "";
      let renamed = false;
      if (repo !== null) {
        try {
          await ghRename(repo, there, fresh);
          renamed = true;
        } catch (e) {
          gh = why(e);
        }
      }
      if (renamed) {
        await ok(git(dir, ["fetch", r, `+refs/heads/${fresh}:refs/remotes/${r}/${fresh}`], ADD_TIMEOUT_MS));
        await ok(git(dir, ["update-ref", "-d", `refs/remotes/${r}/${there}`]));
        await ok(git(dir, ["branch", `--set-upstream-to=${r}/${fresh}`, fresh]));
        remote = `Renamed on GitHub too (${r}/${fresh}); its pull requests follow`;
      } else {
        const note = gh === "" ? "" : ` (GitHub: ${gh})`;
        try {
          await git(dir, ["push", "-u", r, fresh], ADD_TIMEOUT_MS);
          remote = `Pushed as ${r}/${fresh}; ${r}/${there} is still there${note}`;
        } catch (e) {
          remote = `Renamed here only: pushing it failed: ${why(e)}${note}`;
        }
      }
    }
  }
  return { old, branch: fresh, remote };
}

async function ghRename(repo: string, old: string, name: string): Promise<void> {
  let out;
  try {
    out = await outputWithin(["gh", "api", "-X", "POST", `repos/${repo}/branches/${old}/rename`, "-f", `new_name=${name}`], ADD_TIMEOUT_MS, {
      env: { ...process.env, PATH: childPath(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
    if (code === "ENOENT") throw new Error("gh isn't installed");
    throw new Error(`gh: ${why(e)}`);
  }
  if (out.code === 0) return;
  throw new Error(out.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "gh failed");
}

/** The folder a worktree of `repo` on `branch` should have, next to `dir` (null: its name already fits, or the branch gives no name). */
export function folderFor(repo: string, dir: string, branch: string): string | null {
  const part = folderPart(branch);
  if (part === "") return null;
  const want = `${projectPart(repo)}-${part}`;
  if (isNamed(basename(dir), want)) return null;
  for (let n = 1; n < 100; n++) {
    const p = join(dirname(dir), n === 1 ? want : `${want}-${n}`);
    if (!existsSync(p)) return p;
  }
  return null;
}

/** Why `name` can't be a worktree's folder name next to `dir` (null: it can): one plain name, no path, not taken. */
export function folderNameProblem(dir: string, name: string): string | null {
  const n = name.trim();
  if (n === "") return "type the folder's new name";
  if (n.includes("/") || n.includes("\\")) return "just a name, no “/”: it stays in the same place";
  if (n.startsWith(".") || n.startsWith("-")) return `“${n}” can't start with “${n[0]}”`;
  if (/[\s\p{Cc}]/u.test(n)) return "no spaces: use “-” instead";
  if (Buffer.byteLength(n) > 120) return "that name is too long";
  const to = join(dirname(dir), n);
  return to !== dir && existsSync(to) ? `a folder named “${n}” is already there` : null;
}

/** Moves worktree `dir` to `to` with file operations only: the folder is renamed, and its entry in the repository's worktree list pointed at it. */
export function moveDir(dir: string, to: string): void {
  let link: string;
  try {
    link = readFileSync(join(dir, ".git"), "utf8");
  } catch (e) {
    throw new Error(`${dir} isn't a worktree: ${why(e)}`);
  }
  const t = link.trim();
  if (!t.startsWith("gitdir:")) throw new Error(`${dir} isn't a worktree`);
  const rel = t.slice(7).trim();
  let admin = rel;
  if (!isAbsolute(rel)) {
    try {
      admin = realpathSync(join(dir, rel));
    } catch {
      admin = join(dir, rel);
    }
  }
  if (existsSync(join(admin, "locked"))) throw new Error("git has it locked (`git worktree unlock`)");
  if (existsSync(to)) throw new Error(`${to} already exists`);
  try {
    renameSync(dir, to);
  } catch (e) {
    throw new Error(`couldn't rename the folder: ${why(e)}`);
  }
  try {
    writeFileSync(join(admin, "gitdir"), `${join(to, ".git")}\n`);
  } catch (e) {
    renameSync(to, dir);
    throw new Error(`couldn't update git's worktree list: ${why(e)}`);
  }
}

/** "~/x" for a path under the home folder (app.rs). */
export function tilde(p: string): string {
  const h = home();
  if (p === h) return "~";
  if (p.startsWith(`${h}/`)) return `~/${p.slice(h.length + 1)}`;
  return p;
}

/** A worktree just made: its folder, branch, the branch it started from, and Claude's name when that's still on its way. */
export interface Made {
  dir: string;
  branch: string;
  base: string;
  late: Promise<string | null> | null;
}

export function madeName(m: Made): string {
  return basename(m.dir);
}

/** The chat's line about it: "Working in a new worktree · x on branch harbor/x (from main)", and its detail. */
export function madeNotice(m: Made, what: string): [string, string] {
  const from = m.base === "" ? "" : ` (from ${m.base})`;
  const text = `${what} · ${madeName(m)} on branch ${m.branch}${from}`;
  const detail = `Folder: ${tilde(m.dir)}\nBranch: ${m.branch}${from}\nIts own folder and branch, so parallel agents don't collide. It's removed with the thread, unless it has uncommitted changes.`;
  return [text, detail];
}

export function make(repo: string, base: string, about: string, name: Namer | null): Promise<Made> {
  return makeIn(root(), repo, base, about, name);
}

export async function makeIn(rootDir: string, repo: string, base: string, about: string, name: Namer | null): Promise<Made> {
  const start = Date.now();
  const asked = name ? name().catch(() => null) : null;
  let dir = await addIn(rootDir, repo, base, about);
  let late: Promise<string | null> | null = null;
  if (asked) {
    const left = Math.max(0, timing.nameWaitMs - (Date.now() - start));
    const TIMEOUT = Symbol();
    const got = await Promise.race([asked, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), left))]);
    if (got === TIMEOUT) late = asked;
    else if (got !== null) dir = (await renameNew(repo, dir, got)) ?? dir;
  }
  const h = await head(dir);
  const branch = h ? headLabel(h) : "";
  let from = base;
  if (from === "") {
    const r = await head(repo);
    from = r ? headLabel(r) : "";
  }
  return { dir, branch, base: from, late };
}

/** Removes a worktree made by `make`, unless it has uncommitted changes (the error says so); its merged branch goes too. */
export async function remove(repo: string, dir: string): Promise<void> {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // gone: only git's worktree list is pruned
  }
  if (!isDir) {
    await ok(git(repo, ["worktree", "prune"]));
    return;
  }
  const h = await head(dir);
  if (!h) throw new Error(`${dir} isn't a git worktree`);
  if (h.dirty > 0) throw new Error(`${dir} has ${h.dirty} uncommitted change${h.dirty === 1 ? "" : "s"}`);
  await git(repo, ["worktree", "remove", dir]);
  if (h.branch.startsWith("harbor/")) await ok(git(repo, ["branch", "-d", h.branch]));
}

export type RenameKind = "branch" | "folder";

export interface RenameDone {
  kind: RenameKind;
  renamed: Renamed;
  folder: string;
  /** Why the folder waits (something works in it), when it does. */
  waits: string | null;
}

/** What a rename did, in a line: "Renamed to harbor/x · folder harbor-x", with what happened on its remote and whether the folder waits. */
export function renameSaid(d: RenameDone): string {
  if (d.kind === "folder") return d.waits !== null ? `The worktree folder is renamed once nothing works in it (${d.waits})` : `Worktree folder renamed to ${d.folder}`;
  let s = `Renamed to ${d.renamed.branch}`;
  s += d.waits !== null ? ` · the folder follows once nothing works in it (${d.waits})` : ` · folder ${d.folder}`;
  if (d.renamed.remote !== null) s += `. ${d.renamed.remote}`;
  return s;
}
