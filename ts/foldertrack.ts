// Moving or renaming a folder never breaks Harbor: the folders it works in (projects, worktrees,
// the folders of chats without a project, the Projects folder) are followed by what they are
// (foldermove.ts `Ident`, kv `folder_id:<path>`), and one that's gone from its path is looked for
// (by its inode or its `.git` id, below the places it could have gone) and re-homed: the project
// keeps its row, its chats their place, Claude its sessions, Git its worktree links. Gone means
// deleted or in the Trash. Looked at every few seconds (a stat per folder), when a watched parent
// folder changes, and when a chat's turn is about to start in a folder that isn't there.
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { folders, platform } from "./packages/os/src/index.ts";
import { type Chat, projectsdir, repoDir, type Store } from "./packages/store/src/index.ts";
import { type Engine, foldermove as fm, worktree as wt } from "./packages/agents/src/index.ts";
import { workspace } from "./packages/mcp/src/index.ts";

export const KEY = "folder_id:";
/** follow-main's checkout (followmain.ts CHECKOUT_KEY): a path that moves with its folder. */
const PATH_VALUES = ["follow_main_checkout", projectsdir.KEY];
/** kv keys named after a folder: renamed with it. */
const PATH_KEYS = ["untrusted:", KEY];
/** kv keys whose values are folders, one per chat. */
const PATH_PREFIXES = ["worktree:", "chat_dir:"];

const CHECK_MS = 10_000;
/** A folder looked for and not found isn't looked for again before this, unless something changes. */
const RETRY_MS = 10 * 60_000;
const MAX_WATCHES = 64;
const REREAD_MS = 60 * 60_000;

type Kind = "project" | "worktree" | "chats" | "projects";

interface Followed {
  path: string;
  kind: Kind;
}

export interface Moved {
  from: string;
  to: string;
  kind: Kind;
}

export interface FolderTrackHost {
  store: Store;
  engine: () => Engine;
  /** Repaint, tell phones. */
  touch: () => void;
  home: string;
  /** Claude's config folders (null: ~/.claude): their sessions are kept by folder. */
  configs: () => (string | null)[];
  limits?: fm.Limits;
  /** Runs git (tests pass their own). */
  git?: (dir: string, args: string[]) => Promise<void>;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function runGit(dir: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim() || `git ${args.join(" ")} failed`);
}

