// Continue anywhere: what a chat needs to go on on another PC, as the workspace cloud carries it (chatcloud.ts):
// the agent's own session (Claude Code's session file, Codex's rollout) and the work in its folder that its Git
// remote doesn't have (unpushed commits and uncommitted changes, as one git bundle; a folder without Git as a
// packed copy). The PC that runs a chat publishes these when it's idle; a PC that takes the chat over while that PC
// is off (failover.ts) puts them in place, with the paths in the session moved to its own folders (Linux, macOS and
// Windows paths alike), and resumes the session as its own.
//
// The work is put in place without losing anything here: in the chat's folder when that folder is clean and behind
// the carried work, or is exactly a state the carried work came from (`chain`: the PC that went on with it applied
// that state first); otherwise in a worktree of its own, so the changes here stay as they are.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { outputWithin, type Spawner } from "./proc.ts";

/** A session goes up in parts of this many bytes (a part's sealed row stays within the service's 1.4 MB). */
export const SESSION_PART = 960 << 10;
/** A session bigger than this isn't carried (Harbor compacts sessions over 15 MB before a turn). */
export const SESSION_MAX = 48 << 20;
/** The work (a bundle, a packed folder) bigger than this isn't carried. */
export const WORK_MAX = 48 << 20;
/** A folder without Git with more entries than this isn't carried. */
const FILES_MAX_ENTRIES = 20_000;
/** How many earlier states a carried work remembers it came from. */
const CHAIN = 8;

export const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex").slice(0, 32);

// ---- paths across PCs

/** Where a chat ran: its folder and home folder, and whether that PC is Windows. */
export interface PathSpace {
  cwd: string;
  home: string;
  win: boolean;
}

/** Characters that may be part of a file name next to a root (a match must not run into one). */
const NAME = /[A-Za-z0-9._-]/;
/** What ends a path inside a text (a quote, a space, punctuation that doesn't occur in names here). */
const END = /[\s"'`<>|*?,;()[\]{}]/;

function samePrefix(s: string, at: number, root: string, win: boolean): boolean {
  if (at + root.length > s.length) return false;
  if (!win) return s.startsWith(root, at);
  for (let i = 0; i < root.length; i++) {
    const a = s[at + i] as string;
    const b = root[i] as string;
    if (a === b) continue;
    if ((a === "\\" || a === "/") && (b === "\\" || b === "/")) continue;
    if (a.toLowerCase() !== b.toLowerCase()) return false;
  }
  return true;
}

const trimSep = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

/**
 * `s` with the paths under `from`'s folder and home moved to `to`'s (the folder first: it's usually under the
 * home), and the separators of what follows them turned into the other system's.
 */
export function remapPaths(s: string, from: PathSpace, to: PathSpace): string {
  const pairs = (
    [
      [trimSep(from.cwd), trimSep(to.cwd)],
      [trimSep(from.home), trimSep(to.home)],
    ] as [string, string][]
  )
    .filter(([a, b]) => a.length > 1 && b !== "" && (a !== b || from.win !== to.win))
    .sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return s;
  // Quick out: no root in it at all.
  const low = from.win ? s.toLowerCase().replaceAll("\\", "/") : s;
  if (!pairs.some(([a]) => low.includes(from.win ? a.toLowerCase().replaceAll("\\", "/") : a))) return s;
  const toSep = to.win ? "\\" : "/";
  let out = "";
  let i = 0;
  while (i < s.length) {
    let hit: [string, string] | null = null;
    const prev = i === 0 ? "" : (s[i - 1] as string);
    if (prev === "" || !NAME.test(prev)) {
      for (const p of pairs) {
        if (!samePrefix(s, i, p[0], from.win)) continue;
        const next = s[i + p[0].length];
        if (next === undefined || next === "/" || (from.win && next === "\\") || !NAME.test(next)) {
          hit = p;
          break;
        }
      }
    }
    if (hit === null) {
      out += s[i];
      i++;
      continue;
    }
    out += hit[1];
    i += hit[0].length;
    // The rest of this path, with the other system's separators.
    while (i < s.length && !END.test(s[i] as string)) {
      const ch = s[i] as string;
      out += ch === "/" || (from.win && ch === "\\") ? toSep : ch;
      i++;
    }
  }
  return out;
}

function remapValue(v: unknown, from: PathSpace, to: PathSpace): unknown {
  if (typeof v === "string") return remapPaths(v, from, to);
  if (Array.isArray(v)) return v.map((x) => remapValue(x, from, to));
  if (typeof v === "object" && v !== null) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = remapValue(x, from, to);
    return o;
  }
  return v;
}

