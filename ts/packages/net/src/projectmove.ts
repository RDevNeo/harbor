import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Unpacker, plainRel, sizeText } from "./foldercopy.ts";
import { err, ok, type Reply } from "./http.ts";
import type { Kv } from "./kv.ts";
import { normalizeRemote, tildeOf } from "./movepc.ts";
import { outputWithin, type Spawner } from "./proc.ts";
import type { Json } from "./wire.ts";

/**
 * Move to PC… of a whole project, the target PC's side (`/mesh/v1/project/*`): it says where the
 * project would go, takes its folder (a clone of its remote plus what the source has on top, or
 * the whole folder as a stream) into a hidden folder beside the place it goes, and puts it there
 * only once all of it came. Then the chats come one by one with the chat handoff (movepc.ts), and
 * the project's settings last.
 */

/** Said in `hello` (`project_moves`): this Harbor takes whole projects. */
export const PROJECT_MOVES_VERSION = 1;
/** A move nobody spoke to for this long is dropped (its hidden folder removed). */
const IDLE_MS = 20 * 60_000;
const CLONE_TIMEOUT = 30 * 60_000;
const GIT_TIMEOUT = 10 * 60_000;
/** kv: projects that came from another PC, `moved_in:<pc>:<their folder>` -> the folder here. */
export const MOVED_IN = "moved_in:";

export type MoveMode = "copy" | "clone" | "existing";

/** One of this PC's projects, as the target matches them. */
export interface TargetRepo {
  id: number;
  name: string;
  dir: string;
  remote: string;
  /** It moved to another PC: its folder here is left behind, not the project. */
  left: boolean;
}

export interface ProjectTargetApp {
  meName(): string;
  home: string;
  kv: Kv;
  repos(): TargetRepo[];
  /** Adds `dir` as a project named `name` (or finds it); its id. */
  addProject(dir: string, name: string, remote: string): number;
  /** The project's settings from the source: an error to say, or null. */
  settle(repo: number, s: ProjectSettings): string | null;
  /** Where bundles wait. */
  scratch: string;
  run?: Spawner;
  now?: () => number;
  /** "Same files" of a same-named project without a remote: its manifest (projectmoverun.ts `manifest`). */
  manifest(dir: string): string;
  /** The entry the source's folder had here as a project of its chats' copies (by its path there): it goes when it has no chats and isn't `keep`. */
  dropStale?(path: string, keep: string, peer: string): void;
}

export interface ProjectSettings {
  name: string;
  /** The main chat's gid ("" for none). */
  main: string;
  settled: number;
  /** Gids of the chats the project's settle settled. */
  settledChats: string[];
  /** Snoozed until (seconds), 0 for none. */
  snooze: number;
  /** A custom icon, base64, "" for none. */
  icon: string;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function firstLine(e: unknown): string {
  return (
    say(e)
      .split("\n")
      .map((l) => l.replace(/^(fatal|error): /, "").trim())
      .find((l) => l !== "" && !l.startsWith("hint:")) ?? "it failed"
  );
}

/** `git -C dir …`, its output; throws git's first line. */
export async function git(run: Spawner, dir: string, args: string[], timeoutMs = GIT_TIMEOUT, env: Record<string, string> = {}): Promise<string> {
  const out = await run("git", ["-c", "core.fsmonitor=false", "-C", dir, ...args], { timeoutMs, env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env } });
  if (out.code !== 0) throw new Error(firstLine(out.stderr.toString("utf8") || `git ${args[0] ?? ""} failed`));
  return out.stdout.toString("utf8");
}

/** A name for a folder or branch part: letters, digits, `._-`. */
export function slugPart(t: string): string {
  const v = t.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return v === "" ? "pc" : v.slice(0, 40);
}

