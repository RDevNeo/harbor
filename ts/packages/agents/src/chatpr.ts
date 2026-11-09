import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Chat, Store } from "@harbor/store";
import { outputWithin } from "./git.ts";
import { at, bool, optStr, parse, u64 } from "./json.ts";
import { childPath } from "./providers.ts";
import { githubRepo, head as worktreeHead } from "./worktree.ts";

export const SHOWN_TTL_MS = 60_000;
/** Open and draft PRs of chats nobody looks at, so a merge on GitHub reaches their rows. */
const SWEEP_TTL_MS = 600_000;
const SWEEP_EVERY_MS = 20_000;
const SWEEP_MAX = 3;
/** After gh failed (not installed, signed out, offline): don't ask every minute. */
const FAILED_TTL_MS = 300_000;
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 30_000;

export type PrState = "open" | "draft" | "merged" | "closed";

export function word(s: PrState): string {
  return s === "open" ? "Open" : s === "draft" ? "Draft" : s === "merged" ? "Merged" : "Closed";
}

export interface ChatPr {
  number: number;
  state: PrState;
  url: string;
  title: string;
  /** The local branch it was found for: looked up with it again once the worktree is gone. */
  branch: string;
  /** The PR's head commit on GitHub (gh `headRefOid`): a merged worktree is cleaned up only when its branch holds nothing past it. */
  head?: string;
}

/** "PR #123 · Merged". */
export function label(p: ChatPr): string {
  return `PR #${p.number} · ${word(p.state)}`;
}

export function tip(p: ChatPr): string {
  return `${label(p)}\n${p.title}\nOpens it on GitHub`;
}

/** Chat JSON `pr` (phones, peers). */
export function prJson(p: ChatPr): Record<string, unknown> {
  return { number: p.number, state: p.state, label: label(p), title: p.title, url: p.url };
}

/** A peer's `pr` (null when it has none, or is older than 0.83). */
export function prFrom(v: unknown): ChatPr | null {
  const state = optStr(at(v, "state"));
  const number = u64(at(v, "number"));
  const url = optStr(at(v, "url"));
  if ((state !== "open" && state !== "draft" && state !== "merged" && state !== "closed") || number === undefined || url === undefined) return null;
  const head = optStr(at(v, "head")) ?? "";
  return { number, state, url, title: optStr(at(v, "title")) ?? "", branch: optStr(at(v, "branch")) ?? "", ...(head !== "" ? { head } : {}) };
}

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const out = await outputWithin(["git", "-C", dir, ...args], GIT_TIMEOUT_MS, { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    const s = out.stdout.trim();
    return out.code === 0 && s !== "" ? s : null;
  } catch {
    return null;
  }
}

/** Where a branch's PR is looked for: its head branch on GitHub, the repos the PR may be in, and the owner of the repo it's pushed to. */
export interface Where {
  head: string;
  repos: string[];
  owner: string;
}

