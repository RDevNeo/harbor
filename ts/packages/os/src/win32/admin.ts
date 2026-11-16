// "Run as administrator" on Windows: Harbor, and everything it starts, with the user's full administrator token and no
// UAC prompt after the one that turns it on. That prompt runs Harbor's own exe (`harbor admin-task install`), which
// registers a scheduled task (TASK) for this user only: "Run with highest privileges", in the user's desktop session,
// with no time limit, also on battery. The task runs `harbor admin-start`, which starts Harbor with the arguments
// and the few environment values a non-elevated Harbor left in PENDING (or `--background` at logon, when start at
// login is on), then leaves: the task is done at once, and Harbor isn't one of its processes.
//
// A Harbor that starts without the token while it's on (the Start menu, the desktop shortcut, a terminal) hands its
// start to the task and leaves (run.ts); one with it starts the next one itself, which inherits the token (updates,
// rollbacks, `harbor restart`), so every relaunch stays elevated. Turning it off from an elevated Harbor needs no
// prompt: a second task with the user's normal token (LIMITED_TASK) starts the next Harbor, and both tasks go.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateHome } from "../paths.ts";
import { platform } from "../platform.ts";

type Env = Record<string, string | undefined>;

/** The scheduled task that starts Harbor elevated, as Task Scheduler lists it. */
export const TASK = "Harbor (elevated)";
/** The one-off task that starts Harbor with the normal token again, while turning it off. */
export const LIMITED_TASK = "Harbor (normal rights)";
/** Set by `admin-start` for the Harbor it starts: that one never hands its start to the task again. */
export const VIA_TASK = "HARBOR_VIA_TASK";
/** The only environment a start through the task takes from the Harbor that asked for it (a restart's handover). */
export const PASSED_ENV = ["HARBOR_RELOADED_PID", "HARBOR_HANDOVER"] as const;
/** How long a start left for the task stays good. */
const PENDING_MS = 60_000;

// ---- the token ----

const H = FFIType.u64;
let libs: { k: { GetCurrentProcess: () => bigint; CloseHandle: (h: bigint) => number }; a: { OpenProcessToken: (h: bigint, access: number, out: unknown) => number; GetTokenInformation: (h: bigint, cls: number, out: unknown, len: number, ret: unknown) => number } } | null | undefined;
function lib(): typeof libs {
  if (libs !== undefined) return libs;
  libs = null;
  if (platform() !== "win32") return libs;
  try {
    const k = dlopen("kernel32.dll", { GetCurrentProcess: { args: [], returns: H }, CloseHandle: { args: [H], returns: FFIType.i32 } }).symbols;
    const a = dlopen("advapi32.dll", {
      OpenProcessToken: { args: [H, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      GetTokenInformation: { args: [H, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    }).symbols;
    libs = { k: k as never, a: a as never };
  } catch {
    libs = null;
  }
  return libs;
}

const TOKEN_QUERY = 0x8;
const TOKEN_ELEVATION_TYPE = 18;
const TOKEN_ELEVATION = 20;

/** A DWORD of this process's token (TOKEN_INFORMATION_CLASS `cls`); null where it can't be read. */
function tokenDword(cls: number): number | null {
  const l = lib();
  if (!l) return null;
  const h = new BigUint64Array(1);
  if (!l.a.OpenProcessToken(l.k.GetCurrentProcess(), TOKEN_QUERY, ptr(h))) return null;
  const tok = h[0] ?? 0n;
  try {
    const out = new Uint32Array(1);
    const len = new Uint32Array(1);
    return l.a.GetTokenInformation(tok, cls, ptr(out), 4, ptr(len)) ? (out[0] ?? 0) : null;
  } finally {
    l.k.CloseHandle(tok);
  }
}

/** Whether this process has the administrator token (null: unknown). */
export function elevated(): boolean | null {
  const v = tokenDword(TOKEN_ELEVATION);
  return v === null ? null : v !== 0;
}

/**
 * The token's kind: "limited" is an administrator's filtered token (the usual one: UAC can raise it), "full" the
 * raised one, "default" an account with no second token (a standard user, or UAC turned off).
 */
export function tokenKind(): "default" | "full" | "limited" | null {
  const v = tokenDword(TOKEN_ELEVATION_TYPE);
  return v === 1 ? "default" : v === 2 ? "full" : v === 3 ? "limited" : null;
}

/** Whether this account can have Harbor elevated: it's an administrator (raised already, or UAC can raise it). */
export function canElevate(): boolean {
  return elevated() === true || tokenKind() === "limited";
}

// ---- what's on ----

/** The setting, kept beside Harbor's other per-PC state: on while the file is there. */
export interface Marker {
  /** Start at login, while it's on (the task's logon start; the Run value is gone meanwhile). */
  login: boolean;
  /** The harbor.exe the task runs. */
  exe: string;
  /** When it was turned on (ms). */
  since: number;
}

const dir = (env: Env = process.env): string => join(stateHome(env), "harbor");
export const markerPath = (env: Env = process.env): string => join(dir(env), "run-as-admin.json");
export const pendingPath = (env: Env = process.env): string => join(dir(env), "admin-start.json");
const takenPath = (env: Env = process.env): string => `${pendingPath(env)}.taken`;

export function marker(env: Env = process.env): Marker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath(env), "utf8")) as Partial<Marker>;
    if (typeof m.exe !== "string") return null;
    return { login: m.login === true, exe: m.exe, since: typeof m.since === "number" ? m.since : 0 };
  } catch {
    return null;
  }
}

