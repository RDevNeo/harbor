import { dlopen, FFIType } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { now, writePrivate } from "@harbor/store";
import * as repair from "./discordrepair.ts";
import { type Held, freeze as freezeTree, heldWord, killLeftOver, reclaim as reclaimMemory, thaw as thawHeld, type StopFlag } from "./discordfreeze.ts";
import { type Json, type Obj, get, isObj, items, message, parse, sleep, str, uint } from "./discordjson.ts";
import * as setup from "./discordsetup.ts";

export { account, notice } from "./discordsetup.ts";
export type { Account } from "./discordsetup.ts";

/** A page load until the tools answer. */
const START_WAIT = 120_000;
/** With the engine stopped this long and nobody asking, the host goes too. */
const LINGER = 300;
/** The tool calls' limit, unless the call says otherwise. */
export const CALL_WAIT = 120_000;
/** A thaw until the page answers at all; the first after a full reclaim was seen taking 4 s. */
const THAW_WAIT = 20_000;
/** What a screenshot gives a reconnect: the page's own limit, and a bit. */
const LIVE_WAIT = 25_000;
/** From the page answering until it knows who's signed in. */
const SESSION_WAIT = 45_000;
/** Sign-in gives up after this long. */
const SIGNIN_WAIT = 15 * 60;
/** A captcha nobody solved is closed after this long (seconds), and its join given up. */
export const CAPTCHA_WAIT = 10 * 60;
/** How often the host looks at a captcha, and how many looks without one end it. */
const CAPTCHA_LOOK_MS = 1000;
const CAPTCHA_GONE_LOOKS = 3;


/** How the page runs. `scratch` is repair's throwaway logged-out page. */
export type Mode = "run" | "signin" | "scratch";

/** The desktop a sign-in window would open on; empty: there is none. */
export class Display {
  constructor(
    readonly wayland = "",
    readonly x11 = "",
    readonly runtime = "",
  ) {}

  static here(): Display {
    return new Display(process.env.WAYLAND_DISPLAY ?? "", process.env.DISPLAY ?? "", process.env.XDG_RUNTIME_DIR ?? "");
  }

  static from(v: Json): Display {
    return new Display(str(get(v, "wayland")) ?? "", str(get(v, "x11")) ?? "", str(get(v, "runtime")) ?? "");
  }

  any(): boolean {
    return this.wayland !== "" || this.x11 !== "";
  }
}

/**
 * Runs Discord's page. A reboot or a crash just means [`Engine.start`] again: a client that's gone
 * can't be told from one that never ran.
 */
export interface Engine {
  start(mode: Mode, display: Display): Promise<void>;
  /** The page answers: the tools can be called. */
  ready(): boolean;
  /** It's there at all, frozen or not. */
  alive(): boolean;
  /** Quits cleanly (the session is on disk) and returns when it's gone. */
  stop(): Promise<void>;
  /** One request to the page; its answer. */
  ask(op: Obj, waitMs: number): Promise<Json>;
  /** Nothing it does can run until [`Engine.resume`]. */
  suspend(): Promise<"cgroup" | "signals">;
  resume(): void;
  /** Gives up a suspended client's memory, until `stop`. */
  reclaim(stop: StopFlag): Promise<void>;
  /** The running client was started for Harbor's captcha view (see `setup.captchaView`). */
  captchaView?(): boolean;
  /** Freezing can give its memory back (a cgroup); false once a freeze could only stop it with signals. */
  canFreeze?(): boolean;
}

/** What an engine tells the host that wasn't an answer: the shell's events. */
export type EventSink = (mode: Mode, m: Obj) => void;

interface Waiter {
  resolve: (m: Obj) => void;
  reject: (e: Error) => void;
}

/** Electron over stdin and stdout (JSON lines). Its environment is built from nothing: the page gets none of an agent's. */
export class Electron implements Engine {
  private child: ChildProcess | undefined;
  private waiters = new Map<number, Waiter>();
  private isReady = false;
  /** The shell's output is still coming: an answer can still arrive. */
  private open = false;
  private next = 1;
  /** Which start this is: what's left of an earlier one can't touch the current one's state. */
  private run = 0;
  private held: Held | undefined;
  private view = false;
  /** A cgroup freeze worked here, or hasn't been tried. */
  private freezable = true;

  constructor(
    private readonly data: string,
    private readonly events: EventSink,
  ) {}

  async start(mode: Mode, display: Display): Promise<void> {
    await this.stop();
    const v = setup.Vencords.load();
    const page = setup.writeLiveScript();
    const cfg = {
      mode,
      data: this.data,
      page,
      vencord: setup.vencordDir(v.current),
      // A rig's fake Discord; the shell's default is the real one.
      url: process.env[mode === "scratch" ? "HARBOR_DISCORD_SCRATCH_URL" : "HARBOR_DISCORD_URL"] ?? null,
      captchaView: mode === "run" && setup.captchaView(),
      // A rig's fake hCaptcha; the shell's own list is Discord's and hCaptcha's.
      frames: (process.env.HARBOR_DISCORD_FRAME_ORIGINS ?? "").split(",").filter((o) => o !== ""),
    };
    this.view = cfg.captchaView;
    const unit = await inScope(mode);
    const args = [setup.shellDir()];
    // A window can only open on a real desktop, and only sign-in has one. The rest has no tie to
    // a compositor, so it survives one restarting and needs no session at all.
    const env: Record<string, string> = { XDG_RUNTIME_DIR: runtimeDir() };
    for (const k of ["HOME", "PATH", "LANG", "TZ"]) {
      const val = process.env[k];
      if (val !== undefined) env[k] = val;
    }
    // Chromium only moves to a second cgroup of its own with a session bus: a rig's way to get one.
    const bus = process.env.HARBOR_DISCORD_DBUS;
    if (bus !== undefined) env.DBUS_SESSION_BUS_ADDRESS = bus;
    env.HARBOR_DISCORD = JSON.stringify(cfg);
    if (mode === "signin" && display.any()) {
      if (display.runtime !== "") env.XDG_RUNTIME_DIR = display.runtime;
      if (display.wayland !== "") {
        env.WAYLAND_DISPLAY = display.wayland;
        args.push("--ozone-platform=wayland");
      } else {
        env.DISPLAY = display.x11;
        args.push("--ozone-platform=x11");
      }
    } else {
      args.push("--ozone-platform=headless", "--ozone-override-screen-size=1280,720");
    }
    const [exe, argv] =
      unit !== undefined
        ? ["systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "Delegate=yes", `--unit=${unit}`, "--", setup.electronBin(), ...args]]
        : [setup.electronBin(), args];
    const log = openSync(join(setup.root(), mode === "scratch" ? "scratch.log" : "shell.log"), "w");
    let child: ChildProcess;
    try {
      child = spawn(exe, argv, { env, detached: true, stdio: ["pipe", "pipe", log] });
      await new Promise<void>((res, rej) => {
        child.once("spawn", () => res());
        child.once("error", rej);
      });
    } catch (e) {
      throw new Error(`Couldn't start Electron: ${message(e)}`);
    } finally {
      closeSync(log);
    }
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    const out = child.stdout;
    if (child.pid === undefined || child.stdin === null || out === null) throw new Error("no stdin");
    if (mode === "run") {
      try {
        writePrivate(leftOverPath(), String(child.pid));
      } catch {
        // without it a dead host leaves a frozen client for the next one to find by hand
      }
    }
    this.child = child;
    this.isReady = false;
    this.open = true;
    const mine = ++this.run;
    const lines = createInterface({ input: out });
    lines.on("line", (line) => {
      const m = parse(line);
      if (!isObj(m) || this.run !== mine) return;
      const id = uint(m.id);
      if (id !== undefined) {
        const w = this.waiters.get(id);
        this.waiters.delete(id);
        w?.resolve(m);
        return;
      }
      if (m.ev === "ready") this.isReady = true;
      this.events(mode, m);
    });
    lines.on("close", () => {
      if (this.run !== mine) return;
      this.isReady = false;
      this.open = false;
      const all = [...this.waiters.values()];
      this.waiters.clear();
      for (const w of all) w.reject(new Error("Discord stopped."));
      this.events(mode, { ev: "gone" });
    });
  }

  ready(): boolean {
    return this.isReady;
  }

  captchaView(): boolean {
    return this.view && this.child !== undefined;
  }

  alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(): Promise<void> {
    this.resume();
    const c = this.child;
    if (c === undefined) return;
    this.child = undefined;
    // Only its own: repair's scratch page stops while the real client runs.
    if (safeRead(leftOverPath()).trim() === String(c.pid)) rmSync(leftOverPath(), { force: true });
    const gone = (): boolean => c.exitCode !== null || c.signalCode !== null;
    if (!gone()) await this.askOn(c, { op: "quit" }, 5000).catch(() => {});
    c.stdin?.end();
    const until = Date.now() + 5000;
    while (Date.now() < until && !gone()) await sleep(50);
    // The shell leads its own process group (`detached` above); whatever it left goes.
    if (c.pid !== undefined) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    }
    if (!gone()) await new Promise<void>((res) => c.once("exit", () => res()));
  }