/** Null: it can't have one (not pushed, the default branch, not a GitHub remote). */
export async function place(dir: string, branch: string, known: boolean): Promise<Where | null> {
  const r = await git(dir, ["config", "--get", `branch.${branch}.remote`]);
  const remote = r !== null && r !== "." ? r : "origin";
  const merge = await git(dir, ["config", "--get", `branch.${branch}.merge`]);
  const head = merge?.startsWith("refs/heads/") ? merge.slice(11) : branch;
  const url = await git(dir, ["remote", "get-url", remote]);
  const pushed = url === null ? null : githubRepo(url);
  if (pushed === null) return null;
  // The default branch has no PR of its own.
  const sym = await git(dir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  const def = sym?.startsWith(`${remote}/`) ? sym.slice(remote.length + 1) : null;
  if (def === null ? head === "main" || head === "master" : def === head) return null;
  // Never pushed: no PR, unless one was found before (GitHub may have deleted the branch on merge).
  if (!known && (await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${head}`])) === null) return null;
  // A fork's PRs live in the repo it was forked from (remote `upstream`), then its own.
  const up = await git(dir, ["remote", "get-url", "upstream"]);
  const repos = up === null ? [] : [githubRepo(up)].filter((x): x is string => x !== null);
  if (!repos.includes(pushed)) repos.push(pushed);
  return { head, repos, owner: pushed.split("/")[0] ?? "" };
}

async function ghPrs(repo: string, head: string): Promise<unknown> {
  let out;
  try {
    out = await outputWithin(["gh", "pr", "list", "--repo", repo, "--head", head, "--state", "all", "--limit", "20", "--json", "number,state,isDraft,url,title,headRefName,headRepositoryOwner,headRefOid"], GH_TIMEOUT_MS, {
      env: { ...process.env, PATH: childPath(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
    throw new Error(code === "ENOENT" ? "gh isn't installed" : `gh: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code !== 0) throw new Error(out.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "gh failed");
  const v = parse(out.stdout);
  if (v === undefined) throw new Error("gh: not JSON");
  return v;
}

/** The PR of `head` from gh's list: pushed by `owner` (a fork's PR of the same branch name is someone else's), an open one first, else the newest. */
export function pick(list: unknown, head: string, owner: string, branch: string): ChatPr | null {
  if (!Array.isArray(list)) return null;
  const rows = list.filter((p) => {
    const h = optStr(at(p, "headRefName"));
    const o = optStr(at(p, "headRepositoryOwner", "login"));
    return (h === undefined || h === head) && (o === undefined || o.toLowerCase() === owner.toLowerCase());
  });
  const p = rows.find((x) => at(x, "state") === "OPEN") ?? rows[0];
  const st = optStr(at(p, "state"));
  const number = u64(at(p, "number"));
  const url = optStr(at(p, "url"));
  if (st === undefined || number === undefined || url === undefined) return null;
  const state: PrState = st === "MERGED" ? "merged" : st === "CLOSED" ? "closed" : bool(at(p, "isDraft")) === true ? "draft" : "open";
  const oid = optStr(at(p, "headRefOid")) ?? "";
  return { number, state, url, title: optStr(at(p, "title")) ?? "", branch, ...(oid !== "" ? { head: oid } : {}) };
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The PR of the branch checked out in `dir`; once `dir` is gone, of `last`'s branch in `repo`. Null: none; a rejection: gh couldn't say. */
export async function lookup(dir: string, repo: string, last: ChatPr | null): Promise<ChatPr | null> {
  const here = isDir(dir);
  const d = here ? dir : repo;
  const branch = here ? ((await worktreeHead(dir))?.branch ?? "") : (last?.branch ?? "");
  if (branch === "") return null;
  const w = await place(d, branch, last?.branch === branch);
  if (!w) return null;
  for (const r of w.repos) {
    const p = pick(await ghPrs(r, w.head), w.head, w.owner, branch);
    if (p) return p;
  }
  return null;
}

/** The chat whose folder (and so branch) a chat works in: a sub-agent's lead. */
export function leadOf(c: Chat): number {
  return c.role === "sub" ? (c.parent ?? c.id) : c.id;
}

/** What the app asks of the chats it knows: where each works, and that a row changed. */
export interface PrHost {
  store: Store;
  chats(): readonly Chat[];
  chat(id: number): Chat | undefined;
  /** The chat's project folder on this PC, and its worktree if it has one. */
  folders(c: Chat): { repo: string; dir: string } | null;
  changed(chatId: number): void;
  /** A lookup found the chat's PR merged (each time it does, changed or not): its worktree may be cleaned up (worktreeclean.ts). */
  merged?(lead: number, pr: ChatPr): void;
}

/** The PRs found, and when each was last looked up. */
export class ChatPrs {
  readonly found = new Map<number, ChatPr>();
  private readonly checked = new Map<number, [number, boolean]>();
  private readonly busy = new Set<number>();
  private readonly again = new Set<number>();
  private swept: number | null = null;
  private todo: number[] | null = null;
  /** After stop() nothing new starts and lookups still out land nowhere: the store may be closed by then. */
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly host: PrHost) {
    const v = parse(host.store.get("chat_prs") ?? "");
    for (const [k, p] of Object.entries((v ?? {}) as Record<string, unknown>)) {
      const pr = prFrom(p);
      if (pr && /^-?\d+$/.test(k)) this.found.set(Number(k), pr);
    }
  }

  /** A chat's PR as last found (another PC's chat: its home PC's answer, from net). */
  of(c: Chat): ChatPr | null {
    return this.found.get(leadOf(c)) ?? null;
  }

  /** Harbor stops: lookups still out (git, gh) are dropped when they land, and nothing new starts. */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves when every lookup started so far has landed (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Looks a chat's PR up again when it was last looked up longer than `ttlMs` ago (null: now, after a turn). */
  want(chat: number, ttlMs: number | null): void {
    if (this.stopped) return;
    const c = this.host.chat(chat);
    if (!c) return;
    const lead = leadOf(c);
    if (this.busy.has(lead)) {
      if (ttlMs === null) this.again.add(lead);
      return;
    }
    const seen = this.checked.get(lead);
    if (ttlMs !== null && seen && Date.now() - seen[0] < (seen[1] ? Math.max(ttlMs, FAILED_TTL_MS) : ttlMs)) return;
    this.checked.set(lead, [Date.now(), false]);
    const lc = this.host.chat(lead);
    if (!lc || lc.home !== "" || lc.device !== "") return;
    const f = this.host.folders(lc);
    if (!f || !existsSync(join(f.repo, ".git"))) return;
    this.busy.add(lead);
    const p = lookup(f.dir, f.repo, this.found.get(lead) ?? null)
      .then(
        (pr) => this.landed(lead, pr, false),
        () => this.landed(lead, null, true),
      )
      .catch((e: unknown) => console.error(`harbor: pull request lookup: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private landed(lead: number, pr: ChatPr | null, failed: boolean): void {
    this.busy.delete(lead);
    if (this.stopped) return;
    if (failed) this.checked.set(lead, [Date.now(), true]);
    else if (JSON.stringify(this.found.get(lead) ?? null) !== JSON.stringify(pr)) {
      if (pr) this.found.set(lead, pr);
      else this.found.delete(lead);
      // Chats deleted since are left out.
      const ids = new Set(this.host.chats().map((c) => c.id));
      for (const id of [...this.found.keys()]) if (!ids.has(id)) this.found.delete(id);
      this.save();
      this.host.changed(lead);
    }
    if (!failed && pr?.state === "merged") this.host.merged?.(lead, pr);
    if (this.again.delete(lead)) this.want(lead, null);
  }

  /** Looks a chat's PR up now and waits for it (Clean up merged worktrees): what was found, else the last one known. */
  async now(chat: number): Promise<ChatPr | null> {
    const c = this.host.chat(chat);
    if (!c) return null;
    const lead = leadOf(c);
    const lc = this.host.chat(lead);
    if (!lc || lc.home !== "" || lc.device !== "") return null;
    const f = this.host.folders(lc);
    if (!f || !existsSync(join(f.repo, ".git"))) return null;
    this.checked.set(lead, [Date.now(), false]);
    try {
      const pr = await lookup(f.dir, f.repo, this.found.get(lead) ?? null);
      if (this.stopped) return pr;
      if (JSON.stringify(this.found.get(lead) ?? null) !== JSON.stringify(pr)) {
        if (pr) this.found.set(lead, pr);
        else this.found.delete(lead);
        this.save();
        this.host.changed(lead);
      }
      return pr;
    } catch {
      this.checked.set(lead, [Date.now(), true]);
      return this.found.get(lead) ?? null;
    }
  }

  /** kv `chat_prs` as serde writes the map: chat id → the PR's fields in order. */
  private save(): void {
    const o: Record<string, unknown> = {};
    for (const [k, p] of this.found) o[String(k)] = { number: p.number, state: p.state, url: p.url, title: p.title, branch: p.branch, ...(p.head !== undefined ? { head: p.head } : {}) };
    this.host.store.set("chat_prs", JSON.stringify(o));
  }

  /** Now and then: open and draft PRs nobody looked at for a while, then unsettled chats in worktrees not looked up since the start, newest first. */
  sweep(inWorktree: (c: Chat) => boolean): void {
    if (this.stopped) return;
    if (this.swept !== null && Date.now() - this.swept < SWEEP_EVERY_MS) return;
    this.swept = Date.now();
    const due: number[] = [];
    for (const [id, p] of this.found) {
      if (due.length >= SWEEP_MAX) break;
      const seen = this.checked.get(id);
      if ((p.state === "open" || p.state === "draft") && (!seen || Date.now() - seen[0] >= SWEEP_TTL_MS)) due.push(id);
    }
    this.todo ??= this.host
      .chats()
      .filter((c) => c.role !== "sub" && !c.settled && c.home === "" && c.device === "" && inWorktree(c))
      .sort((a, b) => a.updated - b.updated)
      .map((c) => c.id);
    while (due.length < SWEEP_MAX) {
      const id = this.todo.pop();
      if (id === undefined) break;
      if (!this.checked.has(id)) due.push(id);
    }
    for (const id of due) this.want(id, SWEEP_TTL_MS);
  }
}

