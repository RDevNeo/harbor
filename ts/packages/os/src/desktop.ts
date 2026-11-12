// The desktop around Harbor's window: opening files and links, the Downloads folder, raising the window.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "./platform.ts";
import { win } from "./win32/load.ts";

type Env = Record<string, string | undefined>;

/** The program that opens a file or URL with the desktop's default app. */
export function opener(p = platform()): string[] {
  if (p === "darwin") return ["open"];
  // The shell's URL handler takes any URL as one argument (cmd's `start` would split it at `&`).
  if (p === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
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
  if (platform() === "darwin" && pid === process.pid) {
    // macOS: this process brings itself (and its window) to the front.
    const o = require("./darwin-objc.ts") as typeof import("./darwin-objc.ts");
    o.pool(() => o.callBool(o.call(o.cls("NSApplication"), "sharedApplication"), "activateIgnoringOtherApps:", true));
    return true;
  }
  const w = win();
  if (w) return w.desktop.raise(pid);
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

/**
 * Lets the running Harbor take the foreground when this process asks it to show itself: Windows gives the
 * foreground only to the app the user is using (this one, just started). Nothing elsewhere.
 */
export function allowRaise(): void {
  win()?.desktop.allowRaise();
}

/**
 * Right after Harbor shows its main window: on Windows, gives it Harbor's icon and fits it on its screen when
 * Slint's preferred size is bigger than the screen (a scaled display). Slint makes the native window on its loop's
 * next turns, so this looks for it a few times. Nothing elsewhere: the Linux and macOS window managers do both.
 */
export function settleShownWindow(pid: number = process.pid): void {
  const w = win();
  if (!w) return;
  // By the clock, not by tries: Harbor's first seconds block its main thread for seconds at a time.
  const until = Date.now() + 20_000;
  const look = (): void => {
    const n = w.desktop.settleWindows(pid);
    if (n > 0) return;
    if (Date.now() < until) setTimeout(look, 100);
    else console.error("harbor: no window of its own came up to fit on the screen");
  };
  look();
}

/**
 * The command that shows the system's own file picker and prints the chosen paths, one a line (exit 1: cancelled);
 * null where Harbor uses the desktop's tools instead (zenity, kdialog on Linux).
 */
export function pickerCommand(o: import("./win32/picker.ts").PickOptions): string[] | null {
  if (platform() !== "win32") return null;
  return (require("./win32/picker.ts") as typeof import("./win32/picker.ts")).pickerCommand(o);
}
