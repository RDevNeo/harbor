// Starting Harbor at login: the system's own entry for it (Linux: an XDG autostart .desktop file; macOS:
// a LaunchAgent in the user's session; Windows: a value under HKCU\…\Run). Harbor writes it; the system
// runs `EXE ARG` at the next login.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { home } from "./paths.ts";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** Harbor's id where the system asks for one (macOS bundles and LaunchAgents). */
export const APP_ID = "dev.harbor.Harbor";

/**
 * Where an installed Harbor's command is, the one that follows its updates: ~/.local/bin/harbor (a link,
 * install.sh), or on Windows the installed harbor.exe itself (install.ps1 puts its folder on PATH).
 */
export function installedLauncher(env: Env = process.env): string {
  if (platform(env) === "win32") return join(env.LOCALAPPDATA ?? join(home(env), "AppData", "Local"), "Programs", "Harbor", "harbor.exe");
  return join(env.HOME ?? "", ".local/bin/harbor");
}

/** Where the entry goes. */
export function entryPath(env: Env = process.env): string {
  if (platform(env) === "win32") return windows().where;
  if (platform(env) === "darwin") return join(home(env), "Library", "LaunchAgents", `${APP_ID}.plist`);
  const xdg = env.XDG_CONFIG_HOME;
  const config = xdg !== undefined && isAbsolute(xdg) ? xdg : join(env.HOME ?? "", ".config");
  return join(config, "autostart/harbor.desktop");
}

/** The entry that runs `exe arg` at login. */
export function entry(exe: string, arg: string, env: Env = process.env): string {
  return platform(env) === "darwin" ? launchAgent(exe, arg) : desktopEntry(exe, arg);
}

/** Whether `text` is Harbor's entry for `arg`, switched on. */
export function isOn(text: string, arg: string, env: Env = process.env): boolean {
  if (!text.includes(arg)) return false;
  if (platform(env) === "darwin") return !/<key>Disabled<\/key>\s*<true\/>/.test(text);
  return !text.split("\n").some((l) => l.trim() === "Hidden=true");
}

export function desktopEntry(exe: string, arg: string): string {
  // Desktop Entry quoting: inside double quotes, \ " ` $ are escaped.
  let quoted = exe;
  if ([...exe].some((c) => /\s/u.test(c) || "\"'\\`$".includes(c))) {
    quoted = `"${[...exe].map((c) => ("\"`$\\".includes(c) ? `\\${c}` : c)).join("")}"`;
  }
  return `[Desktop Entry]\nType=Application\nName=Harbor\nComment=Starts Harbor in the background, so phones and other PCs can reach this one\nExec=${quoted} ${arg}\nIcon=harbor\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}

const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A LaunchAgent that starts Harbor once at login, in the user's desktop session (where its window and menu bar are). */
export function launchAgent(exe: string, arg: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(exe)}</string>
    <string>${xml(arg)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

let win32Login: typeof import("./win32/login.ts") | undefined;
const windows = (): typeof import("./win32/login.ts") => (win32Login ??= require("./win32/login.ts") as typeof import("./win32/login.ts"));

let darwinLogin: typeof import("./darwin-login.ts") | undefined;
/** macOS from inside Harbor.app: SMAppService (Login Items shows it as Harbor). Elsewhere a file. */
const bundleLogin = (exe: string): typeof import("./darwin-login.ts") | undefined =>
  platform() === "darwin" && /\.app\/Contents\/MacOS\/[^/]+$/.test(exe)
    ? (darwinLogin ??= require("./darwin-login.ts") as typeof import("./darwin-login.ts"))
    : undefined;

/** Whether Harbor starts at login (its entry is there and on). */
export function enabled(arg: string, exe: string = process.execPath, env: Env = process.env): boolean {
  if (platform(env) === "win32") {
    try {
      return windows().enabled(arg);
    } catch {
      return false;
    }
  }
  const b = bundleLogin(exe);
  if (b && (b.status() === "on" || b.status() === "approval")) return true;
  try {
    return isOn(readFileSync(entryPath(env), "utf8"), arg, env);
  } catch {
    return false;
  }
}

/** Turns start at login on or off: `exe arg` runs then. Throws an Error whose message is for the person. */
export function set(on: boolean, exe: string, arg: string, env: Env = process.env): void {
  if (platform(env) === "win32") return windows().set(on, exe, arg);
  const b = bundleLogin(exe);
  if (b) {
    try {
      b.set(on);
      if (!on) rmSync(entryPath(env), { force: true });
      return;
    } catch {
      // macOS refused it (an unsigned bundle may be): the LaunchAgent file instead, as without a bundle.
    }
  }
  const path = entryPath(env);
  if (!on) {
    try {
      rmSync(path);
    } catch (e) {
      if (!(typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT")) throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry(exe, arg, env));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
