// Always on in Harbor main: when the main thread (Slint's window, the hub, the store) doesn't get back to its
// event loop for STALL_MS or more, one log line says how long, what it was doing (the label it had set: Slint's
// loop, a SQLite statement, a synchronous process), and what the kernel saw meanwhile: whether the thread was
// running, waiting on the disk (page faults of a swapped-out or evicted Harbor) or sleeping, its major page
// faults and CPU time, and the PC's pressure (PSI). A Worker (@harbor/os stall.ts) samples the kernel's view while
// the main thread is stuck, so the line can tell "Harbor was busy" from "the PC starved Harbor". Costs a 100 ms
// interval on each thread.
import { Database } from "bun:sqlite";
import { stall as os } from "@harbor/os";

/** A main thread late by this much is logged. */
export const STALL_MS = 250;
/** How often the main thread says it's alive. */
export const BEAT_MS = 100;
/** At most one line per this, with a count of the ones left out. */
const QUIET_MS = 2000;

// Shared slots, in step with @harbor/os stallworker.ts.
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

let v: Int32Array | null = null;
let wbytes: Uint8Array | null = null;
let whatBytes: Uint8Array | null = null;
let worker: Worker | null = null;
let stallLimit = Number.POSITIVE_INFINITY;
const labels: string[] = [""];
const codes = new Map<string, number>();

/** What a stall line holds; also kept for tests and a status read. */
export interface Stall {
  ms: number;
  label: string;
  running: number;
  disk: number;
  sleeping: number;
  majorFaults: number;
  cpuMs: number;
  wchan: string;
  /** The file syscall it was in, with its file: "read /usr/share/fonts/…". */
  syscall: string;
  pressure: string;
  /** HARBOR_STALL_PROFILE: the JavaScript it was running, its hottest call chains ("" otherwise). */
  js: string;
}

/** The last stalls (newest last), and how many there were since start. */
export const seen: { last: Stall[]; count: number; worstMs: number } = { last: [], count: 0, worstMs: 0 };

/** Labels kept apart; past this, new ones share one (SQL built with values in it mustn't grow the table forever). */
const MAX_LABELS = 2000;

function code(name: string): number {
  let c = codes.get(name);
  if (c === undefined) {
    if (labels.length >= MAX_LABELS) return code("(other labels)");
    c = labels.length;
    labels.push(name);
    codes.set(name, c);
    worker?.postMessage({ label: name, code: c });
  }
  return c;
}

/** Runs `f` with the main thread labelled `name`, for a stall that happens inside it. Nests. */
export function within<T>(name: string, f: () => T): T {
  if (v === null) return f();
  const prev = v[LABEL] ?? 0;
  const c = code(name);
  Atomics.store(v, LABEL, c);
  // No sampler (Windows, macOS): the label notes itself when it held the thread past a stall, the innermost first.
  const t = worker === null ? performance.now() : 0;
  try {
    return f();
  } finally {
    Atomics.store(v, LABEL, prev);
    if (worker === null && performance.now() - t >= stallLimit && Atomics.load(v, SEEN) === 0) Atomics.store(v, SEEN, c);
  }
}

export function describe(s: Stall): string {
  const where = s.label || "between labels";
  const kernel = s.running + s.disk + s.sleeping > 0 ? `; samples running ${s.running}, disk ${s.disk}, sleeping ${s.sleeping}${s.wchan ? ` (${s.wchan})` : ""}${s.syscall ? `, in ${s.syscall}` : ""}` : "";
  return `harbor: main thread blocked ${Math.round(s.ms)} ms in ${where}${kernel}; ${s.majorFaults} major faults, ${s.cpuMs} ms CPU${s.pressure ? `; pressure ${s.pressure}` : ""}${s.js ? `; js ${s.js}` : ""}`;
}

interface Frame {
  name?: string;
  sourceURL?: string;
  line?: number;
}
type Traces = { traces?: { frames?: Frame[] }[] };

/**
 * JavaScriptCore's sampler, for HARBOR_STALL_PROFILE=1 (where the kernel can't say what the main thread did:
 * Windows, macOS; or to see the JavaScript anywhere). Each beat takes the samples since the last one; a stall's
 * line then names its hottest call chains. A rig and bug-hunt switch: sampling costs a few % CPU.
 */
