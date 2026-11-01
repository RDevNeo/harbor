// An agent's CLI kills its own background shells when its turn ends, so long-running work runs
// here: its own process group, outliving Harbor, found again by pid and start time.
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ProcRow, Store } from "@harbor/store";
import { agentEnv } from "./detach.ts";
import { newUuid, stateDir } from "./paths.ts";
import { pids, procStart } from "./procfs.ts";
import { childPath } from "./providers.ts";

export type ProcEvent = { type: "url"; id: number; url: string } | { type: "exited"; id: number; code: number | null };
export type ProcSink = (ev: ProcEvent) => void;

/** How long a stopped process group gets to exit after TERM before it is killed. */
const STOP_GRACE_MS = 5000;
/** A log beyond this keeps only its last LOG_KEEP bytes (only its end is read). */
const LOG_MAX = 8 * 1024 * 1024;
const LOG_KEEP = 1024 * 1024;

export class Proc {
  constructor(
    readonly id: number,
    readonly name: string,
    /** The team's lead (a project's thread, or a project-less one). */
    readonly lead: number,
    /** The chat that started it; it gets the exit event. */
    readonly owner: number,
    readonly cmd: string,
    readonly pid: number,
    readonly log: string,
    public url: string | null,
    readonly started: number = Date.now(),
  ) {}

  /** Last `n` lines of output (reads only the end of the log). */
  tail(n: number): string {
    return tailFile(this.log, n);
  }

  /** Stops the whole process group (npm → node → vite…): TERM, and KILL for whatever is still in it a few seconds later. */
  stop(): void {
    const pid = this.pid;
    signalGroup("SIGTERM", pid);
    const t = Date.now();
    const timer = setInterval(() => {
      if (group(pid).length === 0) clearInterval(timer);
      else if (Date.now() - t > STOP_GRACE_MS) {
        signalGroup("SIGKILL", pid);
        clearInterval(timer);
      }
    }, 200);
  }
}

export function signalGroup(sig: NodeJS.Signals, pgid: number): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // the group ended meanwhile
  }
}

