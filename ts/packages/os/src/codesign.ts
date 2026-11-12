// Code signatures: macOS loads native code only when it's signed (on Apple Silicon at least ad hoc,
// with no identity). A library Harbor patched (update/src/macho.ts) has a stale one until it's signed again.
import { spawnSync } from "node:child_process";
import { platform } from "./platform.ts";

const CODESIGN = "/usr/bin/codesign";

/** Whether this system checks code signatures before it loads native code. */
export function required(): boolean {
  return platform() === "darwin";
}

/**
 * Signs each of `files` ad hoc whose signature is missing or doesn't match its contents (macOS's own
 * codesign, part of every macOS). True when every file is fine afterwards; elsewhere nothing to do.
 */
export function adhoc(files: readonly string[]): boolean {
  if (!required()) return true;
  let ok = true;
  for (const f of files) {
    if (spawnSync(CODESIGN, ["--verify", f], { stdio: "ignore", timeout: 30_000 }).status === 0) continue;
    const r = spawnSync(CODESIGN, ["--force", "--sign", "-", f], { stdio: "ignore", timeout: 60_000 });
    if (r.status !== 0) ok = false;
  }
  return ok;
}
