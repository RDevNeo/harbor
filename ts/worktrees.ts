import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Engine, movechat, providers, worktree as wt } from "./packages/agents/src/index.ts";
import { workspace } from "./packages/mcp/src/index.ts";
import { type Chat, repoDir, type Store } from "./packages/store/src/index.ts";

export type Target = { t: "draft"; repo: number | null } | { t: "chat"; id: number };

export interface Info {
  repo: string;
  dir: string;
  worktree: string | null;
  newWorktree: boolean;
  base: string;
  canMove: string | null;
  branchLock: string | null;
  rename: string | null;
}

export interface RenameResult {
  kind: wt.RenameKind;
  renamed: wt.Renamed;
  folder: string;
  path: string;
  waits: string | null;
}

export interface WorktreesHost {
  store: Store;
  engine: () => Engine;
  touch: () => void;
  wantPr?: (chat: number) => void;
  busyIn?: (dir: string) => string | null;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Worktrees {
  busy: { side: "workspace" | "branch"; what: string } | null = null;
  private readonly moves = new Map<number, string>();
  private loaded = false;

  constructor(private readonly h: WorktreesHost) {}

  private get e(): Engine {
    return this.h.engine();
  }

  private lead(c: Chat): number {
    return c.role === "sub" ? (c.parent ?? c.id) : c.id;
  }

  private tree(lead: number): number[] {
    return [lead, ...this.e.subsOf(lead).map((s) => s.id)];
  }

  info(target: Target): Info | null {
    let repoId: number | null;
    let chat: Chat | undefined;
    if (target.t === "draft") {
      if (target.repo === null) return null;
      repoId = target.repo;
    } else {
      chat = this.e.chat(target.id);
      if (!chat || chat.home !== "" || chat.device !== "") return null;
      repoId = chat.repoId;
    }
    const r = repoId === null ? undefined : this.e.repo(repoId);
    if (!r) return null;
    const repo = repoDir(r);
    if (!existsSync(join(repo, ".git"))) return null;
    if (!chat) return { repo, dir: repo, worktree: null, newWorktree: false, base: "", canMove: "a new chat", branchLock: null, rename: "a new chat: it's named after its first message" };
    const w = this.e.worktreeOf(chat);
    const lead = this.lead(chat);
    const running = this.tree(lead).some((i) => this.e.running(i));
    let canMove: string | null = null;
    if (w !== null) canMove = "it already has its own worktree";
    else {
      try {
        this.e.movable(lead);
      } catch (x) {
        canMove = say(x);
      }
    }
    return {
      repo,
      dir: w ?? repo,
      worktree: w,
      newWorktree: false,
      base: "",
      canMove,
      branchLock: running ? "An agent is working here: switch branches once it stops." : null,
      rename: w === null ? "it runs in the project's checkout: only a thread's own worktree is renamed here" : !isDir(w) ? "its worktree isn't there anymore" : null,
    };
  }

  /** Asks the first signed-in Claude account that isn't at (or near) a usage limit: one near its limit doesn't leave the worktree with the slug. */
  namer(about: string, repo: string): wt.Namer | null {
    const e = this.e;
    const a = e.host
      .accounts()
      .filter((a) => a.kind === "Claude" && providers.signedIn(a) && e.limits.blocked(a.id) === undefined)
      .filter((a) => !(e.limits.quota.get(a.id) ?? []).some(([, used]) => used >= 0.9))
      .sort((a, b) => Number(a.id !== "claude") - Number(b.id !== "claude"))[0];
    if (!a) return null;
    return wt.namer(providers.binStr(a), providers.accountEnv(a), about, wt.projectPart(repo));
  }

  make(repo: string, base: string, about: string): Promise<wt.Made> {
    return wt.make(repo, base, about, this.namer(about, repo), wt.root(this.h.store));
  }

  attach(chat: number, made: wt.Made): void {
    this.h.store.set(`worktree:${chat}`, made.dir);
    const [text, detail] = wt.madeNotice(made, "Working in a new worktree");
    this.e.notice(chat, "worktree", text, detail);
    this.nameLater(chat, made);
  }

  async discard(repo: string, dir: string): Promise<void> {
    await wt.remove(repo, dir).catch(() => undefined);
  }

  private nameLater(lead: number, made: wt.Made): void {
    const late = made.late;
    if (late === null) return;
    void (async () => {
      const name = await Promise.race([late, sleep(wt.timing.nameLateMs).then(() => null)]);
      if (name === null) return;
      const id = made.branch.startsWith("harbor/") ? made.branch.slice(7) : null;
      if (id === null) return;
      const h = await wt.head(made.dir);
      if (!h || h.branch !== made.branch || wt.isNamed(id, name)) return;
      const base = basename(made.dir);
      if (!base.endsWith(`-${id}`)) return;
      const free = wt.freeId(dirname(made.dir), base.slice(0, -(id.length + 1)), name, await wt.takenBranches(made.dir));
      if (free !== null) await this.nameApply(lead, `harbor/${free}`, 0);
    })();
  }

  private async nameApply(lead: number, to: string, tries: number): Promise<void> {
    if (this.folderNamed(lead) || !this.e.chat(lead)) return;
    if (this.busy !== null) {
      if (tries < 20) {
        await sleep(1000);
        await this.nameApply(lead, to, tries + 1);
      }
      return;
    }
    await this.renameBranch(lead, to, false, false).catch((x) => console.error(`harbor: couldn't name the worktree: ${say(x)}`));
  }

  async moveToWorktree(chat: number): Promise<string> {
    const info = this.info({ t: "chat", id: chat });
    if (!info) throw new Error("this chat isn't in a git project on this PC");
    if (info.canMove !== null) throw new Error(info.canMove);
    if (this.busy !== null) throw new Error("still busy with the last worktree");
    this.busy = { side: "workspace", what: "Creating worktree…" };
    const about = this.e.chat(chat)?.title ?? "";
    let made: wt.Made;
    try {
      made = await wt.make(info.repo, "", about, this.namer(about, info.repo), wt.root(this.h.store));
    } finally {
      this.busy = null;
    }
    try {
      this.moved(chat, made);
    } catch (x) {
      void this.discard(info.repo, made.dir);
      throw x;
    }
    return made.dir;
  }

  private moved(chat: number, made: wt.Made): void {
    const e = this.e;
    const ids = e.movable(chat);
    for (const id of ids) {
      const c = e.chat(id);
      const acc = c ? e.account(c.account) : undefined;
      if (!c || !acc) continue;
      if (acc.kind === "Claude" && c.started && c.sessionId !== "") {
        try {
          movechat.ensureSession(acc.configDir, c.sessionId, made.dir);
        } catch (x) {
          throw new Error(`couldn't copy ${c.name}'s session: ${say(x)}`);
        }
      }
      workspace.forget(id);
    }
    this.h.store.set(`worktree:${chat}`, made.dir);
    const [text, detail] = wt.madeNotice(made, "Moved to a new worktree");
    e.notice(chat, "worktree", text, detail);
    this.nameLater(chat, made);
    this.h.touch();
  }

  folderBusy(lead: number): string | null {
    const ids = this.tree(lead);
    const e = this.e;
    if (ids.some((i) => e.running(i))) return "an agent is working in it";
    const p = e.procs.find((x) => ids.includes(x.lead) || ids.includes(x.owner));
    if (p) return `its process “${p.name}” is running`;
    return null;
  }

  folderNamed(lead: number): boolean {
    return this.h.store.get(`worktree_named:${lead}`) === "1";
  }

  folderTo(lead: number): string | null {
    this.loadMoves();
    return this.moves.get(lead) ?? null;
  }

  private planMove(lead: number, name: string): void {
    this.h.store.set(`worktree_move:${lead}`, name);
    this.moves.set(lead, name);
  }

  private unplanMove(lead: number): void {
    if (this.moves.delete(lead)) this.h.store.set(`worktree_move:${lead}`, "");
  }

  private loadMoves(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const c of this.e.chats) {
      const v = this.h.store.get(`worktree_move:${c.id}`);
      if (v !== null && v !== "") this.moves.set(c.id, v);
    }
  }