/** The live processes of process group `pgid` (field 5 of /proc/<pid>/stat). */
export function group(pgid: number): number[] {
  const out: number[] = [];
  for (const p of pids()) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${p}/stat`, "utf8");
    } catch {
      continue;
    }
    const i = stat.lastIndexOf(")");
    if (i < 0) continue;
    const f = stat.slice(i + 1).trim().split(/\s+/);
    if ((f[0] ?? "Z") !== "Z" && f[2] === String(pgid)) out.push(p);
  }
  return out;
}

/** Cuts `path` down to its last `keep` bytes, in place: the process writes with O_APPEND, so its next output lands after them. */
export function trim(path: string, keep: number): void {
  const fd = openSync(path, "r+");
  try {
    const len = statSync(path).size;
    const from = Math.max(0, len - keep);
    const tail = Buffer.alloc(len - from);
    let got = 0;
    while (got < tail.length) {
      const n = readSync(fd, tail, got, tail.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    // From the first whole line on.
    const nl = tail.indexOf(10);
    const rest = tail.subarray(nl < 0 ? 0 : nl + 1, got);
    ftruncateSync(fd, 0);
    writeSync(fd, Buffer.from("[… earlier output cut by Harbor]\n"), 0, undefined, 0);
    writeSync(fd, rest, 0, rest.length, Buffer.byteLength("[… earlier output cut by Harbor]\n"));
  } finally {
    closeSync(fd);
  }
}

/** Keeps a process's log small while it runs; ends once the log is gone. */
function capLog(log: string): void {
  const timer = setInterval(() => {
    let len: number;
    try {
      len = statSync(log).size;
    } catch {
      clearInterval(timer);
      return;
    }
    if (len > LOG_MAX) {
      try {
        trim(log, LOG_KEEP);
      } catch {
        // tried again in 30 s
      }
    }
  }, 30_000);
  timer.unref();
}

export function logDir(): string {
  return join(stateDir(), "procs");
}

function readTail(path: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const len = statSync(path).size;
    const from = Math.max(0, len - max);
    const buf = Buffer.alloc(len - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function tailFile(path: string, n: number): string {
  const lines = rustLines(stripAnsi(readTail(path, 64 * 1024)));
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** Rust's `str::lines`: no empty last line for a trailing newline. */
function rustLines(s: string): string[] {
  if (s === "") return [];
  const v = s.split("\n");
  if (v[v.length - 1] === "") v.pop();
  return v;
}

export const startTicks = procStart;

/** The process that started at `ticks` still runs (a zombie has ended). */
export function alive(pid: number, ticks: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const i = stat.lastIndexOf(")");
  if (i >= 0 && stat.slice(i + 1).trimStart().startsWith("Z")) return false;
  return procStart(pid) === ticks;
}

/** First http(s) URL on this machine in a line of output. */
export function localUrl(line: string): string | null {
  for (const start of ["http://", "https://"]) {
    let from = 0;
    for (;;) {
      const i = line.indexOf(start, from);
      if (i < 0) break;
      let url = "";
      for (const c of line.slice(i)) {
        if (/\s/.test(c) || c === '"' || c === "'" || c === ")" || c === "," || c === ">") break;
        url += c;
      }
      const host = url.split("://")[1] ?? "";
      if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].some((h) => host.startsWith(h)))
        return url.replaceAll("0.0.0.0", "localhost").replaceAll("[::]", "localhost").replace(/\.+$/, "");
      from = i + start.length;
    }
  }
  return null;
}

export function stripAnsi(s: string): string {
  let out = "";
  const cs = [...s];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] as string;
    if (c === "\x1b") {
      if (cs[i + 1] === "[") {
        i++;
        while (++i < cs.length) {
          const d = cs[i] as string;
          if (d >= "@" && d <= "~") break;
        }
      }
    } else if (c !== "\r") out += c;
  }
  return out;
}

/** Reads new log output until it finds a local URL (or gives up after ten minutes). */
function watchUrl(id: number, log: string, sink: ProcSink): void {
  let offset = 0;
  let tries = 0;
  const timer = setInterval(() => {
    if (++tries > 1500) return clearInterval(timer);
    let size: number;
    try {
      size = statSync(log).size;
    } catch {
      return clearInterval(timer);
    }
    // Cut down meanwhile (capLog): read it again from the start.
    if (size < offset) offset = 0;
    if (size === offset) return;
    const text = readRange(log, offset, size);
    offset = size;
    const url = rustLines(stripAnsi(text)).map(localUrl).find((u) => u !== null);
    if (url) {
      clearInterval(timer);
      sink({ type: "url", id, url });
    }
  }, 400);
  timer.unref();
}

function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** For processes adopted after a restart (not our children): polls the pid. */
function watchExit(id: number, pid: number, ticks: number, sink: ProcSink): void {
  const timer = setInterval(() => {
    if (alive(pid, ticks)) return;
    clearInterval(timer);
    sink({ type: "exited", id, code: null });
  }, 2000);
}

export interface SpawnOpts {
  name: string;
  cmd: string;
  cwd: string;
  repoId: number | null;
  lead: number;
  owner: number;
}

export async function spawn(store: Store, o: SpawnOpts, sink: ProcSink): Promise<Proc> {
  const dir = logDir();
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${newUuid()}.log`);
  // Owner-only: dev servers print secrets (database URLs, tokens) too.
  const env: Record<string, string | undefined> = { ...process.env };
  // Agents start these: same credentials as the agent itself.
  for (const [k, v] of await agentEnv(true)) {
    if (v === null || v === undefined) delete env[k];
    else env[k] = v;
  }
  env.PATH = childPath();
  env.FORCE_COLOR = "0";
  // Python and others buffer stdout when it is not a terminal; URLs would arrive late.
  env.PYTHONUNBUFFERED = "1";
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    // detached: its own session and process group, so stop() reaches every child and it outlives Harbor.
    child = Bun.spawn(["bash", "-lc", o.cmd], { cwd: o.cwd, env, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
  } finally {
    closeSync(fd);
  }
  const pid = child.pid;
  const id = store.addProc({ lead: o.lead, repoId: o.repoId, owner: o.owner, name: o.name, cmd: o.cmd, cwd: o.cwd, pid, startTicks: startTicks(pid) ?? 0, log, url: null });
  void child.exited.then(() => sink({ type: "exited", id, code: child.exitCode }));
  child.unref();
  watchUrl(id, log, sink);
  capLog(log);
  return new Proc(id, o.name, o.lead, o.owner, o.cmd, pid, log, null);
}

/** Processes from a previous Harbor run that are still alive; the rest are dropped. */
export function adopt(store: Store, sink: ProcSink): Proc[] {
  const out: Proc[] = [];
  for (const r of store.procs() as ProcRow[]) {
    if (!alive(r.pid, r.startTicks)) {
      store.deleteProc(r.id);
      rmSync(r.log, { force: true });
      continue;
    }
    watchExit(r.id, r.pid, r.startTicks, sink);
    capLog(r.log);
    if (r.url === null) watchUrl(r.id, r.log, sink);
    out.push(new Proc(r.id, r.name, r.lead, r.owner, r.cmd, r.pid, r.log, r.url));
  }
  return out;
}
