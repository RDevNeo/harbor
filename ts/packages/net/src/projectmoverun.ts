import { paths as osPaths } from "@harbor/os";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { repoDir, type Chat, type Repo, type Store } from "@harbor/store";
import { http as meshHttp, jsonBody } from "./client.ts";
import { type Entry, PIECE_BYTES, pieces, scanFolder, sizeText, streamBytes, type Scan } from "./foldercopy.ts";
import { err, ok, type Reply } from "./http.ts";
import type { Kv } from "./kv.ts";
import type { Mesh } from "./mesh.ts";
import { movePcTargets, tildeOf, type MeshHttp, type MoveTarget } from "./movepc.ts";
import type { MovePc } from "./movepcrun.ts";
import { outputWithin, type Spawner } from "./proc.ts";
import { git, type MoveMode } from "./projectmove.ts";
import { dest, type Peer, type Shared } from "./shared.ts";
import type { Json } from "./wire.ts";

/**
 * Move to PC… of a whole project, the source PC's side: the project's folder goes to the target
 * (projectmove.ts takes it), then each of its chats with the chat handoff (movepcrun.ts), then
 * its settings. The folder here stays on disk; the project is marked as moved
 * (`project_moved:<id>`), so its chats (copies of the target's now) don't run here again.
 */

const KV_MOVED = "project_moved:";
const KV_STATUS = "move_project:";
const PIECE_TRIES = 4;
const PIECE_WAIT = 180_000;
const STEP_WAIT = 40 * 60_000;
const TURN_WAIT = 10 * 60_000;

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Where a moved project went (`project_moved:<id>`). */
export interface MovedProject {
  pc: string;
  name: string;
  /** Its folder there. */
  dir: string;
  /** Its folder here, left on disk. */
  folder: string;
  at: number;
}

