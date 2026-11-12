// The C library through bun:ffi, opened once and only when first asked. POSIX calls come from the
// system's libc (glibc or musl on Linux, libSystem on macOS); glibc's own allocator controls only from
// glibc. Each returns null (or false) where the call doesn't exist, so callers fall back instead of failing.
import { dlopen, FFIType } from "bun:ffi";
import { platform } from "./platform.ts";

export const LOCK_EX = 2;
export const LOCK_NB = 4;

const POSIX = {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  dup: { args: [FFIType.i32], returns: FFIType.i32 },
  dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
} as const;

type Posix = ReturnType<typeof dlopen<typeof POSIX>>["symbols"];

/** The library names to try, in order. */
export function libcNames(p = platform()): string[] {
  if (p === "darwin") return ["libSystem.B.dylib"];
  if (p === "win32") return [];
  return ["libc.so.6", "libc.so"];
}

let posix: Posix | null | undefined;

function lib(): Posix | null {
  if (posix !== undefined) return posix;
  posix = null;
  for (const name of libcNames()) {
    try {
      posix = dlopen(name, POSIX).symbols;
      break;
    } catch {
      // not this libc's name: try the next
    }
  }
  return posix;
}

/** flock(2) on `fd`; null when there's no libc to ask. */
export function flock(fd: number, op: number): number | null {
  const l = lib();
  return l === null ? null : l.flock(fd, op);
}

/**
 * Sets a variable in the C environment, which native libraries read and Bun's process.env doesn't
 * reach. An existing value is kept unless `overwrite`. False when it couldn't be set.
 */
export function setenv(name: string, value: string, overwrite = false): boolean {
  const l = lib();
  return l !== null && l.setenv(Buffer.from(`${name}\0`), Buffer.from(`${value}\0`), overwrite ? 1 : 0) === 0;
}

/** Whether descriptors can be duplicated and redirected (dup, dup2, close): a POSIX libc is there. */
export function redirectable(): boolean {
  return lib() !== null;
}

/** dup(2); null without a libc. */
export function dup(fd: number): number | null {
  const l = lib();
  return l === null ? null : l.dup(fd);
}

/** dup2(2); null without a libc. */
export function dup2(from: number, to: number): number | null {
  const l = lib();
  return l === null ? null : l.dup2(from, to);
}

/** close(2) on a raw descriptor; null without a libc. */
export function close(fd: number): number | null {
  const l = lib();
  return l === null ? null : l.close(fd);
}

const GLIBC = {
  gnu_get_libc_version: { args: [], returns: FFIType.cstring },
  mallopt: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  malloc_trim: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

/** glibc's own calls. */
export interface Glibc {
  /** "2.39" and such. */
  version: string;
  mallopt: (param: number, value: number) => number;
  malloc_trim: (pad: number) => number;
}

let glibcLib: Glibc | null | undefined;

/** glibc, when this is Linux with glibc (gnu_get_libc_version only exists there: a musl libc.so.6 shim fails). */
export function glibc(): Glibc | null {
  if (glibcLib !== undefined) return glibcLib;
  glibcLib = null;
  if (platform() !== "linux") return glibcLib;
  try {
    const s = dlopen("libc.so.6", GLIBC).symbols;
    glibcLib = { version: String(s.gnu_get_libc_version()), mallopt: s.mallopt, malloc_trim: s.malloc_trim };
  } catch {
    glibcLib = null;
  }
  return glibcLib;
}