/** Where a project from the source's `rel` (its place under the source's home) goes here: the same place when it's free, else the first free `<name>-N` beside it. */
export function planDest(home: string, rel: string, taken: (p: string) => boolean): string {
  // Never into a hidden folder of the home (~/.config, ~/.ssh…): then beside the rest, by its name.
  const plain = plainRel(rel) && !rel.split("/").some((p) => p.startsWith("."));
  const clean = plain ? rel : basename(rel).replace(/^\.+/, "") || "project";
  const want = join(home, clean);
  if (!taken(want)) return want;
  const dir = dirname(want);
  const base = basename(want);
  for (let i = 2; i < 1000; i++) {
    const p = join(dir, `${base}-${i}`);
    if (!taken(p)) return p;
  }
  return join(dir, `${base}-${randomBytes(3).toString("hex")}`);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A place is taken when something is there or one of this PC's projects says it's its folder. */
function takenBy(repos: TargetRepo[]): (p: string) => boolean {
  return (p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return repos.some((r) => r.dir === p);
    }
  };
}

function freeBytes(dir: string): number | null {
  for (let d = dir; ; d = dirname(d)) {
    try {
      const st = statfsSync(d);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      if (d === dirname(d)) return null;
    }
  }
}

/** What the source asks first (`project/check`). */
export interface CheckBody {
  name: string;
  folder: string;
  /** Its folder under the source's home ("Documents/acme"); its name when it's elsewhere. */
  rel: string;
  /** Its folder on the source (the key of a retry). */
  path: string;
  remote: string;
  git: boolean;
  /** Without a remote: what its files are (manifest), for "the same project". */
  manifest: string;
  bytes: number;
  from: string;
}

export function parseCheck(b: unknown): CheckBody {
  const o = obj(b);
  return { name: s(o.name), folder: s(o.folder), rel: s(o.rel), path: s(o.path), remote: s(o.remote), git: o.git === true, manifest: s(o.manifest), bytes: n(o.bytes), from: s(o.from) };
}

/** The target's answer: the project here already (then nothing is copied but local work), or where it would go. */
export interface CheckAnswer {
  ok: boolean;
  why: string | null;
  /** This PC has it already: its folder. */
  existing: string | null;
  /** It came here before from the same folder (a retry): nothing is copied again. */
  again: boolean;
  dest: string;
  destLabel: string;
  free: number | null;
}

/** Which of this PC's projects is the source's, or where it would go (`project/check`). */
export function checkProject(app: ProjectTargetApp, peer: string, b: CheckBody): CheckAnswer {
  const me = app.meName();
  const repos = app.repos();
  const label = (p: string) => tildeOf(app.home, p);
  const answer = (x: Partial<CheckAnswer> & { dest: string }): CheckAnswer => ({ ok: true, why: null, existing: null, again: false, destLabel: label(x.dest), free: null, ...x });
  const before = app.kv.get(`${MOVED_IN}${peer}:${b.path}`);
  if (before !== null && before !== "" && isDir(before) && repos.some((r) => r.dir === before && !r.left)) return answer({ existing: before, again: true, dest: before });
  const live = repos.filter((r) => !r.left && isDir(r.dir));
  if (b.remote !== "") {
    const want = normalizeRemote(b.remote);
    const same = live.find((r) => r.remote !== "" && normalizeRemote(r.remote) === want);
    if (same) return answer({ existing: same.dir, dest: same.dir });
  } else if (b.manifest !== "") {
    for (const r of live.filter((x) => x.remote === "" && (x.name === b.name || basename(x.dir) === b.folder))) {
      let m = "";
      try {
        m = app.manifest(r.dir);
      } catch {
        // unreadable: not the same
      }
      if (m === b.manifest) return answer({ existing: r.dir, dest: r.dir });
    }
  }
  const dest = planDest(app.home, b.rel, takenBy(repos));
  const free = freeBytes(dirname(dest));
  if (free !== null && b.bytes > 0 && free < b.bytes + 512e6) {
    return { ...answer({ dest }), ok: false, why: `${me} has ${sizeText(free)} free where it would go, and the project needs ${sizeText(b.bytes)}`, free };
  }
  return answer({ dest, free });
}

