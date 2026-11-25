// Harbor's administrator rights, on by default: on Windows Harbor itself runs as administrator (win32/admin.ts: a
// scheduled task Windows allows once); on Linux and macOS its agents get passwordless sudo (sudo.ts: a sudoers.d rule
// the desktop's own prompt allows once; Harbor's window never runs as root). Here: the state, setting it up at the
// first window start, turning it off or on again (`harbor admin off|on`), and on Windows a start without the token
// handed to the task and the restarts that go through a task.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "./paths.ts";
import { platform } from "./platform.ts";
import { exists as procExists } from "./proc.ts";

type Env = Record<string, string | undefined>;
type W = typeof import("./win32/admin.ts");
type Login = typeof import("./win32/login.ts");
type U = typeof import("./sudo.ts");
let w: W | undefined;
const win = (): W | null => (platform() === "win32" ? (w ??= require("./win32/admin.ts") as W) : null);
/** The marker and the remembered choice: plain files, the same on every OS (win32/admin.ts has them). */
const files = (): W => (w ??= require("./win32/admin.ts") as W);
let u: U | undefined;
const unix = (): U | null => (platform() === "linux" || platform() === "darwin" ? (u ??= require("./sudo.ts") as U) : null);
const login = (): Login => require("./win32/login.ts") as Login;

/** Linux and macOS: whether sudo needs no password, as last seen (`refresh`). */
let sudoActive: boolean | null = null;

/** Linux and macOS: looks again whether sudo needs no password (`sudo -n true`); off the main thread's way. */
export async function refresh(): Promise<boolean> {
  const x = unix();
  sudoActive = x === null ? false : await x.passwordless();
  return sudoActive;
}

export interface AdminState {
  /** Windows, Linux or macOS: there's something to show. */
  supported: boolean;
  /** How: Windows' task (Harbor runs as administrator), or passwordless sudo for its agents. */
  kind: "task" | "sudo" | null;
  /** Linux and macOS: sudo needs no password, but not by Harbor's rule (it was so before). */
  preexisting: boolean;
  /** Why the last attempt didn't set it up ("" none). */
  why: string;
  /** The setting is on. */
  on: boolean;
  /** This Harbor has the administrator token. */
  elevated: boolean;
  /** The account is an administrator (Windows can raise Harbor). */
  canElevate: boolean;
  /** `harbor admin off` was run: Harbor keeps the normal rights. */
  off: boolean;
  /** Windows' prompt was declined at a start of this minor version ("" none). */
  declined: string;
}

export function state(): AdminState {
  const a = win();
  const x = unix();
  if (a === null && x === null) return { supported: false, kind: null, preexisting: false, why: "", on: false, elevated: false, canElevate: false, off: false, declined: "" };
  const f = files();
  const c = f.readChoice();
  const on = f.marker() !== null;
  if (a !== null) return { supported: true, kind: "task", preexisting: false, why: c.why, on, elevated: a.elevated() === true, canElevate: a.canElevate(), off: c.off, declined: c.declined };
  // Before the first look (`refresh`), Harbor's own rule counts as working.
  const active = sudoActive ?? on;
  return { supported: true, kind: "sudo", preexisting: active && !on, why: c.why, on, elevated: active, canElevate: x?.hasSudo() ?? false, off: c.off, declined: c.declined };
}

/** `harbor admin on|off` is done by the command itself (Linux, macOS: sudo asks in the terminal), not the running Harbor. */
export const cliLocal = (): boolean => unix() !== null;

/** The note shown just before the one prompt. */
export function promptNote(): string {
  return unix() !== null
    ? "Hub's agents get sudo without a password on this PC: your system asks for your password once. (harbor admin off in a terminal turns that off.)"
    : "Hub runs as administrator on Windows: Windows asks once to allow it. (harbor admin off in a terminal turns that off.)";
}

/** This process has the administrator token (false off Windows). Read once: it can't change. */
let elevatedNow: boolean | undefined;
export function elevated(): boolean {
  return (elevatedNow ??= win()?.elevated() === true);
}

const samePath = (a: string, b: string): boolean => a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();

/** The next restart's task, set by turning the setting on or off (null: the usual choice, see `restartSpawn`). */
let next: { name: string; after?: () => Promise<unknown> } | null = null;

/** The result of turning it on or off: what to tell the person, and whether Harbor restarts now. */
export interface SetResult {
  ok: boolean;
  message: string;
  restart: boolean;
}

