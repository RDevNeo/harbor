import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as detach from "../src/detach.ts";
import { alive, procStart } from "../src/procfs.ts";
import * as turnscope from "../src/turnscope.ts";
import { reap } from "./reap.ts";

const base = mkdtempSync(join(tmpdir(), "hts-scope-"));
afterAll(() => {
  reap(base);
  rmSync(base, { recursive: true, force: true });
});

const meta = (chat: number): detach.Meta => ({ chat_id: chat, kind: "Claude", started: 1, base: 0, pid: 0, pid_start: 0 });

describe("the waker", () => {
  test("a change in the folder wakes it at once, and nothing wakes it after the slow look", async () => {
    const dir = join(base, "wake");
    mkdirSync(dir);
    const w = new detach.Waker(dir);
    expect(w.watching).toBe(true);
    let t = Date.now();
    setTimeout(() => appendFileSync(join(dir, "out"), "x\n"), 30);
    await w.wait();
    expect(Date.now() - t).toBeLessThan(detach.SLOW_MS - 100);
    // Events of that write already seen: the next wait sleeps until the slow look.
    await w.wait(0);
    t = Date.now();
    await w.wait();
    expect(Date.now() - t).toBeGreaterThanOrEqual(detach.SLOW_MS - 20);
    w.close();
  });

  test("a folder that can't be watched is polled", async () => {
    const w = new detach.Waker(join(base, "nowhere"));
    expect(w.watching).toBe(false);
    const t = Date.now();
    await w.wait();
    expect(Date.now() - t).toBeLessThan(detach.SLOW_MS);
    w.close();
  });
});

describe("turn scopes", () => {
  test("Harbor main keeps up to 512 MB from reclaim, 8% of a small PC's RAM", () => {
    expect(turnscope.appMemoryLow(16 * 2 ** 30)).toBe(512 * 2 ** 20);
    expect(turnscope.appMemoryLow(4 * 2 ** 30)).toBe(328 * 2 ** 20);
  });

  test("the slices above Harbor's unit, up to the user's manager, get its protection passed down", () => {
    const u = "/user.slice/user-1000.slice/user@1000.service";
    expect(turnscope.slicesAbove(`${u}/app.slice/app-graphical.slice/app-harbor@autostart.service`).map((s) => s.unit)).toEqual(["app-graphical.slice", "app.slice"]);
    expect(turnscope.slicesAbove(`${u}/app.slice/app-harbor-1.scope`).map((s) => s.unit)).toEqual(["app.slice"]);
    expect(turnscope.slicesAbove(`${u}/harbor.service`)).toEqual([]);
  });

  test("turns are weighed down where it counts: the slice that competes with app.slice", () => {
    expect(turnscope.SLICE.split("-")[0] + ".slice").toBe(turnscope.PARENT);
    expect(turnscope.PARENT_LIMITS).toContain("CPUWeight=20");
  });

  test("a scope is named after its turn folder", () => {
    expect(turnscope.unitOf("/s/turns/12-1792605157067846264")).toBe("harbor-turn-12-1792605157067846264.scope");
    expect(turnscope.unitOf("/s/turns/-3-7")).toBe("harbor-turn--3-7.scope");
    expect(turnscope.unitOf("/s/turns/a b")).toBe("harbor-turn-a_b.scope");
  });

  test("turned off, a turn starts and ends as before", async () => {
    process.env.HARBOR_TURN_SCOPE = "0";
    turnscope.reset();
    try {
      expect(turnscope.available()).toBe(false);
      const c = detach.command("sh");
      c.args.push("-c", "echo plain");
      const [dir, m] = await detach.spawn(c, null, false, false, meta(5), join(base, "off"));
      expect(turnscope.scopeOf(m.pid, dir)).toBeUndefined();
      const out: string[] = [];
      expect(await detach.follow(dir, m, (l) => out.push(l), () => {})).toBe(true);
      expect(out).toEqual(["plain"]);
    } finally {
      delete process.env.HARBOR_TURN_SCOPE;
      turnscope.reset();
    }
  });

  // Only where systemd --user runs (not in boat's sandboxes).
  test.skipIf(!turnscope.available())("a turn runs in its own scope, and what it left running dies with it", async () => {
    const pidFile = join(base, "leftover.pid");
    const c = detach.command("sh");
    // A command the agent detached: it would outlive the turn without the scope.
    c.args.push("-c", `setsid sleep 60 & echo $! > '${pidFile}'; echo scoped`);
    const [dir, m] = await detach.spawn(c, null, false, false, meta(6), join(base, "on"));
    const scope = turnscope.scopeOf(m.pid, dir);
    expect(scope).toBeDefined();
    expect(scope).toContain(`/${turnscope.SLICE}/`);
    const out: string[] = [];
    expect(await detach.follow(dir, m, (l) => out.push(l), () => {})).toBe(true);
    expect(out).toEqual(["scoped"]);
    const left = Number(readFileSync(pidFile, "utf8").trim());
    const start = procStart(left);
    const t = Date.now();
    while (start !== undefined && alive(left, start) && Date.now() - t < 5000) await Bun.sleep(50);
    expect(start === undefined || !alive(left, start)).toBe(true);
    while (existsSync(scope as string) && Date.now() - t < 5000) await Bun.sleep(50);
    expect(existsSync(scope as string)).toBe(false);
  });

  test.skipIf(!turnscope.available())("stopping a turn kills its whole scope", async () => {
    const pidFile = join(base, "stopped.pid");
    const c = detach.command("sh");
    c.args.push("-c", `setsid sleep 60 & echo $! > '${pidFile}'; sleep 60`);
    const [dir, m] = await detach.spawn(c, null, false, false, meta(7), join(base, "stop"));
    const t = Date.now();
    while (!existsSync(pidFile) && Date.now() - t < 5000) await Bun.sleep(20);
    const scope = turnscope.scopeOf(m.pid, dir);
    expect(scope).toBeDefined();
    turnscope.end(dir, scope);
    while (existsSync(scope as string) && Date.now() - t < 5000) await Bun.sleep(50);
    expect(existsSync(scope as string)).toBe(false);
    expect(alive(m.pid, m.pid_start)).toBe(false);
  });
});
