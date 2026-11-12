// An agent's CLI kills its own background shells when its turn ends, so long-running work runs
// here: a durable runner in its own systemd scope, found again by pid and start time.
// Its exit file survives a reload too: even work completed while Harbor was away reports to its owner.
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProcRow, Store } from "@harbor/store";
import * as detach from "./detach.ts";
import { stateDir } from "./paths.ts";
import { platform, proc } from "@harbor/os";
import { procStart } from "./procfs.ts";
import { childPath } from "./providers.ts";
import * as turnscope from "./turnscope.ts";

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

  /** Stops the scope (or process group without systemd): TERM, then KILL after a grace period. */
  stop(): void {
    const pid = this.pid;
    const dir = runnerDir(this.log);
    const scope = dir === null ? undefined : turnscope.scopeOf(pid, dir);
    if (scope !== undefined) turnscope.terminate(scope);
    else signalGroup("SIGTERM", pid);
    const t = Date.now();
    const timer = setInterval(() => {
      if (scope !== undefined ? !existsSync(scope) : group(pid).length === 0) clearInterval(timer);
      else if (Date.now() - t > STOP_GRACE_MS) {
        if (scope !== undefined) turnscope.kill(scope);
        else signalGroup("SIGKILL", pid);
        clearInterval(timer);
      }
    }, 200);
  }
}

export function signalGroup(sig: NodeJS.Signals, pgid: number): void {
  // Windows: no groups and no TERM for a program without a window: the tree ends at once.
  if (platform() === "win32") {
    proc.killTree(pgid);
    return;
  }
  try {
    process.kill(-pgid, sig);
  } catch {
    // the group ended meanwhile
  }
}

/** The live processes of process group `pgid`. */
export const group = proc.group;

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
export const alive = proc.alive;

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

/** New processes use the existing detached runner; old installations recorded a single .log. */
function runnerDir(log: string): string | null {
  return basename(log) === "out" ? dirname(log) : null;
}

/** A runner's durable completion status; null while it runs (or an old process without a runner). */
function exitCode(log: string): number | null {
  const dir = runnerDir(log);
  if (dir === null) return null;
  try {
    const text = readFileSync(join(dir, "exit"), "utf8").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** Remove a completed process's private runner files together; legacy processes had only a log. */
export function cleanup(log: string): void {
  const dir = runnerDir(log);
  rmSync(dir ?? log, { recursive: dir !== null, force: true });
}

/** Watches our durable runner as well as adopted processes, which are not Harbor's children. */
function watchExit(id: number, pid: number, ticks: number, log: string, sink: ProcSink): void {
  const check = (): boolean => {
    const code = exitCode(log);
    if (code === null && alive(pid, ticks)) return false;
    sink({ type: "exited", id, code });
    return true;
  };
  // The caller installs the Proc in its engine before even an already-finished runner reports.
  setTimeout(() => {
    if (check()) return;
    const timer = setInterval(() => {
      if (check()) clearInterval(timer);
    }, 400);
    timer.unref();
  }, 0);
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
  const cmd = detach.command("bash");
  cmd.args = ["-lc", o.cmd];
  cmd.cwd = o.cwd;
  cmd.mergeOutput = true;
  cmd.env.set("PATH", childPath());
  cmd.env.set("FORCE_COLOR", "0");
  // Python and others buffer stdout without a terminal; URLs should arrive immediately.
  cmd.env.set("PYTHONUNBUFFERED", "1");
  const started = Date.now();
  // The runner loads app credentials itself: never serialize their values to cmd.json.
  // It lives outside Harbor's cgroup (as turns do), and writes its exit status before going away.
  const [dir, meta] = await detach.spawn(cmd, null, false, true, { chat_id: o.owner, kind: "Process", started: Math.floor(started / 1000), base: 0, pid: 0, pid_start: 0 }, join(logDir(), "runners"));
  const log = join(dir, "out");
  const id = store.addProc({ lead: o.lead, repoId: o.repoId, owner: o.owner, name: o.name, cmd: o.cmd, cwd: o.cwd, pid: meta.pid, startTicks: meta.pid_start, log, url: null });
  watchExit(id, meta.pid, meta.pid_start, log, sink);
  watchUrl(id, log, sink);
  capLog(log);
  return new Proc(id, o.name, o.lead, o.owner, o.cmd, meta.pid, log, null, started);
}

/** Recover running jobs and completed jobs alike: their owner still needs the completion report. */
export function adopt(store: Store, sink: ProcSink): Proc[] {
  return store.procs().map((r: ProcRow) => {
    watchExit(r.id, r.pid, r.startTicks, r.log, sink);
    capLog(r.log);
    if (r.url === null) watchUrl(r.id, r.log, sink);
    const dir = runnerDir(r.log);
    let started: number | undefined;
    if (dir !== null) {
      try {
        const meta = detach.readMeta(readFileSync(join(dir, "meta.json"), "utf8"));
        if (meta) started = meta.started * 1000;
      } catch {
        // Older processes did not keep a start timestamp.
      }
    }
    return new Proc(r.id, r.name, r.lead, r.owner, r.cmd, r.pid, r.log, r.url, started);
  });
}