type JobState = "working" | "ready" | "done" | "failed";

interface Job {
  id: string;
  peer: string;
  mode: MoveMode;
  /** Where the files are written: the hidden folder, or (`existing`) the project's own. */
  root: string;
  dest: string;
  name: string;
  remote: string;
  path: string;
  state: JobState;
  text: string;
  error: string;
  /** Commits this PC has (the bundle needs only what's beyond them). */
  have: string[];
  /** Source branch -> its name here. */
  branches: Record<string, string>;
  stream: number;
  seq: number;
  unpacker: Unpacker | null;
  bundle: string;
  at: number;
  dir: string;
  repo: number;
}

/** kv: the hidden folders of moves under way, so a restart in the middle removes what they left. */
const KV_OPEN = "project_moves_open";

/** The target's moves, by id. */
export class ProjectReceiver {
  readonly jobs = new Map<string, Job>();

  constructor(readonly app: ProjectTargetApp) {}

  /** At startup: what moves cut short by a stop left (their hidden folders, bundles) goes. */
  load(): void {
    for (const p of this.open()) rmSync(p, { recursive: true, force: true });
    this.app.kv.set(KV_OPEN, "[]");
  }

  private open(): string[] {
    try {
      const v: unknown = JSON.parse(this.app.kv.get(KV_OPEN) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
    } catch {
      return [];
    }
  }

  private remember(j: Job, on: boolean): void {
    const mine = [j.root, j.bundle];
    const rest = this.open().filter((p) => !mine.includes(p));
    this.app.kv.set(KV_OPEN, JSON.stringify(on ? [...rest, ...mine] : rest));
  }

  private run(): Spawner {
    return this.app.run ?? outputWithin;
  }

  private now(): number {
    return (this.app.now ?? Date.now)();
  }

  private prune(): void {
    for (const j of this.jobs.values()) if (this.now() - j.at > IDLE_MS && j.state !== "done") void this.drop(j, "the source stopped sending");
  }

  private async drop(j: Job, why: string): Promise<void> {
    this.jobs.delete(j.id);
    await j.unpacker?.abort();
    rmSync(j.root, { recursive: true, force: true });
    rmSync(j.bundle, { force: true });
    this.remember(j, false);
    j.state = "failed";
    j.error = why;
  }

  private job(peer: string, id: string): Job | null {
    const j = this.jobs.get(id);
    if (!j || j.peer !== peer) return null;
    j.at = this.now();
    return j;
  }

  /** Runs `work` as the job's next step; its outcome is read with `status`. */
  private step(j: Job, text: string, work: () => Promise<void>): void {
    j.state = "working";
    j.text = text;
    void work().then(
      () => {
        if (j.state === "working") j.state = "ready";
      },
      (e: unknown) => {
        j.state = "failed";
        j.error = say(e);
      },
    );
  }

  private status(j: Job): Json {
    return { ok: true, state: j.state, text: j.text, error: j.error === "" ? null : j.error, have: j.have, branches: j.branches, dir: j.dir, dir_label: tildeOf(this.app.home, j.dir === "" ? j.dest : j.dir), seq: j.seq, stream: j.stream };
  }

  /** `POST /mesh/v1/project/*` from PC `peer` (JSON bodies; `piece` reads its own). */
  async route(peer: string, sub: string, body: unknown): Promise<Reply> {
    this.prune();
    const b = obj(body);
    if (sub === "check") return ok(checkProject(this.app, peer, parseCheck(b)) as unknown as Json);
    if (sub === "begin") return this.begin(peer, b);
    if (sub === "settle") return this.settleRoute(peer, b);
    const j = this.job(peer, s(b.move));
    if (j === null) return err(404, "that move isn't known here any more: start it again");
    switch (sub) {
      case "status":
        return ok(this.status(j));
      case "apply":
        return this.apply(j, b);
      case "finish":
        return this.finish(j);
      case "abort":
        await this.drop(j, "stopped");
        return ok({ ok: true });
      default:
        return err(404, "unknown project call");
    }
  }

  private async begin(peer: string, b: Record<string, unknown>): Promise<Reply> {
    const id = s(b.move);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return err(400, "no move id");
    const old = this.jobs.get(id);
    if (old && old.peer === peer) return ok(this.status(old));
    const check = parseCheck(b);
    const plan = checkProject(this.app, peer, check);
    if (!plan.ok) return err(409, plan.why ?? "it can't take it");
    const mode: MoveMode = plan.existing !== null ? "existing" : check.git && check.remote !== "" ? "clone" : "copy";
    const want = s(b.mode);
    if (want !== "" && want !== mode) return err(409, `${this.app.meName()}'s projects changed meanwhile: ask again`);
    const dest = plan.dest;
    // Into an existing project only git's bundle comes: whatever else a stream holds lands in scratch.
    const root = mode === "existing" ? join(this.app.scratch, `move-${id}`) : join(dirname(dest), `.${basename(dest)}.harbor-move-${id.slice(0, 12)}`);
    const j: Job = { id, peer, mode, root, dest, name: check.name, remote: check.remote, path: check.path, state: "ready", text: "", error: "", have: [], branches: {}, stream: 0, seq: 0, unpacker: null, bundle: join(this.app.scratch, `move-${id}.bundle`), at: this.now(), dir: "", repo: 0 };
    if (plan.again) {
      j.state = "done";
      j.dir = dest;
      j.repo = this.app.repos().find((r) => r.dir === dest)?.id ?? 0;
      this.jobs.set(id, j);
      return ok({ ...(this.status(j) as Record<string, Json>), mode, again: true });
    }
    try {
      mkdirSync(this.app.scratch, { recursive: true });
      if (mode !== "existing") mkdirSync(dirname(dest), { recursive: true });
      mkdirSync(root, { mode: 0o700 });
    } catch (e) {
      return err(409, `couldn't make ${tildeOf(this.app.home, dirname(dest))} there: ${say(e)}`);
    }
    this.jobs.set(id, j);
    this.remember(j, true);
    const run = this.run();
    if (mode === "clone") {
      this.step(j, `Cloning ${check.remote}…`, async () => {
        try {
          await run("git", ["clone", "--no-checkout", "--", check.remote, root], { timeoutMs: CLONE_TIMEOUT, env: { GIT_TERMINAL_PROMPT: "0" } }).then((o) => {
            if (o.code !== 0) throw new Error(firstLine(o.stderr.toString("utf8")));
          });
        } catch (e) {
          // Without access to the remote here, the whole history comes from the source.
          rmSync(root, { recursive: true, force: true });
          mkdirSync(root, { mode: 0o700 });
          await git(run, root, ["init", "-q"]);
          j.text = `Couldn't clone ${check.remote} on ${this.app.meName()} (${firstLine(e)}): the history comes from the source`;
        }
        j.have = await this.tips(root);
      });
    } else if (mode === "existing" && isDir(join(dest, ".git"))) {
      this.step(j, "Reading the project here…", async () => {
        j.have = await this.tips(dest);
      });
    }
    return ok({ ...(this.status(j) as Record<string, Json>), mode, again: false });
  }

  /** Every commit a ref of `dir` points at. */
  private async tips(dir: string): Promise<string[]> {
    const out = await git(this.run(), dir, ["for-each-ref", "--format=%(objectname)"]).catch(() => "");
    return [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)))];
  }

  /** A piece of stream `stream` (`POST /mesh/v1/project/piece?move=&stream=&seq=`). */
  async piece(peer: string, move: string, stream: number, seq: number, data: Buffer): Promise<Reply> {
    const j = this.job(peer, move);
    if (j === null) return err(404, "that move isn't known here any more: start it again");
    if (j.state === "failed") return err(409, j.error);
    if (stream !== j.stream) {
      if (stream !== j.stream + 1 || (j.unpacker !== null && j.seq > 0)) return err(409, "the copy came out of order");
      j.stream = stream;
      j.seq = 0;
      j.unpacker = new Unpacker(j.root, j.bundle);
    }
    // A piece sent again (its answer got lost): it's here already.
    if (seq < j.seq) return ok({ ok: true, seq: j.seq });
    if (seq !== j.seq || j.unpacker === null) return err(409, "the copy came out of order");
    try {
      await j.unpacker.push(data);
    } catch (e) {
      const why = say(e);
      await this.drop(j, why);
      return err(409, why);
    }
    j.seq += 1;
    j.text = `Received ${sizeText(j.unpacker.taken)}`;
    return ok({ ok: true, seq: j.seq });
  }

  private async endStream(j: Job): Promise<{ gone: string[]; bundle: string | null }> {
    const u = j.unpacker;
    j.unpacker = null;
    j.seq = 0;
    if (u === null) return { gone: [], bundle: null };
    const out = await u.finish().catch(async (e: unknown) => {
      await u.abort();
      throw e;
    });
    for (const g of out.gone) await u.remove(g);
    return { gone: out.gone, bundle: out.bundle };
  }

  /** The bundle of the stream that just ended, into the project's git: its refs, then (not `existing`) its checkout. */
  private apply(j: Job, b: Record<string, unknown>): Reply {
    if (j.state === "working") return err(409, "still busy: ask its status");
    const refs: [string, string][] = (Array.isArray(b.refs) ? b.refs : []).flatMap((r): [string, string][] => (Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string" && /^refs\/(heads|tags)\/|^refs\/stash$/.test(r[0]) && /^[0-9a-f]{40,64}$/.test(r[1]) ? [[r[0], r[1]]] : []));
    const head = obj(b.head);
    const remotes = (Array.isArray(b.remotes) ? b.remotes : []).flatMap((r): [string, string][] => (Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string" && /^[A-Za-z0-9._-]+$/.test(r[0]) ? [[r[0], r[1]]] : []));
    const upstreams = (Array.isArray(b.upstreams) ? b.upstreams : []).flatMap((r): [string, string, string][] =>
      Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string" && typeof r[2] === "string" ? [[r[0], r[1], r[2]]] : [],
    );
    const prefix = `moved-from-${slugPart(s(b.from))}`;
    const run = this.run();
    this.step(j, "Putting the commits in place…", async () => {
      const { bundle } = await this.endStream(j);
      const dir = j.mode === "existing" ? j.dest : j.root;
      if (bundle !== null) {
        await git(run, dir, ["fetch", "-q", "--no-tags", bundle, "+refs/*:refs/harbor-move/*"]);
        rmSync(bundle, { force: true });
      }
      const has = async (sha: string) => (await run("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { timeoutMs: 30_000 })).code === 0;
      if (j.mode === "existing") {
        // The project here is someone's checkout: nothing in it changes, the work comes as branches.
        for (const [ref, sha] of refs) {
          if (!ref.startsWith("refs/heads/") || !(await has(sha))) continue;
          const name = ref.slice("refs/heads/".length);
          const mine = (await git(run, dir, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).catch(() => "")).trim();
          if (mine === sha) {
            j.branches[name] = name;
            continue;
          }
          const to = `${prefix}/${name}`;
          await git(run, dir, ["update-ref", `refs/heads/${to}`, sha]);
          j.branches[name] = to;
        }
      } else {
        for (const [ref, sha] of refs) if (await has(sha)) await git(run, dir, ["update-ref", ref, sha]);
        for (const [name, url] of remotes) {
          const had = (await git(run, dir, ["remote"]).catch(() => "")).split("\n").includes(name);
          await git(run, dir, ["remote", had ? "set-url" : "add", name, url]);
        }
        for (const [branch, remote, merge] of upstreams) {
          await git(run, dir, ["config", `branch.${branch}.remote`, remote]).catch(() => "");
          await git(run, dir, ["config", `branch.${branch}.merge`, merge]).catch(() => "");
        }
        const branch = s(head.branch);
        const sha = s(head.sha);
        if (branch !== "") await git(run, dir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
        else if (/^[0-9a-f]{40,64}$/.test(sha)) await git(run, dir, ["update-ref", "--no-deref", "HEAD", sha]);
        await git(run, dir, ["reset", "-q", "--hard", "HEAD"]);
        for (const [ref] of refs) if (ref.startsWith("refs/heads/")) j.branches[ref.slice("refs/heads/".length)] = ref.slice("refs/heads/".length);
      }
      const tmp = (await git(run, dir, ["for-each-ref", "--format=%(refname)", "refs/harbor-move/"]).catch(() => "")).split("\n").filter((l) => l !== "");
      for (const r of tmp) await git(run, dir, ["update-ref", "-d", r]).catch(() => "");
    });
    return ok(this.status(j));
  }

  /** The last stream ended: the folder goes in its place and becomes a project here. */
  private finish(j: Job): Reply {
    if (j.state === "working") return err(409, "still busy: ask its status");
    if (j.state === "done") return ok(this.status(j));
    const run = this.run();
    this.step(j, "Putting the folder in place…", async () => {
      await this.endStream(j);
      let dir = j.dest;
      if (j.mode === "existing") rmSync(j.root, { recursive: true, force: true });
      else {
        if (isDir(join(j.root, ".git"))) await git(run, j.root, ["worktree", "prune"]).catch(() => "");
        // Taken meanwhile: the next free name.
        if (takenBy(this.app.repos())(dir)) dir = planDest(dirname(dir), basename(dir), takenBy(this.app.repos()));
        renameSync(j.root, dir);
        try {
          // The hidden folder was private while it filled; the project's own folder is as the source's.
          const mode = statSync(dir).mode & 0o777;
          if (mode === 0o700) await run("chmod", ["755", dir], { timeoutMs: 10_000 });
        } catch {
          // as it is
        }
      }
      j.dir = dir;
      j.repo = this.app.addProject(dir, j.mode === "existing" ? "" : j.name, j.remote);
      this.app.kv.set(`${MOVED_IN}${j.peer}:${j.path}`, dir);
      rmSync(j.bundle, { force: true });
      this.remember(j, false);
      j.state = "done";
      j.text = `In ${tildeOf(this.app.home, dir)}`;
    });
    return ok(this.status(j));
  }

  private settleRoute(peer: string, b: Record<string, unknown>): Reply {
    const dir = s(b.dir);
    const r = this.app.repos().find((x) => x.dir === dir && !x.left);
    if (!r) return err(404, "that project isn't on this PC");
    const fromHere = this.app.kv.get(`${MOVED_IN}${peer}:${s(b.path)}`);
    if (fromHere !== dir) return err(403, "that project didn't come from you");
    const settings: ProjectSettings = {
      name: s(b.name),
      main: s(b.main),
      settled: n(b.settled),
      settledChats: (Array.isArray(b.settled_chats) ? b.settled_chats : []).filter((x): x is string => typeof x === "string"),
      snooze: n(b.snooze),
      icon: s(b.icon),
    };
    const bad = this.app.settle(r.id, settings);
    this.app.dropStale?.(s(b.path), dir, peer);
    return bad === null ? ok({ ok: true }) : err(409, bad);
  }
}

/** A custom icon from the source, as a file to give the icon code (null when there's none or it's too big). */
export function iconFile(scratch: string, b64: string): string | null {
  if (b64 === "" || b64.length > 12 << 20) return null;
  const p = join(scratch, `icon-${randomBytes(6).toString("hex")}`);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(p, Buffer.from(b64, "base64"), { mode: 0o600 });
  return p;
}