  ask(op: Obj, waitMs: number): Promise<Json> {
    if (this.child === undefined) return Promise.reject(new Error("Discord isn't running."));
    return this.askOn(this.child, op, waitMs);
  }

  private askOn(c: ChildProcess, op: Obj, waitMs: number): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const stdin = c.stdin;
      if (!this.open || stdin === null || stdin.destroyed || !stdin.writable) return reject(new Error("Discord isn't running."));
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("Discord didn't answer in time."));
      }, waitMs);
      this.waiters.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          if (m.ok === true) resolve(m.result ?? null);
          else reject(new Error(str(m.error) ?? "Discord refused that."));
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      stdin.write(`${JSON.stringify({ ...op, id })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.waiters.delete(id);
          reject(new Error("Discord isn't running."));
        }
      });
    });
  }

  async suspend(): Promise<"cgroup" | "signals"> {
    const leader = this.child?.pid;
    if (leader === undefined) throw new Error("Discord isn't running.");
    const h = await freezeTree(leader);
    this.held = h;
    const word = heldWord(h);
    if (word === "signals") this.freezable = false;
    return word;
  }

  canFreeze(): boolean {
    return this.freezable;
  }

  resume(): void {
    const h = this.held;
    this.held = undefined;
    if (h !== undefined) thawHeld(h);
  }

  async reclaim(stop: StopFlag): Promise<void> {
    if (this.held !== undefined) await reclaimMemory(this.held, stop);
  }
}

/** The scope a running page starts in, where systemd can make one. */
async function inScope(mode: Mode): Promise<string | undefined> {
  if (mode !== "run" || process.env.HARBOR_DISCORD_NO_CGROUP !== undefined) return undefined;
  const ok = await new Promise<boolean>((resolve) => {
    const c = spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", "true"], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir() }, stdio: "ignore" });
    c.once("error", () => resolve(false));
    c.once("exit", (code) => resolve(code === 0));
  });
  return ok ? `harbor-discord-${process.pid}-${now()}` : undefined;
}

/** Where systemd --user listens; the host may have been started without it in its environment. */
function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
}

/** The shell's pid while it runs: a host that died can't leave a frozen client behind for good. */
const leftOverPath = (): string => join(setup.root(), "engine.pid");


/** Full gateway logins a day before freezing stops. A judgement call: nobody has published a safe rate. */
export const MAX_LOGINS = 20;
/** Idle this long, so a burst of tool calls doesn't freeze and thaw between calls. */
export const FREEZE_AFTER = 120;

/**
 * Without swap: frozen RAM stays around 320 MB, so an idle client quits. Each start is a login,
 * hence the longer wait and the lower limit.
 */
export const QUIT_AFTER = 30 * 60;
export const MAX_QUIT_LOGINS = 8;

/** What an idle client does. */
export type Rest = "freeze" | "quit";

export const DAY = 24 * 3600;

/** When the engine rests. */
export class Policy {
  constructor(
    readonly idle: number,
    readonly maxLogins: number,
    readonly quitIdle: number,
    readonly maxQuitLogins: number,
  ) {}

  /** A rig's shorter waits and limits come from the environment. */
  static fromEnv(): Policy {
    const n = (k: string, or: number): number => {
      const v = Number.parseInt(process.env[k] ?? "", 10);
      return Number.isFinite(v) ? v : or;
    };
    return new Policy(n("HARBOR_DISCORD_IDLE", FREEZE_AFTER), n("HARBOR_DISCORD_MAX_LOGINS", MAX_LOGINS), n("HARBOR_DISCORD_QUIT_IDLE", QUIT_AFTER), n("HARBOR_DISCORD_MAX_QUIT_LOGINS", MAX_QUIT_LOGINS));
  }

  /** `busy`: calls in flight, a waitForMessage among them. `logins`: when it last logged in. `swap`: zram counts. */
  rest(at: number, lastUse: number, busy: number, logins: number[], swap: boolean): Rest | undefined {
    const [idle, limit, rest]: [number, number, Rest] = swap ? [this.idle, this.maxLogins, "freeze"] : [this.quitIdle, this.maxQuitLogins, "quit"];
    return busy === 0 && at - lastUse >= idle && logins.filter((t) => at - t < DAY).length < limit ? rest : undefined;
  }
}

/** Whether /proc/meminfo's text shows any swap: a disk's, or zram. */
export function swapIn(meminfo: string): boolean {
  for (const l of meminfo.split("\n")) {
    if (l.startsWith("SwapTotal:")) return (Number.parseInt(l.slice(10).trim().split(/\s+/)[0] ?? "", 10) || 0) > 0;
  }
  return false;
}

/** Asked each time, as swap can come and go. A rig stands in for a PC without it. */
export function hasSwap(): boolean {
  if (process.env.HARBOR_DISCORD_NO_SWAP !== undefined) return false;
  try {
    return swapIn(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return false;
  }
}


/**
 * What Discord's spam filter watches: joining and leaving servers, new DMs, bursts of uploads,
 * floods of messages. Each limit is a count in a window and a gap between two.
 */
interface Limit {
  kind: string;
  label: string;
  gap: number;
  hour: number;
  day: number;
}

const LIMITS: Limit[] = [
  { kind: "join", label: "server joins", gap: 300, hour: 3, day: 6 },
  { kind: "leave", label: "server leaves", gap: 300, hour: 3, day: 6 },
  { kind: "dm", label: "new DMs", gap: 120, hour: 4, day: 10 },
  { kind: "upload", label: "file uploads", gap: 20, hour: 15, day: 60 },
  { kind: "send", label: "messages", gap: 1, hour: 120, day: 600 },
  { kind: "react", label: "reactions", gap: 1, hour: 120, day: 600 },
];

/** Waits this short just happen; longer ones are the agent's to hear about. */
const WAIT_UP_TO = 5;

export type Pace = { go: true } | { wait: number } | { refuse: string };

/** What's allowed now for `kind`, given when it last happened (`log`: unix seconds, any order). */
export function pace(kind: string, log: [string, number][], at: number): Pace {
  const l = LIMITS.find((x) => x.kind === kind);
  if (l === undefined) return { go: true };
  const times = log.filter(([k]) => k === kind).map(([, t]) => t).filter((t) => at - t < DAY).sort((a, b) => a - b);
  const hour = times.filter((t) => at - t < 3600).length;
  const refuse = (n: number, what: string, secs: number): Pace => ({
    refuse: `Paced: ${n} ${l.label} in the last ${what} is Harbor's limit, because Discord's spam filter watches these. The next one can go in about ${Math.floor((secs + 59) / 60)} min. Tell the user instead of retrying.`,
  });
  if (times.length >= l.day) return refuse(times.length, "day", (times[times.length - l.day] ?? 0) + DAY - at);
  if (hour >= l.hour) return refuse(hour, "hour", (times[times.length - l.hour] ?? 0) + 3600 - at);
  const last = times.at(-1);
  const left = last === undefined ? 0 : last + l.gap - at;
  if (left <= 0) return { go: true };
  if (left <= WAIT_UP_TO) return { wait: left };
  return { refuse: `Paced: Harbor spaces out ${l.label} because Discord's spam filter watches them. The next one can go in about ${left < 60 ? `${left} s` : `${Math.floor((left + 59) / 60)} min`}. Tell the user instead of retrying.` };
}

