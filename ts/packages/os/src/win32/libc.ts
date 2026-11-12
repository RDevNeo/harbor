// libc.ts's answers on Windows: setenv through SetEnvironmentVariableW. (File locks: lock.ts, by path.)
import { ptr } from "bun:ffi";
import { badHandle, kernel32, wide } from "./k32.ts";

/** Sets a variable in the process's environment block, where native libraries read it. */
export function setenv(name: string, value: string, overwrite: boolean): boolean {
  const k = kernel32();
  if (k === null) return false;
  if (!overwrite && process.env[name] !== undefined) return true;
  return !!k.SetEnvironmentVariableW(ptr(wide(name)), ptr(wide(value)));
}

const STD_ERROR_HANDLE = 0xfffffff4; // (DWORD)-12
const FILE_APPEND_DATA = 0x0004;
const SYNCHRONIZE = 0x00100000;
const SHARE_ALL = 7;
const CREATE_ALWAYS = 2;
const FILE_ATTRIBUTE_NORMAL = 0x80;

/**
 * Windows' stderr handle (what native code writes to: Rust's eprintln!, the C runtime, a crash report) goes to
 * `path`, emptied, written at its end; the function that puts the old one back and closes the file. Null when
 * the file can't be opened. Bun's own writes (console.error) keep the handle Bun took at its start.
 */
export function stderrTo(path: string): (() => void) | null {
  const k = kernel32();
  if (k === null) return null;
  const h = k.CreateFileW(ptr(wide(path)), (FILE_APPEND_DATA | SYNCHRONIZE) >>> 0, SHARE_ALL, null, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
  if (badHandle(h)) return null;
  const before = k.GetStdHandle(STD_ERROR_HANDLE);
  if (!k.SetStdHandle(STD_ERROR_HANDLE, h)) {
    k.CloseHandle(h);
    return null;
  }
  return () => {
    k.SetStdHandle(STD_ERROR_HANDLE, before);
    k.CloseHandle(h);
  };
}
