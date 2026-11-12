// A Worker for @harbor/store stallwatch.ts (started through stall.ts here): watches the main thread's heartbeat and, while it is late, samples the main
// thread's state from /proc (running, waiting on the disk, sleeping), its major page faults and CPU time, and
// which label it had set. Stalls that last say so on their own (the main thread can't while it is stuck).
import { closeSync, openSync, readFileSync, readlinkSync, readSync } from "node:fs";

declare const self: Worker;

interface Init {
  buf: SharedArrayBuffer;
  base: number;
  tid: number;
  beatMs: number;
  stallMs: number;
  labels: string[];
}

// Keep in step with @harbor/store stallwatch.ts.
const BEAT = 0;
const LABEL = 1;
const RUN = 2;
const DISK = 3;
const SLEEP = 4;
const MAJ = 5;
const CPU = 6;
const SEEN = 7;
const WCHAN = 8;
const WCHAN_BYTES = 48;
const WHAT_BYTES = 200;

let labels: string[] = [];

function stat(tid: number): { state: string; maj: number; cpu: number } | null {
  try {
    const s = readFileSync(`/proc/self/task/${tid}/stat`, "utf8");
    // Fields after the command name, which may hold spaces: state is field 3, majflt 12, utime 14, stime 15.
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return { state: f[0] ?? "?", maj: Number(f[9]), cpu: Number(f[11]) + Number(f[12]) };
  } catch {
    return null;
  }
}

function wchan(tid: number): string {
  try {
    const w = readFileSync(`/proc/self/task/${tid}/wchan`, "utf8").trim();
    return w === "0" ? "" : w;
  } catch {
    return "";
  }
}

// Syscalls a stuck main thread is worth naming: name, then which argument says what (1-based in
// /proc/PID/syscall's list) and whether it is an fd or a path.
type Call = [string, number, "fd" | "path"];
const X64: Record<number, Call> = {
  0: ["read", 1, "fd"], 1: ["write", 1, "fd"], 17: ["pread", 1, "fd"], 18: ["pwrite", 1, "fd"], 19: ["readv", 1, "fd"], 20: ["writev", 1, "fd"],
  74: ["fsync", 1, "fd"], 75: ["fdatasync", 1, "fd"], 5: ["fstat", 1, "fd"], 217: ["getdents", 1, "fd"],
  2: ["open", 1, "path"], 4: ["stat", 1, "path"], 6: ["lstat", 1, "path"], 89: ["readlink", 1, "path"],
  257: ["openat", 2, "path"], 262: ["stat", 2, "path"], 332: ["statx", 2, "path"],
};
const ARM64: Record<number, Call> = {
  63: ["read", 1, "fd"], 64: ["write", 1, "fd"], 67: ["pread", 1, "fd"], 68: ["pwrite", 1, "fd"], 65: ["readv", 1, "fd"], 66: ["writev", 1, "fd"],
  82: ["fsync", 1, "fd"], 83: ["fdatasync", 1, "fd"], 80: ["fstat", 1, "fd"], 61: ["getdents", 1, "fd"],
  56: ["openat", 2, "path"], 79: ["stat", 2, "path"], 291: ["statx", 2, "path"], 78: ["readlink", 2, "path"],
};
const CALLS: Record<number, Call> = process.arch === "arm64" ? ARM64 : process.arch === "x64" ? X64 : {};

/** A C string at `addr` in this process's own memory. */
function cString(addr: number): string {
  let fd = -1;
  try {
    fd = openSync("/proc/self/mem", "r");
    const b = Buffer.alloc(256);
    const n = readSync(fd, b, 0, b.length, addr);
    const end = b.indexOf(0);
    return b.subarray(0, end < 0 ? n : Math.min(end, n)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The file the thread waits on, when it waits in a file syscall: "read /path/to/file" (the fd's target, or the path asked for). */
export function syscallOf(tid: number): string {
  try {
    const f = readFileSync(`/proc/self/task/${tid}/syscall`, "utf8").trim().split(" ");
    const call = CALLS[Number(f[0])];
    if (call === undefined) return "";
    const arg = Number.parseInt(f[call[1]] ?? "", 16);
    if (!Number.isFinite(arg)) return call[0];
    if (call[2] === "fd") {
      try {
        return `${call[0]} ${readlinkSync(`/proc/self/fd/${arg}`)}`;
      } catch {
        return `${call[0]} fd ${arg}`;
      }
    }
    return `${call[0]} ${cString(arg)}`;
  } catch {
    return "";
  }
}

self.onmessage = (e: MessageEvent<Init | { label: string; code: number }>) => {
  const m = e.data;
  if ("code" in m) {
    labels[m.code] = m.label;
    return;
  }
  labels = m.labels;
  const v = new Int32Array(m.buf);
  const w = new Uint8Array(m.buf, WCHAN * 4, WCHAN_BYTES);
  const what = new Uint8Array(m.buf, WCHAN * 4 + WCHAN_BYTES, WHAT_BYTES);
  const enc = new TextEncoder();
  let first: { maj: number; cpu: number } | null = null;
  // Samples per label (0: none) in this stall: the line names the one seen most.
  const byLabel = new Map<number, number>();
  let since = 0;
  let told = 0;
  const every = Math.max(20, Math.round(m.stallMs / 5));
  setInterval(() => {
    const age = Date.now() - m.base - Atomics.load(v, BEAT);
    if (age < m.beatMs + every * 2) {
      first = null;
      byLabel.clear();
      told = 0;
      return;
    }
    const s = stat(m.tid);
    if (s === null) return;
    if (first === null) {
      first = { maj: s.maj, cpu: s.cpu };
      since = age;
      told = 0;
    }
    Atomics.add(v, s.state === "R" ? RUN : s.state === "D" ? DISK : SLEEP, 1);
    Atomics.store(v, MAJ, s.maj - first.maj);
    Atomics.store(v, CPU, s.cpu - first.cpu);
    const label = Atomics.load(v, LABEL);
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    let top = 0;
    let most = 0;
    for (const [k, n] of byLabel) if (n > most) [top, most] = [k, n];
    Atomics.store(v, SEEN, top);
    if (s.state !== "R") {
      const name = wchan(m.tid);
      if (name !== "") {
        w.fill(0);
        enc.encodeInto(name.slice(0, WCHAN_BYTES - 1), w);
      }
      const call = syscallOf(m.tid);
      if (call !== "") {
        what.fill(0);
        enc.encodeInto(call.slice(0, WHAT_BYTES - 4), what);
      }
    }
    // A long one: 3 s, 10 s, 30 s, then every minute.
    const marks = [3000, 10_000, 30_000];
    const due = told < marks.length ? (marks[told] ?? 0) : 30_000 + (told - marks.length + 1) * 60_000;
    if (age >= due) {
      told++;
      const seen = labels[Atomics.load(v, SEEN)] ?? "";
      const wc = new TextDecoder().decode(w).replace(/\0.*$/s, "");
      const doing = new TextDecoder().decode(what).replace(/\0.*$/s, "");
      console.error(
        `harbor: main thread still blocked after ${(age / 1000).toFixed(1)} s (${seen || "unlabelled"}; ` +
          `samples running ${Atomics.load(v, RUN)}, disk ${Atomics.load(v, DISK)}, sleeping ${Atomics.load(v, SLEEP)}` +
          `${wc ? `, waiting in ${wc}` : ""}${doing ? `, ${doing}` : ""}; ${Atomics.load(v, MAJ)} major faults, ${Atomics.load(v, CPU) * 10} ms CPU since ${(since / 1000).toFixed(1)} s)`,
      );
    }
  }, every);
};