export interface SetOptions {
  /** The installed harbor.exe (the task runs it). */
  exe: string;
  /** Start at login is on now. */
  login: boolean;
  /** Start at login's argument (`--background`). */
  arg: string;
}

/**
 * Turns it on or off. Windows shows its prompt (UAC) once when it must; Linux and macOS ask through the desktop's
 * prompt (`via` "desktop") or sudo in the terminal (`via` "terminal", `harbor admin on|off`).
 */
export async function set(on: boolean, o: SetOptions, via: "desktop" | "terminal" = "desktop"): Promise<SetResult> {
  const a = win();
  const x = unix();
  if (a === null && x === null) return { ok: false, message: "Hub's administrator rights are for Windows, Linux and macOS.", restart: false };
  const r = a !== null ? (on ? await enable(a, o) : await disable(a, o)) : on ? await sudoOn(x as U, via) : await sudoOff(x as U, via);
  // Turned off, it stays off over updates; turned on, the default is back.
  if (r.ok) files().writeChoice({ off: !on, declined: "", why: "" });
  return r;
}

async function sudoOn(x: U, via: "desktop" | "terminal"): Promise<SetResult> {
  const f = files();
  const ok = (message: string): SetResult => ({ ok: true, message, restart: false });
  if (!x.hasSudo()) return { ok: false, message: "sudo isn't installed here, so there's nothing to make passwordless.", restart: false };
  if (await refresh()) return ok(f.marker() !== null ? "sudo needs no password already (Hub's rule)." : "sudo needs no password for you already (not Hub's doing): nothing to change.");
  const r = await x.runRoot(via, "on");
  if (r.declined) return { ok: false, message: "The password prompt was declined: sudo still asks for your password.", restart: false };
  if (r.noPrompt) return { ok: false, message: "There's no password prompt Hub can show here (no polkit agent): run harbor admin on in a terminal, where sudo asks for your password.", restart: false };
  if (r.code !== 0) return { ok: false, message: `sudo wasn't changed${r.out === "" ? ` (exit ${r.code})` : `: ${r.out}`}`, restart: false };
  f.writeMarker({ login: false, exe: `${x.sudoersDir()}/${x.fileName(x.currentUser())}`, since: Date.now() });
  await refresh();
  return ok("Hub's agents can use sudo without a password now.");
}

async function sudoOff(x: U, via: "desktop" | "terminal"): Promise<SetResult> {
  const f = files();
  if (f.marker() === null) {
    const pre = await refresh();
    return { ok: true, message: pre ? "Off. sudo still needs no password for you, but that rule isn't Hub's: it was left alone." : "Off.", restart: false };
  }
  // While Harbor's rule is there, sudo needs no password to take it out.
  let r = await x.runRoot("sudo-n", "off");
  if (r.code !== 0) r = await x.runRoot(via, "off");
  if (r.code !== 0) return { ok: false, message: `Hub's sudo rule wasn't removed${r.out === "" ? "" : `: ${r.out}`}`, restart: false };
  f.removeMarker();
  await refresh();
  return { ok: true, message: "Off: sudo asks for your password again.", restart: false };
}

/**
 * At a start with a window: Harbor isn't set up to run as administrator yet (a new install, or the first start of the
 * version that brought it), so it asks Windows once. Not when `harbor admin off` was run, when the account can't be
 * raised, or when the prompt was declined in this minor version (a decline is remembered: the next minor version asks
 * once more). Null: nothing asked; else the outcome (`restart`: restart now, through the task).
 */
export async function autoSetup(o: SetOptions & { version: string }, exe: string = process.execPath, before: (note: string) => void = () => {}): Promise<SetResult | null> {
  const a = win();
  const x = unix();
  const f = files();
  if (f.marker() !== null) return null;
  const c = f.readChoice();
  if (c.off || c.declined === f.minorOf(o.version)) return null;
  let r: SetResult;
  if (a !== null) {
    if (!samePath(o.exe, exe) || !a.canElevate()) return null;
    // An elevated Harbor (opened as administrator) sets it up with no prompt; else Windows asks now.
    if (a.elevated() !== true) before(promptNote());
    r = await enable(a, o);
  } else if (x !== null) {
    // Passwordless already (a rule of the person's own): nothing to ask, no file.
    if (!x.hasSudo() || (await refresh())) return null;
    before(promptNote());
    r = await sudoOn(x, "desktop");
  } else return null;
  if (!r.ok) f.writeChoice({ off: false, declined: f.minorOf(o.version), why: r.message });
  return r;
}

