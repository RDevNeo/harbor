// A turn folder is a byte-for-byte contract with the Rust app and its runner: either side starts,
// follows or picks up the other's turns.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  type FSWatcher,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { compactFirst } from "./compaction.ts";
import { arr, at, compact, isNull, optStr, parse } from "./json.ts";
import { lend, token, unlend } from "./oauth.ts";
import { dataDir, home, now, privateDir, selfArgv, stateDir, writePrivate } from "./paths.ts";
import { env as osEnv, proc, spawn as osSpawn } from "@harbor/os";
import { alive, cmdline, myUid, ownerOf, parentOf, pids, procStart, startedAt } from "./procfs.ts";
import { bin, KINDS, which } from "./providers.ts";
import * as turnscope from "./turnscope.ts";
import { setUp as relaySetUp } from "./relay.ts";

/** Polling, where a folder can't be watched (one deleted under its runner). */
export const POLL_MS = 60;
/** With a watch: a look this often all the same, for what inotify doesn't report (a runner that died). */
export const SLOW_MS = 500;
/** Sent to a chat whose turn was cut off while Harbor was away. */
export const RESTARTED =
  "[harbor] Your previous turn was cut off (the computer restarted or its process was killed). Continue the task from where you stopped.";
/** Finished turns' folders older than this are swept at startup. */
const KEEP_MS = 2 * 24 * 3600 * 1000;

/** The env var that names a remote turn's device, for [`unreachableText`]. */
export const DEVICE = "HARBOR_DEVICE";
/** Set in a guest turn's environment for its runner, which takes them out again (agent.ts). */
export const GUEST_LOGIN = "HARBOR_GUEST_LOGIN";
export const GUEST_APPS = "HARBOR_GUEST_APPS";
/** The last line a device's script prints once the agent there has exited: `{"type":"harbor_exit","code":N}`. */
export const REMOTE_EXIT = "harbor_exit";

/** How long a device ssh can't connect to is tried again, the waits between tries, and how long ssh gets after the agent there exited. */
export const timing = { retryForMs: 30_000, retryFirstMs: 1000, retryMaxMs: 8000, lingerMs: 5000 };

/** What Harbor needs to pick a turn back up (`meta.json`). */
export interface Meta {
  chat_id: number;
  /** Provider kind, as its label ("Claude", "Codex", …). */
  kind: string;
  /** Unix time the turn started. */
  started: number;
  /** Transcript length when it started: replay rebuilds from there. */
  base: number;
  pid: number;
  /** The runner's start time (/proc stat field 22), so a reused pid isn't taken for it. */
  pid_start: number;
}

