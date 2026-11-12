import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { autostart, clipboard, desktop, env, keychain, libc, lock, paths, platform, proc, spawn, sys } from "../src/index.ts";

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
  test.if(process.platform !== "win32")("XDG folders, and their defaults under the home", () => {
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

  test.if(process.platform === "win32")("Windows: %APPDATA% and %LOCALAPPDATA%, else under the profile", () => {
    const env = { USERPROFILE: "C:\\Users\\sam", APPDATA: "D:\\roam", LOCALAPPDATA: "D:\\local" };
    expect(paths.home(env)).toBe("C:\\Users\\sam");
    expect([paths.dataHome(env), paths.configHome(env), paths.stateHome(env), paths.cacheHome(env)]).toEqual(["D:\\roam", "D:\\roam", "D:\\local", "D:\\local\\Cache"]);
    const bare = { USERPROFILE: "C:\\Users\\sam" };
    expect([paths.dataHome(bare), paths.stateHome(bare)]).toEqual(["C:\\Users\\sam\\AppData\\Roaming", "C:\\Users\\sam\\AppData\\Local"]);
  });
});

describe("paths: ~ and folders", () => {
  test("tilde and under, as Linux and macOS write paths", () => {
    const was = process.env.HARBOR_TEST_PLATFORM;
    process.env.HARBOR_TEST_PLATFORM = "linux";
    try {
      linuxPaths();
    } finally {
      if (was === undefined) delete process.env.HARBOR_TEST_PLATFORM;
      else process.env.HARBOR_TEST_PLATFORM = was;
    }
  });
  const linuxPaths = (): void => {
    expect(paths.tilde("/h", "/h")).toBe("~");
    expect(paths.tilde("/h/x/y", "/h/")).toBe("~/x/y");
    expect(paths.tilde("/hx/y", "/h")).toBe("/hx/y");
    expect(paths.tilde("/h/x/", "/h", true)).toBe("~/x");
    expect(paths.under("/h/x/y", "/h")).toBe("x/y");
    expect(paths.under("/h", "/h")).toBe("");
    expect(paths.under("/hx", "/h")).toBeNull();
    expect(paths.under("/H/x", "/h")).toBeNull();
  };
  test("on Windows: either separator, any case", () => {
    const was = process.env.HARBOR_TEST_PLATFORM;
    process.env.HARBOR_TEST_PLATFORM = "win32";
    try {
      expect(paths.tilde("C:\\Users\\Sam\\Projects\\x", "c:\\users\\sam")).toBe("~/Projects/x");
      expect(paths.tilde("C:/Users/Sam", "C:\\Users\\Sam\\")).toBe("~");
      expect(paths.tilde("D:\\x", "C:\\Users\\Sam")).toBe("D:\\x");
      expect(paths.under("C:\\Users\\Sam\\a\\b.png", "c:/users/sam")).toBe("a\\b.png");
      expect(paths.under("C:\\Users\\Samuel", "C:\\Users\\Sam")).toBeNull();
      expect(paths.under("C:\\Users\\Sam", "C:\\Users\\Sam\\")).toBe("");
    } finally {
      if (was === undefined) delete process.env.HARBOR_TEST_PLATFORM;
      else process.env.HARBOR_TEST_PLATFORM = was;
    }
  });
});

describe("desktop", () => {
  test("the opener per OS", () => {
    expect(desktop.opener("linux")).toEqual(["xdg-open"]);
    expect(desktop.opener("darwin")).toEqual(["open"]);
    expect(desktop.opener("win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler"]);
  });

  test("no compositor to ask: nothing raised", () => {
    expect(desktop.raise({})).toBe(false);
    expect(desktop.hyprland({})).toBe(false);
  });

  test("Downloads: the desktop's own folder, else the home's", () => {
    const d = desktop.downloadsDir({ HOME: "/nowhere-home" });
    expect(isAbsolute(d)).toBe(true);
    expect(d === join("/nowhere-home", "Downloads") || d !== "/nowhere-home").toBe(true);
  });
});

describe("keychain", () => {
  test("only macOS has one: elsewhere every call answers nothing", () => {
    if (process.platform === "darwin") return;
    expect(keychain.available()).toBe(false);
    expect(keychain.read("harbor-test")).toBeNull();
    expect(keychain.has("harbor-test")).toBe(false);
    expect(keychain.write("harbor-test", "x")).toBe(false);
    expect(keychain.account({ USER: "sam" })).toBe("sam");
  });
});