async function enable(a: W, o: SetOptions): Promise<SetResult> {
  if (!a.canElevate()) return { ok: false, message: "Your Windows account isn't an administrator, so Hub can't run as one.", restart: false };
  if (a.marker() !== null && (await a.taskExists(a.TASK))) return { ok: true, message: "Hub runs as administrator already.", restart: a.elevated() === false };
  const sid = await a.userSid();
  if (sid === null) return { ok: false, message: "Hub couldn't tell who you are in Windows (whoami /user failed).", restart: false };
  const xmlFile = a.scratchPath("admin-task.xml");
  const resultFile = a.scratchPath("admin-task-result.json");
  a.writeScratch(xmlFile, a.utf16(a.taskXml({ exe: o.exe, sid, home: home(), level: "highest", logon: true })));
  rmSync(resultFile, { force: true });
  let made: { ok: boolean; out: string };
  try {
    if (a.elevated() === true) made = await a.createTask(a.TASK, xmlFile);
    else {
      const r = await a.runElevated(o.exe, ["admin-task", "install", xmlFile, resultFile]);
      if (r.declined) return { ok: false, message: "Windows' prompt was declined: Hub keeps your normal rights.", restart: false };
      made = a.readResult(resultFile) ?? { ok: r.code === 0, out: r.out };
    }
  } finally {
    rmSync(xmlFile, { force: true });
    rmSync(resultFile, { force: true });
  }
  if (!made.ok) return { ok: false, message: `Windows didn't make Hub's task${made.out === "" ? "" : `: ${made.out}`}`, restart: false };
  // Start at login goes through the task from now on (its logon start), not the Run value.
  a.writeMarker({ login: o.login, exe: o.exe, since: Date.now() });
  login().setRun(false, o.exe, o.arg);
  uninstallHook(o.exe, true);
  if (a.elevated() === true) return { ok: true, message: "Hub runs as administrator.", restart: false };
  next = { name: a.TASK };
  return { ok: true, message: "Hub restarts as administrator.", restart: true };
}

async function disable(a: W, o: SetOptions): Promise<SetResult> {
  const m = a.marker();
  const startAtLogin = m?.login ?? o.login;
  let restart = false;
  if (a.elevated() === true) {
    // No prompt: this Harbor may change tasks. The next one starts with the normal token through a task of its own.
    const sid = await a.userSid();
    if (sid !== null) {
      const xmlFile = a.scratchPath("admin-task.xml");
      a.writeScratch(xmlFile, a.utf16(a.taskXml({ exe: o.exe, sid, home: home(), level: "limited", logon: false })));
      restart = (await a.createTask(a.LIMITED_TASK, xmlFile)).ok;
      rmSync(xmlFile, { force: true });
    }
    const gone = await a.deleteTask(a.TASK);
    if (!gone.ok && (await a.taskExists(a.TASK))) return { ok: false, message: `Windows didn't remove Hub's task: ${gone.out}`, restart: false };
    if (restart) next = { name: a.LIMITED_TASK, after: () => a.deleteTask(a.LIMITED_TASK) };
  } else if (m !== null || (await a.taskExists(a.TASK))) {
    const resultFile = a.scratchPath("admin-task-result.json");
    rmSync(resultFile, { force: true });
    const r = await a.runElevated(o.exe, ["admin-task", "remove", resultFile]);
    const said = a.readResult(resultFile);
    rmSync(resultFile, { force: true });
    if (r.declined) return { ok: false, message: "Windows' prompt was declined: Hub's task stays, and so does the setting.", restart: false };
    if (!(said?.ok ?? r.code === 0)) return { ok: false, message: `Windows didn't remove Hub's task${said?.out ? `: ${said.out}` : ""}`, restart: false };
  }
  a.removeMarker();
  login().setRun(startAtLogin, o.exe, o.arg);
  uninstallHook(o.exe, false);
  return { ok: true, message: restart ? "Hub restarts with your normal rights." : elevated() ? "Off. This Hub keeps administrator rights until you quit it and open it again." : "Off.", restart };
}

/** The task's own commands: `harbor admin-task …` (the elevated helper) and `harbor admin-start` (the task's action). */
export async function taskCommand(args: readonly string[]): Promise<number> {
  const a = win();
  if (a === null) return (console.error("harbor: admin-task is for Windows"), 2);
  return a.taskCommand(args);
}

