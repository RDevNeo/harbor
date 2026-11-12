// Where Claude Code keeps a profile's login: `.credentials.json` in its config folder, except on macOS,
// where it keeps it in the login keychain (one item per config folder) and the file, if any, is stale.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keychain } from "@harbor/os";
import { home, writePrivate } from "./paths.ts";

/** The credentials file of a Claude profile (null: the default, ~/.claude). */
export function credentialsPath(configDir: string | null): string {
  return join(configDir ?? join(home(), ".claude"), ".credentials.json");
}

/** The keychain item Claude Code uses for a profile: the default's, or one named after its CLAUDE_CONFIG_DIR. */
export function keychainService(configDir: string | null): string {
  const base = "Claude Code-credentials";
  return configDir === null ? base : `${base}-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

function readFile(configDir: string | null): string | null {
  try {
    return readFileSync(credentialsPath(configDir), "utf8");
  } catch {
    return null;
  }
}

/**
 * The profile's credentials as Claude Code wrote them (JSON text), or null when it has no login here.
 * On macOS the keychain's item, else the file (Claude Code's own fallback where the keychain can't be used).
 */
export function read(configDir: string | null): string | null {
  // The file only where the keychain has no item: one there wins even when it can't be read now (a stale file
  // beside it, left from before, would sign in with a dead login).
  if (keychain.available() && keychain.has(keychainService(configDir))) return keychain.read(keychainService(configDir));
  return readFile(configDir);
}

/** Replaces the profile's credentials. */
export function write(configDir: string | null, text: string): void {
  if (keychain.available()) {
    if (!keychain.write(keychainService(configDir), text)) throw new Error("the keychain didn't take the login");
    return;
  }
  writePrivate(credentialsPath(configDir), text);
}

/** Removes the profile's credentials (a lent login going back). */
export function remove(configDir: string | null): void {
  if (keychain.available()) {
    keychain.remove(keychainService(configDir));
    return;
  }
  rmSync(credentialsPath(configDir), { force: true });
}

/** Whether the profile has a login here (its secret is not read). */
export function exists(configDir: string | null): boolean {
  return (keychain.available() && keychain.has(keychainService(configDir))) || existsSync(credentialsPath(configDir));
}
