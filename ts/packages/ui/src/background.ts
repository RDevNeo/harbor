import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Closing the window leaves Harbor running, unless HARBOR_NO_BACKGROUND is set (a preview rig: closing it ends it). */
export function keepsRunning(env: Record<string, string | undefined> = process.env): boolean {
  return env.HARBOR_NO_BACKGROUND === undefined;
}

/** Starts Harbor without a window (autostart): `harbor --background`. */
export const BACKGROUND_FLAG = "--background";

/** Hidden ticks run at most this often, whatever asks for repaints. */
export const MIN_GAP_MS = 250;
/** And at least this often, for work that only checks the clock. */
export const HEARTBEAT_MS = 5000;

/** The part of the kv table this needs (`Kv` of @harbor/net fits). */
export interface BackgroundKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** What the shell wires: the window's repaint and close, desktop notifications, the tray's state. */
export interface BackgroundHost {
  /** egui's request_repaint: the window (if any) should draw again. */
  wake(): void;
  /** Close the window if there is one (Rust: ViewportCommand::Close). */
  closeWindow(): void;
  /** A desktop notification (Rust: limits::notify). */
  notify(title: string, body: string): void;
  /** The tray icon is shown; picks the hint in the "still running" notice. */
  trayActive(): boolean;
}

/** What the loop ticks while there is no window. */
export interface HiddenApp {
  /** The window closed: stop what only a window needs (browser engines; their URL survives). */
  windowClosed(): void;
  /** One pass of the App's logic (phone API, mesh, queue, auto-work, wakes, webhooks, updates), reported as minimized, unfocused and occluded. */
  tick(): void;
  /** The version of an update that is available or installed (Rust: update_offered), "" when it has no name. */
  updateOffered(): string | null;
  autoUpdate(): boolean;
}

export interface BackgroundTiming {
  minGapMs?: number;
  heartbeatMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Harbor keeps running when its window is closed: the same process, with no window. */
export class Background {
  private isHidden = false;
  private showAsked = false;
  private quitAsked = false;
  private inbox: number[] = [];
  private nudge: (() => void) | null = null;
  private readonly minGap: number;
  private readonly heartbeat: number;

  constructor(
    private readonly host: BackgroundHost,
    private readonly kv: BackgroundKv,
    timing: BackgroundTiming = {},
  ) {
    this.minGap = timing.minGapMs ?? MIN_GAP_MS;
    this.heartbeat = timing.heartbeatMs ?? HEARTBEAT_MS;
  }

  hidden(): boolean {
    return this.isHidden;
  }

  /** Quit Harbor completely was asked (tray, menu, Ctrl+Q). */
  quitting(): boolean {
    return this.quitAsked;
  }

  /** Opens the window (or brings it to the front). */
  show(): void {
    this.showAsked = true;
    this.repaint(0);
    this.host.wake();
  }

  /** Quits Harbor completely, window or not. */
  quit(): void {
    this.quitAsked = true;
    this.host.closeWindow();
    this.repaint(0);
    this.host.wake();
  }

  /** Something asked for a repaint in `delayMs`: while hidden, that is when the next tick runs. Wire the shell's repaint requests here. */
  repaint(delayMs: number): void {
    if (!this.isHidden) return;
    this.inbox.push(delayMs);
    this.nudge?.();
  }

  /** A show asked for while the window is open: true once (the caller raises it). */
  takeShow(): boolean {
    if (this.isHidden) return false;
    const was = this.showAsked;
    this.showAsked = false;
    return was;
  }

  /** A new window opened: the shell also forgets what the last one's renderer had (textures, avatars, QR). */
  windowOpened(): void {
    this.isHidden = false;
    this.showAsked = false;
  }

  /** Ticks the App with no window until it's asked to show one (true) or to quit (false); `closed`:
   * the user closed the window, not a `--background` start. */
  async runHidden(app: HiddenApp, closed: boolean): Promise<boolean> {
    this.isHidden = true;
    this.inbox = [];
    this.windowClosed(app, closed);
    let next = performance.now();
    let last: number | null = null;
    for (;;) {
      if (this.quitAsked) return false;
      if (this.showAsked) {
        this.showAsked = false;
        this.isHidden = false;
        return true;
      }
      const now = performance.now();
      if (now >= next) {
        if (last !== null && now - last < this.minGap) await sleep(this.minGap - (now - last));
        last = performance.now();
        next = last + this.heartbeat;
        app.tick();
        this.updateNotice(app);
        continue;
      }
      const delay = await this.receive(next - now);
      if (delay !== null) next = Math.min(next, performance.now() + Math.min(delay, this.heartbeat));
    }
  }

