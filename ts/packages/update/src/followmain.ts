// Follow main: every installed Harbor runs Harbor's main branch, not only its releases, seconds after a
// push. On by default; `harbor follow-main off` turns it off (kv `follow_main_off`). (0.166's opt-in kv
// `follow_main` is no longer read: everyone starts on.)
//
// - Which main: Harbor's public repository's (`REMOTE`, over HTTPS only, the PC's git config left out),
//   or a local checkout's when that one is ahead of it (commits not pushed yet). The checkout: kv
//   `follow_main_checkout`, else the project whose origin is Harbor's repository; its main is the newer
//   of `main` and `origin/main` (agents push with `git push origin HEAD:main`, which moves only
//   `origin/main`). A PC without a checkout keeps a partial clone (`--filter=blob:none`: commits and
//   trees, blobs only as a build needs them) in the data folder.
// - Only forward from what runs: a commit of the public main is built only when it descends from the
//   running build's commit, so a force-push that rewrote main builds nothing; releases still install.
// - When: every PC holds a long poll on the account worker (`/v1/main/wait`), answered when main moves:
//   the look starts about a second after the push. The worker hears of a push from the PC that made it
//   (its checkout's `origin/main` moved: `POST /v1/main` with its Harbor token, which the worker checks
//   against GitHub before telling anyone), and from GitHub's webhook (the backup: GitHub sometimes
//   delivers it half a minute late). Checkout refs are watched too (3 s after the last write), and
//   `git ls-remote` looks every 3 minutes anyway.
// - What: only a commit that changes what the app bundle is built from (`shipsInApp`: ts/ sources,
//   package.json, bun.lock, assets/; not tests, docs, rigs or scripts) is built. A commit that would need
//   a new runtime (lane.ts says "runtime", counted from the runtime this PC has) is skipped and says why.
// - How: in Harbor's own clone under the data folder (`follow-main/src`), never the checkout's working
//   tree, at nice 19 and idle disk priority, with Harbor's own runtime as Bun (`BUN_BE_BUN=1`, the
//   pinned Bun whatever the PC has): `bun install --frozen-lockfile`, `tsc --noEmit`, scripts/build.ts
//   app, then the bundle must load in this PC's runtime (the installer's own `smoke-bundle` check).
// - Then it's installed as a release is (install.ts: `.previous` keeps what ran, VERSION last), so the
//   app restarts into it the way it does for a release (run.ts watches VERSION) and the start watchdog
//   rolls it back if it doesn't come up. Its version is the source's plus the commit: `0.165.1+abc1234`.
// - A failed build isn't tried again until main moves. A build that was rolled back (its start failed,
//   or it crashed `CRASH_LIMIT` times within its first minutes: health.ts) isn't either.
// - Releases (delivery.ts `keep`): a newer release whose tag is already in the running build of main is
//   ignored; any other newer release installs as usual, and main is followed again from there (a build
//   is made only when main isn't already in what runs, and never older than a running release).
// - Run health per commit (health.ts) is what `ts/scripts/soaked.ts` releases from (`status` shows the
//   last build's push-to-running time).
import { appendFileSync, closeSync, copyFileSync, openSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { alive, BUNDLE_FILE, ensureDir, exists, fresh, isFile, read, readJson, remove, replace, RUNTIME_FILE, writeAtomic } from "./files.ts";
import { bootId, begin, beat, BEAT_MS, CRASH_LIMIT, earlyCrashes, end, readHealth, recordChecks, recordCrash } from "./health.ts";
import { current, hasPrevious, onDisk, PREVIOUS, rollback, rolledBack, runtimeOnDisk, smokeBundle, SKIP } from "./install.ts";
import { lane } from "./lane.ts";
import { buildOf, GIT_COMMIT, newer, parse } from "./version.ts";

/** "1": turned off with `harbor follow-main off`. Unset (the default) or anything else: on. */
export const KEY = "follow_main_off";
export const CHECKOUT_KEY = "follow_main_checkout";
export const DIR = "follow-main";
export const SOON_MS = 3_000;
export const POLL_MS = 5 * 60_000;
/** The first look waits until this start has shown it stays up: a build about to be rolled back builds nothing. */
export const FIRST_MS = 40_000;
/** With push news waiting, the first look comes this soon after start (the start watchdog settles in ~2 s). */
export const FIRST_NEWS_MS = 10_000;
const TOGGLE_MS = 10_000;
const WAIT_MS = 30_000;
const GIT_MS = 60_000;
const INSTALL_MS = 5 * 60_000;
const TSC_MS = 5 * 60_000;
const BUILD_MS = 5 * 60_000;
const REPO_RE = /github\.com[:/]+RDevNeo\/harbor(\.git)?\/?$/i;
/** Harbor's public repository: the only main followed without a checkout (rigs pass their own). */
export const REMOTE = "https://github.com/RDevNeo/harbor.git";
/** Without a checkout's refs to watch, `git ls-remote` this often besides the push news. */
export const REMOTE_POLL_MS = 3 * 60_000;
const NEWS_TIMEOUT_MS = 75_000;
const NEWS_BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000];
const LS_MS = 30_000;
/** After a ref write, before reading `origin/main` (a push writes the lock, then renames it). */
const NUDGE_SOON_MS = 100;

export type FollowState = "off" | "idle" | "building" | "checking" | "waiting" | "swapping" | "failed" | "skipped";