describe.if(process.platform === "darwin")("macOS", () => {
  test("proc: this process, a child's group, one that ended", async () => {
    const s = proc.stat(process.pid);
    expect(s?.ppid).toBe(process.ppid);
    const start = proc.procStart(process.pid) as number;
    expect(proc.alive(process.pid, start)).toBe(true);
    expect(Math.abs((proc.startedAt(process.pid) as number) - Date.now() / 1000)).toBeLessThan(3600);
    expect(proc.cmdline(process.pid)?.length).toBeGreaterThan(0);
    expect(proc.ownerOf(process.pid)).toBe(process.getuid?.() as number);
    expect(proc.pids()).toContain(process.pid);
    expect((proc.stat(process.pid)?.rssPages ?? 0) * proc.pageSize()).toBeGreaterThan(1 << 20);
    const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    expect(proc.parentOf(child.pid)).toBe(process.pid);
    expect(proc.cmdline(child.pid)).toEqual(["sleep", "30"]);
    expect(proc.group(proc.stat(child.pid)?.pgid as number)).toContain(child.pid);
    expect(proc.descendants(process.pid)).toContain(child.pid);
    child.kill("SIGKILL");
    await child.exited;
    expect(proc.running(child.pid)).toBe(false);
  });

  test("sys: memory and boot", () => {
    const m = sys.memory();
    expect(m?.total).toBeGreaterThan(1 << 30);
    expect(m?.available).toBeGreaterThan(0);
    expect(m?.available).toBeLessThan(m?.total as number);
    expect(sys.bootId()).toMatch(/^\d+\.\d+$/);
    expect(sys.netTable("tcp")).toBeNull();
  });

  test("libc and the detached start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hos-"));
    try {
      const a = openSync(join(dir, "l"), "a+");
      const b = openSync(join(dir, "l"), "a+");
      expect(libc.flock(a, libc.LOCK_EX | libc.LOCK_NB)).toBe(0);
      expect(libc.flock(b, libc.LOCK_EX | libc.LOCK_NB)).not.toBe(0);
      closeSync(a);
      closeSync(b);
      expect(spawn.detachedArgv(["x"])).toBeNull();
      spawn.startDetached(["sh", "-c", `echo $$ > ${join(dir, "pid")}`]);
      for (let i = 0; i < 100 && !existsSync(join(dir, "pid")); i++) await Bun.sleep(20);
      expect(existsSync(join(dir, "pid"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keychain: a missing item reads as none", () => {
    expect(keychain.available()).toBe(false);
    expect(keychain.available({ ...process.env, HARBOR_NO_KEYCHAIN: "" })).toBe(true);
    delete process.env.HARBOR_NO_KEYCHAIN;
    expect(keychain.read(`harbor-test-missing-${process.pid}`)).toBeNull();
    expect(keychain.has(`harbor-test-missing-${process.pid}`)).toBe(false);
  });

  // Over SSH the login keychain takes no writes ("User interaction is not allowed"): only in a desktop session.
  test.skipIf(!!process.env.SSH_CONNECTION)("keychain: an item written, read back and removed", () => {
    const svc = `harbor-test-${process.pid}`;
    try {
      expect(keychain.write(svc, '{"a":"b \\" c"}')).toBe(true);
      expect(keychain.has(svc)).toBe(true);
      expect(keychain.read(svc)).toBe('{"a":"b \\" c"}');
      expect(keychain.write(svc, "second")).toBe(true);
      expect(keychain.read(svc)).toBe("second");
    } finally {
      expect(keychain.remove(svc)).toBe(true);
      process.env.HARBOR_NO_KEYCHAIN = "1";
    }
  });
});

describe("proc.pause", () => {
  test.if(process.platform === "win32")("Windows: a paused process stops, and runs on when let go", async () => {
    const d = mkdtempSync(join(tmpdir(), "hos-pause-"));
    const f = join(d, "ticks");
    const p = Bun.spawn([process.execPath, "-e", `const fs = require("fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(f)}, "x"), 20);`]);
    try {
      await Bun.sleep(400);
      proc.pause([p.pid], true);
      await Bun.sleep(100);
      const held = Bun.file(f).size;
      await Bun.sleep(300);
      expect(Bun.file(f).size).toBe(held);
      proc.pause([p.pid], false);
      await Bun.sleep(300);
      expect(Bun.file(f).size).toBeGreaterThan(held);
    } finally {
      p.kill();
      await p.exited;
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("env", () => {
  // test/preload.ts ran env.normalize(): on Windows, Bun.spawn runs #! scripts with their interpreter.
  test.if(process.platform === "win32")("Windows: Bun.spawn runs a #! script, arguments as they are", () => {
    const d = mkdtempSync(join(tmpdir(), "hos-shebang-"));
    try {
      writeFileSync(join(d, "tool"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`);
      const r = Bun.spawnSync([join(d, "tool"), 'a"b', "x&y", "%PATH%"]);
      expect(JSON.parse(r.stdout.toString())).toEqual(['a"b', "x&y", "%PATH%"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("macOS children get a UTF-8 locale when none is set", () => {
    expect(env.childDefaults({ HARBOR_TEST_PLATFORM: "darwin" })).toEqual({ LANG: "en_US.UTF-8" });
    expect(env.childDefaults({ HARBOR_TEST_PLATFORM: "darwin", LC_CTYPE: "UTF-8" })).toEqual({});
    expect(env.childDefaults({ HARBOR_TEST_PLATFORM: "linux" })).toEqual({});
  });
});

describe("tcp listeners", () => {
  test("Linux's tables and macOS's netstat", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1",
      "   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1",
    ].join("\n");
    expect(sys.parseProcTcp(tcp)).toEqual([{ port: 3000, uid: 1000 }]);
    const ns = [
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state",
      "tcp4       0      0  *.3002                 *.*                    LISTEN                 0            0  131072  131072             node:17555  00100",
      "tcp6       0      0  ::1.8788               *.*                    LISTEN                 0            0  131072  131072              bun:9  00100",
      "tcp4       0      0  10.0.0.2.51000         10.0.0.9.443           ESTABLISHED            0            0  131072  131072              bun:9  00100",
    ].join("\n");
    expect(sys.parseNetstat(ns, (pid) => (pid === 9 ? 501 : undefined))).toEqual([
      { port: 3002, uid: null },
      { port: 8788, uid: 501 },
    ]);
  });

  test.if(process.platform === "linux" || process.platform === "darwin")("this process's server is found, as its own", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const mine = sys.tcpListeners()?.filter((l) => l.port === server.port) ?? [];
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((l) => l.uid === process.getuid?.())).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe.if(process.platform === "darwin")("macOS clipboard (a private pasteboard, never the user's)", () => {
  test("every type at once: text, HTML, an image and a file; read back by MIME type", () => {
    const name = `harbor-test-${process.pid}`;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const enc = new TextEncoder();
    const token = clipboard.write(
      [
        { mime: "text/plain;charset=utf-8", data: enc.encode("héllo 日本") },
        { mime: "UTF8_STRING", data: enc.encode("ignored: text has one type there") },
        { mime: "text/html", data: enc.encode("<p>héllo</p>") },
        { mime: "image/png", data: png },
        { mime: "text/uri-list", data: enc.encode("file:///tmp/a.png\r\nfile:///tmp/b.png\r\n") },
      ],
      name,
    );
    expect(token).not.toBeNull();
    expect(clipboard.types(name)).toEqual(["text/plain;charset=utf-8", "text/html", "image/png", "text/uri-list"]);
    expect(new TextDecoder().decode(clipboard.read("text/plain", name) ?? new Uint8Array())).toBe("héllo 日本");
    expect(clipboard.read("image/png", name)).toEqual(png);
    expect(new TextDecoder().decode(clipboard.read("text/uri-list", name) ?? new Uint8Array())).toBe("file:///tmp/a.png\r\n");
    expect(clipboard.stillOurs(token as number, name)).toBe(true);
    clipboard.write([{ mime: "text/plain", data: enc.encode("someone else's") }], name);
    expect(clipboard.stillOurs(token as number, name)).toBe(false);
  });
});

describe("autostart", () => {
  // Windows' Run key: win32.test.ts.
  test.if(process.platform !== "win32")("Linux: an XDG autostart entry; macOS: a LaunchAgent in the user's session", () => {
    const linux = { HARBOR_TEST_PLATFORM: "linux", HOME: "/h" };
    const mac = { HARBOR_TEST_PLATFORM: "darwin", HOME: "/Users/sam" };
    expect(autostart.entryPath(linux)).toBe("/h/.config/autostart/harbor.desktop");
    expect(autostart.entryPath({ ...linux, XDG_CONFIG_HOME: "/c" })).toBe("/c/autostart/harbor.desktop");
    expect(autostart.entryPath(mac)).toBe("/Users/sam/Library/LaunchAgents/dev.harbor.Harbor.plist");
    const d = autostart.entry("/opt/my apps/harbor", "--background", linux);
    expect(d).toContain('Exec="/opt/my apps/harbor" --background');
    expect(autostart.isOn(d, "--background", linux)).toBe(true);
    expect(autostart.isOn(`${d}Hidden=true\n`, "--background", linux)).toBe(false);
    const p = autostart.entry("/Applications/Harbor & Co.app/Contents/MacOS/harbor", "--background", mac);
    expect(p).toContain("<string>/Applications/Harbor &amp; Co.app/Contents/MacOS/harbor</string>");
    expect(p).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(autostart.isOn(p, "--background", mac)).toBe(true);
    expect(autostart.isOn(p.replace("<key>RunAtLoad</key>", "<key>Disabled</key>\n  <true/>\n  <key>RunAtLoad</key>"), "--background", mac)).toBe(false);
  });
});

describe("lock", () => {
  test("one holder at a time, by path, and free again once released", () => {
    const dir = mkdtempSync(join(tmpdir(), "hlock-"));
    try {
      const path = join(dir, "x.lock");
      const a = lock.hold(path, false);
      expect(a).toBeTruthy();
      expect(lock.hold(path, false)).toBeNull();
      expect(lock.heldElsewhere(path)).toBe(true);
      a?.release();
      expect(lock.heldElsewhere(path)).toBe(false);
      const b = lock.hold(path, true);
      expect(b).toBeTruthy();
      b?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
