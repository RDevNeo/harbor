import { join } from "node:path";
import { runDir } from "@harbor/store";

export { dataDir, home, newUuid, now, privateDir, randomHex, runDir, stateDir, writePrivate } from "@harbor/store";

/** control.rs's socket: `HARBOR_SOCK`, else `$XDG_RUNTIME_DIR/harbor.sock`. */
export function socketPath(): string {
  const env = process.env.HARBOR_SOCK;
  if (env) return env;
  return join(process.env.XDG_RUNTIME_DIR ?? runDir(), "harbor.sock");
}

/** From source, Harbor starts itself as Bun with the entry script. */
export function selfArgv(): string[] {
  const exe = process.execPath.replace(/ \(deleted\)$/, "");
  if (Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")) return [exe];
  return [exe, process.env.HARBOR_ENTRY ?? new URL("../../../harbor.ts", import.meta.url).pathname];
}
