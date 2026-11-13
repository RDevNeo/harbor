// Continue anywhere, the app's side (carry.ts has the portable parts, chatcloud.ts the cloud's).
//
// Out: every PC publishes, for its recent chats between turns, the agent's session file and the work in the chat's
// folder that its remote doesn't have (`carrySource`). In: a PC that takes a chat over from a PC that is off
// (failover.ts `takeHere`) holds the chat's next turn (`ContinueHere.prepare`, the engine's `prepare` hook) while it
// fetches them, finds or clones the project, puts the work in place without losing anything here, writes the session
// where its provider looks for it with every path moved to this PC's folders, and resumes it. When something can't
// come, the chat still goes on, with a new session holding the conversation so far, and the notice says why.
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { platform } from "./packages/os/src/index.ts";
import { type Account, type Engine, movechat, worktree as wt } from "./packages/agents/src/index.ts";
import { sessionKindKey } from "./packages/agents/src/engine.ts";
import {
  type CarryChat,
  type CarryFolder,
  type Carried,
  type ChatCloud,
  cloneable,
  cloneFetch,
  continuedNotice,
  findClone,
  findRollout,
  gitApply,
  gitSnapshot,
  homeRelative,
  packFolder,
  type PathSpace,
  remapSession,
  rolloutPlace,
  sha,
  type Snap,
  type Applied,
  unpackFolder,
  type WorkIndex,
  workLines,
} from "./packages/net/src/index.ts";
import { type Chat, home, newUuid, projectsdir, repoDir, type Store } from "./packages/store/src/index.ts";

/** A Claude chat with no session id yet (a copy that never ran) gets one before its first turn here. */
export function freshSession(store: Store, e: Engine, id: number): void {
  const c = e.chat(id);
  if (!c || c.sessionId !== "" || e.account(c.account)?.kind !== "Claude") return;
  store.saveChat({ ...c, sessionId: newUuid(), started: false });
  e.reload();
}

/** kv: the states a folder's work came from (carry.ts `chain`), newest first, as JSON [[commit, tree], …]. */
export const chainKey = (dir: string): string => `carry_chain:${dir}`;

const CHAIN = 8;
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function parseChain(v: string | null): [string, string][] {
  try {
    const a: unknown = JSON.parse(v ?? "[]");
    return Array.isArray(a) ? a.filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string").slice(0, CHAIN) : [];
  } catch {
    return [];
  }
}

const codexHome = (): string => process.env.CODEX_HOME ?? join(home(), ".codex");
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const tilde = (p: string): string => {
  const h = home();
  return p === h ? "~" : p.startsWith(`${h}/`) || p.startsWith(`${h}\\`) ? `~${p.slice(h.length)}` : p;
};

export interface CarryHost {
  store: Store;
  engine: () => Engine | null;
  accounts: () => readonly Account[];
  /** Where snapshots and bundles are made (Harbor's own scratch folder). */
  scratch: string;
}

/** This PC's space: paths in a session are moved from it. */
function spaceOf(cwd: string): PathSpace {
  return { cwd, home: home(), win: platform() === "win32" };
}