  private async receive(timeoutMs: number): Promise<number | null> {
    if (this.inbox.length === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.nudge = resolve;
        timer = setTimeout(resolve, timeoutMs);
      });
      clearTimeout(timer);
      this.nudge = null;
    }
    const delay = this.inbox.shift();
    return delay ?? null;
  }

  /** Harbor keeps running in the background when the window is closed: always, except in a preview rig (HARBOR_NO_BACKGROUND). */
  keepRunning(): boolean {
    return keepsRunning();
  }

  /** The window just closed and Harbor stays: say so once, as a desktop notification (there is no window left for a toast). */
  private windowClosed(app: HiddenApp, explain: boolean): void {
    app.windowClosed();
    const note = explain ? stillRunning(this.kv, this.host.trayActive()) : null;
    if (note) this.host.notify(...note);
  }

  /** "Ask me" updates with no window: a desktop notification, once per version (automatic updates install and restart by themselves). */
  private updateNotice(app: HiddenApp): void {
    const v = app.updateOffered();
    if (v === null) return;
    if (app.autoUpdate() || this.kv.get("bg_update_noticed") === v) return;
    this.kv.set("bg_update_noticed", v);
    const name = v === "" ? "A new version" : `Harbor ${v}`;
    this.host.notify(`${name} is ready`, "Open Harbor and click Update to install it.");
  }
}


/** The first time the window closes and Harbor stays: the notice saying so (once, kv `bg_explained`). */
export function stillRunning(kv: BackgroundKv, trayActive: boolean): [string, string] | null {
  if (kv.get("bg_explained") !== null) return null;
  kv.set("bg_explained", "1");
  const how = trayActive ? "Quit it from its tray icon" : "Quit it from Settings › General";
  return ["Harbor is still running", `Phones, other PCs and queued work keep reaching this PC. Run Harbor again to open it. ${how}, or turn this off there.`];
}

export function autostartFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const config = xdg !== undefined && isAbsolute(xdg) ? xdg : join(process.env.HOME ?? "", ".config");
  return join(config, "autostart/harbor.desktop");
}

/** What the running install is, from the update module: its own file, and whether it is the managed install. */
export interface SelfInstall {
  exe: string | null;
  managed: boolean;
}

function canonical(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** What autostart runs: the installed launcher (~/.local/bin/harbor) when it leads to this install, so it follows updates; else this very file. */
export function autostartLauncher(self: SelfInstall): string | null {
  if (self.exe === null) return null;
  const bin = join(process.env.HOME ?? "", ".local/bin/harbor");
  const a = canonical(bin);
  const b = canonical(self.exe);
  return self.managed && a !== null && a === b ? bin : self.exe;
}

/** The entry is Harbor's (written by `setAutostart`) and not hidden. */
export function autostart(): boolean {
  try {
    const s = readFileSync(autostartFile(), "utf8");
    return s.includes(BACKGROUND_FLAG) && !s.split("\n").some((l) => l.trim() === "Hidden=true");
  } catch {
    return false;
  }
}

/** The installed launcher (~/.local/bin/harbor), which follows updates; null when Harbor isn't installed. */
export function installedLauncher(): string | null {
  const bin = join(process.env.HOME ?? "", ".local/bin/harbor");
  return existsSync(bin) ? bin : null;
}

/** Kv: start at login was turned on by default once (or chosen in Settings since), so it is never forced again. */
export const AUTOSTART_DEFAULT_KEY = "autostart_default";

/** "Start Harbor when I log in" is on by default: the first time an installed Harbor runs this, it writes the entry, unless it is there already. */
export function autostartByDefault(kv: BackgroundKv, managed: boolean): void {
  if (!managed || kv.get(AUTOSTART_DEFAULT_KEY) === "1") return;
  const bin = installedLauncher();
  if (bin === null) return;
  kv.set(AUTOSTART_DEFAULT_KEY, "1");
  if (autostart()) return;
  try {
    setAutostart(true, { exe: bin, managed: false });
  } catch {
    // a read-only config folder: it stays off, Settings › General can still try
  }
}

/** Writes or removes the entry. Throws an Error whose message is for the person. */
export function setAutostart(on: boolean, self: SelfInstall): void {
  const path = autostartFile();
  if (!on) {
    try {
      rmSync(path);
    } catch (e) {
      if (!isNotFound(e)) throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  const exe = autostartLauncher(self);
  if (exe === null) throw new Error("Harbor can't tell where its own file is");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desktopEntry(exe));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT";
}

export function desktopEntry(exe: string): string {
  // Desktop Entry quoting: inside double quotes, \ " ` $ are escaped.
  let quoted = exe;
  if ([...exe].some((c) => /\s/u.test(c) || "\"'\\`$".includes(c))) {
    quoted = `"${[...exe].map((c) => ("\"`$\\".includes(c) ? `\\${c}` : c)).join("")}"`;
  }
  return `[Desktop Entry]\nType=Application\nName=Harbor\nComment=Starts Harbor in the background, so phones and other PCs can reach this one\nExec=${quoted} ${BACKGROUND_FLAG}\nIcon=harbor\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}