const isGo = (p: Pace): boolean => "go" in p;

/** What a tool call counts as, before it's made. */
export function paceKind(name: string, args: Json): string | undefined {
  const apply = get(args, "apply") === true;
  switch (name) {
    case "discord_join":
      return apply ? "join" : undefined;
    case "discord_leave":
      return apply ? "leave" : undefined;
    case "discord_send":
      return items(get(args, "files")).length > 0 ? "upload" : "send";
    case "discord_react":
      return "react";
    default:
      return undefined;
  }
}

const pacePath = (): string => join(setup.root(), "pace.json");

function paceLog(): [string, number][] {
  const v = parse(safeRead(pacePath()));
  const out: [string, number][] = [];
  for (const e of items(v)) {
    if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") out.push([e[0], e[1]]);
  }
  return out;
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function paceNote(kind: string): void {
  const at = now();
  const log = paceLog().filter(([, t]) => at - t < DAY);
  log.push([kind, at]);
  try {
    writePrivate(pacePath(), JSON.stringify(log));
  } catch {
    // an unwritten note only makes the next call a little less paced
  }
}


type Phase = "stopped" | "setup" | "starting" | "ready" | "moving" | "frozen" | "signin";

/** How a sign-in is going, for the card and the hub. */
type Signin = {
  active: boolean;
  /** What to draw as a QR code; none yet, or the window took over. */
  qr: string | null;
  scanned: boolean;
  captcha: boolean;
  /** The real window is open: password, 2FA and captcha happen there. */
  window: boolean;
  /** What's happening, in words. */
  note: string;
  error: string | null;
};

const noSignin = (): Signin => ({ active: false, qr: null, scanned: false, captcha: false, window: false, note: "", error: null });

/** What survives the host (`state.json`). */
export interface Saved {
  /** Recent full logins (unix seconds). */
  logins: number[];
  /** When the engine last stopped: a wait after that catches up on what it missed. */
  stopped: number;
  /** Shown until tools work again. */
  attention: string;
  /** Repair attempts per failure ("build:missing,missing"). */
  attempts: Map<string, number>;
  /** What the last self-test said was missing. */
  failing: string[];
  tested: number;
  /** Discord's build at the last test. */
  build: string;
}

const savedPath = (): string => join(setup.root(), "state.json");

const strings = (v: Json | undefined): string[] => items(v).filter((x): x is string => typeof x === "string");

export function loadSaved(): Saved {
  const j = parse(safeRead(savedPath()));
  const attempts = new Map<string, number>();
  for (const [k, n] of Object.entries(isObj(get(j, "attempts")) ? (get(j, "attempts") as Obj) : {})) {
    const v = uint(n);
    if (v !== undefined) attempts.set(k, v);
  }
  const num = (k: string): number => (typeof get(j, k) === "number" ? (get(j, k) as number) : 0);
  return {
    logins: items(get(j, "logins")).filter((x): x is number => typeof x === "number"),
    stopped: num("stopped"),
    attention: str(get(j, "attention")) ?? "",
    attempts,
    failing: strings(get(j, "failing")),
    tested: num("tested"),
    build: str(get(j, "build")) ?? "",
  };
}

/** A join waiting on a captcha only a person may solve: Harbor's window shows it. */
export type Captcha = {
  /** Names it in the chat's transcript, whose card follows it. */
  id: string;
  guild: string | null;
  guildId: string | null;
  since: number;
  /** The chat whose agent's call hit it (this PC's id); null: not known, the overlay shows it. */
  chat: number | null;
};

/** Who is solving: one device at a time, until it goes quiet. */
type Solver = { who: string; label: string; at: number };
/** A solver's hold ends this long (seconds) after its last input. */
export const SOLVER_HOLD = 20;

/** How the last captcha ended. */
export type CaptchaEnd = {
  outcome: "joined" | "closed" | "timeout" | "stopped";
  guild: string | null;
  at: number;
};

interface St {
  phase: Phase;
  /** Setup's progress. */
  setup: string;
  error: string | null;
  signin: Signin;
  lastUse: number;
  busy: number;
  /** Tools the last self-test says can't work, with what's missing. */
  broken: Map<string, string[]>;
  saved: Saved;
  /** A wait may use this once: the engine wasn't running from then until it came back. */
  catchUp: number | undefined;
  /** How the client is frozen, and since when. */
  held: "" | "cgroup" | "signals";
  frozenAt: number;
  /** Tells reclaim a call wants the client back. */
  reclaiming: StopFlag;
  /** CONNECTION_OPENs this page has counted so far. */
  opens: number;
  /** A newer Vencord is here: the next idle restarts instead of freezing. */
  restart: boolean;
  /** The chat view's internals have been judged in this page. */
  chatTested: boolean;
  /** What the last self-test couldn't judge without a chat on the page. */
  untested: string[];
  repairing: boolean;
  signinAt: number;
  /** The desktop the sign-in started from. */
  display: Display;
  captcha: Captcha | null;
  captchaEnd: CaptchaEnd | null;
}

function newSt(): St {
  return {
    phase: "stopped",
    setup: "",
    error: null,
    signin: noSignin(),
    signinAt: 0,
    display: new Display(),
    lastUse: 0,
    busy: 0,
    broken: new Map(),
    saved: loadSaved(),
    catchUp: undefined,
    held: "",
    frozenAt: 0,
    reclaiming: { stopped: false },
    opens: 0,
    restart: false,
    chatTested: false,
    untested: [],
    repairing: false,
    captcha: null,
    captchaEnd: null,
  };
}

/** Wakes whoever waits for the state to move. */
class Signal {
  private waiting: ((fired: boolean) => void)[] = [];

  notify(): void {
    const all = this.waiting;
    this.waiting = [];
    for (const w of all) w(true);
  }

  wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (fired: boolean): void => {
        clearTimeout(timer);
        resolve(fired);
      };
      this.waiting.push(done);
    });
  }
}

/** What the page's self-test said. */
export interface Test {
  missing: string[];
  /** Lookups only a chat on the page can judge, and none was there: not judged yet. */
  later: string[];
  tools: Map<string, string[]>;
  build: string;
  /** Names and statuses, safe to show repair: nothing else of the page's comes through. */
  report: Json;
}

/** What to do about a self-test's result. */
type Next = "run" | "restart";

export interface HostOptions {
  engine: Engine;
  /** Repair's logged-out page. */
  scratch: Engine;
  policy?: Policy;
  swap?: () => boolean;
}

/** Runs `f` on its own: its failure is the page's to report, not a crash. */
function background(f: () => Promise<void>): void {
  f().catch((e: unknown) => process.stderr.write(`discord host: ${message(e)}\n`));
}