/** A session file (JSON lines) with its paths moved (each line's strings; a line that isn't JSON as text). */
export async function remapSession(text: string, from: PathSpace, to: PathSpace): Promise<string> {
  const lines = text.split("\n");
  let at = performance.now();
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n] as string;
    if (l.trim() === "") continue;
    try {
      lines[n] = JSON.stringify(remapValue(JSON.parse(l), from, to));
    } catch {
      lines[n] = remapPaths(l, from, to);
    }
    if (performance.now() - at > 8) {
      await new Promise<void>((r) => setImmediate(r));
      at = performance.now();
    }
  }
  return lines.join("\n");
}

// ---- sessions

/** A session in parts: each part's hash, in order. */
export function sessionParts(b: Uint8Array, part = SESSION_PART): string[] {
  const out: string[] = [];
  for (let at = 0; at < b.length; at += part) out.push(sha(b.subarray(at, Math.min(b.length, at + part))));
  return out;
}

/** Codex's rollout of session `id` under `codexHome` (sessions/YYYY/MM/DD/rollout-…-<id>.jsonl), newest folders first. */
export async function findRollout(codexHome: string, id: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  const want = `-${id}.jsonl`;
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    if (depth === 3) {
      const f = names.find((n) => n.startsWith("rollout-") && n.endsWith(want));
      return f === undefined ? null : join(dir, f);
    }
    for (const n of names.sort().reverse()) {
      const got = await walk(join(dir, n), depth + 1);
      if (got !== null) return got;
    }
    return null;
  };
  return walk(join(codexHome, "sessions"), 0);
}

/** Where a carried Codex rollout goes here: where this PC has that session already, else today's folder with its name. */
export async function rolloutPlace(codexHome: string, id: string, name: string, now = new Date()): Promise<string> {
  const had = await findRollout(codexHome, id);
  if (had !== null) return had;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const safe = /^rollout-[A-Za-z0-9._-]+\.jsonl$/.test(name) ? name : `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`;
  return join(codexHome, "sessions", String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()), safe);
}

// ---- the work in a folder

/** What a folder's work is, as carried: the commit and tree it's at, and what the bundle (or pack) holds. */
export interface WorkIndex {
  kind: "git" | "files";
  /** The project's name and remote, from the PC that published it. */
  name: string;
  remote: string;
  /** Git: the branch ("" detached), its commit, the tree of the folder as it is (uncommitted changes and new files included), and the commit holding that tree. */
  branch: string;
  head: string;
  tree: string;
  work: string;
  /** Commits the remote doesn't have, and whether the folder differs from its commit. */
  commits: number;
  dirty: boolean;
  /** The chat ran in a worktree of its own. */
  worktree: boolean;
  /** States this work came from ([commit, tree], newest first): a folder exactly at one of them may be moved on. */
  chain: [string, string][];
  /** The bundle (git) or the packed folder: its size, hash and parts' hashes; size 0: nothing to fetch. */
  size: number;
  sha: string;
  parts: string[];
  /** Not carried, and why (too big, no commits…); "": carried. */
  why: string;
}

export interface Snap {
  index: WorkIndex;
  bytes: Uint8Array | null;
}

type Git = (args: string[], o?: { env?: Record<string, string>; timeoutMs?: number; input?: Uint8Array }) => Promise<{ code: number | null; out: string; err: string }>;

