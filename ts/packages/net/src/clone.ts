import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Item } from "@harbor/store";
import { gitText, tildeOf } from "./movepc.ts";
import { outputWithin, type Spawner } from "./proc.ts";
import type { Json } from "./wire.ts";

/** `mesh::Msg::Done`'s `what` for Run on <owner>: from this window (the new chat opens), or from a phone (it opens it itself). */
export const CLONE_RUN_THERE = "run the chat there";
export const CLONE_RAN_THERE = "run the chat there from a phone";

const CLONE_TIMEOUT = 15 * 60_000;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

function trimEnd(s: string, tail: string): string {
  let r = s;
  while (r.endsWith(tail)) r = r.slice(0, r.length - tail.length);
  return r;
}

/** git@github.com:a/b.git and https://github.com/a/b.git both become https://github.com/a/b (git.rs `web_url`). */
export function cloneWebUrl(url: string): string {
  const u = trimEnd(url.trim(), ".git");
  if (u.startsWith("ssh://")) {
    let rest = u.slice("ssh://".length);
    const at = rest.indexOf("@");
    if (at >= 0) rest = rest.slice(at + 1);
    const slash = rest.indexOf("/");
    if (slash >= 0) return `https://${rest.slice(0, slash).split(":")[0]}/${rest.slice(slash + 1)}`;
  }
  if (u.startsWith("git@")) {
    const rest = u.slice("git@".length);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `https://${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  return u;
}

/** A remote's identity, whatever its form; empty for no remote. */
export function cloneNormalize(remote: string): string {
  const r = remote.trim();
  if (r === "") return "";
  const web = cloneWebUrl(r);
  const scheme = web.indexOf("://");
  let rest = scheme >= 0 ? web.slice(scheme + 3) : web;
  // Credentials in an https URL (user:token@host).
  const slash = rest.indexOf("/");
  if (slash >= 0) rest = `${rest.slice(0, slash).split("@").pop()}/${rest.slice(slash + 1)}`;
  return trimEnd(trimEnd(rest, "/"), ".git").toLowerCase();
}

/** Whether two remotes name the same repository. */
export function cloneSame(a: string, b: string): boolean {
  const x = cloneNormalize(a);
  return x !== "" && x === cloneNormalize(b);
}

/** owner/name of a GitHub remote URL (prs.rs `github_repo`). */
export function cloneGithubRepo(remote: string): string | null {
  const r = remote.trim();
  let rest: string | null = null;
  for (const p of ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/", "ssh://git@github.com:22/", "git://github.com/"]) {
    if (r.startsWith(p)) {
      rest = r.slice(p.length);
      break;
    }
  }
  if (rest === null && r.startsWith("https://")) {
    const x = r.slice("https://".length);
    const at = x.indexOf("@");
    if (at >= 0 && x.slice(at + 1).startsWith("github.com/")) rest = x.slice(at + 1 + "github.com/".length);
  }
  if (rest === null) return null;
  const it = trimEnd(rest, "/").split("/");
  const o = it[0];
  let n = it[1];
  if (o === undefined || n === undefined) return null;
  if (n.endsWith(".git")) n = n.slice(0, -4);
  return o !== "" && n !== "" ? `${o}/${n}` : null;
}

/** Where this PC keeps a project the owner has at `owner`: the same place relative to home (`/home/<owner>/Documents/x/proj` becomes `<home>/Documents/x/proj`). A folder outside the owner's home goes straight under this home. */
export function homeRelative(owner: string, home: string, name: string): string {
  // Another PC's path: "/home/sam/…", "/Users/sam/…", or a Windows PC's "C:\Users\sam\…".
  const all = owner.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  const drive = /^[A-Za-z]:$/.test(all[0] ?? "");
  const segs = drive ? all.slice(1) : all;
  const parts = owner.startsWith("/") || drive ? ["/", ...segs] : segs;
  const second = parts[1] ?? "";
  let skip: number | null = null;
  if ((second === "home" || second === "Users") && parts.length > 3) skip = 3;
  else if (second === "root" && parts.length > 2) skip = 2;
  if (skip !== null) return join(home, ...parts.slice(skip));
  const last = segs[segs.length - 1];
  return join(home, last === undefined || last === "" ? name : last);
}

/** This PC's folder for `remote` among its projects' folders and remotes, if one is here. */
export function findClone(dirs: Iterable<[string, string]>, remote: string): string | null {
  for (const [d, r] of dirs) if (cloneSame(r, remote) && isDir(d)) return d;
  return null;
}

/** Where to clone into, given what's on disk: `found` a clone of the same repository already there (use it), `free` a path to clone into (`want`, else `want-2`, `want-3`…). `origin(dir)` reads a folder's remote. */
export function clonePlace(want: string, remote: string, origin: (dir: string) => string | null): { kind: "found" | "free"; dir: string } {
  for (let n = 1; ; n++) {
    const p = n === 1 ? want : `${want}-${n}`;
    if (!exists(p) || isEmptyDir(p)) return { kind: "free", dir: p };
    const o = origin(p);
    if (o !== null && cloneSame(o, remote)) return { kind: "found", dir: p };
  }
}

/** Whether a remote another PC sent is one to clone: a network URL (https, http, ssh, git) or scp-like `user@host:path`. Never an option (`--upload-pack=…`), a helper (`ext::…`) or a local path. */
export function cloneable(remote: string): boolean {
  const r = remote.trim();
  if (r === "" || r.startsWith("-") || /[\s\p{Cc}]/u.test(r)) return false;
  const i = r.indexOf("://");
  if (i >= 0) {
    const scheme = r.slice(0, i);
    const rest = r.slice(i + 3);
    return ["https", "http", "ssh", "git"].includes(scheme) && rest !== "" && !rest.startsWith("-");
  }
  // scp-like: [user@]host:path, the host neither empty nor an option, no "::" helper.
  const c = r.indexOf(":");
  if (c < 0) return false;
  const host = r.slice(0, c);
  const path = r.slice(c + 1);
  return host !== "" && !host.includes("/") && path !== "" && !path.startsWith(":");
}

export interface CloneDeps {
  /** git, gh and ssh run through this. */
  run?: Spawner;
  /** Whether gh is signed in to github.com. */
  ghSignedIn?: () => Promise<boolean>;
}

async function ghSignedIn(run: Spawner): Promise<boolean> {
  try {
    return (await run("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}

/** Clones `remote` into `dest`: with `gh` when it's a GitHub repository and gh is signed in (its login and protocol), else with git (its own credentials; never a prompt). */
export async function cloneRun(remote: string, dest: string, deps: CloneDeps = {}): Promise<void> {
  if (!cloneable(remote)) throw new Error(`${JSON.stringify(remote)} isn't a git remote to clone from`);
  const run = deps.run ?? outputWithin;
  const parent = dirname(dest);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (e) {
    throw new Error(`can't create ${parent}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const slug = cloneGithubRepo(remote);
  const gh = slug !== null && (await (deps.ghSignedIn ?? (() => ghSignedIn(run)))()) ? slug : null;
  const [program, args] = gh !== null ? (["gh", ["repo", "clone", gh, dest, "--", "-q"]] as const) : (["git", ["clone", "-q", "--", remote, dest]] as const);
  let out;
  try {
    out = await run(program, [...args], { timeoutMs: CLONE_TIMEOUT, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
  } catch (e) {
    throw new Error(`${program}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code === 0) return;
  const lines = out.stderr.toString("utf8").trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  throw new Error(lines[lines.length - 1] ?? "the clone failed");
}

async function originOf(dir: string, run: Spawner): Promise<string | null> {
  try {
    const u = await gitText(dir, ["remote", "get-url", "origin"], 15_000, run);
    return u === "" ? null : u;
  } catch {
    return null;
  }
}

/** The thread's work: a clone of `remote` at `want` (or beside it), or the one already there. */
export async function cloneFetch(remote: string, want: string, deps: CloneDeps = {}): Promise<string> {
  const run = deps.run ?? outputWithin;
  // `clonePlace` reads origins synchronously: they are asked for first, for each name it may try.
  const origins = new Map<string, string | null>();
  for (let n = 1; n <= 50; n++) {
    const p = n === 1 ? want : `${want}-${n}`;
    if (!exists(p) || isEmptyDir(p)) break;
    origins.set(p, await originOf(p, run));
  }
  const placed = clonePlace(want, remote, (p) => origins.get(p) ?? null);
  if (placed.kind === "found") return placed.dir;
  await cloneRun(remote, placed.dir, deps);
  return placed.dir;
}

/** "Clone here" into a folder the user picked: the project itself when it's a clone of the remote (or, with no remote known, a folder with files), else a clone in it (in a new folder named after the project when it holds other files). */
export async function cloneFetchInto(remote: string, picked: string, name: string, home: string, deps: CloneDeps = {}): Promise<string> {
  if (remote === "") {
    if (isDir(picked) && !isEmptyDir(picked)) return picked;
    throw new Error(`${tildeOf(home, picked)} doesn't hold its files (it has no Git remote to clone): pick the folder that does`);
  }
  const run = deps.run ?? outputWithin;
  const o = await originOf(picked, run);
  if (o !== null && cloneSame(o, remote)) return picked;
  if (!exists(picked) || isEmptyDir(picked)) {
    await cloneRun(remote, picked, deps);
    return picked;
  }
  return cloneFetch(remote, join(picked, name), deps);
}

/** A project, as the clone logic sees it. */
export interface CloneRepo {
  id: number;
  name: string;
  /** The owner's folder, which is what the mesh calls the project. */
  path: string;
  /** This PC's folder for it: its `local`, else `path`. */
  dir: string;
  remote: string;
}

/** A turn waiting for a project's folder. */
export interface HeldTurn {
  chat: number;
  prompt: string;
  files: string[];
}

/** What a turn about to start without its project's folder does next. */
export type CloneTurnPlan =
  /** Go on (the caller says why, if the turn can't run). */
  | { kind: "skip" }
  /** Another project here has the same remote: its folder becomes this one's, and the turn goes on. */
  | { kind: "use"; repo: number; dir: string }
  /** A clone of the project is running; the turn waits. */
  | { kind: "wait" }
  /** The turn waits for a clone into `want`, started now (`CloneState.begin`). */
  | { kind: "start"; repo: number; want: string };

/** The folder line's facts (`status.folder` for the phone). */
export interface CloneLine {
  text: string;
  cloning: boolean;
  /** The project has a git remote to clone; without one (a plain folder) the action only picks the folder that holds it here. */
  cloneable: boolean;
  /** The PC that has the project: [peer id, its name]. */
  owner: [string, string] | null;
  /** Where Clone here starts (the phone's suggested path). */
  suggested: string;
}

/** The action's label and what it does: Clone here, or the project's folder here. */
export function cloneAction(l: Pick<CloneLine, "cloneable">): [string, string] {
  return l.cloneable
    ? ["Clone here", "The project is cloned into this folder on the PC, or used from it when it's already there."]
    : ["Use a folder here", "The project has no Git remote to clone: give the folder on the PC that holds its files."];
}

export type CloneStep =
  | { do: "notice"; chat: number; text: string }
  | { do: "queue"; chat: number; prompt: string }
  | { do: "start"; chat: number; prompt: string; files: string[] };

export type CloneOutcome =
  | { kind: "ok"; dir: string; /** No project here has this folder: it is untrusted until the user trusts it. */ untrusted: boolean; steps: CloneStep[] }
  | { kind: "failed"; error: string; /** What each waiting chat's transcript gets as an error item. */ errors: { chat: number; text: string }[] };

/** The projects being cloned, the turns waiting for them and why the last clone failed. */
export class CloneState {
  /** Projects being cloned now: id to where. */
  running = new Map<number, string>();
  /** Per project, the turns waiting for its folder. */
  held = new Map<number, HeldTurn[]>();
  /** Per project, why the last clone failed. */
  failed = new Map<number, string>();

  private hold(repo: number, t: HeldTurn): void {
    const l = this.held.get(repo) ?? [];
    l.push(t);
    this.held.set(repo, l);
  }

  /** A chat's turn is about to start without its project's folder (`clone_for_turn`). */
  forTurn(i: { worktreeLost: boolean; repo: CloneRepo | null; chat: number; prompt: string; files: string[]; repos: readonly CloneRepo[]; home: string }): CloneTurnPlan {
    const r = i.repo;
    if (i.worktreeLost || r === null || isDir(r.dir)) return { kind: "skip" };
    const turn = { chat: i.chat, prompt: i.prompt, files: [...i.files] };
    if (r.remote === "") {
      // Nothing to clone (a project without Git): the message waits for the folder line's Use a folder here (or Run on <owner>).
      this.hold(r.id, turn);
      return { kind: "skip" };
    }
    const found = findClone(i.repos.filter((o) => o.id !== r.id).map((o): [string, string] => [o.dir, o.remote]), r.remote);
    if (found !== null) return { kind: "use", repo: r.id, dir: found };
    this.hold(r.id, turn);
    if (this.running.has(r.id)) return { kind: "wait" };
    this.failed.delete(r.id);
    return { kind: "start", repo: r.id, want: homeRelative(r.path, i.home, r.name) };
  }

  /** The folder line's Clone here: checks, and clears the last failure. Error: what to tell the person. */
  cloneHere(i: { chat: { foreign: boolean; repo: CloneRepo | null } | null; picked: string }): { ok: true; repo: CloneRepo } | { ok: false; error: string } {
    if (i.chat === null || i.chat.foreign) return { ok: false, error: "no such chat here" };
    const r = i.chat.repo;
    if (r === null) return { ok: false, error: "this chat has no project" };
    if (isDir(r.dir)) return { ok: false, error: `${r.name} is already on this PC` };
    if (this.running.has(r.id)) return { ok: false, error: `${r.name} is being cloned already` };
    if (!isAbsolute(i.picked)) return { ok: false, error: "give a full path" };
    this.failed.delete(r.id);
    return { ok: true, repo: r };
  }

  /** A clone starts: what the chat is told, and the project counts as running. */
  begin(repo: CloneRepo, at: string, home: string): { text: string; detail: string } {
    this.running.set(repo.id, at);
    const where = tildeOf(home, at);
    return repo.remote === "" ? { text: `Looking for ${repo.name} in ${where}…`, detail: "" } : { text: `Cloning ${repo.name}…`, detail: `${repo.remote} into ${where}` };
  }

  /** A clone's thread is done: the folder is the project's here and its held turns start, or they fail with the reason. */
  finished(i: {
    repo: CloneRepo | null;
    repoId: number;
    result: { ok: true; dir: string } | { ok: false; error: string };
    repos: readonly CloneRepo[];
    home: string;
    turnRunning(chat: number): boolean;
    /** Why a chat's folder is missing, for its transcript. */
    missingFolder(chat: number): string | null;
  }): CloneOutcome {
    this.running.delete(i.repoId);
    const held = this.held.get(i.repoId) ?? [];
    this.held.delete(i.repoId);
    const name = i.repo?.name ?? "";
    if (i.result.ok) {
      const dir = i.result.dir;
      const steps: CloneStep[] = [];
      const said = new Set<number>();
      for (const t of held) {
        if (!said.has(t.chat)) {
          said.add(t.chat);
          steps.push({ do: "notice", chat: t.chat, text: `${name} is at ${tildeOf(i.home, dir)}` });
        }
        if (i.turnRunning(t.chat)) steps.push({ do: "queue", chat: t.chat, prompt: t.prompt });
        else steps.push({ do: "start", chat: t.chat, prompt: t.prompt, files: t.files });
      }
      return { kind: "ok", dir, untrusted: i.repos.every((o) => o.dir !== dir), steps };
    }
    const e = i.result.error;
    this.failed.set(i.repoId, e);
    const failed = i.repo !== null && i.repo.remote === "" ? "That folder can't be used" : "Cloning it here failed";
    // Kept for Clone here / Run on: they still want to run.
    this.held.set(i.repoId, held);
    const errors: { chat: number; text: string }[] = [];
    const said = new Set<number>();
    for (const t of held) {
      if (said.has(t.chat)) continue;
      said.add(t.chat);
      errors.push({ chat: t.chat, text: `${i.missingFolder(t.chat) ?? ""}\n${failed}: ${e}` });
    }
    return { kind: "failed", error: e, errors };
  }

  /** A chat that never ran is gone: nothing waits for it. */
  dropChat(chat: number): void {
    for (const [id, l] of this.held) this.held.set(id, l.filter((x) => x.chat !== chat));
  }

  /** The folder line under a chat whose project isn't on this PC (null: nothing to say). */
  folderLine(i: { chat: { foreign: boolean; device: string } | null; repo: CloneRepo | null; worktreeLost: boolean; owner: [string, string] | null; home: string }): CloneLine | null {
    if (i.chat === null || i.chat.foreign || i.chat.device !== "") return null;
    const r = i.repo;
    if (r === null || isDir(r.dir) || i.worktreeLost) return null;
    const at = this.running.get(r.id);
    const failed = this.failed.get(r.id);
    const cloneableRemote = r.remote !== "";
    const tilde = (p: string) => tildeOf(i.home, p);
    let text: string;
    if (at !== undefined && cloneableRemote) text = `Cloning ${r.name} into ${tilde(at)}…`;
    else if (at !== undefined) text = `Looking for ${r.name} in ${tilde(at)}…`;
    else if (failed !== undefined && cloneableRemote) text = `${r.name} isn't on this PC and couldn't be cloned: ${failed}`;
    else if (failed !== undefined) text = `${r.name} isn't on this PC: ${failed}`;
    else if (i.owner !== null && cloneableRemote) text = `${r.name} isn't on this PC: it's on ${i.owner[1]}.`;
    else if (i.owner !== null) text = `${r.name} isn't on this PC: it's on ${i.owner[1]}, without Git to clone it.`;
    else text = `${r.name}'s folder (${tilde(r.path)}) isn't on this PC.`;
    return { text, cloning: at !== undefined, cloneable: cloneableRemote, owner: i.owner, suggested: homeRelative(r.path, i.home, r.name) };
  }

  /** Run on <owner>: takes the chat's waiting message (else its last one) out of the queue and builds the call that starts a chat in the project on the PC that has it. */
  takeRunOnOwner(i: {
    chat: { foreign: boolean; id: number; account: string; model: string; effort: string; access: string; repo: CloneRepo | null } | null;
    owner: [string, string] | null;
    ownerOnline: boolean;
    items: readonly Item[];
  }): { ok: true; peer: string; peerName: string; text: string; files: string[]; body: { [k: string]: Json } } | { ok: false; error: string } {
    const c = i.chat;
    if (c === null || c.foreign) return { ok: false, error: "no such chat here" };
    const r = c.repo;
    if (r === null) return { ok: false, error: "this chat has no project" };
    if (i.owner === null) return { ok: false, error: "no other PC shares this project" };
    const [peer, peerName] = i.owner;
    if (!i.ownerOnline) return { ok: false, error: `${peerName} is off: try again once it's back` };
    let text: string;
    let files: string[];
    const list = this.held.get(r.id) ?? [];
    const at = list.findIndex((x) => x.chat === c.id);
    if (at >= 0) {
      const [h] = list.splice(at, 1);
      text = h?.prompt ?? "";
      files = h?.files ?? [];
    } else {
      const last = [...i.items].reverse().find((x) => x.kind === "user");
      if (last === undefined || last.kind !== "user") return { ok: false, error: "this chat has no message to send" };
      text = last.text;
      files = last.files.filter(isFile);
    }
    const body = { project: { name: r.name, path: r.path, remote: r.remote }, account: c.account, model: c.model, effort: c.effort, access: c.access, device: "", text };
    return { ok: true, peer, peerName, text, files, body };
  }
}

/** The PC a project belongs to: the home of its chats from other PCs. */
export function cloneProjectOwner(repo: number, chats: readonly { repoId: number | null; foreign: boolean; home: string; homeName: string }[]): [string, string] | null {
  const c = chats.find((x) => x.repoId === repo && x.foreign);
  return c ? [c.home, c.homeName] : null;
}

/** `status.folder` for the phone (PROTOCOL.md). */
export function cloneFolderJson(l: CloneLine | null): Json {
  if (l === null) return null;
  const [action, note] = cloneAction(l);
  return { text: l.text, cloning: l.cloning, owner: l.owner ? { id: l.owner[0], name: l.owner[1] } : null, suggested: l.suggested, action, action_note: note };
}

/** Run on <owner> answered: this chat goes if it never ran (its message went there). */
export function ranOnOwnerDrops(c: { started: boolean; foreign: boolean } | null, turnRunning: boolean): boolean {
  return c !== null && !c.started && !c.foreign && !turnRunning;
}