function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(v)}\n`);
  renameSync(tmp, path);
}

export function writeMarker(m: Marker, env: Env = process.env): void {
  writeJson(markerPath(env), m);
}

export function removeMarker(env: Env = process.env): void {
  rmSync(markerPath(env), { force: true });
}

/**
 * What the person chose, kept over updates: `off` (`harbor admin off`: Harbor never sets it up again by itself), or
 * the minor version (`0.187`) whose start asked and saw Windows' prompt declined (asked again once a later minor
 * version comes). Nothing: the default, Harbor runs as administrator.
 */
export interface Choice {
  off: boolean;
  declined: string;
  /** What the declined (or failed) attempt said ("" none). */
  why: string;
}

export const choicePath = (env: Env = process.env): string => join(dir(env), "admin-choice.json");

export function readChoice(env: Env = process.env): Choice {
  try {
    const c = JSON.parse(readFileSync(choicePath(env), "utf8")) as Partial<Choice>;
    return { off: c.off === true, declined: typeof c.declined === "string" ? c.declined : "", why: typeof c.why === "string" ? c.why : "" };
  } catch {
    return { off: false, declined: "", why: "" };
  }
}

export function writeChoice(c: Choice, env: Env = process.env): void {
  if (!c.off && c.declined === "") rmSync(choicePath(env), { force: true });
  else writeJson(choicePath(env), c);
}

/** "0.187" of "0.187.6+abc": the versions a declined prompt waits out. */
export const minorOf = (version: string): string => /^v?(\d+\.\d+)/.exec(version)?.[1] ?? version;

// ---- the task ----

const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export interface TaskSpec {
  /** harbor.exe. */
  exe: string;
  /** The user's SID (S-1-5-21-…): the task is theirs alone. */
  sid: string;
  /** The folder Harbor starts in (the user's home). */
  home: string;
  /** "highest": the administrator token; "limited": the normal one (LIMITED_TASK). */
  level: "highest" | "limited";
  /** A logon trigger for this user (TASK always has one: `admin-start` checks start at login itself). */
  logon: boolean;
}

/** The task as Task Scheduler's XML (`schtasks /create /xml`). */
export function taskXml(t: TaskSpec): string {
  const trigger = t.logon ? `\n  <Triggers>\n    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${xml(t.sid)}</UserId>\n    </LogonTrigger>\n  </Triggers>` : "";
  const what =
    t.level === "highest"
      ? "Starts Harbor with administrator rights (Harbor: Settings, General, Run as administrator). Turning that off there removes this task."
      : "Starts Harbor with normal rights again, once (Harbor removes it right after).";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Harbor</Author>
    <Description>${xml(what)}</Description>
  </RegistrationInfo>${trigger}
  <Principals>
    <Principal id="Author">
      <UserId>${xml(t.sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>${t.level === "highest" ? "HighestAvailable" : "LeastPrivilege"}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(t.exe)}</Command>
      <Arguments>admin-start</Arguments>
      <WorkingDirectory>${xml(t.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16 with its byte order mark, as the XML says it is. */
export function utf16(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

const system32 = (env: Env = process.env): string => join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32");

/** A Windows tool, hidden (no console window), its output and exit code. */
async function tool(argv: string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, out: `${out}${err}`.trim() };
  } catch (e) {
    return { code: -1, out: e instanceof Error ? e.message : String(e) };
  }
}

const schtasks = (args: string[]) => tool([join(system32(), "schtasks.exe"), ...args]);

/** Whether `name` is registered (this user can see it). */
export async function taskExists(name: string = TASK): Promise<boolean> {
  return (await schtasks(["/query", "/tn", name])).code === 0;
}

/** Registers `name` from an XML file. Needs the administrator token for TASK. */
export async function createTask(name: string, xmlFile: string): Promise<{ ok: boolean; out: string }> {
  const r = await schtasks(["/create", "/tn", name, "/xml", xmlFile, "/f"]);
  return { ok: r.code === 0, out: r.out };
}

export async function deleteTask(name: string): Promise<{ ok: boolean; out: string }> {
  const r = await schtasks(["/delete", "/tn", name, "/f"]);
  return { ok: r.code === 0, out: r.out };
}

/** The user's SID, from `whoami /user`. */
export async function userSid(): Promise<string | null> {
  const r = await tool([join(system32(), "whoami.exe"), "/user", "/fo", "csv", "/nh"]);
  return /"(S-1-[0-9-]+)"/.exec(r.out)?.[1] ?? null;
}

// ---- starting Harbor through a task ----

interface Pending {
  id: string;
  args: string[];
  env: Record<string, string>;
  at: number;
}

/** The arguments a start through the task may carry: a window, or none (`--background`). */
export const passable = (args: readonly string[]): boolean => args.length === 0 || (args.length === 1 && args[0] === "--background");

/**
 * Asks task `name` to start Harbor with `args` and the PASSED_ENV values of `env`, and returns at once: `schtasks
 * /run` runs detached, so it goes on when this process leaves right after (a restart). `ran`: whether Task Scheduler
 * took the request; `waitTaken(id)` then says which process the task started.
 */
export function launchThrough(name: string, args: readonly string[], env: Env = {}): { id: string; ran: Promise<boolean> } | null {
  if (!passable(args)) return null;
  const id = `${process.pid}-${Date.now()}`;
  const passed: Record<string, string> = {};
  for (const k of PASSED_ENV) {
    const v = env[k];
    if (v !== undefined) passed[k] = v;
  }
  try {
    rmSync(takenPath(), { force: true });
    writeJson(pendingPath(), { id, args: [...args], env: passed, at: Date.now() } satisfies Pending);
  } catch (e) {
    console.error(`harbor: Run as administrator: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  // The new window may come to the front: Windows gives that only to the app the user is using (this one).
  allowAnyForeground();
  let ran: Promise<boolean>;
  try {
    const p = Bun.spawn([join(system32(), "schtasks.exe"), "/run", "/tn", name], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, detached: true });
    ran = p.exited.then((code) => {
      if (code !== 0) {
        dropPending(id);
        console.error(`harbor: the task "${name}" didn't start (schtasks exited with ${code})`);
      }
      return code === 0;
    });
  } catch (e) {
    dropPending(id);
    console.error(`harbor: the task "${name}" didn't start: ${e instanceof Error ? e.message : String(e)}`);
    ran = Promise.resolve(false);
  }
  return { id, ran };
}

