import { copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mention } from "@harbor/store";
import { http as meshHttp } from "./client.ts";
import { err, ok, urlEncode, type Reply } from "./http.ts";
import { resolveUpload } from "./hub.ts";
import type { Kv } from "./kv.ts";
import { projectSlug } from "./meshctx.ts";
import { outputWithin, type Spawner } from "./proc.ts";
import { label, type Dest, type Down, type Peer } from "./shared.ts";
import { arr, bool, int, obj, str, wire, type Json } from "./wire.ts";

/** Said in `hello` (`moves`): this Harbor takes moved chats. Raise it when the handoff changes. */
export const MOVEPC_VERSION = 1;
/** How long the target's listener waits for its answer to `adopt` (it fetches a branch). */
export const SERVE_WAIT_MS = 180_000;
/** The target takes the chat only within this of receiving the call (well inside `SERVE_WAIT_MS`). */
export const DEADLINE_MS = 150_000;
const SEND_WAIT = 200_000;
const GIT_TIMEOUT = 20_000;
const NET_TIMEOUT = 120_000;
/** Sidecar files per session, at most. */
export const MOVE_MAX_FILES = 4000;
/** kv: moves waiting for the target's answer, {gid: [peer id, peer name]}. */
const KV = "move_pc";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A PC a chat could move to; `why` says why not (now). */
export interface MoveTarget {
  id: string;
  name: string;
  why: string | null;
}

export interface HeldMessage {
  text: string;
  files: string[];
  mentions: Mention[];
}

/** The UI thread's part. */
export class MovepcLocal {
  /** Chats being handed over, by gid: [peer id, peer name], until the target has answered. */
  moving = new Map<string, [string, string]>();
  /** Gids this PC is taking from another PC right now. */
  adopting = new Set<string>();
  /** Gids whose handoff still runs here (its outcome settles them). */
  sending = new Set<string>();
  /** Started chats moving between this PC and its devices (relocate.rs): lead -> where to. */
  relocating = new Map<number, string>();
  /** Messages sent to a chat while it was being handed over: they follow it, or are sent here if it stays. */
  held = new Map<number, HeldMessage[]>();
  /** Projects moving to another PC as a whole (projectmoverun.ts): repo -> [peer id, peer name]. Their chats take no turns meanwhile. */
  projects = new Map<number, [string, string]>();

  load(kv: Kv): void {
    this.moving = new Map();
    const t = kv.get(KV);
    if (t === null) return;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v !== "object" || v === null || Array.isArray(v)) return;
      const m = new Map<string, [string, string]>();
      for (const [g, e] of Object.entries(v)) {
        if (!Array.isArray(e) || typeof e[0] !== "string" || typeof e[1] !== "string") return;
        m.set(g, [e[0], e[1]]);
      }
      this.moving = m;
    } catch {
      // unreadable: nothing is waiting
    }
  }

  save(kv: Kv): void {
    kv.set(KV, wire(Object.fromEntries(this.moving)));
  }

  /** The PC a chat (or its lead) is being handed to, by name. */
  movingTo(leadGid: string, leadId: number): string | null {
    return this.moving.get(leadGid)?.[1] ?? this.relocating.get(leadId) ?? null;
  }
}

/** A git remote reduced to "host/path", lowercased: scp-like, https and ssh URLs of one repository are the same. */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  let rest: string;
  const scheme = u.indexOf("://");
  if (scheme >= 0) rest = u.slice(scheme + 3);
  else {
    const c = u.indexOf(":");
    rest = c >= 0 && !u.slice(0, c).includes("/") ? `${u.slice(0, c)}/${u.slice(c + 1)}` : u;
  }
  const at = rest.indexOf("@");
  if (at >= 0 && !rest.slice(0, at).includes("/")) rest = rest.slice(at + 1);
  const slash = rest.indexOf("/");
  const host = (slash >= 0 ? rest.slice(0, slash) : rest).split(":")[0] ?? "";
  const path = slash >= 0 ? rest.slice(slash + 1) : "";
  return `${host}/${path.replace(/^\/+|\/+$/g, "")}`.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** One of this PC's projects, as matching sees it. */
export interface MoveCandidate {
  id: number;
  name: string;
  /** Its folder's name. */
  folder: string;
  remote: string;
}

/** This PC's project for the chat's project on the source: the same remote first, else the same folder or project name (only when one side has no remote). */
export function matchProject(cands: MoveCandidate[], remote: string, folder: string, name: string): number | null {
  const want = remote === "" ? "" : normalizeRemote(remote);
  if (want !== "") {
    const c = cands.find((x) => x.remote !== "" && normalizeRemote(x.remote) === want);
    if (c) return c.id;
  }
  const c = cands.filter((x) => want === "" || x.remote === "").find((x) => (folder !== "" && x.folder === folder) || (name !== "" && x.name === name));
  return c?.id ?? null;
}

/** A Claude account here that could take the chat: usage is (weekly, 5-hour) 0-1. */
export interface MoveAccountCand {
  id: string;
  email: string;
  usage: [number, number];
}

const lowerAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The account the chat runs as here: the source account's own login if it's here too, else this PC's default account, else the one with the most quota left. */
export function pickAccount(cands: MoveAccountCand[], email: string, def: string): string | null {
  if (email !== "") {
    const c = cands.find((x) => lowerAscii(x.email) === lowerAscii(email));
    if (c) return c.id;
  }
  const d = cands.find((x) => x.id === def);
  if (d) return d.id;
  let best: MoveAccountCand | null = null;
  for (const c of cands) if (best === null || c.usage[0] < best.usage[0] || (c.usage[0] === best.usage[0] && c.usage[1] < best.usage[1])) best = c;
  return best?.id ?? null;
}

/** A session id as Claude Code writes them (a uuid): nothing that could leave its folder. */
export function validSid(sid: string): boolean {
  return sid !== "" && sid.length <= 100 && /^[A-Za-z0-9_-]+$/.test(sid);
}

/** A path's components as Rust's `Path::components` reads them: null for anything but a plain name. */
function plainParts(rel: string): string[] | null {
  const segs = rel.split("/");
  if (segs[0] === "") return null;
  const parts: string[] = [];
  for (const [i, s] of segs.entries()) {
    if (s === "") continue;
    if (s === ".") {
      if (i === 0) return null;
      continue;
    }
    if (s === "..") return null;
    parts.push(s);
  }
  return parts;
}

/** A received file's place under the account's project folder: `<sid>.jsonl` or inside `<sid>/`. */
export function safeRel(sid: string, rel: string): boolean {
  if (!validSid(sid) || rel.includes("\\")) return false;
  const parts = plainParts(rel);
  if (parts === null || parts.length === 0) return false;
  if (parts.length === 1) return rel === `${sid}.jsonl`;
  return parts[0] === sid;
}

/** Where an account (its config dir; null: ~/.claude) keeps the sessions of `cwd`. */
export function sessionDir(home: string, config: string | null, cwd: string): string {
  return join(config ?? join(home, ".claude"), "projects", projectSlug(cwd));
}

