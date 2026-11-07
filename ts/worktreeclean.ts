import { type chatpr, type Engine, worktree as wt, wtclean } from "./packages/agents/src/index.ts";
import type { Chat, Store } from "./packages/store/src/index.ts";
import type { Worktrees } from "./worktrees.ts";

/**
 * Delete merged worktrees: once a chat's branch has a merged PR (chatpr.ts) and nothing works in
 * its worktree, the worktree goes, and its branch if the settings say so (wtclean.ts checks
 * nothing would be lost). It runs on the PC that holds the folder, whenever a lookup finds the
 * PR merged, at the start and now and then for what had to wait; the project menu's Clean up
 * merged worktrees runs it for every chat of a project at once. The chat stays, and works in the
 * project's checkout from then on.
 */
export interface CleanHost {
  store: Store;
  engine: () => Engine;
  prs: chatpr.ChatPrs;
  worktrees: Worktrees;
  /** What else holds the folder (the window's terminals in it), null: nothing. */
  busyIn: (dir: string) => string | null;
  touch: () => void;
}

/** What a chat's cleanup came to. */
export type Outcome =
  | { kind: "removed"; branch: "deleted" | "kept" | "none"; remote: string }
  | { kind: "kept"; why: string }
  | { kind: "busy"; why: string }
  | { kind: "none" };

/** Clean up merged worktrees' counts for a project, and the line saying them. */
export interface ProjectResult {
  removed: number;
  branches: number;
  kept: number;
  busy: number;
  open: number;
  said: string;
}

/** The kv key remembering why a chat's merged worktree stayed, so the chat says it once. */
const KEPT_KEY = "wt_clean_kept:";
const RETRY_MS = 10 * 60_000;
const START_MS = 20_000;