function dropPending(id: string): void {
  try {
    if ((JSON.parse(readFileSync(pendingPath(), "utf8")) as Pending).id === id) rmSync(pendingPath(), { force: true });
  } catch {
    // gone
  }
}

/** The pid of the Harbor the task started for request `id`, or null when none did within `waitMs` (it then won't). */
export async function waitTaken(id: string, waitMs = 20_000): Promise<number | null> {
  for (const end = Date.now() + waitMs; Date.now() < end; await Bun.sleep(100)) {
    try {
      const t = JSON.parse(readFileSync(takenPath(), "utf8")) as { id?: string; pid?: number };
      if (t.id === id && typeof t.pid === "number") {
        rmSync(takenPath(), { force: true });
        return t.pid;
      }
    } catch {
      // not yet
    }
  }
  // Nobody took it: it mustn't start a Harbor later.
  dropPending(id);
  return null;
}

/** `launchThrough` and its wait: the new Harbor's pid, or null when the task didn't start one. */
export async function startThrough(name: string, args: readonly string[], env: Env = {}, waitMs = 20_000): Promise<number | null> {
  const l = launchThrough(name, args, env);
  if (l === null || !(await l.ran)) return null;
  return waitTaken(l.id, waitMs);
}

let user32: { AllowSetForegroundWindow: (pid: number) => number } | null | undefined;
function allowAnyForeground(): void {
  if (user32 === undefined) {
    user32 = null;
    try {
      user32 = dlopen("user32.dll", { AllowSetForegroundWindow: { args: [FFIType.u32], returns: FFIType.i32 } }).symbols as never;
    } catch {
      // no window station
    }
  }
  user32?.AllowSetForegroundWindow(0xffffffff); // ASFW_ANY
}