export class Host {
  private st: St = newSt();
  private moved = new Signal();
  readonly engine: Engine;
  /** Repair's logged-out page, while it runs. */
  readonly scratch: Engine;
  readonly policy: Policy;
  private readonly swap: () => boolean;
  /** When someone last wanted something (a status check doesn't count). */
  private touched = now();

  constructor(o: HostOptions) {
    this.engine = o.engine;
    this.scratch = o.scratch;
    this.policy = o.policy ?? Policy.fromEnv();
    this.swap = o.swap ?? hasSwap;
  }

  private set(f: (st: St) => void): void {
    f(this.st);
    this.moved.notify();
  }

  private save(): void {
    const s = this.st.saved;
    try {
      writePrivate(savedPath(), JSON.stringify({ ...s, attempts: Object.fromEntries(s.attempts) }, null, 2));
    } catch {
      // the state is rewritten at the next change
    }
  }

  phase(): Phase {
    return this.st.phase;
  }

  setAttention(text: string): void {
    this.set((st) => {
      st.saved.attention = text;
    });
    this.save();
  }

  saved(): Saved {
    const s = this.st.saved;
    return { ...s, logins: [...s.logins], failing: [...s.failing], attempts: new Map(s.attempts) };
  }

  noteAttempt(sig: string): number {
    const n = (this.st.saved.attempts.get(sig) ?? 0) + 1;
    this.set((st) => {
      st.saved.attempts.set(sig, n);
    });
    this.save();
    return n;
  }

  setRepairing(on: boolean): void {
    this.set((st) => {
      st.repairing = on;
    });
  }

  isRepairing(): boolean {
    return this.st.repairing;
  }

  /** A passing self-test after repair: the failure is over. */
  async judgeAfterRepair(t: Test): Promise<void> {
    await this.judge(t);
  }

  scratchAsk(op: Obj): Promise<Json> {
    return this.scratch.ask(op, 45_000);
  }


  /** The page is up and answering: started if it wasn't, thawed if it's frozen. */
  async ensure(): Promise<void> {
    for (;;) {
      const st = this.st;
      switch (st.phase) {
        case "ready":
          return;
        case "signin":
        case "setup":
          throw new Error("Discord is signing in on this PC. Try again when that's done.");
        case "starting":
        case "moving":
          if (!(await this.moved.wait(START_WAIT))) throw new Error("Discord is taking too long to start.");
          break;
        case "frozen":
          this.set((s) => {
            s.phase = "moving";
            s.reclaiming.stopped = true;
          });
          return this.thaw();
        case "stopped":
          if (setup.account() === undefined) throw new Error("Discord isn't signed in here: sign in under Settings › Integrations › Apps.");
          this.set((s) => {
            s.phase = "starting";
            s.error = null;
          });
          return this.coldStart();
      }
    }
  }

  /** From nothing: a first call, a reboot, a crash, a thaw that didn't come back. */
  private async coldStart(): Promise<void> {
    let err: string | null = null;
    try {
      await this.boot();
    } catch (e) {
      err = message(e);
    }
    this.set((st) => {
      st.phase = err === null ? "ready" : "stopped";
      st.error = err;
    });
    if (err !== null) throw new Error(err);
  }

  /**
   * Wakes the client as Discord wakes after a laptop sleeps: the page checks its connection and
   * reconnects, and live tools wait for that in the page. One that doesn't answer starts over.
   */
  private async thaw(): Promise<void> {
    this.engine.resume();
    let state: Json | undefined;
    try {
      state = await this.engine.ask({ op: "thawed" }, THAW_WAIT);
    } catch {
      state = undefined;
    }
    this.set((st) => {
      st.held = "";
    });
    if (state === undefined) {
      await this.engine.stop();
      this.set((st) => {
        st.phase = "starting";
      });
      return this.coldStart();
    }
    if (str(get(state, "path"))?.startsWith("/login")) {
      this.sessionEnded();
      this.set((st) => {
        st.phase = "stopped";
      });
      throw new Error("Discord ended this session: sign in again under Settings › Integrations › Apps.");
    }
    this.set((st) => {
      st.phase = "ready";
      st.lastUse = now();
    });
  }

  /**
   * Holds the idle client still and gives up its memory. Saved first: a frozen client can be lost
   * with the PC, and it mustn't take the newest of the profile with it.
   */
  async freeze(): Promise<void> {
    if (this.st.phase !== "ready" || this.st.busy > 0) return;
    this.st.phase = "moving";
    await this.engine.ask({ op: "flush" }, 5000).catch(() => {});
    let how: "cgroup" | "signals" | undefined;
    try {
      how = await this.engine.suspend();
    } catch {
      how = undefined;
    }
    // Stopped by signals only, it keeps all its memory: no better than running. Without cgroups,
    // idle quits instead, as without swap (`resting`).
    if (how === "signals" && !this.signalsRest && this.engine.canFreeze?.() === false) {
      this.engine.resume();
      how = undefined;
    }
    const stop: StopFlag = { stopped: false };
    const at = now();
    this.set((st) => {
      if (how !== undefined) {
        st.phase = "frozen";
        st.held = how;
        st.frozenAt = at;
        st.catchUp ??= at;
        st.reclaiming = stop;
      } else {
        // Not this time: it stays running, and idle asks again.
        st.phase = "ready";
        st.lastUse = at;
      }
    });
    if (this.phase() === "frozen") background(() => this.engine.reclaim(stop));
  }

  /** Adds the logins the page has seen since the last look. */
  async countLogins(): Promise<void> {
    let g: Json;
    try {
      g = await this.engine.ask({ op: "gateway" }, 5000);
    } catch {
      return;
    }
    const page = uint(get(g, "opens")) ?? 0;
    const at = now();
    this.set((st) => {
      const seen = page < st.opens ? 0 : st.opens;
      st.saved.logins = st.saved.logins.filter((t) => at - t < DAY);
      for (let i = seen; i < page; i++) st.saved.logins.push(at);
      st.opens = page;
    });
    this.save();
  }

  /**
   * Starts the engine and judges what came up. A failed self-test can restart it on another
   * Vencord, at most twice.
   */
  private async boot(): Promise<void> {
    const say = (s: string): void =>
      this.set((st) => {
        st.setup = s;
      });
    await setup.ensureElectron(say);
    await setup.ensureShell(say);
    await setup.ensureVencord(say);
    await setup.checkVencord(false);
    this.set((st) => {
      st.restart = false;
    });
    for (let i = 0; i < 3; i++) {
      await this.startPage();
      const test = await this.selftest();
      if ((await this.judge(test)) === "run") return;
      await this.engine.stop();
    }
    throw new Error("Discord tools need attention");
  }

  private async startPage(): Promise<void> {
    this.set((st) => {
      st.broken.clear();
      st.chatTested = false;
      st.catchUp = st.saved.stopped > 0 ? st.saved.stopped : undefined;
      st.opens = 0;
      st.lastUse = now();
    });
    await this.engine.start("run", new Display());
    let until = Date.now() + START_WAIT;
    while (!this.engine.ready()) {
      if (Date.now() > until) {
        await this.engine.stop();
        throw new Error("Discord's page didn't come up.");
      }
      if (this.st.error !== null) {
        await this.engine.stop();
        throw new Error(this.st.error);
      }
      await sleep(100);
    }
    // The page knows the user once the gateway says who it is; a dead session falls back to the
    // login page. Neither in time: it's the connection, and the session may be fine.
    until = Date.now() + SESSION_WAIT;
    while (Date.now() < until) {
      const state = await this.engine.ask({ op: "state" }, 10_000);
      if (get(state, "user") !== null) {
        // A page that came up signed in logged in, seen or not.
        const at = now();
        this.set((st) => {
          st.saved.logins = st.saved.logins.filter((t) => at - t < DAY);
          st.saved.logins.push(at);
          st.opens = 1;
        });
        this.save();
        return;
      }
      if (str(get(state, "path"))?.startsWith("/login")) {
        this.sessionEnded();
        throw new Error("Discord ended this session: sign in again under Settings › Integrations › Apps.");
      }
      await sleep(250);
    }
    await this.engine.stop();
    throw new Error("Discord didn't connect. Check this PC's connection and try again.");
  }