function modified(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Every copy of session `sid` in the account's project folders, newest first. */
export function sessionCopies(home: string, config: string | null, sid: string): string[] {
  const root = join(config ?? join(home, ".claude"), "projects");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const found = dirs
    .map((d) => join(root, d, `${sid}.jsonl`))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .map((p) => ({ p, m: modified(p) }));
  found.sort((a, b) => (b.m ?? -1) - (a.m ?? -1));
  return found.map((x) => x.p);
}

/** Where the profiles of chats commanded from other PCs live (meshctx.rs `overlays`). */
export interface SessionEnv {
  home: string;
  overlays(): string[];
}

/** The newest copy of session `sid` of an account (null: ~/.claude), also in the overlay profiles, with its sidecar folder's files, as [place relative to the project folder, file here]. */
export function sessionFiles(env: SessionEnv, config: string | null, sid: string): [string, string][] | null {
  const copies = sessionCopies(env.home, config, sid);
  for (const p of env.overlays()) copies.push(...sessionCopies(env.home, p, sid));
  copies.sort((a, b) => (modified(b) ?? -1) - (modified(a) ?? -1));
  const src = copies[0];
  if (src === undefined) return null;
  const out: [string, string][] = [[`${sid}.jsonl`, src]];
  walk(src.replace(/\.[^./]*$/, ""), sid, out);
  out.length = Math.min(out.length, MOVE_MAX_FILES + 1);
  return out;
}

function walk(dir: string, rel: string, out: [string, string][]): void {
  let rd;
  try {
    rd = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of rd) {
    if (out.length > MOVE_MAX_FILES) return;
    const r = `${rel}/${e.name}`;
    // Symlinks stay behind: only what the session wrote travels.
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else if (e.isFile()) out.push([r, join(dir, e.name)]);
  }
}

/** Puts received session files into `dir`; every place is checked first, nothing is written if one is wrong. */
export function placeSessionFiles(dir: string, sid: string, files: [string, string][]): void {
  const bad = files.find(([rel]) => !safeRel(sid, rel));
  if (bad) throw new Error(`refused a session file outside its folder: ${bad[0]}`);
  for (const [rel, src] of files) {
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      copyFileSync(src, dst);
    } catch (e) {
      throw new Error(`couldn't write ${dst}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}


function firstGitError(stderr: string): string {
  const l = stderr
    .split(/\r?\n/)
    .map((x) => x.replace(/^(error: )+/, "").replace(/^(fatal: )+/, "").trim())
    .find((x) => x !== "" && !x.startsWith("hint:"));
  return l ?? "git failed";
}

/** `git -C dir args`: stdout (trimmed), or throws with git's first useful error line. */
export async function gitText(dir: string, args: string[], timeoutMs: number, run: Spawner = outputWithin, trimStart = true): Promise<string> {
  let out;
  try {
    out = await run("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], { timeoutMs, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  } catch (e) {
    throw new Error(`git: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code === 0) {
    const t = out.stdout.toString("utf8");
    return trimStart ? t.trim() : t.trimEnd();
  }
  throw new Error(firstGitError(out.stderr.toString("utf8")));
}

/** A folder's branch ("" when detached: then `detached` is the short commit) and how many files differ from it (untracked included). */
export interface GitHead {
  branch: string;
  detached: string;
  dirty: number;
}

export async function gitHead(dir: string, run: Spawner = outputWithin): Promise<GitHead | null> {
  let s: string;
  try {
    s = await gitText(dir, ["status", "--porcelain=v2", "--branch"], 10_000, run, false);
  } catch {
    return null;
  }
  const h: GitHead = { branch: "", detached: "", dirty: 0 };
  for (const l of s.split("\n")) {
    if (l.startsWith("# branch.head ")) {
      const b = l.slice("# branch.head ".length);
      h.branch = b === "(detached)" ? "" : b;
    } else if (l.startsWith("# branch.oid ")) h.detached = [...l.slice("# branch.oid ".length)].slice(0, 7).join("");
    else if (!l.startsWith("#") && l !== "") h.dirty += 1;
  }
  return h;
}

/** A folder's remotes, [name, URL], in git's order. */
async function remotes(dir: string, run: Spawner): Promise<[string, string][]> {
  let out = "";
  try {
    out = await gitText(dir, ["config", "--get-regexp", "^remote\\..*\\.url$"], GIT_TIMEOUT, run);
  } catch {
    return [];
  }
  const v: [string, string][] = [];
  for (const l of out.split("\n")) {
    const i = l.indexOf(" ");
    if (i < 0) continue;
    const k = l.slice(0, i);
    if (!k.startsWith("remote.") || !k.endsWith(".url")) continue;
    v.push([k.slice("remote.".length, -".url".length), l.slice(i + 1).trim()]);
  }
  return v;
}

/** The URL of a folder's remote: "origin", else the first one ("" when none). */
export async function remoteUrl(dir: string, run: Spawner = outputWithin): Promise<string> {
  const r = await remotes(dir, run);
  return (r.find(([n]) => n === "origin") ?? r[0])?.[1] ?? "";
}

/** The name of the remote of `dir` whose URL is `url` ("origin" when none is). */
async function remoteNamed(dir: string, url: string, run: Spawner): Promise<string> {
  const want = normalizeRemote(url);
  return (await remotes(dir, run)).find(([, u]) => normalizeRemote(u) === want)?.[0] ?? "origin";
}

/** Where the chat works on the source, as the move needs it. */
export interface MoveCode {
  remote: string;
  branch: string;
  sha: string;
  /** Its own worktree (its branch is pushed and checked out on the target). */
  worktree: boolean;
}

export const NO_MOVE_CODE: MoveCode = { remote: "", branch: "", sha: "", worktree: false };

export function tildeOf(home: string, p: string): string {
  const h = home.replace(/\/+$/, "");
  const a = p.replace(/\/+$/, "");
  if (a === h) return "~";
  return a.startsWith(`${h}/`) ? `~/${a.slice(h.length + 1)}` : p;
}

export interface CodeEnv {
  home: string;
  run?: Spawner;
}

/** Refuses a folder with uncommitted changes; reads its remote, branch and commit. */
export async function codeState(env: CodeEnv, dir: string, worktree: boolean): Promise<MoveCode> {
  const run = env.run ?? outputWithin;
  const h = await gitHead(dir, run);
  // Not a git folder: nothing to carry, nothing to lose.
  if (h === null) return { ...NO_MOVE_CODE };
  if (h.dirty > 0) throw new Error(`${tildeOf(env.home, dir)} has ${h.dirty} uncommitted change${h.dirty === 1 ? "" : "s"}: commit or stash them first`);
  if (worktree && h.branch === "") throw new Error("its worktree is on a detached commit: put it on a branch first");
  const sha = await gitText(dir, ["rev-parse", "--short", "HEAD"], GIT_TIMEOUT, run).catch(() => "");
  return { remote: await remoteUrl(dir, run), branch: h.branch, sha, worktree };
}

/** Pushes a worktree's branch to its remote (the source, before the handoff). */
export async function pushBranch(dir: string, branch: string, remote: string, run: Spawner = outputWithin): Promise<void> {
  const name = await remoteNamed(dir, remote, run);
  try {
    await gitText(dir, ["push", "-u", name, branch], NET_TIMEOUT, run);
  } catch (e) {
    throw new Error(`couldn't push ${branch}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface WorktreeEnv {
  /** The folder worktrees are made in (worktree::root). */
  root: string;
  /** Six hex digits from a fresh uuid. */
  newId(): string;
  run?: Spawner;
}

/** Checks out the pushed branch in a new worktree of `repo` (the target); `here`: the branch is in `repo` already (a project move's). Returns its folder. */
export async function fetchWorktree(env: WorktreeEnv, repo: string, branch: string, remote: string, here = false): Promise<string> {
  const run = env.run ?? outputWithin;
  const name = await remoteNamed(repo, remote, run);
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  if (!here) {
    try {
      await gitText(repo, ["fetch", name, branch], NET_TIMEOUT, run);
    } catch (e) {
      throw new Error(`couldn't fetch ${branch}: ${msg(e)}`);
    }
  }
  const base = repo.replace(/\/+$/, "").split("/").pop();
  const project = [...(base ?? "") === "" ? "project" : (base ?? "")].map((c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : "-")).join("");
  mkdirSync(env.root, { recursive: true });
  const tailMatch = /^harbor\/([A-Za-z0-9]*)$/.exec(branch);
  const tail = tailMatch ? (tailMatch[1] ?? "") : null;
  let last = "";
  for (let n = 0; n < 4; n++) {
    const id = tail !== null && n === 0 ? tail : env.newId();
    const dir = join(env.root, `${project}-${id}`);
    if (existsSync(dir)) continue;
    const upstream = `${name}/${branch}`;
    try {
      if (here) await gitText(repo, ["worktree", "add", dir, branch], NET_TIMEOUT, run);
      else {
        try {
          await gitText(repo, ["worktree", "add", "--track", "-b", branch, dir, upstream], NET_TIMEOUT, run);
        } catch {
          await gitText(repo, ["worktree", "add", dir, branch], NET_TIMEOUT, run);
        }
      }
      return dir;
    } catch (e) {
      last = msg(e);
    }
  }
  throw new Error(`couldn't check out ${branch}: ${last}`);
}

/** The deadline the target's listener stamps on an `adopt` call (mesh.rs `serve`). */
export function deadlineMs(now = Date.now()): number {
  return now + DEADLINE_MS;
}


/** How a handoff ended, as the source sees it. */
export type MoveOutcome =
  /** The target owns the chats now: gid -> their ids there. */
  | { kind: "done"; ids: Map<string, number> }
  /** It said no (or can't): the chat stays here. */
  | { kind: "refused"; why: string }
  /** No answer: it may or may not have taken it. */
  | { kind: "unknown"; why: string };

/** What the source sends, prepared where the app can read its chats. */
export interface MoveHandoff {
  dest: Dest;
  peer: string;
  /** `adopt/check`'s body (also the base of `adopt`'s). */
  check: { [k: string]: Json };
  payload: Uint8Array;
  /** [sid, files] */
  sessions: [string, [string, string][]][];
  /** A worktree to push first: [its folder, branch, remote URL]. */
  push: [string, string, string] | null;
}

export type MeshHttp = typeof meshHttp;

export interface MoveSendDeps {
  http?: MeshHttp;
  sleep?: (ms: number) => Promise<void>;
  push?: (dir: string, branch: string, remote: string) => Promise<void>;
  /** Pause between asks after a lost answer (10 s). */
  askEveryMs?: number;
}

function idsOf(v: unknown): Map<string, number> {
  const m = new Map<string, number>();
  for (const [g, i] of Object.entries(obj(obj(v).ids))) {
    const n = int(i);
    if (n !== null) m.set(g, n);
  }
  return m;
}

/** The handoff: ask, push the branch, upload, adopt; only the target's answer decides. */
export async function sendHandoff(h: MoveHandoff, deps: MoveSendDeps = {}): Promise<MoveOutcome> {
  const http = deps.http ?? meshHttp;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pushIt = deps.push ?? ((d: string, b: string, r: string) => pushBranch(d, b, r));
  const name = h.peer;
  const post = (path: string, body: Json, wait: number) => http(h.dest, "POST", path, { ctype: "application/json", data: wire(body) }, wait);
  const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // 1. Can it take it? A Harbor before moves answers 404: nothing was sent yet.
  try {
    const [status, v] = await post("/mesh/v1/adopt/check", h.check, 30_000);
    const o = obj(v);
    if (status === 200 && o.owns === true) return { kind: "done", ids: idsOf(v) };
    if (status === 200 && o.ok === true) {
      // goes on
    } else if (status === 200 || status === 409) return { kind: "refused", why: str(o.why) ?? str(o.error) ?? "it can't take it" };
    else if (status === 404) return { kind: "refused", why: `${name} runs an older Harbor: update it first` };
    else return { kind: "refused", why: `${name} answered ${status}: ${str(o.error) ?? ""}` };
  } catch (e) {
    return { kind: "refused", why: `${name} didn't answer: ${text(e)}` };
  }
  // 2. The worktree's branch goes to its remote, for the target to fetch.
  if (h.push) {
    try {
      await pushIt(...h.push);
    } catch (e) {
      return { kind: "refused", why: text(e) };
    }
  }
  // 3. Transcripts and sessions, as uploads there.
  const upload = async (file: string, data: Uint8Array): Promise<string> => {
    try {
      const [status, v] = await http(h.dest, "POST", `/mesh/v1/upload?name=${urlEncode(file)}`, { ctype: "application/octet-stream", data }, NET_TIMEOUT);
      if (status === 201) {
        const id = str(obj(v).id);
        if (id === null) throw new Error("no upload id");
        return id;
      }
      throw new Error(`${status}: ${str(obj(v).error) ?? ""}`);
    } catch (e) {
      throw new Error(text(e));
    }
  };
  let payload: string;
  try {
    payload = await upload("move.json", h.payload);
  } catch (e) {
    return { kind: "refused", why: `couldn't send the chat to ${name}: ${text(e)}` };
  }
  const sessions: Json[] = [];
  for (const [sid, files] of h.sessions) {
    const list: Json[] = [];
    for (const [rel, path] of files) {
      let data: Buffer;
      try {
        data = readFileSync(path);
      } catch (e) {
        return { kind: "refused", why: `couldn't read ${path}: ${text(e)}` };
      }
      try {
        list.push({ rel, upload: await upload(`${sid}.part`, data) });
      } catch (e) {
        return { kind: "refused", why: `couldn't send a session to ${name}: ${text(e)}` };
      }
    }
    sessions.push({ sid, files: list });
  }
  // 4. The handoff. Only its answer decides.
  const body: { [k: string]: Json } = { ...h.check, payload, sessions };
  let why: string;
  try {
    const [status, v] = await post("/mesh/v1/adopt", body, SEND_WAIT);
    const o = obj(v);
    if (status === 200) return { kind: "done", ids: idsOf(v) };
    if (status === 503) why = str(o.error) ?? "no answer";
    else return { kind: "refused", why: str(o.error) ?? "it refused" };
  } catch (e) {
    why = text(e);
  }
  // No answer: ask until it says whether it took it.
  const gid = h.check.gid ?? null;
  for (let i = 0; i < 12; i++) {
    await sleep(deps.askEveryMs ?? 10_000);
    try {
      const [status, v] = await post("/mesh/v1/adopt/check", { gid }, 20_000);
      const o = obj(v);
      if (status === 200 && o.owns === true) return { kind: "done", ids: idsOf(v) };
      if (status === 200 && o.busy !== true) return { kind: "refused", why: `${name} didn't take it (${why})` };
    } catch {
      // keep asking
    }
  }
  return { kind: "unknown", why };
}

/** One chat of the handoff, as the app holds it. */
export interface MoveChat {
  gid: string;
  /** Auto chose the receiving PC. Missing on older peers: false. */
  auto_placed?: boolean;
  title: string;
  session_id: string;
  started: boolean;
  model: string;
  effort: string;
  access: string;
  settled: boolean;
  retired: boolean;
  /** Role::as_str. */
  role: string;
  /** The parent chat's gid. */
  parent: string | null;
  name: string;
  /** The transcript's items as the database writes them. */
  items: Json;
}

/** `move.json`: the lead first, then its sub-agents. */
export function movePayload(chats: MoveChat[]): Uint8Array {
  return Buffer.from(wire({ chats: chats.map((c) => ({ ...c })) }));
}

export interface MoveCheckInput {
  gid: string;
  email: string;
  /** `at`: a project move's, the project's folder on the target. */
  project: { name: string; folder: string; remote: string; at?: string } | null;
  from: string;
  code: { branch: string; sha: string; worktree: boolean; remote: string };
}

/** `adopt/check`'s body (also the base of `adopt`'s). */
export function moveCheckBody(i: MoveCheckInput): { [k: string]: Json } {
  return {
    gid: i.gid,
    kind: "claude",
    email: i.email,
    project: i.project,
    from: i.from,
    code: { branch: i.code.branch, sha: i.code.sha },
    worktree: i.code.worktree ? { branch: i.code.branch, remote: i.code.remote } : null,
  };
}

/** What the chat's lead and sub-agents say about themselves, for the blocker. */
export interface MoveSubject {
  id: number;
  name: string;
  device: string;
  claude: boolean;
  running: boolean;
}

export interface BlockerInput {
  /** A copy of another PC's chat: that PC's name; null for this PC's own. */
  foreignHome: string | null;
  isSub: boolean;
  meshOn: boolean;
  movingTo: string | null;
  /** The lead first, then its sub-agents. */
  chats: MoveSubject[];
}

/** Why this PC's chat can't move to any PC now (null: it may, the PCs say the rest). Cheap: no git. */
export function movePcBlocker(i: BlockerInput): string | null {
  if (i.foreignHome !== null) return `this chat is ${i.foreignHome}'s: move it from there`;
  if (i.isSub) return "a sub-agent moves with its lead: move the lead";
  if (!i.meshOn) return "this PC doesn't share chats with other PCs (Settings › Workspace)";
  if (i.movingTo !== null) return `it's moving to ${i.movingTo}`;
  const lead = i.chats[0];
  for (const x of i.chats) {
    const it = x === lead ? "it" : `its sub-agent ${x.name}`;
    // A chat on an SSH device comes here first, its sessions with it: relocate.rs.
    if (lead && x.device !== lead.device) return `${it} runs on another device than its lead`;
    if (!x.claude) return `${it} isn't a Claude chat: only Claude chats move to another PC for now`;
    if (x.running) return `${it} is running: move it once its turn ends`;
  }
  return null;
}

export interface TargetsInput {
  blocker: string | null;
  meId: string;
  hosts: Peer[];
  /** Whether a key is on the allowed list (a PC paired but off still shows). */
  allowedFp(fp: string): boolean;
  downOf(id: string): Down | null;
}

/** The PCs this PC's chat could move to, each with why not (if so). */
export function movePcTargets(i: TargetsInput): MoveTarget[] {
  return i.hosts
    .filter((p) => p.id !== i.meId && (p.online || i.allowedFp(p.fp)))
    .map((p) => {
      let why: string | null;
      if (i.blocker !== null) why = i.blocker;
      else if (!p.online) why = i.downOf(p.id) === "harbor" ? "Harbor isn't running there" : "it's off or out of reach";
      else if (!p.moves) why = "it runs an older Harbor: update it first";
      else if (!p.accounts.some((a) => a[2] === "claude")) why = "it has no Claude account";
      else why = null;
      return { id: p.id, name: p.name === "" ? label(p.id) : p.name, why };
    });
}

/** `GET /v1/chats/{id}/move_targets`: with the code's state (a refusing folder blocks every PC). */
export function apiMoveTargets(blocker: string | null, targets: MoveTarget[], codeError: string | null): Json {
  let why = blocker;
  let list = targets;
  if (why === null && codeError !== null) {
    list = targets.map((t) => ({ ...t, why: codeError }));
    why = codeError;
  }
  return { why, targets: list.map((t) => ({ id: t.id, name: t.name, why: t.why })) };
}

/** A target's chat list while a move to it waits for an answer: listed as its own, the move happened; a full list without it, it didn't. */
export function moveReconcile(moving: Map<string, [string, string]>, sending: Set<string>, peer: string, body: unknown): { release: [string, Map<string, number>][]; stays: [string, string][] } {
  const listed = new Map<string, number>();
  for (const m of arr(obj(body).chats)) {
    const g = str(obj(m).gid);
    const id = int(obj(m).id);
    if (g !== null && id !== null) listed.set(g, id);
  }
  const full = bool(obj(body).full) ?? false;
  const release: [string, Map<string, number>][] = [];
  const stays: [string, string][] = [];
  for (const [gid, [p, name]] of moving) {
    if (p !== peer) continue;
    if (listed.has(gid)) release.push([gid, listed]);
    else if (full && !sending.has(gid)) stays.push([gid, name]);
  }
  return { release, stays };
}


export interface MoveAccount {
  id: string;
  email: string;
  /** A Claude account that is installed, signed in and under no block or cap. */
  usable: boolean;
  usage: [number, number];
  configDir: string | null;
  /** How the account is named in notices. */
  short: string;
}

/** A chat of this PC with a gid, for the checks of an arriving move. */
export interface OwnedChat {
  id: number;
  gid: string;
  /** A copy of another PC's chat: its home PC's id and name. */
  home: string;
  homeName: string;
  foreign: boolean;
}

/** What the target PC's app provides to a move. */
export interface MoveTargetApp {
  meName(): string;
  home: string;
  accounts(): MoveAccount[];
  defaultAccount(): string;
  candidates(): MoveCandidate[] | Promise<MoveCandidate[]>;
  repo(id: number): { name: string; dir: string } | null;
  /** The project whose folder is `dir` (a project move's). */
  repoAt?(dir: string): number | null;
  isCheckout(dir: string): Promise<boolean>;
  /** This PC's own chat with the gid, and its sub-agents: gid -> id. */
  owned(gid: string): Map<string, number> | null;
  chatOf(gid: string): OwnedChat | null;
  adopting: Set<string>;
  uploadsDir: string;
  worktree: WorktreeEnv;
  removeWorktree(repo: string, dir: string): Promise<void>;
  /** Makes the received chats this PC's own; returns gid -> id here. */
  take(peer: string, chats: unknown[], repo: number | null, account: string, worktree: string | null, body: unknown): Map<string, number>;
  now?: () => number;
}

/** The project and account the chat would get here, or why it can't come. */
export async function movePlan(app: MoveTargetApp, body: unknown): Promise<{ repo: number | null; account: string }> {
  const me = app.meName();
  const b = obj(body);
  if (b.kind !== "claude") throw new Error(`${me} only takes Claude chats for now`);
  const cands: MoveAccountCand[] = app.accounts().filter((a) => a.usable).map((a) => ({ id: a.id, email: a.email, usage: a.usage }));
  const account = pickAccount(cands, str(b.email) ?? "", app.defaultAccount());
  if (account === null) throw new Error(`${me} has no Claude account signed in that can take it now`);
  const p = b.project;
  if (p === null || p === undefined) return { repo: null, account };
  const s = (k: string) => str(obj(p)[k]) ?? "";
  const at = s("at");
  // A project move's chats go to the folder the move put the project in.
  const repo = at !== "" ? (app.repoAt?.(at) ?? null) : matchProject(await app.candidates(), s("remote"), s("folder"), s("name"));
  if (repo === null && at !== "") throw new Error(`${me} has no project at ${tildeOf(app.home, at)}`);
  if (repo === null) {
    // A folder without Git has nothing to clone, only its files to copy.
    if (s("remote") === "") throw new Error(`${me} has no project named ${s("name")}: copy its folder there and add it to Harbor first`);
    throw new Error(`${me} has no project for ${s("name")} (${s("remote")}): clone it there and add it to Harbor first`);
  }
  if (isObject(b.worktree)) {
    const dir = app.repo(repo)?.dir ?? "";
    if (!(await app.isCheckout(dir))) throw new Error(`${me}'s copy of the project isn't a git checkout`);
  }
  return { repo, account };
}

function idsJson(m: Map<string, number>): Json {
  return Object.fromEntries(m);
}

/** `POST /mesh/v1/adopt/check` from the chat's home: whether this PC owns it already (an answer that got lost), is taking it now, or could take it. */
export async function moveCheck(app: MoveTargetApp, peer: string, body: unknown): Promise<Reply> {
  const b = obj(body);
  const gid = str(b.gid) ?? "";
  if (gid === "") return err(400, "no chat");
  const owned = app.owned(gid);
  if (owned) return ok({ ok: true, owns: true, ids: idsJson(owned) });
  if (app.adopting.has(gid)) return ok({ ok: false, owns: false, busy: true });
  if (b.kind === null || b.kind === undefined) return ok({ ok: false, owns: false, busy: false });
  const c = app.chatOf(gid);
  if (c && c.home !== peer) return ok({ ok: false, owns: false, why: `this chat belongs to ${c.homeName} here, not to you` });
  try {
    const { repo, account } = await movePlan(app, body);
    const project = repo === null ? null : (app.repo(repo)?.name ?? null);
    const acc = app.accounts().find((a) => a.id === account)?.short ?? account;
    return ok({ ok: true, owns: false, project, account: acc });
  } catch (e) {
    return ok({ ok: false, owns: false, why: e instanceof Error ? e.message : String(e) });
  }
}

/** `POST /mesh/v1/adopt` from the chat's home: takes the chat, or says why not. `device` is the caller's id. */
export async function moveAdopt(app: MoveTargetApp, device: string, body: unknown): Promise<Reply> {
  const b = obj(body);
  const now = app.now ?? Date.now;
  const gid = str(b.gid) ?? "";
  if (gid === "") return err(400, "no chat");
  const owned = app.owned(gid);
  if (owned) return ok({ ok: true, ids: idsJson(owned) });
  if (app.adopting.has(gid)) return err(409, "already taking this chat");
  const deadline = int(b.deadline_ms) ?? 0;
  if (now() > deadline) return err(409, "the call came too late");
  const existing = app.chatOf(gid);
  if (existing && existing.home !== device) return err(409, `this chat belongs to ${existing.homeName} here, not to you`);
  let plan;
  try {
    plan = await movePlan(app, body);
  } catch (e) {
    return err(409, e instanceof Error ? e.message : String(e));
  }
  const payloadId = str(b.payload);
  const payloadPath = payloadId === null ? null : resolveUpload(app.uploadsDir, payloadId);
  if (payloadPath === null) return err(400, "the chat's upload is missing");
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch {
    return err(400, "the chat's upload isn't readable");
  }
  const chats = arr(obj(payload).chats);
  if (str(obj(chats[0]).gid) !== gid) return err(400, "the upload is another chat");
  // Every file and its place, checked before anything is written.
  const uploads = [payloadPath];
  const sessions: [string, [string, string][]][] = [];
  for (const s of arr(b.sessions)) {
    const sid = str(obj(s).sid) ?? "";
    const files: [string, string][] = [];
    for (const f of arr(obj(s).files)) {
      const rel = str(obj(f).rel) ?? "";
      const up = str(obj(f).upload);
      const p = up === null ? null : resolveUpload(app.uploadsDir, up);
      if (p === null) return err(400, "a session file is missing");
      if (!safeRel(sid, rel)) return err(400, `refused a session file outside its folder: ${rel}`);
      uploads.push(p);
      files.push([rel, p]);
    }
    if (files.length > MOVE_MAX_FILES + 1) return err(400, "too many session files");
    sessions.push([sid, files]);
  }
  const config = app.accounts().find((a) => a.id === plan.account)?.configDir ?? null;
  const repoPath = plan.repo === null ? null : (app.repo(plan.repo)?.dir ?? null);
  const wtSpec = isObject(b.worktree) ? [str(obj(b.worktree).branch) ?? "", str(obj(b.worktree).remote) ?? ""] : null;
  const wtHere = isObject(b.worktree) && obj(b.worktree).here === true;
  app.adopting.add(gid);
  let wt: string | null = null;
  let failure: string | null = null;
  try {
    const branch = wtSpec?.[0];
    if (branch !== undefined && branch !== "" && repoPath !== null) wt = await fetchWorktree(app.worktree, repoPath, branch, wtSpec?.[1] ?? "", wtHere);
    const cwd = wt ?? repoPath ?? app.home;
    const dir = sessionDir(app.home, config, cwd);
    for (const [sid, files] of sessions) {
      try {
        placeSessionFiles(dir, sid, files);
      } catch (e) {
        if (wt !== null && repoPath !== null) await app.removeWorktree(repoPath, wt).catch(() => undefined);
        wt = null;
        throw e;
      }
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  app.adopting.delete(gid);
  for (const u of uploads) rmSync(u, { force: true });
  if (failure !== null) return err(409, failure);
  if (now() > deadline) {
    // The source has given up waiting: it keeps the chat.
    if (wt !== null && repoPath !== null) void app.removeWorktree(repoPath, wt).catch(() => undefined);
    return err(409, "it took too long");
  }
  return ok({ ok: true, ids: idsJson(app.take(device, chats, plan.repo, plan.account, wt, body)) });
}

/** The notice a chat gets on the PC that took it: "Moved here from <from>" and its detail. */
export function movedHereDetail(i: {
  accountShort: string;
  /** The project's folder here, as ~/…; null without a project. */
  project: string | null;
  worktreeName: string | null;
  from: string;
  code: { branch: string; sha: string } | null;
  /** This PC's checkout of the project (not a worktree): what it is on now. */
  checkout: { label: string; sha: string } | null;
}): string {
  let d = `It runs as ${i.accountShort} here`;
  if (i.project !== null) d += `, in ${i.project}`;
  if (i.worktreeName !== null) d += `, worktree ${i.worktreeName}`;
  if (i.code && i.code.branch !== "") {
    d += `. On ${i.from} it was on ${i.code.branch} at ${i.code.sha}`;
    if (i.checkout) d += `; here the checkout is on ${i.checkout.label} at ${i.checkout.sha}`;
  }
  return `${d}.`;
}

/** A received chat (one entry of `move.json`) as the fields a chat here gets. */
export function receivedChat(m: unknown): { gid: string; auto_placed: boolean; title: string; session_id: string; started: boolean; model: string; effort: string; access: string; settled: boolean; retired: boolean; role: string; parent: string | null; name: string; items: unknown } {
  const o = obj(m);
  const s = (k: string) => str(o[k]) ?? "";
  return {
    gid: s("gid"),
    auto_placed: o.auto_placed === true,
    title: s("title"),
    session_id: s("session_id"),
    started: bool(o.started) ?? false,
    model: s("model"),
    effort: s("effort"),
    access: s("access"),
    settled: bool(o.settled) ?? false,
    retired: bool(o.retired) ?? false,
    role: str(o.role) ?? "chat",
    parent: str(o.parent),
    name: s("name"),
    items: o.items,
  };
}

export function gitHeadLabel(h: GitHead): string {
  return h.branch === "" ? `detached at ${h.detached}` : h.branch;
}

/** What `move_pc` collects before it sends: each started chat's Claude session files, or why the chat can't go. */
export function moveSessions(
  env: SessionEnv,
  leadId: number,
  chats: { id: number; name: string; started: boolean; session_id: string; configDir: string | null }[],
): [string, [string, string][]][] {
  const out: [string, [string, string][]][] = [];
  for (const c of chats) {
    if (!c.started || c.session_id === "") continue;
    if (!validSid(c.session_id)) throw new Error(`${c.name}'s session id looks wrong`);
    const files = sessionFiles(env, c.configDir, c.session_id);
    if (files === null) throw new Error(`${c.id === leadId ? "its" : `${c.name}'s`} Claude session isn't on this PC`);
    if (files.length > MOVE_MAX_FILES) throw new Error(`${c.name}'s session has too many files to send`);
    out.push([c.session_id, files]);
  }
  return out;
}

/** A copy's targets, from its home PC: `GET /v1/chats/{hid}/move_targets` through `/mesh/v1/call`. Throws what the menu shows. */
export async function askMoveTargets(dest: Dest, hid: number, http: MeshHttp = meshHttp): Promise<{ why: string | null; targets: MoveTarget[] }> {
  const call = { method: "GET", path: ["v1", "chats", String(hid), "move_targets"], body: null };
  const [status, v] = await http(dest, "POST", "/mesh/v1/call", { ctype: "application/json", data: wire(call) }, 20_000);
  if (status === 404) throw new Error("its PC runs an older Harbor");
  const o = obj(v);
  if (status !== 200) throw new Error(str(o.error) ?? "its PC didn't say");
  const targets: MoveTarget[] = [];
  for (const t of arr(o.targets)) {
    const x = obj(t);
    const id = str(x.id);
    const name = str(x.name);
    if (id === null || name === null) return { why: str(o.why), targets: [] };
    targets.push({ id, name, why: str(x.why) });
  }
  return { why: str(o.why), targets };
}

/** What the source tells the person when a handoff ends: the chat's notice (none when it went through) and the toast. */
export function moveOutcomeText(name: string, o: MoveOutcome): { notice: string | null; toast: string | null } {
  switch (o.kind) {
    case "done":
      return { notice: null, toast: `Moved to ${name}: it goes on there` };
    case "refused":
      return { notice: `Couldn't move to ${name}: ${o.why}`, toast: `Couldn't move to ${name}: ${o.why}` };
    case "unknown":
      return { notice: `Moving to ${name}: no answer yet (${o.why}). The chat stays here and takes no turns until ${name} answers.`, toast: null };
  }
}

/** The notice when a target's full chat list shows it didn't take a chat. */
export function moveStaysText(name: string): string {
  return `${name} didn't take the chat: it stays on this PC`;
}
