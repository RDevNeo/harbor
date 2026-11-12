// Windows' own calls through bun:ffi (kernel32, ntdll, shell32, ucrtbase), opened once and only when first
// asked, and only on Windows: every helper answers null (or an empty list) where they can't be had.
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { platform } from "../platform.ts";

const H = FFIType.u64_fast; // HANDLE / pointer-sized values, as numbers
const KERNEL32 = {
  GetCurrentProcessId: { args: [], returns: FFIType.u32 },
  CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: H },
  Process32FirstW: { args: [H, FFIType.ptr], returns: FFIType.i32 },
  Process32NextW: { args: [H, FFIType.ptr], returns: FFIType.i32 },
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: H },
  CloseHandle: { args: [H], returns: FFIType.i32 },
  GetProcessTimes: { args: [H, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  GetExitCodeProcess: { args: [H, FFIType.ptr], returns: FFIType.i32 },
  TerminateProcess: { args: [H, FFIType.u32], returns: FFIType.i32 },
  K32GetProcessMemoryInfo: { args: [H, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  QueryFullProcessImageNameW: { args: [H, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GlobalMemoryStatusEx: { args: [FFIType.ptr], returns: FFIType.i32 },
  GetTickCount64: { args: [], returns: FFIType.u64_fast },
  GetSystemTimeAsFileTime: { args: [FFIType.ptr], returns: FFIType.void },
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, H], returns: H },
  LockFileEx: { args: [H, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  UnlockFileEx: { args: [H, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  GetStdHandle: { args: [FFIType.u32], returns: H },
  SetStdHandle: { args: [FFIType.u32, H], returns: FFIType.i32 },
  SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: H },
  SetInformationJobObject: { args: [H, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  AssignProcessToJobObject: { args: [H, H], returns: FFIType.i32 },
  TerminateJobObject: { args: [H, FFIType.u32], returns: FFIType.i32 },
  QueryInformationJobObject: { args: [H, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  GetConsoleWindow: { args: [], returns: H },
  AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
} as const;
/** Windows 11 24H2 and newer only: a library of its own, so its absence elsewhere costs nothing else. */
const CONSOLE_OPTIONS = { AllocConsoleWithOptions: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } } as const;
const NTDLL = {
  NtQueryInformationProcess: { args: [H, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  NtQuerySystemInformation: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  NtSuspendProcess: { args: [H], returns: FFIType.i32 },
  NtResumeProcess: { args: [H], returns: FFIType.i32 },
} as const;
const SHELL32 = {
  CommandLineToArgvW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
} as const;
const KERNELBASE_FREE = { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } } as const;

type Lib<T extends Record<string, unknown>> = ReturnType<typeof dlopen<T & Parameters<typeof dlopen>[1]>>["symbols"];

function opener<T extends Parameters<typeof dlopen>[1]>(name: string, defs: T): () => Lib<T> | null {
  let lib: Lib<T> | null | undefined;
  return () => {
    if (lib !== undefined) return lib;
    lib = null;
    if (platform() !== "win32") return lib;
    try {
      lib = dlopen(name, defs).symbols as Lib<T>;
    } catch {
      lib = null;
    }
    return lib;
  };
}

export const kernel32 = opener("kernel32.dll", KERNEL32);
export const ntdll = opener("ntdll.dll", NTDLL);
export const shell32 = opener("shell32.dll", SHELL32);
const kfree = opener("kernel32.dll", KERNELBASE_FREE);
const consoleOptions = opener("kernel32.dll", CONSOLE_OPTIONS);

/**
 * A process without a console (Harbor started from the Start menu or by the updater: a GUI program) gets one
 * with no window. Otherwise every console program it starts (git, cmd, a shell) opens a console window of its
 * own on the desktop; with this they share the hidden one. True when there's one now. Windows 11 24H2 and
 * newer make one directly; older ones (Windows 10) borrow the windowless console of a helper started with
 * CREATE_NO_WINDOW, which then leaves (`HARBOR_WIN_CONSOLE=attach` takes that way on any Windows).
 */
export function hiddenConsole(): boolean {
  const k = kernel32();
  if (k === null) return false;
  if (!badHandle(k.GetConsoleWindow())) return true;
  // The new console takes over the standard handles: those already set (start.log, startlog.ts) are kept.
  const std = [-10, -11, -12].map((n) => [n, k.GetStdHandle(n >>> 0)] as const);
  try {
    const c = process.env.HARBOR_WIN_CONSOLE === "attach" ? null : consoleOptions();
    return c === null ? borrowConsole(k) : allocNoWindow(c);
  } finally {
    for (const [n, h] of std) if (!badHandle(h)) k.SetStdHandle(n >>> 0, h);
  }
}

function allocNoWindow(c: NonNullable<ReturnType<typeof consoleOptions>>): boolean {
  // ALLOC_CONSOLE_OPTIONS { mode: ALLOC_CONSOLE_MODE_NO_WINDOW (2), useShowWindow: 0, showWindow: 0 }
  const options = new Uint8Array(12);
  new DataView(options.buffer).setInt32(0, 2, true);
  const result = new Uint8Array(4);
  // S_OK: ALLOC_CONSOLE_RESULT_NEW_CONSOLE (1) or _EXISTING_CONSOLE (2), a console either way.
  return c.AllocConsoleWithOptions(ptr(options), ptr(result)) === 0 && new DataView(result.buffer).getInt32(0, true) !== 0;
}

const ERROR_ACCESS_DENIED = 5; // AttachConsole: this process already has a console

function borrowConsole(k: NonNullable<ReturnType<typeof kernel32>>): boolean {
  let helper: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // windowsHide with no inherited handle is CREATE_NO_WINDOW: a console that never had a window. cmd /k
    // waits on its open stdin until it's ended below.
    const cmd = `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\System32\\cmd.exe`;
    helper = Bun.spawn([cmd, "/d", "/q", "/k"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
    // The helper's console is made as it starts, a few ms after spawn returns.
    for (const until = Date.now() + 2000; Date.now() < until; Bun.sleepSync(5)) {
      if (k.AttachConsole(helper.pid) !== 0) return true;
      if (k.GetLastError() === ERROR_ACCESS_DENIED) return true;
      if (helper.exitCode !== null) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    // The console lives on while this process is attached to it.
    helper?.kill();
  }
}

export const INVALID_HANDLE = 0xffffffffffffffff;

/** A HANDLE that names nothing: NULL or INVALID_HANDLE_VALUE (-1, as a u64). */
export function badHandle(h: number | bigint): boolean {
  return h === 0 || h === 0n || h === -1 || BigInt(h) === 0xffffffffffffffffn;
}
export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_SUSPEND_RESUME = 0x0800;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const PROCESS_SET_QUOTA = 0x0100;
export const STILL_ACTIVE = 259;

/** A NUL-terminated UTF-16 string for a W call. */
export function wide(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf16le");
}

function readWide(dv: DataView, from: number, maxBytes: number): string {
  let s = "";
  for (let i = from; i + 1 < from + maxBytes; i += 2) {
    const c = dv.getUint16(i, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** One row of the system's process list. */
export interface Entry {
  pid: number;
  ppid: number;
  exe: string;
  threads: number;
}

/** Every process, with its parent and executable name (Toolhelp32). */
export function entries(): Entry[] {
  const k = kernel32();
  if (k === null) return [];
  const snap = Number(k.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0));
  if (snap === 0 || snap === INVALID_HANDLE || snap === -1) return [];
  const size = 568; // PROCESSENTRY32W on x64
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size, true);
  const out: Entry[] = [];
  try {
    if (k.Process32FirstW(snap, ptr(buf))) {
      do {
        out.push({ pid: dv.getUint32(8, true), ppid: dv.getUint32(32, true), threads: dv.getUint32(28, true), exe: readWide(dv, 44, 520) });
      } while (k.Process32NextW(snap, ptr(buf)));
    }
  } finally {
    k.CloseHandle(snap);
  }
  return out;
}

/** Runs `f` with a handle to `pid` opened for `access`; null when it can't be opened (gone, or not ours to ask). */
export function withProcess<T>(pid: number, access: number, f: (h: number) => T): T | null {
  const k = kernel32();
  if (k === null) return null;
  const h = Number(k.OpenProcess(access, 0, pid));
  if (!h) return null;
  try {
    return f(h);
  } finally {
    k.CloseHandle(h);
  }
}

/** FILETIME (100 ns since 1601) at `off`, as a number: today's values pass 2^53, so the last bits round (the same input always rounds the same). */
function filetime(dv: DataView, off: number): number {
  return dv.getUint32(off + 4, true) * 4294967296 + dv.getUint32(off, true);
}

/** When the process was created, as FILETIME (100 ns units since 1601-01-01); null when it can't be asked. */
export function creationTime(h: number): number | null {
  const k = kernel32();
  if (k === null) return null;
  // Four buffers of their own: ptr() of a subarray points at the start of its buffer, not the subarray's, so the
  // last output (CPU time, ~0 for a new process) overwrote the creation time.
  const created = new Uint8Array(8);
  const [exited, kernel, user] = [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)];
  if (!k.GetProcessTimes(h, ptr(created), ptr(exited), ptr(kernel), ptr(user))) return null;
  return filetime(new DataView(created.buffer), 0);
}

/** The process hasn't exited (its exit code is STILL_ACTIVE). */
export function stillActive(h: number): boolean {
  const k = kernel32();
  if (k === null) return false;
  const b = new Uint32Array(1);
  return !!k.GetExitCodeProcess(h, ptr(b)) && b[0] === STILL_ACTIVE;
}

/** Resident memory (the working set) in bytes. */
export function workingSet(h: number): number | null {
  const k = kernel32();
  if (k === null) return null;
  const b = new Uint8Array(72);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 72, true);
  if (!k.K32GetProcessMemoryInfo(h, ptr(b), 72)) return null;
  return Number(dv.getBigUint64(16, true));
}

/** The full path of the process's executable. */
export function imagePath(h: number): string | null {
  const k = kernel32();
  if (k === null) return null;
  const b = new Uint8Array(2 * 32768);
  const n = new Uint32Array([32768]);
  if (!k.QueryFullProcessImageNameW(h, 0, ptr(b), ptr(n))) return null;
  return Buffer.from(b.buffer, 0, (n[0] ?? 0) * 2).toString("utf16le");
}

/** The process's command line as one string (NtQueryInformationProcess, ProcessCommandLineInformation). */
export function commandLine(h: number): string | null {
  const nt = ntdll();
  if (nt === null) return null;
  let size = 4096;
  for (let tries = 0; tries < 4; tries++) {
    const b = new Uint8Array(size);
    const ret = new Uint32Array(1);
    const st = nt.NtQueryInformationProcess(h, 60, ptr(b), size, ptr(ret));
    if (st === 0) {
      const dv = new DataView(b.buffer);
      const len = dv.getUint16(0, true);
      const at = Number(dv.getBigUint64(8, true)) - (ptr(b) as number);
      if (at < 0 || at + len > size) return null;
      return Buffer.from(b.buffer, at, len).toString("utf16le");
    }
    // STATUS_INFO_LENGTH_MISMATCH / BUFFER_TOO_SMALL: grow to what it asked for.
    if ((ret[0] ?? 0) > size) size = (ret[0] ?? 0) + 64;
    else return null;
  }
  return null;
}

/** A Windows command line split as programs see it (CommandLineToArgvW). */
export function splitCommandLine(line: string): string[] | null {
  const s = shell32();
  const f = kfree();
  if (s === null || f === null) return null;
  if (line.trim() === "") return [];
  const n = new Int32Array(1);
  const argv = s.CommandLineToArgvW(ptr(wide(line)), ptr(n));
  if (argv === null) return null;
  try {
    const count = n[0] ?? 0;
    const table = new BigUint64Array(toArrayBuffer(argv, 0, count * 8));
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const p = Number(table[i]) as Pointer;
      // Up to 32767 UTF-16 units per argument: read until the NUL.
      const units = new Uint16Array(toArrayBuffer(p, 0, 65534));
      let end = 0;
      while (end < units.length && units[end] !== 0) end++;
      out.push(String.fromCharCode(...units.subarray(0, end)));
    }
    return out;
  } finally {
    f.LocalFree(argv);
  }
}

/** The Windows session (logon desktop) a process runs in. */
export function sessionOf(pid: number): number | null {
  const k = kernel32();
  if (k === null) return null;
  const b = new Uint32Array(1);
  return k.ProcessIdToSessionId(pid, ptr(b)) ? (b[0] ?? null) : null;
}

/** Physical memory: total and what programs can still get, in bytes. */
export function memoryStatus(): { total: number; available: number; pageTotal: number; pageAvail: number } | null {
  const k = kernel32();
  if (k === null) return null;
  const b = new Uint8Array(64);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 64, true);
  if (!k.GlobalMemoryStatusEx(ptr(b))) return null;
  const u = (o: number): number => Number(dv.getBigUint64(o, true));
  return { total: u(8), available: u(16), pageTotal: u(24), pageAvail: u(32) };
}

/** The current time as FILETIME (100 ns units since 1601). */
export function nowFiletime(): number | null {
  const k = kernel32();
  if (k === null) return null;
  const b = new Uint8Array(8);
  k.GetSystemTimeAsFileTime(ptr(b));
  return filetime(new DataView(b.buffer), 0);
}

/** When the machine booted, as FILETIME (SystemTimeOfDayInformation's BootTime: exact, the same all boot long). */
export function bootFiletime(): number | null {
  const nt = ntdll();
  if (nt === null) return null;
  const b = new Uint8Array(48);
  if (nt.NtQuerySystemInformation(3, ptr(b), 48, null) !== 0) return null;
  return filetime(new DataView(b.buffer), 0);
}

/** Milliseconds since the machine started. */
export function uptimeMs(): number | null {
  const k = kernel32();
  return k === null ? null : Number(k.GetTickCount64());
}

/** FILETIME 100 ns units → seconds since the Unix epoch. */
export const EPOCH_DIFF_S = 11644473600;
