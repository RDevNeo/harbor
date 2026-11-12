import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktop, libc, paths, platform, proc, sys } from "../src/index.ts";

const linux = process.platform === "linux";

describe("platform", () => {
  test("names this OS, or the test's stand-in", () => {
    expect(platform({})).toBe(linux ? "linux" : platform({}));
    expect(platform({ HARBOR_TEST_PLATFORM: "darwin" })).toBe("darwin");
    expect(platform({ HARBOR_TEST_PLATFORM: "win32" })).toBe("win32");
    expect(platform({ HARBOR_TEST_PLATFORM: "plan9" })).toBe("other");
  });
});

describe.if(linux)("proc on Linux", () => {
  test("finds this process: alive, its start, parent and command line", () => {
    const s = proc.stat(process.pid);
    expect(s).toBeDefined();
    expect(s?.state).not.toBe("Z");
    const start = proc.procStart(process.pid);
    expect(start).toBe(s?.start as number);
    expect(proc.alive(process.pid, start as number)).toBe(true);
    expect(proc.alive(process.pid, (start as number) + 1)).toBe(false);
    expect(proc.liveStart(process.pid)).toBe(start as number);
    expect(proc.running(process.pid)).toBe(true);
    expect(proc.exists(process.pid)).toBe(true);
    expect(proc.parentOf(process.pid)).toBe(process.ppid);
    expect(proc.cmdline(process.pid)?.length).toBeGreaterThan(0);
    expect(proc.ownerOf(process.pid)).toBe(process.getuid?.() as number);
    expect(proc.myUid()).toBe(process.getuid?.() as number);
    expect(proc.pids()).toContain(process.pid);
    expect(proc.table().get(process.pid)?.ppid).toBe(process.ppid);
    expect(proc.descendants(process.ppid)).toContain(process.pid);
    const at = proc.startedAt(process.pid) as number;
    expect(Math.abs(at - Date.now() / 1000)).toBeLessThan(24 * 3600 * 365);
  });

  test("a child's group, and a child that ended", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    const s = proc.stat(child.pid);
    expect(s?.ppid).toBe(process.pid);
    expect(proc.group(s?.pgid as number)).toContain(child.pid);
    child.kill("SIGKILL");
    await child.exited;
    expect(proc.running(child.pid)).toBe(false);
    expect(proc.liveStart(child.pid)).toBeUndefined();
  });

  test("an open file is found through the process, also once deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "hos-"));
    const fd = openSync(join(dir, "f"), "w");
    try {
      expect(proc.openFile(process.pid, dir, "f")).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
      rmSync(join(dir, "f"));
      expect(proc.openFile(process.pid, dir, "f")).toBeDefined();
      expect(proc.openFile(process.pid, dir, "g")).toBeUndefined();
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses stat lines whose command holds spaces and parentheses", () => {
    const line = "4242 (a (b) c) S 17 4242 4242 0 -1 4194560 0 0 0 0 1 2 0 0 20 0 1 0 987654 1000000 2560 18446744073709551615";
    expect(proc.parseStat(line)).toEqual({ state: "S", ppid: 17, pgid: 4242, start: 987654, rssPages: 2560 });
    expect(proc.parseStat("garbage")).toBeUndefined();
  });

  test("page size and cgroup", () => {
    expect(proc.pageSize()).toBeGreaterThanOrEqual(4096);
    expect(typeof (proc.cgroupText("self") ?? "")).toBe("string");
    expect(proc.selfExeReplaced()).toBe(false);
  });
});

describe.if(linux)("sys on Linux", () => {
  test("memory, boot and network tables", () => {
    const m = sys.memory();
    expect(m?.total).toBeGreaterThan(0);
    expect(m?.available).toBeLessThanOrEqual(m?.total as number);
    expect(sys.memAvailableMb({})).toBe(Math.floor((sys.memory()?.available ?? 0) / 1048576));
    expect(sys.memAvailableMb({ HARBOR_TEST_MEMAVAIL_MB: "1234" })).toBe(1234);
    expect(sys.bootId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(sys.netTable("tcp")).toContain("local_address");
  });
});

describe("sys parsing", () => {
  test("meminfo", () => {
    const m = sys.parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n");
    expect(m).toEqual({ total: 1024000, available: 614400, swapTotal: 51200, swapFree: 20480 });
    expect(sys.parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\n")?.available).toBe(102400);
    expect(sys.parseMeminfo("nothing")).toBeNull();
  });
});

describe.if(linux)("libc on Linux", () => {
  test("flock: one holder at a time", () => {
    const dir = mkdtempSync(join(tmpdir(), "hos-"));
    const a = openSync(join(dir, "l"), "a+");
    const b = openSync(join(dir, "l"), "a+");
    try {
      expect(libc.flock(a, libc.LOCK_EX | libc.LOCK_NB)).toBe(0);
      expect(libc.flock(b, libc.LOCK_EX | libc.LOCK_NB)).not.toBe(0);
    } finally {
      closeSync(a);
      closeSync(b);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dup and close, glibc's version", () => {
    expect(libc.redirectable()).toBe(true);
    const fd = libc.dup(2) as number;
    expect(fd).toBeGreaterThan(2);
    expect(libc.close(fd)).toBe(0);
    const g = libc.glibc();
    if (g !== null) expect(g.version).toMatch(/^\d+\.\d+/);
  });

  test("libc names per OS", () => {
    expect(libc.libcNames("linux")).toEqual(["libc.so.6", "libc.so"]);
    expect(libc.libcNames("darwin")).toEqual(["libSystem.B.dylib"]);
    expect(libc.libcNames("win32")).toEqual([]);
  });
});

describe("paths", () => {
  test("XDG folders, and their defaults under the home", () => {
    const env = { HOME: "/h" };
    expect(paths.home(env)).toBe("/h");
    expect(paths.dataHome(env)).toBe("/h/.local/share");
    expect(paths.stateHome(env)).toBe("/h/.local/state");
    expect(paths.cacheHome(env)).toBe("/h/.cache");
    expect(paths.configHome(env)).toBe("/h/.config");
    expect(paths.runtimeDir(env)).toBeUndefined();
    const x = { HOME: "/h", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s", XDG_CACHE_HOME: "/c", XDG_CONFIG_HOME: "/g", XDG_RUNTIME_DIR: "/r" };
    expect([paths.dataHome(x), paths.stateHome(x), paths.cacheHome(x), paths.configHome(x), paths.runtimeDir(x)]).toEqual(["/d", "/s", "/c", "/g", "/r"]);
    expect(paths.runtimeDir({ XDG_RUNTIME_DIR: "relative" })).toBeUndefined();
  });
});

describe("desktop", () => {
  test("the opener per OS", () => {
    expect(desktop.opener("linux")).toEqual(["xdg-open"]);
    expect(desktop.opener("darwin")).toEqual(["open"]);
    expect(desktop.opener("win32")).toEqual(["cmd", "/c", "start", ""]);
  });

  test("no compositor to ask: nothing raised", () => {
    expect(desktop.raise({})).toBe(false);
    expect(desktop.hyprland({})).toBe(false);
  });

  test("Downloads: the desktop's own folder, else the home's", () => {
    const d = desktop.downloadsDir({ HOME: "/nowhere-home" });
    expect(d.startsWith("/")).toBe(true);
    expect(d === "/nowhere-home/Downloads" || d !== "/nowhere-home").toBe(true);
  });
});