  private result(kind: wt.RenameKind, lead: number, fallbackDir: string, renamed: wt.Renamed, suffix: (w: string) => string = (w) => w): RenameResult {
    const c = this.e.chat(lead);
    const path = (c ? this.e.worktreeOf(c) : null) ?? fallbackDir;
    const busy = this.moves.has(lead) ? this.folderBusy(lead) : null;
    return { kind, renamed, folder: basename(path), path, waits: busy === null ? null : suffix(busy) };
  }

  async renameBranch(chat: number, name: string, onRemote: boolean, byUser: boolean): Promise<RenameResult> {
    const c = this.e.chat(chat);
    if (!c) throw new Error("no such chat");
    const lead = this.lead(c);
    const info = this.info({ t: "chat", id: chat });
    if (!info) throw new Error("this chat isn't in a git project on this PC");
    if (info.rename !== null) throw new Error(info.rename);
    const fresh = name.trim();
    if (fresh === "") throw new Error("type the branch's new name");
    if (this.busy !== null) throw new Error("git is still busy here");
    this.busy = { side: "branch", what: `Renaming to ${fresh}…` };
    let rn: wt.Renamed;
    try {
      rn = await wt.renameBranch(info.dir, fresh, onRemote);
    } finally {
      this.busy = null;
    }
    if (rn.old !== rn.branch) {
      let detail = `Branch: ${rn.branch} (was ${rn.old})`;
      if (rn.remote !== null) detail += `\n${rn.remote}.`;
      const e = this.e;
      if (byUser) {
        e.notice(lead, "worktree", `Branch renamed · ${rn.old} → ${rn.branch}`, detail);
        e.noteWorktree(lead, `the user renamed this worktree's branch from ${rn.old} to ${rn.branch}.`);
      } else {
        e.notice(lead, "worktree", `Branch named · ${rn.old} → ${rn.branch}`, detail);
        e.noteWorktree(lead, `Harbor renamed this worktree's branch from ${rn.old} to ${rn.branch}, a name for the task.`);
      }
      if (!this.folderNamed(lead)) {
        const to = wt.folderFor(info.repo, info.dir, rn.branch);
        if (to !== null) this.planMove(lead, basename(to));
      }
      this.h.wantPr?.(lead);
      this.tickMoves();
    }
    this.h.touch();
    return this.result("branch", lead, info.dir, rn);
  }