/** git in `dir`, never prompting, no fsmonitor, no optional locks. */
export function gitIn(dir: string, run: Spawner = outputWithin): Git {
  return async (args, o = {}) => {
    try {
      const r = await run("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], {
        timeoutMs: o.timeoutMs ?? 60_000,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", ...o.env },
        ...(o.input ? { input: o.input } : {}),
      });
      return { code: r.code, out: r.stdout.toString("utf8").trim(), err: r.stderr.toString("utf8").trim() };
    } catch (e) {
      return { code: null, out: "", err: e instanceof Error ? e.message : String(e) };
    }
  };
}

const FIXED = { GIT_AUTHOR_NAME: "Harbor", GIT_AUTHOR_EMAIL: "harbor@localhost", GIT_COMMITTER_NAME: "Harbor", GIT_COMMITTER_EMAIL: "harbor@localhost", GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" };

/** A scratch file name of our own. */
const scratchName = (dir: string, what: string) => join(dir, `harbor-carry-${what}-${process.pid}-${randomBytes(5).toString("hex")}`);

/** The tree of `dir` as it is (tracked changes and new files that aren't ignored), through a copy of its index. */
async function treeOf(g: Git, scratch: string): Promise<string | null> {
  const idx = await g(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (idx.code !== 0) return null;
  const tmp = scratchName(scratch, "index");
  try {
    await mkdir(scratch, { recursive: true });
    try {
      await writeFile(tmp, await readFile(idx.out));
    } catch {
      // no index yet: git makes one
    }
    const env = { GIT_INDEX_FILE: tmp };
    if ((await g(["add", "-A", "--", "."], { env, timeoutMs: 120_000 })).code !== 0) return null;
    const t = await g(["write-tree"], { env });
    return t.code === 0 && /^[0-9a-f]{40,64}$/.test(t.out) ? t.out : null;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Git's state of a folder: its commit, branch and tree as it is now. */
export async function gitState(dir: string, scratch: string, run?: Spawner): Promise<{ head: string; branch: string; tree: string; headTree: string } | null> {
  const g = gitIn(dir, run);
  const head = await g(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.code !== 0) return null;
  const branch = await g(["symbolic-ref", "--short", "-q", "HEAD"]);
  const headTree = await g(["rev-parse", "HEAD^{tree}"]);
  const tree = await treeOf(g, scratch);
  if (tree === null || headTree.code !== 0) return null;
  return { head: head.out, branch: branch.code === 0 ? branch.out : "", tree, headTree: headTree.out };
}

/**
 * A snapshot of the work in git folder `dir`: what its remote doesn't have, as one bundle of a commit (the folder's
 * tree on top of its commit) and the commits before it. `chain`: the states this folder's work came from.
 */
export async function gitSnapshot(dir: string, o: { scratch: string; name: string; worktree: boolean; chain: [string, string][]; max?: number; run?: Spawner }): Promise<Snap | null> {
  const g = gitIn(dir, o.run);
  const st = await gitState(dir, o.scratch, o.run);
  if (st === null) return null;
  const remote = await g(["remote", "get-url", "origin"]);
  const dirty = st.tree !== st.headTree;
  let work = st.head;
  if (dirty) {
    const c = await g(["commit-tree", st.tree, "-p", st.head, "-m", "Harbor: uncommitted work"], { env: FIXED });
    if (c.code !== 0) return null;
    work = c.out;
  }
  const count = await g(["rev-list", "--count", work, "--not", "--remotes"]);
  const ahead = await g(["rev-list", "--count", st.head, "--not", "--remotes"]);
  const index: WorkIndex = {
    kind: "git",
    name: o.name,
    remote: remote.code === 0 ? remote.out : "",
    branch: st.branch,
    head: st.head,
    tree: st.tree,
    work,
    commits: ahead.code === 0 ? Number(ahead.out) || 0 : 0,
    dirty,
    worktree: o.worktree,
    chain: o.chain.slice(0, CHAIN),
    size: 0,
    sha: "",
    parts: [],
    why: "",
  };
  if (count.code === 0 && count.out === "0") return { index, bytes: null };
  const ref = `refs/harbor/carry-${randomBytes(5).toString("hex")}`;
  const file = scratchName(o.scratch, "bundle");
  try {
    await mkdir(o.scratch, { recursive: true });
    if ((await g(["update-ref", ref, work])).code !== 0) return null;
    const b = await g(["bundle", "create", "-q", file, ref, "--not", "--remotes"], { timeoutMs: 300_000 });
    if (b.code !== 0) return { index: { ...index, why: `git bundle: ${b.err.split("\n").pop() ?? ""}` }, bytes: null };
    const size = (await stat(file)).size;
    if (size > (o.max ?? WORK_MAX)) return { index: { ...index, size: 0, why: `too big to carry (${Math.round(size / 1048576)} MB)` }, bytes: null };
    const bytes = new Uint8Array(await readFile(file));
    return { index: { ...index, size: bytes.length, sha: sha(bytes) }, bytes };
  } finally {
    await g(["update-ref", "-d", ref]);
    await rm(file, { force: true });
  }
}

/** What applying carried work did. */
export interface Applied {
  /** The folder the chat goes on in (`dir`, or a worktree made for it). */
  dir: string;
  /** "same": it was there already; "moved": the folder was moved on to it; "worktree": it's in a worktree of its own. */
  how: "same" | "moved" | "worktree";
  /** The local branch the folder's commits stayed on, when the folder had other commits on the carried branch's name. */
  kept: string;
}

/** Whether `a` is an ancestor of (or equal to) `b`. */
async function ancestor(g: Git, a: string, b: string): Promise<boolean> {
  return (await g(["merge-base", "--is-ancestor", a, b])).code === 0;
}

/** Puts the carried tree `work` in folder `dir`, leaving its index at HEAD (new files show as untracked, as they were). */
async function checkoutWork(g: Git, dir: string, w: WorkIndex, branch: string, from: string | null): Promise<void> {
  const must = async (args: string[]) => {
    const r = await g(args, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.err.split("\n").pop() ?? "failed"}`);
  };
  // Files of the folder's own state the carried one doesn't have (removed there; untracked ones git wouldn't touch).
  const gone = from === null ? [] : (await g(["diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", from, w.tree])).out.split("\0").filter((p) => p !== "");
  if (branch !== "") await must(["checkout", "-q", "-f", "-B", branch, w.head]);
  else await must(["checkout", "-q", "-f", "--detach", w.head]);
  await must(["read-tree", "-u", "--reset", w.work]);
  await must(["reset", "-q"]);
  for (const p of gone) if (plain(p)) await rm(join(dir, ...p.split("/")), { force: true }).catch(() => undefined);
}

/** `base`, or `base-2`, `base-3`… : the first name no branch here has. */
async function freeBranch(g: Git, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const b = n === 1 ? base : `${base}-${n}`;
    if ((await g(["rev-parse", "--verify", "-q", `refs/heads/${b}`])).code !== 0) return b;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/**
 * Carried work into git folder `dir`: in place when nothing here would be lost (the folder is clean and behind the
 * carried commit, or is exactly a state it came from), else in a worktree `worktree(head)` makes. `inPlace` false:
 * another chat works in `dir` now, so always a worktree. `bundle`: the carried bundle (null: the remote has it all).
 */
export async function gitApply(
  dir: string,
  w: WorkIndex,
  bundle: Uint8Array | null,
  o: { scratch: string; inPlace: boolean; worktree: (head: string) => Promise<string>; run?: Spawner },
): Promise<Applied> {
  const g = gitIn(dir, o.run);
  const fetchOrigin = () => g(["fetch", "-q", "--no-tags", "origin"], { timeoutMs: 300_000 });
  if (bundle !== null) {
    const file = scratchName(o.scratch, "bundle");
    await mkdir(o.scratch, { recursive: true });
    await writeFile(file, bundle);
    try {
      if ((await g(["bundle", "verify", "-q", file])).code !== 0) await fetchOrigin();
      const heads = (await g(["bundle", "list-heads", file])).out.split("\n").map((l) => l.split(" ")[1] ?? "").filter((r) => r.startsWith("refs/harbor/carry-"));
      const ref = heads[0];
      if (ref === undefined) throw new Error("the carried work came garbled");
      const f = await g(["fetch", "-q", "--no-tags", file, `+${ref}:refs/harbor/carried`], { timeoutMs: 300_000 });
      if (f.code !== 0) throw new Error(`the carried commits need ones this clone doesn't have: ${f.err.split("\n").pop() ?? ""}`);
    } finally {
      await rm(file, { force: true });
    }
  } else if ((await g(["cat-file", "-e", `${w.work}^{commit}`])).code !== 0) {
    await fetchOrigin();
    if ((await g(["cat-file", "-e", `${w.work}^{commit}`])).code !== 0) throw new Error(`commit ${w.head.slice(0, 8)} isn't on ${w.remote || "the remote"} yet`);
  }
  const here = await gitState(dir, o.scratch, o.run);
  if (here === null) throw new Error(`${dir} isn't a Git checkout with commits`);
  if (here.head === w.head && here.tree === w.tree) return { dir, how: "same", kept: "" };
  const dirty = here.tree !== here.headTree;
  const inChain = w.chain.some(([c, t]) => c === here.head && t === here.tree);
  const behind = !dirty && (await ancestor(g, here.head, w.head));
  // The carried branch's name here, when it's another branch than the folder's and has commits of its own.
  let kept = "";
  if (w.branch !== "" && w.branch !== here.branch) {
    const b = await g(["rev-parse", "--verify", "-q", `refs/heads/${w.branch}`]);
    if (b.code === 0 && !(await ancestor(g, b.out, w.head)) && !w.chain.some(([c]) => c === b.out)) kept = w.branch;
  }
  if (o.inPlace && (inChain || behind) && kept === "") {
    await checkoutWork(g, dir, w, w.branch, inChain && dirty ? here.tree : null);
    return { dir, how: "moved", kept: "" };
  }
  // A worktree of its own (made detached at the carried commit), on the carried branch's name when that's free here.
  const wt = await o.worktree(w.head);
  const gw = gitIn(wt, o.run);
  const branch = w.branch === "" ? "" : await freeBranch(g, kept === "" && w.branch !== here.branch ? w.branch : `${w.branch}-continued`);
  await checkoutWork(gw, wt, w, branch, null);
  return { dir: wt, how: "worktree", kept };
}

// ---- a folder without Git, packed

interface PackEntry {
  p: string;
  m: number;
  n: number;
  l?: string;
}

/** Parts that are rebuilt, not copied. */
const SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".cache", ".git"]);

/**
 * A folder without Git as one blob: [4-byte header length][JSON list of entries][each file's bytes]. Null `bytes`
 * with `why`: too big, or too many files.
 */
export async function packFolder(root: string, max = WORK_MAX): Promise<{ bytes: Uint8Array | null; why: string; files: number }> {
  const entries: PackEntry[] = [];
  const blobs: Uint8Array[] = [];
  let bytes = 0;
  const walk = async (rel: string): Promise<string> => {
    let names: string[];
    try {
      names = (await readdir(join(root, rel))).sort();
    } catch {
      return "";
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const r = rel === "" ? n : `${rel}/${n}`;
      const abs = join(root, ...r.split("/"));
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (entries.length >= FILES_MAX_ENTRIES) return `more than ${FILES_MAX_ENTRIES} files`;
      if (st.isSymbolicLink()) entries.push({ p: r, m: 0, n: 0, l: (await readlink(abs)).replaceAll("\\", "/") });
      else if (st.isDirectory()) {
        entries.push({ p: r, m: 0o755, n: -1 });
        const why = await walk(r);
        if (why !== "") return why;
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > max) return `too big to carry (over ${Math.round(max / 1048576)} MB)`;
        const b = new Uint8Array(await readFile(abs));
        entries.push({ p: r, m: st.mode & 0o777, n: b.length });
        blobs.push(b);
      }
    }
    return "";
  };
  const why = await walk("");
  if (why !== "") return { bytes: null, why, files: 0 };
  const head = Buffer.from(JSON.stringify(entries));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return { bytes: new Uint8Array(Buffer.concat([len, head, ...blobs])), why: "", files: blobs.length };
}