export async function taskStart(env: Env = process.env): Promise<number> {
  const a = win();
  if (a === null) return 2;
  const s = a.takeStart(env);
  if (s === null) return 0;
  const p = Bun.spawn([process.execPath, ...s.args], { env: { ...process.env, ...s.env, [a.VIA_TASK]: "1" }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  p.unref();
  if (s.id !== null) a.tellTaken(s.id, p.pid);
  return 0;
}

/** Whether a start would be handed to the task: the setting is on, this is the installed Harbor and it lacks the token. */
export function handsOffStart(argv: readonly string[], exe: string = process.execPath, env: Env = process.env): boolean {
  const a = win();
  if (a === null || env[a.VIA_TASK] === "1") return false;
  const m = a.marker();
  return m !== null && samePath(m.exe, exe) && a.passable(argv) && a.elevated() === false;
}

/**
 * Hands this start to the task (after `handsOffStart`): true when the task started the new Harbor, which this one
 * leaves to. False: start here, with normal rights (said in the log).
 */
export async function handOffStart(argv: readonly string[]): Promise<boolean> {
  const a = win();
  if (a === null) return false;
  const pid = await a.startThrough(a.TASK, argv);
  if (pid === null) {
    console.error("harbor: Run as administrator is on, but its task didn't start Hub: starting with normal rights");
    return false;
  }
  // A program Task Scheduler starts isn't the one the user just opened, so Windows doesn't bring its window to the
  // front. This process is (the Start menu started it): it brings the new window forward once it shows.
  if (argv.length === 0) {
    const d = require("./win32/desktop.ts") as typeof import("./win32/desktop.ts");
    for (let i = 0; i < 150 && procExists(pid); i++) {
      if (d.windowsOf(pid).length > 0) {
        d.raise(pid);
        break;
      }
      await Bun.sleep(100);
    }
  }
  return true;
}

/** The mark `admin-start` gives the Harbor it starts, dropped so that what this Harbor starts doesn't carry it. */
export function forgetViaTask(env: Env = process.env): void {
  delete env.HARBOR_VIA_TASK;
}

/** A started process as the reloader sees it (reload.ts `Spawned`): it resolves `exited` when the process ends. */
export interface Spawned {
  exited: Promise<unknown>;
}

/** The task didn't start a Harbor once in this process: what's left of it starts the next one directly. */
let refused = false;

/**
 * The next Harbor of a restart (reload.ts `spawn`): through a task just after the setting was turned on (the task)
 * or off from an elevated Harbor (the normal-rights task), or while it's on and this Harbor lacks the token. Else,
 * as always, a child of this process, which keeps its token: updates, rollbacks and `harbor restart` of an elevated
 * Harbor stay elevated so. A task that doesn't start one ends `exited` at once, and the handover's plain retry
 * comes back here and starts the child.
 */
export function restartSpawn(cmd: string[], env: Env, exe: string = process.execPath): Spawned {
  const a = win();
  let task = next;
  next = null;
  if (a !== null && task === null && !refused) {
    const m = a.marker();
    if (m !== null && samePath(m.exe, exe) && a.elevated() === false) task = { name: a.TASK };
  }
  const l = a === null || task === null || refused ? null : a.launchThrough(task.name, cmd.slice(1), env);
  if (a === null || task === null || l === null) return spawnChild(cmd, env);
  const t = task;
  let ended = (): void => {};
  const exited = new Promise<void>((r) => (ended = r));
  void (async () => {
    const pid = (await l.ran) ? await a.waitTaken(l.id) : null;
    if (pid === null) {
      refused = true;
      ended();
      return;
    }
    void t.after?.();
    while (procExists(pid)) await Bun.sleep(250);
    ended();
  })();
  return { exited };
}

/** As reload.ts starts the next Harbor: detached on Windows, where a child in Bun's kill-on-close job would die with this one. */
export function spawnChild(cmd: string[], env: Env): Spawned {
  const p = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: platform() === "win32" });
  p.unref();
  return { exited: p.exited };
}

const HOOK_BEGIN = "# >>> Hub: Run as administrator";
const HOOK_END = "# <<< Hub: Run as administrator";