/** The workspace cloud's source of what this PC's chats need to go on elsewhere (chatcloud.ts `CloudSource.carry/snapshot`). */
export function carrySource(h: CarryHost): { carry(): CarryChat[]; snapshot(f: CarryFolder): Promise<Snap | null> } {
  // Codex keeps a session's file by date: found once, remembered.
  const rollouts = new Map<string, string | null>();
  const looking = new Set<string>();
  const rollout = (id: string): string | null => {
    const had = rollouts.get(id);
    if (had !== undefined && (had === null || existsSync(had))) return had;
    if (!looking.has(id)) {
      looking.add(id);
      void findRollout(codexHome(), id)
        .then((p) => rollouts.set(id, p))
        .finally(() => looking.delete(id));
    }
    return null;
  };
  return {
    carry: () => {
      const e = h.engine();
      if (!e) return [];
      const out: CarryChat[] = [];
      for (const c of e.chats) {
        if (c.home !== "" || c.retired || c.role === "sub" || c.device !== "" || !c.started || c.sessionId === "") continue;
        const kind = e.sessionKind(c);
        if (kind !== "Claude" && kind !== "Codex") continue;
        const account = e.account(c.account);
        const cwd = e.chatCwd(c);
        let file: string | null = null;
        if (kind === "Claude") {
          const at = join(movechat.sessionDir(account?.kind === "Claude" ? account.configDir : null, cwd), `${c.sessionId}.jsonl`);
          file = existsSync(at) ? at : (movechat.sessionCopies(account?.kind === "Claude" ? account.configDir : null, c.sessionId)[0] ?? null);
        } else file = rollout(c.sessionId);
        const r = e.repo(c.repoId);
        const folder: CarryFolder | null = r && isDir(cwd) ? { dir: cwd, name: r.name, git: existsSync(join(cwd, ".git")), worktree: e.worktreeOf(c) !== null } : null;
        out.push({ hid: c.id, gid: c.gid, updated: c.updated * 1000, running: e.running(c.id), kind, session: file === null ? null : { id: c.sessionId, file }, space: spaceOf(cwd), folder });
      }
      return out;
    },
    snapshot: async (f) => {
      const chain = parseChain(h.store.get(chainKey(f.dir)));
      if (f.git) return gitSnapshot(f.dir, { scratch: h.scratch, name: f.name, worktree: f.worktree, chain });
      const p = await packFolder(f.dir);
      const base: WorkIndex = { kind: "files", name: f.name, remote: "", branch: "", head: "", tree: "", work: "", commits: 0, dirty: false, worktree: false, chain, size: 0, sha: "", parts: [], why: p.why };
      if (p.bytes === null) return { index: base, bytes: null };
      const s = sha(p.bytes);
      return { index: { ...base, tree: s, size: p.bytes.length, sha: s }, bytes: p.bytes };
    },
  };
}

export interface ContinueHost extends CarryHost {
  cloud: () => ChatCloud;
  /** This PC's name (notices). */
  here: () => string;
  touch: (chat: number | null) => void;
  log?: ((line: string) => void) | undefined;
}

interface Pending {
  from: string;
  hid: number;
  off: string;
  /** Run anywhere (the chat came to the PC it was typed on): no notice unless something didn't come. */
  quiet?: boolean;
}

/**
 * What a chat that came to the PC it was typed on says (run anywhere): nothing when its session and work came whole;
 * else what didn't, with no PC named as the chat's.
 */
export function quietNotice(resumed: string, work: readonly string[]): { text: string; detail: string } | null {
  const odd = work.filter((l) => !/ came from /.test(l) && !/^Cloned the project/.test(l));
  if (resumed === "resumed" && odd.length === 0) return null;
  const text = resumed === "resumed" ? (odd[0] ?? "") : resumed === "new" ? "A new session with the conversation so far" : `A new session with the conversation so far (${resumed})`;
  return { text, detail: (resumed === "resumed" ? odd.slice(1) : odd).join("\n") };
}

/** Taking a chat over with its session and work (failover.ts calls `begin`; the engine's `prepare` hook, `prepare`). */
export class ContinueHere {
  /** Chats taken over whose next turn brings their session and work. */
  private readonly pending = new Map<number, Pending>();
  /** Chats being prepared now, with the turns that wait for it. */
  private readonly busy = new Map<number, { prompt: string; files: string[] }[]>();

  constructor(private readonly h: ContinueHost) {}

  /** What the cloud carries of chat `hid` of PC `pc` (failover's pick and account). */
  of(pc: string, hid: number): { kind: "Claude" | "Codex"; files: boolean } | null {
    const c = this.h.cloud().carryOf(pc, hid);
    if (c === null) return null;
    return { kind: c.index.kind, files: c.index.work?.kind === "files" && c.index.work.why === "" };
  }

  begin(chat: number, from: string, hid: number, off: string, quiet = false): boolean {
    if (this.h.cloud().carryOf(from, hid) === null) return false;
    this.pending.set(chat, { from, hid, off, quiet });
    return true;
  }

  /** Taken over, its session and work not fetched yet (its next turn brings them). */
  waiting(chat: number): boolean {
    return this.pending.has(chat);
  }

  /** Being prepared (its turns and queue wait). */
  preparing(chat: number): boolean {
    return this.busy.has(chat);
  }

  /** The engine's hook: true when this turn waits for the chat's session and work. */
  prepare(chat: number, prompt: string, files: readonly string[]): boolean {
    const waiting = this.busy.get(chat);
    if (waiting) {
      waiting.push({ prompt, files: [...files] });
      return true;
    }
    const p = this.pending.get(chat);
    if (!p) return false;
    this.pending.delete(chat);
    this.busy.set(chat, [{ prompt, files: [...files] }]);
    void this.run(chat, p).catch((e) => this.h.log?.(`continue: ${say(e)}`));
    return true;
  }

