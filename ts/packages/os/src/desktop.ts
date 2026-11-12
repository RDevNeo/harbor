// The desktop around Harbor's window: opening files and links, the Downloads folder, raising the window.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** The program that opens a file or URL with the desktop's default app. */
export function opener(p = platform()): string[] {
  if (p === "darwin") return ["open"];
  if (p === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
}

/** Opens a file or URL with the desktop's default app, without waiting; a missing opener is ignored. */
export function open(target: string): void {
  const [cmd, ...args] = opener();
  if (cmd === undefined) return;
  try {
    const p = spawn(cmd, [...args, target], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no opener: the link just doesn't open
  }
}

/** The user's Downloads folder: the desktop's own (xdg-user-dir on Linux), unless that is the home itself. */
export function downloadsDir(env: Env = process.env): string {
  const home = env.HOME ?? homedir();
  if (platform() === "linux") {
    try {
      const d = spawnSync("xdg-user-dir", ["DOWNLOAD"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).stdout?.trim() ?? "";
      if (d !== "" && d !== home && existsSync(d)) return d;
    } catch {
      // no xdg-user-dir
    }
  }
  return join(home, "Downloads");
}

/**
 * Raises this process's window (Wayland clients can't raise themselves: the compositor is asked).
 * False when there is no way to ask.
 */
export function raise(env: Env = process.env, pid: number = process.pid): boolean {
  if (platform() !== "linux") return false;
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    const hypr = (args: string[]): boolean => {
      const r = spawnSync("hyprctl", args, { encoding: "utf8" });
      return !r.error && r.stdout.trim() === "ok";
    };
    return hypr(["dispatch", `hl.dsp.focus({ window = "pid:${pid}" })`]) || hypr(["dispatch", "focuswindow", `pid:${pid}`]);
  }
  if (env.SWAYSOCK) {
    const r = spawnSync("swaymsg", [`[pid=${pid}] focus`], { encoding: "utf8" });
    return !r.error && r.status === 0;
  }
  return false;
}

/** Whether the window runs under Hyprland (its own rules apply: placement, opacity). */
export function hyprland(env: Env = process.env): boolean {
  return platform() === "linux" && !!env.HYPRLAND_INSTANCE_SIGNATURE;
}
