import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookLines, state, withHook } from "../src/admin.ts";
import { choicePath, LIMITED_TASK, marker, minorOf, passable, pendingPath, readChoice, removeMarker, takeStart, TASK, taskXml, tellTaken, utf16, writeChoice, writeMarker } from "../src/win32/admin.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const env = () => {
  const d = mkdtempSync(join(tmpdir(), "harbor-admin-"));
  dirs.push(d);
  return { XDG_STATE_HOME: d };
};

test("an OS that is none of Windows, Linux and macOS has nothing to show", () => {
  const was = process.env.HARBOR_TEST_PLATFORM;
  process.env.HARBOR_TEST_PLATFORM = "freebsd";
  try {
    expect(state()).toEqual({ supported: false, kind: null, preexisting: false, why: "", on: false, elevated: false, canElevate: false, off: false, declined: "" });
  } finally {
    if (was === undefined) delete process.env.HARBOR_TEST_PLATFORM;
    else process.env.HARBOR_TEST_PLATFORM = was;
  }
});

test("the person's choice outlives updates: off for good, or a declined prompt that waits for the next minor version", () => {
  const e = env();
  expect(readChoice(e)).toEqual({ off: false, declined: "", why: "" });
  writeChoice({ off: false, declined: minorOf("0.187.99+3303a45"), why: "declined" }, e);
  expect(readChoice(e)).toEqual({ off: false, declined: "0.187", why: "declined" });
  expect(minorOf("0.188.0")).not.toBe(readChoice(e).declined);
  writeChoice({ off: true, declined: "", why: "" }, e);
  expect(readChoice(e).off).toBe(true);
  // Back to the default: nothing kept.
  writeChoice({ off: false, declined: "", why: "" }, e);
  expect(existsSync(choicePath(e))).toBe(false);
});

test("the task: this user's alone, the administrator token, in their desktop, no time limit, on battery, normal priority", () => {
  const x = taskXml({ exe: String.raw`C:\Users\A & B\AppData\Local\Programs\Hub\harbor.exe`, sid: "S-1-5-21-1-2-3-1001", home: String.raw`C:\Users\A & B`, level: "highest", logon: true });
  expect(x).toStartWith('<?xml version="1.0" encoding="UTF-16"?>');
  expect(x).toContain("<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>S-1-5-21-1-2-3-1001</UserId>");
  expect(x).toContain("<UserId>S-1-5-21-1-2-3-1001</UserId>\n      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>HighestAvailable</RunLevel>");
  for (const s of ["<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", "<Priority>4</Priority>", "<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>"]) expect(x).toContain(s);
  expect(x).toContain(String.raw`<Command>C:\Users\A &amp; B\AppData\Local\Programs\Hub\harbor.exe</Command>`);
  expect(x).toContain(String.raw`<WorkingDirectory>C:\Users\A &amp; B</WorkingDirectory>`);
  expect(x).toContain("<Arguments>admin-start</Arguments>");
  const limited = taskXml({ exe: String.raw`C:\h.exe`, sid: "S-1-5-21-9", home: "C:\\", level: "limited", logon: false });
  expect(limited).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(limited).not.toContain("<Triggers>");
  expect(TASK).toBe("Hub (elevated)");
  expect(LIMITED_TASK).not.toBe(TASK);
  // schtasks reads it as UTF-16 with its byte order mark.
  expect([...utf16("<").subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00]);
});

test("start at login is still the Run value Windows reads (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Hub)", async () => {
  const { where } = await import("../src/win32/login.ts");
  expect(where).toBe(String.raw`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run\Hub`);
});

test("a start through the task carries a window or the background, nothing else", () => {
  expect(passable([])).toBe(true);
  expect(passable(["--background"])).toBe(true);
  expect(passable(["turn"])).toBe(false);
  expect(passable(["--background", "x"])).toBe(false);
});

test("the task's start: what a Hub left for it, once and while fresh, with only the handover's environment", () => {
  const e = env();
  expect(takeStart(e)).toBeNull();
  const now = Date.now();
  const leave = (p: unknown) => {
    mkdirSync(join(e.XDG_STATE_HOME, "harbor"), { recursive: true });
    writeFileSync(pendingPath(e), JSON.stringify(p));
  };
  leave({ id: "1-2", args: [], env: { HARBOR_HANDOVER: String.raw`C:\run\h`, HARBOR_RELOADED_PID: "42", BUN_OPTIONS: "--preload evil.js" }, at: now });
  expect(takeStart(e, now + 1000)).toEqual({ id: "1-2", args: [], env: { HARBOR_HANDOVER: String.raw`C:\run\h`, HARBOR_RELOADED_PID: "42" } });
  expect(existsSync(pendingPath(e))).toBe(false);
  expect(takeStart(e, now + 1000)).toBeNull();
  // Stale, or asking for anything but a window: not started (and gone).
  leave({ id: "3", args: [], env: {}, at: now });
  expect(takeStart(e, now + 61_000)).toBeNull();
  leave({ id: "4", args: ["mcp"], env: {}, at: now });
  expect(takeStart(e, now)).toBeNull();
  expect(existsSync(pendingPath(e))).toBe(false);
  // Nothing asked for is the logon trigger: the background, when start at login is on.
  writeMarker({ login: false, exe: String.raw`C:\h.exe`, since: 1 }, e);
  expect(takeStart(e)).toBeNull();
  writeMarker({ login: true, exe: String.raw`C:\h.exe`, since: 1 }, e);
  expect(takeStart(e)).toEqual({ id: null, args: ["--background"], env: {} });
  expect(marker(e)).toEqual({ login: true, exe: String.raw`C:\h.exe`, since: 1 });
  removeMarker(e);
  expect(marker(e)).toBeNull();
  tellTaken("5", 77, e);
  expect(JSON.parse(readFileSync(`${pendingPath(e)}.taken`, "utf8"))).toEqual({ id: "5", pid: 77 });
});

test("uninstall.ps1 gets the task's removal first while it's on, and loses it after, as it was", () => {
  const before = '$env:HARBOR_UNINSTALL = "1"\r\n$s = Join-Path $env:TEMP "harbor-uninstall.ps1"\r\n& powershell -NoProfile -File $s -Uninstall\r\n';
  const on = withHook(before, true);
  expect(on.startsWith(hookLines()[0] ?? "x")).toBe(true);
  expect(on).toContain("\r\n");
  expect(on).toContain(`-ArgumentList '/delete /tn "Hub (elevated)" /f' -Verb RunAs`);
  expect(on).toContain(String.raw`"harbor\run-as-admin.json"`);
  expect(withHook(on, true)).toBe(on);
  expect(withHook(on, false)).toBe(before);
  expect(withHook(before, false)).toBe(before);
});