  private async run(id: number, p: Pending): Promise<void> {
    let resumed: "resumed" | string = "new";
    let work: string[] = [];
    try {
      const got = await this.h
        .cloud()
        .fetchCarry(p.from, p.hid)
        .catch((e): null => {
          resumed = say(e);
          return null;
        });
      if (got !== null) {
        work = await this.folder(id, got, p.off);
        resumed = await this.session(id, got);
      }
    } catch (e) {
      resumed = say(e);
    } finally {
      this.finish(id, p, resumed, work);
    }
  }

  /** The turns that waited start: on the carried session, or a new one with the conversation so far. */
  private finish(id: number, p: Pending, resumed: string, work: string[]): void {
    const waiting = this.busy.get(id) ?? [];
    this.busy.delete(id);
    const e = this.h.engine();
    if (!e) return;
    const n = continuedNotice(this.h.here(), p.off, { session: resumed === "resumed" ? "resumed" : resumed === "new" ? "new" : resumed, work });
    let pre = "";
    const c = e.chat(id);
    const kind = c ? (e.account(c.account)?.kind ?? "Claude") : "Claude";
    if (p.quiet === true) {
      // Run anywhere: the chat simply goes on here. Said only when its session or some of its work didn't come.
      const q = quietNotice(resumed, work);
      if (resumed === "resumed") {
        if (q !== null) e.notice(id, "info", q.text, q.detail);
      } else if (c && e.handOver(id, `${kind} on ${p.off}`, q === null ? null : { icon: "restart", ...q })) pre = e.takeForkPreamble(id);
      else if (q !== null) e.notice(id, "info", q.text, q.detail);
    } else if (resumed === "resumed") e.notice(id, "monitor", n.text, n.detail);
    else if (c && e.handOver(id, `${kind} on ${p.off}`, { icon: "monitor", ...n })) pre = e.takeForkPreamble(id);
    else e.notice(id, "monitor", n.text, n.detail);
    freshSession(this.h.store, e, id);
    this.h.touch(id);
    const [first, ...rest] = waiting;
    if (first === undefined) return;
    e.startTurn(id, pre + first.prompt, first.files);
    for (const r of rest) e.pushPending(id, [r.prompt, ...r.files.map((f) => `(attached: ${f})`)].join("\n"));
  }

  /**
   * The project's folder here with the carried work in it: this PC's checkout of it (found by its remote), else a
   * clone into the Projects folder, else (no Git) the carried files; then the work, without losing any here.
   * Returns the notice's lines about it.
   */
  private async folder(id: number, got: Carried, off: string): Promise<string[]> {
    const e = this.h.engine();
    const c = e?.chat(id);
    const w = got.index.work;
    if (!e || !c || c.repoId === null || w === null) return [];
    const r = e.repo(c.repoId);
    if (!r) return [];
    let cloned = "";
    let base: string | null = isDir(repoDir(r)) ? repoDir(r) : null;
    const setLocal = (dir: string) => {
      this.h.store.setRepoLocal(r.id, r.path === dir ? null : dir);
      e.reload();
    };
    const remote = r.remote !== "" ? r.remote : w.remote;
    if (base === null && remote !== "") {
      const found = findClone(
        e.repos.filter((o) => o.id !== r.id).map((o): [string, string] => [repoDir(o), o.remote]),
        remote,
      );
      if (found !== null) {
        base = found;
        setLocal(found);
      }
    }
    const want = (): string => {
      const chosen = projectsdir.chosen(this.h.store, home());
      return chosen !== null ? join(chosen, r.name) : homeRelative(r.path, home(), r.name);
    };
    try {
      if (base === null && w.kind === "git" && cloneable(remote)) {
        e.notice(id, "folder", `Cloning ${r.name}…`, remote);
        this.h.touch(id);
        base = await cloneFetch(remote, want());
        cloned = tilde(base);
        setLocal(base);
      }
      if (w.kind === "files") return [...(await this.files(id, base, want, setLocal, got, w, off))];
      if (base === null) return [`${r.name} isn't on this PC and has no Git remote to clone.`];
      if (w.why !== "") return workLines(w, null, off, "", cloned);
      // The chat's own folder here: its worktree when it ran here before (this PC handed it on), else the project's.
      const own = e.worktreeOf(c);
      const target = own !== null && isDir(own) ? own : base;
      const othersIn = (dir: string) => e.chats.some((x) => x.id !== id && e.running(x.id) && e.chatCwd(x) === dir);
      const made = (head: string) => this.worktreeFor(base as string, c, head);
      // A chat that ran in its own worktree gets one here too, unless it has one here already.
      const inPlace = !othersIn(target) && !(w.worktree && target === base);
      const a: Applied = await gitApply(target, w, got.work, { scratch: this.h.scratch, inPlace, worktree: made });
      if (a.how === "worktree" || (w.worktree && a.dir !== base)) this.h.store.set(`worktree:${id}`, a.dir);
      this.h.store.set(chainKey(a.dir), JSON.stringify([[w.head, w.tree], ...w.chain].slice(0, CHAIN)));
      e.reload();
      return workLines(w, w.worktree && a.how === "worktree" ? { ...a, how: "moved" } : a, off, "", cloned);
    } catch (x) {
      return workLines(w, null, off, say(x), cloned);
    }
  }

