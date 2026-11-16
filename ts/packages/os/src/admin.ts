// "Run as administrator" (Windows only; win32/admin.ts has how): the setting's state, turning it on and off, a
// start without the administrator token handed to the task, and the restarts that go through a task. Elsewhere
// every answer is "not here".
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
}

export function state(): AdminState {
  const a = win();
  if (a === null) return { supported: false, on: false, elevated: false, canElevate: false };
  return { supported: true, on: a.marker() !== null, elevated: a.elevated() === true, canElevate: a.canElevate() };
}

/** This process has the administrator token (false off Windows). Read once: it can't change. */
let elevatedNow: boolean | undefined;
export function elevated(): boolean {
  return (elevatedNow ??= win()?.elevated() === true);
}

const samePath = (a: string, b: string): boolean => a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();

/** The next restart's task, set by turning the setting on or off (null: the usual choice, see `relauncher`). */
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
  if (a === null) return { ok: false, message: "Run as administrator is for Windows.", restart: false };
  return on ? enable(a, o) : disable(a, o);
}

async function enable(a: W, o: SetOptions): Promise<SetResult> {
  if (!a.canElevate()) return { ok: false, message: "Your Windows account isn't an administrator, so Harbor can't run as one.", restart: false };
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
  } else {
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
  if (pid === null) console.error("harbor: Run as administrator is on, but its task didn't start Harbor: starting with normal rights");
  return pid !== null;
}

/** The mark `admin-start` gives the Harbor it starts, dropped so that what this Harbor starts doesn't carry it. */
export function forgetViaTask(env: Env = process.env): void {
  delete env.HARBOR_VIA_TASK;
}

/** What a restart through a task gives the reloader: when the process ends, and whether it started at all. */
export interface Relaunch {
  exited: Promise<unknown>;
  started: Promise<boolean>;
}

/**
 * How the next restart starts Harbor, when a task must: just after turning the setting on (the task) or off from
 * an elevated Harbor (the normal-rights task), or while it's on and this Harbor lacks the token (the task's
 * start was refused once). Null: as usual, a child of this process, which keeps its token.
 */
export function relauncher(exe: string = process.execPath): ((cmd: string[], env: Env) => Relaunch) | null {
  const a = win();
  if (a === null) return null;
  let t = next;
  next = null;
  if (t === null) {
    const m = a.marker();
    if (m === null || !samePath(m.exe, exe) || a.elevated() !== false) return null;
    t = { name: a.TASK };
  }
  const task = t;
  return (cmd, env) => {
    let ended = (): void => {};
    const exited = new Promise<void>((r) => (ended = r));
    const started = (async () => {
      const pid = await a.startThrough(task.name, cmd.slice(1), env);
      if (pid === null) {
        ended();
        return false;
      }
      void task.after?.();
      void (async () => {
        while (procExists(pid)) await Bun.sleep(250);
        ended();
      })();
      return true;
    })();
    return { exited, started };
  };
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

/** `harbor admin`: the state, for diagnostics. */
export async function status(): Promise<string[]> {
  const a = win();
  if (a === null) return ["Run as administrator: Windows only."];
  const m = a.marker();
  const task = await a.taskExists(a.TASK);
  const el = a.elevated();
  return [
    `Run as administrator: ${m === null ? "off" : "on"}${m === null ? "" : ` since ${new Date(m.since).toISOString()} (start at login ${m.login ? "on" : "off"}, ${m.exe})`}`,
    `this process: ${el === null ? "unknown" : el ? "elevated (administrator token)" : "not elevated (normal rights)"}; account: ${a.tokenKind() === "default" && el !== true ? "no administrator token to raise" : "administrator"}`,
    `task "${a.TASK}": ${task ? "registered" : "not found"}`,
  ];
}
