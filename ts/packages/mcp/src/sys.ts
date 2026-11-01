import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { home } from "@harbor/store";

export function childPath(env: Record<string, string | undefined> = process.env): string {
  const h = home(env);
  const dirs = (env.PATH ?? "").split(":");
  for (const extra of [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", ".opencode/bin", ".npm-global/bin"]) {
    const p = join(h, extra);
    if (!dirs.includes(p)) dirs.push(p);
  }
  return dirs.join(":");
}

export function which(bin: string, env: Record<string, string | undefined> = process.env): string | undefined {
  for (const d of childPath(env).split(":")) {
    const p = join(d, bin);
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      // unreadable entry: keep looking
    }
  }
  return undefined;
}

export function openUrl(url: string): void {
  try {
    Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // no opener on this PC: the sign-in card still shows the link
  }
}

export function selfExe(env: Record<string, string | undefined> = process.env): string {
  return (env.HARBOR_EXE || process.execPath).replace(/ \(deleted\)$/, "");
}