/** `harbor admin-start` (the task's action): what to start, from PENDING or, at logon, the setting. Null: nothing. */
export function takeStart(env: Env = process.env, now = Date.now()): { id: string | null; args: string[]; env: Record<string, string> } | null {
  let p: Pending | null = null;
  try {
    p = JSON.parse(readFileSync(pendingPath(env), "utf8")) as Pending;
  } catch {
    // none
  }
  rmSync(pendingPath(env), { force: true });
  if (p !== null && typeof p.id === "string" && Array.isArray(p.args) && passable(p.args) && typeof p.at === "number" && now - p.at < PENDING_MS) {
    const passed: Record<string, string> = {};
    for (const k of PASSED_ENV) {
      const v = p.env?.[k];
      if (typeof v === "string") passed[k] = v;
    }
    return { id: p.id, args: p.args, env: passed };
  }
  // Nothing asked for: the logon trigger. Harbor starts in the background then, if start at login is on.
  const m = marker(env);
  return m?.login ? { id: null, args: ["--background"], env: {} } : null;
}

/** Tells the Harbor that asked which process the task started. */
export function tellTaken(id: string, pid: number, env: Env = process.env): void {
  try {
    writeJson(takenPath(env), { id, pid });
  } catch {
    // it gives up after its wait
  }
}

// ---- the one prompt ----

/**
 * Runs `exe args` with the administrator token: Windows shows its prompt (UAC) and this waits for the program. The
 * prompt is Windows' own; PowerShell only asks for it ("runas"), hidden.
 */
export async function runElevated(exe: string, args: readonly string[]): Promise<{ code: number; declined: boolean; out: string }> {
  const q = (s: string): string => `'${s.replaceAll("'", "''")}'`;
  const line = args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$si = New-Object System.Diagnostics.ProcessStartInfo",
    `$si.FileName = ${q(exe)}`,
    `$si.Arguments = ${q(line)}`,
    "$si.Verb = 'runas'",
    "$si.UseShellExecute = $true",
    "$si.WindowStyle = 'Hidden'",
    "try { $p = [System.Diagnostics.Process]::Start($si); $p.WaitForExit(); exit $p.ExitCode }",
    "catch [System.ComponentModel.Win32Exception] { [Console]::Error.WriteLine($_.Exception.Message); exit $_.Exception.NativeErrorCode }",
  ].join("\n");
  const ps = join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = await tool([ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], 10 * 60_000);
  // ERROR_CANCELLED: the person said No (or the prompt timed out).
  return { code: r.code, declined: r.code === 1223, out: r.out };
}

/** `harbor admin-task install XML RESULT` / `remove RESULT`, run elevated: the task registered or removed, said in RESULT. */
export async function taskCommand(args: readonly string[]): Promise<number> {
  const [verb, a, b] = args;
  const result = verb === "install" ? b : a;
  let r: { ok: boolean; out: string };
  if (verb === "install" && a !== undefined) r = await createTask(TASK, a);
  else if (verb === "remove") {
    r = await deleteTask(TASK);
    if (!r.ok && !(await taskExists(TASK))) r = { ok: true, out: "" };
    if (await taskExists(LIMITED_TASK)) await deleteTask(LIMITED_TASK);
  } else {
    console.error("usage: harbor admin-task install XML RESULT | remove RESULT");
    return 2;
  }
  if (result !== undefined) {
    try {
      writeJson(result, r);
    } catch {
      // the exit code says enough
    }
  }
  return r.ok ? 0 : 1;
}

export function readResult(path: string): { ok: boolean; out: string } | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as { ok?: unknown; out?: unknown };
    return { ok: r.ok === true, out: typeof r.out === "string" ? r.out : "" };
  } catch {
    return null;
  }
}

/** A file of this feature's own in Harbor's state folder (the task's XML, the elevated helper's answer). */
export const scratchPath = (name: string, env: Env = process.env): string => join(dir(env), name);

/** That file written (UTF-16 with a BOM for XML). */
export function writeScratch(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export const exists = (p: string): boolean => existsSync(p);