  /** Discord logged this session out. The tools go; the card offers sign-in again. */
  private sessionEnded(): void {
    rmSync(setup.accountPath(), { force: true });
    this.setAttention("Discord signed this session out. Sign in again to use it.");
    setup.notice("Discord signed out", "Discord ended Harbor's session. Sign in again under Settings › Integrations › Apps.");
    background(() => this.stopPage());
  }

  async stopPage(): Promise<void> {
    // Calls wait for what comes next instead of finding it half gone.
    this.set((st) => {
      st.phase = "moving";
    });
    await this.engine.stop();
    this.set((st) => {
      st.phase = "stopped";
      st.saved.stopped = now();
    });
    this.save();
  }

  /** The page's self-test, reduced to names and statuses. */
  async selftest(): Promise<Test> {
    const r = await this.engine.ask({ op: "selftest" }, 30_000);
    let base = "";
    try {
      base = setup.baseScript();
    } catch {
      base = "";
    }
    return readTest(r, base);
  }

  /**
   * Passed: this Vencord is good, and whatever was wrong is over. Failed: back to the last good
   * Vencord; a newer one, in case that's Vencord's fix; else repair.
   */
  private async judge(t: Test): Promise<Next> {
    const failed = t.missing.length > 0;
    this.set((st) => {
      st.broken = new Map(t.tools);
      st.saved.failing = [...t.missing];
      st.untested = [...t.later];
      st.saved.tested = now();
      st.saved.build = t.build;
    });
    if (!failed) {
      const v = setup.Vencords.load();
      v.passed();
      v.save();
      this.set((st) => {
        st.saved.attention = "";
        st.saved.attempts.clear();
      });
      this.save();
      return "run";
    }
    const v = setup.Vencords.load();
    if (v.rollback()) {
      v.save();
      return "restart";
    }
    if (await setup.checkVencord(true)) return "restart";
    this.save();
    repair.start(this, t);
    return "run";
  }

  /** The chat view's internals exist once a channel has been open: judged then, once a page. */
  private testChatView(): void {
    if (this.st.chatTested) return;
    this.st.chatTested = true;
    this.set((st) => {
      st.busy += 1;
    });
    background(async () => {
      await sleep(this.chatDelay);
      let t: Test | undefined;
      try {
        t = await this.selftest();
      } catch {
        t = undefined;
      }
      this.set((st) => {
        st.busy -= 1;
        // No chat was on the page after all (a send doesn't show one): the next chat tool tries again.
        if (t === undefined || t.later.length > 0) st.chatTested = false;
      });
      if (t !== undefined) await this.judgeRunning(t);
    });
  }

  /** Wait before the chat view is judged; tests shorten it. */
  chatDelay = 2000;

  /** [`Host.judge`] for a page already in use: a restart goes through starting. */
  private async judgeRunning(t: Test): Promise<void> {
    if ((await this.judge(t)) === "restart") {
      await this.engine.stop();
      this.set((st) => {
        st.phase = "stopped";
      });
      await this.ensure().catch(() => {});
    }
  }

  /** Puts the tool script back in the page after repair changed it. */
  async reinject(): Promise<void> {
    setup.writeLiveScript();
    await this.engine.ask({ op: "inject" }, 20_000);
  }

  async scratchStart(): Promise<void> {
    await this.scratch.start("scratch", new Display());
    const until = Date.now() + START_WAIT;
    while (!this.scratch.ready()) {
      if (Date.now() > until) {
        await this.scratch.stop();
        throw new Error("The scratch page didn't come up.");
      }
      await sleep(100);
    }
  }

  async scratchStop(): Promise<void> {
    await this.scratch.stop();
    rmSync(join(setup.root(), "scratch"), { recursive: true, force: true });
  }

  /** The client is up and counts as in use until [`Host.leave`]: it can't freeze in between. */
  private async enter(): Promise<void> {
    for (;;) {
      await this.ensure();
      if (this.st.phase === "ready") {
        this.st.busy += 1;
        this.st.lastUse = now();
        return;
      }
    }
  }

  private leave(): void {
    this.set((st) => {
      st.busy -= 1;
      st.lastUse = now();
    });
  }

  /**
   * A request about the page itself. Anything shown of it comes after the reconnect, like the
   * tools that read it.
   */
  private async pageOp(req: Json): Promise<Json> {
    await this.enter();
    try {
      await this.engine.ask({ op: "settled" }, LIVE_WAIT);
      return await this.engine.ask(isObj(req) ? req : {}, 30_000);
    } finally {
      this.leave();
    }
  }

  /** Reads a tool's arguments and runs it. */
  async call(name: string, args: Json, chat: number | null = null): Promise<Json> {
    await this.enter();
    const a: Obj = isObj(args) ? { ...args } : {};
    let v: Json;
    try {
      v = await this.runTool(name, a);
    } catch (e) {
      // A tool found one of Discord's internals gone: the self-test, with the chat the tool just
      // opened, says what, and repair starts from there.
      if (/may have changed/.test(message(e))) {
        this.st.chatTested = false;
        this.testChatView();
      }
      throw e;
    } finally {
      this.leave();
    }
    switch (name) {
      case "discord_join":
        if (get(v, "joined") === true) paceNote("join");
        else if (get(v, "captchaRequired") === true) v = this.captchaFound(v, chat);
        break;
      case "discord_leave":
        if (get(v, "left") === true) paceNote("leave");
        break;
      case "discord_dm_open":
        if (get(v, "created") === true) paceNote("dm");
        break;
      case "discord_send":
      case "discord_react": {
        const k = paceKind(name, a);
        if (get(v, "paced") !== true && k !== undefined) paceNote(k);
        break;
      }
    }
    if (get(v, "paced") === true && name === "discord_dm_open") {
      const p = pace("dm", paceLog(), now());
      if ("refuse" in p) return { paced: true, note: p.refuse };
    }
    if (["discord_open", "discord_view", "discord_dm_open", "discord_send"].includes(name)) this.testChatView();
    return v;
  }

  private async runTool(name: string, args: Obj): Promise<Json> {
    const c = this.st.captcha;
    if (c !== null && name === "discord_join" && get(args, "apply") === true) {
      return { joined: false, captchaPending: true, note: `A captcha to join ${c.guild ?? "a server"} is waiting for the user to solve it in Harbor. Try again after that one is done.` };
    }
    const missing = this.st.broken.get(name);
    if (missing !== undefined) {
      const doing = this.st.repairing ? "Harbor is repairing it; try again in a few minutes." : "Discord tools need attention.";
      throw new Error(`This tool can't work right now: Discord changed ${missing.join(", ")}. ${doing}`);
    }
    // New DMs are only known in the page: it refuses one when the pace says so.
    if (name === "discord_dm_open") args._allowNew = isGo(pace("dm", paceLog(), now()));
    const k = paceKind(name, args);
    if (k !== undefined) {
      const p = pace(k, paceLog(), now());
      if ("wait" in p) await sleep(p.wait * 1000);
      else if ("refuse" in p) return { paced: true, note: p.refuse };
    }
    if (name === "discord_waitForMessage") {
      const t = this.st.catchUp;
      this.st.catchUp = undefined;
      if (t !== undefined) args._since = t * 1000;
    }
    const r = await this.engine.ask({ op: "call", name, args }, callWait(name, args));
    return typeof r === "string" ? (parse(r) ?? null) : null;
  }


