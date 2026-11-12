// Starting Harbor at login: the system's own entry for it (Linux: an XDG autostart .desktop file; macOS:
// a LaunchAgent in the user's session; Windows: a value under HKCU\…\Run). Harbor writes it; the system
// runs `EXE ARG` at the next login.
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { home, stateHome } from "./paths.ts";
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
  return platform(env) === "darwin" ? launchAgent(exe, arg, bundleOf(exe)) : desktopEntry(exe, arg);
}

/** The app bundle `exe` is (or leads to, ~/.local/bin/harbor being a link into it): …/Harbor.app; null when it's none. */
export function bundleOf(exe: string): string | null {
  let real = exe;
  try {
    real = realpathSync(exe);
  } catch {
    // not there (yet): its path as given
  }
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(real)?.[1] ?? null;
}

/**
 * macOS: brings an older LaunchAgent of Harbor's up to date (Harbor checks at every start). One that ran
 * Harbor's own executable directly fails the first login after each update: launchd pins the code hash of
 * the program a LaunchAgent runs (its "LWCR"), an update changes it, and macOS kills that launch for a code
 * signature that no longer matches (OS_REASON_CODESIGNING). The entry now runs Apple's `open`, which an
 * update doesn't touch, on the bundle. True when it rewrote it (it takes effect at the next login).
 */
export function heal(arg: string, env: Env = process.env, exe: string = process.execPath): boolean {
  if (platform(env) !== "darwin") return false;
  // Registered from inside the bundle (SMAppService): macOS pins that program's code hash as well, so the
  // first start after an update registers it again.
  const b = bundleLogin(exe);
  if (b && b.status() === "on" && registeredBinaryChanged(exe, env)) {
    b.set(false);
    b.set(true);
    return true;
  }
  const path = entryPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(`<string>${APP_ID}</string>`) || !isOn(text, arg, env)) return false;
  const list = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const args = [...list.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => (m[1] ?? "").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
  const first = args[0];
  if (first === undefined) return false;
  // Already `open BUNDLE`: written again as today's (an older one lacks AssociatedBundleIdentifiers, which
  // makes Login Items show it as Harbor rather than as `open`).
  const next = first === "/usr/bin/open" ? (args[2] === undefined ? text : launchAgent(first, arg, args[2])) : entry(first, arg, env);
  if (next === text) return false;
  writeFileSync(path, next);
  return true;
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

/** Where Harbor notes which executable its SMAppService login item was last registered from. */
const registeredPath = (env: Env): string => join(stateHome(env), "harbor", "login-item-binary");

/** The executable as a file (inode, size, time): an update replaces it, so all three change. */
export function binaryIdentity(exe: string): string | null {
  try {
    const st = statSync(realpathSync(exe));
    return `${st.ino}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * Whether the executable changed since the login item was last registered (an update), noting it as
 * registered now. A first look (nothing noted: registered by an older Harbor) counts as changed.
 */
export function registeredBinaryChanged(exe: string, env: Env = process.env): boolean {
  const now = binaryIdentity(exe);
  if (now === null) return false;
  const path = registeredPath(env);
  let was: string | null = null;
  try {
    was = readFileSync(path, "utf8").trim();
  } catch {
    // never noted
  }
  if (was === now) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${now}\n`);
  return true;
}

/**
 * A LaunchAgent that starts Harbor once at login, in the user's desktop session (where its window and menu bar
 * are). Harbor.app is opened with Apple's `open` (`bundle`), not run directly: launchd pins the code hash of the
 * program it runs, and Harbor's changes with every update (see `heal`).
 */
export function launchAgent(exe: string, arg: string, bundle: string | null = null): string {
  const program = bundle === null ? [exe, arg] : ["/usr/bin/open", "-g", bundle, "--args", arg];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>${
    bundle === null
      ? ""
      : `
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${APP_ID}</string>
  </array>`
  }
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
      else registeredBinaryChanged(exe, env);
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