  /** A folder without Git: unpacked where the project goes, or (another state of it is here) beside it. */
  private async files(id: number, base: string | null, want: () => string, setLocal: (d: string) => void, got: Carried, w: WorkIndex, off: string): Promise<string[]> {
    if (got.work === null) return workLines(w, null, off, w.why === "" ? "it isn't in the cloud" : "", "");
    if (base === null) {
      const dir = want();
      await unpackFolder(got.work, dir);
      setLocal(dir);
      this.h.store.set(chainKey(dir), JSON.stringify([["", w.tree], ...w.chain].slice(0, CHAIN)));
      return [`${w.name}'s files came from ${off} into ${tilde(dir)}.`];
    }
    const mine = await packFolder(base);
    const s = mine.bytes === null ? "" : sha(mine.bytes);
    if (s === w.tree) return [];
    if (s !== "" && w.chain.some(([, t]) => t === s)) {
      await unpackFolder(got.work, base);
      this.h.store.set(chainKey(base), JSON.stringify([["", w.tree], ...w.chain].slice(0, CHAIN)));
      return [`${w.name}'s files came from ${off}.`];
    }
    // Other changes here: the carried files go beside them, and this chat works there.
    let dir = `${base}-${off.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    for (let n = 2; existsSync(dir) && n < 100; n++) dir = `${base}-${off.replace(/[^A-Za-z0-9._-]+/g, "-")}-${n}`;
    await unpackFolder(got.work, dir);
    this.h.store.set(`worktree:${id}`, dir);
    this.h.store.set(chainKey(dir), JSON.stringify([["", w.tree], ...w.chain].slice(0, CHAIN)));
    return [`${w.name}'s files came from ${off}. Yours here stay as they were: this chat works in ${tilde(dir)}.`];
  }

  /** A worktree of the project for chat `c`, detached at `head`, where Harbor's worktrees go. */
  private async worktreeFor(repo: string, c: Chat, head: string): Promise<string> {
    const root = wt.root(this.h.store);
    const project = wt.projectPart(repo);
    const want = wt.slug(c.title || "continued", project) || "continued";
    const id = wt.freeId(root, project, want, await wt.takenBranches(repo)) ?? `${want}-${Date.now().toString(36)}`;
    const dir = join(root, `${project}-${id}`);
    await mkdir(root, { recursive: true });
    await wt.git(repo, ["worktree", "add", "--detach", dir, head], 120_000);
    return dir;
  }

  /** The carried session, its paths moved to this PC's, where its provider resumes it: "resumed", or why not. */
  private async session(id: number, got: Carried): Promise<string> {
    const e = this.h.engine();
    const c = e?.chat(id);
    const s = got.index.session;
    if (!e || !c) return "new";
    if (s === null) return "new";
    if (got.session === null) return got.why !== "" ? got.why : "its session isn't in the cloud";
    const account = e.account(c.account);
    if (!account || account.kind !== got.index.kind) return `this PC has no ${got.index.kind} account`;
    const cwd = e.chatCwd(c);
    const text = await remapSession(Buffer.from(got.session).toString("utf8"), got.index.space, spaceOf(cwd));
    const file = account.kind === "Claude" ? join(movechat.sessionDir(account.configDir, cwd), `${s.id}.jsonl`) : await rolloutPlace(codexHome(), s.id, basename(s.name));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    this.h.store.saveChat({ ...c, sessionId: s.id, started: true });
    this.h.store.set(sessionKindKey(id), account.kind);
    e.reload();
    return "resumed";
  }
}