  /** What the agent hears about a join behind a captcha, and whether Harbor shows it. */
  private captchaFound(v: Json, chat: number | null): Json {
    const o: Obj = isObj(v) ? { ...v } : {};
    if (this.engine.captchaView?.() === true) {
      this.captchaStart(v, chat);
      o.note = `Discord wants a captcha for this join, and only a person may solve it. Harbor shows it to the user${chat !== null ? " in this chat" : ""} and will tell them how it went; don't retry. discord_status says whether it's still waiting; discord_guilds shows the server once joined.`;
      return o;
    }
    // The view is off: the join is the user's to make in their own Discord app.
    background(async () => {
      await this.engine.ask({ op: "captcha_end" }, 5000).catch(() => {});
    });
    o.note = "Discord wants a captcha for this join, and a person has to solve it. Ask the user to join this server from their own Discord app; don't retry.";
    return o;
  }

  /**
   * A join is waiting on a captcha: the client stays awake and unfrozen while a person solves it
   * in Harbor's window, which the notice points to. Nothing here solves or clicks anything.
   */
  private captchaStart(v: Json, chat: number | null): void {
    if (this.st.captcha !== null) return;
    const g = get(v, "guild");
    const c: Captcha = { id: randomBytes(6).toString("hex"), guild: str(get(g, "name")) ?? null, guildId: str(get(g, "id")) ?? null, since: now(), chat };
    this.solver = null;
    this.set((st) => {
      st.captcha = c;
      st.captchaEnd = null;
      st.busy += 1;
    });
    const where = chat !== null ? "Solve it in the chat, on any of your PCs or your phone" : "Solve it in Harbor, on this PC or your phone";
    setup.notice("Discord needs a captcha", `To join ${c.guild ?? "a server"}, Discord wants a person to solve a captcha. ${where}; it's given up in ${CAPTCHA_WAIT / 60} minutes.`, "discord-captcha", {
      chat,
      captcha: { captcha: c.id, state: "pending", guild: c.guild },
      line: `Discord needs a captcha to join ${c.guild ?? "a server"}`,
    });
    background(() => this.captchaFollow(c));
  }

  /** Follows a captcha until the join lands, the captcha goes away, or time runs out. */
  private async captchaFollow(c: Captcha): Promise<void> {
    let gone = 0;
    while (this.st.captcha === c) {
      await sleep(CAPTCHA_LOOK_MS);
      let s: Json;
      try {
        s = await this.engine.ask({ op: "captcha" }, 5000);
      } catch {
        return this.captchaEnd(c, "stopped");
      }
      if (get(get(s, "pending"), "joined") === true) return this.captchaEnd(c, "joined");
      if (get(s, "showing") === true) gone = 0;
      else if (++gone >= CAPTCHA_GONE_LOOKS) return this.captchaEnd(c, "closed");
      if (now() - c.since > CAPTCHA_WAIT) {
        await this.engine.ask({ op: "captcha_cancel" }, 5000).catch(() => {});
        return this.captchaEnd(c, "timeout");
      }
    }
  }

  private captchaEnd(c: Captcha, outcome: CaptchaEnd["outcome"]): void {
    if (this.st.captcha !== c) return;
    this.set((st) => {
      st.captcha = null;
      st.captchaEnd = { outcome, guild: c.guild, at: now() };
      st.busy -= 1;
      st.lastUse = now();
    });
    this.solver = null;
    this.engine.ask({ op: "captcha_end" }, 5000).catch(() => {});
    const g = c.guild ?? "the server";
    // The chat's card becomes this line: no frames are kept.
    const card = (line: string): Obj => ({ chat: c.chat, captcha: { captcha: c.id, state: outcome, guild: c.guild }, line });
    switch (outcome) {
      case "joined":
        paceNote("join");
        setup.notice("Discord: joined", `The captcha was solved: Discord joined ${g}.`, "discord-captcha", card(`Captcha solved: joined ${g}`));
        break;
      case "closed":
        setup.notice("Discord: not joined", `The captcha was closed, so Discord didn't join ${g}.`, "discord-captcha", card(`Captcha closed: didn't join ${g}`));
        break;
      case "timeout":
        setup.notice("Discord: not joined", `Nobody solved the captcha in ${CAPTCHA_WAIT / 60} minutes, so Discord didn't join ${g}.`, "discord-captcha", card(`Nobody solved the captcha in ${CAPTCHA_WAIT / 60} minutes: didn't join ${g}`));
        break;
      case "stopped":
        setup.notice("Discord: not joined", `Discord stopped before the captcha was solved, so it didn't join ${g}.`, "discord-captcha", card(`Discord stopped before the captcha was solved: didn't join ${g}`));
        break;
    }
  }

  private solver: Solver | null = null;

  /**
   * A chat's captcha card, from wherever the chat is open (this PC, another PC of the mesh, a
   * phone): its frame (only the captcha and a margin around it), a person's pointer (one device at
   * a time), or Don't join. Status 404: no captcha waits for that chat.
   */
  async chatCaptcha(chat: number, b: Json): Promise<{ status: number; body: Json }> {
    const c = this.st.captcha;
    if (c === null || c.chat !== chat) return { status: 404, body: { error: "No captcha is waiting in this chat." } };
    const at = now();
    const held = this.solver !== null && at - this.solver.at < SOLVER_HOLD ? this.solver : null;
    const who = str(get(b, "who")) ?? "";
    const label = str(get(b, "label")) ?? "another device";
    switch (str(get(b, "action")) ?? "") {
      case "frame": {
        const max = typeof get(b, "max") === "number" ? Math.min(Math.max(get(b, "max") as number, 160), 1280) : 720;
        const f = await this.engine.ask({ op: "captcha_frame", crop: true, max }, 10_000);
        if (get(f, "showing") !== true) return { status: 200, body: { captcha: c.id, guild: c.guild, solver: held } };
        return { status: 200, body: { captcha: c.id, guild: c.guild, data: get(f, "data") ?? null, width: get(f, "width") ?? 0, height: get(f, "height") ?? 0, crop: get(f, "crop") ?? null, rect: get(f, "rect") ?? null, solver: held } };
      }
      case "input": {
        // Two places at once would fight over one pointer: the first keeps it while it's busy.
        if (held !== null && held.who !== who) return { status: 200, body: { taken: false, solver: held } };
        const kind = str(get(b, "kind")) ?? "";
        if (!["down", "up", "move"].includes(kind)) return { status: 400, body: { error: "kind: down, up or move" } };
        const n = (k: string): number => (typeof get(b, k) === "number" ? (get(b, k) as number) : Number.NaN);
        const r = await this.engine.ask({ op: "captcha_input", kind, x: n("x"), y: n("y") }, 5000);
        const taken = get(r, "taken") === true;
        if (taken && who !== "") this.solver = { who, label, at };
        return { status: 200, body: { taken, solver: this.solver !== null && at - this.solver.at < SOLVER_HOLD ? this.solver : null } };
      }
      case "cancel":
        await this.engine.ask({ op: "captcha_cancel" }, 5000);
        return { status: 200, body: {} };
      default:
        return { status: 400, body: { error: "action: frame, input or cancel" } };
    }
  }

  /** The person's side of a captcha: what it looks like, their pointer, and giving up. */
  private async captchaOp(op: string, req: Json): Promise<Json> {
    if (this.st.captcha === null) {
      if (op === "captcha_frame") return { showing: false };
      throw new Error("No captcha is waiting.");
    }
    switch (op) {
      case "captcha_frame":
        return await this.engine.ask({ op }, 10_000);
      case "captcha_input": {
        const n = (k: string): number => (typeof get(req, k) === "number" ? (get(req, k) as number) : Number.NaN);
        return await this.engine.ask({ op, kind: str(get(req, "kind")) ?? "", x: n("x"), y: n("y"), dy: n("dy") }, 5000);
      }
      default:
        return await this.engine.ask({ op: "captcha_cancel" }, 5000);
    }
  }

