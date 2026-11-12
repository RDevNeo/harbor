// libc.ts's answers on Windows: setenv through SetEnvironmentVariableW. (File locks: lock.ts, by path.)
import { ptr } from "bun:ffi";
import { kernel32, wide } from "./k32.ts";

/** Sets a variable in the process's environment block, where native libraries read it. */
export function setenv(name: string, value: string, overwrite: boolean): boolean {
  const k = kernel32();
  if (k === null) return false;
  if (!overwrite && process.env[name] !== undefined) return true;
  return !!k.SetEnvironmentVariableW(ptr(wide(name)), ptr(wide(value)));
}