  renameFolder(chat: number, name: string): RenameResult {
    const c = this.e.chat(chat);
    if (!c) throw new Error("no such chat");
    const lead = this.lead(c);
    const info = this.info({ t: "chat", id: chat });
    if (!info) throw new Error("this chat isn't in a git project on this PC");
    if (info.rename !== null) throw new Error(info.rename);
    const fresh = name.trim();
    const problem = wt.folderNameProblem(info.dir, fresh);
    if (problem !== null) throw new Error(problem);
    this.loadMoves();
    this.h.store.set(`worktree_named:${lead}`, "1");
    if (fresh === basename(info.dir)) this.unplanMove(lead);
    else {
      this.planMove(lead, fresh);
      this.tickMoves();
    }
    this.h.touch();
    return this.result("folder", lead, info.dir, { old: "", branch: "", remote: null }, (w) => `${w}; it becomes ${fresh} then`);
  }

  tickMoves(): void {
    this.loadMoves();
    if (this.moves.size === 0) return;
    const e = this.e;
    for (const lead of [...this.moves.keys()]) {
      const c = e.chat(lead);
      const dir = c ? e.worktreeOf(c) : null;
      if (dir === null || !isDir(dir)) {
        this.unplanMove(lead);
        continue;
      }
      if (this.folderBusy(lead) !== null || this.h.busyIn?.(dir)) continue;
      const name = this.moves.get(lead);
      if (name === undefined) continue;
      this.unplanMove(lead);
      const parent = dirname(dir);
      let to = join(parent, name);
      if (to === dir) continue;
      if (existsSync(to)) {
        if (this.folderNamed(lead)) {
          e.notice(lead, "worktree", "The worktree's folder keeps its name", `Couldn't rename ${wt.tilde(dir)} to ${name}: a folder of that name appeared meanwhile.`);
          continue;
        }
        let free: string | null = null;
        for (let n = 2; n < 100 && free === null; n++) if (!existsSync(join(parent, `${name}-${n}`))) free = join(parent, `${name}-${n}`);
        if (free === null) continue;
        to = free;
      }
      try {
        this.moveFolder(lead, dir, to);
      } catch (x) {
        e.notice(lead, "worktree", "The worktree's folder keeps its name", `Couldn't rename ${wt.tilde(dir)} to ${to}: ${say(x)}`);
      }
    }
  }