const plain = (rel: string): boolean => rel !== "" && !rel.startsWith("/") && !rel.includes("\\") && !rel.includes("\0") && rel.split("/").every((p) => p !== "" && p !== "." && p !== ".." && !/^[A-Za-z]:$/.test(p));

/** A packed folder into `root` (made when missing): its files written over, others there left alone. Files written. */
export async function unpackFolder(blob: Uint8Array, root: string): Promise<number> {
  const b = Buffer.from(blob);
  const n = b.readUInt32BE(0);
  const entries = JSON.parse(b.subarray(4, 4 + n).toString("utf8")) as PackEntry[];
  if (!Array.isArray(entries)) throw new Error("the carried folder came garbled");
  let at = 4 + n;
  let files = 0;
  await mkdir(root, { recursive: true });
  for (const e of entries) {
    if (typeof e?.p !== "string" || !plain(e.p)) throw new Error("the carried folder came garbled");
    const abs = join(root, ...e.p.split("/"));
    if (relative(root, abs).startsWith("..")) throw new Error("the carried folder came garbled");
    // Never through a link made here or there.
    const parent = dirname(abs);
    if (parent !== root && (await lstat(parent).catch(() => null))?.isSymbolicLink()) continue;
    if (e.n === -1) await mkdir(abs, { recursive: true });
    else if (e.l !== undefined) continue;
    else {
      const data = b.subarray(at, at + e.n);
      at += e.n;
      await mkdir(parent, { recursive: true });
      if ((await lstat(abs).catch(() => null))?.isSymbolicLink()) await rm(abs, { force: true });
      await writeFile(abs, data, { mode: e.m || 0o644 });
      files++;
    }
  }
  return files;
}