function jsSampler(env: Record<string, string | undefined> = process.env): (() => Traces) | null {
  if (env.HARBOR_STALL_PROFILE !== "1") return null;
  try {
    const jsc = require("bun:jsc") as { startSamplingProfiler(dir?: string, us?: number): void; samplingProfilerStackTraces(): Traces };
    jsc.startSamplingProfiler(undefined, 2000);
    return () => jsc.samplingProfilerStackTraces();
  } catch {
    return null;
  }
}

/** The samples' commonest call chains (innermost 4 frames with a source), with their share: "f a.ts:3 < g b.ts:9 (80%)". */
export function hottest(t: Traces, top = 2): string {
  const chains = new Map<string, number>();
  let n = 0;
  for (const tr of t.traces ?? []) {
    const frames = (tr.frames ?? []).filter((f) => f.sourceURL !== undefined && f.sourceURL !== "");
    const native = (tr.frames ?? [])[0];
    const head = native !== undefined && native.sourceURL === undefined && native.name ? [`${native.name} (native)`] : [];
    const at = (f: Frame) => `${f.name || "(anonymous)"} ${String(f.sourceURL).split(/[\\/]/).pop()}:${f.line ?? 0}`;
    const key = [...head, ...frames.slice(0, 4).map(at)].join(" < ");
    if (key === "") continue;
    n++;
    chains.set(key, (chains.get(key) ?? 0) + 1);
  }
  if (n === 0) return "";
  return [...chains]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, c]) => `${k} (${Math.round((c / n) * 100)}%)`)
    .join(" | ");
}

/** Labels synchronous process starts and SQLite statements, the usual ways the main thread waits on the disk. */
function hookBlocking(): void {
  const b = Bun as unknown as { spawnSync: (...a: unknown[]) => unknown };
  const spawnSync = b.spawnSync;
  try {
    b.spawnSync = function (this: unknown, ...a: unknown[]): unknown {
      const first = a[0];
      const argv = Array.isArray(first) ? first : (first as { cmd?: unknown[] } | undefined)?.cmd;
      const name = String(argv?.[0] ?? "?").split("/").pop() ?? "?";
      return within(`spawnSync ${name}`, () => spawnSync.apply(this, a));
    };
  } catch {
    // read-only in some build: unlabelled then
  }
}

let wrappedDb = false;
/** Labels every statement of bun:sqlite databases made from now on. */
export function hookSqlite(): void {
  if (wrappedDb) return;
  wrappedDb = true;
  const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const done = new WeakSet<object>();
  // The statement's start, as the label: "sqlite SELECT … FROM items WHERE chat_id=?".
  const name = (sql: unknown): string => `sqlite ${String(sql).replace(/\s+/g, " ").trim().slice(0, 90)}`;
  const wrapStmt = (st: unknown, label: string): unknown => {
    if (st === null || typeof st !== "object" || done.has(st)) return st;
    done.add(st);
    const o = st as Record<string, unknown>;
    for (const k of ["all", "get", "run", "values"]) {
      const f = o[k];
      if (typeof f === "function") o[k] = (...a: unknown[]) => within(label, () => (f as (...x: unknown[]) => unknown).apply(st, a));
    }
    return st;
  };
  for (const k of ["query", "prepare"]) {
    const f = proto[k];
    if (typeof f === "function")
      proto[k] = function (this: unknown, ...a: unknown[]) {
        const label = name(a[0]);
        return wrapStmt(within(label, () => f.apply(this, a)), label);
      };
  }
  for (const k of ["run", "exec"]) {
    const f = proto[k];
    if (typeof f === "function") proto[k] = function (this: unknown, ...a: unknown[]) { return within(name(a[0]), () => f.apply(this, a)); };
  }
}

/**
 * Starts watching. `log` gets one line per stall (at most one per QUIET_MS; the rest are counted into the next).
 * Returns a stop function. Linux reads the main thread's state; elsewhere the line has the duration and label only.
 */