  private signin(display: Display): void {
    const st = this.st;
    if (st.phase === "signin" || st.phase === "setup" || st.phase === "starting") throw new Error("Discord is busy; try again in a moment.");
    st.phase = "setup";
    st.signin = { ...noSignin(), active: true, note: "Getting Discord ready…" };
    st.error = null;
    this.moved.notify();
    background(async () => {
      await this.engine.stop();
      const say = (s: string): void =>
        this.set((x) => {
          x.signin.note = s;
        });
      let err: string | undefined;
      try {
        await setup.ensureElectron(say);
        await setup.ensureShell(say);
        await setup.ensureVencord(say);
        await this.engine.start("signin", display);
      } catch (e) {
        err = message(e);
      }
      this.set((x) => {
        if (err === undefined) {
          x.phase = "signin";
          x.signin.note = "Loading sign-in…";
          x.signinAt = now();
          x.display = display;
        } else {
          x.phase = "stopped";
          x.signin.active = false;
          x.signin.error = err;
        }
      });
    });
  }

  /** The real window: password, 2FA, captcha. */
  async window(): Promise<void> {
    if (this.st.phase !== "signin") throw new Error("No sign-in is going on.");
    if (!this.st.display.any()) throw new Error("This PC has no desktop to open the sign-in window on: use the QR code, or sign in from the PC itself.");
    await this.engine.ask({ op: "show" }, 10_000);
    this.set((st) => {
      st.signin.window = true;
      st.signin.qr = null;
      st.signin.note = "Finish in Discord's window";
    });
  }

  async cancel(): Promise<void> {
    if (!this.st.signin.active) return;
    await this.engine.stop();
    this.set((st) => {
      st.signin = noSignin();
      st.phase = "stopped";
    });
  }

  /** Ends the session at Discord when it can, and removes the profile either way. */
  private signout(): void {
    rmSync(setup.accountPath(), { force: true });
    this.set((st) => {
      st.saved.attention = "";
      st.saved.failing = [];
      st.saved.attempts.clear();
    });
    this.save();
    const running = this.st.phase === "frozen" || this.st.phase === "ready";
    this.set((st) => {
      st.phase = "setup";
    });
    background(async () => {
      this.engine.resume();
      if (!running) {
        try {
          await this.engine.start("run", new Display());
          const until = Date.now() + 40_000;
          while (!this.engine.ready() && Date.now() < until) await sleep(100);
        } catch {
          // there is nothing to log out of
        }
      }
      await this.engine.ask({ op: "logout" }, 10_000).catch(() => {});
      await this.engine.stop();
      rmSync(setup.profile(), { recursive: true, force: true });
      this.set((st) => {
        st.phase = "stopped";
      });
    });
  }

  /** What the shell said on its own. */
  event(mode: Mode, m: Obj): void {
    if (mode === "scratch") return;
    switch (str(m.ev) ?? "") {
      case "fatal":
        this.set((st) => {
          st.error = str(m.error) ?? null;
        });
        break;
      case "qr":
        this.set((st) => {
          if (!st.signin.window) {
            const u = str(m.url);
            st.signin.qr = u !== undefined && u !== "" ? u : null;
            if (st.signin.qr !== null) st.signin.note = "Scan with the Discord app";
          }
        });
        break;
      case "login-page": {
        const [scanned, captcha] = [m.scanned === true, m.captcha === true];
        this.set((st) => {
          st.signin.scanned = scanned;
          st.signin.captcha = captcha;
          if (scanned) st.signin.note = "Confirm on your phone";
        });
        // A person solves it, in the real page.
        if (captcha && this.st.signin.active && !this.st.signin.window) {
          background(async () => {
            try {
              await this.window();
            } catch (e) {
              this.set((st) => {
                st.signin.note = `Discord wants a captcha. ${message(e)}`;
              });
            }
          });
        }
        break;
      }
      case "signed-in": {
        const u = get(m, "user");
        const a: setup.Account = { id: str(get(u, "id")) ?? "", username: str(get(u, "username")) ?? "", name: str(get(u, "name")) ?? "", at: now() };
        try {
          writePrivate(setup.accountPath(), JSON.stringify(a, null, 2));
        } catch {
          // the card finds no account and offers sign-in again
        }
        background(async () => {
          // Sign-in's page goes: the next tool call starts the hidden one.
          await this.engine.stop();
          this.set((st) => {
            st.signin = noSignin();
            st.phase = "stopped";
            st.saved.attention = "";
          });
          this.save();
        });
        break;
      }
      case "window-closed":
        background(() => this.cancel());
        break;
      case "signed-out":
        if (mode === "run" && this.st.phase === "ready") this.sessionEnded();
        break;
      // A page that reloaded by itself may be a new Discord.
      case "ready":
        if (mode === "run" && this.st.phase === "ready") {
          this.set((st) => {
            st.busy += 1;
          });
          background(async () => {
            this.set((st) => {
              st.chatTested = false;
            });
            let t: Test | undefined;
            try {
              t = await this.selftest();
            } catch {
              t = undefined;
            }
            this.set((st) => {
              st.busy -= 1;
            });
            if (t !== undefined) await this.judgeRunning(t);
          });
        }
        break;
      case "gone":
        this.set((st) => {
          if (st.phase === "ready" || st.phase === "frozen" || st.phase === "signin") {
            st.phase = "stopped";
            st.saved.stopped = now();
            if (st.signin.active) st.signin = { ...noSignin(), error: "Discord's sign-in stopped. Try again." };
          }
        });
        break;
    }
  }

  status(): Json {
    return statusJson(this.st, this.st.saved);
  }

  /** Idle may freeze: there's swap to push it to, and a cgroup to freeze it in. */
  private resting(): boolean {
    return this.swap() && (this.signalsRest || this.engine.canFreeze?.() !== false);
  }

  /** Tests: a SIGSTOP counts as a freeze (the fake shell has no cgroup of its own). */
  signalsRest = false;