/** Lines uninstall.ps1 runs first while the setting is on: the task goes (Windows asks once), and the setting. */
export function hookLines(): string[] {
  return [
    HOOK_BEGIN,
    "# Hub's scheduled task goes first (Windows asks once to allow it), and the setting with it.",
    String.raw`$hm = Join-Path $env:LOCALAPPDATA "harbor\run-as-admin.json"`,
    `$hq = Start-Process -FilePath schtasks.exe -ArgumentList '/query /tn "Hub (elevated)"' -WindowStyle Hidden -Wait -PassThru`,
    `if ($hq.ExitCode -eq 0 -or (Test-Path $hm)) { try { Start-Process -FilePath schtasks.exe -ArgumentList '/delete /tn "Hub (elevated)" /f' -Verb RunAs -WindowStyle Hidden -Wait } catch {} }`,
    `Remove-Item -Path $hm -Force -ErrorAction SilentlyContinue`,
    HOOK_END,
  ];
}

/** uninstall.ps1's text with the hook put in (on) or taken out. */
export function withHook(text: string, on: boolean): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const b = lines.indexOf(HOOK_BEGIN);
  const e = lines.indexOf(HOOK_END);
  const rest = b >= 0 && e > b ? [...lines.slice(0, b), ...lines.slice(e + 1)] : lines;
  return (on ? [...hookLines(), ...rest] : rest).join(nl);
}

/** Puts the hook in the install's uninstall.ps1 (Settings › Apps runs it), or takes it out. */
function uninstallHook(exe: string, on: boolean): void {
  const file = join(dirname(exe), "uninstall.ps1");
  try {
    const text = readFileSync(file, "utf8");
    const next = withHook(text, on);
    if (next !== text) writeFileSync(file, next);
  } catch {
    // no uninstall.ps1 (not install.ps1's install): install.ps1's own uninstall removes the task too
  }
}

/**
 * `harbor admin` (and the running Harbor's answer to it): the state, for diagnostics. `self` says whether these lines
 * come from the running Harbor (its own token) or from the command in a terminal.
 */
export async function status(self: "harbor" | "command" = "command"): Promise<string[]> {
  const a = win();
  const x = unix();
  if (a === null && x === null) return ["Hub's administrator rights: Windows, Linux and macOS only."];
  if (a === null && x !== null) return sudoStatus(x);
  if (a === null) return [];
  const m = a.marker();
  const c = a.readChoice();
  const task = await a.taskExists(a.TASK);
  const el = a.elevated();
  const how = m !== null ? `set up since ${new Date(m.since).toISOString()} (start at login ${m.login ? "on" : "off"}, ${m.exe})` : c.off ? "off (harbor admin off; harbor admin on turns it back on)" : c.declined !== "" ? `not set up: Windows' prompt was declined in ${c.declined} (asked again once a later version comes; harbor admin on asks now)` : "not set up yet (the next start of Hub's window asks Windows once)";
  const who = self === "harbor" ? "the running Hub" : "this command";
  return [
    `Run as administrator (Windows default): ${how}`,
    `${who}: ${el === null ? "unknown" : el ? "elevated (administrator token)" : "not elevated (normal rights)"}; account: ${a.tokenKind() === "default" && el !== true ? "no administrator token to raise" : "administrator"}`,
    `task "${a.TASK}": ${task ? "registered" : "not found"}`,
  ];
}

async function sudoStatus(x: U): Promise<string[]> {
  const f = files();
  const m = f.marker();
  const c = f.readChoice();
  const active = await refresh();
  const how =
    m !== null
      ? `Hub's rule since ${new Date(m.since).toISOString()} (${m.exe})${active ? "" : ", but sudo still asks for a password (see harbor admin on)"}`
      : active
        ? "sudo needs no password for you already, by a rule that isn't Hub's (nothing written)"
        : !x.hasSudo()
          ? "sudo (or visudo) isn't installed"
          : c.off
            ? "off (harbor admin off; harbor admin on turns it back on)"
            : c.declined !== ""
              ? `not set up: the prompt in ${c.declined} didn't (${c.why || "declined"}); asked again once a later version comes, harbor admin on asks now`
              : "not set up yet (the next start of Hub's window asks once)";
  return [
    `Passwordless sudo for Hub's agents (default on Linux and macOS): ${how}`,
    `sudo -n true: ${active ? "works (no password)" : "asks for a password"}`,
    ...(active ? ["The cost: any program running as you can get root without a password."] : []),
    "Hub's window itself never runs as root.",
  ];
}

/**
 * At each start while the setting is on: the uninstall hook is still in uninstall.ps1 (installing Harbor again
 * writes that file anew).
 */
export function keepHook(exe: string = process.execPath): void {
  const m = win()?.marker() ?? null;
  if (m !== null && samePath(m.exe, exe)) uninstallHook(m.exe, true);
}