export interface FollowStatus {
  state: FollowState;
  checkout: string;
  /** The commit this is about (main's, or the one built). */
  commit: string;
  subject: string;
  version: string;
  reason: string;
  at: number;
  /** The last build that went live here: commit time → noticed → built → running, in ms. */
  last?: Timeline;
}

export interface Timeline {
  commit: string;
  version: string;
  committedAt: number;
  noticedAt: number;
  builtAt: number;
  liveAt: number;
  /** When the account worker heard of the push (GitHub's webhook), if the build came from that news. */
  pushedAt?: number;
}

interface Memory {
  failed: { commit: string; why: string } | null;
  crashed: { commit: string; version: string; why: string }[];
  /** The build installed and not yet seen running. */
  pending: Omit<Timeline, "liveAt"> | null;
  /** rolled-back.json's `at` already taken in. */
  seenRollback: number;
}

export interface Kv {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

export interface RunResult {
  code: number;
  out: string;
}

export type Runner = (cmd: string[], o: { cwd: string; env?: Record<string, string>; timeoutMs: number; log?: string; nice?: boolean }) => Promise<RunResult>;

export interface FollowDeps {
  cfg: UpdateConfig;
  kv: Kv;
  /** Harbor's data folder: the clone, the builds, health.json and status.json go in `follow-main/`. */
  dataDir: string;
  repos: () => { path: string; remote: string; local: string | null }[];
  /** The updater is installing a release: nothing is installed beside it. */
  busy: () => boolean;
  /** Extra build environment (the running build's Google clients, so a build of main keeps them). */
  buildEnv?: () => Record<string, string>;
  /** The running build's commit (version.ts `GIT_COMMIT`). */
  commit?: string | null;
  /**
   * The repository whose main is followed besides (or without) a checkout: `REMOTE` in an installed
   * copy; null (the default) for none, checkouts only (tests, offline rigs).
   */
  remote?: string | null;
  /** This PC's Harbor token (account.ts), to tell the worker of its own pushes to main; null when signed out. */
  token?: () => string | null;
  run?: Runner;
  watchRefs?: (gitDir: string, onChange: () => void) => () => void;
  changed?: () => void;
  pid?: number;
  boot?: string;
}

/** What the app bundle is built from: a change elsewhere (tests, docs, rigs, the other apps) builds nothing. */
export function shipsInApp(path: string): boolean {
  // build.ts, and the engine checksums the bundle embeds (discordsetup.ts, whatsappsetup.ts).
  if (path === "ts/scripts/build.ts" || path === "discord/SHA256SUMS" || path === "whatsapp/SHA256SUMS") return true;
  if (!path.startsWith("ts/") && !path.startsWith("assets/")) return false;
  if (/(^|\/)test\//.test(path) || /\.test\.ts$/.test(path) || /\.md$/i.test(path)) return false;
  return !/^ts\/(rig|scripts|proto)\//.test(path) && !/^ts\/parity/.test(path) && path !== "ts/run.sh";
}

/** `0.165.1+abc1234`: the release the source says, then the commit. */
export const localVersion = (pkgVersion: string, commit: string): string => `${pkgVersion}+${commit.slice(0, 7)}`;

export const isHarborRemote = (url: string): boolean => REPO_RE.test(url.trim());

export function findCheckout(kv: Kv, repos: FollowDeps["repos"]): string | null {
  const set = kv.get(CHECKOUT_KEY)?.trim();
  if (set) return set;
  for (const r of repos()) if (isHarborRemote(r.remote) && isFile(join(r.local ?? r.path, ".git", "HEAD"))) return r.local ?? r.path;
  // A worktree's .git is a file. Never another PC's project: its path isn't a folder here (on macOS a /home path is
  // the automounter's, and each look at it took milliseconds, hundreds of times at the start).
  for (const r of repos()) if (isHarborRemote(r.remote) && exists(join(r.local ?? r.path, ".git"))) return r.local ?? r.path;
  return null;
}

export const enabled = (kv: Kv): boolean => kv.get(KEY) !== "1";

export const setEnabled = (kv: Kv, on: boolean): void => kv.set(KEY, on ? "0" : "1");

const nice = (cmd: string[]): string[] => (Bun.which("ionice") ? ["nice", "-n", "19", "ionice", "-c3", ...cmd] : ["nice", "-n", "19", ...cmd]);

export const defaultRunner: Runner = async (cmd, o) => {
  const fd = o.log === undefined ? null : openSync(o.log, "a");
  try {
    const p = Bun.spawn(o.nice ? nice(cmd) : cmd, { cwd: o.cwd, env: o.env ?? (process.env as Record<string, string>), stdin: "ignore", stdout: fd ?? "pipe", stderr: fd ?? "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs);
    const out = fd === null ? await new Response(p.stdout as ReadableStream).text() : "";
    const code = await p.exited;
    clearTimeout(timer);
    return { code: p.signalCode === "SIGKILL" ? 124 : code, out: out.trim() };
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

/** Watches main's refs (local and origin's, loose and packed) in a repository's common git folder. */
export function watchMainRefs(common: string, onChange: () => void): () => void {
  const ws: FSWatcher[] = [];
  const on = (dir: string, match: RegExp): void => {
    try {
      const w = watch(dir, (_e, f) => {
        if (f === null || match.test(String(f))) onChange();
      });
      w.on("error", () => w.close());
      ws.push(w);
    } catch {
      // not there: the 5-minute look still finds the change
    }
  };
  on(join(common, "refs", "heads"), /^main(\.lock)?$/);
  on(join(common, "refs", "remotes", "origin"), /^main(\.lock)?$/);
  on(common, /^packed-refs$/);
  return () => {
    for (const w of ws) w.close();
  };
}

/**
 * Installs a bundle built here as install.ts installs a release's: what runs is kept in `.previous` (the
 * start watchdog and `rollback` go back to it), VERSION is written last.
 */
export function installLocal(cfg: UpdateConfig, bundle: string, version: string): void {
  if (cfg.dir === null) throw new Error("not an installed copy");
  const dir = cfg.dir;
  const prev = fresh(join(dir, PREVIOUS));
  writeAtomic(join(prev, "VERSION"), current(cfg));
  writeAtomic(join(prev, "RUNTIME"), runtimeOnDisk(cfg));
  const manifest = read(join(dir, "manifest.json"));
  if (manifest !== "") writeAtomic(join(prev, "manifest.json"), manifest);
  const staged = join(dir, ".staging-local.js");
  copyFileSync(bundle, staged);
  replace(staged, join(dir, BUNDLE_FILE), prev);
  remove(join(dir, SKIP));
  writeAtomic(join(dir, "VERSION"), version);
}

export class FollowMain {
  private st: FollowStatus;
  private readonly home: string;
  private readonly run: Runner;
  private toggleTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private soonTimer: Timer | null = null;
  private beatTimer: Timer | null = null;
  private unwatch: (() => void) | null = null;
  private armed = false;
  private job: Promise<void> | null = null;
  private again = false;
  private exitHooked = false;
  private readonly commit: string | null;
  private readonly pid: number;
  private readonly remote: string | null;
  private news: AbortController | null = null;
  /** The public main the worker last told of, when, and when the worker heard the push. */
  private heard: { sha: string; at: number; pushedAt: number } | null = null;
  /** The first look has run (news before it waits for it: a start about to be rolled back builds nothing). */
  private looked = false;
  private armedAt = 0;
  private warmed = false;
  private nudgeTimer: Timer | null = null;
  /** The last `origin/main` this PC told the worker of. */
  private nudged: string | null = null;

  constructor(private readonly d: FollowDeps) {
    this.home = join(d.dataDir, DIR);
    this.run = d.run ?? defaultRunner;
    this.commit = d.commit === undefined ? GIT_COMMIT : d.commit;
    this.pid = d.pid ?? process.pid;
    this.remote = d.remote ?? null;
    this.st = readJson<FollowStatus>(join(this.home, "status.json")) ?? { state: "off", checkout: "", commit: "", subject: "", version: "", reason: "", at: 0 };
  }

  private get cfg(): UpdateConfig {
    return this.d.cfg;
  }

  status(): FollowStatus {
    return this.st;
  }

  /** Following: not turned off, and there's a main to follow (the public repository's, or a checkout's). */
  on(): boolean {
    return enabled(this.d.kv) && (this.remote !== null || this.checkout() !== null);
  }

  /** What `status` names as followed: the checkout, else the public repository. */
  private source(checkout: string | null): string {
    return checkout ?? (this.remote === null ? "" : this.remote.replace(/^https:\/\//, "").replace(/\.git$/, ""));
  }

  /** Usable here: an installed copy, not running a preview. */
  possible(): boolean {
    return this.cfg.dir !== null && !this.cfg.preview;
  }

  checkout(): string | null {
    return findCheckout(this.d.kv, this.d.repos);
  }

  setOn(on: boolean): void {
    setEnabled(this.d.kv, on);
    this.sync();
  }

  private set(s: Partial<FollowStatus> & Pick<FollowStatus, "state">): void {
    this.st = { checkout: this.st.checkout, commit: "", subject: "", version: "", reason: "", ...(this.st.last ? { last: this.st.last } : {}), ...s, at: this.cfg.now() };
    try {
      ensureDir(this.home);
      writeAtomic(join(this.home, "status.json"), JSON.stringify(this.st));
    } catch {
      // the status file is for the CLI; the window asks this object
    }
    this.d.changed?.();
  }

  private memory(): Memory {
    const m = readJson<Partial<Memory>>(join(this.home, "state.json"));
    return { failed: m?.failed ?? null, crashed: Array.isArray(m?.crashed) ? m.crashed : [], pending: m?.pending ?? null, seenRollback: m?.seenRollback ?? 0 };
  }

  private remember(change: (m: Memory) => void): void {
    const m = this.memory();
    change(m);
    m.crashed = m.crashed.slice(-50);
    ensureDir(this.home);
    writeAtomic(join(this.home, "state.json"), JSON.stringify(m));
  }

  start(): void {
    if (!this.possible() || this.toggleTimer !== null) return;
    this.toggleTimer = setInterval(() => this.sync(), TOGGLE_MS);
    this.toggleTimer.unref?.();
    this.sync();
  }

  /** Harbor stops on purpose (a quit, a restart into an update): this run ended well. */
  stop(): void {
    if (this.toggleTimer !== null) clearInterval(this.toggleTimer);
    this.toggleTimer = null;
    if (this.armed && this.commit !== null) end(this.home, this.commit, this.pid, 0, this.cfg.now());
    this.disarm();
  }

  /** The status line: the state, and how long the last build took to go live. */
  line(): string {
    const t = this.on() && this.st.state === "idle" && this.st.last?.commit === this.commit ? ` ${timelineText(this.st.last)}` : "";
    return statusLine(this.st, this.on()) + t;
  }

  /** Follows the setting: turned on, starts watching; turned off, stops. */
  sync(): void {
    if (!this.possible()) return;
    if (this.on() && !this.armed) this.arm();
    else if (!this.on() && this.armed) {
      this.disarm();
      this.set({ state: "off" });
    }
  }

  private arm(): void {
    this.armed = true;
    this.armedAt = this.cfg.now();
    this.startHealth();
    this.afterStart();
    const checkout = this.checkout();
    if (checkout !== null) {
      const common = this.commonDir(checkout);
      if (common !== null)
        this.unwatch = (this.d.watchRefs ?? watchMainRefs)(common, () => {
          this.nudgeSoon(checkout);
          this.soon();
        });
    }
    this.pollTimer = setInterval(() => this.poke(), this.remote !== null ? REMOTE_POLL_MS : POLL_MS);
    this.pollTimer.unref?.();
    this.soonTimer = setTimeout(() => this.poke(), FIRST_MS);
    this.soonTimer.unref?.();
    if (this.remote !== null && this.cfg.worker !== null) {
      const news = new AbortController();
      this.news = news;
      void this.newsLoop(news.signal);
    }
    if (this.st.state === "off") this.set({ state: "idle", checkout: this.source(checkout), commit: this.commit ?? "", version: current(this.cfg), reason: "" });
  }

  /**
   * The push news: a long poll on the account worker, answered with main's commit when it isn't `have`
   * (GitHub's webhook tells the worker of every push). Only a reason to look: what's built is what
   * the repository itself says main is.
   */
  private async newsLoop(signal: AbortSignal): Promise<void> {
    let fails = 0;
    while (!signal.aborted) {
      try {
        const url = `${this.cfg.worker}/v1/main/wait?have=${encodeURIComponent(this.heard?.sha ?? "")}`;
        const res = await this.cfg.fetch(url, { headers: { "user-agent": `harbor/${this.cfg.version}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(NEWS_TIMEOUT_MS)]) });
        if (res.status === 204) {
          fails = 0;
          continue;
        }
        if (!res.ok) throw new Error(`main news: HTTP ${res.status}`);
        const body = (await res.json()) as { sha?: unknown; at?: unknown };
        fails = 0;
        const sha = typeof body.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : null;
        if (sha === null || sha === this.heard?.sha) {
          await this.cfg.sleep(NEWS_BACKOFF_MS[0] as number, signal);
          continue;
        }
        const first = this.heard === null;
        this.heard = { sha, at: this.cfg.now(), pushedAt: typeof body.at === "number" ? body.at : 0 };
        // The first answer is only where main is: worth a look when it isn't what runs.
        if (first && sha === this.commit) continue;
        if (this.looked) void this.poke();
        else this.firstLookIn(this.armedAt + FIRST_NEWS_MS - this.cfg.now());
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        await this.cfg.sleep(NEWS_BACKOFF_MS[Math.min(fails++, NEWS_BACKOFF_MS.length - 1)] as number, signal);
      }
    }
  }

  private disarm(): void {
    this.armed = false;
    for (const t of [this.pollTimer, this.beatTimer]) if (t !== null) clearInterval(t);
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer);
    this.pollTimer = this.beatTimer = this.soonTimer = this.nudgeTimer = null;
    this.news?.abort();
    this.news = null;
    this.unwatch?.();
    this.unwatch = null;
  }

  private commonDir(checkout: string): string | null {
    const r = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  }

  /** A ref write in the checkout: if `origin/main` moved (a push from here), the worker hears it now. */
  private nudgeSoon(checkout: string): void {
    if (!this.armed || this.remote === null || this.cfg.worker === null || this.d.token === undefined) return;
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.nudge(checkout);
    }, NUDGE_SOON_MS);
    this.nudgeTimer.unref?.();
  }

  /** Tells the worker main moved (it reads GitHub itself before anyone hears of it). */
  async nudge(checkout: string): Promise<boolean> {
    const token = this.d.token?.() ?? null;
    if (token === null || this.cfg.worker === null || this.remote === null) return false;
    const sha = await this.revParse(checkout, "refs/remotes/origin/main");
    if (sha === null || sha === this.nudged || sha === this.heard?.sha) return false;
    this.nudged = sha;
    try {
      const res = await this.cfg.fetch(`${this.cfg.worker}/v1/main`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": `harbor/${this.cfg.version}` },
        body: JSON.stringify({ sha }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Brings the first look forward (never later than it was). */
  private firstLookIn(ms: number): void {
    if (!this.armed || this.looked) return;
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.poke(), Math.max(0, ms));
    this.soonTimer.unref?.();
  }

  /** Ref writes come in bursts (a merge, then a push's packed-refs): one look 3 s after the last. */
  soon(): void {
    if (!this.armed) return;
    if (this.soonTimer !== null) clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.poke(), SOON_MS);
    this.soonTimer.unref?.();
  }

  /** Looks now (or right after the look going on). */
  poke(): Promise<void> {
    if (!this.armed) return Promise.resolve();
    if (this.job !== null) {
      this.again = true;
      return this.job;
    }
    this.job = (async () => {
      do {
        this.again = false;
        try {
          await this.check();
          await this.warm();
        } catch (e) {
          this.set({ state: "failed", reason: e instanceof Error ? e.message : String(e) });
        }
      } while (this.again && this.armed);
    })().finally(() => {
      this.job = null;
    });
    return this.job;
  }

  // ---- health ----

  private startHealth(): void {
    const commit = this.commit;
    if (commit === null) return;
    const now = this.cfg.now();
    begin(this.home, commit, current(this.cfg), { pid: this.pid, boot: this.d.boot ?? bootId(), alive }, now);
    this.beatTimer = setInterval(() => beat(this.home, commit, this.pid, this.cfg.now()), BEAT_MS);
    this.beatTimer.unref?.();
    if (!this.exitHooked) {
      this.exitHooked = true;
      process.on("exit", (code) => {
        if (this.armed) end(this.home, commit, this.pid, code, this.cfg.now());
      });
    }
  }

  /** At start: what happened to the last build (live, rolled back, crashing), and what to do about it. */
  private afterStart(): void {
    const mem = this.memory();
    const running = current(this.cfg);
    const now = this.cfg.now();
    const rb = rolledBack(this.cfg);
    if (rb !== null && rb.at > mem.seenRollback && buildOf(rb.version) !== null) {
      const commit = mem.pending?.version === rb.version ? mem.pending.commit : (mem.crashed.find((c) => c.version === rb.version)?.commit ?? "");
      this.remember((m) => {
        m.seenRollback = rb.at;
        m.pending = null;
        if (commit !== "" && !m.crashed.some((c) => c.commit === commit)) m.crashed.push({ commit, version: rb.version, why: rb.why });
      });
      if (commit !== "") recordCrash(this.home, commit, rb.version, `its start failed: ${rb.why}`, now);
      this.set({ state: "failed", commit, version: rb.version, reason: `${rb.version} was rolled back: ${rb.why}` });
      return;
    }
    if (mem.pending !== null && this.commit !== null && mem.pending.commit === this.commit) {
      const last: Timeline = { ...mem.pending, liveAt: now };
      this.remember((m) => {
        m.pending = null;
      });
      this.st = { ...this.st, last };
      const push = last.pushedAt ? `${Math.round((now - last.pushedAt) / 1000)} s after its push, ` : "";
      this.cfg.log(`follow-main: ${last.version} running, ${push}${Math.round((now - last.committedAt) / 1000)} s after its commit (noticed ${Math.round((last.noticedAt - last.committedAt) / 1000)} s, built ${Math.round((last.builtAt - last.noticedAt) / 1000)} s, restarted ${Math.round((now - last.builtAt) / 1000)} s)`);
      this.set({ state: "idle", commit: this.commit, version: running, reason: "" });
    }
    // A build of main that keeps crashing soon after it starts goes back to what ran before it.
    if (this.commit !== null && buildOf(running) !== null) {
      const h = readHealth(this.home).commits[this.commit];
      if (earlyCrashes(h, now) >= CRASH_LIMIT && hasPrevious(this.cfg)) {
        const why = `it crashed ${earlyCrashes(h, now)} times within minutes of starting`;
        const commit = this.commit;
        this.remember((m) => {
          if (!m.crashed.some((c) => c.commit === commit)) m.crashed.push({ commit, version: running, why });
        });
        const r = rollback(this.cfg, why);
        this.remember((m) => {
          m.seenRollback = rolledBack(this.cfg)?.at ?? m.seenRollback;
        });
        this.cfg.log(`follow-main: ${running} ${why}: back to ${r.restored}`);
        this.set({ state: "failed", commit, version: running, reason: `${running} was rolled back: ${why}` });
      }
    }
  }

  // ---- git ----

  /** Git in Harbor's own clone: the PC's git config left out (no `insteadOf` sends it elsewhere), never a prompt. */
  private gitEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
    return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  }

  private async git(cwd: string, args: string[], timeoutMs = GIT_MS): Promise<string> {
    const own = cwd === this.src || cwd === this.home;
    const r = await this.run(["git", "-C", cwd, ...args], { cwd, timeoutMs, ...(own ? { env: this.gitEnv() } : {}) });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed${r.out ? `: ${r.out.split("\n").pop()}` : ""}`);
    return r.out;
  }

  private async gitOk(cwd: string, args: string[]): Promise<boolean> {
    return (await this.git(cwd, args).then(() => true, () => false));
  }

  private async revParse(cwd: string, ref: string): Promise<string | null> {
    const out = await this.git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).catch(() => "");
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  }

  /** The public main's commit, asked of the repository (`git ls-remote`, a few hundred bytes); null when unreachable. */
  private async lsRemote(): Promise<string | null> {
    if (this.remote === null) return null;
    ensureDir(this.home);
    const out = await this.git(this.home, ["ls-remote", "--", this.remote, "refs/heads/main"], LS_MS).catch((e: unknown) => {
      this.cfg.log(`follow-main: ${this.remote} not reached: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    });
    const sha = out.split(/\s/)[0] ?? "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * Which main a look builds: the public one, or the checkout's when that one is ahead of it (commits
   * not pushed yet) or the public one can't be reached.
   */
  private async pickTip(checkout: string | null): Promise<{ tip: string; from: "checkout" | "remote" } | null> {
    const local = checkout === null ? null : await this.tipOf(checkout);
    const remote = local !== null && this.heard?.sha === local ? local : await this.lsRemote();
    if (remote === null) return local === null ? null : { tip: local, from: "checkout" };
    if (local === remote) return { tip: local, from: "checkout" };
    if (local !== null && checkout !== null && (await this.revParse(checkout, remote)) !== null && (await this.ancestor(checkout, remote, local))) return { tip: local, from: "checkout" };
    return { tip: remote, from: "remote" };
  }

  private ancestor(cwd: string, a: string, b: string): Promise<boolean> {
    return this.gitOk(cwd, ["merge-base", "--is-ancestor", a, b]);
  }

  /** The newer of the checkout's main and origin/main; origin/main when they've gone apart. */
  async tipOf(checkout: string): Promise<string | null> {
    const local = await this.revParse(checkout, "refs/heads/main");
    const origin = await this.revParse(checkout, "refs/remotes/origin/main");
    if (local === null || origin === null) return local ?? origin;
    if (local === origin) return local;
    return (await this.ancestor(checkout, origin, local)) ? local : origin;
  }

  private get src(): string {
    return join(this.home, "src");
  }

  /**
   * Harbor's own clone, brought to the checkout's main refs and tags (`checkout`), or to the public main
   * (null: `refs/follow/remote-main`). Made from the checkout when there is one, else a partial clone of
   * the public repository.
   */
  private async syncClone(checkout: string | null): Promise<void> {
    if (!isFile(join(this.src, ".git", "HEAD"))) {
      remove(this.src);
      ensureDir(this.home);
      if (checkout !== null) await this.git(this.home, ["clone", "--quiet", "--no-checkout", checkout, this.src], INSTALL_MS);
      else if (this.remote !== null) await this.git(this.home, ["clone", "--quiet", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", "main", "--no-tags", "--", this.remote, this.src], INSTALL_MS);
      else throw new Error("no Harbor checkout found");
    }
    if (checkout === null) return this.fetchRemote(["+refs/heads/main:refs/follow/remote-main"]);
    await this.git(this.src, ["fetch", "--quiet", "--force", "--tags", checkout, "+refs/heads/main:refs/follow/main", "+refs/remotes/origin/main:refs/follow/origin-main"], INSTALL_MS).catch(() =>
      this.git(this.src, ["fetch", "--quiet", "--force", "--tags", checkout, "+refs/heads/main:refs/follow/main"], INSTALL_MS),
    );
  }

  /** Fetches from the public repository: through `origin` in the partial clone (its filter goes along), else by address. */
  private async fetchRemote(refspecs: string[]): Promise<void> {
    if (this.remote === null) throw new Error("no repository to fetch from");
    const origin = (await this.git(this.src, ["config", "--get", "remote.origin.url"]).catch(() => "")) === this.remote;
    await this.git(this.src, ["fetch", "--quiet", "--force", "--no-tags", "--", origin ? "origin" : this.remote, ...refspecs], INSTALL_MS);
  }

  /** A release tag's commit: from the clone's tags, else fetched from the public repository (or the checkout's origin). */
  private async tagCommit(version: string): Promise<string | null> {
    const tag = `refs/tags/v${version}`;
    const have = await this.revParse(this.src, tag);
    if (have !== null) return have;
    if (this.remote !== null) {
      await this.fetchRemote([`+${tag}:${tag}`]).catch(() => undefined);
      return this.revParse(this.src, tag);
    }
    const checkout = this.checkout();
    if (checkout === null) return null;
    const url = await this.git(checkout, ["remote", "get-url", "origin"]).catch(() => "");
    if (url === "") return null;
    await this.git(this.src, ["fetch", "--quiet", "--no-tags", url, `+${tag}:${tag}`]).catch(() => "");
    return this.revParse(this.src, tag);
  }

  /** delivery.ts `keep`: a newer release whose commit the running build of main already has. */
  async keeps(version: string): Promise<boolean> {
    if (!this.possible() || !this.on() || this.commit === null || buildOf(current(this.cfg)) === null) return false;
    const checkout = this.checkout();
    if (!isFile(join(this.src, ".git", "HEAD"))) await this.syncClone(checkout);
    if (this.remote !== null && (await this.revParse(this.src, this.commit)) === null) await this.fetchRemote(["+refs/heads/main:refs/follow/remote-main"]).catch(() => undefined);
    const tag = await this.tagCommit(version);
    if (tag === null) return false;
    const keep = await this.ancestor(this.src, tag, this.commit);
    if (keep) this.cfg.log(`follow-main: release ${version} is already in ${current(this.cfg)}: keeping it`);
    return keep;
  }

  // ---- the look ----

  async check(): Promise<void> {
    if (!this.on() || !this.possible()) return;
    this.looked = true;
    const checkout = this.checkout();
    const startedAt = this.cfg.now();
    const pick = await this.pickTip(checkout);
    if (pick === null) return this.set({ state: "failed", checkout: this.source(checkout), reason: checkout === null ? `${this.source(null)} can't be reached` : `no main branch in ${checkout}` });
    const from = pick.from === "checkout" ? checkout : null;
    this.st.checkout = this.source(from);
    const tip = pick.tip;
    const news = this.heard !== null && this.heard.sha === tip && startedAt - this.heard.at < 60_000 ? this.heard : null;
    const noticedAt = news?.at ?? startedAt;
    const short = tip.slice(0, 7);
    const running = current(this.cfg);
    if (tip === this.commit) return this.set({ state: "idle", commit: tip, version: running, reason: "" });
    const mem = this.memory();
    if (mem.failed?.commit === tip) return this.set({ state: "failed", commit: tip, reason: mem.failed.why });
    const crashed = mem.crashed.find((c) => c.commit === tip);
    if (crashed) return this.set({ state: "failed", commit: tip, version: crashed.version, reason: `${crashed.version} was rolled back: ${crashed.why}; waiting for main to move` });
    if (this.d.busy() || onDisk(this.cfg) !== null) return this.waitThen(tip, "a release is being installed");

    await this.syncClone(from);
    if (from === null) {
      // What the repository says main is now (it may have moved since ls-remote).
      const fetched = await this.revParse(this.src, "refs/follow/remote-main");
      if (fetched === null) return this.set({ state: "failed", commit: tip, reason: `main didn't come from ${this.source(null)}` });
      if (fetched !== tip) {
        // It moved since ls-remote: look again from the top with the newer one.
        this.again = true;
        return;
      }
    }
    const subject = await this.git(this.src, ["log", "-1", "--format=%s", tip]).catch(() => "");
    const committedAt = Number(await this.git(this.src, ["log", "-1", "--format=%ct", tip]).catch(() => "0")) * 1000;
    const pkgText = await this.git(this.src, ["show", `${tip}:ts/package.json`]).catch(() => "");
    const pkgVersion = (JSON.parse(pkgText || "{}") as { version?: string }).version ?? "";
    if (parse(pkgVersion) === null) return this.set({ state: "failed", commit: tip, subject, reason: "main's ts/package.json has no version" });
    const version = localVersion(pkgVersion, tip);

    if (buildOf(running) === null && newer(running, pkgVersion)) return this.set({ state: "idle", commit: tip, subject, version: running, reason: `release ${running} is newer than main (${pkgVersion})` });
    const mine = this.commit !== null && (await this.revParse(this.src, this.commit)) !== null ? this.commit : null;
    if (mine !== null && (await this.ancestor(this.src, tip, mine))) return this.set({ state: "idle", commit: tip, subject, version: running, reason: `${running} already has main (${short})` });
    // The public main only forward from what runs: never a rewritten history (a force-push), never older.
    if (from === null && (mine === null || !(await this.ancestor(this.src, mine, tip)))) {
      return this.set({ state: "skipped", commit: tip, subject, version, reason: `${short} doesn't descend from what runs (${(this.commit ?? "no commit").slice(0, 7)}): releases only until main does` });
    }
    if (mine !== null) {
      const changed = (await this.git(this.src, ["diff", "--name-only", mine, tip])).split("\n").filter(Boolean);
      if (!changed.some(shipsInApp)) return this.set({ state: "idle", commit: tip, subject, version: running, reason: `main (${short}) changed nothing the app is built from` });
    }

    // Bundle only: the runtime this PC has must run it.
    const rt = runtimeOnDisk(this.cfg);
    const base = await this.tagCommit(rt);
    if (base === null) return this.set({ state: "skipped", commit: tip, subject, version, reason: `can't tell whether ${short} needs a new runtime: no tag v${rt} to compare with` });
    const sinceRuntime = (await this.git(this.src, ["diff", "--name-only", base, tip])).split("\n").filter(Boolean);
    const before = await this.git(this.src, ["show", `${base}:ts/package.json`]).catch(() => null);
    const l = lane({ changed: sinceRuntime, packageJson: { before, after: pkgText } });
    if (l.lane === "runtime") return this.set({ state: "skipped", commit: tip, subject, version, reason: `${short} needs a new runtime (${l.reasons.slice(0, 3).join("; ")}${l.reasons.length > 3 ? "; …" : ""}): it comes with the next release` });

    // The bundle asks for no more than the runtime that will run it: the older of RUNTIME and this one.
    const minRuntime = newer(rt, this.cfg.runtime) && parse(this.cfg.runtime) !== null ? this.cfg.runtime : rt;
    const built = await this.build(tip, version, minRuntime, subject);
    if (built === null) return;
    if (this.d.busy() || onDisk(this.cfg) !== null) return this.waitThen(tip, "a release is being installed");
    if (!this.on() || !this.armed) return;
    installLocal(this.cfg, built, version);
    this.remember((m) => {
      m.pending = { commit: tip, version, committedAt, noticedAt, builtAt: this.cfg.now(), ...(news?.pushedAt ? { pushedAt: news.pushedAt } : {}) };
    });
    this.cfg.log(`follow-main: ${version} installed, restarting into it`);
    this.set({ state: "swapping", commit: tip, subject, version, reason: "" });
  }

  /**
   * Once per start, when the clone has no node_modules yet (a PC that never built main): the clone and
   * `bun install` now, at idle priority, so the first push builds in seconds rather than downloading.
   */
  private async warm(): Promise<void> {
    if (this.warmed || !this.armed || !this.on() || this.d.busy()) return;
    if (exists(join(this.src, "ts", "node_modules"))) {
      this.warmed = true;
      return;
    }
    if (this.st.state !== "idle" && this.st.state !== "skipped") return;
    this.warmed = true;
    const checkout = this.checkout();
    try {
      await this.syncClone(checkout);
      const at = (this.commit !== null ? await this.revParse(this.src, this.commit) : null) ?? (await this.revParse(this.src, checkout === null ? "refs/follow/remote-main" : "refs/follow/main"));
      if (at === null) return;
      await this.git(this.src, ["checkout", "--quiet", "--force", "--detach", at]);
      const { exe, env } = this.bunCmd();
      const log = join(this.home, "build.log");
      writeAtomic(log, `follow-main: getting ready (bun install at ${at.slice(0, 7)})\n`);
      await this.run([exe, "install", "--frozen-lockfile"], { cwd: join(this.src, "ts"), env, timeoutMs: INSTALL_MS, log, nice: true });
    } catch (e) {
      this.cfg.log(`follow-main: getting ready failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private waitThen(commit: string, why: string): void {
    this.set({ state: "waiting", commit, reason: why });
    const t = setTimeout(() => this.poke(), WAIT_MS);
    t.unref?.();
  }

  private bunCmd(): { exe: string; env: Record<string, string> } {
    const dir = this.cfg.dir;
    const rt = dir === null ? "" : join(dir, RUNTIME_FILE);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("HARBOR_")) env[k] = v;
    Object.assign(env, this.d.buildEnv?.() ?? {});
    if (rt !== "" && isFile(rt)) return { exe: rt, env: { ...env, BUN_BE_BUN: "1" } };
    return { exe: process.execPath, env };
  }

  /** Builds and checks `commit` in the clone: the bundle's path, or null (the failure is remembered). */
  private async build(commit: string, version: string, minRuntime: string, subject: string): Promise<string | null> {
    const log = join(this.home, "build.log");
    const out = join(this.home, "out");
    fresh(out);
    writeAtomic(log, `follow-main: building ${version} (${subject})\n`);
    const ts = join(this.src, "ts");
    const { exe, env } = this.bunCmd();
    const fail = (why: string, checks?: { tsc: boolean; smoke: boolean }): null => {
      this.remember((m) => {
        m.failed = { commit, why };
      });
      if (checks) recordChecks(this.home, commit, version, checks, this.cfg.now());
      this.cfg.log(`follow-main: ${version} not taken: ${why} (${log})`);
      this.set({ state: "failed", commit, subject, version, reason: why });
      return null;
    };
    this.set({ state: "building", commit, subject, version, reason: "" });
    const t0 = this.cfg.now();
    const mark = (what: string): void => {
      try {
        appendFileSync(log, `follow-main: [${((this.cfg.now() - t0) / 1000).toFixed(1)} s] ${what}\n`);
      } catch {
        // the log is for people
      }
    };
    await this.git(this.src, ["checkout", "--quiet", "--force", "--detach", commit]);
    await this.git(this.src, ["clean", "-fdq"]);
    mark("checked out");
    const step = async (cmd: string[], timeoutMs: number) => {
      mark(cmd[0] === "install" ? "bun install" : cmd[0]?.includes("tsc") ? "tsc" : (cmd[0] ?? ""));
      return this.run([exe, ...cmd], { cwd: ts, env, timeoutMs, log, nice: true });
    };
    if ((await step(["install", "--frozen-lockfile"], INSTALL_MS)).code !== 0) return fail("bun install failed");
    this.set({ state: "checking", commit, subject, version, reason: "tsc" });
    // tsc's own entry, run by this Bun: `bun run check` reaches it through `node`, which may be anything (a mise shim).
    if ((await step(["node_modules/typescript/bin/tsc", "--noEmit"], TSC_MS)).code !== 0) return fail("tsc found errors", { tsc: false, smoke: false });
    this.set({ state: "building", commit, subject, version, reason: "" });
    const bundle = join(out, BUNDLE_FILE);
    if ((await step(["scripts/build.ts", "app", bundle, "--version", version, "--min-runtime", minRuntime, "--sha", commit], BUILD_MS)).code !== 0 || !isFile(bundle)) return fail("the build failed");
    mark("smoke-bundle");
    this.set({ state: "checking", commit, subject, version, reason: "smoke-bundle" });
    try {
      await smokeBundle(join(this.cfg.dir ?? "", RUNTIME_FILE), bundle, version);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), { tsc: true, smoke: false });
    }
    recordChecks(this.home, commit, version, { tsc: true, smoke: true }, this.cfg.now());
    mark("built");
    this.remember((m) => {
      if (m.failed?.commit === commit) m.failed = null;
    });
    return bundle;
  }
}

/** One line for `harbor follow-main status`. */
export function statusLine(s: FollowStatus, on: boolean): string {
  if (!on) return "Off: this PC takes Harbor's releases only.";
  const short = s.commit.slice(0, 7);
  const v = s.version !== "" ? s.version : short;
  switch (s.state) {
    case "off":
    case "idle":
      return s.reason !== "" ? `Following main: ${s.reason}.` : `Following main: running ${v}.`;
    case "building":
      return `Building ${v}…`;
    case "checking":
      return `Checking ${v}${s.reason ? ` (${s.reason})` : ""}…`;
    case "waiting":
      return `Built ${short}, waiting: ${s.reason}.`;
    case "swapping":
      return `Restarting into ${v}…`;
    case "skipped":
      return `Skipped ${short}: ${s.reason}.`;
    case "failed":
      return `Failed${short ? ` at ${short}` : ""}: ${s.reason}.`;
  }
}

export function timelineText(t: Timeline | undefined): string {
  if (t === undefined) return "";
  const s = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
  if (t.pushedAt) return `${t.version} ran ${s(t.liveAt - t.pushedAt)} after its push (heard ${s(t.noticedAt - t.pushedAt)}, built ${s(t.builtAt - t.noticedAt)}, restarted ${s(t.liveAt - t.builtAt)}).`;
  return `${t.version} ran ${s(t.liveAt - t.committedAt)} after its commit (noticed ${s(t.noticedAt - t.committedAt)}, built ${s(t.builtAt - t.noticedAt)}, restarted ${s(t.liveAt - t.builtAt)}).`;
}