  /** One request from the socket. */
  async handle(req: Json): Promise<Json> {
    const op = str(get(req, "op")) ?? "";
    if (op !== "status") this.touched = now();
    try {
      let r: Json;
      switch (op) {
        case "status":
          r = this.status();
          break;
        case "call":
          r = await this.call(str(get(req, "name")) ?? "", get(req, "args"), uint(get(req, "chat")) ?? null);
          break;
        case "rect":
        case "capture":
          r = await this.pageOp(req);
          break;
        case "captcha_frame":
        case "captcha_input":
        case "captcha_cancel":
          r = await this.captchaOp(op, req);
          break;
        case "chat_captcha":
          r = await this.chatCaptcha(uint(get(req, "chat")) ?? -1, get(req, "body") ?? {});
          break;
        case "signin":
          if (get(req, "accept") !== true) throw new Error("Sign-in needs the warning accepted first.");
          this.signin(Display.from(get(req, "display")));
          r = {};
          break;
        case "window":
          await this.window();
          r = {};
          break;
        case "cancel":
          await this.cancel();
          r = {};
          break;
        case "signout":
          this.signout();
          r = {};
          break;
        case "stop":
          await this.stopPage();
          r = {};
          break;
        default:
          r = await repair.handle(this, op, req);
      }
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  }

  /**
   * The clock: idle freezes, sign-in's time limit, and the host's own end. True: this host should
   * end.
   */
  async tick(): Promise<boolean> {
    const at = now();
    const { phase, lastUse: last, busy, repairing, signinAt } = this.st;
    const wait = this.resting() ? this.policy.idle : this.policy.quitIdle;
    if (phase === "ready" && !repairing && busy === 0 && at - last >= wait) await this.idle(at, last);
    if (phase === "signin" && at - signinAt > SIGNIN_WAIT) await this.cancel();
    // Frozen children keep the pipe open, so a dead client doesn't look like one by itself.
    if ((phase === "ready" || phase === "frozen") && !this.engine.alive()) await this.stopPage();
    const quiet = at - this.touched;
    const gone = phase === "stopped" && !repairing && quiet > Math.min(LINGER, Math.max(this.policy.idle, 5));
    // A new Harbor came: only a new host runs its shell.
    const replaced = (phase === "stopped" || phase === "frozen") && !repairing && exeDeleted();
    return gone || replaced;
  }

  /**
   * Nothing has used the client for a while: look for a new Vencord, then rest, unless the day's
   * logins are used up. A new Vencord needs a fresh page, so that goes first.
   */
  private async idle(at: number, last: number): Promise<void> {
    await this.countLogins();
    if (await setup.checkVencord(false)) {
      this.set((st) => {
        st.restart = true;
      });
    }
    if (this.st.restart) {
      await this.stopPage();
      return;
    }
    switch (this.policy.rest(at, last, 0, this.st.saved.logins, this.resting())) {
      case "freeze":
        await this.freeze();
        break;
      case "quit":
        await this.stopPage();
        break;
      case undefined:
        break;
    }
  }
}

function exeDeleted(): boolean {
  try {
    return readlinkSync("/proc/self/exe").endsWith(" (deleted)");
  } catch {
    return process.execPath.endsWith(" (deleted)");
  }
}

/** How long a tool may take: waits as long as they ask, uploads and typing pauses a while. */
export function callWait(name: string, args: Json): number {
  switch (name) {
    case "discord_waitForMessage":
      return Math.min(uint(get(args, "timeoutMs")) ?? 60_000, 600_000) + 5000;
    case "discord_onboarding":
      return 125_000;
    case "discord_send":
      return (uint(get(args, "typingMs")) ?? (get(args, "typing") === true ? 6000 : 0)) + 62_000;
    default:
      return CALL_WAIT;
  }
}

/**
 * The self-test's answer, keeping only names the unedited script has and known statuses: edited
 * tool code can't pass anything else (a message, say) to repair through it.
 */
export function readTest(r: Json, base: string): Test {
  const known = (k: string): boolean => base.includes(`${k}:`) || base.includes(`"${k}":`);
  const needs: [string, string][] = [];
  const missing: string[] = [];
  const later: string[] = [];
  const raw = get(r, "needs");
  for (const [k, v] of Object.entries(isObj(raw) ? raw : {})) {
    const s = str(v) ?? "";
    if (!known(k) || !["ok", "missing", "optional", "later"].includes(s)) continue;
    if (s === "missing") missing.push(k);
    if (s === "later") later.push(k);
    needs.push([k, s]);
  }
  // A page without Vencord has none of it, whatever the table above could say.
  if (get(r, "vencord") !== true) missing.push("Vencord");
  missing.sort();
  const tools = new Map<string, string[]>();
  const rawTools = get(r, "tools");
  for (const [k, v] of Object.entries(isObj(rawTools) ? rawTools : {})) {
    const names = strings(v).filter(known);
    if (k.startsWith("discord_") && known(k) && names.length > 0) tools.set(k, names);
  }
  const build = [...(str(get(r, "build")) ?? "")].filter((c) => /^[A-Za-z0-9]$/.test(c)).slice(0, 64).join("");
  const report: Json = { needs: Object.fromEntries(needs), missing, tools: Object.fromEntries(tools), build };
  return { missing, later: later.sort(), tools, build, report };
}

/** The status the card and the hub show; `st` undefined: the host isn't running. */
function statusJson(st: St | undefined, saved: Saved): Json {
  const at = now();
  const a = setup.account();
  return {
    phase: st?.phase ?? "stopped",
    setup: st?.setup ?? "",
    error: st?.error ?? null,
    signin: st?.signin ?? noSignin(),
    account: a ?? null,
    attention: saved.attention,
    failing: saved.failing,
    untested: st?.untested ?? [],
    repairing: st?.repairing ?? false,
    busy: st?.busy ?? 0,
    held: st?.held ?? "",
    captcha: st?.captcha ?? null,
    captcha_end: st?.captchaEnd ?? null,
    logins_today: saved.logins.filter((t) => at - t < DAY).length,
    vencord: setup.Vencords.load().current,
    electron: setup.ELECTRON,
  };
}

/** [`statusJson`] from what's on disk. */
export function statusOffline(): Json {
  return statusJson(undefined, loadSaved());
}


const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
const LOCK_EX = 2;
const LOCK_NB = 4;

/** The lock fd, or undefined when another host holds it for the next two seconds. */
async function takeLock(path: string): Promise<number | undefined> {
  const fd = openSync(path, "a+", 0o600);
  const until = Date.now() + 2000;
  while (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    if (Date.now() > until) {
      closeSync(fd);
      return undefined;
    }
    await sleep(50);
  }
  return fd;
}

export interface Running {
  host: Host;
  /** Resolves with the exit code when the host ends by itself. */
  done: Promise<number>;
  /** Ends it now: the engine stops, the socket goes. */
  close(): Promise<void>;
}

function serveConn(h: Host, conn: Socket): void {
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (d: string) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    const req = parse(buf.slice(0, i));
    buf = "";
    conn.removeAllListeners("data");
    if (req === undefined) return void conn.destroy();
    void h.handle(req).then((reply) => {
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
}

/** Takes the host's lock and socket for `host`, and starts its clock. Undefined: another host has them. */
export async function listen(host: Host, tickMs?: number): Promise<Running | undefined> {
  const root = setup.root();
  const lock = await takeLock(join(root, "h.lock"));
  if (lock === undefined) return undefined;
  const sock = setup.socket();
  rmSync(sock, { force: true });
  const server: Server = createServer((c) => serveConn(host, c));
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(sock, () => res());
  }).catch((e: unknown) => {
    closeSync(lock);
    throw e;
  });
  let end: (code: number) => void = () => {};
  const done = new Promise<number>((res) => {
    end = res;
  });
  let ticking = false;
  const timer = setInterval(
    () => {
      if (ticking) return;
      ticking = true;
      host
        .tick()
        .then((over) => {
          if (over) void close().then(() => end(0));
        })
        .catch((e: unknown) => process.stderr.write(`discord host: ${message(e)}\n`))
        .finally(() => {
          ticking = false;
        });
    },
    tickMs ?? (host.policy.idle < 60 ? 1000 : 10_000),
  );
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      clearInterval(timer);
      server.close();
      await host.engine.stop();
      await host.scratch.stop();
      rmSync(sock, { force: true });
      closeSync(lock);
    })();
    return closed;
  };
  return { host, done, close };
}

/** `harbor app discord-host`: one per user, held by a lock on `h.lock`. */
export async function run(): Promise<number> {
  const root = setup.root();
  // A host that died left its client, frozen perhaps: this one starts clean.
  const pid = Number.parseInt(safeRead(leftOverPath()).trim(), 10);
  const sock = setup.socket();
  const probe = await takeLock(join(root, "h.lock"));
  if (probe === undefined) return 0;
  closeSync(probe);
  if (Number.isFinite(pid) && safeRead(`/proc/${pid}/cmdline`).includes(setup.shellDir())) killLeftOver(pid);
  rmSync(leftOverPath(), { force: true });
  rmSync(join(root, "scratch"), { recursive: true, force: true });
  rmSync(sock, { force: true });
  let host: Host | undefined;
  const sink: EventSink = (mode, m) => host?.event(mode, m);
  host = new Host({ engine: new Electron(setup.profile(), sink), scratch: new Electron(join(root, "scratch"), sink) });
  const running = await listen(host);
  if (running === undefined) return 0;
  return running.done;
}
