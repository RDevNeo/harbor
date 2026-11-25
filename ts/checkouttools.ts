import { basename } from "node:path";
import { checkout as co, type Engine, worktree as wt } from "./packages/agents/src/index.ts";
import type { Chat, Store } from "./packages/store/src/index.ts";
import type { Worktrees } from "./worktrees.ts";

/**
 * The lead's checkout tools (mcpshim.ts): its chat's worktree and branch, the ones the composer's line shows and the user switches by hand,
 * managed by the agent. They go through the picker's own code (worktrees.ts), so the line follows at once. The lead's own running turn
 * doesn't lock its checkout as it does the user's picker; another agent working in it does.
 */
export const TOOLS: ReadonlySet<string> = new Set(["checkout_status", "create_branch", "switch_branch", "rename_branch", "delete_branch", "merge_branch"]);

export interface CheckoutHost {
  store: Store;
  engine: () => Engine;
  worktrees: Worktrees;
}

function arg(a: unknown, k: string): string {
  const v = (a as Record<string, unknown> | null)?.[k];
  return typeof v === "string" ? v.trim() : "";
}

function flag(a: unknown, k: string): boolean | null {
  const v = (a as Record<string, unknown> | null)?.[k];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A chat as the lead knows it: "this chat", an agent's name, another chat's title; `Who` starts a sentence with it. */
function who(c: Chat, me: Chat): string {
  if (c.id === me.id) return "this chat";
  return c.role === "sub" ? `agent ${c.name}` : `chat “${c.title}”`;
}

const Who = (c: Chat, me: Chat): string => {
  const w = who(c, me);
  return (w[0] ?? "").toUpperCase() + w.slice(1);
};

/** Chats named in a sentence's start: "Agent tests, chat “Login”". */
const chatNames = (cs: readonly Chat[], me: Chat): string => cs.map((c, i) => (i === 0 ? Who(c, me) : who(c, me))).join(", ");

interface Where {
  target: Chat;
  repo: string;
  dir: string;
  /** Its own worktree (a lead's, or a sub-agent's), null in the project's checkout or (a sub-agent) its lead's folder. */
  own: string | null;
}

export class CheckoutTools {
  constructor(private readonly h: CheckoutHost) {}

  private get e(): Engine {
    return this.h.engine();
  }

  private get w(): Worktrees {
    return this.h.worktrees;
  }

  /** The answer to `name`, or undefined when it isn't one of these tools. */
  tool(me: Chat, name: string, a: unknown): Promise<string> | undefined {
    if (!TOOLS.has(name)) return undefined;
    return this.run(me, name, a);
  }

  private async run(me: Chat, name: string, a: unknown): Promise<string> {
    if (me.role !== "lead") throw new Error(`'${name}' is only available to the lead`);
    const at = this.where(me, a);
    switch (name) {
      case "checkout_status":
        return this.status(me, at);
      case "create_branch":
        return this.create(me, at, a);
      case "switch_branch":
        return this.switchTo(me, at, a);
      case "rename_branch":
        return this.rename(me, at, a);
      case "delete_branch":
        return this.remove(me, at, a);
      case "merge_branch":
        return this.merge(me, at, a);
    }
    throw new Error(`unknown tool '${name}'`);
  }

  /** The chat a call is about: the lead's, or (`agent`) one of its sub-agents'. */
  private where(me: Chat, a: unknown): Where {
    const name = arg(a, "agent");
    let target = me;
    if (name !== "") {
      const t = this.e.resolve(me, name);
      if (!t || t.role !== "sub" || t.parent !== me.id) throw new Error(`no agent named '${name}'. Use list_agents.`);
      target = t;
    }
    const info = this.w.info({ t: "chat", id: target.id });
    if (!info) throw new Error(`${target.id === me.id ? "this chat" : target.name} isn't in a git project on this PC`);
    const own = target.role === "sub" && (this.h.store.get(`worktree:${target.id}`) ?? "") === "" ? null : info.worktree;
    return { target, repo: info.repo, dir: info.dir, own };
  }

  /** The other chats whose agents are working in `dir` right now. */
  private workingIn(dir: string, me: Chat): Chat[] {
    const e = this.e;
    return e.chats.filter((c) => c.id !== me.id && c.home === "" && !c.retired && e.running(c.id) && co.samePath(e.chatCwd(c), dir));
  }

  /** The chats that work in worktree `dir` as their own. */
  private usersOf(dir: string): Chat[] {
    return this.e.chats.filter((c) => {
      const w = this.h.store.get(`worktree:${c.id}`) ?? "";
      return c.home === "" && w !== "" && co.samePath(w, dir);
    });
  }

  private unlocked(dir: string, me: Chat, doing: string): void {
    const busy = this.workingIn(dir, me);
    if (busy.length > 0) throw new Error(`${chatNames(busy, me)} ${busy.length === 1 ? "is" : "are"} working in ${dir}: ${doing} once ${busy.length === 1 ? "it stops" : "they stop"}, or give it a worktree of its own`);
  }

  /** Runs git work with the composer's line saying so, one at a time, as the picker does. */
  private async busy<T>(what: string, f: () => Promise<T>): Promise<T> {
    const w = this.w;
    if (w.busy !== null) throw new Error(`git is still busy here (${w.busy.what})`);
    w.busy = { side: "branch", what };
    w.changed();
    try {
      return await f();
    } finally {
      w.busy = null;
      w.changed();
    }
  }

  /** What the lead's shell should know after its chat moved folders mid-turn. */
  private shellNote(me: Chat, at: Where, dir: string): string {
    if (at.target.id !== me.id || co.samePath(at.dir, dir)) return "";
    return ` Your shell is still in ${at.dir} for the rest of this turn: run commands there with cd "${dir}" && … or absolute paths; your next turns start in ${dir}.`;
  }

  private async status(me: Chat, at: Where): Promise<string> {
    const def = await co.defaultBranch(at.repo);
    const list = await co.trees(at.repo);
    const out: string[] = [];
    const subject = at.target.id === me.id ? "This chat" : `Agent ${at.target.name}`;
    const place = at.own !== null ? `its own worktree ${basename(at.dir)} (${at.dir})` : co.samePath(at.dir, at.repo) ? `the project's checkout ${at.repo}` : `your folder ${at.dir}`;
    out.push(`${subject} works in ${place}.`);
    out.push(`Branch: ${await co.branchLine(at.dir, def)}`);
    out.push(`Default branch: ${def}`);
    out.push("Worktrees:");
    for (const t of list) {
      const h = await wt.head(t.path);
      const users = t.main ? [] : this.usersOf(t.path).filter((c) => !c.retired);
      const bits = [t.main ? "the project's checkout" : basename(t.path), t.path, `on ${t.branch !== "" ? t.branch : `detached at ${t.head}`}`];
      if (h && h.dirty > 0) bits.push(plural(h.dirty, "uncommitted change"));
      if (co.samePath(t.path, at.dir)) bits.push("(here)");
      if (users.length > 0) bits.push(`used by ${users.map((c) => who(c, me)).join(", ")}`);
      if (t.locked) bits.push("locked");
      out.push(`- ${bits.join(" · ")}`);
    }
    const cur = (await wt.head(at.dir))?.branch ?? "";
    out.push("Local branches, newest first:");
    for (const r of await co.branchRows(at.repo, def, 25)) {
      const bits = [r.name + (r.name === cur ? " (current)" : "")];
      bits.push(r.upstream !== "" ? `${r.upstream}${r.track !== "" ? ` ${r.track}` : ""}` : "not pushed");
      if (r.merged) bits.push(`merged into ${def}`);
      bits.push(r.when);
      bits.push([...r.subject].slice(0, 80).join(""));
      out.push(`- ${bits.join(" · ")}`);
    }
    return out.join("\n");
  }

  private async create(me: Chat, at: Where, a: unknown): Promise<string> {
    const name = arg(a, "name");
    if (name === "") throw new Error("name is required, e.g. 'fix-login-redirect'");
    const tree = flag(a, "worktree") ?? true;
    const go = flag(a, "switch") ?? true;
    if (!tree && go && at.target.id !== me.id && at.own === null) throw new Error(`${at.target.name} shares your folder: pass worktree: true to give it its own`);
    const def = await co.defaultBranch(at.repo);
    const base = await co.freshBase(at.repo, arg(a, "base") || def);
    const tip = await wt.git(at.repo, ["rev-parse", "--short", `${base.ref}^{commit}`]);
    const from = `from ${base.ref} (${tip})${base.note === "" ? "" : `; ${base.note}`}`;
    if (tree) {
      const dir = await this.busy(`Creating ${name}…`, () => co.addTree(at.repo, wt.root(this.h.store), name, base.ref));
      if (!go) {
        this.w.changed();
        return `Created branch ${name} ${from} in a new worktree ${dir}. Nothing works there yet: switch_branch(worktree: "${basename(dir)}") moves a chat in.`;
      }
      this.unlockedMove(me, at);
      this.w.place(at.target.id, dir, `Working in a new worktree · ${basename(dir)} on branch ${name} (from ${base.ref})`, `the lead moved this thread to a new worktree, ${dir}, on branch ${name}: work there now, not in ${at.dir}.`);
      return `Created branch ${name} ${from} in a new worktree ${dir}; ${who(at.target, me)} works there now.${this.shellNote(me, at, dir)}`;
    }
    if (!go) {
      await co.branchAt(at.repo, name, base.ref);
      this.w.changed();
      return `Created branch ${name} ${from}. Nothing has it checked out yet.`;
    }
    this.unlocked(at.dir, me, "switch branches");
    const dirty = (await wt.head(at.dir))?.dirty ?? 0;
    await this.busy(`Creating ${name}…`, () => co.switchNew(at.dir, name, base.ref));
    this.switched(me, at, name);
    const carried = dirty > 0 ? ` Its ${plural(dirty, "uncommitted change")} came along.` : "";
    return `Created branch ${name} ${from} and switched ${at.dir} to it.${carried}${this.checkoutWarning(at)}`;
  }

  /** A chat moving folders mid-turn: its sub-agents sharing them move too, so none of them may be working. */
  private unlockedMove(me: Chat, at: Where): void {
    const moving = at.target.role === "sub" ? [at.target] : [at.target, ...this.e.subsOf(at.target.id).filter((s) => (this.h.store.get(`worktree:${s.id}`) ?? "") === "")];
    const busy = moving.filter((c) => c.id !== me.id && this.e.running(c.id));
    if (busy.length > 0) throw new Error(`${chatNames(busy, me)} ${busy.length === 1 ? "is" : "are"} working in ${at.dir}, which would move: wait for ${busy.length === 1 ? "it" : "them"} to stop`);
  }

  private switched(me: Chat, at: Where, branch: string): void {
    const owner = this.w.owner(at.target);
    this.e.notice(owner, "worktree", `Switched to branch ${branch}`, `Folder: ${wt.tilde(at.dir)}`);
    this.e.noteWorktree(owner, `the lead switched ${at.dir} to branch ${branch}.`);
    this.w.changed();
  }

  private checkoutWarning(at: Where): string {
    return co.samePath(at.dir, at.repo) ? " That's the project's own checkout: other chats without a worktree of their own see the switch too." : "";
  }

  private async switchTo(me: Chat, at: Where, a: unknown): Promise<string> {
    const branch = arg(a, "branch");
    const which = arg(a, "worktree");
    if ((branch === "") === (which === "")) throw new Error("give branch or worktree (one of them)");
    const list = await co.trees(at.repo);
    if (which !== "") {
      const t = co.findTree(list, which);
      if (!t) throw new Error(`no worktree '${which}'. Worktrees: ${list.map((x) => (x.main ? "checkout" : basename(x.path))).join(", ")}`);
      return this.moveTo(me, at, t);
    }
    const t = list.find((x) => x.branch === branch);
    if (t) {
      if (co.samePath(t.path, at.dir)) return `${Who(at.target, me)} is on ${branch} already, in ${at.dir}.`;
      return this.moveTo(me, at, t);
    }
    if (at.target.id !== me.id && at.own === null) throw new Error(`${at.target.name} shares your folder: create_branch(agent, worktree: true) gives it its own, or switch_branch(agent, worktree) moves it to an existing one`);
    this.unlocked(at.dir, me, "switch branches");
    const b = await wt.branches(at.repo);
    let name = branch;
    let remote = false;
    if (!b.local.includes(branch)) {
      const r = await co.remoteOf(at.repo);
      if (b.remote.includes(branch)) remote = true;
      else if (r !== null && b.remote.includes(`${r}/${branch}`)) [name, remote] = [`${r}/${branch}`, true];
      else throw new Error(`no branch '${branch}'. checkout_status lists them; create_branch makes a new one`);
    }
    const dirty = (await wt.head(at.dir))?.dirty ?? 0;
    await this.busy(`Switching to ${branch}…`, () => wt.switchTo(at.dir, name, remote));
    const now = (await wt.head(at.dir))?.branch ?? branch;
    this.switched(me, at, now);
    const carried = dirty > 0 ? ` Its ${plural(dirty, "uncommitted change")} came along.` : "";
    return `Switched ${at.dir} to ${now}.${carried}${this.checkoutWarning(at)}`;
  }

  /** Moves the chat into worktree `t` (the project's checkout: back out of its own). */
  private moveTo(me: Chat, at: Where, t: co.Tree): string {
    if (co.samePath(t.path, at.dir)) return `${Who(at.target, me)} works in ${t.path} already.`;
    this.unlockedMove(me, at);
    const on = t.branch !== "" ? t.branch : `detached at ${t.head}`;
    const lead = at.target.role === "sub" && at.target.parent !== null ? this.e.chat(at.target.parent) : undefined;
    // A sub-agent going back to its lead's folder shares it again; the project's checkout counts as "back" only for a lead.
    const back = at.target.role === "sub" ? lead !== undefined && co.samePath(this.e.chatCwd(lead), t.path) : t.main;
    const dir = back ? null : t.path;
    const text = back ? `Back in ${at.target.role === "sub" ? "the lead's folder" : "the project's checkout"} · on branch ${on}` : `Moved to the worktree ${basename(t.path)} · on branch ${on}`;
    this.w.place(at.target.id, dir, text, `the lead moved this thread to ${t.path} (branch ${on}): work there now, not in ${at.dir}.`);
    return `${Who(at.target, me)} works in ${t.path} now, on ${on}.${this.shellNote(me, at, t.path)}`;
  }

  private async rename(me: Chat, at: Where, a: unknown): Promise<string> {
    const name = arg(a, "name");
    if (name === "") throw new Error("name is required");
    const cur = (await wt.head(at.dir))?.branch ?? "";
    const old = arg(a, "branch") || cur;
    if (old === "") throw new Error(`${at.dir} is detached: give branch`);
    if (old === (await co.defaultBranch(at.repo))) throw new Error(`${old} is the project's default branch: it keeps its name`);
    // The chat's own worktree's branch: as the picker renames it (its folder follows once nothing works in it).
    if (old === cur && at.own !== null && at.target.id === this.w.owner(at.target)) {
      const r = await this.w.renameBranch(at.target.id, name, false, "agent");
      return `${wt.renameSaid(r)}.`;
    }
    const left = await this.busy(`Renaming to ${name}…`, () => co.renameLocal(at.repo, old, name));
    const t = (await co.trees(at.repo)).find((x) => x.branch === name);
    if (t) {
      for (const c of this.usersOf(t.path)) this.e.noteWorktree(this.w.owner(c), `the lead renamed the branch ${old} to ${name}.`);
      if (co.samePath(t.path, at.dir)) this.e.notice(this.w.owner(at.target), "worktree", `Branch renamed · ${old} → ${name}`);
    }
    this.w.changed();
    return `Renamed ${old} to ${name}.${left === null ? "" : ` ${left}.`}`;
  }

  private async remove(me: Chat, at: Where, a: unknown): Promise<string> {
    const branch = arg(a, "branch");
    const which = arg(a, "worktree");
    const force = flag(a, "force") === true;
    if (branch === "" && which === "") throw new Error("give branch, worktree or both");
    const list = await co.trees(at.repo);
    const def = await co.defaultBranch(at.repo);
    let t: co.Tree | undefined;
    if (which !== "") {
      t = co.findTree(list, which);
      if (!t) throw new Error(`no worktree '${which}'. Worktrees: ${list.map((x) => (x.main ? "checkout" : basename(x.path))).join(", ")}`);
    } else t = list.find((x) => x.branch === branch);
    if (t?.main) throw new Error(which !== "" ? "that's the project's own checkout: it's never removed" : `${branch} is checked out in the project's checkout ${t.path}: switch that to another branch first`);
    if (branch === def) throw new Error(`${branch} is the project's default branch: it's never deleted`);
    const mine = this.e.chatCwd(me);
    if (t && co.samePath(t.path, mine)) throw new Error(`this chat works in ${t.path}: switch_branch it elsewhere first (e.g. worktree: "checkout")`);
    if (branch !== "" && branch === (await wt.head(mine))?.branch) throw new Error(`this chat is on ${branch}: switch it to another branch first`);
    // Everything is checked before anything goes.
    if (branch !== "" && !(await co.isLocal(at.repo, branch))) throw new Error(`no local branch '${branch}'`);
    if (branch !== "" && !force && (await co.keptIn(at.repo, branch, def)) === null) {
      const n = (await co.aheadBehind(at.repo, `refs/heads/${branch}`, def))?.ahead ?? 0;
      throw new Error(`${branch} has ${plural(n, "commit")} that aren't merged into ${def} or pushed: merge_branch or push it first, or pass force: true to delete them`);
    }
    let users: Chat[] = [];
    if (t) {
      const busy = this.workingIn(t.path, me);
      if (busy.length > 0) throw new Error(`${chatNames(busy, me)} ${busy.length === 1 ? "is" : "are"} working in ${t.path}: remove it once ${busy.length === 1 ? "it stops" : "they stop"}`);
      users = this.usersOf(t.path);
      const live = users.filter((c) => !c.retired);
      if (live.length > 0 && !force) throw new Error(`${chatNames(live, me)} ${live.length === 1 ? "works" : "work"} in ${t.path}: switch_branch ${live.length === 1 ? "it" : "them"} elsewhere first, or pass force: true to move ${live.length === 1 ? "it" : "them"} back to the project's checkout`);
      const dirty = (await wt.head(t.path))?.dirty ?? 0;
      if (dirty > 0 && !force) throw new Error(`${t.path} has ${plural(dirty, "uncommitted change")}: commit them to ${t.branch !== "" ? t.branch : "a branch"} first, or pass force: true to discard them`);
    }
    const tree = t;
    const said = await this.busy(`Deleting ${branch !== "" ? branch : basename(tree?.path ?? which)}…`, async () => {
      const out: string[] = [];
      if (tree) {
        for (const c of users) {
          if (c.retired) this.h.store.set(`worktree:${c.id}`, "");
          else this.w.place(c.id, null, c.role === "sub" ? "Back in the lead's folder" : "Back in the project's checkout", `the lead removed the worktree ${tree.path}: this thread works in ${c.role === "sub" ? "the lead's folder" : `the project's checkout ${at.repo}`} now.`);
        }
        out.push(await co.removeTree(at.repo, tree.path, force));
      }
      if (branch !== "") out.push(await co.deleteBranch(at.repo, branch, def, force));
      return out;
    });
    this.w.changed();
    return `${said.join(". ")}.`;
  }

  private async merge(me: Chat, at: Where, a: unknown): Promise<string> {
    const cur = (await wt.head(at.dir))?.branch ?? "";
    const from = arg(a, "branch") || cur;
    if (from === "") throw new Error(`${at.dir} is detached: give branch`);
    const into = arg(a, "into") || (await co.defaultBranch(at.repo));
    if (from === into) throw new Error(`branch and into are both ${into}`);
    const m = arg(a, "mode") || "auto";
    if (m !== "auto" && m !== "ff-only" && m !== "no-ff") throw new Error("mode is 'auto', 'ff-only' or 'no-ff'");
    const t = (await co.trees(at.repo)).find((x) => x.branch === into);
    if (t) this.unlocked(t.path, me, `merge into ${into}`);
    let r: co.MergeDone;
    try {
      r = await this.busy(`Merging ${from} into ${into}…`, () => co.merge(at.repo, from, into, m, wt.root(this.h.store)));
    } catch (x) {
      if (x instanceof co.MergeConflict) this.e.notice(me.id, "alert", `Merge conflict · ${from} into ${into}: nothing merged`, x.files.join("\n"));
      throw x;
    }
    if (r.how === "up to date") return `${into} already has everything of ${from}: nothing to merge.`;
    this.e.notice(me.id, "worktree", `Merged ${from} into ${into} · ${r.how} · ${r.tip}`);
    if (t) for (const c of this.usersOf(t.path)) this.e.noteWorktree(this.w.owner(c), `the lead merged ${from} into ${into}, checked out here.`);
    this.w.changed();
    return `Merged ${from} into ${into} (${r.how}), now at ${r.tip}${r.dir !== null ? ` in ${r.dir}` : ""}. Not pushed: push ${into} when the project's rules say to. Once ${from} isn't needed, delete_branch removes it (and its worktree).`;
  }

  /** spawn_agent's own worktree: a new branch `branch` from `base` (default: the lead's branch as it is, its commits only) in a new worktree. */
  async makeWorktree(lead: Chat, branch: string, base: string): Promise<{ dir: string; branch: string; base: string }> {
    const info = this.w.info({ t: "chat", id: lead.id });
    if (!info) throw new Error("a worktree of its own needs a git project on this PC");
    let ref: string;
    if (base !== "") ref = (await co.freshBase(info.repo, base)).ref;
    else {
      const h = await wt.head(info.dir);
      ref = h && h.branch !== "" ? h.branch : "HEAD";
      if (ref === "HEAD") ref = await wt.git(info.dir, ["rev-parse", "HEAD"]);
    }
    let name = branch;
    if (name.startsWith("hub/") || name.startsWith("harbor/")) {
      const taken = await wt.takenBranches(info.repo);
      for (let n = 2; taken.has(name) && n < 100; n++) name = `${branch}-${n}`;
    }
    const dir = await this.busy(`Creating ${name}…`, () => co.addTree(info.repo, wt.root(this.h.store), name, ref));
    this.w.changed();
    return { dir, branch: name, base: ref };
  }
}
