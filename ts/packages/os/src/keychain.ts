// The system's password store, where programs keep logins instead of plain files: the login keychain on
// macOS (through `security`, which the CLIs that wrote the items trust). Elsewhere there is none yet:
// `available()` is false and the calls answer nothing, so callers keep their files.
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { platform } from "./platform.ts";

/** Whether this system has a store these functions use. `HARBOR_NO_KEYCHAIN` turns it off (tests: their sandboxed home has no keychain of its own). */
export function available(env: Record<string, string | undefined> = process.env): boolean {
  return platform(env) === "darwin" && !env.HARBOR_NO_KEYCHAIN;
}

/** The account items are kept under: the login name. */
export function account(env: Record<string, string | undefined> = process.env): string {
  return env.USER || userInfo().username;
}

/** The secret of the item `service` (for `acct`), or null when there's none or no store. */
export function read(service: string, acct: string = account()): string | null {
  if (!available()) return null;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", acct, "-w"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.replace(/\n$/, "");
}

/** Whether the item exists (its secret is not read). */
export function has(service: string, acct: string = account()): boolean {
  if (!available()) return false;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", acct], { timeout: 10_000, stdio: "ignore" });
  return r.status === 0;
}

/**
 * Sets the item's secret, creating or updating it. The secret goes to `security` on stdin, as hex in
 * its interactive mode: never on a command line, where `ps` would show it.
 */
export function write(service: string, secret: string, acct: string = account()): boolean {
  if (!available()) return false;
  const q = (s: string): string => `"${s.replace(/["\\]/g, "\\$&")}"`;
  const line = `add-generic-password -U -s ${q(service)} -a ${q(acct)} -X ${Buffer.from(secret, "utf8").toString("hex")}\n`;
  const r = spawnSync("security", ["-i"], { input: line, timeout: 10_000, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0 && read(service, acct) === secret;
}

/** Removes the item; true when it's gone (or there was none). */
export function remove(service: string, acct: string = account()): boolean {
  if (!available()) return false;
  spawnSync("security", ["delete-generic-password", "-s", service, "-a", acct], { timeout: 10_000, stdio: "ignore" });
  return !has(service, acct);
}
