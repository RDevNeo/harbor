// Harbor runs as administrator on Windows by default (win32/admin.ts has how): its state, setting it up (the first
// start asks Windows once) and turning it off or on again (`harbor admin off|on`), a start without the administrator
// token handed to the task, and the restarts that go through a task. Elsewhere every answer is "not here".
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "./paths.ts";
import { platform } from "./platform.ts";
import { exists as procExists } from "./proc.ts";

type Env = Record<string, string | undefined>;
type W = typeof import("./win32/admin.ts");
type Login = typeof import("./win32/login.ts");
let w: W | undefined;
const win = (): W | null => (platform() === "win32" ? (w ??= require("./win32/admin.ts") as W) : null);
const login = (): Login => require("./win32/login.ts") as Login;

export interface AdminState {
  /** Windows: the setting exists. */
  supported: boolean;
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
  if (a === null) return { supported: false, on: false, elevated: false, canElevate: false, off: false, declined: "" };
  const c = a.readChoice();
  return { supported: true, on: a.marker() !== null, elevated: a.elevated() === true, canElevate: a.canElevate(), off: c.off, declined: c.declined };
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

/** Turns "Run as administrator" on or off. Windows shows its prompt (UAC) once when it must. */
export async function set(on: boolean, o: SetOptions): Promise<SetResult> {
  const a = win();
  if (a === null) return { ok: false, message: "Running as administrator is for Windows.", restart: false };
  const r = on ? await enable(a, o) : await disable(a, o);
  // Turned off, it stays off over updates; turned on, the default is back.
  if (r.ok) a.writeChoice({ off: !on, declined: "" });
  return r;
}

/**
 * At a start with a window: Harbor isn't set up to run as administrator yet (a new install, or the first start of the
 * version that brought it), so it asks Windows once. Not when `harbor admin off` was run, when the account can't be
 * raised, or when the prompt was declined in this minor version (a decline is remembered: the next minor version asks
 * once more). Null: nothing asked; else the outcome (`restart`: restart now, through the task).
 */
export async function autoSetup(o: SetOptions & { version: string }, exe: string = process.execPath, before: () => void = () => {}): Promise<SetResult | null> {
  const a = win();
  if (a === null || !samePath(o.exe, exe) || a.marker() !== null || !a.canElevate()) return null;
  const c = a.readChoice();
  if (c.off || c.declined === a.minorOf(o.version)) return null;
  // An elevated Harbor (opened as administrator) sets it up with no prompt; else Windows asks now.
  if (a.elevated() !== true) before();
  const r = await enable(a, o);
  if (!r.ok) a.writeChoice({ off: false, declined: a.minorOf(o.version) });
  return r;
}

async function enable(a: W, o: SetOptions): Promise<SetResult> {
  if (!a.canElevate()) return { ok: false, message: "Your Windows account isn't an administrator, so Harbor can't run as one.", restart: false };
  if (a.marker() !== null && (await a.taskExists(a.TASK))) return { ok: true, message: "Harbor runs as administrator already.", restart: a.elevated() === false };
  const sid = await a.userSid();
  if (sid === null) return { ok: false, message: "Harbor couldn't tell who you are in Windows (whoami /user failed).", restart: false };
  const xmlFile = a.scratchPath("admin-task.xml");
  const resultFile = a.scratchPath("admin-task-result.json");
  a.writeScratch(xmlFile, a.utf16(a.taskXml({ exe: o.exe, sid, home: home(), level: "highest", logon: true })));
  rmSync(resultFile, { force: true });
  let made: { ok: boolean; out: string };
  try {
    if (a.elevated() === true) made = await a.createTask(a.TASK, xmlFile);
    else {
      const r = await a.runElevated(o.exe, ["admin-task", "install", xmlFile, resultFile]);
      if (r.declined) return { ok: false, message: "Windows' prompt was declined: Harbor keeps your normal rights.", restart: false };
      made = a.readResult(resultFile) ?? { ok: r.code === 0, out: r.out };
    }
  } finally {
    rmSync(xmlFile, { force: true });
    rmSync(resultFile, { force: true });
  }
  if (!made.ok) return { ok: false, message: `Windows didn't make Harbor's task${made.out === "" ? "" : `: ${made.out}`}`, restart: false };
  // Start at login goes through the task from now on (its logon start), not the Run value.
  a.writeMarker({ login: o.login, exe: o.exe, since: Date.now() });
  login().setRun(false, o.exe, o.arg);
  uninstallHook(o.exe, true);
  if (a.elevated() === true) return { ok: true, message: "Harbor runs as administrator.", restart: false };
  next = { name: a.TASK };
  return { ok: true, message: "Harbor restarts as administrator.", restart: true };
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
    if (!gone.ok && (await a.taskExists(a.TASK))) return { ok: false, message: `Windows didn't remove Harbor's task: ${gone.out}`, restart: false };
    if (restart) next = { name: a.LIMITED_TASK, after: () => a.deleteTask(a.LIMITED_TASK) };
  } else if (m !== null || (await a.taskExists(a.TASK))) {
    const resultFile = a.scratchPath("admin-task-result.json");
    rmSync(resultFile, { force: true });
    const r = await a.runElevated(o.exe, ["admin-task", "remove", resultFile]);
    const said = a.readResult(resultFile);
    rmSync(resultFile, { force: true });
    if (r.declined) return { ok: false, message: "Windows' prompt was declined: Harbor's task stays, and so does the setting.", restart: false };
    if (!(said?.ok ?? r.code === 0)) return { ok: false, message: `Windows didn't remove Harbor's task${said?.out ? `: ${said.out}` : ""}`, restart: false };
  }
  a.removeMarker();
  login().setRun(startAtLogin, o.exe, o.arg);
  uninstallHook(o.exe, false);
  return { ok: true, message: restart ? "Harbor restarts with your normal rights." : elevated() ? "Off. This Harbor keeps administrator rights until you quit it and open it again." : "Off.", restart };
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
    console.error("harbor: Run as administrator is on, but its task didn't start Harbor: starting with normal rights");
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

const HOOK_BEGIN = "# >>> Harbor: Run as administrator";
const HOOK_END = "# <<< Harbor: Run as administrator";

/** Lines uninstall.ps1 runs first while the setting is on: the task goes (Windows asks once), and the setting. */
export function hookLines(): string[] {
  return [
    HOOK_BEGIN,
    "# Harbor's scheduled task goes first (Windows asks once to allow it), and the setting with it.",
    String.raw`$hm = Join-Path $env:LOCALAPPDATA "harbor\run-as-admin.json"`,
    `$hq = Start-Process -FilePath schtasks.exe -ArgumentList '/query /tn "Harbor (elevated)"' -WindowStyle Hidden -Wait -PassThru`,
    `if ($hq.ExitCode -eq 0 -or (Test-Path $hm)) { try { Start-Process -FilePath schtasks.exe -ArgumentList '/delete /tn "Harbor (elevated)" /f' -Verb RunAs -WindowStyle Hidden -Wait } catch {} }`,
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
  if (a === null) return ["Running as administrator: Windows only."];
  const m = a.marker();
  const c = a.readChoice();
  const task = await a.taskExists(a.TASK);
  const el = a.elevated();
  const how = m !== null ? `set up since ${new Date(m.since).toISOString()} (start at login ${m.login ? "on" : "off"}, ${m.exe})` : c.off ? "off (harbor admin off; harbor admin on turns it back on)" : c.declined !== "" ? `not set up: Windows' prompt was declined in ${c.declined} (asked again once a later version comes; harbor admin on asks now)` : "not set up yet (the next start of Harbor's window asks Windows once)";
  const who = self === "harbor" ? "the running Harbor" : "this command";
  return [
    `Run as administrator (Windows default): ${how}`,
    `${who}: ${el === null ? "unknown" : el ? "elevated (administrator token)" : "not elevated (normal rights)"}; account: ${a.tokenKind() === "default" && el !== true ? "no administrator token to raise" : "administrator"}`,
    `task "${a.TASK}": ${task ? "registered" : "not found"}`,
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
