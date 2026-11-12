// lock.ts's answers on Windows: a handle of its own on the lock file and LockFileEx on one byte far past any
// file's end. Byte-range locks are mandatory on Windows, so the locked byte is never one a reader reads (single.ts
// keeps its pid in the lock file). Windows drops the lock when the handle's process dies.
import { ptr } from "bun:ffi";
import type { Held } from "../lock.ts";
import { badHandle, kernel32, wide } from "./k32.ts";

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const SHARE_ALL = 0x7; // read, write, delete: others still open, read and replace the file
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const LOCKFILE_FAIL_IMMEDIATELY = 1;
const LOCKFILE_EXCLUSIVE_LOCK = 2;

function overlapped(): Uint8Array {
  const o = new Uint8Array(32);
  new DataView(o.buffer).setUint32(12, 0x7fffffff, true); // OffsetHigh
  return o;
}

function open(path: string): number | null {
  const k = kernel32();
  if (k === null) return null;
  const h = k.CreateFileW(ptr(wide(path)), (GENERIC_READ | GENERIC_WRITE) >>> 0, SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  return badHandle(h) ? null : Number(h);
}

export function hold(path: string, wait: boolean): Held | null | undefined {
  const k = kernel32();
  if (k === null) return undefined;
  const h = open(path);
  if (h === null) return undefined;
  const flags = LOCKFILE_EXCLUSIVE_LOCK | (wait ? 0 : LOCKFILE_FAIL_IMMEDIATELY);
  if (!k.LockFileEx(h, flags, 0, 1, 0, ptr(overlapped()))) {
    k.CloseHandle(h);
    return null;
  }
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      k.UnlockFileEx(h, 0, 1, 0, ptr(overlapped()));
      k.CloseHandle(h);
    },
  };
}

export function heldElsewhere(path: string): boolean | null {
  const got = hold(path, false);
  if (got === undefined) return null;
  if (got === null) return true;
  got.release();
  return false;
}
