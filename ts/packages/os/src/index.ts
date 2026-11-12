// What Harbor asks of the operating system, in one place: the only package that may look at
// process.platform, /proc, libc, the desktop's tools or the XDG folders (test/boundary.test.ts holds the
// rest of ts/ to that). Linux is the one implementation today; Windows and macOS get theirs behind the
// same functions, so the features above stay one code path (docs: the Windows/macOS port plan).
export * as libc from "./libc.ts";
export * as proc from "./proc.ts";
export * as sys from "./sys.ts";
export * as desktop from "./desktop.ts";
export * as paths from "./paths.ts";
export * as keychain from "./keychain.ts";
export * as spawn from "./spawn.ts";
export * as env from "./env.ts";
export { platform, type Platform } from "./platform.ts";
export * as stall from "./stall.ts";