export function start(log: (line: string) => void = (l) => console.error(l), o: { stallMs?: number; beatMs?: number; quietMs?: number } = {}): () => void {
  if (v !== null) return () => {};
  const stallMs = o.stallMs ?? STALL_MS;
  stallLimit = stallMs;
  const beatMs = o.beatMs ?? BEAT_MS;
  // HARBOR_STALL_QUIET_MS=0 (rigs): every stall gets its line.
  const quietEnv = Number(process.env.HARBOR_STALL_QUIET_MS ?? "");
  const quietMs = o.quietMs ?? (process.env.HARBOR_STALL_QUIET_MS && quietEnv >= 0 ? quietEnv : QUIET_MS);
  const buf = new SharedArrayBuffer(WCHAN * 4 + WCHAN_BYTES + WHAT_BYTES);
  v = new Int32Array(buf, 0, WCHAN);
  wbytes = new Uint8Array(buf, WCHAN * 4, WCHAN_BYTES);
  whatBytes = new Uint8Array(buf, WCHAN * 4 + WCHAN_BYTES, WHAT_BYTES);
  const base = Date.now();
  hookBlocking();
  const source = os.samplerSource();
  if (source !== null) {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: "application/typescript" })));
      worker.unref();
      worker.postMessage({ buf, base, tid: os.mainThread(), beatMs, stallMs, labels });
    } catch {
      worker = null;
    }
  }
  const samples = jsSampler();
  let prev = performance.now();
  let held = 0;
  let lastLog = Number.NEGATIVE_INFINITY;
  const id = setInterval(() => {
    const t = performance.now();
    const late = t - prev - beatMs;
    prev = t;
    const s = v;
    if (s === null) return;
    Atomics.store(s, BEAT, Date.now() - base);
    const traces = samples?.() ?? null;
    if (late < stallMs) return;
    const stall: Stall = {
      ms: late,
      label: labels[Atomics.load(s, SEEN)] ?? "",
      running: Atomics.load(s, RUN),
      disk: Atomics.load(s, DISK),
      sleeping: Atomics.load(s, SLEEP),
      majorFaults: Atomics.load(s, MAJ),
      cpuMs: Atomics.load(s, CPU) * 10,
      wchan: wbytes ? new TextDecoder().decode(wbytes).replace(/\0.*$/s, "") : "",
      syscall: whatBytes ? new TextDecoder().decode(whatBytes).replace(/\0.*$/s, "") : "",
      pressure: os.pressure(),
      js: traces === null ? "" : hottest(traces),
    };
    for (const k of [RUN, DISK, SLEEP, MAJ, CPU, SEEN]) Atomics.store(s, k, 0);
    wbytes?.fill(0);
    whatBytes?.fill(0);
    seen.count++;
    seen.worstMs = Math.max(seen.worstMs, late);
    seen.last.push(stall);
    if (seen.last.length > 20) seen.last.shift();
    if (t - lastLog < quietMs) {
      held++;
      return;
    }
    lastLog = t;
    log(describe(stall) + (held > 0 ? ` (+${held} more not shown)` : ""));
    held = 0;
  }, beatMs);
  return () => {
    clearInterval(id);
    worker?.terminate();
    worker = null;
    v = null;
    wbytes = null;
    whatBytes = null;
  };
}

/**
 * HARBOR_MEMTRACE=SECS (rigs, leak hunts): every SECS a line with RSS, swap, the JavaScript heap, open fds and
 * threads, and the object types that grew most since the first line.
 */
export function memTrace(log: (line: string) => void = (l) => console.error(l), secs: number = Number(process.env.HARBOR_MEMTRACE ?? 0)): () => void {
  if (!(secs > 0)) return () => {};
  let base: Record<string, number> | null = null;
  const id = setInterval(() => {
    void import("bun:jsc").then((jsc) => {
      const h = jsc.heapStats();
      const mem = os.selfMemoryKb();
      const handles = os.handles();
      const counts = h.objectTypeCounts as Record<string, number>;
      base ??= { ...counts };
      const grew = Object.entries(counts)
        .map(([k, n]) => [k, n - (base?.[k] ?? 0)] as const)
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, d]) => `${k}+${d}`)
        .join(" ");
      log(
        `harbor: mem rss ${Math.round(mem.rss / 1024)} MB swap ${Math.round(mem.swap / 1024)} MB heap ${Math.round(h.heapSize / 2 ** 20)}/${Math.round(h.heapCapacity / 2 ** 20)} MB ` +
          `objects ${h.objectCount} protected ${h.protectedObjectCount} fds ${handles.fds} threads ${handles.threads} grew: ${grew}`,
      );
    });
  }, secs * 1000);
  (id as { unref?: () => void }).unref?.();
  return () => clearInterval(id);
}
