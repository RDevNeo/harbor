// macOS's answers for proc.ts and sys.ts: processes from libproc and sysctl (bun:ffi, nothing spawned),
// memory from sysctl and vm_stat. Loaded only on macOS.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawnSync } from "node:child_process";

const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
}).symbols;

const PROC_PIDTBSDINFO = 3;
const PROC_PIDTASKINFO = 4;
/** sizeof(struct proc_bsdinfo) and sizeof(struct proc_taskinfo). */
const BSDINFO_SIZE = 136;
const TASKINFO_SIZE = 96;
const CTL_KERN = 1;
const KERN_PROCARGS2 = 49;
const KERN_ARGMAX = 8;

export function pids(): number[] {
  for (let room = 4096; room <= 1 << 20; room *= 4) {
    const buf = new Int32Array(room);
    const n = lib.proc_listallpids(ptr(buf), buf.byteLength);
    if (n <= 0) return [];
    if (n < room) return [...buf.subarray(0, n)].filter((p) => p > 0);
  }
  return [];
}

/** One process (struct proc_bsdinfo), or undefined once it's gone. */
export interface BsdInfo {
  /** SIDL 1, SRUN 2, SSLEEP 3, SSTOP 4, SZOMB 5. */
  status: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** When it started, in microseconds since the epoch. */
  start: number;
}

export function bsdInfo(pid: number): BsdInfo | undefined {
  const buf = new Uint8Array(BSDINFO_SIZE);
  if (lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(buf), BSDINFO_SIZE) !== BSDINFO_SIZE) return undefined;
  const v = new DataView(buf.buffer);
  const sec = Number(v.getBigUint64(120, true));
  const usec = Number(v.getBigUint64(128, true));
  return { status: v.getUint32(4, true), ppid: v.getUint32(16, true), uid: v.getUint32(20, true), pgid: v.getUint32(100, true), start: sec * 1_000_000 + usec };
}

/** Resident memory in bytes; undefined when it can't be read (another user's process). */
export function residentBytes(pid: number): number | undefined {
  const buf = new Uint8Array(TASKINFO_SIZE);
  if (lib.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, ptr(buf), TASKINFO_SIZE) !== TASKINFO_SIZE) return undefined;
  return Number(new DataView(buf.buffer).getBigUint64(8, true));
}

function sysctl(mib: number[], size: number): Buffer | undefined {
  const name = new Int32Array(mib);
  const out = Buffer.alloc(size);
  const len = new BigUint64Array([BigInt(size)]);
  if (lib.sysctl(ptr(name), mib.length, ptr(out), ptr(len), null, 0) !== 0) return undefined;
  return out.subarray(0, Number(len[0]));
}

let argMax = 0;

/** The process's arguments (KERN_PROCARGS2: argc, the executable's path, then argv), or undefined. */
export function args(pid: number): string[] | undefined {
  if (argMax === 0) argMax = sysctl([CTL_KERN, KERN_ARGMAX], 4)?.readInt32LE(0) ?? 262_144;
  const b = sysctl([CTL_KERN, KERN_PROCARGS2, pid], argMax);
  if (b === undefined || b.length < 4) return undefined;
  const argc = b.readInt32LE(0);
  let i = 4;
  // The executable's path, then NUL padding.
  while (i < b.length && b[i] !== 0) i++;
  while (i < b.length && b[i] === 0) i++;
  const out: string[] = [];
  while (out.length < argc && i < b.length) {
    const end = b.indexOf(0, i);
    const stop = end < 0 ? b.length : end;
    out.push(b.subarray(i, stop).toString("utf8"));
    i = stop + 1;
  }
  return out;
}

/** When the system booted, as kern.boottime says it ("sec.usec"); "" when unknown. */
export function bootTime(): string {
  const r = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000 });
  const m = /sec = (\d+), usec = (\d+)/.exec(r.stdout ?? "");
  return m ? `${m[1]}.${m[2]}` : "";
}

/** `sysctl hw.memsize vm.swapusage` and `vm_stat`'s text, as the memory reader parses it. */
export function memoryText(): string {
  const a = spawnSync("sysctl", ["hw.memsize", "vm.swapusage"], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
  const b = spawnSync("vm_stat", [], { encoding: "utf8", timeout: 5000 }).stdout ?? "";
  return `${a}\n${b}`;
}