const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export class WorktreeCleaner {
  private readonly busy = new Set<number>();
  private startAt: number;
  private retried = 0;

  constructor(private readonly h: CleanHost) {
    this.startAt = Date.now() + START_MS;
  }

  private get e(): Engine {
    return this.h.engine();
  }

  prefs(): wtclean.Prefs {
    return wtclean.prefsOf(this.h.store);
  }

  /** A lookup found a chat's PR merged (chatpr.ts PrHost `merged`). */
  merged(lead: number, pr: chatpr.ChatPr): void {
    if (!this.prefs().worktree) return;
    void this.chat(lead, pr).catch((e) => console.error(`harbor: merged worktree cleanup: ${say(e)}`));
  }

  /** The engine's tick: the first pass a little after the start, then again every 10 minutes for what had to wait. */
  tick(): void {
    const t = Date.now();
    if (t < this.startAt || t - this.retried < RETRY_MS || !this.prefs().worktree) return;
    this.retried = t;
    void this.pass().catch((e) => console.error(`harbor: merged worktree cleanup: ${say(e)}`));
  }

  /** Every chat here whose PR was last seen merged and that still has a worktree. */
  private async pass(): Promise<void> {
    for (const [lead, pr] of [...this.h.prs.found]) {
      if (pr.state !== "merged") continue;
      const c = this.e.chat(lead);
      if (!c || this.e.worktreeOf(c) === null) continue;
      await this.chat(lead, pr);
    }
  }

  /** What holds the chat's worktree now (null: nothing): a turn, a process, a terminal, git, queued messages, a move. */
  private holding(lead: number, dir: string, others: readonly number[]): string | null {
    const w = this.h.worktrees;
    const why = w.folderBusy(lead) ?? others.map((o) => w.folderBusy(o)).find((x) => x !== null) ?? this.h.busyIn(dir);
    if (why) return why;
    if (w.busy !== null) return "git is busy with it";
    if (this.e.queuedCount(lead) > 0 || this.e.subsQueued(lead) > 0) return "messages wait to be sent";
    return null;
  }

  /** Cleans chat `lead`'s worktree if its PR `pr` is merged and nothing would be lost. */
  async chat(lead: number, pr: chatpr.ChatPr): Promise<Outcome> {
    const e = this.e;
    const c = e.chat(lead);
    if (!c || c.role === "sub" || c.home !== "" || c.device !== "") return { kind: "none" };
    const dir = e.worktreeOf(c);
    if (dir === null || pr.state !== "merged") return { kind: "none" };
    if (this.busy.has(lead)) return { kind: "busy", why: "it's being cleaned up" };
    const repo = e.cwdOf(c.repoId);
    // Chats of other trees that were pointed at the same folder go with it.
    const others = e.chats.filter((x) => x.id !== lead && x.role !== "sub" && x.home === "" && e.worktreeOf(x) === dir).map((x) => x.id);
    const held = this.holding(lead, dir, others);
    if (held !== null) return { kind: "busy", why: held };
    const merged: wtclean.Merged = { number: pr.number, branch: pr.branch, head: pr.head ?? "" };
    this.busy.add(lead);
    try {
      const ck = await wtclean.check(repo, dir, merged);
      if (!ck.ok) {
        if (!ck.later) this.kept(lead, merged, ck.why);
        return { kind: "kept", why: ck.why };
      }
      // Checking took a while: something may have started in it meanwhile.
      const now = this.holding(lead, dir, others);
      if (now !== null) return { kind: "busy", why: now };
      let done: wtclean.Cleaned;
      try {
        done = await wtclean.clean(ck.plan, this.prefs(), merged);
      } catch (x) {
        const why = `git couldn't remove it: ${say(x)}`;
        this.kept(lead, merged, why);
        return { kind: "kept", why };
      }
      this.h.worktrees.forget(lead, others);
      this.h.store.set(`${KEPT_KEY}${lead}`, "");
      const checkout = await wt.head(repo);
      const on = checkout ? wt.headLabel(checkout) : "";
      const [text, detail] = wtclean.notice(wt.tilde(dir), merged, done, wt.tilde(repo), on);
      for (const id of [lead, ...others]) {
        e.notice(id, "worktree", text, detail);
        e.noteWorktree(id, `this thread's worktree ${dir} was removed: its branch ${merged.branch} was merged (PR #${merged.number})${done.branch === "deleted" ? " and deleted" : ""}. You now work in the project's checkout, ${repo}${on === "" ? "" : `, on ${on}`}: start a new branch before changing anything.`);
      }
      this.h.prs.want(lead, null);
      this.h.touch();
      const remote = done.remote === "deleted" ? "deleted" : done.remote === "kept" ? done.remoteWhy : "";
      return { kind: "removed", branch: done.branch, remote };
    } finally {
      this.busy.delete(lead);
    }
  }

  /** The chat says once why its merged worktree stays (again only when the reason changes). */
  private kept(lead: number, pr: wtclean.Merged, why: string): void {
    const k = `${KEPT_KEY}${lead}`;
    const line = `${pr.number}:${why}`;
    if (this.h.store.get(k) === line) return;
    this.h.store.set(k, line);
    const [text, detail] = wtclean.keptNotice(pr, why);
    this.e.notice(lead, "worktree", text, detail);
  }

  /** Clean up merged worktrees for every chat of project `repo` on this PC: each one's PR looked up now, then cleaned when merged. */
  async project(repo: number): Promise<ProjectResult> {
    const e = this.e;
    const leads = e.chats.filter((c: Chat) => c.repoId === repo && c.role !== "sub" && c.home === "" && c.device === "" && e.worktreeOf(c) !== null);
    const r: ProjectResult = { removed: 0, branches: 0, kept: 0, busy: 0, open: 0, said: "" };
    const why: string[] = [];
    for (const c of leads) {
      const pr = await this.h.prs.now(c.id);
      if (!pr || pr.state !== "merged") {
        r.open++;
        continue;
      }
      const o = await this.chat(c.id, pr);
      if (o.kind === "removed") {
        r.removed++;
        if (o.branch === "deleted") r.branches++;
      } else if (o.kind === "kept") {
        r.kept++;
        why.push(`${c.title || c.name}: ${o.why}`);
      } else if (o.kind === "busy") {
        r.busy++;
        why.push(`${c.title || c.name}: ${o.why}`);
      }
    }
    r.said = projectSaid(r, leads.length, why);
    return r;
  }
}

/** "Removed 2 merged worktrees and their branches; kept 1 (Fix login: it has 1 uncommitted change)". */
export function projectSaid(r: Omit<ProjectResult, "said">, total: number, why: readonly string[]): string {
  if (total === 0) return "No chat of this project has a worktree";
  const parts: string[] = [];
  if (r.removed > 0) parts.push(`Removed ${plural(r.removed, "merged worktree")}${r.branches === 0 ? "" : r.branches === r.removed ? ` and ${r.removed === 1 ? "its branch" : "their branches"}` : ` and ${plural(r.branches, "branch", "branches")}`}`);
  else if (r.kept + r.busy === 0) parts.push(`No merged worktrees: ${plural(r.open, "worktree")} without a merged PR`);
  if (r.kept + r.busy > 0) parts.push(`${r.removed > 0 ? "kept" : "Kept"} ${r.kept + r.busy} (${why.slice(0, 3).join("; ")}${why.length > 3 ? "; …" : ""})`);
  return parts.join("; ");
}