/** Project `repo`'s move (`folder`: its folder here, so a mark left by a removed project whose id came back doesn't count). */
export function movedProject(kv: Kv, repo: number, folder?: string): MovedProject | null {
  const t = kv.get(`${KV_MOVED}${repo}`);
  if (t === null || t === "") return null;
  try {
    const v = obj(JSON.parse(t));
    if (folder !== undefined && s(v.folder) !== folder) return null;
    return { pc: s(v.pc), name: s(v.name), dir: s(v.dir), folder: s(v.folder), at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    return null;
  }
}

/** The line a chat of a moved project gets instead of a turn here. */
export function movedProjectText(home: string, repoName: string, m: MovedProject): string {
  return `${repoName} moved to ${m.name} (${tildeOf(home, m.dir)} there): its chats go on there. Its old folder is still on this PC at ${tildeOf(home, m.folder)}; Harbor doesn't use it any more.`;
}

/** "Same files": what a folder holds, without its `.git`, as one hash (paths and sizes). */
export function manifestOf(scan: Scan): string {
  const lines = scan.entries
    .filter((e) => e.rel !== ".git" && !e.rel.startsWith(".git/"))
    .map((e) => (e.kind === "file" ? `f\0${e.rel}\0${e.size}` : e.kind === "link" ? `l\0${e.rel}\0${e.target ?? ""}` : `d\0${e.rel}`))
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** A git checkout's state, as the move needs it (null: not the top of a checkout, it's copied as a plain folder). */
export interface GitInfo {
  /** Its branch ("" when detached). */
  branch: string;
  /** HEAD's commit ("" before the first commit). */
  sha: string;
  remotes: [string, string][];
  /** origin's URL, else the first remote's ("" without one). */
  origin: string;
  /** refs/heads/*, refs/tags/*, refs/stash: [ref, object]. */
  refs: [string, string][];
  /** [branch, remote, merge ref]. */
  upstreams: [string, string, string][];
  /** Files that differ from HEAD (untracked included, ignored not). */
  dirty: number;
}

export async function gitInfo(run: Spawner, dir: string): Promise<GitInfo | null> {
  let top: string;
  try {
    top = (await git(run, dir, ["rev-parse", "--show-toplevel"], 20_000)).trim();
  } catch {
    return null;
  }
  try {
    if (realpathSync(top) !== realpathSync(dir)) return null;
  } catch {
    return null;
  }
  const t = (args: string[]) => git(run, dir, args, 60_000).catch(() => "");
  const branch = (await t(["symbolic-ref", "-q", "--short", "HEAD"])).trim();
  const sha = (await t(["rev-parse", "-q", "--verify", "HEAD^{commit}"])).trim();
  const remotes: [string, string][] = (await t(["config", "--get-regexp", "^remote\\..*\\.url$"]))
    .split("\n")
    .flatMap((l): [string, string][] => {
      const i = l.indexOf(" ");
      const k = i < 0 ? "" : l.slice(0, i);
      return k.startsWith("remote.") && k.endsWith(".url") ? [[k.slice(7, -4), l.slice(i + 1).trim()]] : [];
    });
  const origin = (remotes.find(([n]) => n === "origin") ?? remotes[0])?.[1] ?? "";
  const refs: [string, string][] = (await t(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags", "refs/stash"]))
    .split("\n")
    .flatMap((l): [string, string][] => {
      const [r, o] = l.split("\0");
      return r && o ? [[r, o]] : [];
    });
  const upstreams: [string, string, string][] = (await t(["for-each-ref", "--format=%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)", "refs/heads"]))
    .split("\n")
    .flatMap((l): [string, string, string][] => {
      const [b, r, m] = l.split("\0");
      return b && r && m ? [[b, r, m]] : [];
    });
  const dirty = (await t(["status", "--porcelain", "-z"])).split("\0").filter((l) => l !== "").length;
  return { branch, sha, remotes, origin, refs, upstreams, dirty };
}

/** `git ls-files -z` of the checkout, as places. */
async function lsFiles(run: Spawner, dir: string, args: string[]): Promise<string[]> {
  const out = await git(run, dir, ["-c", "core.quotepath=off", "ls-files", "-z", ...args], 10 * 60_000);
  return out.split("\0").filter((l) => l !== "");
}

export interface ProjectMoveDeps {
  store: Store;
  movepc: MovePc;
  mesh: Shared;
  forward: Mesh["forward"];
  home: string;
  /** Where bundles are made (not /tmp: it can be small). */
  scratch: string;
  running(id: number): boolean;
  /** A custom icon's bytes (null: the website's). */
  icon(repo: number): Buffer | null;
  /** The engine and the windows hear the projects changed. */
  touch(): void;
  run?: Spawner;
  http?: MeshHttp;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Bytes per piece of a stream (tests send small ones). */
  pieceBytes?: number;
}

export type MoveState = "running" | "done" | "partial" | "failed";

/** How a project's move goes, as the desktop and the phone show it. */
export interface ProjectMoveStatus {
  repo: number;
  name: string;
  to: string;
  toName: string;
  state: MoveState;
  /** What it does now ("Copying 340 MB of 1.2 GB"). */
  stage: string;
  /** 0-100 while copying, null otherwise. */
  percent: number | null;
  /** The result in full once it ended. */
  result: string | null;
  moved: string[];
  stayed: { title: string; why: string }[];
  at: number;
}

/** What the confirmation says, and what the run then does. */
export interface ProjectMovePlan {
  title: string;
  text: string;
  ok: string;
  mode: MoveMode;
  dest: string;
  destLabel: string;
  again: boolean;
}

interface Prepared {
  repo: Repo;
  dir: string;
  peer: Peer;
  info: GitInfo | null;
  /** The whole folder (copy), or what differs from HEAD (clone). */
  scan: Scan | null;
  gone: string[];
  manifest: string;
  check: Record<string, Json>;
  answer: Record<string, unknown>;
  mode: MoveMode;
  leads: Chat[];
}

/** "Move to PC…" for projects, on the project's own PC. */
export class ProjectMove {
  private readonly status = new Map<number, ProjectMoveStatus>();
  /** What the window shows while a move runs (its toast). */
  onToast: (text: string) => void = () => {};
  /** A move's state changed (the window and the phones redraw). */
  onChange: (repo: number) => void = () => {};

  constructor(readonly d: ProjectMoveDeps) {}

  private run(): Spawner {
    return this.d.run ?? outputWithin;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  private http(): MeshHttp {
    return this.d.http ?? meshHttp;
  }

  /** At startup: a move that was running when Harbor stopped says so. */
  load(): void {
    for (const r of this.d.store.repos()) {
      const t = this.d.store.get(`${KV_STATUS}${r.id}`);
      if (t === null || t === "") continue;
      try {
        const v = JSON.parse(t) as ProjectMoveStatus;
        if (v.state === "running") {
          v.state = "failed";
          v.result = `Harbor stopped while ${v.name} was moving to ${v.toName}. Nothing is lost: what moved is on ${v.toName}, the rest is still here. Move it again to finish.`;
          v.stage = "Stopped";
          v.percent = null;
          this.d.store.set(`${KV_STATUS}${r.id}`, JSON.stringify(v));
        }
        this.status.set(r.id, v);
      } catch {
        // unreadable: nothing to say
      }
    }
  }

  private repo(id: number): Repo | undefined {
    return this.d.store.repos().find((r) => r.id === id);
  }

  /** This PC's own chats of the project that move (leads; their sub-agents go with them). */
  private leads(repo: number): Chat[] {
    return this.d.store
      .chats()
      .filter((c) => c.repoId === repo && c.home === "" && c.role !== "sub")
      .sort((a, b) => a.id - b.id);
  }

  /** Sub-agents of the project whose lead is in another project: they stay with their lead. */
  private strays(repo: number): Chat[] {
    const all = this.d.store.chats();
    return all.filter((c) => c.repoId === repo && c.home === "" && c.role === "sub" && all.find((l) => l.id === c.parent)?.repoId !== repo);
  }

  /** The PC whose project this is, when it isn't this one's: [peer id, a way to name the project there]. */
  ownerOf(repo: number): { pc: string; name: string; body: Record<string, Json> } | null {
    const r = this.repo(repo);
    const m = r ? movedProject(this.d.store, repo, repoDir(r)) : null;
    if (m !== null) return { pc: m.pc, name: m.name, body: { project: m.dir } };
    const chats = this.d.store.chats().filter((c) => c.repoId === repo);
    if (chats.some((c) => c.home === "")) return null;
    const copy = chats.find((c) => c.home !== "");
    if (!copy) return null;
    return { pc: copy.home, name: this.d.mesh.nameOf(copy.home), body: { chat: copy.homeId } };
  }

  /** Why project `repo` can't move to any PC now (null: it may; each PC says the rest). */
  blocker(repo: number): string | null {
    const r = this.repo(repo);
    if (!r) return "that project isn't on this PC any more";
    if (!this.d.mesh.on) return "this PC doesn't share chats with other PCs (Settings › Workspace)";
    const moving = this.d.movepc.local.projects.get(repo);
    if (moving) return `it's moving to ${moving[1]}`;
    if (!isDir(repoDir(r))) return `its folder (${tildeOf(this.d.home, repoDir(r))}) isn't on this PC`;
    for (const c of this.leads(repo)) {
      const why = this.d.movepc.blocker(c.id, true);
      if (why !== null) return `“${title(c)}” can't move: ${why}`;
    }
    return null;
  }

  /** The PCs it could move to, each with why not (if so). */
  targets(repo: number): { why: string | null; targets: MoveTarget[] } {
    const why = this.blocker(repo);
    const mesh = this.d.mesh;
    const hosts = [...mesh.peers.values()].sort((a, b) => Number(b.online) - Number(a.online) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const list = movePcTargets({ blocker: why, meId: mesh.me.id, hosts, allowedFp: (fp) => mesh.usableFp(fp) !== null, downOf: (id) => mesh.down.get(id) ?? null });
    const targets = list.map((t) => {
      const p = mesh.peer(t.id);
      if (t.why === null && p && !p.projectMoves) return { ...t, why: "it runs an older Harbor that can't take projects: update it first" };
      return t;
    });
    return { why, targets };
  }

  private peerFor(repo: number, pc: string): Peer {
    const { why, targets } = this.targets(repo);
    if (why !== null) throw new Error(why);
    const t = targets.find((x) => x.id === pc);
    if (!t) throw new Error("that PC isn't one of this PC's");
    if (t.why !== null) throw new Error(`${t.name} can't take it: ${t.why}`);
    const p = this.d.mesh.peer(pc);
    if (!p) throw new Error("that PC isn't one of this PC's");
    return p;
  }

  private async call(peer: Peer, sub: string, body: Record<string, Json>, wait = 30_000): Promise<Record<string, unknown>> {
    let status: number;
    let v: unknown;
    try {
      [status, v] = await this.http()(dest(peer), "POST", `/mesh/v1/project/${sub}`, jsonBody(body), wait);
    } catch (e) {
      throw new Error(`${peer.name} didn't answer (${say(e)})`);
    }
    const o = obj(v);
    if (status === 404 && sub === "check") throw new Error(`${peer.name} runs an older Harbor that can't take projects: update it first`);
    if (status !== 200) throw new Error(s(o.error) || s(o.why) || `${peer.name} answered ${status}`);
    return o;
  }

  /** Reads the project and asks the target: what would happen. */
  private async prepare(repo: number, pc: string): Promise<Prepared> {
    const r = this.repo(repo);
    if (!r) throw new Error("that project isn't on this PC any more");
    const peer = this.peerFor(repo, pc);
    const dir = repoDir(r);
    const run = this.run();
    const info = await gitInfo(run, dir);
    const remote = info?.origin ?? "";
    const clone = info !== null && info.sha !== "" && remote !== "";
    let scan: Scan | null = null;
    let gone: string[] = [];
    let manifest = "";
    if (clone) {
      const others = await lsFiles(run, dir, ["--others"]);
      const modified = await lsFiles(run, dir, ["--modified"]);
      gone = await lsFiles(run, dir, ["--deleted"]);
      scan = scanFolder(dir, [...others, ...modified]);
    } else {
      scan = scanFolder(dir);
      manifest = manifestOf(scan);
    }
    if (scan.skipped.length > 0 && scan.skipped.includes(".")) throw new Error(`${tildeOf(this.d.home, dir)} can't be read`);
    // Worktrees of its chats come as their branches: they must be committed.
    const leads = this.leads(repo);
    for (const c of leads) {
      for (const x of [c, ...this.d.store.chats().filter((y) => y.role === "sub" && y.parent === c.id)]) {
        const wt = this.d.store.get(`worktree:${x.id}`) ?? "";
        if (wt === "" || !isDir(wt)) continue;
        const h = await gitInfo(run, wt).catch(() => null);
        if (h === null) continue;
        if (h.dirty > 0) throw new Error(`“${title(x)}”'s worktree (${tildeOf(this.d.home, wt)}) has ${plural(h.dirty, "uncommitted change")}: commit them first`);
        if (h.branch === "") throw new Error(`“${title(x)}”'s worktree is on a detached commit: put it on a branch first`);
      }
    }
    // "/" between its parts whatever this PC writes: the other PC reads it.
    const inHome = osPaths.under(dir, this.d.home);
    const rel = inHome ? inHome.replaceAll("\\", "/") : basename(dir);
    const check: Record<string, Json> = { name: r.name, folder: basename(dir), rel, path: dir, remote, git: clone, manifest, bytes: scan.bytes, from: this.d.mesh.me.name };
    const answer = await this.call(peer, "check", check);
    if (answer.ok !== true) throw new Error(`${peer.name} can't take it: ${s(answer.why) || "it didn't say why"}`);
    const mode: MoveMode = s(answer.existing) !== "" ? "existing" : clone ? "clone" : "copy";
    return { repo: r, dir, peer, info, scan, gone, manifest, check, answer, mode, leads };
  }

  /** The confirmation: where it goes, what's copied (all of it, also .env), what stays. */
  async plan(repo: number, pc: string): Promise<ProjectMovePlan> {
    const p = await this.prepare(repo, pc);
    return this.planOf(p);
  }

  private planOf(p: Prepared): ProjectMovePlan {
    const to = p.peer.name;
    const name = p.repo.name;
    const destDir = s(p.answer.dest);
    const where = s(p.answer.destLabel) || destDir;
    const here = tildeOf(this.d.home, p.dir);
    const scan = p.scan;
    const lines: string[] = [];
    const again = p.answer.again === true;
    if (again) lines.push(`${name}'s folder came to ${to} before (${where}): it isn't copied again. Changes made here since then stay here.`);
    else if (p.mode === "existing") {
      lines.push(`${to} already has ${name} in ${where}: Harbor uses it and doesn't change its files.`);
      if (p.info !== null) {
        const extra = p.info.dirty > 0 ? ` Uncommitted changes here (${plural(p.info.dirty, "file")}) go as a commit on a branch moved-from-${this.d.mesh.me.name}/uncommitted.` : "";
        lines.push(`Commits ${to} doesn't have go there as branches moved-from-${this.d.mesh.me.name}/….${extra} Files Git ignores (like .env) stay here.`);
      }
    } else if (p.mode === "clone") {
      lines.push(`${to} clones ${name} from ${p.info?.origin ?? ""} into ${where}, then gets from this PC what isn't on the remote: the commits and branches only here, and the ${plural(scan?.files ?? 0, "file")} that differ from the last commit (${sizeText(scan?.bytes ?? 0)}), also files Git ignores like .env.`);
    } else {
      lines.push(`Harbor copies the whole folder to ${to}, into ${where}: ${sizeText(scan?.bytes ?? 0)}, ${plural(scan?.files ?? 0, "file")}, everything in it, also hidden files like .env${isDir(join(p.dir, ".git")) ? " and its Git history" : ""}.`);
    }
    if (!again && p.mode !== "existing") lines.push(`Anyone who uses ${to} can read what's copied.`);
    const chats = p.leads.length;
    lines.push(
      chats === 0
        ? "It has no chats of this PC's."
        : `${chats === 1 ? "Its chat (with its sub-agents) moves" : `Its ${plural(chats, "chat")} (with their sub-agents) move`} with it and ${chats === 1 ? "goes" : "go"} on there; while it moves, what you send ${chats === 1 ? "it follows it" : "them follows them"}.`,
    );
    lines.push(`The folder stays on this PC at ${here}: delete it yourself once ${to} has everything.`);
    const skipped = scan?.skipped ?? [];
    if (skipped.length > 0) lines.push(`Not copied (sockets, pipes or unreadable): ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""}.`);
    return { title: `Move ${name} to ${to}?`, text: lines.join("\n\n"), ok: "Move", mode: p.mode, dest: destDir, destLabel: where, again };
  }

  /** The move's state (null when none ran). */
  statusOf(repo: number): ProjectMoveStatus | null {
    return this.status.get(repo) ?? null;
  }

  private set(st: ProjectMoveStatus, save = true): void {
    st.at = this.now();
    this.status.set(st.repo, st);
    if (save) this.d.store.set(`${KV_STATUS}${st.repo}`, JSON.stringify(st));
    this.onChange(st.repo);
  }

  /** Starts moving project `repo` to PC `pc`: resolves with the PC's name; the rest is `statusOf`. */
  async start(repo: number, pc: string): Promise<string> {
    const p = await this.prepare(repo, pc);
    // Nothing awaited from here to the moment the move is recorded.
    if (this.d.movepc.local.projects.has(repo)) throw new Error(`it's moving to ${this.d.movepc.local.projects.get(repo)?.[1] ?? "another PC"}`);
    this.d.movepc.local.projects.set(repo, [p.peer.id, p.peer.name]);
    const st: ProjectMoveStatus = { repo, name: p.repo.name, to: p.peer.id, toName: p.peer.name, state: "running", stage: "Starting…", percent: null, result: null, moved: [], stayed: [], at: this.now() };
    this.set(st);
    for (const c of p.leads) this.d.movepc.d.engine.changed(c.id);
    void this.runMove(p, st).catch((e: unknown) => this.end(p, st, "failed", `Couldn't move ${p.repo.name} to ${p.peer.name}: ${say(e)}`));
    return p.peer.name;
  }

  private stage(st: ProjectMoveStatus, stage: string, percent: number | null = null): void {
    const save = stage !== st.stage && percent === null;
    st.stage = stage;
    st.percent = percent;
    this.set(st, save);
  }

  /** Polls the target's step until it's ready (or done). */
  private async waitStep(peer: Peer, move: string, st: ProjectMoveStatus, base: string): Promise<Record<string, unknown>> {
    const until = this.now() + STEP_WAIT;
    let lost = 0;
    for (;;) {
      let v: Record<string, unknown>;
      try {
        v = await this.call(peer, "status", { move });
        lost = 0;
      } catch (e) {
        // A slow link loses an answer now and then; a gone move says so.
        if (/isn't known here/.test(say(e)) || ++lost > 6) throw e;
        await this.sleep(5000);
        continue;
      }
      const state = s(v.state);
      if (state === "failed") throw new Error(s(v.error) || "it failed there");
      if (state === "ready" || state === "done") return v;
      const t = s(v.text);
      this.stage(st, t === "" ? base : `${base}: ${t}`);
      if (this.now() > until) throw new Error(`${peer.name} took too long`);
      await this.sleep(1000);
    }
  }

  /** Sends `entries` as stream `stream`, piece by piece, each tried again on a slow or lost link. */
  private async send(peer: Peer, move: string, stream: number, entries: Entry[], st: ProjectMoveStatus, label: string): Promise<void> {
    const total = Math.max(1, streamBytes(entries));
    let sent = 0;
    let seq = 0;
    let shown = 0;
    for await (const piece of pieces(entries, this.d.pieceBytes ?? PIECE_BYTES)) {
      let last = "";
      let done = false;
      for (let t = 0; t < PIECE_TRIES && !done; t++) {
        if (t > 0) await this.sleep([0, 3000, 10_000, 30_000][t] ?? 30_000);
        try {
          const [status, v] = await this.http()(dest(peer), "POST", `/mesh/v1/project/piece?move=${move}&stream=${stream}&seq=${seq}`, { ctype: "application/octet-stream", data: piece }, PIECE_WAIT);
          if (status === 200) done = true;
          else {
            const why = s(obj(v).error) || `${peer.name} answered ${status}`;
            if (status === 404 || status === 409) throw new Error(why);
            last = why;
          }
        } catch (e) {
          // What the target said about the copy itself ends it; a lost connection is tried again.
          if (/out of order|isn't known|refused a file|refused to write|garbled|cut short|outside the folder/.test(say(e))) throw e;
          last = say(e);
        }
      }
      if (!done) throw new Error(`the link to ${peer.name} broke after ${sizeText(sent)} of ${sizeText(total)} (${last}): try again when it's steadier`);
      sent += piece.length;
      seq += 1;
      if (this.now() - shown > 1000 || sent >= total) {
        shown = this.now();
        this.stage(st, `${label} ${sizeText(sent)} of ${sizeText(total)}`, Math.min(100, Math.floor((sent * 100) / total)));
      }
    }
  }

  /** Git's bundle of `refs` without what the target has; null when it has all of it. */
  private async bundle(dir: string, refs: string[], have: string[], name: string): Promise<string | null> {
    const run = this.run();
    const known: string[] = [];
    for (const h of have) if ((await run("git", ["-C", dir, "cat-file", "-e", `${h}^{commit}`], { timeoutMs: 20_000 })).code === 0) known.push(h);
    mkdirSync(this.d.scratch, { recursive: true });
    const file = join(this.d.scratch, `${name}.bundle`);
    rmSync(file, { force: true });
    const input = Buffer.from([...refs, ...known.map((h) => `^${h}`)].join("\n") + "\n");
    const out = await run("git", ["-C", dir, "bundle", "create", "-q", file, "--stdin"], { timeoutMs: 30 * 60_000, input });
    if (out.code !== 0) {
      const e = out.stderr.toString("utf8");
      if (/empty bundle/i.test(e)) return null;
      throw new Error(`couldn't bundle the commits: ${e.split("\n").find((l) => l.trim() !== "") ?? "git failed"}`);
    }
    return file;
  }

  private async runMove(p: Prepared, st: ProjectMoveStatus): Promise<void> {
    const { peer, info, mode } = p;
    const move = randomBytes(9).toString("base64url");
    const run = this.run();
    let dir: string;
    let where = "";
    let branches: Record<string, string> = {};
    const notes: string[] = [];
    // 1. The folder.
    this.stage(st, `Asking ${peer.name}…`);
    const begun = await this.call(peer, "begin", { ...p.check, move, mode }, 60_000);
    const cleanup: string[] = [];
    try {
      if (begun.again === true) {
        dir = s(begun.dir);
        where = s(begun.dir_label);
      }
      else {
        let stream = 0;
        if (mode === "clone" || (mode === "existing" && info !== null)) {
          const ready = await this.waitStep(peer, move, st, mode === "clone" ? `${peer.name} clones ${p.repo.name}` : `${peer.name} reads its copy`);
          const have = Array.isArray(ready.have) ? ready.have.filter((x): x is string => typeof x === "string") : [];
          if (mode === "clone" && s(ready.text).startsWith("Couldn't clone")) notes.push(s(ready.text));
          let refs = info?.refs ?? [];
          const revs = ["HEAD", ...refs.map(([r]) => r)];
          let tmpRef: string | null = null;
          if (mode === "existing" && info !== null && info.sha !== "") {
            const haveSet = new Set(have);
            const wtBranches = this.worktreeBranches(p.leads);
            refs = refs.filter(([r, o]) => r.startsWith("refs/heads/") && (!haveSet.has(o) || wtBranches.has(r.slice(11))));
            revs.length = 0;
            revs.push(...refs.map(([r]) => r));
            if (info.dirty > 0) {
              const sha = await this.uncommitted(p.dir);
              tmpRef = `refs/harbor-move/${move}`;
              await git(run, p.dir, ["update-ref", tmpRef, sha]);
              revs.push(tmpRef);
              refs = [...refs, ["refs/heads/uncommitted", sha]];
            }
          }
          if (revs.length > 0 && info !== null && info.sha !== "") {
            this.stage(st, "Bundling the commits…");
            const file = await this.bundle(p.dir, revs, have, move).finally(() => {
              if (tmpRef !== null) void git(run, p.dir, ["update-ref", "-d", tmpRef]).catch(() => "");
            });
            if (file !== null) {
              cleanup.push(file);
              stream += 1;
              await this.send(peer, move, stream, [{ rel: "bundle", kind: "bundle", mode: 0o600, size: statSync(file).size, mtime: 0, src: file }], st, "Sending the commits:");
            }
          }
          await this.call(peer, "apply", {
            move,
            refs: refs.map(([r, o]) => [r, o]),
            head: { branch: info?.branch ?? "", sha: info?.sha ?? "" },
            remotes: (info?.remotes ?? []).map(([n, u]) => [n, u]),
            upstreams: (info?.upstreams ?? []).map(([b, r, m]) => [b, r, m]),
            from: this.d.mesh.me.name,
          });
          const after = await this.waitStep(peer, move, st, "Putting the commits in place");
          branches = Object.fromEntries(Object.entries(obj(after.branches)).filter((e): e is [string, string] => typeof e[1] === "string"));
        }
        if (mode !== "existing" && p.scan !== null) {
          const entries: Entry[] = [...p.scan.entries, ...p.gone.map((rel): Entry => ({ rel, kind: "gone", mode: 0, size: 0, mtime: 0 }))];
          stream += 1;
          await this.send(peer, move, stream, entries, st, mode === "clone" ? "Copying the files that differ:" : "Copying");
        }
        await this.call(peer, "finish", { move });
        const done = await this.waitStep(peer, move, st, "Putting the folder in place");
        dir = s(done.dir);
        where = s(done.dir_label);
        if (dir === "") throw new Error(`${peer.name} didn't say where it put it`);
      }
    } catch (e) {
      await this.call(peer, "abort", { move }).catch(() => undefined);
      throw new Error(`${say(e)}. Nothing moved: the project and its chats are still here.`);
    } finally {
      for (const f of cleanup) rmSync(f, { force: true });
    }
    if (where === "") where = dir;
    if (mode === "existing" && Object.values(branches).some((b) => b.startsWith("moved-from-"))) {
      notes.push(`Work from here is on ${peer.name} as branches: ${Object.values(branches).filter((b) => b.startsWith("moved-from-")).join(", ")}.`);
    }
    // 2. The chats, one lead (and its sub-agents) at a time.
    const leads = this.leads(p.repo.id);
    const total = leads.length;
    let i = 0;
    for (const c of leads) {
      i += 1;
      this.stage(st, `Moving chats: ${i} of ${total}`, Math.floor(((i - 1) * 100) / Math.max(1, total)));
      // A turn that started meanwhile ends first.
      const until = this.now() + TURN_WAIT;
      while (this.busy(c) && this.now() < until) await this.sleep(2000);
      const o = await this.d.movepc.handoffForProject(c.id, peer.id, dir, branches);
      if (o.kind === "done") st.moved.push(title(c));
      else st.stayed.push({ title: title(c), why: o.kind === "unknown" ? `no answer yet from ${peer.name} (${o.why}); it waits for it` : o.why });
    }
    for (const c of this.strays(p.repo.id)) st.stayed.push({ title: title(c), why: "it's a sub-agent of a chat in another project: it moves with its lead" });
    // 3. The project's settings.
    this.stage(st, "Settings…");
    const settled = this.d.store.settledProjects().get(p.repo.id) ?? 0;
    let settledChats: string[] = [];
    try {
      const v: unknown = JSON.parse(this.d.store.get(`project_settled:${p.repo.id}`) || "[]");
      settledChats = (Array.isArray(v) ? v : []).flatMap((id) => {
        const c = this.d.store.chat(Number(id));
        return c ? [c.gid] : [];
      });
    } catch {
      // none
    }
    const mainId = this.d.store.mainChats().get(p.repo.id);
    const main = mainId === undefined ? "" : (this.d.store.chat(mainId)?.gid ?? "");
    let snooze = 0;
    try {
      const v = obj(JSON.parse(this.d.store.get("snoozed") ?? "{}"))[`r${p.repo.id}`];
      if (typeof v === "number" && v * 1000 > this.now()) snooze = v;
    } catch {
      // none
    }
    const icon = this.d.icon(p.repo.id);
    // A project the target had already keeps its own name and icon.
    const own = mode !== "existing";
    await this.call(peer, "settle", { dir, path: p.dir, name: own ? p.repo.name : "", main, settled, settled_chats: settledChats, snooze, icon: own && icon !== null && icon.length <= 8 << 20 ? icon.toString("base64") : "" }).catch((e: unknown) => {
      notes.push(`Its settings (icon, main chat, settled, snooze) didn't follow: ${say(e)}.`);
    });
    // 4. Here: the project is the target's now, its folder left on disk.
    const left = this.leads(p.repo.id).length + this.strays(p.repo.id).length;
    const all = left === 0;
    if (all) {
      const m: MovedProject = { pc: peer.id, name: peer.name, dir, folder: p.dir, at: Math.floor(this.now() / 1000) };
      this.d.store.set(`${KV_MOVED}${p.repo.id}`, JSON.stringify(m));
    }
    const parts = [`${p.repo.name} is on ${peer.name} now, in ${where}.`];
    if (st.moved.length > 0) parts.push(`Moved: ${st.moved.map((t) => `“${t}”`).join(", ")}.`);
    if (st.stayed.length > 0) parts.push(`Still here: ${st.stayed.map((x) => `“${x.title}” (${x.why})`).join("; ")}. Move the project again to try those once more.`);
    parts.push(...notes);
    parts.push(`Its folder is still on this PC at ${tildeOf(this.d.home, p.dir)}: delete it yourself once ${peer.name} has everything.`);
    this.end(p, st, all ? "done" : "partial", parts.join(" "));
  }

  private end(p: Prepared, st: ProjectMoveStatus, state: MoveState, result: string): void {
    this.d.movepc.local.projects.delete(p.repo.id);
    // What waited and stays here runs here.
    for (const c of this.leads(p.repo.id)) this.d.movepc.resume(c.id);
    st.state = state;
    st.result = result;
    st.percent = null;
    st.stage = state === "done" ? "Moved" : state === "partial" ? "Partly moved" : "Didn't move";
    this.set(st);
    this.d.touch();
    this.onToast(state === "done" ? `Moved ${p.repo.name} to ${p.peer.name}` : state === "partial" ? `${p.repo.name} partly moved to ${p.peer.name}: see the project's menu` : `Couldn't move ${p.repo.name}: see the project's menu`);
  }

  private busy(c: Chat): boolean {
    if (this.d.running(c.id)) return true;
    return this.d.store.chats().some((x) => x.role === "sub" && x.parent === c.id && this.d.running(x.id));
  }

  /** The branches of the project's chats' worktrees. */
  private worktreeBranches(leads: Chat[]): Set<string> {
    const out = new Set<string>();
    for (const c of leads) {
      for (const x of [c, ...this.d.store.chats().filter((y) => y.role === "sub" && y.parent === c.id)]) {
        const wt = this.d.store.get(`worktree:${x.id}`) ?? "";
        if (wt === "") continue;
        const r = Bun.spawnSync(["git", "-C", wt, "symbolic-ref", "-q", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
        const b = r.exitCode === 0 ? r.stdout.toString().trim() : "";
        if (b !== "") out.add(b);
      }
    }
    return out;
  }

  /** The checkout's uncommitted changes (untracked included, ignored not) as a commit on top of HEAD; the checkout itself isn't touched. */
  private async uncommitted(dir: string): Promise<string> {
    const run = this.run();
    mkdirSync(this.d.scratch, { recursive: true });
    const index = join(this.d.scratch, `index-${randomBytes(6).toString("hex")}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git(run, dir, ["read-tree", "HEAD"], 120_000, env);
      await git(run, dir, ["add", "-A"], 10 * 60_000, env);
      const tree = (await git(run, dir, ["write-tree"], 120_000, env)).trim();
      return (await git(run, dir, ["commit-tree", tree, "-p", "HEAD", "-m", `Uncommitted changes from ${this.d.mesh.me.name}, moved by Harbor`], 60_000, { GIT_AUTHOR_NAME: "Harbor", GIT_AUTHOR_EMAIL: "harbor@localhost", GIT_COMMITTER_NAME: "Harbor", GIT_COMMITTER_EMAIL: "harbor@localhost" })).trim();
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** The status as the phone reads it. */
  statusJson(repo: number): Json {
    const st = this.status.get(repo);
    if (!st) return { state: "none" };
    return { state: st.state, name: st.name, to: st.to, to_name: st.toName, stage: st.stage, percent: st.percent, result: st.result, moved: st.moved, stayed: st.stayed.map((x) => ({ title: x.title, why: x.why })), running: st.state === "running" };
  }

  /**
   * `POST /v1/projects/move` (`step`: targets, plan, start, status) for project `repo` of this
   * PC; a project another PC owns (its chats are that PC's, or it moved there) is asked there.
   */
  async api(repo: number, b: Record<string, unknown>, sender: string): Promise<Reply> {
    const step = s(b.step) || "targets";
    // Asked of a PC by name (`ask` of `start`: the PC the move runs on, the project as it names it).
    const pc = s(b.pc);
    if (pc !== "" && pc !== this.d.mesh.me.id) {
      const name = this.d.mesh.nameOf(pc);
      return this.onOwner({ pc, name, body: { project: (b.project ?? null) as Json } }, b, sender);
    }
    const owner = this.ownerOf(repo);
    if (owner !== null) {
      // Another PC's project: it answers. How a move of it went that ran here is this PC's to say.
      const mine = this.status.get(repo);
      if (step === "status" && mine?.state === "running") return ok(this.statusJson(repo));
      const r = await this.onOwner(owner, b, sender);
      if (step === "status" && mine && (r.status !== 200 || s(obj(r.body).state) === "none")) return ok(this.statusJson(repo));
      return r;
    }
    const to = s(b.to);
    try {
      switch (step) {
        case "targets": {
          const t = this.targets(repo);
          return ok({ why: t.why, name: this.repo(repo)?.name ?? "", targets: t.targets.map((x) => ({ id: x.id, name: x.name, why: x.why })) });
        }
        case "plan":
          return ok((await this.plan(repo, to)) as unknown as Json);
        case "start": {
          const name = await this.start(repo, to);
          // How to ask about this move from anywhere, also once the project left this PC's list.
          return { status: 202, body: { ok: true, to: name, ask: { pc: this.d.mesh.me.id, project: this.repo(repo)?.path ?? "" } } };
        }
        case "status":
          return ok(this.statusJson(repo));
        default:
          return err(400, "step: targets, plan, start or status");
      }
    } catch (e) {
      return err(409, say(e));
    }
  }

  private async onOwner(owner: { pc: string; name: string; body: Record<string, Json> }, b: Record<string, unknown>, sender: string): Promise<Reply> {
    const peer = this.d.mesh.peer(owner.pc);
    if (!peer?.online) return err(409, `this project is ${owner.name}'s: ${owner.name} is off, it moves the project`);
    const { project: _p, chat: _c, pc: _pc, ...rest } = b;
    const body = { ...(rest as Record<string, Json>), ...owner.body };
    const r = await this.d.forward(dest(peer), peer.name, "POST", ["v1", "projects", "move"], body, [], [sender, ""], null);
    if (r.status === 404 && ["no such call", "unknown call", "not found"].includes(s(obj(r.body).error))) return err(409, `this project is ${owner.name}'s, and ${owner.name} runs an older Harbor that can't move projects: update it first`);
    return r;
  }

  /** A chat here of a moved project: the line it gets instead of a turn (null when it isn't one). */
  movedLine(c: Chat): string | null {
    if (c.repoId === null || c.home !== "") return null;
    const r = this.repo(c.repoId);
    const m = r ? movedProject(this.d.store, c.repoId, repoDir(r)) : null;
    return m === null || !r ? null : movedProjectText(this.d.home, r.name, m);
  }

  /** The custom icon of a project, read for the move. */
  static iconBytes(path: string): Buffer | null {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }
}

function title(c: Chat): string {
  return c.title.trim() === "" ? "New chat" : c.title.trim();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
