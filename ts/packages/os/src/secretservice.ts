// The desktop's Secret Service (GNOME Keyring, KWallet's freedesktop API) on Linux, through `secret-tool`: secrets
// kept encrypted by the user's login keyring instead of in plain files. Elsewhere (or with no keyring running,
// or HARBOR_NO_KEYCHAIN) `available()` is false and callers keep their own sealed files. A secret only ever goes
// to `secret-tool` on stdin, never on a command line.
import { spawnSync } from "node:child_process";
import { platform } from "./platform.ts";

let cached: boolean | null = null;

export function available(env: Record<string, string | undefined> = process.env): boolean {
  if (platform(env) !== "linux" || env.HARBOR_NO_KEYCHAIN) return false;
  if (cached !== null) return cached;
  // a lookup of a key nobody has: 1 (not found) means the service answered; 127 / a D-Bus error mean it's not there
  const r = spawnSync("secret-tool", ["lookup", "hub-probe", "none"], { timeout: 10_000, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  cached = r.error === undefined && (r.status === 0 || (r.status === 1 && !/(error|cannot|couldn't|not provided)/i.test(r.stderr ?? "")));
  return cached;
}

const attrsOf = (attrs: Record<string, string>): string[] => Object.entries(attrs).flatMap(([k, v]) => [k, v]);

/** The secret with these attributes, or null (none, or no service). */
export function read(attrs: Record<string, string>): string | null {
  if (!available()) return null;
  const r = spawnSync("secret-tool", ["lookup", ...attrsOf(attrs)], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return r.status === 0 && typeof r.stdout === "string" && r.stdout !== "" ? r.stdout.replace(/\n$/, "") : null;
}

/** Stores (or replaces) the secret under these attributes; true when it reads back the same. */
export function write(label: string, attrs: Record<string, string>, secret: string): boolean {
  if (!available()) return false;
  const r = spawnSync("secret-tool", ["store", `--label=${label}`, ...attrsOf(attrs)], { input: secret, timeout: 10_000, stdio: ["pipe", "ignore", "ignore"] });
  return r.status === 0 && read(attrs) === secret;
}

/** Removes it; true when it's gone (or there was none). */
export function remove(attrs: Record<string, string>): boolean {
  if (!available()) return false;
  spawnSync("secret-tool", ["clear", ...attrsOf(attrs)], { timeout: 10_000, stdio: "ignore" });
  return read(attrs) === null;
}
