// Windows' side of @harbor/os, loaded (with bun:ffi's kernel32/ntdll/user32) only on Windows.
export * as proc from "./proc.ts";
export * as sys from "./sys.ts";
export * as libc from "./libc.ts";
export * as desktop from "./desktop.ts";
export * as lock from "./lock.ts";
