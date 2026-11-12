// Starting Harbor at login: the system's own entry for it (Linux: an XDG autostart .desktop file; macOS:
// a LaunchAgent in the user's session). Harbor writes it; the system runs `EXE ARG` at the next login.
import { isAbsolute, join } from "node:path";
import { home } from "./paths.ts";
import { platform } from "./platform.ts";

type Env = Record<string, string | undefined>;

/** Harbor's id where the system asks for one (macOS bundles and LaunchAgents). */
export const APP_ID = "dev.harbor.Harbor";

/** Where the entry goes. */
export function entryPath(env: Env = process.env): string {
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