export class FolderTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watches = new Map<string, FSWatcher>();
  private running: Promise<Moved[]> | null = null;
  private again = false;
  /** Folders looked for and not found: when. */
  private missed = new Map<string, number>();
  /** Folders that went to the Trash. */
  private binned = new Set<string>();
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly h: FolderTrackHost) {}

  private get e(): Engine {
    return this.h.engine();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref?.();
    this.later(3000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.soon !== null) clearTimeout(this.soon);
    for (const w of this.watches.values()) w.close();
    this.watches.clear();
  }

  private later(ms: number): void {
    if (this.soon !== null) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.check();
    }, ms);
    this.soon.unref?.();
  }

  /** Every folder Harbor works in on this PC, outermost first. */
  followed(): Followed[] {
    const s = this.h.store;
    const out = new Map<string, Kind>();
    const chosen = projectsdir.chosen(s, this.h.home);
    if (chosen !== null) out.set(chosen, "projects");
    for (const r of s.repos()) out.set(repoDir(r), "project");
    // Full paths only (C:\… on Windows too).
    for (const [, v] of s.withPrefix("worktree:")) if (isAbsolute(v)) out.set(v, "worktree");
    for (const [, v] of s.withPrefix("chat_dir:")) if (isAbsolute(v) && !out.has(v)) out.set(v, "chats");
    return [...out].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.length - b.path.length);
  }

  private ident(path: string): fm.Ident | null {
    const v = this.h.store.get(KEY + path);
    if (v === null || v === "") return null;
    try {
      return JSON.parse(v) as fm.Ident;
    } catch {
      return null;
    }
  }

  /** The line a chat's turn shows when its folder went to the Trash; null otherwise. */
  goneLine(c: Chat): string | null {
    const dir = this.e.chatCwd(c);
    if (isDir(dir)) return null;
    for (const b of this.binned) {
      if (!fm.under(dir, b)) continue;
      const what = b === dir ? wt.tilde(dir) : `${wt.tilde(b)}, which held ${wt.tilde(dir)},`;
      return `${what} is in the Trash. Restore it and send again: Harbor finds it wherever it goes back to.`;
    }
    return null;
  }

  /**
   * A turn about to start in a folder that isn't there: when Harbor knew that folder, it's looked
   * for first and the turn starts after (in its new place, or with the usual error). True: held.
   */
  hold(c: Chat, prompt: string, files: readonly string[]): boolean {
    const dir = this.e.chatCwd(c);
    if (isDir(dir)) return false;
    const known = this.followed().some((f) => fm.under(dir, f.path) && this.ident(f.path) !== null);
    if (!known || this.missedLately(dir)) return false;
    void this.check(true).then(
      () => this.e.startTurn(c.id, prompt, [...files]),
      () => this.e.startTurn(c.id, prompt, [...files]),
    );
    return true;
  }

  private missedLately(dir: string): boolean {
    for (const [p, at] of this.missed) if (fm.under(dir, p) && Date.now() - at < RETRY_MS) return true;
    return false;
  }

  /** Looks at every followed folder: records the ones there, looks for the ones gone. Resolves with what moved. */
  check(force = false): Promise<Moved[]> {
    if (this.running !== null) {
      if (force) this.again = true;
      return this.running;
    }
    this.running = this.pass(force)
      .catch((x) => {
        console.error(`harbor: following moved folders: ${say(x)}`);
        return [] as Moved[];
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          void this.check(true);
        }
      });
    return this.running;
  }

  private async pass(force: boolean): Promise<Moved[]> {
    const s = this.h.store;
    const gone = new Map<string, fm.Ident>();
    const kinds = new Map<string, Kind>();
    for (const f of this.followed()) {
      kinds.set(f.path, f.kind);
      const was = this.ident(f.path);
      // One seen here before is looked at for real (a move is noticed at once); one that never was (another PC's
      // project) through the cache, which answers a whole missing parent at once.
      if (was !== null ? isDir(f.path) : folders.here(f.path)) {
        this.missed.delete(f.path);
        this.binned.delete(f.path);
        // Cheap while it's the same folder: a stat; what's in it is read again hourly (a plain folder is matched by some of its names).
        if (was !== null && Date.now() - (was.at ?? 0) < REREAD_MS && fm.sameInode(was, f.path)) continue;
        const now = fm.identOf(f.path, f.kind === "project");
        if (now !== null) s.set(KEY + f.path, JSON.stringify({ ...now, at: Date.now() }));
        continue;
      }
      // Gone with a folder it was in: that one is looked for.
      if (was === null || [...gone.keys()].some((g) => fm.under(f.path, g))) continue;
      if (!force && this.missedLately(f.path)) continue;
      gone.set(f.path, was);
    }
    this.watchParents();
    if (gone.size === 0) return [];
    const moved = await fm.locate(gone, this.roots([...gone.keys()]), this.h.limits ?? fm.LIMITS);
    const at = Date.now();
    for (const p of gone.keys()) {
      if (moved.has(p)) continue;
      this.missed.set(p, at);
      if (fm.trashed(p, this.h.home)) {
        if (!this.binned.has(p)) console.error(`harbor: ${p} is in the Trash`);
        this.binned.add(p);
      } else if (kinds.get(p) === "chats") {
        // A chats folder that's really gone is made again by the next turn (engine.ts pinNoProjectDir).
        s.del(KEY + p);
      }
    }
    if (moved.size === 0) return [];
    const done: Moved[] = [];
    for (const [from, to] of [...moved].sort((a, b) => a[0].length - b[0].length)) {
      // Moved along with a folder it was in, re-homed just before.
      if (done.some((d) => fm.under(from, d.from))) continue;
      if (!isDir(to)) continue;
      done.push({ from, to, kind: kinds.get(from) ?? "project" });
    }
    for (const m of done) this.rehome(m);
    await this.repair(done);
    this.afterMoves(done);
    return done;
  }

  /** Where a gone folder could be, nearest first: next to where it was, the Projects folder, Documents, the parents of every project, the home folder. */
  private roots(gone: readonly string[]): string[] {
    const h = this.h.home;
    const out: string[] = [];
    const add = (p: string | null): void => {
      if (p !== null && p !== "" && !out.includes(p) && isDir(p)) out.push(p);
    };
    for (const g of gone) {
      let p = dirname(g);
      while (p !== dirname(p) && !isDir(p)) p = dirname(p);
      // The home folder (or above) is looked in last, as a whole.
      if (fm.under(h, p)) continue;
      add(p);
    }
    add(projectsdir.chosen(this.h.store, h));
    add(join(h, "Projects"));
    add(join(h, "Documents"));
    for (const r of this.h.store.repos()) {
      const d = dirname(repoDir(r));
      if (d !== h && fm.under(d, h)) add(d);
    }
    add(h);
    return out;
  }

  /** Parents of the followed folders, watched: a rename there is looked at within a second. */
  private watchParents(): void {
    // Windows: a folder being watched can't be renamed or moved (Explorer says it's open in another program),
    // and every Projects folder is a watched parent: there the timer alone looks.
    if (platform() === "win32") return;
    const want = new Set<string>();
    for (const f of this.followed()) {
      const p = dirname(f.path);
      if (want.size < MAX_WATCHES && !want.has(p) && folders.here(p)) want.add(p);
    }
    for (const [p, w] of this.watches) {
      if (want.has(p)) continue;
      w.close();
      this.watches.delete(p);
    }
    for (const p of want) {
      if (this.watches.has(p)) continue;
      try {
        const w = watch(p, { persistent: false }, (ev) => {
          if (ev === "rename") this.later(800);
        });
        w.on("error", () => {
          w.close();
          this.watches.delete(p);
        });
        this.watches.set(p, w);
      } catch {
        // not watchable: the timer still looks
      }
    }
  }

  /** Every record of `from` (and what was in it) now says `to`. */
  private rehome(m: Moved): void {
    const s = this.h.store;
    const f = (p: string): string => fm.rewrite(p, m.from, m.to);
    for (const r of s.repos()) {
      if (r.local !== null) {
        if (fm.under(r.local, m.from)) s.setRepoLocal(r.id, f(r.local) === r.path ? null : f(r.local));
      } else if (fm.under(r.path, m.from)) {
        if (!s.setRepoPath(r.id, f(r.path))) {
          console.error(`harbor: ${r.name} moved to ${f(r.path)}, which is another project's folder already`);
          continue;
        }
        // Other PCs know the project by its path: they're told the old ones (meshstore.ts `was`).
        let was: string[] = [];
        try {
          was = JSON.parse(s.get(`path_was:${r.id}`) ?? "[]") as string[];
        } catch {
          // none kept
        }
        s.set(`path_was:${r.id}`, JSON.stringify([r.path, ...was.filter((x) => x !== r.path && x !== f(r.path))].slice(0, 8)));
      }
    }
    for (const pre of PATH_PREFIXES) for (const [k, v] of s.withPrefix(pre)) if (fm.under(v, m.from)) s.set(k, f(v));
    for (const k of PATH_VALUES) {
      const v = s.get(k);
      if (v !== null && v !== "" && fm.under(v, m.from)) s.set(k, f(v));
    }
    for (const pre of PATH_KEYS) {
      for (const [k, v] of s.withPrefix(pre)) {
        const p = k.slice(pre.length);
        if (!fm.under(p, m.from)) continue;
        s.del(k);
        s.set(pre + f(p), v);
      }
    }
    for (const [p, at] of [...this.missed]) if (fm.under(p, m.from)) this.missed.delete(p), this.missed.set(f(p), at);
  }

  /** Git's links between checkouts and worktrees, made right again after their folders moved. */
  private async repair(moves: readonly Moved[]): Promise<void> {
    const git = this.h.git ?? runGit;
    const back = (p: string): string => moves.reduce((x, m) => fm.rewrite(x, m.from, m.to), p);
    const mains = new Map<string, Set<string>>();
    // Every worktree Harbor knows: its main checkout from its `.git` file (moved along when the checkout moved).
    for (const [, w] of this.h.store.withPrefix("worktree:")) {
      if (!isDir(w)) continue;
      const admin = fm.gitdirOf(w);
      if (admin === null) continue;
      const main = fm.mainOf(back(admin));
      const touched = moves.some((m) => fm.under(w, m.to) || fm.under(admin, m.from));
      if (main === null || !touched || !isDir(main)) continue;
      const set = mains.get(main) ?? new Set<string>();
      set.add(w);
      mains.set(main, set);
    }
    // A checkout that moved: the worktrees it knows of find it again.
    for (const m of moves) for (const r of this.h.store.repos()) if (fm.under(repoDir(r), m.to) && existsSync(join(repoDir(r), ".git"))) mains.set(repoDir(r), mains.get(repoDir(r)) ?? new Set());
    for (const [main, wts] of mains) {
      try {
        await git(main, ["worktree", "repair", ...wts]);
      } catch (x) {
        console.error(`harbor: git worktree repair in ${main}: ${say(x)}`);
      }
    }
  }

  /** Chats told, sessions brought, Harbor's lists read again. */
  private afterMoves(moves: readonly Moved[]): void {
    const e = this.e;
    e.reload();
    const configs = this.h.configs();
    for (const m of moves) {
      fm.copySessions(configs, m.from, m.to);
      console.error(`harbor: ${m.from} moved to ${m.to}: followed`);
    }
    const leads = e.chats.filter((c) => c.role !== "sub" && c.home === "" && c.device === "");
    for (const c of leads) {
      const now = e.chatCwd(c);
      const m = moves.find((x) => fm.under(now, x.to));
      if (!m) continue;
      const was = fm.rewrite(now, m.to, m.from);
      // Its own folder's sessions too, when it ran below the folder that moved.
      if (was !== m.from) fm.copySessions(configs, was, now);
      for (const id of [c.id, ...e.subsOf(c.id).map((x) => x.id)]) workspace.forget(id);
      if (!c.started) continue;
      e.noteWorktree(c.id, `this chat's folder moved from ${was} to ${now} (moved outside Harbor): work there now, nothing is left under the old path.`);
      if (c.settled) continue;
      const what = e.worktreeOf(c) !== null ? "Worktree" : c.repoId !== null ? "Project" : "Folder";
      e.notice(c.id, "folder", `${what} moved to ${wt.tilde(now)}`, `Was ${wt.tilde(was)}. Harbor follows a folder that's moved or renamed: its chats, sessions and worktrees go on there.`);
    }
    this.h.touch();
  }
}
