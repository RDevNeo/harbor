// The desktop around Harbor's window: opening files and links, the Downloads folder, raising the window.
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { elevated } from "./admin.ts";
import { platform } from "./platform.ts";
import { win } from "./win32/load.ts";

type Env = Record<string, string | undefined>;

/** The program that opens a file or URL with the desktop's default app. */
export function opener(p = platform()): string[] {
  if (p === "darwin") return ["open"];
  // Harbor running as administrator (admin.ts): Explorer opens it, with the normal rights of the desktop it runs, so
  // the browser or app isn't an administrator too (an elevated explorer.exe hands the request to the running one).
  if (p === "win32" && p === platform() && elevated()) return [join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "explorer.exe")];
  // The shell's URL handler takes any URL as one argument (cmd's `start` would split it at `&`).
  if (p === "win32") return ["rundll32", "url.dll,FileProtocolHandler"];
  return ["xdg-open"];
}

/** Opens a file or URL with the desktop's default app, without waiting; a missing opener is ignored. */
export function open(target: string): void {
  const [cmd, ...args] = opener();
  if (cmd === undefined) return;
  try {
    // Explorer reads its command line itself and splits an unquoted one at commas: the target goes in quotes, as is
    // (a URL or a Windows path holds no `"`).
    const viaExplorer = /explorer\.exe$/i.test(cmd);
    const p = viaExplorer
      ? spawn(cmd, [`"${target.replaceAll('"', "%22")}"`], { stdio: "ignore", detached: true, windowsVerbatimArguments: true })
      : spawn(cmd, [...args, target], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no opener: the link just doesn't open
  }
}

/** Whether the desktop has an app for `scheme:` links (Linux: xdg-mime's default; Windows: the registry; macOS: unknown, `open` tells). */
export function hasHandler(scheme: string, p = platform()): Promise<boolean | null> {
  const query: [string, string[]] | null =
    p === "linux" ? ["xdg-mime", ["query", "default", `x-scheme-handler/${scheme}`]] : p === "win32" ? ["reg", ["query", `HKCR\\${scheme}`, "/v", "URL Protocol"]] : null;
  if (!query) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(query[0], query[1], { encoding: "utf8", timeout: 5_000 }, (e, out) => resolve(!e && String(out).trim() !== ""));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Opens `appUrl` (an app's own link, e.g. discord://…) in the app that takes it, else `webUrl` in the browser: on Linux
 * and Windows when no app claims the scheme, on macOS when `open` fails. Doesn't wait for the app.
 */
export async function openApp(appUrl: string, webUrl: string): Promise<"app" | "web"> {
  const scheme = appUrl.slice(0, Math.max(0, appUrl.indexOf(":")));
  const p = platform();
  if (p === "darwin") {
    const opened = await new Promise<boolean>((resolve) => {
      try {
        execFile("open", [appUrl], { timeout: 10_000 }, (e) => resolve(!e));
      } catch {
        resolve(false);
      }
    });
    if (opened) return "app";
    open(webUrl);
    return "web";
  }
  if (scheme !== "" && (await hasHandler(scheme, p))) {
    open(appUrl);
    return "app";
  }
  open(webUrl);
  return "web";
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

/** `downloadsDir` without blocking: for the window's main thread (xdg-user-dir runs as a child it doesn't wait on). */
export function downloadsDirAsync(env: Env = process.env): Promise<string> {
  const home = env.HOME ?? homedir();
  const fallback = join(home, "Downloads");
  if (platform() !== "linux") return Promise.resolve(fallback);
  return new Promise((resolve) => {
    try {
      execFile("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8", timeout: 5_000 }, (e, out) => {
        const d = e ? "" : String(out).trim();
        resolve(d !== "" && d !== home && existsSync(d) ? d : fallback);
      });
    } catch {
      resolve(fallback);
    }
  });
}

/** Shows a file in the desktop's file manager, selected where it can be (else its folder opens). */
export function reveal(file: string): void {
  const p = platform();
  const run = (cmd: string, args: string[]): boolean => {
    try {
      const c = spawn(cmd, args, { stdio: "ignore", detached: true });
      c.on("error", () => {});
      c.unref();
      return true;
    } catch {
      return false;
    }
  };
  if (p === "darwin" && run("open", ["-R", file])) return;
  if (p === "win32" && run(join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "explorer.exe"), [`/select,${file}`])) return;
  if (p === "linux") {
    // The freedesktop file manager interface (Nautilus, Dolphin, Nemo, Thunar…) selects it; else its folder opens.
    const uri = `file://${file.split("/").map(encodeURIComponent).join("/")}`;
    const c = spawn("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems", `array:string:${uri}`, "string:"], { stdio: "ignore" });
    c.on("error", () => open(dirname(file)));
    c.on("exit", (code) => {
      if (code !== 0) open(dirname(file));
    });
    return;
  }
  open(dirname(file));
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

/**
 * Where the desktop's tools aren't there (Linux without zenity or kdialog): the command that shows the desktop's own
 * picker through the XDG portal, with pickerCommand's output and exit codes (3: no portal); null elsewhere.
 */
export function portalPickerCommand(o: import("./win32/picker.ts").PickOptions): string[] | null {
  if (platform() !== "linux") return null;
  return (require("./linux-picker.ts") as typeof import("./linux-picker.ts")).portalPickerCommand(o);
}
