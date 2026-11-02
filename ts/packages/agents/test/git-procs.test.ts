import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@harbor/store";
import * as git from "../src/git.ts";
import * as procs from "../src/procs.ts";

const base = mkdtempSync(join(tmpdir(), "hts-gitprocs-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("ssh_remotes_have_web_urls", () => {
  for (const u of ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r", "https://github.com/o/r.git"]) expect(git.webUrl(u)).toBe("https://github.com/o/r");
});

test("status_ignores_repo_fsmonitor", async () => {
  const dir = join(base, "fsm");
  const marker = join(base, "fsm.ran");
  mkdirSync(dir);
  const g = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  g("init", "-q");
  g("config", "core.fsmonitor", `touch ${marker}`);
  writeFileSync(join(dir, "a"), "x");
  const s = await git.status(dir);
  expect(s).not.toBeNull();
  expect(s?.changed).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

test("a git query that hangs is cut off", async () => {
  await expect(git.outputWithin(["sleep", "5"], 200)).rejects.toBeInstanceOf(git.TimedOut);
});

test("trims_a_log_to_its_end", () => {
  const p = join(base, "trim.log");
  writeFileSync(p, Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join(""));
  procs.trim(p, 100);
  const t = readFileSync(p, "utf8");
  expect(t.startsWith("[… earlier output cut by Harbor]\nline 9")).toBe(true);
  expect(t.endsWith("line 999\n")).toBe(true);
  expect(t.length).toBeLessThan(150);
});

test("finds_a_process_group", async () => {
  const c = Bun.spawn(["sleep", "30"], { detached: true });
  await Bun.sleep(50);
  expect(procs.group(c.pid)).toEqual([c.pid]);
  c.kill();
  await c.exited;
  expect(procs.group(c.pid)).toEqual([]);
});

test("local URLs in a line of output", () => {
  expect(procs.localUrl("  ➜  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
  expect(procs.localUrl("listening on http://0.0.0.0:3000.")).toBe("http://localhost:3000");
  expect(procs.localUrl('see "http://[::]:8080/x", or https://example.com')).toBe("http://localhost:8080/x");
  expect(procs.localUrl("docs at https://example.com then http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/");
  expect(procs.localUrl("no url")).toBeNull();
  expect(procs.stripAnsi("\x1b[32mgreen\x1b[0m\r\n")).toBe("green\n");
});

test("a started process is recorded, finds its URL, outlives a restart and is stopped with its group", async () => {
  const was = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(base, "state");
  const store = Store.openAt(join(base, "harbor.db"));
  try {
    const events: procs.ProcEvent[] = [];
    const p = await procs.spawn(store, { name: "dev", cmd: "echo ready at http://localhost:4321/ ; sleep 30 & wait", cwd: base, repoId: null, lead: 1, owner: 2 }, (e) => events.push(e));
    for (let i = 0; i < 50 && !events.some((e) => e.type === "url"); i++) await Bun.sleep(100);
    expect(events).toContainEqual({ type: "url", id: p.id, url: "http://localhost:4321/" });
    expect(p.tail(5)).toBe("ready at http://localhost:4321/");
    const row = store.procs()[0];
    expect(row).toMatchObject({ id: p.id, name: "dev", lead: 1, owner: 2, pid: p.pid, log: p.log });
    // The next Harbor finds it again.
    const again = procs.adopt(store, () => {});
    expect(again.map((x) => x.pid)).toEqual([p.pid]);
    expect(procs.group(p.pid).length).toBe(2);
    p.stop();
    for (let i = 0; i < 50 && procs.group(p.pid).length > 0; i++) await Bun.sleep(100);
    expect(procs.group(p.pid)).toEqual([]);
    // Gone: forgotten at the next start.
    expect(procs.adopt(store, () => {})).toEqual([]);
    expect(store.procs()).toEqual([]);
    expect(existsSync(p.log)).toBe(false);
  } finally {
    store.close();
    if (was === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = was;
  }
});