// ---- what the chat is told

/** The notice of a chat that went on here from the cloud: "Continued on Desk — Tower is off", and what came with it. */
export function continuedNotice(here: string, off: string, o: { session: "resumed" | "new" | string; work: string[] }): { text: string; detail: string } {
  const lines: string[] = [];
  if (o.session === "resumed") lines.push(`The agent's session came from ${off}: it goes on with everything it knew.`);
  else if (o.session === "new") lines.push(`A new session with the conversation so far.`);
  else lines.push(`A new session with the conversation so far (${o.session}).`);
  lines.push(...o.work);
  return { text: `Continued on ${here} — ${off} is off`, detail: lines.join("\n") };
}

/** What the carried work did, in a line or two. */
export function workLines(w: WorkIndex | null, a: Applied | null, off: string, err: string, cloned: string): string[] {
  const out: string[] = [];
  if (cloned !== "") out.push(`Cloned the project into ${cloned}.`);
  if (err !== "") {
    out.push(`${off}'s uncommitted work couldn't come: ${err}.`);
    return out;
  }
  if (w === null) return out;
  if (w.why !== "") {
    out.push(`${off}'s uncommitted work stayed there: ${w.why}.`);
    return out;
  }
  const what: string[] = [];
  if (w.kind === "files") what.push("the project's files");
  if (w.commits > 0) what.push(`${w.commits} unpushed commit${w.commits === 1 ? "" : "s"}`);
  if (w.dirty) what.push("uncommitted changes");
  if (what.length > 0) out.push(`${cap(what.join(" and "))} came from ${off}.`);
  if (a?.how === "worktree") out.push(`Your changes here stay as they were: this chat works in ${a.dir}.`);
  if (a !== null && a.kept !== "") out.push(`This PC's own ${a.kept} has other commits: they stay on it.`);
  return out;
}

const cap = (s: string) => (s === "" ? s : s[0]?.toUpperCase() + s.slice(1));
