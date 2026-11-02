import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Display, Electron } from "../src/discordhost.ts";
import type { Mode } from "../src/discordhost.ts";
import * as setup from "../src/discordsetup.ts";
import { fakeElectron, fakeLog, plan, repoDiscord, sandbox, until } from "./discordkit.ts";

let box: ReturnType<typeof sandbox>;
let root = "";
const events: [Mode, Record<string, unknown>][] = [];
let engine: Electron;

beforeAll(() => {
  box = sandbox();
  process.env.HARBOR_DISCORD_NO_CGROUP = "1";
  process.env.HARBOR_DISCORD_ELECTRON = fakeElectron(box.dir);
  process.env.HARBOR_DISCORD_SHELL = repoDiscord;
  process.env.SECRET_FOR_AGENTS = "must not reach the page";
  root = setup.root();
});
afterAll(() => {
  delete process.env.SECRET_FOR_AGENTS;
  box.restore();
});
afterEach(async () => {
  await engine?.stop();
});

const make = (data = setup.profile()): Electron => {
  engine = new Electron(data, (mode, m) => events.push([mode, m]));
  return engine;
};

test("starts the shell with a clean environment and talks to it", async () => {
  events.length = 0;
  plan(root, { calls: { discord_view: { channel: "c1" } } });
  const e = make();
  expect(e.alive()).toBe(false);
  await e.start("run", new Display());
  await until(() => e.ready());
  expect(e.alive()).toBe(true);
  const started = fakeLog(root).find((l) => l.started === "run");
  const env = started?.env as string[];
  expect(env).toContain("HARBOR_DISCORD");
  expect(env).not.toContain("SECRET_FOR_AGENTS");
  expect(env.filter((k) => !["HOME", "PATH", "LANG", "TZ", "XDG_RUNTIME_DIR", "HARBOR_DISCORD", "PWD", "SHLVL", "_", "OLDPWD", "BUN_INSTALL", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"].includes(k))).toEqual([]);
  expect(started?.argv).toEqual([repoDiscord, "--ozone-platform=headless", "--ozone-override-screen-size=1280,720"]);
  const cfg = started?.cfg as Record<string, unknown>;
  expect(cfg.mode).toBe("run");
  expect(cfg.data).toBe(setup.profile());
  expect(cfg.page).toBe(join(root, "page.js"));
  expect(existsSync(join(root, "engine.pid"))).toBe(true);

  expect(await e.ask({ op: "state" }, 2000)).toEqual({ user: { id: "1" }, path: "/channels/@me" });
  const r = await e.ask({ op: "call", name: "discord_view", args: {} }, 2000);
  expect(r).toBe('{"channel":"c1"}');
  await expect(e.ask({ op: "nope" }, 2000)).rejects.toThrow("no such op: nope");
  expect(events.some(([mode, m]) => mode === "run" && m.ev === "ready")).toBe(true);

  await e.stop();
  expect(e.alive()).toBe(false);
  expect(e.ready()).toBe(false);
  expect(existsSync(join(root, "engine.pid"))).toBe(false);
  await expect(e.ask({ op: "state" }, 500)).rejects.toThrow("Discord isn't running.");
});

test("sign-in opens on the desktop it was started from; the rest is headless", async () => {
  const e = make();
  await e.start("signin", new Display("wayland-9", "", "/run/user/test"));
  await until(() => e.ready());
  const s = fakeLog(root).filter((l) => l.started === "signin").at(-1);
  expect(s?.argv).toEqual([repoDiscord, "--ozone-platform=wayland"]);
  expect(s?.wayland).toBe("wayland-9");
  await e.start("signin", new Display("", ":3", ""));
  await until(() => fakeLog(root).filter((l) => l.started === "signin").length === 2);
  const x = fakeLog(root).filter((l) => l.started === "signin").at(-1);
  expect(x?.argv).toEqual([repoDiscord, "--ozone-platform=x11"]);
  expect(x?.display).toBe(":3");
  expect(existsSync(join(root, "engine.pid"))).toBe(false);
});

test("an answer that never comes times out, and a shell that goes is reported", async () => {
  events.length = 0;
  plan(root, { silent: ["state"], exitAfterMs: 400 });
  const e = make();
  await e.start("run", new Display());
  await until(() => e.ready());
  await expect(e.ask({ op: "state" }, 150)).rejects.toThrow("didn't answer in time");
  await until(() => events.some(([, m]) => m.ev === "gone"));
  expect(e.ready()).toBe(false);
  await until(() => !e.alive());
  plan(root, {});
});

test("a pending request fails when the shell dies under it", async () => {
  plan(root, { silent: ["state"], exitAfterMs: 300 });
  const e = make();
  await e.start("run", new Display());
  await until(() => e.ready());
  await expect(e.ask({ op: "state" }, 5000)).rejects.toThrow("Discord stopped.");
  plan(root, {});
});

test("a missing Electron is an error with the reason", async () => {
  const saved = process.env.HARBOR_DISCORD_ELECTRON;
  process.env.HARBOR_DISCORD_ELECTRON = join(box.dir, "no-such-electron");
  const e = make();
  await expect(e.start("run", new Display())).rejects.toThrow("Couldn't start Electron");
  expect(e.alive()).toBe(false);
  process.env.HARBOR_DISCORD_ELECTRON = saved;
});

test("suspend holds the shell still and resume lets it answer", async () => {
  plan(root, {});
  const e = make();
  await e.start("run", new Display());
  await until(() => e.ready());
  expect(await e.suspend()).toBe("signals");
  await expect(e.ask({ op: "state" }, 200)).rejects.toThrow("didn't answer in time");
  e.resume();
  expect((await e.ask({ op: "state" }, 3000)) !== null).toBe(true);
  await e.reclaim({ stopped: false });
  await e.stop();
  await expect(e.suspend()).rejects.toThrow("Discord isn't running.");
});

test("stop kills what the shell left behind", async () => {
  plan(root, { silent: ["quit"] });
  const e = make();
  await e.start("run", new Display());
  await until(() => e.ready());
  const pid = Number(readFileSync(join(root, "engine.pid"), "utf8"));
  const t0 = Date.now();
  await e.stop();
  expect(Date.now() - t0).toBeGreaterThan(4000);
  expect(() => process.kill(pid, 0)).toThrow();
  plan(root, {});
}, 15_000);

test("stopping repair's scratch page leaves the real client's pid file alone", async () => {
  plan(root, {});
  const real = make();
  await real.start("run", new Display());
  await until(() => real.ready());
  const pidPath = join(root, "engine.pid");
  const pid = readFileSync(pidPath, "utf8");
  const scratch = new Electron(join(root, "scratch"), () => {});
  await scratch.start("scratch", new Display());
  await until(() => scratch.ready());
  await scratch.stop();
  expect(readFileSync(pidPath, "utf8")).toBe(pid);
  await real.stop();
  expect(existsSync(pidPath)).toBe(false);
}, 15_000);

test("the live script and Vencord folder are handed to the shell", async () => {
  writeFileSync(join(root, "vencord.json"), JSON.stringify({ current: "abc", good: "", bad: [], checked: 1 }));
  const e = make();
  await e.start("scratch", new Display());
  await until(() => e.ready());
  const s = fakeLog(root).filter((l) => l.started === "scratch").at(-1);
  const cfg = s?.cfg as Record<string, unknown>;
  expect(cfg.vencord).toBe(setup.vencordDir("abc"));
  expect(readFileSync(String(cfg.page), "utf8")).toBe(setup.baseScript());
  expect(await e.ask({ op: "eval", code: "1" }, 2000)).toEqual({ scratch: "eval" });
});