  private moveFolder(lead: number, dir: string, to: string): void {
    const e = this.e;
    const ids = this.tree(lead);
    for (const id of ids) {
      const c = e.chat(id);
      const acc = c ? e.account(c.account) : undefined;
      if (c && acc && acc.kind === "Claude" && c.started && c.sessionId !== "") {
        try {
          movechat.ensureSession(acc.configDir, c.sessionId, to);
        } catch (x) {
          throw new Error(`couldn't copy ${c.name}'s session: ${say(x)}`);
        }
      }
    }
    wt.moveDir(dir, to);
    this.h.store.set(`worktree:${lead}`, to);
    for (const id of ids) workspace.forget(id);
    e.notice(lead, "worktree", `Worktree folder renamed · ${basename(dir)} → ${basename(to)}`, `Folder: ${wt.tilde(to)}`);
    e.noteWorktree(lead, `this thread's worktree folder moved from ${dir} to ${to}: work there now, nothing is left under the old path.`);
    this.h.touch();
  }

  async branch(target: Target, row: { name: string; remote: boolean } | null, create: string | null): Promise<void> {
    const info = this.info(target);
    if (!info) throw new Error("no git project here");
    if (info.branchLock !== null) throw new Error(info.branchLock);
    if (this.busy !== null) throw new Error("git is still busy here");
    if (row === null && create === null) throw new Error("nothing to do");
    this.busy = { side: "branch", what: row ? `Switching to ${row.name}…` : `Creating ${create}…` };
    try {
      if (row) await wt.switchTo(info.dir, row.name, row.remote);
      else if (create !== null) await wt.create(info.dir, create);
    } finally {
      this.busy = null;
    }
    this.h.touch();
  }

  /** The chat's worktree was removed (worktreeclean.ts): it, its sub-agents and `others` sharing the folder work in the project's checkout again. */
  forget(lead: number, others: readonly number[] = []): void {
    this.loadMoves();
    for (const id of [lead, ...others]) {
      this.h.store.set(`worktree:${id}`, "");
      this.h.store.set(`worktree_named:${id}`, "");
      this.unplanMove(id);
    }
    for (const id of [...this.tree(lead), ...others]) workspace.forget(id);
    this.h.touch();
  }

  drop(chat: Chat): void {
    const key = `worktree:${chat.id}`;
    const dir = this.h.store.get(key);
    this.h.store.set(key, "");
    this.h.store.set(`worktree_named:${chat.id}`, "");
    this.loadMoves();
    this.unplanMove(chat.id);
    if (dir === null || dir === "") return;
    const repo = this.e.cwdOf(chat.repoId);
    void wt.remove(repo, dir).catch((x) => {
      this.e.notice(chat.id, "alert", "Kept the chat's worktree", `${say(x)}. Commit or discard them, then remove it with \`git worktree remove ${dir}\`.`);
    });
  }
}