/** `meta.json` as serde writes the struct: fields in declaration order. */
export function metaJson(m: Meta): string {
  return JSON.stringify({ chat_id: m.chat_id, kind: m.kind, started: m.started, base: m.base, pid: m.pid, pid_start: m.pid_start });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** `meta.json` read the way serde reads `Meta`: every field there with its type, or nothing. */
export function readMeta(text: string): Meta | undefined {
  const v = parse(text);
  const chat = at(v, "chat_id");
  const kind = at(v, "kind");
  const started = at(v, "started");
  const base = at(v, "base");
  const pid = at(v, "pid");
  const ps = at(v, "pid_start");
  if (!isInt(chat) || typeof kind !== "string" || !isInt(started) || !isInt(base) || base < 0) return undefined;
  if (!isInt(pid) || pid < 0 || pid > 0xffffffff || !isInt(ps) || ps < 0) return undefined;
  return { chat_id: chat, kind, started, base, pid, pid_start: ps };
}

function readMetaAt(dir: string): Meta | undefined {
  try {
    return readMeta(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** FNV-1a of the data folder: stable across runs and builds. */
export function fnv1a(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h;
}

/** The turns of this Harbor. A Harbor on another data folder (a test instance) gets its own. */
export function root(): string {
  const base = stateDir();
  const data = dataDir();
  if (data === join(home(), ".local/share/harbor")) return join(base, "turns");
  return join(base, `turns-${(fnv1a(data) & 0xffffffffffffn).toString(16).padStart(12, "0")}`);
}

/** A runner started from source has Bun and the entry script before `turn`. */
export function runnerChat(args: readonly string[], rootDir: string): number | undefined {
  let i = 1;
  if (args[1] !== "turn" && args[2] === "turn" && (args[1] ?? "").endsWith("harbor.ts")) i = 2;
  if (args[i] !== "turn") return undefined;
  const dir = args[i + 1];
  if (dir === undefined || dirname(dir) !== rootDir || dir === rootDir) return undefined;
  const head = basename(dir).split("-")[0] ?? "";
  return /^[+-]?\d+$/.test(head) ? Number(head) : undefined;
}

function runnerDir(args: readonly string[]): string {
  const i = args[1] === "turn" ? 2 : 3;
  return args[i] ?? "";
}

/** Runners whose turn's end was followed here (`pid:start`). Once it wrote `exit` a runner only tidies up
 *  and exits, which can take a moment (its scope's leftovers get GRACE_MS, a loaded PC is slow to tear a
 *  process down), while the follower has already removed its folder: taken for a turn still going, the
 *  chat's next turn would wait on it, rewind the transcript over the reply and end it as failed. */
const ended = new Set<string>();

/** A runner of this Harbor's turns that hasn't finished its turn yet. */
function running(pid: number, start: number, dir: string): boolean {
  if (ended.has(`${pid}:${start}`) || existsSync(join(dir, "exit"))) return false;
  return alive(pid, start);
}

/** Live runners of this Harbor's turns, from the processes themselves: chat id, folder, pid. Only this
 *  user's, and only those whose turn is still going. */
export function runners(rootDir: string = root()): [number, string, number][] {
  const me = myUid();
  if (me === undefined) return [];
  for (const k of ended) {
    const [pid, start] = k.split(":").map(Number);
    if (!alive(pid ?? 0, start ?? 0)) ended.delete(k);
  }
  const v: [number, string, number][] = [];
  for (const pid of pids()) {
    if (ownerOf(pid) !== me) continue;
    const args = cmdline(pid);
    if (!args) continue;
    const chat = runnerChat(args, rootDir);
    if (chat === undefined) continue;
    const st = procStart(pid);
    if (st !== undefined && running(pid, st, runnerDir(args))) v.push([chat, runnerDir(args), pid]);
  }
  return v;
}

/** A command as Rust's `Command` keeps it: env changes sorted by name, one per name (null: removed). */
export interface Cmd {
  program: string;
  args: string[];
  cwd: string | null;
  env: Map<string, string | null>;
  /** A Claude session file the runner compacts first when it has grown long (compaction.ts). */
  compact?: string;
  /** A managed process keeps stdout and stderr together in its durable log. */
  mergeOutput?: boolean;
}

export function command(program: string): Cmd {
  return { program, args: [], cwd: null, env: new Map() };
}

export function sortedEnv(c: Cmd): [string, string | null][] {
  return [...c.env.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
}

/** `cmd.json`, byte for byte what the Rust app writes (serde_json's maps keep keys sorted). */
export function cmdJson(c: Cmd, input: boolean, agentEnv: boolean): string {
  const json = { program: c.program, args: c.args, cwd: c.cwd, env: sortedEnv(c), input, agent_env: agentEnv };
  return compact({ ...json, ...(c.compact === undefined ? {} : { compact: c.compact }), ...(c.mergeOutput ? { merge_output: true } : {}) });
}

let lastStamp = 0n;

/** Nanoseconds since the epoch, never the same twice in this process. */
function stamp(): bigint {
  const t = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
  lastStamp = t > lastStamp ? t : lastStamp + 1n;
  return lastStamp;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** With `agentEnv` the runner, not Harbor, adds the app credentials, so they stay out of `cmd.json`. */
export async function spawn(cmd: Cmd, input: string | null, keepInput: boolean, agentEnv: boolean, meta: Meta, rootDir: string = root()): Promise<[string, Meta]> {
  const dir = join(rootDir, `${meta.chat_id}-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  writePrivate(join(dir, "cmd.json"), cmdJson(cmd, input !== null, agentEnv));
  if (input !== null) {
    writePrivate(join(dir, "in"), input);
    if (!keepInput) writeFileSync(join(dir, "in.closed"), "");
  }
  // The runner gets its own session and isn't Harbor's child, so neither a reload nor Harbor exiting
  // reaches it. Where systemd --user runs, in a scope of its own (turnscope.ts).
  const argv = [...selfArgv(), "turn", dir];
  const runner = osSpawn.detachedArgv(argv);
  if (runner === null || !(await turnscope.start(runner, dir, meta.chat_id))) osSpawn.startDetached(argv);
  const t = Date.now();
  let pid: number | undefined;
  for (;;) {
    try {
      const s = readFileSync(join(dir, "pid"), "utf8").trim();
      if (/^\d+$/.test(s)) pid = Number(s);
    } catch {
      // not written yet: the runner is still starting
    }
    if (pid !== undefined) break;
    if (Date.now() - t > 5000) throw new Error("the turn runner didn't start");
    await sleep(10);
  }
  const m: Meta = { ...meta, pid, pid_start: procStart(pid) ?? 0 };
  writeFileSync(join(dir, "meta.json"), metaJson(m));
  return [dir, m];
}

export function writeInput(dir: string, text: string): boolean {
  if (existsSync(join(dir, "in.closed"))) return false;
  try {
    const fd = openSync(join(dir, "in"), "r+");
    closeSync(fd);
    appendFileSync(join(dir, "in"), text);
    return true;
  } catch {
    return false;
  }
}

export function closeInput(dir: string): void {
  try {
    writeFileSync(join(dir, "in.closed"), "");
  } catch {
    // a folder already gone: the turn ended
  }
}

export function inputOpen(dir: string): boolean {
  return existsSync(join(dir, "in")) && !existsSync(join(dir, "in.closed"));
}

/** Wakes on any change in a folder (inotify, through fs.watch) and at least every SLOW_MS all the
 *  same, so a missed event costs one slow look, never a hang. A folder that can't be watched is polled. */
export class Waker {
  private w: FSWatcher | null = null;
  private pending = false;
  private wake: (() => void) | null = null;

  constructor(dir: string) {
    try {
      this.w = watch(dir, () => this.poke());
      this.w.on("error", () => {
        this.w?.close();
        this.w = null;
        this.poke();
      });
    } catch {
      this.w = null;
    }
  }

  get watching(): boolean {
    return this.w !== null;
  }

  poke(): void {
    this.pending = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Returns at once if something changed since the last wait, else at the next change or after the timeout (`maxMs` caps it). */
  async wait(maxMs = Number.POSITIVE_INFINITY): Promise<void> {
    if (!this.pending) {
      const ms = Math.min(this.w !== null ? SLOW_MS : POLL_MS, maxMs);
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          this.wake = null;
          r();
        }, ms);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
    this.pending = false;
  }

  close(): void {
    this.w?.close();
    this.w = null;
    this.poke();
  }
}

/** Reads whole lines appended to a file since the last look. */
class Tail {
  /** Kept open once found: a /proc fd link vanishes with its process, the file doesn't. */
  private fd: number | null = null;
  private pos = 0;
  private buf: Buffer = Buffer.alloc(0);
  private readonly chunk = Buffer.alloc(65536);
  constructor(private readonly path: string) {}

  /** True if anything was read. */
  lines(f: (l: string) => void): boolean {
    if (this.fd === null) {
      try {
        this.fd = openSync(this.path, "r");
      } catch {
        return false;
      }
    }
    const parts: Buffer[] = [];
    for (;;) {
      let n = 0;
      try {
        n = readSync(this.fd, this.chunk, 0, this.chunk.length, this.pos);
      } catch {
        n = 0;
      }
      if (n <= 0) break;
      this.pos += n;
      parts.push(Buffer.from(this.chunk.subarray(0, n)));
    }
    if (parts.length === 0) return false;
    this.buf = Buffer.concat([this.buf, ...parts]);
    let i: number;
    while ((i = this.buf.indexOf(10)) >= 0) {
      const l = this.buf.subarray(0, i).toString("utf8");
      this.buf = this.buf.subarray(i + 1);
      f(l.replace(/\r+$/, ""));
    }
    return true;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

/** The runner's open `<dir>/<name>` (also once deleted), as a path that reads it. */
const fdOf = (pid: number, dir: string, name: string): string | undefined => proc.openFile(pid, dir, name);

/** What the runner wrote to `exit`: "" while there is none (or it is being written). */
function exitCode(dir: string): string {
  try {
    return readFileSync(join(dir, "exit"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Resolves to whether the turn exited cleanly; `stop` ends the following early and leaves the turn alone. */
export async function follow(dir: string, meta: Meta, line: (l: string) => void, err: (l: string) => void, stop?: () => boolean): Promise<boolean> {
  // A folder deleted under a live runner: its output is still open in the runner.
  const file = (name: string): string => (existsSync(join(dir, name)) ? join(dir, name) : fdOf(meta.pid, dir, name) ?? join(dir, name));
  const out = new Tail(file("out"));
  const errs = new Tail(file("err"));
  const waker = new Waker(dir);
  try {
    for (;;) {
      // Checked before reading, so nothing written before the exit is missed. An `exit` seen the
      // moment it is made (the watch wakes on its creation) may not hold its code yet.
      const done = exitCode(dir) !== "" || !alive(meta.pid, meta.pid_start);
      const a = out.lines(line);
      const b = errs.lines(err);
      if (done) {
        if (exitCode(dir) !== "") ended.add(`${meta.pid}:${meta.pid_start}`);
        out.lines(line);
        errs.lines(err);
        return exitCode(dir) === "0";
      }
      if (stop?.()) return false;
      if (!a && !b) await waker.wait();
    }
  } finally {
    waker.close();
    out.close();
    errs.close();
  }
}

/** Per transcript item: the time it was sent if it is the user's message. */
export type UserTimes = readonly (number | null)[];

/** A live runner whose folder is gone gets it back; its input is closed so the agent finishes and exits. */
export function recover(dir: string, pid: number, chatId: number, userAt: UserTimes): Meta {
  const started = startedAt(pid) ?? now();
  let kind = "Claude";
  for (const c of pids()) {
    if (parentOf(c) !== pid) continue;
    const args = cmdline(c);
    if (args === undefined || args.length === 0) continue;
    // Its program, or the script node runs (npm's Codex on Windows): codex.exe and codex.js are Codex.
    const names = args.slice(0, 2).map((a) => basename(a.replaceAll("\\", "/")).replace(/\.(exe|js|cmd)$/i, ""));
    const k = KINDS.find((k) => names.includes(bin(k)));
    if (k) {
      kind = k;
      break;
    }
  }
  let base = userAt.length;
  for (let i = userAt.length - 1; i >= 0; i--) {
    const t = userAt[i];
    if (t !== null && t !== undefined && t <= started + 5) {
      base = i + 1;
      break;
    }
  }
  const meta: Meta = { chat_id: chatId, kind, started, base, pid, pid_start: procStart(pid) ?? 0 };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "in.closed"), "");
    writeFileSync(join(dir, "meta.json"), metaJson(meta));
  } catch {
    // the runner is followed anyway; only a later pickup misses the folder
  }
  return meta;
}

/** When a folder was made: its name is `<chat>-<nanoseconds>`. */
function made(dir: string): bigint {
  const name = basename(dir);
  const i = name.indexOf("-");
  const rest = i < 0 ? "" : name.slice(i + 1);
  return /^\d+$/.test(rest) ? BigInt(rest) : 0n;
}

/** Leftover turns in the order they are picked up (one per chat): live ones first, then the newest. */
export function followOrder(left: [string, Meta][]): void {
  const key = (e: [string, Meta]): [boolean, bigint] => [alive(e[1].pid, e[1].pid_start), made(e[0])];
  const keys = new Map(left.map((e) => [e, key(e)]));
  left.sort((x, y) => {
    const a = keys.get(x) as [boolean, bigint];
    const b = keys.get(y) as [boolean, bigint];
    if (a[0] !== b[0]) return a[0] ? -1 : 1;
    return a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1;
  });
}

/** Turn folders left by an earlier Harbor: still running, or done while it was away. Old leftovers without a turn are swept. */
export function leftovers(rootDir: string = root()): [string, Meta][] {
  const v: [string, Meta][] = [];
  let names: string[] = [];
  try {
    names = readdirSync(rootDir);
  } catch {
    // no turns folder yet: no leftovers
  }
  let live: [number, string, number][] | undefined;
  for (const n of names) {
    const dir = join(rootDir, n);
    const m = readMetaAt(dir);
    if (m) {
      v.push([dir, m]);
      continue;
    }
    live ??= runners(rootDir);
    if (live.some((r) => r[1] === dir)) continue;
    let old = true;
    try {
      old = Date.now() - statSync(dir).mtimeMs > KEEP_MS;
    } catch {
      // gone meanwhile: nothing to sweep
    }
    if (old) rmSync(dir, { recursive: true, force: true });
  }
  v.sort((a, b) => a[1].started - b[1].started);
  return v;
}

/** An environment change: a value, or null/undefined to remove the variable. */
export type EnvPairs = readonly (readonly [string, string | null | undefined])[];

/** Harbor's app credentials for an agent (mcp.rs's `agent_env_as`), set by the mcp package. */
export type AgentEnv = (signedIn: boolean) => EnvPairs | Promise<EnvPairs>;

let agentEnvAs: AgentEnv = signedOutEnv;

/** Returns the one it replaces. */
export function setAgentEnv(f: AgentEnv): AgentEnv {
  const was = agentEnvAs;
  agentEnvAs = f;
  return was;
}

/** The environment changes an agent (or a process it starts) gets. */
export async function agentEnv(signedIn: boolean): Promise<EnvPairs> {
  return agentEnvAs(signedIn);
}

/** mcp.rs's `agent_env_as` with no app signed in: the user's own gh, git, Convex and Supabase sign-ins stay hidden. */
export function signedOutEnv(): [string, string | null][] {
  const v: [string, string | null][] = [];
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "SSH_ASKPASS", "CONVEX_DEPLOY_KEY", "VERCEL_TOKEN"]) v.push([k, null]);
  const gh = privateDir(join(privateDir(join(dataDir(), "apps")), "github-signed-out"));
  const hosts = join(gh, "hosts.yml");
  if (!existsSync(hosts)) {
    try {
      writePrivate(hosts, "github.com:\n    oauth_token: sign-in-to-github-in-harbor\n    git_protocol: https\n    user: harbor\n");
    } catch {
      // gh then finds no login, the same as signed out
    }
  }
  v.push(["GH_CONFIG_DIR", gh], ["GIT_TERMINAL_PROMPT", "0"]);
  const helper = "!f() { test \"$1\" = get && echo 'Harbor: GitHub is not signed in. Sign in under Settings > Integrations > Apps.' >&2; }; f";
  const git: [string, string][] = [
    ["credential.helper", ""],
    ["credential.https://github.com.helper", ""],
    ["credential.https://gist.github.com.helper", ""],
    ["credential.https://github.com.helper", helper],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  v.push(["GIT_CONFIG_COUNT", String(git.length)]);
  git.forEach(([k, val], i) => v.push([`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, val]));
  v.push(["CONVEX_OVERRIDE_ACCESS_TOKEN", "sign-in-to-convex-in-harbor"], ["SUPABASE_ACCESS_TOKEN", "sign-in-to-supabase-in-harbor"]);
  return v;
}

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, "No such file or directory"],
  EACCES: [13, "Permission denied"],
  ENOTDIR: [20, "Not a directory"],
  ENOEXEC: [8, "Exec format error"],
  E2BIG: [7, "Argument list too long"],
};

/** An error as Rust's io::Error prints it. */
function ioText(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  const known = ERRNO[code];
  if (known) return `${known[1]} (os error ${known[0]})`;
  return e instanceof Error ? e.message : String(e);
}

function appendTo(path: string, text: string): void {
  try {
    if (existsSync(path)) appendFileSync(path, text);
  } catch {
    // a turn folder deleted under its runner
  }
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

type Child = ReturnType<typeof Bun.spawn<"pipe", number, "pipe">>;
type SpawnOpts = Parameters<typeof Bun.spawn>[1];

/** The `harbor turn <dir>` command: the turn, then whatever it left running in its scope goes with it. */
export async function turn(args: readonly string[]): Promise<void> {
  const dir = args[0];
  try {
    await run(args);
  } catch (e) {
    // Its output goes nowhere: a runner that fails before its agent ends the turn and says why in the
    // turn's own error output, instead of vanishing and leaving "The agent exited with an error".
    if (dir !== undefined) failed(dir, e);
  }
  if (dir !== undefined) await turnscope.endOwn(dir);
}

function failed(dir: string, e: unknown): void {
  try {
    appendFileSync(join(dir, "err"), `harbor: the turn couldn't start: ${e instanceof Error ? e.message : String(e)}\n`, { mode: 0o600 });
    if (!existsSync(join(dir, "exit"))) writeFileSync(join(dir, "exit"), "1");
  } catch {
    // a turn folder deleted under its runner
  }
}

/** Runs the agent described in `<dir>/cmd.json`. */
export async function run(args: readonly string[]): Promise<void> {
  const dir = args[0];
  if (dir === undefined) return;
  try {
    writeFileSync(join(dir, "pid"), String(process.pid));
  } catch {
    // Harbor's spawn then times out and says the runner didn't start
  }
  let text: string;
  try {
    text = readFileSync(join(dir, "cmd.json"), "utf8");
  } catch {
    return;
  }
  const spec = parse(text) ?? null;
  const program = optStr(at(spec, "program")) ?? "";
  let argv = arr(at(spec, "args")).filter((a): a is string => typeof a === "string");
  const cwd = optStr(at(spec, "cwd"));
  const env: Record<string, string | undefined> = { ...process.env };
  const pairs = arr(at(spec, "env"));
  for (const kv of pairs) {
    const k = at(kv, 0);
    const v = at(kv, 1);
    if (typeof k !== "string") continue;
    if (typeof v === "string") env[k] = v;
    else if (isNull(v)) delete env[k];
  }
  // The first entry of that name, as the Rust runner reads it.
  const varOf = (k: string): string | undefined => {
    const kv = pairs.find((p) => at(p, 0) === k);
    return kv === undefined ? undefined : optStr(at(kv, 1));
  };
  // A chat commanded from another PC: the account's login comes in as a token, read here so it
  // stays out of cmd.json, and this PC's sign-ins may be off.
  const signedIn = varOf(GUEST_APPS) !== "0";
  let lent: string | null = null;
  const login = varOf(GUEST_LOGIN);
  if (login !== undefined) {
    delete env[GUEST_LOGIN];
    delete env[GUEST_APPS];
    const acct = login !== "" ? login : null;
    const overlay = varOf("CLAUDE_CONFIG_DIR");
    const t = token(acct);
    if (t !== null) {
      if (overlay !== undefined) {
        try {
          lend(overlay, acct, t);
          lent = overlay;
        } catch {
          // the token still reaches the agent; only commands it runs miss the login
        }
      }
      env.CLAUDE_CODE_OAUTH_TOKEN = t;
    } else if (overlay !== undefined && !overlayInUse(overlay, process.pid)) {
      // Not signed in here: no login left from an earlier turn runs it as someone else.
      unlend(overlay);
    }
  }
  if (at(spec, "agent_env") === true) {
    for (const [k, v] of await agentEnvAs(signedIn)) {
      if (v === null || v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  // The agent's way to the MCP bridge, kept open across a Harbor restart (relay.ts).
  ({ argv } = await relaySetUp(env, argv));
  const giveBack = (): void => {
    if (lent !== null && !overlayInUse(lent, process.pid)) unlend(lent);
    lent = null;
  };
  const input = at(spec, "input") === true;
  const remote = basename(program) === "ssh";
  const device = varOf(DEVICE);
  delete env[DEVICE];
  const found = program.includes("/") || isAbsolute(program) ? program : which_(program, env.PATH);
  // Windows: an npm shim (codex.cmd) runs as node and its script, so no argument goes through cmd.exe.
  const line = found === null ? null : osEnv.argvOf(found, env);
  const resolved = line?.[0] ?? null;
  const pre = line?.slice(1) ?? [];
  // A long Claude session is compacted before the turn loads it (not one on another device: its file is there).
  const session = optStr(at(spec, "compact"));
  if (!remote && session !== undefined && resolved !== null) {
    await compactFirst(dir, session, { program: resolved, argv: [...pre, ...argv], cwd: cwd ?? process.cwd(), env }, (l) => {
      try {
        appendFileSync(join(dir, "out"), l, { mode: 0o600 });
      } catch {
        // a turn folder deleted under its runner
      }
    });
  }
  const started = Date.now();
  let wait = timing.retryFirstMs;
  let tries = 0;
  let code: number;
  for (;;) {
    tries++;
    let outFd: number;
    let errFd: number;
    try {
      // Owner-only: the agent's whole stream (prompts, files it read, command output).
      outFd = osSpawn.outputFile(join(dir, "out"));
      errFd = at(spec, "merge_output") === true ? outFd : osSpawn.outputFile(join(dir, "err"));
    } catch {
      return;
    }
    const before = size(join(dir, "out"));
    let child: Child;
    try {
      if (resolved === null) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      const opts = {
        cwd: cwd ?? process.cwd(),
        env,
        stdin: input ? "pipe" : "ignore",
        stdout: outFd,
        stderr: remote ? "pipe" : errFd,
        ...(pre.length === 0 ? { argv0: program } : {}),
      };
      child = Bun.spawn([resolved, ...pre, ...argv], opts as SpawnOpts) as unknown as Child;
    } catch (e) {
      appendTo(join(dir, "err"), `${program}: ${ioText(e)}\n`);
      giveBack();
      writeFileSync(join(dir, "exit"), "127");
      return;
    }
    const fed = input ? feed(child, dir) : null;
    if (!remote) {
      await child.exited;
      code = child.exitCode ?? 1;
      break;
    }
    const held = passStderr(child, dir, before);
    const c = await waitRemote(child, dir);
    if (fed) fed.gone = true;
    // Lines ssh printed before it got anywhere, held back from the chat.
    const lines = (await Promise.race([held, sleep(2000).then(() => [] as string[])])) ?? [];
    const grew = size(join(dir, "out")) > before;
    let why: [string, string] | undefined;
    if (c === 255 && !grew) {
      for (let i = lines.length - 1; i >= 0 && !why; i--) why = unreachable(lines[i] ?? "");
    }
    if (!why) {
      for (const l of lines) appendTo(join(dir, "err"), `${l}\n`);
      code = c;
      break;
    }
    const elapsed = Date.now() - started;
    if (elapsed + wait <= timing.retryForMs && !existsSync(join(dir, "stopped"))) {
      await sleep(wait);
      wait = Math.min(wait * 2, timing.retryMaxMs);
      closeSync(outFd);
      if (errFd !== outFd) closeSync(errFd);
      continue;
    }
    appendTo(join(dir, "err"), `${unreachableText(device ?? why[0], why[0], why[1], tries, Date.now() - started)}\n`);
    code = c;
    break;
  }
  giveBack();
  writeFileSync(join(dir, "exit"), String(code));
}

function which_(name: string, path: string | undefined): string | null {
  return Bun.which(name, { PATH: path ?? "" });
}

/** Passes on everything appended to `in` until `in.closed`, or until `gone` is set because ssh is gone. */
function feed(child: Child, dir: string): { gone: boolean } {
  const flag = { gone: false };
  const sink = child.stdin;
  const waker = new Waker(dir);
  // An agent that exited reads nothing more: the feed ends with it.
  void child.exited.then(() => {
    flag.gone = true;
    waker.poke();
  });
  void (async () => {
    let pos = 0;
    const buf = Buffer.alloc(65536);
    while (!flag.gone) {
      const closed = existsSync(join(dir, "in.closed"));
      const parts: Buffer[] = [];
      try {
        const fd = openSync(join(dir, "in"), "r");
        try {
          let n: number;
          while ((n = readSync(fd, buf, 0, buf.length, pos)) > 0) {
            parts.push(Buffer.from(buf.subarray(0, n)));
            pos += n;
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        // no input file yet: read it next time
      }
      if (parts.length > 0) {
        try {
          sink.write(Buffer.concat(parts));
          await sink.flush();
        } catch {
          return;
        }
      } else if (closed) {
        try {
          await sink.end();
        } catch {
          // the agent already exited
        }
        return;
      } else {
        await waker.wait();
      }
    }
  })().finally(() => waker.close());
  return flag;
}

/** Lines saying ssh couldn't connect, before the device sent anything, are held back for a retry. */
async function passStderr(child: Child, dir: string, before: number): Promise<string[]> {
  const held: string[] = [];
  let through = false;
  let rest = Buffer.alloc(0);
  const errPath = join(dir, "err");
  const take = (raw: Buffer): void => {
    const line = raw.toString("utf8").replace(/\r+$/, "");
    through = through || size(join(dir, "out")) > before;
    if (!through && unreachable(line) !== undefined) {
      held.push(line);
      return;
    }
    through = true;
    appendTo(errPath, `${line}\n`);
  };
  for await (const chunk of child.stderr) {
    rest = Buffer.concat([rest, Buffer.from(chunk)]);
    let i: number;
    while ((i = rest.indexOf(10)) >= 0) {
      take(rest.subarray(0, i));
      rest = rest.subarray(i + 1);
    }
  }
  if (rest.length > 0) take(rest);
  return held;
}

/** The host and reason of ssh's "couldn't connect" lines; a refused login is no such line. */
export function unreachable(line: string): [string, string] | undefined {
  const WHY = ["No route to host", "Connection timed out", "Connection refused", "Network is unreachable", "Host is down", "Operation timed out", "Name or service not known"];
  const l = line.trim();
  const connect = "ssh: connect to host ";
  if (l.startsWith(connect)) {
    const rest = l.slice(connect.length);
    const i = rest.indexOf(": ");
    if (i < 0) return undefined;
    let host = rest.slice(0, i);
    const why = rest.slice(i + 2);
    const p = host.lastIndexOf(" port ");
    if (p >= 0) host = host.slice(0, p);
    return WHY.some((w) => why.startsWith(w)) ? [host, why] : undefined;
  }
  const resolve = "ssh: Could not resolve hostname ";
  if (!l.startsWith(resolve)) return undefined;
  const rest = l.slice(resolve.length);
  const i = rest.indexOf(": ");
  const [host, why] = i < 0 ? [rest, ""] : [rest.slice(0, i), rest.slice(i + 2)];
  return [host, why === "" ? "Name or service not known" : why];
}

export function unreachableText(name: string, host: string, why: string, tries: number, tookMs: number): string {
  let what = "its name didn't resolve";
  let ask = "Is it on and on the same network, and is the name right in Settings › Workspace?";
  if (why.startsWith("No route to host")) [what, ask] = ["no route to host", "Is it on and on the same network?"];
  else if (why.startsWith("Connection timed out") || why.startsWith("Operation timed out")) [what, ask] = ["it didn't answer", "Is it on, awake and on the same network?"];
  else if (why.startsWith("Connection refused")) [what, ask] = ["it refused the connection", "Is its SSH server (Remote Login on a Mac) on?"];
  else if (why.startsWith("Network is unreachable")) [what, ask] = ["this PC's network is unreachable", "Is this PC online?"];
  else if (why.startsWith("Host is down")) [what, ask] = ["the device is down", "Is it on and on the same network?"];
  const where = name.toLowerCase() === host.toLowerCase() ? name : `${name} (${host})`;
  const tried = tries > 1 ? ` (tried ${tries} times over ${Math.max(1, Math.floor(tookMs / 1000))} s)` : "";
  return `Couldn't reach ${where}: ${what}${tried}. ${ask}`;
}

/** A stopped turn's lent login: the kill gives its runner no chance to take it out. */
export function takeBack(dir: string, runner: number): void {
  let spec: unknown;
  try {
    spec = parse(readFileSync(join(dir, "cmd.json"), "utf8"));
  } catch {
    // no command file: nothing was lent
  }
  const varOf = (k: string): string | undefined => {
    const kv = arr(at(spec, "env")).find((p) => at(p, 0) === k);
    return kv === undefined ? undefined : optStr(at(kv, 1));
  };
  // Only a guest turn's: another turn's config dir is its account's own profile.
  const overlay = varOf("CLAUDE_CONFIG_DIR");
  if (varOf(GUEST_LOGIN) !== undefined && overlay !== undefined && !overlayInUse(overlay, runner)) unlend(overlay);
}

/** A live turn other than `runner`'s runs in this overlay profile (chats commanded from the same PC share it). */
function overlayInUse(overlay: string, runner: number): boolean {
  return runners().some(([, dir, pid]) => {
    if (pid === runner) return false;
    let spec: unknown;
    try {
      spec = parse(readFileSync(join(dir, "cmd.json"), "utf8"));
    } catch {
      // a runner whose folder is gone lends nothing
    }
    return arr(at(spec, "env")).some((kv) => at(kv, 0) === "CLAUDE_CONFIG_DIR" && at(kv, 1) === overlay);
  });
}

/** ssh doesn't exit while a forwarded channel stays open, so without this cut a remote turn whose agent is done would never end. */
export async function waitRemote(
  child: { readonly pid: number; readonly exitCode: number | null; readonly signalCode: unknown; readonly exited?: Promise<unknown>; kill(sig?: number | NodeJS.Signals): void },
  dir: string,
): Promise<number> {
  const waker = new Waker(dir);
  void child.exited?.then(() => waker.poke());
  try {
    return await waitRemoteOn(child, dir, waker);
  } finally {
    waker.close();
  }
}

async function waitRemoteOn(child: Parameters<typeof waitRemote>[0], dir: string, waker: Waker): Promise<number> {
  const out = join(dir, "out");
  let seen = 0;
  let partial = Buffer.alloc(0);
  let ended: [number, number] | undefined;
  const mark = Buffer.from(`{"type":"${REMOTE_EXIT}"`);
  const exited = (): boolean => child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined);
  const buf = Buffer.alloc(65536);
  for (;;) {
    if (exited()) return child.exitCode ?? ended?.[0] ?? 1;
    if (ended === undefined) {
      try {
        const fd = openSync(out, "r");
        try {
          let n: number;
          while ((n = readSync(fd, buf, 0, buf.length, seen)) > 0) {
            partial = Buffer.concat([partial, buf.subarray(0, n)]);
            seen += n;
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        // no output yet
      }
      let i: number;
      while ((i = partial.indexOf(10)) >= 0) {
        const line = partial.subarray(0, i + 1);
        partial = partial.subarray(i + 1);
        if (!line.subarray(0, mark.length).equals(mark)) continue;
        const v = parse(line.toString("utf8"));
        if (v !== undefined && at(v, "type") === REMOTE_EXIT) {
          const c = at(v, "code");
          ended = [typeof c === "number" && Number.isInteger(c) ? c | 0 : 1, Date.now()];
        }
      }
    }
    if (ended !== undefined && Date.now() - ended[1] >= timing.lingerMs) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ssh exited meanwhile
      }
      const t = Date.now();
      while (!exited() && Date.now() - t < 2000) await sleep(POLL_MS);
      if (!exited()) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ssh exited meanwhile
        }
        while (!exited()) await sleep(10);
      }
      appendTo(join(dir, "err"), `harbor: the agent there exited ${Math.floor((Date.now() - ended[1]) / 1000)} s ago and ssh still held the connection open; closed it\n`);
      return ended[0];
    }
    await waker.wait(ended === undefined ? undefined : Math.max(1, ended[1] + timing.lingerMs - Date.now()));
  }
}
